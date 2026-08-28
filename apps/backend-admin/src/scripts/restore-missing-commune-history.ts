import 'reflect-metadata';
import 'dotenv/config';
import { DataSource, QueryRunner } from 'typeorm';
import { unwrapTypeOrmDmlReturningRows } from '../zone_publication/typeorm-query-result';

const APPLY_CONFIRMATION = 'RESTORE_MISSING_HISTORIC_RESTRICTIONS';
const SNAPSHOT_LOCK = 'vigieau:statistic-commune:snapshot-computation';
const SEVERITIES = new Set([
  'vigilance',
  'alerte',
  'alerte_renforcee',
  'crise',
]);

type Severity = 'vigilance' | 'alerte' | 'alerte_renforcee' | 'crise';

export interface SparseSourceDay {
  code: string;
  date: string;
  SOU: Severity | null;
  SUP: Severity | null;
  AEP: Severity | null;
}

interface PublicationContextRow {
  statisticRevision: string | number;
  currentPublishedDate: string | Date | null;
  historicPublishedThrough: string | Date | null;
  historicDirtyFrom: string | Date | null;
  historicDirtyThrough: string | Date | null;
  sourceRevision: string | number;
  sourcePublicRevision: string | number;
  legacyDualWrite: boolean;
  historicComputeEpoch: string | number;
  historicBackfillGlobalEpoch: string | number;
  computeMapDate: string | Date | null;
  computeStatsDate: string | Date | null;
  priorityActive: boolean | string;
}

export interface RepairPublicationContext {
  statisticRevision: string;
  currentPublishedDate: string | null;
  historicPublishedThrough: string | null;
  historicDirtyFrom: string | null;
  historicDirtyThrough: string | null;
  sourceRevision: string;
  sourcePublicRevision: string;
  legacyDualWrite: boolean;
  historicComputeEpoch: string;
  historicBackfillGlobalEpoch: string;
  computeMapDate: string | null;
  computeStatsDate: string | null;
}

interface SourceBatch {
  cursor: string;
  communeCount: number;
  rows: SparseSourceDay[];
}

interface TargetBatchResult {
  sourceCommuneCount: number | string;
  targetCommuneCount: number | string;
  changedCommuneCount: number | string;
  restoredDayCount: number | string;
  restoredValueCount: number | string;
  affectedCommuneCount: number | string;
  invalidTargetCount: number | string;
}

interface TargetValidationResult {
  sourceCommuneCount: number | string;
  targetCommuneCount: number | string;
  changedCommuneCount: number | string;
  missingDayCount: number | string;
  missingValueCount: number | string;
  invalidTargetCount: number | string;
}

export interface RestoreMissingHistoryOptions {
  through: string;
  batchSize: number;
  communeCodes: string[] | null;
  apply: boolean;
  expectedSourceDatabase: string;
  expectedTargetDatabase: string;
  expectedPublicationContext: string | null;
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  maxRetries: number;
}

export interface RestoreMissingHistorySummary {
  status: 'DRY_RUN' | 'APPLIED';
  sourceCommunes: number;
  targetCommunes: number;
  changedCommunes: number;
  restoredDays: number;
  restoredValues: number;
  appliedCommunes: number;
  batches: number;
  validatedCommunes: number;
  publicationContext: string;
  publicationRevision: string | null;
}

class CurrentStatisticPriorityError extends Error {}
class PublicationContextChangedError extends Error {}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function parseBoolean(name: string, value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() || 'false';
  if (normalized !== 'true' && normalized !== 'false') {
    throw new Error(`${name} must be true or false`);
  }
  return normalized === 'true';
}

function parseInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${name} must be an integer`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function assertCivilDate(name: string, value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${name} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${name} is not a valid date`);
  }
  return value;
}

function assertPublicationContextToken(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('REPAIR_EXPECTED_PUBLICATION_CONTEXT is invalid');
  }
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid payload');
    }
  } catch {
    throw new Error('REPAIR_EXPECTED_PUBLICATION_CONTEXT is invalid');
  }
  return value;
}

function parseCommuneCodes(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  if (value.length === 0) {
    throw new Error('REPAIR_COMMUNE_CODES must not be empty');
  }
  const codes = value.split(',');
  if (
    codes.some((code) => code !== code.trim() || !/^[0-9A-Z]{5}$/.test(code))
  ) {
    throw new Error(
      'REPAIR_COMMUNE_CODES must be a strict CSV list of INSEE codes',
    );
  }
  if (new Set(codes).size !== codes.length) {
    throw new Error('REPAIR_COMMUNE_CODES must not contain duplicates');
  }
  return [...codes].sort();
}

export function parseRestoreMissingHistoryOptions(
  environment: NodeJS.ProcessEnv = process.env,
): RestoreMissingHistoryOptions {
  const apply = parseBoolean('REPAIR_APPLY', environment.REPAIR_APPLY);
  if (apply && environment.REPAIR_CONFIRMATION?.trim() !== APPLY_CONFIRMATION) {
    throw new Error(
      `REPAIR_CONFIRMATION must equal ${APPLY_CONFIRMATION} in apply mode`,
    );
  }
  const expectedPublicationContext =
    environment.REPAIR_EXPECTED_PUBLICATION_CONTEXT?.trim() || null;
  if (apply && expectedPublicationContext === null) {
    throw new Error(
      'REPAIR_EXPECTED_PUBLICATION_CONTEXT is required in apply mode',
    );
  }
  if (expectedPublicationContext !== null) {
    assertPublicationContextToken(expectedPublicationContext);
  }
  const expectedSourceDatabase = requiredEnvironment(
    environment,
    'REPAIR_EXPECTED_SOURCE_DATABASE',
  );
  const expectedTargetDatabase = requiredEnvironment(
    environment,
    'REPAIR_EXPECTED_TARGET_DATABASE',
  );
  if (expectedSourceDatabase === expectedTargetDatabase) {
    throw new Error('Repair source and target databases must be different');
  }
  return {
    through: assertCivilDate(
      'REPAIR_THROUGH',
      requiredEnvironment(environment, 'REPAIR_THROUGH'),
    ),
    batchSize: parseInteger(
      'REPAIR_BATCH_SIZE',
      environment.REPAIR_BATCH_SIZE,
      20,
      1,
      100,
    ),
    communeCodes: parseCommuneCodes(environment.REPAIR_COMMUNE_CODES),
    apply,
    expectedSourceDatabase,
    expectedTargetDatabase,
    expectedPublicationContext,
    lockTimeoutMs: parseInteger(
      'REPAIR_LOCK_TIMEOUT_MS',
      environment.REPAIR_LOCK_TIMEOUT_MS,
      250,
      50,
      5_000,
    ),
    statementTimeoutMs: parseInteger(
      'REPAIR_STATEMENT_TIMEOUT_MS',
      environment.REPAIR_STATEMENT_TIMEOUT_MS,
      5_000,
      500,
      60_000,
    ),
    maxRetries: parseInteger(
      'REPAIR_MAX_RETRIES',
      environment.REPAIR_MAX_RETRIES,
      5,
      1,
      20,
    ),
  };
}

function databaseBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 't';
}

function databaseCount(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: ${String(value)}`);
  }
  return parsed;
}

function normalizeDatabaseDate(value: string | Date | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function normalizePublicationContext(
  row: PublicationContextRow,
): RepairPublicationContext {
  return {
    statisticRevision: String(row.statisticRevision),
    currentPublishedDate: normalizeDatabaseDate(row.currentPublishedDate),
    historicPublishedThrough: normalizeDatabaseDate(
      row.historicPublishedThrough,
    ),
    historicDirtyFrom: normalizeDatabaseDate(row.historicDirtyFrom),
    historicDirtyThrough: normalizeDatabaseDate(row.historicDirtyThrough),
    sourceRevision: String(row.sourceRevision),
    sourcePublicRevision: String(row.sourcePublicRevision),
    legacyDualWrite: databaseBoolean(row.legacyDualWrite),
    historicComputeEpoch: String(row.historicComputeEpoch),
    historicBackfillGlobalEpoch: String(row.historicBackfillGlobalEpoch),
    computeMapDate: normalizeDatabaseDate(row.computeMapDate),
    computeStatsDate: normalizeDatabaseDate(row.computeStatsDate),
  };
}

export function encodePublicationContext(
  context: RepairPublicationContext,
): string {
  return Buffer.from(JSON.stringify(context), 'utf8').toString('base64url');
}

export function encodeRepairExecutionContext(
  context: RepairPublicationContext,
  options: Pick<
    RestoreMissingHistoryOptions,
    | 'through'
    | 'communeCodes'
    | 'expectedSourceDatabase'
    | 'expectedTargetDatabase'
  >,
): string {
  return Buffer.from(
    JSON.stringify({
      publication: context,
      scope: {
        through: options.through,
        communeCodes: options.communeCodes,
        sourceDatabase: options.expectedSourceDatabase,
        targetDatabase: options.expectedTargetDatabase,
      },
    }),
    'utf8',
  ).toString('base64url');
}

export function assertRepairRangeAgainstPublicationContext(
  through: string,
  context: RepairPublicationContext,
): void {
  assertCivilDate('REPAIR_THROUGH', through);
  if (
    (context.historicDirtyFrom === null) !==
    (context.historicDirtyThrough === null)
  ) {
    throw new Error('Target historic dirty range is incomplete');
  }
  if (
    context.currentPublishedDate === null ||
    through >= context.currentPublishedDate
  ) {
    throw new Error(
      'Repair cutoff must be before the current statistic publication',
    );
  }
  if (
    context.historicDirtyFrom !== null &&
    through >= context.historicDirtyFrom
  ) {
    throw new Error('Repair cutoff intersects the target historic dirty range');
  }
  if (
    context.historicPublishedThrough === null ||
    through > context.historicPublishedThrough
  ) {
    throw new Error(
      'Repair cutoff exceeds the target published historic range',
    );
  }
}

function normalizeSeverity(
  value: unknown,
  code: string,
  date: string,
  type: 'SOU' | 'SUP' | 'AEP',
): Severity | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !SEVERITIES.has(value)) {
    throw new Error(
      `Invalid source severity ${String(value)} for ${code}/${date}/${type}`,
    );
  }
  return value as Severity;
}

export function validateSparseSourceRows(
  rows: Array<Record<string, unknown>>,
): SparseSourceDay[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const code = typeof row.code === 'string' ? row.code : '';
    const date = assertCivilDate(
      `source restriction date for ${code || 'unknown commune'}`,
      typeof row.date === 'string' ? row.date : '',
    );
    if (!/^[0-9A-Z]{5}$/.test(code)) {
      throw new Error(`Invalid source commune code ${code}`);
    }
    const normalized: SparseSourceDay = {
      code,
      date,
      SOU: normalizeSeverity(row.SOU, code, date, 'SOU'),
      SUP: normalizeSeverity(row.SUP, code, date, 'SUP'),
      AEP: normalizeSeverity(row.AEP, code, date, 'AEP'),
    };
    if (
      normalized.SOU === null &&
      normalized.SUP === null &&
      normalized.AEP === null
    ) {
      throw new Error(`Empty source restriction for ${code}/${date}`);
    }
    const key = `${code}/${date}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate source restriction ${key}`);
    }
    seen.add(key);
    return normalized;
  });
}

export const SOURCE_BATCH_SQL = `
  WITH batch_communes AS MATERIALIZED (
    SELECT commune.code, statistic.restrictions
    FROM commune
    JOIN statistic_commune statistic
      ON statistic."communeId" = commune.id
    WHERE commune.code > $1::text
      AND ($4::text[] IS NULL OR commune.code = ANY($4::text[]))
      AND jsonb_typeof(COALESCE(statistic.restrictions, '[]'::jsonb)) = 'array'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          COALESCE(statistic.restrictions, '[]'::jsonb)
        ) AS restriction(value)
        WHERE CASE
          WHEN restriction.value ->> 'date' ~ '^\\d{4}-\\d{2}-\\d{2}$'
            THEN (restriction.value ->> 'date')::date
          ELSE NULL
        END <= $2::date
          AND (
            restriction.value ->> 'SOU' IS NOT NULL
            OR restriction.value ->> 'SUP' IS NOT NULL
            OR restriction.value ->> 'AEP' IS NOT NULL
          )
      )
    ORDER BY commune.code
    LIMIT $3::integer
  )
  SELECT
    batch_communes.code,
    restriction.value ->> 'date' AS date,
    restriction.value ->> 'SOU' AS "SOU",
    restriction.value ->> 'SUP' AS "SUP",
    restriction.value ->> 'AEP' AS "AEP"
  FROM batch_communes
  CROSS JOIN LATERAL jsonb_array_elements(
    batch_communes.restrictions
  ) AS restriction(value)
  WHERE CASE
    WHEN restriction.value ->> 'date' ~ '^\\d{4}-\\d{2}-\\d{2}$'
      THEN (restriction.value ->> 'date')::date
    ELSE NULL
  END <= $2::date
    AND (
      restriction.value ->> 'SOU' IS NOT NULL
      OR restriction.value ->> 'SUP' IS NOT NULL
      OR restriction.value ->> 'AEP' IS NOT NULL
    )
  ORDER BY batch_communes.code, restriction.value ->> 'date'
`;

export const REPAIR_PUBLICATION_CONTEXT_SQL = `
  SELECT
    statistic_state."revision"::text AS "statisticRevision",
    statistic_state."currentPublishedDate"::text AS "currentPublishedDate",
    statistic_state."historicPublishedThrough"::text
      AS "historicPublishedThrough",
    statistic_state."historicDirtyFrom"::text AS "historicDirtyFrom",
    statistic_state."historicDirtyThrough"::text AS "historicDirtyThrough",
    source_state."revision"::text AS "sourceRevision",
    source_state."publicRevision"::text AS "sourcePublicRevision",
    source_state."legacyDualWrite" AS "legacyDualWrite",
    config."historicComputeEpoch"::text AS "historicComputeEpoch",
    config."historicBackfillGlobalEpoch"::text
      AS "historicBackfillGlobalEpoch",
    config."computeMapDate"::text AS "computeMapDate",
    config."computeStatsDate"::text AS "computeStatsDate",
    (
      EXISTS (
        SELECT 1
        FROM "current_zone_recompute_request" request
        WHERE request."currentPending"
          OR EXISTS (
            SELECT 1
            FROM unnest(request."pendingScheduledDates") pending(date)
            WHERE pending.date <=
              (now() AT TIME ZONE 'Europe/Paris')::date
          )
      )
      OR EXISTS (
        SELECT 1
        FROM "external_publication_run" run
        WHERE run."jobKey" = 'compute:national-daily'
          AND run.status = 'running'
      )
      OR EXISTS (
        SELECT 1
        FROM "statistic_commune_snapshot" snapshot
        WHERE snapshot.status IN ('running', 'ready', 'partial')
      )
    ) AS "priorityActive"
  FROM "statistic_publication_state" statistic_state
  CROSS JOIN "zone_publication_source_state" source_state
  CROSS JOIN config
  WHERE statistic_state.id = 1
    AND source_state.id = 1
    AND config.id = 1
`;

export const REPAIR_CURRENT_PRIORITY_SQL = `
  SELECT (
    EXISTS (
      SELECT 1
      FROM "current_zone_recompute_request" request
      WHERE request."currentPending"
        OR EXISTS (
          SELECT 1
          FROM unnest(request."pendingScheduledDates") pending(date)
          WHERE pending.date <=
            (now() AT TIME ZONE 'Europe/Paris')::date
        )
    )
    OR EXISTS (
      SELECT 1
      FROM "external_publication_run" run
      WHERE run."jobKey" = 'compute:national-daily'
        AND run.status = 'running'
    )
    OR EXISTS (
      SELECT 1
      FROM "statistic_commune_snapshot" snapshot
      WHERE snapshot.status IN ('running', 'ready', 'partial')
    )
  ) AS "priorityActive"
`;

export const TARGET_BATCH_SQL = `
  WITH source_input AS MATERIALIZED (
    SELECT code, date, "SOU", "SUP", "AEP"
    FROM jsonb_to_recordset($1::jsonb) AS source(
      code text,
      date text,
      "SOU" text,
      "SUP" text,
      "AEP" text
    )
  ), source_communes AS MATERIALIZED (
    SELECT DISTINCT code FROM source_input
  ), target_statistics AS MATERIALIZED (
    SELECT
      statistic.id,
      commune.code,
      statistic.restrictions AS "originalRestrictions",
      statistic."restrictionsByMonth" AS "originalRestrictionsByMonth"
    FROM source_communes source
    JOIN commune ON commune.code = source.code
    JOIN statistic_commune statistic
      ON statistic."communeId" = commune.id
  ), target_days AS MATERIALIZED (
    SELECT
      target.id,
      target.code,
      daily.ordinality,
      daily.value,
      daily.value ->> 'date' AS date
    FROM target_statistics target
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(COALESCE(target."originalRestrictions", '[]'::jsonb))
          = 'array'
          THEN COALESCE(target."originalRestrictions", '[]'::jsonb)
        ELSE '[]'::jsonb
      END
    ) WITH ORDINALITY AS daily(value, ordinality)
  ), target_months AS MATERIALIZED (
    SELECT
      target.id,
      monthly.ordinality,
      monthly.value,
      monthly.value ->> 'date' AS month
    FROM target_statistics target
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(
          COALESCE(target."originalRestrictionsByMonth", '[]'::jsonb)
        ) = 'array'
          THEN COALESCE(target."originalRestrictionsByMonth", '[]'::jsonb)
        ELSE '[]'::jsonb
      END
    ) WITH ORDINALITY AS monthly(value, ordinality)
  ), invalid_targets AS MATERIALIZED (
    SELECT target.id
    FROM target_statistics target
    WHERE jsonb_typeof(COALESCE(target."originalRestrictions", '[]'::jsonb))
      <> 'array'
      OR jsonb_typeof(
        COALESCE(target."originalRestrictionsByMonth", '[]'::jsonb)
      ) <> 'array'
    UNION
    SELECT day.id
    FROM target_days day
    WHERE jsonb_typeof(day.value) <> 'object'
      OR day.date IS NULL
      OR day.date !~ '^\\d{4}-\\d{2}-\\d{2}$'
    UNION
    SELECT month.id
    FROM target_months month
    WHERE jsonb_typeof(month.value) <> 'object'
      OR month.month IS NULL
      OR month.month !~ '^\\d{4}-\\d{2}$'
    UNION
    SELECT day.id
    FROM target_days day
    GROUP BY day.id, day.date
    HAVING COUNT(*) <> 1
    UNION
    SELECT month.id
    FROM target_months month
    GROUP BY month.id, month.month
    HAVING COUNT(*) <> 1
  ), fill_plan AS MATERIALIZED (
    SELECT
      target.id,
      source.code,
      source.date,
      source."SOU",
      source."SUP",
      source."AEP",
      day.value AS "targetValue",
      day.ordinality,
      source."SOU" IS NOT NULL
        AND day.value ->> 'SOU' IS NULL AS "fillSOU",
      source."SUP" IS NOT NULL
        AND day.value ->> 'SUP' IS NULL AS "fillSUP",
      source."AEP" IS NOT NULL
        AND day.value ->> 'AEP' IS NULL AS "fillAEP"
    FROM source_input source
    JOIN target_statistics target ON target.code = source.code
    LEFT JOIN target_days day
      ON day.id = target.id
      AND day.date = source.date
  ), changed_dates AS MATERIALIZED (
    SELECT *
    FROM fill_plan
    WHERE "fillSOU" OR "fillSUP" OR "fillAEP"
  ), merged_existing_days AS (
    SELECT
      day.id,
      day.date,
      day.ordinality,
      day.value
        || CASE
          WHEN plan."fillSOU" THEN jsonb_build_object('SOU', plan."SOU")
          ELSE '{}'::jsonb
        END
        || CASE
          WHEN plan."fillSUP" THEN jsonb_build_object('SUP', plan."SUP")
          ELSE '{}'::jsonb
        END
        || CASE
          WHEN plan."fillAEP" THEN jsonb_build_object('AEP', plan."AEP")
          ELSE '{}'::jsonb
        END AS value
    FROM target_days day
    LEFT JOIN changed_dates plan
      ON plan.id = day.id
      AND plan.date = day.date
  ), appended_days AS (
    SELECT
      changed.id,
      changed.date,
      9223372036854775807::bigint AS ordinality,
      jsonb_build_object(
        'date', changed.date,
        'SOU', changed."SOU",
        'SUP', changed."SUP",
        'AEP', changed."AEP"
      ) AS value
    FROM changed_dates changed
    WHERE changed."targetValue" IS NULL
  ), merged_days AS MATERIALIZED (
    SELECT * FROM merged_existing_days
    UNION ALL
    SELECT * FROM appended_days
  ), changed_months AS MATERIALIZED (
    SELECT DISTINCT id, left(date, 7) AS month
    FROM changed_dates
  ), monthly_weights AS MATERIALIZED (
    SELECT
      changed.id,
      changed.month,
      COALESCE(
        SUM(
          CASE GREATEST(
            CASE day.value ->> 'AEP'
              WHEN 'vigilance' THEN 2
              WHEN 'alerte' THEN 3
              WHEN 'alerte_renforcee' THEN 4
              WHEN 'crise' THEN 5
              ELSE 1
            END,
            CASE day.value ->> 'SOU'
              WHEN 'vigilance' THEN 2
              WHEN 'alerte' THEN 3
              WHEN 'alerte_renforcee' THEN 4
              WHEN 'crise' THEN 5
              ELSE 1
            END,
            CASE day.value ->> 'SUP'
              WHEN 'vigilance' THEN 2
              WHEN 'alerte' THEN 3
              WHEN 'alerte_renforcee' THEN 4
              WHEN 'crise' THEN 5
              ELSE 1
            END
          )
            WHEN 2 THEN 0.5
            WHEN 3 THEN 2
            WHEN 4 THEN 3
            WHEN 5 THEN 4
            ELSE 0
          END
        ),
        0
      ) AS ponderation
    FROM changed_months changed
    JOIN merged_days day
      ON day.id = changed.id
      AND left(day.date, 7) = changed.month
    GROUP BY changed.id, changed.month
  ), merged_existing_months AS (
    SELECT
      month.id,
      month.month,
      month.ordinality,
      CASE
        WHEN weight.month IS NOT NULL
          THEN month.value
            || jsonb_build_object('ponderation', weight.ponderation)
        ELSE month.value
      END AS value
    FROM target_months month
    LEFT JOIN monthly_weights weight
      ON weight.id = month.id
      AND weight.month = month.month
  ), appended_months AS (
    SELECT
      weight.id,
      weight.month,
      9223372036854775807::bigint AS ordinality,
      jsonb_build_object(
        'date', weight.month,
        'ponderation', weight.ponderation
      ) AS value
    FROM monthly_weights weight
    WHERE NOT EXISTS (
      SELECT 1
      FROM target_months month
      WHERE month.id = weight.id
        AND month.month = weight.month
    )
  ), merged_months AS (
    SELECT * FROM merged_existing_months
    UNION ALL
    SELECT * FROM appended_months
  ), prepared_updates AS MATERIALIZED (
    SELECT
      target.id,
      target."originalRestrictions",
      target."originalRestrictionsByMonth",
      (
        SELECT jsonb_agg(day.value ORDER BY day.date, day.ordinality)
        FROM merged_days day
        WHERE day.id = target.id
      ) AS restrictions,
      (
        SELECT jsonb_agg(month.value ORDER BY month.month, month.ordinality)
        FROM merged_months month
        WHERE month.id = target.id
      ) AS "restrictionsByMonth"
    FROM target_statistics target
    WHERE EXISTS (SELECT 1 FROM changed_dates WHERE id = target.id)
  ), updated AS (
    UPDATE statistic_commune statistic
    SET restrictions = prepared.restrictions,
        "restrictionsByMonth" = prepared."restrictionsByMonth"
    FROM prepared_updates prepared
    WHERE $2::boolean
      AND NOT EXISTS (SELECT 1 FROM invalid_targets)
      AND statistic.id = prepared.id
      AND statistic.restrictions
        IS NOT DISTINCT FROM prepared."originalRestrictions"
      AND statistic."restrictionsByMonth"
        IS NOT DISTINCT FROM prepared."originalRestrictionsByMonth"
    RETURNING statistic.id
  )
  SELECT
    (SELECT COUNT(*) FROM source_communes)::integer AS "sourceCommuneCount",
    (SELECT COUNT(*) FROM target_statistics)::integer AS "targetCommuneCount",
    (SELECT COUNT(DISTINCT id) FROM changed_dates)::integer
      AS "changedCommuneCount",
    (SELECT COUNT(*) FROM changed_dates)::integer AS "restoredDayCount",
    COALESCE((
      SELECT SUM(
        "fillSOU"::integer + "fillSUP"::integer + "fillAEP"::integer
      )
      FROM changed_dates
    ), 0)::integer AS "restoredValueCount",
    (SELECT COUNT(*) FROM updated)::integer AS "affectedCommuneCount",
    (SELECT COUNT(*) FROM invalid_targets)::integer AS "invalidTargetCount"
`;

export const VALIDATE_TARGET_BATCH_SQL = `
  WITH source_input AS MATERIALIZED (
    SELECT code, date, "SOU", "SUP", "AEP"
    FROM jsonb_to_recordset($1::jsonb) AS source(
      code text,
      date text,
      "SOU" text,
      "SUP" text,
      "AEP" text
    )
  ), source_communes AS MATERIALIZED (
    SELECT DISTINCT code FROM source_input
  ), target_statistics AS MATERIALIZED (
    SELECT statistic.id, commune.code, statistic.restrictions
    FROM source_communes source
    JOIN commune ON commune.code = source.code
    JOIN statistic_commune statistic
      ON statistic."communeId" = commune.id
  ), target_days AS MATERIALIZED (
    SELECT
      target.id,
      target.code,
      daily.value,
      daily.value ->> 'date' AS date
    FROM target_statistics target
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(COALESCE(target.restrictions, '[]'::jsonb)) = 'array'
          THEN COALESCE(target.restrictions, '[]'::jsonb)
        ELSE '[]'::jsonb
      END
    ) AS daily(value)
  ), invalid_targets AS (
    SELECT target.id
    FROM target_statistics target
    WHERE jsonb_typeof(COALESCE(target.restrictions, '[]'::jsonb)) <> 'array'
    UNION
    SELECT day.id
    FROM target_days day
    WHERE jsonb_typeof(day.value) <> 'object'
      OR day.date IS NULL
      OR day.date !~ '^\\d{4}-\\d{2}-\\d{2}$'
    UNION
    SELECT day.id
    FROM target_days day
    GROUP BY day.id, day.date
    HAVING COUNT(*) <> 1
  ), missing AS MATERIALIZED (
    SELECT
      source.code,
      source.date,
      source."SOU" IS NOT NULL
        AND day.value ->> 'SOU' IS NULL AS "missingSOU",
      source."SUP" IS NOT NULL
        AND day.value ->> 'SUP' IS NULL AS "missingSUP",
      source."AEP" IS NOT NULL
        AND day.value ->> 'AEP' IS NULL AS "missingAEP"
    FROM source_input source
    LEFT JOIN target_statistics target ON target.code = source.code
    LEFT JOIN target_days day
      ON day.id = target.id
      AND day.date = source.date
  )
  SELECT
    (SELECT COUNT(*) FROM source_communes)::integer AS "sourceCommuneCount",
    (SELECT COUNT(*) FROM target_statistics)::integer AS "targetCommuneCount",
    (SELECT COUNT(DISTINCT code) FROM missing
      WHERE "missingSOU" OR "missingSUP" OR "missingAEP")::integer
      AS "changedCommuneCount",
    (SELECT COUNT(*) FROM missing
      WHERE "missingSOU" OR "missingSUP" OR "missingAEP")::integer
      AS "missingDayCount",
    COALESCE((
      SELECT SUM(
        "missingSOU"::integer
        + "missingSUP"::integer
        + "missingAEP"::integer
      )
      FROM missing
    ), 0)::integer AS "missingValueCount",
    (SELECT COUNT(*) FROM invalid_targets)::integer AS "invalidTargetCount"
`;

function isRetryableDatabaseError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return ['55P03', '57014', '40P01', '40001'].includes(
    String((error as { code: unknown }).code),
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function assertDatabaseName(
  database: Pick<DataSource, 'query'>,
  expected: string,
  role: string,
): Promise<void> {
  const [row] = (await database.query(
    'SELECT current_database() AS "database"',
  )) as Array<{ database: string }>;
  if (row?.database !== expected) {
    throw new Error(
      `${role} database mismatch: ${row?.database ?? 'missing'}/${expected}`,
    );
  }
}

async function assertSourceReadOnly(source: DataSource): Promise<void> {
  const [row] = (await source.query(
    'SHOW default_transaction_read_only',
  )) as Array<{ default_transaction_read_only: string }>;
  if (row?.default_transaction_read_only !== 'on') {
    throw new Error('Source database connection is not read-only');
  }
}

async function currentPriorityActive(runner: QueryRunner): Promise<boolean> {
  const [row] = (await runner.query(REPAIR_CURRENT_PRIORITY_SQL)) as Array<{
    priorityActive: boolean | string;
  }>;
  return databaseBoolean(row?.priorityActive);
}

async function publicationContext(
  runner: QueryRunner,
  lockRows = false,
): Promise<RepairPublicationContext> {
  const [row] = (await runner.query(
    `${REPAIR_PUBLICATION_CONTEXT_SQL}${
      lockRows ? ' FOR SHARE OF statistic_state, source_state, config' : ''
    }`,
  )) as PublicationContextRow[];
  if (!row) throw new Error('Statistic publication context is unavailable');
  if (databaseBoolean(row.priorityActive)) {
    throw new CurrentStatisticPriorityError(
      'Current statistic computation has priority over the repair',
    );
  }
  return normalizePublicationContext(row);
}

async function withSnapshotLock<T>(
  target: DataSource,
  options: RestoreMissingHistoryOptions,
  operation: (runner: QueryRunner) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxRetries; attempt += 1) {
    const runner = target.createQueryRunner();
    let locked = false;
    let retry = false;
    try {
      await runner.connect();
      if (await currentPriorityActive(runner)) {
        throw new CurrentStatisticPriorityError(
          'Current statistic computation has priority over the repair',
        );
      }
      const [lock] = (await runner.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [SNAPSHOT_LOCK],
      )) as Array<{ locked: boolean | string }>;
      locked = databaseBoolean(lock?.locked);
      if (!locked) {
        throw new CurrentStatisticPriorityError(
          'Current statistic computation owns the snapshot lock',
        );
      }
      await runner.startTransaction();
      await runner.query("SELECT set_config('lock_timeout', $1, true)", [
        `${options.lockTimeoutMs}ms`,
      ]);
      await runner.query("SELECT set_config('statement_timeout', $1, true)", [
        `${options.statementTimeoutMs}ms`,
      ]);
      if (await currentPriorityActive(runner)) {
        throw new CurrentStatisticPriorityError(
          'Current statistic computation became due before the repair batch',
        );
      }
      const result = await operation(runner);
      await runner.commitTransaction();
      return result;
    } catch (error) {
      lastError = error;
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      const retryable =
        error instanceof CurrentStatisticPriorityError ||
        isRetryableDatabaseError(error);
      if (!retryable || attempt === options.maxRetries) throw error;
      retry = true;
    } finally {
      if (locked) {
        await runner.query('SELECT pg_advisory_unlock(hashtext($1))', [
          SNAPSHOT_LOCK,
        ]);
      }
      await runner.release();
    }
    if (retry) await wait(Math.min(1_000, 50 * 2 ** (attempt - 1)));
  }
  throw lastError;
}

async function assertExpectedContext(
  runner: QueryRunner,
  expected: RepairPublicationContext,
  lockRows: boolean,
): Promise<void> {
  const current = await publicationContext(runner, lockRows);
  if (
    encodePublicationContext(current) !== encodePublicationContext(expected)
  ) {
    throw new PublicationContextChangedError(
      'Statistic publication context changed; rerun the dry-run before applying',
    );
  }
}

async function readSourceBatch(
  source: DataSource,
  cursor: string,
  options: RestoreMissingHistoryOptions,
): Promise<SourceBatch | null> {
  const rawRows = (await source.query(SOURCE_BATCH_SQL, [
    cursor,
    options.through,
    options.batchSize,
    options.communeCodes,
  ])) as Array<Record<string, unknown>>;
  if (rawRows.length === 0) return null;
  const rows = validateSparseSourceRows(rawRows);
  const codes = [...new Set(rows.map((row) => row.code))];
  return {
    cursor: codes.at(-1)!,
    communeCount: codes.length,
    rows,
  };
}

async function validateTargetBatch(
  runner: QueryRunner,
  rows: SparseSourceDay[],
  requireComplete: boolean,
): Promise<TargetValidationResult> {
  const [result] = (await runner.query(VALIDATE_TARGET_BATCH_SQL, [
    JSON.stringify(rows),
  ])) as TargetValidationResult[];
  if (!result) throw new Error('Repair validation returned no result');
  const sourceCommunes = databaseCount(
    result.sourceCommuneCount,
    'validation source commune count',
  );
  const targetCommunes = databaseCount(
    result.targetCommuneCount,
    'validation target commune count',
  );
  const invalidTargets = databaseCount(
    result.invalidTargetCount,
    'validation invalid target count',
  );
  const missingValues = databaseCount(
    result.missingValueCount,
    'validation missing value count',
  );
  if (sourceCommunes !== targetCommunes || invalidTargets !== 0) {
    throw new Error(
      `Repair validation coverage mismatch: ${targetCommunes}/${sourceCommunes}, invalid=${invalidTargets}`,
    );
  }
  if (requireComplete && missingValues !== 0) {
    throw new Error(
      `Repair validation found ${missingValues} missing source values`,
    );
  }
  return result;
}

async function inspectOrApplyTargetBatch(
  target: DataSource,
  rows: SparseSourceDay[],
  expectedContext: RepairPublicationContext,
  options: RestoreMissingHistoryOptions,
): Promise<TargetBatchResult> {
  return withSnapshotLock(target, options, async (runner) => {
    await assertExpectedContext(runner, expectedContext, options.apply);
    if (!options.apply) {
      const inspected = await validateTargetBatch(runner, rows, false);
      return {
        sourceCommuneCount: inspected.sourceCommuneCount,
        targetCommuneCount: inspected.targetCommuneCount,
        changedCommuneCount: inspected.changedCommuneCount,
        restoredDayCount: inspected.missingDayCount,
        restoredValueCount: inspected.missingValueCount,
        affectedCommuneCount: 0,
        invalidTargetCount: inspected.invalidTargetCount,
      };
    }
    const [result] = (await runner.query(TARGET_BATCH_SQL, [
      JSON.stringify(rows),
      true,
    ])) as TargetBatchResult[];
    if (!result) throw new Error('Repair batch returned no result');
    const sourceCommunes = databaseCount(
      result.sourceCommuneCount,
      'source commune count',
    );
    const targetCommunes = databaseCount(
      result.targetCommuneCount,
      'target commune count',
    );
    const invalidTargets = databaseCount(
      result.invalidTargetCount,
      'invalid target count',
    );
    if (sourceCommunes !== targetCommunes) {
      throw new Error(
        `Repair target coverage mismatch: ${targetCommunes}/${sourceCommunes}`,
      );
    }
    if (invalidTargets !== 0) {
      throw new Error(`Repair target contains ${invalidTargets} invalid rows`);
    }
    const changed = databaseCount(
      result.changedCommuneCount,
      'changed commune count',
    );
    const affected = databaseCount(
      result.affectedCommuneCount,
      'affected commune count',
    );
    if (affected !== changed) {
      throw new Error(`Repair batch write mismatch: ${affected}/${changed}`);
    }
    await validateTargetBatch(runner, rows, true);
    return result;
  });
}

async function finalValidation(
  source: DataSource,
  target: DataSource,
  expectedContext: RepairPublicationContext,
  options: RestoreMissingHistoryOptions,
): Promise<number> {
  let cursor = '';
  let validatedCommunes = 0;
  while (true) {
    const batch = await readSourceBatch(source, cursor, options);
    if (!batch) break;
    cursor = batch.cursor;
    await withSnapshotLock(target, options, async (runner) => {
      await assertExpectedContext(runner, expectedContext, options.apply);
      await validateTargetBatch(runner, batch.rows, true);
    });
    validatedCommunes += batch.communeCount;
  }
  return validatedCommunes;
}

async function bumpPublicationRevision(
  target: DataSource,
  expectedContext: RepairPublicationContext,
  options: RestoreMissingHistoryOptions,
): Promise<string> {
  return withSnapshotLock(target, options, async (runner) => {
    await assertExpectedContext(runner, expectedContext, true);
    const [row] = unwrapTypeOrmDmlReturningRows<{ revision: string }>(
      await runner.query(
        `
        UPDATE "statistic_publication_state"
        SET revision = revision + 1, "updatedAt" = now()
        WHERE id = 1
          AND revision = $1::bigint
        RETURNING revision::text AS revision
        `,
        [expectedContext.statisticRevision],
      ),
    );
    if (!/^\d+$/.test(row?.revision ?? '')) {
      throw new PublicationContextChangedError(
        'Statistic publication revision changed before repair publication',
      );
    }
    return row.revision;
  });
}

export async function restoreMissingCommuneHistory(
  source: DataSource,
  target: DataSource,
  options: RestoreMissingHistoryOptions,
): Promise<RestoreMissingHistorySummary> {
  await assertDatabaseName(source, options.expectedSourceDatabase, 'Source');
  await assertDatabaseName(target, options.expectedTargetDatabase, 'Target');
  await assertSourceReadOnly(source);

  const expectedContext = await withSnapshotLock(target, options, (runner) =>
    publicationContext(runner, options.apply),
  );
  assertRepairRangeAgainstPublicationContext(options.through, expectedContext);
  const contextToken = encodeRepairExecutionContext(expectedContext, options);
  if (options.apply && options.expectedPublicationContext !== contextToken) {
    throw new PublicationContextChangedError(
      'REPAIR_EXPECTED_PUBLICATION_CONTEXT does not match the target; rerun the dry-run',
    );
  }

  const summary: RestoreMissingHistorySummary = {
    status: options.apply ? 'APPLIED' : 'DRY_RUN',
    sourceCommunes: 0,
    targetCommunes: 0,
    changedCommunes: 0,
    restoredDays: 0,
    restoredValues: 0,
    appliedCommunes: 0,
    batches: 0,
    validatedCommunes: 0,
    publicationContext: contextToken,
    publicationRevision: null,
  };
  let cursor = '';

  while (true) {
    const batch = await readSourceBatch(source, cursor, options);
    if (!batch) break;
    cursor = batch.cursor;
    const result = await inspectOrApplyTargetBatch(
      target,
      batch.rows,
      expectedContext,
      options,
    );
    summary.sourceCommunes += batch.communeCount;
    summary.targetCommunes += databaseCount(
      result.targetCommuneCount,
      'target commune count',
    );
    summary.changedCommunes += databaseCount(
      result.changedCommuneCount,
      'changed commune count',
    );
    summary.restoredDays += databaseCount(
      result.restoredDayCount,
      'restored day count',
    );
    summary.restoredValues += databaseCount(
      result.restoredValueCount,
      'restored value count',
    );
    summary.appliedCommunes += databaseCount(
      result.affectedCommuneCount,
      'affected commune count',
    );
    summary.batches += 1;
    process.stdout.write(
      `[restore-missing-history] cursor=${cursor} scanned=${summary.sourceCommunes} changed=${summary.changedCommunes} restoredValues=${summary.restoredValues}\n`,
    );
  }

  if (summary.sourceCommunes !== summary.targetCommunes) {
    throw new Error(
      `Repair coverage mismatch: ${summary.targetCommunes}/${summary.sourceCommunes}`,
    );
  }
  if (summary.sourceCommunes === 0) {
    throw new Error(
      'Repair source contains no non-null restriction to restore',
    );
  }
  if (
    options.communeCodes !== null &&
    summary.sourceCommunes !== options.communeCodes.length
  ) {
    throw new Error(
      `Repair source filter coverage mismatch: ${summary.sourceCommunes}/${options.communeCodes.length}`,
    );
  }
  if (options.apply && summary.appliedCommunes !== summary.changedCommunes) {
    throw new Error(
      `Repair apply mismatch: ${summary.appliedCommunes}/${summary.changedCommunes}`,
    );
  }
  if (options.apply) {
    summary.validatedCommunes = await finalValidation(
      source,
      target,
      expectedContext,
      options,
    );
    if (summary.validatedCommunes !== summary.sourceCommunes) {
      throw new Error(
        `Repair final validation mismatch: ${summary.validatedCommunes}/${summary.sourceCommunes}`,
      );
    }
    summary.publicationRevision = await bumpPublicationRevision(
      target,
      expectedContext,
      options,
    );
  }
  return summary;
}

function databaseSslEnabled(url: string): boolean {
  const mode = new URL(url).searchParams.get('sslmode')?.toLowerCase();
  return mode !== undefined && !['disable', 'allow', 'prefer'].includes(mode);
}

export function standaloneDataSource(
  url: string,
  readOnly: boolean,
): DataSource {
  const sslEnabled = databaseSslEnabled(url);
  return new DataSource({
    type: 'postgres',
    url,
    ssl: sslEnabled,
    extra: {
      max: 1,
      ...(readOnly ? { options: '-c default_transaction_read_only=on' } : {}),
      ...(sslEnabled ? { ssl: { rejectUnauthorized: false } } : {}),
    },
  });
}

export async function main(): Promise<void> {
  const options = parseRestoreMissingHistoryOptions();
  const source = standaloneDataSource(
    requiredEnvironment(process.env, 'REPAIR_SOURCE_DATABASE_URL'),
    true,
  );
  const target = standaloneDataSource(
    requiredEnvironment(process.env, 'REPAIR_TARGET_DATABASE_URL'),
    !options.apply,
  );
  try {
    await source.initialize();
    await target.initialize();
    const summary = await restoreMissingCommuneHistory(source, target, options);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    if (target.isInitialized) await target.destroy();
    if (source.isInitialized) await source.destroy();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[restore-missing-history] failed');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
