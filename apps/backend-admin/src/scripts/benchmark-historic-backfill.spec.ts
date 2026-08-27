import {
  assertHistoricBackfillBenchmarkConnectedDatabase,
  assertHistoricBackfillBenchmarkEnvironment,
  assertHistoricBackfillBenchmarkSentinel,
  HistoricBackfillArtifactDuration,
  HistoricBackfillBenchmarkDependencies,
  HistoricBackfillBenchmarkEnvironment,
  HistoricBackfillBenchmarkMetrics,
  HistoricBackfillBenchmarkOptions,
  HistoricBackfillBenchmarkPreflightClient,
  HistoricBackfillBenchmarkRun,
  loadHistoricBackfillBenchmarkAfterPreflight,
  parseHistoricBackfillBenchmarkOptions,
  preflightHistoricBackfillBenchmark,
  readHistoricBackfillBenchmarkSentinelNonces,
  runHistoricBackfillCloneMigrations,
  runHistoricBackfillBenchmark,
  summarizeHistoricBackfillArtifactDurations,
} from './benchmark-historic-backfill';

const RUN_ID = '5a4c3c44-5232-4edf-a067-a700d5f268c3';
const DATABASE_NAME = 'vigieau_benchmark_clone_20260820';
const SENTINEL_NONCE = '9d96adfc-8299-4a56-8a8d-c629454399a9';

const run: HistoricBackfillBenchmarkRun = {
  id: RUN_ID,
  status: 'running',
  mapDateFrom: '2024-01-01',
  statisticDateFrom: '2024-01-01',
  dateThrough: '2026-08-19',
  sourceRevision: '12',
  historicComputeEpoch: '4',
  baseStatisticRevision: '7',
};

function options(
  overrides: Partial<HistoricBackfillBenchmarkOptions> = {},
): HistoricBackfillBenchmarkOptions {
  return {
    mode: 'dry-run-stats',
    runId: RUN_ID,
    pollMs: 1_000,
    timeoutMs: 10_000,
    applyStatistics: false,
    ...overrides,
  };
}

function benchmarkEnvironment(
  overrides: Partial<HistoricBackfillBenchmarkEnvironment> = {},
): HistoricBackfillBenchmarkEnvironment {
  return {
    allowedDatabaseName: DATABASE_NAME,
    configuredDatabaseName: DATABASE_NAME,
    sentinelNonce: SENTINEL_NONCE,
    allowStatisticsApply: false,
    historicBackfillEnabled: false,
    ...overrides,
  };
}

interface ArtifactCounts {
  total: number;
  completed: number;
  failed: number;
  leased: number;
}

function metrics(
  completedDepartments = 101,
  artifactCounts: ArtifactCounts = {
    total: 0,
    completed: 0,
    failed: 0,
    leased: 0,
  },
): HistoricBackfillBenchmarkMetrics {
  return {
    capturedAt: '2026-08-20T08:00:00.000Z',
    postgres: {
      serverVersion: '17.5',
      databaseBytes: '1000',
      walBytes: '2000',
      walRecords: '300',
      walFpi: '10',
      tempBytes: '4000',
      tempFiles: '5',
      blockReadTimeMs: '6',
      blockWriteTimeMs: '7',
      connections: 5,
      maxConnections: 100,
      activeConnections: 1,
      idleConnections: 4,
      idleInTransactionConnections: 0,
      waitingConnections: 0,
    },
    waits: [],
    tableSizes: [
      {
        tableName: 'historic_backfill_commune_shadow',
        estimatedRows: '34943',
        relationBytes: '800',
        indexBytes: '200',
        totalBytes: '1000',
      },
    ],
    run,
    runCounts: {
      taskCount: 101,
      pendingTaskCount: 101 - completedDepartments,
      leasedTaskCount: 0,
      completedTaskCount: completedDepartments,
      failedTaskCount: 0,
      currentGenerationTaskCount: 101,
      currentGenerationCompletedTaskCount: completedDepartments,
      reportedCommuneSegmentCount: 1_000,
      reportedCommuneCount: completedDepartments * 300,
      departmentSegmentCount: 2_000,
      shadowCommuneCount: 34_943,
      artifactTaskCount: artifactCounts.total,
      pendingArtifactTaskCount:
        artifactCounts.total -
        artifactCounts.completed -
        artifactCounts.failed -
        artifactCounts.leased,
      leasedArtifactTaskCount: artifactCounts.leased,
      completedArtifactTaskCount: artifactCounts.completed,
      failedArtifactTaskCount: artifactCounts.failed,
      manifestOutboxCount: 0,
    },
    departmentDurations: {
      completedCount: completedDepartments,
      minMs: completedDepartments ? 100 : null,
      medianMs: completedDepartments ? 200 : null,
      p95Ms: completedDepartments ? 300 : null,
      maxMs: completedDepartments ? 400 : null,
      averageMs: completedDepartments ? 220 : null,
      departments: [],
    },
    artifactDurations: {
      completedCount: artifactCounts.completed,
      p50Ms: artifactCounts.completed ? 1_000 : null,
      p95Ms: artifactCounts.completed ? 2_000 : null,
      maxMs: artifactCounts.completed ? 3_000 : null,
      artifacts: [],
    },
  };
}

function dependencies(
  metricValues: HistoricBackfillBenchmarkMetrics[],
): HistoricBackfillBenchmarkDependencies & {
  events: Array<Record<string, unknown>>;
  finalizer: {
    buildShadow: jest.Mock;
    dryRun: jest.Mock;
    apply: jest.Mock;
  };
  prepareRun: jest.Mock;
  prepareArtifacts: jest.Mock;
  collectMetrics: jest.Mock;
} {
  let now = 0;
  let metricIndex = 0;
  const events: Array<Record<string, unknown>> = [];
  const finalizer = {
    buildShadow: jest.fn().mockResolvedValue({ departmentCount: 101 }),
    dryRun: jest.fn().mockResolvedValue({ applied: false }),
    apply: jest.fn().mockResolvedValue({ applied: true }),
  };
  return {
    events,
    finalizer,
    readConnectedDatabaseName: jest.fn().mockResolvedValue(DATABASE_NAME),
    readBenchmarkSentinelNonces: jest.fn().mockResolvedValue([SENTINEL_NONCE]),
    readRun: jest.fn().mockResolvedValue(run),
    collectMetrics: jest.fn().mockImplementation(async () => {
      const value =
        metricValues[Math.min(metricIndex, metricValues.length - 1)];
      metricIndex += 1;
      return value;
    }),
    prepareRun: jest.fn().mockResolvedValue(run),
    prepareArtifacts: jest.fn().mockResolvedValue({ taskCount: 12 }),
    emit: (event) => events.push(event),
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
  };
}

describe('parseHistoricBackfillBenchmarkOptions', () => {
  it('parses bounded defaults and keeps statistics apply disabled', () => {
    expect(
      parseHistoricBackfillBenchmarkOptions([
        '--mode',
        'dry-run',
        '--run-id',
        RUN_ID,
      ]),
    ).toEqual({
      mode: 'dry-run-stats',
      runId: RUN_ID,
      pollMs: 15_000,
      timeoutMs: 86_400_000,
      applyStatistics: false,
    });
  });

  it('accepts the explicit statistics apply CLI opt-in', () => {
    expect(
      parseHistoricBackfillBenchmarkOptions([
        '--mode',
        'dry-run-stats',
        '--run-id',
        RUN_ID,
        '--apply-statistics',
      ]).applyStatistics,
    ).toBe(true);
  });

  it('accepts the passive artifact wait mode', () => {
    expect(
      parseHistoricBackfillBenchmarkOptions([
        '--mode',
        'wait-artifacts',
        '--run-id',
        RUN_ID,
      ]).mode,
    ).toBe('wait-artifacts');
  });

  it('parses a prepare-run range without requiring an existing run id', () => {
    expect(
      parseHistoricBackfillBenchmarkOptions([
        '--mode',
        'prepare-run',
        '--map-date-from',
        '2011-06-07',
        '--statistic-date-from',
        '2011-06-07',
        '--date-through',
        '2026-08-19',
      ]),
    ).toEqual({
      mode: 'prepare-run',
      range: {
        mapDateFrom: '2011-06-07',
        statisticDateFrom: '2011-06-07',
        dateThrough: '2026-08-19',
      },
      pollMs: 15_000,
      timeoutMs: 86_400_000,
      applyStatistics: false,
    });
  });

  it('accepts prepare-artifacts with an existing run id', () => {
    expect(
      parseHistoricBackfillBenchmarkOptions([
        '--mode',
        'prepare-artifacts',
        '--run-id',
        RUN_ID,
      ]).mode,
    ).toBe('prepare-artifacts');
  });

  it('refuses incomplete, invalid, or misplaced prepare ranges', () => {
    expect(() =>
      parseHistoricBackfillBenchmarkOptions([
        '--mode',
        'prepare-run',
        '--map-date-from',
        '2011-06-07',
        '--statistic-date-from',
        '2011-06-07',
      ]),
    ).toThrow('Missing required argument: --date-through');
    expect(() =>
      parseHistoricBackfillBenchmarkOptions([
        '--mode',
        'prepare-run',
        '--map-date-from',
        '2011-02-29',
        '--statistic-date-from',
        '2011-06-07',
        '--date-through',
        '2026-08-19',
      ]),
    ).toThrow('--map-date-from must be a valid civil date');
    expect(() =>
      parseHistoricBackfillBenchmarkOptions([
        '--mode',
        'wait-staging',
        '--run-id',
        RUN_ID,
        '--date-through',
        '2026-08-19',
      ]),
    ).toThrow('date range arguments are only valid');
  });

  it('refuses statistics apply outside the statistics mode', () => {
    expect(() =>
      parseHistoricBackfillBenchmarkOptions([
        '--mode',
        'build-shadow',
        '--run-id',
        RUN_ID,
        '--apply-statistics',
      ]),
    ).toThrow('--apply-statistics is only valid');
  });

  it.each([
    ['--poll-ms', '999'],
    ['--poll-ms', '300001'],
    ['--timeout-ms', '9999'],
    ['--timeout-ms', '259200001'],
  ])('refuses out-of-range %s=%s', (argument, value) => {
    expect(() =>
      parseHistoricBackfillBenchmarkOptions([
        '--mode',
        'wait-staging',
        '--run-id',
        RUN_ID,
        argument,
        value,
      ]),
    ).toThrow('must be between');
  });
});

describe('historic backfill benchmark clone guard', () => {
  const cloneEnvironment: NodeJS.ProcessEnv = {
    HISTORIC_BACKFILL_BENCHMARK_CLONE: 'I_CONFIRM_DISPOSABLE_CLONE',
    HISTORIC_BACKFILL_BENCHMARK_ALLOWED_DATABASE_NAME: DATABASE_NAME,
    HISTORIC_BACKFILL_BENCHMARK_SENTINEL: SENTINEL_NONCE,
    DATABASE_NAME,
    SCALINGO_APP: 'regleau-back-benchmark',
  };

  it('accepts an explicitly named disposable clone', () => {
    expect(
      assertHistoricBackfillBenchmarkEnvironment(cloneEnvironment),
    ).toEqual({
      allowedDatabaseName: DATABASE_NAME,
      configuredDatabaseName: DATABASE_NAME,
      sentinelNonce: SENTINEL_NONCE,
      allowStatisticsApply: false,
      historicBackfillEnabled: false,
    });
  });

  it('requires the exact clone confirmation', () => {
    expect(() =>
      assertHistoricBackfillBenchmarkEnvironment({
        ...cloneEnvironment,
        HISTORIC_BACKFILL_BENCHMARK_CLONE: 'true',
      }),
    ).toThrow('I_CONFIRM_DISPOSABLE_CLONE');
  });

  it('requires a UUID sentinel nonce', () => {
    expect(() =>
      assertHistoricBackfillBenchmarkEnvironment({
        ...cloneEnvironment,
        HISTORIC_BACKFILL_BENCHMARK_SENTINEL: 'not-a-uuid',
      }),
    ).toThrow('HISTORIC_BACKFILL_BENCHMARK_SENTINEL must be a UUID');
  });

  it('refuses an unauthorized database name', () => {
    expect(() =>
      assertHistoricBackfillBenchmarkEnvironment({
        ...cloneEnvironment,
        DATABASE_NAME: 'another_database',
      }),
    ).toThrow('does not match');
    expect(() =>
      assertHistoricBackfillBenchmarkConnectedDatabase(
        'another_database',
        DATABASE_NAME,
      ),
    ).toThrow('not the explicitly allowed benchmark clone');
  });

  it.each([
    { SCALINGO_APP: 'regleau-back-prod' },
    { APP_ENV: 'production' },
    {
      DATABASE_NAME: 'vigieau-prod',
      HISTORIC_BACKFILL_BENCHMARK_ALLOWED_DATABASE_NAME: 'vigieau-prod',
    },
  ])('refuses production identifiers', (override) => {
    expect(() =>
      assertHistoricBackfillBenchmarkEnvironment({
        ...cloneEnvironment,
        ...override,
      }),
    ).toThrow('Production');
  });

  it('reads the independent environment opt-in for statistics apply', () => {
    expect(
      assertHistoricBackfillBenchmarkEnvironment({
        ...cloneEnvironment,
        HISTORIC_BACKFILL_BENCHMARK_ALLOW_APPLY: 'true',
      }).allowStatisticsApply,
    ).toBe(true);
  });

  it('reads the backfill enable flag independently from the clone guards', () => {
    expect(
      assertHistoricBackfillBenchmarkEnvironment({
        ...cloneEnvironment,
        HISTORIC_BACKFILL_ENABLED: 'true',
      }).historicBackfillEnabled,
    ).toBe(true);
  });
});

describe('historic backfill benchmark preflight', () => {
  function client(
    events: string[],
    overrides: { databaseName?: string; nonces?: string[] } = {},
  ): HistoricBackfillBenchmarkPreflightClient {
    return {
      connect: jest.fn(async () => {
        events.push('connect');
      }),
      query: jest.fn(async (sql: string) => {
        if (sql.includes('current_database()')) {
          events.push('database');
          return [{ databaseName: overrides.databaseName ?? DATABASE_NAME }];
        }
        events.push('sentinel');
        return (overrides.nonces ?? [SENTINEL_NONCE]).map((nonce) => ({
          nonce,
        }));
      }),
      end: jest.fn(async () => {
        events.push('end');
      }),
    };
  }

  it('checks the database and exact sentinel before loading Nest', async () => {
    const events: string[] = [];
    const loadApplication = jest.fn(async () => {
      events.push('load-application');
      return 'application';
    });

    await expect(
      loadHistoricBackfillBenchmarkAfterPreflight(
        benchmarkEnvironment(),
        () => client(events),
        loadApplication,
      ),
    ).resolves.toBe('application');

    expect(events).toEqual([
      'connect',
      'database',
      'sentinel',
      'end',
      'load-application',
    ]);
  });

  it('closes the minimal client and never loads Nest on sentinel mismatch', async () => {
    const events: string[] = [];
    const loadApplication = jest.fn();

    await expect(
      loadHistoricBackfillBenchmarkAfterPreflight(
        benchmarkEnvironment(),
        () =>
          client(events, {
            nonces: ['cbeb6d83-fb40-47a8-83b5-95684f5de591'],
          }),
        loadApplication,
      ),
    ).rejects.toThrow('sentinel nonce does not match');

    expect(events).toEqual(['connect', 'database', 'sentinel', 'end']);
    expect(loadApplication).not.toHaveBeenCalled();
  });

  it('fails closed and closes the client when the sentinel table is absent', async () => {
    const end = jest.fn().mockResolvedValue(undefined);
    await expect(
      preflightHistoricBackfillBenchmark(benchmarkEnvironment(), () => ({
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest
          .fn()
          .mockResolvedValueOnce([{ databaseName: DATABASE_NAME }])
          .mockRejectedValueOnce(new Error('relation does not exist')),
        end,
      })),
    ).rejects.toThrow('Historic benchmark sentinel table is unavailable');
    expect(end).toHaveBeenCalledTimes(1);
  });
});

describe('historic backfill clone migrations', () => {
  function migrationRunner(nonces = [SENTINEL_NONCE]) {
    return {
      initialize: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(async (sql: string) =>
        sql.includes('current_database()')
          ? [{ databaseName: DATABASE_NAME }]
          : nonces.map((nonce) => ({ nonce })),
      ),
      runMigrations: jest
        .fn()
        .mockResolvedValue([
          { name: 'HistoricBackfillControlPlane1787144400000' },
        ]),
      destroy: jest.fn().mockResolvedValue(undefined),
    };
  }

  it('double-checks the clone sentinel around migrations and closes the pool', async () => {
    const runner = migrationRunner();
    const emit = jest.fn();

    await expect(
      runHistoricBackfillCloneMigrations(benchmarkEnvironment(), runner, emit),
    ).resolves.toEqual(
      expect.objectContaining({
        type: 'historic_backfill_benchmark_migrations_complete',
        appliedCount: 1,
      }),
    );

    expect(runner.runMigrations).toHaveBeenCalledTimes(1);
    expect(runner.query).toHaveBeenCalledTimes(4);
    expect(runner.destroy).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('does not run migrations when the connected sentinel is wrong', async () => {
    const runner = migrationRunner(['cbeb6d83-fb40-47a8-83b5-95684f5de591']);

    await expect(
      runHistoricBackfillCloneMigrations(
        benchmarkEnvironment(),
        runner,
        jest.fn(),
      ),
    ).rejects.toThrow('sentinel nonce does not match');

    expect(runner.runMigrations).not.toHaveBeenCalled();
    expect(runner.destroy).toHaveBeenCalledTimes(1);
  });

  it('does not initialize migrations while the backfill is enabled', async () => {
    const runner = migrationRunner();

    await expect(
      runHistoricBackfillCloneMigrations(
        benchmarkEnvironment({ historicBackfillEnabled: true }),
        runner,
        jest.fn(),
      ),
    ).rejects.toThrow('migrate-clone requires HISTORIC_BACKFILL_ENABLED=false');

    expect(runner.initialize).not.toHaveBeenCalled();
    expect(runner.runMigrations).not.toHaveBeenCalled();
    expect(runner.destroy).not.toHaveBeenCalled();
  });
});

describe('runHistoricBackfillBenchmark', () => {
  it('fails closed on a missing or mismatched clone sentinel', async () => {
    const missingRuntime = dependencies([metrics()]);
    missingRuntime.readBenchmarkSentinelNonces = jest
      .fn()
      .mockResolvedValue([]);
    await expect(
      runHistoricBackfillBenchmark(
        options(),
        benchmarkEnvironment(),
        missingRuntime,
      ),
    ).rejects.toThrow('sentinel must contain exactly one row, got 0');
    expect(missingRuntime.finalizer.dryRun).not.toHaveBeenCalled();

    const mismatchedRuntime = dependencies([metrics()]);
    mismatchedRuntime.readBenchmarkSentinelNonces = jest
      .fn()
      .mockResolvedValue(['cbeb6d83-fb40-47a8-83b5-95684f5de591']);
    await expect(
      runHistoricBackfillBenchmark(
        options(),
        benchmarkEnvironment(),
        mismatchedRuntime,
      ),
    ).rejects.toThrow('sentinel nonce does not match');
    expect(mismatchedRuntime.finalizer.dryRun).not.toHaveBeenCalled();
  });

  it('accepts exactly one matching clone sentinel', () => {
    expect(() =>
      assertHistoricBackfillBenchmarkSentinel([SENTINEL_NONCE], SENTINEL_NONCE),
    ).not.toThrow();
  });

  it('prepares a run directly only when the backfill flag is enabled', async () => {
    const range = {
      mapDateFrom: '2011-06-07',
      statisticDateFrom: '2011-06-07',
      dateThrough: '2026-08-19',
    };
    const blockedRuntime = dependencies([metrics()]);
    await expect(
      runHistoricBackfillBenchmark(
        options({ mode: 'prepare-run', runId: undefined, range }),
        benchmarkEnvironment(),
        blockedRuntime,
      ),
    ).rejects.toThrow('prepare-run requires HISTORIC_BACKFILL_ENABLED=true');
    expect(blockedRuntime.prepareRun).not.toHaveBeenCalled();

    const runtime = dependencies([metrics()]);
    const result = await runHistoricBackfillBenchmark(
      options({ mode: 'prepare-run', runId: undefined, range }),
      benchmarkEnvironment({ historicBackfillEnabled: true }),
      runtime,
    );

    expect(runtime.prepareRun).toHaveBeenCalledWith(range);
    expect(runtime.readRun).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ runId: RUN_ID }));
  });

  it('prepares artifact tasks directly after staging is complete', async () => {
    const runtime = dependencies([metrics(), metrics()]);

    await runHistoricBackfillBenchmark(
      options({ mode: 'prepare-artifacts' }),
      benchmarkEnvironment({ historicBackfillEnabled: true }),
      runtime,
    );

    expect(runtime.prepareArtifacts).toHaveBeenCalledWith(RUN_ID);
    expect(runtime.finalizer.buildShadow).not.toHaveBeenCalled();
    expect(runtime.finalizer.dryRun).not.toHaveBeenCalled();
  });

  it('runs only the statistics dry-run by default', async () => {
    const runtime = dependencies([metrics(), metrics()]);

    await runHistoricBackfillBenchmark(
      options(),
      benchmarkEnvironment({ allowStatisticsApply: true }),
      runtime,
    );

    expect(runtime.finalizer.dryRun).toHaveBeenCalledWith(RUN_ID);
    expect(runtime.finalizer.apply).not.toHaveBeenCalled();
    expect(runtime.finalizer.buildShadow).not.toHaveBeenCalled();
  });

  it('requires both CLI and environment opt-ins before statistics apply', async () => {
    const blockedRuntime = dependencies([metrics(), metrics()]);
    await expect(
      runHistoricBackfillBenchmark(
        options({ applyStatistics: true }),
        benchmarkEnvironment(),
        blockedRuntime,
      ),
    ).rejects.toThrow(
      '--apply-statistics requires HISTORIC_BACKFILL_BENCHMARK_ALLOW_APPLY=true',
    );
    expect(blockedRuntime.finalizer.dryRun).not.toHaveBeenCalled();
    expect(blockedRuntime.finalizer.apply).not.toHaveBeenCalled();

    const allowedRuntime = dependencies([metrics(), metrics()]);
    await runHistoricBackfillBenchmark(
      options({ applyStatistics: true }),
      benchmarkEnvironment({ allowStatisticsApply: true }),
      allowedRuntime,
    );
    expect(allowedRuntime.finalizer.dryRun).toHaveBeenCalledWith(RUN_ID);
    expect(allowedRuntime.finalizer.apply).toHaveBeenCalledWith(RUN_ID);
  });

  it('does not start statistics apply after the benchmark deadline', async () => {
    const runtime = dependencies([metrics(), metrics(), metrics()]);
    runtime.finalizer.dryRun.mockImplementation(async () => {
      await runtime.sleep(10_000);
      return { applied: false };
    });

    await expect(
      runHistoricBackfillBenchmark(
        options({ applyStatistics: true }),
        benchmarkEnvironment({ allowStatisticsApply: true }),
        runtime,
      ),
    ).rejects.toThrow(
      'Historic backfill benchmark timed out before statistics apply started',
    );

    expect(runtime.finalizer.apply).not.toHaveBeenCalled();
  });

  it('waits for an in-flight statistics apply after the benchmark deadline', async () => {
    const runtime = dependencies([metrics(), metrics(), metrics()]);
    let resolveApply: (value: { applied: boolean }) => void = () => undefined;
    runtime.finalizer.apply.mockReturnValue(
      new Promise((resolve) => {
        resolveApply = resolve;
      }),
    );
    let settled = false;
    const benchmark = runHistoricBackfillBenchmark(
      options({ applyStatistics: true }),
      benchmarkEnvironment({ allowStatisticsApply: true }),
      runtime,
    ).finally(() => {
      settled = true;
    });

    for (let index = 0; index < 50; index += 1) {
      if (runtime.finalizer.apply.mock.calls.length > 0) break;
      await Promise.resolve();
    }

    expect(runtime.finalizer.apply).toHaveBeenCalledWith(RUN_ID);
    await runtime.sleep(10_000);
    for (let index = 0; index < 50; index += 1) {
      const heartbeatCount = runtime.events.filter(
        (event) => event.phase === 'dry-run-stats-deadline-exceeded',
      ).length;
      if (heartbeatCount >= 2) break;
      await Promise.resolve();
    }
    expect(settled).toBe(false);
    expect(
      runtime.events.filter(
        (event) => event.phase === 'dry-run-stats-deadline-exceeded',
      ).length,
    ).toBeGreaterThanOrEqual(2);
    resolveApply({ applied: true });

    await expect(benchmark).resolves.toEqual(
      expect.objectContaining({ deadlineExceeded: true }),
    );
  });

  it('keeps an operation attached when metric sampling fails', async () => {
    const runtime = dependencies([metrics(), metrics(), metrics()]);
    let metricCallCount = 0;
    runtime.collectMetrics.mockImplementation(async () => {
      metricCallCount += 1;
      if (metricCallCount === 2) {
        throw new Error('metrics unavailable');
      }
      return metrics();
    });
    let resolveShadow: (value: { departmentCount: number }) => void = () =>
      undefined;
    runtime.finalizer.buildShadow.mockReturnValue(
      new Promise((resolve) => {
        resolveShadow = resolve;
      }),
    );
    let settled = false;
    const benchmark = runHistoricBackfillBenchmark(
      options({ mode: 'build-shadow' }),
      benchmarkEnvironment(),
      runtime,
    ).finally(() => {
      settled = true;
    });

    for (let index = 0; index < 50; index += 1) {
      if (
        runtime.events.some(
          (event) => event.phase === 'build-shadow-metrics-error',
        )
      ) {
        break;
      }
      await Promise.resolve();
    }

    expect(settled).toBe(false);
    expect(
      runtime.events.some(
        (event) =>
          event.phase === 'build-shadow-metrics-error' &&
          event.error === 'metrics unavailable',
      ),
    ).toBe(true);
    resolveShadow({ departmentCount: 101 });
    await expect(benchmark).resolves.toEqual(
      expect.objectContaining({ mode: 'build-shadow' }),
    );
  });

  it('waits with bounded polling until all 101 departments are complete', async () => {
    const runtime = dependencies([metrics(100), metrics(101), metrics(101)]);

    await runHistoricBackfillBenchmark(
      options({ mode: 'wait-staging' }),
      benchmarkEnvironment(),
      runtime,
    );

    expect(runtime.collectMetrics).toHaveBeenCalledTimes(3);
    expect(runtime.finalizer.buildShadow).not.toHaveBeenCalled();
    expect(runtime.finalizer.dryRun).not.toHaveBeenCalled();
    expect(runtime.finalizer.apply).not.toHaveBeenCalled();
    expect(runtime.events.some((event) => event.phase === 'wait-staging')).toBe(
      true,
    );
  });

  it('emits artifact progression until every prepared task is complete', async () => {
    const runtime = dependencies([
      metrics(101, { total: 3, completed: 1, failed: 0, leased: 1 }),
      metrics(101, { total: 3, completed: 2, failed: 0, leased: 1 }),
      metrics(101, { total: 3, completed: 3, failed: 0, leased: 0 }),
      metrics(101, { total: 3, completed: 3, failed: 0, leased: 0 }),
    ]);

    await runHistoricBackfillBenchmark(
      options({ mode: 'wait-artifacts' }),
      benchmarkEnvironment(),
      runtime,
    );

    const progression = runtime.events.filter(
      (event) => event.phase === 'wait-artifacts',
    );
    expect(progression).toHaveLength(2);
    expect(
      progression.map(
        (event) =>
          (event.metrics as HistoricBackfillBenchmarkMetrics).runCounts
            .completedArtifactTaskCount,
      ),
    ).toEqual([2, 3]);
    expect(runtime.finalizer.buildShadow).not.toHaveBeenCalled();
    expect(runtime.finalizer.dryRun).not.toHaveBeenCalled();
    expect(runtime.finalizer.apply).not.toHaveBeenCalled();
  });

  it('refuses artifact waiting before tasks have been prepared', async () => {
    const runtime = dependencies([metrics()]);

    await expect(
      runHistoricBackfillBenchmark(
        options({ mode: 'wait-artifacts' }),
        benchmarkEnvironment(),
        runtime,
      ),
    ).rejects.toThrow('call artifacts/prepare before wait-artifacts');
    expect(runtime.finalizer.apply).not.toHaveBeenCalled();
  });

  it('refuses a failed artifact task immediately', async () => {
    const runtime = dependencies([
      metrics(101, { total: 3, completed: 1, failed: 1, leased: 0 }),
    ]);

    await expect(
      runHistoricBackfillBenchmark(
        options({ mode: 'wait-artifacts' }),
        benchmarkEnvironment(),
        runtime,
      ),
    ).rejects.toThrow('Historic artifact build has 1 failed task');
    expect(runtime.finalizer.apply).not.toHaveBeenCalled();
  });

  it('refuses a missing run before invoking a finalizer', async () => {
    const runtime = dependencies([metrics()]);
    runtime.readRun = jest.fn().mockResolvedValue(null);

    await expect(
      runHistoricBackfillBenchmark(
        options({ mode: 'build-shadow' }),
        benchmarkEnvironment(),
        runtime,
      ),
    ).rejects.toThrow('Historic backfill run not found');
    expect(runtime.finalizer.buildShadow).not.toHaveBeenCalled();
  });

  it('times out a staging wait at the configured deadline', async () => {
    const runtime = dependencies([metrics(0), metrics(0)]);

    await expect(
      runHistoricBackfillBenchmark(
        options({ mode: 'wait-staging' }),
        benchmarkEnvironment(),
        runtime,
      ),
    ).rejects.toThrow('timed out after 10000 ms');
    expect(runtime.finalizer.buildShadow).not.toHaveBeenCalled();
    expect(runtime.finalizer.dryRun).not.toHaveBeenCalled();
    expect(runtime.finalizer.apply).not.toHaveBeenCalled();
  });
});

describe('readHistoricBackfillBenchmarkSentinelNonces', () => {
  it('fails closed when the manual sentinel table is absent', async () => {
    await expect(
      readHistoricBackfillBenchmarkSentinelNonces({
        query: jest
          .fn()
          .mockRejectedValue(
            new Error(
              'relation historic_backfill_benchmark_guard does not exist',
            ),
          ),
      }),
    ).rejects.toThrow('Historic benchmark sentinel table is unavailable');
  });
});

describe('summarizeHistoricBackfillArtifactDurations', () => {
  it('reports completed artifact p50, p95 and maximum durations', () => {
    const completed = Array.from({ length: 20 }, (_, index) => ({
      validFrom: `2026-08-${String(index + 1).padStart(2, '0')}`,
      validThrough: `2026-08-${String(index + 1).padStart(2, '0')}`,
      status: 'completed',
      attemptCount: 1,
      featureCount: 10,
      durationMs: (index + 1) * 100,
    }));
    const running: HistoricBackfillArtifactDuration = {
      validFrom: '2026-08-21',
      validThrough: '2026-08-21',
      status: 'leased',
      attemptCount: 1,
      featureCount: 0,
      durationMs: 100_000,
    };

    expect(
      summarizeHistoricBackfillArtifactDurations([...completed, running]),
    ).toEqual(
      expect.objectContaining({
        completedCount: 20,
        p50Ms: 1_000,
        p95Ms: 1_900,
        maxMs: 2_000,
      }),
    );
  });
});
