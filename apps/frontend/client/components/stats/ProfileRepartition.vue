<script setup lang="ts">
import { ChartOptions } from "chart.js";
import { Doughnut } from "vue-chartjs";
import utils from "../../utils";
import { getProfileStatisticsRows } from '../../utils/statistics-accessibility';

const props = defineProps<{
  stats: any
}>();

const rows = getProfileStatisticsRows(props.stats);
const tableRows = rows.map(row => [
  row.label,
  utils.numberWithSpaces(row.count),
  `${row.percentage.toFixed(2)} %`,
]);
const chartePieData = {
  labels: rows.map(row => row.label),
  datasets: [{
    data: rows.map(row => row.count),
  }]
};

const tooltipPieLabel = (tooltipItem: any): string => {
  const sum = tooltipItem.dataset.data.reduce((a: number, b: number) => {
    return a + b;
  })
  const percentage = (tooltipItem.raw * 100 / sum).toFixed(2) + "%";

  return `${utils.numberWithSpaces(tooltipItem.raw)} (${percentage})`;
};

const chartPieOptions: ChartOptions = {
  responsive: true,
  plugins: {
    tooltip: {
      callbacks: {
        label: tooltipPieLabel,
      }
    }
  }
}
</script>

<template>
  <DsfrCallout>
    <figure>
      <figcaption class="fr-h3">Répartition des profils des visiteurs sur les 30 derniers jours</figcaption>
      <div aria-hidden="true">
        <Doughnut :options="chartPieOptions"
                  :data="chartePieData"
                  tabindex="-1"
                  :style="{'max-height': '400px'}"/>
      </div>
      <AccessibleDataTable
        table-id="profile-statistics-table"
        title="Données détaillées de la répartition des profils"
        :headers="['Profil', 'Nombre', 'Pourcentage']"
        :rows="tableRows"
        :row-header-column="0"
        table-class="fr-table--sm"
      />
    </figure>
  </DsfrCallout>
</template>
