<script setup lang="ts">
import type { Ref } from 'vue';
import type { StatisticDepartement } from '~/dto/statistic_departement.dto';
import { useAuthStore } from '~/stores/auth';
import moment from 'moment';

definePageMeta({
  layout: 'basic',
  middleware: 'role',
  roles: ['mte', 'departement'],
});

useHead({
  title: `Accueil - ${useRuntimeConfig().public.appName}`,
});

const statisticDepartement: Ref<StatisticDepartement[] | undefined> = ref();

const api = useApi();
const authStore = useAuthStore();
const utils = useUtils();
const router = useRouter();
const statisticDepartementLoading = ref(true);
const statisticDepartementError = ref(false);

const loadStatisticDepartement = async () => {
  statisticDepartementLoading.value = true;
  statisticDepartementError.value = false;
  const { data, error } = await api.statisticDepartement.list();
  if (data.value) {
    statisticDepartement.value = data.value;
  }
  statisticDepartementError.value = !!error.value;
  statisticDepartementLoading.value = false;
};

const modalCheckRulesOpened = ref(false);
const modalTitle = ref('Vérification de vos règles de gestion');
const modalActions: Ref<any[]> = ref([
  {
    label: 'Modifier',
    onclick: async () => {
      utils.closeModal(modalCheckRulesOpened);
      await api.user.checkRules();
      router.push('mon-departement');
    },
  },
  {
    label: 'Fermer',
    secondary: true,
    onclick: async () => {
      utils.closeModal(modalCheckRulesOpened);
      await api.user.checkRules();
    },
  },
]);
if (
  authStore.user &&
  authStore.user.role === 'departement' &&
  (!authStore.user?.checkRules || moment(authStore.user.checkRules).isBefore(moment().subtract(1, 'years'), 'day'))
) {
  modalCheckRulesOpened.value = true;
}

onMounted(() => {
  loadStatisticDepartement();
});
</script>

<template>
  <div class="accueil">
    <h1 class="text-align-center">Bienvenue sur VigiEau Admin</h1>
    <AccueilCardsLink />
    <div class="fr-mt-2w">
      <AccueilMap />
    </div>
    <div class="fr-mt-2w">
      <div class="fr-grid-row fr-grid-row--gutters">
        <div class="fr-col-12 fr-col-lg-8">
          <AccueilStatsConsultation v-if="statisticDepartement" :statisticDepartement="statisticDepartement" />
          <div v-else class="fr-card fr-p-2w accueil-loading-card">
            <h2 class="text-align-center">Nombre de consultations VigiEau sur votre territoire</h2>
            <p v-if="statisticDepartementLoading" class="fr-mb-0">Chargement des statistiques</p>
            <DsfrAlert
              v-if="statisticDepartementError"
              type="error"
              description="Les statistiques ne sont pas disponibles pour le moment."
              :small="true"
            />
          </div>
        </div>
        <div class="fr-col-12 fr-col-lg-4">
          <AccueilStatsFeedback />
        </div>
        <!--        <div class="fr-col-12 fr-col-lg-4">-->
        <!--          <AccueilStatsRestrictions v-if="statisticDepartement" :statisticDepartement="statisticDepartement" />-->
        <!--        </div>-->
        <div class="fr-col-12 fr-col-lg-4">
          <AccueilStatsSubscriptions v-if="statisticDepartement" :statisticDepartement="statisticDepartement" />
          <div v-else class="fr-card fr-p-2w accueil-loading-card">
            <h2 class="text-align-center">Abonnements mail actifs sur mon territoire</h2>
            <p v-if="statisticDepartementLoading" class="fr-mb-0">Chargement des statistiques</p>
          </div>
        </div>
      </div>
    </div>
    <div class="fr-mt-2w">
      <AccueilLinks />
    </div>
  </div>

  <DsfrModal
    :opened="modalCheckRulesOpened"
    :title="modalTitle"
    :actions="modalActions"
    @close="modalCheckRulesOpened = utils.closeModal(modalCheckRulesOpened)"
  >
    <MonDepartementReglesModal />
  </DsfrModal>
</template>

<style lang="scss">
.accueil {
  position: relative;

  &:before {
    content: '';
    position: absolute;
    height: calc(100% + 4rem);
    width: 100vw;
    top: -2rem;
    left: -1.5rem;
    background: linear-gradient(var(--blue-france-950-100), var(--grey-975-75));
    z-index: -1;
  }

  h2 {
    font-size: 1rem;
    line-height: 1.2rem;
  }

  .accueil-loading-card {
    min-height: 8rem;
  }
}

@media (min-width: 78em) {
  .accueil {
    &:before {
      left: calc((78rem - 100vw) / 2 - 1.5rem);
    }
  }
}
</style>
