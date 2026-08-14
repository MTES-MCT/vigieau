import { MigrationInterface, QueryRunner } from 'typeorm';

export class HistoricCursorGeneration1786032000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "config"
        ADD COLUMN IF NOT EXISTS "computeMapGeneration" bigint NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "computeStatsGeneration" bigint NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "config"
        DROP COLUMN IF EXISTS "computeStatsGeneration",
        DROP COLUMN IF EXISTS "computeMapGeneration"
    `);
  }
}
