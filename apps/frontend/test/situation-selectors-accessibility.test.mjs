import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const statusSource = await readFile(
  new URL('../client/components/situation/Status.vue', import.meta.url),
  'utf8',
);
const headerSource = await readFile(
  new URL('../client/components/situation/Header.vue', import.meta.url),
  'utf8',
);
const restrictionsSource = await readFile(
  new URL('../client/components/situation/Restrictions.vue', import.meta.url),
  'utf8',
);
const restrictionCardSource = await readFile(
  new URL('../client/components/situation/RestrictionCard.vue', import.meta.url),
  'utf8',
);

const selectMarkup = statusSource.match(
  /<DsfrSelect\b[\s\S]*?(?:\/>|<\/DsfrSelect>)/g,
) ?? [];

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

test('announces profile, water type and alert-zone updates from one stable status', () => {
  assert.equal((statusSource.match(/role="status"/g) ?? []).length, 1);
  assert.match(
    statusSource,
    /id="situation-update-status"[\s\S]*?aria-live="polite"[\s\S]*?aria-atomic="true"/,
  );
  assert.match(statusSource, /const situationUpdateAnnouncement = ref\(''\)/);
  assert.match(
    statusSource,
    /\[profile, typeEau, \(\) => zone\.value\?\.id\]/,
  );
  assert.match(statusSource, /Restrictions mises à jour pour le profil/);
  assert.match(statusSource, /Restrictions mises à jour pour l’eau/);
  assert.match(statusSource, /Restrictions mises à jour pour la zone d’alerte/);

  const statusIndex = statusSource.indexOf('id="situation-update-status"');
  const situationHeaderIndex = statusSource.indexOf('<SituationHeader');

  assert.ok(statusIndex > statusSource.indexOf('</fieldset>'));
  assert.ok(statusIndex < situationHeaderIndex);
});

test('keeps the responsive restriction heading hierarchy coherent', () => {
  assert.match(
    restrictionsSource,
    /<DsfrAccordion[\s\S]*?title-tag="h3"/,
  );
  assert.doesNotMatch(restrictionsSource, /title-tag="h4"/);
  assert.match(
    restrictionCardSource,
    /<h3\b[^>]*>[\s\S]*?usage\.nom[\s\S]*?<\/h3>/,
  );
});

test('uses paragraphs for situation messages and restriction explanations', () => {
  assert.match(
    headerSource,
    /<p[^>]*>\{\{ niveauGravite\.description \}\}<\/p>/,
  );
  assert.match(
    headerSource,
    /<p[^>]*>Nous vous conseillons[\s\S]*?eco-gestes[\s\S]*?<\/p>/,
  );
  assert.match(
    restrictionsSource,
    /<p>[\s\S]*?Le respect des restrictions[\s\S]*?amende[\s\S]*?<\/p>/,
  );
  assert.doesNotMatch(
    restrictionsSource,
    /<div class="eau-card__desc">Aucune restriction<\/div>/,
  );
});

test('replaces the no-restriction fallback formatting with a heading and paragraph', () => {
  assert.match(
    statusSource,
    /<h3[^>]*>[\s\S]*?Besoin de précision sur les restrictions \?[\s\S]*?<\/h3>/,
  );
  assert.match(
    statusSource,
    /<p[^>]*>[\s\S]*?Votre mairie a pu renforcer ces restrictions[\s\S]*?<\/p>/,
  );
  assert.doesNotMatch(statusSource, /<b>|<br\b/);
});
