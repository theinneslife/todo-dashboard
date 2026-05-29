// ===== TravelFlo Service Worker =====
// CACHE_VERSION: bump this string any time you deploy a new build.
// Changing it (even by one character) triggers the browser to install
// the new SW and delete the old cache, so mobile devices stop serving
// stale HTML/JS/CSS from the previous version.
const CACHE_VERSION = 'travelflow-v7';

// NOTE: Do NOT precache './' or './index.html' — those resolve to the TaskFlo
// dashboard, which is a separate app that must always load fresh data. This SW
// is registered by travelflo.html but its scope ('/todo-dashboard/') leaks onto
// every page on the origin, so it must stay strictly hands-off the TaskFlo app
// and all live JSON data files (see the .json bypass in the fetch handler).
const PRECACHE_URLS = [
  './travelflow.html',
  './travelflo.html',
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

  // Never touch live JSON data (tasks.json, strava_data.json, coach_briefing.json,
  // trips.json, visited_places.json, etc.). Letting these fall through to the
  // network means they always load fresh AND never bloat the cache. Previously
  // these were cached cache-first with unique ?t= busters, accumulating one
  // permanent entry per auto-refresh until the storage quota filled and cache
  // ops threw — which broke the tasks.json fetch and left dashboards empty.
  if (url.pathname.endsWith('.json')) return;

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
