import { DataSource } from 'typeorm';
import {
  CERTIFIED_APPLY_TARGET_BATCH_SQL,
  CERTIFIED_INSPECT_TARGET_BATCH_SQL,
  CERTIFIED_SOURCE_SCOPE_SQL,
  CertifiedSourceDay,
  parseRestoreCertifiedHistoryOptions,
} from './restore-certified-commune-history';
import { withSnapshotLock } from './restore-missing-commune-history';

const postgresUrl = process.env.REPAIR_CERTIFIED_HISTORY_POSTGRES_URL;
const describePostgres = postgresUrl ? describe : describe.skip;

describePostgres('restore certified commune history PostgreSQL', () => {
  const schemaName = `certified_history_${process.pid}_${Date.now()}`;
  const sourceRunId = 'vigieau-2026-07-11-2026-08-27-backup-repair-v1';
  let admin: DataSource;
  let database: DataSource;
  let readOnly: DataSource;

  const source: CertifiedSourceDay[] = [
    {
      code: '77132',
      date: '2026-07-11',
      SOU: null,
      SUP: null,
      AEP: null,
    },
    {
      code: '77132',
      date: '2026-07-12',
      SOU: 'alerte',
      SUP: 'crise',
      AEP: null,
    },
    {
      code: '77132',
      date: '2026-07-13',
      SOU: null,
      SUP: null,
      AEP: null,
    },
  ];

  beforeAll(async () => {
    admin = await new DataSource({
      type: 'postgres',
      url: postgresUrl,
    }).initialize();
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    database = await new DataSource({
      type: 'postgres',
      url: postgresUrl,
      extra: { max: 1, options: `-c search_path=${schemaName},public` },
    }).initialize();
    await database.query(`
      CREATE TABLE commune (
        id integer PRIMARY KEY,
        code text NOT NULL UNIQUE
      );
      CREATE TABLE statistic_commune (
        id integer PRIMARY KEY,
        "communeId" integer NOT NULL UNIQUE REFERENCES commune(id),
        restrictions jsonb,
        "restrictionsByMonth" jsonb
      );
      CREATE TABLE "statistic_publication_state" (
        id integer PRIMARY KEY,
        revision bigint NOT NULL,
        "historicDirtyFrom" date,
        "historicDirtyThrough" date
      );
      CREATE TABLE certified_history_source_run (
        id text PRIMARY KEY,
        status text NOT NULL,
        "dateFrom" date NOT NULL,
        "dateThrough" date NOT NULL,
        "communeCount" bigint NOT NULL,
        "communeDayCount" bigint NOT NULL,
        "communeDigest" text NOT NULL,
        "communeHistoryDigest" text NOT NULL,
        provenance jsonb NOT NULL
      );
      CREATE TABLE certified_history_commune_day (
        "sourceRunId" text NOT NULL REFERENCES certified_history_source_run(id),
        code text NOT NULL,
        date date NOT NULL,
        "SOU" text,
        "SUP" text,
        "AEP" text,
        PRIMARY KEY ("sourceRunId", code, date)
      );
      CREATE TABLE current_zone_recompute_request (
        "currentPending" boolean NOT NULL DEFAULT false,
        "pendingScheduledDates" date[] NOT NULL DEFAULT '{}'
      );
      CREATE TABLE external_publication_run (
        "jobKey" text NOT NULL,
        status text NOT NULL
      );
      CREATE TABLE statistic_commune_snapshot (
        status text NOT NULL
      );
      INSERT INTO commune VALUES (1, '77132');
      INSERT INTO statistic_commune VALUES (
        10,
        1,
        '[
          {"date":"2026-07-10","SOU":null,"SUP":"alerte","AEP":null,"before":"keep"},
          {"date":"2026-07-11","SOU":null,"SUP":"crise","AEP":null},
          {"date":"2026-07-12","SOU":null,"SUP":"vigilance","AEP":null},
          {"date":"2026-07-14","SOU":null,"SUP":null,"AEP":"vigilance","after":"keep"}
        ]'::jsonb,
        '[{"date":"2026-07","ponderation":999,"label":"keep"}]'::jsonb
      );
      INSERT INTO "statistic_publication_state"
      VALUES (1, 116, '2026-07-11', '2026-08-27');
      INSERT INTO certified_history_source_run VALUES (
        '${sourceRunId}', 'certified', '2026-07-11', '2026-07-13',
        1, 3, repeat('0', 64), repeat('0', 64),
        '{"communeDailyObjectKeyPolicy":"exact-date-SOU-SUP-AEP","dates":{"2026-07-11":"backup-a","2026-07-12":"backup-a","2026-07-13":"backup-b"}}'::jsonb
      );
      INSERT INTO certified_history_commune_day VALUES
        ('${sourceRunId}', '77132', '2026-07-11', NULL, NULL, NULL),
        ('${sourceRunId}', '77132', '2026-07-12', 'alerte', 'crise', NULL),
        ('${sourceRunId}', '77132', '2026-07-13', NULL, NULL, NULL);
    `);
    const [computedScope] = await database.query(CERTIFIED_SOURCE_SCOPE_SQL, [
      '2026-07-11',
      '2026-07-13',
      sourceRunId,
    ]);
    await database.query(
      `UPDATE certified_history_source_run
       SET "communeDigest" = $2, "communeHistoryDigest" = $3
       WHERE id = $1`,
      [
        sourceRunId,
        computedScope.communeDigest,
        computedScope.sourceFingerprint,
      ],
    );
    readOnly = await new DataSource({
      type: 'postgres',
      url: postgresUrl,
      extra: {
        max: 1,
        options: `-c search_path=${schemaName},public -c default_transaction_read_only=on`,
      },
    }).initialize();
  });

  afterAll(async () => {
    if (readOnly?.isInitialized) await readOnly.destroy();
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.destroy();
    }
  });

  it('replaces exact values in every direction, inserts all-null days and preserves outside data', async () => {
    const [inspection] = await database.query(
      CERTIFIED_INSPECT_TARGET_BATCH_SQL,
      [JSON.stringify(source), '2026-07-11', '2026-07-13'],
    );
    expect(inspection).toMatchObject({
      sourceCommuneCount: 1,
      targetCommuneCount: 1,
      changedCommuneCount: 1,
      changedDayCount: 3,
      changedValueCount: 6,
      affectedCommuneCount: 0,
      invalidTargetCount: 0,
    });

    const [applied] = await database.query(CERTIFIED_APPLY_TARGET_BATCH_SQL, [
      JSON.stringify(source),
      '2026-07-11',
      '2026-07-13',
    ]);
    expect(applied).toMatchObject({
      changedCommuneCount: 1,
      changedDayCount: 3,
      changedValueCount: 6,
      affectedCommuneCount: 1,
      invalidTargetCount: 0,
    });

    const [row] = await database.query(
      `SELECT restrictions, "restrictionsByMonth"
       FROM statistic_commune WHERE id = 10`,
    );
    expect(row.restrictions).toEqual([
      {
        date: '2026-07-10',
        SOU: null,
        SUP: 'alerte',
        AEP: null,
        before: 'keep',
      },
      {
        date: '2026-07-11',
        SOU: null,
        SUP: null,
        AEP: null,
      },
      {
        date: '2026-07-12',
        SOU: 'alerte',
        SUP: 'crise',
        AEP: null,
      },
      {
        date: '2026-07-13',
        SOU: null,
        SUP: null,
        AEP: null,
      },
      {
        date: '2026-07-14',
        SOU: null,
        SUP: null,
        AEP: 'vigilance',
        after: 'keep',
      },
    ]);
    expect(row.restrictionsByMonth).toEqual([
      { date: '2026-07', ponderation: 6.5, label: 'keep' },
    ]);

    const [publication] = await database.query(
      `SELECT revision::text AS revision,
              "historicDirtyFrom"::text AS "historicDirtyFrom",
              "historicDirtyThrough"::text AS "historicDirtyThrough"
       FROM "statistic_publication_state" WHERE id = 1`,
    );
    expect(publication).toEqual({
      revision: '116',
      historicDirtyFrom: '2026-07-11',
      historicDirtyThrough: '2026-08-27',
    });
  });

  it('is idempotent and reports a certified complete source scope', async () => {
    const [inspection] = await database.query(
      CERTIFIED_INSPECT_TARGET_BATCH_SQL,
      [JSON.stringify(source), '2026-07-11', '2026-07-13'],
    );
    expect(inspection).toMatchObject({
      changedCommuneCount: 0,
      changedDayCount: 0,
      changedValueCount: 0,
      affectedCommuneCount: 0,
    });
    const [second] = await database.query(CERTIFIED_APPLY_TARGET_BATCH_SQL, [
      JSON.stringify(source),
      '2026-07-11',
      '2026-07-13',
    ]);
    expect(second).toMatchObject({
      changedCommuneCount: 0,
      affectedCommuneCount: 0,
    });

    const [scope] = await database.query(CERTIFIED_SOURCE_SCOPE_SQL, [
      '2026-07-11',
      '2026-07-13',
      sourceRunId,
    ]);
    expect(scope).toMatchObject({
      communeCount: 1,
      distinctCommuneCount: 1,
      statisticCount: 1,
      dayCount: '3',
      invalidCommuneCount: 0,
      runCount: 1,
      status: 'certified',
      dateFrom: '2026-07-11',
      dateThrough: '2026-07-13',
    });
    expect(scope.communeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(scope.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('runs inspection in a strictly read-only target session', async () => {
    await expect(
      readOnly.query(CERTIFIED_INSPECT_TARGET_BATCH_SQL, [
        JSON.stringify(source),
        '2026-07-11',
        '2026-07-13',
      ]),
    ).resolves.toMatchObject([
      expect.objectContaining({ changedCommuneCount: 0 }),
    ]);
    await expect(
      readOnly.query(CERTIFIED_APPLY_TARGET_BATCH_SQL, [
        JSON.stringify(source),
        '2026-07-11',
        '2026-07-13',
      ]),
    ).rejects.toThrow(/read-only transaction/i);
  });

  it('fails closed on an unexpected key inside the certified range', async () => {
    await database.query(`
      UPDATE statistic_commune statistic
      SET restrictions = (
        SELECT jsonb_agg(
          CASE WHEN item.value ->> 'date' = '2026-07-11'
            THEN item.value || '{"unexpected":true}'::jsonb
            ELSE item.value END
          ORDER BY item.ordinality
        )
        FROM jsonb_array_elements(statistic.restrictions)
          WITH ORDINALITY AS item(value, ordinality)
      )
      WHERE id = 10
    `);
    const before = await database.query(
      'SELECT restrictions FROM statistic_commune WHERE id = 10',
    );
    const [result] = await database.query(CERTIFIED_APPLY_TARGET_BATCH_SQL, [
      JSON.stringify(source),
      '2026-07-11',
      '2026-07-13',
    ]);
    expect(result).toMatchObject({
      invalidTargetCount: 1,
      affectedCommuneCount: 0,
    });
    expect(
      await database.query(
        'SELECT restrictions FROM statistic_commune WHERE id = 10',
      ),
    ).toEqual(before);
    await database.query(`
      UPDATE statistic_commune statistic
      SET restrictions = (
        SELECT jsonb_agg(item.value - 'unexpected' ORDER BY item.ordinality)
        FROM jsonb_array_elements(statistic.restrictions)
          WITH ORDINALITY AS item(value, ordinality)
      )
      WHERE id = 10
    `);
  });

  it('fails closed on duplicate target dates without writing', async () => {
    await database.query(`
      UPDATE statistic_commune
      SET restrictions = restrictions || (restrictions -> 1)
      WHERE id = 10
    `);
    const before = await database.query(
      'SELECT restrictions FROM statistic_commune WHERE id = 10',
    );
    const [result] = await database.query(CERTIFIED_APPLY_TARGET_BATCH_SQL, [
      JSON.stringify(source),
      '2026-07-11',
      '2026-07-13',
    ]);
    expect(result).toMatchObject({
      invalidTargetCount: 1,
      affectedCommuneCount: 0,
    });
    const after = await database.query(
      'SELECT restrictions FROM statistic_commune WHERE id = 10',
    );
    expect(after).toEqual(before);
  });

  it('uses non-blocking snapshot locking, short statements and current priority', async () => {
    const options = parseRestoreCertifiedHistoryOptions({
      CERTIFIED_HISTORY_SOURCE_RUN_ID: sourceRunId,
      CERTIFIED_HISTORY_FROM: '2026-07-11',
      CERTIFIED_HISTORY_THROUGH: '2026-07-13',
      CERTIFIED_HISTORY_EXPECTED_SOURCE_DATABASE: 'source',
      CERTIFIED_HISTORY_EXPECTED_TARGET_DATABASE: 'target',
      CERTIFIED_HISTORY_MAX_RETRIES: '1',
    });
    const settings = await withSnapshotLock(
      database,
      options,
      async (runner) => {
        const [row] = await runner.query(`
        SELECT current_setting('lock_timeout') AS "lockTimeout",
               current_setting('statement_timeout') AS "statementTimeout"
      `);
        return row;
      },
    );
    expect(settings).toEqual({ lockTimeout: '250ms', statementTimeout: '5s' });

    await database.query(
      `INSERT INTO current_zone_recompute_request ("currentPending") VALUES (true)`,
    );
    await expect(
      withSnapshotLock(database, options, async () => {
        throw new Error('operation must not run');
      }),
    ).rejects.toThrow('Current statistic computation has priority');
    await database.query('TRUNCATE current_zone_recompute_request');

    const holder = readOnly.createQueryRunner();
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(hashtext($1))', [
        'vigieau:statistic-commune:snapshot-computation',
      ]);
      await expect(
        withSnapshotLock(database, options, async () => undefined),
      ).rejects.toThrow('owns the snapshot lock');
    } finally {
      await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [
        'vigieau:statistic-commune:snapshot-computation',
      ]);
      await holder.release();
    }
  });
});
