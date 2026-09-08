import 'reflect-metadata';
import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { DataSource, QueryRunner } from 'typeorm';
import { CERTIFIED_HISTORY_V2_CERTIFIED_MANIFEST as PINNED } from './restore-certified-commune-history';
import { CERTIFIED_HISTORY_V2_SOURCE_RUN_ID } from './build-certified-history-source';
import {
  CERTIFIED_COMPLETION_ATTESTATION_SQL,
  CERTIFIED_COMPLETION_INITIAL_ATTESTATION_SQL,
} from './complete-certified-history-restoration';
import {
  RepairPublicationContext,
  parseBoolean,
  publicationContext,
  requiredEnvironment,
  standaloneDataSource,
} from './restore-missing-commune-history';
import {
  EQUIVALENCE_FROM as FROM,
  EQUIVALENCE_THROUGH as THROUGH,
  EquivalenceInput,
  HISTORY_SOURCE_EQUIVALENCE_SQL,
  canonicalEquivalenceJson,
  equivalenceDigest,
  sourceEquivalenceEvidence,
} from './history-source-equivalence';

export const EQUIVALENCE_ANCHOR = {
  backupId: '6a98b8a299826944b3817689',
  archiveSha256:
    '512d20144d6de2455b243f45137ec96ac47c53c42a735992580ab29fa97e81ed',
  repairId: '2d8f1cf4-ad79-492a-82cf-ac57c428f8f1',
  attestationId: 'e38866f3-838f-4a74-bc0f-3370cd179e7a',
  historicComputeEpoch: '796',
  inputDigest:
    'f93f95a4c63b6f9c5558265118c59bf01a578bb2813ef72c701807562ef3c725',
} as const;
const MODE = 'attest-by-source-equivalence';
const CONFIRMATION = 'ATTEST_HISTORY_BY_SOURCE_EQUIVALENCE';
const MAX_INSPECTION_MS = 15 * 60_000;
export const EQUIVALENCE_INSPECTION_SETTINGS_SQL =
  "SET LOCAL jit=off; SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='50ms'; SET LOCAL idle_in_transaction_session_timeout='15s'";
export const EQUIVALENCE_INPUT_BATCH_SQL =
  'FETCH FORWARD 100 FROM equivalence_inputs';
const SOURCE_TABLES = [
  'zone_alerte',
  'restriction',
  'usage',
  'arrete_restriction',
  'arrete_cadre',
  'fichier',
  'thematique',
  'parametres',
  'commune',
  'departement',
  'bassin_versant',
  'arrete_cadre_zone_alerte_communes',
  'ac_za_communes',
  'arrete_cadre_arrete_restriction',
  'arrete_cadre_departement',
  'arrete_cadre_zone_alerte',
  'restriction_commune',
  'bassin_versant_departement',
  'sandre_zone_alias',
] as const;

export interface EquivalenceOptions {
  apply: boolean;
  sourceDatabase: string;
  targetDatabase: string;
  archivePath: string;
  expectedProof: string | null;
}
export interface RowVersion {
  id: number;
  xmin: string;
  tableoid: string;
}
type OutputKind = 'commune' | 'department' | 'national';
interface OutputRow extends RowVersion {
  code: string;
  dayCount: number;
  distinctDayCount: number;
  invalidCount: number;
  digest: string;
  line?: string;
}
interface LedgerRow {
  epochAfter: string;
  cause: string;
  fallback: boolean;
  invalidatesStatistics: boolean;
  invalidatesMaps: boolean;
  affectedRange: string;
  sourceRevision: string | null;
  context: Record<string, unknown>;
}
export interface EquivalenceLookupGuard {
  currentCount: number;
  currentMin: string | null;
  currentMax: string | null;
  historicCount: number;
  historicMin: string | null;
  historicMax: string | null;
  sequenceLast: string;
  sequenceCalled: boolean;
  sequenceIncrement: string;
  sequenceCycle: boolean;
}
export const EQUIVALENCE_ANCHOR_LOOKUP_GUARD: EquivalenceLookupGuard = {
  currentCount: 3417,
  currentMin: '4083544',
  currentMax: '4093680',
  historicCount: 3207,
  historicMin: '33890060',
  historicMax: '33897147',
  sequenceLast: '33897162',
  sequenceCalled: true,
  sequenceIncrement: '1',
  sequenceCycle: false,
};
interface Inspection {
  operatorDigest: string;
  context: RepairPublicationContext;
  inputs: ReturnType<typeof sourceEquivalenceEvidence>;
  outputs: Record<
    OutputKind,
    { count: number; days: number; digest: string; versions: RowVersion[] }
  >;
  regionVersions: RowVersion[];
  relations: unknown[];
  ledger: LedgerRow[];
  audit: Record<string, unknown>;
  active: Record<string, unknown> | null;
  lookupGuard: EquivalenceLookupGuard;
}

// The original certified outputs remain the trust anchor, not a claim of a
// deterministic replay. The old AEP helper accidentally looks up historical
// IDs in current derived zones. Disjoint ID ranges make that lookup inactive
// at both attested states, even though current derived rows legitimately differ.
export const EQUIVALENCE_LOOKUP_GUARD_SQL = `
SELECT current_rows.*,historic_rows.*,sequence.last_value::text AS "sequenceLast",
  sequence.is_called AS "sequenceCalled",metadata.seqincrement::text AS "sequenceIncrement",
  metadata.seqcycle AS "sequenceCycle"
FROM (SELECT count(*)::integer AS "currentCount",min(id)::text AS "currentMin",max(id)::text AS "currentMax"
  FROM zone_alerte_computed) current_rows
CROSS JOIN (SELECT count(*)::integer AS "historicCount",min(id)::text AS "historicMin",max(id)::text AS "historicMax"
  FROM zone_alerte_computed_historic) historic_rows
CROSS JOIN zone_alerte_computed_historic_id_seq sequence
JOIN pg_sequence metadata ON metadata.seqrelid='zone_alerte_computed_historic_id_seq'::regclass`;

export function assertEquivalenceLookupGuard(
  row: EquivalenceLookupGuard,
): void {
  const ids = [
    row?.currentMin,
    row?.currentMax,
    row?.historicMin,
    row?.historicMax,
    row?.sequenceLast,
    row?.sequenceIncrement,
  ];
  if (
    !row ||
    !Number.isSafeInteger(row.currentCount) ||
    row.currentCount < 1 ||
    !Number.isSafeInteger(row.historicCount) ||
    row.historicCount < 1 ||
    ids.some(
      (value) => typeof value !== 'string' || !/^[1-9]\d*$/.test(value),
    ) ||
    row.sequenceCalled !== true ||
    row.sequenceCycle !== false
  ) {
    throw new Error('Historic AEP lookup independence is not proven');
  }
  const [currentMin, currentMax, historicMin, historicMax, sequenceLast] =
    ids.map((value) => BigInt(value!));
  if (
    currentMin > currentMax ||
    historicMin > historicMax ||
    currentMax >= historicMin ||
    sequenceLast < historicMax ||
    sequenceLast <= currentMax
  ) {
    throw new Error(
      'Historic AEP lookup ranges overlap or sequence moved backwards',
    );
  }
}

export function parseEquivalenceOptions(env = process.env): EquivalenceOptions {
  const apply = parseBoolean(
    'HISTORY_EQUIVALENCE_APPLY',
    env.HISTORY_EQUIVALENCE_APPLY,
  );
  const sourceDatabase = requiredEnvironment(
    env,
    'HISTORY_EQUIVALENCE_SOURCE_DATABASE',
  );
  const targetDatabase = requiredEnvironment(
    env,
    'HISTORY_EQUIVALENCE_TARGET_DATABASE',
  );
  if (
    ![sourceDatabase, targetDatabase].every((name) =>
      /^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(name),
    ) ||
    sourceDatabase === targetDatabase
  ) {
    throw new Error(
      'Equivalence requires distinct explicit source and target database names',
    );
  }
  const expectedProof = env.HISTORY_EQUIVALENCE_EXPECTED_PROOF?.trim() || null;
  if (
    apply &&
    (env.HISTORY_EQUIVALENCE_CONFIRMATION !== CONFIRMATION ||
      !/^[a-f0-9]{64}$/.test(expectedProof ?? ''))
  ) {
    throw new Error(
      `${CONFIRMATION} and the matching dry-run proof are required`,
    );
  }
  return {
    apply,
    sourceDatabase,
    targetDatabase,
    expectedProof,
    archivePath: requiredEnvironment(env, 'HISTORY_EQUIVALENCE_ANCHOR_ARCHIVE'),
  };
}

function same(actual: unknown, expected: unknown, label: string): void {
  if (canonicalEquivalenceJson(actual) !== canonicalEquivalenceJson(expected))
    throw new Error(label);
}

export function assertEquivalenceAudit(row: Record<string, unknown>): void {
  const expected = {
    id: EQUIVALENCE_ANCHOR.repairId,
    sourceRunId: CERTIFIED_HISTORY_V2_SOURCE_RUN_ID,
    dateFrom: FROM,
    dateThrough: THROUGH,
    communeCount: PINNED.communeCount,
    departmentCount: PINNED.departmentCount,
    dayCount: 52,
    activationKind: 'statistics-only',
    communeHistoryDigest: PINNED.communeHistoryDigest,
    departmentHistoryDigest: PINNED.departmentHistoryDigest,
    statisticDigest: PINNED.statisticDigest,
    provenanceDigest: PINNED.provenanceDigest,
  };
  same(
    Object.fromEntries(Object.keys(expected).map((key) => [key, row?.[key]])),
    expected,
    'Pinned repair audit mismatch',
  );
  if (
    (row.publicationContext as Record<string, unknown>)?.sourceFingerprint !==
    PINNED.sourceFingerprint
  ) {
    throw new Error('Pinned repair source fingerprint mismatch');
  }
}

export function assertEquivalenceAnchorInputs(digest: string): void {
  same(
    digest,
    EQUIVALENCE_ANCHOR.inputDigest,
    'Restored anchor inputs differ from the verified backup',
  );
}

export function assertEquivalenceLedger(
  rows: LedgerRow[],
  throughEpoch: string,
): void {
  const last = BigInt(throughEpoch);
  let expected = BigInt(EQUIVALENCE_ANCHOR.historicComputeEpoch) + 1n;
  for (const row of rows) {
    if (
      BigInt(row.epochAfter) !== expected ||
      row.cause !== 'published-source-mutation' ||
      row.fallback !== false ||
      (row.sourceRevision !== null && !/^\d+$/.test(row.sourceRevision))
    ) {
      throw new Error('Unexplained historic invalidation or incomplete ledger');
    }
    expected++;
  }
  if (expected !== last + 1n)
    throw new Error('Incomplete historic invalidation ledger');
}

export const EQUIVALENCE_LEDGER_SQL = `
SELECT "epochAfter"::text, cause, context->'fallback' AS fallback,
  "invalidatesStatistics", "invalidatesMaps", "affectedRange"::text,
  "sourceRevision"::text, context
FROM historic_range_invalidation WHERE "epochAfter">796 ORDER BY "epochAfter"`;

// Physical relation identity catches TRUNCATE/rewrites, which are not covered by
// the source DML revision trigger. Trigger definitions must remain unchanged.
export const EQUIVALENCE_RELATIONS_SQL = `
SELECT c.relname,c.oid::text,pg_relation_filenode(c.oid)::text AS filenode,
  t.tgenabled,pg_get_triggerdef(t.oid) AS trigger,
  md5(pg_get_functiondef(t.tgfoid)) AS function
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
LEFT JOIN pg_trigger t ON t.tgrelid=c.oid AND t.tgname='TRG_'||c.relname||'_zone_publication_revision'
WHERE n.nspname=current_schema() AND c.relname=ANY($1::text[]) ORDER BY c.relname`;

export function outputBatchSql(kind: OutputKind): string {
  if (kind === 'national')
    return `
    SELECT id,xmin::text,tableoid::text,date::text AS code,1 AS "dayCount",1 AS "distinctDayCount",0 AS "invalidCount",
      jsonb_build_array(date::text,to_jsonb(statistic))::text AS line
    FROM statistic WHERE date BETWEEN '${FROM}' AND '${THROUGH}' ORDER BY date`;
  const commune = kind === 'commune';
  const entity = commune ? 'commune' : 'departement';
  const statistic = commune ? 'statistic_commune' : 'statistic_departement';
  const fk = commune ? 'communeId' : 'departementId';
  const payload = commune
    ? "jsonb_build_array(day->>'date',day->>'SOU',day->>'SUP',day->>'AEP')"
    : "jsonb_build_array(day->>'date',day)";
  const shape = commune
    ? `NOT (day ?& ARRAY['date','SOU','SUP','AEP']) OR day-ARRAY['date','SOU','SUP','AEP'] <> '{}'::jsonb
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['SOU','SUP','AEP']) k WHERE day->k <> 'null'::jsonb
      AND (jsonb_typeof(day->k) IS DISTINCT FROM 'string' OR day->>k NOT IN ('vigilance','alerte','alerte_renforcee','crise')))`
    : 'false';
  return `WITH batch AS MATERIALIZED (
    SELECT e.code,s.id,s.xmin::text,s.tableoid::text,s.restrictions
    FROM ${entity} e LEFT JOIN ${statistic} s ON s."${fk}"=e.id
    WHERE e.code>$1 ORDER BY e.code LIMIT 50
  ) SELECT b.code,b.id,b.xmin,b.tableoid,days.* FROM batch b CROSS JOIN LATERAL (
    SELECT count(*)::integer AS "dayCount",count(DISTINCT day->>'date')::integer AS "distinctDayCount",
      (count(*) FILTER (WHERE jsonb_typeof(day) IS DISTINCT FROM 'object' OR (${shape}))
        + CASE WHEN jsonb_typeof(b.restrictions) IS DISTINCT FROM 'array' THEN 1 ELSE 0 END)::integer AS "invalidCount",
      encode(sha256(convert_to(string_agg(${payload}::text,E'\\n' ORDER BY day->>'date'),'UTF8')),'hex') AS digest
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.restrictions)='array' THEN b.restrictions ELSE '[]'::jsonb END) day
    WHERE day->>'date' BETWEEN '${FROM}' AND '${THROUGH}'
  ) days ORDER BY b.code`;
}

export function validateOutputRows(kind: OutputKind, rows: OutputRow[]) {
  const expectedCount =
    kind === 'commune'
      ? PINNED.communeCount
      : kind === 'department'
        ? PINNED.departmentCount
        : 52;
  const days = kind === 'national' ? 1 : 52;
  const codeHash = createHash('sha256');
  const historyHash = createHash('sha256');
  const ids = new Set<number>();
  let previous = '';
  rows.forEach((row, index) => {
    if (
      !Number.isSafeInteger(row.id) ||
      row.id < 1 ||
      ids.has(row.id) ||
      row.code <= previous ||
      !/^\d+$/.test(row.xmin) ||
      !/^\d+$/.test(row.tableoid) ||
      row.dayCount !== days ||
      row.distinctDayCount !== days ||
      row.invalidCount !== 0
    ) {
      throw new Error(`Invalid ${kind} output coverage or shape`);
    }
    ids.add(row.id);
    previous = row.code;
    codeHash.update(`${index ? '\n' : ''}${row.code}`);
    if (kind !== 'national' && !/^[a-f0-9]{64}$/.test(row.digest))
      throw new Error('Invalid output digest');
    historyHash.update(
      `${index ? '\n' : ''}${kind === 'national' ? row.line : `["${row.code}", "${row.digest}"]`}`,
    );
  });
  if (rows.length !== expectedCount)
    throw new Error(`Incomplete ${kind} output coverage`);
  const digest = historyHash.digest('hex');
  same(
    digest,
    kind === 'commune'
      ? PINNED.communeHistoryDigest
      : kind === 'department'
        ? PINNED.departmentHistoryDigest
        : PINNED.statisticDigest,
    'Output differs from pinned certified repair',
  );
  if (kind !== 'national')
    same(
      codeHash.digest('hex'),
      kind === 'commune' ? PINNED.communeDigest : PINNED.departmentDigest,
      'Output entity coverage differs',
    );
  return {
    count: rows.length,
    days: rows.length * days,
    digest,
    versions: rows.map(({ id, xmin, tableoid }) => ({ id, xmin, tableoid })),
  };
}

async function fileDigest(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function archiveDigest(path: string) {
  same(
    await fileDigest(path),
    EQUIVALENCE_ANCHOR.archiveSha256,
    'Anchor archive does not match the recorded Scalingo backup',
  );
}

export async function releaseEquivalenceRunner(
  runner: QueryRunner,
  preservePrimaryError: boolean,
): Promise<void> {
  if (runner.isReleased) return;
  let cleanupError: unknown;
  try {
    if (!runner.isReleased && runner.isTransactionActive) {
      await runner.rollbackTransaction();
    }
  } catch (error) {
    cleanupError = error;
  }
  try {
    if (!runner.isReleased) await runner.release();
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError && !preservePrimaryError) throw cleanupError;
}

async function inspect(
  database: DataSource,
  expectedDatabase: string,
  anchor: boolean,
  operatorDigest: string,
): Promise<Inspection> {
  const runner = database.createQueryRunner();
  const deadline = Date.now() + MAX_INSPECTION_MS;
  const checkDeadline = () => {
    if (Date.now() > deadline)
      throw new Error('Read-only inspection deadline exceeded');
  };
  await runner.connect();
  let operationFailed = false;
  try {
    await runner.startTransaction('REPEATABLE READ');
    await runner.query('SET TRANSACTION READ ONLY');
    await runner.query(EQUIVALENCE_INSPECTION_SETTINGS_SQL);
    const [identity] = await runner.query('SELECT current_database() AS name');
    same(identity?.name, expectedDatabase, 'Unexpected database identity');
    const context = await publicationContext(runner);
    const [audit] = await runner.query(
      'SELECT to_jsonb(a) AS value FROM certified_history_repair_audit a WHERE id=$1',
      [EQUIVALENCE_ANCHOR.repairId],
    );
    assertEquivalenceAudit(audit?.value);
    const [active] = await runner.query(
      'SELECT to_jsonb(a) AS value FROM active_certified_history_repair a WHERE id=$1',
      [EQUIVALENCE_ANCHOR.repairId],
    );
    if (anchor) {
      same(
        context.historicComputeEpoch,
        EQUIVALENCE_ANCHOR.historicComputeEpoch,
        'Anchor epoch is no longer certified',
      );
      same(
        active?.value?.attestationId,
        EQUIVALENCE_ANCHOR.attestationId,
        'Anchor has no original active attestation',
      );
    }
    const ledger: LedgerRow[] = await runner.query(EQUIVALENCE_LEDGER_SQL);
    assertEquivalenceLedger(ledger, context.historicComputeEpoch);
    const [lookupGuard]: EquivalenceLookupGuard[] = await runner.query(
      EQUIVALENCE_LOOKUP_GUARD_SQL,
    );
    assertEquivalenceLookupGuard(lookupGuard);
    if (anchor)
      same(
        lookupGuard,
        EQUIVALENCE_ANCHOR_LOOKUP_GUARD,
        'Restored anchor derived lookup state differs',
      );
    await runner.query(
      `DECLARE equivalence_inputs NO SCROLL CURSOR FOR ${HISTORY_SOURCE_EQUIVALENCE_SQL}`,
    );
    const inputRows: EquivalenceInput[] = [];
    while (true) {
      checkDeadline();
      const rows = await runner.query(EQUIVALENCE_INPUT_BATCH_SQL);
      if (!rows.length) break;
      inputRows.push(
        ...rows.map((row: { value: EquivalenceInput }) => row.value),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await runner.query('CLOSE equivalence_inputs');
    const inputs = sourceEquivalenceEvidence(inputRows);
    if (anchor) assertEquivalenceAnchorInputs(inputs.digest);
    const outputs = {} as Inspection['outputs'];
    for (const kind of ['commune', 'department', 'national'] as const) {
      const all: OutputRow[] = [];
      if (kind === 'national')
        all.push(...(await runner.query(outputBatchSql(kind))));
      else {
        let cursor = '';
        while (true) {
          checkDeadline();
          const rows: OutputRow[] = await runner.query(outputBatchSql(kind), [
            cursor,
          ]);
          if (!rows.length) break;
          all.push(...rows);
          cursor = rows.at(-1)!.code;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      outputs[kind] = validateOutputRows(kind, all);
    }
    const regionVersions: RowVersion[] = await runner.query(
      'SELECT id,xmin::text,tableoid::text FROM region ORDER BY id',
    );
    const relations = await runner.query(EQUIVALENCE_RELATIONS_SQL, [
      SOURCE_TABLES,
    ]);
    if (
      !anchor &&
      (relations.length !== SOURCE_TABLES.length ||
        relations.some(
          (row: { tgenabled: string }) => !['O', 'A'].includes(row.tgenabled),
        ))
    ) {
      throw new Error('Source revision triggers are missing or disabled');
    }
    await runner.commitTransaction();
    return {
      operatorDigest,
      context,
      inputs,
      outputs,
      regionVersions,
      relations,
      ledger,
      audit: audit.value,
      active: active?.value ?? null,
      lookupGuard,
    };
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    await releaseEquivalenceRunner(runner, operationFailed);
  }
}

export function versionValidationSql(
  table: 'statistic_commune' | 'statistic_departement' | 'statistic' | 'region',
): string {
  const predicate =
    table === 'statistic'
      ? `WHERE date BETWEEN '${FROM}' AND '${THROUGH}'`
      : '';
  return `WITH expected AS MATERIALIZED (
    SELECT * FROM jsonb_to_recordset($1::jsonb) e(id integer,xmin text,tableoid text)
  ), actual AS MATERIALIZED (SELECT id,xmin::text,tableoid::text FROM ${table} ${predicate})
  SELECT (SELECT count(*)::integer FROM actual) AS "actualCount",
    (SELECT count(DISTINCT id)::integer FROM actual) AS "distinctCount",
    (SELECT count(*)::integer FROM expected) AS "expectedCount",
    (SELECT count(DISTINCT id)::integer FROM expected) AS "uniqueExpectedCount",
    (SELECT count(*)::integer FROM actual a JOIN expected e ON a.id=e.id AND a.xmin=e.xmin AND a.tableoid=e.tableoid) AS "matchedCount"`;
}

export function assertVersionValidation(
  row: Record<string, unknown>,
  expected: number,
): void {
  for (const key of [
    'actualCount',
    'distinctCount',
    'expectedCount',
    'uniqueExpectedCount',
    'matchedCount',
  ]) {
    if (Number(row?.[key]) !== expected)
      throw new Error('Statistic or reference rows changed after validation');
  }
}

export async function acquireEquivalenceFinalLocks(
  runner: Pick<QueryRunner, 'query'>,
): Promise<void> {
  await runner.query(
    "SET LOCAL transaction_timeout='3s'; SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='50ms'",
  );
  const [locks] = await runner.query(`SELECT
    pg_try_advisory_xact_lock(hashtext('vigieau:statistic-commune:snapshot-computation')) AS snapshot,
    pg_try_advisory_xact_lock(hashtext('vigieau'),hashtext('zone-compute-global')) AS zone,
    pg_try_advisory_xact_lock(hashtext('vigieau:zone-publication-stable-promotion')) AS promotion`);
  if (
    locks?.snapshot !== true ||
    locks?.zone !== true ||
    locks?.promotion !== true
  )
    throw new Error('Current computation has priority: lock busy');
  await runner.query(
    'LOCK TABLE statistic_commune, statistic_departement, statistic, region, zone_alerte_computed, zone_alerte_computed_historic IN SHARE MODE NOWAIT',
  );
  await runner.query(
    `LOCK TABLE ${SOURCE_TABLES.map((table) => `"${table}"`).join(',')} IN ROW EXCLUSIVE MODE NOWAIT`,
  );
  await runner.query(
    'SELECT id FROM zone_publication_source_state WHERE id=1 FOR SHARE NOWAIT',
  );
  await runner.query('SELECT id FROM config WHERE id=1 FOR SHARE NOWAIT');
  await runner.query(
    'SELECT id FROM statistic_publication_state WHERE id=1 FOR UPDATE NOWAIT',
  );
}

export function equivalenceProof(inspection: Inspection): string {
  return equivalenceDigest({
    mode: MODE,
    operatorDigest: inspection.operatorDigest,
    anchorLookupGuard: EQUIVALENCE_ANCHOR_LOOKUP_GUARD,
    lookupGuard: inspection.lookupGuard,
    anchor: EQUIVALENCE_ANCHOR,
    context: inspection.context,
    inputs: inspection.inputs,
    outputs: Object.fromEntries(
      Object.entries(inspection.outputs).map(([key, value]) => [
        key,
        { count: value.count, days: value.days, digest: value.digest },
      ]),
    ),
    ledger: inspection.ledger,
    sourceFingerprint: PINNED.sourceFingerprint,
  });
}

export async function applyEquivalenceAttestation(
  target: DataSource,
  inspection: Inspection,
  proof: string,
) {
  const runner = target.createQueryRunner();
  await runner.connect();
  let operationFailed = false;
  try {
    // READ COMMITTED is intentional: advisory-lock SELECTs must not fix an old
    // snapshot before a concurrent writer commits and releases its table lock.
    await runner.startTransaction('READ COMMITTED');
    await acquireEquivalenceFinalLocks(runner);
    const [lookupGuard]: EquivalenceLookupGuard[] = await runner.query(
      EQUIVALENCE_LOOKUP_GUARD_SQL,
    );
    assertEquivalenceLookupGuard(lookupGuard);
    same(
      lookupGuard,
      inspection.lookupGuard,
      'Historic AEP lookup state changed after validation',
    );
    same(
      await publicationContext(runner),
      inspection.context,
      'Publication context changed after validation',
    );
    same(
      await runner.query(EQUIVALENCE_RELATIONS_SQL, [SOURCE_TABLES]),
      inspection.relations,
      'Source relation identity or revision guards changed',
    );
    same(
      await runner.query(EQUIVALENCE_LEDGER_SQL),
      inspection.ledger,
      'Historic invalidation ledger changed',
    );
    const [audit] = await runner.query(
      'SELECT to_jsonb(a) AS value FROM certified_history_repair_audit a WHERE id=$1',
      [EQUIVALENCE_ANCHOR.repairId],
    );
    assertEquivalenceAudit(audit?.value);
    same(audit.value, inspection.audit, 'Certified repair audit changed');
    for (const [table, versions] of [
      ['statistic_commune', inspection.outputs.commune.versions],
      ['statistic_departement', inspection.outputs.department.versions],
      ['statistic', inspection.outputs.national.versions],
      ['region', inspection.regionVersions],
    ] as const) {
      const [result] = await runner.query(versionValidationSql(table), [
        JSON.stringify(versions),
      ]);
      assertVersionValidation(result, versions.length);
    }
    const [existing] = await runner.query(
      `SELECT "attestationId" AS id FROM active_certified_history_repair
      WHERE id=$1 AND "attestedThroughEpoch"=$2`,
      [EQUIVALENCE_ANCHOR.repairId, inspection.context.historicComputeEpoch],
    );
    if (existing) {
      await runner.commitTransaction();
      return { status: 'ALREADY_ATTESTED', attestationId: existing.id };
    }
    const id = randomUUID();
    await runner.query(
      "SELECT set_config('vigieau.certified_history_attestation_id',$1,true)",
      [id],
    );
    const [updated] = await runner.query(CERTIFIED_COMPLETION_ATTESTATION_SQL, [
      FROM,
      THROUGH,
      PINNED.communeCount,
      EQUIVALENCE_ANCHOR.repairId,
      inspection.context.statisticRevision,
    ]);
    const revision = (
      BigInt(inspection.context.statisticRevision) + 1n
    ).toString();
    if (
      updated?.snapshotDayCount !== 52 ||
      updated?.invalidSnapshotCount !== 0 ||
      updated?.revision !== revision
    )
      throw new Error(
        'Certified snapshots or revision lost their validation boundary',
      );
    const [attestation] = await runner.query(
      CERTIFIED_COMPLETION_INITIAL_ATTESTATION_SQL,
      [
        id,
        EQUIVALENCE_ANCHOR.repairId,
        inspection.context.historicComputeEpoch,
        revision,
        JSON.stringify({
          attestationMethod: MODE,
          operatorDigest: inspection.operatorDigest,
          lookupPolicy: 'disjoint-current-historic-identifiers-v1',
          anchorLookupGuard: EQUIVALENCE_ANCHOR_LOOKUP_GUARD,
          lookupGuard: inspection.lookupGuard,
          anchor: EQUIVALENCE_ANCHOR,
          proof,
          inputPolicy: inspection.inputs.policy,
          inputDigest: inspection.inputs.digest,
          inputSections: inspection.inputs.sections,
          ledgerDigest: equivalenceDigest(inspection.ledger),
          ledgerPolicy:
            'contiguous-known-events-with-global-source-equivalence-v1',
          legacyEventsWithoutSourceRevision: inspection.ledger.filter(
            (row) => row.sourceRevision === null,
          ).length,
          sourceFingerprint: PINNED.sourceFingerprint,
          currentSourceRevision: inspection.context.sourceRevision,
          currentPublicSourceRevision: inspection.context.sourcePublicRevision,
        }),
      ],
    );
    if (attestation?.attestationId !== id || attestation?.revision !== revision)
      throw new Error('Attestation insertion lost its boundary');
    await runner.commitTransaction();
    return { status: 'ATTESTED', attestationId: id, revision };
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    await releaseEquivalenceRunner(runner, operationFailed);
  }
}

export async function attestHistoryBySourceEquivalence(
  source: DataSource,
  target: DataSource,
  options: EquivalenceOptions,
) {
  await archiveDigest(options.archivePath);
  const artifacts = [
    __filename,
    require.resolve('./history-source-equivalence'),
    require.resolve('./restore-certified-commune-history'),
    require.resolve('./restore-missing-commune-history'),
    require.resolve('./complete-certified-history-restoration'),
  ];
  const artifactDigests: string[] = [];
  for (const path of artifacts) artifactDigests.push(await fileDigest(path));
  const operatorDigest = equivalenceDigest(artifactDigests);
  const anchor = await inspect(
    source,
    options.sourceDatabase,
    true,
    operatorDigest,
  );
  const current = await inspect(
    target,
    options.targetDatabase,
    false,
    operatorDigest,
  );
  same(
    current.inputs,
    anchor.inputs,
    'Historic statistical sources are not equivalent to the active certified backup',
  );
  const proof = equivalenceProof(current);
  if (
    options.apply &&
    current.active?.attestedThroughEpoch ===
      Number(current.context.historicComputeEpoch) &&
    (current.active.attestationContext as Record<string, unknown>)?.proof ===
      options.expectedProof
  ) {
    return {
      status: 'ALREADY_ATTESTED',
      mode: MODE,
      proof: options.expectedProof,
      attestationId: current.active.attestationId,
    };
  }
  if (options.apply && proof !== options.expectedProof)
    throw new Error('Dry-run proof changed; rerun inspection');
  if (!options.apply)
    return {
      status: 'DRY_RUN',
      mode: MODE,
      proof,
      anchor: EQUIVALENCE_ANCHOR,
      context: current.context,
      inputDigest: current.inputs.digest,
      outputDigests: Object.fromEntries(
        Object.entries(current.outputs).map(([key, value]) => [
          key,
          value.digest,
        ]),
      ),
    };
  return {
    ...(await applyEquivalenceAttestation(target, current, proof)),
    mode: MODE,
    proof,
  };
}

async function main() {
  const options = parseEquivalenceOptions();
  const source = standaloneDataSource(
    requiredEnvironment(process.env, 'HISTORY_EQUIVALENCE_SOURCE_DATABASE_URL'),
    true,
  );
  const target = standaloneDataSource(
    requiredEnvironment(process.env, 'HISTORY_EQUIVALENCE_TARGET_DATABASE_URL'),
    !options.apply,
  );
  try {
    await source.initialize();
    await target.initialize();
    process.stdout.write(
      `${JSON.stringify(await attestHistoryBySourceEquivalence(source, target, options))}\n`,
    );
  } finally {
    if (target.isInitialized) await target.destroy();
    if (source.isInitialized) await source.destroy();
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : 'History equivalence attestation failed',
    );
    process.exitCode = 1;
  });
