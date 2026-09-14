import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { useUtils } from '../client/composables/useUtils.ts';

test('debounce runs only the last call and preserves its arguments and this', async () => {
  const calls = [];
  const firstContext = { id: 'first' };
  const lastContext = { id: 'last' };
  const payload = { value: 42 };
  const debounced = useUtils().debounce(function (...args) {
    calls.push({ context: this, args });
  }, 10);

  debounced.call(firstContext, 'discarded', null);
  debounced.call(lastContext, 'retained', payload);
  assert.equal(calls.length, 0, 'callbacks must remain deferred');
  await delay(30);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].context, lastContext);
  assert.deepEqual(calls[0].args, ['retained', payload]);
  assert.equal(calls[0].args[1], payload);

  debounced.call(firstContext, 'next');
  await delay(30);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].context, firstContext);
  assert.deepEqual(calls[1].args, ['next']);
});

test('separate debounced callbacks do not cancel each other', async () => {
  const calls = [];
  const utils = useUtils();
  const first = utils.debounce((value) => calls.push(value), 10);
  const second = utils.debounce((value) => calls.push(value), 10);
  first('first');
  second('second');
  await delay(30);
  assert.deepEqual(calls, ['first', 'second']);
});
