import { MigrationInterface, QueryRunner } from 'typeorm';

export class SandreZoneSync1785484800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "zone_alerte"
        ADD COLUMN IF NOT EXISTS "codeSandre" character varying(32),
        ADD COLUMN IF NOT EXISTS "statutSandre" character varying(20),
        ADD COLUMN IF NOT EXISTS "dateMajSandre" date,
        ADD COLUMN IF NOT EXISTS "codesAlternatifs" jsonb,
        ADD COLUMN IF NOT EXISTS "sandrePayloadHash" character varying(64)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_zone_alerte_code_sandre_unique"
      ON "zone_alerte" ("codeSandre")
      WHERE "codeSandre" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sandre_zone_alias" (
        "id" SERIAL NOT NULL,
        "zoneType" character varying(50) NOT NULL,
        "aliasType" character varying(30) NOT NULL,
        "aliasValue" character varying(64) NOT NULL,
        "source" character varying(30) NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "departementId" integer NOT NULL,
        "zoneAlerteId" integer NOT NULL,
        CONSTRAINT "PK_sandre_zone_alias" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_sandre_zone_alias_identity"
          UNIQUE ("departementId", "zoneType", "aliasType", "aliasValue"),
        CONSTRAINT "FK_sandre_zone_alias_departement"
          FOREIGN KEY ("departementId") REFERENCES "departement"("id")
          ON DELETE CASCADE,
        CONSTRAINT "FK_sandre_zone_alias_zone"
          FOREIGN KEY ("zoneAlerteId") REFERENCES "zone_alerte"("id")
          ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sandre_zone_alias_departement"
      ON "sandre_zone_alias" ("departementId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sandre_zone_alias_zone"
      ON "sandre_zone_alias" ("zoneAlerteId")
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sandre_zone_sync_state" (
        "id" SERIAL NOT NULL,
        "sourceUpdatedAt" date,
        "snapshotHash" character varying(64),
        "latestFeaturesHash" character varying(64),
        "snapshotStartedAt" TIMESTAMP WITH TIME ZONE,
        "lastFullSyncAt" TIMESTAMP WITH TIME ZONE,
        "lastSuccessAt" TIMESTAMP WITH TIME ZONE,
        "featureCount" integer NOT NULL DEFAULT 0,
        "needsRecompute" boolean NOT NULL DEFAULT false,
        "recomputeRevision" integer NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "departementId" integer NOT NULL,
        CONSTRAINT "PK_sandre_zone_sync_state" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_sandre_zone_sync_state_departement"
          UNIQUE ("departementId"),
        CONSTRAINT "FK_sandre_zone_sync_state_departement"
          FOREIGN KEY ("departementId") REFERENCES "departement"("id")
          ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "sandre_zone_sync_state"
        ADD COLUMN IF NOT EXISTS "snapshotStartedAt" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "latestFeaturesHash" character varying(64),
        ADD COLUMN IF NOT EXISTS "needsRecompute" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "recomputeRevision" integer NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "sandre_zone_sync_state"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sandre_zone_alias"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_zone_alerte_code_sandre_unique"`,
    );
    await queryRunner.query(`
      ALTER TABLE "zone_alerte"
        DROP COLUMN IF EXISTS "sandrePayloadHash",
        DROP COLUMN IF EXISTS "codesAlternatifs",
        DROP COLUMN IF EXISTS "dateMajSandre",
        DROP COLUMN IF EXISTS "statutSandre",
        DROP COLUMN IF EXISTS "codeSandre"
    `);
  }
}
