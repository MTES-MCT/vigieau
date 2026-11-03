import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const applications = process.env.VIGIEAU_SECURITY_APPS?.split(',') ?? ['backend', 'backend-admin', 'frontend', 'frontend-admin'];
const temporary = mkdtempSync(join(tmpdir(), 'vigieau-minimatch-test-'));
after(() => rmSync(temporary, { recursive: true, force: true }));
const appRequire = application => createRequire(join(root, 'apps', application, 'package.json'));
const firstRequire = appRequire(applications[0]);
const modernRequire = createRequire(firstRequire.resolve('minimatch-modern/package.json'));
const archive = join(root, 'vendor/minimatch/upstream/minimatch-10.2.6.tgz');
assert.equal(`sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`, 'sha512-vpLQEs+VLCr1nU0BXS07maYoFwlDAH0gngQuuttxIwutDFEMHq2blX+8vpgxDdK3J1PwjCJiep77OitTZ4Ll1A==');
execFileSync('tar', ['-xzf', archive, '-C', temporary]);
mkdirSync(join(temporary, 'package/node_modules'));
symlinkSync(dirname(modernRequire.resolve('brace-expansion/package.json')), join(temporary, 'package/node_modules/brace-expansion'), 'dir');
const upstream = createRequire(import.meta.url)(join(temporary, 'package/dist/commonjs/index.js'));
const fixtures = JSON.parse(readFileSync(join(root, 'vendor/minimatch/legacy-fixtures.json'), 'utf8'));
const maliciousPattern = Array(7).fill('**/../a/b').join('/');
const securityOptions = { optimizationLevel: 2, braceExpandMax: 8 };

test('unmodified 10.2.6 reproduces bounded pattern amplification', () => {
  assert.equal(new upstream.Minimatch(maliciousPattern, securityOptions).set.length, 128);
});

test('both archives rebuild byte-for-byte in all four application directories', () => {
  execFileSync(process.execPath, [join(root, 'scripts/build-minimatch-security-fork.mjs'), '--check'], { cwd: root, timeout: 30_000, stdio: 'pipe' });
});

function checkSecurity(matcher) {
  assert.equal(new matcher.Minimatch(maliciousPattern, securityOptions).set.length, 8);
  const small = new matcher.Minimatch('**/../a/b/**/../c/d', { optimizationLevel: 2 });
  assert.equal(small.set.length, 4);
  assert(small.match('../a/b/../c/d'));
  assert(small.match('x/a/b/y/c/d'));
  const large = new matcher.Minimatch('{x,*}/{0..999}', { optimizationLevel: 2 });
  assert.equal(large.set.length, 2000);
  assert(large.match('x/5'));
  assert(large.match('y/999'));
  assert(!large.match('.y/5'));
  assert.equal(typeof matcher.makeRe, 'function');
  assert(matcher.makeRe('**/*.js').test('src/example.js'));
}

for (const application of applications) {
  const require = appRequire(application);
  test(`${application}: both named-export builds contain the backport and retain regex APIs`, async () => {
    const packageRoot = dirname(require.resolve('minimatch-modern/package.json'));
    const cjs = require('minimatch-modern');
    const esm = await import(pathToFileURL(join(packageRoot, 'dist/esm/index.js')));
    for (const matcher of [cjs, esm]) {
      checkSecurity(matcher);
      assert.equal(typeof matcher.AST, 'function');
    }
  });

  test(`${application}: callable legacy facade preserves all 2128 upstream cases for versions 3 and 5`, () => {
    const legacy = require('minimatch-legacy');
    assert.equal(typeof legacy, 'function');
    for (const reference of fixtures.references) {
      let index = 0;
      for (const pattern of fixtures.patterns) for (const filename of fixtures.paths) for (const options of fixtures.options) {
        assert.equal(legacy(filename, pattern, options), reference.results[index++] === '1', JSON.stringify({ upstream: reference.version, pattern, filename, options }));
      }
      assert.equal(index, 2128);
      assert.equal(reference.results.length, index);
    }
    assert.equal(legacy.defaults({ dot: true })('.example', '*'), true);
    assert(legacy.makeRe('**/*.js').test('src/example.js'));
    checkSecurity(legacy);
  });

  test(`${application}: every installed minimatch alias uses the corrected implementation`, async () => {
    const appRoot = join(root, 'apps', application);
    const lock = JSON.parse(readFileSync(join(appRoot, 'package-lock.json'), 'utf8'));
    const copies = Object.entries(lock.packages).filter(([path]) => path.endsWith('node_modules/minimatch'));
    assert(copies.length > 0);
    for (const [relative, metadata] of copies) {
      const packageRoot = join(appRoot, relative);
      const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
      if (manifest.version.startsWith('11.')) {
        assert(Number(manifest.version.split('.')[2]) >= 1);
        continue;
      }
      assert.match(manifest.name, /^@vigieau\/minimatch(?:-legacy)?$/);
      assert.equal(manifest.version, '10.2.6-vigieau.1');
      assert.equal(manifest.vigieauSecurityFork.advisory, 'GHSA-g3hv-75wg-m249');
      assert(!manifest.scripts);
      assert(metadata.resolved.startsWith('file:vendor/'));
      assert.equal(metadata.integrity, `sha512-${createHash('sha512').update(readFileSync(join(appRoot, metadata.resolved.slice(5)))).digest('base64')}`);
      checkSecurity(require(packageRoot));
    }
  });

  test(`${application}: installed legacy glob consumers still match files and honor ignores`, () => {
    const appRoot = join(root, 'apps', application);
    const lock = JSON.parse(readFileSync(join(appRoot, 'package-lock.json'), 'utf8'));
    const copies = Object.entries(lock.packages).filter(([path, item]) => path.endsWith('node_modules/glob') && item.version.startsWith('7.'));
    const fixtureRoot = join(temporary, application);
    mkdirSync(join(fixtureRoot, 'nested'), { recursive: true });
    writeFileSync(join(fixtureRoot, 'a.txt'), 'a');
    writeFileSync(join(fixtureRoot, 'nested/b.txt'), 'b');
    writeFileSync(join(fixtureRoot, 'nested/ignore.txt'), 'ignore');
    for (const [relative] of copies) {
      const glob = require(join(appRoot, relative));
      assert.deepEqual(glob.sync('**/*.txt', { cwd: fixtureRoot, ignore: '**/ignore.txt' }).sort(), ['a.txt', 'nested/b.txt']);
    }
  });
}
