<script setup lang="ts">
import type { ProvisionalStatisticPeriod } from '../../utils/statistic-provisional';

defineProps<{ periods: ProvisionalStatisticPeriod[] }>();

const formatDate = (date: string) => new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC' }).format(new Date(`${date}T00:00:00.000Z`));
</script>

<template>
  <div role="status">
    <DsfrAlert
      v-if="periods.length"
      title="Recalcul de l'historique en cours"
      type="info"
      class="fr-my-2w"
      :closeable="false"
    >
      <p>Les derni&egrave;res valeurs calcul&eacute;es restent affich&eacute;es pendant le recalcul de l'historique. Ces donn&eacute;es sont provisoires et peuvent &eacute;voluer.</p>
      <ul>
        <li v-for="period in periods" :key="period.start">
          <template v-if="period.days === 1">
            Le {{ formatDate(period.start) }} : 1 jour de donn&eacute;es provisoires.
          </template>
          <template v-else>
            Du {{ formatDate(period.start) }} au {{ formatDate(period.end) }} : {{ period.days }} jours de donn&eacute;es provisoires.
          </template>
        </li>
      </ul>
    </DsfrAlert>
  </div>
</template>
