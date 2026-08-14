import { MigrationInterface, QueryRunner } from 'typeorm';

export class ZonePublicationDurability1785608400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "zone_publication"
      ADD COLUMN IF NOT EXISTS "departmentCount" integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "contentFingerprint" character varying(64),
      ADD COLUMN IF NOT EXISTS "validationReport" jsonb
    `);
    await queryRunner.query(`
      ALTER TABLE "zone_publication_instance"
      ADD COLUMN IF NOT EXISTS "contentFingerprint" character varying(64)
    `);
    await queryRunner.query(`
      ALTER TABLE "zone_publication_state"
      ADD COLUMN IF NOT EXISTS "candidateRequestedAt" TIMESTAMP WITH TIME ZONE,
      ADD COLUMN IF NOT EXISTS "automaticPublishingPaused" boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "automaticPublishingPausedAt" TIMESTAMP WITH TIME ZONE
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "zone_publication_aggregate" (
        "publicationId" uuid NOT NULL,
        "payload" jsonb NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_zone_publication_aggregate"
          PRIMARY KEY ("publicationId"),
        CONSTRAINT "FK_zone_publication_aggregate_publication"
          FOREIGN KEY ("publicationId") REFERENCES "zone_publication"("id")
          ON DELETE CASCADE,
        CONSTRAINT "CHK_zone_publication_aggregate_payload"
          CHECK (
            jsonb_typeof("payload") = 'object'
            AND ("payload" ->> 'schemaVersion')::integer = 1
            AND jsonb_typeof("payload" -> 'counts') = 'object'
            AND jsonb_typeof("payload" -> 'departments') = 'object'
          )
      )
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_zone_publication_aggregate_publication'
            AND conrelid = '"zone_publication_aggregate"'::regclass
        ) THEN
          ALTER TABLE "zone_publication_aggregate"
          ADD CONSTRAINT "FK_zone_publication_aggregate_publication"
          FOREIGN KEY ("publicationId") REFERENCES "zone_publication"("id")
          ON DELETE CASCADE;
        END IF;
      END
      $$
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_zone_publication_aggregate_payload'
            AND conrelid = '"zone_publication_aggregate"'::regclass
        ) THEN
          ALTER TABLE "zone_publication_aggregate"
          ADD CONSTRAINT "CHK_zone_publication_aggregate_payload"
          CHECK (
            jsonb_typeof("payload") = 'object'
            AND ("payload" ->> 'schemaVersion')::integer = 1
            AND jsonb_typeof("payload" -> 'counts') = 'object'
            AND jsonb_typeof("payload" -> 'departments') = 'object'
          ) NOT VALID;
        END IF;
      END
      $$
    `);
    await queryRunner.query(`
      ALTER TABLE "zone_publication_aggregate"
      VALIDATE CONSTRAINT "CHK_zone_publication_aggregate_payload"
    `);

    await queryRunner.query(`
      ALTER TABLE "zone_publication"
      ADD CONSTRAINT "CHK_zone_publication_content_fingerprint"
      CHECK (
        "contentFingerprint" IS NULL
        OR "contentFingerprint" ~ '^[0-9a-f]{64}$'
      ) NOT VALID
    `);
    await queryRunner.query(`
      ALTER TABLE "zone_publication"
      VALIDATE CONSTRAINT "CHK_zone_publication_content_fingerprint"
    `);
    await queryRunner.query(`
      ALTER TABLE "zone_publication_instance"
      ADD CONSTRAINT "CHK_zone_publication_instance_content_fingerprint"
      CHECK (
        "contentFingerprint" IS NULL
        OR "contentFingerprint" ~ '^[0-9a-f]{64}$'
      ) NOT VALID
    `);
    await queryRunner.query(`
      ALTER TABLE "zone_publication_instance"
      VALIDATE CONSTRAINT "CHK_zone_publication_instance_content_fingerprint"
    `);

    await queryRunner.query(`
      CREATE TRIGGER "TRG_zone_publication_aggregate_immutable"
      BEFORE INSERT OR UPDATE OR DELETE ON "zone_publication_aggregate"
      FOR EACH ROW EXECUTE FUNCTION enforce_zone_publication_content_immutable()
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION enforce_zone_publication_durability_metadata_immutable()
      RETURNS trigger AS $$
      BEGIN
        IF OLD."status" <> 'building' AND (
          NEW."departmentCount" IS DISTINCT FROM OLD."departmentCount"
          OR NEW."contentFingerprint" IS DISTINCT FROM OLD."contentFingerprint"
          OR NEW."validationReport" IS DISTINCT FROM OLD."validationReport"
        ) THEN
          RAISE EXCEPTION 'Publication % durability metadata is immutable in status %',
            OLD."id", OLD."status";
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_zone_publication_durability_metadata_immutable"
      BEFORE UPDATE ON "zone_publication"
      FOR EACH ROW EXECUTE FUNCTION enforce_zone_publication_durability_metadata_immutable()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_zone_publication_durability_metadata_immutable"
      ON "zone_publication"
    `);
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS enforce_zone_publication_durability_metadata_immutable',
    );
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_zone_publication_aggregate_immutable"
      ON "zone_publication_aggregate"
    `);
    await queryRunner.query(
      'DROP TABLE IF EXISTS "zone_publication_aggregate"',
    );
    await queryRunner.query(`
      ALTER TABLE "zone_publication_state"
      DROP COLUMN IF EXISTS "automaticPublishingPausedAt",
      DROP COLUMN IF EXISTS "automaticPublishingPaused",
      DROP COLUMN IF EXISTS "candidateRequestedAt"
    `);
    await queryRunner.query(`
      ALTER TABLE "zone_publication_instance"
      DROP COLUMN IF EXISTS "contentFingerprint"
    `);
    await queryRunner.query(`
      ALTER TABLE "zone_publication"
      DROP COLUMN IF EXISTS "validationReport",
      DROP COLUMN IF EXISTS "contentFingerprint",
      DROP COLUMN IF EXISTS "departmentCount"
    `);
  }
}
