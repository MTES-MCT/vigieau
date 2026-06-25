import { StatisticCommuneService } from './statistic_commune.service';

describe('StatisticCommuneService', () => {
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
