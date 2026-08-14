export type SandreZoneSyncMode = 'paused' | 'audit' | 'safe';

export interface SandreSyncDecisionDraft {
  decisionKey: string;
  zoneType: 'SOU' | 'SUP';
  sourceCode: string | null;
  targetCode?: string | null;
  zoneAlerteId?: number | null;
  candidateZoneAlerteId?: number | null;
  action: string;
  outcome: 'observed' | 'applied' | 'blocked' | 'deferred';
  reason: string;
  evidence?: Record<string, unknown> | null;
}

export interface SandreOperatorDepartmentStatus {
  departmentCode: string;
  observedSourceUpdatedAt: string | null;
  appliedSourceUpdatedAt: string | null;
  lastObservedAt: string | null;
  lastAppliedAt: string | null;
  observedAgeSeconds: number | null;
  appliedAgeSeconds: number | null;
  blocked: boolean;
  blockedAt: string | null;
  blockCode:
    | 'NON_ABROGATED_AC_REFERENCE'
    | 'OPERATIONAL_ZONE_REFERENCE'
    | 'DEPARTMENT_VALIDATION_FAILED'
    | null;
}

export interface SandreOperatorStatus {
  mode: SandreZoneSyncMode | 'invalid';
  generatedAt: string;
  latestBatch: {
    id: string;
    mode: 'audit' | 'safe';
    status: 'started' | 'observed' | 'applied' | 'blocked' | 'failed';
    startedAt: string;
    finishedAt: string | null;
    ageSeconds: number;
    durationSeconds: number | null;
  } | null;
  summary: {
    trackedDepartments: number;
    blockedDepartments: number;
  };
  departments: SandreOperatorDepartmentStatus[];
}

export const STRICT_GEOMETRY_THRESHOLDS = Object.freeze({
  sourceCoverage: 0.95,
  targetCoverage: 0.95,
  iou: 0.9,
  iouGap: 0.25,
  secondSourceCoverage: 0.2,
});

export const SANDRE_BLOCKED_RETRY_INTERVAL_MS = 5 * 60 * 1000;
const SANDRE_FORCE_FULL_AUDIT_AFTER_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function parseSandreZoneSyncMode(
  value: string | null | undefined,
): SandreZoneSyncMode | null {
  const normalized = value?.trim().toLowerCase() || 'paused';
  return ['paused', 'audit', 'safe'].includes(normalized)
    ? (normalized as SandreZoneSyncMode)
    : null;
}

export function parseSandreForceFullAuditAfter(
  value: string | null | undefined,
  now = new Date(),
): Date | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  if (!SANDRE_FORCE_FULL_AUDIT_AFTER_PATTERN.test(normalized)) {
    throw new Error(
      'SANDRE_FORCE_FULL_AUDIT_AFTER must be an ISO 8601 UTC timestamp such as 2026-08-02T12:00:00Z',
    );
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      'SANDRE_FORCE_FULL_AUDIT_AFTER must be an ISO 8601 UTC timestamp such as 2026-08-02T12:00:00Z',
    );
  }
  const canonical = normalized.includes('.')
    ? parsed.toISOString()
    : parsed.toISOString().replace('.000Z', 'Z');
  if (canonical !== normalized) {
    throw new Error(
      'SANDRE_FORCE_FULL_AUDIT_AFTER must be an ISO 8601 UTC timestamp such as 2026-08-02T12:00:00Z',
    );
  }
  if (parsed.getTime() > now.getTime()) {
    throw new Error('SANDRE_FORCE_FULL_AUDIT_AFTER must not be in the future');
  }
  return parsed;
}

export function isSandreBlockedRetryDue(
  blockedAt: Date | string | null | undefined,
  now: number = Date.now(),
  retryIntervalMs: number = SANDRE_BLOCKED_RETRY_INTERVAL_MS,
): boolean {
  if (!blockedAt) {
    return false;
  }
  const blockedAtMs = new Date(blockedAt).getTime();
  return (
    Number.isFinite(blockedAtMs) &&
    now - blockedAtMs >= Math.max(0, retryIntervalMs)
  );
}

export class SandreDepartmentBlockedError extends Error {
  constructor(
    public readonly reason: string,
    public readonly decisions: SandreSyncDecisionDraft[] = [],
  ) {
    super(reason);
    this.name = 'SandreDepartmentBlockedError';
  }
}

export interface StrictGeometryEvidence {
  sourceCoverage: number;
  targetCoverage: number;
  iou: number;
  secondIou: number;
  secondSourceCoverage: number;
}

export function isStrictOneToOneGeometry(
  evidence: StrictGeometryEvidence,
): boolean {
  return (
    evidence.sourceCoverage >= STRICT_GEOMETRY_THRESHOLDS.sourceCoverage &&
    evidence.targetCoverage >= STRICT_GEOMETRY_THRESHOLDS.targetCoverage &&
    evidence.iou >= STRICT_GEOMETRY_THRESHOLDS.iou &&
    evidence.iou - evidence.secondIou >= STRICT_GEOMETRY_THRESHOLDS.iouGap &&
    evidence.secondSourceCoverage <=
      STRICT_GEOMETRY_THRESHOLDS.secondSourceCoverage
  );
}
