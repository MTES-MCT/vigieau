import { ExternalPublicationRegistryService } from './external-publication-registry.service';

function createHarness(query: jest.Mock) {
  const queryRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    query,
    release: jest.fn().mockResolvedValue(undefined),
  };
  const dataSource = {
    createQueryRunner: jest.fn(() => queryRunner),
    query: jest.fn(),
  };
  return {
    service: new ExternalPublicationRegistryService(dataSource as any),
    queryRunner,
    dataSource,
  };
}

describe('ExternalPublicationRegistryService', () => {
  it('runs a daily publication once while holding a session lock', async () => {
    const query = jest.fn(async (sql: string, _params?: unknown[]) => {
      void _params;
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (sql.includes('SELECT "status"')) return [];
      if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
      return [];
    });
    const harness = createHarness(query);
    const run = jest.fn().mockResolvedValue({ publicationId: 'publication-1' });

    await expect(
      harness.service.executeDailyRun(
        'datagouv:communes-2026',
        '2026-08-01',
        run,
      ),
    ).resolves.toBe('succeeded');

    expect(run).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) => sql.includes("'running'"))).toBe(
      true,
    );
    expect(query.mock.calls.some(([sql]) => sql.includes("'succeeded'"))).toBe(
      true,
    );
    const successUpdate = query.mock.calls.find(([sql]) =>
      sql.includes('SET "status" = \'succeeded\''),
    );
    expect(successUpdate?.[1]?.[3]).toBe(
      JSON.stringify({ publicationId: 'publication-1' }),
    );
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('does not start when another process owns the job lock', async () => {
    const harness = createHarness(
      jest.fn().mockResolvedValue([{ locked: false }]),
    );
    const run = jest.fn();

    await expect(
      harness.service.executeDailyRun('datagouv:daily', '2026-08-01', run),
    ).resolves.toBe('busy');

    expect(run).not.toHaveBeenCalled();
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('immediately resumes an orphaned running publication after acquiring the lock', async () => {
    const query = jest.fn(async (sql: string, _params?: unknown[]) => {
      void _params;
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (sql.includes('SELECT "status"')) {
        return [
          {
            status: 'running',
            attempt: 1,
            startedAt: '2026-08-01T02:00:00.000Z',
            retryAfter: null,
            metadata: {},
          },
        ];
      }
      if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
      return [];
    });
    const harness = createHarness(query);
    const run = jest.fn().mockResolvedValue(undefined);

    await expect(
      harness.service.executeDailyRun(
        'compute:national-daily',
        '2026-08-01',
        run,
        new Date('2026-08-01T02:01:00.000Z'),
      ),
    ).resolves.toBe('succeeded');

    expect(run).toHaveBeenCalledTimes(1);
    expect(
      query.mock.calls.find(([sql]) =>
        sql.includes('INSERT INTO "external_publication_run"'),
      )?.[1]?.[2],
    ).toBe(2);
    expect(
      query.mock.calls.some(([sql]) => sql.includes('pg_advisory_unlock')),
    ).toBe(true);
    expect(harness.queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('keeps a grace period for a recent external publication', async () => {
    const query = jest.fn(async (sql: string, _params?: unknown[]) => {
      void _params;
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (sql.includes('SELECT "status"')) {
        return [
          {
            status: 'running',
            attempt: 1,
            startedAt: '2026-08-01T02:00:00.000Z',
            retryAfter: null,
            metadata: {},
          },
        ];
      }
      if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
      return [];
    });
    const harness = createHarness(query);
    const run = jest.fn();

    await expect(
      harness.service.executeDailyRun(
        'datagouv:daily',
        '2026-08-01',
        run,
        new Date('2026-08-01T02:01:00.000Z'),
      ),
    ).resolves.toBe('busy');

    expect(run).not.toHaveBeenCalled();
  });

  it('keeps the external grace period when the publication identity changed', async () => {
    const query = jest.fn(async (sql: string, _params?: unknown[]) => {
      void _params;
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (sql.includes('SELECT "status"')) {
        return [
          {
            status: 'running',
            attempt: 1,
            startedAt: '2026-08-01T02:00:00.000Z',
            retryAfter: null,
            metadata: {
              publicationId: 'publication-old',
              sourceRevision: '41',
            },
          },
        ];
      }
      if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
      return [];
    });
    const harness = createHarness(query);
    const run = jest.fn();

    await expect(
      harness.service.executeDailyRun(
        'datagouv:daily',
        '2026-08-01',
        run,
        new Date('2026-08-01T02:01:00.000Z'),
        {
          identity: {
            publicationId: 'publication-new',
            sourceRevision: '42',
          },
        },
      ),
    ).resolves.toBe('busy');

    expect(run).not.toHaveBeenCalled();
  });

  it('waits until the retry date of a failed publication', async () => {
    const query = jest.fn(async (sql: string, _params?: unknown[]) => {
      void _params;
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (sql.includes('SELECT "status"')) {
        return [
          {
            status: 'failed',
            attempt: 1,
            retryAfter: '2026-08-01T02:10:00.000Z',
            metadata: {},
          },
        ];
      }
      if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
      return [];
    });
    const harness = createHarness(query);
    const run = jest.fn();

    await expect(
      harness.service.executeDailyRun(
        'datagouv:daily',
        '2026-08-01',
        run,
        new Date('2026-08-01T02:05:00.000Z'),
      ),
    ).resolves.toBe('not_due');

    expect(run).not.toHaveBeenCalled();
  });

  it('does not execute an already successful daily run twice', async () => {
    const query = jest.fn(async (sql: string, _params?: unknown[]) => {
      void _params;
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (sql.includes('SELECT "status"')) {
        return [
          {
            status: 'succeeded',
            attempt: 1,
            startedAt: '2026-08-01T02:00:00Z',
            retryAfter: null,
            metadata: {},
          },
        ];
      }
      if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
      return [];
    });
    const harness = createHarness(query);
    const run = jest.fn();

    await expect(
      harness.service.executeDailyRun(
        'compute:national-daily',
        '2026-08-01',
        run,
      ),
    ).resolves.toBe('already_succeeded');

    expect(run).not.toHaveBeenCalled();
  });

  it('reruns a successful daily job when its source identity changed', async () => {
    const query = jest.fn(async (sql: string, _params?: unknown[]) => {
      void _params;
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (sql.includes('SELECT "status"')) {
        return [
          {
            status: 'succeeded',
            attempt: 1,
            startedAt: '2026-08-01T02:00:00Z',
            retryAfter: null,
            metadata: {
              sourceRevision: '41',
              publicationId: 'publication-old',
            },
          },
        ];
      }
      if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
      return [];
    });
    const harness = createHarness(query);
    const run = jest.fn().mockResolvedValue({
      sourceRevision: '42',
      publicationId: 'publication-new',
    });

    await expect(
      harness.service.executeDailyRun(
        'compute:national-daily',
        '2026-08-01',
        run,
        new Date('2026-08-01T03:00:00Z'),
        { identity: { sourceRevision: '42' } },
      ),
    ).resolves.toBe('succeeded');

    expect(run).toHaveBeenCalledTimes(1);
    const successUpdate = query.mock.calls.find(([sql]) =>
      sql.includes('SET "status" = \'succeeded\''),
    );
    expect(JSON.parse(successUpdate?.[1]?.[3] as string)).toEqual({
      sourceRevision: '42',
      publicationId: 'publication-new',
    });
  });

  it('reruns a versioned success when legacy publication resumes the same day', async () => {
    const query = jest.fn(async (sql: string, _params?: unknown[]) => {
      void _params;
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (sql.includes('SELECT "status"')) {
        return [
          {
            status: 'succeeded',
            attempt: 1,
            startedAt: '2026-08-01T06:00:00Z',
            retryAfter: null,
            metadata: {
              publicationId: 'publication-versioned',
              sourceRevision: '42',
              materializationVersion: 3,
            },
          },
        ];
      }
      if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
      return [];
    });
    const harness = createHarness(query);
    const run = jest.fn().mockResolvedValue(undefined);

    await expect(
      harness.service.executeDailyRun(
        'datagouv:daily',
        '2026-08-01',
        run,
        new Date('2026-08-01T07:00:00Z'),
        { identity: { publicationMode: 'legacy' } },
      ),
    ).resolves.toBe('succeeded');

    expect(run).toHaveBeenCalledTimes(1);
    const successUpdate = query.mock.calls.find(([sql]) =>
      sql.includes('SET "status" = \'succeeded\''),
    );
    expect(JSON.parse(successUpdate?.[1]?.[3] as string)).toEqual({
      publicationMode: 'legacy',
    });
  });

  it('reruns a historic success after an equal-date generation invalidation', async () => {
    const query = jest.fn(async (sql: string, _params?: unknown[]) => {
      void _params;
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (sql.includes('SELECT "status"')) {
        return [
          {
            status: 'succeeded',
            attempt: 1,
            startedAt: '2026-08-01T02:00:00Z',
            retryAfter: null,
            metadata: {
              sourceRevision: '42',
              materializationVersion: 3,
              historicMapCursor: '2026-07-31',
              historicStatsCursor: '2026-07-31',
              historicMapGeneration: '12',
              historicStatsGeneration: '18',
            },
          },
        ];
      }
      if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
      return [];
    });
    const harness = createHarness(query);
    const run = jest.fn().mockResolvedValue({
      historicMapCursor: '2026-07-31',
      historicStatsCursor: '2026-07-31',
      historicMapGeneration: '14',
      historicStatsGeneration: '19',
    });

    await expect(
      harness.service.executeDailyRun(
        'compute:historic-catchup',
        '2026-08-01',
        run,
        new Date('2026-08-01T03:00:00Z'),
        {
          identity: {
            sourceRevision: '42',
            materializationVersion: 3,
            historicMapCursor: '2026-07-31',
            historicStatsCursor: '2026-07-31',
            historicMapGeneration: '13',
            historicStatsGeneration: '18',
          },
        },
      ),
    ).resolves.toBe('succeeded');

    expect(run).toHaveBeenCalledTimes(1);
    const successUpdate = query.mock.calls.find(([sql]) =>
      sql.includes('SET "status" = \'succeeded\''),
    );
    expect(JSON.parse(successUpdate?.[1]?.[3] as string)).toEqual({
      sourceRevision: '42',
      materializationVersion: 3,
      historicMapCursor: '2026-07-31',
      historicStatsCursor: '2026-07-31',
      historicMapGeneration: '14',
      historicStatsGeneration: '19',
    });
  });

  it('reruns a successful compute job from an older materialization version', async () => {
    const query = jest.fn(async (sql: string, _params?: unknown[]) => {
      void _params;
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (sql.includes('SELECT "status"')) {
        return [
          {
            status: 'succeeded',
            attempt: 1,
            startedAt: '2026-08-01T02:00:00Z',
            retryAfter: null,
            metadata: {
              sourceRevision: '42',
              materializationVersion: 2,
              publicationId: 'publication-v2',
            },
          },
        ];
      }
      if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
      return [];
    });
    const harness = createHarness(query);
    const run = jest.fn().mockResolvedValue({
      sourceRevision: '42',
      materializationVersion: 3,
      publicationId: 'publication-v3',
    });

    await expect(
      harness.service.executeDailyRun(
        'compute:national-daily',
        '2026-08-01',
        run,
        new Date('2026-08-01T03:00:00Z'),
        {
          identity: { sourceRevision: '42', materializationVersion: 3 },
        },
      ),
    ).resolves.toBe('succeeded');

    expect(run).toHaveBeenCalledTimes(1);
    const successUpdate = query.mock.calls.find(([sql]) =>
      sql.includes('SET "status" = \'succeeded\''),
    );
    expect(JSON.parse(successUpdate?.[1]?.[3] as string)).toEqual({
      sourceRevision: '42',
      materializationVersion: 3,
      publicationId: 'publication-v3',
    });
  });

  it('records the revision captured by the job after its source transitions', async () => {
    const query = jest.fn(async (sql: string, _params?: unknown[]) => {
      void _params;
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (sql.includes('SELECT "status"')) return [];
      if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
      return [];
    });
    const harness = createHarness(query);

    await harness.service.executeDailyRun(
      'compute:national-daily',
      '2026-08-01',
      async () => ({
        publicationId: 'publication-1',
        sourceRevision: '42',
      }),
      new Date('2026-08-01T02:00:00Z'),
      { identity: { sourceRevision: '41' } },
    );

    const successUpdate = query.mock.calls.find(([sql]) =>
      sql.includes('SET "status" = \'succeeded\''),
    );
    expect(JSON.parse(successUpdate?.[1]?.[3] as string)).toEqual({
      sourceRevision: '42',
      publicationId: 'publication-1',
    });
  });

  it('persists failures with a retry date and rethrows the original error', async () => {
    const query = jest.fn(async (sql: string, _params?: unknown[]) => {
      void _params;
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (sql.includes('SELECT "status"')) return [];
      if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
      return [];
    });
    const harness = createHarness(query);

    await expect(
      harness.service.executeDailyRun(
        'datagouv:daily',
        '2026-08-01',
        async () => {
          throw new Error('remote unavailable');
        },
        new Date('2026-08-01T06:00:00Z'),
      ),
    ).rejects.toThrow('remote unavailable');

    const failureUpdate = query.mock.calls.find(([sql]) =>
      sql.includes('SET "status" = \'failed\''),
    );
    expect(failureUpdate).toBeDefined();
    expect(failureUpdate?.[1]?.[4]).toBe('remote unavailable');
  });

  it('keeps retrying after the eighth failed attempt once backoff elapsed', async () => {
    const query = jest.fn(async (sql: string, _params?: unknown[]) => {
      void _params;
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (sql.includes('SELECT "status"')) {
        return [
          {
            status: 'failed',
            attempt: 8,
            startedAt: '2026-08-01T06:00:00.000Z',
            retryAfter: '2026-08-01T07:00:00.000Z',
            metadata: {},
          },
        ];
      }
      if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
      return [];
    });
    const harness = createHarness(query);
    const run = jest.fn().mockResolvedValue(undefined);

    await expect(
      harness.service.executeDailyRun(
        'datagouv:daily',
        '2026-08-01',
        run,
        new Date('2026-08-01T07:00:01.000Z'),
      ),
    ).resolves.toBe('succeeded');

    expect(run).toHaveBeenCalledTimes(1);
    expect(
      query.mock.calls.find(([sql]) =>
        sql.includes('INSERT INTO "external_publication_run"'),
      )?.[1]?.[2],
    ).toBe(9);
  });

  it('does not apply an old identity backoff to a new publication', async () => {
    const query = jest.fn(async (sql: string, _params?: unknown[]) => {
      void _params;
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (sql.includes('SELECT "status"')) {
        return [
          {
            status: 'failed',
            attempt: 3,
            startedAt: '2026-08-01T06:00:00.000Z',
            retryAfter: '2026-08-01T07:00:00.000Z',
            metadata: {
              publicationId: 'publication-old',
              sourceRevision: '41',
            },
          },
        ];
      }
      if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
      return [];
    });
    const harness = createHarness(query);
    const run = jest.fn().mockResolvedValue(undefined);

    await expect(
      harness.service.executeDailyRun(
        'datagouv:daily',
        '2026-08-01',
        run,
        new Date('2026-08-01T06:05:00.000Z'),
        {
          identity: {
            publicationId: 'publication-new',
            sourceRevision: '42',
          },
        },
      ),
    ).resolves.toBe('succeeded');

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('uses the persisted resource identifier when no environment override exists', async () => {
    const harness = createHarness(jest.fn());
    harness.dataSource.query.mockResolvedValue([
      { remoteResourceId: 'persisted-resource-id' },
    ]);

    await expect(
      harness.service.resolveResourceId('communes_2026', 'data.gouv.fr'),
    ).resolves.toBe('persisted-resource-id');
  });

  it('checks the persisted success barrier for a daily job', async () => {
    const harness = createHarness(jest.fn());
    harness.dataSource.query
      .mockResolvedValueOnce([{ '?column?': 1 }])
      .mockResolvedValueOnce([]);

    await expect(
      harness.service.hasSucceeded('compute:national-daily', '2026-08-01', {
        sourceRevision: '42',
        publicationId: 'publication-1',
      }),
    ).resolves.toBe(true);
    await expect(
      harness.service.hasSucceeded('compute:national-daily', '2026-08-02'),
    ).resolves.toBe(false);
    expect(harness.dataSource.query.mock.calls[0][1][2]).toBe(
      JSON.stringify({
        sourceRevision: '42',
        publicationId: 'publication-1',
      }),
    );
  });

  it('reads the metadata of a successful run', async () => {
    const harness = createHarness(jest.fn());
    harness.dataSource.query.mockResolvedValueOnce([
      {
        metadata: JSON.stringify({
          sourceRevision: '42',
          publicationId: 'publication-1',
        }),
      },
    ]);

    await expect(
      harness.service.getSucceededRunMetadata(
        'compute:national-daily',
        '2026-08-01',
      ),
    ).resolves.toEqual({
      sourceRevision: '42',
      publicationId: 'publication-1',
    });
  });

  it('exposes an error-free degraded health summary', async () => {
    const harness = createHarness(jest.fn());
    harness.dataSource.query
      .mockResolvedValueOnce([
        {
          scheduledFor: '2026-08-01',
          status: 'failed',
          attempt: 2,
          finishedAt: '2026-08-01T06:10:00Z',
          error: 'must not be exposed',
        },
      ])
      .mockResolvedValueOnce([
        {
          lastSuccessAt: '2026-08-01T06:00:00Z',
          lastFailureAt: '2026-08-01T06:10:00Z',
        },
      ])
      .mockResolvedValueOnce([{ failedResourceCount: '1' }]);

    const health = await harness.service.getHealthStatus(
      new Date('2026-08-01T07:00:00Z'),
    );

    expect(health).toEqual({
      status: 'degraded',
      lastRun: {
        scheduledFor: '2026-08-01',
        status: 'failed',
        attempt: 2,
        finishedAt: '2026-08-01T06:10:00.000Z',
      },
      lastSuccessAt: '2026-08-01T06:00:00.000Z',
      lastFailureAt: '2026-08-01T06:10:00.000Z',
      successAgeSeconds: 3600,
      failedResourceCount: 1,
    });
    expect(JSON.stringify(health)).not.toContain('must not be exposed');
  });

  it('marks a daily publication older than thirty hours as stale', async () => {
    const harness = createHarness(jest.fn());
    harness.dataSource.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          lastSuccessAt: '2026-07-30T06:00:00Z',
          lastFailureAt: null,
        },
      ])
      .mockResolvedValueOnce([{ failedResourceCount: '0' }]);

    const health = await harness.service.getHealthStatus(
      new Date('2026-08-01T13:00:00Z'),
    );

    expect(health.status).toBe('stale');
    expect(health.successAgeSeconds).toBe(55 * 60 * 60);
  });
});
