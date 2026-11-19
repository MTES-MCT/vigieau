import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { QueryRunner } from 'typeorm';
import { CERTIFIED_TARGET_PLAN_CTES } from './restore-certified-commune-history';
import {
  DEPARTMENT_PLAN_CTES,
  publicationContext,
  standaloneDataSource,
} from './complete-certified-history-restoration';

const FROM = '2026-07-11';
const THROUGH = '2026-08-31';
const types = ['SOU', 'SUP', 'AEP'] as const;
type Kind = 'communes' | 'departments';
type Day = Record<string, unknown>;
interface Change {
  code: string;
  date: string;
  before: Day;
  after: Day;
}
interface Patch {
  communes: Change[];
  departments: Change[];
  statistics: unknown[];
}
interface Image {
  kind: Kind;
  code: string;
  id: number;
  before: string;
  after: string;
  monthsBefore: string | null;
  monthsAfter: string | null;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function digest(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function validatePatch(patch: Patch): void {
  check(
    Array.isArray(patch.statistics) && patch.statistics.length === 0,
    'Unexpected national payload change',
  );
  check(
    patch.communes.length === 445 && patch.departments.length === 105,
    'Unexpected patch cardinality',
  );
  const changes = [];
  const departments = new Set<string>();
  for (const [kind, items] of Object.entries({
    communes: patch.communes,
    departments: patch.departments,
  })) {
    const days = new Set<string>();
    for (const item of items) {
      const { code, date, before, after } = item;
      const dep = code.slice(0, 2);
      const channel = dep === '79' ? 'SOU' : 'AEP';
      const starts: Record<string, string> = {
        '12': '2026-07-13',
        '64': '2026-07-28',
        '79': '2026-08-12',
      };
      check(
        starts[dep] &&
          /^2026-\d\d-\d\d$/.test(date) &&
          date >= starts[dep] &&
          date <= THROUGH,
        'Out-of-scope date or department',
      );
      check(!days.has(code + '|' + date), 'Duplicate patch day');
      days.add(code + '|' + date);
      const expected = (kind === 'communes' ? [...types] : [...types, 'date'])
        .sort()
        .join();
      check(
        [before, after].every((s) => Object.keys(s).sort().join() === expected),
        'Unexpected payload structure',
      );
      if (kind === 'communes') {
        check(
          types.filter((k) => before[k] !== after[k]).join() === channel,
          'Unexpected commune change',
        );
        changes.push(
          [
            code,
            date,
            channel,
            before[channel] ?? '-',
            after[channel] ?? '-',
          ].join('|'),
        );
      } else {
        check(
          code === dep && before.date === date && after.date === date,
          'Invalid departmental payload date',
        );
        departments.add(code);
      }
    }
  }
  check(
    departments.size === 3 &&
      digest(changes.sort().join('\n')) ===
        'c02809168de03d3cbf099ebd5d49663a5c0cbbd434289eb82f1dacc7b71984da',
    'Commune changes differ from the arbitrated replay',
  );
}

export async function prepareArbitratedRow(
  runner: QueryRunner,
  raw: string,
  kind: Kind,
  code: string,
): Promise<Image> {
  const isCommune = kind === 'communes';
  const entity = isCommune ? 'commune' : 'departement';
  const stat = isCommune ? 'statistic_commune' : 'statistic_departement';
  const channel = code.startsWith('79') ? 'SOU' : 'AEP';
  // Produce full 52-day inputs for the existing restoration planners. The source
  // dates between corrections come from the target within this read-only snapshot.
  const [plan] = await runner.query(
    `
    WITH patch AS MATERIALIZED (
      SELECT date, before || jsonb_build_object('date',date) AS prior,
             after || jsonb_build_object('date',date) AS desired
      FROM jsonb_to_recordset($1::jsonb->$6::text) AS p(code text,date text,before jsonb,after jsonb)
      WHERE code=$2
    ), history AS (
      SELECT day.value AS original, day.value->>'date' AS date
      FROM ${stat} s JOIN ${entity} e ON e.id=s."${entity}Id"
      CROSS JOIN LATERAL jsonb_array_elements(s.restrictions) day(value)
      WHERE e.code=$2 AND day.value->>'date' BETWEEN $3 AND $4
    )
    SELECT count(*)::int AS days, count(DISTINCT h.date)::int AS dates,
      count(p.date)::int AS matched, (SELECT count(*)::int FROM patch) AS expected,
      bool_and(p.date IS NULL OR (h.original IN (p.prior,p.desired)
        AND p.prior-$5::text = p.desired-$5::text AND p.prior<>p.desired)) AS valid,
      jsonb_agg(${
        isCommune
          ? "coalesce(p.desired,h.original) || jsonb_build_object('code',$2::text)"
          : "jsonb_build_object('code',$2::text,'date',h.date,'restriction',coalesce(p.desired,h.original))"
      }
        ORDER BY h.date)::text AS input
    FROM history h LEFT JOIN patch p ON p.date=h.date
  `,
    [raw, code, FROM, THROUGH, channel, kind],
  );
  check(
    plan.days === 52 &&
      plan.dates === 52 &&
      plan.expected > 0 &&
      plan.matched === plan.expected &&
      plan.valid,
    'Preimage or coverage mismatch for ' + code,
  );
  const ctes = isCommune ? CERTIFIED_TARGET_PLAN_CTES : DEPARTMENT_PLAN_CTES;
  const preparedTable = isCommune ? 'prepared_payloads' : 'prepared';
  const monthFields = isCommune
    ? 'p."originalRestrictionsByMonth"::text AS "monthsBefore",p."restrictionsByMonth"::text AS "monthsAfter"'
    : 'NULL::text AS "monthsBefore",NULL::text AS "monthsAfter"';
  const [row] = await runner.query(
    `
    WITH ${ctes}
    SELECT p.id,p."originalRestrictions"::text AS before,p.restrictions::text AS after,${monthFields},
      (SELECT count(*)::int FROM invalid_targets) AS invalid,
      (SELECT jsonb_agg(value ORDER BY ord) FROM jsonb_array_elements(p."originalRestrictions") WITH ORDINALITY d(value,ord)
       WHERE value->>'date' NOT BETWEEN $2::date::text AND $3::date::text)
      IS NOT DISTINCT FROM
      (SELECT jsonb_agg(value ORDER BY ord) FROM jsonb_array_elements(p.restrictions) WITH ORDINALITY d(value,ord)
       WHERE value->>'date' NOT BETWEEN $2::date::text AND $3::date::text) AS outside_ok
    FROM ${preparedTable} p
  `,
    [plan.input, FROM, THROUGH],
  );
  check(
    row && !row.invalid && row.outside_ok,
    'Historic planner changed unrelated days for ' + code,
  );
  if (isCommune) {
    const keepOtherMonths = (text: string) =>
      JSON.parse(text).filter(
        (m: Day) => !['2026-07', '2026-08'].includes(String(m.date)),
      );
    check(
      JSON.stringify(keepOtherMonths(row.monthsBefore)) ===
        JSON.stringify(keepOtherMonths(row.monthsAfter)),
      'Unrelated month changed for ' + code,
    );
  }
  return {
    kind,
    code,
    id: row.id,
    before: row.before,
    after: row.after,
    monthsBefore: row.monthsBefore,
    monthsAfter: row.monthsAfter,
  };
}

export async function run(): Promise<void> {
  const [mode, file, expected, dir, approvedPlan] = process.argv.slice(2);
  check(mode === 'inspect' || mode === 'apply', 'Expected inspect or apply');
  const raw = await readFile(file, 'utf8');
  check(digest(raw) === expected, 'Unexpected patch file checksum');
  const patch: Patch = JSON.parse(raw);
  validatePatch(patch);
  const url = process.env.HISTORY_PATCH_TARGET_URL;
  const name = process.env.HISTORY_PATCH_DATABASE;
  check(url && name, 'Missing target connection or expected database');
  const ds = standaloneDataSource(url, mode === 'inspect');
  await ds.initialize();
  const r = ds.createQueryRunner();
  await r.connect();
  try {
    await r.startTransaction('REPEATABLE READ');
    await r.query('SET TRANSACTION READ ONLY');
    await r.query("SET LOCAL statement_timeout='20s'");
    const [target] = await r.query('SELECT current_database() AS db');
    check(target.db === name, 'Target database name mismatch');
    const context = await publicationContext(r, false);
    check(
      context.historicDirtyFrom === FROM &&
        context.historicDirtyThrough === THROUGH,
      'Dirty range changed',
    );
    const images: Image[] = [];
    for (const kind of ['communes', 'departments'] as const) {
      for (const code of [...new Set(patch[kind].map((i) => i.code))].sort())
        images.push(await prepareArbitratedRow(r, raw, kind, code));
    }
    await r.commitTransaction();
    const updates = images.filter(
      (i) => i.before !== i.after || i.monthsBefore !== i.monthsAfter,
    );
    const identity = digest(
      JSON.stringify({ name, context, patch: expected, images }),
    );
    console.log(
      JSON.stringify({
        mode,
        database: name,
        identity,
        communes: updates.filter((i) => i.kind === 'communes').length,
        departments: updates.filter((i) => i.kind === 'departments').length,
      }),
    );
    if (mode === 'inspect') {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, identity + '.json');
      const backup = JSON.stringify({
        database: name,
        context,
        patch: expected,
        images,
      });
      try {
        await writeFile(path, backup, { mode: 0o600, flag: 'wx' });
      } catch (e) {
        if (
          (e as NodeJS.ErrnoException).code !== 'EEXIST' ||
          (await readFile(path, 'utf8')) !== backup
        )
          throw e;
      }
      return;
    }
    check(
      approvedPlan === identity,
      'Re-run inspect for this publication and these row images',
    );
    const backup = JSON.parse(
      await readFile(join(dir, identity + '.json'), 'utf8'),
    );
    check(
      backup.database === name &&
        backup.patch === expected &&
        JSON.stringify(backup.images) === JSON.stringify(images),
      'Verified preimage backup missing',
    );
    if (!updates.length) return;
    // Upload the staged images before obtaining any business locks.
    await r.query(
      'CREATE TEMP TABLE history_patch_rows (kind text, id integer, before jsonb, after jsonb, "monthsBefore" jsonb, "monthsAfter" jsonb, PRIMARY KEY(kind,id))',
    );
    for (const i of updates)
      await r.query(
        'INSERT INTO history_patch_rows VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb)',
        [i.kind, i.id, i.before, i.after, i.monthsBefore, i.monthsAfter],
      );
    await r.startTransaction('SERIALIZABLE');
    await r.query("SET LOCAL lock_timeout='100ms'");
    await r.query("SET LOCAL statement_timeout='3s'");
    const [locks] = await r.query(`SELECT
      pg_try_advisory_xact_lock(hashtext('vigieau:statistic-commune:snapshot-computation')) AND
      pg_try_advisory_xact_lock(hashtext('vigieau'),hashtext('zone-compute-global')) AND
      pg_try_advisory_xact_lock(hashtext('vigieau:zone-publication-stable-promotion')) AS ok`);
    check(locks.ok, 'Current production work has priority');
    check(
      JSON.stringify(await publicationContext(r, true)) ===
        JSON.stringify(context),
      'Publication changed during preparation',
    );
    const [cert] = await r.query(
      'SELECT count(*)::int AS n FROM active_certified_history_repair',
    );
    check(cert.n === 0, 'The historic range is already certified');
    for (const kind of ['communes', 'departments'] as const) {
      const monthly = kind === 'communes';
      const [res] = await r.query(
        `WITH applied AS (
        UPDATE ${monthly ? 'statistic_commune' : 'statistic_departement'} target
        SET restrictions=p.after ${monthly ? ', "restrictionsByMonth"=p."monthsAfter"' : ''}
        FROM history_patch_rows p WHERE p.kind=$1 AND p.id=target.id
        AND target.restrictions=p.before
        ${monthly ? 'AND target."restrictionsByMonth" IS NOT DISTINCT FROM p."monthsBefore"' : ''}
        RETURNING target.id) SELECT count(*)::int AS n FROM applied`,
        [kind],
      );
      check(
        res.n === updates.filter((i) => i.kind === kind).length,
        'Concurrent ' + kind + ' change',
      );
    }
    await r.commitTransaction();
    console.log('Committed scoped historical corrections');
  } finally {
    if (r.isTransactionActive) await r.rollbackTransaction();
    await r.release();
    await ds.destroy();
  }
}
if (require.main === module)
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
