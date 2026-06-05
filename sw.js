const CACHE = 'iocontrol-v1';
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './css/scanner.css',
  './css/irrigengine.css',
  './js/app.js',
  './js/settings.js',
  './js/scanner.js',
  './js/irrigengine.js',
  './manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('/api/') || e.request.url.includes('/events')) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
