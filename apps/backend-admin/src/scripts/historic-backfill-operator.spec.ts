import {
  assertHistoricBackfillOperatorDatabase,
  assertHistoricBackfillOperatorFeatureEnabled,
  assertHistoricBackfillOperatorProductionIntent,
  collectHistoricBackfillOperatorPreflight,
  configureHistoricBackfillOperatorProcess,
  executeHistoricBackfillOperator,
  HistoricBackfillOperatorDependencies,
  HistoricBackfillOperatorOptions,
  isHistoricBackfillOperatorMutation,
  parseHistoricBackfillOperatorOptions,
  readHistoricBackfillOperatorDatabaseName,
  safeHistoricBackfillOperatorError,
  stringifyHistoricBackfillOperatorJson,
} from './historic-backfill-operator';

const RUN_ID = '5a4c3c44-5232-4edf-a067-a700d5f268c3';
const DATABASE_NAME = 'vigieau-production-1234';

function options(
  overrides: Partial<HistoricBackfillOperatorOptions> = {},
): HistoricBackfillOperatorOptions {
  return {
    command: 'status',
    runId: RUN_ID,
    apply: false,
    allowProduction: false,
    ...overrides,
  };
}

function dependencyHarness(): {
  dependencies: HistoricBackfillOperatorDependencies;
  databaseQuery: jest.Mock;
  status: jest.Mock;
  prepare: jest.Mock;
  pause: jest.Mock;
  resume: jest.Mock;
  prepareArtifacts: jest.Mock;
  buildShadow: jest.Mock;
  finalizeStatistics: jest.Mock;
  mapsDryRun: jest.Mock;
  mapsApply: jest.Mock;
} {
  const databaseQuery = jest.fn();
  const status = jest.fn().mockResolvedValue({ status: 'running' });
  const prepare = jest.fn().mockResolvedValue({ id: RUN_ID });
  const pause = jest.fn().mockResolvedValue(true);
  const resume = jest.fn().mockResolvedValue(true);
  const prepareArtifacts = jest.fn().mockResolvedValue({ taskCount: 12 });
  const buildShadow = jest.fn().mockResolvedValue({ departmentCount: 101 });
  const finalizeStatistics = jest.fn().mockResolvedValue({ applied: false });
  const mapsDryRun = jest.fn().mockResolvedValue({ mode: 'dry-run' });
  const mapsApply = jest.fn().mockResolvedValue({ mode: 'applied' });
  return {
    dependencies: {
      database: { query: databaseQuery },
      queue: { status, prepare, pause, resume },
      artifactQueue: { prepare: prepareArtifacts },
      statisticsFinalizer: { buildShadow, finalizeStatistics },
      mapFinalizer: { dryRun: mapsDryRun, apply: mapsApply },
    },
    databaseQuery,
    status,
    prepare,
    pause,
    resume,
    prepareArtifacts,
    buildShadow,
    finalizeStatistics,
    mapsDryRun,
    mapsApply,
  };
}

describe('parseHistoricBackfillOperatorOptions', () => {
  it('parses read-only commands with safe defaults', () => {
    expect(parseHistoricBackfillOperatorOptions(['preflight'])).toEqual({
      command: 'preflight',
      apply: false,
      allowProduction: false,
    });
    expect(
      parseHistoricBackfillOperatorOptions([
        'status',
        '--run-id',
        RUN_ID,
        '--expected-database',
        ` ${DATABASE_NAME} `,
      ]),
    ).toEqual({
      command: 'status',
      runId: RUN_ID,
      apply: false,
      allowProduction: false,
      expectedDatabase: DATABASE_NAME,
    });
  });

  it('parses the full production range for prepare', () => {
    expect(
      parseHistoricBackfillOperatorOptions([
        'prepare',
        '--map-date-from',
        '2010-05-01',
        '--statistic-date-from',
        '2010-05-01',
        '--date-through',
        '2026-08-22',
        '--expected-database',
        DATABASE_NAME,
        '--allow-production',
      ]),
    ).toEqual({
      command: 'prepare',
      mapDateFrom: '2010-05-01',
      statisticDateFrom: '2010-05-01',
      dateThrough: '2026-08-22',
      expectedDatabase: DATABASE_NAME,
      apply: false,
      allowProduction: true,
    });
  });

  it('keeps finalizers in dry-run unless apply is explicit', () => {
    expect(
      parseHistoricBackfillOperatorOptions([
        'finalize-statistics',
        '--run-id',
        RUN_ID,
      ]).apply,
    ).toBe(false);
    expect(
      parseHistoricBackfillOperatorOptions([
        'finalize-maps',
        '--run-id',
        RUN_ID,
        '--apply',
      ]).apply,
    ).toBe(true);
  });

  it('rejects missing, duplicate, unknown, and misplaced arguments', () => {
    expect(() => parseHistoricBackfillOperatorOptions(['status'])).toThrow(
      'Missing argument: --run-id',
    );
    expect(() =>
      parseHistoricBackfillOperatorOptions([
        'status',
        '--run-id',
        RUN_ID,
        '--run-id',
        RUN_ID,
      ]),
    ).toThrow('Duplicate argument: --run-id');
    expect(() =>
      parseHistoricBackfillOperatorOptions(['preflight', '--unknown']),
    ).toThrow('Unknown argument: --unknown');
    expect(() =>
      parseHistoricBackfillOperatorOptions([
        'status',
        '--run-id',
        RUN_ID,
        '--apply',
      ]),
    ).toThrow('--apply is not valid with command status');
  });

  it('rejects malformed and inverted date ranges', () => {
    expect(() =>
      parseHistoricBackfillOperatorOptions([
        'prepare',
        '--map-date-from',
        '2010-02-29',
        '--statistic-date-from',
        '2010-05-01',
        '--date-through',
        '2026-08-22',
      ]),
    ).toThrow('--map-date-from must be a valid civil date');
    expect(() =>
      parseHistoricBackfillOperatorOptions([
        'prepare',
        '--map-date-from',
        '2026-08-23',
        '--statistic-date-from',
        '2010-05-01',
        '--date-through',
        '2026-08-22',
      ]),
    ).toThrow('--map-date-from must not be after --date-through');
  });
});

describe('historic backfill operator guards', () => {
  it.each([
    ['preflight', false],
    ['status', false],
    ['prepare', true],
    ['pause', true],
    ['resume', true],
    ['build-shadow', true],
    ['prepare-artifacts', true],
    ['finalize-statistics', false],
    ['finalize-maps', false],
  ] as const)('classifies %s dry-run mutation=%s', (command, expected) => {
    expect(isHistoricBackfillOperatorMutation(options({ command }))).toBe(
      expected,
    );
  });

  it('classifies only applied finalizers as mutations', () => {
    expect(
      isHistoricBackfillOperatorMutation(
        options({ command: 'finalize-statistics', apply: true }),
      ),
    ).toBe(true);
    expect(
      isHistoricBackfillOperatorMutation(
        options({ command: 'finalize-maps', apply: true }),
      ),
    ).toBe(true);
  });

  it('keeps preflight and status observable while the feature is disabled', () => {
    expect(() =>
      assertHistoricBackfillOperatorFeatureEnabled(
        options({ command: 'preflight' }),
        { HISTORIC_BACKFILL_ENABLED: 'false' },
      ),
    ).not.toThrow();
    expect(() =>
      assertHistoricBackfillOperatorFeatureEnabled(options(), {
        HISTORIC_BACKFILL_ENABLED: 'false',
      }),
    ).not.toThrow();
  });

  it('requires the exact feature flag for every POST-equivalent command', () => {
    expect(() =>
      assertHistoricBackfillOperatorFeatureEnabled(
        options({ command: 'finalize-statistics' }),
        { HISTORIC_BACKFILL_ENABLED: 'false' },
      ),
    ).toThrow('HISTORIC_BACKFILL_ENABLED must be true');
    expect(() =>
      assertHistoricBackfillOperatorFeatureEnabled(
        options({ command: 'prepare' }),
        { HISTORIC_BACKFILL_ENABLED: 'yes' },
      ),
    ).toThrow('must be either true or false');
    expect(() =>
      assertHistoricBackfillOperatorFeatureEnabled(
        options({ command: 'prepare' }),
        { HISTORIC_BACKFILL_ENABLED: 'true' },
      ),
    ).not.toThrow();
  });

  it('requires all three production mutation guards', () => {
    const mutation = options({
      command: 'prepare',
      runId: undefined,
      expectedDatabase: DATABASE_NAME,
    });
    expect(() =>
      assertHistoricBackfillOperatorProductionIntent(mutation, {
        HISTORIC_BACKFILL_OPERATOR_ALLOW_PRODUCTION: 'true',
      }),
    ).toThrow('--allow-production');
    expect(() =>
      assertHistoricBackfillOperatorProductionIntent(
        { ...mutation, allowProduction: true },
        {},
      ),
    ).toThrow('HISTORIC_BACKFILL_OPERATOR_ALLOW_PRODUCTION=true');
    expect(() =>
      assertHistoricBackfillOperatorProductionIntent(
        { ...mutation, allowProduction: true, expectedDatabase: undefined },
        { HISTORIC_BACKFILL_OPERATOR_ALLOW_PRODUCTION: 'true' },
      ),
    ).toThrow('--expected-database');
    expect(() =>
      assertHistoricBackfillOperatorProductionIntent(
        { ...mutation, allowProduction: true },
        { HISTORIC_BACKFILL_OPERATOR_ALLOW_PRODUCTION: 'true' },
      ),
    ).not.toThrow();
  });

  it('matches the expected database against current_database()', () => {
    expect(() =>
      assertHistoricBackfillOperatorDatabase(
        options({ expectedDatabase: DATABASE_NAME }),
        DATABASE_NAME,
      ),
    ).not.toThrow();
    expect(() =>
      assertHistoricBackfillOperatorDatabase(
        options({ expectedDatabase: DATABASE_NAME }),
        'another-database',
      ),
    ).toThrow('does not match current_database()');
    expect(() =>
      assertHistoricBackfillOperatorDatabase(
        options({
          command: 'finalize-maps',
          apply: true,
          expectedDatabase: undefined,
        }),
        DATABASE_NAME,
      ),
    ).toThrow('requires --expected-database');
  });

  it('does not demand mutation opt-ins for finalizer dry-runs', () => {
    const dryRun = options({ command: 'finalize-statistics' });
    expect(() =>
      assertHistoricBackfillOperatorProductionIntent(dryRun, {}),
    ).not.toThrow();
    expect(() =>
      assertHistoricBackfillOperatorDatabase(dryRun, DATABASE_NAME),
    ).not.toThrow();
  });
});

describe('historic backfill operator process isolation', () => {
  it('disables scheduled and startup work before AppModule is loaded', () => {
    const environment: NodeJS.ProcessEnv = {
      RUN_BUSINESS_SCHEDULED_JOBS: 'true',
      UNRELATED_VALUE: 'preserved',
    };
    configureHistoricBackfillOperatorProcess(environment, 1234);
    expect(environment).toMatchObject({
      DISABLE_SCHEDULED_JOBS: 'true',
      RUN_BUSINESS_SCHEDULED_JOBS: 'false',
      SKIP_SCHEMA_BOOTSTRAP: 'true',
      SKIP_STARTUP_DATA_LOADS: 'true',
      SKIP_STARTUP_DEPARTEMENT_STATISTICS: 'true',
      HISTORIC_SKIP_COMMUNE_INTERSECTIONS: 'true',
      PGAPPNAME: 'vigieau-historic-operator-1234',
      UNRELATED_VALUE: 'preserved',
    });
  });

  it('reads the server database identity without exposing connection data', async () => {
    const query = jest
      .fn()
      .mockResolvedValue([{ databaseName: DATABASE_NAME }]);
    await expect(
      readHistoricBackfillOperatorDatabaseName({ query }),
    ).resolves.toBe(DATABASE_NAME);
    expect(query).toHaveBeenCalledWith(
      'SELECT current_database()::text AS "databaseName"',
    );
  });
});

const healthyPreflightRow = {
  sourceContextCount: 1,
  legacyDualWrite: false,
  publicRevision: '42',
  historicComputeEpoch: '5',
  historicBackfillGlobalEpoch: '2',
  computeMapDate: '2010-05-01',
  computeStatsDate: '2010-05-01',
  statisticContextCount: 1,
  currentPublishedDate: '2026-08-23',
  historicPublishedThrough: null,
  historicDirtyFrom: '2010-05-01',
  historicDirtyThrough: '2026-08-22',
  sourceDateFrom: '2010-05-01',
  communeCount: 34_943,
  departmentCount: 101,
  currentQueueCount: 0,
  runningSnapshotCount: 0,
  runningDailyPublicationCount: 0,
  unfinishedRunCount: 0,
  unfinishedRunIds: [],
  zonePublicationStateCount: 1,
  zoneCandidateCount: 0,
  statisticCacheStateCount: 1,
  statisticCandidateCount: 0,
  pendingMapOutboxCount: 0,
  postgresLockWaitCount: 0,
};

describe('historic backfill operator preflight', () => {
  function executor(
    row: Record<string, unknown> = healthyPreflightRow,
    lock = { locked: true, unlocked: true },
  ) {
    const query = jest
      .fn()
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([lock]);
    return { query, executor: { query } };
  }

  it('reports all enable gates and probes the historic lock exclusively', async () => {
    const harness = executor();
    await expect(
      collectHistoricBackfillOperatorPreflight(harness.executor, true),
    ).resolves.toMatchObject({
      historicBackfillEnabled: true,
      readyForEnable: true,
      ready: true,
      gates: [],
      sourceDateFrom: '2010-05-01',
      recommendedMapDateFrom: '2010-05-01',
      recommendedStatisticDateFrom: '2010-05-01',
      recommendedDateThrough: '2026-08-22',
      communeCount: 34_943,
      departmentCount: 101,
      pendingMapOutboxCount: 0,
      historicExclusiveLockAvailable: true,
      historicLockProbeReleased: true,
    });

    const stateSql = harness.query.mock.calls[0][0] as string;
    const lockSql = harness.query.mock.calls[1][0] as string;
    expect(stateSql).toContain('historic_backfill_map_manifest_outbox');
    expect(stateSql).toContain(
      'SELECT COUNT(*)::integer FROM "current_zone_recompute_request"',
    );
    expect(stateSql).toContain(`WHERE "status" = 'running'`);
    expect(stateSql).not.toContain(
      `snapshot\n         WHERE "status" = 'failed'`,
    );
    expect(lockSql).toContain('pg_try_advisory_xact_lock(');
    expect(lockSql).not.toContain('pg_try_advisory_lock_shared');
    expect(lockSql).not.toContain('pg_advisory_unlock(');
  });

  it('can validate readiness before the feature flag is enabled', async () => {
    const harness = executor();
    await expect(
      collectHistoricBackfillOperatorPreflight(harness.executor, false),
    ).resolves.toMatchObject({
      historicBackfillEnabled: false,
      readyForEnable: true,
      ready: false,
      gates: ['historic-backfill-disabled'],
    });
  });

  it('blocks a new run while a map-manifest outbox remains pending', async () => {
    const harness = executor({
      ...healthyPreflightRow,
      pendingMapOutboxCount: 1,
    });
    await expect(
      collectHistoricBackfillOperatorPreflight(harness.executor, true),
    ).resolves.toMatchObject({
      readyForEnable: false,
      ready: false,
      gates: ['pending-map-outbox'],
      pendingMapOutboxCount: 1,
    });
  });

  it('blocks when the full commune reference is incomplete', async () => {
    const harness = executor({
      ...healthyPreflightRow,
      communeCount: 34_942,
    });
    await expect(
      collectHistoricBackfillOperatorPreflight(harness.executor, true),
    ).resolves.toMatchObject({
      readyForEnable: false,
      ready: false,
      gates: ['commune-count'],
      communeCount: 34_942,
    });
  });

  it('blocks while historic shared workers prevent the exclusive probe', async () => {
    const harness = executor(healthyPreflightRow, {
      locked: false,
      unlocked: false,
    });
    await expect(
      collectHistoricBackfillOperatorPreflight(harness.executor, true),
    ).resolves.toMatchObject({
      ready: false,
      gates: ['historic-exclusive-lock'],
      historicExclusiveLockAvailable: false,
    });
  });
});

describe('executeHistoricBackfillOperator', () => {
  it('routes status, prepare, pause, and resume to the queue service', async () => {
    const harness = dependencyHarness();
    await executeHistoricBackfillOperator(
      options(),
      harness.dependencies,
      true,
    );
    await executeHistoricBackfillOperator(
      options({
        command: 'prepare',
        runId: undefined,
        mapDateFrom: '2010-05-01',
        statisticDateFrom: '2010-05-01',
        dateThrough: '2026-08-22',
      }),
      harness.dependencies,
      true,
    );
    await expect(
      executeHistoricBackfillOperator(
        options({ command: 'pause' }),
        harness.dependencies,
        true,
      ),
    ).resolves.toEqual({ paused: true });
    await expect(
      executeHistoricBackfillOperator(
        options({ command: 'resume' }),
        harness.dependencies,
        true,
      ),
    ).resolves.toEqual({ resumed: true });

    expect(harness.status).toHaveBeenCalledWith(RUN_ID);
    expect(harness.prepare).toHaveBeenCalledWith({
      mapDateFrom: '2010-05-01',
      statisticDateFrom: '2010-05-01',
      dateThrough: '2026-08-22',
    });
    expect(harness.pause).toHaveBeenCalledWith(RUN_ID);
    expect(harness.resume).toHaveBeenCalledWith(RUN_ID);
  });

  it('routes shadow, statistics, and artifact phases to their services', async () => {
    const harness = dependencyHarness();
    await executeHistoricBackfillOperator(
      options({ command: 'build-shadow' }),
      harness.dependencies,
      true,
    );
    await executeHistoricBackfillOperator(
      options({ command: 'finalize-statistics', apply: true }),
      harness.dependencies,
      true,
    );
    await executeHistoricBackfillOperator(
      options({ command: 'prepare-artifacts' }),
      harness.dependencies,
      true,
    );

    expect(harness.buildShadow).toHaveBeenCalledWith(RUN_ID);
    expect(harness.finalizeStatistics).toHaveBeenCalledWith(RUN_ID, true);
    expect(harness.prepareArtifacts).toHaveBeenCalledWith(RUN_ID);
  });

  it('uses the map finalizer dryRun/apply adapter explicitly', async () => {
    const harness = dependencyHarness();
    await executeHistoricBackfillOperator(
      options({ command: 'finalize-maps' }),
      harness.dependencies,
      true,
    );
    expect(harness.mapsDryRun).toHaveBeenCalledWith(RUN_ID);
    expect(harness.mapsApply).not.toHaveBeenCalled();

    await executeHistoricBackfillOperator(
      options({ command: 'finalize-maps', apply: true }),
      harness.dependencies,
      true,
    );
    expect(harness.mapsApply).toHaveBeenCalledWith(RUN_ID);
  });
});

describe('historic backfill operator output redaction', () => {
  it('redacts environment secrets, URI passwords, and inline token values', () => {
    const error = safeHistoricBackfillOperatorError(
      new Error(
        'failure top-secret datagouv-key postgres://operator:uri-secret@db.local/x token=inline-secret',
      ),
      {
        DATABASE_PASSWORD: 'top-secret',
        API_DATAGOUV_KEY: 'datagouv-key',
      },
    );
    expect(error.message).not.toContain('top-secret');
    expect(error.message).not.toContain('datagouv-key');
    expect(error.message).not.toContain('uri-secret');
    expect(error.message).not.toContain('inline-secret');
    expect(error.message).toContain('[REDACTED]');
  });

  it('redacts sensitive result keys and strings while preserving JSON types', () => {
    const output = stringifyHistoricBackfillOperatorJson(
      {
        runId: RUN_ID,
        createdAt: new Date('2026-08-23T00:00:00.000Z'),
        leaseToken: 'do-not-print',
        apiDatagouvKey: 'also-do-not-print',
        lastError: 'S3 secret-value failed',
      },
      { S3_SECRET_ACCESS_KEY: 'secret-value' },
    );
    expect(output).not.toContain('do-not-print');
    expect(output).not.toContain('also-do-not-print');
    expect(output).not.toContain('secret-value');
    expect(JSON.parse(output)).toEqual({
      runId: RUN_ID,
      createdAt: '2026-08-23T00:00:00.000Z',
      leaseToken: '[REDACTED]',
      apiDatagouvKey: '[REDACTED]',
      lastError: 'S3 [REDACTED] failed',
    });
  });
});
