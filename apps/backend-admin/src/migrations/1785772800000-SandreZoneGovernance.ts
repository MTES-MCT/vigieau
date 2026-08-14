import { MigrationInterface, QueryRunner } from 'typeorm';

export class SandreZoneGovernance1785772800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sandre_zone_sync_state"
        ADD COLUMN IF NOT EXISTS "observedSourceUpdatedAt" date,
        ADD COLUMN IF NOT EXISTS "observedSnapshotHash" character varying(64),
        ADD COLUMN IF NOT EXISTS "observedLatestFeaturesHash" character varying(64),
        ADD COLUMN IF NOT EXISTS "observedFeatureCount" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "lastObservedAt" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "appliedSourceUpdatedAt" date,
        ADD COLUMN IF NOT EXISTS "appliedSnapshotHash" character varying(64),
        ADD COLUMN IF NOT EXISTS "appliedFeatureCount" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "lastAppliedAt" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "blockedAt" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "blockedReason" text,
        ADD COLUMN IF NOT EXISTS "blockedSnapshotHash" character varying(64)
    `);
    await queryRunner.query(`
      UPDATE "sandre_zone_sync_state"
      SET
        "observedSourceUpdatedAt" = COALESCE("observedSourceUpdatedAt", "sourceUpdatedAt"),
        "observedSnapshotHash" = COALESCE("observedSnapshotHash", "snapshotHash"),
        "observedLatestFeaturesHash" = COALESCE("observedLatestFeaturesHash", "latestFeaturesHash"),
        "observedFeatureCount" = CASE
          WHEN "observedSnapshotHash" IS NULL THEN "featureCount"
          ELSE "observedFeatureCount"
        END,
        "lastObservedAt" = COALESCE("lastObservedAt", "lastFullSyncAt", "lastSuccessAt"),
        "appliedSourceUpdatedAt" = COALESCE("appliedSourceUpdatedAt", "sourceUpdatedAt"),
        "appliedSnapshotHash" = COALESCE("appliedSnapshotHash", "snapshotHash"),
        "appliedFeatureCount" = CASE
          WHEN "appliedSnapshotHash" IS NULL THEN "featureCount"
          ELSE "appliedFeatureCount"
        END,
        "lastAppliedAt" = COALESCE("lastAppliedAt", "lastSuccessAt", "lastFullSyncAt")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sandre_zone_sync_batch" (
        "id" BIGSERIAL NOT NULL,
        "kind" character varying(30) NOT NULL,
        "mode" character varying(20) NOT NULL,
        "status" character varying(30) NOT NULL,
        "snapshotHash" character varying(64),
        "sourceUpdatedAt" date,
        "featureCount" integer,
        "reportFingerprint" character varying(64),
        "failureReason" text,
        "metadata" jsonb,
        "startedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "finishedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "departementId" integer,
        CONSTRAINT "PK_sandre_zone_sync_batch" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_sandre_zone_sync_batch_kind"
          CHECK ("kind" IN ('snapshot', 'reconciliation')),
        CONSTRAINT "CHK_sandre_zone_sync_batch_mode"
          CHECK ("mode" IN ('audit', 'safe')),
        CONSTRAINT "CHK_sandre_zone_sync_batch_status"
          CHECK ("status" IN ('started', 'observed', 'applied', 'blocked', 'failed')),
        CONSTRAINT "FK_sandre_zone_sync_batch_departement"
          FOREIGN KEY ("departementId") REFERENCES "departement"("id")
          ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sandre_zone_sync_batch_departement"
      ON "sandre_zone_sync_batch" ("departementId", "startedAt" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sandre_zone_sync_batch_status"
      ON "sandre_zone_sync_batch" ("status", "startedAt" DESC)
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sandre_zone_sync_decision" (
        "id" BIGSERIAL NOT NULL,
        "decisionKey" character varying(128) NOT NULL,
        "zoneType" character varying(30) NOT NULL,
        "sourceCode" character varying(64),
        "targetCode" character varying(64),
        "action" character varying(50) NOT NULL,
        "outcome" character varying(30) NOT NULL,
        "reason" character varying(100) NOT NULL,
        "evidence" jsonb,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "batchId" bigint NOT NULL,
        "departementId" integer NOT NULL,
        "zoneAlerteId" integer,
        "candidateZoneAlerteId" integer,
        CONSTRAINT "PK_sandre_zone_sync_decision" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_sandre_zone_sync_decision_key"
          UNIQUE ("batchId", "decisionKey"),
        CONSTRAINT "CHK_sandre_zone_sync_decision_outcome"
          CHECK ("outcome" IN ('observed', 'applied', 'blocked', 'deferred')),
        CONSTRAINT "CHK_sandre_zone_sync_decision_type"
          CHECK ("zoneType" IN ('SOU', 'SUP')),
        CONSTRAINT "FK_sandre_zone_sync_decision_batch"
          FOREIGN KEY ("batchId") REFERENCES "sandre_zone_sync_batch"("id")
          ON DELETE CASCADE,
        CONSTRAINT "FK_sandre_zone_sync_decision_departement"
          FOREIGN KEY ("departementId") REFERENCES "departement"("id")
          ON DELETE CASCADE,
        CONSTRAINT "FK_sandre_zone_sync_decision_zone"
          FOREIGN KEY ("zoneAlerteId") REFERENCES "zone_alerte"("id")
          ON DELETE SET NULL,
        CONSTRAINT "FK_sandre_zone_sync_decision_candidate_zone"
          FOREIGN KEY ("candidateZoneAlerteId") REFERENCES "zone_alerte"("id")
          ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sandre_zone_sync_decision_batch"
      ON "sandre_zone_sync_decision" ("batchId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sandre_zone_sync_decision_departement"
      ON "sandre_zone_sync_decision" ("departementId", "createdAt" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "sandre_zone_sync_decision"');
    await queryRunner.query('DROP TABLE IF EXISTS "sandre_zone_sync_batch"');
    await queryRunner.query(`
      ALTER TABLE "sandre_zone_sync_state"
        DROP COLUMN IF EXISTS "blockedSnapshotHash",
        DROP COLUMN IF EXISTS "blockedReason",
        DROP COLUMN IF EXISTS "blockedAt",
        DROP COLUMN IF EXISTS "lastAppliedAt",
        DROP COLUMN IF EXISTS "appliedFeatureCount",
        DROP COLUMN IF EXISTS "appliedSnapshotHash",
        DROP COLUMN IF EXISTS "appliedSourceUpdatedAt",
        DROP COLUMN IF EXISTS "lastObservedAt",
        DROP COLUMN IF EXISTS "observedFeatureCount",
        DROP COLUMN IF EXISTS "observedLatestFeaturesHash",
        DROP COLUMN IF EXISTS "observedSnapshotHash",
        DROP COLUMN IF EXISTS "observedSourceUpdatedAt"
    `);
  }
}
