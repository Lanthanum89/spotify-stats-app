const CACHE_NAME = 'soundtracks-shell-v3'

// Resolve shell URLs relative to the service worker's own scope so this
// works whether the app is served from the domain root (local dev) or a
// subpath (e.g. GitHub Pages project sites).
const SHELL_FILES = ['', 'app.js', 'spotify-auth.js', 'style.css', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png']
const SHELL_URLS = SHELL_FILES.map((file) => new URL(file, self.registration.scope).pathname)

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

// Only the static shell is cacheable. Everything else — Spotify's own
// accounts.spotify.com/api.spotify.com calls — is cross-origin and never
// matches SHELL_URLS, so it always passes straight through to the network.
//
// Network-first: always prefer a fresh copy so a deploy is visible on the
// very next load, and only fall back to the cached shell when actually
// offline. (A cache-first/stale-while-revalidate strategy here previously
// let an old app.js and a new index.html get served together whenever
// CACHE_NAME wasn't bumped on a deploy, crashing on the DOM mismatch.)
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || !SHELL_URLS.includes(url.pathname)) return

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()))
        return response
      })
      .catch(() => caches.match(event.request)),
  )
})
