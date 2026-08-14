import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const clientRoot = new URL('../client/', import.meta.url);
const accessibleModalSource = await readFile(
  new URL('../client/components/AccessibleModal.vue', import.meta.url),
  'utf8',
);
const restrictionCardSource = await readFile(
  new URL('../client/components/situation/RestrictionCard.vue', import.meta.url),
  'utf8',
);
const statusSource = await readFile(
  new URL('../client/components/situation/Status.vue', import.meta.url),
  'utf8',
);
const searchAddressSource = await readFile(
  new URL('../client/components/mixins/SearchAddress.vue', import.meta.url),
  'utf8',
);

async function vueSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const sources = [];

  for (const entry of entries) {
    const url = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);

    if (entry.isDirectory()) {
      sources.push(...await vueSources(url));
    } else if (entry.name.endsWith('.vue')) {
      sources.push({
        name: url.pathname.replace(clientRoot.pathname, ''),
        source: await readFile(url, 'utf8'),
      });
    }
  }

  return sources;
}

test('uses the local native dialog implementation for every public modal', async () => {
  const sources = await vueSources(clientRoot);
  const remainingDsfrModals = sources
    .filter(({ source }) => /<DsfrModal\b/.test(source))
    .map(({ name }) => name);
  const accessibleModalCount = sources.reduce(
    (count, { source }) => count + (source.match(/<AccessibleModal\b/g) ?? []).length,
    0,
  );

  assert.deepEqual(remainingDsfrModals, []);
  assert.equal(accessibleModalCount, 7);
  assert.doesNotMatch(searchAddressSource, /DsfrModal|AccessibleModal|modalOpened/);
  assert.match(accessibleModalSource, /<dialog[\s\S]*?data-accessible-modal/);
  assert.match(accessibleModalSource, /dialog\.showModal\(\)/);
  assert.match(accessibleModalSource, /@cancel="requestClose"/);
  assert.match(accessibleModalSource, /:aria-labelledby="titleId"/);
  assert.doesNotMatch(accessibleModalSource, /document\.addEventListener/);
});

test('names modals, supports intentional initial focus and restores the origin', () => {
  assert.match(
    accessibleModalSource,
    /props\.title\.trim\(\) \|\| 'Boîte de dialogue'/,
  );
  assert.match(
    accessibleModalSource,
    /props\.initialFocus[\s\S]*?dialog\.querySelector<HTMLElement>/,
  );
  assert.match(
    accessibleModalSource,
    /const activeElement = document\.activeElement[\s\S]*?returnFocusTarget\.value = props\.origin/,
  );
  assert.match(
    accessibleModalSource,
    /closeDialog[\s\S]*?dialog\.close\(\)[\s\S]*?focusTarget\(target\)/,
  );
});

test('keeps restriction feedback in one named modal with success and error states', () => {
  assert.match(restrictionCardSource, /modalStep = ref<'feedback' \| 'success' \| null>/);
  assert.match(restrictionCardSource, /modalStep\.value = 'feedback'/);
  assert.match(restrictionCardSource, /modalStep\.value = 'success'/);
  assert.match(restrictionCardSource, /if \(error\?\.value\)/);
  assert.match(restrictionCardSource, /catch[\s\S]*?n’a pas pu être envoyé/);
  assert.match(restrictionCardSource, /role="status"[\s\S]*?aria-live="polite"/);
  assert.match(restrictionCardSource, /label: 'Annuler et fermer'/);
  assert.match(restrictionCardSource, /:origin="questionBtn \?\? undefined"/);
  assert.doesNotMatch(restrictionCardSource, /title="\s+"/);
});

test('requires and describes the initial multi-zone selection', () => {
  assert.match(statusSource, /if \(!zoneModal\.value\)/);
  assert.match(statusSource, /Sélectionnez une zone d’alerte/);
  assert.match(statusSource, /initial-focus="#situation-alert-zone-modal"/);
  assert.match(
    statusSource,
    /:aria-invalid="zoneModalError \? 'true' : undefined"/,
  );
  assert.match(
    statusSource,
    /:aria-describedby="zoneModalError \? 'situation-alert-zone-modal-error' : undefined"/,
  );
  assert.match(statusSource, /if \(!modalOpened\.value\)[\s\S]*?return/);
});
