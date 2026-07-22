// SoundTracks — client-side Spotify auth (Authorization Code + PKCE)
//
// Runs entirely in the browser: no client secret, no backend token exchange.
// Tokens are cached in localStorage and refreshed proactively before they expire.
(function () {
  const AUTH_ENDPOINT = 'https://accounts.spotify.com/authorize';
  const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
  const API_BASE = 'https://api.spotify.com/v1';
  const SCOPES = 'user-read-private user-read-email user-top-read user-read-recently-played user-read-currently-playing playlist-read-private';
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

  function clearTokens() {
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

  async function refreshAccessToken() {
    const refreshToken = localStorage.getItem(STORAGE_KEYS.refreshToken);
    if (!refreshToken) {
      throw new Error('No refresh token available');
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: getClientId()
    });

    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });

    if (!response.ok) {
      throw new Error(`Token refresh failed: ${response.status}`);
    }

    storeTokens(await response.json());
    return localStorage.getItem(STORAGE_KEYS.accessToken);
  }

  // Returns a valid access token, refreshing first if it's near expiry. Returns
  // null (and clears storage) if there's nothing usable — caller should show login.
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
      console.error('Failed to refresh Spotify access token:', err);
      clearTokens();
      return null;
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
  async function apiFetch(path) {
    const token = await getAccessToken();
    if (!token) {
      throw new SpotifyUnauthorizedError('Not authenticated with Spotify');
    }

    const response = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (response.status === 401) {
      clearTokens();
      throw new SpotifyUnauthorizedError('Spotify rejected the access token');
    }

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`API error: ${response.status} - ${errorText}`);
      error.status = response.status;
      throw error;
    }

    return response;
  }

  window.SpotifyAuth = {
    connectSpotify,
    handleRedirect,
    getAccessToken,
    isConnected,
    disconnectSpotify,
    apiFetch
  };
})();
