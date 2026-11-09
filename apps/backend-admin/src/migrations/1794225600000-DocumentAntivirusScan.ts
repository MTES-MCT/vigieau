import { MigrationInterface, QueryRunner } from 'typeorm';

export class DocumentAntivirusScan1794225600000 implements MigrationInterface {
  name = 'DocumentAntivirusScan1794225600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS document_scan_run (
        id uuid PRIMARY KEY,
        scope_hash varchar(64) NOT NULL,
        status varchar(20) NOT NULL,
        report jsonb NOT NULL,
        started_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK (status IN ('running', 'completed', 'limited', 'interrupted', 'failed')),
        CHECK (jsonb_typeof(report) = 'object')
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS document_scan_result (
        identity varchar(64) PRIMARY KEY,
        run_id uuid NOT NULL REFERENCES document_scan_run(id),
        bucket text NOT NULL,
        object_key text NOT NULL,
        version_id text,
        etag text,
        object_size bigint NOT NULL CHECK (object_size >= 0),
        object_modified_at timestamptz,
        fichier_ids integer[] NOT NULL DEFAULT '{}',
        status varchar(24) NOT NULL,
        sha256 varchar(64),
        signature text,
        engine_version text,
        signature_version text,
        signature_updated_at timestamptz,
        reason text,
        quarantine_key text,
        quarantine_version_id text,
        result jsonb NOT NULL DEFAULT '{}',
        attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
        started_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK (status IN ('scanning', 'clean', 'infected', 'unscannable', 'error', 'changed', 'missing', 'quarantine_pending', 'quarantine_failed')),
        CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
        CHECK (jsonb_typeof(result) = 'object'),
        CHECK (status NOT IN ('clean', 'infected') OR sha256 IS NOT NULL),
        CHECK (status <> 'infected' OR quarantine_key IS NOT NULL)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS document_scan_result_status ON document_scan_result (status, updated_at)',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS document_scan_result_object ON document_scan_result (bucket, object_key)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Evidence is retained on rollback; removing it would destroy quarantine provenance.
    await queryRunner.query('SELECT 1');
  }
}
