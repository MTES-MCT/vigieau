import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { downloadElementAsPng } from '../client/utils/png-download.ts';

function installDom(t) {
  const dom = new JSDOM(
    '<!doctype html><html><body><section id="capture"></section></body></html>',
  );
  const createdUrls = [];
  const revokedUrls = [];

  dom.window.URL.createObjectURL = (blob) => {
    assert.equal(blob.type, 'image/png');
    const url = `blob:test-${createdUrls.length + 1}`;
    createdUrls.push(url);
    return url;
  };
  dom.window.URL.revokeObjectURL = (url) => revokedUrls.push(url);

  t.after(() => dom.window.close());

  return { createdUrls, dom, revokedUrls };
}

test('captures an element and downloads the PNG through a temporary object URL', async (t) => {
  const { createdUrls, dom, revokedUrls } = installDom(t);
  const element = dom.window.document.querySelector('#capture');
  const options = { scale: 2, useCORS: true };
  let clickedAnchor;

  dom.window.HTMLAnchorElement.prototype.click = function click() {
    clickedAnchor = {
      connected: this.isConnected,
      download: this.download,
      href: this.href,
    };
  };

  const capture = async (capturedElement, capturedOptions) => {
    assert.equal(capturedElement, element);
    assert.equal(element.hasAttribute('data-png-capture'), true);
    assert.equal(capturedOptions, options);

    return {
      toBlob(callback, type) {
        assert.equal(type, 'image/png');
        callback(new dom.window.Blob(['png'], { type }));
      },
    };
  };

  await downloadElementAsPng(element, 'carte.png', options, capture);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

  assert.deepEqual(clickedAnchor, {
    connected: true,
    download: 'carte.png',
    href: 'blob:test-1',
  });
  assert.deepEqual(createdUrls, ['blob:test-1']);
  assert.deepEqual(revokedUrls, ['blob:test-1']);
  assert.equal(element.hasAttribute('data-png-capture'), false);
  assert.equal(dom.window.document.querySelectorAll('a').length, 0);
});

test('cleans up the capture state when rendering fails', async (t) => {
  const { dom } = installDom(t);
  const element = dom.window.document.querySelector('#capture');
  element.setAttribute('data-png-capture', 'existing');

  await assert.rejects(
    downloadElementAsPng(element, 'carte.png', {}, async () => {
      assert.equal(element.getAttribute('data-png-capture'), '');
      throw new Error('capture failed');
    }),
    /capture failed/,
  );

  assert.equal(element.getAttribute('data-png-capture'), 'existing');
  assert.equal(dom.window.document.querySelectorAll('a').length, 0);
});

test('rejects a canvas that cannot produce a PNG blob', async (t) => {
  const { createdUrls, dom, revokedUrls } = installDom(t);
  const element = dom.window.document.querySelector('#capture');

  await assert.rejects(
    downloadElementAsPng(element, 'carte.png', {}, async () => ({
      toBlob(callback) {
        callback(null);
      },
    })),
    /convertir la capture en image PNG/,
  );

  assert.deepEqual(createdUrls, []);
  assert.deepEqual(revokedUrls, []);
  assert.equal(element.hasAttribute('data-png-capture'), false);
});

test('routes all five public PNG exports through the shared guarded helper', async () => {
  const consumers = [
    '../client/pages/donnees/carte-historique/index.vue',
    '../client/pages/donnees/carte-commune/index.vue',
    '../client/components/donnees/AreaChart.vue',
    '../client/components/donnees/DepartementChart.vue',
    '../client/components/donnees/CommuneChart.vue',
  ];

  for (const path of consumers) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');

    assert.match(source, /await downloadElementAsPng\(/);
    assert.match(source, /if \(downloadingPng\.value\)/);
    assert.match(source, /pngDownloadError\.value = true/);
    assert.doesNotMatch(source, /import html2canvas/);
  }
});

test('keeps the DSFR date workaround active only during PNG capture', async () => {
  const css = await readFile(
    new URL('../client/assets/main.scss', import.meta.url),
    'utf8',
  );

  assert.match(
    css,
    /\[data-png-capture\] \.fr-input\[type='date'\]::after \{\s*content: none !important;/,
  );
});
