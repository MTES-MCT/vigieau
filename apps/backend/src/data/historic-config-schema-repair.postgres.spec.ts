import { DataSource } from 'typeorm';
import { Config } from '@shared/entities/config.entity';
import { HistoricCursorGeneration1786032000000 } from '../../../backend-admin/src/migrations/1786032000000-HistoricCursorGeneration';
import { HistoricCursorProgress1786132800000 } from '../../../backend-admin/src/migrations/1786132800000-HistoricCursorProgress';
import { HistoricDepartmentCheckpoint1786219200000 } from '../../../backend-admin/src/migrations/1786219200000-HistoricDepartmentCheckpoint';
import { StatisticCachePublication1786744800000 } from '../../../backend-admin/src/migrations/1786744800000-StatisticCachePublication';
import { HistoricConfigSchemaRepair1786831200000 } from '../../../backend-admin/src/migrations/1786831200000-HistoricConfigSchemaRepair';
import { DataService } from './data.service';
import { StatisticCacheArtifactService } from './statistic-cache-artifact.service';

const postgresUrl = process.env.STATISTIC_CACHE_ARTIFACT_POSTGRES_URL;
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres(
  'Historic config schema drift recovery on PostgreSQL',
  () => {
    const schemaName = `historic_config_repair_${process.pid}_${Date.now()}`;
    let bootstrapDataSource: DataSource;
    let dataSource: DataSource;

    const dataSourceOptions = {
      type: 'postgres' as const,
      url: postgresUrl,
      synchronize: false,
      logging: false,
      extra: { options: `-c search_path=${schemaName},public` },
    };

    beforeAll(async () => {
      bootstrapDataSource = await new DataSource({
        type: 'postgres',
        url: postgresUrl,
        synchronize: false,
        logging: false,
      }).initialize();
      await bootstrapDataSource.query(`CREATE SCHEMA "${schemaName}"`);
    });

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

    it('repairs an applied migration ledger before artifact and runtime reads', async () => {
      const historicMigrations = [
        HistoricCursorGeneration1786032000000,
        HistoricCursorProgress1786132800000,
        HistoricDepartmentCheckpoint1786219200000,
        StatisticCachePublication1786744800000,
      ];
      const legacyDataSource = await new DataSource({
        ...dataSourceOptions,
        entities: [],
        migrations: historicMigrations,
        migrationsTransactionMode: 'each',
      }).initialize();
      await legacyDataSource.query(`
      CREATE TABLE "departement" (
        "id" SERIAL PRIMARY KEY
      );
      INSERT INTO "departement" ("id") VALUES (1);
      CREATE TABLE "config" (
        "id" integer PRIMARY KEY DEFAULT 1,
        "computeMapDate" date,
        "computeStatsDate" date,
        "computeZoneAlerteComputedDate" timestamp
      );
      INSERT INTO "config" (
        "id", "computeMapDate", "computeStatsDate",
        "computeZoneAlerteComputedDate"
      ) VALUES (
        1, DATE '2011-11-14', DATE '2011-11-14',
        TIMESTAMP '2026-08-05 14:28:10.881'
      );
      CREATE TABLE "zone_publication_instance" (
        "instanceId" character varying(200) PRIMARY KEY,
        "heartbeatAt" timestamp with time zone NOT NULL DEFAULT now()
      );
      CREATE TABLE "zone_publication_state" (
        "id" integer PRIMARY KEY,
        "activePublicationId" uuid
      );
      INSERT INTO "zone_publication_state" VALUES (1, NULL);
      CREATE TABLE "zone_publication_source_state" (
        "id" integer PRIMARY KEY,
        "revision" bigint NOT NULL DEFAULT 0
      );
      INSERT INTO "zone_publication_source_state" VALUES (1, 42);
      CREATE TABLE "statistic_publication_state" (
        "id" integer PRIMARY KEY,
        "revision" bigint NOT NULL DEFAULT 0,
        "currentPublishedDate" date,
        "historicPublishedThrough" date,
        "historicDirtyFrom" date,
        "historicDirtyThrough" date
      );
      INSERT INTO "statistic_publication_state" VALUES (
        1, 9, DATE '2026-08-14', DATE '2011-11-13',
        DATE '2011-11-14', DATE '2026-08-13'
      );
      CREATE TABLE "current_zone_recompute_request" (
        "departementId" integer PRIMARY KEY
      );
      CREATE TABLE "statistic_commune_snapshot" (
        "snapshotDate" date NOT NULL,
        "scope" character varying(500) NOT NULL,
        "status" character varying(20) NOT NULL,
        "expectedCommuneCount" integer NOT NULL,
        "processedCommuneCount" integer NOT NULL DEFAULT 0,
        "sourceRevision" bigint,
        PRIMARY KEY ("snapshotDate", "scope")
      );
    `);

      const historicApplied = await legacyDataSource.runMigrations({
        transaction: 'each',
      });
      expect(historicApplied.map(({ name }) => name)).toEqual([
        'HistoricCursorGeneration1786032000000',
        'HistoricCursorProgress1786132800000',
        'HistoricDepartmentCheckpoint1786219200000',
        'StatisticCachePublication1786744800000',
      ]);
      await legacyDataSource.query(`
        ALTER TABLE "statistic_cache_publication"
          ADD COLUMN "protocolVersion" integer NOT NULL DEFAULT 1;
        ALTER TABLE "statistic_cache_state"
          ADD COLUMN "candidatePublicationId" uuid
      `);
      await legacyDataSource.query(`
      INSERT INTO "historic_department_checkpoint" (
        "computedFor", "departementId", "historicComputeEpoch",
        "sourceRevision", "materializationVersion", "inputSignature",
        "outputSignature", "zoneCount"
      ) VALUES
        (
          DATE '2026-08-12', 1, 0, '16', 'historic-v1',
          repeat('a', 64), repeat('b', 64), 1
        ),
        (
          DATE '2026-08-13', 1, 1, '441', 'historic-v1',
          repeat('c', 64), repeat('d', 64), 1
        )
    `);
      await legacyDataSource.query(`
      ALTER TABLE "config"
        DROP COLUMN "computeMapGeneration",
        DROP COLUMN "computeStatsGeneration",
        DROP COLUMN "computeMapUpdatedAt",
        DROP COLUMN "computeStatsUpdatedAt",
        DROP COLUMN "historicComputeEpoch"
    `);
      await legacyDataSource.destroy();

      dataSource = await new DataSource({
        ...dataSourceOptions,
        entities: [Config],
        migrations: [
          ...historicMigrations,
          HistoricConfigSchemaRepair1786831200000,
        ],
        migrationsTransactionMode: 'each',
      }).initialize();
      const artifactService = new StatisticCacheArtifactService(dataSource);
      const runtimeService = new DataService(
        undefined as any,
        undefined as any,
        undefined as any,
        undefined as any,
        undefined as any,
        dataSource,
        artifactService,
      );

      await expect(
        dataSource.getRepository(Config).findOneBy({ id: 1 }),
      ).rejects.toThrow(/computeMapGeneration/);
      await expect(
        (runtimeService as any).readPublicationState(dataSource),
      ).rejects.toThrow(/historicComputeEpoch/);

      const repaired = await dataSource.runMigrations({ transaction: 'each' });
      expect(repaired.map(({ name }) => name)).toEqual([
        'HistoricConfigSchemaRepair1786831200000',
      ]);

      const columns = await dataSource.query(`
      SELECT
        "column_name" AS "columnName",
        "data_type" AS "dataType",
        "is_nullable" AS "isNullable",
        "column_default" AS "columnDefault"
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'config'
        AND "column_name" IN (
          'computeMapGeneration',
          'computeStatsGeneration',
          'computeMapUpdatedAt',
          'computeStatsUpdatedAt',
          'historicComputeEpoch'
        )
      ORDER BY "column_name"
    `);
      expect(columns).toEqual([
        {
          columnName: 'computeMapGeneration',
          dataType: 'bigint',
          isNullable: 'NO',
          columnDefault: '0',
        },
        {
          columnName: 'computeMapUpdatedAt',
          dataType: 'timestamp with time zone',
          isNullable: 'YES',
          columnDefault: null,
        },
        {
          columnName: 'computeStatsGeneration',
          dataType: 'bigint',
          isNullable: 'NO',
          columnDefault: '0',
        },
        {
          columnName: 'computeStatsUpdatedAt',
          dataType: 'timestamp with time zone',
          isNullable: 'YES',
          columnDefault: null,
        },
        {
          columnName: 'historicComputeEpoch',
          dataType: 'bigint',
          isNullable: 'NO',
          columnDefault: '0',
        },
      ]);
      await expect(
        dataSource.getRepository(Config).findOneByOrFail({ id: 1 }),
      ).resolves.toMatchObject({
        computeMapDate: '2011-11-14',
        computeStatsDate: '2011-11-14',
        computeMapGeneration: '0',
        computeStatsGeneration: '0',
        computeMapUpdatedAt: null,
        computeStatsUpdatedAt: null,
        historicComputeEpoch: '2',
      });
      await expect(
        (runtimeService as any).readPublicationState(dataSource),
      ).resolves.toMatchObject({
        revision: '9',
        statisticCachePublicationId: null,
        currentPublishedDate: '2026-08-14',
        historicMapCursor: '2011-11-14',
        historicStatsCursor: '2011-11-14',
        sourceRevision: '42',
        historicComputeEpoch: '2',
      });
      await expect(artifactService.loadActive()).resolves.toBeNull();

      const runRepair = async () => {
        const runner = dataSource.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        try {
          await new HistoricConfigSchemaRepair1786831200000().up(runner);
          await runner.commitTransaction();
        } catch (error) {
          await runner.rollbackTransaction();
          throw error;
        } finally {
          await runner.release();
        }
      };

      await runRepair();
      const [replayed] = await dataSource.query(`
          SELECT "historicComputeEpoch"::text AS "historicComputeEpoch"
          FROM "config"
          WHERE "id" = 1
      `);
      expect(replayed.historicComputeEpoch).toBe('2');
      await dataSource.query(`
          UPDATE "config"
          SET "historicComputeEpoch" = 41
          WHERE "id" = 1
      `);
      await runRepair();
      await expect(
        dataSource.getRepository(Config).findOneByOrFail({ id: 1 }),
      ).resolves.toMatchObject({
        computeMapGeneration: '0',
        computeStatsGeneration: '0',
        historicComputeEpoch: '41',
      });

      await dataSource.query(`
        ALTER TABLE "config"
          ALTER COLUMN "historicComputeEpoch" DROP NOT NULL,
          ALTER COLUMN "historicComputeEpoch" DROP DEFAULT;
        UPDATE "config"
        SET "historicComputeEpoch" = NULL
        WHERE "id" = 1
      `);
      await runRepair();
      await expect(
        dataSource.getRepository(Config).findOneByOrFail({ id: 1 }),
      ).resolves.toMatchObject({ historicComputeEpoch: '2' });
      const [partialRepairColumn] = await dataSource.query(`
        SELECT
          "is_nullable" AS "isNullable",
          "column_default" AS "columnDefault"
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'config'
          AND column_name = 'historicComputeEpoch'
      `);
      expect(partialRepairColumn).toEqual({
        isNullable: 'NO',
        columnDefault: '0',
      });

      await dataSource.query('DELETE FROM "config"');
      await runRepair();
      await expect(
        dataSource.getRepository(Config).findOneByOrFail({ id: 1 }),
      ).resolves.toMatchObject({
        id: 1,
        computeMapGeneration: '0',
        computeStatsGeneration: '0',
        historicComputeEpoch: '2',
      });
      await expect(
        (runtimeService as any).readPublicationState(dataSource),
      ).resolves.toMatchObject({
        historicMapCursor: null,
        historicStatsCursor: null,
        historicComputeEpoch: '2',
      });
      await new HistoricConfigSchemaRepair1786831200000().down();
    }, 60_000);
  },
);
