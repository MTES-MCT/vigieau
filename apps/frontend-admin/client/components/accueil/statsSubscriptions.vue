<script setup lang="ts">
import type { StatisticDepartement } from '~/dto/statistic_departement.dto';

const props = defineProps<{
  statisticDepartement: StatisticDepartement[];
}>();

const subscriptions = computed(() => {
  return props.statisticDepartement.reduce((acc, current) => acc + current.subscriptions, 0);
});
</script>

<template>
  <div class="fr-card fr-p-2w">
    <h2 class="text-align-center">Abonnements mail actifs sur mon territoire</h2>
    <div class="fr-grid-row fr-grid-row--space-between fr-mb-1w">
      <span>{{ subscriptions }} abonnées</span>
    </div>
  </div>
</template>

<style lang="scss" scoped>
</style>