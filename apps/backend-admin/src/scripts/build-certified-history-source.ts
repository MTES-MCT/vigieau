import 'dotenv/config';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Client, PoolClient, QueryResultRow } from 'pg';
import type QueryStreamType from 'pg-query-stream';

const QueryStream = createRequire(__filename)(
  'pg-query-stream',
) as typeof QueryStreamType;

const SEVERITIES = [
  'vigilance',
  'alerte',
  'alerte_renforcee',
  'crise',
] as const;
const GRAVITY_LEVELS = SEVERITIES;
const ZONE_TYPES = ['SOU', 'SUP', 'AEP'] as const;
const SITUATION_KEYS = ['max', 'sup', 'sou', 'aep'] as const;
const EXPECTED_DEPARTMENT_COUNT = 101;
const INSERT_BATCH_SIZE = 1_000;

export type Severity = (typeof SEVERITIES)[number];

export interface CertifiedBackupPart {
  backupId: string;
  from: string;
  through: string;
}

export const CERTIFIED_HISTORY_PLAN: readonly CertifiedBackupPart[] = [
  {
    backupId: '6a88e685998269f979598941',
    from: '2026-07-11',
    through: '2026-08-21',
  },
  {
    backupId: '6a8b899f998269f97959c856',
    from: '2026-08-22',
    through: '2026-08-23',
  },
  {
    backupId: '6a8e2c8599c3cdda4dc62681',
    from: '2026-08-24',
    through: '2026-08-25',
  },
  {
    backupId: '6a8f7e0799c3cde8852db7c1',
    from: '2026-08-26',
    through: '2026-08-26',
  },
  {
    backupId: '6a90cf8599c3cd5eb9c7d9e5',
    from: '2026-08-27',
    through: '2026-08-27',
  },
] as const;

export const CERTIFIED_HISTORY_SOURCE_RUN_ID =
  'vigieau-2026-07-11-2026-08-27-backup-repair-v1';

export const CERTIFIED_HISTORY_V2_VARIANT =
  'isolated-clone-certified-correction-v2';
export const CERTIFIED_HISTORY_V2_SOURCE_RUN_ID =
  'vigieau-2026-07-11-2026-08-31-isolated-recompute-v2';
export const CERTIFIED_HISTORY_V2_CODE_COMMIT =
  '7bd55680297c2f85b4baa08792eab9eefc0578a0';
export const CERTIFIED_HISTORY_V2_PARENT_SOURCE_FINGERPRINT =
  'e73b1ca10cb9af03e234b7340edd46dc66b5fe2172a43aba486ad394a0419d3f';
export const CERTIFIED_HISTORY_V2_PARENT_PROVENANCE_DIGEST =
  '3568717e031455834eb3e2a55cc5e3fd00b8b2bda00999436ddf282cc2c31447';
export const CERTIFIED_HISTORY_V2_FINAL_BACKUP_SHA256 =
  '0f9517ae3893103e8fcb4fa0198ca202fd286dba577d261e6244dc400a9e868d';
export const CERTIFIED_HISTORY_V2_PLAN: readonly CertifiedBackupPart[] = [
  ...CERTIFIED_HISTORY_PLAN,
  {
    backupId: '6a97672299826944b38141dd',
    from: '2026-08-28',
    through: '2026-08-31',
  },
] as const;

export type CertifiedHistorySourceVariant =
  | 'backup-repair-v1'
  | typeof CERTIFIED_HISTORY_V2_VARIANT;

interface CertifiedHistoryPlanDefinition {
  variant: CertifiedHistorySourceVariant;
  sourceRunId: string;
  plan: readonly CertifiedBackupPart[];
  from: string;
  through: string;
}

const V1_PLAN_DEFINITION: CertifiedHistoryPlanDefinition = {
  variant: 'backup-repair-v1',
  sourceRunId: CERTIFIED_HISTORY_SOURCE_RUN_ID,
  plan: CERTIFIED_HISTORY_PLAN,
  from: CERTIFIED_HISTORY_PLAN[0].from,
  through: CERTIFIED_HISTORY_PLAN.at(-1)!.through,
};

const V2_PLAN_DEFINITION: CertifiedHistoryPlanDefinition = {
  variant: CERTIFIED_HISTORY_V2_VARIANT,
  sourceRunId: CERTIFIED_HISTORY_V2_SOURCE_RUN_ID,
  plan: CERTIFIED_HISTORY_V2_PLAN,
  from: '2026-07-11',
  through: '2026-08-31',
};

export interface BuildCertifiedHistorySourceOptions {
  sourceDatabaseUrl: string;
  accumulatorDatabaseUrl: string;
  from: string;
  through: string;
  backupId: string;
  dumpSha256: string;
  variant?: CertifiedHistorySourceVariant;
}

export interface CommuneDay {
  code: string;
  date: string;
  SOU: Severity | null;
  SUP: Severity | null;
  AEP: Severity | null;
}

export interface DepartmentDay {
  code: string;
  date: string;
  restriction: Record<string, unknown>;
}

export interface StatisticDay {
  date: string;
  payload: Record<string, unknown>;
}

interface Scope {
  codes: string[];
  digest: string;
}

interface PartMetrics {
  communeCount: number;
  communeDayCount: number;
  communeDigest: string;
  communeHistoryDigest: string;
  departmentCount: number;
  departmentDayCount: number;
  departmentDigest: string;
  departmentHistoryDigest: string;
  statisticDayCount: number;
  statisticDigest: string;
}

export interface BuildCertifiedHistorySourceSummary extends PartMetrics {
  sourceRunId: string;
  status: 'building' | 'certified';
  backupId: string;
  from: string;
  through: string;
  dumpSha256: string;
  completedPartCount: number;
  expectedPartCount: number;
}

type DatabaseClient = Pick<PoolClient, 'query'>;

function assertCertifiedPart(
  options: BuildCertifiedHistorySourceOptions,
  definition: CertifiedHistoryPlanDefinition,
): void {
  assertCivilDate('CERTIFIED_HISTORY_FROM', options.from);
  assertCivilDate('CERTIFIED_HISTORY_THROUGH', options.through);
  const expected = definition.plan.find(
    (part) => part.backupId === options.backupId,
  );
  if (!expected)
    throw new Error(`Unknown certified backup ${options.backupId}`);
  if (options.from !== expected.from || options.through !== expected.through) {
    throw new Error(
      `Certified backup ${options.backupId} must cover ${expected.from}/${expected.through}`,
    );
  }
  if (!/^[a-f0-9]{64}$/.test(options.dumpSha256)) {
    throw new Error('CERTIFIED_HISTORY_DUMP_SHA256 must be a lowercase SHA256');
  }
  if (
    definition.variant === CERTIFIED_HISTORY_V2_VARIANT &&
    (options.backupId !== CERTIFIED_HISTORY_V2_PLAN.at(-1)!.backupId ||
      options.from !== CERTIFIED_HISTORY_V2_PLAN.at(-1)!.from ||
      options.through !== CERTIFIED_HISTORY_V2_PLAN.at(-1)!.through)
  ) {
    throw new Error(
      'Certified v2 is built only from the audited final clone and inherited v1 parts',
    );
  }
  if (
    definition.variant === CERTIFIED_HISTORY_V2_VARIANT &&
    options.dumpSha256 !== CERTIFIED_HISTORY_V2_FINAL_BACKUP_SHA256
  ) {
    throw new Error('The final v2 backup SHA256 is not the audited artifact');
  }
}

function planDefinition(
  variant: BuildCertifiedHistorySourceOptions['variant'],
): CertifiedHistoryPlanDefinition {
  if (variant === undefined || variant === 'backup-repair-v1') {
    return V1_PLAN_DEFINITION;
  }
  if (variant === CERTIFIED_HISTORY_V2_VARIANT) {
    return V2_PLAN_DEFINITION;
  }
  throw new Error('Unknown certified history source variant');
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function assertCivilDate(name: string, value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${name} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${name} is not a valid civil date`);
  }
  return value;
}

function databaseIdentity(databaseUrl: string, name: string): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error(`${name} must be a PostgreSQL URL`);
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error(`${name} must be a PostgreSQL URL`);
  }
  for (const override of ['host', 'port']) {
    if (url.searchParams.has(override)) {
      throw new Error(
        `${name} must not override ${override} in query parameters`,
      );
    }
  }
  const hostname = url.hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) {
    throw new Error(`${name} must point to a loopback-only local database`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) throw new Error(`${name} must name a database`);
  return `loopback:${url.port || '5432'}/${database}`;
}

export function parseBuildCertifiedHistorySourceOptions(
  environment: NodeJS.ProcessEnv = process.env,
): BuildCertifiedHistorySourceOptions {
  const configuredVariant =
    environment.CERTIFIED_HISTORY_SOURCE_VARIANT?.trim();
  if (configuredVariant && configuredVariant !== CERTIFIED_HISTORY_V2_VARIANT) {
    throw new Error(
      `CERTIFIED_HISTORY_SOURCE_VARIANT must equal ${CERTIFIED_HISTORY_V2_VARIANT}`,
    );
  }
  const variant: BuildCertifiedHistorySourceOptions['variant'] =
    configuredVariant ? CERTIFIED_HISTORY_V2_VARIANT : undefined;
  const definition = planDefinition(variant);
  const sourceDatabaseUrl = requiredEnvironment(
    environment,
    'CERTIFIED_HISTORY_BACKUP_DATABASE_URL',
  );
  const accumulatorDatabaseUrl = requiredEnvironment(
    environment,
    'CERTIFIED_HISTORY_ACCUMULATOR_DATABASE_URL',
  );
  if (
    databaseIdentity(
      sourceDatabaseUrl,
      'CERTIFIED_HISTORY_BACKUP_DATABASE_URL',
    ) ===
    databaseIdentity(
      accumulatorDatabaseUrl,
      'CERTIFIED_HISTORY_ACCUMULATOR_DATABASE_URL',
    )
  ) {
    throw new Error('Backup and accumulator databases must differ');
  }
  const from = assertCivilDate(
    'CERTIFIED_HISTORY_FROM',
    requiredEnvironment(environment, 'CERTIFIED_HISTORY_FROM'),
  );
  const through = assertCivilDate(
    'CERTIFIED_HISTORY_THROUGH',
    requiredEnvironment(environment, 'CERTIFIED_HISTORY_THROUGH'),
  );
  const backupId = requiredEnvironment(
    environment,
    'CERTIFIED_HISTORY_BACKUP_ID',
  );
  const dumpSha256 = requiredEnvironment(
    environment,
    'CERTIFIED_HISTORY_DUMP_SHA256',
  );
  const options: BuildCertifiedHistorySourceOptions = {
    sourceDatabaseUrl,
    accumulatorDatabaseUrl,
    from,
    through,
    backupId,
    dumpSha256,
    ...(variant ? { variant } : {}),
  };
  assertCertifiedPart(options, definition);
  return options;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function severity(value: unknown, label: string): Severity | null {
  if (value === null) return null;
  if (typeof value === 'string' && SEVERITIES.includes(value as Severity)) {
    return value as Severity;
  }
  throw new Error(`${label} has an invalid severity`);
}

export function validateCommuneDay(
  codeValue: unknown,
  payload: unknown,
  from: string,
  through: string,
): CommuneDay {
  const code = typeof codeValue === 'string' ? codeValue : '';
  if (!/^[0-9A-Z]{5}$/.test(code)) {
    throw new Error(`Invalid commune code ${code}`);
  }
  if (!isObject(payload)) {
    throw new Error(`Commune ${code} restriction must be a JSON object`);
  }
  const date = assertCivilDate(
    `Commune ${code} restriction date`,
    String(payload.date ?? ''),
  );
  if (date < from || date > through) {
    throw new Error(`Commune ${code}/${date} is outside the certified part`);
  }
  for (const type of ZONE_TYPES) {
    if (!Object.prototype.hasOwnProperty.call(payload, type)) {
      throw new Error(`Commune ${code}/${date} is missing ${type}`);
    }
  }
  const actualKeys = Object.keys(payload).sort();
  const expectedKeys = ['AEP', 'SOU', 'SUP', 'date'];
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(
      `Commune ${code}/${date} must contain exactly date,SOU,SUP,AEP`,
    );
  }
  return {
    code,
    date,
    SOU: severity(payload.SOU, `Commune ${code}/${date}/SOU`),
    SUP: severity(payload.SUP, `Commune ${code}/${date}/SUP`),
    AEP: severity(payload.AEP, `Commune ${code}/${date}/AEP`),
  };
}

function area(value: unknown, label: string): void {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`${label} must be a non-negative area`);
  }
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(`${label} must be a non-negative area`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative area`);
  }
}

export function validateDepartmentDay(
  codeValue: unknown,
  payload: unknown,
  from: string,
  through: string,
): DepartmentDay {
  const code = typeof codeValue === 'string' ? codeValue : '';
  if (!/^[0-9A-Z]{2,3}$/.test(code)) {
    throw new Error(`Invalid department code ${code}`);
  }
  if (!isObject(payload)) {
    throw new Error(`Department ${code} restriction must be a JSON object`);
  }
  const date = assertCivilDate(
    `Department ${code} restriction date`,
    String(payload.date ?? ''),
  );
  if (date < from || date > through) {
    throw new Error(`Department ${code}/${date} is outside the certified part`);
  }
  for (const type of ZONE_TYPES) {
    const values = payload[type];
    if (!isObject(values)) {
      throw new Error(`Department ${code}/${date}/${type} must be an object`);
    }
    for (const level of GRAVITY_LEVELS) {
      if (!Object.prototype.hasOwnProperty.call(values, level)) {
        throw new Error(
          `Department ${code}/${date}/${type} is missing ${level}`,
        );
      }
      area(values[level], `Department ${code}/${date}/${type}/${level}`);
    }
  }
  return { code, date, restriction: payload };
}

export function validateStatisticDay(
  dateValue: unknown,
  payload: unknown,
  departmentCodes: readonly string[],
  from: string,
  through: string,
): StatisticDay {
  const date = assertCivilDate(
    'National statistic date',
    String(dateValue ?? ''),
  );
  if (date < from || date > through) {
    throw new Error(`National statistic ${date} is outside the certified part`);
  }
  if (!isObject(payload)) {
    throw new Error(`National statistic ${date} must be a JSON object`);
  }
  if (String(payload.date ?? '') !== date) {
    throw new Error(`National statistic ${date} has a divergent payload date`);
  }
  const situations = payload.departementSituation;
  if (!isObject(situations)) {
    throw new Error(`National statistic ${date} has no department situations`);
  }
  const actualCodes = Object.keys(situations).sort();
  const expectedCodes = [...departmentCodes].sort();
  if (
    actualCodes.length !== expectedCodes.length ||
    actualCodes.some((code, index) => code !== expectedCodes[index])
  ) {
    throw new Error(
      `National statistic ${date} department coverage mismatch: ${actualCodes.length}/${expectedCodes.length}`,
    );
  }
  for (const code of expectedCodes) {
    const situation = situations[code];
    if (!isObject(situation)) {
      throw new Error(`National statistic ${date}/${code} must be an object`);
    }
    for (const key of SITUATION_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(situation, key)) {
        throw new Error(`National statistic ${date}/${code} is missing ${key}`);
      }
      severity(situation[key], `National statistic ${date}/${code}/${key}`);
    }
  }
  return { date, payload };
}

function dateCount(from: string, through: string): number {
  return (
    Math.floor(
      (Date.parse(`${through}T00:00:00.000Z`) -
        Date.parse(`${from}T00:00:00.000Z`)) /
        86_400_000,
    ) + 1
  );
}

function expectedDates(from: string, through: string): string[] {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  return Array.from({ length: dateCount(from, through) }, (_, offset) =>
    new Date(start + offset * 86_400_000).toISOString().slice(0, 10),
  );
}

function databaseCount(value: unknown, name: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}`);
  }
  return parsed;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function codeDigest(codes: readonly string[]): string {
  return sha256([...codes].sort().join('\n'));
}

class DailyCoverage {
  private readonly expected: string[];
  private dateIndex = 0;
  private currentDate: string | null = null;
  private currentCodes: string[] = [];
  private currentCodeSet = new Set<string>();
  rowCount = 0;

  constructor(
    from: string,
    through: string,
    private readonly scope: Scope,
    private readonly label: string,
  ) {
    this.expected = expectedDates(from, through);
  }

  accept(date: string, code: string): void {
    if (this.currentDate !== date) {
      this.finishDate();
      const expectedDate = this.expected[this.dateIndex];
      if (date !== expectedDate) {
        throw new Error(
          `${this.label} date coverage mismatch: expected ${expectedDate ?? 'none'}, got ${date}`,
        );
      }
      this.currentDate = date;
      this.currentCodes = [];
      this.currentCodeSet.clear();
    }
    if (this.currentCodeSet.has(code)) {
      throw new Error(`${this.label} duplicate row ${code}/${date}`);
    }
    this.currentCodeSet.add(code);
    this.currentCodes.push(code);
    this.rowCount += 1;
  }

  finish(): void {
    this.finishDate();
    if (this.dateIndex !== this.expected.length) {
      throw new Error(
        `${this.label} date coverage mismatch: ${this.dateIndex}/${this.expected.length}`,
      );
    }
  }

  private finishDate(): void {
    if (this.currentDate === null) return;
    const digest = codeDigest(this.currentCodes);
    if (
      this.currentCodes.length !== this.scope.codes.length ||
      digest !== this.scope.digest
    ) {
      throw new Error(
        `${this.label} ${this.currentDate} coverage mismatch: ${this.currentCodes.length}/${this.scope.codes.length}`,
      );
    }
    this.dateIndex += 1;
    this.currentDate = null;
  }
}

const ACCUMULATOR_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS "certified_history_source_run" (
    "id" text PRIMARY KEY,
    "status" text NOT NULL,
    "dateFrom" date NOT NULL,
    "dateThrough" date NOT NULL,
    "communeCount" integer NOT NULL DEFAULT 0,
    "communeDayCount" bigint NOT NULL DEFAULT 0,
    "communeDigest" character varying(64),
    "communeHistoryDigest" character varying(64),
    "departmentCount" integer NOT NULL DEFAULT 0,
    "departmentDayCount" bigint NOT NULL DEFAULT 0,
    "departmentDigest" character varying(64),
    "departmentHistoryDigest" character varying(64),
    "statisticDayCount" integer NOT NULL DEFAULT 0,
    "statisticDigest" character varying(64),
    "provenance" jsonb NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "CHK_certified_history_source_run_status"
      CHECK ("status" IN ('building', 'certified')),
    CONSTRAINT "CHK_certified_history_source_run_range"
      CHECK ("dateFrom" <= "dateThrough"),
    CONSTRAINT "CHK_certified_history_source_run_certified"
      CHECK (
        "status" <> 'certified' OR (
          "communeCount" > 0 AND "communeDayCount" > 0
          AND "communeDigest" ~ '^[a-f0-9]{64}$'
          AND "communeHistoryDigest" ~ '^[a-f0-9]{64}$'
          AND "departmentCount" = 101 AND "departmentDayCount" > 0
          AND "departmentDigest" ~ '^[a-f0-9]{64}$'
          AND "departmentHistoryDigest" ~ '^[a-f0-9]{64}$'
          AND "statisticDayCount" > 0
          AND "statisticDigest" ~ '^[a-f0-9]{64}$'
          AND jsonb_typeof("provenance") = 'object'
          AND "provenance" <> '{}'::jsonb
        )
      )
  );

  CREATE TABLE IF NOT EXISTS "certified_history_source_part" (
    "sourceRunId" text NOT NULL REFERENCES "certified_history_source_run"("id") ON DELETE RESTRICT,
    "backupId" text NOT NULL,
    "dateFrom" date NOT NULL,
    "dateThrough" date NOT NULL,
    "dumpSha256" character varying(64) NOT NULL,
    "communeCount" integer NOT NULL,
    "communeDayCount" bigint NOT NULL,
    "communeDigest" character varying(64) NOT NULL,
    "communeHistoryDigest" character varying(64) NOT NULL,
    "departmentCount" integer NOT NULL,
    "departmentDayCount" bigint NOT NULL,
    "departmentDigest" character varying(64) NOT NULL,
    "departmentHistoryDigest" character varying(64) NOT NULL,
    "statisticDayCount" integer NOT NULL,
    "statisticDigest" character varying(64) NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("sourceRunId", "backupId"),
    UNIQUE ("sourceRunId", "dateFrom", "dateThrough"),
    CONSTRAINT "CHK_certified_history_source_part_dump"
      CHECK ("dumpSha256" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "CHK_certified_history_source_part_digests"
      CHECK (
        "communeDigest" ~ '^[a-f0-9]{64}$'
        AND "communeHistoryDigest" ~ '^[a-f0-9]{64}$'
        AND "departmentDigest" ~ '^[a-f0-9]{64}$'
        AND "departmentHistoryDigest" ~ '^[a-f0-9]{64}$'
        AND "statisticDigest" ~ '^[a-f0-9]{64}$'
      )
  );

  CREATE TABLE IF NOT EXISTS "certified_history_commune_day" (
    "sourceRunId" text NOT NULL REFERENCES "certified_history_source_run"("id") ON DELETE RESTRICT,
    "code" text NOT NULL,
    "date" date NOT NULL,
    "SOU" text,
    "SUP" text,
    "AEP" text,
    "backupId" text NOT NULL,
    "dumpSha256" character varying(64) NOT NULL,
    PRIMARY KEY ("sourceRunId", "code", "date"),
    CONSTRAINT "CHK_certified_history_commune_day_code" CHECK ("code" ~ '^[0-9A-Z]{5}$'),
    CONSTRAINT "CHK_certified_history_commune_day_sou" CHECK ("SOU" IS NULL OR "SOU" IN ('vigilance','alerte','alerte_renforcee','crise')),
    CONSTRAINT "CHK_certified_history_commune_day_sup" CHECK ("SUP" IS NULL OR "SUP" IN ('vigilance','alerte','alerte_renforcee','crise')),
    CONSTRAINT "CHK_certified_history_commune_day_aep" CHECK ("AEP" IS NULL OR "AEP" IN ('vigilance','alerte','alerte_renforcee','crise'))
  );
  DROP INDEX IF EXISTS "IDX_certified_history_commune_day_run_code_date";
  CREATE INDEX IF NOT EXISTS "IDX_certified_history_commune_day_run_date_code"
    ON "certified_history_commune_day" ("sourceRunId", "date", "code");

  CREATE TABLE IF NOT EXISTS "certified_history_departement_day" (
    "sourceRunId" text NOT NULL REFERENCES "certified_history_source_run"("id") ON DELETE RESTRICT,
    "code" text NOT NULL,
    "date" date NOT NULL,
    "restriction" jsonb NOT NULL,
    "backupId" text NOT NULL,
    "dumpSha256" character varying(64) NOT NULL,
    PRIMARY KEY ("sourceRunId", "code", "date")
  );
  DROP INDEX IF EXISTS "IDX_certified_history_departement_day_run_code_date";
  CREATE INDEX IF NOT EXISTS "IDX_certified_history_departement_day_run_date_code"
    ON "certified_history_departement_day" ("sourceRunId", "date", "code");

  CREATE TABLE IF NOT EXISTS "certified_history_statistic_day" (
    "sourceRunId" text NOT NULL REFERENCES "certified_history_source_run"("id") ON DELETE RESTRICT,
    "date" date NOT NULL,
    "payload" jsonb NOT NULL,
    "backupId" text NOT NULL,
    "dumpSha256" character varying(64) NOT NULL,
    PRIMARY KEY ("sourceRunId", "date")
  );
`;

const COMMUNE_STREAM_SQL = `
  SELECT commune.code, item.value AS payload
  FROM commune
  JOIN statistic_commune statistic ON statistic."communeId" = commune.id
  CROSS JOIN LATERAL jsonb_array_elements(statistic.restrictions)
    WITH ORDINALITY AS item(value, ordinality)
  WHERE item.value ->> 'date' >= $1::date::text
    AND item.value ->> 'date' <= $2::date::text
  ORDER BY item.value ->> 'date', commune.code, item.ordinality
`;

const DEPARTMENT_STREAM_SQL = `
  SELECT departement.code, item.value AS payload
  FROM departement
  JOIN statistic_departement statistic
    ON statistic."departementId" = departement.id
  CROSS JOIN LATERAL jsonb_array_elements(statistic.restrictions)
    WITH ORDINALITY AS item(value, ordinality)
  WHERE item.value ->> 'date' >= $1::date::text
    AND item.value ->> 'date' <= $2::date::text
  ORDER BY item.value ->> 'date', departement.code, item.ordinality
`;

async function loadScope(
  source: DatabaseClient,
  table: 'commune' | 'departement',
): Promise<Scope> {
  const statisticTable =
    table === 'commune' ? 'statistic_commune' : 'statistic_departement';
  const foreignKey = table === 'commune' ? 'communeId' : 'departementId';
  const codePattern = table === 'commune' ? /^[0-9A-Z]{5}$/ : /^[0-9A-Z]{2,3}$/;
  const result = await source.query(
    `
      SELECT entity.code, statistic.id AS "statisticId",
             jsonb_typeof(statistic.restrictions) AS "restrictionType"
      FROM ${table} entity
      LEFT JOIN ${statisticTable} statistic
        ON statistic."${foreignKey}" = entity.id
      ORDER BY entity.code
    `,
  );
  const codes: string[] = [];
  const codeSet = new Set<string>();
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const code = typeof row.code === 'string' ? row.code : '';
    if (!codePattern.test(code) || codeSet.has(code)) {
      throw new Error(`Invalid or duplicate ${table} code ${code}`);
    }
    if (row.statisticId === null || row.restrictionType !== 'array') {
      throw new Error(
        `${table} ${code} has no valid statistic restriction array`,
      );
    }
    codes.push(code);
    codeSet.add(code);
  }
  if (codes.length === 0) throw new Error(`Backup has no ${table} rows`);
  if (table === 'departement' && codes.length !== EXPECTED_DEPARTMENT_COUNT) {
    throw new Error(
      `Backup department coverage mismatch: ${codes.length}/${EXPECTED_DEPARTMENT_COUNT}`,
    );
  }
  codes.sort();
  return { codes, digest: codeDigest(codes) };
}

async function executeExactUpsert(
  accumulator: DatabaseClient,
  sql: string,
  rows: unknown[],
  label: string,
): Promise<void> {
  if (rows.length === 0) return;
  const result = await accumulator.query(sql, [JSON.stringify(rows)]);
  const input = databaseCount(
    result.rows[0]?.inputCount,
    `${label} input count`,
  );
  const accepted = databaseCount(
    result.rows[0]?.acceptedCount,
    `${label} accepted count`,
  );
  if (input !== rows.length || accepted !== rows.length) {
    throw new Error(
      `${label} overlaps divergent accumulator data: ${accepted}/${rows.length}`,
    );
  }
}

const UPSERT_COMMUNES_SQL = `
  WITH input AS MATERIALIZED (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
      code text, date date, "SOU" text, "SUP" text, "AEP" text,
      "sourceRunId" text, "backupId" text, "dumpSha256" text
    )
  ), existing_exact AS MATERIALIZED (
    SELECT 1
    FROM input
    JOIN "certified_history_commune_day" target
      ON target."sourceRunId" = input."sourceRunId"
     AND target.code = input.code
     AND target.date = input.date
    WHERE target."SOU" IS NOT DISTINCT FROM input."SOU"
      AND target."SUP" IS NOT DISTINCT FROM input."SUP"
      AND target."AEP" IS NOT DISTINCT FROM input."AEP"
      AND target."backupId" = input."backupId"
      AND target."dumpSha256" = input."dumpSha256"
  ), inserted AS (
    INSERT INTO "certified_history_commune_day" AS target (
      "sourceRunId", code, date, "SOU", "SUP", "AEP", "backupId", "dumpSha256"
    )
    SELECT "sourceRunId", code, date, "SOU", "SUP", "AEP", "backupId", "dumpSha256"
    FROM input
    ON CONFLICT ("sourceRunId", code, date) DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT COUNT(*) FROM input)::integer AS "inputCount",
         ((SELECT COUNT(*) FROM existing_exact)
          + (SELECT COUNT(*) FROM inserted))::integer AS "acceptedCount"
`;

const UPSERT_DEPARTMENTS_SQL = `
  WITH input AS MATERIALIZED (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
      code text, date date, restriction jsonb,
      "sourceRunId" text, "backupId" text, "dumpSha256" text
    )
  ), existing_exact AS MATERIALIZED (
    SELECT 1
    FROM input
    JOIN "certified_history_departement_day" target
      ON target."sourceRunId" = input."sourceRunId"
     AND target.code = input.code
     AND target.date = input.date
    WHERE target.restriction = input.restriction
      AND target."backupId" = input."backupId"
      AND target."dumpSha256" = input."dumpSha256"
  ), inserted AS (
    INSERT INTO "certified_history_departement_day" AS target (
      "sourceRunId", code, date, restriction, "backupId", "dumpSha256"
    )
    SELECT "sourceRunId", code, date, restriction, "backupId", "dumpSha256"
    FROM input
    ON CONFLICT ("sourceRunId", code, date) DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT COUNT(*) FROM input)::integer AS "inputCount",
         ((SELECT COUNT(*) FROM existing_exact)
          + (SELECT COUNT(*) FROM inserted))::integer AS "acceptedCount"
`;

const UPSERT_STATISTICS_SQL = `
  WITH input AS MATERIALIZED (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
      date date, payload jsonb, "sourceRunId" text,
      "backupId" text, "dumpSha256" text
    )
  ), existing_exact AS MATERIALIZED (
    SELECT 1
    FROM input
    JOIN "certified_history_statistic_day" target
      ON target."sourceRunId" = input."sourceRunId"
     AND target.date = input.date
    WHERE target.payload = input.payload
      AND target."backupId" = input."backupId"
      AND target."dumpSha256" = input."dumpSha256"
  ), inserted AS (
    INSERT INTO "certified_history_statistic_day" AS target (
      "sourceRunId", date, payload, "backupId", "dumpSha256"
    )
    SELECT "sourceRunId", date, payload, "backupId", "dumpSha256"
    FROM input
    ON CONFLICT ("sourceRunId", date) DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT COUNT(*) FROM input)::integer AS "inputCount",
         ((SELECT COUNT(*) FROM existing_exact)
          + (SELECT COUNT(*) FROM inserted))::integer AS "acceptedCount"
`;

async function streamRows<T extends QueryResultRow>(
  source: Client,
  sql: string,
  parameters: unknown[],
): Promise<AsyncIterable<T>> {
  return source.query(
    new QueryStream(sql, parameters, { batchSize: INSERT_BATCH_SIZE }),
  ) as unknown as AsyncIterable<T>;
}

async function extractCommunes(
  source: Client,
  accumulator: DatabaseClient,
  scope: Scope,
  options: BuildCertifiedHistorySourceOptions,
  definition: CertifiedHistoryPlanDefinition,
): Promise<number> {
  const coverage = new DailyCoverage(
    options.from,
    options.through,
    scope,
    'Commune',
  );
  const batch: unknown[] = [];
  const rows = await streamRows<{ code: string; payload: unknown }>(
    source,
    COMMUNE_STREAM_SQL,
    [options.from, options.through],
  );
  for await (const row of rows) {
    const day = validateCommuneDay(
      row.code,
      row.payload,
      options.from,
      options.through,
    );
    coverage.accept(day.date, day.code);
    batch.push({
      ...day,
      sourceRunId: definition.sourceRunId,
      backupId: options.backupId,
      dumpSha256: options.dumpSha256,
    });
    if (batch.length >= INSERT_BATCH_SIZE) {
      await executeExactUpsert(
        accumulator,
        UPSERT_COMMUNES_SQL,
        batch,
        'Commune day',
      );
      batch.length = 0;
    }
  }
  await executeExactUpsert(
    accumulator,
    UPSERT_COMMUNES_SQL,
    batch,
    'Commune day',
  );
  coverage.finish();
  return coverage.rowCount;
}

async function extractDepartments(
  source: Client,
  accumulator: DatabaseClient,
  scope: Scope,
  options: BuildCertifiedHistorySourceOptions,
  definition: CertifiedHistoryPlanDefinition,
): Promise<number> {
  const coverage = new DailyCoverage(
    options.from,
    options.through,
    scope,
    'Department',
  );
  const batch: unknown[] = [];
  const rows = await streamRows<{ code: string; payload: unknown }>(
    source,
    DEPARTMENT_STREAM_SQL,
    [options.from, options.through],
  );
  for await (const row of rows) {
    const day = validateDepartmentDay(
      row.code,
      row.payload,
      options.from,
      options.through,
    );
    coverage.accept(day.date, day.code);
    batch.push({
      code: day.code,
      date: day.date,
      restriction: day.restriction,
      sourceRunId: definition.sourceRunId,
      backupId: options.backupId,
      dumpSha256: options.dumpSha256,
    });
    if (batch.length >= INSERT_BATCH_SIZE) {
      await executeExactUpsert(
        accumulator,
        UPSERT_DEPARTMENTS_SQL,
        batch,
        'Department day',
      );
      batch.length = 0;
    }
  }
  await executeExactUpsert(
    accumulator,
    UPSERT_DEPARTMENTS_SQL,
    batch,
    'Department day',
  );
  coverage.finish();
  return coverage.rowCount;
}

async function extractStatistics(
  source: DatabaseClient,
  accumulator: DatabaseClient,
  departmentScope: Scope,
  options: BuildCertifiedHistorySourceOptions,
  definition: CertifiedHistoryPlanDefinition,
): Promise<number> {
  const result = await source.query(
    `
      SELECT date::text AS date, to_jsonb(statistic) AS payload
      FROM statistic
      WHERE date BETWEEN $1::date AND $2::date
      ORDER BY date
    `,
    [options.from, options.through],
  );
  const dates = expectedDates(options.from, options.through);
  if (result.rows.length !== dates.length) {
    throw new Error(
      `National statistic date coverage mismatch: ${result.rows.length}/${dates.length}`,
    );
  }
  const rows = result.rows.map((row, index) => {
    const day = validateStatisticDay(
      row.date,
      row.payload,
      departmentScope.codes,
      options.from,
      options.through,
    );
    if (day.date !== dates[index]) {
      throw new Error(
        `National statistic date coverage mismatch at ${dates[index]}`,
      );
    }
    return {
      ...day,
      sourceRunId: definition.sourceRunId,
      backupId: options.backupId,
      dumpSha256: options.dumpSha256,
    };
  });
  await executeExactUpsert(
    accumulator,
    UPSERT_STATISTICS_SQL,
    rows,
    'National statistic day',
  );
  return rows.length;
}

const RANGE_METRICS_SQL = `
  WITH commune_codes AS MATERIALIZED (
    SELECT DISTINCT code
    FROM "certified_history_commune_day"
    WHERE "sourceRunId" = $1 AND date BETWEEN $2::date AND $3::date
  ), commune_histories AS MATERIALIZED (
    SELECT code, encode(sha256(convert_to(string_agg(
      jsonb_build_array(date::text, "SOU", "SUP", "AEP")::text,
      E'\\n' ORDER BY date
    ), 'UTF8')), 'hex') AS digest
    FROM "certified_history_commune_day"
    WHERE "sourceRunId" = $1 AND date BETWEEN $2::date AND $3::date
    GROUP BY code
  ), department_codes AS MATERIALIZED (
    SELECT DISTINCT code
    FROM "certified_history_departement_day"
    WHERE "sourceRunId" = $1 AND date BETWEEN $2::date AND $3::date
  ), department_histories AS MATERIALIZED (
    SELECT code, encode(sha256(convert_to(string_agg(
      jsonb_build_array(date::text, restriction)::text,
      E'\\n' ORDER BY date
    ), 'UTF8')), 'hex') AS digest
    FROM "certified_history_departement_day"
    WHERE "sourceRunId" = $1 AND date BETWEEN $2::date AND $3::date
    GROUP BY code
  )
  SELECT
    (SELECT COUNT(*) FROM commune_codes)::integer AS "communeCount",
    (SELECT COUNT(*) FROM "certified_history_commune_day"
      WHERE "sourceRunId" = $1 AND date BETWEEN $2::date AND $3::date)::bigint AS "communeDayCount",
    (SELECT encode(sha256(convert_to(string_agg(code, E'\\n' ORDER BY code), 'UTF8')), 'hex')
      FROM commune_codes) AS "communeDigest",
    (SELECT encode(sha256(convert_to(string_agg(
      jsonb_build_array(code, digest)::text, E'\\n' ORDER BY code
    ), 'UTF8')), 'hex') FROM commune_histories) AS "communeHistoryDigest",
    (SELECT COUNT(*) FROM department_codes)::integer AS "departmentCount",
    (SELECT COUNT(*) FROM "certified_history_departement_day"
      WHERE "sourceRunId" = $1 AND date BETWEEN $2::date AND $3::date)::bigint AS "departmentDayCount",
    (SELECT encode(sha256(convert_to(string_agg(code, E'\\n' ORDER BY code), 'UTF8')), 'hex')
      FROM department_codes) AS "departmentDigest",
    (SELECT encode(sha256(convert_to(string_agg(
      jsonb_build_array(code, digest)::text, E'\\n' ORDER BY code
    ), 'UTF8')), 'hex') FROM department_histories) AS "departmentHistoryDigest",
    (SELECT COUNT(*) FROM "certified_history_statistic_day"
      WHERE "sourceRunId" = $1 AND date BETWEEN $2::date AND $3::date)::integer AS "statisticDayCount",
    (SELECT encode(sha256(convert_to(string_agg(
      jsonb_build_array(date::text, payload)::text, E'\\n' ORDER BY date
    ), 'UTF8')), 'hex') FROM "certified_history_statistic_day"
      WHERE "sourceRunId" = $1 AND date BETWEEN $2::date AND $3::date) AS "statisticDigest"
`;

function assertDigest(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function metricsFromRow(row: Record<string, unknown>): PartMetrics {
  return {
    communeCount: databaseCount(row.communeCount, 'commune count'),
    communeDayCount: databaseCount(row.communeDayCount, 'commune day count'),
    communeDigest: assertDigest(row.communeDigest, 'commune digest'),
    communeHistoryDigest: assertDigest(
      row.communeHistoryDigest,
      'commune history digest',
    ),
    departmentCount: databaseCount(row.departmentCount, 'department count'),
    departmentDayCount: databaseCount(
      row.departmentDayCount,
      'department day count',
    ),
    departmentDigest: assertDigest(row.departmentDigest, 'department digest'),
    departmentHistoryDigest: assertDigest(
      row.departmentHistoryDigest,
      'department history digest',
    ),
    statisticDayCount: databaseCount(
      row.statisticDayCount,
      'statistic day count',
    ),
    statisticDigest: assertDigest(row.statisticDigest, 'statistic digest'),
  };
}

export interface CertifiedSourceFingerprintInput {
  communeDigest: string;
  communeHistoryDigest: string;
  departmentDigest: string;
  departmentHistoryDigest: string;
  statisticDigest: string;
  provenanceDigest: string;
}

interface CertifiedV1Part extends PartMetrics {
  backupId: string;
  dateFrom: string;
  dateThrough: string;
  dumpSha256: string;
}

interface CertifiedV1Parent extends CertifiedSourceFingerprintInput {
  sourceFingerprint: string;
  parts: CertifiedV1Part[];
}

export const CERTIFIED_HISTORY_V2_CORRECTIONS = [
  {
    correctionId: 'pa64-level-37316',
    departmentCode: '64',
    from: '2026-07-17',
    through: '2026-08-31',
    reason: 'certified-human-level-correction',
    arreteId: 37316,
    restrictionIds: [98039, 98040],
    zoneIds: [14768, 14771],
    fromLevel: 'alerte',
    toLevel: 'alerte_renforcee',
    areaKm2: '266.97',
  },
  {
    correctionId: 'd64-late-import-37695',
    departmentCode: '64',
    from: '2026-08-12',
    through: '2026-08-12',
    reason: 'late-decree-import',
    arreteId: 37695,
    predecessorArreteId: 37627,
    restrictionIds: [105191, 105192],
    zoneIds: [14732, 14744],
    departmentAreaFromLevel: 'alerte',
    departmentAreaToLevel: 'vigilance',
    areaKm2: '30.47',
    sourceCreatedAt: '2026-08-13 06:43:51.290354',
    sourceUpdatedAt: '2026-08-13 06:44:10.812809',
  },
  {
    correctionId: 'd15-late-import-37897',
    departmentCode: '15',
    from: '2026-08-31',
    through: '2026-08-31',
    reason: 'late-decree-import',
    arreteId: 37897,
    predecessorArreteId: 37699,
    restrictionIdFrom: 108365,
    restrictionIdThrough: 108390,
    restrictionCount: 26,
    restrictionDigest:
      '29f346d995c1dcb0bbd276d346c08c253caa6529d1464ea1df331e12aca641f4',
  },
  {
    correctionId: 'd68-late-import-37898',
    departmentCode: '68',
    from: '2026-08-31',
    through: '2026-08-31',
    reason: 'late-decree-import',
    arreteId: 37898,
    predecessorArreteId: 37360,
    restrictionIds: [108391],
    zoneIds: [15475],
    restrictionDigest:
      '9ab098385094defe01be15c06abea5a6cfea01914e8ff801866c3bf4de1b56ae',
  },
] as const;

export const CERTIFIED_HISTORY_V2_PARENT_COMMUNE_DELTA = {
  from: '2026-07-17',
  through: '2026-08-27',
  changedPayloadCount: 462,
  changedCommuneCount: 12,
  changedDateCount: 42,
  changedCommuneCodes: [
    '64086',
    '64094',
    '64134',
    '64147',
    '64250',
    '64277',
    '64289',
    '64304',
    '64407',
    '64476',
    '64540',
    '64546',
  ],
  changedCommuneDigest:
    '8921260cf3c007af711eec35d2079be7a1fba06e3cae8a5080ec878be5687d21',
} as const;

export const CERTIFIED_HISTORY_V2_CORRECTED_OUTPUT_DIGESTS = {
  method: 'postgresql-jsonb-agg-sha256-v1',
  from: '2026-07-11',
  through: '2026-08-31',
  nationalSituation: {
    rowCount: 52,
    sha256: '3704c573dab970b7490a0c2b2b539affeca7cf832ff03b1bf501bed02b8111cf',
  },
  allDepartmentRestrictions: {
    rowCount: 5252,
    sha256: '7fe816603b919e44af9acdf8d30d537c83f5fe53d9112cad31210f36903ce0a5',
  },
  targetCommuneRestrictions: {
    '15': {
      rowCount: 13000,
      communeCount: 250,
      sha256:
        '89ac2956f19e00f9d255fad2289ed8d6e6f8aa48d2499717e2c5df7131b335ee',
    },
    '64': {
      rowCount: 28340,
      communeCount: 545,
      sha256:
        '6b0b477418ac3dd8da0af433ce10edbd4513514c57cf9443d60a2e3d692e4a35',
    },
    '68': {
      rowCount: 19032,
      communeCount: 366,
      sha256:
        'd1d5315670a809d5cee92844d81651a60a4370996936552ea3a001fcfa5d035f',
    },
  },
  targetDepartmentRestrictions: {
    '15': {
      rowCount: 52,
      sha256:
        'e0b8001de4acb2ded668138d21d0f255e670b2a8dc8b77a97146f264556b1bee',
    },
    '64': {
      rowCount: 52,
      sha256:
        '84d8a3a2b580dbc1670a5587bba4b1c23a60388096a36b28b785bf1a5d40f485',
    },
    '68': {
      rowCount: 52,
      sha256:
        '117ef29d45d0b0d041f847c45b703d7372f3885f2fb627d6cc573ae48f217963',
    },
  },
  fullAccumulatorCanonical: {
    communeCount: 34943,
    communeDayCount: 1817036,
    communeHistoryDigest:
      'cbc27b27356244017c067e9829347627d80fe9a225c3742706b2d1b71c52a63b',
    departmentCount: 101,
    departmentDayCount: 5252,
    departmentHistoryDigest:
      'e033ca3df6240901c87e99d00469aa1c07da1cab6f1825f0b29069550852e205',
    statisticDayCount: 52,
    statisticDigest:
      '622f931af5db040a330441f98f5872eae0f508a13a3fd695d96b52fae8f8e0d2',
  },
} as const;

export const CERTIFIED_HISTORY_V2_RECOMPUTE_BASELINE_DIGESTS = {
  method: 'postgresql-jsonb-agg-sha256-v1',
  from: '2026-07-11',
  through: '2026-08-31',
  nationalSituationSha256:
    'c752c6a3358a55ba1546f3424766ddec44470b2642ec24820cde211b4b978292',
  allDepartmentRestrictionsSha256:
    '8f2e4ab01c544f574f3fa1b813b87199cdea8bbad2bb787f6c03c297322e790e',
  targetCommuneRestrictionsSha256: {
    '15': 'ed6f140724340f3e19c24689472c13e809d147e85da6c7d3bcc8b8a922743fcc',
    '64': '7d4b59c9a1afd9b32b099c22a69dad6d016475711d8264d33726eb0c4477b4e2',
    '68': 'd1d5315670a809d5cee92844d81651a60a4370996936552ea3a001fcfa5d035f',
  },
  targetDepartmentRestrictionsSha256: {
    '15': '0cde399046e21c988a581df6404666fe6df063aeea78f9628f088499e6f34211',
    '64': 'c91e166a1e6f1024bf16096ca36bf69c2c378413f75a2dacf4b30085c956e40b',
    '68': '8217aa8496bb5a56ef023a959ea2fed7945f9362c5833a3f3d6b1521cfa24356',
  },
} as const;

export const CERTIFIED_HISTORY_V2_OPERATOR_COMMUNE_DELTA = {
  method: 'isolated-clone-before-after-canonical-digest-v1',
  departmentCode: '64',
  from: '2026-07-17',
  through: '2026-08-31',
  changedPayloadCount: 486,
  changedCommuneCount: 12,
  changedDateCount: 46,
  changedCommuneCodes:
    CERTIFIED_HISTORY_V2_PARENT_COMMUNE_DELTA.changedCommuneCodes,
  changedCommuneDigest:
    CERTIFIED_HISTORY_V2_PARENT_COMMUNE_DELTA.changedCommuneDigest,
} as const;

export const CERTIFIED_HISTORY_V2_ZONE_GEOMETRY = [
  {
    zoneId: 14732,
    ewkbSha256:
      'd6fce5a51ddb2e4f95272ea74467d67b08a8139b8c3145e993bdedafaa48d1af',
    areaLambert93Km2: '30.497320564428',
    statisticAreaKm2: '30.47',
    communeCount: 6,
    communeSetDigest:
      'de87539d081ae4759a3e6827b75220b1644862be842e191e0dfd8785ef350f5e',
    dateMajSandre: '2026-02-13',
    sandrePayloadHash:
      'd7a91db6e8bc43fc0b60006c887ec900179cd2b24237f99e7d251ddece1f124c',
  },
  {
    zoneId: 14744,
    ewkbSha256:
      'd6fce5a51ddb2e4f95272ea74467d67b08a8139b8c3145e993bdedafaa48d1af',
    areaLambert93Km2: '30.497320564428',
    statisticAreaKm2: '30.47',
    communeCount: 6,
    communeSetDigest:
      'de87539d081ae4759a3e6827b75220b1644862be842e191e0dfd8785ef350f5e',
    dateMajSandre: '2026-02-13',
    sandrePayloadHash:
      'cd082eaceafe9ea74dba9f0c4b534723f87e22617123934f9659ce73dec750ab',
  },
  {
    zoneId: 14768,
    ewkbSha256:
      'adebe40755aa02eab41efceade19f538937201f0a5c07c3bf774e34b6d0a0f1e',
    areaLambert93Km2: '267.228338785009',
    statisticAreaKm2: '266.97',
    communeCount: 20,
    communeSetDigest:
      '6d46cbd23d6c56471073b86570815ae6d23a834fb469ae9f0585c38ab39d2caf',
    dateMajSandre: '2026-02-13',
    sandrePayloadHash:
      'f536bf995c3cf3d9db71676fcae1bb9884adf5353537509d76ef8cbd027784c4',
  },
  {
    zoneId: 14771,
    ewkbSha256:
      'adebe40755aa02eab41efceade19f538937201f0a5c07c3bf774e34b6d0a0f1e',
    areaLambert93Km2: '267.228338785009',
    statisticAreaKm2: '266.97',
    communeCount: 20,
    communeSetDigest:
      '6d46cbd23d6c56471073b86570815ae6d23a834fb469ae9f0585c38ab39d2caf',
    dateMajSandre: '2026-02-13',
    sandrePayloadHash:
      'a29e9e52b5740c0be674d64ace15384d3b012a3b943f631ff18c2ace21e7e955',
  },
] as const;

const CERTIFIED_HISTORY_V2_PA64_GEOMETRY_EVIDENCE = [
  {
    zoneId: 14768,
    ewkbSha256:
      'adebe40755aa02eab41efceade19f538937201f0a5c07c3bf774e34b6d0a0f1e',
    areaLambert93Km2: '267.228338785009',
    communeCount: 20,
    communeSetDigest:
      '6d46cbd23d6c56471073b86570815ae6d23a834fb469ae9f0585c38ab39d2caf',
  },
  {
    zoneId: 14771,
    ewkbSha256:
      'adebe40755aa02eab41efceade19f538937201f0a5c07c3bf774e34b6d0a0f1e',
    areaLambert93Km2: '267.228338785009',
    communeCount: 20,
    communeSetDigest:
      '6d46cbd23d6c56471073b86570815ae6d23a834fb469ae9f0585c38ab39d2caf',
  },
] as const;

const CERTIFIED_HISTORY_V2_LATE_D64_GEOMETRY_EVIDENCE = [
  {
    zoneId: 14732,
    ewkbSha256:
      'd6fce5a51ddb2e4f95272ea74467d67b08a8139b8c3145e993bdedafaa48d1af',
    areaLambert93Km2: '30.497320564428',
    communeCount: 6,
    communeSetDigest:
      'de87539d081ae4759a3e6827b75220b1644862be842e191e0dfd8785ef350f5e',
  },
  {
    zoneId: 14744,
    ewkbSha256:
      'd6fce5a51ddb2e4f95272ea74467d67b08a8139b8c3145e993bdedafaa48d1af',
    areaLambert93Km2: '30.497320564428',
    communeCount: 6,
    communeSetDigest:
      'de87539d081ae4759a3e6827b75220b1644862be842e191e0dfd8785ef350f5e',
  },
] as const;

export const CERTIFIED_HISTORY_V2_GEOMETRY_EVIDENCE = {
  method: 'cross-backup-ewkb-area-commune-scope-v1',
  anchors: [
    {
      referenceDate: '2026-07-19',
      backupId: '6a5c13b599826965bad6ae7d',
      dumpSha256:
        'a8c24d29a52b9e19ad6029c3f585d25e783a1192fdbf73a11317b7fffea00837',
      zones: CERTIFIED_HISTORY_V2_PA64_GEOMETRY_EVIDENCE,
    },
    {
      referenceDate: '2026-08-16',
      backupId: '6a81c96699c3cde6e237108d',
      dumpSha256:
        'eb51557881b097a60bcedf81268610ef35f8dc250c3352288f89a40632e68cc6',
      zones: [
        ...CERTIFIED_HISTORY_V2_LATE_D64_GEOMETRY_EVIDENCE,
        ...CERTIFIED_HISTORY_V2_PA64_GEOMETRY_EVIDENCE,
      ],
    },
    {
      referenceDate: '2026-08-26',
      backupId: '6a8e2c8599c3cdda4dc62681',
      dumpSha256:
        '8e4a96544b338a3bc9234f4cbf3668abcff229321fd9cc85d4a8bb6031f5e206',
      zones: [
        ...CERTIFIED_HISTORY_V2_LATE_D64_GEOMETRY_EVIDENCE,
        ...CERTIFIED_HISTORY_V2_PA64_GEOMETRY_EVIDENCE,
      ],
    },
    {
      referenceDate: '2026-09-02',
      backupId: '6a97672299826944b38141dd',
      dumpSha256: CERTIFIED_HISTORY_V2_FINAL_BACKUP_SHA256,
      zones: [
        ...CERTIFIED_HISTORY_V2_LATE_D64_GEOMETRY_EVIDENCE,
        ...CERTIFIED_HISTORY_V2_PA64_GEOMETRY_EVIDENCE,
      ],
    },
  ],
  currentSourceZones: CERTIFIED_HISTORY_V2_ZONE_GEOMETRY,
} as const;

export const CERTIFIED_HISTORY_V2_GEOMETRY_EVIDENCE_FINGERPRINT = sha256(
  JSON.stringify(CERTIFIED_HISTORY_V2_GEOMETRY_EVIDENCE),
);

export const CERTIFIED_HISTORY_V2_CORRECTION_SOURCE = {
  method: 'isolated-local-clone-targeted-recompute',
  backupId: '6a97672299826944b38141dd',
  dumpSha256: CERTIFIED_HISTORY_V2_FINAL_BACKUP_SHA256,
  dateFrom: '2026-07-17',
  dateThrough: '2026-08-31',
  parentOverlayThrough: '2026-08-27',
  codeCommit: CERTIFIED_HISTORY_V2_CODE_COMMIT,
  correctionArreteIds: [37316, 37695, 37897, 37898],
  geometryEvidenceFingerprint:
    CERTIFIED_HISTORY_V2_GEOMETRY_EVIDENCE_FINGERPRINT,
  baselineOutputDigests: CERTIFIED_HISTORY_V2_RECOMPUTE_BASELINE_DIGESTS,
  correctedOutputDigests: CERTIFIED_HISTORY_V2_CORRECTED_OUTPUT_DIGESTS,
  operatorCommuneDelta: CERTIFIED_HISTORY_V2_OPERATOR_COMMUNE_DELTA,
  parentComparableCommuneDelta: CERTIFIED_HISTORY_V2_PARENT_COMMUNE_DELTA,
} as const;

export function certifiedSourceFingerprint(
  input: CertifiedSourceFingerprintInput,
): string {
  return sha256(
    JSON.stringify({
      communeDigest: input.communeDigest,
      communeHistoryDigest: input.communeHistoryDigest,
      departmentDigest: input.departmentDigest,
      departmentHistoryDigest: input.departmentHistoryDigest,
      statisticDigest: input.statisticDigest,
      provenanceDigest: input.provenanceDigest,
    }),
  );
}

async function loadCertifiedV1Parent(
  accumulator: DatabaseClient,
): Promise<CertifiedV1Parent> {
  const result = await accumulator.query(
    `
      SELECT status, "dateFrom"::text AS "dateFrom",
             "dateThrough"::text AS "dateThrough",
             "communeCount", "communeDayCount", "communeDigest",
             "communeHistoryDigest", "departmentCount",
             "departmentDayCount", "departmentDigest",
             "departmentHistoryDigest", "statisticDayCount",
             "statisticDigest", provenance,
             encode(sha256(convert_to(provenance::text, 'UTF8')), 'hex')
               AS "provenanceDigest"
      FROM "certified_history_source_run"
      WHERE id = $1
    `,
    [CERTIFIED_HISTORY_SOURCE_RUN_ID],
  );
  if (result.rowCount !== 1) {
    throw new Error('Certified v2 requires its exact certified v1 parent');
  }
  const row = result.rows[0] as Record<string, unknown>;
  const metrics = metricsFromRow(row);
  const days = dateCount(V1_PLAN_DEFINITION.from, V1_PLAN_DEFINITION.through);
  const provenance = row.provenance;
  const expectedProvenanceKeys = [
    'communeDailyObjectKeyPolicy',
    'dateSources',
    'departmentPayloadPolicy',
    'digestPolicy',
    'method',
    'planVersion',
    'statisticPayloadPolicy',
  ];
  if (
    row.status !== 'certified' ||
    row.dateFrom !== V1_PLAN_DEFINITION.from ||
    row.dateThrough !== V1_PLAN_DEFINITION.through ||
    metrics.communeCount === 0 ||
    metrics.communeDayCount !== metrics.communeCount * days ||
    metrics.departmentCount !== EXPECTED_DEPARTMENT_COUNT ||
    metrics.departmentDayCount !== EXPECTED_DEPARTMENT_COUNT * days ||
    metrics.statisticDayCount !== days ||
    !isObject(provenance) ||
    provenance.method !== 'scheduled-logical-backup-before-mutable-replay' ||
    provenance.planVersion !== 1 ||
    provenance.digestPolicy !== 'postgresql-sha256-jsonb-text-v1' ||
    provenance.communeDailyObjectKeyPolicy !== 'exact-date-SOU-SUP-AEP' ||
    provenance.departmentPayloadPolicy !==
      'complete-daily-restriction-object' ||
    provenance.statisticPayloadPolicy !== 'complete-to-jsonb-row' ||
    Object.keys(provenance).sort().join(',') !==
      expectedProvenanceKeys.join(',') ||
    !isObject(provenance.dateSources) ||
    Object.keys(provenance.dateSources).length !== days
  ) {
    throw new Error('Certified v1 parent manifest is invalid');
  }
  const parent: CertifiedV1Parent = {
    communeDigest: metrics.communeDigest,
    communeHistoryDigest: metrics.communeHistoryDigest,
    departmentDigest: metrics.departmentDigest,
    departmentHistoryDigest: metrics.departmentHistoryDigest,
    statisticDigest: metrics.statisticDigest,
    provenanceDigest: assertDigest(
      row.provenanceDigest,
      'parent provenance digest',
    ),
    sourceFingerprint: '',
    parts: [],
  };
  parent.sourceFingerprint = certifiedSourceFingerprint(parent);
  if (
    parent.provenanceDigest !== CERTIFIED_HISTORY_V2_PARENT_PROVENANCE_DIGEST ||
    parent.sourceFingerprint !== CERTIFIED_HISTORY_V2_PARENT_SOURCE_FINGERPRINT
  ) {
    throw new Error(
      'Certified v1 parent fingerprint is not the audited source',
    );
  }

  const currentMetrics = await rangeMetrics(
    accumulator,
    CERTIFIED_HISTORY_SOURCE_RUN_ID,
    V1_PLAN_DEFINITION.from,
    V1_PLAN_DEFINITION.through,
  );
  if (!sameMetrics(metrics, currentMetrics)) {
    throw new Error('Certified v1 parent data diverges from its manifest');
  }
  const outsideResult = await accumulator.query(
    `
      SELECT
        (SELECT COUNT(*) FROM "certified_history_commune_day"
          WHERE "sourceRunId" = $1
            AND date NOT BETWEEN $2::date AND $3::date)::bigint
          AS "communeCount",
        (SELECT COUNT(*) FROM "certified_history_departement_day"
          WHERE "sourceRunId" = $1
            AND date NOT BETWEEN $2::date AND $3::date)::bigint
          AS "departmentCount",
        (SELECT COUNT(*) FROM "certified_history_statistic_day"
          WHERE "sourceRunId" = $1
            AND date NOT BETWEEN $2::date AND $3::date)::bigint
          AS "statisticCount"
    `,
    [
      CERTIFIED_HISTORY_SOURCE_RUN_ID,
      V1_PLAN_DEFINITION.from,
      V1_PLAN_DEFINITION.through,
    ],
  );
  const outside = outsideResult.rows[0];
  if (
    databaseCount(outside?.communeCount, 'parent outside commune count') !==
      0 ||
    databaseCount(
      outside?.departmentCount,
      'parent outside department count',
    ) !== 0 ||
    databaseCount(outside?.statisticCount, 'parent outside statistic count') !==
      0
  ) {
    throw new Error('Certified v1 parent contains rows outside its range');
  }

  const partsResult = await accumulator.query(
    `
      SELECT "backupId", "dateFrom"::text AS "dateFrom",
             "dateThrough"::text AS "dateThrough", "dumpSha256",
             "communeCount", "communeDayCount", "communeDigest",
             "communeHistoryDigest", "departmentCount", "departmentDayCount",
             "departmentDigest", "departmentHistoryDigest",
             "statisticDayCount", "statisticDigest"
      FROM "certified_history_source_part"
      WHERE "sourceRunId" = $1
      ORDER BY "dateFrom"
    `,
    [CERTIFIED_HISTORY_SOURCE_RUN_ID],
  );
  if (partsResult.rows.length !== CERTIFIED_HISTORY_PLAN.length) {
    throw new Error('Certified v1 parent parts are incomplete');
  }
  const expectedDateSourceKeys = [
    'backupId',
    'communeHistoryDigest',
    'departmentHistoryDigest',
    'dumpSha256',
    'statisticDigest',
  ];
  const expectedDateKeys = expectedDates(
    V1_PLAN_DEFINITION.from,
    V1_PLAN_DEFINITION.through,
  );
  if (
    Object.keys(provenance.dateSources).sort().join(',') !==
    expectedDateKeys.join(',')
  ) {
    throw new Error('Certified v1 parent date sources are incomplete');
  }
  for (const [index, expected] of CERTIFIED_HISTORY_PLAN.entries()) {
    const partRow = partsResult.rows[index] as Record<string, unknown>;
    const partMetrics = metricsFromRow(partRow);
    const dumpSha256 = assertDigest(
      partRow.dumpSha256,
      `parent part ${index + 1} dump SHA256`,
    );
    const part: CertifiedV1Part = {
      backupId: String(partRow.backupId),
      dateFrom: String(partRow.dateFrom),
      dateThrough: String(partRow.dateThrough),
      dumpSha256,
      ...partMetrics,
    };
    const partDays = dateCount(expected.from, expected.through);
    const currentPartMetrics = await rangeMetrics(
      accumulator,
      CERTIFIED_HISTORY_SOURCE_RUN_ID,
      expected.from,
      expected.through,
    );
    if (
      part.backupId !== expected.backupId ||
      part.dateFrom !== expected.from ||
      part.dateThrough !== expected.through ||
      !sameMetrics(partMetrics, currentPartMetrics) ||
      partMetrics.communeCount !== metrics.communeCount ||
      partMetrics.communeDayCount !== metrics.communeCount * partDays ||
      partMetrics.communeDigest !== metrics.communeDigest ||
      partMetrics.departmentCount !== EXPECTED_DEPARTMENT_COUNT ||
      partMetrics.departmentDayCount !== EXPECTED_DEPARTMENT_COUNT * partDays ||
      partMetrics.departmentDigest !== metrics.departmentDigest ||
      partMetrics.statisticDayCount !== partDays
    ) {
      throw new Error(`Certified v1 parent part ${index + 1} is invalid`);
    }
    const rowProvenanceResult = await accumulator.query(
      `
        SELECT
          (SELECT COUNT(*) FROM "certified_history_commune_day"
            WHERE "sourceRunId" = $1 AND date BETWEEN $2::date AND $3::date
              AND ("backupId" IS DISTINCT FROM $4
                OR "dumpSha256" IS DISTINCT FROM $5))::bigint
            AS "invalidCommuneCount",
          (SELECT COUNT(*) FROM "certified_history_departement_day"
            WHERE "sourceRunId" = $1 AND date BETWEEN $2::date AND $3::date
              AND ("backupId" IS DISTINCT FROM $4
                OR "dumpSha256" IS DISTINCT FROM $5))::bigint
            AS "invalidDepartmentCount",
          (SELECT COUNT(*) FROM "certified_history_statistic_day"
            WHERE "sourceRunId" = $1 AND date BETWEEN $2::date AND $3::date
              AND ("backupId" IS DISTINCT FROM $4
                OR "dumpSha256" IS DISTINCT FROM $5))::bigint
            AS "invalidStatisticCount"
      `,
      [
        CERTIFIED_HISTORY_SOURCE_RUN_ID,
        expected.from,
        expected.through,
        expected.backupId,
        dumpSha256,
      ],
    );
    const rowProvenance = rowProvenanceResult.rows[0];
    if (
      databaseCount(
        rowProvenance?.invalidCommuneCount,
        'parent invalid commune provenance count',
      ) !== 0 ||
      databaseCount(
        rowProvenance?.invalidDepartmentCount,
        'parent invalid department provenance count',
      ) !== 0 ||
      databaseCount(
        rowProvenance?.invalidStatisticCount,
        'parent invalid statistic provenance count',
      ) !== 0
    ) {
      throw new Error(
        `Certified v1 parent row provenance diverges at part ${index + 1}`,
      );
    }
    for (const date of expectedDates(expected.from, expected.through)) {
      const dateSource = provenance.dateSources[date];
      if (
        !isObject(dateSource) ||
        Object.keys(dateSource).sort().join(',') !==
          expectedDateSourceKeys.join(',') ||
        dateSource.backupId !== expected.backupId ||
        dateSource.dumpSha256 !== dumpSha256 ||
        dateSource.communeHistoryDigest !== part.communeHistoryDigest ||
        dateSource.departmentHistoryDigest !== part.departmentHistoryDigest ||
        dateSource.statisticDigest !== part.statisticDigest
      ) {
        throw new Error(`Certified v1 parent date source diverges at ${date}`);
      }
    }
    parent.parts.push(part);
  }
  return parent;
}

async function assertV2CorrectionInputs(source: DatabaseClient): Promise<void> {
  const result = await source.query(`
    SELECT restriction.id,
           restriction."niveauGravite" AS "level",
           restriction."zoneAlerteId" AS "zoneId",
           restriction."arreteRestrictionId" AS "arreteId",
           zone.type, departement.code AS "departmentCode",
           arrete."dateSignature"::text AS "dateSignature",
           arrete."dateDebut"::text AS "dateFrom",
           arrete."dateFin"::text AS "dateThrough",
           arrete.statut,
           arrete_departement.code AS "arreteDepartmentCode",
           to_char(arrete."updatedByHuman", 'YYYY-MM-DD HH24:MI:SS.US')
             AS "updatedByHuman",
           to_char(arrete.updated_at, 'YYYY-MM-DD HH24:MI:SS.US')
             AS "updatedAt"
    FROM restriction
    JOIN zone_alerte zone ON zone.id = restriction."zoneAlerteId"
    JOIN departement ON departement.id = zone."departementId"
    JOIN arrete_restriction arrete
      ON arrete.id = restriction."arreteRestrictionId"
    JOIN departement arrete_departement
      ON arrete_departement.id = arrete."departementId"
    WHERE restriction.id IN (98039, 98040)
    ORDER BY restriction.id
  `);
  const rows = result.rows as Array<Record<string, unknown>>;
  const expected = [
    { id: 98039, zoneId: 14768, type: 'SOU' },
    { id: 98040, zoneId: 14771, type: 'SUP' },
  ];
  if (
    rows.length !== expected.length ||
    rows.some(
      (row, index) =>
        Number(row.id) !== expected[index].id ||
        Number(row.zoneId) !== expected[index].zoneId ||
        row.type !== expected[index].type ||
        Number(row.arreteId) !== 37316 ||
        row.departmentCode !== '64' ||
        row.level !== 'alerte_renforcee' ||
        row.dateSignature !== '2026-07-16' ||
        row.dateFrom !== '2026-07-17' ||
        row.dateThrough !== '2026-10-31' ||
        row.statut !== 'publie' ||
        row.arreteDepartmentCode !== '64' ||
        row.updatedByHuman !== '2026-09-01 14:15:43.845000' ||
        row.updatedAt !== '2026-09-01 14:15:47.191828',
    )
  ) {
    throw new Error(
      'Certified v2 source does not contain the exact audited PA64 correction',
    );
  }

  const geometryResult = await source.query(`
    WITH selected_zones AS MATERIALIZED (
      SELECT * FROM zone_alerte WHERE id IN (14732, 14744, 14768, 14771)
    )
    SELECT zone.id AS "zoneId",
           encode(sha256(ST_AsEWKB(zone.geom)), 'hex') AS "ewkbSha256",
           round((ST_Area(ST_Transform(zone.geom, 2154))
             / 1000000)::numeric, 12)::text AS "areaLambert93Km2",
           round((ST_Area(
             ST_Transform(zone.geom, 4326)::geography
           ) / 1000000)::numeric, 2)::text AS "statisticAreaKm2",
           zone."dateMajSandre"::text AS "dateMajSandre",
           zone."sandrePayloadHash" AS "sandrePayloadHash",
           commune_scope."communeCount",
           commune_scope."communeSetDigest"
    FROM selected_zones zone
    CROSS JOIN LATERAL (
      SELECT COUNT(*)::integer AS "communeCount",
             encode(sha256(convert_to(string_agg(
               commune.code, E'\\n' ORDER BY commune.code
             ), 'UTF8')), 'hex') AS "communeSetDigest"
      FROM commune
      WHERE commune."departementId" = zone."departementId"
        AND ST_Intersects(zone.geom, commune.geom)
        AND ST_Area(ST_Intersection(zone.geom, commune.geom))
              / ST_Area(commune.geom) > 0.01
    ) commune_scope
    ORDER BY zone.id
  `);
  const geometryRows = geometryResult.rows as Array<Record<string, unknown>>;
  if (
    geometryRows.length !== CERTIFIED_HISTORY_V2_ZONE_GEOMETRY.length ||
    geometryRows.some((row, index) => {
      const expectedGeometry = CERTIFIED_HISTORY_V2_ZONE_GEOMETRY[index];
      return (
        Number(row.zoneId) !== expectedGeometry.zoneId ||
        row.ewkbSha256 !== expectedGeometry.ewkbSha256 ||
        row.areaLambert93Km2 !== expectedGeometry.areaLambert93Km2 ||
        row.statisticAreaKm2 !== expectedGeometry.statisticAreaKm2 ||
        Number(row.communeCount) !== expectedGeometry.communeCount ||
        row.communeSetDigest !== expectedGeometry.communeSetDigest ||
        row.dateMajSandre !== expectedGeometry.dateMajSandre ||
        row.sandrePayloadHash !== expectedGeometry.sandrePayloadHash
      );
    })
  ) {
    throw new Error(
      'Certified v2 source correction geometry is not the audited stable geometry',
    );
  }

  const lateDecreesResult = await source.query(`
    SELECT arrete.id, arrete."arreteRestrictionAbrogeId" AS "predecessorId",
           arrete."dateSignature"::text AS "dateSignature",
           arrete."dateDebut"::text AS "dateFrom",
           arrete."dateFin"::text AS "dateThrough", arrete.statut,
           to_char(arrete.created_at, 'YYYY-MM-DD HH24:MI:SS.US')
             AS "sourceCreatedAt",
           to_char(arrete.updated_at, 'YYYY-MM-DD HH24:MI:SS.US')
             AS "sourceUpdatedAt",
           departement.code AS "departmentCode",
           COUNT(restriction.id)::integer AS "restrictionCount",
           MIN(restriction.id)::integer AS "firstRestrictionId",
           MAX(restriction.id)::integer AS "lastRestrictionId",
           encode(sha256(convert_to(string_agg(jsonb_build_array(
             restriction.id, restriction."zoneAlerteId", zone.type,
             restriction."niveauGravite"
           )::text, E'\\n' ORDER BY restriction.id), 'UTF8')), 'hex')
             AS "restrictionDigest"
    FROM arrete_restriction arrete
    JOIN departement ON departement.id = arrete."departementId"
    JOIN restriction ON restriction."arreteRestrictionId" = arrete.id
    JOIN zone_alerte zone ON zone.id = restriction."zoneAlerteId"
    WHERE arrete.id IN (37695, 37897, 37898)
    GROUP BY arrete.id, departement.code
    ORDER BY arrete.id
  `);
  const lateDecrees = lateDecreesResult.rows as Array<Record<string, unknown>>;
  const expectedLateDecrees = [
    {
      id: 37695,
      predecessorId: 37627,
      dateSignature: '2026-08-12',
      dateFrom: '2026-08-12',
      dateThrough: '2026-10-31',
      departmentCode: '64',
      restrictionCount: 2,
      firstRestrictionId: 105191,
      lastRestrictionId: 105192,
      sourceCreatedAt: '2026-08-13 06:43:51.290354',
      sourceUpdatedAt: '2026-08-13 06:44:10.812809',
      restrictionDigest:
        '54def4212bec4ae40e913b0fa06f9bce4abe809f6fe626d93fdf1cf726973926',
    },
    {
      id: 37897,
      predecessorId: 37699,
      dateSignature: '2026-08-28',
      dateFrom: '2026-08-31',
      dateThrough: '2026-10-31',
      departmentCode: '15',
      restrictionCount: 26,
      firstRestrictionId: 108365,
      lastRestrictionId: 108390,
      restrictionDigest:
        '29f346d995c1dcb0bbd276d346c08c253caa6529d1464ea1df331e12aca641f4',
    },
    {
      id: 37898,
      predecessorId: 37360,
      dateSignature: '2026-08-31',
      dateFrom: '2026-08-31',
      dateThrough: '2026-11-01',
      departmentCode: '68',
      restrictionCount: 1,
      firstRestrictionId: 108391,
      lastRestrictionId: 108391,
      restrictionDigest:
        '9ab098385094defe01be15c06abea5a6cfea01914e8ff801866c3bf4de1b56ae',
    },
  ];
  if (
    lateDecrees.length !== expectedLateDecrees.length ||
    lateDecrees.some((row, index) => {
      const expectedDecree = expectedLateDecrees[index];
      return (
        Number(row.id) !== expectedDecree.id ||
        Number(row.predecessorId) !== expectedDecree.predecessorId ||
        row.dateSignature !== expectedDecree.dateSignature ||
        row.dateFrom !== expectedDecree.dateFrom ||
        row.dateThrough !== expectedDecree.dateThrough ||
        row.statut !== 'publie' ||
        row.departmentCode !== expectedDecree.departmentCode ||
        Number(row.restrictionCount) !== expectedDecree.restrictionCount ||
        Number(row.firstRestrictionId) !== expectedDecree.firstRestrictionId ||
        Number(row.lastRestrictionId) !== expectedDecree.lastRestrictionId ||
        ('sourceCreatedAt' in expectedDecree &&
          row.sourceCreatedAt !== expectedDecree.sourceCreatedAt) ||
        ('sourceUpdatedAt' in expectedDecree &&
          row.sourceUpdatedAt !== expectedDecree.sourceUpdatedAt) ||
        row.restrictionDigest !== expectedDecree.restrictionDigest
      );
    })
  ) {
    throw new Error('Certified v2 source late decree inputs are not audited');
  }

  const correctedOutput = CERTIFIED_HISTORY_V2_CORRECTED_OUTPUT_DIGESTS;
  const nationalDigestResult = await source.query(
    `
      WITH rows AS MATERIALIZED (
        SELECT date, "departementSituation"::jsonb AS payload
        FROM statistic
        WHERE date BETWEEN $1::date AND $2::date
      )
      SELECT COUNT(*)::integer AS "rowCount",
             MIN(date)::text AS "dateFrom", MAX(date)::text AS "dateThrough",
             encode(sha256(convert_to(jsonb_agg(jsonb_build_object(
               'date', date, 'payload', payload
             ) ORDER BY date)::text, 'UTF8')), 'hex') AS sha256
      FROM rows
    `,
    [correctedOutput.from, correctedOutput.through],
  );
  const nationalDigest = nationalDigestResult.rows[0];
  if (
    databaseCount(
      nationalDigest?.rowCount,
      'v2 corrected national row count',
    ) !== correctedOutput.nationalSituation.rowCount ||
    nationalDigest?.dateFrom !== correctedOutput.from ||
    nationalDigest?.dateThrough !== correctedOutput.through ||
    nationalDigest?.sha256 !== correctedOutput.nationalSituation.sha256
  ) {
    throw new Error(
      'Certified v2 source national output digest is not audited',
    );
  }

  const allDepartmentDigestResult = await source.query(
    `
      WITH rows AS MATERIALIZED (
        SELECT departement.code, item.payload,
               item.payload ->> 'date' AS date
        FROM departement
        JOIN statistic_departement statistic
          ON statistic."departementId" = departement.id
        CROSS JOIN LATERAL jsonb_array_elements(statistic.restrictions)
          item(payload)
        WHERE item.payload ->> 'date' BETWEEN $1 AND $2
      )
      SELECT COUNT(*)::integer AS "rowCount",
             MIN(date) AS "dateFrom", MAX(date) AS "dateThrough",
             encode(sha256(convert_to(jsonb_agg(jsonb_build_object(
               'code', code, 'payload', payload
             ) ORDER BY code, date)::text, 'UTF8')), 'hex') AS sha256
      FROM rows
    `,
    [correctedOutput.from, correctedOutput.through],
  );
  const allDepartmentDigest = allDepartmentDigestResult.rows[0];
  if (
    databaseCount(
      allDepartmentDigest?.rowCount,
      'v2 corrected department row count',
    ) !== correctedOutput.allDepartmentRestrictions.rowCount ||
    allDepartmentDigest?.dateFrom !== correctedOutput.from ||
    allDepartmentDigest?.dateThrough !== correctedOutput.through ||
    allDepartmentDigest?.sha256 !==
      correctedOutput.allDepartmentRestrictions.sha256
  ) {
    throw new Error(
      'Certified v2 source all-department output digest is not audited',
    );
  }

  const targetCommuneDigestResult = await source.query(
    `
      WITH rows AS MATERIALIZED (
        SELECT departement.code AS "departmentCode",
               commune.code AS "communeCode", item.payload,
               item.payload ->> 'date' AS date
        FROM commune
        JOIN departement ON departement.id = commune."departementId"
        JOIN statistic_commune statistic
          ON statistic."communeId" = commune.id
        CROSS JOIN LATERAL jsonb_array_elements(statistic.restrictions)
          item(payload)
        WHERE departement.code IN ('15', '64', '68')
          AND item.payload ->> 'date' BETWEEN $1 AND $2
      )
      SELECT "departmentCode", COUNT(*)::integer AS "rowCount",
             COUNT(DISTINCT "communeCode")::integer AS "communeCount",
             MIN(date) AS "dateFrom", MAX(date) AS "dateThrough",
             encode(sha256(convert_to(jsonb_agg(jsonb_build_object(
               'commune', "communeCode", 'payload', payload
             ) ORDER BY "communeCode", date)::text, 'UTF8')), 'hex') AS sha256
      FROM rows GROUP BY "departmentCode" ORDER BY "departmentCode"
    `,
    [correctedOutput.from, correctedOutput.through],
  );
  const targetDepartmentDigestResult = await source.query(
    `
      WITH rows AS MATERIALIZED (
        SELECT departement.code, item.payload,
               item.payload ->> 'date' AS date
        FROM departement
        JOIN statistic_departement statistic
          ON statistic."departementId" = departement.id
        CROSS JOIN LATERAL jsonb_array_elements(statistic.restrictions)
          item(payload)
        WHERE departement.code IN ('15', '64', '68')
          AND item.payload ->> 'date' BETWEEN $1 AND $2
      )
      SELECT code, COUNT(*)::integer AS "rowCount",
             MIN(date) AS "dateFrom", MAX(date) AS "dateThrough",
             encode(sha256(convert_to(jsonb_agg(
               payload ORDER BY date
             )::text, 'UTF8')), 'hex') AS sha256
      FROM rows GROUP BY code ORDER BY code
    `,
    [correctedOutput.from, correctedOutput.through],
  );
  const targetCommuneDigests = targetCommuneDigestResult.rows as Array<
    Record<string, unknown>
  >;
  const targetDepartmentDigests = targetDepartmentDigestResult.rows as Array<
    Record<string, unknown>
  >;
  const targetCodes = ['15', '64', '68'] as const;
  if (
    targetCommuneDigests.length !== targetCodes.length ||
    targetDepartmentDigests.length !== targetCodes.length ||
    targetCodes.some((code, index) => {
      const communeRow = targetCommuneDigests[index];
      const departmentRow = targetDepartmentDigests[index];
      const expectedCommune = correctedOutput.targetCommuneRestrictions[code];
      const expectedDepartment =
        correctedOutput.targetDepartmentRestrictions[code];
      return (
        communeRow.departmentCode !== code ||
        databaseCount(
          communeRow.rowCount,
          `v2 corrected commune ${code} row count`,
        ) !== expectedCommune.rowCount ||
        databaseCount(
          communeRow.communeCount,
          `v2 corrected commune ${code} count`,
        ) !== expectedCommune.communeCount ||
        communeRow.dateFrom !== correctedOutput.from ||
        communeRow.dateThrough !== correctedOutput.through ||
        communeRow.sha256 !== expectedCommune.sha256 ||
        departmentRow.code !== code ||
        databaseCount(
          departmentRow.rowCount,
          `v2 corrected department ${code} row count`,
        ) !== expectedDepartment.rowCount ||
        departmentRow.dateFrom !== correctedOutput.from ||
        departmentRow.dateThrough !== correctedOutput.through ||
        departmentRow.sha256 !== expectedDepartment.sha256
      );
    })
  ) {
    throw new Error(
      'Certified v2 source targeted output digests are not audited',
    );
  }

  const canonical = correctedOutput.fullAccumulatorCanonical;
  const canonicalCommuneResult = await source.query(
    `
      WITH days AS MATERIALIZED (
        SELECT commune.code, item.payload ->> 'date' AS date,
               item.payload ->> 'SOU' AS "SOU",
               item.payload ->> 'SUP' AS "SUP",
               item.payload ->> 'AEP' AS "AEP"
        FROM commune
        JOIN statistic_commune statistic
          ON statistic."communeId" = commune.id
        CROSS JOIN LATERAL jsonb_array_elements(statistic.restrictions)
          item(payload)
        WHERE item.payload ->> 'date' BETWEEN $1 AND $2
      ), histories AS MATERIALIZED (
        SELECT code, encode(sha256(convert_to(string_agg(
          jsonb_build_array(date, "SOU", "SUP", "AEP")::text,
          E'\\n' ORDER BY date
        ), 'UTF8')), 'hex') AS digest
        FROM days GROUP BY code
      )
      SELECT (SELECT COUNT(*) FROM histories)::integer AS "communeCount",
             (SELECT COUNT(*) FROM days)::bigint AS "communeDayCount",
             encode(sha256(convert_to(string_agg(
               jsonb_build_array(code, digest)::text, E'\\n' ORDER BY code
             ), 'UTF8')), 'hex') AS "communeHistoryDigest"
      FROM histories
    `,
    [correctedOutput.from, correctedOutput.through],
  );
  const canonicalDepartmentResult = await source.query(
    `
      WITH days AS MATERIALIZED (
        SELECT departement.code, item.payload ->> 'date' AS date,
               item.payload
        FROM departement
        JOIN statistic_departement statistic
          ON statistic."departementId" = departement.id
        CROSS JOIN LATERAL jsonb_array_elements(statistic.restrictions)
          item(payload)
        WHERE item.payload ->> 'date' BETWEEN $1 AND $2
      ), histories AS MATERIALIZED (
        SELECT code, encode(sha256(convert_to(string_agg(
          jsonb_build_array(date, payload)::text, E'\\n' ORDER BY date
        ), 'UTF8')), 'hex') AS digest
        FROM days GROUP BY code
      )
      SELECT (SELECT COUNT(*) FROM histories)::integer AS "departmentCount",
             (SELECT COUNT(*) FROM days)::bigint AS "departmentDayCount",
             encode(sha256(convert_to(string_agg(
               jsonb_build_array(code, digest)::text, E'\\n' ORDER BY code
             ), 'UTF8')), 'hex') AS "departmentHistoryDigest"
      FROM histories
    `,
    [correctedOutput.from, correctedOutput.through],
  );
  const canonicalStatisticResult = await source.query(
    `
      SELECT COUNT(*)::integer AS "statisticDayCount",
             encode(sha256(convert_to(string_agg(
               jsonb_build_array(date::text, to_jsonb(statistic))::text,
               E'\\n' ORDER BY date
             ), 'UTF8')), 'hex') AS "statisticDigest"
      FROM statistic WHERE date BETWEEN $1::date AND $2::date
    `,
    [correctedOutput.from, correctedOutput.through],
  );
  const canonicalCommune = canonicalCommuneResult.rows[0];
  const canonicalDepartment = canonicalDepartmentResult.rows[0];
  const canonicalStatistic = canonicalStatisticResult.rows[0];
  if (
    databaseCount(
      canonicalCommune?.communeCount,
      'v2 source canonical commune count',
    ) !== canonical.communeCount ||
    databaseCount(
      canonicalCommune?.communeDayCount,
      'v2 source canonical commune day count',
    ) !== canonical.communeDayCount ||
    canonicalCommune?.communeHistoryDigest !== canonical.communeHistoryDigest ||
    databaseCount(
      canonicalDepartment?.departmentCount,
      'v2 source canonical department count',
    ) !== canonical.departmentCount ||
    databaseCount(
      canonicalDepartment?.departmentDayCount,
      'v2 source canonical department day count',
    ) !== canonical.departmentDayCount ||
    canonicalDepartment?.departmentHistoryDigest !==
      canonical.departmentHistoryDigest ||
    databaseCount(
      canonicalStatistic?.statisticDayCount,
      'v2 source canonical statistic day count',
    ) !== canonical.statisticDayCount ||
    canonicalStatistic?.statisticDigest !== canonical.statisticDigest
  ) {
    throw new Error('Certified v2 source canonical output is not audited');
  }

  const communeContinuityResult = await source.query(`
    WITH scoped AS MATERIALIZED (
      SELECT commune.code, departement.code AS "departmentCode",
             statistic.restrictions
      FROM commune
      JOIN departement ON departement.id = commune."departementId"
      JOIN statistic_commune statistic ON statistic."communeId" = commune.id
      WHERE departement.code IN ('15', '64', '68')
    ), paired AS (
      SELECT scoped.code, scoped."departmentCode",
             COUNT(*) FILTER (WHERE day.value ->> 'date' = '2026-08-31')
               AS "augustCount",
             COUNT(*) FILTER (WHERE day.value ->> 'date' = '2026-09-01')
               AS "septemberCount",
             (jsonb_agg(day.value - 'date') FILTER (
               WHERE day.value ->> 'date' = '2026-08-31'
             )) -> 0 AS "augustPayload",
             (jsonb_agg(day.value - 'date') FILTER (
               WHERE day.value ->> 'date' = '2026-09-01'
             )) -> 0 AS "septemberPayload"
      FROM scoped
      CROSS JOIN LATERAL jsonb_array_elements(scoped.restrictions) day(value)
      WHERE day.value ->> 'date' IN ('2026-08-31', '2026-09-01')
      GROUP BY scoped.code, scoped."departmentCode"
    )
    SELECT "departmentCode", COUNT(*)::integer AS "communeCount",
           COUNT(*) FILTER (WHERE "augustCount" <> 1 OR "septemberCount" <> 1
             OR "augustPayload" IS DISTINCT FROM "septemberPayload")::integer
             AS "invalidCount"
    FROM paired GROUP BY "departmentCode" ORDER BY "departmentCode"
  `);
  const expectedCommuneCounts: Record<string, number> = {
    '15': 250,
    '64': 545,
    '68': 366,
  };
  const communeContinuity = communeContinuityResult.rows as Array<
    Record<string, unknown>
  >;
  if (
    communeContinuity.length !== 3 ||
    communeContinuity.some(
      (row) =>
        typeof row.departmentCode !== 'string' ||
        Number(row.communeCount) !==
          expectedCommuneCounts[row.departmentCode] ||
        Number(row.invalidCount) !== 0,
    )
  ) {
    throw new Error('Certified v2 commune results do not match 1 September');
  }

  const aggregateContinuityResult = await source.query(`
    WITH days AS MATERIALIZED (
      SELECT departement.code AS "departmentCode", day.value ->> 'date' AS date,
             day.value
      FROM departement
      JOIN statistic_departement statistic
        ON statistic."departementId" = departement.id
      CROSS JOIN LATERAL jsonb_array_elements(statistic.restrictions) day(value)
      WHERE departement.code IN ('15', '64', '68')
        AND day.value ->> 'date' IN ('2026-08-31', '2026-09-01')
    ), flattened AS (
      SELECT "departmentCode", date, type, level,
             (value -> type ->> level)::numeric AS area
      FROM days
      CROSS JOIN unnest(ARRAY['SOU', 'SUP', 'AEP']) type
      CROSS JOIN unnest(ARRAY[
        'vigilance', 'alerte', 'alerte_renforcee', 'crise'
      ]) level
    ), mismatches AS (
      SELECT august."departmentCode"
      FROM flattened august
      JOIN flattened september USING ("departmentCode", type, level)
      WHERE august.date = '2026-08-31' AND september.date = '2026-09-01'
        AND august.area IS DISTINCT FROM september.area
    ), national AS MATERIALIZED (
      SELECT date::text, "departementSituation"::jsonb AS situation
      FROM statistic WHERE date IN ('2026-08-31', '2026-09-01')
    )
    SELECT (SELECT COUNT(*) FROM mismatches)::integer AS "areaMismatchCount",
           (SELECT COUNT(*) FROM national)::integer AS "nationalDayCount",
           (SELECT COUNT(*) FROM (VALUES ('15'), ('64'), ('68')) code(value)
             WHERE (SELECT situation -> code.value FROM national
                    WHERE date = '2026-08-31') IS DISTINCT FROM
                   (SELECT situation -> code.value FROM national
                    WHERE date = '2026-09-01'))::integer
             AS "nationalMismatchCount"
  `);
  const aggregateContinuity = aggregateContinuityResult.rows[0];
  if (
    databaseCount(
      aggregateContinuity?.areaMismatchCount,
      'v2 area mismatch count',
    ) !== 0 ||
    databaseCount(
      aggregateContinuity?.nationalDayCount,
      'v2 national continuity day count',
    ) !== 2 ||
    databaseCount(
      aggregateContinuity?.nationalMismatchCount,
      'v2 national mismatch count',
    ) !== 0
  ) {
    throw new Error(
      'Certified v2 department or national results do not match 1 September',
    );
  }
}

async function seedV2FromCertifiedParent(
  accumulator: DatabaseClient,
): Promise<void> {
  const parameters = [
    CERTIFIED_HISTORY_SOURCE_RUN_ID,
    CERTIFIED_HISTORY_V2_SOURCE_RUN_ID,
  ];
  await accumulator.query(
    `
      INSERT INTO "certified_history_commune_day" (
        "sourceRunId", code, date, "SOU", "SUP", "AEP",
        "backupId", "dumpSha256"
      )
      SELECT $2, code, date, "SOU", "SUP", "AEP", "backupId", "dumpSha256"
      FROM "certified_history_commune_day"
      WHERE "sourceRunId" = $1
      ON CONFLICT ("sourceRunId", code, date) DO NOTHING
    `,
    parameters,
  );
  await accumulator.query(
    `
      INSERT INTO "certified_history_departement_day" (
        "sourceRunId", code, date, restriction, "backupId", "dumpSha256"
      )
      SELECT $2, code, date, restriction, "backupId", "dumpSha256"
      FROM "certified_history_departement_day"
      WHERE "sourceRunId" = $1
      ON CONFLICT ("sourceRunId", code, date) DO NOTHING
    `,
    parameters,
  );
  await accumulator.query(
    `
      INSERT INTO "certified_history_statistic_day" (
        "sourceRunId", date, payload, "backupId", "dumpSha256"
      )
      SELECT $2, date, payload, "backupId", "dumpSha256"
      FROM "certified_history_statistic_day"
      WHERE "sourceRunId" = $1
      ON CONFLICT ("sourceRunId", date) DO NOTHING
    `,
    parameters,
  );
}

const APPLY_V2_COMMUNE_OVERLAY_SQL = `
  WITH input AS MATERIALIZED (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
      code text, date date, "SOU" text, "SUP" text, "AEP" text
    )
  ), exact AS MATERIALIZED (
    SELECT 1 FROM input
    JOIN "certified_history_commune_day" target
      ON target."sourceRunId" = $2 AND target.code = input.code
     AND target.date = input.date
    WHERE target."SOU" IS NOT DISTINCT FROM input."SOU"
      AND target."SUP" IS NOT DISTINCT FROM input."SUP"
      AND target."AEP" IS NOT DISTINCT FROM input."AEP"
  ), updated AS (
    UPDATE "certified_history_commune_day" target
    SET "SOU" = input."SOU", "SUP" = input."SUP", "AEP" = input."AEP"
    FROM input, "certified_history_commune_day" parent
    WHERE target."sourceRunId" = $2 AND parent."sourceRunId" = $3
      AND target.code = input.code AND target.date = input.date
      AND parent.code = target.code AND parent.date = target.date
      AND target."SOU" IS NOT DISTINCT FROM parent."SOU"
      AND target."SUP" IS NOT DISTINCT FROM parent."SUP"
      AND target."AEP" IS NOT DISTINCT FROM parent."AEP"
      AND (target."SOU", target."SUP", target."AEP") IS DISTINCT FROM
          (input."SOU", input."SUP", input."AEP")
    RETURNING 1
  )
  SELECT (SELECT COUNT(*) FROM input)::integer AS "inputCount",
         ((SELECT COUNT(*) FROM exact) + (SELECT COUNT(*) FROM updated))::integer
           AS "acceptedCount"
`;

const APPLY_V2_DEPARTMENT_OVERLAY_SQL = `
  WITH input AS MATERIALIZED (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
      code text, date date, restriction jsonb
    )
  ), exact AS MATERIALIZED (
    SELECT 1 FROM input
    JOIN "certified_history_departement_day" target
      ON target."sourceRunId" = $2 AND target.code = input.code
     AND target.date = input.date
    WHERE target.restriction = input.restriction
  ), updated AS (
    UPDATE "certified_history_departement_day" target
    SET restriction = input.restriction
    FROM input, "certified_history_departement_day" parent
    WHERE target."sourceRunId" = $2 AND parent."sourceRunId" = $3
      AND target.code = input.code AND target.date = input.date
      AND parent.code = target.code AND parent.date = target.date
      AND target.restriction = parent.restriction
      AND target.restriction IS DISTINCT FROM input.restriction
    RETURNING 1
  )
  SELECT (SELECT COUNT(*) FROM input)::integer AS "inputCount",
         ((SELECT COUNT(*) FROM exact) + (SELECT COUNT(*) FROM updated))::integer
           AS "acceptedCount"
`;

const APPLY_V2_STATISTIC_OVERLAY_SQL = `
  WITH input AS MATERIALIZED (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
      date date, "departmentSituation" jsonb
    )
  ), exact AS MATERIALIZED (
    SELECT 1 FROM input
    JOIN "certified_history_statistic_day" target
      ON target."sourceRunId" = $2 AND target.date = input.date
    WHERE target.payload -> 'departementSituation' -> '64' =
          input."departmentSituation"
  ), updated AS (
    UPDATE "certified_history_statistic_day" target
    SET payload = jsonb_set(
      target.payload, ARRAY['departementSituation', '64'],
      input."departmentSituation"
    )
    FROM input, "certified_history_statistic_day" parent
    WHERE target."sourceRunId" = $2 AND parent."sourceRunId" = $3
      AND target.date = input.date AND parent.date = target.date
      AND target.payload = parent.payload
      AND target.payload -> 'departementSituation' -> '64'
            IS DISTINCT FROM input."departmentSituation"
    RETURNING 1
  )
  SELECT (SELECT COUNT(*) FROM input)::integer AS "inputCount",
         ((SELECT COUNT(*) FROM exact) + (SELECT COUNT(*) FROM updated))::integer
           AS "acceptedCount"
`;

async function executeV2Overlay(
  accumulator: DatabaseClient,
  sql: string,
  rows: unknown[],
  label: string,
): Promise<void> {
  const result = await accumulator.query(sql, [
    JSON.stringify(rows),
    CERTIFIED_HISTORY_V2_SOURCE_RUN_ID,
    CERTIFIED_HISTORY_SOURCE_RUN_ID,
  ]);
  const inputCount = databaseCount(
    result.rows[0]?.inputCount,
    `${label} input`,
  );
  const acceptedCount = databaseCount(
    result.rows[0]?.acceptedCount,
    `${label} accepted`,
  );
  if (inputCount !== rows.length || acceptedCount !== rows.length) {
    throw new Error(
      `${label} does not CAS cleanly onto the certified v1 parent`,
    );
  }
}

async function loadDepartment64CommuneScope(
  source: DatabaseClient,
): Promise<Scope> {
  const result = await source.query(`
    SELECT commune.code, statistic.id AS "statisticId",
           jsonb_typeof(statistic.restrictions) AS "restrictionType"
    FROM commune
    JOIN departement ON departement.id = commune."departementId"
    LEFT JOIN statistic_commune statistic
      ON statistic."communeId" = commune.id
    WHERE departement.code = '64'
    ORDER BY commune.code
  `);
  const codes: string[] = [];
  for (const row of result.rows as Array<Record<string, unknown>>) {
    if (
      typeof row.code !== 'string' ||
      !/^64[0-9A-Z]{3}$/.test(row.code) ||
      row.statisticId === null ||
      row.restrictionType !== 'array'
    ) {
      throw new Error(
        'The v2 source has an invalid department 64 commune scope',
      );
    }
    codes.push(row.code);
  }
  if (codes.length === 0 || new Set(codes).size !== codes.length) {
    throw new Error('The v2 source has no unique department 64 commune scope');
  }
  return { codes, digest: codeDigest(codes) };
}

async function applyV2ParentOverlayFromSource(
  source: DatabaseClient,
  accumulator: DatabaseClient,
  departmentScope: Scope,
): Promise<void> {
  const from = '2026-07-17';
  const through = V1_PLAN_DEFINITION.through;
  const dates = expectedDates(from, through);
  const communeScope = await loadDepartment64CommuneScope(source);
  const communeResult = await source.query(
    `
      SELECT commune.code, item.value AS payload
      FROM commune
      JOIN departement ON departement.id = commune."departementId"
      JOIN statistic_commune statistic ON statistic."communeId" = commune.id
      CROSS JOIN LATERAL jsonb_array_elements(statistic.restrictions) item(value)
      WHERE departement.code = '64'
        AND item.value ->> 'date' BETWEEN $1::date::text AND $2::date::text
      ORDER BY item.value ->> 'date', commune.code
    `,
    [from, through],
  );
  const communeCoverage = new DailyCoverage(
    from,
    through,
    communeScope,
    'V2 department 64 commune overlay',
  );
  const communeRows = communeResult.rows.map((row) => {
    const day = validateCommuneDay(row.code, row.payload, from, through);
    communeCoverage.accept(day.date, day.code);
    return day;
  });
  communeCoverage.finish();
  for (
    let offset = 0;
    offset < communeRows.length;
    offset += INSERT_BATCH_SIZE
  ) {
    await executeV2Overlay(
      accumulator,
      APPLY_V2_COMMUNE_OVERLAY_SQL,
      communeRows.slice(offset, offset + INSERT_BATCH_SIZE),
      'V2 commune overlay',
    );
  }

  const departmentResult = await source.query(
    `
      SELECT departement.code, item.value AS payload
      FROM departement
      JOIN statistic_departement statistic
        ON statistic."departementId" = departement.id
      CROSS JOIN LATERAL jsonb_array_elements(statistic.restrictions) item(value)
      WHERE departement.code = '64'
        AND item.value ->> 'date' BETWEEN $1::date::text AND $2::date::text
      ORDER BY item.value ->> 'date'
    `,
    [from, through],
  );
  if (departmentResult.rows.length !== dates.length) {
    throw new Error(
      'The v2 department 64 overlay has incomplete date coverage',
    );
  }
  const departmentRows = departmentResult.rows.map((row, index) => {
    const day = validateDepartmentDay(row.code, row.payload, from, through);
    if (day.date !== dates[index]) {
      throw new Error('The v2 department 64 overlay has divergent dates');
    }
    return {
      code: day.code,
      date: day.date,
      restriction: day.restriction,
    };
  });
  await executeV2Overlay(
    accumulator,
    APPLY_V2_DEPARTMENT_OVERLAY_SQL,
    departmentRows,
    'V2 department overlay',
  );

  const statisticResult = await source.query(
    `
      SELECT date::text AS date, to_jsonb(statistic) AS payload
      FROM statistic WHERE date BETWEEN $1::date AND $2::date ORDER BY date
    `,
    [from, through],
  );
  if (statisticResult.rows.length !== dates.length) {
    throw new Error('The v2 statistic overlay has incomplete date coverage');
  }
  const statisticRows = statisticResult.rows.map((row, index) => {
    const day = validateStatisticDay(
      row.date,
      row.payload,
      departmentScope.codes,
      from,
      through,
    );
    if (day.date !== dates[index]) {
      throw new Error('The v2 statistic overlay has divergent dates');
    }
    const situations = day.payload.departementSituation;
    if (!isObject(situations) || !isObject(situations['64'])) {
      throw new Error('The v2 statistic overlay is missing department 64');
    }
    return { date: day.date, departmentSituation: situations['64'] };
  });
  await executeV2Overlay(
    accumulator,
    APPLY_V2_STATISTIC_OVERLAY_SQL,
    statisticRows,
    'V2 statistic overlay',
  );
}

const V2_DEPARTMENT_PARENT_DELTA_SQL = `
  WITH parent_days AS MATERIALIZED (
    SELECT * FROM "certified_history_departement_day"
    WHERE "sourceRunId" = $1 AND date BETWEEN $3::date AND $4::date
  ), corrected_days AS MATERIALIZED (
    SELECT * FROM "certified_history_departement_day"
    WHERE "sourceRunId" = $2 AND date BETWEEN $3::date AND $4::date
  ), comparison AS MATERIALIZED (
    SELECT COALESCE(parent.code, corrected.code) AS code,
           COALESCE(parent.date, corrected.date) AS date,
           parent.restriction AS "parentRestriction",
           corrected.restriction AS "correctedRestriction",
           parent.code IS NULL OR corrected.code IS NULL AS missing,
           parent.restriction IS DISTINCT FROM corrected.restriction AS changed
    FROM parent_days parent
    FULL JOIN corrected_days corrected
      ON corrected.code = parent.code AND corrected.date = parent.date
  ), classified AS (
    SELECT *, code = '64'
      AND date BETWEEN '2026-07-17'::date AND '2026-08-27'::date AS allowed,
      (
        ("correctedRestriction" - 'SOU' - 'SUP') =
          ("parentRestriction" - 'SOU' - 'SUP')
        AND (("correctedRestriction" -> 'SOU')
          - 'vigilance' - 'alerte' - 'alerte_renforcee') =
          (("parentRestriction" -> 'SOU')
          - 'vigilance' - 'alerte' - 'alerte_renforcee')
        AND (("correctedRestriction" -> 'SUP')
          - 'vigilance' - 'alerte' - 'alerte_renforcee') =
          (("parentRestriction" -> 'SUP')
          - 'vigilance' - 'alerte' - 'alerte_renforcee')
        AND ("parentRestriction" #>> ARRAY['SOU', 'alerte'])::numeric
          - ("correctedRestriction" #>> ARRAY['SOU', 'alerte'])::numeric =
          266.97 + CASE WHEN date = '2026-08-12'::date THEN 30.47 ELSE 0 END
        AND ("correctedRestriction" #>> ARRAY['SOU', 'alerte_renforcee'])::numeric
          - ("parentRestriction" #>> ARRAY['SOU', 'alerte_renforcee'])::numeric
          = 266.97
        AND ("correctedRestriction" #>> ARRAY['SOU', 'vigilance'])::numeric
          - ("parentRestriction" #>> ARRAY['SOU', 'vigilance'])::numeric =
          CASE WHEN date = '2026-08-12'::date THEN 30.47 ELSE 0 END
        AND ("parentRestriction" #>> ARRAY['SUP', 'alerte'])::numeric
          - ("correctedRestriction" #>> ARRAY['SUP', 'alerte'])::numeric =
          266.97 + CASE WHEN date = '2026-08-12'::date THEN 30.47 ELSE 0 END
        AND ("correctedRestriction" #>> ARRAY['SUP', 'alerte_renforcee'])::numeric
          - ("parentRestriction" #>> ARRAY['SUP', 'alerte_renforcee'])::numeric
          = 266.97
        AND ("correctedRestriction" #>> ARRAY['SUP', 'vigilance'])::numeric
          - ("parentRestriction" #>> ARRAY['SUP', 'vigilance'])::numeric =
          CASE WHEN date = '2026-08-12'::date THEN 30.47 ELSE 0 END
      ) AS "validCorrection"
    FROM comparison
  )
  SELECT
    COUNT(*) FILTER (WHERE missing)::integer AS "missingCount",
    COUNT(*) FILTER (WHERE changed AND NOT allowed)::integer
      AS "unexpectedChangeCount",
    COUNT(*) FILTER (WHERE allowed AND changed)::integer AS "changedCount",
    COUNT(*) FILTER (WHERE allowed AND
      (NOT changed OR "validCorrection" IS NOT TRUE))::integer
      AS "invalidCorrectionCount"
  FROM classified
`;

const V2_COMMUNE_PARENT_DELTA_SQL = `
  WITH parent_days AS MATERIALIZED (
    SELECT * FROM "certified_history_commune_day"
    WHERE "sourceRunId" = $1 AND date BETWEEN $3::date AND $4::date
  ), corrected_days AS MATERIALIZED (
    SELECT * FROM "certified_history_commune_day"
    WHERE "sourceRunId" = $2 AND date BETWEEN $3::date AND $4::date
  ), comparison AS MATERIALIZED (
    SELECT COALESCE(parent.code, corrected.code) AS code,
           COALESCE(parent.date, corrected.date) AS date,
           parent."SOU" AS "parentSOU", corrected."SOU" AS "correctedSOU",
           parent."SUP" AS "parentSUP", corrected."SUP" AS "correctedSUP",
           parent."AEP" AS "parentAEP", corrected."AEP" AS "correctedAEP",
           parent.code IS NULL OR corrected.code IS NULL AS missing
    FROM parent_days parent
    FULL JOIN corrected_days corrected
      ON corrected.code = parent.code AND corrected.date = parent.date
  ), classified AS (
    SELECT *,
      "parentSOU" IS DISTINCT FROM "correctedSOU"
        OR "parentSUP" IS DISTINCT FROM "correctedSUP"
        OR "parentAEP" IS DISTINCT FROM "correctedAEP" AS changed,
      code ~ '^64[0-9A-Z]{3}$' AND date >= '2026-07-17'::date AS allowed,
      "parentAEP" IS NOT DISTINCT FROM "correctedAEP"
        AND (
          "parentSOU" IS NOT DISTINCT FROM "correctedSOU"
          OR ("parentSOU" = 'alerte' AND "correctedSOU" = 'alerte_renforcee')
        )
        AND (
          "parentSUP" IS NOT DISTINCT FROM "correctedSUP"
          OR ("parentSUP" = 'alerte' AND "correctedSUP" = 'alerte_renforcee')
        ) AS "validCorrection"
    FROM comparison
  )
  SELECT
    COUNT(*) FILTER (WHERE missing)::integer AS "missingCount",
    COUNT(*) FILTER (WHERE changed AND NOT allowed)::integer
      AS "unexpectedChangeCount",
    COUNT(*) FILTER (WHERE allowed AND changed
      AND "validCorrection" IS NOT TRUE)::integer
      AS "invalidCorrectionCount",
    COUNT(*) FILTER (WHERE allowed AND changed)::integer
      AS "changedPayloadCount",
    COUNT(DISTINCT code) FILTER (WHERE allowed AND changed)::integer
      AS "changedCommuneCount",
    COUNT(DISTINCT date) FILTER (WHERE allowed AND changed)::integer
      AS "changedDateCount",
    encode(sha256(convert_to(string_agg(
      DISTINCT code, E'\\n' ORDER BY code
    ) FILTER (WHERE allowed AND changed), 'UTF8')), 'hex')
      AS "changedCommuneDigest"
  FROM classified
`;

const V2_STATISTIC_PARENT_DELTA_SQL = `
  WITH parent_days AS MATERIALIZED (
    SELECT * FROM "certified_history_statistic_day"
    WHERE "sourceRunId" = $1 AND date BETWEEN $3::date AND $4::date
  ), corrected_days AS MATERIALIZED (
    SELECT * FROM "certified_history_statistic_day"
    WHERE "sourceRunId" = $2 AND date BETWEEN $3::date AND $4::date
  ), comparison AS MATERIALIZED (
    SELECT COALESCE(parent.date, corrected.date) AS date,
           parent.payload AS "parentPayload",
           corrected.payload AS "correctedPayload",
           parent.date IS NULL OR corrected.date IS NULL AS missing
    FROM parent_days parent
    FULL JOIN corrected_days corrected ON corrected.date = parent.date
  ), classified AS (
    SELECT *, "parentPayload" IS DISTINCT FROM "correctedPayload" AS changed,
      date >= '2026-07-17'::date AS allowed,
      ("parentPayload" - 'departementSituation') =
        ("correctedPayload" - 'departementSituation')
        AND (("parentPayload" -> 'departementSituation') - '64') =
          (("correctedPayload" -> 'departementSituation') - '64')
        AND ("parentPayload" -> 'departementSituation' -> '64' ->> 'aep')
          IS NOT DISTINCT FROM
          ("correctedPayload" -> 'departementSituation' -> '64' ->> 'aep')
        AND (SELECT bool_and(
          parent_value IS NOT DISTINCT FROM corrected_value
          OR (parent_value = 'alerte' AND corrected_value = 'alerte_renforcee')
        ) FROM (VALUES
          ("parentPayload" -> 'departementSituation' -> '64' ->> 'max',
           "correctedPayload" -> 'departementSituation' -> '64' ->> 'max'),
          ("parentPayload" -> 'departementSituation' -> '64' ->> 'sup',
           "correctedPayload" -> 'departementSituation' -> '64' ->> 'sup'),
          ("parentPayload" -> 'departementSituation' -> '64' ->> 'sou',
           "correctedPayload" -> 'departementSituation' -> '64' ->> 'sou')
        ) transition(parent_value, corrected_value)) AS "validCorrection"
    FROM comparison
  )
  SELECT
    COUNT(*) FILTER (WHERE missing)::integer AS "missingCount",
    COUNT(*) FILTER (WHERE changed AND NOT allowed)::integer
      AS "unexpectedChangeCount",
    COUNT(*) FILTER (WHERE allowed AND changed
      AND "validCorrection" IS NOT TRUE)::integer
      AS "invalidCorrectionCount",
    COUNT(*) FILTER (WHERE allowed AND changed)::integer AS "changedDateCount"
  FROM classified
`;

export async function assertV2ParentDelta(
  accumulator: DatabaseClient,
): Promise<void> {
  const from = V1_PLAN_DEFINITION.from;
  const through = V1_PLAN_DEFINITION.through;
  const expectedCorrectionDays = dateCount('2026-07-17', through);
  const parameters = [
    CERTIFIED_HISTORY_SOURCE_RUN_ID,
    CERTIFIED_HISTORY_V2_SOURCE_RUN_ID,
    from,
    through,
  ];
  const departmentResult = await accumulator.query(
    V2_DEPARTMENT_PARENT_DELTA_SQL,
    parameters,
  );
  const communeResult = await accumulator.query(
    V2_COMMUNE_PARENT_DELTA_SQL,
    parameters,
  );
  const statisticResult = await accumulator.query(
    V2_STATISTIC_PARENT_DELTA_SQL,
    parameters,
  );
  const department = departmentResult.rows[0];
  const commune = communeResult.rows[0];
  const statistic = statisticResult.rows[0];
  const invalid = (value: unknown, label: string) =>
    databaseCount(value, label) !== 0;
  const diagnostics = {
    department: {
      missing: databaseCount(
        department?.missingCount,
        'v2 department missing count',
      ),
      unexpected: databaseCount(
        department?.unexpectedChangeCount,
        'v2 department unexpected change count',
      ),
      invalid: databaseCount(
        department?.invalidCorrectionCount,
        'v2 department invalid correction count',
      ),
      changed: databaseCount(
        department?.changedCount,
        'v2 department changed count',
      ),
    },
    commune: {
      missing: databaseCount(commune?.missingCount, 'v2 commune missing count'),
      unexpected: databaseCount(
        commune?.unexpectedChangeCount,
        'v2 commune unexpected change count',
      ),
      invalid: databaseCount(
        commune?.invalidCorrectionCount,
        'v2 commune invalid correction count',
      ),
      changedPayloads: databaseCount(
        commune?.changedPayloadCount,
        'v2 commune changed payload count',
      ),
      changedCommunes: databaseCount(
        commune?.changedCommuneCount,
        'v2 commune changed commune count',
      ),
      changedDates: databaseCount(
        commune?.changedDateCount,
        'v2 commune changed date count',
      ),
      changedCommuneDigest: assertDigest(
        commune?.changedCommuneDigest,
        'v2 commune changed commune digest',
      ),
    },
    statistic: {
      missing: databaseCount(
        statistic?.missingCount,
        'v2 statistic missing count',
      ),
      unexpected: databaseCount(
        statistic?.unexpectedChangeCount,
        'v2 statistic unexpected change count',
      ),
      invalid: databaseCount(
        statistic?.invalidCorrectionCount,
        'v2 statistic invalid correction count',
      ),
      changedDates: databaseCount(
        statistic?.changedDateCount,
        'v2 statistic changed date count',
      ),
    },
  };
  if (
    Object.values(diagnostics.department)
      .slice(0, 3)
      .some((value) => invalid(value, 'v2 department diagnostic')) ||
    diagnostics.department.changed !== expectedCorrectionDays ||
    Object.values(diagnostics.commune)
      .slice(0, 3)
      .some((value) => invalid(value, 'v2 commune diagnostic')) ||
    diagnostics.commune.changedPayloads !==
      CERTIFIED_HISTORY_V2_PARENT_COMMUNE_DELTA.changedPayloadCount ||
    diagnostics.commune.changedCommunes !==
      CERTIFIED_HISTORY_V2_PARENT_COMMUNE_DELTA.changedCommuneCount ||
    diagnostics.commune.changedDates !==
      CERTIFIED_HISTORY_V2_PARENT_COMMUNE_DELTA.changedDateCount ||
    diagnostics.commune.changedCommuneDigest !==
      CERTIFIED_HISTORY_V2_PARENT_COMMUNE_DELTA.changedCommuneDigest ||
    Object.values(diagnostics.statistic)
      .slice(0, 3)
      .some((value) => invalid(value, 'v2 statistic diagnostic')) ||
    diagnostics.statistic.changedDates !== 0
  ) {
    throw new Error(
      `Certified v2 overlay diverges from its v1 parent outside the audited correction: ${JSON.stringify(diagnostics)}`,
    );
  }
}

function sameMetrics(left: PartMetrics, right: PartMetrics): boolean {
  return (Object.keys(left) as Array<keyof PartMetrics>).every(
    (key) => left[key] === right[key],
  );
}

async function rangeMetrics(
  accumulator: DatabaseClient,
  sourceRunId: string,
  from: string,
  through: string,
): Promise<PartMetrics> {
  const result = await accumulator.query(RANGE_METRICS_SQL, [
    sourceRunId,
    from,
    through,
  ]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error('Accumulator metrics are unavailable');
  return metricsFromRow(row);
}

function assertMetricsCoverage(
  metrics: PartMetrics,
  days: number,
  communeScope: Scope,
  departmentScope: Scope,
): void {
  if (
    metrics.communeCount !== communeScope.codes.length ||
    metrics.communeDayCount !== communeScope.codes.length * days ||
    metrics.communeDigest !== communeScope.digest
  ) {
    throw new Error(
      `Accumulator commune coverage mismatch: ${metrics.communeCount}/${metrics.communeDayCount}`,
    );
  }
  if (
    metrics.departmentCount !== EXPECTED_DEPARTMENT_COUNT ||
    metrics.departmentCount !== departmentScope.codes.length ||
    metrics.departmentDayCount !== departmentScope.codes.length * days ||
    metrics.departmentDigest !== departmentScope.digest
  ) {
    throw new Error(
      `Accumulator department coverage mismatch: ${metrics.departmentCount}/${metrics.departmentDayCount}`,
    );
  }
  if (metrics.statisticDayCount !== days) {
    throw new Error(
      `Accumulator national coverage mismatch: ${metrics.statisticDayCount}/${days}`,
    );
  }
}

async function ensureRun(
  accumulator: DatabaseClient,
  definition: CertifiedHistoryPlanDefinition,
): Promise<void> {
  const result = await accumulator.query(
    `
      INSERT INTO "certified_history_source_run" (
        id, status, "dateFrom", "dateThrough"
      ) VALUES ($1, 'building', $2::date, $3::date)
      ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
      WHERE "certified_history_source_run"."dateFrom" = EXCLUDED."dateFrom"
        AND "certified_history_source_run"."dateThrough" = EXCLUDED."dateThrough"
      RETURNING id
    `,
    [definition.sourceRunId, definition.from, definition.through],
  );
  if (result.rowCount !== 1) {
    throw new Error('Accumulator source run has a divergent recovery plan');
  }
}

async function storePart(
  accumulator: DatabaseClient,
  options: BuildCertifiedHistorySourceOptions,
  metrics: PartMetrics,
  definition: CertifiedHistoryPlanDefinition,
): Promise<void> {
  const result = await accumulator.query(
    `
      INSERT INTO "certified_history_source_part" (
        "sourceRunId", "backupId", "dateFrom", "dateThrough", "dumpSha256",
        "communeCount", "communeDayCount", "communeDigest", "communeHistoryDigest",
        "departmentCount", "departmentDayCount", "departmentDigest", "departmentHistoryDigest",
        "statisticDayCount", "statisticDigest"
      ) VALUES (
        $1, $2, $3::date, $4::date, $5,
        $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
      )
      ON CONFLICT ("sourceRunId", "backupId") DO UPDATE
        SET "backupId" = EXCLUDED."backupId"
        WHERE "certified_history_source_part"."dateFrom" = EXCLUDED."dateFrom"
          AND "certified_history_source_part"."dateThrough" = EXCLUDED."dateThrough"
          AND "certified_history_source_part"."dumpSha256" = EXCLUDED."dumpSha256"
          AND "certified_history_source_part"."communeCount" = EXCLUDED."communeCount"
          AND "certified_history_source_part"."communeDayCount" = EXCLUDED."communeDayCount"
          AND "certified_history_source_part"."communeDigest" = EXCLUDED."communeDigest"
          AND "certified_history_source_part"."communeHistoryDigest" = EXCLUDED."communeHistoryDigest"
          AND "certified_history_source_part"."departmentCount" = EXCLUDED."departmentCount"
          AND "certified_history_source_part"."departmentDayCount" = EXCLUDED."departmentDayCount"
          AND "certified_history_source_part"."departmentDigest" = EXCLUDED."departmentDigest"
          AND "certified_history_source_part"."departmentHistoryDigest" = EXCLUDED."departmentHistoryDigest"
          AND "certified_history_source_part"."statisticDayCount" = EXCLUDED."statisticDayCount"
          AND "certified_history_source_part"."statisticDigest" = EXCLUDED."statisticDigest"
      RETURNING "backupId"
    `,
    [
      definition.sourceRunId,
      options.backupId,
      options.from,
      options.through,
      options.dumpSha256,
      metrics.communeCount,
      metrics.communeDayCount,
      metrics.communeDigest,
      metrics.communeHistoryDigest,
      metrics.departmentCount,
      metrics.departmentDayCount,
      metrics.departmentDigest,
      metrics.departmentHistoryDigest,
      metrics.statisticDayCount,
      metrics.statisticDigest,
    ],
  );
  if (result.rowCount !== 1) {
    throw new Error(`Backup ${options.backupId} overlaps divergent provenance`);
  }
}

async function storeV2InheritedParts(
  accumulator: DatabaseClient,
  options: BuildCertifiedHistorySourceOptions,
  communeScope: Scope,
  departmentScope: Scope,
  parent: CertifiedV1Parent,
): Promise<void> {
  const parts = parent.parts;
  for (const [index, expected] of CERTIFIED_HISTORY_PLAN.entries()) {
    const parentPart = parts[index];
    if (
      parentPart.backupId !== expected.backupId ||
      parentPart.dateFrom !== expected.from ||
      parentPart.dateThrough !== expected.through ||
      !/^[a-f0-9]{64}$/.test(parentPart.dumpSha256)
    ) {
      throw new Error(`Certified v2 parent part ${index + 1} is invalid`);
    }
    const metrics = await rangeMetrics(
      accumulator,
      CERTIFIED_HISTORY_V2_SOURCE_RUN_ID,
      expected.from,
      expected.through,
    );
    assertMetricsCoverage(
      metrics,
      dateCount(expected.from, expected.through),
      communeScope,
      departmentScope,
    );
    await storePart(
      accumulator,
      {
        ...options,
        backupId: expected.backupId,
        from: expected.from,
        through: expected.through,
        dumpSha256: parentPart.dumpSha256,
      },
      metrics,
      V2_PLAN_DEFINITION,
    );
  }
}

interface FinalizedRun {
  status: 'building' | 'certified';
  completedPartCount: number;
  metrics: PartMetrics;
}

async function finalizeRun(
  accumulator: DatabaseClient,
  fallbackMetrics: PartMetrics,
  definition: CertifiedHistoryPlanDefinition,
  certifiedV1Parent?: CertifiedV1Parent,
): Promise<FinalizedRun> {
  const partsResult = await accumulator.query(
    `
      SELECT "backupId", "dateFrom"::text, "dateThrough"::text, "dumpSha256",
             "communeCount", "communeDayCount", "communeDigest", "communeHistoryDigest",
             "departmentCount", "departmentDayCount", "departmentDigest", "departmentHistoryDigest",
             "statisticDayCount", "statisticDigest"
      FROM "certified_history_source_part"
      WHERE "sourceRunId" = $1
      ORDER BY "dateFrom"
    `,
    [definition.sourceRunId],
  );
  const parts = partsResult.rows as Array<Record<string, unknown>>;
  if (parts.length < definition.plan.length) {
    return {
      status: 'building',
      completedPartCount: parts.length,
      metrics: fallbackMetrics,
    };
  }
  if (parts.length !== definition.plan.length) {
    throw new Error(`Accumulator has unexpected source parts: ${parts.length}`);
  }
  for (let index = 0; index < definition.plan.length; index += 1) {
    const expected = definition.plan[index];
    const actual = parts[index];
    if (
      actual.backupId !== expected.backupId ||
      actual.dateFrom !== expected.from ||
      actual.dateThrough !== expected.through
    ) {
      throw new Error(`Accumulator source plan diverges at part ${index + 1}`);
    }
    const storedMetrics = metricsFromRow(actual);
    const currentMetrics = await rangeMetrics(
      accumulator,
      definition.sourceRunId,
      expected.from,
      expected.through,
    );
    if (!sameMetrics(storedMetrics, currentMetrics)) {
      throw new Error(
        `Accumulator source part metrics diverge at part ${index + 1}`,
      );
    }
    const provenanceCoverage = await accumulator.query(
      `
        SELECT
          (SELECT COUNT(*) FROM "certified_history_commune_day"
            WHERE "sourceRunId" = $1 AND date BETWEEN $2::date AND $3::date
              AND ("backupId" <> $4 OR "dumpSha256" <> $5))::bigint
            AS "invalidCommuneCount",
          (SELECT COUNT(*) FROM "certified_history_departement_day"
            WHERE "sourceRunId" = $1 AND date BETWEEN $2::date AND $3::date
              AND ("backupId" <> $4 OR "dumpSha256" <> $5))::bigint
            AS "invalidDepartmentCount",
          (SELECT COUNT(*) FROM "certified_history_statistic_day"
            WHERE "sourceRunId" = $1 AND date BETWEEN $2::date AND $3::date
              AND ("backupId" <> $4 OR "dumpSha256" <> $5))::bigint
            AS "invalidStatisticCount"
      `,
      [
        definition.sourceRunId,
        expected.from,
        expected.through,
        expected.backupId,
        actual.dumpSha256,
      ],
    );
    const provenanceRow = provenanceCoverage.rows[0];
    if (
      databaseCount(
        provenanceRow?.invalidCommuneCount,
        'invalid commune provenance count',
      ) !== 0 ||
      databaseCount(
        provenanceRow?.invalidDepartmentCount,
        'invalid department provenance count',
      ) !== 0 ||
      databaseCount(
        provenanceRow?.invalidStatisticCount,
        'invalid statistic provenance count',
      ) !== 0
    ) {
      throw new Error(
        `Accumulator row provenance diverges at part ${index + 1}`,
      );
    }
  }
  const outsideCoverage = await accumulator.query(
    `
      SELECT
        (SELECT COUNT(*) FROM "certified_history_commune_day"
          WHERE "sourceRunId" = $1
            AND date NOT BETWEEN $2::date AND $3::date)::bigint
          AS "communeCount",
        (SELECT COUNT(*) FROM "certified_history_departement_day"
          WHERE "sourceRunId" = $1
            AND date NOT BETWEEN $2::date AND $3::date)::bigint
          AS "departmentCount",
        (SELECT COUNT(*) FROM "certified_history_statistic_day"
          WHERE "sourceRunId" = $1
            AND date NOT BETWEEN $2::date AND $3::date)::bigint
          AS "statisticCount"
    `,
    [definition.sourceRunId, definition.from, definition.through],
  );
  const outside = outsideCoverage.rows[0];
  if (
    databaseCount(outside?.communeCount, 'outside commune count') !== 0 ||
    databaseCount(outside?.departmentCount, 'outside department count') !== 0 ||
    databaseCount(outside?.statisticCount, 'outside statistic count') !== 0
  ) {
    throw new Error('Accumulator contains rows outside the certified range');
  }
  const metrics = await rangeMetrics(
    accumulator,
    definition.sourceRunId,
    definition.from,
    definition.through,
  );
  const days = dateCount(definition.from, definition.through);
  const communeDigest = String(parts[0].communeDigest);
  const departmentDigest = String(parts[0].departmentDigest);
  if (
    metrics.communeCount === 0 ||
    metrics.communeDayCount !== metrics.communeCount * days ||
    metrics.communeDigest !== communeDigest ||
    parts.some((part) => part.communeDigest !== communeDigest) ||
    metrics.departmentCount !== EXPECTED_DEPARTMENT_COUNT ||
    metrics.departmentDayCount !== EXPECTED_DEPARTMENT_COUNT * days ||
    metrics.departmentDigest !== departmentDigest ||
    parts.some((part) => part.departmentDigest !== departmentDigest) ||
    metrics.statisticDayCount !== days
  ) {
    throw new Error('Complete accumulator coverage is not certifiable');
  }
  const dateSources: Record<string, unknown> = {};
  for (const [index, expected] of definition.plan.entries()) {
    const part = parts[index];
    for (const date of expectedDates(expected.from, expected.through)) {
      const dateSource: Record<string, unknown> = {
        backupId: expected.backupId,
        dumpSha256: part.dumpSha256,
        communeHistoryDigest: part.communeHistoryDigest,
        departmentHistoryDigest: part.departmentHistoryDigest,
        statisticDigest: part.statisticDigest,
      };
      if (
        definition.variant === CERTIFIED_HISTORY_V2_VARIANT &&
        date >= '2026-07-17'
      ) {
        const correctionIds = ['pa64-level-37316'];
        const departmentCodes = ['64'];
        if (date === '2026-08-12') {
          correctionIds.push('d64-late-import-37695');
        }
        if (date === '2026-08-31') {
          correctionIds.push('d15-late-import-37897', 'd68-late-import-37898');
          departmentCodes.unshift('15');
          departmentCodes.push('68');
        }
        dateSource.correctionSource = {
          method: CERTIFIED_HISTORY_V2_CORRECTION_SOURCE.method,
          backupId: CERTIFIED_HISTORY_V2_CORRECTION_SOURCE.backupId,
          dumpSha256: CERTIFIED_HISTORY_V2_CORRECTION_SOURCE.dumpSha256,
          codeCommit: CERTIFIED_HISTORY_V2_CODE_COMMIT,
          departmentCodes,
          correctionIds,
          geometryEvidenceFingerprint:
            CERTIFIED_HISTORY_V2_GEOMETRY_EVIDENCE_FINGERPRINT,
          correctedOutputDigestMethod:
            CERTIFIED_HISTORY_V2_CORRECTED_OUTPUT_DIGESTS.method,
        };
      }
      dateSources[date] = dateSource;
    }
  }
  const commonProvenance = {
    digestPolicy: 'postgresql-sha256-jsonb-text-v1',
    communeDailyObjectKeyPolicy: 'exact-date-SOU-SUP-AEP',
    departmentPayloadPolicy: 'complete-daily-restriction-object',
    statisticPayloadPolicy: 'complete-to-jsonb-row',
    dateSources,
  };
  let provenance: Record<string, unknown>;
  if (definition.variant === CERTIFIED_HISTORY_V2_VARIANT) {
    const parent = certifiedV1Parent;
    if (!parent) {
      throw new Error(
        'Certified v2 finalization requires its validated parent',
      );
    }
    provenance = {
      method: CERTIFIED_HISTORY_V2_VARIANT,
      planVersion: 2,
      parentSourceRunId: CERTIFIED_HISTORY_SOURCE_RUN_ID,
      parentSourceFingerprint: parent.sourceFingerprint,
      parentDigests: {
        communeDigest: parent.communeDigest,
        communeHistoryDigest: parent.communeHistoryDigest,
        departmentDigest: parent.departmentDigest,
        departmentHistoryDigest: parent.departmentHistoryDigest,
        statisticDigest: parent.statisticDigest,
        provenanceDigest: parent.provenanceDigest,
      },
      codeCommit: CERTIFIED_HISTORY_V2_CODE_COMMIT,
      corrections: CERTIFIED_HISTORY_V2_CORRECTIONS,
      parentDelta: CERTIFIED_HISTORY_V2_PARENT_COMMUNE_DELTA,
      correctionSource: CERTIFIED_HISTORY_V2_CORRECTION_SOURCE,
      geometryEvidence: CERTIFIED_HISTORY_V2_GEOMETRY_EVIDENCE,
      ...commonProvenance,
    };
  } else {
    provenance = {
      method: 'scheduled-logical-backup-before-mutable-replay',
      planVersion: 1,
      ...commonProvenance,
    };
  }
  const update = await accumulator.query(
    `
      UPDATE "certified_history_source_run"
      SET status = 'certified',
          "communeCount" = $2,
          "communeDayCount" = $3,
          "communeDigest" = $4,
          "communeHistoryDigest" = $5,
          "departmentCount" = $6,
          "departmentDayCount" = $7,
          "departmentDigest" = $8,
          "departmentHistoryDigest" = $9,
          "statisticDayCount" = $10,
          "statisticDigest" = $11,
          provenance = $12::jsonb,
          "updatedAt" = now()
      WHERE id = $1
      RETURNING id
    `,
    [
      definition.sourceRunId,
      metrics.communeCount,
      metrics.communeDayCount,
      metrics.communeDigest,
      metrics.communeHistoryDigest,
      metrics.departmentCount,
      metrics.departmentDayCount,
      metrics.departmentDigest,
      metrics.departmentHistoryDigest,
      metrics.statisticDayCount,
      metrics.statisticDigest,
      JSON.stringify(provenance),
    ],
  );
  if (update.rowCount !== 1)
    throw new Error('Certified source run update failed');
  return {
    status: 'certified',
    completedPartCount: parts.length,
    metrics,
  };
}

export async function buildCertifiedHistorySourcePart(
  source: Client,
  accumulator: Client,
  options: BuildCertifiedHistorySourceOptions,
): Promise<BuildCertifiedHistorySourceSummary> {
  const definition = planDefinition(options.variant);
  assertCertifiedPart(options, definition);
  const configuredSourceIdentity = databaseIdentity(
    options.sourceDatabaseUrl,
    'CERTIFIED_HISTORY_BACKUP_DATABASE_URL',
  );
  const configuredAccumulatorIdentity = databaseIdentity(
    options.accumulatorDatabaseUrl,
    'CERTIFIED_HISTORY_ACCUMULATOR_DATABASE_URL',
  );
  if (configuredSourceIdentity === configuredAccumulatorIdentity) {
    throw new Error('Backup and accumulator databases must differ');
  }
  let sourceTransaction = false;
  let accumulatorTransaction = false;
  let certifiedV1Parent: CertifiedV1Parent | undefined;
  try {
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    sourceTransaction = true;
    const mode = await source.query(
      `SELECT current_setting('transaction_read_only') AS "readOnly"`,
    );
    if (mode.rows[0]?.readOnly !== 'on') {
      throw new Error('Backup source transaction is not read-only');
    }
    await accumulator.query(
      definition.variant === CERTIFIED_HISTORY_V2_VARIANT
        ? 'BEGIN ISOLATION LEVEL REPEATABLE READ'
        : 'BEGIN',
    );
    accumulatorTransaction = true;
    const sourceIdentity = await source.query(
      `SELECT current_database() AS database,
              system_identifier::text AS "systemIdentifier"
       FROM pg_control_system()`,
    );
    const accumulatorIdentity = await accumulator.query(
      `SELECT current_database() AS database,
              system_identifier::text AS "systemIdentifier"
       FROM pg_control_system()`,
    );
    const sourceDatabase = sourceIdentity.rows[0]?.database;
    const accumulatorDatabase = accumulatorIdentity.rows[0]?.database;
    const sourceSystemIdentifier = sourceIdentity.rows[0]?.systemIdentifier;
    const accumulatorSystemIdentifier =
      accumulatorIdentity.rows[0]?.systemIdentifier;
    if (
      typeof sourceDatabase !== 'string' ||
      typeof accumulatorDatabase !== 'string' ||
      typeof sourceSystemIdentifier !== 'string' ||
      typeof accumulatorSystemIdentifier !== 'string' ||
      !/^\d+$/.test(sourceSystemIdentifier) ||
      !/^\d+$/.test(accumulatorSystemIdentifier)
    ) {
      throw new Error('Could not prove local database separation');
    }
    if (
      sourceDatabase === accumulatorDatabase &&
      sourceSystemIdentifier === accumulatorSystemIdentifier
    ) {
      throw new Error(
        'Backup and accumulator connections resolve to the same physical database',
      );
    }
    await accumulator.query(`SET LOCAL lock_timeout = '2s'`);
    if (definition.variant === CERTIFIED_HISTORY_V2_VARIANT) {
      await accumulator.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        CERTIFIED_HISTORY_SOURCE_RUN_ID,
      ]);
    }
    await accumulator.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      definition.sourceRunId,
    ]);
    await accumulator.query(ACCUMULATOR_SCHEMA_SQL);
    await ensureRun(accumulator, definition);

    const communeScope = await loadScope(source, 'commune');
    const departmentScope = await loadScope(source, 'departement');
    if (definition.variant === CERTIFIED_HISTORY_V2_VARIANT) {
      certifiedV1Parent = await loadCertifiedV1Parent(accumulator);
      await assertV2CorrectionInputs(source);
      await seedV2FromCertifiedParent(accumulator);
      await applyV2ParentOverlayFromSource(
        source,
        accumulator,
        departmentScope,
      );
    }

    const expectedDayCount = dateCount(options.from, options.through);
    const communeDays = await extractCommunes(
      source,
      accumulator,
      communeScope,
      options,
      definition,
    );
    const departmentDays = await extractDepartments(
      source,
      accumulator,
      departmentScope,
      options,
      definition,
    );
    const statisticDays = await extractStatistics(
      source,
      accumulator,
      departmentScope,
      options,
      definition,
    );
    if (
      communeDays !== communeScope.codes.length * expectedDayCount ||
      departmentDays !== EXPECTED_DEPARTMENT_COUNT * expectedDayCount ||
      statisticDays !== expectedDayCount
    ) {
      throw new Error('Extracted source coverage is incomplete');
    }
    const metrics = await rangeMetrics(
      accumulator,
      definition.sourceRunId,
      options.from,
      options.through,
    );
    assertMetricsCoverage(
      metrics,
      expectedDayCount,
      communeScope,
      departmentScope,
    );
    if (definition.variant === CERTIFIED_HISTORY_V2_VARIANT) {
      await assertV2ParentDelta(accumulator);
      await storeV2InheritedParts(
        accumulator,
        options,
        communeScope,
        departmentScope,
        certifiedV1Parent,
      );
    }
    await storePart(accumulator, options, metrics, definition);
    const finalized = await finalizeRun(
      accumulator,
      metrics,
      definition,
      certifiedV1Parent,
    );

    await source.query('COMMIT');
    sourceTransaction = false;
    await accumulator.query('COMMIT');
    accumulatorTransaction = false;
    return {
      sourceRunId: definition.sourceRunId,
      status: finalized.status,
      backupId: options.backupId,
      from: options.from,
      through: options.through,
      dumpSha256: options.dumpSha256,
      completedPartCount: finalized.completedPartCount,
      expectedPartCount: definition.plan.length,
      ...finalized.metrics,
    };
  } catch (error) {
    if (sourceTransaction)
      await source.query('ROLLBACK').catch(() => undefined);
    if (accumulatorTransaction) {
      await accumulator.query('ROLLBACK').catch(() => undefined);
    }
    throw error;
  }
}

export async function main(): Promise<void> {
  const options = parseBuildCertifiedHistorySourceOptions();
  const source = new Client({
    connectionString: options.sourceDatabaseUrl,
    application_name: 'vigieau-certified-history-backup-reader',
  });
  const accumulator = new Client({
    connectionString: options.accumulatorDatabaseUrl,
    application_name: 'vigieau-certified-history-local-accumulator',
  });
  try {
    await source.connect();
    await accumulator.connect();
    const summary = await buildCertifiedHistorySourcePart(
      source,
      accumulator,
      options,
    );
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    await accumulator.end().catch(() => undefined);
    await source.end().catch(() => undefined);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[build-certified-history-source] failed');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
