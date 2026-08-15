import { StatisticCacheReadinessService } from './statistic_cache_readiness.service';
import { isStatisticCacheArtifactRequired } from './statistic_cache.config';

describe('StatisticCacheReadinessService', () => {
  const previousRequired = process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED;
  const previousMinimum = process.env.STATISTIC_CACHE_MIN_READY_INSTANCES;
  const previousLease = process.env.STATISTIC_CACHE_INSTANCE_LEASE_SECONDS;

  afterEach(() => {
    if (previousRequired === undefined) {
      delete process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED;
    } else {
      process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED = previousRequired;
    }
    if (previousMinimum === undefined) {
      delete process.env.STATISTIC_CACHE_MIN_READY_INSTANCES;
    } else {
      process.env.STATISTIC_CACHE_MIN_READY_INSTANCES = previousMinimum;
    }
    if (previousLease === undefined) {
      delete process.env.STATISTIC_CACHE_INSTANCE_LEASE_SECONDS;
    } else {
      process.env.STATISTIC_CACHE_INSTANCE_LEASE_SECONDS = previousLease;
    }
  });

  const readyRow = {
    publicationId: '00000000-0000-4000-8000-000000000001',
    statisticRevision: '12',
    statisticPublishedDate: '2026-08-15',
    statisticFingerprint: 'a'.repeat(64),
    sourceRevision: '42',
    artifactCount: 3,
    liveInstances: 2,
    readyInstances: 2,
  };

  const createService = (rows: unknown[] = [readyRow]) => {
    const dataSource = { query: jest.fn().mockResolvedValue(rows) };
    return {
      service: new StatisticCacheReadinessService(dataSource as never),
      dataSource,
    };
  };

  it('keeps the rollout gate disabled by default and validates explicit values', () => {
    delete process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED;
    expect(isStatisticCacheArtifactRequired()).toBe(false);
    process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED = 'true';
    expect(isStatisticCacheArtifactRequired()).toBe(true);
    process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED = 'sometimes';
    expect(() => isStatisticCacheArtifactRequired()).toThrow(
      'Unsupported STATISTIC_CACHE_ARTIFACT_REQUIRED',
    );
  });

  it('returns the exact active identity only after every live instance acknowledges it', async () => {
    const { service, dataSource } = createService();

    await expect(
      service.getReadyPublication('2026-08-15', '42'),
    ).resolves.toEqual({
      publicationId: readyRow.publicationId,
      statisticRevision: '12',
      statisticPublishedDate: '2026-08-15',
      statisticFingerprint: readyRow.statisticFingerprint,
      sourceRevision: '42',
    });
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('instance."statisticLastError" IS NULL'),
      ['2026-08-15', '42', 30],
    );
    const readinessSql = dataSource.query.mock.calls[0][0];
    expect(readinessSql).toContain(
      'cache_state."historicRecoveryMonthlyFrom" IS NULL',
    );
    expect(readinessSql).toContain(
      'incomplete_snapshot."status" <> \'completed\'',
    );
    expect(readinessSql).toContain(
      'incomplete_snapshot."processedCommuneCount" <>',
    );
    expect(readinessSql).toContain(
      'incomplete_snapshot."expectedCommuneCount"',
    );
    expect(readinessSql).toContain('publication."historicComputeEpoch" =');
    expect(readinessSql).toContain(
      'statistic_state."historicPublishedThrough" >=',
    );
    expect(readinessSql).toContain('statistic_state."historicDirtyThrough" >=');
  });

  it.each([
    ['only one live instance', { liveInstances: 1, readyInstances: 1 }],
    ['one divergent live instance', { liveInstances: 2, readyInstances: 1 }],
    ['an incomplete artifact set', { artifactCount: 2 }],
  ])('rejects %s', async (_label, override) => {
    const { service } = createService([{ ...readyRow, ...override }]);

    await expect(
      service.getReadyPublication('2026-08-15', '42'),
    ).resolves.toBeNull();
  });

  it('fails exact revalidation after the active artifact changes', async () => {
    const { service } = createService([]);

    await expect(
      service.assertReadyPublication({
        publicationId: readyRow.publicationId,
        statisticRevision: '12',
        statisticPublishedDate: '2026-08-15',
        statisticFingerprint: readyRow.statisticFingerprint,
        sourceRevision: '42',
      }),
    ).rejects.toThrow('Statistic cache quorum changed');
  });
});
