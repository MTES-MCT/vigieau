import { DataSource } from 'typeorm';
import {
  assertRepairRangeAgainstPublicationContext,
  encodePublicationContext,
  encodeRepairExecutionContext,
  parseRestoreMissingHistoryOptions,
  REPAIR_CURRENT_PRIORITY_SQL,
  REPAIR_PUBLICATION_CONTEXT_SQL,
  RepairPublicationContext,
  SOURCE_BATCH_SQL,
  standaloneDataSource,
  TARGET_BATCH_SQL,
  VALIDATE_TARGET_BATCH_SQL,
  validateSparseSourceRows,
} from './restore-missing-commune-history';

const publicationContext: RepairPublicationContext = {
  statisticRevision: '42',
  currentPublishedDate: '2026-08-28',
  historicPublishedThrough: '2026-07-10',
  historicDirtyFrom: '2026-07-11',
  historicDirtyThrough: '2026-08-27',
  sourceRevision: '100',
  sourcePublicRevision: '99',
  legacyDualWrite: false,
  historicComputeEpoch: '7',
  historicBackfillGlobalEpoch: '3',
  computeMapDate: '2026-08-27',
  computeStatsDate: '2026-08-27',
};

describe('restore-missing-commune-history safeguards', () => {
  const requiredEnvironment = {
    REPAIR_THROUGH: '2026-04-05',
    REPAIR_EXPECTED_SOURCE_DATABASE: 'vigieau_april_backup',
    REPAIR_EXPECTED_TARGET_DATABASE: 'vigieau_production',
  };

  it('is a dry-run by default with short bounded batches and locks', () => {
    expect(parseRestoreMissingHistoryOptions(requiredEnvironment)).toEqual({
      through: '2026-04-05',
      batchSize: 20,
      communeCodes: null,
      apply: false,
      expectedSourceDatabase: 'vigieau_april_backup',
      expectedTargetDatabase: 'vigieau_production',
      expectedPublicationContext: null,
      lockTimeoutMs: 250,
      statementTimeoutMs: 5_000,
      maxRetries: 5,
    });
  });

  it('parses a canonical strict pilot commune filter', () => {
    const parsed = parseRestoreMissingHistoryOptions({
      ...requiredEnvironment,
      REPAIR_COMMUNE_CODES: '77132,2A004',
    });
    expect(parsed.communeCodes).toEqual(['2A004', '77132']);
    expect(() =>
      parseRestoreMissingHistoryOptions({
        ...requiredEnvironment,
        REPAIR_COMMUNE_CODES: '77132, 2A004',
      }),
    ).toThrow('REPAIR_COMMUNE_CODES must be a strict CSV');
    expect(() =>
      parseRestoreMissingHistoryOptions({
        ...requiredEnvironment,
        REPAIR_COMMUNE_CODES: '77132,77132',
      }),
    ).toThrow('REPAIR_COMMUNE_CODES must not contain duplicates');
  });

  it('pins the cutoff, databases and pilot filter in the apply token', () => {
    const base = {
      through: '2026-03-24',
      communeCodes: ['77132'],
      expectedSourceDatabase: 'vigieau_april_backup',
      expectedTargetDatabase: 'vigieau_production',
    };
    const pilot = encodeRepairExecutionContext(publicationContext, base);
    const national = encodeRepairExecutionContext(publicationContext, {
      ...base,
      communeCodes: null,
    });
    expect(pilot).not.toBe(national);
    expect(
      JSON.parse(Buffer.from(pilot, 'base64url').toString('utf8')),
    ).toMatchObject({
      scope: {
        through: '2026-03-24',
        communeCodes: ['77132'],
      },
    });
  });

  it('accepts the backup cutoff but refuses any overlap with the dirty range', () => {
    expect(() =>
      assertRepairRangeAgainstPublicationContext(
        '2026-03-24',
        publicationContext,
      ),
    ).not.toThrow();
    expect(() =>
      assertRepairRangeAgainstPublicationContext(
        '2026-07-11',
        publicationContext,
      ),
    ).toThrow('Repair cutoff intersects the target historic dirty range');
    expect(() =>
      assertRepairRangeAgainstPublicationContext('2026-07-10', {
        ...publicationContext,
        historicPublishedThrough: '2026-07-09',
        historicDirtyFrom: null,
        historicDirtyThrough: null,
      }),
    ).toThrow('Repair cutoff exceeds the target published historic range');
  });

  it('requires both exact confirmation and dry-run context in apply mode', () => {
    expect(() =>
      parseRestoreMissingHistoryOptions({
        ...requiredEnvironment,
        REPAIR_APPLY: 'true',
      }),
    ).toThrow(
      'REPAIR_CONFIRMATION must equal RESTORE_MISSING_HISTORIC_RESTRICTIONS',
    );
    expect(() =>
      parseRestoreMissingHistoryOptions({
        ...requiredEnvironment,
        REPAIR_APPLY: 'true',
        REPAIR_CONFIRMATION: 'RESTORE_MISSING_HISTORIC_RESTRICTIONS',
      }),
    ).toThrow('REPAIR_EXPECTED_PUBLICATION_CONTEXT is required');

    const token = encodePublicationContext(publicationContext);
    expect(
      parseRestoreMissingHistoryOptions({
        ...requiredEnvironment,
        REPAIR_APPLY: 'true',
        REPAIR_CONFIRMATION: 'RESTORE_MISSING_HISTORIC_RESTRICTIONS',
        REPAIR_EXPECTED_PUBLICATION_CONTEXT: token,
      }),
    ).toMatchObject({
      apply: true,
      expectedPublicationContext: token,
    });
  });

  it('refuses ambiguous databases, invalid dates and malformed context', () => {
    expect(() =>
      parseRestoreMissingHistoryOptions({
        ...requiredEnvironment,
        REPAIR_EXPECTED_SOURCE_DATABASE: 'same',
        REPAIR_EXPECTED_TARGET_DATABASE: 'same',
      }),
    ).toThrow('Repair source and target databases must be different');
    expect(() =>
      parseRestoreMissingHistoryOptions({
        ...requiredEnvironment,
        REPAIR_THROUGH: '2026-02-30',
      }),
    ).toThrow('REPAIR_THROUGH is not a valid date');
    expect(() =>
      parseRestoreMissingHistoryOptions({
        ...requiredEnvironment,
        REPAIR_EXPECTED_PUBLICATION_CONTEXT: 'not-json',
      }),
    ).toThrow('REPAIR_EXPECTED_PUBLICATION_CONTEXT is invalid');
  });

  it('creates single-connection standalone pools and a forced read-only source', () => {
    const source = standaloneDataSource(
      'postgres://user:pass@localhost/source',
      true,
    );
    const target = standaloneDataSource(
      'postgres://user:pass@localhost/target?sslmode=disable',
      false,
    );
    expect(source.options.extra).toMatchObject({
      max: 1,
      options: '-c default_transaction_read_only=on',
    });
    expect(source.options).toMatchObject({ ssl: false });
    expect(target.options.extra).toEqual({ max: 1 });
  });
});

describe('sparse repair input and monotone SQL', () => {
  it('accepts only unique non-null source days with known severities', () => {
    expect(
      validateSparseSourceRows([
        {
          code: '77132',
          date: '2021-01-01',
          SOU: null,
          SUP: 'vigilance',
          AEP: null,
        },
      ]),
    ).toEqual([
      {
        code: '77132',
        date: '2021-01-01',
        SOU: null,
        SUP: 'vigilance',
        AEP: null,
      },
    ]);
    expect(() =>
      validateSparseSourceRows([
        {
          code: '77132',
          date: '2021-01-01',
          SOU: null,
          SUP: null,
          AEP: null,
        },
      ]),
    ).toThrow('Empty source restriction');
    expect(() =>
      validateSparseSourceRows([
        {
          code: '77132',
          date: '2021-01-01',
          SOU: null,
          SUP: 'unknown',
          AEP: null,
        },
      ]),
    ).toThrow('Invalid source severity');
    expect(
      validateSparseSourceRows([
        {
          code: '2A004',
          date: '2021-01-01',
          SOU: 'alerte',
          SUP: null,
          AEP: null,
        },
      ])[0].code,
    ).toBe('2A004');
  });

  it('keeps full JSON inside PostgreSQL and patches only null target fields', () => {
    expect(SOURCE_BATCH_SQL).toContain(
      "restriction.value ->> 'SUP' IS NOT NULL",
    );
    expect(SOURCE_BATCH_SQL).toContain('END <= $2::date');
    expect(SOURCE_BATCH_SQL).toContain('commune.code = ANY($4::text[])');
    expect(SOURCE_BATCH_SQL).toContain(
      'CROSS JOIN LATERAL jsonb_array_elements',
    );
    expect(TARGET_BATCH_SQL).toContain('day.value\n        || CASE');
    expect(TARGET_BATCH_SQL).toContain(
      'day.value ->> \'SUP\' IS NULL AS "fillSUP"',
    );
    expect(TARGET_BATCH_SQL).toContain(
      'IS NOT DISTINCT FROM prepared."originalRestrictions"',
    );
    expect(TARGET_BATCH_SQL).toContain('WHERE $2::boolean');
    expect(VALIDATE_TARGET_BATCH_SQL).toContain('"missingValueCount"');
  });
});

const postgresUrl = process.env.REPAIR_MISSING_HISTORY_POSTGRES_URL;
const describePostgres = postgresUrl ? describe : describe.skip;

describePostgres('restore missing history PostgreSQL merge', () => {
  const schemaName = `repair_history_${process.pid}_${Date.now()}`;
  let admin: DataSource;
  let database: DataSource;

  beforeAll(async () => {
    admin = await new DataSource({
      type: 'postgres',
      url: postgresUrl,
    }).initialize();
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    database = await new DataSource({
      type: 'postgres',
      url: postgresUrl,
      extra: { options: `-c search_path=${schemaName},public` },
    }).initialize();
    await database.query(`
      CREATE TABLE commune (
        id integer PRIMARY KEY,
        code text NOT NULL UNIQUE
      );
      CREATE TABLE statistic_commune (
        id integer PRIMARY KEY,
        "communeId" integer NOT NULL REFERENCES commune(id),
        restrictions jsonb,
        "restrictionsByMonth" jsonb
      );
      CREATE TABLE "statistic_publication_state" (
        id integer PRIMARY KEY,
        revision bigint NOT NULL,
        "currentPublishedDate" date,
        "historicPublishedThrough" date,
        "historicDirtyFrom" date,
        "historicDirtyThrough" date,
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE "zone_publication_source_state" (
        id integer PRIMARY KEY,
        revision bigint NOT NULL,
        "publicRevision" bigint NOT NULL,
        "legacyDualWrite" boolean NOT NULL
      );
      CREATE TABLE config (
        id integer PRIMARY KEY,
        "historicComputeEpoch" bigint NOT NULL,
        "historicBackfillGlobalEpoch" bigint NOT NULL,
        "computeMapDate" date,
        "computeStatsDate" date
      );
      CREATE TABLE "current_zone_recompute_request" (
        "currentPending" boolean NOT NULL DEFAULT false,
        "pendingScheduledDates" date[] NOT NULL DEFAULT '{}'
      );
      CREATE TABLE "external_publication_run" (
        "jobKey" text NOT NULL,
        status text NOT NULL
      );
      CREATE TABLE "statistic_commune_snapshot" (
        status text NOT NULL
      );
      INSERT INTO commune VALUES (1, '77132');
      INSERT INTO statistic_commune VALUES (
        10,
        1,
        '[
          {"date":"2021-01-01","SOU":null,"SUP":null,"AEP":null,"note":"keep"},
          {"date":"2021-01-02","SOU":null,"SUP":"crise","AEP":null,"extra":7}
        ]'::jsonb,
        '[{"date":"2021-01","ponderation":0,"label":"keep"}]'::jsonb
      );
      INSERT INTO "statistic_publication_state" VALUES (
        1, 42, '2026-08-28', '2026-07-10', '2026-07-11', '2026-08-27', now()
      );
      INSERT INTO "zone_publication_source_state" VALUES (1, 100, 99, false);
      INSERT INTO config VALUES (
        1, 7, 3, '2026-08-27', '2026-08-27'
      )
    `);
  });

  afterAll(async () => {
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.destroy();
    }
  });

  it('fills nulls, preserves stronger values and extra keys, and is idempotent', async () => {
    const source = [
      {
        code: '77132',
        date: '2021-01-01',
        SOU: null,
        SUP: 'vigilance',
        AEP: null,
      },
      {
        code: '77132',
        date: '2021-01-02',
        SOU: null,
        SUP: 'alerte',
        AEP: null,
      },
      {
        code: '77132',
        date: '2021-01-03',
        SOU: null,
        SUP: 'crise',
        AEP: null,
      },
    ];

    const [first] = await database.query(TARGET_BATCH_SQL, [
      JSON.stringify(source),
      true,
    ]);
    expect(first).toMatchObject({
      changedCommuneCount: 1,
      restoredDayCount: 2,
      restoredValueCount: 2,
      affectedCommuneCount: 1,
      invalidTargetCount: 0,
    });

    const [row] = await database.query(
      'SELECT restrictions, "restrictionsByMonth" FROM statistic_commune WHERE id = 10',
    );
    expect(row.restrictions).toEqual([
      {
        date: '2021-01-01',
        SOU: null,
        SUP: 'vigilance',
        AEP: null,
        note: 'keep',
      },
      {
        date: '2021-01-02',
        SOU: null,
        SUP: 'crise',
        AEP: null,
        extra: 7,
      },
      {
        date: '2021-01-03',
        SOU: null,
        SUP: 'crise',
        AEP: null,
      },
    ]);
    expect(row.restrictionsByMonth).toEqual([
      { date: '2021-01', ponderation: 8.5, label: 'keep' },
    ]);

    const [validation] = await database.query(VALIDATE_TARGET_BATCH_SQL, [
      JSON.stringify(source),
    ]);
    expect(validation).toMatchObject({
      sourceCommuneCount: 1,
      targetCommuneCount: 1,
      missingDayCount: 0,
      missingValueCount: 0,
      invalidTargetCount: 0,
    });

    const [second] = await database.query(TARGET_BATCH_SQL, [
      JSON.stringify(source),
      true,
    ]);
    expect(second).toMatchObject({
      changedCommuneCount: 0,
      restoredDayCount: 0,
      restoredValueCount: 0,
      affectedCommuneCount: 0,
    });
  });

  it('reads a revision-pinned publication context and detects current priority', async () => {
    const runner = database.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const [context] = await runner.query(REPAIR_PUBLICATION_CONTEXT_SQL);
      expect(context).toMatchObject({
        statisticRevision: '42',
        sourceRevision: '100',
        sourcePublicRevision: '99',
        historicComputeEpoch: '7',
        historicBackfillGlobalEpoch: '3',
        priorityActive: false,
      });
      await runner.commitTransaction();
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }

    await database.query(
      'INSERT INTO "current_zone_recompute_request" ("currentPending") VALUES (true)',
    );
    const [priority] = await database.query(REPAIR_CURRENT_PRIORITY_SQL);
    expect(priority.priorityActive).toBe(true);
  });
});
