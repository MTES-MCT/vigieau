import assert from 'node:assert/strict';
import test from 'node:test';
import { isReactive } from 'vue';
import { useRetryableLoad } from '../client/composables/useRetryableLoad.ts';

for (const failure of [
  { statusCode: 404, data: { message: 'Arrete introuvable' } },
  { statusCode: 500, data: { message: 'Serveur indisponible' } },
  new TypeError('Failed to fetch'),
  new DOMException('Request timed out', 'TimeoutError'),
]) {
  test(`keeps load errors visible and retries without creating fallback data: ${failure.statusCode ?? failure.name}`, async () => {
    const captured = [];
    let attempts = 0;
    const source = { id: 47, restrictions: [{ usages: [{ id: 101 }] }] };
    const state = useRetryableLoad(async () => {
      if (++attempts === 1) {
        throw failure;
      }
      return source;
    }, (error) => captured.push(error));

    await state.load();
    assert.equal(state.data.value, null);
    assert.equal(state.error.value, failure);
    assert.equal(state.loading.value, false);
    assert.deepEqual(captured, [failure]);

    await state.load();
    assert.deepEqual(state.data.value, source);
    assert.equal(state.error.value, null);
    assert.equal(state.loading.value, false);
    assert.equal(attempts, 2);
    assert.ok(isReactive(state.data.value.restrictions[0]), 'nested form choices must remain reactive');
  });
}

test('does not start duplicate reads while the current request is pending', async () => {
  let resolve;
  let calls = 0;
  const state = useRetryableLoad(() => {
    calls++;
    return new Promise((done) => { resolve = done; });
  });
  const pending = state.load();
  assert.equal(state.loading.value, true);
  await state.load();
  assert.equal(calls, 1);
  resolve({ id: null, statut: 'a_valider' });
  await pending;
  assert.equal(state.loading.value, false);
});

test('fresh creation needs no existing source and returns the supplied draft', async () => {
  const state = useRetryableLoad(async () => ({ id: null, statut: 'a_valider', restrictions: [] }));
  await state.load();
  assert.deepEqual(state.data.value, { id: null, statut: 'a_valider', restrictions: [] });
  assert.equal(state.error.value, null);
});
