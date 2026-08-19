import { ZonePublicationHealthService } from './zone-publication-health.service';
import { ZONE_PUBLICATION_MATERIALIZATION_VERSION } from '../zone_publication/zone_publication.config';

describe('ZonePublicationHealthService', () => {
  const now = new Date('2026-08-03T00:30:00.000Z');

  function healthyRow(overrides: Record<string, unknown> = {}) {
    return {
      sourceRevision: '42',
      sourceUpdatedAt: '2026-08-02T23:45:00.000Z',
      stateUpdatedAt: '2026-08-02T23:50:00.000Z',
      automaticPublishingPaused: false,
      hasCandidate: false,
      candidateRequestedAt: null,
      activeStatus: 'active',
      activeSourceRevision: '42',
      activeMaterializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
      activeBusinessDate: '2026-08-03',
      legacyPromotedAt: '2026-08-03T00:00:00.000Z',
      promotionError: null,
      liveInstances: 2,
      activeReadyInstances: 2,
      currentPublishedDate: '2026-08-03',
      currentSnapshot: true,
      historicPublishedThrough: '2026-08-02',
      historicDirtyFrom: null,
      historicDirtyThrough: null,
      statisticStateUpdatedAt: '2026-08-03T00:00:00.000Z',
      computeMapDate: '2026-08-02',
      computeStatsDate: '2026-08-02',
      incompleteSnapshotCount: 0,
      latestSnapshotUpdatedAt: '2026-08-03T00:00:00.000Z',
      latestPublicationProgressAt: null,
      latestCandidateHeartbeatAt: null,
      currentRunUpdatedAt: null,
      historicCursorProgressAt: null,
      certifiedCurrentRun: true,
      certifiedHistoricRun: true,
      ...overrides,
    };
  }

  function createHarness(row = healthyRow()) {
    const dataSource = {
      query: jest.fn().mockResolvedValue([row]),
    };
    const config = {
      get: jest.fn((key: string) => {
        const values: Record<string, string> = {
          ZONE_PUBLICATION_INSTANCE_LEASE_SECONDS: '30',
          ZONE_PUBLICATION_MIN_READY_INSTANCES: '2',
          ZONE_PUBLICATION_HEALTH_PROGRESS_STALE_AFTER_SECONDS: '1800',
        };
        return values[key];
      }),
    };
    const clock = {
      getHealthStatus: jest.fn().mockResolvedValue({ status: 'healthy' }),
    };
    return {
      service: new ZonePublicationHealthService(
        dataSource as any,
        config as any,
        clock as any,
      ),
      dataSource,
      config,
      clock,
    };
  }

  beforeEach(() => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.ZONE_PUBLICATION_ENABLED;
  });

  it('returns only a sanitized strict health result', async () => {
    const { service, dataSource } = createHarness();

    const result = await service.getHealthStatus(now);

    expect(result).toEqual({
      status: 'healthy',
      historicStatus: 'complete',
      serving: true,
      businessDate: '2026-08-03',
      requiredHistoricThrough: '2026-08-02',
      checks: {
        enabled: true,
        automaticPublishing: true,
        clock: true,
        activeServing: true,
        activeCurrent: true,
        candidateClear: true,
        legacyPromotion: true,
        currentStatistics: true,
        currentSnapshot: true,
        historicStatistics: true,
        historicClean: true,
        historicCursors: true,
        certifiedRun: true,
        historicRun: true,
        snapshotsComplete: true,
        recentProgress: true,
      },
    });
    const publicKeys = [
      ...Object.keys(result),
      ...Object.keys(result.checks || {}),
    ];
    expect(
      publicKeys.some((key) => /(^id$|Id$|revision|version|error)/i.test(key)),
    ).toBe(false);
    expect(JSON.stringify(result)).not.toContain(
      String(healthyRow().sourceRevision),
    );
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining(
        'instance."contentFingerprint" = active."contentFingerprint"',
      ),
      [now, 30, ZONE_PUBLICATION_MATERIALIZATION_VERSION, '2026-08-03'],
    );
    const sql = dataSource.query.mock.calls[0][0];
    expect(sql).toContain("'historicMapGeneration'");
    expect(sql).toContain("'historicStatsGeneration'");
    expect(sql).toContain('config."computeMapGeneration"::text');
    expect(sql).toContain('config."computeStatsGeneration"::text');
    expect(sql).toContain('AS "certifiedCurrentRun"');
    expect(sql).toContain('AS "certifiedHistoricRun"');
    expect(sql).toContain(
      'snapshot."sourceRevision" = source_state."revision"',
    );
    expect(sql).toContain('snapshot."snapshotDate" = $4::date');
    expect(sql).toContain(
      'snapshot."snapshotDate" BETWEEN\n                          statistic_state."historicDirtyFrom"',
    );
    expect(sql).toContain('config."computeMapUpdatedAt"');
    expect(sql).toContain('config."computeStatsUpdatedAt"');
    expect(sql).toContain('\'sourceRevision\', source_state."revision"::text');
    expect(sql).toContain(
      'publication."sourceComputedAt" AT TIME ZONE \'Europe/Paris\'',
    );
    expect(sql).toContain(
      'candidate."sourceRevision" = source_state."revision"',
    );
    expect(sql).toContain('candidate."materializationVersion" = $3');
  });

  it('uses the previous Paris civil day before the 02:00 business cutoff', async () => {
    const beforeCutoff = new Date('2026-08-02T23:30:00.000Z');
    const { service } = createHarness(
      healthyRow({
        activeBusinessDate: '2026-08-02',
        currentPublishedDate: '2026-08-02',
        historicPublishedThrough: '2026-08-01',
        computeMapDate: '2026-08-01',
        computeStatsDate: '2026-08-01',
      }),
    );

    await expect(service.getHealthStatus(beforeCutoff)).resolves.toMatchObject({
      status: 'healthy',
      businessDate: '2026-08-02',
      requiredHistoricThrough: '2026-08-01',
    });
  });

  it.each([
    { label: 'publication disabled', disable: true },
    {
      label: 'automatic publication paused',
      overrides: { automaticPublishingPaused: true },
    },
    { label: 'clock stale', clockStatus: 'stale' },
    { label: 'active source stale', overrides: { activeSourceRevision: '41' } },
    {
      label: 'old materialization',
      overrides: { activeMaterializationVersion: 2 },
    },
    {
      label: 'old active day',
      overrides: { activeBusinessDate: '2026-08-02' },
    },
    { label: 'candidate pending', overrides: { hasCandidate: true } },
    {
      label: 'legacy promotion missing',
      overrides: { legacyPromotedAt: null },
    },
    {
      label: 'current statistics stale',
      overrides: { currentPublishedDate: '2026-08-02' },
    },
    {
      label: 'current snapshot is not certified',
      overrides: { currentSnapshot: false },
    },
    {
      label: 'certified current run missing',
      overrides: { certifiedCurrentRun: false },
    },
  ])('does not report healthy when $label', async (testCase) => {
    const { service, clock } = createHarness(healthyRow(testCase.overrides));
    if (testCase.disable) {
      delete process.env.ZONE_PUBLICATION_ENABLED;
    }
    if (testCase.clockStatus) {
      clock.getHealthStatus.mockResolvedValue({
        status: testCase.clockStatus,
      });
    }

    await expect(service.getHealthStatus(now)).resolves.not.toMatchObject({
      status: 'healthy',
    });
  });

  it('keeps current health healthy after stable promotion when data.gouv failed', async () => {
    const { service } = createHarness(
      healthyRow({ promotionError: 'private data.gouv failure' }),
    );

    await expect(service.getHealthStatus(now)).resolves.toMatchObject({
      status: 'healthy',
      checks: { legacyPromotion: true },
    });
  });

  it.each([
    {
      label: 'historic statistics stale',
      overrides: { historicPublishedThrough: '2026-08-01' },
      failedCheck: 'historicStatistics',
    },
    {
      label: 'historic range dirty',
      overrides: { historicDirtyFrom: '2026-01-01' },
      failedCheck: 'historicClean',
    },
    {
      label: 'map cursor stale',
      overrides: { computeMapDate: '2026-08-01' },
      failedCheck: 'historicCursors',
    },
    {
      label: 'statistics cursor stale',
      overrides: { computeStatsDate: '2026-08-01' },
      failedCheck: 'historicCursors',
    },
    {
      label: 'historic run missing',
      overrides: { certifiedHistoricRun: false },
      failedCheck: 'historicRun',
    },
    {
      label: 'historic snapshot incomplete',
      overrides: { incompleteSnapshotCount: 1 },
      failedCheck: 'snapshotsComplete',
    },
  ])(
    'keeps current health healthy while $label',
    async ({ overrides, failedCheck }) => {
      const { service } = createHarness(healthyRow(overrides));

      const result = await service.getHealthStatus(now);

      expect(result).toMatchObject({
        status: 'healthy',
        historicStatus: 'incomplete',
        serving: true,
      });
      expect(result.checks?.certifiedRun).toBe(true);
      expect(result.checks?.[failedCheck]).toBe(false);
    },
  );

  it('returns updating only while an old active is served and progress is recent', async () => {
    const { service } = createHarness(
      healthyRow({
        activeSourceRevision: '41',
        activeBusinessDate: '2026-08-02',
        currentPublishedDate: '2026-08-02',
        historicPublishedThrough: '2026-08-01',
        computeMapDate: '2026-08-01',
        computeStatsDate: '2026-08-01',
        incompleteSnapshotCount: 1,
        latestSnapshotUpdatedAt: '2026-08-03T00:20:00.000Z',
      }),
    );

    await expect(service.getHealthStatus(now)).resolves.toMatchObject({
      status: 'updating',
      serving: true,
      checks: {
        activeCurrent: false,
        snapshotsComplete: false,
        recentProgress: true,
      },
    });
  });

  it.each([
    ['recent', '2026-08-03T00:20:00.000Z', 'updating'],
    ['stale', '2026-08-02T20:00:00.000Z', 'stale'],
  ])(
    'treats a %s cursor CAS as historic catch-up progress',
    async (_label, historicCursorProgressAt, expectedStatus) => {
      const { service } = createHarness(
        healthyRow({
          activeBusinessDate: '2026-08-02',
          sourceUpdatedAt: '2026-08-02T20:00:00.000Z',
          stateUpdatedAt: '2026-08-02T20:00:00.000Z',
          statisticStateUpdatedAt: '2026-08-02T20:00:00.000Z',
          latestSnapshotUpdatedAt: '2026-08-02T20:00:00.000Z',
          currentRunUpdatedAt: '2026-08-02T20:00:00.000Z',
          historicCursorProgressAt,
        }),
      );

      await expect(service.getHealthStatus(now)).resolves.toMatchObject({
        status: expectedStatus,
        serving: true,
        checks: { recentProgress: expectedStatus === 'updating' },
      });
    },
  );

  it.each([
    ['progress is stale', { latestSnapshotUpdatedAt: '2026-08-02T20:00:00Z' }],
    [
      'the active quorum is missing',
      { liveInstances: 1, activeReadyInstances: 1 },
    ],
    [
      'a live instance is not ready',
      { liveInstances: 3, activeReadyInstances: 2 },
    ],
    [
      'only a stuck candidate heartbeat remains fresh',
      {
        hasCandidate: true,
        candidateRequestedAt: '2026-08-02T20:00:00Z',
        latestCandidateHeartbeatAt: '2026-08-03T00:29:50Z',
      },
    ],
    [
      'the only progress timestamp is implausibly in the future',
      { latestSnapshotUpdatedAt: '2026-08-03T01:30:00Z' },
    ],
  ])('returns stale when %s', async (_label, overrides) => {
    const { service } = createHarness(
      healthyRow({
        activeSourceRevision: '41',
        activeBusinessDate: '2026-08-02',
        currentPublishedDate: '2026-08-02',
        sourceUpdatedAt: '2026-08-02T20:00:00Z',
        stateUpdatedAt: '2026-08-02T20:00:00Z',
        statisticStateUpdatedAt: '2026-08-02T20:00:00Z',
        latestSnapshotUpdatedAt: '2026-08-02T20:00:00Z',
        ...overrides,
      }),
    );

    await expect(service.getHealthStatus(now)).resolves.toMatchObject({
      status: 'stale',
    });
  });

  it('sanitizes database failures', async () => {
    const { service, dataSource } = createHarness();
    dataSource.query.mockRejectedValue(new Error('private database details'));

    const result = await service.getHealthStatus(now);

    expect(result).toEqual({
      status: 'unavailable',
      historicStatus: 'unknown',
      serving: false,
      businessDate: '2026-08-03',
      requiredHistoricThrough: '2026-08-02',
      checks: null,
    });
    expect(JSON.stringify(result)).not.toContain('private database details');
  });
});
