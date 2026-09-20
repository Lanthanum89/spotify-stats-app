// SoundTracks — client-side Spotify auth (Authorization Code + PKCE)
//
// Runs entirely in the browser: no client secret, no backend token exchange.
// Tokens are cached in localStorage and refreshed proactively before they expire.
(function () {
  const AUTH_ENDPOINT = 'https://accounts.spotify.com/authorize';
  const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
  const API_BASE = 'https://api.spotify.com/v1';
  const SCOPES = 'user-read-private user-read-email user-top-read user-read-recently-played user-read-currently-playing user-read-playback-state user-modify-playback-state playlist-read-private';
  const REFRESH_MARGIN_MS = 60 * 1000; // refresh if the token expires within this window

  const STORAGE_KEYS = {
    verifier: 'spotify_pkce_verifier',
    state: 'spotify_pkce_state',
    accessToken: 'spotify_access_token',
    refreshToken: 'spotify_refresh_token',
    expiresAt: 'spotify_token_expires_at'
  };

  class SpotifyUnauthorizedError extends Error {
    constructor(message) {
      super(message);
      this.name = 'SpotifyUnauthorizedError';
      this.isUnauthorized = true;
    }
  }

  function getClientId() {
    const meta = document.querySelector('meta[name="spotify-client-id"]');
    return meta ? meta.content.trim() : '';
  }

  function getRedirectUri() {
    return window.location.origin + window.location.pathname;
  }

  function base64UrlEncode(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    bytes.forEach((b) => { binary += String.fromCharCode(b); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function generateRandomString(byteLength) {
    const array = new Uint8Array(byteLength);
    crypto.getRandomValues(array);
    return base64UrlEncode(array.buffer);
  }

  async function generateCodeChallenge(verifier) {
    const data = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return base64UrlEncode(digest);
  }

  function storeTokens(data) {
    localStorage.setItem(STORAGE_KEYS.accessToken, data.access_token);
    localStorage.setItem(STORAGE_KEYS.expiresAt, String(Date.now() + data.expires_in * 1000));
    // Spotify doesn't always rotate the refresh token — keep the old one if a new one isn't returned.
    if (data.refresh_token) {
      localStorage.setItem(STORAGE_KEYS.refreshToken, data.refresh_token);
    }
  }

  // Bumped whenever tokens are cleared, so a refresh that was already in
  // flight can tell it has been overtaken by a logout/401 and must not write
  // the old account's tokens back.
  let tokenGeneration = 0;

  function clearTokens() {
    tokenGeneration++;
    Object.values(STORAGE_KEYS).forEach((key) => localStorage.removeItem(key));
  }

  function isConnected() {
    return Boolean(localStorage.getItem(STORAGE_KEYS.refreshToken));
  }

  // Kicks off the Authorization Code + PKCE flow by redirecting to Spotify.
  async function connectSpotify() {
    const clientId = getClientId();
    if (!clientId) {
      throw new Error('missing_client_id');
    }

    const verifier = generateRandomString(64);
    const challenge = await generateCodeChallenge(verifier);
    const state = generateRandomString(16);

    localStorage.setItem(STORAGE_KEYS.verifier, verifier);
    localStorage.setItem(STORAGE_KEYS.state, state);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: SCOPES,
      redirect_uri: getRedirectUri(),
      code_challenge_method: 'S256',
      code_challenge: challenge,
      state
    });

    window.location.href = `${AUTH_ENDPOINT}?${params.toString()}`;
  }

  async function exchangeCodeForToken(code, verifier) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: getRedirectUri(),
      client_id: getClientId(),
      code_verifier: verifier
    });

    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });

    if (!response.ok) {
      throw new Error(`Token exchange failed: ${response.status}`);
    }

    storeTokens(await response.json());
  }

  // A failure that says nothing about whether the credentials are still good:
  // no connection, a timeout, Spotify 5xx, or a 429. Callers must NOT log the
  // user out over one of these.
  function createTransientError(message, extra) {
    return Object.assign(new Error(message), { isNetworkError: true }, extra);
  }

  function isOffline() {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  // Fetches the token endpoint, turning a thrown fetch (offline, DNS, CORS
  // failure) into a transient error rather than an opaque TypeError.
  async function postToTokenEndpoint(body) {
    try {
      return await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
    } catch (err) {
      throw createTransientError('Could not reach Spotify', { offline: isOffline() });
    }
  }

  // Several requests can find the access token expired at the same moment
  // (the dashboard fires four in parallel) — share one refresh between them.
  // Spotify may rotate the refresh token, so a second concurrent refresh with
  // the old one could otherwise be rejected.
  let refreshInFlight = null;

  function refreshAccessToken() {
    if (!refreshInFlight) {
      refreshInFlight = doRefreshAccessToken().finally(() => { refreshInFlight = null; });
    }
    return refreshInFlight;
  }

  async function doRefreshAccessToken() {
    const refreshToken = localStorage.getItem(STORAGE_KEYS.refreshToken);
    if (!refreshToken) {
      throw new SpotifyUnauthorizedError('No refresh token available');
    }

    const generation = tokenGeneration;
    const response = await postToTokenEndpoint(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: getClientId()
    }));

    if (!response.ok) {
      // 400/401 (invalid_grant) means Spotify has genuinely revoked or
      // rejected this refresh token. Anything else is Spotify being
      // unavailable or rate limiting us — the credentials may be fine.
      if (response.status === 400 || response.status === 401) {
        throw new SpotifyUnauthorizedError('Spotify rejected the refresh token');
      }
      throw createTransientError(`Token refresh failed: ${response.status}`, { status: response.status });
    }

    const data = await response.json();
    if (generation !== tokenGeneration) {
      throw new SpotifyUnauthorizedError('Session ended while refreshing');
    }
    storeTokens(data);
    return localStorage.getItem(STORAGE_KEYS.accessToken);
  }

  // Returns a valid access token, refreshing first if it's near expiry.
  // Returns null (and clears storage) only when there is nothing usable and
  // the user must sign in again. A transient failure while refreshing throws
  // instead, leaving the stored credentials intact.
  async function getAccessToken() {
    const accessToken = localStorage.getItem(STORAGE_KEYS.accessToken);
    const expiresAt = Number(localStorage.getItem(STORAGE_KEYS.expiresAt) || 0);

    if (!accessToken) return null;

    if (Date.now() < expiresAt - REFRESH_MARGIN_MS) {
      return accessToken;
    }

    try {
      return await refreshAccessToken();
    } catch (err) {
      if (err.isUnauthorized) {
        clearTokens();
        return null;
      }
      throw err;
    }
  }

  // Call once on page load. Detects a `code`/`error`/`state` redirect back from
  // Spotify, completes the PKCE exchange, and scrubs those params from the URL.
  // Returns { handled: false } if this load isn't a Spotify redirect at all.
  async function handleRedirect() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const error = params.get('error');
    const returnedState = params.get('state');

    if (!code && !error) {
      return { handled: false };
    }

    // Strip auth params so a page refresh doesn't try to reuse a spent code.
    window.history.replaceState({}, document.title, window.location.origin + window.location.pathname);

    if (error) {
      return { handled: true, success: false, error };
    }

    const expectedState = localStorage.getItem(STORAGE_KEYS.state);
    localStorage.removeItem(STORAGE_KEYS.state);

    if (!returnedState || returnedState !== expectedState) {
      return { handled: true, success: false, error: 'state_mismatch' };
    }

    const verifier = localStorage.getItem(STORAGE_KEYS.verifier);
    localStorage.removeItem(STORAGE_KEYS.verifier);

    if (!verifier) {
      return { handled: true, success: false, error: 'no_code' };
    }

    try {
      await exchangeCodeForToken(code, verifier);
      return { handled: true, success: true };
    } catch (err) {
      console.error('Spotify token exchange failed:', err);
      return { handled: true, success: false, error: 'token_exchange_failed' };
    }
  }

  function disconnectSpotify() {
    clearTokens();
  }

  // Thin fetch wrapper for api.spotify.com/v1/* — path should start with '/'.
  // options.method defaults to GET; playback control endpoints (PUT/POST)
  // pass it explicitly and typically get back a bodyless 204. options.body,
  // if present, is JSON-encoded (e.g. { uris: [...] } to start playback of
  // specific tracks, or { context_uri } for an album/artist/playlist).
  async function apiRequest(path, options = {}) {
    // Don't fire a request that can only fail — and don't let the failure be
    // mistaken for anything to do with the account.
    if (isOffline()) {
      throw createTransientError('You are offline', { offline: true });
    }

    const token = await getAccessToken();
    if (!token) {
      throw new SpotifyUnauthorizedError('Not authenticated with Spotify');
    }

    const headers = { Authorization: `Bearer ${token}` };
    let body;
    if (options.body) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method: options.method || 'GET',
        headers,
        body
      });
    } catch (err) {
      throw createTransientError('Could not reach Spotify', { offline: isOffline() });
    }

    if (response.status === 401) {
      clearTokens();
      throw new SpotifyUnauthorizedError('Spotify rejected the access token');
    }

    if (!response.ok) {
      // Status only — the response body can echo request details, so it is
      // deliberately not put in the error message (which gets logged).
      const error = new Error(`API error: ${response.status}`);
      error.status = response.status;
      if (response.status === 429) {
        // Retry-After is in seconds; it is only readable cross-origin if
        // Spotify lists it in Access-Control-Expose-Headers, so it may be null.
        const seconds = Number(response.headers.get('Retry-After'));
        error.retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
      }
      throw error;
    }

    return response;
  }

  function apiFetch(path) {
    return apiRequest(path);
  }

  window.SpotifyAuth = {
    connectSpotify,
    handleRedirect,
    getAccessToken,
    isConnected,
    disconnectSpotify,
    apiFetch,
    apiRequest
  };
})();
