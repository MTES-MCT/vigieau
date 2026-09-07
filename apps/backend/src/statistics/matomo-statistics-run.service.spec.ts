import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import * as Sentry from '@sentry/nestjs';
import { VigieauLogger } from '../logger/vigieau.logger';
import { MatomoReportError } from './matomo-statistics.client';
import { MatomoStatisticsRunService } from './matomo-statistics-run.service';

jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }));

describe('MatomoStatisticsRunService', () => {
  const initialTime = new Date('2026-09-07T15:00:00Z');
  let rows: Map<string, any>;
  let locks: Map<string, any>;
  let runners: any[];
  let dataSource: DataSource;
  let previousDsn: string | undefined;

  const makeService = (environment = 'prod') =>
    new MatomoStatisticsRunService(dataSource, {
      get: (key: string) => (key === 'SENTRY_ENV' ? environment : undefined),
    } as ConfigService);

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(initialTime);
    jest
      .spyOn(VigieauLogger.prototype, 'error')
      .mockImplementation(() => undefined);
    jest.mocked(Sentry.captureException).mockClear();
    previousDsn = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = 'configured-for-test';
    rows = new Map();
    locks = new Map();
    runners = [];
    dataSource = {
      createQueryRunner: () => {
        const runner = {
          connect: jest.fn().mockResolvedValue(undefined),
          release: jest.fn().mockResolvedValue(undefined),
          query: jest.fn(async (sql: string, args: any[] = []) => {
            const [key] = args;
            if (sql.includes('pg_try_advisory_lock')) {
              if (locks.has(key)) return [{ locked: false }];
              locks.set(key, runner);
              return [{ locked: true }];
            }
            if (sql.includes('pg_advisory_unlock_all')) {
              for (const [name, owner] of locks) {
                if (owner === runner) locks.delete(name);
              }
              return [];
            }
            if (sql.includes('pg_advisory_unlock')) {
              const unlocked = locks.get(key) === runner;
              if (unlocked) locks.delete(key);
              return [{ unlocked }];
            }
            if (sql.includes('SELECT "status"'))
              return rows.has(key) ? [rows.get(key)] : [];
            if (sql.includes('INSERT INTO')) {
              rows.set(key, {
                status: 'running',
                attempt: args[2],
                retryAfter: args[4],
                metadata: JSON.parse(args[5]),
                scheduledFor: args[1],
              });
              return [];
            }
            if (sql.includes('UPDATE "external_publication_run"')) {
              Object.assign(rows.get(key), {
                status: sql.includes("'failed'") ? 'failed' : 'succeeded',
                retryAfter: args[3],
                error: args[4] || null,
              });
              return [];
            }
            throw new Error(`Unexpected SQL: ${sql}`);
          }),
        };
        runners.push(runner);
        return runner;
      },
    } as unknown as DataSource;
  });

  afterEach(() => {
    if (previousDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = previousDsn;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('allows only one concurrent collector and releases each dedicated session', async () => {
    let finish!: () => void;
    let started!: () => void;
    const collected = new Promise<void>((resolve) => {
      started = resolve;
    });
    const collect = jest.fn(async () => {
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const first = makeService().run('fingerprint', collect);
    await collected;
    await makeService().run('fingerprint', collect);
    expect(collect).toHaveBeenCalledTimes(1);
    finish();
    await first;
    expect(locks.size).toBe(0);
    expect(runners).toHaveLength(2);
    runners.forEach((runner) =>
      expect(runner.release).toHaveBeenCalledTimes(1),
    );
  });

  it('also prevents sequential duplicates after a fast success, then runs at the next slot', async () => {
    const collect = jest.fn().mockResolvedValue(undefined);
    await makeService().run('fingerprint', collect);
    await makeService().run('fingerprint', collect);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(rows.get('matomo:statistics:prod').retryAfter).toEqual(
      new Date('2026-09-07T18:00:00Z'),
    );
    jest.setSystemTime(new Date('2026-09-07T18:00:00Z'));
    await makeService().run('fingerprint', collect);
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('uses independent collection state for environments sharing a database', async () => {
    const collect = jest.fn().mockResolvedValue(undefined);
    await makeService('prod').run('fingerprint', collect);
    await makeService('preprod').run('fingerprint', collect);
    expect(collect).toHaveBeenCalledTimes(2);
    expect(rows.size).toBe(2);
  });

  it('reports a legacy 401 once and shares its 24-hour cooldown across instances and dates', async () => {
    const error = new MatomoReportError(
      'legacy',
      'VisitsSummary.getVisits',
      'authentication',
      401,
      'legacy.example.test',
    );
    const collect = jest.fn().mockRejectedValue(error);
    await makeService().run('fingerprint', collect);
    await makeService().run('fingerprint', collect);
    jest.setSystemTime(new Date('2026-09-08T00:00:00Z'));
    await makeService().run('fingerprint', collect);

    expect(collect).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(error, {
      tags: expect.objectContaining({
        component: 'matomo-statistics',
        source: 'legacy',
        failure: 'authentication',
        http_status: '401',
      }),
    });
    expect(rows.get('matomo:statistics:prod')).toMatchObject({
      status: 'failed',
      retryAfter: new Date('2026-09-08T15:00:00Z'),
    });
    expect(locks.size).toBe(0);
  });

  it('retries immediately after a credential change and clears the failure on success', async () => {
    const collect = jest
      .fn()
      .mockRejectedValueOnce(
        new MatomoReportError(
          'legacy',
          'VisitsSummary.getVisits',
          'authentication',
          401,
        ),
      )
      .mockResolvedValue(undefined);
    await makeService().run('old-fingerprint', collect);
    await makeService().run('fixed-fingerprint', collect);
    expect(collect).toHaveBeenCalledTimes(2);
    expect(rows.get('matomo:statistics:prod')).toMatchObject({
      status: 'succeeded',
      error: null,
      attempt: 1,
    });
  });

  it('recovers a crashed collector after its lease expires without reusing the old run', async () => {
    rows.set('matomo:statistics:prod', {
      status: 'running',
      attempt: 1,
      retryAfter: new Date('2026-09-07T15:05:00Z'),
      metadata: { fingerprint: 'fingerprint' },
      scheduledFor: '2026-09-07',
    });
    const collect = jest.fn().mockResolvedValue(undefined);
    await makeService().run('fingerprint', collect);
    expect(collect).not.toHaveBeenCalled();

    jest.setSystemTime(new Date('2026-09-07T15:05:00Z'));
    await makeService().run('fingerprint', collect);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(rows.get('matomo:statistics:prod').status).toBe('succeeded');
    expect(locks.size).toBe(0);
  });

  it.each([
    new MatomoReportError('current', 'VisitsSummary.getVisits', 'http', 500),
    new MatomoReportError('legacy', 'VisitsSummary.getVisits', 'timeout'),
  ])(
    'backs off repeated transient failures without an immediate retry loop (%s)',
    async (error) => {
      const collect = jest.fn().mockRejectedValue(error);
      await makeService().run('fingerprint', collect);
      await makeService().run('fingerprint', collect);
      expect(collect).toHaveBeenCalledTimes(1);
      expect(rows.get('matomo:statistics:prod').retryAfter).toEqual(
        new Date('2026-09-07T18:00:00Z'),
      );
      jest.setSystemTime(new Date('2026-09-07T18:00:00Z'));
      await makeService().run('fingerprint', collect);
      expect(collect).toHaveBeenCalledTimes(2);
      expect(rows.get('matomo:statistics:prod')).toMatchObject({
        attempt: 2,
        retryAfter: new Date('2026-09-08T00:00:00Z'),
      });
    },
  );

  it('does not collect if the registry is unavailable and still releases the lock', async () => {
    const create = dataSource.createQueryRunner.bind(dataSource);
    dataSource.createQueryRunner = jest.fn(() => {
      const runner = create();
      const query = runner.query;
      runner.query = jest.fn((sql, args) => {
        if (sql.includes('SELECT "status"'))
          return Promise.reject(new Error('Registry unavailable'));
        return query(sql, args);
      });
      return runner;
    });
    const collect = jest.fn();
    await expect(
      makeService().run('fingerprint', collect),
    ).resolves.toBeUndefined();
    expect(collect).not.toHaveBeenCalled();
    expect(locks.size).toBe(0);
    expect(runners[0].release).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
