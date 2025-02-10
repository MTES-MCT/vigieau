<script setup lang="ts">
import type { Ref } from 'vue';
import type { ArreteCadre } from '~/dto/arrete_cadre.dto';
import type { PaginatedResult } from '~/dto/paginated_result.dto';
import { useRefDataStore } from '~/stores/refData';
import { useAuthStore } from '~/stores/auth';
import { useContextStore } from '~/stores/context';

const refDataStore = useRefDataStore();
const authStore = useAuthStore();
const arretesCadrePaginated: Ref<PaginatedResult<ArreteCadre> | null> = ref(null);
const currentPage: Ref<number> = ref(0);
const query: Ref<string> = ref('');
const loading = ref(false);
const statusFilter = ref('publie');
const statusOptions = ref([
  {
    label: 'En cours',
    value: 'publie',
    icon: 'ri-checkbox-circle-fill',
    'data-cy': 'ArreteCadreListFilterPublie',
  },
  {
    label: 'Abrogé',
    value: 'abroge',
    icon: 'ri-close-circle-fill',
    'data-cy': 'ArreteCadreListFilterAbroge',
  },
]);
const departementsOptions: Ref<any[] | undefined> = ref();
const contextStore = useContextStore();
const departementFilter = ref(contextStore.departementFilter);
const showZaAlert = ref(false);

const api = useApi();

const paginate = async () => {
  const filter = [
    {
      attribute: 'statut',
      filter: `$in:${statusFilter.value === 'publie' ? 'publie,a_valider,a_venir' : 'abroge'}`,
    },
  ];
  if (departementFilter.value && Number(departementFilter.value) !== 0) {
    filter.push({
      attribute: 'departements.id',
      filter: `$eq:${departementFilter.value}`,
    });
  }
  loading.value = true;
  const { data, error } = await api.arreteCadre.paginate(currentPage.value + 1, query.value, filter);
  loading.value = false;
  if (data.value) {
    data.value.meta.dsfrPages = Array.from({ length: data.value.meta.totalPages }, (value, index) => {
      return {
        title: `Page ${index + 1}`,
        label: `${index + 1}`,
      };
    });
    arretesCadrePaginated.value = data.value;
    showZaAlert.value = statusFilter.value === 'publie' && arretesCadrePaginated.value?.data.some((ac) => ac.zonesAlerte.some((za) => za.disabled));
  }
};

watch(
  query,
  useUtils().debounce(async () => {
    paginate();
  }, 500),
);

watch(statusFilter, () => {
  paginate();
});

watch(departementFilter, () => {
  contextStore.setDepartementFilter(Number(departementFilter.value));
  paginate();
});

watch(
  () => refDataStore.departements,
  () => {
    if (refDataStore.departements && refDataStore.departements.length > 0) {
      departementsOptions.value = refDataStore.departements.map((d) => {
        return {
          value: d.id,
          text: `${d.code} - ${d.nom}`,
        };
      });
      departementsOptions.value?.unshift({
        value: 0,
        text: 'Tous les départements',
      });
      if (!departementFilter.value && departementFilter.value !== 0) {
        departementFilter.value =
          authStore.user?.role === 'departement' ? refDataStore.departements.filter((d) => authStore.user?.roleDepartements.includes(d.code))[0].id : 0;
      } else {
        paginate();
      }
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="fr-grid-row fr-grid-row--space-between fr-grid-row--middle fr-mb-2w" data-cy="ArreteCadreListHeader">
    <DsfrAlert
      v-if="showZaAlert"
      class="fr-mb-2w full-width"
      type="warning"
      title="Zones d'alerte modifiées"
      description="Des modifications importantes ont été apportées sur une ou plusieurs zones d’alerte."
      :closeable="true"
      @close="showZaAlert = false"
    />
    <h1 class="fr-my-0">
      Les arrêtés cadre

      <VIcon v-if="loading" name="ri-loader-4-line" animation="spin" :width="40" :height="40" />
    </h1>
    <NuxtLink to="/arrete-cadre/nouveau/edition">
      <DsfrButton label="Créer un nouvel arrêté cadre" data-cy="ArreteCadreListAddBtn" />
    </NuxtLink>
    <div class="fr-col-12 fr-grid-row fr-grid-row--bottom fr-grid-row--gutters fr-mt-2w">
      <div class="fr-col-12 fr-col-md-6 fr-mb-2w">
        <DsfrSegmentedSet v-model="statusFilter"
                          :inline="true"
                          :options="statusOptions" />
      </div>
      <div class="fr-col-12 fr-col-md-3 fr-mb-2w">
        <DsfrSearchBar :labelVisible="false" v-model="query" data-cy="ArreteCadreListSearchBar" />
      </div>
      <div class="fr-col-12 fr-col-md-3 fr-mb-2w">
        <DsfrSelect
          v-model="departementFilter"
          data-cy="ArreteCadreListDepartementSelect"
          label="Filtrer par Département"
          :options="departementsOptions"
        />
      </div>
    </div>
  </div>
  <template v-if="arretesCadrePaginated">
    <div class="fr-grid-row fr-grid-row--gutters fr-mb-1w" data-cy="ArreteCadreList">
      <div class="fr-col-12 text-align-center" v-if="arretesCadrePaginated.data.length < 1">Aucun arrêté cadre n'a été trouvé.</div>
      <div v-for="arreteCadre in arretesCadrePaginated.data" class="fr-col-md-4 fr-col-12">
        <ArreteCadreCard :arrete-cadre="arreteCadre" :key="arreteCadre.id" @delete="paginate()" @repeal="paginate()" />
      </div>
    </div>
    <div class="fr-grid-row fr-grid-row--center fr-mt-2w">
      <DsfrPagination v-model:current-page="currentPage" :pages="arretesCadrePaginated.meta.dsfrPages" @update:current-page="paginate()" />
    </div>
  </template>
</template>
