import { readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { withClamav } from './run-document-scan.mjs';

const eicar = Buffer.from(
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
);
const clean = Buffer.from(
  '%PDF-1.4\n% VigiEau harmless antivirus verification document\n%%EOF\n',
);
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});
const crcByte = (crc, byte) =>
  ((crc >>> 8) ^ crcTable[(crc ^ byte) & 255]) >>> 0;

/** Tiny self-generated ZIP fixtures; no user document or external fixture fetch. */
export function zipFixture(content, encrypted = false) {
  const filename = Buffer.from('antivirus-test.txt');
  const crc = (content.reduce(crcByte, 0xffffffff) ^ 0xffffffff) >>> 0;
  let data = deflateRawSync(content);
  if (encrypted) {
    const keys = [0x12345678, 0x23456789, 0x34567890];
    const update = (byte) => {
      keys[0] = crcByte(keys[0], byte);
      keys[1] =
        (Math.imul((keys[1] + (keys[0] & 255)) >>> 0, 134775813) + 1) >>> 0;
      keys[2] = crcByte(keys[2], keys[1] >>> 24);
    };
    for (const byte of Buffer.from('vigieau-antivirus-fixture')) update(byte);
    const header = Buffer.alloc(12);
    header[11] = crc >>> 24;
    data = Buffer.concat([header, data]);
    for (let index = 0; index < data.length; index++) {
      const byte = data[index];
      const key = (keys[2] | 2) & 0xffff;
      data[index] = byte ^ ((Math.imul(key, key ^ 1) >>> 8) & 255);
      update(byte);
    }
  }
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(encrypted ? 1 : 0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  local.copy(central, 6, 4, 30);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + data.length, 16);
  return Buffer.concat([local, filename, data, central, filename, end]);
}

async function memorySample() {
  for (const [usage, limit] of [
    ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.max'],
    [
      '/sys/fs/cgroup/memory/memory.usage_in_bytes',
      '/sys/fs/cgroup/memory/memory.limit_in_bytes',
    ],
  ]) {
    try {
      const bytes = Number((await readFile(usage, 'utf8')).trim());
      const capacity = Number((await readFile(limit, 'utf8')).trim());
      if (Number.isFinite(bytes))
        return {
          bytes,
          capacity:
            Number.isFinite(capacity) && capacity < 2 ** 52 ? capacity : null,
        };
    } catch {
      /* Try the other cgroup version. */
    }
  }
  return null;
}

function sampleMemory() {
  const report = {
    samples: 0,
    peakBytes: 0,
    reloadPeakBytes: 0,
    capacityBytes: null,
  };
  let inReload = false;
  let pending = Promise.resolve();
  const tick = () => {
    pending = pending.then(async () => {
      const sample = await memorySample();
      if (!sample) return;
      report.samples++;
      report.capacityBytes = sample.capacity;
      report.peakBytes = Math.max(report.peakBytes, sample.bytes);
      if (inReload)
        report.reloadPeakBytes = Math.max(report.reloadPeakBytes, sample.bytes);
    });
  };
  tick();
  const timer = setInterval(tick, 100);
  timer.unref();
  return {
    startReload: () => {
      inReload = true;
      tick();
    },
    stopReload: () => {
      tick();
      inReload = false;
    },
    finish: async () => {
      clearInterval(timer);
      await pending;
      return report;
    },
  };
}

function command(socketPath, name) {
  return new Promise((resolveCommand, reject) => {
    const socket = createConnection(socketPath);
    let output = '';
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error(`ClamAV ${name} timed out`));
    });
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`z${name}\0`));
    socket.on('data', (chunk) => {
      output += chunk.toString();
      if (/[\0\n]/.test(output)) {
        socket.destroy();
        resolveCommand(output.trim().replace(/\0/g, ''));
      }
    });
    socket.on('end', () => resolveCommand(output.trim().replace(/\0/g, '')));
  });
}

async function forceReload(daemon, socketPath, signal) {
  signal?.throwIfAborted();
  let logs = '';
  let removeListeners;
  const completion = new Promise((resolveReload, reject) => {
    const read = (chunk) => {
      logs = (logs + chunk.toString()).slice(-16384);
      if (/Database correctly reloaded|Database reload completed/.test(logs))
        resolveReload();
      if (
        /reload_th:.*failed|Database reload failed|Database reload setup failed/i.test(
          logs,
        )
      )
        reject(new Error('ClamAV signature reload failed'));
    };
    const timeout = setTimeout(
      () =>
        reject(new Error('No successful signature reload within 120 seconds')),
      120000,
    );
    const aborted = () => reject(new Error('Verification interrupted'));
    const exited = () =>
      reject(new Error('ClamAV stopped during signature reload'));
    daemon.stdout.on('data', read);
    daemon.stderr.on('data', read);
    daemon.once('close', exited);
    signal?.addEventListener('abort', aborted, { once: true });
    removeListeners = () => {
      clearTimeout(timeout);
      daemon.stdout.off('data', read);
      daemon.stderr.off('data', read);
      daemon.off('close', exited);
      signal?.removeEventListener('abort', aborted);
    };
  });
  completion.catch(() => undefined);
  try {
    if (!/RELOADING/.test(await command(socketPath, 'RELOAD')))
      throw new Error('ClamAV did not accept RELOAD');
    await completion;
    await delay(1000, undefined, { signal });
  } finally {
    removeListeners();
  }
}

export async function verifyAntivirus({ signal } = {}) {
  const report = {
    kind: 'antivirus-verification',
    startedAt: new Date().toISOString(),
    cases: [],
    reload: { completed: false },
    passed: false,
  };
  const memory = sampleMemory();
  try {
    await withClamav(
      { signal },
      async ({ appRoot, env, configPath, socketPath, workdir, daemon }) => {
        const { scanDocumentStream, getScannerHealth } = await import(
          pathToFileURL(
            join(
              appRoot,
              'dist/apps/backend-admin/src/antivirus/antivirus.core.js',
            ),
          ).href
        );
        const options = {
          executable: env.CLAMDSCAN_PATH,
          configFile: configPath,
          timeoutMs: 15000,
          maxBytes: 10_000_000,
          signal,
        };
        report.health = await getScannerHealth(options);
        if (report.health.status !== 'ready')
          throw new Error(`Scanner health: ${report.health.reason}`);
        const check = async (
          name,
          input,
          expected,
          overrides = {},
          expectedReason,
        ) => {
          signal?.throwIfAborted();
          const start = Date.now();
          const result = await scanDocumentStream(input, {
            ...options,
            ...overrides,
          });
          report.cases.push({
            name,
            expected,
            expectedReason,
            result,
            elapsedMs: Date.now() - start,
            passed:
              result.status === expected &&
              (!expectedReason || result.reason === expectedReason),
          });
        };
        await check('clean', Readable.from([clean]), 'clean');
        await check('eicar', Readable.from([eicar]), 'infected');
        await check(
          'eicar_zip',
          Readable.from([zipFixture(eicar)]),
          'infected',
        );
        await check(
          'encrypted_zip',
          Readable.from([zipFixture(clean, true)]),
          'unscannable',
          {},
          'encrypted',
        );
        await check(
          'client_size_limit',
          Readable.from([Buffer.alloc(1025, 65)]),
          'unscannable',
          { maxBytes: 1024 },
          'size_limit',
        );
        await check(
          'timeout',
          new Readable({ read() {} }),
          'error',
          { timeoutMs: 300 },
          'timeout',
        );
        const unavailableConfig = join(workdir, 'unavailable.conf');
        await writeFile(
          unavailableConfig,
          (await readFile(configPath, 'utf8')).replace(
            /^LocalSocket .+$/m,
            `LocalSocket ${join(workdir, 'absent.sock')}`,
          ),
        );
        await check(
          'unavailable',
          Readable.from([clean]),
          'error',
          { configFile: unavailableConfig, timeoutMs: 1000 },
          'scanner_unavailable',
        );
        memory.startReload();
        const reloadStart = Date.now();
        await forceReload(daemon, socketPath, signal);
        report.reload = {
          completed: true,
          elapsedMs: Date.now() - reloadStart,
        };
        memory.stopReload();
        await check('clean_after_reload', Readable.from([clean]), 'clean');
        report.passed = report.cases.every((test) => test.passed);
      },
    );
  } catch (error) {
    report.error = error.message;
  } finally {
    report.memory = await memory.finish();
    report.memory.includesApplicationWebProcess = false;
    report.memory.reloadPeakRatio = report.memory.capacityBytes
      ? report.memory.reloadPeakBytes / report.memory.capacityBytes
      : null;
    report.memory.belowEightyPercent =
      report.memory.reloadPeakRatio === null
        ? null
        : report.memory.reloadPeakRatio < 0.8;
    report.completedAt = new Date().toISOString();
  }
  return report;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  const report = await verifyAntivirus({ signal: controller.signal });
  console.log(JSON.stringify(report));
  process.exitCode =
    report.passed &&
    report.reload.completed &&
    report.memory.belowEightyPercent === true
      ? 0
      : 1;
}
