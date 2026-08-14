import { MigrationInterface, QueryRunner } from 'typeorm';

export class SandreOperationalReferenceRepair1786118400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION remap_operational_sandre_zone_references(
        source_zone_id integer,
        expected_target_zone_id integer DEFAULT NULL
      ) RETURNS integer AS $$
      DECLARE
        target_zone_id integer;
        remaining_reference boolean;
      BEGIN
        PERFORM parent.id
        FROM arrete_cadre parent
        WHERE parent.statut IN ('a_venir', 'publie')
          AND parent.id IN (
          SELECT reference."arreteCadreId"
          FROM arrete_cadre_zone_alerte reference
          WHERE reference."zoneAlerteId" = source_zone_id
          UNION
          SELECT reference."arreteCadreId"
          FROM arrete_cadre_zone_alerte_communes reference
          WHERE reference."zoneAlerteId" = source_zone_id
        )
        ORDER BY parent.id
        FOR SHARE OF parent;

        PERFORM parent.id
        FROM arrete_restriction parent
        WHERE parent.statut IN ('a_venir', 'publie')
          AND parent.id IN (
          SELECT reference."arreteRestrictionId"
          FROM restriction reference
          WHERE reference."zoneAlerteId" = source_zone_id
        )
        ORDER BY parent.id
        FOR SHARE OF parent;

        target_zone_id := resolve_active_sandre_zone_alias(source_zone_id);
        IF target_zone_id IS NULL THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = format(
              'Impossible de remapper la zone d''alerte %s : alias SANDRE actif absent ou ambigu',
              source_zone_id
            );
        END IF;

        IF expected_target_zone_id IS NOT NULL
          AND target_zone_id <> expected_target_zone_id THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = format(
              'Impossible de remapper la zone d''alerte %s : cible SANDRE %s différente de la cible attendue %s',
              source_zone_id,
              target_zone_id,
              expected_target_zone_id
            );
        END IF;

        IF EXISTS (
          SELECT 1
          FROM restriction source
          JOIN arrete_restriction parent
            ON parent.id = source."arreteRestrictionId"
          JOIN restriction target
            ON target."arreteRestrictionId" = source."arreteRestrictionId"
            AND target."zoneAlerteId" = target_zone_id
          WHERE source."zoneAlerteId" = source_zone_id
            AND parent.statut IN ('a_venir', 'publie')
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = format(
              'Impossible de remapper la zone d''alerte %s : collision de restrictions avec la zone %s',
              source_zone_id,
              target_zone_id
            );
        END IF;

        IF EXISTS (
          SELECT 1
          FROM arrete_cadre_zone_alerte_communes source
          JOIN arrete_cadre parent
            ON parent.id = source."arreteCadreId"
          JOIN arrete_cadre_zone_alerte_communes target
            ON target."arreteCadreId" = source."arreteCadreId"
            AND target."zoneAlerteId" = target_zone_id
          WHERE source."zoneAlerteId" = source_zone_id
            AND parent.statut IN ('a_venir', 'publie')
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = format(
              'Impossible de remapper la zone d''alerte %s : collision de personnalisations avec la zone %s',
              source_zone_id,
              target_zone_id
            );
        END IF;

        INSERT INTO arrete_cadre_zone_alerte (
          "arreteCadreId",
          "zoneAlerteId"
        )
        SELECT link."arreteCadreId", target_zone_id
        FROM arrete_cadre_zone_alerte link
        JOIN arrete_cadre parent ON parent.id = link."arreteCadreId"
        WHERE link."zoneAlerteId" = source_zone_id
          AND parent.statut IN ('a_venir', 'publie')
        ON CONFLICT DO NOTHING;

        DELETE FROM arrete_cadre_zone_alerte link
        USING arrete_cadre parent
        WHERE link."arreteCadreId" = parent.id
          AND link."zoneAlerteId" = source_zone_id
          AND parent.statut IN ('a_venir', 'publie');

        UPDATE restriction reference
        SET "zoneAlerteId" = target_zone_id
        FROM arrete_restriction parent
        WHERE reference."arreteRestrictionId" = parent.id
          AND reference."zoneAlerteId" = source_zone_id
          AND parent.statut IN ('a_venir', 'publie');

        UPDATE arrete_cadre_zone_alerte_communes reference
        SET "zoneAlerteId" = target_zone_id
        FROM arrete_cadre parent
        WHERE reference."arreteCadreId" = parent.id
          AND reference."zoneAlerteId" = source_zone_id
          AND parent.statut IN ('a_venir', 'publie');

        UPDATE sandre_zone_alias alias
        SET "zoneAlerteId" = target_zone_id
        FROM zone_alerte source
        WHERE source.id = source_zone_id
          AND alias."zoneAlerteId" = source.id
          AND alias."departementId" = source."departementId"
          AND alias."zoneType" = source.type;

        SELECT
          EXISTS (
            SELECT 1
            FROM arrete_cadre_zone_alerte reference
            JOIN arrete_cadre parent ON parent.id = reference."arreteCadreId"
            WHERE reference."zoneAlerteId" = source_zone_id
              AND parent.statut IN ('a_venir', 'publie')
          )
          OR EXISTS (
            SELECT 1
            FROM restriction reference
            JOIN arrete_restriction parent
              ON parent.id = reference."arreteRestrictionId"
            WHERE reference."zoneAlerteId" = source_zone_id
              AND parent.statut IN ('a_venir', 'publie')
          )
          OR EXISTS (
            SELECT 1
            FROM arrete_cadre_zone_alerte_communes reference
            JOIN arrete_cadre parent ON parent.id = reference."arreteCadreId"
            WHERE reference."zoneAlerteId" = source_zone_id
              AND parent.statut IN ('a_venir', 'publie')
          )
        INTO remaining_reference;

        IF remaining_reference THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = format(
              'La zone d''alerte %s conserve des références opérationnelles après remappage',
              source_zone_id
            );
        END IF;

        RETURN target_zone_id;
      END;
      $$ LANGUAGE plpgsql;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS remap_operational_sandre_zone_references(integer, integer)',
    );
  }
}
