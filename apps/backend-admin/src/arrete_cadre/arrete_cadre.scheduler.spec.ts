import { ArreteCadreService } from './arrete_cadre.service';
import { ArreteCadreScheduler } from './arrete_cadre.scheduler';
import {
  BUSINESS_SCHEDULER_PROCESS_ENV,
  DISABLE_SCHEDULED_JOBS_ENV,
} from '../core/scheduling/business-cron';
import {
  NATIONAL_DAILY_COMPUTE_JOB_KEY,
  NATIONAL_HISTORIC_CATCHUP_JOB_KEY,
} from '../core/scheduling/daily-job-schedule';
import { ZONE_PUBLICATION_MATERIALIZATION_VERSION } from '../zone_publication/zone_publication.config';

describe('ArreteCadreService scheduled status update', () => {
  it('waits for and propagates a restriction status update failure', async () => {
    const transactionRepository = {
      query: jest.fn().mockResolvedValue([]),
    };
    const repository = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
      manager: {
        transaction: jest.fn(async (_isolation, callback) =>
          callback({ getRepository: () => transactionRepository }),
        ),
      },
    };
    const expectedError = new Error('restriction status update failed');
    const arreteRestrictionService = {
      updateArreteRestrictionStatut: jest.fn().mockRejectedValue(expectedError),
    };
    const service = new ArreteCadreService(
      repository as never,
      arreteRestrictionService as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

    await expect(service.updateArreteCadreStatut()).rejects.toBe(expectedError);
    expect(repository.update).not.toHaveBeenCalled();
    expect(
      arreteRestrictionService.updateArreteRestrictionStatut,
    ).toHaveBeenCalledWith(null, true);
  });

  it('propagates the daily publication reuse context to the restriction update', async () => {
    const transactionRepository = {
      query: jest.fn().mockResolvedValue([]),
    };
    const repository = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
      manager: {
        transaction: jest.fn(async (_isolation, callback) =>
          callback({ getRepository: () => transactionRepository }),
        ),
      },
    };
    const arreteRestrictionService = {
      updateArreteRestrictionStatut: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ArreteCadreService(
      repository as never,
      arreteRestrictionService as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    const reuseContext = {
      scheduledFor: '2026-08-01',
      sourceRevision: '42',
    };

    await service.updateArreteCadreStatut(false, reuseContext);

    expect(
      arreteRestrictionService.updateArreteRestrictionStatut,
    ).toHaveBeenCalledWith(null, false, reuseContext);
  });

  it('does not select unknown legacy boundaries for date reconciliation', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'false';
    const transactionRepository = {
      query: jest.fn().mockResolvedValue([]),
    };
    const repository = {
      manager: {
        transaction: jest.fn(
          async (_isolation: string, callback: (manager: any) => unknown) =>
            callback({
              getRepository: jest.fn(() => transactionRepository),
            }),
        ),
      },
    };
    const arreteRestrictionService = {
      updateArreteRestrictionStatut: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ArreteCadreService(
      repository as never,
      arreteRestrictionService as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

    await service.updateArreteCadreStatut();

    const candidateQuery = transactionRepository.query.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes('expected_end.resolved_end'));
    expect(candidateQuery).toContain(
      'framework_order."dateFinSaisieConnue" = true',
    );
  });
});

describe('ArreteCadreScheduler', () => {
  const previousPublicationEnabled = process.env.ZONE_PUBLICATION_ENABLED;
  const historicCursorState = {
    mapCursor: '2026-07-31',
    statsCursor: '2026-07-31',
    mapGeneration: '12',
    statsGeneration: '18',
  };
  const historicRunIdentity = {
    historicMapCursor: '2026-07-31',
    historicStatsCursor: '2026-07-31',
    historicMapGeneration: '12',
    historicStatsGeneration: '18',
  };

  beforeEach(() => {
    process.env.ZONE_PUBLICATION_ENABLED = 'false';
  });

  afterAll(() => {
    if (previousPublicationEnabled === undefined) {
      delete process.env.ZONE_PUBLICATION_ENABLED;
    } else {
      process.env.ZONE_PUBLICATION_ENABLED = previousPublicationEnabled;
    }
  });

  const createScheduler = () => {
    const completedRunMetadata: unknown[] = [];
    const arreteCadreService = {
      updateArreteCadreStatut: jest.fn().mockResolvedValue(undefined),
      catchUpHistoricComputations: jest
        .fn()
        .mockResolvedValue(historicCursorState),
    };
    const registry = {
      executeDailyRun: jest.fn(
        async (_jobKey: string, _date: string, run: () => Promise<unknown>) => {
          completedRunMetadata.push(await run());
          return 'succeeded';
        },
      ),
      getSucceededRunMetadata: jest.fn().mockResolvedValue({
        publicationId: 'publication-1',
        sourceRevision: '42',
        materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
      }),
    };
    const zonePublicationService = {
      getSourceRevision: jest.fn().mockResolvedValue('42'),
      promoteCertifiedPublicationIfAvailable: jest.fn().mockResolvedValue(true),
    };
    const configService = {
      getConfig: jest.fn().mockResolvedValue({
        computeMapDate: historicCursorState.mapCursor,
        computeStatsDate: historicCursorState.statsCursor,
        computeMapGeneration: historicCursorState.mapGeneration,
        computeStatsGeneration: historicCursorState.statsGeneration,
      }),
    };
    return {
      service: new ArreteCadreScheduler(
        arreteCadreService as never,
        registry as never,
        zonePublicationService as never,
        configService as never,
      ),
      arreteCadreService,
      registry,
      zonePublicationService,
      configService,
      completedRunMetadata,
    };
  };

  it.each([
    ['summer before 02:00', '2026-07-31T23:59:00Z', '2026-07-31'],
    ['summer from 02:00', '2026-08-01T00:00:00Z', '2026-08-01'],
    ['winter before 02:00', '2026-12-01T00:59:00Z', '2026-11-30'],
    ['winter from 02:00', '2026-12-01T01:00:00Z', '2026-12-01'],
    ['DST spring before the jump', '2026-03-29T00:59:00Z', '2026-03-28'],
    ['DST spring after the jump', '2026-03-29T01:00:00Z', '2026-03-29'],
    ['first DST autumn 02:00', '2026-10-25T00:00:00Z', '2026-10-25'],
    ['second DST autumn 02:00', '2026-10-25T01:00:00Z', '2026-10-25'],
  ])(
    'uses the correct Europe/Paris business date %s',
    async (_label, now, expectedDate) => {
      const harness = createScheduler();

      await harness.service.updateIfDue(new Date(now));

      expect(harness.registry.executeDailyRun).toHaveBeenCalledWith(
        NATIONAL_DAILY_COMPUTE_JOB_KEY,
        expectedDate,
        expect.any(Function),
        new Date(now),
      );
      expect(
        harness.arreteCadreService.updateArreteCadreStatut,
      ).toHaveBeenCalledWith(false);
      expect(
        harness.arreteCadreService.catchUpHistoricComputations,
      ).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    },
  );

  it('pins the legacy historic run to the persisted cursor epoch', async () => {
    const harness = createScheduler();
    const now = new Date('2026-08-01T08:00:00Z');

    await harness.service.updateIfDue(now);

    expect(harness.registry.executeDailyRun).toHaveBeenNthCalledWith(
      2,
      NATIONAL_HISTORIC_CATCHUP_JOB_KEY,
      '2026-08-01',
      expect.any(Function),
      now,
      { identity: historicRunIdentity },
    );
  });

  it('keeps submitting the daily run after a failed attempt', async () => {
    const harness = createScheduler();
    harness.registry.executeDailyRun
      .mockRejectedValueOnce(new Error('compute failed'))
      .mockResolvedValueOnce('succeeded');

    await expect(
      harness.service.updateIfDue(new Date('2026-08-01T08:00:00Z')),
    ).rejects.toThrow('compute failed');
    await expect(
      harness.service.updateIfDue(new Date('2026-08-01T08:05:00Z')),
    ).resolves.toBeUndefined();

    expect(harness.registry.executeDailyRun).toHaveBeenCalledTimes(3);
  });

  it('does not overlap startup catch-up and cron execution', async () => {
    const harness = createScheduler();
    let releaseCurrent: () => void;
    const currentPending = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    harness.arreteCadreService.updateArreteCadreStatut.mockReturnValue(
      currentPending,
    );

    const startupCatchUp = harness.service.updateIfDue(
      new Date('2026-08-01T08:00:00Z'),
    );
    await Promise.resolve();
    const cronRun = harness.service.updateIfDue(
      new Date('2026-08-01T08:05:00Z'),
    );

    expect(harness.registry.executeDailyRun).toHaveBeenCalledTimes(1);
    releaseCurrent!();
    await Promise.all([startupCatchUp, cronRun]);

    expect(harness.registry.executeDailyRun).toHaveBeenCalledTimes(2);
    expect(
      harness.registry.executeDailyRun.mock.calls.filter(
        ([jobKey]) => jobKey === NATIONAL_DAILY_COMPUTE_JOB_KEY,
      ),
    ).toHaveLength(1);
    expect(
      harness.registry.executeDailyRun.mock.calls.filter(
        ([jobKey]) => jobKey === NATIONAL_HISTORIC_CATCHUP_JOB_KEY,
      ),
    ).toHaveLength(1);
  });

  it('binds current and historic successes to the computed publication', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const harness = createScheduler();
    harness.arreteCadreService.updateArreteCadreStatut.mockResolvedValue({
      result: {
        publicationId: 'publication-1',
        sourceRevision: '42',
      },
    });
    const now = new Date('2026-08-01T08:00:00Z');

    await harness.service.updateIfDue(now);

    expect(
      harness.arreteCadreService.updateArreteCadreStatut,
    ).toHaveBeenCalledWith(false, {
      scheduledFor: '2026-08-01',
      sourceRevision: '42',
    });
    expect(
      harness.arreteCadreService.catchUpHistoricComputations,
    ).toHaveBeenCalledWith('2026-07-31', '42');

    expect(harness.registry.executeDailyRun).toHaveBeenNthCalledWith(
      1,
      NATIONAL_DAILY_COMPUTE_JOB_KEY,
      '2026-08-01',
      expect.any(Function),
      now,
      {
        identity: {
          sourceRevision: '42',
          materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
        },
      },
    );
    expect(harness.registry.executeDailyRun).toHaveBeenNthCalledWith(
      2,
      NATIONAL_HISTORIC_CATCHUP_JOB_KEY,
      '2026-08-01',
      expect.any(Function),
      now,
      {
        identity: {
          sourceRevision: '42',
          materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
          ...historicRunIdentity,
        },
      },
    );
    expect(
      harness.zonePublicationService.promoteCertifiedPublicationIfAvailable,
    ).toHaveBeenCalledWith({
      scheduledFor: '2026-08-01',
      sourceRevision: '42',
      preferredPublicationId: 'publication-1',
    });
  });

  it('resumes candidacy from persisted daily and historic successes', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const harness = createScheduler();
    harness.registry.executeDailyRun
      .mockResolvedValueOnce('already_succeeded')
      .mockResolvedValueOnce('already_succeeded');

    await harness.service.updateIfDue(new Date('2026-08-01T08:00:00Z'));

    expect(
      harness.arreteCadreService.updateArreteCadreStatut,
    ).not.toHaveBeenCalled();
    expect(
      harness.arreteCadreService.catchUpHistoricComputations,
    ).not.toHaveBeenCalled();
    expect(
      harness.zonePublicationService.promoteCertifiedPublicationIfAvailable,
    ).toHaveBeenCalledWith({
      scheduledFor: '2026-08-01',
      sourceRevision: '42',
      preferredPublicationId: 'publication-1',
    });
  });

  it('does not expose the validated publication while historic catch-up is busy', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const harness = createScheduler();
    harness.registry.executeDailyRun
      .mockResolvedValueOnce('already_succeeded')
      .mockResolvedValueOnce('busy');

    await harness.service.updateIfDue(new Date('2026-08-01T08:00:00Z'));

    expect(
      harness.zonePublicationService.promoteCertifiedPublicationIfAvailable,
    ).not.toHaveBeenCalled();
  });

  it('does not certify a computation when the source revision changes', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const harness = createScheduler();
    harness.arreteCadreService.updateArreteCadreStatut.mockResolvedValue({
      result: {
        publicationId: 'publication-1',
        sourceRevision: '42',
      },
    });
    harness.zonePublicationService.getSourceRevision
      .mockResolvedValueOnce('42')
      .mockResolvedValueOnce('43');

    await expect(
      harness.service.updateIfDue(new Date('2026-08-01T08:00:00Z')),
    ).rejects.toThrow('Zone source revision changed during computation');

    expect(
      harness.arreteCadreService.catchUpHistoricComputations,
    ).not.toHaveBeenCalled();
  });

  it('certifies the revision captured after scheduled status transitions', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const harness = createScheduler();
    harness.arreteCadreService.updateArreteCadreStatut.mockResolvedValue({
      result: {
        publicationId: 'publication-1',
        sourceRevision: '42',
      },
    });
    harness.zonePublicationService.getSourceRevision
      .mockResolvedValueOnce('41')
      .mockResolvedValue('42');
    const now = new Date('2026-08-01T08:00:00Z');

    await harness.service.updateIfDue(now);

    expect(harness.registry.executeDailyRun).toHaveBeenNthCalledWith(
      1,
      NATIONAL_DAILY_COMPUTE_JOB_KEY,
      '2026-08-01',
      expect.any(Function),
      now,
      {
        identity: {
          sourceRevision: '41',
          materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
        },
      },
    );
    expect(harness.registry.executeDailyRun).toHaveBeenNthCalledWith(
      2,
      NATIONAL_HISTORIC_CATCHUP_JOB_KEY,
      '2026-08-01',
      expect.any(Function),
      now,
      {
        identity: {
          sourceRevision: '42',
          materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
          ...historicRunIdentity,
        },
      },
    );
  });

  it('persists the cursor generations reached by the historic catch-up', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const harness = createScheduler();
    harness.arreteCadreService.updateArreteCadreStatut.mockResolvedValue({
      result: {
        publicationId: 'publication-1',
        sourceRevision: '42',
      },
    });
    harness.arreteCadreService.catchUpHistoricComputations.mockResolvedValue({
      mapCursor: '2026-07-31',
      statsCursor: '2026-07-31',
      mapGeneration: '13',
      statsGeneration: '19',
    });

    await harness.service.updateIfDue(new Date('2026-08-01T08:00:00Z'));

    expect(harness.completedRunMetadata[1]).toEqual({
      sourceRevision: '42',
      materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
      historicMapCursor: '2026-07-31',
      historicStatsCursor: '2026-07-31',
      historicMapGeneration: '13',
      historicStatsGeneration: '19',
    });
  });

  it('revalidates the source after the historic barrier completes', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const harness = createScheduler();
    harness.arreteCadreService.updateArreteCadreStatut.mockResolvedValue({
      result: {
        publicationId: 'publication-1',
        sourceRevision: '42',
      },
    });
    harness.zonePublicationService.getSourceRevision
      .mockResolvedValueOnce('42')
      .mockResolvedValueOnce('42')
      .mockResolvedValueOnce('42')
      .mockResolvedValueOnce('42')
      .mockResolvedValueOnce('43');

    await expect(
      harness.service.updateIfDue(new Date('2026-08-01T08:00:00Z')),
    ).rejects.toThrow('Zone source revision changed during computation');
    expect(
      harness.zonePublicationService.promoteCertifiedPublicationIfAvailable,
    ).not.toHaveBeenCalled();
  });

  it('does not schedule startup catch-up during a maintenance freeze', () => {
    const previousRole = process.env[BUSINESS_SCHEDULER_PROCESS_ENV];
    const previousDisabled = process.env[DISABLE_SCHEDULED_JOBS_ENV];
    const timeout = jest.spyOn(global, 'setTimeout');
    process.env[BUSINESS_SCHEDULER_PROCESS_ENV] = 'true';
    process.env[DISABLE_SCHEDULED_JOBS_ENV] = 'true';

    try {
      createScheduler().service.onApplicationBootstrap();
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
    const harness = createScheduler();
    const updateIfDue = jest
      .spyOn(harness.service, 'updateIfDue')
      .mockResolvedValue(undefined);

    try {
      expect(jest.getTimerCount()).toBe(0);
      expect(updateIfDue).not.toHaveBeenCalled();

      harness.service.onApplicationBootstrap();
      harness.service.onApplicationBootstrap();
      jest.runOnlyPendingTimers();
      await Promise.resolve();

      expect(updateIfDue).toHaveBeenCalledTimes(1);
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
