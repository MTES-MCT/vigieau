import { DataSource } from 'typeorm';
import { ZoneAlerteComputedService } from './zone_alerte_computed.service';

jest.mock('moment', () => {
  const momentModule = jest.requireActual('moment');
  return { __esModule: true, default: momentModule };
});

const postgresUrl = process.env.STATISTIC_CACHE_ARTIFACT_POSTGRES_URL;
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres('Historic statistic boundary PostgreSQL recovery', () => {
  const schemaName = `statistic_boundary_${process.pid}_${Date.now()}`;
  let bootstrapDataSource: DataSource;
  let dataSource: DataSource;
  let service: ZoneAlerteComputedService;
  const statisticCommuneService = {
    computeByMonth: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    bootstrapDataSource = await new DataSource({
      type: 'postgres',
      url: postgresUrl,
      synchronize: false,
      logging: false,
    }).initialize();
    await bootstrapDataSource.query(`CREATE SCHEMA "${schemaName}"`);
    dataSource = await new DataSource({
      type: 'postgres',
      url: postgresUrl,
      synchronize: false,
      logging: false,
      extra: { options: `-c search_path=${schemaName},public` },
    }).initialize();
    await dataSource.query(`
      CREATE TABLE "zone_publication_source_state" (
        "id" integer PRIMARY KEY,
        "revision" bigint NOT NULL
      );
      CREATE TABLE "config" (
        "id" integer PRIMARY KEY,
        "computeMapDate" date,
        "computeStatsDate" date,
        "computeMapGeneration" bigint NOT NULL,
        "computeStatsGeneration" bigint NOT NULL,
        "historicComputeEpoch" bigint NOT NULL
      );
      CREATE TABLE "statistic_publication_state" (
        "id" integer PRIMARY KEY,
        "revision" bigint NOT NULL,
        "currentPublishedDate" date,
        "historicPublishedThrough" date,
        "historicDirtyFrom" date,
        "historicDirtyThrough" date,
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE "statistic_cache_publication" (
        "id" uuid PRIMARY KEY,
        "statisticRevision" bigint NOT NULL,
        "mode" varchar NOT NULL,
        "currentPublishedDate" date NOT NULL,
        "historicDirtyFrom" date,
        "historicDirtyThrough" date,
        "historicMapCursor" date,
        "historicStatsCursor" date,
        "sourceRevision" bigint,
        "historicComputeEpoch" bigint,
        "status" varchar NOT NULL
      );
      CREATE TABLE "statistic_cache_state" (
        "id" integer PRIMARY KEY,
        "activePublicationId" uuid,
        "previousPublicationId" uuid,
        "historicRecoveryMonthlyFrom" date,
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE "statistic_commune_snapshot" (
        "snapshotDate" date NOT NULL,
        "scope" varchar(500) NOT NULL,
        "status" varchar(20) NOT NULL,
        "expectedCommuneCount" integer NOT NULL,
        "processedCommuneCount" integer NOT NULL,
        "sourceRevision" bigint,
        "completedAt" timestamptz,
        "lastError" text,
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("snapshotDate", "scope")
      );
      CREATE TABLE "commune" (
        "id" varchar PRIMARY KEY
      );
      CREATE TABLE "statistic_commune" (
        "communeId" varchar PRIMARY KEY,
        "restrictions" jsonb NOT NULL
      );
      INSERT INTO "zone_publication_source_state" VALUES (1, 42);
      INSERT INTO "config" VALUES (
        1, date '2026-08-10', date '2026-08-10', 4, 6, 7
      );
      INSERT INTO "statistic_publication_state" VALUES (
        1, 10, date '2026-08-15', date '2026-08-09', NULL, NULL, now()
      );
      INSERT INTO "statistic_cache_state" VALUES (1, NULL, NULL, NULL, now());
      INSERT INTO "statistic_commune_snapshot" VALUES (
        date '2026-08-10', 'departements:02', 'completed', 3, 2, 41,
        now(), NULL, now()
      );
      INSERT INTO "statistic_commune_snapshot" VALUES (
        date '2026-08-09', 'departements:03', 'completed', 3, 3, 41,
        now(), NULL, now()
      );
      INSERT INTO "commune" VALUES ('01001');
      INSERT INTO "statistic_commune" ("communeId", "restrictions")
      SELECT
        '01001',
        jsonb_agg(
          jsonb_build_object('date', day::date::text)
          ORDER BY day
        ) || jsonb_build_array(jsonb_build_object('date', 'date-inconnue'))
      FROM generate_series(
        date '2026-01-01',
        date '2026-08-10',
        interval '1 day'
      ) day;
    `);

    service = new ZoneAlerteComputedService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      statisticCommuneService as never,
      {} as never,
      dataSource,
      { setConfig: jest.fn() } as never,
      {} as never,
    );
    (service as any).runHistoricWorker = jest.fn(async () => {
      await dataSource.query(`
          UPDATE "statistic_commune_snapshot"
          SET "status" = 'completed', "completedAt" = now(),
              "lastError" = NULL, "updatedAt" = now()
          WHERE "snapshotDate" = date '2026-08-10';
          INSERT INTO "statistic_commune_snapshot" (
            "snapshotDate", "scope", "status", "expectedCommuneCount",
            "processedCommuneCount", "sourceRevision", "completedAt",
            "lastError", "updatedAt"
          ) VALUES (
            date '2026-08-10', 'national', 'completed', 3, 3, 42,
            now(), NULL, now()
          )
          ON CONFLICT ("snapshotDate", "scope") DO UPDATE SET
            "status" = 'completed', "expectedCommuneCount" = 3,
            "processedCommuneCount" = 3, "sourceRevision" = 42,
            "completedAt" = now(), "lastError" = NULL, "updatedAt" = now()
        `);
      return {
        mapCursor: '2026-08-10',
        statsCursor: '2026-08-10',
        mapGeneration: '4',
        statsGeneration: '6',
      };
    });
    (service as any).assertCurrentHistoricCursorState = jest
      .fn()
      .mockResolvedValue(undefined);
  }, 60_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    if (bootstrapDataSource?.isInitialized) {
      await bootstrapDataSource.query(
        `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`,
      );
      await bootstrapDataSource.destroy();
    }
  });

  it('prepares, nationally replays, reconciles, and clears a completed but corrupt sibling scope', async () => {
    await expect(
      service.prepareHistoricStatisticsPublication('2026-08-14', '42'),
    ).resolves.toMatchObject({
      status: 'prepared',
      historicDirtyFrom: '2026-08-10',
      historicDirtyThrough: '2026-08-14',
    });
    await expect(
      service.recoverIncompleteHistoricSnapshots('2026-08-14', '42'),
    ).resolves.toEqual(['2026-08-10']);

    const [sibling] = await dataSource.query(`
      SELECT
        "status", "expectedCommuneCount", "processedCommuneCount",
        "sourceRevision"::text AS "sourceRevision"
      FROM "statistic_commune_snapshot"
      WHERE "snapshotDate" = date '2026-08-10'
        AND "scope" = 'departements:02'
    `);
    expect(sibling).toEqual({
      status: 'completed',
      expectedCommuneCount: 3,
      processedCommuneCount: 3,
      sourceRevision: '42',
    });
    const [validHistoricSibling] = await dataSource.query(`
      SELECT "sourceRevision"::text AS "sourceRevision"
      FROM "statistic_commune_snapshot"
      WHERE "snapshotDate" = date '2026-08-09'
        AND "scope" = 'departements:03'
    `);
    expect(validHistoricSibling).toEqual({ sourceRevision: '41' });
    expect((service as any).runHistoricWorker).toHaveBeenCalledTimes(1);
    await expect(
      dataSource.query(
        `SELECT "historicRecoveryMonthlyFrom"::text AS "monthlyFrom"
         FROM "statistic_cache_state" WHERE "id" = 1`,
      ),
    ).resolves.toEqual([{ monthlyFrom: null }]);
    expect(statisticCommuneService.computeByMonth).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('validates JSON daily coverage without casting malformed legacy dates', async () => {
    await dataSource.query(`
      UPDATE "config"
      SET "computeMapDate" = date '2026-08-11',
          "computeStatsDate" = date '2026-08-11'
      WHERE "id" = 1;
      UPDATE "statistic_commune_snapshot"
      SET "status" = 'completed', "processedCommuneCount" = 3,
          "sourceRevision" = 42, "completedAt" = now(),
          "lastError" = NULL, "updatedAt" = now()
      WHERE "snapshotDate" = date '2026-08-10';
      INSERT INTO "statistic_commune_snapshot" (
        "snapshotDate", "scope", "status", "expectedCommuneCount",
        "processedCommuneCount", "sourceRevision", "completedAt",
        "lastError", "updatedAt"
      ) VALUES (
        date '2026-08-10', 'national', 'completed', 3, 3, 42,
        now(), NULL, now()
      )
      ON CONFLICT ("snapshotDate", "scope") DO UPDATE SET
        "status" = 'completed', "expectedCommuneCount" = 3,
        "processedCommuneCount" = 3, "sourceRevision" = 42,
        "completedAt" = now(), "lastError" = NULL, "updatedAt" = now()
    `);

    await expect(
      (service as any).assertHistoricCatchUpComplete(
        '2026-08-10',
        '42',
        '2026-08-09',
      ),
    ).resolves.toBeUndefined();
  }, 60_000);

  it('publishes the guarded historic range with text materialized guards', async () => {
    await dataSource.query(`
      UPDATE "config"
      SET "computeMapDate" = date '2026-08-14',
          "computeStatsDate" = date '2026-08-14',
          "computeMapGeneration" = 4,
          "computeStatsGeneration" = 6,
          "historicComputeEpoch" = 7
      WHERE "id" = 1;
      UPDATE "statistic_publication_state"
      SET "revision" = 11,
          "currentPublishedDate" = date '2026-08-15',
          "historicPublishedThrough" = date '2026-08-09',
          "historicDirtyFrom" = date '2026-08-10',
          "historicDirtyThrough" = date '2026-08-14',
          "updatedAt" = now()
      WHERE "id" = 1;
    `);

    await expect(
      (service as any).publishHistoricStatistics(
        '2026-08-14',
        '42',
        {
          statisticRevision: '11',
          currentPublishedDate: '2026-08-15',
        },
        {
          mapCursor: '2026-08-14',
          statsCursor: '2026-08-14',
          mapGeneration: '4',
          statsGeneration: '6',
        },
        '7',
      ),
    ).resolves.toBeUndefined();

    await expect(
      dataSource.query(`
        SELECT
          "revision"::text AS "revision",
          "historicPublishedThrough"::text AS "historicPublishedThrough",
          "historicDirtyFrom"::text AS "historicDirtyFrom",
          "historicDirtyThrough"::text AS "historicDirtyThrough"
        FROM "statistic_publication_state"
        WHERE "id" = 1
      `),
    ).resolves.toEqual([
      {
        revision: '12',
        historicPublishedThrough: '2026-08-14',
        historicDirtyFrom: null,
        historicDirtyThrough: null,
      },
    ]);
  }, 60_000);
});
