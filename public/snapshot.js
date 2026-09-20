// SoundTracks — last-known dashboard snapshot.
//
// A deliberately small copy of what the dashboard first shows, kept in this
// browser's localStorage so the installed app has something useful to show
// when it is reopened offline.
//
// WHAT IS STORED (display fields only — never tokens, never raw API payloads):
//   profile        id, display name, plan, first avatar URL (no email)
//   topTracks      medium-term top 50: id, name, artists, album name/cover/link, duration, popularity
//   topArtists     medium-term top 50: id, name, genres, popularity, follower count, image, link
//   recentlyPlayed last 50 plays: played_at + the same track fields
//   savedAt        when the live data was fetched (not when it was written)
//
// POLICY
//   • Replaced wholesale after every successful live dashboard load.
//   • Expires MAX_AGE_MS after savedAt and is deleted when found expired.
//   • Anything unparseable, from another schema version, from the future or
//     with an unexpected shape is deleted and treated as "no snapshot".
//   • Cleared on logout, on a rejected session, and when a new authorisation
//     completes (so one account's data can never be shown to the next).
//   • The caller must also confirm the browser still holds a Spotify
//     connection before showing it (see app.js).
(function () {
  const STORAGE_KEY = 'soundtracks_snapshot_v1';
  const SCHEMA_VERSION = 1;
  const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const CLOCK_SKEW_MS = 5 * 60 * 1000;
  const MAX_ITEMS = 50;

  const isString = (value) => typeof value === 'string';
  const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
  const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const firstImageUrl = (images) => (Array.isArray(images) && images[0] && isString(images[0].url) ? images[0].url : null);

  // --- Reducers: full API object → the few fields the UI renders --------
  // The output keeps the API's nesting so the existing render functions work
  // on it unchanged.

  function reduceTrack(track) {
    if (!isPlainObject(track) || !isPlainObject(track.album)) return null;
    const cover = firstImageUrl(track.album.images);
    return {
      id: track.id,
      name: track.name,
      duration_ms: track.duration_ms,
      popularity: track.popularity,
      preview_url: null,
      external_urls: { spotify: (track.external_urls && track.external_urls.spotify) || '' },
      artists: (track.artists || []).map((artist) => ({ name: artist.name })),
      album: {
        name: track.album.name,
        images: cover ? [{ url: cover }] : [],
        external_urls: { spotify: (track.album.external_urls && track.album.external_urls.spotify) || '' }
      }
    };
  }

  function reduceArtist(artist) {
    if (!isPlainObject(artist)) return null;
    const image = firstImageUrl(artist.images);
    return {
      id: artist.id,
      name: artist.name,
      genres: (artist.genres || []).slice(0, 5),
      popularity: artist.popularity,
      followers: { total: artist.followers ? artist.followers.total : 0 },
      images: image ? [{ url: image }] : [],
      external_urls: { spotify: (artist.external_urls && artist.external_urls.spotify) || '' }
    };
  }

  function reduceProfile(profile) {
    if (!isPlainObject(profile)) return null;
    const avatar = firstImageUrl(profile.images);
    return {
      id: profile.id,
      display_name: profile.display_name || profile.id,
      product: profile.product || 'free',
      images: avatar ? [{ url: avatar }] : []
    };
  }

  function reduceList(page, reduceItem) {
    const items = page && Array.isArray(page.items) ? page.items : [];
    return { items: items.slice(0, MAX_ITEMS).map(reduceItem).filter(Boolean) };
  }

  function reduceRecent(item) {
    const track = reduceTrack(item && item.track);
    return track && isString(item.played_at) ? { played_at: item.played_at, track } : null;
  }

  // --- Validation: never trust what comes back out of storage ----------

  function isValidTrack(track) {
    return isPlainObject(track)
      && isString(track.id) && isString(track.name)
      && isNumber(track.duration_ms) && isNumber(track.popularity)
      && Array.isArray(track.artists) && track.artists.every((a) => isPlainObject(a) && isString(a.name))
      && isPlainObject(track.external_urls) && isString(track.external_urls.spotify)
      && isPlainObject(track.album) && isString(track.album.name)
      && Array.isArray(track.album.images) && track.album.images.every((i) => isPlainObject(i) && isString(i.url))
      && isPlainObject(track.album.external_urls) && isString(track.album.external_urls.spotify);
  }

  function isValidArtist(artist) {
    return isPlainObject(artist)
      && isString(artist.id) && isString(artist.name)
      && isNumber(artist.popularity)
      && Array.isArray(artist.genres) && artist.genres.every(isString)
      && isPlainObject(artist.followers) && isNumber(artist.followers.total)
      && Array.isArray(artist.images) && artist.images.every((i) => isPlainObject(i) && isString(i.url))
      && isPlainObject(artist.external_urls) && isString(artist.external_urls.spotify);
  }

  function isValidRecent(item) {
    return isPlainObject(item) && isString(item.played_at) && isValidTrack(item.track);
  }

  function isValidList(page, isValidItem) {
    return isPlainObject(page) && Array.isArray(page.items) && page.items.length <= MAX_ITEMS && page.items.every(isValidItem);
  }

  function isValidProfile(profile) {
    return isPlainObject(profile)
      && isString(profile.id) && isString(profile.display_name) && isString(profile.product)
      && Array.isArray(profile.images) && profile.images.every((i) => isPlainObject(i) && isString(i.url));
  }

  function isValidSnapshot(snapshot, now) {
    return isPlainObject(snapshot)
      && snapshot.version === SCHEMA_VERSION
      && isNumber(snapshot.savedAt)
      && snapshot.savedAt <= now + CLOCK_SKEW_MS
      && now - snapshot.savedAt <= MAX_AGE_MS
      && isValidProfile(snapshot.profile)
      && isValidList(snapshot.topTracks, isValidTrack)
      && isValidList(snapshot.topArtists, isValidArtist)
      && isValidList(snapshot.recentlyPlayed, isValidRecent);
  }

  // --- Public API ------------------------------------------------------
  // localStorage can be missing or throw (private mode, blocked storage, quota
  // exceeded) — the snapshot is a nicety, so every failure degrades to "none".

  function clear() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      // Nothing more can be done; the snapshot will simply expire.
    }
  }

  // `live` is { profile, topTracks, topArtists, recentlyPlayed } as returned by
  // the Spotify API. Returns true if it was stored.
  function save(live, now = Date.now()) {
    try {
      const snapshot = {
        version: SCHEMA_VERSION,
        savedAt: now,
        profile: reduceProfile(live.profile),
        topTracks: reduceList(live.topTracks, reduceTrack),
        topArtists: reduceList(live.topArtists, reduceArtist),
        recentlyPlayed: reduceList(live.recentlyPlayed, reduceRecent)
      };
      // Refuse to store something we would immediately discard on load.
      if (!isValidSnapshot(snapshot, now)) return false;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      return true;
    } catch (err) {
      clear();
      return false;
    }
  }

  // Returns the validated snapshot, or null (deleting anything unusable).
  function load(now = Date.now()) {
    let raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      return null;
    }
    if (raw === null) return null;

    try {
      const snapshot = JSON.parse(raw);
      // Validation checks shape; re-reducing also drops any unknown properties,
      // so only the documented display fields ever reach the UI.
      if (isValidSnapshot(snapshot, now)) {
        return {
          version: snapshot.version,
          savedAt: snapshot.savedAt,
          profile: reduceProfile(snapshot.profile),
          topTracks: reduceList(snapshot.topTracks, reduceTrack),
          topArtists: reduceList(snapshot.topArtists, reduceArtist),
          recentlyPlayed: reduceList(snapshot.recentlyPlayed, reduceRecent)
        };
      }
    } catch (err) {
      // Corrupted JSON — fall through to deletion.
    }
    clear();
    return null;
  }

  const api = { save, load, clear, MAX_AGE_MS, STORAGE_KEY };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    window.SoundTracksSnapshot = api;
  }
})();
