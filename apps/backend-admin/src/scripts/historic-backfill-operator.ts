import 'reflect-metadata';
import 'dotenv/config';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EXPECTED_DEPARTMENT_COUNT = 101;
const EXPECTED_COMMUNE_COUNT = 34_943;
const OPERATOR_ALLOW_PRODUCTION_ENV =
  'HISTORIC_BACKFILL_OPERATOR_ALLOW_PRODUCTION';

export type HistoricBackfillOperatorCommand =
  | 'preflight'
  | 'status'
  | 'prepare'
  | 'pause'
  | 'resume'
  | 'build-shadow'
  | 'finalize-statistics'
  | 'prepare-artifacts'
  | 'finalize-maps';

export interface HistoricBackfillOperatorOptions {
  command: HistoricBackfillOperatorCommand;
  runId?: string;
  mapDateFrom?: string;
  statisticDateFrom?: string;
  dateThrough?: string;
  apply: boolean;
  allowProduction: boolean;
  expectedDatabase?: string;
}

export interface HistoricBackfillOperatorQueryExecutor {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

export interface HistoricBackfillOperatorDependencies {
  database: HistoricBackfillOperatorQueryExecutor;
  queue: {
    status(runId: string): Promise<unknown>;
    prepare(input: {
      mapDateFrom: string;
      statisticDateFrom: string;
      dateThrough: string;
    }): Promise<unknown>;
    pause(runId: string): Promise<boolean>;
    resume(runId: string): Promise<boolean>;
  };
  artifactQueue: {
    prepare(runId: string): Promise<unknown>;
  };
  statisticsFinalizer: {
    buildShadow(runId: string): Promise<unknown>;
    finalizeStatistics(runId: string, apply: boolean): Promise<unknown>;
  };
  mapFinalizer: {
    dryRun(runId: string): Promise<unknown>;
    apply(runId: string): Promise<unknown>;
  };
}

interface PreflightRow {
  sourceContextCount: string | number;
  legacyDualWrite: boolean | string | null;
  publicRevision: string | null;
  historicComputeEpoch: string | null;
  historicBackfillGlobalEpoch: string | null;
  computeMapDate: string | null;
  computeStatsDate: string | null;
  statisticContextCount: string | number;
  currentPublishedDate: string | null;
  historicPublishedThrough: string | null;
  historicDirtyFrom: string | null;
  historicDirtyThrough: string | null;
  sourceDateFrom: string | null;
  communeCount: string | number;
  departmentCount: string | number;
  currentQueueCount: string | number;
  runningSnapshotCount: string | number;
  runningDailyPublicationCount: string | number;
  unfinishedRunCount: string | number;
  unfinishedRunIds: string[] | null;
  zonePublicationStateCount: string | number;
  zoneCandidateCount: string | number;
  statisticCacheStateCount: string | number;
  statisticCandidateCount: string | number;
  pendingMapOutboxCount: string | number;
  postgresLockWaitCount: string | number;
}

export interface HistoricBackfillOperatorPreflight {
  historicBackfillEnabled: boolean;
  readyForEnable: boolean;
  ready: boolean;
  gates: string[];
  sourceRevision: string | null;
  historicComputeEpoch: string | null;
  historicBackfillGlobalEpoch: string | null;
  computeMapDate: string | null;
  computeStatsDate: string | null;
  currentPublishedDate: string | null;
  historicPublishedThrough: string | null;
  historicDirtyFrom: string | null;
  historicDirtyThrough: string | null;
  sourceDateFrom: string | null;
  recommendedMapDateFrom: string | null;
  recommendedStatisticDateFrom: string | null;
  recommendedDateThrough: string | null;
  communeCount: number;
  departmentCount: number;
  currentQueueCount: number;
  runningSnapshotCount: number;
  runningDailyPublicationCount: number;
  unfinishedRunCount: number;
  unfinishedRunIds: string[];
  zoneCandidateCount: number;
  statisticCandidateCount: number;
  pendingMapOutboxCount: number;
  postgresLockWaitCount: number;
  historicExclusiveLockAvailable: boolean;
  historicLockProbeReleased: boolean;
}

const COMMANDS = new Set<HistoricBackfillOperatorCommand>([
  'preflight',
  'status',
  'prepare',
  'pause',
  'resume',
  'build-shadow',
  'finalize-statistics',
  'prepare-artifacts',
  'finalize-maps',
]);

const RUN_COMMANDS = new Set<HistoricBackfillOperatorCommand>([
  'status',
  'pause',
  'resume',
  'build-shadow',
  'finalize-statistics',
  'prepare-artifacts',
  'finalize-maps',
]);

const VALUE_ARGUMENTS = new Set([
  '--run-id',
  '--map-date-from',
  '--statistic-date-from',
  '--date-through',
  '--expected-database',
]);

const BOOLEAN_ARGUMENTS = new Set(['--apply', '--allow-production']);

function parseCivilDate(name: string, value: string | undefined): string {
  if (!value || !CIVIL_DATE_PATTERN.test(value)) {
    throw new Error(`${name} must use the YYYY-MM-DD format`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${name} must be a valid civil date`);
  }
  return value;
}

function requiredArgument(values: Map<string, string>, name: string): string {
  const value = values.get(name)?.trim();
  if (!value) throw new Error(`Missing argument: ${name}`);
  return value;
}

function assertAllowedArguments(
  command: HistoricBackfillOperatorCommand,
  seen: Set<string>,
): void {
  const allowed = new Set(['--expected-database', '--allow-production']);
  if (RUN_COMMANDS.has(command)) allowed.add('--run-id');
  if (command === 'prepare') {
    allowed.add('--map-date-from');
    allowed.add('--statistic-date-from');
    allowed.add('--date-through');
  }
  if (command === 'finalize-statistics' || command === 'finalize-maps') {
    allowed.add('--apply');
  }
  for (const argument of seen) {
    if (!allowed.has(argument)) {
      throw new Error(`${argument} is not valid with command ${command}`);
    }
  }
}

export function parseHistoricBackfillOperatorOptions(
  args: string[],
): HistoricBackfillOperatorOptions {
  const command = args[0] as HistoricBackfillOperatorCommand | undefined;
  if (!command || !COMMANDS.has(command)) {
    throw new Error(
      'Command must be preflight, status, prepare, pause, resume, build-shadow, finalize-statistics, prepare-artifacts, or finalize-maps',
    );
  }

  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (!VALUE_ARGUMENTS.has(argument) && !BOOLEAN_ARGUMENTS.has(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (seen.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    seen.add(argument);
    if (BOOLEAN_ARGUMENTS.has(argument)) {
      booleans.add(argument);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for argument: ${argument}`);
    }
    values.set(argument, value);
    index += 1;
  }
  assertAllowedArguments(command, seen);

  const expectedDatabase = values.get('--expected-database')?.trim();
  if (values.has('--expected-database') && !expectedDatabase) {
    throw new Error('--expected-database must not be empty');
  }

  const options: HistoricBackfillOperatorOptions = {
    command,
    apply: booleans.has('--apply'),
    allowProduction: booleans.has('--allow-production'),
    ...(expectedDatabase ? { expectedDatabase } : {}),
  };

  if (RUN_COMMANDS.has(command)) {
    const runId = requiredArgument(values, '--run-id');
    if (!UUID_PATTERN.test(runId)) throw new Error('--run-id must be a UUID');
    options.runId = runId;
  }
  if (command === 'prepare') {
    options.mapDateFrom = parseCivilDate(
      '--map-date-from',
      values.get('--map-date-from'),
    );
    options.statisticDateFrom = parseCivilDate(
      '--statistic-date-from',
      values.get('--statistic-date-from'),
    );
    options.dateThrough = parseCivilDate(
      '--date-through',
      values.get('--date-through'),
    );
    if (options.mapDateFrom > options.dateThrough) {
      throw new Error('--map-date-from must not be after --date-through');
    }
    if (options.statisticDateFrom > options.dateThrough) {
      throw new Error('--statistic-date-from must not be after --date-through');
    }
  }
  return options;
}

export function isHistoricBackfillOperatorMutation(
  options: HistoricBackfillOperatorOptions,
): boolean {
  return (
    [
      'prepare',
      'pause',
      'resume',
      'build-shadow',
      'prepare-artifacts',
    ].includes(options.command) ||
    ((options.command === 'finalize-statistics' ||
      options.command === 'finalize-maps') &&
      options.apply)
  );
}

function parseHistoricBackfillEnabled(environment: NodeJS.ProcessEnv): boolean {
  const value =
    environment.HISTORIC_BACKFILL_ENABLED?.trim().toLowerCase() ?? 'false';
  if (value !== 'true' && value !== 'false') {
    throw new Error('HISTORIC_BACKFILL_ENABLED must be either true or false');
  }
  return value === 'true';
}

export function assertHistoricBackfillOperatorFeatureEnabled(
  options: HistoricBackfillOperatorOptions,
  environment: NodeJS.ProcessEnv,
): void {
  if (options.command === 'preflight' || options.command === 'status') return;
  if (!parseHistoricBackfillEnabled(environment)) {
    throw new Error('HISTORIC_BACKFILL_ENABLED must be true for this command');
  }
}

export function assertHistoricBackfillOperatorProductionIntent(
  options: HistoricBackfillOperatorOptions,
  environment: NodeJS.ProcessEnv,
): void {
  if (!isHistoricBackfillOperatorMutation(options)) return;
  if (!options.allowProduction) {
    throw new Error('Production mutation requires --allow-production');
  }
  if (environment[OPERATOR_ALLOW_PRODUCTION_ENV]?.trim() !== 'true') {
    throw new Error(
      `Production mutation requires ${OPERATOR_ALLOW_PRODUCTION_ENV}=true`,
    );
  }
  if (!options.expectedDatabase) {
    throw new Error('Production mutation requires --expected-database');
  }
}

export function assertHistoricBackfillOperatorDatabase(
  options: HistoricBackfillOperatorOptions,
  currentDatabase: string,
): void {
  const normalizedCurrentDatabase = currentDatabase.trim();
  if (!normalizedCurrentDatabase) {
    throw new Error('current_database() returned an empty name');
  }
  if (
    options.expectedDatabase &&
    options.expectedDatabase !== normalizedCurrentDatabase
  ) {
    throw new Error('--expected-database does not match current_database()');
  }
  if (
    isHistoricBackfillOperatorMutation(options) &&
    !options.expectedDatabase
  ) {
    throw new Error('Production mutation requires --expected-database');
  }
}

export function configureHistoricBackfillOperatorProcess(
  environment: NodeJS.ProcessEnv = process.env,
  processId = process.pid,
): void {
  environment.DISABLE_SCHEDULED_JOBS = 'true';
  environment.RUN_BUSINESS_SCHEDULED_JOBS = 'false';
  environment.SKIP_SCHEMA_BOOTSTRAP = 'true';
  environment.SKIP_STARTUP_DATA_LOADS = 'true';
  environment.SKIP_STARTUP_DEPARTEMENT_STATISTICS = 'true';
  environment.HISTORIC_SKIP_COMMUNE_INTERSECTIONS = 'true';
  environment.PGAPPNAME = `vigieau-historic-operator-${processId}`;
}

function rows(result: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(result)) {
    throw new Error('Unexpected PostgreSQL query result');
  }
  return result as Array<Record<string, unknown>>;
}

function databaseCount(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: ${String(value)}`);
  }
  return parsed;
}

function databaseBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 't';
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function minimumCivilDate(values: Array<string | null>): string | null {
  const dates = values.filter((value): value is string => value !== null);
  for (const date of dates) parseCivilDate('database date', date);
  return dates.sort()[0] ?? null;
}

function previousCivilDate(value: string | null): string | null {
  if (value === null) return null;
  const date = new Date(`${parseCivilDate('database date', value)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export async function readHistoricBackfillOperatorDatabaseName(
  executor: HistoricBackfillOperatorQueryExecutor,
): Promise<string> {
  const row = rows(
    await executor.query('SELECT current_database()::text AS "databaseName"'),
  )[0];
  const databaseName = nullableString(row?.databaseName)?.trim();
  if (!databaseName) throw new Error('current_database() returned no name');
  return databaseName;
}

export async function collectHistoricBackfillOperatorPreflight(
  executor: HistoricBackfillOperatorQueryExecutor,
  historicBackfillEnabled: boolean,
): Promise<HistoricBackfillOperatorPreflight> {
  const row = rows(
    await executor.query(`
      SELECT
        (SELECT COUNT(*)::integer
         FROM "zone_publication_source_state" WHERE "id" = 1)
          AS "sourceContextCount",
        (SELECT "legacyDualWrite"
         FROM "zone_publication_source_state" WHERE "id" = 1)
          AS "legacyDualWrite",
        (SELECT "publicRevision"::text
         FROM "zone_publication_source_state" WHERE "id" = 1)
          AS "publicRevision",
        (SELECT "historicComputeEpoch"::text FROM "config" WHERE "id" = 1)
          AS "historicComputeEpoch",
        (SELECT "historicBackfillGlobalEpoch"::text
         FROM "config" WHERE "id" = 1)
          AS "historicBackfillGlobalEpoch",
        (SELECT "computeMapDate"::text FROM "config" WHERE "id" = 1)
          AS "computeMapDate",
        (SELECT "computeStatsDate"::text FROM "config" WHERE "id" = 1)
          AS "computeStatsDate",
        (SELECT COUNT(*)::integer
         FROM "statistic_publication_state" WHERE "id" = 1)
          AS "statisticContextCount",
        (SELECT "currentPublishedDate"::text
         FROM "statistic_publication_state" WHERE "id" = 1)
          AS "currentPublishedDate",
        (SELECT "historicPublishedThrough"::text
         FROM "statistic_publication_state" WHERE "id" = 1)
          AS "historicPublishedThrough",
        (SELECT "historicDirtyFrom"::text
         FROM "statistic_publication_state" WHERE "id" = 1)
          AS "historicDirtyFrom",
        (SELECT "historicDirtyThrough"::text
         FROM "statistic_publication_state" WHERE "id" = 1)
          AS "historicDirtyThrough",
        (
          SELECT MIN(source_dates.value)::text
          FROM (
            SELECT "dateDebut" AS value
            FROM "arrete_restriction"
            WHERE "statut" IN ('publie', 'abroge')
              AND "dateDebut" IS NOT NULL
            UNION ALL
            SELECT "dateDebut" AS value
            FROM "parametres"
            WHERE "dateDebut" IS NOT NULL
          ) source_dates
        ) AS "sourceDateFrom",
        (SELECT COUNT(*)::integer FROM "commune") AS "communeCount",
        (SELECT COUNT(*)::integer FROM "departement") AS "departmentCount",
        (SELECT COUNT(*)::integer FROM "current_zone_recompute_request")
          AS "currentQueueCount",
        (SELECT COUNT(*)::integer FROM "statistic_commune_snapshot"
         WHERE "status" = 'running') AS "runningSnapshotCount",
        (SELECT COUNT(*)::integer FROM "external_publication_run"
         WHERE "jobKey" = 'compute:national-daily' AND "status" = 'running')
          AS "runningDailyPublicationCount",
        (SELECT COUNT(*)::integer FROM "historic_backfill_run"
         WHERE "status" IN ('preparing', 'running', 'paused'))
          AS "unfinishedRunCount",
        ARRAY(
          SELECT "id"::text FROM "historic_backfill_run"
          WHERE "status" IN ('preparing', 'running', 'paused')
          ORDER BY "createdAt", "id"
        ) AS "unfinishedRunIds",
        (SELECT COUNT(*)::integer FROM "zone_publication_state" WHERE "id" = 1)
          AS "zonePublicationStateCount",
        (SELECT COUNT(*)::integer FROM "zone_publication_state"
         WHERE "id" = 1 AND "candidatePublicationId" IS NOT NULL)
          AS "zoneCandidateCount",
        (SELECT COUNT(*)::integer FROM "statistic_cache_state" WHERE "id" = 1)
          AS "statisticCacheStateCount",
        (SELECT COUNT(*)::integer FROM "statistic_cache_state"
         WHERE "id" = 1 AND "candidatePublicationId" IS NOT NULL)
          AS "statisticCandidateCount",
        (SELECT COUNT(*)::integer
         FROM "historic_backfill_map_manifest_outbox"
         WHERE "status" = 'pending') AS "pendingMapOutboxCount",
        (SELECT COUNT(*)::integer FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock') AS "postgresLockWaitCount"
    `),
  )[0] as unknown as PreflightRow | undefined;
  if (!row) throw new Error('Historic backfill preflight returned no row');

  const lockProbe = rows(
    await executor.query(`
      SELECT
        pg_try_advisory_xact_lock(
          hashtext('vigieau'), hashtext('zone-compute-historic')
        ) AS locked,
        true AS unlocked
    `),
  )[0];

  const sourceContextCount = databaseCount(
    row.sourceContextCount,
    'source context count',
  );
  const statisticContextCount = databaseCount(
    row.statisticContextCount,
    'statistic context count',
  );
  const communeCount = databaseCount(row.communeCount, 'commune count');
  const departmentCount = databaseCount(
    row.departmentCount,
    'department count',
  );
  const currentQueueCount = databaseCount(
    row.currentQueueCount,
    'current queue count',
  );
  const runningSnapshotCount = databaseCount(
    row.runningSnapshotCount,
    'running snapshot count',
  );
  const runningDailyPublicationCount = databaseCount(
    row.runningDailyPublicationCount,
    'running daily publication count',
  );
  const unfinishedRunCount = databaseCount(
    row.unfinishedRunCount,
    'unfinished run count',
  );
  const zonePublicationStateCount = databaseCount(
    row.zonePublicationStateCount,
    'zone publication state count',
  );
  const zoneCandidateCount = databaseCount(
    row.zoneCandidateCount,
    'zone candidate count',
  );
  const statisticCacheStateCount = databaseCount(
    row.statisticCacheStateCount,
    'statistic cache state count',
  );
  const statisticCandidateCount = databaseCount(
    row.statisticCandidateCount,
    'statistic candidate count',
  );
  const pendingMapOutboxCount = databaseCount(
    row.pendingMapOutboxCount,
    'pending map outbox count',
  );
  const postgresLockWaitCount = databaseCount(
    row.postgresLockWaitCount,
    'PostgreSQL lock wait count',
  );
  const historicExclusiveLockAvailable = databaseBoolean(lockProbe?.locked);
  const historicLockProbeReleased = databaseBoolean(lockProbe?.unlocked);
  const historicDirtyFrom = nullableString(row.historicDirtyFrom);
  const historicDirtyThrough = nullableString(row.historicDirtyThrough);
  const sourceDateFrom = nullableString(row.sourceDateFrom);
  const computeMapDate = nullableString(row.computeMapDate);
  const computeStatsDate = nullableString(row.computeStatsDate);
  const currentPublishedDate = nullableString(row.currentPublishedDate);
  const recommendedMapDateFrom = minimumCivilDate([
    sourceDateFrom,
    computeMapDate,
    computeStatsDate,
    historicDirtyFrom,
  ]);
  const recommendedStatisticDateFrom = minimumCivilDate([
    sourceDateFrom,
    computeStatsDate,
    historicDirtyFrom,
  ]);
  const recommendedDateThrough = previousCivilDate(currentPublishedDate);

  const enableGates: string[] = [];
  if (sourceContextCount !== 1) enableGates.push('source-context');
  if (statisticContextCount !== 1) enableGates.push('statistic-context');
  if (databaseBoolean(row.legacyDualWrite)) {
    enableGates.push('public-revisions-not-separated');
  }
  if (!currentPublishedDate) {
    enableGates.push('current-published-date');
  }
  if (!sourceDateFrom) enableGates.push('source-date-from');
  if ((historicDirtyFrom === null) !== (historicDirtyThrough === null)) {
    enableGates.push('historic-dirty-range');
  }
  if (
    recommendedDateThrough !== null &&
    [
      recommendedMapDateFrom,
      recommendedStatisticDateFrom,
      historicDirtyThrough,
    ].some(
      (date): date is string => date !== null && date > recommendedDateThrough,
    )
  ) {
    enableGates.push('historic-bounds');
  }
  if (departmentCount !== EXPECTED_DEPARTMENT_COUNT) {
    enableGates.push('department-count');
  }
  if (communeCount !== EXPECTED_COMMUNE_COUNT) {
    enableGates.push('commune-count');
  }
  if (currentQueueCount !== 0) enableGates.push('current-queue');
  if (runningSnapshotCount !== 0) enableGates.push('running-snapshot');
  if (runningDailyPublicationCount !== 0) {
    enableGates.push('running-daily-publication');
  }
  if (unfinishedRunCount !== 0) enableGates.push('unfinished-run');
  if (zonePublicationStateCount !== 1) {
    enableGates.push('zone-publication-state');
  }
  if (zoneCandidateCount !== 0) enableGates.push('zone-candidate');
  if (statisticCacheStateCount !== 1) {
    enableGates.push('statistic-cache-state');
  }
  if (statisticCandidateCount !== 0) {
    enableGates.push('statistic-candidate');
  }
  if (pendingMapOutboxCount !== 0) {
    enableGates.push('pending-map-outbox');
  }
  if (postgresLockWaitCount !== 0) enableGates.push('postgres-lock-waits');
  if (!historicExclusiveLockAvailable) {
    enableGates.push('historic-exclusive-lock');
  }
  if (historicExclusiveLockAvailable && !historicLockProbeReleased) {
    enableGates.push('historic-lock-probe-cleanup');
  }

  const gates = [
    ...(!historicBackfillEnabled ? ['historic-backfill-disabled'] : []),
    ...enableGates,
  ];
  return {
    historicBackfillEnabled,
    readyForEnable: enableGates.length === 0,
    ready: gates.length === 0,
    gates,
    sourceRevision: nullableString(row.publicRevision),
    historicComputeEpoch: nullableString(row.historicComputeEpoch),
    historicBackfillGlobalEpoch: nullableString(
      row.historicBackfillGlobalEpoch,
    ),
    computeMapDate,
    computeStatsDate,
    currentPublishedDate,
    historicPublishedThrough: nullableString(row.historicPublishedThrough),
    historicDirtyFrom,
    historicDirtyThrough,
    sourceDateFrom,
    recommendedMapDateFrom,
    recommendedStatisticDateFrom,
    recommendedDateThrough,
    communeCount,
    departmentCount,
    currentQueueCount,
    runningSnapshotCount,
    runningDailyPublicationCount,
    unfinishedRunCount,
    unfinishedRunIds: Array.isArray(row.unfinishedRunIds)
      ? row.unfinishedRunIds.map(String)
      : [],
    zoneCandidateCount,
    statisticCandidateCount,
    pendingMapOutboxCount,
    postgresLockWaitCount,
    historicExclusiveLockAvailable,
    historicLockProbeReleased,
  };
}

export async function executeHistoricBackfillOperator(
  options: HistoricBackfillOperatorOptions,
  dependencies: HistoricBackfillOperatorDependencies,
  historicBackfillEnabled: boolean,
): Promise<unknown> {
  switch (options.command) {
    case 'preflight':
      return collectHistoricBackfillOperatorPreflight(
        dependencies.database,
        historicBackfillEnabled,
      );
    case 'status':
      return dependencies.queue.status(options.runId!);
    case 'prepare':
      return dependencies.queue.prepare({
        mapDateFrom: options.mapDateFrom!,
        statisticDateFrom: options.statisticDateFrom!,
        dateThrough: options.dateThrough!,
      });
    case 'pause':
      return { paused: await dependencies.queue.pause(options.runId!) };
    case 'resume':
      return { resumed: await dependencies.queue.resume(options.runId!) };
    case 'build-shadow':
      return dependencies.statisticsFinalizer.buildShadow(options.runId!);
    case 'finalize-statistics':
      return dependencies.statisticsFinalizer.finalizeStatistics(
        options.runId!,
        options.apply,
      );
    case 'prepare-artifacts':
      return dependencies.artifactQueue.prepare(options.runId!);
    case 'finalize-maps':
      return options.apply
        ? dependencies.mapFinalizer.apply(options.runId!)
        : dependencies.mapFinalizer.dryRun(options.runId!);
  }
}

const SENSITIVE_KEY_PATTERN =
  /(PASSWORD|SECRET|TOKEN|API.*KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|SIGNATURE|DATABASE_URL|POSTGRESQL_URL|DSN|CERT)/i;

function redactionValues(environment: NodeJS.ProcessEnv): string[] {
  return Object.entries(environment)
    .filter(([name, value]) => {
      return Boolean(value) && SENSITIVE_KEY_PATTERN.test(name);
    })
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length);
}

function redactHistoricBackfillOperatorString(
  value: string,
  environment: NodeJS.ProcessEnv,
): string {
  let redacted = value;
  for (const secret of redactionValues(environment)) {
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(
      /\b(password|secret|token|key|api[_-]?key|access[_-]?key|private[_-]?key|credential|signature)=([^\s&]+)/gi,
      '$1=[REDACTED]',
    );
}

export function stringifyHistoricBackfillOperatorJson(
  value: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return JSON.stringify(value, (key, nestedValue: unknown) => {
    if (key && SENSITIVE_KEY_PATTERN.test(key)) return '[REDACTED]';
    return typeof nestedValue === 'string'
      ? redactHistoricBackfillOperatorString(nestedValue, environment)
      : nestedValue;
  });
}

export function safeHistoricBackfillOperatorError(
  error: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): { name: string; message: string } {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const message = redactHistoricBackfillOperatorString(
    normalized.message,
    environment,
  ).slice(0, 4_000);
  return { name: normalized.name || 'Error', message };
}

async function main(): Promise<void> {
  let options: HistoricBackfillOperatorOptions | undefined;
  let databaseName: string | null = null;
  try {
    options = parseHistoricBackfillOperatorOptions(process.argv.slice(2));
    assertHistoricBackfillOperatorFeatureEnabled(options, process.env);
    assertHistoricBackfillOperatorProductionIntent(options, process.env);
    configureHistoricBackfillOperatorProcess();

    const [
      { NestFactory },
      { AppModule },
      typeormModule,
      queueModule,
      artifactQueueModule,
      statisticsFinalizerModule,
      mapFinalizerModule,
    ] = await Promise.all([
      import('@nestjs/core'),
      import('../app.module.js'),
      import('typeorm'),
      import('../historic_backfill/historic-backfill-queue.service.js'),
      import('../historic_backfill/historic-backfill-artifact-queue.service.js'),
      import('../historic_backfill/historic-backfill-finalizer.service.js'),
      import('../historic_backfill/historic-backfill-map-finalizer.service.js'),
    ]);
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    let result: unknown;
    try {
      const database = app.get(typeormModule.DataSource);
      database.setOptions({ logging: [] });
      databaseName = await readHistoricBackfillOperatorDatabaseName(database);
      assertHistoricBackfillOperatorDatabase(options, databaseName);
      const historicBackfillEnabled = parseHistoricBackfillEnabled(process.env);
      result = await executeHistoricBackfillOperator(
        options,
        {
          database,
          queue: app.get(queueModule.HistoricBackfillQueueService),
          artifactQueue: app.get(
            artifactQueueModule.HistoricBackfillArtifactQueueService,
          ),
          statisticsFinalizer: app.get(
            statisticsFinalizerModule.HistoricBackfillFinalizerService,
          ),
          mapFinalizer: app.get(
            mapFinalizerModule.HistoricBackfillMapFinalizerService,
          ),
        },
        historicBackfillEnabled,
      );
    } finally {
      await app.close();
    }
    process.stdout.write(
      `${stringifyHistoricBackfillOperatorJson({
        schemaVersion: 1,
        type: 'historic_backfill_operator_result',
        timestamp: new Date().toISOString(),
        command: options.command,
        apply: options.apply,
        databaseName,
        result,
      })}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${stringifyHistoricBackfillOperatorJson({
        schemaVersion: 1,
        type: 'historic_backfill_operator_error',
        timestamp: new Date().toISOString(),
        command: options?.command ?? process.argv[2] ?? null,
        apply: options?.apply ?? false,
        databaseName,
        error: safeHistoricBackfillOperatorError(error),
      })}\n`,
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
