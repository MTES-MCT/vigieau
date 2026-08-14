import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const binDirectory = resolve(process.argv[2] || '');
const tileJoinPath = join(binDirectory, 'tile-join');
const decoderPath = join(binDirectory, 'tippecanoe-decode');
const workingDirectory = await mkdtemp(
  join(tmpdir(), 'vigieau-tippecanoe-check-'),
);
const sourceDirectory = join(workingDirectory, 'empty');
const outputPath = join(workingDirectory, 'empty.pmtiles');

const run = (command, args) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(
          `Tippecanoe tool validation failed (${signal ? `signal ${signal}` : `exit ${code}`})`,
        ),
      );
    });
  });

try {
  await mkdir(sourceDirectory);
  await writeFile(
    join(sourceDirectory, 'metadata.json'),
    JSON.stringify({
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
    }),
  );
  await run(tileJoinPath, [
    '--quiet',
    '--force',
    '--name=Zones et arretes en vigueur',
    '--description=',
    `--output=${outputPath}`,
    sourceDirectory,
  ]);

  const content = await readFile(outputPath);
  if (
    content.length < 127 ||
    content.subarray(0, 7).toString('ascii') !== 'PMTiles' ||
    content.readUInt8(7) !== 3
  ) {
    throw new Error('tile-join produced an invalid PMTiles v3 header');
  }

  const fileSize = BigInt(content.length);
  const sections = [8, 24, 40, 56].map((offset) => [
    content.readBigUInt64LE(offset),
    content.readBigUInt64LE(offset + 8),
  ]);
  if (
    sections.some(
      ([offset, length]) =>
        offset < 127n || offset > fileSize || length > fileSize - offset,
    )
  ) {
    throw new Error('tile-join produced invalid PMTiles section offsets');
  }
  if (
    [64, 72, 80, 88].some(
      (offset) => content.readBigUInt64LE(offset) !== 0n,
    )
  ) {
    throw new Error('tile-join produced tiles for an empty publication');
  }
  await run(decoderPath, ['--stats', outputPath]);
} finally {
  await rm(workingDirectory, { force: true, recursive: true });
}
