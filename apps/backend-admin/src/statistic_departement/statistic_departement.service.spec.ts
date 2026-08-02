import { StatisticDepartementService } from './statistic_departement.service';
import { SKIP_STARTUP_DATA_LOADS_ENV } from '../core/startup-data-loads';

describe('StatisticDepartementService startup', () => {
  const previousSkipStartup = process.env.SKIP_STARTUP_DEPARTEMENT_STATISTICS;
  const previousSkipDataLoads = process.env[SKIP_STARTUP_DATA_LOADS_ENV];

  afterEach(() => {
    if (previousSkipStartup === undefined) {
      delete process.env.SKIP_STARTUP_DEPARTEMENT_STATISTICS;
    } else {
      process.env.SKIP_STARTUP_DEPARTEMENT_STATISTICS = previousSkipStartup;
    }
    if (previousSkipDataLoads === undefined) {
      delete process.env[SKIP_STARTUP_DATA_LOADS_ENV];
    } else {
      process.env[SKIP_STARTUP_DATA_LOADS_ENV] = previousSkipDataLoads;
    }
  });

  function createService() {
    const statisticDepartementRepository = {
      find: jest.fn().mockResolvedValue([]),
    };
    const service = new StatisticDepartementService(
      statisticDepartementRepository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    return { service, statisticDepartementRepository };
  }

  it('skips the startup load when explicitly requested', () => {
    process.env.SKIP_STARTUP_DEPARTEMENT_STATISTICS = 'true';

    const { statisticDepartementRepository } = createService();

    expect(statisticDepartementRepository.find).not.toHaveBeenCalled();
  });

  it('skips the startup load in a worker context', () => {
    delete process.env.SKIP_STARTUP_DEPARTEMENT_STATISTICS;
    process.env[SKIP_STARTUP_DATA_LOADS_ENV] = 'true';

    const { statisticDepartementRepository } = createService();

    expect(statisticDepartementRepository.find).not.toHaveBeenCalled();
  });

  it('loads department statistics normally otherwise', () => {
    delete process.env.SKIP_STARTUP_DEPARTEMENT_STATISTICS;
    delete process.env[SKIP_STARTUP_DATA_LOADS_ENV];

    const { statisticDepartementRepository } = createService();

    expect(statisticDepartementRepository.find).toHaveBeenCalledTimes(1);
  });
});
