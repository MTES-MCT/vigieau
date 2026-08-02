import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  NATIONAL_DAILY_COMPUTE_JOB_KEY,
  NATIONAL_HISTORIC_CATCHUP_JOB_KEY,
} from '../core/scheduling/daily-job-schedule';

const STALE_RUN_MS = 2 * 60 * 60 * 1000;
const BASE_RETRY_MS = 5 * 60 * 1000;
const MAX_RETRY_MS = 60 * 60 * 1000;
const IMMEDIATE_ORPHAN_RECOVERY_JOB_KEYS = new Set([
  NATIONAL_DAILY_COMPUTE_JOB_KEY,
  NATIONAL_HISTORIC_CATCHUP_JOB_KEY,
]);

interface PublicationRunRow {
  status: 'running' | 'succeeded' | 'failed';
  attempt: number;
  startedAt: Date | string | null;
  retryAfter: Date | string | null;
  metadata: Record<string, unknown> | string | null;
}

export interface PublicationRunIdentity {
  sourceRevision?: string;
  publicationId?: string;
  materializationVersion?: number;
  historicMapCursor?: string | null;
  historicStatsCursor?: string | null;
  historicMapGeneration?: string;
  historicStatsGeneration?: string;
}

export interface ExecuteDailyRunOptions {
  identity?: PublicationRunIdentity;
}

export type PublicationRunResult =
  | 'busy'
  | 'not_due'
  | 'succeeded'
  | 'already_succeeded';

export interface PublishedResourceDetails {
  remoteResourceId?: string;
  sourceDate?: string;
  checksum?: string;
  byteSize?: number;
  metadata?: Record<string, unknown>;
}

export interface ExternalPublicationHealth {
  status: 'healthy' | 'degraded' | 'stale' | 'never_succeeded';
  lastRun: {
    scheduledFor: string;
    status: 'running' | 'succeeded' | 'failed';
    attempt: number;
    finishedAt: string | null;
  } | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  successAgeSeconds: number | null;
  failedResourceCount: number;
}

@Injectable()
export class ExternalPublicationRegistryService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async getHealthStatus(now = new Date()): Promise<ExternalPublicationHealth> {
    const [[lastRun], [runSummary], [resourceSummary]] = await Promise.all([
      this.dataSource.query(`
        SELECT "scheduledFor", "status", "attempt", "finishedAt"
        FROM "external_publication_run"
        WHERE "jobKey" = 'datagouv:daily'
        ORDER BY "scheduledFor" DESC
        LIMIT 1
      `),
      this.dataSource.query(`
        SELECT
          max("finishedAt") FILTER (WHERE "status" = 'succeeded') AS "lastSuccessAt",
          max("finishedAt") FILTER (WHERE "status" = 'failed') AS "lastFailureAt"
        FROM "external_publication_run"
        WHERE "jobKey" = 'datagouv:daily'
      `),
      this.dataSource.query(`
        SELECT count(*) FILTER (WHERE "status" = 'failed') AS "failedResourceCount"
        FROM "external_publication_resource"
        WHERE "updatedAt" >= now() - interval '30 hours'
      `),
    ]);
    const lastSuccessAt = runSummary?.lastSuccessAt
      ? new Date(runSummary.lastSuccessAt)
      : null;
    const lastFailureAt = runSummary?.lastFailureAt
      ? new Date(runSummary.lastFailureAt)
      : null;
    const successAgeSeconds = lastSuccessAt
      ? Math.max(
          0,
          Math.floor((now.getTime() - lastSuccessAt.getTime()) / 1000),
        )
      : null;
    const failedResourceCount = Number(
      resourceSummary?.failedResourceCount || 0,
    );

    let status: ExternalPublicationHealth['status'] = 'healthy';
    if (!lastSuccessAt) {
      status = 'never_succeeded';
    } else if (successAgeSeconds !== null && successAgeSeconds > 30 * 60 * 60) {
      status = 'stale';
    } else if (
      failedResourceCount > 0 ||
      (lastFailureAt && lastFailureAt.getTime() > lastSuccessAt.getTime())
    ) {
      status = 'degraded';
    }

    return {
      status,
      lastRun: lastRun
        ? {
            scheduledFor:
              lastRun.scheduledFor instanceof Date
                ? lastRun.scheduledFor.toISOString().slice(0, 10)
                : String(lastRun.scheduledFor).slice(0, 10),
            status: lastRun.status,
            attempt: Number(lastRun.attempt),
            finishedAt: lastRun.finishedAt
              ? new Date(lastRun.finishedAt).toISOString()
              : null,
          }
        : null,
      lastSuccessAt: lastSuccessAt?.toISOString() || null,
      lastFailureAt: lastFailureAt?.toISOString() || null,
      successAgeSeconds,
      failedResourceCount,
    };
  }

  async executeDailyRun(
    jobKey: string,
    scheduledFor: string,
    run: () => Promise<unknown>,
    now = new Date(),
    options: ExecuteDailyRunOptions = {},
  ): Promise<PublicationRunResult> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    let locked = false;
    try {
      const [lock] = await queryRunner.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [`vigieau:external-publication:${jobKey}`],
      );
      locked = lock?.locked === true;
      if (!locked) {
        return 'busy';
      }

      const [existing] = (await queryRunner.query(
        `
          SELECT "status", "attempt", "startedAt", "retryAfter", "metadata"
          FROM "external_publication_run"
          WHERE "jobKey" = $1 AND "scheduledFor" = $2
        `,
        [jobKey, scheduledFor],
      )) as PublicationRunRow[];
      const eligibility = this.getRunEligibility(
        existing,
        now,
        jobKey,
        options.identity,
      );
      if (eligibility !== 'succeeded') {
        return eligibility;
      }

      const attempt = (existing?.attempt || 0) + 1;
      await queryRunner.query(
        `
          INSERT INTO "external_publication_run" (
            "jobKey", "scheduledFor", "status", "attempt", "startedAt",
            "finishedAt", "retryAfter", "error", "metadata", "updatedAt"
          ) VALUES ($1, $2, 'running', $3, $4, NULL, NULL, NULL, $5, $4)
          ON CONFLICT ("jobKey", "scheduledFor") DO UPDATE SET
            "status" = 'running', "attempt" = EXCLUDED."attempt",
            "startedAt" = EXCLUDED."startedAt", "finishedAt" = NULL,
            "retryAfter" = NULL, "error" = NULL,
            "metadata" = EXCLUDED."metadata",
            "updatedAt" = EXCLUDED."updatedAt"
        `,
        [
          jobKey,
          scheduledFor,
          attempt,
          now,
          JSON.stringify(options.identity || {}),
        ],
      );

      try {
        const result = await run();
        const runMetadata =
          result && typeof result === 'object' && !Array.isArray(result)
            ? result
            : {};
        const metadata = {
          ...(options.identity || {}),
          ...runMetadata,
        };
        await queryRunner.query(
          `
            UPDATE "external_publication_run"
            SET "status" = 'succeeded', "finishedAt" = $3,
                "retryAfter" = NULL, "error" = NULL,
                "metadata" = $4, "updatedAt" = $3
            WHERE "jobKey" = $1 AND "scheduledFor" = $2
          `,
          [jobKey, scheduledFor, new Date(), JSON.stringify(metadata)],
        );
        return 'succeeded';
      } catch (error) {
        const failedAt = new Date();
        const retryDelay = Math.min(
          BASE_RETRY_MS * 2 ** Math.max(0, attempt - 1),
          MAX_RETRY_MS,
        );
        await queryRunner.query(
          `
            UPDATE "external_publication_run"
            SET "status" = 'failed', "finishedAt" = $3,
                "retryAfter" = $4, "error" = $5, "updatedAt" = $3
            WHERE "jobKey" = $1 AND "scheduledFor" = $2
          `,
          [
            jobKey,
            scheduledFor,
            failedAt,
            new Date(failedAt.getTime() + retryDelay),
            this.errorMessage(error),
          ],
        );
        throw error;
      }
    } finally {
      try {
        if (locked) {
          await queryRunner.query(
            'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
            [`vigieau:external-publication:${jobKey}`],
          );
        }
      } finally {
        await queryRunner.release();
      }
    }
  }

  async hasSucceeded(
    jobKey: string,
    scheduledFor: string,
    identity?: PublicationRunIdentity,
  ): Promise<boolean> {
    const [run] = await this.dataSource.query(
      `
        SELECT 1
        FROM "external_publication_run"
        WHERE "jobKey" = $1 AND "scheduledFor" = $2
          AND "status" = 'succeeded'
          AND ($3::jsonb IS NULL OR "metadata" @> $3::jsonb)
        LIMIT 1
      `,
      [jobKey, scheduledFor, identity ? JSON.stringify(identity) : null],
    );
    return Boolean(run);
  }

  async getSucceededRunMetadata(
    jobKey: string,
    scheduledFor: string,
  ): Promise<Record<string, unknown> | null> {
    const [run] = await this.dataSource.query(
      `
        SELECT "metadata"
        FROM "external_publication_run"
        WHERE "jobKey" = $1 AND "scheduledFor" = $2
          AND "status" = 'succeeded'
        LIMIT 1
      `,
      [jobKey, scheduledFor],
    );
    return this.parseMetadata(run?.metadata);
  }

  async resolveResourceId(
    key: string,
    provider: string,
    configuredResourceId?: string,
  ): Promise<string | undefined> {
    if (configuredResourceId) {
      await this.dataSource.query(
        `
          INSERT INTO "external_publication_resource" (
            "key", "provider", "remoteResourceId", "status", "updatedAt"
          ) VALUES ($1, $2, $3, 'configured', now())
          ON CONFLICT ("key") DO UPDATE SET
            "provider" = EXCLUDED."provider",
            "remoteResourceId" = EXCLUDED."remoteResourceId",
            "updatedAt" = now()
        `,
        [key, provider, configuredResourceId],
      );
      return configuredResourceId;
    }
    const [resource] = await this.dataSource.query(
      `SELECT "remoteResourceId" FROM "external_publication_resource" WHERE "key" = $1`,
      [key],
    );
    return resource?.remoteResourceId || undefined;
  }

  async recordResourceSuccess(
    key: string,
    provider: string,
    details: PublishedResourceDetails,
  ): Promise<void> {
    await this.dataSource.query(
      `
        INSERT INTO "external_publication_resource" (
          "key", "provider", "remoteResourceId", "status", "sourceDate",
          "checksum", "byteSize", "metadata", "lastSuccessAt", "updatedAt"
        ) VALUES ($1, $2, $3, 'succeeded', $4, $5, $6, $7, now(), now())
        ON CONFLICT ("key") DO UPDATE SET
          "provider" = EXCLUDED."provider",
          "remoteResourceId" = COALESCE(
            EXCLUDED."remoteResourceId",
            "external_publication_resource"."remoteResourceId"
          ),
          "status" = 'succeeded', "sourceDate" = EXCLUDED."sourceDate",
          "checksum" = EXCLUDED."checksum", "byteSize" = EXCLUDED."byteSize",
          "metadata" = EXCLUDED."metadata", "lastSuccessAt" = now(),
          "lastError" = NULL, "updatedAt" = now()
      `,
      [
        key,
        provider,
        details.remoteResourceId || null,
        details.sourceDate || null,
        details.checksum || null,
        details.byteSize ?? null,
        JSON.stringify(details.metadata || {}),
      ],
    );
  }

  async recordResourceFailure(
    key: string,
    provider: string,
    error: unknown,
  ): Promise<void> {
    await this.dataSource.query(
      `
        INSERT INTO "external_publication_resource" (
          "key", "provider", "status", "lastFailureAt", "lastError", "updatedAt"
        ) VALUES ($1, $2, 'failed', now(), $3, now())
        ON CONFLICT ("key") DO UPDATE SET
          "provider" = EXCLUDED."provider", "status" = 'failed',
          "lastFailureAt" = now(), "lastError" = EXCLUDED."lastError",
          "updatedAt" = now()
      `,
      [key, provider, this.errorMessage(error)],
    );
  }

  private getRunEligibility(
    run: PublicationRunRow | undefined,
    now: Date,
    jobKey: string,
    identity?: PublicationRunIdentity,
  ): PublicationRunResult {
    if (!run) {
      return 'succeeded';
    }
    if (run.status === 'running') {
      if (IMMEDIATE_ORPHAN_RECOVERY_JOB_KEYS.has(jobKey)) {
        return 'succeeded';
      }
      if (
        run.startedAt &&
        now.getTime() - new Date(run.startedAt).getTime() < STALE_RUN_MS
      ) {
        return 'busy';
      }
    }
    if (identity && !this.metadataContains(run.metadata, identity)) {
      return 'succeeded';
    }
    if (run.status === 'succeeded') {
      return 'already_succeeded';
    }
    if (run.retryAfter && new Date(run.retryAfter).getTime() > now.getTime()) {
      return 'not_due';
    }
    return 'succeeded';
  }

  private metadataContains(
    metadata: PublicationRunRow['metadata'],
    expected: PublicationRunIdentity,
  ): boolean {
    const parsed = this.parseMetadata(metadata);
    return (
      parsed !== null &&
      Object.entries(expected).every(([key, value]) => parsed[key] === value)
    );
  }

  private parseMetadata(
    metadata: PublicationRunRow['metadata'] | undefined,
  ): Record<string, unknown> | null {
    if (!metadata) {
      return null;
    }
    if (typeof metadata === 'string') {
      try {
        const parsed: unknown = JSON.parse(metadata);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    }
    return metadata;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
