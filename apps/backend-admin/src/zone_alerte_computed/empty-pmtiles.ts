import { execFile } from 'node:child_process';
import { readFile, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PMTILES_HEADER_SIZE = 127;
const PMTILES_TILE_DATA_BYTES_OFFSET = 64;
const PMTILES_ADDRESSED_TILES_OFFSET = 72;
const PMTILES_TILE_ENTRIES_OFFSET = 80;
const PMTILES_TILE_CONTENTS_OFFSET = 88;

type CommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<void>;

export interface EmptyPmtilesOptions {
  workingDirectory: string;
  outputPath: string;
  commandRunner?: CommandRunner;
}

const EMPTY_TILESET_METADATA = {
  name: 'Zones et arretes en vigueur',
  description: '',
  version: '2',
  minzoom: '0',
  maxzoom: '0',
  center: '0,0,0',
  bounds: '0,0,0,0',
  antimeridian_adjusted_bounds: '0,0,0,0',
  type: 'overlay',
  format: 'pbf',
  generator: 'VigiEau',
  generator_options: 'empty national publication',
  json: JSON.stringify({
    vector_layers: [],
    tilestats: { layerCount: 0, layers: [] },
  }),
};

function runCommand(
  executable: string,
  args: readonly string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(executable, [...args], (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function assertEmptyPmtiles(outputPath: string): Promise<void> {
  const content = await readFile(outputPath);
  if (
    content.length < PMTILES_HEADER_SIZE ||
    content.subarray(0, 7).toString('ascii') !== 'PMTiles' ||
    content[7] !== 3
  ) {
    throw new Error('tile-join did not produce a valid PMTiles v3 archive');
  }

  const counters = [
    PMTILES_TILE_DATA_BYTES_OFFSET,
    PMTILES_ADDRESSED_TILES_OFFSET,
    PMTILES_TILE_ENTRIES_OFFSET,
    PMTILES_TILE_CONTENTS_OFFSET,
  ];
  if (counters.some((offset) => content.readBigUInt64LE(offset) !== 0n)) {
    throw new Error('tile-join produced a non-empty PMTiles archive');
  }
}

/**
 * tile-join supports an empty directory tileset even though tippecanoe rejects
 * an empty GeoJSON input. The resulting archive has no tiles or geometries.
 */
export async function generateEmptyPmtiles({
  workingDirectory,
  outputPath,
  commandRunner = runCommand,
}: EmptyPmtilesOptions): Promise<void> {
  const sourceDirectory = await mkdtemp(
    join(workingDirectory, '.vigieau-empty-pmtiles-'),
  );

  try {
    await writeFile(
      join(sourceDirectory, 'metadata.json'),
      JSON.stringify(EMPTY_TILESET_METADATA),
    );
    await rm(outputPath, { force: true });
    await commandRunner(
      join(workingDirectory, 'tippecanoe_program/bin/tile-join'),
      [
        '--quiet',
        '--force',
        '--name=Zones et arretes en vigueur',
        '--description=',
        `--output=${outputPath}`,
        sourceDirectory,
      ],
    );
    await assertEmptyPmtiles(outputPath);
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  } finally {
    await rm(sourceDirectory, { force: true, recursive: true });
  }
}
