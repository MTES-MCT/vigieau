import type { ZonePublication } from '../dto/zone-publication.dto';

export const LOCAL_DATE_CHECK_INTERVAL_MS = 60_000;

export interface LocalDateRollover {
  check: () => void;
  stop: () => void;
}

interface LocalDateRolloverOptions {
  now?: () => Date;
  intervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export const formatLocalCivilDate = (date = new Date()): string =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');

export const createLocalDateRollover = (
  onRollover: (currentDate: string, previousDate: string) => void,
  options: LocalDateRolloverOptions = {},
): LocalDateRollover => {
  const now = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? LOCAL_DATE_CHECK_INTERVAL_MS;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  let currentDate = formatLocalCivilDate(now());

  const check = (): void => {
    const nextDate = formatLocalCivilDate(now());
    if (nextDate === currentDate) {
      return;
    }
    const previousDate = currentDate;
    currentDate = nextDate;
    onRollover(nextDate, previousDate);
  };

  const interval = setIntervalFn(check, intervalMs);

  return {
    check,
    stop: () => clearIntervalFn(interval),
  };
};

export const getHttpErrorStatus = (error: any): number | undefined =>
  error?.response?.status ?? error?.statusCode ?? error?.status;

export const classifyManifestFailure = (
  error: unknown,
  hasValidPublication = false,
): 'legacy' | 'keep' | 'error' => {
  const status = getHttpErrorStatus(error);
  // The previous API routes /zones/publication through /zones/:id and returns
  // 400 from its integer parser. Both statuses therefore mean "legacy API".
  if (status === 400 || status === 404) {
    return 'legacy';
  }
  return hasValidPublication ? 'keep' : 'error';
};

export type ManifestFailureAction = 'legacy' | 'serve-cache' | 'throw';

export const getManifestFailureAction = (
  failure: ReturnType<typeof classifyManifestFailure>,
  force: boolean,
): ManifestFailureAction => {
  if (failure === 'legacy') {
    return 'legacy';
  }
  if (failure === 'keep' && !force) {
    return 'serve-cache';
  }
  return 'throw';
};

export const getNextSuccessfulRefreshVersion = (
  currentVersion: number,
  force: boolean,
): number => (force ? currentVersion + 1 : currentVersion);

export const ZONE_PUBLICATION_LEGACY_HEAD_TIMEOUT_MS = 3_000;

interface LegacyPmtilesHeadResponse {
  headers: {
    get: (name: string) => string | null;
  };
}

export type LegacyPmtilesHeadFetcher = (
  url: string,
  options: {
    method: 'HEAD';
    cache: 'no-store';
    retry: 0;
    timeout: number;
  },
) => Promise<LegacyPmtilesHeadResponse>;

export async function fetchLegacyPmtilesEtag(
  url: string,
  fetchHead: LegacyPmtilesHeadFetcher,
): Promise<string | null> {
  try {
    const response = await fetchHead(url, {
      method: 'HEAD',
      cache: 'no-store',
      retry: 0,
      timeout: ZONE_PUBLICATION_LEGACY_HEAD_TIMEOUT_MS,
    });
    return response.headers.get('etag')?.trim() || null;
  } catch {
    return null;
  }
}

export const selectLegacyPmtilesEtag = (
  currentEtag: string | null,
  candidateEtag: string | null | undefined,
): string | null => candidateEtag?.trim() || currentEtag;

export const buildLegacyPmtilesUrl = (
  configuredUrl: string,
  etag: string | null,
): string => {
  if (!etag) {
    return configuredUrl;
  }
  const url = new URL(configuredUrl);
  url.searchParams.set('etag', etag);
  return url.toString();
};

export const isZonePublication = (value: unknown): value is ZonePublication => {
  const publication = value as Partial<ZonePublication> | null;
  return Boolean(
    publication &&
    typeof publication.id === 'string' &&
    publication.id &&
    typeof publication.revision === 'string' &&
    publication.revision &&
    typeof publication.pmtilesUrl === 'string' &&
    publication.pmtilesUrl &&
    typeof publication.pmtilesChecksum === 'string' &&
    publication.pmtilesChecksum,
  );
};

export const isCurrentMapDate = (
  dateValue?: string,
  today = new Date(),
): boolean => {
  if (!dateValue) {
    return true;
  }

  const civilDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  const date = civilDate
    ? new Date(
        Number(civilDate[1]),
        Number(civilDate[2]) - 1,
        Number(civilDate[3]),
      )
    : new Date(dateValue);

  if (Number.isNaN(date.getTime())) {
    return false;
  }

  if (
    civilDate &&
    (date.getFullYear() !== Number(civilDate[1]) ||
      date.getMonth() !== Number(civilDate[2]) - 1 ||
      date.getDate() !== Number(civilDate[3]))
  ) {
    return false;
  }

  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
};

export const getDepartmentsApiDate = (
  requestedDate: string,
  now = new Date(),
): string =>
  isCurrentMapDate(requestedDate, now)
    ? now.toISOString().slice(0, 10)
    : requestedDate;

export const getMapPublicationStateKey = (
  publicationId: string | null | undefined,
  manifestStatus: string,
  pmtilesUrl: string,
): string =>
  JSON.stringify([publicationId ?? null, manifestStatus, pmtilesUrl]);

export const shouldRefreshZonePublication = (
  responseStatus: number | undefined,
  hasExplicitPublicationPin: boolean,
): boolean => responseStatus === 410 && !hasExplicitPublicationPin;

export const shouldReplaceZoneLayers = (
  displayedPmtilesUrl: string | null,
  nextPmtilesUrl: string,
  hasZoneSource: boolean,
): boolean =>
  Boolean(
    nextPmtilesUrl &&
    (!hasZoneSource || displayedPmtilesUrl !== nextPmtilesUrl),
  );

export const buildPublishedZonePath = (
  path: string,
  searchParams: URLSearchParams,
  publicationId?: string | null,
): string => {
  const params = new URLSearchParams(searchParams);
  if (publicationId) {
    params.set('publicationId', publicationId);
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
};
