import type { EntityManager } from 'typeorm';
import {
  getCurrentParisCivilDate,
  normalizeCivilDate,
} from '../shared/arrete-date-continuity';
import { unwrapTypeOrmDmlReturningRows } from '../zone_publication/typeorm-query-result';

export async function invalidateHistoricComputationsFromWithManager(
  manager: EntityManager,
  dirtyFrom: string | null,
): Promise<void> {
  const normalizedDirtyFrom = dirtyFrom ? normalizeCivilDate(dirtyFrom) : null;
  const invalidatesPublishedHistory =
    normalizedDirtyFrom !== null &&
    normalizedDirtyFrom < getCurrentParisCivilDate();
  const [historicEpochColumn] = invalidatesPublishedHistory
    ? await manager.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'config' AND column_name = 'historicComputeEpoch'`,
      )
    : [];
  const updated = unwrapTypeOrmDmlReturningRows<{ id: number }>(
    await manager.query(
      `
      UPDATE "config"
      SET
        "computeMapDate" = CASE
          WHEN $1::date IS NULL THEN "computeMapDate"
          ELSE LEAST(COALESCE("computeMapDate", $1::date), $1::date)
        END,
        "computeMapGeneration" = "computeMapGeneration" + 1,
        "computeStatsDate" = CASE
          WHEN $1::date IS NULL THEN "computeStatsDate"
          ELSE LEAST(COALESCE("computeStatsDate", $1::date), $1::date)
        END,
        "computeStatsGeneration" = "computeStatsGeneration" + 1
        ${historicEpochColumn ? ', "historicComputeEpoch" = "historicComputeEpoch" + 1' : ''}
      WHERE "id" = 1
      RETURNING "id"
      `,
      [normalizedDirtyFrom],
    ),
  );
  if (updated.length !== 1) {
    throw new Error('Unable to invalidate zone computations');
  }
}
