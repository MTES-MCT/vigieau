import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyMaplibreWorkerBuild } from './verify-maplibre-worker-build.mjs';

async function fixture(t, { worker = 'self.onmessage = () => {};', reference = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vigieau-worker-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bundles = join(directory, '.output/public/_nuxt');
  await mkdir(bundles, { recursive: true });
  if (worker !== null) await writeFile(join(bundles, 'maplibre-gl-worker-test.js'), worker);
  await writeFile(join(bundles, 'client.js'), reference
    ? 'setWorkerUrl("/_nuxt/maplibre-gl-worker-test.js");'
    : 'console.log("no configured worker");');
  return directory;
}

test('accepts a bundled worker referenced by the client', async (t) => {
  assert.equal((await verifyMaplibreWorkerBuild(await fixture(t))).status, 'ok');
});

for (const quote of ['"', "'", '`']) {
  test(`accepts the static relative worker URL emitted with ${quote} delimiters`, async (t) => {
    const directory = await fixture(t);
    await writeFile(join(directory, '.output/public/_nuxt/client.js'),
      `setWorkerUrl(new URL(${quote}maplibre-gl-worker-test.js${quote},import.meta.url).href);`);
    assert.equal((await verifyMaplibreWorkerBuild(directory)).status, 'ok');
  });
}

test('rejects interpolated or malformed worker URL literals', async (t) => {
  const directory = await fixture(t);
  for (const source of [
    'setWorkerUrl(new URL(`${prefix}maplibre-gl-worker-test.js`,import.meta.url).href);',
    'setWorkerUrl(new URL(`maplibre-gl-worker-test.js${suffix}`,import.meta.url).href);',
    'setWorkerUrl(`/_nuxt/maplibre-gl-worker-test.js${suffix}`);',
    'setWorkerUrl(new URL(`maplibre-gl-worker-test.js",import.meta.url).href);',
  ]) {
    await writeFile(join(directory, '.output/public/_nuxt/client.js'), source);
    await assert.rejects(verifyMaplibreWorkerBuild(directory), /must reference/, source);
  }
});

test('rejects the missing-worker regression even when the client compiles', async (t) => {
  await assert.rejects(verifyMaplibreWorkerBuild(await fixture(t, { worker: null })), /must be published/);
});

test('rejects a worker copied with its shared module missing', async (t) => {
  await assert.rejects(verifyMaplibreWorkerBuild(await fixture(t, {
    worker: 'import { worker } from "./maplibre-gl-shared.mjs";',
  })), /missing sibling import/);
});

test('rejects an empty or unreferenced worker', async (t) => {
  await assert.rejects(verifyMaplibreWorkerBuild(await fixture(t, { worker: '' })), /empty/);
  await assert.rejects(verifyMaplibreWorkerBuild(await fixture(t, { reference: false })), /must reference/);
});

test('both frontends register the bundled worker in a client plugin and verify their builds', async () => {
  for (const app of ['frontend', 'frontend-admin']) {
    const plugin = await readFile(new URL(`../apps/${app}/client/plugins/maplibre.client.ts`, import.meta.url), 'utf8');
    assert.match(plugin, /maplibre-gl-worker\.mjs\?worker&url/);
    assert.match(plugin, /defineNuxtPlugin\([\s\S]*setWorkerUrl\(workerUrl\)/);
    const manifest = JSON.parse(await readFile(new URL(`../apps/${app}/package.json`, import.meta.url), 'utf8'));
    assert.match(manifest.scripts.build, /&& node \.\.\/\.\.\/scripts\/verify-maplibre-worker-build\.mjs$/);
  }
});
