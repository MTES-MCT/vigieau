<script setup lang="ts">
import api from '../../api';
import type { ZonePublicationPin } from '../../api';
import utils from '../../utils';
import { createLatestTaskRunner } from '../../utils/retryable-task';
import type { Ref } from 'vue';
import { json2csv } from 'json-2-csv';

type DepartmentRow = [string, string, string];

const props = defineProps<{
  date: string;
  area: string;
  light: boolean;
  filterText: string;
  publicationPin?: ZonePublicationPin | null;
}>();

const headers = ['N° Département', 'Département', 'Niveau de gravité'];
const dataResume = reactive([
  {
    label: 'Pas de restrictions',
    niveauGravite: 'pas_de_restrictions',
    number: 0,
  },
  {
    label: 'Vigilance',
    niveauGravite: 'vigilance',
    number: 0,
  },
  {
    label: 'Alerte',
    niveauGravite: 'alerte',
    number: 0,
  },
  {
    label: 'Alerte renforcée',
    niveauGravite: 'alerte_renforcee',
    number: 0,
  },
  {
    label: 'Crise',
    niveauGravite: 'crise',
    number: 0,
  },
]);
const query = ref('');
const rows: Ref<DepartmentRow[]> = ref([]);
const rowsFiltered: Ref<DepartmentRow[]> = ref([]);
const loading = ref(false);
const departementsData: Ref<any[]> = ref([]);
const filterStatus = ref('');
const dataTaskRunner = createLatestTaskRunner();

const formatDepartmentCount = (count: number): string => {
  return `${count} département${count === 1 ? '' : 's'}`;
};

async function loadData() {
  rows.value = [];
  loading.value = true;
  const date = props.date;
  const area = props.area;
  const publicationPin = props.publicationPin;
  await dataTaskRunner.run(
    async () => {
      try {
        const response = await api.getDepartmentsData(
          date,
          area,
          publicationPin,
        );
        return { response };
      } catch (error) {
        return { error };
      }
    },
    (result) => {
      dataResume.forEach((resume) => (resume.number = 0));
      if ('error' in result || result.response.error.value) {
        departementsData.value = [];
        rows.value = [];
        rowsFiltered.value = [];
        filterStatus.value = '';
        loading.value = false;
        return;
      }

      const nextRows: DepartmentRow[] = [];
      departementsData.value = result.response.data.value || [];
      result.response.data.value?.forEach((department: any) => {
        const resume = dataResume.find(
          (item) =>
            item.niveauGravite ===
            (department.niveauGraviteMax || 'pas_de_restrictions'),
        );
        nextRows.push([
          String(department.code),
          String(department.nom),
          resume?.label || 'Pas de restrictions',
        ]);
        if (resume) resume.number++;
      });
      query.value = '';
      rows.value = nextRows;
      rowsFiltered.value = [...nextRows];
      filterStatus.value = `${formatDepartmentCount(nextRows.length)} affiché${nextRows.length === 1 ? '' : 's'}.`;
      loading.value = false;
    },
  );
}

const classObject = (rank: number | undefined): string[] => {
  return [`situation-level-bg-${rank}`];
};

function filterDepartments() {
  const normalizedQuery = query.value.trim().toLocaleLowerCase('fr');
  rowsFiltered.value = normalizedQuery
    ? rows.value.filter((row) =>
        row.some((cell) =>
          cell.toLocaleLowerCase('fr').includes(normalizedQuery),
        ),
      )
    : [...rows.value];
  const count = rowsFiltered.value.length;
  filterStatus.value = normalizedQuery
    ? `${formatDepartmentCount(count)} trouvé${count === 1 ? '' : 's'} pour « ${query.value.trim()} ».`
    : `${formatDepartmentCount(count)} affiché${count === 1 ? '' : 's'}.`;
}

async function downloadCsv() {
  const formatDepartements = departementsData.value.map((departement: any) => {
    return {
      code: departement.code,
      nom: departement.nom,
      region: departement.region,
      niveau_gravite_max: departement.niveauGraviteMax,
    };
  });
  const csv = await json2csv(formatDepartements, {
    expandArrayObjects: true,
  });

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `situation_departement_${props.date}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
}

const tableTitle = computed(() => {
  return `Niveau de gravité maximal observé par département ${props.filterText ? '(' + props.filterText + ')' : ''}`;
});

const pageTitle = computed(() => {
  return `Situation de la sécheresse en France (niveau de gravité maximum constaté par département) ${props.filterText ? ' - ' + props.filterText : ''}`;
});

watch(
  () => props,
  () => {
    const date = new Date(props.date);
    if (!date) {
      return;
    }
    loadData();
  },
  { immediate: true, deep: true },
);

onBeforeUnmount(() => {
  dataTaskRunner.cancel();
});
</script>

<template>
  <div class="carte-table" :class="light ? 'carte-table__light' : ''">
    <template v-if="rows.length > 0">
      <div class="carte-table-header">
        <h3 class="fr-mt-2w fr-mb-1w fr-h4">
          {{ pageTitle }}
        </h3>
        <ul class="departement-card-list fr-mb-2w">
          <li
            v-for="resume of dataResume"
            :key="resume.niveauGravite"
            class="departement-card"
          >
            <DsfrBadge
              small
              no-icon
              :class="
                classObject(utils.getRestrictionRank(resume.niveauGravite))
              "
              :label="resume.label"
            />
            <span class="departement-card__number fr-mt-1w">
              {{ formatDepartmentCount(resume.number) }}
            </span>
          </li>
        </ul>
      </div>

      <div class="carte-table-body">
        <form
          v-if="!light"
          class="department-filter fr-mb-2w"
          role="search"
          @submit.prevent="filterDepartments"
        >
          <div class="fr-input-group department-filter__field">
            <label class="fr-label" for="department-filter">
              Rechercher un département
            </label>
            <input
              id="department-filter"
              v-model="query"
              class="fr-input"
              type="search"
              autocomplete="off"
            >
          </div>
          <button class="fr-btn department-filter__submit" type="submit">
            Rechercher un département
          </button>
        </form>

        <AccessibleDataTable
          table-id="departments-table"
          :title="tableTitle"
          :headers="headers"
          :rows="rowsFiltered"
          :status-prefix="filterStatus"
          pagination-context="du tableau des départements"
          table-class="fr-table--sm"
          fixed-layout
        />
      </div>

      <div class="carte-table__download text-align-right fr-mt-1w">
        <DsfrButton @click="downloadCsv()">
          Télécharger les données (CSV)
        </DsfrButton>
      </div>
    </template>
    <template v-else-if="loading">
      <div class="fr-grid-row fr-grid-row--center fr-my-2w">
        <Loader :show="true" />
      </div>
    </template>
    <template v-else>
      <p class="fr-mt-4w">
        Une erreur est survenue dans la récupération des données. Veuillez
        ré-essayer dans quelques instants.
      </p>
    </template>
  </div>
</template>

<style scoped lang="scss">
.carte-table {
  max-width: 100%;
  min-width: 0;

  &-header,
  &-body {
    padding: 0 2rem;
  }

  &.carte-table__light {
    .carte-table {
      &-header,
      &-body {
        padding: 0;
      }
    }
  }

  &-body {
    min-width: 0;
    padding-bottom: 1rem;
  }

  &__download {
    max-width: 100%;
  }

  .loader {
    text-align: center;
  }
}

.departement-card-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(11rem, 100%), 1fr));
  gap: 1rem;
  padding: 0;
  list-style: none;
}

.departement-card {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: flex-start;
  padding: 1rem;
  border: 1px solid var(--border-default-grey);
  border-radius: 4px;
  background-color: var(--grey-1000-50);

  &__number {
    color: var(--background-action-high-blue-france);
    font-weight: bold;
  }
}

.department-filter {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  align-items: flex-end;

  &__field {
    min-width: min(18rem, 100%);
    flex: 1 1 18rem;
    margin-bottom: 0;
  }

  &__submit {
    flex: 0 1 auto;
  }
}

@media screen and (max-width: 767px) {
  .carte-table {
    &-header,
    &-body {
      padding-right: 1rem;
      padding-left: 1rem;
    }

    &__download {
      padding-right: 1rem;
      padding-left: 1rem;
    }

    &__download :deep(.fr-btn) {
      max-width: 100%;
      white-space: normal;
    }
  }

  .department-filter__submit {
    width: 100%;
    justify-content: center;
  }

}
</style>
