import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import {
  canonicalJson,
  importNovemberStatistics,
  NOVEMBER_RECOVERY_DATES,
  NOVEMBER_RECOVERY_SOURCES,
  RecoveryBundle,
  readRecoveryInputEvidence,
  RECOVERY_STATE_SQL,
  RECOVERY_COMMUNE_PROJECTION_SQL,
  RECOVERY_COMMUNE_MERGE_SQL,
} from './import-november-statistics';

const url = process.env.NOVEMBER_RECOVERY_TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
const day = (date: string, severity: string | null = null) => ({
  date,
  SOU: severity,
  SUP: null,
  AEP: null,
});
const oldDays = [
  day('2026-07-11', 'crise'),
  day('2026-11-12', 'vigilance'),
  day('2026-11-16', 'crise'),
];
const oldMonths = [
  { date: '2026-07', ponderation: 4 },
  { date: '2026-10', ponderation: 2 },
  { date: '2026-11', ponderation: 4.5 },
];
const codes = Array.from({ length: 34943 }, (_, index) =>
  String(index + 1).padStart(5, '0'),
);
const departmentCodes = Array.from({ length: 101 }, (_, index) =>
  String(index + 1).padStart(2, '0'),
).sort();
const area = { vigilance: 0, alerte: 0, alerte_renforcee: 0, crise: 0 };
const situation = Object.fromEntries(
  departmentCodes.map((code) => [
    code,
    { max: null, sou: null, sup: null, aep: null },
  ]),
);
const bundle: RecoveryBundle = {
  manifestSha256: 'a'.repeat(64),
  days: NOVEMBER_RECOVERY_SOURCES.map((source, index) => ({
    source: {
      ...source,
      dumpSha256: 'b'.repeat(64),
      sourceDatabase: `isolated_${index}`,
      sourceRevision: String(169371 + Number(index === 2)),
      historicComputeEpoch: '1447',
      geometryEvidenceSha256: 'c'.repeat(64),
      statisticInputDigest: 'f'.repeat(64),
      payloadFile: `${source.date}.json`,
      payloadSha256: 'd'.repeat(64),
    },
    communes: codes.map((code) => ({
      code,
      restriction: day(
        source.date,
        ['alerte', 'alerte_renforcee', 'crise'][index],
      ),
    })),
    departments: departmentCodes.map((code) => ({
      code,
      restriction: { date: source.date, SOU: area, SUP: area, AEP: area },
    })),
    statistic: { date: source.date, departementSituation: situation },
  })),
};

postgres('November importer against PostgreSQL', () => {
  jest.setTimeout(120_000);
  let client: Client;
  let other: Client;
  let schema: string;
  let databaseName: string;
  beforeAll(async () => {
    client = new Client({ connectionString: url });
    other = new Client({ connectionString: url });
    await client.connect();
    await other.connect();
    // Keep fixture execution independent from host-specific LLVM/JIT support.
    await client.query('SET jit=off');
    await other.query('SET jit=off');
    databaseName = (await client.query('SELECT current_database() AS name'))
      .rows[0].name;
  });
  afterAll(async () => {
    await other.end();
    await client.end();
  });
  beforeEach(async () => {
    schema = `november_import_${randomUUID().replaceAll('-', '')}`;
    await client.query(
      `CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`,
    );
    await other.query(`SET search_path TO "${schema}"`);
    await client.query(`
      CREATE TABLE config (id integer PRIMARY KEY, "computeMapDate" date, "computeStatsDate" date, "historicComputeEpoch" bigint, "historicBackfillGlobalEpoch" bigint);
      INSERT INTO config VALUES (1,'2010-08-11','2010-08-11',1447,9);
      CREATE TABLE historic_range_invalidation ("epochAfter" bigint PRIMARY KEY,"affectedRange" daterange,"invalidatesStatistics" boolean,"invalidatesMaps" boolean,cause text);
      CREATE TABLE zone_publication_source_state (id integer PRIMARY KEY, revision bigint, "publicRevision" bigint);
      INSERT INTO zone_publication_source_state VALUES (1,169376,169376);
      CREATE TABLE statistic_publication_state (id integer PRIMARY KEY, revision bigint, "currentPublishedDate" date, "historicPublishedThrough" date, "historicDirtyFrom" date, "historicDirtyThrough" date, "updatedAt" timestamptz DEFAULT now());
      INSERT INTO statistic_publication_state VALUES (1,400,'2026-11-16','2026-08-27','2026-07-11','2026-08-31',now());
      CREATE TABLE zone_publication_state (id integer PRIMARY KEY, "activePublicationId" text);
      INSERT INTO zone_publication_state VALUES (1,'active-current');
      CREATE TABLE zone_publication (id text PRIMARY KEY,status text,"sourceRevision" bigint,"sourceComputedAt" timestamptz);
      INSERT INTO zone_publication VALUES ('active-current','active',169376,'2026-11-16T12:00:00Z');
      CREATE TABLE certified_history_repair_audit (id text PRIMARY KEY,"dateFrom" date,"dateThrough" date,proof text);
      INSERT INTO certified_history_repair_audit VALUES ('repair-v2','2026-07-11','2026-08-31','do-not-change');
      CREATE TABLE certified_history_repair_attestation (id text PRIMARY KEY,"repairId" text,proof text);
      INSERT INTO certified_history_repair_attestation VALUES ('attestation-v2','repair-v2','do-not-change');
      CREATE TABLE current_zone_recompute_request ("currentPending" boolean,"pendingScheduledDates" date[]);
      CREATE TABLE external_publication_run (status text,"jobKey" text);
      CREATE TABLE historic_backfill_run (status text);
      CREATE TABLE commune (id integer PRIMARY KEY,code text UNIQUE);
      INSERT INTO commune SELECT n,lpad(n::text,5,'0') FROM generate_series(1,34943) n;
      CREATE TABLE departement (id integer PRIMARY KEY,code text UNIQUE);
      INSERT INTO departement SELECT n,CASE WHEN n<100 THEN lpad(n::text,2,'0') ELSE n::text END FROM generate_series(1,101) n;
      CREATE TABLE statistic_commune (id integer PRIMARY KEY,"communeId" integer UNIQUE,restrictions jsonb,"restrictionsByMonth" jsonb);
      CREATE TABLE statistic_departement (id integer PRIMARY KEY,"departementId" integer UNIQUE,restrictions jsonb, visits jsonb,subscriptions integer);
      CREATE TABLE statistic (id serial PRIMARY KEY,date date UNIQUE,"departementSituation" json,visits integer,"profileRepartition" json);
      INSERT INTO statistic(date,visits,"profileRepartition") SELECT date::date,123,'{"preserved":true}'::json FROM unnest(ARRAY['2026-11-13','2026-11-14','2026-11-15','2026-11-16']) date;
      CREATE TABLE statistic_commune_snapshot ("snapshotDate" date,scope text,status text,"expectedCommuneCount" integer,"processedCommuneCount" integer,"sourceRevision" bigint,"certifiedHistoryRepairId" text,"startedAt" timestamptz,"completedAt" timestamptz,"lastError" text,"createdAt" timestamptz,"updatedAt" timestamptz,PRIMARY KEY("snapshotDate",scope));
      INSERT INTO statistic_commune_snapshot("snapshotDate",scope,status,"expectedCommuneCount","processedCommuneCount","sourceRevision","certifiedHistoryRepairId") VALUES
        ('2026-07-11','national','completed',34943,34943,42,'repair-v2'),('2026-11-16','national','completed',34943,34943,169376,NULL);
      ALTER TABLE commune ADD COLUMN "departementId" integer DEFAULT 1, ADD COLUMN population integer DEFAULT 1000, ADD COLUMN disabled boolean DEFAULT false, ADD COLUMN geom text DEFAULT 'commune-geometry';
      ALTER TABLE departement ADD COLUMN nom text DEFAULT 'Department', ADD COLUMN "regionId" integer DEFAULT 1, ADD COLUMN geom text DEFAULT 'department-geometry';
      CREATE FUNCTION ST_AsEWKB(text) RETURNS bytea LANGUAGE SQL IMMUTABLE AS 'SELECT convert_to($1,''UTF8'')';
      CREATE FUNCTION ST_SRID(text) RETURNS integer LANGUAGE SQL IMMUTABLE AS 'SELECT 4326';
      CREATE TABLE region(id integer,code text,nom text,"domOn" boolean);
      INSERT INTO region VALUES(1,'01','Region',false);
      CREATE TABLE bassin_versant(id integer,code text,nom text);
      INSERT INTO bassin_versant VALUES(1,'B1','Basin');
      CREATE TABLE bassin_versant_departement("bassinVersantId" integer,"departementId" integer);
      CREATE TABLE arrete_restriction(id integer,"dateDebut" date,"dateFin" date,"dateSignature" date,statut text,"departementId" integer,"niveauGraviteSpecifiqueEap" boolean,"ressourceEapCommunique" text);
      INSERT INTO arrete_restriction VALUES(1,'2026-11-01',NULL,'2026-10-30','publie',1,false,'SOU');
      CREATE TABLE restriction(id integer,"arreteRestrictionId" integer,"zoneAlerteId" integer,"arreteCadreId" integer,"niveauGravite" text,"nomGroupementAep" text);
      INSERT INTO restriction VALUES(1,1,1,1,'alerte',NULL);
      CREATE TABLE restriction_commune("restrictionId" integer,"communeId" integer);
      CREATE TABLE zone_alerte(id integer,type text,nom text,code text,disabled boolean,geom text,"idSandre" text,"ressourceInfluencee" boolean,"departementId" integer);
      INSERT INTO zone_alerte VALUES(1,'SOU','Zone','Z1',false,'zone-geometry',NULL,false,1);
      CREATE TABLE arrete_cadre_zone_alerte_communes(id integer,"zoneAlerteId" integer,"arreteCadreId" integer);
      CREATE TABLE ac_za_communes("communeId" integer,"arreteCadreZoneAlerteCommunesId" integer);
      CREATE TABLE parametres(id integer,"departementId" integer,"superpositionCommune" boolean,disabled boolean,"dateDebut" date,"dateFin" date);
      INSERT INTO parametres VALUES(1,1,false,false,'2026-01-01',NULL);
      CREATE TABLE audit_event (id uuid,operation_id uuid,phase text,action text,actor jsonb,source text,request_id uuid,metadata jsonb);
    `);
    await client.query(
      'INSERT INTO statistic_commune SELECT id,id,$1::jsonb,$2::jsonb FROM commune',
      [JSON.stringify(oldDays), JSON.stringify(oldMonths)],
    );
    await client.query(
      "INSERT INTO statistic_departement SELECT id,id,$1::jsonb,'[1,2,3]'::jsonb,321 FROM departement",
      [
        JSON.stringify([
          { date: '2026-11-16', SOU: area, SUP: area, AEP: area },
        ]),
      ],
    );
    for (const day of bundle.days)
      day.source.statisticInputDigest = (
        await readRecoveryInputEvidence(client, day.source.date)
      ).digest;
  });
  afterEach(async () => {
    await client.query('ROLLBACK');
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
  });

  async function protectedState() {
    const state = (
      await client.query(RECOVERY_STATE_SQL, [NOVEMBER_RECOVERY_DATES])
    ).rows[0];
    delete state.statistics.revision;
    delete state.statistics.updatedAt;
    return canonicalJson(state);
  }
  async function outsideData() {
    return (
      await client.query(
        `SELECT
      (SELECT md5(string_agg((SELECT jsonb_agg(day ORDER BY ord)::text FROM jsonb_array_elements(restrictions) WITH ORDINALITY d(day,ord) WHERE NOT day->>'date'=ANY($1::text[])),'|' ORDER BY id)) FROM statistic_commune) AS days,
      (SELECT md5(string_agg((SELECT jsonb_agg(month ORDER BY ord)::text FROM jsonb_array_elements("restrictionsByMonth") WITH ORDINALITY m(month,ord) WHERE month->>'date'<>'2026-11'),'|' ORDER BY id)) FROM statistic_commune) AS months,
      (SELECT md5(jsonb_agg(to_jsonb(statistic)-'departementSituation' ORDER BY date)::text) FROM statistic) AS analytics,
      (SELECT md5(jsonb_agg(to_jsonb(statistic_departement)-'restrictions' ORDER BY id)::text) FROM statistic_departement) AS departments`,
        [NOVEMBER_RECOVERY_DATES],
      )
    ).rows[0];
  }
  const options = () => ({
    apply: false,
    expectedDatabase: databaseName,
    operator: 'test-operator',
    batchSize: 500,
  });

  it('dry-runs, imports atomically, preserves outside data and all prior certifications, and is idempotent', async () => {
    const stateBefore = await protectedState();
    const dataBefore = await outsideData();
    const dryRun = await importNovemberStatistics(client, bundle, options());
    expect(dryRun).toMatchObject({
      status: 'DRY_RUN',
      changedCommunes: 34943,
      addedCommuneDays: 104829,
      changedDepartments: 101,
      addedDepartmentDays: 303,
      certifiedDays: 3,
    });
    expect(
      (await client.query('SELECT count(*)::integer AS count FROM audit_event'))
        .rows[0].count,
    ).toBe(0);
    expect(await protectedState()).toBe(stateBefore);
    expect(await outsideData()).toEqual(dataBefore);
    const applied = await importNovemberStatistics(client, bundle, {
      ...options(),
      apply: true,
      expectedContext: dryRun.context,
    });
    expect(applied).toMatchObject({
      status: 'APPLIED',
      revisionBefore: '400',
      revisionAfter: '401',
    });
    expect(await protectedState()).toBe(stateBefore);
    expect(await outsideData()).toEqual(dataBefore);
    expect(
      (
        await client.query(
          'SELECT "restrictionsByMonth" FROM statistic_commune WHERE id=1',
        )
      ).rows[0].restrictionsByMonth,
    ).toEqual([
      ...oldMonths.slice(0, 2),
      { date: '2026-11', ponderation: 13.5 },
    ]);
    expect(
      (
        await client.query(
          'SELECT status,"expectedCommuneCount","processedCommuneCount","certifiedHistoryRepairId" FROM statistic_commune_snapshot WHERE "snapshotDate"=ANY($1::date[])',
          [NOVEMBER_RECOVERY_DATES],
        )
      ).rows,
    ).toEqual(
      Array.from({ length: 3 }, () => ({
        status: 'completed',
        expectedCommuneCount: 34943,
        processedCommuneCount: 34943,
        certifiedHistoryRepairId: null,
      })),
    );
    expect(
      (
        await client.query(
          'SELECT phase,action FROM audit_event ORDER BY phase',
        )
      ).rows,
    ).toEqual([
      { phase: 'started', action: 'statistics.import_november_2026' },
      { phase: 'succeeded', action: 'statistics.import_november_2026' },
    ]);
    expect(
      (
        await client.query(
          'SELECT actor,source,metadata FROM audit_event LIMIT 1',
        )
      ).rows[0],
    ).toMatchObject({
      source: 'system',
      actor: {
        id: null,
        email: null,
        firstName: null,
        lastName: null,
        role: null,
        departements: [],
        communes: [],
      },
      metadata: { operator: 'test-operator' },
    });
    const repeat = await importNovemberStatistics(client, bundle, options());
    expect(repeat).toMatchObject({
      changedCommunes: 0,
      changedDepartments: 0,
      changedNationalDays: 0,
      certifiedDays: 0,
    });
    await expect(
      importNovemberStatistics(client, bundle, {
        ...options(),
        apply: true,
        expectedContext: repeat.context,
      }),
    ).resolves.toMatchObject({ status: 'UNCHANGED', revisionAfter: '401' });
  });

  it('rolls back every imported point when a concurrent source revision appears', async () => {
    const dryRun = await importNovemberStatistics(client, bundle, options());
    let changed = false;
    const database = {
      query: async (sql: string, parameters?: any[]) => {
        const result = await client.query(sql, parameters);
        if (!changed && sql.includes('UPDATE statistic_commune target')) {
          changed = true;
          await other.query(
            'UPDATE zone_publication_source_state SET "publicRevision"="publicRevision"+1',
          );
        }
        return result;
      },
    };
    await expect(
      importNovemberStatistics(database, bundle, {
        ...options(),
        apply: true,
        expectedContext: dryRun.context,
      }),
    ).rejects.toThrow('context changed');
    expect(changed).toBe(true);
    expect(
      (
        await client.query(
          'SELECT restrictions FROM statistic_commune WHERE id=1',
        )
      ).rows[0].restrictions,
    ).toEqual(oldDays);
    expect(
      (
        await client.query(
          'SELECT revision::text FROM statistic_publication_state',
        )
      ).rows[0].revision,
    ).toBe('400');
    expect((await client.query('SELECT phase FROM audit_event')).rows).toEqual([
      { phase: 'failed' },
    ]);
  });

  it('rejects changed reference identities even when the counts still match', async () => {
    await client.query("UPDATE commune SET code='ZZZZZ' WHERE id=1");
    await expect(
      importNovemberStatistics(client, bundle, options()),
    ).rejects.toThrow('inputs diverge');
  });

  it('accepts an equivalent closure after the recovered dates, but rejects changed restriction inputs', async () => {
    await client.query(`UPDATE config SET "historicComputeEpoch"=1448;
      INSERT INTO historic_range_invalidation VALUES(1448,'[2026-11-01,2026-11-16)',true,true,'published-calendar-mutation');
      UPDATE arrete_restriction SET "dateFin"='2026-11-15', statut='abroge'`);
    await expect(
      importNovemberStatistics(client, bundle, options()),
    ).resolves.toHaveProperty('status', 'DRY_RUN');
    await client.query(`UPDATE restriction SET "niveauGravite"='crise'`);
    await expect(
      importNovemberStatistics(client, bundle, options()),
    ).rejects.toThrow('Historical statistical inputs diverge on 2026-11-13');
    expect(
      (await client.query('SELECT count(*)::integer AS count FROM audit_event'))
        .rows[0].count,
    ).toBe(0);
  });

  it('refuses any missing epoch even when the listed invalidations concern maps only', async () => {
    await client.query(`UPDATE config SET "historicComputeEpoch"=1450;
      INSERT INTO historic_range_invalidation VALUES
        (1448,'[2026-11-01,2026-11-16)',false,true,'published-calendar-mutation'),
        (1450,'[2026-11-01,2026-11-16)',false,true,'published-calendar-mutation')`);
    await expect(
      importNovemberStatistics(client, bundle, options()),
    ).rejects.toThrow('ledger is incomplete');
  });

  it('refuses a divergent existing recovered day without touching the target', async () => {
    await client.query(
      `UPDATE statistic_commune SET restrictions=restrictions || $1::jsonb WHERE id=1`,
      [JSON.stringify([day('2026-11-13', 'crise')])],
    );
    const baseline = (
      await client.query(
        'SELECT restrictions FROM statistic_commune WHERE id=1',
      )
    ).rows[0].restrictions;
    await expect(
      importNovemberStatistics(client, bundle, options()),
    ).rejects.toThrow('diverges');
    expect(
      (
        await client.query(
          'SELECT restrictions FROM statistic_commune WHERE id=1',
        )
      ).rows[0].restrictions,
    ).toEqual(baseline);
  });

  it('merges long histories on the server while preserving every outside value and relative order', async () => {
    const start = Date.parse('2013-01-01T00:00:00Z');
    const count = (Date.parse('2026-11-12T00:00:00Z') - start) / 86400000 + 1;
    const history = Array.from({ length: count }, (_, index) =>
      day(new Date(start + index * 86400000).toISOString().slice(0, 10)),
    );
    history[history.length - 1].SOU = 'vigilance';
    [history[0], history[1]] = [history[1], history[0]];
    history.push(day('2026-11-16', 'crise'));
    await client.query(
      'UPDATE statistic_commune SET restrictions=$1::jsonb WHERE id<=100',
      [JSON.stringify(history)],
    );
    const projected = (
      await client.query(RECOVERY_COMMUNE_PROJECTION_SQL, [codes.slice(0, 100)])
    ).rows[0];
    expect(projected.restrictions).toHaveLength(13);
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(history)) / 50,
    );
    const outside = await outsideData();
    const dryRun = await importNovemberStatistics(client, bundle, options());
    await importNovemberStatistics(client, bundle, {
      ...options(),
      apply: true,
      expectedContext: dryRun.context,
    });
    expect(await outsideData()).toEqual(outside);
    const after = (
      await client.query(
        'SELECT restrictions FROM statistic_commune WHERE id=1',
      )
    ).rows[0].restrictions;
    expect(
      after.filter((entry) => !NOVEMBER_RECOVERY_DATES.includes(entry.date)),
    ).toEqual(history);
    expect(after.slice(-4).map((entry) => entry.date)).toEqual([
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
      '2026-11-16',
    ]);
    await client.query(
      'UPDATE statistic_commune SET restrictions=restrictions || $1::jsonb WHERE id=1',
      [JSON.stringify([history[0]])],
    );
    await expect(
      importNovemberStatistics(client, bundle, options()),
    ).resolves.toMatchObject({ status: 'DRY_RUN', changedCommunes: 0 });
    await client.query(
      'UPDATE statistic_commune SET restrictions=restrictions || $1::jsonb WHERE id=1',
      [JSON.stringify([day('2026-11-12')])],
    );
    await expect(
      importNovemberStatistics(client, bundle, options()),
    ).rejects.toThrow('duplicated');
  });

  it('rejects a concurrent xmin change without overwriting its daily or monthly values', async () => {
    const dryRun = await importNovemberStatistics(client, bundle, options());
    let changed = false;
    const database = {
      query: async (sql: string, parameters?: any[]) => {
        if (!changed && sql === RECOVERY_COMMUNE_MERGE_SQL) {
          changed = true;
          await other.query(
            `UPDATE statistic_commune SET "restrictionsByMonth"=jsonb_set("restrictionsByMonth",'{1,ponderation}','999'::jsonb) WHERE id=1`,
          );
        }
        return client.query(sql, parameters);
      },
    };
    await expect(
      importNovemberStatistics(database, bundle, {
        ...options(),
        apply: true,
        expectedContext: dryRun.context,
      }),
    ).rejects.toThrow('Concurrent commune statistic modification');
    expect(changed).toBe(true);
    expect(
      (
        await client.query(
          'SELECT restrictions,"restrictionsByMonth" FROM statistic_commune WHERE id=1',
        )
      ).rows[0],
    ).toEqual({
      restrictions: oldDays,
      restrictionsByMonth: [
        oldMonths[0],
        { date: '2026-10', ponderation: 999 },
        oldMonths[2],
      ],
    });
    expect(
      (
        await client.query(
          'SELECT restrictions FROM statistic_commune WHERE id=2',
        )
      ).rows[0].restrictions,
    ).toEqual(oldDays);
    expect((await client.query('SELECT phase FROM audit_event')).rows).toEqual([
      { phase: 'failed' },
    ]);
  });

  it('still rolls back if protected history changes while batches use the lightweight fence', async () => {
    const dryRun = await importNovemberStatistics(client, bundle, options());
    let writes = 0;
    const database = {
      query: async (sql: string, parameters?: any[]) => {
        const result = await client.query(sql, parameters);
        if (sql === RECOVERY_COMMUNE_MERGE_SQL && ++writes === 1)
          await other.query(
            `UPDATE certified_history_repair_attestation SET proof='concurrent-proof'`,
          );
        return result;
      },
    };
    await expect(
      importNovemberStatistics(database, bundle, {
        ...options(),
        apply: true,
        expectedContext: dryRun.context,
      }),
    ).rejects.toThrow('Publication context changed');
    expect(writes).toBe(Math.ceil(34943 / 500));
    expect(
      (
        await client.query(
          'SELECT restrictions FROM statistic_commune WHERE id=34943',
        )
      ).rows[0].restrictions,
    ).toEqual(oldDays);
    expect((await client.query('SELECT phase FROM audit_event')).rows).toEqual([
      { phase: 'failed' },
    ]);
  });

  it('yields without writes when the current computation holds its lock', async () => {
    await other.query(
      "SELECT pg_advisory_lock(hashtext('vigieau'),hashtext('current-zone-recompute'))",
    );
    try {
      await expect(
        importNovemberStatistics(client, bundle, options()),
      ).rejects.toThrow('required lock');
    } finally {
      await other.query(
        "SELECT pg_advisory_unlock(hashtext('vigieau'),hashtext('current-zone-recompute'))",
      );
    }
    expect(
      (await client.query('SELECT count(*)::integer AS count FROM audit_event'))
        .rows[0].count,
    ).toBe(0);
  });
});
