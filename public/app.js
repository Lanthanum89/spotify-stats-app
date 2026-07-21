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
    });
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
      
      // Re-render active tab if it's tracks or recent
      if (currentTab === 'tracks') {
        renderTopTracks(appData.topTracks[currentRange]);
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

  // Logout event listener
  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', (e) => {
      e.preventDefault();
      logout();
    });
  }

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
  
  if (tabId === 'tracks' || tabId === 'artists' || tabId === 'analysis') {
    timeFilter.classList.remove('hidden');
  } else {
    timeFilter.classList.add('hidden');
  }

  if (tabId === 'tracks' || tabId === 'recent') {
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

  } catch (err) {
    console.error('Error fetching dashboard data:', err);
    logout();
  }
}

// RENDER OVERVIEW TAB
function renderOverview() {
  if (!appData.profile || !appData.recentlyPlayed) return;

  const profile = appData.profile;
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

  // 3. Profile Card Details
  const avatarUrl = profile.images && profile.images.length > 0 
    ? profile.images[0].url 
    : 'https://via.placeholder.com/150';
  document.getElementById('profile-img-large').src = avatarUrl;
  document.getElementById('profile-name-large').textContent = profile.display_name;
  document.getElementById('profile-followers').textContent = `${profile.followers.total.toLocaleString('en-GB')} followers`;
  document.getElementById('profile-country').textContent = profile.country;
  document.getElementById('profile-product').textContent = profile.product;

  // 4. Recently Played Teaser (Limit to 5)
  const recentList = document.getElementById('overview-recent-list');
  recentList.innerHTML = '';
  if (recent && recent.items) {
    recent.items.slice(0, 5).forEach(item => {
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

  // 5. Current Favorites Teaser (Limit to 5)
  const tracksList = document.getElementById('overview-tracks-list');
  tracksList.innerHTML = '';
  if (topTracks && topTracks.items) {
    topTracks.items.slice(0, 5).forEach(track => {
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

  if (!forceReload && appData.topArtists[currentRange]) {
    renderTopArtists(appData.topArtists[currentRange]);
    return;
  }

  grid.innerHTML = '<div class="loading-inline" style="grid-column: 1/-1;"><div class="spinner" style="height: 30px; width: 30px; margin: 0 auto;"></div></div>';

  try {
    const res = await spotifyFetch(`/me/top/artists?time_range=${currentRange}&limit=50`);
    const data = await res.json();
    appData.topArtists[currentRange] = data;
    renderTopArtists(data);
  } catch (err) {
    console.error('Error fetching top artists:', err);
    grid.innerHTML = '<div class="loading-inline" style="grid-column: 1/-1;">Failed to load artists. Please try again.</div>';
  }
}

function renderTopArtists(data) {
  const grid = document.getElementById('top-artists-grid');
  grid.innerHTML = '';

  if (!data || !data.items || data.items.length === 0) {
    grid.innerHTML = '<div class="loading-inline" style="grid-column: 1/-1;">No artists found for this period. Keep listening!</div>';
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
    grid.innerHTML = '<div class="loading-inline" style="grid-column: 1/-1;">No artists match your search or filter criteria.</div>';
    return;
  }

  filteredItems.forEach((artist, index) => {
    // Find index of the original item to keep the rank correct
    const originalRank = data.items.findIndex(a => a.id === artist.id) + 1;
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

  // Draw the additional charts on this tab!
  renderHourlyActivityChart(appData.recentlyPlayed);

  const activeTracks = appData.topTracks[currentRange] || appData.topTracks['medium_term'];
  renderPopularityDistribution(activeTracks);
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
    const hoverTitle = `${String(hour).padStart(2, '0')}:00 - ${count} play${count !== 1 ? 's' : ''}`;
    
    svgContent += `
      <rect 
        x="${x}" y="${y}" 
        width="${barWidth}" height="${barHeight}" 
        rx="3" ry="3" 
        fill="${barColor}" 
        opacity="0.8" 
        style="transition: all 0.2s ease-in-out; cursor: pointer;"
        onmouseover="this.setAttribute('opacity', '1'); this.setAttribute('fill', 'var(--accent-bright)')"
        onmouseout="this.setAttribute('opacity', '0.8'); this.setAttribute('fill', '${barColor}')"
      >
        <title>${hoverTitle}</title>
      </rect>
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

// PWA install support — only caches the static shell, see sw.js.
// Relative path so registration resolves correctly under a subpath (e.g. GitHub Pages).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js');
  });
}
