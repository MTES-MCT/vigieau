import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyMaplibreWorkerBuild(appDirectory) {
  const bundleDirectory = join(appDirectory, '.output/public/_nuxt');
  const files = await readdir(bundleDirectory);
  const workers = files.filter((file) => /^maplibre-gl-worker-[\w-]+\.js$/.test(file));
  assert.equal(workers.length, 1, 'Exactly one bundled MapLibre worker must be published');
  const worker = workers[0];
  const workerSource = await readFile(join(bundleDirectory, worker), 'utf8');
  assert.ok(workerSource.trim().length > 0, 'The MapLibre worker is empty');
  assert.doesNotMatch(
    workerSource,
    /(?:from\s*|import\s*\(?)["'`][^"'`]*maplibre-gl-shared\.mjs/,
    'The MapLibre shared module must be bundled, not left as a missing sibling import',
  );
  const clientBundles = await Promise.all(files
    .filter((file) => file.endsWith('.js') && file !== worker)
    .map((file) => readFile(join(bundleDirectory, file), 'utf8')));
  const relativeWorkerUrl = new RegExp(
    `new URL\\(["'](?:\\./)?${worker.replaceAll('.', '\\.')}["'],\\s*import\\.meta\\.url\\)`,
  );
  assert.ok(
    clientBundles.some((source) => source.includes(`/_nuxt/${worker}`) || relativeWorkerUrl.test(source)),
    'The client must reference the published MapLibre worker URL',
  );
  return { status: 'ok', worker };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await verifyMaplibreWorkerBuild(process.cwd())));
}
