import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'vendor/minimatch');
const archive = join(source, 'upstream/minimatch-10.2.6.tgz');
const integrity = value => `sha512-${createHash('sha512').update(value).digest('base64')}`;
const originalIntegrity = 'sha512-vpLQEs+VLCr1nU0BXS07maYoFwlDAH0gngQuuttxIwutDFEMHq2blX+8vpgxDdK3J1PwjCJiep77OitTZ4Ll1A==';
assert.equal(integrity(readFileSync(archive)), originalIntegrity, 'Unexpected upstream minimatch archive');
const temporary = mkdtempSync(join(tmpdir(), 'vigieau-minimatch-build-'));

function replaceExactly(text, original, replacement) {
  assert.equal(text.split(original).length, 2, `Upstream minimatch changed: ${original}`);
  return text.replace(original, replacement);
}

try {
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  assert(entries.every(name => name.startsWith('package/') && !name.split('/').includes('..')));
  execFileSync('tar', ['-xzf', archive, '-C', temporary]);
  const packageRoot = join(temporary, 'package');
  for (const distribution of ['commonjs', 'esm']) {
    const file = join(packageRoot, 'dist', distribution, 'index.js');
    let content = readFileSync(file, 'utf8');
    content = replaceExactly(content,
      'firstPhasePreProcess(globParts) {',
      'firstPhasePreProcess(globParts) {\n        const { braceExpandMax = 100_000 } = this.options;');
    content = replaceExactly(content,
      "p2 === '..') {",
      "p2 === '..' ||\n                        globParts.length >= braceExpandMax) {");
    content = replaceExactly(content,
      'secondPhasePreProcess(globParts) {',
      'secondPhasePreProcess(globParts) {\n        if (globParts.length > 1000) return globParts;');
    content = content.replace('//# sourceMappingURL=index.js.map', '');
    writeFileSync(file, content);
    rmSync(`${file}.map`);
  }
  copyFileSync(join(source, 'README.md'), join(packageRoot, 'SECURITY-FORK.md'));
  const manifestPath = join(packageRoot, 'package.json');
  const originalManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const legacy of [false, true]) {
    const manifest = structuredClone(originalManifest);
    manifest.name = legacy ? '@vigieau/minimatch-legacy' : '@vigieau/minimatch';
    manifest.version = '10.2.6-vigieau.1';
    manifest.private = true;
    manifest.description = `VigiEau minimatch 10.2.6 security backport${legacy ? ' with callable legacy API' : ''}`;
    manifest.files = ['dist', 'SECURITY-FORK.md'];
    manifest.dependencies = { 'brace-expansion': '5.0.12' };
    delete manifest.scripts;
    delete manifest.devDependencies;
    delete manifest.tshy;
    manifest.vigieauSecurityFork = {
      upstream: 'https://github.com/isaacs/minimatch',
      version: '10.2.6',
      integrity: originalIntegrity,
      patch: 'https://github.com/isaacs/minimatch/commit/77a0f5c',
      advisory: 'GHSA-g3hv-75wg-m249',
      remediation: 'Bound first-phase pattern splitting and skip quadratic deduplication of large sets',
      legacyCallableApi: legacy,
    };
    if (legacy) {
      copyFileSync(join(source, 'legacy.cjs'), join(packageRoot, 'dist/legacy.cjs'));
      copyFileSync(join(source, 'legacy.d.cts'), join(packageRoot, 'dist/legacy.d.cts'));
      manifest.main = './dist/legacy.cjs';
      manifest.module = './dist/legacy.cjs';
      manifest.types = './dist/legacy.d.cts';
      manifest.exports['.'] = { types: './dist/legacy.d.cts', default: './dist/legacy.cjs' };
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], {
      cwd: packageRoot, encoding: 'utf8', env: { ...process.env, SOURCE_DATE_EPOCH: '0' },
    }));
    const metadata = Array.isArray(packed) ? packed[0] : packed[manifest.name];
    const artifactName = `vigieau-minimatch${legacy ? '-legacy' : ''}-10.2.6-vigieau.1.tgz`;
    assert.equal(metadata.filename, artifactName);
    const output = readFileSync(join(temporary, artifactName));
    for (const application of ['backend', 'backend-admin', 'frontend', 'frontend-admin']) {
      const destination = join(root, 'apps', application, 'vendor');
      mkdirSync(destination, { recursive: true });
      const target = join(destination, artifactName);
      if (process.argv.includes('--check')) assert.deepEqual(readFileSync(target), output, `Non-reproducible archive ${target}`);
      else writeFileSync(target, output);
    }
    console.log(JSON.stringify({ filename: artifactName, integrity: integrity(output), reproducible: process.argv.includes('--check') }));
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
