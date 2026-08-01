import { BassinVersant } from '@shared/entities/bassin_versant.entity';
import { Departement } from '@shared/entities/departement.entity';
import { SandreZoneAlias } from '@shared/entities/sandre_zone_alias.entity';
import { SandreZoneSyncState } from '@shared/entities/sandre_zone_sync_state.entity';
import { ZoneAlerte } from '@shared/entities/zone_alerte.entity';
import { of } from 'rxjs';
import { getMetadataArgsStorage } from 'typeorm';
import { createSandreZoneSnapshot } from './sandre-zone-sync';
import { ZoneAlerteService } from './zone_alerte.service';

describe('ZoneAlerteService Sandre synchronization', () => {
  const department = { id: 65, code: '65' };
  const basin = { id: 7, code: 7 };

  const rawFeature = (overrides: Record<string, any> = {}) => ({
    type: 'Feature',
    properties: {
      gid: 3201,
      CdZAS: '3201',
      CdDepartement: '65',
      CodesAlternatifs: '{"{\\"code\\":\\"73_65_14\\"}"}',
      LbZAS: 'Zone actuelle',
      TypeZAS: 'SUP',
      StZAS: 'Validé',
      DateMajZAS: '2026-07-01',
      NumeroVersionZAS: 1,
      NumCircAdminBassin: 7,
      RessInfluenceeZAS: 0,
      ...overrides,
    },
    geometry: {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [0, 43],
            [1, 43],
            [0.5, 44],
            [0, 43],
          ],
        ],
      ],
    },
  });
  const countResponse = (count: number) => ({
    data: `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="${count}" numberReturned="0"></wfs:FeatureCollection>`,
  });

  it('keeps Sandre synchronization metadata out of default API selections', () => {
    const hiddenColumns = getMetadataArgsStorage()
      .columns.filter(
        (column) =>
          column.target === ZoneAlerte && column.options.select === false,
      )
      .map((column) => column.propertyName);

    expect(hiddenColumns).toEqual(
      expect.arrayContaining([
        'codeSandre',
        'statutSandre',
        'dateMajSandre',
        'codesAlternatifs',
        'sandrePayloadHash',
      ]),
    );
  });

  const createHarness = (options?: {
    httpResponses?: any[];
    state?: any;
    zoneFind?: jest.Mock;
    aliasFind?: jest.Mock;
    basin?: any;
    recomputeResult?: any;
    syncMode?: string;
    invalidGeometryCodes?: string[];
    referencedZoneIds?: number[];
    genealogyRelations?: Array<{
      id: string;
      parentCode: string;
      childCode: string;
      modificationDate: string;
      modificationType: string;
      reason: string;
    }>;
    globalLockAvailable?: boolean;
  }) => {
    const zoneRepository = {
      create: jest.fn(() => ({})),
      find: options?.zoneFind ?? jest.fn().mockResolvedValue([]),
      save: jest.fn(async (zone) => {
        if (!zone.id) {
          zone.id = 999;
        }
        return zone;
      }),
    };
    let storedState = options?.state ?? null;
    const stateRepository = {
      create: jest.fn((value) => ({ ...value })),
      findOne: jest.fn(async () => storedState),
      save: jest.fn(async (state) => {
        storedState = state;
        return state;
      }),
    };
    const aliasRepository = {
      create: jest.fn((value) => ({ ...value })),
      findOne: options?.aliasFind ?? jest.fn().mockResolvedValue(null),
      save: jest.fn(async (alias) => alias),
    };
    const departmentRepository = {
      findOne: jest.fn().mockResolvedValue(department),
    };
    const basinRepository = {
      findOne: jest
        .fn()
        .mockResolvedValue(
          options && 'basin' in options ? options.basin : basin,
        ),
    };
    const repositories = new Map<any, any>([
      [ZoneAlerte, zoneRepository],
      [SandreZoneSyncState, stateRepository],
      [SandreZoneAlias, aliasRepository],
      [Departement, departmentRepository],
      [BassinVersant, basinRepository],
    ]);
    const manager = {
      getRepository: jest.fn((entity) => repositories.get(entity)),
      query: jest.fn(async (query: string, parameters?: any[]) => {
        if (query.includes('ST_IsValid')) {
          return (options?.invalidGeometryCodes ?? []).map((code) => ({
            code,
          }));
        }
        if (query.includes('AS "nonAbrogeArreteCadre"')) {
          const referenced = (options?.referencedZoneIds ?? []).includes(
            parameters?.[0],
          );
          return [
            {
              arreteCadre: referenced ? 1 : 0,
              nonAbrogeArreteCadre: referenced ? 1 : 0,
              restrictions: 0,
              customizations: 0,
            },
          ];
        }
        return [];
      }),
    };
    const queryRunner = {
      manager,
      query: jest.fn(async (query: string, parameters?: any[]) => {
        if (query.includes('pg_try_advisory_lock')) {
          return [
            {
              locked:
                options?.globalLockAvailable === undefined
                  ? true
                  : options.globalLockAvailable,
            },
          ];
        }
        if (query.includes('pg_advisory_unlock')) {
          return [{ unlocked: true }];
        }
        if (
          query.includes('UPDATE sandre_zone_sync_state') &&
          storedState?.recomputeRevision === parameters?.[1]
        ) {
          storedState.needsRecompute = false;
        }
        return [];
      }),
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = {
      createQueryRunner: jest.fn(() => queryRunner),
      getRepository: jest.fn((entity) => repositories.get(entity)),
      query: jest.fn(async (query: string, parameters?: any[]) => {
        if (query.includes('clock_timestamp')) {
          return [
            {
              syncStartedAt: new Date('2026-07-31T08:00:00.000Z'),
            },
          ];
        }
        if (query.includes('INSERT INTO sandre_zone_sync_batch')) {
          return [{ id: '1' }];
        }
        if (
          query.includes('UPDATE sandre_zone_sync_state') &&
          storedState?.recomputeRevision === parameters?.[1]
        ) {
          storedState.needsRecompute = false;
        }
        return [];
      }),
    };
    const responses = options?.httpResponses ?? [
      countResponse(1),
      {
        data: {
          features: [rawFeature()],
        },
      },
      countResponse(1),
    ];
    const httpService = {
      get: jest.fn(() => of(responses.shift())),
    };
    const departementService = {
      findAllLight: jest.fn().mockResolvedValue([department]),
      getAll: jest.fn().mockResolvedValue(undefined),
    };
    const mailService = {
      sendEmailsByDepartement: jest.fn().mockResolvedValue(undefined),
    };
    const arreteCadreService = {
      findByDepartement: jest.fn().mockResolvedValue([]),
    };
    const configService = {
      get: jest.fn((key) =>
        key === 'SANDRE_ZONE_SYNC_MODE'
          ? options && 'syncMode' in options
            ? options.syncMode
            : 'safe'
          : undefined,
      ),
      getOrThrow: jest.fn().mockReturnValue('https://services.sandre.test'),
    };
    const runCurrentZoneComputeWorker = jest
      .fn()
      .mockResolvedValue(options?.recomputeResult ?? { success: true });

    const service = new ZoneAlerteService(
      zoneRepository as any,
      configService as any,
      httpService as any,
      departementService as any,
      {} as any,
      mailService as any,
      arreteCadreService as any,
      dataSource as any,
    );
    (service as any).runCurrentZoneComputeWorker = runCurrentZoneComputeWorker;
    (service as any).getSandreGenealogyRelations = jest
      .fn()
      .mockResolvedValue(options?.genealogyRelations ?? []);

    return {
      aliasRepository,
      basinRepository,
      dataSource,
      departmentRepository,
      departementService,
      httpService,
      mailService,
      manager,
      queryRunner,
      service,
      stateRepository,
      zoneRepository,
      runCurrentZoneComputeWorker,
    };
  };

  it('rejects an incomplete paginated snapshot before opening a transaction', async () => {
    const harness = createHarness({
      httpResponses: [
        countResponse(2),
        {
          data: {
            features: [rawFeature()],
          },
        },
        {
          data: {
            features: [],
          },
        },
      ],
    });

    await expect(harness.service.updateDepartementZones('65')).rejects.toThrow(
      'Incomplete Sandre snapshot',
    );

    expect(harness.dataSource.createQueryRunner).toHaveBeenCalledTimes(1);
    expect(harness.queryRunner.startTransaction).not.toHaveBeenCalled();
    expect(harness.zoneRepository.save).not.toHaveBeenCalled();
  });

  it('does not use a reused alternate display code as a zone identity', async () => {
    const zoneFind = jest.fn().mockResolvedValue([]);
    const harness = createHarness({ zoneFind });

    const result = await harness.service.updateDepartementZones('65');

    expect(result).toEqual({
      added: 1,
      updated: 0,
      disabled: 0,
      unchanged: 0,
    });
    expect(zoneFind).toHaveBeenCalledTimes(2);
    expect(zoneFind.mock.calls).not.toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            where: expect.objectContaining({ code: '73_65_14' }),
          }),
        ],
      ]),
    );
    expect(harness.zoneRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        code: '73_65_14',
        codeSandre: '3201',
        idSandre: 3201,
        disabled: false,
      }),
    );
  });

  it('holds the global database lock before the first Sandre request', async () => {
    const harness = createHarness();

    await harness.service.updateDepartementZones('65');

    const lockCallIndex = harness.queryRunner.query.mock.calls.findIndex(
      ([query]) => query.includes('pg_try_advisory_lock'),
    );
    expect(lockCallIndex).toBeGreaterThanOrEqual(0);
    expect(
      harness.queryRunner.query.mock.invocationCallOrder[lockCallIndex],
    ).toBeLessThan(harness.httpService.get.mock.invocationCallOrder[0]);
  });

  it('does not fetch when another process owns the global lock', async () => {
    const harness = createHarness({ globalLockAvailable: false });

    await expect(harness.service.updateDepartementZones('65')).rejects.toThrow(
      'already running',
    );

    expect(harness.httpService.get).not.toHaveBeenCalled();
    expect(harness.dataSource.query).not.toHaveBeenCalled();
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('releases the query runner and falls back when the global unlock fails', async () => {
    const harness = createHarness();
    const unlockError = new Error('unlock query failed');
    harness.queryRunner.query
      .mockRejectedValueOnce(unlockError)
      .mockResolvedValueOnce([]);

    await expect(
      (harness.service as any).releaseSandreGlobalLock(harness.queryRunner),
    ).rejects.toBe(unlockError);
    expect(harness.queryRunner.query).toHaveBeenNthCalledWith(
      2,
      'SELECT pg_advisory_unlock_all()',
    );
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('records an audit snapshot and decisions without mutating zones', async () => {
    const harness = createHarness({ syncMode: 'audit' });

    await expect(harness.service.updateDepartementZones('65')).resolves.toEqual(
      {
        added: 0,
        updated: 0,
        disabled: 0,
        unchanged: 1,
      },
    );

    expect(harness.queryRunner.startTransaction).not.toHaveBeenCalled();
    expect(harness.zoneRepository.save).not.toHaveBeenCalled();
    expect(harness.dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('"observedSnapshotHash"'),
      expect.any(Array),
    );
    expect(harness.dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO sandre_zone_sync_decision'),
      expect.any(Array),
    );
    expect(harness.runCurrentZoneComputeWorker).not.toHaveBeenCalled();
  });

  it('exposes a redacted operator status with observed, applied and blocked state', async () => {
    const harness = createHarness();
    harness.dataSource.query.mockImplementation((async (query: string) => {
      if (query.includes('FROM sandre_zone_sync_batch')) {
        return [
          {
            id: '12',
            mode: 'safe',
            status: 'blocked',
            startedAt: new Date(Date.now() - 20_000),
            finishedAt: new Date(Date.now() - 10_000),
            failureReason: 'must not be exposed',
          },
        ];
      }
      return [
        {
          departmentCode: '65',
          observedSourceUpdatedAt: '2026-08-01',
          appliedSourceUpdatedAt: '2026-07-31',
          lastObservedAt: new Date(Date.now() - 30_000),
          lastAppliedAt: new Date(Date.now() - 86_400_000),
          blockedAt: new Date(Date.now() - 10_000),
          blockCode: 'NON_ABROGATED_AC_REFERENCE',
          blockedReason: 'must not be exposed',
        },
      ];
    }) as any);

    const status = await harness.service.getSandreOperatorStatus();

    expect(status).toEqual(
      expect.objectContaining({
        mode: 'safe',
        latestBatch: expect.objectContaining({
          id: '12',
          status: 'blocked',
          durationSeconds: 10,
        }),
        summary: {
          trackedDepartments: 1,
          blockedDepartments: 1,
        },
        departments: [
          expect.objectContaining({
            departmentCode: '65',
            blocked: true,
            blockCode: 'NON_ABROGATED_AC_REFERENCE',
          }),
        ],
      }),
    );
    expect(JSON.stringify(status)).not.toContain('failureReason');
    expect(JSON.stringify(status)).not.toContain('blockedReason');
    expect(JSON.stringify(status)).not.toContain('must not be exposed');
  });

  it('purges old Sandre batches while retaining the latest audit trail', async () => {
    const harness = createHarness();
    harness.dataSource.query.mockResolvedValue([
      [{ id: '10' }, { id: '11' }],
      2,
    ] as any);

    await expect(harness.service.purgeSandreSyncHistory()).resolves.toBe(2);

    expect(harness.dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('WITH retained AS'),
      [90],
    );
    expect(harness.dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining(`batch."status" <> 'started'`),
      [90],
    );
  });

  it('disables only a zone explicitly returned with an inactive status', async () => {
    const activeFeature = rawFeature();
    const frozenFeature = rawFeature({
      gid: 1380,
      CdZAS: '1380',
      LbZAS: 'Zone historique',
      StZAS: 'Gelé',
    });
    const activeZone = {
      id: 201,
      idSandre: 3201,
      codeSandre: '3201',
      code: '73_65_14',
      nom: 'Zone actuelle',
      type: 'SUP',
      numeroVersionSandre: 1,
      ressourceInfluencee: false,
      disabled: false,
      statutSandre: 'Validé',
      dateMajSandre: '2026-07-01',
      sandrePayloadHash: 'outdated',
      departement: department,
      bassinVersant: basin,
    };
    const frozenZone = {
      id: 102,
      idSandre: 1380,
      codeSandre: '1380',
      code: '73_65_07',
      nom: 'Zone historique',
      type: 'SUP',
      disabled: false,
      departement: department,
      bassinVersant: basin,
    };
    const unrelatedZone = {
      id: 777,
      disabled: false,
    };
    const zoneFind = jest
      .fn()
      .mockResolvedValueOnce([activeZone])
      .mockResolvedValueOnce([frozenZone]);
    const harness = createHarness({
      httpResponses: [
        countResponse(2),
        {
          data: {
            features: [activeFeature, frozenFeature],
          },
        },
        countResponse(2),
      ],
      zoneFind,
    });

    const result = await harness.service.updateDepartementZones('65');

    expect(result.disabled).toBe(1);
    expect(frozenZone.disabled).toBe(true);
    expect(unrelatedZone.disabled).toBe(false);
    expect(harness.zoneRepository.save).toHaveBeenCalledWith(frozenZone);
    expect(zoneFind).toHaveBeenCalledTimes(2);
  });

  it('rolls back the whole department when a referenced frozen zone has no official successor', async () => {
    const activeFeature = rawFeature();
    const frozenFeature = rawFeature({
      gid: 1380,
      CdZAS: '1380',
      LbZAS: 'Zone historique',
      StZAS: 'Gelé',
    });
    const activeZone = {
      id: 201,
      idSandre: 3201,
      codeSandre: '3201',
      disabled: false,
      type: 'SUP',
      departement: department,
      bassinVersant: basin,
    };
    const frozenZone = {
      id: 102,
      idSandre: 1380,
      codeSandre: '1380',
      disabled: false,
      type: 'SUP',
      departement: department,
      bassinVersant: basin,
    };
    const harness = createHarness({
      httpResponses: [
        countResponse(2),
        { data: { features: [activeFeature, frozenFeature] } },
        countResponse(2),
      ],
      zoneFind: jest
        .fn()
        .mockResolvedValueOnce([activeZone])
        .mockResolvedValueOnce([frozenZone]),
      referencedZoneIds: [102],
    });

    await expect(harness.service.updateDepartementZones('65')).rejects.toThrow(
      'NO_TYPE_2_SUCCESSOR',
    );

    expect(harness.queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(harness.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(harness.dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('"blockedSnapshotHash"'),
      expect.any(Array),
    );
  });

  it('reconciles a referenced frozen zone only through a strict official successor', async () => {
    const activeFeature = rawFeature({ gid: 3201, CdZAS: 'NEW' });
    const frozenFeature = rawFeature({
      gid: 1380,
      CdZAS: 'OLD',
      LbZAS: 'Zone historique',
      StZAS: 'Gelé',
    });
    const activeZone = {
      id: 201,
      idSandre: 3201,
      codeSandre: 'NEW',
      code: '73_65_14',
      nom: 'Zone actuelle',
      type: 'SUP',
      numeroVersionSandre: 1,
      ressourceInfluencee: false,
      disabled: false,
      departement: department,
      bassinVersant: basin,
      geom: activeFeature.geometry,
      codesAlternatifs: ['73_65_14'],
    };
    const frozenZone = {
      id: 102,
      idSandre: 1380,
      codeSandre: 'OLD',
      disabled: false,
      type: 'SUP',
      departement: department,
      bassinVersant: basin,
    };
    const harness = createHarness({
      httpResponses: [
        countResponse(2),
        { data: { features: [activeFeature, frozenFeature] } },
        countResponse(2),
      ],
      zoneFind: jest
        .fn()
        .mockResolvedValueOnce([activeZone])
        .mockResolvedValueOnce([frozenZone]),
      referencedZoneIds: [102],
      genealogyRelations: [
        {
          id: '1',
          parentCode: 'OLD',
          childCode: 'NEW',
          modificationDate: '2026-07-01',
          modificationType: '2',
          reason: 'Remplacement',
        },
      ],
    });

    await expect(harness.service.updateDepartementZones('65')).resolves.toEqual(
      expect.objectContaining({ disabled: 1 }),
    );

    expect(harness.aliasRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        zoneAlerte: expect.objectContaining({ id: 201 }),
        aliasValue: 'OLD',
        source: 'sandre_genealogy',
      }),
    );
    expect(frozenZone.disabled).toBe(true);
    expect(harness.queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('rolls back the entire department when an active zone is invalid', async () => {
    const harness = createHarness({ basin: null });

    await expect(harness.service.updateDepartementZones('65')).rejects.toThrow(
      'Unknown basin',
    );

    expect(harness.queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(harness.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(harness.stateRepository.save).not.toHaveBeenCalled();
  });

  it('rolls back before writes when PostGIS rejects an active geometry', async () => {
    const harness = createHarness({ invalidGeometryCodes: ['3201'] });

    await expect(harness.service.updateDepartementZones('65')).rejects.toThrow(
      'Invalid Sandre geometry for zone 3201',
    );

    expect(harness.zoneRepository.save).not.toHaveBeenCalled();
    expect(harness.queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(harness.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it('rejects two active canonical codes resolving through aliases to one zone', async () => {
    const sharedZone = {
      id: 10,
      idSandre: 1,
      codeSandre: 'OLD',
      nom: 'Ancienne zone',
      code: 'DISPLAY',
      type: 'SUP',
      ressourceInfluencee: false,
      numeroVersionSandre: 1,
      disabled: false,
      departement: department,
      bassinVersant: basin,
      geom: rawFeature().geometry,
      codesAlternatifs: [],
    };
    const harness = createHarness({
      httpResponses: [
        countResponse(2),
        {
          data: {
            features: [
              rawFeature({ gid: 1, CdZAS: 'OLD' }),
              rawFeature({ gid: 2, CdZAS: 'NEW' }),
            ],
          },
        },
        countResponse(2),
      ],
      zoneFind: jest.fn(async ({ where }) =>
        where.codeSandre === 'OLD' ? [sharedZone] : [],
      ),
      aliasFind: jest.fn(async ({ where }) =>
        where.aliasValue === 'NEW' ? { id: 20, zoneAlerte: sharedZone } : null,
      ),
    });

    await expect(harness.service.updateDepartementZones('65')).rejects.toThrow(
      'Multiple active Sandre codes resolve to local zone 10',
    );
    expect(harness.queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(harness.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it('keeps a retry marker when post-commit recomputation fails', async () => {
    const harness = createHarness({
      recomputeResult: {
        success: false,
        error: 'worker failed',
      },
    });

    await expect(harness.service.updateDepartementZones('65')).resolves.toEqual(
      expect.objectContaining({
        added: 1,
      }),
    );

    expect(harness.runCurrentZoneComputeWorker).toHaveBeenCalledWith([65]);
    expect(harness.stateRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        needsRecompute: true,
      }),
    );
  });

  it('does not clear a newer recomputation revision', async () => {
    const state = {
      needsRecompute: true,
      recomputeRevision: 1,
      departement: department,
    };
    const harness = createHarness({ state });
    let finishRecompute: (result: any) => void;
    harness.runCurrentZoneComputeWorker.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRecompute = resolve;
        }),
    );

    const recompute = (harness.service as any).recomputeSandreDepartment('65');
    await new Promise((resolve) => setImmediate(resolve));
    state.recomputeRevision = 2;
    finishRecompute({ success: true });
    await recompute;

    expect(state.needsRecompute).toBe(true);
    expect(harness.dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE sandre_zone_sync_state'),
      [65, 1],
    );
  });

  it('rejects an unknown Sandre status before opening a transaction', async () => {
    const harness = createHarness({
      httpResponses: [
        countResponse(1),
        {
          data: {
            features: [rawFeature({ StZAS: 'Projet' })],
          },
        },
        countResponse(1),
      ],
    });

    await expect(harness.service.updateDepartementZones('65')).rejects.toThrow(
      'Invalid Sandre zone payload',
    );
    expect(harness.dataSource.createQueryRunner).toHaveBeenCalledTimes(1);
    expect(harness.queryRunner.startTransaction).not.toHaveBeenCalled();
    expect(harness.zoneRepository.save).not.toHaveBeenCalled();
  });

  it('revalidates an unchanged snapshot without rewriting its zones', async () => {
    const snapshot = createSandreZoneSnapshot(
      [rawFeature()],
      1,
      department.code,
    );
    const state = {
      id: 1,
      snapshotHash: snapshot.snapshotHash,
    };
    const feature = snapshot.features[0];
    const existingZone = {
      id: 201,
      idSandre: feature.gid,
      codeSandre: feature.codeSandre,
      code: feature.alternateCodes[0],
      nom: feature.name,
      type: feature.type,
      numeroVersionSandre: feature.version,
      ressourceInfluencee: feature.influencedResource,
      disabled: false,
      statutSandre: feature.status,
      dateMajSandre: feature.sourceUpdatedAt,
      sandrePayloadHash: feature.payloadHash,
      codesAlternatifs: feature.alternateCodes,
      geom: feature.geometry,
      departement: department,
      bassinVersant: basin,
    };
    const harness = createHarness({
      state,
      zoneFind: jest.fn().mockResolvedValue([existingZone]),
    });

    const result = await (harness.service as any).applySandreSnapshot(
      department.code,
      snapshot,
      new Date('2026-07-31T08:00:00.000Z'),
    );

    expect(result).toEqual(
      expect.objectContaining({
        result: {
          added: 0,
          updated: 0,
          disabled: 0,
          unchanged: 1,
        },
        recomputeRequired: false,
      }),
    );
    expect(harness.zoneRepository.find).toHaveBeenCalledTimes(1);
    expect(harness.zoneRepository.save).not.toHaveBeenCalled();
    expect(harness.stateRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        featureCount: 1,
        snapshotHash: snapshot.snapshotHash,
      }),
    );
    expect(harness.queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('ignores a snapshot that started before the last applied snapshot', async () => {
    const snapshot = createSandreZoneSnapshot(
      [rawFeature()],
      1,
      department.code,
    );
    const state = {
      id: 1,
      snapshotHash: 'newer-snapshot',
      snapshotStartedAt: new Date('2026-07-31T09:00:00.000Z'),
      sourceUpdatedAt: snapshot.sourceUpdatedAt,
    };
    const harness = createHarness({ state });

    const result = await (harness.service as any).applySandreSnapshot(
      department.code,
      snapshot,
      new Date('2026-07-31T08:00:00.000Z'),
    );

    expect(result.result.updated).toBe(0);
    expect(result.recomputeRequired).toBe(false);
    expect(harness.zoneRepository.find).not.toHaveBeenCalled();
    expect(harness.stateRepository.save).not.toHaveBeenCalled();
    expect(harness.queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('backfills Sandre identity metadata without recomputing unchanged maps', async () => {
    const snapshot = createSandreZoneSnapshot(
      [rawFeature()],
      1,
      department.code,
    );
    const feature = snapshot.features[0];
    const legacyZone = {
      id: 201,
      idSandre: feature.gid,
      codeSandre: null,
      code: feature.preferredAlternateCode,
      nom: feature.name,
      type: feature.type,
      numeroVersionSandre: feature.version,
      ressourceInfluencee: feature.influencedResource,
      disabled: false,
      statutSandre: null,
      dateMajSandre: null,
      sandrePayloadHash: null,
      codesAlternatifs: null,
      geom: feature.geometry,
      departement: department,
      bassinVersant: basin,
    };
    const state = {
      needsRecompute: false,
      recomputeRevision: 0,
    };
    const harness = createHarness({
      state,
      zoneFind: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([legacyZone]),
    });

    await expect(harness.service.updateDepartementZones('65')).resolves.toEqual(
      {
        added: 0,
        updated: 1,
        disabled: 0,
        unchanged: 0,
      },
    );
    expect(legacyZone.codeSandre).toBe(feature.codeSandre);
    expect(state.needsRecompute).toBe(false);
    expect(harness.runCurrentZoneComputeWorker).not.toHaveBeenCalled();
  });

  it('uses first-commit-wins when snapshot start times are equal', async () => {
    const state = {
      snapshotStartedAt: new Date('2026-07-31T08:00:00.000Z'),
      sourceUpdatedAt: '2026-07-01',
      latestFeaturesHash: 'latest',
      featureCount: 1,
      needsRecompute: false,
    };
    const harness = createHarness({ state });

    await expect(harness.service.updateDepartementZones('65')).resolves.toEqual(
      {
        added: 0,
        updated: 0,
        disabled: 0,
        unchanged: 1,
      },
    );
    expect(harness.zoneRepository.save).not.toHaveBeenCalled();
  });

  it('does not overlap two cron runs in the same process', async () => {
    const harness = createHarness();
    let finishSync: (value: any) => void;
    const pendingSync = new Promise((resolve) => {
      finishSync = resolve;
    });
    const updateSpy = jest
      .spyOn(harness.service, 'updateDepartementZones')
      .mockReturnValue(pendingSync as any);

    const firstRun = harness.service.updateZones();
    await new Promise((resolve) => setImmediate(resolve));
    await harness.service.updateZones();

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(harness.departementService.findAllLight).toHaveBeenCalledTimes(1);

    finishSync({
      added: 0,
      updated: 0,
      disabled: 0,
      unchanged: 0,
    });
    await firstRun;
  });

  it('continues the Sandre sync when a pending recomputation retry fails', async () => {
    const harness = createHarness({
      state: {
        needsRecompute: true,
        lastFullSyncAt: null,
      },
    });
    const updateSpy = jest
      .spyOn(harness.service, 'updateDepartementZones')
      .mockResolvedValue({
        added: 0,
        updated: 0,
        disabled: 0,
        unchanged: 0,
      });
    jest
      .spyOn(harness.service as any, 'recomputeSandreDepartment')
      .mockRejectedValue(new Error('worker unavailable'));

    await harness.service.updateZones();

    expect(updateSpy).toHaveBeenCalledWith('65');
  });

  it('retries a blocked department on the next cron instead of waiting a day', async () => {
    const harness = createHarness({
      state: {
        needsRecompute: false,
        lastObservedAt: new Date(),
        blockedAt: new Date(Date.now() - 6 * 60 * 1000),
      },
    });
    const updateSpy = jest
      .spyOn(harness.service, 'updateDepartementZones')
      .mockResolvedValue({
        added: 0,
        updated: 0,
        disabled: 0,
        unchanged: 0,
      });

    await harness.service.updateZones();

    expect(updateSpy).toHaveBeenCalledWith('65');
    expect(harness.httpService.get).not.toHaveBeenCalled();
  });

  it('applies a fresh audit observation immediately after switching to safe', async () => {
    const harness = createHarness({
      state: {
        needsRecompute: false,
        lastObservedAt: new Date(),
        lastAppliedAt: null,
        observedSnapshotHash: 'same',
        appliedSnapshotHash: 'same',
        observedSourceUpdatedAt: '2026-08-01',
        appliedSourceUpdatedAt: '2026-08-01',
      },
    });
    const changeSpy = jest
      .spyOn(harness.service as any, 'hasSandreChanges')
      .mockResolvedValue(false);
    const updateSpy = jest
      .spyOn(harness.service, 'updateDepartementZones')
      .mockResolvedValue({
        added: 0,
        updated: 0,
        disabled: 0,
        unchanged: 1,
      });

    await harness.service.updateZones();

    expect(updateSpy).toHaveBeenCalledWith('65');
    expect(changeSpy).not.toHaveBeenCalled();
  });

  it.each([
    {
      difference: 'snapshot hash',
      observedSnapshotHash: 'observed',
      appliedSnapshotHash: 'applied',
      observedSourceUpdatedAt: '2026-08-01',
      appliedSourceUpdatedAt: '2026-08-01',
    },
    {
      difference: 'source date',
      observedSnapshotHash: 'same',
      appliedSnapshotHash: 'same',
      observedSourceUpdatedAt: '2026-08-01',
      appliedSourceUpdatedAt: '2026-07-31',
    },
  ])(
    'retries a fresh pending $difference immediately in safe mode',
    async (state) => {
      const harness = createHarness({
        state: {
          ...state,
          needsRecompute: false,
          lastObservedAt: new Date(),
          lastAppliedAt: new Date(),
        },
      });
      const changeSpy = jest
        .spyOn(harness.service as any, 'hasSandreChanges')
        .mockResolvedValue(false);
      const updateSpy = jest
        .spyOn(harness.service, 'updateDepartementZones')
        .mockResolvedValue({
          added: 0,
          updated: 0,
          disabled: 0,
          unchanged: 1,
        });

      await harness.service.updateZones();

      expect(updateSpy).toHaveBeenCalledWith('65');
      expect(changeSpy).not.toHaveBeenCalled();
    },
  );

  it('does not apply a pending observation while still in audit mode', async () => {
    const harness = createHarness({
      syncMode: 'audit',
      state: {
        needsRecompute: false,
        lastObservedAt: new Date(),
        lastAppliedAt: null,
        observedSnapshotHash: 'observed',
        appliedSnapshotHash: null,
        observedSourceUpdatedAt: '2026-08-01',
        appliedSourceUpdatedAt: null,
      },
    });
    jest
      .spyOn(harness.service as any, 'hasSandreChanges')
      .mockResolvedValue(false);
    const updateSpy = jest.spyOn(harness.service, 'updateDepartementZones');

    await harness.service.updateZones();

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('does not force an already applied fresh snapshot in safe mode', async () => {
    const harness = createHarness({
      state: {
        needsRecompute: false,
        lastObservedAt: new Date(),
        lastAppliedAt: new Date(),
        observedSnapshotHash: 'same',
        appliedSnapshotHash: 'same',
        observedSourceUpdatedAt: '2026-08-01',
        appliedSourceUpdatedAt: '2026-08-01',
      },
    });
    jest
      .spyOn(harness.service as any, 'hasSandreChanges')
      .mockResolvedValue(false);
    const updateSpy = jest.spyOn(harness.service, 'updateDepartementZones');

    await harness.service.updateZones();

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('resets the in-process guard even when global lock cleanup fails', async () => {
    const harness = createHarness();
    jest.spyOn(harness.service, 'updateDepartementZones').mockResolvedValue({
      added: 0,
      updated: 0,
      disabled: 0,
      unchanged: 0,
    });
    jest
      .spyOn(harness.service as any, 'releaseSandreGlobalLock')
      .mockRejectedValue(new Error('unlock failed'));

    await harness.service.updateZones();
    await harness.service.updateZones();

    expect(harness.departementService.findAllLight).toHaveBeenCalledTimes(2);
  });

  it('does not write and warns once when the synchronization mode is absent', async () => {
    const harness = createHarness({ syncMode: undefined });
    const updateSpy = jest.spyOn(harness.service, 'updateDepartementZones');
    const warningSpy = jest
      .spyOn((harness.service as any).logger, 'warn')
      .mockImplementation();

    await harness.service.updateZones();
    await harness.service.updateZones();

    expect(updateSpy).not.toHaveBeenCalled();
    expect(harness.departementService.findAllLight).not.toHaveBeenCalled();
    expect(warningSpy).toHaveBeenCalledTimes(1);
  });

  it('records a stable empty department instead of retrying every ten minutes', async () => {
    const harness = createHarness({
      httpResponses: [countResponse(0), countResponse(0)],
    });

    const result = await harness.service.updateDepartementZones('65');

    expect(result).toEqual({
      added: 0,
      updated: 0,
      disabled: 0,
      unchanged: 0,
    });
    expect(harness.zoneRepository.find).not.toHaveBeenCalled();
    expect(harness.stateRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        featureCount: 0,
        sourceUpdatedAt: null,
      }),
    );
  });
});
