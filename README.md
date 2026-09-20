# SoundTracks: Spotify Stats App

SoundTracks is a fully static, backend-free web app that connects to your Spotify account (via the browser) to display personalised listening statistics, top tracks, top artists, genre distributions, and recent listening history.

## Features

- **Now Playing**: A one-screen dashboard led by a big cover-art hero — large album art on the left with track info, a progress bar, and previous/play-pause/next controls (requires Spotify Premium) directly underneath — alongside your upcoming queue, recently played, and current favourites (last 30 days, Spotify's closest available range) stacked on the right. Live, polled in the background — the hero above and a compact echo in the sidebar (cover, track/artist, and the same controls, just above your profile) both update in real time. On a collapsed sidebar the mini player's transport controls stay put as a vertical icon strip rather than disappearing. Distinguishes checking / nothing playing / offline / repeated-failure states rather than one generic loading spinner, with a Retry action after a persistent failure.
- **Top Songs**: View your top 50 songs across three timeframes (4 weeks, 6 months, and all-time), in grid or list view.
- **Top Artists**: View your top 50 artists with rankings, genres, follower counts, and portraits, in grid or list view.
- **Recently Played**: Shows your last 50 played tracks with relative time calculations and duration details.
- **Search**: A dedicated search tab that matches instantly against whatever top-tracks/top-artists/recently-played data is already loaded ("In Your Library"), plus live results from Spotify's full catalogue (tracks, artists, albums, playlists) as you type. Play buttons start real playback via Spotify Connect (requires Premium and an active device), reusing the same playback scope as the Now Playing controls. A persistent search box also sits in the top header on every other tab (a search icon on mobile): typing there opens a live quick-results dropdown — library matches instantly, Spotify results after a short debounce — with the rest of the app dimmed behind it like a modal. Pressing Enter, or using the dropdown's footer row, hands the query off to the full Search tab; Escape or clicking the dimmed backdrop closes it.
- **Analysis tab**: Four groups in a single scroll, with a "Key Insights" summary up top distilling the data already loaded (top genre, top plays/hours, etc. — deliberately no "most active day" claim, since the last-50-streams sample is too recency-biased for that to be a meaningful habit rather than whatever day you happened to have music on all day) before the detailed charts:
  - *Overview* — Key Insights, plus the *Last 50 Streams* metrics (Spotify's hard cap on play history, doesn't respond to the range selector): total plays/hours/average length.
  - *Habits* — an hourly listening-activity chart and a day-of-week activity chart, both from the last 50 streams, with hover tooltips.
  - *Taste* — genuinely computed by Spotify over a single, shared 4-weeks/6-months/all-time range selector for the whole group: genre distribution with a music-taste classification, track and artist popularity distributions, track duration distribution, and top contributing artists (including features).
  - *Correlations* — four quadrant scatter charts driven by that same range: Popularity vs. Your Rank (tracks and artists), Duration vs. Popularity, and Followers vs. Popularity.
- **Responsive**: A full sidebar layout on desktop; on phones and tablets in portrait (up to 1024px wide) it switches to a top bar with a hamburger-triggered slide-out nav drawer instead, with grids, tables, and filters adapted for smaller screens. Top Tracks/Artists/Recently Played default to a compact stacked list on phones instead of a grid or a wide scrolling table — grid stays one tap away, and your own choice is remembered from then on. Icon-only controls get a ~44px tap target on touch input without changing how the icon itself looks.
- **URL routing**: Each main tab has its own shareable route (`#/tracks`, `#/analysis`, ...). Switching tabs updates the URL without a page reload; browser Back/Forward move between tabs (so Back doesn't dump you out of the installed PWA); opening a route directly selects that tab; an unrecognised route falls back to Now Playing.
- **Accessible by default**: icon-only controls (logout, grid/list toggle, sidebar collapse, playback, mobile nav, filter clear) all have accessible names, not just a `title` tooltip. Search results, playback errors, dashboard load failures, and offline/online changes are announced to screen readers. Chart marks (hourly/day-of-week bars, the quadrant scatter plots) are keyboard-reachable with focus-triggered tooltips and a text alternative alongside the SVG, so nothing is hover-only or colour-only. The sidebar has an explicit, keyboard-operable collapse button alongside the existing click-anywhere-on-the-rail shortcut.
- **Installable (PWA)**: An "Install app" button appears (sidebar, or the mobile menu) only when the browser reports the app is installable, and never when it is already installed. Nothing pops up unprompted. See [Offline, install and updates](#offline-install-and-updates).
- **Honest offline states**: A single banner says when you're offline, rate limited or can't reach Spotify; a "Last updated" line shows when the data on screen was fetched; failed cards offer Retry.
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

## Offline, install and updates

### What works offline
- The app shell (page, scripts, styles, icons) opens offline once it has been visited online, including when launched as an installed app.
- A **last-known snapshot**: if you were signed in, your profile, top tracks and top artists (last 6 months) and recent plays from your last successful load are shown, clearly labelled "Offline copy · saved <time>".

### What does not work offline
- Anything that needs Spotify: Now Playing and playback controls, searching Spotify's catalogue (filtering your saved top tracks/artists still works), the other time ranges, the Analysis tab, and signing in. These say so rather than showing stale values as current.
- Album/artist artwork is not cached by the app, so it may not appear offline unless your browser still has it.

### What is stored locally (this browser only)
| Key | Contents |
|---|---|
| `spotify_*` (localStorage) | Access/refresh token and PKCE state, needed to stay connected |
| `soundtracks_snapshot_v1` (localStorage) | Display fields for the snapshot above: names, ranks, popularity, cover URL, links. No tokens, no email, no raw API responses |
| `view-mode`, `sidebar-collapsed` | Layout preferences (kept on logout, deliberately) |
| Cache Storage `soundtracks-shell-<build>`, `soundtracks-fonts-v1` | The static app shell and Google Fonts files |

Snapshot policy: replaced after every successful live load; expires 7 days after it was fetched; discarded if corrupted, from another schema version or dated in the future; only shown while the browser still holds a Spotify connection; deleted when a new authorisation completes (so another account never sees it).

### Clearing it
**Log out** (the logout icon, "Log out and clear saved data") removes the tokens, the snapshot and everything account-specific from the page. A rejected session (Spotify returns 401) does the same. You can also revoke access in your Spotify account settings.

### Updates
A new deploy installs in the background and **waits**. You'll see a compact "Update available" notice with **Update** and **Later**; nothing reloads until you choose Update, and then the page reloads once. The first-ever install shows no notice. Update checks run on load and when the app returns to the foreground (at most every 15 minutes). The shell is served from a single versioned cache, so files from two deploys can never be mixed.

The cache is named after `BUILD_ID` in `public/sw.js`, which the Pages workflow stamps with the commit SHA on every deploy. While it is the literal `'dev'` (local development) the worker is network-first so edits show immediately; to exercise the update flow locally, change `'dev'` to any string, load, then change it again.

### Installing
- Chrome/Edge/Android: use the "Install app" button when it appears (or the browser's own menu).
- iOS/iPadOS Safari has no install event: an "Install app" button shows a short "Share → Add to Home Screen" hint. Other iOS browsers get no hint.
- Firefox desktop doesn't support installing web apps; no button is shown.
- The manifest `id` is fixed at `/spotify-stats-app/`; if you fork under another repository name, change it to match.

### Tests
- `npm test`: dependency-free unit checks (Node's built-in runner) over the snapshot module and the service-worker/manifest invariants a deploy relies on. Also run by CI before every deploy.
- `npm run test:e2e`: browser regression suite (Chrome, mocked Spotify, so no account or tokens involved). Needs `npm install` first. It covers auth, navigation, ranges, search, playback, errors, offline, install, updates, accessibility (axe), the CSP and a hostile-data XSS check. See [docs/regression-matrix.md](docs/regression-matrix.md).
- Manual checks before a release: [docs/release-checklist.md](docs/release-checklist.md). Security notes and residual risks: [docs/security-and-privacy.md](docs/security-and-privacy.md).

### Known limitations
- Browser-held OAuth tokens can't be hidden from page script; see the security notes.
- Sign-in is limited to accounts allow-listed on your Spotify app (Development Mode).
- Playback controls need Spotify Premium and an active device.
- Firefox desktop can't install the app; iOS installs only via Safari's Share menu.
- A meta-tag CSP can't set `frame-ancestors`.
- Artwork isn't cached for offline use; the offline copy covers top tracks/artists (6 months) and recent plays only.

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
