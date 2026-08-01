import { MigrationInterface, QueryRunner } from 'typeorm';

export class SandreDisabledZoneReferenceGuard1785859200000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION resolve_active_sandre_zone_alias(
        source_zone_id integer
      ) RETURNS integer AS $$
      DECLARE
        target_zone_id integer;
      BEGIN
        SELECT target.id
        INTO target_zone_id
        FROM zone_alerte source
        JOIN sandre_zone_alias alias
          ON alias."departementId" = source."departementId"
          AND alias."zoneType" = source.type
          AND alias."aliasType" = 'cd_zas'
          AND alias."aliasValue" = source."codeSandre"
        JOIN zone_alerte target
          ON target.id = alias."zoneAlerteId"
        WHERE source.id = source_zone_id
          AND source."codeSandre" IS NOT NULL
          AND target.id <> source.id
          AND target.disabled = false
          AND target."departementId" = source."departementId"
          AND target.type = source.type
        FOR SHARE OF source, alias, target;

        RETURN target_zone_id;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION remap_sandre_references_before_parent_reactivation()
      RETURNS trigger AS $$
      DECLARE
        unresolved_zone_id integer;
      BEGIN
        IF OLD.statut IS DISTINCT FROM 'abroge' OR NEW.statut = 'abroge' THEN
          RETURN NEW;
        END IF;

        CASE TG_TABLE_NAME
          WHEN 'arrete_restriction' THEN
            PERFORM source.id
            FROM restriction reference
            JOIN zone_alerte source ON source.id = reference."zoneAlerteId"
            WHERE reference."arreteRestrictionId" = NEW.id
              AND source.disabled = true
            FOR SHARE OF source;

            SELECT source.id
            INTO unresolved_zone_id
            FROM restriction reference
            JOIN zone_alerte source ON source.id = reference."zoneAlerteId"
            WHERE reference."arreteRestrictionId" = NEW.id
              AND source.disabled = true
              AND resolve_active_sandre_zone_alias(source.id) IS NULL
            LIMIT 1;
            IF unresolved_zone_id IS NOT NULL THEN
              RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = format(
                  'Impossible de réactiver l''arrêté de restriction %s : zone désactivée %s sans alias SANDRE actif',
                  NEW.id,
                  unresolved_zone_id
                );
            END IF;

            IF EXISTS (
              SELECT 1
              FROM restriction source_reference
              JOIN zone_alerte source
                ON source.id = source_reference."zoneAlerteId"
               AND source.disabled = true
              JOIN restriction target_reference
                ON target_reference."arreteRestrictionId" = NEW.id
               AND target_reference."zoneAlerteId" =
                   resolve_active_sandre_zone_alias(source.id)
              WHERE source_reference."arreteRestrictionId" = NEW.id
            ) THEN
              RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = format(
                  'Impossible de réactiver l''arrêté de restriction %s : collision de restrictions SANDRE',
                  NEW.id
                );
            END IF;

            UPDATE restriction reference
            SET "zoneAlerteId" = resolve_active_sandre_zone_alias(source.id)
            FROM zone_alerte source
            WHERE reference."arreteRestrictionId" = NEW.id
              AND source.id = reference."zoneAlerteId"
              AND source.disabled = true;

          WHEN 'arrete_cadre' THEN
            PERFORM source.id
            FROM arrete_cadre_zone_alerte reference
            JOIN zone_alerte source ON source.id = reference."zoneAlerteId"
            WHERE reference."arreteCadreId" = NEW.id
              AND source.disabled = true
            FOR SHARE OF source;
            PERFORM source.id
            FROM arrete_cadre_zone_alerte_communes reference
            JOIN zone_alerte source ON source.id = reference."zoneAlerteId"
            WHERE reference."arreteCadreId" = NEW.id
              AND source.disabled = true
            FOR SHARE OF source;

            SELECT invalid_reference."zoneAlerteId"
            INTO unresolved_zone_id
            FROM (
              SELECT reference."zoneAlerteId"
              FROM arrete_cadre_zone_alerte reference
              JOIN zone_alerte source ON source.id = reference."zoneAlerteId"
              WHERE reference."arreteCadreId" = NEW.id
                AND source.disabled = true
              UNION ALL
              SELECT reference."zoneAlerteId"
              FROM arrete_cadre_zone_alerte_communes reference
              JOIN zone_alerte source ON source.id = reference."zoneAlerteId"
              WHERE reference."arreteCadreId" = NEW.id
                AND source.disabled = true
            ) invalid_reference
            WHERE resolve_active_sandre_zone_alias(
              invalid_reference."zoneAlerteId"
            ) IS NULL
            LIMIT 1;
            IF unresolved_zone_id IS NOT NULL THEN
              RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = format(
                  'Impossible de réactiver l''arrêté cadre %s : zone désactivée %s sans alias SANDRE actif',
                  NEW.id,
                  unresolved_zone_id
                );
            END IF;

            IF EXISTS (
              SELECT 1
              FROM arrete_cadre_zone_alerte_communes source_reference
              JOIN zone_alerte source
                ON source.id = source_reference."zoneAlerteId"
               AND source.disabled = true
              JOIN arrete_cadre_zone_alerte_communes target_reference
                ON target_reference."arreteCadreId" = NEW.id
               AND target_reference."zoneAlerteId" =
                   resolve_active_sandre_zone_alias(source.id)
              WHERE source_reference."arreteCadreId" = NEW.id
            ) THEN
              RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = format(
                  'Impossible de réactiver l''arrêté cadre %s : collision de personnalisations SANDRE',
                  NEW.id
                );
            END IF;

            INSERT INTO arrete_cadre_zone_alerte (
              "arreteCadreId",
              "zoneAlerteId"
            )
            SELECT
              NEW.id,
              resolve_active_sandre_zone_alias(source.id)
            FROM arrete_cadre_zone_alerte reference
            JOIN zone_alerte source ON source.id = reference."zoneAlerteId"
            WHERE reference."arreteCadreId" = NEW.id
              AND source.disabled = true
            ON CONFLICT DO NOTHING;

            DELETE FROM arrete_cadre_zone_alerte reference
            USING zone_alerte source
            WHERE reference."arreteCadreId" = NEW.id
              AND source.id = reference."zoneAlerteId"
              AND source.disabled = true;

            UPDATE arrete_cadre_zone_alerte_communes reference
            SET "zoneAlerteId" = resolve_active_sandre_zone_alias(source.id)
            FROM zone_alerte source
            WHERE reference."arreteCadreId" = NEW.id
              AND source.id = reference."zoneAlerteId"
              AND source.disabled = true;

          ELSE
            RAISE EXCEPTION 'Unsupported SANDRE parent table: %', TG_TABLE_NAME;
        END CASE;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION guard_disabled_sandre_zone_reference()
      RETURNS trigger AS $$
      DECLARE
        source_disabled boolean;
        target_zone_id integer;
        reference_is_operational boolean;
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF NEW."zoneAlerteId" IS NOT DISTINCT FROM OLD."zoneAlerteId" THEN
            RETURN NEW;
          END IF;
        END IF;

        CASE TG_TABLE_NAME
          WHEN 'restriction' THEN
            SELECT parent.statut <> 'abroge'
            INTO reference_is_operational
            FROM arrete_restriction parent
            WHERE parent.id = NEW."arreteRestrictionId"
            FOR SHARE OF parent;
          WHEN 'arrete_cadre_zone_alerte' THEN
            SELECT parent.statut <> 'abroge'
            INTO reference_is_operational
            FROM arrete_cadre parent
            WHERE parent.id = NEW."arreteCadreId"
            FOR SHARE OF parent;
          WHEN 'arrete_cadre_zone_alerte_communes' THEN
            SELECT parent.statut <> 'abroge'
            INTO reference_is_operational
            FROM arrete_cadre parent
            WHERE parent.id = NEW."arreteCadreId"
            FOR SHARE OF parent;
          ELSE
            RAISE EXCEPTION 'Unsupported SANDRE reference table: %', TG_TABLE_NAME;
        END CASE;

        -- Historical links remain attached to the zone that was in force.
        IF reference_is_operational IS DISTINCT FROM true THEN
          RETURN NEW;
        END IF;

        SELECT disabled
        INTO source_disabled
        FROM zone_alerte
        WHERE id = NEW."zoneAlerteId"
        FOR SHARE;

        -- The foreign key remains responsible for unknown zone identifiers.
        IF NOT FOUND OR source_disabled = false THEN
          RETURN NEW;
        END IF;

        target_zone_id := resolve_active_sandre_zone_alias(
          NEW."zoneAlerteId"
        );
        IF target_zone_id IS NULL THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = format(
              'Zone d''alerte %s désactivée sans alias SANDRE actif univoque',
              NEW."zoneAlerteId"
            );
        END IF;

        NEW."zoneAlerteId" := target_zone_id;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION remap_references_before_sandre_zone_disable()
      RETURNS trigger AS $$
      DECLARE
        target_zone_id integer;
        has_references boolean;
      BEGIN
        IF NEW.disabled IS DISTINCT FROM true OR OLD.disabled = true THEN
          RETURN NEW;
        END IF;

        SELECT
          EXISTS (
            SELECT 1
            FROM arrete_cadre_zone_alerte link
            JOIN arrete_cadre parent ON parent.id = link."arreteCadreId"
            WHERE link."zoneAlerteId" = OLD.id
              AND parent.statut <> 'abroge'
          )
          OR EXISTS (
            SELECT 1
            FROM restriction reference
            JOIN arrete_restriction parent
              ON parent.id = reference."arreteRestrictionId"
            WHERE reference."zoneAlerteId" = OLD.id
              AND parent.statut <> 'abroge'
          )
          OR EXISTS (
            SELECT 1
            FROM arrete_cadre_zone_alerte_communes reference
            JOIN arrete_cadre parent
              ON parent.id = reference."arreteCadreId"
            WHERE reference."zoneAlerteId" = OLD.id
              AND parent.statut <> 'abroge'
          )
        INTO has_references;

        IF NOT has_references THEN
          RETURN NEW;
        END IF;

        target_zone_id := resolve_active_sandre_zone_alias(OLD.id);
        IF target_zone_id IS NULL THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = format(
              'Impossible de désactiver la zone d''alerte %s : références actives sans alias SANDRE résolu',
              OLD.id
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
          WHERE source."zoneAlerteId" = OLD.id
            AND parent.statut <> 'abroge'
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = format(
              'Impossible de remapper la zone d''alerte %s : collision de restrictions avec la zone %s',
              OLD.id,
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
          WHERE source."zoneAlerteId" = OLD.id
            AND parent.statut <> 'abroge'
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = format(
              'Impossible de remapper la zone d''alerte %s : collision de personnalisations avec la zone %s',
              OLD.id,
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
        WHERE link."zoneAlerteId" = OLD.id
          AND parent.statut <> 'abroge'
        ON CONFLICT DO NOTHING;

        DELETE FROM arrete_cadre_zone_alerte link
        USING arrete_cadre parent
        WHERE link."arreteCadreId" = parent.id
          AND link."zoneAlerteId" = OLD.id
          AND parent.statut <> 'abroge';

        UPDATE restriction reference
        SET "zoneAlerteId" = target_zone_id
        FROM arrete_restriction parent
        WHERE reference."arreteRestrictionId" = parent.id
          AND reference."zoneAlerteId" = OLD.id
          AND parent.statut <> 'abroge';

        UPDATE arrete_cadre_zone_alerte_communes reference
        SET "zoneAlerteId" = target_zone_id
        FROM arrete_cadre parent
        WHERE reference."arreteCadreId" = parent.id
          AND reference."zoneAlerteId" = OLD.id
          AND parent.statut <> 'abroge';

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    for (const table of [
      'restriction',
      'arrete_cadre_zone_alerte',
      'arrete_cadre_zone_alerte_communes',
    ]) {
      await queryRunner.query(`
        DROP TRIGGER IF EXISTS "TRG_${table}_active_sandre_zone" ON "${table}";
        CREATE TRIGGER "TRG_${table}_active_sandre_zone"
        BEFORE INSERT OR UPDATE OF "zoneAlerteId" ON "${table}"
        FOR EACH ROW
        EXECUTE FUNCTION guard_disabled_sandre_zone_reference();
      `);
    }

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_zone_alerte_remap_references_before_disable"
      ON "zone_alerte";
      CREATE TRIGGER "TRG_zone_alerte_remap_references_before_disable"
      BEFORE UPDATE OF disabled ON "zone_alerte"
      FOR EACH ROW
      EXECUTE FUNCTION remap_references_before_sandre_zone_disable();
    `);
    for (const table of ['arrete_restriction', 'arrete_cadre']) {
      await queryRunner.query(`
        DROP TRIGGER IF EXISTS "TRG_${table}_remap_sandre_before_reactivation"
        ON "${table}";
        CREATE TRIGGER "TRG_${table}_remap_sandre_before_reactivation"
        AFTER UPDATE OF statut ON "${table}"
        FOR EACH ROW
        EXECUTE FUNCTION remap_sandre_references_before_parent_reactivation();
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['arrete_cadre', 'arrete_restriction']) {
      await queryRunner.query(`
        DROP TRIGGER IF EXISTS "TRG_${table}_remap_sandre_before_reactivation"
        ON "${table}"
      `);
    }
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_zone_alerte_remap_references_before_disable"
      ON "zone_alerte"
    `);
    for (const table of [
      'arrete_cadre_zone_alerte_communes',
      'arrete_cadre_zone_alerte',
      'restriction',
    ]) {
      await queryRunner.query(`
        DROP TRIGGER IF EXISTS "TRG_${table}_active_sandre_zone" ON "${table}"
      `);
    }
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS remap_references_before_sandre_zone_disable()',
    );
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS guard_disabled_sandre_zone_reference()',
    );
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS remap_sandre_references_before_parent_reactivation()',
    );
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS resolve_active_sandre_zone_alias(integer)',
    );
  }
}
