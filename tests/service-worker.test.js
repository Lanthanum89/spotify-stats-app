// Guards the parts of the service worker and manifest that a deploy depends on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');
const sw = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
const shellList = sw.match(/const SHELL_FILES = \[([\s\S]*?)\]/)[1];

test('BUILD_ID placeholder is on its own line, where the deploy workflow stamps it', () => {
  assert.match(sw, /^const BUILD_ID = 'dev'$/m);
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'pages.yml'), 'utf8');
  assert.ok(workflow.includes("^const BUILD_ID = 'dev'"), 'workflow must stamp the same line');
});

test('every precached shell file exists in public/', () => {
  const files = [...shellList.matchAll(/'([^']*)'/g)].map((m) => m[1]).filter(Boolean);
  assert.ok(files.length > 5);
  for (const file of files) assert.ok(fs.existsSync(path.join(publicDir, file)), `${file} is precached but missing`);
});

test('every script and stylesheet index.html loads locally is precached', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const local = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  local.push(...[...html.matchAll(/<link rel="stylesheet" href="([^":]+)"/g)].map((m) => m[1]));
  assert.ok(local.length >= 5);
  for (const file of local) assert.ok(shellList.includes(`'${file}'`), `${file} is loaded by index.html but not precached`);
});

test('the worker waits for the user: skipWaiting only in response to a message', () => {
  const code = sw.replace(/\/\/.*$/gm, '');
  assert.equal((code.match(/skipWaiting\(\)/g) || []).length, 1);
  assert.match(code, /SKIP_WAITING[\s\S]{0,80}skipWaiting\(\)/);
});

test('only SoundTracks-prefixed caches are ever deleted', () => {
  assert.match(sw, /key\.startsWith\(SHELL_CACHE_PREFIX\)/);
});

test('manifest has a stable id; shortcuts and icons resolve', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.id, '/spotify-stats-app/');
  for (const shortcut of manifest.shortcuts) assert.match(shortcut.url, /^\.\/#\/\w+$/);
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(publicDir, icon.src)));
});
