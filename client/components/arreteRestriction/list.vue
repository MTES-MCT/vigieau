<script setup lang="ts">
import type { Ref } from 'vue';
import type { PaginatedResult } from '~/dto/paginated_result.dto';
import type { ArreteRestriction } from '~/dto/arrete_restriction.dto';
import { useRefDataStore } from '~/stores/refData';
import { useAuthStore } from '~/stores/auth';
import { useContextStore } from "~/stores/context";

const refDataStore = useRefDataStore();
const authStore = useAuthStore();
const route = useRoute();
const arretesRestrictionPaginated: Ref<PaginatedResult<ArreteRestriction> | null> = ref(null);
const currentPage: Ref<number> = ref(0);
const query: Ref<string> = ref(route.query.query ? route.query.query : '');
const loading = ref(false);
const statusFilter = ref('publie');
const statusOptions = ref([
  {
    label: 'En cours',
    value: 'publie',
    icon: 'ri-checkbox-circle-fill',
    'data-cy': 'ArreteRestrictionListFilterPublie',
  },
  {
    label: 'Abrogé',
    value: 'abroge',
    icon: 'ri-close-circle-fill',
    'data-cy': 'ArreteRestrictionListFilterAbroge',
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
      attribute: 'departement.id',
      filter: `$eq:${departementFilter.value}`,
    });
  }
  loading.value = true;
  const { data, error } = await api.arreteRestriction.paginate(currentPage.value + 1, query.value, filter);
  loading.value = false;
  if (data.value) {
    data.value.meta.dsfrPages = Array.from({ length: data.value.meta.totalPages }, (value, index) => {
      return {
        title: `Page ${index + 1}`,
        label: `${index + 1}`,
      };
    });
    arretesRestrictionPaginated.value = data.value;
    showZaAlert.value = statusFilter.value === 'publie' && arretesRestrictionPaginated.value?.data.some((ar) => ar.restrictions.some((r) => r.zoneAlerte?.disabled));
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
      if(!departementFilter.value && departementFilter.value !== 0) {
        departementFilter.value =
          authStore.user?.role === 'departement' ? refDataStore.departements.find((d) => authStore.user?.roleDepartements.includes(d.code)).id : null;
      } else {
        paginate();
      }
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="fr-grid-row fr-grid-row--space-between fr-grid-row--middle fr-mb-2w">
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
      Les arrêtés de restriction

      <VIcon v-if="loading" name="ri-loader-4-line" animation="spin" :width="40" :height="40" />
    </h1>
    <NuxtLink to="/arrete-restriction/nouveau/edition">
      <DsfrButton label="Créer un nouvel arrêté restriction" />
    </NuxtLink>
    <div class="fr-col-12 fr-grid-row fr-grid-row--bottom fr-grid-row--gutters fr-mt-2w">
      <div class="fr-col-12 fr-col-md-6 fr-mb-2w">
        <DsfrSegmentedSet v-model="statusFilter" :inline="true" :options="statusOptions" />
      </div>
      <div class="fr-col-12 fr-col-md-3 fr-mb-2w">
        <DsfrSearchBar :labelVisible="false" v-model="query" data-cy="ArreteRestrictionListSearchBar" />
      </div>
      <div class="fr-col-12 fr-col-md-3 fr-mb-2w">
        <DsfrSelect
          v-model="departementFilter"
          data-cy="ArreteRestrictionListDepartementSelect"
          label="Filtrer par Département"
          :options="departementsOptions"
        />
      </div>
    </div>
  </div>
  <template v-if="arretesRestrictionPaginated">
    <div class="fr-grid-row fr-grid-row--gutters fr-mb-1w">
      <div class="fr-col-12 text-align-center" v-if="arretesRestrictionPaginated.data.length < 1">
        Aucun arrêté de restriction n'a été trouvé.
      </div>
      <div v-for="arreteRestriction in arretesRestrictionPaginated.data" class="fr-col-md-4 fr-col-12">
        <ArreteRestrictionCard
          :arrete-restriction="arreteRestriction"
          :key="arreteRestriction.id"
          @delete="paginate()"
          @repeal="paginate()"
        />
      </div>
    </div>
    <div class="fr-grid-row fr-grid-row--center fr-mt-2w">
      <DsfrPagination
        v-model:current-page="currentPage"
        :pages="arretesRestrictionPaginated.meta.dsfrPages"
        @update:current-page="paginate()"
      />
    </div>
  </template>
</template>
