import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { Client } from 'pg';
import { auditActor, systemAuditContext } from '../audit/audit-context';
import {
  EQUIVALENCE_FROM,
  EQUIVALENCE_THROUGH,
  HISTORY_SOURCE_EQUIVALENCE_SQL,
  sourceEquivalenceEvidence,
} from './history-source-equivalence';
import {
  validateCommuneDay,
  validateDepartmentDay,
  validateStatisticDay,
} from './build-certified-history-source';

export const NOVEMBER_RECOVERY_SOURCES = [
  {
    date: '2026-11-13',
    backupId: '6af7a48b9982694c45ec87e6',
    sourceRevision: '169371',
    historicComputeEpoch: '1447',
  },
  {
    date: '2026-11-14',
    backupId: '6af8f64499c3cdf2e29e5563',
    sourceRevision: '169371',
    historicComputeEpoch: '1447',
  },
  {
    date: '2026-11-15',
    backupId: '6afa47ca9982694c45ece5bf',
    sourceRevision: '169372',
    historicComputeEpoch: '1447',
  },
] as const;
export const NOVEMBER_RECOVERY_RUN_ID = 'vigieau-november-2026-recovery-v1';
export const NOVEMBER_RECOVERY_DATES = NOVEMBER_RECOVERY_SOURCES.map(
  ({ date }) => date,
);
const COMMUNE_COUNT = 34_943;
const DEPARTMENT_COUNT = 101;
const MONTH = '2026-11';
const ACTION = 'statistics.import_november_2026';
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_FILE_SIZE = 64 * 1024 * 1024;
type JsonObject = Record<string, any>;

export interface RecoverySource {
  date: string;
  backupId: string;
  dumpSha256: string;
  sourceDatabase: string;
  sourceRevision: string;
  historicComputeEpoch: string;
  geometryEvidenceSha256: string;
  statisticInputDigest: string;
  payloadFile: string;
  payloadSha256: string;
}
export interface RecoveryDay {
  source: RecoverySource;
  communes: Array<{ code: string; restriction: JsonObject }>;
  departments: Array<{ code: string; restriction: JsonObject }>;
  statistic: { date: string; departementSituation: JsonObject };
}
export interface RecoveryBundle {
  manifestSha256: string;
  days: RecoveryDay[];
}
export interface RecoveryDatabase {
  query(
    sql: string,
    parameters?: any[],
  ): Promise<{ rows: any[]; rowCount: number | null }>;
}
export interface RecoveryOptions {
  apply: boolean;
  expectedDatabase: string;
  expectedContext?: string;
  operator: string;
  batchSize?: number;
  onProgress?: (progress: Record<string, number>) => void;
}

export function canonicalJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function recoveryDigest(value: any): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
function object(value: any, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value;
}
function exactKeys(value: JsonObject, keys: string[], label: string): void {
  if (
    canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())
  )
    throw new Error(`${label} has unexpected fields`);
}
function uniqueCodes(
  rows: Array<{ code: string }>,
  count: number,
  label: string,
): string[] {
  const codes = rows.map(({ code }) => code).sort();
  if (codes.length !== count || new Set(codes).size !== count)
    throw new Error(
      `${label} coverage must contain exactly ${count} unique codes`,
    );
  return codes;
}

export function validateRecoveryPayload(
  payloadValue: any,
  source: RecoverySource,
): RecoveryDay {
  const payload = object(payloadValue, 'Payload');
  exactKeys(
    payload,
    ['date', 'communes', 'departments', 'statistic'],
    'Payload',
  );
  if (
    payload.date !== source.date ||
    !Array.isArray(payload.communes) ||
    !Array.isArray(payload.departments)
  )
    throw new Error('Payload date or collections are invalid');
  const communes = payload.communes.map((value) => {
    const { code, ...restriction } = object(value, 'Commune');
    const validated = validateCommuneDay(
      code,
      restriction,
      source.date,
      source.date,
    );
    return { code: validated.code, restriction };
  });
  uniqueCodes(communes, COMMUNE_COUNT, 'Commune');
  const departments = payload.departments.map((value) => {
    const entry = object(value, 'Department');
    exactKeys(entry, ['code', 'restriction'], 'Department');
    const validated = validateDepartmentDay(
      entry.code,
      entry.restriction,
      source.date,
      source.date,
    );
    exactKeys(
      validated.restriction,
      ['date', 'SOU', 'SUP', 'AEP'],
      'Department restriction',
    );
    return { code: validated.code, restriction: validated.restriction };
  });
  const departmentCodes = uniqueCodes(
    departments,
    DEPARTMENT_COUNT,
    'Department',
  );
  const statistic = object(payload.statistic, 'National statistic');
  // Analytics are independent from restrictions and must never be restored.
  exactKeys(statistic, ['date', 'departementSituation'], 'National statistic');
  validateStatisticDay(
    source.date,
    statistic,
    departmentCodes,
    source.date,
    source.date,
  );
  return {
    source,
    communes,
    departments,
    statistic: statistic as RecoveryDay['statistic'],
  };
}

async function readBoundedFile(path: string): Promise<Buffer> {
  if ((await stat(path)).size > MAX_FILE_SIZE)
    throw new Error('Recovery file exceeds 64 MiB');
  return readFile(path);
}
export async function loadRecoveryBundle(
  manifestPath: string,
): Promise<RecoveryBundle> {
  const bytes = await readBoundedFile(manifestPath);
  const manifest = object(JSON.parse(bytes.toString('utf8')), 'Manifest');
  exactKeys(manifest, ['version', 'runId', 'days'], 'Manifest');
  if (
    manifest.version !== 1 ||
    manifest.runId !== NOVEMBER_RECOVERY_RUN_ID ||
    !Array.isArray(manifest.days) ||
    manifest.days.length !== 3
  )
    throw new Error('Manifest must identify the approved three-day recovery');
  const days: RecoveryDay[] = [];
  for (const expected of NOVEMBER_RECOVERY_SOURCES) {
    const source = manifest.days.find(
      (day) => day.date === expected.date,
    ) as RecoverySource;
    if (!source || source.backupId !== expected.backupId)
      throw new Error(`Wrong dated backup for ${expected.date}`);
    exactKeys(
      source,
      [
        'date',
        'backupId',
        'dumpSha256',
        'sourceDatabase',
        'sourceRevision',
        'historicComputeEpoch',
        'geometryEvidenceSha256',
        'statisticInputDigest',
        'payloadFile',
        'payloadSha256',
      ],
      'Manifest source',
    );
    for (const digest of [
      source.dumpSha256,
      source.geometryEvidenceSha256,
      source.statisticInputDigest,
      source.payloadSha256,
    ])
      if (!SHA256.test(digest))
        throw new Error('Manifest provenance requires SHA256 digests');
    if (
      !source.sourceDatabase ||
      !/^\d+$/.test(source.sourceRevision) ||
      source.sourceRevision !== expected.sourceRevision ||
      source.historicComputeEpoch !== expected.historicComputeEpoch
    )
      throw new Error('Invalid source database/revision/epoch');
    const path = resolve(dirname(manifestPath), source.payloadFile);
    const local = relative(resolve(dirname(manifestPath)), path);
    if (!local || local.startsWith('..') || isAbsolute(local))
      throw new Error('Payload must reside beside its manifest');
    const payload = await readBoundedFile(path);
    if (
      createHash('sha256').update(payload).digest('hex') !==
      source.payloadSha256
    )
      throw new Error(`Payload digest mismatch for ${source.date}`);
    days.push(
      validateRecoveryPayload(JSON.parse(payload.toString('utf8')), source),
    );
  }
  return {
    manifestSha256: createHash('sha256').update(bytes).digest('hex'),
    days,
  };
}

/** Retains original items verbatim; an existing divergent target is fatal. */
export function mergeRecoveryDays(
  original: any,
  incoming: JsonObject[],
): { value: JsonObject[]; added: number } {
  if (original !== null && !Array.isArray(original))
    throw new Error('Existing daily restrictions are not an array');
  const value: JsonObject[] = [...(original ?? [])];
  const byDate = new Map<string, JsonObject>();
  for (const day of value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day?.date) || byDate.has(day.date))
      throw new Error('Existing daily dates are invalid or duplicated');
    byDate.set(day.date, day);
  }
  let added = 0;
  for (const day of [...incoming].sort((a, b) =>
    a.date.localeCompare(b.date),
  )) {
    if (!NOVEMBER_RECOVERY_DATES.includes(day.date))
      throw new Error('Attempt to import outside the approved dates');
    const existing = byDate.get(day.date);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(day))
        throw new Error(`Existing restriction diverges on ${day.date}`);
      continue;
    }
    const index = value.findIndex((entry) => entry.date > day.date);
    value.splice(index < 0 ? value.length : index, 0, day);
    byDate.set(day.date, day);
    added++;
  }
  return { value, added };
}

export function recoverNovemberMonth(
  original: any,
  days: JsonObject[],
): JsonObject[] {
  if (original !== null && !Array.isArray(original))
    throw new Error('Existing monthly restrictions are not an array');
  const months: JsonObject[] = [...(original ?? [])];
  const matching = months.filter((month) => month.date === MONTH);
  if (matching.length > 1)
    throw new Error('Duplicate November monthly statistic');
  const weights = { vigilance: 0.5, alerte: 2, alerte_renforcee: 3, crise: 4 };
  const ponderation = days
    .filter((day) => day.date.startsWith(`${MONTH}-`))
    .reduce((sum, day) => {
      const values = ['SOU', 'SUP', 'AEP'].map((type) => {
        if (
          day[type] !== null &&
          !Object.prototype.hasOwnProperty.call(weights, day[type])
        )
          throw new Error('Invalid November daily severity');
        return day[type] === null ? 0 : weights[day[type]];
      });
      return sum + Math.max(...values);
    }, 0);
  const replacement = { ...(matching[0] ?? {}), date: MONTH, ponderation };
  const index = months.findIndex((month) => month.date === MONTH);
  if (index < 0) months.push(replacement);
  else months[index] = replacement;
  return months;
}

export const RECOVERY_STATE_SQL = `
  SELECT current_database() AS database,
    to_jsonb(config) AS config, to_jsonb(source) AS source,
    to_jsonb(state) AS statistics, to_jsonb(zones) AS zones,
    (SELECT coalesce(jsonb_agg(to_jsonb(invalidation) || jsonb_build_object('affectedDates',
      (SELECT coalesce(jsonb_agg(day::text ORDER BY day), '[]') FROM unnest($1::date[]) dates(day)
        WHERE invalidation."affectedRange" @> day)) ORDER BY invalidation."epochAfter"), '[]')
      FROM historic_range_invalidation invalidation WHERE invalidation."epochAfter" > 1447) AS invalidations,
    (SELECT coalesce(jsonb_agg(to_jsonb(repair) ORDER BY repair.id), '[]') FROM certified_history_repair_audit repair) AS repairs,
    (SELECT coalesce(jsonb_agg(to_jsonb(attestation) ORDER BY attestation.id), '[]') FROM certified_history_repair_attestation attestation) AS attestations,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(snapshot) ORDER BY snapshot."snapshotDate", snapshot.scope)::text, '[]'))
      FROM statistic_commune_snapshot snapshot WHERE NOT (snapshot."snapshotDate" = ANY($1::date[]) AND snapshot.scope = 'national')) AS "outsideSnapshots",
    EXISTS(SELECT 1 FROM current_zone_recompute_request request WHERE request."currentPending"
      OR EXISTS(SELECT 1 FROM unnest(request."pendingScheduledDates") due(date) WHERE due.date <= (now() AT TIME ZONE 'Europe/Paris')::date)) AS "currentPending",
    EXISTS(SELECT 1 FROM external_publication_run run WHERE run.status = 'running' AND run."jobKey" IN ('compute:national-daily', 'compute:historic-catchup')) AS "runningPublication",
    EXISTS(SELECT 1 FROM historic_backfill_run run WHERE run.status IN ('preparing', 'running')) AS "runningHistory",
    EXISTS(SELECT 1 FROM zone_publication publication WHERE publication.id = zones."activePublicationId" AND publication.status = 'active'
      AND publication."sourceRevision" = source."publicRevision" AND (publication."sourceComputedAt" AT TIME ZONE 'Europe/Paris')::date = state."currentPublishedDate") AS "currentMapFresh",
    EXISTS(SELECT 1 FROM statistic_commune_snapshot snapshot WHERE snapshot."snapshotDate" = state."currentPublishedDate" AND snapshot.scope = 'national'
      AND snapshot.status = 'completed' AND snapshot."sourceRevision" = source."publicRevision" AND snapshot."expectedCommuneCount" = ${COMMUNE_COUNT}
      AND snapshot."processedCommuneCount" = ${COMMUNE_COUNT}) AS "currentSnapshotFresh"
  FROM config CROSS JOIN zone_publication_source_state source CROSS JOIN statistic_publication_state state CROSS JOIN zone_publication_state zones
  WHERE config.id = 1 AND source.id = 1 AND state.id = 1 AND zones.id = 1
`;
function assertRecoveryState(
  state: JsonObject,
  options: RecoveryOptions,
  bundle: RecoveryBundle,
): void {
  if (
    !state ||
    state.database !== options.expectedDatabase ||
    bundle.days.some(({ source }) => source.sourceDatabase === state.database)
  )
    throw new Error('Unexpected target database');
  if (
    state.currentPending ||
    state.runningPublication ||
    state.runningHistory ||
    !state.currentMapFresh ||
    !state.currentSnapshotFresh
  )
    throw new Error(
      'Current publication has priority or is not fully certified',
    );
  if (state.statistics.currentPublishedDate <= '2026-11-15')
    throw new Error('Recovery dates must precede the current publication');
  if (
    state.repairs.some(
      (repair) =>
        repair.dateFrom <= '2026-11-15' && repair.dateThrough >= '2026-11-13',
    )
  )
    throw new Error('An existing certified repair overlaps the target dates');
}
export function recoveryInputSql(date: string): string {
  if (
    !NOVEMBER_RECOVERY_DATES.includes(
      date as (typeof NOVEMBER_RECOVERY_DATES)[number],
    )
  )
    throw new Error('Input evidence date is outside the approved recovery');
  // Keep the existing projection unchanged, including its conservative geometry
  // and parameter checks; only narrow both inclusive bounds to this one day.
  return HISTORY_SOURCE_EQUIVALENCE_SQL.replaceAll(
    EQUIVALENCE_FROM,
    date,
  ).replaceAll(EQUIVALENCE_THROUGH, date);
}
export async function readRecoveryInputEvidence(
  database: RecoveryDatabase,
  date: string,
) {
  const result = await database.query(recoveryInputSql(date));
  return sourceEquivalenceEvidence(result.rows.map(({ value }) => value));
}
export async function assertRecoverySourceValidity(
  database: RecoveryDatabase,
  state: JsonObject,
  bundle: RecoveryBundle,
): Promise<void> {
  const through = BigInt(state.config.historicComputeEpoch);
  for (const { source } of bundle.days) {
    if (!SHA256.test(source.statisticInputDigest))
      throw new Error('Missing dated statistical input evidence');
    let epoch = BigInt(source.historicComputeEpoch);
    if (epoch > through) throw new Error('Source epoch is ahead of production');
    const ledger = state.invalidations.filter(
      (entry) => BigInt(entry.epochAfter) > epoch,
    );
    for (const entry of ledger) {
      epoch++;
      if (BigInt(entry.epochAfter) !== epoch || epoch > through)
        throw new Error('Historic invalidation ledger is incomplete');
    }
    if (epoch !== through)
      throw new Error('Historic invalidation ledger is incomplete');
    if (
      String(state.source.publicRevision) !== source.sourceRevision ||
      ledger.some(
        (entry) =>
          entry.invalidatesStatistics &&
          entry.affectedDates.includes(source.date),
      )
    ) {
      const evidence = await readRecoveryInputEvidence(database, source.date);
      if (evidence.digest !== source.statisticInputDigest)
        throw new Error(
          `Historical statistical inputs diverge on ${source.date}`,
        );
    }
  }
}
async function readState(
  database: RecoveryDatabase,
  lock = false,
): Promise<JsonObject> {
  const { rows } = await database.query(
    `${RECOVERY_STATE_SQL}${lock ? ' FOR SHARE OF config, source, state, zones' : ''}`,
    [NOVEMBER_RECOVERY_DATES],
  );
  if (rows.length !== 1) throw new Error('Publication context is not unique');
  return rows[0];
}
async function assertSameState(
  database: RecoveryDatabase,
  before: JsonObject,
  lock = false,
): Promise<void> {
  if (
    recoveryDigest(await readState(database, lock)) !== recoveryDigest(before)
  )
    throw new Error('Publication context changed during recovery');
}
const LOCKS = [
  "hashtext('vigieau'), hashtext('current-zone-recompute')",
  "hashtext('vigieau'), hashtext('sandre-zone-sync')",
  "hashtext('vigieau'), hashtext('zone-compute-historic')",
  "hashtext('vigieau'), hashtext('zone-compute-global')",
  "hashtext('vigieau:statistic-commune:snapshot-computation')",
  "hashtext('vigieau:zone-publication-stable-promotion')",
];
async function audit(
  database: RecoveryDatabase,
  operationId: string,
  phase: string,
  operator: string,
  metadata: JsonObject,
): Promise<void> {
  await database.query(
    `INSERT INTO audit_event (id, operation_id, phase, action, actor, source, request_id, metadata)
    VALUES ($1,$2,$3,$4,$5::jsonb,'system',$2,$6::jsonb)`,
    [
      randomUUID(),
      operationId,
      phase,
      ACTION,
      JSON.stringify(auditActor(null)),
      JSON.stringify({ ...metadata, operator }),
    ],
  );
}

// Scan the target history once on the server. Only November values and insertion
// positions cross the connection; xmin fences both daily and monthly JSONB.
export const RECOVERY_COMMUNE_PROJECTION_SQL = `
  SELECT statistic.id, commune.code, statistic.xmin::text AS version,
    daily.days AS restrictions, daily."validDates", daily."uniqueDates", daily."dayCount",
    daily.positions, monthly.months AS "restrictionsByMonth", monthly.position AS "monthPosition"
  FROM statistic_commune statistic JOIN commune ON commune.id = statistic."communeId"
  CROSS JOIN LATERAL (
    SELECT coalesce(jsonb_agg(value ORDER BY ordinal) FILTER (WHERE value->>'date' LIKE '2026-11-%'), '[]') AS days,
      coalesce(bool_and(jsonb_typeof(value)='object' AND coalesce(value->>'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',false)),true) AS "validDates",
      count(*)::integer AS "dayCount",count(DISTINCT value->>'date')::integer AS "uniqueDates",
      jsonb_build_object(
        '2026-11-13',coalesce(min(ordinal-1) FILTER (WHERE value->>'date'>'2026-11-13'),count(*)),
        '2026-11-14',coalesce(min(ordinal-1) FILTER (WHERE value->>'date'>'2026-11-14'),count(*)),
        '2026-11-15',coalesce(min(ordinal-1) FILTER (WHERE value->>'date'>'2026-11-15'),count(*))) AS positions
    FROM jsonb_array_elements(coalesce(statistic.restrictions,'[]'::jsonb)) WITH ORDINALITY history(value,ordinal)
  ) daily
  CROSS JOIN LATERAL (
    SELECT coalesce(jsonb_agg(value ORDER BY ordinal) FILTER (WHERE value->>'date'='2026-11'),'[]') AS months,
      coalesce(min(ordinal-1) FILTER (WHERE value->>'date'='2026-11'),count(*))::integer AS position
    FROM jsonb_array_elements(coalesce(statistic."restrictionsByMonth",'[]'::jsonb)) WITH ORDINALITY history(value,ordinal)
  ) monthly
  WHERE commune.code=ANY($1::text[]) ORDER BY commune.code
`;
export const RECOVERY_COMMUNE_MERGE_SQL = `
  WITH changes AS MATERIALIZED (
    SELECT * FROM jsonb_to_recordset($1::jsonb) change(id integer,version text,additions jsonb,month jsonb,"monthPosition" integer)
  ), original AS (
    SELECT change.*,coalesce(target.restrictions,'[]'::jsonb) AS value
    FROM statistic_commune target JOIN changes change ON target.id=change.id AND target.xmin::text=change.version
  ), first_day AS (
    SELECT original.*,CASE WHEN jsonb_array_length(additions)>0
      THEN jsonb_insert(value,ARRAY[additions->0->>'index'],additions->0->'value') ELSE value END AS first_value FROM original
  ), second_day AS (
    SELECT first_day.*,CASE WHEN jsonb_array_length(additions)>1
      THEN jsonb_insert(first_value,ARRAY[additions->1->>'index'],additions->1->'value') ELSE first_value END AS second_value FROM first_day
  ), third_day AS (
    SELECT second_day.*,CASE WHEN jsonb_array_length(additions)>2
      THEN jsonb_insert(second_value,ARRAY[additions->2->>'index'],additions->2->'value') ELSE second_value END AS merged_value FROM second_day
  )
  UPDATE statistic_commune target SET restrictions=change.merged_value,
    "restrictionsByMonth"=jsonb_set(coalesce(target."restrictionsByMonth",'[]'::jsonb),ARRAY[change."monthPosition"::text],change.month,true)
  FROM third_day change WHERE target.id=change.id AND target.xmin::text=change.version RETURNING target.id
`;

export async function importNovemberStatistics(
  database: RecoveryDatabase,
  bundle: RecoveryBundle,
  options: RecoveryOptions,
): Promise<JsonObject> {
  const startedAt = Date.now();
  const operationId = systemAuditContext(ACTION).operationId;
  if (
    options.apply &&
    (!SHA256.test(options.expectedContext ?? '') || !options.operator)
  )
    throw new Error('Apply requires the dry-run context and operator identity');
  if (
    bundle.days.length !== 3 ||
    bundle.days.some(
      (day, index) =>
        day.source.date !== NOVEMBER_RECOVERY_SOURCES[index].date ||
        day.source.backupId !== NOVEMBER_RECOVERY_SOURCES[index].backupId ||
        day.source.sourceRevision !==
          NOVEMBER_RECOVERY_SOURCES[index].sourceRevision ||
        day.source.historicComputeEpoch !==
          NOVEMBER_RECOVERY_SOURCES[index].historicComputeEpoch,
    )
  )
    throw new Error('Recovery bundle is outside the approved scope');
  const batchSize = options.batchSize ?? 100;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500)
    throw new Error('Batch size must be between 1 and 500');
  const locked: string[] = [];
  let transaction = false;
  let auditStarted = false;
  const metadata = {
    runId: NOVEMBER_RECOVERY_RUN_ID,
    manifestSha256: bundle.manifestSha256,
    dates: NOVEMBER_RECOVERY_DATES,
    sources: bundle.days.map(({ source }) => source),
  };
  try {
    for (const lock of LOCKS) {
      const result = await database.query(
        `SELECT pg_try_advisory_lock(${lock}) AS locked`,
      );
      if (result.rows[0]?.locked !== true)
        throw new Error(
          'Current computation or another recovery owns a required lock',
        );
      locked.push(lock);
    }
    await database.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY');
    transaction = true;
    await database.query(
      "SELECT set_config('lock_timeout', '1000ms', true), set_config('statement_timeout', '120000ms', true), set_config('transaction_timeout', '300000ms', true)",
    );
    const before = await readState(database);
    assertRecoveryState(before, options, bundle);
    await assertRecoverySourceValidity(database, before, bundle);
    await assertSameState(database, before);
    const context = recoveryDigest({
      state: before,
      manifestSha256: bundle.manifestSha256,
    });
    if (options.apply && context !== options.expectedContext)
      throw new Error('Dry-run context no longer matches production');
    const communes = (
      await database.query('SELECT code FROM commune ORDER BY code')
    ).rows.map(({ code }) => code);
    const departments = (
      await database.query('SELECT code FROM departement ORDER BY code')
    ).rows.map(({ code }) => code);
    if (
      communes.length !== COMMUNE_COUNT ||
      departments.length !== DEPARTMENT_COUNT
    )
      throw new Error('Target reference coverage has changed');
    for (const day of bundle.days) {
      if (
        canonicalJson(uniqueCodes(day.communes, COMMUNE_COUNT, 'Commune')) !==
          canonicalJson(communes) ||
        canonicalJson(
          uniqueCodes(day.departments, DEPARTMENT_COUNT, 'Department'),
        ) !== canonicalJson(departments)
      )
        throw new Error('Source and target reference codes differ');
    }
    const snapshots = (
      await database.query(
        'SELECT *, "snapshotDate"::text AS "snapshotDate" FROM statistic_commune_snapshot WHERE "snapshotDate" = ANY($1::date[])',
        [NOVEMBER_RECOVERY_DATES],
      )
    ).rows;
    for (const snapshot of snapshots) {
      if (
        snapshot.scope !== 'national' ||
        snapshot.status === 'running' ||
        snapshot.status === 'ready' ||
        snapshot.certifiedHistoryRepairId !== null
      )
        throw new Error(
          'Target snapshot is running or belongs to another certification',
        );
    }
    if (options.apply) {
      await database.query(
        "SELECT set_config('vigieau.audit_context', $1, true)",
        [
          JSON.stringify({
            operationId,
            requestId: operationId,
            action: ACTION,
            source: 'system',
            actor: auditActor(null),
            metadata: { ...metadata, operator: options.operator },
          }),
        ],
      );
      await audit(database, operationId, 'started', options.operator, metadata);
      auditStarted = true;
    }
    const communeDays = new Map<string, JsonObject[]>();
    const departmentDays = new Map<string, JsonObject[]>();
    for (const day of bundle.days) {
      for (const entry of day.communes)
        communeDays.set(entry.code, [
          ...(communeDays.get(entry.code) ?? []),
          entry.restriction,
        ]);
      for (const entry of day.departments)
        departmentDays.set(entry.code, [
          ...(departmentDays.get(entry.code) ?? []),
          entry.restriction,
        ]);
    }
    let changedCommunes = 0;
    let changedDepartments = 0;
    let addedCommuneDays = 0;
    let addedDepartmentDays = 0;
    let inspectedBytes = 0;
    for (let offset = 0; offset < communes.length; offset += batchSize) {
      await assertSameState(database, before);
      const codes = communes.slice(offset, offset + batchSize);
      const rows = (
        await database.query(RECOVERY_COMMUNE_PROJECTION_SQL, [codes])
      ).rows;
      if (rows.length !== codes.length)
        throw new Error('Target commune statistics are incomplete');
      inspectedBytes += Buffer.byteLength(JSON.stringify(rows));
      const changes = [];
      for (const row of rows) {
        if (row.validDates !== true || row.uniqueDates !== row.dayCount)
          throw new Error(
            'Target daily history has invalid or duplicated dates',
          );
        const incoming = communeDays.get(row.code);
        if (!incoming)
          throw new Error('Target commune code is outside the source');
        const merged = mergeRecoveryDays(row.restrictions, incoming);
        const months = recoverNovemberMonth(
          row.restrictionsByMonth,
          merged.value,
        );
        addedCommuneDays += merged.added;
        if (
          canonicalJson(merged.value) !== canonicalJson(row.restrictions) ||
          canonicalJson(months) !== canonicalJson(row.restrictionsByMonth)
        )
          changes.push({
            id: row.id,
            version: row.version,
            additions: incoming
              .filter(
                (entry) =>
                  !row.restrictions.some(
                    (existing) => existing.date === entry.date,
                  ),
              )
              .map((value, index) => ({
                index: Number(row.positions[value.date]) + index,
                value,
              })),
            month: months[0],
            monthPosition: row.monthPosition,
          });
      }
      changedCommunes += changes.length;
      if (options.apply && changes.length) {
        const result = await database.query(RECOVERY_COMMUNE_MERGE_SQL, [
          JSON.stringify(changes),
        ]);
        if (result.rows.length !== changes.length)
          throw new Error('Concurrent commune statistic modification');
      }
      options.onProgress?.({
        processedCommunes: Math.min(offset + batchSize, communes.length),
        totalCommunes: communes.length,
        changedCommunes,
        inspectedBytes,
        elapsedMs: Date.now() - startedAt,
      });
    }
    await assertSameState(database, before);
    const departmentRows = (
      await database.query(`SELECT statistic.id, departement.code, statistic.restrictions FROM statistic_departement statistic
      JOIN departement ON departement.id = statistic."departementId" ORDER BY departement.code`)
    ).rows;
    if (departmentRows.length !== DEPARTMENT_COUNT)
      throw new Error('Target department statistics are incomplete');
    for (const row of departmentRows) {
      const incoming = departmentDays.get(row.code);
      if (!incoming)
        throw new Error('Target department code is outside the source');
      const merged = mergeRecoveryDays(row.restrictions, incoming);
      addedDepartmentDays += merged.added;
      if (!merged.added) continue;
      changedDepartments++;
      if (options.apply) {
        const result = await database.query(
          `UPDATE statistic_departement SET restrictions = $2::jsonb WHERE id = $1
          AND restrictions IS NOT DISTINCT FROM $3::jsonb RETURNING id`,
          [
            row.id,
            JSON.stringify(merged.value),
            JSON.stringify(row.restrictions),
          ],
        );
        if (result.rows.length !== 1)
          throw new Error('Concurrent department statistic modification');
      }
    }
    let changedNationalDays = 0;
    for (const day of bundle.days) {
      const rows = (
        await database.query(
          'SELECT "departementSituation" FROM statistic WHERE date = $1::date',
          [day.source.date],
        )
      ).rows;
      if (rows.length > 1) throw new Error('Duplicate national statistic');
      const situation = rows[0]?.departementSituation;
      if (
        situation !== null &&
        situation !== undefined &&
        canonicalJson(situation) !==
          canonicalJson(day.statistic.departementSituation)
      )
        throw new Error(`National statistic diverges on ${day.source.date}`);
      if (situation !== null && situation !== undefined) continue;
      changedNationalDays++;
      if (options.apply) {
        const result = await database.query(
          `INSERT INTO statistic (date, "departementSituation") VALUES ($1::date, $2::json)
          ON CONFLICT (date) DO UPDATE SET "departementSituation" = EXCLUDED."departementSituation"
          WHERE statistic."departementSituation" IS NULL RETURNING date`,
          [day.source.date, JSON.stringify(day.statistic.departementSituation)],
        );
        if (result.rows.length !== 1)
          throw new Error('Concurrent national statistic modification');
      }
    }
    // Ordinary source edits remain possible before this short final fence;
    // any concurrent revision makes the entire import roll back.
    await assertSameState(database, before, options.apply);
    let certifiedDays = 0;
    for (const day of bundle.days) {
      const existing = snapshots.find(
        (snapshot) => snapshot.snapshotDate === day.source.date,
      );
      if (existing?.status === 'completed') {
        if (
          Number(existing.expectedCommuneCount) !== COMMUNE_COUNT ||
          Number(existing.processedCommuneCount) !== COMMUNE_COUNT ||
          String(existing.sourceRevision) !== day.source.sourceRevision
        )
          throw new Error(
            'An existing completed snapshot has different provenance',
          );
        continue;
      }
      certifiedDays++;
      if (options.apply) {
        const result = await database.query(
          `INSERT INTO statistic_commune_snapshot
          ("snapshotDate", scope, status, "expectedCommuneCount", "processedCommuneCount", "sourceRevision", "startedAt", "completedAt", "lastError", "createdAt", "updatedAt")
          VALUES ($1::date, 'national', 'completed', $2, $2, $3::bigint, now(), now(), NULL, now(), now())
          ON CONFLICT ("snapshotDate", scope) DO UPDATE SET status='completed', "expectedCommuneCount"=$2,
            "processedCommuneCount"=$2, "sourceRevision"=$3::bigint, "completedAt"=now(), "lastError"=NULL, "updatedAt"=now()
          WHERE statistic_commune_snapshot.status IN ('failed','partial') AND statistic_commune_snapshot."certifiedHistoryRepairId" IS NULL
          RETURNING "snapshotDate"`,
          [day.source.date, COMMUNE_COUNT, day.source.sourceRevision],
        );
        if (result.rows.length !== 1)
          throw new Error('Target snapshot changed before certification');
      }
    }
    await assertSameState(database, before, options.apply);
    const changed =
      changedCommunes +
      changedDepartments +
      changedNationalDays +
      certifiedDays;
    let revision = String(before.statistics.revision);
    if (options.apply && changed) {
      const result = await database.query(
        `UPDATE statistic_publication_state SET revision = revision + 1, "updatedAt" = now()
        WHERE id = 1 AND revision = $1::bigint RETURNING revision::text`,
        [revision],
      );
      if (result.rows.length !== 1)
        throw new Error('Statistic revision changed before publication');
      revision = result.rows[0].revision;
    }
    const after = await readState(database);
    after.statistics.revision = before.statistics.revision;
    after.statistics.updatedAt = before.statistics.updatedAt;
    if (recoveryDigest(after) !== recoveryDigest(before))
      throw new Error(
        'Protected publication or historical certification changed',
      );
    const report = {
      status: options.apply ? (changed ? 'APPLIED' : 'UNCHANGED') : 'DRY_RUN',
      operationId,
      context,
      manifestSha256: bundle.manifestSha256,
      database: before.database,
      changedCommunes,
      changedDepartments,
      addedCommuneDays,
      addedDepartmentDays,
      changedNationalDays,
      certifiedDays,
      inspectedBytes,
      elapsedMs: Date.now() - startedAt,
      revisionBefore: String(before.statistics.revision),
      revisionAfter: revision,
    };
    if (options.apply)
      await audit(database, operationId, 'succeeded', options.operator, {
        ...metadata,
        ...report,
      });
    await database.query(options.apply ? 'COMMIT' : 'ROLLBACK');
    transaction = false;
    return report;
  } catch (error) {
    if (transaction) {
      try {
        await database.query('ROLLBACK');
      } catch {
        /* A transaction timeout disconnects and rolls back the session. */
      }
    }
    if (auditStarted) {
      try {
        await audit(database, operationId, 'failed', options.operator, {
          ...metadata,
          error: (error instanceof Error ? error.message : String(error)).slice(
            0,
            500,
          ),
        });
      } catch {
        // Preserve the original failure; no data transaction was committed.
      }
    }
    throw error;
  } finally {
    for (const lock of locked.reverse()) {
      try {
        await database.query(`SELECT pg_advisory_unlock(${lock})`);
      } catch {
        /* Disconnection releases session locks. */
      }
    }
  }
}

export async function main(): Promise<void> {
  const manifestPath = process.env.NOVEMBER_RECOVERY_MANIFEST;
  const expectedDatabase = process.env.NOVEMBER_RECOVERY_EXPECTED_DATABASE;
  const connectionString = process.env.NOVEMBER_RECOVERY_DATABASE_URL;
  if (!manifestPath || !expectedDatabase || !connectionString)
    throw new Error(
      'Set NOVEMBER_RECOVERY_MANIFEST, NOVEMBER_RECOVERY_EXPECTED_DATABASE and NOVEMBER_RECOVERY_DATABASE_URL',
    );
  const applyValue = process.env.NOVEMBER_RECOVERY_APPLY ?? 'false';
  if (!['true', 'false'].includes(applyValue))
    throw new Error('NOVEMBER_RECOVERY_APPLY must be true or false');
  const apply = applyValue === 'true';
  if (
    apply &&
    process.env.NOVEMBER_RECOVERY_CONFIRMATION !==
      'IMPORT_CERTIFIED_NOVEMBER_2026_STATS'
  )
    throw new Error('Apply confirmation is required');
  const bundle = await loadRecoveryBundle(resolve(manifestPath));
  const client = new Client({
    connectionString,
    application_name: 'vigieau-november-statistics-recovery',
  });
  await client.connect();
  try {
    const result = await importNovemberStatistics(client, bundle, {
      apply,
      expectedDatabase,
      expectedContext: process.env.NOVEMBER_RECOVERY_EXPECTED_CONTEXT,
      operator: process.env.NOVEMBER_RECOVERY_OPERATOR ?? '',
      onProgress: (progress) =>
        process.stderr.write(
          `${JSON.stringify({ phase: 'communes', ...progress })}\n`,
        ),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await client.end();
  }
}
if (require.main === module) {
  void main().catch((error) => {
    console.error(
      `[november-statistics-recovery] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
