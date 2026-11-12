import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import * as Sentry from '@sentry/nestjs';
import { RegleauLogger } from '../logger/regleau.logger';
import { BusinessCron } from '../core/scheduling/business-cron';
import {
  AuditContext,
  getAuditContext,
  isAuditEnabled,
  runWithoutAuditContext,
  systemAuditContext,
} from './audit-context';
import { auditActionLabel } from './audit-catalog';
import { AUDIT_EVENT_PHASES, AuditEventPhase } from './audit-db.contract';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const METADATA_KEYS = new Set([
  'resourceType',
  'resourceId',
  'resourceLabel',
  'territories',
  'simulation',
  'httpStatus',
  'durationMs',
  'returnedCount',
  'resultCount',
  'errorCode',
  'stage',
  'outcome',
  'externalOutcome',
  'fileId',
  'fileName',
  'size',
  'mimeType',
  'sha256',
  'verdict',
  'engineVersion',
  'signatureVersion',
  'runId',
  'publicationId',
  'publicRevision',
  'departementId',
  'departmentId',
  'revision',
  'requestedBy',
  'networkAddress',
  'networkSource',
  'userAgent',
  'responseClosed',
  'page',
  'limit',
  'depCode',
  'departementCode',
  'sortBy',
  'filter.statut',
  'filter.departement.code',
  'purgedOperations',
  'initiatingOperationId',
  'parentOperationId',
  'jobResult',
  'causeCount',
  'template',
  'recipientCount',
]);

export function sanitizeAuditMetadata(
  input: Record<string, unknown> = {},
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!METADATA_KEYS.has(key)) continue;
    if (typeof value === 'string')
      result[key] = value
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .slice(0, key === 'userAgent' ? 300 : 200);
    else if (
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      value === null
    )
      result[key] = value;
    else if (Array.isArray(value))
      result[key] = value
        .filter((v) => typeof v === 'string' && /^[\w-]{1,40}$/.test(v))
        .slice(0, 1000);
  }
  return result;
}

const operationSql = (where = '') => `
  SELECT operation_id, min(occurred_at) AS started_at, max(occurred_at) AS occurred_at,
    bool_or(phase='applied') AS has_changes,
    (array_agg(source ORDER BY occurred_at DESC, id DESC))[1] AS source,
    (array_agg(action ORDER BY occurred_at DESC, id DESC))[1] AS action,
    (array_agg(actor ORDER BY (actor->>'email' IS NOT NULL) DESC, occurred_at DESC, id DESC))[1] AS actor,
    (array_agg(metadata ORDER BY (metadata->>'resourceType' IS NOT NULL) DESC, occurred_at DESC, id DESC))[1] AS metadata,
    CASE
      WHEN bool_or(phase='failed') AND bool_or(phase='applied' OR metadata->>'externalOutcome' IN ('uploaded','referenced','deleted','smtp_accepted')) THEN 'partial'
      WHEN bool_or(phase='denied') AND NOT bool_or(phase='applied') THEN 'denied'
      WHEN bool_or(phase='failed') THEN 'failed'
      WHEN bool_or(phase IN ('succeeded','read')) THEN 'succeeded'
      WHEN bool_or(phase='accepted') THEN 'accepted'
      WHEN bool_or(phase='unknown') OR max(occurred_at) < now() - interval '15 minutes' THEN 'unknown'
      ELSE 'started'
    END AS result
  FROM audit_event ${where} GROUP BY operation_id`;

function bounded(value: unknown, name: string, max = 200): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (
    typeof value !== 'string' ||
    value.length > max ||
    /[\u0000-\u001f]/.test(value)
  )
    throw new BadRequestException(`Filtre ${name} invalide`);
  return value;
}

function dateFilter(value: unknown, name: string, fallback: Date): string {
  if (value === undefined || value === '') return fallback.toISOString();
  if (
    typeof value !== 'string' ||
    value.length > 35 ||
    !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)
  )
    throw new BadRequestException(`Date ${name} invalide`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new BadRequestException(`Date ${name} invalide`);
  return date.toISOString();
}

@Injectable()
export class AuditService {
  private readonly logger = new RegleauLogger('Audit');
  private failures = 0;
  private lastFailureAt: string | null = null;
  private lastPurgeAt: string | null = null;

  constructor(private readonly dataSource: DataSource) {}

  async recordEvent(
    phase: AuditEventPhase,
    metadata: Record<string, unknown> = {},
    context: AuditContext = getAuditContext(),
    manager?: EntityManager,
  ): Promise<string | null> {
    if (!isAuditEnabled() || !context) return null;
    if (
      !(AUDIT_EVENT_PHASES as readonly string[]).includes(phase) ||
      phase === 'applied'
    )
      throw new Error('Invalid application audit phase');
    const id = randomUUID();
    const sql = `INSERT INTO audit_event (id,operation_id,phase,action,actor,source,request_id,method,route,metadata)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb)`;
    const parameters = [
      id,
      context.operationId,
      phase,
      context.action,
      JSON.stringify(context.actor ?? {}),
      context.source,
      context.requestId ?? null,
      context.method ?? null,
      context.route ?? null,
      JSON.stringify(
        sanitizeAuditMetadata({
          ...context.metadata,
          resourceType: context.resourceType ?? context.metadata?.resourceType,
          resourceId: context.resourceId ?? context.metadata?.resourceId,
          ...metadata,
        }),
      ),
    ];
    if (manager)
      await runWithoutAuditContext(() => manager.query(sql, parameters));
    else {
      let expired = false;
      let timer: ReturnType<typeof setTimeout>;
      const write = runWithoutAuditContext(async () => {
        const runner = this.dataSource.createQueryRunner();
        try {
          await runner.connect();
          if (expired) throw new Error('Audit connection deadline');
          await runner.startTransaction();
          await runner.query("SET LOCAL statement_timeout = '1800ms'");
          if (expired) throw new Error('Audit statement deadline');
          await runner.query(sql, parameters);
          await runner.commitTransaction();
        } catch (error) {
          if (runner.isTransactionActive)
            await runner.rollbackTransaction().catch(() => undefined);
          throw error;
        } finally {
          await runner.release();
        }
      });
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new Error('Audit write deadline'));
        }, 2000);
      });
      try {
        await Promise.race([write, deadline]);
      } finally {
        clearTimeout(timer);
      }
    }
    return id;
  }

  async recordBestEffort(
    phase: AuditEventPhase,
    metadata: Record<string, unknown> = {},
    context: AuditContext = getAuditContext(),
  ): Promise<string | null> {
    try {
      return await this.recordEvent(phase, metadata, context);
    } catch {
      this.reportFailure(context?.operationId);
      return null;
    }
  }

  reportFailure(operationId?: string): void {
    this.failures++;
    this.lastFailureAt = new Date().toISOString();
    // Do not include a PostgreSQL error: it can contain the rejected row or SQL parameters.
    this.logger.error(
      `AUDIT_WRITE_FAILED operation=${UUID.test(operationId ?? '') ? operationId : 'unknown'} count=${this.failures}`,
      '',
    );
    if (process.env.SENTRY_DSN?.trim())
      Sentry.captureMessage('AUDIT_WRITE_FAILED', {
        level: 'error',
        tags: { component: 'audit' },
        extra: {
          operationId: UUID.test(operationId ?? '') ? operationId : null,
          count: this.failures,
        },
      });
  }

  async link(
    eventId: string,
    kind: string,
    reference: string,
    manager?: EntityManager,
  ): Promise<void> {
    if (!isAuditEnabled() || !eventId) return;
    if (
      !UUID.test(eventId) ||
      !/^[a-z_-]{1,40}$/.test(kind) ||
      typeof reference !== 'string' ||
      reference.length > 200
    )
      throw new Error('Invalid audit causality');
    await runWithoutAuditContext(() =>
      (manager ?? this.dataSource).query(
        'INSERT INTO audit_causality(event_id,kind,reference) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [eventId, kind, reference],
      ),
    );
  }

  async requireMte(sessionUser: any): Promise<void> {
    if (!sessionUser?.email)
      throw new ForbiddenException('Accès réservé aux administrateurs MTE');
    const [user] = await runWithoutAuditContext(() =>
      this.dataSource.query('SELECT role FROM "user" WHERE email = $1', [
        sessionUser.email,
      ]),
    );
    if (user?.role !== 'mte')
      throw new ForbiddenException('Accès réservé aux administrateurs MTE');
  }

  private present(row: any): any {
    return {
      id: row.operation_id,
      occurredAt: new Date(row.occurred_at).toISOString(),
      startedAt: new Date(row.started_at).toISOString(),
      actor: row.actor,
      source: row.source,
      action: row.action,
      actionLabel: auditActionLabel(row.action),
      result: row.result,
      resourceType: row.resource_type ?? row.metadata?.resourceType ?? null,
      resourceId: row.resource_id ?? row.metadata?.resourceId ?? null,
      resourceLabel:
        row.metadata?.resourceLabel ??
        row.resource_label ??
        row.resource_id ??
        row.metadata?.resourceId ??
        null,
      territories: row.territories ?? row.metadata?.territories ?? [],
      simulation: row.metadata?.simulation === true,
      hasChanges: row.has_changes === true,
    };
  }

  async list(
    query: Record<string, unknown> = {},
  ): Promise<{ items: any[]; nextCursor: string | null }> {
    const now = new Date();
    const from = dateFilter(
      query.from,
      'from',
      new Date(now.getTime() - 30 * 86400000),
    );
    // PostgreSQL timestamps retain microseconds. A JavaScript "now" cutoff can
    // hide a committed event from the current millisecond before pagination.
    const to =
      query.to === undefined || query.to === ''
        ? null
        : dateFilter(query.to, 'to', now);
    if (to && from > to)
      throw new BadRequestException(
        'La date de début doit précéder la date de fin',
      );
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestException(
        'La limite doit être comprise entre 1 et 100',
      );
    const args: unknown[] = [from, to];
    const conditions = [
      'o.occurred_at >= $1::timestamptz',
      'o.occurred_at <= coalesce($2::timestamptz, statement_timestamp())',
    ];
    const add = (value: unknown, sql: (placeholder: string) => string) => {
      args.push(value);
      conditions.push(sql(`$${args.length}`));
    };
    const actor = bounded(query.actor, 'actor');
    if (actor)
      add(
        actor.toLowerCase(),
        (p) =>
          `position(${p} in lower(coalesce(o.actor->>'email','') || ' ' || coalesce(o.actor->>'firstName','') || ' ' || coalesce(o.actor->>'lastName',''))) > 0`,
      );
    const action = bounded(query.action, 'action', 160);
    if (action)
      add(action, (p) =>
        action.endsWith('.') ? `starts_with(o.action, ${p})` : `o.action=${p}`,
      );
    const result = bounded(query.result, 'result', 30);
    if (result) {
      if (
        ![
          'started',
          'accepted',
          'succeeded',
          'failed',
          'denied',
          'partial',
          'unknown',
        ].includes(result)
      )
        throw new BadRequestException('Résultat invalide');
      add(result, (p) => `o.result=${p}`);
    }
    const resourceType = bounded(query.resourceType, 'resourceType', 100);
    const resourceId = bounded(query.resourceId, 'resourceId', 200);
    if (resourceType)
      add(
        resourceType,
        (p) =>
          `(o.metadata->>'resourceType'=${p} OR EXISTS (SELECT 1 FROM audit_resource ar JOIN audit_event ae ON ae.id=ar.event_id WHERE ae.operation_id=o.operation_id AND ar.resource_type=${p}))`,
      );
    if (resourceId)
      add(
        resourceId,
        (p) =>
          `(o.metadata->>'resourceId'=${p} OR EXISTS (SELECT 1 FROM audit_resource ar JOIN audit_event ae ON ae.id=ar.event_id WHERE ae.operation_id=o.operation_id AND ar.resource_id=${p}))`,
      );
    const departement = bounded(query.departement, 'departement', 10);
    if (departement) {
      if (!/^[a-zA-Z0-9-]+$/.test(departement))
        throw new BadRequestException('Département invalide');
      add(
        departement,
        (p) =>
          `(coalesce(o.metadata->'territories','[]'::jsonb) ? ${p} OR EXISTS (SELECT 1 FROM audit_resource ar JOIN audit_event ae ON ae.id=ar.event_id WHERE ae.operation_id=o.operation_id AND ${p}=ANY(ar.territories)))`,
      );
    }
    const cursor = bounded(query.cursor, 'cursor', 300);
    if (cursor) {
      try {
        const parsed = JSON.parse(
          Buffer.from(cursor, 'base64url').toString('utf8'),
        );
        if (
          !UUID.test(parsed.id) ||
          !Number.isFinite(new Date(parsed.at).getTime())
        )
          throw new Error();
        args.push(parsed.at, parsed.id);
        conditions.push(
          `(o.occurred_at,o.operation_id) < ($${args.length - 1}::timestamptz,$${args.length}::uuid)`,
        );
      } catch {
        throw new BadRequestException('Curseur invalide');
      }
    }
    args.push(limit + 1);
    const rows = await runWithoutAuditContext(() =>
      this.dataSource.query(
        `
      WITH operations AS (${operationSql('WHERE operation_id IN (SELECT operation_id FROM audit_event WHERE occurred_at >= $1::timestamptz AND occurred_at <= coalesce($2::timestamptz, statement_timestamp()))')})
      SELECT o.*, to_char(o.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
        r.resource_type, r.resource_id, r.resource_label, r.territories
      FROM operations o
      LEFT JOIN LATERAL (
        SELECT ar.resource_type, ar.resource_id, ar.territories,
          coalesce(ar.after->>'numero', ar.before->>'numero', ar.after->>'nom', ar.before->>'nom', ar.after->>'email', ar.before->>'email') AS resource_label
        FROM audit_resource ar JOIN audit_event ae ON ae.id=ar.event_id
        WHERE ae.operation_id=o.operation_id ORDER BY ar.id LIMIT 1
      ) r ON true
      WHERE ${conditions.join(' AND ')}
      ORDER BY o.occurred_at DESC,o.operation_id DESC LIMIT $${args.length}`,
        args,
      ),
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => this.present(row)),
      nextCursor: hasMore
        ? Buffer.from(
            JSON.stringify({ at: last.cursor_at, id: last.operation_id }),
          ).toString('base64url')
        : null,
    };
  }

  async detail(operationId: string, resourceCursor?: string): Promise<any> {
    if (!UUID.test(operationId))
      throw new BadRequestException('Identifiant invalide');
    if (resourceCursor !== undefined && !/^\d{1,20}$/.test(resourceCursor))
      throw new BadRequestException('Curseur de changements invalide');
    return runWithoutAuditContext(async () => {
      const [operation] = await this.dataSource.query(
        operationSql('WHERE operation_id=$1'),
        [operationId],
      );
      if (!operation) throw new NotFoundException('Action introuvable');
      const [events, resources, causality, counts, related] = await Promise.all(
        [
          this.dataSource.query(
            'SELECT id,occurred_at,phase,action,source,actor,metadata,request_id,method,route FROM audit_event WHERE operation_id=$1 ORDER BY occurred_at,id LIMIT 101',
            [operationId],
          ),
          this.dataSource.query(
            'SELECT ar.* FROM audit_resource ar JOIN audit_event ae ON ae.id=ar.event_id WHERE ae.operation_id=$1 AND ar.id>$2::bigint ORDER BY ar.id LIMIT 101',
            [operationId, resourceCursor ?? '0'],
          ),
          this.dataSource.query(
            'SELECT ac.kind,ac.reference FROM audit_causality ac JOIN audit_event ae ON ae.id=ac.event_id WHERE ae.operation_id=$1 GROUP BY ac.kind,ac.reference ORDER BY ac.kind,ac.reference LIMIT 501',
            [operationId],
          ),
          this.dataSource.query(
            'SELECT count(*)::int AS count FROM audit_resource ar JOIN audit_event ae ON ae.id=ar.event_id WHERE ae.operation_id=$1',
            [operationId],
          ),
          this.dataSource.query(
            `SELECT * FROM (${operationSql(`WHERE operation_id IN (
          SELECT DISTINCT other_event.operation_id FROM audit_causality origin
          JOIN audit_event origin_event ON origin_event.id=origin.event_id
          JOIN audit_causality other ON other.kind=origin.kind AND other.reference=origin.reference
          JOIN audit_event other_event ON other_event.id=other.event_id
          WHERE origin_event.operation_id=$1 AND other_event.operation_id<>$1
        )`)}) related ORDER BY occurred_at DESC,operation_id DESC LIMIT 101`,
            [operationId],
          ),
        ],
      );
      const page = resources.slice(0, 100);
      return {
        ...this.present(operation),
        events: events.slice(0, 100).map((e: any) => ({
          id: e.id,
          occurredAt: e.occurred_at,
          phase: e.phase,
          action: e.action,
          actor: e.actor,
          source: e.source,
          metadata: e.metadata,
          requestId: e.request_id,
          method: e.method,
          route: e.route,
        })),
        eventsTruncated: events.length > 100,
        resources: page.map((r: any) => ({
          id: r.id,
          eventId: r.event_id,
          resourceType: r.resource_type,
          resourceId: r.resource_id,
          operation: r.operation,
          before: r.before,
          after: r.after,
          changedFields: r.changed_fields,
          territories: r.territories,
        })),
        resourceCount: counts[0]?.count ?? 0,
        nextResourceCursor:
          resources.length > 100 ? String(page[page.length - 1].id) : null,
        causality: causality.slice(0, 500),
        causalityTruncated: causality.length > 500,
        relatedOperations: related
          .slice(0, 100)
          .map((row: any) => this.present(row)),
        relatedOperationsTruncated: related.length > 100,
      };
    });
  }

  async health(): Promise<any> {
    if (!isAuditEnabled()) return { status: 'disabled' };
    const [state] = await runWithoutAuditContext(() =>
      this.dataSource.query(`SELECT
      max(occurred_at) AS last_event_at,
      (SELECT max(p.occurred_at) FROM audit_event p WHERE p.action='audit.purge' AND p.phase='succeeded') AS last_purge_at,
      count(*) FILTER (WHERE phase='started' AND occurred_at < now()-interval '15 minutes'
        AND NOT EXISTS (SELECT 1 FROM audit_event done WHERE done.operation_id=audit_event.operation_id AND done.phase IN ('succeeded','failed','denied','accepted')))::int AS unconfirmed
      FROM audit_event WHERE occurred_at > now()-interval '24 hours'`),
    );
    return {
      status:
        this.lastFailureAt &&
        Date.now() - new Date(this.lastFailureAt).getTime() < 15 * 60000
          ? 'degraded'
          : 'ready',
      failures: this.failures,
      lastFailureAt: this.lastFailureAt,
      lastPurgeAt: state.last_purge_at ?? this.lastPurgeAt,
      lastEventAt: state.last_event_at,
      unconfirmedOperations: state.unconfirmed,
    };
  }

  @BusinessCron('0 15 3 * * *', { timeZone: 'Europe/Paris' })
  async purge(): Promise<void> {
    if (!isAuditEnabled()) return;
    try {
      let total = 0;
      // Bound one clock execution; remaining expired rows are picked up next day.
      for (let batch = 0; batch < 20; batch++) {
        const [result] = await runWithoutAuditContext(() =>
          this.dataSource.query(
            'SELECT purge_user_activity_audit(5000) AS count',
          ),
        );
        total += Number(result.count);
        if (Number(result.count) < 5000) break;
      }
      this.lastPurgeAt = new Date().toISOString();
      await this.recordEvent(
        'succeeded',
        { purgedOperations: total },
        systemAuditContext('audit.purge'),
      );
    } catch {
      this.reportFailure();
    }
  }
}
