<script setup lang="ts">
import type { Ref } from 'vue';
import { Map, NavigationControl, FullscreenControl, LngLatBounds } from 'maplibre-gl';
import type { Commune } from '~/dto/commune.dto';
import type { Departement } from '~/dto/departement.dto';

const props = defineProps<{
  departement: Departement;
  communes: Commune[];
}>();

const mapContainer = shallowRef(null);
const map: Ref<any> = shallowRef(null);
const mapLoaded = ref(false);
const isMapSupported: boolean = useUtils().isWebglSupported();
const layers: Ref<string[]> = ref(['zoneCommunes']);
const communes: Ref<Commune[]> = ref([]);
const api = useApi();
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
      style: `https://etalab-tiles.fr/styles/osm-bright/style.json`,
      bounds: initialState,
    }),
  );

  // Add zoom and rotation controls to the map.
  map.value?.addControl(new NavigationControl(), 'bottom-right');

  // Add fullscreen control to the map.
  map.value?.addControl(new FullscreenControl(), 'bottom-right');

  map.value?.on('load', async () => {
    // COMMUNES
    const query = `depCode=${props.departement?.code}`;
    const { data, error } = await api.commune.listWithGeom(query);
    if (data.value) {
      communes.value = data.value;
    }

    // SOURCES
    map.value?.addSource('cadastre', {
      type: 'vector',
      url: `https://etalab-tiles.fr/data/decoupage-administratif.json`,
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

const populateSources = () => {
  if (!map.value || !mapLoaded.value) {
    return;
  }
  resetSources();
  const features = communes.value.filter(c => props.communes?.some(pc => pc.id === c.id))
    .map((c) => {
      return {
        type: 'Feature',
        geometry: c.geom,
      };
    });
  map.value?.addSource('zoneCommunes', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: features,
    },
  });
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
  const geoms = communes.value.filter(c => props.communes?.some(pc => pc.id === c.id))
    .map((c) => {
      return c.geom.coordinates;
    });

  if (!geoms || geoms.length < 1) {
    return;
  }
  
  let bounds = new LngLatBounds();

  geoms.forEach(g => {
    g.forEach(c => {
      if (c.length === 1) {
        c = c.flat();
      }
      bounds.extend(c);
    });
  });

  map.value?.fitBounds(bounds, {
    padding: 100,
  });
};

const showLayer = () => {
  resetSources(true);
  map.value?.addLayer({
    id: 'zoneCommunes',
    type: 'fill',
    source: 'zoneCommunes',
    paint: {
      'fill-color': '#ccc',
      'fill-opacity': {
        stops: [[5, 1], [6, 0.8], [7, 0.7], [8, 0.6], [9, 0.5], [10, 0.4], [11, 0.3]],
      },
      'fill-outline-color': '#000',
    },
  });
};

watch(
  () => props.communes,
  () => {
    populateSources();
  },
);
</script>

<template>
  <div class="map-sticky" v-if="isMapSupported">
    <div style="height: 50vh">
      <div class="map-wrap">
        <div class="map" ref="mapContainer"></div>
      </div>
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
