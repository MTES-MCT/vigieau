import { DataSource, QueryRunner } from 'typeorm';
import { StatisticCommune } from '@shared/entities/statistic_commune.entity';
import { StatisticCommuneService } from './statistic_commune.service';

const postgresUrl = process.env.STATISTIC_COMMUNE_POSTGRES_URL;
const describeWithPostgres = postgresUrl ? describe : describe.skip;

type SnapshotFinalizer = {
  markSnapshotCompleted(
    queryRunner: QueryRunner,
    snapshotDate: string,
    snapshotScope: string,
    processedCommuneCount: number,
    nationalSnapshotAlreadyCompleted: boolean,
    deferCertificationUntilPublication: boolean,
    preserveBootstrapBarrier: boolean,
    sourceRevision?: string,
    historicComputeEpoch?: string,
    certificationOptions?: {
      requireNationalCoverage?: boolean;
      publishCurrentDate?: boolean;
    },
  ): Promise<void>;
};

type PostgresRestriction = {
  date: string;
  SOU: 'vigilance' | 'alerte' | 'alerte_renforcee' | 'crise' | null;
  SUP: 'vigilance' | 'alerte' | 'alerte_renforcee' | 'crise' | null;
  AEP: 'vigilance' | 'alerte' | 'alerte_renforcee' | 'crise' | null;
};

type StatisticCommunePersister = {
  persistCommuneStatisticsBatch(
    queryRunner: QueryRunner,
    restrictions: Array<{
      communeId: number;
      restriction: PostgresRestriction;
    }>,
    dateString: string,
    snapshotScope: string,
    processedCommuneCount: number,
  ): Promise<void>;
};

type EmptyHistoricStatisticRangePersister = {
  persistEmptyHistoricCommuneStatisticsBatch(
    queryRunner: QueryRunner,
    communeIds: number[],
    dateStrings: string[],
    expectedCommuneCount: number,
    processedCommuneCount: number,
    options: { sourceRevision: string; historicComputeEpoch: string },
  ): Promise<void>;
};

type StatisticCommuneInternals = SnapshotFinalizer &
  StatisticCommunePersister &
  EmptyHistoricStatisticRangePersister;

type StatisticCommuneExportGuard = {
  assertNoIncompleteSnapshots(
    startDate?: string,
    endDate?: string,
  ): Promise<void>;
};

describeWithPostgres('StatisticCommuneService PostgreSQL behavior', () => {
  let dataSource: DataSource;
  let queryRunner: QueryRunner;
  let service: StatisticCommuneInternals;

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      url: postgresUrl,
      entities: [`${__dirname}/../../../../global_shared/**/*.entity{.ts,.js}`],
      synchronize: false,
      logging: false,
    }).initialize();
    service = new StatisticCommuneService(
      {} as never,
      {} as never,
      dataSource,
    ) as unknown as StatisticCommuneInternals;
  });

  beforeEach(async () => {
    queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
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
  });

  it.each([
    {
      snapshotDate: '9998-12-30',
      deferCertificationUntilPublication: true,
      expectedStatus: 'ready',
      completedAtIsNull: true,
    },
    {
      snapshotDate: '9998-12-31',
      deferCertificationUntilPublication: false,
      expectedStatus: 'completed',
      completedAtIsNull: false,
    },
  ])(
    'persists a $expectedStatus national snapshot without ambiguous parameter types',
    async ({
      snapshotDate,
      deferCertificationUntilPublication,
      expectedStatus,
      completedAtIsNull,
    }) => {
      await queryRunner.query(`
        CREATE TEMP TABLE "statistic_commune_snapshot" (
          "snapshotDate" date NOT NULL,
          "scope" varchar NOT NULL,
          "status" varchar NOT NULL,
          "processedCommuneCount" integer NOT NULL DEFAULT 0,
          "expectedCommuneCount" integer NOT NULL DEFAULT 0,
          "completedAt" timestamptz,
          "lastError" text,
          "updatedAt" timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY ("snapshotDate", "scope")
        ) ON COMMIT DROP
      `);
      await queryRunner.query(
        `
          INSERT INTO "statistic_commune_snapshot" (
            "snapshotDate",
            "scope",
            "status",
            "expectedCommuneCount",
            "processedCommuneCount"
          ) VALUES ($1, 'national', 'running', 1, 1)
        `,
        [snapshotDate],
      );

      await service.markSnapshotCompleted(
        queryRunner,
        snapshotDate,
        'national',
        1,
        false,
        deferCertificationUntilPublication,
        false,
      );

      const [snapshot] = await queryRunner.query(
        `
          SELECT
            "status",
            "completedAt" IS NULL AS "completedAtIsNull"
          FROM "statistic_commune_snapshot"
          WHERE "snapshotDate" = $1
            AND "scope" = 'national'
        `,
        [snapshotDate],
      );
      expect(snapshot).toEqual({
        status: expectedStatus,
        completedAtIsNull,
      });
    },
  );

  it('certifies a historic snapshot only in the locked source and epoch context', async () => {
    const snapshotDate = '9998-12-29';
    await queryRunner.query(`
      CREATE TEMP TABLE "config" (
        "id" integer PRIMARY KEY,
        "historicComputeEpoch" bigint NOT NULL
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "zone_publication_source_state" (
        "id" integer PRIMARY KEY,
        "revision" bigint NOT NULL
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "statistic_commune_snapshot" (
        "snapshotDate" date NOT NULL,
        "scope" varchar NOT NULL,
        "status" varchar NOT NULL,
        "processedCommuneCount" integer NOT NULL DEFAULT 0,
        "expectedCommuneCount" integer NOT NULL DEFAULT 0,
        "sourceRevision" bigint,
        "completedAt" timestamptz,
        "lastError" text,
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("snapshotDate", "scope")
      ) ON COMMIT DROP;
      INSERT INTO "config" VALUES (1, 10);
      INSERT INTO "zone_publication_source_state" VALUES (1, 42);
      INSERT INTO "statistic_commune_snapshot" (
        "snapshotDate", "scope", "status", "expectedCommuneCount",
        "processedCommuneCount", "sourceRevision"
      ) VALUES ('9998-12-29', 'national', 'running', 1, 1, 42);
    `);
    const complete = () =>
      service.markSnapshotCompleted(
        queryRunner,
        snapshotDate,
        'national',
        1,
        false,
        false,
        false,
        '42',
        '9',
      );
    const readStatus = async () => {
      const [snapshot] = await queryRunner.query(
        `
          SELECT "status"
          FROM "statistic_commune_snapshot"
          WHERE "snapshotDate" = $1
            AND "scope" = 'national'
        `,
        [snapshotDate],
      );
      return snapshot.status as string;
    };

    await expect(complete()).rejects.toThrow(
      'Le snapshot communal 9998-12-29 ne couvre pas toutes les communes attendues',
    );
    expect(await readStatus()).toBe('running');

    await queryRunner.query(
      `UPDATE "config" SET "historicComputeEpoch" = 9 WHERE "id" = 1`,
    );
    await queryRunner.query(
      `UPDATE "zone_publication_source_state" SET "revision" = 41 WHERE "id" = 1`,
    );
    await expect(complete()).rejects.toThrow(
      'Le snapshot communal 9998-12-29 ne couvre pas toutes les communes attendues',
    );
    expect(await readStatus()).toBe('running');

    await queryRunner.query(
      `UPDATE "zone_publication_source_state" SET "revision" = 42 WHERE "id" = 1`,
    );
    await expect(complete()).resolves.toBeUndefined();
    expect(await readStatus()).toBe('completed');
  });

  it('atomically publishes a fully covered legacy current snapshot without clearing the dirty range', async () => {
    const snapshotDate = '2026-08-11';
    await queryRunner.query(`
      CREATE TEMP TABLE "config" (
        "id" integer PRIMARY KEY,
        "historicComputeEpoch" bigint NOT NULL
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "zone_publication_source_state" (
        "id" integer PRIMARY KEY,
        "revision" bigint NOT NULL
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "departement" (
        "id" integer PRIMARY KEY,
        "code" varchar NOT NULL UNIQUE
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "statistic_departement" (
        "id" serial PRIMARY KEY,
        "departementId" integer NOT NULL UNIQUE,
        "restrictions" jsonb
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "statistic" (
        "id" serial PRIMARY KEY,
        "date" date NOT NULL UNIQUE,
        "departementSituation" json
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "statistic_commune_snapshot" (
        "snapshotDate" date NOT NULL,
        "scope" varchar NOT NULL,
        "status" varchar NOT NULL,
        "processedCommuneCount" integer NOT NULL DEFAULT 0,
        "expectedCommuneCount" integer NOT NULL DEFAULT 0,
        "sourceRevision" bigint,
        "completedAt" timestamptz,
        "lastError" text,
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("snapshotDate", "scope")
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "statistic_publication_state" (
        "id" integer PRIMARY KEY,
        "revision" bigint NOT NULL,
        "currentPublishedDate" date,
        "historicPublishedThrough" date,
        "historicDirtyFrom" date,
        "historicDirtyThrough" date,
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      ) ON COMMIT DROP;

      INSERT INTO "config" VALUES (1, 9);
      INSERT INTO "zone_publication_source_state" VALUES (1, 42);
      INSERT INTO "departement" ("id", "code")
      SELECT value, lpad(value::text, 3, '0')
      FROM generate_series(1, 101) value;
      INSERT INTO "statistic_departement" (
        "departementId", "restrictions"
      )
      SELECT
        "id",
        jsonb_build_array(jsonb_build_object('date', '${snapshotDate}'))
      FROM "departement";
      INSERT INTO "statistic" ("date", "departementSituation")
      SELECT
        date '${snapshotDate}',
        jsonb_object_agg(
          "code",
          jsonb_build_object('max', NULL, 'sup', NULL, 'sou', NULL, 'aep', NULL)
        )::json
      FROM "departement";
      INSERT INTO "statistic_commune_snapshot" (
        "snapshotDate", "scope", "status", "expectedCommuneCount",
        "processedCommuneCount", "sourceRevision"
      ) VALUES ('${snapshotDate}', 'national', 'running', 34943, 34943, 42);
      INSERT INTO "statistic_publication_state" VALUES (
        1, 7, date '2026-08-05', date '2025-05-12',
        date '2025-05-13', date '2026-08-10', now()
      );
    `);

    const certify = () =>
      service.markSnapshotCompleted(
        queryRunner,
        snapshotDate,
        'national',
        34943,
        false,
        false,
        true,
        '42',
        '9',
        { requireNationalCoverage: true, publishCurrentDate: true },
      );
    const readState = async () => {
      const [state] = await queryRunner.query(`
        SELECT
          "revision"::text AS "revision",
          "currentPublishedDate"::text AS "currentPublishedDate",
          "historicPublishedThrough"::text AS "historicPublishedThrough",
          "historicDirtyFrom"::text AS "historicDirtyFrom",
          "historicDirtyThrough"::text AS "historicDirtyThrough"
        FROM "statistic_publication_state"
        WHERE "id" = 1
      `);
      return state;
    };

    await queryRunner.query(`
      INSERT INTO "statistic_commune_snapshot" (
        "snapshotDate", "scope", "status", "expectedCommuneCount",
        "processedCommuneCount", "sourceRevision"
      ) VALUES (
        '${snapshotDate}', 'departements:65', 'partial', 469, 469, 42
      );
      CREATE OR REPLACE FUNCTION pg_temp.fail_scoped_snapshot_completion()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF OLD."scope" = 'departements:65'
          AND NEW."status" = 'completed' THEN
          RAISE EXCEPTION 'forced daily snapshot finalization failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_scoped_snapshot_completion
      BEFORE UPDATE ON "statistic_commune_snapshot"
      FOR EACH ROW
      EXECUTE FUNCTION pg_temp.fail_scoped_snapshot_completion();
    `);
    await queryRunner.startTransaction();
    await expect(certify()).rejects.toThrow(
      'forced daily snapshot finalization failure',
    );
    await queryRunner.rollbackTransaction();
    expect(await readState()).toEqual({
      revision: '7',
      currentPublishedDate: '2026-08-05',
      historicPublishedThrough: '2025-05-12',
      historicDirtyFrom: '2025-05-13',
      historicDirtyThrough: '2026-08-10',
    });
    expect(
      await queryRunner.query(`
        SELECT "scope", "status"
        FROM "statistic_commune_snapshot"
        WHERE "snapshotDate" = date '${snapshotDate}'
        ORDER BY "scope"
      `),
    ).toEqual([
      { scope: 'departements:65', status: 'partial' },
      { scope: 'national', status: 'running' },
    ]);
    await queryRunner.query(`
      DROP TRIGGER fail_scoped_snapshot_completion
      ON "statistic_commune_snapshot";
      DELETE FROM "statistic_commune_snapshot"
      WHERE "scope" = 'departements:65';
    `);

    await expect(certify()).resolves.toBeUndefined();
    expect(await readState()).toEqual({
      revision: '8',
      currentPublishedDate: snapshotDate,
      historicPublishedThrough: '2025-05-12',
      historicDirtyFrom: '2025-05-13',
      historicDirtyThrough: '2026-08-10',
    });

    await queryRunner.query(`
      UPDATE "statistic_commune_snapshot"
      SET "status" = 'running', "completedAt" = NULL
      WHERE "snapshotDate" = date '${snapshotDate}'
        AND "scope" = 'national'
    `);
    await expect(certify()).resolves.toBeUndefined();
    expect((await readState()).revision).toBe('9');

    await queryRunner.query(`
      UPDATE "statistic_departement"
      SET "restrictions" = '[]'::jsonb
      WHERE "departementId" = 101;
      UPDATE "statistic_commune_snapshot"
      SET "status" = 'running', "completedAt" = NULL
      WHERE "snapshotDate" = date '${snapshotDate}'
        AND "scope" = 'national'
    `);
    await expect(certify()).rejects.toThrow(
      'Couverture statistique departementale incomplete',
    );
    expect((await readState()).revision).toBe('9');
  });

  it('compares export bounds as PostgreSQL dates', async () => {
    await queryRunner.query(`
      CREATE TEMP TABLE "statistic_commune_snapshot" (
        "snapshotDate" date NOT NULL,
        "scope" varchar NOT NULL,
        "status" varchar NOT NULL,
        "processedCommuneCount" integer NOT NULL DEFAULT 0,
        "expectedCommuneCount" integer NOT NULL DEFAULT 0
      ) ON COMMIT DROP
    `);
    await queryRunner.query(`
      INSERT INTO "statistic_commune_snapshot" (
        "snapshotDate",
        "scope",
        "status"
      ) VALUES
        ('2025-12-31', 'national', 'failed'),
        ('2026-01-01', 'national', 'completed')
    `);
    const exportGuard = new StatisticCommuneService(
      {} as never,
      {} as never,
      {
        query: (sql: string, parameters: unknown[]) =>
          queryRunner.query(sql, parameters),
      } as DataSource,
    ) as unknown as StatisticCommuneExportGuard;

    await expect(
      exportGuard.assertNoIncompleteSnapshots('2026-01-01', '2027-01-01'),
    ).resolves.toBeUndefined();
  });

  it('streams a bounded year without ambiguous PostgreSQL date parameters', async () => {
    await queryRunner.query(`
      CREATE TEMP TABLE "commune" (
        "id" integer PRIMARY KEY,
        "code" varchar NOT NULL,
        "nom" varchar NOT NULL
      ) ON COMMIT DROP
    `);
    await queryRunner.query(`
      CREATE TEMP TABLE "statistic_commune" (
        "id" integer PRIMARY KEY,
        "communeId" integer NOT NULL,
        "restrictions" jsonb
      ) ON COMMIT DROP
    `);
    await queryRunner.query(`
      CREATE TEMP TABLE "statistic_commune_snapshot" (
        "snapshotDate" date NOT NULL,
        "scope" varchar NOT NULL,
        "status" varchar NOT NULL,
        "processedCommuneCount" integer NOT NULL DEFAULT 0,
        "expectedCommuneCount" integer NOT NULL DEFAULT 0
      ) ON COMMIT DROP
    `);
    await queryRunner.query(`
      INSERT INTO "commune" ("id", "code", "nom")
      VALUES (1, '01001', 'Commune test')
    `);
    await queryRunner.query(
      `
        INSERT INTO "statistic_commune" (
          "id", "communeId", "restrictions"
        ) VALUES (1, 1, $1::jsonb)
      `,
      [
        JSON.stringify([
          { date: '2025-12-31', SUP: 'vigilance' },
          { date: '2026-01-01', SUP: 'alerte' },
          { date: 'not-a-date', SUP: 'crise' },
        ]),
      ],
    );
    await queryRunner.query(`
      INSERT INTO "statistic_commune_snapshot" (
        "snapshotDate", "scope", "status"
      ) VALUES ('2026-01-01', 'national', 'completed')
    `);
    const streamService = new StatisticCommuneService(
      queryRunner.manager.getRepository(StatisticCommune),
      {} as never,
      {
        query: (sql: string, parameters: unknown[]) =>
          queryRunner.query(sql, parameters),
      } as DataSource,
    );

    const stream = await streamService.getStatisticCommuneStreamForYear(2026);
    const rows: Array<{ sc_restrictions: unknown[] }> = [];
    for await (const row of stream) {
      rows.push(row as { sc_restrictions: unknown[] });
    }

    expect(rows).toHaveLength(1);
    expect(rows[0].sc_restrictions).toEqual([
      { date: '2026-01-01', SUP: 'alerte' },
    ]);
  });

  it('persists commune JSONB idempotently and normalizes duplicate dates', async () => {
    await queryRunner.query(`
        CREATE TEMP TABLE "statistic_commune" (
          id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          "communeId" integer NOT NULL UNIQUE,
          "restrictions" jsonb NOT NULL DEFAULT '[]'::jsonb
        ) ON COMMIT DROP
      `);
    await queryRunner.query(`
        CREATE TEMP TABLE "statistic_commune_snapshot" (
          "snapshotDate" date NOT NULL,
          "scope" varchar NOT NULL,
          "status" varchar NOT NULL,
          "processedCommuneCount" integer NOT NULL DEFAULT 0,
          "updatedAt" timestamptz,
          PRIMARY KEY ("snapshotDate", "scope")
        ) ON COMMIT DROP
      `);

    const date = '2025-07-13';
    const followingRestriction = {
      date: '2025-07-14',
      SOU: null,
      SUP: 'vigilance' as const,
      AEP: null,
    };
    const restriction = {
      date,
      SOU: 'alerte' as const,
      SUP: null,
      AEP: null,
    };
    await queryRunner.query(
      `
          INSERT INTO "statistic_commune" ("communeId", "restrictions")
          VALUES (1, $1::jsonb)
        `,
      [JSON.stringify([followingRestriction])],
    );
    await queryRunner.query(
      `
          INSERT INTO "statistic_commune_snapshot" (
            "snapshotDate", "scope", "status"
          ) VALUES ($1, 'national', 'running')
        `,
      [date],
    );

    const persistBatch = async (
      restrictions: Array<{
        communeId: number;
        restriction: PostgresRestriction;
      }>,
    ) =>
      service.persistCommuneStatisticsBatch(
        queryRunner,
        restrictions,
        date,
        'national',
        restrictions.length,
      );
    const persist = async (nextRestriction: PostgresRestriction) =>
      persistBatch([{ communeId: 1, restriction: nextRestriction }]);
    const readStatistic = async (communeId = 1) => {
      const [statistic] = await queryRunner.query(
        `
          SELECT ctid::text AS ctid, "restrictions"
          FROM "statistic_commune"
          WHERE "communeId" = $1
        `,
        [communeId],
      );
      return statistic as { ctid: string; restrictions: unknown[] };
    };

    await persist(restriction);
    const appended = await readStatistic();
    expect(appended.restrictions).toEqual([restriction, followingRestriction]);

    await persist(restriction);
    const unchanged = await readStatistic();
    expect(unchanged.ctid).toBe(appended.ctid);
    expect(unchanged.restrictions).toEqual(appended.restrictions);

    await queryRunner.query(
      `
        INSERT INTO "statistic_commune" ("communeId", "restrictions")
        VALUES (2, $1::jsonb)
      `,
      [JSON.stringify([followingRestriction])],
    );
    const secondBeforeMixedBatch = await readStatistic(2);
    await persistBatch([
      { communeId: 1, restriction },
      { communeId: 2, restriction },
    ]);
    const firstAfterMixedBatch = await readStatistic(1);
    const secondAfterMixedBatch = await readStatistic(2);
    expect(firstAfterMixedBatch.ctid).toBe(unchanged.ctid);
    expect(secondAfterMixedBatch.ctid).not.toBe(secondBeforeMixedBatch.ctid);
    expect(secondAfterMixedBatch.restrictions).toEqual([
      restriction,
      followingRestriction,
    ]);

    const replacement = {
      ...restriction,
      SOU: 'crise' as const,
    };
    await persist(replacement);
    const replaced = await readStatistic();
    expect(replaced.ctid).not.toBe(unchanged.ctid);
    expect(replaced.restrictions).toEqual([replacement, followingRestriction]);

    const nextRestriction = {
      date: '2025-07-15',
      SOU: null,
      SUP: null,
      AEP: 'vigilance' as const,
    };
    await queryRunner.query(
      `
          UPDATE "statistic_commune"
          SET "restrictions" = $1::jsonb
          WHERE "communeId" = 1
        `,
      [
        JSON.stringify([
          followingRestriction,
          replacement,
          restriction,
          nextRestriction,
        ]),
      ],
    );

    await persist(replacement);
    const normalized = await readStatistic();
    expect(normalized.restrictions).toEqual([
      replacement,
      followingRestriction,
      nextRestriction,
    ]);
    expect(
      normalized.restrictions.filter(
        (value: { date?: string }) => value.date === date,
      ),
    ).toHaveLength(1);
  });

  it('normalizes an empty date range with one source traversal and no second-pass rewrite', async () => {
    await queryRunner.query(`
      CREATE TEMP TABLE "config" (
        "id" integer PRIMARY KEY,
        "historicComputeEpoch" bigint NOT NULL
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "zone_publication_source_state" (
        "id" integer PRIMARY KEY,
        "revision" bigint NOT NULL
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "statistic_commune" (
        "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "communeId" integer NOT NULL UNIQUE,
        "restrictions" jsonb NOT NULL DEFAULT '[]'::jsonb
      ) ON COMMIT DROP;
      CREATE TEMP TABLE "statistic_commune_snapshot" (
        "snapshotDate" date NOT NULL,
        "scope" varchar NOT NULL,
        "status" varchar NOT NULL,
        "expectedCommuneCount" integer NOT NULL,
        "processedCommuneCount" integer NOT NULL DEFAULT 0,
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("snapshotDate", "scope")
      ) ON COMMIT DROP;
      INSERT INTO "config" VALUES (1, 9);
      INSERT INTO "zone_publication_source_state" VALUES (1, 42);
      INSERT INTO "statistic_commune_snapshot" (
        "snapshotDate", "scope", "status", "expectedCommuneCount"
      ) VALUES
        ('2025-07-13', 'national', 'running', 1),
        ('2025-07-14', 'national', 'running', 1),
        ('2025-07-15', 'national', 'running', 1);
    `);
    const outsideBefore = {
      date: '2025-07-12',
      SOU: 'vigilance',
      SUP: null,
      AEP: null,
    };
    const outsideAfter = {
      date: '2025-07-16',
      SOU: null,
      SUP: 'alerte',
      AEP: null,
    };
    const outsideDuplicate = {
      date: '2025-07-12',
      SOU: null,
      SUP: 'crise',
      AEP: null,
    };
    const outsideEarlier = {
      date: '2025-07-11',
      SOU: null,
      SUP: null,
      AEP: 'vigilance',
    };
    const outsideLater = {
      date: '2025-07-18',
      SOU: 'alerte',
      SUP: null,
      AEP: null,
    };
    const malformedFirst = { date: 'date-inconnue', marker: 'first' };
    const malformedSecond = { marker: 'second' };
    await queryRunner.query(
      `
        INSERT INTO "statistic_commune" ("communeId", "restrictions")
        VALUES (1, $1::jsonb)
      `,
      [
        JSON.stringify([
          outsideAfter,
          malformedFirst,
          outsideBefore,
          {
            date: '2025-07-13',
            SOU: null,
            SUP: null,
            AEP: null,
          },
          outsideEarlier,
          {
            date: '2025-07-14',
            SOU: 'crise',
            SUP: null,
            AEP: null,
          },
          {
            date: '2025-07-13',
            SOU: 'alerte',
            SUP: null,
            AEP: null,
          },
          outsideDuplicate,
          outsideLater,
          malformedSecond,
        ]),
      ],
    );
    const persistRange = () =>
      service.persistEmptyHistoricCommuneStatisticsBatch(
        queryRunner,
        [1],
        ['2025-07-13', '2025-07-14', '2025-07-15'],
        1,
        1,
        { sourceRevision: '42', historicComputeEpoch: '9' },
      );
    const readStatistic = async () => {
      const [row] = await queryRunner.query(`
        SELECT ctid::text AS ctid, "restrictions"
        FROM "statistic_commune"
        WHERE "communeId" = 1
      `);
      return row as { ctid: string; restrictions: unknown[] };
    };

    await persistRange();
    const firstPass = await readStatistic();
    expect(firstPass.restrictions).toEqual([
      outsideEarlier,
      outsideBefore,
      outsideDuplicate,
      { date: '2025-07-13', SOU: null, SUP: null, AEP: null },
      { date: '2025-07-14', SOU: null, SUP: null, AEP: null },
      { date: '2025-07-15', SOU: null, SUP: null, AEP: null },
      outsideAfter,
      outsideLater,
      malformedFirst,
      malformedSecond,
    ]);
    expect(
      firstPass.restrictions.filter(
        (value) =>
          typeof value === 'object' &&
          value !== null &&
          'date' in value &&
          value.date === '2025-07-13',
      ),
    ).toHaveLength(1);

    await persistRange();
    const secondPass = await readStatistic();
    expect(secondPass.ctid).toBe(firstPass.ctid);
    expect(secondPass.restrictions).toEqual(firstPass.restrictions);
    const snapshots = await queryRunner.query(`
      SELECT "snapshotDate"::text AS date, "processedCommuneCount" AS processed
      FROM "statistic_commune_snapshot"
      ORDER BY "snapshotDate"
    `);
    expect(snapshots).toEqual([
      { date: '2025-07-13', processed: 1 },
      { date: '2025-07-14', processed: 1 },
      { date: '2025-07-15', processed: 1 },
    ]);
  });

  it('excludes only versioned failed days from monthly barriers and weighting', async () => {
    const schemaName = `failed_month_${process.pid}_${Date.now()}`;
    await queryRunner.query(`CREATE SCHEMA "${schemaName}"`);
    await queryRunner.query(`SET LOCAL search_path TO "${schemaName}", public`);
    await queryRunner.query(`
      CREATE TABLE "departement" (
        "id" integer PRIMARY KEY,
        "code" varchar NOT NULL
      );
      CREATE TABLE "commune" (
        "id" integer PRIMARY KEY,
        "departementId" integer NOT NULL
      );
      CREATE TABLE "statistic_commune" (
        "id" integer PRIMARY KEY,
        "communeId" integer NOT NULL,
        "restrictions" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "restrictionsByMonth" jsonb NOT NULL DEFAULT '[]'::jsonb
      );
      CREATE TABLE "statistic_commune_snapshot" (
        "snapshotDate" date NOT NULL,
        "scope" varchar NOT NULL,
        "status" varchar NOT NULL,
        "sourceRevision" bigint,
        "expectedCommuneCount" integer NOT NULL DEFAULT 1,
        "processedCommuneCount" integer NOT NULL DEFAULT 1,
        PRIMARY KEY ("snapshotDate", "scope")
      );
      INSERT INTO "departement" VALUES (1, '65');
      INSERT INTO "commune" VALUES (1, 1);
      INSERT INTO "statistic_commune" (
        "id", "communeId", "restrictions", "restrictionsByMonth"
      ) VALUES (
        1,
        1,
        '[
          {"date":"9998-02-01","SOU":"vigilance","SUP":null,"AEP":null},
          {"date":"9998-02-02","SOU":"crise","SUP":null,"AEP":null},
          {"date":"9998-02-03","SOU":"alerte","SUP":null,"AEP":null}
        ]'::jsonb,
        '[
          {"date":"9998-03","ponderation":3},
          {"date":"9998-01","ponderation":1}
        ]'::jsonb
      );
      INSERT INTO "statistic_commune_snapshot" (
        "snapshotDate", "scope", "status", "sourceRevision"
      ) VALUES
        ('9998-02-01', 'national', 'completed', 1),
        ('9998-02-02', 'national', 'failed', 1),
        ('9998-02-03', 'national', 'completed', 1)
    `);
    const monthlyService = new StatisticCommuneService(
      {} as never,
      {} as never,
      {
        query: (sql: string, parameters?: unknown[]) =>
          queryRunner.query(sql, parameters),
      } as never,
    );
    const computeMonth = () =>
      monthlyService.computeCommuneStatisticsRestrictionsByMonth(
        new Date('9998-02-01T00:00:00.000Z'),
      );
    const readWeight = async () => {
      const [row] = await queryRunner.query(`
        SELECT item.value ->> 'ponderation' AS "weight"
        FROM "statistic_commune" statistic
        CROSS JOIN LATERAL jsonb_array_elements(
          statistic."restrictionsByMonth"
        ) item(value)
        WHERE item.value ->> 'date' = '9998-02'
      `);
      return row?.weight ?? null;
    };

    await expect(computeMonth()).resolves.toBeUndefined();
    await expect(readWeight()).resolves.toBe('2.5');
    await expect(
      queryRunner.query(`
        SELECT jsonb_path_query_array(
          "restrictionsByMonth",
          '$[*].date'
        ) AS dates
        FROM "statistic_commune"
        WHERE "id" = 1
      `),
    ).resolves.toEqual([{ dates: ['9998-01', '9998-02', '9998-03'] }]);

    await queryRunner.query(`
      INSERT INTO "statistic_commune_snapshot" (
        "snapshotDate", "scope", "status", "sourceRevision"
      ) VALUES ('9998-02-02', 'bootstrap', 'running', NULL)
    `);
    await expect(computeMonth()).rejects.toThrow(
      'Calcul mensuel communal bloque pour 9998-02',
    );

    await queryRunner.query(`
      DELETE FROM "statistic_commune_snapshot" WHERE "scope" = 'bootstrap';
      UPDATE "statistic_commune_snapshot"
      SET "sourceRevision" = NULL
      WHERE "snapshotDate" = '9998-02-02' AND "scope" = 'national'
    `);
    await expect(computeMonth()).rejects.toThrow(
      'Calcul mensuel communal bloque pour 9998-02',
    );

    await queryRunner.query(`
      UPDATE "statistic_commune_snapshot"
      SET "status" = 'running', "sourceRevision" = 1
      WHERE "snapshotDate" = '9998-02-02' AND "scope" = 'national'
    `);
    await expect(computeMonth()).rejects.toThrow(
      'Calcul mensuel communal bloque pour 9998-02',
    );

    await queryRunner.query(`
      UPDATE "statistic_commune_snapshot"
      SET "status" = 'completed'
      WHERE "snapshotDate" = '9998-02-02' AND "scope" = 'national'
    `);
    await expect(computeMonth()).resolves.toBeUndefined();
    await expect(readWeight()).resolves.toBe('6.5');
  });
});
