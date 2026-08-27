import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEmptyPmtiles } from './empty-pmtiles';

function validEmptyPmtilesHeader(): Buffer {
  const header = Buffer.alloc(127);
  header.write('PMTiles', 0, 'ascii');
  header[7] = 3;
  return header;
}

async function createTileJoinExecutable(binDirectory: string): Promise<string> {
  await mkdir(binDirectory, { recursive: true });
  const executable = join(binDirectory, 'tile-join');
  await writeFile(executable, '#!/bin/sh\nexit 0\n');
  await chmod(executable, 0o700);
  return executable;
}

describe('generateEmptyPmtiles', () => {
  it('uses tile-join with a source that contains no tiles', async () => {
    const workingDirectory = await mkdtemp(
      join(tmpdir(), 'vigieau-empty-pmtiles-test-'),
    );
    const outputPath = join(workingDirectory, 'zones.pmtiles');
    await createTileJoinExecutable(
      join(workingDirectory, 'tippecanoe_program/bin'),
    );
    let sourceDirectory: string | undefined;

    await generateEmptyPmtiles({
      workingDirectory,
      outputPath,
      commandRunner: async (executable, args) => {
        expect(executable).toBe(
          join(workingDirectory, 'tippecanoe_program/bin/tile-join'),
        );
        expect(args).toContain(`--output=${outputPath}`);
        sourceDirectory = args.at(-1);

        const metadata = JSON.parse(
          await readFile(join(sourceDirectory, 'metadata.json'), 'utf8'),
        );
        expect(JSON.parse(metadata.json)).toEqual({
          vector_layers: [],
          tilestats: { layerCount: 0, layers: [] },
        });
        expect(await stat(sourceDirectory)).toBeDefined();
        await writeFile(outputPath, validEmptyPmtilesHeader());
      },
    });

    expect((await readFile(outputPath)).subarray(0, 8)).toEqual(
      Buffer.from('PMTiles\x03'),
    );
    await expect(stat(sourceDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('removes the temporary source and an invalid output', async () => {
    const workingDirectory = await mkdtemp(
      join(tmpdir(), 'vigieau-empty-pmtiles-test-'),
    );
    const outputPath = join(workingDirectory, 'zones.pmtiles');
    await createTileJoinExecutable(
      join(workingDirectory, 'tippecanoe_program/bin'),
    );
    let sourceDirectory: string | undefined;

    await expect(
      generateEmptyPmtiles({
        workingDirectory,
        outputPath,
        commandRunner: async (_executable, args) => {
          sourceDirectory = args.at(-1);
          await writeFile(outputPath, Buffer.from('not-pmtiles'));
        },
      }),
    ).rejects.toThrow('valid PMTiles v3');

    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(sourceDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects an archive that contains tiles', async () => {
    const workingDirectory = await mkdtemp(
      join(tmpdir(), 'vigieau-empty-pmtiles-test-'),
    );
    const outputPath = join(workingDirectory, 'zones.pmtiles');
    await createTileJoinExecutable(
      join(workingDirectory, 'tippecanoe_program/bin'),
    );

    await expect(
      generateEmptyPmtiles({
        workingDirectory,
        outputPath,
        commandRunner: async () => {
          const header = validEmptyPmtilesHeader();
          header.writeBigUInt64LE(1n, 72);
          await writeFile(outputPath, header);
        },
      }),
    ).rejects.toThrow('non-empty PMTiles archive');
  });

  it('uses an explicit slug bin directory outside the temporary workspace', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'vigieau-empty-pmtiles-test-'),
    );
    const workingDirectory = join(directory, 'tmp');
    const tippecanoeBinDirectory = join(
      directory,
      'apps/backend-admin/tippecanoe_program/bin',
    );
    await mkdir(workingDirectory);
    const tileJoinPath = await createTileJoinExecutable(tippecanoeBinDirectory);
    const outputPath = join(workingDirectory, 'zones.pmtiles');
    const commandRunner = jest.fn(async (executable: string) => {
      expect(executable).toBe(tileJoinPath);
      await writeFile(outputPath, validEmptyPmtilesHeader());
    });

    await generateEmptyPmtiles({
      workingDirectory,
      tippecanoeBinDirectory,
      outputPath,
      commandRunner,
    });

    expect(commandRunner).toHaveBeenCalledTimes(1);
  });

  it('fails before creating temporary input when tile-join is unavailable', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'vigieau-empty-pmtiles-test-'),
    );
    const workingDirectory = join(directory, 'tmp');
    const tippecanoeBinDirectory = join(directory, 'missing-bin');
    await mkdir(workingDirectory);
    const outputPath = join(workingDirectory, 'zones.pmtiles');
    await writeFile(outputPath, Buffer.from('stale'));
    const commandRunner = jest.fn();

    await expect(
      generateEmptyPmtiles({
        workingDirectory,
        tippecanoeBinDirectory,
        outputPath,
        commandRunner,
      }),
    ).rejects.toThrow(
      `Required Tippecanoe executable is not executable: ${join(
        tippecanoeBinDirectory,
        'tile-join',
      )}`,
    );
    expect(commandRunner).not.toHaveBeenCalled();
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
