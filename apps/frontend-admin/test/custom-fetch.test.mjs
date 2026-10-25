import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { isReactive } from 'vue';

const alerts = [];
globalThis.__customFetchTestAlerts = alerts;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '~/stores/alert') {
      return {
        url: `data:text/javascript,${encodeURIComponent('export const useAlertStore = () => ({ addAlert: (alert) => globalThis.__customFetchTestAlerts.push(alert) });')}`,
        shortCircuit: true,
      };
    }
    if (specifier.startsWith('~/')) {
      return nextResolve(new URL(`../client/${specifier.slice(2)}.ts`, import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { useCustomFetch } = await import('../client/composables/useCustomFetch.ts');
const { VigiEauApi } = await import('../client/api/vigieau.ts');
hooks.deregister();

async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${server.address().port}/api`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('identical GET calls perform fresh requests and retain independent deeply reactive refs', async () => {
  let calls = 0;
  await withServer((request, response) => {
    assert.equal(request.url, '/api/users');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ revision: ++calls, users: [{ role: 'departement' }] }));
  }, async (baseURL) => {
    const first = await useCustomFetch('/users', { baseURL, credentials: 'include' });
    const second = await useCustomFetch('/users', { baseURL, credentials: 'include' });
    assert.equal(calls, 2);
    assert.equal(first.data.value.revision, 1);
    assert.equal(second.data.value.revision, 2);
    assert.ok(isReactive(first.data.value.users[0]));
    first.data.value.users.push({ role: 'mte' });
    assert.equal(second.data.value.users.length, 1);
    assert.equal(first.error.value, null);
  });
});

test('identical mutations preserve headers and bodies and execute twice', async () => {
  const requests = [];
  await withServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, token: request.headers['x-request-check'], body: JSON.parse(body) });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ revision: requests.length }));
  }, async (baseURL) => {
    const options = { baseURL, method: 'PATCH', headers: { 'x-request-check': 'local-test' }, body: { role: 'mte' } };
    const first = await useCustomFetch('/users/example', options);
    const second = await useCustomFetch('/users/example', options);
    assert.equal(first.data.value.revision, 1);
    assert.equal(second.data.value.revision, 2);
    assert.deepEqual(requests, Array.from({ length: 2 }, () => ({ method: 'PATCH', token: 'local-test', body: { role: 'mte' } })));
  });
});

test('API errors preserve response details and the existing formatted alert', async () => {
  alerts.length = 0;
  await withServer((request, response) => {
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: ['Champ obligatoire', 'Champ obligatoire', 'Publication refusee'] }));
  }, async (baseURL) => {
    const result = await useCustomFetch('/orders', { baseURL, method: 'POST' });
    assert.equal(result.data.value, null);
    assert.equal(result.error.value.statusCode, 400);
    assert.deepEqual(result.error.value.data.message, ['Champ obligatoire', 'Champ obligatoire', 'Publication refusee']);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].type, 'error');
    assert.match(alerts[0].description, /Champ obligatoire, Publication refusee/);
  });
});

test('failed mutations are not automatically retried and alerts can remain suppressed', async () => {
  alerts.length = 0;
  let calls = 0;
  await withServer((request, response) => {
    calls++;
    response.writeHead(503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'Unavailable' }));
  }, async (baseURL) => {
    const result = await useCustomFetch('/orders', { baseURL, method: 'POST' }, 10000, false);
    assert.equal(result.error.value.statusCode, 503);
    assert.equal(calls, 1);
    assert.equal(alerts.length, 0);
  });
});

test('the requested timeout is enforced and returned as an error', async () => {
  alerts.length = 0;
  await withServer(() => {}, async (baseURL) => {
    const result = await useCustomFetch('/slow', { baseURL, retry: false }, 25);
    assert.equal(result.data.value, null);
    assert.match(result.error.value.message, /timeout|timed out/i);
    assert.equal(alerts.length, 1);
  });
});

test('public zone lookups use their configured API, refetch the same commune and do not display admin alerts', async () => {
  alerts.length = 0;
  let calls = 0;
  await withServer((request, response) => {
    calls++;
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/zones?commune=unknown') {
      response.writeHead(400);
      response.end(JSON.stringify({ message: 'Commune inconnue' }));
      return;
    }
    assert.equal(request.url, '/api/zones?commune=2A004');
    setTimeout(() => response.end(JSON.stringify({ revision: calls })), 25);
  }, async (baseURL) => {
    globalThis.useRuntimeConfig = () => ({ public: { apiSecheresseUrl: baseURL } });
    try {
      const api = new VigiEauApi();
      const first = await api.getZonesByCommune('2A004');
      const second = await api.getZonesByCommune('2A004');
      assert.equal(calls, 2);
      assert.equal(first.data.value.revision, 1);
      assert.equal(second.data.value.revision, 2);
      const missing = await api.getZonesByCommune('unknown');
      assert.equal(missing.error.value.statusCode, 400);
      assert.equal(alerts.length, 0);
    } finally {
      delete globalThis.useRuntimeConfig;
    }
  });
});
