import { bootstrapSchema } from './schema-bootstrap';

describe('bootstrapSchema', () => {
  const createDataSource = (baselineExists: boolean) => {
    const calls: string[] = [];
    const queryRunner = {
      connect: jest.fn(async () => {
        calls.push('connect');
      }),
      query: jest.fn(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) {
          calls.push('lock');
          return [{ locked: true }];
        }
        if (sql.includes('to_regclass')) {
          calls.push('baseline');
          return [{ baselineExists }];
        }
        if (sql.includes('pg_advisory_unlock')) {
          calls.push('unlock');
          return [{ pg_advisory_unlock: true }];
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
      release: jest.fn(async () => {
        calls.push('release');
      }),
    };
    const dataSource = {
      createQueryRunner: jest.fn(() => queryRunner),
      synchronize: jest.fn(async () => {
        calls.push('synchronize');
      }),
      runMigrations: jest.fn(async () => {
        calls.push('migrate');
        return [];
      }),
    };

    return { calls, dataSource, queryRunner };
  };

  it('synchronizes an empty database once before running migrations', async () => {
    const { calls, dataSource, queryRunner } = createDataSource(false);

    await bootstrapSchema(dataSource as any);

    expect(calls).toEqual([
      'connect',
      'lock',
      'baseline',
      'synchronize',
      'migrate',
      'unlock',
      'release',
    ]);
    expect(dataSource.synchronize).toHaveBeenCalledTimes(1);
    expect(dataSource.runMigrations).toHaveBeenCalledTimes(1);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('uses migrations only when the baseline table already exists', async () => {
    const { calls, dataSource, queryRunner } = createDataSource(true);

    await bootstrapSchema(dataSource as any);

    expect(calls).toEqual([
      'connect',
      'lock',
      'baseline',
      'migrate',
      'unlock',
      'release',
    ]);
    expect(dataSource.synchronize).not.toHaveBeenCalled();
    expect(dataSource.runMigrations).toHaveBeenCalledTimes(1);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });
});
