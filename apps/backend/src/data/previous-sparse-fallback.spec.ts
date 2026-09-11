import { DataService } from './data.service';
import { StatisticCacheArtifactPayload } from './statistic-cache-artifact.service';

describe('read-only previous sparse fallback after historical revocation', () => {
  const previousEnvironment = { ...process.env };
  const activeId = '00000000-0000-4000-8000-000000000168';
  const previousId = '00000000-0000-4000-8000-000000000167';
  const repairId = '00000000-0000-4000-8000-000000000130';
  const state = {
    revision: '168',
    activePublicationId: 'zones',
    statisticCachePublicationId: activeId,
    statisticCacheCandidatePublicationId: null,
    currentPublishedDate: '2026-09-11',
    historicPublishedThrough: '2026-07-09',
    historicDirtyFrom: '2026-07-11',
    historicDirtyThrough: '2026-08-31',
    historicMapCursor: '2026-07-09',
    historicStatsCursor: '2026-07-09',
    historicComputeEpoch: '859',
    sourceRevision: '44',
  };
  const references = {
    departements: Array.from({ length: 101 }, (_, i) => ({
      code: String(i + 1),
    })),
    regions: [],
    bassinsVersants: [],
    fullArea: 101,
    metropoleArea: 101,
  };
  let service: DataService;
  let artifactService: {
    loadActive: jest.Mock;
    loadSparseFallback: jest.Mock;
    materialize: jest.Mock;
  };
  let sparse: StatisticCacheArtifactPayload;
  let overlay: StatisticCacheArtifactPayload;
  let preload: jest.SpyInstance;

  function fingerprint(payload: StatisticCacheArtifactPayload): void {
    payload.identity.dateCount = payload.dataArea.length;
    payload.identity.areaCount = payload.dataArea.length;
    payload.identity.firstDate = payload.dataArea[0].date;
    payload.identity.latestDate = payload.dataArea.at(-1).date;
    payload.identity.contentFingerprint = (
      service as any
    ).computeStatisticCacheFingerprint({
      revision: payload.identity.statisticRevision,
      mode: payload.identity.mode,
      publicationState: {
        currentPublishedDate: payload.identity.currentPublishedDate,
      },
      dateCount: payload.identity.dateCount,
      departmentCount: 101,
      communeCount: 1,
      dataArea: payload.dataArea,
      dataDepartement: payload.dataDepartement,
      dataCommune: payload.dataCommune,
    });
  }

  beforeEach(() => {
    process.env.STATISTIC_CACHE_ARTIFACT_MODE = 'read-write';
    process.env.STATISTIC_CACHE_DISTRIBUTED_REFRESH_ENABLED = 'true';
    artifactService = {
      loadActive: jest.fn(),
      loadSparseFallback: jest.fn(),
      materialize: jest.fn(),
    };
    service = new DataService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      artifactService as any,
    );
    service['referenceDataCache'] = references as any;
    jest
      .spyOn(service as any, 'ensureReferenceDataCache')
      .mockResolvedValue(references);
    preload = jest
      .spyOn(service as any, 'startCandidateDataPreload')
      .mockImplementation();
    sparse = {
      identity: {
        id: previousId,
        statisticRevision: '167',
        protocolVersion: 1,
        currentPublishedDate: state.currentPublishedDate,
        mode: 'versioned',
        materializationStrategy: 'sparse-current',
        historicDirtyFrom: state.historicDirtyFrom,
        historicDirtyThrough: state.historicDirtyThrough,
        historicMapCursor: state.historicMapCursor,
        historicStatsCursor: state.historicStatsCursor,
        historicComputeEpoch: '856',
        sourceRevision: '42',
        certifiedHistoryRepairId: null,
        contentFingerprint: '',
        firstDate: '2026-07-10',
        latestDate: state.currentPublishedDate,
        dateCount: 2,
        areaCount: 2,
        departmentCount: 101,
        communeCount: 1,
        readyAt: new Date('2026-09-11T11:00:00Z'),
      },
      dataArea: ['2026-07-10', '2026-09-11'].map((date) => ({ date })),
      dataDepartement: ['2026-07-10', '2026-09-11'].map((date) => ({
        date,
        departements: references.departements,
      })),
      dataCommune: [{ code: '01001', restrictions: [{ d: '2026-09', p: 2 }] }],
      latestCommuneWeights: [['01001', 2]],
    };
    fingerprint(sparse);
    overlay = structuredClone(sparse);
    Object.assign(overlay.identity, {
      id: activeId,
      statisticRevision: '168',
      materializationStrategy: 'certified-history-overlay',
      certifiedHistoryRepairId: repairId,
    });
    // Build an actual continuous, fingerprint-valid overlay, not a mocked hydration.
    overlay.dataArea = [];
    overlay.dataDepartement = [];
    for (
      const day = new Date('2026-07-10');
      day <= new Date('2026-09-11');
      day.setUTCDate(day.getUTCDate() + 1)
    ) {
      const date = day.toISOString().slice(0, 10);
      overlay.dataArea.push({ date });
      overlay.dataDepartement.push({
        date,
        departements: references.departements,
      });
    }
    fingerprint(overlay);
    artifactService.loadActive.mockResolvedValue(overlay);
    artifactService.loadSparseFallback.mockResolvedValue(sparse);
  });

  afterEach(() => {
    for (const key of [
      'STATISTIC_CACHE_ARTIFACT_MODE',
      'STATISTIC_CACHE_DISTRIBUTED_REFRESH_ENABLED',
    ]) {
      if (previousEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnvironment[key];
    }
    jest.restoreAllMocks();
  });

  it('serves only the validated previous sparse data as degraded while current source is newer', async () => {
    const cache = await (service as any).loadArtifactBackedData(state);
    expect(cache.artifactPublicationId).toBe(previousId);
    expect(cache.dataArea).toEqual(sparse.dataArea);
    expect(cache.artifactSourceRevision).toBe('42');
    expect(cache.fingerprint).toBe(sparse.identity.contentFingerprint);
    expect(preload).toHaveBeenCalledWith(state);
    expect(artifactService.materialize).not.toHaveBeenCalled();
    expect(artifactService.loadSparseFallback).toHaveBeenCalledWith(
      state.currentPublishedDate,
    );

    service['certifiedDataCache'] = cache;
    service['publicationState'] = state;
    jest.spyOn(service as any, 'getPublicationState').mockResolvedValue(state);
    jest
      .spyOn(service as any, 'getLegacySnapshotCoverageStatus')
      .mockResolvedValue({
        incompleteSnapshotCount: 0,
        oldestIncompleteSnapshot: null,
      });
    jest
      .spyOn(service as any, 'getStatisticArtifactInstanceSummary')
      .mockResolvedValue({
        liveInstances: 3,
        readyInstances: 3,
      });
    jest
      .spyOn(service as any, 'isCurrentSnapshotCertified')
      .mockResolvedValue(false);
    const refresh = jest
      .spyOn(service as any, 'startCertifiedDataRefresh')
      .mockImplementation();
    await expect(service.getStatisticCacheStatus(true)).resolves.toMatchObject({
      status: 'degraded',
      usable: true,
      fresh: false,
      currentFresh: false,
      historicComplete: false,
      artifactPublicationId: previousId,
    });
    expect(refresh).toHaveBeenCalled();
    expect(
      service.getStatisticCacheAcknowledgement().statisticCachePublicationId,
    ).toBe(previousId);
  });

  it.each([
    [
      'another overlay',
      (p: StatisticCacheArtifactPayload) => {
        p.identity.materializationStrategy = 'certified-history-overlay';
        p.identity.certifiedHistoryRepairId = repairId;
      },
    ],
    [
      'a daily value within the dirty range',
      (p: StatisticCacheArtifactPayload) => {
        p.dataArea[0].date = '2026-08-10';
        p.dataDepartement[0].date = '2026-08-10';
      },
    ],
    [
      'a monthly value intersecting a partially dirty month',
      (p: StatisticCacheArtifactPayload) => {
        p.dataCommune[0].restrictions.push({ d: '2026-07', p: 1 });
      },
    ],
    [
      'a future monthly value',
      (p: StatisticCacheArtifactPayload) => {
        p.dataCommune[0].restrictions.push({ d: '2026-10', p: 1 });
      },
    ],
    [
      'a different current date',
      (p: StatisticCacheArtifactPayload) => {
        p.identity.currentPublishedDate = '2026-09-10';
      },
    ],
    [
      'a future source revision',
      (p: StatisticCacheArtifactPayload) => {
        p.identity.sourceRevision = '45';
      },
    ],
    [
      'a future historical epoch',
      (p: StatisticCacheArtifactPayload) => {
        p.identity.historicComputeEpoch = '860';
      },
    ],
  ])('fails closed for %s', async (_label, mutate) => {
    mutate(sparse);
    fingerprint(sparse);
    await expect(
      (service as any).loadArtifactBackedData(state),
    ).rejects.toThrow('overlay does not match');
    expect(artifactService.materialize).not.toHaveBeenCalled();
  });

  it('keeps fingerprint verification for a previous sparse payload', async () => {
    sparse.identity.contentFingerprint = '0'.repeat(64);
    await expect(
      (service as any).loadArtifactBackedData(state),
    ).rejects.toThrow('fingerprint is invalid');
  });

  it('does not invent a fallback when no previous publication exists', async () => {
    artifactService.loadSparseFallback.mockResolvedValue(null);
    await expect(
      (service as any).loadArtifactBackedData(state),
    ).rejects.toThrow('overlay does not match');
  });

  it('revalidates the fallback when the dirty interval or current source changes', async () => {
    const cache = await (service as any).loadArtifactBackedData(state);
    expect((service as any).canReuseCertifiedCache(cache, state)).toBe(true);
    const wider = { ...state, historicDirtyFrom: '2026-07-10' };
    expect((service as any).canReuseCertifiedCache(cache, wider)).toBe(false);
    expect(
      (service as any).canReuseCertifiedCache(cache, {
        ...state,
        sourceRevision: '45',
      }),
    ).toBe(false);
    await expect(
      (service as any).loadArtifactBackedData(wider),
    ).rejects.toThrow('overlay does not match');
  });

  it('can use a retained sparse artifact older than the immediate previous overlay', async () => {
    const cache = await (service as any).loadArtifactBackedData({
      ...state,
      revision: '169',
      statisticCachePublicationId: '00000000-0000-4000-8000-000000000169',
    });
    expect(cache.artifactPublicationId).toBe(previousId);
    expect(cache.revision).toBe('167');
    expect(artifactService.loadSparseFallback).toHaveBeenCalledWith(
      state.currentPublishedDate,
    );
  });

  it('cold-loads yesterday safely and switches to a newly certified publication', async () => {
    const nextDayState = { ...state, currentPublishedDate: '2026-09-12' };
    const cache = await (service as any).loadArtifactBackedData(nextDayState);
    expect(cache.artifactPublicationId).toBe(previousId);
    expect(cache.latestDate).toBe('2026-09-11');
    expect(cache.artifactIdentity.currentPublishedDate).toBe('2026-09-11');
    expect(cache.fingerprint).toBe(sparse.identity.contentFingerprint);
    expect(artifactService.loadSparseFallback).toHaveBeenCalledWith(
      '2026-09-12',
    );

    const repairedState = {
      ...nextDayState,
      revision: '170',
      statisticCachePublicationId: '00000000-0000-4000-8000-000000000170',
      certifiedHistoryRepairId: repairId,
      certifiedHistoryRepairFrom: state.historicDirtyFrom,
      certifiedHistoryRepairThrough: state.historicDirtyThrough,
      certifiedHistoryRepairSourceRunId: 'isolated-repair',
      certifiedHistoryRepairActivatedAt: '2026-09-12T08:00:00Z',
      certifiedHistoryRepairRevision: '170',
    };
    overlay.dataArea.push({ date: '2026-09-12' });
    overlay.dataDepartement.push({
      date: '2026-09-12',
      departements: references.departements,
    });
    Object.assign(overlay.identity, {
      id: repairedState.statisticCachePublicationId,
      statisticRevision: '170',
      currentPublishedDate: '2026-09-12',
      sourceRevision: state.sourceRevision,
    });
    fingerprint(overlay);
    artifactService.loadSparseFallback.mockClear();
    expect((service as any).canReuseCertifiedCache(cache, repairedState)).toBe(
      false,
    );
    const current = await (service as any).loadArtifactBackedData(
      repairedState,
    );
    expect(current.latestDate).toBe('2026-09-12');
    expect(current.artifactPublicationId).toBe(
      repairedState.statisticCachePublicationId,
    );
    expect(artifactService.loadSparseFallback).not.toHaveBeenCalled();
  });

  it('discards unsafe retained data before a failing reload, including its acknowledgement', async () => {
    service['certifiedDataCache'] = await (
      service as any
    ).loadArtifactBackedData(state);
    const wider = { ...state, historicDirtyFrom: '2026-07-10' };
    await expect(service.loadData(wider)).rejects.toThrow(
      'overlay does not match',
    );
    expect(service['certifiedDataCache']).toBeNull();
    expect(
      service.getStatisticCacheAcknowledgement().statisticCachePublicationId,
    ).toBeNull();
  });

  it.each(['areaFindByDate', 'departementFindByDate'] as const)(
    'does not serve a newly dirty cached day through %s before background refresh',
    async (method) => {
      service['certifiedDataCache'] = await (
        service as any
      ).loadArtifactBackedData(state);
      const wider = { ...state, historicDirtyFrom: '2026-07-10' };
      jest
        .spyOn(service as any, 'getPublicationState')
        .mockResolvedValue(wider);
      await expect(
        service[method]('2026-07-10', '2026-07-10'),
      ).rejects.toMatchObject({
        status: 503,
      });
      expect(service['certifiedDataCache']).toBeNull();
      expect(
        service.getStatisticCacheAcknowledgement().statisticCachePublicationId,
      ).toBeNull();
    },
  );

  it('withdraws acknowledgement when a retained monthly aggregate becomes dirty', async () => {
    service['certifiedDataCache'] = await (
      service as any
    ).loadArtifactBackedData(state);
    service['publicationState'] = {
      ...state,
      historicDirtyThrough: '2026-09-01',
    };
    expect(
      service.getStatisticCacheAcknowledgement().statisticCachePublicationId,
    ).toBeNull();
    expect(service['certifiedDataCache']).toBeNull();
  });

  it('keeps clean retained dates available when only source freshness changes', async () => {
    const cache = await (service as any).loadArtifactBackedData(state);
    service['certifiedDataCache'] = cache;
    jest.spyOn(service as any, 'getPublicationState').mockResolvedValue({
      ...state,
      sourceRevision: '45',
      currentPublishedDate: '2026-09-12',
    });
    jest
      .spyOn(service as any, 'startCertifiedDataRefresh')
      .mockImplementation();
    await expect(
      service.areaFindByDate('2026-07-10', '2026-07-10'),
    ).resolves.toEqual([expect.objectContaining({ date: '2026-07-10' })]);
    expect(service['certifiedDataCache']).toBe(cache);
  });

  it('stops using the fallback when the exact repair is reactivated', async () => {
    const cache = await (service as any).loadArtifactBackedData(state);
    const repairedState = {
      ...state,
      certifiedHistoryRepairId: repairId,
      certifiedHistoryRepairFrom: state.historicDirtyFrom,
      certifiedHistoryRepairThrough: state.historicDirtyThrough,
      certifiedHistoryRepairSourceRunId: 'isolated-repair',
      certifiedHistoryRepairActivatedAt: '2026-09-02T21:39:43Z',
      certifiedHistoryRepairRevision: '130',
    };
    expect((service as any).canReuseCertifiedCache(cache, repairedState)).toBe(
      false,
    );
    artifactService.loadSparseFallback.mockClear();
    const restored = await (service as any).loadArtifactBackedData(
      repairedState,
    );
    expect(restored.artifactPublicationId).toBe(activeId);
    expect(restored.dataArea).toHaveLength(64);
    expect(artifactService.loadSparseFallback).not.toHaveBeenCalled();
  });
});
