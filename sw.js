// sw.js — Service Worker for Local File Studio (offline-first PWA)
const CACHE_NAME = 'local-file-studio-v2';

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './styles.css',
  './engine.js',
  './app.js',
  './manifest.json',
  './libs/pdf-lib.min.js',
  './libs/pdf.min.mjs',
  './libs/pdf.worker.min.mjs',
  './libs/jszip.min.js',
  './libs/heic2any.min.js',
  './libs/UTIF.js',
  './libs/xlsx.full.min.js',
];

// Install: pre-cache all local assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

// Activate: purge old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: cache-first strategy for local assets
self.addEventListener('fetch', (event) => {
  // Only handle same-origin GET requests
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Only cache successful same-origin responses
        if (response.ok && new URL(event.request.url).origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback
        return new Response('Offline — asset not cached.', {
          status: 503,
          statusText: 'Service Unavailable',
        });
      });
    })
  );
});
