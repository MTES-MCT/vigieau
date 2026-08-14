import { DataSource } from 'typeorm';
import { ArreteRestrictionService } from './arrete_restriction.service';

const postgresUrl = process.env.STATISTIC_COMMUNE_POSTGRES_URL;
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres(
  'Current daily computation PostgreSQL postcondition',
  () => {
    let bootstrapDataSource: DataSource;
    let dataSource: DataSource | undefined;
    let schemaName: string;
    let service: ArreteRestrictionService;

    beforeAll(async () => {
      bootstrapDataSource = await new DataSource({
        type: 'postgres',
        url: postgresUrl,
        synchronize: false,
        logging: false,
      }).initialize();
    });

    beforeEach(async () => {
      schemaName = `daily_postcondition_${process.pid}_${Date.now()}`;
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
      CREATE TABLE "statistic_publication_state" (
        "id" integer PRIMARY KEY,
        "currentPublishedDate" date
      );
      CREATE TABLE "statistic_commune_snapshot" (
        "snapshotDate" date NOT NULL,
        "scope" varchar NOT NULL,
        "status" varchar NOT NULL,
        "expectedCommuneCount" integer NOT NULL,
        "processedCommuneCount" integer NOT NULL,
        "sourceRevision" bigint,
        PRIMARY KEY ("snapshotDate", "scope")
      );
      CREATE TABLE "commune" ("id" integer PRIMARY KEY);
      CREATE TABLE "departement" (
        "id" integer PRIMARY KEY,
        "code" varchar NOT NULL UNIQUE
      );
      CREATE TABLE "statistic_departement" (
        "departementId" integer PRIMARY KEY,
        "restrictions" jsonb
      );
      CREATE TABLE "statistic" (
        "date" date PRIMARY KEY,
        "departementSituation" json
      );
      CREATE TABLE "current_zone_recompute_request" (
        "departementId" integer PRIMARY KEY
      );

      INSERT INTO "zone_publication_source_state" VALUES (1, 42);
      INSERT INTO "statistic_publication_state" VALUES (1, '2026-08-14');
      INSERT INTO "statistic_commune_snapshot" VALUES (
        '2026-08-14', 'national', 'completed', 34943, 34943, 42
      );
      INSERT INTO "commune" SELECT value FROM generate_series(1, 34943) value;
      INSERT INTO "departement"
      SELECT value, lpad(value::text, 3, '0')
      FROM generate_series(1, 101) value;
      INSERT INTO "statistic_departement"
      SELECT
        "id",
        jsonb_build_array(jsonb_build_object('date', '2026-08-14'))
      FROM "departement";
      INSERT INTO "statistic"
      SELECT
        date '2026-08-14',
        jsonb_object_agg("code", jsonb_build_object('max', NULL))::json
      FROM "departement";
    `);
      service = new ArreteRestrictionService(
        { manager: dataSource } as never,
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
      );
    });

    afterEach(async () => {
      if (dataSource?.isInitialized) {
        await dataSource.destroy();
      }
      if (bootstrapDataSource?.isInitialized && schemaName) {
        await bootstrapDataSource.query(
          `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`,
        );
      }
    });

    afterAll(async () => {
      if (bootstrapDataSource?.isInitialized) {
        await bootstrapDataSource.destroy();
      }
    });

    it('requires the certified 34943/34943 snapshot, 101 departments and an empty queue', async () => {
      await expect(
        service.assertLegacyDailyComputationCompleted('2026-08-14'),
      ).resolves.toEqual({ sourceRevision: '42' });

      await dataSource!.query(
        `INSERT INTO "current_zone_recompute_request" VALUES (65)`,
      );
      await expect(
        service.assertLegacyDailyComputationCompleted('2026-08-14'),
      ).rejects.toThrow('queue=1');
    });

    it('keeps the versioned ready snapshot behind its activation barrier', async () => {
      await dataSource!.query(`
      DELETE FROM "current_zone_recompute_request";
      UPDATE "statistic_commune_snapshot" SET "status" = 'ready';
      UPDATE "statistic_publication_state"
      SET "currentPublishedDate" = '2026-08-13';
    `);

      await expect(
        service.assertVersionedDailyComputationReady('2026-08-14', '42'),
      ).resolves.toBeUndefined();
    });
  },
);
