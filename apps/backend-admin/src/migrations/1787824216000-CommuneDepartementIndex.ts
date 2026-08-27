import { MigrationInterface, QueryRunner } from 'typeorm';

type IndexState = {
  valid: boolean;
  ready: boolean;
};

export class CommuneDepartementIndex1787824216000 implements MigrationInterface {
  name = 'CommuneDepartementIndex1787824216000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const [indexState] = (await queryRunner.query(`
      SELECT pg_index.indisvalid AS valid, pg_index.indisready AS ready
      FROM pg_index
      INNER JOIN pg_class index_class
        ON index_class.oid = pg_index.indexrelid
      INNER JOIN pg_class table_class
        ON table_class.oid = pg_index.indrelid
      INNER JOIN pg_namespace namespace
        ON namespace.oid = table_class.relnamespace
      WHERE namespace.nspname = current_schema()
        AND table_class.relname = 'commune'
        AND index_class.relname = 'IDX_9fd10acee6a79a942b76466fcd'
    `)) as IndexState[];

    if (indexState?.valid && indexState.ready) {
      return;
    }
    if (indexState) {
      await queryRunner.query(`
        DROP INDEX CONCURRENTLY IF EXISTS "IDX_9fd10acee6a79a942b76466fcd"
      `);
    }
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY "IDX_9fd10acee6a79a942b76466fcd"
      ON "commune" ("departementId")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_9fd10acee6a79a942b76466fcd"
    `);
  }
}
