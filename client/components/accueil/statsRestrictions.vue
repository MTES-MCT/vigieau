<script setup lang="ts">
import type { StatisticDepartement } from '~/dto/statistic_departement.dto';
import NiveauGraviteBadge from '~/components/mixins/NiveauGraviteBadge.vue';
import { Doughnut } from 'vue-chartjs';
import { RestrictionNiveauGraviteFr } from '~/dto/restriction.dto';

const props = defineProps<{
  statisticDepartement: StatisticDepartement[];
}>();

const getAttributeSum = (attribute: string) => {
  return props.statisticDepartement.reduce((acc, current) => acc + current.zones[attribute], 0);
};

const chartData = ref({
  labels: [
    RestrictionNiveauGraviteFr.pas_restrictions,
    RestrictionNiveauGraviteFr.vigilance,
    RestrictionNiveauGraviteFr.alerte,
    RestrictionNiveauGraviteFr.alerte_renforcee,
    RestrictionNiveauGraviteFr.crise
  ],
  datasets: [
    {
      backgroundColor: ['#e8edff', '#ffeda0', '#feb24c', '#fc4e2a', '#b10026'],
      data: [
        getAttributeSum('pasRestriction'),
        getAttributeSum('vigilance'),
        getAttributeSum('alerte'),
        getAttributeSum('alerteRenforcee'),
        getAttributeSum('crise'),
      ],
    },
  ],
});
const chartOptions = ref({
  responsive: true,
  cutout: '80%',
  plugins: {
    legend: {
      display: false,
    },
  },
});
</script>

<template>
  <div class="fr-card fr-p-2w">
    <h2 class="text-align-center">Restrictions en cours sur mon territoire</h2>
    <div class="fr-mb-2w chart-wrapper">
      <Doughnut id="doughnut-zones" :data="chartData" :options="chartOptions" />
    </div>
    <div class="fr-grid-row fr-grid-row--space-between fr-mb-1w">
      <NiveauGraviteBadge niveau-gravite="pas_restrictions" />
      <span>{{ getAttributeSum('pasRestriction') }} zones</span>
    </div>
    <div class="fr-grid-row fr-grid-row--space-between fr-mb-1w">
      <NiveauGraviteBadge niveau-gravite="vigilance" />
      <span>{{ getAttributeSum('vigilance') }} zones</span>
    </div>
    <div class="fr-grid-row fr-grid-row--space-between fr-mb-1w">
      <NiveauGraviteBadge niveau-gravite="alerte" />
      <span>{{ getAttributeSum('alerte') }} zones</span>
    </div>
    <div class="fr-grid-row fr-grid-row--space-between fr-mb-1w">
      <NiveauGraviteBadge niveau-gravite="alerte_renforcee" />
      <span>{{ getAttributeSum('alerteRenforcee') }} zones</span>
    </div>
    <div class="fr-grid-row fr-grid-row--space-between fr-mb-1w">
      <NiveauGraviteBadge niveau-gravite="crise" />
      <span>{{ getAttributeSum('crise') }} zones</span>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.chart-wrapper {
  width: 50%;
  margin: auto;
}
</style>