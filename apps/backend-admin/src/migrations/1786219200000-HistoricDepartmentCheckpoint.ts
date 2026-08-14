import { MigrationInterface, QueryRunner } from 'typeorm';

export class HistoricDepartmentCheckpoint1786219200000 implements MigrationInterface {
  name = 'HistoricDepartmentCheckpoint1786219200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "config"
      ADD COLUMN IF NOT EXISTS "historicComputeEpoch" bigint NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "historic_department_checkpoint" (
        "computedFor" date NOT NULL,
        "departementId" integer NOT NULL,
        "historicComputeEpoch" bigint NOT NULL,
        "sourceRevision" text NOT NULL,
        "materializationVersion" varchar(80) NOT NULL,
        "inputSignature" varchar(64) NOT NULL,
        "outputSignature" varchar(64) NOT NULL,
        "zoneCount" integer NOT NULL,
        "reusedFromDate" date,
        "completedAt" timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "PK_historic_department_checkpoint"
          PRIMARY KEY ("computedFor", "departementId", "historicComputeEpoch"),
        CONSTRAINT "FK_historic_department_checkpoint_departement"
          FOREIGN KEY ("departementId") REFERENCES "departement"("id")
          ON DELETE CASCADE,
        CONSTRAINT "CHK_historic_department_checkpoint_zone_count"
          CHECK ("zoneCount" >= 0),
        CONSTRAINT "CHK_historic_department_checkpoint_reuse_date"
          CHECK (
            "reusedFromDate" IS NULL OR "reusedFromDate" < "computedFor"
          )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_historic_department_checkpoint_reuse"
      ON "historic_department_checkpoint" (
        "departementId",
        "computedFor",
        "historicComputeEpoch",
        "sourceRevision",
        "materializationVersion",
        "inputSignature"
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_historic_department_checkpoint_cleanup"
      ON "historic_department_checkpoint" (
        "completedAt",
        "historicComputeEpoch",
        "sourceRevision"
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP TABLE IF EXISTS "historic_department_checkpoint"',
    );
    await queryRunner.query(
      'ALTER TABLE "config" DROP COLUMN IF EXISTS "historicComputeEpoch"',
    );
  }
}
