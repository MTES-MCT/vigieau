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
      query: jest.fn().mockResolvedValueOnce([
        {
          historicComputeEpoch: '8',
          computeMapDate: '2011-06-07',
          computeStatsDate: '2011-06-07',
          changed: true,
        },
      ]),
    };

    await invalidateHistoricComputationsFromWithManager(
      manager as any,
      '2011-06-07',
    );

    const [sql, parameters] = manager.query.mock.calls[0];
    expect(sql).toContain('"record_historic_compute_invalidation"');
    expect(parameters).toEqual([
      '2011-06-07',
      null,
      true,
      true,
      'published-source-mutation',
      null,
      '{}',
      '2011-06-07',
      '2011-06-07',
      false,
      false,
      false,
      true,
      false,
    ]);
  });

  it.each([
    ['today', '2026-08-20'],
    ['a future date', '2026-08-21'],
    ['no dirty date', null],
  ])(
    'keeps the epoch for %s while still bumping generations',
    async (_, date) => {
      const manager = {
        query: jest.fn().mockResolvedValueOnce([
          {
            historicComputeEpoch: '7',
            computeMapDate: date,
            computeStatsDate: date,
            changed: true,
          },
        ]),
      };

      await invalidateHistoricComputationsFromWithManager(manager as any, date);

      const [sql, parameters] = manager.query.mock.calls[0];
      expect(sql).toContain('"record_historic_compute_invalidation"');
      expect(parameters[0]).toBe(date);
      expect(parameters[2]).toBe(false);
      expect(parameters[3]).toBe(false);
      expect(parameters[12]).toBe(false);
    },
  );

  it('fails the surrounding transaction when the config row is missing', async () => {
    const manager = {
      query: jest.fn().mockResolvedValueOnce([]),
    };

    await expect(
      invalidateHistoricComputationsFromWithManager(
        manager as any,
        '2011-06-07',
      ),
    ).rejects.toThrow('Unable to invalidate zone computations');
  });
});
