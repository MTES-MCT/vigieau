import { MigrationInterface, QueryRunner } from 'typeorm';

export class PublicSourceRevisionAndStatisticCandidate1787140800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '3s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '15min'`);
    await queryRunner.query(`
      ALTER TABLE "zone_publication_source_state"
      ADD COLUMN IF NOT EXISTS "publicRevision" bigint,
      ADD COLUMN IF NOT EXISTS "legacyDualWrite" boolean NOT NULL DEFAULT true
    `);
    await queryRunner.query(`
      UPDATE "zone_publication_source_state"
      SET "publicRevision" = "revision"
      WHERE "publicRevision" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "zone_publication_source_state"
      ALTER COLUMN "publicRevision" SET DEFAULT 0,
      ALTER COLUMN "publicRevision" SET NOT NULL
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION bump_zone_publication_source_revision()
      RETURNS trigger AS $$
      BEGIN
        UPDATE "zone_publication_source_state"
        SET
          "revision" = "revision" + 1,
          "publicRevision" = "publicRevision" + CASE
            WHEN "legacyDualWrite" THEN 1
            ELSE 0
          END,
          "updatedAt" = now()
        WHERE "id" = 1;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      ALTER TABLE "current_zone_recompute_request"
      ADD COLUMN IF NOT EXISTS "targetPublicRevision" bigint,
      ADD COLUMN IF NOT EXISTS "reason" character varying(100),
      ADD COLUMN IF NOT EXISTS "scheduledFor" date,
      ADD COLUMN IF NOT EXISTS "pendingScheduledDates" date[] NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS "currentPending" boolean NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS "nextAttemptAt" timestamptz,
      ADD COLUMN IF NOT EXISTS "supersededCount" integer NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      UPDATE "current_zone_recompute_request" request
      SET
        "targetPublicRevision" = source."publicRevision",
        "reason" = COALESCE(request."reason", 'LEGACY'),
        "nextAttemptAt" = COALESCE(request."nextAttemptAt", request."requestedAt")
      FROM "zone_publication_source_state" source
      WHERE source."id" = 1
        AND (
          request."targetPublicRevision" IS NULL
          OR request."reason" IS NULL
          OR request."nextAttemptAt" IS NULL
        )
    `);
    await queryRunner.query(`
      UPDATE "current_zone_recompute_request"
      SET "pendingScheduledDates" = ARRAY(
        SELECT DISTINCT pending_date
        FROM unnest(
          "pendingScheduledDates" || ARRAY["scheduledFor"]
        ) AS dates(pending_date)
        ORDER BY pending_date
      )
      WHERE "scheduledFor" IS NOT NULL
        AND NOT ("scheduledFor" = ANY("pendingScheduledDates"))
    `);
    await queryRunner.query(`
      ALTER TABLE "current_zone_recompute_request"
      ALTER COLUMN "targetPublicRevision" SET DEFAULT 0,
      ALTER COLUMN "targetPublicRevision" SET NOT NULL,
      ALTER COLUMN "reason" SET DEFAULT 'LEGACY',
      ALTER COLUMN "reason" SET NOT NULL,
      ALTER COLUMN "nextAttemptAt" SET DEFAULT now(),
      ALTER COLUMN "nextAttemptAt" SET NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_current_zone_recompute_request_due"
      ON "current_zone_recompute_request" ("nextAttemptAt", "requestedAt")
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION preserve_current_zone_recompute_contexts()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF NEW."generation" IS DISTINCT FROM OLD."generation"
            AND NEW."targetPublicRevision"
              IS NOT DISTINCT FROM OLD."targetPublicRevision"
            AND NEW."pendingScheduledDates"
              IS NOT DISTINCT FROM OLD."pendingScheduledDates"
            AND NEW."currentPending"
              IS NOT DISTINCT FROM OLD."currentPending"
          THEN
            NEW."currentPending" := true;
          END IF;
          RETURN NEW;
        END IF;

        IF OLD."currentPending"
          OR cardinality(OLD."pendingScheduledDates") > 0
        THEN
          RETURN NULL;
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_preserve_current_zone_recompute_contexts"
      ON "current_zone_recompute_request"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_preserve_current_zone_recompute_contexts"
      BEFORE UPDATE OR DELETE ON "current_zone_recompute_request"
      FOR EACH ROW
      EXECUTE FUNCTION preserve_current_zone_recompute_contexts()
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "zone_type_availability" (
        "departmentCode" character varying(3) NOT NULL,
        "zoneType" character varying(3) NOT NULL,
        "status" character varying(20) NOT NULL,
        "asOf" timestamptz NOT NULL,
        "publicRevision" bigint NOT NULL,
        "officialUrl" text,
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_zone_type_availability"
          PRIMARY KEY ("departmentCode", "zoneType"),
        CONSTRAINT "FK_zone_type_availability_department"
          FOREIGN KEY ("departmentCode") REFERENCES "departement"("code")
          ON UPDATE CASCADE ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "statistic_cache_publication"
      DROP CONSTRAINT IF EXISTS "CHK_statistic_cache_publication_strategy"
    `);
    await queryRunner.query(`
      ALTER TABLE "statistic_cache_publication"
      ADD CONSTRAINT "CHK_statistic_cache_publication_strategy"
      CHECK (
        "materializationStrategy" IN (
          'full-clean',
          'legacy-safe-boundary',
          'daily-delta',
          'current-replace',
          'sparse-current'
        )
      ) NOT VALID
    `);
    await queryRunner.query(`
      ALTER TABLE "statistic_cache_publication"
      VALIDATE CONSTRAINT "CHK_statistic_cache_publication_strategy"
    `);

    await queryRunner.query(`
      ALTER TABLE "statistic_cache_publication"
      ADD COLUMN IF NOT EXISTS "protocolVersion" integer NOT NULL DEFAULT 1
    `);
    await queryRunner.query(`
      ALTER TABLE "statistic_cache_state"
      ADD COLUMN IF NOT EXISTS "candidatePublicationId" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "zone_publication_instance"
      ADD COLUMN IF NOT EXISTS "statisticSourceRevision" bigint,
      ADD COLUMN IF NOT EXISTS "statisticProtocolVersion" integer,
      ADD COLUMN IF NOT EXISTS "candidateStatisticCachePublicationId" uuid,
      ADD COLUMN IF NOT EXISTS "candidateStatisticRevision" bigint,
      ADD COLUMN IF NOT EXISTS "candidateStatisticPublishedDate" date,
      ADD COLUMN IF NOT EXISTS "candidateStatisticSourceRevision" bigint,
      ADD COLUMN IF NOT EXISTS "candidateStatisticFingerprint" character varying(64),
      ADD COLUMN IF NOT EXISTS "candidateStatisticProtocolVersion" integer,
      ADD COLUMN IF NOT EXISTS "candidateStatisticLastError" text
    `);
    await queryRunner.query(`
      UPDATE "zone_publication_instance" instance
      SET
        "statisticSourceRevision" = publication."sourceRevision",
        "statisticProtocolVersion" = publication."protocolVersion"
      FROM "statistic_cache_publication" publication
      WHERE publication."id" = instance."statisticCachePublicationId"
        AND (
          instance."statisticSourceRevision" IS NULL
          OR instance."statisticProtocolVersion" IS NULL
        )
    `);
    await queryRunner.query(`
      ALTER TABLE "zone_publication_instance"
      ALTER COLUMN "statisticProtocolVersion" SET DEFAULT 1
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION normalize_zone_publication_instance_statistic_identity()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."statisticCachePublicationId" IS NULL THEN
          NEW."statisticSourceRevision" := NULL;
          NEW."statisticProtocolVersion" := NULL;
        ELSIF NEW."statisticProtocolVersion" IS NULL THEN
          NEW."statisticProtocolVersion" := 1;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_zone_publication_instance_statistic_identity"
      ON "zone_publication_instance"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_zone_publication_instance_statistic_identity"
      BEFORE INSERT OR UPDATE ON "zone_publication_instance"
      FOR EACH ROW
      EXECUTE FUNCTION normalize_zone_publication_instance_statistic_identity()
    `);

    const checkConstraints = [
      {
        table: 'zone_publication_source_state',
        name: 'CHK_zone_publication_source_state_public_revision',
        definition: '"publicRevision" >= 0',
      },
      {
        table: 'current_zone_recompute_request',
        name: 'CHK_current_zone_recompute_request_public_revision',
        definition: '"targetPublicRevision" >= 0 AND "supersededCount" >= 0',
      },
      {
        table: 'zone_type_availability',
        name: 'CHK_zone_type_availability_zone_type',
        definition: "\"zoneType\" IN ('SOU', 'SUP', 'AEP')",
      },
      {
        table: 'zone_type_availability',
        name: 'CHK_zone_type_availability_status',
        definition:
          "\"status\" IN ('available', 'confirmed_none', 'unavailable')",
      },
      {
        table: 'zone_type_availability',
        name: 'CHK_zone_type_availability_public_revision',
        definition: '"publicRevision" >= 0',
      },
      {
        table: 'statistic_cache_publication',
        name: 'CHK_statistic_cache_publication_protocol_version',
        definition: '"protocolVersion" > 0',
      },
      {
        table: 'statistic_cache_state',
        name: 'CHK_statistic_cache_state_candidate_distinct',
        definition: `
          ("candidatePublicationId" IS NULL OR "activePublicationId" IS NULL
            OR "candidatePublicationId" <> "activePublicationId")
          AND
          ("candidatePublicationId" IS NULL OR "previousPublicationId" IS NULL
            OR "candidatePublicationId" <> "previousPublicationId")
        `,
      },
      {
        table: 'zone_publication_instance',
        name: 'CHK_zone_publication_instance_statistic_candidate_identity',
        definition: `
          (
            "candidateStatisticCachePublicationId" IS NULL
            AND "candidateStatisticRevision" IS NULL
            AND "candidateStatisticPublishedDate" IS NULL
            AND "candidateStatisticSourceRevision" IS NULL
            AND "candidateStatisticFingerprint" IS NULL
            AND "candidateStatisticProtocolVersion" IS NULL
            AND "candidateStatisticLastError" IS NULL
          )
          OR (
            "candidateStatisticCachePublicationId" IS NOT NULL
            AND "candidateStatisticRevision" IS NULL
            AND "candidateStatisticPublishedDate" IS NULL
            AND "candidateStatisticSourceRevision" IS NULL
            AND "candidateStatisticFingerprint" IS NULL
            AND "candidateStatisticProtocolVersion" IS NULL
            AND "candidateStatisticLastError" IS NOT NULL
          )
          OR (
            "candidateStatisticCachePublicationId" IS NOT NULL
            AND "candidateStatisticRevision" IS NOT NULL
            AND "candidateStatisticRevision" >= 0
            AND "candidateStatisticPublishedDate" IS NOT NULL
            AND (
              "candidateStatisticSourceRevision" IS NULL
              OR "candidateStatisticSourceRevision" >= 0
            )
            AND "candidateStatisticFingerprint" IS NOT NULL
            AND "candidateStatisticFingerprint" ~ '^[0-9a-f]{64}$'
            AND "candidateStatisticProtocolVersion" IS NOT NULL
            AND "candidateStatisticProtocolVersion" > 0
          )
        `,
      },
    ];
    for (const constraint of checkConstraints) {
      await queryRunner.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = '${constraint.name}'
              AND conrelid = '"${constraint.table}"'::regclass
          ) THEN
            ALTER TABLE "${constraint.table}"
            ADD CONSTRAINT "${constraint.name}"
            CHECK (${constraint.definition}) NOT VALID;
          END IF;
        END
        $$
      `);
      await queryRunner.query(`
        ALTER TABLE "${constraint.table}"
        VALIDATE CONSTRAINT "${constraint.name}"
      `);
    }

    await queryRunner.query(`
      ALTER TABLE "zone_publication_instance"
      DROP CONSTRAINT IF EXISTS "CHK_zone_publication_instance_statistic_identity"
    `);
    await queryRunner.query(`
      ALTER TABLE "zone_publication_instance"
      ADD CONSTRAINT "CHK_zone_publication_instance_statistic_identity"
      CHECK (
        (
          "statisticCachePublicationId" IS NULL
          AND "statisticRevision" IS NULL
          AND "statisticPublishedDate" IS NULL
          AND "statisticSourceRevision" IS NULL
          AND "statisticFingerprint" IS NULL
          AND "statisticProtocolVersion" IS NULL
        )
        OR (
          "statisticCachePublicationId" IS NOT NULL
          AND "statisticRevision" IS NOT NULL
          AND "statisticRevision" >= 0
          AND "statisticPublishedDate" IS NOT NULL
          AND ("statisticSourceRevision" IS NULL OR "statisticSourceRevision" >= 0)
          AND "statisticFingerprint" IS NOT NULL
          AND "statisticFingerprint" ~ '^[0-9a-f]{64}$'
          AND "statisticProtocolVersion" IS NOT NULL
          AND "statisticProtocolVersion" > 0
        )
      ) NOT VALID
    `);
    await queryRunner.query(`
      ALTER TABLE "zone_publication_instance"
      VALIDATE CONSTRAINT "CHK_zone_publication_instance_statistic_identity"
    `);

    const foreignKeys = [
      {
        table: 'statistic_cache_state',
        name: 'FK_statistic_cache_state_candidate',
        definition: `
          FOREIGN KEY ("candidatePublicationId")
          REFERENCES "statistic_cache_publication"("id") ON DELETE RESTRICT
        `,
      },
      {
        table: 'zone_publication_instance',
        name: 'FK_zone_publication_instance_candidate_statistic_cache',
        definition: `
          FOREIGN KEY ("candidateStatisticCachePublicationId")
          REFERENCES "statistic_cache_publication"("id") ON DELETE RESTRICT
        `,
      },
    ];
    for (const foreignKey of foreignKeys) {
      await queryRunner.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = '${foreignKey.name}'
              AND conrelid = '"${foreignKey.table}"'::regclass
          ) THEN
            ALTER TABLE "${foreignKey.table}"
            ADD CONSTRAINT "${foreignKey.name}"
            ${foreignKey.definition} NOT VALID;
          END IF;
        END
        $$
      `);
      await queryRunner.query(`
        ALTER TABLE "${foreignKey.table}"
        VALIDATE CONSTRAINT "${foreignKey.name}"
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "statistic_cache_publication"
      DROP CONSTRAINT IF EXISTS "CHK_statistic_cache_publication_strategy"
    `);
    await queryRunner.query(`
      ALTER TABLE "statistic_cache_publication"
      ADD CONSTRAINT "CHK_statistic_cache_publication_strategy"
      CHECK (
        "materializationStrategy" IN (
          'full-clean',
          'legacy-safe-boundary',
          'daily-delta',
          'current-replace'
        )
      ) NOT VALID
    `);
    await queryRunner.query(`
      ALTER TABLE "statistic_cache_publication"
      VALIDATE CONSTRAINT "CHK_statistic_cache_publication_strategy"
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_preserve_current_zone_recompute_contexts"
      ON "current_zone_recompute_request"
    `);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS preserve_current_zone_recompute_contexts`,
    );
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_zone_publication_instance_statistic_identity"
      ON "zone_publication_instance"
    `);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS normalize_zone_publication_instance_statistic_identity`,
    );
    await queryRunner.query(`
      ALTER TABLE "zone_publication_instance"
      DROP CONSTRAINT IF EXISTS "FK_zone_publication_instance_candidate_statistic_cache",
      DROP CONSTRAINT IF EXISTS "CHK_zone_publication_instance_statistic_candidate_identity",
      DROP CONSTRAINT IF EXISTS "CHK_zone_publication_instance_statistic_identity"
    `);
    await queryRunner.query(`
      ALTER TABLE "zone_publication_instance"
      DROP COLUMN IF EXISTS "candidateStatisticLastError",
      DROP COLUMN IF EXISTS "candidateStatisticProtocolVersion",
      DROP COLUMN IF EXISTS "candidateStatisticFingerprint",
      DROP COLUMN IF EXISTS "candidateStatisticSourceRevision",
      DROP COLUMN IF EXISTS "candidateStatisticPublishedDate",
      DROP COLUMN IF EXISTS "candidateStatisticRevision",
      DROP COLUMN IF EXISTS "candidateStatisticCachePublicationId",
      DROP COLUMN IF EXISTS "statisticProtocolVersion",
      DROP COLUMN IF EXISTS "statisticSourceRevision"
    `);
    await queryRunner.query(`
      ALTER TABLE "zone_publication_instance"
      ADD CONSTRAINT "CHK_zone_publication_instance_statistic_identity"
      CHECK (
        (
          "statisticCachePublicationId" IS NULL
          AND "statisticRevision" IS NULL
          AND "statisticPublishedDate" IS NULL
          AND "statisticFingerprint" IS NULL
        )
        OR (
          "statisticCachePublicationId" IS NOT NULL
          AND "statisticRevision" IS NOT NULL
          AND "statisticRevision" >= 0
          AND "statisticPublishedDate" IS NOT NULL
          AND "statisticFingerprint" ~ '^[0-9a-f]{64}$'
        )
      ) NOT VALID
    `);
    await queryRunner.query(`
      ALTER TABLE "zone_publication_instance"
      VALIDATE CONSTRAINT "CHK_zone_publication_instance_statistic_identity"
    `);
    await queryRunner.query(`
      ALTER TABLE "statistic_cache_state"
      DROP CONSTRAINT IF EXISTS "FK_statistic_cache_state_candidate",
      DROP CONSTRAINT IF EXISTS "CHK_statistic_cache_state_candidate_distinct",
      DROP COLUMN IF EXISTS "candidatePublicationId"
    `);
    await queryRunner.query(`
      ALTER TABLE "statistic_cache_publication"
      DROP CONSTRAINT IF EXISTS "CHK_statistic_cache_publication_protocol_version",
      DROP COLUMN IF EXISTS "protocolVersion"
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "zone_type_availability"`);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_current_zone_recompute_request_due"
    `);
    await queryRunner.query(`
      ALTER TABLE "current_zone_recompute_request"
      DROP CONSTRAINT IF EXISTS "CHK_current_zone_recompute_request_public_revision",
      DROP COLUMN IF EXISTS "supersededCount",
      DROP COLUMN IF EXISTS "nextAttemptAt",
      DROP COLUMN IF EXISTS "currentPending",
      DROP COLUMN IF EXISTS "pendingScheduledDates",
      DROP COLUMN IF EXISTS "scheduledFor",
      DROP COLUMN IF EXISTS "reason",
      DROP COLUMN IF EXISTS "targetPublicRevision"
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION bump_zone_publication_source_revision()
      RETURNS trigger AS $$
      BEGIN
        UPDATE "zone_publication_source_state"
        SET "revision" = "revision" + 1, "updatedAt" = now()
        WHERE "id" = 1;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      ALTER TABLE "zone_publication_source_state"
      DROP CONSTRAINT IF EXISTS "CHK_zone_publication_source_state_public_revision",
      DROP COLUMN IF EXISTS "legacyDualWrite",
      DROP COLUMN IF EXISTS "publicRevision"
    `);
  }
}
