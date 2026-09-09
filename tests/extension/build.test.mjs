import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertAllowed, buildExtension } from '../../edge_extension/scripts/build.mjs';

test('build contains player assets and no private files', () => {
  const output = mkdtempSync(join(tmpdir(), 'fudan-edge-build-'));
  try {
    const files = buildExtension({ output });
    assert.equal(files.includes('player/vendor/hls.min.js'), true);
    assert.equal(files.some((file) => /\.env|cookie|credential/i.test(file)), false);
    assert.equal(existsSync(join(output, 'edge-extension', 'manifest.json')), true);
    assert.equal(existsSync(join(output, 'edge-extension', 'src', 'page-bridge.js')), true);
    assert.equal(existsSync(join(output, 'fudan-icourse-live-edge.zip')), true);
    const playerHtml = readFileSync(join(output, 'edge-extension', 'player', 'index.html'), 'utf8');
    const hlsScript = playerHtml.match(/<script[^>]+src="([^"]*hls\.min\.js)"[^>]*>/i);
    assert.ok(hlsScript, 'player page should reference the HLS runtime');
    assert.equal(existsSync(join(output, 'edge-extension', 'player', hlsScript[1])), true);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('built manifest public key loads as a 2048-bit RSA SPKI', () => {
  const output = mkdtempSync(join(tmpdir(), 'fudan-edge-build-'));
  try {
    buildExtension({ output });
    const builtManifest = JSON.parse(readFileSync(join(output, 'edge-extension', 'manifest.json'), 'utf8'));
    const publicKey = createPublicKey({
      key: Buffer.from(builtManifest.key, 'base64'),
      format: 'der',
      type: 'spki',
    });
    assert.equal(publicKey.asymmetricKeyType, 'rsa');
    assert.equal(publicKey.asymmetricKeyDetails.modulusLength, 2048);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('rejects private filenames under allowed extension roots', () => {
  for (const relativePath of ['src/private/.env.local', 'src/private/credentials.json', 'src/private/session_cookie.txt']) {
    assert.throws(() => assertAllowed(relativePath), /private or unexpected build input/);
  }
});

test('build is reproducible with lexically sorted, fixed-timestamp zip entries', () => {
  const first = mkdtempSync(join(tmpdir(), 'fudan-edge-build-'));
  const second = mkdtempSync(join(tmpdir(), 'fudan-edge-build-'));
  try {
    buildExtension({ output: first });
    buildExtension({ output: second });
    assert.deepEqual(readFileSync(join(first, 'fudan-icourse-live-edge.zip')), readFileSync(join(second, 'fudan-icourse-live-edge.zip')));
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});
