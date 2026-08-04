import { EventEmitter } from 'node:events';
import { Worker } from 'worker_threads';
import moment from 'moment';
import {
  HISTORIC_COMPUTE_WORKER_TIMEOUT_MS,
  ZONE_COMPUTE_WORKER_TIMEOUT_MS,
  ZoneAlerteComputedService,
} from './zone_alerte_computed.service';
import { ZoneAlerteComputedHistoricService } from './zone_alerte_computed_historic.service';

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
    getSourceRevision: jest.Mock;
    isRecomputeRequired: jest.Mock;
  };
  const previousPublicationEnabled = process.env.ZONE_PUBLICATION_ENABLED;

  beforeEach(() => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
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
      getSourceRevision: jest.fn().mockResolvedValue('1'),
      isRecomputeRequired: jest.fn().mockResolvedValue(false),
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
      {} as any,
      configService as any,
      zonePublicationService as any,
    );
    (service as any).runHistoricWorker = jest.fn().mockResolvedValue({
      mapCursor: '2024-04-28',
      statsCursor: '2024-04-28',
      mapGeneration: '370',
      statsGeneration: '371',
    });
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
  });

  it('runs legacy then computed historic workers when the dirty date predates computed maps', async () => {
    configService.getConfig
      .mockResolvedValueOnce({
        computeMapDate: '2023-04-13',
        computeStatsDate: '2023-04-13',
        computeMapGeneration: '3',
        computeStatsGeneration: '5',
      })
      .mockResolvedValueOnce({
        computeMapDate: '2024-04-28',
        computeStatsDate: '2024-04-28',
        computeMapGeneration: '370',
        computeStatsGeneration: '371',
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
    );
    expect(statisticCommuneService.computeByMonth).toHaveBeenCalledWith(
      expect.objectContaining({
        _isAMomentObject: true,
      }),
    );
    expect(
      statisticCommuneService.computeByMonth.mock.calls[0][0].format(
        'YYYY-MM-DD',
      ),
    ).toBe('2023-04-13');
  });

  it('starts computed historic workers from the dirty date after the computed map switch', async () => {
    configService.getConfig.mockResolvedValue({
      computeMapDate: '2026-03-25',
      computeStatsDate: '2026-03-25',
      computeMapGeneration: '7',
      computeStatsGeneration: '8',
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
    );
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

  it('clears the timeout after the worker finishes current and historic work', async () => {
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
          computeHistoric: true,
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

  it('aggregates historic and normal requests without letting a watchdog downgrade them', async () => {
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
    firstWorker.emit('message', { success: true });
    await expect(firstCompute).resolves.toEqual({ success: true });

    await jest.advanceTimersByTimeAsync(10_000);

    expect(Worker).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        workerData: {
          depsIds: [31, 75],
          computeHistoric: true,
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

  it('requests a full recompute when the publication watchdog detects lag', async () => {
    zonePublicationService.isRecomputeRequired.mockResolvedValue(true);
    const askCompute = jest
      .spyOn(service, 'askCompute')
      .mockResolvedValue(undefined);

    await service.ensureFreshZonePublication();

    expect(askCompute).toHaveBeenCalledWith([], false, false, true);
  });

  it('does not run the publication watchdog while the feature is disabled', async () => {
    delete process.env.ZONE_PUBLICATION_ENABLED;
    const askCompute = jest.spyOn(service, 'askCompute');

    await service.ensureFreshZonePublication();

    expect(zonePublicationService.isRecomputeRequired).not.toHaveBeenCalled();
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
    expect(computeGeoJson).toHaveBeenCalledWith(false, undefined);
  });

  it('captures the global revision only for a national publication compute', async () => {
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
    expect(computeGeoJson).toHaveBeenCalledWith(false, '1');
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

  it('publishes a validated legacy PMTiles before its matching GeoJSON', async () => {
    const publishLegacyArtifact = jest
      .spyOn(service as any, 'publishLegacyArtifact')
      .mockResolvedValue(undefined);
    const computedAt = new Date('2026-07-31T12:00:00Z');

    await (service as any).publishLegacyZoneArtifacts({
      geojsonFile: {
        originalname: 'zones_arretes_en_vigueur.geojson',
        buffer: Buffer.from('{}'),
      },
      pmtilesFile: {
        originalname: 'zones_arretes_en_vigueur.pmtiles',
        buffer: Buffer.from('PMTiles-test'),
      },
      date: computedAt,
    });

    expect(publishLegacyArtifact.mock.calls.map(([, , kind]) => kind)).toEqual([
      'pmtiles',
      'geojson',
    ]);
  });

  it('keeps the legacy GeoJSON unchanged when PMTiles publication fails', async () => {
    const publishLegacyArtifact = jest
      .spyOn(service as any, 'publishLegacyArtifact')
      .mockRejectedValueOnce(new Error('PMTiles upload failed'));

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
        date: new Date('2026-07-31T12:00:00Z'),
      }),
    ).rejects.toThrow('PMTiles upload failed');
    expect(publishLegacyArtifact).toHaveBeenCalledTimes(1);
    expect(publishLegacyArtifact.mock.calls[0][2]).toBe('pmtiles');
  });

  it('fails the legacy publication when the stable upload fails', async () => {
    const s3Service = {
      uploadFile: jest.fn().mockRejectedValue(new Error('S3 unavailable')),
      copyFile: jest.fn(),
    };
    const datagouvService = { uploadToDatagouv: jest.fn() };
    (service as any).s3Service = s3Service;
    (service as any).datagouvService = datagouvService;

    await expect(
      (service as any).publishLegacyArtifact(
        {
          originalname: 'zones_arretes_en_vigueur.pmtiles',
          buffer: Buffer.from('PMTiles-test'),
        },
        new Date('2026-07-31T12:00:00Z'),
        'pmtiles',
        'Carte des zones et arrêtés en vigueur - PMTILES',
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
  let statisticService: { computeDepartementsSituation: jest.Mock };
  let configService: {
    setConfig: jest.Mock;
    advanceComputeMapDate: jest.Mock;
    advanceComputeStatsDate: jest.Mock;
  };
  let zoneAlerteComputedHistoricRepository: { createQueryBuilder: jest.Mock };
  let updateAllHistoricZonesQuery: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    execute: jest.Mock;
  };

  beforeEach(() => {
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
        .mockResolvedValue(undefined),
      sortStatCommune: jest.fn().mockResolvedValue(undefined),
    };
    statisticService = {
      computeDepartementsSituation: jest.fn().mockResolvedValue(undefined),
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
    zoneAlerteComputedHistoricRepository = {
      createQueryBuilder: jest
        .fn()
        .mockReturnValue(updateAllHistoricZonesQuery),
    };

    service = new ZoneAlerteComputedHistoricService(
      {} as any,
      {} as any,
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
      {} as any,
      configService as any,
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
    );
    expect(configService.advanceComputeMapDate.mock.calls).toEqual([
      ['2026-06-21', '0', '2026-06-21'],
      ['2026-06-21', '1', '2026-06-22'],
    ]);
    expect(updateAllHistoricZonesQuery.set).toHaveBeenCalledWith({
      enabled: true,
    });
    expect(updateAllHistoricZonesQuery.where).toHaveBeenCalledWith('1 = 1');
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
});
