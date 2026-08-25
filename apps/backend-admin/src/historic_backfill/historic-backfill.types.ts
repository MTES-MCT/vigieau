export type HistoricBackfillRunStatus =
  | 'preparing'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed';

export type HistoricBackfillTaskStatus =
  | 'pending'
  | 'leased'
  | 'completed'
  | 'failed';

export interface PrepareHistoricBackfillInput {
  mapDateFrom: string;
  statisticDateFrom: string;
  dateThrough: string;
}

export interface HistoricBackfillRun {
  id: string;
  status: HistoricBackfillRunStatus;
  mapDateFrom: string;
  statisticDateFrom: string;
  dateThrough: string;
  sourceRevision: string;
  historicComputeEpoch: string;
  historicBackfillGlobalEpoch: string;
  baseStatisticRevision: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  pausedAt: Date | null;
  completedAt: Date | null;
  lastError: string | null;
}

export interface HistoricBackfillTaskSummary {
  total: number;
  pending: number;
  leased: number;
  completed: number;
  failed: number;
  expiredLeases: number;
  staleGenerations: number;
  processedSegments: number;
  processedCommunes: number;
  earliestProgressDate: string | null;
  latestProgressDate: string | null;
  latestHeartbeatAt: Date | null;
  nextAttemptAt: Date | null;
}

export interface HistoricBackfillArtifactTaskSummary {
  total: number;
  pending: number;
  leased: number;
  completed: number;
  failed: number;
  expiredLeases: number;
  staleContext: number;
  coverageFrom: string | null;
  coverageThrough: string | null;
  latestHeartbeatAt: Date | null;
  nextAttemptAt: Date | null;
}

export interface HistoricBackfillStatus {
  run: HistoricBackfillRun;
  tasks: HistoricBackfillTaskSummary;
  artifacts: HistoricBackfillArtifactTaskSummary;
  historicComputeEpochCurrent: boolean;
  historicBackfillGlobalEpochCurrent: boolean;
  readyToFinalize: boolean;
  readyToFinalizeMaps: boolean;
}

export interface HistoricBackfillLeaseIdentity {
  runId: string;
  departementId: number;
  workerId: string;
  leaseToken: string;
}

export interface HistoricBackfillTaskClaim extends HistoricBackfillLeaseIdentity {
  duringCurrentConcurrency: number;
  departementCode: string;
  departmentGeneration: string;
  departmentLastPublicRevision: string;
  attemptCount: number;
  leaseExpiresAt: Date;
  progressDate: string | null;
  segmentCount: number;
  communeCount: number;
  artifactPrefix: string | null;
  mapDateFrom: string;
  statisticDateFrom: string;
  dateThrough: string;
  sourceRevision: string;
  historicComputeEpoch: string;
  baseStatisticRevision: string;
}

export interface HistoricBackfillTaskProgress {
  progressDate?: string;
  segmentCount?: number;
  communeCount?: number;
  artifactPrefix?: string | null;
}

export interface HistoricBackfillTaskOutput {
  progressDate: string;
  segmentCount: number;
  communeCount: number;
  outputSignature: string;
  artifactPrefix?: string | null;
}

export type HistoricBackfillFailureDisposition = 'retry' | 'terminal';

export type HistoricBackfillTaskInterruptionReason =
  | 'aborted'
  | 'current-priority'
  | 'generation-changed';

export class HistoricBackfillTaskInterruptedError extends Error {
  constructor(
    readonly reason: HistoricBackfillTaskInterruptionReason,
    message = `Historic backfill task interrupted: ${reason}`,
  ) {
    super(message);
    this.name = 'HistoricBackfillTaskInterruptedError';
  }
}

export interface HistoricBackfillTaskContext {
  signal: AbortSignal;
  heartbeat: (progress?: HistoricBackfillTaskProgress) => Promise<boolean>;
}

export type HistoricBackfillTaskHandler = (
  claim: HistoricBackfillTaskClaim,
  context: HistoricBackfillTaskContext,
) => Promise<HistoricBackfillTaskOutput>;
