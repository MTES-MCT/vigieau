import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { unwrapTypeOrmDmlReturningRows } from '../zone_publication/typeorm-query-result';
import {
  HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT,
  HistoricBackfillQueueService,
} from './historic-backfill-queue.service';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface HistoricBackfillArtifactLease {
  runId: string;
  validFrom: string;
  validThrough: string;
  sourceRevision: string;
  historicComputeEpoch: string;
  workerId: string;
  leaseToken: string;
  leaseExpiresAt: Date;
  attemptCount: number;
}

export interface HistoricBackfillArtifactOutput {
  geojsonObjectKey: string;
  geojsonChecksum: string;
  pmtilesObjectKey: string;
  pmtilesChecksum: string;
  featureCount: number;
}

interface ArtifactClaimRow extends Omit<
  HistoricBackfillArtifactLease,
  'attemptCount'
> {
  attemptCount: number | string;
}

function assertUuid(name: string, value: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${name} must be a UUID`);
  }
}

function normalizeWorkerId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new Error('workerId must contain between 1 and 200 characters');
  }
  return normalized;
}

function assertLease(lease: HistoricBackfillArtifactLease): void {
  assertUuid('runId', lease.runId);
  assertUuid('leaseToken', lease.leaseToken);
  normalizeWorkerId(lease.workerId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lease.validFrom)) {
    throw new Error('validFrom must use YYYY-MM-DD');
  }
  if (
    !/^\d+$/.test(lease.sourceRevision) ||
    !/^\d+$/.test(lease.historicComputeEpoch)
  ) {
    throw new Error('Artifact lease source identity is invalid');
  }
}

function assertOutput(output: HistoricBackfillArtifactOutput): void {
  for (const [name, value] of [
    ['geojsonObjectKey', output.geojsonObjectKey],
    ['pmtilesObjectKey', output.pmtilesObjectKey],
  ]) {
    if (!value.trim() || value.length > 2_048 || value.includes('..')) {
      throw new Error(`${name} is invalid`);
    }
  }
  for (const [name, value] of [
    ['geojsonChecksum', output.geojsonChecksum],
    ['pmtilesChecksum', output.pmtilesChecksum],
  ]) {
    if (!SHA256_PATTERN.test(value)) {
      throw new Error(`${name} must be a lowercase SHA-256`);
    }
  }
  if (!Number.isSafeInteger(output.featureCount) || output.featureCount < 0) {
    throw new Error('featureCount must be a non-negative integer');
  }
}

@Injectable()
export class HistoricBackfillArtifactQueueService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly historicBackfillQueue: HistoricBackfillQueueService,
  ) {}

  async findRunnableRunId(): Promise<string | null> {
    await this.historicBackfillQueue.reconcileStaleRuns();
    const [row] = (await this.dataSource.query(`
      SELECT DISTINCT task."runId"
      FROM "historic_backfill_artifact_task" task
      JOIN "historic_backfill_run" run ON run."id" = task."runId"
      JOIN "zone_publication_source_state" source ON source."id" = 1
      JOIN "config" config ON config."id" = 1
      WHERE run."status" = 'running'
        AND task."sourceRevision" = run."sourceRevision"
        AND task."sourceRevision" = source."publicRevision"
        AND task."historicComputeEpoch" = run."historicComputeEpoch"
        AND task."historicComputeEpoch" = config."historicComputeEpoch"
        AND run."historicBackfillGlobalEpoch" =
          config."historicBackfillGlobalEpoch"
        AND task."status" IN ('pending', 'leased')
      ORDER BY task."runId"
      LIMIT 1
    `)) as Array<{ runId: string }>;
    return row?.runId ?? null;
  }

  async prepare(runId: string): Promise<{ taskCount: number }> {
    assertUuid('runId', runId);
    await this.historicBackfillQueue.reconcileStaleRuns();
    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      await manager.query(
        `SELECT pg_advisory_xact_lock(hashtext('vigieau'), hashtext('historic-backfill-artifacts'))`,
      );
      await manager.query(`SET LOCAL lock_timeout = '3s'`);
      const [context] = (await manager.query(
        `
          SELECT
            run."status",
            run."mapDateFrom",
            run."dateThrough",
            run."sourceRevision"::text AS "sourceRevision",
            source."publicRevision"::text AS "currentSourceRevision",
            source."legacyDualWrite" AS "legacyDualWrite",
            run."historicComputeEpoch"::text AS "historicComputeEpoch",
            config."historicComputeEpoch"::text AS "currentEpoch",
            run."historicBackfillGlobalEpoch"::text
              AS "historicBackfillGlobalEpoch",
            config."historicBackfillGlobalEpoch"::text AS "currentGlobalEpoch"
          FROM "historic_backfill_run" run
          CROSS JOIN "zone_publication_source_state" source
          CROSS JOIN "config" config
          WHERE run."id" = $1 AND source."id" = 1 AND config."id" = 1
          FOR UPDATE OF run, source, config
        `,
        [runId],
      )) as Array<{
        status: string;
        mapDateFrom: string;
        dateThrough: string;
        sourceRevision: string;
        currentSourceRevision: string;
        legacyDualWrite: boolean;
        historicComputeEpoch: string;
        currentEpoch: string;
        historicBackfillGlobalEpoch: string;
        currentGlobalEpoch: string;
      }>;
      if (!context || context.status !== 'running') {
        throw new Error('Historic backfill run is not running');
      }
      if (context.historicComputeEpoch !== context.currentEpoch) {
        throw new Error('Historic compute epoch changed');
      }
      if (context.historicBackfillGlobalEpoch !== context.currentGlobalEpoch) {
        throw new Error('Historic backfill global epoch changed');
      }
      if (context.sourceRevision !== context.currentSourceRevision) {
        throw new Error('Historic source revision changed');
      }
      if (context.legacyDualWrite) {
        throw new Error(
          'Historic backfill requires separated public revisions',
        );
      }
      const [tasks] = (await manager.query(
        `SELECT
           COUNT(*)::integer AS "taskCount",
           COUNT(*) FILTER (
             WHERE task."status" = 'completed'
               AND task."departmentGeneration" = revision."generation"
           )::integer AS "completedCount"
         FROM "historic_backfill_task" task
         JOIN "historic_backfill_department_revision" revision
           ON revision."departementId" = task."departementId"
         WHERE task."runId" = $1`,
        [runId],
      )) as Array<{ taskCount: number; completedCount: number }>;
      if (
        Number(tasks.taskCount) !==
          HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT ||
        Number(tasks.completedCount) !==
          HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT
      ) {
        throw new Error(
          'Department backfill tasks are not complete and current',
        );
      }

      const [priority] = (await manager.query(`
        SELECT
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
            AS "queueCount",
          (SELECT COUNT(*)::integer FROM "statistic_commune_snapshot"
             WHERE "status" = 'running') AS "snapshotCount",
          (SELECT COUNT(*)::integer FROM "external_publication_run"
             WHERE "jobKey" = 'compute:national-daily'
               AND "status" = 'running') AS "dailyRunCount"
      `)) as Array<{
        queueCount: number;
        snapshotCount: number;
        dailyRunCount: number;
      }>;
      if (
        Number(priority.queueCount) !== 0 ||
        Number(priority.snapshotCount) !== 0 ||
        Number(priority.dailyRunCount) !== 0
      ) {
        throw new Error(
          'Current computation has priority over historic artifacts',
        );
      }

      const [segmentState] = (await manager.query(
        `SELECT COUNT(DISTINCT "departementId")::integer AS "departmentCount"
         FROM "historic_backfill_department_segment" WHERE "runId" = $1`,
        [runId],
      )) as Array<{ departmentCount: number }>;
      if (
        Number(segmentState.departmentCount) !==
        HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT
      ) {
        throw new Error('Department artifact segments are incomplete');
      }

      const discontinuities = (await manager.query(
        `
          WITH ordered AS (
            SELECT
              segment."departementId",
              segment."validFrom",
              segment."validThrough",
              lag(segment."validThrough") OVER (
                PARTITION BY segment."departementId"
                ORDER BY segment."validFrom"
              ) AS previous_through,
              min(segment."validFrom") OVER (
                PARTITION BY segment."departementId"
              ) AS first_date,
              max(segment."validThrough") OVER (
                PARTITION BY segment."departementId"
              ) AS last_date
            FROM "historic_backfill_department_segment" segment
            WHERE segment."runId" = $1
          )
          SELECT "departementId", "validFrom"
          FROM ordered
          WHERE first_date <> $2::date
             OR last_date <> $3::date
             OR (
               previous_through IS NOT NULL
               AND "validFrom" <> previous_through + 1
             )
          LIMIT 1
        `,
        [runId, context.mapDateFrom, context.dateThrough],
      )) as Array<{ departementId: number; validFrom: string }>;
      if (discontinuities.length > 0) {
        throw new Error(
          `Department artifact coverage is not contiguous for ${discontinuities[0].departementId}`,
        );
      }

      await manager.query(
        `WITH boundaries AS (
           SELECT DISTINCT segment."validFrom"
           FROM "historic_backfill_department_segment" segment
           WHERE segment."runId" = $1
         ), ranges AS (
           SELECT
             boundary."validFrom",
             COALESCE(
               lead(boundary."validFrom") OVER (ORDER BY boundary."validFrom") - 1,
               $2::date
             ) AS "validThrough"
           FROM boundaries boundary
         )
         DELETE FROM "historic_backfill_artifact_task" task
         WHERE task."runId" = $1
           AND NOT EXISTS (
             SELECT 1
             FROM ranges
             WHERE ranges."validFrom" = task."validFrom"
               AND ranges."validThrough" = task."validThrough"
               AND task."sourceRevision" = $3::bigint
               AND task."historicComputeEpoch" = $4::bigint
           )`,
        [
          runId,
          context.dateThrough,
          context.sourceRevision,
          context.historicComputeEpoch,
        ],
      );

      await manager.query(
        `
          WITH boundaries AS (
            SELECT DISTINCT segment."validFrom"
            FROM "historic_backfill_department_segment" segment
            WHERE segment."runId" = $1
          ), ranges AS (
            SELECT
              boundary."validFrom",
              COALESCE(
                lead(boundary."validFrom") OVER (ORDER BY boundary."validFrom") - 1,
                $2::date
              ) AS "validThrough"
            FROM boundaries boundary
          )
          INSERT INTO "historic_backfill_artifact_task" (
            "runId", "validFrom", "validThrough", "sourceRevision",
            "historicComputeEpoch", "status"
          )
          SELECT $1, ranges."validFrom", ranges."validThrough",
                 $3::bigint, $4::bigint, 'pending'
          FROM ranges
          ON CONFLICT ("runId", "validFrom") DO NOTHING
        `,
        [
          runId,
          context.dateThrough,
          context.sourceRevision,
          context.historicComputeEpoch,
        ],
      );

      const [result] = (await manager.query(
        `SELECT COUNT(*)::integer AS count
         FROM "historic_backfill_artifact_task" WHERE "runId" = $1`,
        [runId],
      )) as Array<{ count: number }>;
      return { taskCount: Number(result.count) };
    });
  }

  async claim(
    runId: string,
    workerId: string,
    leaseSeconds: number,
    maxAttempts: number,
  ): Promise<HistoricBackfillArtifactLease | null> {
    assertUuid('runId', runId);
    const normalizedWorkerId = normalizeWorkerId(workerId);
    if (
      !Number.isInteger(leaseSeconds) ||
      leaseSeconds < 10 ||
      leaseSeconds > 3_600
    ) {
      throw new Error('leaseSeconds must be between 10 and 3600');
    }
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error('maxAttempts must be a positive integer');
    }
    await this.historicBackfillQueue.reconcileStaleRuns();
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      const leaseToken = randomUUID();
      const rows = unwrapTypeOrmDmlReturningRows<ArtifactClaimRow>(
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
                  SELECT 1 FROM "statistic_commune_snapshot"
                  WHERE "status" = 'running'
                )
                OR EXISTS (
                  SELECT 1
                  FROM "external_publication_run" daily_run
                  WHERE daily_run."jobKey" = 'compute:national-daily'
                    AND daily_run."status" = 'running'
                )
              ) AS "currentWorkActive"
            ), exhausted_candidate AS MATERIALIZED (
              SELECT task."validFrom"
              FROM "historic_backfill_artifact_task" task
              JOIN "historic_backfill_run" run ON run."id" = task."runId"
              JOIN "config" config ON config."id" = 1
              JOIN "zone_publication_source_state" source ON source."id" = 1
              WHERE task."runId" = $1
                AND run."status" = 'running'
                AND task."sourceRevision" = run."sourceRevision"
                AND task."sourceRevision" = source."publicRevision"
                AND task."historicComputeEpoch" = run."historicComputeEpoch"
                AND run."historicComputeEpoch" = config."historicComputeEpoch"
                AND run."historicBackfillGlobalEpoch" =
                  config."historicBackfillGlobalEpoch"
                AND NOT EXISTS (
                  SELECT 1 FROM priority WHERE priority."currentWorkActive"
                )
                AND task."attemptCount" >= $5::integer
                AND (
                  (task."status" = 'pending' AND task."nextAttemptAt" <= now())
                  OR (
                    task."status" = 'leased'
                    AND task."leaseExpiresAt" <= now()
                  )
                )
              ORDER BY task."nextAttemptAt", task."validFrom"
              FOR UPDATE OF task SKIP LOCKED
              LIMIT 100
            ), exhausted AS (
              UPDATE "historic_backfill_artifact_task" task
              SET "status" = 'failed',
                  "leaseOwner" = NULL,
                  "leaseToken" = NULL,
                  "leaseExpiresAt" = NULL,
                  "completedAt" = NULL,
                  "lastError" = COALESCE(
                    task."lastError",
                    'Maximum historic artifact attempts exhausted'
                  ),
                  "updatedAt" = now()
              FROM exhausted_candidate candidate
              WHERE task."runId" = $1
                AND task."validFrom" = candidate."validFrom"
              RETURNING task."runId"
            ), failed_runs AS (
              UPDATE "historic_backfill_run" run
              SET "status" = 'failed',
                  "lastError" = 'At least one artifact exhausted its attempts',
                  "updatedAt" = now()
              WHERE run."status" = 'running'
                AND run."id" IN (SELECT "runId" FROM exhausted)
              RETURNING run."id"
            ), candidate AS MATERIALIZED (
              SELECT task."validFrom"
              FROM "historic_backfill_artifact_task" task
              JOIN "historic_backfill_run" run ON run."id" = task."runId"
              JOIN "config" config ON config."id" = 1
              JOIN "zone_publication_source_state" source ON source."id" = 1
              WHERE task."runId" = $1
                AND run."status" = 'running'
                AND task."sourceRevision" = run."sourceRevision"
                AND task."sourceRevision" = source."publicRevision"
                AND task."historicComputeEpoch" = run."historicComputeEpoch"
                AND run."historicComputeEpoch" = config."historicComputeEpoch"
                AND run."historicBackfillGlobalEpoch" =
                  config."historicBackfillGlobalEpoch"
                AND (
                  task."status" = 'pending'
                  OR (task."status" = 'leased' AND task."leaseExpiresAt" <= now())
                )
                AND task."nextAttemptAt" <= now()
                AND NOT EXISTS (
                  SELECT 1 FROM priority WHERE priority."currentWorkActive"
                )
                AND NOT EXISTS (
                  SELECT 1 FROM failed_runs WHERE failed_runs."id" = run."id"
                )
                AND task."attemptCount" < $5::integer
              ORDER BY task."validFrom"
              FOR UPDATE OF task SKIP LOCKED
              LIMIT 1
            )
            UPDATE "historic_backfill_artifact_task" task
            SET "status" = 'leased',
                "leaseOwner" = $2,
                "leaseToken" = $3,
                "leaseExpiresAt" = now() + make_interval(secs => $4),
                "heartbeatAt" = now(),
                "startedAt" = COALESCE(task."startedAt", now()),
                "attemptCount" = task."attemptCount" + 1,
                "lastError" = NULL,
                "updatedAt" = now()
            FROM candidate
            WHERE task."runId" = $1
              AND task."validFrom" = candidate."validFrom"
            RETURNING task."runId",
              task."validFrom"::text AS "validFrom",
              task."validThrough"::text AS "validThrough",
              task."sourceRevision"::text AS "sourceRevision",
              task."historicComputeEpoch"::text AS "historicComputeEpoch",
              task."leaseOwner" AS "workerId", task."leaseToken",
              task."leaseExpiresAt", task."attemptCount"
          `,
          [runId, normalizedWorkerId, leaseToken, leaseSeconds, maxAttempts],
        ),
      );
      if (!rows[0]) {
        return null;
      }
      return { ...rows[0], attemptCount: Number(rows[0].attemptCount) };
    });
  }

  async heartbeat(
    lease: HistoricBackfillArtifactLease,
    leaseSeconds: number,
  ): Promise<boolean> {
    assertLease(lease);
    const rows = unwrapTypeOrmDmlReturningRows<{ validFrom: string }>(
      await this.dataSource.query(
        `UPDATE "historic_backfill_artifact_task" task
         SET "heartbeatAt" = now(),
             "leaseExpiresAt" = now() + make_interval(secs => $5),
             "updatedAt" = now()
         WHERE task."runId" = $1 AND task."validFrom" = $2
           AND task."status" = 'leased' AND task."leaseOwner" = $3
           AND task."leaseToken" = $4 AND task."leaseExpiresAt" > now()
           AND task."sourceRevision" = $6::bigint
           AND task."historicComputeEpoch" = $7::bigint
           AND EXISTS (
             SELECT 1 FROM "historic_backfill_run" run
             JOIN "config" config ON config."id" = 1
             JOIN "zone_publication_source_state" source ON source."id" = 1
             WHERE run."id" = $1 AND run."status" = 'running'
               AND run."sourceRevision" = task."sourceRevision"
               AND source."publicRevision" = run."sourceRevision"
               AND run."historicComputeEpoch" = task."historicComputeEpoch"
               AND run."historicComputeEpoch" = config."historicComputeEpoch"
               AND run."historicBackfillGlobalEpoch" =
                 config."historicBackfillGlobalEpoch"
           )
         RETURNING task."validFrom"`,
        [
          lease.runId,
          lease.validFrom,
          lease.workerId,
          lease.leaseToken,
          leaseSeconds,
          lease.sourceRevision,
          lease.historicComputeEpoch,
        ],
      ),
    );
    return rows.length === 1;
  }

  async complete(
    lease: HistoricBackfillArtifactLease,
    output: HistoricBackfillArtifactOutput,
  ): Promise<boolean> {
    assertLease(lease);
    assertOutput(output);
    return this.mutateLease(
      lease,
      `"status" = 'completed', "geojsonObjectKey" = $5,
       "geojsonChecksum" = $6, "pmtilesObjectKey" = $7,
       "pmtilesChecksum" = $8, "featureCount" = $9,
       "completedAt" = now(), "lastError" = NULL,
       "leaseOwner" = NULL, "leaseToken" = NULL, "leaseExpiresAt" = NULL`,
      [
        output.geojsonObjectKey,
        output.geojsonChecksum,
        output.pmtilesObjectKey,
        output.pmtilesChecksum,
        output.featureCount,
      ],
    );
  }

  async fail(
    lease: HistoricBackfillArtifactLease,
    error: unknown,
    maxAttempts: number,
    retryDelaySeconds: number,
  ): Promise<boolean> {
    assertLease(lease);
    const terminal = lease.attemptCount >= maxAttempts;
    const message = String(
      error instanceof Error ? error.message : error,
    ).slice(0, 8_000);
    if (!terminal) {
      return this.mutateLease(
        lease,
        `"status" = 'pending', "lastError" = $5,
         "nextAttemptAt" = now() + make_interval(secs => $6),
         "leaseOwner" = NULL, "leaseToken" = NULL, "leaseExpiresAt" = NULL`,
        [message, retryDelaySeconds],
      );
    }
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      const accepted = await this.mutateLease(
        lease,
        `"status" = 'failed', "lastError" = $5,
         "nextAttemptAt" = now() + make_interval(secs => $6),
         "leaseOwner" = NULL, "leaseToken" = NULL, "leaseExpiresAt" = NULL`,
        [message, retryDelaySeconds],
        manager,
      );
      if (accepted) {
        await manager.query(
          `UPDATE "historic_backfill_run"
           SET "status" = 'failed',
               "lastError" = 'At least one artifact exhausted its attempts',
               "updatedAt" = now()
           WHERE "id" = $1::uuid AND "status" = 'running'`,
          [lease.runId],
        );
      }
      return accepted;
    });
  }

  async yieldTask(
    lease: HistoricBackfillArtifactLease,
    delaySeconds: number,
  ): Promise<boolean> {
    assertLease(lease);
    return this.mutateLease(
      lease,
      `"status" = 'pending', "attemptCount" = GREATEST("attemptCount" - 1, 0),
       "nextAttemptAt" = now() + make_interval(secs => $5),
       "leaseOwner" = NULL, "leaseToken" = NULL, "leaseExpiresAt" = NULL`,
      [delaySeconds],
    );
  }

  private async mutateLease(
    lease: HistoricBackfillArtifactLease,
    assignments: string,
    values: unknown[],
    executor: Pick<DataSource, 'query'> = this.dataSource,
  ): Promise<boolean> {
    const sourceRevisionIndex = 5 + values.length;
    const historicComputeEpochIndex = sourceRevisionIndex + 1;
    const rows = unwrapTypeOrmDmlReturningRows<{ validFrom: string }>(
      await executor.query(
        `UPDATE "historic_backfill_artifact_task" task
         SET ${assignments}, "updatedAt" = now()
         WHERE task."runId" = $1 AND task."validFrom" = $2
           AND task."status" = 'leased' AND task."leaseOwner" = $3
           AND task."leaseToken" = $4 AND task."leaseExpiresAt" > now()
           AND task."sourceRevision" = $${sourceRevisionIndex}::bigint
           AND task."historicComputeEpoch" = $${historicComputeEpochIndex}::bigint
           AND EXISTS (
             SELECT 1
             FROM "historic_backfill_run" run
             JOIN "zone_publication_source_state" source ON source."id" = 1
             JOIN "config" config ON config."id" = 1
             WHERE run."id" = task."runId"
               AND run."status" = 'running'
               AND run."sourceRevision" = task."sourceRevision"
               AND source."publicRevision" = run."sourceRevision"
               AND run."historicComputeEpoch" = task."historicComputeEpoch"
               AND config."historicComputeEpoch" = run."historicComputeEpoch"
               AND run."historicBackfillGlobalEpoch" =
                 config."historicBackfillGlobalEpoch"
           )
         RETURNING task."validFrom"`,
        [
          lease.runId,
          lease.validFrom,
          lease.workerId,
          lease.leaseToken,
          ...values,
          lease.sourceRevision,
          lease.historicComputeEpoch,
        ],
      ),
    );
    return rows.length === 1;
  }

  async getOutputSegments(
    manager: EntityManager,
    lease: HistoricBackfillArtifactLease,
  ): Promise<
    Array<{
      departementId: number;
      geojsonObjectKey: string;
      geojsonChecksum: string;
      featureCount: number;
    }>
  > {
    assertLease(lease);
    return manager.query(
      `SELECT segment."departementId", segment."geojsonObjectKey",
              segment."geojsonChecksum", segment."featureCount"
       FROM "historic_backfill_department_segment" segment
       JOIN "historic_backfill_task" task
         ON task."runId" = segment."runId"
        AND task."departementId" = segment."departementId"
       JOIN "historic_backfill_department_revision" revision
         ON revision."departementId" = segment."departementId"
       JOIN "historic_backfill_run" run ON run."id" = segment."runId"
       JOIN "zone_publication_source_state" source ON source."id" = 1
       JOIN "config" config ON config."id" = 1
       WHERE segment."runId" = $1
         AND segment."validFrom" <= $2::date
         AND segment."validThrough" >= $2::date
         AND task."status" = 'completed'
         AND task."departmentGeneration" = revision."generation"
         AND segment."sourceGeneration" = revision."generation"
         AND run."sourceRevision" = $3::bigint
         AND source."publicRevision" = run."sourceRevision"
         AND run."historicComputeEpoch" = $4::bigint
         AND config."historicComputeEpoch" = run."historicComputeEpoch"
         AND run."historicBackfillGlobalEpoch" =
           config."historicBackfillGlobalEpoch"
       ORDER BY segment."departementId"`,
      [
        lease.runId,
        lease.validFrom,
        lease.sourceRevision,
        lease.historicComputeEpoch,
      ],
    );
  }
}
