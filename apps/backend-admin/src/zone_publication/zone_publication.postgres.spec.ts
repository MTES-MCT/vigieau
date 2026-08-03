import { DataSource, QueryRunner } from 'typeorm';
import { Config } from '@shared/entities/config.entity';
import { ConfigService } from '../config/config.service';
import { SKIP_STARTUP_DATA_LOADS_ENV } from '../core/startup-data-loads';
import { ReconcileTerminalPublicationSnapshots1786219300000 } from '../migrations/1786219300000-ReconcileTerminalPublicationSnapshots';
import { ZonePublicationService } from './zone_publication.service';

const postgresUrl = process.env.STATISTIC_COMMUNE_POSTGRES_URL;
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres('ZonePublicationService PostgreSQL certification', () => {
  let dataSource: DataSource;
  let queryRunner: QueryRunner;
  let service: ZonePublicationService;

  const failedPublicationId = 'dcf24878-0000-4000-8000-000000000000';
  const rebuiltPublicationId = 'dcf24878-0000-4000-8000-000000000001';
  const previousPublicationEnabled = process.env.ZONE_PUBLICATION_ENABLED;

  beforeAll(async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    dataSource = await new DataSource({
      type: 'postgres',
      url: postgresUrl,
      entities: [Config],
      synchronize: false,
      logging: false,
    }).initialize();
  });

  beforeEach(async () => {
    queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    await queryRunner.query(`
      CREATE TEMP TABLE "zone_publication_source_state" (
        "id" integer PRIMARY KEY,
        "revision" bigint NOT NULL
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "zone_publication" (
        "id" uuid PRIMARY KEY,
        "status" varchar NOT NULL,
        "sourceRevision" bigint NOT NULL,
        "materializationVersion" integer NOT NULL,
        "sourceComputedAt" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "activatedAt" timestamptz,
        "candidateAt" timestamptz,
        "failedAt" timestamptz,
        "validationError" text,
        "zoneCount" integer NOT NULL DEFAULT 10,
        "communeLinkCount" integer NOT NULL DEFAULT 20,
        "contentFingerprint" varchar
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "zone_publication_state" (
        "id" integer PRIMARY KEY,
        "activePublicationId" uuid,
        "candidatePublicationId" uuid,
        "candidateRequestedAt" timestamptz,
        "automaticPublishingPaused" boolean NOT NULL DEFAULT false,
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "zone_publication_instance" (
        "instanceId" varchar PRIMARY KEY,
        "heartbeatAt" timestamptz NOT NULL,
        "candidatePublicationId" uuid,
        "lastError" text,
        "zoneCount" integer,
        "communeLinkCount" integer,
        "contentFingerprint" varchar
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "statistic_commune_snapshot" (
        "snapshotDate" date NOT NULL,
        "scope" varchar NOT NULL,
        "status" varchar NOT NULL,
        "sourceRevision" bigint,
        PRIMARY KEY ("snapshotDate", "scope")
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "statistic_publication_state" (
        "id" integer PRIMARY KEY,
        "currentPublishedDate" date,
        "historicPublishedThrough" date,
        "historicDirtyFrom" date
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "config" (
        "id" integer PRIMARY KEY,
        "computeMapDate" date,
        "computeStatsDate" date,
        "computeMapGeneration" bigint NOT NULL DEFAULT 0,
        "computeStatsGeneration" bigint NOT NULL DEFAULT 0,
        "computeMapUpdatedAt" timestamptz,
        "computeStatsUpdatedAt" timestamptz
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "external_publication_run" (
        "jobKey" varchar NOT NULL,
        "scheduledFor" date NOT NULL,
        "status" varchar NOT NULL,
        "metadata" jsonb NOT NULL,
        PRIMARY KEY ("jobKey", "scheduledFor")
      ) ON COMMIT DROP
    `);
    service = new ZonePublicationService({
      query: (sql: string, parameters?: unknown[]) =>
        queryRunner.query(sql, parameters),
      transaction: (
        _isolation: string,
        callback: (manager: QueryRunner) => Promise<unknown>,
      ) => callback(queryRunner),
    } as never);
  });

  afterEach(async () => {
    if (queryRunner?.isTransactionActive) {
      await queryRunner.rollbackTransaction();
    }
    if (queryRunner) {
      await queryRunner.release();
    }
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    if (previousPublicationEnabled === undefined) {
      delete process.env.ZONE_PUBLICATION_ENABLED;
    } else {
      process.env.ZONE_PUBLICATION_ENABLED = previousPublicationEnabled;
    }
  });

  async function seedCurrentSource() {
    await queryRunner.query(
      `INSERT INTO "zone_publication_source_state" VALUES (1, 10)`,
    );
    await queryRunner.query(
      `INSERT INTO "zone_publication_state" ("id") VALUES (1)`,
    );
  }

  async function seedCertifiedRecovery(failedSourceDate = '2026-08-01') {
    await seedCurrentSource();
    await queryRunner.query(
      `
        INSERT INTO "zone_publication" (
          "id", "status", "sourceRevision", "materializationVersion",
          "sourceComputedAt"
        ) VALUES
          ($1, 'failed', 10, 3, $3::date + time '08:00'),
          ($2, 'validated', 10, 3, date '2026-08-01' + time '09:00')
      `,
      [failedPublicationId, rebuiltPublicationId, failedSourceDate],
    );
    await queryRunner.query(
      `INSERT INTO "statistic_commune_snapshot" VALUES (
        date '2026-08-01', 'national', 'ready', 10
      )`,
    );
    await queryRunner.query(
      `INSERT INTO "statistic_publication_state" VALUES (
        1, date '2026-07-31', date '2026-07-31', NULL
      )`,
    );
    await queryRunner.query(
      `INSERT INTO "config" VALUES (
        1, date '2026-07-31', date '2026-07-31', 12, 18
      )`,
    );
    await queryRunner.query(
      `
        INSERT INTO "external_publication_run" VALUES
          (
            'compute:national-daily', date '2026-08-01', 'succeeded',
            jsonb_build_object(
              'publicationId', $1::text,
              'sourceRevision', '10',
              'materializationVersion', 3
            )
          ),
          (
            'compute:historic-catchup', date '2026-08-01', 'succeeded',
            jsonb_build_object(
              'sourceRevision', '10',
              'materializationVersion', 3,
              'historicMapCursor', '2026-07-31',
              'historicStatsCursor', '2026-07-31',
              'historicMapGeneration', '12',
              'historicStatsGeneration', '18'
            )
          )
      `,
      [failedPublicationId],
    );
  }

  async function waitForBackendLock(
    observer: QueryRunner,
    backendPid: number,
  ): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const [activity] = await observer.query(
        `SELECT "wait_event_type" AS "waitEventType"
         FROM "pg_stat_activity"
         WHERE "pid" = $1`,
        [backendPid],
      );
      if (activity?.waitEventType === 'Lock') {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `PostgreSQL backend ${backendPid} did not wait for the expected lock`,
    );
  }

  it('rejects cursor advancement when a newer source revision wins the row lock', async () => {
    const schemaName = `zone_revision_race_${process.pid}_${Date.now()}`;
    const schemaRunner = dataSource.createQueryRunner();
    const cursorRunner = dataSource.createQueryRunner();
    const revisionRunner = dataSource.createQueryRunner();
    let cursorAdvance: Promise<boolean> | undefined;
    await Promise.all([
      schemaRunner.connect(),
      cursorRunner.connect(),
      revisionRunner.connect(),
    ]);

    try {
      await schemaRunner.query(`CREATE SCHEMA "${schemaName}"`);
      await schemaRunner.query(`
        CREATE TABLE "${schemaName}"."config" (
          "id" integer PRIMARY KEY,
          "computeMapDate" date,
          "computeMapGeneration" bigint NOT NULL DEFAULT 0,
          "computeMapUpdatedAt" timestamptz,
          "computeStatsDate" date,
          "computeStatsGeneration" bigint NOT NULL DEFAULT 0,
          "computeStatsUpdatedAt" timestamptz,
          "computeZoneAlerteComputedDate" timestamp
        );
        CREATE TABLE "${schemaName}"."zone_publication_source_state" (
          "id" integer PRIMARY KEY,
          "revision" bigint NOT NULL
        );
        INSERT INTO "${schemaName}"."config" ("id") VALUES (1);
        INSERT INTO "${schemaName}"."zone_publication_source_state"
          ("id", "revision") VALUES (1, 10);
      `);

      await cursorRunner.startTransaction();
      await revisionRunner.startTransaction();
      await cursorRunner.query(
        `SET LOCAL search_path TO "${schemaName}", public`,
      );
      await revisionRunner.query(
        `SET LOCAL search_path TO "${schemaName}", public`,
      );

      await revisionRunner.query(
        `UPDATE "zone_publication_source_state"
         SET "revision" = 11
         WHERE "id" = 1`,
      );
      const [{ pid: cursorBackendPid }] = await cursorRunner.query(
        `SELECT pg_backend_pid() AS "pid"`,
      );

      const previousSkipStartupDataLoads =
        process.env[SKIP_STARTUP_DATA_LOADS_ENV];
      process.env[SKIP_STARTUP_DATA_LOADS_ENV] = 'true';
      const configService = new ConfigService(
        cursorRunner.manager.getRepository(Config),
      );
      if (previousSkipStartupDataLoads === undefined) {
        delete process.env[SKIP_STARTUP_DATA_LOADS_ENV];
      } else {
        process.env[SKIP_STARTUP_DATA_LOADS_ENV] = previousSkipStartupDataLoads;
      }

      cursorAdvance = configService.advanceComputeMapDate(
        null,
        '0',
        '2026-08-01',
        '10',
      );
      await waitForBackendLock(schemaRunner, Number(cursorBackendPid));

      await revisionRunner.commitTransaction();
      await expect(cursorAdvance).resolves.toBe(false);
      await cursorRunner.commitTransaction();

      const [state] = await schemaRunner.query(
        `SELECT
           source."revision"::text AS "revision",
           config."computeMapDate"::text AS "computeMapDate",
           config."computeMapGeneration"::text AS "computeMapGeneration",
           config."computeMapUpdatedAt" AS "computeMapUpdatedAt"
         FROM "${schemaName}"."zone_publication_source_state" source
         CROSS JOIN "${schemaName}"."config" config
         WHERE source."id" = 1 AND config."id" = 1`,
      );
      expect(state).toEqual({
        revision: '11',
        computeMapDate: null,
        computeMapGeneration: '0',
        computeMapUpdatedAt: null,
      });
    } finally {
      if (revisionRunner.isTransactionActive) {
        await revisionRunner.rollbackTransaction();
      }
      if (cursorAdvance) {
        await cursorAdvance.catch(() => undefined);
      }
      if (cursorRunner.isTransactionActive) {
        await cursorRunner.rollbackTransaction();
      }
      await Promise.all([cursorRunner.release(), revisionRunner.release()]);
      await schemaRunner.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await schemaRunner.release();
    }
  }, 15_000);

  it('promotes a rebuilt validated publication through a same-day failed identity', async () => {
    await seedCertifiedRecovery();

    await expect(
      service.promoteCertifiedPublicationIfAvailable({
        scheduledFor: '2026-08-01',
        sourceRevision: '10',
        preferredPublicationId: failedPublicationId,
      }),
    ).resolves.toBe(true);

    const [publication] = await queryRunner.query(
      `SELECT "status", "candidateAt" IS NOT NULL AS "candidateAtSet"
       FROM "zone_publication" WHERE "id" = $1`,
      [rebuiltPublicationId],
    );
    const [state] = await queryRunner.query(
      `SELECT "candidatePublicationId"::text AS "candidatePublicationId"
       FROM "zone_publication_state" WHERE "id" = 1`,
    );
    expect(publication).toEqual({ status: 'candidate', candidateAtSet: true });
    expect(state.candidatePublicationId).toBe(rebuiltPublicationId);
  });

  it('rejects an old historic success after an equal-date generation invalidation', async () => {
    await seedCertifiedRecovery();
    await queryRunner.query(
      `UPDATE "config" SET "computeMapGeneration" = 13 WHERE "id" = 1`,
    );

    await expect(
      service.promoteCertifiedPublicationIfAvailable({
        scheduledFor: '2026-08-01',
        sourceRevision: '10',
        preferredPublicationId: failedPublicationId,
      }),
    ).rejects.toThrow(
      'waiting for certified current statistics or historic catch-up',
    );

    const [publication] = await queryRunner.query(
      `SELECT "status" FROM "zone_publication" WHERE "id" = $1`,
      [rebuiltPublicationId],
    );
    expect(publication.status).toBe('validated');
  });

  it('revalidates the exact historic epoch when activating a recovered publication', async () => {
    await seedCertifiedRecovery();
    await expect(
      service.promoteCertifiedPublicationIfAvailable({
        scheduledFor: '2026-08-01',
        sourceRevision: '10',
        preferredPublicationId: failedPublicationId,
      }),
    ).resolves.toBe(true);
    await queryRunner.query(
      `
        INSERT INTO "zone_publication_instance" (
          "instanceId", "heartbeatAt", "candidatePublicationId",
          "zoneCount", "communeLinkCount"
        ) VALUES
          ('api-1', now(), $1, 10, 20),
          ('api-2', now(), $1, 10, 20)
      `,
      [rebuiltPublicationId],
    );
    await queryRunner.query(
      `UPDATE "config" SET "computeMapGeneration" = 13 WHERE "id" = 1`,
    );

    await expect(
      service.activateWhenReady({ minimumReadyInstances: 2 }),
    ).rejects.toThrow(
      'waiting for certified current statistics or historic catch-up',
    );

    const [publication] = await queryRunner.query(
      `SELECT "status" FROM "zone_publication" WHERE "id" = $1`,
      [rebuiltPublicationId],
    );
    expect(publication.status).toBe('candidate');
  });

  it('rejects recovery through a failed publication from another civil day', async () => {
    await seedCertifiedRecovery('2026-07-31');

    await expect(
      service.promoteCertifiedPublicationIfAvailable({
        scheduledFor: '2026-08-01',
        sourceRevision: '10',
        preferredPublicationId: failedPublicationId,
      }),
    ).resolves.toBe(false);

    const [publication] = await queryRunner.query(
      `SELECT "status" FROM "zone_publication" WHERE "id" = $1`,
      [rebuiltPublicationId],
    );
    expect(publication.status).toBe('validated');
  });

  it.each([
    {
      latestHistoricStatus: 'succeeded',
      expectedRecompute: true,
      label:
        'ignores an older failed historic run after the latest run succeeds',
    },
    {
      latestHistoricStatus: 'running',
      expectedRecompute: false,
      label: 'blocks while the latest historic run is still pending',
    },
  ])('$label', async ({ latestHistoricStatus, expectedRecompute }) => {
    await seedCurrentSource();
    await queryRunner.query(
      `INSERT INTO "statistic_publication_state" VALUES (
        1, date '2026-07-31', date '2026-07-31', NULL
      )`,
    );
    await queryRunner.query(
      `
        INSERT INTO "external_publication_run" VALUES
          (
            'compute:national-daily', date '2026-07-31', 'succeeded',
            '{"sourceRevision":"10","materializationVersion":3}'::jsonb
          ),
          (
            'compute:historic-catchup', date '2026-07-31', 'failed',
            '{"sourceRevision":"10","materializationVersion":3}'::jsonb
          ),
          (
            'compute:national-daily', date '2026-08-01', 'succeeded',
            '{"sourceRevision":"10","materializationVersion":3}'::jsonb
          ),
          (
            'compute:historic-catchup', date '2026-08-01', $1,
            '{"sourceRevision":"10","materializationVersion":3}'::jsonb
          )
      `,
      [latestHistoricStatus],
    );

    await expect(service.isRecomputeRequired()).resolves.toBe(
      expectedRecompute,
    );
  });

  it('expires an old validated publication but preserves the latest daily-bound one', async () => {
    const oldPublicationId = 'dcf24878-0000-4000-8000-000000000010';
    const latestPublicationId = 'dcf24878-0000-4000-8000-000000000011';
    await seedCurrentSource();
    await queryRunner.query(
      `
        INSERT INTO "zone_publication" (
          "id", "status", "sourceRevision", "materializationVersion",
          "sourceComputedAt", "createdAt"
        ) VALUES
          ($1, 'validated', 10, 3, timestamptz '2026-07-31 08:00+00', now() - interval '2 hours'),
          ($2, 'validated', 10, 3, timestamptz '2026-08-01 08:00+00', now() - interval '2 hours')
      `,
      [oldPublicationId, latestPublicationId],
    );
    await queryRunner.query(
      `
        INSERT INTO "external_publication_run" VALUES
          (
            'compute:national-daily', date '2026-07-31', 'succeeded',
            jsonb_build_object(
              'publicationId', $1::text,
              'sourceRevision', '10',
              'materializationVersion', 3
            )
          ),
          (
            'compute:national-daily', date '2026-08-01', 'succeeded',
            jsonb_build_object(
              'publicationId', $2::text,
              'sourceRevision', '10',
              'materializationVersion', 3
            )
          )
      `,
      [oldPublicationId, latestPublicationId],
    );

    await expect(service.expireStalePublications(60)).resolves.toEqual([
      oldPublicationId,
    ]);
    const publications = await queryRunner.query(
      `SELECT "id"::text AS "id", "status" FROM "zone_publication" ORDER BY "id"`,
    );
    expect(publications).toEqual([
      { id: oldPublicationId, status: 'superseded' },
      { id: latestPublicationId, status: 'validated' },
    ]);
  });

  it('retains an expired failed recovery identity until a newer daily run exists', async () => {
    const newerPublicationId = 'dcf24878-0000-4000-8000-000000000020';
    await seedCurrentSource();
    await queryRunner.query(
      `
        INSERT INTO "zone_publication" (
          "id", "status", "sourceRevision", "materializationVersion",
          "sourceComputedAt", "createdAt"
        ) VALUES (
          $1, 'failed', 10, 3,
          timestamptz '2026-08-01 08:00+00', now() - interval '72 hours'
        )
      `,
      [failedPublicationId],
    );
    await queryRunner.query(
      `
        INSERT INTO "external_publication_run" VALUES (
          'compute:national-daily', date '2026-08-01', 'succeeded',
          jsonb_build_object(
            'publicationId', $1::text,
            'sourceRevision', '10',
            'materializationVersion', 3
          )
        )
      `,
      [failedPublicationId],
    );

    await expect(
      service.purgeExpiredPublications({ retentionHours: 48 }),
    ).resolves.toEqual([]);

    await queryRunner.query(
      `
        INSERT INTO "external_publication_run" VALUES (
          'compute:national-daily', date '2026-08-02', 'running',
          jsonb_build_object(
            'publicationId', $1::text,
            'sourceRevision', '10',
            'materializationVersion', 3
          )
        )
      `,
      [newerPublicationId],
    );

    await expect(
      service.purgeExpiredPublications({ retentionHours: 48 }),
    ).resolves.toEqual([failedPublicationId]);
  });

  it('atomically invalidates every orphaned terminal publication snapshot', async () => {
    const schemaName = `terminal_snapshot_${process.pid}_${Date.now()}`;
    const runner = dataSource.createQueryRunner();
    await runner.connect();

    try {
      await runner.query(`CREATE SCHEMA "${schemaName}"`);
      await runner.query(`SET search_path TO "${schemaName}", public`);
      await runner.query(`
        CREATE TABLE "zone_publication" (
          "id" uuid PRIMARY KEY,
          "status" varchar NOT NULL,
          "sourceRevision" bigint NOT NULL,
          "sourceComputedAt" timestamptz NOT NULL
        );
        CREATE TABLE "statistic_commune_snapshot" (
          "snapshotDate" date NOT NULL,
          "scope" varchar NOT NULL,
          "status" varchar NOT NULL,
          "sourceRevision" bigint,
          "completedAt" timestamptz,
          "lastError" text,
          "updatedAt" timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY ("snapshotDate", "scope")
        )
      `);
      await runner.query(`
        INSERT INTO "statistic_commune_snapshot" (
          "snapshotDate", "scope", "status", "sourceRevision"
        ) VALUES
          ('9998-01-01', 'national', 'ready', 1),
          ('9998-01-02', 'national', 'ready', 2),
          ('9998-01-03', 'bootstrap', 'ready', 3),
          ('9998-01-04', 'national', 'ready', NULL);
        INSERT INTO "zone_publication" (
          "id", "status", "sourceRevision", "sourceComputedAt"
        ) VALUES
          ('00000000-0000-4000-8000-000000000001', 'failed', 1, '9998-01-01 08:00+00'),
          ('00000000-0000-4000-8000-000000000002', 'failed', 2, '9998-01-02 08:00+00'),
          ('00000000-0000-4000-8000-000000000003', 'validated', 2, '9998-01-02 09:00+00'),
          ('00000000-0000-4000-8000-000000000004', 'superseded', 3, '9998-01-03 08:00+00'),
          ('00000000-0000-4000-8000-000000000005', 'failed', 4, '9998-01-04 08:00+00')
      `);

      const migration =
        new ReconcileTerminalPublicationSnapshots1786219300000();
      await migration.up(runner);

      const afterReconciliation = await runner.query(`
        SELECT "snapshotDate"::text AS "snapshotDate", "scope", "status"
        FROM "statistic_commune_snapshot"
        ORDER BY "snapshotDate", "scope"
      `);
      expect(afterReconciliation).toEqual([
        { snapshotDate: '9998-01-01', scope: 'national', status: 'failed' },
        { snapshotDate: '9998-01-02', scope: 'national', status: 'ready' },
        { snapshotDate: '9998-01-03', scope: 'bootstrap', status: 'ready' },
        { snapshotDate: '9998-01-04', scope: 'national', status: 'ready' },
      ]);

      await runner.query(`
        INSERT INTO "statistic_commune_snapshot" (
          "snapshotDate", "scope", "status", "sourceRevision"
        ) VALUES
          ('9998-01-05', 'national', 'ready', 5),
          ('9998-01-06', 'national', 'ready', 6),
          ('9998-01-07', 'national', 'ready', 7);
        INSERT INTO "zone_publication" (
          "id", "status", "sourceRevision", "sourceComputedAt"
        ) VALUES
          ('00000000-0000-4000-8000-000000000006', 'building', 5, '9998-01-05 08:00+00'),
          ('00000000-0000-4000-8000-000000000007', 'building', 6, '9998-01-06 08:00+00'),
          ('00000000-0000-4000-8000-000000000008', 'validated', 6, '9998-01-06 09:00+00');
        UPDATE "zone_publication"
        SET "status" = 'failed'
        WHERE "id" = '00000000-0000-4000-8000-000000000006';
        UPDATE "zone_publication"
        SET "status" = 'superseded'
        WHERE "id" = '00000000-0000-4000-8000-000000000007';
        INSERT INTO "zone_publication" (
          "id", "status", "sourceRevision", "sourceComputedAt"
        ) VALUES (
          '00000000-0000-4000-8000-000000000009',
          'failed', 7, '9998-01-07 08:00+00'
        )
      `);

      const afterRuntimeTransitions = await runner.query(`
        SELECT "snapshotDate"::text AS "snapshotDate", "status"
        FROM "statistic_commune_snapshot"
        WHERE "snapshotDate" >= '9998-01-05'
        ORDER BY "snapshotDate"
      `);
      expect(afterRuntimeTransitions).toEqual([
        { snapshotDate: '9998-01-05', status: 'failed' },
        { snapshotDate: '9998-01-06', status: 'ready' },
        { snapshotDate: '9998-01-07', status: 'failed' },
      ]);

      await migration.down(runner);
      const restored = await runner.query(`
        SELECT COUNT(*)::integer AS "failedCount"
        FROM "statistic_commune_snapshot"
        WHERE "status" = 'failed'
      `);
      expect(restored).toEqual([{ failedCount: 0 }]);

      await runner.query(`
        INSERT INTO "statistic_commune_snapshot" (
          "snapshotDate", "scope", "status", "sourceRevision"
        ) VALUES ('9998-01-08', 'national', 'ready', 8);
        INSERT INTO "zone_publication" (
          "id", "status", "sourceRevision", "sourceComputedAt"
        ) VALUES (
          '00000000-0000-4000-8000-000000000010',
          'failed', 8, '9998-01-08 08:00+00'
        )
      `);
      const [afterRollback] = await runner.query(`
        SELECT "status"
        FROM "statistic_commune_snapshot"
        WHERE "snapshotDate" = '9998-01-08'
          AND "scope" = 'national'
      `);
      expect(afterRollback.status).toBe('ready');
    } finally {
      await runner.query('SET search_path TO public');
      await runner.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await runner.release();
    }
  });
});
