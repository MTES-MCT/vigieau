import { DataSource } from 'typeorm';
import { HistoricBackfillControlPlane1787144400000 } from '../migrations/1787144400000-HistoricBackfillControlPlane';
import { HistoricBackfillArtifactQueueService } from './historic-backfill-artifact-queue.service';
import { HistoricBackfillQueueService } from './historic-backfill-queue.service';
import {
  HistoricBackfillLeaseIdentity,
  HistoricBackfillTaskClaim,
} from './historic-backfill.types';

const postgresUrl = process.env.HISTORIC_BACKFILL_POSTGRES_URL;
const describePostgres = postgresUrl ? describe : describe.skip;
const SHA256 = 'a'.repeat(64);
const PARTIAL_SHA256 = 'b'.repeat(64);
const RETRY_SHA256 = 'c'.repeat(64);

function leaseIdentity(
  claim: HistoricBackfillTaskClaim,
): HistoricBackfillLeaseIdentity {
  return {
    runId: claim.runId,
    departementId: claim.departementId,
    workerId: claim.workerId,
    leaseToken: claim.leaseToken,
  };
}

describePostgres('historic backfill PostgreSQL integration', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url: postgresUrl,
      ssl: false,
      extra: { max: 8 },
    });
    await dataSource.initialize();

    await dataSource.query(`CREATE EXTENSION IF NOT EXISTS postgis`);
    await dataSource.query(`
      CREATE TABLE "departement" (
        "id" integer PRIMARY KEY,
        "code" varchar(3) NOT NULL UNIQUE
      )
    `);
    await dataSource.query(`
      CREATE TABLE "commune" (
        "id" integer PRIMARY KEY
      )
    `);
    await dataSource.query(`
      CREATE TABLE "config" (
        "id" integer PRIMARY KEY,
        "computeMapDate" date,
        "computeStatsDate" date,
        "historicComputeEpoch" bigint NOT NULL
      )
    `);
    await dataSource.query(`
      CREATE TABLE "zone_publication_source_state" (
        "id" integer PRIMARY KEY,
        "publicRevision" bigint NOT NULL,
        "legacyDualWrite" boolean NOT NULL DEFAULT false
      )
    `);
    await dataSource.query(`
      CREATE TABLE "statistic_publication_state" (
        "id" integer PRIMARY KEY,
        "revision" bigint NOT NULL,
        "currentPublishedDate" date,
        "historicDirtyFrom" date,
        "historicDirtyThrough" date,
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await dataSource.query(`
      CREATE TABLE "current_zone_recompute_request" (
        "id" bigserial PRIMARY KEY,
        "currentPending" boolean NOT NULL DEFAULT false,
        "pendingScheduledDates" date[] NOT NULL DEFAULT '{}'
      )
    `);
    await dataSource.query(`
      CREATE TABLE "statistic_commune_snapshot" (
        "id" bigserial PRIMARY KEY,
        "status" varchar(20) NOT NULL
      )
    `);
    await dataSource.query(`
      CREATE TABLE "external_publication_run" (
        "jobKey" varchar(200) NOT NULL,
        "status" varchar(20) NOT NULL
      )
    `);
    await dataSource.query(`
      INSERT INTO "departement" ("id", "code")
      SELECT id, lpad(id::text, 3, '0')
      FROM generate_series(1, 101) id
    `);
    await dataSource.query(`
      INSERT INTO "commune" ("id")
      SELECT id FROM generate_series(1, 101) id
    `);
    await dataSource.query(`
      INSERT INTO "config" (
        "id", "computeMapDate", "computeStatsDate", "historicComputeEpoch"
      ) VALUES (1, '2024-04-29', '2024-04-29', 7)
    `);
    await dataSource.query(`
      INSERT INTO "zone_publication_source_state" ("id", "publicRevision")
      VALUES (1, 1)
    `);
    await dataSource.query(`
      INSERT INTO "statistic_publication_state" (
        "id", "revision", "currentPublishedDate",
        "historicDirtyFrom", "historicDirtyThrough"
      ) VALUES (1, 11, '2024-05-03', '2024-04-29', '2024-05-02')
    `);

    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await new HistoricBackfillControlPlane1787144400000().up(queryRunner);
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }, 60_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('validates migration, concurrent claims, anti-ABA, rebase and artifact coverage', async () => {
    const queue = new HistoricBackfillQueueService(dataSource);
    const artifactQueue = new HistoricBackfillArtifactQueueService(
      dataSource,
      queue,
    );

    const [database, migratedTables, revisionCount, invalidConstraints] =
      await Promise.all([
        dataSource.query(
          `SELECT current_setting('server_version_num')::integer AS version,
                  postgis_version() AS postgis`,
        ),
        dataSource.query(`
          SELECT COUNT(*)::integer AS count
          FROM information_schema.tables
          WHERE table_schema = current_schema()
            AND table_name LIKE 'historic_backfill_%'
        `),
        dataSource.query(`
          SELECT COUNT(*)::integer AS count
          FROM "historic_backfill_department_revision"
        `),
        dataSource.query(`
          SELECT COUNT(*)::integer AS count
          FROM pg_constraint
          WHERE connamespace = current_schema()::regnamespace
            AND conname LIKE '%historic_backfill%'
            AND NOT convalidated
        `),
      ]);

    expect(database[0].version).toBeGreaterThanOrEqual(170_000);
    expect(database[0].postgis).toBeTruthy();
    expect(migratedTables[0].count).toBe(8);
    expect(revisionCount[0].count).toBe(101);
    expect(invalidConstraints[0].count).toBe(0);

    const run = await queue.prepare({
      mapDateFrom: '2024-04-29',
      statisticDateFrom: '2024-04-29',
      dateThrough: '2024-05-02',
    });
    const prepared = await queue.status(run.id);
    expect(prepared?.tasks.total).toBe(101);
    expect(prepared?.tasks.pending).toBe(101);
    expect(run.baseStatisticRevision).toBe('11');

    await dataSource.query(
      `UPDATE "historic_backfill_run"
       SET "status" = 'completed', "completedAt" = now()
       WHERE "id" = $1`,
      [run.id],
    );
    await dataSource.query(`
      UPDATE "statistic_publication_state"
      SET "historicDirtyFrom" = NULL, "historicDirtyThrough" = NULL
      WHERE "id" = 1
    `);
    await dataSource.query(`
      UPDATE "config"
      SET "computeMapDate" = '2024-05-01',
          "computeStatsDate" = '2024-05-01',
          "historicComputeEpoch" = 8
      WHERE "id" = 1
    `);
    const resumedRun = await queue.prepare({
      mapDateFrom: '2024-04-29',
      statisticDateFrom: '2024-04-29',
      dateThrough: '2024-05-02',
    });
    const [resumedDebt] = await dataSource.query(`
      SELECT "revision"::text AS "revision",
             "historicDirtyFrom"::text AS "historicDirtyFrom",
             "historicDirtyThrough"::text AS "historicDirtyThrough"
      FROM "statistic_publication_state" WHERE "id" = 1
    `);
    expect(resumedRun.baseStatisticRevision).toBe('12');
    expect(resumedDebt).toEqual({
      revision: '12',
      historicDirtyFrom: '2024-05-01',
      historicDirtyThrough: '2024-05-02',
    });
    await dataSource.query(
      `DELETE FROM "historic_backfill_run" WHERE "id" = $1`,
      [resumedRun.id],
    );
    await dataSource.query(
      `UPDATE "historic_backfill_run"
       SET "status" = 'running', "completedAt" = NULL
       WHERE "id" = $1`,
      [run.id],
    );
    await dataSource.query(`
      UPDATE "config"
      SET "computeMapDate" = '2024-04-29',
          "computeStatsDate" = '2024-04-29',
          "historicComputeEpoch" = 7
      WHERE "id" = 1
    `);
    await dataSource.query(`
      UPDATE "statistic_publication_state"
      SET "revision" = 11,
          "historicDirtyFrom" = '2024-04-29',
          "historicDirtyThrough" = '2024-05-02'
      WHERE "id" = 1
    `);

    await dataSource.query(
      `UPDATE "historic_backfill_task"
       SET "status" = 'completed', "progressDate" = '2024-05-02',
           "segmentCount" = 1, "communeCount" = 1,
           "outputSignature" = $2, "artifactPrefix" = 'preserved',
           "completedAt" = now()
       WHERE "runId" = $1`,
      [run.id, SHA256],
    );
    await dataSource.query(
      `INSERT INTO "historic_backfill_department_segment" (
         "runId", "departementId", "validFrom", "validThrough",
         "sourceGeneration", "inputSignature", "restriction", "situation",
         "geojsonObjectKey", "geojsonChecksum", "featureCount"
       ) SELECT $1, id, '2024-04-29', '2024-05-02', 0, $2, '{}', '{}',
                'department/' || id || '.geojson', $2, 1
         FROM "departement" WHERE "id" IN (1, 3)`,
      [run.id, SHA256],
    );
    await dataSource.query(
      `INSERT INTO "historic_backfill_commune_shadow" (
         "runId", "communeId", "departementId", "sourceGeneration",
         "restrictions", "restrictionsByMonth"
       ) SELECT $1, id, id, 0, '[]', '[]'
         FROM "departement" WHERE "id" IN (1, 3)`,
      [run.id],
    );
    await dataSource.query(
      `UPDATE "config" SET "historicComputeEpoch" = 8 WHERE "id" = 1`,
    );
    await dataSource.query(
      `UPDATE "zone_publication_source_state"
       SET "publicRevision" = 2 WHERE "id" = 1`,
    );
    await dataSource.query(
      `UPDATE "historic_backfill_department_revision"
       SET "generation" = 1, "lastPublicRevision" = 2
       WHERE "departementId" = 1`,
    );

    await expect(artifactQueue.prepare(run.id)).rejects.toThrow(
      'Department backfill tasks are not complete and current',
    );
    const [localRebaseState] = await dataSource.query(
      `SELECT
         run."status", run."sourceRevision"::text AS "sourceRevision",
         run."historicComputeEpoch"::text AS "historicComputeEpoch",
         stale."status" AS "staleStatus",
         stale."leaseOwner" AS "staleLeaseOwner",
         preserved."status" AS "preservedStatus",
         (SELECT COUNT(*)::integer
            FROM "historic_backfill_department_segment" segment
            WHERE segment."runId" = run."id"
              AND segment."departementId" = 1) AS "staleSegmentCount",
         (SELECT COUNT(*)::integer
            FROM "historic_backfill_department_segment" segment
            WHERE segment."runId" = run."id"
              AND segment."departementId" = 3) AS "preservedSegmentCount",
         (SELECT COUNT(*)::integer
            FROM "historic_backfill_commune_shadow" shadow
            WHERE shadow."runId" = run."id"
              AND shadow."departementId" = 3) AS "preservedShadowCount"
       FROM "historic_backfill_run" run
       JOIN "historic_backfill_task" stale
         ON stale."runId" = run."id" AND stale."departementId" = 1
       JOIN "historic_backfill_task" preserved
         ON preserved."runId" = run."id" AND preserved."departementId" = 3
       WHERE run."id" = $1`,
      [run.id],
    );
    expect(localRebaseState).toMatchObject({
      status: 'running',
      sourceRevision: '2',
      historicComputeEpoch: '8',
      staleStatus: 'pending',
      staleLeaseOwner: null,
      preservedStatus: 'completed',
      staleSegmentCount: 0,
      preservedSegmentCount: 1,
      preservedShadowCount: 1,
    });
    const locallyRebased = await queue.claim('epoch-rebase-worker', 30, 5);
    expect(locallyRebased).toMatchObject({
      departementId: 1,
      departmentGeneration: '1',
      sourceRevision: '2',
      historicComputeEpoch: '8',
    });

    await dataSource.query(
      `DELETE FROM "historic_backfill_department_segment" WHERE "runId" = $1`,
      [run.id],
    );
    await dataSource.query(
      `DELETE FROM "historic_backfill_commune_shadow" WHERE "runId" = $1`,
      [run.id],
    );
    await dataSource.query(
      `UPDATE "historic_backfill_task"
       SET "status" = 'pending', "departmentGeneration" = 0,
           "progressDate" = NULL, "segmentCount" = 0, "communeCount" = 0,
           "outputSignature" = NULL, "artifactPrefix" = NULL,
           "attemptCount" = 0, "leaseOwner" = NULL, "leaseToken" = NULL,
           "leaseExpiresAt" = NULL, "heartbeatAt" = NULL,
           "startedAt" = NULL, "completedAt" = NULL, "lastError" = NULL,
           "nextAttemptAt" = now()
       WHERE "runId" = $1`,
      [run.id],
    );
    await dataSource.query(`
      UPDATE "historic_backfill_department_revision"
      SET "generation" = 0, "lastPublicRevision" = 1
    `);
    await dataSource.query(
      `UPDATE "historic_backfill_department_revision"
       SET "generation" = 1, "lastPublicRevision" = 2
       WHERE "departementId" = 1`,
    );
    await dataSource.query(`
      UPDATE "zone_publication_source_state"
      SET "publicRevision" = 2 WHERE "id" = 1
    `);
    await dataSource.query(
      `UPDATE "config"
       SET "historicComputeEpoch" = 8,
           "historicBackfillGlobalEpoch" = 1
       WHERE "id" = 1`,
    );
    await dataSource.query(
      `UPDATE "historic_backfill_run"
       SET "sourceRevision" = 1, "historicComputeEpoch" = 7,
           "historicBackfillGlobalEpoch" = 0,
           "status" = 'running', "pausedAt" = NULL, "lastError" = NULL
       WHERE "id" = $1`,
      [run.id],
    );
    await expect(queue.claim('epoch-cutoff-worker', 30, 5)).resolves.toBeNull();
    const [epochCutoff] = await dataSource.query(
      `SELECT "status", "sourceRevision"::text AS "sourceRevision",
              "historicComputeEpoch"::text AS "historicComputeEpoch",
              "historicBackfillGlobalEpoch"::text
                AS "historicBackfillGlobalEpoch"
       FROM "historic_backfill_run" WHERE "id" = $1`,
      [run.id],
    );
    expect(epochCutoff).toEqual({
      status: 'failed',
      sourceRevision: '1',
      historicComputeEpoch: '7',
      historicBackfillGlobalEpoch: '0',
    });
    await dataSource.query(`
      UPDATE "historic_backfill_department_revision"
      SET "generation" = 0, "lastPublicRevision" = 1
    `);
    await dataSource.query(`
      UPDATE "zone_publication_source_state"
      SET "publicRevision" = 1 WHERE "id" = 1
    `);
    await dataSource.query(
      `UPDATE "historic_backfill_run"
       SET "status" = 'running', "pausedAt" = NULL, "lastError" = NULL
       WHERE "id" = $1`,
      [run.id],
    );
    await dataSource.query(
      `UPDATE "config"
       SET "historicComputeEpoch" = 7,
           "historicBackfillGlobalEpoch" = 0
       WHERE "id" = 1`,
    );

    const promotedAt = new Date('2026-08-20T10:00:00.000Z');
    await dataSource.query(
      `UPDATE "historic_backfill_run"
       SET "statisticsPromotedAt" = $2
       WHERE "id" = $1`,
      [run.id, promotedAt],
    );
    await dataSource.query(
      `UPDATE "zone_publication_source_state"
       SET "publicRevision" = 2 WHERE "id" = 1`,
    );
    await dataSource.query(
      `UPDATE "historic_backfill_department_revision"
       SET "generation" = 1, "lastPublicRevision" = 2
       WHERE "departementId" = 1`,
    );
    await dataSource.query(
      `UPDATE "historic_backfill_task"
       SET "attemptCount" = 5
       WHERE "runId" = $1 AND "departementId" = 2`,
      [run.id],
    );
    const publicationRunner = dataSource.createQueryRunner();
    await publicationRunner.connect();
    let frozenClaim: Promise<unknown> | undefined;
    let claimSettled = false;
    let blockedBeforePublicationCommit = false;
    try {
      await publicationRunner.startTransaction('SERIALIZABLE');
      await publicationRunner.query(
        `SELECT run."id"
         FROM "historic_backfill_run" run
         WHERE run."id" = $1
         FOR UPDATE OF run`,
        [run.id],
      );
      await publicationRunner.query(
        `INSERT INTO "historic_backfill_map_manifest_outbox" (
           "runId", "status", "mapDateFrom", "dateThrough",
           "sourceRevision", "historicComputeEpoch", "mapGeneration",
           "statisticRevision", "artifactTaskCount", "dayCount",
           "manifestObjectKey", "manifestBody", "manifestChecksum"
         ) VALUES (
           $1, 'pending', '2024-04-29', '2024-05-02',
           1, 7, 1, 11, 1, 4,
           'pmtiles/historic-backfill-manifest.json', '{}', $2
         )`,
        [run.id, SHA256],
      );

      frozenClaim = queue.claim('frozen-historic-worker', 30, 5).finally(() => {
        claimSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      blockedBeforePublicationCommit = !claimSettled;
      await publicationRunner.commitTransaction();
    } finally {
      if (publicationRunner.isTransactionActive) {
        await publicationRunner.rollbackTransaction();
      }
      await publicationRunner.release();
    }

    expect(blockedBeforePublicationCommit).toBe(true);
    await expect(frozenClaim).resolves.toBeNull();
    const [frozenState] = await dataSource.query(
      `SELECT
         run."sourceRevision"::text AS "sourceRevision",
         run."statisticsPromotedAt",
         drift_task."departmentGeneration"::text AS "driftGeneration",
         drift_task."status" AS "driftStatus",
         exhausted_task."status" AS "exhaustedStatus"
       FROM "historic_backfill_run" run
       JOIN "historic_backfill_task" drift_task
         ON drift_task."runId" = run."id" AND drift_task."departementId" = 1
       JOIN "historic_backfill_task" exhausted_task
         ON exhausted_task."runId" = run."id"
        AND exhausted_task."departementId" = 2
       WHERE run."id" = $1`,
      [run.id],
    );
    expect(frozenState).toMatchObject({
      sourceRevision: '1',
      statisticsPromotedAt: promotedAt,
      driftGeneration: '0',
      driftStatus: 'pending',
      exhaustedStatus: 'pending',
    });

    await dataSource.query(
      `DELETE FROM "historic_backfill_map_manifest_outbox" WHERE "runId" = $1`,
      [run.id],
    );
    await dataSource.query(
      `UPDATE "historic_backfill_run"
       SET "statisticsPromotedAt" = NULL WHERE "id" = $1`,
      [run.id],
    );
    await dataSource.query(
      `UPDATE "zone_publication_source_state"
       SET "publicRevision" = 1 WHERE "id" = 1`,
    );
    await dataSource.query(
      `UPDATE "historic_backfill_department_revision"
       SET "generation" = 0, "lastPublicRevision" = 1
       WHERE "departementId" = 1`,
    );
    await dataSource.query(
      `UPDATE "historic_backfill_task"
       SET "attemptCount" = 0
       WHERE "runId" = $1 AND "departementId" = 2`,
      [run.id],
    );

    await dataSource.query(`
      INSERT INTO "external_publication_run" ("jobKey", "status")
      VALUES ('compute:national-daily', 'running')
    `);
    await expect(
      queue.claim('blocked-historic-worker', 30, 5),
    ).resolves.toBeNull();
    const [blockedTaskState] = await dataSource.query(
      `SELECT COUNT(*)::integer AS count
       FROM "historic_backfill_task"
       WHERE "runId" = $1 AND "status" <> 'pending'`,
      [run.id],
    );
    expect(blockedTaskState.count).toBe(0);
    await dataSource.query(`DELETE FROM "external_publication_run"`);

    const [claimA, claimB] = await Promise.all([
      queue.claim('department-worker-a', 30, 5),
      queue.claim('department-worker-b', 30, 5),
    ]);
    if (!claimA || !claimB) {
      throw new Error('Both department workers must obtain a lease');
    }
    expect(claimA.departementId).not.toBe(claimB.departementId);
    expect(claimA.leaseToken).not.toBe(claimB.leaseToken);

    await expect(
      queue.heartbeat(
        leaseIdentity(claimA),
        {
          progressDate: '2024-04-30',
          segmentCount: 1,
          communeCount: 1,
          artifactPrefix: 'departments/checkpointed',
        },
        30,
      ),
    ).resolves.toBe(true);
    await dataSource.query(
      `INSERT INTO "historic_backfill_department_segment" (
         "runId", "departementId", "validFrom", "validThrough",
         "sourceGeneration", "inputSignature", "restriction", "situation",
         "geojsonObjectKey", "geojsonChecksum", "featureCount"
       ) VALUES (
         $1, $2, '2024-04-29', '2024-04-30', $3, $4,
         '{"computedZoneIds":[1001]}', '{}',
         'departments/checkpointed/1001.geojson', $4, 1
       )`,
      [run.id, claimA.departementId, claimA.departmentGeneration, SHA256],
    );
    await dataSource.query(
      `INSERT INTO "historic_backfill_commune_segment" (
         "runId", "departementId", "communeId", "validFrom",
         "validThrough", "SUP", "sourceGeneration", "inputSignature"
       ) VALUES (
         $1, $2, $2, '2024-04-29', '2024-04-30', 'alerte', $3, $4
       )`,
      [run.id, claimA.departementId, claimA.departmentGeneration, SHA256],
    );
    await dataSource.query(
      `UPDATE "historic_backfill_task"
       SET "nextAttemptAt" = now() + interval '1 day'
       WHERE "runId" = $1 AND "status" = 'pending'`,
      [run.id],
    );
    const [exhaustionGateTask] = await dataSource.query(
      `SELECT "departementId"
       FROM "historic_backfill_task"
       WHERE "runId" = $1 AND "status" = 'pending'
       ORDER BY "departementId"
       LIMIT 1`,
      [run.id],
    );
    if (!exhaustionGateTask) {
      throw new Error('An exhaustion gate task is required for the retry test');
    }
    await dataSource.query(
      `UPDATE "historic_backfill_task"
       SET "attemptCount" = 5, "nextAttemptAt" = now()
       WHERE "runId" = $1 AND "departementId" = $2`,
      [run.id, exhaustionGateTask.departementId],
    );
    const retryGateKey = [71_401, 71_402] as const;
    await dataSource.query(`
      CREATE OR REPLACE FUNCTION historic_backfill_test_exhaustion_gate()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."status" = 'failed'
          AND OLD."runId" = TG_ARGV[0]::uuid
          AND OLD."departementId" = TG_ARGV[1]::integer THEN
          PERFORM pg_advisory_xact_lock(
            TG_ARGV[2]::integer,
            TG_ARGV[3]::integer
          );
          RETURN NULL;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await dataSource.query(`
      CREATE TRIGGER historic_backfill_test_exhaustion_gate_trigger
      BEFORE UPDATE ON "historic_backfill_task"
      FOR EACH ROW EXECUTE FUNCTION historic_backfill_test_exhaustion_gate(
        '${run.id}', '${exhaustionGateTask.departementId}',
        '${retryGateKey[0]}', '${retryGateKey[1]}'
      )
    `);

    const interruptedWriter = dataSource.createQueryRunner();
    const retryGate = dataSource.createQueryRunner();
    await interruptedWriter.connect();
    await retryGate.connect();
    let reclaimedPromise: Promise<HistoricBackfillTaskClaim | null> | undefined;
    let retryGateLocked = false;
    let retryGateWaiterObserved = false;
    let reclaimed: HistoricBackfillTaskClaim | null | undefined;
    try {
      await retryGate.query(`SELECT pg_advisory_lock($1, $2)`, [
        ...retryGateKey,
      ]);
      retryGateLocked = true;
      await dataSource.query(
        `UPDATE "historic_backfill_task"
         SET "leaseExpiresAt" = clock_timestamp() + interval '1 second'
         WHERE "runId" = $1 AND "departementId" = $2`,
        [run.id, claimA.departementId],
      );
      await interruptedWriter.startTransaction('READ COMMITTED');
      await interruptedWriter.query(`SELECT now()`);

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      reclaimedPromise = queue.claim('department-worker-reclaimer', 30, 5);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [waiting] = await dataSource.query(
          `SELECT EXISTS (
             SELECT 1
             FROM pg_locks
             WHERE locktype = 'advisory'
               AND classid = $1::integer::oid
               AND objid = $2::integer::oid
               AND objsubid = 2
               AND NOT granted
           ) AS waiting`,
          [...retryGateKey],
        );
        if (waiting.waiting === true) {
          retryGateWaiterObserved = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const oldContext = await interruptedWriter.query(
        `SELECT "runId"
         FROM "historic_backfill_task"
         WHERE "runId" = $1 AND "departementId" = $2
           AND "leaseOwner" = $3 AND "leaseToken" = $4
           AND "leaseExpiresAt" > now()
         FOR UPDATE`,
        [run.id, claimA.departementId, claimA.workerId, claimA.leaseToken],
      );
      expect(oldContext).toHaveLength(1);
      await interruptedWriter.query(
        `INSERT INTO "historic_backfill_department_segment" (
           "runId", "departementId", "validFrom", "validThrough",
           "sourceGeneration", "inputSignature", "restriction", "situation",
           "geojsonObjectKey", "geojsonChecksum", "featureCount"
         ) VALUES (
           $1, $2, '2024-05-01', '2024-05-02', $3, $4,
           '{"computedZoneIds":[1002]}', '{}',
           'departments/partial/1002.geojson', $5, 1
         )`,
        [
          run.id,
          claimA.departementId,
          claimA.departmentGeneration,
          SHA256,
          PARTIAL_SHA256,
        ],
      );
      await interruptedWriter.query(
        `INSERT INTO "historic_backfill_commune_segment" (
           "runId", "departementId", "communeId", "validFrom",
           "validThrough", "SUP", "sourceGeneration", "inputSignature"
         ) VALUES (
           $1, $2, $2, '2024-05-01', '2024-05-02', 'crise', $3, $4
         )`,
        [run.id, claimA.departementId, claimA.departmentGeneration, SHA256],
      );
      await interruptedWriter.commitTransaction();
      await retryGate.query(`SELECT pg_advisory_unlock($1, $2)`, [
        ...retryGateKey,
      ]);
      retryGateLocked = false;
      reclaimed = await reclaimedPromise;
    } finally {
      if (interruptedWriter.isTransactionActive) {
        await interruptedWriter.rollbackTransaction();
      }
      if (retryGateLocked) {
        await retryGate.query(`SELECT pg_advisory_unlock($1, $2)`, [
          ...retryGateKey,
        ]);
      }
      if (reclaimedPromise && reclaimed === undefined) {
        await reclaimedPromise.catch(() => undefined);
      }
      await interruptedWriter.release();
      await retryGate.release();
      await dataSource.query(
        `DROP TRIGGER IF EXISTS historic_backfill_test_exhaustion_gate_trigger
         ON "historic_backfill_task"`,
      );
      await dataSource.query(
        `DROP FUNCTION IF EXISTS historic_backfill_test_exhaustion_gate()`,
      );
    }

    expect(retryGateWaiterObserved).toBe(true);
    if (!reclaimed) {
      throw new Error('The expired department lease must be reclaimable');
    }
    expect(reclaimed.departementId).toBe(claimA.departementId);
    expect(reclaimed.leaseToken).not.toBe(claimA.leaseToken);
    expect(reclaimed).toMatchObject({
      progressDate: '2024-04-30',
      segmentCount: 1,
      communeCount: 1,
      artifactPrefix: 'departments/checkpointed',
    });
    const retryStageRows = await dataSource.query(
      `SELECT 'department' AS kind, "validFrom"::text AS "validFrom",
              "validThrough"::text AS "validThrough"
       FROM "historic_backfill_department_segment"
       WHERE "runId" = $1 AND "departementId" = $2
       UNION ALL
       SELECT 'commune' AS kind, "validFrom"::text AS "validFrom",
              "validThrough"::text AS "validThrough"
       FROM "historic_backfill_commune_segment"
       WHERE "runId" = $1 AND "departementId" = $2
       ORDER BY kind`,
      [run.id, claimA.departementId],
    );
    expect(retryStageRows).toEqual([
      {
        kind: 'commune',
        validFrom: '2024-04-29',
        validThrough: '2024-04-30',
      },
      {
        kind: 'department',
        validFrom: '2024-04-29',
        validThrough: '2024-04-30',
      },
    ]);
    await dataSource.query(
      `UPDATE "historic_backfill_task"
       SET "attemptCount" = 0,
           "nextAttemptAt" = now() + interval '1 day'
       WHERE "runId" = $1 AND "departementId" = $2`,
      [run.id, exhaustionGateTask.departementId],
    );

    const retriedDepartmentRows = await dataSource.query(
      `INSERT INTO "historic_backfill_department_segment" AS target (
         "runId", "departementId", "validFrom", "validThrough",
         "sourceGeneration", "inputSignature", "restriction", "situation",
         "geojsonObjectKey", "geojsonChecksum", "featureCount"
       ) VALUES (
         $1, $2, '2024-05-01', '2024-05-02', $3, $4,
         '{"computedZoneIds":[2002]}', '{}',
         'departments/retry/2002.geojson', $5, 1
       )
       ON CONFLICT ("runId", "departementId", "validFrom") DO UPDATE
       SET "validThrough" = EXCLUDED."validThrough",
           "sourceGeneration" = EXCLUDED."sourceGeneration",
           "inputSignature" = EXCLUDED."inputSignature",
           "restriction" = EXCLUDED."restriction",
           "situation" = EXCLUDED."situation",
           "geojsonObjectKey" = EXCLUDED."geojsonObjectKey",
           "geojsonChecksum" = EXCLUDED."geojsonChecksum",
           "featureCount" = EXCLUDED."featureCount"
       WHERE target."validThrough" = EXCLUDED."validThrough"
         AND target."sourceGeneration" = EXCLUDED."sourceGeneration"
         AND target."inputSignature" = EXCLUDED."inputSignature"
         AND target."restriction" = EXCLUDED."restriction"
         AND target."situation" = EXCLUDED."situation"
         AND target."geojsonObjectKey" = EXCLUDED."geojsonObjectKey"
         AND target."geojsonChecksum" = EXCLUDED."geojsonChecksum"
         AND target."featureCount" = EXCLUDED."featureCount"
       RETURNING "geojsonObjectKey", "geojsonChecksum", "restriction"`,
      [
        run.id,
        claimA.departementId,
        claimA.departmentGeneration,
        SHA256,
        RETRY_SHA256,
      ],
    );
    expect(retriedDepartmentRows).toEqual([
      {
        geojsonObjectKey: 'departments/retry/2002.geojson',
        geojsonChecksum: RETRY_SHA256,
        restriction: { computedZoneIds: [2002] },
      },
    ]);
    await expect(
      queue.heartbeat(leaseIdentity(claimA), undefined, 30),
    ).resolves.toBe(false);
    await expect(
      queue.complete(leaseIdentity(claimA), {
        progressDate: '2024-05-02',
        segmentCount: 1,
        communeCount: 1,
        outputSignature: SHA256,
      }),
    ).resolves.toBe(false);
    await expect(
      queue.heartbeat(leaseIdentity(reclaimed), undefined, 30),
    ).resolves.toBe(true);
    await dataSource.query(
      `DELETE FROM "historic_backfill_commune_segment"
       WHERE "runId" = $1 AND "departementId" = $2`,
      [run.id, claimA.departementId],
    );
    await dataSource.query(
      `DELETE FROM "historic_backfill_department_segment"
       WHERE "runId" = $1 AND "departementId" = $2`,
      [run.id, claimA.departementId],
    );

    const staleDepartmentId = 101;
    const preservedDepartmentId = 100;
    await dataSource.query(
      `UPDATE "historic_backfill_task"
       SET "status" = 'completed', "progressDate" = '2024-05-02',
           "segmentCount" = 1, "communeCount" = 1,
           "outputSignature" = $2, "artifactPrefix" = 'staged',
           "leaseOwner" = NULL, "leaseToken" = NULL,
           "leaseExpiresAt" = NULL, "completedAt" = now()
       WHERE "runId" = $1 AND "departementId" IN (100, 101)`,
      [run.id, SHA256],
    );
    await dataSource.query(
      `INSERT INTO "historic_backfill_commune_segment" (
         "runId", "departementId", "communeId", "validFrom",
         "validThrough", "sourceGeneration", "inputSignature"
       )
       SELECT $1, id, id, '2024-04-29', '2024-05-02', 0, $2
       FROM "departement" WHERE id IN (100, 101)`,
      [run.id, SHA256],
    );
    await dataSource.query(
      `INSERT INTO "historic_backfill_department_segment" (
         "runId", "departementId", "validFrom", "validThrough",
         "sourceGeneration", "inputSignature", "restriction", "situation",
         "geojsonObjectKey", "geojsonChecksum", "featureCount"
       )
       SELECT $1, id, '2024-04-29', '2024-05-02', 0, $2, '{}', '{}',
              'department/' || id || '.geojson', $2, 0
       FROM "departement" WHERE id IN (100, 101)`,
      [run.id, SHA256],
    );
    await dataSource.query(
      `INSERT INTO "historic_backfill_commune_shadow" (
         "runId", "communeId", "departementId", "sourceGeneration",
         "restrictions", "restrictionsByMonth"
       )
       SELECT $1, id, id, 0, '[]', '[]'
       FROM "departement" WHERE id IN (100, 101)`,
      [run.id],
    );
    await dataSource.query(
      `UPDATE "historic_backfill_department_revision"
       SET "generation" = 1, "lastPublicRevision" = 2
       WHERE "departementId" = $1`,
      [staleDepartmentId],
    );
    await dataSource.query(
      `UPDATE "zone_publication_source_state"
       SET "publicRevision" = 2 WHERE "id" = 1`,
    );
    await dataSource.query(
      `UPDATE "historic_backfill_run"
       SET "statisticsPromotedAt" = now() WHERE "id" = $1`,
      [run.id],
    );

    const rebased = await queue.claim('department-worker-rebase', 30, 5);
    if (!rebased) {
      throw new Error('The stale completed department must be reprocessed');
    }
    expect(rebased.departementId).toBe(staleDepartmentId);
    expect(rebased.departmentGeneration).toBe('1');
    expect(rebased.sourceRevision).toBe('2');
    expect(rebased.attemptCount).toBe(1);
    expect(rebased.progressDate).toBeNull();
    expect(rebased.segmentCount).toBe(0);
    expect(rebased.communeCount).toBe(0);
    expect(rebased.artifactPrefix).toBeNull();

    const stagedCounts = await dataSource.query(
      `SELECT "departementId", COUNT(*)::integer AS count
       FROM (
         SELECT "departementId" FROM "historic_backfill_commune_segment"
         WHERE "runId" = $1
         UNION ALL
         SELECT "departementId" FROM "historic_backfill_department_segment"
         WHERE "runId" = $1
         UNION ALL
         SELECT "departementId" FROM "historic_backfill_commune_shadow"
         WHERE "runId" = $1
       ) staged
       GROUP BY "departementId" ORDER BY "departementId"`,
      [run.id],
    );
    expect(stagedCounts).toEqual([
      { departementId: preservedDepartmentId, count: 3 },
    ]);
    const [rebasedRun] = await dataSource.query(
      `SELECT "sourceRevision"::text AS "sourceRevision",
              "statisticsPromotedAt"
       FROM "historic_backfill_run" WHERE "id" = $1`,
      [run.id],
    );
    expect(rebasedRun.sourceRevision).toBe('2');
    expect(rebasedRun.statisticsPromotedAt).toBeNull();

    await dataSource.query(
      `UPDATE "historic_backfill_task" task
       SET "status" = 'completed',
           "departmentGeneration" = revision."generation",
           "progressDate" = '2024-05-02', "segmentCount" = 1,
           "communeCount" = 1, "outputSignature" = $2,
           "leaseOwner" = NULL, "leaseToken" = NULL,
           "leaseExpiresAt" = NULL, "completedAt" = now()
       FROM "historic_backfill_department_revision" revision
       WHERE task."runId" = $1
         AND revision."departementId" = task."departementId"`,
      [run.id, SHA256],
    );
    await dataSource.query(
      `DELETE FROM "historic_backfill_department_segment" WHERE "runId" = $1`,
      [run.id],
    );
    await dataSource.query(
      `INSERT INTO "historic_backfill_department_segment" (
         "runId", "departementId", "validFrom", "validThrough",
         "sourceGeneration", "inputSignature", "restriction", "situation",
         "geojsonObjectKey", "geojsonChecksum", "featureCount"
       )
       SELECT $1, departement.id,
              CASE WHEN departement.id = 101 THEN '2024-04-30'::date
                   ELSE '2024-04-29'::date END,
              '2024-05-02', revision."generation", $2, '{}', '{}',
              'department/' || departement.id || '.geojson', $2, 1
       FROM "departement" departement
       JOIN "historic_backfill_department_revision" revision
         ON revision."departementId" = departement.id`,
      [run.id, SHA256],
    );
    await expect(artifactQueue.prepare(run.id)).rejects.toThrow(
      'Department artifact coverage is not contiguous for 101',
    );

    await dataSource.query(
      `UPDATE "historic_backfill_department_segment"
       SET "validFrom" = '2024-04-29'
       WHERE "runId" = $1 AND "departementId" = 101`,
      [run.id],
    );
    await dataSource.query(
      `UPDATE "historic_backfill_department_segment"
       SET "validThrough" = '2024-04-30'
       WHERE "runId" = $1 AND "departementId" = 1`,
      [run.id],
    );
    await dataSource.query(
      `INSERT INTO "historic_backfill_department_segment" (
         "runId", "departementId", "validFrom", "validThrough",
         "sourceGeneration", "inputSignature", "restriction", "situation",
         "geojsonObjectKey", "geojsonChecksum", "featureCount"
       )
       SELECT $1, 1, '2024-05-01', '2024-05-02', "generation", $2,
              '{}', '{}', 'department/1-second.geojson', $2, 1
       FROM "historic_backfill_department_revision"
       WHERE "departementId" = 1`,
      [run.id, SHA256],
    );

    await expect(artifactQueue.prepare(run.id)).resolves.toEqual({
      taskCount: 2,
    });
    const [artifactA, artifactB] = await Promise.all([
      artifactQueue.claim(run.id, 'artifact-worker-a', 30, 2),
      artifactQueue.claim(run.id, 'artifact-worker-b', 30, 2),
    ]);
    if (!artifactA || !artifactB) {
      throw new Error('Both artifact workers must obtain a lease');
    }
    expect(artifactA.validFrom).not.toBe(artifactB.validFrom);
    await expect(
      artifactQueue.getOutputSegments(dataSource.manager, artifactA),
    ).resolves.toHaveLength(101);
    await expect(
      artifactQueue.getOutputSegments(dataSource.manager, artifactB),
    ).resolves.toHaveLength(101);

    await dataSource.query(
      `UPDATE "historic_backfill_artifact_task"
       SET "leaseExpiresAt" = now() - interval '1 second'
       WHERE "runId" = $1 AND "validFrom" = $2`,
      [run.id, artifactA.validFrom],
    );
    const artifactReclaimed = await artifactQueue.claim(
      run.id,
      'artifact-worker-reclaimer',
      30,
      2,
    );
    if (!artifactReclaimed) {
      throw new Error('The expired artifact lease must be reclaimable');
    }
    expect(artifactReclaimed.validFrom).toBe(artifactA.validFrom);
    expect(artifactReclaimed.leaseToken).not.toBe(artifactA.leaseToken);
    await expect(artifactQueue.heartbeat(artifactA, 30)).resolves.toBe(false);
    await expect(
      artifactQueue.complete(artifactA, {
        geojsonObjectKey: 'national/old.geojson',
        geojsonChecksum: SHA256,
        pmtilesObjectKey: 'national/old.pmtiles',
        pmtilesChecksum: SHA256,
        featureCount: 101,
      }),
    ).resolves.toBe(false);
    await expect(artifactQueue.heartbeat(artifactReclaimed, 30)).resolves.toBe(
      true,
    );

    await dataSource.query(
      `UPDATE "historic_backfill_artifact_task"
       SET "leaseExpiresAt" = now() - interval '1 second'
       WHERE "runId" = $1 AND "validFrom" = $2`,
      [run.id, artifactReclaimed.validFrom],
    );
    await expect(
      artifactQueue.claim(run.id, 'artifact-worker-exhaustion', 30, 2),
    ).resolves.toBeNull();
    const [exhaustedArtifact] = (await dataSource.query(
      `SELECT "status", "attemptCount", "leaseOwner", "leaseToken",
              "leaseExpiresAt", "lastError"
       FROM "historic_backfill_artifact_task"
       WHERE "runId" = $1 AND "validFrom" = $2`,
      [run.id, artifactReclaimed.validFrom],
    )) as Array<{
      status: string;
      attemptCount: number;
      leaseOwner: string | null;
      leaseToken: string | null;
      leaseExpiresAt: Date | null;
      lastError: string | null;
    }>;
    expect(exhaustedArtifact).toEqual(
      expect.objectContaining({
        status: 'failed',
        attemptCount: 2,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        lastError: 'Maximum historic artifact attempts exhausted',
      }),
    );
    const [failedRun] = (await dataSource.query(
      `SELECT "status", "lastError"
       FROM "historic_backfill_run" WHERE "id" = $1`,
      [run.id],
    )) as Array<{ status: string; lastError: string | null }>;
    expect(failedRun).toEqual({
      status: 'failed',
      lastError: 'At least one artifact exhausted its attempts',
    });
  }, 60_000);
});
