<template>
  <div>
    <VitePwaManifest />
    <NuxtLoadingIndicator />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </div>
</template>

<script setup lang="ts">
import {
  useZonePublicationStore,
  ZONE_PUBLICATION_ERROR_RETRY_MS,
} from './store/zonePublication';
import { createRetryScheduler } from './utils/retryable-task';

const zonePublicationStore = useZonePublicationStore();
const ZONE_PUBLICATION_REFRESH_MS = 60_000;
let publicationRefreshInterval: ReturnType<typeof setInterval> | null = null;
let publicationRefreshActive = false;

function refreshPublication(force = false): void {
  void zonePublicationStore
    .loadPublication(force)
    .then(() => publicationRetry.clear())
    .catch(() => {
      if (publicationRefreshActive) {
        publicationRetry.schedule();
      }
    });
}

const publicationRetry = createRetryScheduler(
  () => {
    if (publicationRefreshActive) {
      refreshPublication(true);
    }
  },
  ZONE_PUBLICATION_ERROR_RETRY_MS,
);

onMounted(() => {
  publicationRefreshActive = true;
  refreshPublication();
  publicationRefreshInterval = setInterval(
    () => refreshPublication(true),
    ZONE_PUBLICATION_REFRESH_MS,
  );
});

onUnmounted(() => {
  publicationRefreshActive = false;
  publicationRetry.clear();
  if (publicationRefreshInterval !== null) {
    clearInterval(publicationRefreshInterval);
    publicationRefreshInterval = null;
  }
});
</script>
