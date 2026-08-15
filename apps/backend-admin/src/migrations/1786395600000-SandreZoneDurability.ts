import { MigrationInterface, QueryRunner } from 'typeorm';

export class SandreZoneDurability1786395600000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "zone_alerte"
        ADD COLUMN IF NOT EXISTS "sandreProvenance"
          character varying(30) NOT NULL DEFAULT 'legacy_unverified'
    `);
    await queryRunner.query(`
      UPDATE "zone_alerte"
      SET "sandreProvenance" = 'official'
      WHERE "codeSandre" IS NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "zone_alerte"
        DROP CONSTRAINT IF EXISTS "CHK_zone_alerte_sandre_provenance",
        ADD CONSTRAINT "CHK_zone_alerte_sandre_provenance"
          CHECK (
            "sandreProvenance" IN (
              'official',
              'legacy_unverified',
              'local_preserved'
            )
            AND (
              "sandreProvenance" <> 'local_preserved'
              OR (
                "idSandre" IS NULL
                AND "codeSandre" IS NULL
                AND "statutSandre" IS NULL
                AND "dateMajSandre" IS NULL
                AND "numeroVersionSandre" IS NULL
                AND (
                  "codesAlternatifs" IS NULL
                  OR "codesAlternatifs" = '[]'::jsonb
                )
                AND "sandrePayloadHash" IS NULL
              )
            )
          )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sandre_basin_mapping" (
        "officialBasinCode" integer NOT NULL,
        "officialName" character varying(100) NOT NULL,
        "localBasinCode" integer NOT NULL,
        source character varying(50) NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sandre_basin_mapping" PRIMARY KEY ("officialBasinCode"),
        CONSTRAINT "CHK_sandre_basin_mapping_codes"
          CHECK ("officialBasinCode" > 0 AND "localBasinCode" > 0)
      )
    `);
    await queryRunner.query(`
      INSERT INTO "sandre_basin_mapping" (
        "officialBasinCode",
        "officialName",
        "localBasinCode",
        source
      ) VALUES (12, 'CORSE', 6, 'audited_official_to_local')
      ON CONFLICT ("officialBasinCode") DO UPDATE
      SET
        "officialName" = EXCLUDED."officialName",
        "localBasinCode" = EXCLUDED."localBasinCode",
        source = EXCLUDED.source
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "sandre_basin_mapping"');
    await queryRunner.query(`
      ALTER TABLE "zone_alerte"
        DROP CONSTRAINT IF EXISTS "CHK_zone_alerte_sandre_provenance",
        DROP COLUMN IF EXISTS "sandreProvenance"
    `);
  }
}
