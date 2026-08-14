import { of } from 'rxjs';
import { SKIP_STARTUP_DATA_LOADS_ENV } from '../core/startup-data-loads';
import { DepartementService } from './departement.service';

const departementFeature = (code: string) => ({
  type: 'Feature',
  properties: { code },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
  },
});

const completeDepartementFeed = () => ({
  type: 'FeatureCollection',
  features: Array.from({ length: 90 }, (_, index) =>
    departementFeature(String(index + 1).padStart(2, '0')),
  ),
});

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

  function createGeometryService(
    feed: unknown,
    matches: (code: string) => boolean,
  ) {
    process.env[SKIP_STARTUP_DATA_LOADS_ENV] = 'true';
    const query = jest.fn(async (sql: string, parameters: unknown[]) => {
      if (sql.includes('SELECT') && sql.includes('ST_Equals')) {
        const code = String(parameters[0]);
        return [{ id: Number(code), matches: matches(code) }];
      }
      if (sql.includes('UPDATE departement')) {
        return [];
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const manager = { query };
    const transaction = jest.fn(async (callback) => callback(manager));
    const service = new DepartementService(
      { get: jest.fn().mockReturnValue(of({ data: feed })) } as any,
      { manager: { transaction } } as any,
      { get: jest.fn().mockReturnValue('https://example.test/feed') } as any,
      {} as any,
    );

    return { query, service, transaction };
  }

  it('does not update departments when every geometry already matches', async () => {
    const { query, service } = createGeometryService(
      completeDepartementFeed(),
      () => true,
    );

    await service.updateDepartementsGeom();

    expect(query).toHaveBeenCalledTimes(90);
    expect(
      query.mock.calls.filter(([sql]) => sql.includes('UPDATE departement')),
    ).toHaveLength(0);
  });

  it('updates only the different geometry with an explicit SRID 4326', async () => {
    const { query, service } = createGeometryService(
      completeDepartementFeed(),
      (code) => code !== '65',
    );

    await service.updateDepartementsGeom();

    const comparisonQueries = query.mock.calls.filter(([sql]) =>
      sql.includes('ST_Equals'),
    );
    const updateQueries = query.mock.calls.filter(([sql]) =>
      sql.includes('UPDATE departement'),
    );
    expect(comparisonQueries).toHaveLength(90);
    expect(comparisonQueries[0][0]).toContain(
      'ST_SRID(departement.geom) <> 4326',
    );
    expect(updateQueries).toHaveLength(1);
    expect(updateQueries[0][0]).toContain(
      'ST_SetSRID(ST_GeomFromGeoJSON($2::text), 4326)',
    );
    expect(updateQueries[0][1][0]).toBe(65);
  });

  it('validates the feed before opening the update transaction', async () => {
    const { query, service, transaction } = createGeometryService(
      {
        type: 'FeatureCollection',
        features: [departementFeature('65')],
      },
      () => true,
    );

    await expect(service.updateDepartementsGeom()).rejects.toThrow('incomplet');
    expect(transaction).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
