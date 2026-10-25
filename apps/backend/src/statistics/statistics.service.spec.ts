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

const metricFields = [
  'visits',
  'restrictionsSearch',
  'arreteDownloads',
  'subscriptions',
  'profileRepartition',
  'departementRepartition',
  'regionRepartition',
];

describe('StatisticsService', () => {
  let service: StatisticsService;
  let statisticRepository: Repository<Statistic>;
  let matomoClient: MatomoStatisticsClient;

  afterEach(() => jest.useRealTimers());

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
          visits: 10,
          restrictionsSearch: 4,
          arreteDownloads: 2,
          subscriptions: 5,
          profileRepartition: { particulier: 1, entreprise: 2 },
          departementRepartition: { '01': 1 },
          regionRepartition: { AU: 2 },
        },
        {
          date: '2023-07-12',
          visits: 20,
          restrictionsSearch: 6,
          arreteDownloads: 1,
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
        where: metricFields.map((field) => ({
          date: MoreThanOrEqual('2023-07-11'),
          [field]: Not(IsNull()),
        })),
        order: { date: 'DESC' },
        take: 30,
      });
      expect(service.findAll()).toEqual({
        subscriptions: 8,
        profileRepartition: { particulier: 3, entreprise: 3 },
        departementRepartition: { '01': 3 },
        regionRepartition: { AU: 3 },
        period: { from: '2023-07-11', to: '2023-07-12' },
        lastDataDate: '2023-07-12',
        stale: true,
        partial: false,
        statsByDay: [
          {
            date: '2023-07-11',
            visits: 10,
            arreteDownloads: 2,
            restrictionsSearch: 4,
          },
          {
            date: '2023-07-12',
            visits: 20,
            arreteDownloads: 1,
            restrictionsSearch: 6,
          },
        ],
      });
    });

    it('does not manufacture zero subscriptions when no audience data exists', async () => {
      jest.spyOn(statisticRepository, 'find').mockResolvedValue([]);
      await service.loadStatistics();
      expect(service.findAll()).toEqual({
        subscriptions: null,
        profileRepartition: {},
        departementRepartition: {},
        regionRepartition: {},
        statsByDay: [],
        period: null,
        lastDataDate: null,
        stale: true,
        partial: false,
      });
      expect(matomoClient.getReport).not.toHaveBeenCalled();
    });

    it('keeps genuine zero measurements and treats yesterday as fresh', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-25T12:00:00.000Z') });
      jest.spyOn(statisticRepository, 'find').mockResolvedValue([
        {
          date: '2026-10-24',
          visits: 0,
          restrictionsSearch: 0,
          arreteDownloads: 0,
          subscriptions: 0,
          profileRepartition: {},
          departementRepartition: {},
          regionRepartition: {},
        } as Statistic,
      ]);
      await service.loadStatistics();
      expect(service.findAll()).toMatchObject({
        subscriptions: 0,
        lastDataDate: '2026-10-24',
        stale: false,
        partial: false,
        statsByDay: [{ visits: 0, restrictionsSearch: 0, arreteDownloads: 0 }],
      });
    });

    it('preserves partial days without treating missing metrics as zeros', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-25T12:00:00.000Z') });
      jest.spyOn(statisticRepository, 'find').mockResolvedValue([
        {
          date: '2026-09-01',
          visits: 12,
          restrictionsSearch: null,
          arreteDownloads: null,
          subscriptions: null,
          profileRepartition: null,
          departementRepartition: null,
          regionRepartition: null,
        } as Statistic,
      ]);
      await service.loadStatistics();
      expect(service.findAll()).toMatchObject({
        subscriptions: null,
        period: { from: '2026-09-01', to: '2026-09-01' },
        lastDataDate: '2026-09-01',
        stale: true,
        partial: true,
        statsByDay: [
          { visits: 12, restrictionsSearch: null, arreteDownloads: null },
        ],
      });
    });

    it('marks a non-contiguous period as partial even when measured days are complete', async () => {
      jest.spyOn(statisticRepository, 'find').mockResolvedValue(
        ['2026-09-03', '2026-09-01'].map(
          (date) =>
            ({
              date,
              visits: 0,
              restrictionsSearch: 0,
              arreteDownloads: 0,
              subscriptions: 0,
              profileRepartition: {},
              departementRepartition: {},
              regionRepartition: {},
            }) as Statistic,
        ),
      );
      await service.loadStatistics();
      expect(service.findAll()).toMatchObject({
        period: { from: '2026-09-01', to: '2026-09-03' },
        partial: true,
        subscriptions: 0,
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
      const mockLastStat = { date: '2023-07-11' };
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
        where: {
          ...Object.fromEntries(
            metricFields.map((field) => [field, Not(IsNull())]),
          ),
          date: MoreThanOrEqual('2023-07-11'),
        },
        order: { date: 'DESC' },
      });

      expect(statisticRepository.upsert).toHaveBeenCalledWith(
        expect.any(Array),
        ['date'],
      );
      expect(statisticRepository.update).not.toHaveBeenCalled();
    });

    it.each(['current', 'legacy'] as const)(
      'does not overwrite valid statistics when the %s source fails',
      async (failedSource) => {
        const previous = { subscriptions: 42, statsByDay: [{ visits: 123 }] };
        (service as any).statistics = previous;
        jest
          .spyOn(statisticRepository, 'findOne')
          .mockResolvedValue({ date: '2026-09-06' } as Statistic);
        const upsert = jest.spyOn(statisticRepository, 'upsert');
        const load = jest.spyOn(service, 'loadStatistics');
        const error = new MatomoReportError(
          failedSource,
          'VisitsSummary.getVisits',
          'authentication',
          401,
        );
        jest
          .spyOn(matomoClient, 'getReport')
          .mockImplementation(async (source) => {
            if (source === failedSource) throw error;
            return { data: { '2026-09-06': 12 } };
          });

        await expect(service.computeStatistics()).rejects.toBe(error);

        expect(upsert).not.toHaveBeenCalled();
        expect(load).not.toHaveBeenCalled();
        expect(service.findAll()).toBe(previous);
      },
    );

    it.each([
      {
        lastDate: '2026-03-26',
        today: '2026-10-25',
        from: '2026-03-26',
        to: '2026-04-01',
        days: 7,
      },
      {
        lastDate: '2026-10-24',
        today: '2026-10-25',
        from: '2026-10-24',
        to: '2026-10-25',
        days: 2,
      },
      {
        lastDate: '2026-10-25',
        today: '2026-10-25',
        from: '2026-10-25',
        to: '2026-10-25',
        days: 1,
      },
      {
        lastDate: null,
        today: '2026-10-25',
        from: '2023-07-11',
        to: '2023-07-17',
        days: 7,
      },
    ])(
      'recovers a bounded UTC range from $from to $to',
      async ({ lastDate, today, from, to, days }) => {
        jest.useFakeTimers({ now: new Date(`${today}T12:00:00.000Z`) });
        jest
          .spyOn(statisticRepository, 'findOne')
          .mockResolvedValue(
            lastDate ? ({ date: lastDate } as Statistic) : null,
          );
        jest.spyOn(statisticRepository, 'find').mockResolvedValue([]);
        const upsert = jest
          .spyOn(statisticRepository, 'upsert')
          .mockResolvedValue({} as any);
        jest
          .spyOn(matomoClient, 'getReport')
          .mockImplementation(async (_source, method, range) => {
            const [start, end] = range.split(',');
            const data = {};
            for (
              let date = new Date(start);
              date <= new Date(end);
              date.setUTCDate(date.getUTCDate() + 1)
            ) {
              data[date.toISOString().slice(0, 10)] =
                method === 'VisitsSummary.getVisits' ? 3 : [];
            }
            return { data };
          });

        await service.computeStatistics();

        expect(matomoClient.getReport).toHaveBeenCalledTimes(12);
        for (const call of jest.mocked(matomoClient.getReport).mock.calls)
          expect(call[2]).toBe(`${from},${to}`);
        const saved = upsert.mock.calls[0][0] as any[];
        expect(saved).toHaveLength(days);
        expect(saved[0].date.toISOString().slice(0, 10)).toBe(from);
        expect(saved.at(-1).date.toISOString().slice(0, 10)).toBe(to);
        for (const stat of saved) {
          expect(stat.visits).toBe(6);
          expect(stat).not.toHaveProperty('departementSituation');
          expect(stat).not.toHaveProperty('id');
        }
      },
    );
  });

  describe('generateDateString', () => {
    it('should return a formatted date string', () => {
      const date = new Date('2023-07-11T00:00:00Z');
      const result = service.generateDateString(date);

      expect(result).toBe('2023-07-11');
    });
  });
});
