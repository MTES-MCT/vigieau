<script setup lang="ts">
import {
  useZonePublicationStore,
  ZONE_PUBLICATION_ERROR_RETRY_MS,
} from './store/zonePublication';
import { focusRouteContent } from './utils/focus-management';
import { observeNewWindowLinks } from './utils/new-window-links';
import { createRetryScheduler } from './utils/retryable-task';

const route = useRoute();
const routeAnnouncement = ref('');
const zonePublicationStore = useZonePublicationStore();
const ZONE_PUBLICATION_REFRESH_MS = 60_000;
const ZONE_PUBLICATION_ERROR_RETRY_MAX_MS = 60_000;
const ZONE_PUBLICATION_ERROR_RETRY_JITTER_RATIO = 0.2;
let publicationRefreshInterval: ReturnType<typeof setInterval> | null = null;
let publicationRefreshActive = false;
let routeChangeSequence = 0;
let stopNewWindowLinkObserver: (() => void) | null = null;

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
  {
    maxDelayMs: ZONE_PUBLICATION_ERROR_RETRY_MAX_MS,
    jitterRatio: ZONE_PUBLICATION_ERROR_RETRY_JITTER_RATIO,
  },
);

watch(
  () => [route.fullPath.split('#', 1)[0], route.hash] as const,
  async ([pagePath, hash], [previousPagePath]) => {
    if (!import.meta.client) {
      return;
    }

    const pageChanged = pagePath !== previousPagePath;
    if (!pageChanged && !hash) {
      return;
    }
    if (pageChanged) {
      routeAnnouncement.value = '';
    }
    const currentSequence = ++routeChangeSequence;
    await nextTick();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (currentSequence !== routeChangeSequence) {
      return;
    }

    const target = focusRouteContent(document, hash);
    if (target && pageChanged) {
      const pageName =
        target.tagName === 'H1'
          ? target.textContent?.trim() || document.title
          : document.title;
      routeAnnouncement.value = `Page ${pageName} chargée`;
    }
  },
  { flush: 'post' },
);

onMounted(() => {
  stopNewWindowLinkObserver = observeNewWindowLinks(document);
  publicationRefreshActive = true;
  refreshPublication();
  publicationRefreshInterval = setInterval(
    () => refreshPublication(true),
    ZONE_PUBLICATION_REFRESH_MS,
  );
});

onUnmounted(() => {
  stopNewWindowLinkObserver?.();
  stopNewWindowLinkObserver = null;
  publicationRefreshActive = false;
  publicationRetry.clear();
  if (publicationRefreshInterval !== null) {
    clearInterval(publicationRefreshInterval);
    publicationRefreshInterval = null;
  }
});
</script>

<template>
  <div>
    <VitePwaManifest />
    <NuxtLoadingIndicator />
    <div
      role="status"
      class="fr-sr-only"
      aria-live="polite"
      aria-atomic="true"
    >
      {{ routeAnnouncement }}
    </div>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </div>
</template>
