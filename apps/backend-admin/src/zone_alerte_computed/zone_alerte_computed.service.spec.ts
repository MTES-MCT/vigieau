import { EventEmitter } from 'node:events';
import { Worker } from 'worker_threads';
import moment from 'moment';
import {
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
  let configService: { getConfig: jest.Mock };
  let statisticCommuneService: { computeByMonth: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-06-23T12:00:00Z'));

    configService = {
      getConfig: jest.fn(),
    };
    statisticCommuneService = {
      computeByMonth: jest.fn().mockResolvedValue(undefined),
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
    );
    (service as any).runHistoricWorker = jest.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs legacy then computed historic workers when the dirty date predates computed maps', async () => {
    configService.getConfig.mockResolvedValue({
      computeMapDate: '2023-04-13',
      computeStatsDate: '2023-04-13',
    });

    await service.computeHistoric();

    expect((service as any).runHistoricWorker).toHaveBeenCalledTimes(2);
    expect((service as any).runHistoricWorker).toHaveBeenNthCalledWith(
      1,
      'maps',
      '2023-04-13',
      '2023-04-13',
    );
    expect((service as any).runHistoricWorker).toHaveBeenNthCalledWith(
      2,
      'mapsComputed',
      '2024-04-29',
      '2023-04-13',
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
    });

    await service.computeHistoric();

    expect((service as any).runHistoricWorker).toHaveBeenCalledTimes(1);
    expect((service as any).runHistoricWorker).toHaveBeenCalledWith(
      'mapsComputed',
      '2026-03-25',
      '2026-03-25',
    );
  });

  it('uses computeStatsDate when it is older than computeMapDate', async () => {
    configService.getConfig.mockResolvedValue({
      computeMapDate: '2026-06-01',
      computeStatsDate: '2026-03-25',
    });

    await service.computeHistoric();

    expect((service as any).runHistoricWorker).toHaveBeenCalledTimes(1);
    expect((service as any).runHistoricWorker).toHaveBeenCalledWith(
      'mapsComputed',
      '2026-03-25',
      '2026-03-25',
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

  it('keeps watching the worker after resolving its current result', async () => {
    const worker = Object.assign(new EventEmitter(), {
      terminate: jest.fn().mockResolvedValue(1),
    });
    (Worker as unknown as jest.Mock).mockReturnValue(worker);
    jest.spyOn((service as any).logger, 'error').mockImplementation();

    const compute = service.askCompute([65], false, true);
    worker.emit('message', { success: true });

    await expect(compute).resolves.toEqual({ success: true });
    expect(worker.terminate).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(ZONE_COMPUTE_WORKER_TIMEOUT_MS);

    expect(worker.terminate).toHaveBeenCalledTimes(1);
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
  let configService: { setConfig: jest.Mock };
  let dataGouvService: { updateMaps: jest.Mock };
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
    };
    dataGouvService = {
      updateMaps: jest.fn().mockResolvedValue(undefined),
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
      dataGouvService as any,
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
    expect(configService.setConfig).toHaveBeenCalledWith(
      null,
      '2026-06-22',
      null,
      true,
    );
    expect(updateAllHistoricZonesQuery.set).toHaveBeenCalledWith({
      enabled: true,
    });
    expect(updateAllHistoricZonesQuery.where).toHaveBeenCalledWith('1 = 1');
  });
});
