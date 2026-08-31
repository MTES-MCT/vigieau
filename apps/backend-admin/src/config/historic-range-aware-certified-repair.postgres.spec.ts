import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { CertifiedHistoryRepairAudit1787910600000 } from '../migrations/1787910600000-CertifiedHistoryRepairAudit';
import { HistoricRangeAwareCertifiedRepair1788199200000 } from '../migrations/1788199200000-HistoricRangeAwareCertifiedRepair';

const postgresUrl = process.env.REPAIR_CERTIFIED_HISTORY_POSTGRES_URL;
const describePostgres = postgresUrl ? describe : describe.skip;

describePostgres('range-aware certified history repair PostgreSQL', () => {
  const schema = `range_repair_${process.pid}_${Date.now()}`;
  let admin: DataSource;
  let database: DataSource;

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
      CREATE TABLE "config" (
        id integer PRIMARY KEY,
        "computeMapDate" date,
        "computeStatsDate" date,
        "computeMapGeneration" bigint NOT NULL DEFAULT 0,
        "computeStatsGeneration" bigint NOT NULL DEFAULT 0,
        "historicComputeEpoch" bigint NOT NULL DEFAULT 0,
        "historicBackfillGlobalEpoch" bigint NOT NULL DEFAULT 0
      );
      INSERT INTO "config" (id, "historicComputeEpoch") VALUES (1, 7);
      CREATE TABLE "statistic_commune_snapshot" (
        "snapshotDate" date NOT NULL,
        scope text NOT NULL,
        status text NOT NULL DEFAULT 'completed',
        "expectedCommuneCount" integer NOT NULL DEFAULT 34943,
        "processedCommuneCount" integer NOT NULL DEFAULT 34943,
        "sourceRevision" bigint,
        PRIMARY KEY ("snapshotDate", scope)
      );
      CREATE TABLE "statistic_publication_state" (
        id integer PRIMARY KEY,
        revision bigint NOT NULL
      );
      INSERT INTO "statistic_publication_state" (id, revision)
      VALUES (1, 12);
      CREATE TABLE "statistic_cache_publication" (
        id uuid PRIMARY KEY,
        "materializationStrategy" text NOT NULL,
        CONSTRAINT "CHK_statistic_cache_publication_strategy" CHECK (
          "materializationStrategy" IN (
            'full-clean', 'legacy-safe-boundary', 'daily-delta',
            'current-replace', 'sparse-current'
          )
        )
      );
    `);
    for (const migration of [
      new CertifiedHistoryRepairAudit1787910600000(),
      new HistoricRangeAwareCertifiedRepair1788199200000(),
    ]) {
      const runner = database.createQueryRunner();
      await runner.connect();
      try {
        await migration.up(runner);
      } finally {
        await runner.release();
      }
    }
  });

  afterAll(async () => {
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it('keeps an attested repair for disjoint invalidations and revokes overlaps', async () => {
    const repairId = randomUUID();
    const attestationId = randomUUID();
    await database.query(
      `INSERT INTO "certified_history_repair_audit" (
          id, "sourceRunId", "dateFrom", "dateThrough", "communeCount",
          "departmentCount", "dayCount", "communeHistoryDigest",
          "departmentHistoryDigest", "statisticDigest", "provenanceDigest",
          "sourceRevision", "historicComputeEpoch",
          "historicBackfillGlobalEpoch", "activationKind",
          "mapManifestRunId", "publicationRevisionBefore",
          "publicationRevisionAfter", "publicationContext"
        ) VALUES (
          $1, 'range-aware-source', DATE '2026-07-11', DATE '2026-07-12',
          34943, 101, 2, repeat('a', 64), repeat('b', 64),
          repeat('c', 64), repeat('d', 64), 42, 7, 9,
          'statistics-only', NULL, 11, 12, '{"method":"backup"}'::jsonb
        )`,
      [repairId],
    );
    await database.query(
      `INSERT INTO "statistic_commune_snapshot" ("snapshotDate", scope)
       VALUES (DATE '2026-07-11', 'national'),
              (DATE '2026-07-12', 'national')`,
    );
    await database.query('BEGIN');
    try {
      await database.query(
        `SELECT set_config(
           'vigieau.certified_history_promotion_id', $1, true
         )`,
        [repairId],
      );
      await database.query(
        `UPDATE "statistic_commune_snapshot"
         SET "certifiedHistoryRepairId" = $1`,
        [repairId],
      );
      await database.query(
        `SELECT set_config(
           'vigieau.certified_history_attestation_id', $1, true
         )`,
        [attestationId],
      );
      await database.query(
        `INSERT INTO "certified_history_repair_attestation" (
           id, "repairId", "attestedThroughEpoch", "sourceRevision",
           "statisticRevision", "communeHistoryDigest",
           "departmentHistoryDigest", "statisticDigest", "provenanceDigest",
           context
         ) VALUES (
           $1, $2, 7, 42, 12, repeat('a', 64), repeat('b', 64),
           repeat('c', 64), repeat('d', 64), '{"method":"test"}'::jsonb
         )`,
        [attestationId, repairId],
      );
      await database.query('COMMIT');
    } catch (error) {
      await database.query('ROLLBACK');
      throw error;
    }

    const activeCount = async () => {
      const [row] = await database.query(
        `SELECT COUNT(*)::integer AS count
         FROM "active_certified_history_repair"
         WHERE id = $1`,
        [repairId],
      );
      return Number(row.count);
    };
    expect(await activeCount()).toBe(1);

    await database.query(
      `SELECT * FROM "record_historic_compute_invalidation"(
         DATE '2026-08-01', DATE '2026-08-02', true, false,
         'disjoint-test', 43, '{"test":true}'::jsonb
       )`,
    );
    expect(await activeCount()).toBe(1);

    const wrongRevisionAttestationId = randomUUID();
    await database.query('BEGIN');
    try {
      await database.query(
        `SELECT set_config(
           'vigieau.certified_history_attestation_id', $1, true
         )`,
        [wrongRevisionAttestationId],
      );
      await expect(
        database.query(
          `INSERT INTO "certified_history_repair_attestation" (
             id, "repairId", "attestedThroughEpoch", "sourceRevision",
             "statisticRevision", "communeHistoryDigest",
             "departmentHistoryDigest", "statisticDigest",
             "provenanceDigest", context
           ) VALUES (
             $1, $2, 8, 999, 12, repeat('a', 64), repeat('b', 64),
             repeat('c', 64), repeat('d', 64), '{"method":"test"}'::jsonb
           )`,
          [wrongRevisionAttestationId, repairId],
        ),
      ).rejects.toMatchObject({ code: '40001' });
    } finally {
      await database.query('ROLLBACK');
    }

    const renewedAttestationId = randomUUID();
    await database.query('BEGIN');
    try {
      await database.query(
        `SELECT set_config(
           'vigieau.certified_history_attestation_id', $1, true
         )`,
        [renewedAttestationId],
      );
      await database.query(
        `INSERT INTO "certified_history_repair_attestation" (
           id, "repairId", "attestedThroughEpoch", "sourceRevision",
           "statisticRevision", "communeHistoryDigest",
           "departmentHistoryDigest", "statisticDigest",
           "provenanceDigest", context
         ) VALUES (
           $1, $2, 8, 42, 12, repeat('a', 64), repeat('b', 64),
           repeat('c', 64), repeat('d', 64), '{"method":"test"}'::jsonb
         )`,
        [renewedAttestationId, repairId],
      );
      await database.query('COMMIT');
    } catch (error) {
      await database.query('ROLLBACK');
      throw error;
    }
    expect(await activeCount()).toBe(1);

    await database.query(
      `UPDATE "statistic_commune_snapshot"
       SET "certifiedHistoryRepairId" = NULL
       WHERE "snapshotDate" = DATE '2026-07-11'
         AND scope = 'national'`,
    );
    expect(await activeCount()).toBe(0);

    const sameEpochReattestationId = randomUUID();
    await database.query('BEGIN');
    try {
      await database.query(
        `SELECT set_config(
           'vigieau.certified_history_promotion_id', $1, true
         )`,
        [repairId],
      );
      await database.query(
        `UPDATE "statistic_commune_snapshot"
         SET "certifiedHistoryRepairId" = $1`,
        [repairId],
      );
      await database.query(
        `SELECT set_config(
           'vigieau.certified_history_attestation_id', $1, true
         )`,
        [sameEpochReattestationId],
      );
      await database.query(
        `INSERT INTO "certified_history_repair_attestation" (
           id, "repairId", "attestedThroughEpoch", "sourceRevision",
           "statisticRevision", "communeHistoryDigest",
           "departmentHistoryDigest", "statisticDigest",
           "provenanceDigest", context
         ) VALUES (
           $1, $2, 8, 42, 12, repeat('a', 64), repeat('b', 64),
           repeat('c', 64), repeat('d', 64), '{"method":"retest"}'::jsonb
         )`,
        [sameEpochReattestationId, repairId],
      );
      await database.query('COMMIT');
    } catch (error) {
      await database.query('ROLLBACK');
      throw error;
    }
    expect(await activeCount()).toBe(1);

    await database.query(
      `SELECT * FROM "record_historic_compute_invalidation"(
         DATE '2026-07-12', DATE '2026-07-12', true, false,
         'overlap-test', 44, '{"test":true}'::jsonb
       )`,
    );
    expect(await activeCount()).toBe(0);

    await database.query(
      `UPDATE "config"
       SET "historicComputeEpoch" = "historicComputeEpoch" + 1
       WHERE id = 1`,
    );
    const [fallback] = await database.query(
      `SELECT cause, lower_inf("affectedRange") AS "lowerInfinite"
       FROM "historic_range_invalidation"
       ORDER BY "epochAfter" DESC
       LIMIT 1`,
    );
    expect(fallback).toEqual({
      cause: 'legacy-epoch-writer-fallback',
      lowerInfinite: true,
    });

    await expect(
      database.query(
        `DELETE FROM "certified_history_repair_attestation" WHERE id = $1`,
        [attestationId],
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });
});
