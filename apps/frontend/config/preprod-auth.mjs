export function isProtectedPreproduction(environment = process.env) {
  const flag = environment.VIGIEAU_PREPROD_AUTH_ENABLED;
  if (![undefined, '', 'false', 'true'].includes(flag)) {
    throw new Error('VIGIEAU_PREPROD_AUTH_ENABLED must be true, false or unset.');
  }
  if (flag !== 'true') return false;
  if (environment.APP !== 'preservonsleau-front-preprod') {
    throw new Error('Preproduction authentication requires APP=preservonsleau-front-preprod.');
  }
  return true;
}

// Replace the formerly public app's worker when the browser next checks for an
// update. Only Workbox caches belonging to this registration scope are removed.
export const preprodTransitionServiceWorker = `self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const scope = self.registration.scope;
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter((name) => name.startsWith('workbox-') && name.endsWith(scope))
      .map((name) => caches.delete(name)));
    await self.registration.unregister();
    const windows = await self.clients.matchAll({ type: 'window' });
    await Promise.all(windows.map((client) => client.navigate(client.url)));
  })());
});
`;
