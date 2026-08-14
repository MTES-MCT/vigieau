import { MigrationInterface, QueryRunner } from 'typeorm';

const ORPHANED_SNAPSHOT_ERROR =
  'Zone publication ended before statistic activation';

export class ReconcileTerminalPublicationSnapshots1786219300000 implements MigrationInterface {
  name = 'ReconcileTerminalPublicationSnapshots1786219300000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `
        CREATE OR REPLACE FUNCTION invalidate_terminal_zone_publication_snapshot()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NEW."status" NOT IN ('failed', 'superseded') THEN
            RETURN NEW;
          END IF;

          IF TG_OP = 'UPDATE' AND OLD."status" IS NOT DISTINCT FROM NEW."status" THEN
            RETURN NEW;
          END IF;

          UPDATE "statistic_commune_snapshot" snapshot
          SET "status" = 'failed',
              "completedAt" = NULL,
              "lastError" = '${ORPHANED_SNAPSHOT_ERROR}',
              "updatedAt" = now()
          WHERE snapshot."snapshotDate" =
                (NEW."sourceComputedAt" AT TIME ZONE 'UTC')::date
            AND snapshot."scope" = 'national'
            AND snapshot."status" = 'ready'
            AND snapshot."sourceRevision" = NEW."sourceRevision"
            AND NOT EXISTS (
              SELECT 1
              FROM "zone_publication" usable_publication
              WHERE usable_publication."id" <> NEW."id"
                AND usable_publication."status" IN (
                  'validated', 'candidate', 'active'
                )
                AND usable_publication."sourceRevision" = NEW."sourceRevision"
                AND (
                  usable_publication."sourceComputedAt" AT TIME ZONE 'UTC'
                )::date =
                  (NEW."sourceComputedAt" AT TIME ZONE 'UTC')::date
            );

          RETURN NEW;
        END;
        $$
      `,
    );
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_zone_publication_invalidate_terminal_snapshot"
      ON "zone_publication";

      CREATE TRIGGER "TRG_zone_publication_invalidate_terminal_snapshot"
      AFTER INSERT OR UPDATE OF "status" ON "zone_publication"
      FOR EACH ROW
      EXECUTE FUNCTION invalidate_terminal_zone_publication_snapshot()
    `);
    await queryRunner.query(
      `
        UPDATE "statistic_commune_snapshot" snapshot
        SET "status" = 'failed',
            "completedAt" = NULL,
            "lastError" = $1,
            "updatedAt" = now()
        WHERE snapshot."scope" = 'national'
          AND snapshot."status" = 'ready'
          AND snapshot."sourceRevision" IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM "zone_publication" terminal_publication
            WHERE terminal_publication."status" IN ('failed', 'superseded')
              AND terminal_publication."sourceRevision" =
                  snapshot."sourceRevision"
              AND (
                terminal_publication."sourceComputedAt" AT TIME ZONE 'UTC'
              )::date = snapshot."snapshotDate"
          )
          AND NOT EXISTS (
            SELECT 1
            FROM "zone_publication" usable_publication
            WHERE usable_publication."status" IN (
              'validated', 'candidate', 'active'
            )
              AND usable_publication."sourceRevision" =
                  snapshot."sourceRevision"
              AND (
                usable_publication."sourceComputedAt" AT TIME ZONE 'UTC'
              )::date = snapshot."snapshotDate"
          )
      `,
      [ORPHANED_SNAPSHOT_ERROR],
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_zone_publication_invalidate_terminal_snapshot"
      ON "zone_publication"
    `);
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS invalidate_terminal_zone_publication_snapshot()',
    );
    await queryRunner.query(
      `
        UPDATE "statistic_commune_snapshot"
        SET "status" = 'ready',
            "lastError" = NULL,
            "updatedAt" = now()
        WHERE "scope" = 'national'
          AND "status" = 'failed'
          AND "lastError" = $1
      `,
      [ORPHANED_SNAPSHOT_ERROR],
    );
  }
}
