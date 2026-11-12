import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AuditService } from './audit.service';
import { installDataSourceAudit } from './audit-datasource';
import {
  auditActor,
  getAuditContext,
  runWithoutAuditContext,
  systemAuditContext,
  withAuditContext,
} from './audit-context';
import { UserActivityAudit1794477600000 } from '../migrations/1794477600000-UserActivityAudit';

const databaseUrl =
  process.env.USER_ACTIVITY_AUDIT_POSTGRES_URL || process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite('transactional audit core (PostgreSQL)', () => {
  let dataSource: DataSource;
  let service: AuditService;
  const schema = `audit_core_${randomUUID().replace(/-/g, '')}`;
  const context = (email: string) => ({
    ...systemAuditContext('user.update'),
    actor: auditActor({ audit_id: randomUUID(), email, role: 'mte' }),
    source: 'http',
    resourceType: 'user',
    resourceId: 'target@example.test',
  });
  beforeAll(async () => {
    process.env.AUDIT_ENABLED = 'true';
    dataSource = new DataSource({
      type: 'postgres',
      url: databaseUrl,
      entities: [],
      synchronize: false,
      extra: { options: `-c search_path=${schema},public`, max: 5 },
    });
    await dataSource.initialize();
    await dataSource.query(`CREATE SCHEMA "${schema}"`);
    await dataSource.query(
      'CREATE TABLE "user" (email varchar(200) PRIMARY KEY, first_name text, last_name text, role text, role_departements text[], role_communes text[])',
    );
    const runner = dataSource.createQueryRunner();
    try {
      await new UserActivityAudit1794477600000().up(runner);
    } finally {
      await runner.release();
    }
    installDataSourceAudit(dataSource);
    service = new AuditService(dataSource);
    await dataSource.query(
      "INSERT INTO \"user\" (email,role) VALUES ('target@example.test','departement'),('admin@example.test','mte')",
    );
  }, 30000);
  afterAll(async () => {
    delete process.env.AUDIT_ENABLED;
    if (dataSource?.isInitialized) {
      await dataSource.query(`DROP SCHEMA "${schema}" CASCADE`);
      await dataSource.destroy();
    }
  });

  it('records raw autocommit DML atomically and does not leak context to pooled queries', async () => {
    const ctx = context('raw@example.test');
    await withAuditContext(ctx, () =>
      dataSource.query('UPDATE "user" SET first_name=$1 WHERE email=$2', [
        'Updated',
        'target@example.test',
      ]),
    );
    const [event] = await dataSource.query(
      'SELECT * FROM audit_event WHERE operation_id=$1',
      [ctx.operationId],
    );
    expect(event.phase).toBe('applied');
    expect(event.actor.email).toBe('raw@example.test');
    const [change] = await dataSource.query(
      'SELECT * FROM audit_resource WHERE event_id=$1',
      [event.id],
    );
    expect(change.before.first_name).toBeNull();
    expect(change.after.first_name).toBe('Updated');
    const [setting] = await dataSource.query(
      "SELECT current_setting('vigieau.audit_context',true) AS context",
    );
    expect(setting.context || '').toBe('');
  });

  it('rolls back data and audit together for an explicit transaction', async () => {
    const ctx = context('rollback@example.test');
    await expect(
      withAuditContext(ctx, () =>
        dataSource.transaction(async (manager) => {
          await manager.query(
            "UPDATE \"user\" SET first_name='Rollback' WHERE email='target@example.test'",
          );
          throw new Error('business rollback');
        }),
      ),
    ).rejects.toThrow('business rollback');
    expect(
      await dataSource.query(
        'SELECT id FROM audit_event WHERE operation_id=$1',
        [ctx.operationId],
      ),
    ).toHaveLength(0);
    const [user] = await dataSource.query(
      'SELECT first_name FROM "user" WHERE email=\'target@example.test\'',
    );
    expect(user.first_name).toBe('Updated');
  });

  it('isolates interleaved actors and clears context for intentionally unaudited queries', async () => {
    const a = context('a@example.test');
    const b = context('b@example.test');
    await dataSource.transaction(async (manager) => {
      const [one, two] = await Promise.all([
        withAuditContext(a, () =>
          manager.query(
            "SELECT current_setting('vigieau.audit_context')::jsonb->'actor'->>'email' AS actor, pg_sleep(0.01)",
          ),
        ),
        withAuditContext(b, () =>
          manager.query(
            "SELECT current_setting('vigieau.audit_context')::jsonb->'actor'->>'email' AS actor",
          ),
        ),
      ]);
      expect(one[0].actor).toBe('a@example.test');
      expect(two[0].actor).toBe('b@example.test');
      const [empty] = await runWithoutAuditContext(() =>
        manager.query(
          "SELECT current_setting('vigieau.audit_context',true) AS actor",
        ),
      );
      expect(empty.actor).toBe('');
    });
    expect(getAuditContext()).toBeUndefined();
  });

  it('captures the actor snapshot when queued, not after the caller mutates it', async () => {
    const ctx = context('before@example.test');
    const runner = dataSource.createQueryRunner();
    try {
      await runner.startTransaction();
      const task = withAuditContext(ctx, () =>
        runner.query(
          "SELECT current_setting('vigieau.audit_context')::jsonb->'actor'->>'email' AS actor",
        ),
      );
      ctx.actor.email = 'after@example.test';
      expect((await task)[0].actor).toBe('before@example.test');
      await runner.commitTransaction();
    } finally {
      await runner.release();
    }
  });

  it('groups one action, preserves failures after committed effects, and links background outcomes', async () => {
    const ctx = context('partial@example.test');
    await service.recordEvent('started', {}, ctx);
    await withAuditContext(ctx, () =>
      dataSource.query(
        "UPDATE \"user\" SET first_name='Committed' WHERE email='target@example.test'",
      ),
    );
    const eventId = await service.recordEvent(
      'failed',
      { stage: 'external_cleanup', errorCode: 'S3_FAILURE' },
      ctx,
    );
    await service.link(eventId, 'current-zone-revision', '33:123');
    const job = systemAuditContext('current_zone_recompute.complete');
    const jobId = await service.recordEvent('succeeded', {}, job);
    await service.link(jobId, 'current-zone-revision', '33:123');
    const detail = await service.detail(ctx.operationId);
    expect(detail.result).toBe('partial');
    expect(detail.resources).toHaveLength(1);
    expect(detail.relatedOperations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: job.operationId, result: 'succeeded' }),
      ]),
    );
    const list = await service.list({ actor: 'partial@example.test' });
    expect(list.items).toHaveLength(1);
    expect(list.items[0].id).toBe(ctx.operationId);
    await expect(
      service.requireMte({ email: 'target@example.test', role: 'mte' }),
    ).rejects.toThrow();
    await expect(
      service.requireMte({ email: 'admin@example.test', role: 'departement' }),
    ).resolves.toBeUndefined();
  });

  it('paginates same-millisecond events without omission and validates filters', async () => {
    await dataSource.query(`
      INSERT INTO audit_event(operation_id, occurred_at, phase, action, actor)
      SELECT gen_random_uuid(),
        date_trunc('milliseconds', statement_timestamp() - interval '1 second')
          + i * interval '1 microsecond',
        'read', 'user.list', '{"email":"pagination@example.test"}'::jsonb
      FROM generate_series(1, 4) i
    `);
    const first = await service.list({
      actor: 'pagination@example.test',
      limit: '2',
    });
    const second = await service.list({
      actor: 'pagination@example.test',
      limit: '2',
      cursor: first.nextCursor,
    });
    expect(
      JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString()).at,
    ).toMatch(/\.\d{3}003Z$/);
    expect(new Set(first.items.map((x) => x.occurredAt)).size).toBe(1);
    expect(
      new Set([...first.items, ...second.items].map((x) => x.id)).size,
    ).toBe(4);
    expect(second.nextCursor).toBeNull();
    await expect(service.list({ limit: '1000000' })).rejects.toThrow();
    await expect(service.list({ cursor: 'not-a-cursor' })).rejects.toThrow();
  });

  it('uses the database clock for the default upper bound, including sub-millisecond events', async () => {
    const [event] = await dataSource.query(`
      INSERT INTO audit_event(operation_id, occurred_at, phase, action, actor)
      VALUES (gen_random_uuid(),
        date_trunc('milliseconds', statement_timestamp() - interval '1 second')
          + interval '999 microseconds',
        'read', 'user.list', '{"email":"database-clock@example.test"}'::jsonb)
      RETURNING operation_id, occurred_at
    `);
    const applicationClock = new Date(event.occurred_at);
    // Only Date is faked; PostgreSQL and its network timers keep running.
    jest.useFakeTimers({
      now: applicationClock,
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    try {
      const result = await service.list({
        actor: 'database-clock@example.test',
      });
      expect(result.items.map((item) => item.id)).toEqual([event.operation_id]);
      const explicitlyBounded = await service.list({
        actor: 'database-clock@example.test',
        to: applicationClock.toISOString(),
      });
      expect(explicitlyBounded.items).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rolls back the business statement when the trigger cannot persist its audit row', async () => {
    const ctx = context('blocked@example.test');
    await dataSource.query(
      "ALTER TABLE audit_resource ADD CONSTRAINT audit_test_reject CHECK (resource_type <> 'user') NOT VALID",
    );
    try {
      await expect(
        withAuditContext(ctx, () =>
          dataSource.query(
            "UPDATE \"user\" SET first_name='Must not commit' WHERE email='target@example.test'",
          ),
        ),
      ).rejects.toThrow();
      const [user] = await dataSource.query(
        'SELECT first_name FROM "user" WHERE email=\'target@example.test\'',
      );
      expect(user.first_name).toBe('Committed');
      expect(
        await dataSource.query(
          'SELECT id FROM audit_event WHERE operation_id=$1',
          [ctx.operationId],
        ),
      ).toHaveLength(0);
    } finally {
      await dataSource.query(
        'ALTER TABLE audit_resource DROP CONSTRAINT audit_test_reject',
      );
    }
  });

  it('returns every resource of a large cascade through bounded detail pages', async () => {
    const ctx = context('bulk@example.test');
    await dataSource.query(
      "INSERT INTO \"user\" (email,role) SELECT 'bulk-'||n||'@example.test','departement' FROM generate_series(1,105) n",
    );
    await withAuditContext(ctx, () =>
      dataSource.query(
        "UPDATE \"user\" SET first_name='Bulk' WHERE email LIKE 'bulk-%@example.test'",
      ),
    );
    await service.recordEvent('succeeded', {}, ctx);
    const first = await service.detail(ctx.operationId);
    expect(first.resourceCount).toBe(105);
    expect(first.resources).toHaveLength(100);
    expect(first.nextResourceCursor).toBeTruthy();
    const second = await service.detail(
      ctx.operationId,
      first.nextResourceCursor,
    );
    expect(second.resources).toHaveLength(5);
    expect(second.nextResourceCursor).toBeNull();
    expect(
      new Set([...first.resources, ...second.resources].map((r) => r.id)).size,
    ).toBe(105);
  });

  it('refuses unmanaged BEGIN instead of prematurely committing a caller transaction', async () => {
    const runner = dataSource.createQueryRunner();
    try {
      await expect(
        withAuditContext(context('raw-begin@example.test'), () =>
          runner.query('BEGIN'),
        ),
      ).rejects.toThrow('QueryRunner.startTransaction');
      await expect(
        withAuditContext(context('multi-begin@example.test'), () =>
          runner.query('BEGIN; SELECT 1; COMMIT'),
        ),
      ).rejects.toThrow('QueryRunner.startTransaction');
      expect(runner.isTransactionActive).toBe(false);
    } finally {
      await runner.release();
    }
  });

  it('does not hide a completed external effect when the later business transaction fails', async () => {
    const ctx = context('external-partial@example.test');
    await service.recordEvent('started', {}, ctx);
    await service.recordEvent(
      'accepted',
      { externalOutcome: 'uploaded', stage: 's3' },
      ctx,
    );
    await service.recordEvent('failed', { httpStatus: 500 }, ctx);
    expect((await service.detail(ctx.operationId)).result).toBe('partial');
  });
});
