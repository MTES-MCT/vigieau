import type { EntityManager } from 'typeorm';
import { shiftCivilDate } from '../core/scheduling/daily-job-schedule';
import {
  getCurrentParisCivilDate,
  HistoricStatisticRange,
  normalizeCivilDate,
} from '../shared/arrete-date-continuity';

export interface HistoricInvalidationQueryExecutor {
  query(query: string, parameters?: unknown[]): Promise<unknown>;
}

export interface HistoricComputeInvalidation {
  affectedFrom: string | null;
  affectedThrough?: string | null;
  invalidatesStatistics: boolean;
  invalidatesMaps: boolean;
  cause: string;
  sourceRevision?: string | number | null;
  context?: Record<string, unknown>;
  requestedMapDate?: string | null;
  requestedStatsDate?: string | null;
  forceCursor?: boolean;
  resetCursors?: boolean;
  bumpBackfillEpoch?: boolean;
  bumpHistoricEpoch?: boolean;
  onlyIfCursorRewinds?: boolean;
}

export interface HistoricComputeInvalidationResult {
  historicComputeEpoch: string | number;
  computeMapDate: string | Date | null;
  computeStatsDate: string | Date | null;
  changed: boolean;
}

export const RECORD_HISTORIC_COMPUTE_INVALIDATION_SQL = `
  SELECT *
  FROM "record_historic_compute_invalidation"(
    $1::date, $2::date, $3::boolean, $4::boolean, $5::text,
    $6::bigint, $7::jsonb, $8::date, $9::date, $10::boolean,
    $11::boolean, $12::boolean, $13::boolean, $14::boolean
  )
`;

export async function recordHistoricComputeInvalidation(
  executor: HistoricInvalidationQueryExecutor,
  invalidation: HistoricComputeInvalidation,
): Promise<HistoricComputeInvalidationResult[]> {
  const rows = await executor.query(RECORD_HISTORIC_COMPUTE_INVALIDATION_SQL, [
    invalidation.affectedFrom,
    invalidation.affectedThrough ?? null,
    invalidation.invalidatesStatistics,
    invalidation.invalidatesMaps,
    invalidation.cause,
    invalidation.sourceRevision ?? null,
    JSON.stringify(invalidation.context ?? {}),
    invalidation.requestedMapDate ?? null,
    invalidation.requestedStatsDate ?? null,
    invalidation.forceCursor ?? false,
    invalidation.resetCursors ?? false,
    invalidation.bumpBackfillEpoch ?? false,
    invalidation.bumpHistoricEpoch ?? true,
    invalidation.onlyIfCursorRewinds ?? false,
  ]);
  return Array.isArray(rows)
    ? (rows as HistoricComputeInvalidationResult[])
    : [];
}

export async function invalidateHistoricComputationsFromWithManager(
  manager: EntityManager,
  dirtyFrom: string | null,
): Promise<void> {
  const normalizedDirtyFrom = dirtyFrom ? normalizeCivilDate(dirtyFrom) : null;
  const invalidatesPublishedHistory =
    normalizedDirtyFrom !== null &&
    normalizedDirtyFrom < getCurrentParisCivilDate();
  const updated = await recordHistoricComputeInvalidation(manager, {
    affectedFrom: normalizedDirtyFrom,
    invalidatesStatistics: invalidatesPublishedHistory,
    invalidatesMaps: invalidatesPublishedHistory,
    cause: 'published-source-mutation',
    requestedMapDate: normalizedDirtyFrom,
    requestedStatsDate: normalizedDirtyFrom,
    bumpHistoricEpoch: invalidatesPublishedHistory,
  });
  if (updated.length !== 1 || updated[0].changed !== true) {
    throw new Error('Unable to invalidate zone computations');
  }
}

export async function invalidateHistoricCalendarComputationsWithManager(
  manager: EntityManager,
  mapDirtyFrom: string | null,
  statisticRanges: readonly HistoricStatisticRange[],
  context: Record<string, unknown> = {},
): Promise<void> {
  const today = getCurrentParisCivilDate();
  const yesterday = shiftCivilDate(today, -1);
  const normalizedMapFrom =
    mapDirtyFrom === null ? null : normalizeCivilDate(mapDirtyFrom);
  const normalizedRanges = statisticRanges
    .map(({ from, through }) => {
      const normalizedFrom = normalizeCivilDate(from);
      const normalizedThrough =
        through === null ? null : normalizeCivilDate(through);
      if (normalizedThrough !== null && normalizedThrough < normalizedFrom) {
        throw new Error('Invalid historic statistic interval');
      }
      return { from: normalizedFrom, through: normalizedThrough };
    })
    .sort((left, right) => left.from.localeCompare(right.from));
  const mergedRanges: HistoricStatisticRange[] = [];
  for (const range of normalizedRanges) {
    const previous = mergedRanges[mergedRanges.length - 1];
    if (
      !previous ||
      (previous.through !== null &&
        range.from > shiftCivilDate(previous.through, 1))
    ) {
      mergedRanges.push(range);
    } else if (
      previous.through !== null &&
      (range.through === null || range.through > previous.through)
    ) {
      previous.through = range.through;
    }
  }
  const invalidatesHistoricMaps =
    normalizedMapFrom !== null && normalizedMapFrom < today;
  const invalidations: HistoricComputeInvalidation[] = [
    {
      affectedFrom: normalizedMapFrom,
      affectedThrough: invalidatesHistoricMaps ? yesterday : null,
      invalidatesStatistics: false,
      invalidatesMaps: invalidatesHistoricMaps,
      cause: 'published-calendar-mutation',
      context,
      requestedMapDate: normalizedMapFrom,
      bumpHistoricEpoch: invalidatesHistoricMaps,
    },
    ...mergedRanges.map(({ from, through }) => {
      const invalidatesPublishedHistory = from < today;
      return {
        affectedFrom: from,
        affectedThrough: invalidatesPublishedHistory
          ? through === null || through > yesterday
            ? yesterday
            : through
          : through,
        invalidatesStatistics: invalidatesPublishedHistory,
        invalidatesMaps: false,
        cause: 'published-calendar-mutation',
        context,
        requestedStatsDate: from,
        bumpHistoricEpoch: invalidatesPublishedHistory,
      };
    }),
  ];

  for (const invalidation of invalidations) {
    const updated = await recordHistoricComputeInvalidation(
      manager,
      invalidation,
    );
    if (updated.length !== 1 || updated[0].changed !== true) {
      throw new Error('Unable to invalidate zone computations');
    }
  }
}
