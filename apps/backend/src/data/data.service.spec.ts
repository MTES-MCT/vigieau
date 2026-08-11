import { Test, TestingModule } from '@nestjs/testing';
import { DataService } from './data.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StatisticDepartement } from '@shared/entities/statistic_departement.entity';
import { StatisticCommune } from '@shared/entities/statistic_commune.entity';
import { Commune } from '@shared/entities/commune.entity';
import { Departement } from '@shared/entities/departement.entity';
import { Region } from '@shared/entities/region.entity';
import { BassinVersant } from '@shared/entities/bassin_versant.entity';
import { HttpException } from '@nestjs/common';
import { DataSource } from 'typeorm';

describe('DataService', () => {
  let service: DataService;
  const originalStatisticCacheMode = process.env.STATISTIC_CACHE_MODE;

  const stablePublicationState = {
    revision: 'stable',
    activePublicationId: 'active-publication',
    currentPublishedDate: '2023-01-02',
    historicPublishedThrough: '2023-01-01',
    historicDirtyFrom: null,
    historicDirtyThrough: null,
    snapshotStateToken: '1:0:stable',
  };

  const mockRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    count: jest.fn(),
    createQueryBuilder: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      getRawMany: jest.fn(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getCount: jest.fn(),
    })),
  };

  const mockDataSource = {
    query: jest.fn(),
    createQueryRunner: jest.fn(),
  };
  const mockTransactionManager = {
    getRepository: jest.fn(() => mockRepository),
    query: jest.fn(),
  };
  const mockQueryRunner = {
    manager: mockTransactionManager,
    connect: jest.fn(),
    startTransaction: jest.fn(),
    query: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
  };
  const completeDepartments = Array.from({ length: 101 }, (_, index) => ({
    id: index + 1,
    code: String(index + 1).padStart(2, '0'),
    nom: `Departement ${index + 1}`,
    area: 1,
    bounds: {},
  }));
  const departmentDay = (date: string) => ({
    date,
    departements: completeDepartments.map(({ code }) => ({
      code,
      niveauGravite: null,
      niveauGraviteSup: null,
      niveauGraviteSou: null,
      niveauGraviteAep: null,
    })),
  });
  const completeCoverage = (...dates: string[]) =>
    new Map(
      dates.map((date) => [
        date,
        new Set(completeDepartments.map(({ code }) => code)),
      ]),
    );

  const setReferenceData = (overrides: Record<string, unknown> = {}) => {
    const referenceData = {
      departements: service['departements'],
      regions: service['regions'],
      bassinsVersants: service['bassinsVersants'],
      fullArea: service['fullArea'],
      metropoleArea: service['metropoleArea'],
      ...overrides,
    };
    Object.assign(service, referenceData);
    service['referenceDataCache'] = referenceData as any;
    service['referenceDataLoadedAt'] = Date.now();
    return referenceData;
  };

  const certifyData = (overrides: Record<string, unknown> = {}) => {
    const referenceData = service['referenceDataCache'] ?? setReferenceData();
    const certifiedData = {
      ...referenceData,
      revision: stablePublicationState.revision,
      publicationState: stablePublicationState,
      mode: 'versioned',
      dataArea: service['dataArea'],
      dataCommune: service['dataCommune'],
      dataDepartement: service['dataDepartement'],
      firstDate: service['dataArea'][0]?.date ?? '2023-01-01',
      latestDate: service['dataArea'].at(-1)?.date ?? '2023-01-02',
      dateCount: service['dataArea'].length,
      departmentCount: service['departements'].length,
      communeCount: service['dataCommune'].length,
      fingerprint: 'test-fingerprint',
      loadedAt: new Date('2026-08-11T12:00:00.000Z'),
      ...overrides,
    };
    service['certifiedDataCache'] = certifiedData as any;
    service['snapshotStateToken'] = String(certifiedData.revision);
    return certifiedData;
  };

  beforeEach(async () => {
    process.env.STATISTIC_CACHE_MODE = 'versioned';
    jest.clearAllMocks();
    mockDataSource.query.mockReset();
    mockDataSource.query.mockResolvedValue([stablePublicationState]);
    mockDataSource.createQueryRunner.mockReset();
    mockDataSource.createQueryRunner.mockReturnValue(mockQueryRunner);
    mockTransactionManager.getRepository.mockClear();
    mockTransactionManager.query.mockReset();
    mockTransactionManager.query.mockImplementation((sql: string) => {
      if (sql.includes('"expectedCommuneCount"')) {
        return Promise.resolve([
          {
            snapshotDate: stablePublicationState.currentPublishedDate,
            scope: 'national',
            status: 'completed',
            expectedCommuneCount: 1,
            processedCommuneCount: 1,
          },
        ]);
      }
      return Promise.resolve([]);
    });
    mockQueryRunner.connect.mockReset();
    mockQueryRunner.startTransaction.mockReset();
    mockQueryRunner.query.mockReset();
    mockQueryRunner.commitTransaction.mockReset();
    mockQueryRunner.rollbackTransaction.mockReset();
    mockQueryRunner.release.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DataService,
        {
          provide: getRepositoryToken(StatisticDepartement),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(StatisticCommune),
          useValue: mockRepository,
        },
        { provide: getRepositoryToken(Commune), useValue: mockRepository },
        { provide: getRepositoryToken(Departement), useValue: mockRepository },
        { provide: getRepositoryToken(Region), useValue: mockRepository },
        {
          provide: getRepositoryToken(BassinVersant),
          useValue: mockRepository,
        },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = <DataService>module.get(DataService);
    service['snapshotStateToken'] = 'stable';
    service['publicationState'] = stablePublicationState;
    service['publicationStateCheckedAt'] = Date.now();
    setReferenceData();
    certifyData();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (originalStatisticCacheMode === undefined) {
      delete process.env.STATISTIC_CACHE_MODE;
    } else {
      process.env.STATISTIC_CACHE_MODE = originalStatisticCacheMode;
    }
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('starts a tracked statistic cache warm-up on module initialization', async () => {
    service['certifiedDataCache'] = null;
    const loadData = jest.spyOn(service, 'loadData').mockResolvedValue();

    service.onModuleInit();
    await Promise.resolve();

    expect(loadData).toHaveBeenCalledTimes(1);
  });

  describe('getRefData', () => {
    it('should return formatted reference data after checking the cache', async () => {
      service['bassinsVersants'] = <BassinVersant[]>[
        {
          id: 1,
          code: 1,
          nom: 'Bassin 1',
          departements: [{ id: 1, code: 'D01' }],
        },
      ];
      service['regions'] = <Region[]>[
        {
          id: 2,
          code: 'R01',
          nom: 'Region 1',
          departements: [{ id: 2, code: 'D02' }],
        },
      ];
      service['departements'] = [
        { id: 1, code: 'D01', nom: 'Departement 1', bounds: 'bounds1' },
        { id: 2, code: 'D02', nom: 'Departement 2', bounds: 'bounds2' },
      ];
      setReferenceData({
        bassinsVersants: service['bassinsVersants'],
        regions: service['regions'],
        departements: service['departements'],
      });
      certifyData();

      const resultPromise = service.getRefData();
      expect(resultPromise).toBeInstanceOf(Promise);
      const result = await resultPromise;

      expect(result).toEqual({
        bassinsVersants: [
          {
            id: 1,
            code: 1,
            nom: 'Bassin 1',
            departements: [{ id: 1, code: 'D01' }],
          },
        ],
        regions: [
          {
            id: 2,
            code: 'R01',
            nom: 'Region 1',
            departements: [{ id: 2, code: 'D02' }],
          },
        ],
        departements: [
          { id: 1, code: 'D01', nom: 'Departement 1', bounds: 'bounds1' },
          { id: 2, code: 'D02', nom: 'Departement 2', bounds: 'bounds2' },
        ],
      });
    });
  });

  describe('areaFindByDate', () => {
    it('should filter data by date and return global data', async () => {
      service['dataArea'] = [
        { date: '2023-01-01', ESO: 10, ESU: 20, AEP: 30 },
        { date: '2023-02-01', ESO: 15, ESU: 25, AEP: 35 },
      ];
      certifyData({ dataArea: service['dataArea'] });

      const result = await service.areaFindByDate('2023-01-01', '2023-01-31');

      expect(result).toEqual([
        { date: '2023-01-01', ESO: 10, ESU: 20, AEP: 30 },
      ]);
    });

    it('should throw an error if bassin versant is not found', async () => {
      service['bassinsVersants'] = [];
      setReferenceData({ bassinsVersants: [] });
      certifyData({ bassinsVersants: [] });

      await expect(
        service.areaFindByDate(undefined, undefined, '1'),
      ).rejects.toThrow(HttpException);
    });
  });

  describe('commune', () => {
    it('should return commune data for a valid code', async () => {
      const mockStat = {
        id: 1,
        restrictions: [],
        commune: { id: 1, code: '12345', nom: 'Commune 1' },
      };

      mockRepository.findOne.mockResolvedValue(mockStat);
      mockDataSource.query.mockResolvedValue([
        { stateAvailable: true, filtered_restrictions: [] },
      ]);

      const result = await service.commune('12345');

      expect(result).toEqual(mockStat);
    });

    it('should hide commune days until their snapshot is certified', async () => {
      const mockStat = {
        id: 1,
        restrictions: [
          { date: '2023-01-01', SUP: 'alerte' },
          { date: '2023-01-02', SUP: 'crise' },
        ],
        commune: { id: 1, code: '12345', nom: 'Commune 1' },
      };
      mockRepository.findOne.mockResolvedValue(mockStat);
      mockDataSource.query.mockResolvedValue([
        {
          stateAvailable: true,
          filtered_restrictions: [{ date: '2023-01-01', SUP: 'alerte' }],
        },
      ]);

      const result = await service.commune('12345');

      expect(result.restrictions).toEqual([
        { date: '2023-01-01', SUP: 'alerte' },
      ]);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining("status <> 'completed'"),
        [1, null, null, 'versioned'],
      );
    });

    it('should use the live MVCC state when cached state is clean but the epoch is dirty', async () => {
      const mockStat = {
        id: 1,
        restrictions: [
          { date: '2023-01-01', SUP: 'alerte' },
          { date: '2023-01-02', SUP: 'crise' },
          { date: '2023-01-03', SUP: 'vigilance' },
        ],
        commune: { id: 1, code: '12345', nom: 'Commune 1' },
      };
      mockRepository.findOne.mockResolvedValue(mockStat);
      mockDataSource.query.mockResolvedValue([
        {
          stateAvailable: true,
          filtered_restrictions: [{ date: '2023-01-03', SUP: 'vigilance' }],
        },
      ]);

      const result = await service.commune('12345');

      expect(result.restrictions).toEqual([
        { date: '2023-01-03', SUP: 'vigilance' },
      ]);
      expect(mockDataSource.query.mock.calls[0][0]).toContain(
        'CROSS JOIN publication_state state',
      );
      expect(mockDataSource.query.mock.calls[0][0]).toContain(
        'state."historicDirtyThrough"',
      );
    });

    it('should not expose commune days after the current publication watermark', async () => {
      const mockStat = {
        id: 1,
        restrictions: [
          { date: '2023-01-02', SUP: 'alerte' },
          { date: '2023-01-03', SUP: 'crise' },
        ],
        commune: { id: 1, code: '12345', nom: 'Commune 1' },
      };
      mockRepository.findOne.mockResolvedValue(mockStat);
      mockDataSource.query.mockResolvedValue([
        {
          stateAvailable: true,
          filtered_restrictions: [{ date: '2023-01-02', SUP: 'alerte' }],
        },
      ]);

      const result = await service.commune('12345');

      expect(result.restrictions).toEqual([
        { date: '2023-01-02', SUP: 'alerte' },
      ]);
    });

    it('should fail closed through the current watermark when dirty-through is missing', async () => {
      mockRepository.findOne.mockResolvedValue({
        id: 1,
        restrictions: [
          { date: '2023-01-01', SUP: 'alerte' },
          { date: '2023-01-02', SUP: 'crise' },
        ],
        commune: { id: 1, code: '12345', nom: 'Commune 1' },
      });
      mockDataSource.query.mockResolvedValue([
        { stateAvailable: true, filtered_restrictions: [] },
      ]);

      const result = await service.commune('12345');

      expect(result.restrictions).toEqual([]);
    });

    it('should fail closed when publication state cannot be read', async () => {
      mockRepository.findOne.mockResolvedValue({
        id: 1,
        commune: { id: 1, code: '12345', nom: 'Commune 1' },
      });
      mockDataSource.query.mockResolvedValue([
        { stateAvailable: false, filtered_restrictions: [] },
      ]);

      await expect(service.commune('12345')).rejects.toThrow(
        'Statistic publication state is unavailable',
      );
    });

    it('should throw an error if the commune is not found', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      await expect(service.commune('99999')).rejects.toThrow(HttpException);
    });

    it('should filter restrictions by date', async () => {
      const mockStat = {
        id: 1,
        restrictions: [],
        commune: { id: 1, code: '12345', nom: 'Commune 1' },
      };
      const query = jest.fn().mockResolvedValue([
        {
          stateAvailable: true,
          filtered_restrictions: [{ date: '2023-01-01' }],
        },
      ]);

      mockRepository.findOne.mockResolvedValue(mockStat);
      service['dataSource'] = { query } as unknown as DataSource;

      const result = await service.commune('12345', '2023-01', '2023-02');

      expect(result.restrictions).toEqual([{ date: '2023-01-01' }]);
      expect(query.mock.calls[0][0]).toContain('statistic_commune_snapshot');
      expect(query.mock.calls[0][1]).toEqual([
        1,
        '2023-01-01',
        '2023-02-28',
        'versioned',
      ]);
    });

    it('should return an empty restrictions array when a date filter masks all days', async () => {
      mockRepository.findOne.mockResolvedValue({
        id: 1,
        commune: { id: 1, code: '12345', nom: 'Commune 1' },
      });
      mockDataSource.query.mockResolvedValue([
        { stateAvailable: true, filtered_restrictions: null },
      ]);

      const result = await service.commune('12345', '2023-01', '2023-01');

      expect(result.restrictions).toEqual([]);
    });
  });

  describe('departementFindByDate', () => {
    it('should filter data by departement', async () => {
      service['dataDepartement'] = [
        {
          date: '2023-01-01',
          departements: [{ id: 1, code: 'D01', niveauGravite: 'vigilance' }],
        },
        {
          date: '2023-02-01',
          departements: [{ id: 1, code: 'D01', niveauGravite: 'alerte' }],
        },
      ];
      service['departements'] = [
        { id: 1, code: 'D01', niveauGravite: 'alerte' },
      ];
      certifyData({
        departements: service['departements'],
        dataDepartement: service['dataDepartement'],
      });

      const result = await service.departementFindByDate(
        '2023-01-01',
        '2023-01-31',
        undefined,
        undefined,
        '1',
      );

      expect(result).toEqual([
        {
          date: '2023-01-01',
          departements: [{ id: 1, code: 'D01', niveauGravite: 'vigilance' }],
        },
      ]);
    });

    it('should throw an error if the departement is not found', async () => {
      service['departements'] = [];
      certifyData({ departements: [] });

      await expect(
        service.departementFindByDate(
          undefined,
          undefined,
          undefined,
          undefined,
          '999',
        ),
      ).rejects.toThrow(HttpException);
    });
  });

  describe('loadDepartementData', () => {
    it('should hide an incomplete snapshot even when restrictions have no entry for that day', async () => {
      service['data'] = [
        { date: '2023-01-01', departements: [], communes: [] },
        { date: '2023-01-02', departements: [], communes: [] },
      ];
      mockRepository.find.mockResolvedValue([
        {
          departement: { code: '65' },
          restrictions: [
            {
              date: '2023-01-01',
              SOU: {},
              SUP: {},
              AEP: {},
            },
          ],
        },
      ]);
      mockDataSource.query.mockResolvedValue([{ snapshotDate: '2023-01-02' }]);
      service['departements'] = [
        { id: 65, code: '65', area: 1, departements: [{ id: 65 }] },
      ];
      service['fullArea'] = 1;

      await service.loadDepartementData({
        ...stablePublicationState,
        currentPublishedDate: '2023-01-01',
      });

      expect(service['dataArea'].map(({ date }) => date)).toEqual([
        '2023-01-01',
      ]);
      expect(service['dataDepartement'].map(({ date }) => date)).toEqual([
        '2023-01-01',
      ]);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining("scope <> 'bootstrap'"),
        ['2023-01-01', '2023-01-02'],
      );
    });

    it('serves the previous certified cache while refreshing atomically', async () => {
      service['publicationStateCheckedAt'] = 0;
      service['dataArea'] = [{ date: '2023-01-01', ESO: 1, ESU: 1, AEP: 1 }];
      certifyData({
        revision: 'completed-v1',
        dataArea: service['dataArea'],
      });
      const runningState = {
        ...stablePublicationState,
        revision: 'running-v2',
      };
      let finishLoad: (cache: any) => void;
      const delayedLoad = new Promise<any>((resolve) => {
        finishLoad = resolve;
      });
      mockDataSource.query
        .mockResolvedValueOnce([runningState])
        .mockResolvedValueOnce([runningState]);
      const loadDataOnce = jest
        .spyOn(service as any, 'loadDataOnce')
        .mockImplementation(() => {
          service['dataArea'] = [
            { date: '2023-01-01', ESO: 2, ESU: 2, AEP: 2 },
          ];
          return delayedLoad;
        });

      const result = await service.areaFindByDate('2023-01-01', '2023-01-01');

      expect(result).toEqual([{ date: '2023-01-01', ESO: 1, ESU: 1, AEP: 1 }]);
      expect(service['certifiedDataCache']?.dataArea).toEqual(result);
      await Promise.resolve();
      expect(loadDataOnce).toHaveBeenCalledTimes(1);

      finishLoad!({
        ...service['referenceDataCache'],
        revision: runningState.revision,
        publicationState: runningState,
        dataArea: service['dataArea'],
        dataCommune: [],
        dataDepartement: [],
      });
      await service['certifiedDataRefreshLoading'];

      expect(service['certifiedDataCache']?.dataArea).toEqual([
        { date: '2023-01-01', ESO: 2, ESU: 2, AEP: 2 },
      ]);
      expect(service['snapshotStateToken']).toBe('running-v2');
    });

    it('keeps the current publication while hiding a dirty historic range', async () => {
      service['data'] = [
        { date: '2023-01-01', departements: [], communes: [] },
        { date: '2023-01-02', departements: [], communes: [] },
        { date: '2023-01-03', departements: [], communes: [] },
      ];
      mockRepository.find.mockResolvedValue([
        {
          departement: { code: '65' },
          restrictions: [{ date: '2023-01-03', SOU: {}, SUP: {}, AEP: {} }],
        },
      ]);
      mockDataSource.query.mockResolvedValue([]);
      service['departements'] = [
        { id: 65, code: '65', area: 1, departements: [{ id: 65 }] },
      ];
      service['fullArea'] = 1;

      await service.loadDepartementData({
        revision: '2',
        activePublicationId: 'active-publication',
        currentPublishedDate: '2023-01-03',
        historicPublishedThrough: '2023-01-02',
        historicDirtyFrom: '2023-01-01',
        historicDirtyThrough: '2023-01-02',
        snapshotStateToken: '3:0:stable',
      });

      expect(service['dataArea'].map(({ date }) => date)).toEqual([
        '2023-01-03',
      ]);
    });

    it('hides the current publication date when its snapshot is incomplete', async () => {
      service['data'] = [
        { date: '2023-01-02', departements: [], communes: [] },
      ];
      mockRepository.find.mockResolvedValue([
        {
          departement: { code: '65' },
          restrictions: [{ date: '2023-01-02', SOU: {}, SUP: {}, AEP: {} }],
        },
      ]);
      mockDataSource.query.mockResolvedValue([{ snapshotDate: '2023-01-02' }]);
      service['departements'] = [
        { id: 65, code: '65', area: 1, departements: [{ id: 65 }] },
      ];
      service['fullArea'] = 1;

      await service.loadDepartementData(stablePublicationState);

      expect(service['dataArea']).toEqual([]);
      expect(service['dataDepartement']).toEqual([]);
    });

    it('ignores pre-2013 payloads and indexes publishable dates explicitly', async () => {
      service['data'] = [
        { date: '2013-01-01', departements: [], communes: [] },
      ];
      mockRepository.find.mockResolvedValue([
        {
          departement: { code: '65' },
          restrictions: [
            { date: '2012-12-31', SOU: {}, SUP: {}, AEP: {} },
            { date: '2013-01-01', SOU: {}, SUP: {}, AEP: {} },
          ],
        },
      ]);
      mockDataSource.query.mockResolvedValue([]);
      service['departements'] = [
        { id: 65, code: '65', area: 1, departements: [{ id: 65 }] },
      ];
      service['fullArea'] = 1;

      const result = await service.loadDepartementData({
        ...stablePublicationState,
        currentPublishedDate: '2013-01-01',
      });

      expect([...result.coverageByDate.keys()]).toEqual(['2013-01-01']);
      expect(service['dataDepartement'].map(({ date }) => date)).toEqual([
        '2013-01-01',
      ]);
    });

    it('rejects duplicate raw statistics for one department and date', async () => {
      service['data'] = [
        { date: '2023-01-02', departements: [], communes: [] },
      ];
      mockRepository.find.mockResolvedValue([
        {
          departement: { code: '65' },
          restrictions: [
            { date: '2023-01-02', SOU: {}, SUP: {}, AEP: {} },
            { date: '2023-01-02', SOU: {}, SUP: {}, AEP: {} },
          ],
        },
      ]);
      mockDataSource.query.mockResolvedValue([]);

      await expect(
        service.loadDepartementData(stablePublicationState),
      ).rejects.toThrow(
        'Duplicate raw department statistic for 65 on 2023-01-02',
      );
    });

    it('serves a complete dirty range only in explicit legacy bootstrap mode', async () => {
      process.env.STATISTIC_CACHE_MODE = 'legacy-bootstrap';
      const bootstrapState = {
        ...stablePublicationState,
        activePublicationId: null,
        currentPublishedDate: '2023-07-11',
        historicDirtyFrom: '2023-07-11',
        historicDirtyThrough: '2023-07-11',
      };
      service['data'] = [
        { date: '2023-07-11', departements: [], communes: [] },
      ];
      mockRepository.find.mockResolvedValue([
        {
          departement: { code: '65' },
          restrictions: [{ date: '2023-07-11', SOU: {}, SUP: {}, AEP: {} }],
        },
      ]);
      mockDataSource.query.mockResolvedValue([]);
      service['departements'] = [{ id: 65, code: '65', area: 1 }];
      service['fullArea'] = 1;

      await service.loadDepartementData(bootstrapState);
      expect(service['dataArea'].map(({ date }) => date)).toEqual([
        '2023-07-11',
      ]);

      service['data'] = [
        { date: '2023-07-11', departements: [], communes: [] },
      ];
      await service.loadDepartementData({
        ...bootstrapState,
        activePublicationId: 'active-publication',
      });
      expect(service['dataArea']).toEqual([]);
    });
  });

  describe('publication cache coordination', () => {
    it('never generates dates after the current publication watermark', async () => {
      const lastDates: string[] = [];
      jest
        .spyOn(service, 'loadRefData')
        .mockResolvedValue(service['referenceDataCache']!);
      jest
        .spyOn(service, 'loadDepartementData')
        .mockImplementation(async () => {
          lastDates.push(service['data'].at(-1)?.date);
          return { coverageByDate: new Map() };
        });
      jest.spyOn(service, 'loadCommuneData').mockResolvedValue(1);
      jest
        .spyOn(service as any, 'createCertifiedDataCandidate')
        .mockReturnValue({});

      await (service as any).loadDataOnce({
        ...stablePublicationState,
        currentPublishedDate: '2023-01-02',
      });

      expect(lastDates).toEqual(['2023-01-02']);
      expect(service['data'].some(({ date }) => date > '2023-01-02')).toBe(
        false,
      );
      expect(mockQueryRunner.startTransaction).toHaveBeenCalledWith(
        'REPEATABLE READ',
      );
      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        'SET TRANSACTION READ ONLY',
      );
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalledTimes(1);
      expect(mockQueryRunner.release).toHaveBeenCalledTimes(1);
    });

    it('rejects a repository count below the certified snapshot count', async () => {
      jest
        .spyOn(service, 'loadRefData')
        .mockResolvedValue(service['referenceDataCache']!);
      jest
        .spyOn(service as any, 'assertSnapshotCoverage')
        .mockResolvedValue(34943);
      jest.spyOn(service, 'loadDepartementData').mockResolvedValue({
        coverageByDate: new Map(),
      });
      jest.spyOn(service, 'loadCommuneData').mockResolvedValue(34942);

      await expect(
        (service as any).loadDataOnce({
          ...stablePublicationState,
          currentPublishedDate: '2026-08-11',
        }),
      ).rejects.toThrow(
        'The commune statistic repository contains 34942/34943 certified communes',
      );
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(mockQueryRunner.release).toHaveBeenCalledTimes(1);
    });

    it('hides dirty months from a cold duration cache', async () => {
      mockDataSource.query.mockResolvedValue([
        { month: '2023-07' },
        { month: '2023-08' },
      ]);
      const unavailableMonths = await (
        service as any
      ).findUnavailableSnapshotMonths();

      service.computeDataCommune(
        [
          {
            commune: { code: '65000' },
            restrictionsByMonth: [
              { date: '2023-06', ponderation: 1 },
              { date: '2023-07', ponderation: 2 },
              { date: '2023-08', ponderation: 3 },
              { date: '2023-09', ponderation: 4 },
            ],
          },
        ],
        unavailableMonths,
        '2023-08',
      );

      expect(service['dataCommune']).toEqual([
        {
          code: '65000',
          restrictions: [{ d: '2023-06', p: 1 }],
        },
      ]);
      expect(mockDataSource.query.mock.calls[0][0]).toContain(
        'state."historicDirtyThrough"',
      );
      expect(mockDataSource.query.mock.calls[0][0]).toContain(
        'generate_series',
      );
    });

    it('removes a month that becomes unavailable during paginated loading', async () => {
      mockDataSource.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ month: '2023-01' }]);
      mockRepository.count.mockResolvedValue(1);
      mockRepository.find.mockResolvedValue([
        {
          commune: { code: '65000' },
          restrictionsByMonth: [{ date: '2023-01', ponderation: 2 }],
        },
      ]);

      await service.loadCommuneData(stablePublicationState);

      expect(service['dataCommune']).toEqual([
        { code: '65000', restrictions: [] },
      ]);
      expect(mockDataSource.query).toHaveBeenCalledTimes(2);
    });

    it('rejects a versioned clean month missing from commune statistics', async () => {
      mockDataSource.query.mockResolvedValue([]);
      mockRepository.count.mockResolvedValue(1);
      mockRepository.find.mockResolvedValue([
        {
          commune: { code: '65000' },
          restrictionsByMonth: [{ date: '2026-07', ponderation: 0 }],
        },
      ]);

      await expect(
        service.loadCommuneData({
          ...stablePublicationState,
          currentPublishedDate: '2026-08-11',
        }),
      ).rejects.toThrow(
        'Monthly statistics for commune 65000 do not include 2026-08',
      );
    });

    it('allows a missing current month when versioned publication masks it', async () => {
      mockDataSource.query.mockResolvedValue([{ month: '2026-08' }]);
      mockRepository.count.mockResolvedValue(1);
      mockRepository.find.mockResolvedValue([
        {
          commune: { code: '65000' },
          restrictionsByMonth: [{ date: '2026-07', ponderation: 0 }],
        },
      ]);

      await expect(
        service.loadCommuneData({
          ...stablePublicationState,
          currentPublishedDate: '2026-08-11',
          historicDirtyFrom: '2026-08-01',
          historicDirtyThrough: '2026-08-10',
        }),
      ).resolves.toBe(1);
      expect(service['dataCommune']).toEqual([
        {
          code: '65000',
          restrictions: [{ d: '2026-07', p: 0 }],
        },
      ]);
    });

    it('fails a cold load when no current publication exists', async () => {
      await expect(
        (service as any).loadDataOnce({
          ...stablePublicationState,
          currentPublishedDate: null,
        }),
      ).rejects.toThrow('No valid current publication date is available');
    });

    it('waits only on cold start and shares one concurrent reconstruction', async () => {
      service['certifiedDataCache'] = null;
      service['snapshotStateToken'] = null;
      let resolveState: (state: typeof stablePublicationState) => void;
      const delayedState = new Promise<typeof stablePublicationState>(
        (resolve) => {
          resolveState = resolve;
        },
      );
      let finishLoad: (cache: any) => void;
      const delayedLoad = new Promise<any>((resolve) => {
        finishLoad = resolve;
      });
      jest
        .spyOn(service as any, 'getPublicationState')
        .mockReturnValueOnce(delayedState)
        .mockResolvedValue(stablePublicationState);
      jest
        .spyOn(service as any, 'loadDataOnce')
        .mockImplementation(() => delayedLoad);

      let requestsFinished = false;
      const requests = Promise.all([
        service.areaFindByDate(),
        service.duree(),
      ]).then(() => {
        requestsFinished = true;
      });
      await Promise.resolve();
      resolveState!(stablePublicationState);
      await Promise.resolve();
      await Promise.resolve();

      expect(requestsFinished).toBe(false);
      expect((service as any).loadDataOnce).toHaveBeenCalledTimes(1);

      finishLoad!({
        ...service['referenceDataCache'],
        revision: stablePublicationState.revision,
        publicationState: stablePublicationState,
        dataArea: [],
        dataCommune: [],
        dataDepartement: [],
      });
      await requests;
      expect(requestsFinished).toBe(true);
    });

    it('reads publication and snapshot watermarks without hashing payloads', async () => {
      service['publicationState'] = null;
      service['publicationStateCheckedAt'] = 0;

      const state = await (service as any).getPublicationState();

      expect(state).toEqual(stablePublicationState);
      const query = mockDataSource.query.mock.calls[0][0];
      expect(query).toContain('FROM statistic_publication_state');
      expect(query).toContain('WHERE statistic_state.id = 1');
      expect(query).toContain('LIMIT 1');
      expect(query).not.toContain('md5');
      expect(query).toContain('statistic_commune_snapshot');
      expect(query).toContain('"snapshotCount"');
      expect(query).toContain('"incompleteCount"');
      expect(query).toContain('"latestUpdatedAt"');
      expect(mockDataSource.query).toHaveBeenCalledWith(query, ['2013-01-01']);
    });

    it('reports a fresh deterministic statistic cache status', async () => {
      certifyData({
        dataArea: [{ date: '2023-01-02', ESO: {}, ESU: {}, AEP: {} }],
        dataCommune: [{ code: '65000', restrictions: [] }],
        dataDepartement: [
          { date: '2023-01-02', departements: [{ code: '65' }] },
        ],
        firstDate: '2023-01-02',
        latestDate: '2023-01-02',
        dateCount: 1,
        departmentCount: 101,
        communeCount: 1,
        fingerprint: 'stable-fingerprint',
      });
      mockDataSource.query.mockResolvedValue([stablePublicationState]);

      await expect(service.getStatisticCacheStatus(true)).resolves.toEqual(
        expect.objectContaining({
          status: 'ready',
          usable: true,
          fresh: true,
          mode: 'versioned',
          currentPublishedDate: '2023-01-02',
          latestDate: '2023-01-02',
          departmentCount: 101,
          communeCount: 1,
          fingerprint: 'stable-fingerprint',
          lastError: null,
        }),
      );
    });

    it('reports a versioned cache as degraded while history is dirty', async () => {
      const dirtyPublicationState = {
        ...stablePublicationState,
        historicDirtyFrom: '2023-01-01',
        historicDirtyThrough: '2023-01-01',
      };
      certifyData({
        publicationState: dirtyPublicationState,
        latestDate: '2023-01-02',
      });
      mockDataSource.query.mockResolvedValue([dirtyPublicationState]);

      await expect(service.getStatisticCacheStatus(true)).resolves.toEqual(
        expect.objectContaining({
          status: 'degraded',
          usable: true,
          fresh: false,
          mode: 'versioned',
          currentPublishedDate: '2023-01-02',
          latestDate: '2023-01-02',
        }),
      );
    });

    it('refreshes a hot cache after a pre-release snapshot completes', async () => {
      const previousSnapshotState = {
        ...stablePublicationState,
        currentPublishedDate: '2026-08-11',
        snapshotStateToken: '[1128, 0, "2026-08-11T10:00:00Z"]',
      };
      const certifiedSnapshotState = {
        ...stablePublicationState,
        currentPublishedDate: '2026-08-11',
        snapshotStateToken: '[1128, 0, "2026-08-11T11:00:00Z"]',
      };
      certifyData({
        publicationState: previousSnapshotState,
        latestDate: '2026-08-11',
      });
      service['publicationStateCheckedAt'] = 0;
      mockDataSource.query.mockResolvedValue([certifiedSnapshotState]);
      const loadDataOnce = jest
        .spyOn(service as any, 'loadDataOnce')
        .mockResolvedValue({
          ...service['certifiedDataCache'],
          publicationState: certifiedSnapshotState,
        });

      await service.loadData();

      expect(loadDataOnce).toHaveBeenCalledTimes(1);
      expect(service['certifiedDataCache']?.publicationState).toEqual(
        certifiedSnapshotState,
      );
    });

    it('bounds hot publication-state checks to one query per five seconds', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(10_000);
      service['publicationStateCheckedAt'] = 10_000;

      await service.areaFindByDate();
      await service.areaFindByDate();
      expect(mockDataSource.query).not.toHaveBeenCalled();

      now.mockReturnValue(15_001);
      await service.areaFindByDate();
      expect(mockDataSource.query).toHaveBeenCalledTimes(1);
    });

    it('serves the initialized statistical cache when its state lookup fails', async () => {
      service['publicationState'] = null;
      service['publicationStateCheckedAt'] = 0;
      certifyData({
        dataArea: [{ date: '2023-01-01', ESO: 1, ESU: 2, AEP: 3 }],
      });
      mockDataSource.query.mockRejectedValue(new Error('database unavailable'));

      await expect(
        service.areaFindByDate('2023-01-01', '2023-01-01'),
      ).resolves.toEqual([{ date: '2023-01-01', ESO: 1, ESU: 2, AEP: 3 }]);
      await expect(
        service.areaFindByDate('2023-01-01', '2023-01-01'),
      ).resolves.toBeDefined();
      expect(mockDataSource.query).toHaveBeenCalledTimes(1);
    });

    it('loads reference data on cold start without publication state', async () => {
      service['referenceDataCache'] = null;
      service['certifiedDataCache'] = null;
      mockRepository.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getCount: jest.fn(),
        getRawMany: jest.fn().mockResolvedValue([
          {
            id: 65,
            code: '65',
            nom: 'Hautes-Pyrenees',
            area: 1,
            bounds: 'BOX(0 0,1 1)',
          },
        ]),
      });
      mockRepository.find.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      mockDataSource.query.mockRejectedValue(
        new Error('statistic publication state is absent'),
      );

      await expect(service.getRefData()).resolves.toEqual({
        bassinsVersants: [],
        regions: [],
        departements: [
          {
            id: 65,
            code: '65',
            nom: 'Hautes-Pyrenees',
            bounds: {
              minLat: '0',
              maxLat: '1',
              minLong: '0',
              maxLong: '1',
            },
          },
        ],
      });
      expect(mockDataSource.query).not.toHaveBeenCalled();
      expect(mockRepository.find).toHaveBeenCalledTimes(2);
    });

    it('keeps transaction-local reference data unpublished until candidate swap', async () => {
      const previousReferences = setReferenceData({
        departements: [
          { id: 65, code: '65', nom: 'Hautes-Pyrenees', bounds: {} },
        ],
      });
      const previousCache = certifyData();
      mockRepository.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getCount: jest.fn(),
        getRawMany: jest.fn().mockResolvedValue([
          {
            id: 31,
            code: '31',
            nom: 'Haute-Garonne',
            area: 1,
            bounds: 'BOX(0 0,1 1)',
          },
        ]),
      });
      mockRepository.find.mockResolvedValue([]);

      const transactionReferences = await service.loadRefData(
        mockTransactionManager as any,
      );

      expect(transactionReferences.departements).toEqual([
        expect.objectContaining({ code: '31' }),
      ]);
      expect(service['referenceDataCache']).toBe(previousReferences);
      expect(service['certifiedDataCache']).toBe(previousCache);
      expect(service['departements']).toEqual(previousReferences.departements);
    });

    it('serves stale reference data while sharing one background refresh', async () => {
      setReferenceData({
        departements: [
          { id: 65, code: '65', nom: 'Hautes-Pyrenees', bounds: {} },
        ],
      });
      const certifiedCache = certifyData({
        fingerprint: 'certified-with-previous-references',
      });
      service['referenceDataLoadedAt'] = 0;
      let finishDepartements: (rows: any[]) => void;
      const delayedDepartements = new Promise<any[]>((resolve) => {
        finishDepartements = resolve;
      });
      const getRawMany = jest.fn().mockReturnValue(delayedDepartements);
      mockRepository.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getCount: jest.fn(),
        getRawMany,
      });
      mockRepository.find.mockResolvedValue([]);

      const [first, second] = await Promise.all([
        service.getRefData(),
        service.getRefData(),
      ]);

      expect(first.departements).toEqual([
        { id: 65, code: '65', nom: 'Hautes-Pyrenees', bounds: {} },
      ]);
      expect(second).toEqual(first);
      expect(getRawMany).toHaveBeenCalledTimes(1);

      finishDepartements!([
        {
          id: 31,
          code: '31',
          nom: 'Haute-Garonne',
          area: 1,
          bounds: 'BOX(0 0,1 1)',
        },
      ]);
      await service['referenceDataLoading'];

      await expect(service.getRefData()).resolves.toMatchObject({
        departements: [{ code: '65' }],
      });
      expect(service['referenceDataCache']?.departements).toEqual([
        expect.objectContaining({ code: '31' }),
      ]);
      expect(service['certifiedDataCache']).toBe(certifiedCache);
      expect(service['certifiedDataCache']?.departements).toEqual([
        expect.objectContaining({ code: '65' }),
      ]);
      expect(service['certifiedDataCache']?.fingerprint).toBe(
        'certified-with-previous-references',
      );
    });

    it('keeps the last reference cache when a background refresh fails', async () => {
      const previousReferences = setReferenceData({
        departements: [
          { id: 65, code: '65', nom: 'Hautes-Pyrenees', bounds: {} },
        ],
      });
      certifyData();
      service['referenceDataLoadedAt'] = 0;
      let failRefresh: (error: Error) => void;
      const failedRefresh = new Promise<any[]>((_, reject) => {
        failRefresh = reject;
      });
      mockRepository.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getCount: jest.fn(),
        getRawMany: jest.fn().mockReturnValue(failedRefresh),
      });

      const result = await service.getRefData();
      const refresh = service['referenceDataLoading'];

      expect(result.departements).toEqual([
        { id: 65, code: '65', nom: 'Hautes-Pyrenees', bounds: {} },
      ]);
      failRefresh!(new Error('reference database unavailable'));
      await expect(refresh).rejects.toThrow('reference database unavailable');
      expect(service['referenceDataCache']).toBe(previousReferences);
      await expect(service.getRefData()).resolves.toMatchObject({
        departements: [{ code: '65' }],
      });
      expect(mockRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('refreshes stale reference data even when the statistical revision is unchanged', async () => {
      service['referenceDataLoadedAt'] = 0;
      service['publicationStateCheckedAt'] = 0;
      mockDataSource.query.mockResolvedValue([stablePublicationState]);
      const loadRefData = jest
        .spyOn(service, 'loadRefData')
        .mockImplementation(async () => {
          const references = setReferenceData();
          return references as any;
        });
      const loadDataOnce = jest.spyOn(service as any, 'loadDataOnce');

      await service.loadData();

      expect(loadRefData).toHaveBeenCalledTimes(1);
      expect(loadDataOnce).not.toHaveBeenCalled();
    });

    it('uses a compact working date range during reconstruction', () => {
      const dates = (service as any).generateDateRange(
        '2026-01-01',
        '2026-12-31',
      );
      const legacyShape = dates.map((date) => ({ ...date, communes: [] }));

      expect(dates).toHaveLength(365);
      expect(dates.every((date) => !('communes' in date))).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(dates))).toBeLessThan(
        Buffer.byteLength(JSON.stringify(legacyShape)),
      );
    });

    it('does not reload a hot cache when the publication revision is unchanged', async () => {
      service['publicationStateCheckedAt'] = 0;
      mockDataSource.query.mockResolvedValue([stablePublicationState]);
      const loadDataOnce = jest.spyOn(service as any, 'loadDataOnce');

      await service.loadData();

      expect(loadDataOnce).not.toHaveBeenCalled();
      expect(service['snapshotStateToken']).toBe('stable');
    });

    it('cooldowns the publication state that actually fails after a transition', async () => {
      const revision2 = { ...stablePublicationState, revision: '2' };
      const revision3 = { ...stablePublicationState, revision: '3' };
      service['publicationStateCheckedAt'] = 0;
      const previousCache = service['certifiedDataCache'];
      mockDataSource.query
        .mockResolvedValueOnce([revision2])
        .mockResolvedValueOnce([revision3]);
      const loadDataOnce = jest
        .spyOn(service as any, 'loadDataOnce')
        .mockResolvedValueOnce({
          ...service['referenceDataCache'],
          revision: revision2.revision,
          publicationState: revision2,
          dataArea: [],
          dataCommune: [],
          dataDepartement: [],
        })
        .mockRejectedValueOnce(new Error('refresh failed'));

      await expect(service.areaFindByDate()).resolves.toBeDefined();
      await Promise.resolve();
      await expect(service['certifiedDataRefreshLoading']).rejects.toThrow(
        'refresh failed',
      );

      expect(loadDataOnce).toHaveBeenCalledTimes(2);
      expect(service['failedPublicationStateToken']).toBe(
        (service as any).getPublicationStateToken(revision3),
      );
      expect(service['certifiedDataCache']).toBe(previousCache);
    });

    it('refreshes a hot cache when the dirty range changes at the same revision', async () => {
      const dirtyState = {
        ...stablePublicationState,
        historicDirtyFrom: '2023-01-01',
        historicDirtyThrough: '2023-01-01',
      };
      service['publicationStateCheckedAt'] = 0;
      mockDataSource.query.mockResolvedValue([dirtyState]);
      const loadDataOnce = jest
        .spyOn(service as any, 'loadDataOnce')
        .mockResolvedValue({
          ...service['referenceDataCache'],
          revision: dirtyState.revision,
          publicationState: dirtyState,
          dataArea: [{ date: '2023-01-02', ESO: 1, ESU: 2, AEP: 3 }],
          dataCommune: [],
          dataDepartement: [],
        });

      await service.loadData();

      expect(loadDataOnce).toHaveBeenCalledTimes(1);
      expect(service['certifiedDataCache']?.publicationState).toEqual(
        dirtyState,
      );
    });

    it('does not reuse the cooldown of another dirty range at the same revision', async () => {
      const failedDirtyState = {
        ...stablePublicationState,
        historicDirtyFrom: '2023-01-01',
        historicDirtyThrough: '2023-01-01',
      };
      const nextDirtyState = {
        ...failedDirtyState,
        historicDirtyThrough: '2023-01-02',
      };
      service['failedPublicationStateToken'] = (
        service as any
      ).getPublicationStateToken(failedDirtyState);
      service['failedPublicationAt'] = Date.now();
      service['publicationStateCheckedAt'] = 0;
      mockDataSource.query.mockResolvedValue([nextDirtyState]);
      const loadDataOnce = jest
        .spyOn(service as any, 'loadDataOnce')
        .mockResolvedValue({
          ...service['referenceDataCache'],
          revision: nextDirtyState.revision,
          publicationState: nextDirtyState,
          dataArea: [],
          dataCommune: [],
          dataDepartement: [],
        });

      await service.areaFindByDate();
      await service['certifiedDataRefreshLoading'];

      expect(loadDataOnce).toHaveBeenCalledTimes(1);
      expect(service['certifiedDataCache']?.publicationState).toEqual(
        nextDirtyState,
      );
      expect(service['failedPublicationStateToken']).toBeNull();
    });
  });

  describe('certified cache validation', () => {
    const prepareCandidate = (dates: string[]) => {
      service['dataArea'] = dates.map((date) => ({
        date,
        ESO: {},
        ESU: {},
        AEP: {},
      }));
      service['dataDepartement'] = dates.map(departmentDay);
      service['dataCommune'] = [{ code: '65000', restrictions: [] }];
      return {
        departements: completeDepartments,
        regions: [],
        bassinsVersants: [],
        fullArea: 101,
        metropoleArea: 101,
      };
    };

    it('rejects a legacy bootstrap candidate with a raw daily coverage hole', () => {
      process.env.STATISTIC_CACHE_MODE = 'legacy-bootstrap';
      const referenceData = prepareCandidate(['2023-07-11', '2023-07-12']);
      const publicationState = {
        ...stablePublicationState,
        activePublicationId: null,
        currentPublishedDate: '2023-07-12',
      };

      expect(() =>
        (service as any).createCertifiedDataCandidate(
          referenceData,
          publicationState,
          { coverageByDate: completeCoverage('2023-07-12') },
          1,
        ),
      ).toThrow(
        'Raw department statistics for 2023-07-11 contain 0/101 departments',
      );
    });

    it('rejects a candidate that would regress the latest served date', () => {
      const referenceData = prepareCandidate(['2026-08-11']);
      certifyData({ latestDate: '2026-08-12' });

      expect(() =>
        (service as any).createCertifiedDataCandidate(
          referenceData,
          {
            ...stablePublicationState,
            currentPublishedDate: '2026-08-11',
          },
          { coverageByDate: completeCoverage('2026-08-11') },
          1,
        ),
      ).toThrow(
        'The public statistic cache candidate regresses from 2026-08-12 to 2026-08-11',
      );
    });

    it('produces the same fingerprint for two equivalent instance candidates', () => {
      const referenceData = prepareCandidate(['2026-08-11']);
      service['certifiedDataCache'] = null;
      const publicationState = {
        ...stablePublicationState,
        currentPublishedDate: '2026-08-11',
      };
      const departmentData = {
        coverageByDate: completeCoverage('2026-08-11'),
      };

      const first = (service as any).createCertifiedDataCandidate(
        referenceData,
        publicationState,
        departmentData,
        1,
      );
      const second = (service as any).createCertifiedDataCandidate(
        structuredClone(referenceData),
        structuredClone(publicationState),
        departmentData,
        1,
      );

      expect(first.fingerprint).toBe(second.fingerprint);
      expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    });

    it('rejects an incomplete current national snapshot', async () => {
      mockTransactionManager.query.mockResolvedValue([
        {
          snapshotDate: '2026-08-11',
          scope: 'national',
          status: 'running',
          expectedCommuneCount: 34943,
          processedCommuneCount: 12000,
        },
      ]);

      await expect(
        (service as any).assertSnapshotCoverage(
          {
            ...stablePublicationState,
            currentPublishedDate: '2026-08-11',
          },
          mockTransactionManager,
        ),
      ).rejects.toThrow(
        'No completed national statistic snapshot is available for 2026-08-11',
      );
    });

    it('accepts an incomplete historic snapshot in versioned mode', async () => {
      mockTransactionManager.query.mockResolvedValue([
        {
          snapshotDate: '2026-08-10',
          scope: 'national',
          status: 'running',
          expectedCommuneCount: 34943,
          processedCommuneCount: 12000,
        },
        {
          snapshotDate: '2026-08-11',
          scope: 'national',
          status: 'completed',
          expectedCommuneCount: 34943,
          processedCommuneCount: 34943,
        },
      ]);

      await expect(
        (service as any).assertSnapshotCoverage(
          {
            ...stablePublicationState,
            currentPublishedDate: '2026-08-11',
          },
          mockTransactionManager,
        ),
      ).resolves.toBe(34943);
    });

    it('rejects an incomplete historic snapshot in legacy bootstrap mode', async () => {
      process.env.STATISTIC_CACHE_MODE = 'legacy-bootstrap';
      mockTransactionManager.query.mockResolvedValue([
        {
          snapshotDate: '2026-08-10',
          scope: 'national',
          status: 'running',
          expectedCommuneCount: 34943,
          processedCommuneCount: 12000,
        },
        {
          snapshotDate: '2026-08-11',
          scope: 'national',
          status: 'completed',
          expectedCommuneCount: 34943,
          processedCommuneCount: 34943,
        },
      ]);

      await expect(
        (service as any).assertSnapshotCoverage(
          {
            ...stablePublicationState,
            activePublicationId: null,
            currentPublishedDate: '2026-08-11',
          },
          mockTransactionManager,
        ),
      ).rejects.toThrow(
        'Statistic snapshot 2026-08-10 (national) is incomplete',
      );
    });

    it('rejects stale or unordered monthly commune statistics', () => {
      expect(() =>
        (service as any).assertMonthlyStatisticCoverage(
          [
            {
              commune: { code: '65000' },
              restrictionsByMonth: [
                { date: '2026-08', ponderation: 1 },
                { date: '2026-07', ponderation: 0 },
              ],
            },
          ],
          '2026-08',
          false,
        ),
      ).toThrow('Invalid monthly statistic sequence for commune 65000');

      expect(() =>
        (service as any).assertMonthlyStatisticCoverage(
          [
            {
              commune: { code: '65000' },
              restrictionsByMonth: [{ date: '2026-07', ponderation: 0 }],
            },
          ],
          '2026-08',
          true,
        ),
      ).toThrow('Monthly statistics for commune 65000 do not include 2026-08');

      expect(() =>
        (service as any).assertMonthlyStatisticCoverage(
          [
            {
              commune: { code: '65000' },
              restrictionsByMonth: [{ date: '2026-07', ponderation: 0 }],
            },
          ],
          '2026-08',
          false,
        ),
      ).not.toThrow();
    });

    it('returns 503 on a cold load failure instead of an empty payload', async () => {
      service['certifiedDataCache'] = null;
      jest
        .spyOn(service as any, 'getPublicationState')
        .mockResolvedValue(stablePublicationState);
      jest
        .spyOn(service as any, 'loadDataOnce')
        .mockRejectedValue(new Error('invalid candidate'));

      try {
        await service.areaFindByDate();
        throw new Error('Expected the cold request to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(503);
      }
    });
  });
});
