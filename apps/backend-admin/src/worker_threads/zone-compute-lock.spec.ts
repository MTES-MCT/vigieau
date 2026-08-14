import { withZoneComputeLock } from './zone-compute-lock';

describe('withZoneComputeLock', () => {
  it('exits cleanly without running the task when another dyno owns the lock', async () => {
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([{ locked: false }]),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    };
    const task = jest.fn();

    await expect(
      withZoneComputeLock(dataSource as any, [65], task, {
        skipIfBusy: true,
      }),
    ).resolves.toEqual({ acquired: false });
    expect(task).not.toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('releases acquired locks when a watchdog finds any department busy', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('zone-compute-global')) {
          return sql.includes('pg_try_advisory_lock')
            ? [{ locked: true }]
            : [{ unlocked: true }];
        }
        if (sql.includes('pg_try_advisory_lock')) {
          return [{ locked: params?.[0] === 31 }];
        }
        return [{ unlocked: true }];
      }),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    };
    const task = jest.fn();

    await expect(
      withZoneComputeLock(dataSource as any, [31, 65], task, {
        skipIfBusy: true,
      }),
    ).resolves.toEqual({ acquired: false });

    expect(task).not.toHaveBeenCalled();
    expect(
      queries.some(
        ({ sql, params }) =>
          sql.includes('pg_advisory_unlock') && params?.[0] === 31,
      ),
    ).toBe(true);
    expect(
      queries.some(
        ({ sql }) =>
          sql.includes('pg_advisory_unlock') &&
          sql.includes('zone-compute-global'),
      ),
    ).toBe(true);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('waits for the lock for a normal user or historic compute request', async () => {
    const busyQueryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([{ locked: false }]),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const acquiredQueryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) {
          return [{ locked: true }];
        }
        return [{ unlocked: true }];
      }),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = {
      createQueryRunner: jest
        .fn()
        .mockReturnValueOnce(busyQueryRunner)
        .mockReturnValueOnce(acquiredQueryRunner),
    };
    const task = jest.fn().mockResolvedValue('computed');

    await expect(
      withZoneComputeLock(dataSource as any, [65], task, {
        retryDelayMs: 0,
      }),
    ).resolves.toEqual({ acquired: true, value: 'computed' });
    expect(task).toHaveBeenCalledTimes(1);
    expect(busyQueryRunner.release).toHaveBeenCalledTimes(1);
    expect(acquiredQueryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('releases department and global session locks when the compute fails', async () => {
    const queries: string[] = [];
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('pg_try_advisory_lock')) {
          return [{ locked: true }];
        }
        return [{ unlocked: true }];
      }),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    };
    const task = jest.fn().mockRejectedValue(new Error('compute failed'));

    await expect(
      withZoneComputeLock(dataSource as any, [65], task),
    ).rejects.toThrow('compute failed');
    expect(
      queries.some((sql) => sql.includes('vigieau:sandre-zone-sync')),
    ).toBe(true);
    expect(
      queries.some(
        (sql) =>
          sql.includes('pg_advisory_unlock') &&
          sql.includes('zone-compute-global'),
      ),
    ).toBe(true);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });
});
