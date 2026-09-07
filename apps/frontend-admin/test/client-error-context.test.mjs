import assert from 'node:assert/strict';
import test from 'node:test';
import { createClientErrorDeduplicator, getClientErrorTags } from '../client/utils/client-error-context.ts';

test('tags business operations and HTTP failures including 4xx without personal data', () => {
  assert.deepEqual(getClientErrorTags({ response: { status: 400 } }, {
    action: 'save_before_publish',
    arreteType: 'arrete_restriction',
    departement: '2B',
    email: 'operator@example.test',
    numero: 'Private reference',
  }), { http_status: '400', action: 'save_before_publish', arrete_type: 'arrete_restriction', departement: '2B' });
  assert.deepEqual(getClientErrorTags({ statusCode: 503 }, { action: 'load', entity: 'arrete_cadre', departement: '971' }), {
    http_status: '503', action: 'load', arrete_type: 'arrete_cadre', departement: '971',
  });
});

test('rejects unbounded or personal tag values and accepts network errors without an HTTP status', () => {
  assert.deepEqual(getClientErrorTags(new TypeError('Network error'), {
    action: 'operator@example.test', entity: 'unknown', departement: 'Lot-et-Garonne',
  }), {});
  assert.deepEqual(getClientErrorTags({ statusCode: 999 }, {}), {});
});

test('deduplicates only one error object, retaining separate attempts with the same message', () => {
  const deduplicator = createClientErrorDeduplicator();
  const error = new Error('Failure');
  assert.equal(deduplicator.reserve(error), true);
  assert.equal(deduplicator.reserve(error), false);
  assert.equal(deduplicator.reserve(new Error('Failure')), true);
  assert.equal(deduplicator.reserve('Failure'), true);
  assert.equal(deduplicator.reserve('Failure'), true);
  deduplicator.release(error);
  assert.equal(deduplicator.reserve(error), true);
});
