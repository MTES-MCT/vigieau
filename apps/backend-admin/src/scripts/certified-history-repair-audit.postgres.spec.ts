import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { CertifiedHistoryRepairAudit1787910600000 } from '../migrations/1787910600000-CertifiedHistoryRepairAudit';

const postgresUrl = process.env.REPAIR_CERTIFIED_HISTORY_POSTGRES_URL;
const describePostgres = postgresUrl ? describe : describe.skip;

describePostgres('certified history repair audit migration PostgreSQL', () => {
  const schema = `certified_repair_audit_${process.pid}_${Date.now()}`;
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
      CREATE TABLE "statistic_commune_snapshot" (
        "snapshotDate" date NOT NULL,
        scope text NOT NULL,
        marker integer NOT NULL DEFAULT 0,
        PRIMARY KEY ("snapshotDate", scope)
      );
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
  });

  afterAll(async () => {
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it('installs an append-only ledger, provenance FK and overlay strategy', async () => {
    const migration = new CertifiedHistoryRepairAudit1787910600000();
    const runner = database.createQueryRunner();
    await runner.connect();
    try {
      await migration.up(runner);
    } finally {
      await runner.release();
    }

    const repairId = randomUUID();
    await database.query(
      `
        INSERT INTO "certified_history_repair_audit" (
          id, "sourceRunId", "dateFrom", "dateThrough", "communeCount",
          "departmentCount", "dayCount", "communeHistoryDigest",
          "departmentHistoryDigest", "statisticDigest", "provenanceDigest",
          "sourceRevision", "historicComputeEpoch",
          "historicBackfillGlobalEpoch", "activationKind",
          "mapManifestRunId", "publicationRevisionBefore",
          "publicationRevisionAfter", "publicationContext"
        ) VALUES (
          $1, 'certified-postgres-source', DATE '2026-07-11',
          DATE '2026-08-27', 34943, 101, 48, repeat('a', 64),
          repeat('b', 64), repeat('c', 64), repeat('d', 64), 42, 7, 9,
          'statistics-only', NULL, 11, 12, '{"method":"backup"}'::jsonb
        )
      `,
      [repairId],
    );
    await database.query(
      `INSERT INTO "statistic_commune_snapshot" ("snapshotDate", scope)
       VALUES
         (DATE '2026-07-11', 'national'),
         (DATE '2026-07-11', 'departements:77')`,
    );
    const certifySnapshots = async () => {
      await database.query(
        `SELECT pg_advisory_lock(
           hashtext('vigieau:statistic-commune:snapshot-computation')
         )`,
      );
      try {
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
             SET "certifiedHistoryRepairId" = $1
             WHERE "snapshotDate" BETWEEN DATE '2026-07-11'
                                      AND DATE '2026-08-27'`,
            [repairId],
          );
          await database.query('COMMIT');
        } catch (error) {
          await database.query('ROLLBACK');
          throw error;
        }
      } finally {
        await database.query(
          `SELECT pg_advisory_unlock(
             hashtext('vigieau:statistic-commune:snapshot-computation')
           )`,
        );
      }
    };
    const certifiedCount = async () => {
      const [row] = await database.query(
        `SELECT COUNT(*)::integer AS count
         FROM "statistic_commune_snapshot"
         WHERE "certifiedHistoryRepairId" = $1`,
        [repairId],
      );
      return Number(row.count);
    };

    await certifySnapshots();
    expect(await certifiedCount()).toBe(2);

    await database.query(
      `UPDATE "statistic_commune_snapshot"
       SET marker = marker + 1
       WHERE "snapshotDate" = DATE '2026-07-11'`,
    );
    expect(await certifiedCount()).toBe(0);

    await certifySnapshots();
    expect(await certifiedCount()).toBe(2);

    await database.query(
      `UPDATE "statistic_commune_snapshot"
       SET marker = 1
       WHERE "snapshotDate" = DATE '2026-07-11'
         AND scope = 'departements:77'`,
    );
    expect(await certifiedCount()).toBe(0);

    await certifySnapshots();
    expect(await certifiedCount()).toBe(2);
    await database.query(
      `INSERT INTO "statistic_commune_snapshot" ("snapshotDate", scope)
       VALUES (DATE '2026-07-11', 'departements:78')`,
    );
    expect(await certifiedCount()).toBe(0);

    await certifySnapshots();
    expect(await certifiedCount()).toBe(3);
    await database.query(
      `DELETE FROM "statistic_commune_snapshot"
       WHERE "snapshotDate" = DATE '2026-07-11'
         AND scope = 'departements:78'`,
    );
    expect(await certifiedCount()).toBe(0);

    await database.query(
      `UPDATE "statistic_commune_snapshot" SET marker = marker + 1`,
    );
    expect(await certifiedCount()).toBe(0);

    await database.query(`
      CREATE TABLE snapshot_mutation_source (id integer PRIMARY KEY);
      CREATE FUNCTION mutate_snapshot_from_sibling_trigger()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        UPDATE "statistic_commune_snapshot"
        SET marker = marker + 1
        WHERE "snapshotDate" = DATE '2026-07-11'
          AND scope = 'departements:77';
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER snapshot_mutation_source_trigger
      AFTER INSERT ON snapshot_mutation_source
      FOR EACH ROW
      EXECUTE FUNCTION mutate_snapshot_from_sibling_trigger();
    `);
    await certifySnapshots();
    expect(await certifiedCount()).toBe(2);
    await database.query(`INSERT INTO snapshot_mutation_source VALUES (1)`);
    expect(await certifiedCount()).toBe(0);

    await database.query('BEGIN');
    try {
      await database.query(
        `SELECT set_config(
           'vigieau.certified_history_promotion_id', $1, true
         )`,
        [repairId],
      );
      await database.query(
        `INSERT INTO "statistic_commune_snapshot" (
           "snapshotDate", scope, "certifiedHistoryRepairId"
         ) VALUES (DATE '2026-07-12', 'national', $1)`,
        [repairId],
      );
      await database.query('COMMIT');
    } catch (error) {
      await database.query('ROLLBACK');
      throw error;
    }
    expect(await certifiedCount()).toBe(1);
    const publicationId = randomUUID();
    await database.query(
      `INSERT INTO "statistic_cache_publication" (
         id, "materializationStrategy", "certifiedHistoryRepairId"
       ) VALUES ($1, 'certified-history-overlay', $2)`,
      [publicationId, repairId],
    );

    await expect(
      database.query(
        `UPDATE "statistic_cache_publication"
         SET "certifiedHistoryRepairId" = NULL WHERE id = $1`,
        [publicationId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.query(
        `INSERT INTO "statistic_cache_publication" (
           id, "materializationStrategy", "certifiedHistoryRepairId"
         ) VALUES ($1, 'certified-history-overlay', $2)`,
        [randomUUID(), randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23503' });

    await expect(
      database.query(
        `UPDATE "certified_history_repair_audit"
         SET "publicationContext" = '{"changed":true}'::jsonb
         WHERE id = $1`,
        [repairId],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      database.query(
        'DELETE FROM "certified_history_repair_audit" WHERE id = $1',
        [repairId],
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('refuses an unsafe down while overlays exist, then removes dependencies', async () => {
    const migration = new CertifiedHistoryRepairAudit1787910600000();
    const runner = database.createQueryRunner();
    await runner.connect();
    try {
      await expect(migration.down(runner)).rejects.toMatchObject({
        code: '55000',
      });
      await runner.query('DELETE FROM "statistic_cache_publication"');
      await migration.down(runner);
    } finally {
      await runner.release();
    }

    const [schemaState] = await database.query(`
      SELECT
        to_regclass('certified_history_repair_audit') IS NULL
          AS "auditRemoved",
        NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'statistic_commune_snapshot'
            AND column_name = 'certifiedHistoryRepairId'
        ) AS "snapshotColumnRemoved"
        ,NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'statistic_cache_publication'
            AND column_name = 'certifiedHistoryRepairId'
        ) AS "publicationColumnRemoved"
    `);
    expect(schemaState).toEqual({
      auditRemoved: true,
      snapshotColumnRemoved: true,
      publicationColumnRemoved: true,
    });
  });
});
