import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  areScheduledJobsDisabled,
  BusinessCron,
  isBusinessSchedulerProcess,
} from '../core/scheduling/business-cron';
import { RegleauLogger } from '../logger/regleau.logger';
import { automaticallyAttestHistoryBySourceEquivalence } from '../scripts/automatic-history-equivalence';

export const HISTORY_RECOVERY_BOOTSTRAP_DELAY_MS = 90_000;
export const HISTORY_RECOVERY_RETRY_DELAY_MS = 30 * 60_000;

/**
 * Revalidates an existing certified repair only when its inputs and outputs
 * are unchanged. A real historical change remains provisional and needs a
 * dated source review; this service never enables mutable-geometry replay.
 */
@Injectable()
export class HistoryRecoverySchedulerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new RegleauLogger(
    HistoryRecoverySchedulerService.name,
  );
  private bootstrapTimer: ReturnType<typeof setTimeout> | null = null;
  private bootstrapScheduled = false;
  private stopped = false;
  private inFlight = false;
  private retryAfter = 0;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.canRun() || this.bootstrapScheduled) return;
    this.bootstrapScheduled = true;
    // Let current publication and application startup take priority.
    this.bootstrapTimer = setTimeout(() => {
      this.bootstrapTimer = null;
      void this.recoverIfDue();
    }, HISTORY_RECOVERY_BOOTSTRAP_DELAY_MS);
    this.bootstrapTimer.unref();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.bootstrapTimer) {
      clearTimeout(this.bootstrapTimer);
      this.bootstrapTimer = null;
    }
  }

  // Offset the current-computation scheduler, which runs every five minutes.
  @BusinessCron('0 2,32 * * * *')
  async recoverIfDue(): Promise<void> {
    // Runtime checks also protect direct/bootstrap calls and shutdown races.
    if (!this.canRun() || this.inFlight || Date.now() < this.retryAfter) {
      return;
    }
    this.inFlight = true;
    try {
      const result = await automaticallyAttestHistoryBySourceEquivalence(
        this.dataSource,
      );
      this.retryAfter = 0;
      if (result.status === 'ATTESTED') {
        this.logger.log(
          `HISTORY RECOVERY ATTESTED: unchanged certified inputs and outputs; attestation=${result.attestationId}, revision=${result.revision}`,
        );
      } else if (result.status === 'BUSY') {
        this.logger.log(
          'HISTORY RECOVERY DEFERRED: current computation or another recovery has priority',
        );
      }
      // ALREADY_ATTESTED and NOT_APPLICABLE are normal no-ops, not repairs.
    } catch (error) {
      this.retryAfter = Date.now() + HISTORY_RECOVERY_RETRY_DELAY_MS;
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(
        'HISTORY RECOVERY NEEDS REVIEW: certification was not completed; historical data remains provisional; retry in 30 minutes',
        reason,
      );
    } finally {
      this.inFlight = false;
    }
  }

  private canRun(): boolean {
    return (
      !this.stopped &&
      isBusinessSchedulerProcess() &&
      !areScheduledJobsDisabled()
    );
  }
}
