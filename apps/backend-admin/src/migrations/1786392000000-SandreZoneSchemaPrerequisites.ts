import { MigrationInterface, QueryRunner } from 'typeorm';

export class SandreZoneSchemaPrerequisites1786392000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "zone_alerte"
        ADD COLUMN IF NOT EXISTS "idSandre" integer,
        ADD COLUMN IF NOT EXISTS "codeSandre" character varying(32),
        ADD COLUMN IF NOT EXISTS "statutSandre" character varying(20),
        ADD COLUMN IF NOT EXISTS "dateMajSandre" date,
        ADD COLUMN IF NOT EXISTS "numeroVersionSandre" integer,
        ADD COLUMN IF NOT EXISTS "codesAlternatifs" jsonb,
        ADD COLUMN IF NOT EXISTS "sandrePayloadHash" character varying(64)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_zone_alerte_code_sandre_unique"
      ON "zone_alerte" ("codeSandre")
      WHERE "codeSandre" IS NOT NULL
    `);
  }

  public down(): Promise<void> {
    // These columns may predate TypeORM migrations, so rollback must preserve them.
    return Promise.resolve();
  }
}
