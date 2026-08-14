import { HistoricCursorGeneration1786032000000 } from '../migrations/1786032000000-HistoricCursorGeneration';

describe('HistoricCursorGeneration1786032000000', () => {
  it('supports fresh and upgrade schemas without resetting cursor dates', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => statements.push(sql)),
    };

    await new HistoricCursorGeneration1786032000000().up(queryRunner as any);

    const sql = statements.join('\n');
    expect(sql).toContain('ALTER TABLE "config"');
    expect(sql).toContain(
      'ADD COLUMN IF NOT EXISTS "computeMapGeneration" bigint NOT NULL DEFAULT 0',
    );
    expect(sql).toContain(
      'ADD COLUMN IF NOT EXISTS "computeStatsGeneration" bigint NOT NULL DEFAULT 0',
    );
    expect(sql).not.toContain('UPDATE "config"');
    expect(sql).not.toContain('computeMapDate =');
    expect(sql).not.toContain('computeStatsDate =');
  });

  it('removes both generations on rollback', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new HistoricCursorGeneration1786032000000().down({ query } as any);

    const sql = query.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain('DROP COLUMN IF EXISTS "computeStatsGeneration"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "computeMapGeneration"');
  });
});
