import { Test, TestingModule } from '@nestjs/testing';
import { StatisticsService } from './statistics.service';
import { IsNull, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Statistic } from '@shared/entities/statistic.entity';
import { DepartementsService } from '../departements/departements.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import {
  MatomoStatisticsClient,
  MatomoReportError,
} from './matomo-statistics.client';
import { MatomoStatisticsRunService } from './matomo-statistics-run.service';

describe('StatisticsService', () => {
  let service: StatisticsService;
  let statisticRepository: Repository<Statistic>;
  let matomoClient: MatomoStatisticsClient;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatisticsService,
        {
          provide: getRepositoryToken(Statistic),
          useClass: Repository, // Mock the TypeORM repository
        },
        {
          provide: MatomoStatisticsClient,
          useValue: {
            getReport: jest.fn(),
            configurationFingerprint: jest
              .fn()
              .mockReturnValue('configuration'),
          },
        },
        {
          provide: DepartementsService,
          useValue: {
            getAllLight: jest.fn().mockResolvedValue([
              { code: '01', region: { code: 'AU' } },
              { code: '02', region: { code: 'NA' } },
            ]), // Mock the method returning department data
          },
        },
        {
          provide: SubscriptionsService,
          useValue: {
            getAllLight: jest
              .fn()
              .mockResolvedValue([
                { createdAt: new Date().toISOString() },
                { createdAt: new Date().toISOString() },
              ]), // Mock the method returning subscriptions
          },
        },
        {
          provide: MatomoStatisticsRunService,
          useValue: {
            run: jest.fn((_fingerprint, collect) => collect()),
          },
        },
      ],
    }).compile();

    service = <StatisticsService>module.get(StatisticsService);
    statisticRepository = <Repository<Statistic>>(
      module.get(getRepositoryToken(Statistic))
    );
    matomoClient = module.get(MatomoStatisticsClient);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findAll', () => {
    it('should return statistics', () => {
      const mockStatistics = { subscriptions: 10 };
      (service as any).statistics = mockStatistics; // Set mock data

      const result = service.findAll();

      expect(result).toEqual(mockStatistics);
    });
  });

  describe('loadStatistics', () => {
    it('should load and aggregate statistics from the repository', async () => {
      const mockStatistics = [
        {
          date: '2023-07-11',
          subscriptions: 5,
          profileRepartition: { particulier: 1, entreprise: 2 },
          departementRepartition: { '01': 1 },
          regionRepartition: { AU: 2 },
        },
        {
          date: '2023-07-12',
          subscriptions: 3,
          profileRepartition: { particulier: 2, entreprise: 1 },
          departementRepartition: { '01': 2 },
          regionRepartition: { AU: 1 },
        },
      ];

      jest
        .spyOn(statisticRepository, 'find')
        .mockResolvedValueOnce([...mockStatistics].reverse() as any);

      await service.loadStatistics();

      expect(statisticRepository.find).toHaveBeenCalledWith({
        where: { date: MoreThanOrEqual('2023-07-11') },
        order: { date: 'DESC' },
        take: 30,
      });
      expect(service.findAll()).toEqual({
        subscriptions: 8,
        profileRepartition: { particulier: 3, entreprise: 3 },
        departementRepartition: { '01': 3 },
        regionRepartition: { AU: 3 },
        statsByDay: [
          {
            date: '2023-07-11',
            visits: undefined,
            arreteDownloads: undefined,
            restrictionsSearch: undefined,
          },
          {
            date: '2023-07-12',
            visits: undefined,
            arreteDownloads: undefined,
            restrictionsSearch: undefined,
          },
        ],
      });
    });
  });

  it('refreshes each local cache from persisted statistics without collecting Matomo', async () => {
    const load = jest
      .spyOn(service, 'loadStatistics')
      .mockResolvedValue(undefined);
    await service.refreshStatistics();
    expect(load).toHaveBeenCalledTimes(1);
    expect(matomoClient.getReport).not.toHaveBeenCalled();
  });

  describe('computeStatistics', () => {
    it('should compute and save statistics', async () => {
      const mockLastStat = { date: '2023-07-10' };
      const mockMatomoData = {
        data: {
          '2023-07-11': [{ label: 'CODE INSEE', nb_events: 5 }],
          '2023-07-12': [{ label: 'CODE INSEE', nb_events: 10 }],
        },
      };

      jest
        .spyOn(statisticRepository, 'findOne')
        .mockResolvedValueOnce(mockLastStat as any);
      jest
        .spyOn(matomoClient, 'getReport')
        .mockResolvedValue(mockMatomoData as any);
      jest.spyOn(statisticRepository, 'upsert').mockResolvedValue({} as any);
      jest.spyOn(statisticRepository, 'update').mockResolvedValue({} as any);
      jest.spyOn(statisticRepository, 'find').mockResolvedValue([]);

      await service.computeStatistics();

      expect(statisticRepository.findOne).toHaveBeenCalledWith({
        where: { id: Not(IsNull()) },
        order: { date: 'DESC' },
      });

      expect(statisticRepository.upsert).toHaveBeenCalledWith(
        expect.any(Array),
        ['date'],
      );
      expect(statisticRepository.update).not.toHaveBeenCalled();
    });

    it('does not overwrite valid statistics when only the legacy source fails', async () => {
      const previous = { subscriptions: 42, statsByDay: [{ visits: 123 }] };
      (service as any).statistics = previous;
      jest
        .spyOn(statisticRepository, 'findOne')
        .mockResolvedValue({ date: '2026-09-06' } as Statistic);
      const upsert = jest.spyOn(statisticRepository, 'upsert');
      const load = jest.spyOn(service, 'loadStatistics');
      const error = new MatomoReportError(
        'legacy',
        'VisitsSummary.getVisits',
        'authentication',
        401,
      );
      jest
        .spyOn(matomoClient, 'getReport')
        .mockImplementation(async (source) => {
          if (source === 'legacy') throw error;
          return { data: { '2026-09-06': 12 } };
        });

      await expect(service.computeStatistics()).rejects.toBe(error);

      expect(upsert).not.toHaveBeenCalled();
      expect(load).not.toHaveBeenCalled();
      expect(service.findAll()).toBe(previous);
    });
  });

  describe('generateDateString', () => {
    it('should return a formatted date string', () => {
      const date = new Date('2023-07-11T00:00:00Z');
      const result = service.generateDateString(date);

      expect(result).toBe('2023-07-11');
    });
  });
});
