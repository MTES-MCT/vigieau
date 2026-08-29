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
  const originalStatisticArtifactMode =
    process.env.STATISTIC_CACHE_ARTIFACT_MODE;
  const originalDistributedRefresh =
    process.env.STATISTIC_CACHE_DISTRIBUTED_REFRESH_ENABLED;
  const originalPublicSourceRevision =
    process.env.PUBLIC_SOURCE_REVISION_ENABLED;

  const stablePublicationState = {
    revision: 'stable',
    activePublicationId: 'active-publication',
    statisticCachePublicationId: null,
    statisticCacheCandidatePublicationId: null,
    currentPublishedDate: '2023-01-02',
    historicPublishedThrough: '2023-01-01',
    historicDirtyFrom: null,
    historicDirtyThrough: null,
    historicMapCursor: null,
    historicStatsCursor: null,
    sourceRevision: null,
    historicComputeEpoch: null,
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
    return certifiedData;
  };

  beforeEach(async () => {
    process.env.STATISTIC_CACHE_MODE = 'versioned';
    process.env.STATISTIC_CACHE_ARTIFACT_MODE = 'disabled';
    process.env.STATISTIC_CACHE_DISTRIBUTED_REFRESH_ENABLED = 'false';
    process.env.PUBLIC_SOURCE_REVISION_ENABLED = 'false';
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
    jest
      .spyOn(service as any, 'isCurrentSnapshotCertified')
      .mockResolvedValue(true);
    jest
      .spyOn(service as any, 'getStatisticPublicationExpectation')
      .mockReturnValue({
        today: '2023-01-02',
        expectedPublishedDate: '2023-01-02',
        deadline: '06:00',
        afterDeadline: true,
      });
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
    if (originalStatisticArtifactMode === undefined) {
      delete process.env.STATISTIC_CACHE_ARTIFACT_MODE;
    } else {
      process.env.STATISTIC_CACHE_ARTIFACT_MODE = originalStatisticArtifactMode;
    }
    if (originalDistributedRefresh === undefined) {
      delete process.env.STATISTIC_CACHE_DISTRIBUTED_REFRESH_ENABLED;
    } else {
      process.env.STATISTIC_CACHE_DISTRIBUTED_REFRESH_ENABLED =
        originalDistributedRefresh;
    }
    if (originalPublicSourceRevision === undefined) {
      delete process.env.PUBLIC_SOURCE_REVISION_ENABLED;
    } else {
      process.env.PUBLIC_SOURCE_REVISION_ENABLED = originalPublicSourceRevision;
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
      await new Promise<void>((resolve) => setImmediate(resolve));
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
      expect(service['certifiedDataCache']?.revision).toBe('running-v2');
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

    it('reads only the canonical publication watermark without hashing payloads', async () => {
      service['publicationState'] = null;
      service['publicationStateCheckedAt'] = 0;

      const state = await (service as any).getPublicationState();

      expect(state).toEqual(stablePublicationState);
      const query = mockDataSource.query.mock.calls[0][0];
      expect(query).toContain('FROM "statistic_publication_state"');
      expect(query).toContain('WHERE statistic_state."id" = 1');
      expect(query).toContain('LIMIT 1');
      expect(query).not.toContain('md5');
      expect(query).toContain(
        'certified_snapshot."certifiedHistoryRepairId" = repair.id',
      );
      expect(query).toContain('certified_snapshot."sourceRevision" IS NULL');
      expect(mockDataSource.query).toHaveBeenCalledWith(query);
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
          expectedPublishedDate: '2023-01-02',
          publicationDeadline: '06:00',
          lagDays: 0,
          historicDirtyFrom: null,
          historicDirtyThrough: null,
          latestDate: '2023-01-02',
          departmentCount: 101,
          communeCount: 1,
          fingerprint: 'stable-fingerprint',
          incompleteSnapshotCount: null,
          oldestIncompleteSnapshot: null,
          lastError: null,
        }),
      );
      expect(mockDataSource.query).toHaveBeenCalledTimes(1);
    });

    it('reports a late daily watermark as degraded after the Paris deadline', async () => {
      jest
        .spyOn(service as any, 'getStatisticPublicationExpectation')
        .mockReturnValue({
          today: '2023-01-03',
          expectedPublishedDate: '2023-01-03',
          deadline: '06:00',
          afterDeadline: true,
        });
      mockDataSource.query.mockResolvedValue([stablePublicationState]);

      await expect(service.getStatisticCacheStatus(true)).resolves.toEqual(
        expect.objectContaining({
          status: 'degraded',
          usable: true,
          fresh: false,
          currentPublishedDate: '2023-01-02',
          expectedPublishedDate: '2023-01-03',
          publicationDeadline: '06:00',
          lagDays: 1,
          historicDirtyFrom: null,
          historicDirtyThrough: null,
        }),
      );
    });

    it('keeps D current while an older legacy snapshot is incomplete', async () => {
      process.env.STATISTIC_CACHE_MODE = 'legacy-bootstrap';
      (service as any).beginDate = '2015-05-18';
      jest
        .spyOn(service as any, 'getStatisticPublicationExpectation')
        .mockReturnValue({
          today: '2015-05-20',
          expectedPublishedDate: '2015-05-20',
          deadline: '06:00',
          afterDeadline: true,
        });
      const legacyPublicationState = {
        ...stablePublicationState,
        activePublicationId: null,
        currentPublishedDate: '2015-05-20',
      };
      certifyData({
        publicationState: legacyPublicationState,
        mode: 'legacy-bootstrap',
        firstDate: '2015-05-18',
        latestDate: '2015-05-20',
        dateCount: 3,
      });
      mockDataSource.query
        .mockResolvedValueOnce([legacyPublicationState])
        .mockResolvedValueOnce([
          {
            incompleteSnapshotCount: 1,
            oldestSnapshotDate: '2015-05-19',
            oldestSnapshotScope: 'national',
            oldestSnapshotStatus: 'failed',
            oldestProcessedCommuneCount: 34943,
            oldestExpectedCommuneCount: 34943,
            oldestSnapshotUpdatedAt: '2015-05-19T12:00:00.000Z',
          },
        ]);

      await expect(service.getStatisticCacheStatus(true)).resolves.toEqual(
        expect.objectContaining({
          status: 'ready',
          usable: true,
          fresh: true,
          currentFresh: true,
          historicComplete: false,
          mode: 'legacy-bootstrap',
          incompleteSnapshotCount: 1,
          oldestIncompleteSnapshot: {
            date: '2015-05-19',
            scope: 'national',
            status: 'failed',
            processedCommuneCount: 34943,
            expectedCommuneCount: 34943,
            updatedAt: '2015-05-19T12:00:00.000Z',
          },
        }),
      );
      expect(mockDataSource.query.mock.calls[1][1]).toEqual([
        '2015-05-18',
        '2015-05-20',
      ]);
    });

    it('reports the out-of-range bootstrap sentinel while keeping a warm cache usable', async () => {
      process.env.STATISTIC_CACHE_MODE = 'legacy-bootstrap';
      const legacyPublicationState = {
        ...stablePublicationState,
        activePublicationId: null,
        currentPublishedDate: '2013-01-02',
      };
      certifyData({
        publicationState: legacyPublicationState,
        mode: 'legacy-bootstrap',
        firstDate: '2013-01-01',
        latestDate: '2013-01-02',
        dateCount: 2,
      });
      mockDataSource.query
        .mockResolvedValueOnce([legacyPublicationState])
        .mockResolvedValueOnce([
          {
            incompleteSnapshotCount: 1,
            oldestSnapshotDate: '1970-01-01',
            oldestSnapshotScope: 'bootstrap',
            oldestSnapshotStatus: 'failed',
            oldestProcessedCommuneCount: 0,
            oldestExpectedCommuneCount: 0,
            oldestSnapshotUpdatedAt: '1970-01-01T12:00:00.000Z',
          },
        ]);

      await expect(service.getStatisticCacheStatus(true)).resolves.toEqual(
        expect.objectContaining({
          status: 'degraded',
          usable: true,
          fresh: false,
          currentFresh: false,
          historicComplete: false,
          incompleteSnapshotCount: 1,
          oldestIncompleteSnapshot: {
            date: '1970-01-01',
            scope: 'bootstrap',
            status: 'failed',
            processedCommuneCount: 0,
            expectedCommuneCount: 0,
            updatedAt: '1970-01-01T12:00:00.000Z',
          },
        }),
      );
      expect(mockDataSource.query.mock.calls[1][0]).toContain(
        `"scope" = 'bootstrap'`,
      );
    });

    it('keeps an existing legacy cache unchanged behind the bootstrap barrier', async () => {
      process.env.STATISTIC_CACHE_MODE = 'legacy-bootstrap';
      const legacyPublicationState = {
        ...stablePublicationState,
        activePublicationId: null,
        currentPublishedDate: '2013-01-02',
      };
      const warmCache = certifyData({
        publicationState: legacyPublicationState,
        mode: 'legacy-bootstrap',
        firstDate: '2013-01-01',
        latestDate: '2013-01-02',
        dateCount: 2,
      });
      jest
        .spyOn(service as any, 'getPublicationState')
        .mockResolvedValue(legacyPublicationState);
      jest
        .spyOn(service as any, 'getLegacySnapshotCoverageStatus')
        .mockResolvedValue({
          incompleteSnapshotCount: 1,
          oldestIncompleteSnapshot: {
            date: '1970-01-01',
            scope: 'bootstrap',
            status: 'failed',
            processedCommuneCount: 0,
            expectedCommuneCount: 0,
          },
        });
      const loadDataOnce = jest.spyOn(service as any, 'loadDataOnce');

      await service.loadData();

      expect(loadDataOnce).not.toHaveBeenCalled();
      expect(service['certifiedDataCache']).toBe(warmCache);
    });

    it('reuses the legacy snapshot diagnostic within its TTL', async () => {
      process.env.STATISTIC_CACHE_MODE = 'legacy-bootstrap';
      const legacyPublicationState = {
        ...stablePublicationState,
        activePublicationId: null,
        currentPublishedDate: '2013-01-02',
      };
      certifyData({
        publicationState: legacyPublicationState,
        mode: 'legacy-bootstrap',
        firstDate: '2013-01-01',
        latestDate: '2013-01-02',
        dateCount: 2,
      });
      mockDataSource.query
        .mockResolvedValueOnce([legacyPublicationState])
        .mockResolvedValueOnce([{ incompleteSnapshotCount: 0 }])
        .mockResolvedValueOnce([legacyPublicationState]);

      await service.getStatisticCacheStatus(true);
      await service.getStatisticCacheStatus(true);

      const coverageQueries = mockDataSource.query.mock.calls.filter(([sql]) =>
        String(sql).includes('oldest_incomplete_snapshot'),
      );
      expect(coverageQueries).toHaveLength(1);
      expect(mockDataSource.query).toHaveBeenCalledTimes(3);
    });

    it('shares an in-flight legacy snapshot diagnostic', async () => {
      let releaseCoverage: (rows: unknown[]) => void;
      const coverage = new Promise<unknown[]>((resolve) => {
        releaseCoverage = resolve;
      });
      mockDataSource.query.mockReturnValue(coverage);

      const first = (service as any).getLegacySnapshotCoverageStatus(
        '2013-01-02',
      );
      const second = (service as any).getLegacySnapshotCoverageStatus(
        '2013-01-02',
      );
      expect(mockDataSource.query).toHaveBeenCalledTimes(1);

      releaseCoverage!([{ incompleteSnapshotCount: 0 }]);
      await expect(Promise.all([first, second])).resolves.toEqual([
        { incompleteSnapshotCount: 0, oldestIncompleteSnapshot: null },
        { incompleteSnapshotCount: 0, oldestIncompleteSnapshot: null },
      ]);
      expect(mockDataSource.query).toHaveBeenCalledTimes(1);
    });

    it('reports a complete continuous legacy cache as fresh', async () => {
      process.env.STATISTIC_CACHE_MODE = 'legacy-bootstrap';
      jest
        .spyOn(service as any, 'getStatisticPublicationExpectation')
        .mockReturnValue({
          today: '2013-01-02',
          expectedPublishedDate: '2013-01-02',
          deadline: '06:00',
          afterDeadline: true,
        });
      const legacyPublicationState = {
        ...stablePublicationState,
        activePublicationId: null,
        currentPublishedDate: '2013-01-02',
      };
      certifyData({
        publicationState: legacyPublicationState,
        mode: 'legacy-bootstrap',
        firstDate: '2013-01-01',
        latestDate: '2013-01-02',
        dateCount: 2,
      });
      mockDataSource.query
        .mockResolvedValueOnce([legacyPublicationState])
        .mockResolvedValueOnce([{ incompleteSnapshotCount: 0 }]);

      await expect(service.getStatisticCacheStatus(true)).resolves.toEqual(
        expect.objectContaining({
          status: 'ready',
          usable: true,
          fresh: true,
          mode: 'legacy-bootstrap',
          incompleteSnapshotCount: 0,
          oldestIncompleteSnapshot: null,
        }),
      );
    });

    it('fails strict legacy health closed when snapshot diagnostics are unavailable', async () => {
      process.env.STATISTIC_CACHE_MODE = 'legacy-bootstrap';
      const legacyPublicationState = {
        ...stablePublicationState,
        activePublicationId: null,
        currentPublishedDate: '2013-01-02',
      };
      certifyData({
        publicationState: legacyPublicationState,
        mode: 'legacy-bootstrap',
        firstDate: '2013-01-01',
        latestDate: '2013-01-02',
        dateCount: 2,
      });
      mockDataSource.query
        .mockResolvedValueOnce([legacyPublicationState])
        .mockRejectedValueOnce(new Error('snapshot diagnostic unavailable'));

      await expect(service.getStatisticCacheStatus(true)).resolves.toEqual(
        expect.objectContaining({
          status: 'degraded',
          usable: true,
          fresh: false,
          currentFresh: false,
          historicComplete: false,
          incompleteSnapshotCount: null,
          oldestIncompleteSnapshot: null,
          lastError: expect.objectContaining({
            phase: 'snapshot-coverage-check',
          }),
        }),
      );
    });

    it('keeps current freshness when history is dirty but the current snapshot is exact', async () => {
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
          status: 'ready',
          usable: true,
          fresh: true,
          currentFresh: true,
          historicComplete: false,
          mode: 'versioned',
          currentPublishedDate: '2023-01-02',
          latestDate: '2023-01-02',
          lagDays: 0,
          historicDirtyFrom: '2023-01-01',
          historicDirtyThrough: '2023-01-01',
        }),
      );
    });

    it('ignores background snapshot progress until its publication revision changes', async () => {
      const previousPublishedState = {
        ...stablePublicationState,
        currentPublishedDate: '2026-08-11',
      };
      certifyData({
        publicationState: previousPublishedState,
        latestDate: '2026-08-11',
      });
      service['publicationStateCheckedAt'] = 0;
      mockDataSource.query.mockResolvedValue([previousPublishedState]);
      const loadDataOnce = jest.spyOn(service as any, 'loadDataOnce');

      await service.loadData();

      expect(loadDataOnce).not.toHaveBeenCalled();
    });

    it('rebuilds an incomplete legacy cache after repair without a publication state change', async () => {
      process.env.STATISTIC_CACHE_MODE = 'legacy-bootstrap';
      (service as any).beginDate = '2015-05-18';
      const legacyPublicationState = {
        ...stablePublicationState,
        activePublicationId: null,
        currentPublishedDate: '2015-05-20',
      };
      certifyData({
        publicationState: legacyPublicationState,
        mode: 'legacy-bootstrap',
        firstDate: '2015-05-18',
        latestDate: '2015-05-20',
        dateCount: 2,
      });
      jest
        .spyOn(service as any, 'getPublicationState')
        .mockResolvedValue(legacyPublicationState);
      jest
        .spyOn(service as any, 'getLegacySnapshotCoverageStatus')
        .mockResolvedValueOnce({
          incompleteSnapshotCount: 1,
          oldestIncompleteSnapshot: {
            date: '2015-05-19',
            scope: 'national',
            status: 'failed',
            processedCommuneCount: 34943,
            expectedCommuneCount: 34943,
          },
        })
        .mockResolvedValueOnce({
          incompleteSnapshotCount: 0,
          oldestIncompleteSnapshot: null,
        });
      const repairedCandidate = {
        ...service['certifiedDataCache'],
        publicationState: legacyPublicationState,
        mode: 'legacy-bootstrap',
        dateCount: 3,
      };
      const loadDataOnce = jest
        .spyOn(service as any, 'loadDataOnce')
        .mockResolvedValue(repairedCandidate);

      await service.loadData();
      expect(loadDataOnce).not.toHaveBeenCalled();

      await service.loadData();
      expect(loadDataOnce).toHaveBeenCalledWith(legacyPublicationState);
      expect(service['certifiedDataCache']?.dateCount).toBe(3);
      expect(service['legacySnapshotCoverageDirty']).toBe(false);
    });

    it('does not refresh or clear the legacy repair signal while the historic range is dirty', async () => {
      process.env.STATISTIC_CACHE_MODE = 'legacy-bootstrap';
      const dirtyPublicationState = {
        ...stablePublicationState,
        activePublicationId: null,
        currentPublishedDate: '2015-05-20',
        historicDirtyFrom: '2015-05-19',
        historicDirtyThrough: '2015-05-20',
      };
      const warmCache = certifyData({
        publicationState: dirtyPublicationState,
        mode: 'legacy-bootstrap',
        firstDate: '2013-01-01',
        latestDate: '2015-05-20',
        dateCount: 868,
      });
      service['legacySnapshotCoverageDirty'] = true;
      jest
        .spyOn(service as any, 'getPublicationState')
        .mockResolvedValue(dirtyPublicationState);
      const getCoverage = jest.spyOn(
        service as any,
        'getLegacySnapshotCoverageStatus',
      );
      const loadDataOnce = jest.spyOn(service as any, 'loadDataOnce');

      await service.loadData();

      expect(getCoverage).not.toHaveBeenCalled();
      expect(loadDataOnce).not.toHaveBeenCalled();
      (service as any).publishCertifiedDataCache(warmCache);
      expect(service['legacySnapshotCoverageDirty']).toBe(true);
    });

    it('keeps legacy health degraded without starting a rebuild while history is dirty', async () => {
      process.env.STATISTIC_CACHE_MODE = 'legacy-bootstrap';
      const dirtyPublicationState = {
        ...stablePublicationState,
        activePublicationId: null,
        currentPublishedDate: '2013-01-02',
        historicDirtyFrom: '2013-01-01',
        historicDirtyThrough: '2013-01-02',
      };
      certifyData({
        publicationState: dirtyPublicationState,
        mode: 'legacy-bootstrap',
        firstDate: '2013-01-01',
        latestDate: '2013-01-02',
        dateCount: 2,
      });
      mockDataSource.query
        .mockResolvedValueOnce([dirtyPublicationState])
        .mockResolvedValueOnce([{ incompleteSnapshotCount: 0 }]);
      const startRefresh = jest.spyOn(
        service as any,
        'startCertifiedDataRefresh',
      );

      await expect(service.getStatisticCacheStatus(true)).resolves.toEqual(
        expect.objectContaining({
          status: 'degraded',
          usable: true,
          fresh: false,
          incompleteSnapshotCount: 0,
        }),
      );
      expect(startRefresh).not.toHaveBeenCalled();
      expect(service['legacySnapshotCoverageDirty']).toBe(false);
    });

    it('refreshes a hot cache when an explicit same-date repair bumps the revision', async () => {
      const previousPublishedState = {
        ...stablePublicationState,
        revision: '41',
        currentPublishedDate: '2026-08-11',
      };
      const repairedPublishedState = {
        ...previousPublishedState,
        revision: '42',
      };
      certifyData({
        revision: previousPublishedState.revision,
        publicationState: previousPublishedState,
        latestDate: '2026-08-11',
      });
      service['publicationStateCheckedAt'] = 0;
      mockDataSource.query
        .mockResolvedValueOnce([repairedPublishedState])
        .mockResolvedValueOnce([repairedPublishedState]);
      const loadDataOnce = jest
        .spyOn(service as any, 'loadDataOnce')
        .mockResolvedValue({
          ...service['certifiedDataCache'],
          revision: repairedPublishedState.revision,
          publicationState: repairedPublishedState,
        });

      await service.loadData();

      expect(loadDataOnce).toHaveBeenCalledTimes(1);
      expect(service['certifiedDataCache']?.publicationState).toEqual(
        repairedPublishedState,
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

    it('cooldowns a failed cold reconstruction for the same publication state', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(100_000);
      service['certifiedDataCache'] = null;
      service['publicationStateCheckedAt'] = 0;
      mockDataSource.query.mockResolvedValue([stablePublicationState]);
      const loadDataOnce = jest
        .spyOn(service as any, 'loadDataOnce')
        .mockRejectedValue(new Error('snapshot is still running'));

      await expect(service.loadData()).rejects.toThrow(
        'snapshot is still running',
      );
      const failedAt = service['failedPublicationAt'];
      await expect(service.loadData()).rejects.toThrow(
        'is in refresh cooldown',
      );

      expect(loadDataOnce).toHaveBeenCalledTimes(1);
      expect(service['failedPublicationAt']).toBe(failedAt);

      now.mockReturnValue(160_001);
      await expect(service.loadData()).rejects.toThrow(
        'snapshot is still running',
      );
      expect(loadDataOnce).toHaveBeenCalledTimes(2);
      expect(service['failedPublicationAt']).toBe(160_001);
    });

    it('discards an overlay loaded while its certified repair is revoked', async () => {
      process.env.STATISTIC_CACHE_ARTIFACT_MODE = 'read-write';
      (service as any).statisticCacheArtifactService = {};
      service['certifiedDataCache'] = null;
      const repairId = '00000000-0000-4000-8000-000000000048';
      const artifactPublicationId = '00000000-0000-4000-8000-000000000049';
      const activeState = {
        ...stablePublicationState,
        revision: '48',
        statisticCachePublicationId: artifactPublicationId,
        historicDirtyFrom: '2026-07-11',
        historicDirtyThrough: '2026-08-27',
        historicComputeEpoch: '9',
        certifiedHistoryRepairId: repairId,
        certifiedHistoryRepairFrom: '2026-07-11',
        certifiedHistoryRepairThrough: '2026-08-27',
        certifiedHistoryRepairSourceRunId: 'certified-source-run',
        certifiedHistoryRepairActivatedAt: '2026-08-29T12:00:00.000Z',
        certifiedHistoryRepairRevision: '48',
      };
      const revokedState = {
        ...activeState,
        certifiedHistoryRepairId: null,
        certifiedHistoryRepairFrom: null,
        certifiedHistoryRepairThrough: null,
        certifiedHistoryRepairSourceRunId: null,
        certifiedHistoryRepairActivatedAt: null,
        certifiedHistoryRepairRevision: null,
      };
      const overlayCandidate = {
        ...service['referenceDataCache'],
        revision: activeState.revision,
        publicationState: activeState,
        dataArea: [],
        dataCommune: [],
        dataDepartement: [],
        artifactPublicationId,
        artifactIdentity: {
          materializationStrategy: 'certified-history-overlay',
          certifiedHistoryRepairId: repairId,
        },
      };
      const sparseCandidate = {
        ...overlayCandidate,
        publicationState: revokedState,
        artifactIdentity: {
          materializationStrategy: 'sparse-current',
          certifiedHistoryRepairId: null,
        },
      };
      jest
        .spyOn(service as any, 'getPublicationState')
        .mockResolvedValueOnce(activeState)
        .mockResolvedValueOnce(revokedState)
        .mockResolvedValueOnce(revokedState);
      const loadArtifact = jest
        .spyOn(service as any, 'loadArtifactBackedData')
        .mockResolvedValueOnce(overlayCandidate)
        .mockResolvedValueOnce(sparseCandidate);
      const publish = jest
        .spyOn(service as any, 'publishCertifiedDataCache')
        .mockImplementation();

      await service.loadData();

      expect(loadArtifact).toHaveBeenCalledTimes(2);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          publicationState: revokedState,
          artifactIdentity: expect.objectContaining({
            materializationStrategy: 'sparse-current',
          }),
        }),
      );
    });

    it('rebuilds a hot non-artifact cache when its repair is revoked', async () => {
      const repairId = '00000000-0000-4000-8000-000000000048';
      const activeState = {
        ...stablePublicationState,
        revision: '48',
        historicDirtyFrom: '2026-07-11',
        historicDirtyThrough: '2026-08-27',
        historicComputeEpoch: '9',
        certifiedHistoryRepairId: repairId,
        certifiedHistoryRepairFrom: '2026-07-11',
        certifiedHistoryRepairThrough: '2026-08-27',
        certifiedHistoryRepairSourceRunId: 'certified-source-run',
        certifiedHistoryRepairActivatedAt: '2026-08-29T12:00:00.000Z',
        certifiedHistoryRepairRevision: '48',
      };
      const revokedState = {
        ...activeState,
        certifiedHistoryRepairId: null,
        certifiedHistoryRepairFrom: null,
        certifiedHistoryRepairThrough: null,
        certifiedHistoryRepairSourceRunId: null,
        certifiedHistoryRepairActivatedAt: null,
        certifiedHistoryRepairRevision: null,
      };
      certifyData({ publicationState: activeState, revision: '48' });
      service['publicationState'] = activeState;
      service['publicationStateCheckedAt'] = 0;
      jest
        .spyOn(service as any, 'getPublicationState')
        .mockResolvedValueOnce(revokedState)
        .mockResolvedValueOnce(revokedState);
      const loadDataOnce = jest
        .spyOn(service as any, 'loadDataOnce')
        .mockResolvedValue({
          ...service['referenceDataCache'],
          revision: revokedState.revision,
          publicationState: revokedState,
          dataArea: [],
          dataCommune: [],
          dataDepartement: [],
        });

      await service.loadData();

      expect(loadDataOnce).toHaveBeenCalledTimes(1);
      expect(service['certifiedDataCache']?.publicationState).toEqual(
        revokedState,
      );
      expect(
        service['certifiedDataCache']?.publicationState
          .certifiedHistoryRepairId,
      ).toBeNull();
    });

    it('bypasses a cold reconstruction cooldown for a new publication revision', async () => {
      const nextRevision = { ...stablePublicationState, revision: 'next' };
      service['certifiedDataCache'] = null;
      service['publicationStateCheckedAt'] = 0;
      mockDataSource.query
        .mockResolvedValueOnce([stablePublicationState])
        .mockResolvedValueOnce([nextRevision])
        .mockResolvedValueOnce([nextRevision]);
      const loadDataOnce = jest
        .spyOn(service as any, 'loadDataOnce')
        .mockRejectedValueOnce(new Error('snapshot is still running'))
        .mockResolvedValueOnce({
          ...service['referenceDataCache'],
          revision: nextRevision.revision,
          publicationState: nextRevision,
          dataArea: [],
          dataCommune: [],
          dataDepartement: [],
        });

      await expect(service.loadData()).rejects.toThrow(
        'snapshot is still running',
      );
      await expect(service.loadData()).resolves.toBeUndefined();

      expect(loadDataOnce).toHaveBeenCalledTimes(2);
      expect(service['certifiedDataCache']?.revision).toBe('next');
      expect(service['failedPublicationStateToken']).toBeNull();
    });

    it('updates dirty health metadata without reloading an unchanged cache identity', async () => {
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

      expect(loadDataOnce).not.toHaveBeenCalled();
      expect(service['certifiedDataCache']?.publicationState).toEqual(
        dirtyState,
      );
    });

    it('does not let a dirty cursor change trigger cache materialization', async () => {
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

      expect(loadDataOnce).not.toHaveBeenCalled();
      expect(service['certifiedDataCache']?.publicationState).toEqual(
        nextDirtyState,
      );
      expect(service['failedPublicationStateToken']).toBeNull();
    });
  });

  describe('statistic artifact materialization', () => {
    const artifactState = {
      ...stablePublicationState,
      revision: '11',
      activePublicationId: null,
      statisticCachePublicationId: '00000000-0000-4000-8000-000000000011',
      currentPublishedDate: '2026-09-02',
      historicDirtyFrom: '2015-01-01',
      historicDirtyThrough: '2026-09-01',
      historicMapCursor: '2015-01-01',
      historicStatsCursor: '2015-01-01',
      sourceRevision: '42',
      historicComputeEpoch: '7',
      certifiedHistoryRepairId: null,
    };
    const activeArtifact = {
      identity: {
        id: '00000000-0000-4000-8000-000000000010',
        statisticRevision: '10',
        currentPublishedDate: '2026-08-31',
        protocolVersion: 1,
        mode: 'legacy-bootstrap',
        materializationStrategy: 'daily-delta',
        historicDirtyFrom: '2015-01-01',
        historicDirtyThrough: '2026-08-30',
        historicMapCursor: '2015-01-01',
        historicStatsCursor: '2015-01-01',
        sourceRevision: '42',
        historicComputeEpoch: '7',
        certifiedHistoryRepairId: null,
        contentFingerprint: 'a'.repeat(64),
        firstDate: '2026-08-31',
        latestDate: '2026-08-31',
        dateCount: 1,
        areaCount: 1,
        departmentCount: 101,
        communeCount: 1,
        readyAt: new Date('2026-08-31T06:00:00.000Z'),
      },
      dataArea: [{ date: '2026-08-31', ESO: {}, ESU: {}, AEP: {} }],
      dataDepartement: [departmentDay('2026-08-31')],
      dataCommune: [{ code: '01001', restrictions: [{ d: '2026-08', p: 2 }] }],
      latestCommuneWeights: [['01001', 2]],
    };

    beforeEach(() => {
      process.env.STATISTIC_CACHE_MODE = 'legacy-bootstrap';
    });

    it.each([
      ['clean bootstrap', null, 'full-clean'],
      ['safe dirty bootstrap', '2015-01-01', 'legacy-safe-boundary'],
    ])('builds a %s candidate', async (_label, dirtyFrom, strategy) => {
      const state = {
        ...artifactState,
        historicDirtyFrom: dirtyFrom,
        historicDirtyThrough: dirtyFrom ? '2026-09-01' : null,
      };
      const candidate = { materializationStrategy: strategy };
      const full = jest
        .spyOn(service as any, 'createFullArtifactCandidate')
        .mockResolvedValue(candidate);

      await expect(
        (service as any).createArtifactCandidate(
          state,
          null,
          mockTransactionManager,
        ),
      ).resolves.toBe(candidate);
      expect(full).toHaveBeenCalledWith(
        state,
        strategy,
        mockTransactionManager,
      );
    });

    it('bootstraps a versioned sparse-current candidate from the certified current day', async () => {
      const currentDate = '2026-08-19';
      const state = {
        ...artifactState,
        activePublicationId: '00000000-0000-4000-8000-000000000019',
        statisticCachePublicationId: null,
        currentPublishedDate: currentDate,
        historicDirtyFrom: '2011-06-07',
        historicDirtyThrough: '2026-08-05',
      };
      const referenceData = {
        departements: completeDepartments,
        regions: [],
        bassinsVersants: [],
        fullArea: 101,
        metropoleArea: 101,
      };
      const snapshotCoverage = jest
        .spyOn(service as any, 'getCertifiedCurrentSnapshotCommuneCount')
        .mockResolvedValue(1);
      jest
        .spyOn(service as any, 'loadRefData')
        .mockResolvedValue(referenceData);
      const departmentLoad = jest
        .spyOn(service as any, 'loadDailyDepartmentCollections')
        .mockResolvedValue({
          dataArea: [{ date: currentDate, ESO: {}, ESU: {}, AEP: {} }],
          dataDepartement: [departmentDay(currentDate)],
        });
      const communeLoad = jest
        .spyOn(service as any, 'loadDailyCommuneWeights')
        .mockResolvedValue(new Map([[currentDate, [['01001', 4]]]]));
      const fullBuild = jest.spyOn(
        service as any,
        'createFullArtifactCandidate',
      );

      const result = await (service as any).createArtifactCandidate(
        state,
        null,
        mockTransactionManager,
      );

      expect(result).toEqual(
        expect.objectContaining({
          statisticRevision: state.revision,
          currentPublishedDate: currentDate,
          mode: 'versioned',
          materializationStrategy: 'sparse-current',
          historicDirtyFrom: state.historicDirtyFrom,
          historicDirtyThrough: state.historicDirtyThrough,
          firstDate: currentDate,
          latestDate: currentDate,
          dateCount: 1,
          departmentCount: 101,
          communeCount: 1,
          dataCommune: [
            { code: '01001', restrictions: [{ d: '2026-08', p: 4 }] },
          ],
          latestCommuneWeights: [['01001', 4]],
        }),
      );
      expect(result.contentFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(snapshotCoverage).toHaveBeenCalledWith(
        state,
        mockTransactionManager,
      );
      expect(departmentLoad).toHaveBeenCalledWith(
        currentDate,
        currentDate,
        referenceData,
        mockTransactionManager,
      );
      expect(communeLoad).toHaveBeenCalledWith(
        currentDate,
        currentDate,
        1,
        state,
        mockTransactionManager,
      );
      expect(fullBuild).not.toHaveBeenCalled();
    });

    it('transitions a dirty legacy artifact to versioned without filling a missing day', async () => {
      const previousDate = '2026-08-17';
      const currentDate = '2026-08-19';
      const candidateId = '00000000-0000-4000-8000-000000000019';
      const state = {
        ...artifactState,
        revision: '39',
        activePublicationId: '00000000-0000-4000-8000-000000000039',
        statisticCachePublicationId: '00000000-0000-4000-8000-000000000017',
        currentPublishedDate: currentDate,
        historicDirtyFrom: '2011-06-07',
        historicDirtyThrough: '2026-08-16',
        historicMapCursor: '2014-10-07',
        historicStatsCursor: '2014-10-07',
        sourceRevision: '168348',
        historicComputeEpoch: '462',
      };
      const legacyActive = {
        ...activeArtifact,
        identity: {
          ...activeArtifact.identity,
          currentPublishedDate: previousDate,
          mode: 'legacy-bootstrap' as const,
          materializationStrategy: 'legacy-safe-boundary' as const,
          historicDirtyFrom: '2011-06-07',
          historicDirtyThrough: '2026-08-16',
          historicMapCursor: '2014-10-07',
          historicStatsCursor: '2014-10-07',
          sourceRevision: '166401',
          historicComputeEpoch: '462',
          firstDate: previousDate,
          latestDate: previousDate,
          dateCount: 1,
        },
        dataArea: [{ date: previousDate, ESO: {}, ESU: {}, AEP: {} }],
        dataDepartement: [departmentDay(previousDate)],
        dataCommune: [
          { code: '01001', restrictions: [{ d: '2026-08', p: 2 }] },
        ],
        latestCommuneWeights: [['01001', 2]] as Array<[string, number]>,
      };
      const referenceData = {
        departements: completeDepartments,
        regions: [],
        bassinsVersants: [],
        fullArea: 101,
        metropoleArea: 101,
      };
      jest
        .spyOn(service as any, 'loadRefData')
        .mockResolvedValue(referenceData);
      const rangeCoverage = jest.spyOn(
        service as any,
        'hasCertifiedDeltaSnapshotCoverage',
      );
      const currentCoverage = jest
        .spyOn(service as any, 'assertDeltaSnapshotCoverage')
        .mockResolvedValue(undefined);
      const departmentLoad = jest
        .spyOn(service as any, 'loadDailyDepartmentCollections')
        .mockResolvedValue({
          dataArea: [{ date: currentDate, ESO: {}, ESU: {}, AEP: {} }],
          dataDepartement: [departmentDay(currentDate)],
        });
      const communeLoad = jest
        .spyOn(service as any, 'loadDailyCommuneWeights')
        .mockResolvedValue(new Map([[currentDate, [['01001', 4]]]]));
      const fullBuild = jest.spyOn(
        service as any,
        'createFullArtifactCandidate',
      );

      const result = await (service as any).createArtifactCandidate(
        state,
        legacyActive,
        mockTransactionManager,
      );

      expect(result).toEqual(
        expect.objectContaining({
          mode: 'versioned',
          materializationStrategy: 'sparse-current',
          historicDirtyFrom: state.historicDirtyFrom,
          historicDirtyThrough: state.historicDirtyThrough,
          firstDate: previousDate,
          latestDate: currentDate,
          dateCount: 2,
        }),
      );
      expect(result.dataArea.map(({ date }) => date)).toEqual([
        previousDate,
        currentDate,
      ]);
      expect(result.dataDepartement.map(({ date }) => date)).toEqual([
        previousDate,
        currentDate,
      ]);
      expect(result.dataArea).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ date: '2026-08-18' }),
        ]),
      );
      expect(rangeCoverage).not.toHaveBeenCalled();
      expect(currentCoverage).toHaveBeenCalledWith(
        currentDate,
        currentDate,
        1,
        state,
        mockTransactionManager,
      );
      expect(departmentLoad).toHaveBeenCalledWith(
        currentDate,
        currentDate,
        referenceData,
        mockTransactionManager,
      );
      expect(communeLoad).toHaveBeenCalledWith(
        currentDate,
        currentDate,
        1,
        state,
        mockTransactionManager,
      );
      expect(fullBuild).not.toHaveBeenCalled();

      service['referenceDataCache'] = referenceData as any;
      const activatedState = {
        ...state,
        statisticCachePublicationId: candidateId,
      };
      const {
        dataArea,
        dataDepartement,
        dataCommune,
        latestCommuneWeights,
        ...candidateIdentity
      } = result;
      service['certifiedDataCache'] = (service as any).hydrateArtifactPayload(
        {
          identity: {
            id: candidateId,
            protocolVersion: 1,
            areaCount: dataArea.length,
            readyAt: new Date('2026-08-19T20:00:00.000Z'),
            ...candidateIdentity,
          },
          dataArea,
          dataDepartement,
          dataCommune,
          latestCommuneWeights,
        },
        activatedState,
      );
      process.env.STATISTIC_CACHE_ARTIFACT_MODE = 'read-write';
      (service as any).statisticCacheArtifactService = {};
      jest
        .spyOn(service as any, 'getPublicationState')
        .mockResolvedValue(activatedState);
      jest
        .spyOn(service as any, 'getStatisticPublicationExpectation')
        .mockReturnValue({
          today: currentDate,
          expectedPublishedDate: currentDate,
          deadline: '06:00',
          afterDeadline: true,
        });
      jest
        .spyOn(service as any, 'getLegacySnapshotCoverageStatus')
        .mockResolvedValue({
          incompleteSnapshotCount: 0,
          oldestIncompleteSnapshot: null,
        });
      jest
        .spyOn(service as any, 'getStatisticArtifactInstanceSummary')
        .mockResolvedValue({ liveInstances: 2, readyInstances: 2 });
      jest
        .spyOn(service as any, 'startCertifiedDataRefresh')
        .mockImplementation();

      await expect(service.getStatisticCacheStatus(true)).resolves.toEqual(
        expect.objectContaining({
          status: 'ready',
          currentFresh: true,
          historicComplete: false,
          mode: 'versioned',
          firstDate: previousDate,
          latestDate: currentDate,
          dateCount: 2,
        }),
      );
    });

    it('fails closed before loading data when the current bootstrap snapshot is not certified', async () => {
      const state = {
        ...artifactState,
        activePublicationId: '00000000-0000-4000-8000-000000000019',
        statisticCachePublicationId: null,
        currentPublishedDate: '2026-08-19',
      };
      mockTransactionManager.query.mockResolvedValue([
        {
          status: 'completed',
          expectedCommuneCount: 1,
          processedCommuneCount: 1,
          communeCount: 1,
          sourceRevision: 'stale-source',
        },
      ]);
      const referenceLoad = jest.spyOn(service as any, 'loadRefData');
      const departmentLoad = jest.spyOn(
        service as any,
        'loadDailyDepartmentCollections',
      );
      const communeLoad = jest.spyOn(service as any, 'loadDailyCommuneWeights');

      await expect(
        (service as any).createArtifactCandidate(
          state,
          null,
          mockTransactionManager,
        ),
      ).rejects.toThrow('current snapshot is not certified');
      expect(referenceLoad).not.toHaveBeenCalled();
      expect(departmentLoad).not.toHaveBeenCalled();
      expect(communeLoad).not.toHaveBeenCalled();
    });

    it('forces a full rebuild when statistics close before the map cursor advances', async () => {
      const cleanState = {
        ...artifactState,
        revision: '12',
        historicDirtyFrom: null,
        historicDirtyThrough: null,
        historicPublishedThrough: '2026-09-01',
        historicMapCursor: artifactState.historicMapCursor,
        historicStatsCursor: '2026-09-01',
      };
      const candidate = { materializationStrategy: 'full-clean' };
      const full = jest
        .spyOn(service as any, 'createFullArtifactCandidate')
        .mockResolvedValue(candidate);

      await expect(
        (service as any).createArtifactCandidate(
          cleanState,
          activeArtifact,
          mockTransactionManager,
        ),
      ).resolves.toBe(candidate);
      expect(full).toHaveBeenCalledWith(
        cleanState,
        'full-clean',
        mockTransactionManager,
      );
      expect(cleanState.historicMapCursor).toBe(
        activeArtifact.identity.historicMapCursor,
      );
    });

    it('replaces only the current slice when the clean map cursor advances', async () => {
      process.env.STATISTIC_CACHE_MODE = 'versioned';
      const currentDate = '2026-08-31';
      const state = {
        ...artifactState,
        revision: '12',
        activePublicationId: '00000000-0000-4000-8000-000000000012',
        currentPublishedDate: currentDate,
        historicPublishedThrough: currentDate,
        historicDirtyFrom: null,
        historicDirtyThrough: null,
        historicMapCursor: currentDate,
        historicStatsCursor: currentDate,
      };
      const cleanActive = {
        ...activeArtifact,
        identity: {
          ...activeArtifact.identity,
          statisticRevision: '12',
          currentPublishedDate: currentDate,
          mode: 'versioned' as const,
          materializationStrategy: 'full-clean' as const,
          historicDirtyFrom: null,
          historicDirtyThrough: null,
          historicMapCursor: '2026-08-30',
          historicStatsCursor: currentDate,
          firstDate: currentDate,
          latestDate: currentDate,
          dateCount: 1,
        },
        dataArea: [{ date: currentDate, ESO: {}, ESU: {}, AEP: {} }],
        dataDepartement: [departmentDay(currentDate)],
        dataCommune: [
          { code: '01001', restrictions: [{ d: '2026-08', p: 2 }] },
        ],
        latestCommuneWeights: [['01001', 2]],
      };
      const referenceData = {
        departements: completeDepartments,
        regions: [],
        bassinsVersants: [],
        fullArea: 101,
        metropoleArea: 101,
      };
      jest
        .spyOn(service as any, 'assertDeltaSnapshotCoverage')
        .mockResolvedValue(undefined);
      jest
        .spyOn(service as any, 'loadRefData')
        .mockResolvedValue(referenceData);
      jest
        .spyOn(service as any, 'loadDailyDepartmentCollections')
        .mockResolvedValue({
          dataArea: [{ date: currentDate, ESO: {}, ESU: {}, AEP: {} }],
          dataDepartement: [departmentDay(currentDate)],
        });
      jest
        .spyOn(service as any, 'loadDailyCommuneWeights')
        .mockResolvedValue(new Map([[currentDate, [['01001', 2]]]]));
      const full = jest.spyOn(service as any, 'createFullArtifactCandidate');
      const delta = jest.spyOn(service as any, 'createDeltaArtifactCandidate');

      await expect(
        (service as any).createArtifactCandidate(
          state,
          cleanActive,
          mockTransactionManager,
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          materializationStrategy: 'current-replace',
          statisticRevision: '12',
          historicMapCursor: currentDate,
          historicStatsCursor: currentDate,
        }),
      );
      expect(full).not.toHaveBeenCalled();
      expect(delta).toHaveBeenCalledWith(
        state,
        cleanActive,
        mockTransactionManager,
      );
    });

    it('appends several days across a month boundary even when revision changes', async () => {
      const referenceData = {
        departements: completeDepartments,
        regions: [],
        bassinsVersants: [],
        fullArea: 101,
        metropoleArea: 101,
      };
      jest
        .spyOn(service as any, 'loadRefData')
        .mockResolvedValue(referenceData);
      const snapshotCoverage = jest
        .spyOn(service as any, 'hasCertifiedDeltaSnapshotCoverage')
        .mockResolvedValue(true);
      jest
        .spyOn(service as any, 'loadDailyDepartmentCollections')
        .mockResolvedValue({
          dataArea: [
            { date: '2026-09-01', ESO: {}, ESU: {}, AEP: {} },
            { date: '2026-09-02', ESO: {}, ESU: {}, AEP: {} },
          ],
          dataDepartement: [
            departmentDay('2026-09-01'),
            departmentDay('2026-09-02'),
          ],
        });
      jest.spyOn(service as any, 'loadDailyCommuneWeights').mockResolvedValue(
        new Map([
          ['2026-09-01', [['01001', 3]]],
          ['2026-09-02', [['01001', 4]]],
        ]),
      );

      const result = await (service as any).createDeltaArtifactCandidate(
        artifactState,
        activeArtifact,
        mockTransactionManager,
      );

      expect(result.materializationStrategy).toBe('daily-delta');
      expect(result.statisticRevision).toBe('11');
      expect(result.latestDate).toBe('2026-09-02');
      expect(result.dateCount).toBe(3);
      expect(result.dataCommune).toEqual([
        {
          code: '01001',
          restrictions: [
            { d: '2026-08', p: 2 },
            { d: '2026-09', p: 7 },
          ],
        },
      ]);
      expect(snapshotCoverage).toHaveBeenCalledWith(
        '2026-09-01',
        '2026-09-02',
        1,
        artifactState,
        mockTransactionManager,
      );
    });

    it('appends only the certified current day when the previous day is missing', async () => {
      const previousDate = '2026-08-17';
      const currentDate = '2026-08-19';
      const sparsePublicationId = '00000000-0000-4000-8000-000000000019';
      const gapState = {
        ...artifactState,
        revision: '19',
        statisticCachePublicationId: sparsePublicationId,
        currentPublishedDate: currentDate,
        historicDirtyFrom: null,
        historicDirtyThrough: null,
        historicMapCursor: previousDate,
        historicStatsCursor: previousDate,
      };
      const gapActive = {
        ...activeArtifact,
        identity: {
          ...activeArtifact.identity,
          currentPublishedDate: previousDate,
          historicDirtyFrom: null,
          historicDirtyThrough: null,
          historicMapCursor: previousDate,
          historicStatsCursor: previousDate,
          firstDate: previousDate,
          latestDate: previousDate,
        },
        dataArea: [{ date: previousDate, ESO: {}, ESU: {}, AEP: {} }],
        dataDepartement: [departmentDay(previousDate)],
        dataCommune: [
          { code: '01001', restrictions: [{ d: '2026-08', p: 2 }] },
        ],
        latestCommuneWeights: [['01001', 2]],
      };
      const referenceData = {
        departements: completeDepartments,
        regions: [],
        bassinsVersants: [],
        fullArea: 101,
        metropoleArea: 101,
      };
      jest
        .spyOn(service as any, 'loadRefData')
        .mockResolvedValue(referenceData);
      const snapshotCoverage = jest
        .spyOn(service as any, 'hasCertifiedDeltaSnapshotCoverage')
        .mockResolvedValue(false);
      const currentSnapshotCoverage = jest
        .spyOn(service as any, 'assertDeltaSnapshotCoverage')
        .mockResolvedValue(undefined);
      const departmentLoad = jest
        .spyOn(service as any, 'loadDailyDepartmentCollections')
        .mockResolvedValue({
          dataArea: [{ date: currentDate, ESO: {}, ESU: {}, AEP: {} }],
          dataDepartement: [departmentDay(currentDate)],
        });
      const communeLoad = jest
        .spyOn(service as any, 'loadDailyCommuneWeights')
        .mockResolvedValue(new Map([[currentDate, [['01001', 4]]]]));

      const result = await (service as any).createDeltaArtifactCandidate(
        gapState,
        gapActive,
        mockTransactionManager,
      );

      expect(result.materializationStrategy).toBe('sparse-current');
      expect(result.dataArea.map(({ date }) => date)).toEqual([
        previousDate,
        currentDate,
      ]);
      expect(result.dataDepartement.map(({ date }) => date)).toEqual([
        previousDate,
        currentDate,
      ]);
      expect(result.dateCount).toBe(2);
      expect(result.dataCommune).toEqual([
        { code: '01001', restrictions: [{ d: '2026-08', p: 6 }] },
      ]);
      expect(snapshotCoverage).toHaveBeenCalledWith(
        '2026-08-18',
        currentDate,
        1,
        gapState,
        mockTransactionManager,
      );
      expect(currentSnapshotCoverage).toHaveBeenCalledWith(
        currentDate,
        currentDate,
        1,
        gapState,
        mockTransactionManager,
      );
      expect(departmentLoad).toHaveBeenCalledWith(
        currentDate,
        currentDate,
        referenceData,
        mockTransactionManager,
      );
      expect(communeLoad).toHaveBeenCalledWith(
        currentDate,
        currentDate,
        1,
        gapState,
        mockTransactionManager,
      );

      const {
        dataArea,
        dataDepartement,
        dataCommune,
        latestCommuneWeights,
        ...candidateIdentity
      } = result;
      service['referenceDataCache'] = referenceData as any;
      const hydrated = (service as any).hydrateArtifactPayload(
        {
          identity: {
            id: sparsePublicationId,
            protocolVersion: 1,
            areaCount: dataArea.length,
            readyAt: new Date('2026-08-19T06:00:00.000Z'),
            ...candidateIdentity,
          },
          dataArea,
          dataDepartement,
          dataCommune,
          latestCommuneWeights,
        },
        gapState,
      );
      expect(hydrated.dataArea.map(({ date }) => date)).toEqual([
        previousDate,
        currentDate,
      ]);
    });

    it('fails closed when the sparse current snapshot is not certified', async () => {
      const previousDate = '2026-08-17';
      const currentDate = '2026-08-19';
      const gapState = {
        ...artifactState,
        currentPublishedDate: currentDate,
        historicDirtyFrom: null,
        historicDirtyThrough: null,
        historicMapCursor: previousDate,
        historicStatsCursor: previousDate,
      };
      const gapActive = {
        ...activeArtifact,
        identity: {
          ...activeArtifact.identity,
          currentPublishedDate: previousDate,
          historicDirtyFrom: null,
          historicDirtyThrough: null,
          historicMapCursor: previousDate,
          historicStatsCursor: previousDate,
          firstDate: previousDate,
          latestDate: previousDate,
        },
      };
      jest.spyOn(service as any, 'loadRefData').mockResolvedValue({});
      const snapshotCoverage = jest
        .spyOn(service as any, 'hasCertifiedDeltaSnapshotCoverage')
        .mockResolvedValue(false);
      const currentSnapshotCoverage = jest
        .spyOn(service as any, 'assertDeltaSnapshotCoverage')
        .mockRejectedValue(
          new Error(
            `Statistic delta snapshots are not certified for ${currentDate}..${currentDate}`,
          ),
        );
      const departmentLoad = jest.spyOn(
        service as any,
        'loadDailyDepartmentCollections',
      );
      const communeLoad = jest.spyOn(service as any, 'loadDailyCommuneWeights');
      const fullBuild = jest.spyOn(
        service as any,
        'createFullArtifactCandidate',
      );

      await expect(
        (service as any).createArtifactCandidate(
          gapState,
          gapActive,
          mockTransactionManager,
        ),
      ).rejects.toThrow('snapshots are not certified');
      expect(snapshotCoverage).toHaveBeenCalledWith(
        '2026-08-18',
        currentDate,
        1,
        gapState,
        mockTransactionManager,
      );
      expect(currentSnapshotCoverage).toHaveBeenCalledWith(
        currentDate,
        currentDate,
        1,
        gapState,
        mockTransactionManager,
      );
      expect(departmentLoad).not.toHaveBeenCalled();
      expect(communeLoad).not.toHaveBeenCalled();
      expect(fullBuild).not.toHaveBeenCalled();
    });

    it('reports a sparse current artifact as current-fresh but historically incomplete', async () => {
      process.env.STATISTIC_CACHE_ARTIFACT_MODE = 'read-write';
      (service as any).statisticCacheArtifactService = {};
      const currentDate = '2026-08-19';
      const activeId = '00000000-0000-4000-8000-000000000019';
      const state = {
        ...artifactState,
        revision: '19',
        statisticCachePublicationId: activeId,
        currentPublishedDate: currentDate,
        historicDirtyFrom: null,
        historicDirtyThrough: null,
        historicMapCursor: '2026-08-17',
        historicStatsCursor: '2026-08-17',
      };
      const completeDateCount = (service as any).countCivilDates(
        '2013-01-01',
        currentDate,
      );
      certifyData({
        revision: state.revision,
        publicationState: state,
        mode: 'legacy-bootstrap',
        firstDate: '2013-01-01',
        latestDate: currentDate,
        dateCount: completeDateCount - 1,
        artifactPublicationId: activeId,
        artifactProtocolVersion: 1,
        artifactSourceRevision: state.sourceRevision,
        artifactHistoricDirtyFrom: null,
        artifactHistoricDirtyThrough: null,
        artifactHistoricMapCursor: state.historicMapCursor,
        artifactHistoricStatsCursor: state.historicStatsCursor,
        artifactHistoricComputeEpoch: state.historicComputeEpoch,
        latestCommuneWeights: [],
      });
      jest
        .spyOn(service as any, 'getPublicationState')
        .mockResolvedValue(state);
      jest
        .spyOn(service as any, 'getStatisticPublicationExpectation')
        .mockReturnValue({
          today: currentDate,
          expectedPublishedDate: currentDate,
          deadline: '06:00',
          afterDeadline: true,
        });
      jest
        .spyOn(service as any, 'getLegacySnapshotCoverageStatus')
        .mockResolvedValue({
          incompleteSnapshotCount: 0,
          oldestIncompleteSnapshot: null,
        });
      jest
        .spyOn(service as any, 'getStatisticArtifactInstanceSummary')
        .mockResolvedValue({ liveInstances: 2, readyInstances: 2 });
      jest
        .spyOn(service as any, 'startCertifiedDataRefresh')
        .mockImplementation();

      await expect(service.getStatisticCacheStatus(true)).resolves.toEqual(
        expect.objectContaining({
          status: 'ready',
          currentFresh: true,
          historicComplete: false,
          dateCount: completeDateCount - 1,
        }),
      );
    });

    it.each([
      ['before map publication', '2023-01-01', '2022-12-31', 0, false],
      ['after map publication', '2023-01-01', '2023-01-01', 0, true],
      [
        'after map publication with an incomplete snapshot',
        '2023-01-01',
        '2023-01-01',
        1,
        false,
      ],
      ['legacy boundary without a published watermark', null, null, 0, true],
    ])(
      'reports historic completion %s',
      async (
        _label,
        historicPublishedThrough,
        historicMapCursor,
        incompleteSnapshotCount,
        expectedHistoricComplete,
      ) => {
        process.env.STATISTIC_CACHE_ARTIFACT_MODE = 'read-write';
        (service as any).statisticCacheArtifactService = {};
        const activeId = '00000000-0000-4000-8000-000000000024';
        const state = {
          ...stablePublicationState,
          revision: '24',
          statisticCachePublicationId: activeId,
          historicPublishedThrough,
          historicMapCursor,
          historicStatsCursor: '2023-01-01',
          sourceRevision: '42',
          historicComputeEpoch: '7',
        };
        certifyData({
          revision: state.revision,
          publicationState: state,
          mode: 'versioned',
          firstDate: '2023-01-01',
          latestDate: state.currentPublishedDate,
          dateCount: 2,
          artifactPublicationId: activeId,
          artifactProtocolVersion: 1,
          artifactSourceRevision: state.sourceRevision,
          artifactHistoricDirtyFrom: null,
          artifactHistoricDirtyThrough: null,
          artifactHistoricMapCursor: state.historicMapCursor,
          artifactHistoricStatsCursor: state.historicStatsCursor,
          artifactHistoricComputeEpoch: state.historicComputeEpoch,
          latestCommuneWeights: [],
        });
        service['legacySnapshotCoverageDirty'] = true;
        jest
          .spyOn(service as any, 'getPublicationState')
          .mockResolvedValue(state);
        jest
          .spyOn(service as any, 'getLegacySnapshotCoverageStatus')
          .mockResolvedValue({
            incompleteSnapshotCount,
            oldestIncompleteSnapshot: null,
          });
        jest
          .spyOn(service as any, 'getStatisticArtifactInstanceSummary')
          .mockResolvedValue({ liveInstances: 2, readyInstances: 2 });
        jest
          .spyOn(service as any, 'isLegacyCacheContinuous')
          .mockReturnValue(true);

        await expect(service.getStatisticCacheStatus(true)).resolves.toEqual(
          expect.objectContaining({
            currentFresh: true,
            historicComplete: expectedHistoricComplete,
          }),
        );
      },
    );

    it('replaces the current date by subtracting its previous private weight first', async () => {
      const sameDateState = {
        ...artifactState,
        currentPublishedDate: '2026-08-31',
      };
      const referenceData = {
        departements: completeDepartments,
        regions: [],
        bassinsVersants: [],
        fullArea: 101,
        metropoleArea: 101,
      };
      jest
        .spyOn(service as any, 'loadRefData')
        .mockResolvedValue(referenceData);
      jest
        .spyOn(service as any, 'assertDeltaSnapshotCoverage')
        .mockResolvedValue(undefined);
      jest
        .spyOn(service as any, 'loadDailyDepartmentCollections')
        .mockResolvedValue({
          dataArea: [{ date: '2026-08-31', ESO: {}, ESU: {}, AEP: {} }],
          dataDepartement: [departmentDay('2026-08-31')],
        });
      jest
        .spyOn(service as any, 'loadDailyCommuneWeights')
        .mockResolvedValue(new Map([['2026-08-31', [['01001', 4]]]]));

      const result = await (service as any).createDeltaArtifactCandidate(
        sameDateState,
        {
          ...activeArtifact,
          dataCommune: [
            { code: '01001', restrictions: [{ d: '2026-08', p: 5 }] },
          ],
        },
        mockTransactionManager,
      );

      expect(result.materializationStrategy).toBe('current-replace');
      expect(result.dataCommune).toEqual([
        { code: '01001', restrictions: [{ d: '2026-08', p: 7 }] },
      ]);
      expect(result.latestCommuneWeights).toEqual([['01001', 4]]);
    });

    it('rejects a delta whose current national snapshot has another source', async () => {
      mockTransactionManager.query.mockResolvedValue([
        {
          snapshotDate: '2026-09-02',
          status: 'completed',
          expectedCommuneCount: 1,
          processedCommuneCount: 1,
          sourceRevision: '41',
        },
      ]);

      await expect(
        (service as any).assertDeltaSnapshotCoverage(
          '2026-09-02',
          '2026-09-02',
          1,
          artifactState,
          mockTransactionManager,
        ),
      ).rejects.toThrow('snapshots are not certified');
    });

    it('loads reference data before hydrating an active artifact on cold start', async () => {
      process.env.STATISTIC_CACHE_ARTIFACT_MODE = 'read-write';
      const artifactService = {
        loadActive: jest.fn(),
        materialize: jest.fn(),
      };
      const coldService = new DataService(
        mockRepository as any,
        mockRepository as any,
        mockRepository as any,
        mockRepository as any,
        mockRepository as any,
        mockDataSource as any,
        artifactService as any,
      );
      const referenceData = {
        departements: completeDepartments,
        regions: [],
        bassinsVersants: [],
        fullArea: 101,
        metropoleArea: 101,
      };
      const state = {
        ...artifactState,
        revision: '10',
        currentPublishedDate: '2026-08-31',
        historicDirtyFrom: activeArtifact.identity.historicDirtyFrom,
        historicDirtyThrough: activeArtifact.identity.historicDirtyThrough,
        historicMapCursor: activeArtifact.identity.historicMapCursor,
        historicStatsCursor: activeArtifact.identity.historicStatsCursor,
        sourceRevision: activeArtifact.identity.sourceRevision,
        historicComputeEpoch: activeArtifact.identity.historicComputeEpoch,
      };
      const payload = structuredClone(activeArtifact) as any;
      payload.identity.readyAt = new Date('2026-08-31T06:00:00.000Z');
      const cacheWithoutFingerprint = {
        ...referenceData,
        revision: '10',
        publicationState: state,
        mode: 'legacy-bootstrap',
        dataArea: payload.dataArea,
        dataDepartement: payload.dataDepartement,
        dataCommune: payload.dataCommune,
        firstDate: '2026-08-31',
        latestDate: '2026-08-31',
        dateCount: 1,
        departmentCount: 101,
        communeCount: 1,
        artifactPublicationId: payload.identity.id,
        latestCommuneWeights: payload.latestCommuneWeights,
        artifactHistoricDirtyFrom: payload.identity.historicDirtyFrom,
        artifactHistoricDirtyThrough: payload.identity.historicDirtyThrough,
        artifactHistoricMapCursor: payload.identity.historicMapCursor,
        artifactHistoricStatsCursor: payload.identity.historicStatsCursor,
        loadedAt: payload.identity.readyAt,
      };
      payload.identity.contentFingerprint = (
        coldService as any
      ).computeStatisticCacheFingerprint(cacheWithoutFingerprint);
      artifactService.loadActive.mockResolvedValue(payload);
      const ensureReferences = jest
        .spyOn(coldService as any, 'ensureReferenceDataCache')
        .mockImplementation(async () => {
          coldService['referenceDataCache'] = referenceData as any;
          return referenceData;
        });

      const loaded = await (coldService as any).loadArtifactBackedData(state);

      expect(ensureReferences).toHaveBeenCalledTimes(1);
      expect(artifactService.materialize).not.toHaveBeenCalled();
      expect(loaded.artifactPublicationId).toBe(payload.identity.id);
      expect(JSON.stringify(loaded.dataCommune)).not.toContain(
        'latestCommuneWeights',
      );
    });

    it('materializes a complete non-distributed target when only the clean map cursor advances', async () => {
      process.env.STATISTIC_CACHE_ARTIFACT_MODE = 'read-write';
      process.env.STATISTIC_CACHE_MODE = 'versioned';
      process.env.STATISTIC_CACHE_DISTRIBUTED_REFRESH_ENABLED = 'false';
      const currentDate = '2026-08-31';
      const state = {
        ...artifactState,
        revision: '12',
        currentPublishedDate: currentDate,
        historicPublishedThrough: currentDate,
        historicDirtyFrom: null,
        historicDirtyThrough: null,
        historicMapCursor: currentDate,
        historicStatsCursor: currentDate,
      };
      const staleActive = {
        ...activeArtifact,
        identity: {
          ...activeArtifact.identity,
          statisticRevision: state.revision,
          currentPublishedDate: currentDate,
          mode: 'versioned' as const,
          materializationStrategy: 'full-clean' as const,
          historicDirtyFrom: null,
          historicDirtyThrough: null,
          historicMapCursor: '2026-08-30',
          historicStatsCursor: currentDate,
          firstDate: currentDate,
          latestDate: currentDate,
          dateCount: 1,
        },
        dataArea: [{ date: currentDate, ESO: {}, ESU: {}, AEP: {} }],
        dataDepartement: [departmentDay(currentDate)],
      };
      const artifactService = {
        loadActive: jest.fn().mockResolvedValue(staleActive),
        materialize: jest.fn(),
      };
      const referenceData = {
        departements: completeDepartments,
        regions: [],
        bassinsVersants: [],
        fullArea: 101,
        metropoleArea: 101,
      };
      (service as any).statisticCacheArtifactService = artifactService;
      jest
        .spyOn(service as any, 'readPublicationState')
        .mockResolvedValue(state);
      jest
        .spyOn(service as any, 'assertDeltaSnapshotCoverage')
        .mockResolvedValue(undefined);
      jest
        .spyOn(service as any, 'loadRefData')
        .mockResolvedValue(referenceData);
      jest
        .spyOn(service as any, 'loadDailyDepartmentCollections')
        .mockResolvedValue({
          dataArea: staleActive.dataArea,
          dataDepartement: staleActive.dataDepartement,
        });
      jest
        .spyOn(service as any, 'loadDailyCommuneWeights')
        .mockResolvedValue(new Map([[currentDate, [['01001', 2]]]]));
      const replacement = {
        ...staleActive,
        identity: {
          ...staleActive.identity,
          id: '00000000-0000-4000-8000-000000000013',
          materializationStrategy: 'current-replace' as const,
          historicMapCursor: currentDate,
        },
      };
      let builtCandidate: any;
      artifactService.materialize.mockImplementation(
        async (_target: any, factory: any) => {
          builtCandidate = await factory(mockTransactionManager);
          return replacement;
        },
      );
      const hydrated = { artifactPublicationId: replacement.identity.id };
      jest
        .spyOn(service as any, 'hydrateArtifactPayload')
        .mockReturnValue(hydrated);

      await expect(
        (service as any).loadArtifactBackedData(state),
      ).resolves.toBe(hydrated);

      expect(artifactService.materialize).toHaveBeenCalledWith(
        {
          statisticRevision: state.revision,
          currentPublishedDate: currentDate,
          protocolVersion: 1,
          historicDirtyFrom: null,
          historicDirtyThrough: null,
          historicMapCursor: currentDate,
          historicStatsCursor: currentDate,
          sourceRevision: state.sourceRevision,
          historicComputeEpoch: state.historicComputeEpoch,
          certifiedHistoryRepairId: null,
        },
        expect.any(Function),
      );
      expect(builtCandidate).toEqual(
        expect.objectContaining({
          materializationStrategy: 'current-replace',
          historicMapCursor: currentDate,
          historicStatsCursor: currentDate,
        }),
      );
      expect(artifactService.loadActive).toHaveBeenCalledTimes(2);
    });

    it('uses a local hydration timestamp while preserving one artifact identity across instances', () => {
      const referenceData = {
        departements: completeDepartments,
        regions: [],
        bassinsVersants: [],
        fullArea: 101,
        metropoleArea: 101,
      };
      const state = {
        ...artifactState,
        revision: '10',
        statisticCachePublicationId: activeArtifact.identity.id,
        currentPublishedDate: '2026-08-31',
      };
      const createInstance = () => {
        const instance = new DataService(
          mockRepository as any,
          mockRepository as any,
          mockRepository as any,
          mockRepository as any,
          mockRepository as any,
          mockDataSource as any,
          {} as any,
        );
        instance['referenceDataCache'] = referenceData as any;
        return instance;
      };
      const firstService = createInstance();
      const secondService = createInstance();
      const payload = structuredClone(activeArtifact) as any;
      const fingerprintInput = {
        ...referenceData,
        revision: '10',
        publicationState: state,
        mode: payload.identity.mode,
        dataArea: payload.dataArea,
        dataDepartement: payload.dataDepartement,
        dataCommune: payload.dataCommune,
        firstDate: payload.identity.firstDate,
        latestDate: payload.identity.latestDate,
        dateCount: payload.identity.dateCount,
        departmentCount: payload.identity.departmentCount,
        communeCount: payload.identity.communeCount,
        artifactPublicationId: payload.identity.id,
        artifactSourceRevision: payload.identity.sourceRevision,
        latestCommuneWeights: payload.latestCommuneWeights,
        artifactHistoricDirtyFrom: payload.identity.historicDirtyFrom,
        artifactHistoricDirtyThrough: payload.identity.historicDirtyThrough,
        artifactHistoricMapCursor: payload.identity.historicMapCursor,
        artifactHistoricStatsCursor: payload.identity.historicStatsCursor,
        artifactHistoricComputeEpoch: payload.identity.historicComputeEpoch,
        loadedAt: new Date(),
      };
      payload.identity.contentFingerprint = (
        firstService as any
      ).computeStatisticCacheFingerprint(fingerprintInput);

      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date('2026-08-31T06:01:00.000Z'));
        const first = (firstService as any).hydrateArtifactPayload(
          payload,
          state,
        );
        jest.setSystemTime(new Date('2026-08-31T06:02:00.000Z'));
        const second = (secondService as any).hydrateArtifactPayload(
          payload,
          state,
        );

        expect(first.artifactPublicationId).toBe(second.artifactPublicationId);
        expect(first.fingerprint).toBe(second.fingerprint);
        expect(first.loadedAt.toISOString()).toBe('2026-08-31T06:01:00.000Z');
        expect(second.loadedAt.toISOString()).toBe('2026-08-31T06:02:00.000Z');
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps current health ready across a historic-only revision bump and refreshes the full artifact', async () => {
      process.env.STATISTIC_CACHE_ARTIFACT_MODE = 'read-write';
      process.env.STATISTIC_CACHE_MODE = 'legacy-bootstrap';
      (service as any).statisticCacheArtifactService = {};
      const activeId = '00000000-0000-4000-8000-000000000020';
      const stateAfterHistoricPublish = {
        ...stablePublicationState,
        revision: '12',
        statisticCachePublicationId: activeId,
        sourceRevision: '42',
        historicMapCursor: '2023-01-01',
        historicStatsCursor: '2023-01-01',
        historicComputeEpoch: '7',
      };
      certifyData({
        revision: '11',
        publicationState: {
          ...stateAfterHistoricPublish,
          revision: '11',
          historicDirtyFrom: '2023-01-01',
          historicDirtyThrough: '2023-01-01',
        },
        mode: 'legacy-bootstrap',
        latestDate: '2023-01-02',
        artifactPublicationId: activeId,
        artifactSourceRevision: '42',
        artifactHistoricDirtyFrom: '2023-01-01',
        artifactHistoricDirtyThrough: '2023-01-01',
        artifactHistoricMapCursor: '2023-01-01',
        artifactHistoricStatsCursor: '2023-01-01',
        artifactHistoricComputeEpoch: '7',
        latestCommuneWeights: [],
      });
      (service as any).lastDataCacheError = {
        at: new Date('2023-01-02T08:00:00.000Z'),
        phase: 'refresh',
      };
      jest
        .spyOn(service as any, 'getPublicationState')
        .mockResolvedValue(stateAfterHistoricPublish);
      jest
        .spyOn(service as any, 'getLegacySnapshotCoverageStatus')
        .mockResolvedValue({
          incompleteSnapshotCount: 0,
          oldestIncompleteSnapshot: null,
        });
      jest
        .spyOn(service as any, 'isLegacyCacheContinuous')
        .mockReturnValue(true);
      jest
        .spyOn(service as any, 'getStatisticArtifactInstanceSummary')
        .mockResolvedValue({ liveInstances: 2, readyInstances: 2 });
      const refresh = jest
        .spyOn(service as any, 'startCertifiedDataRefresh')
        .mockImplementation();

      await expect(service.getStatisticCacheStatus(true)).resolves.toEqual(
        expect.objectContaining({
          status: 'ready',
          fresh: true,
          currentFresh: true,
          historicComplete: false,
          artifactPublicationId: activeId,
          artifactLiveInstances: 2,
          artifactReadyInstances: 2,
          lastError: expect.objectContaining({ phase: 'refresh' }),
        }),
      );
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('fails current freshness on source drift without rebuilding an exact historic identity', async () => {
      process.env.STATISTIC_CACHE_ARTIFACT_MODE = 'read-write';
      process.env.STATISTIC_CACHE_MODE = 'legacy-bootstrap';
      (service as any).statisticCacheArtifactService = {};
      const activeId = '00000000-0000-4000-8000-000000000021';
      const baseState = {
        ...stablePublicationState,
        revision: '11',
        statisticCachePublicationId: activeId,
        sourceRevision: '42',
        historicMapCursor: '2023-01-01',
        historicStatsCursor: '2023-01-01',
        historicComputeEpoch: '8',
      };
      certifyData({
        revision: '11',
        publicationState: baseState,
        mode: 'legacy-bootstrap',
        latestDate: '2023-01-02',
        artifactPublicationId: activeId,
        artifactSourceRevision: '42',
        artifactHistoricDirtyFrom: null,
        artifactHistoricDirtyThrough: null,
        artifactHistoricMapCursor: '2023-01-01',
        artifactHistoricStatsCursor: '2023-01-01',
        artifactHistoricComputeEpoch: '8',
        latestCommuneWeights: [],
      });
      jest
        .spyOn(service as any, 'getLegacySnapshotCoverageStatus')
        .mockResolvedValue({
          incompleteSnapshotCount: 0,
          oldestIncompleteSnapshot: null,
        });
      jest
        .spyOn(service as any, 'isLegacyCacheContinuous')
        .mockReturnValue(true);
      const refresh = jest
        .spyOn(service as any, 'startCertifiedDataRefresh')
        .mockImplementation();
      const getState = jest
        .spyOn(service as any, 'getPublicationState')
        .mockResolvedValue(baseState);

      await expect(service.getStatisticCacheStatus(true)).resolves.toEqual(
        expect.objectContaining({
          currentFresh: true,
          historicComplete: true,
        }),
      );

      getState.mockResolvedValue({ ...baseState, sourceRevision: '43' });
      await expect(service.getStatisticCacheStatus(true)).resolves.toEqual(
        expect.objectContaining({
          status: 'degraded',
          currentFresh: false,
          historicComplete: false,
        }),
      );
      expect(refresh).not.toHaveBeenCalled();
    });

    it('does not refresh an exact active artifact while dirty cursors advance', async () => {
      process.env.STATISTIC_CACHE_ARTIFACT_MODE = 'read-write';
      process.env.STATISTIC_CACHE_MODE = 'legacy-bootstrap';
      (service as any).statisticCacheArtifactService = {};
      const activeId = '00000000-0000-4000-8000-000000000022';
      const cachedState = {
        ...stablePublicationState,
        revision: '11',
        statisticCachePublicationId: activeId,
        sourceRevision: '42',
        historicDirtyFrom: '2022-01-01',
        historicDirtyThrough: '2022-01-31',
        historicMapCursor: '2022-01-02',
        historicStatsCursor: '2022-01-02',
        historicComputeEpoch: '8',
      };
      const progressedState = {
        ...cachedState,
        historicMapCursor: '2022-01-03',
        historicStatsCursor: '2022-01-03',
      };
      certifyData({
        revision: '11',
        publicationState: cachedState,
        mode: 'legacy-bootstrap',
        latestDate: cachedState.currentPublishedDate,
        artifactPublicationId: activeId,
        artifactSourceRevision: '42',
        artifactHistoricDirtyFrom: '2022-01-01',
        artifactHistoricDirtyThrough: '2022-01-31',
        artifactHistoricMapCursor: '2022-01-02',
        artifactHistoricStatsCursor: '2022-01-02',
        artifactHistoricComputeEpoch: '8',
        latestCommuneWeights: [],
      });
      jest
        .spyOn(service as any, 'getPublicationState')
        .mockResolvedValue(progressedState);
      jest
        .spyOn(service as any, 'getLegacySnapshotCoverageStatus')
        .mockResolvedValue({
          incompleteSnapshotCount: 0,
          oldestIncompleteSnapshot: null,
        });
      jest
        .spyOn(service as any, 'isLegacyCacheContinuous')
        .mockReturnValue(true);
      jest
        .spyOn(service as any, 'getStatisticArtifactInstanceSummary')
        .mockResolvedValue({ liveInstances: 2, readyInstances: 2 });
      const refresh = jest
        .spyOn(service as any, 'startCertifiedDataRefresh')
        .mockImplementation();

      await expect(service.getStatisticCacheStatus(true)).resolves.toEqual(
        expect.objectContaining({
          currentFresh: true,
          historicComplete: false,
        }),
      );
      await service.getStatisticCacheStatus(true);

      expect(refresh).not.toHaveBeenCalled();
    });

    it('requests a non-distributed refresh after a clean map-only identity change', async () => {
      process.env.STATISTIC_CACHE_ARTIFACT_MODE = 'read-write';
      process.env.STATISTIC_CACHE_MODE = 'versioned';
      process.env.STATISTIC_CACHE_DISTRIBUTED_REFRESH_ENABLED = 'false';
      (service as any).statisticCacheArtifactService = {};
      const activeId = '00000000-0000-4000-8000-000000000023';
      const state = {
        ...stablePublicationState,
        revision: '12',
        statisticCachePublicationId: activeId,
        historicPublishedThrough: '2023-01-01',
        historicMapCursor: '2023-01-01',
        historicStatsCursor: '2023-01-01',
        sourceRevision: '42',
        historicComputeEpoch: '8',
      };
      certifyData({
        revision: state.revision,
        publicationState: { ...state, historicMapCursor: '2022-12-31' },
        mode: 'versioned',
        latestDate: state.currentPublishedDate,
        artifactPublicationId: activeId,
        artifactProtocolVersion: 1,
        artifactSourceRevision: state.sourceRevision,
        artifactHistoricDirtyFrom: null,
        artifactHistoricDirtyThrough: null,
        artifactHistoricMapCursor: '2022-12-31',
        artifactHistoricStatsCursor: state.historicStatsCursor,
        artifactHistoricComputeEpoch: state.historicComputeEpoch,
        latestCommuneWeights: [],
      });
      jest
        .spyOn(service as any, 'getPublicationState')
        .mockResolvedValue(state);
      jest
        .spyOn(service as any, 'getLegacySnapshotCoverageStatus')
        .mockResolvedValue({
          incompleteSnapshotCount: 0,
          oldestIncompleteSnapshot: null,
        });
      jest
        .spyOn(service as any, 'isLegacyCacheContinuous')
        .mockReturnValue(true);
      jest
        .spyOn(service as any, 'getStatisticArtifactInstanceSummary')
        .mockResolvedValue({ liveInstances: 1, readyInstances: 1 });
      const refresh = jest
        .spyOn(service as any, 'startCertifiedDataRefresh')
        .mockImplementation();

      await expect(service.getStatisticCacheStatus(true)).resolves.toEqual(
        expect.objectContaining({
          currentFresh: true,
          historicComplete: false,
        }),
      );

      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });

  describe('distributed statistic cache', () => {
    const distributedState = {
      ...stablePublicationState,
      revision: '100',
      statisticCachePublicationId: '00000000-0000-4000-8000-000000000100',
      currentPublishedDate: '2026-08-19',
      sourceRevision: '42',
    };

    beforeEach(() => {
      process.env.STATISTIC_CACHE_ARTIFACT_MODE = 'read-write';
      process.env.STATISTIC_CACHE_DISTRIBUTED_REFRESH_ENABLED = 'true';
    });

    it('acknowledges the loaded active artifact instead of the newer target state', async () => {
      const activeId = '00000000-0000-4000-8000-000000000034';
      const targetState = {
        ...distributedState,
        revision: '38',
        statisticCachePublicationId: activeId,
        currentPublishedDate: '2026-08-19',
        sourceRevision: '168348',
      };
      const artifactIdentity = {
        id: activeId,
        statisticRevision: '34',
        currentPublishedDate: '2026-08-17',
        protocolVersion: 1,
        mode: 'versioned',
        materializationStrategy: 'sparse-current',
        historicDirtyFrom: '2013-01-01',
        historicDirtyThrough: '2026-08-16',
        historicMapCursor: '2026-08-16',
        historicStatsCursor: '2026-08-16',
        sourceRevision: '166401',
        historicComputeEpoch: '7',
        contentFingerprint: 'a'.repeat(64),
        firstDate: '2026-08-17',
        latestDate: '2026-08-17',
        dateCount: 1,
        areaCount: 1,
        departmentCount: 101,
        communeCount: 34943,
        readyAt: new Date('2026-08-17T06:00:00.000Z'),
      };
      const loadedArtifact = certifyData({
        revision: artifactIdentity.statisticRevision,
        publicationState: targetState,
        latestDate: artifactIdentity.latestDate,
        fingerprint: artifactIdentity.contentFingerprint,
        artifactIdentity,
        artifactPublicationId: artifactIdentity.id,
        artifactProtocolVersion: artifactIdentity.protocolVersion,
        artifactSourceRevision: artifactIdentity.sourceRevision,
      });
      (service as any).statisticCacheArtifactService = {};
      service['certifiedDataCache'] = null;
      jest
        .spyOn(service as any, 'loadArtifactBackedData')
        .mockResolvedValue(loadedArtifact);
      jest
        .spyOn(service as any, 'getPublicationState')
        .mockResolvedValue(targetState);

      await service.loadData(targetState);

      expect(service['certifiedDataCache']?.revision).toBe('34');
      expect(service.getStatisticCacheAcknowledgement()).toEqual(
        expect.objectContaining({
          statisticCachePublicationId: activeId,
          statisticRevision: '34',
          statisticPublishedDate: '2026-08-17',
          statisticSourceRevision: '166401',
          statisticFingerprint: 'a'.repeat(64),
          statisticProtocolVersion: 1,
          statisticLastError: null,
        }),
      );
    });

    it('nulls the complete active identity when the loaded artifact cache is internally inconsistent', () => {
      const artifactIdentity = {
        id: '00000000-0000-4000-8000-000000000034',
        statisticRevision: '34',
        currentPublishedDate: '2026-08-17',
        protocolVersion: 1,
        mode: 'versioned',
        materializationStrategy: 'sparse-current',
        historicDirtyFrom: null,
        historicDirtyThrough: null,
        historicMapCursor: null,
        historicStatsCursor: null,
        sourceRevision: '166401',
        historicComputeEpoch: null,
        contentFingerprint: 'a'.repeat(64),
        firstDate: '2026-08-17',
        latestDate: '2026-08-17',
        dateCount: 1,
        areaCount: 1,
        departmentCount: 101,
        communeCount: 34943,
        readyAt: new Date('2026-08-17T06:00:00.000Z'),
      };
      certifyData({
        revision: '38',
        latestDate: artifactIdentity.latestDate,
        fingerprint: artifactIdentity.contentFingerprint,
        artifactIdentity,
        artifactPublicationId: artifactIdentity.id,
        artifactProtocolVersion: artifactIdentity.protocolVersion,
        artifactSourceRevision: artifactIdentity.sourceRevision,
      });

      expect(service.getStatisticCacheAcknowledgement()).toEqual(
        expect.objectContaining({
          statisticCachePublicationId: null,
          statisticRevision: null,
          statisticPublishedDate: null,
          statisticSourceRevision: null,
          statisticFingerprint: null,
          statisticProtocolVersion: null,
          statisticLastError: 'statistic-artifact-identity-inconsistent',
        }),
      );
    });

    it('loads only the active artifact on a web refresh', async () => {
      const payload = { identity: { id: 'active' } } as any;
      const artifactService = {
        loadActive: jest.fn().mockResolvedValue(payload),
        materialize: jest.fn(),
      };
      (service as any).statisticCacheArtifactService = artifactService;
      jest
        .spyOn(service as any, 'ensureReferenceDataCache')
        .mockResolvedValue(service['referenceDataCache']);
      jest
        .spyOn(service as any, 'startCandidateDataPreload')
        .mockImplementation();
      const hydrated = { artifactPublicationId: 'active' };
      jest
        .spyOn(service as any, 'hydrateArtifactPayload')
        .mockReturnValue(hydrated);

      await expect(
        (service as any).loadArtifactBackedData(distributedState),
      ).resolves.toBe(hydrated);
      expect(artifactService.materialize).not.toHaveBeenCalled();
    });

    it('rejects a preloaded overlay promoted after its repair was revoked', async () => {
      const activeId = '00000000-0000-4000-8000-000000000048';
      const repairId = '00000000-0000-4000-8000-000000000049';
      const repairedState = {
        ...distributedState,
        revision: '48',
        statisticCachePublicationId: activeId,
        historicDirtyFrom: '2026-07-11',
        historicDirtyThrough: '2026-08-27',
        historicComputeEpoch: '9',
        certifiedHistoryRepairId: repairId,
        certifiedHistoryRepairFrom: '2026-07-11',
        certifiedHistoryRepairThrough: '2026-08-27',
        certifiedHistoryRepairSourceRunId: 'certified-source-run',
        certifiedHistoryRepairActivatedAt: '2026-08-29T12:00:00.000Z',
        certifiedHistoryRepairRevision: '48',
      };
      const revokedState = {
        ...repairedState,
        certifiedHistoryRepairId: null,
        certifiedHistoryRepairFrom: null,
        certifiedHistoryRepairThrough: null,
        certifiedHistoryRepairSourceRunId: null,
        certifiedHistoryRepairActivatedAt: null,
        certifiedHistoryRepairRevision: null,
      };
      const overlayIdentity = {
        id: activeId,
        statisticRevision: repairedState.revision,
        currentPublishedDate: repairedState.currentPublishedDate,
        protocolVersion: 1,
        mode: 'versioned',
        materializationStrategy: 'certified-history-overlay',
        historicDirtyFrom: repairedState.historicDirtyFrom,
        historicDirtyThrough: repairedState.historicDirtyThrough,
        historicMapCursor: repairedState.historicMapCursor,
        historicStatsCursor: repairedState.historicStatsCursor,
        sourceRevision: repairedState.sourceRevision,
        historicComputeEpoch: repairedState.historicComputeEpoch,
        certifiedHistoryRepairId: repairId,
      };
      const overlayCandidate = {
        ...service['referenceDataCache'],
        revision: repairedState.revision,
        publicationState: repairedState,
        dataArea: [],
        dataCommune: [],
        dataDepartement: [],
        artifactPublicationId: activeId,
        artifactIdentity: overlayIdentity,
      };
      const activePayload = { identity: { id: activeId } };
      const sparseCache = {
        ...overlayCandidate,
        publicationState: revokedState,
        artifactIdentity: {
          ...overlayIdentity,
          materializationStrategy: 'sparse-current',
          certifiedHistoryRepairId: null,
        },
      };
      const artifactService = {
        loadActive: jest.fn().mockResolvedValue(activePayload),
      };
      (service as any).statisticCacheArtifactService = artifactService;
      service['candidateDataCache'] = overlayCandidate as any;
      jest
        .spyOn(service as any, 'hydrateArtifactPayload')
        .mockReturnValue(sparseCache);

      await expect(
        (service as any).loadArtifactBackedData(revokedState),
      ).resolves.toBe(sparseCache);

      expect(artifactService.loadActive).toHaveBeenCalledTimes(1);
      expect(service['candidateDataCache']).toBeNull();
    });

    it('classifies a publication drift as superseded instead of throwing', async () => {
      const artifactService = {
        loadActiveIdentity: jest.fn().mockResolvedValue(null),
        stageCandidate: jest
          .fn()
          .mockRejectedValue(
            new Error(
              'Statistic publication state changed before materialization',
            ),
          ),
      };
      (service as any).statisticCacheArtifactService = artifactService;
      jest
        .spyOn(service as any, 'getPublicationState')
        .mockResolvedValue(distributedState);

      await expect(service.reconcileStatisticCacheCandidate()).resolves.toEqual(
        expect.objectContaining({ outcome: 'superseded' }),
      );
    });

    it('classifies an incomplete snapshot as a retry', async () => {
      const artifactService = {
        loadActiveIdentity: jest.fn().mockResolvedValue(null),
        stageCandidate: jest
          .fn()
          .mockRejectedValue(
            new Error('Statistic snapshots are not certified'),
          ),
      };
      (service as any).statisticCacheArtifactService = artifactService;
      jest
        .spyOn(service as any, 'getPublicationState')
        .mockResolvedValue(distributedState);

      await expect(service.reconcileStatisticCacheCandidate()).resolves.toEqual(
        expect.objectContaining({ outcome: 'retry' }),
      );
    });

    it('acknowledges the complete candidate identity only after preload', () => {
      const candidateId = '00000000-0000-4000-8000-000000000101';
      service['publicationState'] = {
        ...distributedState,
        statisticCacheCandidatePublicationId: candidateId,
      };
      service['candidateDataCache'] = {
        ...service['certifiedDataCache'],
        artifactPublicationId: candidateId,
        artifactProtocolVersion: 1,
        artifactSourceRevision: '42',
        revision: '100',
        latestDate: '2026-08-19',
        fingerprint: 'a'.repeat(64),
      } as any;

      expect(service.getStatisticCacheAcknowledgement()).toEqual(
        expect.objectContaining({
          candidateStatisticCachePublicationId: candidateId,
          candidateStatisticRevision: '100',
          candidateStatisticPublishedDate: '2026-08-19',
          candidateStatisticSourceRevision: '42',
          candidateStatisticFingerprint: 'a'.repeat(64),
          candidateStatisticProtocolVersion: 1,
          candidateStatisticLastError: null,
        }),
      );
    });

    it('acknowledges a failed candidate preload without claiming readiness', () => {
      const candidateId = '00000000-0000-4000-8000-000000000102';
      service['publicationState'] = {
        ...distributedState,
        statisticCacheCandidatePublicationId: candidateId,
      };
      service['candidateDataCache'] = null;
      service['failedCandidatePublicationId'] = candidateId;
      service['failedCandidatePhase'] = 'candidate-preload';

      expect(service.getStatisticCacheAcknowledgement()).toEqual(
        expect.objectContaining({
          candidateStatisticCachePublicationId: candidateId,
          candidateStatisticRevision: null,
          candidateStatisticPublishedDate: null,
          candidateStatisticSourceRevision: null,
          candidateStatisticFingerprint: null,
          candidateStatisticProtocolVersion: null,
          candidateStatisticLastError: 'candidate-preload',
        }),
      );
    });
  });

  it('uses publicRevision as the statistic source identity when enabled', async () => {
    process.env.PUBLIC_SOURCE_REVISION_ENABLED = 'true';
    service['publicationStateCheckedAt'] = 0;
    mockDataSource.query.mockResolvedValue([
      {
        ...stablePublicationState,
        revision: '100',
        sourceRevision: '42',
      },
    ]);

    const state = await (service as any).getPublicationState();

    expect(state).toEqual(
      expect.objectContaining({ revision: '100', sourceRevision: '42' }),
    );
    expect(mockDataSource.query.mock.calls[0][0]).toContain(
      'source_state."publicRevision"::text AS "sourceRevision"',
    );
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
      (service as any).beginDate = '2023-07-11';
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

    it('rejects a pre-release legacy candidate with a missing civil date', () => {
      process.env.STATISTIC_CACHE_MODE = 'legacy-bootstrap';
      (service as any).beginDate = '2015-05-18';
      service['certifiedDataCache'] = null;
      const referenceData = prepareCandidate(['2015-05-18', '2015-05-20']);

      expect(() =>
        (service as any).createCertifiedDataCandidate(
          referenceData,
          {
            ...stablePublicationState,
            activePublicationId: null,
            currentPublishedDate: '2015-05-20',
          },
          { coverageByDate: new Map() },
          1,
        ),
      ).toThrow(
        'Legacy statistic coverage is missing candidate date 2015-05-19',
      );
    });

    it('does not require raw department coverage before the release date', () => {
      process.env.STATISTIC_CACHE_MODE = 'legacy-bootstrap';
      (service as any).beginDate = '2015-05-18';
      service['certifiedDataCache'] = null;
      const referenceData = prepareCandidate([
        '2015-05-18',
        '2015-05-19',
        '2015-05-20',
      ]);

      expect(
        (service as any).createCertifiedDataCandidate(
          referenceData,
          {
            ...stablePublicationState,
            activePublicationId: null,
            currentPublishedDate: '2015-05-20',
          },
          { coverageByDate: new Map() },
          1,
        ),
      ).toEqual(
        expect.objectContaining({
          firstDate: '2015-05-18',
          latestDate: '2015-05-20',
          dateCount: 3,
        }),
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

    it('rejects a cold cache candidate while the bootstrap sentinel exists outside the date range', async () => {
      mockTransactionManager.query.mockResolvedValue([
        {
          snapshotDate: '1970-01-01',
          scope: 'bootstrap',
          status: 'failed',
          expectedCommuneCount: 0,
          processedCommuneCount: 0,
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
      ).rejects.toThrow('Statistic bootstrap barrier 1970-01-01 is active');
      expect(mockTransactionManager.query.mock.calls[0][0]).toContain(
        `"scope" = 'bootstrap'`,
      );
      expect(mockTransactionManager.query.mock.calls[0][1]).toEqual([
        '2023-07-11',
        '2026-08-11',
      ]);
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
      expect(mockTransactionManager.query.mock.calls[0][1]).toEqual([
        '2013-01-01',
        '2026-08-11',
      ]);
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
