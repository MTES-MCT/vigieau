import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The buildpack creates this file before the Node postbuild hook runs. */
export function configureClamd(source, { batch = false, socket } = {}) {
  for (const directive of ['DatabaseDirectory', 'LocalSocket']) {
    if (!new RegExp(`^\\s*${directive}\\s+\\S+`, 'm').test(source)) {
      throw new Error(`ClamAV buildpack configuration is missing ${directive}`);
    }
  }
  if (/^\s*TCPSocket\s+/m.test(source)) {
    throw new Error(
      'ClamAV must use its local Unix socket, without a TCP listener',
    );
  }

  const values = {
    StreamMaxLength: '32M',
    MaxFileSize: '32M',
    MaxScanSize: '128M',
    AlertExceedsMax: 'yes',
    AlertEncrypted: 'yes',
    MaxThreads: '1',
    MaxQueue: '2',
    MaxScanTime: batch ? '60000' : '10000',
    ConcurrentDatabaseReload: 'yes',
    ...(socket ? { LocalSocket: socket } : {}),
  };
  const retained = source
    .split('\n')
    .filter((line) => !Object.hasOwn(values, line.trim().split(/\s+/, 1)[0]))
    .join('\n')
    .trimEnd();
  return `${retained}\n${Object.entries(values)
    .map(([key, value]) => `${key} ${value}`)
    .join('\n')}\n`;
}

export async function configureClamavFile(configPath) {
  const source = await readFile(configPath, 'utf8');
  await writeFile(configPath, configureClamd(source));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // Resolve against this script, not /app: the build directory has a temporary name.
  const configPath = fileURLToPath(
    new URL('../clamav/conf/clamd.conf', import.meta.url),
  );
  await configureClamavFile(configPath);
  console.log(
    'ClamAV: local socket, bounded scans and encrypted/partial-file alerts configured.',
  );
}
