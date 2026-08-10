import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import {
  ensureButtonAccessibleText,
  focusFirstBreadcrumbLink,
  focusRouteContent,
  getFocusableElements,
  trapTabKey,
} from '../client/utils/focus-management.ts';

test('adds real visually hidden text to an icon-only button', () => {
  const dom = new JSDOM('<button id="button-menu" aria-label="Menu"></button>');

  const button = ensureButtonAccessibleText(
    dom.window.document,
    'button-menu',
    'Menu',
  );
  ensureButtonAccessibleText(dom.window.document, 'button-menu', 'Menu');

  assert.equal(button?.textContent, 'Menu');
  assert.equal(button?.querySelectorAll('.fr-sr-only').length, 1);
});

test('focuses the page heading after a route change', () => {
  const dom = new JSDOM('<main id="main-content"><h1>Nouvelle page</h1></main>');

  const target = focusRouteContent(dom.window.document);

  assert.equal(target?.textContent, 'Nouvelle page');
  assert.equal(target?.getAttribute('tabindex'), '-1');
  assert.equal(dom.window.document.activeElement, target);
});

test('falls back to the main landmark when a page has no heading', () => {
  const dom = new JSDOM('<main id="main-content"><p>Contenu</p></main>');

  const target = focusRouteContent(dom.window.document);

  assert.equal(target?.id, 'main-content');
  assert.equal(dom.window.document.activeElement, target);
});

test('ignores a heading that belongs to a closed dialog during route focus', () => {
  const dom = new JSDOM(`
    <main id="main-content">
      <p>Contenu de la page</p>
      <dialog>
        <h1>Titre de modale fermée</h1>
      </dialog>
    </main>
  `);

  const target = focusRouteContent(dom.window.document);

  assert.equal(target?.id, 'main-content');
  assert.equal(dom.window.document.activeElement, target);
});

test('focuses a rendered fragment target after cross-page navigation', () => {
  const dom = new JSDOM(`
    <main id="main-content">
      <h1>Déclaration d’accessibilité</h1>
      <h2 id="amelioration-contact">Amélioration et contact</h2>
    </main>
  `);

  const target = focusRouteContent(
    dom.window.document,
    '#amelioration-contact',
  );

  assert.equal(target?.id, 'amelioration-contact');
  assert.equal(target?.getAttribute('tabindex'), '-1');
  assert.equal(dom.window.document.activeElement, target);
});

test('focuses rendered landmarks outside main and falls back on invalid fragments', () => {
  const dom = new JSDOM(`
    <header id="outside">Navigation</header>
    <main id="main-content"><h1>Page courante</h1></main>
  `);

  const outside = focusRouteContent(dom.window.document, '#outside');
  assert.equal(outside?.id, 'outside');
  assert.equal(dom.window.document.activeElement, outside);
  assert.equal(
    focusRouteContent(dom.window.document, '#%E0%A4%A')?.textContent,
    'Page courante',
  );
});

test('wraps focus inside an open dialog in both directions', () => {
  const dom = new JSDOM(`
    <div id="dialog">
      <button id="first">Premier</button>
      <span hidden><button id="hidden">Masqué</button></span>
      <button id="programmatic" tabindex="-2">Hors tabulation</button>
      <a id="last" href="/next">Dernier</a>
    </div>
    <button id="outside">Hors dialogue</button>
  `);
  const dialog = dom.window.document.getElementById('dialog');
  const first = dom.window.document.getElementById('first');
  const last = dom.window.document.getElementById('last');

  assert.deepEqual(
    getFocusableElements(dialog).map((element) => element.id),
    ['first', 'last'],
  );

  last.focus();
  const forwards = new dom.window.KeyboardEvent('keydown', {
    key: 'Tab',
    cancelable: true,
  });
  assert.equal(trapTabKey(forwards, dialog), true);
  assert.equal(forwards.defaultPrevented, true);
  assert.equal(dom.window.document.activeElement, first);

  first.focus();
  const backwards = new dom.window.KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: true,
    cancelable: true,
  });
  assert.equal(trapTabKey(backwards, dialog), true);
  assert.equal(backwards.defaultPrevented, true);
  assert.equal(dom.window.document.activeElement, last);
});

test('focuses the first breadcrumb link after disclosure', () => {
  const dom = new JSDOM(`
    <div id="breadcrumb">
      <a class="fr-breadcrumb__link" href="/">Accueil</a>
      <a class="fr-breadcrumb__link" aria-current="page">Page</a>
    </div>
  `);
  const breadcrumb = dom.window.document.getElementById('breadcrumb');

  const target = focusFirstBreadcrumbLink(breadcrumb);

  assert.equal(target?.textContent, 'Accueil');
  assert.equal(dom.window.document.activeElement, target);
});
