import {
  HISTORIC_BACKFILL_SHADOW_CONCURRENCY_DEFAULT,
  HISTORIC_BACKFILL_SHADOW_CONCURRENCY_MAX,
  HISTORIC_BACKFILL_SHADOW_WORK_MEM_MB_DEFAULT,
  HISTORIC_BACKFILL_SHADOW_WORK_MEM_MB_MAX,
  HistoricBackfillFinalizerService,
  HistoricBackfillFinalizerStateError,
  HistoricBackfillFinalizerValidationError,
  HistoricBackfillFinalizationInspection,
  HistoricDepartmentShadowResult,
  readHistoricBackfillShadowConcurrency,
  readHistoricBackfillShadowWorkMemMb,
} from './historic-backfill-finalizer.service';
import { DataSource } from 'typeorm';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const EXPECTED_DEPARTMENTS = 101;

function rebaseRow(overrides: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    runStatus: 'running',
    mapDateFrom: '2026-08-15',
    statisticDateFrom: '2026-08-16',
    dateThrough: '2026-08-18',
    sourceRevision: '42',
    currentSourceRevision: '42',
    historicComputeEpoch: '7',
    currentHistoricComputeEpoch: '7',
    historicBackfillGlobalEpoch: '4',
    currentHistoricBackfillGlobalEpoch: '4',
    baseStatisticRevision: '12',
    currentStatisticRevision: '12',
    statisticsPromotedAt: null,
    historicPublishedThrough: '2026-08-15',
    historicDirtyFrom: '2026-08-16',
    historicDirtyThrough: '2026-08-18',
    currentPublishedDate: '2026-08-19',
    computeStatsDate: '2026-08-15',
    departmentCount: '101',
    taskCount: '101',
    completedTaskCount: '101',
    currentGenerationTaskCount: '101',
    validTaskCount: '101',
    currentQueueCount: '0',
    runningDailyPublicationCount: '0',
    incompleteSnapshotCount: '0',
    pendingMapPublicationCount: '0',
    ...overrides,
  };
}

function inspectionRow(overrides: Record<string, unknown> = {}) {
  return {
    runFound: true,
    runStatus: 'running',
    statisticDateFrom: '2026-08-16',
    dateThrough: '2026-08-18',
    sourceRevision: '42',
    currentSourceRevision: '42',
    historicComputeEpoch: '7',
    currentHistoricComputeEpoch: '7',
    historicBackfillGlobalEpoch: '4',
    currentHistoricBackfillGlobalEpoch: '4',
    baseStatisticRevision: '12',
    currentStatisticRevision: '12',
    statisticsPromotedAt: null,
    sourceRevisionMatches: true,
    historicComputeEpochMatches: true,
    historicBackfillGlobalEpochMatches: true,
    baseStatisticRevisionMatches: true,
    statisticsPublicationClosed: false,
    dirtyRangeCovers: true,
    currentPublishedAfterRange: true,
    statsCursor: '2026-08-18',
    departmentCount: '101',
    taskCount: '101',
    completedTaskCount: '101',
    currentGenerationTaskCount: '101',
    validTaskArtifactCount: '101',
    expectedCommuneCount: '34935',
    validCommuneSegmentCoverageCount: '34935',
    shadowCommuneCount: '34935',
    validShadowCommuneCount: '34935',
    departmentSegmentCount: '202',
    invalidDepartmentSegmentCount: '0',
    expectedDepartmentPointCount: '303',
    expandedDepartmentPointCount: '303',
    distinctDepartmentPointCount: '303',
    currentQueueCount: '0',
    runningDailyPublicationCount: '0',
    runningSnapshotCount: '0',
    incompleteSnapshotCount: '0',
    pendingMapPublicationCount: '0',
    expectedDateCount: '3',
    ...overrides,
  };
}

function shadowRow(overrides: Record<string, unknown> = {}) {
  return {
    contextMatches: true,
    expectedCommuneCount: '2',
    segmentCount: '4',
    expectedPointCount: '6',
    expandedPointCount: '6',
    distinctPointCount: '6',
    invalidSegmentCount: '0',
    purgedShadowCount: '0',
    upsertedCount: '2',
    ...overrides,
  };
}

function materializationRows(
  sql: string,
  row: Record<string, unknown> = shadowRow(),
  pendingMapPublicationCount = '0',
): Record<string, unknown>[] | undefined {
  if (
    sql.includes('SELECT run."id"') &&
    sql.includes('FOR SHARE OF run') &&
    !sql.includes('WITH run_context AS MATERIALIZED')
  ) {
    return [{ id: RUN_ID }];
  }
  if (
    sql.includes('AS "pendingMapPublicationCount"') &&
    !sql.includes('WITH run_context AS MATERIALIZED')
  ) {
    return [{ pendingMapPublicationCount }];
  }
  if (sql.includes('payload_barrier AS MATERIALIZED')) return [row];
  return undefined;
}

function shadowBuildPlanRow(
  departementId: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    runId: RUN_ID,
    departementId,
    departmentGeneration: '9',
    taskCommuneCount: '2',
    segmentCount: '4',
    expectedCommuneCount: '2',
    expectedPointCount: '6',
    shadowCommuneCount: '0',
    validShadowCommuneCount: '0',
    ...overrides,
  };
}

function createRunner(options?: {
  inspection?: Record<string, unknown>;
  zoneLock?: boolean;
  statisticLock?: boolean;
  communeWrite?: Record<string, unknown>;
  departmentWrite?: Record<string, unknown>;
  snapshotWrite?: Record<string, unknown>;
}) {
  let statisticsPromotedAt = options?.inspection?.statisticsPromotedAt ?? null;
  const runner: any = {
    isTransactionActive: false,
    connect: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn(async () => {
      runner.isTransactionActive = true;
    }),
    commitTransaction: jest.fn(async () => {
      runner.isTransactionActive = false;
    }),
    rollbackTransaction: jest.fn(async () => {
      runner.isTransactionActive = false;
    }),
    query: jest.fn(async (sql: string) => {
      if (
        sql.includes('pg_try_advisory_lock') &&
        sql.includes('zone-compute-global')
      ) {
        return [{ locked: options?.zoneLock ?? true }];
      }
      if (
        sql.includes('pg_try_advisory_lock') &&
        sql.includes('snapshot-computation')
      ) {
        return [{ locked: options?.statisticLock ?? true }];
      }
      if (sql.includes('pg_advisory_unlock')) {
        return [{ unlocked: true }];
      }
      if (sql.includes('WITH request AS MATERIALIZED')) {
        return [
          inspectionRow({
            ...options?.inspection,
            statisticsPromotedAt,
          }),
        ];
      }
      if (sql.includes('upsertedCommuneCount')) {
        return [
          {
            expectedCommuneCount: '34935',
            upsertedCommuneCount: '34935',
            ...options?.communeWrite,
          },
        ];
      }
      if (sql.includes('upsertedDepartmentCount')) {
        return [
          {
            expectedDepartmentCount: '101',
            upsertedDepartmentCount: '101',
            expectedDateCount: '3',
            upsertedDateCount: '3',
            ...options?.departmentWrite,
          },
        ];
      }
      if (sql.includes('nationalSnapshotCount')) {
        return [
          {
            expectedDateCount: '3',
            nationalSnapshotCount: '3',
            siblingSnapshotCount: '6',
            cursorUpdateCount: '1',
            statsCursor: '2026-08-18',
            ...options?.snapshotWrite,
          },
        ];
      }
      if (sql.includes('SET "statisticsPromotedAt" = now()')) {
        if (statisticsPromotedAt !== null) return [[], 0];
        statisticsPromotedAt = '2026-08-20T09:30:00.000Z';
        return [[{ statisticsPromotedAt, statisticRevision: '13' }], 1];
      }
      return [];
    }),
  };
  return runner;
}

function createFinalizeHarness(options?: Parameters<typeof createRunner>[0]): {
  service: HistoricBackfillFinalizerService;
  runner: ReturnType<typeof createRunner>;
} {
  const runner = createRunner(options);
  const dataSource = {
    createQueryRunner: jest.fn(() => runner),
  };
  return {
    service: new HistoricBackfillFinalizerService(dataSource as any),
    runner,
  };
}

describe('HistoricBackfillFinalizerService shadow construction', () => {
  it('rebases once, purges every old shadow, and builds an exact guarded payload', async () => {
    const manager = {
      query: jest.fn(async (sql: string) => {
        const materialization = materializationRows(sql);
        if (materialization) return materialization;
        if (sql.includes('WITH run_context AS MATERIALIZED')) {
          return [
            rebaseRow({
              baseStatisticRevision: '12',
              currentStatisticRevision: '13',
            }),
          ];
        }
        if (sql.includes('WITH purged AS')) {
          return [{ purgedShadowCount: '17', updatedCount: '1' }];
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
    const service = new HistoricBackfillFinalizerService(dataSource as any);

    await expect(
      service.buildDepartmentShadow({
        runId: RUN_ID,
        departementId: 75,
        departmentGeneration: '9',
      }),
    ).resolves.toEqual({
      runId: RUN_ID,
      departementId: 75,
      departmentGeneration: '9',
      baseStatisticRevision: '13',
      rebased: true,
      purgedShadowCount: 17,
      communeCount: 2,
      segmentCount: 4,
      expandedPointCount: 6,
      upsertedCount: 2,
    });

    expect(dataSource.transaction).toHaveBeenCalledWith(
      'SERIALIZABLE',
      expect.any(Function),
    );
    expect(dataSource.transaction).toHaveBeenCalledWith(
      'READ COMMITTED',
      expect.any(Function),
    );
    const rebaseSql = manager.query.mock.calls.map(([sql]) => sql).join('\n');
    expect(rebaseSql).toContain(
      'FOR UPDATE OF run, source, config, publication',
    );
    expect(rebaseSql).toContain('FOR UPDATE OF task, revision');
    expect(rebaseSql).toContain(
      'daily_run."jobKey" = \'compute:national-daily\'',
    );
    expect(rebaseSql).toContain('daily_run."status" = \'running\'');
    expect(rebaseSql).toContain('snapshot."status" <> \'completed\'');
    expect(rebaseSql).toContain('snapshot."processedCommuneCount" <>');
    expect(rebaseSql).toContain('run."mapDateFrom"::text AS "mapDateFrom"');
    expect(rebaseSql).toContain(
      'DELETE FROM "historic_backfill_commune_shadow"',
    );
    expect(rebaseSql).toContain('SET "baseStatisticRevision" = $3::bigint');
    expect(rebaseSql).toContain('"statisticsPromotedAt" = NULL');

    const shadowSql = manager.query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('payload_barrier AS MATERIALIZED'))!;
    expect(shadowSql).toContain('generate_series(');
    expect(shadowSql).not.toContain('COUNT(DISTINCT ("communeId", date))');
    expect(shadowSql).toContain('ordered_segments AS MATERIALIZED');
    expect(shadowSql).toContain('lag(segment."validThrough") OVER');
    expect(shadowSql).toContain('segment_coverage AS MATERIALIZED');
    expect(shadowSql).toContain(
      'segment."validFrom" = segment."previousValidThrough" + 1',
    );
    expect(shadowSql).toContain('coverage."validCoveredCommuneCount" =');
    expect(shadowSql.indexOf('coverage_gate AS MATERIALIZED')).toBeLessThan(
      shadowSql.indexOf('expanded AS MATERIALIZED'),
    );
    expect(shadowSql).toContain('FROM daily_entries entries');
    expect(shadowSql).not.toContain('jsonb_array_elements(daily.restrictions)');
    expect(shadowSql).toContain('monthly_payload AS MATERIALIZED');
    expect(shadowSql).not.toContain(
      'GROUP BY daily."communeId", daily.restrictions',
    );
    expect(shadowSql).toContain('payload_barrier AS MATERIALIZED');
    const commitContextSql = shadowSql.slice(
      shadowSql.indexOf('commit_context AS MATERIALIZED'),
      shadowSql.indexOf('commit_tasks AS MATERIALIZED'),
    );
    expect(commitContextSql).toContain(
      'daily_run."jobKey" = \'compute:national-daily\'',
    );
    expect(commitContextSql).toContain('daily_run."status" = \'running\'');
    expect(commitContextSql).toContain('"status" <> \'completed\'');
    expect(commitContextSql).toContain(
      '"processedCommuneCount" <> "expectedCommuneCount"',
    );
    expect(commitContextSql).toContain(
      'FROM "historic_backfill_map_manifest_outbox" outbox',
    );
    expect(commitContextSql).toContain('outbox."status" = \'pending\'');
    expect(commitContextSql).toMatch(
      /run\."historicBackfillGlobalEpoch"\s*=\s*config\."historicBackfillGlobalEpoch"/,
    );
    expect(shadowSql).toContain(
      'FOR SHARE OF run, source, config, publication',
    );
    expect(shadowSql).toContain('FOR SHARE OF task, revision');
    expect(shadowSql).toContain("WHEN 'vigilance' THEN 1");
    expect(shadowSql).toContain(
      'INSERT INTO "historic_backfill_commune_shadow"',
    );
    expect(shadowSql).not.toContain('INSERT INTO "statistic_commune_snapshot"');
    expect(shadowSql).not.toContain('UPDATE "statistic_commune"');
    const shadowCall = (
      manager.query.mock.calls as unknown as Array<[string, unknown[]]>
    ).find(([sql]) => String(sql).includes('payload_barrier AS MATERIALIZED'));
    expect(shadowCall?.[1]).toEqual([RUN_ID, 75, '9']);
  });

  it('fails closed before materialization when one completed task is missing', async () => {
    const manager = {
      query: jest
        .fn()
        .mockResolvedValue([
          rebaseRow({ completedTaskCount: '100', validTaskCount: '100' }),
        ]),
    };
    const query = jest.fn();
    const dataSource = {
      query,
      transaction: jest.fn(
        async (_isolation: string, operation: (value: any) => unknown) =>
          operation(manager),
      ),
    };

    await expect(
      new HistoricBackfillFinalizerService(
        dataSource as any,
      ).buildDepartmentShadow({
        runId: RUN_ID,
        departementId: 75,
        departmentGeneration: '9',
      }),
    ).rejects.toThrow('tasks are not all completed');
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses shadow rebase when the global epoch changed', async () => {
    const manager = {
      query: jest
        .fn()
        .mockResolvedValue([
          rebaseRow({ currentHistoricBackfillGlobalEpoch: '5' }),
        ]),
    };
    const query = jest.fn();
    const dataSource = {
      query,
      transaction: jest.fn(
        async (_isolation: string, operation: (value: any) => unknown) =>
          operation(manager),
      ),
    };

    await expect(
      new HistoricBackfillFinalizerService(dataSource as any).buildShadow(
        RUN_ID,
      ),
    ).rejects.toThrow('historic backfill global epoch changed');
    expect(query).not.toHaveBeenCalled();
  });

  it('accepts a shadow rebase when the statistic cursor is already ahead', () => {
    const service = new HistoricBackfillFinalizerService({} as any);

    expect(() =>
      (service as any).assertRebaseState(
        rebaseRow({ computeStatsDate: '2026-08-20' }),
      ),
    ).not.toThrow();
  });

  it('reopens invalidated closed statistics once and preserves current shadows', async () => {
    let recovered = false;
    const manager = {
      query: jest.fn(async (sql: string, _parameters?: unknown[]) => {
        void _parameters;
        if (sql.includes('WITH run_context AS MATERIALIZED')) {
          return [
            rebaseRow(
              recovered
                ? {
                    baseStatisticRevision: '13',
                    currentStatisticRevision: '13',
                    historicDirtyFrom: '2026-08-16',
                    historicDirtyThrough: '2026-08-18',
                  }
                : {
                    statisticsPromotedAt: null,
                    historicPublishedThrough: '2026-08-18',
                    historicDirtyFrom: null,
                    historicDirtyThrough: null,
                    computeStatsDate: '2026-08-16',
                    currentPublishedDate: '2026-08-20',
                  },
            ),
          ];
        }
        if (sql.includes('WITH publication_update AS MATERIALIZED')) {
          recovered = true;
          return [
            {
              currentStatisticRevision: '13',
              purgedShadowCount: '0',
              updatedCount: '1',
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
    const service = new HistoricBackfillFinalizerService(dataSource as any);

    await expect(
      (service as any).rebaseStatisticRevision(RUN_ID),
    ).resolves.toEqual({
      baseStatisticRevision: '13',
      currentStatisticRevision: '13',
      rebased: true,
      purgedShadowCount: 0,
    });
    await expect(
      (service as any).rebaseStatisticRevision(RUN_ID),
    ).resolves.toEqual({
      baseStatisticRevision: '13',
      currentStatisticRevision: '13',
      rebased: false,
      purgedShadowCount: 0,
    });

    const recoveryCalls = manager.query.mock.calls.filter(([sql]) =>
      String(sql).includes('WITH publication_update AS MATERIALIZED'),
    );
    expect(recoveryCalls).toHaveLength(1);
    expect(recoveryCalls[0][0]).toContain(
      'publication."historicPublishedThrough" = $4::date',
    );
    expect(recoveryCalls[0][0]).toContain(
      'publication."currentPublishedDate" > $4::date',
    );
    expect(recoveryCalls[0][0]).toContain('AND $10::date <= $3::date');
    expect(recoveryCalls[0][0]).toContain('run."statisticsPromotedAt" IS NULL');
    expect(recoveryCalls[0][0]).toContain('AND NOT $9::boolean');
    expect(recoveryCalls[0][1]).toEqual([
      RUN_ID,
      '12',
      '2026-08-16',
      '2026-08-18',
      '42',
      '7',
      '4',
      '12',
      true,
      '2026-08-15',
    ]);
  });

  it('purges shadows when recovering across an intervening statistic revision', async () => {
    const manager = {
      query: jest.fn(async (sql: string, _parameters?: unknown[]) => {
        void _parameters;
        if (sql.includes('WITH run_context AS MATERIALIZED')) {
          return [
            rebaseRow({
              baseStatisticRevision: '11',
              currentStatisticRevision: '12',
              statisticsPromotedAt: null,
              historicPublishedThrough: '2026-08-18',
              historicDirtyFrom: null,
              historicDirtyThrough: null,
              computeStatsDate: '2026-08-16',
            }),
          ];
        }
        if (sql.includes('WITH publication_update AS MATERIALIZED')) {
          return [
            {
              currentStatisticRevision: '13',
              purgedShadowCount: '34943',
              updatedCount: '1',
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
      (
        new HistoricBackfillFinalizerService(dataSource as any) as any
      ).rebaseStatisticRevision(RUN_ID),
    ).resolves.toEqual({
      baseStatisticRevision: '13',
      currentStatisticRevision: '13',
      rebased: true,
      purgedShadowCount: 34943,
    });
    const recoveryCall = manager.query.mock.calls.find(([sql]) =>
      String(sql).includes('WITH publication_update AS MATERIALIZED'),
    );
    expect(recoveryCall?.[1]).toEqual([
      RUN_ID,
      '12',
      '2026-08-16',
      '2026-08-18',
      '42',
      '7',
      '4',
      '11',
      false,
      '2026-08-15',
    ]);
  });

  it.each([
    ['cursor before run', { computeStatsDate: '2026-08-15' }],
    ['cursor at completed boundary', { computeStatsDate: '2026-08-18' }],
    ['published range behind run', { historicPublishedThrough: '2026-08-17' }],
    [
      'published range ahead of run',
      { historicPublishedThrough: '2026-08-19' },
    ],
    ['map range starts after cursor', { mapDateFrom: '2026-08-17' }],
    ['half-open dirty range', { historicDirtyFrom: '2026-08-16' }],
  ])('refuses closed statistic recovery with %s', async (_, overrides) => {
    const manager = {
      query: jest.fn().mockResolvedValue([
        rebaseRow({
          statisticsPromotedAt: null,
          historicPublishedThrough: '2026-08-18',
          historicDirtyFrom: null,
          historicDirtyThrough: null,
          computeStatsDate: '2026-08-16',
          ...overrides,
        }),
      ]),
    };
    const dataSource = {
      transaction: jest.fn(
        async (_isolation: string, operation: (value: any) => unknown) =>
          operation(manager),
      ),
    };

    await expect(
      (
        new HistoricBackfillFinalizerService(dataSource as any) as any
      ).rebaseStatisticRevision(RUN_ID),
    ).rejects.toThrow('run does not cover the dirty range');
    expect(
      manager.query.mock.calls.some(([sql]) =>
        String(sql).includes('WITH publication_update AS MATERIALIZED'),
      ),
    ).toBe(false);
  });

  it('refuses closed recovery for a ready incomplete snapshot', async () => {
    const manager = {
      query: jest.fn().mockResolvedValue([
        rebaseRow({
          statisticsPromotedAt: null,
          historicPublishedThrough: '2026-08-18',
          historicDirtyFrom: null,
          historicDirtyThrough: null,
          computeStatsDate: '2026-08-16',
          incompleteSnapshotCount: '1',
        }),
      ]),
    };
    const dataSource = {
      transaction: jest.fn(
        async (_isolation: string, operation: (value: any) => unknown) =>
          operation(manager),
      ),
    };

    await expect(
      (
        new HistoricBackfillFinalizerService(dataSource as any) as any
      ).rebaseStatisticRevision(RUN_ID),
    ).rejects.toThrow('a commune statistic snapshot is incomplete');
    expect(manager.query).toHaveBeenCalledTimes(1);
    const sql = manager.query.mock.calls[0][0] as string;
    expect(sql).toContain('snapshot."status" <> \'completed\'');
    expect(sql).toContain('snapshot."processedCommuneCount" <>');
    expect(sql).not.toContain('WITH publication_update AS MATERIALIZED');
  });

  it('refuses shadow rebase while the current daily publication is running', async () => {
    const manager = {
      query: jest.fn().mockResolvedValue([
        rebaseRow({
          runningDailyPublicationCount: '1',
        }),
      ]),
    };
    const query = jest.fn();
    const dataSource = {
      query,
      transaction: jest.fn(
        async (_isolation: string, operation: (value: any) => unknown) =>
          operation(manager),
      ),
    };

    await expect(
      new HistoricBackfillFinalizerService(
        dataSource as any,
      ).buildDepartmentShadow({
        runId: RUN_ID,
        departementId: 75,
        departmentGeneration: '9',
      }),
    ).rejects.toThrow('a current daily publication is running');
    expect(query).not.toHaveBeenCalled();
  });

  it('freezes every shadow entry point while a map publication is pending', async () => {
    const operations: Array<
      (service: HistoricBackfillFinalizerService) => Promise<unknown>
    > = [
      (service) =>
        service.buildDepartmentShadow({
          runId: RUN_ID,
          departementId: 75,
          departmentGeneration: '9',
        }),
      (service) => service.buildShadow(RUN_ID),
      (service) => (service as any).rebaseStatisticRevision(RUN_ID),
    ];

    for (const operation of operations) {
      const manager = {
        query: jest
          .fn()
          .mockResolvedValue([rebaseRow({ pendingMapPublicationCount: '1' })]),
      };
      const dataSource = {
        query: jest.fn(),
        transaction: jest.fn(
          async (_isolation: string, callback: (value: any) => unknown) =>
            callback(manager),
        ),
      };
      const service = new HistoricBackfillFinalizerService(dataSource as any);

      await expect(operation(service)).rejects.toThrow(
        'a map publication is pending',
      );
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(dataSource.query).not.toHaveBeenCalled();
    }
  });

  it('fails the department commit when a daily publication starts after rebase', async () => {
    const manager = {
      query: jest.fn(async (sql: string) => {
        const materialization = materializationRows(
          sql,
          shadowRow({ contextMatches: false }),
        );
        if (materialization) return materialization;
        return [rebaseRow()];
      }),
    };
    const dataSource = {
      transaction: jest.fn(
        async (_isolation: string, operation: (value: any) => unknown) =>
          operation(manager),
      ),
    };

    await expect(
      new HistoricBackfillFinalizerService(
        dataSource as any,
      ).buildDepartmentShadow({
        runId: RUN_ID,
        departementId: 75,
        departmentGeneration: '9',
      }),
    ).rejects.toThrow('Historic shadow context changed for department 75');

    const sql = manager.query.mock.calls
      .map(([statement]) => String(statement))
      .find((statement) =>
        statement.includes('payload_barrier AS MATERIALIZED'),
      )!;
    const commitContextSql = sql.slice(
      sql.indexOf('commit_context AS MATERIALIZED'),
      sql.indexOf('commit_tasks AS MATERIALIZED'),
    );
    expect(commitContextSql).toContain(
      'FROM "external_publication_run" daily_run',
    );
    expect(commitContextSql).toContain(
      'daily_run."jobKey" = \'compute:national-daily\'',
    );
    expect(commitContextSql).toContain('daily_run."status" = \'running\'');
    expect(commitContextSql).toContain('"status" <> \'completed\'');
    expect(commitContextSql).toContain(
      '"processedCommuneCount" <> "expectedCommuneCount"',
    );
  });

  it('locks then freezes a department when an outbox appears after rebase', async () => {
    const manager = {
      query: jest.fn(async (sql: string) => {
        const materialization = materializationRows(sql, shadowRow(), '1');
        if (materialization) return materialization;
        return [rebaseRow()];
      }),
    };
    const dataSource = {
      transaction: jest.fn(
        async (_isolation: string, callback: (value: any) => unknown) =>
          callback(manager),
      ),
    };

    await expect(
      new HistoricBackfillFinalizerService(
        dataSource as any,
      ).buildDepartmentShadow({
        runId: RUN_ID,
        departementId: 75,
        departmentGeneration: '9',
      }),
    ).rejects.toThrow('Historic run is frozen by a pending map publication');

    expect(
      manager.query.mock.calls.some(([sql]) =>
        String(sql).includes('payload_barrier AS MATERIALIZED'),
      ),
    ).toBe(false);
  });

  it('refuses a run that does not cover the complete dirty range', async () => {
    const manager = {
      query: jest.fn().mockResolvedValue([
        rebaseRow({
          statisticDateFrom: '2026-08-17',
          historicDirtyFrom: '2026-08-16',
        }),
      ]),
    };
    const query = jest.fn();
    const dataSource = {
      query,
      transaction: jest.fn(
        async (_isolation: string, operation: (value: any) => unknown) =>
          operation(manager),
      ),
    };

    await expect(
      new HistoricBackfillFinalizerService(
        dataSource as any,
      ).buildDepartmentShadow({
        runId: RUN_ID,
        departementId: 75,
        departmentGeneration: '9',
      }),
    ).rejects.toThrow('run does not cover the dirty range');
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    { expandedPointCount: '5' },
    { distinctPointCount: '5' },
    { invalidSegmentCount: '1' },
    { contextMatches: false },
  ])(
    'rejects a gap, overlap, invalid segment, or lost commit guard',
    async (row) => {
      const manager = {
        query: jest.fn(async (sql: string) => {
          const materialization = materializationRows(sql, shadowRow(row));
          if (materialization) return materialization;
          return [rebaseRow()];
        }),
      };
      const dataSource = {
        transaction: jest.fn(
          async (_isolation: string, operation: (value: any) => unknown) =>
            operation(manager),
        ),
      };
      const service = new HistoricBackfillFinalizerService(dataSource as any);

      await expect(
        service.buildDepartmentShadow({
          runId: RUN_ID,
          departementId: 75,
          departmentGeneration: '9',
        }),
      ).rejects.toThrow(HistoricBackfillFinalizerStateError);
    },
  );

  it('orchestrates exactly 101 departments with configured concurrency', async () => {
    const plans = Array.from({ length: EXPECTED_DEPARTMENTS }, (_, index) =>
      shadowBuildPlanRow(index + 1),
    );
    const dataSource = { query: jest.fn().mockResolvedValue(plans) };
    const service = new HistoricBackfillFinalizerService(dataSource as any);
    jest.spyOn(service as any, 'rebaseStatisticRevision').mockResolvedValue({
      baseStatisticRevision: '13',
      currentStatisticRevision: '13',
      rebased: true,
      purgedShadowCount: 11,
    });
    let active = 0;
    let maximumActive = 0;
    jest
      .spyOn(service as any, 'materializeDepartmentShadow')
      .mockImplementation(async (identity: any) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 0));
        active -= 1;
        return {
          ...identity,
          baseStatisticRevision: '13',
          rebased: false,
          purgedShadowCount: 0,
          communeCount: 2,
          segmentCount: 4,
          expandedPointCount: 6,
          upsertedCount: 2,
        } satisfies HistoricDepartmentShadowResult;
      });

    const previousConcurrency =
      process.env.HISTORIC_BACKFILL_SHADOW_CONCURRENCY;
    process.env.HISTORIC_BACKFILL_SHADOW_CONCURRENCY = '2';
    try {
      await expect(service.buildShadow(RUN_ID)).resolves.toMatchObject({
        runId: RUN_ID,
        departmentCount: 101,
        skippedDepartmentCount: 0,
        communeCount: 202,
        segmentCount: 404,
        expandedPointCount: 606,
        upsertedCount: 202,
        purgedShadowCount: 11,
        rebased: true,
        baseStatisticRevision: '13',
      });
    } finally {
      if (previousConcurrency === undefined) {
        delete process.env.HISTORIC_BACKFILL_SHADOW_CONCURRENCY;
      } else {
        process.env.HISTORIC_BACKFILL_SHADOW_CONCURRENCY = previousConcurrency;
      }
    }
    expect(maximumActive).toBe(2);
    const planSql = dataSource.query.mock.calls[0][0] as string;
    expect(planSql).toContain('shadow_by_department AS MATERIALIZED');
    expect(planSql).toContain(
      'shadow."sourceGeneration" = task."departmentGeneration"',
    );
    expect(planSql).toContain(
      'commune."departementId" = shadow."departementId"',
    );
    expect(planSql).toContain('snapshot."status" <> \'completed\'');
    expect(planSql).toContain('snapshot."processedCommuneCount" <>');
  });

  it('resumes a partial build without rematerializing complete departments', async () => {
    const plans = Array.from({ length: EXPECTED_DEPARTMENTS }, (_, index) =>
      shadowBuildPlanRow(index + 1, {
        shadowCommuneCount: index === EXPECTED_DEPARTMENTS - 1 ? '0' : '2',
        validShadowCommuneCount: index === EXPECTED_DEPARTMENTS - 1 ? '0' : '2',
      }),
    );
    const dataSource = { query: jest.fn().mockResolvedValue(plans) };
    const service = new HistoricBackfillFinalizerService(dataSource as any);
    jest.spyOn(service as any, 'rebaseStatisticRevision').mockResolvedValue({
      baseStatisticRevision: '13',
      currentStatisticRevision: '13',
      rebased: false,
      purgedShadowCount: 0,
    });
    const materialize = jest
      .spyOn(service as any, 'materializeDepartmentShadow')
      .mockImplementation(async (identity: any) => ({
        ...identity,
        baseStatisticRevision: '13',
        rebased: false,
        purgedShadowCount: 0,
        communeCount: 2,
        segmentCount: 4,
        expandedPointCount: 6,
        upsertedCount: 2,
      }));

    await expect(service.buildShadow(RUN_ID)).resolves.toMatchObject({
      runId: RUN_ID,
      departmentCount: 101,
      skippedDepartmentCount: 100,
      communeCount: 202,
      segmentCount: 404,
      expandedPointCount: 606,
      upsertedCount: 2,
      rebased: false,
    });
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(materialize).toHaveBeenCalledWith(
      {
        runId: RUN_ID,
        departementId: 101,
        departmentGeneration: '9',
      },
      expect.objectContaining({ baseStatisticRevision: '13' }),
    );
  });

  it('validates the identity before touching PostgreSQL', async () => {
    const dataSource = { transaction: jest.fn(), query: jest.fn() };
    const service = new HistoricBackfillFinalizerService(dataSource as any);

    await expect(
      service.buildDepartmentShadow({
        runId: 'not-a-uuid',
        departementId: 0,
        departmentGeneration: '-1',
      }),
    ).rejects.toThrow(HistoricBackfillFinalizerValidationError);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('sets the configured local work_mem before each heavy materialization query', async () => {
    const manager = {
      query: jest.fn(async (sql: string) => {
        const materialization = materializationRows(sql);
        if (materialization) return materialization;
        if (sql.includes('WITH run_context AS MATERIALIZED')) {
          return [rebaseRow()];
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
    const service = new HistoricBackfillFinalizerService(dataSource as any);
    const previousWorkMem = process.env.HISTORIC_BACKFILL_SHADOW_WORK_MEM_MB;
    process.env.HISTORIC_BACKFILL_SHADOW_WORK_MEM_MB = '128';

    try {
      await expect(
        service.buildDepartmentShadow({
          runId: RUN_ID,
          departementId: 75,
          departmentGeneration: '9',
        }),
      ).resolves.toMatchObject({ communeCount: 2, upsertedCount: 2 });
    } finally {
      if (previousWorkMem === undefined) {
        delete process.env.HISTORIC_BACKFILL_SHADOW_WORK_MEM_MB;
      } else {
        process.env.HISTORIC_BACKFILL_SHADOW_WORK_MEM_MB = previousWorkMem;
      }
    }

    const statements = manager.query.mock.calls.map(([sql]) => sql as string);
    const workMemIndex = statements.findIndex((sql) =>
      sql.includes("SET LOCAL work_mem = '128MB'"),
    );
    const materializationIndex = statements.findIndex((sql) =>
      sql.includes('payload_barrier AS MATERIALIZED'),
    );
    expect(workMemIndex).toBeGreaterThanOrEqual(0);
    expect(materializationIndex).toBeGreaterThan(workMemIndex);
  });
});

describe('historic shadow concurrency configuration', () => {
  it('defaults to four and accepts the configured bounds', () => {
    expect(readHistoricBackfillShadowConcurrency({})).toBe(
      HISTORIC_BACKFILL_SHADOW_CONCURRENCY_DEFAULT,
    );
    expect(
      readHistoricBackfillShadowConcurrency({
        HISTORIC_BACKFILL_SHADOW_CONCURRENCY: ' 1 ',
      }),
    ).toBe(1);
    expect(
      readHistoricBackfillShadowConcurrency({
        HISTORIC_BACKFILL_SHADOW_CONCURRENCY: String(
          HISTORIC_BACKFILL_SHADOW_CONCURRENCY_MAX,
        ),
      }),
    ).toBe(HISTORIC_BACKFILL_SHADOW_CONCURRENCY_MAX);
  });

  it.each(['0', '9', '1.5', 'invalid'])(
    'rejects invalid concurrency %s',
    (value) => {
      expect(() =>
        readHistoricBackfillShadowConcurrency({
          HISTORIC_BACKFILL_SHADOW_CONCURRENCY: value,
        }),
      ).toThrow('HISTORIC_BACKFILL_SHADOW_CONCURRENCY must be between 1 and 8');
    },
  );
});

describe('historic shadow work_mem configuration', () => {
  it('defaults to disabled and accepts zero and the configured bounds', () => {
    expect(readHistoricBackfillShadowWorkMemMb({})).toBe(
      HISTORIC_BACKFILL_SHADOW_WORK_MEM_MB_DEFAULT,
    );
    expect(
      readHistoricBackfillShadowWorkMemMb({
        HISTORIC_BACKFILL_SHADOW_WORK_MEM_MB: ' 0 ',
      }),
    ).toBe(0);
    expect(
      readHistoricBackfillShadowWorkMemMb({
        HISTORIC_BACKFILL_SHADOW_WORK_MEM_MB: '128',
      }),
    ).toBe(128);
    expect(
      readHistoricBackfillShadowWorkMemMb({
        HISTORIC_BACKFILL_SHADOW_WORK_MEM_MB: String(
          HISTORIC_BACKFILL_SHADOW_WORK_MEM_MB_MAX,
        ),
      }),
    ).toBe(HISTORIC_BACKFILL_SHADOW_WORK_MEM_MB_MAX);
  });

  it.each(['-1', '513', '1.5', '1e2', '0x80', 'invalid'])(
    'rejects invalid work_mem %s',
    (value) => {
      expect(() =>
        readHistoricBackfillShadowWorkMemMb({
          HISTORIC_BACKFILL_SHADOW_WORK_MEM_MB: value,
        }),
      ).toThrow(
        'HISTORIC_BACKFILL_SHADOW_WORK_MEM_MB must be an integer between 0 and 512',
      );
    },
  );
});

describe('HistoricBackfillFinalizerService inspection', () => {
  it('reports all exact gates and efficient segment coverage checks', async () => {
    const query = jest.fn().mockResolvedValue([inspectionRow()]);
    const service = new HistoricBackfillFinalizerService({ query } as any);

    await expect(service.inspect(RUN_ID)).resolves.toMatchObject({
      runId: RUN_ID,
      ready: true,
      gates: [],
      expectedCommuneCount: 34935,
      validCommuneSegmentCoverageCount: 34935,
      expectedDepartmentPointCount: 303,
      historicBackfillGlobalEpoch: '4',
      currentHistoricBackfillGlobalEpoch: '4',
      statsCursor: '2026-08-18',
    } satisfies Partial<HistoricBackfillFinalizationInspection>);

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain('lag(segment."validThrough") OVER');
    expect(sql).toContain(
      'segment."validFrom" = segment."previousValidThrough" + 1',
    );
    expect(sql).toContain('generate_series(');
    expect(sql).toContain('COUNT(DISTINCT ("departementId", date))');
    expect(sql).toContain('FROM "current_zone_recompute_request"');
    expect(sql).toContain('FROM "external_publication_run" daily_run');
    expect(sql).toContain('daily_run."jobKey" = \'compute:national-daily\'');
    expect(sql).toContain('WHERE snapshot."status" <> \'completed\'');
    expect(sql).toContain('snapshot."processedCommuneCount" <>');
    expect(sql).toContain(
      'FROM "historic_backfill_map_manifest_outbox" outbox',
    );
    expect(sql).toContain(
      'run_context."mapDateFrom" <= run_context."historicDirtyFrom"',
    );
    expect(sql).toContain('run."historicBackfillGlobalEpoch"::text');
    expect(sql).toContain('config."historicBackfillGlobalEpoch"::text');
    expect(sql).not.toContain('FOR UPDATE OF run, source, config, publication');
  });

  it('keeps readiness when the statistic cursor is beyond the run', async () => {
    const query = jest
      .fn()
      .mockResolvedValue([inspectionRow({ statsCursor: '2026-08-20' })]);
    const service = new HistoricBackfillFinalizerService({ query } as any);

    await expect(service.inspect(RUN_ID)).resolves.toMatchObject({
      ready: true,
      gates: [],
      statsCursor: '2026-08-20',
    });
    expect(query.mock.calls[0][0]).not.toContain('statsCursorNotAhead');
  });

  it('refuses an applied marker whose statistic cursor is still behind', async () => {
    const query = jest.fn().mockResolvedValue([
      inspectionRow({
        statisticsPromotedAt: '2026-08-20T09:30:00.000Z',
        statsCursor: '2026-08-17',
      }),
    ]);
    const service = new HistoricBackfillFinalizerService({ query } as any);

    await expect(service.inspect(RUN_ID)).resolves.toMatchObject({
      ready: false,
      gates: expect.arrayContaining(['stats-cursor-behind-promotion']),
    });
  });

  it('fails readiness when the source, shadow, queue, or daily barrier changes', async () => {
    const query = jest.fn().mockResolvedValue([
      inspectionRow({
        sourceRevisionMatches: false,
        historicBackfillGlobalEpochMatches: false,
        validShadowCommuneCount: '34934',
        currentQueueCount: '1',
        runningDailyPublicationCount: '1',
        incompleteSnapshotCount: '1',
        pendingMapPublicationCount: '1',
      }),
    ]);
    const service = new HistoricBackfillFinalizerService({ query } as any);

    await expect(service.inspect(RUN_ID)).resolves.toMatchObject({
      ready: false,
      gates: expect.arrayContaining([
        'source-revision',
        'historic-backfill-global-epoch',
        'shadow-generation',
        'current-queue',
        'running-daily-publication',
        'incomplete-snapshot',
        'pending-map-publication',
      ]),
    });
  });
});

describe('HistoricBackfillFinalizerService statistic finalization', () => {
  it.each(['dry-run', 'apply'])(
    'refuses %s while a map publication is pending',
    async (mode) => {
      const { service, runner } = createFinalizeHarness({
        inspection: { pendingMapPublicationCount: '1' },
      });

      const operation =
        mode === 'dry-run' ? service.dryRun(RUN_ID) : service.apply(RUN_ID);
      await expect(operation).rejects.toThrow('pending-map-publication');
      expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(
        runner.query.mock.calls.some(([sql]: [string]) =>
          sql.includes('upsertedCommuneCount'),
        ),
      ).toBe(false);
    },
  );

  it('runs a write-free dry-run under serializable locks in the required order', async () => {
    const { service, runner } = createFinalizeHarness();

    await expect(service.dryRun(RUN_ID)).resolves.toMatchObject({
      runId: RUN_ID,
      applied: false,
      alreadyApplied: false,
      communeCount: 34935,
      departmentCount: 101,
      dateCount: 3,
    });

    expect(runner.startTransaction).toHaveBeenCalledWith('SERIALIZABLE');
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(runner.rollbackTransaction).not.toHaveBeenCalled();
    const statements = runner.query.mock.calls.map(([sql]: [string]) => sql);
    const zoneTry = statements.findIndex(
      (sql) =>
        sql.includes('pg_try_advisory_lock') &&
        sql.includes('zone-compute-global'),
    );
    const statisticTry = statements.findIndex(
      (sql) =>
        sql.includes('pg_try_advisory_lock') &&
        sql.includes('snapshot-computation'),
    );
    const statisticUnlock = statements.findIndex(
      (sql) =>
        sql.includes('pg_advisory_unlock') &&
        sql.includes('snapshot-computation'),
    );
    const zoneUnlock = statements.findIndex(
      (sql) =>
        sql.includes('pg_advisory_unlock') &&
        sql.includes('zone-compute-global'),
    );
    expect(zoneTry).toBeLessThan(statisticTry);
    expect(statisticTry).toBeLessThan(statisticUnlock);
    expect(statisticUnlock).toBeLessThan(zoneUnlock);
    expect(statements.join('\n')).not.toContain(
      'INSERT INTO "statistic_commune"',
    );
    const inspectionSql = statements.find((sql) =>
      sql.includes('WITH request AS MATERIALIZED'),
    );
    expect(inspectionSql).toContain(
      'FOR UPDATE OF run, source, config, publication',
    );
    expect(inspectionSql).toContain('FOR SHARE OF shadow');
    expect(inspectionSql).toContain('actual_by_department AS MATERIALIZED');
    expect(inspectionSql).toContain('GROUP BY segment."departementId"');
    expect(inspectionSql).toContain('LEFT JOIN actual_by_department actual');
    expect(inspectionSql).toContain(
      'run_context."statisticsPromotedAt" IS NOT NULL',
    );
    expect(inspectionSql).toContain(
      'run_context."historicPublishedThrough" >=',
    );
    expect(inspectionSql).toContain(
      'run_context."computeStatsDate" >= run_context."dateThrough"',
    );
    expect(inspectionSql).toContain('AS "statisticsPublicationClosed"');
    expect(inspectionSql).not.toContain(
      'FROM commune_segment_rows segment\n            WHERE segment."departementId" = task."departementId"',
    );
  });

  it('atomically publishes statistics and snapshots without map/run completion writes', async () => {
    const { service, runner } = createFinalizeHarness();

    await expect(service.apply(RUN_ID)).resolves.toMatchObject({
      runId: RUN_ID,
      applied: true,
      alreadyApplied: false,
      communeCount: 34935,
      departmentCount: 101,
      dateCount: 3,
      siblingSnapshotCount: 6,
      statsCursor: '2026-08-18',
    });

    const sql = runner.query.mock.calls
      .map(([statement]: [string]) => statement)
      .join('\n');
    expect(sql).toContain('INSERT INTO "statistic_commune"');
    expect(sql).toContain('INSERT INTO "statistic_departement"');
    expect(sql).toContain('INSERT INTO "statistic" AS statistic');
    expect(sql).toContain('INSERT INTO "statistic_commune_snapshot"');
    expect(sql).toContain(
      "snapshot.\"scope\" NOT IN ('national', 'bootstrap')",
    );
    expect(sql).toContain('"computeStatsDate" = GREATEST(');
    expect(sql).toContain('"computeStatsGeneration" =');
    expect(sql).not.toContain('"computeMapDate" =');
    expect(sql).not.toContain('"computeMapGeneration" =');
    expect(sql).toContain('UPDATE "statistic_publication_state" publication');
    expect(sql).toContain('"revision" = publication."revision" + 1');
    expect(sql).toContain('"historicPublishedThrough" = $3::date');
    expect(sql).toContain('"historicDirtyFrom" = NULL');
    expect(sql).toContain('"historicDirtyThrough" = NULL');
    expect(sql).toContain('UPDATE "historic_backfill_run" run');
    expect(sql).toContain('SET "statisticsPromotedAt" = now()');
    expect(sql).toContain(
      '"baseStatisticRevision" = publication_update."revision"',
    );
    const statements = runner.query.mock.calls.map(
      ([statement]: [string]) => statement,
    );
    const communeWrite = statements.findIndex((statement) =>
      statement.includes('upsertedCommuneCount'),
    );
    const departmentWrite = statements.findIndex((statement) =>
      statement.includes('upsertedDepartmentCount'),
    );
    const snapshotWrite = statements.findIndex((statement) =>
      statement.includes('nationalSnapshotCount'),
    );
    const markerWrite = statements.findIndex((statement) =>
      statement.includes('SET "statisticsPromotedAt" = now()'),
    );
    expect(communeWrite).toBeLessThan(departmentWrite);
    expect(departmentWrite).toBeLessThan(snapshotWrite);
    expect(snapshotWrite).toBeLessThan(markerWrite);
    expect(statements[markerWrite]).not.toContain('SET "status" =');
    expect(statements[markerWrite]).not.toContain('"computeMapDate"');
    expect(statements[markerWrite]).not.toContain('"computeMapGeneration"');
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('keeps an already-ahead statistic cursor while applying the run', async () => {
    const { service, runner } = createFinalizeHarness({
      inspection: { statsCursor: '2026-08-20' },
      snapshotWrite: {
        cursorUpdateCount: '0',
        statsCursor: '2026-08-20',
      },
    });

    await expect(service.apply(RUN_ID)).resolves.toMatchObject({
      applied: true,
      alreadyApplied: false,
      statsCursor: '2026-08-20',
      inspection: { statsCursor: '2026-08-20' },
    });

    const sql = runner.query.mock.calls
      .map(([statement]: [string]) => statement)
      .join('\n');
    expect(sql).toContain('"computeStatsDate" = GREATEST(');
    expect(sql).toContain(
      'config."computeStatsDate" < run_context."dateThrough"',
    );
  });

  it('returns the real ahead cursor from the already-applied fast path', async () => {
    const { service } = createFinalizeHarness({
      inspection: {
        statisticsPromotedAt: '2026-08-20T09:30:00.000Z',
        statsCursor: '2026-08-20',
      },
    });

    await expect(service.apply(RUN_ID)).resolves.toMatchObject({
      applied: true,
      alreadyApplied: true,
      statsCursor: '2026-08-20',
    });
  });

  it('keeps an already-closed publication idempotent after a daily revision advances', async () => {
    const { service, runner } = createFinalizeHarness({
      inspection: {
        statisticsPromotedAt: '2026-08-20T09:30:00.000Z',
        baseStatisticRevision: '13',
        currentStatisticRevision: '14',
        baseStatisticRevisionMatches: false,
        statisticsPublicationClosed: true,
        statsCursor: '2026-08-20',
      },
    });

    await expect(service.apply(RUN_ID)).resolves.toMatchObject({
      applied: true,
      alreadyApplied: true,
      statsCursor: '2026-08-20',
      inspection: {
        baseStatisticRevisionMatches: false,
        statisticsPublicationClosed: true,
      },
    });
    expect(
      runner.query.mock.calls.some(([sql]: [string]) =>
        sql.includes('upsertedCommuneCount'),
      ),
    ).toBe(false);
  });

  it('does not repeat heavy writes after statistics were promoted once', async () => {
    const { service, runner } = createFinalizeHarness();

    await expect(service.apply(RUN_ID)).resolves.toMatchObject({
      applied: true,
      alreadyApplied: false,
      inspection: {
        statisticsPromotedAt: '2026-08-20T09:30:00.000Z',
      },
    });
    await expect(service.apply(RUN_ID)).resolves.toMatchObject({
      applied: true,
      alreadyApplied: true,
      siblingSnapshotCount: 0,
      statsCursor: '2026-08-18',
      inspection: {
        statisticsPromotedAt: '2026-08-20T09:30:00.000Z',
      },
    });

    const statements = runner.query.mock.calls.map(([sql]: [string]) => sql);
    expect(
      statements.filter((sql) => sql.includes('upsertedCommuneCount')),
    ).toHaveLength(1);
    expect(
      statements.filter((sql) => sql.includes('upsertedDepartmentCount')),
    ).toHaveLength(1);
    expect(
      statements.filter((sql) => sql.includes('nationalSnapshotCount')),
    ).toHaveLength(1);
    expect(
      statements.filter((sql) =>
        sql.includes('SET "statisticsPromotedAt" = now()'),
      ),
    ).toHaveLength(1);
    expect(runner.commitTransaction).toHaveBeenCalledTimes(2);
  });

  it('still refuses stale context before the already-applied fast path', async () => {
    const { service, runner } = createFinalizeHarness({
      inspection: {
        statisticsPromotedAt: '2026-08-20T09:30:00.000Z',
        sourceRevisionMatches: false,
      },
    });

    await expect(service.apply(RUN_ID)).rejects.toThrow('source-revision');
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(
      runner.query.mock.calls.some(([sql]: [string]) =>
        sql.includes('upsertedCommuneCount'),
      ),
    ).toBe(false);
  });

  it('exposes an existing promotion marker in a write-free dry-run', async () => {
    const { service, runner } = createFinalizeHarness({
      inspection: {
        statisticsPromotedAt: new Date('2026-08-20T09:30:00.000Z'),
      },
    });

    await expect(service.dryRun(RUN_ID)).resolves.toMatchObject({
      applied: false,
      alreadyApplied: true,
      inspection: {
        statisticsPromotedAt: '2026-08-20T09:30:00.000Z',
      },
    });
    expect(
      runner.query.mock.calls.some(([sql]: [string]) =>
        sql.includes('upsertedCommuneCount'),
      ),
    ).toBe(false);
  });

  it('rolls back before writes when a final gate changes', async () => {
    const { service, runner } = createFinalizeHarness({
      inspection: { baseStatisticRevisionMatches: false },
    });

    await expect(service.apply(RUN_ID)).rejects.toThrow(
      'base-statistic-revision',
    );
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(runner.commitTransaction).not.toHaveBeenCalled();
    expect(
      runner.query.mock.calls.some(([sql]: [string]) =>
        sql.includes('upsertedCommuneCount'),
      ),
    ).toBe(false);
  });

  it('rolls back every canonical write when an affected count is incomplete', async () => {
    const { service, runner } = createFinalizeHarness({
      communeWrite: { upsertedCommuneCount: '34934' },
    });

    await expect(service.apply(RUN_ID)).rejects.toThrow(
      'Canonical commune statistic write is incomplete',
    );
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(runner.commitTransaction).not.toHaveBeenCalled();
    expect(
      runner.query.mock.calls.some(([sql]: [string]) =>
        sql.includes('upsertedDepartmentCount'),
      ),
    ).toBe(false);
  });

  it('releases the first lock and never opens a transaction if the second is busy', async () => {
    const { service, runner } = createFinalizeHarness({ statisticLock: false });

    await expect(service.dryRun(RUN_ID)).rejects.toThrow(
      'Commune statistic computation is running',
    );
    expect(runner.startTransaction).not.toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalledTimes(1);
    const unlocks = runner.query.mock.calls.filter(([sql]: [string]) =>
      sql.includes('pg_advisory_unlock'),
    );
    expect(unlocks).toHaveLength(1);
    expect(unlocks[0][0]).toContain('zone-compute-global');
  });
});

const postgresUrl = process.env.HISTORIC_BACKFILL_FINALIZER_POSTGRES_URL;
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres(
  'HistoricBackfillFinalizerService PostgreSQL behavior',
  () => {
    const schemaName = `historic_finalizer_${process.pid}_${Date.now()}`;
    let adminDataSource: DataSource;
    let dataSource: DataSource;
    let service: HistoricBackfillFinalizerService;

    beforeAll(async () => {
      adminDataSource = await new DataSource({
        type: 'postgres',
        url: postgresUrl,
        synchronize: false,
        logging: false,
      }).initialize();
      await adminDataSource.query(`CREATE SCHEMA "${schemaName}"`);
      dataSource = await new DataSource({
        type: 'postgres',
        url: postgresUrl,
        synchronize: false,
        logging: false,
        extra: { options: `-c search_path=${schemaName},public` },
      }).initialize();
      service = new HistoricBackfillFinalizerService(dataSource);

      await dataSource.query(`
      CREATE TABLE "departement" (
        "id" integer PRIMARY KEY,
        "code" varchar NOT NULL UNIQUE
      );
      CREATE TABLE "commune" (
        "id" integer PRIMARY KEY,
        "departementId" integer NOT NULL
      );
      CREATE TABLE "zone_publication_source_state" (
        "id" integer PRIMARY KEY,
        "publicRevision" bigint NOT NULL
      );
      CREATE TABLE "config" (
        "id" integer PRIMARY KEY,
        "computeMapDate" date,
        "computeMapGeneration" bigint NOT NULL,
        "computeMapUpdatedAt" timestamptz,
        "computeStatsDate" date,
        "computeStatsGeneration" bigint NOT NULL,
        "computeStatsUpdatedAt" timestamptz,
        "historicComputeEpoch" bigint NOT NULL,
        "historicBackfillGlobalEpoch" bigint NOT NULL
      );
      CREATE TABLE "statistic_publication_state" (
        "id" integer PRIMARY KEY,
        "revision" bigint NOT NULL,
        "currentPublishedDate" date,
        "historicPublishedThrough" date,
        "historicDirtyFrom" date,
        "historicDirtyThrough" date,
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE "current_zone_recompute_request" (
        "departementId" integer PRIMARY KEY,
        "currentPending" boolean NOT NULL DEFAULT false,
        "pendingScheduledDates" date[] NOT NULL DEFAULT ARRAY[]::date[]
      );
      CREATE TABLE "external_publication_run" (
        "jobKey" varchar NOT NULL,
        "status" varchar NOT NULL
      );
      CREATE TABLE "historic_backfill_run" (
        "id" uuid PRIMARY KEY,
        "status" varchar NOT NULL,
        "mapDateFrom" date NOT NULL,
        "statisticDateFrom" date NOT NULL,
        "dateThrough" date NOT NULL,
        "sourceRevision" bigint NOT NULL,
        "historicComputeEpoch" bigint NOT NULL,
        "historicBackfillGlobalEpoch" bigint NOT NULL,
        "baseStatisticRevision" bigint NOT NULL,
        "statisticsPromotedAt" timestamptz,
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE "historic_backfill_map_manifest_outbox" (
        "runId" uuid PRIMARY KEY,
        "status" varchar NOT NULL
      );
      CREATE TABLE "historic_backfill_department_revision" (
        "departementId" integer PRIMARY KEY,
        "generation" bigint NOT NULL
      );
      CREATE TABLE "historic_backfill_task" (
        "runId" uuid NOT NULL,
        "departementId" integer NOT NULL,
        "status" varchar NOT NULL,
        "departmentGeneration" bigint NOT NULL,
        "progressDate" date,
        "segmentCount" integer NOT NULL,
        "communeCount" integer NOT NULL,
        "outputSignature" varchar,
        "artifactPrefix" text,
        PRIMARY KEY ("runId", "departementId")
      );
      CREATE TABLE "historic_backfill_commune_segment" (
        "runId" uuid NOT NULL,
        "departementId" integer NOT NULL,
        "communeId" integer NOT NULL,
        "validFrom" date NOT NULL,
        "validThrough" date NOT NULL,
        "SOU" varchar,
        "SUP" varchar,
        "AEP" varchar,
        "sourceGeneration" bigint NOT NULL,
        "inputSignature" varchar NOT NULL,
        PRIMARY KEY ("runId", "communeId", "validFrom")
      );
      CREATE TABLE "historic_backfill_department_segment" (
        "runId" uuid NOT NULL,
        "departementId" integer NOT NULL,
        "validFrom" date NOT NULL,
        "validThrough" date NOT NULL,
        "sourceGeneration" bigint NOT NULL,
        "inputSignature" varchar NOT NULL,
        "restriction" jsonb NOT NULL,
        "situation" jsonb NOT NULL,
        "geojsonObjectKey" text NOT NULL,
        "geojsonChecksum" varchar NOT NULL,
        "featureCount" integer NOT NULL,
        PRIMARY KEY ("runId", "departementId", "validFrom")
      );
      CREATE TABLE "historic_backfill_commune_shadow" (
        "runId" uuid NOT NULL,
        "communeId" integer NOT NULL,
        "departementId" integer NOT NULL,
        "sourceGeneration" bigint NOT NULL,
        "restrictions" jsonb NOT NULL,
        "restrictionsByMonth" jsonb NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("runId", "communeId")
      );
      CREATE TABLE "statistic_commune" (
        "id" serial PRIMARY KEY,
        "communeId" integer NOT NULL UNIQUE,
        "restrictions" jsonb,
        "restrictionsByMonth" jsonb
      );
      CREATE TABLE "statistic_departement" (
        "id" serial PRIMARY KEY,
        "departementId" integer NOT NULL UNIQUE,
        "visits" jsonb,
        "restrictions" jsonb,
        "totalVisits" integer NOT NULL,
        "weekVisits" integer NOT NULL,
        "monthVisits" integer NOT NULL,
        "yearVisits" integer NOT NULL,
        "subscriptions" integer NOT NULL
      );
      CREATE TABLE "statistic" (
        "id" serial PRIMARY KEY,
        "date" date NOT NULL UNIQUE,
        "departementSituation" json
      );
      CREATE TABLE "statistic_commune_snapshot" (
        "snapshotDate" date NOT NULL,
        "scope" varchar NOT NULL,
        "status" varchar NOT NULL,
        "expectedCommuneCount" integer NOT NULL,
        "processedCommuneCount" integer NOT NULL,
        "sourceRevision" bigint,
        "startedAt" timestamptz NOT NULL DEFAULT now(),
        "completedAt" timestamptz,
        "lastError" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("snapshotDate", "scope")
      );

      INSERT INTO "zone_publication_source_state" VALUES (1, 42);
      INSERT INTO "config" VALUES (
        1, date '2026-08-14', 5, NULL,
        date '2026-08-15', 7, NULL, 9, 4
      );
      INSERT INTO "statistic_publication_state" VALUES (
        1, 13, date '2026-08-19', date '2026-08-15',
        date '2026-08-16', date '2026-08-18', now()
      );
      INSERT INTO "historic_backfill_run" VALUES (
        '${RUN_ID}', 'running', date '2026-08-15', date '2026-08-16',
        date '2026-08-18', 42, 9, 4, 12, now(), now()
      );
      INSERT INTO "departement" ("id", "code")
      SELECT value, lpad(value::text, 3, '0')
      FROM generate_series(1, 101) value;
      INSERT INTO "commune" ("id", "departementId")
      SELECT value, value FROM generate_series(1, 101) value;
      INSERT INTO "historic_backfill_department_revision"
      SELECT value, 3 FROM generate_series(1, 101) value;
      INSERT INTO "historic_backfill_task"
      SELECT
        '${RUN_ID}', value, 'completed', 3, date '2026-08-18',
        1, 1, repeat('a', 64), 'historic/${RUN_ID}'
      FROM generate_series(1, 101) value;
      INSERT INTO "historic_backfill_commune_segment"
      SELECT
        '${RUN_ID}', value, value, date '2026-08-16', date '2026-08-18',
        NULL, CASE WHEN value = 1 THEN 'alerte' ELSE NULL END, NULL,
        3, repeat('b', 64)
      FROM generate_series(1, 101) value;
      INSERT INTO "historic_backfill_department_segment"
      SELECT
        '${RUN_ID}', value, date '2026-08-15', date '2026-08-18', 3,
        repeat('b', 64),
        jsonb_build_object(
          'date', '2026-08-15', 'SOU', jsonb_build_object(),
          'SUP', jsonb_build_object(), 'AEP', jsonb_build_object()
        ),
        jsonb_build_object('max', NULL, 'sup', NULL, 'sou', NULL, 'aep', NULL),
        'historic/${RUN_ID}/department.geojson', repeat('c', 64), 0
      FROM generate_series(1, 101) value;
      INSERT INTO "statistic_commune" (
        "communeId", "restrictions", "restrictionsByMonth"
      )
      SELECT
        value,
        '[{"date":"2026-08-15","SOU":null,"SUP":null,"AEP":null},
          {"date":"2026-08-19","SOU":null,"SUP":null,"AEP":null}]'::jsonb,
        '[{"date":"2026-08","ponderation":99}]'::jsonb
      FROM generate_series(1, 101) value;
      INSERT INTO "statistic_departement" (
        "departementId", "visits", "restrictions", "totalVisits",
        "weekVisits", "monthVisits", "yearVisits", "subscriptions"
      )
      SELECT
        value, '[]'::jsonb,
        '[{"date":"2026-08-15"},{"date":"2026-08-19"}]'::jsonb,
        0, 0, 0, 0, 0
      FROM generate_series(1, 101) value;
      INSERT INTO "statistic_commune_snapshot" (
        "snapshotDate", "scope", "status", "expectedCommuneCount",
        "processedCommuneCount", "sourceRevision"
      ) VALUES
        (date '1970-01-01', 'bootstrap', 'completed', 0, 0, NULL),
        (date '2026-08-16', 'departements:001', 'completed', 1, 1, 41);
    `);
    }, 30_000);

    afterAll(async () => {
      if (dataSource?.isInitialized) await dataSource.destroy();
      if (adminDataSource?.isInitialized) {
        await adminDataSource.query(
          `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`,
        );
        await adminDataSource.destroy();
      }
    });

    it('freezes shadow and statistic mutations behind a pending map outbox', async () => {
      const [before] = await dataSource.query(`
        SELECT "sourceRevision"::text AS "sourceRevision",
               "baseStatisticRevision"::text AS "baseStatisticRevision",
               "statisticsPromotedAt"
        FROM "historic_backfill_run"
        WHERE "id" = '${RUN_ID}'
      `);
      await dataSource.query(`
        INSERT INTO "historic_backfill_map_manifest_outbox" ("runId", "status")
        VALUES ('${RUN_ID}', 'pending')
      `);

      try {
        await expect(service.buildShadow(RUN_ID)).rejects.toThrow(
          'a map publication is pending',
        );
        await expect(
          service.buildDepartmentShadow({
            runId: RUN_ID,
            departementId: 1,
            departmentGeneration: '3',
          }),
        ).rejects.toThrow('a map publication is pending');
        await expect(service.dryRun(RUN_ID)).rejects.toThrow(
          'pending-map-publication',
        );
        await expect(service.apply(RUN_ID)).rejects.toThrow(
          'pending-map-publication',
        );

        const [after] = await dataSource.query(`
          SELECT "sourceRevision"::text AS "sourceRevision",
                 "baseStatisticRevision"::text AS "baseStatisticRevision",
                 "statisticsPromotedAt",
                 (SELECT COUNT(*)::integer
                  FROM "historic_backfill_commune_shadow") AS "shadowCount"
          FROM "historic_backfill_run"
          WHERE "id" = '${RUN_ID}'
        `);
        expect(after).toMatchObject({
          sourceRevision: before.sourceRevision,
          baseStatisticRevision: before.baseStatisticRevision,
          statisticsPromotedAt: before.statisticsPromotedAt,
          shadowCount: 0,
        });
      } finally {
        await dataSource.query(`
          DELETE FROM "historic_backfill_map_manifest_outbox"
          WHERE "runId" = '${RUN_ID}'
        `);
      }
    }, 30_000);

    it('allows a statistic rebase when the daily cursor is already ahead', async () => {
      const [before] = await dataSource.query(`
        SELECT config."computeStatsDate"::text AS "computeStatsDate",
               run."baseStatisticRevision"::text AS "baseStatisticRevision",
               run."statisticsPromotedAt"
        FROM "config" config
        CROSS JOIN "historic_backfill_run" run
        WHERE config."id" = 1 AND run."id" = '${RUN_ID}'
      `);
      await dataSource.query(`
        UPDATE "config"
        SET "computeStatsDate" = date '2026-08-20'
        WHERE "id" = 1
      `);

      try {
        await expect(
          (service as any).rebaseStatisticRevision(RUN_ID),
        ).resolves.toMatchObject({
          currentStatisticRevision: '13',
          rebased: true,
        });
      } finally {
        await dataSource.query(
          `UPDATE "config" SET "computeStatsDate" = $1::date WHERE "id" = 1`,
          [before.computeStatsDate],
        );
        await dataSource.query(
          `UPDATE "historic_backfill_run"
           SET "baseStatisticRevision" = $1::bigint,
               "statisticsPromotedAt" = $2::timestamptz
           WHERE "id" = '${RUN_ID}'`,
          [before.baseStatisticRevision, before.statisticsPromotedAt],
        );
      }
    }, 30_000);

    it('blocks the department commit when the daily job starts after rebase', async () => {
      const raceService = new HistoricBackfillFinalizerService(dataSource);
      const originalRebase = (raceService as any).rebaseStatisticRevision.bind(
        raceService,
      );
      jest
        .spyOn(raceService as any, 'rebaseStatisticRevision')
        .mockImplementation(async (runId: string) => {
          const rebase = await originalRebase(runId);
          await dataSource.query(`
            INSERT INTO "external_publication_run" ("jobKey", "status")
            VALUES ('compute:national-daily', 'running')
          `);
          return rebase;
        });

      try {
        await expect(
          raceService.buildDepartmentShadow({
            runId: RUN_ID,
            departementId: 1,
            departmentGeneration: '3',
          }),
        ).rejects.toThrow('Historic shadow context changed for department 1');
        const [shadowCount] = await dataSource.query(`
          SELECT COUNT(*)::integer AS count
          FROM "historic_backfill_commune_shadow"
          WHERE "runId" = '${RUN_ID}' AND "departementId" = 1
        `);
        expect(shadowCount.count).toBe(0);
      } finally {
        await dataSource.query(`
          DELETE FROM "external_publication_run"
          WHERE "jobKey" = 'compute:national-daily';
          UPDATE "historic_backfill_run"
          SET "baseStatisticRevision" = 12, "statisticsPromotedAt" = NULL
          WHERE "id" = '${RUN_ID}'
        `);
      }
    }, 30_000);

    it('recovers a closed invalidated publication and preserves valid shadows', async () => {
      const [before] = await dataSource.query(`
        SELECT
          config."computeStatsDate"::text AS "computeStatsDate",
          publication."revision"::text AS "revision",
          publication."historicPublishedThrough"::text
            AS "historicPublishedThrough",
          publication."historicDirtyFrom"::text AS "historicDirtyFrom",
          publication."historicDirtyThrough"::text AS "historicDirtyThrough",
          run."baseStatisticRevision"::text AS "baseStatisticRevision",
          run."statisticsPromotedAt"
        FROM "config" config
        CROSS JOIN "statistic_publication_state" publication
        CROSS JOIN "historic_backfill_run" run
        WHERE config."id" = 1
          AND publication."id" = 1
          AND run."id" = '${RUN_ID}'
      `);
      const [beforeShadow] = await dataSource.query(`
        SELECT COUNT(*)::integer AS count
        FROM "historic_backfill_commune_shadow"
        WHERE "runId" = '${RUN_ID}'
      `);
      expect(beforeShadow.count).toBe(0);

      try {
        await dataSource.query(`
          INSERT INTO "historic_backfill_commune_shadow" (
            "runId", "communeId", "departementId", "sourceGeneration",
            "restrictions", "restrictionsByMonth"
          )
          SELECT
            '${RUN_ID}', value, value, 3,
            jsonb_build_array(jsonb_build_object('sentinel', value)),
            jsonb_build_array(jsonb_build_object('month', value))
          FROM generate_series(1, 101) value;

          UPDATE "config"
          SET "computeStatsDate" = date '2026-08-16'
          WHERE "id" = 1;

          UPDATE "statistic_publication_state"
          SET
            "revision" = 13,
            "historicPublishedThrough" = date '2026-08-18',
            "historicDirtyFrom" = NULL,
            "historicDirtyThrough" = NULL
          WHERE "id" = 1;

          UPDATE "historic_backfill_run"
          SET
            "baseStatisticRevision" = 13,
            "statisticsPromotedAt" = NULL
          WHERE "id" = '${RUN_ID}';
        `);
        const [shadowBeforeRecovery] = await dataSource.query(`
          SELECT
            COUNT(*)::integer AS count,
            md5(string_agg(
              "communeId"::text || ':' || "restrictions"::text || ':' ||
              "restrictionsByMonth"::text || ':' || "createdAt"::text || ':' ||
              "updatedAt"::text,
              '|' ORDER BY "communeId"
            )) AS fingerprint
          FROM "historic_backfill_commune_shadow"
          WHERE "runId" = '${RUN_ID}'
        `);

        await expect(service.buildShadow(RUN_ID)).resolves.toMatchObject({
          departmentCount: 101,
          skippedDepartmentCount: 101,
          communeCount: 101,
          upsertedCount: 0,
          purgedShadowCount: 0,
          rebased: true,
          baseStatisticRevision: '14',
        });

        const [recovered] = await dataSource.query(`
          SELECT
            publication."revision"::text AS "revision",
            publication."historicPublishedThrough"::text
              AS "historicPublishedThrough",
            publication."historicDirtyFrom"::text AS "historicDirtyFrom",
            publication."historicDirtyThrough"::text AS "historicDirtyThrough",
            run."baseStatisticRevision"::text AS "baseStatisticRevision",
            run."statisticsPromotedAt",
            COUNT(shadow.*)::integer AS "shadowCount",
            md5(string_agg(
              shadow."communeId"::text || ':' ||
              shadow."restrictions"::text || ':' ||
              shadow."restrictionsByMonth"::text || ':' ||
              shadow."createdAt"::text || ':' || shadow."updatedAt"::text,
              '|' ORDER BY shadow."communeId"
            )) AS fingerprint
          FROM "statistic_publication_state" publication
          CROSS JOIN "historic_backfill_run" run
          LEFT JOIN "historic_backfill_commune_shadow" shadow
            ON shadow."runId" = run."id"
          WHERE publication."id" = 1 AND run."id" = '${RUN_ID}'
          GROUP BY publication."revision",
                   publication."historicPublishedThrough",
                   publication."historicDirtyFrom",
                   publication."historicDirtyThrough",
                   run."baseStatisticRevision", run."statisticsPromotedAt"
        `);
        expect(recovered).toMatchObject({
          revision: '14',
          historicPublishedThrough: '2026-08-18',
          historicDirtyFrom: '2026-08-16',
          historicDirtyThrough: '2026-08-18',
          baseStatisticRevision: '14',
          statisticsPromotedAt: null,
          shadowCount: 101,
          fingerprint: shadowBeforeRecovery.fingerprint,
        });

        await expect(service.buildShadow(RUN_ID)).resolves.toMatchObject({
          departmentCount: 101,
          skippedDepartmentCount: 101,
          communeCount: 101,
          upsertedCount: 0,
          purgedShadowCount: 0,
          rebased: false,
          baseStatisticRevision: '14',
        });
        const [afterRetry] = await dataSource.query(`
          SELECT
            publication."revision"::text AS "revision",
            publication."historicDirtyFrom"::text AS "historicDirtyFrom",
            publication."historicDirtyThrough"::text AS "historicDirtyThrough",
            run."baseStatisticRevision"::text AS "baseStatisticRevision",
            COUNT(shadow.*)::integer AS "shadowCount",
            md5(string_agg(
              shadow."communeId"::text || ':' ||
              shadow."restrictions"::text || ':' ||
              shadow."restrictionsByMonth"::text || ':' ||
              shadow."createdAt"::text || ':' || shadow."updatedAt"::text,
              '|' ORDER BY shadow."communeId"
            )) AS fingerprint
          FROM "statistic_publication_state" publication
          CROSS JOIN "historic_backfill_run" run
          LEFT JOIN "historic_backfill_commune_shadow" shadow
            ON shadow."runId" = run."id"
          WHERE publication."id" = 1 AND run."id" = '${RUN_ID}'
          GROUP BY publication."revision",
                   publication."historicDirtyFrom",
                   publication."historicDirtyThrough",
                   run."baseStatisticRevision"
        `);
        expect(afterRetry).toMatchObject({
          revision: '14',
          historicDirtyFrom: '2026-08-16',
          historicDirtyThrough: '2026-08-18',
          baseStatisticRevision: '14',
          shadowCount: 101,
          fingerprint: shadowBeforeRecovery.fingerprint,
        });
      } finally {
        await dataSource.query(`
          DELETE FROM "historic_backfill_commune_shadow"
          WHERE "runId" = '${RUN_ID}'
        `);
        await dataSource.query(
          `UPDATE "config"
           SET "computeStatsDate" = $1::date
           WHERE "id" = 1`,
          [before.computeStatsDate],
        );
        await dataSource.query(
          `UPDATE "statistic_publication_state"
           SET "revision" = $1::bigint,
               "historicPublishedThrough" = $2::date,
               "historicDirtyFrom" = $3::date,
               "historicDirtyThrough" = $4::date
           WHERE "id" = 1`,
          [
            before.revision,
            before.historicPublishedThrough,
            before.historicDirtyFrom,
            before.historicDirtyThrough,
          ],
        );
        await dataSource.query(
          `UPDATE "historic_backfill_run"
           SET "baseStatisticRevision" = $1::bigint,
               "statisticsPromotedAt" = $2::timestamptz
           WHERE "id" = '${RUN_ID}'`,
          [before.baseStatisticRevision, before.statisticsPromotedAt],
        );
      }
    }, 30_000);

    it('rebases, builds all shadows, dry-runs, and atomically applies statistics', async () => {
      const shadow = await service.buildShadow(RUN_ID);
      expect(shadow).toMatchObject({
        departmentCount: 101,
        skippedDepartmentCount: 0,
        communeCount: 101,
        rebased: true,
        baseStatisticRevision: '13',
      });
      const [rebasedMarker] = await dataSource.query(`
        SELECT "statisticsPromotedAt"
        FROM "historic_backfill_run"
        WHERE "id" = '${RUN_ID}'
      `);
      expect(rebasedMarker.statisticsPromotedAt).toBeNull();
      await expect(service.buildShadow(RUN_ID)).resolves.toMatchObject({
        departmentCount: 101,
        skippedDepartmentCount: 101,
        communeCount: 101,
        upsertedCount: 0,
        rebased: false,
        baseStatisticRevision: '13',
      });
      await dataSource.query(`
        UPDATE "historic_backfill_task"
        SET "segmentCount" = 2
        WHERE "runId" = '${RUN_ID}' AND "departementId" = 1;
        UPDATE "historic_backfill_commune_segment"
        SET "validThrough" = date '2026-08-16'
        WHERE "runId" = '${RUN_ID}' AND "communeId" = 1;
        INSERT INTO "historic_backfill_commune_segment" (
          "runId", "departementId", "communeId", "validFrom", "validThrough",
          "SOU", "SUP", "AEP", "sourceGeneration", "inputSignature"
        ) VALUES (
          '${RUN_ID}', 1, 1, date '2026-08-18', date '2026-08-18',
          NULL, 'alerte', NULL, 3, repeat('b', 64)
        );
      `);
      await expect(
        service.buildDepartmentShadow({
          runId: RUN_ID,
          departementId: 1,
          departmentGeneration: '3',
        }),
      ).rejects.toThrow(HistoricBackfillFinalizerStateError);
      await dataSource.query(`
        DELETE FROM "historic_backfill_commune_segment"
        WHERE "runId" = '${RUN_ID}'
          AND "communeId" = 1
          AND "validFrom" = date '2026-08-18';
        UPDATE "historic_backfill_commune_segment"
        SET "validThrough" = date '2026-08-18'
        WHERE "runId" = '${RUN_ID}' AND "communeId" = 1;
        UPDATE "historic_backfill_task"
        SET "segmentCount" = 1
        WHERE "runId" = '${RUN_ID}' AND "departementId" = 1;
      `);
      await expect(service.inspect(RUN_ID)).resolves.toMatchObject({
        ready: true,
      });
      await expect(service.dryRun(RUN_ID)).resolves.toMatchObject({
        applied: false,
        alreadyApplied: false,
        dateCount: 3,
      });
      await expect(service.apply(RUN_ID)).resolves.toMatchObject({
        applied: true,
        alreadyApplied: false,
        communeCount: 101,
        departmentCount: 101,
        dateCount: 3,
        statsCursor: '2026-08-18',
      });
      await expect(service.apply(RUN_ID)).resolves.toMatchObject({
        applied: true,
        alreadyApplied: true,
        statsCursor: '2026-08-18',
      });

      const [state] = await dataSource.query(`
      SELECT
        run."status", run."baseStatisticRevision"::text,
        run."statisticsPromotedAt",
        config."computeMapDate"::text, config."computeMapGeneration"::text,
        config."computeStatsDate"::text, config."computeStatsGeneration"::text,
        publication."revision"::text,
        publication."historicPublishedThrough"::text,
        publication."historicDirtyFrom"::text,
        publication."historicDirtyThrough"::text
      FROM "historic_backfill_run" run
      CROSS JOIN "config" config
      CROSS JOIN "statistic_publication_state" publication
      WHERE run."id" = '${RUN_ID}' AND config."id" = 1 AND publication."id" = 1
    `);
      expect(state).toMatchObject({
        status: 'running',
        baseStatisticRevision: '14',
        statisticsPromotedAt: expect.any(Date),
        computeMapDate: '2026-08-14',
        computeMapGeneration: '5',
        computeStatsDate: '2026-08-18',
        computeStatsGeneration: '8',
        revision: '14',
        historicPublishedThrough: '2026-08-18',
        historicDirtyFrom: null,
        historicDirtyThrough: null,
      });
      await dataSource.query(`
        UPDATE "statistic_publication_state"
        SET "revision" = "revision" + 1
        WHERE "id" = 1;
        UPDATE "config"
        SET "computeStatsDate" = date '2026-08-20'
        WHERE "id" = 1
      `);
      await expect(service.apply(RUN_ID)).resolves.toMatchObject({
        applied: true,
        alreadyApplied: true,
        statsCursor: '2026-08-20',
        inspection: {
          baseStatisticRevision: '14',
          currentStatisticRevision: '15',
          baseStatisticRevisionMatches: false,
          statisticsPublicationClosed: true,
        },
      });
      const [afterDaily] = await dataSource.query(`
        SELECT run."status", run."baseStatisticRevision"::text,
               publication."revision"::text,
               publication."historicPublishedThrough"::text,
               publication."historicDirtyFrom"::text,
               publication."historicDirtyThrough"::text,
               config."computeMapDate"::text,
               config."computeMapGeneration"::text
        FROM "historic_backfill_run" run
        CROSS JOIN "statistic_publication_state" publication
        CROSS JOIN "config" config
        WHERE run."id" = '${RUN_ID}'
          AND publication."id" = 1
          AND config."id" = 1
      `);
      expect(afterDaily).toMatchObject({
        status: 'running',
        baseStatisticRevision: '14',
        revision: '15',
        historicPublishedThrough: '2026-08-18',
        historicDirtyFrom: null,
        historicDirtyThrough: null,
        computeMapDate: '2026-08-14',
        computeMapGeneration: '5',
      });
      const [coverage] = await dataSource.query(`
      SELECT
        (SELECT COUNT(*) FROM "historic_backfill_commune_shadow")::integer
          AS shadows,
        (SELECT COUNT(*) FROM "statistic_commune_snapshot"
          WHERE "scope" = 'national' AND "status" = 'completed')::integer
          AS national,
        (SELECT COUNT(*) FROM "statistic" WHERE (
          SELECT COUNT(*) FROM json_object_keys("departementSituation")
        ) = 101)::integer AS situations,
        (SELECT "status" FROM "statistic_commune_snapshot"
          WHERE "scope" = 'bootstrap') AS bootstrap,
        (SELECT "status" FROM "statistic_commune_snapshot"
          WHERE "scope" = 'departements:001') AS sibling,
        (SELECT jsonb_array_length("restrictions") FROM "statistic_commune"
          WHERE "communeId" = 1) AS "communeDayCount",
        (SELECT ("restrictionsByMonth" -> 0 ->> 'ponderation')::float8
          FROM "statistic_commune" WHERE "communeId" = 1) AS weight,
        (SELECT jsonb_array_length("restrictions")
          FROM "statistic_departement" WHERE "departementId" = 1)
          AS "departmentDayCount"
    `);
      expect(coverage).toEqual({
        shadows: 101,
        national: 3,
        situations: 3,
        bootstrap: 'completed',
        sibling: 'completed',
        communeDayCount: 5,
        weight: 6,
        departmentDayCount: 5,
      });
    }, 30_000);
  },
);
