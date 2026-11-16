import { EventEmitter } from 'node:events';
import * as Pool from 'pg-pool';
import {
  createDatabasePoolOptions,
  DATABASE_POOL_MAX_DEFAULT,
  parseDatabasePoolMax,
} from './database-pool';

describe('parseDatabasePoolMax', () => {
  it.each([undefined, '', '  '])('uses the default for %p', (value) => {
    expect(parseDatabasePoolMax(value)).toBe(DATABASE_POOL_MAX_DEFAULT);
  });

  it.each([
    ['1', 1],
    [' 2 ', 2],
    ['20', 20],
  ])('parses %p', (value, expected) => {
    expect(parseDatabasePoolMax(value)).toBe(expected);
  });

  it.each(['0', '-1', '1.5', 'abc', '21'])('rejects %p', (value) => {
    expect(() => parseDatabasePoolMax(value)).toThrow('DATABASE_POOL_MAX');
  });
});

// Exercise pg-pool's real checkout queue without PostgreSQL or network calls.
class ConnectedClient extends EventEmitter {
  _queryable = true;
  _ending = false;

  connect(callback: () => void) {
    callback();
  }

  end(callback?: () => void) {
    callback?.();
  }
}

describe('shared application and worker database pool', () => {
  afterEach(() => jest.useRealTimers());

  it.each(['production', 'preproduction', undefined])(
    'preserves pool capacity and SSL without a global checkout deadline in %p',
    (nodeEnv) => {
      expect(createDatabasePoolOptions('3', nodeEnv)).toEqual({
        max: 3,
        ssl: { rejectUnauthorized: false },
      });
    },
  );

  it('keeps local connections without SSL and the default pool capacity', () => {
    expect(createDatabasePoolOptions(undefined, 'local')).toEqual({ max: 10 });
  });

  it('reproduces a checkout timeout when a shared deadline is configured', async () => {
    jest.useFakeTimers();
    const pool = new Pool({
      ...createDatabasePoolOptions('1', 'local'),
      Client: ConnectedClient,
      connectionTimeoutMillis: 50,
    });
    const busy = await pool.connect();
    try {
      const waiting = expect(pool.connect()).rejects.toThrow(
        'timeout exceeded when trying to connect',
      );
      await jest.advanceTimersByTimeAsync(100);
      await waiting;
      expect(pool.waitingCount).toBe(0);
    } finally {
      busy.release();
      await pool.end();
    }
  });

  it('keeps geometry work queued until a busy connection is released', async () => {
    jest.useFakeTimers();
    const pool = new Pool({
      ...createDatabasePoolOptions('1', 'local'),
      Client: ConnectedClient,
    });
    let busy = await pool.connect();
    try {
      const waiting = pool.connect();
      await jest.advanceTimersByTimeAsync(100);
      expect(pool.waitingCount).toBe(1);
      expect(pool.totalCount).toBe(1);
      const originalClient = busy;
      busy.release();
      busy = await waiting;
      expect(busy).toBe(originalClient);
      expect(pool.waitingCount).toBe(0);
    } finally {
      busy.release();
      await pool.end();
    }
  });
});
