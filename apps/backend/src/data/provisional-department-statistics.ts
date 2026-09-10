import { DataSource } from 'typeorm';
import moment from 'moment';

export const PROVISIONAL_STATISTIC_STATUS = {
  dataStatus: 'provisional',
  dataStatusReason: 'historic-recalculation',
} as const;

export interface ProvisionalDepartmentRow {
  departement: string;
  date: string;
  restriction: Record<string, any>;
}

export interface ProvisionalDepartmentDay {
  date: string;
  departements: Array<Record<string, any>>;
}

export function completeProvisionalDepartmentDays(
  rows: ProvisionalDepartmentRow[],
  expectedCodes: string[],
  from: string,
  through: string,
): ProvisionalDepartmentDay[] {
  const expected = new Set(expectedCodes);
  if (expected.size !== 101 || expectedCodes.length !== 101) return [];
  const days = new Map<string, Map<string, Record<string, any>>>();
  const invalid = new Set<string>();
  for (const row of rows) {
    if (!moment.utc(row.date, 'YYYY-MM-DD', true).isValid()) continue;
    if (row.date < from || row.date > through) continue;
    const day = days.get(row.date) ?? new Map();
    days.set(row.date, day);
    const validRestriction = ['SUP', 'SOU', 'AEP'].every((zone) =>
      ['vigilance', 'alerte', 'alerte_renforcee', 'crise'].every((level) => {
        const value = row.restriction?.[zone]?.[level];
        const numeric =
          typeof value === 'number' ||
          (typeof value === 'string' &&
            /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value));
        return numeric && Number.isFinite(Number(value)) && Number(value) >= 0;
      }),
    );
    if (
      !expected.has(row.departement) ||
      day.has(row.departement) ||
      row.restriction?.date !== row.date ||
      !validRestriction
    ) {
      invalid.add(row.date);
      continue;
    }
    const restriction = {
      ...row.restriction,
      ...Object.fromEntries(
        ['SUP', 'SOU', 'AEP'].map((zone) => [
          zone,
          Object.fromEntries(
            ['vigilance', 'alerte', 'alerte_renforcee', 'crise'].map(
              (level) => [level, Number(row.restriction[zone][level])],
            ),
          ),
        ]),
      ),
      departement: row.departement,
      date: row.date,
    };
    day.set(row.departement, restriction);
  }
  return [...days]
    .filter(
      ([date, departments]) => !invalid.has(date) && departments.size === 101,
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, departments]) => ({
      date,
      departements: expectedCodes.map((code) => departments.get(code)!),
    }));
}

export async function readProvisionalDepartmentDays(
  dataSource: DataSource,
  from: string,
  through: string,
  expectedCodes: string[],
): Promise<ProvisionalDepartmentDay[]> {
  const runner = dataSource.createQueryRunner();
  let transactionStarted = false;
  try {
    await runner.connect();
    await runner.startTransaction('REPEATABLE READ');
    transactionStarted = true;
    await runner.query('SET TRANSACTION READ ONLY');
    await runner.query("SET LOCAL statement_timeout = '5s'");
    // Department days are replaced atomically before the separate commune snapshot.
    // An unfinished commune recomputation must not hide these persisted provisional values.
    const rows: ProvisionalDepartmentRow[] = await runner.query(
      `
        SELECT department.code AS departement,
          restriction.value ->> 'date' AS date,
          restriction.value AS restriction
        FROM statistic_departement statistic
        JOIN departement department ON department.id = statistic."departementId"
        CROSS JOIN LATERAL jsonb_array_elements(
          COALESCE(statistic.restrictions, '[]'::jsonb)
        ) restriction(value)
        WHERE restriction.value ->> 'date' BETWEEN $1::text AND $2::text
        ORDER BY date, department.code
      `,
      [from, through],
    );
    await runner.commitTransaction();
    transactionStarted = false;
    return completeProvisionalDepartmentDays(
      rows,
      expectedCodes,
      from,
      through,
    );
  } catch (error) {
    if (transactionStarted) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}
