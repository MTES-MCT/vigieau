import { HttpException, HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ArreteMunicipal } from '@shared/entities/arrete_municipal.entity';
import { Config } from '@shared/entities/config.entity';
import { ZoneAlerteComputed } from '@shared/entities/zone_alerte_computed.entity';
import { ZonePublication } from '@shared/entities/zone_publication.entity';
import { ZonePublicationZone } from '@shared/entities/zone_publication_zone.entity';
import { ZonePublicationCommune } from '@shared/entities/zone_publication_commune.entity';
import { ZonePublicationState } from '@shared/entities/zone_publication_state.entity';
import { ZonePublicationInstance } from '@shared/entities/zone_publication_instance.entity';
import { CommunesService } from '../communes/communes.service';
import { DataService } from '../data/data.service';
import { DepartementsService } from '../departements/departements.service';
import { StatisticsService } from '../statistics/statistics.service';
import {
  buildZonePublicationAggregate,
  computeZonePublicationFingerprint,
} from '@shared/zone_publication_materialization';
import { ZonesService } from './zones.service';

const mockFlatbushConstructor = jest.fn();

jest.mock('@shared/entities/arrete_municipal.entity', () => ({
  ArreteMunicipal: class ArreteMunicipal {},
}));
jest.mock('@shared/entities/config.entity', () => ({
  Config: class Config {},
}));
jest.mock('@shared/entities/commune.entity', () => ({
  Commune: class Commune {},
}));
jest.mock('@shared/entities/zone_alerte_computed.entity', () => ({
  ZoneAlerteComputed: class ZoneAlerteComputed {},
}));
jest.mock('@shared/entities/zone_publication.entity', () => ({
  ZonePublication: class ZonePublication {},
}));
jest.mock('@shared/entities/zone_publication_zone.entity', () => ({
  ZonePublicationZone: class ZonePublicationZone {},
}));
jest.mock('@shared/entities/zone_publication_commune.entity', () => ({
  ZonePublicationCommune: class ZonePublicationCommune {},
}));
jest.mock('@shared/entities/zone_publication_state.entity', () => ({
  ZonePublicationState: class ZonePublicationState {},
}));
jest.mock('@shared/entities/zone_publication_instance.entity', () => ({
  ZonePublicationInstance: class ZonePublicationInstance {},
}));
jest.mock('../communes/communes.service', () => ({
  CommunesService: class CommunesService {},
}));
jest.mock('../data/data.service', () => ({
  DataService: class DataService {},
}));
jest.mock('../departements/departements.service', () => ({
  DepartementsService: class DepartementsService {},
}));
jest.mock('../statistics/statistics.service', () => ({
  StatisticsService: class StatisticsService {},
}));
jest.mock('flatbush', () => ({
  __esModule: true,
  default: class Flatbush {
    private readonly indexes: number[] = [];

    constructor(size: number) {
      mockFlatbushConstructor(size);
    }

    add() {
      this.indexes.push(this.indexes.length);
    }

    finish() {}

    search() {
      return this.indexes;
    }
  },
}));

describe('ZonesService', () => {
  let service: ZonesService;
  let configRepository: Repository<Config>;

  const queryBuilder = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    getRawMany: jest.fn(),
  };
  const arreteQueryBuilder = {
    where: jest.fn().mockReturnThis(),
    getCount: jest.fn(),
  };
  const mockZoneAlerteComputedRepository = {
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(() => queryBuilder),
  };
  const mockArreteMunicipalRepository = {
    createQueryBuilder: jest.fn(() => arreteQueryBuilder),
    query: jest.fn(),
  };
  const mockConfigRepository = { findOne: jest.fn() };
  const mockZonePublicationRepository = {
    findOne: jest.fn(),
    query: jest.fn(),
  };
  const mockZonePublicationStateRepository = { findOne: jest.fn() };
  const mockZonePublicationInstanceRepository = {
    upsert: jest.fn(),
    query: jest.fn(),
  };
  const mockDepartementsService = {
    loadSituation: jest.fn(),
    buildSituationSnapshot: jest.fn(),
    publishSituation: jest.fn(),
  };
  const mockStatisticsService = { loadStatistics: jest.fn() };
  const mockDataService = {
    loadData: jest.fn(),
    getStatisticCacheAcknowledgement: jest.fn(() => ({
      statisticCachePublicationId: null,
      statisticRevision: null,
      statisticPublishedDate: null,
      statisticFingerprint: null,
      statisticLastError: 'statistic-artifact-unavailable',
    })),
  };
  const mockCommunesService = {
    normalizeCodeCommune: jest.fn((code) => code),
    findArretesMunicipaux: jest.fn(),
  };

  const version = new Date('2026-07-31T12:00:00.000Z');
  const flushPromises = () =>
    new Promise<void>((resolve) => setImmediate(resolve));
  const polygon = {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 4],
          [0, 0],
        ],
      ],
    },
  };

  const makeZone = (id: number, type = 'SUP') => ({
    id,
    idSandre: id + 100,
    code: `ZONE_${id}`,
    nom: `Zone ${id}`,
    type,
    ressourceInfluencee: false,
    niveauGravite: 'alerte',
    departement: '65',
    arrete: {},
    usages: [],
  });

  const makePublicationRow = (
    publicationId: string,
    status: 'active' | 'candidate' | 'retired' = 'active',
    zoneId = 1,
  ) => ({
    publicationId,
    revision: '42',
    status,
    sourceComputedAt: version,
    zoneCount: 1,
    communeLinkCount: 1,
    geojsonUrl: `https://example.test/${publicationId}.geojson`,
    geojsonChecksum: 'b'.repeat(64),
    pmtilesUrl: `https://example.test/${publicationId}.pmtiles`,
    pmtilesChecksum: 'a'.repeat(64),
    activatedAt: status === 'candidate' ? null : version,
    publicationZoneId: String(zoneId),
    sourceZoneId: zoneId,
    departmentCode: '65',
    publicPayload: makeZone(zoneId),
    geom: JSON.stringify(polygon),
    communeCodes: ['65440'],
  });

  const makeEmptyPublicationRow = (
    publicationId: string,
    counts: { zoneCount: number; communeLinkCount: number } = {
      zoneCount: 0,
      communeLinkCount: 0,
    },
  ) => ({
    ...makePublicationRow(publicationId),
    ...counts,
    publicationZoneId: null,
    sourceZoneId: null,
    departmentCode: null,
    publicPayload: null,
    geom: null,
    communeCodes: [],
  });

  const makeSnapshot = (id: number, snapshotVersion = version) => {
    const zone = makeZone(id);
    const feature = {
      geometry: JSON.stringify(polygon),
      zoneId: id,
    };
    return Object.freeze({
      zones: Object.freeze([zone]),
      features: Object.freeze([feature]),
      zonesIndex: Object.freeze({ [id]: zone }),
      zonesCommunesIndex: Object.freeze({
        '65440': Object.freeze([zone]),
      }),
      zoneTree: { search: jest.fn(() => [0]) },
      communeArretesMunicipaux: Object.freeze([]),
      version: snapshotVersion,
      loadedAt: new Date(),
      communeAssociationCount: 1,
      departmentSituation: Object.freeze([]),
      aggregate: Object.freeze({
        version: 1,
        zoneCount: 1,
        communeLinkCount: 1,
        restrictedZoneCount: 1,
        zoneCountByType: Object.freeze({ SUP: 1 }),
        departments: Object.freeze({}),
      }),
      publication: null,
    });
  };

  const makeVersionedSnapshot = (
    publicationId: string,
    id = 1,
    status: 'active' | 'candidate' | 'retired' = 'active',
  ) =>
    Object.freeze({
      ...makeSnapshot(id),
      publication: Object.freeze({
        id: publicationId,
        revision: '42',
        geojsonUrl: `https://example.test/${publicationId}.geojson`,
        geojsonChecksum: 'b'.repeat(64),
        pmtilesUrl: `https://example.test/${publicationId}.pmtiles`,
        pmtilesChecksum: 'a'.repeat(64),
        zoneCount: 1,
        contentFingerprint: null,
        sourceComputedAt: version,
        activatedAt: status === 'candidate' ? null : version,
        status,
      }),
    });

  const installSnapshot = (id = 1, snapshotVersion = version) => {
    const snapshot = makeSnapshot(id, snapshotVersion);
    service['activeSnapshot'] = snapshot as any;
    service['lastAvailableZoneComputationDate'] = snapshotVersion;
    service['lastSuccessfulZoneComputationCheckAt'] = new Date();
    service['lastZoneComputationCheckAt'] = Date.now();
    return snapshot;
  };

  const createStandaloneService = () =>
    new ZonesService(
      mockZoneAlerteComputedRepository as any,
      mockDepartementsService as any,
      mockStatisticsService as any,
      mockDataService as any,
      mockCommunesService as any,
      mockArreteMunicipalRepository as any,
      mockConfigRepository as any,
      mockZonePublicationRepository as any,
      {} as any,
      {} as any,
      mockZonePublicationStateRepository as any,
      mockZonePublicationInstanceRepository as any,
    );

  beforeEach(async () => {
    jest.clearAllMocks();
    queryBuilder.select.mockReturnThis();
    queryBuilder.addSelect.mockReturnThis();
    queryBuilder.getRawMany.mockResolvedValue([]);
    arreteQueryBuilder.where.mockReturnThis();
    arreteQueryBuilder.getCount.mockResolvedValue(0);
    mockConfigRepository.findOne.mockResolvedValue({
      computeZoneAlerteComputedDate: version,
    });
    mockZonePublicationStateRepository.findOne.mockResolvedValue({
      activePublicationId: null,
      candidatePublicationId: null,
    });
    mockZonePublicationRepository.findOne.mockResolvedValue(null);
    mockZonePublicationRepository.query.mockResolvedValue([]);
    mockZonePublicationInstanceRepository.upsert.mockResolvedValue(undefined);
    mockZonePublicationInstanceRepository.query.mockResolvedValue([
      { live: 1, activeReady: 0, candidateReady: 0 },
    ]);
    mockDepartementsService.loadSituation.mockResolvedValue(undefined);
    mockDepartementsService.buildSituationSnapshot.mockImplementation(
      async (zones) => zones,
    );
    mockDepartementsService.publishSituation.mockReturnValue(undefined);
    mockStatisticsService.loadStatistics.mockResolvedValue(undefined);
    mockDataService.loadData.mockResolvedValue(undefined);
    mockCommunesService.findArretesMunicipaux.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ZonesService,
        {
          provide: getRepositoryToken(ZoneAlerteComputed),
          useValue: mockZoneAlerteComputedRepository,
        },
        {
          provide: getRepositoryToken(ArreteMunicipal),
          useValue: mockArreteMunicipalRepository,
        },
        {
          provide: getRepositoryToken(Config),
          useValue: mockConfigRepository,
        },
        {
          provide: getRepositoryToken(ZonePublication),
          useValue: mockZonePublicationRepository,
        },
        {
          provide: getRepositoryToken(ZonePublicationZone),
          useValue: {},
        },
        {
          provide: getRepositoryToken(ZonePublicationCommune),
          useValue: {},
        },
        {
          provide: getRepositoryToken(ZonePublicationState),
          useValue: mockZonePublicationStateRepository,
        },
        {
          provide: getRepositoryToken(ZonePublicationInstance),
          useValue: mockZonePublicationInstanceRepository,
        },
        { provide: DepartementsService, useValue: mockDepartementsService },
        { provide: StatisticsService, useValue: mockStatisticsService },
        { provide: DataService, useValue: mockDataService },
        { provide: CommunesService, useValue: mockCommunesService },
      ],
    }).compile();

    service = module.get(ZonesService);
    configRepository = module.get(getRepositoryToken(Config));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('waits for the initial zone snapshot before module startup completes', async () => {
    let finishLoad!: () => void;
    jest.spyOn(service, 'loadAllZones').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishLoad = () => {
            service['activeSnapshot'] = makeSnapshot(1) as any;
            resolve();
          };
        }),
    );

    let initialized = false;
    const initialization = service.onModuleInit().then(() => {
      initialized = true;
    });
    await flushPromises();

    expect(service.loadAllZones).toHaveBeenCalledWith(true);
    expect(initialized).toBe(false);

    finishLoad();
    await initialization;

    expect(initialized).toBe(true);
  });

  it('fails startup when no initial zone snapshot can be loaded', async () => {
    jest.spyOn(service, 'loadAllZones').mockResolvedValue(undefined);

    await expect(service.onModuleInit()).rejects.toThrow(
      'Initial zone cache could not be loaded',
    );
  });

  describe('zone data availability', () => {
    it('reports an AEP zone as available', async () => {
      const snapshot = makeSnapshot(1) as any;
      const aepZone = makeZone(2, 'AEP');
      service['activeSnapshot'] = Object.freeze({
        ...snapshot,
        zones: Object.freeze([aepZone]),
        zonesCommunesIndex: Object.freeze({
          '79002': Object.freeze([aepZone]),
        }),
      }) as any;
      mockZonePublicationRepository.query.mockResolvedValue([
        {
          sourcePublicRevision: '44',
          zoneType: null,
          status: null,
          asOf: null,
          availabilityPublicRevision: null,
          officialUrl: null,
        },
      ]);

      const result = await service.findWithAvailability(
        undefined,
        undefined,
        '79002',
      );

      expect(result.zones).toMatchObject([{ id: 2, type: 'AEP' }]);
      expect(result.availability.AEP).toMatchObject({
        status: 'available',
        officialUrl: expect.stringContaining('deux-sevres.gouv.fr'),
      });
    });

    it('hides a stale AEP zone while the current public revision is unavailable', async () => {
      const snapshot = makeSnapshot(1) as any;
      const aepZone = makeZone(2, 'AEP');
      service['activeSnapshot'] = Object.freeze({
        ...snapshot,
        zones: Object.freeze([aepZone]),
        zonesCommunesIndex: Object.freeze({
          '49007': Object.freeze([aepZone]),
        }),
      }) as any;
      mockZonePublicationRepository.query.mockResolvedValue([
        {
          sourcePublicRevision: '45',
          zoneType: 'AEP',
          status: 'unavailable',
          asOf: '2026-08-19T10:00:00.000Z',
          availabilityPublicRevision: '45',
          officialUrl: null,
        },
      ]);

      const result = await service.findWithAvailability(
        undefined,
        undefined,
        '49007',
      );

      expect(result.zones).toEqual([]);
      expect(result.availability.AEP).toMatchObject({
        status: 'unavailable',
        sourceRevision: '45',
      });
    });

    it('serves an AEP zone again after exact availability certification', async () => {
      const snapshot = makeSnapshot(1) as any;
      const aepZone = makeZone(2, 'AEP');
      service['activeSnapshot'] = Object.freeze({
        ...snapshot,
        zones: Object.freeze([aepZone]),
        zonesCommunesIndex: Object.freeze({
          '49007': Object.freeze([aepZone]),
        }),
      }) as any;
      mockZonePublicationRepository.query.mockResolvedValue([
        {
          sourcePublicRevision: '45',
          zoneType: 'AEP',
          status: 'available',
          asOf: '2026-08-19T10:10:00.000Z',
          availabilityPublicRevision: '45',
          officialUrl: null,
        },
      ]);

      const result = await service.findWithAvailability(
        undefined,
        undefined,
        '49007',
      );

      expect(result.zones).toMatchObject([{ id: 2, type: 'AEP' }]);
      expect(result.availability.AEP.status).toBe('available');
    });

    it('reports confirmed none locally when applicable AEP data has no zone for the commune', async () => {
      const snapshot = makeSnapshot(1) as any;
      const aepZone = { ...makeZone(2, 'AEP'), departement: '77' };
      service['activeSnapshot'] = Object.freeze({
        ...snapshot,
        zones: Object.freeze([aepZone]),
        zonesCommunesIndex: Object.freeze({
          '77168': Object.freeze([aepZone]),
        }),
      }) as any;
      mockZonePublicationRepository.query.mockResolvedValue([
        {
          sourcePublicRevision: '45',
          zoneType: 'AEP',
          status: 'available',
          asOf: '2026-08-19T10:10:00.000Z',
          availabilityPublicRevision: '45',
          officialUrl: null,
        },
      ]);

      const result = await service.findWithAvailability(
        undefined,
        undefined,
        '77010',
        undefined,
        'AEP',
      );

      expect(result.zones).toEqual([]);
      expect(result.availability.AEP).toEqual({
        status: 'confirmed_none',
        asOf: '2026-08-19T10:10:00.000Z',
        sourceRevision: '45',
        officialUrl: null,
      });
    });

    it('keeps an applicable AEP zone available for a covered commune', async () => {
      const snapshot = makeSnapshot(1) as any;
      const aepZone = { ...makeZone(2, 'AEP'), departement: '77' };
      service['activeSnapshot'] = Object.freeze({
        ...snapshot,
        zones: Object.freeze([aepZone]),
        zonesCommunesIndex: Object.freeze({
          '77168': Object.freeze([aepZone]),
        }),
      }) as any;
      mockZonePublicationRepository.query.mockResolvedValue([
        {
          sourcePublicRevision: '45',
          zoneType: 'AEP',
          status: 'available',
          asOf: '2026-08-19T10:10:00.000Z',
          availabilityPublicRevision: '45',
          officialUrl: null,
        },
      ]);

      const result = await service.findWithAvailability(
        undefined,
        undefined,
        '77168',
        undefined,
        'AEP',
      );

      expect(result.zones).toMatchObject([{ id: 2, type: 'AEP' }]);
      expect(result.availability.AEP.status).toBe('available');
    });

    it('keeps a commune without an AEP zone unavailable when no certification exists', async () => {
      const snapshot = makeSnapshot(1) as any;
      const aepZone = { ...makeZone(2, 'AEP'), departement: '77' };
      service['activeSnapshot'] = Object.freeze({
        ...snapshot,
        zones: Object.freeze([aepZone]),
        zonesCommunesIndex: Object.freeze({
          '77168': Object.freeze([aepZone]),
        }),
      }) as any;
      mockZonePublicationRepository.query.mockResolvedValue([
        {
          sourcePublicRevision: '45',
          zoneType: null,
          status: null,
          asOf: null,
          availabilityPublicRevision: null,
          officialUrl: null,
        },
      ]);

      const result = await service.findWithAvailability(
        undefined,
        undefined,
        '77010',
        undefined,
        'AEP',
      );

      expect(result.zones).toEqual([]);
      expect(result.availability.AEP).toMatchObject({
        status: 'unavailable',
        sourceRevision: '45',
      });
    });

    it('preserves a municipal decree when certified AEP data has no local zone', async () => {
      service['activeSnapshot'] = Object.freeze({
        ...(makeSnapshot(1) as any),
        zones: Object.freeze([]),
        zonesCommunesIndex: Object.freeze({}),
        communeArretesMunicipaux: Object.freeze([
          {
            code: '77010',
            arretesMunicipaux: Object.freeze([
              { fichier: { url: 'https://example.test/municipal.pdf' } },
            ]),
          },
        ]),
      }) as any;
      mockZonePublicationRepository.query.mockResolvedValue([
        {
          sourcePublicRevision: '45',
          zoneType: 'AEP',
          status: 'available',
          asOf: '2026-08-19T10:10:00.000Z',
          availabilityPublicRevision: '45',
          officialUrl: null,
        },
      ]);

      const result = await service.findWithAvailability(
        undefined,
        undefined,
        '77010',
        undefined,
        'AEP',
      );

      expect(result.zones).toEqual([
        {
          id: null,
          type: 'AEP',
          arreteMunicipalCheminFichier: 'https://example.test/municipal.pdf',
        },
      ]);
      expect(result.availability.AEP.status).toBe('confirmed_none');
    });

    it('reports confirmed none for an applicable departmental certification', async () => {
      installSnapshot();
      mockZonePublicationRepository.query.mockResolvedValue([
        {
          sourcePublicRevision: '44',
          zoneType: 'AEP',
          status: 'confirmed_none',
          asOf: '2026-08-19T10:00:00.000Z',
          availabilityPublicRevision: '44',
          officialUrl: null,
        },
      ]);

      const result = await service.findWithAvailability(
        undefined,
        undefined,
        '49007',
        undefined,
        'AEP',
      );

      expect(result.zones).toEqual([]);
      expect(result.availability.AEP).toEqual({
        status: 'confirmed_none',
        asOf: '2026-08-19T10:00:00.000Z',
        sourceRevision: '44',
        officialUrl: expect.stringContaining('maine-et-loire.gouv.fr'),
      });
    });

    it('binds availability to the source revision of a pinned publication', async () => {
      const publicationId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
      mockZonePublicationRepository.query.mockResolvedValue([
        {
          sourcePublicRevision: '43',
          zoneType: 'AEP',
          status: 'confirmed_none',
          asOf: '2026-08-18T10:00:00.000Z',
          availabilityPublicRevision: '43',
          officialUrl: null,
        },
      ]);

      const context = await service['loadZoneTypeAvailability'](
        '49',
        publicationId,
      );

      expect(mockZonePublicationRepository.query).toHaveBeenCalledWith(
        expect.stringContaining('publication."sourceRevision"'),
        ['49', publicationId],
      );
      expect(context.sourcePublicRevision).toBe('43');
      expect(context.certifications.get('AEP')).toMatchObject({
        availabilityPublicRevision: '43',
      });
    });

    it('keeps an earlier certification when another department advances the global revision', async () => {
      installSnapshot();
      mockZonePublicationRepository.query.mockResolvedValue([
        {
          sourcePublicRevision: '45',
          zoneType: 'AEP',
          status: 'confirmed_none',
          asOf: '2026-08-18T10:00:00.000Z',
          availabilityPublicRevision: '44',
          officialUrl: null,
        },
      ]);

      const result = await service.findWithAvailability(
        undefined,
        undefined,
        '79002',
        undefined,
        'AEP',
      );

      expect(result.availability.AEP).toMatchObject({
        status: 'confirmed_none',
        sourceRevision: '45',
      });
    });

    it('fails closed when a certification is newer than a pinned publication', async () => {
      installSnapshot();
      mockZonePublicationRepository.query.mockResolvedValue([
        {
          sourcePublicRevision: '45',
          zoneType: 'AEP',
          status: 'confirmed_none',
          asOf: '2026-08-19T10:00:00.000Z',
          availabilityPublicRevision: '46',
          officialUrl: null,
        },
      ]);

      const result = await service.findWithAvailability(
        undefined,
        undefined,
        '79002',
        undefined,
        'AEP',
      );

      expect(result.availability.AEP).toMatchObject({
        status: 'unavailable',
        sourceRevision: '45',
      });
    });

    it('fails closed when availability storage cannot be read', async () => {
      const snapshot = makeSnapshot(1) as any;
      const aepZone = makeZone(2, 'AEP');
      service['activeSnapshot'] = Object.freeze({
        ...snapshot,
        zones: Object.freeze([aepZone]),
        zonesCommunesIndex: Object.freeze({
          '79002': Object.freeze([aepZone]),
        }),
      }) as any;
      mockZonePublicationRepository.query.mockRejectedValue(
        new Error('relation missing'),
      );

      const result = await service.findWithAvailability(
        undefined,
        undefined,
        '79002',
        undefined,
        'AEP',
      );

      expect(result.zones).toEqual([]);
      expect(result.availability.AEP.status).toBe('unavailable');
    });
  });

  it('returns 503 on cold start and starts a background load', async () => {
    const loadSpy = jest
      .spyOn(service, 'loadAllZones')
      .mockResolvedValue(undefined);

    await expect(
      service.find(undefined, undefined, '65440'),
    ).rejects.toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE });
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps serving the previous snapshot when the version check fails', async () => {
    installSnapshot();
    service['lastZoneComputationCheckAt'] = 0;
    jest
      .spyOn(configRepository, 'findOne')
      .mockRejectedValueOnce(new Error('db'));

    await expect(
      service.find(undefined, undefined, '65440'),
    ).resolves.toMatchObject([{ id: 1 }]);

    const status = await service.getCacheStatus();
    expect(status.status).toBe('degraded');
    expect(status.lastError).toMatchObject({ phase: 'version-check' });
    expect(status.lastError).not.toHaveProperty('message');
  });

  it('joins an in-flight non-forced refresh and runs a queued forced check afterwards', async () => {
    const oldId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    const nextId = '5a7edfae-f4b8-43f1-9bef-4314d65c8d4c';
    service['activeSnapshot'] = makeVersionedSnapshot(oldId) as any;
    service['lastZoneComputationCheckAt'] = 0;
    let resolveNonForced!: (state: any) => void;
    let resolveForced!: (state: any) => void;
    mockZonePublicationStateRepository.findOne
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveNonForced = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveForced = resolve;
        }),
      )
      .mockResolvedValue({
        activePublicationId: nextId,
        candidatePublicationId: null,
      });
    mockZonePublicationRepository.query.mockResolvedValue([
      makePublicationRow(nextId, 'active', 2),
    ]);

    const nonForced = service['refreshZonesIfStale'](false);
    const joined = service['refreshZonesIfStale'](false);
    const forced = service['refreshZonesIfStale'](true);

    expect(joined).toBe(nonForced);
    expect(forced).toBe(nonForced);
    expect(mockZonePublicationStateRepository.findOne).toHaveBeenCalledTimes(1);

    resolveNonForced({
      activePublicationId: oldId,
      candidatePublicationId: null,
    });
    await flushPromises();

    expect(mockZonePublicationStateRepository.findOne).toHaveBeenCalledTimes(2);
    resolveForced({
      activePublicationId: nextId,
      candidatePublicationId: null,
    });
    await Promise.all([nonForced, joined, forced]);

    expect(service['activeSnapshot']?.publication?.id).toBe(nextId);
    expect(mockZonePublicationStateRepository.findOne).toHaveBeenCalledTimes(3);
    expect(mockZonePublicationRepository.query).toHaveBeenCalledTimes(1);
  });

  it('ignores an older publication-state read resolved after a newer one', async () => {
    const oldId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    const nextId = '5a7edfae-f4b8-43f1-9bef-4314d65c8d4c';
    let resolveOlder!: (state: any) => void;
    let resolveNewer!: (state: any) => void;
    mockZonePublicationStateRepository.findOne
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOlder = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveNewer = resolve;
        }),
      );

    const olderRead = service['getPublicationState']();
    const newerRead = service['getPublicationState']();
    resolveNewer({
      activePublicationId: nextId,
      candidatePublicationId: null,
    });
    await expect(newerRead).resolves.toMatchObject({
      activePublicationId: nextId,
    });

    resolveOlder({
      activePublicationId: oldId,
      candidatePublicationId: null,
    });

    await expect(olderRead).resolves.toMatchObject({
      activePublicationId: nextId,
    });
    expect(service['availablePublicationState']).toMatchObject({
      activePublicationId: nextId,
    });
  });

  it('rechecks the active pointer after a refresh snapshot is built', async () => {
    const initialId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    const staleId = '5a7edfae-f4b8-43f1-9bef-4314d65c8d4c';
    const latestId = '8b9289cb-93f5-4eed-b2f9-a8f88d0bb095';
    service['activeSnapshot'] = makeVersionedSnapshot(initialId) as any;
    mockZonePublicationStateRepository.findOne
      .mockResolvedValueOnce({
        activePublicationId: staleId,
        candidatePublicationId: null,
      })
      .mockResolvedValueOnce({
        activePublicationId: latestId,
        candidatePublicationId: null,
      })
      .mockResolvedValueOnce({
        activePublicationId: latestId,
        candidatePublicationId: null,
      });
    let resolveStaleSnapshot!: (rows: any[]) => void;
    let resolveLatestSnapshot!: (rows: any[]) => void;
    mockZonePublicationRepository.query.mockImplementation((_sql, params) => {
      if (params[0] === staleId) {
        return new Promise<any[]>((resolve) => {
          resolveStaleSnapshot = resolve;
        });
      }
      return new Promise<any[]>((resolve) => {
        resolveLatestSnapshot = resolve;
      });
    });

    const refresh = service['refreshZonesIfStale'](true);
    await flushPromises();
    expect(mockZonePublicationRepository.query).toHaveBeenCalledTimes(1);

    resolveStaleSnapshot([makePublicationRow(staleId, 'active', 2)]);
    await flushPromises();

    expect(mockZonePublicationRepository.query).toHaveBeenCalledTimes(2);
    expect(service['activeSnapshot']?.publication?.id).toBe(initialId);
    expect(mockDepartementsService.publishSituation).not.toHaveBeenCalled();

    resolveLatestSnapshot([makePublicationRow(latestId, 'active', 3)]);
    await refresh;

    expect(service['activeSnapshot']?.publication?.id).toBe(latestId);
    expect(mockZonePublicationStateRepository.findOne).toHaveBeenCalledTimes(3);
    expect(mockZonePublicationRepository.query).toHaveBeenCalledTimes(2);
    expect(mockDepartementsService.publishSituation).toHaveBeenCalledTimes(1);
    expect(mockDepartementsService.publishSituation).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 3 })]),
    );
  });

  it('rebuilds a preloaded candidate department situation before activating it', async () => {
    const previousId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    const activatedId = '5a7edfae-f4b8-43f1-9bef-4314d65c8d4c';
    const previousSnapshot = makeVersionedSnapshot(previousId);
    const preloadedCandidate = Object.freeze({
      ...makeVersionedSnapshot(activatedId, 2, 'candidate'),
      departmentSituation: Object.freeze([{ date: 'stale' }]),
    });
    const certifiedSituation = [
      {
        date: '2026-07-31',
        departementSituation: [{ code: '65', niveauGraviteMax: 'crise' }],
      },
    ];
    let resolveSituation!: (situation: any[]) => void;
    const situationBuild = new Promise<any[]>((resolve) => {
      resolveSituation = resolve;
    });
    service['activeSnapshot'] = previousSnapshot as any;
    service['publicationSnapshots'].set(activatedId, preloadedCandidate as any);
    service['lastZoneComputationCheckAt'] = 0;
    mockZonePublicationStateRepository.findOne.mockResolvedValue({
      activePublicationId: activatedId,
      candidatePublicationId: null,
    });
    mockZonePublicationRepository.findOne.mockResolvedValue({
      id: activatedId,
      status: 'active',
      activatedAt: version,
    });
    mockDepartementsService.buildSituationSnapshot.mockReturnValueOnce(
      situationBuild,
    );

    const refresh = service['refreshZonesIfStale'](true);
    await flushPromises();

    expect(service['activeSnapshot']).toBe(previousSnapshot);
    expect(service['publicationSnapshots'].get(activatedId)).toBe(
      preloadedCandidate,
    );
    expect(mockDepartementsService.publishSituation).not.toHaveBeenCalled();

    resolveSituation(certifiedSituation);
    await refresh;

    const activatedSnapshot = service['activeSnapshot'];
    expect(activatedSnapshot?.publication).toMatchObject({
      id: activatedId,
      status: 'active',
    });
    expect(activatedSnapshot?.departmentSituation).toEqual(certifiedSituation);
    expect(Object.isFrozen(activatedSnapshot)).toBe(true);
    expect(Object.isFrozen(activatedSnapshot?.departmentSituation)).toBe(true);
    expect(service['publicationSnapshots'].get(activatedId)).toBe(
      activatedSnapshot,
    );
    expect(mockDepartementsService.publishSituation).toHaveBeenCalledWith(
      certifiedSituation,
    );
  });

  it('revalidates a candidate preload still in flight before activating it', async () => {
    const previousId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    const activatedId = '5a7edfae-f4b8-43f1-9bef-4314d65c8d4c';
    const previousSnapshot = makeVersionedSnapshot(previousId);
    const inFlightCandidate = Object.freeze({
      ...makeVersionedSnapshot(activatedId, 2, 'candidate'),
      departmentSituation: Object.freeze([{ date: 'stale' }]),
    });
    const certifiedSituation = [
      {
        date: '2026-07-31',
        departementSituation: [{ code: '65', niveauGraviteMax: 'crise' }],
      },
    ];
    let resolvePreload!: (snapshot: any) => void;
    const preload = new Promise<any>((resolve) => {
      resolvePreload = resolve;
    });
    service['activeSnapshot'] = previousSnapshot as any;
    service['publicationLoadPromises'].set(activatedId, preload);
    service['lastZoneComputationCheckAt'] = 0;
    mockZonePublicationStateRepository.findOne.mockResolvedValue({
      activePublicationId: activatedId,
      candidatePublicationId: null,
    });
    mockZonePublicationRepository.findOne.mockResolvedValue({
      id: activatedId,
      status: 'active',
      activatedAt: version,
    });
    mockDepartementsService.buildSituationSnapshot.mockResolvedValueOnce(
      certifiedSituation,
    );

    const refresh = service['refreshZonesIfStale'](true);
    await flushPromises();
    expect(service['activeSnapshot']).toBe(previousSnapshot);

    resolvePreload(inFlightCandidate);
    await refresh;

    expect(service['activeSnapshot']?.publication).toMatchObject({
      id: activatedId,
      status: 'active',
    });
    expect(service['activeSnapshot']?.departmentSituation).toEqual(
      certifiedSituation,
    );
    expect(service['publicationSnapshots'].get(activatedId)).toBe(
      service['activeSnapshot'],
    );
  });

  it('retains the active snapshot when certified department rebuilding fails', async () => {
    const previousId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    const activatedId = '5a7edfae-f4b8-43f1-9bef-4314d65c8d4c';
    const previousSnapshot = makeVersionedSnapshot(previousId);
    const preloadedCandidate = makeVersionedSnapshot(
      activatedId,
      2,
      'candidate',
    );
    service['activeSnapshot'] = previousSnapshot as any;
    service['publicationSnapshots'].set(activatedId, preloadedCandidate as any);
    service['lastZoneComputationCheckAt'] = 0;
    mockZonePublicationStateRepository.findOne.mockResolvedValue({
      activePublicationId: activatedId,
      candidatePublicationId: null,
    });
    mockZonePublicationRepository.findOne.mockResolvedValue({
      id: activatedId,
      status: 'active',
      activatedAt: version,
    });
    mockDepartementsService.buildSituationSnapshot.mockRejectedValueOnce(
      new Error('statistics unavailable'),
    );

    await service['refreshZonesIfStale'](true);

    expect(service['activeSnapshot']).toBe(previousSnapshot);
    expect(service['publicationSnapshots'].get(activatedId)).toBe(
      preloadedCandidate,
    );
    expect(mockDepartementsService.publishSituation).not.toHaveBeenCalled();
    expect(service['lastCacheError']).toMatchObject({
      phase: 'version-check',
    });
  });

  it('rechecks the active pointer before publishing an initial snapshot', async () => {
    const staleId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    const latestId = '5a7edfae-f4b8-43f1-9bef-4314d65c8d4c';
    mockZonePublicationStateRepository.findOne
      .mockResolvedValueOnce({
        activePublicationId: staleId,
        candidatePublicationId: null,
      })
      .mockResolvedValueOnce({
        activePublicationId: latestId,
        candidatePublicationId: null,
      })
      .mockResolvedValueOnce({
        activePublicationId: latestId,
        candidatePublicationId: null,
      });
    let resolveStaleSnapshot!: (rows: any[]) => void;
    let resolveLatestSnapshot!: (rows: any[]) => void;
    mockZonePublicationRepository.query.mockImplementation((_sql, params) => {
      if (params[0] === staleId) {
        return new Promise<any[]>((resolve) => {
          resolveStaleSnapshot = resolve;
        });
      }
      return new Promise<any[]>((resolve) => {
        resolveLatestSnapshot = resolve;
      });
    });

    const loading = service.loadAllZones();
    await flushPromises();
    expect(mockZonePublicationRepository.query).toHaveBeenCalledTimes(1);

    resolveStaleSnapshot([makePublicationRow(staleId, 'active', 1)]);
    await flushPromises();

    expect(mockZonePublicationRepository.query).toHaveBeenCalledTimes(2);
    expect(service['activeSnapshot']).toBeNull();
    expect(mockDepartementsService.publishSituation).not.toHaveBeenCalled();

    resolveLatestSnapshot([makePublicationRow(latestId, 'active', 2)]);
    await loading;

    expect(service['activeSnapshot']?.publication?.id).toBe(latestId);
    expect(mockZonePublicationStateRepository.findOne).toHaveBeenCalledTimes(3);
    expect(mockZonePublicationRepository.query).toHaveBeenCalledTimes(2);
    expect(mockDepartementsService.publishSituation).toHaveBeenCalledTimes(1);
    expect(mockDepartementsService.publishSituation).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 2 })]),
    );
  });

  it('reloads before lookup when a newer computation is available', async () => {
    installSnapshot(1, new Date('2026-07-31T10:00:00.000Z'));
    service['lastZoneComputationCheckAt'] = 0;
    jest.spyOn(configRepository, 'findOne').mockResolvedValueOnce({
      computeZoneAlerteComputedDate: version,
    } as Config);
    const nextSnapshot = makeSnapshot(2);
    jest
      .spyOn(service as any, 'buildCacheSnapshot')
      .mockResolvedValueOnce(nextSnapshot);

    const result = await service.find(undefined, undefined, '65440');

    expect(result).toMatchObject([{ id: 2 }]);
  });

  it('preloads the first candidate before the legacy computation changes', async () => {
    const candidateId = '5a7edfae-f4b8-43f1-9bef-4314d65c8d4c';
    installSnapshot();
    service['lastZoneComputationCheckAt'] = 0;
    mockZonePublicationStateRepository.findOne.mockResolvedValue({
      activePublicationId: null,
      candidatePublicationId: candidateId,
    });
    mockZonePublicationRepository.query.mockResolvedValue([
      makePublicationRow(candidateId, 'candidate', 2),
    ]);

    await service['refreshZonesIfStale'](true);
    await flushPromises();

    expect(service['publicationSnapshots'].has(candidateId)).toBe(true);
    expect(mockZonePublicationInstanceRepository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        activePublicationId: null,
        candidatePublicationId: candidateId,
        zoneCount: 1,
        communeLinkCount: 1,
      }),
      ['instanceId'],
    );
    expect(service['activeSnapshot']?.publication).toBeNull();
  });

  it('keeps a first-candidate preload failure visible', async () => {
    const candidateId = '5a7edfae-f4b8-43f1-9bef-4314d65c8d4c';
    installSnapshot();
    service['lastZoneComputationCheckAt'] = 0;
    mockZonePublicationStateRepository.findOne.mockResolvedValue({
      activePublicationId: null,
      candidatePublicationId: candidateId,
    });
    mockZonePublicationRepository.query.mockRejectedValue(
      new Error('candidate read failed'),
    );

    await service['refreshZonesIfStale'](true);
    await flushPromises();
    await flushPromises();

    expect(service['lastCacheError']).toMatchObject({
      phase: 'candidate-preload',
    });
    expect(
      mockZonePublicationInstanceRepository.upsert,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        candidatePublicationId: null,
        lastError: 'candidate-preload',
      }),
      ['instanceId'],
    );
    expect(service['activeSnapshot']?.publication).toBeNull();
  });

  it('builds all lookup indexes locally before publishing them', async () => {
    queryBuilder.getRawMany.mockResolvedValueOnce([
      {
        id: 1,
        idSandre: 101,
        code: 'ZONE_1',
        nom: 'Zone 1',
        type: 'SUP',
        ressourceInfluencee: false,
        niveauGravite: 'alerte',
        geom: JSON.stringify(polygon),
      },
    ]);
    mockZoneAlerteComputedRepository.findOne.mockImplementation((options) => {
      if (options.relations.includes('communes')) {
        return Promise.resolve({ communes: [{ code: '65440' }] });
      }
      return Promise.resolve({
        restriction: {
          usages: [],
          arreteRestriction: { departement: { code: '65' } },
        },
      });
    });

    await service.loadAllZones();

    expect(service.searchZonesByCommune('65440')).toMatchObject([{ id: 1 }]);
    expect(service.searchZonesByLonLat({ lon: 1, lat: 1 })).toMatchObject([
      { id: 1 },
    ]);
    expect(mockFlatbushConstructor).toHaveBeenCalledWith(1);
    expect(Object.isFrozen(service['activeSnapshot'])).toBe(true);
    expect(Object.isFrozen(service['activeSnapshot']?.zones)).toBe(true);
  });

  it('publishes an atomic empty legacy snapshot and serves empty lookups', async () => {
    await service.loadAllZones();

    expect(service['activeSnapshot']).toMatchObject({
      zones: [],
      features: [],
      zonesIndex: {},
      zonesCommunesIndex: {},
      communeAssociationCount: 0,
      publication: null,
    });
    expect(Object.isFrozen(service['activeSnapshot'])).toBe(true);
    expect(service['activeSnapshot']?.zoneTree.search(1, 1, 1, 1)).toEqual([]);
    expect(mockFlatbushConstructor).not.toHaveBeenCalled();
    await expect(service.find('1', '1')).resolves.toEqual([]);
    await expect(service.find(undefined, undefined, '65440')).resolves.toEqual(
      [],
    );
    await expect(service.getCacheStatus(true)).resolves.toMatchObject({
      status: 'ready',
      usable: true,
      fresh: true,
      counts: {
        zones: 0,
        features: 0,
        communes: 0,
        communeAssociations: 0,
      },
    });
  });

  it('deduplicates concurrent cache loads', async () => {
    let resolveBuild: (snapshot: any) => void;
    const build = new Promise((resolve) => {
      resolveBuild = resolve;
    });
    const buildSpy = jest
      .spyOn(service as any, 'buildCacheSnapshot')
      .mockReturnValue(build);

    const first = service.loadAllZones();
    const second = service.loadAllZones();
    await flushPromises();

    expect(buildSpy).toHaveBeenCalledTimes(1);
    resolveBuild!(makeSnapshot(1));
    await Promise.all([first, second]);
  });

  it('publishes a completed snapshot with one atomic reference swap', async () => {
    const previous = installSnapshot(1);
    let resolveBuild: (snapshot: any) => void;
    const build = new Promise((resolve) => {
      resolveBuild = resolve;
    });
    jest.spyOn(service as any, 'buildCacheSnapshot').mockReturnValue(build);

    const loading = service.loadAllZones();
    await flushPromises();

    expect(service['activeSnapshot']).toBe(previous);
    expect(service.searchZonesByCommune('65440')).toMatchObject([{ id: 1 }]);

    const next = makeSnapshot(2);
    resolveBuild!(next);
    await loading;

    expect(service['activeSnapshot']).toBe(next);
    expect(service.searchZonesByCommune('65440')).toMatchObject([{ id: 2 }]);
  });

  it('retains the previous snapshot if building the next one fails', async () => {
    const previous = installSnapshot();
    jest
      .spyOn(service as any, 'buildCacheSnapshot')
      .mockRejectedValueOnce(new Error('invalid geometry'));

    await service.loadAllZones();

    expect(service['activeSnapshot']).toBe(previous);
    expect((await service.getCacheStatus()).lastError).toMatchObject({
      phase: 'load',
    });
    await expect(
      service.find(undefined, undefined, '65440'),
    ).resolves.toHaveLength(1);
  });

  it('retries the initial load from the scheduled refresh', async () => {
    const loadSpy = jest
      .spyOn(service, 'loadAllZones')
      .mockResolvedValue(undefined);

    await service.updateZones();

    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it('reports ready only when the loaded version matches a recent DB check', async () => {
    installSnapshot();

    await expect(service.getCacheStatus(true)).resolves.toMatchObject({
      status: 'ready',
      usable: true,
      fresh: true,
      loadedVersion: version.toISOString(),
      availableVersion: version.toISOString(),
      counts: { zones: 1, communes: 1, communeAssociations: 1 },
    });

    jest.spyOn(configRepository, 'findOne').mockResolvedValueOnce({
      computeZoneAlerteComputedDate: new Date('2026-07-31T13:00:00.000Z'),
    } as Config);
    await expect(service.getCacheStatus(true)).resolves.toMatchObject({
      status: 'degraded',
      usable: true,
      fresh: false,
    });
  });

  it('keeps the existing validation and ambiguity status codes', async () => {
    installSnapshot();
    await expect(service.find('181', '43')).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });

    const first = makeZone(1, 'SUP');
    const second = makeZone(2, 'SUP');
    service['activeSnapshot'] = {
      ...makeSnapshot(1),
      zonesCommunesIndex: { '65440': [first, second] },
    } as any;
    expect(() => service.searchZonesByCommune('65440')).toThrow(HttpException);
    try {
      service.searchZonesByCommune('65440');
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(HttpStatus.CONFLICT);
    }
  });

  it('returns 404 after confirming the active state is truly legacy and 410 for a pinned publication', async () => {
    installSnapshot();

    await expect(service.getPublication()).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
    });
    expect(mockZonePublicationStateRepository.findOne).toHaveBeenCalled();
    await expect(
      service.find(
        undefined,
        undefined,
        '65440',
        undefined,
        undefined,
        '37fec02d-4d5f-45ae-8f8c-9cae2b725f80',
      ),
    ).rejects.toMatchObject({ status: HttpStatus.GONE });
  });

  it('rejects an invalid publication id before querying PostgreSQL', async () => {
    installSnapshot();

    await expect(service.findOne(1, 'not-a-uuid')).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
    await expect(
      service.findByDepartement('65', 'not-a-uuid'),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    expect(mockZonePublicationRepository.findOne).not.toHaveBeenCalled();
    expect(mockZonePublicationRepository.query).not.toHaveBeenCalled();
  });

  it('loads the active versioned publication and exposes its manifest', async () => {
    const publicationId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    mockZonePublicationStateRepository.findOne.mockResolvedValue({
      activePublicationId: publicationId,
      candidatePublicationId: null,
    });
    mockZonePublicationRepository.query.mockResolvedValue([
      makePublicationRow(publicationId),
    ]);

    await service.loadAllZones();

    await expect(service.getPublication()).resolves.toEqual({
      id: publicationId,
      revision: '42',
      geojsonUrl: `https://example.test/${publicationId}.geojson`,
      geojsonChecksum: 'b'.repeat(64),
      pmtilesUrl: `https://example.test/${publicationId}.pmtiles`,
      pmtilesChecksum: 'a'.repeat(64),
      zoneCount: 1,
    });
    await expect(
      service.find(
        undefined,
        undefined,
        '65440',
        undefined,
        undefined,
        publicationId,
      ),
    ).resolves.toMatchObject([{ id: 1 }]);
    await expect(
      service.find('1', '1', undefined, undefined, undefined, publicationId),
    ).resolves.toMatchObject([{ id: 1 }]);
    expect(
      service['publicationSnapshots'].get(publicationId)?.features[0],
    ).toEqual({
      geometry: JSON.stringify(polygon),
      zoneId: 1,
    });
    expect(mockZonePublicationInstanceRepository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        activePublicationId: publicationId,
        zoneCount: 1,
        communeLinkCount: 1,
      }),
      ['instanceId'],
    );
    const heartbeat =
      mockZonePublicationInstanceRepository.upsert.mock.calls[
        mockZonePublicationInstanceRepository.upsert.mock.calls.length - 1
      ][0];
    expect(heartbeat.heartbeatAt()).toBe('now()');
  });

  it('verifies and publishes zone and department snapshots as one version', async () => {
    const publicationId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    const row: any = makePublicationRow(publicationId);
    const aggregate = buildZonePublicationAggregate([row.publicPayload], 1);
    row.departmentCount = 1;
    row.aggregatePayload = aggregate;
    row.contentFingerprint = computeZonePublicationFingerprint({
      zones: [
        {
          sourceZoneId: row.sourceZoneId,
          departmentCode: row.departmentCode,
          type: row.publicPayload.type,
          geometry: row.geom,
          publicPayload: row.publicPayload,
          communeCodes: row.communeCodes,
        },
      ],
      aggregate,
    });
    const situation = [
      {
        date: '2026-07-31',
        departementSituation: [{ code: '65', niveauGraviteMax: 'alerte' }],
      },
    ];
    let snapshotDuringDepartmentPublish: unknown;
    mockDepartementsService.buildSituationSnapshot.mockResolvedValue(situation);
    mockDepartementsService.publishSituation.mockImplementationOnce(() => {
      snapshotDuringDepartmentPublish = service['activeSnapshot'];
    });
    mockZonePublicationStateRepository.findOne.mockResolvedValue({
      activePublicationId: publicationId,
      candidatePublicationId: null,
    });
    mockZonePublicationRepository.query.mockResolvedValue([row]);

    await service.loadAllZones();

    expect(snapshotDuringDepartmentPublish).toBeNull();
    expect(mockDepartementsService.buildSituationSnapshot).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 1 })]),
      aggregate,
    );
    expect(
      mockDepartementsService.buildSituationSnapshot,
    ).toHaveBeenCalledTimes(2);
    expect(mockDepartementsService.publishSituation).toHaveBeenCalledWith(
      situation,
    );
    expect(service['activeSnapshot']).toMatchObject({
      aggregate,
      departmentSituation: situation,
      publication: {
        id: publicationId,
        contentFingerprint: row.contentFingerprint,
      },
    });
  });

  it('rebuilds department situation before an explicitly pinned active publication is adopted', async () => {
    const previousId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    const activatedId = '5a7edfae-f4b8-43f1-9bef-4314d65c8d4c';
    const previousSnapshot = makeVersionedSnapshot(previousId);
    const preloadedCandidate = Object.freeze({
      ...makeVersionedSnapshot(activatedId, 2, 'candidate'),
      departmentSituation: Object.freeze([{ date: 'stale' }]),
    });
    const certifiedSituation = [
      {
        date: '2026-07-31',
        departementSituation: [{ code: '65', niveauGraviteMax: 'alerte' }],
      },
    ];
    service['activeSnapshot'] = previousSnapshot as any;
    service['availablePublicationState'] = {
      activePublicationId: activatedId,
      candidatePublicationId: null,
    };
    service['publicationSnapshots'].set(activatedId, preloadedCandidate as any);
    mockZonePublicationRepository.findOne.mockResolvedValue({
      id: activatedId,
      status: 'active',
      activatedAt: version,
    });
    mockZonePublicationStateRepository.findOne.mockResolvedValue({
      activePublicationId: activatedId,
      candidatePublicationId: null,
    });
    mockDepartementsService.buildSituationSnapshot.mockResolvedValueOnce(
      certifiedSituation,
    );

    await expect(
      service.find(
        undefined,
        undefined,
        '65440',
        undefined,
        undefined,
        activatedId,
      ),
    ).resolves.toMatchObject([{ id: 2 }]);

    expect(service['activeSnapshot']?.departmentSituation).toEqual(
      certifiedSituation,
    );
    expect(service['publicationSnapshots'].get(activatedId)).toBe(
      service['activeSnapshot'],
    );
    expect(mockDepartementsService.publishSituation).toHaveBeenCalledWith(
      certifiedSituation,
    );
  });

  it('loads a legitimate empty versioned publication and serves empty lookups', async () => {
    const publicationId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    mockZonePublicationStateRepository.findOne.mockResolvedValue({
      activePublicationId: publicationId,
      candidatePublicationId: null,
    });
    mockZonePublicationRepository.query.mockResolvedValue([
      makeEmptyPublicationRow(publicationId),
    ]);

    await service.loadAllZones();

    expect(service['activeSnapshot']).toMatchObject({
      zones: [],
      features: [],
      zonesIndex: {},
      zonesCommunesIndex: {},
      communeAssociationCount: 0,
      publication: { id: publicationId, status: 'active' },
    });
    expect(service['activeSnapshot']?.zoneTree.search(1, 1, 1, 1)).toEqual([]);
    expect(mockFlatbushConstructor).not.toHaveBeenCalled();
    await expect(
      service.find('1', '1', undefined, undefined, undefined, publicationId),
    ).resolves.toEqual([]);
    await expect(
      service.find(
        undefined,
        undefined,
        '65440',
        undefined,
        undefined,
        publicationId,
      ),
    ).resolves.toEqual([]);
    await expect(service.getCacheStatus(true)).resolves.toMatchObject({
      status: 'ready',
      usable: true,
      fresh: true,
      counts: {
        zones: 0,
        features: 0,
        communes: 0,
        communeAssociations: 0,
      },
      publication: { mode: 'versioned', activeId: publicationId },
    });
    expect(mockZonePublicationInstanceRepository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        activePublicationId: publicationId,
        zoneCount: 0,
        communeLinkCount: 0,
      }),
      ['instanceId'],
    );
  });

  it.each([
    ['zone count', { zoneCount: 1, communeLinkCount: 0 }],
    ['commune count', { zoneCount: 0, communeLinkCount: 1 }],
  ])(
    'rejects an empty versioned publication with a mismatched %s',
    async (_label, counts) => {
      const publicationId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
      mockZonePublicationRepository.query.mockResolvedValueOnce([
        makeEmptyPublicationRow(publicationId, counts),
      ]);

      await expect(
        service['buildPublicationSnapshot'](publicationId, ['active']),
      ).rejects.toThrow('incohérente');
      expect(service['publicationSnapshots'].has(publicationId)).toBe(false);
    },
  );

  it('loads the active publication before answering the manifest on cold start', async () => {
    const publicationId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    let resolvePublication: (rows: any[]) => void;
    const publicationRows = new Promise<any[]>((resolve) => {
      resolvePublication = resolve;
    });
    mockZonePublicationStateRepository.findOne.mockResolvedValue({
      activePublicationId: publicationId,
      candidatePublicationId: null,
    });
    mockZonePublicationRepository.query.mockReturnValue(publicationRows);

    const manifest = service.getPublication();
    await flushPromises();
    let settled = false;
    void manifest.finally(() => {
      settled = true;
    });
    await flushPromises();
    expect(settled).toBe(false);

    resolvePublication!([makePublicationRow(publicationId)]);

    await expect(manifest).resolves.toMatchObject({ id: publicationId });
    expect(service['activeSnapshot']?.publication?.id).toBe(publicationId);
  });

  it('serves the active publication while its cold-start candidate is still preloading', async () => {
    const activeId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    const candidateId = '5a7edfae-f4b8-43f1-9bef-4314d65c8d4c';
    let resolveCandidate!: (rows: any[]) => void;
    const candidateRows = new Promise<any[]>((resolve) => {
      resolveCandidate = resolve;
    });
    mockZonePublicationStateRepository.findOne.mockResolvedValue({
      activePublicationId: activeId,
      candidatePublicationId: candidateId,
    });
    mockZonePublicationRepository.query.mockImplementation((_sql, params) =>
      params[0] === candidateId
        ? candidateRows
        : Promise.resolve([makePublicationRow(activeId)]),
    );

    const loading = service.loadAllZones();
    await flushPromises();
    await flushPromises();

    expect(service['loading']).toBe(false);
    expect(service['activeSnapshot']?.publication?.id).toBe(activeId);
    const candidatePreload =
      service['candidatePreloadPromises'].get(candidateId);
    expect(candidatePreload).toBeDefined();
    await expect(
      service.find(undefined, undefined, '65440'),
    ).resolves.toMatchObject([{ id: 1 }]);

    resolveCandidate([makePublicationRow(candidateId, 'candidate', 2)]);
    await Promise.all([loading, candidatePreload]);
    await flushPromises();

    expect(service['publicationSnapshots'].has(candidateId)).toBe(true);
  });

  it('checks the active pointer independently on two instances for unpinned requests', async () => {
    const oldId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    const activatedId = '5a7edfae-f4b8-43f1-9bef-4314d65c8d4c';
    const secondInstance = createStandaloneService();
    service['activeSnapshot'] = makeVersionedSnapshot(oldId) as any;
    secondInstance['activeSnapshot'] = makeVersionedSnapshot(oldId) as any;
    service['lastZoneComputationCheckAt'] = Date.now();
    secondInstance['lastZoneComputationCheckAt'] = Date.now();
    mockZonePublicationStateRepository.findOne.mockResolvedValue({
      activePublicationId: activatedId,
      candidatePublicationId: null,
    });
    mockZonePublicationRepository.query.mockResolvedValue([
      makePublicationRow(activatedId, 'active', 2),
    ]);

    const [manifest, zones] = await Promise.all([
      service.getPublication(),
      secondInstance.find(undefined, undefined, '65440'),
    ]);

    expect(manifest.id).toBe(activatedId);
    expect(zones).toMatchObject([{ id: 2 }]);
    expect(service['activeSnapshot']?.publication?.id).toBe(activatedId);
    expect(secondInstance['activeSnapshot']?.publication?.id).toBe(activatedId);
    expect(mockZonePublicationStateRepository.findOne).toHaveBeenCalledTimes(4);
    expect(mockZonePublicationRepository.query).toHaveBeenCalledTimes(2);

    await service.find(undefined, undefined, '65440');

    expect(mockZonePublicationStateRepository.findOne).toHaveBeenCalledTimes(5);
    expect(mockZonePublicationRepository.query).toHaveBeenCalledTimes(2);
    expect(mockZonePublicationInstanceRepository.upsert).toHaveBeenCalledTimes(
      2,
    );
  });

  it('preloads a candidate without making it publicly readable', async () => {
    const activeId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    const candidateId = '5a7edfae-f4b8-43f1-9bef-4314d65c8d4c';
    mockZonePublicationStateRepository.findOne.mockResolvedValue({
      activePublicationId: activeId,
      candidatePublicationId: candidateId,
    });
    mockZonePublicationRepository.query.mockImplementation((_sql, params) => {
      if (params[0] !== candidateId) {
        return Promise.resolve([makePublicationRow(activeId)]);
      }
      return Promise.resolve(
        [
          makePublicationRow(candidateId, 'candidate', 2),
          makePublicationRow(candidateId, 'candidate', 3),
        ].map((row) => ({
          ...row,
          zoneCount: 2,
          communeLinkCount: 2,
        })),
      );
    });

    await service.loadAllZones();
    await flushPromises();

    expect(service['publicationSnapshots'].has(candidateId)).toBe(true);
    await expect(
      service.find(
        undefined,
        undefined,
        '65440',
        undefined,
        undefined,
        candidateId,
      ),
    ).rejects.toMatchObject({ status: HttpStatus.GONE });
    expect(mockZonePublicationInstanceRepository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        candidatePublicationId: candidateId,
        zoneCount: 2,
        communeLinkCount: 2,
      }),
      ['instanceId'],
    );
  });

  it('evicts older publications before preloading a candidate', async () => {
    const activeId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    const retiredId = '8b9289cb-93f5-4eed-b2f9-a8f88d0bb095';
    const candidateId = '5a7edfae-f4b8-43f1-9bef-4314d65c8d4c';
    const activeSnapshot = makeVersionedSnapshot(activeId);
    service['activeSnapshot'] = activeSnapshot as any;
    service['availablePublicationState'] = {
      activePublicationId: activeId,
      candidatePublicationId: candidateId,
    };
    service['publicationSnapshots'].set(
      retiredId,
      makeVersionedSnapshot(retiredId, 3, 'retired') as any,
    );
    service['publicationSnapshots'].set(activeId, activeSnapshot as any);
    mockZonePublicationRepository.query.mockResolvedValueOnce([
      makePublicationRow(candidateId, 'candidate', 2),
    ]);

    await service['preloadCandidateSnapshot'](candidateId);

    expect([...service['publicationSnapshots'].keys()]).toEqual([
      activeId,
      candidateId,
    ]);
  });

  it('keeps heartbeats alive without acknowledging a candidate before preload completes', async () => {
    const activeId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    const candidateId = '5a7edfae-f4b8-43f1-9bef-4314d65c8d4c';
    const activeSnapshot = makeVersionedSnapshot(activeId);
    service['activeSnapshot'] = activeSnapshot as any;
    service['publicationSnapshots'].set(activeId, activeSnapshot as any);
    (service as any).publicationHeartbeatIntervalMs = 1;
    mockZonePublicationStateRepository.findOne.mockResolvedValue({
      activePublicationId: activeId,
      candidatePublicationId: candidateId,
    });
    let resolveCandidate!: (snapshot: any) => void;
    const candidateLoad = new Promise<any>((resolve) => {
      resolveCandidate = resolve;
    });
    jest
      .spyOn(service as any, 'buildPublicationSnapshot')
      .mockReturnValueOnce(candidateLoad);

    const loading = service.loadAllZones();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await loading;
    const candidatePreload =
      service['candidatePreloadPromises'].get(candidateId);
    expect(candidatePreload).toBeDefined();

    const pendingHeartbeats =
      mockZonePublicationInstanceRepository.upsert.mock.calls.map(
        ([heartbeat]) => heartbeat,
      );
    expect(pendingHeartbeats.length).toBeGreaterThanOrEqual(2);
    expect(
      pendingHeartbeats.every(
        (heartbeat) => heartbeat.candidatePublicationId === null,
      ),
    ).toBe(true);

    resolveCandidate(makeVersionedSnapshot(candidateId, 2, 'candidate'));
    await candidatePreload;
    await flushPromises();

    const completedHeartbeat =
      mockZonePublicationInstanceRepository.upsert.mock.calls[
        mockZonePublicationInstanceRepository.upsert.mock.calls.length - 1
      ][0];
    expect(completedHeartbeat.candidatePublicationId).toBe(candidateId);
  });

  it('forces a heartbeat with the candidate preload error', async () => {
    const activeId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    const candidateId = '5a7edfae-f4b8-43f1-9bef-4314d65c8d4c';
    const activeSnapshot = makeVersionedSnapshot(activeId);
    service['activeSnapshot'] = activeSnapshot as any;
    service['publicationSnapshots'].set(activeId, activeSnapshot as any);
    service['lastPublicationHeartbeatAt'] = Date.now();
    mockZonePublicationStateRepository.findOne.mockResolvedValue({
      activePublicationId: activeId,
      candidatePublicationId: candidateId,
    });
    jest
      .spyOn(service as any, 'buildPublicationSnapshot')
      .mockRejectedValueOnce(new Error('candidate read failed'));

    await service.loadAllZones();
    await flushPromises();

    const failedHeartbeat =
      mockZonePublicationInstanceRepository.upsert.mock.calls[
        mockZonePublicationInstanceRepository.upsert.mock.calls.length - 1
      ][0];
    expect(failedHeartbeat).toEqual(
      expect.objectContaining({
        candidatePublicationId: null,
        lastError: 'candidate-preload',
      }),
    );
  });

  it('coalesces forced heartbeats received during a slow database write', async () => {
    const publicationId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    service['activeSnapshot'] = makeVersionedSnapshot(publicationId) as any;
    service['availablePublicationState'] = {
      activePublicationId: publicationId,
      candidatePublicationId: null,
    };
    let resolveHeartbeat!: () => void;
    mockZonePublicationInstanceRepository.upsert.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveHeartbeat = resolve;
      }),
    );

    const first = service['writePublicationHeartbeat'](true);
    expect(mockZonePublicationInstanceRepository.upsert).toHaveBeenCalledTimes(
      1,
    );
    service['lastCacheError'] = {
      at: new Date(),
      message: 'candidate read failed',
      phase: 'candidate-preload',
    };
    const queued = [
      service['writePublicationHeartbeat'](true),
      service['writePublicationHeartbeat'](true),
      service['writePublicationHeartbeat'](true),
    ];
    expect(mockZonePublicationInstanceRepository.upsert).toHaveBeenCalledTimes(
      1,
    );

    resolveHeartbeat();
    await Promise.all([first, ...queued]);

    expect(mockZonePublicationInstanceRepository.upsert).toHaveBeenCalledTimes(
      2,
    );
    expect(
      mockZonePublicationInstanceRepository.upsert.mock.calls[1][0],
    ).toEqual(expect.objectContaining({ lastError: 'candidate-preload' }));
  });

  it('serves a newly activated pinned publication despite stale local state', async () => {
    const oldId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    const activatedId = '5a7edfae-f4b8-43f1-9bef-4314d65c8d4c';
    service['activeSnapshot'] = makeVersionedSnapshot(oldId) as any;
    service['availablePublicationState'] = {
      activePublicationId: oldId,
      candidatePublicationId: activatedId,
    };
    service['publicationSnapshots'].set(
      activatedId,
      makeVersionedSnapshot(activatedId, 2, 'candidate') as any,
    );
    service['lastZoneComputationCheckAt'] = Date.now();
    mockZonePublicationRepository.findOne.mockResolvedValue({
      id: activatedId,
      status: 'active',
      activatedAt: version,
    });

    await expect(
      service.find(
        undefined,
        undefined,
        '65440',
        undefined,
        undefined,
        activatedId,
      ),
    ).resolves.toMatchObject([{ id: 2 }]);
  });

  it('only advertises the complete publication loaded by the local instance', async () => {
    const loadedId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    const availableId = '5a7edfae-f4b8-43f1-9bef-4314d65c8d4c';
    service['activeSnapshot'] = makeVersionedSnapshot(loadedId) as any;
    service['availablePublicationState'] = {
      activePublicationId: availableId,
      candidatePublicationId: null,
    };
    service['lastZoneComputationCheckAt'] = Date.now();
    mockZonePublicationStateRepository.findOne.mockRejectedValue(
      new Error('db unavailable'),
    );

    await expect(service.getPublication()).resolves.toMatchObject({
      id: loadedId,
      revision: '42',
    });
  });

  it('reports a fresh versioned cache only when the active pointer is loaded', async () => {
    const publicationId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    service['activeSnapshot'] = makeVersionedSnapshot(publicationId) as any;
    service['lastSuccessfulZoneComputationCheckAt'] = new Date();
    mockZonePublicationStateRepository.findOne.mockResolvedValue({
      activePublicationId: publicationId,
      candidatePublicationId: null,
    });
    mockZonePublicationInstanceRepository.query.mockResolvedValue([
      { live: 2, activeReady: 2, candidateReady: 0 },
    ]);

    await expect(service.getCacheStatus(true)).resolves.toMatchObject({
      status: 'ready',
      fresh: true,
      publication: {
        mode: 'versioned',
        activeId: publicationId,
        activeRevision: '42',
        instances: { live: 2, activeReady: 2, candidateReady: 0 },
      },
    });

    mockZonePublicationStateRepository.findOne.mockResolvedValueOnce({
      activePublicationId: '5a7edfae-f4b8-43f1-9bef-4314d65c8d4c',
      candidatePublicationId: null,
    });
    await expect(service.getCacheStatus(true)).resolves.toMatchObject({
      status: 'degraded',
      fresh: false,
    });
  });

  it('keeps strict cache health degraded until the current candidate is preloaded', async () => {
    const activeId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    const candidateId = '5a7edfae-f4b8-43f1-9bef-4314d65c8d4c';
    service['activeSnapshot'] = makeVersionedSnapshot(activeId) as any;
    service['lastSuccessfulZoneComputationCheckAt'] = new Date();
    service['lastCacheError'] = {
      at: new Date(),
      message: 'candidate read failed',
      phase: 'candidate-preload',
    };
    mockZonePublicationStateRepository.findOne.mockResolvedValue({
      activePublicationId: activeId,
      candidatePublicationId: candidateId,
    });

    await expect(service.getCacheStatus(true)).resolves.toMatchObject({
      status: 'degraded',
      fresh: false,
      lastError: { phase: 'candidate-preload' },
      publication: { candidatePreloaded: false },
    });

    service['publicationSnapshots'].set(
      candidateId,
      makeVersionedSnapshot(candidateId, 2, 'candidate') as any,
    );

    await expect(service.getCacheStatus(true)).resolves.toMatchObject({
      status: 'ready',
      fresh: true,
      lastError: null,
      publication: { candidatePreloaded: true },
    });
  });

  it('serves a retained publication but never reads a building publication', async () => {
    const retainedId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    installSnapshot();
    service['publicationSnapshots'].set(
      retainedId,
      makeVersionedSnapshot(retainedId, 1, 'retired') as any,
    );
    mockZonePublicationRepository.findOne.mockResolvedValueOnce({
      id: retainedId,
      status: 'retired',
    });

    await expect(
      service.find(
        undefined,
        undefined,
        '65440',
        undefined,
        undefined,
        retainedId,
      ),
    ).resolves.toMatchObject([{ id: 1 }]);

    const buildingId = '5a7edfae-f4b8-43f1-9bef-4314d65c8d4c';
    mockZonePublicationRepository.findOne.mockResolvedValueOnce({
      id: buildingId,
      status: 'building',
    });
    mockZonePublicationRepository.query.mockClear();
    await expect(
      service.find(
        undefined,
        undefined,
        '65440',
        undefined,
        undefined,
        buildingId,
      ),
    ).rejects.toMatchObject({ status: HttpStatus.GONE });
    expect(mockZonePublicationRepository.query).not.toHaveBeenCalled();
  });

  it('replaces the retained snapshot before loading another retired pin', async () => {
    const activeId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    const retainedId = '8b9289cb-93f5-4eed-b2f9-a8f88d0bb095';
    const requestedId = 'a782b6c6-646d-4c80-b20a-4ec13173e90d';
    const activeSnapshot = makeVersionedSnapshot(activeId);
    service['activeSnapshot'] = activeSnapshot as any;
    service['availablePublicationState'] = {
      activePublicationId: activeId,
      candidatePublicationId: null,
    };
    service['publicationSnapshots'].set(activeId, activeSnapshot as any);
    service['publicationSnapshots'].set(
      retainedId,
      makeVersionedSnapshot(retainedId, 2, 'retired') as any,
    );
    mockZonePublicationRepository.findOne.mockResolvedValueOnce({
      id: requestedId,
      status: 'retired',
    });
    mockZonePublicationRepository.query.mockResolvedValueOnce([
      makePublicationRow(requestedId, 'retired', 3),
    ]);

    await expect(
      service.find(
        undefined,
        undefined,
        '65440',
        undefined,
        undefined,
        requestedId,
      ),
    ).resolves.toMatchObject([{ id: 3 }]);
    expect([...service['publicationSnapshots'].keys()]).toEqual([
      activeId,
      requestedId,
    ]);
  });

  it('returns 503 and retains the active snapshot when pinned publication metadata cannot be read', async () => {
    const activeSnapshot = installSnapshot();
    const publicationId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    mockZonePublicationRepository.findOne.mockRejectedValueOnce(
      new Error('database unavailable'),
    );

    await expect(
      service.find(
        undefined,
        undefined,
        '65440',
        undefined,
        undefined,
        publicationId,
      ),
    ).rejects.toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE });
    expect(service['activeSnapshot']).toBe(activeSnapshot);
    expect(service['lastCacheError']).toBeNull();
  });

  it('keeps an uncached retired pin out of memory during candidate preload', async () => {
    const activeId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    const candidateId = '5a7edfae-f4b8-43f1-9bef-4314d65c8d4c';
    const publicationId = '8b9289cb-93f5-4eed-b2f9-a8f88d0bb095';
    const activeSnapshot = makeVersionedSnapshot(activeId);
    service['activeSnapshot'] = activeSnapshot as any;
    service['availablePublicationState'] = {
      activePublicationId: activeId,
      candidatePublicationId: candidateId,
    };
    service['publicationSnapshots'].set(
      candidateId,
      makeVersionedSnapshot(candidateId, 2, 'candidate') as any,
    );
    mockZonePublicationRepository.findOne.mockResolvedValueOnce({
      id: publicationId,
      status: 'retired',
    });
    await expect(
      service.find(
        undefined,
        undefined,
        '65440',
        undefined,
        undefined,
        publicationId,
      ),
    ).rejects.toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE });
    expect(service['activeSnapshot']).toBe(activeSnapshot);
    expect(service['lastCacheError']).toBeNull();
    expect(mockZonePublicationRepository.query).not.toHaveBeenCalled();

    await service['writePublicationHeartbeat'](true);

    const heartbeat =
      mockZonePublicationInstanceRepository.upsert.mock.calls[
        mockZonePublicationInstanceRepository.upsert.mock.calls.length - 1
      ][0];
    expect(heartbeat).toEqual(
      expect.objectContaining({
        candidatePublicationId: candidateId,
        lastError: null,
      }),
    );
  });

  it('keeps an uncached retired pin out of memory during activation', async () => {
    const previousId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    const activeId = '5a7edfae-f4b8-43f1-9bef-4314d65c8d4c';
    const publicationId = '8b9289cb-93f5-4eed-b2f9-a8f88d0bb095';
    const previousSnapshot = makeVersionedSnapshot(previousId);
    service['activeSnapshot'] = previousSnapshot as any;
    service['availablePublicationState'] = {
      activePublicationId: activeId,
      candidatePublicationId: null,
    };
    service['publicationSnapshots'].set(previousId, previousSnapshot as any);
    service['publicationSnapshots'].set(
      activeId,
      makeVersionedSnapshot(activeId, 2) as any,
    );
    mockZonePublicationRepository.findOne.mockResolvedValueOnce({
      id: publicationId,
      status: 'retired',
    });

    await expect(
      service.find(
        undefined,
        undefined,
        '65440',
        undefined,
        undefined,
        publicationId,
      ),
    ).rejects.toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE });
    expect(mockZonePublicationRepository.query).not.toHaveBeenCalled();
    expect(service['publicationSnapshots'].size).toBe(2);
  });

  it('keeps municipal decrees in formatting without mutating the snapshot', () => {
    service['activeSnapshot'] = {
      ...makeSnapshot(1),
      communeArretesMunicipaux: [
        {
          code: '65440',
          arretesMunicipaux: [
            { fichier: { url: 'https://example.test/a.pdf' } },
          ],
        },
      ],
    } as any;

    const result = service.formatZones(
      [makeZone(1)],
      undefined,
      undefined,
      '65440',
    );

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 1,
          arreteMunicipalCheminFichier: 'https://example.test/a.pdf',
        }),
        expect.objectContaining({ id: null, type: 'AEP' }),
        expect.objectContaining({ id: null, type: 'SOU' }),
      ]),
    );
  });

  it('refreshes municipal decrees in active and preloaded publication snapshots', async () => {
    const activeId = '37fec02d-4d5f-45ae-8f8c-9cae2b725f80';
    const candidateId = '5a7edfae-f4b8-43f1-9bef-4314d65c8d4c';
    service['activeSnapshot'] = makeVersionedSnapshot(activeId) as any;
    service['publicationSnapshots'].set(
      activeId,
      service['activeSnapshot'] as any,
    );
    service['publicationSnapshots'].set(
      candidateId,
      makeVersionedSnapshot(candidateId, 2, 'candidate') as any,
    );
    mockCommunesService.findArretesMunicipaux.mockResolvedValue([
      { code: '65440', arretesMunicipaux: [] },
    ]);

    await service['refreshArretesMunicipaux']();

    expect(service['activeSnapshot']?.communeArretesMunicipaux).toHaveLength(1);
    expect(
      service['publicationSnapshots'].get(candidateId)
        ?.communeArretesMunicipaux,
    ).toHaveLength(1);
  });

  it('deduplicates full municipal decree refreshes', async () => {
    installSnapshot();
    let resolveRead!: (communes: any[]) => void;
    mockCommunesService.findArretesMunicipaux.mockReturnValueOnce(
      new Promise<any[]>((resolve) => {
        resolveRead = resolve;
      }),
    );

    const first = service['refreshArretesMunicipaux']();
    const second = service['refreshArretesMunicipaux']();
    expect(mockCommunesService.findArretesMunicipaux).toHaveBeenCalledTimes(1);
    resolveRead([{ code: '65440', arretesMunicipaux: [] }]);
    await Promise.all([first, second]);

    expect(service['activeSnapshot']?.communeArretesMunicipaux).toEqual([
      { code: '65440', arretesMunicipaux: [] },
    ]);
  });

  it('reloads municipal decrees periodically so removals cannot be missed', async () => {
    service['activeSnapshot'] = {
      ...makeSnapshot(1),
      communeArretesMunicipaux: [
        { code: '65440', arretesMunicipaux: [{ id: 1 }] },
      ],
    } as any;
    mockCommunesService.findArretesMunicipaux.mockResolvedValueOnce([]);

    await service.updateArretesMunicipaux();

    expect(mockCommunesService.findArretesMunicipaux).toHaveBeenCalledTimes(1);
    expect(service['activeSnapshot']?.communeArretesMunicipaux).toEqual([]);
  });
});
