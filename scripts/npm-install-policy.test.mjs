import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projects = ['.', 'apps/backend', 'apps/backend-admin', 'apps/frontend', 'apps/frontend-admin'];
const engines = { node: '24.22.1', npm: '12.2.1' };
const packageName = '(?:@[a-z0-9._-]+/)?[a-z0-9._-]+';
const exactApproval = new RegExp(`^(${packageName})@(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)$`);
const registryName = new RegExp(`^${packageName}$`);
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

test('all project manifests, locks and npm configs enforce the reviewed toolchain', () => {
  for (const project of projects) {
    const directory = join(repository, project);
    const manifest = readJson(join(directory, 'package.json'));
    const lock = readJson(join(directory, 'package-lock.json'));
    assert.deepEqual(manifest.engines, engines, `${project}: manifest engines`);
    assert.deepEqual(lock.packages[''].engines, engines, `${project}: lock engines`);
    assert.equal(manifest.packageManager, `npm@${engines.npm}`, `${project}: package manager`);
    const config = readFileSync(join(directory, '.npmrc'), 'utf8');
    assert.equal(config.match(/^\s*strict-allow-scripts\s*=\s*true\s*$/gm)?.length, 1, `${project}: strict script policy`);
    assert.doesNotMatch(config, /^\s*(?:ignore-scripts|dangerously-allow-all-scripts|allow-scripts)(?:\[\])?\s*=/im, `${project}: script policy bypass`);
    assert.doesNotMatch(config, /^\s*(?:allow-git|allow-remote)\s*=\s*(?!none\s*$)\S+/im, `${project}: non-registry source bypass`);
    assert.doesNotMatch(config, /^\s*strict-allow-scripts\s*=\s*(?!true\s*$)\S+/im, `${project}: conflicting strict policy`);
  }
});

test('install-script approvals pin registry identities with locked provenance and integrity', () => {
  for (const project of projects) {
    const directory = join(repository, project);
    const policy = readJson(join(directory, 'package.json')).allowScripts;
    const lock = readJson(join(directory, 'package-lock.json'));
    assert(policy && typeof policy === 'object' && !Array.isArray(policy), `${project}: missing policy`);
    const identities = new Set();
    const verifiedApprovals = new Set();
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!path || !entry.hasInstallScript) continue;
      if (!entry.resolved) {
        // Name-only denials remain safe when older locks omit registry metadata.
        const name = path.split('node_modules/').at(-1);
        const key = `${name}@${entry.version}`;
        assert(policy[name] === false || policy[key] === false, `${project}/${path}: approval requires locked provenance`);
        identities.add(key);
        continue;
      }
      assert.equal(typeof entry.resolved, 'string', `${project}/${path}: missing source`);
      const source = new URL(entry.resolved);
      assert.equal(source.origin, 'https://registry.npmjs.org', `${project}/${path}: unreviewed source`);
      const [namePath, archive, extra] = decodeURIComponent(source.pathname).split('/-/');
      const name = namePath.slice(1);
      assert.match(name, registryName, `${project}/${path}: registry identity`);
      assert.equal(extra, undefined, `${project}/${path}: malformed registry path`);
      assert.equal(archive, `${name.split('/').at(-1)}-${entry.version}.tgz`, `${project}/${path}: registry version`);
      const key = `${name}@${entry.version}`;
      identities.add(key);
      assert(policy[key] === true || policy[key] === false || policy[name] === false, `${project}: unreviewed ${key}`);
      if (policy[key] === true) {
        assert.match(entry.integrity ?? '', /^sha512-[A-Za-z0-9+/]{86}==$/, `${project}/${path}: missing SHA-512 integrity`);
        verifiedApprovals.add(key);
      }
    }
    for (const [key, allowed] of Object.entries(policy)) {
      assert.equal(typeof allowed, 'boolean', `${project}: ${key} is not boolean`);
      const exact = exactApproval.exec(key);
      if (allowed) {
        assert(exact, `${project}: approval must pin an exact registry version: ${key}`);
        assert(verifiedApprovals.has(key), `${project}: approval has no verified locked install script: ${key}`);
      } else {
        assert(exact || registryName.test(key), `${project}: invalid registry denial: ${key}`);
        assert(exact ? identities.has(key) : [...identities].some(identity => identity.startsWith(`${key}@`)), `${project}: stale denial: ${key}`);
      }
    }
  }
});

test('npm ci blocks unreviewed and disguised local scripts, respecting explicit source decisions', { timeout: 90_000 }, () => {
  const temporary = mkdtempSync(join(tmpdir(), 'vigieau-npm-policy-'));
  try {
    const fixture = join(temporary, 'fixture');
    const project = join(temporary, 'project');
    const marker = join(temporary, 'hook-executed');
    mkdirSync(fixture);
    mkdirSync(project);
    const userConfig = join(temporary, 'user.npmrc');
    const globalConfig = join(temporary, 'global.npmrc');
    writeFileSync(userConfig, '');
    writeFileSync(globalConfig, '');
    // Keep the fixture independent of developer credentials, npm overrides and caches.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key) && key !== 'NODE_OPTIONS'));
    Object.assign(env, {
      HOME: temporary,
      CI: 'true',
      npm_config_cache: join(temporary, 'cache'),
      npm_config_userconfig: userConfig,
      npm_config_globalconfig: globalConfig,
      npm_config_offline: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
      npm_config_registry: 'http://127.0.0.1:9',
      VIGIEAU_INSTALL_POLICY_MARKER: marker,
    });
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const run = (args, cwd = project) => {
      const result = spawnSync(npm, args, { cwd, env, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
      assert.ifError(result.error);
      return { ...result, output: `${result.stdout}\n${result.stderr}` };
    };
    const succeeds = result => assert.equal(result.status, 0, result.output);
    const version = run(['--version']);
    succeeds(version);
    assert.equal(version.stdout.trim(), engines.npm, 'run the policy test with the pinned npm version on PATH');
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({
      name: 'vigieau-install-script-fixture',
      version: '1.0.0',
      scripts: { install: 'node install.cjs' },
    }));
    writeFileSync(join(fixture, 'install.cjs'), "require('node:fs').writeFileSync(process.env.VIGIEAU_INSTALL_POLICY_MARKER, 'executed');\n");
    succeeds(run(['pack', '--ignore-scripts', '--pack-destination', temporary], fixture));
    const source = 'file:../vigieau-install-script-fixture-1.0.0.tgz';
    const manifest = {
      name: 'vigieau-install-policy-project', version: '1.0.0', private: true,
      dependencies: { 'vigieau-install-script-fixture': source }, allowScripts: {},
    };
    const savePolicy = policy => writeFileSync(join(project, 'package.json'), JSON.stringify({ ...manifest, allowScripts: policy }));
    writeFileSync(join(project, '.npmrc'), 'strict-allow-scripts=true\n');
    savePolicy({});
    // Generate only the fixture lock; the four actual installs below never ignore scripts.
    succeeds(run(['install', '--package-lock-only', '--ignore-scripts']));
    const scenarios = [
      { name: 'unreviewed', policy: {}, blocked: true },
      { name: 'explicit denial', policy: { [source]: false }, blocked: false },
      { name: 'forged registry identity', policy: { 'vigieau-install-script-fixture@1.0.0': true }, blocked: true },
      { name: 'exact local source approval', policy: { [source]: true }, blocked: false, executes: true },
    ];
    for (const scenario of scenarios) {
      rmSync(marker, { force: true });
      savePolicy(scenario.policy);
      const result = run(['ci']);
      if (scenario.blocked) {
        assert.notEqual(result.status, 0, `${scenario.name}: install unexpectedly succeeded`);
        assert.match(result.output, /ESTRICTALLOWSCRIPTS/, result.output);
      } else {
        succeeds(result);
        assert.equal(readJson(join(project, 'node_modules/vigieau-install-script-fixture/package.json')).version, '1.0.0');
      }
      assert.equal(existsSync(marker), scenario.executes === true, `${scenario.name}: unexpected hook execution`);
      if (scenario.executes) assert.equal(readFileSync(marker, 'utf8'), 'executed');
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
