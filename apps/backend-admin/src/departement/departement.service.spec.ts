import { SKIP_STARTUP_DATA_LOADS_ENV } from '../core/startup-data-loads';
import { DepartementService } from './departement.service';

describe('DepartementService startup', () => {
  const previousSkipDataLoads = process.env[SKIP_STARTUP_DATA_LOADS_ENV];

  afterEach(() => {
    if (previousSkipDataLoads === undefined) {
      delete process.env[SKIP_STARTUP_DATA_LOADS_ENV];
    } else {
      process.env[SKIP_STARTUP_DATA_LOADS_ENV] = previousSkipDataLoads;
    }
  });

  function createService() {
    const queryBuilder = {
      select: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    const departementRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    new DepartementService(
      {} as any,
      departementRepository as any,
      {} as any,
      {} as any,
    );

    return departementRepository;
  }

  it('skips the startup load in a worker context', () => {
    process.env[SKIP_STARTUP_DATA_LOADS_ENV] = 'true';

    const departementRepository = createService();

    expect(departementRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('loads departments normally otherwise', () => {
    delete process.env[SKIP_STARTUP_DATA_LOADS_ENV];

    const departementRepository = createService();

    expect(departementRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
  });
});
