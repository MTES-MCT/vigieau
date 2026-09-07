<script setup lang="ts">
import api from '../../api';
import { Line } from 'vue-chartjs';
import {
  ArcElement,
  CategoryScale,
  Chart as ChartJS,
  ChartOptions, Colors, Filler,
  Legend,
  LinearScale, LineController,
  LineElement, PointElement, TimeScale,
  Title,
  Tooltip,
} from 'chart.js';
import 'chartjs-adapter-luxon';
import { BassinVersant } from '../../dto/bassinVersant.dto';
import { Region } from '../../dto/region.dto';
import { Departement } from '../../dto/departement.dto';
import { useRefDataStore } from '../../store/refData';
import { helpers, required } from '@vuelidate/validators';
import moment from 'moment';
import useVuelidate from '@vuelidate/core';
import utils from '../../utils';
import { downloadElementAsPng } from '../../utils/png-download';
import { isDepartmentStatisticSeries } from '../../utils/statistic-series';
import * as Sentry from '@sentry/vue';


ChartJS.register(Title, Tooltip, Legend, LineElement, CategoryScale, LinearScale, PointElement, LineController, TimeScale, ArcElement, Colors, Filler);

const refDataStore = useRefDataStore();
const loading = ref(false);
const chartLineData = ref(null);
const dataDepartement = ref<any[] | null>(null);
const loadError = ref(false);
const hasData = computed(() => !loadError.value && (dataDepartement.value?.length ?? 0) > 0);
const computeDisabled = ref(true);
const downloadingPng = ref(false);
const pngDownloadError = ref(false);

const dateMin = ref('2013-01-01');
const tmp = new Date();
tmp.setFullYear(tmp.getFullYear() - 1);
const currentDate = ref(new Date().toISOString().split('T')[0]);
const territoire = ref({ text: 'France entière', value: '' });
const screenshotZone = ref();

const typesEauOptions = [
  {
    text: 'Tout type d\'eau',
    value: '',
  },
  {
    text: 'Eau potable',
    value: 'AEP',
  },
  {
    text: `Eau superficielle`,
    value: 'SUP',
  }, {
    text: 'Eau souterraine',
    value: 'SOU',
  },
];

const areaOptions = ref([]);

const formData = reactive({
  typeEau: '',
  dateDebut: tmp.toISOString().split('T')[0],
  dateFin: new Date().toISOString().split('T')[0],
  area: '',
});
const rules = computed(() => {
  return {
    dateDebut: {
      required: helpers.withMessage('La date de début est obligatoire.', required),
      minValue: helpers.withMessage('La date de début doit être supérieure à Janvier 2013.', (val: string) => {
        if (val) {
          return moment(val, 'YYYY-MM-DD') >= moment(dateMin.value, 'YYYY-MM-DD');
        }
        return true;
      }),
      maxValue: helpers.withMessage('La date de début doit être inférieure à la date de fin.', (val: string) => {
        if (formData.dateFin && val) {
          return moment(val, 'YYYY-MM-DD') <= moment(formData.dateFin, 'YYYY-MM-DD');
        }
        return true;
      }),
      isValid: helpers.withMessage('La date de début doit être sous la forme YYYY-MM-DD (ex : 2024-01-01).', (val: string) => {
        if (val) {
          return moment(val, 'YYYY-MM-DD', true).isValid();
        }
        return true;
      }),
    },
    dateFin: {
      required: helpers.withMessage('La date de fin est obligatoire.', required),
      minValue: helpers.withMessage('La date de fin doit être supérieure à la date de début.', (val: string) => {
        if (formData.dateDebut && val) {
          return moment(val, 'YYYY-MM-DD') >= moment(formData.dateDebut, 'YYYY-MM-DD');
        }
        return true;
      }),
      maxValue: helpers.withMessage('La date de fin doit être inférieure à la date du jour.', (val: string) => {
        if (val) {
          return moment(val, 'YYYY-MM-DD') <= moment();
        }
        return true;
      }),
      isValid: helpers.withMessage('La date de fin doit être sous la forme YYYY-MM-DD (ex : 2024-01-01).', (val: string) => {
        if (val) {
          return moment(val, 'YYYY-MM-DD', true).isValid();
        }
        return true;
      }),
    },
    area: {
      required: helpers.withMessage('Le territoire est obligatoire.', (val: string) => {
        return val !== null;
      }),
    },
    typeEau: {
      required: helpers.withMessage('Le type d\'eau est obligatoire.', (val: string) => {
        return val !== null;
      }),
    },
  };
});

const v$ = useVuelidate(rules, formData);

async function loadData() {
  if (loading.value) {
    return;
  }
  loading.value = true;
  try {
    await v$.value.$validate();
    if (v$.value.$error) {
      return;
    }
    loadError.value = false;
    const { data, error } = await api.getDataDepartement(formData.dateDebut, formData.dateFin, formData.area);
    if (error.value || !isDepartmentStatisticSeries(data.value)) {
      throw error.value || new Error('Invalid statistic response');
    }
    dataDepartement.value = data.value;
    territoire.value = areaOptions.value.find((a: any) => a.value === formData.area) || territoire.value;
    sortData();
    computeDisabled.value = true;
  } catch (error) {
    loadError.value = true;
    dataDepartement.value = null;
    chartLineData.value = null;
    computeDisabled.value = false;
    Sentry.captureException(error, { tags: { action: 'load_department_statistics' } });
  } finally {
    loading.value = false;
  }
}

function sortData() {
  if (!isDepartmentStatisticSeries(dataDepartement.value)) {
    chartLineData.value = null;
    if (dataDepartement.value !== null) {
      loadError.value = true;
      computeDisabled.value = false;
    }
    return;
  }
  loadError.value = false;
  chartLineData.value = {
    labels: dataDepartement.value.map((d: any) => d.date),
    datasets: [
      {
        label: 'Vigilance',
        data: dataDepartement.value.map((d: any) => d.departements.reduce((acc: number, dep: any) => acc + (getNiveauGravite(dep) === 'vigilance' ? 1 : 0), 0)),
        fill: {
          target: 'stack',
        },
        borderColor: '#FFEDA0',
        backgroundColor: '#FFEDA080',
      },
      {
        label: 'Alerte',
        data: dataDepartement.value.map((d: any) => d.departements.reduce((acc: number, dep: any) => acc + (getNiveauGravite(dep) === 'alerte' ? 1 : 0), 0)),
        fill: {
          target: 'stack',
        },
        borderColor: '#FEB24C',
        backgroundColor: '#FEB24C80',
      },
      {
        label: 'Alerte renforcée',
        data: dataDepartement.value.map((d: any) => d.departements.reduce((acc: number, dep: any) => acc + (getNiveauGravite(dep) === 'alerte_renforcee' ? 1 : 0), 0)),
        fill: {
          target: 'stack',
        },
        borderColor: '#FC4E2A',
        backgroundColor: '#FC4E2A80',
      },
      {
        label: 'Crise',
        data: dataDepartement.value.map((d: any) => d.departements.reduce((acc: number, dep: any) => acc + (getNiveauGravite(dep) === 'crise' ? 1 : 0), 0)),
        fill: {
          target: 'stack',
        },
        borderColor: '#B10026',
        backgroundColor: '#B1002680',
      },
    ],
  };
}

const getNiveauGravite = (departement: any) => {
  switch (formData.typeEau) {
    case 'SUP':
      return departement.niveauGraviteSup;
    case 'SOU':
      return departement.niveauGraviteSou;
    case 'AEP':
      return departement.niveauGraviteAep;
    default:
      return departement.niveauGravite;
  }
};

loadData();

const tooltipTitle = (tooltipItems: any[]): string => {
  return moment(tooltipItems[0].parsed.x).format('DD/MM/YYYY');
};

const chartLineOptions: ChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  scales: {
    x: {
      type: 'time',
      time: {
        unit: 'week',
      },
    },
    y: {
      stacked: true,
      beginAtZero: true,
      min: 0,
      suggestedMax: 5,
    },
  },
  interaction: {
    intersect: false,
    mode: 'index',
  },
  plugins: {
    tooltip: {
      callbacks: {
        title: tooltipTitle,
      },
    },
    legend: {
      position: 'bottom',
    },
  },
};

async function downloadGraph() {
  if (downloadingPng.value || loading.value || !hasData.value || !computeDisabled.value) {
    return;
  }

  downloadingPng.value = true;
  pngDownloadError.value = false;
  try {
    await downloadElementAsPng(
      screenshotZone.value,
      `graphique_departements_${territoire.value.text}_${formData.dateDebut}_${formData.dateFin}_${formData.typeEau}.png`,
      { scale: 2 },
    );
  } catch {
    pngDownloadError.value = true;
  } finally {
    downloadingPng.value = false;
  }
}

watch(() => refDataStore.departements, () => {
  areaOptions.value = [{
    text: 'France entière',
    value: '',
  }];
  areaOptions.value.push({
    text: 'Bassins Versants',
    disabled: true,
  });
  refDataStore.bassinsVersants.forEach((b: BassinVersant) => {
    areaOptions.value.push({
      text: b.nom,
      value: `bassinVersant=${b.id}`,
    });
  });
  areaOptions.value.push({
    text: 'Régions',
    disabled: true,
  });
  refDataStore.regions.forEach((r: Region) => {
    areaOptions.value.push({
      text: r.nom,
      value: `region=${r.id}`,
    });
  });
  areaOptions.value.push({
    text: 'Départements',
    disabled: true,
  });
  refDataStore.departements.forEach((d: Departement) => {
    areaOptions.value.push({
      text: d.nom,
      value: `departement=${d.id}`,
    });
  });
}, {
  immediate: true,
});
</script>

<template>
  <div ref="screenshotZone">
    <div class="fr-grid-row fr-grid-row--gutters">
      <div class="fr-col-lg-2 fr-col-md-6 fr-col-12">
        <DsfrInputGroup :error-message="utils.showInputError(v$, 'typeEau')">
          <DsfrSelect label="Type d'eau"
                      :disabled="loading"
                      v-model="formData.typeEau"
                      @update:modelValue="sortData()"
                      :options="typesEauOptions"
                      required />
        </DsfrInputGroup>
      </div>
      <div class="fr-col-lg-2 fr-col-md-6 fr-col-12">
        <DsfrInputGroup :error-message="utils.showInputError(v$, 'area')">
          <DsfrSelect label="Territoire"
                      :disabled="loading"
                      v-model="formData.area"
                      @update:modelValue="computeDisabled = false"
                      :options="areaOptions"
                      required />
        </DsfrInputGroup>
      </div>
      <div class="fr-col-lg-3 fr-col-md-6 fr-col-12">
        <DsfrInputGroup :error-message="utils.showInputError(v$, 'dateDebut')">
          <DsfrInput
            id="dateDebut"
            :disabled="loading"
            v-model="formData.dateDebut"
            @update:modelValue="computeDisabled = false"
            label="Date début"
            label-visible
            type="date"
            name="dateCarte"
            :min="dateMin"
            :max="formData.dateFin"
            required
          />
        </DsfrInputGroup>
      </div>
      <div class="fr-col-lg-3 fr-col-md-6 fr-col-12">
        <DsfrInputGroup :error-message="utils.showInputError(v$, 'dateFin')">
          <DsfrInput
            id="dateFin"
            :disabled="loading"
            v-model="formData.dateFin"
            @update:modelValue="computeDisabled = false"
            label="Date fin"
            label-visible
            type="date"
            name="dateCarte"
            :min="formData.dateDebut"
            :max="currentDate"
            required
          />
        </DsfrInputGroup>
      </div>
      <div data-html2canvas-ignore="true" class="fr-col-lg-2 fr-col-6">
        <DsfrButton :disabled="loading || computeDisabled"
                    :aria-busy="loading ? 'true' : undefined"
                    @click="loadData()">
          Calculer
        </DsfrButton>
      </div>
    </div>
    <div class="fr-col-12">
      <DsfrAlert
        title="Données historiques sur l’eau potable limitées"
        data-html2canvas-ignore="true"
        type="info"
        class="fr-my-2w"
      >
        Nous ne sommes pas en mesure de fournir les restrictions appliquées sur l'eau potable avant le 28/04/2024. Pour
        connaître les niveaux de restrictions en vigueur, veuillez vous référer aux niveaux de restrictions des eaux
        superficielles et souterraines.
      </DsfrAlert>
    </div>
    <div v-if="!loading && chartLineData && hasData" class="chart-container">
      <Line id="departement-chart-line"
            :options="chartLineOptions"
            :data="chartLineData" />
    </div>
  </div>
  <DsfrAlert v-if="loadError"
             title="Données temporairement indisponibles"
             type="error"
             class="fr-my-2w">
    Le chargement des données a échoué. Veuillez réessayer.
    <DsfrButton class="fr-mt-2w" :disabled="loading" @click="loadData()">
      Réessayer
    </DsfrButton>
  </DsfrAlert>
  <p v-else-if="!loading && !hasData" role="status" class="fr-my-2w">
    Aucune donnée disponible pour cette sélection.
  </p>
  <template v-if="!loading && !loadError">
    <div class="text-align-right fr-mt-1w">
      <DsfrButton
        :disabled="downloadingPng || !hasData || !computeDisabled"
        :aria-busy="downloadingPng ? 'true' : undefined"
        @click="downloadGraph()"
      >
        Télécharger le graphique en .png
      </DsfrButton>
    </div>
    <DsfrAlert
      v-if="pngDownloadError"
      title="Téléchargement impossible"
      class="fr-mt-2w"
      type="error"
      :closeable="false"
    >
      La génération de l’image PNG a échoué. Veuillez réessayer.
    </DsfrAlert>

    <DonneesDepartementTable class="fr-mt-4w"
                             :dataDepartement="dataDepartement"
                             :disabled="!hasData || !computeDisabled"
                             :territoire="territoire?.text"
                             :typeEau="formData.typeEau"
                             :dateDebut="formData.dateDebut"
                             :dateFin="formData.dateFin" />
  </template>
  <template v-if="loading">
    <div class="fr-grid-row fr-grid-row--center fr-my-2w">
      <Loader :show="true" />
    </div>
  </template>
</template>

<style lang="scss" scoped>
.fr-grid-row {
  align-items: end;

  :deep(.fr-select-group) {
    margin-bottom: 0;
  }
}

.chart-container {
  position: relative;
  width: 100%;
  min-width: 0;
  height: 600px;

  :deep(canvas) {
    max-width: 100%;
  }
}
</style>
