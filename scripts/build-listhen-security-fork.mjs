import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'vendor/listhen');
const archive = join(source, 'upstream/listhen-1.10.1.tgz');
const originalIntegrity = '6nt/86SkqUQSLW1ofz8MxC6RhRMqOl3ONISe6qqvJ3xj09aJWQx6DhgSZpugs3PX4PXdOas/WD6A9jx6J2N19A==';
const artifactName = 'vigieau-listhen-1.10.1-vigieau.1.tgz';
const integrity = value => createHash('sha512').update(value).digest('base64');
assert.equal(integrity(readFileSync(archive)), originalIntegrity, 'Unexpected upstream tarball');
const temporary = mkdtempSync(join(tmpdir(), 'vigieau-listhen-build-'));
try {
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  assert(entries.every(name => name.startsWith('package/') && !name.split('/').includes('..')));
  execFileSync('tar', ['-xzf', archive, '-C', temporary]);
  const packageRoot = join(temporary, 'package');
  const manifestPath = join(packageRoot, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.name = '@vigieau/listhen';
  manifest.version = '1.10.1-vigieau.1';
  manifest.private = true;
  manifest.description = 'VigiEau security fork of listhen 1.10.1 using native crypto and selfsigned';
  delete manifest.dependencies['node-forge'];
  manifest.dependencies.selfsigned = '5.5.0';
  delete manifest.devDependencies;
  delete manifest.scripts;
  delete manifest.packageManager;
  manifest.files.push('SECURITY-FORK.md');
  manifest.vigieauSecurityFork = {
    upstream: 'unjs/listhen',
    commit: '2466b698997f6d5006c22f36ab54379df277cf5f',
    integrity: `sha512-${originalIntegrity}`,
    advisory: 'GHSA-86w9-cpqp-85rv',
    remediation: 'Remove node-forge; use selfsigned 5.5.0 and native Node TLS/crypto',
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  copyFileSync(join(source, 'certificate.cjs'), join(packageRoot, 'dist/certificate.cjs'));
  copyFileSync(join(source, 'README.md'), join(packageRoot, 'SECURITY-FORK.md'));
  let replacedBundles = 0;
  let replacedTypes = 0;
  for (const relative of entries.map(name => name.slice('package/'.length))) {
    if (!/\.(?:mjs|cjs|d\.ts|d\.mts|d\.cts)$/.test(relative)) continue;
    const file = join(packageRoot, relative);
    let content = readFileSync(file, 'utf8');
    if (relative.startsWith('dist/shared/') && /\.(mjs|cjs)$/.test(relative)) {
      const start = content.indexOf('async function resolveCertificate(options) {');
      const end = content.indexOf('\nasync function listen(handle, _options = {}) {', start);
      assert(start > 0 && end > start, 'Upstream certificate block changed');
      content = `${content.slice(0, start)}${content.slice(end)}`;
      if (relative.endsWith('.mjs')) {
        assert(content.includes("import forge from 'node-forge';"));
        content = content.replace("import forge from 'node-forge';", "import certificateModule from '../certificate.cjs';\nconst { resolveCertificate } = certificateModule;");
      } else {
        assert(content.includes("const forge = require('node-forge');"));
        content = content.replace("const forge = require('node-forge');", "const { resolveCertificate } = require('../certificate.cjs');");
        content = content.replace(/^const forge__default = .*\n/m, '');
      }
      replacedBundles++;
    }
    content = content.replace(/^(?:import 'node-forge';|require\('node-forge'\);)\n/gm, '');
    if (/dist\/shared\/.*\.d\.(?:ts|mts|cts)$/.test(relative)) {
      assert(content.includes('https: false | Certificate;'));
      content = content.replace('interface HTTPSOptions {', 'interface PfxCertificate {\n    pfx: Buffer;\n    passphrase?: string;\n}\ninterface HTTPSOptions {');
      content = content.replace('https: false | Certificate;', 'https: false | Certificate | PfxCertificate;');
      replacedTypes++;
    }
    assert(!content.includes('node-forge'), `Remaining forge import in ${relative}`);
    writeFileSync(file, content);
  }
  assert.equal(replacedBundles, 2);
  assert.equal(replacedTypes, 3);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = JSON.parse(execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], {
    cwd: packageRoot, encoding: 'utf8', env: { ...process.env, SOURCE_DATE_EPOCH: '0' },
  }));
  assert.equal(packed[0].filename, artifactName);
  const output = join(temporary, artifactName);
  for (const app of ['frontend', 'frontend-admin']) {
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
