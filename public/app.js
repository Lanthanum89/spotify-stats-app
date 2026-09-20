// SoundTracks App JavaScript Logic

// SPA URL ROUTING — each main tab gets a stable, shareable hash route
// (#/overview, #/tracks, ...) via the History API, so Back/Forward move
// between app tabs instead of leaving the installed PWA, and a direct link
// to a route opens straight into that tab. Hash-based (not full paths),
// since this is served as a static site with no server-side routing to
// match a path against. Set true only while applying a tab change that
// *came from* a popstate event, so switchTab doesn't push a redundant
// second history entry for a navigation the browser already recorded.
const TAB_ROUTES = ['overview', 'search', 'tracks', 'artists', 'analysis', 'recent'];
let isApplyingHistoryNavigation = false;

function tabIdFromHash() {
  const match = window.location.hash.match(/^#\/(\w+)$/);
  const id = match ? match[1] : '';
  return TAB_ROUTES.includes(id) ? id : null;
}

// Called once after the dashboard first loads: opens directly into whatever
// tab the URL names (falling back to Overview for an empty/invalid route),
// and starts listening for Back/Forward.
let routingInitialised = false;

function initRouting() {
  // loadDashboard can run more than once (retry, reconnect) — the popstate
  // listener below must only be added the first time.
  if (routingInitialised) return;
  routingInitialised = true;

  const initialTab = tabIdFromHash() || 'overview';
  history.replaceState({ tab: initialTab }, '', `#/${initialTab}`);
  if (initialTab !== currentTab) {
    isApplyingHistoryNavigation = true;
    switchTab(initialTab);
    isApplyingHistoryNavigation = false;
  }

  window.addEventListener('popstate', () => {
    const hash = window.location.hash;

    // Only react to history entries shaped like one of *our* routes
    // (#/tabname) or empty; anything else is left alone rather than being
    // misread as "not a valid tab route" and bounced back to Overview.
    if (hash !== '' && !/^#\/\w+$/.test(hash)) return;

    const tabId = tabIdFromHash() || 'overview';
    isApplyingHistoryNavigation = true;
    switchTab(tabId);
    isApplyingHistoryNavigation = false;
  });
}

let currentTab = 'overview';
let currentRange = 'medium_term'; // short_term, medium_term, long_term
// Grid vs list for Top Tracks/Artists/Recent. Defaults to list on phones
// (a wide grid/table isn't a great primary mobile layout) and grid on
// larger screens, but a user's own choice — once they touch the toggle —
// is remembered from then on regardless of screen size.
const MOBILE_VIEW_QUERY = '(max-width: 800px), (orientation: portrait) and (max-width: 1024px)';
let currentView = localStorage.getItem('view-mode') || (window.matchMedia(MOBILE_VIEW_QUERY).matches ? 'list' : 'grid');
let artistFilter = ''; // Filter string for top artists grid
let trackFilter = ''; // Filter string for top tracks grid

// Timeframe for the Analysis tab's "Your Top 50 (Selected Range)" section —
// one shared range drives every card there, independent of the Top
// Tracks/Artists tabs' own `currentRange`.
let analysisRange = 'medium_term';
// Bumped on every range switch so a slow, superseded fetch can recognise
// it's stale and skip rendering over the newer selection.
let analysisRangeToken = 0;

// Audio preview player state
let activeAudio = null;
let activePlayButton = null;
let activeTrackCard = null;

let appData = {
  profile: null,
  topTracks: {}, // Keyed by range
  topArtists: {}, // Keyed by range
  recentlyPlayed: null,
  queue: [] // Latest fetched "up next" queue, for Overview's teaser
};

// Where the data on screen came from. 'snapshot' means the last-known copy
// from a previous visit (offline reopen) rather than a live Spotify response.
let dataSource = 'live';
// When each dataset was last fetched live (or saved, for a snapshot copy).
const dataStamps = {};
// True between a dashboard starting to load and the session ending.
let sessionActive = false;
let dashboardLoadPromise = null;
let rateLimitedUntil = 0;
const DEFAULT_RATE_LIMIT_WAIT_MS = 30 * 1000;

// Now Playing polling state
const NOW_PLAYING_POLL_MS = 5000;
const NOW_PLAYING_TICK_MS = 500;
let nowPlayingPollTimer = null;
let nowPlayingTickTimer = null;
let nowPlayingState = {
  trackId: null,
  isPlaying: false,
  progressMs: 0,
  durationMs: 0,
  lastSyncedAt: 0,
  contextUri: null,
  contextName: null,
  shuffleState: false
};
let nowPlayingPollCount = 0;
let miniPlayerControlPending = false;
let nowPlayingConsecutiveFailures = 0;
const NOW_PLAYING_FAILURE_THRESHOLD = 3; // show a visible error after this many polls in a row fail

// --- Spotify API Helper ---
// apiPath is a path under https://api.spotify.com/v1 (e.g. '/me/top/tracks?...').
//
// Failure handling lives here so every caller gets the same behaviour:
//   401 / rejected token → end the session (login screen, saved data wiped)
//   429                  → one global banner, and further calls wait out the window
//   offline / network    → thrown as-is (err.isNetworkError, err.offline);
//                          callers show a local message, the session survives
async function spotifyFetch(apiPath) {
  if (Date.now() < rateLimitedUntil) {
    // Inside a rate-limit window: don't send requests Spotify has asked us to hold.
    throw Object.assign(new Error('Waiting out a Spotify rate limit'), {
      status: 429,
      retryAfterMs: rateLimitedUntil - Date.now(),
      alreadyReported: true
    });
  }

  try {
    const response = await SpotifyAuth.apiFetch(apiPath);
    // A request that was already in flight may succeed while another has just
    // been told to back off — only lift the limit once its window has passed.
    if (rateLimitedUntil && Date.now() >= rateLimitedUntil) {
      rateLimitedUntil = 0;
      SoundTracksNotices.clearStatus('rate-limit');
    }
    return response;
  } catch (err) {
    if (err.isUnauthorized) {
      endSession('session_expired');
    } else if (err.status === 429 && !err.alreadyReported) {
      handleRateLimit(err);
    }
    throw err;
  }
}

// Ends the session on this device: stops authenticated timers and removes
// everything specific to the account (tokens are cleared by the caller or by
// the auth module) — cached data, state and rendered DOM — then shows a clean
// sign-in screen. Safe to call repeatedly (several requests can fail at once).
function endSession(reason) {
  if (!sessionActive && reason === 'session_expired') return;
  sessionActive = false;

  stopNowPlayingPolling();
  SoundTracksSnapshot.clear();
  clearAccountState();
  showLoginScreen();

  const authError = document.getElementById('auth-error-msg');
  authError.classList.add('hidden');
  authError.textContent = '';
  if (reason === 'session_expired') {
    showError('session_expired');
    SoundTracksNotices.announce('Your Spotify session has ended. Connect again to continue.');
  }
}

// Log out and clear saved data: this is the one way to disconnect.
function logout() {
  sessionActive = true; // make endSession() run its full clean-up
  SpotifyAuth.disconnectSpotify();
  endSession('logout');
  SoundTracksNotices.announce('Logged out. Saved data on this device was cleared.');
}

// Resets every piece of in-memory state and rendered DOM that belongs to the
// signed-in account, so nothing (names, artwork, statistics) survives in the
// page for the next person or account. UI preferences (grid/list, collapsed
// sidebar) are deliberately kept — they describe the device, not the account.
function clearAccountState() {
  if (activeAudio) activeAudio.pause();
  activeAudio = null;
  activePlayButton = null;
  activeTrackCard = null;

  appData = { profile: null, topTracks: {}, topArtists: {}, recentlyPlayed: null, queue: [] };
  dataSource = 'live';
  Object.keys(dataStamps).forEach((key) => delete dataStamps[key]);
  analysisRangeToken++;
  rateLimitedUntil = 0;
  SoundTracksNotices.clearStatus('rate-limit');
  SoundTracksNotices.clearStatus('reconnected');

  nowPlayingState = { trackId: null, isPlaying: false, progressMs: 0, durationMs: 0, lastSyncedAt: 0, contextUri: null, contextName: null, shuffleState: false };
  nowPlayingConsecutiveFailures = 0;
  hideDashboardError();
  hideSidebarMiniPlayer();
  ['mini-player-track', 'mini-player-artist', 'user-name', 'user-account-type'].forEach((id) => {
    const node = document.getElementById(id);
    if (node) { node.textContent = ''; node.removeAttribute('title'); }
  });
  ['mini-player-cover', 'user-avatar'].forEach((id) => {
    const img = document.getElementById(id);
    if (img) { img.removeAttribute('src'); img.alt = ''; }
  });
  document.getElementById('now-playing-content').innerHTML = '<div class="loading-inline">Checking playback...</div>';

  const emptied = [
    'overview-queue-list', 'overview-recent-list',
    'top-tracks-grid', 'top-tracks-table-body', 'top-artists-grid', 'top-artists-table-body',
    'recently-played-grid', 'recently-played-table-body',
    'search-library-grid', 'search-tracks-grid', 'search-artists-grid', 'search-albums-grid', 'search-playlists-grid',
    'header-search-dropdown', 'key-insights-list', 'genre-donut'
  ];
  emptied.forEach((id) => { const node = document.getElementById(id); if (node) node.replaceChildren(); });
  document.querySelectorAll('#tab-analysis [id$="-container"]').forEach((node) => node.replaceChildren());
  ['genre-metric-plays', 'genre-metric-hours', 'genre-metric-average', 'taste-title', 'taste-description',
    'genre-stat-primary', 'genre-stat-unique', 'genre-stat-share'].forEach((id) => {
    const node = document.getElementById(id);
    if (node) node.textContent = '';
  });

  // Search and filter boxes (they may hold something the user typed about their own listening)
  artistFilter = '';
  trackFilter = '';
  searchQuery = '';
  searchTypeFilter = 'all';
  headerSearchLiveResults = { tracks: [], artists: [], albums: [], playlists: [] };
  headerSearchLocalResults = { tracks: [], artists: [] };
  ['global-search-input', 'header-search-input', 'artist-search-input', 'track-search-input'].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });
  clearTimeout(searchDebounceTimer);
  clearTimeout(headerSearchDebounceTimer);
  hideAllControlErrors();
  hideSearchPlayError();
  miniPlayerControlPending = false;
  closeHeaderSearchDropdown();
  clearSpotifySearchResults();
  document.getElementById('data-freshness').classList.add('hidden');
  if (window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search);
  currentTab = 'overview';
  routingInitialised = false; // routing re-initialises on the next sign-in
}

// Turns a failed request into the sentence shown in a card. Offline gets its
// own wording and no Retry (the global banner already has one).
function loadFailureText(err, noun) {
  if (err && err.offline) return `Not available offline. Reconnect to load ${noun}.`;
  if (err && err.isNetworkError) return `Couldn’t reach Spotify to load ${noun}.`;
  if (err && err.status === 429) return 'Spotify is limiting requests right now. Try again in a little while.';
  if (err && err.status === 403) return `Spotify didn’t allow access to ${noun}. Logging out and connecting again may help.`;
  return `Failed to load ${noun}. Please try again.`;
}

// Card-level error block. Static strings only (never Spotify data), so it is
// safe to build as HTML.
function localErrorHtml(err, noun) {
  const retry = err && err.offline ? '' : '<div><button type="button" class="btn btn-secondary btn-sm" data-retry-load>Retry</button></div>';
  return `<div class="local-error" role="status">${loadFailureText(err, noun)}${retry}</div>`;
}

function localErrorRowHtml(err, noun) {
  return `<tr><td colspan="5">${localErrorHtml(err, noun)}</td></tr>`;
}

function playbackErrorMessage(err, fallback) {
  if (err.offline) return 'You’re offline.';
  if (err.status === 403) return 'Playback control needs Spotify Premium.';
  if (err.status === 404) return 'No active Spotify device found — open Spotify on a device first.';
  if (err.status === 429) return 'Spotify is limiting requests. Try again shortly.';
  return fallback;
}

// --- Connectivity, freshness and recovery ---------------------------------

function formatSavedAt(timestamp) {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${time}`;
}

function markUpdated(key, when = Date.now()) {
  dataStamps[key] = when;
  refreshFreshnessLabel();
}

function freshnessKeysFor(tabId) {
  if (tabId === 'overview' || tabId === 'recent') return ['recent'];
  if (tabId === 'tracks') return [`tracks:${currentRange}`];
  if (tabId === 'artists') return [`artists:${currentRange}`];
  if (tabId === 'analysis') return [`tracks:${analysisRange}`, `artists:${analysisRange}`, 'recent'];
  return [];
}

// "Updated 14:32" when live and online; clearly marked as last-known/offline
// otherwise, so old data is never presented as current.
function refreshFreshnessLabel() {
  const label = document.getElementById('data-freshness');
  if (!label) return;

  const stamps = freshnessKeysFor(currentTab).map((key) => dataStamps[key]);
  const isStale = dataSource === 'snapshot' || !navigator.onLine;
  // Overview is mostly live playback, so it only carries a label when stale.
  if (stamps.length === 0 || stamps.some((stamp) => !stamp) || (currentTab === 'overview' && !isStale)) {
    label.classList.add('hidden');
    return;
  }

  const oldest = Math.min(...stamps);
  const time = document.createElement('time');
  time.dateTime = new Date(oldest).toISOString();
  time.textContent = formatSavedAt(oldest);
  const prefix = dataSource === 'snapshot' ? 'Offline copy · saved ' : isStale ? 'Last known data · ' : 'Updated ';
  label.replaceChildren(prefix, time);
  label.classList.toggle('is-stale', isStale);
  label.classList.remove('hidden');
}

// The single global banner for "we can't reach Spotify right now".
function showOfflineBanner({ reachable = false, checkedAt = null } = {}) {
  const hasData = Boolean(appData.profile);
  const label = reachable ? 'Can’t reach Spotify' : 'Offline';
  const detail = dataSource === 'snapshot'
    ? `Showing your last saved copy from ${formatSavedAt(dataStamps.recent || Date.now())}. It will refresh when Spotify is reachable.`
    : hasData
      ? 'Showing data from earlier in this session; it may be out of date.'
      : 'Spotify data can’t load until you’re connected.';
  SoundTracksNotices.clearStatus('reconnected');
  SoundTracksNotices.showStatus('offline', {
    tone: 'warn',
    icon: 'offline',
    label,
    text: checkedAt ? `${detail} Still not connected (checked ${formatSavedAt(checkedAt)}).` : detail,
    action: { label: 'Retry', onClick: retryConnection }
  });
}

function initConnectivity() {
  window.addEventListener('offline', handleWentOffline);
  window.addEventListener('online', handleCameOnline);
  if (!navigator.onLine) showOfflineBanner();
}

function handleWentOffline() {
  hideDashboardError();
  showOfflineBanner();
  SoundTracksNotices.announce('You are offline. Spotify data will not update until you reconnect.');
  if (nowPlayingPollTimer) renderNowPlayingOffline();
  refreshFreshnessLabel();
}

let isRecovering = false;

async function handleCameOnline() {
  SoundTracksNotices.clearStatus('offline');
  refreshFreshnessLabel();
  if (!sessionActive) {
    SoundTracksNotices.announce('Back online.');
    return;
  }
  await recoverConnection();
}

// Re-fetches whatever is on screen after connectivity returns. Shows
// "Back online" only once the outcome is known, so it never claims fresh data
// that didn't arrive.
async function recoverConnection() {
  if (isRecovering) return false;
  isRecovering = true;
  SoundTracksNotices.showStatus('reconnected', {
    tone: 'ok', icon: 'check', label: 'Back online', text: 'Refreshing your Spotify data…'
  });
  SoundTracksNotices.announce('Back online. Refreshing your data.');

  let ok = false;
  try {
    ok = await refreshCurrentView();
  } finally {
    isRecovering = false;
  }

  if (ok) {
    SoundTracksNotices.clearStatus('offline');
    SoundTracksNotices.showStatus('reconnected', {
      tone: 'ok', icon: 'check', label: 'Back online', text: 'Your Spotify data is up to date.', dismissible: true, autoHideMs: 6000
    });
    SoundTracksNotices.announce('Your Spotify data is up to date.');
  } else {
    SoundTracksNotices.clearStatus('reconnected');
    // The refresh failed. If nothing has explained why yet (a global banner or
    // the dashboard's own error), say so once — never two banners.
    const dashboardErrorShown = !document.getElementById('dashboard-error-banner').classList.contains('hidden');
    if (!SoundTracksNotices.hasBlockingStatus() && !dashboardErrorShown) showOfflineBanner({ reachable: true });
  }
  refreshFreshnessLabel();
  return ok;
}

// The offline banner's Retry. navigator.onLine can only say "no" reliably, so
// when the browser claims to be online this is a real attempt to reach Spotify.
async function retryConnection() {
  if (!navigator.onLine) {
    showOfflineBanner({ checkedAt: Date.now() });
    SoundTracksNotices.announce('Still offline.');
    return;
  }
  if (!sessionActive) {
    SoundTracksNotices.clearStatus('offline');
    return;
  }
  await recoverConnection();
}

function retryAfterRateLimit() {
  const remaining = rateLimitedUntil - Date.now();
  if (remaining > 0) {
    SoundTracksNotices.announce(`Spotify asked us to wait about ${Math.ceil(remaining / 1000)} more seconds.`);
    return;
  }
  rateLimitedUntil = 0;
  SoundTracksNotices.clearStatus('rate-limit');
  refreshCurrentView();
  if (nowPlayingPollTimer) pollNowPlaying();
}

function handleRateLimit(err) {
  const wait = err.retryAfterMs || DEFAULT_RATE_LIMIT_WAIT_MS;
  const alreadyShowing = SoundTracksNotices.hasStatus('rate-limit') && Date.now() < rateLimitedUntil;
  rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + wait);
  if (alreadyShowing) return;

  SoundTracksNotices.showStatus('rate-limit', {
    tone: 'warn',
    icon: 'warning',
    label: 'Rate limited',
    text: `Spotify is limiting requests. Please wait about ${Math.ceil(wait / 1000)} seconds, then retry.`,
    action: { label: 'Retry', onClick: retryAfterRateLimit }
  });
  SoundTracksNotices.announce('Spotify is limiting requests. Wait a moment, then retry.');
}

// Re-fetches what the current view needs. Resolves true if it all loaded.
async function refreshCurrentView() {
  if (!appData.profile || dataSource === 'snapshot') return loadDashboard();

  if (currentTab === 'tracks') return loadTopTracks(true);
  if (currentTab === 'artists') return loadTopArtists(true);
  if (currentTab === 'analysis') return (await loadAnalysisTab(true)) !== false;
  if (currentTab === 'search' && searchQuery.length >= SEARCH_MIN_CHARS) {
    await runSpotifySearch(searchQuery);
    return true;
  }
  // Overview, Recent and Search all rest on the recently-played list.
  const ok = await loadRecentlyPlayed();
  if (ok) renderOverview();
  if (nowPlayingPollTimer) pollNowPlaying();
  return ok;
}

// UK English formatting helpers
function formatDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

function formatHours(ms) {
  const hours = ms / 3600000;
  return `${hours.toFixed(hours >= 10 ? 1 : 2)}h`;
}

function formatFollowers(count) {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(0)}K`;
  }
  return count.toLocaleString('en-GB');
}

function formatRelativeTime(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.round(diffMs / 60000);
  const diffHours = Math.round(diffMins / 60);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} min${diffMins > 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  
  // Format as day/month/year for UK English standard
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Announces a message to screen reader users via the sr-only global status
// region, for state changes that don't already have their own visible
// role="alert"/aria-live element. Clearing first (then setting on the next
// frame) ensures back-to-back identical messages are both announced, since
// most screen readers only react to an actual content change.
function announceStatus(message) {
  SoundTracksNotices.announce(message);
}

// Initialise App
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  initConnectivity();
  checkAuthStatus();

  // Card-level "Retry" buttons (see localErrorHtml)
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-retry-load]')) refreshCurrentView();
  });

  // Now Playing's own "Retry" button (shown after repeated poll failures)
  document.getElementById('now-playing-content').addEventListener('click', (e) => {
    if (e.target.closest('#now-playing-retry-btn')) {
      nowPlayingConsecutiveFailures = 0;
      pollNowPlaying();
    }
  });
});

// Check if user is authenticated
async function checkAuthStatus() {
  try {
    // If this page load is Spotify redirecting back with ?code=/?error=, finish
    // the PKCE exchange first — this also scrubs those params from the URL.
    const redirectResult = await SpotifyAuth.handleRedirect();

    if (redirectResult.handled) {
      if (redirectResult.success) {
        // A fresh authorisation may be a different Spotify account: never let
        // the previous account's saved copy be shown to it.
        SoundTracksSnapshot.clear();
        await loadDashboard();
      } else {
        showError(redirectResult.error);
        showLoginScreen();
      }
      return;
    }

    if (SpotifyAuth.isConnected()) {
      await loadDashboard();
    } else {
      showLoginScreen();
    }
  } catch (err) {
    console.error('Error checking auth status:', err);
    showError('failed_connection');
    showLoginScreen();
  } finally {
    hideLoading();
  }
}

function showLoginScreen() {
  SoundTracksNotices.mountIn(document.querySelector('#login-container .auth-body'));
  document.getElementById('login-container').classList.remove('hidden');
  document.getElementById('app-container').classList.add('hidden');
}

function showDashboardScreen() {
  SoundTracksNotices.mountIn(document.getElementById('main-content'));
  document.getElementById('login-container').classList.add('hidden');
  document.getElementById('app-container').classList.remove('hidden');
}

function hideLoading() {
  document.getElementById('loading-container').classList.add('hidden');
}

// Collapsible sidebar (desktop) — icon-only rail, persisted across sessions
function applySidebarCollapsedState(collapsed) {
  const sidebar = document.getElementById('sidebar');
  const dashboardLayout = document.getElementById('app-container');
  if (!sidebar || !dashboardLayout) return;

  sidebar.classList.toggle('collapsed', collapsed);
  dashboardLayout.classList.toggle('sidebar-collapsed', collapsed);

  const collapseBtn = document.getElementById('btn-sidebar-collapse');
  if (collapseBtn) {
    collapseBtn.setAttribute('aria-expanded', String(!collapsed));
    collapseBtn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  }
}

// Mobile nav drawer (hamburger menu, phones & tablets in portrait)
function openMobileMenu() {
  document.getElementById('mobile-nav-drawer').classList.add('open');
  document.getElementById('mobile-nav-drawer').setAttribute('aria-hidden', 'false');
  document.getElementById('mobile-nav-overlay').classList.add('open');
  const toggleBtn = document.getElementById('btn-mobile-menu');
  if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
}

function closeMobileMenu() {
  document.getElementById('mobile-nav-drawer').classList.remove('open');
  document.getElementById('mobile-nav-drawer').setAttribute('aria-hidden', 'true');
  document.getElementById('mobile-nav-overlay').classList.remove('open');
  const toggleBtn = document.getElementById('btn-mobile-menu');
  if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
}

function showError(errorType) {
  const banner = document.getElementById('auth-error-msg');
  banner.classList.remove('hidden');
  
  let msg = 'An error occurred during authentication. Please try again.';
  if (errorType === 'access_denied') {
    msg = 'Access was denied. You must approve permissions to use the application.';
  } else if (errorType === 'token_exchange_failed') {
    msg = 'Failed to exchange the authorisation code with Spotify. Please try connecting again.';
  } else if (errorType === 'no_code') {
    msg = 'No authorisation code was returned from Spotify.';
  } else if (errorType === 'state_mismatch') {
    msg = 'The authorisation response could not be verified. Please try connecting again.';
  } else if (errorType === 'missing_client_id') {
    msg = 'No Spotify Client ID is configured. Add one to the spotify-client-id meta tag in index.html.';
  } else if (errorType === 'session_expired') {
    msg = 'Your Spotify session has ended or was rejected. Connect again to continue.';
  } else if (errorType === 'failed_connection') {
    msg = 'Unable to reach Spotify. Check your connection and try again.';
  }
  
  banner.textContent = msg;
}

// Setup Event Listeners
function setupEventListeners() {
  const retryBtn = document.getElementById('btn-dashboard-retry');
  if (retryBtn) retryBtn.addEventListener('click', () => loadDashboard());

  // Navigation tabs
  document.querySelectorAll('.nav-item').forEach(button => {
    button.addEventListener('click', () => {
      const tabId = button.getAttribute('data-tab');
      switchTab(tabId);
      if (tabId === 'search') focusSearchInput();
      if (button.closest('#mobile-nav-drawer')) closeMobileMenu();
    });
  });

  // Mobile nav drawer (hamburger menu, phones & tablets in portrait)
  const menuToggleBtn = document.getElementById('btn-mobile-menu');
  const menuCloseBtn = document.getElementById('btn-mobile-menu-close');
  const menuOverlay = document.getElementById('mobile-nav-overlay');
  if (menuToggleBtn) menuToggleBtn.addEventListener('click', openMobileMenu);
  if (menuCloseBtn) menuCloseBtn.addEventListener('click', closeMobileMenu);
  if (menuOverlay) menuOverlay.addEventListener('click', closeMobileMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMobileMenu();
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 800) closeMobileMenu();
  });

  // Re-fit the Overview teasers whenever the viewport (and so the hero's
  // rendered size) changes — debounced since resize fires continuously
  // while dragging a window edge.
  let overviewFitResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(overviewFitResizeTimer);
    overviewFitResizeTimer = setTimeout(fitOverviewSideLists, 150);
  });

  // Collapsible sidebar (desktop) — click any empty area of the rail itself
  // (not a nav item, the user badge, or logout) to toggle collapsed state.
  applySidebarCollapsedState(localStorage.getItem('sidebar-collapsed') === 'true');
  const sidebarEl = document.getElementById('sidebar');
  if (sidebarEl) {
    sidebarEl.addEventListener('click', (e) => {
      if (e.target.closest('.nav-item, .btn-logout, .user-badge, .sidebar-mini-player')) return;
      const collapsed = !sidebarEl.classList.contains('collapsed');
      applySidebarCollapsedState(collapsed);
      localStorage.setItem('sidebar-collapsed', String(collapsed));
      // Wait for the collapse transition (0.25s) to finish before
      // re-measuring the hero's now-different width.
      setTimeout(fitOverviewSideLists, 300);
    });
  }

  // Playback transport controls — sidebar mini player and the Overview Now
  // Playing panel each get their own set of prev/play/next/shuffle buttons,
  // wired up identically (stopPropagation so the sidebar's set doesn't also
  // trigger the click-anywhere sidebar collapse toggle above).
  TRANSPORT_BUTTON_SETS.forEach(({ prev, play, next, shuffle }) => {
    const prevBtn = document.getElementById(prev);
    const playBtn = document.getElementById(play);
    const nextBtn = document.getElementById(next);
    const shuffleBtn = document.getElementById(shuffle);

    if (prevBtn) {
      prevBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        playbackControl('POST', '/me/player/previous');
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        playbackControl('POST', '/me/player/next');
      });
    }
    if (playBtn) {
      playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasPlaying = nowPlayingState.isPlaying;
        // Optimistic flip so the button feels instant instead of waiting on the network.
        nowPlayingState.isPlaying = !wasPlaying;
        updateAllPlayIcons();
        const badge = document.getElementById('now-playing-status-badge');
        if (badge) badge.classList.toggle('hidden', !nowPlayingState.isPlaying);
        playbackControl('PUT', wasPlaying ? '/me/player/pause' : '/me/player/play');
      });
    }
    if (shuffleBtn) {
      shuffleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleShuffle();
      });
    }
  });

  // Time Range filters
  document.querySelectorAll('.time-filter-btn').forEach(button => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.time-filter-btn').forEach(btn => btn.classList.remove('active'));
      button.classList.add('active');
      currentRange = button.getAttribute('data-range');

      // Reload current tab content with new range
      if (currentTab === 'tracks') {
        loadTopTracks(true);
      } else if (currentTab === 'artists') {
        loadTopArtists(true);
      }
    });
  });

  // View toggle buttons (Grid vs List) — an explicit click is a deliberate
  // choice, so it's persisted and wins over the mobile/desktop default from
  // here on.
  document.querySelectorAll('.view-toggle-btn').forEach(button => {
    button.addEventListener('click', () => {
      currentView = button.getAttribute('data-view');
      localStorage.setItem('view-mode', currentView);
      updateViewToggleButtons();

      // Re-render active tab if it's tracks, artists, or recent
      if (currentTab === 'tracks') {
        renderTopTracks(appData.topTracks[currentRange]);
      } else if (currentTab === 'artists') {
        renderTopArtists(appData.topArtists[currentRange] || appData.topArtists['medium_term']);
      } else if (currentTab === 'recent') {
        renderRecentlyPlayed(appData.recentlyPlayed);
      }
    });
  });

  // Global timeframe control for the Analysis tab's "Your Top 50 (Selected
  // Range)" section — one control drives every range-based card there.
  document.querySelectorAll('.top50-range-btn').forEach(button => {
    button.addEventListener('click', () => {
      const range = button.getAttribute('data-range');
      if (range === analysisRange) return;

      analysisRange = range;
      updateTop50RangeControl();
      loadAnalysisTab();
    });
  });

  // Artist search input field — the clear button mirrors the input's own
  // text, so there's nothing else to keep in sync (no separate "Filter: x"
  // badge to duplicate what's already visible in the field).
  const searchInput = document.getElementById('artist-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      artistFilter = e.target.value;
      document.getElementById('btn-clear-artist-filter').classList.toggle('hidden', !artistFilter);
      renderTopArtists(appData.topArtists[currentRange] || appData.topArtists['medium_term']);
    });
  }

  // Clear artist filter button
  const clearFilterBtn = document.getElementById('btn-clear-artist-filter');
  if (clearFilterBtn) {
    clearFilterBtn.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      artistFilter = '';
      clearFilterBtn.classList.add('hidden');
      renderTopArtists(appData.topArtists[currentRange] || appData.topArtists['medium_term']);
    });
  }

  // Track search input field
  const trackSearchInput = document.getElementById('track-search-input');
  if (trackSearchInput) {
    trackSearchInput.addEventListener('input', (e) => {
      trackFilter = e.target.value;
      document.getElementById('btn-clear-track-filter').classList.toggle('hidden', !trackFilter);
      renderTopTracks(appData.topTracks[currentRange] || appData.topTracks['medium_term']);
    });
  }

  // Global search tab (search input + type filter chips)
  initSearchTab();

  // Clear track filter button
  const clearTrackFilterBtn = document.getElementById('btn-clear-track-filter');
  if (clearTrackFilterBtn) {
    clearTrackFilterBtn.addEventListener('click', () => {
      if (trackSearchInput) trackSearchInput.value = '';
      trackFilter = '';
      clearTrackFilterBtn.classList.add('hidden');
      renderTopTracks(appData.topTracks[currentRange] || appData.topTracks['medium_term']);
    });
  }

  // Logout event listeners (desktop sidebar + mobile top bar)
  document.querySelectorAll('.btn-logout').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      logout();
    });
  });

  // Login event listener — kicks off the client-side PKCE redirect to Spotify
  const loginBtn = document.getElementById('btn-login');
  if (loginBtn) {
    loginBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        await SpotifyAuth.connectSpotify();
      } catch (err) {
        console.error('Failed to start Spotify login:', err);
        showError(err.message === 'missing_client_id' ? 'missing_client_id' : 'failed_connection');
      }
    });
  }
}

// Keeps the grid/list toggle buttons' active state + aria-pressed in sync
// with `currentView`.
function updateViewToggleButtons() {
  document.querySelectorAll('.view-toggle-btn').forEach((btn) => {
    const isActive = btn.getAttribute('data-view') === currentView;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });
}

// Switch tabs logic
function switchTab(tabId) {
  currentTab = tabId;
  closeHeaderSearchDropdown();
  updateMiniPlayerVisibility();

  if (!isApplyingHistoryNavigation) {
    const url = `#/${tabId}`;
    if (window.location.hash !== url) {
      history.pushState({ tab: tabId }, '', url);
    }
  }

  // Stop any playing audio preview on tab switch to prevent ghost audio
  if (activeAudio) {
    activeAudio.pause();
    activeAudio = null;
    activePlayButton = null;
    activeTrackCard = null;
  }
  
  // Update sidebar active state
  document.querySelectorAll('.nav-item').forEach(btn => {
    if (btn.getAttribute('data-tab') === tabId) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // Hide the persistent header search on the Search tab itself — it already
  // has its own, more prominent search box.
  const headerSearchWrapper = document.getElementById('header-search-wrapper');
  if (headerSearchWrapper) headerSearchWrapper.classList.toggle('hidden', tabId === 'search');

  // Show/Hide time range filter and view toggle controls
  const timeFilter = document.getElementById('time-filter-container');
  const viewToggle = document.getElementById('view-toggle-container');

  // Analysis cards each have their own timeframe filter now, so the shared
  // header time filter is only relevant for tracks/artists.
  if (tabId === 'tracks' || tabId === 'artists') {
    timeFilter.classList.remove('hidden');
  } else {
    timeFilter.classList.add('hidden');
  }

  if (tabId === 'tracks' || tabId === 'artists' || tabId === 'recent') {
    viewToggle.classList.remove('hidden');
    updateViewToggleButtons();
  } else {
    viewToggle.classList.add('hidden');
  }

  // Update header title — human-facing labels (matching the sidebar nav
  // text), not the old terminal-identifier style ("now-playing", "top-tracks").
  const titles = {
    overview: 'Now Playing',
    search: 'Search',
    tracks: 'Top Tracks',
    artists: 'Top Artists',
    analysis: 'Analysis',
    recent: 'Recent'
  };
  document.getElementById('current-tab-title').textContent = titles[tabId] || 'Dashboard';

  // Toggle tab panels
  document.querySelectorAll('.tab-pane').forEach(pane => {
    pane.classList.remove('active');
  });
  document.getElementById(`tab-${tabId}`).classList.add('active');

  // Analysis needs live data the saved copy doesn't include.
  const analysisBlocked = dataSource === 'snapshot';
  document.getElementById('tab-analysis').classList.toggle('is-offline-unavailable', analysisBlocked);
  document.getElementById('analysis-offline-note').classList.toggle('hidden', !analysisBlocked);

  // Load tab data
  if (tabId === 'overview') {
    renderOverview();
  } else if (tabId === 'search') {
    renderLocalSearchResults();
  } else if (tabId === 'tracks') {
    loadTopTracks();
  } else if (tabId === 'artists') {
    loadTopArtists();
  } else if (tabId === 'analysis') {
    if (!analysisBlocked) loadAnalysisTab();
  } else if (tabId === 'recent') {
    loadRecentlyPlayed();
  }

  refreshFreshnessLabel();
}

// Load and cache all initial dashboard data. Resolves true if the dashboard
// now shows live data. Concurrent calls share one load.
function loadDashboard() {
  if (!dashboardLoadPromise) {
    dashboardLoadPromise = loadDashboardOnce().finally(() => { dashboardLoadPromise = null; });
  }
  return dashboardLoadPromise;
}

function renderUserBar(profile) {
  document.getElementById('user-name').textContent = profile.display_name;
  const avatarUrl = profile.images && profile.images.length > 0
    ? profile.images[0].url
    : 'https://via.placeholder.com/40';
  const avatar = document.getElementById('user-avatar');
  avatar.src = avatarUrl;
  avatar.alt = 'Avatar';
  document.getElementById('user-account-type').textContent = String(profile.product || '').toUpperCase();
}

// Shared tail of a live load and a snapshot restore.
function showDashboardContent() {
  renderUserBar(appData.profile);
  renderOverview();
  startNowPlayingPolling();
  if (routingInitialised) {
    // Already showing a tab: re-apply it now the data source may have changed.
    isApplyingHistoryNavigation = true;
    switchTab(currentTab);
    isApplyingHistoryNavigation = false;
  } else {
    initRouting();
  }
  refreshFreshnessLabel();
}

// Offline reopen: show the last-known copy, clearly labelled. Only ever
// used while this browser still holds a Spotify connection, so a saved copy
// can't be seen by someone who has logged out (which also deletes it).
function restoreFromSnapshot(reachable) {
  if (!SpotifyAuth.isConnected()) return false;
  const snapshot = SoundTracksSnapshot.load();
  if (!snapshot) return false;

  appData.profile = snapshot.profile;
  appData.recentlyPlayed = snapshot.recentlyPlayed;
  appData.topTracks = { medium_term: snapshot.topTracks };
  appData.topArtists = { medium_term: snapshot.topArtists };
  dataSource = 'snapshot';
  ['recent', 'tracks:medium_term', 'artists:medium_term'].forEach((key) => { dataStamps[key] = snapshot.savedAt; });

  showDashboardContent();
  showOfflineBanner({ reachable });
  return true;
}

async function loadDashboardOnce() {
  sessionActive = true;
  showDashboardScreen();
  hideDashboardError();

  if (!navigator.onLine) {
    // Don't wait for requests that can only fail.
    if (restoreFromSnapshot(false)) return false;
    startNowPlayingPolling(); // shows the offline message, resumes on reconnect
    return false;
  }

  try {
    // Fetch profile, recently played, and default ranges for initial display
    const [profileRes, recentRes, tracksRes, artistsRes] = await Promise.all([
      spotifyFetch('/me'),
      spotifyFetch('/me/player/recently-played?limit=50'),
      spotifyFetch(`/me/top/tracks?time_range=medium_term&limit=50`),
      spotifyFetch(`/me/top/artists?time_range=medium_term&limit=50`)
    ]);

    appData.profile = await profileRes.json();
    appData.recentlyPlayed = await recentRes.json();
    appData.topTracks['medium_term'] = await tracksRes.json();
    appData.topArtists['medium_term'] = await artistsRes.json();

    // This live copy replaces any saved one (a snapshot is only ever the
    // most recent successful load, and never mixed with live values).
    dataSource = 'live';
    ['recent', 'tracks:medium_term', 'artists:medium_term'].forEach((key) => { dataStamps[key] = Date.now(); });
    SoundTracksSnapshot.save({
      profile: appData.profile,
      topTracks: appData.topTracks['medium_term'],
      topArtists: appData.topArtists['medium_term'],
      recentlyPlayed: appData.recentlyPlayed
    });

    showDashboardContent();
    return true;

  } catch (err) {
    console.error('Error fetching dashboard data:', err);
    // An expired/invalid refresh token is a genuine "you need to log back
    // in" — spotifyFetch already cleared tokens and swapped to the login
    // screen for that case. Anything else (a rate limit, a network blip) is
    // transient and shouldn't cost the user their session — show a retry
    // instead of logging them out over it.
    if (err.isUnauthorized) return false; // endSession already showed sign-in

    if (err.isNetworkError && err.status !== 429) {
      // Can't reach Spotify: fall back to the saved copy if there is one.
      // and either way explain it once, in the global banner (which has Retry).
      if (!appData.profile && restoreFromSnapshot(!err.offline)) return false;
      showOfflineBanner({ reachable: !err.offline });
    } else if (err.status !== 429) {
      // (A 429 already has the global rate-limit banner; no second one.)
      showDashboardError('Failed to load your dashboard data. This is usually temporary — try again.');
    }
    return false;
  }
}

function showDashboardError(message) {
  const banner = document.getElementById('dashboard-error-banner');
  const text = document.getElementById('dashboard-error-text');
  if (text) text.textContent = message;
  if (banner) banner.classList.remove('hidden');
}

function hideDashboardError() {
  const banner = document.getElementById('dashboard-error-banner');
  if (banner) banner.classList.add('hidden');
}

// RENDER OVERVIEW TAB
function renderOverview() {
  if (!appData.profile || !appData.recentlyPlayed) return;
  fitOverviewSideLists();
}

// Builds one mini-track-item row shared by the Up Next and Recently Played
// teasers; metaHtml is the trailing bit (relative time, or nothing).
function buildMiniTrackItem(track, metaHtml) {
  const cover = track.album && track.album.images && track.album.images.length > 0
    ? track.album.images[0].url
    : 'https://via.placeholder.com/44';
  const artistsName = (track.artists || []).map(a => a.name).join(', ');

  const div = document.createElement('div');
  div.className = 'mini-track-item';
  div.innerHTML = `
    <img class="mini-track-cover" src="${cover}" alt="${track.name}">
    <div class="mini-track-info">
      <span class="mini-track-title">${track.name}</span>
      <span class="mini-track-artist">${artistsName}</span>
    </div>
    ${metaHtml || ''}
  `;
  return div;
}

function renderRecentListCount(count) {
  const list = document.getElementById('overview-recent-list');
  if (!list) return;
  const recent = appData.recentlyPlayed;
  if (!recent || !recent.items) return;

  list.innerHTML = '';
  recent.items.slice(0, count).forEach(item => {
    const metaHtml = `<div class="mini-track-meta"><span>${formatRelativeTime(item.played_at)}</span></div>`;
    list.appendChild(buildMiniTrackItem(item.track, metaHtml));
  });
}

function renderQueueListCount(count) {
  const list = document.getElementById('overview-queue-list');
  if (!list) return;

  const upcoming = appData.queue.slice(0, count);
  if (upcoming.length === 0) {
    list.innerHTML = '<div class="loading-inline">Nothing queued right now.</div>';
    return;
  }
  list.innerHTML = '';
  upcoming.forEach((track) => list.appendChild(buildMiniTrackItem(track)));
}

// Fills Up Next / Recently Played with as many real rows as fit alongside
// the hero's actual rendered height, rather than a fixed count that's
// either too sparse on a big screen or overflows on a smaller one. Grows
// each list one row at a time, alternating, measuring the real DOM after
// each addition, and backs off the moment adding a row would make the
// side column taller than the hero column.
const OVERVIEW_LIST_MAX_ITEMS = 12; // sane ceiling regardless of available space
function fitOverviewSideLists() {
  const artCol = document.querySelector('.now-playing-art-col');
  const sideCol = document.querySelector('.now-playing-side-col');
  if (!artCol || !sideCol) return;
  // offsetParent is null while the Overview tab-pane isn't the active one
  // (display:none ancestor) — bail rather than measure a zero-height hero
  // and shrink both lists down to nothing.
  if (!artCol.offsetParent) return;

  // Below this breakpoint the hero stacks into a single column (see
  // style.css), so there's no shared row of height to fit into — just
  // show a small, fixed number and let the page scroll normally.
  if (window.matchMedia('(max-width: 900px)').matches) {
    renderQueueListCount(3);
    renderRecentListCount(3);
    return;
  }

  const target = artCol.getBoundingClientRect().height;
  const queueLen = appData.queue.length;
  const recentLen = (appData.recentlyPlayed && appData.recentlyPlayed.items || []).length;

  let queueCount = Math.min(1, queueLen);
  let recentCount = Math.min(1, recentLen);
  renderQueueListCount(queueCount);
  renderRecentListCount(recentCount);

  let grew = true;
  while (grew && queueCount + recentCount < OVERVIEW_LIST_MAX_ITEMS * 2) {
    grew = false;

    if (queueCount < queueLen && queueCount < OVERVIEW_LIST_MAX_ITEMS) {
      renderQueueListCount(queueCount + 1);
      if (sideCol.getBoundingClientRect().height <= target) {
        queueCount++;
        grew = true;
      } else {
        renderQueueListCount(queueCount);
      }
    }

    if (recentCount < recentLen && recentCount < OVERVIEW_LIST_MAX_ITEMS) {
      renderRecentListCount(recentCount + 1);
      if (sideCol.getBoundingClientRect().height <= target) {
        recentCount++;
        grew = true;
      } else {
        renderRecentListCount(recentCount);
      }
    }
  }
}

// --- NOW PLAYING ---
// Polls /me/player (rather than /me/player/currently-playing) periodically
// for the real state — the extra fields cost nothing extra to fetch and
// /me/player is the only one of the two that reports shuffle_state, which
// the shuffle toggle needs. Also ticks a local timer between polls so the
// progress bar advances smoothly without hammering the API every second.

function startNowPlayingPolling() {
  stopNowPlayingPolling();

  pollNowPlaying();
  nowPlayingPollTimer = setInterval(pollNowPlaying, NOW_PLAYING_POLL_MS);
  nowPlayingTickTimer = setInterval(tickNowPlayingProgress, NOW_PLAYING_TICK_MS);

  // Don't burn API calls / battery polling a tab nobody is looking at.
  document.addEventListener('visibilitychange', handleNowPlayingVisibilityChange);
}

function stopNowPlayingPolling() {
  if (nowPlayingPollTimer) clearInterval(nowPlayingPollTimer);
  if (nowPlayingTickTimer) clearInterval(nowPlayingTickTimer);
  nowPlayingPollTimer = null;
  nowPlayingTickTimer = null;
  document.removeEventListener('visibilitychange', handleNowPlayingVisibilityChange);
}

function handleNowPlayingVisibilityChange() {
  if (document.hidden) {
    if (nowPlayingPollTimer) clearInterval(nowPlayingPollTimer);
    if (nowPlayingTickTimer) clearInterval(nowPlayingTickTimer);
    nowPlayingPollTimer = null;
    nowPlayingTickTimer = null;
  } else if (!nowPlayingPollTimer) {
    pollNowPlaying();
    nowPlayingPollTimer = setInterval(pollNowPlaying, NOW_PLAYING_POLL_MS);
    nowPlayingTickTimer = setInterval(tickNowPlayingProgress, NOW_PLAYING_TICK_MS);
  }
}

async function pollNowPlaying() {
  if (!navigator.onLine) {
    renderNowPlayingOffline();
    return;
  }
  // Hold polling while Spotify has asked us to back off.
  if (Date.now() < rateLimitedUntil) return;

  let response;
  try {
    response = await spotifyFetch('/me/player');
  } catch (err) {
    if (err.status === 403) {
      // Session was authorised before user-read-playback-state existed —
      // needs a fresh login to pick up the new scope.
      stopNowPlayingPolling();
      renderNowPlayingNeedsReconnect();
      return;
    }
    if (err.status === 429 || err.isUnauthorized) return; // handled globally (banner / sign-in)
    if (err.offline) {
      renderNowPlayingOffline();
      return;
    }
    // spotifyFetch already handles 401 (shows login screen). Anything else
    // (network blip, rate limit) retries silently at first — persistent
    // failures get a visible error instead of leaving stale/stuck content
    // with no explanation.
    nowPlayingConsecutiveFailures++;
    if (nowPlayingConsecutiveFailures >= NOW_PLAYING_FAILURE_THRESHOLD) {
      renderNowPlayingError();
    }
    return;
  }

  if (response.status === 204) {
    nowPlayingConsecutiveFailures = 0;
    renderNowPlayingIdle();
    return;
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    nowPlayingConsecutiveFailures++;
    if (nowPlayingConsecutiveFailures >= NOW_PLAYING_FAILURE_THRESHOLD) {
      renderNowPlayingError();
    }
    return;
  }

  nowPlayingConsecutiveFailures = 0;

  if (!data || !data.item) {
    renderNowPlayingIdle();
    return;
  }

  await renderNowPlayingActive(data);
}

function renderNowPlayingIdle() {
  nowPlayingState = { trackId: null, isPlaying: false, progressMs: 0, durationMs: 0, lastSyncedAt: 0, contextUri: null, contextName: null, shuffleState: false };
  document.getElementById('now-playing-status-badge').classList.add('hidden');
  document.getElementById('now-playing-content').innerHTML =
    '<div class="loading-inline">Nothing is playing, and no active Spotify device was found. Open Spotify on a device and press play.</div>';
  hideSidebarMiniPlayer();
}

function renderNowPlayingNeedsReconnect() {
  document.getElementById('now-playing-status-badge').classList.add('hidden');
  document.getElementById('now-playing-content').innerHTML =
    '<div class="loading-inline">Reconnect your Spotify account to enable Now Playing (needs one extra permission).</div>';
  hideSidebarMiniPlayer();
}

function renderNowPlayingOffline() {
  document.getElementById('now-playing-status-badge').classList.add('hidden');
  document.getElementById('now-playing-content').innerHTML =
    '<div class="loading-inline">You&rsquo;re offline, so playback can&rsquo;t be shown. Now Playing resumes when you&rsquo;re back online.</div>';
  hideSidebarMiniPlayer();
}

function renderNowPlayingError() {
  document.getElementById('now-playing-status-badge').classList.add('hidden');
  document.getElementById('now-playing-content').innerHTML = `
    <div class="loading-inline" role="alert">Couldn&rsquo;t check playback right now.</div>
    <button type="button" id="now-playing-retry-btn" class="btn btn-secondary btn-sm margin-top">Retry</button>
  `;
  hideSidebarMiniPlayer();
}

async function renderNowPlayingActive(data) {
  const track = data.item;
  const isNewTrack = track.id !== nowPlayingState.trackId;
  const contextUri = data.context ? data.context.uri : null;
  const isNewContext = contextUri !== nowPlayingState.contextUri;

  nowPlayingState.trackId = track.id;
  nowPlayingState.isPlaying = Boolean(data.is_playing);
  nowPlayingState.progressMs = data.progress_ms || 0;
  nowPlayingState.durationMs = track.duration_ms || 0;
  nowPlayingState.lastSyncedAt = Date.now();
  nowPlayingState.contextUri = contextUri;
  nowPlayingState.shuffleState = Boolean(data.shuffle_state);

  if (isNewContext) {
    nowPlayingState.contextName = null; // cleared until (if) the fetch below resolves
    if (data.context) {
      fetchNowPlayingContextName(data.context, contextUri);
    }
  }

  const badge = document.getElementById('now-playing-status-badge');
  badge.classList.toggle('hidden', !nowPlayingState.isPlaying);

  const cover = track.album.images && track.album.images.length > 0
    ? track.album.images[0].url
    : 'https://via.placeholder.com/64';
  const artistsName = track.artists.map((a) => a.name).join(', ');

  if (isNewTrack || !document.getElementById('now-playing-track')) {
    const spotifyUrl = track.external_urls.spotify;

    document.getElementById('now-playing-content').innerHTML = `
      <div class="now-playing-body">
        <div class="now-playing-info">
          <a id="now-playing-track" class="now-playing-title" href="${spotifyUrl}" target="_blank" rel="noopener noreferrer" title="${track.name}">${track.name}</a>
          <span class="now-playing-artist">${artistsName}</span>
          <span id="now-playing-context" class="now-playing-context">${nowPlayingState.contextName ? `Playing from: ${nowPlayingState.contextName}` : ''}</span>
          <div class="now-playing-progress-wrapper">
            <div class="now-playing-progress-bar"><div id="now-playing-progress-fill" class="now-playing-progress-fill"></div></div>
            <div class="now-playing-times">
              <span id="now-playing-elapsed">0:00</span>
              <span id="now-playing-duration">${formatDuration(nowPlayingState.durationMs)}</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  renderNowPlayingArtTile(cover, track.name);
  renderSidebarMiniPlayer(track, cover, artistsName);
  showNowPlayingControls();
  updateAllPlayIcons();
  updateAllShuffleButtons();
  nowPlayingPollCount++;
  refreshQueue(isNewTrack);

  updateNowPlayingProgressUI();
}

// --- SIDEBAR MINI PLAYER ---
// Compact echo of the Overview Now Playing panel, shown above the user's
// name in the sidebar footer: cover, track/artist, and skip controls. Hidden
// on the Now Playing tab itself (the hero there already shows all of this),
// shown on every other tab whenever something is actually playing.
let hasActiveNowPlayingTrack = false;

function updateMiniPlayerVisibility() {
  const panel = document.getElementById('sidebar-mini-player');
  if (!panel) return;
  panel.classList.toggle('hidden', !hasActiveNowPlayingTrack || currentTab === 'overview');
}

function renderSidebarMiniPlayer(track, cover, artistsName) {
  const panel = document.getElementById('sidebar-mini-player');
  if (!panel) return;
  hasActiveNowPlayingTrack = true;
  updateMiniPlayerVisibility();

  const coverEl = document.getElementById('mini-player-cover');
  const trackEl = document.getElementById('mini-player-track');
  const artistEl = document.getElementById('mini-player-artist');
  if (coverEl) { coverEl.src = cover; coverEl.alt = track.name; }
  if (trackEl) { trackEl.textContent = track.name; trackEl.title = track.name; }
  if (artistEl) { artistEl.textContent = artistsName; artistEl.title = artistsName; }
}

function hideSidebarMiniPlayer() {
  hasActiveNowPlayingTrack = false;
  const panel = document.getElementById('sidebar-mini-player');
  if (panel) panel.classList.add('hidden');
  hideNowPlayingControls();
  hideNowPlayingArtTile();
  nowPlayingPollCount = 0;
  appData.queue = [];
  fitOverviewSideLists();
}

// Big cover-art tile on Overview, in the teaser row (replaces the old Top
// Genres slot) — shows the currently-playing track's artwork large, with a
// placeholder icon when nothing's playing.
function renderNowPlayingArtTile(cover, trackName) {
  const img = document.getElementById('now-playing-cover-large');
  const placeholder = document.getElementById('now-playing-art-placeholder');
  if (!img || !placeholder) return;
  img.src = cover;
  img.alt = trackName;
  img.classList.remove('hidden');
  placeholder.classList.add('hidden');
}

function hideNowPlayingArtTile() {
  const img = document.getElementById('now-playing-cover-large');
  const placeholder = document.getElementById('now-playing-art-placeholder');
  if (img) { img.classList.add('hidden'); img.src = ''; }
  if (placeholder) placeholder.classList.remove('hidden');
}

function showNowPlayingControls() {
  const controls = document.getElementById('now-playing-controls');
  if (controls) controls.classList.remove('hidden');
}

function hideNowPlayingControls() {
  const controls = document.getElementById('now-playing-controls');
  if (controls) controls.classList.add('hidden');
}

function updateAllPlayIcons() {
  ['mini-player-play-icon', 'now-playing-play-icon'].forEach((id) => {
    const icon = document.getElementById(id);
    if (!icon) return;
    icon.innerHTML = nowPlayingState.isPlaying
      ? '<path d="M6 5h4v14H6zm8 0h4v14h-4z"></path>'
      : '<path d="M8 5v14l11-7z"></path>';
  });
}

function updateAllShuffleButtons() {
  ['mini-player-shuffle', 'now-playing-shuffle'].forEach((id) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.classList.toggle('active', nowPlayingState.shuffleState);
    btn.setAttribute('aria-pressed', String(nowPlayingState.shuffleState));
  });
}

const QUEUE_REFRESH_EVERY_N_POLLS = 4; // ~20s at the 5s poll interval

async function refreshQueue(force) {
  if (!force && nowPlayingPollCount % QUEUE_REFRESH_EVERY_N_POLLS !== 0) return;

  try {
    const response = await spotifyFetch('/me/player/queue');
    const data = await response.json();
    appData.queue = data.queue || [];
    fitOverviewSideLists();
  } catch (err) {
    // Needs user-read-playback-state (older sessions won't have it yet) —
    // just leave the queue preview empty rather than erroring.
  }
}

// Playback transport controls — shared between the sidebar mini player and
// the Overview Now Playing panel, which each have their own button/error IDs.
const TRANSPORT_BUTTON_SETS = [
  { prev: 'mini-player-prev', play: 'mini-player-play', next: 'mini-player-next', shuffle: 'mini-player-shuffle', error: 'mini-player-error' },
  { prev: 'now-playing-prev', play: 'now-playing-play', next: 'now-playing-next', shuffle: 'now-playing-shuffle', error: 'now-playing-controls-error' },
];

async function playbackControl(method, path) {
  if (miniPlayerControlPending) return;
  miniPlayerControlPending = true;
  setAllControlsDisabled(true);
  hideAllControlErrors();

  try {
    await SpotifyAuth.apiRequest(path, { method });
    // Optimistic UI updates instantly (see button handlers); this just
    // resyncs the exact state once Spotify has actually applied the change.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await pollNowPlaying();
  } catch (err) {
    showAllControlErrors(playbackErrorMessage(err, 'Playback control failed.'));
  } finally {
    miniPlayerControlPending = false;
    setAllControlsDisabled(false);
  }
}

function setAllControlsDisabled(disabled) {
  TRANSPORT_BUTTON_SETS.forEach(({ prev, play, next, shuffle }) => {
    [prev, play, next, shuffle].forEach((id) => {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = disabled;
    });
  });
}

async function toggleShuffle() {
  const target = !nowPlayingState.shuffleState;
  nowPlayingState.shuffleState = target; // optimistic
  updateAllShuffleButtons();
  await playbackControl('PUT', `/me/player/shuffle?state=${target}`);
}

let controlErrorTimer = null;
function showAllControlErrors(message) {
  TRANSPORT_BUTTON_SETS.forEach(({ error }) => {
    const el = document.getElementById(error);
    if (!el) return;
    el.textContent = message;
    el.classList.remove('hidden');
  });
  if (controlErrorTimer) clearTimeout(controlErrorTimer);
  controlErrorTimer = setTimeout(hideAllControlErrors, 4000);
}

function hideAllControlErrors() {
  TRANSPORT_BUTTON_SETS.forEach(({ error }) => {
    const el = document.getElementById(error);
    if (el) el.classList.add('hidden');
  });
  if (controlErrorTimer) { clearTimeout(controlErrorTimer); controlErrorTimer = null; }
}

async function fetchNowPlayingContextName(context, contextUri) {
  if (!context.href) return;
  const path = context.href.replace('https://api.spotify.com/v1', '');

  try {
    const res = await spotifyFetch(path);
    const data = await res.json();
    // Only apply if we're still on the same context (avoids a slow response
    // clobbering a newer track's context after a fast skip).
    if (nowPlayingState.contextUri === contextUri && data.name) {
      nowPlayingState.contextName = data.name;
      const contextEl = document.getElementById('now-playing-context');
      if (contextEl) contextEl.textContent = `Playing from: ${data.name}`;
    }
  } catch (err) {
    // Missing playlist-read-private scope on an older session, a since-deleted
    // playlist, etc. — just leave the context line blank rather than erroring.
  }
}

function tickNowPlayingProgress() {
  if (!nowPlayingState.isPlaying || !nowPlayingState.trackId) return;
  updateNowPlayingProgressUI();
}

function updateNowPlayingProgressUI() {
  const fill = document.getElementById('now-playing-progress-fill');
  const elapsedEl = document.getElementById('now-playing-elapsed');
  const miniFill = document.getElementById('mini-player-progress-fill');
  if ((!fill || !elapsedEl) && !miniFill) return;

  let displayedMs = nowPlayingState.progressMs;
  if (nowPlayingState.isPlaying) {
    displayedMs += Date.now() - nowPlayingState.lastSyncedAt;
  }
  displayedMs = Math.min(displayedMs, nowPlayingState.durationMs);

  const percentage = nowPlayingState.durationMs > 0 ? (displayedMs / nowPlayingState.durationMs) * 100 : 0;
  if (fill) fill.style.width = `${percentage}%`;
  if (elapsedEl) elapsedEl.textContent = formatDuration(displayedMs);
  if (miniFill) miniFill.style.width = `${percentage}%`;
}

// LOAD TOP TRACKS
async function loadTopTracks(forceReload = false) {
  const tbody = document.getElementById('top-tracks-table-body');
  const grid = document.getElementById('top-tracks-grid');
  
  if (!forceReload && appData.topTracks[currentRange]) {
    renderTopTracks(appData.topTracks[currentRange]);
    return true;
  }

  const spinnerHtml = '<div class="loading-inline" style="grid-column: 1/-1;"><div class="spinner" style="height: 30px; width: 30px; margin: 0 auto;"></div></div>';
  tbody.innerHTML = '<tr><td colspan="5" class="loading-inline"><div class="spinner" style="height: 30px; width: 30px; margin: 0 auto;"></div></td></tr>';
  grid.innerHTML = spinnerHtml;

  try {
    const res = await spotifyFetch(`/me/top/tracks?time_range=${currentRange}&limit=50`);
    const data = await res.json();
    appData.topTracks[currentRange] = data;
    markUpdated(`tracks:${currentRange}`);
    renderTopTracks(data);
    return true;
  } catch (err) {
    console.error('Error fetching top tracks:', err.message);
    tbody.innerHTML = localErrorRowHtml(err, 'your top tracks');
    grid.innerHTML = `<div style="grid-column: 1/-1;">${localErrorHtml(err, 'your top tracks')}</div>`;
    return false;
  }
}

function renderTopTracks(data) {
  const tbody = document.getElementById('top-tracks-table-body');
  const grid = document.getElementById('top-tracks-grid');
  const listPanel = document.getElementById('top-tracks-list-panel');

  const query = trackFilter.toLowerCase().trim();
  const items = data && data.items ? data.items : [];
  const filteredItems = query
    ? items.filter(track => 
        track.name.toLowerCase().includes(query) || 
        track.artists.some(a => a.name.toLowerCase().includes(query)) ||
        track.album.name.toLowerCase().includes(query)
      )
    : items;

  if (currentView === 'grid') {
    grid.classList.remove('hidden');
    listPanel.classList.add('hidden');
    renderTracksGrid(grid, filteredItems, 'tracks');
  } else {
    grid.classList.add('hidden');
    listPanel.classList.remove('hidden');
    
    tbody.innerHTML = '';
    if (filteredItems.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="loading-inline">${query ? 'No tracks match your search or filter criteria.' : 'No tracks found for this period. Keep listening!'}</td></tr>`;
      return;
    }

    filteredItems.forEach((track) => {
      const originalRank = items.findIndex(t => t.id === track.id) + 1;
      const cover = track.album.images && track.album.images.length > 0 
        ? track.album.images[0].url 
        : 'https://via.placeholder.com/48';
      const artistsName = track.artists.map(a => a.name).join(', ');
      const spotifyUrl = track.external_urls.spotify;
      const albumUrl = track.album.external_urls.spotify;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${originalRank}</td>
        <td>
          <div class="track-row-cell">
            <img class="track-row-cover" src="${cover}" alt="${track.name}">
            <div class="track-row-details">
              <a class="track-row-title" href="${spotifyUrl}" target="_blank" rel="noopener noreferrer">${track.name}</a>
              <span class="track-row-artist">${artistsName}</span>
            </div>
          </div>
        </td>
        <td>
          <a class="album-link" href="${albumUrl}" target="_blank" rel="noopener noreferrer">${track.album.name}</a>
        </td>
        <td aria-label="Popularity: ${track.popularity}%">
          <div class="popularity-meter" title="${track.popularity}% popularity">
            <div class="popularity-fill" style="width: ${track.popularity}%"></div>
          </div>
        </td>
        <td style="text-align: right;" aria-label="Duration: ${formatDuration(track.duration_ms)}">${formatDuration(track.duration_ms)}</td>
      `;
      tbody.appendChild(tr);
    });
  }
}

// LOAD TOP ARTISTS
async function loadTopArtists(forceReload = false) {
  const grid = document.getElementById('top-artists-grid');
  const tbody = document.getElementById('top-artists-table-body');

  if (!forceReload && appData.topArtists[currentRange]) {
    renderTopArtists(appData.topArtists[currentRange]);
    return true;
  }

  const spinnerHtml = '<div class="loading-inline" style="grid-column: 1/-1;"><div class="spinner" style="height: 30px; width: 30px; margin: 0 auto;"></div></div>';
  grid.innerHTML = spinnerHtml;
  tbody.innerHTML = '<tr><td colspan="5" class="loading-inline"><div class="spinner" style="height: 30px; width: 30px; margin: 0 auto;"></div></td></tr>';

  try {
    const res = await spotifyFetch(`/me/top/artists?time_range=${currentRange}&limit=50`);
    const data = await res.json();
    appData.topArtists[currentRange] = data;
    markUpdated(`artists:${currentRange}`);
    renderTopArtists(data);
    return true;
  } catch (err) {
    console.error('Error fetching top artists:', err.message);
    grid.innerHTML = `<div style="grid-column: 1/-1;">${localErrorHtml(err, 'your top artists')}</div>`;
    tbody.innerHTML = localErrorRowHtml(err, 'your top artists');
    return false;
  }
}

function renderTopArtists(data) {
  const grid = document.getElementById('top-artists-grid');
  const tbody = document.getElementById('top-artists-table-body');
  const listPanel = document.getElementById('top-artists-list-panel');

  if (!data || !data.items || data.items.length === 0) {
    const emptyMsg = 'No artists found for this period. Keep listening!';
    grid.innerHTML = `<div class="loading-inline" style="grid-column: 1/-1;">${emptyMsg}</div>`;
    tbody.innerHTML = `<tr><td colspan="5" class="loading-inline">${emptyMsg}</td></tr>`;
    return;
  }

  // Filter items based on active artist filter query
  const query = artistFilter.toLowerCase().trim();
  const filteredItems = query
    ? data.items.filter(artist =>
        artist.name.toLowerCase().includes(query) ||
        artist.genres.some(genre => genre.toLowerCase().includes(query))
      )
    : data.items;

  if (filteredItems.length === 0) {
    const emptyMsg = 'No artists match your search or filter criteria.';
    grid.innerHTML = `<div class="loading-inline" style="grid-column: 1/-1;">${emptyMsg}</div>`;
    tbody.innerHTML = `<tr><td colspan="5" class="loading-inline">${emptyMsg}</td></tr>`;
    return;
  }

  if (currentView === 'grid') {
    grid.classList.remove('hidden');
    listPanel.classList.add('hidden');
    renderArtistsGrid(grid, filteredItems, data.items);
  } else {
    grid.classList.add('hidden');
    listPanel.classList.remove('hidden');
    renderArtistsList(tbody, filteredItems, data.items);
  }
}

function renderArtistsGrid(grid, filteredItems, allItems) {
  grid.innerHTML = '';

  filteredItems.forEach((artist) => {
    // Find index of the original item to keep the rank correct
    const originalRank = allItems.findIndex(a => a.id === artist.id) + 1;
    const photo = artist.images && artist.images.length > 0
      ? artist.images[0].url
      : 'https://via.placeholder.com/150';
    const mainGenre = artist.genres && artist.genres.length > 0 ? artist.genres[0] : 'Various';
    const spotifyUrl = artist.external_urls.spotify;

    const div = document.createElement('div');
    div.className = 'track-card'; // Reuse track card class to match layout exactly
    div.innerHTML = `
      <div class="track-card-cover-container">
        <img class="track-card-cover" src="${photo}" alt="${escapeHtml(artist.name)}">
        <div class="track-card-play-overlay">
          <a class="btn-play-preview btn-spotify-link" href="${spotifyUrl}" target="_blank" rel="noopener noreferrer" title="Open in Spotify" aria-label="Open ${escapeHtml(artist.name)} on Spotify">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm4.586 14.424c-.18.295-.565.387-.86.207-2.377-1.454-5.37-1.783-8.894-.982-.336.077-.67-.137-.747-.473-.077-.337.137-.67.473-.748 3.854-.88 7.15-.502 9.822 1.135.296.18.387.565.206.86zm1.223-2.72c-.227.367-.707.487-1.074.26-2.72-1.672-6.866-2.155-10.073-1.182-.413.125-.847-.107-.972-.52-.125-.413.108-.847.52-.972 3.666-1.112 8.225-.573 11.338 1.34.368.226.488.706.26 1.074zm.107-2.825C14.502 8.84 9.17 8.663 6.074 9.603c-.522.158-1.074-.142-1.233-.664-.158-.522.142-1.074.664-1.233 3.563-1.082 9.44-.88 13.34 1.436.47.278.623.882.345 1.352-.278.47-.882.622-1.352.345z"/></svg>
          </a>
        </div>
        <span class="track-card-rank">#${originalRank}</span>
      </div>
      <div class="track-card-details">
        <a class="track-card-title" href="${spotifyUrl}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(artist.name)}">${escapeHtml(artist.name)}</a>
        <span class="track-card-artist" style="text-transform: capitalize;">${escapeHtml(mainGenre)}</span>
        <span class="track-card-album">${formatFollowers(artist.followers.total)} followers</span>
        <div class="track-card-meta">
          <div class="popularity-info">
            <div class="popularity-meter" style="width: 50px; margin-right: 4px;" title="${artist.popularity}% popularity">
              <div class="popularity-fill" style="width: ${artist.popularity}%"></div>
            </div>
            <span class="popularity-val" style="font-size: 0.75rem;">${artist.popularity}%</span>
          </div>
          <span style="font-size: 0.75rem; color: var(--dim); font-family: var(--mono);">ARTIST</span>
        </div>
      </div>
    `;
    grid.appendChild(div);
  });
}

function renderArtistsList(tbody, filteredItems, allItems) {
  tbody.innerHTML = '';

  filteredItems.forEach((artist) => {
    const originalRank = allItems.findIndex(a => a.id === artist.id) + 1;
    const photo = artist.images && artist.images.length > 0
      ? artist.images[0].url
      : 'https://via.placeholder.com/48';
    const mainGenre = artist.genres && artist.genres.length > 0 ? artist.genres[0] : 'Various';
    const spotifyUrl = artist.external_urls.spotify;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${originalRank}</td>
      <td>
        <div class="track-row-cell">
          <img class="track-row-cover" src="${photo}" alt="${artist.name}" style="border-radius: 50%;">
          <div class="track-row-details">
            <a class="track-row-title" href="${spotifyUrl}" target="_blank" rel="noopener noreferrer">${artist.name}</a>
          </div>
        </div>
      </td>
      <td style="text-transform: capitalize;">${mainGenre}</td>
      <td aria-label="Followers: ${formatFollowers(artist.followers.total)}">${formatFollowers(artist.followers.total)}</td>
      <td style="text-align: right;" aria-label="Popularity: ${artist.popularity}%">
        <div class="popularity-info" style="justify-content: flex-end;">
          <div class="popularity-meter" title="${artist.popularity}% popularity">
            <div class="popularity-fill" style="width: ${artist.popularity}%"></div>
          </div>
          <span class="popularity-val">${artist.popularity}%</span>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// Load data for analysis tab and render
const TOP50_RANGE_LABELS = { short_term: '4 weeks', medium_term: '6 months', long_term: 'all time' };
const TOP50_RANGE_HEADINGS = { short_term: 'Last 4 Weeks', medium_term: 'Last 6 Months', long_term: 'All Time' };

// Keeps the global range control's active button and the section heading in
// sync with `analysisRange`. Called on click and once on initial load.
function updateTop50RangeControl() {
  document.querySelectorAll('.top50-range-btn').forEach(btn => {
    const isActive = btn.getAttribute('data-range') === analysisRange;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });

  const titleEl = document.getElementById('top50-section-title');
  if (titleEl) titleEl.textContent = `Your Top 50 · ${TOP50_RANGE_HEADINGS[analysisRange] || 'Last 6 Months'}`;
}

// Loads (or reuses cached) Top 50 data for the Analysis tab's selected-range
// section, then renders it. Last-50 (recent-stream) metrics/charts are
// range-independent and always re-rendered immediately.
async function loadAnalysisTab(forceReload = false) {
  renderLast50AnalysisMetrics();
  updateTop50RangeControl();

  const range = analysisRange;
  const requestToken = ++analysisRangeToken;
  const needsArtists = forceReload || !appData.topArtists[range];
  const needsTracks = forceReload || !appData.topTracks[range];
  const section = document.getElementById('top50-section');
  const statusEl = document.getElementById('top50-range-status');

  if (needsArtists || needsTracks) {
    if (section) section.classList.add('is-loading');
    if (statusEl) statusEl.classList.remove('hidden');

    try {
      const promises = [];
      if (needsArtists) {
        promises.push(
          spotifyFetch(`/me/top/artists?time_range=${range}&limit=50`)
            .then(res => res.json())
            .then(data => { appData.topArtists[range] = data; })
        );
      }
      if (needsTracks) {
        promises.push(
          spotifyFetch(`/me/top/tracks?time_range=${range}&limit=50`)
            .then(res => res.json())
            .then(data => { appData.topTracks[range] = data; })
        );
      }
      await Promise.all(promises);
      if (needsArtists) markUpdated(`artists:${range}`);
      if (needsTracks) markUpdated(`tracks:${range}`);
    } catch (err) {
      console.error('Error fetching analysis data:', err.message);
      // A newer range switch already owns the loading/error UI — leave it alone.
      if (requestToken === analysisRangeToken) {
        if (section) section.classList.remove('is-loading');
        if (statusEl) statusEl.classList.add('hidden');
        const chartContainer = document.getElementById('genres-chart-container');
        const popularityContainer = document.getElementById('popularity-distribution-container');
        if (chartContainer) chartContainer.innerHTML = localErrorHtml(err, 'this analysis');
        if (popularityContainer) popularityContainer.innerHTML = `<div class="loading-inline">${loadFailureText(err, 'this analysis')}</div>`;
      }
      return false;
    }
  }

  // A faster, more recent range switch has already rendered — don't let this
  // stale response overwrite it.
  if (requestToken !== analysisRangeToken) return;

  if (section) section.classList.remove('is-loading');
  if (statusEl) statusEl.classList.add('hidden');
  renderTop50Section(range);
}

// Update data source label for a specific card
function updateDataSourceLabel(elementId, type, rangeLabel) {
  const element = document.getElementById(elementId);
  if (!element) return;

  const labelMap = {
    'genres': `top 50 artists (${rangeLabel})`,
    'track-popularity': `top 50 songs (${rangeLabel})`,
    'artist-popularity': `top 50 artists (${rangeLabel})`,
    'duration': `top 50 songs (${rangeLabel})`,
    'contributing': `top 50 songs (${rangeLabel})`,
    'track-quadrant': `top 50 songs (${rangeLabel})`,
    'artist-quadrant': `top 50 artists (${rangeLabel})`,
    'duration-quadrant': `top 50 songs (${rangeLabel})`,
    'followers-quadrant': `top 50 artists (${rangeLabel})`
  };

  element.textContent = labelMap[type] || `top 50 (${rangeLabel})`;
}

// Render genre distribution and listening profile cards
function renderGenreDistributionCard(activeArtists, rangeLabel) {
  const chartContainer = document.getElementById('genres-chart-container');
  const donutContainer = document.getElementById('genre-donut');
  const tasteTitle = document.getElementById('taste-title');
  const tasteDesc = document.getElementById('taste-description');
  const primaryGenreVal = document.getElementById('genre-stat-primary');
  const uniqueGenresVal = document.getElementById('genre-stat-unique');
  const topShareVal = document.getElementById('genre-stat-share');

  if (!activeArtists || !activeArtists.items || activeArtists.items.length === 0) {
    chartContainer.innerHTML = '<div class="loading-inline">Not enough artist data to display genres. Please listen to more music first.</div>';
    donutContainer.innerHTML = '';
    return;
  }

  const genreCounts = {};
  activeArtists.items.forEach(artist => {
    artist.genres.forEach(genre => {
      genreCounts[genre] = (genreCounts[genre] || 0) + 1;
    });
  });

  const sortedGenres = Object.entries(genreCounts).sort((a, b) => b[1] - a[1]);
  const totalHits = Object.values(genreCounts).reduce((a, b) => a + b, 0);
  const uniqueCount = sortedGenres.length;

  primaryGenreVal.textContent = sortedGenres.length > 0 ? sortedGenres[0][0] : '-';
  uniqueGenresVal.textContent = uniqueCount;
  topShareVal.textContent = sortedGenres.length > 0
    ? `${Math.round((sortedGenres[0][1] / totalHits) * 100)}%`
    : '0%';

  chartContainer.innerHTML = '';
  const displayGenres = sortedGenres.slice(0, 6);

  displayGenres.forEach(([genre, count], index) => {
    const percentage = Math.round((count / totalHits) * 100);
    const bar = document.createElement('div');
    bar.className = 'genre-bar-container interactive-genre-bar';
    bar.title = `Filter artists by ${genre}`;
    bar.setAttribute('role', 'button');
    bar.setAttribute('tabindex', '0');
    bar.setAttribute('aria-label', `Filter artists by ${genre}, ${count} artist${count > 1 ? 's' : ''}, ${percentage}%`);
    bar.innerHTML = `
      <div class="genre-bar-info">
        <span class="genre-bar-name">${String(index + 1).padStart(2, '0')} / ${escapeHtml(genre)}</span>
        <span class="genre-bar-percentage">${count} artist${count > 1 ? 's' : ''} · ${percentage}%</span>
      </div>
      <div class="genre-bar-wrapper">
        <div class="genre-bar-fill" style="width: ${percentage}%"></div>
      </div>
    `;
    bar.addEventListener('click', () => {
      applyGenreFilterToArtists(genre);
    });
    bar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        applyGenreFilterToArtists(genre);
      }
    });
    chartContainer.appendChild(bar);
  });

  renderGenreDonut(sortedGenres, totalHits);

  if (sortedGenres.length === 0) {
    tasteTitle.textContent = 'Insufficient signal';
    tasteDesc.textContent = 'Listen to more artists on Spotify to build a useful genre profile.';
    return;
  }

  const topGenre = sortedGenres[0][0].toLowerCase();
  if (topGenre.includes('rock') || topGenre.includes('metal') || topGenre.includes('grunge')) {
    tasteTitle.textContent = 'High-gain architecture';
    tasteDesc.textContent = 'Guitar-led, rhythm-forward listening with a preference for weight, texture, and strong band dynamics.';
  } else if (topGenre.includes('pop') || topGenre.includes('dance')) {
    tasteTitle.textContent = 'Hook-driven systems';
    tasteDesc.textContent = 'Clean production, immediate melodies, and high-energy arrangements dominate your current listening profile.';
  } else if (topGenre.includes('rap') || topGenre.includes('hip hop') || topGenre.includes('trap')) {
    tasteTitle.textContent = 'Low-end focused';
    tasteDesc.textContent = 'Bass, cadence, and vocal flow are the strongest signals across your top-artist set.';
  } else if (topGenre.includes('indie') || topGenre.includes('alternative') || topGenre.includes('folk')) {
    tasteTitle.textContent = 'Independent signal';
    tasteDesc.textContent = 'Atmospheric arrangements, organic production, and introspective songwriting recur across your taste profile.';
  } else if (topGenre.includes('electronic') || topGenre.includes('house') || topGenre.includes('techno') || topGenre.includes('edm')) {
    tasteTitle.textContent = 'Synthetic runtime';
    tasteDesc.textContent = 'Repetition, detailed sound design, and electronic rhythm form the core of your listening environment.';
  } else if (topGenre.includes('jazz') || topGenre.includes('blues') || topGenre.includes('soul') || topGenre.includes('r&b')) {
    tasteTitle.textContent = 'Harmonic depth';
    tasteDesc.textContent = 'Vocal detail, expressive harmony, and groove carry more weight than genre boundaries in your listening.';
  } else {
    tasteTitle.textContent = 'Distributed taste';
    tasteDesc.textContent = 'Your top artists span a broad set of sub-genres without a single category overwhelming the rest.';
  }
}

// Last 50 Streams metrics + charts — always sourced from recentlyPlayed,
// independent of the Top 50 section's selected range.
function renderLast50AnalysisMetrics() {
  const recentItems = appData.recentlyPlayed?.items || [];
  const recentDurationMs = recentItems.reduce((total, item) => total + item.track.duration_ms, 0);
  const averageDurationMs = recentItems.length > 0 ? recentDurationMs / recentItems.length : 0;
  document.getElementById('genre-metric-plays').textContent = recentItems.length.toLocaleString('en-GB');
  document.getElementById('genre-metric-hours').textContent = formatHours(recentDurationMs);
  document.getElementById('genre-metric-average').textContent = formatDuration(averageDurationMs);

  renderHourlyActivityChart(appData.recentlyPlayed);
  renderDayOfWeekActivityChart(appData.recentlyPlayed);
}

// Renders every card in "Your Top 50 (Selected Range)" from the one shared range.
function renderTop50Section(range) {
  const activeArtists = appData.topArtists[range];
  const activeTracks = appData.topTracks[range];
  const rangeLabel = TOP50_RANGE_LABELS[range] || '6 months';

  renderGenreDistributionCard(activeArtists, rangeLabel);
  updateDataSourceLabel('analysis-genres-source', 'genres', rangeLabel);
  updateDataSourceLabel('analysis-popularity-source', 'track-popularity', rangeLabel);
  updateDataSourceLabel('analysis-artist-popularity-source', 'artist-popularity', rangeLabel);
  updateDataSourceLabel('analysis-duration-source', 'duration', rangeLabel);
  updateDataSourceLabel('analysis-contributing-source', 'contributing', rangeLabel);
  updateDataSourceLabel('analysis-quadrant-source', 'track-quadrant', rangeLabel);
  updateDataSourceLabel('analysis-artist-quadrant-source', 'artist-quadrant', rangeLabel);
  updateDataSourceLabel('analysis-duration-quadrant-source', 'duration-quadrant', rangeLabel);
  updateDataSourceLabel('analysis-followers-quadrant-source', 'followers-quadrant', rangeLabel);

  renderPopularityDistribution(activeTracks);
  renderArtistPopularityDistribution(activeArtists);
  renderDurationDistribution(activeTracks);
  renderTopContributingArtists(activeTracks);
  renderPopularityRankQuadrant(activeTracks);
  renderArtistRankQuadrant(activeArtists);
  renderDurationPopularityQuadrant(activeTracks);
  renderFollowersPopularityQuadrant(activeArtists);

  renderKeyInsights(activeArtists, activeTracks, rangeLabel);
}

// KEY INSIGHTS — a handful of short, plain-language takeaways at the top of
// the Analysis page, derived entirely from data already loaded for the
// Last 50 Streams and Your Top 50 sections (no extra API calls).
function renderKeyInsights(activeArtists, activeTracks, rangeLabel) {
  const list = document.getElementById('key-insights-list');
  if (!list) return;

  const insights = [];
  const recentItems = appData.recentlyPlayed?.items || [];

  // Deliberately no "most active day" insight here: the last-50-streams
  // sample is recency-biased, not a real distribution — whichever day you
  // last had music on all day dominates the count and would misleadingly
  // read as your "habit". The Day-of-Week Activity chart below is honest
  // about being a "last 50 streams" snapshot; a single-sentence claim here
  // isn't.
  if (recentItems.length > 0) {
    const recentDurationMs = recentItems.reduce((total, item) => total + item.track.duration_ms, 0);
    insights.push(`You've logged <strong>${recentItems.length}</strong> plays across <strong>${formatHours(recentDurationMs)}</strong> in your last 50 streams.`);
  }

  if (activeArtists && activeArtists.items && activeArtists.items.length > 0) {
    const genreCounts = {};
    activeArtists.items.forEach((artist) => {
      artist.genres.forEach((genre) => { genreCounts[genre] = (genreCounts[genre] || 0) + 1; });
    });
    const sortedGenres = Object.entries(genreCounts).sort((a, b) => b[1] - a[1]);
    const totalHits = Object.values(genreCounts).reduce((a, b) => a + b, 0);
    if (sortedGenres.length > 0) {
      const [topGenre, topCount] = sortedGenres[0];
      const share = Math.round((topCount / totalHits) * 100);
      insights.push(`Your top genre is <strong>${escapeHtml(topGenre)}</strong>, making up <strong>${share}%</strong> of your top artists (${rangeLabel}).`);
    }
  }

  if (activeTracks && activeTracks.items && activeTracks.items.length > 0) {
    const artistCounts = {};
    activeTracks.items.forEach((track) => {
      track.artists.forEach((artist) => { artistCounts[artist.name] = (artistCounts[artist.name] || 0) + 1; });
    });
    const sortedArtists = Object.entries(artistCounts).sort((a, b) => b[1] - a[1]);
    if (sortedArtists.length > 0 && sortedArtists[0][1] > 1) {
      const [name, count] = sortedArtists[0];
      insights.push(`<strong>${escapeHtml(name)}</strong> shows up on <strong>${count}</strong> of your top tracks (${rangeLabel}) — more than any other artist.`);
    }
  }

  if (insights.length === 0) {
    list.innerHTML = '<li class="key-insight-item loading-inline">Not enough listening data yet for insights — keep listening!</li>';
    return;
  }

  list.innerHTML = insights.map((text) => `<li class="key-insight-item">${text}</li>`).join('');
}

function renderGenreDonut(sortedGenres, totalHits) {
  const container = document.getElementById('genre-donut');
  const palette = ['#cbbaf0', '#aa96d8', '#8773b4', '#67568e', '#4f426c', '#393144'];
  const topGenres = sortedGenres.slice(0, 5);
  const topTotal = topGenres.reduce((sum, [, count]) => sum + count, 0);
  const segments = [...topGenres];

  if (topTotal < totalHits) {
    segments.push(['other', totalHits - topTotal]);
  }

  const radius = 72;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const circles = segments.map(([genre, count], index) => {
    const fraction = count / totalHits;
    const dash = fraction * circumference;
    const circle = `
      <circle
        cx="100" cy="100" r="${radius}"
        fill="none"
        stroke="${palette[index]}"
        stroke-width="24"
        stroke-dasharray="${dash} ${circumference - dash}"
        stroke-dashoffset="${-offset}"
        transform="rotate(-90 100 100)"
      >
        <title>${genre}: ${Math.round(fraction * 100)}%</title>
      </circle>`;
    offset += dash;
    return circle;
  }).join('');

  container.innerHTML = `
    <svg viewBox="0 0 200 200" role="img" aria-labelledby="genre-chart-title genre-chart-desc">
      <title id="genre-chart-title">Genre distribution</title>
      <desc id="genre-chart-desc">Distribution of genre tags across your top artists.</desc>
      <circle cx="100" cy="100" r="${radius}" fill="none" stroke="#292431" stroke-width="24"></circle>
      ${circles}
      <text x="100" y="96" class="donut-total">${sortedGenres.length}</text>
      <text x="100" y="112" class="donut-label">GENRE SIGNALS</text>
    </svg>
  `;
}

// LOAD RECENTLY PLAYED
async function loadRecentlyPlayed() {
  const tbody = document.getElementById('recently-played-table-body');
  const grid = document.getElementById('recently-played-grid');
  
  const spinnerHtml = '<div class="loading-inline" style="grid-column: 1/-1;"><div class="spinner" style="height: 30px; width: 30px; margin: 0 auto;"></div></div>';
  tbody.innerHTML = '<tr><td colspan="5" class="loading-inline"><div class="spinner" style="height: 30px; width: 30px; margin: 0 auto;"></div></td></tr>';
  grid.innerHTML = spinnerHtml;

  try {
    const res = await spotifyFetch('/me/player/recently-played?limit=50');
    const data = await res.json();
    appData.recentlyPlayed = data;
    markUpdated('recent');
    renderRecentlyPlayed(data);
    return true;
  } catch (err) {
    console.error('Error fetching recently played:', err.message);
    tbody.innerHTML = localErrorRowHtml(err, 'your recent plays');
    grid.innerHTML = `<div style="grid-column: 1/-1;">${localErrorHtml(err, 'your recent plays')}</div>`;
    return false;
  }
}

function renderRecentlyPlayed(data) {
  const tbody = document.getElementById('recently-played-table-body');
  const grid = document.getElementById('recently-played-grid');
  const listPanel = document.getElementById('recently-played-list-panel');

  if (currentView === 'grid') {
    grid.classList.remove('hidden');
    listPanel.classList.add('hidden');
    renderTracksGrid(grid, data ? data.items : [], 'recent');
  } else {
    grid.classList.add('hidden');
    listPanel.classList.remove('hidden');
    
    tbody.innerHTML = '';
    if (!data || !data.items || data.items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="loading-inline">No recently played tracks found. Let\'s play some music!</td></tr>';
      return;
    }

    data.items.forEach((item, index) => {
      const track = item.track;
      const cover = track.album.images && track.album.images.length > 0 
        ? track.album.images[0].url 
        : 'https://via.placeholder.com/48';
      const artistsName = track.artists.map(a => a.name).join(', ');
      const spotifyUrl = track.external_urls.spotify;
      const albumUrl = track.album.external_urls.spotify;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${index + 1}</td>
        <td>
          <div class="track-row-cell">
            <img class="track-row-cover" src="${cover}" alt="${track.name}">
            <div class="track-row-details">
              <a class="track-row-title" href="${spotifyUrl}" target="_blank" rel="noopener noreferrer">${track.name}</a>
              <span class="track-row-artist">${artistsName}</span>
            </div>
          </div>
        </td>
        <td>
          <a class="album-link" href="${albumUrl}" target="_blank" rel="noopener noreferrer">${track.album.name}</a>
        </td>
        <td aria-label="Played: ${formatRelativeTime(item.played_at)}">
          <span class="played-at-time">${formatRelativeTime(item.played_at)}</span>
        </td>
        <td style="text-align: right;" aria-label="Duration: ${formatDuration(track.duration_ms)}">${formatDuration(track.duration_ms)}</td>
      `;
      tbody.appendChild(tr);
    });
  }
}

// RENDER TRACKS GRID (CARD VIEW)
function renderTracksGrid(container, items, type) {
  container.innerHTML = '';
  
  if (!items || items.length === 0) {
    const emptyMsg = type === 'tracks' && trackFilter
      ? 'No tracks match your search or filter criteria.'
      : 'No tracks found. Keep listening!';
    container.innerHTML = `<div class="loading-inline" style="grid-column: 1/-1;">${emptyMsg}</div>`;
    return;
  }

  items.forEach((item, index) => {
    const track = type === 'recent' ? item.track : item;
    const playedAt = type === 'recent' ? item.played_at : null;
    
    const cover = track.album.images && track.album.images.length > 0 
      ? track.album.images[0].url 
      : 'https://via.placeholder.com/150';
    const artistsName = track.artists.map(a => a.name).join(', ');
    const spotifyUrl = track.external_urls.spotify;
    
    // Check if this track is currently playing in our preview player
    const isPlayingThis = activeAudio && activeAudio.src === track.preview_url && !activeAudio.paused;
    const cardClass = isPlayingThis ? 'track-card playing' : 'track-card';
    const btnIconClass = isPlayingThis ? 'play-icon hidden' : 'play-icon';
    const btnPauseClass = isPlayingThis ? 'pause-icon' : 'pause-icon hidden';
    
    const previewLabel = isPlayingThis ? `Pause preview of ${escapeHtml(track.name)}` : `Play preview of ${escapeHtml(track.name)}`;
    const playButton = track.preview_url
      ? `<button type="button" class="btn-play-preview" data-preview-url="${track.preview_url}" data-track-name="${escapeHtml(track.name)}" title="Play preview" aria-label="${previewLabel}" aria-pressed="${isPlayingThis}">
           <svg class="${btnIconClass}" viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
           <svg class="${btnPauseClass}" viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
         </button>`
      : `<a class="btn-play-preview btn-spotify-link" href="${spotifyUrl}" target="_blank" rel="noopener noreferrer" title="Open in Spotify" aria-label="Open ${escapeHtml(track.name)} on Spotify">
           <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm4.586 14.424c-.18.295-.565.387-.86.207-2.377-1.454-5.37-1.783-8.894-.982-.336.077-.67-.137-.747-.473-.077-.337.137-.67.473-.748 3.854-.88 7.15-.502 9.822 1.135.296.18.387.565.206.86zm1.223-2.72c-.227.367-.707.487-1.074.26-2.72-1.672-6.866-2.155-10.073-1.182-.413.125-.847-.107-.972-.52-.125-.413.108-.847.52-.972 3.666-1.112 8.225-.573 11.338 1.34.368.226.488.706.26 1.074zm.107-2.825C14.502 8.84 9.17 8.663 6.074 9.603c-.522.158-1.074-.142-1.233-.664-.158-.522.142-1.074.664-1.233 3.563-1.082 9.44-.88 13.34 1.436.47.278.623.882.345 1.352-.278.47-.882.622-1.352.345z"/></svg>
         </a>`;

    const subMeta = playedAt
      ? `<span class="played-at-time" style="font-size: 0.8rem; color: var(--muted);">${formatRelativeTime(playedAt)}</span>`
      : `<span class="track-card-duration">${formatDuration(track.duration_ms)}</span>`;

    const originalRank = type === 'tracks' && appData.topTracks[currentRange]
      ? appData.topTracks[currentRange].items.findIndex(t => t.id === track.id) + 1
      : (index + 1);

    const div = document.createElement('div');
    div.className = cardClass;
    div.innerHTML = `
      <div class="track-card-cover-container">
        <img class="track-card-cover" src="${cover}" alt="${escapeHtml(track.name)}">
        <div class="track-card-play-overlay">
          ${playButton}
        </div>
        <span class="track-card-rank">#${originalRank}</span>
        <div class="playing-equalizer ${isPlayingThis ? '' : 'hidden'}">
          <div class="eq-bar eq-bar-1"></div>
          <div class="eq-bar eq-bar-2"></div>
          <div class="eq-bar eq-bar-3"></div>
        </div>
      </div>
      <div class="track-card-details">
        <a class="track-card-title" href="${spotifyUrl}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(track.name)}">${escapeHtml(track.name)}</a>
        <span class="track-card-artist" title="${escapeHtml(artistsName)}">${escapeHtml(artistsName)}</span>
        <span class="track-card-album" title="${escapeHtml(track.album.name)}">${escapeHtml(track.album.name)}</span>
        <div class="track-card-meta">
          <div class="popularity-info">
            <div class="popularity-meter" style="width: 50px; margin-right: 4px;" title="${track.popularity}% popularity">
              <div class="popularity-fill" style="width: ${track.popularity}%"></div>
            </div>
            <span class="popularity-val" style="font-size: 0.75rem;">${track.popularity}%</span>
          </div>
          ${subMeta}
        </div>
      </div>
    `;

    // Hook up play preview click
    const playBtn = div.querySelector('.btn-play-preview');
    if (playBtn && track.preview_url) {
      playBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleAudioPreview(track.preview_url, playBtn, div);
      });
    }

    container.appendChild(div);
  });
}

// TOGGLE AUDIO PREVIEW PLAYBACK
function toggleAudioPreview(previewUrl, button, card) {
  const playIcon = button.querySelector('.play-icon');
  const pauseIcon = button.querySelector('.pause-icon');
  const eq = card.querySelector('.playing-equalizer');
  const trackName = button.dataset.trackName || '';

  // Case 1: Clicked on a currently playing preview -> Pause it
  if (activeAudio && activeAudio.src === previewUrl) {
    if (activeAudio.paused) {
      activeAudio.play().catch(err => console.error("Error playing audio:", err));
      playIcon.classList.add('hidden');
      pauseIcon.classList.remove('hidden');
      card.classList.add('playing');
      if (eq) eq.classList.remove('hidden');
      button.setAttribute('aria-label', `Pause preview of ${trackName}`);
      button.setAttribute('aria-pressed', 'true');
    } else {
      activeAudio.pause();
      playIcon.classList.remove('hidden');
      pauseIcon.classList.add('hidden');
      card.classList.remove('playing');
      if (eq) eq.classList.add('hidden');
      button.setAttribute('aria-label', `Play preview of ${trackName}`);
      button.setAttribute('aria-pressed', 'false');
    }
    return;
  }

  // Case 2: Clicked on a different preview or nothing is playing yet -> Start new preview
  if (activeAudio) {
    activeAudio.pause();
    if (activePlayButton) {
      const activePlayIcon = activePlayButton.querySelector('.play-icon');
      const activePauseIcon = activePlayButton.querySelector('.pause-icon');
      if (activePlayIcon) activePlayIcon.classList.remove('hidden');
      if (activePauseIcon) activePauseIcon.classList.add('hidden');
      const activeTrackName = activePlayButton.dataset.trackName || '';
      activePlayButton.setAttribute('aria-label', `Play preview of ${activeTrackName}`);
      activePlayButton.setAttribute('aria-pressed', 'false');
    }
    if (activeTrackCard) {
      activeTrackCard.classList.remove('playing');
      const activeEq = activeTrackCard.querySelector('.playing-equalizer');
      if (activeEq) activeEq.classList.add('hidden');
    }
  }

  // Create new audio
  activeAudio = new Audio(previewUrl);
  activePlayButton = button;
  activeTrackCard = card;

  activeAudio.play()
    .then(() => {
      playIcon.classList.add('hidden');
      pauseIcon.classList.remove('hidden');
      card.classList.add('playing');
      if (eq) eq.classList.remove('hidden');
      button.setAttribute('aria-label', `Pause preview of ${trackName}`);
      button.setAttribute('aria-pressed', 'true');
    })
    .catch(err => {
      console.error("Failed to play audio preview:", err);
      alert("Spotify preview is unavailable for playback at the moment.");
    });

  // Handle preview completion
  activeAudio.addEventListener('ended', () => {
    playIcon.classList.remove('hidden');
    pauseIcon.classList.add('hidden');
    card.classList.remove('playing');
    if (eq) eq.classList.add('hidden');
    button.setAttribute('aria-label', `Play preview of ${trackName}`);
    button.setAttribute('aria-pressed', 'false');
    activeAudio = null;
    activePlayButton = null;
    activeTrackCard = null;
  });
}

// APPLY GENRE FILTER PROGRAMMATICALLY (e.g. from Overview or Genres tab)
function applyGenreFilterToArtists(genre) {
  artistFilter = genre;
  const searchInput = document.getElementById('artist-search-input');
  if (searchInput) searchInput.value = genre;

  const clearFilterBtn = document.getElementById('btn-clear-artist-filter');
  if (clearFilterBtn) clearFilterBtn.classList.toggle('hidden', !genre);

  switchTab('artists');
}

// RENDER HOURLY LISTENING ACTIVITY CHART (SVG)
function renderHourlyActivityChart(recent) {
  const container = document.getElementById('hourly-activity-chart-container');
  if (!container) return;

  if (!recent || !recent.items || recent.items.length === 0) {
    container.innerHTML = '<div class="loading-inline">No stream activity available.</div>';
    return;
  }

  const hourlyCounts = Array(24).fill(0);
  recent.items.forEach(item => {
    const date = new Date(item.played_at);
    const hour = date.getHours(); // Local hour of user
    hourlyCounts[hour]++;
  });

  const maxCount = Math.max(...hourlyCounts, 1);
  
  let svgContent = `<svg viewBox="0 0 480 160" style="width: 100%; height: 100%; overflow: visible;">`;
  
  // Horizontal grid lines
  svgContent += `
    <line x1="0" y1="130" x2="480" y2="130" stroke="var(--line)" stroke-width="1" />
    <line x1="0" y1="65" x2="480" y2="65" stroke="var(--line)" stroke-width="1" stroke-dasharray="4,4" />
    <line x1="0" y1="0" x2="480" y2="0" stroke="var(--line)" stroke-dasharray="4,4" />
  `;

  const barWidth = 14;
  const gap = 6;
  hourlyCounts.forEach((count, hour) => {
    const x = hour * (barWidth + gap) + 5;
    const barHeight = (count / maxCount) * 115; // Max height 115px
    const y = 130 - barHeight;

    const barColor = count > 0 ? 'var(--accent)' : 'var(--line-strong)';

    svgContent += `
      <rect
        class="hourly-bar"
        data-hour="${hour}"
        data-count="${count}"
        x="${x}" y="${y}"
        width="${barWidth}" height="${barHeight}"
        rx="3" ry="3"
        fill="${barColor}"
        opacity="0.8"
        style="transition: all 0.2s ease-in-out; cursor: pointer;"
        onmouseover="this.setAttribute('opacity', '1'); this.setAttribute('fill', 'var(--accent-bright)')"
        onmouseout="this.setAttribute('opacity', '0.8'); this.setAttribute('fill', '${barColor}')"
      ></rect>
    `;
  });

  // Hour labels for intervals (00, 06, 12, 18, 23)
  const labels = [0, 6, 12, 18, 23];
  labels.forEach(hour => {
    const x = hour * (barWidth + gap) + 5 + (barWidth / 2);
    svgContent += `
      <text
        x="${x}" y="150"
        fill="var(--dim)"
        font-size="10"
        font-family="var(--mono)"
        text-anchor="middle"
      >${String(hour).padStart(2, '0')}</text>
    `;
  });

  svgContent += `</svg>`;
  container.innerHTML = svgContent;
  container.setAttribute('role', 'group');
  container.setAttribute('aria-label', 'Hourly listening activity, bar chart');

  const getBarLabel = (bar) => {
    const hour = bar.getAttribute('data-hour');
    const count = bar.getAttribute('data-count');
    return `${String(hour).padStart(2, '0')}:00 — ${count} play${count !== '1' ? 's' : ''}`;
  };
  attachChartTooltip(container, container.querySelectorAll('.hourly-bar'), getBarLabel);

  const altList = Array.from(container.querySelectorAll('.hourly-bar')).map((bar) => `<li>${escapeHtml(getBarLabel(bar))}</li>`).join('');
  container.insertAdjacentHTML('beforeend', `<ul class="sr-only">${altList}</ul>`);
}

// Wires up a floating tooltip that follows the mouse over a set of SVG
// shapes, and makes the same info reachable without a mouse: every shape
// gets an aria-label (so a screen reader announces it on its own), plus
// keyboard focus support so the tooltip also shows on focus. The marks
// share one "roving tabindex" stop — Tab reaches the group once, then
// Arrow keys/Home/End move between individual marks — rather than each
// mark being its own Tab stop, which would make a 50-point chart take 50
// presses of Tab to get past.
// getLabel(el) returns the text to show for a given mark.
function attachChartTooltip(container, elements, getLabel) {
  let tooltip = container.querySelector('.chart-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip hidden';
    container.appendChild(tooltip);
  }
  if (elements.length === 0) return;

  const positionAt = (x, y) => {
    const rect = container.getBoundingClientRect();
    tooltip.style.left = `${x - rect.left}px`;
    tooltip.style.top = `${y - rect.top}px`;
  };
  const show = (el) => {
    tooltip.textContent = getLabel(el);
    tooltip.classList.remove('hidden');
  };
  const hide = () => tooltip.classList.add('hidden');

  elements.forEach((el, i) => {
    el.setAttribute('tabindex', i === 0 ? '0' : '-1');
    if (!el.hasAttribute('role')) el.setAttribute('role', 'img');
    el.setAttribute('aria-label', getLabel(el));

    el.addEventListener('mouseenter', () => show(el));
    el.addEventListener('mousemove', (e) => positionAt(e.clientX, e.clientY));
    el.addEventListener('mouseleave', hide);

    el.addEventListener('focus', () => {
      const r = el.getBoundingClientRect();
      positionAt(r.left + r.width / 2, r.top);
      show(el);
    });
    el.addEventListener('blur', hide);

    el.addEventListener('keydown', (e) => {
      let nextIndex = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIndex = Math.min(i + 1, elements.length - 1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') nextIndex = Math.max(i - 1, 0);
      else if (e.key === 'Home') nextIndex = 0;
      else if (e.key === 'End') nextIndex = elements.length - 1;
      if (nextIndex !== null && nextIndex !== i) {
        e.preventDefault();
        el.setAttribute('tabindex', '-1');
        const next = elements[nextIndex];
        next.setAttribute('tabindex', '0');
        next.focus();
      }
    });
  });
}

// RENDER DAY-OF-WEEK LISTENING ACTIVITY CHART (SVG) — companion to the hourly chart
function renderDayOfWeekActivityChart(recent) {
  const container = document.getElementById('day-of-week-chart-container');
  if (!container) return;

  if (!recent || !recent.items || recent.items.length === 0) {
    container.innerHTML = '<div class="loading-inline">No stream activity available.</div>';
    return;
  }

  // Monday-first week, matching UK convention used elsewhere in the app.
  const dayLabels = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  const dayCounts = Array(7).fill(0);
  recent.items.forEach((item) => {
    const jsDay = new Date(item.played_at).getDay(); // 0 = Sunday ... 6 = Saturday
    const mondayFirstIndex = (jsDay + 6) % 7; // 0 = Monday ... 6 = Sunday
    dayCounts[mondayFirstIndex]++;
  });

  const maxCount = Math.max(...dayCounts, 1);
  const barWidth = 46;
  const gap = 20;
  const chartWidth = dayLabels.length * (barWidth + gap);

  let svgContent = `<svg viewBox="0 0 ${chartWidth} 160" style="width: 100%; height: 100%; overflow: visible;">`;

  svgContent += `
    <line x1="0" y1="130" x2="${chartWidth}" y2="130" stroke="var(--line)" stroke-width="1" />
    <line x1="0" y1="65" x2="${chartWidth}" y2="65" stroke="var(--line)" stroke-width="1" stroke-dasharray="4,4" />
    <line x1="0" y1="0" x2="${chartWidth}" y2="0" stroke="var(--line)" stroke-dasharray="4,4" />
  `;

  dayCounts.forEach((count, index) => {
    const x = index * (barWidth + gap) + gap / 2;
    const barHeight = (count / maxCount) * 115;
    const y = 130 - barHeight;
    const barColor = count > 0 ? 'var(--accent)' : 'var(--line-strong)';

    svgContent += `
      <rect
        class="day-of-week-bar"
        data-day="${dayLabels[index]}"
        data-count="${count}"
        x="${x}" y="${y}"
        width="${barWidth}" height="${barHeight}"
        rx="3" ry="3"
        fill="${barColor}"
        opacity="0.8"
        style="transition: all 0.2s ease-in-out; cursor: pointer;"
        onmouseover="this.setAttribute('opacity', '1'); this.setAttribute('fill', 'var(--accent-bright)')"
        onmouseout="this.setAttribute('opacity', '0.8'); this.setAttribute('fill', '${barColor}')"
      ></rect>
    `;

    svgContent += `
      <text
        x="${x + barWidth / 2}" y="150"
        fill="var(--dim)"
        font-size="10"
        font-family="var(--mono)"
        text-anchor="middle"
      >${dayLabels[index]}</text>
    `;
  });

  svgContent += `</svg>`;
  container.innerHTML = svgContent;
  container.setAttribute('role', 'group');
  container.setAttribute('aria-label', 'Day-of-week listening activity, bar chart');

  const getBarLabel = (bar) => {
    const day = bar.getAttribute('data-day');
    const count = bar.getAttribute('data-count');
    return `${day} — ${count} play${count !== '1' ? 's' : ''}`;
  };
  attachChartTooltip(container, container.querySelectorAll('.day-of-week-bar'), getBarLabel);

  const altList = Array.from(container.querySelectorAll('.day-of-week-bar')).map((bar) => `<li>${escapeHtml(getBarLabel(bar))}</li>`).join('');
  container.insertAdjacentHTML('beforeend', `<ul class="sr-only">${altList}</ul>`);
}

// RENDER POPULARITY DISTRIBUTION CHART
function renderPopularityDistribution(topTracks) {
  const container = document.getElementById('popularity-distribution-container');
  if (!container) return;

  if (!topTracks || !topTracks.items || topTracks.items.length === 0) {
    container.innerHTML = '<div class="loading-inline">No track popularity metrics available.</div>';
    return;
  }

  let mainstream = 0;
  let popular = 0;
  let alternative = 0;
  let obscure = 0;
  const total = topTracks.items.length;

  topTracks.items.forEach(track => {
    const pop = track.popularity;
    if (pop >= 80) mainstream++;
    else if (pop >= 60) popular++;
    else if (pop >= 30) alternative++;
    else obscure++;
  });

  const percentages = {
    mainstream: Math.round((mainstream / total) * 100),
    popular: Math.round((popular / total) * 100),
    alternative: Math.round((alternative / total) * 100),
    obscure: Math.round((obscure / total) * 100)
  };

  container.innerHTML = `
    <div class="genre-bar-container">
      <div class="genre-bar-info">
        <span class="genre-bar-name" style="font-weight: 500;">Mainstream Hits (80-100)</span>
        <span class="genre-bar-percentage">${percentages.mainstream}%</span>
      </div>
      <div class="genre-bar-wrapper">
        <div class="genre-bar-fill" style="width: ${percentages.mainstream}%; background: var(--green);"></div>
      </div>
    </div>

    <div class="genre-bar-container">
      <div class="genre-bar-info">
        <span class="genre-bar-name" style="font-weight: 500;">Popular & Hot (60-79)</span>
        <span class="genre-bar-percentage">${percentages.popular}%</span>
      </div>
      <div class="genre-bar-wrapper">
        <div class="genre-bar-fill" style="width: ${percentages.popular}%; background: var(--accent);"></div>
      </div>
    </div>

    <div class="genre-bar-container">
      <div class="genre-bar-info">
        <span class="genre-bar-name" style="font-weight: 500;">Alternative / Indie (30-59)</span>
        <span class="genre-bar-percentage">${percentages.alternative}%</span>
      </div>
      <div class="genre-bar-wrapper">
        <div class="genre-bar-fill" style="width: ${percentages.alternative}%; background: var(--accent-bright);"></div>
      </div>
    </div>

    <div class="genre-bar-container">
      <div class="genre-bar-info">
        <span class="genre-bar-name" style="font-weight: 500;">Obscure & Underground (0-29)</span>
        <span class="genre-bar-percentage">${percentages.obscure}%</span>
      </div>
      <div class="genre-bar-wrapper">
        <div class="genre-bar-fill" style="width: ${percentages.obscure}%; background: var(--dim);"></div>
      </div>
    </div>
  `;
}

// RENDER ARTIST POPULARITY DISTRIBUTION CHART — same buckets as the track version, for artists
function renderArtistPopularityDistribution(topArtists) {
  const container = document.getElementById('artist-popularity-distribution-container');
  if (!container) return;

  if (!topArtists || !topArtists.items || topArtists.items.length === 0) {
    container.innerHTML = '<div class="loading-inline">No artist popularity metrics available.</div>';
    return;
  }

  let mainstream = 0;
  let popular = 0;
  let alternative = 0;
  let obscure = 0;
  const total = topArtists.items.length;

  topArtists.items.forEach((artist) => {
    const pop = artist.popularity;
    if (pop >= 80) mainstream++;
    else if (pop >= 60) popular++;
    else if (pop >= 30) alternative++;
    else obscure++;
  });

  const percentages = {
    mainstream: Math.round((mainstream / total) * 100),
    popular: Math.round((popular / total) * 100),
    alternative: Math.round((alternative / total) * 100),
    obscure: Math.round((obscure / total) * 100)
  };

  container.innerHTML = `
    <div class="genre-bar-container">
      <div class="genre-bar-info">
        <span class="genre-bar-name" style="font-weight: 500;">Mainstream Hits (80-100)</span>
        <span class="genre-bar-percentage">${percentages.mainstream}%</span>
      </div>
      <div class="genre-bar-wrapper">
        <div class="genre-bar-fill" style="width: ${percentages.mainstream}%; background: var(--green);"></div>
      </div>
    </div>

    <div class="genre-bar-container">
      <div class="genre-bar-info">
        <span class="genre-bar-name" style="font-weight: 500;">Popular & Hot (60-79)</span>
        <span class="genre-bar-percentage">${percentages.popular}%</span>
      </div>
      <div class="genre-bar-wrapper">
        <div class="genre-bar-fill" style="width: ${percentages.popular}%; background: var(--accent);"></div>
      </div>
    </div>

    <div class="genre-bar-container">
      <div class="genre-bar-info">
        <span class="genre-bar-name" style="font-weight: 500;">Alternative / Indie (30-59)</span>
        <span class="genre-bar-percentage">${percentages.alternative}%</span>
      </div>
      <div class="genre-bar-wrapper">
        <div class="genre-bar-fill" style="width: ${percentages.alternative}%; background: var(--accent-bright);"></div>
      </div>
    </div>

    <div class="genre-bar-container">
      <div class="genre-bar-info">
        <span class="genre-bar-name" style="font-weight: 500;">Obscure & Underground (0-29)</span>
        <span class="genre-bar-percentage">${percentages.obscure}%</span>
      </div>
      <div class="genre-bar-wrapper">
        <div class="genre-bar-fill" style="width: ${percentages.obscure}%; background: var(--dim);"></div>
      </div>
    </div>
  `;
}

// RENDER TRACK DURATION DISTRIBUTION CHART
function renderDurationDistribution(topTracks) {
  const container = document.getElementById('duration-distribution-container');
  if (!container) return;

  if (!topTracks || !topTracks.items || topTracks.items.length === 0) {
    container.innerHTML = '<div class="loading-inline">No track duration data available.</div>';
    return;
  }

  const buckets = [
    { label: 'Under 2 min', max: 120000, count: 0, color: 'var(--dim)' },
    { label: '2-3 min', max: 180000, count: 0, color: 'var(--accent-bright)' },
    { label: '3-4 min', max: 240000, count: 0, color: 'var(--accent)' },
    { label: '4-5 min', max: 300000, count: 0, color: 'var(--green)' },
    { label: '5 min+', max: Infinity, count: 0, color: 'var(--accent)' }
  ];

  const total = topTracks.items.length;
  topTracks.items.forEach((track) => {
    const bucket = buckets.find((b) => track.duration_ms < b.max);
    bucket.count++;
  });

  container.innerHTML = buckets.map((bucket) => {
    const percentage = Math.round((bucket.count / total) * 100);
    return `
      <div class="genre-bar-container">
        <div class="genre-bar-info">
          <span class="genre-bar-name" style="font-weight: 500;">${bucket.label}</span>
          <span class="genre-bar-percentage">${bucket.count} track${bucket.count !== 1 ? 's' : ''} · ${percentage}%</span>
        </div>
        <div class="genre-bar-wrapper">
          <div class="genre-bar-fill" style="width: ${percentage}%; background: ${bucket.color};"></div>
        </div>
      </div>
    `;
  }).join('');
}

// RENDER TOP CONTRIBUTING ARTISTS — which artists appear most often across the top tracks list (features included)
function renderTopContributingArtists(topTracks) {
  const container = document.getElementById('top-contributing-artists-container');
  if (!container) return;

  if (!topTracks || !topTracks.items || topTracks.items.length === 0) {
    container.innerHTML = '<div class="loading-inline">No track data available.</div>';
    return;
  }

  const artistCounts = {};
  topTracks.items.forEach((track) => {
    track.artists.forEach((artist) => {
      artistCounts[artist.name] = (artistCounts[artist.name] || 0) + 1;
    });
  });

  const sortedArtists = Object.entries(artistCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  if (sortedArtists.length === 0 || sortedArtists[0][1] <= 1) {
    container.innerHTML = '<div class="loading-inline">No repeat artists — your top tracks are spread across different artists.</div>';
    return;
  }

  const maxCount = sortedArtists[0][1];

  container.innerHTML = sortedArtists.map(([name, count]) => {
    const percentage = Math.round((count / maxCount) * 100);
    return `
      <div class="genre-bar-container">
        <div class="genre-bar-info">
          <span class="genre-bar-name">${escapeHtml(name)}</span>
          <span class="genre-bar-percentage">${count} track${count !== 1 ? 's' : ''}</span>
        </div>
        <div class="genre-bar-wrapper">
          <div class="genre-bar-fill" style="width: ${percentage}%;"></div>
        </div>
      </div>
    `;
  }).join('');
}

// SHARED SCATTER/QUADRANT RENDERER
// points: [{ x, y, tooltip }] with x/y normalized to [0, 1] — x=0 left, x=1
// right, y=0 top, y=1 bottom. Callers own the meaning of each axis and must
// normalize their own data into that space before calling this. chartLabel
// names the chart for screen reader users (the group role + a sr-only list
// mirroring each dot's tooltip text, since the SVG itself conveys nothing
// on its own without sight or a mouse).
function renderQuadrantScatter(container, points, labels, chartLabel) {
  const width = 560;
  const height = 320;
  const padding = 36;
  const plotW = width - padding * 2;
  const plotH = height - padding * 2;
  const midX = padding + plotW / 2;
  const midY = padding + plotH / 2;

  let svg = `<svg viewBox="0 0 ${width} ${height}" style="width: 100%; height: auto; overflow: visible;">`;

  // Quadrant background tints
  svg += `<rect x="${padding}" y="${padding}" width="${plotW / 2}" height="${plotH / 2}" fill="var(--accent-soft)" opacity="0.5" />`;
  svg += `<rect x="${midX}" y="${padding}" width="${plotW / 2}" height="${plotH / 2}" fill="var(--green)" opacity="0.07" />`;

  // Divider lines
  svg += `<line x1="${midX}" y1="${padding}" x2="${midX}" y2="${height - padding}" stroke="var(--line-strong)" stroke-dasharray="4,4" />`;
  svg += `<line x1="${padding}" y1="${midY}" x2="${width - padding}" y2="${midY}" stroke="var(--line-strong)" stroke-dasharray="4,4" />`;
  svg += `<rect x="${padding}" y="${padding}" width="${plotW}" height="${plotH}" fill="none" stroke="var(--line)" />`;

  // Quadrant labels — sit in the margins above/below the plot rect so they
  // never collide with dots plotted right at the corners.
  svg += `<text x="${padding + 8}" y="${padding - 12}" fill="var(--accent-bright)" font-size="9" font-family="var(--mono)" letter-spacing="0.05em">${labels.topLeft}</text>`;
  svg += `<text x="${width - padding - 8}" y="${padding - 12}" text-anchor="end" fill="var(--green)" font-size="9" font-family="var(--mono)" letter-spacing="0.05em">${labels.topRight}</text>`;
  svg += `<text x="${padding + 8}" y="${height - padding + 18}" fill="var(--dim)" font-size="9" font-family="var(--mono)" letter-spacing="0.05em">${labels.bottomLeft}</text>`;
  svg += `<text x="${width - padding - 8}" y="${height - padding + 18}" text-anchor="end" fill="var(--dim)" font-size="9" font-family="var(--mono)" letter-spacing="0.05em">${labels.bottomRight}</text>`;

  // Axis labels
  svg += `<text x="${width / 2}" y="${height - 4}" text-anchor="middle" fill="var(--dim)" font-size="10" font-family="var(--mono)">${labels.xAxis}</text>`;
  svg += `<text x="14" y="${height / 2}" text-anchor="middle" fill="var(--dim)" font-size="10" font-family="var(--mono)" transform="rotate(-90 14 ${height / 2})">${labels.yAxis}</text>`;

  points.forEach((p, index) => {
    const cx = padding + p.x * plotW;
    const cy = padding + p.y * plotH;
    svg += `<circle class="quadrant-dot" data-index="${index}" cx="${cx}" cy="${cy}" r="5" fill="var(--accent)" opacity="0.85" stroke="var(--bg)" stroke-width="1" style="cursor: pointer;"></circle>`;
  });

  svg += `</svg>`;
  container.innerHTML = svg;
  container.setAttribute('role', 'group');
  if (chartLabel) container.setAttribute('aria-label', chartLabel);

  attachChartTooltip(container, container.querySelectorAll('.quadrant-dot'), (dot) => {
    return points[Number(dot.getAttribute('data-index'))].tooltip;
  });

  // Concise text alternative: the same per-point detail as the tooltips,
  // as a list a screen reader can read without needing to see or hover
  // the chart at all.
  const altList = points.map((p) => `<li>${escapeHtml(p.tooltip)}</li>`).join('');
  container.insertAdjacentHTML('beforeend', `<ul class="sr-only">${altList}</ul>`);
}

const RANK_QUADRANT_LABELS = {
  topLeft: 'PERSONAL GEMS',
  topRight: 'MAINSTREAM FAVES',
  bottomLeft: 'DEEP CUTS',
  bottomRight: 'BACKGROUND HITS',
  xAxis: 'POPULARITY →',
  yAxis: 'HIGHER PERSONAL RANK →'
};

// X = Spotify's global popularity score (mainstream-ness). Y = your rank
// within this list (rank 1 at the top).
function renderPopularityRankQuadrant(topTracks) {
  const container = document.getElementById('popularity-rank-quadrant-container');
  if (!container) return;

  if (!topTracks || !topTracks.items || topTracks.items.length === 0) {
    container.innerHTML = '<div class="loading-inline">Not enough track data to plot.</div>';
    return;
  }

  const items = topTracks.items;
  const total = items.length;
  const points = items.map((track, index) => {
    const rank = index + 1;
    const y = total > 1 ? (rank - 1) / (total - 1) : 0.5;
    return { x: track.popularity / 100, y, tooltip: `#${rank} ${track.name} — ${track.popularity}% popularity` };
  });

  renderQuadrantScatter(container, points, RANK_QUADRANT_LABELS, 'Tracks: popularity versus your rank, scatter chart');
}

// Same idea as the track quadrant above, but for your top artists.
function renderArtistRankQuadrant(topArtists) {
  const container = document.getElementById('artist-rank-quadrant-container');
  if (!container) return;

  if (!topArtists || !topArtists.items || topArtists.items.length === 0) {
    container.innerHTML = '<div class="loading-inline">Not enough artist data to plot.</div>';
    return;
  }

  const items = topArtists.items;
  const total = items.length;
  const points = items.map((artist, index) => {
    const rank = index + 1;
    const y = total > 1 ? (rank - 1) / (total - 1) : 0.5;
    return { x: artist.popularity / 100, y, tooltip: `#${rank} ${artist.name} — ${artist.popularity}% popularity` };
  });

  renderQuadrantScatter(container, points, RANK_QUADRANT_LABELS, 'Artists: popularity versus your rank, scatter chart');
}

// X = popularity. Y = track duration (longer plots higher) — are your
// mainstream favourites long epics or quick hits?
function renderDurationPopularityQuadrant(topTracks) {
  const container = document.getElementById('duration-popularity-quadrant-container');
  if (!container) return;

  if (!topTracks || !topTracks.items || topTracks.items.length === 0) {
    container.innerHTML = '<div class="loading-inline">Not enough track data to plot.</div>';
    return;
  }

  const items = topTracks.items;
  const durations = items.map((t) => t.duration_ms);
  const minDur = Math.min(...durations);
  const maxDur = Math.max(...durations);
  const range = maxDur - minDur || 1;

  const points = items.map((track) => ({
    x: track.popularity / 100,
    y: 1 - (track.duration_ms - minDur) / range,
    tooltip: `${track.name} — ${formatDuration(track.duration_ms)}, ${track.popularity}% popularity`
  }));

  renderQuadrantScatter(container, points, {
    topLeft: 'NICHE EPICS',
    topRight: 'MAINSTREAM EPICS',
    bottomLeft: 'NICHE QUICK HITS',
    bottomRight: 'MAINSTREAM QUICK HITS',
    xAxis: 'POPULARITY →',
    yAxis: 'LONGER DURATION →'
  }, 'Tracks: duration versus popularity, scatter chart');
}

// X = popularity. Y = follower count on a log scale (spans orders of
// magnitude) — surfaces artists with a huge legacy following but modest
// current buzz, vs. ones breaking out with high popularity but a smaller
// audience so far. Followers are compared relatively within this top-50 set,
// not against fixed absolute thresholds.
function renderFollowersPopularityQuadrant(topArtists) {
  const container = document.getElementById('followers-popularity-quadrant-container');
  if (!container) return;

  if (!topArtists || !topArtists.items || topArtists.items.length === 0) {
    container.innerHTML = '<div class="loading-inline">Not enough artist data to plot.</div>';
    return;
  }

  const items = topArtists.items;
  const logFollowers = items.map((a) => Math.log10(a.followers.total + 1));
  const minLog = Math.min(...logFollowers);
  const maxLog = Math.max(...logFollowers);
  const range = maxLog - minLog || 1;

  const points = items.map((artist, index) => ({
    x: artist.popularity / 100,
    y: 1 - (logFollowers[index] - minLog) / range,
    tooltip: `${artist.name} — ${formatFollowers(artist.followers.total)} followers, ${artist.popularity}% popularity`
  }));

  renderQuadrantScatter(container, points, {
    topLeft: 'LEGACY FANBASE',
    topRight: 'SUPERSTARS',
    bottomLeft: 'NICHE / EMERGING',
    bottomRight: 'RISING BUZZ',
    xAxis: 'POPULARITY →',
    yAxis: 'MORE FOLLOWERS →'
  }, 'Artists: followers versus popularity, scatter chart');
}

// --- GLOBAL SEARCH ---
// Searches both your already-loaded local data ("In Your Library" — instant,
// no network call) and Spotify's full catalogue via /v1/search (debounced).
// Play buttons start real playback via Spotify Connect (not the 30s preview
// clips used elsewhere), reusing the playback scope the app already has.
const SEARCH_MIN_CHARS = 2;
const SEARCH_DEBOUNCE_MS = 350;
const SEARCH_NO_RESULTS_TEXT = 'No results found. Try a different search.';
const SEARCH_ERROR_TEXT = "Search failed — try again.";

let searchQuery = '';
let searchTypeFilter = 'all'; // all | track | artist | album | playlist
let searchDebounceTimer = null;
let searchRequestSeq = 0;
let searchLiveResults = { tracks: [], artists: [], albums: [], playlists: [] };

// Header search dropdown — a compact quick-results preview, separate from
// the full Search tab's own state above so typing in the header doesn't
// disturb whatever's already on that tab.
const HEADER_SEARCH_LOCAL_LIMIT = 3;
const HEADER_SEARCH_LIVE_LIMIT = 6;
let headerSearchOpen = false;
let headerSearchLocalResults = { tracks: [], artists: [] };
let headerSearchLiveResults = { tracks: [], artists: [], albums: [], playlists: [] };
let headerSearchDebounceTimer = null;
let headerSearchRequestSeq = 0;

function initSearchTab() {
  const input = document.getElementById('global-search-input');
  if (input) {
    input.addEventListener('input', (e) => onSearchQueryChange(e.target.value, input));
  }

  // Persistent header search (visible on every tab except Search itself) —
  // typing there opens a quick-results dropdown in place; Enter (or its
  // footer row) hands the query off to the full Search tab.
  const headerInput = document.getElementById('header-search-input');
  const headerDropdown = document.getElementById('header-search-dropdown');
  const headerBackdrop = document.getElementById('header-search-backdrop');
  if (headerInput && headerDropdown && headerBackdrop) {
    headerInput.addEventListener('input', (e) => {
      syncSearchInputValues(e.target.value, headerInput);
      onHeaderSearchQueryChange(e.target.value);
    });
    headerInput.addEventListener('focus', () => {
      if (headerInput.value.trim().length >= SEARCH_MIN_CHARS) onHeaderSearchQueryChange(headerInput.value);
    });
    headerInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitHeaderSearch();
      } else if (e.key === 'Escape') {
        closeHeaderSearchDropdown();
        headerInput.blur();
      }
    });
    headerBackdrop.addEventListener('click', closeHeaderSearchDropdown);
  }

  const mobileSearchBtn = document.getElementById('btn-mobile-search');
  if (mobileSearchBtn) {
    mobileSearchBtn.addEventListener('click', () => {
      switchTab('search');
      focusSearchInput();
    });
  }

  document.querySelectorAll('.search-type-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.search-type-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      searchTypeFilter = btn.getAttribute('data-search-type');

      renderLocalSearchResults();
      if (searchQuery.length >= SEARCH_MIN_CHARS) {
        runSpotifySearch(searchQuery);
      } else {
        renderSpotifySearchResults();
      }
    });
  });
}

function focusSearchInput() {
  const input = document.getElementById('global-search-input');
  if (input) input.focus();
}

// Shared by both the in-tab search box and the persistent header search box
// so either one can drive the same search state, staying in sync with
// whichever one the user isn't actively typing in.
function onSearchQueryChange(value, sourceInput) {
  searchQuery = value.trim();
  syncSearchInputValues(value, sourceInput);
  clearTimeout(searchDebounceTimer);
  renderLocalSearchResults();

  if (searchQuery.length < SEARCH_MIN_CHARS) {
    clearSpotifySearchResults();
    return;
  }
  searchDebounceTimer = setTimeout(() => runSpotifySearch(searchQuery), SEARCH_DEBOUNCE_MS);
}

function syncSearchInputValues(value, sourceInput) {
  ['global-search-input', 'header-search-input'].forEach((id) => {
    const el = document.getElementById(id);
    if (el && el !== sourceInput && el.value !== value) el.value = value;
  });
}

// Drives the header dropdown: local (instant) results render immediately,
// live Spotify results follow after the usual debounce.
function onHeaderSearchQueryChange(value) {
  const query = value.trim();
  if (query.length < SEARCH_MIN_CHARS) {
    closeHeaderSearchDropdown();
    return;
  }

  headerSearchLocalResults = computeLocalSearchResults(query);
  renderHeaderSearchDropdown(query);
  openHeaderSearchDropdown();

  clearTimeout(headerSearchDebounceTimer);
  headerSearchDebounceTimer = setTimeout(() => runHeaderSearchLive(query), SEARCH_DEBOUNCE_MS);
}

async function runHeaderSearchLive(query) {
  const seq = ++headerSearchRequestSeq;
  try {
    const res = await spotifyFetch(`/search?q=${encodeURIComponent(query)}&type=track,artist,album,playlist&limit=3`);
    const data = await res.json();
    if (seq !== headerSearchRequestSeq) return; // superseded by a newer keystroke or a close

    headerSearchLiveResults = {
      tracks: (data.tracks && data.tracks.items) || [],
      artists: (data.artists && data.artists.items) || [],
      albums: (data.albums && data.albums.items) || [],
      playlists: ((data.playlists && data.playlists.items) || []).filter(Boolean)
    };
    renderHeaderSearchDropdown(query);
  } catch (err) {
    if (seq !== headerSearchRequestSeq) return;
    if (!err.isUnauthorized) {
      headerSearchLiveResults = { tracks: [], artists: [], albums: [], playlists: [] };
      renderHeaderSearchDropdown(query);
    }
  }
}

function renderHeaderSearchDropdown(query) {
  const dropdown = document.getElementById('header-search-dropdown');
  if (!dropdown) return;

  const localItems = [
    ...headerSearchLocalResults.tracks.map((t) => ({ kind: 'track', item: t })),
    ...headerSearchLocalResults.artists.map((a) => ({ kind: 'artist', item: a }))
  ].slice(0, HEADER_SEARCH_LOCAL_LIMIT);

  const liveItems = [
    ...headerSearchLiveResults.tracks.map((t) => ({ kind: 'track', item: t })),
    ...headerSearchLiveResults.artists.map((a) => ({ kind: 'artist', item: a })),
    ...headerSearchLiveResults.albums.map((a) => ({ kind: 'album', item: a })),
    ...headerSearchLiveResults.playlists.map((p) => ({ kind: 'playlist', item: p }))
  ].slice(0, HEADER_SEARCH_LIVE_LIMIT);

  dropdown.innerHTML = '';

  if (localItems.length === 0 && liveItems.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'header-search-dropdown-empty';
    empty.textContent = `No quick matches for "${query}" yet.`;
    dropdown.appendChild(empty);
  } else {
    if (localItems.length > 0) dropdown.appendChild(buildHeaderSearchGroup('In Your Library', localItems));
    if (liveItems.length > 0) dropdown.appendChild(buildHeaderSearchGroup('Spotify', liveItems));
  }

  const footer = document.createElement('div');
  footer.className = 'header-search-dropdown-footer';
  footer.innerHTML = `<span>View all results for "${escapeHtml(query)}"</span><span>&crarr; Enter</span>`;
  footer.addEventListener('click', commitHeaderSearch);
  dropdown.appendChild(footer);
}

function buildHeaderSearchGroup(heading, items) {
  const group = document.createElement('div');
  group.className = 'header-search-dropdown-group';

  const headingEl = document.createElement('div');
  headingEl.className = 'header-search-dropdown-heading';
  headingEl.textContent = heading;
  group.appendChild(headingEl);

  items.forEach(({ kind, item }) => {
    const row = buildHeaderSearchRow(kind, item);
    if (row) group.appendChild(row);
  });

  return group;
}

// Each row links straight to the item on Spotify — a quick jump, distinct
// from the full Search tab's cards which also offer in-app playback.
function buildHeaderSearchRow(kind, item) {
  const meta = getSearchResultMeta(kind, item);
  if (!meta) return null;

  const row = document.createElement('a');
  row.className = 'header-search-dropdown-row';
  row.href = meta.spotifyUrl || '#';
  row.target = '_blank';
  row.rel = 'noopener noreferrer';
  row.innerHTML = `
    <img class="header-search-dropdown-cover" src="${escapeHtml(meta.cover)}" alt="" loading="lazy">
    <div class="header-search-dropdown-info">
      <span class="header-search-dropdown-title">${escapeHtml(meta.title)}</span>
      <span class="header-search-dropdown-subtitle">${escapeHtml(meta.subtitle)}</span>
    </div>
    <span class="header-search-dropdown-kind">${escapeHtml(meta.metaRight)}</span>
  `;
  row.addEventListener('click', () => closeHeaderSearchDropdown());
  return row;
}

function openHeaderSearchDropdown() {
  headerSearchOpen = true;
  document.getElementById('header-search-wrapper').classList.add('search-active');
  document.getElementById('header-search-dropdown').classList.add('visible');
  document.getElementById('header-search-backdrop').classList.add('visible');
  document.getElementById('header-search-input').setAttribute('aria-expanded', 'true');
}

function closeHeaderSearchDropdown() {
  if (!headerSearchOpen) return;
  headerSearchOpen = false;
  headerSearchRequestSeq++; // invalidate any in-flight live search

  const wrapper = document.getElementById('header-search-wrapper');
  const dropdown = document.getElementById('header-search-dropdown');
  const backdrop = document.getElementById('header-search-backdrop');
  const input = document.getElementById('header-search-input');
  if (wrapper) wrapper.classList.remove('search-active');
  if (dropdown) dropdown.classList.remove('visible');
  if (backdrop) backdrop.classList.remove('visible');
  if (input) input.setAttribute('aria-expanded', 'false');
}

// Enter (or the dropdown's footer row) hands the query off to the full
// Search tab instead of picking any one quick result.
function commitHeaderSearch() {
  const headerInput = document.getElementById('header-search-input');
  const value = headerInput ? headerInput.value.trim() : '';
  if (value.length < SEARCH_MIN_CHARS) return;

  closeHeaderSearchDropdown();
  if (currentTab !== 'search') switchTab('search');
  onSearchQueryChange(value, headerInput);
  if (headerInput) headerInput.blur();
}

// Matches against whatever top-tracks/top-artists ranges and recently-played
// data happen to already be loaded in appData — best-effort, not exhaustive.
function computeLocalSearchResults(query) {
  const q = query.toLowerCase();

  const trackMap = new Map();
  Object.values(appData.topTracks).forEach((data) => {
    (data && data.items || []).forEach((t) => trackMap.set(t.id, t));
  });
  if (appData.recentlyPlayed && appData.recentlyPlayed.items) {
    appData.recentlyPlayed.items.forEach((entry) => trackMap.set(entry.track.id, entry.track));
  }
  const tracks = Array.from(trackMap.values()).filter((t) =>
    t.name.toLowerCase().includes(q) || t.artists.some((a) => a.name.toLowerCase().includes(q))
  );

  const artistMap = new Map();
  Object.values(appData.topArtists).forEach((data) => {
    (data && data.items || []).forEach((a) => artistMap.set(a.id, a));
  });
  const artists = Array.from(artistMap.values()).filter((a) =>
    a.name.toLowerCase().includes(q) || a.genres.some((g) => g.toLowerCase().includes(q))
  );

  return { tracks, artists };
}

function renderLocalSearchResults() {
  const section = document.getElementById('search-library-section');
  const grid = document.getElementById('search-library-grid');

  const eligible = searchQuery.length >= SEARCH_MIN_CHARS && searchTypeFilter !== 'album' && searchTypeFilter !== 'playlist';
  if (!eligible) {
    section.classList.add('hidden');
    grid.innerHTML = '';
    updateSearchVisibility();
    return;
  }

  const { tracks, artists } = computeLocalSearchResults(searchQuery);
  const items = searchTypeFilter === 'artist'
    ? artists.map((a) => ({ kind: 'artist', item: a }))
    : searchTypeFilter === 'track'
      ? tracks.map((t) => ({ kind: 'track', item: t }))
      : [...tracks.map((t) => ({ kind: 'track', item: t })), ...artists.map((a) => ({ kind: 'artist', item: a }))];

  if (items.length === 0) {
    section.classList.add('hidden');
    grid.innerHTML = '';
  } else {
    section.classList.remove('hidden');
    grid.innerHTML = '';
    items.slice(0, 16).forEach(({ kind, item }) => {
      const card = buildSearchResultCard(kind, item);
      if (card) grid.appendChild(card);
    });
  }

  updateSearchVisibility();
}

function clearSpotifySearchResults() {
  searchRequestSeq++; // invalidate any in-flight request so it's a no-op when it lands
  searchLiveResults = { tracks: [], artists: [], albums: [], playlists: [] };
  ['search-tracks-section', 'search-artists-section', 'search-albums-section', 'search-playlists-section'].forEach((id) => {
    document.getElementById(id).classList.add('hidden');
  });
  document.getElementById('search-loading-indicator').classList.add('hidden');
  document.getElementById('search-no-results').classList.add('hidden');
  updateSearchVisibility();
}

async function runSpotifySearch(query) {
  const seq = ++searchRequestSeq;
  const types = searchTypeFilter === 'all' ? 'track,artist,album,playlist' : searchTypeFilter;
  const limit = searchTypeFilter === 'all' ? 8 : 24;

  document.getElementById('search-loading-indicator').classList.remove('hidden');
  document.getElementById('search-no-results').classList.add('hidden');
  updateSearchVisibility();

  try {
    const res = await spotifyFetch(`/search?q=${encodeURIComponent(query)}&type=${types}&limit=${limit}`);
    const data = await res.json();
    if (seq !== searchRequestSeq) return; // a newer search superseded this one

    searchLiveResults = {
      tracks: (data.tracks && data.tracks.items) || [],
      artists: (data.artists && data.artists.items) || [],
      albums: (data.albums && data.albums.items) || [],
      playlists: ((data.playlists && data.playlists.items) || []).filter(Boolean)
    };
    renderSpotifySearchResults();
  } catch (err) {
    if (seq !== searchRequestSeq) return;
    console.error('Spotify search failed:', err);
    if (!err.isUnauthorized) {
      searchLiveResults = { tracks: [], artists: [], albums: [], playlists: [] };
      renderSpotifySearchResults();
      const noResultsEl = document.getElementById('search-no-results');
      noResultsEl.textContent = err.offline ? 'Search needs a connection. Reconnect and try again.' : err.status === 429 ? 'Spotify is limiting requests. Try again shortly.' : SEARCH_ERROR_TEXT;
      noResultsEl.classList.remove('hidden');
    }
  } finally {
    if (seq === searchRequestSeq) {
      document.getElementById('search-loading-indicator').classList.add('hidden');
    }
  }
}

function renderSpotifySearchResults() {
  const sectionsByType = {
    track: { sectionId: 'search-tracks-section', gridId: 'search-tracks-grid', items: searchLiveResults.tracks },
    artist: { sectionId: 'search-artists-section', gridId: 'search-artists-grid', items: searchLiveResults.artists },
    album: { sectionId: 'search-albums-section', gridId: 'search-albums-grid', items: searchLiveResults.albums },
    playlist: { sectionId: 'search-playlists-section', gridId: 'search-playlists-grid', items: searchLiveResults.playlists }
  };

  let anyLiveResults = false;

  Object.entries(sectionsByType).forEach(([kind, cfg]) => {
    const sectionEl = document.getElementById(cfg.sectionId);
    const gridEl = document.getElementById(cfg.gridId);
    const matchesFilter = searchTypeFilter === 'all' || searchTypeFilter === kind;

    if (!matchesFilter || cfg.items.length === 0) {
      sectionEl.classList.add('hidden');
      gridEl.innerHTML = '';
      return;
    }

    anyLiveResults = true;
    sectionEl.classList.remove('hidden');
    gridEl.innerHTML = '';
    cfg.items.forEach((item) => {
      const card = buildSearchResultCard(kind, item);
      if (card) gridEl.appendChild(card);
    });
  });

  const hasLibraryResults = !document.getElementById('search-library-section').classList.contains('hidden');
  const noResultsEl = document.getElementById('search-no-results');
  const resultsStatusEl = document.getElementById('search-results-status');
  if (!anyLiveResults && !hasLibraryResults && searchQuery.length >= SEARCH_MIN_CHARS) {
    noResultsEl.textContent = SEARCH_NO_RESULTS_TEXT;
    noResultsEl.classList.remove('hidden');
    if (resultsStatusEl) resultsStatusEl.textContent = '';
  } else {
    noResultsEl.classList.add('hidden');
    if (anyLiveResults && resultsStatusEl) {
      const total = searchLiveResults.tracks.length + searchLiveResults.artists.length + searchLiveResults.albums.length + searchLiveResults.playlists.length;
      resultsStatusEl.textContent = `${total} result${total !== 1 ? 's' : ''} found.`;
    }
  }

  updateSearchVisibility();
}

function updateSearchVisibility() {
  const wrapper = document.getElementById('search-results-wrapper');
  const prompt = document.getElementById('search-prompt-state');

  if (searchQuery.length < SEARCH_MIN_CHARS) {
    wrapper.classList.add('hidden');
    prompt.classList.remove('hidden');
  } else {
    prompt.classList.add('hidden');
    wrapper.classList.remove('hidden');
  }
}

// Shared field extraction for any search result kind — used both by the
// full-page result cards and the header dropdown's compact rows.
function getSearchResultMeta(kind, item) {
  if (!item) return null;
  const placeholder = 'https://via.placeholder.com/150';

  if (kind === 'track') {
    return {
      cover: item.album && item.album.images && item.album.images.length ? item.album.images[0].url : placeholder,
      title: item.name,
      subtitle: item.artists.map((a) => a.name).join(', '),
      thirdLine: item.album ? item.album.name : '',
      metaLeft: formatDuration(item.duration_ms),
      metaRight: 'TRACK',
      spotifyUrl: item.external_urls && item.external_urls.spotify,
      playBody: { uris: [item.uri] }
    };
  }
  if (kind === 'artist') {
    return {
      cover: item.images && item.images.length ? item.images[0].url : placeholder,
      title: item.name,
      subtitle: item.genres && item.genres.length ? item.genres[0] : 'Artist',
      thirdLine: '',
      metaLeft: item.followers ? `${formatFollowers(item.followers.total)} followers` : '',
      metaRight: 'ARTIST',
      spotifyUrl: item.external_urls && item.external_urls.spotify,
      playBody: { context_uri: item.uri }
    };
  }
  if (kind === 'album') {
    return {
      cover: item.images && item.images.length ? item.images[0].url : placeholder,
      title: item.name,
      subtitle: (item.artists || []).map((a) => a.name).join(', '),
      thirdLine: item.release_date ? item.release_date.slice(0, 4) : '',
      metaLeft: typeof item.total_tracks === 'number' ? `${item.total_tracks} tracks` : '',
      metaRight: item.album_type ? item.album_type.toUpperCase() : 'ALBUM',
      spotifyUrl: item.external_urls && item.external_urls.spotify,
      playBody: { context_uri: item.uri }
    };
  }
  if (kind === 'playlist') {
    return {
      cover: item.images && item.images.length ? item.images[0].url : placeholder,
      title: item.name,
      subtitle: item.owner && item.owner.display_name ? `By ${item.owner.display_name}` : 'Playlist',
      thirdLine: '',
      metaLeft: item.tracks && typeof item.tracks.total === 'number' ? `${item.tracks.total} tracks` : '',
      metaRight: 'PLAYLIST',
      spotifyUrl: item.external_urls && item.external_urls.spotify,
      playBody: { context_uri: item.uri }
    };
  }
  return null;
}

// Builds a card for any search result kind, reusing the existing track-card
// layout/CSS. Its play button starts real Spotify Connect playback (uris for
// a single track, context_uri for an artist/album/playlist "start here").
function buildSearchResultCard(kind, item) {
  const meta = getSearchResultMeta(kind, item);
  if (!meta) return null;
  const { cover, title, subtitle, thirdLine, metaLeft, metaRight, spotifyUrl, playBody } = meta;

  const div = document.createElement('div');
  div.className = 'track-card';
  div.innerHTML = `
    <div class="track-card-cover-container">
      <img class="track-card-cover" src="${escapeHtml(cover)}" alt="${escapeHtml(title)}" loading="lazy">
      <div class="track-card-play-overlay">
        <button type="button" class="btn-play-preview btn-search-play" title="Play on Spotify" aria-label="Play &quot;${escapeHtml(title)}&quot; on Spotify">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </button>
      </div>
    </div>
    <div class="track-card-details">
      <a class="track-card-title" href="${escapeHtml(spotifyUrl || '#')}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(title)}">${escapeHtml(title)}</a>
      <span class="track-card-artist" title="${escapeHtml(subtitle)}">${escapeHtml(subtitle)}</span>
      ${thirdLine ? `<span class="track-card-album" title="${escapeHtml(thirdLine)}">${escapeHtml(thirdLine)}</span>` : ''}
      <div class="track-card-meta">
        <span class="track-card-duration">${escapeHtml(metaLeft)}</span>
        <span style="font-size: 0.75rem; color: var(--dim); font-family: var(--mono);">${escapeHtml(metaRight)}</span>
      </div>
    </div>
  `;

  const playBtn = div.querySelector('.btn-search-play');
  if (playBtn && playBody) {
    playBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      playSearchResult(playBody, title, playBtn);
    });
  }

  return div;
}

async function playSearchResult(body, itemName, buttonEl) {
  hideSearchPlayError();
  if (buttonEl) buttonEl.disabled = true;

  try {
    await SpotifyAuth.apiRequest('/me/player/play', { method: 'PUT', body });
    // Optimistic UI elsewhere resyncs on its own poll cycle; nudge it now so
    // the sidebar mini player reflects the new track without a 5s wait.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await pollNowPlaying();
  } catch (err) {
    if (!err.isUnauthorized) {
      showSearchPlayError(playbackErrorMessage(err, `Couldn't play "${itemName}".`));
    }
  } finally {
    if (buttonEl) buttonEl.disabled = false;
  }
}

function showSearchPlayError(message) {
  const el = document.getElementById('search-play-error');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
}

function hideSearchPlayError() {
  const el = document.getElementById('search-play-error');
  if (el) el.classList.add('hidden');
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// PWA install and service-worker updates live in pwa.js (shell caching: sw.js).
