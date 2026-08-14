import { StatisticPublicationActivationBarrier1786129200000 } from '../migrations/1786129200000-StatisticPublicationActivationBarrier';

describe('StatisticPublicationActivationBarrier1786129200000', () => {
  it('adds ready snapshots and seeds publication dates from active and legacy cursors', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    };

    await new StatisticPublicationActivationBarrier1786129200000().up(
      queryRunner as any,
    );

    const migrationSql = statements.join('\n');
    expect(migrationSql).toContain(
      'ADD COLUMN IF NOT EXISTS "automaticPublishingPaused" boolean NOT NULL DEFAULT false',
    );
    expect(migrationSql).toContain(
      'ADD COLUMN IF NOT EXISTS "automaticPublishingPausedAt" TIMESTAMP WITH TIME ZONE',
    );
    expect(migrationSql).toContain(
      'ADD COLUMN IF NOT EXISTS "sourceRevision" bigint',
    );
    expect(migrationSql).toContain(
      "'running', 'ready', 'completed', 'failed', 'partial'",
    );
    expect(migrationSql).toContain(
      'CREATE TABLE IF NOT EXISTS "statistic_publication_state"',
    );
    expect(migrationSql).toContain('"historicDirtyThrough" date');
    expect(migrationSql).toContain(
      'CONSTRAINT "CHK_statistic_publication_state_dirty_range" CHECK',
    );
    expect(migrationSql).toContain(
      'CONSTRAINT "CHK_statistic_publication_state_singleton" CHECK ("id" = 1)',
    );
    expect(migrationSql).toContain(
      `(active."sourceComputedAt" AT TIME ZONE 'UTC')::date`,
    );
    expect(migrationSql).toContain('WITH publication_seed AS MATERIALIZED');
    expect(migrationSql).toContain('FROM (VALUES (1)) AS seed("id")');
    expect(migrationSql).toContain(
      'LEFT JOIN "zone_publication_state" publication_state',
    );
    expect(migrationSql).toContain('LEFT JOIN "zone_publication" active');
    expect(migrationSql).toContain('AND active."status" = \'active\'');
    expect(migrationSql).toContain('LEFT JOIN "config" config');
    expect(migrationSql).toContain('WHEN config."computeMapDate" IS NULL');
    expect(migrationSql).toContain('WHEN config."computeStatsDate" IS NULL');
    expect(migrationSql).toContain(
      'LEAST(config."computeMapDate", config."computeStatsDate")',
    );
    expect(migrationSql).toContain('publication_seed."historicCursor" - 1');
    expect(migrationSql).toContain(
      'WHEN publication_seed."historicCursor" IS NULL\n            THEN NULL',
    );
    expect(migrationSql).toContain('publication_seed."activeDate" - 1');
    expect(migrationSql).toContain('ON CONFLICT ("id") DO NOTHING');
  });

  it('removes publication state and maps ready snapshots on rollback', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    };

    await new StatisticPublicationActivationBarrier1786129200000().down(
      queryRunner as any,
    );

    const migrationSql = statements.join('\n');
    expect(migrationSql).toContain(
      'DROP TABLE IF EXISTS "statistic_publication_state"',
    );
    expect(migrationSql).not.toContain(
      'DROP COLUMN IF EXISTS "automaticPublishingPausedAt"',
    );
    expect(migrationSql).not.toContain(
      'DROP COLUMN IF EXISTS "automaticPublishingPaused"',
    );
    expect(migrationSql).toContain(`WHERE "status" = 'ready'`);
    expect(migrationSql).toContain('DROP COLUMN IF EXISTS "sourceRevision"');
    expect(migrationSql).toContain(
      "'running', 'completed', 'failed', 'partial'",
    );
  });
});
