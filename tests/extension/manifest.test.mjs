import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FUDAN_EXTENSION_ID } from '../../frontend/live/extension-config.js';

const manifest = JSON.parse(readFileSync('edge_extension/manifest.json', 'utf8'));

function extensionIdForKey(key) {
  const digest = createHash('sha256').update(Buffer.from(key, 'base64')).digest();
  return Array.from(digest.subarray(0, 16), (byte) => (
    String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 0x0f))
  )).join('');
}

test('manifest grants only required Fudan and Pages origins', () => {
  assert.deepEqual(manifest.host_permissions.sort(), [
    'https://icourse.fudan.edu.cn/*',
    'https://webvpn.fudan.edu.cn/*',
  ]);
  assert.deepEqual(manifest.externally_connectable.matches, ['https://johnxmj.github.io/*']);
  assert.equal(manifest.permissions.includes('downloads'), false);
  assert.equal(manifest.permissions.includes('<all_urls>'), false);
});

test('manifest exposes player only to Pages and has stable public identity', () => {
  assert.deepEqual(manifest.web_accessible_resources, [{ resources: ['player/*'], matches: ['https://johnxmj.github.io/*'] }]);
});

test('manifest key is loadable SPKI and derives the approved Pages extension ID', () => {
  const publicKey = createPublicKey({
    key: Buffer.from(manifest.key, 'base64'),
    format: 'der',
    type: 'spki',
  });
  assert.equal(publicKey.asymmetricKeyType, 'rsa');
  assert.equal(publicKey.asymmetricKeyDetails.modulusLength, 2048);
  assert.equal(extensionIdForKey(manifest.key), FUDAN_EXTENSION_ID);
});
