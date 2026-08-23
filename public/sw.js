const CACHE_NAME = 'savor-shell-v2';
const PRIVATE_SHELL_KEY = '/__savor-private-shell';
const SHELL_ASSETS = [
  '/offline',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/recipes/lemon-chicken.jpg',
  '/recipes/tuscan-pasta.jpg',
  '/recipes/salmon-bowl.jpg',
  '/recipes/chicken-tacos.jpg',
  '/recipes/tomato-soup.jpg',
  '/recipes/bean-salad.jpg',
  '/recipes/banana-bread.jpg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'CLEAR_PRIVATE_CACHE') {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.delete(PRIVATE_SHELL_KEY)));
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/signin-') || url.pathname.startsWith('/signout-') || url.pathname === '/callback') return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok && url.pathname === '/') {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(PRIVATE_SHELL_KEY, copy));
      }
      return response;
    }).catch(async () => (await caches.match(PRIVATE_SHELL_KEY)) ?? caches.match('/offline')));
    return;
  }

  if (/\.(?:js|css|png|jpg|jpeg|webp|woff2?|webmanifest)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((response) => {
        if (!response.ok || response.type !== 'basic') return response;
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      })),
    );
  }
});
