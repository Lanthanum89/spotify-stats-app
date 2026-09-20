// Run with: npm test   (Node's built-in test runner — no dependencies)
const test = require('node:test');
const assert = require('node:assert/strict');

// Minimal localStorage stand-in
function installStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); }
  };
  return store;
}

const snapshot = require('../public/snapshot.js');

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);

const track = (n) => ({
  id: `t${n}`, name: `Track ${n}`, duration_ms: 200000, popularity: 50, preview_url: 'https://p.scdn.co/x',
  uri: `spotify:track:t${n}`, available_markets: ['GB', 'US'], explicit: false,
  external_urls: { spotify: `https://open.spotify.com/track/t${n}` },
  artists: [{ id: 'a1', name: 'Artist', href: 'x', uri: 'y' }],
  album: {
    name: 'Album', release_date: '2020-01-01', total_tracks: 12,
    images: [{ url: 'https://i.scdn.co/big', width: 640 }, { url: 'https://i.scdn.co/small', width: 64 }],
    external_urls: { spotify: 'https://open.spotify.com/album/x' }
  }
});
const artist = (n) => ({
  id: `a${n}`, name: `Artist ${n}`, genres: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'], popularity: 70,
  followers: { total: 1234, href: null }, images: [{ url: 'https://i.scdn.co/a' }],
  external_urls: { spotify: 'https://open.spotify.com/artist/x' }
});
const live = () => ({
  profile: { id: 'user-1', display_name: 'Someone', email: 'someone@example.com', country: 'GB', product: 'premium', images: [{ url: 'https://i.scdn.co/me' }] },
  topTracks: { items: [track(1), track(2)], total: 50, href: 'x' },
  topArtists: { items: [artist(1)] },
  recentlyPlayed: { items: [{ played_at: '2026-09-20T10:00:00Z', track: track(3), context: { uri: 'spotify:playlist:z' } }] }
});

test('round-trips a reduced snapshot', () => {
  installStorage();
  assert.equal(snapshot.save(live(), NOW), true);
  const loaded = snapshot.load(NOW + 1000);
  assert.equal(loaded.savedAt, NOW);
  assert.equal(loaded.profile.id, 'user-1');
  assert.equal(loaded.topTracks.items.length, 2);
  assert.equal(loaded.recentlyPlayed.items[0].track.id, 't3');
});

test('stores display fields only — no email, tokens, markets or extra images', () => {
  const store = installStorage();
  snapshot.save(live(), NOW);
  const raw = store.get(snapshot.STORAGE_KEY);
  for (const forbidden of ['someone@example.com', 'available_markets', 'release_date', 'p.scdn.co', 'spotify:track', 'i.scdn.co/small', 'country', 'token']) {
    assert.ok(!raw.includes(forbidden), `snapshot should not contain "${forbidden}"`);
  }
  assert.equal(snapshot.load(NOW).topArtists.items[0].genres.length, 5);
});

test('expires after MAX_AGE_MS and deletes the entry', () => {
  const store = installStorage();
  snapshot.save(live(), NOW);
  assert.ok(snapshot.load(NOW + snapshot.MAX_AGE_MS - 1));
  assert.equal(snapshot.load(NOW + snapshot.MAX_AGE_MS + 1), null);
  assert.equal(store.has(snapshot.STORAGE_KEY), false);
});

test('rejects and deletes corrupted JSON', () => {
  const store = installStorage();
  store.set(snapshot.STORAGE_KEY, '{not json');
  assert.equal(snapshot.load(NOW), null);
  assert.equal(store.has(snapshot.STORAGE_KEY), false);
});

test('rejects and deletes another schema version', () => {
  const store = installStorage();
  snapshot.save(live(), NOW);
  const parsed = JSON.parse(store.get(snapshot.STORAGE_KEY));
  parsed.version = 99;
  store.set(snapshot.STORAGE_KEY, JSON.stringify(parsed));
  assert.equal(snapshot.load(NOW), null);
  assert.equal(store.has(snapshot.STORAGE_KEY), false);
});

test('rejects a snapshot dated in the future', () => {
  installStorage();
  snapshot.save(live(), NOW + 60 * 60 * 1000);
  assert.equal(snapshot.load(NOW), null);
});

test('rejects tampered or malformed items', () => {
  const store = installStorage();
  snapshot.save(live(), NOW);
  const parsed = JSON.parse(store.get(snapshot.STORAGE_KEY));
  parsed.topTracks.items[0].name = 42;
  store.set(snapshot.STORAGE_KEY, JSON.stringify(parsed));
  assert.equal(snapshot.load(NOW), null);
});

test('refuses to save an unusable payload (no profile)', () => {
  const store = installStorage();
  const bad = live();
  bad.profile = null;
  assert.equal(snapshot.save(bad, NOW), false);
  assert.equal(store.has(snapshot.STORAGE_KEY), false);
});

test('clear() removes the snapshot', () => {
  const store = installStorage();
  snapshot.save(live(), NOW);
  snapshot.clear();
  assert.equal(store.has(snapshot.STORAGE_KEY), false);
  assert.equal(snapshot.load(NOW), null);
});

test("a new save replaces the previous account's snapshot entirely", () => {
  installStorage();
  snapshot.save(live(), NOW);
  const other = live();
  other.profile.id = 'user-2';
  other.topTracks.items = [track(9)];
  snapshot.save(other, NOW + 1000);
  const loaded = snapshot.load(NOW + 2000);
  assert.equal(loaded.profile.id, 'user-2');
  assert.deepEqual(loaded.topTracks.items.map((t) => t.id), ['t9']);
});

test('degrades to "no snapshot" when storage throws', () => {
  globalThis.localStorage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('quota'); },
    removeItem() { throw new Error('blocked'); }
  };
  assert.equal(snapshot.save(live(), NOW), false);
  assert.equal(snapshot.load(NOW), null);
  assert.doesNotThrow(() => snapshot.clear());
});
