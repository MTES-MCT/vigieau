import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEmptyPmtiles } from './empty-pmtiles';

function validEmptyPmtilesHeader(): Buffer {
  const header = Buffer.alloc(127);
  header.write('PMTiles', 0, 'ascii');
  header[7] = 3;
  return header;
}

describe('generateEmptyPmtiles', () => {
  it('uses tile-join with a source that contains no tiles', async () => {
    const workingDirectory = await mkdtemp(
      join(tmpdir(), 'vigieau-empty-pmtiles-test-'),
    );
    const outputPath = join(workingDirectory, 'zones.pmtiles');
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
});
