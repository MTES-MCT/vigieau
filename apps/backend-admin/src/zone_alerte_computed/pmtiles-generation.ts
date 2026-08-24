import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, open, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { isExactEmptyMultiPolygonGeometry } from './legacy-historic-empty-geometries';

const PMTILES_HEADER_SIZE = 127;
const PMTILES_MAX_ZOOM_OFFSET = 101;
const PMTILES_LAYER_NAME = 'zones_arretes_en_vigueur';
const ERROR_OUTPUT_LIMIT = 8_000;
export const COMPUTED_HISTORIC_PMTILES_MAX_ZOOM = 12;
const VECTOR_TILE_EXTENT = 4_096;
const WEB_MERCATOR_MAX_LATITUDE = 85.0511287798066;

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
  geometry?: { type?: unknown; coordinates?: unknown };
  properties?: { id?: unknown };
}

export interface LegacyHistoricBackfillPmtilesFeatureIds {
  expectedFeatureIds: string[];
  excludedEmptyGeometryIds: string[];
}

export interface ComputedHistoricPmtilesFeatureIds {
  expectedFeatureIds: string[];
  excludedNonRenderableGeometryIds: string[];
}

export interface GeneratePmtilesOptions {
  workingDirectory: string;
  tippecanoeBinDirectory?: string;
  inputPath: string;
  outputPath: string;
  expectedFeatureIds: readonly string[];
  optionalFeatureIds?: readonly string[];
  maximumZoom?: number;
  commandRunner?: CommandRunner;
  decodeRunner?: DecodeRunner;
}

async function assertExecutable(executable: string): Promise<void> {
  try {
    await access(executable, constants.X_OK);
  } catch {
    throw new Error(
      `Required Tippecanoe executable is not executable: ${executable}`,
    );
  }
}

export async function assertTippecanoeExecutables(
  binDirectory: string,
  executableNames: readonly string[],
): Promise<void> {
  for (const executableName of executableNames) {
    await assertExecutable(join(binDirectory, executableName));
  }
}

export interface AssertPmtilesIntegrityOptions {
  decoderPath: string;
  pmtilesPath: string;
  expectedFeatureIds: readonly string[];
  optionalFeatureIds?: readonly string[];
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

function quantizeWebMercatorPosition(value: unknown): [number, number] | null {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    typeof value[0] !== 'number' ||
    !Number.isFinite(value[0]) ||
    typeof value[1] !== 'number' ||
    !Number.isFinite(value[1])
  ) {
    return null;
  }
  const scale = VECTOR_TILE_EXTENT * 2 ** COMPUTED_HISTORIC_PMTILES_MAX_ZOOM;
  const longitude = value[0];
  const latitude = Math.max(
    -WEB_MERCATOR_MAX_LATITUDE,
    Math.min(WEB_MERCATOR_MAX_LATITUDE, value[1]),
  );
  const sinLatitude = Math.sin((latitude * Math.PI) / 180);
  return [
    Math.round(((longitude + 180) / 360) * scale),
    Math.round(
      (0.5 - Math.log((1 + sinLatitude) / (1 - sinLatitude)) / (4 * Math.PI)) *
        scale,
    ),
  ];
}

function quantizedRingHasArea(value: unknown): boolean | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  let first: [number, number] | null = null;
  let previous: [number, number] | null = null;
  let twiceArea = 0;
  for (const coordinate of value) {
    const position = quantizeWebMercatorPosition(coordinate);
    if (!position) {
      return null;
    }
    first ??= position;
    if (previous) {
      twiceArea += previous[0] * position[1] - position[0] * previous[1];
    }
    previous = position;
  }
  twiceArea += previous![0] * first![1] - first![0] * previous![1];
  if (twiceArea !== 0) {
    return true;
  }

  // Exact arithmetic is only needed for the rare zero-area candidates.
  let exactPrevious: [number, number] | null = null;
  let exactTwiceArea = 0n;
  for (const coordinate of value) {
    const position = quantizeWebMercatorPosition(coordinate)!;
    if (exactPrevious) {
      exactTwiceArea +=
        BigInt(exactPrevious[0]) * BigInt(position[1]) -
        BigInt(position[0]) * BigInt(exactPrevious[1]);
    }
    exactPrevious = position;
  }
  exactTwiceArea +=
    BigInt(exactPrevious![0]) * BigInt(first![1]) -
    BigInt(first![0]) * BigInt(exactPrevious![1]);
  return exactTwiceArea !== 0n;
}

function isNonRenderablePolygonGeometry(
  geometry: PmtilesFeature['geometry'],
): boolean {
  if (!geometry || !Array.isArray(geometry.coordinates)) {
    return false;
  }
  let exteriorRings: unknown[];
  if (geometry.type === 'Polygon') {
    exteriorRings = [geometry.coordinates[0]];
  } else if (geometry.type === 'MultiPolygon') {
    exteriorRings = geometry.coordinates.map((polygon) =>
      Array.isArray(polygon) ? polygon[0] : undefined,
    );
  } else {
    return false;
  }
  if (exteriorRings.length === 0) {
    return false;
  }
  const areas = exteriorRings.map(quantizedRingHasArea);
  return areas.every((hasArea) => hasArea === false);
}

function formatIds(ids: readonly string[]): string {
  return ids.slice(0, 20).join(',');
}

export function collectPmtilesFeatureIds(
  features: readonly PmtilesFeature[],
): string[] {
  return collectPmtilesFeatureIdsWithEmptyAllowlist(features, [])
    .expectedFeatureIds;
}

export function collectLegacyHistoricBackfillPmtilesFeatureIds(
  features: readonly PmtilesFeature[],
  allowedEmptyGeometryIds: readonly number[],
): LegacyHistoricBackfillPmtilesFeatureIds {
  const result = collectPmtilesFeatureIdsWithEmptyAllowlist(
    features,
    allowedEmptyGeometryIds,
  );
  return {
    expectedFeatureIds: result.expectedFeatureIds,
    excludedEmptyGeometryIds: result.excludedEmptyGeometryIds,
  };
}

export function collectComputedHistoricPmtilesFeatureIds(
  features: readonly PmtilesFeature[],
): ComputedHistoricPmtilesFeatureIds {
  const result = collectPmtilesFeatureIdsWithEmptyAllowlist(features, [], true);
  return {
    expectedFeatureIds: result.expectedFeatureIds,
    excludedNonRenderableGeometryIds: result.excludedNonRenderableGeometryIds,
  };
}

function collectPmtilesFeatureIdsWithEmptyAllowlist(
  features: readonly PmtilesFeature[],
  allowedEmptyGeometryIds: readonly number[],
  excludeNonRenderablePolygonGeometries = false,
): LegacyHistoricBackfillPmtilesFeatureIds & {
  excludedNonRenderableGeometryIds: string[];
} {
  const ids: string[] = [];
  const duplicates = new Set<string>();
  const emptyGeometryIds: string[] = [];
  const disallowedEmptyGeometryIds: string[] = [];
  const nonRenderableGeometryIds: string[] = [];
  const seen = new Set<string>();
  const allowedEmptyIds = new Set(
    allowedEmptyGeometryIds.map((id) =>
      normalizeFeatureId(id, 'Allowed empty GeoJSON features'),
    ),
  );

  for (const feature of features) {
    const id = normalizeFeatureId(feature.properties?.id, 'GeoJSON');
    if (seen.has(id)) {
      duplicates.add(id);
    }
    seen.add(id);
    if (!hasCoordinatePair(feature.geometry?.coordinates)) {
      if (
        allowedEmptyIds.has(id) &&
        isExactEmptyMultiPolygonGeometry(feature.geometry)
      ) {
        emptyGeometryIds.push(id);
      } else {
        disallowedEmptyGeometryIds.push(id);
      }
      continue;
    }
    if (
      excludeNonRenderablePolygonGeometries &&
      isNonRenderablePolygonGeometry(feature.geometry)
    ) {
      nonRenderableGeometryIds.push(id);
      continue;
    }
    ids.push(id);
  }

  if (duplicates.size > 0) {
    const values = [...duplicates].sort();
    throw new Error(
      `GeoJSON contains duplicate feature ids (${values.length}): ${formatIds(values)}`,
    );
  }
  if (disallowedEmptyGeometryIds.length > 0) {
    throw new Error(
      `GeoJSON contains empty feature geometries (${disallowedEmptyGeometryIds.length}): ${formatIds(disallowedEmptyGeometryIds)}`,
    );
  }
  return {
    expectedFeatureIds: ids,
    excludedEmptyGeometryIds: emptyGeometryIds,
    excludedNonRenderableGeometryIds: nonRenderableGeometryIds,
  };
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
  maximumZoom?: number,
): string[] {
  if (
    maximumZoom !== undefined &&
    (!Number.isInteger(maximumZoom) || maximumZoom < 0 || maximumZoom > 24)
  ) {
    throw new Error('Tippecanoe maximum zoom must be between 0 and 24');
  }
  return [
    '-Z4',
    maximumZoom === undefined ? '-zg' : `-z${maximumZoom}`,
    '--no-tile-size-limit',
    '--no-feature-limit',
    '--force',
    // The input is one compact FeatureCollection line; Tippecanoe's line
    // splitter makes --read-parallel pathologically expensive for this shape.
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
  optionalFeatureIds = [],
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

  const optional = new Set<string>();
  for (const rawId of optionalFeatureIds) {
    const id = normalizeFeatureId(rawId, 'Optional PMTiles features');
    if (expected.has(id) || optional.has(id)) {
      duplicates.add(id);
    }
    optional.add(id);
  }
  if (duplicates.size > 0) {
    const values = [...duplicates].sort();
    throw new Error(
      `PMTiles feature ids overlap or contain duplicates (${values.length}): ${formatIds(values)}`,
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
  const unexpected = [...actual]
    .filter((id) => !expected.has(id) && !optional.has(id))
    .sort();
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `PMTiles feature integrity check failed: missing=${missing.length} [${formatIds(missing)}], unexpected=${unexpected.length} [${formatIds(unexpected)}]`,
    );
  }
}

export async function generatePmtiles({
  workingDirectory,
  tippecanoeBinDirectory = join(workingDirectory, 'tippecanoe_program/bin'),
  inputPath,
  outputPath,
  expectedFeatureIds,
  optionalFeatureIds,
  maximumZoom,
  commandRunner = runCommand,
  decodeRunner = decodeLines,
}: GeneratePmtilesOptions): Promise<void> {
  const tippecanoePath = join(tippecanoeBinDirectory, 'tippecanoe');
  const decoderPath = join(tippecanoeBinDirectory, 'tippecanoe-decode');
  try {
    await assertTippecanoeExecutables(tippecanoeBinDirectory, [
      'tippecanoe',
      'tippecanoe-decode',
    ]);
    await commandRunner(
      tippecanoePath,
      buildTippecanoeArguments(inputPath, outputPath, maximumZoom),
    );
    await assertPmtilesFeatureIntegrity({
      decoderPath,
      pmtilesPath: outputPath,
      expectedFeatureIds,
      optionalFeatureIds,
      decodeRunner,
    });
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  }
}
