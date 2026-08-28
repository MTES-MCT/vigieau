import {
  HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT,
  HistoricBackfillQueueService,
  HistoricBackfillStateError,
  HistoricBackfillValidationError,
  validateHistoricBackfillRange,
} from './historic-backfill-queue.service';
import { HISTORIC_MUTABLE_GEOMETRY_REPLAY_ENABLED_ENV } from '../core/historic-geometry-replay';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const LEASE_TOKEN = '22222222-2222-4222-8222-222222222222';
const OUTPUT_SIGNATURE = 'a'.repeat(64);
const NOW = new Date('2026-08-19T10:00:00.000Z');
const previousMutableGeometryReplayEnabled =
  process.env[HISTORIC_MUTABLE_GEOMETRY_REPLAY_ENABLED_ENV];

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    status: 'running',
    mapDateFrom: '2012-01-01',
    statisticDateFrom: '2019-01-01',
    dateThrough: '2026-08-18',
    sourceRevision: '42',
    historicComputeEpoch: '7',
    historicBackfillGlobalEpoch: '0',
    baseStatisticRevision: '12',
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    pausedAt: null,
    completedAt: null,
    lastError: null,
    ...overrides,
  };
}

function historicContext(overrides: Record<string, unknown> = {}) {
  return {
    sourceRevision: '42',
    legacyDualWrite: false,
    historicComputeEpoch: '7',
    historicBackfillGlobalEpoch: '0',
    baseStatisticRevision: '12',
    computeMapDate: '2012-01-01',
    computeStatsDate: '2019-01-01',
    currentPublishedDate: '2026-08-19',
    historicDirtyFrom: '2019-01-01',
    historicDirtyThrough: '2026-08-18',
    ...overrides,
  };
}

function lease() {
  return {
    runId: RUN_ID,
    departementId: 75,
    workerId: 'worker-1',
    leaseToken: LEASE_TOKEN,
  };
}

function transactionalDataSource(query: jest.Mock) {
  const manager = { query };
  return {
    query,
    transaction: jest.fn(
      async (_isolation: string, operation: (value: any) => unknown) =>
        operation(manager),
    ),
  };
}

describe('validateHistoricBackfillRange', () => {
  it('accepts independent map/statistic starts through today', () => {
    expect(() =>
      validateHistoricBackfillRange(
        {
          mapDateFrom: '2012-01-01',
          statisticDateFrom: '2019-01-01',
          dateThrough: '2026-08-19',
        },
        '2026-08-19',
      ),
    ).not.toThrow();
  });

  it.each([
    {
      input: {
        mapDateFrom: '2026-02-30',
        statisticDateFrom: '2019-01-01',
        dateThrough: '2026-08-18',
      },
      message: 'mapDateFrom is not a valid date',
    },
    {
      input: {
        mapDateFrom: '2026-08-19',
        statisticDateFrom: '2019-01-01',
        dateThrough: '2026-08-18',
      },
      message: 'mapDateFrom must not be after dateThrough',
    },
    {
      input: {
        mapDateFrom: '2012-01-01',
        statisticDateFrom: '2026-08-19',
        dateThrough: '2026-08-18',
      },
      message: 'statisticDateFrom must not be after dateThrough',
    },
    {
      input: {
        mapDateFrom: '2012-01-01',
        statisticDateFrom: '2019-01-01',
        dateThrough: '2026-08-20',
      },
      message: 'dateThrough must not be after 2026-08-19',
    },
  ])('rejects an unsafe range: $message', ({ input, message }) => {
    expect(() => validateHistoricBackfillRange(input, '2026-08-19')).toThrow(
      message,
    );
  });
});

describe('HistoricBackfillQueueService', () => {
  beforeEach(() => {
    process.env[HISTORIC_MUTABLE_GEOMETRY_REPLAY_ENABLED_ENV] = 'true';
  });

  afterAll(() => {
    if (previousMutableGeometryReplayEnabled === undefined) {
      delete process.env[HISTORIC_MUTABLE_GEOMETRY_REPLAY_ENABLED_ENV];
    } else {
      process.env[HISTORIC_MUTABLE_GEOMETRY_REPLAY_ENABLED_ENV] =
        previousMutableGeometryReplayEnabled;
    }
  });

  it('refuses prepare and resume before querying PostgreSQL by default', async () => {
    process.env[HISTORIC_MUTABLE_GEOMETRY_REPLAY_ENABLED_ENV] = 'false';
    const dataSource = {
      query: jest.fn(),
      transaction: jest.fn(),
    };
    const service = new HistoricBackfillQueueService(dataSource as any);

    await expect(
      service.prepare({
        mapDateFrom: '2012-01-01',
        statisticDateFrom: '2019-01-01',
        dateThrough: '2026-08-18',
      }),
    ).rejects.toThrow('Historic replay from mutable geometries is disabled');
    await expect(service.resume(RUN_ID)).rejects.toThrow(
      'Historic replay from mutable geometries is disabled',
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('prepares exactly one task per department in a serializable transaction', async () => {
    const manager = {
      query: jest.fn(async (sql: string, parameters?: unknown[]) => {
        void parameters;
        if (sql.includes('SELECT\n          source."publicRevision"')) {
          return [historicContext()];
        }
        if (sql.includes('FROM "historic_backfill_run"')) {
          return [];
        }
        if (sql.includes('AS "currentQueueCount"')) {
          return [
            {
              currentQueueCount: 0,
              departmentCount: HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT,
            },
          ];
        }
        if (sql.includes('RETURNING "departementId"')) {
          return Array.from(
            { length: HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT },
            (_, departementId) => ({ departementId: departementId + 1 }),
          );
        }
        if (sql.includes('RETURNING\n              "id", "status"')) {
          return [runRow()];
        }
        return [];
      }),
    };
    const dataSource = {
      transaction: jest.fn(
        async (_isolation: string, operation: (value: any) => unknown) =>
          operation(manager),
      ),
    };
    const service = new HistoricBackfillQueueService(dataSource as any);

    await expect(
      service.prepare({
        mapDateFrom: '2012-01-01',
        statisticDateFrom: '2019-01-01',
        dateThrough: '2026-08-18',
      }),
    ).resolves.toEqual(runRow());

    expect(dataSource.transaction).toHaveBeenCalledWith(
      'SERIALIZABLE',
      expect.any(Function),
    );
    const sql = manager.query.mock.calls.map(([query]) => query).join('\n');
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain(
      'LOCK TABLE "current_zone_recompute_request" IN SHARE MODE NOWAIT',
    );
    expect(sql).toContain('FOR UPDATE OF source, config, statistic_state');
    expect(sql).toContain(
      'INSERT INTO "historic_backfill_department_revision"',
    );
    expect(sql).toContain('INSERT INTO "historic_backfill_task"');
    expect(sql).toContain('"baseStatisticRevision", "statisticsPromotedAt",');
    expect(sql).toContain('$8::bigint,\n            NULL, now(), now()');
    expect(sql).toContain('revision."generation"');
    expect(sql).toContain('"status" = \'running\'');
    expect(sql).not.toContain('UPDATE "statistic_publication_state"');
    const statements = manager.query.mock.calls.map(([query]) => query);
    expect(
      statements.findIndex((query) =>
        query.includes('source."publicRevision"'),
      ),
    ).toBeLessThan(
      statements.findIndex((query) =>
        query.includes('LOCK TABLE "current_zone_recompute_request"'),
      ),
    );
  });

  it('recreates the complete statistic debt after completion and invalidation', async () => {
    const preparedRun = runRow({
      mapDateFrom: '2024-04-29',
      statisticDateFrom: '2024-04-29',
      dateThrough: '2024-05-02',
      baseStatisticRevision: '13',
    });
    const manager = {
      query: jest.fn(async (sql: string, parameters?: unknown[]) => {
        void parameters;
        if (sql.includes('SELECT\n          source."publicRevision"')) {
          return [
            historicContext({
              computeMapDate: '2024-05-01',
              computeStatsDate: '2024-05-01',
              currentPublishedDate: '2024-05-03',
              historicDirtyFrom: null,
              historicDirtyThrough: null,
            }),
          ];
        }
        if (sql.includes('UPDATE "statistic_publication_state"')) {
          return [{ revision: '13' }];
        }
        if (sql.includes('FROM "historic_backfill_run"')) {
          return [];
        }
        if (sql.includes('AS "currentQueueCount"')) {
          return [
            {
              currentQueueCount: 0,
              departmentCount: HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT,
            },
          ];
        }
        if (sql.includes('RETURNING "departementId"')) {
          return Array.from(
            { length: HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT },
            (_, departementId) => ({ departementId: departementId + 1 }),
          );
        }
        if (sql.includes('RETURNING\n              "id", "status"')) {
          return [preparedRun];
        }
        return [];
      }),
    };
    const dataSource = transactionalDataSource(manager.query);
    const service = new HistoricBackfillQueueService(dataSource as any);

    await expect(
      service.prepare({
        mapDateFrom: '2024-04-29',
        statisticDateFrom: '2024-04-29',
        dateThrough: '2024-05-02',
      }),
    ).resolves.toEqual(preparedRun);

    const debtUpdate = manager.query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE "statistic_publication_state"'),
    );
    expect(debtUpdate?.[1]).toEqual(['2024-05-01', '2024-05-02', '12']);
    const runInsert = manager.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO "historic_backfill_run"'),
    );
    expect(runInsert?.[1]?.[7]).toBe('13');
  });

  it('refuses a run that does not cover the complete statistic debt', async () => {
    const manager = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('source."publicRevision"')) {
          return [
            historicContext({
              computeMapDate: '2024-05-01',
              computeStatsDate: '2024-05-01',
              currentPublishedDate: '2024-05-03',
              historicDirtyFrom: null,
              historicDirtyThrough: null,
            }),
          ];
        }
        return [];
      }),
    };
    const dataSource = transactionalDataSource(manager.query);

    await expect(
      new HistoricBackfillQueueService(dataSource as any).prepare({
        mapDateFrom: '2024-04-29',
        statisticDateFrom: '2024-04-29',
        dateThrough: '2024-05-01',
      }),
    ).rejects.toThrow(
      'does not cover the required statistic range 2024-05-01 through 2024-05-02',
    );
    expect(
      manager.query.mock.calls.some(([sql]) =>
        sql.includes('INSERT INTO "historic_backfill_run"'),
      ),
    ).toBe(false);
  });

  it('refuses preparation while another unfinished run exists', async () => {
    const manager = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('source."publicRevision"')) {
          return [historicContext()];
        }
        if (sql.includes('FROM "historic_backfill_run"')) {
          return [{ id: RUN_ID }];
        }
        return [];
      }),
    };
    const dataSource = {
      transaction: jest.fn(
        async (_isolation: string, operation: (value: any) => unknown) =>
          operation(manager),
      ),
    };

    await expect(
      new HistoricBackfillQueueService(dataSource as any).prepare({
        mapDateFrom: '2012-01-01',
        statisticDateFrom: '2019-01-01',
        dateThrough: '2026-08-18',
      }),
    ).rejects.toThrow(HistoricBackfillStateError);
  });

  it.each([
    {
      queue: 1,
      departments: HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT,
      message: 'Current zone recomputation queue is not empty',
    },
    {
      queue: 0,
      departments: HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT - 1,
      message: 'Expected 101 departments',
    },
  ])(
    'refuses an incomplete preparation context: $message',
    async ({ queue, departments, message }) => {
      const manager = {
        query: jest.fn(async (sql: string) => {
          if (sql.includes('source."publicRevision"')) {
            return [historicContext()];
          }
          if (sql.includes('FROM "historic_backfill_run"')) {
            return [];
          }
          if (sql.includes('AS "currentQueueCount"')) {
            return [
              {
                currentQueueCount: queue,
                departmentCount: departments,
              },
            ];
          }
          return [];
        }),
      };
      const dataSource = {
        transaction: jest.fn(
          async (_isolation: string, operation: (value: any) => unknown) =>
            operation(manager),
        ),
      };

      await expect(
        new HistoricBackfillQueueService(dataSource as any).prepare({
          mapDateFrom: '2012-01-01',
          statisticDateFrom: '2019-01-01',
          dateThrough: '2026-08-18',
        }),
      ).rejects.toThrow(message);
    },
  );

  it('requires statistics promotion for map finalization readiness', async () => {
    const statusRow = {
      ...runRow(),
      historicComputeEpochCurrent: true,
      historicBackfillGlobalEpochCurrent: true,
      statisticsPromotedAt: NOW as Date | null,
      total: '101',
      pending: '0',
      leased: '0',
      completed: '101',
      failed: '0',
      expiredLeases: '0',
      staleGenerations: '0',
      processedSegments: '12345',
      processedCommunes: '34935',
      earliestProgressDate: '2026-08-18',
      latestProgressDate: '2026-08-18',
      latestHeartbeatAt: NOW,
      nextAttemptAt: null,
      artifactTotal: '2',
      artifactPending: '0',
      artifactLeased: '0',
      artifactCompleted: '2',
      artifactFailed: '0',
      artifactExpiredLeases: '0',
      artifactStaleContext: '0',
      artifactCoverageFrom: '2012-01-01',
      artifactCoverageThrough: '2026-08-18',
      artifactLatestHeartbeatAt: NOW,
      artifactNextAttemptAt: null,
    };
    const query = jest.fn().mockResolvedValue([statusRow]);
    const service = new HistoricBackfillQueueService({ query } as any);

    const result = await service.status(RUN_ID);

    expect(result).toEqual({
      run: runRow(),
      tasks: {
        total: 101,
        pending: 0,
        leased: 0,
        completed: 101,
        failed: 0,
        expiredLeases: 0,
        staleGenerations: 0,
        processedSegments: 12345,
        processedCommunes: 34935,
        earliestProgressDate: '2026-08-18',
        latestProgressDate: '2026-08-18',
        latestHeartbeatAt: NOW,
        nextAttemptAt: null,
      },
      artifacts: {
        total: 2,
        pending: 0,
        leased: 0,
        completed: 2,
        failed: 0,
        expiredLeases: 0,
        staleContext: 0,
        coverageFrom: '2012-01-01',
        coverageThrough: '2026-08-18',
        latestHeartbeatAt: NOW,
        nextAttemptAt: null,
      },
      historicComputeEpochCurrent: true,
      historicBackfillGlobalEpochCurrent: true,
      readyToFinalize: true,
      readyToFinalizeMaps: true,
    });
    expect(query.mock.calls[0][0]).toContain(
      'revision."generation" IS DISTINCT FROM',
    );
    expect(query.mock.calls[0][0]).toContain('run."statisticsPromotedAt"');

    statusRow.statisticsPromotedAt = null;
    await expect(service.status(RUN_ID)).resolves.toMatchObject({
      readyToFinalize: true,
      readyToFinalizeMaps: false,
    });
  });

  it('does not finalize completed tasks whose department generation changed', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        ...runRow(),
        historicComputeEpochCurrent: true,
        historicBackfillGlobalEpochCurrent: true,
        total: 101,
        pending: 0,
        leased: 0,
        completed: 101,
        failed: 0,
        expiredLeases: 0,
        staleGenerations: 1,
        processedSegments: 12345,
        processedCommunes: 34935,
        earliestProgressDate: '2026-08-18',
        latestProgressDate: '2026-08-18',
        latestHeartbeatAt: NOW,
        nextAttemptAt: null,
        artifactTotal: '0',
        artifactPending: '0',
        artifactLeased: '0',
        artifactCompleted: '0',
        artifactFailed: '0',
        artifactExpiredLeases: '0',
        artifactStaleContext: '0',
        artifactCoverageFrom: null,
        artifactCoverageThrough: null,
        artifactLatestHeartbeatAt: null,
        artifactNextAttemptAt: null,
      },
    ]);
    const service = new HistoricBackfillQueueService({ query } as any);

    await expect(service.status(RUN_ID)).resolves.toMatchObject({
      readyToFinalize: false,
    });
  });

  it('does not finalize after the historic compute epoch changes', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        ...runRow(),
        historicComputeEpochCurrent: false,
        historicBackfillGlobalEpochCurrent: true,
        total: 101,
        pending: 0,
        leased: 0,
        completed: 101,
        failed: 0,
        expiredLeases: 0,
        staleGenerations: 0,
        processedSegments: 12345,
        processedCommunes: 34935,
        earliestProgressDate: '2026-08-18',
        latestProgressDate: '2026-08-18',
        latestHeartbeatAt: NOW,
        nextAttemptAt: null,
        artifactTotal: '0',
        artifactPending: '0',
        artifactLeased: '0',
        artifactCompleted: '0',
        artifactFailed: '0',
        artifactExpiredLeases: '0',
        artifactStaleContext: '0',
        artifactCoverageFrom: null,
        artifactCoverageThrough: null,
        artifactLatestHeartbeatAt: null,
        artifactNextAttemptAt: null,
      },
    ]);
    const service = new HistoricBackfillQueueService({ query } as any);

    await expect(service.status(RUN_ID)).resolves.toMatchObject({
      historicComputeEpochCurrent: false,
      historicBackfillGlobalEpochCurrent: true,
      readyToFinalize: false,
    });
  });

  it('does not finalize after the global historic fence changes', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        ...runRow(),
        historicComputeEpochCurrent: true,
        historicBackfillGlobalEpochCurrent: false,
        total: 101,
        pending: 0,
        leased: 0,
        completed: 101,
        failed: 0,
        expiredLeases: 0,
        staleGenerations: 0,
        processedSegments: 12345,
        processedCommunes: 34935,
        earliestProgressDate: '2026-08-18',
        latestProgressDate: '2026-08-18',
        latestHeartbeatAt: NOW,
        nextAttemptAt: null,
        artifactTotal: 0,
        artifactPending: 0,
        artifactLeased: 0,
        artifactCompleted: 0,
        artifactFailed: 0,
        artifactExpiredLeases: 0,
        artifactStaleContext: 0,
        artifactCoverageFrom: null,
        artifactCoverageThrough: null,
        artifactLatestHeartbeatAt: null,
        artifactNextAttemptAt: null,
      },
    ]);
    const service = new HistoricBackfillQueueService({ query } as any);

    await expect(service.status(RUN_ID)).resolves.toMatchObject({
      historicComputeEpochCurrent: true,
      historicBackfillGlobalEpochCurrent: false,
      readyToFinalize: false,
      readyToFinalizeMaps: false,
    });
  });

  it('claims one due task with SKIP LOCKED and a fresh anti-ABA token', async () => {
    const query = jest
      .fn()
      .mockImplementation(async (sql: string, parameters: unknown[]) =>
        sql.includes('WITH priority AS MATERIALIZED')
          ? [
              [
                {
                  runId: RUN_ID,
                  departementId: '75',
                  workerId: parameters[0],
                  leaseToken: parameters[1],
                  departementCode: '75',
                  departmentGeneration: '3',
                  departmentLastPublicRevision: '42',
                  attemptCount: '1',
                  leaseExpiresAt: NOW,
                  progressDate: null,
                  segmentCount: '0',
                  communeCount: '0',
                  artifactPrefix: null,
                  mapDateFrom: '2012-01-01',
                  statisticDateFrom: '2019-01-01',
                  dateThrough: '2026-08-18',
                  sourceRevision: '42',
                  historicComputeEpoch: '7',
                  baseStatisticRevision: '12',
                },
              ],
              1,
            ]
          : sql.includes('WITH claimed_task AS MATERIALIZED')
            ? [{ contextCount: 1, communeCount: 2, departmentCount: 1 }]
            : [],
      );
    const dataSource = transactionalDataSource(query);
    const service = new HistoricBackfillQueueService(dataSource as any);

    const result = await service.claim(' worker-1 ', 300, 5);

    expect(result).toMatchObject({
      runId: RUN_ID,
      departementId: 75,
      workerId: 'worker-1',
      duringCurrentConcurrency: 0,
      departementCode: '75',
      departmentGeneration: '3',
      attemptCount: 1,
    });
    expect(result?.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(dataSource.transaction).toHaveBeenNthCalledWith(
      1,
      'READ COMMITTED',
      expect.any(Function),
    );
    expect(dataSource.transaction).toHaveBeenNthCalledWith(
      2,
      'READ COMMITTED',
      expect.any(Function),
    );
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE OF run');
    expect(query.mock.calls[0][0]).not.toContain('CROSS JOIN "config"');
    expect(query.mock.calls[1][0]).toContain('paused_stale_runs');
    expect(query.mock.calls[1][0]).toContain(
      'FROM "historic_backfill_map_manifest_outbox" outbox',
    );
    expect(query.mock.calls[1][0]).toContain('outbox."status" = \'pending\'');
    expect(query.mock.calls[1][0]).toContain(
      'run."historicComputeEpoch" <> config."historicComputeEpoch"',
    );
    expect(query.mock.calls[1][0]).toContain(
      'task."departmentGeneration" < revision."generation"',
    );
    expect(query.mock.calls[1][0]).toContain(
      'task."departmentGeneration" > revision."generation"',
    );
    expect(query.mock.calls[1][0]).toContain('rebased_runs AS');
    expect(query.mock.calls[1][0]).toContain(
      'CROSS JOIN "statistic_publication_state" statistic_state',
    );
    expect(query.mock.calls[1][0]).toContain(
      'statistic_state."historicPublishedThrough" >=',
    );
    expect(query.mock.calls[1][0]).toContain(
      'config."computeStatsDate" >= run."dateThrough"',
    );
    const reconciledRunSql = query.mock.calls[1][0].slice(
      query.mock.calls[1][0].indexOf('rebased_runs AS'),
      query.mock.calls[1][0].indexOf('reset_departments AS MATERIALIZED'),
    );
    expect(reconciledRunSql).toContain(
      'WHEN stale."statisticsPublicationClosed"',
    );
    expect(reconciledRunSql).toContain('THEN run."statisticsPromotedAt"');
    expect(reconciledRunSql).toContain('ELSE NULL');
    expect(query.mock.calls[1][0]).toContain(
      '"historicComputeEpoch" = stale."currentEpoch"',
    );
    expect(query.mock.calls[1][0]).toContain(
      '"sourceRevision" = stale."currentSourceRevision"',
    );
    expect(query.mock.calls[1][0]).toContain(
      'task."status" <> \'completed\'\n            OR task."departmentGeneration" <> revision."generation"',
    );
    expect(query.mock.calls[1][0]).toContain(
      'DELETE FROM "historic_backfill_artifact_task"',
    );
    expect(query.mock.calls[1][0]).toContain(
      'stale."currentEpoch" > stale."previousEpoch"',
    );
    expect(query.mock.calls[1][0]).toContain(
      'stale."previousGlobalEpoch" = stale."currentGlobalEpoch"',
    );
    expect(query.mock.calls[1][0]).toContain(
      'NOT stale."hasRegressedDepartmentGeneration"',
    );
    expect(query.mock.calls[1][0]).toContain('"leaseToken" = NULL');
    expect(query.mock.calls[2][0]).toContain('FOR SHARE OF run');
    const [sql, parameters] = query.mock.calls[3];
    expect(sql.trimStart()).toMatch(/^WITH priority AS MATERIALIZED/);
    const prioritySql = sql.slice(
      sql.indexOf('WITH priority AS MATERIALIZED'),
      sql.indexOf('exhausted_candidate AS MATERIALIZED'),
    );
    expect(prioritySql).toContain('request."currentPending"');
    expect(prioritySql).toContain('request."pendingScheduledDates"');
    expect(prioritySql).toContain('request."nextAttemptAt" <= now()');
    expect(prioritySql).toContain(
      'daily_run."jobKey" = \'compute:national-daily\'',
    );
    expect(prioritySql).toContain('daily_run."status" = \'running\'');
    expect(prioritySql).toContain('FROM "statistic_commune_snapshot" snapshot');
    expect(prioritySql).toContain('snapshot."status" = \'running\'');
    expect(prioritySql).toContain('AS "activeHistoricLeaseCount"');
    const exhaustedCandidateSql = sql.slice(
      sql.indexOf('exhausted_candidate AS MATERIALIZED'),
      sql.indexOf('exhausted AS'),
    );
    expect(exhaustedCandidateSql).toContain(
      'FROM "historic_backfill_map_manifest_outbox" outbox',
    );
    expect(exhaustedCandidateSql).toContain('outbox."status" = \'pending\'');
    expect(sql).toContain('FOR UPDATE OF task SKIP LOCKED');
    expect(sql).toContain('task."leaseExpiresAt" <= now()');
    const candidateSql = sql.slice(
      sql.indexOf('candidate AS MATERIALIZED'),
      sql.indexOf('purged_stale_commune_segments'),
    );
    expect(candidateSql).toContain('task."status" = \'completed\'');
    expect(candidateSql).toContain(
      'task."departmentGeneration" <> revision."generation"',
    );
    expect(candidateSql).toContain(
      'priority."activeHistoricLeaseCount" >= $5::integer',
    );
    expect(candidateSql).toContain('priority."hardBlockActive"');
    expect(candidateSql).toContain(
      'FROM "historic_backfill_map_manifest_outbox" outbox',
    );
    expect(candidateSql).toContain('outbox."status" = \'pending\'');
    expect(sql).toContain('purged_stale_commune_segments');
    expect(sql).toContain('purged_stale_department_segments');
    expect(sql).toContain('purged_stale_commune_shadow');
    expect(sql).toContain('rebased_run AS');
    expect(sql).toContain('"sourceRevision" = GREATEST(');
    const rebasedRunSql = sql.slice(
      sql.indexOf('rebased_run AS'),
      sql.indexOf('claimed AS'),
    );
    expect(sql).toContain(
      'CROSS JOIN "statistic_publication_state" statistic_state',
    );
    expect(sql).toContain('statistic_state."historicDirtyFrom" IS NULL');
    expect(sql).toContain('statistic_state."historicDirtyThrough" IS NULL');
    expect(sql).toContain('statistic_state."historicPublishedThrough" >=');
    expect(sql).toContain('config."computeStatsDate" >= run."dateThrough"');
    expect(rebasedRunSql).toContain(
      'WHEN candidate."statisticsPublicationClosed"',
    );
    expect(rebasedRunSql).toContain('THEN run."statisticsPromotedAt"');
    expect(rebasedRunSql).toContain('ELSE NULL');
    expect(sql).toContain('candidate."currentGeneration"');
    expect(sql).toContain(
      'run."historicComputeEpoch" = config."historicComputeEpoch"',
    );
    expect(sql).toContain('"status" = \'failed\'');
    expect(parameters).toEqual([
      'worker-1',
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      300,
      5,
      0,
    ]);
    const [cleanupSql, cleanupParameters] = query.mock.calls[4];
    expect(cleanupSql).toContain('WITH claimed_task AS MATERIALIZED');
    expect(cleanupSql).toContain('FOR UPDATE OF task');
    expect(cleanupSql).toContain(
      'DELETE FROM "historic_backfill_commune_segment"',
    );
    expect(cleanupSql).toContain(
      'DELETE FROM "historic_backfill_department_segment"',
    );
    expect(cleanupSql).toContain('task."progressDate" IS NULL');
    expect(cleanupSql).toContain(
      'segment."validThrough" > task."progressDate"',
    );
    expect(cleanupSql).not.toContain('segment."sourceGeneration"');
    expect(cleanupParameters).toEqual([
      RUN_ID,
      '75',
      'worker-1',
      result?.leaseToken,
    ]);
  });

  it('fails the claim transaction when cleanup loses the claimed lease context', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async (_sql: string, parameters: unknown[]) => [
        [
          {
            runId: RUN_ID,
            departementId: '75',
            workerId: parameters[0],
            leaseToken: parameters[1],
            departementCode: '75',
            departmentGeneration: '3',
            departmentLastPublicRevision: '42',
            attemptCount: '2',
            leaseExpiresAt: NOW,
            progressDate: '2024-04-30',
            segmentCount: '1',
            communeCount: '1',
            artifactPrefix: 'departments/checkpointed',
            mapDateFrom: '2024-04-29',
            statisticDateFrom: '2024-04-29',
            dateThrough: '2024-05-02',
            sourceRevision: '42',
            historicComputeEpoch: '7',
            baseStatisticRevision: '12',
          },
        ],
        1,
      ])
      .mockResolvedValueOnce([
        { contextCount: 0, communeCount: 0, departmentCount: 0 },
      ]);
    const service = new HistoricBackfillQueueService(
      transactionalDataSource(query) as any,
    );

    await expect(service.claim('worker-1', 300, 5)).rejects.toThrow(
      HistoricBackfillStateError,
    );
    expect(query.mock.calls[4][0]).toContain('task."leaseToken" = $4::uuid');
  });

  it('returns null when no claim is available', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new HistoricBackfillQueueService(
      transactionalDataSource(query) as any,
    );

    await expect(service.claim('worker-1', 300, 5)).resolves.toBeNull();
  });

  it('serializes positive current-work budgets before counting active leases', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new HistoricBackfillQueueService(
      transactionalDataSource(query) as any,
    );

    await expect(service.claim('worker-1', 300, 5, 2)).resolves.toBeNull();

    const advisorySql = query.mock.calls.find(([sql]) =>
      sql.includes('pg_advisory_xact_lock'),
    )?.[0] as string;
    expect(advisorySql).toContain('historic-backfill-current-budget');
    const [claimSql, parameters] = query.mock.calls.find(([sql]) =>
      sql.includes('WITH priority AS MATERIALIZED'),
    ) as [string, unknown[]];
    expect(claimSql).toContain('request."nextAttemptAt" <= now()');
    expect(claimSql).toContain('priority."currentQueueDue"');
    expect(claimSql).toContain(
      'priority."activeHistoricLeaseCount" >= $5::integer',
    );
    expect(parameters).toEqual([
      'worker-1',
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      300,
      5,
      2,
    ]);
  });

  it('rejects an out-of-range current-work budget before touching the queue', async () => {
    const query = jest.fn();
    const service = new HistoricBackfillQueueService(
      transactionalDataSource(query) as any,
    );

    await expect(service.claim('worker-1', 300, 5, 33)).rejects.toThrow(
      'duringCurrentConcurrency must not exceed 32',
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('makes every stale purge and rebase depend on a priority-gated candidate', async () => {
    const query = jest.fn().mockImplementation(async () => []);
    const service = new HistoricBackfillQueueService(
      transactionalDataSource(query) as any,
    );

    await expect(service.claim('worker-1', 300, 5)).resolves.toBeNull();

    const sql = query.mock.calls[3][0] as string;
    const candidateSql = sql.slice(
      sql.indexOf('candidate AS MATERIALIZED'),
      sql.indexOf('purged_stale_commune_segments'),
    );
    expect(candidateSql).toContain(
      'NOT EXISTS (\n                SELECT 1\n                FROM priority',
    );
    for (const cte of [
      'purged_stale_commune_segments',
      'purged_stale_department_segments',
      'purged_stale_commune_shadow',
      'rebased_run',
      'claimed',
    ]) {
      const start = sql.indexOf(`${cte} AS`);
      expect(start).toBeGreaterThan(-1);
      const next = sql.indexOf(' AS (', start + cte.length + 4);
      const body = sql.slice(start, next === -1 ? undefined : next);
      expect(body).toContain('candidate');
    }
  });

  it('renews only an unexpired exact lease and advances progress monotonically', async () => {
    const query = jest.fn().mockResolvedValue([{ runId: RUN_ID }]);
    const service = new HistoricBackfillQueueService({ query } as any);

    await expect(
      service.heartbeat(
        lease(),
        {
          progressDate: '2020-01-02',
          segmentCount: 12,
          communeCount: 8,
          artifactPrefix: 'historic/run/75',
        },
        300,
      ),
    ).resolves.toBe(true);

    const [sql, parameters] = query.mock.calls[0];
    expect(sql).toContain('task."leaseToken" = $9::uuid');
    expect(sql).toContain('task."leaseExpiresAt" > now()');
    expect(sql).toContain('GREATEST(task."progressDate", $5::date)');
    expect(sql).toContain(
      'revision."generation" = task."departmentGeneration"',
    );
    expect(parameters).toEqual([
      RUN_ID,
      75,
      'worker-1',
      300,
      '2020-01-02',
      12,
      8,
      'historic/run/75',
      LEASE_TOKEN,
    ]);
  });

  it('rejects completion after lease loss and validates the output identity', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new HistoricBackfillQueueService({ query } as any);
    const output = {
      progressDate: '2026-08-18',
      segmentCount: 200,
      communeCount: 350,
      outputSignature: OUTPUT_SIGNATURE,
      artifactPrefix: null,
    };

    await expect(service.complete(lease(), output)).resolves.toBe(false);
    const sql = query.mock.calls[0][0];
    expect(sql).toContain('task."leaseToken" = $4::uuid');
    expect(sql).toContain('task."leaseExpiresAt" > now()');
    expect(sql).toContain('$5::date = run."dateThrough"');
    expect(sql).toContain('"leaseToken" = NULL');

    await expect(
      service.complete(lease(), {
        ...output,
        outputSignature: 'NOT-A-SHA',
      }),
    ).rejects.toThrow(HistoricBackfillValidationError);
  });

  it.each(['retry', 'terminal'] as const)(
    'records a %s failure with bounded backoff and releases leases',
    async (disposition) => {
      const query = jest.fn().mockResolvedValue([{ disposition }]);
      const service = new HistoricBackfillQueueService({ query } as any);

      await expect(
        service.fail(lease(), new Error('boom'), 5, 30, 1800),
      ).resolves.toBe(disposition);

      const [sql, parameters] = query.mock.calls[0];
      expect(sql).toContain('left($5, 4000)');
      expect(sql).toContain('task."attemptCount" >= $6::integer');
      expect(sql).toContain('power(');
      expect(sql).toContain('released_siblings');
      expect(sql).toContain('"leaseToken" = NULL');
      expect(parameters.slice(4)).toEqual(['boom', 5, 30, 1800]);
    },
  );

  it('yields with CAS semantics without consuming an attempt', async () => {
    const query = jest.fn().mockResolvedValue([{ runId: RUN_ID }]);
    const service = new HistoricBackfillQueueService({ query } as any);

    await expect(service.yieldTask(lease(), 15)).resolves.toBe(true);

    const [sql, parameters] = query.mock.calls[0];
    expect(sql).toContain('GREATEST("attemptCount" - 1, 0)');
    expect(sql).toContain('"leaseToken" = $4::uuid');
    expect(sql).toContain('make_interval(secs => $5::integer)');
    expect(parameters).toEqual([RUN_ID, 75, 'worker-1', LEASE_TOKEN, 15]);
  });

  it('pauses idempotently while revoking every live lease', async () => {
    const manager = {
      query: jest.fn(async (sql: string) =>
        sql.includes('SELECT "id", "status"')
          ? [{ id: RUN_ID, status: 'running' }]
          : [
              {
                status: 'paused',
                pendingPublication: false,
                releasedCount: '4',
              },
            ],
      ),
    };
    const dataSource = {
      transaction: jest.fn(
        async (_isolation: string, operation: (value: any) => unknown) =>
          operation(manager),
      ),
    };
    const service = new HistoricBackfillQueueService(dataSource as any);

    await expect(service.pause(RUN_ID)).resolves.toBe(true);

    expect(dataSource.transaction).toHaveBeenCalledWith(
      'READ COMMITTED',
      expect.any(Function),
    );
    expect(manager.query).toHaveBeenCalledTimes(2);
    expect(manager.query.mock.calls[0][0]).toContain('FOR UPDATE');
    const sql = manager.query.mock.calls[1][0];
    expect(sql).toContain('run."status" = \'running\'');
    expect(sql).toContain('task."status" = \'leased\'');
    expect(sql).toContain('"leaseToken" = NULL');
    expect(sql).toContain('released_artifacts');
    expect(sql).toContain('"historic_backfill_artifact_task"');
    expect(sql).toContain(
      'FROM "historic_backfill_map_manifest_outbox" outbox',
    );
    expect(sql).toContain('outbox."status" = \'pending\'');
    expect(sql).not.toContain('"statisticsPromotedAt"');
  });

  it('refuses an operator pause while a map publication awaits ACK', async () => {
    const manager = {
      query: jest.fn(async (sql: string) =>
        sql.includes('SELECT "id", "status"')
          ? [{ id: RUN_ID, status: 'running' }]
          : [
              {
                status: null,
                pendingPublication: true,
                releasedCount: '0',
              },
            ],
      ),
    };
    const dataSource = {
      transaction: jest.fn(
        async (_isolation: string, operation: (value: any) => unknown) =>
          operation(manager),
      ),
    };
    const service = new HistoricBackfillQueueService(dataSource as any);

    await expect(service.pause(RUN_ID)).resolves.toBe(false);

    expect(manager.query).toHaveBeenCalledTimes(2);
    expect(manager.query.mock.calls[0][0]).toContain('FOR UPDATE');
    const sql = manager.query.mock.calls[1][0] as string;
    expect(sql).toContain('pending_publication AS MATERIALIZED');
    expect(sql).toContain(
      'FROM "historic_backfill_map_manifest_outbox" outbox',
    );
    expect(sql).toContain('outbox."runId" = $1::uuid');
    expect(sql).toContain('outbox."status" = \'pending\'');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM pending_publication)');
  });

  it('resumes paused or failed runs and resets terminal tasks', async () => {
    const query = jest
      .fn()
      .mockResolvedValue([{ status: 'running', requeuedCount: '2' }]);
    const service = new HistoricBackfillQueueService({ query } as any);

    await expect(service.resume(RUN_ID)).resolves.toBe(true);

    const sql = query.mock.calls[0][0];
    expect(sql).toContain("target.\"status\" IN ('paused', 'failed')");
    expect(sql).toContain('target."historicComputeEpochCurrent"');
    expect(sql).toContain("task.\"status\" IN ('failed', 'leased')");
    expect(sql).toContain('WHEN task."status" = \'failed\' THEN 0');
    expect(sql).toContain("hashtext('historic-backfill-prepare')");
    expect(sql).toContain('active_conflict');
    expect(sql).not.toContain('"statisticsPromotedAt"');
  });

  it('refuses to resume while another run is active', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        status: 'failed',
        requeuedCount: '0',
        conflictingRunId: 'c9dba0c8-3d22-494f-b3b2-31ee987deabe',
      },
    ]);
    const service = new HistoricBackfillQueueService({ query } as any);

    await expect(service.resume(RUN_ID)).rejects.toThrow(
      'An unfinished historic backfill already exists',
    );
  });

  it('validates lease identity before querying PostgreSQL', async () => {
    const query = jest.fn();
    const service = new HistoricBackfillQueueService({ query } as any);

    await expect(
      service.yieldTask({ ...lease(), leaseToken: 'stale-token' }),
    ).rejects.toThrow(HistoricBackfillValidationError);
    expect(query).not.toHaveBeenCalled();
  });
});
