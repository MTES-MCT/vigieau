import { HttpException, HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ZonesService, type ZoneCacheStatus } from '../zones/zones.service';
import { HealthController } from './health.controller';

jest.mock('../zones/zones.service', () => ({
  ZonesService: class ZonesService {},
}));

describe('HealthController', () => {
  let controller: HealthController;
  const zonesService = { getCacheStatus: jest.fn() };
  const baseStatus: ZoneCacheStatus = {
    status: 'ready',
    usable: true,
    fresh: true,
    loading: false,
    loadedVersion: '2026-07-31T12:00:00.000Z',
    availableVersion: '2026-07-31T12:00:00.000Z',
    loadedAt: '2026-07-31T12:00:05.000Z',
    lastVersionCheckAt: '2026-07-31T12:00:05.000Z',
    lastSuccessfulVersionCheckAt: '2026-07-31T12:00:05.000Z',
    lastError: null,
    counts: {
      zones: 1,
      features: 1,
      communes: 1,
      communeAssociations: 1,
      arretesMunicipaux: 0,
    },
    publication: {
      mode: 'legacy',
      activeId: null,
      activeRevision: null,
      candidatePreloaded: false,
      cachedPublications: 0,
      instances: { live: 1, activeReady: 0, candidateReady: 0 },
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: ZonesService, useValue: zonesService }],
    }).compile();
    controller = module.get(HealthController);
  });

  it('reports process liveness independently from the cache', () => {
    expect(controller.live()).toEqual({ status: 'ok' });
  });

  it('exempts health probes from global throttling', () => {
    expect(Reflect.getMetadata('THROTTLER:SKIPdefault', HealthController)).toBe(
      true,
    );
  });

  it('keeps readiness while a complete but stale snapshot is usable', async () => {
    const stale = {
      ...baseStatus,
      status: 'degraded' as const,
      usable: true,
      fresh: false,
    };
    zonesService.getCacheStatus.mockResolvedValue(stale);

    await expect(controller.ready()).resolves.toBe(stale);
  });

  it('returns 503 readiness when no complete snapshot is available', async () => {
    zonesService.getCacheStatus.mockResolvedValue({
      ...baseStatus,
      status: 'unavailable',
      usable: false,
      fresh: false,
    });

    await expect(controller.ready()).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
    });
  });

  it('returns 503 from strict cache health when the snapshot is stale', async () => {
    zonesService.getCacheStatus.mockResolvedValue({
      ...baseStatus,
      status: 'degraded',
      usable: true,
      fresh: false,
      lastError: { at: '2026-07-31T12:00:00.000Z', phase: 'load' },
    });

    await expect(controller.cache()).rejects.toBeInstanceOf(HttpException);
  });

  it('returns strict cache diagnostics when the snapshot is fresh', async () => {
    zonesService.getCacheStatus.mockResolvedValue(baseStatus);

    await expect(controller.cache()).resolves.toBe(baseStatus);
  });
});
