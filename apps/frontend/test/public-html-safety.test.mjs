import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { NodeTypes } from '@vue/compiler-dom';
import { parse } from '@vue/compiler-sfc';

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

test('keeps block content out of every public Vue paragraph', async () => {
  const blockTags = new Set([
    'address',
    'article',
    'aside',
    'blockquote',
    'details',
    'dialog',
    'div',
    'dl',
    'fieldset',
    'figure',
    'footer',
    'form',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'header',
    'hr',
    'main',
    'nav',
    'ol',
    'p',
    'pre',
    'section',
    'table',
    'ul',
  ]);
  const violations = [];

  for (const file of await collectVueFiles(clientRoot)) {
    const source = await readFile(file, 'utf8');
    const relativeFile = path.relative(clientRoot, file);
    const { descriptor, errors } = parse(source, { filename: relativeFile });

    assert.deepEqual(errors, [], `${relativeFile}: invalid Vue syntax`);
    const template = descriptor.template?.ast;
    if (!template) {
      continue;
    }

    const visit = (node, paragraph = null) => {
      let currentParagraph = paragraph;
      if (node.type === NodeTypes.ELEMENT) {
        if (paragraph && blockTags.has(node.tag)) {
          violations.push(
            `${relativeFile}:${node.loc.start.line} <${node.tag}> in paragraph line ${paragraph.loc.start.line}`,
          );
        }
        if (node.tag === 'p') {
          currentParagraph = node;
        }
      }

      for (const child of node.children ?? []) {
        visit(child, currentParagraph);
      }
    };

    visit(template);
  }

  assert.deepEqual(violations, []);
});

test('keeps every client alert named and removes level-six headings', async () => {
  const unnamedAlerts = [];
  const levelSixHeadings = [];

  for (const file of await collectVueFiles(clientRoot)) {
    const source = await readFile(file, 'utf8');
    const relativeFile = path.relative(clientRoot, file);
    const { descriptor, errors } = parse(source, { filename: relativeFile });

    assert.deepEqual(errors, [], `${relativeFile}: invalid Vue syntax`);
    const template = descriptor.template?.ast;
    if (!template) {
      continue;
    }

    const visit = (node) => {
      if (node.type === NodeTypes.ELEMENT) {
        if (node.tag.toLowerCase() === 'h6') {
          levelSixHeadings.push(`${relativeFile}:${node.loc.start.line}`);
        }

        if (node.tag.toLowerCase() === 'dsfralert') {
          const hasNonEmptyTitle = node.props.some((property) => {
            if (
              property.type === NodeTypes.ATTRIBUTE &&
              property.name === 'title'
            ) {
              return Boolean(property.value?.content.trim());
            }

            return (
              property.type === NodeTypes.DIRECTIVE &&
              property.name === 'bind' &&
              property.arg?.type === NodeTypes.SIMPLE_EXPRESSION &&
              property.arg.content === 'title' &&
              property.exp?.type === NodeTypes.SIMPLE_EXPRESSION &&
              Boolean(property.exp.content.trim())
            );
          });

          if (!hasNonEmptyTitle) {
            unnamedAlerts.push(`${relativeFile}:${node.loc.start.line}`);
          }
        }
      }

      for (const child of node.children ?? []) {
        visit(child);
      }
    };

    visit(template);
  }

  assert.deepEqual(unnamedAlerts, []);
  assert.deepEqual(levelSixHeadings, []);
});
