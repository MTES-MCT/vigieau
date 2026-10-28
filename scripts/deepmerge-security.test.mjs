import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { after, test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const applications = ['backend', 'backend-admin', 'frontend', 'frontend-admin'];
const artifactName = 'vigieau-deepmerge-4.3.1-vigieau.1.tgz';
const artifactIntegrity = 'sha512-Ym8b3RNNm1f+VPKXaL8jqU8X1YyWzN0Fh39r5TNTwhEdraj+Q6p2lmZAzXtoxneal6RNEgo1qF9gDiEqxK0zuw==';
const upstreamIntegrity = 'sha512-3sUqbMEc77XqpdNO7FRyRog+eW3ph+GYCbj+rK+uYyRMuwsVy0rMiVtPn+QJlKFvWP/1PYpapqYn0Me2knFn+A==';
const temporary = mkdtempSync(join(tmpdir(), 'vigieau-deepmerge-security-'));
after(() => rmSync(temporary, { recursive: true, force: true }));
const require = createRequire(import.meta.url);
const upstreamArchive = join(root, 'vendor/deepmerge/upstream/deepmerge-4.3.1.tgz');
assert.equal(`sha512-${createHash('sha512').update(readFileSync(upstreamArchive)).digest('base64')}`, upstreamIntegrity);
execFileSync('tar', ['-xzf', upstreamArchive, '-C', temporary]);
const upstream = require(join(temporary, 'package/dist/cjs.js'));
const payload = value => JSON.parse(`{"__proto__":${JSON.stringify(value)}}`);

test('the pinned unmodified package reproduces CVE-2026-93753 without changing Object.prototype', () => {
  const target = payload({ privileged: true });
  assert.equal(Object.getPrototypeOf(target), Object.prototype);
  const merged = upstream(target, {});
  assert.notEqual(Object.getPrototypeOf(merged), Object.prototype);
  assert.equal(merged.privileged, true);
  assert.equal(Object.hasOwn(merged, 'privileged'), false);
  assert.equal(({}).privileged, undefined);
});

test('all four security archives rebuild byte-for-byte from the pinned source', () => {
  execFileSync(process.execPath, [join(root, 'scripts/build-deepmerge-security-fork.mjs'), '--check'], {
    cwd: root, timeout: 30_000, stdio: 'pipe',
  });
});

function checkPrototypeSafety(merge) {
  for (const options of [{}, { clone: false }]) {
    // Exercise the target copy, source clone and recursive/custom merge writes.
    const cases = [
      [payload({ privileged: true }), {}],
      [Object.create(null), payload({ privileged: true })],
      [payload({ existing: true }), payload({ privileged: true })],
      [{ nested: payload({ privileged: true }) }, {}],
    ];
    for (const [target, source] of cases) {
      const beforeTarget = JSON.stringify(target);
      const beforeSource = JSON.stringify(source);
      const merged = merge(target, source, options);
      assert.equal(Object.getPrototypeOf(merged), Object.prototype);
      assert.equal(merged.privileged, undefined);
      if (merged.nested) {
        assert.equal(Object.getPrototypeOf(merged.nested), Object.prototype);
        assert.equal(merged.nested.privileged, undefined);
      }
      assert.equal(JSON.stringify(target), beforeTarget);
      assert.equal(JSON.stringify(source), beforeSource);
    }
  }
  const target = payload({ existing: true });
  const source = payload({ privileged: true });
  const customKeys = [];
  const merged = merge(target, source, {
    customMerge(key) {
      customKeys.push(key);
      return key === '__proto__' ? () => ({ privileged: true }) : undefined;
    },
  });
  assert(customKeys.includes('__proto__'));
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.equal(merged.privileged, undefined);
  assert.deepEqual(Object.getOwnPropertyDescriptor(merged, '__proto__'), {
    value: { privileged: true }, enumerable: true, configurable: true, writable: true,
  });
  const constructorPayload = JSON.parse('{"constructor":{"prototype":{"polluted":true}}}');
  const constructorResult = merge(constructorPayload, { constructor: { custom: 'kept' } });
  assert.equal(Object.getPrototypeOf(constructorResult), Object.prototype);
  assert.deepEqual(constructorResult.constructor, { prototype: { polluted: true }, custom: 'kept' });
  assert.equal(constructorResult.polluted, undefined);
  assert.equal(({}).polluted, undefined);
  assert.deepEqual(merge({}, constructorPayload), {});
  assert.deepEqual(merge({}, payload({ privileged: true })), {});

  const setterKey = Symbol('inherited setter');
  let setterCalls = 0;
  Object.defineProperty(Object.prototype, setterKey, {
    set() { setterCalls++; }, configurable: true,
  });
  try {
    const ownTarget = Object.defineProperty({}, setterKey, {
      value: { safe: true }, enumerable: true,
    });
    const ownResult = merge(ownTarget, {});
    assert.equal(setterCalls, 0);
    assert.equal(Object.hasOwn(ownResult, setterKey), true);
    assert.deepEqual(ownResult[setterKey], { safe: true });
  } finally {
    delete Object.prototype[setterKey];
  }
}

function checkCompatibility(merge) {
  const symbol = Symbol('enumerable');
  const hidden = Symbol('hidden');
  const target = { plain: { a: 1 }, array: [{ a: 1 }], [symbol]: { a: 1 } };
  Object.defineProperty(target, hidden, { value: 'not copied', enumerable: false });
  const source = { plain: { b: 2 }, array: [{ b: 2 }], [symbol]: { b: 2 } };
  const result = merge(target, source);
  assert.deepEqual(result, { plain: { a: 1, b: 2 }, array: [{ a: 1 }, { b: 2 }], [symbol]: { a: 1, b: 2 } });
  assert.notEqual(result.plain, target.plain);
  assert.notEqual(result.array[0], target.array[0]);
  assert.equal(result[hidden], undefined);
  assert.equal(merge(target, {}, { clone: false }).plain, target.plain);
  assert.deepEqual(merge.all([{ one: 1 }, { two: 2 }, { nested: { three: 3 } }]), { one: 1, two: 2, nested: { three: 3 } });
  assert.throws(() => merge.all({}), /first argument should be an array/);
  assert.deepEqual(merge([1], [2], { arrayMerge: (_, values) => values }), [2]);
  assert.deepEqual(merge({ plain: { a: 1 } }, { plain: { b: 2 } }, {
    customMerge: key => key === 'plain' ? (left, right) => ({ total: left.a + right.b }) : undefined,
  }), { plain: { total: 3 } });
  const date = new Date('2026-10-28T00:00:00Z');
  const regexp = /vigieau/;
  assert.equal(merge({}, { date }).date, date);
  assert.equal(merge({}, { regexp }).regexp, regexp);
  const inherited = Object.create({ inherited: { hidden: true } });
  inherited.own = 1;
  assert.deepEqual(merge(inherited, { inherited: { unexpected: true } }), { own: 1 });
}

for (const app of applications) {
  const appRoot = join(root, 'apps', app);
  const lock = JSON.parse(readFileSync(join(appRoot, 'package-lock.json'), 'utf8'));
  const copies = Object.entries(lock.packages).filter(([path]) => path.endsWith('node_modules/deepmerge'));
  test(`${app}: every installed deepmerge copy is the integrity-pinned repaired fork`, () => {
    assert(copies.length > 0);
    assert.equal(`sha512-${createHash('sha512').update(readFileSync(join(appRoot, 'vendor', artifactName))).digest('base64')}`, artifactIntegrity);
    for (const [path, metadata] of copies) {
      assert.equal(metadata.integrity, artifactIntegrity, path);
      const packageRoot = join(appRoot, path);
      const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
      assert.equal(manifest.name, '@vigieau/deepmerge');
      assert.equal(manifest.version, '4.3.1-vigieau.1');
      assert.equal(manifest.scripts, undefined);
      assert.equal(manifest.vigieauSecurityFork.integrity, upstreamIntegrity);
      assert.equal(manifest.vigieauSecurityFork.advisory, 'GHSA-gcqx-w48m-w2h4');
      for (const bundle of ['dist/cjs.js', 'dist/umd.js']) {
        const merge = require(join(packageRoot, bundle));
        checkPrototypeSafety(merge);
        checkCompatibility(merge);
      }
      const globalBundle = {};
      runInNewContext(readFileSync(join(packageRoot, 'dist/umd.js'), 'utf8'), globalBundle);
      assert.equal(typeof globalBundle.deepmerge, 'function');
      const browserResult = globalBundle.deepmerge(payload({ privileged: true }), {});
      assert.equal(browserResult.privileged, undefined);
      assert.equal(Object.hasOwn(browserResult, '__proto__'), true);
      assert.equal(Object.getPrototypeOf(browserResult), Object.getPrototypeOf(globalBundle.deepmerge({}, {})));
    }
  });
}
