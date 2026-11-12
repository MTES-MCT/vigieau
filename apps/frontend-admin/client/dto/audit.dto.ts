export interface AuditActor {
  id?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  role?: string;
  departements?: string[];
  communes?: string[];
}

export interface AuditRow {
  id: string;
  occurredAt: string;
  actor: AuditActor;
  action: string;
  actionLabel: string;
  result: string;
  simulation?: boolean;
  hasChanges?: boolean;
  source?: string;
  resourceType?: string;
  resourceId?: string;
  resourceLabel?: string;
  territories: string[];
}

export interface AuditResource {
  id?: string;
  resourceType: string;
  resourceId: string;
  operation: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  changedFields: string[];
  territories?: string[];
}

export interface AuditDetail extends AuditRow {
  events: {
    id: string;
    occurredAt: string;
    phase: string;
    action: string;
    metadata?: Record<string, unknown>;
    source?: string;
    requestId?: string;
    route?: string;
    method?: string;
  }[];
  resources: AuditResource[];
  resourceCount?: number;
  nextResourceCursor?: string | null;
  eventCount?: number;
  eventsTruncated?: boolean;
  causalityTruncated?: boolean;
  relatedOperations?: AuditRow[];
  relatedOperationsTruncated?: boolean;
  causality: { kind: string; reference: string }[];
}

export interface AuditPage {
  items: AuditRow[];
  nextCursor: string | null;
}
