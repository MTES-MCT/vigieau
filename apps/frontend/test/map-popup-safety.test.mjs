import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import {
  createCommunePopupContent,
  createFullCommunePopupContent,
  createPointSelectionPopupContent,
  createRestrictionsPopupContent,
  createStatsPopupContent,
} from '../client/utils/map-popup-content.ts';

const clientRoot = fileURLToPath(new URL('../client/', import.meta.url));
const injection = '<img src=x onerror="globalThis.injected=true"><script>bad()</script>';

const createDocument = () => new JSDOM('<!doctype html>').window.document;

const assertTextIsEscaped = (element, expectedText = injection) => {
  assert.match(element.textContent, new RegExp(expectedText.replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
  )));
  assert.equal(element.querySelector('img, script'), null);
  assert.doesNotMatch(element.innerHTML, /<(?:img|script)\b/i);
  assert.match(element.innerHTML, /&lt;img[\s\S]*&lt;script&gt;/i);
};

async function collectPublicSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const sources = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return collectPublicSources(entryPath);
    }
    if (!entry.isFile() || !/\.(?:js|ts|vue)$/.test(entry.name)) {
      return [];
    }
    return [{
      file: path.relative(clientRoot, entryPath),
      source: await readFile(entryPath, 'utf8'),
    }];
  }));

  return sources.flat();
}

test('échappe les libellés du point sélectionné et conserve son bouton', () => {
  const content = createPointSelectionPopupContent(
    { addressLabel: injection },
    createDocument(),
  );

  assertTextIsEscaped(content);
  assert.match(
    content.querySelector('p.fr-mb-2w')?.textContent,
    /Adresse proche\u00A0:/,
  );
  assert.equal(content.querySelector('br'), null);
  const button = content.querySelector('button.fr-btn.btn-map-popup');
  assert.ok(button);
  assert.equal(button.type, 'button');
  assert.equal(button.textContent, 'Sélectionner ce point');
});

test('échappe badges, zones et adresse sans perdre la structure restrictions', () => {
  const content = createRestrictionsPopupContent(
    [
      { badgeLabel: injection, rank: 4, zoneName: injection },
      { badgeLabel: 'Alerte', rank: 2, zoneName: 'Zone secondaire' },
    ],
    true,
    `Adresse proche\u00A0: ${injection}`,
    createDocument(),
  );

  assertTextIsEscaped(content);
  assert.equal(content.querySelectorAll('p.fr-badge').length, 2);
  assert.ok(content.querySelector('p.situation-level-bg-4'));
  assert.equal(content.querySelectorAll('.map-popup-zone').length, 2);
  assert.equal(content.querySelectorAll('.divider.fr-my-1w').length, 1);
  assert.equal(
    content.querySelector('button.btn-map-popup')?.textContent,
    'Je consulte les restrictions',
  );
});

test('un résultat vide reste neutre tant que la disponibilité n’est pas résolue', () => {
  const content = createRestrictionsPopupContent(
    [],
    false,
    '',
    createDocument(),
  );

  assert.equal(
    content.querySelector('[role="status"]')?.textContent,
    'Vérification des restrictions en cours…',
  );
  assert.equal(content.querySelector('.situation-level-bg-0'), null);
  assert.equal(content.querySelector('button'), null);
});

test('affiche sans restrictions uniquement après confirmation explicite', () => {
  const content = createRestrictionsPopupContent(
    [],
    true,
    '',
    createDocument(),
    { status: 'confirmed_none' },
  );

  assert.equal(
    content.querySelector('p.fr-badge.situation-level-bg-0')?.textContent,
    'Pas de restrictions',
  );
  assert.equal(
    content.querySelector('button.btn-map-popup')?.textContent,
    'Je consulte les restrictions',
  );
});

test('rend l’indisponibilité actionnable avec uniquement un lien HTTPS', () => {
  const official = createRestrictionsPopupContent(
    [],
    true,
    '',
    createDocument(),
    {
      status: 'unavailable',
      officialUrl: 'https://www.deux-sevres.gouv.fr/eau',
    },
  );
  const unsafe = createRestrictionsPopupContent(
    [],
    false,
    '',
    createDocument(),
    { status: 'unavailable', officialUrl: 'javascript:alert(1)' },
  );

  assert.match(official.textContent, /ne peuvent pas être confirmées/);
  assert.equal(
    official.querySelector('a.fr-link')?.href,
    'https://www.deux-sevres.gouv.fr/eau',
  );
  assert.equal(official.querySelector('a.fr-link')?.target, '_blank');
  assert.match(official.querySelector('a.fr-link')?.rel ?? '', /noopener/);
  assert.equal(unsafe.querySelector('a'), null);
  assert.match(unsafe.textContent, /services de l'État de votre département/);
});

test('présente un arrêté municipal sans badge de rang zéro', () => {
  const content = createRestrictionsPopupContent(
    [],
    true,
    '',
    createDocument(),
    {
      status: 'municipal',
      documentUrl: 'https://example.test/arrete-municipal.pdf',
    },
  );

  assert.match(content.textContent, /arrêté municipal a été publié/);
  assert.equal(content.querySelector('.situation-level-bg-0'), null);
  assert.equal(
    content.querySelector('a.fr-link')?.href,
    'https://example.test/arrete-municipal.pdf',
  );
});

test('échappe le nom de commune dans les popups de chargement et de bilan', () => {
  const popupDocument = createDocument();
  const loadingContent = createCommunePopupContent(injection, popupDocument);
  const fullContent = createFullCommunePopupContent(
    injection,
    {
      noDays: 1,
      vigilanceDays: 2,
      alerteDays: 3,
      alerteRenforceeDays: 4,
      criseDays: 5,
      nbDays: 10,
    },
    popupDocument,
  );

  assertTextIsEscaped(loadingContent);
  assert.equal(loadingContent.querySelectorAll('.lds-ring > div').length, 4);
  assert.equal(
    loadingContent.querySelector('button.btn-map-popup')?.textContent,
    "Voir l'historique",
  );
  assertTextIsEscaped(fullContent);
  assert.equal(fullContent.querySelectorAll('ul.text-align-left > li').length, 5);
  assert.match(fullContent.querySelector('li')?.textContent, /\u00A0:/);
  assert.equal(
    fullContent.querySelector('button.btn-map-popup')?.textContent,
    "Voir l'historique",
  );
});

test('échappe les propriétés de tuiles des statistiques', () => {
  const content = createStatsPopupContent(
    { name: injection, code: injection, summary: injection },
    createDocument(),
  );

  assertTextIsEscaped(content);
  assert.equal(content.children.length, 2);
});

test('interdit setHTML et les entités nbsp malformées dans le client public', async () => {
  const sources = await collectPublicSources(clientRoot);
  let domSetterCount = 0;

  for (const { file, source } of sources) {
    assert.doesNotMatch(source, /\.setHTML\s*\(/, file);
    assert.doesNotMatch(source, /&nbsp:/, file);
    domSetterCount += source.match(/\.setDOMContent\s*\(/g)?.length ?? 0;
  }

  assert.equal(domSetterCount, 6);
});
