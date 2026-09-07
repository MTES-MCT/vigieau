import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, QueryRunner } from 'typeorm';
import * as Sentry from '@sentry/nestjs';
import { VigieauLogger } from '../logger/vigieau.logger';
import { MatomoReportError } from './matomo-statistics.client';

const PERIOD_MS = 3 * 60 * 60 * 1000;

@Injectable()
export class MatomoStatisticsRunService {
  private readonly logger = new VigieauLogger('MatomoStatisticsRunService');

  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  async run(fingerprint: string, collect: () => Promise<void>): Promise<void> {
    const environment =
      this.configService.get<string>('SENTRY_ENV')?.trim() ||
      this.configService.get<string>('NODE_ENV')?.trim() ||
      'local';
    const jobKey = `matomo:statistics:${environment}`;
    const lockKey = `vigieau:external-publication:${jobKey}`;
    const runner = this.dataSource.createQueryRunner();
    let locked = false;
    try {
      await runner.connect();
      const [lock] = await runner.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [lockKey],
      );
      locked = lock?.locked === true;
      if (!locked) return;

      const now = new Date();
      const [previous] = await runner.query(
        `SELECT "status", "attempt", "retryAfter", "metadata"
         FROM "external_publication_run"
         WHERE "jobKey" = $1 ORDER BY "scheduledFor" DESC LIMIT 1`,
        [jobKey],
      );
      const sameConfiguration = previous?.metadata?.fingerprint === fingerprint;
      if (
        sameConfiguration &&
        previous?.retryAfter &&
        new Date(previous.retryAfter).getTime() > now.getTime()
      ) {
        return;
      }
      const attempt =
        sameConfiguration && previous?.status === 'failed'
          ? Number(previous.attempt) + 1
          : 1;
      const scheduledFor = now.toISOString().slice(0, 10);
      const metadata = JSON.stringify({ fingerprint });
      await runner.query(
        `INSERT INTO "external_publication_run" (
           "jobKey", "scheduledFor", "status", "attempt", "startedAt",
           "finishedAt", "retryAfter", "error", "metadata", "updatedAt"
         ) VALUES ($1, $2, 'running', $3, $4, NULL, $5, NULL, $6, $4)
         ON CONFLICT ("jobKey", "scheduledFor") DO UPDATE SET
           "status" = 'running', "attempt" = EXCLUDED."attempt",
           "startedAt" = EXCLUDED."startedAt", "finishedAt" = NULL,
           "retryAfter" = EXCLUDED."retryAfter", "error" = NULL,
           "metadata" = EXCLUDED."metadata", "updatedAt" = EXCLUDED."updatedAt"`,
        [
          jobKey,
          scheduledFor,
          attempt,
          now,
          new Date(now.getTime() + 5 * 60_000),
          metadata,
        ],
      );
      try {
        await collect();
      } catch (error) {
        const failedAt = new Date();
        const configurationFailure =
          error instanceof MatomoReportError &&
          ['authentication', 'configuration'].includes(error.kind);
        const retryPeriods = configurationFailure
          ? 8
          : Math.min(8, 2 ** Math.min(attempt - 1, 3));
        const retryAfter = new Date(
          (Math.floor(failedAt.getTime() / PERIOD_MS) + retryPeriods) *
            PERIOD_MS,
        );
        await runner.query(
          `UPDATE "external_publication_run"
           SET "status" = 'failed', "finishedAt" = $3, "retryAfter" = $4,
               "error" = $5, "updatedAt" = $3
           WHERE "jobKey" = $1 AND "scheduledFor" = $2`,
          [
            jobKey,
            scheduledFor,
            failedAt,
            retryAfter,
            this.errorMessage(error),
          ],
        );
        throw error;
      }
      const finishedAt = new Date();
      const retryAfter = new Date(
        (Math.floor(finishedAt.getTime() / PERIOD_MS) + 1) * PERIOD_MS,
      );
      await runner.query(
        `UPDATE "external_publication_run"
         SET "status" = 'succeeded', "finishedAt" = $3, "retryAfter" = $4,
             "error" = NULL, "updatedAt" = $3
         WHERE "jobKey" = $1 AND "scheduledFor" = $2`,
        [jobKey, scheduledFor, finishedAt, retryAfter],
      );
    } catch (error) {
      this.reportError(error);
    } finally {
      await this.release(runner, locked ? lockKey : null);
    }
  }

  private async release(
    runner: QueryRunner,
    lockKey: string | null,
  ): Promise<void> {
    try {
      if (lockKey) {
        const [result] = await runner.query(
          'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
          [lockKey],
        );
        if (result?.unlocked !== true)
          throw new Error('Matomo lock was not released');
      }
    } catch (error) {
      this.reportError(error);
      try {
        await runner.query('SELECT pg_advisory_unlock_all()');
      } catch {
        // A broken database connection is released below.
      }
    } finally {
      try {
        await runner.release();
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error
      ? error.message
      : 'Matomo statistics collection failed';
  }

  private reportError(error: unknown): void {
    const normalized =
      error instanceof Error ? error : new Error(this.errorMessage(error));
    this.logger.error(normalized.message, normalized.stack);
    if (!process.env.SENTRY_DSN?.trim()) return;
    Sentry.captureException(normalized, {
      tags: {
        component: 'matomo-statistics',
        ...(error instanceof MatomoReportError
          ? {
              source: error.source,
              report: error.report,
              failure: error.kind,
              ...(error.status ? { http_status: String(error.status) } : {}),
              ...(error.host ? { upstream_host: error.host } : {}),
            }
          : {}),
      },
    });
  }
}
