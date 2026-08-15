import { MigrationInterface, QueryRunner } from 'typeorm';

export class HistoricConfigSchemaRepair1786831200000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "config"
        ADD COLUMN IF NOT EXISTS "computeMapGeneration" bigint NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "computeStatsGeneration" bigint NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "computeMapUpdatedAt" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "computeStatsUpdatedAt" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "historicComputeEpoch" bigint
    `);

    const [configState] = await queryRunner.query(`
      SELECT
        EXISTS (
          SELECT 1
          FROM "config"
          WHERE "historicComputeEpoch" IS NULL
        ) AS "configHasNullHistoricComputeEpoch",
        NOT EXISTS (
          SELECT 1
          FROM "config"
        ) AS "configIsEmpty"
    `);
    const configHasNullHistoricComputeEpoch =
      configState?.configHasNullHistoricComputeEpoch === true;
    const configIsEmpty = configState?.configIsEmpty === true;

    if (configHasNullHistoricComputeEpoch || configIsEmpty) {
      const [checkpointState] = await queryRunner.query(`
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'historic_department_checkpoint'
            AND column_name = 'historicComputeEpoch'
        ) AS "checkpointEpochAvailable"
      `);
      let nextHistoricComputeEpoch = '0';
      if (checkpointState?.checkpointEpochAvailable === true) {
        await queryRunner.query(
          'LOCK TABLE "historic_department_checkpoint" IN SHARE MODE',
        );
        const [checkpointFence] = await queryRunner.query(`
          SELECT (
            COALESCE(MAX("historicComputeEpoch"), -1) + 1
          )::text AS "nextHistoricComputeEpoch"
          FROM "historic_department_checkpoint"
        `);
        nextHistoricComputeEpoch =
          checkpointFence?.nextHistoricComputeEpoch ?? '0';
      }
      if (configIsEmpty) {
        await queryRunner.query(
          `
            INSERT INTO "config" ("id", "historicComputeEpoch")
            VALUES (1, $1::bigint)
            ON CONFLICT ("id") DO NOTHING
          `,
          [nextHistoricComputeEpoch],
        );
      }
      await queryRunner.query(
        `
          UPDATE "config"
          SET "historicComputeEpoch" = $1::bigint
          WHERE "historicComputeEpoch" IS NULL
        `,
        [nextHistoricComputeEpoch],
      );
    }

    await queryRunner.query(`
      ALTER TABLE "config"
        ALTER COLUMN "historicComputeEpoch" SET DEFAULT 0,
        ALTER COLUMN "historicComputeEpoch" SET NOT NULL
    `);
  }

  public down(): Promise<void> {
    // These columns belong to earlier migrations and must survive this repair rollback.
    return Promise.resolve();
  }
}
