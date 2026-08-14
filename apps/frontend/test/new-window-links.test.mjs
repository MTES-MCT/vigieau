import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import {
  enhanceNewWindowLink,
  enhanceNewWindowLinks,
  observeNewWindowLinks,
} from '../client/utils/new-window-links.ts';

const flushMutations = () => new Promise((resolve) => setTimeout(resolve, 0));

test('preserves visible text and appends one hidden new-window announcement', () => {
  const dom = new JSDOM(`
    <a id="link" href="https://example.test" target="_blank" rel="external">
      Documentation
    </a>
  `);
  const link = dom.window.document.getElementById('link');

  assert.equal(enhanceNewWindowLink(link), true);
  assert.equal(enhanceNewWindowLink(link), true);

  assert.equal(link.childNodes[0].textContent.trim(), 'Documentation');
  assert.equal(
    link.querySelector('[data-vigieau-new-window-suffix]').textContent,
    ' (nouvelle fenêtre)',
  );
  assert.equal(
    link.querySelectorAll('[data-vigieau-new-window-suffix]').length,
    1,
  );
  assert.deepEqual(new Set(link.rel.split(/\s+/)), new Set([
    'external',
    'noopener',
    'noreferrer',
  ]));
});

test('does not rely on title and secures every static blank-target link', () => {
  const dom = new JSDOM(`
    <main>
      <a target="_blank" title="Rapport (nouvelle fenêtre)">Rapport</a>
      <a target="_BLANK" rel="NoOpener opener NOREFERRER">Données</a>
    </main>
  `);

  assert.equal(enhanceNewWindowLinks(dom.window.document), 2);

  const links = [...dom.window.document.querySelectorAll('a')];
  assert.equal(
    links[0].querySelector('[data-vigieau-new-window-suffix]').textContent,
    ' (nouvelle fenêtre)',
  );
  assert.equal(links[1].rel.split(/\s+/).includes('opener'), false);
  assert.equal(links[1].rel.split(/\s+/).includes('noopener'), true);
  assert.equal(links[1].rel.split(/\s+/).includes('noreferrer'), true);
});

test('extends aria-label while retaining a different visible label', () => {
  const dom = new JSDOM(`
    <a id="link" target="_blank" aria-label="Télécharger le document">
      Rapport annuel
    </a>
  `);
  const link = dom.window.document.getElementById('link');

  enhanceNewWindowLink(link);
  enhanceNewWindowLink(link);

  assert.equal(
    link.getAttribute('aria-label'),
    'Rapport annuel – Télécharger le document (nouvelle fenêtre)',
  );
});

test('keeps an authored announcement without adding a duplicate suffix', () => {
  const dom = new JSDOM(`
    <a id="link" href="https://example.test" target="_blank">
      Documentation <span class="fr-sr-only">(nouvelle fenêtre)</span>
    </a>
  `);
  const link = dom.window.document.getElementById('link');

  enhanceNewWindowLink(link);

  assert.equal(
    link.querySelector('[data-vigieau-new-window-suffix]'),
    null,
  );
  assert.equal(
    (link.textContent.match(/nouvelle fenêtre/g) || []).length,
    1,
  );
});

test('extends aria-labelledby without replacing its existing label source', () => {
  const dom = new JSDOM(`
    <span id="label">Consulter le rapport</span>
    <a id="link" target="_blank" aria-labelledby="label"></a>
  `);
  const link = dom.window.document.getElementById('link');

  enhanceNewWindowLink(link);
  enhanceNewWindowLink(link);

  const ids = link.getAttribute('aria-labelledby').split(/\s+/);
  const suffix = link.querySelector('[data-vigieau-new-window-suffix]');
  assert.equal(ids[0], 'label');
  assert.equal(ids[1], suffix.id);
  assert.equal(suffix.textContent, ' (nouvelle fenêtre)');
  assert.equal(ids.length, 2);
});

test('observes dynamically injected links and restores generated labels when target changes', async () => {
  const dom = new JSDOM('<main id="content"></main>');
  const stop = observeNewWindowLinks(dom.window.document);
  const content = dom.window.document.getElementById('content');

  content.innerHTML = `
    <a id="dynamic" target="_blank" aria-label="Notice">Lire la notice</a>
  `;
  await flushMutations();

  const link = dom.window.document.getElementById('dynamic');
  assert.equal(
    link.getAttribute('aria-label'),
    'Lire la notice – Notice (nouvelle fenêtre)',
  );
  assert.equal(link.rel, 'noopener noreferrer');

  link.setAttribute('target', '_self');
  await flushMutations();
  assert.equal(link.getAttribute('aria-label'), 'Notice');
  assert.equal(link.querySelector('[data-vigieau-new-window-suffix]'), null);

  stop();
});

test('restores an absent aria-label after an unnamed link stops opening a new window', async () => {
  const dom = new JSDOM(`
    <a id="link" href="https://example.test/notice" target="_blank"></a>
  `);
  const link = dom.window.document.getElementById('link');
  const stop = observeNewWindowLinks(dom.window.document);

  assert.equal(
    link.getAttribute('aria-label'),
    'https://example.test/notice (nouvelle fenêtre)',
  );

  link.setAttribute('target', '_self');
  await flushMutations();
  assert.equal(link.hasAttribute('aria-label'), false);

  stop();
});

test('honors an author removing a generated aria-label from a live link', async () => {
  const dom = new JSDOM(`
    <a id="link" href="https://example.test" target="_blank" aria-label="Notice">
      Lire la notice
    </a>
  `);
  const link = dom.window.document.getElementById('link');
  const stop = observeNewWindowLinks(dom.window.document);

  link.removeAttribute('aria-label');
  await flushMutations();

  assert.equal(link.hasAttribute('aria-label'), false);
  assert.equal(
    link.querySelectorAll('[data-vigieau-new-window-suffix]').length,
    1,
  );

  link.setAttribute('target', '_self');
  await flushMutations();
  assert.equal(link.hasAttribute('aria-label'), false);
  assert.equal(link.querySelector('[data-vigieau-new-window-suffix]'), null);

  stop();
});
