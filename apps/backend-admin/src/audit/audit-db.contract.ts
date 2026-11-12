/** Values supplied by the server, never by a request body or forwarding header. */
export interface AuditDatabaseActor {
  id?: string | null;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  role?: string | null;
  departements?: string[];
  communes?: string[];
}

/** Must be set with set_config(..., true) on the same transaction as the DML. */
export interface AuditDatabaseContext {
  operationId: string;
  requestId?: string | null;
  action: string;
  actor: AuditDatabaseActor;
  source: string;
  metadata?: Record<string, unknown>;
  route?: string | null;
  method?: string | null;
}

export const AUDIT_CONTEXT_SETTING = 'vigieau.audit_context';
export const AUDIT_EVENT_PHASES = [
  'started',
  'applied',
  'succeeded',
  'failed',
  'denied',
  'accepted',
  'read',
  'unknown',
] as const;
export type AuditEventPhase = (typeof AUDIT_EVENT_PHASES)[number];
