import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { UserActivityAudit1794477600000 } from '../migrations/1794477600000-UserActivityAudit';
import { AuditDatabaseContext } from './audit-db.contract';

const postgresUrl = process.env.USER_ACTIVITY_AUDIT_POSTGRES_URL;
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres('user activity audit atomic PostgreSQL capture', () => {
  const schema = `user_audit_${process.pid}_${Date.now()}`;
  let dataSource: DataSource;
  let runner: QueryRunner;
  let operationId: string;

  const context = (
    patch: Partial<AuditDatabaseContext> = {},
  ): AuditDatabaseContext => ({
    operationId,
    requestId: randomUUID(),
    action: 'arrete-restriction.update',
    actor: {
      id: randomUUID(),
      email: 'agent@example.test',
      role: 'departement',
      departements: ['33'],
    },
    source: 'http',
    method: 'PATCH',
    route: '/api/arrete-restriction/:id',
    ...patch,
  });
  const setContext = (value = context()) =>
    runner.query(`SELECT set_config('vigieau.audit_context', $1, true)`, [
      JSON.stringify(value),
    ]);
  const events = () =>
    runner.query(
      'SELECT * FROM audit_event WHERE operation_id = $1 ORDER BY occurred_at, id',
      [operationId],
    );
  const resources = () =>
    runner.query(
      `SELECT r.* FROM audit_resource r JOIN audit_event e ON e.id = r.event_id WHERE e.operation_id = $1 ORDER BY r.id`,
      [operationId],
    );

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      url: postgresUrl,
      entities: [],
      synchronize: false,
    }).initialize();
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.query(
      `CREATE SCHEMA "${schema}"; SET search_path TO "${schema}", public`,
    );
    await runner.query(`
      CREATE TABLE "user" (email text PRIMARY KEY, first_name text, last_name text, role text, role_departements text[], role_communes text[], check_rules date, password text, id_token text);
      CREATE TABLE departement(id integer PRIMARY KEY, code text);
      CREATE TABLE commune(id integer PRIMARY KEY, "departementId" integer REFERENCES departement(id));
      CREATE TABLE arrete_cadre(id integer PRIMARY KEY, numero text, "departementPiloteId" integer);
      CREATE TABLE arrete_restriction(id integer PRIMARY KEY, numero text, "dateFin" date, "departementId" integer REFERENCES departement(id), updated_at timestamptz DEFAULT now());
      CREATE TABLE restriction(id integer PRIMARY KEY, "arreteRestrictionId" integer REFERENCES arrete_restriction(id) ON DELETE CASCADE, "niveauGravite" text);
      CREATE TABLE usage(id integer PRIMARY KEY, nom text, "restrictionId" integer REFERENCES restriction(id) ON DELETE CASCADE);
      CREATE TABLE usage_feedback(id integer PRIMARY KEY, "arreteRestrictionId" integer, archived boolean, feedback text, "usageDescription" text);
      CREATE TABLE fichier(id integer PRIMARY KEY, nom text, size integer, url text);
      CREATE TABLE arrete_cadre_departement("arreteCadreId" integer REFERENCES arrete_cadre(id) ON DELETE CASCADE, "departementId" integer REFERENCES departement(id), PRIMARY KEY("arreteCadreId", "departementId"));
      CREATE TABLE current_zone_recompute_request("departementId" integer PRIMARY KEY, generation bigint, "targetPublicRevision" bigint, "currentPending" boolean, "lastError" text);
      CREATE TABLE historic_backfill_run(id uuid PRIMARY KEY, status text, "sourceRevision" bigint, "lastError" text);
      CREATE TABLE zone_alerte(id integer PRIMARY KEY, nom text, code text, geom text, "departementId" integer);
      CREATE TABLE zone_publication_source_state(id integer PRIMARY KEY, revision bigint, "publicRevision" bigint, "legacyDualWrite" boolean);
      CREATE TABLE statistic_publication_state(id integer PRIMARY KEY, revision bigint, "currentPublishedDate" date, "historicPublishedThrough" date, "historicDirtyFrom" date, "historicDirtyThrough" date);
    `);
    await new UserActivityAudit1794477600000().up(runner);
  }, 30000);

  beforeEach(async () => {
    operationId = randomUUID();
    await runner.query(`SELECT set_config('vigieau.audit_context', '', false)`);
    await runner.query(`
      TRUNCATE "user", departement, commune, arrete_cadre, arrete_restriction, restriction, usage, usage_feedback, fichier, arrete_cadre_departement, current_zone_recompute_request, historic_backfill_run, zone_alerte, zone_publication_source_state, statistic_publication_state CASCADE;
      INSERT INTO departement VALUES(33, '33'), (47, '47');
      INSERT INTO commune VALUES(33001, 33);
      INSERT INTO arrete_cadre VALUES(1, 'AC-1', 33);
      INSERT INTO arrete_restriction(id, numero, "dateFin", "departementId") VALUES(1, 'AR-1', '2026-11-15', 33);
      INSERT INTO restriction VALUES(1, 1, 'alerte');
      INSERT INTO usage VALUES(1, 'Arrosage', 1);
      INSERT INTO zone_publication_source_state VALUES(1, 571, 50, true);
      INSERT INTO statistic_publication_state(id, revision) VALUES(1, 5);
    `);
  });

  afterEach(async () => {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
  });

  afterAll(async () => {
    if (runner) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.query(`DROP SCHEMA "${schema}" CASCADE`);
      await runner.release();
    }
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('records exact raw SQL changes in the same transaction and rolls them back together', async () => {
    await runner.startTransaction();
    await setContext();
    await runner.query(
      `UPDATE arrete_restriction SET "dateFin" = '2026-11-30' WHERE id = 1`,
    );
    expect(await events()).toHaveLength(1);
    expect(await resources()).toEqual([
      expect.objectContaining({
        resource_type: 'arrete_restriction',
        resource_id: '1',
        operation: 'update',
        before: expect.objectContaining({ dateFin: '2026-11-15' }),
        after: expect.objectContaining({ dateFin: '2026-11-30' }),
        changed_fields: ['dateFin'],
        territories: ['33'],
      }),
    ]);
    await runner.rollbackTransaction();
    expect(await events()).toEqual([]);
    expect(await resources()).toEqual([]);
    expect(
      await runner.query(
        `SELECT "dateFin"::text AS value FROM arrete_restriction WHERE id = 1`,
      ),
    ).toEqual([{ value: '2026-11-15' }]);
  });

  it('deduplicates the applied event per transaction and captures cascaded deletes', async () => {
    await runner.startTransaction();
    await setContext();
    await runner.query('DELETE FROM arrete_restriction WHERE id = 1');
    await runner.commitTransaction();
    expect(await events()).toEqual([
      expect.objectContaining({
        phase: 'applied',
        actor: expect.objectContaining({ email: 'agent@example.test' }),
      }),
    ]);
    expect((await resources()).map((row) => row.resource_type).sort()).toEqual([
      'arrete_restriction',
      'restriction',
      'usage',
    ]);
    expect(
      (await resources()).every(
        (row) => row.operation === 'delete' && row.after === null,
      ),
    ).toBe(true);
  });

  it('rejects the business write if the audit event cannot be inserted', async () => {
    await runner.startTransaction();
    await setContext(context({ action: 'x'.repeat(161) }));
    await expect(
      runner.query(
        `UPDATE arrete_restriction SET numero = 'UNTRACED' WHERE id = 1`,
      ),
    ).rejects.toThrow();
    await runner.rollbackTransaction();
    expect(
      await runner.query('SELECT numero FROM arrete_restriction WHERE id = 1'),
    ).toEqual([{ numero: 'AR-1' }]);
    expect(await events()).toEqual([]);
  });

  it('ignores technical-only/no-op updates and never leaks context into the next transaction', async () => {
    await runner.startTransaction();
    await setContext();
    await runner.query(
      `UPDATE arrete_restriction SET numero = numero, updated_at = now() WHERE id = 1`,
    );
    await runner.commitTransaction();
    await runner.query(
      `UPDATE arrete_restriction SET numero = 'unscoped system operation' WHERE id = 1`,
    );
    expect(await events()).toEqual([]);
  });

  it('captures composite relation keys and target departments', async () => {
    await runner.startTransaction();
    await setContext();
    await runner.query('INSERT INTO arrete_cadre_departement VALUES(1, 47)');
    await runner.query(
      'DELETE FROM arrete_cadre_departement WHERE "departementId" = 47',
    );
    await runner.commitTransaction();
    expect(
      (await resources()).map((r) => ({
        key: r.resource_id,
        operation: r.operation,
        territories: r.territories,
      })),
    ).toEqual([
      { key: '1:47', operation: 'create', territories: ['47'] },
      { key: '1:47', operation: 'delete', territories: ['47'] },
    ]);
  });

  it('keeps stable actor identities after account deletion and does not copy secrets or free comments', async () => {
    await runner.query(
      `INSERT INTO "user"(email, first_name, role, password, id_token) VALUES('user@example.test', 'Camille', 'mte', 'PASSWORD_SECRET', 'OIDC_SECRET')`,
    );
    const [{ audit_id }] = await runner.query('SELECT audit_id FROM "user"');
    await runner.startTransaction();
    await setContext(
      context({
        actor: { id: audit_id, email: 'user@example.test', role: 'mte' },
        metadata: { authorization: 'SECRET_METADATA' },
      }),
    );
    await runner.query(
      `UPDATE "user" SET role = 'departement' WHERE email = 'user@example.test'`,
    );
    await runner.query(
      `INSERT INTO usage_feedback VALUES(1, 1, true, 'PRIVATE_FEEDBACK', 'PRIVATE_DESCRIPTION')`,
    );
    await runner.query(
      `INSERT INTO fichier VALUES(1, 'arrete.pdf', 123, 'https://files.test/private?signature=SIGNED_SECRET')`,
    );
    await runner.query('DELETE FROM "user"');
    await runner.commitTransaction();
    const evidence = JSON.stringify({
      events: await events(),
      resources: await resources(),
    });
    for (const secret of [
      'PASSWORD_SECRET',
      'OIDC_SECRET',
      'SECRET_METADATA',
      'PRIVATE_FEEDBACK',
      'PRIVATE_DESCRIPTION',
      'SIGNED_SECRET',
    ])
      expect(evidence).not.toContain(secret);
    expect((await events())[0].actor.id).toBe(audit_id);
    await runner.query(
      `INSERT INTO "user"(email, role) VALUES('user@example.test', 'mte')`,
    );
    expect(
      (await runner.query('SELECT audit_id FROM "user"'))[0].audit_id,
    ).not.toBe(audit_id);
    await expect(
      runner.query('UPDATE "user" SET audit_id = gen_random_uuid()'),
    ).rejects.toThrow('immutable');
  });

  it('records sensitive field changes as masked values and geometries as fingerprints', async () => {
    await runner.query(
      `INSERT INTO fichier VALUES(1, 'arrete.pdf', 100, 'https://old.test/file'); INSERT INTO zone_alerte VALUES(1, 'Zone', 'Z1', 'GEOMETRY_ORIGINAL', 33)`,
    );
    await runner.startTransaction();
    await setContext();
    await runner.query(
      `UPDATE fichier SET url = 'https://new.test/file?secret=token' WHERE id = 1`,
    );
    await runner.query(
      `UPDATE zone_alerte SET geom = 'GEOMETRY_CHANGED' WHERE id = 1`,
    );
    await runner.commitTransaction();
    const [file, zone] = await resources();
    expect(file.changed_fields).toEqual(['url']);
    expect(file.before.url).toBe('[masqué]');
    expect(file.after.url).toBe('[masqué]');
    expect(zone.changed_fields).toEqual(['geom']);
    expect(zone.before.geom).not.toEqual(zone.after.geom);
    expect(JSON.stringify(zone)).not.toContain('GEOMETRY_');
  });

  it('preserves several initiating operations for one recompute revision', async () => {
    await runner.startTransaction();
    await setContext();
    await runner.query(
      'INSERT INTO current_zone_recompute_request VALUES(33, 1, 571, true, NULL)',
    );
    await runner.commitTransaction();
    const firstOperation = operationId;
    operationId = randomUUID();
    await runner.startTransaction();
    await setContext();
    await runner.query(
      'UPDATE current_zone_recompute_request SET generation = 2 WHERE "departementId" = 33',
    );
    await runner.commitTransaction();
    const linked = await runner.query(
      `SELECT DISTINCT e.operation_id FROM audit_causality c JOIN audit_event e ON e.id = c.event_id WHERE c.kind = 'current-zone-revision' AND c.reference = '33:571'`,
    );
    expect(linked.map((r) => r.operation_id).sort()).toEqual(
      [firstOperation, operationId].sort(),
    );
  });

  it('blocks editing, recent deletion and truncation of audit data', async () => {
    await runner.startTransaction();
    await setContext();
    await runner.query(
      `UPDATE arrete_restriction SET numero = 'AR-2' WHERE id = 1`,
    );
    await runner.commitTransaction();
    await expect(
      runner.query(
        'UPDATE audit_event SET action = action WHERE operation_id = $1',
        [operationId],
      ),
    ).rejects.toThrow('append-only');
    await expect(
      runner.query('DELETE FROM audit_event WHERE operation_id = $1', [
        operationId,
      ]),
    ).rejects.toThrow('two years');
    await expect(
      runner.query('DELETE FROM audit_resource WHERE event_id = $1', [
        (await events())[0].id,
      ]),
    ).rejects.toThrow('two years');
    await expect(runner.query('TRUNCATE audit_event CASCADE')).rejects.toThrow(
      'append-only',
    );
  });

  it('links an idempotent enqueue to its start without inventing a mutation', async () => {
    await runner.query(
      'INSERT INTO current_zone_recompute_request VALUES(33, 1, 571, true, NULL)',
    );
    await runner.query(
      `INSERT INTO audit_event(operation_id, phase, action) VALUES($1, 'started', 'recompute.request')`,
      [operationId],
    );
    await runner.startTransaction();
    await setContext();
    await runner.query(
      'UPDATE current_zone_recompute_request SET "currentPending" = true WHERE "departementId" = 33',
    );
    await runner.commitTransaction();
    expect((await events()).map((e) => e.phase)).toEqual(['started']);
    expect(await resources()).toEqual([]);
    expect(
      await runner.query(
        `SELECT kind, reference FROM audit_causality WHERE event_id = $1`,
        [(await events())[0].id],
      ),
    ).toEqual([{ kind: 'current-zone-revision', reference: '33:571' }]);
  });

  it('preserves all coalesced initiators across user and system revision advances, but not a new queue', async () => {
    await runner.startTransaction();
    await setContext();
    await runner.query(
      'INSERT INTO current_zone_recompute_request VALUES(33, 1, 5, true, NULL)',
    );
    await runner.commitTransaction();
    const firstOperation = operationId;
    operationId = randomUUID();
    await runner.startTransaction();
    await setContext();
    await runner.query(
      'UPDATE current_zone_recompute_request SET generation = 2, "targetPublicRevision" = 6 WHERE "departementId" = 33',
    );
    await runner.commitTransaction();
    await runner.query(
      'UPDATE current_zone_recompute_request SET generation = 3, "targetPublicRevision" = 7 WHERE "departementId" = 33',
    );
    await runner.query(
      'UPDATE current_zone_recompute_request SET generation = 3, "targetPublicRevision" = 7 WHERE "departementId" = 33',
    );
    const linked = await runner.query(
      `SELECT e.operation_id FROM audit_causality c JOIN audit_event e ON e.id = c.event_id WHERE c.kind = 'current-zone-revision' AND c.reference = '33:7'`,
    );
    expect(linked.map((r) => r.operation_id).sort()).toEqual(
      [firstOperation, operationId].sort(),
    );
    await runner.query('DELETE FROM current_zone_recompute_request');
    operationId = randomUUID();
    await runner.startTransaction();
    await setContext();
    await runner.query(
      'INSERT INTO current_zone_recompute_request VALUES(33, 1, 8, true, NULL)',
    );
    await runner.commitTransaction();
    const fresh = await runner.query(
      `SELECT e.operation_id FROM audit_causality c JOIN audit_event e ON e.id = c.event_id WHERE c.kind = 'current-zone-revision' AND c.reference = '33:8'`,
    );
    expect(fresh.map((r) => r.operation_id)).toEqual([operationId]);
  });

  it('purges complete expired operations only, retaining an old start with a recent completion', async () => {
    const expired = randomUUID();
    const active = randomUUID();
    const [old] = await runner.query(
      `INSERT INTO audit_event(operation_id, phase, action, occurred_at) VALUES($1, 'started', 'old', now() - interval '3 years') RETURNING id`,
      [expired],
    );
    await runner.query(
      `INSERT INTO audit_resource(event_id, resource_type, resource_id, operation) VALUES($1, 'user', 'old-user', 'read')`,
      [old.id],
    );
    await runner.query(
      `INSERT INTO audit_causality(event_id, kind, reference) VALUES($1, 'external', 'already-expired-reference')`,
      [old.id],
    );
    await runner.query(
      `INSERT INTO audit_event(operation_id, phase, action, occurred_at) VALUES($1, 'started', 'long-running', now() - interval '3 years'), ($1, 'succeeded', 'long-running', now())`,
      [active],
    );
    await expect(
      runner.query(
        'DELETE FROM audit_event WHERE operation_id = $1 AND phase = $2',
        [active, 'started'],
      ),
    ).rejects.toThrow('two years');
    expect(
      await runner.query('SELECT purge_user_activity_audit(5000) AS count'),
    ).toEqual([{ count: 1 }]);
    expect(
      await runner.query('SELECT id FROM audit_event WHERE operation_id = $1', [
        expired,
      ]),
    ).toEqual([]);
    expect(
      await runner.query('SELECT id FROM audit_resource WHERE event_id = $1', [
        old.id,
      ]),
    ).toEqual([]);
    expect(
      await runner.query('SELECT id FROM audit_causality WHERE event_id = $1', [
        old.id,
      ]),
    ).toEqual([]);
    expect(
      await runner.query('SELECT id FROM audit_event WHERE operation_id = $1', [
        active,
      ]),
    ).toHaveLength(2);
    await expect(
      runner.query('SELECT purge_user_activity_audit(5001)'),
    ).rejects.toThrow('between 1 and 5000');
  });

  it('preserves retained evidence and identities when the migration is reverted', async () => {
    await runner.startTransaction();
    await setContext();
    await runner.query(
      `UPDATE arrete_restriction SET numero = 'BEFORE-ROLLBACK' WHERE id = 1`,
    );
    await runner.commitTransaction();
    await new UserActivityAudit1794477600000().down(runner);
    expect(await events()).toHaveLength(1);
    expect(await resources()).toHaveLength(1);
    await new UserActivityAudit1794477600000().up(runner);
  });

  it('permits separate transactions under one operation before the outer commit', async () => {
    const second = dataSource.createQueryRunner();
    await second.connect();
    try {
      await second.query(
        `SET search_path TO "${schema}", public; SET statement_timeout = '2s'`,
      );
      await runner.startTransaction();
      const ctx = context();
      await setContext(ctx);
      await runner.query(
        `UPDATE arrete_restriction SET numero = 'OUTER' WHERE id = 1`,
      );
      await second.query(
        `INSERT INTO audit_event(operation_id, phase, action) VALUES($1, 'succeeded', 'file.upload')`,
        [operationId],
      );
      await second.startTransaction();
      await second.query(
        `SELECT set_config('vigieau.audit_context', $1, true)`,
        [JSON.stringify(ctx)],
      );
      await second.query(
        `INSERT INTO fichier VALUES(1, 'parallel.pdf', 10, 'https://files.test/parallel')`,
      );
      await second.commitTransaction();
      await runner.commitTransaction();
      expect((await events()).map((e) => e.phase).sort()).toEqual([
        'applied',
        'applied',
        'succeeded',
      ]);
      expect(await resources()).toHaveLength(2);
    } finally {
      if (second.isTransactionActive) await second.rollbackTransaction();
      await second.release();
    }
  });

  it('captures operator publication modes and historical publication state', async () => {
    await runner.startTransaction();
    await setContext();
    await runner.query(
      `UPDATE zone_publication_source_state SET "legacyDualWrite" = false, "publicRevision" = 51 WHERE id = 1`,
    );
    await runner.query(
      `UPDATE statistic_publication_state SET revision = 6, "historicPublishedThrough" = '2026-11-12' WHERE id = 1`,
    );
    await runner.commitTransaction();
    const records = await resources();
    expect(records).toHaveLength(2);
    expect(records[0].after).toMatchObject({
      legacyDualWrite: false,
      publicRevision: 51,
    });
    expect(records[1].after).toMatchObject({
      revision: 6,
      historicPublishedThrough: '2026-11-12',
    });
  });

  it('rechecks retention after waiting for a concurrent event in the same operation', async () => {
    const concurrentOperation = randomUUID();
    await runner.query(
      `INSERT INTO audit_event(operation_id, phase, action, occurred_at) VALUES($1, 'started', 'concurrent', now() - interval '3 years')`,
      [concurrentOperation],
    );
    const writer = dataSource.createQueryRunner();
    await writer.connect();
    try {
      await writer.query(`SET search_path TO "${schema}", public`);
      await writer.startTransaction();
      await writer.query(
        `INSERT INTO audit_event(operation_id, phase, action) VALUES($1, 'succeeded', 'concurrent')`,
        [concurrentOperation],
      );
      const purge = runner.query(
        'SELECT purge_user_activity_audit(5000) AS count',
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      await writer.commitTransaction();
      expect(await purge).toEqual([{ count: 0 }]);
      expect(
        await runner.query(
          'SELECT id FROM audit_event WHERE operation_id = $1',
          [concurrentOperation],
        ),
      ).toHaveLength(2);
    } finally {
      if (writer.isTransactionActive) await writer.rollbackTransaction();
      await writer.release();
    }
  });
});
