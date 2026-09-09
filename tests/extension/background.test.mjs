import test from 'node:test';
import assert from 'node:assert/strict';

import {
  probeSession,
  openCasLogin,
  createBackgroundHandlers,
  parseCourseIds,
  handleExternalOpenPlayer,
  isLoginCompleteUrl,
  installLoginTabWatcher,
  installRuntimeListeners,
} from '../../edge_extension/src/background.js';

test('cold WebVPN session becomes login-required without password retries', async () => {
  const state = await probeSession({ fetchJson: async () => ({ httpStatus: 302, location: '/login' }) });
  assert.deepEqual(state, { state: 'login-required' });
});

test('login action opens the official CAS page', async () => {
  const opened = [];
  await openCasLogin({ tabsCreate: (value) => opened.push(value) });
  assert.equal(new URL(opened[0].url).hostname, 'webvpn.fudan.edu.cn');
});

test('handlers expose capabilities without download or archive actions', async () => {
  const handlers = createBackgroundHandlers({ probe: async () => ({ state: 'ready' }) });
  const result = await handlers.handle({ version: 1, type: 'CAPABILITIES', payload: {} });
  assert.equal(result.state, 'ready');
  assert.equal(result.capabilities.download, false);
  assert.equal(result.capabilities.record, false);
  assert.equal(result.capabilities.archive, false);
});

test('probeSession checks the canonical iCourse infosimple endpoint by default', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return { status: 200, url: String(input), json: async () => ({ code: 0 }) };
  };
  try {
    assert.deepEqual(await probeSession(), { state: 'ready' });
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.match(requests[0], /\/userapi\/v1\/infosimple$/);
  assert.doesNotMatch(requests[0], /courseapi\/v3\/user\/info/);
});

test('LIST_LIVE uses the canonical multi-search course-detail endpoint', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return {
      status: 200,
      url: String(input),
      json: async () => ({ code: 0, data: { course_id: '1', lectures: [] } }),
    };
  };
  try {
    const handlers = createBackgroundHandlers({
      probe: async () => ({ state: 'ready' }),
      getCourseIds: async () => ['1'],
      listLive: async (fetcher, ids) => {
        await fetcher.getCourseDetail(ids[0]);
        return [];
      },
    });
    assert.deepEqual(
      await handlers.handle({ version: 1, type: 'LIST_LIVE', payload: {} }),
      { state: 'ready', courses: [] },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.match(requests[0], /\/courseapi\/v3\/multi-search\/get-course-detail\?course_id=1$/);
  assert.doesNotMatch(requests[0], /courseapi\/v3\/course\/get-course-detail/);
});

test('LIST_LIVE discovers a live lecture from the canonical nested sub_list response', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const date = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const courseDate = `${date.year}-${date.month}-${date.day}`;
  const subInfo = {
    course_id: '1',
    sub_id: '2',
    course_title: 'Analysis',
    lecturer_name: 'Dr. Example',
    room_name: 'R1',
    sub_title: `${courseDate}第1-2节`,
    start_at: `${courseDate}T09:00:00+08:00`,
    end_at: `${courseDate}T10:00:00+08:00`,
    sub_status: 1,
    live_url: { output: { m3u8: 'https://media.invalid/live.m3u8' } },
  };
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('/userapi/v1/infosimple')) {
      return { status: 200, url, json: async () => ({ code: 0 }) };
    }
    if (url.includes('/courseapi/v3/multi-search/get-course-detail')) {
      return {
        status: 200,
        url,
        json: async () => ({
          code: 0,
          data: {
            course_id: '1',
            title: 'Analysis',
            realname: 'Dr. Example',
            sub_list: {
              [date.year]: {
                [date.month]: {
                  [date.day]: [{
                    id: '2',
                    sub_title: `${courseDate}第1-2节`,
                    lecturer_name: 'Dr. Example',
                    playback_status: '0',
                  }],
                },
              },
            },
          },
        }),
      };
    }
    if (url.includes('/courseapi/v3/portal-home-setting/get-sub-info')) {
      return { status: 200, url, json: async () => ({ code: 0, data: subInfo }) };
    }
    throw new Error(`unexpected request: ${url}`);
  };
  try {
    const handlers = createBackgroundHandlers({
      probe: async () => ({ state: 'ready' }),
      getCourseIds: async () => ['1'],
    });
    const result = await handlers.handle({ version: 1, type: 'LIST_LIVE', payload: {} });
    assert.deepEqual(result, {
      state: 'ready',
      courses: [{
        course_id: '1',
        course_title: 'Analysis',
        teacher: 'Dr. Example',
        room: 'R1',
        sub_id: '2',
        sub_title: `${courseDate}第1-2节`,
        starts_at: subInfo.start_at,
        ends_at: subInfo.end_at,
        status: 'live',
        available_views: ['teacher'],
      }],
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(requests.filter((url) => url.includes('/courseapi/v3/portal-home-setting/get-sub-info')).length, 1);
});

test('PLAYER_SOURCE validates and uses its payload fields', async () => {
  const calls = [];
  const handlers = createBackgroundHandlers({
    fetcher: {
      async getSubInfo(courseId, subId) {
        calls.push([courseId, subId]);
        return {
          sub_status: 1,
          sub_id: subId,
          live_url: { output: { m3u8: 'https://media.invalid/live.m3u8' } },
        };
      },
    },
  });
  const listeners = [];
  installRuntimeListeners({
    runtime: {
      id: 'extension-id',
      onMessage: { addListener(listener) { listeners.push(listener); } },
      onMessageExternal: { addListener() {} },
    },
    tabs: {},
  }, handlers);
  const responses = [];
  const keepChannelOpen = listeners[0](
    {
      type: 'PLAYER_SOURCE',
      payload: { courseId: 'course1', subId: 'sub2', view: 'teacher' },
    },
    { id: 'extension-id' },
    (value) => responses.push(value),
  );
  assert.equal(keepChannelOpen, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [['course1', 'sub2']]);
  assert.deepEqual(responses, [{ ok: true, source: 'https://media.invalid/live.m3u8' }]);
});

test('PLAYER_HANDSHAKE returns the stable protocol version', async () => {
  const listeners = [];
  installRuntimeListeners({
    runtime: {
      id: 'extension-id',
      onMessage: { addListener(listener) { listeners.push(listener); } },
      onMessageExternal: { addListener() {} },
    },
    tabs: {},
  }, createBackgroundHandlers());
  const responses = [];
  assert.equal(
    listeners[0](
      { type: 'PLAYER_HANDSHAKE' },
      { id: 'extension-id' },
      (value) => responses.push(value),
    ),
    false,
  );
  assert.deepEqual(responses, [{ ok: true, version: 1 }]);
});

test('PLAYER_SOURCE rejects an unsupported wrapper version', async () => {
  const listeners = [];
  installRuntimeListeners({
    runtime: {
      id: 'extension-id',
      onMessage: { addListener(listener) { listeners.push(listener); } },
      onMessageExternal: { addListener() {} },
    },
    tabs: {},
  }, createBackgroundHandlers());
  const responses = [];
  assert.equal(
    listeners[0](
      {
        version: 2,
        type: 'PLAYER_SOURCE',
        payload: { courseId: 'course1', subId: 'sub2', view: 'teacher' },
      },
      { id: 'extension-id' },
      (value) => responses.push(value),
    ),
    false,
  );
  assert.deepEqual(responses, [{ ok: false, error: 'invalid request' }]);
});

test('external OPEN_PLAYER requires a versioned validated envelope', async () => {
  const opened = [];
  const tabsCreate = async (value) => {
    opened.push(value);
    return { id: 42 };
  };
  const getUrl = (value) => `extension://${value}`;
  assert.deepEqual(
    await handleExternalOpenPlayer(
      {
        version: 1,
        type: 'OPEN_PLAYER',
        payload: { courseId: 'course1', subId: 'sub2', view: 'student' },
      },
      { tabsCreate, getUrl },
    ),
    { ok: true },
  );
  assert.match(opened[0].url, /courseId=course1/);
  assert.deepEqual(
    await handleExternalOpenPlayer(
      {
        version: 1,
        type: 'OPEN_PLAYER',
        payload: { courseId: 'course1', subId: 'sub2', view: 'student', token: 'secret' },
      },
      { tabsCreate, getUrl },
    ),
    { ok: false, error: 'invalid request' },
  );
  assert.deepEqual(
    await handleExternalOpenPlayer(
      { type: 'OPEN_PLAYER', courseId: 'course1', subId: 'sub2', view: 'student' },
      { tabsCreate, getUrl },
    ),
    { ok: false, error: 'invalid request' },
  );
  assert.equal(opened.length, 1);
});

test('OPEN_PLAYER reuses and focuses an existing player tab', async () => {
  const listeners = [];
  const updates = [];
  const tabs = [{
    id: 91,
    url: 'chrome-extension://extension-id/player/index.html?courseId=old&subId=old&view=teacher',
  }];
  installRuntimeListeners({
    runtime: {
      id: 'extension-id',
      getURL: (value) => `chrome-extension://extension-id/${value}`,
      onMessage: { addListener(listener) { listeners.push(listener); } },
      onMessageExternal: { addListener() {} },
    },
    tabs: {
      query: async () => tabs,
      update: async (tabId, changes) => updates.push([tabId, changes]),
    },
  }, createBackgroundHandlers({ probe: async () => ({ state: 'ready' }) }));

  const responses = [];
  listeners[0](
    {
      version: 1,
      type: 'OPEN_PLAYER',
      payload: { courseId: 'course1', subId: 'sub2', view: 'student' },
    },
    { id: 'extension-id' },
    (value) => responses.push(value),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(responses, [{ ok: true }]);
  assert.deepEqual(updates, [[91, {
    active: true,
    url: 'chrome-extension://extension-id/player/index.html?courseId=course1&subId=sub2&view=student',
  }]]);
});

test('external LIST_LIVE uses the authenticated background catalog', async () => {
  const externalListeners = [];
  installRuntimeListeners({
    runtime: {
      id: 'extension-id',
      getURL: (value) => `chrome-extension://extension-id/${value}`,
      onMessage: { addListener() {} },
      onMessageExternal: { addListener(listener) { externalListeners.push(listener); } },
    },
    tabs: {},
  }, {
    handle: async () => ({ state: 'failed' }),
    refresh: async () => ({
      state: 'ready',
      courses: [{
        course_id: 'course1',
        sub_id: 'sub2',
        course_title: 'Analysis',
        live_url: 'must-not-cross-boundary',
      }],
    }),
    source: async () => 'unused',
  });

  const responses = [];
  externalListeners[0](
    { version: 1, type: 'LIST_LIVE', payload: {} },
    { url: 'https://johnxmj.github.io/app' },
    (value) => responses.push(value),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(responses, [{
    version: 1,
    state: 'ready',
    courses: [{
      course_id: 'course1',
      course_title: 'Analysis',
      teacher: '',
      room: '',
      sub_id: 'sub2',
      sub_title: '',
      starts_at: '',
      ends_at: '',
      status: '',
      available_views: [],
    }],
  }]);
});

test('login completion recognizes direct iCourse and routed WebVPN URLs', () => {
  assert.equal(isLoginCompleteUrl('https://icourse.fudan.edu.cn/'), true);
  assert.equal(isLoginCompleteUrl('https://webvpn.fudan.edu.cn/https/77726476706e69737468656265737421f9f44e8935236d1e781d8dad961b2631a501f26f/courseapi/v3'), true);
  assert.equal(isLoginCompleteUrl('https://webvpn.fudan.edu.cn/'), true);
  assert.equal(isLoginCompleteUrl('https://webvpn.fudan.edu.cn/login'), false);
});

test('course ID settings are normalized and deduplicated', () => {
  assert.deepEqual(parseCourseIds('37142, 37234 37142\n38154'), ['37142', '37234', '38154']);
  assert.deepEqual(parseCourseIds(['37142', 'bad-id!', '37142']), ['37142']);
});

test('handlers read configured course IDs from extension storage', async () => {
  const calls = [];
  const handlers = createBackgroundHandlers({
    probe: async () => ({ state: 'ready' }),
    storageGet: async () => ({ courseIds: ['37142'] }),
    listLive: async (_fetcher, ids) => { calls.push(ids); return []; },
  });
  await handlers.handle({ version: 1, type: 'LIST_LIVE', payload: {} });
  assert.deepEqual(calls, [['37142']]);
});

test('WebVPN home waits for a confirmed ready session before closing login tab', async () => {
  await openCasLogin({ tabsCreate: async () => ({ id: 74 }) });
  const listeners = [];
  const removed = [];
  let state = 'login-required';
  installLoginTabWatcher({
    tabs: {
      onUpdated: { addListener(listener) { listeners.push(listener); } },
      remove: async (tabId) => removed.push(tabId),
    },
  }, { refresh: async () => ({ state }) });

  listeners[0](74, { url: 'https://webvpn.fudan.edu.cn/login' });
  listeners[0](74, { url: 'https://webvpn.fudan.edu.cn/' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(removed, []);

  state = 'ready';
  listeners[0](74, { url: 'https://webvpn.fudan.edu.cn/' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(removed, [74]);
});

test('initial WebVPN home does not close the login tab before the auth page', async () => {
  await openCasLogin({ tabsCreate: async () => ({ id: 75 }) });
  const listeners = [];
  const removed = [];
  installLoginTabWatcher({
    tabs: {
      onUpdated: { addListener(listener) { listeners.push(listener); } },
      remove: async (tabId) => removed.push(tabId),
    },
  }, { refresh: async () => ({ state: 'ready' }) });

  listeners[0](75, { url: 'https://webvpn.fudan.edu.cn/' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(removed, []);
});

test('CAS completion closes only the created tab and refreshes handlers', async () => {
  const opened = await openCasLogin({ tabsCreate: async () => ({ id: 73 }) });
  assert.equal(opened.id, 73);
  const listeners = [];
  const removed = [];
  const calls = [];
  installRuntimeListeners({
    runtime: {
      id: 'extension-id',
      onMessage: { addListener() {} },
      onMessageExternal: { addListener() {} },
    },
    tabs: {
      onUpdated: { addListener(listener) { listeners.push(listener); } },
      remove: async (tabId) => removed.push(tabId),
    },
  }, {
    handle: async (message) => {
      calls.push(message);
      return { state: 'ready' };
    },
    source: async () => 'unused',
  });
  listeners[0](73, {
    url: 'https://webvpn.fudan.edu.cn/https/77726476706e69737468656265737421f9f44e8935236d1e781d8dad961b2631a501f26f/courseapi/v3',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(removed, [73]);
  assert.deepEqual(calls, [{ version: 1, type: 'REFRESH', payload: {} }]);
});

test('runtime listeners route versioned protocol requests through handlers', async () => {
  const listeners = [];
  const calls = [];
  const handlers = {
    handle: async (message) => {
      calls.push(message);
      return { state: 'ready' };
    },
    source: async () => 'unused',
  };
  installRuntimeListeners({
    runtime: {
      id: 'extension-id',
      onMessage: { addListener(listener) { listeners.push(listener); } },
      onMessageExternal: { addListener() {} },
    },
    tabs: {},
  }, handlers);
  const responses = [];
  assert.equal(
    listeners.at(-1)(
      { version: 1, type: 'REFRESH', payload: {} },
      { id: 'extension-id' },
      (value) => responses.push(value),
    ),
    true,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ version: 1, type: 'REFRESH', payload: {} }]);
  assert.deepEqual(responses, [{ state: 'ready' }]);
});

test('runtime listeners expose course ID settings to the popup', async () => {
  const listeners = [];
  let stored = [];
  installRuntimeListeners({
    runtime: {
      id: 'extension-id',
      onMessage: { addListener(listener) { listeners.push(listener); } },
      onMessageExternal: { addListener() {} },
    },
    storage: {
      local: {
        get: async () => ({ courseIds: stored }),
        set: async ({ courseIds }) => { stored = courseIds; },
      },
    },
    tabs: {},
  }, { handle: async () => ({ state: 'ready' }), source: async () => 'unused' });
  const getResponses = [];
  listeners.at(-1)({ type: 'GET_COURSE_IDS' }, { id: 'extension-id' }, (value) => getResponses.push(value));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(getResponses, [{ courseIds: [] }]);
  const setResponses = [];
  listeners.at(-1)({ type: 'SET_COURSE_IDS', courseIds: '37142,37234,37142' }, { id: 'extension-id' }, (value) => setResponses.push(value));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(setResponses, [{ ok: true, courseIds: ['37142', '37234'] }]);
  assert.deepEqual(stored, ['37142', '37234']);
});

test('popup exposes a user-triggered CAS login action', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync('edge_extension/popup/index.html', 'utf8');
  const script = readFileSync('edge_extension/popup/popup.js', 'utf8');
  assert.match(html, /id=["']login["']/);
  assert.match(html, /popup\.js/);
  assert.match(script, /OPEN_CAS_LOGIN/);
  assert.match(script, /addEventListener\(["']click["']/);
  assert.match(html, /id=["']course-ids["']/);
  assert.match(script, /SET_COURSE_IDS/);
});
