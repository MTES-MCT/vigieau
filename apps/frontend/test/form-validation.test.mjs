import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { focusFirstInvalidField } from '../client/utils/form-validation.ts';

const mainSearchSource = readFile(
  new URL('../client/components/mixins/Search.vue', import.meta.url),
  'utf8',
);

test('focuses the first available invalid field in validation order', () => {
  const dom = new JSDOM(`
    <select id="main-search-profile"></select>
    <select id="main-search-water-type"></select>
    <input id="main-search-address">
  `);

  const focused = focusFirstInvalidField(dom.window.document, [
    'missing-field',
    'main-search-water-type',
    'main-search-address',
  ]);

  assert.equal(focused, true);
  assert.equal(
    dom.window.document.activeElement?.id,
    'main-search-water-type',
  );
});

test('is safe when no focus target or root is available', () => {
  const dom = new JSDOM('<p id="content">Contenu</p>');

  assert.equal(
    focusFirstInvalidField(dom.window.document, ['missing-field']),
    false,
  );
  assert.equal(focusFirstInvalidField(undefined, ['content']), false);
});

test('submits the main search through a native form without hiding validation', async () => {
  const source = await mainSearchSource;

  assert.match(
    source,
    /<form[\s\S]*novalidate[\s\S]*@submit\.prevent="searchZone"/,
  );
  assert.match(
    source,
    /<DsfrButton[\s\S]*type="submit"[\s\S]*:disabled="loading"/,
  );
  assert.doesNotMatch(source, /:disabled="loading \|\| v\$\.\$invalid"/);
});

test('links main search errors and exposes required select labels', async () => {
  const source = await mainSearchSource;

  for (const field of ['profile', 'water-type', 'address']) {
    assert.match(source, new RegExp(`main-search-${field}`));
    assert.match(source, new RegExp(`main-search-${field}-error`));
  }

  assert.equal(source.match(/#required-tip/g)?.length, 2);
  assert.equal(source.match(/> \(obligatoire\)<\/span>/g)?.length, 2);
  assert.match(source, /focusFirstInvalidField\(document/);
});
