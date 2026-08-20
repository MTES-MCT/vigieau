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
  buildComputedZoneGeoJsonFeature,
  readHistoricComputeChunkDays,
  ZoneAlerteComputedService,
} from './zone_alerte_computed.service';
import {
  HISTORIC_DEPARTMENT_CONCURRENCY_DEFAULT,
  HISTORIC_DEPARTMENT_CONCURRENCY_MAX,
  isHistoricEmptyStatisticsRangeEnabled,
  readHistoricDepartmentConcurrency,
  readHistoricSkipCommuneIntersections,
  withHistoricArtifactCleanup,
  ZoneAlerteComputedHistoricService,
} from './zone_alerte_computed_historic.service';
import * as emptyPmtiles from './empty-pmtiles';

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
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    isTransactionActive: boolean;
  };
  let dataSource: { createQueryRunner: jest.Mock; query: jest.Mock };
  const previousPublicationEnabled = process.env.ZONE_PUBLICATION_ENABLED;
  const previousHistoricChunkDays = process.env.HISTORIC_COMPUTE_CHUNK_DAYS;
  const previousStatisticArtifactRequired =
    process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED;

  beforeEach(() => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    process.env.HISTORIC_COMPUTE_CHUNK_DAYS = '3000';
    process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED = 'false';
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
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn().mockResolvedValue(undefined),
      isTransactionActive: false,
    };
    preflightQueryRunner.startTransaction.mockImplementation(async () => {
      preflightQueryRunner.isTransactionActive = true;
    });
    preflightQueryRunner.commitTransaction.mockImplementation(async () => {
      preflightQueryRunner.isTransactionActive = false;
    });
    preflightQueryRunner.rollbackTransaction.mockImplementation(async () => {
      preflightQueryRunner.isTransactionActive = false;
    });
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
    if (previousStatisticArtifactRequired === undefined) {
      delete process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED;
    } else {
      process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED =
        previousStatisticArtifactRequired;
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

  it('publishes the computed severity after commune harmonization', () => {
    const feature = buildComputedZoneGeoJsonFeature(
      {
        id: 2282397,
        idSandre: 1927,
        code: '84_38_0028',
        nom: 'Bievre-Liers-Valloire',
        type: 'SOU',
        niveauGravite: 'alerte_renforcee',
        departement: { code: '38', nom: 'Isere' },
        restriction: {
          niveauGravite: 'vigilance',
          arreteRestriction: {
            id: 37243,
            numero: 'AP BLV',
            dateDebut: '2026-07-10',
            dateFin: '2026-09-30',
            dateSignature: '2026-07-10',
            fichier: { url: 'https://example.test/arrete.pdf' },
          },
          usages: [
            {
              nom: 'Irrigation',
              thematique: { nom: 'Irriguer' },
              descriptionVigilance: 'Description vigilance',
              descriptionAlerte: 'Description alerte',
              descriptionAlerteRenforcee: 'Description alerte renforcee',
              descriptionCrise: 'Description crise',
              concerneParticulier: false,
              concerneEntreprise: false,
              concerneCollectivite: false,
              concerneExploitation: true,
              concerneEso: true,
              concerneEsu: false,
              concerneAep: false,
            },
          ],
        },
      } as any,
      { type: 'MultiPolygon', coordinates: [] },
    );

    expect(feature.properties.niveauGravite).toBe('alerte_renforcee');
    expect(feature.properties.restrictions[0].description).toBe(
      'Description alerte renforcee',
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

  it('prepares the historic statistic boundary atomically under the worker lock', async () => {
    preflightQueryRunner.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (sql.includes('FROM "zone_publication_source_state"')) {
        return [{ revision: '1' }];
      }
      if (sql.includes('FROM "config"')) {
        return [
          {
            computeMapDate: '2026-06-20',
            computeStatsDate: '2026-06-22',
            historicComputeEpoch: '7',
          },
        ];
      }
      if (sql.includes('FROM "statistic_publication_state"')) {
        return [
          {
            revision: '10',
            currentPublishedDate: '2026-06-23',
            historicPublishedThrough: '2026-06-21',
            historicDirtyFrom: '2026-06-21',
            historicDirtyThrough: '2026-06-21',
          },
        ];
      }
      if (sql.includes('FROM "statistic_cache_state"')) {
        return [
          {
            statisticRevision: '10',
            mode: 'legacy-bootstrap',
            currentPublishedDate: '2026-06-23',
            historicDirtyFrom: '2026-06-21',
            historicDirtyThrough: '2026-06-22',
            historicMapCursor: '2026-06-20',
            historicStatsCursor: '2026-06-22',
            sourceRevision: '1',
            historicComputeEpoch: '6',
          },
        ];
      }
      if (sql.includes('INSERT INTO "statistic_publication_state"')) {
        return [
          {
            revision: '11',
            currentPublishedDate: '2026-06-23',
            historicDirtyFrom: '2026-06-20',
            historicDirtyThrough: '2026-06-22',
          },
        ];
      }
      if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
      return [];
    });

    await expect(
      service.prepareHistoricStatisticsPublication('2026-06-22', '1'),
    ).resolves.toEqual({
      status: 'prepared',
      statisticRevision: '11',
      currentPublishedDate: '2026-06-23',
      historicDirtyFrom: '2026-06-20',
      historicDirtyThrough: '2026-06-22',
    });

    expect(preflightQueryRunner.startTransaction).toHaveBeenCalledWith(
      'SERIALIZABLE',
    );
    expect(preflightQueryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    const statements = preflightQueryRunner.query.mock.calls.map(
      ([sql]) => sql as string,
    );
    expect(
      statements.findIndex((sql) =>
        sql.includes('FROM "zone_publication_source_state"'),
      ),
    ).toBeLessThan(
      statements.findIndex((sql) => sql.includes('FROM "config"')),
    );
    expect(
      statements.findIndex((sql) => sql.includes('FROM "config"')),
    ).toBeLessThan(
      statements.findIndex((sql) =>
        sql.includes('FROM "statistic_publication_state"'),
      ),
    );
    expect(preflightQueryRunner.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO "statistic_publication_state"'),
      ['2026-06-20', '2026-06-22', true],
    );
  });

  it('cleans the historic lock session independently without masking a primary error', async () => {
    const runner = {
      rollbackTransaction: jest
        .fn()
        .mockRejectedValue(new Error('rollback failed')),
      query: jest.fn(async (sql: string) => {
        if (sql.includes('pg_advisory_unlock_all')) return [];
        throw new Error('unlock failed');
      }),
      release: jest.fn().mockResolvedValue(undefined),
    };

    await expect(
      (service as any).cleanupHistoricLockSession(
        runner,
        true,
        true,
        new Error('primary'),
      ),
    ).resolves.toBeUndefined();
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(runner.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock_all()',
    );
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it('fails successful historic work when PostgreSQL reports a retained lock', async () => {
    const runner = {
      rollbackTransaction: jest.fn(),
      query: jest.fn(async (sql: string) =>
        sql.includes('pg_advisory_unlock_all') ? [] : [{ unlocked: false }],
      ),
      release: jest.fn().mockResolvedValue(undefined),
    };

    await expect(
      (service as any).cleanupHistoricLockSession(runner, true, false, null),
    ).rejects.toThrow('Failed to clean up historic statistic lock session');
    expect(runner.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock_all()',
    );
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it('does not reopen an already published boundary on repeated scheduler ticks', async () => {
    preflightQueryRunner.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (sql.includes('FROM "zone_publication_source_state"')) {
        return [{ revision: '1' }];
      }
      if (sql.includes('FROM "config"')) {
        return [
          {
            computeMapDate: '2026-06-22',
            computeStatsDate: '2026-06-22',
            historicComputeEpoch: '7',
          },
        ];
      }
      if (sql.includes('FROM "statistic_publication_state"')) {
        return [
          {
            revision: '12',
            currentPublishedDate: '2026-06-23',
            historicPublishedThrough: '2026-06-22',
            historicDirtyFrom: null,
            historicDirtyThrough: null,
          },
        ];
      }
      if (sql.includes('FROM "statistic_cache_state"')) {
        return [
          {
            mode: 'legacy-bootstrap',
            currentPublishedDate: '2026-06-23',
            sourceRevision: '1',
            historicComputeEpoch: '7',
          },
        ];
      }
      if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
      return [];
    });

    await expect(
      service.prepareHistoricStatisticsPublication('2026-06-22', '1'),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'already-completed',
        statisticRevision: '12',
      }),
    );
    await expect(
      service.prepareHistoricStatisticsPublication('2026-06-22', '1'),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'already-completed',
        statisticRevision: '12',
      }),
    );

    expect(
      preflightQueryRunner.query.mock.calls.some(([sql]) =>
        sql.includes('INSERT INTO "statistic_publication_state"'),
      ),
    ).toBe(false);
  });

  it.each([
    ['epoch rewind', '8', true, '11'],
    ['normal cursor progress', '7', false, '10'],
  ])(
    'uses an explicit revision bump for %s with unchanged dirty bounds',
    async (_label, configEpoch, expectedForceBump, returnedRevision) => {
      preflightQueryRunner.query.mockImplementation(
        async (sql: string, parameters?: unknown[]) => {
          if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
          if (sql.includes('FROM "zone_publication_source_state"')) {
            return [{ revision: '1' }];
          }
          if (sql.includes('FROM "config"')) {
            return [
              {
                computeMapDate: '2026-06-21',
                computeStatsDate: '2026-06-22',
                historicComputeEpoch: configEpoch,
              },
            ];
          }
          if (sql.includes('FROM "statistic_publication_state"')) {
            return [
              {
                revision: '10',
                currentPublishedDate: '2026-06-23',
                historicPublishedThrough: '2026-06-19',
                historicDirtyFrom: '2026-06-20',
                historicDirtyThrough: '2026-06-22',
              },
            ];
          }
          if (sql.includes('FROM "statistic_cache_state"')) {
            return [
              {
                statisticRevision: '10',
                mode: 'legacy-bootstrap',
                currentPublishedDate: '2026-06-23',
                historicDirtyFrom: '2026-06-20',
                historicDirtyThrough: '2026-06-22',
                historicMapCursor: '2026-06-20',
                historicStatsCursor: '2026-06-20',
                sourceRevision: '1',
                historicComputeEpoch: '7',
                historicRecoveryMonthlyFrom: null,
              },
            ];
          }
          if (sql.includes('INSERT INTO "statistic_publication_state"')) {
            expect(parameters).toEqual([
              '2026-06-20',
              '2026-06-22',
              expectedForceBump,
            ]);
            return [
              {
                revision: returnedRevision,
                currentPublishedDate: '2026-06-23',
                historicDirtyFrom: '2026-06-20',
                historicDirtyThrough: '2026-06-22',
              },
            ];
          }
          if (sql.includes('pg_advisory_unlock')) {
            return [{ unlocked: true }];
          }
          return [];
        },
      );

      await expect(
        service.prepareHistoricStatisticsPublication('2026-06-22', '1'),
      ).resolves.toEqual(
        expect.objectContaining({
          status: 'prepared',
          statisticRevision: returnedRevision,
        }),
      );
    },
  );

  it('recovers only pre-existing incomplete historic snapshots before rebuilding monthly data', async () => {
    let contextReadCount = 0;
    preflightQueryRunner.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (sql.includes('AS "incompleteSnapshotDate"')) {
        contextReadCount += 1;
        return [
          {
            sourceRevision: '1',
            mapCursor: contextReadCount === 1 ? '2026-06-20' : '2026-06-21',
            statsCursor: contextReadCount === 1 ? '2026-06-20' : '2026-06-21',
            mapGeneration: contextReadCount === 1 ? '3' : '4',
            statsGeneration: contextReadCount === 1 ? '5' : '6',
            historicComputeEpoch: '7',
            currentPublishedDate: '2026-06-23',
            historicDirtyFrom: '2026-06-19',
            historicDirtyThrough: '2026-06-22',
            historicRecoveryMonthlyFrom: '2026-06-21',
            incompleteSnapshotDate:
              contextReadCount === 1 ? '2026-06-21' : null,
          },
        ];
      }
      if (sql.includes('SELECT EXISTS(SELECT 1 FROM cleared)')) {
        return [{ cleared: true }];
      }
      if (sql.includes('AS "reconciledCount"')) {
        return [{ certified: true, reconciledCount: 0 }];
      }
      if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
      return [];
    });
    (service as any).runHistoricWorker.mockResolvedValue({
      mapCursor: '2026-06-21',
      statsCursor: '2026-06-21',
      mapGeneration: '4',
      statsGeneration: '6',
    });

    await expect(
      service.recoverIncompleteHistoricSnapshots('2026-06-22', '1'),
    ).resolves.toEqual(['2026-06-21']);

    expect((service as any).runHistoricWorker).toHaveBeenCalledWith(
      'mapsComputed',
      '2026-06-21',
      '2026-06-21',
      '2026-06-20',
      '2026-06-20',
      '3',
      '5',
      '1',
      '2026-06-21',
      '7',
    );
    expect(statisticCommuneService.computeByMonth).toHaveBeenCalledWith(
      expect.objectContaining({ _isAMomentObject: true }),
    );
    expect(contextReadCount).toBe(2);
  });

  it('finishes a durable monthly recovery after a crash that already completed the snapshot', async () => {
    preflightQueryRunner.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (sql.includes('AS "incompleteSnapshotDate"')) {
        return [
          {
            sourceRevision: '1',
            mapCursor: '2026-06-21',
            statsCursor: '2026-06-21',
            mapGeneration: '4',
            statsGeneration: '6',
            historicComputeEpoch: '7',
            currentPublishedDate: '2026-06-23',
            historicDirtyFrom: '2026-06-19',
            historicDirtyThrough: '2026-06-22',
            historicRecoveryMonthlyFrom: '2026-06-21',
            incompleteSnapshotDate: null,
          },
        ];
      }
      if (sql.includes('SELECT EXISTS(SELECT 1 FROM cleared)')) {
        return [{ cleared: true }];
      }
      if (sql.includes('AS "reconciledCount"')) {
        return [{ certified: true, reconciledCount: 0 }];
      }
      if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
      return [];
    });

    await expect(
      service.recoverIncompleteHistoricSnapshots('2026-06-22', '1'),
    ).resolves.toEqual([]);

    expect((service as any).runHistoricWorker).not.toHaveBeenCalled();
    expect(statisticCommuneService.computeByMonth).toHaveBeenCalledTimes(1);
    expect(preflightQueryRunner.query).toHaveBeenCalledWith(
      expect.stringContaining('SET "historicRecoveryMonthlyFrom" = NULL'),
      ['2026-06-21', '1', '7', '2026-06-22'],
    );
  });

  it('repairs non-contiguous incomplete scopes newest-first before rewinding catch-up', async () => {
    const contexts = [
      {
        sourceRevision: '1',
        mapCursor: '2026-06-20',
        statsCursor: '2026-06-20',
        mapGeneration: '3',
        statsGeneration: '5',
        historicComputeEpoch: '7',
        currentPublishedDate: '2026-06-23',
        historicDirtyFrom: '2026-06-18',
        historicDirtyThrough: '2026-06-22',
        historicRecoveryMonthlyFrom: '2026-06-18',
        incompleteSnapshotDate: '2026-06-19',
        incompleteSnapshotScope: 'departements:02',
      },
      {
        sourceRevision: '1',
        mapCursor: '2026-06-19',
        statsCursor: '2026-06-19',
        mapGeneration: '4',
        statsGeneration: '6',
        historicComputeEpoch: '8',
        currentPublishedDate: '2026-06-23',
        historicDirtyFrom: '2026-06-18',
        historicDirtyThrough: '2026-06-22',
        historicRecoveryMonthlyFrom: '2026-06-18',
        incompleteSnapshotDate: '2026-06-19',
      },
      {
        sourceRevision: '1',
        mapCursor: '2026-06-19',
        statsCursor: '2026-06-19',
        mapGeneration: '5',
        statsGeneration: '7',
        historicComputeEpoch: '8',
        currentPublishedDate: '2026-06-23',
        historicDirtyFrom: '2026-06-18',
        historicDirtyThrough: '2026-06-22',
        historicRecoveryMonthlyFrom: '2026-06-18',
        incompleteSnapshotDate: '2026-06-18',
      },
      {
        sourceRevision: '1',
        mapCursor: '2026-06-18',
        statsCursor: '2026-06-18',
        mapGeneration: '7',
        statsGeneration: '9',
        historicComputeEpoch: '9',
        currentPublishedDate: '2026-06-23',
        historicDirtyFrom: '2026-06-18',
        historicDirtyThrough: '2026-06-22',
        historicRecoveryMonthlyFrom: '2026-06-18',
        incompleteSnapshotDate: '2026-06-18',
      },
      {
        sourceRevision: '1',
        mapCursor: '2026-06-18',
        statsCursor: '2026-06-18',
        mapGeneration: '8',
        statsGeneration: '10',
        historicComputeEpoch: '9',
        currentPublishedDate: '2026-06-23',
        historicDirtyFrom: '2026-06-18',
        historicDirtyThrough: '2026-06-22',
        historicRecoveryMonthlyFrom: '2026-06-18',
        incompleteSnapshotDate: null,
      },
    ];
    let contextIndex = 0;
    preflightQueryRunner.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (sql.includes('AS "incompleteSnapshotDate"')) {
        return [contexts[contextIndex++]];
      }
      if (sql.includes('SELECT EXISTS(SELECT 1 FROM cleared)')) {
        return [{ cleared: true }];
      }
      if (sql.includes('AS "reconciledCount"')) {
        return [{ certified: true, reconciledCount: 1 }];
      }
      if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
      return [];
    });
    (service as any).runHistoricWorker.mockImplementation(
      async (...args: unknown[]) => ({
        mapCursor: args[1],
        statsCursor: args[1],
        mapGeneration: (BigInt(String(args[5])) + 1n).toString(),
        statsGeneration: (BigInt(String(args[6])) + 1n).toString(),
      }),
    );

    await expect(
      service.recoverIncompleteHistoricSnapshots('2026-06-22', '1'),
    ).resolves.toEqual(['2026-06-19', '2026-06-18']);

    expect(configService.setConfig.mock.calls).toEqual([
      ['2026-06-19', '2026-06-19'],
      ['2026-06-18', '2026-06-18'],
    ]);
    expect((service as any).runHistoricWorker).toHaveBeenCalledTimes(2);
    expect(
      (service as any).runHistoricWorker.mock.calls.map((call) => call[1]),
    ).toEqual(['2026-06-19', '2026-06-18']);
    expect(statisticCommuneService.computeByMonth).toHaveBeenCalledTimes(1);
    expect(
      preflightQueryRunner.query.mock.calls.find(([sql]) =>
        String(sql).includes('AS "reconciledCount"'),
      )?.[1],
    ).toEqual(['2026-06-19', '1']);
    expect(
      preflightQueryRunner.query.mock.calls.find(([sql]) =>
        String(sql).includes('AS "incompleteSnapshotDate"'),
      )?.[0],
    ).toContain('snapshot."scope" <> \'bootstrap\'');
    expect(
      preflightQueryRunner.query.mock.calls.find(([sql]) =>
        String(sql).includes('AS "incompleteSnapshotDate"'),
      )?.[0],
    ).toContain('ORDER BY snapshot."snapshotDate" DESC');
    expect(
      preflightQueryRunner.query.mock.calls.some(([sql]) =>
        sql.includes('UPDATE "statistic_publication_state" statistic_state'),
      ),
    ).toBe(false);
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
      ['2026-03-25', '2026-06-22', false],
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
      [
        '2026-06-22',
        '1',
        null,
        null,
        '24',
        '2026-06-22',
        '2026-06-22',
        '370',
        '371',
      ],
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
      [
        '2026-06-22',
        '1',
        null,
        null,
        '0',
        '2026-06-22',
        '2026-06-22',
        '30',
        '31',
      ],
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

  it('finalizes a prepared publication after restart when every worker cursor is already past the boundary', async () => {
    configService.getConfig.mockResolvedValue({
      computeMapDate: '2026-06-23',
      computeStatsDate: '2026-06-23',
      computeMapGeneration: '30',
      computeStatsGeneration: '31',
      historicComputeEpoch: '7',
    });
    dataSource.query.mockImplementation(async (sql: string) => {
      if (
        sql.includes('FROM "statistic_publication_state"') &&
        !sql.includes('EXISTS(SELECT 1 FROM published)')
      ) {
        return [
          {
            revision: '11',
            currentPublishedDate: '2026-06-23',
            historicPublishedThrough: '2026-06-21',
            historicDirtyFrom: '2026-06-01',
            historicDirtyThrough: '2026-06-22',
          },
        ];
      }
      if (sql.includes('EXISTS(SELECT 1 FROM published)')) {
        return [
          {
            published: true,
            incompleteDate: null,
            currentSourceRevision: '1',
            currentStatisticRevision: '11',
            currentStatisticPublishedDate: '2026-06-23',
          },
        ];
      }
      return [];
    });
    jest
      .spyOn(service as any, 'assertHistoricCatchUpComplete')
      .mockResolvedValue(undefined);
    const boundary = jest.fn().mockResolvedValue(undefined);

    await service.computeHistoric(true, '2026-06-22', '1', boundary, {
      statisticRevision: '11',
      currentPublishedDate: '2026-06-23',
    });

    expect((service as any).runHistoricWorker).not.toHaveBeenCalled();
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('EXISTS(SELECT 1 FROM published)'),
      [
        '2026-06-22',
        '1',
        '11',
        '2026-06-23',
        '7',
        '2026-06-23',
        '2026-06-23',
        '30',
        '31',
      ],
    );
    expect(boundary).toHaveBeenCalledTimes(3);
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

  it('pins historic catch-up to a source revision in legacy publication mode', async () => {
    delete process.env.ZONE_PUBLICATION_ENABLED;
    configService.getConfig.mockResolvedValue({
      computeMapDate: null,
      computeStatsDate: null,
      computeMapGeneration: '0',
      computeStatsGeneration: '0',
      historicComputeEpoch: '0',
    });

    await service.computeHistoric(true);

    expect(zonePublicationService.getSourceRevision).toHaveBeenCalledTimes(1);
    expect((service as any).runHistoricWorker).not.toHaveBeenCalled();
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
    expect(parameters).toEqual([
      '2026-06-22',
      '1',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
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

  it('keeps the dirty publication open when a cursor is rewound before the final CAS', async () => {
    dataSource.query.mockResolvedValue([
      {
        published: false,
        incompleteDate: null,
        currentSourceRevision: '1',
        currentStatisticRevision: '11',
        currentStatisticPublishedDate: '2026-06-23',
        currentCursorState: {
          mapCursor: '2026-06-21',
          statsCursor: '2026-06-22',
          mapGeneration: '31',
          statsGeneration: '31',
          historicComputeEpoch: '8',
        },
      },
    ]);

    await expect(
      (service as any).publishHistoricStatistics(
        '2026-06-22',
        '1',
        {
          statisticRevision: '11',
          currentPublishedDate: '2026-06-23',
        },
        {
          mapCursor: '2026-06-22',
          statsCursor: '2026-06-22',
          mapGeneration: '30',
          statsGeneration: '31',
        },
        '7',
      ),
    ).rejects.toThrow('Historic cursor publication changed');

    const publicationSql = dataSource.query.mock.calls[0][0];
    expect(publicationSql).toContain('config_guard AS MATERIALIZED');
    expect(publicationSql).toContain('FOR UPDATE OF config');
    expect(publicationSql).toContain(
      'config."historicComputeEpoch" = $5::text',
    );
    expect(publicationSql).toContain('config."mapGeneration" = $8::text');
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

  it('passes a legacy scheduled date to its worker independently of versioned reuse', async () => {
    const worker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    (Worker as unknown as jest.Mock).mockReturnValue(worker);

    const compute = service.askCompute(
      [65],
      false,
      false,
      false,
      undefined,
      '2026-08-01',
    );

    expect(Worker).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        workerData: {
          depsIds: [65],
          skipIfBusy: false,
          publicationScheduledFor: '2026-08-01',
        },
      }),
    );
    worker.emit('message', { success: true });
    await expect(compute).resolves.toEqual({ success: true });
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

  it('pins a legacy computation to the scheduled date supplied by the scheduler', async () => {
    const computeAll = jest.spyOn(service, 'computeAll').mockResolvedValue({
      publicationId: undefined,
      sourceRevision: '42',
    });

    await service.computeAllOrReuseDailyPublication(
      [65],
      undefined,
      '2026-08-01',
    );

    expect(computeAll).toHaveBeenCalledWith([65], false, '2026-08-01');
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

  it('keeps web watchdog promotion-only while the dedicated worker is enabled', async () => {
    process.env.CURRENT_ZONE_RECOMPUTE_WORKER_ENABLED = 'true';
    zonePublicationService.isRecomputeRequired.mockResolvedValue(true);
    const askCompute = jest.spyOn(service, 'askCompute');

    try {
      await service.ensureFreshZonePublication();
    } finally {
      delete process.env.CURRENT_ZONE_RECOMPUTE_WORKER_ENABLED;
    }

    expect(
      zonePublicationService.promoteCertifiedPublicationIfAvailable,
    ).toHaveBeenCalledTimes(1);
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
    expect(computeGeoJson).toHaveBeenCalledWith(
      false,
      undefined,
      undefined,
      undefined,
      false,
    );
  });

  it.each([
    ['without a framework order', null, undefined],
    ['with a framework order', { id: 42 }, [42]],
  ])(
    'loads a current reference zone %s',
    async (_label, arreteCadre, expectedArreteCadreIds) => {
      const findByDepartement = jest.fn().mockResolvedValue([
        {
          id: 123,
          restrictions: [
            {
              id: 456,
              niveauGravite: 'alerte',
              zoneAlerte: { id: 789 },
              arreteCadre,
              communes: [],
            },
          ],
        },
      ]);
      const findOne = jest.fn().mockResolvedValue({
        id: 789,
        type: 'SUP',
        geom: JSON.stringify({
          type: 'MultiPolygon',
          coordinates: [
            [
              [
                [0, 0],
                [1, 0],
                [0, 1],
                [0, 0],
              ],
            ],
          ],
        }),
        arreteCadreZoneAlerteCommunes: [],
      });
      const zoneAlerteComputedRepository = {
        delete: jest.fn().mockResolvedValue(undefined),
        save: jest.fn().mockImplementation(async (zones) => zones),
      };
      Object.assign(service as any, {
        arreteResrictionService: { findByDepartement },
        zoneAlerteService: { findOne },
        zoneAlerteComputedRepository,
      });
      jest.spyOn(service, 'cleanZones').mockResolvedValue(undefined);

      const result = await service.computeRegleAr({
        id: 16,
        code: '16',
        nom: 'Charente',
        parametres: [{ disabled: false, superpositionCommune: 'yes_all' }],
      } as any);

      expect(findOne).toHaveBeenCalledWith(789, expectedArreteCadreIds);
      expect(zoneAlerteComputedRepository.save).toHaveBeenCalledWith([
        expect.objectContaining({
          id: null,
          departement: { id: 16 },
          niveauGravite: 'alerte',
          geom: expect.objectContaining({ type: 'MultiPolygon' }),
        }),
      ]);
      expect(result).toHaveLength(1);
    },
  );

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
    const residualZoneDeleteCall = dataSource.query.mock.calls.find(([sql]) =>
      String(sql).includes('DELETE FROM zone_alerte_computed zone'),
    );
    expect(residualZoneDeleteCall).toBeDefined();
    expect(residualZoneDeleteCall![0]).toContain('NOT EXISTS');
    expect(residualZoneDeleteCall![0]).toContain(
      'ST_Area(ST_Transform(dumped.geom, 2154)) > 100',
    );
    expect(residualZoneDeleteCall![1]).toEqual([65]);
    expect(
      dataSource.query.mock.calls.indexOf(residueCleanupCall!),
    ).toBeLessThan(
      dataSource.query.mock.calls.indexOf(residualZoneDeleteCall!),
    );
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

  it('prepares a guarded ready snapshot in legacy publication mode', async () => {
    delete process.env.ZONE_PUBLICATION_ENABLED;
    const computeCommuneStatisticsRestrictions = jest
      .fn()
      .mockResolvedValue(undefined);
    (service as any).statisticCommuneService = {
      computeCommuneStatisticsRestrictions,
    };

    await (service as any).computePublicationStatistics(
      [],
      new Date('2026-08-11T12:00:00.000Z'),
      false,
      false,
      '42',
      '9',
    );

    expect(computeCommuneStatisticsRestrictions.mock.calls[0][5]).toEqual(
      expect.objectContaining({
        deferCertificationUntilPublication: true,
        sourceRevision: '42',
        historicComputeEpoch: '9',
        requireNationalCoverage: true,
        publishCurrentDate: false,
      }),
    );
  });

  it('refuses the unguarded legacy historic entrypoint when artifact boundaries are required', async () => {
    delete process.env.ZONE_PUBLICATION_ENABLED;
    process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED = 'true';
    (service as any).statisticCommuneService = {
      computeCommuneStatisticsRestrictions: jest
        .fn()
        .mockResolvedValue(undefined),
    };

    await expect(
      (service as any).computePublicationStatistics(
        [],
        new Date('2026-08-11T12:00:00.000Z'),
        true,
        false,
        '42',
        '9',
      ),
    ).rejects.toThrow('Direct legacy historic computation is disabled');
  });

  it('certifies complete current statistics after a partial legacy recompute', async () => {
    delete process.env.ZONE_PUBLICATION_ENABLED;
    const computeCommuneStatisticsRestrictions = jest
      .fn()
      .mockResolvedValue(undefined);
    (service as any).statisticCommuneService = {
      computeCommuneStatisticsRestrictions,
    };

    await (service as any).computePublicationStatistics(
      [],
      new Date('2026-08-11T12:00:00.000Z'),
      false,
      false,
      '42',
      '9',
      false,
    );

    expect(computeCommuneStatisticsRestrictions.mock.calls[0][5]).toEqual(
      expect.objectContaining({
        sourceRevision: '42',
        historicComputeEpoch: '9',
        requireNationalCoverage: true,
        publishCurrentDate: false,
      }),
    );
  });

  it('keeps partial versioned statistics outside current certification', async () => {
    const computeCommuneStatisticsRestrictions = jest
      .fn()
      .mockResolvedValue(undefined);
    (service as any).statisticCommuneService = {
      computeCommuneStatisticsRestrictions,
    };

    await (service as any).computePublicationStatistics(
      [],
      new Date('2026-08-11T12:00:00.000Z'),
      false,
      true,
      '42',
      '9',
      false,
    );

    expect(computeCommuneStatisticsRestrictions.mock.calls[0][5]).toEqual(
      expect.objectContaining({
        sourceRevision: '42',
        historicComputeEpoch: '9',
        requireNationalCoverage: false,
        publishCurrentDate: false,
      }),
    );
  });

  it('captures the global revision for a national publication compute', async () => {
    configService.getConfig.mockResolvedValue({ historicComputeEpoch: '7' });
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
    expect(computeGeoJson).toHaveBeenCalledWith(
      false,
      '1',
      '2026-06-23',
      '7',
      true,
    );
  });

  it('keeps the captured business date when a national compute crosses 02:00 in Paris', async () => {
    configService.getConfig.mockResolvedValue({ historicComputeEpoch: '7' });
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

    expect(computeGeoJson).toHaveBeenCalledWith(
      false,
      '1',
      '2026-07-31',
      '7',
      true,
    );
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

  it('captures the certification context while versioned publication is disabled', async () => {
    delete process.env.ZONE_PUBLICATION_ENABLED;
    configService.getConfig.mockResolvedValue({ historicComputeEpoch: '7' });
    (service as any).departementService = {
      findAllLight: jest.fn().mockResolvedValue([]),
    };
    const computeGeoJson = jest
      .spyOn(service, 'computeGeoJson')
      .mockResolvedValue(undefined);

    await service.computeAll([], false);

    expect(zonePublicationService.getSourceRevision).toHaveBeenCalledTimes(1);
    expect(computeGeoJson).toHaveBeenCalledWith(
      false,
      '1',
      '2026-06-23',
      '7',
      true,
    );
  });

  it('captures guarded statistics context for a partial legacy compute', async () => {
    delete process.env.ZONE_PUBLICATION_ENABLED;
    configService.getConfig.mockResolvedValue({ historicComputeEpoch: '7' });
    (service as any).departementService = {
      findAllLight: jest.fn().mockResolvedValue([
        {
          id: 65,
          code: '65',
          nom: 'Hautes-Pyrenees',
          parametres: [{ disabled: false, superpositionCommune: 'no' }],
        },
      ]),
    };
    jest.spyOn(service, 'computeRegleAr').mockResolvedValue([]);
    jest
      .spyOn(service, 'computeCommunesIntersected')
      .mockResolvedValue(undefined);
    const computeGeoJson = jest
      .spyOn(service, 'computeGeoJson')
      .mockResolvedValue(undefined);

    await service.computeAll([65], false);

    expect(zonePublicationService.getSourceRevision).toHaveBeenCalledTimes(1);
    expect(computeGeoJson).toHaveBeenCalledWith(
      false,
      '1',
      '2026-06-23',
      '7',
      false,
    );
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

  it('rejects an invalid historic snapshot without replaying stale-source siblings', async () => {
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
    expect(snapshotSql).toContain('"processedCommuneCount" <>');
    expect(snapshotSql).toContain('"expectedCommuneCount"');
    expect(snapshotSql).toMatch(
      /"scope" = 'national'[\s\S]+"sourceRevision" IS DISTINCT FROM \$3::bigint/,
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

  it('separates stable legacy uploads from archive and data.gouv side effects', async () => {
    delete process.env.ZONE_PUBLICATION_ENABLED;
    const s3Service = {
      uploadFile: jest.fn(
        async (
          file: { originalname: string },
          _prefix: string,
          _options: {
            abortSignal: AbortSignal;
            cacheControl: string;
            contentType: string;
          },
        ) => {
          void _prefix;
          void _options;
          return {
            Location: `https://stable.test/${file.originalname}`,
          };
        },
      ),
      copyFile: jest.fn().mockResolvedValue(undefined),
    };
    const datagouvService = {
      uploadToDatagouv: jest.fn().mockResolvedValue(undefined),
    };
    (service as any).s3Service = s3Service;
    (service as any).datagouvService = datagouvService;
    (service as any).nestConfigService = {
      get: jest.fn().mockReturnValue('42500'),
    };

    const computedAt = new Date('2026-07-31T12:00:00Z');
    const geojsonFile = {
      originalname: 'zones_arretes_en_vigueur.geojson',
      buffer: Buffer.from('{}'),
    };
    const pmtilesFile = {
      originalname: 'zones_arretes_en_vigueur.pmtiles',
      buffer: Buffer.from('PMTiles-test'),
    };
    const stableArtifacts = await (service as any).publishLegacyZoneArtifacts({
      geojsonFile,
      pmtilesFile,
    });

    expect(stableArtifacts).toEqual({
      geojsonUrl: 'https://stable.test/zones_arretes_en_vigueur.geojson',
      pmtilesUrl: 'https://stable.test/zones_arretes_en_vigueur.pmtiles',
    });
    expect(
      s3Service.uploadFile.mock.calls.map(([file, prefix, options]) => ({
        file: file.originalname,
        prefix,
        cacheControl: options.cacheControl,
        contentType: options.contentType,
        hasAbortSignal: options.abortSignal instanceof AbortSignal,
      })),
    ).toEqual([
      {
        file: 'zones_arretes_en_vigueur.geojson',
        prefix: 'geojson/',
        cacheControl: 'public, max-age=0, must-revalidate',
        contentType: 'application/geo+json',
        hasAbortSignal: true,
      },
      {
        file: 'zones_arretes_en_vigueur.pmtiles',
        prefix: 'pmtiles/',
        cacheControl: 'public, max-age=0, must-revalidate',
        contentType: 'application/vnd.pmtiles',
        hasAbortSignal: true,
      },
    ]);
    expect(s3Service.copyFile).not.toHaveBeenCalled();
    expect(datagouvService.uploadToDatagouv).not.toHaveBeenCalled();

    await (service as any).publishLegacyZoneArtifactSideEffects({
      geojsonFile,
      geojsonUrl: stableArtifacts.geojsonUrl,
      pmtilesFile,
      pmtilesUrl: stableArtifacts.pmtilesUrl,
      date: computedAt,
    });

    expect(s3Service.uploadFile).toHaveBeenCalledTimes(2);
    expect(s3Service.copyFile.mock.calls).toEqual([
      [
        'zones_arretes_en_vigueur.geojson',
        'zones_arretes_en_vigueur_2026-07-31.geojson',
        'geojson/',
        {
          abortSignal: expect.any(AbortSignal),
          cacheControl: 'public, max-age=0, must-revalidate',
          contentType: 'application/geo+json',
        },
      ],
      [
        'zones_arretes_en_vigueur.pmtiles',
        'zones_arretes_en_vigueur_2026-07-31.pmtiles',
        'pmtiles/',
        {
          abortSignal: expect.any(AbortSignal),
          cacheControl: 'public, max-age=0, must-revalidate',
          contentType: 'application/vnd.pmtiles',
        },
      ],
    ]);
    expect(datagouvService.uploadToDatagouv).toHaveBeenCalledTimes(2);
  });

  it('keeps a ready legacy snapshot unpublished when artifact publication fails', async () => {
    delete process.env.ZONE_PUBLICATION_ENABLED;
    const directory = await mkdtemp(join(tmpdir(), 'vigieau-current-legacy-'));
    const generateEmptyPmtiles = jest
      .spyOn(emptyPmtiles, 'generateEmptyPmtiles')
      .mockImplementation(async ({ outputPath }) => {
        await writeFile(outputPath, Buffer.from('PMTiles-empty'));
      });
    const enableQueryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    const publicationError = new Error('S3 unavailable');
    const computePublicationStatistics = jest
      .spyOn(service as any, 'computePublicationStatistics')
      .mockResolvedValue(undefined);
    const publishLegacyZoneArtifacts = jest
      .spyOn(service as any, 'publishLegacyZoneArtifacts')
      .mockRejectedValue(publicationError);
    const publishLegacyZoneArtifactSideEffects = jest
      .spyOn(service as any, 'publishLegacyZoneArtifactSideEffects')
      .mockResolvedValue(undefined);
    const finalizeLegacyCurrentPublication = jest
      .fn()
      .mockResolvedValue(undefined);
    (service as any).statisticCommuneService = {
      finalizeLegacyCurrentPublication,
    };
    const markLegacyComputationAvailable = jest
      .spyOn(service as any, 'markLegacyComputationAvailable')
      .mockResolvedValue(undefined);
    (service as any).zoneAlerteComputedRepository = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn().mockReturnValue(enableQueryBuilder),
    };
    (service as any).nestConfigService = {
      get: jest.fn().mockReturnValue(directory),
    };

    try {
      await expect(
        service.computeGeoJson(false, '42', '2026-08-11', '9', false),
      ).rejects.toBe(publicationError);

      expect(computePublicationStatistics).toHaveBeenCalledTimes(1);
      expect(publishLegacyZoneArtifacts).toHaveBeenCalledTimes(1);
      expect(
        computePublicationStatistics.mock.invocationCallOrder[0],
      ).toBeLessThan(publishLegacyZoneArtifacts.mock.invocationCallOrder[0]);
      expect(finalizeLegacyCurrentPublication).not.toHaveBeenCalled();
      expect(markLegacyComputationAvailable).not.toHaveBeenCalled();
      expect(publishLegacyZoneArtifactSideEffects).not.toHaveBeenCalled();
      expect(configService.setConfig).not.toHaveBeenCalled();
    } finally {
      generateEmptyPmtiles.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('finalizes stable legacy artifacts before ignoring a side-effect failure', async () => {
    delete process.env.ZONE_PUBLICATION_ENABLED;
    const directory = await mkdtemp(join(tmpdir(), 'vigieau-current-legacy-'));
    const generateEmptyPmtiles = jest
      .spyOn(emptyPmtiles, 'generateEmptyPmtiles')
      .mockImplementation(async ({ outputPath }) => {
        await writeFile(outputPath, Buffer.from('PMTiles-empty'));
      });
    const enableQueryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    const computePublicationStatistics = jest
      .spyOn(service as any, 'computePublicationStatistics')
      .mockResolvedValue(undefined);
    const publishLegacyZoneArtifacts = jest
      .spyOn(service as any, 'publishLegacyZoneArtifacts')
      .mockResolvedValue({
        geojsonUrl: 'https://stable.test/current.geojson',
        pmtilesUrl: 'https://stable.test/current.pmtiles',
      });
    const finalizeLegacyCurrentPublication = jest
      .fn()
      .mockResolvedValue(undefined);
    (service as any).statisticCommuneService = {
      finalizeLegacyCurrentPublication,
    };
    const markLegacyComputationAvailable = jest
      .spyOn(service as any, 'markLegacyComputationAvailable')
      .mockResolvedValue(undefined);
    const sideEffectError = new Error('archive unavailable');
    const publishLegacyZoneArtifactSideEffects = jest
      .spyOn(service as any, 'publishLegacyZoneArtifactSideEffects')
      .mockRejectedValue(sideEffectError);
    const logError = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation();
    (service as any).zoneAlerteComputedRepository = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn().mockReturnValue(enableQueryBuilder),
    };
    (service as any).nestConfigService = {
      get: jest.fn().mockReturnValue(directory),
    };

    try {
      await expect(
        service.computeGeoJson(false, '42', '2026-08-11', '9', false),
      ).resolves.toEqual({
        publicationId: undefined,
        sourceRevision: '42',
      });

      expect(computePublicationStatistics).toHaveBeenCalledTimes(1);
      expect(publishLegacyZoneArtifacts).toHaveBeenCalledTimes(1);
      expect(finalizeLegacyCurrentPublication).toHaveBeenCalledWith(
        expect.any(Date),
        '42',
        '9',
      );
      expect(markLegacyComputationAvailable).toHaveBeenCalledTimes(1);
      expect(publishLegacyZoneArtifactSideEffects).toHaveBeenCalledWith({
        geojsonFile: expect.objectContaining({
          originalname: 'zones_arretes_en_vigueur.geojson',
        }),
        geojsonUrl: 'https://stable.test/current.geojson',
        pmtilesFile: expect.objectContaining({
          originalname: 'zones_arretes_en_vigueur.pmtiles',
        }),
        pmtilesUrl: 'https://stable.test/current.pmtiles',
        date: expect.any(Date),
      });
      expect(
        computePublicationStatistics.mock.invocationCallOrder[0],
      ).toBeLessThan(publishLegacyZoneArtifacts.mock.invocationCallOrder[0]);
      expect(
        publishLegacyZoneArtifacts.mock.invocationCallOrder[0],
      ).toBeLessThan(
        finalizeLegacyCurrentPublication.mock.invocationCallOrder[0],
      );
      expect(
        finalizeLegacyCurrentPublication.mock.invocationCallOrder[0],
      ).toBeLessThan(
        markLegacyComputationAvailable.mock.invocationCallOrder[0],
      );
      expect(
        markLegacyComputationAvailable.mock.invocationCallOrder[0],
      ).toBeLessThan(
        publishLegacyZoneArtifactSideEffects.mock.invocationCallOrder[0],
      );
      expect(logError).toHaveBeenCalledWith(
        'ERROR PUBLISHING LEGACY ZONE ARTIFACT SIDE EFFECTS',
        sideEffectError,
      );
    } finally {
      generateEmptyPmtiles.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('publishes the stable legacy PMTiles alias last', async () => {
    const uploadStableLegacyArtifact = jest
      .spyOn(service as any, 'uploadStableLegacyArtifact')
      .mockImplementation(async (_file, kind) => `https://stable/${kind}`);

    await (service as any).publishLegacyZoneArtifacts({
      geojsonFile: {
        originalname: 'zones_arretes_en_vigueur.geojson',
        buffer: Buffer.from('{}'),
      },
      pmtilesFile: {
        originalname: 'zones_arretes_en_vigueur.pmtiles',
        buffer: Buffer.from('PMTiles-test'),
      },
    });

    expect(
      uploadStableLegacyArtifact.mock.calls.map(([, kind]) => kind),
    ).toEqual(['geojson', 'pmtiles']);
  });

  it('keeps the stable PMTiles unchanged when GeoJSON publication fails', async () => {
    const uploadStableLegacyArtifact = jest
      .spyOn(service as any, 'uploadStableLegacyArtifact')
      .mockRejectedValueOnce(new Error('GeoJSON upload failed'));

    await expect(
      (service as any).publishLegacyZoneArtifacts({
        geojsonFile: {
          originalname: 'zones_arretes_en_vigueur.geojson',
          buffer: Buffer.from('{}'),
        },
        pmtilesFile: {
          originalname: 'zones_arretes_en_vigueur.pmtiles',
          buffer: Buffer.from('PMTiles-test'),
        },
      }),
    ).rejects.toThrow('GeoJSON upload failed');
    expect(uploadStableLegacyArtifact).toHaveBeenCalledTimes(1);
    expect(uploadStableLegacyArtifact.mock.calls[0][1]).toBe('geojson');
  });

  it('fails the legacy publication when the stable upload fails', async () => {
    const s3Service = {
      uploadFile: jest.fn().mockRejectedValue(new Error('S3 unavailable')),
      copyFile: jest.fn(),
    };
    const datagouvService = { uploadToDatagouv: jest.fn() };
    (service as any).s3Service = s3Service;
    (service as any).datagouvService = datagouvService;
    (service as any).nestConfigService = { get: jest.fn() };

    await expect(
      (service as any).uploadStableLegacyArtifact(
        {
          originalname: 'zones_arretes_en_vigueur.pmtiles',
          buffer: Buffer.from('PMTiles-test'),
        },
        'pmtiles',
      ),
    ).rejects.toThrow('S3 unavailable');
    expect(s3Service.copyFile).not.toHaveBeenCalled();
    expect(datagouvService.uploadToDatagouv).not.toHaveBeenCalled();
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

    await (service as any).publishLegacyArtifactSideEffects(
      {
        originalname: 'zones_arretes_en_vigueur.geojson',
        buffer: Buffer.from('{}'),
      },
      'https://stable.test/zones_arretes_en_vigueur.geojson',
      computedAt,
      'geojson',
      'Carte des zones et arrêtés en vigueur - GeoJSON',
    );
    expect(datagouvService.uploadToDatagouv).not.toHaveBeenCalled();

    await (service as any).publishLegacyArtifactSideEffects(
      {
        originalname: 'zones_arretes_en_vigueur.pmtiles',
        buffer: Buffer.from('PMTiles-test'),
      },
      'https://stable.test/zones_arretes_en_vigueur.pmtiles',
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
  let arreteRestrictionService: {
    findByDate: jest.Mock;
    findByDepartementAndDate: jest.Mock;
  };
  let statisticDepartementService: {
    computeDepartementStatisticsRestrictions: jest.Mock;
    sortStatDepartement: jest.Mock;
  };
  let statisticCommuneService: {
    computeCommuneStatisticsRestrictions: jest.Mock;
    computeEmptyHistoricCommuneStatisticsRange: jest.Mock;
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
    find: jest.Mock;
    save: jest.Mock;
  };
  let zoneAlerteService: {
    findByArreteRestriction: jest.Mock;
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
  const previousHistoricEmptyStatisticsRange =
    process.env.HISTORIC_EMPTY_STATISTICS_RANGE_ENABLED;
  const previousHistoricEmptyStatisticsRangeMaxDays =
    process.env.HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS;

  beforeEach(() => {
    delete process.env.HISTORIC_DEPARTMENT_CONCURRENCY;
    delete process.env.HISTORIC_SKIP_COMMUNE_INTERSECTIONS;
    delete process.env.HISTORIC_DEPARTMENT_CHECKPOINT_ENABLED;
    delete process.env.HISTORIC_EMPTY_STATISTICS_RANGE_ENABLED;
    delete process.env.HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS;
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
      computeEmptyHistoricCommuneStatisticsRange: jest
        .fn()
        .mockImplementation(async (days: any[]) => {
          for (const day of days) {
            await day.beforeCommuneStatistics?.();
          }
          for (const day of days) {
            await day.beforeCertification?.();
          }
        }),
      sortStatCommune: jest.fn().mockResolvedValue(undefined),
    };
    statisticService = {
      computeDepartementsSituation: jest.fn().mockResolvedValue(undefined),
      computeDepartementsSituationHistoric: jest
        .fn()
        .mockResolvedValue(undefined),
    };
    arreteRestrictionService = {
      findByDate: jest.fn().mockResolvedValue([]),
      findByDepartementAndDate: jest.fn().mockResolvedValue([]),
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
      find: jest.fn(),
      save: jest.fn().mockImplementation(async (zones) => zones),
    };
    zoneAlerteService = {
      findByArreteRestriction: jest.fn().mockResolvedValue([]),
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
      arreteRestrictionService as any,
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
    if (previousHistoricEmptyStatisticsRange === undefined) {
      delete process.env.HISTORIC_EMPTY_STATISTICS_RANGE_ENABLED;
    } else {
      process.env.HISTORIC_EMPTY_STATISTICS_RANGE_ENABLED =
        previousHistoricEmptyStatisticsRange;
    }
    if (previousHistoricEmptyStatisticsRangeMaxDays === undefined) {
      delete process.env.HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS;
    } else {
      process.env.HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS =
        previousHistoricEmptyStatisticsRangeMaxDays;
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
    expect(isHistoricEmptyStatisticsRangeEnabled()).toBe(false);
    expect(isHistoricEmptyStatisticsRangeEnabled(' TRUE ')).toBe(true);
    expect(isHistoricEmptyStatisticsRangeEnabled('false')).toBe(false);
    expect(() => isHistoricEmptyStatisticsRangeEnabled('1')).toThrow(
      'must be true or false',
    );
  });

  it('loads legacy historic zones with a department-scoped source query', async () => {
    const arrete = {
      id: 42,
      numero: 'DDT-42',
      dateDebut: '2024-04-01',
      dateFin: '2024-04-30',
      dateSignature: '2024-03-31',
    };
    const restriction = {
      id: 420,
      niveauGravite: 'alerte',
      arreteRestriction: arrete,
      usages: [],
    };
    const zone = {
      id: 101,
      type: 'SUP',
      departement: { code: '01' },
      restrictions: [restriction],
    };
    arreteRestrictionService.findByDepartementAndDate.mockResolvedValue([
      arrete,
    ]);
    arreteRestrictionService.findByDate.mockRejectedValue(
      new Error('national source query must not run'),
    );
    zoneAlerteService.findByArreteRestriction.mockResolvedValue([zone]);
    zoneAlerteService.findGeometriesByIds.mockResolvedValue(
      new Map([[101, '{"type":"Polygon","coordinates":[]}']]),
    );

    await expect(
      service.findLegacyHistoricDepartmentZones('01', '2024-04-15'),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 101,
        departement: { code: '01' },
        restrictions: [restriction],
        restriction,
        niveauGravite: 'alerte',
        geom: { type: 'Polygon', coordinates: [] },
      }),
    ]);

    expect(
      arreteRestrictionService.findByDepartementAndDate,
    ).toHaveBeenCalledWith(
      '01',
      expect.objectContaining({ _isAMomentObject: true }),
    );
    const [, queriedDate] =
      arreteRestrictionService.findByDepartementAndDate.mock.calls[0];
    expect(queriedDate.format('YYYY-MM-DD')).toBe('2024-04-15');
    expect(arreteRestrictionService.findByDate).not.toHaveBeenCalled();
    expect(zoneAlerteService.findByArreteRestriction).toHaveBeenCalledWith([
      42,
    ]);
  });

  it('uses the reference zone geometry when a historic restriction has no framework order', async () => {
    const departement = {
      id: 16,
      code: '16',
      nom: 'Charente',
      parametres: [
        {
          dateDebut: '2010-01-01',
          dateFin: null,
          superpositionCommune: 'yes_all',
        },
      ],
    } as any;
    arreteRestrictionService.findByDepartementAndDate.mockResolvedValue([
      {
        id: 123,
        restrictions: [
          {
            id: 456,
            niveauGravite: 'alerte',
            zoneAlerte: { id: 789 },
            arreteCadre: null,
            communes: [],
          },
        ],
      },
    ]);
    zoneAlerteService.findOne.mockResolvedValue({
      id: 789,
      type: 'SUP',
      geom: JSON.stringify({
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [0, 0],
              [1, 0],
              [0, 1],
              [0, 0],
            ],
          ],
        ],
      }),
      arreteCadreZoneAlerteCommunes: [],
    });
    (service as any).computeRegleAr =
      ZoneAlerteComputedHistoricService.prototype.computeRegleAr.bind(service);

    const result = await service.computeRegleAr(
      departement,
      moment('2014-04-23', 'YYYY-MM-DD'),
    );

    expect(zoneAlerteService.findOne).toHaveBeenCalledWith(789, undefined);
    expect(zoneAlerteComputedHistoricRepository.save).toHaveBeenCalledWith([
      expect.objectContaining({
        id: null,
        departement: { id: 16 },
        niveauGravite: 'alerte',
        geom: expect.objectContaining({ type: 'MultiPolygon' }),
      }),
    ]);
    expect(result).toHaveLength(1);
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

  it('publishes and certifies a legacy historic day without mappable source restrictions', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'vigieau-legacy-historic-empty-'),
    );
    const uploadFile = jest.fn().mockResolvedValue(undefined);
    const generateEmptyPmtiles = jest
      .spyOn(emptyPmtiles, 'generateEmptyPmtiles')
      .mockImplementation(async ({ outputPath }) => {
        await writeFile(outputPath, Buffer.from('PMTiles-empty'));
      });
    zoneAlerteService.findGeometriesByIds.mockResolvedValue(new Map());
    arreteRestrictionService.findByDate.mockResolvedValue([{ id: 20958 }]);
    dataSource.query.mockImplementation(async (sql: string) =>
      sql.includes('zone_publication_source_state')
        ? [{ revision: '42' }]
        : [
            {
              arId: 20958,
              departmentCode: null,
              zoneType: null,
              mappableCount: 0,
              sourceZoneIds: [],
            },
          ],
    );
    (service as any).nestConfigService = {
      get: jest.fn().mockReturnValue(directory),
    };
    (service as any).s3Service = { uploadFile };
    (service as any).execPromise = jest.fn();

    try {
      await expect(
        service.computeHistoricMaps(
          moment('2011-06-07', 'YYYY-MM-DD'),
          moment('2011-06-07', 'YYYY-MM-DD'),
          '2011-06-06',
          '2011-06-06',
          '12',
          '4',
          '42',
          '2011-06-07',
          '9',
        ),
      ).resolves.toEqual({
        mapCursor: '2011-06-07',
        statsCursor: '2011-06-07',
        mapGeneration: '13',
        statsGeneration: '5',
      });

      expect(arreteRestrictionService.findByDate).toHaveBeenCalledWith(
        expect.objectContaining({ _isAMomentObject: true }),
      );
      expect(zoneAlerteService.findByArreteRestriction).toHaveBeenCalledWith([
        20958,
      ]);
      expect(generateEmptyPmtiles).toHaveBeenCalledWith({
        workingDirectory: directory,
        outputPath: join(
          directory,
          'zones_arretes_en_vigueur_2011-06-07.pmtiles',
        ),
      });
      expect((service as any).execPromise).not.toHaveBeenCalled();
      expect(
        uploadFile.mock.calls.map(([file, prefix]) => [
          file.originalname,
          prefix,
        ]),
      ).toEqual([
        ['zones_arretes_en_vigueur_2011-06-07.pmtiles', 'pmtiles/'],
        ['zones_arretes_en_vigueur_2011-06-07.geojson', 'geojson/'],
      ]);
      const geojsonUpload = uploadFile.mock.calls.find(
        ([file, prefix]) =>
          prefix === 'geojson/' && file.originalname.endsWith('.geojson'),
      );
      expect(JSON.parse(geojsonUpload?.[0].buffer.toString())).toEqual({
        type: 'FeatureCollection',
        features: [],
      });
      expect(
        statisticDepartementService.computeDepartementStatisticsRestrictions,
      ).toHaveBeenCalledWith([], new Date('2011-06-07'), true, true);
      expect(
        statisticCommuneService.computeCommuneStatisticsRestrictions,
      ).toHaveBeenCalledWith(
        [],
        new Date('2011-06-07'),
        true,
        true,
        undefined,
        expect.any(Object),
      );
      expect(
        statisticCommuneService.computeEmptyHistoricCommuneStatisticsRange,
      ).not.toHaveBeenCalled();
      expect(
        statisticCommuneService.computeCommuneStatisticsRestrictions.mock
          .calls[0][5],
      ).toEqual(
        expect.objectContaining({
          sourceRevision: '42',
          historicComputeEpoch: '9',
        }),
      );
      expect(
        statisticService.computeDepartementsSituationHistoric,
      ).toHaveBeenCalledWith([], '2011-06-07');
      expect(configService.advanceComputeStatsDate).toHaveBeenCalledWith(
        '2011-06-06',
        '4',
        '2011-06-07',
        '42',
      );
      expect(configService.advanceComputeMapDate).toHaveBeenCalledWith(
        '2011-06-06',
        '12',
        '2011-06-07',
        '42',
      );
    } finally {
      generateEmptyPmtiles.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('batches certified empty legacy days only when the dedicated flag is enabled', async () => {
    process.env.HISTORIC_EMPTY_STATISTICS_RANGE_ENABLED = 'true';
    process.env.HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS = '2';
    const directory = await mkdtemp(
      join(tmpdir(), 'vigieau-legacy-historic-empty-range-'),
    );
    const uploadFile = jest.fn().mockResolvedValue(undefined);
    const generateEmptyPmtiles = jest
      .spyOn(emptyPmtiles, 'generateEmptyPmtiles')
      .mockImplementation(async ({ outputPath }) => {
        await writeFile(outputPath, Buffer.from('PMTiles-empty'));
      });
    zoneAlerteService.findGeometriesByIds.mockResolvedValue(new Map());
    arreteRestrictionService.findByDate.mockResolvedValue([]);
    dataSource.query.mockImplementation(async (sql: string) =>
      sql.includes('zone_publication_source_state') ? [{ revision: '42' }] : [],
    );
    (service as any).nestConfigService = {
      get: jest.fn().mockReturnValue(directory),
    };
    (service as any).s3Service = { uploadFile };

    try {
      await expect(
        service.computeHistoricMaps(
          moment('2011-06-07', 'YYYY-MM-DD'),
          moment('2011-06-07', 'YYYY-MM-DD'),
          '2011-06-06',
          '2011-06-06',
          '12',
          '4',
          '42',
          '2011-06-09',
          '9',
        ),
      ).resolves.toEqual({
        mapCursor: '2011-06-09',
        statsCursor: '2011-06-09',
        mapGeneration: '15',
        statsGeneration: '7',
      });

      expect(
        statisticCommuneService.computeEmptyHistoricCommuneStatisticsRange,
      ).toHaveBeenCalledTimes(2);
      expect(
        statisticCommuneService.computeEmptyHistoricCommuneStatisticsRange.mock.calls.map(
          ([days, options]) => ({
            dates: days.map((day) => day.date.toISOString().slice(0, 10)),
            options,
          }),
        ),
      ).toEqual([
        {
          dates: ['2011-06-07', '2011-06-08'],
          options: { sourceRevision: '42', historicComputeEpoch: '9' },
        },
        {
          dates: ['2011-06-09'],
          options: { sourceRevision: '42', historicComputeEpoch: '9' },
        },
      ]);
      expect(
        statisticCommuneService.computeCommuneStatisticsRestrictions,
      ).not.toHaveBeenCalled();
      expect(configService.advanceComputeStatsDate.mock.calls).toEqual([
        ['2011-06-06', '4', '2011-06-07', '42'],
        ['2011-06-07', '5', '2011-06-08', '42'],
        ['2011-06-08', '6', '2011-06-09', '42'],
      ]);
      expect(configService.advanceComputeMapDate.mock.calls).toEqual([
        ['2011-06-06', '12', '2011-06-07', '42'],
        ['2011-06-07', '13', '2011-06-08', '42'],
        ['2011-06-08', '14', '2011-06-09', '42'],
      ]);
      expect(
        statisticDepartementService.computeDepartementStatisticsRestrictions,
      ).toHaveBeenCalledTimes(3);
      expect(
        statisticService.computeDepartementsSituationHistoric,
      ).toHaveBeenCalledTimes(3);
      expect(generateEmptyPmtiles).toHaveBeenCalledTimes(3);
      expect(uploadFile).toHaveBeenCalledTimes(6);
    } finally {
      generateEmptyPmtiles.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('flushes a pending empty range before processing the next non-empty day', async () => {
    process.env.HISTORIC_EMPTY_STATISTICS_RANGE_ENABLED = 'true';
    process.env.HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS = '7';
    const directory = await mkdtemp(
      join(tmpdir(), 'vigieau-legacy-historic-empty-then-nonempty-'),
    );
    const uploadFile = jest.fn().mockResolvedValue(undefined);
    const generateEmptyPmtiles = jest
      .spyOn(emptyPmtiles, 'generateEmptyPmtiles')
      .mockImplementation(async ({ outputPath }) => {
        await writeFile(outputPath, Buffer.from('PMTiles-empty'));
      });
    const zone = {
      id: 101,
      type: 'SUP',
      departement: { code: '01' },
      restrictions: [{ niveauGravite: 'vigilance' }],
    } as any;
    const formatLegacyHistoricZones = jest
      .spyOn(service as any, 'formatLegacyHistoricZones')
      .mockResolvedValueOnce({ features: [], zones: [] })
      .mockResolvedValueOnce({ features: [], zones: [zone] });
    jest
      .spyOn(service as any, 'assertHistoricSourceCoverage')
      .mockResolvedValue(undefined);
    dataSource.query.mockImplementation(async (sql: string) =>
      sql.includes('zone_publication_source_state') ? [{ revision: '42' }] : [],
    );
    (service as any).nestConfigService = {
      get: jest.fn().mockReturnValue(directory),
    };
    (service as any).s3Service = { uploadFile };

    try {
      await service.computeHistoricMaps(
        moment('2011-06-07', 'YYYY-MM-DD'),
        moment('2011-06-07', 'YYYY-MM-DD'),
        '2011-06-06',
        '2011-06-06',
        '12',
        '4',
        '42',
        '2011-06-08',
        '9',
      );

      expect(
        statisticCommuneService.computeEmptyHistoricCommuneStatisticsRange,
      ).toHaveBeenCalledTimes(1);
      expect(
        statisticCommuneService.computeEmptyHistoricCommuneStatisticsRange.mock.calls[0][0].map(
          (day) => day.date.toISOString().slice(0, 10),
        ),
      ).toEqual(['2011-06-07']);
      expect(
        statisticCommuneService.computeCommuneStatisticsRestrictions,
      ).toHaveBeenCalledTimes(1);
      expect(
        statisticCommuneService.computeEmptyHistoricCommuneStatisticsRange.mock
          .invocationCallOrder[0],
      ).toBeLessThan(
        statisticCommuneService.computeCommuneStatisticsRestrictions.mock
          .invocationCallOrder[0],
      );
      expect(configService.advanceComputeStatsDate.mock.calls).toEqual([
        ['2011-06-06', '4', '2011-06-07', '42'],
        ['2011-06-07', '5', '2011-06-08', '42'],
      ]);
      expect(configService.advanceComputeMapDate.mock.calls).toEqual([
        ['2011-06-06', '12', '2011-06-07', '42'],
        ['2011-06-07', '13', '2011-06-08', '42'],
      ]);
      expect(
        statisticCommuneService.computeCommuneStatisticsRestrictions.mock
          .calls[0][5],
      ).toEqual(
        expect.objectContaining({
          sourceRevision: '42',
          historicComputeEpoch: '9',
        }),
      );
    } finally {
      formatLegacyHistoricZones.mockRestore();
      generateEmptyPmtiles.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rewinds the historic cursors when an empty range fails after a daily CAS', async () => {
    process.env.HISTORIC_EMPTY_STATISTICS_RANGE_ENABLED = 'true';
    const directory = await mkdtemp(
      join(tmpdir(), 'vigieau-legacy-historic-empty-range-failure-'),
    );
    const uploadFile = jest.fn().mockResolvedValue(undefined);
    const generateEmptyPmtiles = jest
      .spyOn(emptyPmtiles, 'generateEmptyPmtiles')
      .mockImplementation(async ({ outputPath }) => {
        await writeFile(outputPath, Buffer.from('PMTiles-empty'));
      });
    statisticCommuneService.computeEmptyHistoricCommuneStatisticsRange.mockImplementationOnce(
      async (days: any[]) => {
        for (const day of days) {
          await day.beforeCommuneStatistics?.();
        }
        await days[0].beforeCertification?.();
        throw new Error('empty range completion failed');
      },
    );
    dataSource.query.mockImplementation(async (sql: string) =>
      sql.includes('zone_publication_source_state') ? [{ revision: '42' }] : [],
    );
    (service as any).nestConfigService = {
      get: jest.fn().mockReturnValue(directory),
    };
    (service as any).s3Service = { uploadFile };

    try {
      await expect(
        service.computeHistoricMaps(
          moment('2011-06-07', 'YYYY-MM-DD'),
          moment('2011-06-07', 'YYYY-MM-DD'),
          '2011-06-06',
          '2011-06-06',
          '12',
          '4',
          '42',
          '2011-06-08',
          '9',
        ),
      ).rejects.toThrow('empty range completion failed');

      expect(configService.advanceComputeStatsDate).toHaveBeenCalledTimes(1);
      expect(configService.advanceComputeStatsDate).toHaveBeenCalledWith(
        '2011-06-06',
        '4',
        '2011-06-07',
        '42',
      );
      expect(configService.setConfig).toHaveBeenCalledWith(
        '2011-06-07',
        '2011-06-07',
      );
      expect(configService.advanceComputeMapDate).not.toHaveBeenCalled();
      expect(
        statisticCommuneService.computeCommuneStatisticsRestrictions,
      ).not.toHaveBeenCalled();
    } finally {
      generateEmptyPmtiles.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an empty legacy artifact when source restrictions are mappable', async () => {
    process.env.HISTORIC_EMPTY_STATISTICS_RANGE_ENABLED = 'true';
    arreteRestrictionService.findByDate.mockResolvedValue([{ id: 42 }]);
    dataSource.query.mockImplementation(async (sql: string) =>
      sql.includes('zone_publication_source_state')
        ? [{ revision: '42' }]
        : [
            {
              arId: 42,
              departmentCode: '01',
              zoneType: 'SUP',
              mappableCount: 1,
              sourceZoneIds: [101],
            },
          ],
    );
    const uploadFile = jest.fn();
    const generateEmptyPmtiles = jest.spyOn(
      emptyPmtiles,
      'generateEmptyPmtiles',
    );
    (service as any).nestConfigService = {
      get: jest.fn().mockReturnValue(tmpdir()),
    };
    (service as any).s3Service = { uploadFile };

    try {
      await expect(
        service.computeHistoricMaps(
          moment('2011-06-07', 'YYYY-MM-DD'),
          moment('2011-06-07', 'YYYY-MM-DD'),
          '2011-06-06',
          '2011-06-06',
          '12',
          '4',
          '42',
          '2011-06-07',
          '9',
        ),
      ).rejects.toThrow(
        'Historic map 2011-06-07 source coverage mismatch (missing=01, unexpected=none)',
      );

      expect(generateEmptyPmtiles).not.toHaveBeenCalled();
      expect(uploadFile).not.toHaveBeenCalled();
      expect(
        statisticCommuneService.computeCommuneStatisticsRestrictions,
      ).not.toHaveBeenCalled();
      expect(
        statisticCommuneService.computeEmptyHistoricCommuneStatisticsRange,
      ).not.toHaveBeenCalled();
      expect(configService.advanceComputeMapDate).not.toHaveBeenCalled();
      expect(configService.advanceComputeStatsDate).not.toHaveBeenCalled();
    } finally {
      generateEmptyPmtiles.mockRestore();
    }
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

  it('certifies statistics and cursors for a historic day without zones', async () => {
    (service as any).computeGeoJson = jest.fn().mockResolvedValue([]);

    await service.computeHistoricMapsComputed(
      moment('2024-04-29', 'YYYY-MM-DD'),
      moment('2024-04-29', 'YYYY-MM-DD'),
      '2024-04-28',
      '2024-04-28',
      '12',
      '4',
      undefined,
      '2024-04-29',
    );

    expect(
      statisticDepartementService.computeDepartementStatisticsRestrictions,
    ).toHaveBeenCalledWith([], new Date('2024-04-29'), true);
    expect(
      statisticCommuneService.computeCommuneStatisticsRestrictions,
    ).toHaveBeenCalledWith(
      [],
      new Date('2024-04-29'),
      true,
      false,
      undefined,
      expect.any(Object),
    );
    expect(statisticService.computeDepartementsSituation).toHaveBeenCalledWith(
      [],
      '2024-04-29',
    );
    expect(configService.advanceComputeStatsDate).toHaveBeenCalledWith(
      '2024-04-28',
      '4',
      '2024-04-29',
      undefined,
    );
    expect(configService.advanceComputeMapDate).toHaveBeenCalledWith(
      '2024-04-28',
      '12',
      '2024-04-29',
      undefined,
    );
  });

  it('uses the empty PMTiles generator for computed historic artifacts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vigieau-historic-empty-'));
    const uploadFile = jest.fn().mockResolvedValue(undefined);
    const generateEmptyPmtiles = jest
      .spyOn(emptyPmtiles, 'generateEmptyPmtiles')
      .mockImplementation(async ({ outputPath }) => {
        await writeFile(outputPath, Buffer.from('PMTiles-empty'));
      });
    zoneAlerteComputedHistoricRepository.find.mockResolvedValue([]);
    (service as any).nestConfigService = {
      get: jest.fn().mockReturnValue(directory),
    };
    (service as any).s3Service = { uploadFile };
    (service as any).execPromise = jest.fn();
    (service as any).computeGeoJson =
      ZoneAlerteComputedHistoricService.prototype.computeGeoJson.bind(service);

    try {
      await expect(
        service.computeGeoJson(moment('2024-04-29', 'YYYY-MM-DD')),
      ).resolves.toEqual([]);

      const geojsonUpload = uploadFile.mock.calls.find(
        ([file, prefix]) =>
          prefix === 'geojson/' && file.originalname.endsWith('.geojson'),
      );
      expect(JSON.parse(geojsonUpload?.[0].buffer.toString())).toEqual({
        type: 'FeatureCollection',
        features: [],
      });
      expect(generateEmptyPmtiles).toHaveBeenCalledWith({
        workingDirectory: directory,
        outputPath: join(
          directory,
          'zones_arretes_en_vigueur_2024-04-29.pmtiles',
        ),
      });
      expect((service as any).execPromise).not.toHaveBeenCalled();
      expect(
        uploadFile.mock.calls.map(([file, prefix]) => [
          file.originalname,
          prefix,
        ]),
      ).toEqual([
        ['zones_arretes_en_vigueur_2024-04-29.pmtiles', 'pmtiles/'],
        ['zones_arretes_en_vigueur_2024-04-29.geojson', 'geojson/'],
      ]);
    } finally {
      generateEmptyPmtiles.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an empty computed artifact when source restrictions are mappable', async () => {
    zoneAlerteComputedHistoricRepository.find.mockResolvedValue([]);
    arreteRestrictionService.findByDate.mockResolvedValue([{ id: 42 }]);
    dataSource.query.mockResolvedValue([
      {
        arId: 42,
        departmentCode: '01',
        zoneType: 'SUP',
        mappableCount: 1,
        sourceZoneIds: [101],
      },
    ]);
    const uploadFile = jest.fn();
    const generateEmptyPmtiles = jest.spyOn(
      emptyPmtiles,
      'generateEmptyPmtiles',
    );
    (service as any).nestConfigService = {
      get: jest.fn().mockReturnValue(tmpdir()),
    };
    (service as any).s3Service = { uploadFile };
    (service as any).computeGeoJson =
      ZoneAlerteComputedHistoricService.prototype.computeGeoJson.bind(service);

    try {
      await expect(
        service.computeGeoJson(moment('2024-04-29', 'YYYY-MM-DD')),
      ).rejects.toThrow(
        'Historic map 2024-04-29 source coverage mismatch (missing=01, unexpected=none)',
      );

      expect(generateEmptyPmtiles).not.toHaveBeenCalled();
      expect(uploadFile).not.toHaveBeenCalled();
      expect(dataSource.query.mock.calls[0][0]).toContain(
        'FROM "restriction_commune" commune_source',
      );
      expect(configService.advanceComputeMapDate).not.toHaveBeenCalled();
      expect(configService.advanceComputeStatsDate).not.toHaveBeenCalled();
    } finally {
      generateEmptyPmtiles.mockRestore();
    }
  });

  it('rejects an active computed source order without a mappable restriction', async () => {
    dataSource.query.mockResolvedValue([
      {
        arId: 42,
        departmentCode: '01',
        zoneType: null,
        mappableCount: 0,
        sourceZoneIds: [],
      },
    ]);

    await expect(
      (service as any).assertHistoricSourceCoverage(
        [42],
        [],
        moment('2024-04-29', 'YYYY-MM-DD'),
        'computed',
      ),
    ).rejects.toThrow(
      'Historic map 2024-04-29 has active source order(s) without mappable restrictions: 42',
    );
  });

  it('rejects a missing computed department even when another department has zones', async () => {
    dataSource.query.mockResolvedValue([
      {
        arId: 42,
        departmentCode: '01',
        zoneType: 'SUP',
        mappableCount: 1,
        sourceZoneIds: [101],
      },
      {
        arId: 43,
        departmentCode: '02',
        zoneType: 'SOU',
        mappableCount: 1,
        sourceZoneIds: [102],
      },
    ]);

    await expect(
      (service as any).assertHistoricSourceCoverage(
        [42, 43],
        [
          {
            type: 'SUP',
            departement: { code: '01' },
            restriction: { arreteRestriction: { id: 42 } },
          },
        ],
        moment('2024-04-29', 'YYYY-MM-DD'),
        'computed',
      ),
    ).rejects.toThrow(
      'Historic map 2024-04-29 source coverage mismatch (missing=02, unexpected=none)',
    );
  });

  it('rejects a missing computed source type within a present department', async () => {
    dataSource.query.mockResolvedValue([
      {
        arId: 42,
        departmentCode: '01',
        zoneType: 'SUP',
        mappableCount: 1,
        sourceZoneIds: [101],
      },
      {
        arId: 43,
        departmentCode: '01',
        zoneType: 'SOU',
        mappableCount: 1,
        sourceZoneIds: [102],
      },
    ]);

    await expect(
      (service as any).assertHistoricSourceCoverage(
        [42, 43],
        [
          {
            type: 'SUP',
            departement: { code: '01' },
            restriction: { arreteRestriction: { id: 42 } },
          },
        ],
        moment('2024-04-29', 'YYYY-MM-DD'),
        'computed',
      ),
    ).rejects.toThrow(
      'Historic map 2024-04-29 source department/type coverage mismatch (missing=01:SOU)',
    );
  });

  it('rejects a missing legacy zone within a present department', async () => {
    dataSource.query.mockResolvedValue([
      {
        arId: 42,
        departmentCode: '01',
        zoneType: 'SUP',
        mappableCount: 2,
        sourceZoneIds: [101, 102],
      },
    ]);

    await expect(
      (service as any).assertHistoricSourceCoverage(
        [42],
        [{ id: 101, type: 'SUP', departement: { code: '01' } }],
        moment('2024-04-28', 'YYYY-MM-DD'),
        'legacy',
      ),
    ).rejects.toThrow(
      'Historic map 2024-04-28 zone coverage mismatch (missing=102, unexpected=none)',
    );
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
    expect(
      statisticCommuneService.computeCommuneStatisticsRestrictions.mock
        .calls[0][5].historicComputeEpoch,
    ).toBe('13');
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

  it('selects the newest active restriction regardless of input order or severity', async () => {
    zoneAlerteService.findGeometriesByIds.mockResolvedValue(
      new Map([
        [12, '{"type":"Polygon","coordinates":[]}'],
        [13, '{"type":"Polygon","coordinates":[]}'],
      ]),
    );
    const olderRestriction = {
      id: 1,
      niveauGravite: 'crise',
      arreteRestriction: {
        id: 98,
        dateDebut: '2023-06-01',
        dateSignature: '2023-05-31',
      },
      usages: [],
    };
    const newerRestriction = {
      id: 2,
      niveauGravite: 'vigilance',
      arreteRestriction: {
        id: 99,
        dateDebut: '2023-06-02',
        dateSignature: '2023-06-01',
      },
      usages: [],
    };

    const result = await (service as any).formatLegacyHistoricZones(
      [
        { id: 12, restrictions: [olderRestriction, newerRestriction] },
        { id: 13, restrictions: [newerRestriction, olderRestriction] },
      ],
      [98, 99],
      moment('2023-06-02'),
    );

    expect(
      result.features.map((feature) => ({
        arreteId: feature.properties.arreteRestriction.id,
        niveauGravite: feature.properties.niveauGravite,
      })),
    ).toEqual([
      { arreteId: 99, niveauGravite: 'vigilance' },
      { arreteId: 99, niveauGravite: 'vigilance' },
    ]);
  });

  it('uses the signature date to choose between restrictions with the same start date', async () => {
    zoneAlerteService.findGeometriesByIds.mockResolvedValue(
      new Map([[12, '{"type":"Polygon","coordinates":[]}']]),
    );
    const result = await (service as any).formatLegacyHistoricZones(
      [
        {
          id: 12,
          restrictions: [
            {
              id: 1,
              niveauGravite: 'crise',
              arreteRestriction: {
                id: 100,
                dateDebut: '2023-06-01',
                dateSignature: '2023-05-30',
              },
              usages: [],
            },
            {
              id: 2,
              niveauGravite: 'alerte',
              arreteRestriction: {
                id: 99,
                dateDebut: '2023-06-01',
                dateSignature: '2023-05-31',
              },
              usages: [],
            },
          ],
        },
      ],
      [99, 100],
      moment('2023-06-01'),
    );

    expect(result.features[0].properties.arreteRestriction.id).toBe(99);
  });

  it('uses the decree ID to break equal start and signature dates', async () => {
    zoneAlerteService.findGeometriesByIds.mockResolvedValue(
      new Map([[12, '{"type":"Polygon","coordinates":[]}']]),
    );
    const result = await (service as any).formatLegacyHistoricZones(
      [
        {
          id: 12,
          restrictions: [
            {
              id: 1,
              niveauGravite: 'crise',
              arreteRestriction: {
                id: 99,
                dateDebut: '2023-06-01',
                dateSignature: '2023-05-31',
              },
              usages: [],
            },
            {
              id: 2,
              niveauGravite: 'alerte',
              arreteRestriction: {
                id: 100,
                dateDebut: '2023-06-01',
                dateSignature: '2023-05-31',
              },
              usages: [],
            },
          ],
        },
      ],
      [99, 100],
      moment('2023-06-01'),
    );

    expect(result.features[0].properties.arreteRestriction.id).toBe(100);
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

  it('treats an omitted legacy usage relation as an empty list', async () => {
    zoneAlerteService.findGeometriesByIds.mockResolvedValue(
      new Map([[12, '{"type":"Polygon","coordinates":[]}']]),
    );
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

    const result = await (service as any).formatLegacyHistoricZones(
      [zone],
      [99],
      moment('2023-06-01'),
    );

    expect(result.features[0].properties.restrictions).toEqual([]);
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

  it('treats an omitted computed historic usage relation as an empty list', async () => {
    dataSource.query.mockResolvedValue([
      { id: 1, geom: '{"type":"Polygon","coordinates":[]}' },
    ]);

    const features = await (service as any).formatComputedHistoricZones(
      [
        {
          id: 1,
          restriction: {
            niveauGravite: 'vigilance',
            arreteRestriction: { id: 99 },
          },
        },
      ],
      moment('2024-04-29'),
    );

    expect(features[0].properties.restrictions).toEqual([]);
  });

  it('publishes the harmonized severity in computed historic maps', async () => {
    dataSource.query.mockResolvedValue([
      { id: 1, geom: '{"type":"Polygon","coordinates":[]}' },
    ]);

    const features = await (service as any).formatComputedHistoricZones(
      [
        {
          id: 1,
          niveauGravite: 'alerte_renforcee',
          restriction: {
            niveauGravite: 'vigilance',
            arreteRestriction: { id: 99 },
            usages: [
              {
                id: 10,
                nom: 'Irrigation',
                thematique: { nom: 'Irriguer' },
                descriptionVigilance: 'Description vigilance',
                descriptionAlerteRenforcee: 'Description alerte renforcee',
              },
            ],
          },
        },
      ],
      moment('2024-04-29'),
    );

    expect(features[0].properties.niveauGravite).toBe('alerte_renforcee');
    expect(features[0].properties.restrictions[0].description).toBe(
      'Description alerte renforcee',
    );
  });
});
