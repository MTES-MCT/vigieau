import {
  CURRENT_COMMUNE_STATISTICS_LOCK_WAIT_TIMEOUT_MS_DEFAULT,
  HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS_DEFAULT,
  parseCommuneStatisticsBatchSize,
  parseCurrentCommuneStatisticsLockWaitTimeoutMs,
  parseHistoricEmptyStatisticsRangeMaxDays,
  StatisticCommuneService,
} from './statistic_commune.service';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import moment = require('moment');

describe('StatisticCommuneService', () => {
  const previousBatchSize = process.env.COMMUNE_STATISTICS_BATCH_SIZE;
  const previousEmptyRangeMaxDays =
    process.env.HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS;
  const previousCurrentLockWaitTimeoutMs =
    process.env.CURRENT_COMMUNE_STATISTICS_LOCK_WAIT_TIMEOUT_MS;
  const previousPublicSourceRevisionEnabled =
    process.env.PUBLIC_SOURCE_REVISION_ENABLED;

  beforeEach(() => {
    delete process.env.COMMUNE_STATISTICS_BATCH_SIZE;
    delete process.env.HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS;
    delete process.env.CURRENT_COMMUNE_STATISTICS_LOCK_WAIT_TIMEOUT_MS;
    delete process.env.PUBLIC_SOURCE_REVISION_ENABLED;
  });

  afterAll(() => {
    if (previousBatchSize === undefined) {
      delete process.env.COMMUNE_STATISTICS_BATCH_SIZE;
    } else {
      process.env.COMMUNE_STATISTICS_BATCH_SIZE = previousBatchSize;
    }
    if (previousEmptyRangeMaxDays === undefined) {
      delete process.env.HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS;
    } else {
      process.env.HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS =
        previousEmptyRangeMaxDays;
    }
    if (previousCurrentLockWaitTimeoutMs === undefined) {
      delete process.env.CURRENT_COMMUNE_STATISTICS_LOCK_WAIT_TIMEOUT_MS;
    } else {
      process.env.CURRENT_COMMUNE_STATISTICS_LOCK_WAIT_TIMEOUT_MS =
        previousCurrentLockWaitTimeoutMs;
    }
    if (previousPublicSourceRevisionEnabled === undefined) {
      delete process.env.PUBLIC_SOURCE_REVISION_ENABLED;
    } else {
      process.env.PUBLIC_SOURCE_REVISION_ENABLED =
        previousPublicSourceRevisionEnabled;
    }
  });

  it.each([
    [undefined, 250],
    ['1', 1],
    ['250', 250],
    ['1000', 1000],
    [' 1000 ', 1000],
  ])('parses commune batch size %s as %i', (value, expected) => {
    expect(parseCommuneStatisticsBatchSize(value)).toBe(expected);
  });

  it.each(['', ' ', '0', '1001', '-1', '1.5', '1e3', 'invalid'])(
    'rejects invalid commune batch size %p',
    (value) => {
      expect(() => parseCommuneStatisticsBatchSize(value)).toThrow(
        'Invalid COMMUNE_STATISTICS_BATCH_SIZE',
      );
    },
  );

  it.each([
    [undefined, HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS_DEFAULT],
    ['', HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS_DEFAULT],
    ['1', 1],
    ['31', 31],
  ])('parses empty historic range bound %s as %i', (value, expected) => {
    expect(parseHistoricEmptyStatisticsRangeMaxDays(value)).toBe(expected);
  });

  it.each(['0', '-1', '1.5', '32', 'invalid'])(
    'rejects invalid empty historic range bound %p',
    (value) => {
      expect(() => parseHistoricEmptyStatisticsRangeMaxDays(value)).toThrow(
        'Invalid HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS',
      );
    },
  );

  it.each([
    [undefined, CURRENT_COMMUNE_STATISTICS_LOCK_WAIT_TIMEOUT_MS_DEFAULT],
    ['', CURRENT_COMMUNE_STATISTICS_LOCK_WAIT_TIMEOUT_MS_DEFAULT],
    ['1', 1],
    ['600000', 600_000],
    [' 1800000 ', 1_800_000],
  ])('parses current lock wait timeout %s as %i ms', (value, expected) => {
    expect(parseCurrentCommuneStatisticsLockWaitTimeoutMs(value)).toBe(
      expected,
    );
  });

  it.each(['0', '-1', '1.5', '1800001', 'invalid'])(
    'rejects invalid current lock wait timeout %p',
    (value) => {
      expect(() =>
        parseCurrentCommuneStatisticsLockWaitTimeoutMs(value),
      ).toThrow('Invalid CURRENT_COMMUNE_STATISTICS_LOCK_WAIT_TIMEOUT_MS');
    },
  );

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
      expect.stringContaining(
        '"snapshotDate" >= $1::date AND "snapshotDate" < $2::date',
      ),
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
      "restriction.value ->> 'date' >= :startDate::text",
    );
    expect(restrictionSelection).toContain(
      "restriction.value ->> 'date' < :endDate::text",
    );
    expect(harness.queryBuilder.where).toHaveBeenCalledWith(
      expect.stringContaining('snapshot."snapshotDate" >= :startDate::date'),
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

  it('sorts legacy daily and monthly arrays without casting malformed dates', async () => {
    const queryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    const repository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    const service = new StatisticCommuneService(
      repository as any,
      {} as any,
      {} as any,
    );

    await service.sortStatCommune(['65']);

    const dailySql = queryBuilder.set.mock.calls[0][0].restrictions();
    const monthlySql = queryBuilder.set.mock.calls[1][0].restrictionsByMonth();
    expect(dailySql).toContain("~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'");
    expect(dailySql).toContain('item.ordinality');
    expect(dailySql).not.toContain('::date');
    expect(monthlySql).toContain("~ '^[0-9]{4}-[0-9]{2}$'");
    expect(monthlySql).not.toContain('TO_DATE');
    expect(queryBuilder.andWhere).toHaveBeenCalledTimes(2);
    expect(queryBuilder.execute).toHaveBeenCalledTimes(2);
  });

  function createComputationHarness(options?: {
    failBatch?: boolean;
    updatedRows?: number;
    unchangedRows?: number;
    matchedRows?: number;
    nationalAlreadyCompleted?: boolean;
    snapshotAffectedRows?: number;
    snapshotCount?: number;
    snapshotStatus?: string;
    snapshotExpectedCommuneCount?: number;
    snapshotProcessedCommuneCount?: number;
    snapshotSourceRevision?: string;
    certificationContextCount?: number;
    actualSourceRevision?: string;
    actualHistoricComputeEpoch?: string;
    publicationContextCount?: number;
    legacyPublicationContextCount?: number;
    legacyRepairPublishedStateCount?: number;
    departementRestrictionCount?: number;
    departementSituationCount?: number;
    departementSituationKeyCount?: number;
    monthlyAffectedRows?: number;
    monthlyBlocked?: boolean;
    failNationalFinalization?: boolean;
    invalidZoneIds?: number[];
    loadedZoneCount?: number;
    lockAcquired?: boolean;
    blockingLock?: jest.Mock;
    communes?: Array<{
      id: number;
      departement: { id?: number; code: string };
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
        return [{ locked: options?.lockAcquired ?? true }];
      }
      if (sql.includes('pg_advisory_lock')) {
        events.push('lock');
        if (options?.blockingLock) {
          return options.blockingLock();
        }
        return [{ locked: true }];
      }
      if (sql.includes("set_config('statement_timeout'")) {
        return [{ set_config: params?.[0] }];
      }
      if (
        sql.includes('WITH current_context AS MATERIALIZED') &&
        sql.includes('target_dates AS MATERIALIZED') &&
        sql.includes('started AS')
      ) {
        events.push('range-running');
        return [
          {
            contextMatches: true,
            affected: (params?.[0] as unknown[]).length,
          },
        ];
      }
      if (sql.includes('FOR SHARE OF config, source_state')) {
        events.push('range-context');
        return [{ '?column?': 1 }];
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
        const updated = options?.updatedRows ?? payload.length;
        return [
          {
            updated,
            unchanged: options?.unchangedRows ?? payload.length - updated,
            matched: options?.matchedRows ?? payload.length,
          },
        ];
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
      if (sql.includes('WITH progressed AS')) {
        events.push('range-progress');
        return [{ affected: (params?.[0] as unknown[]).length }];
      }
      if (
        sql.includes('completed_snapshot AS') &&
        (sql.includes('SELECT COUNT(*)::integer AS affected') ||
          sql.includes('FROM completed_snapshot) AS affected'))
      ) {
        events.push(`scope-completed:${String(params?.[2])}`);
        return [
          {
            affected: options?.snapshotAffectedRows ?? 1,
            snapshotCount: options?.snapshotCount ?? 1,
            snapshotStatus: options?.snapshotStatus ?? 'running',
            snapshotExpectedCommuneCount:
              options?.snapshotExpectedCommuneCount ?? communes.length,
            snapshotProcessedCommuneCount:
              options?.snapshotProcessedCommuneCount ?? communes.length,
            snapshotSourceRevision: options?.snapshotSourceRevision ?? '42',
            contextCount: options?.certificationContextCount ?? 1,
            actualSourceRevision: options?.actualSourceRevision ?? '42',
            actualHistoricComputeEpoch:
              options?.actualHistoricComputeEpoch ?? '9',
            publicationContextCount: options?.publicationContextCount ?? 1,
            legacyPublicationContextCount:
              options?.legacyPublicationContextCount ?? 1,
            legacyRepairPublishedStateCount:
              options?.legacyRepairPublishedStateCount ?? 1,
            expectedDepartementCount: 101,
            departementRestrictionCount:
              options?.departementRestrictionCount ?? 101,
            departementSituationCount:
              options?.departementSituationCount ?? 101,
            departementSituationKeyCount:
              options?.departementSituationKeyCount ?? 101,
            publishedStateCount: 1,
          },
        ];
      }
      if (
        sql.includes('SET "status" = \'completed\'') &&
        sql.includes('WHERE "snapshotDate" = $1')
      ) {
        events.push('national-certified');
        if (options?.failNationalFinalization) {
          throw new Error('national finalization failed');
        }
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
    const queryRunner: any = {
      isTransactionActive: false,
      connect: jest.fn().mockResolvedValue(undefined),
      query,
      startTransaction: jest.fn(async () => {
        queryRunner.isTransactionActive = true;
      }),
      commitTransaction: jest.fn(async () => {
        queryRunner.isTransactionActive = false;
      }),
      rollbackTransaction: jest.fn(async () => {
        queryRunner.isTransactionActive = false;
      }),
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

  it('stages a stable historic interval in batches without snapshots or canonical JSONB writes', async () => {
    process.env.COMMUNE_STATISTICS_BATCH_SIZE = '1';
    const runId = '11111111-1111-4111-8111-111111111111';
    const inputSignature = 'a'.repeat(64);
    const sink = {
      writeSegments: jest.fn().mockResolvedValue(undefined),
    };
    const harness = createComputationHarness({
      communes: [
        {
          id: 77001,
          departement: { id: 77, code: '77' },
          statisticCommune: { id: 1, restrictions: [] },
        },
        {
          id: 77002,
          departement: { id: 77, code: '77' },
          statisticCommune: { id: 2, restrictions: [] },
        },
      ],
      intersections: [{ communeId: 77001, zoneId: 10 }],
    });
    const zones = [
      {
        id: 10,
        departement: { code: '77' },
        type: 'AEP',
        restriction: { niveauGravite: 'alerte' },
      },
    ] as any;

    await expect(
      harness.service.stageHistoricCommuneStatisticsRestrictions(
        zones,
        new Date('2025-07-13T00:00:00.000Z'),
        {
          runId,
          departementId: 77,
          departementCode: '77',
          sourceGeneration: '12',
          inputSignature,
          validThrough: '2025-07-15',
          sink,
        },
      ),
    ).resolves.toEqual({
      expectedCommuneCount: 2,
      processedCommuneCount: 2,
      segmentCount: 2,
    });

    expect(sink.writeSegments).toHaveBeenCalledTimes(2);
    expect(sink.writeSegments).toHaveBeenNthCalledWith(1, {
      runId,
      departementId: 77,
      departementCode: '77',
      computedFor: '2025-07-13',
      validThrough: '2025-07-15',
      sourceGeneration: '12',
      inputSignature,
      offset: 0,
      expectedCommuneCount: 2,
      processedCommuneCount: 1,
      segments: [
        {
          runId,
          departementId: 77,
          communeId: 77001,
          validFrom: '2025-07-13',
          validThrough: '2025-07-15',
          SOU: null,
          SUP: null,
          AEP: 'alerte',
          sourceGeneration: '12',
          inputSignature,
        },
      ],
    });
    expect(sink.writeSegments).toHaveBeenNthCalledWith(2, {
      runId,
      departementId: 77,
      departementCode: '77',
      computedFor: '2025-07-13',
      validThrough: '2025-07-15',
      sourceGeneration: '12',
      inputSignature,
      offset: 1,
      expectedCommuneCount: 2,
      processedCommuneCount: 2,
      segments: [
        {
          runId,
          departementId: 77,
          communeId: 77002,
          validFrom: '2025-07-13',
          validThrough: '2025-07-15',
          SOU: null,
          SUP: null,
          AEP: null,
          sourceGeneration: '12',
          inputSignature,
        },
      ],
    });
    expect(harness.communeService.count).toHaveBeenNthCalledWith(1, ['77']);
    expect(harness.communeService.count).toHaveBeenNthCalledWith(2, ['77']);
    expect(harness.communeService.findWithStats).toHaveBeenCalledWith(1, 0, [
      '77',
    ]);
    expect(harness.communeService.findWithStats).toHaveBeenCalledWith(1, 1, [
      '77',
    ]);
    const sql = harness.query.mock.calls.map(([statement]) =>
      String(statement),
    );
    expect(sql.join('\n')).toContain('"zone_alerte_computed_historic"');
    expect(sql.join('\n')).not.toContain('statistic_commune_snapshot');
    expect(sql.join('\n')).not.toContain('INSERT INTO "statistic_commune"');
    expect(sql.join('\n')).not.toContain('UPDATE "statistic_commune"');
    expect(sql.join('\n')).not.toContain('pg_advisory');
    expect(harness.queryRunner.startTransaction).not.toHaveBeenCalled();
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('excludes only the certified empty legacy geometry from staged commune intersections', async () => {
    const sink = {
      writeSegments: jest.fn().mockResolvedValue(undefined),
    };
    const harness = createComputationHarness({
      communes: [
        {
          id: 18001,
          departement: { id: 18, code: '18' },
          statisticCommune: { id: 1, restrictions: [] },
        },
      ],
      intersections: [{ communeId: 18001, zoneId: 10 }],
    });
    const warn = jest
      .spyOn((harness.service as any).logger, 'warn')
      .mockImplementation(() => undefined);
    const zones = [
      {
        id: 7626,
        departement: { code: '18' },
        type: 'SUP',
        restriction: { niveauGravite: 'crise' },
        geom: { type: 'MultiPolygon', coordinates: [] },
      },
      {
        id: 10,
        departement: { code: '18' },
        type: 'SUP',
        restriction: { niveauGravite: 'alerte' },
        geom: {
          type: 'MultiPolygon',
          coordinates: [
            [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
          ],
        },
      },
    ] as any;

    try {
      await harness.service.stageHistoricCommuneStatisticsRestrictions(
        zones,
        new Date('2022-06-18T00:00:00.000Z'),
        {
          runId: '11111111-1111-4111-8111-111111111111',
          departementId: 18,
          departementCode: '18',
          sourceGeneration: '12',
          inputSignature: 'a'.repeat(64),
          historicNotComputed: true,
          sink,
        },
      );

      const createTableCall = harness.query.mock.calls.find(([statement]) =>
        String(statement).includes('CREATE TEMP TABLE'),
      );
      expect(JSON.parse(String(createTableCall?.[1]?.[0]))).toEqual([
        { id: 10, departementCode: '18' },
      ]);
      expect(zones.map((zone) => zone.id)).toEqual([7626, 10]);
      expect(sink.writeSegments).toHaveBeenCalledWith(
        expect.objectContaining({
          segments: [
            expect.objectContaining({
              communeId: 18001,
              SUP: 'alerte',
            }),
          ],
        }),
      );
      expect(warn).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'legacy_historic_statistic_empty_geometries_excluded',
          runId: '11111111-1111-4111-8111-111111111111',
          computedFor: '2022-06-18',
          zoneIds: [7626],
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('stages null restrictions when the only legacy zone has the certified empty geometry', async () => {
    const sink = {
      writeSegments: jest.fn().mockResolvedValue(undefined),
    };
    const harness = createComputationHarness({
      communes: [
        {
          id: 18001,
          departement: { id: 18, code: '18' },
          statisticCommune: { id: 1, restrictions: [] },
        },
      ],
    });
    const warn = jest
      .spyOn((harness.service as any).logger, 'warn')
      .mockImplementation(() => undefined);

    try {
      await harness.service.stageHistoricCommuneStatisticsRestrictions(
        [
          {
            id: 7626,
            departement: { code: '18' },
            type: 'SUP',
            restriction: { niveauGravite: 'crise' },
            geom: { type: 'MultiPolygon', coordinates: [] },
          },
        ] as any,
        new Date('2022-06-18T00:00:00.000Z'),
        {
          runId: '11111111-1111-4111-8111-111111111111',
          departementId: 18,
          departementCode: '18',
          sourceGeneration: '12',
          inputSignature: 'a'.repeat(64),
          historicNotComputed: true,
          sink,
        },
      );

      expect(
        harness.query.mock.calls.some(([statement]) =>
          String(statement).includes('CREATE TEMP TABLE'),
        ),
      ).toBe(false);
      expect(
        harness.query.mock.calls.some(([statement]) =>
          String(statement).includes(
            'pg_temp."statistic_zone_geometry" valid_zones',
          ),
        ),
      ).toBe(false);
      expect(sink.writeSegments).toHaveBeenCalledWith(
        expect.objectContaining({
          segments: [
            expect.objectContaining({
              communeId: 18001,
              SOU: null,
              SUP: null,
              AEP: null,
            }),
          ],
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ['another legacy zone', 9, { type: 'MultiPolygon', coordinates: [] }, true],
    [
      'a different empty geometry type',
      7626,
      { type: 'Polygon', coordinates: [] },
      true,
    ],
    [
      'the computed historic path',
      7626,
      { type: 'MultiPolygon', coordinates: [] },
      false,
    ],
  ])(
    'keeps %s strict during staged geometry validation',
    async (_label, zoneId, geom, historicNotComputed) => {
      const harness = createComputationHarness({
        invalidZoneIds: [zoneId],
        communes: [
          {
            id: 18001,
            departement: { id: 18, code: '18' },
            statisticCommune: { id: 1, restrictions: [] },
          },
        ],
      });

      await expect(
        harness.service.stageHistoricCommuneStatisticsRestrictions(
          [
            {
              id: zoneId,
              departement: { code: '18' },
              type: 'SUP',
              restriction: { niveauGravite: 'crise' },
              geom,
            },
          ] as any,
          new Date('2022-06-18T00:00:00.000Z'),
          {
            runId: '11111111-1111-4111-8111-111111111111',
            departementId: 18,
            departementCode: '18',
            sourceGeneration: '12',
            inputSignature: 'a'.repeat(64),
            historicNotComputed,
            sink: { writeSegments: jest.fn() },
          },
        ),
      ).rejects.toThrow(
        `Geometries de zones statistiques invalides: ${zoneId}`,
      );

      const createTableCall = harness.query.mock.calls.find(([statement]) =>
        String(statement).includes('CREATE TEMP TABLE'),
      );
      expect(JSON.parse(String(createTableCall?.[1]?.[0]))).toEqual([
        { id: zoneId, departementCode: '18' },
      ]);
    },
  );

  it('allows independent departments to stage concurrently without a shared lock', async () => {
    const queryRunners = ['18', '65'].map(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([]),
      release: jest.fn().mockResolvedValue(undefined),
    }));
    const communeService = {
      count: jest.fn().mockResolvedValue(1),
      findWithStats: jest.fn(
        async (_take: number, _skip: number, codes: string[]) => {
          const code = codes[0];
          const departementId = code === '18' ? 18 : 65;
          return [
            {
              id: departementId * 1000 + 1,
              departement: { id: departementId, code },
              statisticCommune: null,
            },
          ];
        },
      ),
    };
    const dataSource = {
      createQueryRunner: jest
        .fn()
        .mockReturnValueOnce(queryRunners[0])
        .mockReturnValueOnce(queryRunners[1]),
    };
    const service = new StatisticCommuneService(
      { createQueryBuilder: jest.fn() } as any,
      communeService as any,
      dataSource as any,
    );
    let activeWrites = 0;
    let maxActiveWrites = 0;
    let releaseWrites: () => void;
    const bothWritesStarted = new Promise<void>((resolve) => {
      releaseWrites = resolve;
    });
    const sink = {
      writeSegments: jest.fn(async () => {
        activeWrites += 1;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        if (activeWrites === 2) {
          releaseWrites();
        }
        await bothWritesStarted;
        activeWrites -= 1;
      }),
    };
    const baseOptions = {
      sourceGeneration: '3',
      inputSignature: 'b'.repeat(64),
      sink,
    };

    await Promise.all([
      service.stageHistoricCommuneStatisticsRestrictions(
        [],
        new Date('2025-07-13T00:00:00.000Z'),
        {
          ...baseOptions,
          runId: '18181818-1818-4181-8181-181818181818',
          departementId: 18,
          departementCode: '18',
        },
      ),
      service.stageHistoricCommuneStatisticsRestrictions(
        [],
        new Date('2025-07-13T00:00:00.000Z'),
        {
          ...baseOptions,
          runId: '65656565-6565-4656-8656-656565656565',
          departementId: 65,
          departementCode: '65',
        },
      ),
    ]);

    expect(maxActiveWrites).toBe(2);
    expect(dataSource.createQueryRunner).toHaveBeenCalledTimes(2);
    for (const queryRunner of queryRunners) {
      expect(queryRunner.query).not.toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalledTimes(1);
    }
  });

  it('reduces historic segments into an idempotent daily and monthly shadow without I/O', () => {
    const dataSource = {
      createQueryRunner: jest.fn(),
      query: jest.fn(),
    };
    const service = new StatisticCommuneService(
      { createQueryBuilder: jest.fn() } as any,
      {} as any,
      dataSource as any,
    );
    const currentRestrictions = [
      { date: '2025-08-01', SOU: null, SUP: null, AEP: 'crise' },
      { date: '2025-07-02', SOU: null, SUP: null, AEP: 'crise' },
      { legacy: true },
      { date: '2025-07-01', SOU: null, SUP: null, AEP: 'vigilance' },
    ];
    const currentRestrictionsByMonth = [
      { date: '2025-08', ponderation: 4 },
      { date: '2025-07', ponderation: 99 },
      { legacyMonth: true },
    ];
    const originalDaily = JSON.parse(JSON.stringify(currentRestrictions));
    const originalMonthly = JSON.parse(
      JSON.stringify(currentRestrictionsByMonth),
    );
    const sharedSegment = {
      runId: '11111111-1111-4111-8111-111111111111',
      departementId: 77,
      communeId: 77001,
      SOU: null,
      SUP: null,
      AEP: 'alerte' as const,
      sourceGeneration: '12',
      inputSignature: 'c'.repeat(64),
    };
    const segments = [
      {
        ...sharedSegment,
        validFrom: '2025-07-02',
        validThrough: '2025-07-03',
      },
      {
        ...sharedSegment,
        validFrom: '2025-07-03',
        validThrough: '2025-07-03',
      },
    ];

    const first = service.reduceHistoricCommuneStatisticShadow({
      communeId: 77001,
      currentRestrictions,
      currentRestrictionsByMonth,
      segments,
    });
    const second = service.reduceHistoricCommuneStatisticShadow({
      communeId: 77001,
      currentRestrictions: first.nextRestrictions,
      currentRestrictionsByMonth: first.nextRestrictionsByMonth,
      segments,
    });

    expect(first).toEqual({
      communeId: 77001,
      nextRestrictions: [
        { date: '2025-07-01', SOU: null, SUP: null, AEP: 'vigilance' },
        { date: '2025-07-02', SOU: null, SUP: null, AEP: 'alerte' },
        { date: '2025-07-03', SOU: null, SUP: null, AEP: 'alerte' },
        { date: '2025-08-01', SOU: null, SUP: null, AEP: 'crise' },
        { legacy: true },
      ],
      nextRestrictionsByMonth: [
        { date: '2025-07', ponderation: 4.5 },
        { date: '2025-08', ponderation: 4 },
        { legacyMonth: true },
      ],
    });
    expect(second).toEqual(first);
    expect(currentRestrictions).toEqual(originalDaily);
    expect(currentRestrictionsByMonth).toEqual(originalMonthly);
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('rejects conflicting overlapping historic segments', () => {
    const service = new StatisticCommuneService(
      { createQueryBuilder: jest.fn() } as any,
      {} as any,
      {} as any,
    );
    const common = {
      runId: '11111111-1111-4111-8111-111111111111',
      departementId: 77,
      communeId: 77001,
      validThrough: '2025-07-13',
      SOU: null,
      SUP: null,
      sourceGeneration: '12',
      inputSignature: 'd'.repeat(64),
    };

    expect(() =>
      service.reduceHistoricCommuneStatisticShadow({
        communeId: 77001,
        segments: [
          {
            ...common,
            validFrom: '2025-07-12',
            AEP: 'alerte',
          },
          {
            ...common,
            validFrom: '2025-07-13',
            AEP: 'crise',
          },
        ],
      }),
    ).toThrow(
      'Conflicting historic statistic segments for commune 77001 on 2025-07-13',
    );
  });

  it.each([
    ['2025-07-13', '2025-07-12'],
    ['2025-07-13', '2025-7-14'],
    ['2025-02-01', '2025-02-30'],
  ])(
    'rejects invalid historic staging interval %s/%s before opening a connection',
    async (validFrom, validThrough) => {
      const harness = createComputationHarness();

      await expect(
        harness.service.stageHistoricCommuneStatisticsRestrictions(
          [],
          new Date(`${validFrom}T00:00:00.000Z`),
          {
            runId: '11111111-1111-4111-8111-111111111111',
            departementId: 18,
            departementCode: '18',
            sourceGeneration: '1',
            inputSignature: 'e'.repeat(64),
            validThrough,
            sink: { writeSegments: jest.fn() },
          },
        ),
      ).rejects.toThrow('Invalid historic statistic staging interval');
      expect(harness.dataSource.createQueryRunner).not.toHaveBeenCalled();
    },
  );

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

  it('queues a current computation until the shared snapshot lock is acquired', async () => {
    let releaseLock!: (value: Array<{ locked: boolean }>) => void;
    const blockingLock = jest.fn(
      () =>
        new Promise<Array<{ locked: boolean }>>((resolve) => {
          releaseLock = resolve;
        }),
    );
    const harness = createComputationHarness({ blockingLock });

    const computation = harness.service.computeCommuneStatisticsRestrictions(
      [],
      new Date('2025-07-13T00:00:00.000Z'),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(blockingLock).toHaveBeenCalledTimes(1);
    expect(harness.events).toEqual(['lock']);
    expect(harness.communeService.count).not.toHaveBeenCalled();
    const timeoutCall = harness.query.mock.calls.find(([sql]) =>
      String(sql).includes("set_config('statement_timeout'"),
    );
    expect(timeoutCall?.[1]).toEqual([
      `${CURRENT_COMMUNE_STATISTICS_LOCK_WAIT_TIMEOUT_MS_DEFAULT}ms`,
    ]);

    releaseLock([{ locked: true }]);
    await computation;

    expect(harness.events).toContain('running:national');
    expect(harness.queryRunner.commitTransaction).toHaveBeenCalled();
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('keeps historic computations fail-fast when the shared lock is busy', async () => {
    const harness = createComputationHarness({ lockAcquired: false });

    await expect(
      harness.service.computeCommuneStatisticsRestrictions(
        [],
        new Date('2025-07-13T00:00:00.000Z'),
        true,
      ),
    ).rejects.toThrow(
      'Un calcul des statistiques communales est deja en cours',
    );

    expect(
      harness.query.mock.calls.some(([sql]) =>
        String(sql).includes('pg_try_advisory_lock'),
      ),
    ).toBe(true);
    expect(
      harness.query.mock.calls.some(([sql]) =>
        String(sql).includes('SELECT pg_advisory_lock'),
      ),
    ).toBe(false);
    expect(harness.queryRunner.startTransaction).not.toHaveBeenCalled();
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('bounds current lock waiting and cleans up the acquisition transaction on timeout', async () => {
    const lockTimeout = Object.assign(
      new Error('canceling statement due to statement timeout'),
      { code: '57014' },
    );
    const blockingLock = jest.fn().mockRejectedValue(lockTimeout);
    const harness = createComputationHarness({ blockingLock });

    await expect(
      harness.service.computeCommuneStatisticsRestrictions(
        [],
        new Date('2025-07-13T00:00:00.000Z'),
      ),
    ).rejects.toThrow(
      `Delai maximal d'attente du calcul courant des statistiques communales atteint (${CURRENT_COMMUNE_STATISTICS_LOCK_WAIT_TIMEOUT_MS_DEFAULT} ms)`,
    );

    expect(harness.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(harness.queryRunner.isTransactionActive).toBe(false);
    expect(
      harness.query.mock.calls.some(([sql]) =>
        String(sql).includes('pg_advisory_unlock'),
      ),
    ).toBe(false);
    expect(harness.communeService.count).not.toHaveBeenCalled();
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('preserves the bootstrap barrier during a targeted recomputation', async () => {
    const harness = createComputationHarness();

    await harness.service.computeCommuneStatisticsRestrictions(
      [],
      new Date('2025-07-13T00:00:00.000Z'),
      true,
      false,
      undefined,
      { preserveBootstrapBarrier: true },
    );

    expect(harness.events).toContain('national-certified');
    expect(harness.events).not.toContain('bootstrap-cleared');
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

  it('processes commune statistics in configurable bounded set-based transactions', async () => {
    process.env.COMMUNE_STATISTICS_BATCH_SIZE = '1000';
    const communes = Array.from({ length: 2001 }, (_, index) => ({
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
      [1000, 0, undefined],
      [1000, 1000, undefined],
      [1000, 2000, undefined],
    ]);
    expect(
      harness.query.mock.calls
        .filter(([sql]) => String(sql).includes('WITH input AS MATERIALIZED'))
        .map(([, params]) => JSON.parse(String(params?.[0] ?? '[]')).length),
    ).toEqual([1000, 1000, 1]);
    expect(
      harness.events.filter((event) => event === 'commune-updated'),
    ).toHaveLength(3);
    expect(harness.queryRunner.startTransaction).toHaveBeenCalledTimes(5);
    expect(harness.queryRunner.commitTransaction).toHaveBeenCalledTimes(5);
    expect(harness.queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid batch size before starting the computation', async () => {
    process.env.COMMUNE_STATISTICS_BATCH_SIZE = '1001';
    const harness = createComputationHarness();

    await expect(
      harness.service.computeCommuneStatisticsRestrictions(
        [],
        new Date('2025-07-13T00:00:00.000Z'),
      ),
    ).rejects.toThrow('Invalid COMMUNE_STATISTICS_BATCH_SIZE');

    expect(harness.dataSource.createQueryRunner).not.toHaveBeenCalled();
    expect(harness.communeService.count).not.toHaveBeenCalled();
  });

  it('skips an identical JSONB write while advancing the snapshot', async () => {
    const harness = createComputationHarness({ updatedRows: 0 });

    await harness.service.computeCommuneStatisticsRestrictions(
      [],
      new Date('2025-07-13T00:00:00.000Z'),
    );

    const updateCall = harness.query.mock.calls.find(([sql]) =>
      String(sql).includes('WITH input AS MATERIALIZED'),
    );
    const updateSql = String(updateCall?.[0]);
    expect(updateSql).toContain('matched AS MATERIALIZED');
    expect(updateSql).toContain('candidate AS MATERIALIZED');
    expect(updateSql).toContain("item.value ->> 'date'");
    expect(updateSql).toContain('item.phase');
    expect(updateSql).toContain('matched."dateCount" = 1');
    expect(updateSql).toContain('matched."identicalCount" = 1');
    expect(updateSql).toContain(
      '(SELECT COUNT(*)::integer FROM matched) AS matched',
    );
    expect(updateSql).toContain('AS unchanged');
    expect(harness.queryRunner.commitTransaction).toHaveBeenCalledTimes(3);
    expect(
      harness.query.mock.calls.some(
        ([sql, params]) =>
          String(sql).includes('WITH progressed_snapshot AS') &&
          params?.[2] === 1,
      ),
    ).toBe(true);
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

  it('excludes the certified empty geometry only from legacy historic snapshot intersections', async () => {
    const harness = createComputationHarness();
    const warn = jest
      .spyOn((harness.service as any).logger, 'warn')
      .mockImplementation(() => undefined);

    try {
      await harness.service.computeCommuneStatisticsRestrictions(
        [
          {
            id: 7626,
            type: 'SUP',
            departement: { code: '18' },
            restriction: { niveauGravite: 'crise' },
            geom: { type: 'MultiPolygon', coordinates: [] },
          },
        ] as any,
        new Date('2022-06-18T00:00:00.000Z'),
        true,
        true,
      );

      expect(
        harness.query.mock.calls.some(([statement]) =>
          String(statement).includes('CREATE TEMP TABLE'),
        ),
      ).toBe(false);
      expect(
        harness.query.mock.calls.some(([statement]) =>
          String(statement).includes(
            'pg_temp."statistic_zone_geometry" valid_zones',
          ),
        ),
      ).toBe(false);
      const updateCall = harness.query.mock.calls.find(([statement]) =>
        String(statement).includes('WITH input AS'),
      );
      expect(JSON.parse(String(updateCall?.[1]?.[0]))).toEqual([
        {
          communeId: 1,
          restriction: {
            date: '2022-06-18',
            SOU: null,
            SUP: null,
            AEP: null,
          },
        },
      ]);
      expect(warn).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'legacy_historic_statistic_empty_geometries_excluded',
          computedFor: '2022-06-18',
          zoneIds: [7626],
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

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
    expect(harness.dataSource.query.mock.calls[0][0]).toContain(
      "sorted.value ->> 'date'",
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

  it('accepts an exact completed candidate without extending the ready bootstrap exemption', async () => {
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
    expect(sql).toContain(
      'snapshot."scope" = \'bootstrap\'\n                OR NOT EXISTS',
    );
    expect(sql).toContain('failed_national_snapshot."scope" = \'national\'');
    expect(sql).toContain('failed_national_snapshot."status" = \'failed\'');
    expect(sql).toContain(
      'failed_national_snapshot."sourceRevision" IS NOT NULL',
    );
    expect(sql).toContain(
      'failed_national_snapshot."snapshotDate" =\n                     (daily.value ->> \'date\')::date',
    );
    expect(sql).toContain('allowed_ready_snapshot AS MATERIALIZED');
    expect(sql).toContain('allowed_completed_snapshot AS MATERIALIZED');
    expect(sql).toContain('snapshot."status" = \'completed\'');
    expect(sql).toContain('snapshot."expectedCommuneCount" > 0');
    expect(sql).toContain(
      'snapshot."processedCommuneCount" =\n                  snapshot."expectedCommuneCount"',
    );
    expect(sql).toContain(
      'AND NOT EXISTS (SELECT 1 FROM allowed_ready_snapshot)',
    );
    expect(sql).toContain(
      'AND NOT EXISTS (SELECT 1 FROM allowed_completed_snapshot)',
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
        const completedExceptionMatches =
          candidate.status === 'completed' &&
          sql.includes('allowed_completed_snapshot AS MATERIALIZED') &&
          parameters[8] === candidate.sourceRevision &&
          parameters[9] === candidate.date;
        const bootstrapExceptionMatches =
          bootstrapPresent && readyExceptionMatches;
        if (
          (bootstrapPresent && !bootstrapExceptionMatches) ||
          (!readyExceptionMatches && !completedExceptionMatches)
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

  it('finalizes a ready legacy snapshot only in its guarded publication context', async () => {
    const harness = createComputationHarness();
    harness.query.mockResolvedValueOnce([
      {
        contextMatches: true,
        publicationContextMatches: true,
        readyCount: 1,
        alreadyPublishedCount: 0,
        completedCount: 1,
        completedSiblingCount: 2,
        clearedBootstrapCount: 1,
        publishedStateCount: 1,
        expectedDepartementCount: 101,
        departementRestrictionCount: 101,
        departementSituationCount: 101,
        departementSituationKeyCount: 101,
      },
    ]);

    await harness.service.finalizeLegacyCurrentPublication(
      new Date('2025-07-13T00:00:00.000Z'),
      '42',
      '9',
    );

    const [sql, parameters] = harness.query.mock.calls[0];
    expect(sql).toContain('snapshot."status" = \'ready\'');
    expect(sql).toContain('source_state."revision" = $2::bigint');
    expect(sql).toContain('config."historicComputeEpoch" = $3::bigint');
    expect(sql).toContain('coverage."expectedDepartementCount" = 101');
    expect(sql).toContain('snapshot."scope" <> \'bootstrap\'');
    expect(sql).toContain('"revision" = publication_state."revision" + 1');
    expect(parameters).toEqual(['2025-07-13', '42', '9']);
    expect(harness.queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(harness.queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('certifies the current snapshot against public revision 42 instead of technical revision 100', async () => {
    process.env.PUBLIC_SOURCE_REVISION_ENABLED = 'true';
    const harness = createComputationHarness();
    harness.query.mockResolvedValueOnce([
      {
        contextMatches: true,
        publicationContextMatches: true,
        readyCount: 1,
        alreadyPublishedCount: 0,
        completedCount: 1,
        completedSiblingCount: 2,
        clearedBootstrapCount: 1,
        publishedStateCount: 1,
        expectedDepartementCount: 101,
        departementRestrictionCount: 101,
        departementSituationCount: 101,
        departementSituationKeyCount: 101,
      },
    ]);

    await harness.service.finalizeLegacyCurrentPublication(
      new Date('2025-07-13T00:00:00.000Z'),
      '42',
      '9',
    );

    const [sql, parameters] = harness.query.mock.calls[0];
    expect(sql).toContain('source_state."publicRevision" = $2::bigint');
    expect(sql).not.toContain('source_state."revision" = $2::bigint');
    expect(parameters).toEqual(['2025-07-13', '42', '9']);
  });

  it('does not publish a legacy watermark after source context drift', async () => {
    const harness = createComputationHarness();
    harness.query.mockResolvedValueOnce([
      {
        contextMatches: false,
        publicationContextMatches: false,
        readyCount: 0,
        alreadyPublishedCount: 0,
        completedCount: 0,
        publishedStateCount: 0,
        expectedDepartementCount: 101,
        departementRestrictionCount: 101,
        departementSituationCount: 101,
        departementSituationKeyCount: 101,
      },
    ]);

    await expect(
      harness.service.finalizeLegacyCurrentPublication(
        new Date('2025-07-13T00:00:00.000Z'),
        '42',
        '9',
      ),
    ).rejects.toThrow(
      'Legacy statistic publication context changed for 2025-07-13',
    );

    const sql = String(harness.query.mock.calls[0][0]);
    expect(sql).toContain(
      'UPDATE "statistic_publication_state" publication_state',
    );
    expect(sql).toContain('FROM completed_snapshot, publication_context');
    expect(harness.queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(harness.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('publishes a fully covered legacy snapshot in the guarded completion statement', async () => {
    const harness = createComputationHarness();

    await harness.service.computeCommuneStatisticsRestrictions(
      [],
      new Date('2025-07-13T00:00:00.000Z'),
      undefined,
      undefined,
      undefined,
      {
        sourceRevision: '42',
        historicComputeEpoch: '9',
        requireNationalCoverage: true,
        publishCurrentDate: true,
        preserveBootstrapBarrier: true,
      },
    );

    const completionCall = harness.query.mock.calls.find(([sql]) =>
      String(sql).includes('national_coverage AS MATERIALIZED'),
    );
    expect(completionCall?.[0]).toContain(
      'coverage."expectedDepartementCount" = 101',
    );
    expect(completionCall?.[0]).toContain(
      'UPDATE "statistic_publication_state" statistic_state',
    );
    expect(completionCall?.[0]).toContain(
      '"revision" = statistic_state."revision" + 1',
    );
    expect(completionCall?.[0]).not.toContain(
      '"currentPublishedDate"\n                    IS DISTINCT FROM',
    );
    expect(completionCall?.[0]).toContain('"currentPublishedDate" = $1::date');
    expect(completionCall?.[0]).not.toContain('"historicDirtyFrom" =');
    expect(completionCall?.[0]).not.toContain('"historicDirtyThrough" =');
    expect(completionCall?.[1]).toEqual([
      '2025-07-13',
      'national',
      'completed',
      1,
      '42',
      '9',
    ]);
  });

  it('rejects overlapping current publication and legacy repair signals', async () => {
    const harness = createComputationHarness();

    await expect(
      harness.service.computeCommuneStatisticsRestrictions(
        [],
        new Date('2025-07-13T00:00:00.000Z'),
        undefined,
        undefined,
        undefined,
        {
          sourceRevision: '42',
          historicComputeEpoch: '9',
          requireNationalCoverage: true,
          publishCurrentDate: true,
          bumpLegacyRevisionOnCompletion: true,
        },
      ),
    ).rejects.toThrow(
      'La publication courante et le signal de reparation legacy sont mutuellement exclusifs',
    );
    expect(harness.events).toContain('failed');
  });

  it('fails certification when a requested legacy repair signal is not published', async () => {
    const harness = createComputationHarness({
      legacyRepairPublishedStateCount: 0,
    });

    await expect(
      harness.service.computeCommuneStatisticsRestrictions(
        [],
        new Date('2025-07-13T00:00:00.000Z'),
        true,
        false,
        undefined,
        {
          sourceRevision: '42',
          historicComputeEpoch: '9',
          requireNationalCoverage: true,
          bumpLegacyRevisionOnCompletion: true,
        },
      ),
    ).rejects.toThrow(
      "La reparation statistique legacy 2025-07-13 n'a pas actualise le filigrane",
    );
    expect(harness.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(harness.events).toContain('failed');
  });

  it('fails certification when the locked legacy publication context is absent', async () => {
    const harness = createComputationHarness({
      legacyPublicationContextCount: 0,
      legacyRepairPublishedStateCount: 0,
    });

    await expect(
      harness.service.computeCommuneStatisticsRestrictions(
        [],
        new Date('2025-07-13T00:00:00.000Z'),
        true,
        false,
        undefined,
        {
          sourceRevision: '42',
          historicComputeEpoch: '9',
          requireNationalCoverage: true,
          bumpLegacyRevisionOnCompletion: true,
        },
      ),
    ).rejects.toThrow(
      'Le contexte de publication legacy 2025-07-13 est indisponible',
    );
    const completionSql = harness.query.mock.calls.find(([sql]) =>
      String(sql).includes('legacy_publication_context AS MATERIALIZED'),
    )?.[0];
    expect(completionSql).toContain('FOR UPDATE OF zone_state');
    expect(completionSql).toContain(
      'FROM completed_snapshot, legacy_publication_context',
    );
    expect(harness.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(harness.events).toContain('failed');
  });

  it('rolls back legacy publication when finalizing the daily snapshots fails', async () => {
    const harness = createComputationHarness({
      failNationalFinalization: true,
    });

    await expect(
      harness.service.computeCommuneStatisticsRestrictions(
        [],
        new Date('2025-07-13T00:00:00.000Z'),
        undefined,
        undefined,
        undefined,
        {
          sourceRevision: '42',
          historicComputeEpoch: '9',
          requireNationalCoverage: true,
          publishCurrentDate: true,
          preserveBootstrapBarrier: true,
        },
      ),
    ).rejects.toThrow('national finalization failed');

    expect(harness.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(harness.queryRunner.commitTransaction).toHaveBeenCalledTimes(2);
    expect(harness.events).toEqual([
      'lock',
      'running:national',
      'commune-updated',
      'scope-completed:completed',
      'national-certified',
      'failed',
      'unlock',
    ]);
  });

  it('rejects legacy publication when one department aggregate is missing', async () => {
    const harness = createComputationHarness({
      departementRestrictionCount: 100,
      snapshotAffectedRows: 0,
    });

    await expect(
      harness.service.computeCommuneStatisticsRestrictions(
        [],
        new Date('2025-07-13T00:00:00.000Z'),
        undefined,
        undefined,
        undefined,
        {
          sourceRevision: '42',
          historicComputeEpoch: '9',
          requireNationalCoverage: true,
          publishCurrentDate: true,
        },
      ),
    ).rejects.toThrow(
      'Couverture statistique departementale incomplete pour 2025-07-13: 100/101 restrictions',
    );
    expect(harness.events).toContain('failed');
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

  it('fails the barrier when an input commune cannot be matched', async () => {
    const harness = createComputationHarness({
      updatedRows: 0,
      matchedRows: 0,
    });

    await expect(
      harness.service.computeCommuneStatisticsRestrictions(
        [],
        new Date('2025-07-13T00:00:00.000Z'),
      ),
    ).rejects.toThrow('Lot communal incomplet: 0/1 statistiques trouvees');

    expect(harness.events).toEqual([
      'lock',
      'running:national',
      'commune-updated',
      'failed',
      'unlock',
    ]);
    expect(harness.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(harness.queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('fails the barrier when a matched input is neither updated nor unchanged', async () => {
    const harness = createComputationHarness({
      updatedRows: 0,
      unchangedRows: 0,
      matchedRows: 1,
    });

    await expect(
      harness.service.computeCommuneStatisticsRestrictions(
        [],
        new Date('2025-07-13T00:00:00.000Z'),
      ),
    ).rejects.toThrow(
      'Lot communal incomplet: 0 mises a jour + 0 inchangees / 1 statistiques attendues',
    );

    expect(harness.events).toEqual([
      'lock',
      'running:national',
      'commune-updated',
      'failed',
      'unlock',
    ]);
    expect(
      harness.query.mock.calls.some(([sql]) =>
        String(sql).includes('WITH progressed_snapshot AS'),
      ),
    ).toBe(false);
    expect(harness.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(harness.queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('does not certify a snapshot whose completion transition affected no row', async () => {
    const harness = createComputationHarness({
      snapshotAffectedRows: 0,
      snapshotStatus: 'failed',
    });

    await expect(
      harness.service.computeCommuneStatisticsRestrictions(
        [],
        new Date('2025-07-13T00:00:00.000Z'),
      ),
    ).rejects.toThrow(
      'Le snapshot communal 2025-07-13 (national) a le statut failed au lieu de running',
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

  it('fails closed when the historic context changes after the certification hook', async () => {
    const harness = createComputationHarness({
      snapshotAffectedRows: 0,
      actualSourceRevision: '43',
    });

    await expect(
      harness.service.computeCommuneStatisticsRestrictions(
        [],
        new Date('2025-07-13T00:00:00.000Z'),
        true,
        false,
        undefined,
        {
          beforeCertification: async () => {
            harness.events.push('historic-context-changed');
          },
          sourceRevision: '42',
          historicComputeEpoch: '9',
        },
      ),
    ).rejects.toThrow('Historic source revision changed (42 -> 43)');

    const completionCall = harness.query.mock.calls.find(([sql]) =>
      String(sql).includes('current_context AS MATERIALIZED'),
    );
    expect(completionCall?.[0]).toContain('FOR SHARE OF source_state, config');
    expect(completionCall?.[0]).toContain(
      'target."sourceRevision" = $5::bigint',
    );
    expect(completionCall?.[0]).toContain(
      'current_context."sourceRevision" = $5::bigint',
    );
    expect(completionCall?.[0]).toContain(
      'current_context."historicComputeEpoch" = $6::bigint',
    );
    expect(completionCall?.[1]).toEqual([
      '2025-07-13',
      'national',
      'completed',
      1,
      '42',
      '9',
    ]);
    expect(harness.events).toEqual([
      'lock',
      'running:national',
      'commune-updated',
      'historic-context-changed',
      'scope-completed:completed',
      'failed',
      'unlock',
    ]);
    expect(harness.events).not.toContain('national-certified');
  });

  it('materializes a contiguous empty range once and certifies every date in order', async () => {
    const harness = createComputationHarness();
    const days = ['2025-07-13', '2025-07-14'].map((date) => ({
      date: new Date(`${date}T00:00:00.000Z`),
      beforeCommuneStatistics: async () => {
        harness.events.push(`department:${date}`);
      },
      beforeCertification: async () => {
        harness.events.push(`aggregate:${date}`);
      },
    }));

    await harness.service.computeEmptyHistoricCommuneStatisticsRange(days, {
      sourceRevision: '42',
      historicComputeEpoch: '9',
    });

    expect(harness.communeService.findWithStats).toHaveBeenCalledTimes(1);
    const rangeUpdateCalls = harness.query.mock.calls.filter(([sql]) =>
      String(sql).includes('candidate AS NOT MATERIALIZED'),
    );
    expect(rangeUpdateCalls).toHaveLength(1);
    expect(JSON.parse(String(rangeUpdateCalls[0][1]?.[1]))).toEqual([
      {
        date: '2025-07-13',
        restriction: {
          date: '2025-07-13',
          SOU: null,
          SUP: null,
          AEP: null,
        },
      },
      {
        date: '2025-07-14',
        restriction: {
          date: '2025-07-14',
          SOU: null,
          SUP: null,
          AEP: null,
        },
      },
    ]);
    expect(harness.events.indexOf('department:2025-07-14')).toBeLessThan(
      harness.events.indexOf('commune-updated'),
    );
    expect(harness.events.indexOf('commune-updated')).toBeLessThan(
      harness.events.indexOf('aggregate:2025-07-13'),
    );
    expect(harness.events.indexOf('aggregate:2025-07-13')).toBeLessThan(
      harness.events.indexOf('aggregate:2025-07-14'),
    );
    expect(
      harness.events.filter((event) =>
        event.startsWith('scope-completed:completed'),
      ),
    ).toHaveLength(2);
    expect(harness.queryRunner.startTransaction).toHaveBeenCalledTimes(3);
    expect(harness.queryRunner.commitTransaction).toHaveBeenCalledTimes(3);
    const guardedContextCall = harness.query.mock.calls.find(([sql]) =>
      String(sql).includes('FOR SHARE OF config, source_state'),
    );
    expect(guardedContextCall?.[0]).toContain(
      'config."historicComputeEpoch" = $1::bigint',
    );
    expect(guardedContextCall?.[0]).toContain(
      'source_state."revision" = $2::bigint',
    );
    expect(guardedContextCall?.[1]).toEqual(['9', '42']);
  });

  it('keeps empty-range JSONB traversals proportional to commune batches instead of days', async () => {
    process.env.COMMUNE_STATISTICS_BATCH_SIZE = '1000';
    process.env.HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS = '7';
    const communes = Array.from({ length: 2001 }, (_, index) => ({
      id: index + 1,
      departement: { code: '18' },
      statisticCommune: { id: index + 1000, restrictions: [] },
    }));
    const harness = createComputationHarness({ communes });
    const days = Array.from({ length: 7 }, (_, index) => ({
      date: new Date(
        moment.utc('2025-07-13').add(index, 'day').format('YYYY-MM-DD'),
      ),
    }));

    await harness.service.computeEmptyHistoricCommuneStatisticsRange(days, {
      sourceRevision: '42',
      historicComputeEpoch: '9',
    });

    const rangeUpdateCalls = harness.query.mock.calls.filter(([sql]) =>
      String(sql).includes('candidate AS NOT MATERIALIZED'),
    );
    expect(rangeUpdateCalls).toHaveLength(3);
    for (const [sql, parameters] of rangeUpdateCalls) {
      const statement = String(sql);
      expect(statement).toContain('matched AS MATERIALIZED');
      expect(statement).toContain('SELECT DISTINCT statistic.id');
      expect(statement).toContain('CROSS JOIN LATERAL');
      expect(statement).toContain('jsonb_agg(');
      expect(statement).not.toContain('ROW_NUMBER() OVER');
      expect(statement).not.toContain('expanded AS MATERIALIZED');
      expect(statement).not.toContain('existing_target_dates AS MATERIALIZED');
      expect(
        statement.match(
          /jsonb_array_elements\(\s*COALESCE\(statistic\."restrictions"/g,
        ),
      ).toHaveLength(1);
      expect(JSON.parse(String(parameters?.[1]))).toHaveLength(7);
    }
    expect(rangeUpdateCalls).toHaveLength(Math.ceil(2001 / 1000));
    expect(rangeUpdateCalls).not.toHaveLength(7 * Math.ceil(2001 / 1000));
  });

  it('fails every still-running range snapshot when guarded certification cannot complete', async () => {
    const harness = createComputationHarness({
      snapshotAffectedRows: 0,
      actualHistoricComputeEpoch: '10',
    });

    await expect(
      harness.service.computeEmptyHistoricCommuneStatisticsRange(
        [
          {
            date: new Date('2025-07-13T00:00:00.000Z'),
          },
          {
            date: new Date('2025-07-14T00:00:00.000Z'),
          },
        ],
        { sourceRevision: '42', historicComputeEpoch: '9' },
      ),
    ).rejects.toThrow('Historic compute epoch changed (9 -> 10)');

    expect(harness.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(harness.events).toContain('failed');
    const failedCall = harness.query.mock.calls.find(([sql]) =>
      String(sql).includes('AND "status" = \'running\''),
    );
    expect(failedCall?.[1]?.[0]).toEqual(['2025-07-13', '2025-07-14']);
  });

  it('rejects non-contiguous or oversized empty ranges before acquiring the lock', async () => {
    process.env.HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS = '2';
    const harness = createComputationHarness();
    const context = { sourceRevision: '42', historicComputeEpoch: '9' };

    await expect(
      harness.service.computeEmptyHistoricCommuneStatisticsRange(
        [
          { date: new Date('2025-07-13T00:00:00.000Z') },
          { date: new Date('2025-07-15T00:00:00.000Z') },
        ],
        context,
      ),
    ).rejects.toThrow('range is not contiguous');
    await expect(
      harness.service.computeEmptyHistoricCommuneStatisticsRange(
        [
          { date: new Date('2025-07-13T00:00:00.000Z') },
          { date: new Date('2025-07-14T00:00:00.000Z') },
          { date: new Date('2025-07-15T00:00:00.000Z') },
        ],
        context,
      ),
    ).rejects.toThrow('range length: 3/2');
    expect(harness.dataSource.createQueryRunner).not.toHaveBeenCalled();
  });
});
