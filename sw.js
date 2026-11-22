// Service worker: laat de app openen als een echte app, ook bij slechte verbinding.
// Strategie: eerst het netwerk (altijd de nieuwste versie), anders de opgeslagen kopie.
// Alleen de eigen app-bestanden; streams en lijsten worden nooit opgeslagen.
const CACHE = 'iptv-cast-v2-dev-680b3d3';
const FILES = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (/\/(api|p|m3u8)$/.test(url.pathname) || url.pathname.includes('/subs/')) return; // dev-server
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }) // altijd bij de server nagaan of er een nieuwere versie is
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
