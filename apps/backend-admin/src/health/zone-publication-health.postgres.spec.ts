import { DataSource, QueryRunner } from 'typeorm';
import { ZonePublicationHealthService } from './zone-publication-health.service';

const postgresUrl = process.env.STATISTIC_COMMUNE_POSTGRES_URL;
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres('ZonePublicationHealthService PostgreSQL health', () => {
  let dataSource: DataSource;
  let queryRunner: QueryRunner;
  let service: ZonePublicationHealthService;

  const now = new Date('2026-08-03T00:30:00.000Z');
  const activePublicationId = 'b1c24878-0000-4000-8000-000000000001';
  const fingerprint = 'a'.repeat(64);
  const previousPublicationEnabled = process.env.ZONE_PUBLICATION_ENABLED;

  beforeAll(async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    dataSource = await new DataSource({
      type: 'postgres',
      url: postgresUrl,
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
        "revision" bigint NOT NULL,
        "updatedAt" timestamptz NOT NULL
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "zone_publication" (
        "id" uuid PRIMARY KEY,
        "status" varchar NOT NULL,
        "sourceRevision" bigint NOT NULL,
        "materializationVersion" integer NOT NULL,
        "sourceComputedAt" timestamptz NOT NULL,
        "zoneCount" integer NOT NULL,
        "communeLinkCount" integer NOT NULL,
        "contentFingerprint" varchar,
        "legacyPromotedAt" timestamptz,
        "promotionError" text,
        "createdAt" timestamptz NOT NULL,
        "validatedAt" timestamptz,
        "candidateAt" timestamptz
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "zone_publication_state" (
        "id" integer PRIMARY KEY,
        "activePublicationId" uuid,
        "candidatePublicationId" uuid,
        "candidateRequestedAt" timestamptz,
        "automaticPublishingPaused" boolean NOT NULL,
        "updatedAt" timestamptz NOT NULL
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "zone_publication_instance" (
        "instanceId" varchar PRIMARY KEY,
        "activePublicationId" uuid,
        "candidatePublicationId" uuid,
        "heartbeatAt" timestamptz NOT NULL,
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
        "expectedCommuneCount" integer NOT NULL,
        "processedCommuneCount" integer NOT NULL,
        "updatedAt" timestamptz NOT NULL,
        PRIMARY KEY ("snapshotDate", "scope")
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "statistic_publication_state" (
        "id" integer PRIMARY KEY,
        "currentPublishedDate" date,
        "historicPublishedThrough" date,
        "historicDirtyFrom" date,
        "historicDirtyThrough" date,
        "updatedAt" timestamptz NOT NULL
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "config" (
        "id" integer PRIMARY KEY,
        "computeMapDate" date,
        "computeStatsDate" date,
        "computeMapGeneration" bigint NOT NULL,
        "computeStatsGeneration" bigint NOT NULL,
        "computeMapUpdatedAt" timestamptz,
        "computeStatsUpdatedAt" timestamptz
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "external_publication_run" (
        "jobKey" varchar NOT NULL,
        "scheduledFor" date NOT NULL,
        "status" varchar NOT NULL,
        "metadata" jsonb NOT NULL,
        "updatedAt" timestamptz NOT NULL,
        PRIMARY KEY ("jobKey", "scheduledFor")
      ) ON COMMIT DROP;
    `);
    await queryRunner.query(`
      INSERT INTO "zone_publication_source_state"
        VALUES (1, 10, timestamptz '2026-08-03 00:10:00+00')
    `);
    await queryRunner.query(
      `
        INSERT INTO "zone_publication" (
          "id", "status", "sourceRevision", "materializationVersion",
          "sourceComputedAt", "zoneCount", "communeLinkCount",
          "contentFingerprint", "legacyPromotedAt", "promotionError",
          "createdAt", "validatedAt", "candidateAt"
        ) VALUES (
          $1, 'active', 10, 4, timestamptz '2026-08-03 12:00:00+00',
          20, 40, $2, timestamptz '2026-08-03 00:20:00+00', NULL,
          timestamptz '2026-08-03 00:00:00+00',
          timestamptz '2026-08-03 00:10:00+00',
          timestamptz '2026-08-03 00:15:00+00'
        )
      `,
      [activePublicationId, fingerprint],
    );
    await queryRunner.query(
      `
        INSERT INTO "zone_publication_state" VALUES (
          1, $1, NULL, NULL, false, timestamptz '2026-08-03 00:20:00+00'
        )
      `,
      [activePublicationId],
    );
    await queryRunner.query(
      `
        INSERT INTO "zone_publication_instance" VALUES
          (
            'api-1', $1, NULL, timestamptz '2026-08-03 00:29:50+00',
            NULL, 20, 40, $2
          ),
          (
            'api-2', $1, NULL, timestamptz '2026-08-03 00:29:50+00',
            NULL, 20, 40, $2
          )
      `,
      [activePublicationId, fingerprint],
    );
    await queryRunner.query(`
        INSERT INTO "statistic_commune_snapshot" VALUES (
          date '2026-08-03', 'national', 'completed', 10, 100, 100,
          timestamptz '2026-08-03 00:20:00+00'
        )
    `);
    await queryRunner.query(`
        INSERT INTO "statistic_publication_state" VALUES (
          1, date '2026-08-03', date '2026-08-02', NULL, NULL,
          timestamptz '2026-08-03 00:20:00+00'
        )
    `);
    await queryRunner.query(`
        INSERT INTO "config" VALUES (
          1, date '2026-08-02', date '2026-08-02', 12, 18,
          timestamptz '2026-08-03 00:20:00+00',
          timestamptz '2026-08-03 00:20:00+00'
        )
    `);
    await queryRunner.query(
      `
        INSERT INTO "external_publication_run" VALUES
          (
            'compute:national-daily', date '2026-08-03', 'succeeded',
            jsonb_build_object(
              'publicationId', $1::text,
              'sourceRevision', '10',
              'materializationVersion', 4
            ),
            timestamptz '2026-08-03 00:20:00+00'
          ),
          (
            'compute:historic-catchup', date '2026-08-03', 'succeeded',
            jsonb_build_object(
              'sourceRevision', '10',
              'materializationVersion', 4,
              'historicMapCursor', '2026-08-02',
              'historicStatsCursor', '2026-08-02',
              'historicMapGeneration', '12',
              'historicStatsGeneration', '18'
            ),
            timestamptz '2026-08-03 00:20:00+00'
          )
      `,
      [activePublicationId],
    );

    service = new ZonePublicationHealthService(
      {
        query: (sql: string, parameters?: unknown[]) =>
          queryRunner.query(sql, parameters),
      } as never,
      {
        get: (key: string) => {
          const values: Record<string, string> = {
            ZONE_PUBLICATION_INSTANCE_LEASE_SECONDS: '30',
            ZONE_PUBLICATION_MIN_READY_INSTANCES: '2',
            ZONE_PUBLICATION_HEALTH_PROGRESS_STALE_AFTER_SECONDS: '1800',
          };
          return values[key];
        },
      } as never,
      {
        getHealthStatus: async () => ({ status: 'healthy' }),
      } as never,
    );
  });

  async function makeActiveOutdatedAndProgressOld(): Promise<void> {
    await queryRunner.query(`
      UPDATE "zone_publication_source_state"
      SET "updatedAt" = timestamptz '2026-08-02 20:00:00+00';
      UPDATE "zone_publication_state"
      SET "updatedAt" = timestamptz '2026-08-02 20:00:00+00';
      UPDATE "statistic_publication_state"
      SET "updatedAt" = timestamptz '2026-08-02 20:00:00+00';
      UPDATE "statistic_commune_snapshot"
      SET "updatedAt" = timestamptz '2026-08-02 20:00:00+00';
      UPDATE "zone_publication"
      SET "sourceComputedAt" = timestamptz '2026-08-02 12:00:00+00',
          "createdAt" = timestamptz '2026-08-02 20:00:00+00',
          "validatedAt" = timestamptz '2026-08-02 20:00:00+00',
          "candidateAt" = timestamptz '2026-08-02 20:00:00+00';
      UPDATE "config"
      SET "computeMapUpdatedAt" = timestamptz '2026-08-02 20:00:00+00',
          "computeStatsUpdatedAt" = timestamptz '2026-08-02 20:00:00+00';
    `);
  }

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

  it('executes the real health query and accepts an exact certified run', async () => {
    await expect(service.getHealthStatus(now)).resolves.toMatchObject({
      status: 'healthy',
      serving: true,
      checks: {
        activeServing: true,
        activeCurrent: true,
        currentSnapshot: true,
        historicCursors: true,
        certifiedRun: true,
      },
    });
  });

  it('rejects a current snapshot certified for another source revision', async () => {
    await queryRunner.query(
      `UPDATE "statistic_commune_snapshot"
       SET "sourceRevision" = 9
       WHERE "snapshotDate" = date '2026-08-03'`,
    );

    await expect(service.getHealthStatus(now)).resolves.toMatchObject({
      status: 'updating',
      serving: true,
      checks: { currentStatistics: true, currentSnapshot: false },
    });
  });

  it.each([
    { label: 'the historic run is missing', mutation: 'delete' },
    { label: 'a cursor generation changed', mutation: 'generation' },
  ])('rejects certification when $label', async ({ mutation }) => {
    if (mutation === 'delete') {
      await queryRunner.query(
        `DELETE FROM "external_publication_run"
         WHERE "jobKey" = 'compute:historic-catchup'`,
      );
    } else {
      await queryRunner.query(
        `UPDATE "config" SET "computeMapGeneration" = 13 WHERE "id" = 1`,
      );
    }

    await expect(service.getHealthStatus(now)).resolves.toMatchObject({
      status: 'updating',
      serving: true,
      checks: {
        historicCursors: true,
        certifiedRun: false,
      },
    });
  });

  it('rejects serving health while any live instance is not ready', async () => {
    await queryRunner.query(
      `
        INSERT INTO "zone_publication_instance" VALUES (
          'api-3', NULL, NULL, timestamptz '2026-08-03 00:29:50+00',
          'preload failed', NULL, NULL, NULL
        )
      `,
    );

    await expect(service.getHealthStatus(now)).resolves.toMatchObject({
      status: 'stale',
      serving: false,
      checks: { activeServing: false },
    });
  });

  it('ignores recent snapshots outside the useful current or dirty range', async () => {
    await makeActiveOutdatedAndProgressOld();
    await queryRunner.query(`
      INSERT INTO "statistic_commune_snapshot" VALUES (
        date '2026-08-01', 'manual', 'completed', 10, 1, 1,
        timestamptz '2026-08-03 00:29:50+00'
      )
    `);

    await expect(service.getHealthStatus(now)).resolves.toMatchObject({
      status: 'stale',
      serving: true,
      checks: { recentProgress: false },
    });
  });

  it('accepts a current-source snapshot inside the dirty range as progress', async () => {
    await makeActiveOutdatedAndProgressOld();
    await queryRunner.query(`
      UPDATE "statistic_publication_state"
      SET "historicDirtyFrom" = date '2026-08-01',
          "historicDirtyThrough" = date '2026-08-01',
          "updatedAt" = timestamptz '2026-08-02 20:00:00+00';
      INSERT INTO "statistic_commune_snapshot" VALUES (
        date '2026-08-01', 'historic', 'running', 10, 100, 50,
        timestamptz '2026-08-03 00:29:50+00'
      )
    `);

    await expect(service.getHealthStatus(now)).resolves.toMatchObject({
      status: 'updating',
      serving: true,
      checks: { recentProgress: true },
    });
  });

  it('ignores a recent building publication from another business date', async () => {
    await makeActiveOutdatedAndProgressOld();
    await queryRunner.query(`
      INSERT INTO "zone_publication" (
        "id", "status", "sourceRevision", "materializationVersion",
        "sourceComputedAt", "zoneCount", "communeLinkCount",
        "contentFingerprint", "legacyPromotedAt", "promotionError",
        "createdAt", "validatedAt", "candidateAt"
      ) VALUES (
        'b1c24878-0000-4000-8000-000000000002', 'building', 10, 4,
        timestamptz '2026-08-01 12:00:00+00', 0, 0, NULL, NULL, NULL,
        timestamptz '2026-08-03 00:29:50+00', NULL, NULL
      )
    `);

    await expect(service.getHealthStatus(now)).resolves.toMatchObject({
      status: 'stale',
      serving: true,
      checks: { recentProgress: false },
    });
  });

  it.each([
    ['recent', '2026-08-03 00:29:50+00', 'updating'],
    ['stale', '2026-08-02 20:00:00+00', 'stale'],
  ])(
    'uses a %s cursor CAS during the current historic run as progress',
    async (_label, cursorUpdatedAt, expectedStatus) => {
      await makeActiveOutdatedAndProgressOld();
      await queryRunner.query(`
        UPDATE "external_publication_run"
        SET "status" = 'running',
            "updatedAt" = timestamptz '2026-08-02 20:00:00+00'
        WHERE "jobKey" = 'compute:historic-catchup'
      `);
      await queryRunner.query(
        `UPDATE "config"
         SET "computeMapUpdatedAt" = $1::timestamptz
         WHERE "id" = 1`,
        [cursorUpdatedAt],
      );

      await expect(service.getHealthStatus(now)).resolves.toMatchObject({
        status: expectedStatus,
        serving: true,
        checks: { recentProgress: expectedStatus === 'updating' },
      });
    },
  );

  it('ignores a cursor timestamp when the running job has another identity', async () => {
    await makeActiveOutdatedAndProgressOld();
    await queryRunner.query(`
      UPDATE "external_publication_run"
      SET "status" = 'running',
          "metadata" = "metadata" || '{"sourceRevision":"9"}'::jsonb,
          "updatedAt" = timestamptz '2026-08-02 20:00:00+00'
      WHERE "jobKey" = 'compute:historic-catchup';
      UPDATE "config"
      SET "computeMapUpdatedAt" = timestamptz '2026-08-03 00:29:50+00'
      WHERE "id" = 1
    `);

    await expect(service.getHealthStatus(now)).resolves.toMatchObject({
      status: 'stale',
      serving: true,
      checks: { recentProgress: false },
    });
  });
});
