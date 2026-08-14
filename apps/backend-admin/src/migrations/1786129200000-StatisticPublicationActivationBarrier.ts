import { MigrationInterface, QueryRunner } from 'typeorm';

export class StatisticPublicationActivationBarrier1786129200000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "zone_publication_state"
      ADD COLUMN IF NOT EXISTS "automaticPublishingPaused" boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "automaticPublishingPausedAt" TIMESTAMP WITH TIME ZONE
    `);

    await queryRunner.query(`
      ALTER TABLE "statistic_commune_snapshot"
      ADD COLUMN IF NOT EXISTS "sourceRevision" bigint
    `);

    await queryRunner.query(`
      ALTER TABLE "statistic_commune_snapshot"
      DROP CONSTRAINT IF EXISTS "CHK_statistic_commune_snapshot_status"
    `);
    await queryRunner.query(`
      ALTER TABLE "statistic_commune_snapshot"
      ADD CONSTRAINT "CHK_statistic_commune_snapshot_status" CHECK (
        "status" IN ('running', 'ready', 'completed', 'failed', 'partial')
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "statistic_publication_state" (
        "id" integer NOT NULL DEFAULT 1,
        "revision" bigint NOT NULL DEFAULT 0,
        "currentPublishedDate" date,
        "historicPublishedThrough" date,
        "historicDirtyFrom" date,
        "historicDirtyThrough" date,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_statistic_publication_state" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_statistic_publication_state_singleton" CHECK ("id" = 1),
        CONSTRAINT "CHK_statistic_publication_state_dirty_range" CHECK (
          ("historicDirtyFrom" IS NULL AND "historicDirtyThrough" IS NULL)
          OR (
            "historicDirtyFrom" IS NOT NULL
            AND "historicDirtyThrough" IS NOT NULL
            AND "historicDirtyFrom" <= "historicDirtyThrough"
          )
        )
      )
    `);

    await queryRunner.query(`
      WITH publication_seed AS MATERIALIZED (
        SELECT
          seed."id",
          (active."sourceComputedAt" AT TIME ZONE 'UTC')::date AS "activeDate",
          CASE
            WHEN config."computeMapDate" IS NULL
              THEN config."computeStatsDate"
            WHEN config."computeStatsDate" IS NULL
              THEN config."computeMapDate"
            ELSE LEAST(config."computeMapDate", config."computeStatsDate")
          END AS "historicCursor"
        FROM (VALUES (1)) AS seed("id")
        LEFT JOIN "zone_publication_state" publication_state
          ON publication_state."id" = seed."id"
        LEFT JOIN "zone_publication" active
          ON active."id" = publication_state."activePublicationId"
          AND active."status" = 'active'
        LEFT JOIN "config" config
          ON config."id" = seed."id"
      )
      INSERT INTO "statistic_publication_state" (
        "id", "revision", "currentPublishedDate", "historicPublishedThrough",
        "historicDirtyFrom", "historicDirtyThrough", "updatedAt"
      )
      SELECT
        publication_seed."id",
        0,
        publication_seed."activeDate",
        CASE
          WHEN publication_seed."activeDate" IS NULL THEN NULL
          WHEN publication_seed."historicCursor" IS NULL
            THEN NULL
          WHEN publication_seed."historicCursor"
              < publication_seed."activeDate" - 1
            THEN publication_seed."historicCursor" - 1
          ELSE LEAST(
            publication_seed."historicCursor",
            publication_seed."activeDate"
          )
        END,
        CASE
          WHEN publication_seed."activeDate" IS NOT NULL
            AND publication_seed."historicCursor" IS NOT NULL
            AND publication_seed."historicCursor"
              < publication_seed."activeDate" - 1
            THEN publication_seed."historicCursor"
          ELSE NULL
        END,
        CASE
          WHEN publication_seed."activeDate" IS NOT NULL
            AND publication_seed."historicCursor" IS NOT NULL
            AND publication_seed."historicCursor"
              < publication_seed."activeDate" - 1
            THEN publication_seed."activeDate" - 1
          ELSE NULL
        END,
        now()
      FROM publication_seed
      ON CONFLICT ("id") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP TABLE IF EXISTS "statistic_publication_state"',
    );
    await queryRunner.query(`
      UPDATE "statistic_commune_snapshot"
      SET "status" = 'completed',
          "completedAt" = COALESCE("completedAt", now()),
          "updatedAt" = now()
      WHERE "status" = 'ready'
    `);
    await queryRunner.query(`
      ALTER TABLE "statistic_commune_snapshot"
      DROP CONSTRAINT IF EXISTS "CHK_statistic_commune_snapshot_status"
    `);
    await queryRunner.query(`
      ALTER TABLE "statistic_commune_snapshot"
      DROP COLUMN IF EXISTS "sourceRevision",
      ADD CONSTRAINT "CHK_statistic_commune_snapshot_status" CHECK (
        "status" IN ('running', 'completed', 'failed', 'partial')
      )
    `);
  }
}
