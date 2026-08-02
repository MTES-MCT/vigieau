import { MigrationInterface, QueryRunner } from 'typeorm';

export class HistoricCursorProgress1786132800000 implements MigrationInterface {
  name = 'HistoricCursorProgress1786132800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "config"
        ADD COLUMN IF NOT EXISTS "computeMapUpdatedAt" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "computeStatsUpdatedAt" TIMESTAMP WITH TIME ZONE
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "config"
        DROP COLUMN IF EXISTS "computeStatsUpdatedAt",
        DROP COLUMN IF EXISTS "computeMapUpdatedAt"
    `);
  }
}
