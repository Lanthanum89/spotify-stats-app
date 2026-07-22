// SoundTracks App JavaScript Logic
let currentTab = 'overview';
let currentRange = 'medium_term'; // short_term, medium_term, long_term
let currentView = 'grid'; // grid, list
let artistFilter = ''; // Filter string for top artists grid
let trackFilter = ''; // Filter string for top tracks grid

// Audio preview player state
let activeAudio = null;
let activePlayButton = null;
let activeTrackCard = null;

let appData = {
  profile: null,
  topTracks: {}, // Keyed by range
  topArtists: {}, // Keyed by range
  recentlyPlayed: null
};

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
  contextName: null
};
let nowPlayingPollCount = 0;
let miniPlayerControlPending = false;

// --- Spotify API Helper ---
// apiPath is a path under https://api.spotify.com/v1 (e.g. '/me/top/tracks?...').
async function spotifyFetch(apiPath) {
  try {
    return await SpotifyAuth.apiFetch(apiPath);
  } catch (err) {
    if (err.isUnauthorized) {
      showLoginScreen();
    }
    throw err;
  }
}

function logout() {
  stopNowPlayingPolling();
  SpotifyAuth.disconnectSpotify();
  showLoginScreen();
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

// Initialise App
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  checkAuthStatus();
});

// Check if user is authenticated
async function checkAuthStatus() {
  try {
    // If this page load is Spotify redirecting back with ?code=/?error=, finish
    // the PKCE exchange first — this also scrubs those params from the URL.
    const redirectResult = await SpotifyAuth.handleRedirect();

    if (redirectResult.handled) {
      if (redirectResult.success) {
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
  document.getElementById('login-container').classList.remove('hidden');
  document.getElementById('app-container').classList.add('hidden');
}

function showDashboardScreen() {
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
  sidebar.setAttribute('aria-expanded', String(!collapsed));
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
  } else if (errorType === 'failed_connection') {
    msg = 'Unable to reach Spotify. Check your connection and try again.';
  }
  
  banner.textContent = msg;
}

// Setup Event Listeners
function setupEventListeners() {
  // Navigation tabs
  document.querySelectorAll('.nav-item').forEach(button => {
    button.addEventListener('click', () => {
      const tabId = button.getAttribute('data-tab');
      switchTab(tabId);
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
    });
  }

  // Playback transport controls — sidebar mini player and the Overview Now
  // Playing panel each get their own set of prev/play/next buttons, wired
  // up identically (stopPropagation so the sidebar's set doesn't also
  // trigger the click-anywhere sidebar collapse toggle above).
  TRANSPORT_BUTTON_SETS.forEach(({ prev, play, next }) => {
    const prevBtn = document.getElementById(prev);
    const playBtn = document.getElementById(play);
    const nextBtn = document.getElementById(next);

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
      } else if (currentTab === 'analysis') {
        loadAnalysisTab(true);
      }
    });
  });

  // View toggle buttons (Grid vs List)
  document.querySelectorAll('.view-toggle-btn').forEach(button => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.view-toggle-btn').forEach(btn => btn.classList.remove('active'));
      button.classList.add('active');
      currentView = button.getAttribute('data-view');
      
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

  // Artist search input field
  const searchInput = document.getElementById('artist-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      artistFilter = e.target.value;
      
      // Toggle badge visibility based on filter presence
      const filterBadge = document.getElementById('artist-active-filter');
      const badgeText = document.getElementById('filter-badge-text');
      
      if (artistFilter) {
        filterBadge.classList.remove('hidden');
        badgeText.textContent = artistFilter;
      } else {
        filterBadge.classList.add('hidden');
      }
      
      renderTopArtists(appData.topArtists[currentRange] || appData.topArtists['medium_term']);
    });
  }

  // Clear artist filter badge button
  const clearFilterBtn = document.getElementById('btn-clear-artist-filter');
  if (clearFilterBtn) {
    clearFilterBtn.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      artistFilter = '';
      document.getElementById('artist-active-filter').classList.add('hidden');
      renderTopArtists(appData.topArtists[currentRange] || appData.topArtists['medium_term']);
    });
  }

  // Track search input field
  const trackSearchInput = document.getElementById('track-search-input');
  if (trackSearchInput) {
    trackSearchInput.addEventListener('input', (e) => {
      trackFilter = e.target.value;
      
      const filterBadge = document.getElementById('track-active-filter');
      const badgeText = document.getElementById('track-filter-badge-text');
      
      if (trackFilter) {
        filterBadge.classList.remove('hidden');
        badgeText.textContent = trackFilter;
      } else {
        filterBadge.classList.add('hidden');
      }
      
      renderTopTracks(appData.topTracks[currentRange] || appData.topTracks['medium_term']);
    });
  }

  // Clear track filter badge button
  const clearTrackFilterBtn = document.getElementById('btn-clear-track-filter');
  if (clearTrackFilterBtn) {
    clearTrackFilterBtn.addEventListener('click', () => {
      if (trackSearchInput) trackSearchInput.value = '';
      trackFilter = '';
      document.getElementById('track-active-filter').classList.add('hidden');
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

// Switch tabs logic
function switchTab(tabId) {
  currentTab = tabId;

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

  // Show/Hide time range filter and view toggle controls
  const timeFilter = document.getElementById('time-filter-container');
  const viewToggle = document.getElementById('view-toggle-container');

  // On Analysis, the range selector only affects the genre/popularity/quadrant
  // charts (not the last-50-based metrics/hourly chart) — so it's relocated to
  // sit directly above those charts instead of the shared tab header, where it
  // would misleadingly look like it applies to everything in the tab.
  const analysisSlot = document.getElementById('analysis-time-filter-slot');
  const headerControls = document.querySelector('.header-controls');

  if (tabId === 'analysis') {
    analysisSlot.appendChild(timeFilter);
    timeFilter.classList.remove('hidden');
  } else {
    headerControls.appendChild(timeFilter);
    if (tabId === 'tracks' || tabId === 'artists') {
      timeFilter.classList.remove('hidden');
    } else {
      timeFilter.classList.add('hidden');
    }
  }

  if (tabId === 'tracks' || tabId === 'artists' || tabId === 'recent') {
    viewToggle.classList.remove('hidden');
    // Ensure the toggle buttons show correct active view status
    document.querySelectorAll('.view-toggle-btn').forEach(btn => {
      if (btn.getAttribute('data-view') === currentView) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  } else {
    viewToggle.classList.add('hidden');
  }

  // Update header title
  const titles = {
    overview: 'overview',
    tracks: 'top-tracks',
    artists: 'top-artists',
    analysis: 'analysis',
    recent: 'recent'
  };
  document.getElementById('current-tab-title').textContent = titles[tabId] || 'dashboard';

  // Toggle tab panels
  document.querySelectorAll('.tab-pane').forEach(pane => {
    pane.classList.remove('active');
  });
  document.getElementById(`tab-${tabId}`).classList.add('active');

  // Load tab data
  if (tabId === 'overview') {
    renderOverview();
  } else if (tabId === 'tracks') {
    loadTopTracks();
  } else if (tabId === 'artists') {
    loadTopArtists();
  } else if (tabId === 'analysis') {
    loadAnalysisTab();
  } else if (tabId === 'recent') {
    loadRecentlyPlayed();
  }
}

// Load and cache all initial dashboard data
async function loadDashboard() {
  showDashboardScreen();
  
  try {
    // Fetch profile and recently played immediately
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

    // Fill user bar details
    document.getElementById('user-name').textContent = appData.profile.display_name;
    const avatarUrl = appData.profile.images && appData.profile.images.length > 0 
      ? appData.profile.images[0].url 
      : 'https://via.placeholder.com/40';
    document.getElementById('user-avatar').src = avatarUrl;
    document.getElementById('user-account-type').textContent = appData.profile.product.toUpperCase();

    // Render overview tab first
    renderOverview();
    startNowPlayingPolling();

  } catch (err) {
    console.error('Error fetching dashboard data:', err);
    logout();
  }
}

// RENDER OVERVIEW TAB
function renderOverview() {
  if (!appData.profile || !appData.recentlyPlayed) return;

  const recent = appData.recentlyPlayed;
  const topTracks = appData.topTracks['medium_term'];
  const topArtists = appData.topArtists['medium_term'];

  // 1. Calculate Playtime (Last 50 songs)
  let totalPlaytimeMs = 0;
  if (recent && recent.items) {
    recent.items.forEach(item => {
      totalPlaytimeMs += item.track.duration_ms;
    });
  }
  const totalPlaytimeMins = Math.round(totalPlaytimeMs / 60000);
  document.getElementById('stat-recent-playtime').textContent = `${totalPlaytimeMins} mins`;

  // 2. Favorite Track / Artist labels
  if (topTracks && topTracks.items && topTracks.items.length > 0) {
    document.getElementById('stat-favorite-track').textContent = topTracks.items[0].name;
  } else {
    document.getElementById('stat-favorite-track').textContent = 'None';
  }

  if (topArtists && topArtists.items && topArtists.items.length > 0) {
    document.getElementById('stat-favorite-artist').textContent = topArtists.items[0].name;
  } else {
    document.getElementById('stat-favorite-artist').textContent = 'None';
  }

  // 3. Recently Played Teaser (Limit to 2, keeps Overview fitting one screen)
  const recentList = document.getElementById('overview-recent-list');
  recentList.innerHTML = '';
  if (recent && recent.items) {
    recent.items.slice(0, 2).forEach(item => {
      const track = item.track;
      const cover = track.album.images && track.album.images.length > 0 
        ? track.album.images[0].url 
        : 'https://via.placeholder.com/44';
      const artistsName = track.artists.map(a => a.name).join(', ');
      
      const div = document.createElement('div');
      div.className = 'mini-track-item';
      div.innerHTML = `
        <img class="mini-track-cover" src="${cover}" alt="${track.name}">
        <div class="mini-track-info">
          <span class="mini-track-title">${track.name}</span>
          <span class="mini-track-artist">${artistsName}</span>
        </div>
        <div class="mini-track-meta">
          <span>${formatRelativeTime(item.played_at)}</span>
        </div>
      `;
      recentList.appendChild(div);
    });
  }

  // 5. Current Favorites Teaser (Limit to 2, keeps Overview fitting one screen)
  const tracksList = document.getElementById('overview-tracks-list');
  tracksList.innerHTML = '';
  if (topTracks && topTracks.items) {
    topTracks.items.slice(0, 2).forEach(track => {
      const cover = track.album.images && track.album.images.length > 0 
        ? track.album.images[0].url 
        : 'https://via.placeholder.com/44';
      const artistsName = track.artists.map(a => a.name).join(', ');
      
      const div = document.createElement('div');
      div.className = 'mini-track-item';
      div.innerHTML = `
        <img class="mini-track-cover" src="${cover}" alt="${track.name}">
        <div class="mini-track-info">
          <span class="mini-track-title">${track.name}</span>
          <span class="mini-track-artist">${artistsName}</span>
        </div>
        <div class="mini-track-meta">
          <span>${formatDuration(track.duration_ms)}</span>
        </div>
      `;
      tracksList.appendChild(div);
    });
  }

  // 6. Genres summary teaser
  renderMiniGenres(topArtists);
}

// --- NOW PLAYING ---
// Polls /me/player/currently-playing periodically for the real state, and
// ticks a local timer between polls so the progress bar advances smoothly
// without hammering the API every second.

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
  let response;
  try {
    response = await spotifyFetch('/me/player/currently-playing');
  } catch (err) {
    if (err.status === 403) {
      // Session was authorised before user-read-currently-playing existed —
      // needs a fresh login to pick up the new scope.
      stopNowPlayingPolling();
      renderNowPlayingNeedsReconnect();
      return;
    }
    // spotifyFetch already handles 401 (shows login screen); anything else
    // (network blip, rate limit) just skips this poll — we'll try again shortly.
    return;
  }

  if (response.status === 204) {
    renderNowPlayingIdle();
    return;
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    return;
  }

  if (!data || !data.item) {
    renderNowPlayingIdle();
    return;
  }

  await renderNowPlayingActive(data);
}

function renderNowPlayingIdle() {
  nowPlayingState = { trackId: null, isPlaying: false, progressMs: 0, durationMs: 0, lastSyncedAt: 0, contextUri: null, contextName: null };
  document.getElementById('now-playing-status-badge').classList.add('hidden');
  document.getElementById('now-playing-content').innerHTML =
    '<div class="loading-inline">Nothing playing right now. Start a track on Spotify to see it here.</div>';
  hideSidebarMiniPlayer();
}

function renderNowPlayingNeedsReconnect() {
  document.getElementById('now-playing-status-badge').classList.add('hidden');
  document.getElementById('now-playing-content').innerHTML =
    '<div class="loading-inline">Reconnect your Spotify account to enable Now Playing (needs one extra permission).</div>';
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
        <img id="now-playing-cover" class="now-playing-cover" src="${cover}" alt="${track.name}">
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

  renderSidebarMiniPlayer(track, cover, artistsName);
  showNowPlayingControls();
  updateAllPlayIcons();
  nowPlayingPollCount++;
  refreshQueue(isNewTrack);

  updateNowPlayingProgressUI();
}

// --- SIDEBAR MINI PLAYER ---
// Compact echo of the Overview Now Playing panel, shown above the user's
// name in the sidebar footer: cover, track/artist, and skip controls.

function renderSidebarMiniPlayer(track, cover, artistsName) {
  const panel = document.getElementById('sidebar-mini-player');
  if (!panel) return;
  panel.classList.remove('hidden');

  const coverEl = document.getElementById('mini-player-cover');
  const trackEl = document.getElementById('mini-player-track');
  const artistEl = document.getElementById('mini-player-artist');
  if (coverEl) { coverEl.src = cover; coverEl.alt = track.name; }
  if (trackEl) { trackEl.textContent = track.name; trackEl.title = track.name; }
  if (artistEl) { artistEl.textContent = artistsName; artistEl.title = artistsName; }
}

function hideSidebarMiniPlayer() {
  const panel = document.getElementById('sidebar-mini-player');
  if (panel) panel.classList.add('hidden');
  hideNowPlayingControls();
  nowPlayingPollCount = 0;
  renderOverviewQueue([]);
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

const QUEUE_REFRESH_EVERY_N_POLLS = 4; // ~20s at the 5s poll interval

async function refreshQueue(force) {
  if (!force && nowPlayingPollCount % QUEUE_REFRESH_EVERY_N_POLLS !== 0) return;

  try {
    const response = await spotifyFetch('/me/player/queue');
    const data = await response.json();
    renderOverviewQueue(data.queue || []);
  } catch (err) {
    // Needs user-read-playback-state (older sessions won't have it yet) —
    // just leave the queue preview empty rather than erroring.
  }
}

// "Up Next" panel on the Overview tab — a roomier version of the sidebar's
// queue preview, reusing the same mini-track-item markup as the other
// Overview teaser lists.
function renderOverviewQueue(queue) {
  const list = document.getElementById('overview-queue-list');
  if (!list) return;

  const upcoming = queue.slice(0, 5);
  if (upcoming.length === 0) {
    list.innerHTML = '<div class="loading-inline">Nothing queued right now.</div>';
    return;
  }

  list.innerHTML = '';
  upcoming.forEach((track) => {
    const cover = track.album && track.album.images && track.album.images.length > 0
      ? track.album.images[0].url
      : 'https://via.placeholder.com/44';
    const artistsName = (track.artists || []).map((a) => a.name).join(', ');

    const div = document.createElement('div');
    div.className = 'mini-track-item';
    div.innerHTML = `
      <img class="mini-track-cover" src="${cover}" alt="${track.name}">
      <div class="mini-track-info">
        <span class="mini-track-title">${track.name}</span>
        <span class="mini-track-artist">${artistsName}</span>
      </div>
    `;
    list.appendChild(div);
  });
}

// Playback transport controls — shared between the sidebar mini player and
// the Overview Now Playing panel, which each have their own button/error IDs.
const TRANSPORT_BUTTON_SETS = [
  { prev: 'mini-player-prev', play: 'mini-player-play', next: 'mini-player-next', error: 'mini-player-error' },
  { prev: 'now-playing-prev', play: 'now-playing-play', next: 'now-playing-next', error: 'now-playing-controls-error' },
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
    if (err.status === 403) {
      showAllControlErrors('Playback control needs Spotify Premium.');
    } else if (err.status === 404) {
      showAllControlErrors('No active Spotify device found.');
    } else {
      showAllControlErrors('Playback control failed.');
    }
  } finally {
    miniPlayerControlPending = false;
    setAllControlsDisabled(false);
  }
}

function setAllControlsDisabled(disabled) {
  TRANSPORT_BUTTON_SETS.forEach(({ prev, play, next }) => {
    [prev, play, next].forEach((id) => {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = disabled;
    });
  });
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

// Render Mini Genres List on Overview
function renderMiniGenres(topArtists) {
  const container = document.getElementById('overview-genres-list');
  container.innerHTML = '';

  if (!topArtists || !topArtists.items || topArtists.items.length === 0) {
    container.innerHTML = '<div class="loading-inline">No genre data available.</div>';
    return;
  }

  const genreCounts = {};
  topArtists.items.forEach(artist => {
    artist.genres.forEach(genre => {
      genreCounts[genre] = (genreCounts[genre] || 0) + 1;
    });
  });

  const sortedGenres = Object.entries(genreCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3); // Top 3

  const totalHits = Object.values(genreCounts).reduce((a, b) => a + b, 0);

  if (sortedGenres.length === 0) {
    container.innerHTML = '<div class="loading-inline">Not enough artist data to map genres.</div>';
    return;
  }

  sortedGenres.forEach(([genre, count]) => {
    const percentage = Math.round((count / totalHits) * 100);
    const item = document.createElement('div');
    item.className = 'genre-bar-container interactive-genre-bar';
    item.title = `Click to filter artists by ${genre}`;
    item.innerHTML = `
      <div class="genre-bar-info">
        <span class="genre-bar-name">${genre}</span>
        <span class="genre-bar-percentage">${percentage}%</span>
      </div>
      <div class="genre-bar-wrapper">
        <div class="genre-bar-fill" style="width: ${percentage}%"></div>
      </div>
    `;
    item.addEventListener('click', () => {
      applyGenreFilterToArtists(genre);
    });
    container.appendChild(item);
  });
}

// LOAD TOP TRACKS
async function loadTopTracks(forceReload = false) {
  const tbody = document.getElementById('top-tracks-table-body');
  const grid = document.getElementById('top-tracks-grid');
  
  if (!forceReload && appData.topTracks[currentRange]) {
    renderTopTracks(appData.topTracks[currentRange]);
    return;
  }

  const spinnerHtml = '<div class="loading-inline" style="grid-column: 1/-1;"><div class="spinner" style="height: 30px; width: 30px; margin: 0 auto;"></div></div>';
  tbody.innerHTML = '<tr><td colspan="5" class="loading-inline"><div class="spinner" style="height: 30px; width: 30px; margin: 0 auto;"></div></td></tr>';
  grid.innerHTML = spinnerHtml;

  try {
    const res = await spotifyFetch(`/me/top/tracks?time_range=${currentRange}&limit=50`);
    const data = await res.json();
    appData.topTracks[currentRange] = data;
    renderTopTracks(data);
  } catch (err) {
    console.error('Error fetching top tracks:', err);
    tbody.innerHTML = '<tr><td colspan="5" class="loading-inline">Failed to load tracks. Please try again.</td></tr>';
    grid.innerHTML = '<div class="loading-inline" style="grid-column: 1/-1;">Failed to load tracks. Please try again.</div>';
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
        <td>
          <div class="popularity-meter" title="${track.popularity}% popularity">
            <div class="popularity-fill" style="width: ${track.popularity}%"></div>
          </div>
        </td>
        <td style="text-align: right;">${formatDuration(track.duration_ms)}</td>
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
    return;
  }

  const spinnerHtml = '<div class="loading-inline" style="grid-column: 1/-1;"><div class="spinner" style="height: 30px; width: 30px; margin: 0 auto;"></div></div>';
  grid.innerHTML = spinnerHtml;
  tbody.innerHTML = '<tr><td colspan="5" class="loading-inline"><div class="spinner" style="height: 30px; width: 30px; margin: 0 auto;"></div></td></tr>';

  try {
    const res = await spotifyFetch(`/me/top/artists?time_range=${currentRange}&limit=50`);
    const data = await res.json();
    appData.topArtists[currentRange] = data;
    renderTopArtists(data);
  } catch (err) {
    console.error('Error fetching top artists:', err);
    grid.innerHTML = '<div class="loading-inline" style="grid-column: 1/-1;">Failed to load artists. Please try again.</div>';
    tbody.innerHTML = '<tr><td colspan="5" class="loading-inline">Failed to load artists. Please try again.</td></tr>';
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
        <img class="track-card-cover" src="${photo}" alt="${artist.name}">
        <div class="track-card-play-overlay">
          <a class="btn-play-preview btn-spotify-link" href="${spotifyUrl}" target="_blank" rel="noopener noreferrer" title="Open in Spotify">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm4.586 14.424c-.18.295-.565.387-.86.207-2.377-1.454-5.37-1.783-8.894-.982-.336.077-.67-.137-.747-.473-.077-.337.137-.67.473-.748 3.854-.88 7.15-.502 9.822 1.135.296.18.387.565.206.86zm1.223-2.72c-.227.367-.707.487-1.074.26-2.72-1.672-6.866-2.155-10.073-1.182-.413.125-.847-.107-.972-.52-.125-.413.108-.847.52-.972 3.666-1.112 8.225-.573 11.338 1.34.368.226.488.706.26 1.074zm.107-2.825C14.502 8.84 9.17 8.663 6.074 9.603c-.522.158-1.074-.142-1.233-.664-.158-.522.142-1.074.664-1.233 3.563-1.082 9.44-.88 13.34 1.436.47.278.623.882.345 1.352-.278.47-.882.622-1.352.345z"/></svg>
          </a>
        </div>
        <span class="track-card-rank">#${originalRank}</span>
      </div>
      <div class="track-card-details">
        <a class="track-card-title" href="${spotifyUrl}" target="_blank" rel="noopener noreferrer" title="${artist.name}">${artist.name}</a>
        <span class="track-card-artist" style="text-transform: capitalize;">${mainGenre}</span>
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
      <td>${formatFollowers(artist.followers.total)}</td>
      <td style="text-align: right;">
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
async function loadAnalysisTab(forceReload = false) {
  const needsArtists = forceReload || !appData.topArtists[currentRange];
  const needsTracks = forceReload || !appData.topTracks[currentRange];

  if (needsArtists || needsTracks) {
    const chartContainer = document.getElementById('genres-chart-container');
    const popularityContainer = document.getElementById('popularity-distribution-container');
    
    if (chartContainer) chartContainer.innerHTML = '<div class="loading-inline"><div class="spinner" style="height: 30px; width: 30px; margin: 0 auto;"></div></div>';
    if (popularityContainer) popularityContainer.innerHTML = '<div class="loading-inline"><div class="spinner" style="height: 30px; width: 30px; margin: 0 auto;"></div></div>';

    try {
      const promises = [];
      if (needsArtists) {
        promises.push(
          spotifyFetch(`/me/top/artists?time_range=${currentRange}&limit=50`)
            .then(res => res.json())
            .then(data => { appData.topArtists[currentRange] = data; })
        );
      }
      if (needsTracks) {
        promises.push(
          spotifyFetch(`/me/top/tracks?time_range=${currentRange}&limit=50`)
            .then(res => res.json())
            .then(data => { appData.topTracks[currentRange] = data; })
        );
      }
      await Promise.all(promises);
    } catch (err) {
      console.error('Error fetching analysis data:', err);
      if (chartContainer) chartContainer.innerHTML = '<div class="loading-inline">Failed to load data.</div>';
      if (popularityContainer) popularityContainer.innerHTML = '<div class="loading-inline">Failed to load data.</div>';
      return;
    }
  }

  renderAnalysisTab();
}

// RENDER GENRES TAB
function renderAnalysisTab() {
  const chartContainer = document.getElementById('genres-chart-container');
  const donutContainer = document.getElementById('genre-donut');
  const tasteTitle = document.getElementById('taste-title');
  const tasteDesc = document.getElementById('taste-description');
  const primaryGenreVal = document.getElementById('genre-stat-primary');
  const uniqueGenresVal = document.getElementById('genre-stat-unique');
  const topShareVal = document.getElementById('genre-stat-share');

  // We analyze the genres of the active Top Artists list
  const activeArtists = appData.topArtists[currentRange] || appData.topArtists['medium_term'];

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

  const sortedGenres = Object.entries(genreCounts)
    .sort((a, b) => b[1] - a[1]);

  const totalHits = Object.values(genreCounts).reduce((a, b) => a + b, 0);
  const uniqueCount = sortedGenres.length;

  primaryGenreVal.textContent = sortedGenres.length > 0 ? sortedGenres[0][0] : '-';
  uniqueGenresVal.textContent = uniqueCount;
  topShareVal.textContent = sortedGenres.length > 0
    ? `${Math.round((sortedGenres[0][1] / totalHits) * 100)}%`
    : '0%';

  const recentItems = appData.recentlyPlayed?.items || [];
  const recentDurationMs = recentItems.reduce((total, item) => total + item.track.duration_ms, 0);
  const averageDurationMs = recentItems.length > 0 ? recentDurationMs / recentItems.length : 0;
  document.getElementById('genre-metric-plays').textContent = recentItems.length.toLocaleString('en-GB');
  document.getElementById('genre-metric-hours').textContent = formatHours(recentDurationMs);
  document.getElementById('genre-metric-average').textContent = formatDuration(averageDurationMs);
  document.getElementById('genre-metric-unique').textContent = uniqueCount.toLocaleString('en-GB');

  // Render a focused top-six distribution and group the long tail.
  chartContainer.innerHTML = '';
  const displayGenres = sortedGenres.slice(0, 6);

  displayGenres.forEach(([genre, count], index) => {
    const percentage = Math.round((count / totalHits) * 100);
    const bar = document.createElement('div');
    bar.className = 'genre-bar-container interactive-genre-bar';
    bar.title = `Click to filter artists by ${genre}`;
    bar.innerHTML = `
      <div class="genre-bar-info">
        <span class="genre-bar-name">${String(index + 1).padStart(2, '0')} / ${genre}</span>
        <span class="genre-bar-percentage">${count} artist${count > 1 ? 's' : ''} · ${percentage}%</span>
      </div>
      <div class="genre-bar-wrapper">
        <div class="genre-bar-fill" style="width: ${percentage}%"></div>
      </div>
    `;
    bar.addEventListener('click', () => {
      applyGenreFilterToArtists(genre);
    });
    chartContainer.appendChild(bar);
  });

  renderGenreDonut(sortedGenres, totalHits);

  // Taste Classification Logic
  if (sortedGenres.length === 0) {
    tasteTitle.textContent = 'Insufficient signal';
    tasteDesc.textContent = 'Listen to more artists on Spotify to build a useful genre profile.';
    return;
  }

  const topGenre = sortedGenres[0][0].toLowerCase();
  
  // Custom classification based on top genre
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

  // Update data source labels dynamically based on selected range
  const rangeLabels = {
    short_term: '4 weeks',
    medium_term: '6 months',
    long_term: 'all time'
  };
  const rangeLabel = rangeLabels[currentRange] || '6 months';
  
  const genresSource = document.getElementById('analysis-genres-source');
  if (genresSource) {
    genresSource.textContent = `top 50 artists (${rangeLabel})`;
  }
  
  const popularitySource = document.getElementById('analysis-popularity-source');
  if (popularitySource) {
    popularitySource.textContent = `top 50 songs (${rangeLabel})`;
  }

  const quadrantSource = document.getElementById('analysis-quadrant-source');
  if (quadrantSource) {
    quadrantSource.textContent = `top 50 songs (${rangeLabel})`;
  }

  const artistPopularitySource = document.getElementById('analysis-artist-popularity-source');
  if (artistPopularitySource) {
    artistPopularitySource.textContent = `top 50 artists (${rangeLabel})`;
  }

  const durationSource = document.getElementById('analysis-duration-source');
  if (durationSource) {
    durationSource.textContent = `top 50 songs (${rangeLabel})`;
  }

  const contributingSource = document.getElementById('analysis-contributing-source');
  if (contributingSource) {
    contributingSource.textContent = `top 50 songs (${rangeLabel})`;
  }

  const artistQuadrantSource = document.getElementById('analysis-artist-quadrant-source');
  if (artistQuadrantSource) {
    artistQuadrantSource.textContent = `top 50 artists (${rangeLabel})`;
  }

  const durationQuadrantSource = document.getElementById('analysis-duration-quadrant-source');
  if (durationQuadrantSource) {
    durationQuadrantSource.textContent = `top 50 songs (${rangeLabel})`;
  }

  const followersQuadrantSource = document.getElementById('analysis-followers-quadrant-source');
  if (followersQuadrantSource) {
    followersQuadrantSource.textContent = `top 50 artists (${rangeLabel})`;
  }

  // Draw the additional charts on this tab!
  renderHourlyActivityChart(appData.recentlyPlayed);
  renderDayOfWeekActivityChart(appData.recentlyPlayed);

  const activeTracks = appData.topTracks[currentRange] || appData.topTracks['medium_term'];
  renderPopularityDistribution(activeTracks);
  renderArtistPopularityDistribution(activeArtists);
  renderDurationDistribution(activeTracks);
  renderTopContributingArtists(activeTracks);
  renderPopularityRankQuadrant(activeTracks);
  renderArtistRankQuadrant(activeArtists);
  renderDurationPopularityQuadrant(activeTracks);
  renderFollowersPopularityQuadrant(activeArtists);
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
    renderRecentlyPlayed(data);
  } catch (err) {
    console.error('Error fetching recently played:', err);
    tbody.innerHTML = '<tr><td colspan="5" class="loading-inline">Failed to load recently played tracks. Please try again.</td></tr>';
    grid.innerHTML = '<div class="loading-inline" style="grid-column: 1/-1;">Failed to load recently played tracks. Please try again.</div>';
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
        <td>
          <span class="played-at-time">${formatRelativeTime(item.played_at)}</span>
        </td>
        <td style="text-align: right;">${formatDuration(track.duration_ms)}</td>
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
    
    const playButton = track.preview_url 
      ? `<button class="btn-play-preview" data-preview-url="${track.preview_url}" title="Play Preview">
           <svg class="${btnIconClass}" viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
           <svg class="${btnPauseClass}" viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
         </button>`
      : `<a class="btn-play-preview btn-spotify-link" href="${spotifyUrl}" target="_blank" rel="noopener noreferrer" title="Open in Spotify">
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
        <img class="track-card-cover" src="${cover}" alt="${track.name}">
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
        <a class="track-card-title" href="${spotifyUrl}" target="_blank" rel="noopener noreferrer" title="${track.name}">${track.name}</a>
        <span class="track-card-artist" title="${artistsName}">${artistsName}</span>
        <span class="track-card-album" title="${track.album.name}">${track.album.name}</span>
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

  // Case 1: Clicked on a currently playing preview -> Pause it
  if (activeAudio && activeAudio.src === previewUrl) {
    if (activeAudio.paused) {
      activeAudio.play().catch(err => console.error("Error playing audio:", err));
      playIcon.classList.add('hidden');
      pauseIcon.classList.remove('hidden');
      card.classList.add('playing');
      if (eq) eq.classList.remove('hidden');
    } else {
      activeAudio.pause();
      playIcon.classList.remove('hidden');
      pauseIcon.classList.add('hidden');
      card.classList.remove('playing');
      if (eq) eq.classList.add('hidden');
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
  
  const filterBadge = document.getElementById('artist-active-filter');
  const badgeText = document.getElementById('filter-badge-text');
  if (filterBadge && badgeText) {
    filterBadge.classList.remove('hidden');
    badgeText.textContent = genre;
  }
  
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

  attachChartTooltip(container, container.querySelectorAll('.hourly-bar'), (bar) => {
    const hour = bar.getAttribute('data-hour');
    const count = bar.getAttribute('data-count');
    return `${String(hour).padStart(2, '0')}:00 — ${count} play${count !== '1' ? 's' : ''}`;
  });
}

// Wires up a floating tooltip that follows the mouse over a set of SVG shapes.
// getLabel(el) returns the text to show for the hovered element.
function attachChartTooltip(container, elements, getLabel) {
  let tooltip = container.querySelector('.chart-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip hidden';
    container.appendChild(tooltip);
  }

  elements.forEach((el) => {
    el.addEventListener('mouseenter', () => {
      tooltip.textContent = getLabel(el);
      tooltip.classList.remove('hidden');
    });
    el.addEventListener('mousemove', (e) => {
      const rect = container.getBoundingClientRect();
      tooltip.style.left = `${e.clientX - rect.left}px`;
      tooltip.style.top = `${e.clientY - rect.top}px`;
    });
    el.addEventListener('mouseleave', () => {
      tooltip.classList.add('hidden');
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

  attachChartTooltip(container, container.querySelectorAll('.day-of-week-bar'), (bar) => {
    const day = bar.getAttribute('data-day');
    const count = bar.getAttribute('data-count');
    return `${day} — ${count} play${count !== '1' ? 's' : ''}`;
  });
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
// normalize their own data into that space before calling this.
function renderQuadrantScatter(container, points, labels) {
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

  attachChartTooltip(container, container.querySelectorAll('.quadrant-dot'), (dot) => {
    return points[Number(dot.getAttribute('data-index'))].tooltip;
  });
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

  renderQuadrantScatter(container, points, RANK_QUADRANT_LABELS);
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

  renderQuadrantScatter(container, points, RANK_QUADRANT_LABELS);
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
  });
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
  });
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// PWA install support — only caches the static shell, see sw.js.
// Relative path so registration resolves correctly under a subpath (e.g. GitHub Pages).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js');
  });
}
