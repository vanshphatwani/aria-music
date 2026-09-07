const APP_CACHE = 'aria-app-v1';
const DOWNLOAD_CACHE = 'aria-downloads-v1';
const API_CACHE = 'aria-api-v1';
const FONT_CACHE = 'aria-fonts-v1';

const APP_SHELL = ['/', '/index.html', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) => Promise.all(APP_SHELL.map((u) => cache.add(u).catch(() => null))))
  );
});

self.addEventListener('activate', (event) => {
  const keep = [APP_CACHE, DOWNLOAD_CACHE, API_CACHE, FONT_CACHE];
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => (keep.includes(key) ? null : caches.delete(key)))))
      .then(() => self.clients.claim())
  );
});

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => { if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone()); return res; })
    .catch(() => null);
  if (cached) return cached;
  return (await network) || Response.error();
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'Offline and no cached data available.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(request, FONT_CACHE));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(request);
        if (res && res.ok) { const cache = await caches.open(APP_CACHE); cache.put(request, res.clone()); }
        return res;
      } catch {
        const cache = await caches.open(APP_CACHE);
        return (await cache.match(request)) || (await cache.match('/index.html')) || (await cache.match('/')) || Response.error();
      }
    })());
    return;
  }

  if (url.pathname.startsWith('/music/') || url.pathname.startsWith('/api/art/')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        if (url.pathname.startsWith('/api/art/') && url.search) {
          const plain = new URL(url.href);
          plain.search = '';
          return caches.match(plain.href).then((c2) => c2 || fetch(request));
        }
        return fetch(request);
      })
    );
    return;
  }

  if (url.pathname === '/api/songs' || url.pathname === '/api/playlists' || url.pathname === '/api/profiles' || url.pathname === '/api/mixes') {
    event.respondWith(networkFirst(request, API_CACHE));
    return;
  }

  if (url.pathname.startsWith('/api/')) return;

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request, APP_CACHE));
    return;
  }
});
