// Shared helpers for the browser regression tests (tests/e2e/regression.test.js).
//
// - serves public/ beneath /spotify-stats-app/ (the GitHub Pages project
//   subpath) on a random port, optionally stamping the service worker BUILD_ID
// - mocks Spotify's API and token/authorise endpoints, so no real account,
//   token or listening data is ever involved
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'public');
const BASE = '/spotify-stats-app/';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

function startServer() {
  const state = { buildId: 'dev', requests: [] };
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    state.requests.push(urlPath);
    if (!urlPath.startsWith(BASE)) { res.writeHead(404); return res.end('not found'); }
    const file = path.join(ROOT, urlPath.slice(BASE.length) || 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      if (file.endsWith('sw.js')) data = Buffer.from(String(data).replace("const BUILD_ID = 'dev'", `const BUILD_ID = '${state.buildId}'`));
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'max-age=600' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, () => {
    const port = server.address().port;
    resolve({ state, url: `http://localhost:${port}${BASE}`, close: () => server.close() });
  }));
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const EVIL = `<img src=x onerror="window.__pwned=(window.__pwned||0)+1"><b id=inj>"'&`;
const EVIL_URL = 'javascript:window.__pwned=(window.__pwned||0)+1';

function makeData(evil) {
  const name = (n, base) => (evil ? EVIL + n : `${base} ${n}`);
  const url = (u) => (evil ? EVIL_URL : u);
  const images = [{ url: evil ? EVIL_URL : 'https://i.scdn.co/image/x' }];
  const track = (n) => ({
    id: `t${n}`, name: name(n, 'Track'), duration_ms: 200000, popularity: 60, preview_url: evil ? EVIL_URL : null,
    external_urls: { spotify: url(`https://open.spotify.com/track/t${n}`) }, artists: [{ id: 'a', name: name('', 'Artist') }],
    album: { name: name('', 'Album'), images, external_urls: { spotify: url('https://open.spotify.com/album/x') }, release_date: '2020-01-01', total_tracks: 3 }
  });
  const artist = (n) => ({
    id: `a${n}`, name: name(n, 'Artist'), genres: [evil ? EVIL : 'pop', 'rock'], popularity: 70, followers: { total: 999 },
    images, external_urls: { spotify: url('https://open.spotify.com/artist/x') }
  });
  return { track, artist, images, name, url };
}

// Returns a mock controller. `mock.mode`: 'ok' | '401' | '429' | '500'.
// `mock.playback`: 'playing' | 'idle'. `mock.playbackStatus`: status for control PUT/POSTs.
async function mockSpotify(context, { evil = false } = {}) {
  const mock = { mode: 'ok', playback: 'idle', playbackStatus: 204, calls: [], profileId: 'user-1', evil };
  const d = makeData(evil);
  await context.route(/api\.spotify\.com|accounts\.spotify\.com|fonts\.g/, async (route) => {
    const req = route.request();
    const u = req.url();
    if (u.includes('fonts.g')) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    if (u.includes('accounts.spotify.com/authorize')) return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>spotify</title>' });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const apiPath = u.replace('https://api.spotify.com/v1', '');
    mock.calls.push(`${req.method()} ${apiPath}`);
    const json = (body) => route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
    if (u.includes('/api/token')) return json({ access_token: 'FAKE_ACCESS', refresh_token: 'FAKE_REFRESH', expires_in: 3600 });
    if (mock.mode === '401') return route.fulfill({ status: 401, headers: CORS, body: '{}' });
    if (mock.mode === '429') return route.fulfill({ status: 429, headers: { ...CORS, 'retry-after': '2', 'access-control-expose-headers': 'retry-after' }, body: '{}' });
    if (mock.mode === '500') return route.fulfill({ status: 500, headers: CORS, body: '{}' });
    if (req.method() !== 'GET') return route.fulfill({ status: mock.playbackStatus, headers: CORS, body: mock.playbackStatus === 204 ? '' : '{}' });
    if (u.endsWith('/me')) return json({ id: mock.profileId, display_name: evil ? EVIL : `Name of ${mock.profileId}`, product: 'premium', images: d.images });
    if (u.includes('/me/top/tracks')) return json({ items: [1, 2, 3].map(d.track) });
    if (u.includes('/me/top/artists')) return json({ items: [1, 2, 3].map(d.artist) });
    if (u.includes('recently-played')) return json({ items: [1, 2, 3].map((n) => ({ played_at: new Date().toISOString(), track: d.track(n) })) });
    if (u.includes('/me/player/queue')) return json({ queue: [d.track(5)] });
    if (u.includes('/me/player')) {
      if (mock.playback === 'idle') return route.fulfill({ status: 204, headers: CORS });
      return json({ is_playing: true, progress_ms: 1000, shuffle_state: false, item: d.track(9), context: { uri: 'spotify:playlist:x', href: 'https://api.spotify.com/v1/playlists/x' } });
    }
    if (u.includes('/playlists/')) return json({ name: evil ? EVIL : 'A playlist' });
    if (u.includes('/search')) {
      return json({
        tracks: { items: [d.track(1)] }, artists: { items: [d.artist(1)] },
        albums: { items: [{ id: 'al', name: d.name('', 'Album'), images: d.images, artists: [{ name: 'x' }], external_urls: { spotify: d.url('https://open.spotify.com/album/x') }, total_tracks: 3, release_date: '2020' }] },
        playlists: { items: [{ id: 'pl', name: d.name('', 'Playlist'), images: d.images, owner: { display_name: d.name('', 'Owner') }, external_urls: { spotify: d.url('https://open.spotify.com/playlist/x') }, tracks: { total: 3 } }] }
      });
    }
    return json({});
  });
  return mock;
}

const seedTokens = (page) => page.evaluate(() => {
  localStorage.setItem('spotify_access_token', 'FAKE_ACCESS');
  localStorage.setItem('spotify_refresh_token', 'FAKE_REFRESH');
  localStorage.setItem('spotify_token_expires_at', String(Date.now() + 3600000));
});

module.exports = { startServer, mockSpotify, seedTokens, EVIL };
