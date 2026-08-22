import { createHash } from 'node:crypto';
import {
  HistoricBackfillDepartmentPayloadBuilderService,
  HistoricBackfillLegacyZoneProviderService,
  HistoricBackfillMapArtifactBuilderService,
} from './historic-backfill-task-providers.service';

describe('historic backfill task providers', () => {
  const previousArtifactAcl = process.env.HISTORIC_BACKFILL_ARTIFACT_ACL;

  beforeEach(() => {
    delete process.env.HISTORIC_BACKFILL_ARTIFACT_ACL;
  });

  afterAll(() => {
    if (previousArtifactAcl === undefined) {
      delete process.env.HISTORIC_BACKFILL_ARTIFACT_ACL;
    } else {
      process.env.HISTORIC_BACKFILL_ARTIFACT_ACL = previousArtifactAcl;
    }
  });

  it('builds an empty department payload from explicit department context', async () => {
    const statisticDepartementService = {
      buildHistoricDepartmentRestriction: jest
        .fn()
        .mockResolvedValue({ date: '2026-08-01', restrictions: [] }),
    };
    const service = new HistoricBackfillDepartmentPayloadBuilderService(
      statisticDepartementService as any,
    );

    await expect(
      service.build([], '2026-08-01', false, {
        departementId: 77,
        departementCode: '77',
      }),
    ).resolves.toEqual({
      restriction: { date: '2026-08-01', restrictions: [] },
      situation: { max: null, sup: null, sou: null, aep: null },
    });
    expect(
      statisticDepartementService.buildHistoricDepartmentRestriction,
    ).toHaveBeenCalledWith([], {
      date: '2026-08-01',
      departementId: 77,
      departementCode: '77',
      historicNotComputed: false,
    });
  });

  it('keeps the legacy AEP situation null', async () => {
    const service = new HistoricBackfillDepartmentPayloadBuilderService({
      buildHistoricDepartmentRestriction: jest.fn().mockResolvedValue({}),
    } as any);
    const zones = [
      {
        type: 'AEP',
        restrictions: [{ niveauGravite: 'crise' }],
      },
      {
        type: 'SUP',
        restrictions: [{ niveauGravite: 'alerte' }],
      },
    ];

    await expect(
      service.build(zones as any, '2023-01-01', true, {
        departementId: 1,
        departementCode: '01',
      }),
    ).resolves.toEqual({
      restriction: {},
      situation: { max: 'crise', sup: 'alerte', sou: null, aep: null },
    });
  });

  it('uploads a deterministic department GeoJSON object', async () => {
    const collection = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { id: 1 } }],
    };
    const historicZoneService = {
      buildHistoricDepartmentFeatureCollection: jest
        .fn()
        .mockResolvedValue(collection),
    };
    const s3Service = { uploadFile: jest.fn().mockResolvedValue({}) };
    const service = new HistoricBackfillMapArtifactBuilderService(
      historicZoneService as any,
      s3Service as any,
    );

    const signal = new AbortController().signal;
    const artifactClaim = {
      runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sourceRevision: '42',
      departmentLastPublicRevision: '41',
      historicComputeEpoch: '9',
      departmentGeneration: '7',
      departementCode: '77',
    };
    const result = await service.buildAndUpload(
      [],
      artifactClaim as any,
      '2026-08-01',
      '2026-08-03',
      false,
      { signal },
    );
    const checksum = createHash('sha256')
      .update(Buffer.from(JSON.stringify(collection)))
      .digest('hex');

    expect(result).toEqual({
      objectKey:
        'historic-backfill/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/' +
        'departments/department-revision-41/epoch-9/generation-7/77/' +
        `2026-08-01-${checksum}.geojson`,
      checksum,
      featureCount: 1,
    });
    expect(s3Service.uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        originalname: result.objectKey,
        mimetype: 'application/geo+json',
        buffer: expect.any(Buffer),
      }),
      '',
      { abortSignal: signal, acl: 'public-read' },
    );

    const globallyRebased = await service.buildAndUpload(
      [],
      { ...artifactClaim, sourceRevision: '43' } as any,
      '2026-08-01',
      '2026-08-03',
      false,
      { signal },
    );
    const locallyRevised = await service.buildAndUpload(
      [],
      { ...artifactClaim, departmentLastPublicRevision: '42' } as any,
      '2026-08-01',
      '2026-08-03',
      false,
      { signal },
    );
    const regenerated = await service.buildAndUpload(
      [],
      { ...artifactClaim, departmentGeneration: '8' } as any,
      '2026-08-01',
      '2026-08-03',
      false,
      { signal },
    );

    expect(globallyRebased.objectKey).toBe(result.objectKey);
    expect(locallyRevised.objectKey).not.toBe(result.objectKey);
    expect(regenerated.objectKey).not.toBe(result.objectKey);
  });

  it('uploads department staging artifacts with the configured private ACL', async () => {
    process.env.HISTORIC_BACKFILL_ARTIFACT_ACL = 'private';
    const historicZoneService = {
      buildHistoricDepartmentFeatureCollection: jest.fn().mockResolvedValue({
        type: 'FeatureCollection',
        features: [],
      }),
    };
    const s3Service = { uploadFile: jest.fn().mockResolvedValue({}) };
    const service = new HistoricBackfillMapArtifactBuilderService(
      historicZoneService as any,
      s3Service as any,
    );
    const signal = new AbortController().signal;

    await service.buildAndUpload(
      [],
      {
        runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        departmentLastPublicRevision: '41',
        historicComputeEpoch: '9',
        departmentGeneration: '7',
        departementCode: '77',
      },
      '2026-08-01',
      '2026-08-03',
      false,
      { signal },
    );

    expect(s3Service.uploadFile).toHaveBeenCalledWith(expect.any(Object), '', {
      abortSignal: signal,
      acl: 'private',
    });
  });

  it('delegates legacy materialization to the historic zone service', async () => {
    const historicZoneService = {
      findLegacyHistoricDepartmentZones: jest.fn().mockResolvedValue([]),
    };
    const service = new HistoricBackfillLegacyZoneProviderService(
      historicZoneService as any,
    );

    await expect(
      service.computeAndFindZones({ code: '77' } as any, '2023-01-01', {
        signal: new AbortController().signal,
      } as any),
    ).resolves.toEqual([]);
    expect(
      historicZoneService.findLegacyHistoricDepartmentZones,
    ).toHaveBeenCalledWith('77', '2023-01-01');
  });
});
