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

describe('StatisticDepartementService restriction computation', () => {
  const departements = [
    { id: 65, code: '65', nom: 'Hautes-Pyrenees' },
    { id: 75, code: '75', nom: 'Paris' },
  ];

  function createHarness(options?: {
    areaRows?: Array<{
      departementCode: string;
      zoneType: string;
      gravityLevel: string;
      area: number | null;
      requestedZoneCount?: number;
      foundZoneCount?: number;
    }>;
    departements?: Array<{ id: number; code: string; nom: string }>;
    existingStats?: Array<{ id: number; departement: { code: string } }>;
    updatedRowCount?: number;
  }) {
    const selectedDepartements = options?.departements ?? departements;
    const existingStats =
      options?.existingStats ??
      selectedDepartements.map((departement, index) => ({
        id: 100 + index,
        departement: { code: departement.code },
      }));
    const query = jest.fn(async (sql: string, parameters: unknown[]) => {
      if (sql.includes('WITH requested_zones AS')) {
        const requests = JSON.parse(parameters[0] as string);
        const counts = new Map<string, number>();
        requests.forEach((request) => {
          const key = `${request.departementCode}:${request.zoneType}:${request.gravityLevel}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        });
        return (options?.areaRows ?? []).map((row) => {
          const key = `${row.departementCode}:${row.zoneType}:${row.gravityLevel}`;
          const requestedZoneCount = counts.get(key) ?? 0;
          return {
            ...row,
            requestedZoneCount: row.requestedZoneCount ?? requestedZoneCount,
            foundZoneCount: row.foundZoneCount ?? requestedZoneCount,
          };
        });
      }
      if (sql.includes('WITH updates AS')) {
        const updates = JSON.parse(parameters[0] as string);
        return [
          {
            expected: updates.length,
            affected: options?.updatedRowCount ?? updates.length,
          },
        ];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const save = jest.fn(async (stats: any[]) =>
      stats.map((stat, index) => ({ ...stat, id: 1000 + index })),
    );
    const statisticDepartementRepository = {
      find: jest.fn().mockResolvedValue(existingStats),
      query,
      save,
    };
    const departementService = {
      findAllLight: jest.fn().mockResolvedValue(selectedDepartements),
    };
    const zoneAlerteComputedService = { getZonesArea: jest.fn() };
    const zoneAlerteComputedHistoricService = { getZonesArea: jest.fn() };
    const zoneAlerteService = { getZonesArea: jest.fn() };

    const previousSkipDataLoads = process.env[SKIP_STARTUP_DATA_LOADS_ENV];
    process.env[SKIP_STARTUP_DATA_LOADS_ENV] = 'true';
    const service = new StatisticDepartementService(
      statisticDepartementRepository as any,
      {} as any,
      {} as any,
      departementService as any,
      zoneAlerteComputedService as any,
      zoneAlerteComputedHistoricService as any,
      zoneAlerteService as any,
    );
    if (previousSkipDataLoads === undefined) {
      delete process.env[SKIP_STARTUP_DATA_LOADS_ENV];
    } else {
      process.env[SKIP_STARTUP_DATA_LOADS_ENV] = previousSkipDataLoads;
    }

    return {
      service,
      statisticDepartementRepository,
      departementService,
      zoneAlerteComputedService,
      zoneAlerteComputedHistoricService,
      zoneAlerteService,
    };
  }

  function getSqlCall(query: jest.Mock, marker: string): [string, unknown[]] {
    return query.mock.calls.find(([sql]) => sql.includes(marker));
  }

  it('aggregates areas once and preserves the exact restriction payload shapes', async () => {
    const harness = createHarness({
      areaRows: [
        {
          departementCode: '65',
          zoneType: 'SUP',
          gravityLevel: 'alerte',
          area: 12.346,
        },
        {
          departementCode: '65',
          zoneType: 'SOU',
          gravityLevel: 'vigilance',
          area: 0,
        },
        {
          departementCode: '75',
          zoneType: 'AEP',
          gravityLevel: 'crise',
          area: 3.1,
        },
      ],
    });
    const zones = [
      {
        id: 987654,
        type: 'SUP',
        departement: { code: '65' },
        restriction: { niveauGravite: 'alerte' },
      },
      {
        id: 987654,
        type: 'SUP',
        departement: { code: '65' },
        restriction: { niveauGravite: 'alerte' },
      },
      {
        id: 987655,
        type: 'SOU',
        departement: { code: '65' },
        restriction: { niveauGravite: 'vigilance' },
      },
      {
        id: 987656,
        type: 'AEP',
        departement: { code: '75' },
        restriction: { niveauGravite: 'crise' },
      },
      {
        id: 987657,
        type: 'SUP',
        departement: { code: '75' },
      },
    ];

    await harness.service.computeDepartementStatisticsRestrictions(
      zones as any,
      new Date('2023-06-01T00:00:00.000Z'),
    );

    const [areaSql, areaParameters] = getSqlCall(
      harness.statisticDepartementRepository.query,
      'WITH requested_zones AS',
    );
    expect(areaSql).toContain('LEFT JOIN "zone_alerte_computed" zone');
    expect(areaSql).not.toContain('987654');
    expect(JSON.parse(areaParameters[0] as string)).toEqual([
      {
        id: 987654,
        departementCode: '65',
        zoneType: 'SUP',
        gravityLevel: 'alerte',
      },
      {
        id: 987655,
        departementCode: '65',
        zoneType: 'SOU',
        gravityLevel: 'vigilance',
      },
      {
        id: 987656,
        departementCode: '75',
        zoneType: 'AEP',
        gravityLevel: 'crise',
      },
    ]);

    const [updateSql, updateParameters] = getSqlCall(
      harness.statisticDepartementRepository.query,
      'WITH updates AS',
    );
    expect(updateSql).not.toContain('2023-06-01');
    const updates = JSON.parse(updateParameters[0] as string);
    expect(updates).toEqual([
      {
        departementId: 65,
        date: '2023-06-01',
        restriction: {
          date: '2023-06-01',
          SOU: {
            vigilance: '0.00',
            alerte: 0,
            alerte_renforcee: 0,
            crise: 0,
          },
          SUP: {
            vigilance: 0,
            alerte: '12.35',
            alerte_renforcee: 0,
            crise: 0,
          },
          AEP: {
            vigilance: 0,
            alerte: 0,
            alerte_renforcee: 0,
            crise: 0,
          },
        },
      },
      {
        departementId: 75,
        date: '2023-06-01',
        restriction: {
          date: '2023-06-01',
          SOU: {
            vigilance: 0,
            alerte: 0,
            alerte_renforcee: 0,
            crise: 0,
          },
          SUP: {
            vigilance: 0,
            alerte: 0,
            alerte_renforcee: 0,
            crise: 0,
          },
          AEP: {
            vigilance: 0,
            alerte: 0,
            alerte_renforcee: 0,
            crise: '3.10',
          },
        },
      },
    ]);
    expect(
      harness.zoneAlerteComputedService.getZonesArea,
    ).not.toHaveBeenCalled();
    expect(
      harness.zoneAlerteComputedHistoricService.getZonesArea,
    ).not.toHaveBeenCalled();
    expect(harness.zoneAlerteService.getZonesArea).not.toHaveBeenCalled();
  });

  it.each([
    [false, false, 'zone_alerte_computed', false],
    [true, false, 'zone_alerte_computed_historic', false],
    [false, true, 'zone_alerte', true],
    [true, true, 'zone_alerte', true],
  ])(
    'selects the whitelisted area source for historic=%s legacy=%s',
    async (historic, historicNotComputed, table, transformsGeometry) => {
      const harness = createHarness({
        departements: [departements[0]],
        existingStats: [{ id: 100, departement: { code: '65' } }],
        areaRows: [
          {
            departementCode: '65',
            zoneType: 'SUP',
            gravityLevel: 'crise',
            area: 1,
          },
        ],
      });

      await harness.service.computeDepartementStatisticsRestrictions(
        [
          {
            id: 42,
            type: 'SUP',
            departement: { code: '65' },
            restriction: { niveauGravite: 'crise' },
          },
        ] as any,
        new Date('2023-06-01T00:00:00.000Z'),
        historic,
        historicNotComputed,
      );

      const [areaSql] = getSqlCall(
        harness.statisticDepartementRepository.query,
        'WITH requested_zones AS',
      );
      expect(areaSql).toContain(`LEFT JOIN "${table}" zone`);
      expect(areaSql.includes('ST_TRANSFORM(zone.geom, 4326)')).toBe(
        transformsGeometry,
      );
    },
  );

  it('creates missing statistics and updates restrictions atomically', async () => {
    const selectedDepartements = [
      ...departements,
      { id: 31, code: '31', nom: 'Haute-Garonne' },
    ];
    const harness = createHarness({
      departements: selectedDepartements,
      existingStats: [{ id: 100, departement: { code: '65' } }],
    });

    await harness.service.computeDepartementStatisticsRestrictions(
      [],
      new Date('2023-06-01T00:00:00.000Z'),
    );

    expect(harness.statisticDepartementRepository.save).not.toHaveBeenCalled();
    const [updateSql, updateParameters] = getSqlCall(
      harness.statisticDepartementRepository.query,
      'WITH updates AS',
    );
    const updates = JSON.parse(updateParameters[0] as string);
    expect(updates.map((update) => update.departementId)).toEqual([65, 75, 31]);
    expect(updates[1].restriction.SOU).toEqual({
      vigilance: 0,
      alerte: 0,
      alerte_renforcee: 0,
      crise: 0,
    });
    expect(updateSql).toContain('inserted AS');
    expect(updateSql).toContain('ON CONFLICT ("departementId") DO NOTHING');
    expect(harness.statisticDepartementRepository.query).toHaveBeenCalledTimes(
      2,
    );
  });

  it('fails closed when the bulk update misses a department', async () => {
    const harness = createHarness({ updatedRowCount: 1 });

    await expect(
      harness.service.computeDepartementStatisticsRestrictions(
        [],
        new Date('2023-06-01T00:00:00.000Z'),
      ),
    ).rejects.toThrow(
      'Statistiques departementales incompletes: 1/2 mises a jour',
    );
  });

  it('fails closed before writing when a requested source zone is missing', async () => {
    const harness = createHarness({
      departements: [departements[0]],
      existingStats: [{ id: 100, departement: { code: '65' } }],
      areaRows: [
        {
          departementCode: '65',
          zoneType: 'SUP',
          gravityLevel: 'alerte',
          area: null,
          requestedZoneCount: 1,
          foundZoneCount: 0,
        },
      ],
    });

    await expect(
      harness.service.computeDepartementStatisticsRestrictions(
        [
          {
            id: 42,
            type: 'SUP',
            departement: { code: '65' },
            restriction: { niveauGravite: 'alerte' },
          },
        ] as any,
        new Date('2023-06-01T00:00:00.000Z'),
      ),
    ).rejects.toThrow(
      'Zones statistiques departementales invalides: 65:SUP:alerte',
    );

    expect(harness.statisticDepartementRepository.save).not.toHaveBeenCalled();
    expect(
      harness.statisticDepartementRepository.query.mock.calls.some(([sql]) =>
        String(sql).includes('WITH updates AS'),
      ),
    ).toBe(false);
  });
});
