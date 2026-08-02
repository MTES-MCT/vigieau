import { EventEmitter } from 'node:events';
import {
  BUSINESS_SCHEDULER_PROCESS_ENV,
  DISABLE_SCHEDULED_JOBS_ENV,
} from './business-cron';
import { ClockHeartbeatService } from './clock-heartbeat.service';

describe('ClockHeartbeatService', () => {
  const previousRole = process.env[BUSINESS_SCHEDULER_PROCESS_ENV];
  const previousDisabled = process.env[DISABLE_SCHEDULED_JOBS_ENV];
  const previousExitCode = process.exitCode;

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    process.exitCode = previousExitCode;
    if (previousRole === undefined) {
      delete process.env[BUSINESS_SCHEDULER_PROCESS_ENV];
    } else {
      process.env[BUSINESS_SCHEDULER_PROCESS_ENV] = previousRole;
    }
    if (previousDisabled === undefined) {
      delete process.env[DISABLE_SCHEDULED_JOBS_ENV];
    } else {
      process.env[DISABLE_SCHEDULED_JOBS_ENV] = previousDisabled;
    }
  });

  function createService(
    query = jest.fn().mockResolvedValue([]),
    values: Record<string, string> = {},
    leadershipAvailable: boolean | boolean[] = true,
    heartbeatResults: Array<{
      leadershipHeld: boolean;
      heartbeatRecorded: boolean;
    }> = [{ leadershipHeld: true, heartbeatRecorded: true }],
    scheduledJobs: Array<{ stop: jest.Mock }> = [],
  ) {
    const configService = {
      get: jest.fn((key: string) => values[key]),
    };
    const connection = new EventEmitter();
    let leadershipIndex = 0;
    let heartbeatIndex = 0;
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(connection),
      query: jest.fn(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) {
          const locked = Array.isArray(leadershipAvailable)
            ? leadershipAvailable[
                Math.min(leadershipIndex, leadershipAvailable.length - 1)
              ]
            : leadershipAvailable;
          leadershipIndex += 1;
          return [{ locked }];
        }
        if (sql.includes('INSERT INTO "scheduler_heartbeat"')) {
          const result =
            heartbeatResults[
              Math.min(heartbeatIndex, heartbeatResults.length - 1)
            ];
          heartbeatIndex += 1;
          return [result];
        }
        return [{ unlocked: true }];
      }),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = {
      query,
      createQueryRunner: jest.fn(() => queryRunner),
    };
    const cronJobs = new Map(
      scheduledJobs.map((job, index) => [`job-${index}`, job]),
    );
    const schedulerRegistry = {
      getCronJobs: jest.fn(() => cronJobs),
    };
    return {
      service: new ClockHeartbeatService(
        dataSource as any,
        configService as any,
        schedulerRegistry as any,
      ),
      query,
      queryRunner,
      connection,
      configService,
      cronJobs,
      schedulerRegistry,
    };
  }

  it('writes an immediate durable heartbeat only in the clock process', async () => {
    const web = createService();
    delete process.env[BUSINESS_SCHEDULER_PROCESS_ENV];
    await web.service.onModuleInit();
    expect(web.queryRunner.connect).not.toHaveBeenCalled();

    const clock = createService();
    process.env[BUSINESS_SCHEDULER_PROCESS_ENV] = 'true';
    await clock.service.onModuleInit();
    expect(clock.query).not.toHaveBeenCalled();
    expect(clock.queryRunner.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO "scheduler_heartbeat"'),
      [
        expect.any(Number),
        expect.any(Number),
        'business-clock',
        expect.any(Date),
      ],
    );
  });

  it('does not advertise a fresh clock while scheduled jobs are disabled', async () => {
    process.env[BUSINESS_SCHEDULER_PROCESS_ENV] = 'true';
    process.env[DISABLE_SCHEDULED_JOBS_ENV] = 'true';
    const disabled = createService();

    await disabled.service.onModuleInit();

    expect(disabled.query).not.toHaveBeenCalled();
    expect(disabled.queryRunner.connect).not.toHaveBeenCalled();
  });

  it('acquires leadership after temporary rolling-deploy contention', async () => {
    jest.useFakeTimers();
    process.env[BUSINESS_SCHEDULER_PROCESS_ENV] = 'true';
    delete process.env[DISABLE_SCHEDULED_JOBS_ENV];
    const clock = createService(
      jest.fn(),
      {
        CLOCK_LEADERSHIP_ACQUIRE_TIMEOUT_SECONDS: '10',
        CLOCK_LEADERSHIP_RETRY_SECONDS: '1',
      },
      [false, false, true],
    );

    const initialization = clock.service.onModuleInit();
    await Promise.resolve();
    expect(
      clock.queryRunner.query.mock.calls.filter(([sql]) =>
        sql.includes('INSERT INTO "scheduler_heartbeat"'),
      ),
    ).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);
    await initialization;

    expect(
      clock.queryRunner.query.mock.calls.filter(([sql]) =>
        sql.includes('pg_try_advisory_lock'),
      ),
    ).toHaveLength(3);
    expect(clock.queryRunner.release).not.toHaveBeenCalled();
    expect(clock.queryRunner.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO "scheduler_heartbeat"'),
      expect.any(Array),
    );
  });

  it('fails and releases its connection after persistent contention', async () => {
    jest.useFakeTimers();
    process.env[BUSINESS_SCHEDULER_PROCESS_ENV] = 'true';
    delete process.env[DISABLE_SCHEDULED_JOBS_ENV];
    const second = createService(
      jest.fn(),
      {
        CLOCK_LEADERSHIP_ACQUIRE_TIMEOUT_SECONDS: '2',
        CLOCK_LEADERSHIP_RETRY_SECONDS: '1',
      },
      false,
    );

    const rejection = expect(second.service.onModuleInit()).rejects.toThrow(
      'still owns the lock after 2 seconds',
    );
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);
    await rejection;

    expect(second.query).not.toHaveBeenCalled();
    expect(
      second.queryRunner.query.mock.calls.filter(([sql]) =>
        sql.includes('pg_try_advisory_lock'),
      ),
    ).toHaveLength(3);
    expect(second.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending leadership wait during shutdown', async () => {
    jest.useFakeTimers();
    process.env[BUSINESS_SCHEDULER_PROCESS_ENV] = 'true';
    delete process.env[DISABLE_SCHEDULED_JOBS_ENV];
    const clock = createService(
      jest.fn(),
      {
        CLOCK_LEADERSHIP_ACQUIRE_TIMEOUT_SECONDS: '90',
        CLOCK_LEADERSHIP_RETRY_SECONDS: '10',
      },
      false,
    );

    const initialization = clock.service.onModuleInit().catch((error) => error);
    await Promise.resolve();
    await clock.service.onModuleDestroy();

    await expect(initialization).resolves.toThrow(
      'leadership acquisition cancelled during shutdown',
    );
    expect(clock.queryRunner.release).toHaveBeenCalledTimes(1);
    expect(
      clock.queryRunner.query.mock.calls.filter(([sql]) =>
        sql.includes('pg_try_advisory_lock'),
      ),
    ).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('releases leadership during a graceful shutdown', async () => {
    process.env[BUSINESS_SCHEDULER_PROCESS_ENV] = 'true';
    delete process.env[DISABLE_SCHEDULED_JOBS_ENV];
    const clock = createService();

    await clock.service.onModuleInit();
    await clock.service.onModuleDestroy();

    expect(
      clock.queryRunner.query.mock.calls.some(([sql]) =>
        sql.includes('pg_advisory_unlock'),
      ),
    ).toBe(false);

    await clock.service.beforeApplicationShutdown();

    expect(clock.queryRunner.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock($1, $2) AS unlocked',
      [expect.any(Number), expect.any(Number)],
    );
    expect(clock.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('drains captured cron jobs before releasing leadership', async () => {
    process.env[BUSINESS_SCHEDULER_PROCESS_ENV] = 'true';
    delete process.env[DISABLE_SCHEDULED_JOBS_ENV];
    let finishJob: () => void = () => undefined;
    const stop = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishJob = resolve;
        }),
    );
    const clock = createService(
      jest.fn(),
      {},
      true,
      [{ leadershipHeld: true, heartbeatRecorded: true }],
      [{ stop }],
    );

    await clock.service.onModuleInit();
    await clock.service.onModuleDestroy();
    clock.cronJobs.clear();

    const shutdown = clock.service.beforeApplicationShutdown();
    await Promise.resolve();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(
      clock.queryRunner.query.mock.calls.some(([sql]) =>
        sql.includes('pg_advisory_unlock'),
      ),
    ).toBe(false);

    finishJob();
    await shutdown;

    expect(clock.queryRunner.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock($1, $2) AS unlocked',
      [expect.any(Number), expect.any(Number)],
    );
    expect(clock.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it.each(['error', 'end'] as const)(
    'terminates the clock when its leadership connection emits %s',
    async (event) => {
      process.env[BUSINESS_SCHEDULER_PROCESS_ENV] = 'true';
      delete process.env[DISABLE_SCHEDULED_JOBS_ENV];
      const kill = jest.spyOn(process, 'kill').mockReturnValue(true);
      const clock = createService();
      await clock.service.onModuleInit();

      if (event === 'error') {
        clock.connection.emit(event, new Error('connection lost'));
      } else {
        clock.connection.emit(event);
      }

      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
      await expect(clock.service.recordHeartbeat()).rejects.toThrow(
        'without leadership',
      );
      expect(
        clock.queryRunner.query.mock.calls.filter(([sql]) =>
          sql.includes('INSERT INTO "scheduler_heartbeat"'),
        ),
      ).toHaveLength(1);
    },
  );

  it('does not publish a heartbeat and terminates when the session no longer owns the lock', async () => {
    process.env[BUSINESS_SCHEDULER_PROCESS_ENV] = 'true';
    delete process.env[DISABLE_SCHEDULED_JOBS_ENV];
    const kill = jest.spyOn(process, 'kill').mockReturnValue(true);
    const clock = createService(jest.fn(), {}, true, [
      { leadershipHeld: true, heartbeatRecorded: true },
      { leadershipHeld: false, heartbeatRecorded: false },
    ]);
    await clock.service.onModuleInit();

    await expect(clock.service.recordHeartbeat()).rejects.toThrow(
      'leadership lock was lost',
    );

    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(clock.queryRunner.query.mock.calls[1][0]).toContain('pg_locks');
  });

  it('caches heartbeat reads while computing age for the request time', async () => {
    const query = jest
      .fn()
      .mockResolvedValue([{ lastSeenAt: '2026-08-01T12:00:00.000Z' }]);
    const { service } = createService(query, {
      CLOCK_HEALTH_CACHE_SECONDS: '15',
      CLOCK_HEARTBEAT_STALE_AFTER_SECONDS: '300',
    });

    await expect(
      service.getHealthStatus(new Date('2026-08-01T12:01:00.000Z')),
    ).resolves.toEqual({
      status: 'healthy',
      lastSeenAt: '2026-08-01T12:00:00.000Z',
      ageSeconds: 60,
      staleAfterSeconds: 300,
    });
    await expect(
      service.getHealthStatus(new Date('2026-08-01T12:01:10.000Z')),
    ).resolves.toMatchObject({ status: 'healthy', ageSeconds: 70 });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('reports stale and missing clock heartbeats explicitly', async () => {
    const stale = createService(
      jest.fn().mockResolvedValue([{ lastSeenAt: '2026-08-01T11:50:00.000Z' }]),
      { CLOCK_HEARTBEAT_STALE_AFTER_SECONDS: '300' },
    );
    await expect(
      stale.service.getHealthStatus(new Date('2026-08-01T12:00:00.000Z')),
    ).resolves.toMatchObject({ status: 'stale', ageSeconds: 600 });

    const missing = createService();
    await expect(
      missing.service.getHealthStatus(new Date('2026-08-01T12:00:00.000Z')),
    ).resolves.toEqual({
      status: 'never_seen',
      lastSeenAt: null,
      ageSeconds: null,
      staleAfterSeconds: 300,
    });
  });
});
