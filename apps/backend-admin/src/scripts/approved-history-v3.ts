import { QueryRunner } from 'typeorm';
import {
  EQUIVALENCE_RELATIONS_SQL,
  EquivalenceInput,
  HISTORICAL_REVISION_TABLES,
  HISTORY_SOURCE_EQUIVALENCE_SQL,
  sourceEquivalenceEvidence,
} from './history-source-equivalence';

export const APPROVED_HISTORY_V3_RUN =
  'vigieau-2026-07-11-2026-08-31-arbitrage-v3';
// Independently computed from the eight historical input sections restored
// from Scalingo backup 6afe3c4299c3cddad8905d97, including the three edits.
export const APPROVED_HISTORY_V3_INPUT_DIGEST =
  '6285956eda3f5ec2a4cb8f1fa97c7e07a899dc3d477ac45b1465de96fd897a17';

// The operator accepts only a reviewed final manifest. An empty pin disables
// publication until both hashes have been independently recomputed.
export const APPROVED_HISTORY_V3_PROVENANCE = '';
export const APPROVED_HISTORY_V3_FINGERPRINT = '';

export async function verifyApprovedHistoryInputs(
  runner: QueryRunner,
): Promise<void> {
  await runner.query(
    `DECLARE approved_inputs NO SCROLL CURSOR FOR ${HISTORY_SOURCE_EQUIVALENCE_SQL}`,
  );
  const inputs: EquivalenceInput[] = [];
  while (true) {
    const batch: Array<{ value: EquivalenceInput }> = await runner.query(
      'FETCH FORWARD 2048 FROM approved_inputs',
    );
    if (!batch.length) break;
    inputs.push(...batch.map((row) => row.value));
  }
  await runner.query('CLOSE approved_inputs');
  if (
    sourceEquivalenceEvidence(inputs).digest !==
    APPROVED_HISTORY_V3_INPUT_DIGEST
  ) {
    throw new Error(
      'Historical inputs differ from the eight approved v3 source sections',
    );
  }
}

export async function approvedHistoryMutationGuards(
  runner: QueryRunner,
): Promise<string> {
  const relations: Array<{ tgenabled: string }> = await runner.query(
    EQUIVALENCE_RELATIONS_SQL,
    [HISTORICAL_REVISION_TABLES],
  );
  if (
    relations.length !== HISTORICAL_REVISION_TABLES.length ||
    relations.some((row) => !['O', 'A'].includes(row.tgenabled))
  ) {
    throw new Error(
      'Historical source revision triggers are missing or disabled',
    );
  }
  // Region has no source-revision trigger. Cover all rows and table replacement.
  const regions =
    await runner.query(`SELECT 'region'::regclass::oid::text AS oid,
    pg_relation_filenode('region'::regclass)::text AS filenode,
    jsonb_agg(jsonb_build_array(id,xmin::text,ctid::text) ORDER BY id) AS versions FROM region`);
  return JSON.stringify([relations, regions]);
}

export async function lockApprovedHistoryInputs(
  runner: QueryRunner,
): Promise<void> {
  // Block rewrites and trigger changes. Ordinary source writers remain guarded
  // by the revision rows checked in the same transaction. Region is untracked.
  await runner.query(
    `LOCK TABLE ${HISTORICAL_REVISION_TABLES.join(',')} IN ROW EXCLUSIVE MODE NOWAIT`,
  );
  await runner.query('LOCK TABLE region IN SHARE MODE NOWAIT');
}

// Hash every matching item, including duplicates, while each commune is still
// independent. This avoids materializing entire multi-year histories together.
export const APPROVED_COMMUNE_DIGEST_SQL = `
WITH expected AS MATERIALIZED (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(code text,"dayCount" integer,digest text)
), actual AS (
  SELECT e.*,s.id,proof.*
  FROM expected e
  LEFT JOIN commune c ON c.code=e.code
  LEFT JOIN statistic_commune s ON s."communeId"=c.id
  CROSS JOIN LATERAL (
    SELECT count(*) FILTER (WHERE in_scope) AS n,
      count(DISTINCT stamp) = count(*)
        AND bool_and(jsonb_typeof(value)='object' AND stamp ~ '^\\d{4}-\\d{2}-\\d{2}$') AS dated,
      bool_and(value ?& ARRAY['date','SOU','SUP','AEP']
        AND value-ARRAY['date','SOU','SUP','AEP']='{}'::jsonb) FILTER (WHERE in_scope) AS valid,
      encode(sha256(convert_to(string_agg(jsonb_build_array(stamp,value->>'SOU',
        value->>'SUP',value->>'AEP')::text,E'\\n' ORDER BY stamp) FILTER (WHERE in_scope),'UTF8')),'hex') AS computed
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.restrictions)='array'
      THEN s.restrictions ELSE '[]'::jsonb END) AS item(value)
    CROSS JOIN LATERAL (SELECT value->>'date' AS stamp) d
    CROSS JOIN LATERAL (SELECT stamp BETWEEN $2::text AND $3::text AS in_scope) scoped
  ) proof
)
SELECT (SELECT count(*)::int FROM expected) AS "sourceCount",count(id)::int AS "targetCount",
  count(*) FILTER (WHERE id IS NULL OR n <> "dayCount" OR dated IS DISTINCT FROM true
    OR valid IS DISTINCT FROM true OR digest IS DISTINCT FROM computed)::int AS "mismatchCount"
FROM actual`;
