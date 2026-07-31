import { StatisticCommuneService } from './statistic_commune.service';

describe('StatisticCommuneService', () => {
  it('streams the complete commune history in a stable order', async () => {
    const stream = {};
    const queryBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      stream: jest.fn().mockResolvedValue(stream),
    };
    const repository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    const service = new StatisticCommuneService(
      repository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(service.getStatisticCommuneStream()).resolves.toBe(stream);

    expect(queryBuilder.addSelect).toHaveBeenCalledWith(
      'sc.restrictions',
      'sc_restrictions',
    );
    expect(queryBuilder.orderBy).toHaveBeenCalledWith('commune.code', 'ASC');
  });

  it('streams commune restrictions within the requested year bounds', async () => {
    const stream = {};
    const queryBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      stream: jest.fn().mockResolvedValue(stream),
    };
    const repository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    const service = new StatisticCommuneService(
      repository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(service.getStatisticCommuneStreamForYear(2026)).resolves.toBe(
      stream,
    );

    expect(queryBuilder.setParameters).toHaveBeenCalledWith({
      startDate: '2026-01-01',
      endDate: '2027-01-01',
    });
    expect(queryBuilder.orderBy).toHaveBeenCalledWith('commune.code', 'ASC');
    const restrictionSelection = queryBuilder.addSelect.mock.calls.find(
      (call) => call[1] === 'sc_restrictions',
    )[0];
    expect(restrictionSelection).toContain(
      "restriction.value ->> 'date' >= :startDate",
    );
    expect(restrictionSelection).toContain(
      "restriction.value ->> 'date' < :endDate",
    );
  });

  it('rejects invalid statistic years before querying the database', async () => {
    const repository = { createQueryBuilder: jest.fn() };
    const service = new StatisticCommuneService(
      repository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.getStatisticCommuneStreamForYear(2026.5),
    ).rejects.toThrow('Invalid statistic year');
    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('limits daily recomputation to requested departements', async () => {
    const communeService = {
      count: jest.fn().mockResolvedValue(1),
      findWithStats: jest.fn().mockResolvedValue([]),
    };
    const service = new StatisticCommuneService(
      {} as any,
      communeService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await service.computeCommuneStatisticsRestrictions(
      [],
      new Date('2025-07-13T00:00:00.000Z'),
      true,
      false,
      ['18'],
    );

    expect(communeService.count).toHaveBeenCalledWith(['18']);
    expect(communeService.findWithStats).toHaveBeenCalledWith(1000, 0, ['18']);
  });
});
