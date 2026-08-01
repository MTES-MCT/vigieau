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
          DATAGOUV_MAP_ARCHIVES_ENABLED: 'false',
        };
        return values[key];
      }),
    };
    return {
      controller: new HealthController(
        dataSource as any,
        registry as any,
        clockHeartbeat as any,
        config as any,
      ),
      dataSource,
      registry,
      clockHeartbeat,
      config,
    };
  }

  it('exposes the sanitized external publication health status', async () => {
    const { controller } = createController();

    await expect(controller.externalPublications()).resolves.toEqual({
      status: 'healthy',
      lastSuccessAt: '2026-08-01T06:00:00.000Z',
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
      expect.stringContaining("parent.statut <> 'abroge'"),
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
            : undefined,
      );
      dataSource.query.mockResolvedValue([
        {
          totalDepartments: 101,
          trackedDepartments: 101,
          staleDepartments: 0,
          appliedDepartments: mode === 'safe' ? 101 : 0,
          staleAppliedDepartments: mode === 'safe' ? 0 : 101,
          pendingApplicationDepartments: mode === 'safe' ? 0 : 101,
          blockedDepartments: 0,
          failedBatches: 0,
          blockedBatches: 0,
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
          blockedDepartments: 0,
        },
      });
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
      config.get.mockImplementation((key: string) =>
        key === 'SANDRE_ZONE_SYNC_MODE' ? mode : undefined,
      );
      dataSource.query.mockResolvedValue([
        {
          totalDepartments: 101,
          trackedDepartments: 101,
          staleDepartments: 0,
          appliedDepartments: 101,
          staleAppliedDepartments: 0,
          pendingApplicationDepartments: 0,
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
