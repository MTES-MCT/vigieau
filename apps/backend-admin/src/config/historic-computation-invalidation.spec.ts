import { invalidateHistoricComputationsFromWithManager } from './historic-computation-invalidation';

describe('invalidateHistoricComputationsFromWithManager', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-20T10:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('rewinds both cursors and bumps generations and epoch atomically', async () => {
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([{ exists: true }])
        .mockResolvedValueOnce([[{ id: 1 }], 1]),
    };

    await invalidateHistoricComputationsFromWithManager(
      manager as any,
      '2011-06-07',
    );

    const [sql, parameters] = manager.query.mock.calls[1];
    expect(sql).toContain('"computeMapDate" = CASE');
    expect(sql).toContain('"computeStatsDate" = CASE');
    expect(sql).toContain('"computeMapGeneration" + 1');
    expect(sql).toContain('"computeStatsGeneration" + 1');
    expect(sql).toContain('"historicComputeEpoch" + 1');
    expect(parameters).toEqual(['2011-06-07']);
  });

  it.each([
    ['today', '2026-08-20'],
    ['a future date', '2026-08-21'],
    ['no dirty date', null],
  ])(
    'keeps the epoch for %s while still bumping generations',
    async (_, date) => {
      const manager = {
        query: jest.fn().mockResolvedValueOnce([[{ id: 1 }], 1]),
      };

      await invalidateHistoricComputationsFromWithManager(manager as any, date);

      const [sql, parameters] = manager.query.mock.calls[0];
      expect(sql).toContain('"computeMapGeneration" + 1');
      expect(sql).toContain('"computeStatsGeneration" + 1');
      expect(sql).not.toContain('"historicComputeEpoch" + 1');
      expect(parameters).toEqual([date]);
    },
  );

  it('fails the surrounding transaction when the config row is missing', async () => {
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([{ exists: true }])
        .mockResolvedValueOnce([[], 0]),
    };

    await expect(
      invalidateHistoricComputationsFromWithManager(
        manager as any,
        '2011-06-07',
      ),
    ).rejects.toThrow('Unable to invalidate zone computations');
  });
});
