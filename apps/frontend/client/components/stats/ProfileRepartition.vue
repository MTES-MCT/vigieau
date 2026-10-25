<script setup lang="ts">
import { ChartOptions } from "chart.js";
import { Doughnut } from "vue-chartjs";
import { Profile } from "../../dto/profile.enum";
import utils from "../../utils";
import { knownCounts, statisticPercentage, sumKnownCounts } from '../../utils/audience-statistics';

const props = defineProps<{
  stats: any
}>();

const counts = knownCounts(props.stats.profileRepartition);
const profiles = Object.keys(Profile).filter(profile => profile in counts);
const total = sumKnownCounts(profiles.map(profile => counts[profile]));
const chartePieData = {
  labels: profiles.map(profile => Profile[profile]),
  datasets: [{
    data: []
  }]
};
profiles.forEach(p => {
  chartePieData.datasets[0].data.push(counts[p]);
});

const tooltipPieLabel = (tooltipItem: any): string => {
  const sum = sumKnownCounts(tooltipItem.dataset.data);
  const percentage = statisticPercentage(tooltipItem.raw, sum);

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
  <DsfrCallout title="Répartition des profils des visiteurs sur la période affichée">
    <Doughnut
      v-if="total !== null && total > 0" :options="chartPieOptions"
      :data="chartePieData"
      :style="{'max-height': '400px'}"
    />
    <p v-else-if="total === 0">
      Aucune visite enregistrée pour ces profils sur la période.
    </p>
    <p v-else>
      La répartition des profils n'est pas disponible pour cette période.
    </p>
  </DsfrCallout>
</template>
