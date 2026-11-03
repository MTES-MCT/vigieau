import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { previewAddress, staticPreview } from './preview-static.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicApp = join(root, 'apps/frontend');

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'vigieau-static-preview-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const publicDirectory = join(directory, '.output/public');
  for (const [path, value] of Object.entries({
    'index.html': '<h1>Application</h1>',
    'abonnements/index.html': '<h1>Abonnements</h1>',
    '_nuxt/app.js': 'const app = true;',
    '_nuxt/app.js.map': 'private sourcemap',
    '_nuxt/app.js.map.gz': 'private compressed sourcemap',
    'sw.js': '// service worker',
    'inject-sw.js': '// register service worker',
    'manifest.webmanifest': '{"name":"VigiEau"}',
    '.env': 'private environment',
  })) {
    mkdirSync(dirname(join(publicDirectory, path)), { recursive: true });
    writeFileSync(join(publicDirectory, path), value);
  }
  return { directory, publicDirectory };
}

test('preview honors CLI and environment bind settings and rejects invalid ports', () => {
  assert.deepEqual(previewAddress({}, []), { port: 3000, host: '0.0.0.0' });
  assert.deepEqual(previewAddress({ PORT: '3003', HOST: '0.0.0.0' }, []), { port: 3003, host: '0.0.0.0' });
  assert.deepEqual(previewAddress({ PORT: '3000', NITRO_PORT: '3100', NUXT_PORT: '3200', HOST: '0.0.0.0', NITRO_HOST: '::', NUXT_HOST: 'localhost' }, []), { port: 3200, host: 'localhost' });
  assert.deepEqual(previewAddress({ PORT: '3003' }, ['--port', '0', '--host', '127.0.0.1']), { port: 0, host: '127.0.0.1' });
  for (const PORT of ['NaN', '-1', '65536', '3000abc']) assert.throws(() => previewAddress({ PORT }, []), /Invalid preview port/);
});

test('preview serves generated routes, SPA links and assets without exposing maps or fallback asset responses', async (t) => {
  const { publicDirectory } = fixture(t);
  const server = staticPreview({ appDirectory: publicApp, publicDirectory });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [path, expected] of [['/', 'Application'], ['/abonnements', 'Abonnements'], ['/situation?lon=0&lat=0', 'Application']]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), new RegExp(expected));
  }
  const asset = await fetch(`${base}/_nuxt/app.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);
  assert.match(asset.headers.get('cache-control'), /immutable/);
  for (const path of ['/sw.js', '/inject-sw.js', '/manifest.webmanifest']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
  }
  for (const path of ['/_nuxt/app.js.map', '/_nuxt/app.js.map.gz', '/_nuxt/app.js.%6dap', '/_nuxt/missing', '/_nuxt/missing.js', '/workbox-missing.js', '/.env', '/preview.mjs']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(await response.text(), /private|Application/);
  }
  const head = await fetch(`${base}/_nuxt/app.js`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const post = await fetch(`${base}/abonnements`, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
});

test('preview reports a missing static build without trying a Node server entrypoint', (t) => {
  const { directory } = fixture(t);
  assert.throws(() => staticPreview({ appDirectory: directory, publicDirectory: join(directory, 'absent') }), /Run npm run build/);
});

for (const application of ['frontend', 'frontend-admin']) {
  test(`${application}: exact npm start runs a standalone generated app without the monorepo`, async (t) => {
    const { directory } = fixture(t);
    const appDirectory = join(root, 'apps', application);
    const manifest = JSON.parse(readFileSync(join(appDirectory, 'package.json'), 'utf8'));
    assert.equal(manifest.dependencies.sirv, '3.0.2');
    assert.match(manifest.scripts.build, /prepare-static-preview\.mjs(?: &&|$)/);
    if (manifest.scripts.generate) assert.match(manifest.scripts.generate, /prepare-static-preview\.mjs$/);
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, scripts: { start: manifest.scripts.start } }));
    const require = createRequire(join(appDirectory, 'package.json'));
    for (const dependency of ['sirv', '@polka/url', 'mrmime', 'totalist']) {
      let packageRoot = dirname(require.resolve(dependency));
      while (!existsSync(join(packageRoot, 'package.json')) || JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).name !== dependency) {
        assert.notEqual(dirname(packageRoot), packageRoot, `Package root not found for ${dependency}`);
        packageRoot = dirname(packageRoot);
      }
      cpSync(packageRoot, join(directory, 'node_modules', dependency), { recursive: true });
    }
    execFileSync(process.execPath, [join(root, 'scripts/prepare-static-preview.mjs')], { cwd: directory });
    const child = spawn('npm', ['start', '--', '--port', '0', '--host', '127.0.0.1'], {
      cwd: directory,
      env: { ...process.env, NODE_ENV: 'production' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const stopped = once(child, 'exit');
      process.kill(-child.pid, 'SIGTERM');
      await stopped;
    });
    let output = '';
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Static preview did not start: ${output}`)), 10_000);
      const observe = chunk => {
        output += chunk;
        const match = output.match(/Static preview listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      };
      child.stdout.on('data', observe);
      child.stderr.on('data', observe);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Static preview exited ${code}: ${output}`)); });
    });
    const response = await fetch(`${url}/situation?lon=0&lat=0`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Application/);
  });
}
