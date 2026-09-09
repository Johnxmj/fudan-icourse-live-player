import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync('edge_extension/player/index.html', 'utf8');
const js = readFileSync('edge_extension/player/player.js', 'utf8');
const proof = readFileSync('edge_extension/manual-proof.js', 'utf8');
const bg = readFileSync('edge_extension/src/background.js', 'utf8');

test('player is extension-origin and does not expose source credentials', () => {
  assert.match(html, /<video[^>]+id=["']video["']/i);
  assert.match(html, /player\.js/);
  assert.doesNotMatch(js, /innerHTML\s*=.*source|dataset\.[^\n]*source|sourceUrl|signed[_-]?url|token/i);
  assert.match(js, /MediaSource/);
  assert.match(js, /toWebVpnUrl/);
  assert.match(bg, /credentials:\s*["']include["']/);
});

test('player accepts only handshake-gated safe parameters', () => {
  assert.match(js, /PLAYER_HANDSHAKE/);
  assert.match(js, /PLAYER_CHALLENGE/);
  assert.match(js, /PLAYER_INIT/);
  assert.match(js, /LIVE_PLAYER_HELLO/);
  assert.match(js, /courseId/);
  assert.match(js, /subId/);
  assert.match(js, /view/);
  assert.match(js, /validRequest/);
  assert.doesNotMatch(js, /download|MediaRecorder|archive/i);
});

test('embedded player waits for validated PLAYER_INIT before startup', () => {
  assert.match(js, /initialized/);
  assert.match(js, /event\.data\?\.type\s*===\s*['"]PLAYER_INIT['"]/);
  assert.match(js, /startIfReady/);
  assert.match(js, /helloNonce/);
  assert.match(js, /SAFE_ID/);
});

test('player startup errors update status without creating an unhandled rejection', () => {
  assert.doesNotMatch(js, /startPromise\s*=\s*start\(\)\.catch\(\(error\)\s*=>\s*\{[\s\S]*?throw error;/);
  assert.match(js, /startPromise\s*=\s*start\(\)\.catch\(\(error\)\s*=>\s*\{[\s\S]*?status\.textContent\s*=\s*error\.message;/);
});

test('player SET_VIEW requests and loads the source for the new view', () => {
  assert.match(js, /SET_VIEW/);
  assert.match(js, /getSource\(view\)/);
  assert.match(js, /loadSourceForView/);
  assert.match(js, /hls\.loadSource\(source\)/);
});

test('player ignores stale source request rejections after a newer generation succeeds', () => {
  assert.match(
    js,
    /catch\s*\(error\)\s*\{[\s\S]*?if\s*\(generation\s*!==\s*loadGeneration\)\s*return;[\s\S]*?status\.textContent\s*=\s*error\.message/
  );
  assert.doesNotMatch(js, /loadSourceForView\(event\.data\.view\)\.catch\(\(\)\s*=>\s*\{\s*status\.textContent\s*=\s*['"]Live stream unavailable/);
});

test('player attaches media before loading and attempts playback after parsing the manifest', () => {
  const attachIndex = js.indexOf('hls.attachMedia(video)');
  const loadIndex = js.indexOf('await loadSourceForView(request.view)');
  const manifestIndex = js.indexOf('MANIFEST_PARSED');
  const playIndex = js.indexOf('video.play');

  assert.ok(attachIndex >= 0, 'expected Hls.js to attach the video element');
  assert.ok(loadIndex >= 0, 'expected Hls.js to load the source');
  assert.ok(attachIndex < loadIndex, 'Hls.js must attach media before loading the source');
  assert.ok(manifestIndex >= 0, 'expected a manifest-parsed handler');
  assert.ok(manifestIndex < playIndex, 'playback should be attempted from the manifest-parsed handler');
  assert.doesNotMatch(js, /new MediaSource\s*\(/, 'Hls.js should own the MediaSource lifecycle');
});

async function playerHarness({ blockAutoplay = false, embedded = false } = {}) {
  const events = {};
  const videoEvents = {};
  const timers = new Map();
  const sources = [];
  const posts = [];
  let timerId = 0;
  let requests = 0;
  let mediaRecoveries = 0;
  const status = { textContent: '' };
  const retry = { hidden: true, addEventListener(type, fn) { this[type] = fn; } };
  const video = {
    paused: true, readyState: 0,
    addEventListener(type, fn) { videoEvents[type] = fn; },
    async play() { if (blockAutoplay) throw new Error('autoplay blocked'); },
  };
  class Hls {
    static DefaultConfig = { loader: class {} };
    static Events = { ERROR: 'error', MANIFEST_PARSED: 'manifestParsed' };
    static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
    static isSupported() { return true; }
    on(type, fn) { events[type] = fn; }
    attachMedia() {}
    stopLoad() {}
    startLoad() {}
    loadSource(source) { sources.push(source); }
    recoverMediaError() { mediaRecoveries += 1; }
    destroy() {}
  }
  const context = {
    URL, URLSearchParams, Hls, MediaSource: class {},
    location: { search: '?courseId=c1&subId=s1&view=teacher', href: 'chrome-extension://test/player/index.html?courseId=c1&subId=s1&view=teacher' },
    document: { getElementById(id) { return id === 'video' ? video : id === 'status' ? status : retry; } },
    chrome: { runtime: { async sendMessage(message) {
      if (message.type === 'PLAYER_SOURCE') { requests += 1; return { ok: true, source: `https://media.invalid/live${requests}.m3u8` }; }
      return { ok: true };
    } } },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(type, fn) { if (type === 'message') this.message = fn; },
    toWebVpnUrl(value) { return value; },
  };
  context.window = context;
  context.parent = embedded ? { postMessage(message, origin) { posts.push({ message, origin }); } } : context;
  vm.runInNewContext(js.replace(/^import .*;\n/m, '').replace(/export /g, ''), context);
  await new Promise(resolve => setImmediate(resolve));
  return { events, videoEvents, status, retry, sources, timers, posts, context,
    get requests() { return requests; }, get mediaRecoveries() { return mediaRecoveries; },
    async tick() { const entry = timers.entries().next().value; if (entry) { timers.delete(entry[0]); await entry[1](); } await new Promise(resolve => setImmediate(resolve)); },
  };
}

test('manifest parsing and blocked autoplay never claim that playback has started', async () => {
  const player = await playerHarness({ blockAutoplay: true });
  await player.events.manifestParsed();
  assert.match(player.status.textContent, /点击.*播放/);
  assert.equal(typeof player.videoEvents.playing, 'function');
  player.videoEvents.playing();
  assert.match(player.status.textContent, /正在直播/);
});

test('fatal network recovery refreshes the source at most three times and allows explicit retry', async () => {
  const player = await playerHarness();
  assert.equal(player.requests, 1);
  for (let i = 0; i < 4; i += 1) {
    player.events.error(null, { fatal: true, type: 'networkError' });
    player.events.error(null, { fatal: true, type: 'networkError' });
    await player.tick();
  }
  assert.equal(player.requests, 4);
  assert.equal(player.timers.size, 0);
  assert.equal(player.retry.hidden, false);
  assert.match(player.status.textContent, /重试/);
  await player.retry.click();
  assert.equal(player.requests, 5);
});

test('fatal media recovery uses the same bounded recovery budget', async () => {
  const player = await playerHarness();
  for (let i = 0; i < 4; i += 1) { player.events.error(null, { fatal: true, type: 'mediaError' }); await player.tick(); }
  assert.equal(player.mediaRecoveries, 3);
  assert.equal(player.retry.hidden, false);
});

test('embedded playback status is sent only after the nonce handshake and contains no media address', async () => {
  const player = await playerHarness({ embedded: true });
  const hello = player.posts[0].message;
  const send = data => player.context.message({ origin: 'https://johnxmj.github.io', source: player.context.parent, data });
  send({ type: 'PLAYER_CHALLENGE', version: 1, nonce: 'challenge', helloNonce: hello.nonce });
  send({ type: 'PLAYER_INIT', version: 1, nonce: 'challenge', helloNonce: hello.nonce, courseId: 'c1', subId: 's1', view: 'teacher' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof player.videoEvents.playing, 'function');
  player.videoEvents.playing();
  const update = player.posts.at(-1);
  assert.equal(update.message.type, 'LIVE_PLAYER_STATE');
  assert.equal(update.message.state, 'playing');
  assert.equal(update.message.nonce, 'challenge');
  assert.equal(update.message.helloNonce, hello.nonce);
  assert.equal(update.origin, 'https://johnxmj.github.io');
  assert.doesNotMatch(JSON.stringify(update), /media.invalid|m3u8/);
});

test('manual proof reports measurable player diagnostics', () => {
  assert.match(proof, /__fudanPlayerDiagnostics/);
  assert.match(proof, /fragmentCount/);
  assert.match(proof, /mediaSource\??\.readyState/);
  assert.match(proof, /const observationMs = 5000/);
  assert.match(proof, /fragment count after 5 seconds/);
  assert.doesNotMatch(proof, /inspect Network panel|inspect MediaSource|fragment count after 15 seconds['"]\s*:\s*['"]/i);
});
