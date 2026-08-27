import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Injectable, Logger } from '@nestjs/common';
import {
  HistoricBackfillWorkerConfig,
  readHistoricBackfillWorkerConfig,
} from './historic-backfill.config';
import {
  HistoricBackfillArtifactBuilderService,
  HistoricBackfillArtifactYieldError,
} from './historic-backfill-artifact-builder.service';
import {
  HistoricBackfillArtifactLease,
  HistoricBackfillArtifactQueueService,
} from './historic-backfill-artifact-queue.service';
import { historicBackfillSleep } from './historic-backfill-worker-loop';

export interface HistoricBackfillArtifactWorkerSummary {
  enabled: boolean;
  claimed: number;
  completed: number;
  yielded: number;
  failed: number;
  lostLeases: number;
}

@Injectable()
export class HistoricBackfillArtifactWorkerLoop {
  private readonly logger = new Logger(HistoricBackfillArtifactWorkerLoop.name);

  constructor(
    private readonly queue: HistoricBackfillArtifactQueueService,
    private readonly builder: HistoricBackfillArtifactBuilderService,
  ) {}

  async run(
    options: {
      environment?: NodeJS.ProcessEnv;
      signal?: AbortSignal;
      workerId?: string;
      maxIdlePolls?: number;
    } = {},
  ): Promise<HistoricBackfillArtifactWorkerSummary> {
    const config = readHistoricBackfillWorkerConfig(options.environment);
    const summary: HistoricBackfillArtifactWorkerSummary = {
      enabled: config.enabled,
      claimed: 0,
      completed: 0,
      yielded: 0,
      failed: 0,
      lostLeases: 0,
    };
    if (!config.enabled) {
      return summary;
    }
    const baseWorkerId = (
      options.workerId ??
      `${hostname()}:${process.pid}:artifact:${randomUUID()}`
    ).slice(0, 190);
    const concurrency = this.readConcurrency(options.environment);
    await Promise.all(
      Array.from({ length: concurrency }, (_, slot) =>
        this.runSlot(
          `${baseWorkerId}:${slot + 1}`,
          config,
          summary,
          options.signal,
          options.maxIdlePolls,
        ),
      ),
    );
    return summary;
  }

  private async runSlot(
    workerId: string,
    config: HistoricBackfillWorkerConfig,
    summary: HistoricBackfillArtifactWorkerSummary,
    signal?: AbortSignal,
    maxIdlePolls?: number,
  ): Promise<void> {
    let idlePolls = 0;
    while (!signal?.aborted) {
      try {
        const runId = await this.queue.findRunnableRunId();
        const claim = runId
          ? await this.queue.claim(
              runId,
              workerId,
              config.leaseSeconds,
              config.maxAttempts,
            )
          : null;
        if (!claim) {
          idlePolls += 1;
          if (maxIdlePolls !== undefined && idlePolls >= maxIdlePolls) {
            return;
          }
          if (!(await historicBackfillSleep(config.pollMilliseconds, signal))) {
            return;
          }
          continue;
        }
        idlePolls = 0;
        summary.claimed += 1;
        const result = await this.processClaim(claim, config, signal);
        summary[result] += 1;
      } catch (error) {
        this.logger.error(
          `Historic artifact worker error: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (
          !(await historicBackfillSleep(config.errorPollMilliseconds, signal))
        ) {
          return;
        }
      }
    }
  }

  private async processClaim(
    claim: HistoricBackfillArtifactLease,
    config: HistoricBackfillWorkerConfig,
    shutdownSignal?: AbortSignal,
  ): Promise<'completed' | 'yielded' | 'failed' | 'lostLeases'> {
    const controller = new AbortController();
    let leaseLost = false;
    const stop = () => controller.abort(new Error('Artifact worker stopped'));
    shutdownSignal?.addEventListener('abort', stop, { once: true });
    const heartbeat = setInterval(() => {
      void this.queue
        .heartbeat(claim, config.leaseSeconds)
        .then((renewed) => {
          if (!renewed) {
            leaseLost = true;
            controller.abort(new Error('Historic artifact lease lost'));
          }
        })
        .catch((error) => {
          leaseLost = true;
          controller.abort(error);
        });
    }, config.heartbeatMilliseconds);
    heartbeat.unref();

    try {
      const output = await this.builder.build(claim, controller.signal);
      if (leaseLost) {
        return 'lostLeases';
      }
      return (await this.queue.complete(claim, output))
        ? 'completed'
        : 'lostLeases';
    } catch (error) {
      if (leaseLost) {
        return 'lostLeases';
      }
      if (
        shutdownSignal?.aborted ||
        error instanceof HistoricBackfillArtifactYieldError
      ) {
        return (await this.queue.yieldTask(claim, config.yieldDelaySeconds))
          ? 'yielded'
          : 'lostLeases';
      }
      const retryDelay = Math.min(
        config.retryMaxSeconds,
        config.retryBaseSeconds * 2 ** Math.max(0, claim.attemptCount - 1),
      );
      return (await this.queue.fail(
        claim,
        error,
        config.maxAttempts,
        retryDelay,
      ))
        ? 'failed'
        : 'lostLeases';
    } finally {
      clearInterval(heartbeat);
      shutdownSignal?.removeEventListener('abort', stop);
    }
  }

  private readConcurrency(
    environment: NodeJS.ProcessEnv = process.env,
  ): number {
    const raw = environment.HISTORIC_BACKFILL_ARTIFACT_CONCURRENCY?.trim();
    const value = raw ? Number(raw) : 1;
    if (!Number.isInteger(value) || value < 1 || value > 8) {
      throw new Error(
        'HISTORIC_BACKFILL_ARTIFACT_CONCURRENCY must be between 1 and 8',
      );
    }
    return value;
  }
}
