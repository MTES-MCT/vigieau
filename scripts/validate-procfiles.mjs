import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const validateProcfile = (content) => {
  const errors = [];
  const processTypes = new Set();

  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = /^([A-Za-z0-9]+):\s+(.+)$/.exec(line);
    if (!match) {
      errors.push(`line ${index + 1}: invalid process declaration`);
      continue;
    }

    const processType = match[1];
    if (processTypes.has(processType)) {
      errors.push(`line ${index + 1}: duplicate process type ${processType}`);
    }
    processTypes.add(processType);
  }

  return errors;
};

export const validateProcfilePath = async (path) => {
  const errors = validateProcfile(await readFile(path, 'utf8'));
  return errors.map((error) => `${path}: ${error}`);
};

const main = async () => {
  const paths = process.argv.slice(2);
  const errors = (
    await Promise.all(paths.map((path) => validateProcfilePath(path)))
  ).flat();

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
