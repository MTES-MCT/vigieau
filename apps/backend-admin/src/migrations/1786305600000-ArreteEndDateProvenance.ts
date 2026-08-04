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

    await queryRunner.query(`
      WITH earliest_successor AS (
        SELECT
          successor."arreteRestrictionAbrogeId" AS predecessor_id,
          MIN(successor."dateDebut") AS successor_start
        FROM "arrete_restriction" successor
        JOIN "arrete_restriction" predecessor
          ON predecessor.id = successor."arreteRestrictionAbrogeId"
        WHERE successor."arreteRestrictionAbrogeId" IS NOT NULL
          AND successor.id <> predecessor.id
          AND successor."statut" <> 'a_valider'
          AND successor."dateDebut" IS NOT NULL
          AND predecessor."dateDebut" IS NOT NULL
          AND successor."dateDebut" > predecessor."dateDebut"
        GROUP BY successor."arreteRestrictionAbrogeId"
      ), potentially_computed AS (
        SELECT predecessor.id
        FROM "arrete_restriction" predecessor
        JOIN earliest_successor successor
          ON successor.predecessor_id = predecessor.id
        WHERE predecessor."dateFin" = successor.successor_start - 1
          AND predecessor."statut" <> 'a_valider'
      ), framework_limited AS (
        SELECT restriction_order.id
        FROM "arrete_restriction" restriction_order
        JOIN "arrete_cadre_arrete_restriction" link
          ON link."arreteRestrictionId" = restriction_order.id
        JOIN "arrete_cadre" framework_order
          ON framework_order.id = link."arreteCadreId"
        WHERE framework_order."dateFin" IS NOT NULL
          AND framework_order."statut" <> 'a_valider'
          AND restriction_order."statut" <> 'a_valider'
        GROUP BY restriction_order.id, restriction_order."dateFin"
        HAVING restriction_order."dateFin" = MIN(framework_order."dateFin")
      )
      UPDATE "arrete_restriction" restriction_order
      SET
        "dateFinCalculee" = true,
        "dateFinSaisieConnue" = false,
        "dateFinSaisie" = restriction_order."dateFin"
      WHERE restriction_order.id IN (
        SELECT id FROM potentially_computed
        UNION
        SELECT id FROM framework_limited
      )
    `);

    await queryRunner.query(`
      WITH earliest_successor AS (
        SELECT
          successor."arreteCadreAbrogeId" AS predecessor_id,
          MIN(successor."dateDebut") AS successor_start
        FROM "arrete_cadre" successor
        JOIN "arrete_cadre" predecessor
          ON predecessor.id = successor."arreteCadreAbrogeId"
        WHERE successor."arreteCadreAbrogeId" IS NOT NULL
          AND successor.id <> predecessor.id
          AND successor."statut" <> 'a_valider'
          AND successor."dateDebut" IS NOT NULL
          AND predecessor."dateDebut" IS NOT NULL
          AND successor."dateDebut" > predecessor."dateDebut"
        GROUP BY successor."arreteCadreAbrogeId"
      )
      UPDATE "arrete_cadre" predecessor
      SET
        "dateFinCalculee" = true,
        "dateFinSaisieConnue" = false,
        "dateFinSaisie" = predecessor."dateFin"
      FROM earliest_successor successor
      WHERE predecessor.id = successor.predecessor_id
        AND predecessor."dateFin" = successor.successor_start - 1
        AND predecessor."statut" <> 'a_valider'
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
