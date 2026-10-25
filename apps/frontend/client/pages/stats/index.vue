<script setup lang="ts">
import { Ref } from 'vue';
import {
  ArcElement,
  CategoryScale,
  Chart as ChartJS,
  Colors,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  TimeScale,
  Title,
  Tooltip,
} from 'chart.js';
import 'chartjs-adapter-luxon';
import api from '../../api';
import utils from '../../utils';
import { normalizeAudienceStatistics, sumKnownCounts } from '../../utils/audience-statistics';

definePageMeta({
  layout: 'basic',
});

useHead({
  title: `Statistiques - ${useRuntimeConfig().public.appName}`,
});

const links: Ref<any[]> = ref([{ 'to': '/', 'text': 'Accueil' }, { 'text': 'Statistiques' }]);

ChartJS.register(Title, Tooltip, Legend, LineElement, CategoryScale, LinearScale, PointElement, LineController, TimeScale, ArcElement, Colors);

const { data, error, status, refresh } = await api.getStats();
const statistics = computed(() => normalizeAudienceStatistics(data.value));
const cumulativeVisits = computed(() => sumKnownCounts(statistics.value?.statsByDay.map(day => day.visits) || []));
const visitsLabel = computed(() => statistics.value?.statsByDay.some(day => day.visits === null)
  ? 'visites sur les jours renseignés'
  : 'visites sur la période affichée');
const formatDate = (date: string) => new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC' }).format(new Date(date));
</script>

<template>
  <div class="fr-container">
    <AppBreadcrumb :links="links" />
    <div>
      <h1>Statistiques de fréquentation</h1>
      <div v-if="error || !statistics" role="status">
        <p>Les statistiques de fréquentation sont momentanément indisponibles.</p>
        <DsfrButton label="Réessayer" icon="fr-icon-refresh-line" :disabled="status === 'pending'" @click="refresh()" />
      </div>
      <template v-else>
        <p v-if="statistics.period">
          Période du {{ formatDate(statistics.period.from) }} au {{ formatDate(statistics.period.to) }}.
        </p>
        <p v-if="statistics.stale && statistics.lastDataDate" class="fr-highlight">
          Dernières données disponibles : {{ formatDate(statistics.lastDataDate) }}. Les chiffres ci-dessous ne reflètent pas l'activité récente.
        </p>
        <p v-if="statistics.partial">
          Certaines mesures manquent sur cette période.
        </p>
        <div class="fr-grid-row fr-grid-row--top fr-grid-row--gutters">
          <div class="fr-col-12">
            <StatsLineChart :stats="statistics" />
          </div>
          <div class="fr-col-12 fr-col-md-6">
            <StatsProfileRepartition :stats="statistics" />
          </div>
          <div class="fr-col-12 fr-col-md-6 fr-grid-row fr-grid-row--gutters">
            <div class="fr-col-12">
              <DsfrCallout
                :title="statistics.subscriptions === null ? 'Donnée indisponible' : utils.numberWithSpaces(statistics.subscriptions)"
                content="nouveaux abonnements aux alertes mail sur la période affichée"
              />
            </div>
            <div class="fr-col-12">
              <DsfrCallout
                :title="cumulativeVisits === null ? 'Donnée indisponible' : utils.numberWithSpaces(cumulativeVisits)"
                :content="visitsLabel"
              />
            </div>
          </div>
          <div class="fr-col-12">
            <StatsDepartementWrapper :stats="statistics" />
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
