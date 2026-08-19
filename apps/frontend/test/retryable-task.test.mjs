import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLatestTaskRunner,
  createRetryScheduler,
  runRetryableTask,
} from '../client/utils/retryable-task.ts';

test('retries a task up to the configured bound', async () => {
  const controller = new AbortController();
  const attempts = [];
  const result = await runRetryableTask(
    async (_signal, attempt) => {
      attempts.push(attempt);
      if (attempt < 3) {
        throw new Error('temporary PMTiles failure');
      }
      return 'ready';
    },
    { attempts: 3, delayMs: 0, signal: controller.signal },
  );

  assert.equal(result, 'ready');
  assert.deepEqual(attempts, [1, 2, 3]);
});

test('does not exceed the configured retry bound', async () => {
  const controller = new AbortController();
  let attempts = 0;

  await assert.rejects(
    runRetryableTask(
      async () => {
        attempts += 1;
        throw new Error('PMTiles unavailable');
      },
      { attempts: 2, delayMs: 0, signal: controller.signal },
    ),
    /PMTiles unavailable/,
  );
  assert.equal(attempts, 2);
});

test('aborts without starting a later retry', async () => {
  const controller = new AbortController();
  let attempts = 0;

  await assert.rejects(
    runRetryableTask(
      async () => {
        attempts += 1;
        controller.abort();
        throw new Error('obsolete request');
      },
      { attempts: 3, delayMs: 1_000, signal: controller.signal },
    ),
    { name: 'AbortError' },
  );
  assert.equal(attempts, 1);
});

test('applies only the latest asynchronous result', async () => {
  const runner = createLatestTaskRunner();
  const applied = [];
  let resolveFirst;
  const firstRun = runner.run(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    (value) => applied.push(value),
  );
  const secondRun = runner.run(
    async () => 'new-publication',
    (value) => applied.push(value),
  );

  assert.equal(await secondRun, true);
  resolveFirst('old-publication');
  assert.equal(await firstRun, false);
  assert.deepEqual(applied, ['new-publication']);
});

test('schedules one manifest retry at the requested delay', () => {
  let retryCount = 0;
  let scheduledCallback;
  let scheduledDelay;
  let clearedTimeout;
  const scheduler = createRetryScheduler(
    () => {
      retryCount += 1;
    },
    5_000,
    {
      setTimeoutFn: (callback, delay) => {
        scheduledCallback = callback;
        scheduledDelay = delay;
        return 24;
      },
      clearTimeoutFn: (timeout) => {
        clearedTimeout = timeout;
      },
    },
  );

  scheduler.schedule();
  scheduler.schedule();
  assert.equal(scheduledDelay, 5_000);
  scheduledCallback();
  assert.equal(retryCount, 1);

  scheduler.schedule();
  scheduler.clear();
  assert.equal(clearedTimeout, 24);
});

test('backs off manifest retries with bounded jitter and resets after success', () => {
  const scheduledCallbacks = [];
  const scheduledDelays = [];
  const scheduler = createRetryScheduler(() => {}, 5_000, {
    maxDelayMs: 60_000,
    jitterRatio: 0.2,
    randomFn: () => 0.5,
    setTimeoutFn: (callback, delay) => {
      scheduledCallbacks.push(callback);
      scheduledDelays.push(delay);
      return scheduledCallbacks.length;
    },
  });

  for (let attempt = 0; attempt < 6; attempt += 1) {
    scheduler.schedule();
    scheduledCallbacks.shift()();
  }
  assert.deepEqual(
    scheduledDelays,
    [4_500, 9_000, 18_000, 36_000, 54_000, 54_000],
  );

  scheduler.clear();
  scheduler.schedule();
  assert.equal(scheduledDelays.at(-1), 4_500);
});
