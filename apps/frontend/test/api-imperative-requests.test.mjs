import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createFetch } from 'ofetch';
import ts from 'typescript';
import { ref } from 'vue';
import { fetchAsRefResponse } from '../client/utils/fetch-response.ts';
import * as zonePublication from '../client/utils/zone-publication.ts';
import * as preprodAuth from '../client/utils/preprod-auth.ts';

const source = readFileSync(new URL('../client/api/index.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});

function createApi(request, config = {}) {
  const exports = {};
  const imports = {
    ofetch: { $fetch: request },
    vue: { ref },
    '../store/zonePublication': {},
    '../utils/fetch-response': { fetchAsRefResponse },
    '../utils/preprod-auth': preprodAuth,
    '../utils/zone-publication': zonePublication,
    '../utils/zone-availability': {},
  };
  runInNewContext(outputText, {
    exports,
    require(id) {
      assert.ok(Object.hasOwn(imports, id), `Unexpected API dependency: ${id}`);
      return imports[id];
    },
    URLSearchParams,
    useRuntimeConfig: () => ({ public: {
      apiSecheresseUrl: 'http://localhost/api',
      apiAdresseUrl: 'http://localhost/api',
      apiGeoUrl: 'http://localhost/api',
      ...config,
    } }),
    useFetch() {
      throw new Error('Explicit requests must not reuse Nuxt async-data cache');
    },
  });
  return exports.default;
}

test('protected API reports an expired proxy session and preserves subscription Authorization', async () => {
  for (const [body, requiresLogin] of [
    [{ error: 'preprod_auth_required' }, true],
    [{}, false],
    [{ error: 'Unauthorized' }, false],
    [{ message: 'Unauthorized', statusCode: 401 }, false],
  ]) {
    preprodAuth.preprodAuthenticationRequired.value = false;
    const api = createApi(createFetch({
      fetch: async (url, options) => {
        assert.equal(url, '/api/subscriptions');
        assert.equal(options.headers.get('Authorization'), 'Bearer business-jwt');
        return new Response(JSON.stringify(body), {
          status: 401, headers: { 'Content-Type': 'application/json' },
        });
      },
    }), { apiSecheresseUrl: '/api', preprodAuthEnabled: true });
    const result = await api.getUserSubscriptions('business-jwt');
    assert.equal(result.error.value.statusCode, 401);
    assert.equal(preprodAuth.preprodAuthenticationRequired.value, requiresLogin);
  }
  preprodAuth.preprodAuthenticationRequired.value = false;
});

test('external address lookup does not trigger preproduction login handling', async () => {
  preprodAuth.preprodAuthenticationRequired.value = false;
  const api = createApi(createFetch({
    fetch: async () => new Response(JSON.stringify({ error: 'preprod_auth_required' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    }),
  }), { apiSecheresseUrl: '/api', preprodAuthEnabled: true });
  await api.searchAddressByLatlon('2.3', '48.8');
  assert.equal(preprodAuth.preprodAuthenticationRequired.value, false);
});

for (const [method, args, path] of [
  ['getDataArea', ['2026-08-01', '2026-08-31', 'departement=01', true], '/data/area?departement=01&dateDebut=2026-08-01&dateFin=2026-08-31&includeProvisional=true'],
  ['getDataDepartement', ['2026-08-01', '2026-08-31', 'departement=01', true], '/data/departement?departement=01&dateDebut=2026-08-01&dateFin=2026-08-31&includeProvisional=true'],
  ['getDataCommune', ['75107', '2026-08-01', '2026-08-31', true], '/data/commune/75107?dateDebut=2026-08-01&dateFin=2026-08-31&includeProvisional=true'],
  ['getDataStatus', [], '/data/status'],
  ['getDataDuree', [], '/data/duree'],
  ['getArretesRestrictions', ['2026-08-01', 'departement=01'], '/arretes_restrictions?date=2026-08-01&departement=01'],
  ['getDepartmentsData', ['2026-08-01', 'departement=01', { publicationId: 'publication-test' }], '/departements?departement=01&date=2026-08-01&publicationId=publication-test'],
  ['getRefData', [], '/data'],
  ['searchAddresses', ['Paris', true], '/search/?q=Paris&limit=10&type=housenumber'],
  ['searchAddressByLatlon', ['2.3', '48.8'], '/reverse?lon=2.3&lat=48.8'],
  ['searchGeoByLatlon', ['2.3', '48.8'], '/communes?lon=2.3&lat=48.8'],
  ['getUserSubscriptions', ['test-token'], '/subscriptions'],
]) {
  test(`${method} requests fresh data again after a successful HTTP response`, async () => {
    const responses = [{ fresh: false }, undefined, { fresh: true }];
    let requests = 0;
    const api = createApi(async (url, options) => {
      assert.equal(url, path);
      assert.equal(options.method, 'GET');
      assert.equal(options.baseURL, 'http://localhost/api');
      return responses[requests++];
    });

    const initial = await api[method](...args);
    const empty = await api[method](...args);
    const refreshed = await api[method](...args);

    assert.equal(requests, 3);
    assert.deepEqual(initial.data.value, { fresh: false });
    assert.equal(initial.error.value, null);
    assert.equal(empty.data.value, undefined);
    assert.equal(empty.error.value, null);
    assert.deepEqual(refreshed.data.value, { fresh: true });
    assert.equal(refreshed.error.value, null);
    assert.notEqual(initial.data, refreshed.data);
  });
}

test('imperative address search preserves municipality label formatting', async () => {
  const features = [
    { properties: { type: 'municipality', label: 'Paris', citycode: '75056' } },
    { properties: { type: 'municipality', label: 'Saint-Denis', citycode: '97411' } },
    { properties: { type: 'housenumber', label: '20 avenue de Segur', citycode: '75107' } },
  ];
  const api = createApi(createFetch({
    fetch: async () => new Response(JSON.stringify({ type: 'FeatureCollection', features }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  }));

  const response = await api.searchAddresses('Paris');

  assert.equal(response.error.value, null);
  assert.equal(response.data.value.type, 'FeatureCollection');
  assert.deepEqual(Array.from(response.data.value.features, feature => feature.properties.label), [
    'Paris, 75', 'Saint-Denis, 974', '20 avenue de Segur',
  ]);
});

test('address geocoding preserves ampersands, plus signs and fragments in its query', async () => {
  const address = '12 rue A & B + C #1';
  const api = createApi(async (url) => {
    const parsed = new URL(url, 'http://localhost');
    assert.equal(parsed.searchParams.get('q'), address);
    assert.equal(parsed.searchParams.get('limit'), '10');
    assert.equal(parsed.hash, '');
    return {};
  });
  const result = await api.searchAddresses(address);
  assert.equal(result.error.value, null);
});

test('statistic refresh retains HTTP errors without poisoning the next request', async () => {
  const failure = { statusCode: 503 };
  let requests = 0;
  const api = createApi(async () => {
    if (++requests === 1) throw failure;
    return { status: 'ready' };
  });

  const initial = await api.getDataStatus();
  const refreshed = await api.getDataStatus();

  assert.equal(initial.data.value, null);
  assert.deepEqual(initial.error.value, failure);
  assert.deepEqual(refreshed.data.value, { status: 'ready' });
  assert.equal(refreshed.error.value, null);
  assert.equal(requests, 2);
});

for (const [method, args, verb, path, body] of [
  ['subscribeMail', [{ email: 'test@example.test', commune: '75107', unused: '' }], 'POST', '/subscriptions', { email: 'test@example.test', commune: '75107' }],
  ['signalRestriction', [101, 'Clarification'], 'POST', '/usage/feedback/101', { feedback: 'Clarification' }],
  ['unsubscribe', [101, 'test-token'], 'DELETE', '/subscriptions/101'],
  ['unsubscribeAll', ['test-token'], 'DELETE', '/subscriptions'],
  ['requestSubscriptionManagementLink', ['test@example.test'], 'POST', '/subscriptions/management-link', { email: 'test@example.test' }],
]) {
  test(`${method} sends identical actions again and never retries a failed mutation`, async () => {
    let requests = 0;
    const request = createFetch({
      async fetch(url, options) {
        requests += 1;
        assert.equal(url, `http://localhost/api${path}`);
        assert.equal(options.method, verb);
        if (body) assert.deepEqual(JSON.parse(options.body), body);
        if (verb === 'DELETE') {
          assert.equal(options.headers.get('Authorization'), 'Bearer test-token');
        }
        return new Response(JSON.stringify({ attempt: requests }), {
          status: requests === 3 ? 503 : 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    const api = createApi(request);

    const first = await api[method](...args);
    const repeated = await api[method](...args);
    const failed = await api[method](...args);
    const recovered = await api[method](...args);

    assert.deepEqual(first.data.value, { attempt: 1 });
    assert.deepEqual(repeated.data.value, { attempt: 2 });
    assert.equal(failed.data.value, null);
    assert.equal(failed.error.value.statusCode, 503);
    assert.deepEqual(recovered.data.value, { attempt: 4 });
    assert.equal(recovered.error.value, null);
    assert.equal(requests, 4);
  });
}

test('subscription payload preserves zero coordinates and never changes the live form', async () => {
  const form = {
    email: 'test@example.test', lon: 0, lat: 0, commune: null,
    idAdresse: undefined, unused: '', confirmSubscription: true,
  };
  const before = { ...form };
  const api = createApi(async (_url, options) => {
    assert.deepEqual(JSON.parse(JSON.stringify(options.body)), {
      email: 'test@example.test', lon: 0, lat: 0, confirmSubscription: true,
    });
    throw Object.assign(new Error('Service unavailable'), { statusCode: 503 });
  });

  await api.subscribeMail(form);
  assert.deepEqual(form, before);
});
