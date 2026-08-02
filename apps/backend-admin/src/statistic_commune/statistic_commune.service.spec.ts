import { StatisticCommuneService } from './statistic_commune.service';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import moment = require('moment');

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
    monthlyAffectedRows?: number;
    monthlyBlocked?: boolean;
    invalidZoneIds?: number[];
    loadedZoneCount?: number;
    communes?: Array<{
      id: number;
      departement: { code: string };
      statisticCommune: { id: number; restrictions: unknown[] };
    }>;
    intersections?: Array<{ communeId: number; zoneId: number }>;
  }) {
    const events: string[] = [];
    const repository = {
      createQueryBuilder: jest.fn(),
    };
    const communes = options?.communes ?? [
      {
        id: 1,
        departement: { code: '18' },
        statisticCommune: { id: 11, restrictions: [] },
      },
    ];
    const communeService = {
      count: jest.fn().mockResolvedValue(communes.length),
      findWithStats: options?.failBatch
        ? jest.fn().mockRejectedValue(new Error('batch failed'))
        : jest.fn(async (take: number, skip: number) =>
            communes.slice(skip, skip + take),
          ),
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
        sql.includes('WITH input AS') &&
        sql.includes('UPDATE "statistic_commune" statistic')
      ) {
        events.push('commune-updated');
        const payload = JSON.parse(String(params?.[0] ?? '[]'));
        return [{ affected: options?.affectedRows ?? payload.length }];
      }
      if (sql.includes('AS "loadedCount"')) {
        const payloadCall = query.mock.calls.find(([statement]) =>
          String(statement).includes('CREATE TEMP TABLE'),
        );
        const zones = JSON.parse(String(payloadCall?.[1]?.[0] ?? '[]'));
        return [
          {
            loadedCount: options?.loadedZoneCount ?? zones.length,
            invalidIds: options?.invalidZoneIds ?? [],
          },
        ];
      }
      if (sql.includes('pg_temp."statistic_zone_geometry" valid_zones')) {
        const communeIds = params?.[0] as number[];
        return (options?.intersections ?? []).filter((intersection) =>
          communeIds.includes(intersection.communeId),
        );
      }
      if (sql.includes('WITH progressed_snapshot AS')) {
        return [{ affected: 1 }];
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
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
      query: jest.fn(async (sql: string, _params?: unknown[]) => {
        void _params;
        if (sql.includes('selected_statistics AS MATERIALIZED')) {
          const expected = communes.filter(
            (commune) => commune.statisticCommune,
          ).length;
          return [
            {
              blocked: options?.monthlyBlocked ?? false,
              expected,
              affected: options?.monthlyAffectedRows ?? expected,
            },
          ];
        }
        return [];
      }),
    };
    const service = new StatisticCommuneService(
      repository as any,
      communeService as any,
      dataSource as any,
    );
    return {
      service,
      communeService,
      query,
      queryRunner,
      dataSource,
      events,
    };
  }

  it('certifies a national snapshot only after every commune', async () => {
    const harness = createComputationHarness();

    await harness.service.computeCommuneStatisticsRestrictions(
      [],
      new Date('2025-07-13T00:00:00.000Z'),
      undefined,
      undefined,
      undefined,
      {
        beforeCommuneStatistics: async () => {
          harness.events.push('department-updated');
        },
        beforeCertification: async () => {
          harness.events.push('aggregates-updated');
        },
      },
    );

    expect(harness.communeService.count).toHaveBeenCalledWith(undefined);
    expect(harness.communeService.findWithStats).toHaveBeenCalledWith(
      250,
      0,
      undefined,
    );
    expect(harness.events).toEqual([
      'lock',
      'running:national',
      'department-updated',
      'commune-updated',
      'aggregates-updated',
      'scope-completed:completed',
      'national-certified',
      'bootstrap-cleared',
      'unlock',
    ]);
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('keeps the barrier failed when a write before communes fails', async () => {
    const harness = createComputationHarness();

    await expect(
      harness.service.computeCommuneStatisticsRestrictions(
        [],
        new Date('2025-07-13T00:00:00.000Z'),
        undefined,
        undefined,
        undefined,
        {
          beforeCommuneStatistics: async () => {
            throw new Error('department failed');
          },
        },
      ),
    ).rejects.toThrow('department failed');

    expect(harness.events).toEqual([
      'lock',
      'running:national',
      'failed',
      'unlock',
    ]);
    expect(harness.communeService.findWithStats).not.toHaveBeenCalled();
  });

  it('processes commune statistics in bounded set-based transactions', async () => {
    const communes = Array.from({ length: 501 }, (_, index) => ({
      id: index + 1,
      departement: { code: '18' },
      statisticCommune: {
        id: index + 1000,
        restrictions: [],
      },
    }));
    const harness = createComputationHarness({ communes });

    await harness.service.computeCommuneStatisticsRestrictions(
      [],
      new Date('2025-07-13T00:00:00.000Z'),
    );

    expect(harness.communeService.findWithStats.mock.calls).toEqual([
      [250, 0, undefined],
      [250, 250, undefined],
      [250, 500, undefined],
    ]);
    expect(
      harness.events.filter((event) => event === 'commune-updated'),
    ).toHaveLength(3);
    expect(harness.queryRunner.startTransaction).toHaveBeenCalledTimes(3);
    expect(harness.queryRunner.commitTransaction).toHaveBeenCalledTimes(3);
    expect(harness.queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('keeps the severity rules while repairing only invalid legacy geometries', async () => {
    const harness = createComputationHarness({
      intersections: [
        { communeId: 1, zoneId: 10 },
        { communeId: 1, zoneId: 11 },
        { communeId: 1, zoneId: 12 },
        { communeId: 1, zoneId: 13 },
      ],
    });
    const zones = [
      {
        id: 10,
        type: 'SUP',
        departement: { code: '18' },
        restriction: { niveauGravite: 'vigilance' },
      },
      {
        id: 11,
        type: 'SUP',
        departement: { code: '18' },
        restriction: { niveauGravite: 'crise' },
      },
      {
        id: 12,
        type: 'SOU',
        departement: { code: '18' },
        restriction: { niveauGravite: 'alerte' },
      },
      {
        id: 13,
        type: 'AEP',
        departement: { code: '18' },
        restriction: { niveauGravite: 'alerte_renforcee' },
      },
    ] as any;

    await harness.service.computeCommuneStatisticsRestrictions(
      zones,
      new Date('2025-07-13T00:00:00.000Z'),
      true,
      true,
    );

    const spatialCall = harness.query.mock.calls.find(([sql]) =>
      String(sql).includes('CREATE TEMP TABLE'),
    );
    expect(spatialCall[0]).toContain('JOIN "zone_alerte" source_zone');
    expect(spatialCall[0]).toContain('ST_MakeValid');
    const intersectionCall = harness.query.mock.calls.find(([sql]) =>
      String(sql).includes('pg_temp."statistic_zone_geometry" valid_zones'),
    );
    expect(intersectionCall[0]).toContain('> 0.01');

    const updateCall = harness.query.mock.calls.find(([sql]) =>
      String(sql).includes('WITH input AS'),
    );
    expect(JSON.parse(String(updateCall[1][0]))).toEqual([
      {
        communeId: 1,
        restriction: {
          date: '2025-07-13',
          SOU: 'alerte',
          SUP: 'crise',
          AEP: 'alerte_renforcee',
        },
      },
    ]);
  });

  it.each([
    [false, false, 'zone_alerte_computed'],
    [true, false, 'zone_alerte_computed_historic'],
    [true, true, 'zone_alerte'],
  ])(
    'uses the expected spatial source for historic=%s legacy=%s',
    async (historic, historicNotComputed, table) => {
      const harness = createComputationHarness();
      await (harness.service as any).prepareStatisticZoneGeometryTable(
        harness.queryRunner,
        [{ id: 10, departementCode: '18' }],
        historic,
        historicNotComputed,
      );

      expect(harness.query).toHaveBeenCalledWith(
        expect.stringContaining(`JOIN "${table}" source_zone`),
        [JSON.stringify([{ id: 10, departementCode: '18' }])],
      );
    },
  );

  it('fails the snapshot when a requested zone geometry cannot be loaded', async () => {
    const harness = createComputationHarness({ invalidZoneIds: [10] });

    await expect(
      harness.service.computeCommuneStatisticsRestrictions(
        [
          {
            id: 10,
            type: 'SUP',
            departement: { code: '18' },
            restriction: { niveauGravite: 'alerte' },
          },
        ] as any,
        new Date('2025-07-13T00:00:00.000Z'),
      ),
    ).rejects.toThrow('Geometries de zones statistiques invalides: 10');

    expect(harness.events).toContain('failed');
    expect(harness.communeService.findWithStats).not.toHaveBeenCalled();
    expect(harness.query).toHaveBeenCalledWith(
      'DROP TABLE IF EXISTS pg_temp."statistic_zone_geometry"',
    );
  });

  it('computes monthly statistics in one atomic set-based query', async () => {
    const communes = Array.from({ length: 501 }, (_, index) => ({
      id: index + 1,
      departement: { code: '18' },
      statisticCommune: {
        id: index + 1000,
        restrictions: [],
      },
    }));
    const harness = createComputationHarness({ communes });

    await harness.service.computeCommuneStatisticsRestrictionsByMonth(
      new Date('2025-07-13T00:00:00.000Z'),
    );

    expect(harness.dataSource.query).toHaveBeenCalledTimes(1);
    expect(harness.dataSource.query.mock.calls[0][0]).toContain(
      'selected_statistics AS MATERIALIZED',
    );
    expect(harness.dataSource.query.mock.calls[0][0]).toContain(
      'LEFT JOIN LATERAL jsonb_array_elements',
    );
    expect(harness.dataSource.query.mock.calls[0][0]).toContain(
      'WHERE ($1::text[] IS NULL OR departement.code = ANY($1::text[]))',
    );
    expect(harness.dataSource.query.mock.calls[0][1]).toEqual([
      null,
      '2025-07',
      '2025-07-01',
      '2025-08-01',
      false,
      'national',
      '2025-07-13',
      null,
      null,
      null,
    ]);
    expect(harness.communeService.findWithStats).not.toHaveBeenCalled();
  });

  it('scopes an atomic monthly computation to unique departments', async () => {
    const harness = createComputationHarness();

    await harness.service.computeCommuneStatisticsRestrictionsByMonth(
      new Date('2025-07-13T00:00:00.000Z'),
      ['65', '31', '65'],
    );

    expect(harness.dataSource.query.mock.calls[0][1]).toEqual([
      ['65', '31'],
      '2025-07',
      '2025-07-01',
      '2025-08-01',
      false,
      'departements:31,65',
      '2025-07-13',
      null,
      null,
      null,
    ]);
  });

  it('only exempts the exact fully processed current snapshot', async () => {
    const harness = createComputationHarness();

    await harness.service.computeCommuneStatisticsRestrictionsByMonth(
      new Date('2025-07-02T00:00:00.000Z'),
      undefined,
      true,
    );

    const [sql, parameters] = harness.dataSource.query.mock.calls[0];
    expect(sql).toContain('current_snapshot_ready AS MATERIALIZED');
    expect(sql).toContain('snapshot."snapshotDate" = $7::date');
    expect(sql).toContain('snapshot."scope" = $6');
    expect(sql).toContain('snapshot."status" = \'running\'');
    expect(sql).toContain(
      'snapshot."processedCommuneCount" = snapshot."expectedCommuneCount"',
    );
    expect(sql).toContain('EXISTS (SELECT 1 FROM current_snapshot_ready)');
    expect(parameters).toEqual([
      null,
      '2025-07',
      '2025-07-01',
      '2025-08-01',
      true,
      'national',
      '2025-07-02',
      null,
      null,
      null,
    ]);
  });

  it('allows only bootstrap and the matching ready candidate while aggregating through J', async () => {
    const harness = createComputationHarness();

    await harness.service.computeCommuneStatisticsRestrictionsByMonth(
      new Date('2025-07-01T00:00:00.000Z'),
      undefined,
      false,
      '2025-07-12',
      { date: '2025-07-12', sourceRevision: '42' },
    );

    const [sql, parameters] = harness.dataSource.query.mock.calls[0];
    expect(sql).toContain('snapshot."snapshotDate" <= $8::date');
    expect(sql).toContain("(daily.value ->> 'date')::date <= $8::date");
    expect(sql).toContain('snapshot."snapshotDate" = $10::date');
    expect(sql).toContain('snapshot."scope" = \'national\'');
    expect(sql).toContain('snapshot."status" = \'ready\'');
    expect(sql).toContain('snapshot."sourceRevision" = $9::bigint');
    expect(sql).toContain('snapshot."scope" = \'bootstrap\'');
    expect(sql).toContain('allowed_ready_snapshot AS MATERIALIZED');
    expect(sql).toContain(
      'AND NOT EXISTS (SELECT 1 FROM allowed_ready_snapshot)',
    );
    expect(parameters).toEqual([
      null,
      '2025-07',
      '2025-07-01',
      '2025-08-01',
      false,
      'national',
      '2025-07-01',
      '2025-07-12',
      '42',
      '2025-07-12',
    ]);
  });

  it('keeps bootstrap and J hidden while preparing the month, then exposes it after activation', async () => {
    const candidate = {
      date: '2025-07-13',
      sourceRevision: '42',
      status: 'ready' as 'ready' | 'completed',
    };
    let bootstrapPresent = true;
    let candidateMonth: number | null = null;
    const dataSource = {
      query: jest.fn(async (sql: string, parameters: unknown[]) => {
        const readyExceptionMatches =
          candidate.status === 'ready' &&
          parameters[8] === candidate.sourceRevision &&
          parameters[9] === candidate.date;
        const bootstrapExceptionMatches =
          bootstrapPresent && readyExceptionMatches;
        if (
          (bootstrapPresent && !bootstrapExceptionMatches) ||
          (candidate.status !== 'completed' && !readyExceptionMatches)
        ) {
          return [{ blocked: true, expected: 0, affected: 0 }];
        }
        expect(sql).toContain("(daily.value ->> 'date')::date <= $8::date");
        expect(sql).toContain('snapshot."scope" = \'bootstrap\'');
        expect(sql).toContain('EXISTS (SELECT 1 FROM allowed_ready_snapshot)');
        expect(parameters[7]).toBe(candidate.date);
        candidateMonth = 7.5;
        return [{ blocked: false, expected: 1, affected: 1 }];
      }),
    };
    const service = new StatisticCommuneService(
      {} as any,
      {} as any,
      dataSource as any,
    );
    const readPublishedMonth = () =>
      !bootstrapPresent && candidate.status === 'completed'
        ? candidateMonth
        : null;

    expect(readPublishedMonth()).toBeNull();
    await service.computeCommuneStatisticsRestrictionsByMonth(
      new Date('2025-07-01T00:00:00.000Z'),
      undefined,
      false,
      candidate.date,
      {
        date: candidate.date,
        sourceRevision: candidate.sourceRevision,
      },
    );
    expect(candidateMonth).toBe(7.5);
    expect(readPublishedMonth()).toBeNull();

    // Candidate activation completes J and removes the bootstrap barrier atomically.
    candidate.status = 'completed';
    bootstrapPresent = false;
    expect(readPublishedMonth()).toBe(7.5);
  });

  it.each([
    ['missing', null],
    [
      'source mismatch',
      { date: '2025-07-13', sourceRevision: '41', status: 'ready' },
    ],
    [
      'date mismatch',
      { date: '2025-07-12', sourceRevision: '42', status: 'ready' },
    ],
  ])(
    'blocks the monthly candidate when its exact ready snapshot is %s',
    async (_caseName, persistedCandidate) => {
      const expectedCandidate = {
        date: '2025-07-13',
        sourceRevision: '42',
      };
      const dataSource = {
        query: jest.fn(async (sql: string, parameters: unknown[]) => {
          expect(sql).toContain('allowed_ready_snapshot AS MATERIALIZED');
          expect(sql).toContain(
            'AND NOT EXISTS (SELECT 1 FROM allowed_ready_snapshot)',
          );
          const exactReadySnapshotExists =
            persistedCandidate?.status === 'ready' &&
            persistedCandidate.date === parameters[9] &&
            persistedCandidate.sourceRevision === parameters[8];
          return [
            {
              blocked: !exactReadySnapshotExists,
              expected: 0,
              affected: 0,
            },
          ];
        }),
      };
      const service = new StatisticCommuneService(
        {} as any,
        {} as any,
        dataSource as any,
      );

      await expect(
        service.computeCommuneStatisticsRestrictionsByMonth(
          new Date('2025-07-01T00:00:00.000Z'),
          undefined,
          false,
          expectedCandidate.date,
          expectedCandidate,
        ),
      ).rejects.toThrow('Calcul mensuel communal bloque pour 2025-07');
    },
  );

  it('recomputes every touched month up to an explicit historic bound', async () => {
    const harness = createComputationHarness();
    const computeMonth = jest
      .spyOn(harness.service, 'computeCommuneStatisticsRestrictionsByMonth')
      .mockResolvedValue(undefined);

    await harness.service.computeByMonth(
      moment('2025-07-31', 'YYYY-MM-DD'),
      undefined,
      {
        aggregateThrough: moment('2025-08-02', 'YYYY-MM-DD'),
        allowedReadySnapshot: {
          date: '2025-08-02',
          sourceRevision: '42',
        },
      },
    );

    expect(computeMonth.mock.calls).toEqual([
      [
        new Date('2025-07-01T00:00:00.000Z'),
        undefined,
        false,
        '2025-08-02',
        { date: '2025-08-02', sourceRevision: '42' },
      ],
      [
        new Date('2025-08-01T00:00:00.000Z'),
        undefined,
        false,
        '2025-08-02',
        { date: '2025-08-02', sourceRevision: '42' },
      ],
    ]);
  });

  it('rejects a ready-snapshot exemption outside the aggregate bound', async () => {
    const harness = createComputationHarness();

    await expect(
      harness.service.computeCommuneStatisticsRestrictionsByMonth(
        new Date('2025-07-01T00:00:00.000Z'),
        undefined,
        false,
        '2025-07-12',
        { date: '2025-07-13', sourceRevision: '42' },
      ),
    ).rejects.toThrow('Invalid allowed ready monthly snapshot');

    expect(harness.dataSource.query).not.toHaveBeenCalled();
  });

  it('rejects an incomplete monthly bulk update', async () => {
    const harness = createComputationHarness({ monthlyAffectedRows: 0 });

    await expect(
      harness.service.computeCommuneStatisticsRestrictionsByMonth(
        new Date('2025-07-13T00:00:00.000Z'),
      ),
    ).rejects.toThrow(
      'Calcul mensuel communal incomplet: 0/1 statistiques mises a jour',
    );
  });

  it('does not aggregate a month containing an incomplete snapshot', async () => {
    const harness = createComputationHarness({ monthlyBlocked: true });

    await expect(
      harness.service.computeCommuneStatisticsRestrictionsByMonth(
        new Date('2025-07-13T00:00:00.000Z'),
      ),
    ).rejects.toThrow('Calcul mensuel communal bloque pour 2025-07');
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

  it('keeps a current national snapshot ready until map activation', async () => {
    const harness = createComputationHarness();

    await harness.service.computeCommuneStatisticsRestrictions(
      [],
      new Date('2025-07-13T00:00:00.000Z'),
      undefined,
      undefined,
      undefined,
      {
        deferCertificationUntilPublication: true,
        sourceRevision: '42',
      },
    );

    expect(harness.events).toEqual([
      'lock',
      'running:national',
      'commune-updated',
      'scope-completed:ready',
      'unlock',
    ]);
    expect(harness.events).not.toContain('national-certified');
    const runningCall = harness.query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO "statistic_commune_snapshot"'),
    );
    expect(runningCall?.[1]).toEqual(['2025-07-13', 'national', 1, '42']);
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
    ).rejects.toThrow('Lot communal incomplet: 0/1 statistiques mises a jour');

    expect(harness.events).toEqual([
      'lock',
      'running:national',
      'commune-updated',
      'failed',
      'unlock',
    ]);
    expect(harness.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(harness.queryRunner.commitTransaction).not.toHaveBeenCalled();
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
