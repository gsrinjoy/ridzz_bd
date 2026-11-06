// Keeps the app itself available in dead zones. Map tiles are left to the
// browser's HTTP cache, which already stores them and adds nothing to their path.
const SHELL = 'shell-v4';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name !== SHELL) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          e.waitUntil(caches.open(SHELL).then((cache) => cache.put(e.request, copy)));
        }
        return res;
      })
      .catch(async () => (await caches.match(e.request)) ?? (await caches.match('/')) ?? Response.error()),
  );
});
