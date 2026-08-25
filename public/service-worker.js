// Minimal service worker - just enough to satisfy PWA installability
// requirements (Chrome/Android requires an active service worker before
// it'll offer the "Install app" prompt). This app is mostly real-time and
// account-specific, so we intentionally do NOT cache API responses or
// pages - caching stale feeds/messages would be actively confusing.
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    self.clients.claim();
});

// Pass-through fetch handler - required for installability but doesn't
// intercept or cache anything, so the app always gets fresh data.
self.addEventListener('fetch', (event) => {
    event.respondWith(fetch(event.request));
});
