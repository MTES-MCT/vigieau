import { MigrationInterface, QueryRunner } from 'typeorm';

export class StatisticCommuneSnapshotBarrier1785945600000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "statistic_commune_snapshot" (
        "snapshotDate" date NOT NULL,
        "scope" character varying(500) NOT NULL,
        "status" character varying(20) NOT NULL,
        "expectedCommuneCount" integer NOT NULL,
        "processedCommuneCount" integer NOT NULL DEFAULT 0,
        "startedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "completedAt" TIMESTAMP WITH TIME ZONE,
        "lastError" text,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_statistic_commune_snapshot" PRIMARY KEY ("snapshotDate", "scope"),
        CONSTRAINT "CHK_statistic_commune_snapshot_status" CHECK (
          "status" IN ('running', 'completed', 'failed', 'partial')
        ),
        CONSTRAINT "CHK_statistic_commune_snapshot_expected_count" CHECK (
          "expectedCommuneCount" >= 0
        ),
        CONSTRAINT "CHK_statistic_commune_snapshot_processed_count" CHECK (
          "processedCommuneCount" >= 0
        )
      )
    `);

    await queryRunner.query(`
      INSERT INTO "statistic_commune_snapshot" (
        "snapshotDate", "scope", "status", "expectedCommuneCount",
        "processedCommuneCount", "startedAt", "completedAt", "lastError",
        "createdAt", "updatedAt"
      ) VALUES (
        DATE '1970-01-01', 'bootstrap', 'failed', 0, 0,
        now(), NULL, 'A national snapshot must be recomputed after barrier activation',
        now(), now()
      )
      ON CONFLICT ("snapshotDate", "scope") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP TABLE IF EXISTS "statistic_commune_snapshot"',
    );
  }
}
