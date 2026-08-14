import { StatisticCommuneSnapshotBarrier1785945600000 } from '../migrations/1785945600000-StatisticCommuneSnapshotBarrier';

describe('StatisticCommuneSnapshotBarrier1785945600000', () => {
  it('creates a persistent completion barrier with distinct scopes', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
      }),
    };
    const migration = new StatisticCommuneSnapshotBarrier1785945600000();

    await migration.up(queryRunner as any);

    expect(queries.join('\n')).toContain(
      'CREATE TABLE IF NOT EXISTS "statistic_commune_snapshot"',
    );
    expect(queries.join('\n')).toContain(
      "\"status\" IN ('running', 'completed', 'failed', 'partial')",
    );
    expect(queries.join('\n')).toContain(
      'PRIMARY KEY ("snapshotDate", "scope")',
    );
    expect(queries.join('\n')).toContain(
      "DATE '1970-01-01', 'bootstrap', 'failed', 0, 0",
    );
  });

  it('activates fail-closed without scanning legacy JSON histories', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
      }),
    };
    const migration = new StatisticCommuneSnapshotBarrier1785945600000();
    await migration.up(queryRunner as any);

    expect(queries).toHaveLength(2);
    expect(queries.join('\n')).not.toContain('statistic_commune" statistic');
    expect(queries.join('\n')).not.toContain('jsonb_array_elements');
    expect(queries.join('\n')).not.toContain('commune_latest');
  });

  it('drops the barrier table on rollback', async () => {
    const queryRunner = { query: jest.fn().mockResolvedValue(undefined) };
    const migration = new StatisticCommuneSnapshotBarrier1785945600000();

    await migration.down(queryRunner as any);

    expect(queryRunner.query).toHaveBeenCalledWith(
      'DROP TABLE IF EXISTS "statistic_commune_snapshot"',
    );
  });
});
