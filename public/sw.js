// SoundTracks service worker — caches the static app shell only.
//
// Spotify data is never cached here: every accounts.spotify.com /
// api.spotify.com request is cross-origin and passes straight through to the
// network. (Last-known dashboard data lives in snapshot.js, not the cache.)
//
// LIFECYCLE
//   install   → precache the whole shell into a cache named after BUILD_ID,
//               all-or-nothing. Does NOT skipWaiting, so a new version waits
//               until the user chooses "Update" in the app.
//   message   → { type: 'SKIP_WAITING' } from the page activates the waiting
//               worker; the page reloads once it takes control (pwa.js).
//   activate  → delete obsolete SoundTracks caches, claim open pages.
//   fetch     → serve the shell from THIS version's cache only, so an
//               index.html, app.js and style.css from different deploys can
//               never be mixed.
//
// VERSIONING
//   BUILD_ID is stamped with the commit SHA by .github/workflows/pages.yml on
//   every deploy, so nothing needs bumping by hand. While it is the literal
//   'dev' (local development, or a deploy where stamping failed) the worker
//   uses network-first so edits are visible and nothing can go stale.
//   To test the update flow locally, change 'dev' to any other string and
//   change it again to simulate a new release.
const BUILD_ID = 'dev'

// Only touch caches with these prefixes: GitHub Pages serves every project
// site from one origin, so other apps' caches must be left alone.
const SHELL_CACHE_PREFIX = 'soundtracks-shell-'
const FONT_CACHE = 'soundtracks-fonts-v1'
const SHELL_CACHE = SHELL_CACHE_PREFIX + BUILD_ID
const NETWORK_FIRST = BUILD_ID === 'dev'

// Resolved against the worker's own scope, so this works from a domain root
// (local dev) and from a subpath (GitHub Pages project site) alike.
const SHELL_FILES = [
  '',
  'app.js',
  'spotify-auth.js',
  'snapshot.js',
  'notices.js',
  'pwa.js',
  'style.css',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
]
const SHELL_URLS = SHELL_FILES.map((file) => new URL(file, self.registration.scope).pathname)
const SCOPE_ROOT = new URL('', self.registration.scope).pathname
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com']

self.addEventListener('install', (event) => {
  // `cache: 'reload'` bypasses the browser's HTTP cache, which GitHub Pages
  // fills with several minutes of max-age — without it a fresh worker could
  // precache the previous deploy's files.
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS.map((url) => new Request(url, { cache: 'reload' })))),
  )
})

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(SHELL_CACHE_PREFIX) && key !== SHELL_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(fontResponse(request))
    return
  }

  if (url.origin !== self.location.origin) return

  // The OAuth redirect arrives as `<scope>?code=…&state=…`, so navigations
  // are matched to the cached shell ignoring the query string.
  const isNavigation = request.mode === 'navigate' && url.pathname === SCOPE_ROOT
  if (!isNavigation && !SHELL_URLS.includes(url.pathname)) return

  event.respondWith(NETWORK_FIRST ? networkFirst(request, isNavigation) : cacheOnly(request, isNavigation))
})

async function cacheOnly(request, isNavigation) {
  const cache = await caches.open(SHELL_CACHE)
  const cached = await cache.match(isNavigation ? SCOPE_ROOT : request, { ignoreSearch: isNavigation })
  return cached || fetch(request)
}

async function networkFirst(request, isNavigation) {
  const cache = await caches.open(SHELL_CACHE)
  try {
    const response = await fetch(request, { cache: 'reload' })
    if (response.ok && !isNavigation) cache.put(request, response.clone())
    if (response.ok && isNavigation) cache.put(SCOPE_ROOT, response.clone())
    return response
  } catch (err) {
    const cached = await cache.match(isNavigation ? SCOPE_ROOT : request, { ignoreSearch: isNavigation })
    if (cached) return cached
    throw err
  }
}

// Google Fonts: serve from cache when there is one and refresh it in the
// background, so the mono/sans typography survives an offline reopen.
async function fontResponse(request) {
  const cache = await caches.open(FONT_CACHE)
  const cached = await cache.match(request)
  const refresh = fetch(request)
    .then((response) => {
      if (response.ok || response.type === 'opaque') cache.put(request, response.clone())
      return response
    })
    .catch(() => cached || Response.error())
  return cached || refresh
}
