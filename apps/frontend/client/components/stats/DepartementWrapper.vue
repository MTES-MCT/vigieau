<script setup lang="ts">
import { Ref } from 'vue';

const props = defineProps<{
  stats: any
}>();
const hasGeographicData = computed(() => Object.keys(props.stats.departementRepartition).length > 0
  || Object.keys(props.stats.regionRepartition).length > 0);

const tabs = [
  { id: 'map', label: 'Carte' },
  { id: 'data', label: 'Données' },
];
const selectedTabIndex: Ref<number> = ref(0);
</script>

<template>
  <DsfrCallout title="Répartition géographique des recherches sur la période affichée">
    <AccessibleTabs
      v-if="hasGeographicData"
      v-model="selectedTabIndex"
      id-prefix="search-statistics"
      label="Présentation de la répartition géographique des recherches"
      :tabs="tabs"
    >
      <template #map>
        <StatsDepartementMap :stats="stats" />
      </template>
      <template #data>
        <div class="fr-mt-2w">
          <StatsDepartementTable :stats="stats" />
        </div>
      </template>
    </AccessibleTabs>
    <p v-else>
      La répartition géographique des recherches n'est pas disponible pour cette période.
    </p>
  </DsfrCallout>
</template>

<style scoped lang="scss">
.fr-tabs {
  box-shadow: none;

  &:before {
    box-shadow: none;
  }

  :deep(.fr-tabs__panel) {
    padding-top: 0;
    padding-bottom: 0;
    z-index: 1;
    background-color: var(--background-alt-grey);
  }
}
</style>
