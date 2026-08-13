import {
  applyOneOffSafetyFlags,
  parseMoment,
  parseOptions,
  runRecomputeCommuneStatistics,
  withHistoricRecomputeLock,
} from './recompute-commune-statistics';

describe('recompute-commune-statistics safeguards', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('parses, validates and normalizes the maintenance options', () => {
    expect(
      parseOptions(
        {
          DATES: '2026-06-20, 2026-03-28,2026-03-28',
          DATE_FROM: '2026-03-29',
          DATE_TO: '2026-03-30',
          DEP_CODES: '2b, 65,2B',
          RECOMPUTE_MONTHS: ' true ',
          SORT_AT_END: 'true',
          HISTORIC_RECOMPUTE_LOCK_TIMEOUT_MS: '120000',
          HISTORIC_RECOMPUTE_LOCK_RETRY_MS: '250',
        },
        parseMoment('2026-08-05'),
      ),
    ).toEqual({
      dates: ['2026-03-28', '2026-03-29', '2026-03-30', '2026-06-20'],
      departementCodes: ['2B', '65'],
      confirmNationalRecompute: false,
      publishThrough: null,
      publishLegacyRepair: false,
      recomputeMonths: true,
      sortAtEnd: true,
      historicLockTimeoutMs: 120000,
      historicLockRetryMs: 250,
      maxDates: 100,
    });
    expect(parseMoment('2026-03-28').toISOString()).toBe(
      '2026-03-28T00:00:00.000Z',
    );
  });

  it('rejects ambiguous or unsafe option values', () => {
    expect(() => parseOptions({ DATES: '2026-02-30' })).toThrow('Invalid date');
    expect(() => parseOptions({ DATE_FROM: '2026-03-28' })).toThrow(
      'DATE_FROM and DATE_TO must be set together',
    );
    expect(() =>
      parseOptions({ DATES: '2026-03-28', SORT_AT_END: 'yes' }),
    ).toThrow('Invalid SORT_AT_END');
    expect(() =>
      parseOptions({
        DATES: '2026-03-28',
        PUBLISH_LEGACY_REPAIR: 'yes',
      }),
    ).toThrow('Invalid PUBLISH_LEGACY_REPAIR');
    expect(() =>
      parseOptions({
        DATES: '2026-03-28',
        HISTORIC_RECOMPUTE_LOCK_TIMEOUT_MS: '0',
      }),
    ).toThrow('Invalid HISTORIC_RECOMPUTE_LOCK_TIMEOUT_MS');
    expect(() =>
      parseOptions({ DATES: '2026-08-06' }, parseMoment('2026-08-05')),
    ).toThrow('Future recomputation date is not allowed: 2026-08-06');
    expect(() =>
      parseOptions(
        { DATE_FROM: '2026-01-01', DATE_TO: '2026-04-11' },
        parseMoment('2026-08-05'),
      ),
    ).toThrow('Too many recomputation dates: 101/100');
    expect(
      parseOptions(
        {
          DATE_FROM: '2026-01-01',
          DATE_TO: '2026-04-11',
          HISTORIC_RECOMPUTE_MAX_DATES: '101',
          CONFIRM_NATIONAL_RECOMPUTE: 'true',
        },
        parseMoment('2026-08-05'),
      ).dates,
    ).toHaveLength(101);
    expect(() =>
      parseOptions({
        DATES: '2026-03-28',
        HISTORIC_RECOMPUTE_MAX_DATES: '3661',
      }),
    ).toThrow('Invalid HISTORIC_RECOMPUTE_MAX_DATES');
    expect(() =>
      parseOptions(
        {
          DATES: '2026-03-28',
          CONFIRM_NATIONAL_RECOMPUTE: 'true',
          RECOMPUTE_MONTHS: 'false',
        },
        parseMoment('2026-08-11'),
      ),
    ).toThrow('Statistic recomputation requires RECOMPUTE_MONTHS=true');
    expect(() =>
      parseOptions(
        {
          DATES: '2026-03-28',
          CONFIRM_NATIONAL_RECOMPUTE: 'true',
          SORT_AT_END: 'false',
        },
        parseMoment('2026-08-11'),
      ),
    ).toThrow('Statistic recomputation requires SORT_AT_END=true');
    expect(() =>
      parseOptions(
        {
          DATES: '2026-08-09',
          PUBLISH_THROUGH: '2026-08-10',
          CONFIRM_NATIONAL_RECOMPUTE: 'true',
        },
        parseMoment('2026-08-11'),
      ),
    ).toThrow('PUBLISH_THROUGH must be included in DATES');
    expect(() =>
      parseOptions(
        {
          DATES: '2026-08-10',
          DEP_CODES: '65',
          PUBLISH_THROUGH: '2026-08-10',
        },
        parseMoment('2026-08-11'),
      ),
    ).toThrow('PUBLISH_THROUGH requires a national recomputation');
    expect(() =>
      parseOptions(
        {
          DATES: '2026-08-10,2026-08-11',
          PUBLISH_THROUGH: '2026-08-10',
          CONFIRM_NATIONAL_RECOMPUTE: 'true',
        },
        parseMoment('2026-08-11'),
      ),
    ).toThrow('PUBLISH_THROUGH must be the last recomputation date');
    expect(() =>
      parseOptions(
        {
          DATES: '2026-08-10',
          DEP_CODES: '65',
          PUBLISH_LEGACY_REPAIR: 'true',
        },
        parseMoment('2026-08-11'),
      ),
    ).toThrow('PUBLISH_LEGACY_REPAIR requires a national recomputation');
    expect(() =>
      parseOptions(
        {
          DATES: '2026-08-10',
          PUBLISH_THROUGH: '2026-08-10',
          PUBLISH_LEGACY_REPAIR: 'true',
          CONFIRM_NATIONAL_RECOMPUTE: 'true',
        },
        parseMoment('2026-08-11'),
      ),
    ).toThrow('PUBLISH_LEGACY_REPAIR cannot be combined with PUBLISH_THROUGH');
  });

  it('accepts an explicit national publication target from the previous day', () => {
    expect(
      parseOptions(
        {
          DATES: '2026-08-09,2026-08-10',
          PUBLISH_THROUGH: '2026-08-10',
          CONFIRM_NATIONAL_RECOMPUTE: 'true',
        },
        parseMoment('2026-08-11'),
      ).publishThrough,
    ).toBe('2026-08-10');
  });

  it('only enables legacy repair publication when explicitly requested', () => {
    expect(
      parseOptions(
        {
          DATES: '2015-05-19',
          PUBLISH_LEGACY_REPAIR: 'true',
          CONFIRM_NATIONAL_RECOMPUTE: 'true',
        },
        parseMoment('2026-08-11'),
      ).publishLegacyRepair,
    ).toBe(true);
  });

  it('requires an explicit confirmation for a national recomputation', () => {
    expect(() =>
      parseOptions({ DATES: '2026-03-28' }, parseMoment('2026-08-05')),
    ).toThrow(
      'National recomputation requires CONFIRM_NATIONAL_RECOMPUTE=true',
    );

    expect(
      parseOptions(
        {
          DATES: '2026-03-28',
          CONFIRM_NATIONAL_RECOMPUTE: 'true',
        },
        parseMoment('2026-08-05'),
      ).confirmNationalRecompute,
    ).toBe(true);
  });

  it('uses the current Europe/Paris civil date for future-date validation', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T22:30:00.000Z'));

    expect(
      parseOptions({
        DATES: '2026-08-06',
        CONFIRM_NATIONAL_RECOMPUTE: 'true',
      }).dates,
    ).toEqual(['2026-08-06']);
  });

  it('rejects publication beyond the 02:00 Europe/Paris scheduler boundary', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-10T22:30:00.000Z'));
    const previousPublicationFlag = process.env.ZONE_PUBLICATION_ENABLED;
    process.env.ZONE_PUBLICATION_ENABLED = 'false';
    const dataSource = { query: jest.fn() };

    try {
      await expect(
        runRecomputeCommuneStatistics({ dataSource } as any, {
          dates: ['2026-08-11'],
          departementCodes: [],
          confirmNationalRecompute: true,
          publishThrough: '2026-08-11',
          publishLegacyRepair: false,
          recomputeMonths: true,
          sortAtEnd: true,
          historicLockTimeoutMs: 1000,
          historicLockRetryMs: 1,
          maxDates: 100,
        }),
      ).rejects.toThrow(
        'PUBLISH_THROUGH cannot exceed the scheduled civil date 2026-08-10',
      );
      expect(dataSource.query).not.toHaveBeenCalled();
    } finally {
      if (previousPublicationFlag === undefined) {
        delete process.env.ZONE_PUBLICATION_ENABLED;
      } else {
        process.env.ZONE_PUBLICATION_ENABLED = previousPublicationFlag;
      }
    }
  });

  it('rejects legacy watermark publication when versioned publication is enabled', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-11T10:00:00.000Z'));
    const previousPublicationFlag = process.env.ZONE_PUBLICATION_ENABLED;
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const dataSource = { query: jest.fn() };

    try {
      await expect(
        runRecomputeCommuneStatistics({ dataSource } as any, {
          dates: ['2026-08-10'],
          departementCodes: [],
          confirmNationalRecompute: true,
          publishThrough: '2026-08-10',
          publishLegacyRepair: false,
          recomputeMonths: true,
          sortAtEnd: true,
          historicLockTimeoutMs: 1000,
          historicLockRetryMs: 1,
          maxDates: 100,
        }),
      ).rejects.toThrow(
        'PUBLISH_THROUGH is only supported while ZONE_PUBLICATION_ENABLED=false',
      );
      expect(dataSource.query).not.toHaveBeenCalled();
    } finally {
      if (previousPublicationFlag === undefined) {
        delete process.env.ZONE_PUBLICATION_ENABLED;
      } else {
        process.env.ZONE_PUBLICATION_ENABLED = previousPublicationFlag;
      }
    }
  });

  it('rejects explicit legacy repair publication in versioned mode', async () => {
    const previousPublicationFlag = process.env.ZONE_PUBLICATION_ENABLED;
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const dataSource = { query: jest.fn() };

    try {
      await expect(
        runRecomputeCommuneStatistics({ dataSource } as any, {
          dates: ['2026-05-19'],
          departementCodes: [],
          confirmNationalRecompute: true,
          publishThrough: null,
          publishLegacyRepair: true,
          recomputeMonths: true,
          sortAtEnd: true,
          historicLockTimeoutMs: 1000,
          historicLockRetryMs: 1,
          maxDates: 100,
        }),
      ).rejects.toThrow(
        'PUBLISH_LEGACY_REPAIR is only supported while ZONE_PUBLICATION_ENABLED=false',
      );
      expect(dataSource.query).not.toHaveBeenCalled();
    } finally {
      if (previousPublicationFlag === undefined) {
        delete process.env.ZONE_PUBLICATION_ENABLED;
      } else {
        process.env.ZONE_PUBLICATION_ENABLED = previousPublicationFlag;
      }
    }
  });

  it('rejects legacy repair before any batch when the database publication is versioned', async () => {
    const previousPublicationFlag = process.env.ZONE_PUBLICATION_ENABLED;
    process.env.ZONE_PUBLICATION_ENABLED = 'false';
    const findAllLight = jest.fn();
    const dataSource = {
      query: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            currentPublishedDate: '2026-08-10',
            activePublicationId: '11111111-1111-1111-1111-111111111111',
          },
        ]),
    };

    try {
      await expect(
        runRecomputeCommuneStatistics(
          { dataSource, departementService: { findAllLight } } as any,
          {
            dates: ['2015-05-19'],
            departementCodes: [],
            confirmNationalRecompute: true,
            publishThrough: null,
            publishLegacyRepair: true,
            recomputeMonths: true,
            sortAtEnd: true,
            historicLockTimeoutMs: 1000,
            historicLockRetryMs: 1,
            maxDates: 100,
          },
        ),
      ).rejects.toThrow(
        'PUBLISH_LEGACY_REPAIR requires an active legacy publication context',
      );
      expect(findAllLight).not.toHaveBeenCalled();
    } finally {
      if (previousPublicationFlag === undefined) {
        delete process.env.ZONE_PUBLICATION_ENABLED;
      } else {
        process.env.ZONE_PUBLICATION_ENABLED = previousPublicationFlag;
      }
    }
  });

  it('rejects legacy repair before any batch when the target exceeds the watermark', async () => {
    const previousPublicationFlag = process.env.ZONE_PUBLICATION_ENABLED;
    process.env.ZONE_PUBLICATION_ENABLED = 'false';
    const findAllLight = jest.fn();
    const dataSource = {
      query: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            currentPublishedDate: '2015-05-18',
            activePublicationId: null,
          },
        ]),
    };

    try {
      await expect(
        runRecomputeCommuneStatistics(
          { dataSource, departementService: { findAllLight } } as any,
          {
            dates: ['2015-05-19'],
            departementCodes: [],
            confirmNationalRecompute: true,
            publishThrough: null,
            publishLegacyRepair: true,
            recomputeMonths: true,
            sortAtEnd: true,
            historicLockTimeoutMs: 1000,
            historicLockRetryMs: 1,
            maxDates: 100,
          },
        ),
      ).rejects.toThrow(
        'PUBLISH_LEGACY_REPAIR target 2015-05-19 exceeds current publication date 2015-05-18',
      );
      expect(findAllLight).not.toHaveBeenCalled();
    } finally {
      if (previousPublicationFlag === undefined) {
        delete process.env.ZONE_PUBLICATION_ENABLED;
      } else {
        process.env.ZONE_PUBLICATION_ENABLED = previousPublicationFlag;
      }
    }
  });

  it('sets all one-off process safeguards before application bootstrap', () => {
    const environment: NodeJS.ProcessEnv = {};

    applyOneOffSafetyFlags(environment);

    expect(environment).toMatchObject({
      DISABLE_SCHEDULED_JOBS: 'true',
      SKIP_SCHEMA_BOOTSTRAP: 'true',
      SKIP_STARTUP_DATA_LOADS: 'true',
      SKIP_STARTUP_DEPARTEMENT_STATISTICS: 'true',
      SANDRE_ZONE_SYNC_MODE: 'paused',
    });
    expect(environment.HISTORIC_DEPARTMENT_CHECKPOINT_ENABLED).toBeUndefined();
  });

  it('does not override an explicit checkpoint setting', () => {
    const environment: NodeJS.ProcessEnv = {
      HISTORIC_DEPARTMENT_CHECKPOINT_ENABLED: 'true',
    };

    applyOneOffSafetyFlags(environment);

    expect(environment.HISTORIC_DEPARTMENT_CHECKPOINT_ENABLED).toBe('true');
  });

  it('holds and releases the historic session lock around the whole task', async () => {
    const events: string[] = [];
    const queryRunner = {
      connect: jest.fn(async () => events.push('connect')),
      query: jest.fn(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) {
          events.push('lock');
          return [{ locked: true }];
        }
        events.push('unlock');
        return [{ unlocked: true }];
      }),
      release: jest.fn(async () => events.push('release')),
    };
    const dataSource = {
      createQueryRunner: jest.fn(() => queryRunner),
    };

    const result = await withHistoricRecomputeLock(
      dataSource as any,
      async () => {
        events.push('task');
        return 'done';
      },
      { timeoutMs: 1000, retryMs: 1 },
    );

    expect(result).toBe('done');
    expect(events).toEqual(['connect', 'lock', 'task', 'unlock', 'release']);
    expect(queryRunner.query.mock.calls[0][0]).toBe(
      "SELECT pg_try_advisory_lock(hashtext('vigieau'), hashtext('zone-compute-historic')) AS locked",
    );
    expect(queryRunner.query.mock.calls[1][0]).toBe(
      "SELECT pg_advisory_unlock(hashtext('vigieau'), hashtext('zone-compute-historic')) AS unlocked",
    );
  });

  it('releases the historic lock when recomputation fails', async () => {
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest
        .fn()
        .mockResolvedValueOnce([{ locked: true }])
        .mockResolvedValueOnce([{ unlocked: true }]),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = {
      createQueryRunner: jest.fn(() => queryRunner),
    };

    await expect(
      withHistoricRecomputeLock(
        dataSource as any,
        async () => {
          throw new Error('recompute failed');
        },
        { timeoutMs: 1000, retryMs: 1 },
      ),
    ).rejects.toThrow('recompute failed');
    expect(queryRunner.query).toHaveBeenCalledTimes(2);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('does not mask the business error when lock cleanup also fails', async () => {
    const cleanupError = new Error('unlock failed');
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest
        .fn()
        .mockResolvedValueOnce([{ locked: true }])
        .mockRejectedValueOnce(cleanupError),
      release: jest.fn().mockResolvedValue(undefined),
    };
    let caught: unknown;

    try {
      await withHistoricRecomputeLock(
        { createQueryRunner: () => queryRunner } as any,
        async () => {
          throw new Error('business failed');
        },
        { timeoutMs: 1000, retryMs: 1 },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('business failed');
    expect((caught as Error & { cause?: unknown }).cause).toBe(cleanupError);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('times out without running the task and always releases the connection', async () => {
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([{ locked: false }]),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = {
      createQueryRunner: jest.fn(() => queryRunner),
    };
    const task = jest.fn();

    await expect(
      withHistoricRecomputeLock(dataSource as any, task, {
        timeoutMs: 1,
        retryMs: 1,
      }),
    ).rejects.toThrow('Timed out waiting for the historic zone compute lock');
    expect(task).not.toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('reuses checkpoints only across contiguous dates and aggregates each snapshot month before certification', async () => {
    const computeZonesForDate = jest.fn().mockResolvedValue(undefined);
    const findZonesForStatistics = jest.fn().mockResolvedValue([{ id: 1 }]);
    const computeCommuneStatisticsRestrictions = jest.fn(
      async (...args: any[]) => {
        await args[5].beforeCommuneStatistics();
        await args[5].beforeCertification();
      },
    );
    const computeCommuneStatisticsRestrictionsByMonth = jest
      .fn()
      .mockResolvedValue(undefined);
    const sortStatCommune = jest.fn().mockResolvedValue(undefined);
    const computeDepartementStatisticsRestrictions = jest
      .fn()
      .mockResolvedValue(undefined);
    const sortStatDepartement = jest.fn().mockResolvedValue(undefined);
    const computeDepartementsSituation = jest.fn().mockResolvedValue(undefined);
    const statisticLockRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(async (sql: string) =>
        sql.includes('pg_try_advisory_lock')
          ? [{ locked: true }]
          : [{ unlocked: true }],
      ),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const dependencies = {
      departementService: {
        findAllLight: jest.fn().mockResolvedValue([
          { id: 1, code: '01' },
          { id: 2, code: '65' },
        ]),
      },
      historicService: {
        computeZonesForDate,
        findZonesForStatistics,
      },
      statisticCommuneService: {
        computeCommuneStatisticsRestrictions,
        computeCommuneStatisticsRestrictionsByMonth,
        sortStatCommune,
      },
      statisticDepartementService: {
        computeDepartementStatisticsRestrictions,
        sortStatDepartement,
      },
      statisticService: { computeDepartementsSituation },
      configService: {
        getConfig: jest.fn().mockResolvedValue({ historicComputeEpoch: '17' }),
      },
      zonePublicationService: {
        getSourceRevision: jest.fn().mockResolvedValue('42'),
      },
      dataSource: {
        query: jest.fn().mockResolvedValue([]),
        createQueryRunner: jest.fn(() => statisticLockRunner),
      } as any,
    };
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await runRecomputeCommuneStatistics(dependencies, {
      dates: ['2026-03-28', '2026-03-29', '2026-06-20'],
      departementCodes: [],
      confirmNationalRecompute: true,
      publishThrough: null,
      publishLegacyRepair: false,
      recomputeMonths: true,
      sortAtEnd: true,
      historicLockTimeoutMs: 1000,
      historicLockRetryMs: 1,
      maxDates: 100,
    });

    expect(computeZonesForDate).toHaveBeenCalledTimes(3);
    expect(computeZonesForDate.mock.calls.map((call) => call[2])).toEqual([
      {
        previousDate: null,
        historicComputeEpoch: '17',
        expectedSourceRevision: '42',
      },
      {
        previousDate: '2026-03-28',
        historicComputeEpoch: '17',
        expectedSourceRevision: '42',
      },
      {
        previousDate: null,
        historicComputeEpoch: '17',
        expectedSourceRevision: '42',
      },
    ]);
    expect(computeCommuneStatisticsRestrictions).toHaveBeenCalledTimes(3);
    expect(computeCommuneStatisticsRestrictions.mock.calls[0][5]).toEqual({
      beforeCommuneStatistics: expect.any(Function),
      beforeCertification: expect.any(Function),
      sourceRevision: '42',
      historicComputeEpoch: '17',
      preserveBootstrapBarrier: true,
      requireNationalCoverage: true,
      publishCurrentDate: false,
      bumpLegacyRevisionOnCompletion: false,
    });
    expect(
      computeCommuneStatisticsRestrictions.mock.calls.map(
        (call) => call[5].bumpLegacyRevisionOnCompletion,
      ),
    ).toEqual([false, false, false]);
    expect(computeDepartementStatisticsRestrictions).toHaveBeenCalledTimes(3);
    expect(
      computeDepartementStatisticsRestrictions.mock.calls[0].slice(1),
    ).toEqual([new Date('2026-03-28T00:00:00.000Z'), true, false, undefined]);
    expect(computeDepartementsSituation).toHaveBeenCalledTimes(3);
    expect(computeDepartementsSituation).toHaveBeenNthCalledWith(
      1,
      [{ id: 1 }],
      '2026-03-28',
      undefined,
    );
    expect(
      computeCommuneStatisticsRestrictions.mock.calls.map((call) =>
        call[1].toISOString().slice(0, 10),
      ),
    ).toEqual(['2026-03-28', '2026-03-29', '2026-06-20']);
    expect(
      computeCommuneStatisticsRestrictionsByMonth.mock.calls.map((call) =>
        call[0].toISOString().slice(0, 10),
      ),
    ).toEqual(['2026-03-28', '2026-03-29', '2026-06-20']);
    expect(
      computeCommuneStatisticsRestrictionsByMonth.mock.calls.every(
        (call) => call[2] === true,
      ),
    ).toBe(true);
    expect(sortStatCommune).toHaveBeenCalledTimes(1);
    expect(sortStatDepartement).toHaveBeenCalledTimes(1);
    expect(statisticLockRunner.query).not.toHaveBeenCalled();
    expect(statisticLockRunner.release).not.toHaveBeenCalled();
  });

  it('bumps the legacy publication revision only for an explicit repair', async () => {
    const previousPublicationFlag = process.env.ZONE_PUBLICATION_ENABLED;
    process.env.ZONE_PUBLICATION_ENABLED = 'false';
    const computeCommuneStatisticsRestrictions = jest
      .fn()
      .mockResolvedValue(undefined);
    const dependencies = {
      departementService: {
        findAllLight: jest.fn().mockResolvedValue([{ id: 1, code: '01' }]),
      },
      historicService: {
        computeZonesForDate: jest.fn().mockResolvedValue(undefined),
        findZonesForStatistics: jest.fn().mockResolvedValue([{ id: 1 }]),
      },
      statisticCommuneService: { computeCommuneStatisticsRestrictions },
      configService: {
        getConfig: jest.fn().mockResolvedValue({ historicComputeEpoch: '17' }),
      },
      zonePublicationService: {
        getSourceRevision: jest.fn().mockResolvedValue('42'),
      },
      dataSource: {
        query: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              currentPublishedDate: '2026-08-10',
              activePublicationId: null,
            },
          ]),
      },
    };
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await runRecomputeCommuneStatistics(dependencies as any, {
        dates: ['2015-05-19'],
        departementCodes: [],
        confirmNationalRecompute: true,
        publishThrough: null,
        publishLegacyRepair: true,
        recomputeMonths: true,
        sortAtEnd: true,
        historicLockTimeoutMs: 1000,
        historicLockRetryMs: 1,
        maxDates: 100,
      });
    } finally {
      if (previousPublicationFlag === undefined) {
        delete process.env.ZONE_PUBLICATION_ENABLED;
      } else {
        process.env.ZONE_PUBLICATION_ENABLED = previousPublicationFlag;
      }
    }

    expect(computeCommuneStatisticsRestrictions).toHaveBeenCalledTimes(1);
    expect(computeCommuneStatisticsRestrictions.mock.calls[0][5]).toMatchObject(
      {
        requireNationalCoverage: true,
        publishCurrentDate: false,
        bumpLegacyRevisionOnCompletion: true,
        sourceRevision: '42',
        historicComputeEpoch: '17',
      },
    );
  });

  it('repairs and publishes a previous-day target only after monthly aggregation and sorting', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-11T10:00:00.000Z'));
    const previousPublicationFlag = process.env.ZONE_PUBLICATION_ENABLED;
    process.env.ZONE_PUBLICATION_ENABLED = 'false';
    const events: string[] = [];
    let certificationHooks: any;
    const dependencies = {
      departementService: {
        findAllLight: jest.fn().mockResolvedValue([{ id: 1, code: '01' }]),
      },
      historicService: {
        computeZonesForDate: jest.fn().mockResolvedValue(undefined),
        findZonesForStatistics: jest.fn().mockResolvedValue([{ id: 1 }]),
      },
      statisticCommuneService: {
        computeCommuneStatisticsRestrictions: jest.fn(
          async (...args: any[]) => {
            certificationHooks = args[5];
            await args[5].beforeCommuneStatistics();
            await args[5].beforeCertification();
            events.push('certification');
          },
        ),
        computeCommuneStatisticsRestrictionsByMonth: jest.fn(async () => {
          events.push('monthly');
        }),
        sortStatCommune: jest.fn(async () => {
          events.push('sort-commune');
        }),
      },
      statisticDepartementService: {
        computeDepartementStatisticsRestrictions: jest
          .fn()
          .mockResolvedValue(undefined),
        sortStatDepartement: jest.fn(async () => {
          events.push('sort-departement');
        }),
      },
      statisticService: {
        computeDepartementsSituation: jest.fn(async () => {
          events.push('situation');
        }),
      },
      configService: {
        getConfig: jest.fn().mockResolvedValue({ historicComputeEpoch: '17' }),
      },
      zonePublicationService: {
        getSourceRevision: jest.fn().mockResolvedValue('42'),
      },
      dataSource: {
        query: jest.fn().mockResolvedValue([]),
        createQueryRunner: jest.fn(),
      } as any,
    };
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await runRecomputeCommuneStatistics(dependencies, {
        dates: ['2026-08-10'],
        departementCodes: [],
        confirmNationalRecompute: true,
        publishThrough: '2026-08-10',
        publishLegacyRepair: false,
        recomputeMonths: true,
        sortAtEnd: true,
        historicLockTimeoutMs: 1000,
        historicLockRetryMs: 1,
        maxDates: 100,
      });
    } finally {
      if (previousPublicationFlag === undefined) {
        delete process.env.ZONE_PUBLICATION_ENABLED;
      } else {
        process.env.ZONE_PUBLICATION_ENABLED = previousPublicationFlag;
      }
    }

    expect(events).toEqual([
      'monthly',
      'sort-commune',
      'sort-departement',
      'situation',
      'certification',
    ]);
    expect(certificationHooks).toMatchObject({
      requireNationalCoverage: true,
      publishCurrentDate: true,
      bumpLegacyRevisionOnCompletion: false,
      sourceRevision: '42',
      historicComputeEpoch: '17',
    });
    expect(
      dependencies.statisticCommuneService
        .computeCommuneStatisticsRestrictionsByMonth,
    ).toHaveBeenCalledWith(
      new Date('2026-08-10T00:00:00.000Z'),
      undefined,
      true,
    );
    expect(dependencies.dataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('aborts before certification when the source context changes', async () => {
    const getSourceRevision = jest
      .fn()
      .mockResolvedValueOnce('42')
      .mockResolvedValueOnce('42')
      .mockResolvedValueOnce('43');
    const computeCommuneStatisticsRestrictions = jest.fn(
      async (...args: any[]) => args[5].beforeCertification(),
    );
    const dependencies = {
      departementService: {
        findAllLight: jest.fn().mockResolvedValue([{ id: 1, code: '01' }]),
      },
      historicService: {
        computeZonesForDate: jest.fn().mockResolvedValue(undefined),
        findZonesForStatistics: jest.fn().mockResolvedValue([{ id: 1 }]),
      },
      statisticCommuneService: {
        computeCommuneStatisticsRestrictions,
        computeCommuneStatisticsRestrictionsByMonth: jest.fn(),
        sortStatCommune: jest.fn(),
      },
      statisticDepartementService: {
        computeDepartementStatisticsRestrictions: jest
          .fn()
          .mockResolvedValue(undefined),
        sortStatDepartement: jest.fn(),
      },
      statisticService: {
        computeDepartementsSituation: jest.fn().mockResolvedValue(undefined),
      },
      configService: {
        getConfig: jest.fn().mockResolvedValue({ historicComputeEpoch: '17' }),
      },
      zonePublicationService: { getSourceRevision },
      dataSource: {
        query: jest.fn().mockResolvedValue([]),
        createQueryRunner: jest.fn(),
      } as any,
    };
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      runRecomputeCommuneStatistics(dependencies, {
        dates: ['2026-03-28'],
        departementCodes: [],
        confirmNationalRecompute: true,
        publishThrough: null,
        publishLegacyRepair: false,
        recomputeMonths: true,
        sortAtEnd: true,
        historicLockTimeoutMs: 1000,
        historicLockRetryMs: 1,
        maxDates: 100,
      }),
    ).rejects.toThrow(
      'Zone publication source revision changed during recomputation (42 -> 43)',
    );
    expect(
      dependencies.statisticCommuneService
        .computeCommuneStatisticsRestrictionsByMonth,
    ).toHaveBeenCalledTimes(1);
    expect(
      dependencies.statisticCommuneService.sortStatCommune,
    ).not.toHaveBeenCalled();
  });

  it('aborts before certification when the historic epoch changes', async () => {
    const getConfig = jest
      .fn()
      .mockResolvedValueOnce({ historicComputeEpoch: '17' })
      .mockResolvedValueOnce({ historicComputeEpoch: '17' })
      .mockResolvedValueOnce({ historicComputeEpoch: '18' });
    const computeCommuneStatisticsRestrictions = jest.fn(
      async (...args: any[]) => args[5].beforeCertification(),
    );
    const dependencies = {
      departementService: {
        findAllLight: jest.fn().mockResolvedValue([{ id: 1, code: '01' }]),
      },
      historicService: {
        computeZonesForDate: jest.fn().mockResolvedValue(undefined),
        findZonesForStatistics: jest.fn().mockResolvedValue([{ id: 1 }]),
      },
      statisticCommuneService: {
        computeCommuneStatisticsRestrictions,
        computeCommuneStatisticsRestrictionsByMonth: jest.fn(),
        sortStatCommune: jest.fn(),
      },
      statisticDepartementService: {
        computeDepartementStatisticsRestrictions: jest
          .fn()
          .mockResolvedValue(undefined),
        sortStatDepartement: jest.fn(),
      },
      statisticService: {
        computeDepartementsSituation: jest.fn().mockResolvedValue(undefined),
      },
      configService: { getConfig },
      zonePublicationService: {
        getSourceRevision: jest.fn().mockResolvedValue('42'),
      },
      dataSource: {
        query: jest.fn().mockResolvedValue([]),
        createQueryRunner: jest.fn(),
      } as any,
    };
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      runRecomputeCommuneStatistics(dependencies, {
        dates: ['2026-03-28'],
        departementCodes: [],
        confirmNationalRecompute: true,
        publishThrough: null,
        publishLegacyRepair: false,
        recomputeMonths: true,
        sortAtEnd: true,
        historicLockTimeoutMs: 1000,
        historicLockRetryMs: 1,
        maxDates: 100,
      }),
    ).rejects.toThrow(
      'Historic compute epoch changed during recomputation (17 -> 18)',
    );
    expect(
      dependencies.statisticCommuneService
        .computeCommuneStatisticsRestrictionsByMonth,
    ).toHaveBeenCalledTimes(1);
    expect(
      dependencies.statisticCommuneService.sortStatCommune,
    ).not.toHaveBeenCalled();
  });

  it.each([
    {
      operation: 'monthly',
    },
    {
      operation: 'sort',
    },
  ])(
    'detects a source change after the $operation operation',
    async ({ operation }) => {
      let sourceRevisionReadCount = 0;
      const getSourceRevision = jest.fn(async () => {
        sourceRevisionReadCount += 1;
        const failingRead = operation === 'monthly' ? 3 : 4;
        return sourceRevisionReadCount === failingRead ? '43' : '42';
      });
      const monthly = jest.fn().mockResolvedValue(undefined);
      const sort = jest.fn().mockResolvedValue(undefined);
      const dependencies = {
        departementService: {
          findAllLight: jest.fn().mockResolvedValue([{ id: 1, code: '01' }]),
        },
        historicService: {
          computeZonesForDate: jest.fn().mockResolvedValue(undefined),
          findZonesForStatistics: jest.fn().mockResolvedValue([]),
        },
        statisticCommuneService: {
          computeCommuneStatisticsRestrictions: jest.fn(
            async (...args: any[]) => {
              await args[5].beforeCertification();
            },
          ),
          computeCommuneStatisticsRestrictionsByMonth: monthly,
          sortStatCommune: sort,
        },
        statisticDepartementService: {
          computeDepartementStatisticsRestrictions: jest
            .fn()
            .mockResolvedValue(undefined),
          sortStatDepartement: jest.fn().mockResolvedValue(undefined),
        },
        statisticService: {
          computeDepartementsSituation: jest.fn().mockResolvedValue(undefined),
        },
        configService: {
          getConfig: jest
            .fn()
            .mockResolvedValue({ historicComputeEpoch: '17' }),
        },
        zonePublicationService: { getSourceRevision },
        dataSource: {
          query: jest.fn().mockResolvedValue([]),
          createQueryRunner: jest.fn(),
        } as any,
      };
      jest.spyOn(console, 'log').mockImplementation(() => undefined);

      await expect(
        runRecomputeCommuneStatistics(dependencies, {
          dates: ['2026-03-28'],
          departementCodes: ['01'],
          confirmNationalRecompute: true,
          publishThrough: null,
          publishLegacyRepair: false,
          recomputeMonths: true,
          sortAtEnd: true,
          historicLockTimeoutMs: 1000,
          historicLockRetryMs: 1,
          maxDates: 100,
        }),
      ).rejects.toThrow(
        'Zone publication source revision changed during recomputation (42 -> 43)',
      );
      expect(monthly).toHaveBeenCalledTimes(1);
      expect(sort).toHaveBeenCalledTimes(operation === 'sort' ? 1 : 0);
      expect(dependencies.dataSource.createQueryRunner).not.toHaveBeenCalled();
    },
  );

  it('fails before any computation while the bootstrap barrier exists', async () => {
    const dependencies = {
      departementService: {
        findAllLight: jest.fn(),
      },
      historicService: {
        computeZonesForDate: jest.fn(),
        findZonesForStatistics: jest.fn(),
      },
      statisticCommuneService: {
        computeCommuneStatisticsRestrictions: jest.fn(),
        computeCommuneStatisticsRestrictionsByMonth: jest.fn(),
        sortStatCommune: jest.fn(),
      },
      statisticDepartementService: {
        computeDepartementStatisticsRestrictions: jest.fn(),
        sortStatDepartement: jest.fn(),
      },
      statisticService: {
        computeDepartementsSituation: jest.fn(),
      },
      configService: {
        getConfig: jest.fn(),
      },
      zonePublicationService: {
        getSourceRevision: jest.fn(),
      },
      dataSource: {
        query: jest
          .fn()
          .mockResolvedValue([
            { snapshotDate: '1970-01-01', status: 'failed' },
          ]),
        createQueryRunner: jest.fn(),
      } as any,
    };

    await expect(
      runRecomputeCommuneStatistics(dependencies, {
        dates: ['2026-03-28'],
        departementCodes: [],
        confirmNationalRecompute: true,
        publishThrough: null,
        publishLegacyRepair: false,
        recomputeMonths: true,
        sortAtEnd: true,
        historicLockTimeoutMs: 1000,
        historicLockRetryMs: 1,
        maxDates: 100,
      }),
    ).rejects.toThrow(
      'Targeted commune statistic recomputation is blocked until the bootstrap barrier is cleared by the normal historic chain',
    );

    expect(dependencies.departementService.findAllLight).not.toHaveBeenCalled();
    expect(
      dependencies.historicService.computeZonesForDate,
    ).not.toHaveBeenCalled();
    expect(
      dependencies.statisticCommuneService.computeCommuneStatisticsRestrictions,
    ).not.toHaveBeenCalled();
    expect(
      dependencies.statisticCommuneService
        .computeCommuneStatisticsRestrictionsByMonth,
    ).not.toHaveBeenCalled();
    expect(
      dependencies.statisticCommuneService.sortStatCommune,
    ).not.toHaveBeenCalled();
    expect(
      dependencies.statisticDepartementService
        .computeDepartementStatisticsRestrictions,
    ).not.toHaveBeenCalled();
    expect(
      dependencies.statisticService.computeDepartementsSituation,
    ).not.toHaveBeenCalled();
    expect(dependencies.configService.getConfig).not.toHaveBeenCalled();
    expect(
      dependencies.zonePublicationService.getSourceRevision,
    ).not.toHaveBeenCalled();
    expect(dependencies.dataSource.createQueryRunner).not.toHaveBeenCalled();
  });
});
