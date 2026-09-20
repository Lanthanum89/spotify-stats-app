# Regression matrix

What is checked, where, and how. **Auto** = `npm test` (unit, no dependencies) or
`npm run test:e2e` (Chrome, mocked Spotify — see `tests/e2e/`). **Manual** rows need a
real Spotify account or a device and belong in [release-checklist.md](release-checklist.md).

| Area | Scenario | How |
|---|---|---|
| Authentication | Connect starts PKCE with `S256`, no secret, redirect URI = deployed subpath | Auto e2e |
| | Redirect back with valid `state` signs in and scrubs `?code=` from the URL | Auto e2e |
| | Wrong `state` is rejected with a message | Auto e2e |
| | Real Spotify consent + redirect on GitHub Pages | Manual |
| | 401 → sign-in screen with explanation; tokens and snapshot wiped | Auto e2e |
| | Token refresh failing for network/5xx reasons does *not* log out | Code path (`spotify-auth.js`); Manual (airplane mode after token expiry) |
| | Logout clears tokens, snapshot, DOM; a second account sees only its own data | Auto e2e |
| Navigation | Direct route (`#/artists`), Back/Forward, unknown route → Now Playing | Auto e2e |
| | Mobile drawer navigation; Back stays inside the app; no horizontal overflow at 390px | Auto e2e |
| | Installed-app Back button behaviour | Manual |
| Timeframes | Changing range requests that range and updates the "Updated" label | Auto e2e |
| Search | Live catalogue results render | Auto e2e |
| | Header quick-results dropdown; count announced politely | Auto e2e (axe) / Manual (screen reader) |
| Playback | Pause is sent; 404 → "No active device"; 403 → "needs Premium" | Auto e2e |
| | Real playback control, progress, queue | Manual |
| Errors | 500 on dashboard → one Retry banner, still connected, retry recovers | Auto e2e |
| | 429 → one banner, requests paused for the window | Auto e2e |
| | 403 / generic card errors offer Retry (not offline) | Code review; Manual |
| Offline | Banner, "Last known data", snapshot reopen, "Offline copy" label, analysis note | Auto e2e |
| | Retry while offline; reconnect refreshes and lifts the banner | Auto e2e |
| | Corrupt / expired / future / tampered snapshot discarded | Auto unit (`snapshot.test.js`) + e2e |
| | Installed app reopened offline on a phone | Manual |
| Install | Button appears only after `beforeinstallprompt`; never unprompted; hidden after | Auto e2e |
| | Standalone / iOS Safari / unsupported browsers | Manual |
| | Chrome reports no installability or manifest errors | Auto e2e (CDP) |
| Updates | First install silent; update waits; Later; Update reloads once; old cache removed | Auto e2e |
| | Precache list matches `index.html`; BUILD_ID stamp line present; skipWaiting only on message | Auto unit (`service-worker.test.js`) |
| | Two real deploys in a row | Manual |
| Security | Hostile names/URLs never execute or inject markup on any tab; CSP raises no violations | Auto e2e |
| Accessibility | axe-core: zero violations on every tab | Auto e2e |
| | Keyboard order, focus after dismissing a notice, screen-reader wording | Manual |
| Hygiene | No duplicate ids, no inline event handlers, dashboard load makes each request once | Auto e2e |
| Combined | Batches 1–5 together: each e2e test runs a full signed-in session across tabs, ranges, search, offline and auth paths | Auto e2e |
