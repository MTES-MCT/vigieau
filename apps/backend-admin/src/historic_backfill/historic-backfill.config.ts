import { parseDatabasePoolMax } from '../core/database-pool';
import { isHistoricMutableGeometryReplayEnabled } from '../core/historic-geometry-replay';

export const HISTORIC_BACKFILL_ENABLED_ENV = 'HISTORIC_BACKFILL_ENABLED';
export const HISTORIC_BACKFILL_ARTIFACT_ACL_ENV =
  'HISTORIC_BACKFILL_ARTIFACT_ACL';
export const HISTORIC_BACKFILL_DURING_CURRENT_CONCURRENCY_ENV =
  'HISTORIC_BACKFILL_DURING_CURRENT_CONCURRENCY';
export const HISTORIC_BACKFILL_DURING_CURRENT_CONCURRENCY_MAX = 32;
export type HistoricBackfillArtifactAcl = 'private' | 'public-read';

export interface HistoricBackfillWorkerConfig {
  enabled: boolean;
  concurrency: number;
  duringCurrentConcurrency: number;
  leaseSeconds: number;
  heartbeatMilliseconds: number;
  pollMilliseconds: number;
  errorPollMilliseconds: number;
  maxAttempts: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  yieldDelaySeconds: number;
}

const DEFAULT_CONFIG: HistoricBackfillWorkerConfig = {
  enabled: false,
  concurrency: 1,
  duringCurrentConcurrency: 0,
  // Spatial computation can block the Node.js heartbeat timer for several minutes.
  leaseSeconds: 1_800,
  heartbeatMilliseconds: 30_000,
  pollMilliseconds: 2_000,
  errorPollMilliseconds: 10_000,
  maxAttempts: 5,
  retryBaseSeconds: 30,
  retryMaxSeconds: 1_800,
  yieldDelaySeconds: 15,
};

function readInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

export function isHistoricBackfillEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const value =
    environment[HISTORIC_BACKFILL_ENABLED_ENV]?.trim().toLowerCase() ?? 'false';
  if (value !== 'true' && value !== 'false') {
    throw new Error(
      `${HISTORIC_BACKFILL_ENABLED_ENV} must be either true or false`,
    );
  }
  return value === 'true';
}

export function readHistoricBackfillArtifactAcl(
  environment: NodeJS.ProcessEnv = process.env,
): HistoricBackfillArtifactAcl {
  const value = environment[HISTORIC_BACKFILL_ARTIFACT_ACL_ENV]?.trim();
  if (!value) {
    return 'public-read';
  }
  if (value !== 'private' && value !== 'public-read') {
    throw new Error(
      `${HISTORIC_BACKFILL_ARTIFACT_ACL_ENV} must be either private or public-read`,
    );
  }
  return value;
}

export function readHistoricBackfillWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): HistoricBackfillWorkerConfig {
  const config: HistoricBackfillWorkerConfig = {
    enabled:
      isHistoricBackfillEnabled(environment) &&
      isHistoricMutableGeometryReplayEnabled(environment),
    concurrency: readInteger(
      environment,
      'HISTORIC_BACKFILL_WORKER_CONCURRENCY',
      DEFAULT_CONFIG.concurrency,
      1,
      32,
    ),
    duringCurrentConcurrency: readInteger(
      environment,
      HISTORIC_BACKFILL_DURING_CURRENT_CONCURRENCY_ENV,
      DEFAULT_CONFIG.duringCurrentConcurrency,
      0,
      HISTORIC_BACKFILL_DURING_CURRENT_CONCURRENCY_MAX,
    ),
    leaseSeconds: readInteger(
      environment,
      'HISTORIC_BACKFILL_LEASE_SECONDS',
      DEFAULT_CONFIG.leaseSeconds,
      10,
      3_600,
    ),
    heartbeatMilliseconds: readInteger(
      environment,
      'HISTORIC_BACKFILL_HEARTBEAT_MILLISECONDS',
      DEFAULT_CONFIG.heartbeatMilliseconds,
      1_000,
      600_000,
    ),
    pollMilliseconds: readInteger(
      environment,
      'HISTORIC_BACKFILL_POLL_MILLISECONDS',
      DEFAULT_CONFIG.pollMilliseconds,
      100,
      60_000,
    ),
    errorPollMilliseconds: readInteger(
      environment,
      'HISTORIC_BACKFILL_ERROR_POLL_MILLISECONDS',
      DEFAULT_CONFIG.errorPollMilliseconds,
      100,
      300_000,
    ),
    maxAttempts: readInteger(
      environment,
      'HISTORIC_BACKFILL_MAX_ATTEMPTS',
      DEFAULT_CONFIG.maxAttempts,
      1,
      100,
    ),
    retryBaseSeconds: readInteger(
      environment,
      'HISTORIC_BACKFILL_RETRY_BASE_SECONDS',
      DEFAULT_CONFIG.retryBaseSeconds,
      1,
      86_400,
    ),
    retryMaxSeconds: readInteger(
      environment,
      'HISTORIC_BACKFILL_RETRY_MAX_SECONDS',
      DEFAULT_CONFIG.retryMaxSeconds,
      1,
      604_800,
    ),
    yieldDelaySeconds: readInteger(
      environment,
      'HISTORIC_BACKFILL_YIELD_DELAY_SECONDS',
      DEFAULT_CONFIG.yieldDelaySeconds,
      0,
      3_600,
    ),
  };
  if (config.heartbeatMilliseconds >= config.leaseSeconds * 1_000) {
    throw new Error(
      'HISTORIC_BACKFILL_HEARTBEAT_MILLISECONDS must be shorter than the lease',
    );
  }
  if (config.retryBaseSeconds > config.retryMaxSeconds) {
    throw new Error(
      'HISTORIC_BACKFILL_RETRY_BASE_SECONDS must not exceed HISTORIC_BACKFILL_RETRY_MAX_SECONDS',
    );
  }
  const databasePoolMax = parseDatabasePoolMax(environment.DATABASE_POOL_MAX);
  const requiredPoolSize = config.concurrency * 2 + 1;
  if (databasePoolMax < requiredPoolSize) {
    throw new Error(
      `DATABASE_POOL_MAX must be at least ${requiredPoolSize} for ` +
        `HISTORIC_BACKFILL_WORKER_CONCURRENCY=${config.concurrency}`,
    );
  }
  return config;
}
