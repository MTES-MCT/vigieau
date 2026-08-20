import { readHistoricBackfillWorkerConfig } from './historic-backfill.config';
import {
  HistoricBackfillSleep,
  HistoricBackfillWorkerLoop,
  historicBackfillSleep,
} from './historic-backfill-worker-loop';
import {
  HistoricBackfillTaskClaim,
  HistoricBackfillTaskInterruptedError,
} from './historic-backfill.types';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const LEASE_TOKEN = '22222222-2222-4222-8222-222222222222';
const OUTPUT_SIGNATURE = 'a'.repeat(64);

function claim(): HistoricBackfillTaskClaim {
  return {
    runId: RUN_ID,
    departementId: 75,
    workerId: 'worker:1',
    leaseToken: LEASE_TOKEN,
    departementCode: '75',
    departmentGeneration: '3',
    departmentLastPublicRevision: '42',
    attemptCount: 1,
    leaseExpiresAt: new Date('2026-08-19T10:05:00.000Z'),
    progressDate: null,
    segmentCount: 0,
    communeCount: 0,
    artifactPrefix: null,
    mapDateFrom: '2012-01-01',
    statisticDateFrom: '2019-01-01',
    dateThrough: '2026-08-18',
    sourceRevision: '42',
    historicComputeEpoch: '7',
    baseStatisticRevision: '12',
  };
}

function output() {
  return {
    progressDate: '2026-08-18',
    segmentCount: 200,
    communeCount: 350,
    outputSignature: OUTPUT_SIGNATURE,
    artifactPrefix: null,
  };
}

function workerConfig() {
  return readHistoricBackfillWorkerConfig({
    HISTORIC_BACKFILL_ENABLED: 'true',
  });
}

function harness(overrides: Record<string, jest.Mock> = {}) {
  const queue = {
    claim: jest.fn(),
    heartbeat: jest.fn().mockResolvedValue(true),
    complete: jest.fn().mockResolvedValue(true),
    fail: jest.fn().mockResolvedValue('retry'),
    yieldTask: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
  const loop = new HistoricBackfillWorkerLoop(queue as any);
  (loop as any).logger.error = jest.fn();
  (loop as any).logger.warn = jest.fn();
  return { loop, queue };
}

describe('historicBackfillSleep', () => {
  it('stops immediately when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      historicBackfillSleep(60_000, controller.signal),
    ).resolves.toBe(false);
  });

  it('cancels its timer on abort', async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const pending = historicBackfillSleep(60_000, controller.signal);

    controller.abort();

    await expect(pending).resolves.toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
});

describe('HistoricBackfillWorkerLoop', () => {
  it('does not touch the queue while the feature flag is absent', async () => {
    const { loop, queue } = harness();

    await expect(loop.run(jest.fn(), { environment: {} })).resolves.toEqual({
      enabled: false,
      claimed: 0,
      completed: 0,
      retries: 0,
      terminalFailures: 0,
      yielded: 0,
      lostLeases: 0,
      claimErrors: 0,
    });
    expect(queue.claim).not.toHaveBeenCalled();
  });

  it('runs an independently claimable worker pool', async () => {
    const { loop, queue } = harness({
      claim: jest.fn().mockResolvedValue(null),
    });

    const result = await loop.run(jest.fn(), {
      environment: {
        HISTORIC_BACKFILL_ENABLED: 'true',
        HISTORIC_BACKFILL_WORKER_CONCURRENCY: '2',
      },
      workerId: 'container-a',
      maxIdlePolls: 1,
    });

    expect(result.enabled).toBe(true);
    expect(queue.claim).toHaveBeenCalledTimes(2);
    expect(queue.claim.mock.calls.map(([workerId]) => workerId)).toEqual([
      'container-a:1',
      'container-a:2',
    ]);
  });

  it('claims, handles and completes a task before polling again', async () => {
    const { loop, queue } = harness({
      claim: jest
        .fn()
        .mockResolvedValueOnce(claim())
        .mockResolvedValueOnce(null),
    });
    const handler = jest.fn().mockResolvedValue(output());

    const result = await loop.run(handler, {
      environment: { HISTORIC_BACKFILL_ENABLED: 'true' },
      workerId: 'container-a',
      maxIdlePolls: 1,
    });

    expect(result).toMatchObject({ claimed: 1, completed: 1 });
    expect(handler).toHaveBeenCalledWith(
      claim(),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        heartbeat: expect.any(Function),
      }),
    );
    expect(queue.complete).toHaveBeenCalledWith(
      {
        runId: RUN_ID,
        departementId: 75,
        workerId: 'worker:1',
        leaseToken: LEASE_TOKEN,
      },
      output(),
    );
  });

  it('forwards explicit progress heartbeats', async () => {
    const { loop, queue } = harness();
    const progress = {
      progressDate: '2020-01-01',
      segmentCount: 10,
      communeCount: 5,
    };

    await expect(
      loop.processClaim(
        claim(),
        async (_claim, context) => {
          await expect(context.heartbeat(progress)).resolves.toBe(true);
          return output();
        },
        workerConfig(),
      ),
    ).resolves.toBe('completed');

    expect(queue.heartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ leaseToken: LEASE_TOKEN }),
      progress,
      300,
    );
  });

  it('records an ordinary handler failure through the retry policy', async () => {
    const { loop, queue } = harness();
    const error = new Error('temporary failure');

    await expect(
      loop.processClaim(
        claim(),
        async () => {
          throw error;
        },
        workerConfig(),
      ),
    ).resolves.toBe('retry');

    expect(queue.fail).toHaveBeenCalledWith(
      expect.objectContaining({ leaseToken: LEASE_TOKEN }),
      error,
      5,
      30,
      1800,
    );
    expect(queue.yieldTask).not.toHaveBeenCalled();
  });

  it.each(['aborted', 'current-priority', 'generation-changed'] as const)(
    'yields a cooperative %s interruption without consuming a retry',
    async (reason) => {
      const { loop, queue } = harness();

      await expect(
        loop.processClaim(
          claim(),
          async () => {
            throw new HistoricBackfillTaskInterruptedError(reason);
          },
          workerConfig(),
        ),
      ).resolves.toBe('yielded');

      expect(queue.yieldTask).toHaveBeenCalledWith(
        expect.objectContaining({ leaseToken: LEASE_TOKEN }),
        15,
      );
      expect(queue.fail).not.toHaveBeenCalled();
    },
  );

  it('aborts the handler and rejects stale completion when a heartbeat loses the lease', async () => {
    const { loop, queue } = harness({
      heartbeat: jest.fn().mockResolvedValue(false),
    });
    const immediateTick: HistoricBackfillSleep = jest
      .fn()
      .mockResolvedValue(true);

    const result = await loop.processClaim(
      claim(),
      async (_claim, context) =>
        new Promise((_, reject) => {
          context.signal.addEventListener(
            'abort',
            () => reject(new Error('lease stopped')),
            { once: true },
          );
        }),
      workerConfig(),
      undefined,
      immediateTick,
    );

    expect(result).toBe('lease-lost');
    expect(queue.complete).not.toHaveBeenCalled();
    expect(queue.fail).not.toHaveBeenCalled();
    expect(queue.yieldTask).not.toHaveBeenCalled();
  });

  it('yields an owned lease during graceful shutdown', async () => {
    const { loop, queue } = harness();
    const controller = new AbortController();
    controller.abort();

    await expect(
      loop.processClaim(
        claim(),
        async (_claim, context) => {
          expect(context.signal.aborted).toBe(true);
          throw new HistoricBackfillTaskInterruptedError('aborted');
        },
        workerConfig(),
        controller.signal,
      ),
    ).resolves.toBe('yielded');

    expect(queue.yieldTask).toHaveBeenCalled();
  });

  it('treats a rejected CAS completion as a lost lease', async () => {
    const { loop, queue } = harness({
      complete: jest.fn().mockResolvedValue(false),
    });

    await expect(
      loop.processClaim(claim(), async () => output(), workerConfig()),
    ).resolves.toBe('lease-lost');
    expect(queue.fail).not.toHaveBeenCalled();
  });

  it('backs off a claim error without terminating other production processes', async () => {
    const { loop, queue } = harness({
      claim: jest.fn().mockRejectedValue(new Error('database unavailable')),
    });
    const stopSleep = jest.fn().mockResolvedValue(false);

    const result = await loop.run(jest.fn(), {
      environment: { HISTORIC_BACKFILL_ENABLED: 'true' },
      workerId: 'container-a',
      maxIdlePolls: 1,
      sleep: stopSleep,
    });

    expect(result.claimErrors).toBe(1);
    expect(stopSleep).toHaveBeenCalledWith(10_000, undefined);
    expect((loop as any).logger.error).toHaveBeenCalled();
    expect(queue.complete).not.toHaveBeenCalled();
  });
});
