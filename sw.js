const CACHE_PREFIX = 'rockwelltools-web-v';
const CACHE = `${CACHE_PREFIX}0.1.3`;
const SHELL = [
  './',
  './index.html',
  './styles.css?v=0.1.3',
  './app.js?v=0.1.3',
  './manifest.webmanifest?v=0.1.3',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Cross-origin requests are always left to the browser. In particular, the
  // service worker never intercepts GitHub/CDN responses or converts failures.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: 'no-store' });
        if (response?.ok) (await caches.open(CACHE)).put('./index.html', response.clone()).catch(() => {});
        return response;
      } catch {
        return (await caches.match('./index.html')) || new Response('RockwellTools 离线且应用外壳尚未缓存。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  // Model must be served by this website. Cache only a successful model, never
  // a 404/error response. Network-first also lets a corrected deployment replace
  // an old failure immediately, while retaining offline use after one success.
  if (url.pathname.endsWith('/models/u2netp.onnx')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request, { cache: 'no-store' });
        if (response?.ok) cache.put(request, response.clone()).catch(() => {});
        return response;
      } catch {
        return (await cache.match(request)) || new Response('AI model unavailable.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response?.ok) (await caches.open(CACHE)).put(request, response.clone()).catch(() => {});
      return response;
    } catch {
      return new Response('Resource unavailable while offline.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
