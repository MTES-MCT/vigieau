import { chmod, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertPmtilesFeatureIntegrity,
  buildTippecanoeArguments,
  collectPmtilesFeatureIds,
  generatePmtiles,
} from './pmtiles-generation';

function validPmtilesHeader(maxZoom = 12): Buffer {
  const header = Buffer.alloc(127);
  header.write('PMTiles', 0, 'ascii');
  header[7] = 3;
  header[101] = maxZoom;
  return header;
}

async function createExecutable(
  binDirectory: string,
  name: string,
): Promise<string> {
  await mkdir(binDirectory, { recursive: true });
  const executable = join(binDirectory, name);
  await writeFile(executable, '#!/bin/sh\nexit 0\n');
  await chmod(executable, 0o700);
  return executable;
}

describe('PMTiles generation integrity', () => {
  it('uses retention-first Tippecanoe options', () => {
    const args = buildTippecanoeArguments('zones.geojson', 'zones.pmtiles');

    expect(args).toEqual(
      expect.arrayContaining([
        '--no-tile-size-limit',
        '--no-feature-limit',
        '--no-tiny-polygon-reduction-at-maximum-zoom',
        '--simplification-at-maximum-zoom=1',
      ]),
    );
    expect(args.join(' ')).not.toMatch(/drop|coalesce/);
    expect(args).not.toContain('--read-parallel');
  });

  it('rejects duplicate ids and empty source geometries', () => {
    expect(() =>
      collectPmtilesFeatureIds([
        {
          geometry: { coordinates: [[[1, 2]]] },
          properties: { id: 7 },
        },
        {
          geometry: { coordinates: [[[3, 4]]] },
          properties: { id: 7 },
        },
      ]),
    ).toThrow('duplicate feature ids');
    expect(() =>
      collectPmtilesFeatureIds([
        { geometry: { coordinates: [] }, properties: { id: 9 } },
      ]),
    ).toThrow('empty feature geometries (1): 9');
  });

  it('accepts every expected id at the archive maximum zoom', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vigieau-pmtiles-test-'));
    const pmtilesPath = join(directory, 'zones.pmtiles');
    await writeFile(pmtilesPath, validPmtilesHeader());
    const decodeRunner = jest.fn(
      async (_executable, args: readonly string[], onLine) => {
        expect(args).toContain('-Z12');
        expect(args).toContain('-z12');
        onLine(JSON.stringify({ properties: { id: 10 } }));
        onLine(JSON.stringify({ properties: { id: 10 } }));
        onLine(JSON.stringify({ properties: { id: 20 } }));
      },
    );

    await assertPmtilesFeatureIntegrity({
      decoderPath: '/tippecanoe-decode',
      pmtilesPath,
      expectedFeatureIds: ['10', '20'],
      decodeRunner,
    });

    expect(decodeRunner).toHaveBeenCalledTimes(1);
  });

  it('rejects missing, unexpected, or invalid decoded ids', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vigieau-pmtiles-test-'));
    const pmtilesPath = join(directory, 'zones.pmtiles');
    await writeFile(pmtilesPath, validPmtilesHeader());

    await expect(
      assertPmtilesFeatureIntegrity({
        decoderPath: '/tippecanoe-decode',
        pmtilesPath,
        expectedFeatureIds: ['10', '20'],
        decodeRunner: async (_executable, _args, onLine) => {
          onLine(JSON.stringify({ properties: { id: 10 } }));
          onLine(JSON.stringify({ properties: { id: 30 } }));
        },
      }),
    ).rejects.toThrow('missing=1 [20], unexpected=1 [30]');

    await expect(
      assertPmtilesFeatureIntegrity({
        decoderPath: '/tippecanoe-decode',
        pmtilesPath,
        expectedFeatureIds: ['10'],
        decodeRunner: async (_executable, _args, onLine) => onLine('{broken'),
      }),
    ).rejects.toThrow('invalid JSON');
  });

  it('removes an output that fails validation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vigieau-pmtiles-test-'));
    const outputPath = join(directory, 'zones.pmtiles');
    const binDirectory = join(directory, 'tippecanoe_program/bin');
    await createExecutable(binDirectory, 'tippecanoe');
    await createExecutable(binDirectory, 'tippecanoe-decode');

    await expect(
      generatePmtiles({
        workingDirectory: directory,
        inputPath: join(directory, 'zones.geojson'),
        outputPath,
        expectedFeatureIds: ['10'],
        commandRunner: async () => {
          await writeFile(outputPath, validPmtilesHeader());
        },
        decodeRunner: async () => undefined,
      }),
    ).rejects.toThrow('missing=1 [10]');
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the temporary workspace separate from an explicit slug bin directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vigieau-pmtiles-test-'));
    const workingDirectory = join(directory, 'tmp');
    const tippecanoeBinDirectory = join(
      directory,
      'apps/backend-admin/tippecanoe_program/bin',
    );
    const tippecanoePath = await createExecutable(
      tippecanoeBinDirectory,
      'tippecanoe',
    );
    const decoderPath = await createExecutable(
      tippecanoeBinDirectory,
      'tippecanoe-decode',
    );
    await mkdir(workingDirectory);
    const outputPath = join(workingDirectory, 'zones.pmtiles');
    const commandRunner = jest.fn(async (executable: string) => {
      expect(executable).toBe(tippecanoePath);
      await writeFile(outputPath, validPmtilesHeader());
    });
    const decodeRunner = jest.fn(async (executable, _args, onLine) => {
      expect(executable).toBe(decoderPath);
      onLine(JSON.stringify({ properties: { id: 10 } }));
    });

    await generatePmtiles({
      workingDirectory,
      tippecanoeBinDirectory,
      inputPath: join(workingDirectory, 'zones.geojson'),
      outputPath,
      expectedFeatureIds: ['10'],
      commandRunner,
      decodeRunner,
    });

    expect(commandRunner).toHaveBeenCalledTimes(1);
    expect(decodeRunner).toHaveBeenCalledTimes(1);
  });

  it('fails before generation when a required slug executable is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vigieau-pmtiles-test-'));
    const workingDirectory = join(directory, 'tmp');
    const tippecanoeBinDirectory = join(directory, 'tippecanoe_program/bin');
    await mkdir(workingDirectory);
    await createExecutable(tippecanoeBinDirectory, 'tippecanoe');
    const outputPath = join(workingDirectory, 'zones.pmtiles');
    await writeFile(outputPath, Buffer.from('stale'));
    const commandRunner = jest.fn();

    await expect(
      generatePmtiles({
        workingDirectory,
        tippecanoeBinDirectory,
        inputPath: join(workingDirectory, 'zones.geojson'),
        outputPath,
        expectedFeatureIds: [],
        commandRunner,
      }),
    ).rejects.toThrow(
      `Required Tippecanoe executable is not executable: ${join(
        tippecanoeBinDirectory,
        'tippecanoe-decode',
      )}`,
    );
    expect(commandRunner).not.toHaveBeenCalled();
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects invalid PMTiles headers before decoding', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vigieau-pmtiles-test-'));
    const pmtilesPath = join(directory, 'zones.pmtiles');
    await writeFile(pmtilesPath, Buffer.from('invalid'));

    await expect(
      assertPmtilesFeatureIntegrity({
        decoderPath: '/tippecanoe-decode',
        pmtilesPath,
        expectedFeatureIds: ['10'],
      }),
    ).rejects.toThrow('valid PMTiles v3');
  });
});
