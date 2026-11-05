import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { isProtectedPreproduction, preprodTransitionServiceWorker } from '../config/preprod-auth.mjs';
import {
  isPreprodAuthenticationError,
  preprodAuthenticationRequired,
  preprodLoginUrl,
  publicApiRequestOptions,
} from '../client/utils/preprod-auth.ts';

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

test('recognizes only the preproduction gateway JSON 401, preserving business JWT failures', () => {
  assert.equal(isPreprodAuthenticationError({
    statusCode: 401, data: { error: 'preprod_auth_required' },
  }), true);
  assert.equal(isPreprodAuthenticationError({
    response: { status: 401, _data: { error: 'preprod_auth_required' } },
  }), true);
  for (const failure of [
    null, new Error('network failure'),
    { statusCode: 401, data: { message: 'Unauthorized', statusCode: 401 } },
    { statusCode: 401, data: { error: 'Unauthorized', message: 'Expired subscription JWT', statusCode: 401 } },
    { statusCode: 401, data: {} },
    { statusCode: 401, data: { error: 'Unauthorized' } },
    { statusCode: 401, data: { error: 'preprod_auth_required', message: 'Invalid token' } },
    { statusCode: 403, data: { error: 'Forbidden' } },
    { statusCode: 401, data: [] },
    { statusCode: 401, data: null },
    { statusCode: 401 },
    { statusCode: 401, data: '<html>unauthorized</html>' },
    { statusCode: 500, data: { error: 'preprod_auth_required' } },
  ]) assert.equal(isPreprodAuthenticationError(failure), false);
});

test('keeps request behavior unchanged unless protected preproduction is enabled', () => {
  assert.deepEqual(publicApiRequestOptions({ apiSecheresseUrl: 'https://api.example.test/api' }), {
    baseURL: 'https://api.example.test/api',
  });
  const options = publicApiRequestOptions({ apiSecheresseUrl: '/api', preprodAuthEnabled: true });
  preprodAuthenticationRequired.value = false;
  options.onResponseError({ response: {
    status: 401, _data: { message: 'Unauthorized', statusCode: 401 },
  } });
  assert.equal(preprodAuthenticationRequired.value, false);
  options.onResponseError({ response: { status: 401, _data: { error: 'preprod_auth_required' } } });
  assert.equal(preprodAuthenticationRequired.value, true);
  preprodAuthenticationRequired.value = false;
});

test('login preserves a local route, query and fragment without accepting an external redirect', () => {
  const path = '/abonnements?token=subscription-token&source=test#result';
  const login = new URL(preprodLoginUrl(path), 'https://vigieau.incubateur.net');
  assert.equal(login.pathname, '/_preprod/login');
  assert.equal(login.searchParams.get('rd'), path);
  for (const unsafe of [
    '', '//evil.example/path', 'https://evil.example/', 'javascript:alert(1)',
    '/\\evil.example/', '/%2f%2fevil.example/', '/%5cevil.example/',
    '/_preprod/login?rd=//evil.example', '/_preprod/logout', '/%invalid', '/\n/evil.example',
    '/%0d%0a/evil.example',
  ]) {
    assert.equal(new URL(preprodLoginUrl(unsafe), login.origin).searchParams.get('rd'), '/', unsafe);
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
