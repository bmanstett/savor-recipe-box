const CACHE_NAME = 'savor-static-v6';
const BASE = new URL(self.registration.scope).pathname.replace(/\/$/, '');
const scoped = (path = '') => `${BASE}/${path}`;
const BUILD_ASSETS = [
  /* __SAVOR_BUILD_ASSETS__ */
];
const SHELL_ASSETS = [
  scoped(),
  scoped('manifest.webmanifest'),
  scoped('icons/icon-192.png'),
  scoped('icons/icon-512.png'),
  scoped('icons/icon-maskable-512.png'),
  ...BUILD_ASSETS.map(scoped),
];
// Demo photos are nice to have offline but must never block an install.
const OPTIONAL_ASSETS = [
  'recipes/lemon-chicken.jpg', 'recipes/tuscan-pasta.jpg', 'recipes/salmon-bowl.jpg', 'recipes/chicken-tacos.jpg',
  'recipes/tomato-soup.jpg', 'recipes/bean-salad.jpg', 'recipes/banana-bread.jpg',
].map(scoped);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then(async (cache) => {
    // The HTML must be fetched fresh: a CDN-cached index.html would pair the
    // previous build's script names with this worker's asset list.
    await cache.addAll(SHELL_ASSETS.map((path) => new Request(path, { cache: path === scoped() ? 'reload' : 'default' })));
    await Promise.allSettled(OPTIONAL_ASSETS.map((path) => cache.add(path)));
  }));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    // Hashed bundles from earlier builds share this cache name; drop anything
    // the current shell no longer references so old builds do not pile up.
    const cache = await caches.open(CACHE_NAME);
    const keep = new Set(SHELL_ASSETS.map((path) => new URL(path, self.location.origin).href));
    const cached = await cache.keys();
    await Promise.all(cached
      .filter((request) => /\/assets\//.test(new URL(request.url).pathname) && !keep.has(request.url))
      .map((request) => cache.delete(request)));
  })());
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(`${BASE}/`)) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(scoped(), response.clone()));
      return response;
    }).catch(() => caches.match(scoped())));
    return;
  }

  if (/\.(?:js|css|png|jpg|jpeg|webp|woff2?|webmanifest)$/.test(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok && response.type === 'basic') caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
      return response;
    })));
  }
});
