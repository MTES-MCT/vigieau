<script setup lang="ts">
import * as maplibregl from 'maplibre-gl';
import { PMTiles } from 'pmtiles';
import { Ref } from 'vue';
import api from '../../api';
import type { ZonePublicationPin } from '../../api';
import { useRefDataStore } from '../../store/refData';
import { useZonePublicationStore } from '../../store/zonePublication';
import {
  ensureZonePmtilesProtocol,
  preflightPmtiles,
  subscribeZonePmtilesStatus,
  zonePmtilesProtocol,
} from '../../utils/pmtiles';
import type { PmtilesStatus } from '../../utils/pmtiles';
import { createRetryableInitializer } from '../../utils/retryable-initializer';
import {
  createAbortError,
  createLatestTaskRunner,
  createRetryScheduler,
  isAbortError,
  runRetryableTask,
} from '../../utils/retryable-task';
import {
  createLocalDateRollover,
  getMapPublicationStateKey,
  isCurrentMapDate,
  shouldReplaceZoneLayers,
} from '../../utils/zone-publication';
import type { LocalDateRollover } from '../../utils/zone-publication';
import {
  canRetainDisplayedZoneSource,
  captureDisplayedZonePublicationPin,
  getZoneSourceKey,
  getZoneSourceLoadAction,
  shouldResetZoneSourceRetryCycle,
} from '../../utils/zone-source-transition';

const props = defineProps<{
  embedded: any;
  date?: string;
  area: string;
  loading: boolean;
  hideDownloadBtn: boolean;
  hideTypeEau: boolean;
  typeEau: string;
  profil: string;
}>();

const emit = defineEmits<{
  (event: 'downloadMap', typeEau: string): void;
  (
    event: 'displayedPublicationPin',
    publicationPin: ZonePublicationPin | null,
  ): void;
}>();

const modalOpened: Ref<boolean> = ref(false);
const modalTitle: Ref<string> = ref('');
const modalText: Ref<string> = ref('');
const modalIcon: Ref<string> = ref('');
const modalActions: Ref<any[]> = ref([]);
const loadingZones: Ref<boolean> = ref(false);
const mapContainer = shallowRef(null);
const map: Ref<any> = shallowRef(null);
const isMapSupported: boolean = utils.isWebglSupported();
const runtimeConfig = useRuntimeConfig();
const zonesSelected = ref([]);
const route = useRoute();
const departementCode = route.query.depCode;
const showRestrictionsBtn = ref(true);
const showError = ref(false);
const refDataStore = useRefDataStore();
const zonePublicationStore = useZonePublicationStore();
const depsSelected = ref([]);

const initialState = [
  [-7.075195, 41.211722],
  [11.403809, 51.248163],
];

const protocol = zonePmtilesProtocol;
const DEFAULT_PMTILES_URL = `${runtimeConfig.public.s3vhost}pmtiles/zones_arretes_en_vigueur.pmtiles`;
const CONFIGURED_PMTILES_URL = String(
  runtimeConfig.public.pmtilesUrl || DEFAULT_PMTILES_URL,
).trim();
const PMTILES_URL_TRUNC = CONFIGURED_PMTILES_URL.replace(/\.pmtiles$/, '');
const PMTILES_PREFLIGHT_ATTEMPTS = 3;
const PMTILES_PREFLIGHT_RETRY_MS = 500;
const PMTILES_TILE_RETRY_LIMIT = 2;
const PMTILES_TILE_RETRY_MS = 1_000;
const PMTILES_RECOVERY_RETRY_MS = 60_000;

interface ZoneSourceState {
  pmtilesUrl: string;
  publicationId: string | null;
  restrictionsAvailable: boolean;
  viewKey: string;
  sourceKey: string;
  pmtiles: PMTiles;
  validated: boolean;
}

interface RequestedZoneSource {
  pmtilesUrl: string;
  publicationId: string | null;
  restrictionsAvailable: boolean;
  viewKey: string;
  sourceKey: string;
}

interface PendingZoneSourceTransition {
  candidate: ZoneSourceState;
  previous: ZoneSourceState | null;
}

const getZoneSourceViewKey = (
  restrictionsAvailable: boolean,
  dateValue?: string,
): string => (restrictionsAvailable ? 'current' : `historic:${dateValue}`);

const getRequestedZoneSource = (
  dateValue = props.date,
): RequestedZoneSource | null => {
  const restrictionsAvailable = isCurrentMapDate(dateValue);
  const pmtilesUrl = restrictionsAvailable
    ? zonePublicationStore.pmtilesUrl
    : `${PMTILES_URL_TRUNC}_${dateValue}.pmtiles`;
  if (!pmtilesUrl) {
    return null;
  }
  const publicationId = restrictionsAvailable
    ? (zonePublicationStore.publication?.id ?? null)
    : null;
  return {
    pmtilesUrl,
    publicationId,
    restrictionsAvailable,
    viewKey: getZoneSourceViewKey(restrictionsAvailable, dateValue),
    sourceKey: getZoneSourceKey(pmtilesUrl, publicationId),
  };
};
let firstSymbolId: any;
let mapPopupRequestId = 0;
let initialMapStyleLoaded = false;
let mapViewRequestId = 0;
let componentMounted = false;
let displayedZoneSource: ZoneSourceState | null = null;
let pendingZoneSourceTransition: PendingZoneSourceTransition | null = null;
let requestedZoneSourceKey: string | null = null;
let scheduledZoneSourceKey: string | null = null;
let scheduledZoneSourceRecoveryKey: string | null = null;
let exhaustedZoneSourceKey: string | null = null;
let zoneTileRetryCount = 0;
let handledSuccessfulRefreshVersion =
  zonePublicationStore.successfulRefreshVersion;
let localDateRollover: LocalDateRollover | null = null;
let unsubscribePmtilesStatus: (() => void) | null = null;
const zoneLayerTaskRunner = createLatestTaskRunner();
const zoneTileRetry = createRetryScheduler(() => {
  const retrySourceKey = scheduledZoneSourceKey;
  scheduledZoneSourceKey = null;
  if (
    componentMounted &&
    retrySourceKey &&
    getRequestedZoneSource()?.sourceKey === retrySourceKey
  ) {
    void synchronizeMapView();
  }
}, PMTILES_TILE_RETRY_MS);
const clearZoneTileRetry = (): void => {
  scheduledZoneSourceKey = null;
  zoneTileRetry.clear();
};
const zoneSourceRecoveryRetry = createRetryScheduler(() => {
  const recoverySourceKey = scheduledZoneSourceRecoveryKey;
  scheduledZoneSourceRecoveryKey = null;
  if (
    componentMounted &&
    recoverySourceKey &&
    getRequestedZoneSource()?.sourceKey === recoverySourceKey
  ) {
    if (exhaustedZoneSourceKey === recoverySourceKey) {
      exhaustedZoneSourceKey = null;
    }
    zoneTileRetryCount = 0;
    void synchronizeMapView();
  }
}, PMTILES_RECOVERY_RETRY_MS);
const clearZoneSourceRecovery = (): void => {
  scheduledZoneSourceRecoveryKey = null;
  zoneSourceRecoveryRetry.clear();
};
const scheduleZoneSourceRecovery = (sourceKey: string): void => {
  scheduledZoneSourceRecoveryKey = sourceKey;
  zoneSourceRecoveryRetry.schedule();
};
const requestMatchesPmtilesUrl = (
  requestUrl: string,
  pmtilesUrl?: string,
): boolean => Boolean(pmtilesUrl && requestUrl.includes(pmtilesUrl));
const updatePmtilesStatus = ({
  failed,
  requestUrl,
  requestKind,
}: PmtilesStatus): void => {
  if (!componentMounted) {
    return;
  }
  const requestedSource = getRequestedZoneSource();
  const pendingTransition = pendingZoneSourceTransition;
  const matchesRequested = requestMatchesPmtilesUrl(
    requestUrl,
    requestedSource?.pmtilesUrl,
  );
  const matchesDisplayed = requestMatchesPmtilesUrl(
    requestUrl,
    displayedZoneSource?.pmtilesUrl,
  );
  const matchesPendingCandidate = Boolean(
    pendingTransition &&
    displayedZoneSource === pendingTransition.candidate &&
    requestMatchesPmtilesUrl(
      requestUrl,
      pendingTransition.candidate.pmtilesUrl,
    ),
  );
  if (!matchesRequested && !matchesDisplayed && !matchesPendingCandidate) {
    return;
  }

  const action = getZoneSourceLoadAction({
    failed,
    requestKind,
    isPendingCandidate: matchesPendingCandidate,
    candidateValidated: pendingTransition?.candidate.validated ?? false,
    retryCount: zoneTileRetryCount,
    retryLimit: PMTILES_TILE_RETRY_LIMIT,
  });

  if (failed) {
    showError.value = true;
  }

  if (action === 'validate' && pendingTransition) {
    pendingTransition.candidate.validated = true;
    pendingZoneSourceTransition = null;
    exhaustedZoneSourceKey = null;
    zoneTileRetryCount = 0;
    clearZoneTileRetry();
    clearZoneSourceRecovery();
    showError.value = false;
    return;
  }

  if (
    (action === 'restore' || action === 'restore-and-retry') &&
    pendingTransition
  ) {
    pendingZoneSourceTransition = null;
    restoreZoneSource(pendingTransition.previous);
    if (
      action === 'restore-and-retry' &&
      requestedSource?.sourceKey === pendingTransition.candidate.sourceKey
    ) {
      zoneTileRetryCount += 1;
      scheduledZoneSourceKey = pendingTransition.candidate.sourceKey;
      zoneTileRetry.schedule();
    } else if (action === 'restore') {
      exhaustedZoneSourceKey = pendingTransition.candidate.sourceKey;
      scheduleZoneSourceRecovery(pendingTransition.candidate.sourceKey);
    }
    return;
  }

  if (
    !failed &&
    requestKind === 'tile' &&
    matchesDisplayed &&
    displayedZoneSource?.validated
  ) {
    showError.value = false;
  }
};

// Create a popup, but don't add it to the map yet.
const popup = new maplibregl.Popup({
  closeButton: true,
  closeOnClick: false,
}).setMaxWidth('300px');

const mapInitializer = createRetryableInitializer(() => {
  const initialPmtilesUrl = getRequestedZoneSource()?.pmtilesUrl;
  if (
    !componentMounted ||
    !mapContainer.value ||
    !initialPmtilesUrl ||
    map.value
  ) {
    return map.value;
  }

  const mapInstance = new maplibregl.Map({
    container: mapContainer.value,
    style: `https://openmaptiles.data.gouv.fr/styles/osm-bright/style.json`,
    bounds: initialState,
    preserveDrawingBuffer: true,
    minZoom: 4,
    maxZoom: 14,
  });
  map.value = mapInstance;

  // Add zoom and rotation controls to the map.
  mapInstance.addControl(new maplibregl.NavigationControl(), 'bottom-right');

  // Add geolocate control to the map.
  mapInstance.addControl(
    new maplibregl.GeolocateControl({
      positionOptions: {
        enableHighAccuracy: true,
      },
      trackUserLocation: true,
    }),
    'bottom-right',
  );

  // Add fullscreen control to the map.
  mapInstance.addControl(new maplibregl.FullscreenControl(), 'bottom-right');

  mapInstance.on('load', () => {
    initialMapStyleLoaded = true;
    const layers = mapInstance.getStyle().layers;
    for (let i = 0; i < layers.length; i++) {
      if (layers[i].type === 'symbol') {
        firstSymbolId = layers[i].id;
        break;
      }
    }
    if (!mapInstance.getSource('decoupage-administratif')) {
      mapInstance.addSource('decoupage-administratif', {
        type: 'vector',
        url: `https://openmaptiles.data.gouv.fr/data/decoupage-administratif.json`,
      });
    }
    void synchronizeMapView();
  });

  mapInstance.on('click', 'departements-overlay', async (e: any) => {
    const requestId = ++mapPopupRequestId;
    const features = map.value?.queryRenderedFeatures(e.point, {
      layers: ['zones-data'],
    });
    const coordinates = e.lngLat;
    const properties = features ? features.map((f: any) => f.properties) : [];
    zonesSelected.value = properties ? properties.map((p: any) => p.id) : [];

    updateContourFilter();
    renderMapPopup(coordinates, properties);
    map.value.flyTo({
      center: [
        e.lngLat.lng - 0.5 / map.value.getZoom(),
        e.lngLat.lat - 0.7 / (map.value.getZoom() + 5),
      ],
      essential: true,
      speed: 0.2,
    });

    const [addressResult, geoResult] = await Promise.allSettled([
      api.searchAddressByLatlon(coordinates.lng, coordinates.lat),
      api.searchGeoByLatlon(coordinates.lng, coordinates.lat),
    ]);
    if (requestId !== mapPopupRequestId) {
      return;
    }
    const address =
      addressResult.status === 'fulfilled'
        ? addressResult.value.data.value?.features?.[0]
        : null;
    const geo =
      geoResult.status === 'fulfilled' ? geoResult.value.data.value?.[0] : null;
    renderMapPopup(coordinates, properties, address, geo);
  });

  mapInstance.on('mouseenter', 'zones-data', () => {
    // Change the cursor style as a UI indicator.
    map.value.getCanvas().style.cursor = 'pointer';
  });

  mapInstance.on('mouseleave', 'zones-data', () => {
    map.value.getCanvas().style.cursor = '';
  });

  return mapInstance;
});

const ensureMapInitialized = async (): Promise<boolean> => {
  try {
    const initializedMap = await mapInitializer.initialize();
    if (initializedMap) {
      return true;
    }
  } catch {
    // A later manifest refresh can retry the exact same initialization.
  }
  showError.value = true;
  const requestedSource = getRequestedZoneSource();
  if (requestedSource) {
    scheduleZoneSourceRecovery(requestedSource.sourceKey);
  }
  return false;
};

onMounted(async () => {
  if (!isMapSupported) {
    return;
  }
  componentMounted = true;
  ensureZonePmtilesProtocol();
  unsubscribePmtilesStatus = subscribeZonePmtilesStatus(updatePmtilesStatus);
  localDateRollover = createLocalDateRollover(() => {
    void synchronizeMapView();
  });
  await synchronizeMapView();
});

onBeforeUnmount(() => {
  componentMounted = false;
  mapViewRequestId += 1;
  mapPopupRequestId += 1;
  zoneLayerTaskRunner.cancel();
  clearZoneTileRetry();
  clearZoneSourceRecovery();
  localDateRollover?.stop();
  unsubscribePmtilesStatus?.();
  popup.remove();
  map.value?.remove();
  map.value = null;
  initialMapStyleLoaded = false;
  displayedZoneSource = null;
  pendingZoneSourceTransition = null;
  requestedZoneSourceKey = null;
  exhaustedZoneSourceKey = null;
});

const mapTags: Ref<any[]> = ref([
  {
    label: 'Métropole',
    bounds: initialState,
  },
  {
    label: 'La Réunion',
    bounds: [
      [54.615784, -21.749296],
      [56.497192, -20.522216],
    ],
  },
  {
    label: 'Guadeloupe',
    bounds: [
      [-62.119446, 15.612456],
      [-60.762634, 16.61777],
    ],
  },
  {
    label: 'Martinique',
    bounds: [
      [-61.480865, 14.193832],
      [-60.570374, 14.964687],
    ],
  },
  {
    label: 'Mayotte',
    bounds: [
      [44.748688, -13.175771],
      [45.532837, -12.507643],
    ],
  },
  {
    label: 'Guyane',
    bounds: [
      [-55.26123, 1.79048],
      [-51.130371, 6.107784],
    ],
  },
]);

const typeEauTags: Ref<any[]> = ref([
  {
    label: 'Eau potable',
    value: 'AEP',
    disabled: false,
    text: 'du robinet',
  },
  {
    label: 'Eau superficielle',
    value: 'SUP',
    text: `des cours d'eau, rivières`,
  },
  {
    label: 'Eau souterraine',
    value: 'SOU',
    text: `des nappes (puits ou forage)`,
  },
]);
const selectedTypeEau: Ref<string> = ref(props.typeEau ? props.typeEau : 'AEP');
const router = useRouter();
const expandedId = ref<string>();

const getTypeEauText = computed(() => {
  return typeEauTags.value.find((t) => t.value === selectedTypeEau.value).text;
});

const flyToLocation = (bounds: any) => {
  map.value?.fitBounds(bounds);
};

const updateLayerFilter = () => {
  if (map.value?.getLayer('zones-data')) {
    map.value.setFilter('zones-data', ['==', 'type', selectedTypeEau.value]);
  }
};

const updateContourFilter = () => {
  if (map.value?.getLayer('zones-contour')) {
    map.value.setFilter('zones-contour', [
      'all',
      ['==', 'type', selectedTypeEau.value],
      ['in', 'id', ...zonesSelected.value],
    ]);
  }
};

const updateDepartementsContourFilter = () => {
  if (map.value?.getLayer('departements-contour')) {
    map.value.setFilter('departements-contour', [
      'in',
      'code',
      ...depsSelected.value.map((d: any) => d.code),
    ]);
  }
};

const closeModal = () => {
  modalOpened.value = false;
};

function renderMapPopup(
  coordinates: { lng: number; lat: number },
  properties: any[],
  address?: any,
  geo?: any,
) {
  const description = utils.generatePopupHtml(
    properties,
    showRestrictionsBtn.value,
    address,
    geo,
  );

  popup.setLngLat(coordinates).setHTML(description).addTo(map.value);
  bindMapPopupButton(coordinates, address, geo);
}

function bindMapPopupButton(
  coordinates: { lng: number; lat: number },
  address?: any,
  geo?: any,
) {
  const btn = popup
    .getElement()
    ?.querySelector<HTMLButtonElement>('.btn-map-popup');
  if (!btn) {
    return;
  }
  const publicationPin = captureDisplayedZonePublicationPin(
    displayedZoneSource?.publicationId,
  );

  btn.addEventListener('click', async () => {
    // On garde le lon/lat exact du clic, même quand le libellé vient d'un service externe.
    const selectedAddress = {
      geometry: {
        coordinates: [coordinates.lng, coordinates.lat],
      },
      properties: {
        postcode: address?.properties?.postcode || '',
        label:
          geo?.nom && geo?.codeDepartement
            ? `${geo.nom}, ${geo.codeDepartement}`
            : address?.properties?.label || 'Point sélectionné sur la carte',
        type: 'coordinates',
        citycode: address?.properties?.citycode || geo?.code || '',
        context: address?.properties?.context || '',
      },
    };
    utils.searchZones(
      selectedAddress,
      null,
      props.profil,
      selectedTypeEau.value,
      router,
      modalTitle,
      modalText,
      modalIcon,
      modalActions,
      modalOpened,
      loadingZones,
      publicationPin,
    );
  });
}

const removeZoneLayers = () => {
  if (map.value?.getLayer('zones-data')) {
    map.value?.removeLayer('zones-data');
  }
  if (map.value?.getLayer('departements-data')) {
    map.value?.removeLayer('departements-data');
  }
  if (map.value?.getLayer('departements-overlay')) {
    map.value?.removeLayer('departements-overlay');
  }
  if (map.value?.getLayer('departements-contour')) {
    map.value?.removeLayer('departements-contour');
  }
  if (map.value?.getLayer('zones-contour')) {
    map.value?.removeLayer('zones-contour');
  }
  if (map.value?.getSource('zones')) {
    map.value?.removeSource('zones');
  }
};

const addSourceAndLayerZones = (pmtilesUrl: string) => {
  map.value?.addSource('zones', {
    type: 'vector',
    url: `pmtiles://${pmtilesUrl}`,
  });

  map.value?.addLayer(
    {
      id: 'zones-data',
      type: 'fill',
      source: 'zones',
      'source-layer': 'zones_arretes_en_vigueur',
      filter: ['==', 'type', selectedTypeEau.value],
      paint: {
        'fill-color': [
          'match',
          ['get', 'niveauGravite'],
          'vigilance',
          '#FFEDA0',
          'alerte',
          '#FEB24C',
          'alerte_renforcee',
          '#FC4E2A',
          'crise',
          '#B10026',
          '#e8edff',
        ],
        'fill-opacity': {
          stops: [
            [5, 1],
            [6, 0.8],
            [7, 0.7],
            [8, 0.6],
            [9, 0.5],
            [10, 0.4],
            [11, 0.3],
          ],
        },
      },
    },
    firstSymbolId,
  );

  map.value?.addLayer(
    {
      id: 'departements-data',
      type: 'line',
      source: 'decoupage-administratif',
      'source-layer': 'departements',
      layout: {
        'line-join': 'round',
        'line-cap': 'round',
      },
      paint: {
        'line-color': '#888888',
        'line-width': 1,
      },
    },
    firstSymbolId,
  );

  map.value?.addLayer(
    {
      id: 'departements-overlay',
      type: 'fill',
      source: 'decoupage-administratif',
      'source-layer': 'departements',
      paint: {
        'fill-color': 'rgba(0, 0, 0, 0)',
      },
    },
    firstSymbolId,
  );

  map.value?.addLayer(
    {
      id: 'departements-contour',
      type: 'line',
      source: 'decoupage-administratif',
      'source-layer': 'departements',
      filter: [
        'all',
        ['in', 'code', ...depsSelected.value.map((d: any) => d.code)],
      ],
      paint: {
        'line-color': '#000',
        'line-width': 2,
      },
    },
    firstSymbolId,
  );

  map.value?.addLayer(
    {
      id: 'zones-contour',
      type: 'line',
      source: 'zones',
      'source-layer': 'zones_arretes_en_vigueur',
      filter: [
        'all',
        ['==', 'type', selectedTypeEau.value],
        ['in', 'id', ...zonesSelected.value],
      ],
      paint: {
        'line-color': '#000091',
        'line-width': 3,
      },
    },
    firstSymbolId,
  );

  // If date < vigieau admin, on affiche pas eau potable.
};

const resetZoneSelected = () => {
  // Ignore geocoding responses started for a selection that is no longer visible.
  mapPopupRequestId += 1;
  zonesSelected.value = [];
  updateContourFilter();
  popup.remove();
};

const publishDisplayedPublicationPin = (
  source: ZoneSourceState | null,
): void => {
  emit(
    'displayedPublicationPin',
    source ? captureDisplayedZonePublicationPin(source.publicationId) : null,
  );
};

const restoreZoneSource = (source: ZoneSourceState | null): void => {
  resetZoneSelected();
  removeZoneLayers();
  displayedZoneSource = null;
  if (!source) {
    showRestrictionsBtn.value = false;
    publishDisplayedPublicationPin(null);
    return;
  }

  protocol.add(source.pmtiles);
  addSourceAndLayerZones(source.pmtilesUrl);
  displayedZoneSource = source;
  showRestrictionsBtn.value = source.restrictionsAvailable;
  publishDisplayedPublicationPin(source);
};

const replaceZoneLayers = (
  requestedSource: RequestedZoneSource,
  candidate: PMTiles,
  validated = false,
): void => {
  const previous = canRetainDisplayedZoneSource(
    displayedZoneSource?.viewKey,
    requestedSource.viewKey,
  )
    ? displayedZoneSource
    : null;
  const candidateState: ZoneSourceState = {
    ...requestedSource,
    pmtiles: candidate,
    validated,
  };

  resetZoneSelected();
  removeZoneLayers();
  displayedZoneSource = null;
  protocol.add(candidateState.pmtiles);

  try {
    addSourceAndLayerZones(candidateState.pmtilesUrl);
  } catch (error) {
    restoreZoneSource(previous);
    throw error;
  }

  displayedZoneSource = candidateState;
  pendingZoneSourceTransition = validated
    ? null
    : {
        candidate: candidateState,
        previous,
      };
  showRestrictionsBtn.value = candidateState.restrictionsAvailable;
  publishDisplayedPublicationPin(candidateState);
  showError.value = false;
};

const isMapViewRequestCurrent = (
  requestId: number,
  dateValue: string | undefined,
  currentDate: boolean,
): boolean =>
  componentMounted &&
  requestId === mapViewRequestId &&
  props.date === dateValue &&
  isCurrentMapDate(props.date) === currentDate;

const displayZoneLayers = async (
  requestedSource: RequestedZoneSource,
  requestId: number,
  dateValue: string | undefined,
  currentDate: boolean,
): Promise<boolean> => {
  if (
    !initialMapStyleLoaded ||
    !isMapViewRequestCurrent(requestId, dateValue, currentDate)
  ) {
    return false;
  }

  if (
    exhaustedZoneSourceKey === requestedSource.sourceKey &&
    displayedZoneSource?.sourceKey !== requestedSource.sourceKey
  ) {
    return false;
  }

  const shouldReplaceSource =
    shouldReplaceZoneLayers(
      displayedZoneSource?.pmtilesUrl ?? null,
      requestedSource.pmtilesUrl,
      Boolean(map.value.getSource('zones')),
    ) || displayedZoneSource?.sourceKey !== requestedSource.sourceKey;
  if (!shouldReplaceSource) {
    exhaustedZoneSourceKey = null;
    clearZoneSourceRecovery();
    if (displayedZoneSource) {
      displayedZoneSource.publicationId = requestedSource.publicationId;
      displayedZoneSource.restrictionsAvailable =
        requestedSource.restrictionsAvailable;
      displayedZoneSource.viewKey = requestedSource.viewKey;
      displayedZoneSource.sourceKey = requestedSource.sourceKey;
      publishDisplayedPublicationPin(displayedZoneSource);
    }
    showRestrictionsBtn.value = requestedSource.restrictionsAvailable;
    return true;
  }

  try {
    return await zoneLayerTaskRunner.run(
      (signal) =>
        runRetryableTask(
          async (retrySignal) => {
            const candidate = await preflightPmtiles(
              requestedSource.pmtilesUrl,
              retrySignal,
            );
            if (
              !isMapViewRequestCurrent(requestId, dateValue, currentDate) ||
              getRequestedZoneSource(dateValue)?.sourceKey !==
                requestedSource.sourceKey ||
              !initialMapStyleLoaded
            ) {
              throw createAbortError();
            }
            return candidate;
          },
          {
            attempts: PMTILES_PREFLIGHT_ATTEMPTS,
            delayMs: PMTILES_PREFLIGHT_RETRY_MS,
            signal,
          },
        ),
      (candidate) => {
        if (
          !isMapViewRequestCurrent(requestId, dateValue, currentDate) ||
          getRequestedZoneSource(dateValue)?.sourceKey !==
            requestedSource.sourceKey ||
          !initialMapStyleLoaded
        ) {
          throw createAbortError();
        }
        replaceZoneLayers(
          requestedSource,
          candidate.archive,
          candidate.empty,
        );
      },
    );
  } catch (error) {
    if (
      !isAbortError(error) &&
      isMapViewRequestCurrent(requestId, dateValue, currentDate)
    ) {
      showError.value = true;
      exhaustedZoneSourceKey = requestedSource.sourceKey;
      scheduleZoneSourceRecovery(requestedSource.sourceKey);
    }
    return false;
  }
};

const updateTypeAvailability = (dateValue?: string): void => {
  const date = dateValue ? new Date(dateValue) : new Date();
  if (date < new Date('2024-04-28')) {
    if (selectedTypeEau.value === 'AEP') {
      selectedTypeEau.value = 'SUP';
    }
    typeEauTags.value[0].disabled = true;
  } else {
    typeEauTags.value[0].disabled = false;
  }
};

const synchronizeMapView = async (): Promise<void> => {
  if (!componentMounted) {
    return;
  }

  const requestId = ++mapViewRequestId;
  zoneLayerTaskRunner.cancel();
  const dateValue = props.date;
  const currentDate = isCurrentMapDate(dateValue);
  const requestedViewKey = getZoneSourceViewKey(currentDate, dateValue);
  if (
    pendingZoneSourceTransition &&
    !canRetainDisplayedZoneSource(
      pendingZoneSourceTransition.candidate.viewKey,
      requestedViewKey,
    )
  ) {
    const previous = canRetainDisplayedZoneSource(
      pendingZoneSourceTransition.previous?.viewKey,
      requestedViewKey,
    )
      ? pendingZoneSourceTransition.previous
      : null;
    pendingZoneSourceTransition = null;
    restoreZoneSource(previous);
  } else if (
    !pendingZoneSourceTransition &&
    displayedZoneSource &&
    !canRetainDisplayedZoneSource(displayedZoneSource.viewKey, requestedViewKey)
  ) {
    restoreZoneSource(null);
  }
  if (
    currentDate &&
    shouldResetZoneSourceRetryCycle(
      handledSuccessfulRefreshVersion,
      zonePublicationStore.successfulRefreshVersion,
    )
  ) {
    handledSuccessfulRefreshVersion =
      zonePublicationStore.successfulRefreshVersion;
    exhaustedZoneSourceKey = null;
    zoneTileRetryCount = 0;
    clearZoneTileRetry();
    clearZoneSourceRecovery();
  }
  updateTypeAvailability(dateValue);

  if (currentDate) {
    try {
      await zonePublicationStore.loadPublication();
    } catch {
      if (isMapViewRequestCurrent(requestId, dateValue, currentDate)) {
        showError.value = true;
      }
      return;
    }
  } else {
    void zonePublicationStore.loadPublication().catch(() => undefined);
  }

  if (!isMapViewRequestCurrent(requestId, dateValue, currentDate)) {
    return;
  }
  const requestedSource = getRequestedZoneSource(dateValue);
  if (!requestedSource) {
    requestedZoneSourceKey = null;
    zoneTileRetryCount = 0;
    clearZoneTileRetry();
    clearZoneSourceRecovery();
    showError.value = true;
    return;
  }

  if (requestedSource.sourceKey !== requestedZoneSourceKey) {
    requestedZoneSourceKey = requestedSource.sourceKey;
    exhaustedZoneSourceKey = null;
    zoneTileRetryCount = 0;
    clearZoneTileRetry();
    clearZoneSourceRecovery();
    if (pendingZoneSourceTransition) {
      const previous = canRetainDisplayedZoneSource(
        pendingZoneSourceTransition.previous?.viewKey,
        requestedSource.viewKey,
      )
        ? pendingZoneSourceTransition.previous
        : null;
      pendingZoneSourceTransition = null;
      restoreZoneSource(previous);
    }
    if (
      displayedZoneSource &&
      !canRetainDisplayedZoneSource(
        displayedZoneSource.viewKey,
        requestedSource.viewKey,
      )
    ) {
      restoreZoneSource(null);
    }
  }

  if (!(await ensureMapInitialized())) {
    return;
  }
  if (!isMapViewRequestCurrent(requestId, dateValue, currentDate)) {
    return;
  }

  await displayZoneLayers(requestedSource, requestId, dateValue, currentDate);
};

async function downloadMap() {
  emit('downloadMap', selectedTypeEau.value);
}

watch(
  () => props.typeEau,
  () => {
    selectedTypeEau.value = props.typeEau;
    updateLayerFilter();
  },
);

watch(
  () => selectedTypeEau.value,
  () => {
    resetZoneSelected();
  },
);

watch(
  () => [
    zonePublicationStore.publication,
    getMapPublicationStateKey(
      zonePublicationStore.publication?.id,
      zonePublicationStore.manifestStatus,
      zonePublicationStore.pmtilesUrl,
    ),
    zonePublicationStore.successfulRefreshVersion,
  ],
  () => {
    if (!componentMounted || !isCurrentMapDate(props.date)) {
      return;
    }
    void synchronizeMapView();
  },
);

watch(
  () => props.date,
  () => {
    void synchronizeMapView();
  },
);

watch(
  () => props.area,
  () => {
    let deps = [];
    let territoire = null;
    let idTerritoire = null;
    if (props.area) {
      territoire = props.area.split('=')[0];
      idTerritoire = props.area.split('=')[1];
    }
    if (territoire === 'bassinVersant' && idTerritoire) {
      const bassinVersantDeps = refDataStore.bassinsVersants.find(
        (r: any) => r.id === +idTerritoire,
      )?.departements;
      deps = refDataStore.departements.filter((d: any) =>
        bassinVersantDeps.some((bvd) => bvd.id === d.id),
      );
    } else if (territoire === 'region' && idTerritoire) {
      const regionDeps = refDataStore.regions.find(
        (r: any) => r.id === +idTerritoire,
      )?.departements;
      deps = refDataStore.departements.filter((d: any) =>
        regionDeps.some((rd) => rd.id === d.id),
      );
    } else if (territoire === 'departement' && idTerritoire) {
      deps = refDataStore.departements.filter(
        (d: any) => d.id === +idTerritoire,
      );
    }
    if (deps && deps.length > 0) {
      const llb = new maplibregl.LngLatBounds();
      deps.forEach((d: any) => {
        llb.extend([d.bounds.minLat, d.bounds.minLong]);
        llb.extend([d.bounds.maxLat, d.bounds.maxLong]);
      });
      map.value?.fitBounds(llb, {
        padding: 30,
      });
    }
    depsSelected.value = deps;
    updateDepartementsContourFilter();
  },
);
</script>

<template>
  <div class="full-width full-height" v-if="isMapSupported">
    <div class="map-pre-actions" data-html2canvas-ignore="true">
      <div v-if="showError" class="map-pre-actions-card fr-p-1w fr-m-1w">
        <DsfrAlert
          description="Une erreur est survenue lors du chargement de la carte"
          type="error"
          :closeable="false"
        />
      </div>
      <div v-if="!hideTypeEau" class="map-pre-actions-card fr-p-1w fr-m-1w">
        <h6 class="fr-mb-1w fr-mr-2w">Situation par ressource :</h6>
        <DsfrRadioButton
          v-for="option of typeEauTags"
          :modelValue="selectedTypeEau"
          v-bind="option"
          :small="true"
          class="fr-mb-1w"
          @update:modelValue="
            selectedTypeEau = $event;
            updateLayerFilter();
          "
        />
      </div>
      <div
        v-else
        class="map-pre-actions-card map-pre-actions-card--short fr-p-1w fr-m-1w"
      >
        <h6 class="fr-mb-0">Situation pour l'eau {{ getTypeEauText }}</h6>
      </div>
      <div class="map-pre-actions-card fr-p-1w fr-m-1w hide-sm">
        <h6 class="fr-mb-1w fr-mr-2w">Raccourcis :</h6>
        <DsfrTag
          v-for="tag in mapTags"
          :label="tag.label"
          class="fr-m-1w"
          small
          @click="flyToLocation(tag.bounds)"
          tag-name="button"
        />
      </div>
    </div>
    <MixinsNiveauGraviteLegende class="map-legend fr-mb-1w show-sm" />
    <div
      class="map-wrap"
      :class="{
        'map-wrap--full-actions': !hideTypeEau,
      }"
    >
      <div class="map" ref="mapContainer"></div>
    </div>
    <div class="map-post-actions show-sm" data-html2canvas-ignore="true">
      <div class="map-post-actions-card fr-p-1w fr-m-1w">
        <h6 class="fr-mb-1w fr-mr-2w">Raccourcis :</h6>
        <DsfrTag
          v-for="tag in mapTags"
          :label="tag.label"
          class="fr-m-1w"
          small
          @click="flyToLocation(tag.bounds)"
          tag-name="button"
        />
      </div>
    </div>
    <MixinsNiveauGraviteLegende class="map-legend fr-mt-1w hide-sm" />

    <div
      v-if="!hideDownloadBtn"
      data-html2canvas-ignore="true"
      class="text-align-right"
    >
      <DsfrButton @click="downloadMap()">
        Télécharger la carte en .png
      </DsfrButton>
    </div>
  </div>
  <template v-else>
    <DsfrAlert
      title="Votre navigateur ne supporte pas les cartographies"
      description="Impossible d'afficher la carte de la situation de la sécheresse en France"
      type="error"
      :closeable="false"
    />
  </template>

  <DsfrModal
    :opened="modalOpened"
    :title="modalTitle"
    :icon="modalIcon"
    :actions="modalActions"
    @close="closeModal"
  >
    <div v-html="modalText"></div>
  </DsfrModal>
</template>

<style lang="scss" scoped>
.map-wrap {
  position: relative;
  width: 100%;
  height: 100%;
  left: 0;

  &-embedded {
    width: calc(100vw + 32px);
    left: -32px;
    height: calc(100vh - 125px - 12px);
  }

  .map {
    width: 100%;
    height: 100%;
    border-radius: 15px;
  }
}

.map-pre-actions,
.map-post-actions {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 1;

  &-card {
    background-color: var(--grey-1000-50);
    font-size: 14px;
    border-radius: 4px;
    opacity: 0.9;

    &--short {
      max-width: 180px;
    }
  }

  .fr-tag {
    display: block;
  }
}

h6 {
  font-size: 16px;
}

:deep(.maplibregl-map) {
  font-family: inherit;
}

:deep(.maplibregl-popup-content) {
  border-radius: 4px;
  padding: 1rem;
  text-align: center;
  font-size: 1rem;

  .map-popup {
    &-zone {
      font-weight: bold;
    }
  }
}

.map-legend,
:deep(.maplibregl-popup-content) {
  .situation-level-bg-0 {
    background-color: #e8edff;
    color: var(--grey-50-1000);
  }
}

@media screen and (max-width: 767px) {
  .map-wrap {
    height: calc(100% - 230px);

    &--full-actions {
      height: calc(100% - 300px);
    }

    &-embedded {
      height: calc(100vh - 160px);
    }
  }

  .map-legende,
  .map-pre-actions,
  .map-post-actions {
    position: relative;
    top: 0;
    left: 0;
    bottom: 0;
    opacity: 1;

    .fr-tag {
      display: initial;
    }

    .map-pre-actions-card--short {
      max-width: initial;
    }
  }
}
</style>
