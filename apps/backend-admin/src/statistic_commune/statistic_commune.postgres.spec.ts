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

type StatisticCommuneInternals = SnapshotFinalizer & StatisticCommunePersister;

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
    const previousRestriction = {
      date: '2025-07-12',
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
      [JSON.stringify([previousRestriction])],
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
    expect(appended.restrictions).toEqual([previousRestriction, restriction]);

    await persist(restriction);
    const unchanged = await readStatistic();
    expect(unchanged.ctid).toBe(appended.ctid);
    expect(unchanged.restrictions).toEqual(appended.restrictions);

    await queryRunner.query(
      `
        INSERT INTO "statistic_commune" ("communeId", "restrictions")
        VALUES (2, $1::jsonb)
      `,
      [JSON.stringify([previousRestriction])],
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
      previousRestriction,
      restriction,
    ]);

    const replacement = {
      ...restriction,
      SOU: 'crise' as const,
    };
    await persist(replacement);
    const replaced = await readStatistic();
    expect(replaced.ctid).not.toBe(unchanged.ctid);
    expect(replaced.restrictions).toEqual([previousRestriction, replacement]);

    const nextRestriction = {
      date: '2025-07-14',
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
          previousRestriction,
          replacement,
          restriction,
          nextRestriction,
        ]),
      ],
    );

    await persist(replacement);
    const normalized = await readStatistic();
    expect(normalized.restrictions).toEqual([
      previousRestriction,
      replacement,
      nextRestriction,
    ]);
    expect(
      normalized.restrictions.filter(
        (value: { date?: string }) => value.date === date,
      ),
    ).toHaveLength(1);
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
        "id", "communeId", "restrictions"
      ) VALUES (
        1,
        1,
        '[
          {"date":"9998-02-01","SOU":"vigilance","SUP":null,"AEP":null},
          {"date":"9998-02-02","SOU":"crise","SUP":null,"AEP":null},
          {"date":"9998-02-03","SOU":"alerte","SUP":null,"AEP":null}
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
