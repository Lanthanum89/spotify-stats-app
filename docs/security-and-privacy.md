# Security and privacy notes

## What is protected
- **No secrets in the page.** Authorisation Code + PKCE (`S256`); no client secret exists. The Client ID in `index.html` is public by design.
- **Untrusted text is never trusted.** Everything Spotify returns (names, genres, playlist and owner names, URLs) is either set with `textContent`, or escaped via `escapeHtml()` before going into `innerHTML`. Links, images and audio only accept `https:` URLs (`httpsUrl()` / `attrUrl()`), so a `javascript:` URL is dropped. A hostile-fixture browser test (`tests/e2e`) covers every screen; it fails against the pre-Batch-5 code.
- **Content Security Policy** (meta tag): scripts only from this origin (no inline, no `eval`); network only to `api.spotify.com` and `accounts.spotify.com`; fonts from Google Fonts; images `https:`/`data:`. No inline event handlers remain. Limits: it is a meta tag, so `frame-ancestors` is unsupported (no clickjacking protection), and inline *styles* are still allowed because generated markup uses `style=` attributes.
- **No token logging.** API error messages carry status codes only, never response bodies.
- **Logout is thorough.** Tokens, PKCE state, the offline snapshot, in-memory state, timers and rendered DOM are cleared. A rejected session does the same.
- **Snapshot boundary.** `soundtracks_snapshot_v1` holds display fields only (no tokens, no email, no raw responses); it is validated and stripped on load, expires after 7 days, is replaced on each live load, and is deleted whenever a new authorisation completes.

## Residual risk (not removed by being a static site)
- **Tokens live in `localStorage`.** Anything that can run script on this origin (an XSS bug, a compromised dependency, a browser extension with page access, or another project served from the same origin) could read the refresh token. Mitigations here are the CSP, escaping, and having no third-party scripts. Browser-held OAuth tokens can't be hidden from page script; `HttpOnly` cookies need a backend, which this project deliberately doesn't have.
- **Shared origin.** GitHub Pages serves every project of the account from one origin, so `localStorage` is shared with sibling projects. Don't host untrusted or unreviewed apps under the same account origin, or move this app to its own domain.
- **Refresh tokens are long-lived.** Revoke access in Spotify account settings if a device is lost.
- **Development Mode** limits who can sign in; it is not a security control.
