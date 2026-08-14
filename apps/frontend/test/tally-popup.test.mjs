import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import {
  enhanceAndFocusTallyPopup,
  observeTallyPopup,
  openAccessibleTallyPopup,
  TALLY_FEEDBACK_IFRAME_TITLE,
} from '../client/utils/tally-popup.ts';

function appendTallyPopup(document) {
  const popup = document.createElement('div');
  popup.className = 'tally-popup tally-form-w881YY';
  popup.innerHTML = `
    <iframe
      src="https://tally.so/popup/w881YY"
      title="Tally Forms"
      width="376"
      height="600"
      align="center"
      frameborder="0"
      marginheight="0"
      marginwidth="0"
      scrolling="yes"
    ></iframe>
  `;
  document.body.append(popup);
  return popup.querySelector('iframe');
}

test('targets only the feedback iframe and removes obsolete presentation attributes', () => {
  const dom = new JSDOM(`
    <iframe id="unrelated" title="Contenu cartographique"></iframe>
  `);
  const unrelatedIframe = dom.window.document.getElementById('unrelated');
  const tallyIframe = appendTallyPopup(dom.window.document);

  const target = enhanceAndFocusTallyPopup(dom.window.document);

  assert.equal(target, tallyIframe);
  assert.equal(target?.title, TALLY_FEEDBACK_IFRAME_TITLE);
  assert.equal(dom.window.document.activeElement, target);
  for (const attribute of [
    'align',
    'frameborder',
    'marginheight',
    'marginwidth',
    'scrolling',
  ]) {
    assert.equal(target?.hasAttribute(attribute), false);
  }
  assert.equal(target?.getAttribute('width'), '376');
  assert.equal(target?.getAttribute('height'), '600');
  assert.equal(unrelatedIframe?.title, 'Contenu cartographique');
});

test('connects the public feedback quick link to the DSFR onClick contract', async () => {
  const source = await readFile(
    new URL('../client/layouts/basic.vue', import.meta.url),
    'utf8',
  );

  assert.match(
    source,
    /label: 'Donner mon avis',[\s\S]*'data-cy': 'OpenFeedbackForm',[\s\S]*onClick: utils\.openTally/,
  );
  assert.doesNotMatch(source, /onclick: utils\.openTally/);
});

test('waits for the asynchronously injected Tally popup', async () => {
  const dom = new JSDOM('<button id="trigger">Donner mon avis</button>');
  const stopObserving = observeTallyPopup(dom.window.document);

  const iframe = appendTallyPopup(dom.window.document);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

  assert.equal(iframe?.title, TALLY_FEEDBACK_IFRAME_TITLE);
  assert.equal(dom.window.document.activeElement, iframe);
  stopObserving();
});

test('opens the feedback popup, focuses it and restores the trigger on close', () => {
  const dom = new JSDOM('<button id="trigger">Donner mon avis</button>');
  const trigger = dom.window.document.getElementById('trigger');
  trigger.focus();
  let popupOptions;

  dom.window.Tally = {
    openPopup(formId, options) {
      assert.equal(formId, 'w881YY');
      popupOptions = options;
      appendTallyPopup(dom.window.document);
      options.onOpen();
    },
  };

  assert.equal(openAccessibleTallyPopup(dom.window), true);
  assert.equal(
    dom.window.document.activeElement?.title,
    TALLY_FEEDBACK_IFRAME_TITLE,
  );

  popupOptions.onClose();
  assert.equal(dom.window.document.activeElement, trigger);
});

test('waits for the asynchronous widget script without throwing', () => {
  const dom = new JSDOM(`
    <button id="trigger">Donner mon avis</button>
    <script src="https://tally.so/widgets/embed.js"></script>
  `);
  const trigger = dom.window.document.getElementById('trigger');
  const script = dom.window.document.querySelector('script');
  trigger.focus();
  let opened = false;

  assert.equal(openAccessibleTallyPopup(dom.window), true);

  dom.window.Tally = {
    openPopup(_formId, options) {
      opened = true;
      appendTallyPopup(dom.window.document);
      options.onOpen();
    },
  };
  script.dispatchEvent(new dom.window.Event('load'));

  assert.equal(opened, true);
  assert.equal(
    dom.window.document.activeElement?.title,
    TALLY_FEEDBACK_IFRAME_TITLE,
  );
});

test('keeps focus stable when the Tally API and widget script are absent', () => {
  const dom = new JSDOM('<button id="trigger">Donner mon avis</button>');
  const trigger = dom.window.document.getElementById('trigger');
  trigger.focus();

  assert.doesNotThrow(() => openAccessibleTallyPopup(dom.window));
  assert.equal(openAccessibleTallyPopup(dom.window), false);
  assert.equal(dom.window.document.activeElement, trigger);
});
