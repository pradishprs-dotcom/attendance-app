// Minimal service worker — required for Android "Add to Home Screen" install
// prompts. Intentionally does no offline caching yet: this app needs a live
// network connection to Firestore, so caching stale data would be worse than
// no caching. This just satisfies the installability requirement.
self.addEventListener('install', function(e){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ self.clients.claim(); });
self.addEventListener('fetch', function(e){ /* pass-through, no caching */ });
