<script setup lang="ts">
import type { ArreteRestriction } from '~/dto/arrete_restriction.dto';
import type { ZoneAlerte } from '~/dto/zone_alerte.dto';
import type { Ref } from 'vue';
import * as maplibregl from 'maplibre-gl';

const props = defineProps<{
  arreteRestriction: ArreteRestriction;
}>();

const api = useApi();
const zones: Ref<ZoneAlerte[]> = ref([]);

const loadGeom = async () => {
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
  populateSources();
};

const mapContainer = shallowRef(null);
const map: Ref<any> = shallowRef(null);
const isMapSupported: boolean = useUtils().isWebglSupported();
const initialState = [
  [-7.075195, 41.211722],
  [11.403809, 51.248163],
];
const layers = ref(['zoneSup', 'zoneSou']);
const layersSelected = ref(['zoneSupSelected', 'zoneSouSelected']);
const typeEauTags: Ref<any[]> = ref([
  {
    label: 'Eau superficielle',
    value: 'SUP',
  },
  {
    label: 'Eau souterraine',
    value: 'SOU',
  },
]);
const selectedTypeEau: Ref<string> = ref('SUP');

onMounted(() => {
  if (!isMapSupported) {
    return;
  }

  map.value = new maplibregl.Map({
    container: mapContainer.value,
    style: `https://openmaptiles.data.gouv.fr/styles/osm-bright/style.json`,
    bounds: initialState,
  });

  // Add zoom and rotation controls to the map.
  map.value?.addControl(new maplibregl.NavigationControl(), 'bottom-right');

  // Add fullscreen control to the map.
  map.value?.addControl(new maplibregl.FullscreenControl(), 'bottom-right');

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
    populateSources();
    computeBounds();
  });
});

const populateSources = () => {
  if (!map.value) {
    return;
  }
  resetSources();
  const zonesSup = zones.value.filter((z) => z.type === 'SUP');
  const zonesSou = zones.value.filter((z) => z.type === 'SOU');
  map.value?.addSource('zoneSup', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: zonesSup
        .filter((z) => !props.arreteRestriction.restrictions.some((r) => r.zoneAlerte.id === z.id))
        .map((z) => {
          return {
            type: 'Feature',
            geometry: z.geom,
          };
        }),
    },
  });
  map.value?.addSource('zoneSupSelected', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: zonesSup
        .filter((z) => props.arreteRestriction.restrictions.some((r) => r.zoneAlerte.id === z.id))
        .map((z) => {
          return {
            type: 'Feature',
            geometry: z.geom,
          };
        }),
    },
  });
  map.value?.addSource('zoneSou', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: zonesSou
        .filter((z) => !props.arreteRestriction.restrictions.some((r) => r.zoneAlerte.id === z.id))
        .map((z) => {
          return {
            type: 'Feature',
            geometry: z.geom,
          };
        }),
    },
  });
  map.value?.addSource('zoneSouSelected', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: zonesSou
        .filter((z) => props.arreteRestriction.restrictions.some((r) => r.zoneAlerte.id === z.id))
        .map((z) => {
          return {
            type: 'Feature',
            geometry: z.geom,
          };
        }),
    },
  });
  populateLayers();
};

const populateLayers = () => {
  layers.value.forEach((layerName: string) => {
    map.value?.addLayer({
      id: layerName,
      type: 'line',
      source: layerName,
      layout: {
        visibility: 'none',
      },
      paint: {
        'line-color': layerName.includes('zoneSup') ? '#7AB1E8' : '#CE614A',
        'line-opacity': 0.6,
      },
    });
  });
  layersSelected.value.forEach((layerName: string) => {
    map.value?.addLayer({
      id: layerName,
      type: 'fill',
      source: layerName,
      layout: {
        visibility: 'none',
      },
      paint: {
        'fill-color': layerName.includes('zoneSup') ? '#7AB1E8' : '#CE614A',
        'fill-opacity': 0.6,
        'fill-outline-color': layerName.includes('zoneSup') ? '#7AB1E8' : '#CE614A',
      },
    });
  });
  showLayer();
};

const resetSources = () => {
  try {
    layers.value.forEach((l) => {
      map.value?.removeLayer(l);
      map.value?.removeSource(l);
    });
    layersSelected.value.forEach((l) => {
      map.value?.removeLayer(l);
      map.value?.removeSource(l);
    });
  } catch (e) {}
};

const computeBounds = () => {
  const coordinates = zones.value.map((z) => {
    return z.geom.coordinates;
  }).flat(3);

  const bounds = coordinates.reduce(function(bounds, coord) {
    return bounds.extend(coord);
  }, new maplibregl.LngLatBounds(coordinates[0], coordinates[0]));

  map.value?.fitBounds(bounds, {
    padding: 20
  });
}

const showLayer = () => {
  if (selectedTypeEau.value === 'SUP') {
    map.value.setLayoutProperty('zoneSup', 'visibility', 'visible');
    map.value.setLayoutProperty('zoneSupSelected', 'visibility', 'visible');
    map.value.setLayoutProperty('zoneSou', 'visibility', 'none');
    map.value.setLayoutProperty('zoneSouSelected', 'visibility', 'none');
  } else {
    map.value.setLayoutProperty('zoneSup', 'visibility', 'none');
    map.value.setLayoutProperty('zoneSupSelected', 'visibility', 'none');
    map.value.setLayoutProperty('zoneSou', 'visibility', 'visible');
    map.value.setLayoutProperty('zoneSouSelected', 'visibility', 'visible');
  }
};

onUnmounted(() => {
  map.value?.remove();
});

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
  </div>
</template>

<style lang="scss">
.map-wrap {
  height: calc(50vh);
  position: relative;

  .map {
    width: 100%;
    height: 100%;
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
