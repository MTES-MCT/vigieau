import { Client } from 'pg';
import {
  BuildCertifiedHistorySourceOptions,
  CERTIFIED_HISTORY_PLAN,
  CERTIFIED_HISTORY_SOURCE_RUN_ID,
  buildCertifiedHistorySourcePart,
} from './build-certified-history-source';

const postgresUrl = process.env.BUILD_CERTIFIED_HISTORY_POSTGRES_URL;
const describePostgres = postgresUrl ? describe : describe.skip;

function allDates(): string[] {
  const from = Date.parse('2026-07-11T00:00:00.000Z');
  const through = Date.parse('2026-08-27T00:00:00.000Z');
  const count = Math.floor((through - from) / 86_400_000) + 1;
  return Array.from({ length: count }, (_, offset) =>
    new Date(from + offset * 86_400_000).toISOString().slice(0, 10),
  );
}

function dumpSha(index: number): string {
  return `${'a'.repeat(63)}${index}`;
}

function databaseUrl(database: string): string {
  const url = new URL(postgresUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

describePostgres('build certified history source PostgreSQL', () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const sourceDatabase = `certified_builder_source_${suffix}`;
  const accumulatorDatabase = `certified_builder_accumulator_${suffix}`;
  let sourceUrl: string;
  let accumulatorUrl: string;
  let admin: Client;
  let source: Client;
  let accumulator: Client;

  beforeAll(async () => {
    sourceUrl = databaseUrl(sourceDatabase);
    accumulatorUrl = databaseUrl(accumulatorDatabase);
    admin = new Client({ connectionString: databaseUrl('postgres') });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${sourceDatabase}"`);
    await admin.query(`CREATE DATABASE "${accumulatorDatabase}"`);
    source = new Client({ connectionString: sourceUrl });
    accumulator = new Client({ connectionString: accumulatorUrl });
    await source.connect();
    await accumulator.connect();

    const dates = allDates();
    const communeRestrictions = dates.map((date, index) => ({
      date,
      SOU: index % 4 === 0 ? 'vigilance' : null,
      SUP: index % 4 === 1 ? 'alerte' : null,
      AEP: index % 4 === 2 ? 'crise' : null,
    }));
    const departmentRestrictions = dates.map((date) => ({
      date,
      SOU: {
        vigilance: 0,
        alerte: '1.00',
        alerte_renforcee: 0,
        crise: 0,
      },
      SUP: {
        vigilance: 0,
        alerte: 0,
        alerte_renforcee: '2.25',
        crise: 0,
      },
      AEP: {
        vigilance: 0,
        alerte: 0,
        alerte_renforcee: 0,
        crise: 0,
      },
    }));
    const departmentCodes = Array.from({ length: 101 }, (_, index) =>
      String(index).padStart(3, '0'),
    );
    const situations = Object.fromEntries(
      departmentCodes.map((code) => [
        code,
        { max: 'crise', sup: 'alerte', sou: null, aep: null },
      ]),
    );
    await source.query(
      `
        CREATE TABLE commune (id integer PRIMARY KEY, code text NOT NULL UNIQUE);
        CREATE TABLE statistic_commune (
          id integer PRIMARY KEY,
          "communeId" integer NOT NULL UNIQUE REFERENCES commune(id),
          restrictions jsonb NOT NULL
        );
        CREATE TABLE departement (id integer PRIMARY KEY, code text NOT NULL UNIQUE);
        CREATE TABLE statistic_departement (
          id integer PRIMARY KEY,
          "departementId" integer NOT NULL UNIQUE REFERENCES departement(id),
          restrictions jsonb NOT NULL
        );
        CREATE TABLE statistic (
          id integer PRIMARY KEY,
          date date NOT NULL UNIQUE,
          visits integer,
          "departementSituation" json
        );
      `,
    );
    await source.query(`INSERT INTO commune VALUES (1, '77132')`);
    await source.query(
      `INSERT INTO statistic_commune VALUES (1, 1, $1::jsonb)`,
      [JSON.stringify(communeRestrictions)],
    );
    await source.query(
      `INSERT INTO departement (id, code)
       SELECT value + 1, lpad(value::text, 3, '0')
       FROM generate_series(0, 100) value`,
    );
    await source.query(
      `INSERT INTO statistic_departement (id, "departementId", restrictions)
       SELECT id, id, $1::jsonb FROM departement`,
      [JSON.stringify(departmentRestrictions)],
    );
    for (const [index, date] of dates.entries()) {
      await source.query(
        `INSERT INTO statistic VALUES ($1, $2::date, NULL, $3::json)`,
        [index + 1, date, JSON.stringify(situations)],
      );
    }
  }, 30_000);

  afterAll(async () => {
    await accumulator?.end().catch(() => undefined);
    await source?.end().catch(() => undefined);
    if (admin) {
      await admin
        .query(`DROP DATABASE IF EXISTS "${accumulatorDatabase}"`)
        .catch(() => undefined);
      await admin
        .query(`DROP DATABASE IF EXISTS "${sourceDatabase}"`)
        .catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });

  function options(index: number): BuildCertifiedHistorySourceOptions {
    const part = CERTIFIED_HISTORY_PLAN[index];
    return {
      sourceDatabaseUrl: sourceUrl,
      accumulatorDatabaseUrl: accumulatorUrl,
      from: part.from,
      through: part.through,
      backupId: part.backupId,
      dumpSha256: dumpSha(index),
    };
  }

  it('rejects an accumulator that resolves to the physical backup database', async () => {
    const sameDatabase = new Client({ connectionString: sourceUrl });
    await sameDatabase.connect();
    try {
      await expect(
        buildCertifiedHistorySourcePart(source, sameDatabase, options(0)),
      ).rejects.toThrow('same physical database');
    } finally {
      await sameDatabase.end();
    }
  });

  it('assembles five exact parts, certifies complete coverage and is idempotent', async () => {
    for (let index = 0; index < CERTIFIED_HISTORY_PLAN.length - 1; index += 1) {
      const summary = await buildCertifiedHistorySourcePart(
        source,
        accumulator,
        options(index),
      );
      expect(summary.completedPartCount).toBe(index + 1);
      expect(summary.status).toBe('building');
    }

    await accumulator.query(
      `UPDATE "certified_history_commune_day" SET "SUP" = 'crise'
       WHERE "sourceRunId" = $1 AND code = '77132' AND date = '2026-07-11'`,
      [CERTIFIED_HISTORY_SOURCE_RUN_ID],
    );
    await expect(
      buildCertifiedHistorySourcePart(source, accumulator, options(4)),
    ).rejects.toThrow('source part metrics diverge at part 1');
    await accumulator.query(
      `UPDATE "certified_history_commune_day" SET "SUP" = NULL
       WHERE "sourceRunId" = $1 AND code = '77132' AND date = '2026-07-11'`,
      [CERTIFIED_HISTORY_SOURCE_RUN_ID],
    );

    const certified = await buildCertifiedHistorySourcePart(
      source,
      accumulator,
      options(4),
    );
    expect(certified.status).toBe('certified');
    expect(certified.completedPartCount).toBe(5);

    const [run] = (
      await accumulator.query(
        `SELECT *, "communeDayCount"::text, "departmentDayCount"::text
         FROM "certified_history_source_run" WHERE id = $1`,
        [CERTIFIED_HISTORY_SOURCE_RUN_ID],
      )
    ).rows;
    expect(run).toMatchObject({
      status: 'certified',
      communeCount: 1,
      communeDayCount: '48',
      departmentCount: 101,
      departmentDayCount: String(101 * 48),
      statisticDayCount: 48,
    });
    expect(run.communeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(run.communeHistoryDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(run.provenance).toMatchObject({
      method: 'scheduled-logical-backup-before-mutable-replay',
      planVersion: 1,
      communeDailyObjectKeyPolicy: 'exact-date-SOU-SUP-AEP',
    });
    expect(Object.keys(run.provenance.dateSources)).toHaveLength(48);

    const [before] = (
      await accumulator.query(
        `SELECT xmin::text AS xmin FROM "certified_history_commune_day"
         WHERE "sourceRunId" = $1 AND code = '77132' AND date = '2026-08-26'`,
        [CERTIFIED_HISTORY_SOURCE_RUN_ID],
      )
    ).rows;

    const idempotent = await buildCertifiedHistorySourcePart(
      source,
      accumulator,
      options(3),
    );
    expect(idempotent.status).toBe('certified');
    expect(idempotent.completedPartCount).toBe(5);
    const [after] = (
      await accumulator.query(
        `SELECT xmin::text AS xmin FROM "certified_history_commune_day"
         WHERE "sourceRunId" = $1 AND code = '77132' AND date = '2026-08-26'`,
        [CERTIFIED_HISTORY_SOURCE_RUN_ID],
      )
    ).rows;
    expect(after.xmin).toBe(before.xmin);
  }, 30_000);

  it('rolls back a divergent overlap', async () => {
    await source.query(`
      UPDATE statistic_commune
      SET restrictions = (
        SELECT jsonb_agg(
          CASE WHEN value ->> 'date' = '2026-08-26'
            THEN value || '{"SUP":"crise"}'::jsonb
            ELSE value
          END ORDER BY ordinality
        )
        FROM jsonb_array_elements(restrictions)
          WITH ORDINALITY AS item(value, ordinality)
      )
    `);
    await expect(
      buildCertifiedHistorySourcePart(source, accumulator, options(3)),
    ).rejects.toThrow('overlaps divergent accumulator data');

    const [day] = (
      await accumulator.query(
        `SELECT "SUP" FROM "certified_history_commune_day"
         WHERE "sourceRunId" = $1 AND code = '77132' AND date = '2026-08-26'`,
        [CERTIFIED_HISTORY_SOURCE_RUN_ID],
      )
    ).rows;
    expect(day.SUP).toBeNull();
  });
});
