import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectPrivateSourcemaps } from './sentry-private-sourcemaps.mjs';

test('keeps exact assets private with maps and removes maps from public output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vigieau-sourcemaps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const publicDir = join(root, '.output/public/_nuxt');
  await mkdir(publicDir, { recursive: true });
  const javascript = Buffer.from('export default 1;\n');
  await writeFile(join(publicDir, 'entry.js'), javascript);
  await writeFile(join(publicDir, 'entry.js.map'), JSON.stringify({ version: 3, sources: ['entry.ts'], mappings: '' }));
  const artifacts = await collectPrivateSourcemaps(root);
  assert.deepEqual(await readdir(publicDir), ['entry.js']);
  assert.deepEqual(await readFile(join(root, '.sentry-sourcemaps/_nuxt/entry.js')), javascript);
  assert.deepEqual(await readFile(join(publicDir, 'entry.js')), javascript);
  assert.equal(artifacts[0].file, '_nuxt/entry.js');
  assert.equal(artifacts[0].sha256, createHash('sha256').update(javascript).digest('hex'));
  assert.deepEqual(JSON.parse(await readFile(join(root, '.sentry-sourcemaps/manifest.json'), 'utf8')).artifacts, artifacts);
  assert.equal(JSON.parse(await readFile(join(root, '.sentry-sourcemaps/_nuxt/entry.js.map'), 'utf8')).version, 3);
});

test('fails the build instead of silently omitting sourcemaps', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vigieau-sourcemaps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.output/public'), { recursive: true });
  await assert.rejects(collectPrivateSourcemaps(root), /No client sourcemaps/);
});

test('removes precompressed maps without modifying precompressed deployed assets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vigieau-sourcemaps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const publicDir = join(root, '.output/public/_nuxt');
  await mkdir(publicDir, { recursive: true });
  for (const file of ['entry.js', 'entry.js.map', 'entry.js.map.gz', 'entry.js.map.br', 'orphan.js.map.br', 'entry.js.gz', 'entry.js.br']) {
    await writeFile(join(publicDir, file), file);
  }
  await collectPrivateSourcemaps(root);
  assert.deepEqual(await readdir(publicDir), ['entry.js', 'entry.js.br', 'entry.js.gz']);
  assert.equal(await readFile(join(publicDir, 'entry.js.gz'), 'utf8'), 'entry.js.gz');
  assert.equal(await readFile(join(publicDir, 'entry.js.br'), 'utf8'), 'entry.js.br');
});

test('rejects public symlinks rather than following files outside the output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vigieau-sourcemaps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const publicDir = join(root, '.output/public');
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(root, 'private.js'), 'private');
  await symlink(join(root, 'private.js'), join(publicDir, 'entry.js'));
  await assert.rejects(collectPrivateSourcemaps(root), /Unexpected public symlink/);
  assert.equal(await readFile(join(root, 'private.js'), 'utf8'), 'private');
});
