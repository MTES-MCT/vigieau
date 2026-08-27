import { HistoricBackfillArtifactYieldError } from './historic-backfill-artifact-builder.service';
import { HistoricBackfillArtifactWorkerLoop } from './historic-backfill-artifact-worker-loop';

describe('HistoricBackfillArtifactWorkerLoop', () => {
  const lease = {
    runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    validFrom: '2026-08-01',
    validThrough: '2026-08-01',
    workerId: 'worker:1',
    leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    leaseExpiresAt: new Date(Date.now() + 60_000),
    attemptCount: 1,
  };
  const environment = {
    HISTORIC_BACKFILL_ENABLED: 'true',
    HISTORIC_BACKFILL_WORKER_CONCURRENCY: '1',
    HISTORIC_BACKFILL_ARTIFACT_CONCURRENCY: '1',
    HISTORIC_BACKFILL_LEASE_SECONDS: '60',
    HISTORIC_BACKFILL_HEARTBEAT_MILLISECONDS: '30000',
    HISTORIC_BACKFILL_POLL_MILLISECONDS: '100',
  } as NodeJS.ProcessEnv;

  it('does nothing while the feature flag is disabled', async () => {
    const queue = { findRunnableRunId: jest.fn() };
    const loop = new HistoricBackfillArtifactWorkerLoop(
      queue as any,
      {} as any,
    );

    await expect(
      loop.run({
        environment: { HISTORIC_BACKFILL_ENABLED: 'false' },
      }),
    ).resolves.toEqual(
      expect.objectContaining({ enabled: false, claimed: 0, completed: 0 }),
    );
    expect(queue.findRunnableRunId).not.toHaveBeenCalled();
  });

  it('claims and completes one artifact task', async () => {
    const queue = {
      findRunnableRunId: jest
        .fn()
        .mockResolvedValueOnce(lease.runId)
        .mockResolvedValue(null),
      claim: jest.fn().mockResolvedValue(lease),
      heartbeat: jest.fn().mockResolvedValue(true),
      complete: jest.fn().mockResolvedValue(true),
      fail: jest.fn(),
      yieldTask: jest.fn(),
    };
    const builder = {
      build: jest.fn().mockResolvedValue({
        geojsonObjectKey: 'geojson',
        geojsonChecksum: 'a'.repeat(64),
        pmtilesObjectKey: 'pmtiles',
        pmtilesChecksum: 'b'.repeat(64),
        featureCount: 1,
      }),
    };
    const loop = new HistoricBackfillArtifactWorkerLoop(
      queue as any,
      builder as any,
    );

    const result = await loop.run({
      environment,
      workerId: 'worker',
      maxIdlePolls: 1,
    });

    expect(result).toEqual(
      expect.objectContaining({ claimed: 1, completed: 1 }),
    );
    expect(queue.claim).toHaveBeenCalledWith(lease.runId, 'worker:1', 60, 5);
    expect(queue.complete).toHaveBeenCalledWith(lease, expect.any(Object));
  });

  it('yields priority interruptions without consuming an attempt', async () => {
    const queue = {
      heartbeat: jest.fn().mockResolvedValue(true),
      yieldTask: jest.fn().mockResolvedValue(true),
    };
    const builder = {
      build: jest
        .fn()
        .mockRejectedValue(new HistoricBackfillArtifactYieldError('priority')),
    };
    const loop = new HistoricBackfillArtifactWorkerLoop(
      queue as any,
      builder as any,
    );
    const config = {
      leaseSeconds: 60,
      heartbeatMilliseconds: 30_000,
      maxAttempts: 5,
      retryBaseSeconds: 30,
      retryMaxSeconds: 1800,
      yieldDelaySeconds: 15,
    };

    await expect((loop as any).processClaim(lease, config)).resolves.toBe(
      'yielded',
    );
    expect(queue.yieldTask).toHaveBeenCalledWith(lease, 15);
  });
});
