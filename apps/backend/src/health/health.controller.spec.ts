import { HttpException, HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataService, type StatisticCacheStatus } from '../data/data.service';
import { ZonesService, type ZoneCacheStatus } from '../zones/zones.service';
import { HealthController } from './health.controller';

jest.mock('../zones/zones.service', () => ({
  ZonesService: class ZonesService {},
}));
jest.mock('../data/data.service', () => ({
  DataService: class DataService {},
}));

describe('HealthController', () => {
  let controller: HealthController;
  const zonesService = { getCacheStatus: jest.fn() };
  const dataService = { getStatisticCacheStatus: jest.fn() };
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
  const statisticStatus: StatisticCacheStatus = {
    status: 'ready',
    usable: true,
    fresh: true,
    mode: 'versioned',
    currentPublishedDate: '2026-08-11',
    firstDate: '2013-01-01',
    latestDate: '2026-08-11',
    dateCount: 4971,
    departmentCount: 101,
    communeCount: 34943,
    fingerprint: 'statistic-fingerprint',
    loadedAt: '2026-08-11T12:00:00.000Z',
    lastError: null,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: ZonesService, useValue: zonesService },
        { provide: DataService, useValue: dataService },
      ],
    }).compile();
    controller = module.get(HealthController);
    dataService.getStatisticCacheStatus.mockResolvedValue(statisticStatus);
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

  it('returns 503 readiness when the statistic cache is unusable', async () => {
    zonesService.getCacheStatus.mockResolvedValue(baseStatus);
    dataService.getStatisticCacheStatus.mockResolvedValue({
      ...statisticStatus,
      status: 'unavailable',
      usable: false,
      fresh: false,
    });

    try {
      await controller.ready();
      throw new Error('Expected readiness to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(
        HttpStatus.SERVICE_UNAVAILABLE,
      );
      expect((error as HttpException).getResponse()).toEqual(
        expect.objectContaining({ status: 'unavailable', usable: false }),
      );
    }
  });

  it('keeps readiness when the statistic cache is usable but stale', async () => {
    zonesService.getCacheStatus.mockResolvedValue(baseStatus);
    dataService.getStatisticCacheStatus.mockResolvedValue({
      ...statisticStatus,
      status: 'degraded',
      fresh: false,
    });

    await expect(controller.ready()).resolves.toBe(baseStatus);
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

  it('returns 503 from statistic health when the cache is stale', async () => {
    dataService.getStatisticCacheStatus.mockResolvedValue({
      ...statisticStatus,
      status: 'degraded',
      fresh: false,
    });

    await expect(controller.statistics()).rejects.toBeInstanceOf(HttpException);
  });

  it('returns statistic diagnostics when the cache is fresh', async () => {
    dataService.getStatisticCacheStatus.mockResolvedValue(statisticStatus);

    await expect(controller.statistics()).resolves.toBe(statisticStatus);
  });
});
