import 'reflect-metadata';
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import {
  CERTIFIED_HISTORY_SOURCE_RUN_ID as V1_SOURCE_RUN_ID,
  CERTIFIED_HISTORY_V2_CODE_COMMIT as V2_CODE_COMMIT,
  CERTIFIED_HISTORY_V2_CORRECTIONS as V2_CORRECTIONS,
  CERTIFIED_HISTORY_V2_CORRECTION_SOURCE as V2_CORRECTION_SOURCE,
  CERTIFIED_HISTORY_V2_GEOMETRY_EVIDENCE as V2_GEOMETRY_EVIDENCE,
  CERTIFIED_HISTORY_V2_GEOMETRY_EVIDENCE_FINGERPRINT as V2_GEOMETRY_EVIDENCE_FINGERPRINT,
  CERTIFIED_HISTORY_V2_PARENT_COMMUNE_DELTA as V2_PARENT_DELTA,
  CERTIFIED_HISTORY_V2_PARENT_PROVENANCE_DIGEST as V2_PARENT_PROVENANCE_DIGEST,
  CERTIFIED_HISTORY_V2_PARENT_SOURCE_FINGERPRINT as V2_PARENT_SOURCE_FINGERPRINT,
  CERTIFIED_HISTORY_V2_SOURCE_RUN_ID as V2_SOURCE_RUN_ID,
  CERTIFIED_HISTORY_V2_VARIANT as V2_VARIANT,
} from './build-certified-history-source';
import {
  RepairPublicationContext,
  RestoreMissingHistoryOptions,
  Severity,
  assertCivilDate,
  assertDatabaseName,
  assertExpectedContext,
  assertSourceSessionSafety,
  databaseBoolean,
  databaseCount,
  normalizeSeverity,
  parseBoolean,
  parseInteger,
  publicationContext,
  requiredEnvironment,
  standaloneDataSource,
  withSnapshotLock,
} from './restore-missing-commune-history';

const APPLY_CONFIRMATION = 'RESTORE_CERTIFIED_COMMUNE_HISTORY';
const PROMOTION_BLOCKED =
  'BLOCKED_PENDING_DEPARTMENT_NATIONAL_AND_PROVENANCE_VALIDATION';
const V2_FROM = '2026-07-11';
const V2_THROUGH = '2026-08-31';
const V2_INITIAL_DIRTY_THROUGH = '2026-08-27';

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

export interface CertifiedSourceDay {
  code: string;
  date: string;
  SOU: Severity | null;
  SUP: Severity | null;
  AEP: Severity | null;
}

interface CertifiedSourceScopeRow {
  runCount: number | string;
  status: string | null;
  dateFrom: string | null;
  dateThrough: string | null;
  manifestCommuneCount: number | string | null;
  manifestDayCount: number | string | null;
  manifestCommuneDigest: string | null;
  manifestHistoryDigest: string | null;
  provenanceValid: boolean | string | null;
  provenanceDigest: string | null;
  invalidProvenanceCount: number | string;
  communeCount: number | string;
  distinctCommuneCount: number | string;
  statisticCount: number | string;
  dayCount: number | string;
  invalidCommuneCount: number | string;
  communeDigest: string | null;
  sourceFingerprint: string | null;
  manifestSourceFingerprint: string | null;
}

export interface CertifiedSourceScope {
  sourceRunId: string;
  communeCount: number;
  dayCount: number;
  communeDigest: string;
  sourceFingerprint: string;
  provenanceDigest: string;
}

export function assertPinnedV2CertifiedSource(
  source: CertifiedSourceScope,
): void {
  if (source.sourceRunId !== V2_SOURCE_RUN_ID) return;
  const expected = CERTIFIED_HISTORY_V2_CERTIFIED_MANIFEST;
  if (
    source.communeCount !== expected.communeCount ||
    source.dayCount !== expected.communeDayCount ||
    source.communeDigest !== expected.communeDigest ||
    source.provenanceDigest !== expected.provenanceDigest ||
    source.sourceFingerprint !== expected.sourceFingerprint
  ) {
    throw new Error('Certified v2 source does not match the audited manifest');
  }
}

interface TargetScopeRow {
  communeCount: number | string;
  distinctCommuneCount: number | string;
  statisticCount: number | string;
  communeDigest: string | null;
}

interface CertifiedTargetBatchResult {
  sourceCommuneCount: number | string;
  targetCommuneCount: number | string;
  changedCommuneCount: number | string;
  changedDayCount: number | string;
  changedValueCount: number | string;
  affectedCommuneCount: number | string;
  invalidTargetCount: number | string;
}

interface SourceBatch {
  cursor: string;
  communeCount: number;
  days: CertifiedSourceDay[];
}

export interface RestoreCertifiedHistoryOptions extends RestoreMissingHistoryOptions {
  from: string;
  sourceRunId: string;
  promotionRequested: boolean;
}

export interface RestoreCertifiedHistorySummary {
  status: 'DRY_RUN' | 'APPLIED';
  from: string;
  through: string;
  sourceCommunes: number;
  sourceDays: number;
  targetCommunes: number;
  changedCommunes: number;
  changedDays: number;
  changedValues: number;
  appliedCommunes: number;
  batches: number;
  validatedCommunes: number;
  sourceFingerprint: string;
  provenanceDigest: string;
  publicationContext: string;
  publicationRevision: string;
  dirtyRangePreserved: true;
  promotionStatus: typeof PROMOTION_BLOCKED;
}

function assertContextToken(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(
      'CERTIFIED_HISTORY_EXPECTED_PUBLICATION_CONTEXT is invalid',
    );
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid payload');
    }
  } catch {
    throw new Error(
      'CERTIFIED_HISTORY_EXPECTED_PUBLICATION_CONTEXT is invalid',
    );
  }
  return value;
}

function assertSourceRunId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new Error('CERTIFIED_HISTORY_SOURCE_RUN_ID is invalid');
  }
  return value;
}

export function parseRestoreCertifiedHistoryOptions(
  environment: NodeJS.ProcessEnv = process.env,
): RestoreCertifiedHistoryOptions {
  const apply = parseBoolean(
    'CERTIFIED_HISTORY_APPLY',
    environment.CERTIFIED_HISTORY_APPLY,
  );
  const promotionRequested = parseBoolean(
    'CERTIFIED_HISTORY_PROMOTE',
    environment.CERTIFIED_HISTORY_PROMOTE,
  );
  if (promotionRequested) {
    throw new Error(
      'Certified commune repair cannot promote: department/global statistics and audited provenance require a separate validation command',
    );
  }
  if (
    apply &&
    environment.CERTIFIED_HISTORY_CONFIRMATION?.trim() !== APPLY_CONFIRMATION
  ) {
    throw new Error(
      `CERTIFIED_HISTORY_CONFIRMATION must equal ${APPLY_CONFIRMATION} in apply mode`,
    );
  }
  const expectedPublicationContext =
    environment.CERTIFIED_HISTORY_EXPECTED_PUBLICATION_CONTEXT?.trim() || null;
  if (apply && expectedPublicationContext === null) {
    throw new Error(
      'CERTIFIED_HISTORY_EXPECTED_PUBLICATION_CONTEXT is required in apply mode',
    );
  }
  if (expectedPublicationContext !== null) {
    assertContextToken(expectedPublicationContext);
  }
  const expectedSourceDatabase = requiredEnvironment(
    environment,
    'CERTIFIED_HISTORY_EXPECTED_SOURCE_DATABASE',
  );
  const expectedTargetDatabase = requiredEnvironment(
    environment,
    'CERTIFIED_HISTORY_EXPECTED_TARGET_DATABASE',
  );
  if (expectedSourceDatabase === expectedTargetDatabase) {
    throw new Error(
      'Certified history source and target databases must differ',
    );
  }
  const from = assertCivilDate(
    'CERTIFIED_HISTORY_FROM',
    requiredEnvironment(environment, 'CERTIFIED_HISTORY_FROM'),
  );
  const through = assertCivilDate(
    'CERTIFIED_HISTORY_THROUGH',
    requiredEnvironment(environment, 'CERTIFIED_HISTORY_THROUGH'),
  );
  if (through < from) {
    throw new Error('CERTIFIED_HISTORY_THROUGH must be on or after FROM');
  }
  return {
    from,
    through,
    sourceRunId: assertSourceRunId(
      requiredEnvironment(environment, 'CERTIFIED_HISTORY_SOURCE_RUN_ID'),
    ),
    batchSize: parseInteger(
      'CERTIFIED_HISTORY_BATCH_SIZE',
      environment.CERTIFIED_HISTORY_BATCH_SIZE,
      20,
      1,
      100,
    ),
    communeCodes: null,
    apply,
    promotionRequested,
    expectedSourceDatabase,
    expectedTargetDatabase,
    expectedPublicationContext,
    lockTimeoutMs: parseInteger(
      'CERTIFIED_HISTORY_LOCK_TIMEOUT_MS',
      environment.CERTIFIED_HISTORY_LOCK_TIMEOUT_MS,
      250,
      50,
      5_000,
    ),
    statementTimeoutMs: parseInteger(
      'CERTIFIED_HISTORY_STATEMENT_TIMEOUT_MS',
      environment.CERTIFIED_HISTORY_STATEMENT_TIMEOUT_MS,
      5_000,
      500,
      5_000,
    ),
    maxRetries: parseInteger(
      'CERTIFIED_HISTORY_MAX_RETRIES',
      environment.CERTIFIED_HISTORY_MAX_RETRIES,
      5,
      1,
      20,
    ),
  };
}

function dateCount(from: string, through: string): number {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${through}T00:00:00.000Z`);
  return Math.floor((end - start) / 86_400_000) + 1;
}

function expectedDates(from: string, through: string): string[] {
  const dates: string[] = [];
  const count = dateCount(from, through);
  const start = Date.parse(`${from}T00:00:00.000Z`);
  for (let offset = 0; offset < count; offset += 1) {
    dates.push(
      new Date(start + offset * 86_400_000).toISOString().slice(0, 10),
    );
  }
  return dates;
}

export function assertCertifiedRangeAgainstPublicationContext(
  from: string,
  through: string,
  context: RepairPublicationContext,
  sourceRunId?: string,
): void {
  assertCivilDate('CERTIFIED_HISTORY_FROM', from);
  assertCivilDate('CERTIFIED_HISTORY_THROUGH', through);
  const isV2 = sourceRunId === V2_SOURCE_RUN_ID;
  if (isV2 && (from !== V2_FROM || through !== V2_THROUGH)) {
    throw new Error(
      `Certified v2 commune repair is restricted to ${V2_FROM}/${V2_THROUGH}`,
    );
  }
  if (
    context.historicDirtyFrom === null ||
    context.historicDirtyThrough === null
  ) {
    throw new Error('Target has no complete historic dirty window');
  }
  const expectedDirtyThrough = isV2 ? V2_INITIAL_DIRTY_THROUGH : through;
  if (
    from !== context.historicDirtyFrom ||
    expectedDirtyThrough !== context.historicDirtyThrough
  ) {
    if (!isV2) {
      throw new Error(
        `Certified range must equal target dirty window ${context.historicDirtyFrom}/${context.historicDirtyThrough}`,
      );
    }
    throw new Error(
      `Certified range requires target dirty window ${from}/${expectedDirtyThrough}, found ${context.historicDirtyFrom}/${context.historicDirtyThrough}`,
    );
  }
  if (
    context.currentPublishedDate === null ||
    through >= context.currentPublishedDate
  ) {
    throw new Error(
      'Certified history must end before the current statistic publication',
    );
  }
}

export function validateCertifiedSourceDays(
  rows: Array<Record<string, unknown>>,
  from: string,
  through: string,
): CertifiedSourceDay[] {
  const dates = expectedDates(from, through);
  const expected = new Set(dates);
  const byCode = new Map<string, Map<string, CertifiedSourceDay>>();
  for (const row of rows) {
    const code = typeof row.code === 'string' ? row.code : '';
    const date = typeof row.date === 'string' ? row.date : '';
    if (!/^[0-9A-Z]{5}$/.test(code)) {
      throw new Error(`Invalid certified source commune code ${code}`);
    }
    assertCivilDate(`certified source date for ${code}`, date);
    if (!expected.has(date)) {
      throw new Error(
        `Certified source date ${code}/${date} is outside the range`,
      );
    }
    for (const type of ['SOU', 'SUP', 'AEP'] as const) {
      if (!Object.prototype.hasOwnProperty.call(row, type)) {
        throw new Error(
          `Certified source value ${code}/${date}/${type} is missing`,
        );
      }
    }
    const day: CertifiedSourceDay = {
      code,
      date,
      SOU: normalizeSeverity(row.SOU, code, date, 'SOU'),
      SUP: normalizeSeverity(row.SUP, code, date, 'SUP'),
      AEP: normalizeSeverity(row.AEP, code, date, 'AEP'),
    };
    const communeDays = byCode.get(code) ?? new Map();
    if (communeDays.has(date)) {
      throw new Error(`Duplicate certified source day ${code}/${date}`);
    }
    communeDays.set(date, day);
    byCode.set(code, communeDays);
  }
  if (byCode.size === 0) throw new Error('Certified source batch is empty');
  for (const [code, communeDays] of byCode) {
    const missing = dates.find((date) => !communeDays.has(date));
    if (missing || communeDays.size !== dates.length) {
      throw new Error(
        `Certified source coverage mismatch for ${code}: ${communeDays.size}/${dates.length}${missing ? `, missing ${missing}` : ''}`,
      );
    }
  }
  return [...byCode.values()]
    .flatMap((days) => [...days.values()])
    .sort(
      (left, right) =>
        left.code.localeCompare(right.code) ||
        left.date.localeCompare(right.date),
    );
}

export const CERTIFIED_SOURCE_SCOPE_SQL = `
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
    FROM certified_history_source_run parent
    WHERE parent.id::text = '${V1_SOURCE_RUN_ID}'
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
      run.id::text AS id,
      run.status,
      run."dateFrom"::text AS "dateFrom",
      run."dateThrough"::text AS "dateThrough",
      run."communeCount" AS "manifestCommuneCount",
      run."communeDayCount" AS "manifestDayCount",
      run."communeDigest" AS "manifestCommuneDigest",
      run."communeHistoryDigest" AS "manifestHistoryDigest",
      run.provenance,
      CASE
        WHEN run.id::text = '${V1_SOURCE_RUN_ID}' THEN
          jsonb_typeof(run.provenance) = 'object'
          AND run.provenance <> '{}'::jsonb
          AND run.provenance ->> 'communeDailyObjectKeyPolicy'
            = 'exact-date-SOU-SUP-AEP'
        WHEN run.id::text = '${V2_SOURCE_RUN_ID}' THEN
          jsonb_typeof(run.provenance) = 'object'
          AND run.provenance ->> 'method' = '${V2_VARIANT}'
          AND run.provenance -> 'planVersion' = '2'::jsonb
          AND run.provenance ->> 'parentSourceRunId' =
              '${V1_SOURCE_RUN_ID}'
          AND run.provenance ->> 'parentSourceFingerprint' =
              '${V2_PARENT_SOURCE_FINGERPRINT}'
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
                  IS DISTINCT FROM '6a97672299826944b38141dd'
                OR run.provenance -> 'dateSources' ->
                    expected_date.value::date::text ->> 'dumpSha256'
                  IS DISTINCT FROM '${V2_CORRECTION_SOURCE.dumpSha256}'
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
      END AS "provenanceValid",
      encode(
        sha256(convert_to(run.provenance::text, 'UTF8')),
        'hex'
      ) AS "provenanceDigest",
      encode(sha256(convert_to(
        '{"communeDigest":"' || run."communeDigest" ||
        '","communeHistoryDigest":"' || run."communeHistoryDigest" ||
        '","departmentDigest":"' || run."departmentDigest" ||
        '","departmentHistoryDigest":"' ||
          run."departmentHistoryDigest" ||
        '","statisticDigest":"' || run."statisticDigest" ||
        '","provenanceDigest":"' ||
          encode(sha256(convert_to(run.provenance::text, 'UTF8')), 'hex') ||
        '"}',
        'UTF8'
      )), 'hex') AS "manifestSourceFingerprint"
    FROM certified_history_source_run run
    WHERE run.id::text = $3::text
  ), expected_dates AS MATERIALIZED (
    SELECT
      COUNT(*)::integer AS count,
      encode(
        sha256(convert_to(string_agg(day::date::text, E'\\n' ORDER BY day), 'UTF8')),
        'hex'
      ) AS digest
    FROM generate_series($1::date, $2::date, '1 day'::interval) day
  ), source_days AS MATERIALIZED (
    SELECT
      day.code,
      day.date::text AS date,
      day."SOU",
      day."SUP",
      day."AEP",
      day."backupId",
      day."dumpSha256"
    FROM certified_history_commune_day day
    WHERE day."sourceRunId"::text = $3::text
      AND day.date BETWEEN $1::date AND $2::date
  ), coverage AS MATERIALIZED (
    SELECT
      day.code,
      COUNT(*)::integer AS "dayCount",
      COUNT(DISTINCT day.date)::integer AS "distinctDayCount",
      encode(
        sha256(convert_to(string_agg(day.date, E'\\n' ORDER BY day.date), 'UTF8')),
        'hex'
      ) AS "dateDigest",
      bool_or(
        (day."SOU" IS NOT NULL AND day."SOU" NOT IN (
          'vigilance', 'alerte', 'alerte_renforcee', 'crise'
        ))
        OR (day."SUP" IS NOT NULL AND day."SUP" NOT IN (
          'vigilance', 'alerte', 'alerte_renforcee', 'crise'
        ))
        OR (day."AEP" IS NOT NULL AND day."AEP" NOT IN (
          'vigilance', 'alerte', 'alerte_renforcee', 'crise'
        ))
      ) AS "invalidValue",
      encode(
        sha256(convert_to(string_agg(
          jsonb_build_array(day.date, day."SOU", day."SUP", day."AEP")::text,
          E'\\n' ORDER BY day.date
        ), 'UTF8')),
        'hex'
      ) AS digest
    FROM source_days day
    GROUP BY day.code
  ), provenance_errors AS MATERIALIZED (
    SELECT day.date
    FROM source_days day
    CROSS JOIN source_run run
    WHERE run.id = '${V2_SOURCE_RUN_ID}'
      AND (
        run.provenance -> 'dateSources' -> day.date ->> 'backupId'
          IS DISTINCT FROM day."backupId"
        OR run.provenance -> 'dateSources' -> day.date ->> 'dumpSha256'
          IS DISTINCT FROM day."dumpSha256"
        OR day."dumpSha256" !~ '^[a-f0-9]{64}$'
      )
  )
  SELECT
    (SELECT COUNT(*) FROM source_run)::integer AS "runCount",
    (SELECT status FROM source_run) AS status,
    (SELECT "dateFrom" FROM source_run) AS "dateFrom",
    (SELECT "dateThrough" FROM source_run) AS "dateThrough",
    (SELECT "manifestCommuneCount" FROM source_run) AS "manifestCommuneCount",
    (SELECT "manifestDayCount" FROM source_run) AS "manifestDayCount",
    (SELECT "manifestCommuneDigest" FROM source_run) AS "manifestCommuneDigest",
    (SELECT "manifestHistoryDigest" FROM source_run) AS "manifestHistoryDigest",
    (SELECT "provenanceValid" FROM source_run) AS "provenanceValid",
    (SELECT "provenanceDigest" FROM source_run) AS "provenanceDigest",
    (SELECT "manifestSourceFingerprint" FROM source_run)
      AS "manifestSourceFingerprint",
    (SELECT COUNT(*) FROM provenance_errors)::integer
      AS "invalidProvenanceCount",
    COUNT(*)::integer AS "communeCount",
    COUNT(DISTINCT coverage.code)::integer AS "distinctCommuneCount",
    COUNT(*)::integer AS "statisticCount",
    COALESCE(SUM(coverage."dayCount"), 0)::bigint AS "dayCount",
    COUNT(*) FILTER (WHERE
      coverage.code !~ '^[0-9A-Z]{5}$'
      OR coverage."dayCount" <> expected.count
      OR coverage."distinctDayCount" <> expected.count
      OR coverage."dateDigest" IS DISTINCT FROM expected.digest
      OR coverage."invalidValue"
    )::integer AS "invalidCommuneCount",
    encode(
      sha256(convert_to(string_agg(coverage.code, E'\\n' ORDER BY coverage.code), 'UTF8')),
      'hex'
    ) AS "communeDigest",
    encode(
      sha256(convert_to(string_agg(
        jsonb_build_array(coverage.code, coverage.digest)::text,
        E'\\n' ORDER BY coverage.code
      ), 'UTF8')),
      'hex'
    ) AS "sourceFingerprint"
  FROM coverage
  CROSS JOIN expected_dates expected
  GROUP BY expected.count, expected.digest
`;

export const CERTIFIED_TARGET_SCOPE_SQL = `
  SELECT
    COUNT(*)::integer AS "communeCount",
    COUNT(DISTINCT commune.code)::integer AS "distinctCommuneCount",
    COUNT(statistic.id)::integer AS "statisticCount",
    encode(
      sha256(convert_to(string_agg(commune.code, E'\\n' ORDER BY commune.code), 'UTF8')),
      'hex'
    ) AS "communeDigest"
  FROM commune
  LEFT JOIN statistic_commune statistic
    ON statistic."communeId" = commune.id
`;

export const CERTIFIED_SOURCE_BATCH_SQL = `
  WITH batch_communes AS MATERIALIZED (
    SELECT DISTINCT day.code
    FROM certified_history_commune_day day
    WHERE day."sourceRunId"::text = $5::text
      AND day.code > $1::text
      AND day.date BETWEEN $2::date AND $3::date
    ORDER BY day.code
    LIMIT $4::integer
  )
  SELECT
    batch.code,
    day.date::text AS date,
    day."SOU",
    day."SUP",
    day."AEP"
  FROM batch_communes batch
  JOIN certified_history_commune_day day
    ON day.code = batch.code
   AND day."sourceRunId"::text = $5::text
   AND day.date BETWEEN $2::date AND $3::date
  ORDER BY batch.code, day.date
`;

const CERTIFIED_TARGET_PLAN_CTES = `
  source_input AS MATERIALIZED (
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
      CASE WHEN jsonb_typeof(COALESCE(target."originalRestrictions", '[]'::jsonb)) = 'array'
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
      CASE WHEN jsonb_typeof(COALESCE(target."originalRestrictionsByMonth", '[]'::jsonb)) = 'array'
        THEN COALESCE(target."originalRestrictionsByMonth", '[]'::jsonb)
        ELSE '[]'::jsonb
      END
    ) WITH ORDINALITY AS monthly(value, ordinality)
  ), invalid_targets AS MATERIALIZED (
    SELECT target.id
    FROM target_statistics target
    WHERE jsonb_typeof(COALESCE(target."originalRestrictions", '[]'::jsonb)) <> 'array'
      OR jsonb_typeof(COALESCE(target."originalRestrictionsByMonth", '[]'::jsonb)) <> 'array'
    UNION
    SELECT day.id FROM target_days day
    WHERE jsonb_typeof(day.value) <> 'object'
      OR day.date IS NULL
      OR day.date !~ '^\\d{4}-\\d{2}-\\d{2}$'
    UNION
    SELECT day.id FROM target_days day
    CROSS JOIN LATERAL jsonb_object_keys(
      CASE WHEN jsonb_typeof(day.value) = 'object'
        THEN day.value ELSE '{}'::jsonb END
    ) AS key(name)
    WHERE day.date BETWEEN $2::date::text AND $3::date::text
      AND key.name NOT IN ('date', 'SOU', 'SUP', 'AEP')
    UNION
    SELECT month.id FROM target_months month
    WHERE jsonb_typeof(month.value) <> 'object'
      OR month.month IS NULL
      OR month.month !~ '^\\d{4}-\\d{2}$'
    UNION
    SELECT day.id FROM target_days day
    GROUP BY day.id, day.date HAVING COUNT(*) <> 1
    UNION
    SELECT month.id FROM target_months month
    GROUP BY month.id, month.month HAVING COUNT(*) <> 1
  ), differences AS MATERIALIZED (
    SELECT
      target.id,
      source.code,
      source.date,
      source."SOU",
      source."SUP",
      source."AEP",
      day.value AS "targetValue",
      day.ordinality,
      day.value IS NULL OR NOT (day.value ? 'SOU')
        OR day.value ->> 'SOU' IS DISTINCT FROM source."SOU" AS "changedSOU",
      day.value IS NULL OR NOT (day.value ? 'SUP')
        OR day.value ->> 'SUP' IS DISTINCT FROM source."SUP" AS "changedSUP",
      day.value IS NULL OR NOT (day.value ? 'AEP')
        OR day.value ->> 'AEP' IS DISTINCT FROM source."AEP" AS "changedAEP"
    FROM source_input source
    LEFT JOIN target_statistics target ON target.code = source.code
    LEFT JOIN target_days day ON day.id = target.id AND day.date = source.date
  ), changed_dates AS MATERIALIZED (
    SELECT * FROM differences
    WHERE "changedSOU" OR "changedSUP" OR "changedAEP"
  ), merged_days AS MATERIALIZED (
    SELECT
      day.id,
      day.date,
      CASE WHEN day.date < $2::date::text THEN 0 ELSE 2 END AS "sortGroup",
      day.ordinality,
      day.value
    FROM target_days day
    WHERE day.date < $2::date::text OR day.date > $3::date::text
    UNION ALL
    SELECT
      target.id,
      source.date,
      1 AS "sortGroup",
      ROW_NUMBER() OVER (PARTITION BY target.id ORDER BY source.date)::bigint AS ordinality,
      COALESCE(day.value, jsonb_build_object('date', source.date))
        || jsonb_build_object(
          'date', source.date,
          'SOU', source."SOU",
          'SUP', source."SUP",
          'AEP', source."AEP"
        ) AS value
    FROM source_input source
    JOIN target_statistics target ON target.code = source.code
    LEFT JOIN target_days day ON day.id = target.id AND day.date = source.date
  ), months_to_refresh AS MATERIALIZED (
    SELECT DISTINCT left(date, 7) AS month FROM source_input
  ), monthly_weights AS MATERIALIZED (
    SELECT
      target.id,
      month.month,
      COALESCE(SUM(
        CASE GREATEST(
          CASE day.value ->> 'AEP'
            WHEN 'vigilance' THEN 2 WHEN 'alerte' THEN 3
            WHEN 'alerte_renforcee' THEN 4 WHEN 'crise' THEN 5 ELSE 1 END,
          CASE day.value ->> 'SOU'
            WHEN 'vigilance' THEN 2 WHEN 'alerte' THEN 3
            WHEN 'alerte_renforcee' THEN 4 WHEN 'crise' THEN 5 ELSE 1 END,
          CASE day.value ->> 'SUP'
            WHEN 'vigilance' THEN 2 WHEN 'alerte' THEN 3
            WHEN 'alerte_renforcee' THEN 4 WHEN 'crise' THEN 5 ELSE 1 END
        )
          WHEN 2 THEN 0.5 WHEN 3 THEN 2 WHEN 4 THEN 3 WHEN 5 THEN 4 ELSE 0
        END
      ), 0) AS ponderation
    FROM target_statistics target
    CROSS JOIN months_to_refresh month
    LEFT JOIN merged_days day
      ON day.id = target.id AND left(day.date, 7) = month.month
    GROUP BY target.id, month.month
  ), merged_months AS MATERIALIZED (
    SELECT
      month.id,
      month.month,
      month.ordinality,
      CASE WHEN weight.month IS NULL THEN month.value
        ELSE month.value || jsonb_build_object('ponderation', weight.ponderation)
      END AS value
    FROM target_months month
    LEFT JOIN monthly_weights weight
      ON weight.id = month.id AND weight.month = month.month
    UNION ALL
    SELECT
      weight.id,
      weight.month,
      9223372036854775807::bigint AS ordinality,
      jsonb_build_object('date', weight.month, 'ponderation', weight.ponderation)
    FROM monthly_weights weight
    WHERE NOT EXISTS (
      SELECT 1 FROM target_months month
      WHERE month.id = weight.id AND month.month = weight.month
    )
  ), prepared_payloads AS MATERIALIZED (
    SELECT
      target.id,
      target."originalRestrictions",
      target."originalRestrictionsByMonth",
      COALESCE((
        SELECT jsonb_agg(day.value ORDER BY day."sortGroup", day.date, day.ordinality)
        FROM merged_days day WHERE day.id = target.id
      ), '[]'::jsonb) AS restrictions,
      COALESCE((
        SELECT jsonb_agg(month.value ORDER BY month.month, month.ordinality)
        FROM merged_months month WHERE month.id = target.id
      ), '[]'::jsonb) AS "restrictionsByMonth"
    FROM target_statistics target
  ), prepared_updates AS MATERIALIZED (
    SELECT * FROM prepared_payloads prepared
    WHERE prepared.restrictions IS DISTINCT FROM prepared."originalRestrictions"
      OR prepared."restrictionsByMonth" IS DISTINCT FROM prepared."originalRestrictionsByMonth"
  )
`;

const CERTIFIED_TARGET_RESULT_SQL = `
  SELECT
    (SELECT COUNT(*) FROM source_communes)::integer AS "sourceCommuneCount",
    (SELECT COUNT(*) FROM target_statistics)::integer AS "targetCommuneCount",
    (SELECT COUNT(*) FROM prepared_updates)::integer AS "changedCommuneCount",
    (SELECT COUNT(*) FROM changed_dates)::integer AS "changedDayCount",
    COALESCE((SELECT SUM(
      "changedSOU"::integer + "changedSUP"::integer + "changedAEP"::integer
    ) FROM changed_dates), 0)::integer AS "changedValueCount",
    %AFFECTED% AS "affectedCommuneCount",
    (SELECT COUNT(*) FROM invalid_targets)::integer AS "invalidTargetCount"
`;

export const CERTIFIED_INSPECT_TARGET_BATCH_SQL = `
  WITH ${CERTIFIED_TARGET_PLAN_CTES}
  ${CERTIFIED_TARGET_RESULT_SQL.replace('%AFFECTED%', '0::integer')}
`;

export const CERTIFIED_APPLY_TARGET_BATCH_SQL = `
  WITH ${CERTIFIED_TARGET_PLAN_CTES}, updated AS (
    UPDATE statistic_commune statistic
    SET restrictions = prepared.restrictions,
        "restrictionsByMonth" = prepared."restrictionsByMonth"
    FROM prepared_updates prepared
    WHERE NOT EXISTS (SELECT 1 FROM invalid_targets)
      AND statistic.id = prepared.id
      AND statistic.restrictions
        IS NOT DISTINCT FROM prepared."originalRestrictions"
      AND statistic."restrictionsByMonth"
        IS NOT DISTINCT FROM prepared."originalRestrictionsByMonth"
    RETURNING statistic.id
  )
  ${CERTIFIED_TARGET_RESULT_SQL.replace(
    '%AFFECTED%',
    '(SELECT COUNT(*) FROM updated)::integer',
  )}
`;

function encodeCertifiedExecutionContext(
  context: RepairPublicationContext,
  options: RestoreCertifiedHistoryOptions,
  source: CertifiedSourceScope,
): string {
  return Buffer.from(
    JSON.stringify({
      publication: context,
      scope: {
        from: options.from,
        through: options.through,
        sourceRunId: source.sourceRunId,
        sourceDatabase: options.expectedSourceDatabase,
        targetDatabase: options.expectedTargetDatabase,
        communeCount: source.communeCount,
        dayCount: source.dayCount,
        communeDigest: source.communeDigest,
        sourceFingerprint: source.sourceFingerprint,
        provenanceDigest: source.provenanceDigest,
      },
    }),
    'utf8',
  ).toString('base64url');
}

export { encodeCertifiedExecutionContext };

function assertSha256(value: string | null, name: string): string {
  if (!value || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Invalid certified source ${name}`);
  }
  return value;
}

async function certifiedSourceScope(
  source: QueryRunner,
  options: RestoreCertifiedHistoryOptions,
): Promise<CertifiedSourceScope> {
  const [row] = (await source.query(CERTIFIED_SOURCE_SCOPE_SQL, [
    options.from,
    options.through,
    options.sourceRunId,
  ])) as CertifiedSourceScopeRow[];
  if (!row) throw new Error('Certified source scope is unavailable');
  const runCount = databaseCount(row.runCount, 'source manifest run count');
  if (
    runCount !== 1 ||
    row.status !== 'certified' ||
    row.dateFrom !== options.from ||
    row.dateThrough !== options.through ||
    !databaseBoolean(row.provenanceValid)
  ) {
    throw new Error(
      `Certified source manifest mismatch: run=${runCount}, status=${row.status ?? 'missing'}, range=${row.dateFrom ?? 'missing'}/${row.dateThrough ?? 'missing'}, provenance=${String(row.provenanceValid)}`,
    );
  }
  const communeCount = databaseCount(row.communeCount, 'source commune count');
  const distinctCommuneCount = databaseCount(
    row.distinctCommuneCount,
    'distinct source commune count',
  );
  const statisticCount = databaseCount(
    row.statisticCount,
    'source statistic count',
  );
  const dayCountValue = databaseCount(row.dayCount, 'source day count');
  const invalid = databaseCount(
    row.invalidCommuneCount,
    'invalid source commune count',
  );
  const invalidProvenance = databaseCount(
    row.invalidProvenanceCount,
    'invalid source provenance count',
  );
  const expectedDayCount =
    communeCount * dateCount(options.from, options.through);
  const manifestCommuneCount = databaseCount(
    row.manifestCommuneCount,
    'manifest commune count',
  );
  const manifestDayCount = databaseCount(
    row.manifestDayCount,
    'manifest commune day count',
  );
  const communeDigest = assertSha256(row.communeDigest, 'commune digest');
  const communeHistoryFingerprint = assertSha256(
    row.sourceFingerprint,
    'history fingerprint',
  );
  const manifestSourceFingerprint =
    options.sourceRunId === V2_SOURCE_RUN_ID
      ? assertSha256(
          row.manifestSourceFingerprint,
          'manifest source fingerprint',
        )
      : null;
  const manifestCommuneDigest = assertSha256(
    row.manifestCommuneDigest,
    'manifest commune digest',
  );
  const manifestHistoryDigest = assertSha256(
    row.manifestHistoryDigest,
    'manifest history digest',
  );
  if (
    communeCount === 0 ||
    communeCount !== distinctCommuneCount ||
    communeCount !== statisticCount ||
    dayCountValue !== expectedDayCount ||
    manifestCommuneCount !== communeCount ||
    manifestDayCount !== dayCountValue ||
    manifestCommuneDigest !== communeDigest ||
    manifestHistoryDigest !== communeHistoryFingerprint ||
    invalid !== 0 ||
    invalidProvenance !== 0
  ) {
    throw new Error(
      `Certified source coverage mismatch: communes=${communeCount}/${distinctCommuneCount}/${statisticCount}, days=${dayCountValue}/${expectedDayCount}, invalid=${invalid}, provenance=${invalidProvenance}`,
    );
  }
  const sourceFingerprint =
    options.sourceRunId === V2_SOURCE_RUN_ID
      ? manifestSourceFingerprint!
      : communeHistoryFingerprint;
  const result = {
    sourceRunId: options.sourceRunId,
    communeCount,
    dayCount: dayCountValue,
    communeDigest,
    sourceFingerprint,
    provenanceDigest: assertSha256(row.provenanceDigest, 'provenance digest'),
  };
  assertPinnedV2CertifiedSource(result);
  return result;
}

async function assertTargetScope(
  runner: QueryRunner,
  source: CertifiedSourceScope,
): Promise<void> {
  const [row] = (await runner.query(
    CERTIFIED_TARGET_SCOPE_SQL,
  )) as TargetScopeRow[];
  if (!row) throw new Error('Certified target scope is unavailable');
  const communeCount = databaseCount(row.communeCount, 'target commune count');
  const distinct = databaseCount(
    row.distinctCommuneCount,
    'distinct target commune count',
  );
  const statisticCount = databaseCount(
    row.statisticCount,
    'target statistic count',
  );
  if (
    communeCount !== source.communeCount ||
    distinct !== source.communeCount ||
    statisticCount !== source.communeCount ||
    row.communeDigest !== source.communeDigest
  ) {
    throw new Error(
      `Certified target commune set mismatch: ${communeCount}/${distinct}/${statisticCount}/${source.communeCount}`,
    );
  }
}

async function readSourceBatch(
  source: QueryRunner,
  cursor: string,
  options: RestoreCertifiedHistoryOptions,
): Promise<SourceBatch | null> {
  const rows = (await source.query(CERTIFIED_SOURCE_BATCH_SQL, [
    cursor,
    options.from,
    options.through,
    options.batchSize,
    options.sourceRunId,
  ])) as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  const days = validateCertifiedSourceDays(rows, options.from, options.through);
  const codes = [...new Set(days.map((day) => day.code))];
  return { cursor: codes.at(-1)!, communeCount: codes.length, days };
}

function validateTargetResult(
  result: CertifiedTargetBatchResult | undefined,
  requireComplete: boolean,
): CertifiedTargetBatchResult {
  if (!result) throw new Error('Certified target batch returned no result');
  const sourceCommunes = databaseCount(
    result.sourceCommuneCount,
    'batch source commune count',
  );
  const targetCommunes = databaseCount(
    result.targetCommuneCount,
    'batch target commune count',
  );
  const invalidTargets = databaseCount(
    result.invalidTargetCount,
    'invalid target count',
  );
  const changed = databaseCount(
    result.changedCommuneCount,
    'changed target commune count',
  );
  if (sourceCommunes !== targetCommunes || invalidTargets !== 0) {
    throw new Error(
      `Certified target coverage mismatch: ${targetCommunes}/${sourceCommunes}, invalid=${invalidTargets}`,
    );
  }
  if (requireComplete && changed !== 0) {
    throw new Error(
      `Certified target validation found ${changed} divergent communes`,
    );
  }
  return result;
}

async function inspectTargetBatch(
  runner: QueryRunner,
  days: CertifiedSourceDay[],
  options: RestoreCertifiedHistoryOptions,
  requireComplete: boolean,
): Promise<CertifiedTargetBatchResult> {
  const [result] = (await runner.query(CERTIFIED_INSPECT_TARGET_BATCH_SQL, [
    JSON.stringify(days),
    options.from,
    options.through,
  ])) as CertifiedTargetBatchResult[];
  return validateTargetResult(result, requireComplete);
}

async function inspectOrApplyTargetBatch(
  target: DataSource,
  days: CertifiedSourceDay[],
  expectedContext: RepairPublicationContext,
  options: RestoreCertifiedHistoryOptions,
): Promise<CertifiedTargetBatchResult> {
  return withSnapshotLock(target, options, async (runner) => {
    await assertExpectedContext(runner, expectedContext, options.apply);
    if (!options.apply) {
      return inspectTargetBatch(runner, days, options, false);
    }
    const [result] = (await runner.query(CERTIFIED_APPLY_TARGET_BATCH_SQL, [
      JSON.stringify(days),
      options.from,
      options.through,
    ])) as CertifiedTargetBatchResult[];
    const checked = validateTargetResult(result, false);
    const changed = databaseCount(
      checked.changedCommuneCount,
      'changed target commune count',
    );
    const affected = databaseCount(
      checked.affectedCommuneCount,
      'affected target commune count',
    );
    if (affected !== changed) {
      throw new Error(`Certified history CAS mismatch: ${affected}/${changed}`);
    }
    await inspectTargetBatch(runner, days, options, true);
    return checked;
  });
}

async function finalValidation(
  source: QueryRunner,
  target: DataSource,
  expectedContext: RepairPublicationContext,
  options: RestoreCertifiedHistoryOptions,
): Promise<number> {
  let cursor = '';
  let validated = 0;
  while (true) {
    const batch = await readSourceBatch(source, cursor, options);
    if (!batch) break;
    cursor = batch.cursor;
    await withSnapshotLock(target, options, async (runner) => {
      await assertExpectedContext(runner, expectedContext, options.apply);
      await inspectTargetBatch(runner, batch.days, options, true);
    });
    validated += batch.communeCount;
  }
  return validated;
}

async function assertTargetSessionMode(
  target: DataSource,
  readOnly: boolean,
): Promise<void> {
  const [row] = (await target.query(
    `SELECT current_setting('default_transaction_read_only') AS "readOnly"`,
  )) as Array<{ readOnly: string }>;
  if (row?.readOnly !== (readOnly ? 'on' : 'off')) {
    throw new Error(
      `Target database connection must be ${readOnly ? 'strictly read-only' : 'writable'} in this mode`,
    );
  }
}

export async function restoreCertifiedCommuneHistory(
  source: DataSource,
  target: DataSource,
  options: RestoreCertifiedHistoryOptions,
): Promise<RestoreCertifiedHistorySummary> {
  await assertDatabaseName(source, options.expectedSourceDatabase, 'Source');
  await assertDatabaseName(target, options.expectedTargetDatabase, 'Target');
  await assertSourceSessionSafety(source);
  await assertTargetSessionMode(target, !options.apply);

  const sourceRunner = source.createQueryRunner();
  await sourceRunner.connect();
  await sourceRunner.startTransaction('REPEATABLE READ');
  try {
    const [sourceMode] = (await sourceRunner.query(
      `SELECT current_setting('transaction_read_only') AS "readOnly"`,
    )) as Array<{ readOnly: string }>;
    if (sourceMode?.readOnly !== 'on') {
      throw new Error('Certified source transaction must be read-only');
    }
    const sourceScope = await certifiedSourceScope(sourceRunner, options);
    const expectedContext = await withSnapshotLock(
      target,
      options,
      async (runner) => {
        const context = await publicationContext(runner, options.apply);
        assertCertifiedRangeAgainstPublicationContext(
          options.from,
          options.through,
          context,
          options.sourceRunId,
        );
        await assertTargetScope(runner, sourceScope);
        return context;
      },
    );
    const contextToken = encodeCertifiedExecutionContext(
      expectedContext,
      options,
      sourceScope,
    );
    if (options.apply && options.expectedPublicationContext !== contextToken) {
      throw new Error(
        'CERTIFIED_HISTORY_EXPECTED_PUBLICATION_CONTEXT does not match source/target; rerun the dry-run',
      );
    }

    const summary: RestoreCertifiedHistorySummary = {
      status: options.apply ? 'APPLIED' : 'DRY_RUN',
      from: options.from,
      through: options.through,
      sourceCommunes: 0,
      sourceDays: 0,
      targetCommunes: 0,
      changedCommunes: 0,
      changedDays: 0,
      changedValues: 0,
      appliedCommunes: 0,
      batches: 0,
      validatedCommunes: 0,
      sourceFingerprint: sourceScope.sourceFingerprint,
      provenanceDigest: sourceScope.provenanceDigest,
      publicationContext: contextToken,
      publicationRevision: expectedContext.statisticRevision,
      dirtyRangePreserved: true,
      promotionStatus: PROMOTION_BLOCKED,
    };
    let cursor = '';
    while (true) {
      const batch = await readSourceBatch(sourceRunner, cursor, options);
      if (!batch) break;
      cursor = batch.cursor;
      const result = await inspectOrApplyTargetBatch(
        target,
        batch.days,
        expectedContext,
        options,
      );
      summary.sourceCommunes += batch.communeCount;
      summary.sourceDays += batch.days.length;
      summary.targetCommunes += databaseCount(
        result.targetCommuneCount,
        'target commune count',
      );
      summary.changedCommunes += databaseCount(
        result.changedCommuneCount,
        'changed commune count',
      );
      summary.changedDays += databaseCount(
        result.changedDayCount,
        'changed day count',
      );
      summary.changedValues += databaseCount(
        result.changedValueCount,
        'changed value count',
      );
      summary.appliedCommunes += databaseCount(
        result.affectedCommuneCount,
        'affected commune count',
      );
      summary.batches += 1;
      process.stdout.write(
        `[restore-certified-history] cursor=${cursor} scanned=${summary.sourceCommunes} changed=${summary.changedCommunes} values=${summary.changedValues}\n`,
      );
    }
    if (
      summary.sourceCommunes !== sourceScope.communeCount ||
      summary.sourceDays !== sourceScope.dayCount ||
      summary.targetCommunes !== sourceScope.communeCount
    ) {
      throw new Error(
        `Certified repair coverage mismatch: communes=${summary.sourceCommunes}/${summary.targetCommunes}/${sourceScope.communeCount}, days=${summary.sourceDays}/${sourceScope.dayCount}`,
      );
    }
    if (options.apply && summary.appliedCommunes !== summary.changedCommunes) {
      throw new Error(
        `Certified repair apply mismatch: ${summary.appliedCommunes}/${summary.changedCommunes}`,
      );
    }
    if (options.apply) {
      summary.validatedCommunes = await finalValidation(
        sourceRunner,
        target,
        expectedContext,
        options,
      );
      if (summary.validatedCommunes !== sourceScope.communeCount) {
        throw new Error(
          `Certified final validation mismatch: ${summary.validatedCommunes}/${sourceScope.communeCount}`,
        );
      }
    }
    await sourceRunner.commitTransaction();
    return summary;
  } catch (error) {
    if (sourceRunner.isTransactionActive) {
      await sourceRunner.rollbackTransaction();
    }
    throw error;
  } finally {
    await sourceRunner.release();
  }
}

export function certifiedHistoryFingerprint(
  days: CertifiedSourceDay[],
): string {
  const canonical = [...days]
    .sort(
      (left, right) =>
        left.code.localeCompare(right.code) ||
        left.date.localeCompare(right.date),
    )
    .map((day) =>
      JSON.stringify([day.code, day.date, day.SOU, day.SUP, day.AEP]),
    )
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

export async function main(): Promise<void> {
  const options = parseRestoreCertifiedHistoryOptions();
  const source = standaloneDataSource(
    requiredEnvironment(process.env, 'CERTIFIED_HISTORY_SOURCE_DATABASE_URL'),
    true,
    true,
  );
  const target = standaloneDataSource(
    requiredEnvironment(process.env, 'CERTIFIED_HISTORY_TARGET_DATABASE_URL'),
    !options.apply,
  );
  try {
    await source.initialize();
    await target.initialize();
    const summary = await restoreCertifiedCommuneHistory(
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
    console.error('[restore-certified-history] failed');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
