<script setup lang="ts">
import { ChartOptions } from "chart.js";
import { Line } from "vue-chartjs";
import moment from 'moment';
import { getDailyStatisticsRows } from '../../utils/statistics-accessibility';
import utils from '../../utils';

const props = defineProps<{
  stats: any
}>();

const rows = getDailyStatisticsRows(props.stats);
const tableRows = rows.map((row) => [
  moment(row.date).format('DD/MM/YYYY'),
  utils.numberWithSpaces(row.visits),
  utils.numberWithSpaces(row.restrictionsSearch),
  utils.numberWithSpaces(row.arreteDownloads),
]);
const chartLineData = {
  labels: rows.map(row => row.date),
  datasets: [
    {
      label: 'Visiteurs',
      data: rows.map(row => row.visits)
    },
    {
      label: 'Recherche de restrictions',
      data: rows.map(row => row.restrictionsSearch)
    },
    {
      label: 'Téléchargement d\'arrêtés',
      data: rows.map(row => row.arreteDownloads)
    }
  ]
};

const tooltipTitle = (tooltipItems: any[]): string => {
  return moment(tooltipItems[0].parsed.x).format('DD/MM/YYYY');
};

const chartLineOptions: ChartOptions = {
  responsive: true,
  maintainAspectRatio: true,
  scales: {
    x: {
      type: 'time',
      time: {
        unit: 'week'
      }
    }
  },
  interaction: {
    intersect: false,
    mode: 'index',
  },
  plugins: {
    tooltip: {
      callbacks: {
        title: tooltipTitle,
      }
    }
  }
};
</script>

<template>
  <DsfrCallout>
    <figure>
      <figcaption class="fr-h3">Activité quotidienne de VigiEau</figcaption>
      <p>Nombre quotidien de visites, recherches de restrictions et téléchargements d’arrêtés depuis le 10 juillet 2023.</p>
      <div aria-hidden="true">
        <Line :options="chartLineOptions"
              :data="chartLineData"
              tabindex="-1"
              :style="{'min-height': '400px'}"/>
      </div>
      <AccessibleDataTable
        table-id="daily-statistics-table"
        title="Données détaillées de l’activité quotidienne de VigiEau"
        :headers="['Date', 'Visiteurs', 'Recherches de restrictions', 'Téléchargements d’arrêtés']"
        :rows="tableRows"
        :row-header-column="0"
        table-class="fr-table--sm"
      />
    </figure>
  </DsfrCallout>  
</template>
