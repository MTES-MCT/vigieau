import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isPwaNetworkOnlyUrl,
  pwaNavigationFallbackDenylist,
} from '../client/utils/pwa-cache-policy.ts';

test('keeps APIs, publication manifests and PMTiles out of Workbox caches', () => {
  assert.equal(isPwaNetworkOnlyUrl('https://api.example.test/api/zones'), true);
  assert.equal(
    isPwaNetworkOnlyUrl('https://api.vigieau.beta.gouv.fr/departements'),
    true,
  );
  assert.equal(
    isPwaNetworkOnlyUrl('https://api.example.test/zones/publication'),
    true,
  );
  assert.equal(
    isPwaNetworkOnlyUrl('https://objects.example.test/zones/current.pmtiles'),
    true,
  );
  assert.equal(isPwaNetworkOnlyUrl('/manifest.webmanifest'), true);
  assert.equal(isPwaNetworkOnlyUrl('/carte'), false);
});

test('never serves the application shell for data or static-file requests', () => {
  const denied = (path) =>
    pwaNavigationFallbackDenylist.some((pattern) => pattern.test(path));

  assert.equal(denied('/api/zones'), true);
  assert.equal(denied('/zones/publication'), true);
  assert.equal(denied('/maps/zones.pmtiles'), true);
  assert.equal(denied('/inject-sw.js'), true);
  assert.equal(denied('/carte'), false);
});
