import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createLatestRequestGuard,
  getAddressSuggestionStatus,
  moveActiveOption,
} from '../client/utils/address-combobox.ts';

const componentSources = Promise.all([
  readFile(new URL('../client/components/FdrAutoComplete.vue', import.meta.url), 'utf8'),
  readFile(new URL('../client/components/mixins/SearchAddress.vue', import.meta.url), 'utf8'),
]);

test('moves the active option without ever targeting an empty list', () => {
  assert.equal(moveActiveOption(-1, 0, 'next'), -1);
  assert.equal(moveActiveOption(-1, 3, 'next'), 0);
  assert.equal(moveActiveOption(0, 3, 'previous'), 2);
  assert.equal(moveActiveOption(2, 3, 'next'), 0);
  assert.equal(moveActiveOption(2, 3, 'previous'), 1);
});

test('formats singular, plural and empty suggestion announcements', () => {
  assert.equal(getAddressSuggestionStatus(0), 'Aucune adresse trouvée.');
  assert.match(getAddressSuggestionStatus(1), /^1 suggestion d’adresse disponible\./);
  assert.match(getAddressSuggestionStatus(10), /^10 suggestions d’adresses disponibles\./);
});

test('invalidates every response older than the latest request or cancellation', () => {
  const guard = createLatestRequestGuard();
  const firstRequest = guard.next();
  const secondRequest = guard.next();

  assert.equal(guard.isCurrent(firstRequest), false);
  assert.equal(guard.isCurrent(secondRequest), true);

  guard.cancel();
  assert.equal(guard.isCurrent(secondRequest), false);
});

test('keeps the ARIA combobox focus model on the input', async () => {
  const [autocompleteSource] = await componentSources;

  assert.match(autocompleteSource, /role="combobox"/);
  assert.match(autocompleteSource, /aria-autocomplete="list"/);
  assert.match(autocompleteSource, /:aria-expanded="displayListbox"/);
  assert.match(autocompleteSource, /:aria-controls="listboxId"/);
  assert.match(autocompleteSource, /:aria-activedescendant="activeOptionId"/);
  assert.match(autocompleteSource, /role="listbox"/);
  assert.match(autocompleteSource, /role="option"/);
  assert.doesNotMatch(autocompleteSource, /tabindex="[01]"/);
});

test('provides persistent search and geolocation status paths', async () => {
  const [autocompleteSource, searchAddressSource] = await componentSources;

  assert.match(autocompleteSource, /data-cy="AddressSearchStatus"/);
  assert.match(autocompleteSource, /role="status"/);
  assert.doesNotMatch(autocompleteSource, /v-if="statusMessage"/);
  assert.match(searchAddressSource, /Géolocalisation en cours\./);
  assert.match(searchAddressSource, /Position localisée/);
  assert.match(searchAddressSource, /La géolocalisation a échoué/);
  assert.match(searchAddressSource, /createLatestRequestGuard/);
  assert.match(searchAddressSource, /loadAddresses\.value = false;/);
  assert.match(searchAddressSource, /\{ timeout: 10_000 \}/);
});

test('processes an empty manual value before the null-selection guard', async () => {
  const [, searchAddressSource] = await componentSources;
  const stringBranch = searchAddressSource.indexOf("if (typeof address === 'string')");
  const nullBranch = searchAddressSource.indexOf('if (!address && !geo)');

  assert.notEqual(stringBranch, -1);
  assert.notEqual(nullBranch, -1);
  assert.ok(stringBranch < nullBranch);
});

test('makes the required state visible and native', async () => {
  const [autocompleteSource] = await componentSources;

  assert.match(autocompleteSource, /> \(obligatoire\)<\/span>/);
  assert.match(autocompleteSource, /:required="required"/);
});
