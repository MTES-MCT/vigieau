import assert from 'node:assert/strict';
import test from 'node:test';
import { createRetryableInitializer } from '../client/utils/retryable-initializer.ts';

test('retries after an initial failure and initializes only once', async () => {
  const mapInstance = { id: 'map' };
  let attempts = 0;
  const initializer = createRetryableInitializer(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error('manifest temporarily unavailable');
    }
    return mapInstance;
  });

  await assert.rejects(initializer.initialize(), /temporarily unavailable/);

  const [firstRecovery, concurrentRecovery] = await Promise.all([
    initializer.initialize(),
    initializer.initialize(),
  ]);
  const subsequentCall = await initializer.initialize();

  assert.equal(firstRecovery, mapInstance);
  assert.equal(concurrentRecovery, mapInstance);
  assert.equal(subsequentCall, mapInstance);
  assert.equal(initializer.value(), mapInstance);
  assert.equal(attempts, 2);
});

test('can initialize once its prerequisite becomes available', async () => {
  const mapInstance = { id: 'map' };
  let manifestAvailable = false;
  let attempts = 0;
  const initializer = createRetryableInitializer(() => {
    attempts += 1;
    return manifestAvailable ? mapInstance : null;
  });

  assert.equal(await initializer.initialize(), null);
  manifestAvailable = true;
  assert.equal(await initializer.initialize(), mapInstance);
  assert.equal(await initializer.initialize(), mapInstance);
  assert.equal(attempts, 2);
});
