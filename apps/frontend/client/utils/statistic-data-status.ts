import type {
  StatisticDataStatus,
  StatisticDataStatusValue,
} from '../dto/data-status.dto';

interface StatisticStatusPresentation {
  title: string;
  description: string;
  type: 'info' | 'error';
}

export const unavailableStatisticDataStatus = (): StatisticDataStatus => ({
  status: 'unavailable',
  usable: false,
  fresh: false,
  currentFresh: false,
  latestDate: null,
  currentPublishedDate: null,
});

export const isMissingStatisticStatusEndpoint = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const error = value as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  return [error.statusCode, error.status, error.response?.status].some(
    (status) => Number(status) === 404,
  );
};

const normalizeDate = (value: unknown): string | null => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : value;
};

const normalizeOptionalString = (value: unknown): string | null | undefined =>
  value === null || typeof value === 'string' ? value : undefined;

export const normalizeStatisticDataStatus = (
  value: unknown,
): StatisticDataStatus | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const rawStatus = candidate.status;
  const status: StatisticDataStatusValue =
    rawStatus === 'updating'
      ? 'degraded'
      : rawStatus === 'ready' ||
          rawStatus === 'degraded' ||
          rawStatus === 'unavailable'
        ? rawStatus
        : candidate.usable === true
          ? 'degraded'
          : 'unavailable';

  return {
    status,
    usable: candidate.usable === true,
    fresh: candidate.fresh === true,
    currentFresh: candidate.currentFresh === true,
    latestDate: normalizeDate(candidate.latestDate),
    currentPublishedDate: normalizeDate(candidate.currentPublishedDate),
    loadedAt: normalizeOptionalString(candidate.loadedAt),
    asOf: normalizeOptionalString(candidate.asOf),
    sourceRevision: normalizeOptionalString(candidate.sourceRevision),
  };
};

export const formatCertifiedDataDate = (value: string): string =>
  new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));

export const getStatisticStatusPresentation = (
  status: StatisticDataStatus | null,
): StatisticStatusPresentation | null => {
  if (!status || (status.usable && status.currentFresh)) {
    return null;
  }

  if (status.usable && status.latestDate) {
    return {
      title: 'Mise à jour en cours',
      description: `Les dernières données certifiées disponibles datent du ${formatCertifiedDataDate(status.latestDate)}. Elles restent consultables pendant la mise à jour.`,
      type: 'info',
    };
  }

  return {
    title: 'Données temporairement indisponibles',
    description:
      'Les données certifiées ne peuvent pas être affichées pour le moment.',
    type: 'error',
  };
};
