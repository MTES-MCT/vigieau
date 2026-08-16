import { BassinVersant } from '@shared/entities/bassin_versant.entity';
import { Departement } from '@shared/entities/departement.entity';
import { SandreZoneAlias } from '@shared/entities/sandre_zone_alias.entity';
import { SandreZoneSyncState } from '@shared/entities/sandre_zone_sync_state.entity';
import { ZoneAlerte } from '@shared/entities/zone_alerte.entity';
import { of } from 'rxjs';
import { getMetadataArgsStorage } from 'typeorm';
import * as approvedReferences from './sandre-zone-sync-approved-references';
import * as syncApprovals from './sandre-zone-sync-approvals';
import {
  fetchSandreMdmZoneRecordEvidence,
  SANDRE_MDM_PROOF_TIMEOUT_MS,
  SandreMdmProofBudget,
  SandreMdmProofDeadlineExceededError,
  SandreMdmTransientError,
} from './sandre-mdm-evidence';
import { fingerprint } from './sandre-zone-reconciliation';
import { createSandreZoneSnapshot } from './sandre-zone-sync';
import { ZoneAlerteService } from './zone_alerte.service';

describe('ZoneAlerteService Sandre synchronization', () => {
  const department = { id: 65, code: '65' };
  const basin = { id: 7, code: 7 };
  const mdmBudget = (remainingMs = 30_000): SandreMdmProofBudget => ({
    expiresAt: remainingMs,
    signal: new AbortController().signal,
    remainingMs: jest.fn(() => remainingMs),
    assertRemaining: jest.fn(() => remainingMs),
  });
  const mdmApproval = () => ({
    approvalId: 'test-mdm-proof',
    mdmRecords: ['355', '3947', '3948'].map((codeSandre) => ({
      codeSandre,
      projectionSha256: '0'.repeat(64),
      requiredEvolution: null,
    })),
    mdmNomenclature: {
      nid: '282836',
      nomenclatureCode: '590',
      title: 'Creation',
      code: '7',
      mnemonic: 'Creation',
      projectionSha256: '0'.repeat(64),
    },
  });
  const mdmRecordProjection = (codeSandre: string) => ({
    nid: `nid-${codeSandre}`,
    title: `[${codeSandre}] Test zone`,
    changed: '1',
    code: [{ value: codeSandre }],
    status: [{ nid: '6513' }],
    evolutionTypes: [],
    evolutionDates: [],
    evolutionComments: [],
    undergoes: [],
    alternate: [],
    dateCreated: [],
    dateUpdated: [],
  });
  const mdmRecordBody = (projection: ReturnType<typeof mdmRecordProjection>) =>
    JSON.stringify({
      nid: projection.nid,
      title: projection.title,
      changed: projection.changed,
      field_zas_cdzas: projection.code,
      field_zas_statutzas: projection.status,
      field_zas_typeevolution: projection.evolutionTypes,
      field_zas_dateevolution: projection.evolutionDates,
      field_zas_comevolution: projection.evolutionComments,
      field_zas_subitevolution: projection.undergoes,
      field_zas_codealternatif: projection.alternate,
      field_zas_datecreazas: projection.dateCreated,
      field_zas_datemajzas: projection.dateUpdated,
    });
  const mdmNomenclatureProjection = {
    nid: '282836',
    nomenclatureCode: '590',
    title: 'Creation',
    code: '7',
    mnemonic: 'Creation',
  };
  const mdmNomenclatureBody = `
    <article id="node-282836" class="node-nsa_590">
      <h2>Creation</h2>
      <div class="field">
        <div class="field-label">CdElement:</div>
        <div class="field-item">7</div>
      </div>
      <div class="field">
        <div class="field-label">MnElement:</div>
        <div class="field-item">Creation</div>
      </div>
    </article>
  `;
  const exactMdmApproval = () => ({
    approvalId: 'test-exact-mdm-proof',
    mdmRecords: ['355', '3947', '3948'].map((codeSandre) => ({
      codeSandre,
      projectionSha256: fingerprint(mdmRecordProjection(codeSandre)),
      requiredEvolution: null,
    })),
    mdmNomenclature: {
      nid: mdmNomenclatureProjection.nid,
      nomenclatureCode: mdmNomenclatureProjection.nomenclatureCode,
      title: mdmNomenclatureProjection.title,
      code: mdmNomenclatureProjection.code,
      mnemonic: mdmNomenclatureProjection.mnemonic,
      projectionSha256: fingerprint(mdmNomenclatureProjection),
    },
  });
  const exactMdmResponse = (url: string, driftCode?: string) => {
    if (url.endsWith('/node/282836')) {
      return {
        status: 200,
        contentType: 'text/html; charset=utf-8',
        finalUrl: url,
        body: mdmNomenclatureBody,
      };
    }
    const codeSandre = url.match(/\/([^/]+)\/json$/)?.[1];
    if (!codeSandre) {
      throw new Error(`Unexpected MDM test URL ${url}`);
    }
    const projection = mdmRecordProjection(codeSandre);
    return {
      status: 200,
      contentType: 'application/json',
      finalUrl: url,
      body: mdmRecordBody(
        codeSandre === driftCode
          ? { ...projection, title: `${projection.title} drift` }
          : projection,
      ),
    };
  };

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
        'sandreProvenance',
      ]),
    );
  });

  it('never matches a local_preserved zone through canonical, alias or legacy identity', async () => {
    const preservedZone = {
      id: 4605,
      idSandre: null,
      codeSandre: null,
      sandreProvenance: 'local_preserved',
      type: 'SUP',
      departement: department,
    };
    const zoneFind = jest
      .fn()
      .mockResolvedValueOnce([preservedZone])
      .mockResolvedValueOnce([]);
    const harness = createHarness({
      zoneFind,
      aliasFind: jest.fn().mockResolvedValue({
        id: 1,
        zoneAlerte: preservedZone,
      }),
    });
    const feature = createSandreZoneSnapshot([rawFeature()], 1, department.code)
      .features[0];

    await expect(
      (harness.service as any).findSandreZoneMatch(
        harness.manager,
        department,
        feature,
      ),
    ).resolves.toBeNull();
    expect(
      harness.aliasRepository.findOne.mock.calls[0][0].where.zoneAlerte,
    ).toBeDefined();
  });

  const createHarness = (options?: {
    httpResponses?: any[];
    state?: any;
    zoneFind?: jest.Mock;
    aliasFind?: jest.Mock;
    basin?: any;
    basinFind?: jest.Mock;
    basinMappings?: Record<number, { localBasinCode: number; source: string }>;
    recomputeResult?: any;
    syncMode?: string;
    forceFullAuditAfter?: string;
    rolloutAuditRows?: Array<{
      departementId: number;
      status: 'observed' | 'blocked' | 'failed' | 'applied';
    }>;
    invalidGeometryCodes?: string[];
    referencedZoneIds?: number[];
    historicalReferencedZoneIds?: number[];
    operationalDisabledSources?: Array<{
      id: number;
      idSandre: number | null;
      codeSandre: string | null;
      type: 'SOU' | 'SUP';
    }>;
    collisionZoneIds?: number[];
    genealogyRelations?: Array<{
      id: string;
      parentCode: string;
      childCode: string;
      modificationDate: string;
      modificationType: string;
      reason: string;
    }>;
    globalLockAvailable?: boolean;
    exactAuditBatch?: Record<string, unknown> | null;
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
      find:
        options?.basinFind ??
        jest
          .fn()
          .mockResolvedValue(
            (options && 'basin' in options ? options.basin : basin)
              ? [options && 'basin' in options ? options.basin : basin]
              : [],
          ),
    };
    const repositories = new Map<any, any>([
      [ZoneAlerte, zoneRepository],
      [SandreZoneSyncState, stateRepository],
      [SandreZoneAlias, aliasRepository],
      [Departement, departmentRepository],
      [BassinVersant, basinRepository],
    ]);
    const configuredResponses = options?.httpResponses ?? [
      countResponse(1),
      {
        data: {
          features: [rawFeature()],
        },
      },
      countResponse(1),
    ];
    const exactAuditFeatures = configuredResponses.flatMap((response) =>
      Array.isArray(response?.data?.features) ? response.data.features : [],
    );
    const getExactAuditSnapshot = () =>
      createSandreZoneSnapshot(
        exactAuditFeatures,
        exactAuditFeatures.length,
        department.code,
      );
    const manager = {
      getRepository: jest.fn((entity) => repositories.get(entity)),
      query: jest.fn(async (query: string, parameters?: any[]) => {
        if (
          query.includes('FROM sandre_zone_sync_batch batch') &&
          query.includes("batch.kind = 'snapshot'") &&
          query.includes("batch.mode = 'audit'") &&
          query.includes('FOR SHARE')
        ) {
          if (options && 'exactAuditBatch' in options) {
            return options.exactAuditBatch ? [options.exactAuditBatch] : [];
          }
          const exactAuditSnapshot = getExactAuditSnapshot();
          return [
            {
              id: 'exact-audit-1',
              status: 'observed',
              snapshotHash: exactAuditSnapshot.snapshotHash,
              sourceUpdatedAt: exactAuditSnapshot.sourceUpdatedAt,
              featureCount: exactAuditSnapshot.featureCount,
            },
          ];
        }
        if (query.includes('WITH sandre_geometry_input AS')) {
          const inputs = JSON.parse(parameters?.[0] ?? '[]');
          return inputs.map((input, index) => {
            const invalid = (options?.invalidGeometryCodes ?? []).includes(
              input.code,
            );
            return {
              ordinal: index + 1,
              code: input.code,
              geometry: input.geometry,
              raw_valid: !invalid,
              invalid_reason: invalid ? 'Self-intersection' : 'Valid Geometry',
              raw_geometry_type: input.geometry.type.toUpperCase(),
              normalized_geometry_type: input.geometry.type.toUpperCase(),
              raw_parts: 1,
              normalized_parts: 1,
              raw_points: 4,
              normalized_points: 4,
              raw_area: '1',
              normalized_area: '1',
              relative_area_delta: '0',
              raw_geodesic_area: '10000000',
              normalized_geodesic_area: '10000000',
              absolute_geodesic_area_delta: '0',
              bbox_unchanged: true,
              normalized_valid: !invalid,
            };
          });
        }
        if (query.includes('FROM sandre_basin_mapping')) {
          const mapping = options?.basinMappings?.[Number(parameters?.[0])];
          return mapping ? [mapping] : [];
        }
        if (query.includes('AS "nonAbrogeArreteCadre"')) {
          const operationallyReferenced = (
            options?.referencedZoneIds ?? []
          ).includes(parameters?.[0]);
          const historicallyReferenced = (
            options?.historicalReferencedZoneIds ?? []
          ).includes(parameters?.[0]);
          const referenced = operationallyReferenced || historicallyReferenced;
          return [
            {
              arreteCadre: referenced ? 1 : 0,
              nonAbrogeArreteCadre: operationallyReferenced ? 1 : 0,
              allRestrictions: referenced ? 1 : 0,
              restrictions: 0,
              allCustomizations: 0,
              customizations: 0,
            },
          ];
        }
        if (
          query.includes('FROM zone_alerte zone') &&
          query.includes('zone.disabled = true')
        ) {
          return options?.operationalDisabledSources ?? [];
        }
        if (query.includes('AS "restrictionCollision"')) {
          const collides = (options?.collisionZoneIds ?? []).includes(
            parameters?.[0],
          );
          return [
            {
              restrictionCollision: collides,
              customizationCollision: false,
              aliasCollision: false,
            },
          ];
        }
        if (query.includes('remap_operational_sandre_zone_references')) {
          return [{ targetZoneId: parameters?.[1] }];
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
          storedState &&
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
      manager,
      createQueryRunner: jest.fn(() => queryRunner),
      getRepository: jest.fn((entity) => repositories.get(entity)),
      query: jest.fn(async (query: string, parameters?: any[]) => {
        if (
          query.includes('FROM sandre_zone_sync_batch batch') &&
          query.includes("batch.mode = 'audit'")
        ) {
          return options && 'rolloutAuditRows' in options
            ? options.rolloutAuditRows
            : [{ departementId: 65, status: 'observed' }];
        }
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
          storedState &&
          storedState?.recomputeRevision === parameters?.[1]
        ) {
          storedState.needsRecompute = false;
        }
        return [];
      }),
    };
    const responses = [...configuredResponses];
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
      get: jest.fn((key) => {
        if (key === 'SANDRE_ZONE_SYNC_MODE') {
          return options && 'syncMode' in options ? options.syncMode : 'safe';
        }
        if (key === 'SANDRE_FORCE_FULL_AUDIT_AFTER') {
          return options && 'forceFullAuditAfter' in options
            ? options.forceFullAuditAfter
            : '2020-08-02T12:00:00Z';
        }
        return undefined;
      }),
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
    const getSandreGenealogyRelations = jest
      .fn()
      .mockResolvedValue(options?.genealogyRelations ?? []);
    (service as any).getSandreGenealogyRelations = getSandreGenealogyRelations;

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
      getSandreGenealogyRelations,
      runCurrentZoneComputeWorker,
    };
  };

  it('requests the official genealogy representation explicitly', async () => {
    const csvUrl =
      'https://services.sandre.eaufrance.fr/telechargement/geo/ZAS/GenealogieZAS_millesime2024.csv';
    const metadata = `
      <root xmlns:gmd="gmd" xmlns:gco="gco">
        <gmd:CI_OnlineResource>
          <gmd:linkage><gmd:URL>${csvUrl}</gmd:URL></gmd:linkage>
          <gmd:name><gco:CharacterString>Télécharger la généalogie des zones d'alerte sécheresse</gco:CharacterString></gmd:name>
        </gmd:CI_OnlineResource>
      </root>
    `;
    const csv = [
      'id,CdZASParent,CdZASEnfant,DtGenZAS,TypGenZAS,RaisGenZAS',
      '1,OLD,NEW,2024-10-01,2,Remplacement',
    ].join('\n');
    const harness = createHarness({
      httpResponses: [{ data: metadata }, { data: csv }],
    });

    await expect(
      (harness.service as any).fetchSandreGenealogyRelations(),
    ).resolves.toEqual([
      expect.objectContaining({
        parentCode: 'OLD',
        childCode: 'NEW',
        modificationType: '2',
      }),
    ]);

    expect(harness.httpService.get).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('/formatters/xml'),
      expect.objectContaining({
        headers: {
          accept: 'application/xml,text/xml,text/csv,text/html;q=0.9',
          'accept-language': 'fr',
        },
        responseType: 'text',
      }),
    );
    expect(harness.httpService.get).toHaveBeenNthCalledWith(
      2,
      csvUrl,
      expect.objectContaining({
        headers: {
          accept: 'application/xml,text/xml,text/csv,text/html;q=0.9',
          'accept-language': 'fr',
        },
        responseType: 'text',
      }),
    );
  });

  it('fails closed when Sandre serves the default JSON metadata representation', async () => {
    const harness = createHarness({
      httpResponses: [{ data: { distributions: [] } }],
    });

    await expect(
      (harness.service as any).fetchSandreGenealogyRelations(),
    ).rejects.toThrow(
      'Expected exactly one official Sandre genealogy resource',
    );
    expect(harness.httpService.get).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500, 502, 503, 504])(
    'classifies exhausted MDM HTTP %s retries as a transient proof failure',
    async (status) => {
      const harness = createHarness({
        httpResponses: [{ status }, { status }, { status }],
      });
      const waitForRetry = jest
        .spyOn(harness.service as any, 'waitForSandreMdmRequestRetry')
        .mockResolvedValue(undefined);
      const budget = mdmBudget(1_234);
      const controller = new AbortController();

      await expect(
        (harness.service as any).fetchSandreMdmTransport(
          'https://mdm.sandre.test/id/355/json',
          'application/json',
          2 * 1024 * 1024,
          budget,
          controller.signal,
        ),
      ).rejects.toBeInstanceOf(SandreMdmTransientError);
      expect(harness.httpService.get).toHaveBeenCalledTimes(3);
      expect(waitForRetry.mock.calls.map(([attempt]) => attempt)).toEqual([
        1, 2,
      ]);
      expect(harness.httpService.get).toHaveBeenNthCalledWith(
        1,
        'https://mdm.sandre.test/id/355/json',
        expect.objectContaining({ timeout: 1_234, signal: controller.signal }),
      );
    },
  );

  it.each([501, 505])(
    'returns MDM HTTP %s to strict validation without retrying',
    async (status) => {
      const harness = createHarness({ httpResponses: [{ status }] });
      const waitForRetry = jest.spyOn(
        harness.service as any,
        'waitForSandreMdmRequestRetry',
      );
      const controller = new AbortController();

      await expect(
        fetchSandreMdmZoneRecordEvidence(
          {
            codeSandre: '355',
            projectionSha256: '0'.repeat(64),
            requiredEvolution: null,
          },
          (url) =>
            (harness.service as any).fetchSandreMdmTransport(
              url,
              'application/json',
              2 * 1024 * 1024,
              mdmBudget(),
              controller.signal,
            ),
        ),
      ).rejects.toThrow('Invalid Sandre MDM response for zone 355');
      expect(harness.httpService.get).toHaveBeenCalledTimes(1);
      expect(waitForRetry).not.toHaveBeenCalled();
    },
  );

  it('rejects a response that completes after the MDM proof deadline', async () => {
    const harness = createHarness({ httpResponses: [{ status: 200 }] });
    const budget = mdmBudget(1_234);
    (budget.assertRemaining as jest.Mock)
      .mockReturnValueOnce(1_234)
      .mockImplementationOnce(() => {
        throw new SandreMdmProofDeadlineExceededError();
      });

    await expect(
      (harness.service as any).fetchSandreMdmTransport(
        'https://mdm.sandre.test/id/355/json',
        'application/json',
        2 * 1024 * 1024,
        budget,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(SandreMdmProofDeadlineExceededError);
    expect(harness.httpService.get).toHaveBeenCalledTimes(1);
    expect(harness.httpService.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeout: 1_234 }),
    );
  });

  it('fails closed when the required MDM retry backoff exceeds the deadline', async () => {
    const harness = createHarness({ httpResponses: [{ status: 503 }] });

    await expect(
      (harness.service as any).fetchSandreMdmTransport(
        'https://mdm.sandre.test/id/355/json',
        'application/json',
        2 * 1024 * 1024,
        mdmBudget(250),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(SandreMdmProofDeadlineExceededError);
    expect(harness.httpService.get).toHaveBeenCalledTimes(1);
  });

  it('cancels an MDM request backoff when its proof attempt is aborted', async () => {
    jest.useFakeTimers();
    try {
      const harness = createHarness();
      const controller = new AbortController();
      const cancellation = new Error('proof failed elsewhere');
      const waiting = (harness.service as any).waitForSandreMdmRequestRetry(
        1,
        mdmBudget(),
        controller.signal,
      );
      const rejection = expect(waiting).rejects.toBe(cancellation);

      expect(jest.getTimerCount()).toBe(1);
      controller.abort(cancellation);
      await rejection;
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('caps proof retry backoff and fits its last wait inside the remaining budget', async () => {
    jest.useFakeTimers();
    try {
      const harness = createHarness();
      let cappedSettled = false;
      const cappedWait = (harness.service as any).waitForSandreMdmProofRetry(
        100,
        mdmBudget(15_000),
      );
      cappedWait.then(() => {
        cappedSettled = true;
      });

      await jest.advanceTimersByTimeAsync(9_999);
      expect(cappedSettled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await cappedWait;

      let finalSettled = false;
      const finalWait = (harness.service as any).waitForSandreMdmProofRetry(
        100,
        mdmBudget(4_000),
      );
      finalWait.then(() => {
        finalSettled = true;
      });
      await jest.advanceTimersByTimeAsync(3_998);
      expect(finalSettled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await finalWait;

      expect(finalSettled).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('drains slower successful siblings after a transient failure and retries only the missing resource', async () => {
    const harness = createHarness();
    const pendingResponses = new Map<
      string,
      {
        url: string;
        resolve: (response: ReturnType<typeof exactMdmResponse>) => void;
      }
    >();
    const callsByResource = new Map<string, number>();
    const transport = jest
      .spyOn(harness.service as any, 'fetchSandreMdmTransport')
      .mockImplementation(async (url: string) => {
        const resource = url.endsWith('/node/282836')
          ? '282836'
          : url.match(/\/([^/]+)\/json$/)?.[1];
        if (!resource) {
          throw new Error(`Unexpected MDM test URL ${url}`);
        }
        const call = (callsByResource.get(resource) ?? 0) + 1;
        callsByResource.set(resource, call);
        if (resource === '355') {
          if (call === 1) {
            throw new SandreMdmTransientError('HTTP 500 for 355');
          }
          return exactMdmResponse(url);
        }
        return new Promise((resolve) => {
          pendingResponses.set(resource, { url, resolve });
        });
      });
    const waitForProofRetry = jest
      .spyOn(harness.service as any, 'waitForSandreMdmProofRetry')
      .mockResolvedValue(undefined);
    const proof = (harness.service as any).fetchApprovedSandreMdmEvidence(
      exactMdmApproval(),
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(transport).toHaveBeenCalledTimes(4);
    expect(waitForProofRetry).not.toHaveBeenCalled();

    for (const resource of ['3947', '3948', '282836']) {
      const pending = pendingResponses.get(resource);
      if (!pending) {
        throw new Error(`Missing pending MDM test response for ${resource}`);
      }
      pending.resolve(exactMdmResponse(pending.url));
    }

    await expect(proof).resolves.toEqual(
      expect.objectContaining({
        zoneRecords: [
          expect.objectContaining({ codeSandre: '355' }),
          expect.objectContaining({ codeSandre: '3947' }),
          expect.objectContaining({ codeSandre: '3948' }),
        ],
      }),
    );
    expect(Object.fromEntries(callsByResource)).toEqual({
      '355': 2,
      '3947': 1,
      '3948': 1,
      '282836': 1,
    });
    expect(waitForProofRetry).toHaveBeenCalledTimes(1);
    expect(harness.queryRunner.startTransaction).not.toHaveBeenCalled();
  });

  it('lets the global deadline abort hanging siblings after a transient-first failure', async () => {
    jest.useFakeTimers();
    try {
      const harness = createHarness();
      const cancelledResources: string[] = [];
      const transport = jest
        .spyOn(harness.service as any, 'fetchSandreMdmTransport')
        .mockImplementation(async (url: string, ...args: any[]) => {
          const resource = url.endsWith('/node/282836')
            ? '282836'
            : url.match(/\/([^/]+)\/json$/)?.[1];
          if (!resource) {
            throw new Error(`Unexpected MDM test URL ${url}`);
          }
          if (resource === '355') {
            throw new SandreMdmTransientError('HTTP 500 for 355');
          }
          if (resource === '3947') {
            return exactMdmResponse(url);
          }
          const signal = args.at(-1) as AbortSignal;
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                cancelledResources.push(resource);
                reject(signal.reason);
              },
              { once: true },
            );
          });
        });
      const waitForProofRetry = jest.spyOn(
        harness.service as any,
        'waitForSandreMdmProofRetry',
      );
      const proof = (harness.service as any).fetchApprovedSandreMdmEvidence(
        exactMdmApproval(),
      );
      const rejection = expect(proof).rejects.toBeInstanceOf(
        SandreMdmProofDeadlineExceededError,
      );

      await jest.advanceTimersByTimeAsync(0);
      expect(transport).toHaveBeenCalledTimes(4);
      expect(cancelledResources).toEqual([]);
      expect(waitForProofRetry).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(SANDRE_MDM_PROOF_TIMEOUT_MS - 1);
      expect(cancelledResources).toEqual([]);
      await jest.advanceTimersByTimeAsync(1);
      await rejection;

      expect(cancelledResources.sort()).toEqual(['282836', '3948']);
      expect(waitForProofRetry).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      expect(harness.queryRunner.startTransaction).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('accumulates four strictly validated MDM resources beyond five rotating transient attempts', async () => {
    const harness = createHarness();
    const successOnCall = new Map([
      ['355', 1],
      ['3947', 2],
      ['3948', 3],
      ['282836', 7],
    ]);
    const callsByResource = new Map<string, number>();
    const transport = jest
      .spyOn(harness.service as any, 'fetchSandreMdmTransport')
      .mockImplementation(async (url: string) => {
        const resource = url.endsWith('/node/282836')
          ? '282836'
          : url.match(/\/([^/]+)\/json$/)?.[1];
        if (!resource) {
          throw new Error(`Unexpected MDM test URL ${url}`);
        }
        const call = (callsByResource.get(resource) ?? 0) + 1;
        callsByResource.set(resource, call);
        if (call < successOnCall.get(resource)!) {
          throw new SandreMdmTransientError(`HTTP 500 for ${resource}`);
        }
        return exactMdmResponse(url);
      });
    const waitForProofRetry = jest
      .spyOn(harness.service as any, 'waitForSandreMdmProofRetry')
      .mockResolvedValue(undefined);

    await expect(
      (harness.service as any).fetchApprovedSandreMdmEvidence(
        exactMdmApproval(),
      ),
    ).resolves.toEqual({
      approvalId: 'test-exact-mdm-proof',
      zoneRecords: [
        expect.objectContaining({ codeSandre: '355' }),
        expect.objectContaining({ codeSandre: '3947' }),
        expect.objectContaining({ codeSandre: '3948' }),
      ],
      nomenclature: expect.objectContaining({
        projection: mdmNomenclatureProjection,
      }),
    });

    expect(Object.fromEntries(callsByResource)).toEqual({
      '355': 1,
      '3947': 2,
      '3948': 3,
      '282836': 7,
    });
    expect(transport).toHaveBeenCalledTimes(13);
    expect(waitForProofRetry.mock.calls.map(([attempt]) => attempt)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(harness.queryRunner.startTransaction).not.toHaveBeenCalled();
  });

  it('keeps validated evidence write-once within a proof and revalidates it on the next proof', async () => {
    const harness = createHarness();
    const callsByResource = new Map<string, number>();
    jest
      .spyOn(harness.service as any, 'fetchSandreMdmTransport')
      .mockImplementation(async (url: string) => {
        const resource = url.endsWith('/node/282836')
          ? '282836'
          : url.match(/\/([^/]+)\/json$/)?.[1];
        if (!resource) {
          throw new Error(`Unexpected MDM test URL ${url}`);
        }
        const call = (callsByResource.get(resource) ?? 0) + 1;
        callsByResource.set(resource, call);
        if (resource === '3947' && call === 1) {
          throw new SandreMdmTransientError('HTTP 500 for 3947');
        }
        return exactMdmResponse(
          url,
          resource === '355' && call === 2 ? '355' : undefined,
        );
      });
    const waitForProofRetry = jest
      .spyOn(harness.service as any, 'waitForSandreMdmProofRetry')
      .mockResolvedValue(undefined);
    const approval = exactMdmApproval();

    await expect(
      (harness.service as any).fetchApprovedSandreMdmEvidence(approval),
    ).resolves.toEqual(
      expect.objectContaining({
        zoneRecords: expect.arrayContaining([
          expect.objectContaining({ codeSandre: '355' }),
        ]),
      }),
    );
    expect(callsByResource.get('355')).toBe(1);

    await expect(
      (harness.service as any).fetchApprovedSandreMdmEvidence(approval),
    ).rejects.toThrow('Sandre MDM projection changed for zone 355');
    expect(callsByResource.get('355')).toBe(2);
    expect(waitForProofRetry).toHaveBeenCalledTimes(1);
    expect(harness.queryRunner.startTransaction).not.toHaveBeenCalled();
  });

  it('aborts all non-completing MDM reads at one wall-clock proof deadline', async () => {
    jest.useFakeTimers();
    try {
      const harness = createHarness();
      const cancelledUrls: string[] = [];
      const transport = jest
        .spyOn(harness.service as any, 'fetchSandreMdmTransport')
        .mockImplementation(async (url: string, ...args: any[]) => {
          const signal = args.at(-1) as AbortSignal;
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                cancelledUrls.push(url);
                reject(signal.reason);
              },
              { once: true },
            );
          });
        });
      const proof = (harness.service as any).fetchApprovedSandreMdmEvidence(
        mdmApproval(),
      );
      const rejection = expect(proof).rejects.toBeInstanceOf(
        SandreMdmProofDeadlineExceededError,
      );

      await jest.advanceTimersByTimeAsync(0);
      expect(transport).toHaveBeenCalledTimes(4);
      expect(jest.getTimerCount()).toBe(1);

      await jest.advanceTimersByTimeAsync(SANDRE_MDM_PROOF_TIMEOUT_MS / 2);
      expect(cancelledUrls).toHaveLength(0);
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(SANDRE_MDM_PROOF_TIMEOUT_MS / 2);
      await rejection;

      expect(cancelledUrls).toHaveLength(4);
      expect(jest.getTimerCount()).toBe(0);
      expect(harness.queryRunner.startTransaction).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not retry when a transient result wins before sibling validation drift', async () => {
    const harness = createHarness();
    const transient = new SandreMdmTransientError('HTTP 500 for 355');
    let rejectTransient!: (reason: unknown) => void;
    let resolveValidation!: (response: any) => void;
    let validationUrl = '';
    const transport = jest
      .spyOn(harness.service as any, 'fetchSandreMdmTransport')
      .mockImplementation(async (url: string, ...args: any[]) => {
        if (url.endsWith('/355/json')) {
          return new Promise((_resolve, reject) => {
            rejectTransient = reject;
          });
        }
        if (url.endsWith('/3947/json')) {
          validationUrl = url;
          return new Promise((resolve) => {
            resolveValidation = resolve;
          });
        }
        const signal = args.at(-1) as AbortSignal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      });
    const waitForProofRetry = jest.spyOn(
      harness.service as any,
      'waitForSandreMdmProofRetry',
    );
    const proof = (harness.service as any).fetchApprovedSandreMdmEvidence(
      mdmApproval(),
    );
    const rejection = expect(proof).rejects.toThrow(
      'Incomplete Sandre MDM zone record',
    );

    expect(transport).toHaveBeenCalledTimes(4);
    rejectTransient(transient);
    resolveValidation({
      status: 200,
      contentType: 'application/json',
      finalUrl: validationUrl,
      body: '{}',
    });
    await rejection;

    expect(waitForProofRetry).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it('cancels sibling MDM reads when a non-transient validation fails first', async () => {
    const harness = createHarness();
    const cancelledUrls: string[] = [];
    const transport = jest
      .spyOn(harness.service as any, 'fetchSandreMdmTransport')
      .mockImplementation(async (url: string, ...args: any[]) => {
        const signal = args.at(-1) as AbortSignal;
        if (url.endsWith('/355/json')) {
          return {
            status: 302,
            contentType: 'application/json',
            finalUrl: url,
            body: '{}',
          };
        }
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              cancelledUrls.push(url);
              reject(signal.reason);
            },
            { once: true },
          );
        });
      });
    const approval = mdmApproval();

    await expect(
      (harness.service as any).fetchApprovedSandreMdmEvidenceAttempt(
        approval,
        mdmBudget(),
      ),
    ).rejects.toThrow('Invalid Sandre MDM response for zone 355');
    expect(transport).toHaveBeenCalledTimes(4);
    expect(cancelledUrls).toHaveLength(3);
    expect(harness.queryRunner.startTransaction).not.toHaveBeenCalled();
  });

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
    expect(harness.dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('"blockedAt" = NULL'),
      ['65'],
    );
    const rawMutations = [
      ...harness.dataSource.query.mock.calls,
      ...harness.manager.query.mock.calls,
    ]
      .map(([query]) => String(query))
      .filter((query) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(query));
    expect(rawMutations).not.toHaveLength(0);
    expect(
      rawMutations.every((query) =>
        /^\s*(?:INSERT INTO|UPDATE|DELETE FROM)\s+sandre_zone_sync_(?:batch|state|decision)\b/i.test(
          query,
        ),
      ),
    ).toBe(true);
    expect(harness.stateRepository.save).not.toHaveBeenCalled();
    expect(harness.aliasRepository.save).not.toHaveBeenCalled();
    expect(harness.runCurrentZoneComputeWorker).not.toHaveBeenCalled();
  });

  it('records a successful safe observation atomically with its application', async () => {
    const harness = createHarness();

    await harness.service.updateDepartementZones('65');

    const savedState = harness.stateRepository.save.mock.calls.at(-1)?.[0];
    expect(savedState).toEqual(
      expect.objectContaining({
        observedSourceUpdatedAt: '2026-07-01',
        appliedSourceUpdatedAt: '2026-07-01',
        observedFeatureCount: 1,
        appliedFeatureCount: 1,
        lastObservedAt: new Date('2026-07-31T08:00:00.000Z'),
      }),
    );
    expect(savedState?.observedSnapshotHash).toBe(
      savedState?.appliedSnapshotHash,
    );
    expect(harness.dataSource.query.mock.calls).not.toEqual(
      expect.arrayContaining([
        [expect.stringContaining('"observedSnapshotHash"'), expect.anything()],
      ]),
    );
  });

  it('binds a virtual-target audit before promoting and splitting a strict legacy source', async () => {
    const sourceGeometry = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
          [0, 0],
        ],
      ],
    };
    const targetGeometryA = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 2],
          [0, 2],
          [0, 0],
        ],
      ],
    };
    const targetGeometryB = {
      type: 'Polygon',
      coordinates: [
        [
          [1, 0],
          [2, 0],
          [2, 2],
          [1, 2],
          [1, 0],
        ],
      ],
    };
    const raw = (
      properties: Record<string, unknown>,
      geometry: Record<string, unknown>,
    ) => ({
      ...rawFeature({
        DateMajZAS: '2026-06-30',
        NumCircAdminBassin: 7,
        ...properties,
      }),
      geometry,
    });
    const snapshot = createSandreZoneSnapshot(
      [
        raw(
          { gid: 464, CdZAS: '355', StZAS: 'Gelé', LbZAS: 'Source' },
          sourceGeometry,
        ),
        raw(
          { gid: 3947, CdZAS: '3947', StZAS: 'Validé', LbZAS: 'Target A' },
          targetGeometryA,
        ),
        raw(
          { gid: 3946, CdZAS: '3948', StZAS: 'Validé', LbZAS: 'Target B' },
          targetGeometryB,
        ),
      ],
      3,
      department.code,
    );
    const sourceFeature = snapshot.features.find(
      (feature) => feature.codeSandre === '355',
    )!;
    const targetFeatures = snapshot.features.filter((feature) =>
      ['3947', '3948'].includes(feature.codeSandre),
    );
    const sourceZone = {
      id: 10582,
      idSandre: sourceFeature.gid,
      codeSandre: null,
      sandreProvenance: 'legacy_unverified',
      disabled: false,
      type: 'SUP',
      statutSandre: null,
      dateMajSandre: null,
      numeroVersionSandre: null,
      sandrePayloadHash: null,
      departement: department,
    };
    const targetZones = targetFeatures.map((feature, index) => ({
      id: 20001 + index,
      idSandre: feature.gid,
      codeSandre: feature.codeSandre,
      sandreProvenance: 'official',
      disabled: false,
      type: 'SUP',
      departement: department,
    }));
    const mapping = {
      sourceCode: '355',
      sourceZoneId: 10582,
      targetCodes: ['3947', '3948'],
      requireTopologicalEquality: false,
      effectiveDate: '2026-06-30',
      expectedGeometry: {
        sourceGeometryHash: '1'.repeat(32),
        targetGeometryHashes: ['2'.repeat(32), '3'.repeat(32)],
        unionGeometryHash: '4'.repeat(32),
        sourceCoverage: 1,
        targetCoverage: 1,
        iou: 1,
      },
      minimumGeometry: {
        sourceCoverage: 0.9999,
        targetCoverage: 0.9999,
        iou: 0.9999,
      },
    };
    const approval = {
      approvalId: 'test-approved-split',
      departmentCode: department.code,
      snapshotHash: snapshot.snapshotHash,
      sourceUpdatedAt: snapshot.sourceUpdatedAt!,
      featureCount: snapshot.featureCount,
      featureEvidenceFingerprint: '5'.repeat(64),
      expectedSourceCount: 1,
      expectedTargetCount: 2,
      mappings: [mapping],
      mdmRecords: [],
      mdmNomenclature: null,
    };
    const targetState = [0, 1].map((targetIndex) => ({
      targetIndex,
      arreteCadreIds: [],
      restrictions: [],
      customizationCount: 0,
      aliasCount: 0,
    }));
    const referenceEvidence = (lifecycle: 'pre_apply' | 'post_apply') => {
      const state =
        lifecycle === 'pre_apply'
          ? targetState
          : targetState.map((target) => ({
              ...target,
              arreteCadreIds: [700],
            }));
      const unsigned = {
        sourceZoneId: sourceZone.id,
        lifecycle,
        sourceOperationalEmpty: lifecycle === 'post_apply',
        arreteCadreLinks: [{ arreteCadreId: 700, parentStatus: 'publie' }],
        restrictions: [],
        customizationCount: 0,
        aliasCount: 0,
        targetCollisionFingerprint: fingerprint([]),
        targetStateFingerprint: fingerprint(state),
        targetState: state,
      };
      return { ...unsigned, fingerprint: fingerprint(unsigned) };
    };
    const preApplyReferences = referenceEvidence('pre_apply');
    const postApplyLineage = referenceEvidence('post_apply');
    const geometryEvidence = {
      sourceGeometryHash: mapping.expectedGeometry.sourceGeometryHash,
      targetGeometryHashes: mapping.expectedGeometry.targetGeometryHashes,
      unionGeometryHash: mapping.expectedGeometry.unionGeometryHash,
      sourceCoverage: 1,
      targetCoverage: 1,
      iou: 1,
      pairwiseOverlapRatio: 0,
      topologicallyEqual: true,
      sourceValid: true,
      targetsValid: true,
      sourceSrid: 4326,
      targetsSrid: 4326,
      sourceType: 'POLYGON',
      targetType: 'MULTIPOLYGON',
    };
    const mdmEvidence = {
      approvalId: approval.approvalId,
      zoneRecords: [],
      nomenclature: null,
    };
    const harness = createHarness();
    const geometrySpy = jest
      .spyOn(syncApprovals, 'auditSandreApprovedSyncGeometry')
      .mockResolvedValue(geometryEvidence);
    const materializedSpy = jest
      .spyOn(syncApprovals, 'assertSandreApprovedMaterializedTargets')
      .mockResolvedValue();
    const lockSpy = jest
      .spyOn(approvedReferences, 'lockSandreApprovedSyncReferences')
      .mockResolvedValue();
    const referencesSpy = jest
      .spyOn(approvedReferences, 'loadSandreApprovedReferenceEvidence')
      .mockResolvedValueOnce(preApplyReferences)
      .mockResolvedValueOnce(preApplyReferences)
      .mockResolvedValueOnce(postApplyLineage);
    const partitionSpy = jest
      .spyOn(approvedReferences, 'applySandreApprovedPartitionReferences')
      .mockResolvedValue({ applied: true });
    const inactive = [
      {
        feature: sourceFeature,
        match: { zone: sourceZone, matchType: 'legacy_gid' },
      },
    ];
    const auditTargets = new Map(
      targetFeatures.map((feature, index) => [
        feature.codeSandre,
        { ...targetZones[index], id: -1 - index },
      ]),
    );
    const auditDecisions: any[] = [];

    await (harness.service as any).reconcileApprovedSandreSnapshotMappings(
      harness.manager,
      department,
      snapshot,
      approval,
      inactive,
      auditTargets,
      auditDecisions,
      false,
      undefined,
      mdmEvidence,
    );

    expect(auditDecisions).toHaveLength(1);
    expect(auditDecisions[0]).toEqual(
      expect.objectContaining({
        candidateZoneAlerteId: null,
        outcome: 'observed',
      }),
    );
    expect(JSON.stringify(auditDecisions[0].evidence)).not.toContain(':-1');
    expect(lockSpy).not.toHaveBeenCalled();
    const audited = auditDecisions[0].evidence;
    const safeDecisions: any[] = [];

    await (harness.service as any).reconcileApprovedSandreSnapshotMappings(
      harness.manager,
      department,
      snapshot,
      approval,
      inactive,
      new Map(
        targetFeatures.map((feature, index) => [
          feature.codeSandre,
          targetZones[index],
        ]),
      ),
      safeDecisions,
      true,
      {
        batchId: 'audit-1',
        decisions: new Map([['355:approved-snapshot', audited]]),
      },
      mdmEvidence,
    );

    expect(sourceZone).toEqual(
      expect.objectContaining({
        idSandre: 464,
        codeSandre: '355',
        sandreProvenance: 'official',
      }),
    );
    expect(materializedSpy).toHaveBeenCalledWith(
      harness.manager,
      department.id,
      expect.arrayContaining([
        expect.objectContaining({ zoneAlerteId: 20001 }),
        expect.objectContaining({ zoneAlerteId: 20002 }),
      ]),
    );
    expect(partitionSpy).toHaveBeenCalledWith(
      harness.manager,
      preApplyReferences,
      [
        { codeSandre: '3947', zoneAlerteId: 20001 },
        { codeSandre: '3948', zoneAlerteId: 20002 },
      ],
      '2026-06-30',
    );
    expect(safeDecisions[0].evidence.migrationLineage).toEqual(
      postApplyLineage,
    );
    expect(referencesSpy).toHaveBeenCalledTimes(3);

    materializedSpy.mockRejectedValueOnce(
      new Error('Approved Sandre materialized target geometry changed'),
    );
    await expect(
      (harness.service as any).reconcileApprovedSandreSnapshotMappings(
        harness.manager,
        department,
        snapshot,
        approval,
        [
          {
            feature: sourceFeature,
            match: { zone: sourceZone, matchType: 'canonical' },
          },
        ],
        new Map(
          targetFeatures.map((feature, index) => [
            feature.codeSandre,
            targetZones[index],
          ]),
        ),
        [],
        true,
        {
          batchId: 'audit-1',
          decisions: new Map([['355:approved-snapshot', audited]]),
        },
        mdmEvidence,
      ),
    ).rejects.toThrow('materialized target geometry changed');
    expect(partitionSpy).toHaveBeenCalledTimes(1);
    expect(geometrySpy).toHaveBeenCalledTimes(2);
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

  it('reports stale or missing genealogy for a newer frozen zone without a successor', async () => {
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
      'GENEALOGY_STALE_OR_MISSING',
    );

    expect(harness.queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(harness.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(harness.dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('"blockedSnapshotHash"'),
      expect.any(Array),
    );
    const decisionCall = harness.dataSource.query.mock.calls.find(([query]) =>
      query.includes('INSERT INTO sandre_zone_sync_decision'),
    );
    expect(decisionCall?.[1]?.[2]).toContain('GENEALOGY_STALE_OR_MISSING');
  });

  it.each(['audit', 'safe'])(
    'blocks a conflicting frozen alias consistently in %s mode',
    async (syncMode) => {
      const activeFeature = rawFeature({ gid: 3201, CdZAS: 'NEW' });
      const frozenFeature = rawFeature({
        gid: 1380,
        CdZAS: 'OLD_ALIAS',
        LbZAS: 'Zone historique',
        StZAS: 'Gelé',
      });
      const activeZone = {
        id: 201,
        idSandre: 3201,
        codeSandre: 'NEW',
        disabled: false,
        type: 'SUP',
        departement: department,
        bassinVersant: basin,
      };
      const conflictingFrozenZone = {
        id: 102,
        idSandre: 1380,
        codeSandre: 'OTHER_CANONICAL_CODE',
        disabled: true,
        type: 'SUP',
        departement: department,
        bassinVersant: basin,
      };
      const harness = createHarness({
        syncMode,
        httpResponses: [
          countResponse(2),
          { data: { features: [activeFeature, frozenFeature] } },
          countResponse(2),
        ],
        zoneFind: jest
          .fn()
          .mockResolvedValueOnce([activeZone])
          .mockResolvedValueOnce([]),
        aliasFind: jest.fn().mockResolvedValue({
          id: 10,
          zoneAlerte: conflictingFrozenZone,
        }),
        referencedZoneIds: [102],
      });

      await expect(
        harness.service.updateDepartementZones('65'),
      ).rejects.toThrow('conflicts with canonical zone identity');

      const decisionCall = harness.dataSource.query.mock.calls.find(([query]) =>
        query.includes('INSERT INTO sandre_zone_sync_decision'),
      );
      expect(decisionCall?.[1]?.[2]).toContain(
        'SOURCE_CANONICAL_IDENTITY_CONFLICT',
      );
      expect(harness.zoneRepository.save.mock.calls).not.toEqual(
        expect.arrayContaining([
          [expect.objectContaining({ id: conflictingFrozenZone.id })],
        ]),
      );
      if (syncMode === 'safe') {
        expect(harness.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(
          1,
        );
      }
      expect(harness.manager.query).not.toHaveBeenCalledWith(
        expect.stringContaining('remap_operational_sandre_zone_references'),
        expect.any(Array),
      );
    },
  );

  it.each(['audit', 'safe'])(
    'blocks an unverified frozen alias identity consistently in %s mode',
    async (syncMode) => {
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
        disabled: false,
        type: 'SUP',
        departement: department,
        bassinVersant: basin,
      };
      const unverifiedFrozenZone = {
        id: 102,
        idSandre: 9999,
        codeSandre: null,
        disabled: true,
        type: 'SUP',
        departement: department,
        bassinVersant: basin,
      };
      const harness = createHarness({
        syncMode,
        httpResponses: [
          countResponse(2),
          { data: { features: [activeFeature, frozenFeature] } },
          countResponse(2),
        ],
        zoneFind: jest
          .fn()
          .mockResolvedValueOnce([activeZone])
          .mockResolvedValueOnce([]),
        aliasFind: jest.fn().mockResolvedValue({
          id: 10,
          zoneAlerte: unverifiedFrozenZone,
        }),
        referencedZoneIds: [102],
      });

      await expect(
        harness.service.updateDepartementZones('65'),
      ).rejects.toThrow('identity is unresolved');

      const decisionCall = harness.dataSource.query.mock.calls.find(([query]) =>
        query.includes('INSERT INTO sandre_zone_sync_decision'),
      );
      expect(decisionCall?.[1]?.[2]).toContain('SOURCE_IDENTITY_UNRESOLVED');
      expect(harness.zoneRepository.save.mock.calls).not.toEqual(
        expect.arrayContaining([
          [expect.objectContaining({ id: unverifiedFrozenZone.id })],
        ]),
      );
      if (syncMode === 'safe') {
        expect(harness.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(
          1,
        );
      }
    },
  );

  it('defers an unverified historical identity without blocking safe sync', async () => {
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
      disabled: false,
      type: 'SUP',
      departement: department,
      bassinVersant: basin,
    };
    const unverifiedFrozenZone = {
      id: 102,
      idSandre: 9999,
      codeSandre: null,
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
        .mockResolvedValueOnce([]),
      aliasFind: jest.fn().mockResolvedValue({
        id: 10,
        zoneAlerte: unverifiedFrozenZone,
      }),
      historicalReferencedZoneIds: [102],
    });

    await expect(harness.service.updateDepartementZones('65')).resolves.toEqual(
      expect.objectContaining({ disabled: 1 }),
    );

    expect(unverifiedFrozenZone).toEqual(
      expect.objectContaining({
        disabled: true,
        idSandre: 9999,
        codeSandre: null,
      }),
    );
    expect(harness.aliasRepository.save).not.toHaveBeenCalled();
    const decisionCall = harness.manager.query.mock.calls.find(([query]) =>
      query.includes('INSERT INTO sandre_zone_sync_decision'),
    );
    expect(decisionCall?.[1]?.[2]).toContain('SOURCE_IDENTITY_UNRESOLVED');
    expect(decisionCall?.[1]?.[2]).toContain('"outcome":"deferred"');
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

  it('repairs operational references from an already disabled frozen zone', async () => {
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
      disabled: true,
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
      aliasFind: jest.fn().mockResolvedValue({
        id: 10,
        zoneAlerte: activeZone,
      }),
      referencedZoneIds: [102],
      operationalDisabledSources: [
        { id: 102, idSandre: 1380, codeSandre: 'OLD', type: 'SUP' },
      ],
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
      expect.any(Object),
    );

    expect(harness.aliasRepository.save).not.toHaveBeenCalled();
    expect(harness.manager.query).toHaveBeenCalledWith(
      'SELECT remap_operational_sandre_zone_references($1, $2)',
      [102, 201],
    );
    expect(harness.runCurrentZoneComputeWorker).toHaveBeenCalledWith([65]);
    expect(harness.queryRunner.commitTransaction).toHaveBeenCalledTimes(1);

    const parentLockCalls = harness.manager.query.mock.calls
      .map(([query], index) => ({ index, query }))
      .filter(({ query }) => query.includes('FOR SHARE OF parent'));
    expect(parentLockCalls).toHaveLength(2);
    expect(parentLockCalls[0].query).toContain('FROM arrete_cadre parent');
    expect(parentLockCalls[1].query).toContain(
      'FROM arrete_restriction parent',
    );
    expect(
      harness.manager.query.mock.calls[parentLockCalls[0].index][1],
    ).toEqual([[102]]);
    expect(
      harness.manager.query.mock.invocationCallOrder[parentLockCalls[1].index],
    ).toBeLessThan(harness.zoneRepository.save.mock.invocationCallOrder[0]);
  });

  it('provisions a strict successor alias without moving historical references', async () => {
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
      disabled: false,
      type: 'SUP',
      departement: department,
      bassinVersant: basin,
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
      historicalReferencedZoneIds: [102],
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
    expect(harness.manager.query).not.toHaveBeenCalledWith(
      expect.stringContaining('remap_operational_sandre_zone_references'),
      expect.any(Array),
    );
    const firstParentLockCall = harness.manager.query.mock.calls.findIndex(
      ([query]) => query.includes('FOR SHARE OF parent'),
    );
    expect(firstParentLockCall).toBeGreaterThanOrEqual(0);
    expect(
      harness.getSandreGenealogyRelations.mock.invocationCallOrder[0],
    ).toBeLessThan(
      harness.manager.query.mock.invocationCallOrder[firstParentLockCall],
    );
  });

  it('backfills a verified legacy gid before repairing its references', async () => {
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
      disabled: false,
      type: 'SUP',
      departement: department,
      bassinVersant: basin,
    };
    const frozenZone = {
      id: 102,
      idSandre: 1380,
      codeSandre: null,
      disabled: true,
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
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([frozenZone]),
      referencedZoneIds: [102],
      operationalDisabledSources: [
        { id: 102, idSandre: 1380, codeSandre: null, type: 'SUP' },
      ],
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
      expect.any(Object),
    );

    expect(harness.zoneRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 102, idSandre: 1380, codeSandre: 'OLD' }),
    );
    expect(harness.aliasRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        zoneAlerte: expect.objectContaining({ id: 201 }),
        aliasValue: 'OLD',
      }),
    );
    const sourceSaveIndex = harness.zoneRepository.save.mock.calls.findIndex(
      ([zone]) => zone.id === 102,
    );
    const repairCallIndex = harness.manager.query.mock.calls.findIndex(
      ([query]) => query.includes('remap_operational_sandre_zone_references'),
    );
    expect(sourceSaveIndex).toBeGreaterThanOrEqual(0);
    expect(repairCallIndex).toBeGreaterThanOrEqual(0);
    expect(
      harness.zoneRepository.save.mock.invocationCallOrder[sourceSaveIndex],
    ).toBeLessThan(
      harness.manager.query.mock.invocationCallOrder[repairCallIndex],
    );
  });

  it('moves an existing source alias only after strict reconciliation', async () => {
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
      disabled: false,
      type: 'SUP',
      departement: department,
      bassinVersant: basin,
    };
    const frozenZone = {
      id: 102,
      idSandre: 1380,
      codeSandre: 'OLD',
      disabled: true,
      type: 'SUP',
      departement: department,
      bassinVersant: basin,
    };
    const existingAlias = {
      id: 10,
      zoneAlerte: frozenZone,
      source: 'manual_reconciliation',
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
      aliasFind: jest.fn().mockResolvedValue(existingAlias),
      referencedZoneIds: [102],
      operationalDisabledSources: [
        { id: 102, idSandre: 1380, codeSandre: 'OLD', type: 'SUP' },
      ],
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

    await harness.service.updateDepartementZones('65');

    expect(harness.aliasRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 10,
        zoneAlerte: activeZone,
        source: 'sandre_genealogy',
      }),
    );
  });

  it('rolls back before remapping when operational references collide', async () => {
    const activeFeature = rawFeature({ gid: 3201, CdZAS: 'NEW' });
    const frozenFeature = rawFeature({
      gid: 1380,
      CdZAS: 'OLD',
      StZAS: 'Gelé',
    });
    const activeZone = {
      id: 201,
      idSandre: 3201,
      codeSandre: 'NEW',
      disabled: false,
      type: 'SUP',
      departement: department,
      bassinVersant: basin,
    };
    const frozenZone = {
      id: 102,
      idSandre: 1380,
      codeSandre: 'OLD',
      disabled: true,
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
      operationalDisabledSources: [
        { id: 102, idSandre: 1380, codeSandre: 'OLD', type: 'SUP' },
      ],
      collisionZoneIds: [102],
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

    await expect(harness.service.updateDepartementZones('65')).rejects.toThrow(
      'restriction collision',
    );

    expect(harness.aliasRepository.save).not.toHaveBeenCalled();
    expect(harness.manager.query).not.toHaveBeenCalledWith(
      expect.stringContaining('remap_operational_sandre_zone_references'),
      expect.any(Array),
    );
    expect(harness.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(harness.queryRunner.commitTransaction).not.toHaveBeenCalled();
  });

  it('audits the same strict reconciliation without remapping references', async () => {
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
      disabled: false,
      type: 'SUP',
      departement: department,
      bassinVersant: basin,
    };
    const frozenZone = {
      id: 102,
      idSandre: 1380,
      codeSandre: 'OLD',
      disabled: true,
      type: 'SUP',
      departement: department,
      bassinVersant: basin,
    };
    const harness = createHarness({
      syncMode: 'audit',
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
      operationalDisabledSources: [
        { id: 102, idSandre: 1380, codeSandre: 'OLD', type: 'SUP' },
      ],
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
      expect.objectContaining({ unchanged: 2 }),
    );

    expect(harness.zoneRepository.save).not.toHaveBeenCalled();
    expect(harness.aliasRepository.save).not.toHaveBeenCalled();
    expect(harness.manager.query).not.toHaveBeenCalledWith(
      expect.stringContaining('remap_operational_sandre_zone_references'),
      expect.any(Array),
    );
    const decisionCall = harness.dataSource.query.mock.calls.find(([query]) =>
      query.includes('INSERT INTO sandre_zone_sync_decision'),
    );
    expect(decisionCall?.[1]?.[2]).toContain('OFFICIAL_LINEAR_SUCCESSOR');
    expect(decisionCall?.[1]?.[2]).toContain('"outcome":"deferred"');
  });

  it('blocks audit when an operational disabled zone has no Sandre identity', async () => {
    const harness = createHarness({
      syncMode: 'audit',
      operationalDisabledSources: [
        { id: 501, idSandre: null, codeSandre: null, type: 'SUP' },
      ],
    });

    await expect(harness.service.updateDepartementZones('65')).rejects.toThrow(
      'no unambiguous Sandre identity',
    );

    const decisionCall = harness.dataSource.query.mock.calls.find(([query]) =>
      query.includes('INSERT INTO sandre_zone_sync_decision'),
    );
    expect(decisionCall?.[1]?.[2]).toContain('SOURCE_IDENTITY_UNRESOLVED');
    expect(harness.zoneRepository.save).not.toHaveBeenCalled();
  });

  it('locks parents of unidentified operational zones before any active-zone write', async () => {
    const activeFeature = rawFeature();
    const activeZone = {
      id: 201,
      idSandre: 3201,
      codeSandre: '3201',
      disabled: true,
      type: 'SUP',
      departement: department,
      bassinVersant: basin,
    };
    const harness = createHarness({
      zoneFind: jest.fn().mockResolvedValueOnce([activeZone]),
      operationalDisabledSources: [
        { id: 501, idSandre: null, codeSandre: null, type: 'SUP' },
      ],
      httpResponses: [
        countResponse(1),
        { data: { features: [activeFeature] } },
        countResponse(1),
      ],
    });

    await expect(harness.service.updateDepartementZones('65')).rejects.toThrow(
      'no unambiguous Sandre identity',
    );

    const parentLockCalls = harness.manager.query.mock.calls
      .map(([query], index) => ({ index, query }))
      .filter(({ query }) => query.includes('FOR SHARE OF parent'));
    expect(parentLockCalls).toHaveLength(2);
    expect(
      harness.manager.query.mock.calls[parentLockCalls[0].index][1],
    ).toEqual([[501]]);
    expect(
      harness.manager.query.mock.invocationCallOrder[parentLockCalls[1].index],
    ).toBeLessThan(harness.zoneRepository.save.mock.invocationCallOrder[0]);
    expect(harness.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it.each(['audit', 'safe'])(
    'blocks %s before domain writes when an active zone basin is unknown',
    async (syncMode) => {
      const harness = createHarness({ syncMode, basin: null });

      await expect(
        harness.service.updateDepartementZones('65'),
      ).rejects.toThrow('Expected one local basin');

      expect(harness.zoneRepository.save).not.toHaveBeenCalled();
      expect(harness.aliasRepository.save).not.toHaveBeenCalled();
      expect(harness.queryRunner.commitTransaction).not.toHaveBeenCalled();
      expect(harness.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(
        syncMode === 'safe' ? 1 : 0,
      );
      expect(harness.stateRepository.save).not.toHaveBeenCalled();
    },
  );

  it.each(['audit', 'safe'])(
    'blocks %s before domain writes when PostGIS rejects an active geometry',
    async (syncMode) => {
      const harness = createHarness({
        syncMode,
        invalidGeometryCodes: ['3201'],
      });

      await expect(
        harness.service.updateDepartementZones('65'),
      ).rejects.toThrow('Unsafe Sandre geometry normalization for zone 3201');

      expect(harness.zoneRepository.save).not.toHaveBeenCalled();
      expect(harness.aliasRepository.save).not.toHaveBeenCalled();
      expect(harness.queryRunner.commitTransaction).not.toHaveBeenCalled();
      expect(harness.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(
        syncMode === 'safe' ? 1 : 0,
      );
    },
  );

  it('does not require a basin for an explicitly frozen zone', async () => {
    const harness = createHarness({
      basin: null,
      httpResponses: [
        countResponse(1),
        { data: { features: [rawFeature({ StZAS: 'Gelé' })] } },
        countResponse(1),
      ],
    });

    await expect(harness.service.updateDepartementZones('65')).resolves.toEqual(
      {
        added: 0,
        updated: 0,
        disabled: 0,
        unchanged: 1,
      },
    );
    expect(harness.basinRepository.find).not.toHaveBeenCalled();
  });

  it('completes the full preflight before upserting the first active zone', async () => {
    const harness = createHarness({
      basinFind: jest
        .fn()
        .mockResolvedValueOnce([basin])
        .mockResolvedValueOnce([]),
      httpResponses: [
        countResponse(2),
        {
          data: {
            features: [
              rawFeature({ gid: 3201, CdZAS: '3201' }),
              rawFeature({
                gid: 3202,
                CdZAS: '3202',
                NumCircAdminBassin: 8,
              }),
            ],
          },
        },
        countResponse(2),
      ],
    });

    await expect(harness.service.updateDepartementZones('65')).rejects.toThrow(
      'Expected one local basin 8',
    );
    expect(harness.zoneRepository.save).not.toHaveBeenCalled();
  });

  it('resolves the audited official Corsica basin onto the local basin', async () => {
    const corsicaBasin = { id: 6, code: 6 };
    const harness = createHarness({
      basin: corsicaBasin,
      basinMappings: {
        12: {
          localBasinCode: 6,
          source: 'audited_official_to_local',
        },
      },
      httpResponses: [
        countResponse(1),
        {
          data: {
            features: [rawFeature({ NumCircAdminBassin: 12 })],
          },
        },
        countResponse(1),
      ],
    });

    await expect(harness.service.updateDepartementZones('65')).resolves.toEqual(
      expect.objectContaining({ added: 1 }),
    );
    expect(harness.basinRepository.find).toHaveBeenCalledWith({
      where: { code: 6 },
      order: { id: 'ASC' },
      take: 2,
    });
    expect(harness.zoneRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        bassinVersant: corsicaBasin,
        sandreProvenance: 'official',
      }),
    );
  });

  it.each(['audit', 'safe'])(
    'blocks %s before domain writes when preserving an old canonical alias would collide',
    async (syncMode) => {
      const activeZone = {
        id: 10,
        idSandre: 1,
        codeSandre: 'OLD',
        code: 'DISPLAY',
        nom: 'Ancienne zone',
        type: 'SUP',
        ressourceInfluencee: false,
        numeroVersionSandre: 1,
        disabled: false,
        departement: department,
        bassinVersant: basin,
        geom: rawFeature().geometry,
        codesAlternatifs: [],
      };
      const conflictingZone = { ...activeZone, id: 11 };
      const harness = createHarness({
        syncMode,
        httpResponses: [
          countResponse(1),
          { data: { features: [rawFeature({ CdZAS: 'NEW' })] } },
          countResponse(1),
        ],
        aliasFind: jest.fn(async ({ where }) =>
          where.aliasValue === 'NEW'
            ? { id: 20, zoneAlerte: activeZone }
            : { id: 21, zoneAlerte: conflictingZone },
        ),
      });

      await expect(
        harness.service.updateDepartementZones('65'),
      ).rejects.toThrow('Sandre alias OLD is already assigned to zone 11');
      expect(harness.zoneRepository.save).not.toHaveBeenCalled();
      expect(harness.aliasRepository.save).not.toHaveBeenCalled();
      expect(harness.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(
        syncMode === 'safe' ? 1 : 0,
      );
    },
  );

  it('accepts an old canonical alias already assigned to the matched zone', async () => {
    const activeZone = {
      id: 10,
      idSandre: 1,
      codeSandre: 'OLD',
      code: 'DISPLAY',
      nom: 'Ancienne zone',
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
        countResponse(1),
        { data: { features: [rawFeature({ CdZAS: 'NEW' })] } },
        countResponse(1),
      ],
      aliasFind: jest.fn(async () => ({ id: 20, zoneAlerte: activeZone })),
    });

    await expect(harness.service.updateDepartementZones('65')).resolves.toEqual(
      expect.objectContaining({ updated: 1 }),
    );
    expect(harness.aliasRepository.save).not.toHaveBeenCalled();
    expect(harness.zoneRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 10, codeSandre: 'NEW' }),
    );
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

  it('fails closed before the domain preflight without an exact audit', async () => {
    const harness = createHarness({ exactAuditBatch: null });

    await expect(harness.service.updateDepartementZones('65')).rejects.toThrow(
      'successful exact-snapshot audit',
    );

    expect(harness.zoneRepository.find).not.toHaveBeenCalled();
    expect(harness.zoneRepository.save).not.toHaveBeenCalled();
    expect(harness.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
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

  it('ignores a stale safe snapshot before running its domain preflight', async () => {
    const state = {
      snapshotStartedAt: new Date('2026-07-31T08:00:00.000Z'),
      observedSourceUpdatedAt: '2026-07-02',
      observedSnapshotHash: 'winning-snapshot',
      observedFeatureCount: 1,
      lastObservedAt: new Date('2026-07-31T08:00:00.000Z'),
      appliedSourceUpdatedAt: '2026-07-02',
      appliedSnapshotHash: 'winning-snapshot',
      appliedFeatureCount: 1,
      needsRecompute: false,
    };
    const harness = createHarness({
      state,
      basin: null,
      invalidGeometryCodes: ['3201'],
      exactAuditBatch: null,
    });

    await expect(harness.service.updateDepartementZones('65')).resolves.toEqual(
      {
        added: 0,
        updated: 0,
        disabled: 0,
        unchanged: 1,
      },
    );

    expect(harness.basinRepository.find).not.toHaveBeenCalled();
    expect(harness.manager.query.mock.calls).not.toEqual(
      expect.arrayContaining([
        [expect.stringContaining('ST_IsValid'), expect.anything()],
      ]),
    );
    expect(harness.zoneRepository.save).not.toHaveBeenCalled();
    expect(harness.manager.query).not.toHaveBeenCalledWith(
      expect.stringContaining("batch.mode = 'audit'"),
      expect.anything(),
    );
    expect(harness.stateRepository.save).not.toHaveBeenCalled();
    expect(state).toEqual(
      expect.objectContaining({
        observedSourceUpdatedAt: '2026-07-02',
        observedSnapshotHash: 'winning-snapshot',
        appliedSourceUpdatedAt: '2026-07-02',
        appliedSnapshotHash: 'winning-snapshot',
      }),
    );
    expect(harness.dataSource.query.mock.calls).not.toEqual(
      expect.arrayContaining([
        [expect.stringContaining('"observedSnapshotHash"'), expect.anything()],
      ]),
    );
    const batchFinish = harness.dataSource.query.mock.calls.find(
      ([query]) =>
        query.includes('UPDATE sandre_zone_sync_batch') &&
        query.includes('"finishedAt"'),
    );
    expect(batchFinish?.[1]?.[1]).toBe('observed');
    expect(harness.departementService.getAll).not.toHaveBeenCalled();
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

  it.each(['audit', 'safe'])(
    'retries a blocked department in %s mode instead of waiting a day',
    async (syncMode) => {
      const harness = createHarness({
        syncMode,
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
    },
  );

  it('forces one fresh audit after the configured rollout cutoff', async () => {
    const harness = createHarness({
      syncMode: 'audit',
      forceFullAuditAfter: '2020-08-02T12:00:00Z',
      rolloutAuditRows: [],
      state: {
        needsRecompute: false,
        lastObservedAt: new Date(),
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
        unchanged: 0,
      });

    await harness.service.updateZones();

    expect(updateSpy).toHaveBeenCalledWith('65');
    expect(changeSpy).not.toHaveBeenCalled();
  });

  it('does not repeat an audit completed after the rollout cutoff', async () => {
    const harness = createHarness({
      syncMode: 'audit',
      forceFullAuditAfter: '2020-08-02T12:00:00Z',
      rolloutAuditRows: [{ departementId: 65, status: 'observed' }],
      state: {
        needsRecompute: false,
        lastObservedAt: new Date(),
      },
    });
    jest
      .spyOn(harness.service as any, 'hasSandreChanges')
      .mockResolvedValue(false);
    const updateSpy = jest.spyOn(harness.service, 'updateDepartementZones');

    await harness.service.updateZones();

    expect(updateSpy).not.toHaveBeenCalled();
    expect(harness.dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT DISTINCT ON (batch."departementId")'),
      [new Date('2020-08-02T12:00:00Z')],
    );
  });

  it('keeps a covered blocked audit on its five-minute retry interval', async () => {
    const harness = createHarness({
      syncMode: 'audit',
      forceFullAuditAfter: '2020-08-02T12:00:00Z',
      rolloutAuditRows: [{ departementId: 65, status: 'blocked' }],
      state: {
        needsRecompute: false,
        lastObservedAt: new Date(),
        blockedAt: new Date(Date.now() - 60_000),
      },
    });
    jest
      .spyOn(harness.service as any, 'hasSandreChanges')
      .mockResolvedValue(false);
    const updateSpy = jest.spyOn(harness.service, 'updateDepartementZones');

    await harness.service.updateZones();

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it.each(['audit', 'safe'])(
    'rejects an invalid forced-audit cutoff in %s mode before contacting Sandre',
    async (syncMode) => {
      const harness = createHarness({
        syncMode,
        forceFullAuditAfter: '2026-08-02 12:00:00',
      });

      await expect(harness.service.updateZones()).rejects.toThrow(
        'SANDRE_FORCE_FULL_AUDIT_AFTER',
      );
      expect(harness.departementService.findAllLight).not.toHaveBeenCalled();
      expect(harness.httpService.get).not.toHaveBeenCalled();
    },
  );

  it.each(['audit', 'safe'])(
    'requires a forced-audit cutoff in %s mode',
    async (syncMode) => {
      const harness = createHarness({
        syncMode,
        forceFullAuditAfter: undefined,
      });

      await expect(harness.service.updateZones()).rejects.toThrow(
        'SANDRE_FORCE_FULL_AUDIT_AFTER is required',
      );
      expect(harness.departementService.findAllLight).not.toHaveBeenCalled();
      expect(harness.httpService.get).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['a newer blocked audit after an older observed audit', 'blocked'],
    ['a newer failed audit after an older observed audit', 'failed'],
    ['a non-audit application batch', 'applied'],
  ] as const)(
    'blocks safe mode nationally when the only rollout evidence is %s',
    async (_case, status) => {
      const harness = createHarness({
        rolloutAuditRows: [{ departementId: 65, status }],
        state: {
          needsRecompute: false,
          lastObservedAt: new Date(),
        },
      });
      const updateSpy = jest.spyOn(harness.service, 'updateDepartementZones');

      await harness.service.updateZones();

      expect(updateSpy).not.toHaveBeenCalled();
      expect(harness.stateRepository.findOne).not.toHaveBeenCalled();
      expect(harness.httpService.get).not.toHaveBeenCalled();
      expect(harness.dataSource.query).toHaveBeenCalledWith(
        expect.stringMatching(
          /batch\.mode = 'audit'[\s\S]*ORDER BY batch\."departementId", batch\."startedAt" DESC, batch\.id DESC/,
        ),
        [new Date('2020-08-02T12:00:00Z')],
      );
    },
  );

  it('does not let a direct safe synchronization bypass the national audit gate', async () => {
    const harness = createHarness({ rolloutAuditRows: [] });

    await expect(harness.service.updateDepartementZones('65')).rejects.toThrow(
      'safe mode requires a successful rollout audit',
    );

    expect(harness.httpService.get).not.toHaveBeenCalled();
    expect(harness.zoneRepository.save).not.toHaveBeenCalled();
    expect(harness.dataSource.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO sandre_zone_sync_batch'),
      expect.anything(),
    );
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

describe('ZoneAlerteService geometry reads', () => {
  const createService = (
    zoneRepository: Record<string, jest.Mock>,
    dataSource: { query: jest.Mock },
  ) =>
    new ZoneAlerteService(
      zoneRepository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      dataSource as any,
    );

  const createQueryBuilder = (result: unknown, resultMethod: string) => {
    const queryBuilder: Record<string, jest.Mock> = {
      select: jest.fn(),
      addSelect: jest.fn(),
      leftJoin: jest.fn(),
      where: jest.fn(),
      [resultMethod]: jest.fn().mockResolvedValue(result),
    };
    queryBuilder.select.mockReturnValue(queryBuilder);
    queryBuilder.addSelect.mockReturnValue(queryBuilder);
    queryBuilder.leftJoin.mockReturnValue(queryBuilder);
    queryBuilder.where.mockReturnValue(queryBuilder);
    return queryBuilder;
  };

  it.each([
    { label: 'absent', acIds: undefined as number[] | undefined },
    { label: 'empty', acIds: [] as number[] },
  ])(
    'does not query alert-frame communes when IDs are $label',
    async ({ acIds }) => {
      const geometryQuery = createQueryBuilder(
        { id: 12, geom: '{"type":"Polygon","coordinates":[]}' },
        'getRawOne',
      );
      const zoneRepository = {
        createQueryBuilder: jest.fn().mockReturnValue(geometryQuery),
      };
      const service = createService(zoneRepository, { query: jest.fn() });

      const zone = await service.findOne(12, acIds);

      expect(zone.arreteCadreZoneAlerteCommunes).toEqual([]);
      expect(zoneRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps the alert-frame commune lookup when IDs are provided', async () => {
    const geometryQuery = createQueryBuilder(
      { id: 12, geom: '{"type":"Polygon","coordinates":[]}' },
      'getRawOne',
    );
    const relationQuery = createQueryBuilder(
      { arreteCadreZoneAlerteCommunes: [{ id: 34 }] },
      'getOne',
    );
    const zoneRepository = {
      createQueryBuilder: jest
        .fn()
        .mockReturnValueOnce(geometryQuery)
        .mockReturnValueOnce(relationQuery),
    };
    const service = createService(zoneRepository, { query: jest.fn() });

    const zone = await service.findOne(12, [56]);

    expect(zone.arreteCadreZoneAlerteCommunes).toEqual([{ id: 34 }]);
    expect(relationQuery.leftJoin).toHaveBeenCalledWith(
      'zone_alerte.arreteCadreZoneAlerteCommunes',
      'aczac',
      'aczac.arreteCadreId IN(:...acIds)',
      { acIds: [56] },
    );
  });

  it('loads geometries in one parameterized query and indexes them by ID', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([
        { id: 2, geom: '{"type":"Polygon","coordinates":[[2]]}' },
        { id: 1, geom: '{"type":"Polygon","coordinates":[[1]]}' },
      ]),
    };
    const service = createService({} as any, dataSource);

    const geometries = await service.findGeometriesByIds([1, 2, 1]);

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
    expect(geometries.get(1)).toContain('[[1]]');
    expect(geometries.get(2)).toContain('[[2]]');
  });

  it('does not query the database for an empty geometry set', async () => {
    const dataSource = { query: jest.fn() };
    const service = createService({} as any, dataSource);

    await expect(service.findGeometriesByIds([])).resolves.toEqual(new Map());
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('fails when a requested geometry is absent', async () => {
    const dataSource = {
      query: jest
        .fn()
        .mockResolvedValue([{ id: 1, geom: '{"type":"Polygon"}' }]),
    };
    const service = createService({} as any, dataSource);

    await expect(service.findGeometriesByIds([1, 2])).rejects.toThrow(
      'Missing geometry for alert zone(s): 2',
    );
  });
});
