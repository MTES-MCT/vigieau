import { EventEmitter } from 'node:events';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'worker_threads';
import moment from 'moment';
import {
  HISTORIC_COMPUTE_CHUNK_DAYS_DEFAULT,
  HISTORIC_COMPUTE_WORKER_TIMEOUT_MS,
  ZONE_COMPUTE_WORKER_TIMEOUT_MS,
  readHistoricComputeChunkDays,
  ZoneAlerteComputedService,
} from './zone_alerte_computed.service';
import {
  HISTORIC_DEPARTMENT_CONCURRENCY_DEFAULT,
  HISTORIC_DEPARTMENT_CONCURRENCY_MAX,
  readHistoricDepartmentConcurrency,
  readHistoricSkipCommuneIntersections,
  withHistoricArtifactCleanup,
  ZoneAlerteComputedHistoricService,
} from './zone_alerte_computed_historic.service';

jest.mock('worker_threads', () => ({
  ...jest.requireActual('worker_threads'),
  Worker: jest.fn(),
}));

jest.mock('moment', () => {
  const momentModule = jest.requireActual('moment');
  return {
    __esModule: true,
    default: momentModule,
  };
});

describe('ZoneAlerteComputedService', () => {
  let service: ZoneAlerteComputedService;
  let configService: { getConfig: jest.Mock; setConfig: jest.Mock };
  let statisticCommuneService: { computeByMonth: jest.Mock };
  let zonePublicationService: {
    buildCandidateFromCurrentComputed: jest.Mock;
    findReusableDailyPublication: jest.Mock;
    getSourceRevision: jest.Mock;
    isRecomputeRequired: jest.Mock;
    promoteCertifiedPublicationIfAvailable: jest.Mock;
  };
  let preflightQueryRunner: {
    connect: jest.Mock;
    query: jest.Mock;
    release: jest.Mock;
  };
  let dataSource: { createQueryRunner: jest.Mock; query: jest.Mock };
  const previousPublicationEnabled = process.env.ZONE_PUBLICATION_ENABLED;
  const previousHistoricChunkDays = process.env.HISTORIC_COMPUTE_CHUNK_DAYS;

  beforeEach(() => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    process.env.HISTORIC_COMPUTE_CHUNK_DAYS = '3000';
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-06-23T12:00:00Z'));

    configService = {
      getConfig: jest.fn(),
      setConfig: jest.fn().mockResolvedValue(undefined),
    };
    statisticCommuneService = {
      computeByMonth: jest.fn().mockResolvedValue(undefined),
    };
    zonePublicationService = {
      buildCandidateFromCurrentComputed: jest.fn().mockResolvedValue(undefined),
      findReusableDailyPublication: jest.fn().mockResolvedValue(null),
      getSourceRevision: jest.fn().mockResolvedValue('1'),
      isRecomputeRequired: jest.fn().mockResolvedValue(false),
      promoteCertifiedPublicationIfAvailable: jest
        .fn()
        .mockResolvedValue(false),
    };
    preflightQueryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(async (sql: string) =>
        sql.includes('pg_try_advisory_lock')
          ? [{ locked: true }]
          : [{ unlocked: true }],
      ),
      release: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(preflightQueryRunner),
      query: jest.fn(async (sql: string) =>
        sql.includes('EXISTS(SELECT 1 FROM published)')
          ? [
              {
                published: true,
                incompleteDate: null,
                currentSourceRevision: '1',
              },
            ]
          : [],
      ),
    };

    service = new ZoneAlerteComputedService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      statisticCommuneService as any,
      {} as any,
      dataSource as any,
      configService as any,
      zonePublicationService as any,
    );
    (service as any).runHistoricWorker = jest
      .fn()
      .mockImplementation(async (...args: unknown[]) => ({
        mapCursor: args[8],
        statsCursor: args[8],
        mapGeneration: '370',
        statsGeneration: '371',
      }));
    (service as any).assertCurrentHistoricCursorState = jest
      .fn()
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    if (previousPublicationEnabled === undefined) {
      delete process.env.ZONE_PUBLICATION_ENABLED;
    } else {
      process.env.ZONE_PUBLICATION_ENABLED = previousPublicationEnabled;
    }
    if (previousHistoricChunkDays === undefined) {
      delete process.env.HISTORIC_COMPUTE_CHUNK_DAYS;
    } else {
      process.env.HISTORIC_COMPUTE_CHUNK_DAYS = previousHistoricChunkDays;
    }
  });

  it('uses a conservative historic chunk default and rejects invalid overrides', () => {
    expect(readHistoricComputeChunkDays('')).toBe(
      HISTORIC_COMPUTE_CHUNK_DAYS_DEFAULT,
    );
    expect(readHistoricComputeChunkDays('3')).toBe(3);
    expect(() => readHistoricComputeChunkDays('0')).toThrow(
      'must be a positive integer',
    );
    expect(() => readHistoricComputeChunkDays('3.5')).toThrow(
      'must be a positive integer',
    );
    expect(() => readHistoricComputeChunkDays('3661')).toThrow(
      'must be at most 3660',
    );
  });

  it('chains bounded historic workers through persisted cursor states', async () => {
    process.env.HISTORIC_COMPUTE_CHUNK_DAYS = '3';
    (service as any).runHistoricWorker.mockImplementation(
      async (...args: unknown[]) => {
        const chunkStart = moment.utc(String(args[1]), 'YYYY-MM-DD');
        const chunkEnd = moment.utc(String(args[8]), 'YYYY-MM-DD');
        const dayCount = chunkEnd.diff(chunkStart, 'days') + 1;
        return {
          mapCursor: args[8],
          statsCursor: args[8],
          mapGeneration: (
            BigInt(String(args[5])) + BigInt(dayCount)
          ).toString(),
          statsGeneration: (
            BigInt(String(args[6])) + BigInt(dayCount)
          ).toString(),
        };
      },
    );

    await expect(
      (service as any).runHistoricWorkerInChunks(
        'mapsComputed',
        '2026-07-01',
        '2026-07-01',
        '2026-07-01',
        '2026-07-01',
        '4',
        '9',
        '2026-07-10',
        '42',
      ),
    ).resolves.toEqual({
      mapCursor: '2026-07-10',
      statsCursor: '2026-07-10',
      mapGeneration: '14',
      statsGeneration: '19',
    });

    expect(
      (service as any).runHistoricWorker.mock.calls.map(
        ([, dateMin, , , , , , sourceRevision, dateMax]) => ({
          dateMin,
          dateMax,
          sourceRevision,
        }),
      ),
    ).toEqual([
      {
        dateMin: '2026-07-01',
        dateMax: '2026-07-03',
        sourceRevision: '42',
      },
      {
        dateMin: '2026-07-04',
        dateMax: '2026-07-06',
        sourceRevision: '42',
      },
      {
        dateMin: '2026-07-07',
        dateMax: '2026-07-09',
        sourceRevision: '42',
      },
      {
        dateMin: '2026-07-10',
        dateMax: '2026-07-10',
        sourceRevision: '42',
      },
    ]);
    expect(
      (service as any).assertCurrentHistoricCursorState,
    ).toHaveBeenCalledTimes(4);
  });

  it('stops chunk chaining when a worker does not advance through its end date', async () => {
    process.env.HISTORIC_COMPUTE_CHUNK_DAYS = '3';
    (service as any).runHistoricWorker.mockResolvedValue({
      mapCursor: '2026-07-02',
      statsCursor: '2026-07-02',
      mapGeneration: '6',
      statsGeneration: '11',
    });

    await expect(
      (service as any).runHistoricWorkerInChunks(
        'mapsComputed',
        '2026-07-01',
        '2026-07-01',
        '2026-07-01',
        '2026-07-01',
        '4',
        '9',
        '2026-07-10',
        '42',
      ),
    ).rejects.toThrow(
      'Historic worker did not complete its chunk through 2026-07-03',
    );
    expect((service as any).runHistoricWorker).toHaveBeenCalledTimes(1);
  });

  it('runs legacy then computed historic workers when the dirty date predates computed maps', async () => {
    configService.getConfig
      .mockResolvedValueOnce({
        computeMapDate: '2023-04-13',
        computeStatsDate: '2023-04-13',
        computeMapGeneration: '3',
        computeStatsGeneration: '5',
        historicComputeEpoch: '23',
      })
      .mockResolvedValueOnce({
        computeMapDate: '2024-04-28',
        computeStatsDate: '2024-04-28',
        computeMapGeneration: '370',
        computeStatsGeneration: '371',
        historicComputeEpoch: '23',
      });

    await service.computeHistoric();

    expect((service as any).runHistoricWorker).toHaveBeenCalledTimes(2);
    expect((service as any).runHistoricWorker).toHaveBeenNthCalledWith(
      1,
      'maps',
      '2023-04-13',
      '2023-04-13',
      '2023-04-13',
      '2023-04-13',
      '3',
      '5',
      '1',
      '2024-04-28',
      '23',
    );
    expect((service as any).runHistoricWorker).toHaveBeenNthCalledWith(
      2,
      'mapsComputed',
      '2024-04-29',
      '2024-04-28',
      '2024-04-28',
      '2024-04-28',
      '370',
      '371',
      '1',
      '2026-06-22',
      '23',
    );
    expect(statisticCommuneService.computeByMonth).toHaveBeenCalledWith(
      expect.objectContaining({
        _isAMomentObject: true,
      }),
      undefined,
      expect.objectContaining({
        aggregateThrough: expect.objectContaining({
          _isAMomentObject: true,
        }),
      }),
    );
    expect(
      statisticCommuneService.computeByMonth.mock.calls[0][0].format(
        'YYYY-MM-DD',
      ),
    ).toBe('2023-04-13');
    expect(
      statisticCommuneService.computeByMonth.mock.calls[0][2].aggregateThrough.format(
        'YYYY-MM-DD',
      ),
    ).toBe('2026-06-22');
    expect(
      statisticCommuneService.computeByMonth.mock.calls[0][2]
        .allowedReadySnapshot,
    ).toBeUndefined();
  });

  it('starts computed historic workers from the dirty date after the computed map switch', async () => {
    configService.getConfig.mockResolvedValue({
      computeMapDate: '2026-03-25',
      computeStatsDate: '2026-03-25',
      computeMapGeneration: '7',
      computeStatsGeneration: '8',
      historicComputeEpoch: '24',
    });

    await service.computeHistoric();

    expect((service as any).runHistoricWorker).toHaveBeenCalledTimes(1);
    expect((service as any).runHistoricWorker).toHaveBeenCalledWith(
      'mapsComputed',
      '2026-03-25',
      '2026-03-25',
      '2026-03-25',
      '2026-03-25',
      '7',
      '8',
      '1',
      '2026-06-22',
      '24',
    );
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('"historicDirtyFrom"'),
      ['2026-03-25', '2026-06-22'],
    );
    const dirtyRangeSql = dataSource.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO "statistic_publication_state"'),
    )?.[0];
    expect(dirtyRangeSql).toContain('VALUES (1, 1, $1::date, $2::date, now())');
    expect(dirtyRangeSql).toContain(
      '"revision" = "statistic_publication_state"."revision" + CASE',
    );
    expect(dirtyRangeSql).toContain('IS DISTINCT FROM CASE');
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('EXISTS(SELECT 1 FROM published)'),
      ['2026-06-22', '1'],
    );
    expect(
      dataSource.query.mock.calls.find(([sql]) =>
        sql.includes('EXISTS(SELECT 1 FROM published)'),
      )?.[0],
    ).toContain('$1::date >= publication_state."historicDirtyThrough"');
  });

  it('uses computeStatsDate when it is older than computeMapDate', async () => {
    configService.getConfig.mockResolvedValue({
      computeMapDate: '2026-06-01',
      computeStatsDate: '2026-03-25',
      computeMapGeneration: '9',
      computeStatsGeneration: '10',
    });

    await service.computeHistoric();

    expect((service as any).runHistoricWorker).toHaveBeenCalledTimes(1);
    expect((service as any).runHistoricWorker).toHaveBeenCalledWith(
      'mapsComputed',
      '2026-03-25',
      '2026-03-25',
      '2026-06-01',
      '2026-03-25',
      '9',
      '10',
      '1',
      '2026-06-22',
      '0',
    );
  });

  it('initializes a missing statistics cursor from the existing dirty date', async () => {
    configService.getConfig.mockResolvedValue({
      computeMapDate: '2026-03-25',
      computeStatsDate: null,
      computeMapGeneration: '9',
      computeStatsGeneration: '0',
    });

    await service.computeHistoric();

    expect((service as any).runHistoricWorker).toHaveBeenCalledWith(
      'mapsComputed',
      '2026-03-25',
      '2026-03-25',
      '2026-03-25',
      null,
      '9',
      '0',
      '1',
      '2026-06-22',
      '0',
    );
    expect(statisticCommuneService.computeByMonth).toHaveBeenCalledWith(
      expect.objectContaining({ _isAMomentObject: true }),
      undefined,
      expect.any(Object),
    );
  });

  it('certifies history through J-1 while aggregating the matching ready J candidate', async () => {
    configService.getConfig.mockResolvedValue({
      computeMapDate: '2026-06-01',
      computeStatsDate: '2026-06-01',
      computeMapGeneration: '9',
      computeStatsGeneration: '10',
    });
    (service as any).runHistoricWorker.mockResolvedValue({
      mapCursor: '2026-06-22',
      statsCursor: '2026-06-22',
      mapGeneration: '30',
      statsGeneration: '31',
    });
    jest
      .spyOn(service as any, 'assertHistoricCatchUpComplete')
      .mockResolvedValue(undefined);

    const completedState = await service.computeHistoric(
      true,
      '2026-06-22',
      '1',
    );

    expect(statisticCommuneService.computeByMonth).toHaveBeenCalledWith(
      expect.objectContaining({ _isAMomentObject: true }),
      undefined,
      expect.objectContaining({
        aggregateThrough: expect.objectContaining({ _isAMomentObject: true }),
        allowedReadySnapshot: {
          date: '2026-06-23',
          sourceRevision: '1',
        },
      }),
    );
    expect(
      statisticCommuneService.computeByMonth.mock.calls[0][2].aggregateThrough.format(
        'YYYY-MM-DD',
      ),
    ).toBe('2026-06-23');
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('EXISTS(SELECT 1 FROM published)'),
      ['2026-06-22', '1'],
    );
    expect(completedState).toEqual({
      mapCursor: '2026-06-22',
      statsCursor: '2026-06-22',
      mapGeneration: '30',
      statsGeneration: '31',
    });
    expect(
      (service as any).assertCurrentHistoricCursorState,
    ).toHaveBeenLastCalledWith(completedState, '0');
  });

  it('does not compute monthly aggregates after a historic worker failure', async () => {
    configService.getConfig.mockResolvedValue({
      computeMapDate: '2026-03-25',
      computeStatsDate: '2026-03-25',
      computeMapGeneration: '7',
      computeStatsGeneration: '8',
    });
    (service as any).runHistoricWorker.mockRejectedValue(
      new Error('historic worker failed'),
    );

    await expect(service.computeHistoric()).resolves.toBeUndefined();

    expect(statisticCommuneService.computeByMonth).not.toHaveBeenCalled();
  });

  it('rethrows a historic worker failure for persistent catch-up', async () => {
    configService.getConfig.mockResolvedValue({
      computeMapDate: '2026-03-25',
      computeStatsDate: '2026-03-25',
      computeMapGeneration: '7',
      computeStatsGeneration: '8',
    });
    (service as any).runHistoricWorker.mockRejectedValue(
      new Error('historic worker failed'),
    );

    await expect(service.computeHistoric(true)).rejects.toThrow(
      'historic worker failed',
    );
    expect(statisticCommuneService.computeByMonth).not.toHaveBeenCalled();
  });

  it('rewinds to the first dirty day when the source revision changes', async () => {
    configService.getConfig.mockResolvedValue({
      computeMapDate: '2026-03-25',
      computeStatsDate: '2026-03-25',
      computeMapGeneration: '7',
      computeStatsGeneration: '8',
    });
    zonePublicationService.getSourceRevision
      .mockResolvedValueOnce('41')
      .mockResolvedValueOnce('42');
    (service as any).runHistoricWorker.mockRejectedValue(
      new Error('Historic source revision changed (41 -> 42)'),
    );

    await expect(service.computeHistoric(true)).rejects.toThrow(
      'Historic source revision changed (41 -> 42)',
    );

    expect(configService.setConfig).toHaveBeenCalledWith(
      '2026-03-25',
      '2026-03-25',
    );
  });

  it('handles a monthly aggregate failure in background catch-up', async () => {
    configService.getConfig.mockResolvedValue({
      computeMapDate: '2026-03-25',
      computeStatsDate: '2026-03-25',
      computeMapGeneration: '7',
      computeStatsGeneration: '8',
    });
    statisticCommuneService.computeByMonth.mockRejectedValue(
      new Error('monthly failed'),
    );

    await expect(service.computeHistoric()).resolves.toBeUndefined();
  });

  it('rethrows a monthly aggregate failure in persistent catch-up', async () => {
    configService.getConfig.mockResolvedValue({
      computeMapDate: '2026-03-25',
      computeStatsDate: '2026-03-25',
      computeMapGeneration: '7',
      computeStatsGeneration: '8',
    });
    statisticCommuneService.computeByMonth.mockRejectedValue(
      new Error('monthly failed'),
    );

    await expect(service.computeHistoric(true)).rejects.toThrow(
      'monthly failed',
    );
  });

  it('does not publish a historic epoch while a snapshot is incomplete', async () => {
    configService.getConfig.mockResolvedValue({
      computeMapDate: '2026-03-25',
      computeStatsDate: '2026-03-25',
      computeMapGeneration: '7',
      computeStatsGeneration: '8',
    });
    dataSource.query.mockImplementation(async (sql: string) =>
      sql.includes('EXISTS(SELECT 1 FROM published)')
        ? [
            {
              published: false,
              incompleteDate: '2026-03-26',
              currentSourceRevision: '1',
            },
          ]
        : [],
    );

    await expect(service.computeHistoric(true)).rejects.toThrow(
      'Historic statistics publication blocked by snapshot 2026-03-26',
    );
  });

  it('does not publish a historic epoch after the source revision changes', async () => {
    configService.getConfig.mockResolvedValue({
      computeMapDate: '2026-03-25',
      computeStatsDate: '2026-03-25',
      computeMapGeneration: '7',
      computeStatsGeneration: '8',
    });
    dataSource.query.mockImplementation(async (sql: string) =>
      sql.includes('EXISTS(SELECT 1 FROM published)')
        ? [
            {
              published: false,
              incompleteDate: null,
              currentSourceRevision: '2',
            },
          ]
        : [],
    );

    await expect(service.computeHistoric(true)).rejects.toThrow(
      'Historic statistics source revision changed (1 -> 2)',
    );
    const publicationSql = dataSource.query.mock.calls.find(([sql]) =>
      sql.includes('EXISTS(SELECT 1 FROM published)'),
    )?.[0];
    expect(publicationSql).toContain('FOR UPDATE');
    expect(publicationSql).toContain('source_guard.revision = $2::text');
  });

  it('locks the dirty range before certifying a historic publication', async () => {
    await (service as any).publishHistoricStatistics('2026-06-22', '1');

    const [publicationSql, parameters] = dataSource.query.mock.calls.find(
      ([sql]) => sql.includes('EXISTS(SELECT 1 FROM published)'),
    );
    expect(parameters).toEqual(['2026-06-22', '1']);
    expect(publicationSql).toContain('publication_guard AS MATERIALIZED');
    expect(publicationSql).toContain('CROSS JOIN source_guard');
    expect(publicationSql).toContain('FOR UPDATE OF state');
    expect(publicationSql).toContain(
      'CROSS JOIN publication_guard publication_state',
    );
    expect(publicationSql).toContain(
      'snapshot."snapshotDate" >= publication_state."historicDirtyFrom"',
    );
    expect(publicationSql).toContain(
      'snapshot."sourceRevision" IS DISTINCT FROM $2::bigint',
    );
    expect(publicationSql).toContain(
      'FROM publication_guard publication_state',
    );
    expect(publicationSql).toContain(
      '$1::date >= publication_state."historicDirtyThrough"',
    );
    expect(publicationSql).not.toContain(
      'snapshot."snapshotDate" >= state."historicDirtyFrom"',
    );
  });

  it('rejects an equal-date invalidation after a historic worker completed', () => {
    expect(() =>
      (service as any).assertHistoricCursorState(
        {
          mapCursor: '2026-07-31',
          statsCursor: '2026-07-31',
          mapGeneration: '12',
          statsGeneration: '18',
        },
        {
          computeMapDate: '2026-07-31',
          computeStatsDate: '2026-07-31',
          computeMapGeneration: '13',
          computeStatsGeneration: '18',
        },
      ),
    ).toThrow('Historic cursors changed after worker completion');
  });

  it('rejects a completed worker after its checkpoint epoch was invalidated', () => {
    expect(() =>
      (service as any).assertHistoricCursorState(
        {
          mapCursor: '2026-07-31',
          statsCursor: '2026-07-31',
          mapGeneration: '12',
          statsGeneration: '18',
        },
        {
          computeMapDate: '2026-07-31',
          computeStatsDate: '2026-07-31',
          computeMapGeneration: '12',
          computeStatsGeneration: '18',
          historicComputeEpoch: '8',
        },
        '7',
      ),
    ).toThrow('Historic cursors changed after worker completion');
  });

  it('passes the source revision and end date to a historic worker', async () => {
    const worker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    (Worker as unknown as jest.Mock).mockReturnValue(worker);
    const runHistoricWorker = (
      ZoneAlerteComputedService.prototype as any
    ).runHistoricWorker.bind(service);

    const computation = runHistoricWorker(
      'mapsComputed',
      '2026-07-01',
      '2026-07-01',
      '2026-07-01',
      '2026-07-01',
      '12',
      '18',
      '42',
      '2026-07-03',
      '17',
    );

    expect(Worker).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        workerData: expect.objectContaining({
          expectedSourceRevision: '42',
          dateMax: '2026-07-03',
          expectedHistoricComputeEpoch: '17',
        }),
      }),
    );
    worker.emit('message', {
      success: true,
      result: {
        mapCursor: '2026-07-03',
        statsCursor: '2026-07-03',
        mapGeneration: '15',
        statsGeneration: '21',
      },
    });
    await expect(computation).resolves.toEqual(
      expect.objectContaining({ mapCursor: '2026-07-03' }),
    );
  });

  it('waits for historic worker termination before rejecting its timeout', async () => {
    const order: string[] = [];
    let finishTermination: (exitCode: number) => void;
    const termination = new Promise<number>((resolve) => {
      finishTermination = resolve;
    });
    const worker = Object.assign(new EventEmitter(), {
      terminate: jest.fn(async () => {
        order.push('terminate:start');
        const exitCode = await termination;
        order.push('terminate:end');
        return exitCode;
      }),
    });
    (Worker as unknown as jest.Mock).mockReturnValue(worker);
    jest.spyOn((service as any).logger, 'error').mockImplementation();

    const runHistoricWorker = (
      ZoneAlerteComputedService.prototype as any
    ).runHistoricWorker.bind(service);
    const outcome = runHistoricWorker(
      'mapsComputed',
      '2026-07-31',
      '2026-07-31',
      '2026-07-31',
      '2026-07-31',
      '12',
      '18',
    ).then(
      () => {
        order.push('promise:resolved');
        return null;
      },
      (error: Error) => {
        order.push('promise:rejected');
        return error;
      },
    );
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });

    await jest.advanceTimersByTimeAsync(HISTORIC_COMPUTE_WORKER_TIMEOUT_MS);

    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['terminate:start']);
    expect(settled).toBe(false);

    worker.emit('message', {
      success: true,
      result: {
        mapCursor: '2026-07-31',
        statsCursor: '2026-07-31',
        mapGeneration: '13',
        statsGeneration: '19',
      },
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishTermination!(1);

    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe(
      'COMPUTE HISTORIC MAPSCOMPUTED worker timed out',
    );
    expect(order).toEqual([
      'terminate:start',
      'terminate:end',
      'promise:rejected',
    ]);
  });

  it('logs a historic worker termination failure before rejecting its timeout', async () => {
    const terminationError = new Error('termination failed');
    const worker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockRejectedValue(terminationError),
    });
    (Worker as unknown as jest.Mock).mockReturnValue(worker);
    const loggerError = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation();

    const runHistoricWorker = (
      ZoneAlerteComputedService.prototype as any
    ).runHistoricWorker.bind(service);
    const computation = runHistoricWorker(
      'maps',
      '2026-07-31',
      '2026-07-31',
      '2026-07-31',
      '2026-07-31',
      '12',
      '18',
    );
    const rejection = expect(computation).rejects.toThrow(
      'COMPUTE HISTORIC MAPS worker timed out',
    );

    await jest.advanceTimersByTimeAsync(HISTORIC_COMPUTE_WORKER_TIMEOUT_MS);

    await rejection;
    expect(loggerError).toHaveBeenCalledWith(
      'COMPUTE HISTORIC MAPS WORKER TERMINATION ERROR',
      terminationError,
    );
  });

  it('terminates a compute worker that times out before its first result', async () => {
    const worker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    (Worker as unknown as jest.Mock).mockReturnValue(worker);
    jest.spyOn((service as any).logger, 'error').mockImplementation();

    const compute = service.askCompute([65]);
    const rejection = expect(compute).rejects.toThrow(
      'COMPUTE ALL worker timed out',
    );
    await jest.advanceTimersByTimeAsync(ZONE_COMPUTE_WORKER_TIMEOUT_MS);

    await rejection;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect((service as any).isComputing).toBe(false);
  });

  it('keeps historic catch-up out of the current compute worker', async () => {
    const worker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    (Worker as unknown as jest.Mock).mockReturnValue(worker);
    jest.spyOn((service as any).logger, 'error').mockImplementation();

    const compute = service.askCompute([65], false, true);
    expect(Worker).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        workerData: {
          depsIds: [65],
          skipIfBusy: false,
        },
      }),
    );
    worker.emit('message', { success: true });

    await expect(compute).resolves.toEqual({ success: true });
    expect(worker.terminate).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(ZONE_COMPUTE_WORKER_TIMEOUT_MS);

    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('keeps the current worker implementation free of historic catch-up calls', async () => {
    const workerSource = await readFile(
      join(__dirname, '../worker_threads/computeMap.ts'),
      'utf8',
    );

    expect(workerSource).not.toMatch(/\.computeHistoric(?:Persistently)?\s*\(/);
    expect(workerSource).not.toContain('computeHistoric:');
  });

  it('passes the daily publication reuse identity to its worker', async () => {
    const worker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    (Worker as unknown as jest.Mock).mockReturnValue(worker);
    const reuseContext = {
      scheduledFor: '2026-08-02',
      sourceRevision: '42',
    };

    const compute = service.askCompute([], false, false, false, reuseContext);

    expect(Worker).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        workerData: {
          depsIds: [],
          skipIfBusy: false,
          dailyPublicationReuse: reuseContext,
        },
      }),
    );
    worker.emit('message', {
      success: true,
      result: { publicationId: 'publication-1', sourceRevision: '42' },
    });
    await expect(compute).resolves.toEqual(
      expect.objectContaining({ success: true }),
    );
  });

  it('keeps the daily reuse identity while its compute waits in the local queue', async () => {
    const firstWorker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    const dailyWorker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    (Worker as unknown as jest.Mock)
      .mockReturnValueOnce(firstWorker)
      .mockReturnValueOnce(dailyWorker);
    const reuseContext = {
      scheduledFor: '2026-08-02',
      sourceRevision: '42',
    };

    const currentCompute = service.askCompute([65]);
    const dailyCompute = service.askCompute(
      [],
      false,
      false,
      false,
      reuseContext,
    );
    firstWorker.emit('message', { success: true });
    await expect(currentCompute).resolves.toEqual({ success: true });
    await jest.advanceTimersByTimeAsync(10_000);

    expect(Worker).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        workerData: expect.objectContaining({
          depsIds: [],
          dailyPublicationReuse: reuseContext,
        }),
      }),
    );
    dailyWorker.emit('message', {
      success: true,
      result: { publicationId: 'publication-1', sourceRevision: '42' },
    });
    await expect(dailyCompute).resolves.toEqual(
      expect.objectContaining({ success: true }),
    );
  });

  it('lets a queued daily national compute dominate a watchdog partial compute', async () => {
    const firstWorker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    const dailyWorker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    (Worker as unknown as jest.Mock)
      .mockReturnValueOnce(firstWorker)
      .mockReturnValueOnce(dailyWorker);
    const reuseContext = {
      scheduledFor: '2026-08-02',
      sourceRevision: '42',
    };

    const currentCompute = service.askCompute([31]);
    const dailyCompute = service.askCompute(
      [],
      false,
      false,
      false,
      reuseContext,
    );
    const watchdogCompute = service.askCompute([65], false, false, true);
    firstWorker.emit('message', { success: true });
    await expect(currentCompute).resolves.toEqual({ success: true });
    await jest.advanceTimersByTimeAsync(10_000);

    expect(Worker).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        workerData: {
          depsIds: [],
          skipIfBusy: false,
          dailyPublicationReuse: reuseContext,
        },
      }),
    );
    const result = {
      success: true,
      result: { publicationId: 'publication-1', sourceRevision: '42' },
    };
    dailyWorker.emit('message', result);
    await expect(dailyCompute).resolves.toEqual(result);
    await expect(watchdogCompute).resolves.toEqual(result);
  });

  it('invalidates queued daily reuse when a normal national compute joins it', async () => {
    const firstWorker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    const nationalWorker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    (Worker as unknown as jest.Mock)
      .mockReturnValueOnce(firstWorker)
      .mockReturnValueOnce(nationalWorker);
    const reuseContext = {
      scheduledFor: '2026-08-02',
      sourceRevision: '42',
    };

    const currentCompute = service.askCompute([31]);
    const dailyCompute = service.askCompute(
      [],
      false,
      false,
      false,
      reuseContext,
    );
    const manualCompute = service.askCompute([]);
    firstWorker.emit('message', { success: true });
    await expect(currentCompute).resolves.toEqual({ success: true });
    await jest.advanceTimersByTimeAsync(10_000);

    expect(Worker).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        workerData: {
          depsIds: [],
          skipIfBusy: false,
        },
      }),
    );
    const result = {
      success: true,
      result: { publicationId: 'publication-2', sourceRevision: '42' },
    };
    nationalWorker.emit('message', result);
    await expect(dailyCompute).resolves.toEqual(result);
    await expect(manualCompute).resolves.toEqual(result);
  });

  it('reuses a matching daily publication instead of recomputing', async () => {
    const reuseContext = {
      scheduledFor: '2026-08-02',
      sourceRevision: '42',
    };
    const reusablePublication = {
      publicationId: 'publication-1',
      sourceRevision: '42',
    };
    zonePublicationService.findReusableDailyPublication.mockResolvedValue(
      reusablePublication,
    );
    const computeAll = jest.spyOn(service, 'computeAll');

    await expect(
      service.computeAllOrReuseDailyPublication([], reuseContext),
    ).resolves.toEqual(reusablePublication);

    expect(
      zonePublicationService.findReusableDailyPublication,
    ).toHaveBeenCalledWith(reuseContext);
    expect(computeAll).not.toHaveBeenCalled();
  });

  it('keeps the normal compute path when no daily publication is reusable', async () => {
    const reuseContext = {
      scheduledFor: '2026-08-02',
      sourceRevision: '42',
    };
    const computed = { publicationId: 'publication-2', sourceRevision: '42' };
    const computeAll = jest
      .spyOn(service, 'computeAll')
      .mockResolvedValue(computed);

    await expect(
      service.computeAllOrReuseDailyPublication([], reuseContext),
    ).resolves.toEqual(computed);

    expect(
      zonePublicationService.findReusableDailyPublication,
    ).toHaveBeenCalledWith(reuseContext);
    expect(computeAll).toHaveBeenCalledWith([], false, '2026-08-02');
  });

  it('does not apply daily reuse to an ordinary scoped compute', async () => {
    const computeAll = jest.spyOn(service, 'computeAll').mockResolvedValue({
      publicationId: undefined,
      sourceRevision: undefined,
    });

    await service.computeAllOrReuseDailyPublication([65], {
      scheduledFor: '2026-08-02',
      sourceRevision: '42',
    });

    expect(
      zonePublicationService.findReusableDailyPublication,
    ).not.toHaveBeenCalled();
    expect(computeAll).toHaveBeenCalledWith([65], false);
  });

  it('rejects and releases the compute slot when the worker reports a failure', async () => {
    const worker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    (Worker as unknown as jest.Mock).mockReturnValue(worker);
    jest.spyOn((service as any).logger, 'error').mockImplementation();

    const compute = service.askCompute([65]);
    worker.emit('message', {
      success: false,
      error: 'Unable to build zone publication',
    });

    await expect(compute).rejects.toThrow('Unable to build zone publication');
    expect((service as any).isComputing).toBe(false);
    expect((service as any).activeComputeWorker).toBeNull();

    await jest.advanceTimersByTimeAsync(ZONE_COMPUTE_WORKER_TIMEOUT_MS);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('rejects and resets state when a worker exits cleanly without a result', async () => {
    const worker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    (Worker as unknown as jest.Mock).mockReturnValue(worker);
    jest.spyOn((service as any).logger, 'error').mockImplementation();

    const compute = service.askCompute([65]);
    worker.emit('exit', 0);

    await expect(compute).rejects.toThrow(
      'COMPUTE ALL worker exited without a result',
    );
    expect((service as any).isComputing).toBe(false);
  });

  it('rejects and resets state when a worker exits with an error code', async () => {
    const worker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    (Worker as unknown as jest.Mock).mockReturnValue(worker);
    jest.spyOn((service as any).logger, 'error').mockImplementation();

    const compute = service.askCompute([65]);
    worker.emit('exit', 2);

    await expect(compute).rejects.toThrow(
      'COMPUTE ALL Worker stopped with exit code 2',
    );
    expect((service as any).isComputing).toBe(false);
  });

  it('propagates a synchronous worker startup failure', async () => {
    const expectedError = new Error('worker unavailable');
    (Worker as unknown as jest.Mock).mockImplementationOnce(() => {
      throw expectedError;
    });
    jest.spyOn((service as any).logger, 'error').mockImplementation();

    await expect(service.askCompute([65])).rejects.toBe(expectedError);
    expect((service as any).isComputing).toBe(false);
    expect((service as any).activeComputeWorker).toBeNull();
  });

  it('aggregates current requests without sending historic work to the worker', async () => {
    const firstWorker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    const secondWorker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    (Worker as unknown as jest.Mock)
      .mockReturnValueOnce(firstWorker)
      .mockReturnValueOnce(secondWorker);

    const firstCompute = service.askCompute([65], false, false, true);
    const queuedWatchdog = service.askCompute([31], false, false, true);
    const queuedHistoric = service.askCompute([75], false, true, false);
    await jest.advanceTimersByTimeAsync(0);
    expect(
      preflightQueryRunner.query.mock.calls.some(([sql]) =>
        sql.includes('pg_advisory_unlock'),
      ),
    ).toBe(true);
    expect(preflightQueryRunner.release).toHaveBeenCalledTimes(1);
    firstWorker.emit('message', { success: true });
    await expect(firstCompute).resolves.toEqual({ success: true });

    await jest.advanceTimersByTimeAsync(10_000);

    expect(Worker).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        workerData: {
          depsIds: [31, 75],
          skipIfBusy: false,
        },
      }),
    );
    secondWorker.emit('message', { success: true });
    await expect(queuedWatchdog).resolves.toEqual({ success: true });
    await expect(queuedHistoric).resolves.toEqual({ success: true });
  });

  it('keeps polling a queued compute while the current worker stays busy', async () => {
    const firstWorker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    const secondWorker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    (Worker as unknown as jest.Mock)
      .mockReturnValueOnce(firstWorker)
      .mockReturnValueOnce(secondWorker);

    const firstCompute = service.askCompute([65]);
    const queuedCompute = service.askCompute([31]);
    await jest.advanceTimersByTimeAsync(20_000);

    expect(Worker).toHaveBeenCalledTimes(1);
    firstWorker.emit('message', { success: true });
    await expect(firstCompute).resolves.toEqual({ success: true });
    await jest.advanceTimersByTimeAsync(10_000);

    expect(Worker).toHaveBeenCalledTimes(2);
    expect(Worker).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        workerData: expect.objectContaining({ depsIds: [31] }),
      }),
    );
    secondWorker.emit('message', { success: true });
    await expect(queuedCompute).resolves.toEqual({ success: true });
  });

  it('ignores a stale queue timer after a normal request already drained it', async () => {
    const firstWorker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    const secondWorker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    (Worker as unknown as jest.Mock)
      .mockReturnValueOnce(firstWorker)
      .mockReturnValueOnce(secondWorker);

    const firstCompute = service.askCompute([65]);
    const queuedCompute = service.askCompute([31]);
    await jest.advanceTimersByTimeAsync(5_000);
    firstWorker.emit('message', { success: true });
    await expect(firstCompute).resolves.toEqual({ success: true });

    const secondCompute = service.askCompute([75]);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(Worker).toHaveBeenCalledTimes(2);
    secondWorker.emit('message', { success: true });
    await expect(secondCompute).resolves.toEqual({ success: true });
    await expect(queuedCompute).resolves.toEqual({ success: true });
    await jest.advanceTimersByTimeAsync(20_000);

    expect(Worker).toHaveBeenCalledTimes(2);
  });

  it('rejects every caller waiting for a queued computation that fails', async () => {
    const firstWorker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    const secondWorker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    (Worker as unknown as jest.Mock)
      .mockReturnValueOnce(firstWorker)
      .mockReturnValueOnce(secondWorker);

    const firstCompute = service.askCompute([65]);
    const queuedFirst = service.askCompute([31]);
    const queuedSecond = service.askCompute([75], false, true);
    firstWorker.emit('message', { success: true });
    await expect(firstCompute).resolves.toEqual({ success: true });
    await jest.advanceTimersByTimeAsync(10_000);

    secondWorker.emit('message', { success: false, error: 'queued failed' });
    await expect(queuedFirst).rejects.toThrow('queued failed');
    await expect(queuedSecond).rejects.toThrow('queued failed');
  });

  it('does not start a worker when a skip-if-busy preflight finds the global lock busy', async () => {
    preflightQueryRunner.query.mockResolvedValueOnce([{ locked: false }]);

    await expect(service.askCompute([65], false, false, true)).resolves.toEqual(
      { success: true, skipped: true },
    );

    expect(Worker).not.toHaveBeenCalled();
    expect(preflightQueryRunner.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_try_advisory_lock'),
    );
    expect(
      preflightQueryRunner.query.mock.calls.some(([sql]) =>
        sql.includes('pg_advisory_unlock'),
      ),
    ).toBe(false);
    expect(preflightQueryRunner.release).toHaveBeenCalledTimes(1);
    expect((service as any).isComputing).toBe(false);
  });

  it('resolves queued skip-if-busy callers when the cross-process lock remains busy', async () => {
    const worker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    (Worker as unknown as jest.Mock).mockReturnValue(worker);

    const currentCompute = service.askCompute([65]);
    const queuedFirst = service.askCompute([31], false, false, true);
    const queuedSecond = service.askCompute([75], false, false, true);
    worker.emit('message', { success: true });
    await expect(currentCompute).resolves.toEqual({ success: true });
    preflightQueryRunner.query.mockResolvedValueOnce([{ locked: false }]);

    await jest.advanceTimersByTimeAsync(10_000);

    await expect(queuedFirst).resolves.toEqual({
      success: true,
      skipped: true,
    });
    await expect(queuedSecond).resolves.toEqual({
      success: true,
      skipped: true,
    });
    expect(Worker).toHaveBeenCalledTimes(1);
    expect((service as any).isComputing).toBe(false);
  });

  it('keeps a normal request queued when a watchdog preflight finds the lock busy', async () => {
    const worker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    (Worker as unknown as jest.Mock).mockReturnValue(worker);
    preflightQueryRunner.query.mockResolvedValueOnce([{ locked: false }]);

    const watchdog = service.askCompute([65], false, false, true);
    const normalRequest = service.askCompute([31]);

    await expect(watchdog).resolves.toEqual({
      success: true,
      skipped: true,
    });
    expect(Worker).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(10_000);

    expect(Worker).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        workerData: {
          depsIds: [31],
          skipIfBusy: false,
        },
      }),
    );
    worker.emit('message', { success: true });
    await expect(normalRequest).resolves.toEqual({ success: true });
  });

  it('requests a full recompute when the publication watchdog detects lag', async () => {
    zonePublicationService.isRecomputeRequired.mockResolvedValue(true);
    const askCompute = jest
      .spyOn(service, 'askCompute')
      .mockResolvedValue(undefined);

    await service.ensureFreshZonePublication();

    expect(
      zonePublicationService.promoteCertifiedPublicationIfAvailable,
    ).toHaveBeenCalledTimes(1);
    expect(askCompute).toHaveBeenCalledWith([], false, false, true);
  });

  it('promotes a certified validated publication without rebuilding it', async () => {
    zonePublicationService.promoteCertifiedPublicationIfAvailable.mockResolvedValue(
      true,
    );
    const askCompute = jest.spyOn(service, 'askCompute');

    await service.ensureFreshZonePublication();

    expect(zonePublicationService.isRecomputeRequired).not.toHaveBeenCalled();
    expect(askCompute).not.toHaveBeenCalled();
  });

  it('does not run the publication watchdog while the feature is disabled', async () => {
    delete process.env.ZONE_PUBLICATION_ENABLED;
    const askCompute = jest.spyOn(service, 'askCompute');

    await service.ensureFreshZonePublication();

    expect(zonePublicationService.isRecomputeRequired).not.toHaveBeenCalled();
    expect(
      zonePublicationService.promoteCertifiedPublicationIfAvailable,
    ).not.toHaveBeenCalled();
    expect(askCompute).not.toHaveBeenCalled();
  });

  it('does not request a recompute while a compute is already running', async () => {
    (service as any).isComputing = true;
    const askCompute = jest
      .spyOn(service, 'askCompute')
      .mockResolvedValue(undefined);

    await service.ensureFreshZonePublication();

    expect(zonePublicationService.isRecomputeRequired).not.toHaveBeenCalled();
    expect(askCompute).not.toHaveBeenCalled();
  });

  it('keeps a partial compute scoped and does not capture a global revision', async () => {
    const departments = [
      {
        id: 65,
        code: '65',
        nom: 'Hautes-Pyrenees',
        parametres: [{ disabled: false, superpositionCommune: 'no' }],
      },
      {
        id: 31,
        code: '31',
        nom: 'Haute-Garonne',
        parametres: [{ disabled: false, superpositionCommune: 'no' }],
      },
    ];
    (service as any).departementService = {
      findAllLight: jest.fn().mockResolvedValue(departments),
    };
    const computeRegleAr = jest
      .spyOn(service, 'computeRegleAr')
      .mockResolvedValue([]);
    const computeCommunesIntersected = jest
      .spyOn(service, 'computeCommunesIntersected')
      .mockResolvedValue(undefined);
    const computeGeoJson = jest
      .spyOn(service, 'computeGeoJson')
      .mockResolvedValue(undefined);

    await service.computeAll([65], false);

    expect(computeRegleAr).toHaveBeenCalledTimes(1);
    expect(computeRegleAr).toHaveBeenNthCalledWith(1, departments[0]);
    expect(computeCommunesIntersected).toHaveBeenCalledTimes(1);
    expect(zonePublicationService.getSourceRevision).not.toHaveBeenCalled();
    expect(computeGeoJson).toHaveBeenCalledWith(false, undefined, undefined);
  });

  it('removes collapsed current zones during cleanup', async () => {
    const updateQuery = {
      update: jest.fn(),
      set: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    updateQuery.update.mockReturnValue(updateQuery);
    updateQuery.set.mockReturnValue(updateQuery);
    updateQuery.where.mockReturnValue(updateQuery);
    updateQuery.andWhere.mockReturnValue(updateQuery);
    (service as any).zoneAlerteComputedRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(updateQuery),
    };

    await service.cleanZones({ id: 65 } as any);

    const deleteCall = dataSource.query.mock.calls.find(([sql]) =>
      String(sql).includes('DELETE FROM zone_alerte_computed'),
    );
    const secondRepairCall = dataSource.query.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE zone_alerte_computed'),
    );
    const validationCall = dataSource.query.mock.calls.find(([sql]) =>
      String(sql).includes('AS "invalidIds"'),
    );
    expect(secondRepairCall).toBeDefined();
    expect(secondRepairCall![0]).toContain(
      `ST_CollectionExtract(\n          ST_MakeValid(geom, 'method=structure keepcollapsed=false')`,
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall![0]).toContain('ST_IsEmpty(geom)');
    expect(deleteCall![0]).toContain(
      `ST_GeometryType(geom) NOT IN ('ST_Polygon', 'ST_MultiPolygon')`,
    );
    expect(deleteCall![0]).not.toContain('OR NOT ST_IsValid(geom, 0)');
    expect(deleteCall![1]).toEqual([65]);
    expect(validationCall).toBeDefined();
    expect(validationCall![0]).toContain('NOT ST_IsValid(geom, 0)');

    const secondRepairIndex = dataSource.query.mock.calls.indexOf(
      secondRepairCall!,
    );
    const deleteIndex = dataSource.query.mock.calls.indexOf(deleteCall!);
    const validationIndex = dataSource.query.mock.calls.indexOf(
      validationCall!,
    );
    expect(secondRepairIndex).toBeLessThan(deleteIndex);
    expect(deleteIndex).toBeLessThan(validationIndex);

    const residueCleanupCall = dataSource.query.mock.calls.find(([sql]) =>
      String(sql).includes('WITH cleaned_geometries AS'),
    );
    expect(validationIndex).toBeLessThan(
      dataSource.query.mock.calls.indexOf(residueCleanupCall!),
    );
    expect(residueCleanupCall![0]).toContain('WHERE "departementId" = $1');
  });

  it('fails closed when a non-empty computed polygon remains invalid', async () => {
    const updateQuery = {
      update: jest.fn(),
      set: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    updateQuery.update.mockReturnValue(updateQuery);
    updateQuery.set.mockReturnValue(updateQuery);
    updateQuery.where.mockReturnValue(updateQuery);
    updateQuery.andWhere.mockReturnValue(updateQuery);
    (service as any).zoneAlerteComputedRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(updateQuery),
    };
    dataSource.query.mockImplementation(async (sql: string) =>
      sql.includes('AS "invalidIds"') ? [{ invalidIds: [3416566] }] : [],
    );

    await expect(service.cleanZones({ id: 65 } as any)).rejects.toThrow(
      'Geometries de zones calculees invalides apres nettoyage: 3416566',
    );
    expect(
      dataSource.query.mock.calls.some(([sql]) =>
        String(sql).includes('WITH cleaned_geometries AS'),
      ),
    ).toBe(false);
  });

  it('does not touch public statistics during a partial versioned compute', async () => {
    const computeCommuneStatisticsRestrictions = jest.fn();
    const computeCommuneStatisticsRestrictionsByMonth = jest.fn();
    const computeDepartementStatisticsRestrictions = jest.fn();
    const computeDepartementsSituation = jest.fn();
    (service as any).statisticCommuneService = {
      computeCommuneStatisticsRestrictions,
      computeCommuneStatisticsRestrictionsByMonth,
    };
    (service as any).statisticDepartementService = {
      computeDepartementStatisticsRestrictions,
    };
    (service as any).statisticService = { computeDepartementsSituation };
    const computeHistoric = jest.spyOn(service, 'computeHistoric');

    await (service as any).computePublicationStatistics(
      [],
      new Date('2026-08-02T08:00:00Z'),
      true,
      true,
      undefined,
    );

    expect(computeHistoric).not.toHaveBeenCalled();
    expect(computeCommuneStatisticsRestrictions).not.toHaveBeenCalled();
    expect(computeCommuneStatisticsRestrictionsByMonth).not.toHaveBeenCalled();
    expect(computeDepartementStatisticsRestrictions).not.toHaveBeenCalled();
    expect(computeDepartementsSituation).not.toHaveBeenCalled();
  });

  it('completes daily J before catching up through J-1 with the same revision', async () => {
    const events: string[] = [];
    const computeCommuneStatisticsRestrictions = jest.fn(
      async (...args: any[]) => {
        const hooks = args[5];
        events.push('daily-started');
        await hooks.beforeCommuneStatistics();
        await hooks.beforeCertification();
        events.push('daily-ready');
      },
    );
    (service as any).statisticCommuneService = {
      computeCommuneStatisticsRestrictions,
      computeCommuneStatisticsRestrictionsByMonth: jest.fn(async () => {
        events.push('current-month-computed');
      }),
    };
    (service as any).statisticDepartementService = {
      computeDepartementStatisticsRestrictions: jest.fn(async () => {
        events.push('department-computed');
      }),
    };
    (service as any).statisticService = {
      computeDepartementsSituation: jest.fn(async () => {
        events.push('situation-computed');
      }),
    };
    const computeHistoric = jest
      .spyOn(service, 'computeHistoric')
      .mockImplementation(async () => {
        events.push('historic-computed');
        return {
          mapCursor: '2026-08-02',
          statsCursor: '2026-08-02',
          mapGeneration: '1',
          statsGeneration: '1',
        };
      });

    await (service as any).computePublicationStatistics(
      [],
      new Date('2026-08-02T23:30:00-04:00'),
      true,
      true,
      '42',
    );

    expect(events).toEqual([
      'daily-started',
      'department-computed',
      'current-month-computed',
      'situation-computed',
      'daily-ready',
      'historic-computed',
    ]);
    expect(computeHistoric).toHaveBeenCalledWith(true, '2026-08-02', '42');
  });

  it('captures the global revision for a national publication compute', async () => {
    const departments = [
      {
        id: 65,
        code: '65',
        nom: 'Hautes-Pyrenees',
        parametres: [{ disabled: false, superpositionCommune: 'no' }],
      },
      {
        id: 31,
        code: '31',
        nom: 'Haute-Garonne',
        parametres: [{ disabled: false, superpositionCommune: 'no' }],
      },
    ];
    (service as any).departementService = {
      findAllLight: jest.fn().mockResolvedValue(departments),
    };
    const computeRegleAr = jest
      .spyOn(service, 'computeRegleAr')
      .mockResolvedValue([]);
    jest
      .spyOn(service, 'computeCommunesIntersected')
      .mockResolvedValue(undefined);
    const computeGeoJson = jest
      .spyOn(service, 'computeGeoJson')
      .mockResolvedValue(undefined);

    await service.computeAll([], false);

    expect(computeRegleAr).toHaveBeenCalledTimes(2);
    expect(zonePublicationService.getSourceRevision).toHaveBeenCalledTimes(1);
    expect(computeGeoJson).toHaveBeenCalledWith(false, '1', '2026-06-23');
  });

  it('keeps the captured business date when a national compute crosses 02:00 in Paris', async () => {
    jest.setSystemTime(new Date('2026-07-31T23:59:00Z'));
    zonePublicationService.getSourceRevision.mockImplementationOnce(
      async () => {
        jest.setSystemTime(new Date('2026-08-01T00:01:00Z'));
        return '1';
      },
    );
    (service as any).departementService = {
      findAllLight: jest.fn().mockResolvedValue([]),
    };
    const computeGeoJson = jest
      .spyOn(service, 'computeGeoJson')
      .mockResolvedValue(undefined);

    await service.computeAll([], false);

    expect(computeGeoJson).toHaveBeenCalledWith(false, '1', '2026-07-31');
  });

  it('rejects an invalid daily business date before starting the national compute', async () => {
    (service as any).departementService = {
      findAllLight: jest.fn().mockResolvedValue([]),
    };

    await expect(service.computeAll([], false, '')).rejects.toThrow(
      'Invalid civil date: ',
    );
    await expect(service.computeAll([], false, '2026-02-31')).rejects.toThrow(
      'Invalid civil date: 2026-02-31',
    );

    expect(zonePublicationService.getSourceRevision).not.toHaveBeenCalled();
    expect(
      (service as any).departementService.findAllLight,
    ).not.toHaveBeenCalled();
  });

  it('does not capture a publication revision while the feature is disabled', async () => {
    delete process.env.ZONE_PUBLICATION_ENABLED;
    (service as any).departementService = {
      findAllLight: jest.fn().mockResolvedValue([]),
    };
    jest.spyOn(service, 'computeGeoJson').mockResolvedValue(undefined);

    await service.computeAll([], false);

    expect(zonePublicationService.getSourceRevision).not.toHaveBeenCalled();
  });

  it('publishes only when the national compute supplied a source revision', async () => {
    const artifacts = {
      sourceComputedAt: new Date('2026-07-31T12:00:00Z'),
      artifactZoneCount: 12,
      geojsonUrl: 'https://example.test/zones.geojson',
      geojsonChecksum: 'a'.repeat(64),
      pmtilesUrl: 'https://example.test/zones.pmtiles',
      pmtilesChecksum: 'b'.repeat(64),
    };

    await (service as any).buildVersionedPublicationIfNational(artifacts);
    expect(
      zonePublicationService.buildCandidateFromCurrentComputed,
    ).not.toHaveBeenCalled();

    await (service as any).buildVersionedPublicationIfNational({
      ...artifacts,
      sourceRevision: '12',
    });
    expect(
      zonePublicationService.buildCandidateFromCurrentComputed,
    ).toHaveBeenCalledWith({ ...artifacts, sourceRevision: '12' });
  });

  it('propagates a versioned publication failure to the worker caller', async () => {
    const expectedError = new Error('candidate validation failed');
    zonePublicationService.buildCandidateFromCurrentComputed.mockRejectedValue(
      expectedError,
    );

    await expect(
      (service as any).buildVersionedPublicationIfNational({
        sourceComputedAt: new Date('2026-08-01T08:00:00Z'),
        sourceRevision: '42',
        artifactZoneCount: 12,
        geojsonUrl: 'https://example.test/zones.geojson',
        geojsonChecksum: 'a'.repeat(64),
        pmtilesUrl: 'https://example.test/zones.pmtiles',
        pmtilesChecksum: 'b'.repeat(64),
      }),
    ).rejects.toBe(expectedError);
  });

  it('rewinds persisted statistics when daily commune coverage has a gap', async () => {
    const dataSource = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM "config"')) {
          return [
            {
              computeMapDate: '2026-07-31',
              computeStatsDate: '2026-07-31',
            },
          ];
        }
        if (sql.includes('FROM "statistic_commune_snapshot"')) {
          return [];
        }
        return [{ incompleteCommuneCount: 1, expectedDayCount: 212 }];
      }),
    };
    (service as any).dataSource = dataSource;

    await expect(
      (service as any).assertHistoricCatchUpComplete('2026-07-31'),
    ).rejects.toThrow('Historic commune coverage incomplete');
    expect(configService.setConfig).toHaveBeenCalledWith(null, '2026-01-01');
  });

  it('rewinds an annual coverage gap before a later dirty boundary', async () => {
    const dataSource = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM "config"')) {
          return [
            {
              computeMapDate: '2026-07-31',
              computeStatsDate: '2026-07-31',
            },
          ];
        }
        if (sql.includes('FROM "statistic_commune_snapshot"')) {
          return [];
        }
        return [{ incompleteCommuneCount: 1, expectedDayCount: 212 }];
      }),
    };
    (service as any).dataSource = dataSource;

    await expect(
      (service as any).assertHistoricCatchUpComplete(
        '2026-07-31',
        '42',
        '2026-07-20',
      ),
    ).rejects.toThrow('Historic commune coverage incomplete');
    expect(configService.setConfig).toHaveBeenCalledWith(null, '2026-01-01');
  });

  it('preserves an older dirty boundary while repairing annual coverage', async () => {
    const dataSource = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM "config"')) {
          return [
            {
              computeMapDate: '2026-07-31',
              computeStatsDate: '2026-07-31',
            },
          ];
        }
        if (sql.includes('FROM "statistic_commune_snapshot"')) {
          return [];
        }
        return [{ incompleteCommuneCount: 1, expectedDayCount: 212 }];
      }),
    };
    (service as any).dataSource = dataSource;

    await expect(
      (service as any).assertHistoricCatchUpComplete(
        '2026-07-31',
        '42',
        '2025-12-20',
      ),
    ).rejects.toThrow('Historic commune coverage incomplete');
    expect(configService.setConfig).toHaveBeenCalledWith(null, '2025-12-20');
  });

  it('rejects a completed historic snapshot from another source revision', async () => {
    const incompatibleDate = '2026-07-22';
    const dataSource = {
      query: jest.fn(async (sql: string, parameters?: unknown[]) => {
        void parameters;
        if (sql.includes('FROM "config"')) {
          return [
            {
              computeMapDate: '2026-07-31',
              computeStatsDate: '2026-07-31',
            },
          ];
        }
        if (sql.includes('FROM "statistic_commune_snapshot"')) {
          return [{ snapshotDate: incompatibleDate }];
        }
        return [{ incompleteCommuneCount: 0, expectedDayCount: 12 }];
      }),
    };
    (service as any).dataSource = dataSource;

    await expect(
      (service as any).assertHistoricCatchUpComplete(
        '2026-07-31',
        '42',
        '2026-07-20',
      ),
    ).rejects.toThrow(
      `Historic catch-up blocked by incompatible commune snapshot ${incompatibleDate}`,
    );

    const [snapshotSql, parameters] = dataSource.query.mock.calls.find(
      ([sql]) => sql.includes('FROM "statistic_commune_snapshot"'),
    );
    expect(snapshotSql).toContain(
      '"sourceRevision" IS DISTINCT FROM $3::bigint',
    );
    expect(snapshotSql).toContain('"snapshotDate" >= $2::date');
    expect(parameters).toEqual(['2026-07-31', '2026-07-20', '42']);
    expect(configService.setConfig).toHaveBeenCalledWith(
      '2026-07-20',
      '2026-07-20',
    );
  });

  it('ignores the bootstrap barrier when validating a completed historic catch-up', async () => {
    const dataSource = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM "config"')) {
          return [
            {
              computeMapDate: '2026-07-31',
              computeStatsDate: '2026-07-31',
            },
          ];
        }
        if (sql.includes('FROM "statistic_commune_snapshot"')) {
          expect(sql).toContain('"scope" <> \'bootstrap\'');
          // A failed bootstrap row exists in production, but this query excludes it.
          return [];
        }
        return [{ incompleteCommuneCount: 0, expectedDayCount: 212 }];
      }),
    };
    (service as any).dataSource = dataSource;

    await expect(
      (service as any).assertHistoricCatchUpComplete('2026-07-31'),
    ).resolves.toBeUndefined();
    expect(configService.setConfig).not.toHaveBeenCalled();
  });

  it('publishes only immutable artifacts for a national versioned compute', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const s3Service = {
      uploadFile: jest.fn(
        async (
          file,
          prefix?: string,
          options?: { abortSignal: AbortSignal },
        ) => {
          void prefix;
          void options;
          return {
            Location: `https://immutable.test/${file.originalname}`,
          };
        },
      ),
      copyFile: jest.fn().mockResolvedValue(undefined),
    };
    const datagouvService = {
      uploadToDatagouv: jest.fn(),
    };
    (service as any).s3Service = s3Service;
    (service as any).datagouvService = datagouvService;
    (service as any).nestConfigService = {
      get: jest.fn((key: string) =>
        key === 'ZONE_PUBLICATION_S3_TIMEOUT_MS' ? '42500' : undefined,
      ),
    };

    await expect(
      (service as any).publishGeneratedZoneArtifacts({
        sourceRevision: '12',
        geojsonFile: {
          originalname: 'zones_arretes_en_vigueur.geojson',
          buffer: Buffer.from('{}'),
        },
        geojsonChecksum: 'a'.repeat(64),
        pmtilesFile: {
          originalname: 'zones_arretes_en_vigueur.pmtiles',
          buffer: Buffer.from('PMTiles-test'),
        },
        pmtilesChecksum: 'b'.repeat(64),
      }),
    ).resolves.toEqual({
      geojsonUrl: `https://immutable.test/zones_arretes_en_vigueur_${'a'.repeat(64)}.geojson`,
      pmtilesUrl: `https://immutable.test/zones_arretes_en_vigueur_${'b'.repeat(64)}.pmtiles`,
    });
    expect(s3Service.uploadFile).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenCalledWith(42_500);
    expect(
      s3Service.uploadFile.mock.calls.map(([file]) => file.originalname),
    ).toEqual([
      `zones_arretes_en_vigueur_${'a'.repeat(64)}.geojson`,
      `zones_arretes_en_vigueur_${'b'.repeat(64)}.pmtiles`,
    ]);
    expect(
      s3Service.uploadFile.mock.calls.map(([, , options]) => options),
    ).toEqual([
      {
        abortSignal: expect.any(AbortSignal),
        cacheControl: 'public, max-age=31536000, immutable',
        contentType: 'application/geo+json',
      },
      {
        abortSignal: expect.any(AbortSignal),
        cacheControl: 'public, max-age=31536000, immutable',
        contentType: 'application/vnd.pmtiles',
      },
    ]);
    expect(s3Service.uploadFile.mock.calls[0][2].abortSignal).not.toBe(
      s3Service.uploadFile.mock.calls[1][2].abortSignal,
    );
    expect(s3Service.copyFile).not.toHaveBeenCalled();
    expect(datagouvService.uploadToDatagouv).not.toHaveBeenCalled();
  });

  it('does not publish any artifact for a partial versioned compute', async () => {
    const s3Service = {
      uploadFile: jest.fn(),
      copyFile: jest.fn(),
    };
    const datagouvService = { uploadToDatagouv: jest.fn() };
    (service as any).s3Service = s3Service;
    (service as any).datagouvService = datagouvService;

    await expect(
      (service as any).publishGeneratedZoneArtifacts({
        geojsonFile: {
          originalname: 'zones_arretes_en_vigueur.geojson',
          buffer: Buffer.from('{}'),
        },
        geojsonChecksum: 'a'.repeat(64),
        pmtilesFile: {
          originalname: 'zones_arretes_en_vigueur.pmtiles',
          buffer: Buffer.from('PMTiles-test'),
        },
        pmtilesChecksum: 'b'.repeat(64),
      }),
    ).resolves.toEqual({});
    expect(s3Service.uploadFile).not.toHaveBeenCalled();
    expect(s3Service.copyFile).not.toHaveBeenCalled();
    expect(datagouvService.uploadToDatagouv).not.toHaveBeenCalled();
  });

  it('keeps the stable and data.gouv publication path when versioning is disabled', async () => {
    delete process.env.ZONE_PUBLICATION_ENABLED;
    const s3Service = {
      uploadFile: jest.fn(async (file) => ({
        Location: `https://stable.test/${file.originalname}`,
      })),
      copyFile: jest.fn().mockResolvedValue(undefined),
    };
    const datagouvService = {
      uploadToDatagouv: jest.fn().mockResolvedValue(undefined),
    };
    (service as any).s3Service = s3Service;
    (service as any).datagouvService = datagouvService;

    const computedAt = new Date('2026-07-31T12:00:00Z');
    await (service as any).publishLegacyArtifact(
      {
        originalname: 'zones_arretes_en_vigueur.geojson',
        buffer: Buffer.from('{}'),
      },
      computedAt,
      'geojson',
      'Carte des zones et arrêtés en vigueur - GeoJSON',
    );
    await (service as any).publishLegacyArtifact(
      {
        originalname: 'zones_arretes_en_vigueur.pmtiles',
        buffer: Buffer.from('PMTiles-test'),
      },
      computedAt,
      'pmtiles',
      'Carte des zones et arrêtés en vigueur - PMTILES',
    );

    expect(s3Service.uploadFile).toHaveBeenCalledTimes(2);
    expect(s3Service.copyFile.mock.calls).toEqual([
      [
        'zones_arretes_en_vigueur.geojson',
        'zones_arretes_en_vigueur_2026-07-31.geojson',
        'geojson/',
        {
          cacheControl: 'public, max-age=0, must-revalidate',
          contentType: 'application/geo+json',
        },
      ],
      [
        'zones_arretes_en_vigueur.pmtiles',
        'zones_arretes_en_vigueur_2026-07-31.pmtiles',
        'pmtiles/',
        {
          cacheControl: 'public, max-age=0, must-revalidate',
          contentType: 'application/vnd.pmtiles',
        },
      ],
    ]);
    expect(datagouvService.uploadToDatagouv).toHaveBeenCalledTimes(2);
  });

  it('preserves legacy data.gouv sequencing when a dated copy fails', async () => {
    delete process.env.ZONE_PUBLICATION_ENABLED;
    const s3Service = {
      uploadFile: jest.fn(async (file) => ({
        Location: `https://stable.test/${file.originalname}`,
      })),
      copyFile: jest.fn().mockRejectedValue(new Error('copy failed')),
    };
    const datagouvService = {
      uploadToDatagouv: jest.fn().mockResolvedValue(undefined),
    };
    (service as any).s3Service = s3Service;
    (service as any).datagouvService = datagouvService;
    jest.spyOn((service as any).logger, 'error').mockImplementation();
    const computedAt = new Date('2026-07-31T12:00:00Z');

    await (service as any).publishLegacyArtifact(
      {
        originalname: 'zones_arretes_en_vigueur.geojson',
        buffer: Buffer.from('{}'),
      },
      computedAt,
      'geojson',
      'Carte des zones et arrêtés en vigueur - GeoJSON',
    );
    expect(datagouvService.uploadToDatagouv).not.toHaveBeenCalled();

    await (service as any).publishLegacyArtifact(
      {
        originalname: 'zones_arretes_en_vigueur.pmtiles',
        buffer: Buffer.from('PMTiles-test'),
      },
      computedAt,
      'pmtiles',
      'Carte des zones et arrêtés en vigueur - PMTILES',
    );
    expect(datagouvService.uploadToDatagouv).toHaveBeenCalledTimes(1);
    expect(datagouvService.uploadToDatagouv).toHaveBeenCalledWith(
      'pmtiles',
      'https://stable.test/zones_arretes_en_vigueur.pmtiles',
      'Carte des zones et arrêtés en vigueur - PMTILES',
      true,
    );
  });

  it('signals the legacy compute date only when versioning is disabled', async () => {
    const computedAt = new Date('2026-07-31T12:00:00Z');

    await (service as any).markLegacyComputationAvailable(computedAt);
    expect(configService.setConfig).not.toHaveBeenCalled();

    delete process.env.ZONE_PUBLICATION_ENABLED;
    await (service as any).markLegacyComputationAvailable(computedAt);
    expect(configService.setConfig).toHaveBeenCalledWith(
      null,
      null,
      computedAt,
    );
  });
});

describe('withHistoricArtifactCleanup', () => {
  it('deletes generated artifacts after a successful upload action', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vigieau-historic-'));
    const geojsonPath = join(directory, 'zones.geojson');
    const pmtilesPath = join(directory, 'zones.pmtiles');
    try {
      await expect(
        withHistoricArtifactCleanup([geojsonPath, pmtilesPath], async () => {
          await writeFile(geojsonPath, '{}');
          await writeFile(pmtilesPath, 'pmtiles');
          return 'uploaded';
        }),
      ).resolves.toBe('uploaded');
      await expect(access(geojsonPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(access(pmtilesPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('deletes generated artifacts without masking the original failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vigieau-historic-'));
    const geojsonPath = join(directory, 'zones.geojson');
    const pmtilesPath = join(directory, 'zones.pmtiles');
    const uploadError = new Error('upload failed');
    try {
      await expect(
        withHistoricArtifactCleanup([geojsonPath, pmtilesPath], async () => {
          await writeFile(geojsonPath, '{}');
          await writeFile(pmtilesPath, 'pmtiles');
          throw uploadError;
        }),
      ).rejects.toBe(uploadError);
      await expect(access(geojsonPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(access(pmtilesPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('ZoneAlerteComputedHistoricService', () => {
  let service: ZoneAlerteComputedHistoricService;
  let statisticDepartementService: {
    computeDepartementStatisticsRestrictions: jest.Mock;
    sortStatDepartement: jest.Mock;
  };
  let statisticCommuneService: {
    computeCommuneStatisticsRestrictions: jest.Mock;
    sortStatCommune: jest.Mock;
  };
  let statisticService: {
    computeDepartementsSituation: jest.Mock;
    computeDepartementsSituationHistoric: jest.Mock;
  };
  let configService: {
    setConfig: jest.Mock;
    advanceComputeMapDate: jest.Mock;
    advanceComputeStatsDate: jest.Mock;
  };
  let zoneAlerteComputedHistoricRepository: {
    createQueryBuilder: jest.Mock;
    delete: jest.Mock;
  };
  let zoneAlerteService: {
    findGeometriesByIds: jest.Mock;
    findOne: jest.Mock;
  };
  let dataSource: { query: jest.Mock };
  let historicDepartmentCheckpointService: {
    purgeStaleCheckpoints: jest.Mock;
    hasAnyCheckpointForDate: jest.Mock;
    prepare: jest.Mock;
    complete: jest.Mock;
  };
  let updateAllHistoricZonesQuery: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    execute: jest.Mock;
  };
  const previousHistoricDepartmentConcurrency =
    process.env.HISTORIC_DEPARTMENT_CONCURRENCY;
  const previousHistoricSkipCommuneIntersections =
    process.env.HISTORIC_SKIP_COMMUNE_INTERSECTIONS;
  const previousHistoricDepartmentCheckpoint =
    process.env.HISTORIC_DEPARTMENT_CHECKPOINT_ENABLED;

  beforeEach(() => {
    delete process.env.HISTORIC_DEPARTMENT_CONCURRENCY;
    delete process.env.HISTORIC_SKIP_COMMUNE_INTERSECTIONS;
    delete process.env.HISTORIC_DEPARTMENT_CHECKPOINT_ENABLED;
    jest.useFakeTimers().setSystemTime(new Date('2026-06-23T12:00:00Z'));

    statisticDepartementService = {
      computeDepartementStatisticsRestrictions: jest
        .fn()
        .mockResolvedValue(undefined),
      sortStatDepartement: jest.fn().mockResolvedValue(undefined),
    };
    statisticCommuneService = {
      computeCommuneStatisticsRestrictions: jest
        .fn()
        .mockImplementation(async (...args: any[]) => {
          const hooks = args[5];
          await hooks?.beforeCommuneStatistics?.();
          await hooks?.beforeCertification?.();
        }),
      sortStatCommune: jest.fn().mockResolvedValue(undefined),
    };
    statisticService = {
      computeDepartementsSituation: jest.fn().mockResolvedValue(undefined),
      computeDepartementsSituationHistoric: jest
        .fn()
        .mockResolvedValue(undefined),
    };
    configService = {
      setConfig: jest.fn().mockResolvedValue(undefined),
      advanceComputeMapDate: jest.fn().mockResolvedValue(true),
      advanceComputeStatsDate: jest.fn().mockResolvedValue(true),
    };
    updateAllHistoricZonesQuery = {
      update: jest.fn(),
      set: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    updateAllHistoricZonesQuery.update.mockReturnValue(
      updateAllHistoricZonesQuery,
    );
    updateAllHistoricZonesQuery.set.mockReturnValue(
      updateAllHistoricZonesQuery,
    );
    updateAllHistoricZonesQuery.where.mockReturnValue(
      updateAllHistoricZonesQuery,
    );
    updateAllHistoricZonesQuery.andWhere.mockReturnValue(
      updateAllHistoricZonesQuery,
    );
    zoneAlerteComputedHistoricRepository = {
      createQueryBuilder: jest
        .fn()
        .mockReturnValue(updateAllHistoricZonesQuery),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    zoneAlerteService = {
      findGeometriesByIds: jest.fn(),
      findOne: jest.fn(),
    };
    dataSource = { query: jest.fn().mockResolvedValue([]) };
    historicDepartmentCheckpointService = {
      purgeStaleCheckpoints: jest.fn().mockResolvedValue(0),
      hasAnyCheckpointForDate: jest.fn().mockResolvedValue(false),
      prepare: jest.fn().mockResolvedValue({
        enabled: false,
        shouldCompute: true,
        reason: 'disabled',
      }),
      complete: jest.fn().mockResolvedValue(undefined),
    };

    service = new ZoneAlerteComputedHistoricService(
      {} as any,
      zoneAlerteService as any,
      {} as any,
      {} as any,
      statisticService as any,
      {
        findAllLight: jest.fn().mockResolvedValue([
          {
            id: 1,
            code: '01',
            nom: 'Ain',
            parametres: [
              {
                dateDebut: '2020-01-01',
                dateFin: null,
                superpositionCommune: 'no',
              },
            ],
          },
        ]),
      } as any,
      {} as any,
      zoneAlerteComputedHistoricRepository as any,
      {} as any,
      statisticDepartementService as any,
      statisticCommuneService as any,
      dataSource as any,
      configService as any,
      historicDepartmentCheckpointService as any,
    );
    (service as any).computeRegleAr = jest.fn().mockResolvedValue([]);
    (service as any).computeCommunesIntersected = jest
      .fn()
      .mockResolvedValue(undefined);
    (service as any).computeGeoJson = jest.fn().mockResolvedValue([
      {
        departement: { code: '01' },
        type: 'SUP',
        restriction: { niveauGravite: 'alerte' },
      },
    ]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    if (previousHistoricDepartmentConcurrency === undefined) {
      delete process.env.HISTORIC_DEPARTMENT_CONCURRENCY;
    } else {
      process.env.HISTORIC_DEPARTMENT_CONCURRENCY =
        previousHistoricDepartmentConcurrency;
    }
    if (previousHistoricSkipCommuneIntersections === undefined) {
      delete process.env.HISTORIC_SKIP_COMMUNE_INTERSECTIONS;
    } else {
      process.env.HISTORIC_SKIP_COMMUNE_INTERSECTIONS =
        previousHistoricSkipCommuneIntersections;
    }
    if (previousHistoricDepartmentCheckpoint === undefined) {
      delete process.env.HISTORIC_DEPARTMENT_CHECKPOINT_ENABLED;
    } else {
      process.env.HISTORIC_DEPARTMENT_CHECKPOINT_ENABLED =
        previousHistoricDepartmentCheckpoint;
    }
  });

  it('uses conservative historic acceleration defaults and validates overrides', () => {
    expect(readHistoricDepartmentConcurrency()).toBe(
      HISTORIC_DEPARTMENT_CONCURRENCY_DEFAULT,
    );
    expect(readHistoricDepartmentConcurrency(' 4 ')).toBe(
      HISTORIC_DEPARTMENT_CONCURRENCY_MAX,
    );
    expect(() => readHistoricDepartmentConcurrency('0')).toThrow(
      'must be a positive integer',
    );
    expect(() => readHistoricDepartmentConcurrency('5')).toThrow(
      `must be at most ${HISTORIC_DEPARTMENT_CONCURRENCY_MAX}`,
    );
    expect(readHistoricSkipCommuneIntersections()).toBe(false);
    expect(readHistoricSkipCommuneIntersections(' TRUE ')).toBe(true);
    expect(readHistoricSkipCommuneIntersections('false')).toBe(false);
    expect(() => readHistoricSkipCommuneIntersections('1')).toThrow(
      'must be true or false',
    );
  });

  it('cleans global historic residues once before computing departments', async () => {
    const events: string[] = [];
    const departments = [
      {
        id: 65,
        code: '65',
        nom: 'Hautes-Pyrenees',
        parametres: [],
      },
      {
        id: 31,
        code: '31',
        nom: 'Haute-Garonne',
        parametres: [],
      },
    ] as any;
    zoneAlerteComputedHistoricRepository.delete.mockImplementation(async () => {
      events.push('global-cleanup');
    });
    (service.computeRegleAr as jest.Mock).mockImplementation(
      async (departement) => {
        events.push(`compute-${departement.code}`);
        return [];
      },
    );

    await service.computeZonesForDate(
      moment('2026-06-22', 'YYYY-MM-DD'),
      departments,
    );

    expect(events).toEqual(['global-cleanup', 'compute-65', 'compute-31']);
    expect(zoneAlerteComputedHistoricRepository.delete).toHaveBeenCalledTimes(
      1,
    );
    expect(
      zoneAlerteComputedHistoricRepository.delete.mock.calls[0][0].departement,
    ).toMatchObject({ _type: 'isNull' });
    expect(service.computeCommunesIntersected).toHaveBeenCalledTimes(2);
  });

  it('omits historic commune intersections only when explicitly enabled', async () => {
    process.env.HISTORIC_SKIP_COMMUNE_INTERSECTIONS = 'true';
    const departments = [
      { id: 65, code: '65', nom: 'Hautes-Pyrenees', parametres: [] },
      { id: 31, code: '31', nom: 'Haute-Garonne', parametres: [] },
    ] as any;

    await service.computeZonesForDate(
      moment('2026-06-22', 'YYYY-MM-DD'),
      departments,
    );

    expect(service.computeRegleAr).toHaveBeenCalledTimes(2);
    expect(service.computeCommunesIntersected).not.toHaveBeenCalled();
  });

  it('preserves a department when its durable checkpoint is reusable', async () => {
    historicDepartmentCheckpointService.prepare.mockResolvedValue({
      enabled: true,
      shouldCompute: false,
      reason: 'resume',
    });
    const department = {
      id: 65,
      code: '65',
      nom: 'Hautes-Pyrenees',
      parametres: [],
    } as any;

    await service.computeZonesForDate(
      moment('2026-06-22', 'YYYY-MM-DD'),
      [department],
      {
        previousDate: '2026-06-21',
        historicComputeEpoch: '43',
        expectedSourceRevision: '12',
      },
    );

    expect(historicDepartmentCheckpointService.prepare).toHaveBeenCalledWith(
      department,
      expect.objectContaining({
        previousDate: '2026-06-21',
        historicComputeEpoch: '43',
        expectedSourceRevision: '12',
      }),
    );
    expect(service.computeRegleAr).not.toHaveBeenCalled();
    expect(historicDepartmentCheckpointService.complete).not.toHaveBeenCalled();
  });

  it('certifies a department only after its full computation', async () => {
    const events: string[] = [];
    historicDepartmentCheckpointService.complete.mockImplementation(
      async () => {
        events.push('checkpoint');
      },
    );
    (service.computeRegleAr as jest.Mock).mockImplementation(async () => {
      events.push('zones');
      return [];
    });
    (service.computeCommunesIntersected as jest.Mock).mockImplementation(
      async () => {
        events.push('communes');
      },
    );

    await service.computeZonesForDate(
      moment('2026-06-22', 'YYYY-MM-DD'),
      [
        {
          id: 65,
          code: '65',
          nom: 'Hautes-Pyrenees',
          parametres: [],
        },
      ] as any,
      {
        previousDate: '2026-06-21',
        historicComputeEpoch: '43',
        expectedSourceRevision: '12',
      },
    );

    expect(events).toEqual(['zones', 'communes', 'checkpoint']);
  });

  it('bounds parallel historic department computations to the configured value', async () => {
    jest.useRealTimers();
    process.env.HISTORIC_DEPARTMENT_CONCURRENCY = '2';
    const departments = [1, 2, 3, 4, 5].map((id) => ({
      id,
      code: String(id).padStart(2, '0'),
      nom: `Departement ${id}`,
      parametres: [],
    })) as any;
    let activeComputations = 0;
    let maximumActiveComputations = 0;
    (service.computeRegleAr as jest.Mock).mockImplementation(async () => {
      activeComputations += 1;
      maximumActiveComputations = Math.max(
        maximumActiveComputations,
        activeComputations,
      );
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeComputations -= 1;
      return [];
    });

    await service.computeZonesForDate(
      moment('2026-06-22', 'YYYY-MM-DD'),
      departments,
    );

    expect(service.computeRegleAr).toHaveBeenCalledTimes(5);
    expect(maximumActiveComputations).toBe(2);
  });

  it('waits for in-flight departments and stops scheduling after a parallel failure', async () => {
    jest.useRealTimers();
    process.env.HISTORIC_DEPARTMENT_CONCURRENCY = '2';
    const departments = [1, 2, 3].map((id) => ({
      id,
      code: String(id).padStart(2, '0'),
      nom: `Departement ${id}`,
      parametres: [],
    })) as any;
    const computationError = new Error('department failed');
    let releaseInFlight: () => void = () => undefined;
    (service.computeRegleAr as jest.Mock).mockImplementation(
      async (departement) => {
        if (departement.id === 1) {
          throw computationError;
        }
        await new Promise<void>((resolve) => {
          releaseInFlight = resolve;
        });
        return [];
      },
    );

    const computation = service.computeZonesForDate(
      moment('2026-06-22', 'YYYY-MM-DD'),
      departments,
    );
    let rejected = false;
    void computation.catch(() => {
      rejected = true;
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(rejected).toBe(false);
    expect(service.computeRegleAr).toHaveBeenCalledTimes(2);

    releaseInFlight();
    await expect(computation).rejects.toBe(computationError);
    expect(service.computeRegleAr).toHaveBeenCalledTimes(2);
  });

  it('removes collapsed zones from computed history before statistics', async () => {
    await service.cleanZones({ id: 65 } as any);

    const deleteCall = dataSource.query.mock.calls.find(([sql]) =>
      String(sql).includes('DELETE FROM zone_alerte_computed_historic'),
    );
    const secondRepairCall = dataSource.query.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE zone_alerte_computed_historic'),
    );
    const validationCall = dataSource.query.mock.calls.find(([sql]) =>
      String(sql).includes('AS "invalidIds"'),
    );
    expect(secondRepairCall).toBeDefined();
    expect(secondRepairCall![0]).toContain(
      `ST_CollectionExtract(\n          ST_MakeValid(geom, 'method=structure keepcollapsed=false')`,
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall![0]).toContain('ST_IsEmpty(geom)');
    expect(deleteCall![0]).toContain(
      `ST_GeometryType(geom) NOT IN ('ST_Polygon', 'ST_MultiPolygon')`,
    );
    expect(deleteCall![0]).not.toContain('OR NOT ST_IsValid(geom, 0)');
    expect(deleteCall![1]).toEqual([65]);
    expect(validationCall).toBeDefined();
    expect(validationCall![0]).toContain('NOT ST_IsValid(geom, 0)');

    const secondRepairIndex = dataSource.query.mock.calls.indexOf(
      secondRepairCall!,
    );
    const deleteIndex = dataSource.query.mock.calls.indexOf(deleteCall!);
    const validationIndex = dataSource.query.mock.calls.indexOf(
      validationCall!,
    );
    expect(secondRepairIndex).toBeLessThan(deleteIndex);
    expect(deleteIndex).toBeLessThan(validationIndex);

    const residueCleanupCall = dataSource.query.mock.calls.find(([sql]) =>
      String(sql).includes('WITH cleaned_geometries AS'),
    );
    expect(validationIndex).toBeLessThan(
      dataSource.query.mock.calls.indexOf(residueCleanupCall!),
    );
    expect(residueCleanupCall![0]).toContain('WHERE "departementId" = $1');
  });

  it('fails closed when a non-empty historic polygon remains invalid', async () => {
    dataSource.query.mockImplementation(async (sql: string) =>
      sql.includes('AS "invalidIds"')
        ? [{ invalidIds: [3418660, 3418661] }]
        : [],
    );

    await expect(service.cleanZones({ id: 65 } as any)).rejects.toThrow(
      'Geometries de zones historiques calculees invalides apres nettoyage: 3418660,3418661',
    );
    expect(
      dataSource.query.mock.calls.some(([sql]) =>
        String(sql).includes('WITH cleaned_geometries AS'),
      ),
    ).toBe(false);
  });

  it('computes statistics from dateStats onward in computed historic maps', async () => {
    await service.computeHistoricMapsComputed(
      moment('2026-06-21', 'YYYY-MM-DD'),
      moment('2026-06-22', 'YYYY-MM-DD'),
    );

    expect(
      statisticDepartementService.computeDepartementStatisticsRestrictions,
    ).toHaveBeenCalledTimes(1);
    expect(
      statisticDepartementService.computeDepartementStatisticsRestrictions.mock.calls[0][1]
        .toISOString()
        .split('T')[0],
    ).toBe('2026-06-22');
    expect(
      statisticCommuneService.computeCommuneStatisticsRestrictions,
    ).toHaveBeenCalledTimes(1);
    expect(statisticService.computeDepartementsSituation).toHaveBeenCalledWith(
      expect.any(Array),
      '2026-06-22',
    );
    expect(configService.advanceComputeStatsDate).toHaveBeenCalledWith(
      '2026-06-22',
      '0',
      '2026-06-22',
      undefined,
    );
    expect(configService.advanceComputeMapDate.mock.calls).toEqual([
      ['2026-06-21', '0', '2026-06-21', undefined],
      ['2026-06-21', '1', '2026-06-22', undefined],
    ]);
    expect(updateAllHistoricZonesQuery.set).toHaveBeenCalledWith({
      enabled: true,
    });
    expect(updateAllHistoricZonesQuery.where).toHaveBeenCalledWith('1 = 1');
  });

  it('pins every historic day and snapshot to the expected source revision', async () => {
    dataSource.query.mockImplementation(async (sql: string) =>
      sql.includes('zone_publication_source_state') ? [{ revision: '42' }] : [],
    );

    await service.computeHistoricMapsComputed(
      moment('2026-06-22', 'YYYY-MM-DD'),
      moment('2026-06-22', 'YYYY-MM-DD'),
      '2026-06-22',
      '2026-06-22',
      '12',
      '4',
      '42',
      '2026-06-22',
      '13',
    );

    expect(
      statisticCommuneService.computeCommuneStatisticsRestrictions.mock
        .calls[0][5].sourceRevision,
    ).toBe('42');
    expect(configService.advanceComputeStatsDate).toHaveBeenCalledWith(
      '2026-06-22',
      '4',
      '2026-06-22',
      '42',
    );
    expect(configService.advanceComputeMapDate).toHaveBeenCalledWith(
      '2026-06-22',
      '12',
      '2026-06-22',
      '42',
    );
    expect(historicDepartmentCheckpointService.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ code: '01' }),
      expect.objectContaining({
        previousDate: '2026-06-22',
        historicComputeEpoch: '13',
        expectedSourceRevision: '42',
      }),
    );
    expect(
      dataSource.query.mock.calls.filter(([sql]) =>
        String(sql).includes('zone_publication_source_state'),
      ),
    ).toHaveLength(3);
  });

  it('resumes a partially checkpointed D+1 after D was fully certified', async () => {
    process.env.HISTORIC_DEPARTMENT_CHECKPOINT_ENABLED = 'true';
    const log = jest.spyOn((service as any).logger, 'log');
    dataSource.query.mockImplementation(async (sql: string) =>
      sql.includes('zone_publication_source_state') ? [{ revision: '42' }] : [],
    );
    historicDepartmentCheckpointService.hasAnyCheckpointForDate.mockResolvedValueOnce(
      true,
    );
    historicDepartmentCheckpointService.prepare.mockResolvedValue({
      enabled: true,
      shouldCompute: true,
      reason: 'recompute',
      inputSignature: 'changed-input',
      materializationVersion: 'current-mode',
    });
    const computedDates: string[] = [];
    (service.computeRegleAr as jest.Mock).mockImplementation(
      async (_departement, computedFor) => {
        computedDates.push(computedFor.format('YYYY-MM-DD'));
        return [];
      },
    );

    await service.computeHistoricMapsComputed(
      moment('2026-06-21', 'YYYY-MM-DD'),
      moment('2026-06-21', 'YYYY-MM-DD'),
      '2026-06-21',
      '2026-06-21',
      '12',
      '4',
      '42',
      '2026-06-22',
      '13',
    );

    expect(
      historicDepartmentCheckpointService.purgeStaleCheckpoints,
    ).toHaveBeenCalledWith({
      historicComputeEpoch: '13',
      expectedSourceRevision: '42',
    });
    expect(
      historicDepartmentCheckpointService.hasAnyCheckpointForDate,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ _isAMomentObject: true }),
      expect.objectContaining({ _isAMomentObject: true }),
      {
        historicComputeEpoch: '13',
        expectedSourceRevision: '42',
      },
    );
    const [partialDate, completedSnapshotDate] =
      historicDepartmentCheckpointService.hasAnyCheckpointForDate.mock.calls[0];
    expect(partialDate.format('YYYY-MM-DD')).toBe('2026-06-22');
    expect(completedSnapshotDate.format('YYYY-MM-DD')).toBe('2026-06-21');
    expect(computedDates).toEqual(['2026-06-22']);
    expect(log).toHaveBeenCalledWith(
      'RESUMING PARTIAL HISTORIC DAY 2026-06-22 AFTER CERTIFIED 2026-06-21 (epoch=13, sourceRevision=42)',
    );
    expect(historicDepartmentCheckpointService.complete).toHaveBeenCalledTimes(
      1,
    );
    expect(configService.advanceComputeStatsDate).toHaveBeenCalledWith(
      '2026-06-21',
      '4',
      '2026-06-22',
      '42',
    );
    expect(configService.advanceComputeMapDate).toHaveBeenCalledWith(
      '2026-06-21',
      '12',
      '2026-06-22',
      '42',
    );
  });

  it('keeps inclusive replay when statistics lag behind the map cursor', async () => {
    process.env.HISTORIC_DEPARTMENT_CHECKPOINT_ENABLED = 'true';
    dataSource.query.mockImplementation(async (sql: string) =>
      sql.includes('zone_publication_source_state') ? [{ revision: '42' }] : [],
    );
    historicDepartmentCheckpointService.hasAnyCheckpointForDate.mockResolvedValue(
      true,
    );
    const computedDates: string[] = [];
    (service.computeRegleAr as jest.Mock).mockImplementation(
      async (_departement, computedFor) => {
        computedDates.push(computedFor.format('YYYY-MM-DD'));
        return [];
      },
    );

    await service.computeHistoricMapsComputed(
      moment('2026-06-21', 'YYYY-MM-DD'),
      moment('2026-06-20', 'YYYY-MM-DD'),
      '2026-06-21',
      '2026-06-20',
      '12',
      '4',
      '42',
      '2026-06-22',
      '13',
    );

    expect(
      historicDepartmentCheckpointService.hasAnyCheckpointForDate,
    ).not.toHaveBeenCalled();
    expect(computedDates).toEqual(['2026-06-21', '2026-06-22']);
  });

  it('does not skip the requested day when D+1 is outside the worker chunk', async () => {
    process.env.HISTORIC_DEPARTMENT_CHECKPOINT_ENABLED = 'true';
    dataSource.query.mockImplementation(async (sql: string) =>
      sql.includes('zone_publication_source_state') ? [{ revision: '42' }] : [],
    );
    historicDepartmentCheckpointService.hasAnyCheckpointForDate.mockResolvedValue(
      true,
    );
    const computedDates: string[] = [];
    (service.computeRegleAr as jest.Mock).mockImplementation(
      async (_departement, computedFor) => {
        computedDates.push(computedFor.format('YYYY-MM-DD'));
        return [];
      },
    );

    await service.computeHistoricMapsComputed(
      moment('2026-06-22', 'YYYY-MM-DD'),
      moment('2026-06-22', 'YYYY-MM-DD'),
      '2026-06-22',
      '2026-06-22',
      '12',
      '4',
      '42',
      '2026-06-22',
      '13',
    );

    expect(
      historicDepartmentCheckpointService.hasAnyCheckpointForDate,
    ).not.toHaveBeenCalled();
    expect(computedDates).toEqual(['2026-06-22']);
  });

  it('tracks the actual materialized previous day when statistics lag behind maps', async () => {
    const checkpointContexts: Array<{
      date: string;
      previousDate: string | null;
      historicComputeEpoch?: string;
    }> = [];
    historicDepartmentCheckpointService.prepare.mockImplementation(
      async (_departement, options) => {
        checkpointContexts.push({
          date: options.date.format('YYYY-MM-DD'),
          previousDate: options.previousDate,
          historicComputeEpoch: options.historicComputeEpoch,
        });
        return {
          enabled: false,
          shouldCompute: true,
          reason: 'disabled',
        };
      },
    );

    await service.computeHistoricMapsComputed(
      moment('2026-06-21', 'YYYY-MM-DD'),
      undefined,
      '2026-06-22',
      '2026-06-20',
      '12',
      '4',
      undefined,
      '2026-06-22',
      '13',
    );

    expect(checkpointContexts).toEqual([
      {
        date: '2026-06-21',
        previousDate: null,
        historicComputeEpoch: '13',
      },
      {
        date: '2026-06-22',
        previousDate: '2026-06-21',
        historicComputeEpoch: '13',
      },
    ]);
  });

  it('stops before recalculating a day whose source revision is stale', async () => {
    dataSource.query.mockResolvedValue([{ revision: '43' }]);

    await expect(
      service.computeHistoricMapsComputed(
        moment('2026-06-22', 'YYYY-MM-DD'),
        moment('2026-06-22', 'YYYY-MM-DD'),
        '2026-06-22',
        '2026-06-22',
        '12',
        '4',
        '42',
        '2026-06-22',
      ),
    ).rejects.toThrow('Historic source revision changed (42 -> 43)');

    expect((service as any).computeRegleAr).not.toHaveBeenCalled();
    expect((service as any).computeGeoJson).not.toHaveBeenCalled();
    expect(configService.advanceComputeStatsDate).not.toHaveBeenCalled();
    expect(configService.advanceComputeMapDate).not.toHaveBeenCalled();
  });

  it('detects an equal-date invalidation through its generation', async () => {
    configService.advanceComputeMapDate.mockResolvedValueOnce(false);

    await expect(
      service.computeHistoricMapsComputed(
        moment('2026-06-22', 'YYYY-MM-DD'),
        undefined,
        '2026-06-22',
        null,
        '12',
        '4',
      ),
    ).rejects.toThrow(
      'Historic map cursor changed concurrently while advancing 2026-06-22@12 -> 2026-06-22',
    );

    expect(configService.setConfig).not.toHaveBeenCalled();
  });

  it('never certifies statistics after their cursor generation changed', async () => {
    configService.advanceComputeStatsDate.mockResolvedValueOnce(false);

    await expect(
      service.computeHistoricMapsComputed(
        moment('2026-06-22', 'YYYY-MM-DD'),
        moment('2026-06-22', 'YYYY-MM-DD'),
        '2026-06-22',
        '2026-06-22',
        '12',
        '4',
      ),
    ).rejects.toThrow(
      'Historic statistics cursor changed concurrently while advancing 2026-06-22@4 -> 2026-06-22',
    );

    expect(configService.setConfig).not.toHaveBeenCalled();
    expect(configService.advanceComputeMapDate).not.toHaveBeenCalled();
  });

  it('rewinds a cursor advanced before a failed snapshot completion', async () => {
    statisticCommuneService.computeCommuneStatisticsRestrictions.mockImplementationOnce(
      async (...args: any[]) => {
        const hooks = args[5];
        await hooks?.beforeCommuneStatistics?.();
        await hooks?.beforeCertification?.();
        throw new Error('snapshot completion failed');
      },
    );

    await expect(
      service.computeHistoricMapsComputed(
        moment('2026-06-22', 'YYYY-MM-DD'),
        moment('2026-06-22', 'YYYY-MM-DD'),
        '2026-06-22',
        '2026-06-22',
        '12',
        '4',
      ),
    ).rejects.toThrow('snapshot completion failed');

    expect(configService.advanceComputeStatsDate).toHaveBeenCalled();
    expect(configService.setConfig).toHaveBeenCalledWith(
      '2026-06-22',
      '2026-06-22',
    );
    expect(configService.advanceComputeMapDate).not.toHaveBeenCalled();
  });

  it('formats legacy zones with one geometry batch and the applicable restriction', async () => {
    zoneAlerteService.findGeometriesByIds.mockResolvedValue(
      new Map([[12, '{"type":"Polygon","coordinates":[[[0,0],[1,0],[0,0]]]}']]),
    );
    const inactiveRestriction = {
      id: 1,
      arreteRestriction: { id: 98 },
      usages: [],
    };
    const applicableRestriction = {
      id: 2,
      niveauGravite: 'alerte',
      arreteRestriction: {
        id: 99,
        numero: 'AR-99',
        dateDebut: '2023-06-01',
        dateFin: '2023-06-30',
        dateSignature: '2023-05-31',
        fichier: { url: 'https://files.test/ar-99.pdf' },
      },
      usages: [
        {
          id: 3,
          nom: 'Arrosage',
          thematique: { nom: 'Jardin' },
          concerneParticulier: true,
          descriptionAlerte: 'Interdit',
        },
      ],
    };
    const zone = {
      id: 12,
      idSandre: 1200,
      nom: 'Zone test',
      code: 'ZA12',
      type: 'SUP',
      departement: { code: '12' },
      restrictions: [inactiveRestriction, applicableRestriction],
    };

    const result = await (service as any).formatLegacyHistoricZones(
      [zone],
      [99],
      moment('2023-06-01'),
    );

    expect(zoneAlerteService.findGeometriesByIds).toHaveBeenCalledWith([12]);
    expect(zoneAlerteService.findOne).not.toHaveBeenCalled();
    expect(result.zones[0].restrictions).toEqual([applicableRestriction]);
    expect(result.features[0]).toEqual(
      expect.objectContaining({
        geometry: expect.objectContaining({ type: 'Polygon' }),
        properties: expect.objectContaining({
          niveauGravite: 'alerte',
          arreteRestriction: expect.objectContaining({ id: 99 }),
          restrictions: [
            expect.objectContaining({
              nom: 'Arrosage',
              thematique: 'Jardin',
              description: 'Interdit',
            }),
          ],
        }),
      }),
    );
  });

  it('accepts a loaded empty usage list in legacy history', async () => {
    zoneAlerteService.findGeometriesByIds.mockResolvedValue(
      new Map([[12, '{"type":"Polygon","coordinates":[]}']]),
    );
    const zone = {
      id: 12,
      restrictions: [
        {
          id: 2,
          niveauGravite: 'vigilance',
          arreteRestriction: { id: 99 },
          usages: [],
        },
      ],
    };

    const result = await (service as any).formatLegacyHistoricZones(
      [zone],
      [99],
      moment('2023-06-01'),
    );

    expect(result.features[0].properties.restrictions).toEqual([]);
  });

  it('fails before loading geometries when legacy relations are incomplete', async () => {
    const zone = {
      id: 12,
      restrictions: [
        {
          id: 2,
          niveauGravite: 'alerte',
          arreteRestriction: { id: 99 },
        },
      ],
    };

    await expect(
      (service as any).formatLegacyHistoricZones(
        [zone],
        [99],
        moment('2023-06-01'),
      ),
    ).rejects.toThrow(
      'Usages were not loaded for historic zone 12 on 2023-06-01',
    );
    expect(zoneAlerteService.findGeometriesByIds).not.toHaveBeenCalled();
  });

  it('loads computed historic geometries in one query and joins by ID', async () => {
    dataSource.query.mockResolvedValue([
      { id: 2, geom: '{"type":"Polygon","coordinates":[[2]]}' },
      { id: 1, geom: '{"type":"Polygon","coordinates":[[1]]}' },
    ]);
    const zones = [
      { id: 1, restriction: undefined },
      { id: 2, restriction: undefined },
    ];

    const features = await (service as any).formatComputedHistoricZones(
      zones,
      moment('2024-04-29'),
    );

    expect(dataSource.query).toHaveBeenCalledTimes(1);
    expect(dataSource.query.mock.calls[0][0]).toContain(
      'WHERE zone.id = ANY($1::int[])',
    );
    expect(dataSource.query.mock.calls[0][0]).toContain(
      'ST_IsValid(transformed.geom, 0)',
    );
    expect(dataSource.query.mock.calls[0][0]).toContain(
      "'method=structure keepcollapsed=false'",
    );
    expect(dataSource.query.mock.calls[0][0]).toContain(
      'ST_IsEmpty(normalized.geom)',
    );
    expect(dataSource.query.mock.calls[0][1]).toEqual([[1, 2]]);
    expect(features[0].geometry.coordinates).toEqual([[1]]);
    expect(features[1].geometry.coordinates).toEqual([[2]]);
  });

  it('fails closed on an invalid computed historic geometry', async () => {
    dataSource.query.mockResolvedValue([{ id: 1, geom: 'invalid-json' }]);

    await expect(
      (service as any).formatComputedHistoricZones(
        [{ id: 1, restriction: undefined }],
        moment('2024-04-29'),
      ),
    ).rejects.toThrow('Invalid geometry for historic zone 1 on 2024-04-29');
  });

  it('fails closed when a computed historic restriction has no decree', async () => {
    dataSource.query.mockResolvedValue([
      { id: 1, geom: '{"type":"Polygon","coordinates":[]}' },
    ]);

    await expect(
      (service as any).formatComputedHistoricZones(
        [{ id: 1, restriction: { usages: [] } }],
        moment('2024-04-29'),
      ),
    ).rejects.toThrow(
      'Missing decree for computed historic zone 1 on 2024-04-29',
    );
  });
});
