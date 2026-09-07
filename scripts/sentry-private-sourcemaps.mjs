import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function filesIn(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected public symlink: ${entry.name}`);
    if (entry.isDirectory()) files.push(...await filesIn(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export async function collectPrivateSourcemaps(appDirectory) {
  const publicDirectory = resolve(appDirectory, '.output/public');
  const archiveDirectory = resolve(appDirectory, '.sentry-sourcemaps');
  const publicFiles = await filesIn(publicDirectory);
  const maps = publicFiles.filter(path => path.endsWith('.map'));
  if (!maps.length) throw new Error('No client sourcemaps generated; refusing an untraceable release');
  await rm(archiveDirectory, { recursive: true, force: true });
  await mkdir(archiveDirectory, { recursive: true });
  const artifacts = [];
  for (const map of maps) {
    const name = relative(publicDirectory, map);
    const destination = join(archiveDirectory, name);
    const source = map.slice(0, -4);
    const contents = await readFile(source);
    // Keep the exact deployed JS alongside its hidden map for Sentry release matching.
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination.slice(0, -4));
    await rename(map, destination);
    artifacts.push({ file: name.slice(0, -4), sha256: createHash('sha256').update(contents).digest('hex') });
  }
  // Static hosts can serve precompressed files even after the original map is removed.
  for (const path of publicFiles.filter(path => /\.map\.(?:gz|br)$/.test(path))) {
    await rm(path);
  }
  if ((await filesIn(publicDirectory)).some(path => /\.map(?:\.(?:gz|br))?$/.test(path))) {
    throw new Error('Public sourcemaps remain after extraction');
  }
  await writeFile(join(archiveDirectory, 'manifest.json'), JSON.stringify({
    release: process.env.SENTRY_RELEASE || process.env.SOURCE_VERSION || process.env.CONTAINER_VERSION || null,
    artifacts,
  }, null, 2) + '\n');
  return artifacts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const artifacts = await collectPrivateSourcemaps(process.cwd());
  console.log(`Sentry: ${artifacts.length} sourcemaps retained privately; none in public output`);
}
