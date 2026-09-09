import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

test('player attaches media before loading and only reports Live after manifest playback attempt', () => {
  const attachIndex = js.indexOf('hls.attachMedia(video)');
  const loadIndex = js.indexOf('await loadSourceForView(request.view)');
  const manifestIndex = js.indexOf('MANIFEST_PARSED');
  const playIndex = js.indexOf('video.play');
  const liveIndex = js.indexOf("status.textContent = 'Live'");

  assert.ok(attachIndex >= 0, 'expected Hls.js to attach the video element');
  assert.ok(loadIndex >= 0, 'expected Hls.js to load the source');
  assert.ok(attachIndex < loadIndex, 'Hls.js must attach media before loading the source');
  assert.ok(manifestIndex >= 0, 'expected a manifest-parsed handler');
  assert.ok(manifestIndex < playIndex, 'playback should be attempted from the manifest-parsed handler');
  assert.ok(playIndex < liveIndex, 'Live status should follow the playback attempt');
  assert.doesNotMatch(js, /new MediaSource\s*\(/, 'Hls.js should own the MediaSource lifecycle');
});

test('manual proof reports measurable player diagnostics', () => {
  assert.match(proof, /__fudanPlayerDiagnostics/);
  assert.match(proof, /fragmentCount/);
  assert.match(proof, /mediaSource\??\.readyState/);
  assert.match(proof, /const observationMs = 5000/);
  assert.match(proof, /fragment count after 5 seconds/);
  assert.doesNotMatch(proof, /inspect Network panel|inspect MediaSource|fragment count after 15 seconds['"]\s*:\s*['"]/i);
});
