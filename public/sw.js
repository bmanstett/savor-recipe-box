const CACHE_NAME = 'savor-static-v3';
const BASE = new URL(self.registration.scope).pathname.replace(/\/$/, '');
const scoped = (path = '') => `${BASE}/${path}`;
const SHELL_ASSETS = [
  scoped(),
  scoped('manifest.webmanifest'),
  scoped('icons/icon-192.png'),
  scoped('icons/icon-512.png'),
  scoped('recipes/lemon-chicken.jpg'),
  scoped('recipes/tuscan-pasta.jpg'),
  scoped('recipes/salmon-bowl.jpg'),
  scoped('recipes/chicken-tacos.jpg'),
  scoped('recipes/tomato-soup.jpg'),
  scoped('recipes/bean-salad.jpg'),
  scoped('recipes/banana-bread.jpg'),
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))));
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
