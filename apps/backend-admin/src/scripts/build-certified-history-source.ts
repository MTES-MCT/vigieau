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

const FULL_FROM = CERTIFIED_HISTORY_PLAN[0].from;
const FULL_THROUGH = CERTIFIED_HISTORY_PLAN.at(-1)!.through;

export interface BuildCertifiedHistorySourceOptions {
  sourceDatabaseUrl: string;
  accumulatorDatabaseUrl: string;
  from: string;
  through: string;
  backupId: string;
  dumpSha256: string;
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
  options: Pick<
    BuildCertifiedHistorySourceOptions,
    'backupId' | 'from' | 'through' | 'dumpSha256'
  >,
): void {
  assertCivilDate('CERTIFIED_HISTORY_FROM', options.from);
  assertCivilDate('CERTIFIED_HISTORY_THROUGH', options.through);
  const expected = CERTIFIED_HISTORY_PLAN.find(
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
  const options = {
    sourceDatabaseUrl,
    accumulatorDatabaseUrl,
    from,
    through,
    backupId,
    dumpSha256,
  };
  assertCertifiedPart(options);
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
      sourceRunId: CERTIFIED_HISTORY_SOURCE_RUN_ID,
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
      sourceRunId: CERTIFIED_HISTORY_SOURCE_RUN_ID,
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
      sourceRunId: CERTIFIED_HISTORY_SOURCE_RUN_ID,
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

function sameMetrics(left: PartMetrics, right: PartMetrics): boolean {
  return (Object.keys(left) as Array<keyof PartMetrics>).every(
    (key) => left[key] === right[key],
  );
}

async function rangeMetrics(
  accumulator: DatabaseClient,
  from: string,
  through: string,
): Promise<PartMetrics> {
  const result = await accumulator.query(RANGE_METRICS_SQL, [
    CERTIFIED_HISTORY_SOURCE_RUN_ID,
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

async function ensureRun(accumulator: DatabaseClient): Promise<void> {
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
    [CERTIFIED_HISTORY_SOURCE_RUN_ID, FULL_FROM, FULL_THROUGH],
  );
  if (result.rowCount !== 1) {
    throw new Error('Accumulator source run has a divergent recovery plan');
  }
}

async function storePart(
  accumulator: DatabaseClient,
  options: BuildCertifiedHistorySourceOptions,
  metrics: PartMetrics,
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
      CERTIFIED_HISTORY_SOURCE_RUN_ID,
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

interface FinalizedRun {
  status: 'building' | 'certified';
  completedPartCount: number;
  metrics: PartMetrics;
}

async function finalizeRun(
  accumulator: DatabaseClient,
  fallbackMetrics: PartMetrics,
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
    [CERTIFIED_HISTORY_SOURCE_RUN_ID],
  );
  const parts = partsResult.rows as Array<Record<string, unknown>>;
  if (parts.length < CERTIFIED_HISTORY_PLAN.length) {
    return {
      status: 'building',
      completedPartCount: parts.length,
      metrics: fallbackMetrics,
    };
  }
  if (parts.length !== CERTIFIED_HISTORY_PLAN.length) {
    throw new Error(`Accumulator has unexpected source parts: ${parts.length}`);
  }
  for (let index = 0; index < CERTIFIED_HISTORY_PLAN.length; index += 1) {
    const expected = CERTIFIED_HISTORY_PLAN[index];
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
        CERTIFIED_HISTORY_SOURCE_RUN_ID,
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
    [CERTIFIED_HISTORY_SOURCE_RUN_ID, FULL_FROM, FULL_THROUGH],
  );
  const outside = outsideCoverage.rows[0];
  if (
    databaseCount(outside?.communeCount, 'outside commune count') !== 0 ||
    databaseCount(outside?.departmentCount, 'outside department count') !== 0 ||
    databaseCount(outside?.statisticCount, 'outside statistic count') !== 0
  ) {
    throw new Error('Accumulator contains rows outside the certified range');
  }
  const metrics = await rangeMetrics(accumulator, FULL_FROM, FULL_THROUGH);
  const days = dateCount(FULL_FROM, FULL_THROUGH);
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
  for (const [index, expected] of CERTIFIED_HISTORY_PLAN.entries()) {
    const part = parts[index];
    for (const date of expectedDates(expected.from, expected.through)) {
      dateSources[date] = {
        backupId: expected.backupId,
        dumpSha256: part.dumpSha256,
        communeHistoryDigest: part.communeHistoryDigest,
        departmentHistoryDigest: part.departmentHistoryDigest,
        statisticDigest: part.statisticDigest,
      };
    }
  }
  const provenance = {
    method: 'scheduled-logical-backup-before-mutable-replay',
    planVersion: 1,
    digestPolicy: 'postgresql-sha256-jsonb-text-v1',
    communeDailyObjectKeyPolicy: 'exact-date-SOU-SUP-AEP',
    departmentPayloadPolicy: 'complete-daily-restriction-object',
    statisticPayloadPolicy: 'complete-to-jsonb-row',
    dateSources,
  };
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
      CERTIFIED_HISTORY_SOURCE_RUN_ID,
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
  assertCertifiedPart(options);
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
  try {
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    sourceTransaction = true;
    const mode = await source.query(
      `SELECT current_setting('transaction_read_only') AS "readOnly"`,
    );
    if (mode.rows[0]?.readOnly !== 'on') {
      throw new Error('Backup source transaction is not read-only');
    }
    await accumulator.query('BEGIN');
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
    await accumulator.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      CERTIFIED_HISTORY_SOURCE_RUN_ID,
    ]);
    await accumulator.query(ACCUMULATOR_SCHEMA_SQL);
    await ensureRun(accumulator);

    const communeScope = await loadScope(source, 'commune');
    const departmentScope = await loadScope(source, 'departement');
    const expectedDayCount = dateCount(options.from, options.through);
    const communeDays = await extractCommunes(
      source,
      accumulator,
      communeScope,
      options,
    );
    const departmentDays = await extractDepartments(
      source,
      accumulator,
      departmentScope,
      options,
    );
    const statisticDays = await extractStatistics(
      source,
      accumulator,
      departmentScope,
      options,
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
      options.from,
      options.through,
    );
    assertMetricsCoverage(
      metrics,
      expectedDayCount,
      communeScope,
      departmentScope,
    );
    await storePart(accumulator, options, metrics);
    const finalized = await finalizeRun(accumulator, metrics);

    await source.query('COMMIT');
    sourceTransaction = false;
    await accumulator.query('COMMIT');
    accumulatorTransaction = false;
    return {
      sourceRunId: CERTIFIED_HISTORY_SOURCE_RUN_ID,
      status: finalized.status,
      backupId: options.backupId,
      from: options.from,
      through: options.through,
      dumpSha256: options.dumpSha256,
      completedPartCount: finalized.completedPartCount,
      expectedPartCount: CERTIFIED_HISTORY_PLAN.length,
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
