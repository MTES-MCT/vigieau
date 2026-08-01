import { $fetch } from 'ofetch';
import { defineStore } from 'pinia';
import { computed, Ref, ref } from 'vue';
import type { ZonePublication } from '../dto/zone-publication.dto';
import {
  classifyManifestFailure,
  getManifestFailureAction,
  getNextSuccessfulRefreshVersion,
  isZonePublication,
} from '../utils/zone-publication';

export type ZonePublicationManifestStatus =
  | 'idle'
  | 'ready'
  | 'legacy'
  | 'error';

export const ZONE_PUBLICATION_TIMEOUT_MS = 3_000;
export const ZONE_PUBLICATION_LEGACY_RETRY_MS = 30_000;
export const ZONE_PUBLICATION_ERROR_RETRY_MS = 5_000;

export const useZonePublicationStore = defineStore(
  'zonePublicationStore',
  () => {
    const publication: Ref<ZonePublication | null> = ref(null);
    const manifestStatus: Ref<ZonePublicationManifestStatus> = ref('idle');
    const successfulRefreshVersion: Ref<number> = ref(0);
    let loadingPromise: Promise<ZonePublication | null> | null = null;
    let retryAfter = 0;
    let lastLoadError: Error | null = null;

    const configuredPmtilesUrl = computed(() => {
      const runtimeConfig = useRuntimeConfig();
      const defaultUrl = `${runtimeConfig.public.s3vhost}pmtiles/zones_arretes_en_vigueur.pmtiles`;
      return String(runtimeConfig.public.pmtilesUrl || defaultUrl).trim();
    });

    const pmtilesUrl = computed(() => {
      if (publication.value) {
        return publication.value.pmtilesUrl;
      }
      return manifestStatus.value === 'legacy'
        ? configuredPmtilesUrl.value
        : '';
    });

    async function loadPublication(
      force = false,
    ): Promise<ZonePublication | null> {
      if (!force && publication.value) {
        return publication.value;
      }
      if (!force && Date.now() < retryAfter) {
        if (manifestStatus.value === 'legacy') {
          return null;
        }
        throw lastLoadError || new Error('Manifest des zones indisponible.');
      }
      if (loadingPromise) {
        return loadingPromise;
      }

      const runtimeConfig = useRuntimeConfig();
      loadingPromise = $fetch<ZonePublication>('/zones/publication', {
        baseURL: runtimeConfig.public.apiSecheresseUrl,
        cache: 'no-store',
        retry: 0,
        timeout: ZONE_PUBLICATION_TIMEOUT_MS,
      })
        .then((value) => {
          if (!isZonePublication(value)) {
            throw new Error('Manifest des zones invalide.');
          }
          publication.value = value;
          manifestStatus.value = 'ready';
          retryAfter = 0;
          lastLoadError = null;
          successfulRefreshVersion.value = getNextSuccessfulRefreshVersion(
            successfulRefreshVersion.value,
            force,
          );
          return publication.value;
        })
        .catch((error: unknown) => {
          const failure = classifyManifestFailure(
            error,
            Boolean(publication.value),
          );
          const failureAction = getManifestFailureAction(failure, force);
          if (failureAction === 'legacy') {
            publication.value = null;
            manifestStatus.value = 'legacy';
            retryAfter = Date.now() + ZONE_PUBLICATION_LEGACY_RETRY_MS;
            lastLoadError = null;
            successfulRefreshVersion.value = getNextSuccessfulRefreshVersion(
              successfulRefreshVersion.value,
              force,
            );
            return null;
          }

          manifestStatus.value = 'error';
          retryAfter = Date.now() + ZONE_PUBLICATION_ERROR_RETRY_MS;
          lastLoadError =
            error instanceof Error ? error : new Error(String(error));
          if (failureAction === 'serve-cache' && publication.value) {
            return publication.value;
          }
          throw lastLoadError;
        })
        .finally(() => {
          loadingPromise = null;
        });

      return loadingPromise;
    }

    return {
      publication,
      manifestStatus,
      successfulRefreshVersion,
      pmtilesUrl,
      configuredPmtilesUrl,
      loadPublication,
    };
  },
);
