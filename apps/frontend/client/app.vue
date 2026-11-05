<script setup lang="ts">
import {
  useZonePublicationStore,
  ZONE_PUBLICATION_ERROR_RETRY_MS,
} from './store/zonePublication';
import { focusRouteContent } from './utils/focus-management';
import { observeNewWindowLinks } from './utils/new-window-links';
import { createRetryScheduler } from './utils/retryable-task';
import { preprodAuthenticationRequired, preprodLoginUrl } from './utils/preprod-auth';

const route = useRoute();
const preprodAuthEnabled = useRuntimeConfig().public.preprodAuthEnabled === true;
const preprodLoginHref = computed(() => preprodLoginUrl(route.fullPath));
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
  if (preprodAuthEnabled && preprodAuthenticationRequired.value) {
    publicationRetry.clear();
    return;
  }
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
    <VitePwaManifest v-if="!preprodAuthEnabled" />
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
      <div
        v-if="preprodAuthEnabled && preprodAuthenticationRequired"
        class="fr-container fr-my-6w"
        role="alert"
      >
        <div class="fr-alert fr-alert--info">
          <h1 class="fr-alert__title">
            Connexion à la préproduction nécessaire
          </h1>
          <p>Votre session a expiré. Connectez-vous à la préproduction pour poursuivre.</p>
          <p class="fr-mt-2w">
            <a :href="preprodLoginHref" class="fr-btn">Se connecter à la préproduction</a>
          </p>
        </div>
      </div>
      <NuxtPage v-else />
    </NuxtLayout>
  </div>
</template>
