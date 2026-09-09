import test from 'node:test';
import assert from 'node:assert/strict';
import { handleExternal, handleExternalOpenPlayer } from '../../edge_extension/src/background.js';

test('external messages reject unapproved origins', async () => {
  const response = await handleExternal({ version: 1, type: 'CAPABILITIES', payload: {} }, { url: 'https://evil.invalid/' });
  assert.equal(response.error.code, 'ORIGIN_DENIED');
});

test('external capabilities and live list expose only safe data', async () => {
  const deps = {
    playerFrameUrl: 'chrome-extension://id/player/index.html',
    listLive: async () => [{ course_id: '1', sub_id: '2', starts_at: '08:00', live_url: 'secret' }],
  };
  assert.deepEqual(await handleExternal({ version: 1, type: 'CAPABILITIES', payload: {} }, { url: 'https://johnxmj.github.io/app' }, deps), { version: 1, playerFrame: deps.playerFrameUrl });
  const result = await handleExternal({ version: 1, type: 'LIST_LIVE', payload: {} }, { url: 'https://johnxmj.github.io/app' }, deps);
  assert.equal(result.version, 1);
  assert.equal(result.courses[0].live_url, undefined);
});

test('external capabilities and live list preserve login and failed states', async () => {
  const login = await handleExternal(
    { version: 1, type: 'CAPABILITIES', payload: {} },
    { url: 'https://johnxmj.github.io/app' },
    { getState: async () => ({ state: 'login-required' }) },
  );
  assert.deepEqual(login, { version: 1, state: 'login-required' });

  const failed = await handleExternal(
    { version: 1, type: 'LIST_LIVE', payload: {} },
    { url: 'https://johnxmj.github.io/app' },
    { listLive: async () => ({ state: 'failed', courses: [] }) },
  );
  assert.deepEqual(failed, { version: 1, state: 'failed', courses: [] });
});

test('external REFRESH returns the refreshed public state', async () => {
  const calls = [];
  const response = await handleExternal(
    { version: 1, type: 'REFRESH', payload: {} },
    { url: 'https://johnxmj.github.io/app' },
    {
      refresh: async () => {
        calls.push(true);
        return { state: 'ready', courses: [] };
      },
    },
  );
  assert.deepEqual(response, { version: 1, state: 'ready', courses: [] });
  assert.deepEqual(calls, [true]);
});

test('external open player passes only validated ids and view', async () => {
  let payload;
  const response = await handleExternal({ version: 1, type: 'OPEN_PLAYER', payload: { courseId: 'c1', subId: 's1', view: 'teacher' } }, { url: 'https://johnxmj.github.io/' }, { openPlayer: async (value) => { payload = value; return { ok: true }; } });
  assert.deepEqual(response, { ok: true });
  assert.deepEqual(payload, { courseId: 'c1', subId: 's1', view: 'teacher' });
});

test('external OPEN_PLAYER reuses and focuses the existing player tab', async () => {
  const updates = [];
  const response = await handleExternalOpenPlayer(
    {
      version: 1,
      type: 'OPEN_PLAYER',
      payload: { courseId: 'c1', subId: 's1', view: 'student' },
    },
    {
      getUrl: (value) => `chrome-extension://extension-id/${value}`,
      tabsQuery: async () => [{
        id: 17,
        url: 'chrome-extension://extension-id/player/index.html?courseId=old&subId=old&view=teacher',
      }],
      tabsUpdate: async (tabId, changes) => updates.push([tabId, changes]),
    },
  );

  assert.deepEqual(response, { ok: true });
  assert.deepEqual(updates, [[17, {
    active: true,
    url: 'chrome-extension://extension-id/player/index.html?courseId=c1&subId=s1&view=student',
  }]]);
});
