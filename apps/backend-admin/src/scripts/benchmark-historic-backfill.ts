import 'reflect-metadata';
import 'dotenv/config';

const EXPECTED_DEPARTMENT_COUNT = 101;
const DEFAULT_POLL_MS = 15_000;
const MIN_POLL_MS = 1_000;
const MAX_POLL_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MIN_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 72 * 60 * 60 * 1000;
const CLONE_CONFIRMATION = 'I_CONFIRM_DISPOSABLE_CLONE';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRODUCTION_IDENTIFIER_PATTERN =
  /(^|[-_.])prod(?:uction)?($|[-_.])|production/i;

const BACKFILL_TABLES = [
  'historic_backfill_department_revision',
  'historic_backfill_run',
  'historic_backfill_task',
  'historic_backfill_commune_segment',
  'historic_backfill_department_segment',
  'historic_backfill_commune_shadow',
  'historic_backfill_artifact_task',
  'historic_backfill_map_manifest_outbox',
] as const;

export type HistoricBackfillBenchmarkMode =
  | 'migrate-clone'
  | 'prepare-run'
  | 'prepare-artifacts'
  | 'wait-staging'
  | 'wait-artifacts'
  | 'build-shadow'
  | 'dry-run-stats';

export interface HistoricBackfillBenchmarkRange {
  mapDateFrom: string;
  statisticDateFrom: string;
  dateThrough: string;
}

export interface HistoricBackfillBenchmarkOptions {
  mode: HistoricBackfillBenchmarkMode;
  runId?: string;
  range?: HistoricBackfillBenchmarkRange;
  pollMs: number;
  timeoutMs: number;
  applyStatistics: boolean;
}

export interface HistoricBackfillBenchmarkEnvironment {
  allowedDatabaseName: string;
  configuredDatabaseName: string;
  sentinelNonce: string;
  allowStatisticsApply: boolean;
  historicBackfillEnabled: boolean;
}

export interface HistoricBackfillBenchmarkRun {
  id: string;
  status: string;
  mapDateFrom: string;
  statisticDateFrom: string;
  dateThrough: string;
  sourceRevision: string;
  historicComputeEpoch: string;
  baseStatisticRevision: string;
}

export interface HistoricBackfillDepartmentDuration {
  departementId: number;
  status: string;
  currentGeneration: boolean;
  attemptCount: number;
  progressDate: string | null;
  segmentCount: number;
  communeCount: number;
  durationMs: number | null;
}

export interface HistoricBackfillArtifactDuration {
  validFrom: string;
  validThrough: string;
  status: string;
  attemptCount: number;
  featureCount: number;
  durationMs: number | null;
}

export interface HistoricBackfillRunCounts {
  taskCount: number;
  pendingTaskCount: number;
  leasedTaskCount: number;
  completedTaskCount: number;
  failedTaskCount: number;
  currentGenerationTaskCount: number;
  currentGenerationCompletedTaskCount: number;
  reportedCommuneSegmentCount: number;
  reportedCommuneCount: number;
  departmentSegmentCount: number;
  shadowCommuneCount: number;
  artifactTaskCount: number;
  pendingArtifactTaskCount: number;
  leasedArtifactTaskCount: number;
  completedArtifactTaskCount: number;
  failedArtifactTaskCount: number;
  manifestOutboxCount: number;
}

export interface HistoricBackfillTableSize {
  tableName: string;
  estimatedRows: string | null;
  relationBytes: string | null;
  indexBytes: string | null;
  totalBytes: string | null;
}

export interface HistoricBackfillWaitMetric {
  state: string;
  waitEventType: string | null;
  waitEvent: string | null;
  connectionCount: number;
  longestQueryMs: number | null;
}

export interface HistoricBackfillBenchmarkMetrics {
  capturedAt: string;
  postgres: {
    serverVersion: string;
    databaseBytes: string;
    walBytes: string | null;
    walRecords: string | null;
    walFpi: string | null;
    tempBytes: string;
    tempFiles: string;
    blockReadTimeMs: string;
    blockWriteTimeMs: string;
    connections: number;
    maxConnections: number;
    activeConnections: number;
    idleConnections: number;
    idleInTransactionConnections: number;
    waitingConnections: number;
  };
  waits: HistoricBackfillWaitMetric[];
  tableSizes: HistoricBackfillTableSize[];
  run: HistoricBackfillBenchmarkRun;
  runCounts: HistoricBackfillRunCounts;
  departmentDurations: {
    completedCount: number;
    minMs: number | null;
    medianMs: number | null;
    p95Ms: number | null;
    maxMs: number | null;
    averageMs: number | null;
    departments: HistoricBackfillDepartmentDuration[];
  };
  artifactDurations: {
    completedCount: number;
    p50Ms: number | null;
    p95Ms: number | null;
    maxMs: number | null;
    artifacts: HistoricBackfillArtifactDuration[];
  };
}

interface HistoricBackfillBenchmarkFinalizer {
  buildShadow(runId: string): Promise<unknown>;
  dryRun(runId: string): Promise<unknown>;
  apply(runId: string): Promise<unknown>;
}

export interface HistoricBackfillBenchmarkDependencies {
  readConnectedDatabaseName(): Promise<string>;
  readBenchmarkSentinelNonces(): Promise<string[]>;
  readRun(runId: string): Promise<HistoricBackfillBenchmarkRun | null>;
  collectMetrics(runId: string): Promise<HistoricBackfillBenchmarkMetrics>;
  prepareRun(
    range: HistoricBackfillBenchmarkRange,
  ): Promise<HistoricBackfillBenchmarkRun>;
  prepareArtifacts(runId: string): Promise<{ taskCount: number }>;
  finalizer: HistoricBackfillBenchmarkFinalizer;
  emit(event: Record<string, unknown>): void;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

interface QueryExecutor {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

export interface HistoricBackfillBenchmarkPreflightClient extends QueryExecutor {
  connect(): Promise<void>;
  end(): Promise<void>;
}

export interface HistoricBackfillBenchmarkMigrationRunner extends QueryExecutor {
  initialize(): Promise<unknown>;
  runMigrations(): Promise<Array<{ name?: string }>>;
  destroy(): Promise<void>;
}

interface OperationOutcome {
  status: 'resolved' | 'rejected';
  value?: unknown;
  error?: unknown;
}

function requireArgument(
  values: Map<string, string>,
  argument: string,
): string {
  const value = values.get(argument)?.trim();
  if (!value) throw new Error(`Missing required argument: ${argument}`);
  return value;
}

function parseCivilDateArgument(
  values: Map<string, string>,
  argument: string,
): string {
  const value = requireArgument(values, argument);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${argument} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${argument} must be a valid civil date`);
  }
  return value;
}

function parseBoundedInteger(
  value: string | undefined,
  argument: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return defaultValue;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${argument} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${argument} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function parseHistoricBackfillBenchmarkOptions(
  args: string[],
): HistoricBackfillBenchmarkOptions {
  const allowedArguments = new Set([
    '--mode',
    '--run-id',
    '--poll-ms',
    '--timeout-ms',
    '--apply-statistics',
    '--map-date-from',
    '--statistic-date-from',
    '--date-through',
  ]);
  const values = new Map<string, string>();
  let applyStatistics = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!allowedArguments.has(argument)) {
      throw new Error(`Invalid argument: ${argument}`);
    }
    if (values.has(argument)) {
      throw new Error(`Duplicate argument: ${argument}`);
    }
    if (argument === '--apply-statistics') {
      if (applyStatistics) {
        throw new Error('Duplicate argument: --apply-statistics');
      }
      applyStatistics = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for argument: ${argument}`);
    }
    values.set(argument, value);
    index += 1;
  }

  const rawMode = requireArgument(values, '--mode');
  const mode = rawMode === 'dry-run' ? 'dry-run-stats' : rawMode;
  if (
    ![
      'migrate-clone',
      'prepare-run',
      'prepare-artifacts',
      'wait-staging',
      'wait-artifacts',
      'build-shadow',
      'dry-run-stats',
    ].includes(mode)
  ) {
    throw new Error(
      '--mode must be migrate-clone, prepare-run, prepare-artifacts, wait-staging, wait-artifacts, build-shadow, or dry-run-stats',
    );
  }
  if (applyStatistics && mode !== 'dry-run-stats') {
    throw new Error(
      '--apply-statistics is only valid with --mode dry-run-stats',
    );
  }
  let runId: string | undefined;
  let range: HistoricBackfillBenchmarkRange | undefined;
  if (mode === 'prepare-run') {
    if (values.has('--run-id')) {
      throw new Error('--run-id is not valid with --mode prepare-run');
    }
    range = {
      mapDateFrom: parseCivilDateArgument(values, '--map-date-from'),
      statisticDateFrom: parseCivilDateArgument(
        values,
        '--statistic-date-from',
      ),
      dateThrough: parseCivilDateArgument(values, '--date-through'),
    };
  } else if (mode === 'migrate-clone') {
    if (values.has('--run-id')) {
      throw new Error('--run-id is not valid with --mode migrate-clone');
    }
  } else {
    runId = requireArgument(values, '--run-id');
    if (!UUID_PATTERN.test(runId)) throw new Error('--run-id must be a UUID');
  }
  if (
    mode !== 'prepare-run' &&
    ['--map-date-from', '--statistic-date-from', '--date-through'].some(
      (argument) => values.has(argument),
    )
  ) {
    throw new Error(
      'date range arguments are only valid with --mode prepare-run',
    );
  }

  const pollMs = parseBoundedInteger(
    values.get('--poll-ms'),
    '--poll-ms',
    DEFAULT_POLL_MS,
    MIN_POLL_MS,
    MAX_POLL_MS,
  );
  const timeoutMs = parseBoundedInteger(
    values.get('--timeout-ms'),
    '--timeout-ms',
    DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  if (timeoutMs < pollMs) {
    throw new Error('--timeout-ms must be greater than or equal to --poll-ms');
  }

  return {
    mode: mode as HistoricBackfillBenchmarkMode,
    ...(runId ? { runId } : {}),
    ...(range ? { range } : {}),
    pollMs,
    timeoutMs,
    applyStatistics,
  };
}

function requiredEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export function assertHistoricBackfillBenchmarkEnvironment(
  environment: NodeJS.ProcessEnv,
): HistoricBackfillBenchmarkEnvironment {
  const confirmation = requiredEnvironmentValue(
    environment,
    'HISTORIC_BACKFILL_BENCHMARK_CLONE',
  );
  if (confirmation !== CLONE_CONFIRMATION) {
    throw new Error(
      `HISTORIC_BACKFILL_BENCHMARK_CLONE must equal ${CLONE_CONFIRMATION}`,
    );
  }

  const configuredDatabaseName = requiredEnvironmentValue(
    environment,
    'DATABASE_NAME',
  );
  const allowedDatabaseName = requiredEnvironmentValue(
    environment,
    'HISTORIC_BACKFILL_BENCHMARK_ALLOWED_DATABASE_NAME',
  );
  if (configuredDatabaseName !== allowedDatabaseName) {
    throw new Error(
      'DATABASE_NAME does not match HISTORIC_BACKFILL_BENCHMARK_ALLOWED_DATABASE_NAME',
    );
  }
  const sentinelNonce = requiredEnvironmentValue(
    environment,
    'HISTORIC_BACKFILL_BENCHMARK_SENTINEL',
  );
  if (!UUID_PATTERN.test(sentinelNonce)) {
    throw new Error('HISTORIC_BACKFILL_BENCHMARK_SENTINEL must be a UUID');
  }

  const identifiers = [
    configuredDatabaseName,
    environment.SCALINGO_APP,
    environment.APP_NAME,
    environment.APP_ENV,
    environment.DEPLOY_ENV,
    environment.ENVIRONMENT,
  ].filter((value): value is string => Boolean(value?.trim()));
  const productionIdentifier = identifiers.find((value) =>
    PRODUCTION_IDENTIFIER_PATTERN.test(value.trim()),
  );
  if (productionIdentifier) {
    throw new Error(
      `Production identifier refused for historic benchmark: ${productionIdentifier}`,
    );
  }

  const rawAllowStatisticsApply =
    environment.HISTORIC_BACKFILL_BENCHMARK_ALLOW_APPLY?.trim().toLowerCase();
  if (
    rawAllowStatisticsApply !== undefined &&
    !['true', 'false'].includes(rawAllowStatisticsApply)
  ) {
    throw new Error(
      'HISTORIC_BACKFILL_BENCHMARK_ALLOW_APPLY must be either true or false',
    );
  }
  const rawHistoricBackfillEnabled =
    environment.HISTORIC_BACKFILL_ENABLED?.trim().toLowerCase() ?? 'false';
  if (!['true', 'false'].includes(rawHistoricBackfillEnabled)) {
    throw new Error('HISTORIC_BACKFILL_ENABLED must be either true or false');
  }

  return {
    allowedDatabaseName,
    configuredDatabaseName,
    sentinelNonce,
    allowStatisticsApply: rawAllowStatisticsApply === 'true',
    historicBackfillEnabled: rawHistoricBackfillEnabled === 'true',
  };
}

export function assertHistoricBackfillBenchmarkConnectedDatabase(
  connectedDatabaseName: string,
  allowedDatabaseName: string,
): void {
  if (!connectedDatabaseName || connectedDatabaseName !== allowedDatabaseName) {
    throw new Error(
      `Connected database ${connectedDatabaseName || '<empty>'} is not the explicitly allowed benchmark clone ${allowedDatabaseName}`,
    );
  }
  if (PRODUCTION_IDENTIFIER_PATTERN.test(connectedDatabaseName)) {
    throw new Error(
      `Production database refused for historic benchmark: ${connectedDatabaseName}`,
    );
  }
}

function rows(result: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(result)) {
    throw new Error('Unexpected PostgreSQL query result');
  }
  return result as Array<Record<string, unknown>>;
}

function firstRow(result: unknown, context: string): Record<string, unknown> {
  const row = rows(result)[0];
  if (!row) throw new Error(`PostgreSQL returned no row for ${context}`);
  return row;
}

function stringValue(value: unknown, name: string): string {
  if (value === null || value === undefined) {
    throw new Error(`Missing PostgreSQL value ${name}`);
  }
  return String(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function countValue(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid PostgreSQL count ${name}: ${String(value)}`);
  }
  return parsed;
}

function nullableNumber(value: unknown, name: string): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid PostgreSQL number ${name}: ${String(value)}`);
  }
  return parsed;
}

function databaseBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 't';
}

function normalizeDate(value: unknown): string {
  return stringValue(value, 'date').slice(0, 10);
}

export async function readHistoricBackfillBenchmarkDatabaseName(
  executor: QueryExecutor,
): Promise<string> {
  const row = firstRow(
    await executor.query(`SELECT current_database() AS "databaseName"`),
    'current database',
  );
  return stringValue(row.databaseName, 'databaseName');
}

export async function readHistoricBackfillBenchmarkSentinelNonces(
  executor: QueryExecutor,
): Promise<string[]> {
  let result: unknown;
  try {
    result = await executor.query(`
      SELECT "nonce"::text AS "nonce"
      FROM public."historic_backfill_benchmark_guard"
      ORDER BY "nonce"
    `);
  } catch (error) {
    throw new Error(
      `Historic benchmark sentinel table is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return rows(result).map((row) => stringValue(row.nonce, 'sentinel nonce'));
}

export function assertHistoricBackfillBenchmarkSentinel(
  actualNonces: string[],
  expectedNonce: string,
): void {
  if (actualNonces.length !== 1) {
    throw new Error(
      `Historic benchmark sentinel must contain exactly one row, got ${actualNonces.length}`,
    );
  }
  if (actualNonces[0] !== expectedNonce) {
    throw new Error('Historic benchmark sentinel nonce does not match');
  }
}

export async function preflightHistoricBackfillBenchmark(
  environment: HistoricBackfillBenchmarkEnvironment,
  createClient: () => HistoricBackfillBenchmarkPreflightClient,
): Promise<void> {
  const client = createClient();
  let failure: unknown;
  try {
    await client.connect();
    assertHistoricBackfillBenchmarkConnectedDatabase(
      await readHistoricBackfillBenchmarkDatabaseName(client),
      environment.allowedDatabaseName,
    );
    assertHistoricBackfillBenchmarkSentinel(
      await readHistoricBackfillBenchmarkSentinelNonces(client),
      environment.sentinelNonce,
    );
  } catch (error) {
    failure = error;
  } finally {
    try {
      await client.end();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

export async function loadHistoricBackfillBenchmarkAfterPreflight<T>(
  environment: HistoricBackfillBenchmarkEnvironment,
  createClient: () => HistoricBackfillBenchmarkPreflightClient,
  loadApplication: () => Promise<T>,
): Promise<T> {
  await preflightHistoricBackfillBenchmark(environment, createClient);
  return loadApplication();
}

export async function runHistoricBackfillCloneMigrations(
  environment: HistoricBackfillBenchmarkEnvironment,
  runner: HistoricBackfillBenchmarkMigrationRunner,
  emit: (event: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  if (environment.historicBackfillEnabled) {
    throw new Error('migrate-clone requires HISTORIC_BACKFILL_ENABLED=false');
  }
  const startedAt = Date.now();
  let initialized = false;
  try {
    await runner.initialize();
    initialized = true;
    assertHistoricBackfillBenchmarkConnectedDatabase(
      await readHistoricBackfillBenchmarkDatabaseName(runner),
      environment.allowedDatabaseName,
    );
    assertHistoricBackfillBenchmarkSentinel(
      await readHistoricBackfillBenchmarkSentinelNonces(runner),
      environment.sentinelNonce,
    );
    const migrations = await runner.runMigrations();
    assertHistoricBackfillBenchmarkConnectedDatabase(
      await readHistoricBackfillBenchmarkDatabaseName(runner),
      environment.allowedDatabaseName,
    );
    assertHistoricBackfillBenchmarkSentinel(
      await readHistoricBackfillBenchmarkSentinelNonces(runner),
      environment.sentinelNonce,
    );
    const result = {
      schemaVersion: 1,
      type: 'historic_backfill_benchmark_migrations_complete',
      timestamp: new Date().toISOString(),
      databaseName: environment.allowedDatabaseName,
      elapsedMs: Date.now() - startedAt,
      appliedCount: migrations.length,
      appliedMigrations: migrations.map((migration) => migration.name ?? null),
    };
    emit(result);
    return result;
  } finally {
    if (initialized) {
      await runner.destroy();
    }
  }
}

export async function readHistoricBackfillBenchmarkRun(
  executor: QueryExecutor,
  runId: string,
): Promise<HistoricBackfillBenchmarkRun | null> {
  const result = rows(
    await executor.query(
      `
        SELECT "id", "status", "mapDateFrom", "statisticDateFrom",
               "dateThrough", "sourceRevision"::text AS "sourceRevision",
               "historicComputeEpoch"::text AS "historicComputeEpoch",
               "baseStatisticRevision"::text AS "baseStatisticRevision"
        FROM "historic_backfill_run"
        WHERE "id" = $1::uuid
      `,
      [runId],
    ),
  );
  const row = result[0];
  if (!row) return null;
  return {
    id: stringValue(row.id, 'run id'),
    status: stringValue(row.status, 'run status'),
    mapDateFrom: normalizeDate(row.mapDateFrom),
    statisticDateFrom: normalizeDate(row.statisticDateFrom),
    dateThrough: normalizeDate(row.dateThrough),
    sourceRevision: stringValue(row.sourceRevision, 'source revision'),
    historicComputeEpoch: stringValue(
      row.historicComputeEpoch,
      'historic compute epoch',
    ),
    baseStatisticRevision: stringValue(
      row.baseStatisticRevision,
      'base statistic revision',
    ),
  };
}

function percentile(sortedValues: number[], percentileValue: number): number {
  const index = Math.ceil(percentileValue * sortedValues.length) - 1;
  return sortedValues[Math.max(0, index)];
}

function summarizeDepartmentDurations(
  departments: HistoricBackfillDepartmentDuration[],
): HistoricBackfillBenchmarkMetrics['departmentDurations'] {
  const completedDurations = departments
    .filter(
      (department) =>
        department.currentGeneration &&
        department.status === 'completed' &&
        department.durationMs !== null,
    )
    .map((department) => department.durationMs!)
    .sort((left, right) => left - right);
  if (completedDurations.length === 0) {
    return {
      completedCount: 0,
      minMs: null,
      medianMs: null,
      p95Ms: null,
      maxMs: null,
      averageMs: null,
      departments,
    };
  }
  return {
    completedCount: completedDurations.length,
    minMs: completedDurations[0],
    medianMs: percentile(completedDurations, 0.5),
    p95Ms: percentile(completedDurations, 0.95),
    maxMs: completedDurations[completedDurations.length - 1],
    averageMs: Math.round(
      completedDurations.reduce((total, value) => total + value, 0) /
        completedDurations.length,
    ),
    departments,
  };
}

export function summarizeHistoricBackfillArtifactDurations(
  artifacts: HistoricBackfillArtifactDuration[],
): HistoricBackfillBenchmarkMetrics['artifactDurations'] {
  const completedDurations = artifacts
    .filter(
      (artifact) =>
        artifact.status === 'completed' && artifact.durationMs !== null,
    )
    .map((artifact) => artifact.durationMs!)
    .sort((left, right) => left - right);
  if (completedDurations.length === 0) {
    return {
      completedCount: 0,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
      artifacts,
    };
  }
  return {
    completedCount: completedDurations.length,
    p50Ms: percentile(completedDurations, 0.5),
    p95Ms: percentile(completedDurations, 0.95),
    maxMs: completedDurations[completedDurations.length - 1],
    artifacts,
  };
}

export async function collectHistoricBackfillBenchmarkMetrics(
  executor: QueryExecutor,
  runId: string,
): Promise<HistoricBackfillBenchmarkMetrics> {
  const run = await readHistoricBackfillBenchmarkRun(executor, runId);
  if (!run) throw new Error(`Historic backfill run not found: ${runId}`);

  const postgresRow = firstRow(
    await executor.query(`
      SELECT current_setting('server_version') AS "serverVersion",
             pg_database_size(current_database())::text AS "databaseBytes",
             database_stats."temp_bytes"::text AS "tempBytes",
             database_stats."temp_files"::text AS "tempFiles",
             database_stats."blk_read_time"::text AS "blockReadTimeMs",
             database_stats."blk_write_time"::text AS "blockWriteTimeMs",
             database_stats."numbackends"::text AS "connections",
             current_setting('max_connections') AS "maxConnections",
             (SELECT "wal_bytes"::text FROM pg_stat_wal) AS "walBytes",
             (SELECT "wal_records"::text FROM pg_stat_wal) AS "walRecords",
             (SELECT "wal_fpi"::text FROM pg_stat_wal) AS "walFpi",
             COUNT(*) FILTER (WHERE activity."state" = 'active')::text
               AS "activeConnections",
             COUNT(*) FILTER (WHERE activity."state" = 'idle')::text
               AS "idleConnections",
             COUNT(*) FILTER (
               WHERE activity."state" = 'idle in transaction'
             )::text AS "idleInTransactionConnections",
             COUNT(*) FILTER (
               WHERE activity."wait_event_type" IS NOT NULL
             )::text AS "waitingConnections"
      FROM pg_stat_database database_stats
      LEFT JOIN pg_stat_activity activity
        ON activity."datname" = database_stats."datname"
      WHERE database_stats."datname" = current_database()
      GROUP BY database_stats."temp_bytes", database_stats."temp_files",
               database_stats."blk_read_time",
               database_stats."blk_write_time", database_stats."numbackends"
    `),
    'PostgreSQL metrics',
  );

  const waitRows = rows(
    await executor.query(`
      SELECT COALESCE("state", 'unknown') AS "state",
             "wait_event_type" AS "waitEventType",
             "wait_event" AS "waitEvent",
             COUNT(*)::text AS "connectionCount",
             ROUND(MAX(
               EXTRACT(EPOCH FROM (clock_timestamp() - "query_start")) * 1000
             ))::text AS "longestQueryMs"
      FROM pg_stat_activity
      WHERE "datname" = current_database()
        AND "pid" <> pg_backend_pid()
        AND "state" <> 'idle'
      GROUP BY "state", "wait_event_type", "wait_event"
      ORDER BY "state", "wait_event_type" NULLS FIRST,
               "wait_event" NULLS FIRST
    `),
  ).map((row) => ({
    state: stringValue(row.state, 'activity state'),
    waitEventType: nullableString(row.waitEventType),
    waitEvent: nullableString(row.waitEvent),
    connectionCount: countValue(row.connectionCount, 'waiting connections'),
    longestQueryMs: nullableNumber(row.longestQueryMs, 'longest query'),
  }));

  const tableRows = rows(
    await executor.query(
      `
        WITH requested_tables AS (
          SELECT unnest($1::text[]) AS "tableName"
        )
        SELECT requested_tables."tableName",
               statistics."n_live_tup"::text AS "estimatedRows",
               CASE WHEN to_regclass(requested_tables."tableName") IS NULL
                 THEN NULL
                 ELSE pg_relation_size(
                   to_regclass(requested_tables."tableName")
                 )::text
               END AS "relationBytes",
               CASE WHEN to_regclass(requested_tables."tableName") IS NULL
                 THEN NULL
                 ELSE pg_indexes_size(
                   to_regclass(requested_tables."tableName")
                 )::text
               END AS "indexBytes",
               CASE WHEN to_regclass(requested_tables."tableName") IS NULL
                 THEN NULL
                 ELSE pg_total_relation_size(
                   to_regclass(requested_tables."tableName")
                 )::text
               END AS "totalBytes"
        FROM requested_tables
        LEFT JOIN pg_stat_user_tables statistics
          ON statistics."schemaname" = current_schema()
         AND statistics."relname" = requested_tables."tableName"
        ORDER BY requested_tables."tableName"
      `,
      [[...BACKFILL_TABLES]],
    ),
  ).map((row) => ({
    tableName: stringValue(row.tableName, 'table name'),
    estimatedRows: nullableString(row.estimatedRows),
    relationBytes: nullableString(row.relationBytes),
    indexBytes: nullableString(row.indexBytes),
    totalBytes: nullableString(row.totalBytes),
  }));

  const countRow = firstRow(
    await executor.query(
      `
        SELECT COUNT(task.*)::text AS "taskCount",
               COUNT(*) FILTER (WHERE task."status" = 'pending')::text
                 AS "pendingTaskCount",
               COUNT(*) FILTER (WHERE task."status" = 'leased')::text
                 AS "leasedTaskCount",
               COUNT(*) FILTER (WHERE task."status" = 'completed')::text
                 AS "completedTaskCount",
               COUNT(*) FILTER (WHERE task."status" = 'failed')::text
                 AS "failedTaskCount",
               COUNT(*) FILTER (
                 WHERE task."departmentGeneration" = revision."generation"
               )::text AS "currentGenerationTaskCount",
               COUNT(*) FILTER (
                 WHERE task."departmentGeneration" = revision."generation"
                   AND task."status" = 'completed'
               )::text AS "currentGenerationCompletedTaskCount",
               COALESCE(SUM(task."segmentCount") FILTER (
                 WHERE task."departmentGeneration" = revision."generation"
               ), 0)::text AS "reportedCommuneSegmentCount",
               COALESCE(SUM(task."communeCount") FILTER (
                 WHERE task."departmentGeneration" = revision."generation"
               ), 0)::text AS "reportedCommuneCount",
               (SELECT COUNT(*)::text
                  FROM "historic_backfill_department_segment"
                 WHERE "runId" = $1::uuid) AS "departmentSegmentCount",
               (SELECT COUNT(*)::text
                  FROM "historic_backfill_commune_shadow"
                 WHERE "runId" = $1::uuid) AS "shadowCommuneCount",
               (SELECT COUNT(*)::text
                  FROM "historic_backfill_artifact_task"
                 WHERE "runId" = $1::uuid) AS "artifactTaskCount",
               (SELECT COUNT(*)::text
                  FROM "historic_backfill_artifact_task"
                 WHERE "runId" = $1::uuid AND "status" = 'pending')
                 AS "pendingArtifactTaskCount",
               (SELECT COUNT(*)::text
                  FROM "historic_backfill_artifact_task"
                 WHERE "runId" = $1::uuid AND "status" = 'leased')
                 AS "leasedArtifactTaskCount",
               (SELECT COUNT(*)::text
                  FROM "historic_backfill_artifact_task"
                 WHERE "runId" = $1::uuid AND "status" = 'completed')
                 AS "completedArtifactTaskCount",
               (SELECT COUNT(*)::text
                  FROM "historic_backfill_artifact_task"
                 WHERE "runId" = $1::uuid AND "status" = 'failed')
                 AS "failedArtifactTaskCount",
               (SELECT COUNT(*)::text
                  FROM "historic_backfill_map_manifest_outbox"
                 WHERE "runId" = $1::uuid) AS "manifestOutboxCount"
        FROM "historic_backfill_task" task
        LEFT JOIN "historic_backfill_department_revision" revision
          ON revision."departementId" = task."departementId"
        WHERE task."runId" = $1::uuid
      `,
      [runId],
    ),
    'historic run counts',
  );

  const runCounts = Object.fromEntries(
    Object.keys(countRow).map((name) => [
      name,
      countValue(countRow[name], name),
    ]),
  ) as unknown as HistoricBackfillRunCounts;

  const departments = rows(
    await executor.query(
      `
        SELECT task."departementId", task."status",
               task."departmentGeneration" = revision."generation"
                 AS "currentGeneration",
               task."attemptCount", task."progressDate",
               task."segmentCount", task."communeCount",
               CASE WHEN task."startedAt" IS NULL THEN NULL
                 ELSE ROUND(EXTRACT(EPOCH FROM (
                   COALESCE(task."completedAt", clock_timestamp())
                   - task."startedAt"
                 )) * 1000)::text
               END AS "durationMs"
        FROM "historic_backfill_task" task
        LEFT JOIN "historic_backfill_department_revision" revision
          ON revision."departementId" = task."departementId"
        WHERE task."runId" = $1::uuid
        ORDER BY task."departementId"
      `,
      [runId],
    ),
  ).map((row) => ({
    departementId: countValue(row.departementId, 'department id'),
    status: stringValue(row.status, 'task status'),
    currentGeneration: databaseBoolean(row.currentGeneration),
    attemptCount: countValue(row.attemptCount, 'attempt count'),
    progressDate:
      row.progressDate === null || row.progressDate === undefined
        ? null
        : normalizeDate(row.progressDate),
    segmentCount: countValue(row.segmentCount, 'segment count'),
    communeCount: countValue(row.communeCount, 'commune count'),
    durationMs: nullableNumber(row.durationMs, 'department duration'),
  }));

  const artifactDurations = rows(
    await executor.query(
      `
        SELECT task."validFrom", task."validThrough", task."status",
               task."attemptCount", task."featureCount",
               CASE WHEN task."startedAt" IS NULL THEN NULL
                 ELSE ROUND(EXTRACT(EPOCH FROM (
                   COALESCE(task."completedAt", clock_timestamp())
                   - task."startedAt"
                 )) * 1000)::text
               END AS "durationMs"
        FROM "historic_backfill_artifact_task" task
        WHERE task."runId" = $1::uuid
        ORDER BY task."validFrom"
      `,
      [runId],
    ),
  ).map((row) => ({
    validFrom: normalizeDate(row.validFrom),
    validThrough: normalizeDate(row.validThrough),
    status: stringValue(row.status, 'artifact task status'),
    attemptCount: countValue(row.attemptCount, 'artifact attempt count'),
    featureCount: countValue(row.featureCount, 'artifact feature count'),
    durationMs: nullableNumber(row.durationMs, 'artifact duration'),
  }));

  return {
    capturedAt: new Date().toISOString(),
    postgres: {
      serverVersion: stringValue(postgresRow.serverVersion, 'server version'),
      databaseBytes: stringValue(postgresRow.databaseBytes, 'database bytes'),
      walBytes: nullableString(postgresRow.walBytes),
      walRecords: nullableString(postgresRow.walRecords),
      walFpi: nullableString(postgresRow.walFpi),
      tempBytes: stringValue(postgresRow.tempBytes, 'temp bytes'),
      tempFiles: stringValue(postgresRow.tempFiles, 'temp files'),
      blockReadTimeMs: stringValue(
        postgresRow.blockReadTimeMs,
        'block read time',
      ),
      blockWriteTimeMs: stringValue(
        postgresRow.blockWriteTimeMs,
        'block write time',
      ),
      connections: countValue(postgresRow.connections, 'connections'),
      maxConnections: countValue(postgresRow.maxConnections, 'max connections'),
      activeConnections: countValue(
        postgresRow.activeConnections,
        'active connections',
      ),
      idleConnections: countValue(
        postgresRow.idleConnections,
        'idle connections',
      ),
      idleInTransactionConnections: countValue(
        postgresRow.idleInTransactionConnections,
        'idle in transaction connections',
      ),
      waitingConnections: countValue(
        postgresRow.waitingConnections,
        'waiting connections',
      ),
    },
    waits: waitRows,
    tableSizes: tableRows,
    run,
    runCounts,
    departmentDurations: summarizeDepartmentDurations(departments),
    artifactDurations:
      summarizeHistoricBackfillArtifactDurations(artifactDurations),
  };
}

function stagingReady(metrics: HistoricBackfillBenchmarkMetrics): boolean {
  return (
    metrics.run.status === 'running' &&
    metrics.runCounts.taskCount === EXPECTED_DEPARTMENT_COUNT &&
    metrics.runCounts.currentGenerationTaskCount ===
      EXPECTED_DEPARTMENT_COUNT &&
    metrics.runCounts.currentGenerationCompletedTaskCount ===
      EXPECTED_DEPARTMENT_COUNT &&
    metrics.runCounts.failedTaskCount === 0
  );
}

function assertRunCanContinue(metrics: HistoricBackfillBenchmarkMetrics): void {
  if (['paused', 'completed', 'failed'].includes(metrics.run.status)) {
    throw new Error(
      `Historic backfill run cannot be benchmarked in status ${metrics.run.status}`,
    );
  }
  if (metrics.runCounts.failedTaskCount > 0) {
    throw new Error(
      `Historic backfill staging has ${metrics.runCounts.failedTaskCount} failed task(s)`,
    );
  }
}

function assertStagingReady(metrics: HistoricBackfillBenchmarkMetrics): void {
  assertRunCanContinue(metrics);
  if (!stagingReady(metrics)) {
    throw new Error(
      'Historic backfill staging is not ready: 101 current-generation completed departments are required',
    );
  }
}

function artifactsReady(metrics: HistoricBackfillBenchmarkMetrics): boolean {
  return (
    metrics.run.status === 'running' &&
    metrics.runCounts.artifactTaskCount > 0 &&
    metrics.runCounts.completedArtifactTaskCount ===
      metrics.runCounts.artifactTaskCount &&
    metrics.runCounts.failedArtifactTaskCount === 0
  );
}

function assertArtifactsCanContinue(
  metrics: HistoricBackfillBenchmarkMetrics,
): void {
  assertRunCanContinue(metrics);
  if (metrics.runCounts.artifactTaskCount === 0) {
    throw new Error(
      'No historic artifact tasks were found; call artifacts/prepare before wait-artifacts',
    );
  }
  if (metrics.runCounts.failedArtifactTaskCount > 0) {
    throw new Error(
      `Historic artifact build has ${metrics.runCounts.failedArtifactTaskCount} failed task(s)`,
    );
  }
}

function bigintDelta(
  before: string | null,
  after: string | null,
): string | null {
  if (before === null || after === null) return null;
  return (BigInt(after) - BigInt(before)).toString();
}

function metricDelta(
  before: HistoricBackfillBenchmarkMetrics,
  after: HistoricBackfillBenchmarkMetrics,
): Record<string, unknown> {
  const beforeTables = new Map(
    before.tableSizes.map((table) => [table.tableName, table.totalBytes]),
  );
  return {
    walBytes: bigintDelta(before.postgres.walBytes, after.postgres.walBytes),
    walRecords: bigintDelta(
      before.postgres.walRecords,
      after.postgres.walRecords,
    ),
    walFpi: bigintDelta(before.postgres.walFpi, after.postgres.walFpi),
    tempBytes: bigintDelta(before.postgres.tempBytes, after.postgres.tempBytes),
    tempFiles: bigintDelta(before.postgres.tempFiles, after.postgres.tempFiles),
    databaseBytes: bigintDelta(
      before.postgres.databaseBytes,
      after.postgres.databaseBytes,
    ),
    tableTotalBytes: Object.fromEntries(
      after.tableSizes.map((table) => [
        table.tableName,
        bigintDelta(
          beforeTables.get(table.tableName) ?? null,
          table.totalBytes,
        ),
      ]),
    ),
  };
}

function metricsEvent(
  options: HistoricBackfillBenchmarkOptions,
  phase: string,
  startedAt: number,
  now: number,
  metrics: HistoricBackfillBenchmarkMetrics,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    type: 'historic_backfill_benchmark_metrics',
    timestamp: new Date(now).toISOString(),
    phase,
    mode: options.mode,
    applyStatistics: options.applyStatistics,
    runId: options.runId,
    elapsedMs: now - startedAt,
    metrics,
  };
}

async function runSampledOperation(
  options: HistoricBackfillBenchmarkOptions,
  dependencies: HistoricBackfillBenchmarkDependencies,
  startedAt: number,
  deadline: number,
  phase: string,
  operation: () => Promise<unknown>,
): Promise<unknown> {
  if (dependencies.now() >= deadline) {
    throw new Error(
      `Historic backfill benchmark timed out before ${phase} started`,
    );
  }
  const completion = operation().then<OperationOutcome, OperationOutcome>(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );

  while (true) {
    const remainingMs = deadline - dependencies.now();
    if (remainingMs <= 0) {
      dependencies.emit({
        schemaVersion: 1,
        type: 'historic_backfill_benchmark_status',
        timestamp: new Date(dependencies.now()).toISOString(),
        phase: `${phase}-deadline-exceeded`,
        mode: options.mode,
        applyStatistics: options.applyStatistics,
        runId: options.runId,
        elapsedMs: dependencies.now() - startedAt,
      });
      const outcome = await Promise.race([
        completion,
        dependencies.sleep(options.pollMs).then(() => null),
      ]);
      if (outcome) {
        if (outcome.status === 'rejected') throw outcome.error;
        return outcome.value;
      }
      continue;
    }
    const outcome = await Promise.race([
      completion,
      dependencies
        .sleep(Math.min(options.pollMs, remainingMs))
        .then(() => null),
    ]);
    if (outcome) {
      if (outcome.status === 'rejected') throw outcome.error;
      return outcome.value;
    }
    try {
      const metrics = await dependencies.collectMetrics(options.runId);
      dependencies.emit(
        metricsEvent(
          options,
          `${phase}-running`,
          startedAt,
          dependencies.now(),
          metrics,
        ),
      );
    } catch (error) {
      dependencies.emit({
        schemaVersion: 1,
        type: 'historic_backfill_benchmark_status',
        timestamp: new Date(dependencies.now()).toISOString(),
        phase: `${phase}-metrics-error`,
        mode: options.mode,
        applyStatistics: options.applyStatistics,
        runId: options.runId,
        elapsedMs: dependencies.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export async function runHistoricBackfillBenchmark(
  options: HistoricBackfillBenchmarkOptions,
  environment: HistoricBackfillBenchmarkEnvironment,
  dependencies: HistoricBackfillBenchmarkDependencies,
): Promise<Record<string, unknown>> {
  const startedAt = dependencies.now();
  const deadline = startedAt + options.timeoutMs;
  if (options.applyStatistics && !environment.allowStatisticsApply) {
    throw new Error(
      '--apply-statistics requires HISTORIC_BACKFILL_BENCHMARK_ALLOW_APPLY=true',
    );
  }
  if (options.mode === 'migrate-clone') {
    throw new Error('migrate-clone must run before the Nest benchmark context');
  }
  if (
    ['prepare-run', 'prepare-artifacts'].includes(options.mode) &&
    !environment.historicBackfillEnabled
  ) {
    throw new Error(`${options.mode} requires HISTORIC_BACKFILL_ENABLED=true`);
  }
  const databaseName = await dependencies.readConnectedDatabaseName();
  assertHistoricBackfillBenchmarkConnectedDatabase(
    databaseName,
    environment.allowedDatabaseName,
  );
  assertHistoricBackfillBenchmarkSentinel(
    await dependencies.readBenchmarkSentinelNonces(),
    environment.sentinelNonce,
  );
  if (options.mode === 'prepare-run') {
    dependencies.emit({
      schemaVersion: 1,
      type: 'historic_backfill_benchmark_start',
      timestamp: new Date(startedAt).toISOString(),
      mode: options.mode,
      applyStatistics: false,
      databaseName,
      pollMs: options.pollMs,
      timeoutMs: options.timeoutMs,
      range: options.range,
    });
    const prepared = await dependencies.prepareRun(options.range!);
    const preparedOptions: HistoricBackfillBenchmarkOptions = {
      ...options,
      runId: prepared.id,
    };
    const after = await dependencies.collectMetrics(prepared.id);
    const completedAt = dependencies.now();
    dependencies.emit(
      metricsEvent(preparedOptions, 'after', startedAt, completedAt, after),
    );
    const result = {
      schemaVersion: 1,
      type: 'historic_backfill_benchmark_complete',
      timestamp: new Date(completedAt).toISOString(),
      mode: options.mode,
      applyStatistics: false,
      runId: prepared.id,
      databaseName,
      elapsedMs: completedAt - startedAt,
      deadlineExceeded: completedAt >= deadline,
      operationResult: { preparedRun: prepared },
      delta: null,
    };
    dependencies.emit(result);
    return result;
  }
  const run = await dependencies.readRun(options.runId);
  if (!run)
    throw new Error(`Historic backfill run not found: ${options.runId}`);

  dependencies.emit({
    schemaVersion: 1,
    type: 'historic_backfill_benchmark_start',
    timestamp: new Date(startedAt).toISOString(),
    mode: options.mode,
    applyStatistics: options.applyStatistics,
    runId: options.runId,
    databaseName,
    pollMs: options.pollMs,
    timeoutMs: options.timeoutMs,
    run,
  });

  const baseline = await dependencies.collectMetrics(options.runId);
  let current = baseline;
  dependencies.emit(
    metricsEvent(options, 'before', startedAt, dependencies.now(), baseline),
  );
  let operationResult: unknown = null;

  if (options.mode === 'prepare-artifacts') {
    assertStagingReady(current);
    operationResult = await dependencies.prepareArtifacts(options.runId);
  } else if (options.mode === 'wait-staging') {
    while (!stagingReady(current)) {
      assertRunCanContinue(current);
      const remainingMs = deadline - dependencies.now();
      if (remainingMs <= 0) {
        throw new Error(
          `Historic backfill benchmark timed out after ${options.timeoutMs} ms`,
        );
      }
      await dependencies.sleep(Math.min(options.pollMs, remainingMs));
      current = await dependencies.collectMetrics(options.runId);
      dependencies.emit(
        metricsEvent(
          options,
          'wait-staging',
          startedAt,
          dependencies.now(),
          current,
        ),
      );
    }
    operationResult = { stagingReady: true };
  } else if (options.mode === 'wait-artifacts') {
    while (!artifactsReady(current)) {
      assertArtifactsCanContinue(current);
      const remainingMs = deadline - dependencies.now();
      if (remainingMs <= 0) {
        throw new Error(
          `Historic backfill benchmark timed out after ${options.timeoutMs} ms`,
        );
      }
      await dependencies.sleep(Math.min(options.pollMs, remainingMs));
      current = await dependencies.collectMetrics(options.runId);
      dependencies.emit(
        metricsEvent(
          options,
          'wait-artifacts',
          startedAt,
          dependencies.now(),
          current,
        ),
      );
    }
    operationResult = {
      artifactsReady: true,
      artifactTaskCount: current.runCounts.artifactTaskCount,
    };
  } else {
    assertStagingReady(current);
    operationResult = await runSampledOperation(
      options,
      dependencies,
      startedAt,
      deadline,
      options.mode,
      async () => {
        if (options.mode === 'build-shadow') {
          return dependencies.finalizer.buildShadow(options.runId);
        }
        const dryRun = await dependencies.finalizer.dryRun(options.runId);
        if (!options.applyStatistics) return dryRun;
        if (dependencies.now() >= deadline) {
          throw new Error(
            'Historic backfill benchmark timed out before statistics apply started',
          );
        }
        return {
          dryRun,
          statisticsApply: await dependencies.finalizer.apply(options.runId),
        };
      },
    );
  }

  const after = await dependencies.collectMetrics(options.runId);
  const completedAt = dependencies.now();
  dependencies.emit(
    metricsEvent(options, 'after', startedAt, completedAt, after),
  );
  const result = {
    schemaVersion: 1,
    type: 'historic_backfill_benchmark_complete',
    timestamp: new Date(completedAt).toISOString(),
    mode: options.mode,
    applyStatistics: options.applyStatistics,
    runId: options.runId,
    databaseName,
    elapsedMs: completedAt - startedAt,
    deadlineExceeded: completedAt >= deadline,
    operationResult,
    delta: metricDelta(baseline, after),
  };
  dependencies.emit(result);
  return result;
}

function configureBenchmarkProcess(timeoutMs: number): void {
  process.env.DISABLE_SCHEDULED_JOBS = 'true';
  process.env.RUN_BUSINESS_SCHEDULED_JOBS = 'false';
  process.env.SKIP_SCHEMA_BOOTSTRAP = 'true';
  process.env.SKIP_STARTUP_DATA_LOADS = 'true';
  process.env.SKIP_STARTUP_DEPARTEMENT_STATISTICS = 'true';
  process.env.PGAPPNAME = `vigieau-historic-benchmark-${process.pid}`;
  const statementTimeout = `-c statement_timeout=${timeoutMs}`;
  process.env.PGOPTIONS = [process.env.PGOPTIONS?.trim(), statementTimeout]
    .filter(Boolean)
    .join(' ');
}

async function main(): Promise<void> {
  const options = parseHistoricBackfillBenchmarkOptions(process.argv.slice(2));
  const environment = assertHistoricBackfillBenchmarkEnvironment(process.env);
  configureBenchmarkProcess(options.timeoutMs);

  const pgModule = await import('pg');
  const databaseConnection = {
    user: requiredEnvironmentValue(process.env, 'DATABASE_USER'),
    password: requiredEnvironmentValue(process.env, 'DATABASE_PASSWORD'),
    host: requiredEnvironmentValue(process.env, 'DATABASE_HOST'),
    port: parseBoundedInteger(
      requiredEnvironmentValue(process.env, 'DATABASE_PORT'),
      'DATABASE_PORT',
      5432,
      1,
      65_535,
    ),
    database: environment.configuredDatabaseName,
    ssl:
      process.env.NODE_ENV === 'local'
        ? undefined
        : ({ rejectUnauthorized: false } as const),
  };
  const createPreflightClient = () =>
    new pgModule.Client({
      ...databaseConnection,
      application_name: `${process.env.PGAPPNAME}-preflight`,
    });

  if (options.mode === 'migrate-clone') {
    await preflightHistoricBackfillBenchmark(
      environment,
      createPreflightClient,
    );
    const typeormModule = await import('typeorm');
    const migrationDataSource = new typeormModule.DataSource({
      type: 'postgres',
      host: databaseConnection.host,
      port: databaseConnection.port,
      username: databaseConnection.user,
      password: databaseConnection.password,
      database: databaseConnection.database,
      ssl: databaseConnection.ssl,
      synchronize: false,
      migrations: [`${__dirname}/../migrations/**/*{.ts,.js}`],
      extra: {
        max: 1,
        application_name: `${process.env.PGAPPNAME}-migrations`,
      },
    });
    await runHistoricBackfillCloneMigrations(
      environment,
      migrationDataSource,
      (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
    );
    return;
  }

  const [
    { NestFactory },
    { AppModule },
    finalizerModule,
    queueModule,
    artifactQueueModule,
    typeormModule,
  ] = await loadHistoricBackfillBenchmarkAfterPreflight(
    environment,
    createPreflightClient,
    () =>
      Promise.all([
        import('@nestjs/core'),
        import('../app.module.js'),
        import('../historic_backfill/historic-backfill-finalizer.service.js'),
        import('../historic_backfill/historic-backfill-queue.service.js'),
        import('../historic_backfill/historic-backfill-artifact-queue.service.js'),
        import('typeorm'),
      ]),
  );
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  try {
    const dataSource = app.get(typeormModule.DataSource);
    const executor: QueryExecutor = {
      query: (sql, parameters) => dataSource.query(sql, parameters),
    };
    await runHistoricBackfillBenchmark(options, environment, {
      readConnectedDatabaseName: () =>
        readHistoricBackfillBenchmarkDatabaseName(executor),
      readBenchmarkSentinelNonces: () =>
        readHistoricBackfillBenchmarkSentinelNonces(executor),
      readRun: (runId) => readHistoricBackfillBenchmarkRun(executor, runId),
      collectMetrics: (runId) =>
        collectHistoricBackfillBenchmarkMetrics(executor, runId),
      prepareRun: (range) =>
        app.get(queueModule.HistoricBackfillQueueService).prepare(range),
      prepareArtifacts: (runId) =>
        app
          .get(artifactQueueModule.HistoricBackfillArtifactQueueService)
          .prepare(runId),
      finalizer: app.get(finalizerModule.HistoricBackfillFinalizerService),
      emit: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
      now: () => Date.now(),
      sleep: (milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)),
    });
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        type: 'historic_backfill_benchmark_error',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exitCode = 1;
  });
}
