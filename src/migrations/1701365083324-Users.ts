import { MigrationInterface, QueryRunner } from 'typeorm';

export class Users1701365083324 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`INSERT INTO "user" (email, first_name, last_name, role, role_departements) VALUES
('vincent.laine.utc@gmail.com', 'Vincent', 'Lainé', 'mte', null)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "user" WHERE "email" IN ('vincent.laine@beta.gouv.fr')`,
    );
  }
}
