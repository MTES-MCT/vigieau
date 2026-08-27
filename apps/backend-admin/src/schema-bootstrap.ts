import { DataSource, QueryRunner } from 'typeorm';

const SCHEMA_BOOTSTRAP_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

async function acquireSchemaBootstrapLock(
  dataSource: DataSource,
): Promise<QueryRunner> {
  const deadline = Date.now() + SCHEMA_BOOTSTRAP_LOCK_TIMEOUT_MS;
  while (true) {
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      const [lockResult] = await queryRunner.query(
        "SELECT pg_try_advisory_lock(hashtext('vigieau'), hashtext('schema-bootstrap')) AS locked",
      );
      if (lockResult?.locked === true) {
        return queryRunner;
      }
    } catch (error) {
      await queryRunner.release();
      throw error;
    }
    await queryRunner.release();
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the schema bootstrap lock');
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export async function bootstrapSchema(dataSource: DataSource): Promise<void> {
  const queryRunner = await acquireSchemaBootstrapLock(dataSource);
  try {
    const [schemaState] = await queryRunner.query(`
      SELECT to_regclass(current_schema() || '."user"') IS NOT NULL
        AS "baselineExists"
    `);
    if (schemaState?.baselineExists !== true) {
      await dataSource.synchronize();
    }
    await dataSource.runMigrations({ transaction: 'each' });
  } finally {
    try {
      const [unlockResult] = await queryRunner.query(
        "SELECT pg_advisory_unlock(hashtext('vigieau'), hashtext('schema-bootstrap'))",
      );
      if (unlockResult?.pg_advisory_unlock !== true) {
        throw new Error('Unable to release the schema bootstrap lock');
      }
    } finally {
      await queryRunner.release();
    }
  }
}
