import { DatagouvSchedulerService } from './datagouv-scheduler.service';
import {
  BUSINESS_SCHEDULER_PROCESS_ENV,
  DISABLE_SCHEDULED_JOBS_ENV,
} from '../core/scheduling/business-cron';
import { ZONE_PUBLICATION_MATERIALIZATION_VERSION } from '../zone_publication/zone_publication.config';

describe('DatagouvSchedulerService', () => {
  const previousZonePublicationEnabled = process.env.ZONE_PUBLICATION_ENABLED;
  const historicConfig = {
    computeMapDate: new Date('2026-07-31T00:00:00.000Z'),
    computeStatsDate: '2026-07-31T12:00:00.000Z',
    computeMapGeneration: 12,
    computeStatsGeneration: '8',
  };
  const historicIdentity = {
    sourceRevision: '42',
    materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
    historicMapCursor: '2026-07-31',
    historicStatsCursor: '2026-07-31',
    historicMapGeneration: '12',
    historicStatsGeneration: '8',
  };

  beforeEach(() => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
  });

  afterAll(() => {
    if (previousZonePublicationEnabled === undefined) {
      delete process.env.ZONE_PUBLICATION_ENABLED;
    } else {
      process.env.ZONE_PUBLICATION_ENABLED = previousZonePublicationEnabled;
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
    const configService = {
      getConfig: jest.fn().mockResolvedValue(historicConfig),
    };
    return {
      service: new DatagouvSchedulerService(
        datagouvService as any,
        registry as any,
        zonePublicationService as any,
        configService as any,
      ),
      datagouvService,
      registry,
      zonePublicationService,
      configService,
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
          publicationId: 'publication-1',
          ...historicIdentity,
        },
      },
    );
    expect(harness.datagouvService.updateDatagouvData).toHaveBeenCalledWith(
      '2026-07-31',
      expect.objectContaining({
        publicationId: 'publication-1',
        ...historicIdentity,
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
          publicationId: 'publication-1',
          ...historicIdentity,
        },
      },
    );
    expect(harness.datagouvService.updateDatagouvData).toHaveBeenCalledWith(
      '2026-08-01',
      expect.objectContaining({
        publicationId: 'publication-1',
        ...historicIdentity,
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
    expect(harness.configService.getConfig).not.toHaveBeenCalled();
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

  it('waits for the national computation of the same civil day', async () => {
    const harness = createService();
    harness.registry.hasSucceeded.mockResolvedValue(false);

    await harness.service.publishIfDue(new Date('2026-08-01T04:01:00Z'));

    expect(harness.registry.hasSucceeded).toHaveBeenCalledWith(
      'compute:national-daily',
      '2026-08-01',
      {
        sourceRevision: '42',
        materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
      },
    );
    expect(harness.registry.hasSucceeded).toHaveBeenCalledWith(
      'compute:historic-catchup',
      '2026-08-01',
      historicIdentity,
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

    expect(harness.registry.hasSucceeded).toHaveBeenCalledWith(
      'compute:national-daily',
      '2026-08-01',
      {
        sourceRevision: '42',
        materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
      },
    );
    expect(harness.registry.executeDailyRun).toHaveBeenCalledWith(
      'datagouv:daily',
      '2026-08-01',
      expect.any(Function),
      expect.any(Date),
      {
        identity: {
          publicationId: 'publication-replacement',
          ...historicIdentity,
        },
      },
    );
  });

  it('fails when an equal-date historic invalidation changes a generation', async () => {
    const harness = createService();
    harness.configService.getConfig
      .mockResolvedValueOnce(historicConfig)
      .mockResolvedValueOnce(historicConfig)
      .mockResolvedValueOnce({
        ...historicConfig,
        computeMapGeneration: 13,
      });

    await expect(
      harness.service.publishIfDue(new Date('2026-08-01T04:01:00Z')),
    ).rejects.toThrow('Historic computation gate changed during Datagouv run');

    expect(harness.datagouvService.updateDatagouvData).toHaveBeenCalledTimes(1);
    expect(harness.registry.hasSucceeded).toHaveBeenCalledWith(
      'compute:historic-catchup',
      '2026-08-01',
      historicIdentity,
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
