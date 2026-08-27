import { CommuneDepartementIndex1787824216000 } from '../migrations/1787824216000-CommuneDepartementIndex';

describe('CommuneDepartementIndex1787824216000', () => {
  const migration = new CommuneDepartementIndex1787824216000();

  it('runs outside a transaction and creates the index concurrently', async () => {
    const query = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await migration.up({ query } as any);

    expect(migration.transaction).toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain(
      'CREATE INDEX CONCURRENTLY "IDX_9fd10acee6a79a942b76466fcd"',
    );
    expect(query.mock.calls[1][0]).toContain('ON "commune" ("departementId")');
  });

  it('replaces an invalid interrupted index before retrying', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ valid: false, ready: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await migration.up({ query } as any);

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1][0]).toContain('DROP INDEX CONCURRENTLY');
    expect(query.mock.calls[2][0]).toContain('CREATE INDEX CONCURRENTLY');
  });

  it('keeps an existing valid index', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ valid: true, ready: true }]);

    await migration.up({ query } as any);

    expect(query).toHaveBeenCalledTimes(1);
  });

  it('uses a transaction-compatible rollback', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);

    await migration.down({ query } as any);

    expect(query.mock.calls[0][0]).toContain('DROP INDEX IF EXISTS');
    expect(query.mock.calls[0][0]).not.toContain('CONCURRENTLY');
  });
});
