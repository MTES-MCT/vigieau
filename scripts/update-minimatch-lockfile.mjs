import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// npm 12 resolves a newly introduced relative file override from the consumer
// directory. Bootstrap only that resolution with absolute paths, then restore
// the manifest and portable lockfile before any clean installation.
const applications = ['backend', 'backend-admin', 'frontend', 'frontend-admin'];
const application = process.argv[2];
assert(applications.includes(application), `Choose an application: ${applications.join(', ')}`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = join(root, 'apps', application);
const manifestPath = join(appRoot, 'package.json');
const lockPath = join(appRoot, 'package-lock.json');
const original = readFileSync(manifestPath, 'utf8');
const originalLock = readFileSync(lockPath, 'utf8');
const manifest = JSON.parse(original);
assert.equal(execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(), manifest.engines.npm);
assert.equal(process.versions.node, manifest.engines.node);
for (const [key, dependency] of [['minimatch@<6', 'minimatch-legacy'], ['minimatch@>=9 <11', 'minimatch-modern']]) {
  assert.equal(manifest.overrides[key], `$${dependency}`);
  const spec = manifest.devDependencies[dependency];
  assert(spec.startsWith('file:vendor/'));
  manifest.overrides[key] = `file:${join(appRoot, spec.slice(5))}`;
}
try {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], { cwd: appRoot, stdio: 'inherit' });
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const prefix = `file:${join(appRoot, 'vendor')}/`;
  for (const item of Object.values(lock.packages)) {
    if (item.resolved?.startsWith(prefix)) item.resolved = `file:vendor/${item.resolved.slice(prefix.length)}`;
  }
  const portable = `${JSON.stringify(lock, null, 2)}\n`;
  assert(!portable.includes(appRoot), 'An absolute project path remains in the lockfile');
  writeFileSync(lockPath, portable);
} catch (error) {
  writeFileSync(lockPath, originalLock);
  throw error;
} finally {
  writeFileSync(manifestPath, original);
}
