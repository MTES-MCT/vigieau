import { MigrationInterface, QueryRunner } from 'typeorm';

export class HistoricRangeAwareCertifiedRepair1788199200000 implements MigrationInterface {
  name = 'HistoricRangeAwareCertifiedRepair1788199200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "historic_range_invalidation" (
        "epochAfter" bigint NOT NULL,
        "affectedRange" daterange NOT NULL,
        "invalidatesStatistics" boolean NOT NULL,
        "invalidatesMaps" boolean NOT NULL,
        "cause" character varying(120) NOT NULL,
        "sourceRevision" bigint,
        "context" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "PK_historic_range_invalidation"
          PRIMARY KEY ("epochAfter"),
        CONSTRAINT "CHK_historic_range_invalidation_epoch"
          CHECK ("epochAfter" >= 0),
        CONSTRAINT "CHK_historic_range_invalidation_cause"
          CHECK (length(trim("cause")) > 0),
        CONSTRAINT "CHK_historic_range_invalidation_context"
          CHECK (jsonb_typeof("context") = 'object'),
        CONSTRAINT "CHK_historic_range_invalidation_scope"
          CHECK (
            NOT isempty("affectedRange")
            OR (
              NOT "invalidatesStatistics"
              AND NOT "invalidatesMaps"
            )
          )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "IDX_historic_range_invalidation_range"
      ON "historic_range_invalidation"
      USING gist ("affectedRange")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "IDX_historic_range_invalidation_statistics_epoch"
      ON "historic_range_invalidation" ("epochAfter")
      WHERE "invalidatesStatistics"
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS
        "certified_history_repair_attestation" (
          "id" uuid NOT NULL,
          "repairId" uuid NOT NULL,
          "attestedThroughEpoch" bigint NOT NULL,
          "sourceRevision" bigint NOT NULL,
          "statisticRevision" bigint NOT NULL,
          "communeHistoryDigest" character varying(64) NOT NULL,
          "departmentHistoryDigest" character varying(64) NOT NULL,
          "statisticDigest" character varying(64) NOT NULL,
          "provenanceDigest" character varying(64) NOT NULL,
          "context" jsonb NOT NULL,
          "attestedAt" timestamp with time zone NOT NULL DEFAULT now(),
          CONSTRAINT "PK_certified_history_repair_attestation"
            PRIMARY KEY ("id"),
          CONSTRAINT "FK_certified_history_repair_attestation_repair"
            FOREIGN KEY ("repairId")
            REFERENCES "certified_history_repair_audit"("id")
            ON DELETE RESTRICT,
          CONSTRAINT "CHK_certified_history_repair_attestation_revisions"
            CHECK (
              "attestedThroughEpoch" >= 0
              AND "sourceRevision" >= 0
              AND "statisticRevision" >= 0
            ),
          CONSTRAINT "CHK_certified_history_repair_attestation_digests"
            CHECK (
              "communeHistoryDigest" ~ '^[a-f0-9]{64}$'
              AND "departmentHistoryDigest" ~ '^[a-f0-9]{64}$'
              AND "statisticDigest" ~ '^[a-f0-9]{64}$'
              AND "provenanceDigest" ~ '^[a-f0-9]{64}$'
            ),
          CONSTRAINT "CHK_certified_history_repair_attestation_context"
            CHECK (
              jsonb_typeof("context") = 'object'
              AND "context" <> '{}'::jsonb
            )
        )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "IDX_certified_history_repair_attestation_latest"
      ON "certified_history_repair_attestation"
        ("repairId", "attestedThroughEpoch" DESC, "attestedAt" DESC)
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION
        "reject_historic_range_ledger_mutation"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'historic range certification ledgers are append-only'
          USING ERRCODE = '55000';
      END;
      $$
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_historic_range_invalidation_append_only"
      ON "historic_range_invalidation"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_historic_range_invalidation_append_only"
      BEFORE UPDATE OR DELETE ON "historic_range_invalidation"
      FOR EACH ROW
      EXECUTE FUNCTION "reject_historic_range_ledger_mutation"()
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS
        "TRG_certified_history_repair_attestation_append_only"
      ON "certified_history_repair_attestation"
    `);
    await queryRunner.query(`
      CREATE TRIGGER
        "TRG_certified_history_repair_attestation_append_only"
      BEFORE UPDATE OR DELETE ON "certified_history_repair_attestation"
      FOR EACH ROW
      EXECUTE FUNCTION "reject_historic_range_ledger_mutation"()
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION
        "guard_certified_history_repair_attestation_insert"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        authorized_id text := NULLIF(
          current_setting(
            'vigieau.certified_history_attestation_id', true
          ),
          ''
        );
      BEGIN
        IF authorized_id IS NULL OR NEW.id::text <> authorized_id THEN
          RAISE EXCEPTION
            'certified history repair attestation requires certified validation'
            USING ERRCODE = '55000';
        END IF;
        IF NOT EXISTS (
          SELECT 1
          FROM "certified_history_repair_audit" repair
          CROSS JOIN "config" config
          CROSS JOIN "statistic_publication_state" publication
          WHERE repair.id = NEW."repairId"
            AND config.id = 1
            AND publication.id = 1
            AND NEW."attestedThroughEpoch" = config."historicComputeEpoch"
            AND NEW."sourceRevision" = repair."sourceRevision"
            AND NEW."statisticRevision" = publication.revision
            AND NEW."communeHistoryDigest" =
                repair."communeHistoryDigest"
            AND NEW."departmentHistoryDigest" =
                repair."departmentHistoryDigest"
            AND NEW."statisticDigest" = repair."statisticDigest"
            AND NEW."provenanceDigest" = repair."provenanceDigest"
            AND NOT EXISTS (
              SELECT 1
              FROM generate_series(
                repair."dateFrom", repair."dateThrough", '1 day'::interval
              ) repaired_day(value)
              WHERE NOT EXISTS (
                SELECT 1
                FROM "statistic_commune_snapshot" snapshot
                WHERE snapshot."snapshotDate" = repaired_day.value::date
                  AND snapshot.scope = 'national'
                  AND snapshot.status = 'completed'
                  AND snapshot."expectedCommuneCount" = repair."communeCount"
                  AND snapshot."processedCommuneCount" = repair."communeCount"
                  AND snapshot."sourceRevision" IS NULL
                  AND snapshot."certifiedHistoryRepairId" = repair.id
              )
            )
        ) THEN
          RAISE EXCEPTION
            'certified history repair attestation lost its validation boundary'
            USING ERRCODE = '40001';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS
        "TRG_certified_history_repair_attestation_guard"
      ON "certified_history_repair_attestation"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_certified_history_repair_attestation_guard"
      BEFORE INSERT ON "certified_history_repair_attestation"
      FOR EACH ROW
      EXECUTE FUNCTION "guard_certified_history_repair_attestation_insert"()
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION
        "record_historic_range_invalidation_after_epoch_update"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        payload_text text := NULLIF(
          current_setting('vigieau.historic_invalidation_payload', true),
          ''
        );
        payload jsonb := NULL;
        affected_from date := NULL;
        affected_through date := NULL;
        invalidates_statistics boolean := true;
        invalidates_maps boolean := true;
        event_cause text := 'legacy-epoch-writer-fallback';
        event_source_revision bigint := NULL;
        event_context jsonb := jsonb_build_object(
          'fallback', true,
          'epochBefore', OLD."historicComputeEpoch"::text,
          'epochAfter', NEW."historicComputeEpoch"::text
        );
        affected_range daterange;
      BEGIN
        IF NEW."historicComputeEpoch" IS NOT DISTINCT FROM
            OLD."historicComputeEpoch" THEN
          RETURN NULL;
        END IF;
        IF payload_text IS NOT NULL THEN
          BEGIN
            payload := payload_text::jsonb;
            affected_from := NULLIF(payload ->> 'affectedFrom', '')::date;
            affected_through :=
              NULLIF(payload ->> 'affectedThrough', '')::date;
            invalidates_statistics := COALESCE(
              (payload ->> 'invalidatesStatistics')::boolean,
              true
            );
            invalidates_maps := COALESCE(
              (payload ->> 'invalidatesMaps')::boolean,
              true
            );
            event_cause := COALESCE(
              NULLIF(payload ->> 'cause', ''),
              event_cause
            );
            event_source_revision :=
              NULLIF(payload ->> 'sourceRevision', '')::bigint;
            event_context := COALESCE(payload -> 'context', '{}'::jsonb)
              || jsonb_build_object(
                'fallback', false,
                'epochBefore', OLD."historicComputeEpoch"::text,
                'epochAfter', NEW."historicComputeEpoch"::text
              );
          EXCEPTION WHEN OTHERS THEN
            payload := NULL;
            affected_from := NULL;
            affected_through := NULL;
            invalidates_statistics := true;
            invalidates_maps := true;
            event_cause := 'legacy-epoch-writer-fallback';
            event_source_revision := NULL;
            event_context := jsonb_build_object(
              'fallback', true,
              'invalidPayload', true,
              'epochBefore', OLD."historicComputeEpoch"::text,
              'epochAfter', NEW."historicComputeEpoch"::text
            );
          END;
        END IF;
        IF NOT invalidates_statistics AND NOT invalidates_maps THEN
          affected_range := 'empty'::daterange;
        ELSE
          affected_through := COALESCE(
            affected_through,
            (now() AT TIME ZONE 'Europe/Paris')::date - 1
          );
          IF affected_from IS NOT NULL
             AND affected_from > affected_through THEN
            affected_range := 'empty'::daterange;
            invalidates_statistics := false;
            invalidates_maps := false;
          ELSE
            affected_range := daterange(
              affected_from,
              affected_through + 1,
              '[)'
            );
          END IF;
        END IF;
        INSERT INTO "historic_range_invalidation" (
          "epochAfter", "affectedRange", "invalidatesStatistics",
          "invalidatesMaps", "cause", "sourceRevision", "context"
        ) VALUES (
          NEW."historicComputeEpoch", affected_range,
          invalidates_statistics, invalidates_maps, event_cause,
          event_source_revision, event_context
        );
        RETURN NULL;
      END;
      $$
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS
        "TRG_config_record_historic_range_invalidation"
      ON "config"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_config_record_historic_range_invalidation"
      AFTER UPDATE OF "historicComputeEpoch" ON "config"
      FOR EACH ROW
      WHEN (
        NEW."historicComputeEpoch" IS DISTINCT FROM
        OLD."historicComputeEpoch"
      )
      EXECUTE FUNCTION
        "record_historic_range_invalidation_after_epoch_update"()
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "record_historic_compute_invalidation"(
        affected_from date,
        affected_through date,
        invalidates_statistics boolean,
        invalidates_maps boolean,
        event_cause text,
        source_revision bigint DEFAULT NULL,
        event_context jsonb DEFAULT '{}'::jsonb,
        requested_map_date date DEFAULT NULL,
        requested_stats_date date DEFAULT NULL,
        force_cursor boolean DEFAULT false,
        reset_cursors boolean DEFAULT false,
        bump_backfill_epoch boolean DEFAULT false,
        bump_historic_epoch boolean DEFAULT true,
        only_if_cursor_rewinds boolean DEFAULT false
      )
      RETURNS TABLE (
        "historicComputeEpoch" bigint,
        "computeMapDate" date,
        "computeStatsDate" date,
        "changed" boolean
      )
      LANGUAGE plpgsql
      AS $$
      DECLARE
        payload jsonb;
      BEGIN
        IF event_cause IS NULL OR length(trim(event_cause)) = 0 THEN
          RAISE EXCEPTION 'historic invalidation cause is required';
        END IF;
        IF jsonb_typeof(COALESCE(event_context, '{}'::jsonb)) <> 'object' THEN
          RAISE EXCEPTION 'historic invalidation context must be an object';
        END IF;
        payload := jsonb_build_object(
          'affectedFrom', affected_from,
          'affectedThrough', affected_through,
          'invalidatesStatistics', invalidates_statistics,
          'invalidatesMaps', invalidates_maps,
          'cause', event_cause,
          'sourceRevision', source_revision,
          'context', COALESCE(event_context, '{}'::jsonb)
        );
        PERFORM set_config(
          'vigieau.historic_invalidation_payload', payload::text, true
        );
        RETURN QUERY
        WITH updated AS MATERIALIZED (
          UPDATE "config" config
          SET
            "computeMapDate" = CASE
              WHEN reset_cursors THEN NULL
              WHEN requested_map_date IS NULL THEN config."computeMapDate"
              WHEN force_cursor THEN requested_map_date
              ELSE LEAST(
                COALESCE(config."computeMapDate", requested_map_date),
                requested_map_date
              )
            END,
            "computeStatsDate" = CASE
              WHEN reset_cursors THEN NULL
              WHEN requested_stats_date IS NULL THEN config."computeStatsDate"
              WHEN force_cursor THEN requested_stats_date
              ELSE LEAST(
                COALESCE(config."computeStatsDate", requested_stats_date),
                requested_stats_date
              )
            END,
            "computeMapGeneration" = config."computeMapGeneration" + CASE
              WHEN reset_cursors OR requested_map_date IS NOT NULL THEN 1
              ELSE 0
            END,
            "computeStatsGeneration" =
              config."computeStatsGeneration" + CASE
                WHEN reset_cursors OR requested_stats_date IS NOT NULL THEN 1
                ELSE 0
              END,
            "historicComputeEpoch" = config."historicComputeEpoch" + CASE
              WHEN bump_historic_epoch THEN 1 ELSE 0
            END,
            "historicBackfillGlobalEpoch" =
              config."historicBackfillGlobalEpoch" + CASE
                WHEN bump_backfill_epoch THEN 1 ELSE 0
              END
          WHERE config.id = 1
            AND (
              NOT only_if_cursor_rewinds
              OR reset_cursors
              OR (
                requested_map_date IS NOT NULL
                AND (
                  config."computeMapDate" IS NULL
                  OR config."computeMapDate" > requested_map_date
                )
              )
              OR (
                requested_stats_date IS NOT NULL
                AND (
                  config."computeStatsDate" IS NULL
                  OR config."computeStatsDate" > requested_stats_date
                )
              )
            )
          RETURNING
            config."historicComputeEpoch",
            config."computeMapDate",
            config."computeStatsDate"
        )
        SELECT
          updated."historicComputeEpoch",
          updated."computeMapDate",
          updated."computeStatsDate",
          true
        FROM updated;
        PERFORM set_config(
          'vigieau.historic_invalidation_payload', '', true
        );
      EXCEPTION WHEN OTHERS THEN
        PERFORM set_config(
          'vigieau.historic_invalidation_payload', '', true
        );
        RAISE;
      END;
      $$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE VIEW "active_certified_history_repair" AS
      SELECT
        repair.id,
        repair."sourceRunId",
        repair."dateFrom",
        repair."dateThrough",
        repair."communeCount",
        repair."departmentCount",
        repair."dayCount",
        repair."communeHistoryDigest",
        repair."departmentHistoryDigest",
        repair."statisticDigest",
        repair."provenanceDigest",
        repair."sourceRevision",
        repair."historicComputeEpoch",
        repair."historicBackfillGlobalEpoch",
        repair."activationKind",
        repair."mapManifestRunId",
        repair."publicationRevisionBefore",
        repair."publicationRevisionAfter",
        repair."publicationContext",
        repair."promotedAt",
        attestation.id AS "attestationId",
        attestation."attestedThroughEpoch",
        attestation."sourceRevision" AS "attestationSourceRevision",
        attestation."statisticRevision" AS "attestationStatisticRevision",
        attestation.context AS "attestationContext",
        attestation."attestedAt",
        config."historicComputeEpoch" AS "currentHistoricComputeEpoch"
      FROM "certified_history_repair_audit" repair
      CROSS JOIN "config" config
      JOIN LATERAL (
        SELECT candidate.*
        FROM "certified_history_repair_attestation" candidate
        WHERE candidate."repairId" = repair.id
          AND candidate."attestedThroughEpoch" <=
              config."historicComputeEpoch"
          AND candidate."communeHistoryDigest" =
              repair."communeHistoryDigest"
          AND candidate."departmentHistoryDigest" =
              repair."departmentHistoryDigest"
          AND candidate."statisticDigest" = repair."statisticDigest"
          AND candidate."provenanceDigest" = repair."provenanceDigest"
        ORDER BY
          candidate."attestedThroughEpoch" DESC,
          candidate."attestedAt" DESC,
          candidate.id DESC
        LIMIT 1
      ) attestation ON true
      WHERE config.id = 1
        AND NOT EXISTS (
          SELECT 1
          FROM "historic_range_invalidation" invalidation
          WHERE invalidation."epochAfter" >
                attestation."attestedThroughEpoch"
            AND (
              invalidation."invalidatesStatistics"
              OR (
                repair."activationKind" = 'statistics-and-maps'
                AND invalidation."invalidatesMaps"
              )
            )
            AND invalidation."affectedRange" && daterange(
              repair."dateFrom", repair."dateThrough" + 1, '[)'
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM generate_series(
            repair."dateFrom", repair."dateThrough", '1 day'::interval
          ) repaired_day(value)
          WHERE NOT EXISTS (
            SELECT 1
            FROM "statistic_commune_snapshot" snapshot
            WHERE snapshot."snapshotDate" = repaired_day.value::date
              AND snapshot.scope = 'national'
              AND snapshot.status = 'completed'
              AND snapshot."expectedCommuneCount" = repair."communeCount"
              AND snapshot."processedCommuneCount" = repair."communeCount"
              AND snapshot."sourceRevision" IS NULL
              AND snapshot."certifiedHistoryRepairId" = repair.id
          )
        )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP VIEW IF EXISTS "active_certified_history_repair"',
    );
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS "record_historic_compute_invalidation"(date, date, boolean, boolean, text, bigint, jsonb, date, date, boolean, boolean, boolean, boolean, boolean)',
    );
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS
        "TRG_config_record_historic_range_invalidation"
      ON "config"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS
        "record_historic_range_invalidation_after_epoch_update"()
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS
        "TRG_certified_history_repair_attestation_guard"
      ON "certified_history_repair_attestation"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS
        "guard_certified_history_repair_attestation_insert"()
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS
        "TRG_certified_history_repair_attestation_append_only"
      ON "certified_history_repair_attestation"
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_historic_range_invalidation_append_only"
      ON "historic_range_invalidation"
    `);
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS "reject_historic_range_ledger_mutation"()',
    );
    await queryRunner.query(
      'DROP TABLE IF EXISTS "certified_history_repair_attestation"',
    );
    await queryRunner.query(
      'DROP TABLE IF EXISTS "historic_range_invalidation"',
    );
  }
}
