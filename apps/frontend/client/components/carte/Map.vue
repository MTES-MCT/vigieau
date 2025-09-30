<script setup lang="ts">
import * as maplibregl from 'maplibre-gl';
import { PMTiles, Protocol } from 'pmtiles';
import { Ref } from 'vue';
import api from '../../api';
import { useRefDataStore } from '../../store/refData';

const props = defineProps<{
  embedded: any;
  date: string;
  area: string;
  loading: boolean;
  hideDownloadBtn: boolean;
  hideTypeEau: boolean;
  typeEau: string;
  profil: string;
}>();

const emit = defineEmits<{
  downloadMap: any;
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
const depsSelected = ref([]);
const loading = ref(false);

const initialState = [
  [-7.075195, 41.211722],
  [11.403809, 51.248163],
];

let protocol = new Protocol();
maplibregl.addProtocol('pmtiles', (request) => {
  return new Promise((resolve, reject) => {
    const callback = (err, data) => {
      if (err) {
        showError.value = true;
        reject(err);
      } else {
        showError.value = false;
        resolve({ data });
      }
    };
    protocol.tile(request, callback);
  });
});
const PMTILES_URL = `${runtimeConfig.public.s3vhost}pmtiles/zones_arretes_en_vigueur.pmtiles`;
const PMTILES_URL_TRUNC = `${runtimeConfig.public.s3vhost}pmtiles/zones_arretes_en_vigueur`;
const p = new PMTiles(PMTILES_URL);
// this is so we share one instance across the JS code and the map renderer
protocol.add(p);
let firstSymbolId: any;

// Create a popup, but don't add it to the map yet.
const popup = new maplibregl.Popup({
  closeButton: true,
  closeOnClick: false,
}).setMaxWidth('300px');

onMounted(() => {
  if (!isMapSupported) {
    return;
  }

  map.value = new maplibregl.Map({
    container: mapContainer.value,
    style: `https://openmaptiles.data.gouv.fr/styles/osm-bright/style.json`,
    bounds: initialState,
    preserveDrawingBuffer: true,
    minZoom: 4,
    maxZoom: 14,
  });

  // Add zoom and rotation controls to the map.
  map.value?.addControl(new maplibregl.NavigationControl(), 'bottom-right');

  // Add geolocate control to the map.
  map.value?.addControl(
    new maplibregl.GeolocateControl({
      positionOptions: {
        enableHighAccuracy: true,
      },
      trackUserLocation: true,
    }),
    'bottom-right',
  );

  // Add fullscreen control to the map.
  map.value?.addControl(new maplibregl.FullscreenControl(), 'bottom-right');

  map.value?.on('load', () => {
    const layers = map.value.getStyle().layers;
    for (let i = 0; i < layers.length; i++) {
      if (layers[i].type === 'symbol') {
        firstSymbolId = layers[i].id;
        break;
      }
    }
    map.value?.addSource('decoupage-administratif', {
      type: 'vector',
      url: `https://openmaptiles.data.gouv.fr/data/decoupage-administratif.json`,
    });
    addSourceAndLayerZones(PMTILES_URL);
  });

  map.value?.on('click', async (e: any) => {
    if (loading.value) return;
    loading.value = true;

    try {
      // 1) Identifier le layer "zones" actif selon le type sélectionné
      const activeZoneLayerId =
        selectedTypeEau.value === 'AEP'
          ? 'zones-AEP'
          : selectedTypeEau.value === 'SUP'
          ? 'zones-SUP'
          : 'zones-SOU';

      // 2) Récupérer les features cliquées sur ce layer
      const features =
        map.value?.queryRenderedFeatures(e.point, {
          layers: [activeZoneLayerId],
        }) ?? [];
      const properties = features.map((f: any) => f.properties);

      // 3) Mettre à jour la sélection (ids) pour le contour
      zonesSelected.value = properties.map((p: any) => p.id);

      // 4) Géocodage inverse + données géo
      const { lng, lat } = e.lngLat;
      const [dataAddress, dataGeo] = await Promise.all([
        api.searchAddressByLatlon(lng, lat).then((r: any) => r.data),
        api.searchGeoByLatlon(lng, lat).then((r: any) => r.data),
      ]);

      // 5) Générer le HTML de la popup
      const description = utils.generatePopupHtml(
        properties,
        showRestrictionsBtn.value,
        dataAddress.value?.features?.[0],
        dataGeo.value?.[0],
      );

      // 6) Mettre à jour le contour (ne filtre que par id désormais)
      updateContourFilter();

      // 7) Afficher la popup + flyTo léger
      popup.setLngLat(e.lngLat).setHTML(description).addTo(map.value);
      map.value.flyTo({
        center: [
          lng - 0.5 / map.value.getZoom(),
          lat - 0.7 / (map.value.getZoom() + 5),
        ],
        essential: true,
        speed: 0.2,
      });

      // 8) Bouton de la popup : recherche détaillée
      const btn = document.getElementsByClassName('btn-map-popup')[0] as
        | HTMLElement
        | undefined;
      if (btn) {
        btn.addEventListener(
          'click',
          async () => {
            // On force l’adresse à la coordonnée exacte du clic
            const address = {
              geometry: { coordinates: [lng, lat] },
              properties: {
                citycode: dataAddress.value?.features?.[0]?.properties?.citycode
                  ? dataAddress.value.features[0].properties.citycode
                  : dataGeo.value?.[0]?.code ?? null,
                label: `${dataGeo.value?.[0]?.nom}, ${dataGeo.value?.[0]?.codeDepartement}`,
              },
            };

            utils.searchZones(
              address,
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
            );
          },
          { once: true }, // évite les multiples handlers
        );
      }
    } catch (err) {
      console.error(err);
    } finally {
      loading.value = false;
    }
  });

  map.value?.on('mouseenter', 'zones-data', () => {
    // Change the cursor style as a UI indicator.
    map.value.getCanvas().style.cursor = 'pointer';
  });

  map.value?.on('mouseleave', 'zones-data', () => {
    map.value.getCanvas().style.cursor = '';
  });
});

onUnmounted(() => {
  map.value?.remove();
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

const setLayerVisibility = (id: string, visible: boolean) => {
  if (!map.value?.getLayer(id)) return;
  map.value.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
};

const updateLayerVisibility = () => {
  setLayerVisibility('zones-SOU', selectedTypeEau.value === 'SOU'); // adapte si inversion ESO/ESU
  setLayerVisibility('zones-SUP', selectedTypeEau.value === 'SUP');
  setLayerVisibility('zones-AEP', selectedTypeEau.value === 'AEP');

  setLayerVisibility('zones-contour-SOU', selectedTypeEau.value === 'SOU');
  setLayerVisibility('zones-contour-SUP', selectedTypeEau.value === 'SUP');
  setLayerVisibility('zones-contour-AEP', selectedTypeEau.value === 'AEP');
};

const updateContourFilter = () => {
  ['zones-contour-ESO', 'zones-contour-ESU', 'zones-contour-AEP'].forEach(
    (id) => {
      if (map.value?.getLayer(id)) {
        map.value.setFilter(id, ['in', 'id', ...zonesSelected.value]);
      }
    },
  );
};

const updateDepartementsContourFilter = () => {
  map.value?.setFilter('departements-contour', [
    'in',
    'code',
    ...depsSelected.value.map((d: any) => d.code),
  ]);
};

const closeModal = () => {
  modalOpened.value = false;
};

const addSourceAndLayerZones = (pmtilesUrl: string) => {
  [
    'zones-SOU',
    'zones-SUP',
    'zones-AEP',
    'departements-data',
    'departements-overlay',
    'departements-contour',
    'zones-contour-SOU',
    'zones-contour-SUP',
    'zones-contour-AEP',
  ].forEach((id) => {
    if (map.value?.getLayer(id)) map.value?.removeLayer(id);
  });

  if (map.value?.getSource('zones')) map.value?.removeSource('zones');

  map.value?.addSource('zones', {
    type: 'vector',
    url: `pmtiles://${pmtilesUrl}`,
    maxZoom: 10,
  });

  const visible = (t: string) =>
    selectedTypeEau.value === t ? 'visible' : 'none';

  const commonFillPaint: any = {
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
  };

  map.value?.addLayer(
    {
      id: 'zones-SOU',
      type: 'fill',
      source: 'zones',
      'source-layer': 'SOU',
      layout: { visibility: visible('SOU') },
      paint: commonFillPaint,
    },
    firstSymbolId,
  );

  map.value?.addLayer(
    {
      id: 'zones-SUP',
      type: 'fill',
      source: 'zones',
      'source-layer': 'SUP',
      layout: { visibility: visible('SUP') },
      paint: commonFillPaint,
    },
    firstSymbolId,
  );

  map.value?.addLayer(
    {
      id: 'zones-AEP',
      type: 'fill',
      source: 'zones',
      'source-layer': 'AEP',
      layout: { visibility: visible('AEP') },
      paint: commonFillPaint,
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

  // --- LAYERS CONTOUR (line) ---
  const commonLinePaint: any = { 'line-color': '#000091', 'line-width': 3 };

  map.value?.addLayer(
    {
      id: 'zones-contour-SOU',
      type: 'line',
      source: 'zones',
      'source-layer': 'SOU',
      layout: { visibility: visible('SOU') },
      // le filtre ne garde que les features sélectionnées
      filter: ['in', 'id', ...zonesSelected.value],
      paint: commonLinePaint,
    },
    firstSymbolId,
  );

  map.value?.addLayer(
    {
      id: 'zones-contour-SUP',
      type: 'line',
      source: 'zones',
      'source-layer': 'SUP',
      layout: { visibility: visible('SUP') },
      filter: ['in', 'id', ...zonesSelected.value],
      paint: commonLinePaint,
    },
    firstSymbolId,
  );

  map.value?.addLayer(
    {
      id: 'zones-contour-AEP',
      type: 'line',
      source: 'zones',
      'source-layer': 'AEP',
      layout: { visibility: visible('AEP') },
      filter: ['in', 'id', ...zonesSelected.value],
      paint: commonLinePaint,
    },
    firstSymbolId,
  );
};

const resetZoneSelected = () => {
  zonesSelected.value = [];
  updateContourFilter();
  popup.remove();
};

async function downloadMap() {
  emit('downloadMap', selectedTypeEau.value);
}

watch(
  () => props.typeEau,
  () => {
    selectedTypeEau.value = props.typeEau;
    updateLayerVisibility();
  },
);

watch(
  () => selectedTypeEau.value,
  () => {
    resetZoneSelected();
    updateLayerVisibility();
  },
);

watch(
  () => props.date,
  () => {
    const date = new Date(props.date);
    if (!date || !map.value) {
      return;
    }
    resetZoneSelected();
    if (date < new Date('2024-04-28')) {
      if (selectedTypeEau.value === 'AEP') {
        selectedTypeEau.value = 'SUP';
      }
      typeEauTags.value[0].disabled = true;
    } else {
      typeEauTags.value[0].disabled = false;
    }
    const today = new Date();
    if (
      date.getFullYear() === today.getFullYear() &&
      date.getMonth() === today.getMonth() &&
      date.getDate() === today.getDate()
    ) {
      addSourceAndLayerZones(PMTILES_URL);
      showRestrictionsBtn.value = true;
    } else {
      const p = new PMTiles(`${PMTILES_URL_TRUNC}_${props.date}.pmtiles`);
      protocol.add(p);
      addSourceAndLayerZones(`${PMTILES_URL_TRUNC}_${props.date}.pmtiles`);
      showRestrictionsBtn.value = false;
    }
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
            selectedTypeEau = $event as string;
            updateLayerVisibility();
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
        'map-wrap--loading': loading,
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

  &--loading :deep(.maplibregl-canvas-container.maplibregl-interactive) {
    cursor: wait;
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
