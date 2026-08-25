import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { shiftCivilDate } from '../core/scheduling/daily-job-schedule';
import { getCurrentParisCivilDate } from '../shared/arrete-date-continuity';
import { unwrapTypeOrmDmlReturningRows } from '../zone_publication/typeorm-query-result';
import {
  HistoricBackfillFailureDisposition,
  HistoricBackfillLeaseIdentity,
  HistoricBackfillRun,
  HistoricBackfillStatus,
  HistoricBackfillTaskClaim,
  HistoricBackfillTaskOutput,
  HistoricBackfillTaskProgress,
  PrepareHistoricBackfillInput,
} from './historic-backfill.types';

export const HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT = 101;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface HistoricContextRow {
  sourceRevision: string;
  legacyDualWrite: boolean;
  historicComputeEpoch: string;
  historicBackfillGlobalEpoch: string;
  baseStatisticRevision: string;
  computeMapDate: string | null;
  computeStatsDate: string | null;
  currentPublishedDate: string | null;
  historicDirtyFrom: string | null;
  historicDirtyThrough: string | null;
}

type RunRow = HistoricBackfillRun;

interface StatusRow extends RunRow {
  historicComputeEpochCurrent: boolean;
  historicBackfillGlobalEpochCurrent: boolean;
  statisticsPromotedAt: Date | null;
  total: number | string;
  pending: number | string;
  leased: number | string;
  completed: number | string;
  failed: number | string;
  expiredLeases: number | string;
  staleGenerations: number | string;
  processedSegments: number | string;
  processedCommunes: number | string;
  earliestProgressDate: string | null;
  latestProgressDate: string | null;
  latestHeartbeatAt: Date | null;
  nextAttemptAt: Date | null;
  artifactTotal: number | string;
  artifactPending: number | string;
  artifactLeased: number | string;
  artifactCompleted: number | string;
  artifactFailed: number | string;
  artifactExpiredLeases: number | string;
  artifactStaleContext: number | string;
  artifactCoverageFrom: string | null;
  artifactCoverageThrough: string | null;
  artifactLatestHeartbeatAt: Date | null;
  artifactNextAttemptAt: Date | null;
}

interface ClaimRow {
  runId: string;
  departementId: number | string;
  workerId: string;
  leaseToken: string;
  departementCode: string;
  departmentGeneration: string;
  departmentLastPublicRevision: string;
  attemptCount: number | string;
  leaseExpiresAt: Date;
  progressDate: string | null;
  segmentCount: number | string;
  communeCount: number | string;
  artifactPrefix: string | null;
  mapDateFrom: string;
  statisticDateFrom: string;
  dateThrough: string;
  sourceRevision: string;
  historicComputeEpoch: string;
  baseStatisticRevision: string;
}

export class HistoricBackfillValidationError extends Error {}
export class HistoricBackfillStateError extends Error {}

function parseCount(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid database count: ${String(value)}`);
  }
  return parsed;
}

function assertCivilDate(name: string, value: string): void {
  if (!CIVIL_DATE_PATTERN.test(value)) {
    throw new HistoricBackfillValidationError(
      `${name} must use the YYYY-MM-DD format`,
    );
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new HistoricBackfillValidationError(`${name} is not a valid date`);
  }
}

export function validateHistoricBackfillRange(
  input: PrepareHistoricBackfillInput,
  today = getCurrentParisCivilDate(),
): void {
  assertCivilDate('mapDateFrom', input.mapDateFrom);
  assertCivilDate('statisticDateFrom', input.statisticDateFrom);
  assertCivilDate('dateThrough', input.dateThrough);
  assertCivilDate('today', today);
  if (input.mapDateFrom > input.dateThrough) {
    throw new HistoricBackfillValidationError(
      'mapDateFrom must not be after dateThrough',
    );
  }
  if (input.statisticDateFrom > input.dateThrough) {
    throw new HistoricBackfillValidationError(
      'statisticDateFrom must not be after dateThrough',
    );
  }
  if (input.dateThrough > today) {
    throw new HistoricBackfillValidationError(
      `dateThrough must not be after ${today}`,
    );
  }
}

function assertUuid(name: string, value: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new HistoricBackfillValidationError(`${name} must be a UUID`);
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new HistoricBackfillValidationError(
      `${name} must be a positive integer`,
    );
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HistoricBackfillValidationError(
      `${name} must be a non-negative integer`,
    );
  }
}

function normalizeWorkerId(workerId: string): string {
  const normalized = workerId.trim();
  if (!normalized || normalized.length > 200) {
    throw new HistoricBackfillValidationError(
      'workerId must contain between 1 and 200 characters',
    );
  }
  return normalized;
}

function validateLeaseIdentity(
  identity: HistoricBackfillLeaseIdentity,
): HistoricBackfillLeaseIdentity {
  assertUuid('runId', identity.runId);
  assertPositiveInteger('departementId', identity.departementId);
  assertUuid('leaseToken', identity.leaseToken);
  return { ...identity, workerId: normalizeWorkerId(identity.workerId) };
}

function validateProgress(progress?: HistoricBackfillTaskProgress): void {
  if (!progress) {
    return;
  }
  if (progress.progressDate !== undefined) {
    assertCivilDate('progressDate', progress.progressDate);
  }
  if (progress.segmentCount !== undefined) {
    assertNonNegativeInteger('segmentCount', progress.segmentCount);
  }
  if (progress.communeCount !== undefined) {
    assertNonNegativeInteger('communeCount', progress.communeCount);
  }
  if (
    progress.artifactPrefix !== undefined &&
    progress.artifactPrefix !== null &&
    (!progress.artifactPrefix.trim() || progress.artifactPrefix.length > 2_048)
  ) {
    throw new HistoricBackfillValidationError(
      'artifactPrefix must contain between 1 and 2048 characters',
    );
  }
}

function normalizeRun(row: RunRow): HistoricBackfillRun {
  return {
    id: row.id,
    status: row.status,
    mapDateFrom: row.mapDateFrom,
    statisticDateFrom: row.statisticDateFrom,
    dateThrough: row.dateThrough,
    sourceRevision: String(row.sourceRevision),
    historicComputeEpoch: String(row.historicComputeEpoch),
    historicBackfillGlobalEpoch: String(row.historicBackfillGlobalEpoch),
    baseStatisticRevision: String(row.baseStatisticRevision),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    pausedAt: row.pausedAt,
    completedAt: row.completedAt,
    lastError: row.lastError,
  };
}

@Injectable()
export class HistoricBackfillQueueService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async prepare(
    input: PrepareHistoricBackfillInput,
  ): Promise<HistoricBackfillRun> {
    validateHistoricBackfillRange(input);
    const runId = randomUUID();

    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      await manager.query(
        `SELECT pg_advisory_xact_lock(hashtext('vigieau'), hashtext('historic-backfill-prepare'))`,
      );
      await manager.query(`SET LOCAL lock_timeout = '3s'`);

      const [context] = (await manager.query(`
        SELECT
          source."publicRevision"::text AS "sourceRevision",
          source."legacyDualWrite" AS "legacyDualWrite",
          config."historicComputeEpoch"::text AS "historicComputeEpoch",
          config."historicBackfillGlobalEpoch"::text
            AS "historicBackfillGlobalEpoch",
          config."computeMapDate"::text AS "computeMapDate",
          config."computeStatsDate"::text AS "computeStatsDate",
          statistic_state."revision"::text AS "baseStatisticRevision",
          statistic_state."currentPublishedDate"::text
            AS "currentPublishedDate",
          statistic_state."historicDirtyFrom"::text AS "historicDirtyFrom",
          statistic_state."historicDirtyThrough"::text
            AS "historicDirtyThrough"
        FROM "zone_publication_source_state" source
        CROSS JOIN "config" config
        CROSS JOIN "statistic_publication_state" statistic_state
        WHERE source."id" = 1
          AND config."id" = 1
          AND statistic_state."id" = 1
        FOR UPDATE OF source, config, statistic_state
      `)) as HistoricContextRow[];
      if (!context) {
        throw new HistoricBackfillStateError(
          'The historic source context is incomplete',
        );
      }
      if (context.legacyDualWrite) {
        throw new HistoricBackfillStateError(
          'Historic backfill requires separated public revisions',
        );
      }

      if (
        (context.historicDirtyFrom === null) !==
        (context.historicDirtyThrough === null)
      ) {
        throw new HistoricBackfillStateError(
          'Historic statistic dirty range is incomplete',
        );
      }
      if (!context.currentPublishedDate) {
        throw new HistoricBackfillStateError(
          'Current statistic publication date is missing',
        );
      }
      const requiredDirtyThrough = shiftCivilDate(
        context.currentPublishedDate,
        -1,
      );
      const dirtyFromCandidates = [
        context.historicDirtyFrom,
        context.computeStatsDate,
      ].filter((value): value is string => value !== null);
      const requiredDirtyFrom =
        dirtyFromCandidates.sort()[0] ?? input.statisticDateFrom;
      const requiredMapFrom = [context.computeMapDate, requiredDirtyFrom]
        .filter((value): value is string => value !== null)
        .sort()[0];
      const effectiveDirtyThrough = [
        context.historicDirtyThrough,
        requiredDirtyThrough,
      ]
        .filter((value): value is string => value !== null)
        .sort()
        .at(-1)!;
      if (
        requiredDirtyFrom > effectiveDirtyThrough ||
        input.mapDateFrom > requiredMapFrom ||
        input.statisticDateFrom > requiredDirtyFrom ||
        input.dateThrough < effectiveDirtyThrough ||
        input.dateThrough >= context.currentPublishedDate
      ) {
        throw new HistoricBackfillStateError(
          `Historic backfill does not cover the required statistic range ${requiredDirtyFrom} through ${effectiveDirtyThrough}`,
        );
      }

      let baseStatisticRevision = context.baseStatisticRevision;
      if (
        context.historicDirtyFrom !== requiredDirtyFrom ||
        context.historicDirtyThrough !== effectiveDirtyThrough
      ) {
        const [publication] = unwrapTypeOrmDmlReturningRows<{
          revision: string | number;
        }>(
          await manager.query(
            `
              UPDATE "statistic_publication_state"
              SET
                "revision" = "revision" + 1,
                "historicDirtyFrom" = $1::date,
                "historicDirtyThrough" = $2::date,
                "updatedAt" = now()
              WHERE "id" = 1
                AND "revision" = $3::bigint
              RETURNING "revision"::text AS "revision"
            `,
            [
              requiredDirtyFrom,
              effectiveDirtyThrough,
              context.baseStatisticRevision,
            ],
          ),
        );
        if (!publication) {
          throw new HistoricBackfillStateError(
            'Historic statistic dirty range changed during preparation',
          );
        }
        baseStatisticRevision = String(publication.revision);
      }

      // Lock context rows before the queue table to follow the public-mutation
      // lock order. NOWAIT prevents preparation from waiting behind queue work.
      await manager.query(
        `LOCK TABLE "current_zone_recompute_request" IN SHARE MODE NOWAIT`,
      );

      const unfinishedRuns = (await manager.query(`
        SELECT "id"
        FROM "historic_backfill_run"
        WHERE "status" IN ('preparing', 'running', 'paused')
        FOR UPDATE
      `)) as Array<{ id: string }>;
      if (unfinishedRuns.length > 0) {
        throw new HistoricBackfillStateError(
          `An unfinished historic backfill already exists: ${unfinishedRuns[0].id}`,
        );
      }

      const [queueState] = (await manager.query(`
        SELECT
          (SELECT COUNT(*)::integer FROM "current_zone_recompute_request")
            AS "currentQueueCount",
          (SELECT COUNT(*)::integer FROM "departement")
            AS "departmentCount"
      `)) as Array<{
        currentQueueCount: number | string;
        departmentCount: number | string;
      }>;
      const currentQueueCount = parseCount(queueState?.currentQueueCount ?? -1);
      if (currentQueueCount !== 0) {
        throw new HistoricBackfillStateError(
          `Current zone recomputation queue is not empty (${currentQueueCount})`,
        );
      }
      const departmentCount = parseCount(queueState?.departmentCount ?? -1);
      if (departmentCount !== HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT) {
        throw new HistoricBackfillStateError(
          `Expected ${HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT} departments, found ${departmentCount}`,
        );
      }

      await manager.query(
        `
          INSERT INTO "historic_backfill_department_revision" (
            "departementId", "generation", "lastPublicRevision", "updatedAt"
          )
          SELECT "id", 0, $1::bigint, now()
          FROM "departement"
          ON CONFLICT ("departementId") DO NOTHING
        `,
        [context.sourceRevision],
      );

      await manager.query(
        `
          INSERT INTO "historic_backfill_run" (
            "id", "status", "mapDateFrom", "statisticDateFrom",
            "dateThrough", "sourceRevision", "historicComputeEpoch",
            "historicBackfillGlobalEpoch",
            "baseStatisticRevision", "statisticsPromotedAt",
            "createdAt", "updatedAt"
          ) VALUES (
            $1::uuid, 'preparing', $2::date, $3::date, $4::date,
            $5::bigint, $6::bigint, $7::bigint, $8::bigint,
            NULL, now(), now()
          )
        `,
        [
          runId,
          input.mapDateFrom,
          input.statisticDateFrom,
          input.dateThrough,
          context.sourceRevision,
          context.historicComputeEpoch,
          context.historicBackfillGlobalEpoch,
          baseStatisticRevision,
        ],
      );

      const insertedTasks = unwrapTypeOrmDmlReturningRows<{
        departementId: number;
      }>(
        await manager.query(
          `
            INSERT INTO "historic_backfill_task" (
              "runId", "departementId", "status", "departmentGeneration",
              "progressDate", "segmentCount", "communeCount",
              "outputSignature", "artifactPrefix", "attemptCount",
              "leaseOwner", "leaseToken", "leaseExpiresAt", "heartbeatAt",
              "nextAttemptAt", "startedAt", "completedAt", "lastError",
              "createdAt", "updatedAt"
            )
            SELECT
              $1::uuid, departement."id", 'pending', revision."generation",
              NULL, 0, 0, NULL, NULL, 0,
              NULL, NULL, NULL, NULL, now(), NULL, NULL, NULL, now(), now()
            FROM "departement" departement
            JOIN "historic_backfill_department_revision" revision
              ON revision."departementId" = departement."id"
            ORDER BY departement."code"
            RETURNING "departementId"
          `,
          [runId],
        ),
      );
      if (insertedTasks.length !== departmentCount) {
        throw new HistoricBackfillStateError(
          `Prepared ${insertedTasks.length}/${departmentCount} department tasks`,
        );
      }

      const [run] = unwrapTypeOrmDmlReturningRows<RunRow>(
        await manager.query(
          `
            UPDATE "historic_backfill_run"
            SET
              "status" = 'running',
              "startedAt" = now(),
              "updatedAt" = now()
            WHERE "id" = $1::uuid
              AND "status" = 'preparing'
            RETURNING
              "id", "status", "mapDateFrom"::text AS "mapDateFrom",
              "statisticDateFrom"::text AS "statisticDateFrom",
              "dateThrough"::text AS "dateThrough",
              "sourceRevision"::text AS "sourceRevision",
              "historicComputeEpoch"::text AS "historicComputeEpoch",
              "historicBackfillGlobalEpoch"::text
                AS "historicBackfillGlobalEpoch",
              "baseStatisticRevision"::text AS "baseStatisticRevision",
              "createdAt", "updatedAt", "startedAt", "pausedAt",
              "completedAt", "lastError"
          `,
          [runId],
        ),
      );
      if (!run) {
        throw new HistoricBackfillStateError(
          'Unable to start the prepared historic backfill',
        );
      }
      return normalizeRun(run);
    });
  }

  async status(runId: string): Promise<HistoricBackfillStatus | null> {
    assertUuid('runId', runId);
    const [row] = (await this.dataSource.query(
      `
        SELECT
          run."id", run."status",
          run."mapDateFrom"::text AS "mapDateFrom",
          run."statisticDateFrom"::text AS "statisticDateFrom",
          run."dateThrough"::text AS "dateThrough",
          run."sourceRevision"::text AS "sourceRevision",
          run."historicComputeEpoch"::text AS "historicComputeEpoch",
          run."historicBackfillGlobalEpoch"::text
            AS "historicBackfillGlobalEpoch",
          run."baseStatisticRevision"::text AS "baseStatisticRevision",
          run."statisticsPromotedAt",
          run."createdAt", run."updatedAt", run."startedAt", run."pausedAt",
          run."completedAt", run."lastError",
          run."historicComputeEpoch" = config."historicComputeEpoch"
            AS "historicComputeEpochCurrent",
          run."historicBackfillGlobalEpoch" =
              config."historicBackfillGlobalEpoch"
            AS "historicBackfillGlobalEpochCurrent",
          summary.*,
          artifact_summary.*
        FROM "historic_backfill_run" run
        CROSS JOIN "config" config
        CROSS JOIN LATERAL (
          SELECT
            COUNT(*)::integer AS "total",
            COUNT(*) FILTER (WHERE task."status" = 'pending')::integer
              AS "pending",
            COUNT(*) FILTER (WHERE task."status" = 'leased')::integer
              AS "leased",
            COUNT(*) FILTER (WHERE task."status" = 'completed')::integer
              AS "completed",
            COUNT(*) FILTER (WHERE task."status" = 'failed')::integer
              AS "failed",
            COUNT(*) FILTER (
              WHERE task."status" = 'leased'
                AND task."leaseExpiresAt" <= now()
            )::integer AS "expiredLeases",
            COUNT(*) FILTER (
              WHERE revision."generation" IS DISTINCT FROM
                task."departmentGeneration"
            )::integer AS "staleGenerations",
            COALESCE(SUM(task."segmentCount"), 0)::integer
              AS "processedSegments",
            COALESCE(SUM(task."communeCount"), 0)::integer
              AS "processedCommunes",
            MIN(task."progressDate")::text AS "earliestProgressDate",
            MAX(task."progressDate")::text AS "latestProgressDate",
            MAX(task."heartbeatAt") AS "latestHeartbeatAt",
            MIN(task."nextAttemptAt") FILTER (
              WHERE task."status" = 'pending'
            ) AS "nextAttemptAt"
          FROM "historic_backfill_task" task
          LEFT JOIN "historic_backfill_department_revision" revision
            ON revision."departementId" = task."departementId"
          WHERE task."runId" = run."id"
        ) summary
        CROSS JOIN LATERAL (
          SELECT
            COUNT(*)::integer AS "artifactTotal",
            COUNT(*) FILTER (WHERE task."status" = 'pending')::integer
              AS "artifactPending",
            COUNT(*) FILTER (WHERE task."status" = 'leased')::integer
              AS "artifactLeased",
            COUNT(*) FILTER (WHERE task."status" = 'completed')::integer
              AS "artifactCompleted",
            COUNT(*) FILTER (WHERE task."status" = 'failed')::integer
              AS "artifactFailed",
            COUNT(*) FILTER (
              WHERE task."status" = 'leased'
                AND task."leaseExpiresAt" <= now()
            )::integer AS "artifactExpiredLeases",
            COUNT(*) FILTER (
              WHERE task."sourceRevision" IS DISTINCT FROM run."sourceRevision"
                OR task."historicComputeEpoch" IS DISTINCT FROM
                  run."historicComputeEpoch"
            )::integer AS "artifactStaleContext",
            MIN(task."validFrom")::text AS "artifactCoverageFrom",
            MAX(task."validThrough")::text AS "artifactCoverageThrough",
            MAX(task."heartbeatAt") AS "artifactLatestHeartbeatAt",
            MIN(task."nextAttemptAt") FILTER (
              WHERE task."status" = 'pending'
            ) AS "artifactNextAttemptAt"
          FROM "historic_backfill_artifact_task" task
          WHERE task."runId" = run."id"
        ) artifact_summary
        WHERE run."id" = $1::uuid
          AND config."id" = 1
      `,
      [runId],
    )) as StatusRow[];
    if (!row) {
      return null;
    }
    const tasks = {
      total: parseCount(row.total),
      pending: parseCount(row.pending),
      leased: parseCount(row.leased),
      completed: parseCount(row.completed),
      failed: parseCount(row.failed),
      expiredLeases: parseCount(row.expiredLeases),
      staleGenerations: parseCount(row.staleGenerations),
      processedSegments: parseCount(row.processedSegments),
      processedCommunes: parseCount(row.processedCommunes),
      earliestProgressDate: row.earliestProgressDate,
      latestProgressDate: row.latestProgressDate,
      latestHeartbeatAt: row.latestHeartbeatAt,
      nextAttemptAt: row.nextAttemptAt,
    };
    const artifacts = {
      total: parseCount(row.artifactTotal),
      pending: parseCount(row.artifactPending),
      leased: parseCount(row.artifactLeased),
      completed: parseCount(row.artifactCompleted),
      failed: parseCount(row.artifactFailed),
      expiredLeases: parseCount(row.artifactExpiredLeases),
      staleContext: parseCount(row.artifactStaleContext),
      coverageFrom: row.artifactCoverageFrom,
      coverageThrough: row.artifactCoverageThrough,
      latestHeartbeatAt: row.artifactLatestHeartbeatAt,
      nextAttemptAt: row.artifactNextAttemptAt,
    };
    return {
      run: normalizeRun(row),
      tasks,
      artifacts,
      historicComputeEpochCurrent: row.historicComputeEpochCurrent,
      historicBackfillGlobalEpochCurrent:
        row.historicBackfillGlobalEpochCurrent,
      readyToFinalize:
        row.status === 'running' &&
        row.historicComputeEpochCurrent &&
        row.historicBackfillGlobalEpochCurrent &&
        tasks.total > 0 &&
        tasks.completed === tasks.total &&
        tasks.staleGenerations === 0,
      readyToFinalizeMaps:
        row.status === 'running' &&
        row.historicComputeEpochCurrent &&
        row.historicBackfillGlobalEpochCurrent &&
        Boolean(row.statisticsPromotedAt) &&
        artifacts.total > 0 &&
        artifacts.completed === artifacts.total &&
        artifacts.staleContext === 0,
    };
  }

  async claim(
    workerId: string,
    leaseSeconds: number,
    maxAttempts: number,
  ): Promise<HistoricBackfillTaskClaim | null> {
    const normalizedWorkerId = normalizeWorkerId(workerId);
    assertPositiveInteger('leaseSeconds', leaseSeconds);
    assertPositiveInteger('maxAttempts', maxAttempts);
    const leaseToken = randomUUID();
    await this.reconcileStaleRuns();
    const row = await this.dataSource.transaction(
      'READ COMMITTED',
      async (manager) => {
        await manager.query(`
          SELECT run."id"
          FROM "historic_backfill_run" run
          WHERE run."status" = 'running'
          ORDER BY run."id"
          FOR SHARE OF run
        `);
        const rows = unwrapTypeOrmDmlReturningRows<ClaimRow>(
          await manager.query(
            `
          WITH priority AS MATERIALIZED (
            SELECT (
              EXISTS (
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
              OR EXISTS (
                SELECT 1
                FROM "external_publication_run" daily_run
                WHERE daily_run."jobKey" = 'compute:national-daily'
                  AND daily_run."status" = 'running'
              )
              OR EXISTS (
                SELECT 1
                FROM "statistic_commune_snapshot" snapshot
                WHERE snapshot."status" = 'running'
              )
            ) AS "currentWorkActive"
          ), exhausted_candidate AS MATERIALIZED (
            SELECT task."runId", task."departementId"
            FROM "historic_backfill_task" task
            JOIN "historic_backfill_run" run ON run."id" = task."runId"
            JOIN "historic_backfill_department_revision" revision
              ON revision."departementId" = task."departementId"
            CROSS JOIN "config" config
            WHERE run."status" = 'running'
              AND config."id" = 1
              AND run."historicComputeEpoch" = config."historicComputeEpoch"
              AND run."historicBackfillGlobalEpoch" =
                config."historicBackfillGlobalEpoch"
              AND NOT EXISTS (
                SELECT 1 FROM priority WHERE priority."currentWorkActive"
              )
              AND NOT EXISTS (
                SELECT 1
                FROM "historic_backfill_map_manifest_outbox" outbox
                WHERE outbox."runId" = run."id"
                  AND outbox."status" = 'pending'
              )
              AND task."departmentGeneration" = revision."generation"
              AND task."attemptCount" >= $4::integer
              AND (
                (task."status" = 'pending' AND task."nextAttemptAt" <= now())
                OR (
                  task."status" = 'leased'
                  AND task."leaseExpiresAt" <= now()
                )
              )
            ORDER BY task."nextAttemptAt", task."createdAt"
            FOR UPDATE OF task SKIP LOCKED
            LIMIT 100
          ),
          exhausted AS (
            UPDATE "historic_backfill_task" task
            SET
              "status" = 'failed',
              "leaseOwner" = NULL,
              "leaseToken" = NULL,
              "leaseExpiresAt" = NULL,
              "completedAt" = NULL,
              "lastError" = COALESCE(
                task."lastError",
                'Maximum historic backfill attempts exhausted'
              ),
              "updatedAt" = now()
            FROM exhausted_candidate candidate
            WHERE task."runId" = candidate."runId"
              AND task."departementId" = candidate."departementId"
            RETURNING task."runId"
          ),
          failed_runs AS (
            UPDATE "historic_backfill_run" run
            SET
              "status" = 'failed',
              "lastError" = 'At least one department exhausted its attempts',
              "updatedAt" = now()
            WHERE run."status" = 'running'
              AND run."id" IN (SELECT "runId" FROM exhausted)
            RETURNING run."id"
          ),
          candidate AS MATERIALIZED (
            SELECT
              task."runId", task."departementId",
              task."departmentGeneration" AS "previousGeneration",
              revision."generation" AS "currentGeneration",
              source."publicRevision" AS "currentSourceRevision",
              (
                run."statisticsPromotedAt" IS NOT NULL
                AND statistic_state."historicDirtyFrom" IS NULL
                AND statistic_state."historicDirtyThrough" IS NULL
                AND statistic_state."historicPublishedThrough" >=
                  run."dateThrough"
                AND config."computeStatsDate" >= run."dateThrough"
              ) AS "statisticsPublicationClosed"
            FROM "historic_backfill_task" task
            JOIN "historic_backfill_run" run ON run."id" = task."runId"
            JOIN "departement" departement
              ON departement."id" = task."departementId"
            JOIN "historic_backfill_department_revision" revision
              ON revision."departementId" = task."departementId"
            CROSS JOIN "zone_publication_source_state" source
            CROSS JOIN "config" config
            CROSS JOIN "statistic_publication_state" statistic_state
            WHERE run."status" = 'running'
              AND source."id" = 1
              AND config."id" = 1
              AND statistic_state."id" = 1
              AND run."historicComputeEpoch" = config."historicComputeEpoch"
              AND run."historicBackfillGlobalEpoch" =
                config."historicBackfillGlobalEpoch"
              AND NOT EXISTS (
                SELECT 1 FROM priority WHERE priority."currentWorkActive"
              )
              AND NOT EXISTS (
                SELECT 1 FROM failed_runs WHERE failed_runs."id" = run."id"
              )
              AND NOT EXISTS (
                SELECT 1
                FROM "historic_backfill_map_manifest_outbox" outbox
                WHERE outbox."runId" = run."id"
                  AND outbox."status" = 'pending'
              )
              AND (
                (task."status" = 'pending' AND task."nextAttemptAt" <= now())
                OR (
                  task."status" = 'leased'
                  AND task."leaseExpiresAt" <= now()
                )
                OR (
                  task."status" = 'completed'
                  AND task."departmentGeneration" <> revision."generation"
                )
              )
              AND (
                task."departmentGeneration" <> revision."generation"
                OR task."attemptCount" < $4::integer
              )
            ORDER BY run."createdAt", task."nextAttemptAt", departement."code"
            FOR UPDATE OF task SKIP LOCKED
            LIMIT 1
          ),
          purged_stale_commune_segments AS (
            DELETE FROM "historic_backfill_commune_segment" segment
            USING candidate
            WHERE candidate."previousGeneration" <>
                candidate."currentGeneration"
              AND segment."runId" = candidate."runId"
              AND segment."departementId" = candidate."departementId"
            RETURNING segment."runId"
          ),
          purged_stale_department_segments AS (
            DELETE FROM "historic_backfill_department_segment" segment
            USING candidate
            WHERE candidate."previousGeneration" <>
                candidate."currentGeneration"
              AND segment."runId" = candidate."runId"
              AND segment."departementId" = candidate."departementId"
            RETURNING segment."runId"
          ),
          purged_stale_commune_shadow AS (
            DELETE FROM "historic_backfill_commune_shadow" shadow
            USING candidate
            WHERE candidate."previousGeneration" <>
                candidate."currentGeneration"
              AND shadow."runId" = candidate."runId"
              AND shadow."departementId" = candidate."departementId"
            RETURNING shadow."runId"
          ),
          rebased_run AS (
            UPDATE "historic_backfill_run" run
            SET
              "sourceRevision" = GREATEST(
                run."sourceRevision",
                candidate."currentSourceRevision"
              ),
              "statisticsPromotedAt" = CASE
                WHEN candidate."statisticsPublicationClosed"
                  THEN run."statisticsPromotedAt"
                ELSE NULL
              END,
              "updatedAt" = now()
            FROM candidate
            WHERE candidate."previousGeneration" <>
                candidate."currentGeneration"
              AND run."id" = candidate."runId"
              AND run."status" = 'running'
              AND (
                (SELECT COUNT(*) FROM purged_stale_commune_segments)
                + (SELECT COUNT(*) FROM purged_stale_department_segments)
                + (SELECT COUNT(*) FROM purged_stale_commune_shadow)
              ) >= 0
            RETURNING run."id", run."sourceRevision"
          ),
          claimed AS (
            UPDATE "historic_backfill_task" task
            SET
              "status" = 'leased',
              "departmentGeneration" = candidate."currentGeneration",
              "progressDate" = CASE
                WHEN candidate."previousGeneration" <>
                    candidate."currentGeneration" THEN NULL
                ELSE task."progressDate"
              END,
              "segmentCount" = CASE
                WHEN candidate."previousGeneration" <>
                    candidate."currentGeneration" THEN 0
                ELSE task."segmentCount"
              END,
              "communeCount" = CASE
                WHEN candidate."previousGeneration" <>
                    candidate."currentGeneration" THEN 0
                ELSE task."communeCount"
              END,
              "outputSignature" = NULL,
              "artifactPrefix" = CASE
                WHEN candidate."previousGeneration" <>
                    candidate."currentGeneration" THEN NULL
                ELSE task."artifactPrefix"
              END,
              "attemptCount" = CASE
                WHEN candidate."previousGeneration" <>
                    candidate."currentGeneration" THEN 1
                ELSE task."attemptCount" + 1
              END,
              "leaseOwner" = $1,
              "leaseToken" = $2::uuid,
              "leaseExpiresAt" = now() + make_interval(secs => $3::integer),
              "heartbeatAt" = now(),
              "nextAttemptAt" = now(),
              "startedAt" = CASE
                WHEN candidate."previousGeneration" <>
                    candidate."currentGeneration" THEN now()
                ELSE COALESCE(task."startedAt", now())
              END,
              "completedAt" = NULL,
              "lastError" = NULL,
              "updatedAt" = now()
            FROM candidate
            WHERE task."runId" = candidate."runId"
              AND task."departementId" = candidate."departementId"
              AND (
                candidate."previousGeneration" = candidate."currentGeneration"
                OR EXISTS (
                  SELECT 1 FROM rebased_run
                  WHERE rebased_run."id" = candidate."runId"
                )
              )
            RETURNING task.*
          )
          SELECT
            claimed."runId", claimed."departementId",
            claimed."leaseOwner" AS "workerId", claimed."leaseToken",
            departement."code" AS "departementCode",
            claimed."departmentGeneration"::text AS "departmentGeneration",
            revision."lastPublicRevision"::text
              AS "departmentLastPublicRevision",
            claimed."attemptCount", claimed."leaseExpiresAt",
            claimed."progressDate"::text AS "progressDate",
            claimed."segmentCount", claimed."communeCount",
            claimed."artifactPrefix",
            run."mapDateFrom"::text AS "mapDateFrom",
            run."statisticDateFrom"::text AS "statisticDateFrom",
            run."dateThrough"::text AS "dateThrough",
            COALESCE(
              rebased_run."sourceRevision", run."sourceRevision"
            )::text AS "sourceRevision",
            run."historicComputeEpoch"::text AS "historicComputeEpoch",
            run."baseStatisticRevision"::text AS "baseStatisticRevision",
            (
              (SELECT COUNT(*) FROM purged_stale_commune_segments)
              + (SELECT COUNT(*) FROM purged_stale_department_segments)
              + (SELECT COUNT(*) FROM purged_stale_commune_shadow)
            ) AS "purgedCount"
          FROM claimed
          JOIN "historic_backfill_run" run ON run."id" = claimed."runId"
          JOIN "departement" departement
            ON departement."id" = claimed."departementId"
          JOIN "historic_backfill_department_revision" revision
            ON revision."departementId" = claimed."departementId"
          LEFT JOIN rebased_run ON rebased_run."id" = claimed."runId"
        `,
            [normalizedWorkerId, leaseToken, leaseSeconds, maxAttempts],
          ),
        );
        const claimed = rows[0] ?? null;
        if (!claimed) {
          return null;
        }

        const [cleanup] = await manager.query(
          `
            WITH claimed_task AS MATERIALIZED (
              SELECT
                task."runId", task."departementId", task."progressDate"
              FROM "historic_backfill_task" task
              WHERE task."runId" = $1::uuid
                AND task."departementId" = $2::integer
                AND task."status" = 'leased'
                AND task."leaseOwner" = $3
                AND task."leaseToken" = $4::uuid
              FOR UPDATE OF task
            ), purged_commune_segments AS (
              DELETE FROM "historic_backfill_commune_segment" segment
              USING claimed_task task
              WHERE segment."runId" = task."runId"
                AND segment."departementId" = task."departementId"
                AND (
                  task."progressDate" IS NULL
                  OR segment."validThrough" > task."progressDate"
                )
              RETURNING segment."runId"
            ), purged_department_segments AS (
              DELETE FROM "historic_backfill_department_segment" segment
              USING claimed_task task
              WHERE segment."runId" = task."runId"
                AND segment."departementId" = task."departementId"
                AND (
                  task."progressDate" IS NULL
                  OR segment."validThrough" > task."progressDate"
                )
              RETURNING segment."runId"
            )
            SELECT
              (SELECT COUNT(*)::integer FROM claimed_task) AS "contextCount",
              (SELECT COUNT(*)::integer FROM purged_commune_segments)
                AS "communeCount",
              (SELECT COUNT(*)::integer FROM purged_department_segments)
                AS "departmentCount"
          `,
          [
            claimed.runId,
            claimed.departementId,
            claimed.workerId,
            claimed.leaseToken,
          ],
        );
        if (parseCount(cleanup?.contextCount) !== 1) {
          throw new HistoricBackfillStateError(
            `Historic backfill claim context was lost for ${claimed.runId}/${claimed.departementId}`,
          );
        }
        return claimed;
      },
    );
    if (!row) {
      return null;
    }
    return {
      runId: row.runId,
      departementId: parseCount(row.departementId),
      workerId: row.workerId,
      leaseToken: row.leaseToken,
      departementCode: row.departementCode,
      attemptCount: parseCount(row.attemptCount),
      leaseExpiresAt: row.leaseExpiresAt,
      progressDate: row.progressDate,
      segmentCount: parseCount(row.segmentCount),
      communeCount: parseCount(row.communeCount),
      artifactPrefix: row.artifactPrefix,
      mapDateFrom: row.mapDateFrom,
      statisticDateFrom: row.statisticDateFrom,
      dateThrough: row.dateThrough,
      departmentGeneration: String(row.departmentGeneration),
      departmentLastPublicRevision: String(row.departmentLastPublicRevision),
      sourceRevision: String(row.sourceRevision),
      historicComputeEpoch: String(row.historicComputeEpoch),
      baseStatisticRevision: String(row.baseStatisticRevision),
    };
  }

  async heartbeat(
    lease: HistoricBackfillLeaseIdentity,
    progress: HistoricBackfillTaskProgress | undefined,
    leaseSeconds: number,
  ): Promise<boolean> {
    const normalized = validateLeaseIdentity(lease);
    validateProgress(progress);
    assertPositiveInteger('leaseSeconds', leaseSeconds);
    const updated = unwrapTypeOrmDmlReturningRows<{ runId: string }>(
      await this.dataSource.query(
        `
          UPDATE "historic_backfill_task" task
          SET
            "progressDate" = CASE
              WHEN $5::date IS NULL THEN task."progressDate"
              WHEN task."progressDate" IS NULL THEN $5::date
              ELSE GREATEST(task."progressDate", $5::date)
            END,
            "segmentCount" = CASE
              WHEN $6::integer IS NULL THEN task."segmentCount"
              ELSE GREATEST(task."segmentCount", $6::integer)
            END,
            "communeCount" = CASE
              WHEN $7::integer IS NULL THEN task."communeCount"
              ELSE GREATEST(task."communeCount", $7::integer)
            END,
            "artifactPrefix" = COALESCE($8::text, task."artifactPrefix"),
            "heartbeatAt" = now(),
            "leaseExpiresAt" = now() + make_interval(secs => $4::integer),
            "updatedAt" = now()
          FROM "historic_backfill_run" run,
            "historic_backfill_department_revision" revision,
            "config" config
          WHERE task."runId" = $1::uuid
            AND task."departementId" = $2::integer
            AND task."leaseOwner" = $3
            AND task."leaseToken" = $9::uuid
            AND task."status" = 'leased'
            AND task."leaseExpiresAt" > now()
            AND run."id" = task."runId"
            AND run."status" = 'running'
            AND config."id" = 1
            AND config."historicComputeEpoch" = run."historicComputeEpoch"
            AND config."historicBackfillGlobalEpoch" =
              run."historicBackfillGlobalEpoch"
            AND ($5::date IS NULL OR (
              $5::date BETWEEN LEAST(
                run."mapDateFrom", run."statisticDateFrom"
              ) AND run."dateThrough"
            ))
            AND revision."departementId" = task."departementId"
            AND revision."generation" = task."departmentGeneration"
          RETURNING task."runId"
        `,
        [
          normalized.runId,
          normalized.departementId,
          normalized.workerId,
          leaseSeconds,
          progress?.progressDate ?? null,
          progress?.segmentCount ?? null,
          progress?.communeCount ?? null,
          progress?.artifactPrefix ?? null,
          normalized.leaseToken,
        ],
      ),
    );
    return updated.length === 1;
  }

  async complete(
    lease: HistoricBackfillLeaseIdentity,
    output: HistoricBackfillTaskOutput,
  ): Promise<boolean> {
    const normalized = validateLeaseIdentity(lease);
    validateProgress(output);
    if (!SHA256_PATTERN.test(output.outputSignature)) {
      throw new HistoricBackfillValidationError(
        'outputSignature must be a lowercase SHA-256 digest',
      );
    }
    const completed = unwrapTypeOrmDmlReturningRows<{ runId: string }>(
      await this.dataSource.query(
        `
          UPDATE "historic_backfill_task" task
          SET
            "status" = 'completed',
            "progressDate" = $5::date,
            "segmentCount" = $6::integer,
            "communeCount" = $7::integer,
            "outputSignature" = $8,
            "artifactPrefix" = $9::text,
            "leaseOwner" = NULL,
            "leaseToken" = NULL,
            "leaseExpiresAt" = NULL,
            "heartbeatAt" = now(),
            "completedAt" = now(),
            "lastError" = NULL,
            "updatedAt" = now()
          FROM "historic_backfill_run" run,
            "historic_backfill_department_revision" revision,
            "config" config
          WHERE task."runId" = $1::uuid
            AND task."departementId" = $2::integer
            AND task."leaseOwner" = $3
            AND task."leaseToken" = $4::uuid
            AND task."status" = 'leased'
            AND task."leaseExpiresAt" > now()
            AND run."id" = task."runId"
            AND run."status" = 'running'
            AND config."id" = 1
            AND config."historicComputeEpoch" = run."historicComputeEpoch"
            AND config."historicBackfillGlobalEpoch" =
              run."historicBackfillGlobalEpoch"
            AND $5::date = run."dateThrough"
            AND revision."departementId" = task."departementId"
            AND revision."generation" = task."departmentGeneration"
          RETURNING task."runId"
        `,
        [
          normalized.runId,
          normalized.departementId,
          normalized.workerId,
          normalized.leaseToken,
          output.progressDate,
          output.segmentCount,
          output.communeCount,
          output.outputSignature,
          output.artifactPrefix ?? null,
        ],
      ),
    );
    return completed.length === 1;
  }

  async fail(
    lease: HistoricBackfillLeaseIdentity,
    error: unknown,
    maxAttempts: number,
    retryBaseSeconds: number,
    retryMaxSeconds: number,
  ): Promise<HistoricBackfillFailureDisposition | null> {
    const normalized = validateLeaseIdentity(lease);
    assertPositiveInteger('maxAttempts', maxAttempts);
    assertPositiveInteger('retryBaseSeconds', retryBaseSeconds);
    assertPositiveInteger('retryMaxSeconds', retryMaxSeconds);
    if (retryBaseSeconds > retryMaxSeconds) {
      throw new HistoricBackfillValidationError(
        'retryBaseSeconds must not exceed retryMaxSeconds',
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    const [result] = unwrapTypeOrmDmlReturningRows<{
      disposition: HistoricBackfillFailureDisposition;
    }>(
      await this.dataSource.query(
        `
          WITH failed_task AS (
            UPDATE "historic_backfill_task" task
            SET
              "status" = CASE
                WHEN task."attemptCount" >= $6::integer
                  THEN 'failed'
                ELSE 'pending'
              END,
              "leaseOwner" = NULL,
              "leaseToken" = NULL,
              "leaseExpiresAt" = NULL,
              "heartbeatAt" = now(),
              "nextAttemptAt" = CASE
                WHEN task."attemptCount" >= $6::integer THEN now()
                ELSE now() + make_interval(secs => LEAST(
                  $7::integer * power(
                    2,
                    LEAST(GREATEST(task."attemptCount" - 1, 0), 10)
                  )::integer,
                  $8::integer
                ))
              END,
              "completedAt" = NULL,
              "lastError" = left($5, 4000),
              "updatedAt" = now()
            FROM "historic_backfill_run" run,
              "historic_backfill_department_revision" revision,
              "config" config
            WHERE task."runId" = $1::uuid
              AND task."departementId" = $2::integer
              AND task."leaseOwner" = $3
              AND task."leaseToken" = $4::uuid
              AND task."status" = 'leased'
              AND task."leaseExpiresAt" > now()
              AND run."id" = task."runId"
              AND run."status" = 'running'
              AND config."id" = 1
              AND config."historicComputeEpoch" = run."historicComputeEpoch"
              AND config."historicBackfillGlobalEpoch" =
                run."historicBackfillGlobalEpoch"
              AND revision."departementId" = task."departementId"
              AND revision."generation" = task."departmentGeneration"
            RETURNING task."runId", task."departementId", task."status"
          ),
          failed_run AS (
            UPDATE "historic_backfill_run" run
            SET
              "status" = 'failed',
              "pausedAt" = NULL,
              "lastError" = left($5, 4000),
              "updatedAt" = now()
            FROM failed_task
            WHERE failed_task."status" = 'failed'
              AND run."id" = failed_task."runId"
              AND run."status" = 'running'
            RETURNING run."id"
          ),
          released_siblings AS (
            UPDATE "historic_backfill_task" sibling
            SET
              "status" = 'pending',
              "leaseOwner" = NULL,
              "leaseToken" = NULL,
              "leaseExpiresAt" = NULL,
              "heartbeatAt" = NULL,
              "nextAttemptAt" = now(),
              "updatedAt" = now()
            FROM failed_run, failed_task
            WHERE sibling."runId" = failed_run."id"
              AND sibling."status" = 'leased'
              AND NOT (
                sibling."runId" = failed_task."runId"
                AND sibling."departementId" = failed_task."departementId"
              )
            RETURNING sibling."runId"
          )
          SELECT
            CASE
              WHEN failed_task."status" = 'failed' THEN 'terminal'
              ELSE 'retry'
            END AS "disposition",
            (SELECT COUNT(*) FROM released_siblings) AS "releasedCount"
          FROM failed_task
        `,
        [
          normalized.runId,
          normalized.departementId,
          normalized.workerId,
          normalized.leaseToken,
          message,
          maxAttempts,
          retryBaseSeconds,
          retryMaxSeconds,
        ],
      ),
    );
    return result?.disposition ?? null;
  }

  async yieldTask(
    lease: HistoricBackfillLeaseIdentity,
    delaySeconds = 0,
  ): Promise<boolean> {
    const normalized = validateLeaseIdentity(lease);
    assertNonNegativeInteger('delaySeconds', delaySeconds);
    const yielded = unwrapTypeOrmDmlReturningRows<{ runId: string }>(
      await this.dataSource.query(
        `
          UPDATE "historic_backfill_task"
          SET
            "status" = 'pending',
            "attemptCount" = GREATEST("attemptCount" - 1, 0),
            "leaseOwner" = NULL,
            "leaseToken" = NULL,
            "leaseExpiresAt" = NULL,
            "heartbeatAt" = NULL,
            "nextAttemptAt" = now() + make_interval(secs => $5::integer),
            "completedAt" = NULL,
            "lastError" = NULL,
            "updatedAt" = now()
          WHERE "runId" = $1::uuid
            AND "departementId" = $2::integer
            AND "leaseOwner" = $3
            AND "leaseToken" = $4::uuid
            AND "status" = 'leased'
          RETURNING "runId"
        `,
        [
          normalized.runId,
          normalized.departementId,
          normalized.workerId,
          normalized.leaseToken,
          delaySeconds,
        ],
      ),
    );
    return yielded.length === 1;
  }

  async pause(runId: string): Promise<boolean> {
    assertUuid('runId', runId);
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      const [target] = (await manager.query(
        `
          SELECT "id", "status"
          FROM "historic_backfill_run"
          WHERE "id" = $1::uuid
          FOR UPDATE
        `,
        [runId],
      )) as Array<{ id: string; status: string }>;
      if (!target) return false;
      if (target.status !== 'running') return target.status === 'paused';

      const [result] = unwrapTypeOrmDmlReturningRows<{
        status: string | null;
        pendingPublication: boolean | string;
        releasedCount: number | string;
      }>(
        await manager.query(
          `
          WITH pending_publication AS MATERIALIZED (
            SELECT outbox."runId"
            FROM "historic_backfill_map_manifest_outbox" outbox
            WHERE outbox."runId" = $1::uuid
              AND outbox."status" = 'pending'
          ), paused_run AS (
            UPDATE "historic_backfill_run" run
            SET
              "status" = 'paused',
              "pausedAt" = now(),
              "lastError" = NULL,
              "updatedAt" = now()
            WHERE run."id" = $1::uuid
              AND run."status" = 'running'
              AND NOT EXISTS (SELECT 1 FROM pending_publication)
            RETURNING run."id", run."status"
          ),
          released AS (
            UPDATE "historic_backfill_task" task
            SET
              "status" = 'pending',
              "leaseOwner" = NULL,
              "leaseToken" = NULL,
              "leaseExpiresAt" = NULL,
              "heartbeatAt" = NULL,
              "nextAttemptAt" = now(),
              "updatedAt" = now()
            FROM paused_run
            WHERE task."runId" = paused_run."id"
              AND task."status" = 'leased'
            RETURNING task."runId"
          ),
          released_artifacts AS (
            UPDATE "historic_backfill_artifact_task" task
            SET
              "status" = 'pending',
              "leaseOwner" = NULL,
              "leaseToken" = NULL,
              "leaseExpiresAt" = NULL,
              "heartbeatAt" = NULL,
              "nextAttemptAt" = now(),
              "geojsonObjectKey" = NULL,
              "geojsonChecksum" = NULL,
              "pmtilesObjectKey" = NULL,
              "pmtilesChecksum" = NULL,
              "featureCount" = 0,
              "updatedAt" = now()
            FROM paused_run
            WHERE task."runId" = paused_run."id"
              AND task."status" = 'leased'
            RETURNING task."runId"
          )
          SELECT
            (SELECT "status" FROM paused_run) AS "status",
            EXISTS (SELECT 1 FROM pending_publication)
              AS "pendingPublication",
            (
              (SELECT COUNT(*) FROM released)
              + (SELECT COUNT(*) FROM released_artifacts)
            ) AS "releasedCount"
        `,
          [runId],
        ),
      );
      return result?.status === 'paused';
    });
  }

  async resume(runId: string): Promise<boolean> {
    assertUuid('runId', runId);
    const [result] = unwrapTypeOrmDmlReturningRows<{
      status: string;
      requeuedCount: number | string;
      conflictingRunId: string | null;
    }>(
      await this.dataSource.query(
        `
          WITH prepare_lock AS MATERIALIZED (
            SELECT pg_advisory_xact_lock(
              hashtext('vigieau'),
              hashtext('historic-backfill-prepare')
            )
          ),
          target AS MATERIALIZED (
            SELECT
              run."id", run."status",
              run."historicComputeEpoch" = config."historicComputeEpoch"
                AS "historicComputeEpochCurrent",
              run."historicBackfillGlobalEpoch" =
                  config."historicBackfillGlobalEpoch"
                AS "historicBackfillGlobalEpochCurrent"
            FROM "historic_backfill_run" run
            CROSS JOIN "config" config
            CROSS JOIN prepare_lock
            WHERE run."id" = $1::uuid
              AND config."id" = 1
            FOR UPDATE OF run
          ),
          active_conflict AS MATERIALIZED (
            SELECT run."id"
            FROM "historic_backfill_run" run
            CROSS JOIN prepare_lock
            WHERE run."id" <> $1::uuid
              AND run."status" IN ('preparing', 'running', 'paused')
            FOR UPDATE OF run
          ),
          resumed_run AS (
            UPDATE "historic_backfill_run" run
            SET
              "status" = 'running',
              "pausedAt" = NULL,
              "completedAt" = NULL,
              "lastError" = NULL,
              "updatedAt" = now()
            FROM target
            WHERE run."id" = target."id"
              AND target."status" IN ('paused', 'failed')
              AND target."historicComputeEpochCurrent"
              AND target."historicBackfillGlobalEpochCurrent"
              AND NOT EXISTS (SELECT 1 FROM active_conflict)
            RETURNING run."id", run."status", target."status" AS "oldStatus"
          ),
          requeued AS (
            UPDATE "historic_backfill_task" task
            SET
              "status" = 'pending',
              "attemptCount" = CASE
                WHEN task."status" = 'failed' THEN 0
                ELSE task."attemptCount"
              END,
              "leaseOwner" = NULL,
              "leaseToken" = NULL,
              "leaseExpiresAt" = NULL,
              "heartbeatAt" = NULL,
              "nextAttemptAt" = now(),
              "completedAt" = NULL,
              "lastError" = NULL,
              "updatedAt" = now()
            FROM resumed_run
            WHERE task."runId" = resumed_run."id"
              AND task."status" IN ('failed', 'leased')
            RETURNING task."runId"
          ), artifacts_requeued AS (
            UPDATE "historic_backfill_artifact_task" task
            SET
              "status" = 'pending',
              "attemptCount" = CASE
                WHEN task."status" = 'failed' THEN 0
                ELSE task."attemptCount"
              END,
              "leaseOwner" = NULL,
              "leaseToken" = NULL,
              "leaseExpiresAt" = NULL,
              "heartbeatAt" = NULL,
              "nextAttemptAt" = now(),
              "completedAt" = NULL,
              "lastError" = NULL,
              "geojsonObjectKey" = NULL,
              "geojsonChecksum" = NULL,
              "pmtilesObjectKey" = NULL,
              "pmtilesChecksum" = NULL,
              "featureCount" = 0,
              "updatedAt" = now()
            FROM resumed_run
            WHERE task."runId" = resumed_run."id"
              AND task."status" IN ('failed', 'leased')
            RETURNING task."runId"
          )
          SELECT
            COALESCE(resumed_run."status", target."status") AS "status",
            (SELECT COUNT(*) FROM requeued) AS "requeuedCount",
            (SELECT "id" FROM active_conflict LIMIT 1) AS "conflictingRunId"
          FROM target
          LEFT JOIN resumed_run ON resumed_run."id" = target."id"
        `,
        [runId],
      ),
    );
    if (result?.conflictingRunId) {
      throw new HistoricBackfillStateError(
        `An unfinished historic backfill already exists: ${result.conflictingRunId}`,
      );
    }
    return result?.status === 'running';
  }

  async reconcileStaleRuns(): Promise<void> {
    await this.dataSource.transaction('READ COMMITTED', async (manager) => {
      await manager.query(`
        SELECT run."id"
        FROM "historic_backfill_run" run
        WHERE run."status" = 'running'
        ORDER BY run."id"
        FOR UPDATE OF run
      `);
      await manager.query(`
        WITH stale_epoch_runs AS MATERIALIZED (
          SELECT
            run."id",
            run."historicComputeEpoch" AS "previousEpoch",
            config."historicComputeEpoch" AS "currentEpoch",
            run."historicBackfillGlobalEpoch" AS "previousGlobalEpoch",
            config."historicBackfillGlobalEpoch" AS "currentGlobalEpoch",
            run."sourceRevision" AS "previousSourceRevision",
            source."publicRevision" AS "currentSourceRevision",
            (
              run."statisticsPromotedAt" IS NOT NULL
              AND statistic_state."historicDirtyFrom" IS NULL
              AND statistic_state."historicDirtyThrough" IS NULL
              AND statistic_state."historicPublishedThrough" >=
                run."dateThrough"
              AND config."computeStatsDate" >= run."dateThrough"
            ) AS "statisticsPublicationClosed",
            EXISTS (
              SELECT 1
              FROM "historic_backfill_task" task
              JOIN "historic_backfill_department_revision" revision
                ON revision."departementId" = task."departementId"
              WHERE task."runId" = run."id"
                AND task."departmentGeneration" < revision."generation"
            ) AS "hasAdvancedDepartmentGeneration",
            EXISTS (
              SELECT 1
              FROM "historic_backfill_task" task
              JOIN "historic_backfill_department_revision" revision
                ON revision."departementId" = task."departementId"
              WHERE task."runId" = run."id"
                AND task."departmentGeneration" > revision."generation"
            ) AS "hasRegressedDepartmentGeneration"
          FROM "historic_backfill_run" run
          CROSS JOIN "config" config
          CROSS JOIN "zone_publication_source_state" source
          CROSS JOIN "statistic_publication_state" statistic_state
          WHERE run."status" = 'running'
            AND config."id" = 1
            AND source."id" = 1
            AND statistic_state."id" = 1
            AND (
              run."historicComputeEpoch" <> config."historicComputeEpoch"
              OR run."historicBackfillGlobalEpoch" <>
                config."historicBackfillGlobalEpoch"
            )
            AND NOT EXISTS (
              SELECT 1
              FROM "historic_backfill_map_manifest_outbox" outbox
              WHERE outbox."runId" = run."id"
                AND outbox."status" = 'pending'
            )
        ),
        failed_global_runs AS (
          UPDATE "historic_backfill_run" run
          SET
            "status" = 'failed',
            "pausedAt" = NULL,
            "lastError" = concat(
              'Historic backfill global epoch changed from ',
              stale."previousGlobalEpoch"::text,
              ' to ',
              stale."currentGlobalEpoch"::text
            ),
            "updatedAt" = now()
          FROM stale_epoch_runs stale
          WHERE run."id" = stale."id"
            AND stale."previousGlobalEpoch" <>
              stale."currentGlobalEpoch"
          RETURNING run."id"
        ),
        released_global_tasks AS (
          UPDATE "historic_backfill_task" task
          SET
            "status" = 'pending',
            "leaseOwner" = NULL,
            "leaseToken" = NULL,
            "leaseExpiresAt" = NULL,
            "heartbeatAt" = NULL,
            "nextAttemptAt" = now(),
            "updatedAt" = now()
          FROM failed_global_runs run
          WHERE task."runId" = run."id"
            AND task."status" = 'leased'
          RETURNING task."runId"
        ),
        released_global_artifacts AS (
          UPDATE "historic_backfill_artifact_task" task
          SET
            "status" = 'pending',
            "leaseOwner" = NULL,
            "leaseToken" = NULL,
            "leaseExpiresAt" = NULL,
            "heartbeatAt" = NULL,
            "nextAttemptAt" = now(),
            "geojsonObjectKey" = NULL,
            "geojsonChecksum" = NULL,
            "pmtilesObjectKey" = NULL,
            "pmtilesChecksum" = NULL,
            "featureCount" = 0,
            "updatedAt" = now()
          FROM failed_global_runs run
          WHERE task."runId" = run."id"
            AND task."status" = 'leased'
          RETURNING task."runId"
        ),
        rebased_runs AS (
          UPDATE "historic_backfill_run" run
          SET
            "historicComputeEpoch" = stale."currentEpoch",
            "sourceRevision" = stale."currentSourceRevision",
            "statisticsPromotedAt" = CASE
              WHEN stale."statisticsPublicationClosed"
                THEN run."statisticsPromotedAt"
              ELSE NULL
            END,
            "lastError" = NULL,
            "updatedAt" = now()
          FROM stale_epoch_runs stale
          WHERE run."id" = stale."id"
            AND stale."hasAdvancedDepartmentGeneration"
            AND NOT stale."hasRegressedDepartmentGeneration"
            AND stale."previousGlobalEpoch" = stale."currentGlobalEpoch"
            AND stale."currentEpoch" > stale."previousEpoch"
            AND stale."currentSourceRevision" >= stale."previousSourceRevision"
          RETURNING run."id"
        ),
        reset_departments AS MATERIALIZED (
          SELECT
            task."runId", task."departementId",
            revision."generation" AS "currentGeneration"
          FROM "historic_backfill_task" task
          JOIN "historic_backfill_department_revision" revision
            ON revision."departementId" = task."departementId"
          JOIN rebased_runs run ON run."id" = task."runId"
          WHERE task."status" <> 'completed'
            OR task."departmentGeneration" <> revision."generation"
          FOR UPDATE OF task, revision
        ),
        purged_rebased_commune_segments AS (
          DELETE FROM "historic_backfill_commune_segment" segment
          USING reset_departments target
          WHERE segment."runId" = target."runId"
            AND segment."departementId" = target."departementId"
          RETURNING segment."runId"
        ),
        purged_rebased_department_segments AS (
          DELETE FROM "historic_backfill_department_segment" segment
          USING reset_departments target
          WHERE segment."runId" = target."runId"
            AND segment."departementId" = target."departementId"
          RETURNING segment."runId"
        ),
        purged_rebased_commune_shadow AS (
          DELETE FROM "historic_backfill_commune_shadow" shadow
          USING reset_departments target
          WHERE shadow."runId" = target."runId"
            AND shadow."departementId" = target."departementId"
          RETURNING shadow."runId"
        ),
        reset_rebased_tasks AS (
          UPDATE "historic_backfill_task" task
          SET
            "status" = 'pending',
            "departmentGeneration" = target."currentGeneration",
            "progressDate" = NULL,
            "segmentCount" = 0,
            "communeCount" = 0,
            "outputSignature" = NULL,
            "artifactPrefix" = NULL,
            "attemptCount" = 0,
            "leaseOwner" = NULL,
            "leaseToken" = NULL,
            "leaseExpiresAt" = NULL,
            "heartbeatAt" = NULL,
            "nextAttemptAt" = now(),
            "startedAt" = NULL,
            "completedAt" = NULL,
            "lastError" = NULL,
            "updatedAt" = now()
          FROM reset_departments target
          WHERE task."runId" = target."runId"
            AND task."departementId" = target."departementId"
            AND (
              (SELECT COUNT(*) FROM purged_rebased_commune_segments)
              + (SELECT COUNT(*) FROM purged_rebased_department_segments)
              + (SELECT COUNT(*) FROM purged_rebased_commune_shadow)
            ) >= 0
          RETURNING task."runId"
        ),
        deleted_rebased_artifacts AS (
          DELETE FROM "historic_backfill_artifact_task" task
          USING rebased_runs run
          WHERE task."runId" = run."id"
          RETURNING task."runId"
        ),
        paused_stale_runs AS (
          UPDATE "historic_backfill_run" run
          SET
            "status" = 'paused',
            "pausedAt" = now(),
            "lastError" = concat(
              'Historic compute epoch changed from ',
              stale."previousEpoch"::text,
              ' to ',
              stale."currentEpoch"::text
            ),
            "updatedAt" = now()
          FROM stale_epoch_runs stale
          WHERE run."id" = stale."id"
            AND stale."previousGlobalEpoch" = stale."currentGlobalEpoch"
            AND NOT (
              stale."hasAdvancedDepartmentGeneration"
              AND NOT stale."hasRegressedDepartmentGeneration"
              AND stale."currentEpoch" > stale."previousEpoch"
              AND stale."currentSourceRevision" >=
                stale."previousSourceRevision"
            )
          RETURNING run."id"
        ),
        released_paused_tasks AS (
          UPDATE "historic_backfill_task" task
          SET
            "status" = 'pending',
            "leaseOwner" = NULL,
            "leaseToken" = NULL,
            "leaseExpiresAt" = NULL,
            "heartbeatAt" = NULL,
            "nextAttemptAt" = now(),
            "updatedAt" = now()
          FROM paused_stale_runs
          WHERE task."runId" = paused_stale_runs."id"
            AND task."status" = 'leased'
          RETURNING task."runId"
        ),
        released_paused_artifacts AS (
          UPDATE "historic_backfill_artifact_task" task
          SET
            "status" = 'pending',
            "leaseOwner" = NULL,
            "leaseToken" = NULL,
            "leaseExpiresAt" = NULL,
            "heartbeatAt" = NULL,
            "nextAttemptAt" = now(),
            "geojsonObjectKey" = NULL,
            "geojsonChecksum" = NULL,
            "pmtilesObjectKey" = NULL,
            "pmtilesChecksum" = NULL,
            "featureCount" = 0,
            "updatedAt" = now()
          FROM paused_stale_runs
          WHERE task."runId" = paused_stale_runs."id"
            AND task."status" = 'leased'
          RETURNING task."runId"
        )
        SELECT
          (SELECT COUNT(*) FROM failed_global_runs) AS "failedGlobalCount",
          (
            (SELECT COUNT(*) FROM released_global_tasks)
            + (SELECT COUNT(*) FROM released_global_artifacts)
          ) AS "releasedGlobalCount",
          (SELECT COUNT(*) FROM rebased_runs) AS "rebasedCount",
          (SELECT COUNT(*) FROM reset_rebased_tasks) AS "resetTaskCount",
          (SELECT COUNT(*) FROM deleted_rebased_artifacts)
            AS "deletedArtifactCount",
          (SELECT COUNT(*) FROM paused_stale_runs) AS "pausedCount",
          (
            (SELECT COUNT(*) FROM released_paused_tasks)
            + (SELECT COUNT(*) FROM released_paused_artifacts)
          ) AS "releasedCount"
      `);
    });
  }
}
