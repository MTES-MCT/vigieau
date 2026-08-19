<script setup lang="ts">
import api from '../../api';
import type { StatisticDataStatus } from '../../dto/data-status.dto';
import {
  getStatisticStatusPresentation,
  isMissingStatisticStatusEndpoint,
  normalizeStatisticDataStatus,
  unavailableStatisticDataStatus,
} from '../../utils/statistic-data-status';

const status = ref<StatisticDataStatus | null>(null);
const presentation = computed(() =>
  getStatisticStatusPresentation(status.value),
);

onMounted(async () => {
  try {
    const { data, error } = await api.getDataStatus();
    if (error?.value) {
      status.value = isMissingStatisticStatusEndpoint(error.value)
        ? null
        : unavailableStatisticDataStatus();
      return;
    }
    status.value =
      normalizeStatisticDataStatus(data.value) ??
      unavailableStatisticDataStatus();
  } catch (error) {
    // A 404 is expected only while an older backend is still serving traffic.
    status.value = isMissingStatisticStatusEndpoint(error)
      ? null
      : unavailableStatisticDataStatus();
  }
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
  />
</template>
