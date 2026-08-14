import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import {
  lockModalPageScroll,
  unlockModalPageScroll,
} from '../client/utils/modal-scroll-lock.ts';

function installDom(t, scrollY = 420) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
  });
  const previousGlobals = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    window: globalThis.window,
  };

  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.window = dom.window;

  Object.defineProperty(dom.window, 'innerWidth', {
    configurable: true,
    value: 1000,
  });
  Object.defineProperty(dom.window, 'scrollY', {
    configurable: true,
    value: scrollY,
    writable: true,
  });
  Object.defineProperty(dom.window.document.documentElement, 'clientWidth', {
    configurable: true,
    value: 985,
  });
  dom.window.scrollTo = (_x, y) => {
    dom.window.scrollY = y;
  };

  t.after(() => {
    globalThis.document = previousGlobals.document;
    globalThis.getComputedStyle = previousGlobals.getComputedStyle;
    globalThis.window = previousGlobals.window;
    dom.window.close();
  });

  return dom;
}

test('locks scrolling once across several open public modals', (t) => {
  const dom = installDom(t);
  const root = dom.window.document.documentElement;
  const body = dom.window.document.body;
  root.style.scrollBehavior = 'smooth';

  lockModalPageScroll();
  lockModalPageScroll();

  assert.equal(root.getAttribute('data-fr-scrolling'), 'false');
  assert.equal(body.style.top, '-420px');
  assert.equal(root.style.getPropertyValue('--scrollbar-width'), '15px');
  assert.equal(root.style.scrollBehavior, 'auto');

  unlockModalPageScroll();
  assert.equal(root.getAttribute('data-fr-scrolling'), 'false');

  dom.window.scrollY = 0;
  unlockModalPageScroll();
  assert.equal(root.hasAttribute('data-fr-scrolling'), false);
  assert.equal(body.style.top, '');
  assert.equal(root.style.getPropertyValue('--scrollbar-width'), '');
  assert.equal(root.style.scrollBehavior, 'smooth');
  assert.equal(dom.window.scrollY, 420);
});

test('preserves a scroll lock already owned by another DSFR dialog', (t) => {
  const dom = installDom(t, 120);
  const root = dom.window.document.documentElement;
  root.setAttribute('data-fr-scrolling', 'false');
  dom.window.document.body.style.top = '-120px';

  lockModalPageScroll();
  unlockModalPageScroll();

  assert.equal(root.getAttribute('data-fr-scrolling'), 'false');
  assert.equal(dom.window.document.body.style.top, '-120px');
});
