import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { configureClamd } from './configure-clamav.mjs';

const execute = promisify(execFile);
const defaultAppRoot = fileURLToPath(new URL('..', import.meta.url));

function ping(socketPath) {
  return new Promise((resolvePing) => {
    const socket = createConnection(socketPath);
    let response = '';
    const finish = (ready) => {
      socket.destroy();
      resolvePing(ready);
    };
    socket.setTimeout(1000, () => finish(false));
    socket.on('error', () => finish(false));
    socket.on('connect', () => socket.write('zPING\0'));
    socket.on('data', (data) => {
      response += data.toString();
      if (response.includes('\0') || response.includes('\n'))
        finish(response.trim().replace(/\0/g, '') === 'PONG');
    });
    socket.on('end', () =>
      finish(response.trim().replace(/\0/g, '') === 'PONG'),
    );
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolveClose) =>
    child.once('close', resolveClose),
  );
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 10000);
  force.unref();
  await closed;
  clearTimeout(force);
}

function waitForExit(child) {
  return new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', (code) => resolveExit(code ?? 1));
  });
}

function assertOneOff(env) {
  if (env.CONTAINER && !env.CONTAINER.startsWith('one-off-')) {
    throw new Error(
      'Run the historical scan in a dedicated one-off container, never in a web or worker container',
    );
  }
  if (env.CONTAINER && env.CLAMAV_START === '0') {
    throw new Error(
      'Exclude one-off in CLAMAV_DISABLE_PROCESS_TYPES: the launcher starts its own ClamAV process',
    );
  }
}

export async function runDocumentScan({
  appRoot = defaultAppRoot,
  args = [],
  env = process.env,
  signal,
} = {}) {
  assertOneOff(env);
  const entrypoint = join(
    appRoot,
    'dist/apps/backend-admin/src/scripts/scan-documents.js',
  );
  // Inventory has no AV work. Do not download signatures or reserve a second
  // engine just to list documents; the CLI validates conflicting/unknown flags.
  if (!args.includes('--execute') || args.includes('--dry-run')) {
    const inventory = spawn(process.execPath, [entrypoint, ...args], {
      cwd: appRoot,
      env,
      stdio: 'inherit',
      signal,
    });
    try {
      return await waitForExit(inventory);
    } finally {
      await stop(inventory);
    }
  }
  return withClamav(
    { appRoot, env, signal, batch: true },
    async ({ env: childEnv }) => {
      const scanner = spawn(process.execPath, [entrypoint, ...args], {
        cwd: appRoot,
        env: childEnv,
        stdio: 'inherit',
        signal,
      });
      try {
        return await waitForExit(scanner);
      } finally {
        await stop(scanner);
      }
    },
  );
}

/** A finite, isolated engine for operator jobs. Never starts a business process. */
export async function withClamav(
  { appRoot = defaultAppRoot, env = process.env, signal, batch = false } = {},
  use,
) {
  assertOneOff(env);
  const clamRoot = join(appRoot, 'clamav');
  const workdir = await mkdtemp(join(tmpdir(), 'vigieau-av-'));
  const socketPath = join(workdir, 'clamd.sock');
  const configPath = join(workdir, 'clamd.conf');
  let daemon;
  let daemonError;
  try {
    const source = await readFile(join(clamRoot, 'conf/clamd.conf'), 'utf8');
    await writeFile(
      configPath,
      configureClamd(source, { batch, socket: socketPath }),
      { mode: 0o600 },
    );
    // Refresh before starting clamd. The buildpack's delayed refresh is deliberately
    // bypassed for this finite batch; NotifyClamd would target the absent web socket.
    const freshclamConfig = (
      await readFile(join(clamRoot, 'conf/freshclam.conf'), 'utf8')
    )
      .split('\n')
      .filter((line) => !/^\s*NotifyClamd\s+/.test(line))
      .join('\n');
    const freshclamPath = join(workdir, 'freshclam.conf');
    await writeFile(freshclamPath, freshclamConfig, { mode: 0o600 });
    const childEnv = {
      ...env,
      ANTIVIRUS_ENABLED: 'true',
      CLAMD_CONFIG_FILE: configPath,
      CLAMDSCAN_PATH: join(clamRoot, 'bin/clamdscan'),
      ANTIVIRUS_TIMEOUT_MS: batch ? '75000' : '15000',
      RUN_BUSINESS_SCHEDULED_JOBS: 'false',
      DISABLE_SCHEDULED_JOBS: 'true',
    };
    console.log('Updating antivirus signatures before the operator job.');
    await execute(
      join(clamRoot, 'bin/freshclam'),
      [`--config-file=${freshclamPath}`, '--stdout'],
      {
        env: childEnv,
        timeout: 180000,
        maxBuffer: 1024 * 1024,
        signal,
      },
    );
    signal?.throwIfAborted();
    daemon = spawn(
      join(clamRoot, 'sbin/clamd'),
      [`--config-file=${configPath}`, '--foreground'],
      {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    daemon.stdout.pipe(process.stdout, { end: false });
    daemon.stderr.pipe(process.stderr, { end: false });
    daemon.on('error', (error) => {
      daemonError = error;
    });
    const deadline = Date.now() + 120000;
    while (!(await ping(socketPath))) {
      signal?.throwIfAborted();
      if (daemonError) throw daemonError;
      if (daemon.exitCode !== null || daemon.signalCode !== null)
        throw new Error('ClamAV stopped before becoming ready');
      if (Date.now() >= deadline)
        throw new Error('ClamAV did not become ready within 120 seconds');
      await delay(250, undefined, { signal });
    }
    signal?.throwIfAborted();
    return await use({
      appRoot,
      env: childEnv,
      workdir,
      configPath,
      socketPath,
      daemon,
    });
  } finally {
    await stop(daemon);
    await rm(workdir, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  try {
    process.exitCode = await runDocumentScan({
      args: process.argv.slice(2),
      signal: controller.signal,
    });
  } catch (error) {
    console.error(`Historical antivirus scan stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
