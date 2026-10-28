import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'vendor/deepmerge');
const archive = join(source, 'upstream/deepmerge-4.3.1.tgz');
const originalIntegrity = '3sUqbMEc77XqpdNO7FRyRog+eW3ph+GYCbj+rK+uYyRMuwsVy0rMiVtPn+QJlKFvWP/1PYpapqYn0Me2knFn+A==';
const artifactName = 'vigieau-deepmerge-4.3.1-vigieau.1.tgz';
const integrity = value => createHash('sha512').update(value).digest('base64');
assert.equal(integrity(readFileSync(archive)), originalIntegrity, 'Unexpected upstream tarball');
const temporary = mkdtempSync(join(tmpdir(), 'vigieau-deepmerge-build-'));
try {
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  assert(entries.every(name => name.startsWith('package/') && !name.split('/').includes('..')));
  execFileSync('tar', ['-xzf', archive, '-C', temporary]);
  const packageRoot = join(temporary, 'package');
  assert.equal(readFileSync(join(packageRoot, 'license.txt'), 'utf8').trim(), readFileSync(join(source, 'LICENSE'), 'utf8').trim());
  const writer = readFileSync(join(source, 'define-property.js'), 'utf8');
  for (const relative of ['index.js', 'dist/cjs.js', 'dist/umd.js']) {
    const file = join(packageRoot, relative);
    let content = readFileSync(file, 'utf8');
    const marker = 'function mergeObject(target, source, options) {';
    assert.equal(content.split(marker).length, 2, `Upstream object merger changed: ${relative}`);
    content = content.replace(marker, `${writer}\n${marker}`);
    for (const expression of [
      'cloneUnlessOtherwiseSpecified(target[key], options)',
      'getMergeFunction(key, options)(target[key], source[key], options)',
      'cloneUnlessOtherwiseSpecified(source[key], options)',
    ]) {
      const original = `destination[key] = ${expression}`;
      assert.equal(content.split(original).length, 2, `Upstream assignment changed: ${relative}`);
      content = content.replace(original, `setOwnProperty(destination, key, ${expression})`);
    }
    assert(!content.includes('destination[key] ='), `Unsafe destination assignment in ${relative}`);
    writeFileSync(file, content);
  }
  const manifestPath = join(packageRoot, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.name = '@vigieau/deepmerge';
  manifest.version = '4.3.1-vigieau.1';
  manifest.private = true;
  manifest.description = 'VigiEau security fork of deepmerge 4.3.1 with prototype-safe destination writes';
  delete manifest.devDependencies;
  delete manifest.scripts;
  manifest.vigieauSecurityFork = {
    upstream: 'TehShrike/deepmerge',
    commit: '5b87756a5671635679001cbac72aa42f23472c81',
    integrity: `sha512-${originalIntegrity}`,
    advisory: 'GHSA-gcqx-w48m-w2h4',
    remediation: 'Use own data properties for all object destination writes, never inherited setters',
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  copyFileSync(join(source, 'README.md'), join(packageRoot, 'SECURITY-FORK.md'));
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], {
    cwd: packageRoot, encoding: 'utf8', env: { ...process.env, SOURCE_DATE_EPOCH: '0' },
  }));
  const metadata = Array.isArray(packed) ? packed[0] : packed[manifest.name];
  assert.equal(metadata?.filename, artifactName);
  const output = join(temporary, artifactName);
  for (const app of ['backend', 'backend-admin', 'frontend', 'frontend-admin']) {
    const destination = join(root, 'apps', app, 'vendor');
    mkdirSync(destination, { recursive: true });
    const target = join(destination, artifactName);
    if (process.argv.includes('--check')) {
      assert(existsSync(target), `Missing archive ${target}`);
      assert.deepEqual(readFileSync(target), readFileSync(output), `Non-reproducible archive ${target}`);
    } else {
      copyFileSync(output, target);
    }
  }
  console.log(JSON.stringify({ filename: artifactName, integrity: `sha512-${integrity(readFileSync(output))}`, reproducible: process.argv.includes('--check') }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
