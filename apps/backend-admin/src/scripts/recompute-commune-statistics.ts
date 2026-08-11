import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
// Moment exposes a CommonJS callable export under the current Jest/NodeNext setup.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import moment = require('moment');
import { Moment } from 'moment';
import { DataSource, QueryRunner } from 'typeorm';
import {
  getParisSchedule,
  getScheduledCivilDate,
  NATIONAL_COMPUTE_START_HOUR,
} from '../core/scheduling/daily-job-schedule';
import { isZonePublicationEnabled } from '../zone_publication/zone_publication.config';

const HISTORIC_LOCK_TIMEOUT_MS_DEFAULT = 60 * 60 * 1000;
const HISTORIC_LOCK_RETRY_MS_DEFAULT = 1000;
const HISTORIC_RECOMPUTE_MAX_DATES_DEFAULT = 100;
const HISTORIC_RECOMPUTE_MAX_DATES_LIMIT = 3660;

interface RecomputeOptions {
  dates: string[];
  departementCodes: string[];
  confirmNationalRecompute: boolean;
  publishThrough: string | null;
  recomputeMonths: boolean;
  sortAtEnd: boolean;
  historicLockTimeoutMs: number;
  historicLockRetryMs: number;
  maxDates: number;
}

interface HistoricContext {
  historicComputeEpoch: string;
  sourceRevision: string;
}

interface DepartementLike {
  id: number;
  code: string;
}

interface RecomputeDependencies {
  departementService: {
    findAllLight: () => Promise<DepartementLike[]>;
  };
  historicService: {
    computeZonesForDate: (
      date: Moment,
      departements: DepartementLike[],
      checkpointOptions: {
        previousDate: string | null;
        historicComputeEpoch: string;
        expectedSourceRevision: string;
      },
    ) => Promise<void>;
    findZonesForStatistics: (departementCodes: string[]) => Promise<any[]>;
  };
  statisticCommuneService: {
    computeCommuneStatisticsRestrictions: (
      zones: any[],
      date: Date,
      historic: boolean,
      historicNotComputed: boolean,
      departementCodes: string[] | undefined,
      hooks: {
        beforeCommuneStatistics: () => Promise<void>;
        beforeCertification: () => Promise<void>;
        sourceRevision: string;
        historicComputeEpoch: string;
        preserveBootstrapBarrier: boolean;
        requireNationalCoverage: boolean;
        publishCurrentDate: boolean;
      },
    ) => Promise<void>;
    computeCommuneStatisticsRestrictionsByMonth: (
      date: Date,
      departementCodes?: string[],
      allowCurrentSnapshot?: boolean,
    ) => Promise<void>;
    sortStatCommune: (departementCodes?: string[]) => Promise<void>;
  };
  statisticDepartementService: {
    computeDepartementStatisticsRestrictions: (
      zones: any[],
      date: Date,
      historic?: boolean,
      historicNotComputed?: boolean,
      departementCodes?: string[],
    ) => Promise<void>;
    sortStatDepartement: () => Promise<void>;
  };
  statisticService: {
    computeDepartementsSituation: (
      zones: any[],
      date?: string,
      departementCodes?: string[],
    ) => Promise<void>;
  };
  configService: {
    getConfig: () => Promise<{ historicComputeEpoch?: string | number } | null>;
  };
  zonePublicationService: {
    getSourceRevision: () => Promise<string>;
  };
  dataSource: DataSource;
}

export function parseMoment(date: string): Moment {
  const parsedDate = moment.utc(date, 'YYYY-MM-DD', true);
  if (!parsedDate.isValid()) {
    throw new Error(`Invalid date: ${date}`);
  }
  return parsedDate;
}

export function parseDates(
  environment: NodeJS.ProcessEnv = process.env,
  maxDates = HISTORIC_RECOMPUTE_MAX_DATES_DEFAULT,
  today: Moment = parseMoment(getParisSchedule(new Date()).date),
): string[] {
  const dates = new Set<string>();
  const todayString = today.clone().utc().startOf('day').format('YYYY-MM-DD');
  const addDate = (date: string) => {
    const parsedDate = parseMoment(date);
    const dateString = parsedDate.format('YYYY-MM-DD');
    if (dateString > todayString) {
      throw new Error(
        `Future recomputation date is not allowed: ${dateString}`,
      );
    }
    dates.add(dateString);
    if (dates.size > maxDates) {
      throw new Error(
        `Too many recomputation dates: ${dates.size}/${maxDates} (set HISTORIC_RECOMPUTE_MAX_DATES explicitly to override)`,
      );
    }
  };

  if (environment.DATES) {
    environment.DATES.split(',')
      .map((date) => date.trim())
      .filter(Boolean)
      .forEach(addDate);
  }

  if (environment.DATE_FROM || environment.DATE_TO) {
    if (!environment.DATE_FROM || !environment.DATE_TO) {
      throw new Error('DATE_FROM and DATE_TO must be set together');
    }

    const from = parseMoment(environment.DATE_FROM);
    const to = parseMoment(environment.DATE_TO);
    if (from.isAfter(to, 'day')) {
      throw new Error(
        `Invalid date range: ${environment.DATE_FROM}..${environment.DATE_TO}`,
      );
    }
    if (to.format('YYYY-MM-DD') > todayString) {
      throw new Error(
        `Future recomputation date is not allowed: ${to.format('YYYY-MM-DD')}`,
      );
    }

    for (
      let date = moment.utc(from);
      date.isSameOrBefore(to, 'day');
      date.add(1, 'day')
    ) {
      addDate(date.format('YYYY-MM-DD'));
    }
  }

  const sortedDates = [...dates].sort();
  sortedDates.forEach(parseMoment);
  if (sortedDates.length === 0) {
    throw new Error('Set DATES=YYYY-MM-DD[,YYYY-MM-DD] or DATE_FROM/DATE_TO');
  }

  return sortedDates;
}

export function parseDepartementCodes(
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    ...new Set(
      (environment.DEP_CODES || environment.DEP_CODE || '')
        .split(',')
        .map((code) => code.trim().toUpperCase())
        .filter(Boolean),
    ),
  ].sort();
}

export function parseBooleanOption(
  name: string,
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue === 'true') {
    return true;
  }
  if (normalizedValue === 'false') {
    return false;
  }
  throw new Error(`Invalid ${name}: ${value} (expected true or false)`);
}

export function parsePositiveIntegerOption(
  name: string,
  value: string | undefined,
  defaultValue: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  const normalizedValue = value.trim();
  if (!/^\d+$/.test(normalizedValue)) {
    throw new Error(`Invalid ${name}: ${value} (expected a positive integer)`);
  }
  const parsedValue = Number(normalizedValue);
  if (
    !Number.isSafeInteger(parsedValue) ||
    parsedValue <= 0 ||
    parsedValue > maximum
  ) {
    throw new Error(`Invalid ${name}: ${value} (expected a positive integer)`);
  }
  return parsedValue;
}

export function parseOptions(
  environment: NodeJS.ProcessEnv = process.env,
  today: Moment = parseMoment(getParisSchedule(new Date()).date),
): RecomputeOptions {
  const maxDates = parsePositiveIntegerOption(
    'HISTORIC_RECOMPUTE_MAX_DATES',
    environment.HISTORIC_RECOMPUTE_MAX_DATES,
    HISTORIC_RECOMPUTE_MAX_DATES_DEFAULT,
    HISTORIC_RECOMPUTE_MAX_DATES_LIMIT,
  );
  const dates = parseDates(environment, maxDates, today);
  const departementCodes = parseDepartementCodes(environment);
  const rawPublishThrough = environment.PUBLISH_THROUGH?.trim();
  const publishThrough = rawPublishThrough
    ? parseMoment(rawPublishThrough).format('YYYY-MM-DD')
    : null;
  if (publishThrough !== null && !dates.includes(publishThrough)) {
    throw new Error('PUBLISH_THROUGH must be included in DATES');
  }
  if (publishThrough !== null && departementCodes.length > 0) {
    throw new Error('PUBLISH_THROUGH requires a national recomputation');
  }
  if (publishThrough !== null && dates.at(-1) !== publishThrough) {
    throw new Error('PUBLISH_THROUGH must be the last recomputation date');
  }
  const recomputeMonths = parseBooleanOption(
    'RECOMPUTE_MONTHS',
    environment.RECOMPUTE_MONTHS,
    true,
  );
  const sortAtEnd = parseBooleanOption(
    'SORT_AT_END',
    environment.SORT_AT_END,
    true,
  );
  if (!recomputeMonths) {
    throw new Error('Statistic recomputation requires RECOMPUTE_MONTHS=true');
  }
  if (!sortAtEnd) {
    throw new Error('Statistic recomputation requires SORT_AT_END=true');
  }
  const options = {
    dates,
    departementCodes,
    confirmNationalRecompute: parseBooleanOption(
      'CONFIRM_NATIONAL_RECOMPUTE',
      environment.CONFIRM_NATIONAL_RECOMPUTE,
      false,
    ),
    publishThrough,
    recomputeMonths,
    sortAtEnd,
    historicLockTimeoutMs: parsePositiveIntegerOption(
      'HISTORIC_RECOMPUTE_LOCK_TIMEOUT_MS',
      environment.HISTORIC_RECOMPUTE_LOCK_TIMEOUT_MS,
      HISTORIC_LOCK_TIMEOUT_MS_DEFAULT,
    ),
    historicLockRetryMs: parsePositiveIntegerOption(
      'HISTORIC_RECOMPUTE_LOCK_RETRY_MS',
      environment.HISTORIC_RECOMPUTE_LOCK_RETRY_MS,
      HISTORIC_LOCK_RETRY_MS_DEFAULT,
    ),
    maxDates,
  };
  assertNationalScopeIsConfirmed(options);
  return options;
}

function assertNationalScopeIsConfirmed(
  options: Pick<
    RecomputeOptions,
    'departementCodes' | 'confirmNationalRecompute'
  >,
): void {
  if (
    options.departementCodes.length === 0 &&
    !options.confirmNationalRecompute
  ) {
    throw new Error(
      'National recomputation requires CONFIRM_NATIONAL_RECOMPUTE=true',
    );
  }
}

export function applyOneOffSafetyFlags(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  environment.DISABLE_SCHEDULED_JOBS = 'true';
  environment.SKIP_SCHEMA_BOOTSTRAP = 'true';
  environment.SKIP_STARTUP_DATA_LOADS = 'true';
  environment.SKIP_STARTUP_DEPARTEMENT_STATISTICS = 'true';
  environment.SANDRE_ZONE_SYNC_MODE = 'paused';
}

function normalizeContextInteger(name: string, value: unknown): string {
  const normalizedValue = String(value ?? '');
  if (!/^\d+$/.test(normalizedValue)) {
    throw new Error(`Invalid ${name}: ${normalizedValue || 'missing'}`);
  }
  return normalizedValue;
}

async function readHistoricContext(
  dependencies: Pick<
    RecomputeDependencies,
    'configService' | 'zonePublicationService'
  >,
): Promise<HistoricContext> {
  const [config, sourceRevision] = await Promise.all([
    dependencies.configService.getConfig(),
    dependencies.zonePublicationService.getSourceRevision(),
  ]);
  if (!config) {
    throw new Error('Historic cursor configuration is missing');
  }
  return {
    historicComputeEpoch: normalizeContextInteger(
      'historic compute epoch',
      config.historicComputeEpoch,
    ),
    sourceRevision: normalizeContextInteger(
      'zone publication source revision',
      sourceRevision,
    ),
  };
}

async function assertHistoricContext(
  dependencies: Pick<
    RecomputeDependencies,
    'configService' | 'zonePublicationService'
  >,
  expected: HistoricContext,
): Promise<void> {
  const current = await readHistoricContext(dependencies);
  if (current.historicComputeEpoch !== expected.historicComputeEpoch) {
    throw new Error(
      `Historic compute epoch changed during recomputation (${expected.historicComputeEpoch} -> ${current.historicComputeEpoch})`,
    );
  }
  if (current.sourceRevision !== expected.sourceRevision) {
    throw new Error(
      `Zone publication source revision changed during recomputation (${expected.sourceRevision} -> ${current.sourceRevision})`,
    );
  }
}

async function assertNoBootstrapBarrier(dataSource: DataSource): Promise<void> {
  const [bootstrapBarrier] = await dataSource.query(
    `
      SELECT "snapshotDate", "status"
      FROM "statistic_commune_snapshot"
      WHERE "scope" = 'bootstrap'
      LIMIT 1
    `,
  );
  if (bootstrapBarrier) {
    throw new Error(
      'Targeted commune statistic recomputation is blocked until the bootstrap barrier is cleared by the normal historic chain',
    );
  }
}

interface SessionAdvisoryLock {
  tryLockSql: string;
  unlockSql: string;
  parameters?: unknown[];
  timeoutMessage: string;
  unlockMessage: string;
}

function attachCleanupError(
  primaryError: unknown,
  cleanupError: unknown,
): void {
  if (!(primaryError instanceof Error) || cleanupError === undefined) {
    return;
  }
  const errorWithCause = primaryError as Error & { cause?: unknown };
  if (errorWithCause.cause === undefined) {
    errorWithCause.cause = cleanupError;
  }
}

async function withSessionAdvisoryLock<T>(
  dataSource: DataSource,
  task: () => Promise<T>,
  options: { timeoutMs: number; retryMs: number },
  lock: SessionAdvisoryLock,
): Promise<T> {
  const queryRunner: QueryRunner = dataSource.createQueryRunner();
  let connected = false;
  let locked = false;
  let result: T | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;

  try {
    await queryRunner.connect();
    connected = true;
    const deadline = Date.now() + options.timeoutMs;
    while (!locked) {
      const [lockResult] = await queryRunner.query(
        lock.tryLockSql,
        lock.parameters,
      );
      locked = lockResult?.locked === true;
      if (locked) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error(lock.timeoutMessage);
      }
      await new Promise((resolve) => setTimeout(resolve, options.retryMs));
    }

    result = await task();
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }

  let cleanupError: unknown;
  if (locked) {
    try {
      const [unlockResult] = await queryRunner.query(
        lock.unlockSql,
        lock.parameters,
      );
      if (unlockResult?.unlocked !== true) {
        throw new Error(lock.unlockMessage);
      }
    } catch (error) {
      cleanupError = error;
    }
  }
  if (connected) {
    try {
      await queryRunner.release();
    } catch (error) {
      cleanupError ??= error;
    }
  }

  if (hasPrimaryError) {
    attachCleanupError(primaryError, cleanupError);
    throw primaryError;
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
  return result as T;
}

export async function withHistoricRecomputeLock<T>(
  dataSource: DataSource,
  task: () => Promise<T>,
  options: { timeoutMs: number; retryMs: number },
): Promise<T> {
  return withSessionAdvisoryLock(dataSource, task, options, {
    tryLockSql:
      "SELECT pg_try_advisory_lock(hashtext('vigieau'), hashtext('zone-compute-historic')) AS locked",
    unlockSql:
      "SELECT pg_advisory_unlock(hashtext('vigieau'), hashtext('zone-compute-historic')) AS unlocked",
    timeoutMessage: 'Timed out waiting for the historic zone compute lock',
    unlockMessage: 'Unable to release the historic zone compute lock',
  });
}

function isPreviousDay(previousDate: string | null, date: string): boolean {
  return (
    previousDate !== null &&
    parseMoment(previousDate).add(1, 'day').format('YYYY-MM-DD') === date
  );
}

export async function runRecomputeCommuneStatistics(
  dependencies: RecomputeDependencies,
  options: RecomputeOptions,
): Promise<void> {
  assertNationalScopeIsConfirmed(options);
  if (!options.recomputeMonths) {
    throw new Error('Statistic recomputation requires RECOMPUTE_MONTHS=true');
  }
  if (!options.sortAtEnd) {
    throw new Error('Statistic recomputation requires SORT_AT_END=true');
  }
  const businessDate = getScheduledCivilDate(
    new Date(),
    NATIONAL_COMPUTE_START_HOUR,
  );
  if (options.publishThrough !== null) {
    if (isZonePublicationEnabled()) {
      throw new Error(
        'PUBLISH_THROUGH is only supported while ZONE_PUBLICATION_ENABLED=false',
      );
    }
    if (options.publishThrough > businessDate) {
      throw new Error(
        `PUBLISH_THROUGH cannot exceed the scheduled civil date ${businessDate}`,
      );
    }
  }
  await assertNoBootstrapBarrier(dependencies.dataSource);
  let departements = await dependencies.departementService.findAllLight();
  if (options.departementCodes.length > 0) {
    departements = departements.filter((departement) =>
      options.departementCodes.includes(departement.code),
    );
  }

  const foundCodes = departements.map((departement) => departement.code);
  const statisticScopeCodes =
    options.departementCodes.length > 0 ? foundCodes : undefined;
  const missingCodes = options.departementCodes.filter(
    (code) => !foundCodes.includes(code),
  );
  if (missingCodes.length > 0) {
    throw new Error(`Unknown departement codes: ${missingCodes.join(',')}`);
  }
  if (foundCodes.length === 0) {
    throw new Error('No departement to recompute');
  }

  const historicContext = await readHistoricContext(dependencies);
  const isNationalRecompute = statisticScopeCodes === undefined;
  const lastSelectedDate = options.dates.at(-1);
  console.log(
    `[recompute-commune-statistics] dates=${options.dates.length} departements=${foundCodes.join(',')} epoch=${historicContext.historicComputeEpoch} sourceRevision=${historicContext.sourceRevision}`,
  );

  let previousDate: string | null = null;
  for (const date of options.dates) {
    await assertHistoricContext(dependencies, historicContext);
    const dateMoment = parseMoment(date);
    const reusablePreviousDate = isPreviousDay(previousDate, date)
      ? previousDate
      : null;
    console.log(`[recompute-commune-statistics] ${date} zones begin`);
    await dependencies.historicService.computeZonesForDate(
      dateMoment,
      departements,
      {
        previousDate: reusablePreviousDate,
        historicComputeEpoch: historicContext.historicComputeEpoch,
        expectedSourceRevision: historicContext.sourceRevision,
      },
    );
    const zones =
      await dependencies.historicService.findZonesForStatistics(foundCodes);
    console.log(`[recompute-commune-statistics] ${date} zones=${zones.length}`);
    const publishCurrentDate =
      isNationalRecompute && options.publishThrough === date;

    await dependencies.statisticCommuneService.computeCommuneStatisticsRestrictions(
      zones,
      dateMoment.toDate(),
      true,
      false,
      statisticScopeCodes,
      {
        beforeCommuneStatistics: async () => {
          await dependencies.statisticDepartementService.computeDepartementStatisticsRestrictions(
            zones,
            dateMoment.toDate(),
            true,
            false,
            statisticScopeCodes,
          );
          await assertHistoricContext(dependencies, historicContext);
        },
        beforeCertification: async () => {
          await dependencies.statisticCommuneService.computeCommuneStatisticsRestrictionsByMonth(
            dateMoment.toDate(),
            statisticScopeCodes,
            true,
          );
          await assertHistoricContext(dependencies, historicContext);
          console.log(
            `[recompute-commune-statistics] ${date.slice(0, 7)} monthly done`,
          );

          if (date === lastSelectedDate) {
            await dependencies.statisticCommuneService.sortStatCommune(
              statisticScopeCodes,
            );
            await assertHistoricContext(dependencies, historicContext);
            await dependencies.statisticDepartementService.sortStatDepartement();
            await assertHistoricContext(dependencies, historicContext);
            console.log(
              '[recompute-commune-statistics] statistics sorted before certification',
            );
          }

          await dependencies.statisticService.computeDepartementsSituation(
            zones,
            date,
            statisticScopeCodes,
          );
          await assertHistoricContext(dependencies, historicContext);
        },
        sourceRevision: historicContext.sourceRevision,
        historicComputeEpoch: historicContext.historicComputeEpoch,
        preserveBootstrapBarrier: true,
        requireNationalCoverage: isNationalRecompute,
        publishCurrentDate,
      },
    );

    previousDate = date;
    console.log(`[recompute-commune-statistics] ${date} done`);
  }
}

export async function main(): Promise<void> {
  const options = parseOptions();
  applyOneOffSafetyFlags();

  const [
    { AppModule },
    { DepartementService },
    { StatisticCommuneService },
    { StatisticDepartementService },
    { StatisticService },
    { ZoneAlerteComputedHistoricService },
    { ConfigService },
    { ZonePublicationService },
  ] = await Promise.all([
    import('../app.module.js'),
    import('../departement/departement.service.js'),
    import('../statistic_commune/statistic_commune.service.js'),
    import('../statistic_departement/statistic_departement.service.js'),
    import('../statistic/statistic.service.js'),
    import('../zone_alerte_computed/zone_alerte_computed_historic.service.js'),
    import('../config/config.service.js'),
    import('../zone_publication/zone_publication.service.js'),
  ]);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const dataSource = app.get(DataSource);
    const dependencies: RecomputeDependencies = {
      departementService: app.get(DepartementService),
      historicService: app.get(ZoneAlerteComputedHistoricService),
      statisticCommuneService: app.get(StatisticCommuneService),
      statisticDepartementService: app.get(StatisticDepartementService),
      statisticService: app.get(StatisticService),
      configService: app.get(ConfigService),
      zonePublicationService: app.get(ZonePublicationService),
      dataSource,
    };

    await withHistoricRecomputeLock(
      dataSource,
      () => runRecomputeCommuneStatistics(dependencies, options),
      {
        timeoutMs: options.historicLockTimeoutMs,
        retryMs: options.historicLockRetryMs,
      },
    );
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[recompute-commune-statistics] failed');
    console.error(error);
    process.exitCode = 1;
  });
}
