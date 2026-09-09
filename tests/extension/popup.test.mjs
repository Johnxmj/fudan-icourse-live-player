import test from 'node:test';
import assert from 'node:assert/strict';
import { sortLiveCourses } from '../../edge_extension/popup/popup.js';

test('popup sorts live courses by start time', () => {
  assert.deepEqual(sortLiveCourses([
    { starts_at: '10:00', sub_id: '2' },
    { starts_at: '08:00', sub_id: '1' },
  ]).map((x) => x.sub_id), ['1', '2']);
});

test('popup renders course metadata through text nodes', async () => {
  const { readFileSync } = await import('node:fs');
  const script = readFileSync('edge_extension/popup/popup.js', 'utf8');
  assert.doesNotMatch(script, /\.innerHTML\s*=/);
  assert.match(script, /textContent\s*=/);
  assert.match(script, /createTextNode/);
});
