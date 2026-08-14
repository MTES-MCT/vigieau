import { MigrationInterface, QueryRunner } from 'typeorm';

export class ArreteEndDateProvenance1786305600000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['arrete_restriction', 'arrete_cadre']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
        ADD COLUMN IF NOT EXISTS "dateFinSaisie" date,
        ADD COLUMN IF NOT EXISTS "dateFinCalculee" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "dateFinSaisieConnue" boolean NOT NULL DEFAULT true
      `);
    }

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_arrete_restriction_replaced_order"
      ON "arrete_restriction" ("arreteRestrictionAbrogeId")
      WHERE "arreteRestrictionAbrogeId" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_arrete_cadre_replaced_order"
      ON "arrete_cadre" ("arreteCadreAbrogeId")
      WHERE "arreteCadreAbrogeId" IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_arrete_cadre_replaced_order"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_arrete_restriction_replaced_order"`,
    );
    for (const table of ['arrete_restriction', 'arrete_cadre']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
        DROP COLUMN IF EXISTS "dateFinSaisieConnue",
        DROP COLUMN IF EXISTS "dateFinCalculee",
        DROP COLUMN IF EXISTS "dateFinSaisie"
      `);
    }
  }
}
