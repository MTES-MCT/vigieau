<script setup lang="ts">
import type { ChartOptions } from 'chart.js';
import { Line } from 'vue-chartjs';
import type { StatisticDepartement } from '~/dto/statistic_departement.dto';

const props = defineProps<{
  statisticDepartement: StatisticDepartement[];
}>();

const chartLineData = ref();
const fullData = ref();

const tooltipTitle = (tooltipItems: any[]): string => {
  const date = new Date(tooltipItems[0].parsed.x);
  const year: string | number = date.getFullYear();
  let month: string | number = date.getMonth() + 1;
  let dt: string | number = date.getDate();

  if (dt < 10) {
    dt = '0' + dt;
  }
  if (month < 10) {
    month = '0' + month;
  }

  return `${dt}/${month}/${year}`;
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
  },
};


const dateMin = computed(() => {
  const dates = props.statisticDepartement?.map((s: any) => s.visits?.map((v: any) => new Date(v.date))).flat();
  return dates && dates.length > 0 ? new Date(Math.min(...dates?.map(date => date.getTime()))).toISOString().split('T')[0] :
    new Date().toISOString().split('T')[0];
});
const dateDebut = ref(dateMin.value);
const dateFin = ref(new Date().toISOString().split('T')[0]);
const currentDate = ref(new Date().toISOString().split('T')[0]);

const computeData = () => {
  const dates = props.statisticDepartement?.map((s: any) => s.visits?.map((v: any) => v.date))
    .flat();
  const uniqueDates = Array.from(new Set(dates));
  uniqueDates.sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

  const data: any[] = [];
  uniqueDates.map(d => {
    const visits = props.statisticDepartement?.map(s => {
      return s.visits.find((v: any) => v.date === d)?.visits;
    }).reduce((acc, current) => acc + current, 0);

    data.push({
      date: d,
      visits: visits,
    });
  });

  fullData.value = data;
};

const filterData = () => {
  const filteredData = fullData.value.filter(d => {
    const date = new Date(d.date);
    const dateDebutValue = new Date(dateDebut.value);
    const dateFinValue = new Date(dateFin.value);
    return date.getTime() >= dateDebutValue.getTime() && date.getTime() <= dateFinValue.getTime();
  });

  chartLineData.value = {
    labels: filteredData.map(d => new Date(d.date)),
    datasets: [
      {
        label: 'Visiteurs',
        data: filteredData.map(d => d.visits),
      },
    ],
  };
};

computeData();
filterData();

watch([dateDebut, dateFin], () => {
  filterData();
});
</script>

<template>
  <div class="fr-card fr-p-2w">
    <h2 class="text-align-center">Nombre de consultations VigiEau sur votre territoire</h2>
    <div class="fr-grid-row">
      <DsfrInputGroup>
        <DsfrInput
          id="dateDebut"
          v-model="dateDebut"
          label="Date début"
          label-visible
          type="date"
          name="dateCarte"
          :min="dateMin"
          :max="dateFin"
        />
      </DsfrInputGroup>
      <DsfrInputGroup>
        <DsfrInput
          class="fr-ml-1w"
          id="dateFin"
          v-model="dateFin"
          label="Date fin"
          label-visible
          type="date"
          name="dateCarte"
          :min="dateDebut"
          :max="currentDate"
        />
      </DsfrInputGroup>
    </div>
    <div v-if="chartLineData">
      <Line :options="chartLineOptions"
            id="stats-consultation-line"
            :data="chartLineData" />
    </div>
  </div>
</template>

<style lang="scss" scoped>
.fr-card {
  & > div {
    .fr-h1 {
      color: inherit;
    }
  }
}

#stats-consultation-line {
  height: 400px;
  max-height: 400px;
}
</style>