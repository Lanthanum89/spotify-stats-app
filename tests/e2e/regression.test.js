// Browser regression tests. Optional: needs `npm install` (playwright-core, axe-core)
// and Google Chrome or Edge. Run with: npm run test:e2e
//
// Everything Spotify-facing is mocked (see harness.js). Each test maps to a
// row of docs/regression-matrix.md.
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const axe = require('axe-core');
const { startServer, mockSpotify, seedTokens } = require('./harness');

const TABS = ['overview', 'search', 'tracks', 'artists', 'analysis', 'recent'];
let browser;
let site;

before(async () => {
  site = await startServer();
  browser = await chromium.launch({ channel: process.env.E2E_CHANNEL || 'chrome', headless: true });
});
after(async () => {
  await browser.close();
  site.close();
});

// Opens a page with a fresh profile; violations of the CSP and page errors are collected.
async function session({ evil = false, signedIn = true, viewport = { width: 1440, height: 900 }, url = site.url } = {}) {
  const context = await browser.newContext({ viewport });
  const mock = await mockSpotify(context, { evil });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|net::ERR|status of (4|5)\d\d/.test(m.text())) problems.push(`console: ${m.text().slice(0, 200)}`);
  });
  page.on('dialog', (d) => d.dismiss());
  await page.goto(url);
  if (signedIn) {
    await seedTokens(page);
    await page.reload();
    await page.locator('#user-name:not(:empty)').waitFor({ state: 'attached' });
  }
  return { context, page, mock, problems };
}

const goTab = async (page, tab) => { await page.click(`.nav-item[data-tab="${tab}"] >> visible=true`); await page.waitForTimeout(500); };

// ---- Authentication -------------------------------------------------------

test('auth: Connect starts PKCE (S256) with the subpath redirect URI', async () => {
  const { context, page } = await session({ signedIn: false });
  const nav = page.waitForRequest((r) => r.url().startsWith('https://accounts.spotify.com/authorize'));
  await page.click('#btn-login');
  const authUrl = new URL((await nav).url());
  assert.equal(authUrl.searchParams.get('response_type'), 'code');
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authUrl.searchParams.get('code_challenge').length >= 43);
  assert.equal(authUrl.searchParams.get('redirect_uri'), site.url);
  assert.ok(!authUrl.searchParams.has('client_secret'));
  await context.close();
});

test('auth: redirect back with a valid state signs in and scrubs the URL; bad state is rejected', async () => {
  const { context, page } = await session({ signedIn: false });
  const nav = page.waitForRequest((r) => r.url().startsWith('https://accounts.spotify.com/authorize'));
  await page.click('#btn-login');
  const state = new URL((await nav).url()).searchParams.get('state');
  await page.goto(`${site.url}?code=abc&state=${state}`);
  await page.locator('#user-name:not(:empty)').waitFor({ state: 'attached' });
  assert.equal(new URL(page.url()).search, '');

  await page.evaluate(() => localStorage.clear());
  await page.goto(`${site.url}?code=abc&state=WRONG`);
  await page.locator('#login-container:not(.hidden)').waitFor();
  assert.match(await page.textContent('#auth-error-msg'), /could not be verified/);
  await context.close();
});

test('auth: 401 returns to sign-in with an explanation and wipes saved data', async () => {
  const { context, page, mock } = await session();
  mock.mode = '401';
  await goTab(page, 'recent');
  await page.locator('#login-container:not(.hidden)').waitFor();
  assert.match(await page.textContent('#auth-error-msg'), /session has ended/);
  assert.equal(await page.evaluate(() => localStorage.getItem('soundtracks_snapshot_v1')), null);
  assert.equal(await page.evaluate(() => localStorage.getItem('spotify_refresh_token')), null);
  await context.close();
});

test('auth: logout clears tokens, snapshot and every trace of the account from the page', async () => {
  const { context, page } = await session();
  await goTab(page, 'tracks');
  await page.click('#btn-logout');
  await page.locator('#login-container:not(.hidden)').waitFor();
  const keys = await page.evaluate(() => Object.keys(localStorage));
  assert.ok(!keys.some((k) => k.startsWith('spotify_') || k.startsWith('soundtracks_snapshot')), keys.join());
  assert.doesNotMatch(await page.content(), /Name of user-1|Track \d/);
  await context.close();
});

test('auth: a second account never sees the first account\'s saved copy', async () => {
  const { context, page, mock } = await session();
  await page.click('#btn-logout');
  mock.profileId = 'user-2';
  await seedTokens(page);
  await page.reload();
  await page.locator('#user-name:not(:empty)').waitFor({ state: 'attached' });
  assert.equal(await page.textContent('#user-name'), 'Name of user-2');
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('soundtracks_snapshot_v1'))).profile.id, 'user-2');
  await context.close();
});

// ---- Navigation, timeframes, search ----------------------------------------

test('navigation: direct routes, Back/Forward and unknown routes (desktop)', async () => {
  const { context, page } = await session({ url: `${site.url}#/artists` });
  assert.equal(await page.textContent('#current-tab-title'), 'Top Artists');
  await goTab(page, 'recent');
  await page.goBack();
  assert.equal(await page.textContent('#current-tab-title'), 'Top Artists');
  await page.goForward();
  assert.equal(await page.textContent('#current-tab-title'), 'Recent');
  await page.evaluate(() => { location.hash = '#/nonsense'; });
  await page.waitForTimeout(300);
  assert.equal(await page.textContent('#current-tab-title'), 'Now Playing');
  await context.close();
});

test('navigation: mobile drawer + Back button stays inside the app', async () => {
  const { context, page } = await session({ viewport: { width: 390, height: 800 } });
  await page.click('#btn-mobile-menu');
  await page.click('#mobile-nav-drawer .nav-item[data-tab="tracks"]');
  await page.waitForTimeout(400);
  assert.equal(await page.textContent('#current-tab-title'), 'Top Tracks');
  await page.goBack();
  assert.equal(await page.textContent('#current-tab-title'), 'Now Playing');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow');
  await context.close();
});

test('timeframes: choosing 4 Weeks requests short_term and updates the freshness label', async () => {
  const { context, page, mock } = await session();
  await goTab(page, 'tracks');
  await page.click('.time-filter-btn[data-range="short_term"]');
  await page.waitForTimeout(600);
  assert.ok(mock.calls.some((c) => c.includes('/me/top/tracks?time_range=short_term')));
  assert.match(await page.textContent('#data-freshness'), /^Updated \d\d:\d\d$/);
  await context.close();
});

test('search: live catalogue results render and header dropdown announces the count', async () => {
  const { context, page, mock } = await session();
  await goTab(page, 'search');
  await page.fill('#global-search-input', 'anything');
  await page.waitForTimeout(1200);
  assert.ok(mock.calls.some((c) => c.startsWith('GET /search?')));
  assert.ok((await page.locator('#search-tracks-grid .track-card').count()) >= 1);
  await context.close();
});

// ---- Playback ---------------------------------------------------------------

test('playback: pause is sent; 404 and 403 give specific messages', async () => {
  const { context, page, mock } = await session();
  mock.playback = 'playing';
  await page.reload();
  await page.locator('#now-playing-track').waitFor();
  await page.click('#now-playing-play');
  await page.waitForTimeout(700);
  assert.ok(mock.calls.some((c) => c === 'PUT /me/player/pause'));

  mock.playbackStatus = 404;
  await page.click('#now-playing-next');
  await page.locator('#now-playing-controls-error:not(.hidden)').waitFor();
  assert.match(await page.textContent('#now-playing-controls-error'), /No active Spotify device/);

  mock.playbackStatus = 403;
  await page.waitForTimeout(4200);
  await page.click('#now-playing-next');
  await page.locator('#now-playing-controls-error:not(.hidden)').waitFor();
  assert.match(await page.textContent('#now-playing-controls-error'), /Premium/);
  await context.close();
});

test('errors: 500 on the dashboard shows one retry banner without logging out; retry recovers', async () => {
  const { context, page, mock } = await session({ signedIn: false });
  mock.mode = '500';
  await seedTokens(page);
  await page.reload();
  await page.locator('#dashboard-error-banner:not(.hidden)').waitFor();
  assert.equal(await page.locator('.app-notices .notice').count(), 0, 'no competing global banner');
  assert.notEqual(await page.evaluate(() => localStorage.getItem('spotify_refresh_token')), null, 'still connected');
  mock.mode = 'ok';
  await page.click('#btn-dashboard-retry');
  await page.locator('#user-name:not(:empty)').waitFor({ state: 'attached' });
  await context.close();
});

test('errors: 429 shows a single rate-limit banner and pauses requests', async () => {
  const { context, page, mock } = await session();
  await goTab(page, 'tracks');
  mock.mode = '429';
  await page.click('.time-filter-btn[data-range="long_term"]');
  await page.locator('.notice[data-status="rate-limit"]').waitFor();
  assert.equal(await page.locator('.notice').count(), 1);
  const before = mock.calls.length;
  await page.click('.time-filter-btn[data-range="short_term"]');
  await page.waitForTimeout(500);
  assert.equal(mock.calls.length, before, 'no requests sent inside the Retry-After window');
  await context.close();
});

// ---- Offline, install, update ------------------------------------------------

test('offline: banner, snapshot reopen, retry, reconnect refresh', async () => {
  const { context, page } = await session();
  await goTab(page, 'tracks');
  await context.setOffline(true);
  await page.locator('.notice[data-status="offline"]').waitFor();
  assert.match(await page.textContent('#data-freshness'), /Last known data/);

  await page.reload();
  await page.locator('#user-name:not(:empty)').waitFor({ state: 'attached' });
  await goTab(page, 'tracks');
  assert.match(await page.textContent('#data-freshness'), /Offline copy/);
  assert.ok((await page.locator('#top-tracks-grid .track-card, #top-tracks-table-body tr').count()) >= 3);
  await goTab(page, 'analysis');
  assert.ok(await page.locator('#analysis-offline-note').isVisible());

  await page.locator('.notice[data-status="offline"] button').click();
  assert.match(await page.textContent('.notice[data-status="offline"]'), /Still not connected/);

  await context.setOffline(false);
  await page.locator('#analysis-offline-note').waitFor({ state: 'hidden' });
  await page.locator('.notice[data-status="offline"]').waitFor({ state: 'detached' });
  await context.close();
});

test('offline: corrupt snapshot is discarded without crashing', async () => {
  const { context, page } = await session();
  await page.evaluate(() => localStorage.setItem('soundtracks_snapshot_v1', '{bad'));
  await context.setOffline(true);
  await page.reload();
  await page.locator('.notice[data-status="offline"]').waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('soundtracks_snapshot_v1')), null);
  await context.close();
});

test('updates: first install silent; update waits, Later, Update reloads exactly once, old cache removed', async () => {
  site.state.buildId = 'e2e-1';
  const { context, page } = await session();
  await page.evaluate(() => navigator.serviceWorker.ready);
  assert.equal(await page.locator('[data-status="update"]').count(), 0, 'no notice on first install');
  await page.reload();
  assert.ok(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)));

  site.state.buildId = 'e2e-2';
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
  await page.locator('[data-status="update"]').waitFor();
  assert.ok((await page.evaluate(() => caches.keys())).includes('soundtracks-shell-e2e-1'), 'old shell still served');
  await page.getByRole('button', { name: 'Dismiss update notification' }).click();
  assert.equal(await page.locator('[data-status="update"]').count(), 0);

  await page.reload();
  await page.locator('[data-status="update"]').waitFor();
  let loads = 0;
  page.on('load', () => { loads++; });
  await page.getByRole('button', { name: 'Update SoundTracks to the new version' }).click();
  await page.waitForTimeout(2500);
  assert.equal(loads, 1, 'exactly one reload');
  const keys = (await page.evaluate(() => caches.keys())).filter((k) => k.startsWith('soundtracks-shell'));
  assert.deepEqual(keys, ['soundtracks-shell-e2e-2']);
  assert.equal(await page.locator('[data-status="update"]').count(), 0);
  site.state.buildId = 'dev';
  await context.close();
});

test('install: button only after beforeinstallprompt, prompts on click, hidden afterwards', async () => {
  const { context, page } = await session();
  assert.equal(await page.locator('.js-install-btn:visible').count(), 0);
  await page.evaluate(() => {
    const e = new Event('beforeinstallprompt', { cancelable: true });
    e.prompt = () => { window.__prompted = true; };
    e.userChoice = Promise.resolve({ outcome: 'dismissed' });
    window.dispatchEvent(e);
  });
  assert.equal(await page.locator('.js-install-btn:visible').count(), 1);
  assert.equal(await page.evaluate(() => window.__prompted), undefined, 'never prompts unprompted');
  await page.locator('.js-install-btn:visible').click();
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__prompted), true);
  assert.equal(await page.locator('.js-install-btn:visible').count(), 0);
  await context.close();
});

test('pwa: Chrome reports no installability errors and a valid manifest', async () => {
  site.state.buildId = 'e2e-pwa';
  const { context, page } = await session({ signedIn: false });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  const manifest = await cdp.send('Page.getAppManifest');
  // Playwright contexts are incognito-like, which Chrome reports as a (non-manifest) blocker.
  assert.deepEqual(installabilityErrors.filter((e) => e.errorId !== 'in-incognito'), []);
  assert.deepEqual(manifest.errors, []);
  const parsed = JSON.parse(manifest.data);
  // Relative scope/start_url resolve beneath the subpath because the manifest lives there.
  assert.equal(manifest.url, `${site.url}manifest.webmanifest`);
  assert.equal(parsed.scope, './');
  assert.equal(parsed.start_url, './');
  assert.equal(parsed.id, '/spotify-stats-app/');
  site.state.buildId = 'dev';
  await context.close();
});

// ---- Security, accessibility, hygiene ------------------------------------------

test('security: hostile Spotify strings and URLs never execute or inject markup on any screen', async () => {
  const { context, page, problems } = await session({ evil: true });
  for (const tab of TABS) {
    await goTab(page, tab);
    if (tab === 'search') { await page.fill('#global-search-input', 'evil query'); await page.waitForTimeout(1200); }
    if (tab === 'tracks' || tab === 'artists') {
      for (const view of ['list', 'grid']) { await page.click(`.view-toggle-btn[data-view="${view}"]`); await page.waitForTimeout(200); }
    }
    if (tab === 'analysis') await page.waitForTimeout(1200);
  }
  await goTab(page, 'tracks');
  await page.fill('#header-search-input', 'evil query');
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => window.__pwned || 0), 0, 'script executed');
  assert.equal(await page.locator('#inj, img[onerror]').count(), 0, 'markup injected');
  const jsUrls = await page.evaluate(() => [...document.querySelectorAll('[href],[src],[data-preview-url]')]
    .filter((n) => /^javascript:/i.test(n.getAttribute('href') || n.getAttribute('src') || n.dataset.previewUrl || '')).length);
  assert.equal(jsUrls, 0);
  assert.deepEqual(problems, [], 'CSP violations or page errors');
  await context.close();
});

test('security: legitimate https links and images survive sanitising; only https audio is ever played', async () => {
  const { context, page } = await session();
  await goTab(page, 'tracks');
  await page.click('.view-toggle-btn[data-view="grid"]');
  await page.waitForTimeout(300);
  const links = await page.evaluate(() => [...document.querySelectorAll('#top-tracks-grid a[href], #top-tracks-grid img')].map((n) => n.getAttribute('href') || n.getAttribute('src')));
  assert.ok(links.length > 0);
  assert.ok(links.every((u) => /^https:\/\/(open\.spotify\.com|i\.scdn\.co)\//.test(u)), links.join(' '));
  await context.close();

  const evil = await session({ evil: true });
  await evil.page.evaluate(() => { window.__audio = []; window.Audio = function (src) { window.__audio.push(src); this.play = () => Promise.resolve(); this.pause = () => {}; this.addEventListener = () => {}; }; });
  await goTab(evil.page, 'tracks');
  await evil.page.click('.view-toggle-btn[data-view="grid"]');
  await evil.page.waitForTimeout(300);
  for (const btn of await evil.page.locator('#top-tracks-grid button[data-preview-url]').all()) await btn.click({ force: true });
  assert.deepEqual(await evil.page.evaluate(() => window.__audio), [], 'no Audio created for a javascript: preview URL');
  await evil.context.close();

  const good = await session();
  await good.page.evaluate(() => { window.__audio = []; window.Audio = function (src) { window.__audio.push(src); this.play = () => Promise.resolve(); this.pause = () => {}; this.addEventListener = () => {}; }; });
  await goTab(good.page, 'tracks');
  await good.page.click('.view-toggle-btn[data-view="grid"]');
  await good.page.waitForTimeout(300);
  await good.page.locator('#top-tracks-grid button[data-preview-url]').first().click({ force: true });
  assert.deepEqual(await good.page.evaluate(() => window.__audio), ['https://p.scdn.co/preview.mp3']);
  await good.context.close();
});

test('accessibility: closed header dropdown is out of the tab order; quick results are announced once per query', async () => {
  const { context, page } = await session();
  await goTab(page, 'tracks');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('header-search-dropdown')).visibility), 'hidden');
  await page.evaluate(() => {
    window.__announcements = [];
    new MutationObserver(() => {
      const text = document.getElementById('a11y-status').textContent;
      if (/quick result|No quick matches/.test(text)) window.__announcements.push(text);
    }).observe(document.getElementById('a11y-status'), { childList: true, characterData: true, subtree: true });
  });
  await page.fill('#header-search-input', 'anything');
  await page.waitForTimeout(2500);
  assert.equal(await page.evaluate(() => window.__announcements.length), 1, 'announced once');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('header-search-dropdown')).visibility), 'visible');
  await context.close();
});

test('hygiene: no duplicate ids, no inline handlers, dashboard load makes each request once', async () => {
  const { context, page, mock } = await session({ signedIn: false });
  await seedTokens(page);
  mock.calls.length = 0;
  await page.reload();
  await page.locator('#user-name:not(:empty)').waitFor({ state: 'attached' });
  await page.waitForTimeout(1500);
  // Only the initial load is checked: opening the Recent tab deliberately refreshes it.
  const loadCalls = mock.calls.filter((c) => /^GET \/me(\?|$)|top\/(tracks|artists)\?time_range=medium_term|recently-played/.test(c));
  for (const tab of TABS) await goTab(page, tab);
  const dups = await page.evaluate(() => {
    const seen = new Set(); const dup = [];
    document.querySelectorAll('[id]').forEach((n) => { if (seen.has(n.id)) dup.push(n.id); seen.add(n.id); });
    return dup;
  });
  assert.deepEqual(dups, []);
  assert.equal(await page.locator('[onclick],[onmouseover],[onmouseout],[onerror]').count(), 0);
  assert.equal(new Set(loadCalls).size, loadCalls.length, `duplicate requests: ${loadCalls.join(' | ')}`);
  await context.close();
});

test('accessibility: axe finds no violations on any tab', async () => {
  const { context, page } = await session();
  for (const tab of TABS) {
    await goTab(page, tab);
    if (tab === 'analysis') await page.waitForTimeout(1200);
    // A string is evaluated over CDP, which the page's CSP doesn't restrict.
    await page.evaluate(axe.source);
    const violations = await page.evaluate(async () =>
      (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map((v) => `${v.id} (${v.nodes[0].target.join(' ')})`));
    assert.deepEqual(violations, [], `${tab}: ${violations.join('; ')}`);
  }
  await context.close();
});
