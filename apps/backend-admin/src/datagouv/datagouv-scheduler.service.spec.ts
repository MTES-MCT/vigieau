import { DatagouvSchedulerService } from './datagouv-scheduler.service';
import {
  BUSINESS_SCHEDULER_PROCESS_ENV,
  DISABLE_SCHEDULED_JOBS_ENV,
} from '../core/scheduling/business-cron';
import { ZONE_PUBLICATION_MATERIALIZATION_VERSION } from '../zone_publication/zone_publication.config';

describe('DatagouvSchedulerService', () => {
  const previousZonePublicationEnabled = process.env.ZONE_PUBLICATION_ENABLED;
  const previousStatisticCacheRequired =
    process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED;
  const exportIdentity = (scheduledFor: string) => ({
    publicationMode: 'versioned' as const,
    publicationId: 'publication-1',
    sourceRevision: '42',
    materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
    statisticCachePublicationId: 'statistic-publication-1',
    statisticRevision: '12',
    statisticPublishedDate: scheduledFor,
    statisticFingerprint: 'c'.repeat(64),
    historicFirstDate: '2013-01-01',
    historicLatestDate: scheduledFor,
    historicDateCount: 1,
    historicComputeEpoch: '8',
    historicReadinessMode: 'certified-repair' as const,
    certifiedHistoryRepairId: 'repair-1',
    certifiedHistoryRepairAttestationId: 'attestation-1',
  });

  beforeEach(() => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED = 'false';
  });

  afterAll(() => {
    if (previousZonePublicationEnabled === undefined) {
      delete process.env.ZONE_PUBLICATION_ENABLED;
    } else {
      process.env.ZONE_PUBLICATION_ENABLED = previousZonePublicationEnabled;
    }
    if (previousStatisticCacheRequired === undefined) {
      delete process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED;
    } else {
      process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED =
        previousStatisticCacheRequired;
    }
  });

  const createService = () => {
    const datagouvService = {
      updateDatagouvData: jest.fn().mockResolvedValue(undefined),
    };
    const registry = {
      hasSucceeded: jest.fn().mockResolvedValue(true),
      executeDailyRun: jest.fn(
        async (_key: string, _date: string, run: () => Promise<void>) => {
          await run();
          return 'succeeded';
        },
      ),
    };
    const zonePublicationService = {
      getSourceRevision: jest.fn().mockResolvedValue('42'),
      getActivePublicationGate: jest.fn().mockResolvedValue({
        publicationId: 'publication-1',
        sourceRevision: '42',
        geojsonChecksum: 'a'.repeat(64),
        pmtilesChecksum: 'b'.repeat(64),
      }),
    };
    const statisticCacheReadiness = {
      getReadyPublication: jest.fn().mockResolvedValue({
        publicationId: 'statistic-publication-1',
        statisticRevision: '12',
        statisticPublishedDate: '2026-08-01',
        statisticFingerprint: 'c'.repeat(64),
        sourceRevision: '42',
      }),
      assertReadyPublication: jest.fn().mockResolvedValue(undefined),
    };
    const historicExportReadiness = {
      evaluate: jest.fn(
        async (scheduledFor: string, gate?: { publicationId: string }) => ({
          status: 'ready',
          scheduledFor,
          identity: {
            ...exportIdentity(scheduledFor),
            publicationId: gate?.publicationId ?? 'publication-1',
          },
        }),
      ),
      assertReady: jest.fn().mockResolvedValue(undefined),
    };
    return {
      service: new DatagouvSchedulerService(
        datagouvService as any,
        registry as any,
        zonePublicationService as any,
        statisticCacheReadiness as any,
        historicExportReadiness as any,
      ),
      datagouvService,
      registry,
      zonePublicationService,
      statisticCacheReadiness,
      historicExportReadiness,
    };
  };

  it('keeps retrying the previous civil day before 06:00 in Europe/Paris', async () => {
    const harness = createService();

    await harness.service.publishIfDue(new Date('2026-08-01T03:59:00Z'));

    expect(harness.registry.executeDailyRun).toHaveBeenCalledWith(
      'datagouv:daily',
      '2026-07-31',
      expect.any(Function),
      new Date('2026-08-01T03:59:00Z'),
      {
        identity: {
          ...exportIdentity('2026-07-31'),
        },
      },
    );
    expect(harness.datagouvService.updateDatagouvData).toHaveBeenCalledWith(
      '2026-07-31',
      expect.objectContaining({
        ...exportIdentity('2026-07-31'),
        verifyCurrent: expect.any(Function),
      }),
    );
  });

  it('catches up the current Paris civil day after 06:00', async () => {
    const harness = createService();

    await harness.service.publishIfDue(new Date('2026-08-01T04:01:00Z'));

    expect(harness.registry.executeDailyRun).toHaveBeenCalledWith(
      'datagouv:daily',
      '2026-08-01',
      expect.any(Function),
      new Date('2026-08-01T04:01:00Z'),
      {
        identity: {
          ...exportIdentity('2026-08-01'),
        },
      },
    );
    expect(harness.datagouvService.updateDatagouvData).toHaveBeenCalledWith(
      '2026-08-01',
      expect.objectContaining({
        ...exportIdentity('2026-08-01'),
        verifyCurrent: expect.any(Function),
      }),
    );
  });

  it('publishes legacy data after the national computation succeeds', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'false';
    const harness = createService();
    const now = new Date('2026-08-01T04:01:00Z');

    await harness.service.publishIfDue(now);

    expect(harness.registry.hasSucceeded).toHaveBeenCalledTimes(3);
    expect(harness.registry.hasSucceeded).toHaveBeenCalledWith(
      'compute:national-daily',
      '2026-08-01',
      { publicationMode: 'legacy', sourceRevision: '42' },
    );
    expect(harness.registry.executeDailyRun).toHaveBeenCalledWith(
      'datagouv:daily',
      '2026-08-01',
      expect.any(Function),
      now,
      {
        identity: { publicationMode: 'legacy', sourceRevision: '42' },
      },
    );
    expect(harness.datagouvService.updateDatagouvData).toHaveBeenCalledWith(
      '2026-08-01',
      {
        publicationMode: 'legacy',
        sourceRevision: '42',
        verifyCurrent: expect.any(Function),
      },
    );
    expect(
      harness.zonePublicationService.getActivePublicationGate,
    ).not.toHaveBeenCalled();
    expect(harness.historicExportReadiness.evaluate).not.toHaveBeenCalled();
  });

  it('waits for the national computation in legacy mode', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'false';
    const harness = createService();
    harness.registry.hasSucceeded.mockResolvedValue(false);

    await harness.service.publishIfDue(new Date('2026-08-01T04:01:00Z'));

    expect(harness.registry.hasSucceeded).toHaveBeenCalledWith(
      'compute:national-daily',
      '2026-08-01',
      { publicationMode: 'legacy', sourceRevision: '42' },
    );
    expect(harness.registry.executeDailyRun).not.toHaveBeenCalled();
    expect(harness.datagouvService.updateDatagouvData).not.toHaveBeenCalled();
  });

  it('waits for the exact statistic artifact quorum in required legacy mode', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'false';
    process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED = 'true';
    const harness = createService();
    harness.statisticCacheReadiness.getReadyPublication.mockResolvedValue(null);

    await harness.service.publishIfDue(new Date('2026-08-01T04:01:00Z'));

    expect(
      harness.statisticCacheReadiness.getReadyPublication,
    ).toHaveBeenCalledWith('2026-08-01', '42');
    expect(harness.registry.executeDailyRun).not.toHaveBeenCalled();
  });

  it('pins a required legacy Datagouv run to the exact statistic artifact', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'false';
    process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED = 'true';
    const harness = createService();

    await harness.service.publishIfDue(new Date('2026-08-01T04:01:00Z'));

    expect(harness.registry.executeDailyRun).toHaveBeenCalledWith(
      'datagouv:daily',
      '2026-08-01',
      expect.any(Function),
      new Date('2026-08-01T04:01:00Z'),
      {
        identity: expect.objectContaining({
          publicationMode: 'legacy',
          sourceRevision: '42',
          statisticCachePublicationId: 'statistic-publication-1',
          statisticRevision: '12',
          statisticPublishedDate: '2026-08-01',
          statisticFingerprint: 'c'.repeat(64),
        }),
      },
    );
    expect(
      harness.statisticCacheReadiness.assertReadyPublication,
    ).toHaveBeenCalled();
  });

  it('keeps legacy retries idempotent through the daily registry', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'false';
    const harness = createService();
    let completed = false;
    harness.registry.executeDailyRun.mockImplementation(
      async (_key: string, _date: string, run: () => Promise<void>) => {
        if (completed) {
          return 'already_succeeded';
        }
        await run();
        completed = true;
        return 'succeeded';
      },
    );
    const now = new Date('2026-08-01T04:01:00Z');

    await harness.service.publishIfDue(now);
    await harness.service.publishIfDue(now);

    expect(harness.registry.executeDailyRun).toHaveBeenCalledTimes(2);
    expect(harness.datagouvService.updateDatagouvData).toHaveBeenCalledTimes(1);
  });

  it('rejects an obsolete legacy daily success', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'false';
    const harness = createService();
    harness.registry.hasSucceeded.mockImplementation(
      async (_jobKey, _scheduledFor, identity) =>
        identity?.sourceRevision === '41',
    );

    await harness.service.publishIfDue(new Date('2026-08-01T04:01:00Z'));

    expect(harness.registry.hasSucceeded).toHaveBeenCalledWith(
      'compute:national-daily',
      '2026-08-01',
      { publicationMode: 'legacy', sourceRevision: '42' },
    );
    expect(harness.registry.executeDailyRun).not.toHaveBeenCalled();
    expect(harness.datagouvService.updateDatagouvData).not.toHaveBeenCalled();
  });

  it('fails a legacy publication when the source revision changes during it', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'false';
    const harness = createService();
    harness.zonePublicationService.getSourceRevision
      .mockResolvedValueOnce('42')
      .mockResolvedValueOnce('42')
      .mockResolvedValueOnce('43');

    await expect(
      harness.service.publishIfDue(new Date('2026-08-01T04:01:00Z')),
    ).rejects.toThrow('Legacy computation gate changed during Datagouv run');

    expect(harness.datagouvService.updateDatagouvData).toHaveBeenCalledTimes(1);
  });

  it('waits for the certified export boundary without requiring a catch-up run', async () => {
    const harness = createService();
    harness.historicExportReadiness.evaluate.mockResolvedValue({
      status: 'blocked',
      scheduledFor: '2026-08-01',
      blocker: 'current_daily_not_ready',
    } as any);

    await harness.service.publishIfDue(new Date('2026-08-01T04:01:00Z'));

    expect(harness.historicExportReadiness.evaluate).toHaveBeenCalledWith(
      '2026-08-01',
      expect.objectContaining({ publicationId: 'publication-1' }),
    );
    expect(harness.registry.hasSucceeded).not.toHaveBeenCalledWith(
      'compute:historic-catchup',
      expect.anything(),
      expect.anything(),
    );
    expect(harness.registry.executeDailyRun).not.toHaveBeenCalled();
    expect(harness.datagouvService.updateDatagouvData).not.toHaveBeenCalled();
  });

  it('waits until the publication of the same day is fully promoted', async () => {
    const harness = createService();
    harness.zonePublicationService.getActivePublicationGate.mockResolvedValue(
      null,
    );

    await harness.service.publishIfDue(new Date('2026-08-01T04:01:00Z'));

    expect(
      harness.zonePublicationService.getActivePublicationGate,
    ).toHaveBeenCalledWith('2026-08-01');
    expect(harness.registry.executeDailyRun).not.toHaveBeenCalled();
  });

  it('fails the run when the active publication changes before completion', async () => {
    const harness = createService();
    const initialGate = {
      publicationId: 'publication-1',
      sourceRevision: '42',
      geojsonChecksum: 'a'.repeat(64),
      pmtilesChecksum: 'b'.repeat(64),
    };
    harness.zonePublicationService.getActivePublicationGate
      .mockResolvedValueOnce(initialGate)
      .mockResolvedValueOnce(initialGate)
      .mockResolvedValueOnce({
        ...initialGate,
        publicationId: 'publication-2',
        sourceRevision: '43',
      });

    await expect(
      harness.service.publishIfDue(new Date('2026-08-01T04:01:00Z')),
    ).rejects.toThrow('Zone publication gate changed during Datagouv run');
  });

  it('publishes a replacement publication for an already computed revision', async () => {
    const harness = createService();
    harness.zonePublicationService.getActivePublicationGate.mockResolvedValue({
      publicationId: 'publication-replacement',
      sourceRevision: '42',
      geojsonChecksum: 'c'.repeat(64),
      pmtilesChecksum: 'd'.repeat(64),
    });

    await harness.service.publishIfDue(new Date('2026-08-01T04:01:00Z'));

    expect(harness.registry.executeDailyRun).toHaveBeenCalledWith(
      'datagouv:daily',
      '2026-08-01',
      expect.any(Function),
      expect.any(Date),
      {
        identity: {
          ...exportIdentity('2026-08-01'),
          publicationId: 'publication-replacement',
        },
      },
    );
  });

  it('fails when the certified export boundary changes during publication', async () => {
    const harness = createService();
    harness.historicExportReadiness.assertReady.mockRejectedValueOnce(
      new Error('Historic export boundary changed'),
    );

    await expect(
      harness.service.publishIfDue(new Date('2026-08-01T04:01:00Z')),
    ).rejects.toThrow('Historic export boundary changed');

    expect(harness.datagouvService.updateDatagouvData).not.toHaveBeenCalled();
    expect(harness.historicExportReadiness.assertReady).toHaveBeenCalledWith(
      exportIdentity('2026-08-01'),
    );
  });

  it('does not schedule startup catch-up during a maintenance freeze', () => {
    const previousRole = process.env[BUSINESS_SCHEDULER_PROCESS_ENV];
    const previousDisabled = process.env[DISABLE_SCHEDULED_JOBS_ENV];
    const timeout = jest.spyOn(global, 'setTimeout');
    process.env[BUSINESS_SCHEDULER_PROCESS_ENV] = 'true';
    process.env[DISABLE_SCHEDULED_JOBS_ENV] = 'true';

    try {
      createService().service.onApplicationBootstrap();
      expect(timeout).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
      if (previousRole === undefined) {
        delete process.env[BUSINESS_SCHEDULER_PROCESS_ENV];
      } else {
        process.env[BUSINESS_SCHEDULER_PROCESS_ENV] = previousRole;
      }
      if (previousDisabled === undefined) {
        delete process.env[DISABLE_SCHEDULED_JOBS_ENV];
      } else {
        process.env[DISABLE_SCHEDULED_JOBS_ENV] = previousDisabled;
      }
    }
  });

  it('schedules no catch-up before bootstrap and exactly one after', async () => {
    const previousRole = process.env[BUSINESS_SCHEDULER_PROCESS_ENV];
    const previousDisabled = process.env[DISABLE_SCHEDULED_JOBS_ENV];
    process.env[BUSINESS_SCHEDULER_PROCESS_ENV] = 'true';
    delete process.env[DISABLE_SCHEDULED_JOBS_ENV];
    jest.useFakeTimers();
    const harness = createService();
    const publishIfDue = jest
      .spyOn(harness.service, 'publishIfDue')
      .mockResolvedValue(undefined);

    try {
      expect(jest.getTimerCount()).toBe(0);
      expect(publishIfDue).not.toHaveBeenCalled();

      harness.service.onApplicationBootstrap();
      harness.service.onApplicationBootstrap();
      jest.runOnlyPendingTimers();
      await Promise.resolve();

      expect(publishIfDue).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
      if (previousRole === undefined) {
        delete process.env[BUSINESS_SCHEDULER_PROCESS_ENV];
      } else {
        process.env[BUSINESS_SCHEDULER_PROCESS_ENV] = previousRole;
      }
      if (previousDisabled === undefined) {
        delete process.env[DISABLE_SCHEDULED_JOBS_ENV];
      } else {
        process.env[DISABLE_SCHEDULED_JOBS_ENV] = previousDisabled;
      }
    }
  });
});
