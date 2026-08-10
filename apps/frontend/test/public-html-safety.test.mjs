import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const clientRoot = fileURLToPath(new URL('../client/', import.meta.url));

async function collectVueFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return collectVueFiles(entryPath);
      }

      return entry.isFile() && entry.name.endsWith('.vue') ? [entryPath] : [];
    }),
  );

  return files.flat();
}

test('limits v-html to the reviewed local FAQ content', async () => {
  const vueFiles = await collectVueFiles(clientRoot);
  const usages = [];

  for (const file of vueFiles) {
    const source = await readFile(file, 'utf8');
    const directiveCount = source.match(/\bv-html\b/g)?.length ?? 0;

    if (directiveCount > 0) {
      usages.push({
        file: path.relative(clientRoot, file),
        directiveCount,
        source,
      });
    }
  }

  assert.equal(usages.length, 1);
  assert.equal(usages[0].file, 'components/accueil/Faq.vue');
  assert.equal(usages[0].directiveCount, 1);
  assert.match(
    usages[0].source,
    /\bv-html\s*=\s*["']item\.response["']/,
  );
});

test('renders API subscription labels with escaped Vue interpolation', async () => {
  const source = await readFile(
    new URL('../client/pages/abonnements/index.vue', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /modalText|v-html/);
  assert.match(
    source,
    /<strong>\{\{ subscriptionsToUnsubscribe\[0\]\.libelleLocalisation \}\}<\/strong>/,
  );
});

test('keeps the cookies page paragraphs and lists structurally separate', async () => {
  const source = await readFile(
    new URL('../client/pages/cookies/index.vue', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /<p\b[^>]*>(?:(?!<\/p>)[\s\S])*<ul\b/);
  assert.doesNotMatch(source, /<br\b/i);
  assert.match(source, /<ul>[\s\S]*?<li>[\s\S]*?<\/li>[\s\S]*?<\/ul>/);
});
