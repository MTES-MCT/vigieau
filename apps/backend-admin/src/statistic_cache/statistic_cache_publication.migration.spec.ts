import { StatisticCachePublication1786744800000 } from '../migrations/1786744800000-StatisticCachePublication';

describe('StatisticCachePublication1786744800000', () => {
  it('creates a complete immutable three-artifact publication contract', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    };

    await new StatisticCachePublication1786744800000().up(queryRunner as any);

    const migrationSql = statements.join('\n');
    expect(migrationSql).toContain(
      'CREATE TABLE IF NOT EXISTS "statistic_cache_publication"',
    );
    expect(migrationSql).toContain(
      'CREATE TABLE IF NOT EXISTS "statistic_cache_artifact"',
    );
    expect(migrationSql).toContain(
      'CREATE TABLE IF NOT EXISTS "statistic_cache_state"',
    );
    expect(migrationSql).toContain('"historicRecoveryMonthlyFrom" date');
    expect(migrationSql).not.toContain(
      'CONSTRAINT "UQ_statistic_cache_publication_source"',
    );
    expect(migrationSql).toContain(
      'CREATE INDEX IF NOT EXISTS "IDX_statistic_cache_publication_source"',
    );
    expect(migrationSql).toContain(
      "\"mode\" IN ('legacy-bootstrap', 'versioned')",
    );
    expect(migrationSql).toContain(
      '"materializationStrategy" character varying(30) NOT NULL',
    );
    expect(migrationSql).toContain(
      "'full-clean', 'legacy-safe-boundary', 'daily-delta'",
    );
    for (const auditColumn of [
      'historicDirtyFrom',
      'historicDirtyThrough',
      'historicMapCursor',
      'historicStatsCursor',
      'sourceRevision',
      'historicComputeEpoch',
    ]) {
      expect(migrationSql).toContain(`"${auditColumn}"`);
      expect(migrationSql).toContain(
        `NEW."${auditColumn}" IS DISTINCT FROM OLD."${auditColumn}"`,
      );
    }
    expect(migrationSql).toContain(
      'CHK_statistic_cache_publication_safe_boundary',
    );
    expect(migrationSql).toContain(
      "\"status\" IN ('building', 'ready', 'active', 'retired', 'failed')",
    );
    expect(migrationSql).toContain(
      "\"kind\" IN ('area', 'departement', 'commune')",
    );
    expect(migrationSql).toContain('"payload" bytea NOT NULL');
    expect(migrationSql).toContain(
      '"compressedByteLength" = octet_length("payload")',
    );
    expect(migrationSql).toContain(
      'CREATE OR REPLACE FUNCTION enforce_statistic_cache_publication_immutable()',
    );
    expect(migrationSql).toContain('artifact_count <> 3');
    expect(migrationSql).toContain(
      `OLD."status" = 'retired' AND NEW."status" = 'active'`,
    );
    expect(migrationSql).toContain('area_rows <> NEW."dateCount"');
    expect(migrationSql).toContain('department_rows <> NEW."dateCount"');
    expect(migrationSql).toContain('commune_rows <> NEW."communeCount"');
    expect(migrationSql).toContain(
      'CREATE OR REPLACE FUNCTION enforce_statistic_cache_artifact_immutable()',
    );
    expect(migrationSql).toContain('pg_trigger_depth() = 1');
    expect(migrationSql).toContain(
      'CREATE OR REPLACE FUNCTION enforce_statistic_cache_state_targets()',
    );
    expect(migrationSql).toContain('ON CONFLICT ("id") DO NOTHING');
  });

  it('adds an atomic cache identity to every public API heartbeat', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    };

    await new StatisticCachePublication1786744800000().up(queryRunner as any);

    const migrationSql = statements.join('\n');
    for (const column of [
      'statisticCachePublicationId',
      'statisticRevision',
      'statisticPublishedDate',
      'statisticFingerprint',
      'statisticLastError',
    ]) {
      expect(migrationSql).toContain(`"${column}"`);
    }
    expect(migrationSql).toContain(
      'CONSTRAINT "FK_zone_publication_instance_statistic_cache"',
    );
    expect(migrationSql).toContain(
      '"statisticCachePublicationId", "statisticRevision",',
    );
    expect(migrationSql).toContain(
      '"id", "statisticRevision", "currentPublishedDate",',
    );
    expect(migrationSql).toContain('ON DELETE SET NULL');
    expect(migrationSql).toContain(
      'CHK_zone_publication_instance_statistic_identity',
    );
  });

  it('removes the shared schema and heartbeat columns on rollback', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    };

    await new StatisticCachePublication1786744800000().down(queryRunner as any);

    const migrationSql = statements.join('\n');
    expect(migrationSql).toContain(
      'DROP CONSTRAINT IF EXISTS "FK_zone_publication_instance_statistic_cache"',
    );
    expect(migrationSql).toContain(
      'DROP COLUMN IF EXISTS "statisticCachePublicationId"',
    );
    expect(migrationSql).toContain(
      'DROP FUNCTION IF EXISTS enforce_statistic_cache_publication_immutable',
    );
    expect(migrationSql).toContain(
      'DROP TABLE IF EXISTS "statistic_cache_artifact"',
    );
    expect(migrationSql).toContain(
      'DROP TABLE IF EXISTS "statistic_cache_publication"',
    );
  });
});
