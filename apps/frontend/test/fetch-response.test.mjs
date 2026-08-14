import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchAsRefResponse } from '../client/utils/fetch-response.ts';

test('adapts a successful imperative fetch to the existing ref contract', async () => {
  const response = await fetchAsRefResponse(async () => [{ id: 29959 }]);

  assert.deepEqual(response.data.value, [{ id: 29959 }]);
  assert.equal(response.error.value, null);
});

test('keeps the fetch error available for 410 handling', async () => {
  const fetchError = { statusCode: 410 };
  const response = await fetchAsRefResponse(async () => {
    throw fetchError;
  });

  assert.equal(response.data.value, null);
  assert.deepEqual(response.error.value, fetchError);
});
