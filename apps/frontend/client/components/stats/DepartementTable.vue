<script setup lang="ts">
import type { Ref } from 'vue';
import utils from '../../utils';

const props = defineProps<{
  stats: any;
}>();

const headers = ['N° Département', 'Nombre recherches', '% recherches'];
const query = ref('');
const rowsFiltered: Ref<string[][]> = ref([]);
const filterStatus = ref('');
const sumSearches = Object.values(
  props.stats.departementRepartition,
).reduce((total: number, count: unknown) => total + Number(count), 0);
const rows = Object.keys(props.stats.departementRepartition)
  .map((departmentCode): string[] => {
    const searchCount = props.stats.departementRepartition[departmentCode];

    return [
      departmentCode,
      utils.numberWithSpaces(searchCount),
      `${((searchCount * 100) / sumSearches).toFixed(2)}%`,
    ];
  })
  .sort((firstRow, secondRow) =>
    new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: 'base',
    }).compare(firstRow[0], secondRow[0]),
  );

const formatDepartmentCount = (count: number): string => {
  return `${count} département${count === 1 ? '' : 's'}`;
};

function filterDepartments() {
  const normalizedQuery = query.value.trim().toLocaleLowerCase('fr');
  rowsFiltered.value = normalizedQuery
    ? rows.filter((row) =>
        row.some((cell) =>
          cell.toLocaleLowerCase('fr').includes(normalizedQuery),
        ),
      )
    : [...rows];

  const count = rowsFiltered.value.length;
  filterStatus.value = normalizedQuery
    ? `${formatDepartmentCount(count)} trouvé${count === 1 ? '' : 's'} pour « ${query.value.trim()} ».`
    : `${formatDepartmentCount(count)} affiché${count === 1 ? '' : 's'}.`;
}

filterDepartments();
</script>

<template>
  <template v-if="rows.length > 0">
    <form
      class="department-stats-filter fr-mb-2w"
      role="search"
      @submit.prevent="filterDepartments"
    >
      <div class="fr-input-group department-stats-filter__field">
        <label class="fr-label" for="department-stats-filter">
          Rechercher un département dans les statistiques
        </label>
        <input
          id="department-stats-filter"
          v-model="query"
          class="fr-input"
          type="search"
          autocomplete="off"
        >
      </div>
      <button class="fr-btn department-stats-filter__submit" type="submit">
        Rechercher un département dans les statistiques
      </button>
    </form>

    <AccessibleDataTable
      table-id="department-search-statistics-table"
      title="Répartition des recherches par département"
      :headers="headers"
      :rows="rowsFiltered"
      :status-prefix="filterStatus"
      pagination-context="du tableau des statistiques par département"
      fixed-layout
    />
  </template>
  <template v-else>
    <p class="fr-mt-4w">
      Une erreur est survenue dans la récupération des données. Veuillez
      ré-essayer dans quelques instants.
    </p>
  </template>
</template>

<style scoped lang="scss">
.department-stats-filter {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  align-items: flex-end;

  &__field {
    min-width: min(18rem, 100%);
    flex: 1 1 18rem;
    margin-bottom: 0;
  }
}

@media screen and (max-width: 767px) {
  .department-stats-filter__submit {
    width: 100%;
    justify-content: center;
  }
}
</style>
