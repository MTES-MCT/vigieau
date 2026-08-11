import { StatisticService } from './statistic.service';

describe('StatisticService department situation computation', () => {
  function createHarness(existingSituation: Record<string, unknown>) {
    const statistic = {
      id: 1,
      date: '2026-08-11',
      departementSituation: existingSituation,
    };
    const statisticRepository = {
      findOne: jest.fn().mockResolvedValue(statistic),
      save: jest.fn().mockImplementation(async (value) => value),
    };
    const departementService = {
      findAllLight: jest.fn().mockResolvedValue([
        { id: 65, code: '65' },
        { id: 75, code: '75' },
      ]),
    };
    const service = new StatisticService(
      statisticRepository as never,
      departementService as never,
    );
    return { service, statisticRepository };
  }

  it('preserves departments outside a targeted repair', async () => {
    const harness = createHarness({
      '65': { max: 'vigilance' },
      '75': { max: 'crise' },
    });

    await harness.service.computeDepartementsSituation(
      [
        {
          departement: { code: '65' },
          type: 'SUP',
          restriction: { niveauGravite: 'alerte' },
        },
      ] as never,
      '2026-08-11',
      ['65'],
    );

    const saved = harness.statisticRepository.save.mock.calls[0][0];
    expect(saved.departementSituation['65']).toEqual({
      max: 'alerte',
      sup: 'alerte',
      sou: null,
      aep: null,
    });
    expect(saved.departementSituation['75']).toEqual({ max: 'crise' });
  });

  it('replaces the complete situation during a national recomputation', async () => {
    const harness = createHarness({ stale: { max: 'crise' } });

    await harness.service.computeDepartementsSituation([], '2026-08-11');

    const saved = harness.statisticRepository.save.mock.calls[0][0];
    expect(saved.departementSituation).toEqual({
      '65': { max: null, sup: null, sou: null, aep: null },
      '75': { max: null, sup: null, sou: null, aep: null },
    });
  });
});
