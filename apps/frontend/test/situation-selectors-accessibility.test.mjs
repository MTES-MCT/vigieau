import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const statusSource = await readFile(
  new URL('../client/components/situation/Status.vue', import.meta.url),
  'utf8',
);

const selectMarkup = statusSource.match(/<DsfrSelect\b[\s\S]*?\/>/g) ?? [];

test('renders one responsive fieldset instead of duplicate desktop and mobile controls', () => {
  assert.equal((statusSource.match(/<fieldset\b/g) ?? []).length, 1);
  assert.equal((statusSource.match(/<legend\b/g) ?? []).length, 1);
  assert.doesNotMatch(statusSource, /\b(?:hide|show)-sm\b/);
});

test('gives every situation select a unique and explicitly associated label', () => {
  const selectIds = selectMarkup.map((markup) => {
    assert.match(markup, /\blabel="[^"]+"/);
    assert.match(markup, /\bselect-id="[^"]+"/);
    assert.doesNotMatch(markup, /\b(?:title|titile)=/);
    assert.doesNotMatch(markup, /(?:^|\s)id=/);

    return markup.match(/\bselect-id="([^"]+)"/)?.[1];
  });

  assert.deepEqual(selectIds, [
    'situation-water-type',
    'situation-alert-zone',
    'situation-profile',
    'situation-alert-zone-modal',
  ]);
  assert.equal(new Set(selectIds).size, selectIds.length);
});

test('keeps each control understandable outside the visual sentence', () => {
  assert.match(statusSource, /label="Type d’eau concerné"/);
  assert.match(statusSource, /label="Zone d’alerte concernée"/);
  assert.match(statusSource, /label="Profil concerné"/);
  assert.match(statusSource, /label="Zone d’alerte à consulter"/);
});
