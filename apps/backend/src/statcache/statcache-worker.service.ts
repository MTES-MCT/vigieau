import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataService } from '../data/data.service';
import { VigieauLogger } from '../logger/vigieau.logger';
import * as Sentry from '@sentry/nestjs';

@Injectable()
export class StatcacheWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new VigieauLogger('StatcacheWorkerService');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(private readonly dataService: DataService) {}

  onModuleInit(): void {
    if (process.env.VIGIEAU_PROCESS_ROLE !== 'statcache') {
      return;
    }
    this.schedule(0);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.dataService.reconcileStatisticCacheCandidate();
      if (result.outcome !== 'disabled' && result.outcome !== 'up-to-date') {
        this.logger.log(
          `STATISTIC CACHE WORKER - ${result.outcome.toUpperCase()}: ${result.reason}`,
        );
      }
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        'STATISTIC CACHE WORKER - UNEXPECTED ERROR',
        normalized.stack || normalized.message,
      );
      if (process.env.SENTRY_DSN?.trim()) {
        Sentry.captureException(normalized, {
          tags: { component: 'statistic-cache-worker' },
        });
      }
    } finally {
      this.running = false;
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      await this.runOnce();
      this.schedule(this.getPollIntervalMs());
    }, delayMs);
  }

  private getPollIntervalMs(): number {
    const seconds = Number(
      process.env.STATISTIC_CACHE_WORKER_POLL_SECONDS ?? 10,
    );
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) {
      return 10_000;
    }
    return seconds * 1_000;
  }
}
