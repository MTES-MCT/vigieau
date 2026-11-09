import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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

export const CLAMAV_BUILDPACK =
  'https://github.com/Scalingo/clamav-buildpack.git#661a265ae1898e44f140c5765788cae26533bc74';

export function configureClamavProfile(source) {
  // scalingo-26 does not provide rev. Keep the official process selection,
  // replacing only its dependency on rev/cut with a Bash builtin expansion.
  const original = `current_process_type="$( echo "\${CONTAINER}" | rev | cut -d'-' -f2- | rev )"`;
  const replacement = 'current_process_type="${CONTAINER%-*}"';
  if (source.split(original).length === 2)
    return source.replace(original, replacement);
  if (source.split(replacement).length === 2 && !source.includes(original))
    return source;
  throw new Error(
    'Unexpected ClamAV buildpack process profile: review the pinned buildpack before deploying',
  );
}

export async function configureClamavBuild(appRoot) {
  const buildpacks = await readFile(join(appRoot, '.buildpacks'), 'utf8');
  const clamavBuildpacks = buildpacks
    .split(/\r?\n/)
    .filter((line) => line.includes('/clamav-buildpack'));
  if (
    clamavBuildpacks.length !== 1 ||
    clamavBuildpacks[0] !== CLAMAV_BUILDPACK
  ) {
    throw new Error('Unexpected ClamAV buildpack pin');
  }
  const configPath = join(appRoot, 'clamav/conf/clamd.conf');
  const profilePath = join(appRoot, '.profile.d/010-clamav.sh');
  const config = configureClamd(await readFile(configPath, 'utf8'));
  const profile = configureClamavProfile(await readFile(profilePath, 'utf8'));
  await writeFile(configPath, config);
  await writeFile(profilePath, profile);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // Resolve against this script, not /app: the build directory has a temporary name.
  await configureClamavBuild(fileURLToPath(new URL('..', import.meta.url)));
  console.log(
    'ClamAV: local socket, bounded scans and encrypted/partial-file alerts configured.',
  );
}
