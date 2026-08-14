import { MigrationInterface, QueryRunner } from 'typeorm';

export class CurrentZoneRecomputeQueue1786309200000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "current_zone_recompute_request" (
        "departementId" integer PRIMARY KEY,
        "generation" bigint NOT NULL DEFAULT 1,
        "requestedAt" timestamptz NOT NULL DEFAULT now(),
        "lastAttemptAt" timestamptz,
        "attemptCount" integer NOT NULL DEFAULT 0,
        "lastError" text,
        CONSTRAINT "FK_current_zone_recompute_request_departement"
          FOREIGN KEY ("departementId") REFERENCES "departement"("id")
          ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_current_zone_recompute_request_requested"
      ON "current_zone_recompute_request" ("requestedAt")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "current_zone_recompute_request"`,
    );
  }
}
