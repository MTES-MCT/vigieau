<script setup lang="ts">
import type { MissingStatisticPeriod } from '../../utils/statistic-history-gaps';

defineProps<{ periods: MissingStatisticPeriod[] }>();

const formatDate = (date: string) => new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC' }).format(new Date(`${date}T00:00:00.000Z`));
</script>

<template>
  <div role="status">
    <DsfrAlert
      v-if="periods.length"
      title="Données manquantes sur la période"
      type="warning"
      class="fr-my-2w"
    >
      <p>Les données ne sont pas disponibles aux dates suivantes. Ces absences ne signifient pas une absence de restrictions.</p>
      <ul>
        <li v-for="period in periods" :key="period.start">
          <template v-if="period.days === 1">
            Le {{ formatDate(period.start) }} : 1 jour sans donnée.
          </template>
          <template v-else>
            Du {{ formatDate(period.start) }} au {{ formatDate(period.end) }} : {{ period.days }} jours sans donnée.
          </template>
        </li>
      </ul>
    </DsfrAlert>
  </div>
</template>
