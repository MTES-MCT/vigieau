import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  function createController() {
    const dataSource = {
      query: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    };
    const registry = {
      getHealthStatus: jest.fn().mockResolvedValue({
        status: 'healthy',
        lastSuccessAt: '2026-08-01T06:00:00.000Z',
      }),
    };
    const clockHeartbeat = {
      getHealthStatus: jest.fn().mockResolvedValue({
        status: 'healthy',
        lastSeenAt: '2026-08-01T12:00:00.000Z',
        ageSeconds: 30,
        staleAfterSeconds: 300,
      }),
    };
    const config = {
      get: jest.fn((key: string) => {
        const values: Record<string, string> = {
          SANDRE_ZONE_SYNC_MODE: 'safe',
          SANDRE_HEALTH_STALE_AFTER_SECONDS: '108000',
          SANDRE_FORCE_FULL_AUDIT_AFTER: '2020-08-02T12:00:00Z',
          DATAGOUV_MAP_ARCHIVES_ENABLED: 'false',
        };
        return values[key];
      }),
    };
    const zonePublicationHealth = {
      getHealthStatus: jest.fn().mockResolvedValue({
        status: 'healthy',
        serving: true,
        businessDate: '2026-08-01',
        requiredHistoricThrough: '2026-07-31',
        checks: { activeCurrent: true },
      }),
    };
    return {
      controller: new HealthController(
        dataSource as any,
        registry as any,
        clockHeartbeat as any,
        config as any,
        zonePublicationHealth as any,
      ),
      dataSource,
      registry,
      clockHeartbeat,
      config,
      zonePublicationHealth,
    };
  }

  it('exposes the sanitized external publication health status', async () => {
    const { controller } = createController();

    await expect(controller.externalPublications()).resolves.toEqual({
      status: 'healthy',
      lastSuccessAt: '2026-08-01T06:00:00.000Z',
    });
  });

  it('returns healthy and updating zone publications but rejects stale ones', async () => {
    const { controller, zonePublicationHealth } = createController();

    await expect(controller.zonePublication()).resolves.toMatchObject({
      status: 'healthy',
      serving: true,
    });

    zonePublicationHealth.getHealthStatus.mockResolvedValueOnce({
      status: 'updating',
      serving: true,
      businessDate: '2026-08-01',
      requiredHistoricThrough: '2026-07-31',
      checks: { activeCurrent: false, recentProgress: true },
    });
    await expect(controller.zonePublication()).resolves.toMatchObject({
      status: 'updating',
      serving: true,
    });

    zonePublicationHealth.getHealthStatus.mockResolvedValueOnce({
      status: 'stale',
      serving: true,
      businessDate: '2026-08-01',
      requiredHistoricThrough: '2026-07-31',
      checks: { activeCurrent: false, recentProgress: false },
    });
    await expect(controller.zonePublication()).rejects.toMatchObject({
      status: 503,
      response: {
        status: 'stale',
        serving: true,
      },
    });
  });

  it('keeps probes unthrottled but throttles diagnostics', () => {
    expect(
      Reflect.getMetadata(
        'THROTTLER:SKIPdefault',
        HealthController.prototype.live,
      ),
    ).toBe(true);
    expect(
      Reflect.getMetadata(
        'THROTTLER:SKIPdefault',
        HealthController.prototype.externalPublications,
      ),
    ).not.toBe(true);
    expect(
      Reflect.getMetadata(
        'THROTTLER:SKIPdefault',
        HealthController.prototype.zonePublication,
      ),
    ).not.toBe(true);
    expect(
      Reflect.getMetadata(
        'THROTTLER:SKIPdefault',
        HealthController.prototype.clock,
      ),
    ).not.toBe(true);
  });

  it('returns a healthy clock heartbeat and rejects a stale one', async () => {
    const { controller, clockHeartbeat } = createController();

    await expect(controller.clock()).resolves.toMatchObject({
      status: 'healthy',
      ageSeconds: 30,
    });

    clockHeartbeat.getHealthStatus.mockResolvedValue({
      status: 'stale',
      lastSeenAt: '2026-08-01T11:50:00.000Z',
      ageSeconds: 600,
      staleAfterSeconds: 300,
    });
    await expect(controller.clock()).rejects.toMatchObject({ status: 503 });
  });

  it('reports only active references to disabled SANDRE zones', async () => {
    const { controller, dataSource } = createController();
    dataSource.query.mockResolvedValue([
      {
        arreteRestrictions: 0,
        arreteCadres: 0,
        customizations: 0,
      },
    ]);

    await expect(controller.sandreReferences()).resolves.toEqual({
      status: 'healthy',
      invalidReferences: {
        arreteRestrictions: 0,
        arreteCadres: 0,
        customizations: 0,
        total: 0,
      },
    });
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining("parent.statut IN ('a_venir', 'publie')"),
    );
  });

  it('returns 503 when an active parent references a disabled SANDRE zone', async () => {
    const { controller, dataSource } = createController();
    dataSource.query.mockResolvedValue([
      {
        arreteRestrictions: 1,
        arreteCadres: 2,
        customizations: 3,
      },
    ]);

    await expect(controller.sandreReferences()).rejects.toMatchObject({
      status: 503,
      response: {
        status: 'inconsistent',
        invalidReferences: {
          arreteRestrictions: 1,
          arreteCadres: 2,
          customizations: 3,
          total: 6,
        },
      },
    });
  });

  it('sanitizes database failures from the SANDRE reference diagnostic', async () => {
    const { controller, dataSource } = createController();
    dataSource.query.mockRejectedValue(new Error('secret database details'));

    await expect(controller.sandreReferences()).rejects.toMatchObject({
      status: 503,
      response: {
        status: 'unavailable',
        invalidReferences: null,
      },
    });
  });

  it.each(['safe', 'audit'])(
    'accepts a fresh SANDRE %s synchronization',
    async (mode) => {
      const { controller, dataSource, config } = createController();
      config.get.mockImplementation((key: string) =>
        key === 'SANDRE_ZONE_SYNC_MODE'
          ? mode
          : key === 'SANDRE_HEALTH_STALE_AFTER_SECONDS'
            ? '108000'
            : key === 'SANDRE_FORCE_FULL_AUDIT_AFTER'
              ? '2020-08-02T12:00:00Z'
              : undefined,
      );
      dataSource.query.mockResolvedValue([
        {
          totalDepartments: 101,
          trackedDepartments: 101,
          staleDepartments: 0,
          forcedAuditCompletedDepartments: 101,
          pendingForcedAuditDepartments: 0,
          appliedDepartments: mode === 'safe' ? 101 : 0,
          staleAppliedDepartments: mode === 'safe' ? 0 : 101,
          pendingApplicationDepartments: mode === 'safe' ? 0 : 101,
          recomputePendingDepartments: 0,
          blockedDepartments: 0,
          failedBatches: 0,
          blockedBatches: 0,
          retainedLkgZones: 1,
          oldestObservationAt: '2026-08-01T03:00:00.000Z',
          latestObservationAt: '2026-08-01T04:00:00.000Z',
        },
      ]);

      await expect(controller.sandreSynchronization()).resolves.toMatchObject({
        status: 'healthy',
        mode,
        summary: {
          totalDepartments: 101,
          staleDepartments: 0,
          appliedDepartments: mode === 'safe' ? 101 : 0,
          recomputePendingDepartments: 0,
          blockedDepartments: 0,
          retainedLkgZones: 1,
        },
      });
    },
  );

  it('requires every rollout audit batch to complete after its cutoff', async () => {
    const { controller, dataSource, config } = createController();
    config.get.mockImplementation((key: string) => {
      const values: Record<string, string> = {
        SANDRE_ZONE_SYNC_MODE: 'audit',
        SANDRE_HEALTH_STALE_AFTER_SECONDS: '108000',
        SANDRE_FORCE_FULL_AUDIT_AFTER: '2020-08-02T12:00:00Z',
      };
      return values[key];
    });
    const summary = {
      totalDepartments: 101,
      trackedDepartments: 101,
      staleDepartments: 0,
      forcedAuditCompletedDepartments: 101,
      pendingForcedAuditDepartments: 0,
      appliedDepartments: 0,
      staleAppliedDepartments: 101,
      pendingApplicationDepartments: 101,
      recomputePendingDepartments: 0,
      blockedDepartments: 0,
      failedBatches: 0,
      blockedBatches: 0,
      oldestObservationAt: '2026-08-02T12:00:01.000Z',
      latestObservationAt: '2026-08-02T12:30:00.000Z',
    };
    dataSource.query.mockResolvedValue([summary]);

    await expect(controller.sandreSynchronization()).resolves.toMatchObject({
      status: 'healthy',
      mode: 'audit',
      requiredObservationAfter: '2020-08-02T12:00:00.000Z',
      summary: {
        forcedAuditCompletedDepartments: 101,
        pendingForcedAuditDepartments: 0,
      },
    });
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining("batch.mode = 'audit'"),
      [108000, new Date('2020-08-02T12:00:00Z')],
    );

    dataSource.query.mockResolvedValueOnce([
      {
        ...summary,
        forcedAuditCompletedDepartments: 100,
        pendingForcedAuditDepartments: 1,
      },
    ]);
    await expect(controller.sandreSynchronization()).rejects.toMatchObject({
      status: 503,
      response: {
        status: 'stale',
        summary: { pendingForcedAuditDepartments: 1 },
      },
    });
  });

  it('rejects an invalid rollout audit cutoff before querying the database', async () => {
    const { controller, dataSource, config } = createController();
    config.get.mockImplementation((key: string) => {
      const values: Record<string, string> = {
        SANDRE_ZONE_SYNC_MODE: 'audit',
        SANDRE_FORCE_FULL_AUDIT_AFTER: '2026-08-02 12:00:00',
      };
      return values[key];
    });

    await expect(controller.sandreSynchronization()).rejects.toMatchObject({
      status: 503,
      response: {
        status: 'invalid_configuration',
        mode: 'audit',
        summary: null,
      },
    });
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it.each(['audit', 'safe'])(
    'requires a rollout audit cutoff in %s mode before querying the database',
    async (mode) => {
      const { controller, dataSource, config } = createController();
      config.get.mockImplementation((key: string) =>
        key === 'SANDRE_ZONE_SYNC_MODE' ? mode : undefined,
      );

      await expect(controller.sandreSynchronization()).rejects.toMatchObject({
        status: 503,
        response: {
          status: 'invalid_configuration',
          mode,
          requiredObservationAfter: null,
          summary: null,
        },
      });
      expect(dataSource.query).not.toHaveBeenCalled();
    },
  );

  it('keeps paused mode valid without a rollout audit cutoff', async () => {
    const { controller, dataSource, config } = createController();
    config.get.mockImplementation((key: string) =>
      key === 'SANDRE_ZONE_SYNC_MODE' ? 'paused' : undefined,
    );
    dataSource.query.mockResolvedValue([
      {
        totalDepartments: 101,
        trackedDepartments: 101,
        staleDepartments: 0,
        forcedAuditCompletedDepartments: 0,
        pendingForcedAuditDepartments: 0,
        appliedDepartments: 101,
        staleAppliedDepartments: 0,
        pendingApplicationDepartments: 0,
        recomputePendingDepartments: 0,
        blockedDepartments: 0,
        failedBatches: 0,
        blockedBatches: 0,
      },
    ]);

    await expect(controller.sandreSynchronization()).rejects.toMatchObject({
      status: 503,
      response: {
        status: 'paused',
        mode: 'paused',
        requiredObservationAfter: null,
      },
    });
    expect(dataSource.query).toHaveBeenCalledWith(expect.any(String), [
      108000,
      null,
    ]);
  });

  it.each(['blocked', 'failed'])(
    'keeps safe unhealthy when the latest rollout audit is %s',
    async () => {
      const { controller, dataSource } = createController();
      dataSource.query.mockResolvedValue([
        {
          totalDepartments: 101,
          trackedDepartments: 101,
          staleDepartments: 0,
          forcedAuditCompletedDepartments: 100,
          pendingForcedAuditDepartments: 1,
          appliedDepartments: 101,
          staleAppliedDepartments: 0,
          pendingApplicationDepartments: 0,
          recomputePendingDepartments: 0,
          blockedDepartments: 0,
          failedBatches: 0,
          blockedBatches: 0,
        },
      ]);

      await expect(controller.sandreSynchronization()).rejects.toMatchObject({
        status: 503,
        response: {
          status: 'stale',
          mode: 'safe',
          summary: { pendingForcedAuditDepartments: 1 },
        },
      });
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringMatching(
          /latest_rollout_audits[\s\S]*DISTINCT ON \(batch\."departementId"\)[\s\S]*ORDER BY batch\."departementId", batch\."startedAt" DESC, batch\.id DESC[\s\S]*status = 'observed'/,
        ),
        [108000, new Date('2020-08-02T12:00:00Z')],
      );
    },
  );

  it.each([
    ['paused', { blockedDepartments: 0, blockedBatches: 0, failedBatches: 0 }],
    ['safe', { blockedDepartments: 1, blockedBatches: 1, failedBatches: 0 }],
    ['safe', { blockedDepartments: 0, blockedBatches: 0, failedBatches: 1 }],
    ['safe', { staleDepartments: 1, blockedBatches: 0, failedBatches: 0 }],
    [
      'safe',
      {
        appliedDepartments: 100,
        staleAppliedDepartments: 1,
        pendingApplicationDepartments: 1,
      },
    ],
    ['safe', { pendingApplicationDepartments: 1 }],
  ])(
    'rejects an unhealthy SANDRE synchronization in %s mode',
    async (mode, overrides) => {
      const { controller, dataSource, config } = createController();
      config.get.mockImplementation((key: string) => {
        if (key === 'SANDRE_ZONE_SYNC_MODE') {
          return mode;
        }
        if (key === 'SANDRE_FORCE_FULL_AUDIT_AFTER' && mode !== 'paused') {
          return '2020-08-02T12:00:00Z';
        }
        return undefined;
      });
      dataSource.query.mockResolvedValue([
        {
          totalDepartments: 101,
          trackedDepartments: 101,
          staleDepartments: 0,
          appliedDepartments: 101,
          staleAppliedDepartments: 0,
          pendingApplicationDepartments: 0,
          recomputePendingDepartments: 0,
          blockedDepartments: 0,
          failedBatches: 0,
          blockedBatches: 0,
          oldestObservationAt: '2026-08-01T03:00:00.000Z',
          latestObservationAt: '2026-08-01T04:00:00.000Z',
          ...overrides,
        },
      ]);

      await expect(controller.sandreSynchronization()).rejects.toMatchObject({
        status: 503,
      });
    },
  );

  it('reports pending SANDRE recomputes as unavailable', async () => {
    const { controller, dataSource } = createController();
    dataSource.query.mockResolvedValue([
      {
        totalDepartments: 101,
        trackedDepartments: 101,
        staleDepartments: 0,
        forcedAuditCompletedDepartments: 101,
        pendingForcedAuditDepartments: 0,
        appliedDepartments: 101,
        staleAppliedDepartments: 0,
        pendingApplicationDepartments: 0,
        recomputePendingDepartments: 1,
        blockedDepartments: 0,
        failedBatches: 0,
        blockedBatches: 0,
      },
    ]);

    await expect(controller.sandreSynchronization()).rejects.toMatchObject({
      status: 503,
      response: {
        status: 'pending_recompute',
        mode: 'safe',
        summary: { recomputePendingDepartments: 1 },
      },
    });
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('state."needsRecompute" = true'),
      expect.any(Array),
    );
  });

  it('exposes map archives as disabled by default and rejects incomplete opt-in', () => {
    const { controller, config } = createController();

    expect(controller.mapArchives()).toEqual({
      status: 'disabled',
      enabled: false,
      resources: { geojson: false, pmtiles: false },
    });

    config.get.mockImplementation((key: string) =>
      key === 'DATAGOUV_MAP_ARCHIVES_ENABLED' ? 'true' : undefined,
    );
    expect(() => controller.mapArchives()).toThrow(ServiceUnavailableException);

    config.get.mockImplementation((key: string) => {
      const values: Record<string, string> = {
        DATAGOUV_MAP_ARCHIVES_ENABLED: 'true',
        API_DATAGOUV_GEOJSON_ARCHIVE_RESOURCE_ID: 'geojson-resource',
        API_DATAGOUV_PMTILES_ARCHIVE_RESOURCE_ID: 'pmtiles-resource',
      };
      return values[key];
    });
    expect(controller.mapArchives()).toEqual({
      status: 'configured',
      enabled: true,
      resources: { geojson: true, pmtiles: true },
    });
  });

  it('sanitizes database failures from the SANDRE synchronization diagnostic', async () => {
    const { controller, dataSource } = createController();
    dataSource.query.mockRejectedValue(new Error('secret database details'));

    await expect(controller.sandreSynchronization()).rejects.toMatchObject({
      status: 503,
      response: {
        status: 'unavailable',
        mode: 'safe',
        summary: null,
      },
    });
  });

  it('returns 503 readiness without exposing a database error', async () => {
    const { controller, dataSource } = createController();
    dataSource.query.mockRejectedValue(new Error('secret database details'));

    await expect(controller.ready()).rejects.toMatchObject({
      status: 503,
      response: { status: 'unavailable', database: 'down' },
    });
  });
});
