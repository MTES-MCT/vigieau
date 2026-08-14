import { MigrationInterface, QueryRunner } from 'typeorm';

const CONSTRAINT_NAME = 'UQ_ac_za_communes_arrete_cadre_zone';

export class SandreCustomizationUniqueness1786125600000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const [duplicateState] = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1
        FROM arrete_cadre_zone_alerte_communes
        GROUP BY "arreteCadreId", "zoneAlerteId"
        HAVING count(*) > 1
      ) AS "hasDuplicates"
    `);
    if (duplicateState?.hasDuplicates === true) {
      throw new Error(
        'Cannot enforce SANDRE customization uniqueness while duplicate (arreteCadreId, zoneAlerteId) rows exist; reconcile them before retrying the migration',
      );
    }

    const [constraintState] = await queryRunner.query(`
      SELECT
        EXISTS (
          SELECT 1
          FROM pg_constraint constraint_definition
          WHERE constraint_definition.conrelid =
              '"arrete_cadre_zone_alerte_communes"'::regclass
            AND constraint_definition.conname = '${CONSTRAINT_NAME}'
        ) AS "constraintExists",
        EXISTS (
          SELECT 1
          FROM pg_constraint constraint_definition
          WHERE constraint_definition.conrelid =
              '"arrete_cadre_zone_alerte_communes"'::regclass
            AND constraint_definition.conname = '${CONSTRAINT_NAME}'
            AND constraint_definition.contype = 'u'
            AND ARRAY(
              SELECT attribute.attname::text
              FROM unnest(constraint_definition.conkey) WITH ORDINALITY
                AS key_column(attnum, position)
              JOIN pg_attribute attribute
                ON attribute.attrelid = constraint_definition.conrelid
                AND attribute.attnum = key_column.attnum
              ORDER BY key_column.position
            ) = ARRAY['arreteCadreId', 'zoneAlerteId']::text[]
        ) AS "constraintMatches"
    `);
    if (constraintState?.constraintExists === true) {
      if (constraintState.constraintMatches !== true) {
        throw new Error(
          `Constraint ${CONSTRAINT_NAME} already exists with an incompatible definition`,
        );
      }
      return;
    }

    await queryRunner.query(`
      ALTER TABLE "arrete_cadre_zone_alerte_communes"
      ADD CONSTRAINT "${CONSTRAINT_NAME}"
      UNIQUE ("arreteCadreId", "zoneAlerteId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "arrete_cadre_zone_alerte_communes"
      DROP CONSTRAINT IF EXISTS "${CONSTRAINT_NAME}"
    `);
  }
}
