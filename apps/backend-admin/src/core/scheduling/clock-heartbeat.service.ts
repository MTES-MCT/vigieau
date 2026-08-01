import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { RegleauLogger } from '../../logger/regleau.logger';
import {
  areScheduledJobsDisabled,
  BusinessCron,
  isBusinessSchedulerProcess,
} from './business-cron';

const CLOCK_HEARTBEAT_NAME = 'business-clock';
const DEFAULT_STALE_AFTER_SECONDS = 5 * 60;
const DEFAULT_HEALTH_CACHE_SECONDS = 15;
const CLOCK_LEADERSHIP_LOCK_NAMESPACE = 0x56494749;
const CLOCK_LEADERSHIP_LOCK_ID = 0x434c4f43;

interface LeadershipConnection {
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'end', listener: () => void): void;
  removeListener(event: 'error', listener: (error: Error) => void): void;
  removeListener(event: 'end', listener: () => void): void;
}

export interface ClockHeartbeatHealth {
  status: 'healthy' | 'stale' | 'never_seen';
  lastSeenAt: string | null;
  ageSeconds: number | null;
  staleAfterSeconds: number;
}

@Injectable()
export class ClockHeartbeatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new RegleauLogger('ClockHeartbeatService');
  private cachedLastSeenAt:
    | { value: Date | null; expiresAt: number }
    | undefined;
  private lastSeenQuery: Promise<Date | null> | null = null;
  private leadershipRunner: QueryRunner | null = null;
  private leadershipConnection: LeadershipConnection | null = null;
  private leadershipLost = false;
  private shutdownRequested = false;
  private destroying = false;
  private readonly onLeadershipConnectionError = (error: Error): void => {
    this.requestShutdown(
      error instanceof Error
        ? error
        : new Error('Clock leadership connection failed'),
    );
  };
  private readonly onLeadershipConnectionEnd = (): void => {
    this.requestShutdown(new Error('Clock leadership connection ended'));
  };

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (isBusinessSchedulerProcess() && !areScheduledJobsDisabled()) {
      await this.acquireLeadership();
      await this.recordHeartbeat();
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.destroying = true;
    this.detachLeadershipConnectionListeners();
    const runner = this.leadershipRunner;
    this.leadershipRunner = null;
    if (!runner) {
      return;
    }
    try {
      await runner.query('SELECT pg_advisory_unlock($1, $2) AS unlocked', [
        CLOCK_LEADERSHIP_LOCK_NAMESPACE,
        CLOCK_LEADERSHIP_LOCK_ID,
      ]);
    } catch (error) {
      this.logger.error('CLOCK LEADERSHIP UNLOCK ERROR', error);
    } finally {
      await runner.release();
    }
  }

  @BusinessCron(CronExpression.EVERY_MINUTE)
  async recordHeartbeat(now = new Date()): Promise<void> {
    const runner = this.leadershipRunner;
    if (!runner || this.leadershipLost) {
      const error = new Error(
        'Business clock cannot heartbeat without leadership',
      );
      this.requestShutdown(error);
      throw error;
    }

    try {
      const [result] = await runner.query(
        `
          WITH leadership AS (
            SELECT EXISTS (
              SELECT 1
              FROM pg_locks
              WHERE locktype = 'advisory'
                AND pid = pg_backend_pid()
                AND granted
                AND classid = $1::oid
                AND objid = $2::oid
                AND objsubid = 2
            ) AS held
          ), heartbeat AS (
            INSERT INTO "scheduler_heartbeat" (
              "name", "lastSeenAt", "createdAt", "updatedAt"
            )
            SELECT $3, $4, $4, $4
            FROM leadership
            WHERE held
            ON CONFLICT ("name") DO UPDATE SET
              "lastSeenAt" = EXCLUDED."lastSeenAt",
              "updatedAt" = EXCLUDED."updatedAt"
            RETURNING 1
          )
          SELECT
            leadership.held AS "leadershipHeld",
            EXISTS (SELECT 1 FROM heartbeat) AS "heartbeatRecorded"
          FROM leadership
        `,
        [
          CLOCK_LEADERSHIP_LOCK_NAMESPACE,
          CLOCK_LEADERSHIP_LOCK_ID,
          CLOCK_HEARTBEAT_NAME,
          now,
        ],
      );
      if (
        result?.leadershipHeld !== true ||
        result?.heartbeatRecorded !== true
      ) {
        throw new Error('Business clock leadership lock was lost');
      }
      this.cachedLastSeenAt = {
        value: now,
        expiresAt:
          now.getTime() +
          this.readPositiveSeconds(
            'CLOCK_HEALTH_CACHE_SECONDS',
            DEFAULT_HEALTH_CACHE_SECONDS,
          ) *
            1000,
      };
    } catch (error) {
      this.requestShutdown(error);
      throw error;
    }
  }

  async getHealthStatus(now = new Date()): Promise<ClockHeartbeatHealth> {
    const staleAfterSeconds = this.readPositiveSeconds(
      'CLOCK_HEARTBEAT_STALE_AFTER_SECONDS',
      DEFAULT_STALE_AFTER_SECONDS,
    );
    const lastSeenAt = await this.getLastSeenAt(now.getTime());
    if (!lastSeenAt) {
      return {
        status: 'never_seen',
        lastSeenAt: null,
        ageSeconds: null,
        staleAfterSeconds,
      };
    }

    const ageSeconds = Math.max(
      0,
      Math.floor((now.getTime() - lastSeenAt.getTime()) / 1000),
    );
    return {
      status: ageSeconds <= staleAfterSeconds ? 'healthy' : 'stale',
      lastSeenAt: lastSeenAt.toISOString(),
      ageSeconds,
      staleAfterSeconds,
    };
  }

  private async getLastSeenAt(nowMs: number): Promise<Date | null> {
    if (this.cachedLastSeenAt && this.cachedLastSeenAt.expiresAt > nowMs) {
      return this.cachedLastSeenAt.value;
    }
    if (this.lastSeenQuery) {
      return this.lastSeenQuery;
    }

    const query = (async () => {
      const [heartbeat] = await this.dataSource.query(
        `SELECT "lastSeenAt" FROM "scheduler_heartbeat" WHERE "name" = $1`,
        [CLOCK_HEARTBEAT_NAME],
      );
      const lastSeenAt = heartbeat?.lastSeenAt
        ? new Date(heartbeat.lastSeenAt)
        : null;
      if (lastSeenAt && Number.isNaN(lastSeenAt.getTime())) {
        throw new Error('Invalid persisted clock heartbeat');
      }
      this.cachedLastSeenAt = {
        value: lastSeenAt,
        expiresAt:
          nowMs +
          this.readPositiveSeconds(
            'CLOCK_HEALTH_CACHE_SECONDS',
            DEFAULT_HEALTH_CACHE_SECONDS,
          ) *
            1000,
      };
      return lastSeenAt;
    })();
    this.lastSeenQuery = query;
    try {
      return await query;
    } finally {
      if (this.lastSeenQuery === query) {
        this.lastSeenQuery = null;
      }
    }
  }

  private async acquireLeadership(): Promise<void> {
    const runner = this.dataSource.createQueryRunner();
    const connection = (await runner.connect()) as LeadershipConnection;
    try {
      const [result] = await runner.query(
        'SELECT pg_try_advisory_lock($1, $2) AS locked',
        [CLOCK_LEADERSHIP_LOCK_NAMESPACE, CLOCK_LEADERSHIP_LOCK_ID],
      );
      if (result?.locked !== true) {
        throw new Error('Another business clock process already owns the lock');
      }
      this.leadershipRunner = runner;
      this.leadershipConnection = connection;
      this.attachLeadershipConnectionListeners(connection);
    } catch (error) {
      await runner.release();
      throw error;
    }
  }

  private attachLeadershipConnectionListeners(
    connection: LeadershipConnection,
  ): void {
    if (
      !connection ||
      typeof connection.on !== 'function' ||
      typeof connection.removeListener !== 'function'
    ) {
      throw new Error('Clock leadership connection cannot be monitored');
    }
    connection.on('error', this.onLeadershipConnectionError);
    connection.on('end', this.onLeadershipConnectionEnd);
  }

  private detachLeadershipConnectionListeners(): void {
    const connection = this.leadershipConnection;
    this.leadershipConnection = null;
    if (!connection) {
      return;
    }
    connection.removeListener('error', this.onLeadershipConnectionError);
    connection.removeListener('end', this.onLeadershipConnectionEnd);
  }

  private requestShutdown(error: unknown): void {
    if (this.destroying || this.shutdownRequested) {
      return;
    }
    this.leadershipLost = true;
    this.shutdownRequested = true;
    this.cachedLastSeenAt = undefined;
    this.detachLeadershipConnectionListeners();
    this.logger.error(
      'CLOCK LEADERSHIP LOST',
      error instanceof Error ? error.stack || error.message : String(error),
    );
    process.exitCode = 1;
    process.kill(process.pid, 'SIGTERM');
  }

  private readPositiveSeconds(key: string, fallback: number): number {
    const value = Number(this.configService.get(key));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  }
}
