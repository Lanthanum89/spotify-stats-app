# SoundTracks: Spotify Stats App

SoundTracks is a fully static, backend-free web app that connects to your Spotify account (via the browser) to display personalised listening statistics, top tracks, top artists, genre distributions, and recent listening history.

## Features

- **Profile Overview**: Displays user profile details, total playtime across recent tracks, and quick summaries.
- **Now Playing**: A live panel on the Overview tab showing the current track, its cover art, playlist/album context, and a progress bar that ticks in real time between polls. A compact echo of it also sits in the sidebar, just above your profile — with previous/play-pause/next controls (requires Spotify Premium) and a preview of the next couple of tracks in your queue.
- **Top Songs**: View your top 50 songs across three timeframes (4 weeks, 6 months, and all-time), in grid or list view.
- **Top Artists**: View your top 50 artists with rankings, genres, follower counts, and portraits, in grid or list view.
- **Recently Played**: Shows your last 50 played tracks with relative time calculations and duration details.
- **Analysis tab**: Split into two clearly labelled sections so it's obvious what each chart is actually built from:
  - *Last 50 Streams* (Spotify's hard cap on play history, doesn't respond to the range selector): total plays/hours/average length, an hourly listening-activity chart, and a day-of-week activity chart — all with hover tooltips.
  - *Your Top 50 (Selected Range)* (genuinely computed by Spotify over 4 weeks / 6 months / all-time): genre distribution with a music-taste classification, track and artist popularity distributions, track duration distribution, top contributing artists (including features), and four quadrant scatter charts — Popularity vs. Your Rank (tracks and artists), Duration vs. Popularity, and Followers vs. Popularity.
- **Responsive**: A full sidebar layout on desktop; on phones and tablets in portrait (up to 1024px wide) it switches to a top bar with a hamburger-triggered slide-out nav drawer instead, with grids, tables, and filters adapted for smaller screens.
- **Installable (PWA)**: Can be added to your home screen on Android, with offline caching of the app shell.
- **Static, backend-free architecture**: Authenticates directly against Spotify from the browser using Authorization Code + PKCE. There's no server holding credentials — no Client Secret, no session store, nothing but static files. Tokens live only in your browser's `localStorage`.

---

## How authentication works

This app uses OAuth 2.0 **Authorization Code with PKCE** — the flow designed for public clients (browser apps, mobile apps) that can't keep a secret. There is no Client Secret anywhere in this project:

1. Clicking **Connect with Spotify** generates a random PKCE code verifier/challenge pair in the browser and redirects you to Spotify's authorization page.
2. Spotify redirects back to this same page with a `code` (and the `state` you sent, for CSRF protection).
3. The app exchanges that code for an access + refresh token directly against `https://accounts.spotify.com/api/token`, using the PKCE verifier instead of a Client Secret.
4. Tokens are cached in `localStorage` and refreshed automatically (via the refresh token, still no Client Secret) shortly before they expire.
5. All Spotify API calls (`/me`, `/me/top/tracks`, `/me/top/artists`, `/me/player/recently-played`) are made directly from the browser to `api.spotify.com` with the cached access token.

Because there's no backend, this app can be hosted anywhere that serves static files — including GitHub Pages.

---

## Spotify API Setup Guide

To run this application, you must register a free application in the Spotify Developer Dashboard.

1. **Access Developer Portal**:
   Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and log in using your standard Spotify credentials.

2. **Create App**:
   - Click the green **Create app** button in the top right.
   - Enter an **App name** (e.g. `SoundTracks`) and **App description**.
   - In the **Redirect URIs** field, add the exact URL(s) this app will be served from (see below).
   - Select the **Web API** box under the API/SDK section.
   - Agree to the Developer Terms of Service and click **Save**.

3. **Retrieve your Client ID**:
   - On your application's overview page, click **Settings**.
   - Copy the **Client ID**. You do **not** need the Client Secret — this app never uses one, so there's nothing sensitive to protect here.

### Redirect URIs

Spotify requires an exact match on the redirect URI, including trailing slashes. The app always redirects back to the same page it was loaded from (`window.location.origin + window.location.pathname`), so register whatever URL you'll actually open in the browser:

- **Local dev over plain HTTP**: Spotify requires `127.0.0.1`, not `localhost`, for unencrypted loopback redirect URIs. Use `http://127.0.0.1:3000/` (note the trailing slash).
- **GitHub Pages / any HTTPS static host**: register the exact page URL, e.g. `https://<username>.github.io/spotify-stats-app/`.

If you serve the app from more than one place (e.g. local dev and GitHub Pages), add each exact URL as a separate Redirect URI in the Spotify dashboard.

### Development Mode's 25-user limit

New Spotify apps start in **Development Mode**, which restricts login to Spotify accounts you've explicitly added as testers (up to 25) in the dashboard's **User Management** section. For a personal project this is generally a feature, not a bug — it stops anyone else from being able to log in even if they find the page. If you need more users, Spotify requires an extended quota request for production access.

---

## Running the Application

### 1. Set your Client ID
Open `public/index.html` and fill in the `spotify-client-id` meta tag in the `<head>`:

```html
<meta name="spotify-client-id" content="your_client_id_here">
```

(`.env.example` documents the same value for reference, but nothing in this app reads a `.env` file — there's no server process left to read it.)

### 2. Serve the app
Any static file server works. This repo includes a tiny dependency-free one for convenience:

```bash
npm start
```

Or use whatever you prefer, e.g. `npx serve public` or Python's `python3 -m http.server --directory public 3000`.

Once running, navigate to `http://127.0.0.1:3000` in your web browser, click **Connect with Spotify**, and authorise the app to view your stats.

### 3. Deploying statically (e.g. GitHub Pages)
Since the whole app is static files under `public/`, you can publish that folder directly to GitHub Pages (or any static host). Just make sure:
- The Client ID is filled in in `index.html` before you publish (it's not a secret, so it's fine to commit).
- The exact published URL is registered as a Redirect URI in the Spotify Developer Dashboard.
- The site is served over HTTPS (GitHub Pages does this by default) — Spotify's PKCE flow works over HTTP only for the `127.0.0.1` loopback case.
