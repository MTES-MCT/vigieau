import { ConfigService } from './config.service';
import { SKIP_STARTUP_DATA_LOADS_ENV } from '../core/startup-data-loads';

describe('ConfigService historic cursor advancement', () => {
  const createHarness = (affected: number) => {
    const queryBuilder = {
      update: jest.fn(),
      set: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      setParameter: jest.fn(),
      execute: jest.fn().mockResolvedValue({ affected }),
    };
    queryBuilder.update.mockReturnValue(queryBuilder);
    queryBuilder.set.mockReturnValue(queryBuilder);
    queryBuilder.where.mockReturnValue(queryBuilder);
    queryBuilder.andWhere.mockReturnValue(queryBuilder);
    queryBuilder.setParameter.mockReturnValue(queryBuilder);
    const repository = {
      count: jest.fn().mockResolvedValue(1),
      save: jest.fn(),
      query: jest.fn().mockResolvedValue([
        {
          historicComputeEpoch: '8',
          computeMapDate: '2026-07-30',
          computeStatsDate: '2026-07-30',
          changed: true,
        },
      ]),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    return {
      service: new ConfigService(repository as any),
      queryBuilder,
      repository,
    };
  };

  it('advances only when the persisted map cursor still matches', async () => {
    const harness = createHarness(1);

    await expect(
      harness.service.advanceComputeMapDate('2026-07-30', '12', '2026-07-31'),
    ).resolves.toBe(true);

    expect(harness.queryBuilder.set).toHaveBeenCalledWith({
      computeMapDate: '2026-07-31',
      computeMapGeneration: expect.any(Function),
      computeMapUpdatedAt: expect.any(Function),
    });
    expect(
      harness.queryBuilder.set.mock.calls[0][0].historicComputeEpoch,
    ).toBeUndefined();
    expect(
      harness.queryBuilder.set.mock.calls[0][0].historicBackfillGlobalEpoch,
    ).toBeUndefined();
    expect(
      harness.queryBuilder.set.mock.calls[0][0].computeMapUpdatedAt(),
    ).toBe('now()');
    expect(harness.queryBuilder.andWhere).toHaveBeenCalledWith(
      '"computeMapDate" IS NOT DISTINCT FROM :expectedCurrent',
      { expectedCurrent: '2026-07-30' },
    );
    expect(harness.queryBuilder.andWhere).toHaveBeenCalledWith(
      '"computeMapGeneration" = :expectedGeneration',
      { expectedGeneration: '12' },
    );
  });

  it('guards map cursor advancement with the expected source revision', async () => {
    const harness = createHarness(1);

    await harness.service.advanceComputeMapDate(
      '2026-07-30',
      '12',
      '2026-07-31',
      '42',
    );

    const sourceRevisionGuard = harness.queryBuilder.andWhere.mock.calls.find(
      ([condition]) => condition.includes('zone_publication_source_state'),
    );
    expect(sourceRevisionGuard).toEqual([
      expect.stringContaining('EXISTS ('),
      { expectedSourceRevision: '42' },
    ]);
    expect(sourceRevisionGuard?.[0]).toContain(
      'source_state."revision" = :expectedSourceRevision',
    );
    expect(sourceRevisionGuard?.[0]).toContain('FOR SHARE');
  });

  it('reports a concurrent statistics cursor change', async () => {
    const harness = createHarness(0);

    await expect(
      harness.service.advanceComputeStatsDate('2026-07-30', '8', '2026-07-31'),
    ).resolves.toBe(false);
    expect(
      harness.queryBuilder.set.mock.calls[0][0].computeStatsUpdatedAt(),
    ).toBe('now()');
  });

  it('guards statistics cursor advancement with the expected source revision', async () => {
    const harness = createHarness(1);

    await harness.service.advanceComputeStatsDate(
      '2026-07-30',
      '8',
      '2026-07-31',
      '43',
    );

    const sourceRevisionGuard = harness.queryBuilder.andWhere.mock.calls.find(
      ([condition]) => condition.includes('zone_publication_source_state'),
    );
    expect(sourceRevisionGuard).toEqual([
      expect.stringContaining('EXISTS ('),
      { expectedSourceRevision: '43' },
    ]);
    expect(sourceRevisionGuard?.[0]).toContain(
      'source_state."revision" = :expectedSourceRevision',
    );
    expect(sourceRevisionGuard?.[0]).toContain('FOR SHARE');
  });

  it('increments both cursor generations and both global historic fences', async () => {
    const harness = createHarness(1);

    await harness.service.setConfig('2026-07-30', '2026-07-30');

    const [sql, parameters] = harness.repository.query.mock.calls[0];
    expect(sql).toContain('"record_historic_compute_invalidation"');
    expect(parameters).toEqual([
      '2026-07-30',
      null,
      true,
      true,
      'config-cursor-rewind',
      null,
      JSON.stringify({ force: false }),
      '2026-07-30',
      '2026-07-30',
      false,
      false,
      true,
      true,
      false,
    ]);
  });

  it.each([
    ['map', '2026-07-30', undefined],
    ['statistics', undefined, '2026-07-30'],
  ])(
    'increments the historic epoch once for a %s-only invalidation',
    async (_label, computeMapDate, computeStatsDate) => {
      const harness = createHarness(1);

      await harness.service.setConfig(computeMapDate, computeStatsDate);

      const [, parameters] = harness.repository.query.mock.calls[0];
      expect(parameters[2]).toBe(Boolean(computeStatsDate));
      expect(parameters[3]).toBe(Boolean(computeMapDate));
      expect(parameters[11]).toBe(true);
      expect(parameters[12]).toBe(true);
    },
  );

  it('does not invalidate historic checkpoints for a current-map-only update', async () => {
    const harness = createHarness(1);

    await harness.service.setConfig(undefined, undefined, new Date());

    expect(harness.queryBuilder.set).toHaveBeenCalledWith({
      computeZoneAlerteComputedDate: expect.any(Date),
    });
    expect(
      harness.queryBuilder.set.mock.calls[0][0].historicComputeEpoch,
    ).toBeUndefined();
    expect(
      harness.queryBuilder.set.mock.calls[0][0].historicBackfillGlobalEpoch,
    ).toBeUndefined();
  });

  it('invalidates historic checkpoints once when all cursors are reset', async () => {
    const harness = createHarness(1);

    await harness.service.resetConfig();

    const [sql, parameters] = harness.repository.query.mock.calls[0];
    expect(sql).toContain('"record_historic_compute_invalidation"');
    expect(parameters[4]).toBe('config-reset');
    expect(parameters[10]).toBe(true);
    expect(parameters[11]).toBe(true);
  });
});

describe('ConfigService startup', () => {
  const previousSkipDataLoads = process.env[SKIP_STARTUP_DATA_LOADS_ENV];

  afterEach(() => {
    if (previousSkipDataLoads === undefined) {
      delete process.env[SKIP_STARTUP_DATA_LOADS_ENV];
    } else {
      process.env[SKIP_STARTUP_DATA_LOADS_ENV] = previousSkipDataLoads;
    }
  });

  function createRepository() {
    return {
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn().mockResolvedValue({}),
    };
  }

  it('skips config initialization in a worker context', () => {
    process.env[SKIP_STARTUP_DATA_LOADS_ENV] = 'true';
    const repository = createRepository();

    new ConfigService(repository as any);

    expect(repository.count).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('initializes config normally otherwise', async () => {
    delete process.env[SKIP_STARTUP_DATA_LOADS_ENV];
    const repository = createRepository();

    new ConfigService(repository as any);
    await Promise.resolve();

    expect(repository.count).toHaveBeenCalledTimes(1);
    expect(repository.save).toHaveBeenCalledWith({});
  });
});
