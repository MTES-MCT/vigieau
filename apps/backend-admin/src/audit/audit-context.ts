import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type {
  AuditDatabaseActor,
  AuditDatabaseContext,
} from './audit-db.contract';

export interface AuditContext extends AuditDatabaseContext {
  mutation?: boolean;
  startedAt?: number;
  resourceType?: string;
  resourceId?: string;
}

const storage = new AsyncLocalStorage<AuditContext | null>();

export const isAuditEnabled = () =>
  process.env.AUDIT_ENABLED?.trim() === 'true';
export const getAuditContext = (): AuditContext | undefined =>
  storage.getStore() || undefined;
export const withAuditContext = <T>(
  context: AuditContext,
  callback: () => T,
): T => storage.run(context, callback);
export const runWithoutAuditContext = <T>(callback: () => T): T =>
  storage.run(null, callback);

const short = (value: unknown, max: number): string | null =>
  typeof value === 'string' ? value.slice(0, max) : null;
const codes = (value: unknown): string[] =>
  Array.isArray(value)
    ? [
        ...new Set(
          value.filter(
            (v) => typeof v === 'string' && /^[a-zA-Z0-9-]{1,12}$/.test(v),
          ),
        ),
      ]
        .sort()
        .slice(0, 1000)
    : [];

/** Never spread a session or an OIDC payload: both may contain credentials. */
export function auditActor(user: any): AuditDatabaseActor {
  return {
    id: short(user?.audit_id ?? user?.auditId, 36),
    email: short(user?.email, 200),
    firstName: short(user?.first_name ?? user?.firstName, 100),
    lastName: short(user?.last_name ?? user?.lastName, 100),
    role: short(user?.role, 30),
    departements: codes(user?.role_departements ?? user?.roleDepartements),
    communes: codes(user?.role_communes ?? user?.roleCommunes),
  } as AuditDatabaseActor;
}

export function setAuditActor(user: any): void {
  const context = getAuditContext();
  if (context) context.actor = auditActor(user);
}

export function systemAuditContext(
  action: string,
  metadata: Record<string, unknown> = {},
): AuditContext {
  return {
    operationId: randomUUID(),
    requestId: randomUUID(),
    action,
    actor: auditActor(null),
    source: 'system',
    metadata,
    method: null,
    route: null,
  } as AuditContext;
}
