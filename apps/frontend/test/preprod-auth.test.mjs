import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { isProtectedPreproduction, preprodTransitionServiceWorker } from '../config/preprod-auth.mjs';
test('protects only the explicitly enabled public preproduction frontend', () => {
  assert.equal(isProtectedPreproduction({
    APP: 'preservonsleau-front-preprod', VIGIEAU_PREPROD_AUTH_ENABLED: 'true',
  }), true);
  for (const APP of [undefined, 'vigieau-front', 'preservonsleau-front', 'regleau-front-preprod']) {
    assert.throws(() => isProtectedPreproduction({ APP, VIGIEAU_PREPROD_AUTH_ENABLED: 'true' }),
      /requires APP=preservonsleau-front-preprod/);
  }
  for (const VIGIEAU_PREPROD_AUTH_ENABLED of [undefined, '', 'false']) {
    assert.equal(isProtectedPreproduction({
      APP: 'preservonsleau-front-preprod', VIGIEAU_PREPROD_AUTH_ENABLED,
    }), false);
  }
  for (const VIGIEAU_PREPROD_AUTH_ENABLED of ['1', 'TRUE', 'False', ' true ']) {
    assert.throws(() => isProtectedPreproduction({
      APP: 'preservonsleau-front-preprod', VIGIEAU_PREPROD_AUTH_ENABLED,
    }), /must be true, false or unset/);
  }
});

test('transition worker removes only its Workbox caches, unregisters and reloads controlled tabs', async () => {
  const listeners = new Map();
  const deleted = [];
  const navigations = [];
  const lifecycle = [];
  const scope = 'https://vigieau.incubateur.net/';
  runInNewContext(preprodTransitionServiceWorker, {
    self: {
      addEventListener: (event, listener) => listeners.set(event, listener),
      skipWaiting: async () => lifecycle.push('skip-waiting'),
      registration: { scope, unregister: async () => lifecycle.push('unregister') },
      clients: { matchAll: async () => [{
        url: `${scope}carte`, navigate: async url => navigations.push(url),
      }] },
    },
    caches: {
      keys: async () => [
        `workbox-precache-v2-${scope}`, `workbox-runtime-${scope}`,
        'unrelated-cache', `custom-${scope}`, `workbox-precache-v2-${scope}other/`,
      ],
      delete: async name => deleted.push(name),
    },
  });
  for (const event of ['install', 'activate']) {
    let completion;
    listeners.get(event)({ waitUntil: promise => { completion = promise; } });
    await completion;
  }
  assert.deepEqual(deleted, [`workbox-precache-v2-${scope}`, `workbox-runtime-${scope}`]);
  assert.deepEqual(lifecycle, ['skip-waiting', 'unregister']);
  assert.deepEqual(navigations, [`${scope}carte`]);
  assert.equal(listeners.has('fetch'), false);
});
