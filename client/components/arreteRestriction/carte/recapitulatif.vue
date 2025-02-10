<script setup lang="ts">
import type { ArreteRestriction } from '~/dto/arrete_restriction.dto';
import type { Ref } from 'vue';
import { Map, NavigationControl, FullscreenControl, LngLatBounds } from 'maplibre-gl';
import type { ZoneAlerte } from '~/dto/zone_alerte.dto';
import type { Commune } from '~/dto/commune.dto';
import NiveauGraviteBadge from '~/components/mixins/NiveauGraviteBadge.vue';

const props = defineProps<{
  arreteRestriction: ArreteRestriction;
}>();

const computeTypeEauTags = () => {
  const toReturn = [];
  const toReturnLayers = [];
  if (props.arreteRestriction.restrictions.some(r => r.zoneAlerte?.type === 'SUP')) {
    toReturn.push({
      label: 'Eau superficielle',
      value: 'SUP',
    });
    toReturnLayers.push('zoneSup');
  }
  if (props.arreteRestriction.restrictions.some(r => r.zoneAlerte?.type === 'SOU')) {
    toReturn.push({
      label: 'Eau souterraine',
      value: 'SOU',
    });
    toReturnLayers.push('zoneSou');
  }
  if (props.arreteRestriction.restrictions.some(r => r.isAep) || props.arreteRestriction.ressourceEapCommunique) {
    toReturn.push({
      label: 'Eau potable',
      value: 'AEP',
    });
    toReturnLayers.push('zoneAep');
  }

  typeEauTags.value = toReturn;
  layers.value = toReturnLayers;
  selectedTypeEau.value = typeEauTags.value[0].value;
};

const mapContainer = shallowRef(null);
const map: Ref<any> = shallowRef(null);
const mapLoaded = ref(false);
const isMapSupported: boolean = useUtils().isWebglSupported();
const typeEauTags: Ref<any[]> = ref([]);
const layers: Ref<string[]> = ref([]);
const selectedTypeEau: Ref<string | undefined> = ref();
computeTypeEauTags();
const initialState = [
  [-7.075195, 41.211722],
  [11.403809, 51.248163],
];

onMounted(async () => {
  await new Promise((r) => setTimeout(r, 100));
  if (!isMapSupported) {
    return;
  }

  map.value = markRaw(
    new Map({
      container: mapContainer.value,
      style: `https://openmaptiles.data.gouv.fr/styles/osm-bright/style.json`,
      bounds: initialState,
    }),
  );

  // Add zoom and rotation controls to the map.
  map.value?.addControl(new NavigationControl(), 'bottom-right');

  // Add fullscreen control to the map.
  map.value?.addControl(new FullscreenControl(), 'bottom-right');

  map.value?.on('load', () => {
    // SOURCES
    map.value?.addSource('cadastre', {
      type: 'vector',
      url: `https://openmaptiles.data.gouv.fr/data/decoupage-administratif.json`,
    });

    // LAYER
    map.value?.addLayer({
      id: 'departements-data',
      type: 'line',
      source: 'cadastre',
      'source-layer': 'departements',
      layout: {
        'line-join': 'round',
        'line-cap': 'round',
      },
      paint: {
        'line-color': '#888888',
        'line-width': 1,
      },
    });
    map.value?.addLayer({
      id: 'communes-data',
      type: 'line',
      source: 'cadastre',
      'source-layer': 'communes',
      layout: {
        'line-join': 'round',
        'line-cap': 'round',
      },
      paint: {
        'line-color': '#557ad9',
        'line-width': 1,
      },
    });
    mapLoaded.value = true;
    populateSources();
    computeBounds();
  });
});

onUnmounted(() => {
  map.value?.remove();
});

const api = useApi();
const zones: Ref<ZoneAlerte[]> = ref([]);
const communes: Ref<Commune[]> = ref([]);

const loadGeom = async () => {
  // ZONES
  const newZones = [];
  const results = await Promise.all(props.arreteRestriction.arretesCadre.map((ac) => api.zoneAlerte.getByArreteCadre(ac.id)));
  results.forEach((r) => {
    if (r.data.value) {
      r.data.value.forEach((z) => {
        if (!newZones.some((nz) => nz.id === z.id)) {
          newZones.push(z);
        }
      });
    }
  });
  zones.value = newZones;

  // COMMUNES
  const query = `depCode=${props.arreteRestriction.departement?.code}`;
  const { data, error } = await api.commune.listWithGeom(query);
  if (data.value) {
    communes.value = data.value;
  }
  populateSources();
};

const populateSources = () => {
  if (!map.value || !mapLoaded.value) {
    return;
  }
  resetSources();
  const zonesSup = zones.value.filter((z) => z.type === 'SUP');
  const zonesSou = zones.value.filter((z) => z.type === 'SOU');
  const featuresSup = zonesSup
    .filter((z) => props.arreteRestriction.restrictions.some((r) => r.zoneAlerte?.id === z.id))
    .map((z) => {
      return {
        type: 'Feature',
        geometry: z.geom,
        properties: {
          niveauGravite: props.arreteRestriction.restrictions.find((r) => r.zoneAlerte?.id === z.id)?.niveauGravite,
        },
      };
    });
  const featuresSou = zonesSou
    .filter((z) => props.arreteRestriction.restrictions.some((r) => r.zoneAlerte?.id === z.id))
    .map((z) => {
      return {
        type: 'Feature',
        geometry: z.geom,
        properties: {
          niveauGravite: props.arreteRestriction.restrictions.find((r) => r.zoneAlerte?.id === z.id)?.niveauGravite,
        },
      };
    });
  if (layers.value.includes('zoneSup')) {
    map.value?.addSource('zoneSup', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: featuresSup,
      },
    });
  }
  if (layers.value.includes('zoneSou')) {
    map.value?.addSource('zoneSou', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: featuresSou,
      },
    });
  }
  if (layers.value.includes('zoneAep')) {
    let features: any[] = [];
    if (!props.arreteRestriction.niveauGraviteSpecifiqueEap && props.arreteRestriction.ressourceEapCommunique) {
      switch (props.arreteRestriction.ressourceEapCommunique) {
        case 'eso':
          features = featuresSou;
          break;
        case 'esu':
          features = featuresSup;
          break;
        case 'max':
          features = featuresSou.concat(featuresSup);
          break;
      }
    } else {
      features = communes.value
        .filter((c) => props.arreteRestriction.restrictions.some((r) => r.communes?.some((rc) => rc.id === c.id)))
        .map((c) => {
          return {
            type: 'Feature',
            geometry: c.geom,
            properties: {
              niveauGravite: props.arreteRestriction.restrictions.find((r) => r.communes?.some((rc) => rc.id === c.id))?.niveauGravite,
            },
          };
        });
    }
    map.value?.addSource('zoneAep', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: features,
      },
    });
  }
  showLayer();
};

const resetSources = (onlyLayers = false) => {
  try {
    layers.value.forEach((l) => {
      if (map.value?.getLayer(l)) {
        map.value?.removeLayer(l);
      }
      if (map.value?.getSource(l) && !onlyLayers) {
        map.value?.removeSource(l);
      }
    });
  } catch (e) {
  }
};

const computeBounds = () => {
  const geoms = zones.value
    .map((z) => {
      return z.geom.coordinates;
    });

  let bounds = new LngLatBounds();

  geoms.forEach(g => {
    g.forEach(c => {
      if(c.length === 1) {
        c = c.flat();
      }
      bounds.extend(c);
    });
  });

  map.value?.fitBounds(bounds, {
    padding: 20,
  });
};

const showLayer = () => {
  resetSources(true);
  const layerName = selectedTypeEau.value === 'SUP' ? 'zoneSup' : selectedTypeEau.value === 'SOU' ? 'zoneSou' : 'zoneAep';
  map.value?.addLayer({
    id: layerName,
    type: 'fill',
    source: layerName,
    paint: {
      'fill-color': [
        'match',
        ['get', 'niveauGravite'],
        'vigilance',
        '#ffeda0',
        'alerte',
        '#feb24c',
        'alerte_renforcee',
        '#fc4e2a',
        'crise',
        '#b10026',
        /* other */ '#ccc',
      ],
      'fill-opacity': {
        stops: [[5, 1], [6, 0.8], [7, 0.7], [8, 0.6], [9, 0.5], [10, 0.4], [11, 0.3]],
      },
      'fill-outline-color': '#000',
    },
  });
};

watch(
  () => props.arreteRestriction.arretesCadre,
  () => {
    if (props.arreteRestriction) {
      loadGeom();
    }
  },
  { immediate: true },
);

watch(
  () => props.arreteRestriction.restrictions,
  () => {
    populateSources();
  },
);

watch(
  () => props.arreteRestriction.restrictions.map((r) => r.niveauGravite),
  () => {
    populateSources();
  },
);
</script>

<template>
  <div class="map-sticky" v-if="isMapSupported">
    <div class="map-pre-actions">
      <div class="map-pre-actions-card fr-p-1w fr-m-1w">
        <DsfrRadioButton
          v-for="option of typeEauTags"
          :modelValue="selectedTypeEau"
          v-bind="option"
          :small="true"
          class="fr-mb-0"
          @update:modelValue="
            selectedTypeEau = $event;
            showLayer();
          "
        />
      </div>
    </div>
    <div style="height: 50vh">
      <div class="map-wrap">
        <div class="map" ref="mapContainer"></div>
      </div>
    </div>

    <div class="fr-mt-1w">
      <NiveauGraviteBadge niveau-gravite="vigilance" class="fr-mr-1w" />
      <NiveauGraviteBadge niveau-gravite="alerte" class="fr-mr-1w" />
      <NiveauGraviteBadge niveau-gravite="alerte_renforcee" class="fr-mr-1w" />
      <NiveauGraviteBadge niveau-gravite="crise" />
    </div>

    <DsfrAlert
      type="info"
      class="fr-mt-2w"
      description="La règle de gestion de votre département n'est pas prise en compte sur cette carte mais sera prise en compte lors de l'affichage de Vigieau"
    />
  </div>
</template>

<style lang="scss">
.map-wrap {
  height: calc(50vh);
  width: 100%;
  position: relative;

  .map {
    position: absolute;
    height: 100%;
    width: 100%;
  }
}

.map-sticky {
  position: sticky;
  top: 20px;
}

.maplibregl-map {
  font-family: inherit;
}

.map-pre-actions {
  position: absolute;
  top: 5px;
  left: 5px;
  z-index: 1;

  &-card {
    background-color: var(--grey-1000-50);
    border-radius: 4px;
    opacity: 0.9;
  }
}
</style>
