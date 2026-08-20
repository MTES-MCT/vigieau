import { DataSource } from 'typeorm';
import { Departement } from '@shared/entities/departement.entity';
import { ZoneAlerteComputedHistoric } from '@shared/entities/zone_alerte_computed_historic.entity';
import {
  HistoricBackfillTaskClaim,
  HistoricBackfillTaskInterruptedError,
} from './historic-backfill.types';
import {
  buildHistoricBackfillStableSegments,
  createHistoricBackfillInputSignature,
  HistoricBackfillCurrentPriority,
  HistoricBackfillDepartmentPayloadBuilder,
  HistoricBackfillLegacyZoneProvider,
  HistoricBackfillMapArtifactBuilder,
  HistoricBackfillTaskHandlerService,
  SqlHistoricBackfillCurrentPriority,
  withHistoricBackfillDepartmentLock,
} from './historic-backfill-task-handler';

const claim = (): HistoricBackfillTaskClaim => ({
  runId: '00000000-0000-4000-8000-000000000001',
  departementId: 65,
  departementCode: '65',
  workerId: 'worker-1',
  leaseToken: '00000000-0000-4000-8000-000000000002',
  departmentGeneration: '7',
  departmentLastPublicRevision: '41',
  attemptCount: 1,
  leaseExpiresAt: new Date('2026-08-19T12:05:00.000Z'),
  progressDate: null,
  segmentCount: 0,
  communeCount: 0,
  artifactPrefix: null,
  mapDateFrom: '2024-04-29',
  statisticDateFrom: '2024-05-03',
  dateThrough: '2024-05-12',
  sourceRevision: '42',
  historicComputeEpoch: '9',
  baseStatisticRevision: '100',
});

function createHarness(options?: {
  boundaries?: string[];
  generations?: string[];
  contexts?: boolean[];
  signal?: AbortSignal;
  legacyZoneProvider?: HistoricBackfillLegacyZoneProvider;
}) {
  const generations = [...(options?.generations ?? ['7'])];
  const contexts = [...(options?.contexts ?? [true])];
  let generationRead = 0;
  let contextRead = 0;
  const departmentSegments = new Map<string, Record<string, unknown>>();
  const communeSegments = new Map<string, Record<string, unknown>>();
  const departmentLockQueries: string[] = [];
  const dataSource = {
    createQueryRunner: jest.fn(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(async (sql: string) => {
        departmentLockQueries.push(sql);
        return sql.includes('pg_try_advisory_lock')
          ? [{ locked: true }]
          : [{ unlocked: true }];
      }),
    })),
    query: jest.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql.includes('revision."generation"::text AS "generation"')) {
        const generation =
          generations[Math.min(generationRead, generations.length - 1)];
        generationRead += 1;
        const contextMatches =
          contexts[Math.min(contextRead, contexts.length - 1)];
        contextRead += 1;
        return [{ generation, contextMatches }];
      }
      if (sql.includes('WITH source_boundaries AS')) {
        return (options?.boundaries ?? ['2024-04-29']).map((boundaryDate) => ({
          boundaryDate,
        }));
      }
      if (sql.includes('INSERT INTO "historic_backfill_department_segment"')) {
        const validFrom = String(parameters?.[2]);
        departmentSegments.set(validFrom, {
          validFrom,
          validThrough: String(parameters?.[3]),
          inputSignature: String(parameters?.[5]),
          restriction: JSON.parse(String(parameters?.[6])),
          situation: JSON.parse(String(parameters?.[7])),
          geojsonObjectKey: String(parameters?.[8]),
          geojsonChecksum: String(parameters?.[9]),
          featureCount: Number(parameters?.[10]),
        });
        return [{ contextMatches: true, upserted: true }];
      }
      if (sql.includes('INSERT INTO "historic_backfill_commune_segment"')) {
        const rows = JSON.parse(String(parameters?.[5] ?? '[]')) as Array<
          Record<string, unknown>
        >;
        for (const row of rows) {
          communeSegments.set(`${row.communeId}/${row.validFrom}`, {
            ...row,
            inputSignature: String(parameters?.[6]),
          });
        }
        return [
          {
            contextMatches: true,
            inputCount: rows.length,
            upsertedCount: rows.length,
          },
        ];
      }
      if (sql.includes('FROM "historic_backfill_department_segment"')) {
        return [...departmentSegments.values()];
      }
      if (sql.includes('FROM "historic_backfill_commune_segment"')) {
        return [...communeSegments.values()];
      }
      throw new Error(`Unexpected query: ${sql}`);
    }),
  } as unknown as DataSource;
  const departement = {
    id: 65,
    code: '65',
    nom: 'Hautes-Pyrenees',
    parametres: [],
  } as unknown as Departement;
  const departementService = {
    findAllLight: jest.fn().mockResolvedValue([departement]),
  };
  const zone = {
    id: 1,
    type: 'SUP',
    departement: { code: '65' },
    restriction: { niveauGravite: 'alerte' },
  } as unknown as ZoneAlerteComputedHistoric;
  const historicZoneService = {
    computeZonesForDate: jest.fn().mockResolvedValue(undefined),
    findZonesForHistoricBackfill: jest.fn().mockResolvedValue([zone]),
  };
  const statisticCommuneService = {
    stageHistoricCommuneStatisticsRestrictions: jest.fn(
      async (_zones, date: Date, stagingOptions) => {
        await stagingOptions.sink.writeSegments({
          runId: stagingOptions.runId,
          departementId: stagingOptions.departementId,
          departementCode: stagingOptions.departementCode,
          computedFor: date.toISOString().slice(0, 10),
          validThrough: stagingOptions.validThrough,
          sourceGeneration: stagingOptions.sourceGeneration,
          inputSignature: stagingOptions.inputSignature,
          offset: 0,
          expectedCommuneCount: 1,
          processedCommuneCount: 1,
          segments: [
            {
              runId: stagingOptions.runId,
              departementId: stagingOptions.departementId,
              communeId: 65001,
              validFrom: date.toISOString().slice(0, 10),
              validThrough: stagingOptions.validThrough,
              SOU: null,
              SUP: 'alerte',
              AEP: null,
              sourceGeneration: stagingOptions.sourceGeneration,
              inputSignature: stagingOptions.inputSignature,
            },
          ],
        });
        return {
          expectedCommuneCount: 1,
          processedCommuneCount: 1,
          segmentCount: 1,
        };
      },
    ),
  };
  const payloadBuilder: HistoricBackfillDepartmentPayloadBuilder = {
    build: jest.fn().mockResolvedValue({ restriction: {}, situation: {} }),
  };
  const mapArtifactBuilder: HistoricBackfillMapArtifactBuilder = {
    buildAndUpload: jest.fn(async (_zones, artifactClaim, validFrom) => ({
      objectKey:
        `historic/run-1/department-revision-${artifactClaim.departmentLastPublicRevision}/` +
        `epoch-${artifactClaim.historicComputeEpoch}/` +
        `generation-${artifactClaim.departmentGeneration}/65/${validFrom}.geojson.gz`,
      checksum: 'b'.repeat(64),
      featureCount: 1,
    })),
  };
  const priority: HistoricBackfillCurrentPriority = {
    shouldYield: jest.fn().mockResolvedValue(false),
  };
  const service = new HistoricBackfillTaskHandlerService(
    dataSource,
    departementService as any,
    historicZoneService as any,
    statisticCommuneService as any,
    options?.legacyZoneProvider,
    payloadBuilder,
    mapArtifactBuilder,
    priority,
  );
  const heartbeat = jest.fn().mockResolvedValue(true);
  const signal = options?.signal ?? new AbortController().signal;

  return {
    service,
    dataSource,
    departementService,
    historicZoneService,
    statisticCommuneService,
    payloadBuilder,
    mapArtifactBuilder,
    departmentSegments,
    communeSegments,
    departmentLockQueries,
    priority,
    context: { signal, heartbeat },
  };
}

describe('historic backfill stable segments', () => {
  it('turns unordered AR and parameter boundaries into contiguous intervals', () => {
    expect(
      buildHistoricBackfillStableSegments('2024-04-29', '2024-05-12', [
        '2024-05-10',
        '2024-05-01',
        '2024-05-05',
        '2024-05-01',
        '2024-05-20',
      ]),
    ).toEqual([
      { validFrom: '2024-04-29', validThrough: '2024-04-30' },
      { validFrom: '2024-05-01', validThrough: '2024-05-04' },
      { validFrom: '2024-05-05', validThrough: '2024-05-09' },
      { validFrom: '2024-05-10', validThrough: '2024-05-12' },
    ]);
  });

  it('builds a locally fenced signature independent from global rebases', () => {
    const input = {
      departementId: 65,
      departementCode: '65',
      departmentGeneration: '7',
      departmentLastPublicRevision: '41',
      sourceRevision: '42',
      historicComputeEpoch: '9',
      baseStatisticRevision: '100',
      validFrom: '2024-05-01',
      validThrough: '2024-05-04',
      legacy: false,
    };
    const first = createHistoricBackfillInputSignature(input);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(createHistoricBackfillInputSignature({ ...input })).toBe(first);
    const globallyRebasedInput = { ...input, sourceRevision: '43' };
    expect(createHistoricBackfillInputSignature(globallyRebasedInput)).toBe(
      first,
    );
    expect(
      createHistoricBackfillInputSignature({
        ...input,
        departmentLastPublicRevision: '42',
      }),
    ).not.toBe(first);
    expect(
      createHistoricBackfillInputSignature({
        ...input,
        departmentGeneration: '8',
      }),
    ).not.toBe(first);
  });
});

describe('historic backfill department lock', () => {
  it('lets distinct departments compute under the shared historic lock', async () => {
    const queries: Array<{ sql: string; parameters?: unknown[] }> = [];
    const dataSource = {
      createQueryRunner: jest.fn(() => ({
        connect: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
        query: jest.fn(async (sql: string, parameters?: unknown[]) => {
          queries.push({ sql, parameters });
          return sql.includes('pg_try_advisory_lock')
            ? [{ locked: true }]
            : [{ unlocked: true }];
        }),
      })),
    } as unknown as DataSource;
    let active = 0;
    let maxActive = 0;
    let signalBothStarted!: () => void;
    let releaseTasks!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      signalBothStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseTasks = resolve;
    });
    const task = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 2) {
        signalBothStarted();
      }
      await release;
      active -= 1;
    };

    const computations = [
      withHistoricBackfillDepartmentLock(dataSource, 65, task),
      withHistoricBackfillDepartmentLock(dataSource, 66, task),
    ];
    await bothStarted;
    releaseTasks();
    await Promise.all(computations);

    expect(maxActive).toBe(2);
    expect(queries.map(({ sql }) => sql).join('\n')).not.toContain(
      'zone-compute-global',
    );
    expect(queries.map(({ sql }) => sql).join('\n')).not.toContain(
      'sandre-zone-sync',
    );
    expect(queries.map(({ sql }) => sql).join('\n')).toContain(
      'vigieau:historic-backfill-department',
    );
    expect(queries.map(({ sql }) => sql).join('\n')).toContain(
      'pg_try_advisory_lock_shared',
    );
    expect(queries.map(({ sql }) => sql).join('\n')).toContain(
      'zone-compute-historic',
    );
    expect(
      queries
        .filter(
          ({ sql }) =>
            sql.includes('pg_try_advisory_lock(') &&
            sql.includes('vigieau:historic-backfill-department'),
        )
        .map(({ parameters }) => parameters),
    ).toEqual([[65], [66]]);
  });

  it('does not run when the same department lock is already held', async () => {
    const task = jest.fn();
    const release = jest.fn().mockResolvedValue(undefined);
    const dataSource = {
      createQueryRunner: jest.fn(() => ({
        connect: jest.fn().mockResolvedValue(undefined),
        release,
        query: jest.fn().mockResolvedValue([{ locked: false }]),
      })),
    } as unknown as DataSource;

    await expect(
      withHistoricBackfillDepartmentLock(dataSource, 65, task),
    ).resolves.toEqual({ acquired: false });
    expect(task).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('HistoricBackfillTaskHandlerService', () => {
  it('computes stable segments sequentially and stages clipped statistic intervals', async () => {
    const harness = createHarness({
      boundaries: ['2024-04-29', '2024-05-01', '2024-05-10'],
    });

    const output = await harness.service.handle(claim(), harness.context);

    const boundaryCall = jest
      .mocked(harness.dataSource.query)
      .mock.calls.find(([sql]) => sql.includes('WITH source_boundaries AS'));
    expect(boundaryCall?.[0]).toContain(`ar."statut" IN ('publie', 'abroge')`);
    expect(boundaryCall?.[0]).toContain('ar."dateFin" + 1');
    expect(boundaryCall?.[0]).toContain('parametres."dateFin" + 1');
    expect(
      harness.historicZoneService.computeZonesForDate,
    ).toHaveBeenCalledTimes(3);
    expect(
      harness.historicZoneService.computeZonesForDate.mock.calls.every(
        ([, , options]) => options.expectedSourceRevision === undefined,
      ),
    ).toBe(true);
    expect(harness.departmentLockQueries.join('\n')).not.toContain(
      'zone-compute-global',
    );
    expect(
      harness.statisticCommuneService.stageHistoricCommuneStatisticsRestrictions.mock.calls.map(
        ([, date, options]) => [
          date.toISOString().slice(0, 10),
          options.validThrough,
        ],
      ),
    ).toEqual([
      ['2024-05-03', '2024-05-09'],
      ['2024-05-10', '2024-05-12'],
    ]);
    expect(harness.payloadBuilder.build).toHaveBeenCalledTimes(3);
    expect(harness.payloadBuilder.build).toHaveBeenCalledWith(
      expect.any(Array),
      '2024-04-29',
      false,
      { departementId: 65, departementCode: '65' },
    );
    expect(harness.mapArtifactBuilder.buildAndUpload).toHaveBeenCalledTimes(3);
    expect(harness.departmentSegments.size).toBe(3);
    expect(harness.communeSegments.size).toBe(2);
    expect(
      jest
        .mocked(harness.dataSource.query)
        .mock.calls.some(([sql]) =>
          sql.includes('COUNT(DISTINCT "communeId")::integer'),
        ),
    ).toBe(false);
    expect(
      harness.context.heartbeat.mock.calls.map(([progress]) => [
        progress.progressDate,
        progress.segmentCount,
      ]),
    ).toEqual([
      ['2024-04-30', 0],
      ['2024-05-09', 1],
      ['2024-05-12', 2],
    ]);
    const departmentUpsert = jest
      .mocked(harness.dataSource.query)
      .mock.calls.find(([sql]) =>
        sql.includes('INSERT INTO "historic_backfill_department_segment"'),
      );
    const communeUpsert = jest
      .mocked(harness.dataSource.query)
      .mock.calls.find(([sql]) =>
        sql.includes('INSERT INTO "historic_backfill_commune_segment"'),
      );
    expect(departmentUpsert?.[0]).toContain('FOR UPDATE OF task, revision');
    expect(departmentUpsert?.[0]).toContain('"geojsonObjectKey"');
    expect(communeUpsert?.[0]).toContain('FOR UPDATE OF task, revision');
    for (const [sql] of jest
      .mocked(harness.dataSource.query)
      .mock.calls.filter(
        ([statement]) =>
          statement.includes('revision."generation"::text AS "generation"') ||
          statement.includes(
            'INSERT INTO "historic_backfill_department_segment"',
          ) ||
          statement.includes('INSERT INTO "historic_backfill_commune_segment"'),
      )) {
      expect(sql).toMatch(
        /run\."historicBackfillGlobalEpoch"\s*=\s*config\."historicBackfillGlobalEpoch"/,
      );
    }
    expect(output).toMatchObject({
      progressDate: '2024-05-12',
      segmentCount: 2,
      communeCount: 1,
      artifactPrefix:
        'historic/run-1/department-revision-41/epoch-9/generation-7/65',
      outputSignature: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('rebuilds retry-safe heartbeat counters without rescanning staged rows', async () => {
    const harness = createHarness({
      boundaries: ['2024-04-29', '2024-05-01', '2024-05-10'],
    });
    await harness.service.handle(claim(), harness.context);
    harness.context.heartbeat.mockClear();
    jest.mocked(harness.dataSource.query).mockClear();

    const output = await harness.service.handle(
      {
        ...claim(),
        progressDate: '2024-05-09',
        segmentCount: 1,
        communeCount: 1,
      },
      harness.context,
    );

    expect(harness.context.heartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        progressDate: '2024-05-12',
        segmentCount: 2,
        communeCount: 1,
      }),
    );
    expect(output).toMatchObject({ segmentCount: 2, communeCount: 1 });
    expect(
      jest
        .mocked(harness.dataSource.query)
        .mock.calls.some(([sql]) =>
          sql.includes('COUNT(DISTINCT "communeId")::integer'),
        ),
    ).toBe(false);
  });

  it('splits the legacy/computed transition into two stable segments', async () => {
    const legacyZoneProvider: HistoricBackfillLegacyZoneProvider = {
      computeAndFindZones: jest.fn().mockResolvedValue([]),
    };
    const harness = createHarness({
      boundaries: [],
      legacyZoneProvider,
    });
    const transitionClaim = {
      ...claim(),
      mapDateFrom: '2024-04-27',
      statisticDateFrom: '2024-04-27',
      dateThrough: '2024-04-30',
    };

    await harness.service.handle(transitionClaim, harness.context);

    expect(legacyZoneProvider.computeAndFindZones).toHaveBeenCalledTimes(1);
    expect(legacyZoneProvider.computeAndFindZones).toHaveBeenCalledWith(
      expect.objectContaining({ id: 65 }),
      '2024-04-27',
      expect.objectContaining({
        signal: harness.context.signal,
        departmentGeneration: '7',
      }),
    );
    const legacyContext = jest.mocked(legacyZoneProvider.computeAndFindZones)
      .mock.calls[0][2];
    expect(legacyContext).not.toHaveProperty('sourceRevision');
    expect(
      harness.historicZoneService.computeZonesForDate,
    ).toHaveBeenCalledTimes(1);
    const [computedDate, , checkpoint] =
      harness.historicZoneService.computeZonesForDate.mock.calls[0];
    expect(computedDate.format('YYYY-MM-DD')).toBe('2024-04-29');
    expect(checkpoint.previousDate).toBe('2024-04-27');
    expect(
      harness.context.heartbeat.mock.calls.map(
        ([progress]) => progress.progressDate,
      ),
    ).toEqual(['2024-04-28', '2024-04-30']);
    expect(
      jest
        .mocked(harness.mapArtifactBuilder.buildAndUpload)
        .mock.calls.map(([, , validFrom, validThrough, legacy, context]) => [
          validFrom,
          validThrough,
          legacy,
          context.signal,
        ]),
    ).toEqual([
      ['2024-04-27', '2024-04-28', true, harness.context.signal],
      ['2024-04-29', '2024-04-30', false, harness.context.signal],
    ]);
  });

  it('keeps persisted output stable after another department rebases the run', async () => {
    const harness = createHarness({
      boundaries: ['2024-04-29', '2024-05-10'],
    });

    const first = await harness.service.handle(claim(), harness.context);
    const second = await harness.service.handle(
      { ...claim(), sourceRevision: '43' },
      harness.context,
    );

    expect(second.outputSignature).toBe(first.outputSignature);
    expect(second.segmentCount).toBe(first.segmentCount);
    expect(second.artifactPrefix).toBe(first.artifactPrefix);
    expect(harness.communeSegments.size).toBe(2);
  });

  it('interrupts after spatial work when the department generation mutates', async () => {
    const harness = createHarness({
      boundaries: ['2024-04-29'],
      generations: ['7', '7', '7', '8'],
    });

    await expect(
      harness.service.handle(claim(), harness.context),
    ).rejects.toMatchObject({
      name: 'HistoricBackfillTaskInterruptedError',
      reason: 'generation-changed',
    });
    expect(
      harness.historicZoneService.computeZonesForDate,
    ).toHaveBeenCalledTimes(1);
    expect(harness.payloadBuilder.build).not.toHaveBeenCalled();
    expect(harness.mapArtifactBuilder.buildAndUpload).not.toHaveBeenCalled();
    expect(
      harness.statisticCommuneService
        .stageHistoricCommuneStatisticsRestrictions,
    ).not.toHaveBeenCalled();
  });

  it('interrupts after spatial work when the lease or epoch is lost', async () => {
    const harness = createHarness({
      boundaries: ['2024-04-29'],
      contexts: [true, true, true, false],
    });

    await expect(
      harness.service.handle(claim(), harness.context),
    ).rejects.toMatchObject({
      name: 'HistoricBackfillTaskInterruptedError',
      reason: 'aborted',
    });
    expect(
      harness.historicZoneService.computeZonesForDate,
    ).toHaveBeenCalledTimes(1);
    expect(harness.payloadBuilder.build).not.toHaveBeenCalled();
  });

  it('honours an already aborted task before reading source data', async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = createHarness({ signal: controller.signal });

    await expect(
      harness.service.handle(claim(), harness.context),
    ).rejects.toBeInstanceOf(HistoricBackfillTaskInterruptedError);
    expect(harness.departementService.findAllLight).not.toHaveBeenCalled();
    expect(harness.dataSource.query).not.toHaveBeenCalled();
  });

  it('yields when current work arrives after the spatial computation', async () => {
    const harness = createHarness({ boundaries: ['2024-04-29'] });
    jest
      .mocked(harness.priority.shouldYield)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(
      harness.service.handle(claim(), harness.context),
    ).rejects.toMatchObject({
      name: 'HistoricBackfillTaskInterruptedError',
      reason: 'current-priority',
    });
    expect(
      harness.historicZoneService.computeZonesForDate,
    ).toHaveBeenCalledTimes(1);
    expect(harness.payloadBuilder.build).not.toHaveBeenCalled();
    expect(harness.mapArtifactBuilder.buildAndUpload).not.toHaveBeenCalled();
  });

  it('detects queued work, running snapshots or a running daily job', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([{ shouldYield: true }]),
    } as unknown as DataSource;
    const priority = new SqlHistoricBackfillCurrentPriority(dataSource);

    await expect(priority.shouldYield(65)).resolves.toBe(true);
    const sql = jest.mocked(dataSource.query).mock.calls[0][0];
    expect(sql).toContain('request."currentPending"');
    expect(sql).toContain('pending_date <=');
    expect(sql).toContain('daily_run."jobKey" = \'compute:national-daily\'');
    expect(sql).toContain('daily_run."status" = \'running\'');
    expect(sql).toContain('FROM "statistic_commune_snapshot" snapshot');
    expect(sql).toContain('snapshot."status" = \'running\'');
  });
});
