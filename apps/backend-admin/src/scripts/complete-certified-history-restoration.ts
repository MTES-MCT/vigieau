import 'reflect-metadata';
import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import {
  CERTIFIED_HISTORY_SOURCE_RUN_ID as V1_SOURCE_RUN_ID,
  CERTIFIED_HISTORY_V2_CODE_COMMIT as V2_CODE_COMMIT,
  CERTIFIED_HISTORY_V2_CORRECTIONS as V2_CORRECTIONS,
  CERTIFIED_HISTORY_V2_CORRECTION_SOURCE as V2_CORRECTION_SOURCE,
  CERTIFIED_HISTORY_V2_FINAL_BACKUP_SHA256 as V2_FINAL_BACKUP_SHA256,
  CERTIFIED_HISTORY_V2_GEOMETRY_EVIDENCE as V2_GEOMETRY_EVIDENCE,
  CERTIFIED_HISTORY_V2_GEOMETRY_EVIDENCE_FINGERPRINT as V2_GEOMETRY_EVIDENCE_FINGERPRINT,
  CERTIFIED_HISTORY_V2_PARENT_COMMUNE_DELTA as V2_PARENT_DELTA,
  CERTIFIED_HISTORY_V2_PARENT_PROVENANCE_DIGEST as V2_PARENT_PROVENANCE_DIGEST,
  CERTIFIED_HISTORY_V2_PARENT_SOURCE_FINGERPRINT as V2_PARENT_SOURCE_FINGERPRINT,
  CERTIFIED_HISTORY_V2_SOURCE_RUN_ID as V2_SOURCE_RUN_ID,
  CERTIFIED_HISTORY_V2_VARIANT as V2_VARIANT,
} from './build-certified-history-source';

const SNAPSHOT_LOCK = 'vigieau:statistic-commune:snapshot-computation';
const ZONE_PROMOTION_LOCK = 'vigieau:zone-publication-stable-promotion';
const RESTORE_CONFIRMATION = 'RESTORE_CERTIFIED_DEPARTMENT_NATIONAL_HISTORY';
const PROMOTE_CONFIRMATION = 'PROMOTE_CERTIFIED_HISTORY';
const ATTEST_CONFIRMATION = 'ATTEST_CERTIFIED_HISTORY';
const EXPECTED_COMMUNE_COUNT = 34_943;
const EXPECTED_DEPARTMENT_COUNT = 101;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const CERTIFIED_HISTORY_V2_CERTIFIED_MANIFEST = {
  communeCount: 34_943,
  communeDayCount: 1_817_036,
  communeDigest:
    '95e3081ffb5360dc80835ee9cbf218bb5ca17848622b625f05a3d19faca6af40',
  communeHistoryDigest:
    'cbc27b27356244017c067e9829347627d80fe9a225c3742706b2d1b71c52a63b',
  departmentCount: 101,
  departmentDayCount: 5_252,
  departmentDigest:
    '3c80bb8dc3cd50abae598358247a012d8ec787aa40d408b049b7e8d39d4c6097',
  departmentHistoryDigest:
    'e033ca3df6240901c87e99d00469aa1c07da1cab6f1825f0b29069550852e205',
  statisticDayCount: 52,
  statisticDigest:
    '622f931af5db040a330441f98f5872eae0f508a13a3fd695d96b52fae8f8e0d2',
  provenanceDigest:
    'ed51a780628597d085433cfd02dcf5c700027ebc86ff6a0ec9a8b62c02feb0cf',
  sourceFingerprint:
    '18634d2cee5c23198429c034dad3f574ab9f8f94695b4fd5ff184f0a9717091b',
} as const;

interface CertifiedHistoryCompletionScope {
  sourceRunId: string;
  from: string;
  through: string;
  dirtyFrom: string;
  dirtyThrough: string;
}

const CERTIFIED_HISTORY_COMPLETION_SCOPES = [
  {
    sourceRunId: V1_SOURCE_RUN_ID,
    from: '2026-07-11',
    through: '2026-08-27',
    dirtyFrom: '2026-07-11',
    dirtyThrough: '2026-08-27',
  },
  {
    sourceRunId: V2_SOURCE_RUN_ID,
    from: '2026-07-11',
    through: '2026-08-31',
    dirtyFrom: '2026-07-11',
    dirtyThrough: '2026-08-27',
  },
] as const satisfies readonly CertifiedHistoryCompletionScope[];

export type CertifiedHistoryCompletionMode = 'restore' | 'promote' | 'attest';

export interface CertifiedHistoryCompletionOptions {
  mode: CertifiedHistoryCompletionMode;
  apply: boolean;
  from: string;
  through: string;
  sourceRunId: string;
  expectedSourceDatabase: string;
  expectedTargetDatabase: string;
  expectedExecutionContext: string | null;
  batchSize: number;
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  maxRetries: number;
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

export interface CertifiedCompletionSourceScope {
  sourceRunId: string;
  communeCount: number;
  communeDayCount: number;
  departmentCount: number;
  departmentDayCount: number;
  dayCount: number;
  communeDigest: string;
  communeHistoryDigest: string;
  departmentDigest: string;
  departmentHistoryDigest: string;
  statisticDigest: string;
  provenanceDigest: string;
  sourceFingerprint: string;
}

export function assertPinnedV2CertifiedSource(
  source: CertifiedCompletionSourceScope,
): void {
  if (source.sourceRunId !== V2_SOURCE_RUN_ID) return;
  const expected = CERTIFIED_HISTORY_V2_CERTIFIED_MANIFEST;
  if (
    source.communeCount !== expected.communeCount ||
    source.communeDayCount !== expected.communeDayCount ||
    source.communeDigest !== expected.communeDigest ||
    source.communeHistoryDigest !== expected.communeHistoryDigest ||
    source.departmentCount !== expected.departmentCount ||
    source.departmentDayCount !== expected.departmentDayCount ||
    source.departmentDigest !== expected.departmentDigest ||
    source.departmentHistoryDigest !== expected.departmentHistoryDigest ||
    source.dayCount !== expected.statisticDayCount ||
    source.statisticDigest !== expected.statisticDigest ||
    source.provenanceDigest !== expected.provenanceDigest ||
    source.sourceFingerprint !== expected.sourceFingerprint
  ) {
    throw new Error('Certified v2 source does not match the audited manifest');
  }
}

export interface CertifiedDepartmentDay {
  code: string;
  date: string;
  restriction: Record<string, unknown>;
}

export interface CertifiedStatisticDay {
  date: string;
  payload: Record<string, unknown>;
}

export interface CertifiedHistoryCompletionSummary {
  status:
    | 'DRY_RUN'
    | 'APPLIED'
    | 'PROMOTION_READY'
    | 'PROMOTED'
    | 'ATTESTATION_READY'
    | 'ATTESTED';
  mode: CertifiedHistoryCompletionMode;
  from: string;
  through: string;
  sourceRunId: string;
  departments: number;
  departmentDays: number;
  changedDepartments: number;
  changedDepartmentDays: number;
  statisticDays: number;
  changedStatisticDays: number;
  batches: number;
  sourceFingerprint: string;
  provenanceDigest: string;
  executionContext: string;
  auditId: string | null;
  attestationId: string | null;
  publicationRevision: string;
}

interface SourceScopeRow {
  runCount: unknown;
  status: unknown;
  dateFrom: unknown;
  dateThrough: unknown;
  manifestCommuneCount: unknown;
  manifestCommuneDayCount: unknown;
  manifestCommuneDigest: unknown;
  manifestCommuneHistoryDigest: unknown;
  manifestDepartmentCount: unknown;
  manifestDepartmentDayCount: unknown;
  manifestDepartmentDigest: unknown;
  manifestDepartmentHistoryDigest: unknown;
  manifestStatisticDayCount: unknown;
  manifestStatisticDigest: unknown;
  provenanceValid: unknown;
  provenanceDigest: unknown;
  invalidProvenanceCount: unknown;
  departmentCount: unknown;
  departmentDayCount: unknown;
  departmentDigest: unknown;
  departmentHistoryDigest: unknown;
  statisticDayCount: unknown;
  statisticDigest: unknown;
  invalidDepartmentCount: unknown;
  invalidStatisticCount: unknown;
}

interface BatchResult {
  sourceEntityCount: unknown;
  targetEntityCount: unknown;
  sourceDayCount: unknown;
  changedEntityCount: unknown;
  changedDayCount: unknown;
  affectedEntityCount: unknown;
  invalidTargetCount: unknown;
}

interface CertifiedCommuneDigest {
  code: string;
  dayCount: number;
  digest: string;
}

class CurrentPriorityError extends Error {}
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
  if (!value?.trim()) return fallback;
  if (!/^\d+$/.test(value.trim()))
    throw new Error(`${name} must be an integer`);
  const result = Number(value.trim());
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return result;
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
    throw new Error(`${name} is not a valid date`);
  }
  return value;
}

function inclusiveDayCount(from: string, through: string): number {
  return (
    Math.floor(
      (Date.parse(`${through}T00:00:00.000Z`) -
        Date.parse(`${from}T00:00:00.000Z`)) /
        86_400_000,
    ) + 1
  );
}

function count(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
  return parsed;
}

function bool(value: unknown): boolean {
  return value === true || value === 'true' || value === 't';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function normalizeDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}

function assertContextToken(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('CERTIFIED_HISTORY_COMPLETION_EXPECTED_CONTEXT is invalid');
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid context');
    }
  } catch {
    throw new Error('CERTIFIED_HISTORY_COMPLETION_EXPECTED_CONTEXT is invalid');
  }
  return value;
}

function certifiedHistoryCompletionScope(
  options: Pick<
    CertifiedHistoryCompletionOptions,
    'from' | 'through' | 'sourceRunId'
  >,
): CertifiedHistoryCompletionScope {
  const scope = CERTIFIED_HISTORY_COMPLETION_SCOPES.find(
    (candidate) =>
      candidate.sourceRunId === options.sourceRunId &&
      candidate.from === options.from &&
      candidate.through === options.through,
  );
  if (!scope) {
    throw new Error(
      'Certified history completion is restricted to the approved v1 or v2 source run and exact scope',
    );
  }
  return scope;
}

export function parseCertifiedHistoryCompletionOptions(
  environment: NodeJS.ProcessEnv = process.env,
): CertifiedHistoryCompletionOptions {
  const rawMode =
    environment.CERTIFIED_HISTORY_COMPLETION_MODE?.trim().toLowerCase() ||
    'restore';
  if (rawMode !== 'restore' && rawMode !== 'promote' && rawMode !== 'attest') {
    throw new Error(
      'CERTIFIED_HISTORY_COMPLETION_MODE must be restore, promote or attest',
    );
  }
  const mode = rawMode as CertifiedHistoryCompletionMode;
  const apply = parseBoolean(
    'CERTIFIED_HISTORY_COMPLETION_APPLY',
    environment.CERTIFIED_HISTORY_COMPLETION_APPLY,
  );
  const expectedConfirmation =
    mode === 'restore'
      ? RESTORE_CONFIRMATION
      : mode === 'promote'
        ? PROMOTE_CONFIRMATION
        : ATTEST_CONFIRMATION;
  if (
    apply &&
    environment.CERTIFIED_HISTORY_COMPLETION_CONFIRMATION?.trim() !==
      expectedConfirmation
  ) {
    throw new Error(
      `CERTIFIED_HISTORY_COMPLETION_CONFIRMATION must equal ${expectedConfirmation} in ${mode} apply mode`,
    );
  }
  const expectedExecutionContext =
    environment.CERTIFIED_HISTORY_COMPLETION_EXPECTED_CONTEXT?.trim() || null;
  if (apply && expectedExecutionContext === null) {
    throw new Error(
      'CERTIFIED_HISTORY_COMPLETION_EXPECTED_CONTEXT is required in apply mode',
    );
  }
  if (expectedExecutionContext !== null) {
    assertContextToken(expectedExecutionContext);
  }
  const from = assertCivilDate(
    'CERTIFIED_HISTORY_COMPLETION_FROM',
    requiredEnvironment(environment, 'CERTIFIED_HISTORY_COMPLETION_FROM'),
  );
  const through = assertCivilDate(
    'CERTIFIED_HISTORY_COMPLETION_THROUGH',
    requiredEnvironment(environment, 'CERTIFIED_HISTORY_COMPLETION_THROUGH'),
  );
  if (from > through) throw new Error('Certified history range is reversed');
  const sourceRunId = requiredEnvironment(
    environment,
    'CERTIFIED_HISTORY_COMPLETION_SOURCE_RUN_ID',
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(sourceRunId)) {
    throw new Error('CERTIFIED_HISTORY_COMPLETION_SOURCE_RUN_ID is invalid');
  }
  certifiedHistoryCompletionScope({ from, through, sourceRunId });
  const expectedSourceDatabase = requiredEnvironment(
    environment,
    'CERTIFIED_HISTORY_COMPLETION_EXPECTED_SOURCE_DATABASE',
  );
  const expectedTargetDatabase = requiredEnvironment(
    environment,
    'CERTIFIED_HISTORY_COMPLETION_EXPECTED_TARGET_DATABASE',
  );
  if (expectedSourceDatabase === expectedTargetDatabase) {
    throw new Error(
      'Certified history source and target databases must differ',
    );
  }
  return {
    mode,
    apply,
    from,
    through,
    sourceRunId,
    expectedSourceDatabase,
    expectedTargetDatabase,
    expectedExecutionContext,
    batchSize: parseInteger(
      'CERTIFIED_HISTORY_COMPLETION_BATCH_SIZE',
      environment.CERTIFIED_HISTORY_COMPLETION_BATCH_SIZE,
      10,
      1,
      25,
    ),
    lockTimeoutMs: parseInteger(
      'CERTIFIED_HISTORY_COMPLETION_LOCK_TIMEOUT_MS',
      environment.CERTIFIED_HISTORY_COMPLETION_LOCK_TIMEOUT_MS,
      250,
      50,
      5_000,
    ),
    statementTimeoutMs: parseInteger(
      'CERTIFIED_HISTORY_COMPLETION_STATEMENT_TIMEOUT_MS',
      environment.CERTIFIED_HISTORY_COMPLETION_STATEMENT_TIMEOUT_MS,
      5_000,
      500,
      5_000,
    ),
    maxRetries: parseInteger(
      'CERTIFIED_HISTORY_COMPLETION_MAX_RETRIES',
      environment.CERTIFIED_HISTORY_COMPLETION_MAX_RETRIES,
      5,
      1,
      20,
    ),
  };
}

export const CERTIFIED_COMPLETION_SOURCE_SCOPE_SQL = `
  WITH parent_candidate AS MATERIALIZED (
    SELECT
      parent.*,
      encode(sha256(convert_to(parent.provenance::text, 'UTF8')), 'hex')
        AS "provenanceDigest",
      encode(sha256(convert_to(
        '{"communeDigest":"' || parent."communeDigest" ||
        '","communeHistoryDigest":"' || parent."communeHistoryDigest" ||
        '","departmentDigest":"' || parent."departmentDigest" ||
        '","departmentHistoryDigest":"' ||
          parent."departmentHistoryDigest" ||
        '","statisticDigest":"' || parent."statisticDigest" ||
        '","provenanceDigest":"' ||
          encode(sha256(convert_to(parent.provenance::text, 'UTF8')), 'hex') ||
        '"}',
        'UTF8'
      )), 'hex') AS "sourceFingerprint"
    FROM "certified_history_source_run" parent
    WHERE parent.id = '${V1_SOURCE_RUN_ID}'
      AND parent.status = 'certified'
      AND parent."dateFrom" = '2026-07-11'::date
      AND parent."dateThrough" = '2026-08-27'::date
      AND jsonb_typeof(parent.provenance) = 'object'
      AND parent.provenance ->> 'method' =
          'scheduled-logical-backup-before-mutable-replay'
      AND parent.provenance ->> 'communeDailyObjectKeyPolicy' =
          'exact-date-SOU-SUP-AEP'
  ), parent_run AS MATERIALIZED (
    SELECT parent.*
    FROM parent_candidate parent
    WHERE parent."provenanceDigest" = '${V2_PARENT_PROVENANCE_DIGEST}'
      AND parent."sourceFingerprint" = '${V2_PARENT_SOURCE_FINGERPRINT}'
  ), source_run AS MATERIALIZED (
    SELECT
      run.*,
      CASE
        WHEN run.id = '${V1_SOURCE_RUN_ID}' THEN
          jsonb_typeof(run.provenance) = 'object'
          AND run.provenance ->> 'method' =
              'scheduled-logical-backup-before-mutable-replay'
          AND run.provenance ->> 'communeDailyObjectKeyPolicy' =
              'exact-date-SOU-SUP-AEP'
          AND jsonb_typeof(run.provenance -> 'dateSources') = 'object'
        WHEN run.id = '${V2_SOURCE_RUN_ID}' THEN
          jsonb_typeof(run.provenance) = 'object'
          AND run.provenance ->> 'method' =
              '${V2_VARIANT}'
          AND run.provenance -> 'planVersion' = '2'::jsonb
          AND run.provenance ->> 'parentSourceRunId' =
              '${V1_SOURCE_RUN_ID}'
          AND run.provenance ->> 'codeCommit' = '${V2_CODE_COMMIT}'
          AND run.provenance ->> 'digestPolicy' =
              'postgresql-sha256-jsonb-text-v1'
          AND run.provenance ->> 'communeDailyObjectKeyPolicy' =
              'exact-date-SOU-SUP-AEP'
          AND run.provenance ->> 'departmentPayloadPolicy' =
              'complete-daily-restriction-object'
          AND run.provenance ->> 'statisticPayloadPolicy' =
              'complete-to-jsonb-row'
          AND run.provenance - ARRAY[
            'method', 'planVersion', 'parentSourceRunId',
            'parentSourceFingerprint', 'parentDigests', 'codeCommit',
            'corrections', 'parentDelta', 'correctionSource',
            'geometryEvidence', 'digestPolicy',
            'communeDailyObjectKeyPolicy', 'departmentPayloadPolicy',
            'statisticPayloadPolicy', 'dateSources'
          ]::text[] = '{}'::jsonb
          AND (SELECT COUNT(*) FROM parent_run) = 1
          AND run.provenance -> 'parentDigests' = (
            SELECT jsonb_build_object(
              'communeDigest', parent."communeDigest",
              'communeHistoryDigest', parent."communeHistoryDigest",
              'departmentDigest', parent."departmentDigest",
              'departmentHistoryDigest', parent."departmentHistoryDigest",
              'statisticDigest', parent."statisticDigest",
              'provenanceDigest', parent."provenanceDigest"
            )
            FROM parent_run parent
          )
          AND run.provenance ->> 'parentSourceFingerprint' = (
            SELECT parent."sourceFingerprint" FROM parent_run parent
          )
          AND run.provenance -> 'corrections' =
              $v2_corrections$${JSON.stringify(V2_CORRECTIONS)}$v2_corrections$::jsonb
          AND run.provenance -> 'parentDelta' =
              $v2_parent_delta$${JSON.stringify(V2_PARENT_DELTA)}$v2_parent_delta$::jsonb
          AND run.provenance -> 'correctionSource' =
              $v2_correction_source$${JSON.stringify(V2_CORRECTION_SOURCE)}$v2_correction_source$::jsonb
          AND run.provenance -> 'geometryEvidence' =
              $v2_geometry_evidence$${JSON.stringify(V2_GEOMETRY_EVIDENCE)}$v2_geometry_evidence$::jsonb
          AND run.provenance -> 'correctionSource' ->>
                'geometryEvidenceFingerprint' =
              '${V2_GEOMETRY_EVIDENCE_FINGERPRINT}'
          AND run."communeCount" =
              ${CERTIFIED_HISTORY_V2_CERTIFIED_MANIFEST.communeCount}
          AND run."communeDayCount" =
              ${CERTIFIED_HISTORY_V2_CERTIFIED_MANIFEST.communeDayCount}
          AND run."communeDigest" =
              '${CERTIFIED_HISTORY_V2_CERTIFIED_MANIFEST.communeDigest}'
          AND run."communeHistoryDigest" =
              '${CERTIFIED_HISTORY_V2_CERTIFIED_MANIFEST.communeHistoryDigest}'
          AND run."departmentCount" =
              ${CERTIFIED_HISTORY_V2_CERTIFIED_MANIFEST.departmentCount}
          AND run."departmentDayCount" =
              ${CERTIFIED_HISTORY_V2_CERTIFIED_MANIFEST.departmentDayCount}
          AND run."departmentDigest" =
              '${CERTIFIED_HISTORY_V2_CERTIFIED_MANIFEST.departmentDigest}'
          AND run."departmentHistoryDigest" =
              '${CERTIFIED_HISTORY_V2_CERTIFIED_MANIFEST.departmentHistoryDigest}'
          AND run."statisticDayCount" =
              ${CERTIFIED_HISTORY_V2_CERTIFIED_MANIFEST.statisticDayCount}
          AND run."statisticDigest" =
              '${CERTIFIED_HISTORY_V2_CERTIFIED_MANIFEST.statisticDigest}'
          AND encode(
                sha256(convert_to(run.provenance::text, 'UTF8')),
                'hex'
              ) = '${CERTIFIED_HISTORY_V2_CERTIFIED_MANIFEST.provenanceDigest}'
          AND encode(sha256(convert_to(
            '{"communeDigest":"' || run."communeDigest" ||
            '","communeHistoryDigest":"' || run."communeHistoryDigest" ||
            '","departmentDigest":"' || run."departmentDigest" ||
            '","departmentHistoryDigest":"' ||
              run."departmentHistoryDigest" ||
            '","statisticDigest":"' || run."statisticDigest" ||
            '","provenanceDigest":"' ||
              encode(
                sha256(convert_to(run.provenance::text, 'UTF8')),
                'hex'
              ) ||
            '"}',
            'UTF8'
          )), 'hex') =
              '${CERTIFIED_HISTORY_V2_CERTIFIED_MANIFEST.sourceFingerprint}'
          AND CASE
            WHEN jsonb_typeof(run.provenance -> 'dateSources') = 'object'
              THEN (
                SELECT COUNT(*)
                FROM jsonb_object_keys(
                  run.provenance -> 'dateSources'
                ) source_date(value)
              ) = ($2::date - $1::date + 1)
            ELSE false
          END
          AND NOT EXISTS (
            SELECT 1
            FROM generate_series(
              $1::date, $2::date, '1 day'::interval
            ) expected_date(value)
            WHERE CASE
              WHEN expected_date.value::date <= '2026-08-27'::date
                THEN
                  run.provenance -> 'dateSources' ->
                      expected_date.value::date::text ->> 'backupId'
                    IS DISTINCT FROM (
                      SELECT parent.provenance -> 'dateSources' ->
                        expected_date.value::date::text ->> 'backupId'
                      FROM parent_run parent
                    )
                  OR run.provenance -> 'dateSources' ->
                      expected_date.value::date::text ->> 'dumpSha256'
                    IS DISTINCT FROM (
                      SELECT parent.provenance -> 'dateSources' ->
                        expected_date.value::date::text ->> 'dumpSha256'
                      FROM parent_run parent
                    )
              ELSE
                run.provenance -> 'dateSources' ->
                    expected_date.value::date::text ->> 'backupId'
                  IS DISTINCT FROM '${V2_CORRECTION_SOURCE.backupId}'
                OR run.provenance -> 'dateSources' ->
                    expected_date.value::date::text ->> 'dumpSha256'
                  IS DISTINCT FROM '${V2_FINAL_BACKUP_SHA256}'
            END
          )
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_each(
              CASE
                WHEN jsonb_typeof(run.provenance -> 'dateSources') = 'object'
                  THEN run.provenance -> 'dateSources'
                ELSE '{}'::jsonb
              END
            ) date_source(date, payload)
            WHERE jsonb_typeof(date_source.payload) IS DISTINCT FROM 'object'
               OR NOT (date_source.payload ?& ARRAY[
                 'backupId', 'dumpSha256', 'communeHistoryDigest',
                 'departmentHistoryDigest', 'statisticDigest'
               ])
               OR date_source.payload - ARRAY[
                 'backupId', 'dumpSha256', 'communeHistoryDigest',
                 'departmentHistoryDigest', 'statisticDigest',
                 'correctionSource'
               ]::text[] <> '{}'::jsonb
               OR (
                 date_source.date < '2026-07-17'
                 AND date_source.payload ? 'correctionSource'
               )
               OR (
                 date_source.date >= '2026-07-17'
                 AND date_source.payload -> 'correctionSource'
                   IS DISTINCT FROM jsonb_build_object(
                     'method', '${V2_CORRECTION_SOURCE.method}',
                     'backupId', '${V2_CORRECTION_SOURCE.backupId}',
                     'dumpSha256', '${V2_CORRECTION_SOURCE.dumpSha256}',
                     'codeCommit', '${V2_CODE_COMMIT}',
                     'departmentCodes', CASE
                       WHEN date_source.date = '2026-08-31'
                         THEN '["15","64","68"]'::jsonb
                       ELSE '["64"]'::jsonb
                     END,
                     'correctionIds', CASE
                       WHEN date_source.date = '2026-08-12'
                         THEN '["pa64-level-37316","d64-late-import-37695"]'::jsonb
                       WHEN date_source.date = '2026-08-31'
                         THEN '["pa64-level-37316","d15-late-import-37897","d68-late-import-37898"]'::jsonb
                       ELSE '["pa64-level-37316"]'::jsonb
                     END,
                     'geometryEvidenceFingerprint',
                       '${V2_GEOMETRY_EVIDENCE_FINGERPRINT}',
                     'correctedOutputDigestMethod',
                       '${V2_CORRECTION_SOURCE.correctedOutputDigests.method}'
                   )
               )
               OR date_source.payload ->> 'dumpSha256' !~ '^[a-f0-9]{64}$'
               OR date_source.payload ->> 'communeHistoryDigest'
                    !~ '^[a-f0-9]{64}$'
               OR date_source.payload ->> 'departmentHistoryDigest'
                    !~ '^[a-f0-9]{64}$'
               OR date_source.payload ->> 'statisticDigest'
                    !~ '^[a-f0-9]{64}$'
          )
        ELSE false
      END
        AS "provenanceValid",
      encode(sha256(convert_to(run.provenance::text, 'UTF8')), 'hex')
        AS "provenanceDigest"
    FROM "certified_history_source_run" run
    WHERE run.id = $3::text
  ), department_days AS MATERIALIZED (
    SELECT day.*
    FROM "certified_history_departement_day" day
    WHERE day."sourceRunId" = $3::text
      AND day.date BETWEEN $1::date AND $2::date
  ), department_coverage AS MATERIALIZED (
    SELECT
      day.code,
      COUNT(*)::integer AS "dayCount",
      COUNT(DISTINCT day.date)::integer AS "distinctDayCount",
      encode(sha256(convert_to(string_agg(
        jsonb_build_array(day.date::text, day.restriction)::text,
        E'\\n' ORDER BY day.date
      ), 'UTF8')), 'hex') AS digest,
      bool_or(
        day.code !~ '^[0-9A-Z]{2,3}$'
        OR jsonb_typeof(day.restriction) <> 'object'
        OR day.restriction ->> 'date' IS DISTINCT FROM day.date::text
      ) AS invalid
    FROM department_days day
    GROUP BY day.code
  ), statistic_days AS MATERIALIZED (
    SELECT day.*
    FROM "certified_history_statistic_day" day
    WHERE day."sourceRunId" = $3::text
      AND day.date BETWEEN $1::date AND $2::date
  ), provenance_errors AS MATERIALIZED (
    SELECT day.date
    FROM (
      SELECT date, "backupId", "dumpSha256"
      FROM "certified_history_commune_day"
      WHERE "sourceRunId" = $3::text
        AND $3::text = '${V2_SOURCE_RUN_ID}'
        AND date BETWEEN $1::date AND $2::date
      GROUP BY date, "backupId", "dumpSha256"
      UNION ALL
      SELECT date, "backupId", "dumpSha256"
      FROM department_days
      GROUP BY date, "backupId", "dumpSha256"
      UNION ALL
      SELECT date, "backupId", "dumpSha256"
      FROM statistic_days
      GROUP BY date, "backupId", "dumpSha256"
    ) day
    CROSS JOIN source_run run
    WHERE run.provenance -> 'dateSources' -> day.date::text
            ->> 'backupId' IS DISTINCT FROM day."backupId"
       OR run.provenance -> 'dateSources' -> day.date::text
            ->> 'dumpSha256' IS DISTINCT FROM day."dumpSha256"
       OR day."dumpSha256" !~ '^[a-f0-9]{64}$'
  )
  SELECT
    (SELECT COUNT(*) FROM source_run)::integer AS "runCount",
    (SELECT status FROM source_run) AS status,
    (SELECT "dateFrom"::text FROM source_run) AS "dateFrom",
    (SELECT "dateThrough"::text FROM source_run) AS "dateThrough",
    (SELECT "communeCount" FROM source_run) AS "manifestCommuneCount",
    (SELECT "communeDayCount" FROM source_run) AS "manifestCommuneDayCount",
    (SELECT "communeDigest" FROM source_run) AS "manifestCommuneDigest",
    (SELECT "communeHistoryDigest" FROM source_run)
      AS "manifestCommuneHistoryDigest",
    (SELECT "departmentCount" FROM source_run)
      AS "manifestDepartmentCount",
    (SELECT "departmentDayCount" FROM source_run)
      AS "manifestDepartmentDayCount",
    (SELECT "departmentDigest" FROM source_run)
      AS "manifestDepartmentDigest",
    (SELECT "departmentHistoryDigest" FROM source_run)
      AS "manifestDepartmentHistoryDigest",
    (SELECT "statisticDayCount" FROM source_run)
      AS "manifestStatisticDayCount",
    (SELECT "statisticDigest" FROM source_run) AS "manifestStatisticDigest",
    (SELECT "provenanceValid" FROM source_run) AS "provenanceValid",
    (SELECT "provenanceDigest" FROM source_run) AS "provenanceDigest",
    (SELECT COUNT(*) FROM provenance_errors)::integer
      AS "invalidProvenanceCount",
    COUNT(*)::integer AS "departmentCount",
    COALESCE(SUM(coverage."dayCount"), 0)::bigint AS "departmentDayCount",
    encode(sha256(convert_to(string_agg(
      coverage.code, E'\\n' ORDER BY coverage.code
    ), 'UTF8')), 'hex') AS "departmentDigest",
    encode(sha256(convert_to(string_agg(
      jsonb_build_array(coverage.code, coverage.digest)::text,
      E'\\n' ORDER BY coverage.code
    ), 'UTF8')), 'hex') AS "departmentHistoryDigest",
    (SELECT COUNT(*) FROM statistic_days)::integer AS "statisticDayCount",
    (SELECT encode(sha256(convert_to(string_agg(
      jsonb_build_array(day.date::text, day.payload)::text,
      E'\\n' ORDER BY day.date
    ), 'UTF8')), 'hex') FROM statistic_days day) AS "statisticDigest",
    COUNT(*) FILTER (WHERE
      coverage.invalid
      OR coverage."dayCount" <> ($2::date - $1::date + 1)
      OR coverage."distinctDayCount" <> ($2::date - $1::date + 1)
    )::integer AS "invalidDepartmentCount",
    (SELECT COUNT(*) FROM statistic_days day WHERE
      jsonb_typeof(day.payload) <> 'object'
      OR day.payload ->> 'date' IS DISTINCT FROM day.date::text
    )::integer AS "invalidStatisticCount"
  FROM department_coverage coverage
`;

export const CERTIFIED_COMPLETION_SOURCE_DEPARTMENT_BATCH_SQL = `
  WITH batch_codes AS MATERIALIZED (
    SELECT DISTINCT day.code
    FROM "certified_history_departement_day" day
    WHERE day."sourceRunId" = $5::text
      AND day.code > $1::text
      AND day.date BETWEEN $2::date AND $3::date
    ORDER BY day.code
    LIMIT $4::integer
  )
  SELECT day.code, day.date::text AS date, day.restriction
  FROM batch_codes batch
  JOIN "certified_history_departement_day" day
    ON day.code = batch.code
   AND day."sourceRunId" = $5::text
   AND day.date BETWEEN $2::date AND $3::date
  ORDER BY day.code, day.date
`;

export const CERTIFIED_COMPLETION_SOURCE_STATISTIC_BATCH_SQL = `
  SELECT day.date::text AS date, day.payload
  FROM "certified_history_statistic_day" day
  WHERE day."sourceRunId" = $3::text
    AND day.date BETWEEN $1::date AND $2::date
  ORDER BY day.date
`;

const DEPARTMENT_PLAN_CTES = `
  source_input AS MATERIALIZED (
    SELECT code, date, restriction
    FROM jsonb_to_recordset($1::jsonb) source(
      code text, date date, restriction jsonb
    )
  ), source_codes AS MATERIALIZED (
    SELECT DISTINCT code FROM source_input
  ), target_statistics AS MATERIALIZED (
    SELECT statistic.id, departement.code,
           statistic.restrictions AS "originalRestrictions"
    FROM source_codes source
    JOIN departement ON departement.code = source.code
    JOIN statistic_departement statistic
      ON statistic."departementId" = departement.id
  ), target_days AS MATERIALIZED (
    SELECT target.id, target.code, item.ordinality, item.value,
           item.value ->> 'date' AS date
    FROM target_statistics target
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(target."originalRestrictions") = 'array'
          THEN target."originalRestrictions"
        ELSE '[]'::jsonb
      END
    ) WITH ORDINALITY item(value, ordinality)
  ), invalid_targets AS MATERIALIZED (
    SELECT target.id FROM target_statistics target
    WHERE jsonb_typeof(target."originalRestrictions") <> 'array'
    UNION
    SELECT day.id FROM target_days day
    WHERE jsonb_typeof(day.value) <> 'object'
      OR day.date IS NULL
      OR day.date !~ '^\\d{4}-\\d{2}-\\d{2}$'
    UNION
    SELECT day.id FROM target_days day GROUP BY day.id, day.date
    HAVING COUNT(*) <> 1
    UNION
    SELECT day.id
    FROM target_days day
    GROUP BY day.id
    HAVING array_agg(day.date ORDER BY day.ordinality) <>
           array_agg(day.date ORDER BY day.date)
  ), prepared AS MATERIALIZED (
    SELECT
      target.id,
      target.code,
      target."originalRestrictions",
      COALESCE((
        SELECT jsonb_agg(value ORDER BY section, ordering)
        FROM (
          SELECT 0 AS section, day.ordinality::bigint AS ordering, day.value
          FROM target_days day
          WHERE day.id = target.id AND day.date < $2::date::text
          UNION ALL
          SELECT 1, row_number() OVER (ORDER BY source.date)::bigint,
                 source.restriction
          FROM source_input source WHERE source.code = target.code
          UNION ALL
          SELECT 2, day.ordinality::bigint, day.value
          FROM target_days day
          WHERE day.id = target.id AND day.date > $3::date::text
        ) ordered
      ), '[]'::jsonb) AS restrictions
    FROM target_statistics target
    WHERE NOT EXISTS (
      SELECT 1 FROM invalid_targets invalid WHERE invalid.id = target.id
    )
  ), changes AS MATERIALIZED (
    SELECT prepared.*
    FROM prepared
    WHERE prepared.restrictions IS DISTINCT FROM
          prepared."originalRestrictions"
  ), changed_days AS MATERIALIZED (
    SELECT source.code, source.date
    FROM source_input source
    LEFT JOIN target_statistics target ON target.code = source.code
    LEFT JOIN target_days day
      ON day.id = target.id AND day.date = source.date::text
    WHERE day.value IS DISTINCT FROM source.restriction
  )
`;

export const CERTIFIED_COMPLETION_INSPECT_DEPARTMENT_BATCH_SQL = `
  WITH ${DEPARTMENT_PLAN_CTES}
  SELECT
    (SELECT COUNT(*) FROM source_codes)::integer AS "sourceEntityCount",
    (SELECT COUNT(*) FROM target_statistics)::integer AS "targetEntityCount",
    (SELECT COUNT(*) FROM source_input)::integer AS "sourceDayCount",
    (SELECT COUNT(*) FROM changes)::integer AS "changedEntityCount",
    (SELECT COUNT(*) FROM changed_days)::integer AS "changedDayCount",
    0::integer AS "affectedEntityCount",
    (SELECT COUNT(*) FROM invalid_targets)::integer AS "invalidTargetCount"
`;

export const CERTIFIED_COMPLETION_APPLY_DEPARTMENT_BATCH_SQL = `
  WITH ${DEPARTMENT_PLAN_CTES}, updated AS (
    UPDATE statistic_departement statistic
    SET restrictions = changes.restrictions
    FROM changes
    WHERE statistic.id = changes.id
      AND statistic.restrictions IS NOT DISTINCT FROM
          changes."originalRestrictions"
    RETURNING statistic.id
  )
  SELECT
    (SELECT COUNT(*) FROM source_codes)::integer AS "sourceEntityCount",
    (SELECT COUNT(*) FROM target_statistics)::integer AS "targetEntityCount",
    (SELECT COUNT(*) FROM source_input)::integer AS "sourceDayCount",
    (SELECT COUNT(*) FROM changes)::integer AS "changedEntityCount",
    (SELECT COUNT(*) FROM changed_days)::integer AS "changedDayCount",
    (SELECT COUNT(*) FROM updated)::integer AS "affectedEntityCount",
    (SELECT COUNT(*) FROM invalid_targets)::integer AS "invalidTargetCount"
`;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function buildStatisticInspectionSql(): string {
  return `
    WITH source_input AS MATERIALIZED (
      SELECT date, payload - 'id' AS payload
      FROM jsonb_to_recordset($1::jsonb) source(date date, payload jsonb)
    ), target_rows AS MATERIALIZED (
      SELECT statistic.id, statistic.date,
             to_jsonb(statistic) - 'id' AS "originalPayload"
      FROM statistic
      WHERE statistic.date IN (SELECT date FROM source_input)
    ), changes AS MATERIALIZED (
      SELECT source.date
      FROM source_input source
      LEFT JOIN target_rows target ON target.date = source.date
      WHERE target."originalPayload" IS DISTINCT FROM source.payload
    )
    SELECT
      (SELECT COUNT(*) FROM source_input)::integer AS "sourceEntityCount",
      (SELECT COUNT(*) FROM target_rows)::integer AS "targetEntityCount",
      (SELECT COUNT(*) FROM source_input)::integer AS "sourceDayCount",
      (SELECT COUNT(*) FROM changes)::integer AS "changedEntityCount",
      (SELECT COUNT(*) FROM changes)::integer AS "changedDayCount",
      0::integer AS "affectedEntityCount",
      0::integer AS "invalidTargetCount"
  `;
}

export function buildStatisticApplySql(columns: string[]): string {
  if (
    !columns.includes('date') ||
    columns.includes('id') ||
    columns.length < 2
  ) {
    throw new Error('Target statistic columns are not restorable');
  }
  const identifiers = columns.map(quoteIdentifier);
  const selected = columns.map(
    (column) => `desired.${quoteIdentifier(column)}`,
  );
  const updated = columns
    .filter((column) => column !== 'date')
    .map(
      (column) =>
        `${quoteIdentifier(column)} = desired.${quoteIdentifier(column)}`,
    );
  const conflict = columns
    .filter((column) => column !== 'date')
    .map(
      (column) =>
        `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`,
    );
  return `
    WITH source_input AS MATERIALIZED (
      SELECT date, payload - 'id' AS payload
      FROM jsonb_to_recordset($1::jsonb) source(date date, payload jsonb)
    ), desired AS MATERIALIZED (
      SELECT record.*
      FROM source_input source
      CROSS JOIN LATERAL jsonb_populate_record(
        NULL::statistic, source.payload
      ) record
    ), target_before AS MATERIALIZED (
      SELECT statistic.id, statistic.date,
             to_jsonb(statistic) - 'id' AS "originalPayload"
      FROM statistic
      WHERE statistic.date IN (SELECT date FROM source_input)
    ), changed AS MATERIALIZED (
      SELECT source.date, source.payload
      FROM source_input source
      LEFT JOIN target_before target ON target.date = source.date
      WHERE target."originalPayload" IS DISTINCT FROM source.payload
    ), updated AS (
      UPDATE statistic target
      SET ${updated.join(', ')}
      FROM desired, target_before before, changed
      WHERE target.id = before.id
        AND desired.date = before.date
        AND changed.date = before.date
        AND to_jsonb(target) - 'id' IS NOT DISTINCT FROM
            before."originalPayload"
      RETURNING target.date
    ), inserted AS (
      INSERT INTO statistic (${identifiers.join(', ')})
      SELECT ${selected.join(', ')}
      FROM desired
      JOIN changed ON changed.date = desired.date
      WHERE NOT EXISTS (
        SELECT 1 FROM target_before target WHERE target.date = desired.date
      )
      ON CONFLICT (date) DO UPDATE SET ${conflict.join(', ')}
      WHERE false
      RETURNING date
    )
    SELECT
      (SELECT COUNT(*) FROM source_input)::integer AS "sourceEntityCount",
      (SELECT COUNT(*) FROM target_before)::integer AS "targetEntityCount",
      (SELECT COUNT(*) FROM source_input)::integer AS "sourceDayCount",
      (SELECT COUNT(*) FROM changed)::integer AS "changedEntityCount",
      (SELECT COUNT(*) FROM changed)::integer AS "changedDayCount",
      ((SELECT COUNT(*) FROM updated) +
       (SELECT COUNT(*) FROM inserted))::integer AS "affectedEntityCount",
      0::integer AS "invalidTargetCount"
  `;
}

export const CERTIFIED_COMPLETION_CONTEXT_SQL = `
  SELECT
    statistic_state.revision::text AS "statisticRevision",
    statistic_state."currentPublishedDate"::text AS "currentPublishedDate",
    statistic_state."historicPublishedThrough"::text
      AS "historicPublishedThrough",
    statistic_state."historicDirtyFrom"::text AS "historicDirtyFrom",
    statistic_state."historicDirtyThrough"::text AS "historicDirtyThrough",
    source_state.revision::text AS "sourceRevision",
    source_state."publicRevision"::text AS "sourcePublicRevision",
    source_state."legacyDualWrite" AS "legacyDualWrite",
    config."historicComputeEpoch"::text AS "historicComputeEpoch",
    config."historicBackfillGlobalEpoch"::text
      AS "historicBackfillGlobalEpoch",
    config."computeMapDate"::text AS "computeMapDate",
    config."computeStatsDate"::text AS "computeStatsDate",
    (
      EXISTS (
        SELECT 1 FROM "current_zone_recompute_request" request
        WHERE request."currentPending"
          OR EXISTS (
            SELECT 1 FROM unnest(request."pendingScheduledDates") due(date)
            WHERE due.date <= (now() AT TIME ZONE 'Europe/Paris')::date
          )
      )
      OR EXISTS (
        SELECT 1 FROM "external_publication_run" run
        WHERE run.status = 'running'
          AND run."jobKey" IN (
            'compute:national-daily', 'compute:historic-catchup'
          )
      )
      OR EXISTS (
        SELECT 1 FROM "statistic_commune_snapshot" snapshot
        WHERE snapshot.status IN ('running', 'ready', 'partial')
      )
      OR EXISTS (
        SELECT 1 FROM "historic_backfill_run" run
        WHERE run.status IN ('preparing', 'running', 'paused')
      )
    ) AS "priorityActive"
  FROM "statistic_publication_state" statistic_state
  CROSS JOIN "zone_publication_source_state" source_state
  CROSS JOIN config
  WHERE statistic_state.id = 1
    AND source_state.id = 1
    AND config.id = 1
`;

export function certifiedCompletionContextSql(lock: boolean): string {
  return `${CERTIFIED_COMPLETION_CONTEXT_SQL}${
    lock ? ' FOR SHARE OF statistic_state, source_state, config' : ''
  }`;
}

export function certifiedCompletionRepairAuditSql(lock: boolean): string {
  return `
    SELECT repair.*
    FROM "certified_history_repair_audit" repair
    WHERE repair."sourceRunId" = $1::text
      AND repair."dateFrom" = $2::date
      AND repair."dateThrough" = $3::date
      AND repair."activationKind" = 'statistics-only'
      AND repair."communeCount" = $4::integer
      AND repair."departmentCount" = $5::integer
      AND repair."dayCount" = $6::integer
      AND repair."communeHistoryDigest" = $7::text
      AND repair."departmentHistoryDigest" = $8::text
      AND repair."statisticDigest" = $9::text
      AND repair."provenanceDigest" = $10::text
    ${lock ? 'FOR SHARE' : ''}
  `;
}

function normalizeContext(
  row: Record<string, unknown>,
): RepairPublicationContext {
  return {
    statisticRevision: String(row.statisticRevision),
    currentPublishedDate: normalizeDate(row.currentPublishedDate),
    historicPublishedThrough: normalizeDate(row.historicPublishedThrough),
    historicDirtyFrom: normalizeDate(row.historicDirtyFrom),
    historicDirtyThrough: normalizeDate(row.historicDirtyThrough),
    sourceRevision: String(row.sourceRevision),
    sourcePublicRevision: String(row.sourcePublicRevision),
    legacyDualWrite: bool(row.legacyDualWrite),
    historicComputeEpoch: String(row.historicComputeEpoch),
    historicBackfillGlobalEpoch: String(row.historicBackfillGlobalEpoch),
    computeMapDate: normalizeDate(row.computeMapDate),
    computeStatsDate: normalizeDate(row.computeStatsDate),
  };
}

async function publicationContext(
  runner: QueryRunner,
  lock: boolean,
): Promise<RepairPublicationContext> {
  const [row] = (await runner.query(
    certifiedCompletionContextSql(lock),
  )) as Array<Record<string, unknown>>;
  if (!row) throw new Error('Statistic publication context is unavailable');
  if (bool(row.priorityActive)) {
    throw new CurrentPriorityError(
      'Current statistic or historic publication work has priority',
    );
  }
  return normalizeContext(row);
}

export function assertRangeMatchesDirtyWindow(
  options: Pick<
    CertifiedHistoryCompletionOptions,
    'from' | 'through' | 'sourceRunId' | 'mode'
  >,
  context: RepairPublicationContext,
): void {
  const scope = certifiedHistoryCompletionScope(options);
  if (
    context.historicDirtyFrom === null ||
    context.historicDirtyThrough === null
  ) {
    throw new Error('Certified completion requires a non-null dirty window');
  }
  if (context.historicDirtyFrom !== scope.dirtyFrom) {
    throw new Error(
      `Certified range must start at dirty window ${context.historicDirtyFrom}`,
    );
  }
  const expectedDirtyThrough =
    options.mode === 'attest' ? scope.through : scope.dirtyThrough;
  if (context.historicDirtyThrough !== expectedDirtyThrough) {
    throw new Error(
      `Certified ${options.mode} requires dirty window ${scope.dirtyFrom}/${expectedDirtyThrough}`,
    );
  }
  if (
    context.currentPublishedDate === null ||
    scope.through >= context.currentPublishedDate
  ) {
    throw new Error('Certified range must precede the current publication');
  }
}

export function encodeCertifiedCompletionContext(
  options: CertifiedHistoryCompletionOptions,
  context: RepairPublicationContext,
  source: CertifiedCompletionSourceScope,
): string {
  return Buffer.from(
    JSON.stringify({
      mode: options.mode,
      publication: context,
      scope: {
        from: options.from,
        through: options.through,
        sourceRunId: options.sourceRunId,
        sourceDatabase: options.expectedSourceDatabase,
        targetDatabase: options.expectedTargetDatabase,
        sourceFingerprint: source.sourceFingerprint,
        provenanceDigest: source.provenanceDigest,
      },
    }),
    'utf8',
  ).toString('base64url');
}

async function assertDatabaseName(
  database: DataSource,
  expected: string,
  label: string,
): Promise<void> {
  const [row] = (await database.query(
    'SELECT current_database() AS database',
  )) as Array<{ database: string }>;
  if (row?.database !== expected) {
    throw new Error(
      `${label} database mismatch: ${row?.database ?? 'missing'}/${expected}`,
    );
  }
}

async function assertReadOnlySession(
  database: DataSource | QueryRunner,
  label: string,
): Promise<void> {
  const [row] = (await database.query(
    `SELECT current_setting('default_transaction_read_only') AS "readOnly"`,
  )) as Array<{ readOnly: string }>;
  if (row?.readOnly !== 'on') {
    throw new Error(`${label} database session is not read-only`);
  }
}

export function validateCertifiedDepartmentDays(
  rows: Array<Record<string, unknown>>,
  from: string,
  through: string,
): CertifiedDepartmentDay[] {
  const expectedDays = inclusiveDayCount(from, through);
  const coverage = new Map<string, Set<string>>();
  const result = rows.map((row) => {
    const code = typeof row.code === 'string' ? row.code : '';
    const date = normalizeDate(row.date) ?? '';
    if (!/^[0-9A-Z]{2,3}$/.test(code)) {
      throw new Error(`Invalid certified department code ${code}`);
    }
    assertCivilDate(`certified department date ${code}`, date);
    if (date < from || date > through) {
      throw new Error(
        `Certified department day ${code}/${date} is out of range`,
      );
    }
    if (
      !row.restriction ||
      typeof row.restriction !== 'object' ||
      Array.isArray(row.restriction)
    ) {
      throw new Error(`Invalid certified department payload ${code}/${date}`);
    }
    const restriction = row.restriction as Record<string, unknown>;
    if (restriction.date !== date) {
      throw new Error(
        `Certified department payload date mismatch ${code}/${date}`,
      );
    }
    const dates = coverage.get(code) ?? new Set<string>();
    if (dates.has(date)) {
      throw new Error(`Duplicate certified department day ${code}/${date}`);
    }
    dates.add(date);
    coverage.set(code, dates);
    return { code, date, restriction };
  });
  for (const [code, dates] of coverage) {
    if (dates.size !== expectedDays) {
      throw new Error(
        `Certified department coverage mismatch ${code}: ${dates.size}/${expectedDays}`,
      );
    }
  }
  return result;
}

export function validateCertifiedStatisticDays(
  rows: Array<Record<string, unknown>>,
  from: string,
  through: string,
  targetColumns: string[],
): CertifiedStatisticDay[] {
  const requiredKeys = [...targetColumns].sort();
  const dates = new Set<string>();
  const result = rows.map((row) => {
    const date = normalizeDate(row.date) ?? '';
    assertCivilDate('certified statistic date', date);
    if (date < from || date > through || dates.has(date)) {
      throw new Error(`Invalid or duplicate certified statistic day ${date}`);
    }
    if (
      !row.payload ||
      typeof row.payload !== 'object' ||
      Array.isArray(row.payload)
    ) {
      throw new Error(`Invalid certified statistic payload ${date}`);
    }
    const rawPayload = row.payload as Record<string, unknown>;
    const payload = Object.fromEntries(
      Object.entries(rawPayload).filter(([key]) => key !== 'id'),
    );
    if (payload.date !== date) {
      throw new Error(`Certified statistic payload date mismatch ${date}`);
    }
    if (
      JSON.stringify(Object.keys(payload).sort()) !==
      JSON.stringify(requiredKeys)
    ) {
      throw new Error(`Certified statistic payload columns mismatch ${date}`);
    }
    dates.add(date);
    return { date, payload: rawPayload };
  });
  if (dates.size !== inclusiveDayCount(from, through)) {
    throw new Error(
      `Certified statistic coverage mismatch: ${dates.size}/${inclusiveDayCount(from, through)}`,
    );
  }
  return result;
}

async function readSourceScope(
  runner: QueryRunner,
  options: CertifiedHistoryCompletionOptions,
): Promise<CertifiedCompletionSourceScope> {
  const [row] = (await runner.query(CERTIFIED_COMPLETION_SOURCE_SCOPE_SQL, [
    options.from,
    options.through,
    options.sourceRunId,
  ])) as SourceScopeRow[];
  if (!row) throw new Error('Certified completion source scope is unavailable');
  const days = inclusiveDayCount(options.from, options.through);
  const communeCount = count(row.manifestCommuneCount, 'commune count');
  const communeDayCount = count(
    row.manifestCommuneDayCount,
    'commune day count',
  );
  const departmentCount = count(row.departmentCount, 'department count');
  const departmentDayCount = count(
    row.departmentDayCount,
    'department day count',
  );
  const statisticDayCount = count(row.statisticDayCount, 'statistic day count');
  const communeDigest = digest(row.manifestCommuneDigest, 'commune digest');
  const communeHistoryDigest = digest(
    row.manifestCommuneHistoryDigest,
    'commune history digest',
  );
  const departmentDigest = digest(row.departmentDigest, 'department digest');
  const departmentHistoryDigest = digest(
    row.departmentHistoryDigest,
    'department history digest',
  );
  const statisticDigest = digest(row.statisticDigest, 'statistic digest');
  const provenanceDigest = digest(row.provenanceDigest, 'provenance digest');
  if (
    count(row.runCount, 'source run count') !== 1 ||
    row.status !== 'certified' ||
    row.dateFrom !== options.from ||
    row.dateThrough !== options.through ||
    !bool(row.provenanceValid) ||
    count(row.invalidProvenanceCount, 'provenance error count') !== 0
  ) {
    throw new Error('Certified source run or provenance is invalid');
  }
  if (
    communeCount !== EXPECTED_COMMUNE_COUNT ||
    communeDayCount !== EXPECTED_COMMUNE_COUNT * days ||
    departmentCount !== EXPECTED_DEPARTMENT_COUNT ||
    departmentDayCount !== EXPECTED_DEPARTMENT_COUNT * days ||
    statisticDayCount !== days ||
    count(row.manifestDepartmentCount, 'manifest department count') !==
      departmentCount ||
    count(row.manifestDepartmentDayCount, 'manifest department day count') !==
      departmentDayCount ||
    count(row.manifestStatisticDayCount, 'manifest statistic day count') !==
      statisticDayCount ||
    row.manifestDepartmentDigest !== departmentDigest ||
    row.manifestDepartmentHistoryDigest !== departmentHistoryDigest ||
    row.manifestStatisticDigest !== statisticDigest ||
    count(row.invalidDepartmentCount, 'invalid department count') !== 0 ||
    count(row.invalidStatisticCount, 'invalid statistic count') !== 0
  ) {
    throw new Error('Certified source coverage or manifest digest mismatch');
  }
  const sourceFingerprint = sha256(
    JSON.stringify({
      communeDigest,
      communeHistoryDigest,
      departmentDigest,
      departmentHistoryDigest,
      statisticDigest,
      provenanceDigest,
    }),
  );
  const source = {
    sourceRunId: options.sourceRunId,
    communeCount,
    communeDayCount,
    departmentCount,
    departmentDayCount,
    dayCount: statisticDayCount,
    communeDigest,
    communeHistoryDigest,
    departmentDigest,
    departmentHistoryDigest,
    statisticDigest,
    provenanceDigest,
    sourceFingerprint,
  };
  assertPinnedV2CertifiedSource(source);
  return source;
}

async function statisticColumns(target: DataSource): Promise<string[]> {
  const rows = (await target.query(`
    SELECT attribute.attname AS name
    FROM pg_attribute attribute
    WHERE attribute.attrelid = 'statistic'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attname <> 'id'
    ORDER BY attribute.attnum
  `)) as Array<{ name: string }>;
  const columns = rows.map(({ name }) => name);
  if (!columns.includes('date') || columns.length < 2) {
    throw new Error('Target statistic schema is incomplete');
  }
  return columns;
}

function retryable(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    ['55P03', '57014', '40P01', '40001'].includes(
      String((error as { code: unknown }).code),
    ),
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function withTargetSnapshotLock<T>(
  target: DataSource,
  options: CertifiedHistoryCompletionOptions,
  operation: (runner: QueryRunner) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxRetries; attempt += 1) {
    const runner = target.createQueryRunner();
    let locked = false;
    try {
      await runner.connect();
      const [lock] = (await runner.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [SNAPSHOT_LOCK],
      )) as Array<{ locked: unknown }>;
      locked = bool(lock?.locked);
      if (!locked) throw new CurrentPriorityError('Snapshot lock is busy');
      return await operation(runner);
    } catch (error) {
      lastError = error;
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      if (!(error instanceof CurrentPriorityError) && !retryable(error)) {
        throw error;
      }
      if (attempt === options.maxRetries) throw error;
    } finally {
      if (locked) {
        await runner.query('SELECT pg_advisory_unlock(hashtext($1))', [
          SNAPSHOT_LOCK,
        ]);
      }
      await runner.release();
    }
    await delay(Math.min(1_000, 50 * 2 ** (attempt - 1)));
  }
  throw lastError;
}

export async function withShortRunnerTransaction<T>(
  runner: QueryRunner,
  options: CertifiedHistoryCompletionOptions,
  operation: () => Promise<T>,
): Promise<T> {
  await runner.startTransaction('SERIALIZABLE');
  try {
    await runner.query("SELECT set_config('lock_timeout', $1, true)", [
      `${options.lockTimeoutMs}ms`,
    ]);
    await runner.query("SELECT set_config('statement_timeout', $1, true)", [
      `${options.statementTimeoutMs}ms`,
    ]);
    const result = await operation();
    await runner.commitTransaction();
    return result;
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  }
}

async function withShortTargetTransaction<T>(
  target: DataSource,
  options: CertifiedHistoryCompletionOptions,
  operation: (runner: QueryRunner) => Promise<T>,
): Promise<T> {
  return withTargetSnapshotLock(target, options, (runner) =>
    withShortRunnerTransaction(runner, options, () => operation(runner)),
  );
}

async function assertContext(
  runner: QueryRunner,
  expected: RepairPublicationContext,
  lock: boolean,
): Promise<void> {
  const actual = await publicationContext(runner, lock);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new PublicationContextChangedError(
      'Publication context changed; rerun the dry-run',
    );
  }
}

function validateBatchResult(
  row: BatchResult | undefined,
  expectedEntities: number,
  expectedDays: number,
  apply: boolean,
  label: string,
  targetMustExist = false,
): { changedEntities: number; changedDays: number } {
  if (!row) throw new Error(`${label} batch returned no result`);
  const sourceEntities = count(row.sourceEntityCount, `${label} source count`);
  const targetEntities = count(row.targetEntityCount, `${label} target count`);
  const sourceDays = count(row.sourceDayCount, `${label} source day count`);
  const changedEntities = count(
    row.changedEntityCount,
    `${label} changed count`,
  );
  const changedDays = count(row.changedDayCount, `${label} changed day count`);
  const affected = count(row.affectedEntityCount, `${label} affected count`);
  const invalid = count(
    row.invalidTargetCount,
    `${label} invalid target count`,
  );
  if (
    sourceEntities !== expectedEntities ||
    targetEntities > sourceEntities ||
    (targetMustExist && targetEntities !== sourceEntities) ||
    sourceDays !== expectedDays ||
    invalid !== 0 ||
    (apply && affected !== changedEntities) ||
    (!apply && affected !== 0)
  ) {
    throw new Error(
      `${label} batch invariant mismatch: source=${sourceEntities}/${sourceDays}, target=${targetEntities}, invalid=${invalid}, changed=${changedEntities}, affected=${affected}`,
    );
  }
  return { changedEntities, changedDays };
}

async function exactDepartmentBatch(
  target: DataSource,
  rows: CertifiedDepartmentDay[],
  context: RepairPublicationContext,
  options: CertifiedHistoryCompletionOptions,
): Promise<{ changedEntities: number; changedDays: number }> {
  const entityCount = new Set(rows.map(({ code }) => code)).size;
  return withShortTargetTransaction(target, options, async (runner) => {
    await assertContext(runner, context, options.apply);
    const [result] = (await runner.query(
      options.apply
        ? CERTIFIED_COMPLETION_APPLY_DEPARTMENT_BATCH_SQL
        : CERTIFIED_COMPLETION_INSPECT_DEPARTMENT_BATCH_SQL,
      [JSON.stringify(rows), options.from, options.through],
    )) as BatchResult[];
    return validateBatchResult(
      result,
      entityCount,
      rows.length,
      options.apply,
      'Department',
      true,
    );
  });
}

async function exactStatisticBatch(
  target: DataSource,
  rows: CertifiedStatisticDay[],
  columns: string[],
  context: RepairPublicationContext,
  options: CertifiedHistoryCompletionOptions,
): Promise<{ changedEntities: number; changedDays: number }> {
  return withShortTargetTransaction(target, options, async (runner) => {
    await assertContext(runner, context, options.apply);
    const [result] = (await runner.query(
      options.apply
        ? buildStatisticApplySql(columns)
        : buildStatisticInspectionSql(),
      [JSON.stringify(rows)],
    )) as BatchResult[];
    return validateBatchResult(
      result,
      rows.length,
      rows.length,
      options.apply,
      'National statistic',
    );
  });
}

async function validateTargetDepartmentExact(
  runner: QueryRunner,
  sourceRows: CertifiedDepartmentDay[],
  options: CertifiedHistoryCompletionOptions,
): Promise<void> {
  const [row] = (await runner.query(
    CERTIFIED_COMPLETION_INSPECT_DEPARTMENT_BATCH_SQL,
    [JSON.stringify(sourceRows), options.from, options.through],
  )) as BatchResult[];
  const result = validateBatchResult(
    row,
    new Set(sourceRows.map(({ code }) => code)).size,
    sourceRows.length,
    false,
    'Department validation',
    true,
  );
  if (result.changedEntities !== 0 || result.changedDays !== 0) {
    throw new Error(
      'Department target is not exactly equal to certified source',
    );
  }
}

async function validateTargetStatisticExact(
  runner: QueryRunner,
  sourceRows: CertifiedStatisticDay[],
): Promise<void> {
  const [row] = (await runner.query(buildStatisticInspectionSql(), [
    JSON.stringify(sourceRows),
  ])) as BatchResult[];
  const result = validateBatchResult(
    row,
    sourceRows.length,
    sourceRows.length,
    false,
    'National statistic validation',
  );
  if (result.changedEntities !== 0 || result.changedDays !== 0) {
    throw new Error(
      'National statistic target is not exactly equal to certified source',
    );
  }
}

export function chunkCertifiedValidationRows<T>(
  rows: T[],
  batchSize: number,
): T[][] {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error('Certified validation batch size must be positive');
  }
  const batches: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    batches.push(rows.slice(offset, offset + batchSize));
  }
  return batches;
}

const SOURCE_COMMUNE_DIGEST_BATCH_SQL = `
  WITH codes AS MATERIALIZED (
    SELECT DISTINCT day.code
    FROM "certified_history_commune_day" day
    WHERE day."sourceRunId" = $5::text
      AND day.code > $1::text
      AND day.date BETWEEN $2::date AND $3::date
    ORDER BY day.code
    LIMIT $4::integer
  )
  SELECT day.code,
         COUNT(*)::integer AS "dayCount",
         encode(sha256(convert_to(string_agg(
           jsonb_build_array(
             day.date::text, day."SOU", day."SUP", day."AEP"
           )::text, E'\\n' ORDER BY day.date
         ), 'UTF8')), 'hex') AS digest
  FROM codes
  JOIN "certified_history_commune_day" day
    ON day.code = codes.code
   AND day."sourceRunId" = $5::text
   AND day.date BETWEEN $2::date AND $3::date
  GROUP BY day.code
  ORDER BY day.code
`;

export const TARGET_COMMUNE_DIGEST_VALIDATION_SQL = `
  WITH source_input AS MATERIALIZED (
    SELECT code, "dayCount", digest
    FROM jsonb_to_recordset($1::jsonb) source(
      code text, "dayCount" integer, digest text
    )
  ), target_statistics AS MATERIALIZED (
    SELECT commune.code, statistic.restrictions
    FROM source_input source
    JOIN commune ON commune.code = source.code
    JOIN statistic_commune statistic
      ON statistic."communeId" = commune.id
  ), target_days AS MATERIALIZED (
    SELECT target.code, item.value, item.value ->> 'date' AS date
    FROM target_statistics target
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(COALESCE(target.restrictions, '[]'::jsonb)) =
             'array'
          THEN COALESCE(target.restrictions, '[]'::jsonb)
        ELSE '[]'::jsonb
      END
    ) item(value)
  ), invalid_targets AS MATERIALIZED (
    SELECT target.code
    FROM target_statistics target
    WHERE jsonb_typeof(COALESCE(target.restrictions, '[]'::jsonb)) <>
          'array'
    UNION
    SELECT day.code
    FROM target_days day
    WHERE jsonb_typeof(day.value) <> 'object'
       OR day.date IS NULL
       OR day.date !~ '^\\d{4}-\\d{2}-\\d{2}$'
    UNION
    SELECT day.code
    FROM target_days day
    GROUP BY day.code, day.date
    HAVING COUNT(*) <> 1
  ), target AS MATERIALIZED (
    SELECT item.code,
           COUNT(item.value)::integer AS "dayCount",
           COUNT(*) FILTER (
             WHERE CASE
               WHEN jsonb_typeof(item.value) IS DISTINCT FROM 'object'
                 THEN true
               ELSE
                 NOT (item.value ?& ARRAY['date', 'SOU', 'SUP', 'AEP'])
                 OR (
                   item.value - ARRAY['date', 'SOU', 'SUP', 'AEP']::text[]
                 ) <> '{}'::jsonb
             END
           )::integer AS "invalidShapeCount",
           encode(sha256(convert_to(string_agg(
             jsonb_build_array(
               item.value ->> 'date', item.value ->> 'SOU',
               item.value ->> 'SUP', item.value ->> 'AEP'
             )::text, E'\\n' ORDER BY item.value ->> 'date'
           ), 'UTF8')), 'hex') AS digest
    FROM target_days item
    WHERE item.date BETWEEN $2::date::text AND $3::date::text
    GROUP BY item.code
  )
  SELECT
    (SELECT COUNT(*) FROM source_input)::integer AS "sourceCount",
    (SELECT COUNT(*) FROM target)::integer AS "targetCount",
    (SELECT COUNT(*)
     FROM source_input source
     LEFT JOIN target ON target.code = source.code
     WHERE target."dayCount" IS DISTINCT FROM source."dayCount"
        OR target."invalidShapeCount" IS DISTINCT FROM 0
        OR EXISTS (
          SELECT 1 FROM invalid_targets invalid
          WHERE invalid.code = source.code
        )
        OR target.digest IS DISTINCT FROM source.digest)::integer
      AS "mismatchCount"
`;

async function readCertifiedCommuneDigests(
  source: QueryRunner,
  options: CertifiedHistoryCompletionOptions,
  sourceScope: CertifiedCompletionSourceScope,
): Promise<CertifiedCommuneDigest[][]> {
  let cursor = '';
  let validated = 0;
  let firstDigestEntry = true;
  const communeDigest = createHash('sha256');
  const communeHistoryDigest = createHash('sha256');
  const batches: CertifiedCommuneDigest[][] = [];
  while (true) {
    const rows = (await source.query(SOURCE_COMMUNE_DIGEST_BATCH_SQL, [
      cursor,
      options.from,
      options.through,
      500,
      options.sourceRunId,
    ])) as CertifiedCommuneDigest[];
    if (rows.length === 0) break;
    for (const row of rows) {
      if (
        !/^[0-9A-Z]{5}$/.test(row.code) ||
        count(row.dayCount, `commune ${row.code} day count`) !==
          sourceScope.dayCount ||
        !SHA256_PATTERN.test(row.digest)
      ) {
        throw new Error(`Invalid certified commune coverage ${row.code}`);
      }
      const separator = firstDigestEntry ? '' : '\n';
      communeDigest.update(`${separator}${row.code}`);
      communeHistoryDigest.update(
        `${separator}["${row.code}", "${row.digest}"]`,
      );
      firstDigestEntry = false;
    }
    batches.push(...chunkCertifiedValidationRows(rows, options.batchSize));
    cursor = rows.at(-1)!.code;
    validated += rows.length;
  }
  if (validated !== EXPECTED_COMMUNE_COUNT) {
    throw new Error(
      `Commune validation coverage mismatch: ${validated}/${EXPECTED_COMMUNE_COUNT}`,
    );
  }
  if (
    communeDigest.digest('hex') !== sourceScope.communeDigest ||
    communeHistoryDigest.digest('hex') !== sourceScope.communeHistoryDigest
  ) {
    throw new Error(
      'Certified commune source digest changed after certification',
    );
  }
  return batches;
}

async function validateAllCommunesExact(
  target: QueryRunner,
  batches: CertifiedCommuneDigest[][],
  options: CertifiedHistoryCompletionOptions,
  expectedContext: RepairPublicationContext,
): Promise<number> {
  let validated = 0;
  for (const rows of batches) {
    await assertContext(target, expectedContext, false);
    const [result] = (await target.query(TARGET_COMMUNE_DIGEST_VALIDATION_SQL, [
      JSON.stringify(rows),
      options.from,
      options.through,
    ])) as Array<Record<string, unknown>>;
    const cursor = rows.at(-1)!.code;
    if (
      count(result?.sourceCount, 'commune validation source count') !==
        rows.length ||
      count(result?.targetCount, 'commune validation target count') !==
        rows.length ||
      count(result?.mismatchCount, 'commune validation mismatch count') !== 0
    ) {
      throw new Error(`Commune target mismatch near ${cursor}`);
    }
    validated += rows.length;
  }
  if (validated !== EXPECTED_COMMUNE_COUNT) {
    throw new Error(
      `Commune target validation mismatch: ${validated}/${EXPECTED_COMMUNE_COUNT}`,
    );
  }
  return validated;
}

export const CERTIFIED_COMPLETION_PROMOTION_PREFLIGHT_SQL = `
  WITH context AS MATERIALIZED (
    SELECT
      statistic_state.revision,
      statistic_state."currentPublishedDate",
      statistic_state."historicDirtyFrom",
      statistic_state."historicDirtyThrough",
      config."computeMapDate",
      config."computeStatsDate",
      config."historicComputeEpoch",
      config."historicBackfillGlobalEpoch",
      source_state."publicRevision" AS "sourceRevision",
      zone_state."activePublicationId"
    FROM "statistic_publication_state" statistic_state
    CROSS JOIN config
    CROSS JOIN "zone_publication_source_state" source_state
    CROSS JOIN "zone_publication_state" zone_state
    WHERE statistic_state.id = 1 AND config.id = 1
      AND source_state.id = 1 AND zone_state.id = 1
  )
  SELECT
    (context."currentPublishedDate" =
      (now() AT TIME ZONE 'Europe/Paris')::date) AS "currentDateFresh",
    (context."historicDirtyFrom" = $4::date AND
      context."historicDirtyThrough" = $5::date) AS "dirtyRangeExact",
    context."computeMapDate"::text AS "computeMapDate",
    context."computeStatsDate"::text AS "computeStatsDate",
    EXISTS (
      SELECT 1
      FROM "zone_publication" active
      WHERE active.id = context."activePublicationId"
        AND active.status = 'active'
        AND active."sourceRevision" = context."sourceRevision"
        AND (active."sourceComputedAt" AT TIME ZONE 'Europe/Paris')::date =
            context."currentPublishedDate"
    ) AS "activeCurrentFresh",
    EXISTS (
      SELECT 1 FROM "statistic_commune_snapshot" snapshot
      WHERE snapshot."snapshotDate" = context."currentPublishedDate"
        AND snapshot.scope = 'national'
        AND snapshot.status = 'completed'
        AND snapshot."sourceRevision" = context."sourceRevision"
        AND snapshot."expectedCommuneCount" = $3::integer
        AND snapshot."processedCommuneCount" = $3::integer
    ) AS "currentSnapshotFresh",
    NOT EXISTS (
      SELECT 1 FROM "statistic_commune_snapshot" snapshot
      WHERE snapshot."snapshotDate" NOT BETWEEN $1::date AND $2::date
        AND snapshot.scope <> 'bootstrap'
        AND (
          snapshot.status <> 'completed'
          OR snapshot."processedCommuneCount" <>
             snapshot."expectedCommuneCount"
        )
    ) AS "outsideSnapshotsComplete",
    NOT EXISTS (
      SELECT 1 FROM "external_publication_run" run WHERE run.status = 'running'
    ) AND NOT EXISTS (
      SELECT 1 FROM "historic_backfill_run" run
      WHERE run.status IN ('preparing', 'running', 'paused')
    ) AS "jobsIdle"
  FROM context
`;

interface PromotionPreflight {
  currentDateFresh: unknown;
  dirtyRangeExact: unknown;
  computeMapDate: string | null;
  computeStatsDate: string | null;
  activeCurrentFresh: unknown;
  currentSnapshotFresh: unknown;
  outsideSnapshotsComplete: unknown;
  jobsIdle: unknown;
}

export function assertPromotionPreflight(row: PromotionPreflight): void {
  const blockers: string[] = [];
  if (!bool(row.currentDateFresh)) blockers.push('current date is not fresh');
  if (!bool(row.dirtyRangeExact)) blockers.push('dirty range changed');
  if (!bool(row.activeCurrentFresh))
    blockers.push('active current map is stale');
  if (!bool(row.currentSnapshotFresh)) {
    blockers.push('current national statistic snapshot is stale');
  }
  if (!bool(row.outsideSnapshotsComplete)) {
    blockers.push('snapshots outside the certified range are incomplete');
  }
  if (!bool(row.jobsIdle)) blockers.push('publication jobs are active');
  if (blockers.length > 0) {
    throw new Error(
      `Certified statistic promotion is blocked to protect current production: ${blockers.join('; ')}`,
    );
  }
}

export const CERTIFIED_COMPLETION_PROMOTION_SQL = `
  WITH audit_insert AS MATERIALIZED (
    INSERT INTO "certified_history_repair_audit" (
      id, "sourceRunId", "dateFrom", "dateThrough",
      "communeCount", "departmentCount", "dayCount",
      "communeHistoryDigest", "departmentHistoryDigest",
      "statisticDigest", "provenanceDigest", "sourceRevision",
      "historicComputeEpoch", "historicBackfillGlobalEpoch",
      "activationKind", "mapManifestRunId", "publicationRevisionBefore",
      "publicationRevisionAfter", "publicationContext"
    ) VALUES (
      $1::uuid, $2::text, $3::date, $4::date,
      $5::integer, $6::integer, $7::integer,
      $8::text, $9::text, $10::text, $11::text, $12::bigint,
      $13::bigint, $14::bigint, 'statistics-only', NULL, $15::bigint,
      $15::bigint + 1, $16::jsonb
    )
    ON CONFLICT ("sourceRunId", "dateFrom", "dateThrough") DO NOTHING
    RETURNING id
  ), normalized_existing AS MATERIALIZED (
    UPDATE "statistic_commune_snapshot" snapshot
    SET status = 'completed',
        "expectedCommuneCount" = CASE
          WHEN snapshot.scope = 'national' THEN $5::integer
          ELSE snapshot."expectedCommuneCount"
        END,
        "processedCommuneCount" = CASE
          WHEN snapshot.scope = 'national' THEN $5::integer
          ELSE snapshot."expectedCommuneCount"
        END,
        "completedAt" = COALESCE(snapshot."completedAt", now()),
        "lastError" = NULL,
        "sourceRevision" = NULL,
        "certifiedHistoryRepairId" = audit_insert.id,
        "updatedAt" = now()
    FROM audit_insert
    WHERE snapshot."snapshotDate" BETWEEN $3::date AND $4::date
      AND snapshot.scope <> 'bootstrap'
    -- Promotion reaches this statement only after all 34,943 commune payloads
    -- have been compared with the certified source. Every existing non-bootstrap
    -- scope is therefore a certified subset of that exact national restoration.
    RETURNING snapshot."snapshotDate", snapshot.scope, snapshot.status,
              snapshot."expectedCommuneCount",
              snapshot."processedCommuneCount",
              snapshot."certifiedHistoryRepairId"
  ), inserted_national AS MATERIALIZED (
    INSERT INTO "statistic_commune_snapshot" (
      "snapshotDate", scope, status, "expectedCommuneCount",
      "processedCommuneCount", "startedAt", "completedAt", "lastError",
      "sourceRevision", "createdAt", "updatedAt",
      "certifiedHistoryRepairId"
    )
    SELECT day::date, 'national', 'completed', $5::integer, $5::integer,
           now(), now(), NULL, NULL, now(), now(), audit_insert.id
    FROM audit_insert
    CROSS JOIN generate_series($3::date, $4::date, '1 day'::interval) day
    WHERE NOT EXISTS (
      SELECT 1 FROM "statistic_commune_snapshot" snapshot
      WHERE snapshot."snapshotDate" = day::date
        AND snapshot.scope = 'national'
    )
    RETURNING "snapshotDate", scope, status, "expectedCommuneCount",
              "processedCommuneCount", "certifiedHistoryRepairId"
  ), snapshot_coverage AS MATERIALIZED (
    SELECT COUNT(DISTINCT repaired."snapshotDate") FILTER (
             WHERE repaired.scope = 'national'
           )::integer AS count,
           COUNT(*) FILTER (
             WHERE repaired.status IS DISTINCT FROM 'completed'
                OR repaired."processedCommuneCount" IS DISTINCT FROM
                   repaired."expectedCommuneCount"
                OR repaired."certifiedHistoryRepairId" IS DISTINCT FROM
                   audit_insert.id
                OR (
                 repaired.scope = 'national' AND (
                 repaired."expectedCommuneCount" IS DISTINCT FROM $5::integer
                 OR repaired."processedCommuneCount" IS DISTINCT FROM
                    $5::integer
                 )
               )
           )::integer AS invalid
    FROM (
      SELECT "snapshotDate", scope, status, "expectedCommuneCount",
             "processedCommuneCount", "certifiedHistoryRepairId"
      FROM normalized_existing
      UNION ALL
      SELECT "snapshotDate", scope, status, "expectedCommuneCount",
             "processedCommuneCount", "certifiedHistoryRepairId"
      FROM inserted_national
    ) repaired
    CROSS JOIN audit_insert
  ), publication_update AS MATERIALIZED (
    UPDATE "statistic_publication_state" publication
    SET revision = publication.revision + 1,
        "historicDirtyThrough" = $4::date,
        "updatedAt" = now()
    FROM audit_insert, snapshot_coverage
    WHERE publication.id = 1
      AND publication.revision = $15::bigint
      AND publication."historicDirtyFrom" = $17::date
      AND publication."historicDirtyThrough" = $18::date
      AND snapshot_coverage.count = $7::integer
      AND snapshot_coverage.invalid = 0
    RETURNING publication.revision
  )
  SELECT
    (SELECT COUNT(*) FROM audit_insert)::integer AS "auditCount",
    (SELECT count FROM snapshot_coverage) AS "snapshotDayCount",
    (SELECT invalid FROM snapshot_coverage) AS "invalidSnapshotCount",
    (SELECT revision::text FROM publication_update) AS revision
`;

export const CERTIFIED_COMPLETION_INITIAL_ATTESTATION_SQL = `
  INSERT INTO "certified_history_repair_attestation" (
    id, "repairId", "attestedThroughEpoch", "sourceRevision",
    "statisticRevision", "communeHistoryDigest",
    "departmentHistoryDigest", "statisticDigest", "provenanceDigest",
    context
  )
  SELECT
    $1::uuid, repair.id, config."historicComputeEpoch",
    repair."sourceRevision", publication.revision,
    repair."communeHistoryDigest", repair."departmentHistoryDigest",
    repair."statisticDigest", repair."provenanceDigest",
    repair."publicationContext" || $5::jsonb
  FROM "certified_history_repair_audit" repair
  CROSS JOIN "config" config
  CROSS JOIN "statistic_publication_state" publication
  WHERE repair.id = $2::uuid
    AND config.id = 1
    AND config."historicComputeEpoch" = $3::bigint
    AND publication.id = 1
    AND publication.revision = $4::bigint
  RETURNING id::text AS "attestationId",
            "statisticRevision"::text AS revision
`;

export const CERTIFIED_COMPLETION_PROMOTION_REVOCATION_GUARD_SQL = `
  SELECT set_config(
    'vigieau.certified_history_revocation_in_progress', $1, true
  )
`;

export const CERTIFIED_COMPLETION_ATTESTATION_RETAG_SQL = `
  WITH retagged AS MATERIALIZED (
    UPDATE "statistic_commune_snapshot" snapshot
    SET "certifiedHistoryRepairId" = $1::uuid,
        "updatedAt" = now()
    WHERE snapshot."snapshotDate" BETWEEN $2::date AND $3::date
      AND snapshot.scope = 'national'
      AND snapshot.status = 'completed'
      AND snapshot."expectedCommuneCount" = $4::integer
      AND snapshot."processedCommuneCount" = $4::integer
      AND snapshot."sourceRevision" IS NULL
      AND snapshot."certifiedHistoryRepairId" IS NULL
    RETURNING snapshot."snapshotDate"
  )
  SELECT COUNT(*)::integer AS "retaggedSnapshotCount"
  FROM retagged
`;

export const CERTIFIED_COMPLETION_ATTESTATION_SQL = `
  WITH snapshot_coverage AS MATERIALIZED (
    SELECT
      COUNT(DISTINCT snapshot."snapshotDate")::integer AS count,
      COUNT(*) FILTER (
        WHERE snapshot.status IS DISTINCT FROM 'completed'
           OR snapshot."expectedCommuneCount" IS DISTINCT FROM $3::integer
           OR snapshot."processedCommuneCount" IS DISTINCT FROM $3::integer
           OR snapshot."sourceRevision" IS NOT NULL
           OR snapshot."certifiedHistoryRepairId" IS DISTINCT FROM $4::uuid
      )::integer AS invalid
    FROM "statistic_commune_snapshot" snapshot
    WHERE snapshot."snapshotDate" BETWEEN $1::date AND $2::date
      AND snapshot.scope = 'national'
  ), publication_update AS MATERIALIZED (
    UPDATE "statistic_publication_state" publication
    SET revision = publication.revision + 1,
        "updatedAt" = now()
    FROM snapshot_coverage
    WHERE publication.id = 1
      AND publication.revision = $5::bigint
      AND snapshot_coverage.count = ($2::date - $1::date + 1)
      AND snapshot_coverage.invalid = 0
    RETURNING publication.revision
  )
  SELECT
    snapshot_coverage.count AS "snapshotDayCount",
    snapshot_coverage.invalid AS "invalidSnapshotCount",
    (SELECT revision::text FROM publication_update) AS revision
  FROM snapshot_coverage
`;

async function promote(
  source: QueryRunner,
  target: DataSource,
  sourceScope: CertifiedCompletionSourceScope,
  departmentBatches: CertifiedDepartmentDay[][],
  statisticRows: CertifiedStatisticDay[],
  expectedContext: RepairPublicationContext,
  executionContext: string,
  options: CertifiedHistoryCompletionOptions,
): Promise<{
  auditId: string | null;
  attestationId: string | null;
  revision: string;
}> {
  const communeDigestBatches = await readCertifiedCommuneDigests(
    source,
    options,
    sourceScope,
  );
  const runner = target.createQueryRunner();
  let snapshotLocked = false;
  let transactionStarted = false;
  try {
    await runner.connect();
    const [snapshotLock] = (await runner.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [SNAPSHOT_LOCK],
    )) as Array<{ locked: unknown }>;
    snapshotLocked = bool(snapshotLock?.locked);
    if (!snapshotLocked) {
      throw new CurrentPriorityError('Snapshot lock is busy');
    }
    await runner.query("SELECT set_config('statement_timeout', $1, false)", [
      `${options.statementTimeoutMs}ms`,
    ]);
    await assertContext(runner, expectedContext, false);
    // All statistic writers use SNAPSHOT_LOCK. Keeping it for the complete
    // verification makes the following short atomic activation a valid CAS
    // without holding millions of rows in one transaction.
    await validateAllCommunesExact(
      runner,
      communeDigestBatches,
      options,
      expectedContext,
    );
    for (const rows of departmentBatches) {
      await assertContext(runner, expectedContext, false);
      await validateTargetDepartmentExact(runner, rows, options);
    }
    for (
      let offset = 0;
      offset < statisticRows.length;
      offset += options.batchSize
    ) {
      await assertContext(runner, expectedContext, false);
      await validateTargetStatisticExact(
        runner,
        statisticRows.slice(offset, offset + options.batchSize),
      );
    }
    await assertContext(runner, expectedContext, false);

    await runner.startTransaction('SERIALIZABLE');
    transactionStarted = true;
    await runner.query("SELECT set_config('lock_timeout', $1, true)", [
      `${options.lockTimeoutMs}ms`,
    ]);
    await runner.query("SELECT set_config('statement_timeout', $1, true)", [
      `${options.statementTimeoutMs}ms`,
    ]);
    const [zoneLock] = (await runner.query(
      `SELECT pg_try_advisory_xact_lock(
         hashtext('vigieau'), hashtext('zone-compute-global')
       ) AS locked`,
    )) as Array<{ locked: unknown }>;
    const [promotionLock] = (await runner.query(
      'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
      [ZONE_PROMOTION_LOCK],
    )) as Array<{ locked: unknown }>;
    if (!bool(zoneLock?.locked) || !bool(promotionLock?.locked)) {
      throw new CurrentPriorityError('Zone publication lock is busy');
    }
    await assertContext(runner, expectedContext, options.apply);
    const [preflight] = (await runner.query(
      CERTIFIED_COMPLETION_PROMOTION_PREFLIGHT_SQL,
      [
        options.from,
        options.through,
        EXPECTED_COMMUNE_COUNT,
        expectedContext.historicDirtyFrom,
        expectedContext.historicDirtyThrough,
      ],
    )) as PromotionPreflight[];
    if (!preflight) throw new Error('Promotion preflight is unavailable');
    assertPromotionPreflight(preflight);
    if (!options.apply) {
      await runner.commitTransaction();
      transactionStarted = false;
      return {
        auditId: null,
        attestationId: null,
        revision: expectedContext.statisticRevision,
      };
    }
    const auditId = randomUUID();
    const attestationId = randomUUID();
    await runner.query(
      `SELECT set_config(
         'vigieau.certified_history_promotion_id', $1, true
       )`,
      [auditId],
    );
    await runner.query(
      `SELECT set_config(
         'vigieau.certified_history_attestation_id', $1, true
       )`,
      [attestationId],
    );
    // Retagging snapshots from an older certified repair to this newly
    // validated repair is an atomic supersession, not a data invalidation.
    // Keep the revocation trigger from clearing the new provenance tags while
    // the promotion transaction replaces the previous repair boundary.
    await runner.query(CERTIFIED_COMPLETION_PROMOTION_REVOCATION_GUARD_SQL, [
      'on',
    ]);
    const [result] = (await runner.query(CERTIFIED_COMPLETION_PROMOTION_SQL, [
      auditId,
      options.sourceRunId,
      options.from,
      options.through,
      sourceScope.communeCount,
      sourceScope.departmentCount,
      sourceScope.dayCount,
      sourceScope.communeHistoryDigest,
      sourceScope.departmentHistoryDigest,
      sourceScope.statisticDigest,
      sourceScope.provenanceDigest,
      expectedContext.sourcePublicRevision,
      expectedContext.historicComputeEpoch,
      expectedContext.historicBackfillGlobalEpoch,
      expectedContext.statisticRevision,
      JSON.stringify({
        executionContext,
        method: 'certified-backup-repair',
        sourceFingerprint: sourceScope.sourceFingerprint,
      }),
      expectedContext.historicDirtyFrom,
      expectedContext.historicDirtyThrough,
    ])) as Array<Record<string, unknown>>;
    await runner.query(CERTIFIED_COMPLETION_PROMOTION_REVOCATION_GUARD_SQL, [
      '',
    ]);
    const promotedRevision = String(
      BigInt(expectedContext.statisticRevision) + 1n,
    );
    if (
      count(result?.auditCount, 'audit insert count') !== 1 ||
      count(result?.snapshotDayCount, 'snapshot day count') !==
        sourceScope.dayCount ||
      count(result?.invalidSnapshotCount, 'invalid snapshot count') !== 0 ||
      String(result?.revision) !== promotedRevision
    ) {
      throw new PublicationContextChangedError(
        'Atomic certified history promotion lost its CAS precondition',
      );
    }
    const [attestation] = (await runner.query(
      CERTIFIED_COMPLETION_INITIAL_ATTESTATION_SQL,
      [
        attestationId,
        auditId,
        expectedContext.historicComputeEpoch,
        promotedRevision,
        JSON.stringify({
          attestationMethod: 'initial-certified-promotion',
        }),
      ],
    )) as Array<Record<string, unknown>>;
    if (
      String(attestation?.attestationId) !== attestationId ||
      String(attestation?.revision) !== promotedRevision
    ) {
      throw new PublicationContextChangedError(
        'Atomic certified history promotion lost its attestation boundary',
      );
    }
    await runner.commitTransaction();
    transactionStarted = false;
    return {
      auditId,
      attestationId,
      revision: promotedRevision,
    };
  } catch (error) {
    if (transactionStarted) await runner.rollbackTransaction();
    throw error;
  } finally {
    if (snapshotLocked) {
      await runner.query('SELECT pg_advisory_unlock(hashtext($1))', [
        SNAPSHOT_LOCK,
      ]);
    }
    await runner.release();
  }
}

async function attestExistingRepair(
  source: QueryRunner,
  target: DataSource,
  sourceScope: CertifiedCompletionSourceScope,
  departmentBatches: CertifiedDepartmentDay[][],
  statisticRows: CertifiedStatisticDay[],
  expectedContext: RepairPublicationContext,
  executionContext: string,
  options: CertifiedHistoryCompletionOptions,
): Promise<{
  auditId: string;
  attestationId: string | null;
  revision: string;
}> {
  const communeDigestBatches = await readCertifiedCommuneDigests(
    source,
    options,
    sourceScope,
  );
  const runner = target.createQueryRunner();
  let snapshotLocked = false;
  let transactionStarted = false;
  try {
    await runner.connect();
    const [snapshotLock] = (await runner.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [SNAPSHOT_LOCK],
    )) as Array<{ locked: unknown }>;
    snapshotLocked = bool(snapshotLock?.locked);
    if (!snapshotLocked) {
      throw new CurrentPriorityError('Snapshot lock is busy');
    }
    await runner.query("SELECT set_config('statement_timeout', $1, false)", [
      `${options.statementTimeoutMs}ms`,
    ]);
    await assertContext(runner, expectedContext, false);
    await validateAllCommunesExact(
      runner,
      communeDigestBatches,
      options,
      expectedContext,
    );
    for (const rows of departmentBatches) {
      await assertContext(runner, expectedContext, false);
      await validateTargetDepartmentExact(runner, rows, options);
    }
    for (
      let offset = 0;
      offset < statisticRows.length;
      offset += options.batchSize
    ) {
      await assertContext(runner, expectedContext, false);
      await validateTargetStatisticExact(
        runner,
        statisticRows.slice(offset, offset + options.batchSize),
      );
    }
    await assertContext(runner, expectedContext, false);

    await runner.startTransaction('SERIALIZABLE');
    transactionStarted = true;
    await runner.query("SELECT set_config('lock_timeout', $1, true)", [
      `${options.lockTimeoutMs}ms`,
    ]);
    await runner.query("SELECT set_config('statement_timeout', $1, true)", [
      `${options.statementTimeoutMs}ms`,
    ]);
    const [zoneLock] = (await runner.query(
      `SELECT pg_try_advisory_xact_lock(
         hashtext('vigieau'), hashtext('zone-compute-global')
       ) AS locked`,
    )) as Array<{ locked: unknown }>;
    const [promotionLock] = (await runner.query(
      'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
      [ZONE_PROMOTION_LOCK],
    )) as Array<{ locked: unknown }>;
    if (!bool(zoneLock?.locked) || !bool(promotionLock?.locked)) {
      throw new CurrentPriorityError('Zone publication lock is busy');
    }
    await assertContext(runner, expectedContext, options.apply);
    const [preflight] = (await runner.query(
      CERTIFIED_COMPLETION_PROMOTION_PREFLIGHT_SQL,
      [
        options.from,
        options.through,
        EXPECTED_COMMUNE_COUNT,
        expectedContext.historicDirtyFrom,
        expectedContext.historicDirtyThrough,
      ],
    )) as PromotionPreflight[];
    if (!preflight) throw new Error('Attestation preflight is unavailable');
    assertPromotionPreflight(preflight);

    const repairs = (await runner.query(
      certifiedCompletionRepairAuditSql(options.apply),
      [
        options.sourceRunId,
        options.from,
        options.through,
        sourceScope.communeCount,
        sourceScope.departmentCount,
        sourceScope.dayCount,
        sourceScope.communeHistoryDigest,
        sourceScope.departmentHistoryDigest,
        sourceScope.statisticDigest,
        sourceScope.provenanceDigest,
      ],
    )) as Array<{ id: string }>;
    if (repairs.length !== 1) {
      throw new Error(
        `Expected one matching certified repair audit, found ${repairs.length}`,
      );
    }
    const auditId = String(repairs[0].id);
    const [existing] = (await runner.query(
      `
        SELECT repair."attestationId"::text AS id,
               repair."attestationStatisticRevision"::text AS revision
        FROM "active_certified_history_repair" repair
        WHERE repair.id = $1::uuid
          AND repair."attestedThroughEpoch" = $2::bigint
        LIMIT 1
      `,
      [auditId, expectedContext.historicComputeEpoch],
    )) as Array<{ id: string; revision: string }>;
    if (existing) {
      await runner.commitTransaction();
      transactionStarted = false;
      return {
        auditId,
        attestationId: existing.id,
        revision: existing.revision,
      };
    }
    if (!options.apply) {
      await runner.commitTransaction();
      transactionStarted = false;
      return {
        auditId,
        attestationId: null,
        revision: expectedContext.statisticRevision,
      };
    }

    const [foreignTag] = (await runner.query(
      `
        SELECT snapshot."snapshotDate"::text AS date
        FROM "statistic_commune_snapshot" snapshot
        WHERE snapshot."snapshotDate" BETWEEN $1::date AND $2::date
          AND snapshot.scope = 'national'
          AND snapshot."certifiedHistoryRepairId" IS NOT NULL
          AND snapshot."certifiedHistoryRepairId" <> $3::uuid
        ORDER BY snapshot."snapshotDate"
        LIMIT 1
      `,
      [options.from, options.through, auditId],
    )) as Array<{ date: string }>;
    if (foreignTag) {
      throw new Error(
        `Certified snapshot ${foreignTag.date} belongs to another repair`,
      );
    }
    const attestationId = randomUUID();
    await runner.query(
      `SELECT set_config(
         'vigieau.certified_history_promotion_id', $1, true
       )`,
      [auditId],
    );
    await runner.query(
      `SELECT set_config(
         'vigieau.certified_history_attestation_id', $1, true
       )`,
      [attestationId],
    );
    const [retagged] = (await runner.query(
      CERTIFIED_COMPLETION_ATTESTATION_RETAG_SQL,
      [auditId, options.from, options.through, sourceScope.communeCount],
    )) as Array<Record<string, unknown>>;
    const retaggedSnapshotCount = count(
      retagged?.retaggedSnapshotCount,
      'retagged snapshot count',
    );
    if (retaggedSnapshotCount > sourceScope.dayCount) {
      throw new PublicationContextChangedError(
        'Atomic certified history attestation retagged too many snapshots',
      );
    }
    const [result] = (await runner.query(CERTIFIED_COMPLETION_ATTESTATION_SQL, [
      options.from,
      options.through,
      sourceScope.communeCount,
      auditId,
      expectedContext.statisticRevision,
    ])) as Array<Record<string, unknown>>;
    const attestedRevision = String(
      BigInt(expectedContext.statisticRevision) + 1n,
    );
    if (
      count(result?.snapshotDayCount, 'snapshot day count') !==
        sourceScope.dayCount ||
      count(result?.invalidSnapshotCount, 'invalid snapshot count') !== 0 ||
      String(result?.revision) !== attestedRevision
    ) {
      throw new PublicationContextChangedError(
        'Atomic certified history attestation preparation lost its CAS precondition',
      );
    }
    const [attestation] = (await runner.query(
      CERTIFIED_COMPLETION_INITIAL_ATTESTATION_SQL,
      [
        attestationId,
        auditId,
        expectedContext.historicComputeEpoch,
        attestedRevision,
        JSON.stringify({
          attestationMethod: 'certified-backup-reattestation',
          executionContext,
          sourceFingerprint: sourceScope.sourceFingerprint,
          currentSourceRevision: expectedContext.sourcePublicRevision,
        }),
      ],
    )) as Array<Record<string, unknown>>;
    if (
      String(attestation?.attestationId) !== attestationId ||
      String(attestation?.revision) !== attestedRevision
    ) {
      throw new PublicationContextChangedError(
        'Atomic certified history attestation lost its attestation boundary',
      );
    }
    await runner.commitTransaction();
    transactionStarted = false;
    return {
      auditId,
      attestationId,
      revision: attestedRevision,
    };
  } catch (error) {
    if (transactionStarted) await runner.rollbackTransaction();
    throw error;
  } finally {
    if (snapshotLocked) {
      await runner.query('SELECT pg_advisory_unlock(hashtext($1))', [
        SNAPSHOT_LOCK,
      ]);
    }
    await runner.release();
  }
}

export async function completeCertifiedHistoryRestoration(
  sourceDataSource: DataSource,
  target: DataSource,
  options: CertifiedHistoryCompletionOptions,
): Promise<CertifiedHistoryCompletionSummary> {
  await assertDatabaseName(
    sourceDataSource,
    options.expectedSourceDatabase,
    'Source',
  );
  await assertDatabaseName(target, options.expectedTargetDatabase, 'Target');
  await assertReadOnlySession(sourceDataSource, 'Source');
  if (!options.apply) await assertReadOnlySession(target, 'Dry-run target');

  const source = sourceDataSource.createQueryRunner();
  await source.connect();
  await source.startTransaction('REPEATABLE READ');
  try {
    const [transaction] = (await source.query(
      `SELECT current_setting('transaction_read_only') AS "readOnly",
              current_setting('transaction_isolation') AS isolation`,
    )) as Array<{ readOnly: string; isolation: string }>;
    if (
      transaction?.readOnly !== 'on' ||
      transaction.isolation.toLowerCase() !== 'repeatable read'
    ) {
      throw new Error('Source snapshot is not repeatable-read and read-only');
    }
    const sourceScope = await readSourceScope(source, options);
    const columns = await statisticColumns(target);
    const rawStatistics = (await source.query(
      CERTIFIED_COMPLETION_SOURCE_STATISTIC_BATCH_SQL,
      [options.from, options.through, options.sourceRunId],
    )) as Array<Record<string, unknown>>;
    const statisticRows = validateCertifiedStatisticDays(
      rawStatistics,
      options.from,
      options.through,
      columns,
    );
    const expectedContext = await withShortTargetTransaction(
      target,
      options,
      (runner) => publicationContext(runner, options.apply),
    );
    assertRangeMatchesDirtyWindow(options, expectedContext);
    const executionContext = encodeCertifiedCompletionContext(
      options,
      expectedContext,
      sourceScope,
    );
    if (
      options.apply &&
      options.expectedExecutionContext !== executionContext
    ) {
      throw new PublicationContextChangedError(
        'Expected execution context does not match; rerun the dry-run',
      );
    }

    const summary: CertifiedHistoryCompletionSummary = {
      status: options.apply ? 'APPLIED' : 'DRY_RUN',
      mode: options.mode,
      from: options.from,
      through: options.through,
      sourceRunId: options.sourceRunId,
      departments: 0,
      departmentDays: 0,
      changedDepartments: 0,
      changedDepartmentDays: 0,
      statisticDays: statisticRows.length,
      changedStatisticDays: 0,
      batches: 0,
      sourceFingerprint: sourceScope.sourceFingerprint,
      provenanceDigest: sourceScope.provenanceDigest,
      executionContext,
      auditId: null,
      attestationId: null,
      publicationRevision: expectedContext.statisticRevision,
    };

    let departmentCursor = '';
    const departmentBatches: CertifiedDepartmentDay[][] = [];
    while (true) {
      const raw = (await source.query(
        CERTIFIED_COMPLETION_SOURCE_DEPARTMENT_BATCH_SQL,
        [
          departmentCursor,
          options.from,
          options.through,
          options.batchSize,
          options.sourceRunId,
        ],
      )) as Array<Record<string, unknown>>;
      if (raw.length === 0) break;
      const rows = validateCertifiedDepartmentDays(
        raw,
        options.from,
        options.through,
      );
      departmentCursor = rows.at(-1)!.code;
      departmentBatches.push(rows);
      summary.departments += new Set(rows.map(({ code }) => code)).size;
      summary.departmentDays += rows.length;
    }
    if (
      summary.departments !== EXPECTED_DEPARTMENT_COUNT ||
      summary.departmentDays !==
        EXPECTED_DEPARTMENT_COUNT * sourceScope.dayCount
    ) {
      throw new Error(
        `Department source coverage mismatch: ${summary.departments}/${summary.departmentDays}`,
      );
    }

    if (options.mode === 'restore') {
      const inspectionOptions = { ...options, apply: false };
      for (const rows of departmentBatches) {
        const batch = await exactDepartmentBatch(
          target,
          rows,
          expectedContext,
          inspectionOptions,
        );
        if (!options.apply) {
          summary.changedDepartments += batch.changedEntities;
          summary.changedDepartmentDays += batch.changedDays;
        }
      }
      if (options.apply) {
        for (const rows of departmentBatches) {
          const batch = await exactDepartmentBatch(
            target,
            rows,
            expectedContext,
            options,
          );
          summary.changedDepartments += batch.changedEntities;
          summary.changedDepartmentDays += batch.changedDays;
        }
      }
      summary.batches += departmentBatches.length;
      for (
        let offset = 0;
        offset < statisticRows.length;
        offset += options.batchSize
      ) {
        const rows = statisticRows.slice(offset, offset + options.batchSize);
        const batch = await exactStatisticBatch(
          target,
          rows,
          columns,
          expectedContext,
          options,
        );
        summary.changedStatisticDays += batch.changedDays;
        summary.batches += 1;
      }
      if (options.apply) {
        await withTargetSnapshotLock(target, options, async (runner) => {
          for (const rows of departmentBatches) {
            await withShortRunnerTransaction(runner, options, async () => {
              await assertContext(runner, expectedContext, true);
              await validateTargetDepartmentExact(runner, rows, options);
            });
          }
          for (
            let offset = 0;
            offset < statisticRows.length;
            offset += options.batchSize
          ) {
            const rows = statisticRows.slice(
              offset,
              offset + options.batchSize,
            );
            await withShortRunnerTransaction(runner, options, async () => {
              await assertContext(runner, expectedContext, true);
              await validateTargetStatisticExact(runner, rows);
            });
          }
        });
      }
    } else if (options.mode === 'promote') {
      const promoted = await promote(
        source,
        target,
        sourceScope,
        departmentBatches,
        statisticRows,
        expectedContext,
        executionContext,
        options,
      );
      summary.auditId = promoted.auditId;
      summary.attestationId = promoted.attestationId;
      summary.publicationRevision = promoted.revision;
      summary.status = options.apply ? 'PROMOTED' : 'PROMOTION_READY';
      summary.batches = 1;
    } else {
      const attested = await attestExistingRepair(
        source,
        target,
        sourceScope,
        departmentBatches,
        statisticRows,
        expectedContext,
        executionContext,
        options,
      );
      summary.auditId = attested.auditId;
      summary.attestationId = attested.attestationId;
      summary.publicationRevision = attested.revision;
      summary.status = options.apply ? 'ATTESTED' : 'ATTESTATION_READY';
      summary.batches = 1;
    }
    await source.commitTransaction();
    return summary;
  } catch (error) {
    if (source.isTransactionActive) await source.rollbackTransaction();
    throw error;
  } finally {
    await source.release();
  }
}

function sslEnabled(url: string): boolean {
  const mode = new URL(url).searchParams.get('sslmode')?.toLowerCase();
  return mode !== undefined && !['disable', 'allow', 'prefer'].includes(mode);
}

export function standaloneDataSource(
  url: string,
  readOnly: boolean,
): DataSource {
  const ssl = sslEnabled(url);
  return new DataSource({
    type: 'postgres',
    url,
    ssl,
    extra: {
      max: 1,
      ...(readOnly ? { options: '-c default_transaction_read_only=on' } : {}),
      ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    },
  });
}

export async function main(): Promise<void> {
  const options = parseCertifiedHistoryCompletionOptions();
  const source = standaloneDataSource(
    requiredEnvironment(
      process.env,
      'CERTIFIED_HISTORY_COMPLETION_SOURCE_DATABASE_URL',
    ),
    true,
  );
  const target = standaloneDataSource(
    requiredEnvironment(
      process.env,
      'CERTIFIED_HISTORY_COMPLETION_TARGET_DATABASE_URL',
    ),
    !options.apply,
  );
  try {
    await source.initialize();
    await target.initialize();
    const summary = await completeCertifiedHistoryRestoration(
      source,
      target,
      options,
    );
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    if (target.isInitialized) await target.destroy();
    if (source.isInitialized) await source.destroy();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[complete-certified-history-restoration] failed');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
