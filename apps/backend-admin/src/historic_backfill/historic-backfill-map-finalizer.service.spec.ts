import { createHash } from 'node:crypto';
import {
  HISTORIC_BACKFILL_ARTIFACT_HEAD_CONCURRENCY_DEFAULT,
  HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS_DEFAULT,
  HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS_MAX,
  HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS_MIN,
  HistoricBackfillMapFinalizerService,
  readHistoricBackfillArtifactHeadConcurrency,
  readHistoricBackfillManifestUploadTimeout,
} from './historic-backfill-map-finalizer.service';

describe('HistoricBackfillMapFinalizerService', () => {
  const originalHeadConcurrency =
    process.env.HISTORIC_BACKFILL_ARTIFACT_HEAD_CONCURRENCY;
  const originalManifestUploadTimeout =
    process.env.HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS;
  const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const context = {
    id: runId,
    status: 'running',
    mapDateFrom: '2026-08-01',
    statisticDateFrom: '2026-08-01',
    dateThrough: '2026-08-03',
    sourceRevision: '42',
    currentSourceRevision: '42',
    historicComputeEpoch: '9',
    currentHistoricComputeEpoch: '9',
    historicBackfillGlobalEpoch: '5',
    currentHistoricBackfillGlobalEpoch: '5',
    statisticsPromotedAt: '2026-08-20T09:30:00.000Z' as string | null,
    computeMapDate: '2026-08-01',
    computeMapGeneration: '12',
    computeStatsDate: '2026-08-03',
    currentStatisticRevision: '76',
    historicPublishedThrough: '2026-07-31',
    historicDirtyFrom: '2026-08-01',
    historicDirtyThrough: '2026-08-03',
    departmentTaskCount: 101,
    currentDepartmentTaskCount: 101,
    currentQueueCount: 0,
    runningSnapshotCount: 0,
    runningDailyCount: 0,
  };
  const immutablePrefix = `historic-backfill/${runId}/national/revision-42/epoch-9/`;
  const artifacts = [
    {
      validFrom: '2026-08-01',
      validThrough: '2026-08-02',
      sourceRevision: '42',
      historicComputeEpoch: '9',
      status: 'completed',
      geojsonChecksum: 'a'.repeat(64),
      pmtilesChecksum: 'b'.repeat(64),
      featureCount: 12,
      geojsonObjectKey: `${immutablePrefix}2026-08-01-${'a'.repeat(64)}.geojson`,
      pmtilesObjectKey: `${immutablePrefix}2026-08-01-${'b'.repeat(64)}.pmtiles`,
    },
    {
      validFrom: '2026-08-03',
      validThrough: '2026-08-03',
      sourceRevision: '42',
      historicComputeEpoch: '9',
      status: 'completed',
      geojsonChecksum: 'c'.repeat(64),
      pmtilesChecksum: 'd'.repeat(64),
      featureCount: 14,
      geojsonObjectKey: `${immutablePrefix}2026-08-03-${'c'.repeat(64)}.geojson`,
      pmtilesObjectKey: `${immutablePrefix}2026-08-03-${'d'.repeat(64)}.pmtiles`,
    },
  ];
  function createHarness(options: { failPublishCommitOnce?: boolean } = {}) {
    let outbox: Record<string, any> | null = null;
    let failPublishCommit = options.failPublishCommitOnce === true;
    let publishCurrentQueueCount = 0;
    let publishRunningSnapshotCount = 0;
    let publishRunningDailyCount = 0;
    let manifestPublicationLocked = false;
    const s3Service = {
      headFile: jest.fn().mockResolvedValue({ ContentLength: 128 }),
      getPublicFileUrl: jest.fn(
        (key: string) => `https://objects.example.test/${key}`,
      ),
      uploadFile: jest.fn().mockResolvedValue({}),
    };
    const runners: any[] = [];
    const createRunner = () => {
      let transactionOutbox: Record<string, any> | null = null;
      let transactionAcknowledged = false;
      const runner = {
        connect: jest.fn().mockResolvedValue(undefined),
        startTransaction: jest.fn(async () => {
          transactionOutbox = outbox ? { ...outbox } : null;
        }),
        commitTransaction: jest.fn(async () => {
          if (transactionAcknowledged && failPublishCommit) {
            failPublishCommit = false;
            throw new Error('ACK commit unavailable');
          }
          transactionOutbox = null;
          transactionAcknowledged = false;
        }),
        rollbackTransaction: jest.fn(async () => {
          outbox = transactionOutbox ? { ...transactionOutbox } : null;
          transactionOutbox = null;
          transactionAcknowledged = false;
        }),
        release: jest.fn().mockResolvedValue(undefined),
        query: jest.fn(async (sql: string, parameters?: unknown[]) => {
          if (sql.includes('pg_try_advisory_lock')) {
            if (
              parameters?.[0] === 'historic-backfill-map-manifest-publication'
            ) {
              if (manifestPublicationLocked) return [{ locked: false }];
              manifestPublicationLocked = true;
            }
            return [{ locked: true }];
          }
          if (sql.includes('pg_advisory_unlock')) {
            if (
              parameters?.[0] === 'historic-backfill-map-manifest-publication'
            ) {
              manifestPublicationLocked = false;
            }
            return [{ unlocked: true }];
          }
          if (sql.includes('AS "statisticsPromotedCount"')) {
            return [
              {
                currentQueueCount: publishCurrentQueueCount,
                runningSnapshotCount: publishRunningSnapshotCount,
                runningDailyCount: publishRunningDailyCount,
                statisticsPromotedCount: context.statisticsPromotedAt ? 1 : 0,
              },
            ];
          }
          if (sql.includes('FROM "historic_backfill_map_manifest_outbox"')) {
            return outbox ? [outbox] : [];
          }
          if (sql.includes('UPDATE "config"')) {
            return [[{ computeMapGeneration: '13' }], 1];
          }
          if (sql.includes('FROM "historic_backfill_run" run')) {
            return [context];
          }
          if (sql.includes('FROM "historic_backfill_artifact_task" task')) {
            return artifacts;
          }
          if (sql.includes('UPDATE "statistic_publication_state"')) {
            return [[{ revision: '77' }], 1];
          }
          if (
            sql.includes('INSERT INTO "historic_backfill_map_manifest_outbox"')
          ) {
            outbox = {
              runId: parameters?.[0],
              status: 'pending',
              mapDateFrom: parameters?.[1],
              dateThrough: parameters?.[2],
              sourceRevision: parameters?.[3],
              historicComputeEpoch: parameters?.[4],
              mapGeneration: parameters?.[5],
              statisticRevision: parameters?.[6],
              artifactTaskCount: parameters?.[7],
              dayCount: parameters?.[8],
              manifestObjectKey: parameters?.[9],
              manifestBody: parameters?.[10],
              manifestChecksum: parameters?.[11],
              publishedAt: null,
            };
            return [[outbox], 1];
          }
          if (sql.includes('UPDATE "historic_backfill_map_manifest_outbox"')) {
            if (!outbox || outbox.status !== 'pending') {
              return [[], 0];
            }
            outbox = {
              ...outbox,
              status: 'published',
              publishedAt: new Date('2026-08-20T00:00:00.000Z'),
            };
            transactionAcknowledged = true;
            return [[{ id: parameters?.[0] }], 1];
          }
          if (sql.includes('UPDATE "historic_backfill_run"')) {
            return [[{ id: parameters?.[0] }], 1];
          }
          throw new Error(`Unexpected runner query: ${sql}`);
        }),
      };
      runners.push(runner);
      return runner;
    };
    const dataSource = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM "historic_backfill_map_manifest_outbox"')) {
          return outbox ? [outbox] : [];
        }
        if (sql.includes('FROM "historic_backfill_run" run')) {
          return [context];
        }
        if (sql.includes('FROM "historic_backfill_artifact_task" task')) {
          return artifacts;
        }
        throw new Error(`Unexpected SELECT: ${sql}`);
      }),
      createQueryRunner: jest.fn(createRunner),
    };
    const service = new HistoricBackfillMapFinalizerService(
      dataSource as any,
      s3Service as any,
    );
    return {
      dataSource,
      getOutbox: () => outbox,
      setOutbox: (value: Record<string, any>) => {
        outbox = { ...value };
      },
      runners,
      setPublishPriority: (priority: {
        currentQueueCount?: number;
        runningSnapshotCount?: number;
        runningDailyCount?: number;
      }) => {
        publishCurrentQueueCount = priority.currentQueueCount ?? 0;
        publishRunningSnapshotCount = priority.runningSnapshotCount ?? 0;
        publishRunningDailyCount = priority.runningDailyCount ?? 0;
      },
      s3Service,
      service,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.HISTORIC_BACKFILL_ARTIFACT_HEAD_CONCURRENCY;
    delete process.env.HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS;
  });

  afterAll(() => {
    if (originalHeadConcurrency === undefined) {
      delete process.env.HISTORIC_BACKFILL_ARTIFACT_HEAD_CONCURRENCY;
    } else {
      process.env.HISTORIC_BACKFILL_ARTIFACT_HEAD_CONCURRENCY =
        originalHeadConcurrency;
    }
    if (originalManifestUploadTimeout === undefined) {
      delete process.env.HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS;
    } else {
      process.env.HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS =
        originalManifestUploadTimeout;
    }
  });

  it('dry-runs without validating objects or writing the outbox', async () => {
    const { dataSource, s3Service, service } = createHarness();

    await expect(service.dryRun(runId)).resolves.toEqual({
      runId,
      mode: 'dry-run',
      mapDateFrom: '2026-08-01',
      dateThrough: '2026-08-03',
      artifactTaskCount: 2,
      dayCount: 3,
      copiedObjectCount: 0,
      verifiedObjectCount: 0,
      manifestObjectKey: 'pmtiles/historic-backfill-manifest.json',
      mapGeneration: '13',
    });

    expect(s3Service.headFile).not.toHaveBeenCalled();
    expect(s3Service.uploadFile).not.toHaveBeenCalled();
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('refuses dry-run and apply until this run promoted its statistics', async () => {
    const { dataSource, s3Service, service } = createHarness();
    const previousStatisticsPromotedAt = context.statisticsPromotedAt;
    context.statisticsPromotedAt = null;

    try {
      await expect(service.dryRun(runId)).rejects.toThrow(
        'Historic statistics have not been promoted for this run',
      );
      await expect(service.apply(runId)).rejects.toThrow(
        'Historic statistics have not been promoted for this run',
      );
    } finally {
      context.statisticsPromotedAt = previousStatisticsPromotedAt;
    }

    expect(s3Service.headFile).not.toHaveBeenCalled();
    expect(s3Service.uploadFile).not.toHaveBeenCalled();
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('accepts cursors beyond the run without regressing the map cursor', async () => {
    const { dataSource, runners, service } = createHarness();
    const originalContext = { ...context };
    Object.assign(context, {
      computeStatsDate: '2026-08-20',
      computeMapDate: '2026-08-21',
    });

    try {
      await expect(service.dryRun(runId)).resolves.toMatchObject({
        mode: 'dry-run',
        dateThrough: '2026-08-03',
      });
      await expect(service.apply(runId)).resolves.toMatchObject({
        mode: 'applied',
        dateThrough: '2026-08-03',
      });
    } finally {
      Object.assign(context, originalContext);
    }

    const inspectionSql = dataSource.query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('FROM "historic_backfill_run" run'))!;
    expect(inspectionSql).toContain(
      'config."computeStatsDate"::text AS "computeStatsDate"',
    );
    const promotionSql = runners[0].query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('UPDATE "config"'))!;
    expect(promotionSql).toContain('"computeMapDate" = GREATEST(');
    expect(promotionSql).toContain('config."computeStatsDate" >= $1::date');
  });

  it('resumes maps after statistics were published without reopening or rebumping their boundary', async () => {
    const { getOutbox, runners, service } = createHarness();
    const originalContext = { ...context };
    Object.assign(context, {
      computeMapDate: '2026-08-01',
      computeStatsDate: '2026-08-20',
      currentStatisticRevision: '77',
      historicPublishedThrough: '2026-08-03',
      historicDirtyFrom: null,
      historicDirtyThrough: null,
    });

    try {
      await expect(service.apply(runId)).resolves.toMatchObject({
        mode: 'applied',
        statisticRevision: '77',
      });
    } finally {
      Object.assign(context, originalContext);
    }

    const preparationSql = runners[0].query.mock.calls
      .map(([sql]) => String(sql))
      .join('\n');
    expect(preparationSql).toContain('UPDATE "config" config');
    expect(preparationSql).not.toContain(
      'UPDATE "statistic_publication_state"',
    );
    expect(getOutbox()).toEqual(
      expect.objectContaining({ statisticRevision: '77', status: 'published' }),
    );
  });

  it('refuses dry-run and apply when the global epoch changed', async () => {
    const { dataSource, s3Service, service } = createHarness();
    const previousGlobalEpoch = context.currentHistoricBackfillGlobalEpoch;
    context.currentHistoricBackfillGlobalEpoch = '6';

    try {
      await expect(service.dryRun(runId)).rejects.toThrow(
        'Historic backfill global epoch changed',
      );
      await expect(service.apply(runId)).rejects.toThrow(
        'Historic backfill global epoch changed',
      );
    } finally {
      context.currentHistoricBackfillGlobalEpoch = previousGlobalEpoch;
    }

    expect(s3Service.headFile).not.toHaveBeenCalled();
    expect(s3Service.uploadFile).not.toHaveBeenCalled();
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('revalidates statistics promotion inside the preparation transaction', async () => {
    const { getOutbox, runners, s3Service, service } = createHarness();
    const previousStatisticsPromotedAt = context.statisticsPromotedAt;
    let checkedObjectCount = 0;
    s3Service.headFile.mockImplementation(async () => {
      checkedObjectCount += 1;
      if (checkedObjectCount === artifacts.length * 2) {
        context.statisticsPromotedAt = null;
      }
      return { ContentLength: 128 };
    });

    try {
      await expect(service.apply(runId)).rejects.toThrow(
        'Historic statistics have not been promoted for this run',
      );
    } finally {
      context.statisticsPromotedAt = previousStatisticsPromotedAt;
    }

    expect(runners).toHaveLength(1);
    expect(runners[0].rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(getOutbox()).toBeNull();
    expect(s3Service.uploadFile).not.toHaveBeenCalled();
  });

  it('commits a durable pending outbox before publishing and ACKing it', async () => {
    const { dataSource, getOutbox, runners, s3Service, service } =
      createHarness();

    await expect(service.apply(runId)).resolves.toEqual({
      runId,
      mode: 'applied',
      mapDateFrom: '2026-08-01',
      dateThrough: '2026-08-03',
      artifactTaskCount: 2,
      dayCount: 3,
      copiedObjectCount: 0,
      verifiedObjectCount: 4,
      manifestObjectKey: 'pmtiles/historic-backfill-manifest.json',
      mapGeneration: '13',
      statisticRevision: '77',
    });

    expect(runners).toHaveLength(2);
    expect(runners[0].commitTransaction).toHaveBeenCalledTimes(1);
    expect(runners[1].commitTransaction).toHaveBeenCalledTimes(2);
    expect(runners[1].startTransaction).toHaveBeenNthCalledWith(
      1,
      'READ COMMITTED',
    );
    expect(runners[1].startTransaction).toHaveBeenNthCalledWith(
      2,
      'READ COMMITTED',
    );
    expect(
      runners[0].commitTransaction.mock.invocationCallOrder[0],
    ).toBeLessThan(s3Service.uploadFile.mock.invocationCallOrder[0]);
    expect(
      runners[1].commitTransaction.mock.invocationCallOrder[0],
    ).toBeLessThan(s3Service.uploadFile.mock.invocationCallOrder[0]);
    expect(s3Service.uploadFile.mock.invocationCallOrder[0]).toBeLessThan(
      runners[1].release.mock.invocationCallOrder[0],
    );
    expect(
      runners[1].query.mock.calls.some(
        ([sql, parameters]) =>
          String(sql).includes('pg_try_advisory_lock') &&
          parameters?.[0] === 'historic-backfill-map-manifest-publication',
      ),
    ).toBe(true);
    expect(
      runners[1].query.mock.calls.some(([sql]) =>
        String(sql).includes('zone-compute-global'),
      ),
    ).toBe(false);
    expect(
      runners[1].query.mock.calls.some(
        ([sql, parameters]) =>
          String(sql).includes('pg_try_advisory_lock') &&
          parameters?.[0] === 'vigieau:statistic-commune:snapshot-computation',
      ),
    ).toBe(false);
    const publishQueries = runners[1].query.mock.calls;
    const ackCall = publishQueries.find(([sql]) =>
      String(sql).includes('UPDATE "historic_backfill_map_manifest_outbox"'),
    );
    const runCompletionCall = publishQueries.find(([sql]) =>
      String(sql).includes('UPDATE "historic_backfill_run"'),
    );
    const unlockCall = publishQueries.find(
      ([sql, parameters]) =>
        String(sql).includes('pg_advisory_unlock') &&
        parameters?.[0] === 'historic-backfill-map-manifest-publication',
    );
    const ackIndex = publishQueries.indexOf(ackCall as any);
    const runCompletionIndex = publishQueries.indexOf(runCompletionCall as any);
    const unlockIndex = publishQueries.indexOf(unlockCall as any);
    expect(ackIndex).toBeGreaterThanOrEqual(0);
    expect(runCompletionIndex).toBeGreaterThanOrEqual(0);
    expect(unlockIndex).toBeGreaterThanOrEqual(0);
    expect(s3Service.uploadFile.mock.invocationCallOrder[0]).toBeLessThan(
      runners[1].query.mock.invocationCallOrder[ackIndex],
    );
    expect(runners[1].query.mock.invocationCallOrder[ackIndex]).toBeLessThan(
      runners[1].query.mock.invocationCallOrder[runCompletionIndex],
    );
    expect(
      runners[1].query.mock.invocationCallOrder[runCompletionIndex],
    ).toBeLessThan(runners[1].query.mock.invocationCallOrder[unlockIndex]);
    expect(
      runners[1].commitTransaction.mock.invocationCallOrder[1],
    ).toBeLessThan(runners[1].query.mock.invocationCallOrder[unlockIndex]);
    expect(
      runners[1].commitTransaction.mock.invocationCallOrder[1],
    ).toBeLessThan(runners[1].release.mock.invocationCallOrder[0]);
    expect(getOutbox()).toEqual(
      expect.objectContaining({
        status: 'published',
        publishedAt: expect.any(Date),
      }),
    );

    expect(s3Service.headFile).toHaveBeenCalledTimes(4);
    expect(s3Service.uploadFile).toHaveBeenCalledTimes(1);
    const [manifestFile, manifestPrefix, manifestOptions] =
      s3Service.uploadFile.mock.calls[0];
    expect(manifestFile.originalname).toBe('historic-backfill-manifest.json');
    expect(manifestPrefix).toBe('pmtiles/');
    expect(manifestOptions).toEqual({
      acl: 'public-read',
      cacheControl: 'public, max-age=0, must-revalidate',
      contentType: 'application/json',
      abortSignal: expect.any(AbortSignal),
    });
    const manifestBody = manifestFile.buffer.toString('utf8');
    const parsedManifest = JSON.parse(manifestBody);
    expect(parsedManifest.artifacts).toHaveLength(2);
    expect(parsedManifest.artifacts[0].pmtilesUrl).toContain(
      `/revision-42/epoch-9/2026-08-01-${'b'.repeat(64)}.pmtiles`,
    );
    expect(getOutbox()?.manifestChecksum).toBe(
      createHash('sha256').update(manifestBody).digest('hex'),
    );

    const inspectionSql = dataSource.query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('AS "currentQueueCount"'))!;
    const promotionSql = runners[0].query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('UPDATE "config"'))!;
    const pendingRecheckSql = runners[1].query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('AS "currentQueueCount"'))!;
    const transactionalInspectionSql = runners[0].query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('FROM "historic_backfill_run" run'))!;
    for (const sql of [inspectionSql, transactionalInspectionSql]) {
      expect(sql).toContain(
        'run."statisticsPromotedAt" AS "statisticsPromotedAt"',
      );
      expect(sql).toContain('run."historicBackfillGlobalEpoch"::text');
      expect(sql).toContain('config."historicBackfillGlobalEpoch"::text');
    }
    expect(promotionSql).toMatch(
      /run\."historicBackfillGlobalEpoch"\s*=\s*config\."historicBackfillGlobalEpoch"/,
    );
    expect(pendingRecheckSql).toContain(
      'run."statisticsPromotedAt" IS NOT NULL',
    );
    for (const sql of [inspectionSql, promotionSql, pendingRecheckSql]) {
      expect(sql).toContain('request."currentPending"');
      expect(sql).toContain('unnest(request."pendingScheduledDates")');
      expect(sql).toContain("AT TIME ZONE 'Europe/Paris'");
      expect(sql).toContain('FROM "external_publication_run" daily_run');
      expect(sql).toContain('daily_run."jobKey" = \'compute:national-daily\'');
      expect(sql).toContain('daily_run."status" = \'running\'');
    }
  });

  it('blocks initial preparation while the national daily run is active', async () => {
    const { dataSource, s3Service, service } = createHarness();
    const previousRunningDailyCount = context.runningDailyCount;
    context.runningDailyCount = 1;

    try {
      await expect(service.apply(runId)).rejects.toThrow(
        'Current computation has priority over historic maps',
      );
    } finally {
      context.runningDailyCount = previousRunningDailyCount;
    }

    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    expect(s3Service.headFile).not.toHaveBeenCalled();
    expect(s3Service.uploadFile).not.toHaveBeenCalled();
  });

  it('does not create an outbox when immutable validation fails', async () => {
    const { dataSource, getOutbox, s3Service, service } = createHarness();
    s3Service.headFile.mockRejectedValueOnce(new Error('S3 unavailable'));

    await expect(service.apply(runId)).rejects.toThrow('S3 unavailable');

    expect(getOutbox()).toBeNull();
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    expect(s3Service.uploadFile).not.toHaveBeenCalled();
  });

  it('ACKs an uploaded pending publication when the run was paused', async () => {
    const { getOutbox, runners, s3Service, service } = createHarness();
    const previousStatus = context.status;
    s3Service.uploadFile.mockImplementationOnce(async () => {
      context.status = 'paused';
      return {};
    });

    try {
      await expect(service.apply(runId)).resolves.toEqual(
        expect.objectContaining({ mode: 'applied', runId }),
      );
      const completionSql = runners[1].query.mock.calls
        .map(([sql]) => String(sql))
        .find((sql) => sql.includes('UPDATE "historic_backfill_run"'))!;
      expect(completionSql).toContain("\"status\" IN ('running', 'paused')");
      expect(completionSql).toContain('"sourceRevision" = $2::bigint');
      expect(completionSql).toContain('"historicComputeEpoch" = $3::bigint');
      expect(getOutbox()).toEqual(
        expect.objectContaining({ status: 'published' }),
      );
    } finally {
      context.status = previousStatus;
    }
  });

  it('checks immutable objects in stable order with bounded concurrency', async () => {
    process.env.HISTORIC_BACKFILL_ARTIFACT_HEAD_CONCURRENCY = '2';
    const { s3Service, service } = createHarness();
    const startedKeys: string[] = [];
    let active = 0;
    let maximumActive = 0;
    s3Service.headFile.mockImplementation(async (key: string) => {
      const callIndex = startedKeys.length;
      startedKeys.push(key);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        await new Promise((resolve) =>
          setTimeout(resolve, callIndex % 2 === 0 ? 10 : 1),
        );
        return { ContentLength: 128 };
      } finally {
        active -= 1;
      }
    });

    await service.apply(runId);

    expect(startedKeys).toEqual(
      artifacts.flatMap((artifact) => [
        artifact.geojsonObjectKey,
        artifact.pmtilesObjectKey,
      ]),
    );
    expect(maximumActive).toBe(2);
  });

  it('aborts in-flight checks without replacing the primary failure', async () => {
    process.env.HISTORIC_BACKFILL_ARTIFACT_HEAD_CONCURRENCY = '2';
    const { dataSource, s3Service, service } = createHarness();
    const primaryError = new Error('primary HEAD failure');
    let secondaryAborted = false;
    s3Service.headFile.mockImplementation(
      (
        _key: string,
        _prefix: string,
        options?: { abortSignal?: AbortSignal },
      ) => {
        if (s3Service.headFile.mock.calls.length === 1) {
          return Promise.reject(primaryError);
        }
        return new Promise((_resolve, reject) => {
          const signal = options?.abortSignal;
          const rejectForAbort = () => {
            secondaryAborted = true;
            reject(new Error('secondary HEAD aborted'));
          };
          if (signal?.aborted) {
            rejectForAbort();
          } else {
            signal?.addEventListener('abort', rejectForAbort, { once: true });
          }
        });
      },
    );

    await expect(service.apply(runId)).rejects.toBe(primaryError);

    expect(secondaryAborted).toBe(true);
    expect(s3Service.headFile).toHaveBeenCalledTimes(2);
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('rejects an empty immutable object before creating the outbox', async () => {
    const { dataSource, getOutbox, s3Service, service } = createHarness();
    s3Service.headFile.mockResolvedValueOnce({ ContentLength: 0 });

    await expect(service.apply(runId)).rejects.toThrow(
      'Immutable historic artifacts are empty for 2026-08-01',
    );

    expect(getOutbox()).toBeNull();
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    expect(s3Service.uploadFile).not.toHaveBeenCalled();
  });

  it('defaults HEAD verification concurrency to 16', () => {
    expect(readHistoricBackfillArtifactHeadConcurrency({})).toBe(
      HISTORIC_BACKFILL_ARTIFACT_HEAD_CONCURRENCY_DEFAULT,
    );
  });

  it.each(['0', '33', '1.5', 'invalid'])(
    'rejects invalid HEAD verification concurrency %s',
    (value) => {
      expect(() =>
        readHistoricBackfillArtifactHeadConcurrency({
          HISTORIC_BACKFILL_ARTIFACT_HEAD_CONCURRENCY: value,
        }),
      ).toThrow(
        'HISTORIC_BACKFILL_ARTIFACT_HEAD_CONCURRENCY must be between 1 and 32',
      );
    },
  );

  it('defaults and bounds the manifest upload timeout', () => {
    expect(readHistoricBackfillManifestUploadTimeout({})).toBe(
      HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS_DEFAULT,
    );
    expect(
      readHistoricBackfillManifestUploadTimeout({
        HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS: String(
          HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS_MIN,
        ),
      }),
    ).toBe(HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS_MIN);
    expect(
      readHistoricBackfillManifestUploadTimeout({
        HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS: String(
          HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS_MAX,
        ),
      }),
    ).toBe(HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS_MAX);
  });

  it.each(['999', '600001', '1.5', 'invalid'])(
    'rejects invalid manifest upload timeout %s',
    (value) => {
      expect(() =>
        readHistoricBackfillManifestUploadTimeout({
          HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS: value,
        }),
      ).toThrow(
        'HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS must be between 1000 and 600000',
      );
    },
  );

  it.each([
    {
      label: 'a due current queue',
      priority: { currentQueueCount: 1 },
    },
    {
      label: 'a running statistic snapshot',
      priority: { runningSnapshotCount: 1 },
    },
    {
      label: 'a running national daily publication',
      priority: { runningDailyCount: 1 },
    },
  ])(
    'keeps a pending outbox when $label takes priority',
    async ({ priority }) => {
      const { getOutbox, runners, s3Service, service, setPublishPriority } =
        createHarness();
      s3Service.uploadFile.mockRejectedValueOnce(
        new Error('initial manifest failure'),
      );
      await expect(service.apply(runId)).rejects.toThrow(
        'initial manifest failure',
      );
      expect(getOutbox()).toEqual(
        expect.objectContaining({ status: 'pending' }),
      );

      setPublishPriority(priority);
      await expect(service.apply(runId)).rejects.toThrow(
        'Current computation has priority over historic maps',
      );

      expect(s3Service.uploadFile).toHaveBeenCalledTimes(1);
      expect(getOutbox()).toEqual(
        expect.objectContaining({ status: 'pending' }),
      );
      const priorityRunner = runners.at(-1)!;
      expect(priorityRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(priorityRunner.release).toHaveBeenCalledTimes(1);
      expect(
        priorityRunner.query.mock.calls.some(([sql]) =>
          String(sql).includes(
            'UPDATE "historic_backfill_map_manifest_outbox"',
          ),
        ),
      ).toBe(false);
    },
  );

  it('aborts a timed-out manifest upload and preserves the pending outbox', async () => {
    process.env.HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS = '1000';
    const { getOutbox, runners, s3Service, service } = createHarness();
    const controller = new AbortController();
    const timeoutError = new DOMException(
      'Manifest upload timed out',
      'TimeoutError',
    );
    const timeout = jest
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(controller.signal);
    let uploadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    s3Service.uploadFile.mockImplementation(
      (
        _file: Express.Multer.File,
        _prefix: string,
        options: { abortSignal: AbortSignal },
      ) =>
        new Promise((_resolve, reject) => {
          uploadStarted();
          const rejectForAbort = () => reject(options.abortSignal.reason);
          if (options.abortSignal.aborted) {
            rejectForAbort();
          } else {
            options.abortSignal.addEventListener('abort', rejectForAbort, {
              once: true,
            });
          }
        }),
    );

    try {
      const publishing = service.apply(runId);
      await started;
      expect(timeout).toHaveBeenCalledWith(1000);
      controller.abort(timeoutError);
      await expect(publishing).rejects.toBe(timeoutError);
    } finally {
      timeout.mockRestore();
    }

    expect(getOutbox()).toEqual(expect.objectContaining({ status: 'pending' }));
    expect(runners).toHaveLength(2);
    expect(runners[1].commitTransaction).toHaveBeenCalledTimes(1);
    expect(runners[1].release).toHaveBeenCalledTimes(1);
    expect(s3Service.uploadFile.mock.calls[0][2].abortSignal).toBe(
      controller.signal,
    );
  });

  it('resumes a committed pending outbox idempotently after S3 fails', async () => {
    const { getOutbox, runners, s3Service, service } = createHarness();
    s3Service.uploadFile.mockRejectedValueOnce(
      new Error('Manifest unavailable'),
    );

    await expect(service.apply(runId)).rejects.toThrow('Manifest unavailable');
    expect(getOutbox()).toEqual(expect.objectContaining({ status: 'pending' }));
    expect(runners).toHaveLength(2);
    expect(runners[0].commitTransaction).toHaveBeenCalledTimes(1);
    expect(runners[1].commitTransaction).toHaveBeenCalledTimes(1);
    expect(
      runners[1].query.mock.calls.some(([sql]) =>
        String(sql).includes('UPDATE "historic_backfill_run"'),
      ),
    ).toBe(false);

    await expect(service.apply(runId)).resolves.toEqual(
      expect.objectContaining({ mode: 'applied', statisticRevision: '77' }),
    );
    expect(runners).toHaveLength(3);
    expect(s3Service.uploadFile).toHaveBeenCalledTimes(2);
    expect(s3Service.headFile).toHaveBeenCalledTimes(4);
    expect(
      runners
        .flatMap((runner) => runner.query.mock.calls)
        .filter(([sql]) => String(sql).includes('UPDATE "config"')),
    ).toHaveLength(1);
    expect(getOutbox()).toEqual(
      expect.objectContaining({
        status: 'published',
        publishedAt: expect.any(Date),
      }),
    );
  });

  it('keeps a pending outbox unpublished if the promotion marker disappears', async () => {
    const { getOutbox, s3Service, service } = createHarness();
    const previousStatisticsPromotedAt = context.statisticsPromotedAt;
    s3Service.uploadFile.mockRejectedValueOnce(new Error('initial failure'));
    await expect(service.apply(runId)).rejects.toThrow('initial failure');
    context.statisticsPromotedAt = null;

    try {
      await expect(service.apply(runId)).rejects.toThrow(
        'Historic statistics have not been promoted for this run',
      );
    } finally {
      context.statisticsPromotedAt = previousStatisticsPromotedAt;
    }

    expect(s3Service.uploadFile).toHaveBeenCalledTimes(1);
    expect(getOutbox()).toEqual(expect.objectContaining({ status: 'pending' }));
  });

  it('serializes concurrent retries and uploads a pending body only once', async () => {
    const { getOutbox, runners, s3Service, service } = createHarness();
    s3Service.uploadFile.mockRejectedValueOnce(new Error('initial failure'));
    await expect(service.apply(runId)).rejects.toThrow('initial failure');

    let signalUploadStarted!: () => void;
    const uploadStarted = new Promise<void>((resolve) => {
      signalUploadStarted = resolve;
    });
    let releaseSlowUpload!: () => void;
    const slowUpload = new Promise<void>((resolve) => {
      releaseSlowUpload = resolve;
    });
    s3Service.uploadFile.mockImplementationOnce(() => {
      signalUploadStarted();
      return slowUpload;
    });

    const firstRetry = service.apply(runId);
    await uploadStarted;
    const secondRetry = service.apply(runId);
    await expect(secondRetry).rejects.toThrow(
      'Historic map manifest publication is already running',
    );
    expect(s3Service.uploadFile).toHaveBeenCalledTimes(2);

    releaseSlowUpload();
    await expect(firstRetry).resolves.toEqual(
      expect.objectContaining({ mode: 'applied', statisticRevision: '77' }),
    );
    expect(getOutbox()).toEqual(
      expect.objectContaining({ status: 'published' }),
    );
    expect(
      runners
        .flatMap((runner) => runner.query.mock.calls)
        .filter(([sql]) =>
          String(sql).includes(
            'UPDATE "historic_backfill_map_manifest_outbox"',
          ),
        ),
    ).toHaveLength(1);
    expect(runners).toHaveLength(4);
    expect(runners[3].startTransaction).not.toHaveBeenCalled();
    expect(runners[3].release).toHaveBeenCalledTimes(1);

    await expect(service.apply(runId)).resolves.toEqual(
      expect.objectContaining({ mode: 'applied', statisticRevision: '77' }),
    );
    expect(s3Service.uploadFile).toHaveBeenCalledTimes(2);
  });

  it('cannot publish a newer run before a slow older publication finishes', async () => {
    const { getOutbox, s3Service, service, setOutbox } = createHarness();
    s3Service.uploadFile.mockRejectedValueOnce(new Error('initial failure'));
    await expect(service.apply(runId)).rejects.toThrow('initial failure');
    const olderPublication = { ...getOutbox()! };

    let signalOlderStarted!: () => void;
    const olderStarted = new Promise<void>((resolve) => {
      signalOlderStarted = resolve;
    });
    let releaseOlder!: () => void;
    const olderCanFinish = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    const completionOrder: string[] = [];
    s3Service.uploadFile.mockImplementationOnce(async () => {
      signalOlderStarted();
      await olderCanFinish;
      completionOrder.push(runId);
      return {};
    });

    const olderPublishing = service.apply(runId);
    await olderStarted;

    const newerRunId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const newerManifest = {
      ...JSON.parse(olderPublication.manifestBody),
      runId: newerRunId,
    };
    const newerManifestBody = `${JSON.stringify(newerManifest)}\n`;
    const newerPublication = {
      ...olderPublication,
      runId: newerRunId,
      status: 'pending',
      manifestBody: newerManifestBody,
      manifestChecksum: createHash('sha256')
        .update(newerManifestBody)
        .digest('hex'),
      publishedAt: null,
    };

    await expect(
      (service as any).publishPendingPublication(newerPublication),
    ).rejects.toThrow('Historic map manifest publication is already running');
    expect(s3Service.uploadFile).toHaveBeenCalledTimes(2);

    releaseOlder();
    await expect(olderPublishing).resolves.toEqual(
      expect.objectContaining({ runId }),
    );

    setOutbox(newerPublication);
    s3Service.uploadFile.mockImplementationOnce(async () => {
      completionOrder.push(newerRunId);
      return {};
    });
    await expect(
      (service as any).publishPendingPublication(newerPublication),
    ).resolves.toEqual(expect.objectContaining({ runId: newerRunId }));

    expect(completionOrder).toEqual([runId, newerRunId]);
    expect(s3Service.uploadFile).toHaveBeenCalledTimes(3);
  });

  it('ACKs an exact pending body after upload commit failure and source drift', async () => {
    const { getOutbox, runners, s3Service, service } = createHarness({
      failPublishCommitOnce: true,
    });

    await expect(service.apply(runId)).rejects.toThrow(
      'ACK commit unavailable',
    );
    expect(s3Service.uploadFile).toHaveBeenCalledTimes(1);
    expect(getOutbox()).toEqual(expect.objectContaining({ status: 'pending' }));
    expect(runners[1].rollbackTransaction).toHaveBeenCalledTimes(1);
    const failedPublishUnlock = runners[1].query.mock.calls.findIndex(
      ([sql, parameters]) =>
        String(sql).includes('pg_advisory_unlock') &&
        parameters?.[0] === 'historic-backfill-map-manifest-publication',
    );
    expect(
      runners[1].rollbackTransaction.mock.invocationCallOrder[0],
    ).toBeLessThan(
      runners[1].query.mock.invocationCallOrder[failedPublishUnlock],
    );
    expect(
      runners[1].rollbackTransaction.mock.invocationCallOrder[0],
    ).toBeLessThan(runners[1].release.mock.invocationCallOrder[0]);

    const originalContext = { ...context };
    Object.assign(context, {
      currentSourceRevision: '43',
      currentHistoricBackfillGlobalEpoch: '6',
      computeMapGeneration: '14',
      historicDirtyFrom: '2026-08-04',
      historicDirtyThrough: '2026-08-04',
    });
    try {
      await expect(service.apply(runId)).resolves.toEqual(
        expect.objectContaining({
          mode: 'applied',
          mapGeneration: '13',
          statisticRevision: '77',
        }),
      );
      expect(context).toMatchObject({
        currentSourceRevision: '43',
        currentHistoricBackfillGlobalEpoch: '6',
        computeMapGeneration: '14',
        historicDirtyFrom: '2026-08-04',
        historicDirtyThrough: '2026-08-04',
      });
    } finally {
      Object.assign(context, originalContext);
    }

    expect(s3Service.uploadFile).toHaveBeenCalledTimes(2);
    expect(getOutbox()).toEqual(
      expect.objectContaining({ status: 'published' }),
    );
    const retryRunQueries = runners[2].query.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes('FROM "historic_backfill_run" run'));
    expect(retryRunQueries).toHaveLength(1);
    expect(retryRunQueries[0]).toContain(
      'run."statisticsPromotedAt" IS NOT NULL',
    );
    expect(retryRunQueries[0]).not.toContain(
      'CROSS JOIN "zone_publication_source_state"',
    );
    const retrySql = runners[2].query.mock.calls
      .map(([sql]) => String(sql))
      .join('\n');
    expect(retrySql).not.toContain('UPDATE "config"');
    expect(retrySql).not.toContain('UPDATE "statistic_publication_state"');
    expect(retrySql).not.toContain('UPDATE "zone_publication_source_state"');
  });

  it('returns an already published outbox without republishing', async () => {
    const { dataSource, runners, s3Service, service } = createHarness();

    await service.apply(runId);
    const runnerCount = runners.length;
    const uploadCount = s3Service.uploadFile.mock.calls.length;
    await expect(service.apply(runId)).resolves.toEqual(
      expect.objectContaining({ mode: 'applied', mapGeneration: '13' }),
    );

    expect(runners).toHaveLength(runnerCount);
    expect(s3Service.uploadFile).toHaveBeenCalledTimes(uploadCount);
    expect(dataSource.query.mock.calls.at(-1)?.[0]).toContain(
      'historic_backfill_map_manifest_outbox',
    );
  });

  it('rejects artifact keys that omit immutable revision context', async () => {
    const { service } = createHarness();
    const originalKey = artifacts[0].pmtilesObjectKey;
    artifacts[0].pmtilesObjectKey = `historic-backfill/${runId}/national/2026-08-01.pmtiles`;
    try {
      await expect(service.dryRun(runId)).rejects.toThrow(
        'Historic artifact keys are invalid',
      );
    } finally {
      artifacts[0].pmtilesObjectKey = originalKey;
    }
  });
});
