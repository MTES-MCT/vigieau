import assert from 'node:assert/strict';
import test from 'node:test';
import { applyLightTheme } from '../client/utils/light-theme.ts';
import { isAreaStatisticSeries, isDepartmentStatisticSeries, isCommuneStatisticData } from '../client/utils/statistic-series.ts';
import { createLatestWorkerTask } from '../client/utils/latest-worker-task.ts';
import { readFile } from 'node:fs/promises';

for (const [name, storage] of [
  ['blocked property', () => { throw new Error('Access denied'); }],
  ['missing storage', () => null],
  ['blocked writes', () => ({ setItem() { throw new Error('Quota exceeded'); } })],
]) {
  test(`initializes the light theme with ${name}`, () => {
    const attributes = {};
    assert.doesNotThrow(() => applyLightTheme({ setAttribute: (key, value) => { attributes[key] = value; } }, storage));
    assert.equal(attributes['data-fr-theme'], 'light');
  });
}

test('persists the existing light theme preference when storage is available', () => {
  const writes = [];
  applyLightTheme({ setAttribute() {} }, () => ({ setItem: (...args) => writes.push(args) }));
  assert.deepEqual(writes, [['vue-dsfr-scheme', 'light']]);
});

test('distinguishes empty statistics from failed or incomplete data without inventing zeroes', () => {
  assert.equal(isAreaStatisticSeries([], 'AEP'), true);
  assert.equal(isDepartmentStatisticSeries([]), true);
  for (const invalid of [null, undefined, {}, [null]]) {
    assert.equal(isAreaStatisticSeries(invalid, 'AEP'), false);
    assert.equal(isDepartmentStatisticSeries(invalid), false);
  }
  assert.equal(isAreaStatisticSeries([{ date: '2026-09-07', AEP: null }], 'AEP'), false);
  assert.equal(isAreaStatisticSeries([{ date: '2026-09-07', AEP: { vigilance: null, alerte: 0, alerte_renforcee: 0, crise: 0 } }], 'AEP'), false);
  assert.equal(isDepartmentStatisticSeries([{ date: '2026-09-07', departements: null }]), false);
  assert.equal(isDepartmentStatisticSeries([{ date: '2026-09-07', departements: [null] }]), false);
});

test('accepts zeroes and numeric strings returned by historical statistics', () => {
  assert.equal(isAreaStatisticSeries([{ date: '2026-09-07', AEP: { vigilance: 0, alerte: '2.5', alerte_renforcee: 0, crise: '0' } }], 'AEP'), true);
  assert.equal(isDepartmentStatisticSeries([{ date: '2026-09-07', departements: [{ niveauGravite: 'alerte', niveauGraviteSup: 'alerte', niveauGraviteSou: null, niveauGraviteAep: null }] }]), true);
  assert.equal(isDepartmentStatisticSeries([{ date: '2026-09-07', departements: [{}] }]), false);
  assert.equal(isCommuneStatisticData({ commune: { nom: 'Test' }, restrictions: [] }), true);
  assert.equal(isCommuneStatisticData({ commune: { nom: 'Test' }, restrictions: null }), false);
  assert.equal(isCommuneStatisticData({ commune: { nom: 'Test' }, restrictions: [{ date: '2026-09-07' }] }), false);
  assert.equal(isCommuneStatisticData({ commune: { nom: 'Test' }, restrictions: [{ date: '2026-09-07', AEP: null, SUP: 'alerte', SOU: null }] }), true);
});

function createWorkers() {
  const workers = [];
  const results = [];
  const errors = [];
  const task = createLatestWorkerTask(() => {
    const worker = {
      terminated: false,
      onmessage: null,
      onerror: null,
      postMessage(value) { this.value = value; },
      terminate() { this.terminated = true; },
    };
    workers.push(worker);
    return worker;
  }, (result) => results.push(result), (error) => errors.push(error));
  return { task, workers, results, errors };
}

test('terminates the previous map worker and ignores queued stale results', () => {
  const { task, workers, results } = createWorkers();
  task.run('first');
  const staleCallback = workers[0].onmessage;
  task.run('second');
  assert.equal(workers[0].terminated, true);
  staleCallback({ data: 'stale' });
  workers[1].onmessage({ data: 'current' });
  assert.deepEqual(results, ['current']);
  assert.equal(workers[1].terminated, true);
});

test('unmount disposal prevents both queued results and new map work', () => {
  const { task, workers, results } = createWorkers();
  task.run({});
  const pendingCallback = workers[0].onmessage;
  task.dispose();
  pendingCallback({ data: 'removed map' });
  task.run({});
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminated, true);
  assert.deepEqual(results, []);
});

test('handles worker errors once and allows another computation', () => {
  const { task, workers, errors } = createWorkers();
  task.run({});
  let prevented = false;
  workers[0].onerror({ message: 'Worker failed', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(workers[0].terminated, true);
  assert.equal(errors[0].message, 'Worker failed');
  task.run({});
  assert.equal(workers.length, 2);
});

test('handles worker construction and postMessage failures without leaked workers', () => {
  const errors = [];
  const task = createLatestWorkerTask(() => { throw new Error('Worker unavailable'); }, () => {}, (error) => errors.push(error));
  task.run({});
  assert.equal(errors[0].message, 'Worker unavailable');
  let terminated = false;
  const failingTask = createLatestWorkerTask(() => ({
    onmessage: null,
    onerror: null,
    postMessage() { throw new Error('Cannot clone'); },
    terminate() { terminated = true; },
  }), () => {}, (error) => errors.push(error));
  failingTask.run({});
  assert.equal(terminated, true);
  assert.equal(errors[1].message, 'Cannot clone');
});

test('reports a failed map update without leaving a running worker', () => {
  const errors = [];
  const worker = { onmessage: null, onerror: null, postMessage() {}, terminate() { this.terminated = true; } };
  const task = createLatestWorkerTask(() => worker, () => { throw new Error('Map update failed'); }, (error) => errors.push(error));
  task.run({});
  assert.doesNotThrow(() => worker.onmessage({ data: {} }));
  assert.equal(worker.terminated, true);
  assert.equal(errors[0].message, 'Map update failed');
});

test('keeps import maps disabled and client sourcemaps hidden in production builds', async () => {
  const config = await readFile(new URL('../nuxt.config.ts', import.meta.url), 'utf8');
  assert.match(config, /entryImportMap:\s*false/);
  assert.match(config, /sourcemap:\s*\{\s*client:\s*'hidden'/);
  assert.match(config, /sentryRelease:\s*process\.env\.SENTRY_RELEASE/);
  assert.match(config, /installPrompt:\s*false/);
});
