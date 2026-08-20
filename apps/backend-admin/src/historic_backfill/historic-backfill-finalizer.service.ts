import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { unwrapTypeOrmDmlReturningRows } from '../zone_publication/typeorm-query-result';
import { HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT } from './historic-backfill-queue.service';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERATION_PATTERN = /^\d+$/;
const STATISTIC_COMMUNE_LOCK = 'vigieau:statistic-commune:snapshot-computation';
export const HISTORIC_BACKFILL_SHADOW_CONCURRENCY_DEFAULT = 4;
export const HISTORIC_BACKFILL_SHADOW_CONCURRENCY_MAX = 8;

type SqlExecutor = Pick<DataSource, 'query'> | Pick<QueryRunner, 'query'>;

export interface HistoricDepartmentShadowIdentity {
  runId: string;
  departementId: number;
  departmentGeneration: string;
}

export interface HistoricDepartmentShadowResult extends HistoricDepartmentShadowIdentity {
  baseStatisticRevision: string;
  rebased: boolean;
  purgedShadowCount: number;
  communeCount: number;
  segmentCount: number;
  expandedPointCount: number;
  upsertedCount: number;
}

export interface HistoricBackfillShadowBuildResult {
  runId: string;
  departmentCount: number;
  skippedDepartmentCount: number;
  communeCount: number;
  segmentCount: number;
  expandedPointCount: number;
  upsertedCount: number;
  purgedShadowCount: number;
  rebased: boolean;
  baseStatisticRevision: string;
}

export interface HistoricBackfillFinalizationInspection {
  runId: string;
  runFound: boolean;
  runStatus: string | null;
  statisticDateFrom: string | null;
  dateThrough: string | null;
  sourceRevision: string | null;
  currentSourceRevision: string | null;
  historicComputeEpoch: string | null;
  currentHistoricComputeEpoch: string | null;
  historicBackfillGlobalEpoch: string | null;
  currentHistoricBackfillGlobalEpoch: string | null;
  baseStatisticRevision: string | null;
  currentStatisticRevision: string | null;
  statisticsPromotedAt: string | null;
  sourceRevisionMatches: boolean;
  historicComputeEpochMatches: boolean;
  historicBackfillGlobalEpochMatches: boolean;
  baseStatisticRevisionMatches: boolean;
  dirtyRangeCovers: boolean;
  currentPublishedAfterRange: boolean;
  statsCursor: string | null;
  departmentCount: number;
  taskCount: number;
  completedTaskCount: number;
  currentGenerationTaskCount: number;
  validTaskArtifactCount: number;
  expectedCommuneCount: number;
  validCommuneSegmentCoverageCount: number;
  shadowCommuneCount: number;
  validShadowCommuneCount: number;
  departmentSegmentCount: number;
  invalidDepartmentSegmentCount: number;
  expectedDepartmentPointCount: number;
  expandedDepartmentPointCount: number;
  distinctDepartmentPointCount: number;
  currentQueueCount: number;
  runningDailyPublicationCount: number;
  runningSnapshotCount: number;
  pendingMapPublicationCount: number;
  expectedDateCount: number;
  gates: string[];
  ready: boolean;
}

export interface HistoricBackfillStatisticFinalizationResult {
  runId: string;
  applied: boolean;
  alreadyApplied: boolean;
  communeCount: number;
  departmentCount: number;
  dateCount: number;
  siblingSnapshotCount: number;
  statsCursor: string | null;
  inspection: HistoricBackfillFinalizationInspection;
}

interface RebaseStateRow {
  runId: string;
  runStatus: string;
  mapDateFrom: string;
  statisticDateFrom: string;
  dateThrough: string;
  sourceRevision: string;
  currentSourceRevision: string;
  historicComputeEpoch: string;
  currentHistoricComputeEpoch: string;
  historicBackfillGlobalEpoch: string;
  currentHistoricBackfillGlobalEpoch: string;
  baseStatisticRevision: string;
  currentStatisticRevision: string;
  historicPublishedThrough: string | null;
  historicDirtyFrom: string | null;
  historicDirtyThrough: string | null;
  currentPublishedDate: string | null;
  computeStatsDate: string | null;
  departmentCount: number | string;
  taskCount: number | string;
  completedTaskCount: number | string;
  currentGenerationTaskCount: number | string;
  validTaskCount: number | string;
  currentQueueCount: number | string;
  runningDailyPublicationCount: number | string;
  runningSnapshotCount: number | string;
  pendingMapPublicationCount: number | string;
}

interface ShadowBuildRow {
  contextMatches: boolean | string;
  expectedCommuneCount: number | string;
  segmentCount: number | string;
  expectedPointCount: number | string;
  expandedPointCount: number | string;
  distinctPointCount: number | string;
  invalidSegmentCount: number | string;
  purgedShadowCount: number | string;
  upsertedCount: number | string;
}

interface ShadowBuildPlanRow extends HistoricDepartmentShadowIdentity {
  taskCommuneCount: number | string;
  segmentCount: number | string;
  expectedCommuneCount: number | string;
  expectedPointCount: number | string;
  shadowCommuneCount: number | string;
  validShadowCommuneCount: number | string;
}

interface InspectionRow {
  runFound: boolean | string;
  runStatus: string | null;
  statisticDateFrom: string | null;
  dateThrough: string | null;
  sourceRevision: string | null;
  currentSourceRevision: string | null;
  historicComputeEpoch: string | null;
  currentHistoricComputeEpoch: string | null;
  historicBackfillGlobalEpoch: string | null;
  currentHistoricBackfillGlobalEpoch: string | null;
  baseStatisticRevision: string | null;
  currentStatisticRevision: string | null;
  statisticsPromotedAt: Date | string | null;
  sourceRevisionMatches: boolean | string;
  historicComputeEpochMatches: boolean | string;
  historicBackfillGlobalEpochMatches: boolean | string;
  baseStatisticRevisionMatches: boolean | string;
  dirtyRangeCovers: boolean | string;
  currentPublishedAfterRange: boolean | string;
  statsCursor: string | null;
  departmentCount: number | string;
  taskCount: number | string;
  completedTaskCount: number | string;
  currentGenerationTaskCount: number | string;
  validTaskArtifactCount: number | string;
  expectedCommuneCount: number | string;
  validCommuneSegmentCoverageCount: number | string;
  shadowCommuneCount: number | string;
  validShadowCommuneCount: number | string;
  departmentSegmentCount: number | string;
  invalidDepartmentSegmentCount: number | string;
  expectedDepartmentPointCount: number | string;
  expandedDepartmentPointCount: number | string;
  distinctDepartmentPointCount: number | string;
  currentQueueCount: number | string;
  runningDailyPublicationCount: number | string;
  runningSnapshotCount: number | string;
  pendingMapPublicationCount: number | string;
  expectedDateCount: number | string;
}

interface StatisticWriteRow {
  expectedCommuneCount: number | string;
  upsertedCommuneCount: number | string;
}

interface DepartmentWriteRow {
  expectedDepartmentCount: number | string;
  upsertedDepartmentCount: number | string;
  expectedDateCount: number | string;
  upsertedDateCount: number | string;
}

interface SnapshotWriteRow {
  expectedDateCount: number | string;
  nationalSnapshotCount: number | string;
  siblingSnapshotCount: number | string;
  cursorUpdateCount: number | string;
  statsCursor: string | null;
}

export class HistoricBackfillFinalizerValidationError extends Error {}
export class HistoricBackfillFinalizerStateError extends Error {}

function databaseBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 't';
}

function databaseCount(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new HistoricBackfillFinalizerStateError(
      `Invalid ${name}: ${String(value)}`,
    );
  }
  return parsed;
}

function validateRunId(runId: string): void {
  if (!UUID_PATTERN.test(runId)) {
    throw new HistoricBackfillFinalizerValidationError('runId must be a UUID');
  }
}

function validateDepartmentIdentity(
  identity: HistoricDepartmentShadowIdentity,
): void {
  validateRunId(identity.runId);
  if (
    !Number.isSafeInteger(identity.departementId) ||
    identity.departementId <= 0
  ) {
    throw new HistoricBackfillFinalizerValidationError(
      'departementId must be a positive integer',
    );
  }
  if (!GENERATION_PATTERN.test(identity.departmentGeneration)) {
    throw new HistoricBackfillFinalizerValidationError(
      'departmentGeneration must be a non-negative integer',
    );
  }
}

function normalizeDate(value: string | null | undefined): string | null {
  return value ? String(value).slice(0, 10) : null;
}

function normalizeRevision(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function normalizeTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const timestamp = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(timestamp.getTime())) {
    throw new HistoricBackfillFinalizerStateError(
      `Invalid statistics promotion timestamp: ${String(value)}`,
    );
  }
  return timestamp.toISOString();
}

export function readHistoricBackfillShadowConcurrency(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const raw = environment.HISTORIC_BACKFILL_SHADOW_CONCURRENCY?.trim();
  const concurrency = raw
    ? Number(raw)
    : HISTORIC_BACKFILL_SHADOW_CONCURRENCY_DEFAULT;
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > HISTORIC_BACKFILL_SHADOW_CONCURRENCY_MAX
  ) {
    throw new Error(
      'HISTORIC_BACKFILL_SHADOW_CONCURRENCY must be between 1 and 8',
    );
  }
  return concurrency;
}

@Injectable()
export class HistoricBackfillFinalizerService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async buildDepartmentShadow(
    identity: HistoricDepartmentShadowIdentity,
  ): Promise<HistoricDepartmentShadowResult> {
    validateDepartmentIdentity(identity);

    const rebase = await this.rebaseStatisticRevision(identity.runId);
    return this.materializeDepartmentShadow(identity, rebase);
  }

  async buildShadow(runId: string): Promise<HistoricBackfillShadowBuildResult> {
    validateRunId(runId);
    const rebase = await this.rebaseStatisticRevision(runId);
    const plans = (await this.dataSource.query(
      `
        WITH expected_by_department AS MATERIALIZED (
          SELECT
            commune."departementId",
            COUNT(*)::integer AS "expectedCommuneCount"
          FROM "commune" commune
          GROUP BY commune."departementId"
        ), shadow_by_department AS MATERIALIZED (
          SELECT
            shadow."departementId",
            COUNT(*)::integer AS "shadowCommuneCount",
            COUNT(*) FILTER (
              WHERE shadow."sourceGeneration" = task."departmentGeneration"
                AND commune."departementId" = shadow."departementId"
            )::integer AS "validShadowCommuneCount"
          FROM "historic_backfill_commune_shadow" shadow
          JOIN "historic_backfill_task" task
            ON task."runId" = shadow."runId"
           AND task."departementId" = shadow."departementId"
          LEFT JOIN "commune" commune ON commune."id" = shadow."communeId"
          WHERE shadow."runId" = $1::uuid
          GROUP BY shadow."departementId"
        )
        SELECT
          task."runId", task."departementId",
          task."departmentGeneration"::text AS "departmentGeneration",
          task."communeCount" AS "taskCommuneCount",
          task."segmentCount",
          expected."expectedCommuneCount",
          (
            expected."expectedCommuneCount"::bigint *
            (run."dateThrough" - run."statisticDateFrom" + 1)::bigint
          )::bigint AS "expectedPointCount",
          COALESCE(shadow."shadowCommuneCount", 0)::integer
            AS "shadowCommuneCount",
          COALESCE(shadow."validShadowCommuneCount", 0)::integer
            AS "validShadowCommuneCount"
        FROM "historic_backfill_task" task
        JOIN "historic_backfill_department_revision" revision
          ON revision."departementId" = task."departementId"
        JOIN "historic_backfill_run" run ON run."id" = task."runId"
        JOIN expected_by_department expected
          ON expected."departementId" = task."departementId"
        LEFT JOIN shadow_by_department shadow
          ON shadow."departementId" = task."departementId"
        WHERE task."runId" = $1::uuid
          AND run."status" = 'running'
          AND NOT EXISTS (
            SELECT 1
            FROM "historic_backfill_map_manifest_outbox" outbox
            WHERE outbox."runId" = run."id"
              AND outbox."status" = 'pending'
          )
          AND task."status" = 'completed'
          AND task."departmentGeneration" = revision."generation"
        ORDER BY task."departementId"
      `,
      [runId],
    )) as ShadowBuildPlanRow[];
    if (plans.length !== HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT) {
      throw new HistoricBackfillFinalizerStateError(
        `Historic shadow requires ${HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT} current completed departments, got ${plans.length}`,
      );
    }

    const results: HistoricDepartmentShadowResult[] = [];
    const pending: HistoricDepartmentShadowIdentity[] = [];
    let skippedDepartmentCount = 0;
    for (const plan of plans) {
      const identity: HistoricDepartmentShadowIdentity = {
        runId: plan.runId,
        departementId: plan.departementId,
        departmentGeneration: plan.departmentGeneration,
      };
      const taskCommuneCount = databaseCount(
        plan.taskCommuneCount,
        'task shadow commune count',
      );
      const expectedCommuneCount = databaseCount(
        plan.expectedCommuneCount,
        'expected shadow commune count',
      );
      const shadowCommuneCount = databaseCount(
        plan.shadowCommuneCount,
        'existing shadow commune count',
      );
      const validShadowCommuneCount = databaseCount(
        plan.validShadowCommuneCount,
        'valid existing shadow commune count',
      );
      if (
        expectedCommuneCount > 0 &&
        taskCommuneCount === expectedCommuneCount &&
        shadowCommuneCount === expectedCommuneCount &&
        validShadowCommuneCount === expectedCommuneCount
      ) {
        skippedDepartmentCount += 1;
        results.push({
          ...identity,
          baseStatisticRevision: rebase.baseStatisticRevision,
          rebased: false,
          purgedShadowCount: 0,
          communeCount: expectedCommuneCount,
          segmentCount: databaseCount(
            plan.segmentCount,
            'task shadow segment count',
          ),
          expandedPointCount: databaseCount(
            plan.expectedPointCount,
            'expected shadow point count',
          ),
          upsertedCount: 0,
        });
      } else {
        pending.push(identity);
      }
    }

    const concurrency = readHistoricBackfillShadowConcurrency();
    for (let offset = 0; offset < pending.length; offset += concurrency) {
      results.push(
        ...(await Promise.all(
          pending.slice(offset, offset + concurrency).map((identity) =>
            this.materializeDepartmentShadow(identity, {
              ...rebase,
              rebased: false,
              purgedShadowCount: 0,
            }),
          ),
        )),
      );
    }

    return {
      runId,
      departmentCount: results.length,
      skippedDepartmentCount,
      communeCount: results.reduce(
        (total, result) => total + result.communeCount,
        0,
      ),
      segmentCount: results.reduce(
        (total, result) => total + result.segmentCount,
        0,
      ),
      expandedPointCount: results.reduce(
        (total, result) => total + result.expandedPointCount,
        0,
      ),
      upsertedCount: results.reduce(
        (total, result) => total + result.upsertedCount,
        0,
      ),
      purgedShadowCount: rebase.purgedShadowCount,
      rebased: rebase.rebased,
      baseStatisticRevision: rebase.baseStatisticRevision,
    };
  }

  dryRun(runId: string): Promise<HistoricBackfillStatisticFinalizationResult> {
    return this.finalizeStatistics(runId, false);
  }

  apply(runId: string): Promise<HistoricBackfillStatisticFinalizationResult> {
    return this.finalizeStatistics(runId, true);
  }

  private async materializeDepartmentShadow(
    identity: HistoricDepartmentShadowIdentity,
    rebase: {
      baseStatisticRevision: string;
      currentStatisticRevision: string;
      rebased: boolean;
      purgedShadowCount: number;
    },
  ): Promise<HistoricDepartmentShadowResult> {
    if (rebase.baseStatisticRevision !== rebase.currentStatisticRevision) {
      throw new HistoricBackfillFinalizerStateError(
        'Historic statistic revision rebase did not converge',
      );
    }

    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      const lockedRuns = (await manager.query(
        `
          SELECT run."id"
          FROM "historic_backfill_run" run
          WHERE run."id" = $1::uuid
          FOR SHARE OF run
        `,
        [identity.runId],
      )) as Array<{ id: string }>;
      if (lockedRuns.length !== 1) {
        throw new HistoricBackfillFinalizerStateError(
          'Historic backfill run context is incomplete',
        );
      }

      const [freeze] = (await manager.query(
        `
          SELECT COUNT(*)::integer AS "pendingMapPublicationCount"
          FROM "historic_backfill_map_manifest_outbox" outbox
          WHERE outbox."runId" = $1::uuid
            AND outbox."status" = 'pending'
        `,
        [identity.runId],
      )) as Array<{ pendingMapPublicationCount: number | string }>;
      if (
        databaseCount(
          freeze?.pendingMapPublicationCount,
          'pending map publication count',
        ) !== 0
      ) {
        throw new HistoricBackfillFinalizerStateError(
          'Historic run is frozen by a pending map publication',
        );
      }

      const [row] = (await manager.query(this.departmentShadowSql(), [
        identity.runId,
        identity.departementId,
        identity.departmentGeneration,
      ])) as ShadowBuildRow[];
      if (!row || !databaseBoolean(row.contextMatches)) {
        throw new HistoricBackfillFinalizerStateError(
          `Historic shadow context changed for department ${identity.departementId}`,
        );
      }

      const expectedCommuneCount = databaseCount(
        row.expectedCommuneCount,
        'expected shadow commune count',
      );
      const segmentCount = databaseCount(
        row.segmentCount,
        'shadow segment count',
      );
      const expectedPointCount = databaseCount(
        row.expectedPointCount,
        'expected shadow point count',
      );
      const expandedPointCount = databaseCount(
        row.expandedPointCount,
        'expanded shadow point count',
      );
      const distinctPointCount = databaseCount(
        row.distinctPointCount,
        'distinct shadow point count',
      );
      const invalidSegmentCount = databaseCount(
        row.invalidSegmentCount,
        'invalid shadow segment count',
      );
      const upsertedCount = databaseCount(
        row.upsertedCount,
        'upserted shadow count',
      );

      if (
        expectedCommuneCount === 0 ||
        invalidSegmentCount !== 0 ||
        expectedPointCount !== expandedPointCount ||
        expectedPointCount !== distinctPointCount ||
        upsertedCount !== expectedCommuneCount
      ) {
        throw new HistoricBackfillFinalizerStateError(
          `Incomplete historic shadow for department ${identity.departementId}: ` +
            `${upsertedCount}/${expectedCommuneCount} communes, ` +
            `${expandedPointCount}/${distinctPointCount}/${expectedPointCount} points, ` +
            `${invalidSegmentCount} invalid segments`,
        );
      }

      return {
        ...identity,
        baseStatisticRevision: rebase.baseStatisticRevision,
        rebased: rebase.rebased,
        purgedShadowCount:
          rebase.purgedShadowCount +
          databaseCount(
            row.purgedShadowCount,
            'purged department shadow count',
          ),
        communeCount: expectedCommuneCount,
        segmentCount,
        expandedPointCount,
        upsertedCount,
      };
    });
  }

  async inspect(
    runId: string,
  ): Promise<HistoricBackfillFinalizationInspection> {
    validateRunId(runId);
    return this.readInspection(this.dataSource, runId, false);
  }

  async finalizeStatistics(
    runId: string,
    apply: boolean,
  ): Promise<HistoricBackfillStatisticFinalizationResult> {
    validateRunId(runId);
    if (typeof apply !== 'boolean') {
      throw new HistoricBackfillFinalizerValidationError(
        'apply must be a boolean',
      );
    }

    const queryRunner = this.dataSource.createQueryRunner();
    let connected = false;
    let zoneLockAcquired = false;
    let statisticLockAcquired = false;
    let failure: unknown;
    let result: HistoricBackfillStatisticFinalizationResult | undefined;

    try {
      await queryRunner.connect();
      connected = true;

      const [zoneLock] = (await queryRunner.query(
        `SELECT pg_try_advisory_lock(
          hashtext('vigieau'), hashtext('zone-compute-global')
        ) AS locked`,
      )) as Array<{ locked: boolean | string }>;
      if (!databaseBoolean(zoneLock?.locked)) {
        throw new HistoricBackfillFinalizerStateError(
          'Current zone computation is running',
        );
      }
      zoneLockAcquired = true;

      const [statisticLock] = (await queryRunner.query(
        `SELECT pg_try_advisory_lock(
          hashtext('vigieau:statistic-commune:snapshot-computation')
        ) AS locked`,
      )) as Array<{ locked: boolean | string }>;
      if (!databaseBoolean(statisticLock?.locked)) {
        throw new HistoricBackfillFinalizerStateError(
          'Commune statistic computation is running',
        );
      }
      statisticLockAcquired = true;

      await queryRunner.startTransaction('SERIALIZABLE');
      await queryRunner.query(`SET LOCAL lock_timeout = '3s'`);
      await queryRunner.query(`SET LOCAL statement_timeout = '30min'`);

      const inspection = await this.readInspection(queryRunner, runId, true);
      this.assertReady(inspection);

      if (!apply) {
        await queryRunner.commitTransaction();
        result = {
          runId,
          applied: false,
          alreadyApplied: inspection.statisticsPromotedAt !== null,
          communeCount: inspection.expectedCommuneCount,
          departmentCount: inspection.departmentCount,
          dateCount: inspection.expectedDateCount,
          siblingSnapshotCount: 0,
          statsCursor: null,
          inspection,
        };
      } else if (inspection.statisticsPromotedAt !== null) {
        await queryRunner.commitTransaction();
        result = {
          runId,
          applied: true,
          alreadyApplied: true,
          communeCount: inspection.expectedCommuneCount,
          departmentCount: inspection.departmentCount,
          dateCount: inspection.expectedDateCount,
          siblingSnapshotCount: 0,
          statsCursor: inspection.statsCursor,
          inspection,
        };
      } else {
        const communeWrite = await this.writeCommuneStatistics(
          queryRunner,
          runId,
          inspection.expectedCommuneCount,
        );
        const departmentWrite = await this.writeDepartmentStatistics(
          queryRunner,
          runId,
          inspection.departmentCount,
          inspection.expectedDateCount,
        );
        const snapshotWrite = await this.writeSnapshotsAndStatsCursor(
          queryRunner,
          runId,
          inspection.expectedDateCount,
          inspection.dateThrough!,
        );
        const statisticsPromotedAt = await this.markStatisticsPromoted(
          queryRunner,
          runId,
        );
        const appliedInspection = {
          ...inspection,
          statisticsPromotedAt,
          statsCursor: snapshotWrite.statsCursor,
        };

        await queryRunner.commitTransaction();
        result = {
          runId,
          applied: true,
          alreadyApplied: false,
          communeCount: communeWrite,
          departmentCount: departmentWrite.departmentCount,
          dateCount: departmentWrite.dateCount,
          siblingSnapshotCount: snapshotWrite.siblingSnapshotCount,
          statsCursor: snapshotWrite.statsCursor,
          inspection: appliedInspection,
        };
      }
    } catch (error) {
      failure = error;
    } finally {
      if (queryRunner.isTransactionActive) {
        try {
          await queryRunner.rollbackTransaction();
        } catch (error) {
          failure ??= error;
        }
      }
      if (statisticLockAcquired) {
        try {
          const [unlock] = (await queryRunner.query(
            `SELECT pg_advisory_unlock(
              hashtext('vigieau:statistic-commune:snapshot-computation')
            ) AS unlocked`,
          )) as Array<{ unlocked: boolean | string }>;
          if (!databaseBoolean(unlock?.unlocked)) {
            throw new Error(`Failed to release ${STATISTIC_COMMUNE_LOCK}`);
          }
        } catch (error) {
          failure ??= error;
        }
      }
      if (zoneLockAcquired) {
        try {
          const [unlock] = (await queryRunner.query(
            `SELECT pg_advisory_unlock(
              hashtext('vigieau'), hashtext('zone-compute-global')
            ) AS unlocked`,
          )) as Array<{ unlocked: boolean | string }>;
          if (!databaseBoolean(unlock?.unlocked)) {
            throw new Error('Failed to release the global zone compute lock');
          }
        } catch (error) {
          failure ??= error;
        }
      }
      if (connected) {
        try {
          await queryRunner.release();
        } catch (error) {
          failure ??= error;
        }
      }
    }

    if (failure !== undefined) {
      throw failure;
    }
    if (!result) {
      throw new HistoricBackfillFinalizerStateError(
        'Historic statistic finalization produced no result',
      );
    }
    return result;
  }

  private async rebaseStatisticRevision(runId: string): Promise<{
    baseStatisticRevision: string;
    currentStatisticRevision: string;
    rebased: boolean;
    purgedShadowCount: number;
  }> {
    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const [row] = (await manager.query(
        `
          WITH run_context AS MATERIALIZED (
            SELECT
              run."id" AS "runId",
              run."status" AS "runStatus",
              run."mapDateFrom"::text AS "mapDateFrom",
              run."statisticDateFrom"::text AS "statisticDateFrom",
              run."dateThrough"::text AS "dateThrough",
              run."sourceRevision"::text AS "sourceRevision",
              source."publicRevision"::text AS "currentSourceRevision",
              run."historicComputeEpoch"::text AS "historicComputeEpoch",
              config."historicComputeEpoch"::text
                AS "currentHistoricComputeEpoch",
              run."historicBackfillGlobalEpoch"::text
                AS "historicBackfillGlobalEpoch",
              config."historicBackfillGlobalEpoch"::text
                AS "currentHistoricBackfillGlobalEpoch",
              run."baseStatisticRevision"::text
                AS "baseStatisticRevision",
              publication."revision"::text AS "currentStatisticRevision",
              publication."historicPublishedThrough"::text
                AS "historicPublishedThrough",
              publication."historicDirtyFrom"::text AS "historicDirtyFrom",
              publication."historicDirtyThrough"::text
                AS "historicDirtyThrough",
              publication."currentPublishedDate"::text
                AS "currentPublishedDate",
              config."computeStatsDate"::text AS "computeStatsDate"
            FROM "historic_backfill_run" run
            CROSS JOIN "zone_publication_source_state" source
            CROSS JOIN "config" config
            CROSS JOIN "statistic_publication_state" publication
            WHERE run."id" = $1::uuid
              AND source."id" = 1
              AND config."id" = 1
              AND publication."id" = 1
            FOR UPDATE OF run, source, config, publication
          ), locked_tasks AS MATERIALIZED (
            SELECT
              task."status", task."departmentGeneration",
              task."progressDate", task."outputSignature",
              task."artifactPrefix",
              revision."generation" AS "currentGeneration"
            FROM "historic_backfill_task" task
            JOIN "historic_backfill_department_revision" revision
              ON revision."departementId" = task."departementId"
            CROSS JOIN run_context
            WHERE task."runId" = run_context."runId"
            FOR UPDATE OF task, revision
          ), task_state AS MATERIALIZED (
            SELECT
              COUNT(*)::integer AS "taskCount",
              COUNT(*) FILTER (
                WHERE "status" = 'completed'
              )::integer AS "completedTaskCount",
              COUNT(*) FILTER (
                WHERE "departmentGeneration" = "currentGeneration"
              )::integer AS "currentGenerationTaskCount",
              COUNT(*) FILTER (
                WHERE "status" = 'completed'
                  AND "departmentGeneration" = "currentGeneration"
                  AND "progressDate" = (SELECT "dateThrough"::date FROM run_context)
                  AND "outputSignature" ~ '^[0-9a-f]{64}$'
                  AND length("artifactPrefix") > 0
              )::integer AS "validTaskCount"
            FROM locked_tasks
          )
          SELECT
            run_context.*,
            (SELECT COUNT(*)::integer FROM "departement")
              AS "departmentCount",
            task_state.*,
            (
              SELECT COUNT(*)::integer
              FROM "current_zone_recompute_request" request
              WHERE request."currentPending"
                OR EXISTS (
                  SELECT 1
                  FROM unnest(request."pendingScheduledDates")
                    AS pending_dates(pending_date)
                  WHERE pending_date <=
                    (now() AT TIME ZONE 'Europe/Paris')::date
                )
            ) AS "currentQueueCount",
            (
              SELECT COUNT(*)::integer
              FROM "external_publication_run" daily_run
              WHERE daily_run."jobKey" = 'compute:national-daily'
                AND daily_run."status" = 'running'
            ) AS "runningDailyPublicationCount",
            (
              SELECT COUNT(*)::integer
              FROM "statistic_commune_snapshot"
              WHERE "status" = 'running'
            ) AS "runningSnapshotCount",
            (
              SELECT COUNT(*)::integer
              FROM "historic_backfill_map_manifest_outbox" outbox
              WHERE outbox."runId" = run_context."runId"
                AND outbox."status" = 'pending'
            ) AS "pendingMapPublicationCount"
          FROM run_context
          CROSS JOIN task_state
        `,
        [runId],
      )) as RebaseStateRow[];
      this.assertRebaseState(row);

      const currentStatisticRevision = String(row.currentStatisticRevision);
      const previousStatisticRevision = String(row.baseStatisticRevision);
      if (currentStatisticRevision === previousStatisticRevision) {
        return {
          baseStatisticRevision: currentStatisticRevision,
          currentStatisticRevision,
          rebased: false,
          purgedShadowCount: 0,
        };
      }

      const [rebased] = (await manager.query(
        `
          WITH purged AS (
            DELETE FROM "historic_backfill_commune_shadow"
            WHERE "runId" = $1::uuid
            RETURNING 1
          ), updated AS (
            UPDATE "historic_backfill_run" run
            SET "baseStatisticRevision" = $3::bigint,
                "statisticsPromotedAt" = NULL,
                "updatedAt" = now()
            FROM (SELECT COUNT(*)::integer AS count FROM purged) purge
            WHERE run."id" = $1::uuid
              AND run."status" = 'running'
              AND run."baseStatisticRevision" = $2::bigint
            RETURNING 1
          )
          SELECT
            (SELECT COUNT(*)::integer FROM purged) AS "purgedShadowCount",
            (SELECT COUNT(*)::integer FROM updated) AS "updatedCount"
        `,
        [runId, previousStatisticRevision, currentStatisticRevision],
      )) as Array<{
        purgedShadowCount: number | string;
        updatedCount: number | string;
      }>;
      if (databaseCount(rebased?.updatedCount, 'rebased run count') !== 1) {
        throw new HistoricBackfillFinalizerStateError(
          'Historic statistic revision changed during rebase',
        );
      }
      return {
        baseStatisticRevision: currentStatisticRevision,
        currentStatisticRevision,
        rebased: true,
        purgedShadowCount: databaseCount(
          rebased.purgedShadowCount,
          'purged shadow count',
        ),
      };
    });
  }

  private assertRebaseState(row: RebaseStateRow | undefined): asserts row {
    if (!row) {
      throw new HistoricBackfillFinalizerStateError(
        'Historic backfill run context is incomplete',
      );
    }
    const failures: string[] = [];
    if (row.runStatus !== 'running') failures.push('run is not running');
    if (row.sourceRevision !== row.currentSourceRevision) {
      failures.push('source revision changed');
    }
    if (row.historicComputeEpoch !== row.currentHistoricComputeEpoch) {
      failures.push('historic compute epoch changed');
    }
    if (
      row.historicBackfillGlobalEpoch !== row.currentHistoricBackfillGlobalEpoch
    ) {
      failures.push('historic backfill global epoch changed');
    }
    if (
      !row.historicDirtyFrom ||
      !row.historicDirtyThrough ||
      row.mapDateFrom > row.historicDirtyFrom ||
      row.statisticDateFrom > row.historicDirtyFrom ||
      row.dateThrough < row.historicDirtyThrough ||
      (row.historicPublishedThrough !== null &&
        row.historicPublishedThrough > row.dateThrough)
    ) {
      failures.push('run does not cover the dirty range');
    }
    if (
      !row.currentPublishedDate ||
      row.currentPublishedDate <= row.dateThrough
    ) {
      failures.push('statistic range is not strictly historic');
    }
    const expected = HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT;
    if (databaseCount(row.departmentCount, 'department count') !== expected) {
      failures.push('department catalogue is incomplete');
    }
    if (databaseCount(row.taskCount, 'task count') !== expected) {
      failures.push('task set is incomplete');
    }
    if (
      databaseCount(row.completedTaskCount, 'completed task count') !== expected
    ) {
      failures.push('tasks are not all completed');
    }
    if (
      databaseCount(
        row.currentGenerationTaskCount,
        'current-generation task count',
      ) !== expected
    ) {
      failures.push('task generation changed');
    }
    if (databaseCount(row.validTaskCount, 'valid task count') !== expected) {
      failures.push('task output metadata is incomplete');
    }
    if (databaseCount(row.currentQueueCount, 'current queue count') !== 0) {
      failures.push('current recompute queue is not empty');
    }
    if (
      databaseCount(
        row.runningDailyPublicationCount,
        'running daily publication count',
      ) !== 0
    ) {
      failures.push('a current daily publication is running');
    }
    if (
      databaseCount(row.runningSnapshotCount, 'running snapshot count') !== 0
    ) {
      failures.push('a commune statistic snapshot is running');
    }
    if (
      databaseCount(
        row.pendingMapPublicationCount,
        'pending map publication count',
      ) !== 0
    ) {
      failures.push('a map publication is pending');
    }
    if (failures.length > 0) {
      throw new HistoricBackfillFinalizerStateError(
        `Historic shadow rebase refused: ${failures.join(', ')}`,
      );
    }
  }

  private async readInspection(
    executor: SqlExecutor,
    runId: string,
    lockRows: boolean,
  ): Promise<HistoricBackfillFinalizationInspection> {
    const [row] = (await executor.query(this.inspectionSql(lockRows), [
      runId,
    ])) as InspectionRow[];
    if (!row) {
      throw new HistoricBackfillFinalizerStateError(
        'Historic finalization inspection returned no row',
      );
    }

    const inspection: HistoricBackfillFinalizationInspection = {
      runId,
      runFound: databaseBoolean(row.runFound),
      runStatus: row.runStatus,
      statisticDateFrom: normalizeDate(row.statisticDateFrom),
      dateThrough: normalizeDate(row.dateThrough),
      sourceRevision: normalizeRevision(row.sourceRevision),
      currentSourceRevision: normalizeRevision(row.currentSourceRevision),
      historicComputeEpoch: normalizeRevision(row.historicComputeEpoch),
      currentHistoricComputeEpoch: normalizeRevision(
        row.currentHistoricComputeEpoch,
      ),
      historicBackfillGlobalEpoch: normalizeRevision(
        row.historicBackfillGlobalEpoch,
      ),
      currentHistoricBackfillGlobalEpoch: normalizeRevision(
        row.currentHistoricBackfillGlobalEpoch,
      ),
      baseStatisticRevision: normalizeRevision(row.baseStatisticRevision),
      currentStatisticRevision: normalizeRevision(row.currentStatisticRevision),
      statisticsPromotedAt: normalizeTimestamp(row.statisticsPromotedAt),
      sourceRevisionMatches: databaseBoolean(row.sourceRevisionMatches),
      historicComputeEpochMatches: databaseBoolean(
        row.historicComputeEpochMatches,
      ),
      historicBackfillGlobalEpochMatches: databaseBoolean(
        row.historicBackfillGlobalEpochMatches,
      ),
      baseStatisticRevisionMatches: databaseBoolean(
        row.baseStatisticRevisionMatches,
      ),
      dirtyRangeCovers: databaseBoolean(row.dirtyRangeCovers),
      currentPublishedAfterRange: databaseBoolean(
        row.currentPublishedAfterRange,
      ),
      statsCursor: normalizeDate(row.statsCursor),
      departmentCount: databaseCount(row.departmentCount, 'department count'),
      taskCount: databaseCount(row.taskCount, 'task count'),
      completedTaskCount: databaseCount(
        row.completedTaskCount,
        'completed task count',
      ),
      currentGenerationTaskCount: databaseCount(
        row.currentGenerationTaskCount,
        'current-generation task count',
      ),
      validTaskArtifactCount: databaseCount(
        row.validTaskArtifactCount,
        'valid task artifact count',
      ),
      expectedCommuneCount: databaseCount(
        row.expectedCommuneCount,
        'expected commune count',
      ),
      validCommuneSegmentCoverageCount: databaseCount(
        row.validCommuneSegmentCoverageCount,
        'valid commune segment coverage count',
      ),
      shadowCommuneCount: databaseCount(
        row.shadowCommuneCount,
        'shadow commune count',
      ),
      validShadowCommuneCount: databaseCount(
        row.validShadowCommuneCount,
        'valid shadow commune count',
      ),
      departmentSegmentCount: databaseCount(
        row.departmentSegmentCount,
        'department segment count',
      ),
      invalidDepartmentSegmentCount: databaseCount(
        row.invalidDepartmentSegmentCount,
        'invalid department segment count',
      ),
      expectedDepartmentPointCount: databaseCount(
        row.expectedDepartmentPointCount,
        'expected department point count',
      ),
      expandedDepartmentPointCount: databaseCount(
        row.expandedDepartmentPointCount,
        'expanded department point count',
      ),
      distinctDepartmentPointCount: databaseCount(
        row.distinctDepartmentPointCount,
        'distinct department point count',
      ),
      currentQueueCount: databaseCount(
        row.currentQueueCount,
        'current queue count',
      ),
      runningDailyPublicationCount: databaseCount(
        row.runningDailyPublicationCount,
        'running daily publication count',
      ),
      runningSnapshotCount: databaseCount(
        row.runningSnapshotCount,
        'running snapshot count',
      ),
      pendingMapPublicationCount: databaseCount(
        row.pendingMapPublicationCount,
        'pending map publication count',
      ),
      expectedDateCount: databaseCount(
        row.expectedDateCount,
        'expected date count',
      ),
      gates: [],
      ready: false,
    };
    inspection.gates = this.failedGates(inspection);
    inspection.ready = inspection.gates.length === 0;
    return inspection;
  }

  private failedGates(
    inspection: HistoricBackfillFinalizationInspection,
  ): string[] {
    const failures: string[] = [];
    const expectedDepartments = HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT;
    if (!inspection.runFound) failures.push('run-missing');
    if (inspection.runStatus !== 'running') failures.push('run-not-running');
    if (!inspection.sourceRevisionMatches) failures.push('source-revision');
    if (!inspection.historicComputeEpochMatches) {
      failures.push('historic-compute-epoch');
    }
    if (!inspection.historicBackfillGlobalEpochMatches) {
      failures.push('historic-backfill-global-epoch');
    }
    if (!inspection.baseStatisticRevisionMatches) {
      failures.push('base-statistic-revision');
    }
    if (!inspection.dirtyRangeCovers) failures.push('dirty-range');
    if (!inspection.currentPublishedAfterRange) {
      failures.push('current-published-date');
    }
    if (
      inspection.statisticsPromotedAt !== null &&
      (inspection.statsCursor === null ||
        inspection.dateThrough === null ||
        inspection.statsCursor < inspection.dateThrough)
    ) {
      failures.push('stats-cursor-behind-promotion');
    }
    if (inspection.departmentCount !== expectedDepartments) {
      failures.push('department-count');
    }
    if (inspection.taskCount !== expectedDepartments) {
      failures.push('task-count');
    }
    if (inspection.completedTaskCount !== expectedDepartments) {
      failures.push('task-status');
    }
    if (inspection.currentGenerationTaskCount !== expectedDepartments) {
      failures.push('task-generation');
    }
    if (inspection.validTaskArtifactCount !== expectedDepartments) {
      failures.push('task-artifacts');
    }
    if (inspection.expectedCommuneCount === 0) failures.push('commune-count');
    if (
      inspection.validCommuneSegmentCoverageCount !==
      inspection.expectedCommuneCount
    ) {
      failures.push('commune-segment-coverage');
    }
    if (inspection.shadowCommuneCount !== inspection.expectedCommuneCount) {
      failures.push('shadow-count');
    }
    if (
      inspection.validShadowCommuneCount !== inspection.expectedCommuneCount
    ) {
      failures.push('shadow-generation');
    }
    if (inspection.invalidDepartmentSegmentCount !== 0) {
      failures.push('department-segments-invalid');
    }
    if (
      inspection.expectedDepartmentPointCount === 0 ||
      inspection.expandedDepartmentPointCount !==
        inspection.expectedDepartmentPointCount ||
      inspection.distinctDepartmentPointCount !==
        inspection.expectedDepartmentPointCount
    ) {
      failures.push('department-segment-coverage');
    }
    if (inspection.currentQueueCount !== 0) failures.push('current-queue');
    if (inspection.runningDailyPublicationCount !== 0) {
      failures.push('running-daily-publication');
    }
    if (inspection.runningSnapshotCount !== 0) {
      failures.push('running-snapshot');
    }
    if (inspection.pendingMapPublicationCount !== 0) {
      failures.push('pending-map-publication');
    }
    if (inspection.expectedDateCount === 0) failures.push('date-range');
    return failures;
  }

  private assertReady(
    inspection: HistoricBackfillFinalizationInspection,
  ): void {
    if (!inspection.ready) {
      throw new HistoricBackfillFinalizerStateError(
        `Historic statistic finalization refused: ${inspection.gates.join(', ')}`,
      );
    }
  }

  private async writeCommuneStatistics(
    queryRunner: QueryRunner,
    runId: string,
    expectedCommuneCount: number,
  ): Promise<number> {
    const [row] = (await queryRunner.query(
      `
        WITH target AS MATERIALIZED (
          SELECT shadow."communeId", shadow."restrictions",
                 shadow."restrictionsByMonth"
          FROM "historic_backfill_commune_shadow" shadow
          WHERE shadow."runId" = $1::uuid
        ), upserted AS (
          INSERT INTO "statistic_commune" AS statistic (
            "communeId", "restrictions", "restrictionsByMonth"
          )
          SELECT "communeId", "restrictions", "restrictionsByMonth"
          FROM target
          ON CONFLICT ("communeId") DO UPDATE
          SET "restrictions" = EXCLUDED."restrictions",
              "restrictionsByMonth" = EXCLUDED."restrictionsByMonth"
          RETURNING 1
        )
        SELECT
          (SELECT COUNT(*)::integer FROM target) AS "expectedCommuneCount",
          (SELECT COUNT(*)::integer FROM upserted) AS "upsertedCommuneCount"
      `,
      [runId],
    )) as StatisticWriteRow[];
    const expected = databaseCount(
      row?.expectedCommuneCount,
      'commune write target count',
    );
    const upserted = databaseCount(
      row?.upsertedCommuneCount,
      'commune write count',
    );
    if (
      expected !== expectedCommuneCount ||
      upserted !== expectedCommuneCount
    ) {
      throw new HistoricBackfillFinalizerStateError(
        `Canonical commune statistic write is incomplete: ${upserted}/${expected}/${expectedCommuneCount}`,
      );
    }
    return upserted;
  }

  private async writeDepartmentStatistics(
    queryRunner: QueryRunner,
    runId: string,
    expectedDepartmentCount: number,
    expectedDateCount: number,
  ): Promise<{ departmentCount: number; dateCount: number }> {
    const [row] = (await queryRunner.query(
      `
        WITH run_context AS MATERIALIZED (
          SELECT "statisticDateFrom", "dateThrough"
          FROM "historic_backfill_run"
          WHERE "id" = $1::uuid
        ), expanded AS MATERIALIZED (
          SELECT
            segment."departementId",
            day.value::date AS date,
            (segment."restriction" - 'date') ||
              jsonb_build_object('date', day.value::date::text)
              AS restriction,
            segment."situation" AS situation
          FROM "historic_backfill_department_segment" segment
          CROSS JOIN run_context
          CROSS JOIN LATERAL generate_series(
            GREATEST(segment."validFrom", run_context."statisticDateFrom"),
            LEAST(segment."validThrough", run_context."dateThrough"),
            interval '1 day'
          ) AS day(value)
          WHERE segment."runId" = $1::uuid
            AND segment."validThrough" >= run_context."statisticDateFrom"
            AND segment."validFrom" <= run_context."dateThrough"
        ), department_entries AS MATERIALIZED (
          SELECT
            departement."id" AS "departementId",
            item.value AS restriction,
            item.value ->> 'date' AS "sortDate",
            item.ordinality AS ordinality
          FROM "departement" departement
          LEFT JOIN "statistic_departement" statistic
            ON statistic."departementId" = departement."id"
          CROSS JOIN run_context
          CROSS JOIN LATERAL jsonb_array_elements(
            COALESCE(statistic."restrictions", '[]'::jsonb)
          ) WITH ORDINALITY AS item(value, ordinality)
          WHERE item.value ->> 'date' < run_context."statisticDateFrom"::text
             OR item.value ->> 'date' > run_context."dateThrough"::text
             OR item.value ->> 'date' IS NULL
             OR item.value ->> 'date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          UNION ALL
          SELECT "departementId", restriction, date::text, 0
          FROM expanded
        ), department_payload AS MATERIALIZED (
          SELECT
            departement."id" AS "departementId",
            COALESCE(
              jsonb_agg(
                entries.restriction
                ORDER BY
                  CASE WHEN entries."sortDate" ~
                    '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN 0 ELSE 1 END,
                  CASE WHEN entries."sortDate" ~
                    '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                    THEN entries."sortDate" END,
                  entries.ordinality
              ) FILTER (WHERE entries.restriction IS NOT NULL),
              '[]'::jsonb
            ) AS restrictions
          FROM "departement" departement
          LEFT JOIN department_entries entries
            ON entries."departementId" = departement."id"
          GROUP BY departement."id"
        ), upserted_departments AS (
          INSERT INTO "statistic_departement" AS statistic (
            "departementId", "visits", "restrictions", "totalVisits",
            "weekVisits", "monthVisits", "yearVisits", "subscriptions"
          )
          SELECT "departementId", '[]'::jsonb, restrictions, 0, 0, 0, 0, 0
          FROM department_payload
          ON CONFLICT ("departementId") DO UPDATE
          SET "restrictions" = EXCLUDED."restrictions"
          RETURNING 1
        ), daily_payload AS MATERIALIZED (
          SELECT
            expanded.date,
            jsonb_object_agg(
              departement."code", expanded.situation
              ORDER BY departement."code"
            )::json AS "departementSituation"
          FROM expanded
          JOIN "departement" departement
            ON departement."id" = expanded."departementId"
          GROUP BY expanded.date
        ), upserted_dates AS (
          INSERT INTO "statistic" AS statistic (
            "date", "departementSituation"
          )
          SELECT date, "departementSituation"
          FROM daily_payload
          ON CONFLICT ("date") DO UPDATE
          SET "departementSituation" = EXCLUDED."departementSituation"
          RETURNING 1
        )
        SELECT
          (SELECT COUNT(*)::integer FROM department_payload)
            AS "expectedDepartmentCount",
          (SELECT COUNT(*)::integer FROM upserted_departments)
            AS "upsertedDepartmentCount",
          (SELECT COUNT(*)::integer FROM daily_payload)
            AS "expectedDateCount",
          (SELECT COUNT(*)::integer FROM upserted_dates)
            AS "upsertedDateCount"
      `,
      [runId],
    )) as DepartmentWriteRow[];
    const departmentTarget = databaseCount(
      row?.expectedDepartmentCount,
      'department write target count',
    );
    const departmentWrite = databaseCount(
      row?.upsertedDepartmentCount,
      'department write count',
    );
    const dateTarget = databaseCount(
      row?.expectedDateCount,
      'situation write target count',
    );
    const dateWrite = databaseCount(
      row?.upsertedDateCount,
      'situation write count',
    );
    if (
      departmentTarget !== expectedDepartmentCount ||
      departmentWrite !== expectedDepartmentCount ||
      dateTarget !== expectedDateCount ||
      dateWrite !== expectedDateCount
    ) {
      throw new HistoricBackfillFinalizerStateError(
        `Canonical department statistic write is incomplete: ` +
          `${departmentWrite}/${departmentTarget}/${expectedDepartmentCount} departments, ` +
          `${dateWrite}/${dateTarget}/${expectedDateCount} dates`,
      );
    }
    return { departmentCount: departmentWrite, dateCount: dateWrite };
  }

  private async writeSnapshotsAndStatsCursor(
    queryRunner: QueryRunner,
    runId: string,
    expectedDateCount: number,
    expectedStatsCursor: string,
  ): Promise<{ siblingSnapshotCount: number; statsCursor: string | null }> {
    const [row] = (await queryRunner.query(
      `
        WITH run_context AS MATERIALIZED (
          SELECT "statisticDateFrom", "dateThrough", "sourceRevision"
          FROM "historic_backfill_run"
          WHERE "id" = $1::uuid
        ), expected_communes AS MATERIALIZED (
          SELECT COUNT(*)::integer AS count FROM "commune"
        ), target_dates AS MATERIALIZED (
          SELECT day.value::date AS date
          FROM run_context
          CROSS JOIN LATERAL generate_series(
            run_context."statisticDateFrom",
            run_context."dateThrough",
            interval '1 day'
          ) AS day(value)
        ), national_snapshots AS (
          INSERT INTO "statistic_commune_snapshot" AS snapshot (
            "snapshotDate", "scope", "status", "expectedCommuneCount",
            "processedCommuneCount", "sourceRevision", "startedAt",
            "completedAt", "lastError", "createdAt", "updatedAt"
          )
          SELECT
            target_dates.date, 'national', 'completed',
            expected_communes.count, expected_communes.count,
            run_context."sourceRevision", now(), now(), NULL, now(), now()
          FROM target_dates
          CROSS JOIN expected_communes
          CROSS JOIN run_context
          ON CONFLICT ("snapshotDate", "scope") DO UPDATE
          SET "status" = 'completed',
              "expectedCommuneCount" = EXCLUDED."expectedCommuneCount",
              "processedCommuneCount" = EXCLUDED."processedCommuneCount",
              "sourceRevision" = EXCLUDED."sourceRevision",
              "completedAt" = now(),
              "lastError" = NULL,
              "updatedAt" = now()
          RETURNING 1
        ), sibling_snapshots AS (
          UPDATE "statistic_commune_snapshot" snapshot
          SET "status" = 'completed',
              "processedCommuneCount" = snapshot."expectedCommuneCount",
              "sourceRevision" = run_context."sourceRevision",
              "completedAt" = COALESCE(snapshot."completedAt", now()),
              "lastError" = NULL,
              "updatedAt" = now()
          FROM run_context
          WHERE snapshot."snapshotDate"
              BETWEEN run_context."statisticDateFrom"
                  AND run_context."dateThrough"
            AND snapshot."scope" NOT IN ('national', 'bootstrap')
          RETURNING 1
        ), cursor_update AS (
          UPDATE "config" config
          SET "computeStatsDate" = GREATEST(
                COALESCE(
                  config."computeStatsDate",
                  run_context."dateThrough"
                ),
                run_context."dateThrough"
              ),
              "computeStatsGeneration" =
                config."computeStatsGeneration" + 1,
              "computeStatsUpdatedAt" = now()
          FROM run_context
          WHERE config."id" = 1
            AND (
              config."computeStatsDate" IS NULL
              OR config."computeStatsDate" < run_context."dateThrough"
            )
          RETURNING config."computeStatsDate"
        )
        SELECT
          (SELECT COUNT(*)::integer FROM target_dates)
            AS "expectedDateCount",
          (SELECT COUNT(*)::integer FROM national_snapshots)
            AS "nationalSnapshotCount",
          (SELECT COUNT(*)::integer FROM sibling_snapshots)
            AS "siblingSnapshotCount",
          (SELECT COUNT(*)::integer FROM cursor_update)
            AS "cursorUpdateCount",
          COALESCE(
            (SELECT "computeStatsDate"::text FROM cursor_update),
            config."computeStatsDate"::text
          ) AS "statsCursor"
        FROM "config" config
        WHERE config."id" = 1
      `,
      [runId],
    )) as SnapshotWriteRow[];
    const dateTarget = databaseCount(
      row?.expectedDateCount,
      'snapshot target date count',
    );
    const nationalCount = databaseCount(
      row?.nationalSnapshotCount,
      'national snapshot count',
    );
    const siblingSnapshotCount = databaseCount(
      row?.siblingSnapshotCount,
      'sibling snapshot count',
    );
    const cursorUpdateCount = databaseCount(
      row?.cursorUpdateCount,
      'statistic cursor update count',
    );
    const statsCursor = normalizeDate(row.statsCursor);
    if (
      dateTarget !== expectedDateCount ||
      nationalCount !== expectedDateCount ||
      cursorUpdateCount > 1 ||
      statsCursor === null ||
      statsCursor < expectedStatsCursor
    ) {
      throw new HistoricBackfillFinalizerStateError(
        `Statistic snapshot write is incomplete: ${nationalCount}/${dateTarget}/${expectedDateCount}`,
      );
    }
    return {
      siblingSnapshotCount,
      statsCursor,
    };
  }

  private async markStatisticsPromoted(
    queryRunner: QueryRunner,
    runId: string,
  ): Promise<string> {
    const [row] = unwrapTypeOrmDmlReturningRows<{
      statisticsPromotedAt: Date | string;
    }>(
      await queryRunner.query(
        `
        UPDATE "historic_backfill_run" run
        SET "statisticsPromotedAt" = now(),
            "updatedAt" = now()
        WHERE run."id" = $1::uuid
          AND run."status" = 'running'
          AND run."statisticsPromotedAt" IS NULL
        RETURNING run."statisticsPromotedAt"
      `,
        [runId],
      ),
    );
    const promotedAt = normalizeTimestamp(row?.statisticsPromotedAt);
    if (promotedAt === null) {
      throw new HistoricBackfillFinalizerStateError(
        'Historic statistics promotion marker was not written',
      );
    }
    return promotedAt;
  }

  private departmentShadowSql(): string {
    return `
      WITH run_context AS MATERIALIZED (
        SELECT
          run."id" AS "runId", run."statisticDateFrom", run."dateThrough",
          run."sourceRevision", run."historicComputeEpoch",
          run."baseStatisticRevision",
          task."segmentCount" AS "taskSegmentCount",
          task."communeCount" AS "taskCommuneCount"
        FROM "historic_backfill_run" run
        JOIN "historic_backfill_task" task
          ON task."runId" = run."id"
         AND task."departementId" = $2::integer
        JOIN "historic_backfill_department_revision" revision
          ON revision."departementId" = task."departementId"
        WHERE run."id" = $1::uuid
          AND run."status" = 'running'
          AND task."status" = 'completed'
          AND task."departmentGeneration" = $3::bigint
          AND revision."generation" = $3::bigint
          AND task."progressDate" = run."dateThrough"
          AND task."outputSignature" ~ '^[0-9a-f]{64}$'
      ), expected_communes AS MATERIALIZED (
        SELECT commune."id" AS "communeId"
        FROM "commune" commune
        CROSS JOIN run_context
        WHERE commune."departementId" = $2::integer
      ), segments AS MATERIALIZED (
        SELECT segment.*
        FROM "historic_backfill_commune_segment" segment
        CROSS JOIN run_context
        WHERE segment."runId" = $1::uuid
          AND segment."departementId" = $2::integer
      ), ordered_segments AS MATERIALIZED (
        SELECT
          segment.*,
          lag(segment."validThrough") OVER (
            PARTITION BY segment."communeId" ORDER BY segment."validFrom"
          ) AS "previousValidThrough"
        FROM segments segment
      ), segment_coverage AS MATERIALIZED (
        SELECT
          segment."communeId",
          bool_and(
            segment."sourceGeneration" = $3::bigint
            AND segment."validFrom" >= run_context."statisticDateFrom"
            AND segment."validThrough" <= run_context."dateThrough"
          ) AS "contextValid",
          min(segment."validFrom") AS "firstDate",
          max(segment."validThrough") AS "lastDate",
          bool_and(
            segment."previousValidThrough" IS NULL
            OR segment."validFrom" = segment."previousValidThrough" + 1
          ) AS contiguous,
          SUM(segment."validThrough" - segment."validFrom" + 1)::bigint
            AS "coveredDayCount"
        FROM ordered_segments segment
        CROSS JOIN run_context
        GROUP BY segment."communeId"
      ), coverage AS MATERIALIZED (
        SELECT
          (SELECT COUNT(*)::integer FROM expected_communes)
            AS "expectedCommuneCount",
          (SELECT COUNT(*)::integer FROM segments) AS "segmentCount",
          (
            (SELECT COUNT(*) FROM expected_communes) *
            (
              SELECT ("dateThrough" - "statisticDateFrom" + 1)::bigint
              FROM run_context
            )
          )::bigint AS "expectedPointCount",
          COALESCE(
            (SELECT SUM("coveredDayCount") FROM segment_coverage), 0
          )::bigint AS "expandedPointCount",
          COALESCE(
            (
              SELECT SUM(segment_coverage."coveredDayCount")
              FROM segment_coverage
              JOIN expected_communes commune
                ON commune."communeId" = segment_coverage."communeId"
              CROSS JOIN run_context
              WHERE segment_coverage."contextValid"
                AND segment_coverage."firstDate" =
                    run_context."statisticDateFrom"
                AND segment_coverage."lastDate" = run_context."dateThrough"
                AND segment_coverage.contiguous
                AND segment_coverage."coveredDayCount" =
                    run_context."dateThrough" -
                    run_context."statisticDateFrom" + 1
            ),
            0
          )::bigint AS "distinctPointCount",
          (
            SELECT COUNT(*)::integer
            FROM segments segment
            CROSS JOIN run_context
            LEFT JOIN expected_communes commune
              ON commune."communeId" = segment."communeId"
            WHERE segment."sourceGeneration" <> $3::bigint
               OR segment."validFrom" < run_context."statisticDateFrom"
               OR segment."validThrough" > run_context."dateThrough"
               OR commune."communeId" IS NULL
          ) AS "invalidSegmentCount",
          (SELECT COUNT(*)::integer FROM segment_coverage)
            AS "actualCommuneCount",
          (
            SELECT COUNT(*)::integer
            FROM segment_coverage
            JOIN expected_communes commune
              ON commune."communeId" = segment_coverage."communeId"
            CROSS JOIN run_context
            WHERE segment_coverage."contextValid"
              AND segment_coverage."firstDate" =
                  run_context."statisticDateFrom"
              AND segment_coverage."lastDate" = run_context."dateThrough"
              AND segment_coverage.contiguous
              AND segment_coverage."coveredDayCount" =
                  run_context."dateThrough" -
                  run_context."statisticDateFrom" + 1
          ) AS "validCoveredCommuneCount"
      ), coverage_gate AS MATERIALIZED (
        SELECT coverage.*
        FROM coverage
        CROSS JOIN run_context
        WHERE coverage."expectedCommuneCount" > 0
          AND coverage."segmentCount" = run_context."taskSegmentCount"
          AND coverage."expectedCommuneCount" =
              run_context."taskCommuneCount"
          AND coverage."actualCommuneCount" = coverage."expectedCommuneCount"
          AND coverage."validCoveredCommuneCount" =
              coverage."expectedCommuneCount"
          AND coverage."invalidSegmentCount" = 0
          AND coverage."expandedPointCount" = coverage."expectedPointCount"
          AND coverage."distinctPointCount" = coverage."expectedPointCount"
      ), expanded AS MATERIALIZED (
        SELECT
          segment."communeId", day.value::date AS date,
          jsonb_build_object(
            'date', day.value::date::text,
            'SOU', segment."SOU",
            'SUP', segment."SUP",
            'AEP', segment."AEP"
          ) AS restriction
        FROM segments segment
        CROSS JOIN coverage_gate
        CROSS JOIN LATERAL generate_series(
          segment."validFrom", segment."validThrough", interval '1 day'
        ) AS day(value)
      ), daily_entries AS MATERIALIZED (
        SELECT
          commune."communeId", item.value AS restriction,
          item.value ->> 'date' AS "sortDate", item.ordinality
        FROM expected_communes commune
        CROSS JOIN coverage_gate
        LEFT JOIN "statistic_commune" statistic
          ON statistic."communeId" = commune."communeId"
        CROSS JOIN run_context
        CROSS JOIN LATERAL jsonb_array_elements(
          COALESCE(statistic."restrictions", '[]'::jsonb)
        ) WITH ORDINALITY AS item(value, ordinality)
        WHERE item.value ->> 'date' < run_context."statisticDateFrom"::text
           OR item.value ->> 'date' > run_context."dateThrough"::text
           OR item.value ->> 'date' IS NULL
           OR item.value ->> 'date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        UNION ALL
        SELECT "communeId", restriction, date::text, 0 FROM expanded
      ), merged_daily AS MATERIALIZED (
        SELECT
          commune."communeId",
          COALESCE(
            jsonb_agg(
              entries.restriction
              ORDER BY
                CASE WHEN entries."sortDate" ~
                  '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN 0 ELSE 1 END,
                CASE WHEN entries."sortDate" ~
                  '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                  THEN entries."sortDate" END,
                entries.ordinality
            ) FILTER (WHERE entries.restriction IS NOT NULL),
            '[]'::jsonb
          ) AS restrictions
        FROM expected_communes commune
        JOIN coverage_gate ON true
        LEFT JOIN daily_entries entries
          ON entries."communeId" = commune."communeId"
        GROUP BY commune."communeId"
      ), target_months AS MATERIALIZED (
        SELECT to_char(month.value, 'YYYY-MM') AS month
        FROM run_context
        CROSS JOIN LATERAL generate_series(
          date_trunc('month', run_context."statisticDateFrom"::timestamp),
          date_trunc('month', run_context."dateThrough"::timestamp),
          interval '1 month'
        ) AS month(value)
      ), monthly_weights AS MATERIALIZED (
        SELECT
          entries."communeId",
          substring(entries.restriction ->> 'date', 1, 7) AS month,
          SUM(
            CASE GREATEST(
              CASE entries.restriction ->> 'SOU'
                WHEN 'vigilance' THEN 1 WHEN 'alerte' THEN 2
                WHEN 'alerte_renforcee' THEN 3 WHEN 'crise' THEN 4 ELSE 0 END,
              CASE entries.restriction ->> 'SUP'
                WHEN 'vigilance' THEN 1 WHEN 'alerte' THEN 2
                WHEN 'alerte_renforcee' THEN 3 WHEN 'crise' THEN 4 ELSE 0 END,
              CASE entries.restriction ->> 'AEP'
                WHEN 'vigilance' THEN 1 WHEN 'alerte' THEN 2
                WHEN 'alerte_renforcee' THEN 3 WHEN 'crise' THEN 4 ELSE 0 END
            )
              WHEN 1 THEN 0.5 WHEN 2 THEN 2
              WHEN 3 THEN 3 WHEN 4 THEN 4 ELSE 0
            END
          ) AS weight
        FROM daily_entries entries
        WHERE substring(entries.restriction ->> 'date', 1, 7)
          IN (SELECT month FROM target_months)
        GROUP BY entries."communeId",
          substring(entries.restriction ->> 'date', 1, 7)
      ), monthly_entries AS MATERIALIZED (
        SELECT
          commune."communeId", item.value AS value,
          item.value ->> 'date' AS "sortMonth", item.ordinality
        FROM expected_communes commune
        LEFT JOIN "statistic_commune" statistic
          ON statistic."communeId" = commune."communeId"
        CROSS JOIN LATERAL jsonb_array_elements(
          COALESCE(statistic."restrictionsByMonth", '[]'::jsonb)
        ) WITH ORDINALITY AS item(value, ordinality)
        WHERE NOT EXISTS (
          SELECT 1 FROM target_months
          WHERE target_months.month = item.value ->> 'date'
        )
        UNION ALL
        SELECT
          commune."communeId",
          jsonb_build_object(
            'date', target_months.month,
            'ponderation', COALESCE(monthly_weights.weight, 0)
          ),
          target_months.month,
          0
        FROM expected_communes commune
        CROSS JOIN target_months
        LEFT JOIN monthly_weights
          ON monthly_weights."communeId" = commune."communeId"
         AND monthly_weights.month = target_months.month
      ), monthly_payload AS MATERIALIZED (
        SELECT
          commune."communeId",
          COALESCE(
            jsonb_agg(
              monthly.value
              ORDER BY
                CASE WHEN monthly."sortMonth" ~ '^[0-9]{4}-[0-9]{2}$'
                  THEN 0 ELSE 1 END,
                CASE WHEN monthly."sortMonth" ~ '^[0-9]{4}-[0-9]{2}$'
                  THEN monthly."sortMonth" END,
                monthly.ordinality
            ) FILTER (WHERE monthly.value IS NOT NULL),
            '[]'::jsonb
          ) AS "restrictionsByMonth"
        FROM expected_communes commune
        LEFT JOIN monthly_entries monthly
          ON monthly."communeId" = commune."communeId"
        GROUP BY commune."communeId"
      ), payload AS MATERIALIZED (
        SELECT
          daily."communeId", daily.restrictions,
          monthly."restrictionsByMonth"
        FROM merged_daily daily
        JOIN monthly_payload monthly
          ON monthly."communeId" = daily."communeId"
      ), payload_barrier AS MATERIALIZED (
        SELECT COUNT(*)::integer AS count,
               COALESCE(SUM(pg_column_size(restrictions)), 0)::bigint AS bytes
        FROM payload
      ), commit_context AS MATERIALIZED (
        SELECT run."id"
        FROM "historic_backfill_run" run
        CROSS JOIN "zone_publication_source_state" source
        CROSS JOIN "config" config
        CROSS JOIN "statistic_publication_state" publication
        CROSS JOIN payload_barrier
        WHERE run."id" = $1::uuid
          AND run."status" = 'running'
          AND source."id" = 1
          AND source."publicRevision" = run."sourceRevision"
          AND config."id" = 1
          AND config."historicComputeEpoch" = run."historicComputeEpoch"
          AND run."historicBackfillGlobalEpoch" =
            config."historicBackfillGlobalEpoch"
          AND publication."id" = 1
          AND publication."revision" = run."baseStatisticRevision"
          AND run."mapDateFrom" <= publication."historicDirtyFrom"
          AND run."statisticDateFrom" <= publication."historicDirtyFrom"
          AND run."dateThrough" >= publication."historicDirtyThrough"
          AND (
            publication."historicPublishedThrough" IS NULL
            OR publication."historicPublishedThrough" <= run."dateThrough"
          )
          AND publication."currentPublishedDate" > run."dateThrough"
          AND payload_barrier.count =
              (SELECT "expectedCommuneCount" FROM coverage_gate)
          AND NOT EXISTS (
            SELECT 1
            FROM "current_zone_recompute_request" request
            WHERE request."currentPending"
              OR EXISTS (
                SELECT 1
                FROM unnest(request."pendingScheduledDates")
                  AS pending_dates(pending_date)
                WHERE pending_date <=
                  (now() AT TIME ZONE 'Europe/Paris')::date
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM "external_publication_run" daily_run
            WHERE daily_run."jobKey" = 'compute:national-daily'
              AND daily_run."status" = 'running'
          )
          AND NOT EXISTS (
            SELECT 1 FROM "statistic_commune_snapshot"
            WHERE "status" = 'running'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM "historic_backfill_map_manifest_outbox" outbox
            WHERE outbox."runId" = run."id"
              AND outbox."status" = 'pending'
          )
        FOR SHARE OF run, source, config, publication
      ), commit_tasks AS MATERIALIZED (
        SELECT task."departementId", task."status",
               task."departmentGeneration", revision."generation"
        FROM "historic_backfill_task" task
        JOIN "historic_backfill_department_revision" revision
          ON revision."departementId" = task."departementId"
        CROSS JOIN payload_barrier
        WHERE task."runId" = $1::uuid
        FOR SHARE OF task, revision
      ), commit_task_gate AS MATERIALIZED (
        SELECT 1
        FROM commit_tasks
        HAVING COUNT(*) = ${HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT}
          AND COUNT(*) FILTER (
            WHERE status = 'completed'
              AND "departmentGeneration" = generation
          ) = ${HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT}
          AND COUNT(*) FILTER (
            WHERE "departementId" = $2::integer
              AND "departmentGeneration" = $3::bigint
          ) = 1
      ), commit_guard AS MATERIALIZED (
        SELECT 1
        FROM commit_context
        CROSS JOIN commit_task_gate
      ), purged AS (
        DELETE FROM "historic_backfill_commune_shadow" shadow
        USING commit_guard
        WHERE shadow."runId" = $1::uuid
          AND shadow."departementId" = $2::integer
          AND (
            shadow."sourceGeneration" <> $3::bigint
            OR NOT EXISTS (
              SELECT 1 FROM expected_communes commune
              WHERE commune."communeId" = shadow."communeId"
            )
          )
        RETURNING 1
      ), upserted AS (
        INSERT INTO "historic_backfill_commune_shadow" AS shadow (
          "runId", "communeId", "departementId", "sourceGeneration",
          "restrictions", "restrictionsByMonth", "createdAt", "updatedAt"
        )
        SELECT
          $1::uuid, payload."communeId", $2::integer, $3::bigint,
          payload.restrictions, payload."restrictionsByMonth", now(), now()
        FROM payload
        CROSS JOIN commit_guard
        CROSS JOIN (SELECT COUNT(*) FROM purged) purge_barrier
        ON CONFLICT ("runId", "communeId") DO UPDATE
        SET "departementId" = EXCLUDED."departementId",
            "sourceGeneration" = EXCLUDED."sourceGeneration",
            "restrictions" = EXCLUDED."restrictions",
            "restrictionsByMonth" = EXCLUDED."restrictionsByMonth",
            "updatedAt" = now()
        RETURNING 1
      )
      SELECT
        EXISTS (SELECT 1 FROM commit_guard) AS "contextMatches",
        coverage."expectedCommuneCount", coverage."segmentCount",
        coverage."expectedPointCount", coverage."expandedPointCount",
        coverage."distinctPointCount", coverage."invalidSegmentCount",
        (SELECT COUNT(*)::integer FROM purged) AS "purgedShadowCount",
        (SELECT COUNT(*)::integer FROM upserted) AS "upsertedCount"
      FROM coverage
    `;
  }

  private inspectionSql(lockRows: boolean): string {
    const contextLock = lockRows
      ? 'FOR UPDATE OF run, source, config, publication'
      : '';
    const taskLock = lockRows ? 'FOR UPDATE OF task, revision' : '';
    const segmentLock = lockRows ? 'FOR SHARE OF segment' : '';
    const shadowLock = lockRows ? 'FOR SHARE OF shadow' : '';
    const snapshotLock = lockRows ? 'FOR SHARE OF snapshot' : '';

    return `
      WITH request AS MATERIALIZED (SELECT $1::uuid AS "runId"),
      run_context AS MATERIALIZED (
        SELECT
          run."id" AS "runId", run."status" AS "runStatus",
          run."mapDateFrom", run."statisticDateFrom", run."dateThrough",
          run."sourceRevision"::text AS "sourceRevision",
          source."publicRevision"::text AS "currentSourceRevision",
          run."historicComputeEpoch"::text AS "historicComputeEpoch",
          config."historicComputeEpoch"::text AS "currentHistoricComputeEpoch",
          run."historicBackfillGlobalEpoch"::text
            AS "historicBackfillGlobalEpoch",
          config."historicBackfillGlobalEpoch"::text
            AS "currentHistoricBackfillGlobalEpoch",
          run."baseStatisticRevision"::text AS "baseStatisticRevision",
          run."statisticsPromotedAt",
          publication."revision"::text AS "currentStatisticRevision",
          publication."historicPublishedThrough",
          publication."historicDirtyFrom", publication."historicDirtyThrough",
          publication."currentPublishedDate", config."computeStatsDate"
        FROM "historic_backfill_run" run
        CROSS JOIN "zone_publication_source_state" source
        CROSS JOIN "config" config
        CROSS JOIN "statistic_publication_state" publication
        WHERE run."id" = $1::uuid
          AND source."id" = 1 AND config."id" = 1 AND publication."id" = 1
        ${contextLock}
      ), task_rows AS MATERIALIZED (
        SELECT
          task.*, revision."generation" AS "currentGeneration"
        FROM "historic_backfill_task" task
        JOIN "historic_backfill_department_revision" revision
          ON revision."departementId" = task."departementId"
        WHERE task."runId" = $1::uuid
        ${taskLock}
      ), commune_segment_rows AS MATERIALIZED (
        SELECT
          segment."departementId", segment."communeId", segment."validFrom",
          segment."validThrough", segment."sourceGeneration",
          commune."departementId" AS "communeDepartementId",
          task."departmentGeneration"
        FROM "historic_backfill_commune_segment" segment
        LEFT JOIN "commune" commune ON commune."id" = segment."communeId"
        LEFT JOIN task_rows task
          ON task."departementId" = segment."departementId"
        WHERE segment."runId" = $1::uuid
        ${segmentLock}
      ), ordered_commune_segments AS MATERIALIZED (
        SELECT segment.*,
          lag(segment."validThrough") OVER (
            PARTITION BY segment."communeId" ORDER BY segment."validFrom"
          ) AS "previousValidThrough"
        FROM commune_segment_rows segment
      ), commune_coverage AS MATERIALIZED (
        SELECT
          segment."communeId", segment."departementId",
          COUNT(*)::integer AS "segmentCount",
          bool_and(
            segment."communeDepartementId" = segment."departementId"
            AND segment."sourceGeneration" = segment."departmentGeneration"
          ) AS "contextValid",
          min(segment."validFrom") AS "firstDate",
          max(segment."validThrough") AS "lastDate",
          bool_and(
            segment."previousValidThrough" IS NULL
            OR segment."validFrom" = segment."previousValidThrough" + 1
          ) AS contiguous,
          SUM(segment."validThrough" - segment."validFrom" + 1)::bigint
            AS "coveredDayCount"
        FROM ordered_commune_segments segment
        GROUP BY segment."communeId", segment."departementId"
      ), commune_coverage_by_department AS MATERIALIZED (
        SELECT
          task."departementId",
          COUNT(coverage."communeId")::integer AS "coveredCommuneCount",
          COUNT(*) FILTER (
            WHERE coverage."contextValid"
              AND coverage."firstDate" = run_context."statisticDateFrom"
              AND coverage."lastDate" = run_context."dateThrough"
              AND coverage.contiguous
              AND coverage."coveredDayCount" =
                  run_context."dateThrough" -
                  run_context."statisticDateFrom" + 1
          )::integer AS "validCoveredCommuneCount"
        FROM task_rows task
        CROSS JOIN run_context
        LEFT JOIN commune_coverage coverage
          ON coverage."departementId" = task."departementId"
        GROUP BY task."departementId"
      ), actual_by_department AS MATERIALIZED (
        SELECT
          segment."departementId",
          COUNT(*)::integer AS count,
          COUNT(DISTINCT segment."communeId")::integer
            AS "distinctCommuneCount"
        FROM commune_segment_rows segment
        GROUP BY segment."departementId"
      ), task_details AS MATERIALIZED (
        SELECT
          task.*,
          expected.count AS "expectedCommuneCount",
          COALESCE(actual.count, 0) AS "actualSegmentCount",
          COALESCE(actual."distinctCommuneCount", 0)
            AS "actualCommuneCount",
          COALESCE(coverage."validCoveredCommuneCount", 0)
            AS "validCoveredCommuneCount"
        FROM task_rows task
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::integer AS count
          FROM "commune" commune
          WHERE commune."departementId" = task."departementId"
        ) expected ON true
        LEFT JOIN actual_by_department actual
          ON actual."departementId" = task."departementId"
        LEFT JOIN commune_coverage_by_department coverage
          ON coverage."departementId" = task."departementId"
      ), task_state AS MATERIALIZED (
        SELECT
          COUNT(*)::integer AS "taskCount",
          COUNT(*) FILTER (WHERE "status" = 'completed')::integer
            AS "completedTaskCount",
          COUNT(*) FILTER (
            WHERE "departmentGeneration" = "currentGeneration"
          )::integer AS "currentGenerationTaskCount",
          COUNT(*) FILTER (
            WHERE "status" = 'completed'
              AND "departmentGeneration" = "currentGeneration"
              AND "progressDate" = (SELECT "dateThrough" FROM run_context)
              AND "outputSignature" ~ '^[0-9a-f]{64}$'
              AND length("artifactPrefix") > 0
              AND "segmentCount" = "actualSegmentCount"
              AND "communeCount" = "expectedCommuneCount"
              AND "actualCommuneCount" = "expectedCommuneCount"
              AND "validCoveredCommuneCount" = "expectedCommuneCount"
          )::integer AS "validTaskArtifactCount",
          COALESCE(SUM("expectedCommuneCount"), 0)::integer
            AS "expectedCommuneCount",
          COALESCE(SUM("validCoveredCommuneCount"), 0)::integer
            AS "validCommuneSegmentCoverageCount"
        FROM task_details
      ), shadow_rows AS MATERIALIZED (
        SELECT shadow.*, commune."departementId" AS "communeDepartementId",
               task."departmentGeneration", task."currentGeneration"
        FROM "historic_backfill_commune_shadow" shadow
        LEFT JOIN "commune" commune ON commune."id" = shadow."communeId"
        LEFT JOIN task_rows task
          ON task."departementId" = shadow."departementId"
        WHERE shadow."runId" = $1::uuid
        ${shadowLock}
      ), shadow_state AS MATERIALIZED (
        SELECT
          COUNT(*)::integer AS "shadowCommuneCount",
          COUNT(*) FILTER (
            WHERE "communeDepartementId" = "departementId"
              AND "sourceGeneration" = "departmentGeneration"
              AND "sourceGeneration" = "currentGeneration"
              AND jsonb_typeof("restrictions") = 'array'
              AND jsonb_typeof("restrictionsByMonth") = 'array'
          )::integer AS "validShadowCommuneCount"
        FROM shadow_rows
      ), department_segment_rows AS MATERIALIZED (
        SELECT segment.*, task."departmentGeneration",
               task."currentGeneration"
        FROM "historic_backfill_department_segment" segment
        LEFT JOIN task_rows task
          ON task."departementId" = segment."departementId"
        WHERE segment."runId" = $1::uuid
        ${segmentLock}
      ), expanded_department AS MATERIALIZED (
        SELECT segment."departementId", day.value::date AS date
        FROM department_segment_rows segment
        CROSS JOIN run_context
        CROSS JOIN LATERAL generate_series(
          GREATEST(segment."validFrom", run_context."statisticDateFrom"),
          LEAST(segment."validThrough", run_context."dateThrough"),
          interval '1 day'
        ) AS day(value)
        WHERE segment."validThrough" >= run_context."statisticDateFrom"
          AND segment."validFrom" <= run_context."dateThrough"
      ), department_segment_state AS MATERIALIZED (
        SELECT
          (SELECT COUNT(*)::integer FROM department_segment_rows)
            AS "departmentSegmentCount",
          (
            SELECT COUNT(*)::integer
            FROM department_segment_rows segment
            CROSS JOIN run_context
            WHERE segment."departmentGeneration" IS NULL
               OR segment."sourceGeneration" <> segment."departmentGeneration"
               OR segment."sourceGeneration" <> segment."currentGeneration"
               OR segment."validFrom" < run_context."mapDateFrom"
               OR segment."validThrough" > run_context."dateThrough"
          ) AS "invalidDepartmentSegmentCount",
          (
            (SELECT COUNT(*) FROM "departement") *
            (
              SELECT ("dateThrough" - "statisticDateFrom" + 1)::bigint
              FROM run_context
            )
          )::bigint AS "expectedDepartmentPointCount",
          (SELECT COUNT(*)::bigint FROM expanded_department)
            AS "expandedDepartmentPointCount",
          (
            SELECT COUNT(DISTINCT ("departementId", date))::bigint
            FROM expanded_department
          ) AS "distinctDepartmentPointCount"
      ), running_snapshots AS MATERIALIZED (
        SELECT snapshot."snapshotDate", snapshot."scope"
        FROM "statistic_commune_snapshot" snapshot
        WHERE snapshot."status" = 'running'
        ${snapshotLock}
      )
      SELECT
        (run_context."runId" IS NOT NULL) AS "runFound",
        run_context."runStatus", run_context."statisticDateFrom"::text,
        run_context."dateThrough"::text, run_context."sourceRevision",
        run_context."currentSourceRevision",
        run_context."historicComputeEpoch",
        run_context."currentHistoricComputeEpoch",
        run_context."historicBackfillGlobalEpoch",
        run_context."currentHistoricBackfillGlobalEpoch",
        run_context."baseStatisticRevision",
        run_context."currentStatisticRevision",
        run_context."statisticsPromotedAt",
        run_context."computeStatsDate"::text AS "statsCursor",
        COALESCE(
          run_context."sourceRevision" = run_context."currentSourceRevision",
          false
        ) AS "sourceRevisionMatches",
        COALESCE(
          run_context."historicComputeEpoch" =
            run_context."currentHistoricComputeEpoch",
          false
        ) AS "historicComputeEpochMatches",
        COALESCE(
          run_context."historicBackfillGlobalEpoch" =
            run_context."currentHistoricBackfillGlobalEpoch",
          false
        ) AS "historicBackfillGlobalEpochMatches",
        COALESCE(
          run_context."baseStatisticRevision" =
            run_context."currentStatisticRevision",
          false
        ) AS "baseStatisticRevisionMatches",
        COALESCE(
          run_context."mapDateFrom" <= run_context."historicDirtyFrom"
          AND run_context."statisticDateFrom" <=
              run_context."historicDirtyFrom"
          AND run_context."dateThrough" >=
              run_context."historicDirtyThrough"
          AND (
            run_context."historicPublishedThrough" IS NULL
            OR run_context."historicPublishedThrough" <=
                run_context."dateThrough"
          ),
          false
        ) AS "dirtyRangeCovers",
        COALESCE(
          run_context."currentPublishedDate" > run_context."dateThrough",
          false
        ) AS "currentPublishedAfterRange",
        (SELECT COUNT(*)::integer FROM "departement") AS "departmentCount",
        COALESCE(task_state."taskCount", 0) AS "taskCount",
        COALESCE(task_state."completedTaskCount", 0) AS "completedTaskCount",
        COALESCE(task_state."currentGenerationTaskCount", 0)
          AS "currentGenerationTaskCount",
        COALESCE(task_state."validTaskArtifactCount", 0)
          AS "validTaskArtifactCount",
        COALESCE(task_state."expectedCommuneCount", 0)
          AS "expectedCommuneCount",
        COALESCE(task_state."validCommuneSegmentCoverageCount", 0)
          AS "validCommuneSegmentCoverageCount",
        COALESCE(shadow_state."shadowCommuneCount", 0)
          AS "shadowCommuneCount",
        COALESCE(shadow_state."validShadowCommuneCount", 0)
          AS "validShadowCommuneCount",
        COALESCE(department_segment_state."departmentSegmentCount", 0)
          AS "departmentSegmentCount",
        COALESCE(department_segment_state."invalidDepartmentSegmentCount", 0)
          AS "invalidDepartmentSegmentCount",
        COALESCE(department_segment_state."expectedDepartmentPointCount", 0)
          AS "expectedDepartmentPointCount",
        COALESCE(department_segment_state."expandedDepartmentPointCount", 0)
          AS "expandedDepartmentPointCount",
        COALESCE(department_segment_state."distinctDepartmentPointCount", 0)
          AS "distinctDepartmentPointCount",
        (
          SELECT COUNT(*)::integer
          FROM "current_zone_recompute_request" request
          WHERE request."currentPending"
            OR EXISTS (
              SELECT 1
              FROM unnest(request."pendingScheduledDates")
                AS pending_dates(pending_date)
              WHERE pending_date <=
                (now() AT TIME ZONE 'Europe/Paris')::date
            )
        )
          AS "currentQueueCount",
        (
          SELECT COUNT(*)::integer
          FROM "external_publication_run" daily_run
          WHERE daily_run."jobKey" = 'compute:national-daily'
            AND daily_run."status" = 'running'
        ) AS "runningDailyPublicationCount",
        (SELECT COUNT(*)::integer FROM running_snapshots)
          AS "runningSnapshotCount",
        (
          SELECT COUNT(*)::integer
          FROM "historic_backfill_map_manifest_outbox" outbox
          WHERE outbox."runId" = $1::uuid
            AND outbox."status" = 'pending'
        ) AS "pendingMapPublicationCount",
        COALESCE(
          run_context."dateThrough" - run_context."statisticDateFrom" + 1,
          0
        )::integer AS "expectedDateCount"
      FROM request
      LEFT JOIN run_context ON run_context."runId" = request."runId"
      LEFT JOIN task_state ON true
      LEFT JOIN shadow_state ON true
      LEFT JOIN department_segment_state ON true
    `;
  }
}
