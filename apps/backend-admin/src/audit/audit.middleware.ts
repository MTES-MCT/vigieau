import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AuditService } from './audit.service';
import {
  AuditContext,
  auditActor,
  isAuditEnabled,
  runWithoutAuditContext,
  withAuditContext,
} from './audit-context';
import {
  AUDIT_DRY_RUN_BY_DEFAULT,
  auditRequestMetadata,
  matchAuditRoute,
} from './audit-catalog';
import type { AuditEventPhase } from './audit-db.contract';

@Injectable()
export class AuditMiddleware implements NestMiddleware {
  constructor(
    private readonly audit: AuditService,
    private readonly dataSource: DataSource,
  ) {}

  async use(req: any, res: any, next: () => void): Promise<void> {
    if (!isAuditEnabled()) {
      next();
      return;
    }
    const match = matchAuditRoute(req.method, req.path ?? req.url ?? '');
    if (!match || match.route.exempt) {
      next();
      return;
    }
    const { route, params } = match;
    const context: AuditContext = {
      operationId: randomUUID(),
      requestId: randomUUID(),
      action: route.action,
      actor: auditActor(req.session?.user),
      source: 'http',
      method: req.method,
      route: `/api${route.path}`,
      metadata: {
        ...auditRequestMetadata(req.query, req.body),
        ...(AUDIT_DRY_RUN_BY_DEFAULT.has(route.action)
          ? { simulation: req.body?.apply !== true }
          : {}),
        resourceType: route.resourceType,
        resourceId:
          params.id ??
          params.email ??
          params.runId ??
          params.depCode ??
          params.departementCode,
        networkAddress: req.socket?.remoteAddress ?? null,
        networkSource: 'api_socket_peer',
        userAgent: req.headers?.['user-agent'],
        territories: [
          params.depCode ?? params.departementCode ?? req.query?.depCode,
        ]
          .filter(
            (code) => typeof code === 'string' && /^[0-9ABab]{2,3}$/.test(code),
          )
          .map((code: string) => code.toUpperCase()),
      },
      mutation: route.mutation,
      startedAt: Date.now(),
      resourceType: route.resourceType,
      resourceId:
        params.id ??
        params.email ??
        params.runId ??
        params.depCode ??
        params.departementCode,
    };
    try {
      if (req.session?.user?.email) {
        let lookupTimer: ReturnType<typeof setTimeout>;
        let users: any[];
        try {
          users = await Promise.race([
            runWithoutAuditContext(() =>
              this.dataSource.query(
                'SELECT audit_id,email,first_name,last_name,role,role_departement,role_departements,role_communes FROM "user" WHERE email=$1',
                [req.session.user.email],
              ),
            ),
            new Promise<never>((_, reject) => {
              lookupTimer = setTimeout(
                () => reject(new Error('Audit actor lookup deadline')),
                2000,
              );
            }),
          ]);
        } finally {
          clearTimeout(lookupTimer);
        }
        const user = users[0];
        if (user) {
          context.actor = auditActor(user);
          // Apply revocations immediately while retaining the token used only by logout.
          req.session.user = { ...req.session.user, ...user };
        } else {
          req.session.user = null;
          context.actor.role = null;
          context.actor.departements = [];
          context.actor.communes = [];
        }
      }
    } catch {
      // Unavailable authorization is never treated as a journal-only failure.
      // In particular, do not serve personal data using a stale MTE session.
      await this.audit.recordBestEffort(
        'failed',
        { errorCode: 'AUTHORIZATION_UNAVAILABLE' },
        context,
      );
      res.status(503).json({
        statusCode: 503,
        code: 'AUTHORIZATION_UNAVAILABLE',
        message:
          'Vos droits ne peuvent pas être vérifiés. Réessayez dans quelques instants.',
      });
      return;
    }
    if (route.mutation) {
      try {
        await this.audit.recordEvent('started', {}, context);
      } catch {
        this.audit.reportFailure(context.operationId);
        res.status(503).json({
          statusCode: 503,
          code: 'AUDIT_UNAVAILABLE',
          message:
            'La modification ne peut pas être tracée. Réessayez dans quelques instants.',
        });
        return;
      }
    }

    let finalized = false;
    const originalEnd = res.end;
    const originalJson = res.json;
    let returnedCount: number | undefined;
    if (typeof originalJson === 'function')
      res.json = function (body: any) {
        if (Array.isArray(body)) returnedCount = body.length;
        else if (Array.isArray(body?.data)) returnedCount = body.data.length;
        else if (Array.isArray(body?.items)) returnedCount = body.items.length;
        if (body && !Array.isArray(body) && res.statusCode < 400) {
          const label = body.numero ?? body.nom;
          if (typeof label === 'string')
            context.metadata.resourceLabel = label.slice(0, 200);
          const code = body.departement?.code;
          if (typeof code === 'string' && /^[0-9ABab]{2,3}$/.test(code))
            context.metadata.territories = [code.toUpperCase()];
        }
        return originalJson.call(this, body);
      };
    const finish = async (closed = false) => {
      if (finalized) return;
      finalized = true;
      let phase: AuditEventPhase = closed
        ? 'unknown'
        : res.statusCode === 401 || res.statusCode === 403
          ? 'denied'
          : res.statusCode >= 400
            ? 'failed'
            : res.statusCode === 202
              ? 'accepted'
              : route.mutation
                ? 'succeeded'
                : 'read';
      // A callback redirect without an authenticated identity is not a successful login.
      if (
        route.action === 'auth.login' &&
        !context.actor?.email &&
        phase === 'succeeded'
      )
        phase = 'denied';
      await this.audit.recordBestEffort(
        phase,
        {
          httpStatus: res.statusCode,
          durationMs: Date.now() - context.startedAt,
          returnedCount,
          responseClosed: closed,
        },
        context,
      );
    };
    res.end = function (...args: any[]) {
      void finish().finally(() => originalEnd.apply(this, args));
      return this;
    };
    res.once('close', () => {
      if (!res.writableEnded) void finish(true);
    });
    withAuditContext(context, next);
  }
}
