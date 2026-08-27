import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateProcfile,
  validateProcfilePath,
} from './validate-procfiles.mjs';

test('accepts Scalingo-compatible process declarations', () => {
  assert.deepEqual(
    validateProcfile('web: npm run start:prod\nstatcache: npm run start:statcache\n'),
    [],
  );
});

test('rejects process types that Scalingo cannot parse', () => {
  assert.deepEqual(validateProcfile('current-zone-worker: npm run worker\n'), [
    'line 1: invalid process declaration',
  ]);
});

test('keeps every application Procfile deployable', async () => {
  const errors = (
    await Promise.all([
      validateProcfilePath('apps/backend/Procfile'),
      validateProcfilePath('apps/backend-admin/Procfile'),
    ])
  ).flat();

  assert.deepEqual(errors, []);
});
