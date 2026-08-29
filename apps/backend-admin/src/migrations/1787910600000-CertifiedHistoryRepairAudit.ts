import { MigrationInterface, QueryRunner } from 'typeorm';

export class CertifiedHistoryRepairAudit1787910600000 implements MigrationInterface {
  name = 'CertifiedHistoryRepairAudit1787910600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "certified_history_repair_audit" (
        "id" uuid NOT NULL,
        "sourceRunId" text NOT NULL,
        "dateFrom" date NOT NULL,
        "dateThrough" date NOT NULL,
        "communeCount" integer NOT NULL,
        "departmentCount" integer NOT NULL,
        "dayCount" integer NOT NULL,
        "communeHistoryDigest" character varying(64) NOT NULL,
        "departmentHistoryDigest" character varying(64) NOT NULL,
        "statisticDigest" character varying(64) NOT NULL,
        "provenanceDigest" character varying(64) NOT NULL,
        "sourceRevision" bigint NOT NULL,
        "historicComputeEpoch" bigint NOT NULL,
        "historicBackfillGlobalEpoch" bigint NOT NULL,
        "activationKind" character varying(30) NOT NULL,
        "mapManifestRunId" uuid,
        "publicationRevisionBefore" bigint NOT NULL,
        "publicationRevisionAfter" bigint NOT NULL,
        "publicationContext" jsonb NOT NULL,
        "promotedAt" timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "PK_certified_history_repair_audit" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_certified_history_repair_audit_source_range"
          UNIQUE ("sourceRunId", "dateFrom", "dateThrough"),
        CONSTRAINT "CHK_certified_history_repair_audit_range"
          CHECK ("dateFrom" <= "dateThrough"),
        CONSTRAINT "CHK_certified_history_repair_audit_activation"
          CHECK (
            ("activationKind" = 'statistics-only'
              AND "mapManifestRunId" IS NULL)
            OR ("activationKind" = 'statistics-and-maps'
              AND "mapManifestRunId" IS NOT NULL)
          ),
        CONSTRAINT "CHK_certified_history_repair_audit_counts"
          CHECK (
            "communeCount" = 34943
            AND "departmentCount" = 101
            AND "dayCount" > 0
            AND "dayCount" = ("dateThrough" - "dateFrom" + 1)
          ),
        CONSTRAINT "CHK_certified_history_repair_audit_digests"
          CHECK (
            "communeHistoryDigest" ~ '^[a-f0-9]{64}$'
            AND "departmentHistoryDigest" ~ '^[a-f0-9]{64}$'
            AND "statisticDigest" ~ '^[a-f0-9]{64}$'
            AND "provenanceDigest" ~ '^[a-f0-9]{64}$'
          ),
        CONSTRAINT "CHK_certified_history_repair_audit_revisions"
          CHECK (
            "sourceRevision" >= 0
            AND "historicComputeEpoch" >= 0
            AND "historicBackfillGlobalEpoch" >= 0
            AND "publicationRevisionBefore" >= 0
            AND "publicationRevisionAfter" =
                "publicationRevisionBefore" + 1
          ),
        CONSTRAINT "CHK_certified_history_repair_audit_context"
          CHECK (
            jsonb_typeof("publicationContext") = 'object'
            AND "publicationContext" <> '{}'::jsonb
          )
      )
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION
        "reject_certified_history_repair_audit_mutation"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION
          'certified_history_repair_audit is append-only'
          USING ERRCODE = '55000';
      END;
      $$
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS
        "TRG_certified_history_repair_audit_append_only"
      ON "certified_history_repair_audit"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_certified_history_repair_audit_append_only"
      BEFORE UPDATE OR DELETE ON "certified_history_repair_audit"
      FOR EACH ROW
      EXECUTE FUNCTION "reject_certified_history_repair_audit_mutation"()
    `);

    await queryRunner.query(`
      ALTER TABLE "statistic_commune_snapshot"
      ADD COLUMN IF NOT EXISTS "certifiedHistoryRepairId" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "statistic_commune_snapshot"
      DROP CONSTRAINT IF EXISTS "FK_statistic_commune_snapshot_certified_repair"
    `);
    await queryRunner.query(`
      ALTER TABLE "statistic_commune_snapshot"
      ADD CONSTRAINT "FK_statistic_commune_snapshot_certified_repair"
      FOREIGN KEY ("certifiedHistoryRepairId")
      REFERENCES "certified_history_repair_audit"("id")
      ON DELETE RESTRICT
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "IDX_statistic_commune_snapshot_certified_repair"
      ON "statistic_commune_snapshot" ("certifiedHistoryRepairId")
      WHERE "certifiedHistoryRepairId" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION
        "lock_certified_history_snapshot_write"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(
          hashtext('vigieau:statistic-commune:snapshot-computation')
        );
        RETURN NULL;
      END;
      $$
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS
        "TRG_statistic_commune_snapshot_certified_repair_lock"
      ON "statistic_commune_snapshot"
    `);
    await queryRunner.query(`
      CREATE TRIGGER
        "TRG_statistic_commune_snapshot_certified_repair_lock"
      BEFORE INSERT OR UPDATE OR DELETE ON "statistic_commune_snapshot"
      FOR EACH STATEMENT
      EXECUTE FUNCTION "lock_certified_history_snapshot_write"()
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION
        "guard_certified_history_snapshot_provenance"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        promotion_id text := NULLIF(
          current_setting(
            'vigieau.certified_history_promotion_id', true
          ),
          ''
        );
      BEGIN
        -- Promotion is the sole operation allowed to attach provenance. The
        -- operator sets this transaction-local identity while holding the
        -- shared statistic snapshot lock.
        IF TG_OP = 'INSERT'
           AND NEW.scope = 'national'
           AND NEW."certifiedHistoryRepairId" IS NOT NULL
           AND NEW."certifiedHistoryRepairId"::text = promotion_id THEN
          RETURN NEW;
        END IF;
        IF TG_OP = 'UPDATE'
           AND NEW."certifiedHistoryRepairId" IS NOT NULL
           AND NEW."certifiedHistoryRepairId" IS DISTINCT FROM
               OLD."certifiedHistoryRepairId"
           AND NEW."certifiedHistoryRepairId"::text = promotion_id THEN
          RETURN NEW;
        END IF;
        NEW."certifiedHistoryRepairId" := NULL;
        RETURN NEW;
      END;
      $$
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS
        "TRG_statistic_commune_snapshot_guard_certified_repair"
      ON "statistic_commune_snapshot"
    `);
    await queryRunner.query(`
      CREATE TRIGGER
        "TRG_statistic_commune_snapshot_guard_certified_repair"
      BEFORE INSERT OR UPDATE ON "statistic_commune_snapshot"
      FOR EACH ROW
      EXECUTE FUNCTION "guard_certified_history_snapshot_provenance"()
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION
        "revoke_certified_history_repairs_for_dates"(affected_dates date[])
      RETURNS void
      LANGUAGE plpgsql
      AS $$
      DECLARE
        previous_guard text := COALESCE(
          current_setting(
            'vigieau.certified_history_revocation_in_progress', true
          ),
          ''
        );
      BEGIN
        IF previous_guard = 'on' THEN
          RETURN;
        END IF;
        PERFORM set_config(
          'vigieau.certified_history_revocation_in_progress', 'on', true
        );
        WITH affected_repairs AS MATERIALIZED (
          SELECT DISTINCT repair.id
          FROM "certified_history_repair_audit" repair
          CROSS JOIN unnest(affected_dates) affected_date
          WHERE affected_date BETWEEN repair."dateFrom" AND repair."dateThrough"
        )
        UPDATE "statistic_commune_snapshot" repaired_snapshot
        SET "certifiedHistoryRepairId" = NULL
        FROM affected_repairs
        WHERE repaired_snapshot."certifiedHistoryRepairId" =
              affected_repairs.id;
        PERFORM set_config(
          'vigieau.certified_history_revocation_in_progress',
          previous_guard,
          true
        );
      EXCEPTION WHEN OTHERS THEN
        PERFORM set_config(
          'vigieau.certified_history_revocation_in_progress',
          previous_guard,
          true
        );
        RAISE;
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION
        "revoke_certified_history_repair_after_snapshot_insert"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF current_setting(
          'vigieau.certified_history_revocation_in_progress', true
        ) = 'on' THEN
          RETURN NULL;
        END IF;
        PERFORM "revoke_certified_history_repairs_for_dates"(
          ARRAY(
            SELECT DISTINCT inserted."snapshotDate"
            FROM new_snapshot_rows inserted
            WHERE inserted.scope <> 'bootstrap'
              AND inserted."certifiedHistoryRepairId" IS NULL
          )
        );
        RETURN NULL;
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION
        "revoke_certified_history_repair_after_snapshot_update"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF current_setting(
          'vigieau.certified_history_revocation_in_progress', true
        ) = 'on' THEN
          RETURN NULL;
        END IF;
        PERFORM "revoke_certified_history_repairs_for_dates"(
          ARRAY(
            SELECT DISTINCT affected."snapshotDate"
            FROM (
              SELECT previous."snapshotDate"
              FROM old_snapshot_rows previous
              WHERE previous.scope <> 'bootstrap'
                AND previous."certifiedHistoryRepairId" IS NOT NULL
              UNION
              SELECT updated."snapshotDate"
              FROM new_snapshot_rows updated
              WHERE updated.scope <> 'bootstrap'
                AND updated."certifiedHistoryRepairId" IS NULL
            ) affected
          )
        );
        RETURN NULL;
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION
        "revoke_certified_history_repair_after_snapshot_delete"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF current_setting(
          'vigieau.certified_history_revocation_in_progress', true
        ) = 'on' THEN
          RETURN NULL;
        END IF;
        PERFORM "revoke_certified_history_repairs_for_dates"(
          ARRAY(
            SELECT DISTINCT deleted."snapshotDate"
            FROM old_snapshot_rows deleted
            WHERE deleted.scope <> 'bootstrap'
          )
        );
        RETURN NULL;
      END;
      $$
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS
        "TRG_statistic_commune_snapshot_revoke_certified_repair_insert"
      ON "statistic_commune_snapshot"
    `);
    await queryRunner.query(`
      CREATE TRIGGER
        "TRG_statistic_commune_snapshot_revoke_certified_repair_insert"
      AFTER INSERT ON "statistic_commune_snapshot"
      REFERENCING NEW TABLE AS new_snapshot_rows
      FOR EACH STATEMENT
      EXECUTE FUNCTION
        "revoke_certified_history_repair_after_snapshot_insert"()
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS
        "TRG_statistic_commune_snapshot_revoke_certified_repair_update"
      ON "statistic_commune_snapshot"
    `);
    await queryRunner.query(`
      CREATE TRIGGER
        "TRG_statistic_commune_snapshot_revoke_certified_repair_update"
      AFTER UPDATE ON "statistic_commune_snapshot"
      REFERENCING OLD TABLE AS old_snapshot_rows
                  NEW TABLE AS new_snapshot_rows
      FOR EACH STATEMENT
      EXECUTE FUNCTION
        "revoke_certified_history_repair_after_snapshot_update"()
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS
        "TRG_statistic_commune_snapshot_revoke_certified_repair_delete"
      ON "statistic_commune_snapshot"
    `);
    await queryRunner.query(`
      CREATE TRIGGER
        "TRG_statistic_commune_snapshot_revoke_certified_repair_delete"
      AFTER DELETE ON "statistic_commune_snapshot"
      REFERENCING OLD TABLE AS old_snapshot_rows
      FOR EACH STATEMENT
      EXECUTE FUNCTION
        "revoke_certified_history_repair_after_snapshot_delete"()
    `);

    await queryRunner.query(`
      ALTER TABLE "statistic_cache_publication"
      ADD COLUMN IF NOT EXISTS "certifiedHistoryRepairId" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "statistic_cache_publication"
      DROP CONSTRAINT IF EXISTS
        "FK_statistic_cache_publication_certified_repair"
    `);
    await queryRunner.query(`
      ALTER TABLE "statistic_cache_publication"
      ADD CONSTRAINT "FK_statistic_cache_publication_certified_repair"
      FOREIGN KEY ("certifiedHistoryRepairId")
      REFERENCES "certified_history_repair_audit"("id")
      ON DELETE RESTRICT
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "IDX_statistic_cache_publication_certified_repair"
      ON "statistic_cache_publication" ("certifiedHistoryRepairId")
      WHERE "certifiedHistoryRepairId" IS NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "statistic_cache_publication"
      DROP CONSTRAINT IF EXISTS
        "CHK_statistic_cache_publication_certified_repair"
    `);
    await queryRunner.query(`
      ALTER TABLE "statistic_cache_publication"
      ADD CONSTRAINT "CHK_statistic_cache_publication_certified_repair" CHECK (
        (
          "materializationStrategy" = 'certified-history-overlay'
          AND "certifiedHistoryRepairId" IS NOT NULL
        ) OR (
          "materializationStrategy" <> 'certified-history-overlay'
          AND "certifiedHistoryRepairId" IS NULL
        )
      )
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION
        "reject_statistic_cache_publication_repair_mutation"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW."certifiedHistoryRepairId" IS DISTINCT FROM
            OLD."certifiedHistoryRepairId" THEN
          RAISE EXCEPTION
            'statistic cache publication certified repair identity is immutable'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS
        "TRG_statistic_cache_publication_repair_immutable"
      ON "statistic_cache_publication"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_statistic_cache_publication_repair_immutable"
      BEFORE UPDATE OF "certifiedHistoryRepairId"
      ON "statistic_cache_publication"
      FOR EACH ROW
      EXECUTE FUNCTION
        "reject_statistic_cache_publication_repair_mutation"()
    `);

    await queryRunner.query(`
      ALTER TABLE "statistic_cache_publication"
      DROP CONSTRAINT IF EXISTS "CHK_statistic_cache_publication_strategy"
    `);
    await queryRunner.query(`
      ALTER TABLE "statistic_cache_publication"
      ADD CONSTRAINT "CHK_statistic_cache_publication_strategy" CHECK (
        "materializationStrategy" IN (
          'full-clean', 'legacy-safe-boundary', 'daily-delta',
          'current-replace', 'sparse-current', 'certified-history-overlay'
        )
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM "statistic_cache_publication"
          WHERE "materializationStrategy" = 'certified-history-overlay'
             OR "certifiedHistoryRepairId" IS NOT NULL
        ) THEN
          RAISE EXCEPTION
            'cannot remove certified repair audit while overlay publications exist'
            USING ERRCODE = '55000';
        END IF;
      END;
      $$
    `);
    await queryRunner.query(`
      ALTER TABLE "statistic_cache_publication"
      DROP CONSTRAINT IF EXISTS "CHK_statistic_cache_publication_strategy"
    `);
    await queryRunner.query(`
      ALTER TABLE "statistic_cache_publication"
      ADD CONSTRAINT "CHK_statistic_cache_publication_strategy" CHECK (
        "materializationStrategy" IN (
          'full-clean', 'legacy-safe-boundary', 'daily-delta',
          'current-replace', 'sparse-current'
        )
      )
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS
        "TRG_statistic_cache_publication_repair_immutable"
      ON "statistic_cache_publication"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS
        "reject_statistic_cache_publication_repair_mutation"()
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS
        "IDX_statistic_cache_publication_certified_repair"
    `);
    await queryRunner.query(`
      ALTER TABLE "statistic_cache_publication"
      DROP CONSTRAINT IF EXISTS
        "CHK_statistic_cache_publication_certified_repair",
      DROP CONSTRAINT IF EXISTS
        "FK_statistic_cache_publication_certified_repair",
      DROP COLUMN IF EXISTS "certifiedHistoryRepairId"
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS
        "TRG_statistic_commune_snapshot_revoke_certified_repair_delete"
      ON "statistic_commune_snapshot"
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS
        "TRG_statistic_commune_snapshot_revoke_certified_repair_update"
      ON "statistic_commune_snapshot"
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS
        "TRG_statistic_commune_snapshot_revoke_certified_repair_insert"
      ON "statistic_commune_snapshot"
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS
        "TRG_statistic_commune_snapshot_guard_certified_repair"
      ON "statistic_commune_snapshot"
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS
        "TRG_statistic_commune_snapshot_certified_repair_lock"
      ON "statistic_commune_snapshot"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS
        "revoke_certified_history_repair_after_snapshot_delete"()
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS
        "revoke_certified_history_repair_after_snapshot_update"()
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS
        "revoke_certified_history_repair_after_snapshot_insert"()
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS
        "revoke_certified_history_repairs_for_dates"(date[])
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS
        "guard_certified_history_snapshot_provenance"()
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS
        "lock_certified_history_snapshot_write"()
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS
        "IDX_statistic_commune_snapshot_certified_repair"
    `);
    await queryRunner.query(`
      ALTER TABLE "statistic_commune_snapshot"
      DROP CONSTRAINT IF EXISTS "FK_statistic_commune_snapshot_certified_repair",
      DROP COLUMN IF EXISTS "certifiedHistoryRepairId"
    `);
    await queryRunner.query(
      'DROP TABLE IF EXISTS "certified_history_repair_audit"',
    );
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS "reject_certified_history_repair_audit_mutation"()',
    );
  }
}
