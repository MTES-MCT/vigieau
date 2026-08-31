import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  CERTIFIED_COMPLETION_APPLY_DEPARTMENT_BATCH_SQL,
  CERTIFIED_COMPLETION_ATTESTATION_RETAG_SQL,
  CERTIFIED_COMPLETION_ATTESTATION_SQL,
  CERTIFIED_COMPLETION_INITIAL_ATTESTATION_SQL,
  CERTIFIED_COMPLETION_INSPECT_DEPARTMENT_BATCH_SQL,
  CERTIFIED_COMPLETION_PROMOTION_SQL,
  TARGET_COMMUNE_DIGEST_VALIDATION_SQL,
  buildStatisticApplySql,
  buildStatisticInspectionSql,
  certifiedCompletionContextSql,
} from './complete-certified-history-restoration';

const postgresUrl = process.env.REPAIR_CERTIFIED_HISTORY_POSTGRES_URL;
const describePostgres = postgresUrl ? describe : describe.skip;

describePostgres('complete certified history PostgreSQL', () => {
  const schema = `certified_completion_${process.pid}_${Date.now()}`;
  let admin: DataSource;
  let database: DataSource;
  let readOnly: DataSource;

  const departmentSource = [
    {
      code: '01',
      date: '2026-07-11',
      restriction: { date: '2026-07-11', SUP: { crise: 0 } },
    },
    {
      code: '01',
      date: '2026-07-12',
      restriction: { date: '2026-07-12', SUP: { crise: 1 } },
    },
    {
      code: '77',
      date: '2026-07-11',
      restriction: { date: '2026-07-11', SUP: { crise: 2 } },
    },
    {
      code: '77',
      date: '2026-07-12',
      restriction: { date: '2026-07-12', SUP: { crise: 3 } },
    },
  ];

  const statisticSource = [
    {
      date: '2026-07-11',
      payload: { id: 800, date: '2026-07-11', visits: null, details: null },
    },
    {
      date: '2026-07-12',
      payload: {
        id: 801,
        date: '2026-07-12',
        visits: 7,
        details: { exact: true },
      },
    },
  ];

  beforeAll(async () => {
    admin = await new DataSource({
      type: 'postgres',
      url: postgresUrl,
    }).initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    database = await new DataSource({
      type: 'postgres',
      url: postgresUrl,
      extra: { max: 1, options: `-c search_path=${schema},public` },
    }).initialize();
    await database.query(`
      CREATE TABLE departement (id integer PRIMARY KEY, code text NOT NULL UNIQUE);
      CREATE TABLE statistic_departement (
        id integer PRIMARY KEY,
        "departementId" integer NOT NULL UNIQUE REFERENCES departement(id),
        restrictions jsonb NOT NULL
      );
      CREATE TABLE statistic (
        id bigserial PRIMARY KEY,
        date date NOT NULL UNIQUE,
        visits integer,
        details json
      );
      CREATE TABLE commune (
        id integer PRIMARY KEY,
        code text NOT NULL UNIQUE
      );
      CREATE TABLE statistic_commune (
        id integer PRIMARY KEY,
        "communeId" integer NOT NULL UNIQUE REFERENCES commune(id),
        restrictions jsonb NOT NULL
      );
      CREATE TABLE statistic_publication_state (
        id integer PRIMARY KEY,
        revision bigint NOT NULL,
        "currentPublishedDate" date,
        "historicPublishedThrough" date,
        "historicDirtyFrom" date,
        "historicDirtyThrough" date,
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE config (
        id integer PRIMARY KEY,
        "historicComputeEpoch" bigint NOT NULL,
        "historicBackfillGlobalEpoch" bigint NOT NULL,
        "computeMapDate" date,
        "computeStatsDate" date
      );
      CREATE TABLE zone_publication_source_state (
        id integer PRIMARY KEY,
        revision bigint NOT NULL,
        "publicRevision" bigint NOT NULL,
        "legacyDualWrite" boolean NOT NULL
      );
      CREATE TABLE current_zone_recompute_request (
        id integer PRIMARY KEY,
        "currentPending" boolean NOT NULL,
        "pendingScheduledDates" date[] NOT NULL
      );
      CREATE TABLE external_publication_run (
        id integer PRIMARY KEY,
        status text NOT NULL,
        "jobKey" text NOT NULL
      );
      CREATE TABLE historic_backfill_run (
        id integer PRIMARY KEY,
        status text NOT NULL
      );
      CREATE TABLE certified_history_repair_audit (
        id uuid PRIMARY KEY,
        "sourceRunId" text NOT NULL,
        "dateFrom" date NOT NULL,
        "dateThrough" date NOT NULL,
        "communeCount" integer NOT NULL,
        "departmentCount" integer NOT NULL,
        "dayCount" integer NOT NULL,
        "communeHistoryDigest" text NOT NULL,
        "departmentHistoryDigest" text NOT NULL,
        "statisticDigest" text NOT NULL,
        "provenanceDigest" text NOT NULL,
        "sourceRevision" bigint NOT NULL,
        "historicComputeEpoch" bigint NOT NULL,
        "historicBackfillGlobalEpoch" bigint NOT NULL,
        "activationKind" text NOT NULL,
        "mapManifestRunId" uuid,
        "publicationRevisionBefore" bigint NOT NULL,
        "publicationRevisionAfter" bigint NOT NULL,
        "publicationContext" jsonb NOT NULL,
        "promotedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("sourceRunId", "dateFrom", "dateThrough")
      );
      CREATE TABLE statistic_commune_snapshot (
        "snapshotDate" date NOT NULL,
        scope text NOT NULL,
        status text NOT NULL,
        "expectedCommuneCount" integer NOT NULL,
        "processedCommuneCount" integer NOT NULL,
        "startedAt" timestamptz NOT NULL DEFAULT now(),
        "completedAt" timestamptz,
        "lastError" text,
        "sourceRevision" bigint,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "certifiedHistoryRepairId" uuid,
        PRIMARY KEY ("snapshotDate", scope)
      );
      CREATE TABLE certified_history_repair_attestation (
        id uuid PRIMARY KEY,
        "repairId" uuid NOT NULL,
        "attestedThroughEpoch" bigint NOT NULL,
        "sourceRevision" bigint NOT NULL,
        "statisticRevision" bigint NOT NULL,
        "communeHistoryDigest" text NOT NULL,
        "departmentHistoryDigest" text NOT NULL,
        "statisticDigest" text NOT NULL,
        "provenanceDigest" text NOT NULL,
        context jsonb NOT NULL
      );
      INSERT INTO departement VALUES (1, '01'), (2, '77');
      INSERT INTO statistic_departement VALUES
        (1, 1, '[
          {"date":"2026-07-10","keep":"before"},
          {"date":"2026-07-11","SUP":{"crise":9}},
          {"date":"2026-07-13","keep":"after"}
        ]'),
        (2, 2, '[
          {"date":"2026-07-10","keep":"before"},
          {"date":"2026-07-11","SUP":{"crise":9}},
          {"date":"2026-07-12","SUP":{"crise":9}},
          {"date":"2026-07-13","keep":"after"}
        ]');
      INSERT INTO statistic (date, visits, details) VALUES
        ('2026-07-10', 10, '{"keep":"before"}'),
        ('2026-07-11', 99, '{"wrong":true}'),
        ('2026-07-13', 13, '{"keep":"after"}');
      INSERT INTO commune VALUES (1, '77132');
      INSERT INTO statistic_commune VALUES (
        1, 1,
        '[{"date":"2026-07-11","SOU":null,"SUP":"vigilance","AEP":null}]'
      );
      INSERT INTO statistic_publication_state VALUES (
        1, 5, '2026-08-29', '2026-07-12', '2026-07-11',
        '2026-07-12', now()
      );
      INSERT INTO config VALUES (
        1, 7, 9, '2026-07-11', '2026-07-11'
      );
      INSERT INTO zone_publication_source_state VALUES (1, 42, 42, false);
      INSERT INTO statistic_commune_snapshot (
        "snapshotDate", scope, status, "expectedCommuneCount",
        "processedCommuneCount", "lastError", "sourceRevision"
      ) VALUES ('2026-07-11', 'national', 'failed', 34943, 0, 'old', 41);
    `);
    readOnly = await new DataSource({
      type: 'postgres',
      url: postgresUrl,
      extra: {
        max: 1,
        options: `-c search_path=${schema},public -c default_transaction_read_only=on`,
      },
    }).initialize();
  });

  it('runs promotion context preflight in a read-only transaction', async () => {
    const runner = readOnly.createQueryRunner();
    await runner.connect();
    await runner.startTransaction('SERIALIZABLE');
    try {
      const [context] = await runner.query(
        certifiedCompletionContextSql(false),
      );
      expect(context).toMatchObject({
        statisticRevision: '5',
        historicDirtyFrom: '2026-07-11',
        historicDirtyThrough: '2026-07-12',
        priorityActive: false,
      });
      await runner.commitTransaction();
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  });

  afterAll(async () => {
    if (readOnly?.isInitialized) await readOnly.destroy();
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it('restores exact department objects and preserves both boundaries', async () => {
    const [before] = await readOnly.query(
      CERTIFIED_COMPLETION_INSPECT_DEPARTMENT_BATCH_SQL,
      [JSON.stringify(departmentSource), '2026-07-11', '2026-07-12'],
    );
    expect(before).toMatchObject({
      sourceEntityCount: 2,
      targetEntityCount: 2,
      sourceDayCount: 4,
      changedEntityCount: 2,
      changedDayCount: 4,
      affectedEntityCount: 0,
      invalidTargetCount: 0,
    });

    const [applied] = await database.query(
      CERTIFIED_COMPLETION_APPLY_DEPARTMENT_BATCH_SQL,
      [JSON.stringify(departmentSource), '2026-07-11', '2026-07-12'],
    );
    expect(applied.affectedEntityCount).toBe(2);
    const rows = await database.query(
      `SELECT departement.code, statistic.restrictions
       FROM statistic_departement statistic
       JOIN departement ON departement.id = statistic."departementId"
       ORDER BY departement.code`,
    );
    expect(rows[0].restrictions[0]).toEqual({
      date: '2026-07-10',
      keep: 'before',
    });
    expect(rows[0].restrictions.at(-1)).toEqual({
      date: '2026-07-13',
      keep: 'after',
    });
    const [idempotent] = await database.query(
      CERTIFIED_COMPLETION_APPLY_DEPARTMENT_BATCH_SQL,
      [JSON.stringify(departmentSource), '2026-07-11', '2026-07-12'],
    );
    expect(idempotent).toMatchObject({
      changedEntityCount: 0,
      changedDayCount: 0,
      affectedEntityCount: 0,
    });
  });

  it('replaces and inserts full national payloads without copying ids', async () => {
    const columns = ['date', 'visits', 'details'];
    const [before] = await readOnly.query(buildStatisticInspectionSql(), [
      JSON.stringify(statisticSource),
    ]);
    expect(before.changedDayCount).toBe(2);
    const [applied] = await database.query(buildStatisticApplySql(columns), [
      JSON.stringify(statisticSource),
    ]);
    expect(applied.affectedEntityCount).toBe(2);
    const rows = await database.query(
      `SELECT id::text, date::text, visits, details FROM statistic ORDER BY date`,
    );
    expect(rows.map(({ date }) => date)).toEqual([
      '2026-07-10',
      '2026-07-11',
      '2026-07-12',
      '2026-07-13',
    ]);
    expect(rows.find(({ date }) => date === '2026-07-11')).toMatchObject({
      visits: null,
      details: null,
    });
    expect(rows.some(({ id }) => id === '800' || id === '801')).toBe(false);
  });

  it('rejects missing or extra keys even when the commune digest is unchanged', async () => {
    const [expected] = await database.query(`
      SELECT encode(sha256(convert_to(
        jsonb_build_array(
          '2026-07-11'::text, NULL::text, 'vigilance'::text, NULL::text
        )::text,
        'UTF8'
      )), 'hex') AS digest
    `);
    const source = JSON.stringify([
      { code: '77132', dayCount: 1, digest: expected.digest },
    ]);
    const parameters = [source, '2026-07-11', '2026-07-11'];

    const [exact] = await database.query(
      TARGET_COMMUNE_DIGEST_VALIDATION_SQL,
      parameters,
    );
    expect(exact.mismatchCount).toBe(0);

    await database.query(`
      UPDATE statistic_commune
      SET restrictions =
        '[{"date":"2026-07-11","SOU":null,"SUP":"vigilance"}]'::jsonb
    `);
    const [missingKey] = await database.query(
      TARGET_COMMUNE_DIGEST_VALIDATION_SQL,
      parameters,
    );
    expect(missingKey.mismatchCount).toBe(1);

    await database.query(`
      UPDATE statistic_commune
      SET restrictions =
        ('[{"date":"2026-07-11","SOU":null,"SUP":"vigilance",' ||
         '"AEP":null,"unexpected":true}]')::jsonb
    `);
    const [extraKey] = await database.query(
      TARGET_COMMUNE_DIGEST_VALIDATION_SQL,
      parameters,
    );
    expect(extraKey.mismatchCount).toBe(1);

    await database.query(`
      UPDATE statistic_commune
      SET restrictions =
        ('[{"date":"2026-07-11","SOU":null,"SUP":"vigilance",' ||
         '"AEP":null}, {}]')::jsonb
    `);
    const [invalidElement] = await database.query(
      TARGET_COMMUNE_DIGEST_VALIDATION_SQL,
      parameters,
    );
    expect(invalidElement.mismatchCount).toBe(1);

    await database.query(`
      UPDATE statistic_commune
      SET restrictions =
        ('[{"date":"2026-07-11","SOU":null,"SUP":"vigilance",' ||
         '"AEP":null}]')::jsonb
    `);
  });

  it('activates only the audited statistic range and leaves dirty/cursors intact', async () => {
    await database.query(`
      INSERT INTO statistic_commune_snapshot (
        "snapshotDate", scope, status, "expectedCommuneCount",
        "processedCommuneCount", "lastError", "sourceRevision"
      ) VALUES (
        '2026-07-11', 'departements:77', 'partial', 500, 123, 'old', 41
      )
    `);
    const auditId = randomUUID();
    const attestationId = randomUUID();
    const parameters = [
      auditId,
      'certified-test-source-run',
      '2026-07-11',
      '2026-07-12',
      34_943,
      101,
      2,
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
      'd'.repeat(64),
      42,
      7,
      9,
      5,
      JSON.stringify({ method: 'certified-backup-repair' }),
    ];
    const [result] = await database.query(
      CERTIFIED_COMPLETION_PROMOTION_SQL,
      parameters,
    );
    expect(result).toMatchObject({
      auditCount: 1,
      snapshotDayCount: 2,
      invalidSnapshotCount: 0,
      revision: '6',
    });
    const [attestation] = await database.query(
      CERTIFIED_COMPLETION_INITIAL_ATTESTATION_SQL,
      [
        attestationId,
        auditId,
        7,
        6,
        JSON.stringify({
          attestationMethod: 'initial-certified-promotion',
        }),
      ],
    );
    expect(attestation).toEqual({
      attestationId,
      revision: '6',
    });
    const [state] = await database.query(
      `SELECT revision::text, "historicDirtyFrom"::text,
              "historicDirtyThrough"::text
       FROM statistic_publication_state WHERE id = 1`,
    );
    expect(state).toEqual({
      revision: '6',
      historicDirtyFrom: '2026-07-11',
      historicDirtyThrough: '2026-07-12',
    });
    const snapshots = await database.query(
      `SELECT "snapshotDate"::text AS date, status,
              scope,
              "expectedCommuneCount", "processedCommuneCount",
              "sourceRevision", "certifiedHistoryRepairId"::text AS repair
       FROM statistic_commune_snapshot ORDER BY "snapshotDate", scope`,
    );
    expect(snapshots).toEqual([
      {
        date: '2026-07-11',
        scope: 'departements:77',
        status: 'completed',
        expectedCommuneCount: 500,
        processedCommuneCount: 500,
        sourceRevision: null,
        repair: auditId,
      },
      {
        date: '2026-07-11',
        scope: 'national',
        status: 'completed',
        expectedCommuneCount: 34_943,
        processedCommuneCount: 34_943,
        sourceRevision: null,
        repair: auditId,
      },
      {
        date: '2026-07-12',
        scope: 'national',
        status: 'completed',
        expectedCommuneCount: 34_943,
        processedCommuneCount: 34_943,
        sourceRevision: null,
        repair: auditId,
      },
    ]);

    const [second] = await database.query(
      CERTIFIED_COMPLETION_PROMOTION_SQL,
      parameters,
    );
    expect(second.auditCount).toBe(0);
    const [unchanged] = await database.query(
      `SELECT revision::text FROM statistic_publication_state WHERE id = 1`,
    );
    expect(unchanged.revision).toBe('6');

    await database.query(
      `UPDATE statistic_commune_snapshot
       SET "certifiedHistoryRepairId" = NULL
       WHERE scope = 'national'`,
    );
    const [retagged] = await database.query(
      CERTIFIED_COMPLETION_ATTESTATION_RETAG_SQL,
      [auditId, '2026-07-11', '2026-07-12', 34_943],
    );
    expect(retagged.retaggedSnapshotCount).toBe(2);
    const [prepared] = await database.query(
      CERTIFIED_COMPLETION_ATTESTATION_SQL,
      ['2026-07-11', '2026-07-12', 34_943, auditId, 6],
    );
    expect(prepared).toEqual({
      snapshotDayCount: 2,
      invalidSnapshotCount: 0,
      revision: '7',
    });
    const reattestationId = randomUUID();
    const [reattestation] = await database.query(
      CERTIFIED_COMPLETION_INITIAL_ATTESTATION_SQL,
      [
        reattestationId,
        auditId,
        7,
        7,
        JSON.stringify({
          attestationMethod: 'certified-backup-reattestation',
          currentSourceRevision: '999',
        }),
      ],
    );
    expect(reattestation).toEqual({
      attestationId: reattestationId,
      revision: '7',
    });
    const [reattestedRow] = await database.query(
      `SELECT "sourceRevision"::text AS "sourceRevision",
              context ->> 'currentSourceRevision' AS "currentSourceRevision"
       FROM certified_history_repair_attestation
       WHERE id = $1`,
      [reattestationId],
    );
    expect(reattestedRow).toEqual({
      sourceRevision: '42',
      currentSourceRevision: '999',
    });
  });
});
