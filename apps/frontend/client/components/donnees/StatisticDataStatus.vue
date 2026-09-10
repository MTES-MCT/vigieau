<script setup lang="ts">
import api from '../../api';
import type { StatisticDataStatus } from '../../dto/data-status.dto';
import type { StatisticObservationStatus } from '../../utils/statistic-provisional';
import { findProvisionalStatisticPeriods } from '../../utils/statistic-provisional';
import { findMissingStatisticPeriods } from '../../utils/statistic-history-gaps';
import { getStatisticSeriesStatusPresentation } from '../../utils/statistic-series-status';
import {
  getStatisticStatusPresentation,
  isMissingStatisticStatusEndpoint,
  normalizeStatisticDataStatus,
  unavailableStatisticDataStatus,
} from '../../utils/statistic-data-status';

const props = defineProps<{
  series?: StatisticObservationStatus[] | null;
  waterType?: string;
  loading?: boolean;
}>();

const status = ref<StatisticDataStatus | null>(null);
const presentation = computed(() => props.series === undefined
  ? getStatisticStatusPresentation(status.value)
  : getStatisticSeriesStatusPresentation(status.value, {
    series: props.series,
    waterType: props.waterType ?? '',
    loading: props.loading,
    missingPeriods: findMissingStatisticPeriods(props.series),
    provisionalPeriods: findProvisionalStatisticPeriods(props.series),
  }));
const details = computed(() => presentation.value && 'details' in presentation.value ? presentation.value.details : []);

let mounted = false;
let latestStatusRequest = 0;

async function loadStatus() {
  const request = ++latestStatusRequest;
  const applyStatus = (value: StatisticDataStatus | null) => {
    if (mounted && request === latestStatusRequest) status.value = value;
  };
  try {
    const { data, error } = await api.getDataStatus();
    if (error?.value) {
      applyStatus(isMissingStatisticStatusEndpoint(error.value)
        ? null
        : unavailableStatisticDataStatus());
      return;
    }
    applyStatus(
      normalizeStatisticDataStatus(data.value) ??
      unavailableStatisticDataStatus(),
    );
  } catch (error) {
    // A 404 is expected only while an older backend is still serving traffic.
    applyStatus(isMissingStatisticStatusEndpoint(error)
      ? null
      : unavailableStatisticDataStatus());
  }
}

onMounted(() => {
  mounted = true;
  if (props.series !== null) loadStatus();
});

watch(() => props.series, (series) => {
  if (mounted && series !== undefined && series !== null) loadStatus();
});

onBeforeUnmount(() => {
  mounted = false;
  latestStatusRequest += 1;
});
</script>

<template>
  <DsfrAlert
    v-if="presentation"
    class="fr-mb-2w"
    :closeable="false"
    :description="presentation.description"
    :title="presentation.title"
    :type="presentation.type"
    :role="props.series !== undefined ? 'status' : undefined"
    :data-testid="props.series !== undefined ? 'statistic-series-status' : undefined"
  >
    <template v-if="props.series !== undefined" #default>
      <p class="fr-mb-0">
        {{ presentation.description }}
      </p>
      <details v-if="details.length" class="fr-mt-1w">
        <summary>Détails des données</summary>
        <ul class="fr-mb-0">
          <li v-for="detail in details" :key="detail">
            {{ detail }}
          </li>
        </ul>
      </details>
    </template>
  </DsfrAlert>
</template>
