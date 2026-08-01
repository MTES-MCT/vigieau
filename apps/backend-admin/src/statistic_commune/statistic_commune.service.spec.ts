import { StatisticCommuneService } from './statistic_commune.service';

describe('StatisticCommuneService', () => {
  function createStreamHarness(incompleteSnapshots: unknown[] = []) {
    const stream = {};
    const queryBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      stream: jest.fn().mockResolvedValue(stream),
    };
    const repository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    const dataSource = {
      query: jest.fn().mockResolvedValue(incompleteSnapshots),
    };
    const service = new StatisticCommuneService(
      repository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      dataSource as any,
    );
    return { service, repository, dataSource, queryBuilder, stream };
  }

  it('streams the complete commune history in a stable order behind the barrier', async () => {
    const harness = createStreamHarness();

    await expect(harness.service.getStatisticCommuneStream()).resolves.toBe(
      harness.stream,
    );

    expect(harness.queryBuilder.addSelect).toHaveBeenCalledWith(
      'sc.restrictions',
      'sc_restrictions',
    );
    expect(harness.queryBuilder.where).toHaveBeenCalledWith(
      expect.stringContaining("snapshot.status <> 'completed'"),
    );
    expect(harness.queryBuilder.orderBy).toHaveBeenCalledWith(
      'commune.code',
      'ASC',
    );
  });

  it('streams commune restrictions within complete requested year bounds', async () => {
    const harness = createStreamHarness();

    await expect(
      harness.service.getStatisticCommuneStreamForYear(2026),
    ).resolves.toBe(harness.stream);

    expect(harness.dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('"snapshotDate" >= $1'),
      ['2026-01-01', '2027-01-01'],
    );
    expect(harness.queryBuilder.setParameters).toHaveBeenCalledWith({
      startDate: '2026-01-01',
      endDate: '2027-01-01',
    });
    expect(harness.queryBuilder.where).toHaveBeenCalledWith(
      expect.stringContaining('snapshot."snapshotDate" >= :startDate'),
    );
    const restrictionSelection = harness.queryBuilder.addSelect.mock.calls.find(
      (call) => call[1] === 'sc_restrictions',
    )[0];
    expect(restrictionSelection).toContain(
      "restriction.value ->> 'date' >= :startDate",
    );
    expect(restrictionSelection).toContain(
      "restriction.value ->> 'date' < :endDate",
    );
  });

  it('rejects an export while a persisted snapshot is incomplete', async () => {
    const harness = createStreamHarness([
      {
        snapshotDate: '2026-08-01',
        scope: 'national',
        status: 'failed',
        processedCommuneCount: 1000,
        expectedCommuneCount: 34935,
      },
    ]);

    await expect(harness.service.getStatisticCommuneStream()).rejects.toThrow(
      'Snapshot communal 2026-08-01 non publie (national, failed, 1000/34935)',
    );
    expect(harness.repository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('blocks every annual export until the bootstrap barrier is cleared', async () => {
    const harness = createStreamHarness([
      {
        snapshotDate: '1970-01-01',
        scope: 'bootstrap',
        status: 'failed',
        processedCommuneCount: 0,
        expectedCommuneCount: 0,
      },
    ]);

    await expect(
      harness.service.getStatisticCommuneStreamForYear(2026),
    ).rejects.toThrow(
      'Snapshot communal 1970-01-01 non publie (bootstrap, failed, 0/0)',
    );
    expect(harness.repository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('rejects invalid statistic years before querying the database', async () => {
    const harness = createStreamHarness();

    await expect(
      harness.service.getStatisticCommuneStreamForYear(2026.5),
    ).rejects.toThrow('Invalid statistic year');
    expect(harness.dataSource.query).not.toHaveBeenCalled();
    expect(harness.repository.createQueryBuilder).not.toHaveBeenCalled();
  });

  function createComputationHarness(options?: {
    failBatch?: boolean;
    affectedRows?: number;
    nationalAlreadyCompleted?: boolean;
    snapshotAffectedRows?: number;
  }) {
    const events: string[] = [];
    const updateQueryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn(async () => {
        events.push('commune-updated');
        return { affected: options?.affectedRows ?? 1 };
      }),
    };
    const repository = {
      createQueryBuilder: jest.fn().mockReturnValue(updateQueryBuilder),
      save: jest.fn(),
    };
    const commune = {
      id: 1,
      departement: { code: '18' },
      statisticCommune: { id: 11, restrictions: [] },
    };
    const communeService = {
      count: jest.fn().mockResolvedValue(1),
      findWithStats: options?.failBatch
        ? jest.fn().mockRejectedValue(new Error('batch failed'))
        : jest.fn().mockResolvedValue([commune]),
    };
    const query = jest.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('pg_try_advisory_lock')) {
        events.push('lock');
        return [{ locked: true }];
      }
      if (sql.includes('"scope" = \'national\'') && sql.includes('SELECT 1')) {
        events.push('national-check');
        return options?.nationalAlreadyCompleted ? [{ '?column?': 1 }] : [];
      }
      if (sql.includes('INSERT INTO "statistic_commune_snapshot"')) {
        events.push(`running:${String(params?.[1])}`);
        return [];
      }
      if (
        sql.includes('WITH completed_snapshot AS') &&
        sql.includes('SELECT COUNT(*)::integer AS affected')
      ) {
        events.push(`scope-completed:${String(params?.[2])}`);
        return [{ affected: options?.snapshotAffectedRows ?? 1 }];
      }
      if (
        sql.includes('SET "status" = \'completed\'') &&
        sql.includes('WHERE "snapshotDate" = $1')
      ) {
        events.push('national-certified');
        return [];
      }
      if (
        sql.includes('DELETE FROM "statistic_commune_snapshot"') &&
        sql.includes('"scope" = \'bootstrap\'')
      ) {
        events.push('bootstrap-cleared');
        return [];
      }
      if (sql.includes('SET "status" = \'failed\'')) {
        events.push('failed');
        return [];
      }
      if (sql.includes('pg_advisory_unlock')) {
        events.push('unlock');
        return [{ unlocked: true }];
      }
      return [];
    });
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query,
      release: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    };
    const service = new StatisticCommuneService(
      repository as any,
      communeService as any,
      {
        getZonesIntersectedWithCommune: jest.fn(),
      } as any,
      {} as any,
      {} as any,
      dataSource as any,
    );
    return {
      service,
      communeService,
      query,
      queryRunner,
      events,
    };
  }

  it('certifies a national snapshot only after every commune', async () => {
    const harness = createComputationHarness();

    await harness.service.computeCommuneStatisticsRestrictions(
      [],
      new Date('2025-07-13T00:00:00.000Z'),
    );

    expect(harness.communeService.count).toHaveBeenCalledWith(undefined);
    expect(harness.communeService.findWithStats).toHaveBeenCalledWith(
      1000,
      0,
      undefined,
    );
    expect(harness.events).toEqual([
      'lock',
      'running:national',
      'commune-updated',
      'scope-completed:completed',
      'national-certified',
      'bootstrap-cleared',
      'unlock',
    ]);
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('keeps a department-only snapshot separate from national certification', async () => {
    const harness = createComputationHarness({
      nationalAlreadyCompleted: true,
    });

    await harness.service.computeCommuneStatisticsRestrictions(
      [],
      new Date('2025-07-13T00:00:00.000Z'),
      true,
      false,
      ['65'],
    );

    expect(harness.events).toEqual([
      'lock',
      'national-check',
      'running:departements:65',
      'commune-updated',
      'scope-completed:completed',
      'unlock',
    ]);
    expect(harness.events).not.toContain('national-certified');
  });

  it('does not certify a new date from a department-only snapshot', async () => {
    const harness = createComputationHarness();

    await harness.service.computeCommuneStatisticsRestrictions(
      [],
      new Date('2025-07-13T00:00:00.000Z'),
      true,
      false,
      ['65'],
    );

    expect(harness.events).toContain('scope-completed:partial');
    expect(harness.events).not.toContain('national-certified');
  });

  it('persists a failed barrier and never marks a partial batch complete', async () => {
    const harness = createComputationHarness({ failBatch: true });

    await expect(
      harness.service.computeCommuneStatisticsRestrictions(
        [],
        new Date('2025-07-13T00:00:00.000Z'),
      ),
    ).rejects.toThrow('batch failed');

    expect(harness.events).toEqual([
      'lock',
      'running:national',
      'failed',
      'unlock',
    ]);
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('fails the barrier when a commune update affects no row', async () => {
    const harness = createComputationHarness({ affectedRows: 0 });

    await expect(
      harness.service.computeCommuneStatisticsRestrictions(
        [],
        new Date('2025-07-13T00:00:00.000Z'),
      ),
    ).rejects.toThrow("La statistique de la commune 1 n'a pas ete mise a jour");

    expect(harness.events).toEqual([
      'lock',
      'running:national',
      'commune-updated',
      'failed',
      'unlock',
    ]);
  });

  it('does not certify a snapshot whose completion transition affected no row', async () => {
    const harness = createComputationHarness({ snapshotAffectedRows: 0 });

    await expect(
      harness.service.computeCommuneStatisticsRestrictions(
        [],
        new Date('2025-07-13T00:00:00.000Z'),
      ),
    ).rejects.toThrow(
      'Le snapshot communal 2025-07-13 ne couvre pas toutes les communes attendues',
    );

    expect(harness.events).toEqual([
      'lock',
      'running:national',
      'commune-updated',
      'scope-completed:completed',
      'failed',
      'unlock',
    ]);
    expect(harness.events).not.toContain('national-certified');
  });
});
