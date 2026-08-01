import { ConfigService } from './config.service';

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
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    return {
      service: new ConfigService(repository as any),
      queryBuilder,
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
    });
    expect(harness.queryBuilder.andWhere).toHaveBeenCalledWith(
      '"computeMapDate" IS NOT DISTINCT FROM :expectedCurrent',
      { expectedCurrent: '2026-07-30' },
    );
    expect(harness.queryBuilder.andWhere).toHaveBeenCalledWith(
      '"computeMapGeneration" = :expectedGeneration',
      { expectedGeneration: '12' },
    );
  });

  it('reports a concurrent statistics cursor change', async () => {
    const harness = createHarness(0);

    await expect(
      harness.service.advanceComputeStatsDate('2026-07-30', '8', '2026-07-31'),
    ).resolves.toBe(false);
  });

  it('increments invalidation generations even for an equal dirty date', async () => {
    const harness = createHarness(1);

    await harness.service.setConfig('2026-07-30', '2026-07-30');

    const [mapSet, statsSet] = harness.queryBuilder.set.mock.calls.map(
      ([value]) => value,
    );
    expect(mapSet.computeMapDate()).toContain('LEAST');
    expect(mapSet.computeMapGeneration()).toBe('"computeMapGeneration" + 1');
    expect(statsSet.computeStatsDate()).toContain('LEAST');
    expect(statsSet.computeStatsGeneration()).toBe(
      '"computeStatsGeneration" + 1',
    );
    expect(harness.queryBuilder.execute).toHaveBeenCalledTimes(2);
  });
});
