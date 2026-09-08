import { Client } from 'pg';
import { DataSource, QueryRunner } from 'typeorm';
import {
  EQUIVALENCE_LOOKUP_GUARD_SQL,
  EQUIVALENCE_RELATIONS_SQL,
  RowVersion,
  acquireEquivalenceFinalLocks,
  assertEquivalenceLookupGuard,
  assertVersionValidation,
  rowVersionEvidence,
  versionValidationSql,
} from './attest-history-by-source-equivalence';

const postgresUrl = process.env.HISTORY_EQUIVALENCE_POSTGRES_URL;
const describePostgres = postgresUrl ? describe : describe.skip;
const sourceTables = [
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
];
type VersionTable = Parameters<typeof versionValidationSql>[0];

describePostgres('history equivalence PostgreSQL concurrency boundary', () => {
  const schema = `history_equivalence_${process.pid}_${Date.now()}`;
  let admin: DataSource;
  let database: DataSource;
  const runners = new Set<QueryRunner>();

  async function runner() {
    const connection = database.createQueryRunner();
    await connection.connect();
    runners.add(connection);
    return connection;
  }

  async function versions(table: VersionTable = 'statistic_commune') {
    return database.query(
      `SELECT id,xmin::text,tableoid::text FROM ${table} ${
        table === 'statistic'
          ? "WHERE date BETWEEN '2026-07-11' AND '2026-08-31'"
          : ''
      } ORDER BY id`,
    ) as Promise<RowVersion[]>;
  }

  async function validation(
    table: VersionTable = 'statistic_commune',
    connection: DataSource | QueryRunner = database,
  ) {
    const [row] = await connection.query(versionValidationSql(table));
    return row;
  }

  beforeAll(async () => {
    admin = await new DataSource({
      type: 'postgres',
      url: postgresUrl,
    }).initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    database = await new DataSource({
      type: 'postgres',
      url: postgresUrl,
      extra: { max: 8, options: `-c search_path=${schema},public` },
    }).initialize();
    await database.query(`
      CREATE TABLE statistic_commune (id integer PRIMARY KEY, value text);
      CREATE TABLE statistic_departement (id integer PRIMARY KEY, value text);
      CREATE TABLE statistic (id integer PRIMARY KEY, date date UNIQUE NOT NULL, value text);
      CREATE TABLE region (id integer PRIMARY KEY, value text);
      CREATE TABLE zone_alerte_computed (id integer PRIMARY KEY, value text);
      CREATE TABLE zone_alerte_computed_historic (id serial PRIMARY KEY, value text);
      CREATE TABLE zone_publication_source_state (
        id integer PRIMARY KEY, revision bigint NOT NULL, "publicRevision" bigint NOT NULL
      );
      CREATE TABLE config (id integer PRIMARY KEY, "historicComputeEpoch" bigint NOT NULL);
      CREATE TABLE statistic_publication_state (
        id integer PRIMARY KEY, revision bigint NOT NULL, "currentPublishedDate" date NOT NULL
      );
      CREATE FUNCTION bump_zone_publication_source_revision() RETURNS trigger AS $$
      BEGIN
        UPDATE zone_publication_source_state SET revision=revision+1 WHERE id=1;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
    `);
    for (const table of sourceTables) {
      await database.query(`
        CREATE TABLE "${table}" (id integer PRIMARY KEY, value text);
        CREATE TRIGGER "TRG_${table}_zone_publication_revision"
          AFTER INSERT OR UPDATE OR DELETE ON "${table}"
          FOR EACH STATEMENT EXECUTE FUNCTION bump_zone_publication_source_revision();
      `);
    }
  });

  beforeEach(async () => {
    await database.query(`
      TRUNCATE statistic_commune,statistic_departement,statistic,region,
        zone_publication_source_state,config,statistic_publication_state,
        zone_alerte_computed,zone_alerte_computed_historic;
      ALTER SEQUENCE zone_alerte_computed_historic_id_seq INCREMENT BY 1 NO CYCLE;
      SELECT setval('zone_alerte_computed_historic_id_seq',102,true);
      INSERT INTO zone_alerte_computed VALUES (1,'current-a'),(3,'current-b');
      INSERT INTO zone_alerte_computed_historic VALUES (100,'historic-a'),(102,'historic-b');
      INSERT INTO statistic_commune VALUES (1,'historic-a'),(2,'historic-b'),(3,'historic-c');
      INSERT INTO statistic_departement VALUES (1,'department-a'),(2,'department-b');
      INSERT INTO statistic VALUES
        (1,'2026-07-11','historic-a'),(2,'2026-08-31','historic-b'),(3,'2026-09-08','current');
      INSERT INTO region VALUES (1,'region-a'),(2,'region-b');
      INSERT INTO zone_publication_source_state VALUES (1,100,90);
      INSERT INTO config VALUES (1,811);
      INSERT INTO statistic_publication_state VALUES (1,143,'2026-09-08');
    `);
  });

  afterEach(async () => {
    for (const connection of runners) {
      if (connection.isTransactionActive)
        await connection.rollbackTransaction();
      await connection.release();
    }
    runners.clear();
  });

  afterAll(async () => {
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it.each<VersionTable>([
    'statistic_commune',
    'statistic_departement',
    'statistic',
    'region',
  ])('accepts unchanged versions of %s', async (table) => {
    const expected = await versions(table);
    const awaitedRow = await validation(table);
    expect(() =>
      assertVersionValidation(awaitedRow, rowVersionEvidence(expected)),
    ).not.toThrow();
  });

  it.each([
    ['update', "UPDATE statistic_commune SET value='changed' WHERE id=1"],
    ['delete', 'DELETE FROM statistic_commune WHERE id=1'],
    [
      'delete and reinsert',
      "DELETE FROM statistic_commune WHERE id=1; INSERT INTO statistic_commune VALUES (1,'historic-a')",
    ],
    ['insert', "INSERT INTO statistic_commune VALUES (4,'new')"],
  ])('rejects a concurrent %s', async (_label, sql) => {
    const expected = await versions();
    await database.query(sql);
    const row = await validation();
    expect(() =>
      assertVersionValidation(row, rowVersionEvidence(expected)),
    ).toThrow('changed after validation');
  });

  it('rejects duplicate proof identities even when the proof length is unchanged', async () => {
    const expected = await versions();
    expected[1] = expected[0];
    expect(() => rowVersionEvidence(expected)).toThrow();
  });

  it('rejects changed physical table identity', async () => {
    const expected = await versions();
    expected[0].tableoid = (BigInt(expected[0].tableoid) + 1n).toString();
    const row = await validation();
    expect(() =>
      assertVersionValidation(row, rowVersionEvidence(expected)),
    ).toThrow();
  });

  it('matches Node and PostgreSQL digests with numeric rather than lexical ID ordering', async () => {
    await database.query(
      "INSERT INTO statistic_commune VALUES (10,'ten'),(21,'twenty-one'),(100,'hundred')",
    );
    const expected = await versions();
    const shuffled = [
      expected[5],
      expected[1],
      expected[4],
      expected[0],
      expected[3],
      expected[2],
    ];
    const evidence = rowVersionEvidence(shuffled);
    const row = await validation();
    expect(row).toEqual({
      actualCount: 6,
      distinctCount: 6,
      digest: evidence.digest,
    });
    expect(evidence).toEqual(rowVersionEvidence(expected));
    expect(() => assertVersionValidation(row, evidence)).not.toThrow();
  });

  it('rejects an actual replacement relation even when IDs and xmin are unchanged', async () => {
    const transaction = await runner();
    await transaction.startTransaction('READ COMMITTED');
    await transaction.query('UPDATE statistic_commune SET value=value');
    const expected: RowVersion[] = await transaction.query(
      'SELECT id,xmin::text,tableoid::text FROM statistic_commune ORDER BY id',
    );
    await transaction.query(`
      CREATE TABLE statistic_commune_replacement (LIKE statistic_commune INCLUDING ALL);
      INSERT INTO statistic_commune_replacement SELECT * FROM statistic_commune;
      ALTER TABLE statistic_commune RENAME TO statistic_commune_previous;
      ALTER TABLE statistic_commune_replacement RENAME TO statistic_commune;
    `);
    const actual: RowVersion[] = await transaction.query(
      'SELECT id,xmin::text,tableoid::text FROM statistic_commune ORDER BY id',
    );
    expect(actual.map(({ id, xmin }) => ({ id, xmin }))).toEqual(
      expected.map(({ id, xmin }) => ({ id, xmin })),
    );
    expect(actual[0].tableoid).not.toBe(expected[0].tableoid);
    const row = await validation('statistic_commune', transaction);
    expect(() =>
      assertVersionValidation(row, rowVersionEvidence(expected)),
    ).toThrow();
  });

  it('detects a region label change not covered by source revision triggers', async () => {
    const expected = await versions('region');
    await database.query("UPDATE region SET value='renamed' WHERE id=1");
    const row = await validation('region');
    expect(() =>
      assertVersionValidation(row, rowVersionEvidence(expected)),
    ).toThrow();
    expect(
      await database.query(
        'SELECT revision FROM zone_publication_source_state',
      ),
    ).toEqual([{ revision: '100' }]);
  });

  it('records a source DML change in the singleton revision', async () => {
    const writer = await runner();
    await writer.startTransaction();
    await writer.query("INSERT INTO usage VALUES (999,'changed-source')");
    expect(
      await writer.query('SELECT revision FROM zone_publication_source_state'),
    ).toEqual([{ revision: '101' }]);
  });

  it('proves disjoint derived IDs and a forward-only historic sequence', async () => {
    const [guard] = await database.query(EQUIVALENCE_LOOKUP_GUARD_SQL);
    expect(guard).toEqual({
      currentCount: 2,
      currentMin: '1',
      currentMax: '3',
      historicCount: 2,
      historicMin: '100',
      historicMax: '102',
      sequenceLast: '102',
      sequenceCalled: true,
      sequenceIncrement: '1',
      sequenceCycle: false,
    });
    expect(() => assertEquivalenceLookupGuard(guard)).not.toThrow();
  });

  it.each([
    [
      'overlapping IDs',
      "INSERT INTO zone_alerte_computed_historic VALUES (3,'overlap')",
    ],
    [
      'backwards sequence',
      "SELECT setval('zone_alerte_computed_historic_id_seq',50,true)",
    ],
    ['empty current table', 'TRUNCATE zone_alerte_computed'],
    ['empty historic table', 'TRUNCATE zone_alerte_computed_historic'],
    [
      'uncalled sequence',
      "SELECT setval('zone_alerte_computed_historic_id_seq',102,false)",
    ],
    [
      'descending sequence',
      'ALTER SEQUENCE zone_alerte_computed_historic_id_seq INCREMENT BY -1',
    ],
    [
      'cycling sequence',
      'ALTER SEQUENCE zone_alerte_computed_historic_id_seq CYCLE',
    ],
  ])('rejects derived lookup independence with %s', async (_label, sql) => {
    await database.query(sql);
    const [guard] = await database.query(EQUIVALENCE_LOOKUP_GUARD_SQL);
    expect(() => assertEquivalenceLookupGuard(guard)).toThrow();
  });

  it('does not include or alter the current national day in historical CAS', async () => {
    const expected = await versions('statistic');
    await database.query(
      "UPDATE statistic SET value='new-current' WHERE date='2026-09-08'",
    );
    const row = await validation('statistic');
    expect(() =>
      assertVersionValidation(row, rowVersionEvidence(expected)),
    ).not.toThrow();
    expect(
      await database.query(
        "SELECT value FROM statistic WHERE date='2026-09-08'",
      ),
    ).toEqual([{ value: 'new-current' }]);
  });

  it('observes a commit after the first advisory SELECT using READ COMMITTED', async () => {
    const expected = await versions();
    const final = await runner();
    await final.startTransaction('READ COMMITTED');
    await final.query('SELECT pg_try_advisory_xact_lock(919191)');
    await database.query(
      "UPDATE statistic_commune SET value='late-commit' WHERE id=1",
    );
    await acquireEquivalenceFinalLocks(final);
    const row = await validation('statistic_commune', final);
    expect(() =>
      assertVersionValidation(row, rowVersionEvidence(expected)),
    ).toThrow();
  });

  it('demonstrates why a repeatable-read final transaction would miss that commit', async () => {
    const expected = await versions();
    const final = await runner();
    await final.startTransaction('REPEATABLE READ');
    await final.query('SELECT pg_try_advisory_xact_lock(919191)');
    await database.query(
      "UPDATE statistic_commune SET value='late-commit' WHERE id=1",
    );
    await acquireEquivalenceFinalLocks(final);
    const row = await validation('statistic_commune', final);
    expect(() =>
      assertVersionValidation(row, rowVersionEvidence(expected)),
    ).not.toThrow();
  });

  it('refuses a busy statistic writer without waiting', async () => {
    const writer = await runner();
    await writer.startTransaction();
    await writer.query("UPDATE statistic_commune SET value='busy' WHERE id=1");
    const final = await runner();
    await final.startTransaction('READ COMMITTED');
    const started = Date.now();
    await expect(acquireEquivalenceFinalLocks(final)).rejects.toMatchObject({
      code: '55P03',
    });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('refuses an active computation advisory lock without waiting', async () => {
    const writer = await runner();
    await writer.startTransaction();
    await writer.query(
      "SELECT pg_advisory_xact_lock(hashtext('vigieau:statistic-commune:snapshot-computation'))",
    );
    const final = await runner();
    await final.startTransaction('READ COMMITTED');
    await expect(acquireEquivalenceFinalLocks(final)).rejects.toThrow(
      'lock busy',
    );
  });

  it.each([
    'zone_publication_source_state',
    'config',
    'statistic_publication_state',
  ])('refuses a concurrently locked %s singleton', async (table) => {
    const writer = await runner();
    await writer.startTransaction();
    await writer.query(`SELECT id FROM ${table} WHERE id=1 FOR UPDATE`);
    const final = await runner();
    await final.startTransaction('READ COMMITTED');
    await expect(acquireEquivalenceFinalLocks(final)).rejects.toMatchObject({
      code: '55P03',
    });
  });

  it.each([
    "INSERT INTO statistic_commune VALUES (4,'blocked')",
    "UPDATE statistic_departement SET value='blocked' WHERE id=1",
    "UPDATE statistic SET value='blocked' WHERE id=1",
    "UPDATE region SET value='blocked' WHERE id=1",
    "UPDATE zone_alerte_computed SET value='blocked' WHERE id=1",
    "INSERT INTO zone_alerte_computed_historic (value) VALUES ('blocked')",
    'TRUNCATE zone_alerte',
    'ALTER TABLE zone_alerte DISABLE TRIGGER ALL',
    "INSERT INTO zone_alerte VALUES (101,'blocked-by-revision-trigger')",
  ])('guards the final comparison against %s', async (sql) => {
    const final = await runner();
    await final.startTransaction('READ COMMITTED');
    await acquireEquivalenceFinalLocks(final);
    const writer = await runner();
    await writer.startTransaction();
    await writer.query("SET LOCAL lock_timeout='50ms'");
    await expect(writer.query(sql)).rejects.toMatchObject({ code: '55P03' });
    expect(
      await final.query(
        'SELECT count(*)::integer AS count FROM statistic_commune',
      ),
    ).toEqual([{ count: 3 }]);
  });

  it('detects a source TRUNCATE without relying on its absent DML revision bump', async () => {
    const before = await database.query(EQUIVALENCE_RELATIONS_SQL, [
      ['zone_alerte'],
    ]);
    const sourceRevision = await database.query(
      'SELECT revision FROM zone_publication_source_state',
    );
    await database.query('TRUNCATE zone_alerte');
    const after = await database.query(EQUIVALENCE_RELATIONS_SQL, [
      ['zone_alerte'],
    ]);
    expect(after[0].filenode).not.toBe(before[0].filenode);
    expect(
      await database.query(
        'SELECT revision FROM zone_publication_source_state',
      ),
    ).toEqual(sourceRevision);
  });

  it('detects disabled source revision triggers', async () => {
    await database.query(
      'ALTER TABLE zone_alerte DISABLE TRIGGER "TRG_zone_alerte_zone_publication_revision"',
    );
    try {
      const [relation] = await database.query(EQUIVALENCE_RELATIONS_SQL, [
        ['zone_alerte'],
      ]);
      expect(relation.tgenabled).toBe('D');
    } finally {
      await database.query(
        'ALTER TABLE zone_alerte ENABLE TRIGGER "TRG_zone_alerte_zone_publication_revision"',
      );
    }
  });

  it('terminates and rolls back a final transaction exceeding three seconds', async () => {
    const client = new Client({
      connectionString: postgresUrl,
      options: `-c search_path=${schema},public`,
    });
    client.on('error', () => undefined);
    await client.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await acquireEquivalenceFinalLocks({
        query: async (sql: string, parameters?: unknown[]) =>
          (await client.query(sql, parameters)).rows,
      });
      await client.query(
        'UPDATE statistic_publication_state SET revision=144 WHERE id=1',
      );
      await client.query("SET LOCAL statement_timeout='0'");
      await expect(client.query('SELECT pg_sleep(4)')).rejects.toMatchObject({
        code: '25P04',
      });
      expect(
        await database.query(
          'SELECT revision,"currentPublishedDate"::text FROM statistic_publication_state',
        ),
      ).toEqual([{ revision: '143', currentPublishedDate: '2026-09-08' }]);
      await database.query(
        "UPDATE statistic_commune SET value='locks-released' WHERE id=1",
      );
    } finally {
      await client.end();
    }
  }, 10000);
});
