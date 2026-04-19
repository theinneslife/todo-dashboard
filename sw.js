// ===== TravelFlo Service Worker =====
// CACHE_VERSION: bump this string any time you deploy a new build.
// Changing it (even by one character) triggers the browser to install
// the new SW and delete the old cache, so mobile devices stop serving
// stale HTML/JS/CSS from the previous version.
const CACHE_VERSION = 'travelflow-v5';

const PRECACHE_URLS = [
  './',
  './travelflow.html',
  './travelflo.html',
  './index.html',
];

// ── Install: cache core files ──────────────────────────────────────────────
self.addEventListener('install', event => {
  // Skip waiting so the new SW activates immediately (no tab-close needed)
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      // Use individual adds so a single 404 doesn't break the whole install
      return Promise.allSettled(
        PRECACHE_URLS.map(url => cache.add(url).catch(() => {}))
      );
    })
  );
});

// ── Activate: delete caches from any previous version ─────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim()) // take control of open pages immediately
  );
});

// ── Fetch: network-first for HTML, cache-first for everything else ─────────
// Network-first for HTML means changes to travelflow.html show up on next
// reload even without a SW version bump. Other assets (fonts, etc.) are
// cache-first for speed.
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests; let GitHub API calls through
  if (url.origin !== self.location.origin) return;

  const isHTML = request.destination === 'document' ||
                 url.pathname.endsWith('.html') ||
                 url.pathname === '/';

  if (isHTML) {
    // Network-first: always try to get fresh HTML, fall back to cache
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            // Update the cached copy while we're here
            const clone = response.clone();
            caches.open(CACHE_VERSION).then(c => c.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
  } else {
    // Cache-first for non-HTML assets
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then(c => c.put(request, clone));
          }
          return response;
        });
      })
    );
  }
});
