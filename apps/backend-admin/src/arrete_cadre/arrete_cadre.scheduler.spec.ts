import { ArreteCadreService } from './arrete_cadre.service';
import {
  ArreteCadreScheduler,
  HISTORIC_CATCHUP_ENABLED_ENV,
  isHistoricCatchupEnabled,
} from './arrete_cadre.scheduler';
import {
  BUSINESS_SCHEDULER_PROCESS_ENV,
  CURRENT_ZONE_RECOMPUTE_WORKER_ENABLED_ENV,
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

  it('propagates an explicit legacy scheduled date to the restriction update', async () => {
    const transactionRepository = {
      query: jest.fn().mockResolvedValue([]),
    };
    const repository = {
      manager: {
        transaction: jest.fn(async (_isolation, callback) =>
          callback({ getRepository: () => transactionRepository }),
        ),
      },
    };
    const arreteRestrictionService = {
      updateArreteRestrictionStatut: jest.fn().mockResolvedValue('processed'),
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

    await service.updateArreteCadreStatut(false, undefined, '2026-08-01');

    expect(
      arreteRestrictionService.updateArreteRestrictionStatut,
    ).toHaveBeenCalledWith(null, false, undefined, '2026-08-01');
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
  const previousStatisticCacheRequired =
    process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED;
  const previousHistoricCatchupEnabled =
    process.env[HISTORIC_CATCHUP_ENABLED_ENV];
  const previousCurrentZoneWorkerEnabled =
    process.env[CURRENT_ZONE_RECOMPUTE_WORKER_ENABLED_ENV];
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
    process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED = 'false';
    delete process.env[HISTORIC_CATCHUP_ENABLED_ENV];
    delete process.env[CURRENT_ZONE_RECOMPUTE_WORKER_ENABLED_ENV];
  });

  afterAll(() => {
    if (previousPublicationEnabled === undefined) {
      delete process.env.ZONE_PUBLICATION_ENABLED;
    } else {
      process.env.ZONE_PUBLICATION_ENABLED = previousPublicationEnabled;
    }
    if (previousStatisticCacheRequired === undefined) {
      delete process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED;
    } else {
      process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED =
        previousStatisticCacheRequired;
    }
    if (previousHistoricCatchupEnabled === undefined) {
      delete process.env[HISTORIC_CATCHUP_ENABLED_ENV];
    } else {
      process.env[HISTORIC_CATCHUP_ENABLED_ENV] =
        previousHistoricCatchupEnabled;
    }
    if (previousCurrentZoneWorkerEnabled === undefined) {
      delete process.env[CURRENT_ZONE_RECOMPUTE_WORKER_ENABLED_ENV];
    } else {
      process.env[CURRENT_ZONE_RECOMPUTE_WORKER_ENABLED_ENV] =
        previousCurrentZoneWorkerEnabled;
    }
  });

  const createScheduler = () => {
    const completedRunMetadata: unknown[] = [];
    const arreteCadreService = {
      updateArreteCadreStatut: jest.fn().mockResolvedValue('processed'),
      assertLegacyDailyComputationCompleted: jest
        .fn()
        .mockResolvedValue({ sourceRevision: '42' }),
      assertVersionedDailyComputationReady: jest
        .fn()
        .mockResolvedValue(undefined),
      catchUpHistoricComputations: jest
        .fn()
        .mockResolvedValue(historicCursorState),
      prepareHistoricComputations: jest.fn().mockResolvedValue(undefined),
      recoverIncompleteHistoricComputations: jest.fn().mockResolvedValue([]),
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
      hasSucceeded: jest.fn().mockResolvedValue(true),
    };
    const zonePublicationService = {
      getSourceRevision: jest.fn().mockResolvedValue('42'),
      findReusableDailyPublication: jest.fn().mockResolvedValue({
        publicationId: 'publication-1',
        sourceRevision: '42',
      }),
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
    return {
      service: new ArreteCadreScheduler(
        arreteCadreService as never,
        registry as never,
        zonePublicationService as never,
        configService as never,
        statisticCacheReadiness as never,
      ),
      arreteCadreService,
      registry,
      zonePublicationService,
      configService,
      statisticCacheReadiness,
      completedRunMetadata,
    };
  };

  it.each([
    [undefined, true],
    ['true', true],
    [' TRUE ', true],
    ['false', false],
    [' False ', false],
  ])('parses the historic catch-up switch %p', (value, expected) => {
    expect(isHistoricCatchupEnabled(value)).toBe(expected);
  });

  it.each(['', '1', 'yes', 'enabled'])(
    'rejects the invalid historic catch-up switch %p',
    (value) => {
      expect(() => isHistoricCatchupEnabled(value)).toThrow(
        `${HISTORIC_CATCHUP_ENABLED_ENV} must be true or false`,
      );
    },
  );

  it('promotes the current publication while historic catch-up is paused', async () => {
    process.env[HISTORIC_CATCHUP_ENABLED_ENV] = 'false';
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED = 'true';
    const harness = createScheduler();
    harness.arreteCadreService.updateArreteCadreStatut.mockResolvedValue({
      result: {
        publicationId: 'publication-1',
        sourceRevision: '42',
      },
    });
    const now = new Date('2026-08-17T14:00:00Z');

    await harness.service.updateIfDue(now);

    expect(harness.registry.executeDailyRun).toHaveBeenCalledTimes(1);
    expect(
      harness.arreteCadreService.prepareHistoricComputations,
    ).not.toHaveBeenCalled();
    expect(
      harness.arreteCadreService.recoverIncompleteHistoricComputations,
    ).not.toHaveBeenCalled();
    expect(
      harness.statisticCacheReadiness.getReadyPublication,
    ).not.toHaveBeenCalled();
    expect(
      harness.arreteCadreService.catchUpHistoricComputations,
    ).not.toHaveBeenCalled();
    expect(
      harness.zonePublicationService.promoteCertifiedPublicationIfAvailable,
    ).toHaveBeenCalledWith({
      scheduledFor: '2026-08-17',
      sourceRevision: '42',
      preferredPublicationId: 'publication-1',
    });
  });

  it('lets the clock enqueue once and records completion only after the dedicated worker finishes', async () => {
    process.env[CURRENT_ZONE_RECOMPUTE_WORKER_ENABLED_ENV] = 'true';
    const harness = createScheduler();
    harness.arreteCadreService.assertLegacyDailyComputationCompleted
      .mockRejectedValueOnce(new Error('daily computation pending'))
      .mockResolvedValue({ sourceRevision: '42' });
    const now = new Date('2026-08-17T14:00:00Z');

    await harness.service.updateIfDue(now);

    expect(
      harness.arreteCadreService.updateArreteCadreStatut,
    ).toHaveBeenCalledTimes(1);
    expect(
      harness.arreteCadreService.updateArreteCadreStatut,
    ).toHaveBeenCalledWith(false, undefined, '2026-08-17');
    expect(
      harness.registry.executeDailyRun.mock.calls.filter(
        ([jobKey]) => jobKey === NATIONAL_DAILY_COMPUTE_JOB_KEY,
      ),
    ).toHaveLength(0);

    await harness.service.updateIfDue(now);

    expect(
      harness.arreteCadreService.updateArreteCadreStatut,
    ).toHaveBeenCalledTimes(1);
    expect(
      harness.registry.executeDailyRun.mock.calls.filter(
        ([jobKey]) => jobKey === NATIONAL_DAILY_COMPUTE_JOB_KEY,
      ),
    ).toHaveLength(1);
  });

  it('keeps the versioned clock enqueue-only until the dedicated worker produces a certified publication', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    process.env[CURRENT_ZONE_RECOMPUTE_WORKER_ENABLED_ENV] = 'true';
    const harness = createScheduler();
    harness.zonePublicationService.findReusableDailyPublication.mockResolvedValue(
      null,
    );
    const now = new Date('2026-08-17T14:00:00Z');

    await harness.service.updateIfDue(now);

    expect(
      harness.arreteCadreService.updateArreteCadreStatut,
    ).toHaveBeenCalledTimes(1);
    expect(
      harness.arreteCadreService.updateArreteCadreStatut,
    ).toHaveBeenCalledWith(false, undefined, '2026-08-17');
    expect(
      harness.registry.executeDailyRun.mock.calls.filter(
        ([jobKey]) => jobKey === NATIONAL_DAILY_COMPUTE_JOB_KEY,
      ),
    ).toHaveLength(0);
  });

  it('records a versioned daily success by reusing the publication certified by the worker', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    process.env[CURRENT_ZONE_RECOMPUTE_WORKER_ENABLED_ENV] = 'true';
    const harness = createScheduler();
    const now = new Date('2026-08-17T14:00:00Z');

    await harness.service.updateIfDue(now);

    expect(
      harness.zonePublicationService.findReusableDailyPublication,
    ).toHaveBeenCalledWith({
      scheduledFor: '2026-08-17',
      sourceRevision: '42',
    });
    expect(
      harness.arreteCadreService.updateArreteCadreStatut,
    ).not.toHaveBeenCalled();
    expect(harness.completedRunMetadata[0]).toEqual({
      publicationId: 'publication-1',
      sourceRevision: '42',
      materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
    });
  });

  it('fails the historic branch closed on an invalid switch after daily succeeds', async () => {
    process.env[HISTORIC_CATCHUP_ENABLED_ENV] = 'invalid';
    const harness = createScheduler();

    await expect(
      harness.service.updateIfDue(new Date('2026-08-17T14:00:00Z')),
    ).rejects.toThrow(`${HISTORIC_CATCHUP_ENABLED_ENV} must be true or false`);

    expect(
      harness.arreteCadreService.updateArreteCadreStatut,
    ).toHaveBeenCalledTimes(1);
    expect(
      harness.arreteCadreService.catchUpHistoricComputations,
    ).not.toHaveBeenCalled();
  });

  it('allows cron reentry so a new daily date is not hidden by historic work', () => {
    expect(
      Reflect.getMetadata(
        'SCHEDULE_CRON_OPTIONS',
        ArreteCadreScheduler.prototype.updateIfDue,
      ),
    ).toMatchObject({ waitForCompletion: false });
  });

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
        {
          identity: {
            publicationMode: 'legacy',
            sourceRevision: '42',
          },
        },
      );
      expect(
        harness.arreteCadreService.updateArreteCadreStatut,
      ).toHaveBeenCalledWith(false, undefined, expectedDate);
      expect(
        harness.arreteCadreService.catchUpHistoricComputations,
      ).toHaveBeenCalledWith(
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        '42',
      );
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
      {
        identity: {
          publicationMode: 'legacy',
          sourceRevision: '42',
          ...historicRunIdentity,
        },
      },
    );
  });

  it('repairs an orphaned prior-day snapshot before artifact and Datagouv gates after rollover', async () => {
    process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED = 'true';
    const harness = createScheduler();
    harness.arreteCadreService.recoverIncompleteHistoricComputations.mockResolvedValue(
      ['2026-07-30'],
    );
    const now = new Date('2026-08-01T08:00:00Z');

    await harness.service.updateIfDue(now);

    expect(
      harness.arreteCadreService.prepareHistoricComputations,
    ).toHaveBeenCalledWith('2026-07-31', '42');
    expect(
      harness.arreteCadreService.recoverIncompleteHistoricComputations,
    ).toHaveBeenCalledWith('2026-07-31', '42');
    expect(
      harness.arreteCadreService.recoverIncompleteHistoricComputations.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      harness.statisticCacheReadiness.getReadyPublication.mock
        .invocationCallOrder[0],
    );
    expect(
      harness.statisticCacheReadiness.getReadyPublication.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      harness.arreteCadreService.catchUpHistoricComputations.mock
        .invocationCallOrder[0],
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

  it('does not record a daily success while the current queue is busy', async () => {
    const harness = createScheduler();
    harness.arreteCadreService.updateArreteCadreStatut.mockResolvedValue(
      'busy',
    );

    await expect(
      harness.service.updateIfDue(new Date('2026-08-01T08:00:00Z')),
    ).rejects.toThrow('Current zone recompute queue is busy');

    expect(
      harness.arreteCadreService.assertLegacyDailyComputationCompleted,
    ).not.toHaveBeenCalled();
    expect(
      harness.arreteCadreService.catchUpHistoricComputations,
    ).not.toHaveBeenCalled();
  });

  it('starts the new daily date while the previous historic catch-up is running', async () => {
    const harness = createScheduler();
    let releaseHistoric!: (value: typeof historicCursorState) => void;
    harness.arreteCadreService.catchUpHistoricComputations.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseHistoric = resolve;
      }),
    );

    const previousDate = harness.service.updateIfDue(
      new Date('2026-08-13T08:00:00Z'),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      harness.arreteCadreService.catchUpHistoricComputations,
    ).toHaveBeenCalledTimes(1);

    await harness.service.updateIfDue(new Date('2026-08-14T08:00:00Z'));

    const dailyDates = harness.registry.executeDailyRun.mock.calls
      .filter(([jobKey]) => jobKey === NATIONAL_DAILY_COMPUTE_JOB_KEY)
      .map(([, scheduledFor]) => scheduledFor);
    expect(dailyDates).toEqual(['2026-08-13', '2026-08-14']);
    expect(
      harness.arreteCadreService.updateArreteCadreStatut,
    ).toHaveBeenCalledWith(false, undefined, '2026-08-14');

    releaseHistoric(historicCursorState);
    await previousDate;
  });

  it('prepares the new legacy artifact boundary before deferring to an older historic run', async () => {
    process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED = 'true';
    const harness = createScheduler();
    let releaseHistoric!: (value: typeof historicCursorState) => void;
    harness.arreteCadreService.catchUpHistoricComputations.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseHistoric = resolve;
      }),
    );

    const previousDate = harness.service.updateIfDue(
      new Date('2026-08-13T08:00:00Z'),
    );
    await new Promise((resolve) => setImmediate(resolve));
    await harness.service.updateIfDue(new Date('2026-08-14T08:00:00Z'));

    expect(
      harness.arreteCadreService.prepareHistoricComputations.mock.calls,
    ).toEqual([
      ['2026-08-12', '42'],
      ['2026-08-13', '42'],
    ]);
    expect(
      harness.arreteCadreService.recoverIncompleteHistoricComputations.mock
        .calls,
    ).toEqual([
      ['2026-08-12', '42'],
      ['2026-08-13', '42'],
    ]);
    expect(
      harness.statisticCacheReadiness.getReadyPublication,
    ).toHaveBeenCalledTimes(1);

    releaseHistoric(historicCursorState);
    await previousDate;
  });

  it('does not repeat boundary preparation while the same historic date is running', async () => {
    process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED = 'true';
    const harness = createScheduler();
    let releaseHistoric!: (value: typeof historicCursorState) => void;
    harness.arreteCadreService.catchUpHistoricComputations.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseHistoric = resolve;
      }),
    );

    const firstTick = harness.service.updateIfDue(
      new Date('2026-08-13T08:00:00Z'),
    );
    await new Promise((resolve) => setImmediate(resolve));
    await harness.service.updateIfDue(new Date('2026-08-13T08:05:00Z'));
    await harness.service.updateIfDue(new Date('2026-08-13T08:10:00Z'));

    expect(
      harness.arreteCadreService.prepareHistoricComputations,
    ).toHaveBeenCalledTimes(1);
    expect(
      harness.arreteCadreService.recoverIncompleteHistoricComputations,
    ).toHaveBeenCalledTimes(1);

    releaseHistoric(historicCursorState);
    await firstTick;
  });

  it('deduplicates concurrent rollover boundary preparation', async () => {
    process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED = 'true';
    const harness = createScheduler();
    let releaseHistoric!: (value: typeof historicCursorState) => void;
    let releaseBoundary!: () => void;
    harness.arreteCadreService.catchUpHistoricComputations.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseHistoric = resolve;
      }),
    );
    harness.arreteCadreService.prepareHistoricComputations.mockImplementation(
      async (requiredThrough: string) => {
        if (requiredThrough === '2026-08-13') {
          await new Promise<void>((resolve) => {
            releaseBoundary = resolve;
          });
        }
      },
    );

    const previousDate = harness.service.updateIfDue(
      new Date('2026-08-13T08:00:00Z'),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const firstRollover = harness.service.updateIfDue(
      new Date('2026-08-14T08:00:00Z'),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const secondRollover = harness.service.updateIfDue(
      new Date('2026-08-14T08:05:00Z'),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      harness.arreteCadreService.prepareHistoricComputations.mock.calls.filter(
        ([requiredThrough]) => requiredThrough === '2026-08-13',
      ),
    ).toHaveLength(1);

    releaseBoundary();
    await Promise.all([firstRollover, secondRollover]);
    expect(
      harness.arreteCadreService.recoverIncompleteHistoricComputations.mock.calls.filter(
        ([requiredThrough]) => requiredThrough === '2026-08-13',
      ),
    ).toHaveLength(1);

    releaseHistoric(historicCursorState);
    await previousDate;
  });

  it('does not overlap startup catch-up and cron execution', async () => {
    const harness = createScheduler();
    let releaseCurrent: (result: string) => void;
    const currentPending = new Promise<string>((resolve) => {
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
    await expect(cronRun).resolves.toBeUndefined();
    releaseCurrent!('processed');
    await startupCatchUp;

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

  it('keeps the versioned pipeline independent from the required legacy artifact gate', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED = 'true';
    const harness = createScheduler();
    harness.arreteCadreService.updateArreteCadreStatut.mockResolvedValue({
      result: {
        publicationId: 'publication-1',
        sourceRevision: '42',
      },
    });

    await harness.service.updateIfDue(new Date('2026-08-01T08:00:00Z'));

    expect(
      harness.arreteCadreService.prepareHistoricComputations,
    ).not.toHaveBeenCalled();
    expect(
      harness.arreteCadreService.recoverIncompleteHistoricComputations,
    ).not.toHaveBeenCalled();
    expect(
      harness.statisticCacheReadiness.getReadyPublication,
    ).not.toHaveBeenCalled();
    expect(
      harness.statisticCacheReadiness.assertReadyPublication,
    ).not.toHaveBeenCalled();
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

  it('promotes the validated publication before a busy historic catch-up', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const harness = createScheduler();
    harness.registry.executeDailyRun
      .mockResolvedValueOnce('already_succeeded')
      .mockResolvedValueOnce('busy');

    await harness.service.updateIfDue(new Date('2026-08-01T08:00:00Z'));

    expect(
      harness.zonePublicationService.promoteCertifiedPublicationIfAvailable,
    ).toHaveBeenCalledWith({
      scheduledFor: '2026-08-01',
      sourceRevision: '42',
      preferredPublicationId: 'publication-1',
    });
    expect(
      harness.zonePublicationService.promoteCertifiedPublicationIfAvailable.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      harness.registry.executeDailyRun.mock.invocationCallOrder[1],
    );
  });

  it('does not start historic catch-up when current candidacy is rejected', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const harness = createScheduler();
    harness.arreteCadreService.updateArreteCadreStatut.mockResolvedValue({
      result: {
        publicationId: 'publication-1',
        sourceRevision: '42',
      },
    });
    harness.zonePublicationService.promoteCertifiedPublicationIfAvailable.mockResolvedValue(
      false,
    );

    await expect(
      harness.service.updateIfDue(new Date('2026-08-01T08:00:00Z')),
    ).rejects.toThrow(
      'Zone publication publication-1 was superseded before candidacy',
    );

    expect(harness.registry.executeDailyRun).toHaveBeenCalledTimes(1);
    expect(
      harness.arreteCadreService.catchUpHistoricComputations,
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
    ).toHaveBeenCalledWith({
      scheduledFor: '2026-08-01',
      sourceRevision: '42',
      preferredPublicationId: 'publication-1',
    });
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
