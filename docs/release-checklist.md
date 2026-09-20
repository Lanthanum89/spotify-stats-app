# Release checklist (manual)

Run after `npm test` and `npm run test:e2e` pass. Needs a real Spotify account allow-listed on the app.

**Deploy**
- [ ] Pages workflow green; the "Stamp service worker build ID" step succeeded.
- [ ] Open the live URL in a private window: sign in with Spotify, the dashboard loads, no console errors.

**Auth**
- [ ] Log out, log back in. Confirm the Application tab shows no `spotify_*` or `soundtracks_snapshot_v1` entries after logout.
- [ ] Revoke access in Spotify account settings, reload: you land on sign-in with the "session ended" message.

**PWA**
- [ ] Chrome/Edge: "Install app" appears; install; it launches standalone with no install button.
- [ ] Android Chrome: same. iOS Safari: "Install app" shows the Share hint.
- [ ] Airplane mode, reopen the installed app: "Offline copy" with your data; Analysis says it needs a connection.
- [ ] Reconnect: the banner clears and data refreshes.
- [ ] Deploy a trivial change: "Update available" appears once; **Later** dismisses; **Update** reloads once.

**Accessibility**
- [ ] Keyboard only: tab through the notices, Update/Later, Retry and Install; focus is visible and not lost after dismissing.
- [ ] Screen reader: offline / back online / update available / quick-search count are each announced once.
- [ ] `prefers-reduced-motion`: no new motion.

**Playback (Premium account, device active)**
- [ ] Play/pause/next/shuffle from the hero and the mini player; with no device you get a clear message.
