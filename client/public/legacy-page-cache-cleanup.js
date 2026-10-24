// Route-level code splitting was removed (pages are statically imported now),
// so this drops the page-chunk runtime cache left behind by older service
// workers. cleanupOutdatedCaches only handles workbox precache entries, which
// is why this listener has to remove the cache by name.
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.delete('la-pluma-page-chunks'))
})
