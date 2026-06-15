require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure session middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'spotify-stats-default-secret-key-12345',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // Set to true if using HTTPS
}));

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Middleware to check if user is authenticated
function isAuthenticated(req, res, next) {
  if (req.session && req.session.accessToken) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized. Please login first.' });
}

// Helper function to handle Spotify API calls with automatic token refresh
async function spotifyFetch(url, req) {
  let response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${req.session.accessToken}`
    }
  });

  // If token has expired (401), try to refresh it
  if (response.status === 401 && req.session.refreshToken) {
    console.log('Access token expired. Attempting token refresh...');
    const refreshed = await refreshAccessToken(req);
    if (refreshed) {
      // Retry the original request with the new token
      response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${req.session.accessToken}`
        }
      });
    }
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Spotify API error: ${response.status} - ${errorText}`);
  }

  return response.json();
}

// Helper to exchange refresh token for new access token
async function refreshAccessToken(req) {
  const tokenUrl = 'https://accounts.spotify.com/api/token';
  const credentials = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');

  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: req.session.refreshToken
      })
    });

    if (response.ok) {
      const data = await response.json();
      req.session.accessToken = data.access_token;
      if (data.refresh_token) {
        req.session.refreshToken = data.refresh_token; // Sometimes a new refresh token is returned
      }
      console.log('Token refreshed successfully.');
      return true;
    } else {
      console.error('Failed to refresh token:', await response.text());
      return false;
    }
  } catch (error) {
    console.error('Error refreshing access token:', error);
    return false;
  }
}

// --- Routes ---

// Login route: Redirects to Spotify Authorization page
app.get('/login', (req, res) => {
  const client_id = process.env.SPOTIFY_CLIENT_ID;
  const redirect_uri = process.env.REDIRECT_URI;
  
  if (!client_id || !redirect_uri) {
    return res.send('Error: SPOTIFY_CLIENT_ID or REDIRECT_URI is not set in the .env file. Please read the setup instructions.');
  }

  const scopes = [
    'user-read-private',
    'user-read-email',
    'user-top-read',
    'user-read-recently-played'
  ].join(' ');

  const authUrl = new URL('https://accounts.spotify.com/authorize');
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('client_id', client_id);
  authUrl.searchParams.append('scope', scopes);
  authUrl.searchParams.append('redirect_uri', redirect_uri);
  authUrl.searchParams.append('show_dialog', 'true'); // Forces dialog to show up for user switching

  res.redirect(authUrl.toString());
});

// Callback route: Handles the redirect back from Spotify
app.get('/callback', async (req, res) => {
  const code = req.query.code || null;
  const error = req.query.error || null;

  if (error) {
    console.error('Spotify Auth error:', error);
    return res.redirect(`/?error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return res.redirect('/?error=no_code');
  }

  const tokenUrl = 'https://accounts.spotify.com/api/token';
  const credentials = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');

  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: process.env.REDIRECT_URI
      })
    });

    if (response.ok) {
      const data = await response.json();
      req.session.accessToken = data.access_token;
      req.session.refreshToken = data.refresh_token;
      res.redirect('/');
    } else {
      const errBody = await response.text();
      console.error('Token exchange error:', errBody);
      res.redirect(`/?error=token_exchange_failed`);
    }
  } catch (err) {
    console.error('Error during token exchange:', err);
    res.redirect(`/?error=server_error`);
  }
});

// Check authentication status
app.get('/api/auth-status', (req, res) => {
  if (req.session && req.session.accessToken) {
    res.json({ authenticated: true });
  } else {
    res.json({ authenticated: false });
  }
});

// Logout route
app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Error destroying session:', err);
    }
    res.redirect('/');
  });
});

// API: Get current user profile
app.get('/api/profile', isAuthenticated, async (req, res) => {
  try {
    const data = await spotifyFetch('https://api.spotify.com/v1/me', req);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Get user's top tracks
app.get('/api/top/tracks', isAuthenticated, async (req, res) => {
  const timeRange = req.query.time_range || 'medium_term'; // short_term, medium_term, long_term
  const limit = req.query.limit || 50;
  try {
    const data = await spotifyFetch(`https://api.spotify.com/v1/me/top/tracks?time_range=${timeRange}&limit=${limit}`, req);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Get user's top artists
app.get('/api/top/artists', isAuthenticated, async (req, res) => {
  const timeRange = req.query.time_range || 'medium_term';
  const limit = req.query.limit || 50;
  try {
    const data = await spotifyFetch(`https://api.spotify.com/v1/me/top/artists?time_range=${timeRange}&limit=${limit}`, req);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Get recently played tracks
app.get('/api/recently-played', isAuthenticated, async (req, res) => {
  const limit = req.query.limit || 50;
  const before = req.query.before || '';
  const after = req.query.after || '';
  
  let url = `https://api.spotify.com/v1/me/player/recently-played?limit=${limit}`;
  if (before) url += `&before=${before}`;
  if (after) url += `&after=${after}`;

  try {
    const data = await spotifyFetch(url, req);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start the server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`===================================================`);
  console.log(`Spotify Stats App is running locally!`);
  console.log(`Open http://localhost:${PORT} in your web browser.`);
  console.log(`===================================================`);
});
