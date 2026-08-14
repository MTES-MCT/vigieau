import { spawn } from 'node:child_process';
import { open, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const PMTILES_HEADER_SIZE = 127;
const PMTILES_MAX_ZOOM_OFFSET = 101;
const PMTILES_LAYER_NAME = 'zones_arretes_en_vigueur';
const ERROR_OUTPUT_LIMIT = 8_000;

type CommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<void>;

type DecodeRunner = (
  executable: string,
  args: readonly string[],
  onLine: (line: string) => void,
) => Promise<void>;

interface PmtilesFeature {
  geometry?: { coordinates?: unknown };
  properties?: { id?: unknown };
}

export interface GeneratePmtilesOptions {
  workingDirectory: string;
  inputPath: string;
  outputPath: string;
  expectedFeatureIds: readonly string[];
  commandRunner?: CommandRunner;
  decodeRunner?: DecodeRunner;
}

export interface AssertPmtilesIntegrityOptions {
  decoderPath: string;
  pmtilesPath: string;
  expectedFeatureIds: readonly string[];
  decodeRunner?: DecodeRunner;
}

function appendErrorOutput(current: string, chunk: Buffer | string): string {
  return `${current}${String(chunk)}`.slice(-ERROR_OUTPUT_LIMIT);
}

function commandFailure(
  executable: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): Error {
  const status = signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`;
  const details = stderr.trim();
  return new Error(
    `${executable} failed (${status})${details ? `: ${details}` : ''}`,
  );
}

function runCommand(
  executable: string,
  args: readonly string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    child.stderr?.on('data', (chunk) => {
      stderr = appendErrorOutput(stderr, chunk);
    });
    child.once('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once('exit', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      if (code === 0) {
        resolve();
        return;
      }
      reject(commandFailure(executable, code, signal, stderr));
    });
  });
}

async function decodeLines(
  executable: string,
  args: readonly string[],
  onLine: (line: string) => void,
): Promise<void> {
  const child = spawn(executable, [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!child.stdout) {
    child.kill();
    throw new Error(`${executable} did not expose its output`);
  }

  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr = appendErrorOutput(stderr, chunk);
  });
  const completion = new Promise<void>((resolve, reject) => {
    let settled = false;
    child.once('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once('exit', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      if (code === 0) {
        resolve();
        return;
      }
      reject(commandFailure(executable, code, signal, stderr));
    });
  });

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim()) {
        onLine(line);
      }
    }
    await completion;
  } catch (error) {
    child.kill();
    await completion.catch(() => undefined);
    throw error;
  } finally {
    lines.close();
  }
}

function normalizeFeatureId(value: unknown, source: string): string {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return value;
  }
  throw new Error(`${source} contains an invalid feature id`);
}

function hasCoordinatePair(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  if (
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    Number.isFinite(value[0]) &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[1])
  ) {
    return true;
  }
  return value.some(hasCoordinatePair);
}

function formatIds(ids: readonly string[]): string {
  return ids.slice(0, 20).join(',');
}

export function collectPmtilesFeatureIds(
  features: readonly PmtilesFeature[],
): string[] {
  const ids: string[] = [];
  const duplicates = new Set<string>();
  const emptyGeometryIds: string[] = [];
  const seen = new Set<string>();

  for (const feature of features) {
    const id = normalizeFeatureId(feature.properties?.id, 'GeoJSON');
    if (seen.has(id)) {
      duplicates.add(id);
    }
    seen.add(id);
    ids.push(id);
    if (!hasCoordinatePair(feature.geometry?.coordinates)) {
      emptyGeometryIds.push(id);
    }
  }

  if (duplicates.size > 0) {
    const values = [...duplicates].sort();
    throw new Error(
      `GeoJSON contains duplicate feature ids (${values.length}): ${formatIds(values)}`,
    );
  }
  if (emptyGeometryIds.length > 0) {
    throw new Error(
      `GeoJSON contains empty feature geometries (${emptyGeometryIds.length}): ${formatIds(emptyGeometryIds)}`,
    );
  }
  return ids;
}

async function readPmtilesMaxZoom(pmtilesPath: string): Promise<number> {
  const handle = await open(pmtilesPath, 'r');
  try {
    const header = Buffer.alloc(PMTILES_HEADER_SIZE);
    const { bytesRead } = await handle.read(header, 0, PMTILES_HEADER_SIZE, 0);
    if (
      bytesRead < PMTILES_HEADER_SIZE ||
      header.subarray(0, 7).toString('ascii') !== 'PMTiles' ||
      header[7] !== 3
    ) {
      throw new Error('Tippecanoe did not produce a valid PMTiles v3 archive');
    }
    return header[PMTILES_MAX_ZOOM_OFFSET];
  } finally {
    await handle.close();
  }
}

export function buildTippecanoeArguments(
  inputPath: string,
  outputPath: string,
): string[] {
  return [
    '-Z4',
    '-zg',
    '--no-tile-size-limit',
    '--no-feature-limit',
    '--force',
    '--read-parallel',
    '--detect-shared-borders',
    '--no-tiny-polygon-reduction-at-maximum-zoom',
    '--simplification=28',
    '--simplification-at-maximum-zoom=1',
    `--layer=${PMTILES_LAYER_NAME}`,
    `--output=${outputPath}`,
    inputPath,
  ];
}

export async function assertPmtilesFeatureIntegrity({
  decoderPath,
  pmtilesPath,
  expectedFeatureIds,
  decodeRunner = decodeLines,
}: AssertPmtilesIntegrityOptions): Promise<void> {
  const expected = new Set<string>();
  const duplicates = new Set<string>();
  for (const rawId of expectedFeatureIds) {
    const id = normalizeFeatureId(rawId, 'Expected PMTiles features');
    if (expected.has(id)) {
      duplicates.add(id);
    }
    expected.add(id);
  }
  if (duplicates.size > 0) {
    const values = [...duplicates].sort();
    throw new Error(
      `Expected PMTiles feature ids contain duplicates (${values.length}): ${formatIds(values)}`,
    );
  }

  const maxZoom = await readPmtilesMaxZoom(pmtilesPath);
  const actual = new Set<string>();
  await decodeRunner(
    decoderPath,
    [
      '-c',
      '-I',
      '-l',
      PMTILES_LAYER_NAME,
      '-y',
      'id',
      `-Z${maxZoom}`,
      `-z${maxZoom}`,
      pmtilesPath,
    ],
    (line) => {
      let feature: { properties?: { id?: unknown } };
      try {
        feature = JSON.parse(line);
      } catch {
        throw new Error('tippecanoe-decode returned invalid JSON');
      }
      actual.add(normalizeFeatureId(feature.properties?.id, 'Decoded PMTiles'));
    },
  );

  const missing = [...expected].filter((id) => !actual.has(id)).sort();
  const unexpected = [...actual].filter((id) => !expected.has(id)).sort();
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `PMTiles feature integrity check failed: missing=${missing.length} [${formatIds(missing)}], unexpected=${unexpected.length} [${formatIds(unexpected)}]`,
    );
  }
}

export async function generatePmtiles({
  workingDirectory,
  inputPath,
  outputPath,
  expectedFeatureIds,
  commandRunner = runCommand,
  decodeRunner = decodeLines,
}: GeneratePmtilesOptions): Promise<void> {
  try {
    await commandRunner(
      join(workingDirectory, 'tippecanoe_program/bin/tippecanoe'),
      buildTippecanoeArguments(inputPath, outputPath),
    );
    await assertPmtilesFeatureIntegrity({
      decoderPath: join(
        workingDirectory,
        'tippecanoe_program/bin/tippecanoe-decode',
      ),
      pmtilesPath: outputPath,
      expectedFeatureIds,
      decodeRunner,
    });
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  }
}
