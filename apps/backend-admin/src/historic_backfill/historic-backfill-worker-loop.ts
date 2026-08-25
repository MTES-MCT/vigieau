import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  HistoricBackfillWorkerConfig,
  readHistoricBackfillWorkerConfig,
} from './historic-backfill.config';
import { HistoricBackfillQueueService } from './historic-backfill-queue.service';
import {
  HistoricBackfillLeaseIdentity,
  HistoricBackfillTaskClaim,
  HistoricBackfillTaskHandler,
  HistoricBackfillTaskInterruptedError,
} from './historic-backfill.types';

export type HistoricBackfillTaskExecutionResult =
  | 'completed'
  | 'retry'
  | 'terminal'
  | 'yielded'
  | 'lease-lost'
  | 'stopped';

export interface HistoricBackfillWorkerRunSummary {
  enabled: boolean;
  claimed: number;
  completed: number;
  retries: number;
  terminalFailures: number;
  yielded: number;
  lostLeases: number;
  claimErrors: number;
}

export type HistoricBackfillSleep = (
  milliseconds: number,
  signal?: AbortSignal,
) => Promise<boolean>;

export interface HistoricBackfillWorkerRunOptions {
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  workerId?: string;
  maxIdlePolls?: number;
  sleep?: HistoricBackfillSleep;
}

function createWorkerId(): string {
  return `${hostname()}:${process.pid}:${randomUUID()}`.slice(0, 190);
}

export const historicBackfillSleep: HistoricBackfillSleep = (
  milliseconds,
  signal,
) => {
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (slept: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      resolve(slept);
    };
    const timeout = setTimeout(() => finish(true), milliseconds);
    const onAbort = () => finish(false);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
  });
};

function leaseIdentity(
  claim: HistoricBackfillTaskClaim,
): HistoricBackfillLeaseIdentity {
  return {
    runId: claim.runId,
    departementId: claim.departementId,
    workerId: claim.workerId,
    leaseToken: claim.leaseToken,
  };
}

@Injectable()
export class HistoricBackfillWorkerLoop {
  private readonly logger = new Logger(HistoricBackfillWorkerLoop.name);

  constructor(private readonly queue: HistoricBackfillQueueService) {}

  async run(
    handler: HistoricBackfillTaskHandler,
    options: HistoricBackfillWorkerRunOptions = {},
  ): Promise<HistoricBackfillWorkerRunSummary> {
    const config = readHistoricBackfillWorkerConfig(options.environment);
    const summary: HistoricBackfillWorkerRunSummary = {
      enabled: config.enabled,
      claimed: 0,
      completed: 0,
      retries: 0,
      terminalFailures: 0,
      yielded: 0,
      lostLeases: 0,
      claimErrors: 0,
    };
    if (!config.enabled) {
      return summary;
    }
    if (options.maxIdlePolls !== undefined) {
      if (
        !Number.isSafeInteger(options.maxIdlePolls) ||
        options.maxIdlePolls <= 0
      ) {
        throw new Error('maxIdlePolls must be a positive integer');
      }
    }

    const baseWorkerId = (options.workerId ?? createWorkerId()).trim();
    if (!baseWorkerId || baseWorkerId.length > 190) {
      throw new Error('workerId must contain between 1 and 190 characters');
    }
    const sleep = options.sleep ?? historicBackfillSleep;
    await Promise.all(
      Array.from({ length: config.concurrency }, (_, slot) =>
        this.runSlot(
          handler,
          `${baseWorkerId}:${slot + 1}`,
          config,
          summary,
          options.signal,
          options.maxIdlePolls,
          sleep,
        ),
      ),
    );
    return summary;
  }

  async processClaim(
    claim: HistoricBackfillTaskClaim,
    handler: HistoricBackfillTaskHandler,
    config: HistoricBackfillWorkerConfig,
    shutdownSignal?: AbortSignal,
    sleep: HistoricBackfillSleep = historicBackfillSleep,
  ): Promise<HistoricBackfillTaskExecutionResult> {
    const identity = leaseIdentity(claim);
    const taskController = new AbortController();
    const heartbeatController = new AbortController();
    let lostLease = false;
    let heartbeatError: unknown;
    const stopForShutdown = () => {
      taskController.abort();
      heartbeatController.abort();
    };
    if (shutdownSignal?.aborted) {
      stopForShutdown();
    } else {
      shutdownSignal?.addEventListener('abort', stopForShutdown, {
        once: true,
      });
    }

    const markLeaseLost = (error?: unknown) => {
      lostLease = true;
      heartbeatError = error;
      taskController.abort();
      heartbeatController.abort();
    };
    const heartbeat = async () => {
      if (taskController.signal.aborted) {
        return false;
      }
      try {
        const renewed = await this.queue.heartbeat(
          identity,
          undefined,
          config.leaseSeconds,
        );
        if (!renewed) {
          markLeaseLost();
        }
        return renewed;
      } catch (error) {
        markLeaseLost(error);
        throw error;
      }
    };
    const heartbeatLoop = (async () => {
      while (
        await sleep(config.heartbeatMilliseconds, heartbeatController.signal)
      ) {
        try {
          if (!(await heartbeat())) {
            return;
          }
        } catch {
          return;
        }
      }
    })();

    try {
      const output = await handler(claim, {
        signal: taskController.signal,
        heartbeat: async (progress) => {
          if (taskController.signal.aborted) {
            return false;
          }
          try {
            const renewed = await this.queue.heartbeat(
              identity,
              progress,
              config.leaseSeconds,
            );
            if (!renewed) {
              markLeaseLost();
            }
            return renewed;
          } catch (error) {
            markLeaseLost(error);
            throw error;
          }
        },
      });
      heartbeatController.abort();
      await heartbeatLoop;

      if (lostLease) {
        if (heartbeatError) {
          this.logger.warn(
            `Historic backfill lease heartbeat failed for ${claim.runId}/${claim.departementCode}`,
          );
        }
        return 'lease-lost';
      }
      if (shutdownSignal?.aborted) {
        const yielded = await this.queue.yieldTask(
          identity,
          config.yieldDelaySeconds,
        );
        return yielded ? 'yielded' : 'lease-lost';
      }
      return (await this.queue.complete(identity, output))
        ? 'completed'
        : 'lease-lost';
    } catch (error) {
      heartbeatController.abort();
      await heartbeatLoop;
      if (lostLease) {
        return 'lease-lost';
      }
      if (
        shutdownSignal?.aborted ||
        error instanceof HistoricBackfillTaskInterruptedError
      ) {
        const yielded = await this.queue.yieldTask(
          identity,
          config.yieldDelaySeconds,
        );
        return yielded ? 'yielded' : 'lease-lost';
      }
      const disposition = await this.queue.fail(
        identity,
        error,
        config.maxAttempts,
        config.retryBaseSeconds,
        config.retryMaxSeconds,
      );
      return disposition ?? 'lease-lost';
    } finally {
      heartbeatController.abort();
      shutdownSignal?.removeEventListener('abort', stopForShutdown);
    }
  }

  private async runSlot(
    handler: HistoricBackfillTaskHandler,
    workerId: string,
    config: HistoricBackfillWorkerConfig,
    summary: HistoricBackfillWorkerRunSummary,
    signal: AbortSignal | undefined,
    maxIdlePolls: number | undefined,
    sleep: HistoricBackfillSleep,
  ): Promise<void> {
    let idlePolls = 0;
    while (!signal?.aborted) {
      let claim: HistoricBackfillTaskClaim | null;
      try {
        claim = await this.queue.claim(
          workerId,
          config.leaseSeconds,
          config.maxAttempts,
          config.duringCurrentConcurrency,
        );
      } catch (error) {
        summary.claimErrors += 1;
        this.logger.error(
          `Unable to claim a historic backfill task: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        if (!(await sleep(config.errorPollMilliseconds, signal))) {
          return;
        }
        continue;
      }

      if (!claim) {
        idlePolls += 1;
        if (maxIdlePolls !== undefined && idlePolls >= maxIdlePolls) {
          return;
        }
        if (!(await sleep(config.pollMilliseconds, signal))) {
          return;
        }
        continue;
      }

      idlePolls = 0;
      summary.claimed += 1;
      const result = await this.processClaim(
        claim,
        handler,
        config,
        signal,
        sleep,
      );
      if (result === 'completed') {
        summary.completed += 1;
      } else if (result === 'retry') {
        summary.retries += 1;
      } else if (result === 'terminal') {
        summary.terminalFailures += 1;
      } else if (result === 'yielded') {
        summary.yielded += 1;
      } else if (result === 'lease-lost') {
        summary.lostLeases += 1;
      }
    }
  }
}
