import { HistoricExportReadinessService } from './historic-export-readiness.service';

describe('HistoricExportReadinessService', () => {
  const scheduledFor = '2026-08-31';
  const zoneGate = {
    publicationId: 'zone-publication-1',
    sourceRevision: '168693',
    sourceComputedAt: '2026-08-31T12:00:00.000Z',
    geojsonUrl: 'https://objects.test/zones.geojson',
    geojsonChecksum: 'a'.repeat(64),
    pmtilesUrl: 'https://objects.test/zones.pmtiles',
    pmtilesChecksum: 'b'.repeat(64),
  };
  const certifiedBoundary = {
    publicationId: 'statistic-publication-1',
    mode: 'versioned',
    materializationStrategy: 'certified-history-overlay',
    schemaVersion: 1,
    protocolVersion: 1,
    statisticRevision: '120',
    currentPublishedDate: scheduledFor,
    contentFingerprint: 'c'.repeat(64),
    firstDate: '2013-01-01',
    latestDate: scheduledFor,
    dateCount: 4991,
    communeCount: 34_943,
    departmentCount: 101,
    sourceRevision: '168693',
    historicComputeEpoch: '785',
    certifiedHistoryRepairId: 'repair-1',
    artifactHistoricDirtyFrom: '2026-07-11',
    artifactHistoricDirtyThrough: '2026-08-27',
    stateRevision: '120',
    stateCurrentPublishedDate: scheduledFor,
    stateHistoricDirtyFrom: '2026-07-11',
    stateHistoricDirtyThrough: '2026-08-27',
    historicPublishedThrough: '2026-08-27',
    computeMapDate: '2026-07-11',
    computeStatsDate: '2026-07-11',
    currentHistoricComputeEpoch: '785',
    historicRecoveryMonthlyFrom: null,
    artifactCount: 3,
    liveInstances: 3,
    readyInstances: 3,
  };
  const activeRepair = {
    id: 'repair-1',
    dateFrom: '2026-07-11',
    dateThrough: '2026-08-27',
    activationKind: 'statistics-only',
    attestationId: 'attestation-1',
    currentHistoricComputeEpoch: '785',
  };

  function createHarness() {
    const dataSource = { query: jest.fn() };
    const zonePublicationService = {
      getActivePublicationGate: jest.fn().mockResolvedValue(zoneGate),
    };
    const registry = { hasSucceeded: jest.fn().mockResolvedValue(true) };
    const service = new HistoricExportReadinessService(
      dataSource as any,
      zonePublicationService as any,
      registry as any,
    );
    jest
      .spyOn(service as any, 'readStatisticBoundary')
      .mockResolvedValue({ ...certifiedBoundary });
    jest
      .spyOn(service as any, 'readActiveCertifiedRepair')
      .mockResolvedValue({ ...activeRepair });
    jest
      .spyOn(service as any, 'countMissingPostRepairSnapshots')
      .mockResolvedValue(0);
    jest.spyOn(service as any, 'hasPromotionFailure').mockResolvedValue(false);
    return { service, dataSource, zonePublicationService, registry };
  }

  it('accepts a certified overlay without requiring a historic catch-up run', async () => {
    const harness = createHarness();

    await expect(harness.service.evaluate(scheduledFor)).resolves.toEqual({
      status: 'ready',
      scheduledFor,
      identity: expect.objectContaining({
        publicationMode: 'versioned',
        publicationId: 'zone-publication-1',
        statisticCachePublicationId: 'statistic-publication-1',
        historicReadinessMode: 'certified-repair',
        certifiedHistoryRepairId: 'repair-1',
        certifiedHistoryRepairAttestationId: 'attestation-1',
        historicFirstDate: '2013-01-01',
        historicLatestDate: scheduledFor,
        historicDateCount: 4991,
      }),
    });
    expect(harness.registry.hasSucceeded).toHaveBeenCalledWith(
      'compute:national-daily',
      scheduledFor,
      { sourceRevision: '168693', materializationVersion: 4 },
    );
    expect(harness.registry.hasSucceeded).not.toHaveBeenCalledWith(
      'compute:historic-catchup',
      expect.anything(),
      expect.anything(),
    );
  });

  it('fails closed for a sparse current-only artifact', async () => {
    const harness = createHarness();
    (harness.service as any).readStatisticBoundary.mockResolvedValue({
      ...certifiedBoundary,
      materializationStrategy: 'sparse-current',
      firstDate: scheduledFor,
      dateCount: 1,
      certifiedHistoryRepairId: null,
    });

    await expect(harness.service.evaluate(scheduledFor)).resolves.toMatchObject(
      {
        status: 'blocked',
        blocker: 'sparse_statistic_cache',
      },
    );
  });

  it('fails closed when the canonical repair view has no active row', async () => {
    const harness = createHarness();
    (harness.service as any).readActiveCertifiedRepair.mockResolvedValue(null);

    await expect(harness.service.evaluate(scheduledFor)).resolves.toMatchObject(
      {
        status: 'blocked',
        blocker: 'certified_repair_not_active',
      },
    );
  });

  it('rejects missing post-repair snapshots', async () => {
    const missing = createHarness();
    (missing.service as any).countMissingPostRepairSnapshots.mockResolvedValue(
      2,
    );
    await expect(missing.service.evaluate(scheduledFor)).resolves.toMatchObject(
      {
        status: 'blocked',
        blocker: 'post_repair_snapshot_missing',
        details: { missingSnapshotCount: 2 },
      },
    );
  });

  it('checks the current snapshot even when the certified range ends today', async () => {
    const harness = createHarness();
    (harness.service as any).countMissingPostRepairSnapshots.mockRestore();
    harness.dataSource.query.mockResolvedValueOnce([
      { missingSnapshotCount: '1' },
    ]);

    await expect(
      (harness.service as any).countMissingPostRepairSnapshots(
        scheduledFor,
        scheduledFor,
        '168693',
      ),
    ).resolves.toBe(1);

    const [sql, parameters] = harness.dataSource.query.mock.calls[0];
    expect(sql).toContain('UNION');
    expect(sql).toContain('SELECT $2::date AS "snapshotDate"');
    expect(sql).toContain('snapshot."scope" = \'national\'');
    expect(parameters).toEqual([scheduledFor, scheduledFor, '168693', 34_943]);
  });

  it('accepts a complete clean historic boundary', async () => {
    const harness = createHarness();
    (harness.service as any).readStatisticBoundary.mockResolvedValue({
      ...certifiedBoundary,
      materializationStrategy: 'full-clean',
      certifiedHistoryRepairId: null,
      artifactHistoricDirtyFrom: null,
      artifactHistoricDirtyThrough: null,
      stateHistoricDirtyFrom: null,
      stateHistoricDirtyThrough: null,
      historicPublishedThrough: '2026-08-30',
      computeMapDate: '2026-08-30',
      computeStatsDate: '2026-08-30',
    });

    await expect(harness.service.evaluate(scheduledFor)).resolves.toMatchObject(
      {
        status: 'ready',
        identity: { historicReadinessMode: 'clean' },
      },
    );
    expect(
      (harness.service as any).readActiveCertifiedRepair,
    ).not.toHaveBeenCalled();
  });

  it('reports a structured promotion retry and pins the full identity', async () => {
    const blocked = createHarness();
    blocked.zonePublicationService.getActivePublicationGate.mockResolvedValue(
      null,
    );
    (blocked.service as any).hasPromotionFailure.mockResolvedValue(true);
    await expect(blocked.service.evaluate(scheduledFor)).resolves.toEqual({
      status: 'blocked',
      scheduledFor,
      blocker: 'zone_publication_promotion_retry',
    });

    const changed = createHarness();
    const ready = await changed.service.evaluate(scheduledFor);
    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') return;
    changed.zonePublicationService.getActivePublicationGate.mockResolvedValue({
      ...zoneGate,
      publicationId: 'zone-publication-2',
    });
    await expect(changed.service.assertReady(ready.identity)).rejects.toThrow(
      'Historic export boundary changed',
    );
  });

  it('reports a stable blocking age for bounded health polling', async () => {
    const harness = createHarness();
    harness.zonePublicationService.getActivePublicationGate.mockResolvedValue(
      null,
    );
    jest
      .spyOn(harness.service as any, 'readBlockingSince')
      .mockResolvedValue(new Date('2026-08-31T12:00:00.000Z'));

    await expect(
      harness.service.getHealthStatus(
        scheduledFor,
        new Date('2026-08-31T12:10:00.000Z'),
      ),
    ).resolves.toEqual({
      status: 'blocked',
      scheduledFor,
      blocker: 'zone_publication_not_ready',
      observedAt: '2026-08-31T12:10:00.000Z',
      blockingSince: '2026-08-31T12:00:00.000Z',
      blockingAgeSeconds: 600,
    });
  });
});
