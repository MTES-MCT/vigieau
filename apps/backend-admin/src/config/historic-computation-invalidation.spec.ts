import {
  invalidateHistoricCalendarComputationsWithManager,
  invalidateHistoricComputationsFromWithManager,
} from './historic-computation-invalidation';

describe('invalidateHistoricCalendarComputationsWithManager', () => {
  const manager = () => ({
    query: jest.fn().mockResolvedValue([
      {
        historicComputeEpoch: '8',
        computeMapDate: '2026-07-11',
        computeStatsDate: '2026-08-16',
        changed: true,
      },
    ]),
  });

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-20T10:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('separates conservative map metadata impact from the exact statistic ranges', async () => {
    const executor = manager();
    const context = { arreteId: 42, mutation: 'reconcile-end-date' };
    await invalidateHistoricCalendarComputationsWithManager(
      executor as any,
      '2026-07-11',
      [
        { from: '2026-07-11', through: '2026-07-14' },
        { from: '2026-08-16', through: '2026-08-18' },
      ],
      context,
    );

    expect(executor.query).toHaveBeenCalledTimes(3);
    const parameters = executor.query.mock.calls.map(([, values]) => values);
    expect(parameters).toEqual([
      [
        '2026-07-11',
        '2026-08-19',
        false,
        true,
        'published-calendar-mutation',
        null,
        JSON.stringify(context),
        '2026-07-11',
        null,
        false,
        false,
        false,
        true,
        false,
      ],
      [
        '2026-07-11',
        '2026-07-14',
        true,
        false,
        'published-calendar-mutation',
        null,
        JSON.stringify(context),
        null,
        '2026-07-11',
        false,
        false,
        false,
        true,
        false,
      ],
      [
        '2026-08-16',
        '2026-08-18',
        true,
        false,
        'published-calendar-mutation',
        null,
        JSON.stringify(context),
        null,
        '2026-08-16',
        false,
        false,
        false,
        true,
        false,
      ],
    ]);
    for (const [sql] of executor.query.mock.calls) {
      expect(sql).toContain('"record_historic_compute_invalidation"');
    }
  });

  it('does not invalidate statistics or their generation for unchanged active days', async () => {
    const executor = manager();
    await invalidateHistoricCalendarComputationsWithManager(
      executor as any,
      '2026-07-11',
      [],
    );
    expect(executor.query).toHaveBeenCalledTimes(1);
    const [, parameters] = executor.query.mock.calls[0];
    expect(parameters[2]).toBe(false);
    expect(parameters[3]).toBe(true);
    expect(parameters[7]).toBe('2026-07-11');
    expect(parameters[8]).toBeNull();
    expect(parameters[12]).toBe(true);
  });

  it.each([null, '2026-09-01', '2026-08-20'])(
    'clamps the statistic historic through %s to yesterday',
    async (through) => {
      const executor = manager();
      await invalidateHistoricCalendarComputationsWithManager(
        executor as any,
        '2026-07-11',
        [{ from: '2026-08-16', through }],
      );
      const [, parameters] = executor.query.mock.calls[1];
      expect(parameters[0]).toBe('2026-08-16');
      expect(parameters[1]).toBe('2026-08-19');
      expect(parameters[2]).toBe(true);
      expect(parameters[3]).toBe(false);
      expect(parameters[8]).toBe('2026-08-16');
      expect(parameters[12]).toBe(true);
    },
  );

  it.each(['2026-08-20', '2026-08-21'])(
    'requests current or future cursor generations without invalidating history: %s',
    async (from) => {
      const executor = manager();
      await invalidateHistoricCalendarComputationsWithManager(
        executor as any,
        from,
        [{ from, through: null }],
      );
      const parameters = executor.query.mock.calls.map(([, values]) => values);
      expect(parameters).toHaveLength(2);
      expect(parameters[0][7]).toBe(from);
      expect(parameters[0][8]).toBeNull();
      expect(parameters[1][7]).toBeNull();
      expect(parameters[1][8]).toBe(from);
      for (const values of parameters) {
        expect(values[2]).toBe(false);
        expect(values[3]).toBe(false);
        expect(values[12]).toBe(false);
      }
    },
  );

  it('uses the Paris day at the UTC date boundary', async () => {
    jest.setSystemTime(new Date('2026-08-19T22:30:00.000Z'));
    const executor = manager();
    await invalidateHistoricCalendarComputationsWithManager(
      executor as any,
      '2026-08-19',
      [{ from: '2026-08-19', through: null }],
    );
    for (const [, parameters] of executor.query.mock.calls) {
      expect(parameters[1]).toBe('2026-08-19');
      expect(parameters[12]).toBe(true);
    }
  });

  it('normalizes dates before passing them to the ledger', async () => {
    const executor = manager();
    await invalidateHistoricCalendarComputationsWithManager(
      executor as any,
      '2026-08-17T12:00:00.000Z',
      [
        {
          from: '2026-08-17T12:00:00.000Z',
          through: '2026-08-18T12:00:00.000Z',
        },
      ],
    );
    expect(executor.query.mock.calls[0][1][0]).toBe('2026-08-17');
    expect(executor.query.mock.calls[1][1].slice(0, 2)).toEqual([
      '2026-08-17',
      '2026-08-18',
    ]);
  });

  it('preserves the legacy null map date without touching statistic generations', async () => {
    const executor = manager();
    await invalidateHistoricCalendarComputationsWithManager(
      executor as any,
      null,
      [],
    );
    const [, parameters] = executor.query.mock.calls[0];
    expect(parameters[0]).toBeNull();
    expect(parameters[2]).toBe(false);
    expect(parameters[3]).toBe(false);
    expect(parameters[7]).toBeNull();
    expect(parameters[8]).toBeNull();
    expect(parameters[12]).toBe(false);
  });

  it.each([
    { mapFrom: '', from: '2026-08-17', through: null },
    { mapFrom: 'invalid', from: '2026-08-17', through: null },
    { mapFrom: '2026-08-17', from: 'invalid', through: null },
    { mapFrom: '2026-08-17', from: '2026-08-17', through: '' },
    { mapFrom: '2026-08-17', from: '2026-08-17', through: '2026-02-29' },
    { mapFrom: '2026-08-17', from: '2026-08-17', through: '2026-08-16' },
  ])(
    'rejects invalid intervals before performing any update: %p',
    async ({ mapFrom, from, through }) => {
      const executor = manager();
      await expect(
        invalidateHistoricCalendarComputationsWithManager(
          executor as any,
          mapFrom,
          [{ from, through }],
        ),
      ).rejects.toThrow();
      expect(executor.query).not.toHaveBeenCalled();
    },
  );

  it.each([
    { rows: [] },
    { rows: [{ changed: false }] },
    { rows: [{ changed: true }, { changed: true }] },
  ])(
    'fails the surrounding transaction for invalid update result %p',
    async ({ rows }) => {
      const executor = manager();
      executor.query.mockResolvedValueOnce(rows);
      await expect(
        invalidateHistoricCalendarComputationsWithManager(
          executor as any,
          '2026-07-11',
          [{ from: '2026-08-16', through: null }],
        ),
      ).rejects.toThrow('Unable to invalidate zone computations');
      expect(executor.query).toHaveBeenCalledTimes(1);
    },
  );

  it('merges duplicate, overlapping and adjacent ranges without filling their gaps', async () => {
    const executor = manager();
    const ranges = [
      { from: '2026-08-16', through: '2026-08-18' },
      { from: '2026-07-15', through: '2026-07-16' },
      { from: '2026-07-11', through: '2026-07-13' },
      { from: '2026-07-12', through: '2026-07-14' },
      { from: '2026-07-11', through: '2026-07-13' },
    ];
    const originalRanges = ranges.map((range) => ({ ...range }));
    await invalidateHistoricCalendarComputationsWithManager(
      executor as any,
      '2026-07-11',
      ranges,
    );
    expect(executor.query).toHaveBeenCalledTimes(3);
    expect(
      executor.query.mock.calls
        .slice(1)
        .map(([, parameters]) => parameters.slice(0, 2)),
    ).toEqual([
      ['2026-07-11', '2026-07-16'],
      ['2026-08-16', '2026-08-18'],
    ]);
    expect(ranges).toEqual(originalRanges);
  });

  it('merges open-ended intervals and later ranges into one invalidation', async () => {
    const executor = manager();
    await invalidateHistoricCalendarComputationsWithManager(
      executor as any,
      '2026-07-11',
      [
        { from: '2026-08-18', through: '2026-08-19' },
        { from: '2026-08-17', through: null },
        { from: '2026-08-16', through: '2026-08-17' },
        { from: '2026-09-01', through: null },
      ],
    );
    expect(executor.query).toHaveBeenCalledTimes(2);
    expect(executor.query.mock.calls[1][1].slice(0, 2)).toEqual([
      '2026-08-16',
      '2026-08-19',
    ]);
  });

  it('fails the surrounding transaction if a later statistic invalidation fails', async () => {
    const executor = manager();
    executor.query
      .mockResolvedValueOnce([{ changed: true }])
      .mockResolvedValueOnce([]);
    await expect(
      invalidateHistoricCalendarComputationsWithManager(
        executor as any,
        '2026-07-11',
        [{ from: '2026-08-16', through: null }],
      ),
    ).rejects.toThrow('Unable to invalidate zone computations');
    expect(executor.query).toHaveBeenCalledTimes(2);
  });
});

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
