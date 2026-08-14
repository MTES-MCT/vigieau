import { HistoricCursorProgress1786132800000 } from '../migrations/1786132800000-HistoricCursorProgress';

describe('HistoricCursorProgress1786132800000', () => {
  it('adds durable cursor progress timestamps', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
      }),
    };

    await new HistoricCursorProgress1786132800000().up(queryRunner as any);

    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain(
      'ADD COLUMN IF NOT EXISTS "computeMapUpdatedAt"',
    );
    expect(queries[0]).toContain(
      'ADD COLUMN IF NOT EXISTS "computeStatsUpdatedAt"',
    );
  });

  it('drops both progress timestamps on rollback', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
      }),
    };

    await new HistoricCursorProgress1786132800000().down(queryRunner as any);

    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain(
      'DROP COLUMN IF EXISTS "computeStatsUpdatedAt"',
    );
    expect(queries[0]).toContain('DROP COLUMN IF EXISTS "computeMapUpdatedAt"');
  });
});
