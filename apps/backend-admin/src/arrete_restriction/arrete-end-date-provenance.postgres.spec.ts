import { DataSource, QueryRunner } from 'typeorm';
import { ArreteCadreService } from '../arrete_cadre/arrete_cadre.service';
import { ArreteEndDateProvenance1786305600000 } from '../migrations/1786305600000-ArreteEndDateProvenance';
import { ArreteRestrictionService } from './arrete_restriction.service';

const postgresUrl = process.env.ARRETE_CONTINUITY_POSTGRES_URL;
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres('ArreteEndDateProvenance PostgreSQL migration', () => {
  let dataSource: DataSource;
  let queryRunner: QueryRunner;

  interface CapturedQuery {
    sql: string;
    parameters: unknown[];
  }

  jest.setTimeout(30_000);

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      url: postgresUrl,
      synchronize: false,
      logging: false,
    }).initialize();
    queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
  });

  afterAll(async () => {
    if (queryRunner) {
      await queryRunner.release();
    }
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  async function captureRestrictionSchedulerQuery(): Promise<CapturedQuery> {
    let capturedQuery: CapturedQuery | undefined;
    const repository = {
      query: jest.fn(async (sql: string, parameters: unknown[]) => {
        capturedQuery = { sql, parameters };
        return [];
      }),
    };
    const manager = {
      getRepository: jest.fn(() => repository),
      query: jest.fn().mockResolvedValue([]),
    };
    const rootRepository = {
      manager: {
        transaction: jest.fn(
          async (
            _isolation: string,
            callback: (transactionManager: typeof manager) => Promise<unknown>,
          ) => callback(manager),
        ),
      },
    };
    const service = new ArreteRestrictionService(
      rootRepository as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      { askCompute: jest.fn().mockResolvedValue(undefined) } as never,
      {
        computeDepartementStatistics: jest.fn().mockResolvedValue(undefined),
      } as never,
      undefined as never,
      { setConfig: jest.fn().mockResolvedValue(undefined) } as never,
      undefined as never,
    );
    jest
      .spyOn(service, 'processPendingCurrentZoneRecomputes')
      .mockResolvedValue(undefined);

    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
    try {
      await service.updateArreteRestrictionStatut(undefined, false);
    } finally {
      jest.useRealTimers();
    }

    if (!capturedQuery) {
      throw new Error(
        'Restriction scheduler did not issue its candidate query',
      );
    }
    return capturedQuery;
  }

  async function captureFrameworkSchedulerQuery(): Promise<CapturedQuery> {
    let capturedQuery: CapturedQuery | undefined;
    const repository = {
      query: jest.fn(async (sql: string, parameters: unknown[]) => {
        capturedQuery = { sql, parameters };
        return [];
      }),
    };
    const manager = { getRepository: jest.fn(() => repository) };
    const rootRepository = {
      manager: {
        transaction: jest.fn(
          async (
            _isolation: string,
            callback: (transactionManager: typeof manager) => Promise<unknown>,
          ) => callback(manager),
        ),
      },
    };
    const restrictionService = {
      updateArreteRestrictionStatut: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ArreteCadreService(
      rootRepository as never,
      restrictionService as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
    try {
      await service.updateArreteCadreStatut(false);
    } finally {
      jest.useRealTimers();
    }

    if (!capturedQuery) {
      throw new Error('Framework scheduler did not issue its candidate query');
    }
    return capturedQuery;
  }

  it('migrates and rolls back provenance in an isolated schema', async () => {
    const schemaName = `arrete_continuity_${process.pid}_${Date.now()}`;
    const quotedSchema = `"${schemaName}"`;
    const migration = new ArreteEndDateProvenance1786305600000();
    let migrated = false;
    let rolledBack = false;

    await queryRunner.query(`CREATE SCHEMA ${quotedSchema}`);

    try {
      await queryRunner.query(`SET search_path TO ${quotedSchema}, public`);
      await queryRunner.query(`
        CREATE TABLE "arrete_restriction" (
          "id" integer PRIMARY KEY,
          "dateDebut" date,
          "dateFin" date,
          "statut" varchar NOT NULL,
          "arreteRestrictionAbrogeId" integer
        );
        CREATE TABLE "arrete_cadre" (
          "id" integer PRIMARY KEY,
          "dateDebut" date,
          "dateFin" date,
          "statut" varchar NOT NULL,
          "arreteCadreAbrogeId" integer
        );
        CREATE TABLE "arrete_cadre_arrete_restriction" (
          "arreteCadreId" integer NOT NULL,
          "arreteRestrictionId" integer NOT NULL,
          PRIMARY KEY ("arreteCadreId", "arreteRestrictionId")
        )
      `);

      await queryRunner.query(`
        INSERT INTO "arrete_restriction" (
          "id", "dateDebut", "dateFin", "statut",
          "arreteRestrictionAbrogeId"
        ) VALUES
          (100, date '2026-07-01', date '2026-08-03', 'publie', NULL),
          (101, date '2026-08-04', NULL, 'publie', 100),
          (110, date '2026-07-01', date '2026-08-03', 'publie', NULL),
          (111, date '2026-08-04', NULL, 'a_valider', 110),
          (120, date '2026-07-01', date '2026-08-03', 'a_valider', NULL),
          (121, date '2026-08-04', NULL, 'publie', 120),
          (130, date '2026-07-01', date '2026-08-05', 'publie', NULL),
          (140, date '2026-07-01', date '2026-08-05', 'publie', NULL),
          (150, date '2026-07-01', date '2026-08-05', 'a_valider', NULL),
          (160, date '2026-07-01', date '2026-08-12', 'publie', NULL);

        INSERT INTO "arrete_cadre" (
          "id", "dateDebut", "dateFin", "statut", "arreteCadreAbrogeId"
        ) VALUES
          (200, date '2026-07-01', date '2026-08-05', 'publie', NULL),
          (201, date '2026-07-01', date '2026-08-05', 'a_valider', NULL),
          (210, date '2026-07-01', date '2026-08-03', 'publie', NULL),
          (211, date '2026-08-04', NULL, 'publie', 210),
          (220, date '2026-07-01', date '2026-08-03', 'publie', NULL),
          (221, date '2026-08-04', NULL, 'a_valider', 220),
          (230, date '2026-07-01', date '2026-08-03', 'a_valider', NULL),
          (231, date '2026-08-04', NULL, 'publie', 230);

        INSERT INTO "arrete_cadre_arrete_restriction" (
          "arreteCadreId", "arreteRestrictionId"
        ) VALUES
          (200, 130),
          (201, 140),
          (200, 150)
      `);

      await migration.up(queryRunner);
      migrated = true;

      const columns = (await queryRunner.query(
        `
          SELECT
            "table_name" AS "tableName",
            "column_name" AS "columnName",
            "data_type" AS "dataType",
            "is_nullable" AS "isNullable",
            "column_default" AS "columnDefault"
          FROM information_schema.columns
          WHERE "table_schema" = $1
            AND "table_name" IN ('arrete_restriction', 'arrete_cadre')
            AND "column_name" IN (
              'dateFinSaisie', 'dateFinCalculee', 'dateFinSaisieConnue'
            )
          ORDER BY "table_name", "column_name"
        `,
        [schemaName],
      )) as Array<{
        tableName: string;
        columnName: string;
        dataType: string;
        isNullable: string;
        columnDefault: string | null;
      }>;

      expect(columns).toHaveLength(6);
      for (const tableName of ['arrete_cadre', 'arrete_restriction']) {
        expect(columns).toEqual(
          expect.arrayContaining([
            {
              tableName,
              columnName: 'dateFinSaisie',
              dataType: 'date',
              isNullable: 'YES',
              columnDefault: null,
            },
            {
              tableName,
              columnName: 'dateFinCalculee',
              dataType: 'boolean',
              isNullable: 'NO',
              columnDefault: 'false',
            },
            {
              tableName,
              columnName: 'dateFinSaisieConnue',
              dataType: 'boolean',
              isNullable: 'NO',
              columnDefault: 'true',
            },
          ]),
        );
      }

      const indexes = (await queryRunner.query(
        `
          SELECT "tablename", "indexname", "indexdef"
          FROM pg_indexes
          WHERE "schemaname" = $1
            AND "indexname" IN (
              'IDX_arrete_restriction_replaced_order',
              'IDX_arrete_cadre_replaced_order'
            )
          ORDER BY "indexname"
        `,
        [schemaName],
      )) as Array<{
        tablename: string;
        indexname: string;
        indexdef: string;
      }>;

      expect(indexes).toHaveLength(2);
      expect(indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tablename: 'arrete_restriction',
            indexname: 'IDX_arrete_restriction_replaced_order',
            indexdef: expect.stringContaining(
              '("arreteRestrictionAbrogeId") WHERE ("arreteRestrictionAbrogeId" IS NOT NULL)',
            ),
          }),
          expect.objectContaining({
            tablename: 'arrete_cadre',
            indexname: 'IDX_arrete_cadre_replaced_order',
            indexdef: expect.stringContaining(
              '("arreteCadreAbrogeId") WHERE ("arreteCadreAbrogeId" IS NOT NULL)',
            ),
          }),
        ]),
      );

      const restrictionOrders = await queryRunner.query(`
        SELECT
          "id",
          "dateFinSaisie"::text AS "dateFinSaisie",
          "dateFinCalculee",
          "dateFinSaisieConnue"
        FROM "arrete_restriction"
        WHERE "id" IN (100, 110, 120, 130, 140, 150, 160)
        ORDER BY "id"
      `);
      expect(restrictionOrders).toEqual([
        {
          id: 100,
          dateFinSaisie: '2026-08-03',
          dateFinCalculee: true,
          dateFinSaisieConnue: false,
        },
        {
          id: 110,
          dateFinSaisie: null,
          dateFinCalculee: false,
          dateFinSaisieConnue: true,
        },
        {
          id: 120,
          dateFinSaisie: null,
          dateFinCalculee: false,
          dateFinSaisieConnue: true,
        },
        {
          id: 130,
          dateFinSaisie: '2026-08-05',
          dateFinCalculee: true,
          dateFinSaisieConnue: false,
        },
        {
          id: 140,
          dateFinSaisie: null,
          dateFinCalculee: false,
          dateFinSaisieConnue: true,
        },
        {
          id: 150,
          dateFinSaisie: null,
          dateFinCalculee: false,
          dateFinSaisieConnue: true,
        },
        {
          id: 160,
          dateFinSaisie: null,
          dateFinCalculee: false,
          dateFinSaisieConnue: true,
        },
      ]);

      const frameworkOrders = await queryRunner.query(`
        SELECT
          "id",
          "dateFinSaisie"::text AS "dateFinSaisie",
          "dateFinCalculee",
          "dateFinSaisieConnue"
        FROM "arrete_cadre"
        WHERE "id" IN (210, 220, 230)
        ORDER BY "id"
      `);
      expect(frameworkOrders).toEqual([
        {
          id: 210,
          dateFinSaisie: '2026-08-03',
          dateFinCalculee: true,
          dateFinSaisieConnue: false,
        },
        {
          id: 220,
          dateFinSaisie: null,
          dateFinCalculee: false,
          dateFinSaisieConnue: true,
        },
        {
          id: 230,
          dateFinSaisie: null,
          dateFinCalculee: false,
          dateFinSaisieConnue: true,
        },
      ]);

      await migration.down(queryRunner);
      rolledBack = true;

      const [{ provenanceColumnCount }] = await queryRunner.query(
        `
          SELECT COUNT(*)::integer AS "provenanceColumnCount"
          FROM information_schema.columns
          WHERE "table_schema" = $1
            AND "table_name" IN ('arrete_restriction', 'arrete_cadre')
            AND "column_name" IN (
              'dateFinSaisie', 'dateFinCalculee', 'dateFinSaisieConnue'
            )
        `,
        [schemaName],
      );
      expect(provenanceColumnCount).toBe(0);

      const [{ continuityIndexCount }] = await queryRunner.query(
        `
          SELECT COUNT(*)::integer AS "continuityIndexCount"
          FROM pg_indexes
          WHERE "schemaname" = $1
            AND "indexname" IN (
              'IDX_arrete_restriction_replaced_order',
              'IDX_arrete_cadre_replaced_order'
            )
        `,
        [schemaName],
      );
      expect(continuityIndexCount).toBe(0);

      const [{ restrictionCount }] = await queryRunner.query(
        `SELECT COUNT(*)::integer AS "restrictionCount" FROM "arrete_restriction"`,
      );
      expect(restrictionCount).toBe(10);
    } finally {
      if (migrated && !rolledBack) {
        await migration.down(queryRunner).catch(() => undefined);
      }
      await queryRunner.query(`SET search_path TO public`);
      await queryRunner.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    }
  });

  it('executes the scheduler candidate queries against PostgreSQL', async () => {
    const schemaName = `arrete_scheduler_${process.pid}_${Date.now()}`;
    const quotedSchema = `"${schemaName}"`;
    const migration = new ArreteEndDateProvenance1786305600000();
    let migrated = false;
    let rolledBack = false;

    await queryRunner.query(`CREATE SCHEMA ${quotedSchema}`);

    try {
      await queryRunner.query(`SET search_path TO ${quotedSchema}, public`);
      await queryRunner.query(`
        CREATE TABLE "arrete_restriction" (
          "id" integer PRIMARY KEY,
          "dateDebut" date,
          "dateFin" date,
          "statut" varchar NOT NULL,
          "departementId" integer,
          "arreteRestrictionAbrogeId" integer
        );
        CREATE TABLE "arrete_cadre" (
          "id" integer PRIMARY KEY,
          "dateDebut" date,
          "dateFin" date,
          "statut" varchar NOT NULL,
          "arreteCadreAbrogeId" integer
        );
        CREATE TABLE "arrete_cadre_arrete_restriction" (
          "arreteCadreId" integer NOT NULL,
          "arreteRestrictionId" integer NOT NULL,
          PRIMARY KEY ("arreteCadreId", "arreteRestrictionId")
        )
      `);

      await migration.up(queryRunner);
      migrated = true;

      await queryRunner.query(`
        INSERT INTO "arrete_cadre" (
          "id", "dateDebut", "dateFin", "statut", "arreteCadreAbrogeId"
        ) VALUES
          (400, date '2026-07-01', NULL, 'publie', NULL),
          (401, date '2026-08-10', NULL, 'a_venir', 400),
          (410, date '2026-07-01', date '2026-08-20', 'publie', NULL),
          (411, date '2026-08-10', NULL, 'a_venir', 410),
          (420, date '2026-07-01', date '2026-08-07', 'publie', NULL),
          (421, date '2026-08-10', NULL, 'a_venir', 420),
          (430, date '2026-07-01', NULL, 'publie', NULL),
          (431, date '2026-08-10', NULL, 'a_venir', 430),
          (440, date '2026-07-01', date '2026-08-03', 'abroge', NULL),
          (441, date '2026-08-10', NULL, 'a_venir', 440),
          (450, date '2026-07-10', NULL, 'publie', NULL),
          (451, date '2026-07-01', NULL, 'publie', 450),
          (460, date '2026-07-01', NULL, 'publie', 460),
          (470, date '2026-07-01', date '2026-08-09', 'publie', NULL),
          (471, date '2026-08-10', NULL, 'a_venir', 470),
          (472, date '2026-08-08', NULL, 'a_venir', 470),
          (900, date '2026-07-01', NULL, 'publie', NULL);

        INSERT INTO "arrete_restriction" (
          "id", "dateDebut", "dateFin", "statut", "departementId",
          "arreteRestrictionAbrogeId"
        ) VALUES
          (300, date '2026-07-01', NULL, 'publie', 53, NULL),
          (301, date '2026-08-10', NULL, 'a_venir', 53, 300),
          (310, date '2026-07-01', date '2026-08-20', 'publie', 53, NULL),
          (311, date '2026-08-10', NULL, 'a_venir', 53, 310),
          (320, date '2026-07-01', date '2026-08-07', 'publie', 53, NULL),
          (321, date '2026-08-10', NULL, 'a_venir', 53, 320),
          (330, date '2026-07-01', NULL, 'publie', 53, NULL),
          (331, date '2026-08-10', NULL, 'a_venir', 53, 330),
          (340, date '2026-07-01', date '2026-08-03', 'abroge', 53, NULL),
          (341, date '2026-08-10', NULL, 'a_venir', 53, 340),
          (350, date '2026-07-10', NULL, 'publie', 53, NULL),
          (351, date '2026-07-01', NULL, 'publie', 53, 350),
          (360, date '2026-07-01', NULL, 'publie', 53, 360),
          (370, date '2026-07-01', date '2026-08-09', 'publie', 53, NULL),
          (371, date '2026-08-10', NULL, 'a_venir', 53, 370),
          (372, date '2026-08-08', NULL, 'a_venir', 53, 370);

        INSERT INTO "arrete_cadre_arrete_restriction" (
          "arreteCadreId", "arreteRestrictionId"
        )
        SELECT 900, "id" FROM "arrete_restriction"
        ;

        UPDATE "arrete_restriction"
        SET
          "dateFinCalculee" = true,
          "dateFinSaisie" = NULL,
          "dateFinSaisieConnue" = true
        WHERE "id" IN (330, 350, 360, 370);

        UPDATE "arrete_restriction"
        SET
          "dateFinCalculee" = true,
          "dateFinSaisie" = date '2026-08-03',
          "dateFinSaisieConnue" = false
        WHERE "id" = 340;

        UPDATE "arrete_cadre"
        SET
          "dateFinCalculee" = true,
          "dateFinSaisie" = NULL,
          "dateFinSaisieConnue" = true
        WHERE "id" IN (430, 450, 460, 470);

        UPDATE "arrete_cadre"
        SET
          "dateFinCalculee" = true,
          "dateFinSaisie" = date '2026-08-03',
          "dateFinSaisieConnue" = false
        WHERE "id" = 440
      `);

      const restrictionQuery = await captureRestrictionSchedulerQuery();
      const frameworkQuery = await captureFrameworkSchedulerQuery();

      const restrictionCandidates = await queryRunner.query(
        restrictionQuery.sql,
        restrictionQuery.parameters,
      );
      expect(restrictionCandidates).toEqual([
        {
          id: 330,
          dateDebut: '2026-07-01',
          dateFin: null,
          statut: 'publie',
        },
        {
          id: 370,
          dateDebut: '2026-07-01',
          dateFin: '2026-08-09',
          statut: 'publie',
        },
      ]);
      expect(
        restrictionCandidates.some(({ id }) =>
          [300, 310, 320, 340, 350, 360].includes(id),
        ),
      ).toBe(false);

      const frameworkCandidates = await queryRunner.query(
        frameworkQuery.sql,
        frameworkQuery.parameters,
      );
      expect(frameworkCandidates).toEqual([
        {
          id: 430,
          dateDebut: '2026-07-01',
          dateFin: null,
          statut: 'publie',
        },
        {
          id: 470,
          dateDebut: '2026-07-01',
          dateFin: '2026-08-09',
          statut: 'publie',
        },
      ]);
      expect(
        frameworkCandidates.some(({ id }) =>
          [400, 410, 420, 440, 450, 460].includes(id),
        ),
      ).toBe(false);

      await queryRunner.query(`SET enable_seqscan TO off`);
      const restrictionPlanRows = await queryRunner.query(
        `EXPLAIN (FORMAT TEXT) ${restrictionQuery.sql}`,
        restrictionQuery.parameters,
      );
      const frameworkPlanRows = await queryRunner.query(
        `EXPLAIN (FORMAT TEXT) ${frameworkQuery.sql}`,
        frameworkQuery.parameters,
      );
      const restrictionPlan = restrictionPlanRows
        .map((row) => row['QUERY PLAN'])
        .join('\n');
      const frameworkPlan = frameworkPlanRows
        .map((row) => row['QUERY PLAN'])
        .join('\n');

      expect(restrictionPlan).toContain(
        'IDX_arrete_restriction_replaced_order',
      );
      expect(frameworkPlan).toContain('IDX_arrete_cadre_replaced_order');

      await queryRunner.query(`SET enable_seqscan TO on`);
      await migration.down(queryRunner);
      rolledBack = true;
    } finally {
      await queryRunner
        .query(`SET enable_seqscan TO on`)
        .catch(() => undefined);
      if (migrated && !rolledBack) {
        await migration.down(queryRunner).catch(() => undefined);
      }
      await queryRunner.query(`SET search_path TO public`);
      await queryRunner.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    }
  });
});
