import { HistoricBackfillArtifactQueueService } from './historic-backfill-artifact-queue.service';

describe('HistoricBackfillArtifactQueueService', () => {
  const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const reconcileStaleRuns = jest.fn();
  const createService = (dataSource: unknown) =>
    new HistoricBackfillArtifactQueueService(
      dataSource as any,
      {
        reconcileStaleRuns,
      } as any,
    );
  const lease = {
    runId,
    validFrom: '2011-06-07',
    validThrough: '2011-06-09',
    sourceRevision: '168348',
    historicComputeEpoch: '462',
    workerId: 'artifact-worker',
    leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    leaseExpiresAt: new Date(Date.now() + 60_000),
    attemptCount: 1,
  };

  beforeEach(() => {
    reconcileStaleRuns.mockReset().mockResolvedValue(undefined);
  });

  it('creates contiguous national artifact ranges after all departments complete', async () => {
    const statements: string[] = [];
    const manager = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('run."mapDateFrom"')) {
          return [
            {
              status: 'running',
              mapDateFrom: '2011-06-07',
              dateThrough: '2026-08-16',
              sourceRevision: '168348',
              currentSourceRevision: '168348',
              historicComputeEpoch: '462',
              currentEpoch: '462',
              historicBackfillGlobalEpoch: '12',
              currentGlobalEpoch: '12',
            },
          ];
        }
        if (sql.includes('AS "taskCount"')) {
          return [{ taskCount: 101, completedCount: 101 }];
        }
        if (sql.includes('AS "queueCount"')) {
          return [{ queueCount: 0, snapshotCount: 0, dailyRunCount: 0 }];
        }
        if (sql.includes('AS "departmentCount"')) {
          return [{ departmentCount: 101 }];
        }
        if (sql.includes('FROM ordered')) {
          return [];
        }
        if (sql.includes('AS count')) {
          return [{ count: 2587 }];
        }
        return [];
      }),
    };
    const dataSource = {
      transaction: jest.fn(async (_level, callback) => callback(manager)),
    };
    const service = createService(dataSource);

    await expect(service.prepare(runId)).resolves.toEqual({ taskCount: 2587 });

    const sql = statements.join('\n');
    expect(sql).toContain('COUNT(DISTINCT "departementId")');
    expect(sql).toContain('lead(boundary."validFrom")');
    expect(sql).toContain('previous_through + 1');
    expect(sql).toContain('task."sourceRevision" = $3::bigint');
    expect(sql).toContain('ON CONFLICT ("runId", "validFrom") DO NOTHING');
    expect(sql).toContain('FROM "external_publication_run"');
    expect(sql).toContain('"jobKey" = \'compute:national-daily\'');
    expect(sql).toContain('"status" = \'running\'');
    expect(sql).toContain('run."historicBackfillGlobalEpoch"::text');
    expect(sql).toContain(
      'config."historicBackfillGlobalEpoch"::text AS "currentGlobalEpoch"',
    );
    expect(reconcileStaleRuns).toHaveBeenCalledTimes(1);
  });

  it('refuses artifact preparation when the global epoch changed', async () => {
    const manager = {
      query: jest.fn(async (sql: string) => {
        if (
          sql.includes('pg_advisory_xact_lock') ||
          sql.includes('SET LOCAL')
        ) {
          return [];
        }
        return [
          {
            status: 'running',
            mapDateFrom: '2011-06-07',
            dateThrough: '2026-08-16',
            sourceRevision: '168348',
            currentSourceRevision: '168348',
            historicComputeEpoch: '462',
            currentEpoch: '462',
            historicBackfillGlobalEpoch: '12',
            currentGlobalEpoch: '13',
          },
        ];
      }),
    };
    const service = createService({
      transaction: jest.fn(async (_level, callback) => callback(manager)),
    });

    await expect(service.prepare(runId)).rejects.toThrow(
      'Historic backfill global epoch changed',
    );
    expect(manager.query).toHaveBeenCalledTimes(3);
  });

  it('refuses artifact preparation while the national daily run is active', async () => {
    const manager = {
      query: jest.fn(async (sql: string) => {
        if (
          sql.includes('pg_advisory_xact_lock') ||
          sql.includes('SET LOCAL')
        ) {
          return [];
        }
        if (sql.includes('run."mapDateFrom"')) {
          return [
            {
              status: 'running',
              mapDateFrom: '2011-06-07',
              dateThrough: '2026-08-16',
              sourceRevision: '168348',
              currentSourceRevision: '168348',
              historicComputeEpoch: '462',
              currentEpoch: '462',
              historicBackfillGlobalEpoch: '12',
              currentGlobalEpoch: '12',
            },
          ];
        }
        if (sql.includes('AS "taskCount"')) {
          return [{ taskCount: 101, completedCount: 101 }];
        }
        if (sql.includes('AS "queueCount"')) {
          return [{ queueCount: 0, snapshotCount: 0, dailyRunCount: 1 }];
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    const service = createService({
      transaction: jest.fn(async (_level, callback) => callback(manager)),
    });

    await expect(service.prepare(runId)).rejects.toThrow(
      'Current computation has priority over historic artifacts',
    );
  });

  it('claims with SKIP LOCKED and an anti-ABA token', async () => {
    const manager = {
      query: jest.fn().mockResolvedValue([
        [
          {
            ...lease,
            attemptCount: '1',
          },
        ],
        1,
      ]),
    };
    const dataSource = {
      transaction: jest.fn(async (_level, callback) => callback(manager)),
    };
    const service = createService(dataSource);

    await expect(service.claim(runId, 'worker', 300, 5)).resolves.toEqual(
      expect.objectContaining({ attemptCount: 1, validFrom: lease.validFrom }),
    );
    const sql = manager.query.mock.calls[0][0];
    expect(sql).toContain('FOR UPDATE OF task SKIP LOCKED');
    expect(sql).toContain('"leaseToken" = $3');
    expect(sql).toContain('task."sourceRevision" = source."publicRevision"');
    expect(sql).toContain('request."currentPending"');
    expect(sql).toContain('request."pendingScheduledDates"');
    expect(sql).toContain("AT TIME ZONE 'Europe/Paris'");
    expect(sql).toContain('FROM "external_publication_run" daily_run');
    expect(sql).toContain('daily_run."jobKey" = \'compute:national-daily\'');
    expect(sql).toContain('daily_run."status" = \'running\'');
    expect(sql).toContain('task."attemptCount" < $5::integer');
    expect(
      sql.match(
        /run\."historicBackfillGlobalEpoch"\s*=\s*config\."historicBackfillGlobalEpoch"/g,
      ),
    ).toHaveLength(2);
    expect(manager.query.mock.calls[0][1][4]).toBe(5);
    expect(reconcileStaleRuns).toHaveBeenCalledTimes(1);
  });

  it('terminalizes an artifact and its run after repeated lease expirations', async () => {
    const manager = {
      query: jest.fn().mockResolvedValue([[], 0]),
    };
    const service = createService({
      transaction: jest.fn(async (_level, callback) => callback(manager)),
    });

    await expect(service.claim(runId, 'worker', 300, 2)).resolves.toBeNull();

    const [sql, parameters] = manager.query.mock.calls[0];
    expect(sql.indexOf('exhausted_candidate AS MATERIALIZED')).toBeLessThan(
      sql.indexOf('candidate AS MATERIALIZED'),
    );
    expect(sql).toContain('task."attemptCount" >= $5::integer');
    expect(sql).toContain('"status" = \'failed\'');
    expect(sql).toContain('Maximum historic artifact attempts exhausted');
    expect(sql).toContain('At least one artifact exhausted its attempts');
    expect(sql).toContain('SELECT 1 FROM failed_runs');
    expect(parameters.slice(3)).toEqual([300, 2]);
  });

  it('completes only the unexpired matching lease', async () => {
    const query = jest
      .fn()
      .mockResolvedValue([[{ validFrom: lease.validFrom }], 1]);
    const service = createService({ query });

    await expect(
      service.complete(lease, {
        geojsonObjectKey: 'historic/run/date.geojson',
        geojsonChecksum: 'a'.repeat(64),
        pmtilesObjectKey: 'historic/run/date.pmtiles',
        pmtilesChecksum: 'b'.repeat(64),
        featureCount: 12,
      }),
    ).resolves.toBe(true);

    expect(query.mock.calls[0][0]).toContain('"leaseToken" = $4');
    expect(query.mock.calls[0][0]).toContain('"leaseExpiresAt" > now()');
    expect(query.mock.calls[0][0]).toContain(
      'task."sourceRevision" = $10::bigint',
    );
    expect(query.mock.calls[0][0]).toContain('"status" = \'completed\'');
    expect(query.mock.calls[0][0]).toMatch(
      /run\."historicBackfillGlobalEpoch"\s*=\s*config\."historicBackfillGlobalEpoch"/,
    );
  });

  it('fences runnable lookup, heartbeat, and segment reads on the global epoch', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ runId }])
      .mockResolvedValueOnce([[{ validFrom: lease.validFrom }], 1])
      .mockResolvedValueOnce([]);
    const service = createService({ query });

    await expect(service.findRunnableRunId()).resolves.toBe(runId);
    expect(reconcileStaleRuns).toHaveBeenCalledTimes(1);
    await expect(service.heartbeat(lease, 300)).resolves.toBe(true);
    await expect(
      service.getOutputSegments({ query } as any, lease),
    ).resolves.toEqual([]);

    for (const [sql] of query.mock.calls) {
      expect(String(sql)).toMatch(
        /run\."historicBackfillGlobalEpoch"\s*=\s*config\."historicBackfillGlobalEpoch"/,
      );
    }
  });

  it('yields without consuming an attempt', async () => {
    const query = jest
      .fn()
      .mockResolvedValue([[{ validFrom: lease.validFrom }], 1]);
    const service = createService({ query });

    await expect(service.yieldTask(lease, 15)).resolves.toBe(true);
    expect(query.mock.calls[0][0]).toContain(
      '"attemptCount" = GREATEST("attemptCount" - 1, 0)',
    );
  });
});
