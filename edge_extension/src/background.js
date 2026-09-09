import { listFollowedCourses, listLiveCourses, resolveLiveSource } from './live-api.js';
import { readCourseIds, readCourseSelections, saveCourseIds } from './course-settings.js';
import { createDirectoryService, discoverRecentTerms } from './course-directory.js';
import {
  parseRequest,
  safeCourse,
  PROTOCOL_VERSION,
  CAPABILITIES,
  LIST_LIVE,
  LIST_FOLLOWED,
  OPEN_PLAYER,
  SET_VIEW,
  REFRESH,
} from './protocol.js';
import { WEBVPN_PREFIX } from './webvpn-url.js';

const ALLOWED_PAGE_ORIGIN = 'https://johnxmj.github.io';
const CAS_URL = 'https://webvpn.fudan.edu.cn/';
const API_BASE = `${WEBVPN_PREFIX}/`;
const SAFE_COURSE_ID = /^[A-Za-z0-9]{1,64}$/;
export const PLAYER_HANDSHAKE = 'PLAYER_HANDSHAKE';
export const PLAYER_SOURCE = 'PLAYER_SOURCE';
export const OPEN_CAS_LOGIN = 'OPEN_CAS_LOGIN';

let loginTabId = null;
let loginTabSawPrompt = false;

export function parseCourseIds(value) {
  // Preserve normalization of legacy ID arrays; user input is validated by saveCourseIds.
  const values = Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/);
  return [...new Set(values
    .map((item) => String(item ?? '').trim())
    .filter((item) => SAFE_COURSE_ID.test(item)))];
}

/** Handle the small, public API exposed to the approved Pages origin. */
export async function handleExternal(message, sender = {}, deps = {}) {
  let origin;
  try { origin = new URL(sender.url || '').origin; } catch { origin = ''; }
  if (origin !== ALLOWED_PAGE_ORIGIN) {
    return { error: { code: 'ORIGIN_DENIED', message: 'origin is not allowed' } };
  }
  let request;
  try { request = parseRequest(message); } catch { return { error: { code: 'INVALID_REQUEST', message: 'invalid request' } }; }
  if (request.type === CAPABILITIES) {
    const state = typeof deps.getState === 'function' ? await deps.getState() : null;
    return {
      version: PROTOCOL_VERSION,
      ...(typeof state?.state === 'string' ? { state: state.state } : {}),
      ...(deps.playerFrameUrl || globalThis.chrome?.runtime?.getURL?.('player/index.html')
        ? { playerFrame: deps.playerFrameUrl || globalThis.chrome?.runtime?.getURL?.('player/index.html') }
        : {}),
    };
  }
  if (request.type === LIST_LIVE) {
    const listing = deps.listLive
      ? await deps.listLive()
      : await listLiveCourses(
        deps.fetcher || defaultFetcher,
        await (deps.getCourseIds || (async () => []))(),
      );
    const courses = Array.isArray(listing) ? listing : (Array.isArray(listing?.courses) ? listing.courses : []);
    return {
      version: PROTOCOL_VERSION,
      ...(typeof listing?.state === 'string' ? { state: listing.state } : {}),
      courses: courses.map(safeCourse),
    };
  }
  if (request.type === LIST_FOLLOWED) {
    const listing = deps.listFollowed
      ? await deps.listFollowed()
      : await listFollowedCourses(
        deps.fetcher || defaultFetcher,
        await (deps.getCourseSelections || (async () => []))(),
      );
    const courses = Array.isArray(listing) ? listing : (Array.isArray(listing?.courses) ? listing.courses : []);
    return {
      version: PROTOCOL_VERSION,
      ...(typeof listing?.state === 'string' ? { state: listing.state } : {}),
      courses: courses.map(safeCourse),
    };
  }
  if (request.type === REFRESH) {
    const refreshed = typeof deps.refresh === 'function'
      ? await deps.refresh()
      : (typeof deps.getState === 'function' ? await deps.getState() : {});
    const courses = Array.isArray(refreshed) ? refreshed : refreshed?.courses;
    return {
      version: PROTOCOL_VERSION,
      ...(typeof refreshed?.state === 'string' ? { state: refreshed.state } : {}),
      ...(Array.isArray(courses) ? { courses: courses.map(safeCourse) } : {}),
    };
  }
  if (request.type === OPEN_PLAYER) {
    if (typeof deps.openPlayer === 'function') return deps.openPlayer(request.payload);
    return handleExternalOpenPlayer(message, deps);
  }
  return { error: { code: 'UNSUPPORTED', message: 'request is not externally available' } };
}

async function apiGet(path, params) {
  const url = new URL(path, API_BASE);
  Object.entries(params || {}).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  const body = await response.json().catch(() => ({}));
  return {
    httpStatus: response.status,
    location: response.url?.includes('/login') ? '/login' : undefined,
    body,
  };
}

function assertApiSuccess(result) {
  const code = result?.body?.code;
  if ([302, 401, 403].includes(result?.httpStatus) || [401, 403, '401', '403'].includes(code) || locationRequiresLogin(result?.location)) {
    throw Object.assign(new Error('login required'), { state: 'login-required' });
  }
  if (result?.httpStatus !== 200 || (code != null && ![0, 200, '0', '200'].includes(code))) throw new Error('request failed');
}

const defaultFetcher = {
  async getDirectoryTerms() {
    const result = await apiGet('portal/courseapi/v3/multi-search/get-course-list', { tenant: 222, page: 1, per_page: 500 });
    assertApiSuccess(result);
    return discoverRecentTerms(result.body.data);
  },
  async getCourseList({ term, page, per_page }) {
    const result = await apiGet('portal/courseapi/v3/multi-search/get-course-list', { tenant: 222, term, page, per_page });
    assertApiSuccess(result);
    return result.body.data;
  },
  async getSubInfo(courseId, subId) {
    const result = await apiGet(
      'courseapi/v3/portal-home-setting/get-sub-info',
      { course_id: courseId, sub_id: subId },
    );
    assertApiSuccess(result);
    return result.body.data || {};
  },
  async getCourseDetail(courseId) {
    const result = await apiGet(
      'courseapi/v3/multi-search/get-course-detail',
      { course_id: courseId },
    );
    assertApiSuccess(result);
    return result.body.data || result.body;
  },
};

function locationRequiresLogin(location) {
  return typeof location === 'string' && /\/login(?:[/?#]|$)/i.test(location);
}

export async function probeSession(deps = {}) {
  try {
    const result = await (
      deps.fetchJson
        || (() => apiGet('userapi/v1/infosimple'))
    )();
    if (
      result?.httpStatus === 302
      || result?.httpStatus === 401
      || result?.httpStatus === 403
      || [401, 403, '401', '403'].includes(result?.body?.code)
      || locationRequiresLogin(result?.location)
    ) {
      return { state: 'login-required' };
    }
    const code = result?.body?.code;
    if (result?.httpStatus === 200 && [0, 200, '0', '200'].includes(code)) {
      return { state: 'ready' };
    }
    return { state: 'failed' };
  } catch (_) {
    return { state: 'failed' };
  }
}

export async function openCasLogin({ tabsCreate } = {}) {
  const create = tabsCreate || globalThis.chrome?.tabs?.create?.bind(globalThis.chrome.tabs);
  if (typeof create !== 'function') throw new Error('tabs unavailable');
  const tab = await create({ url: CAS_URL });
  loginTabId = tab?.id ?? null;
  loginTabSawPrompt = false;
  return tab;
}

export function createBackgroundHandlers(deps = {}) {
  const fetcher = deps.fetcher || defaultFetcher;
  const probe = deps.probe || (() => probeSession(deps));
  const storage = deps.storage || (typeof deps.storageGet === 'function' ? { get: deps.storageGet } : undefined);
  const getCourseIds = deps.getCourseIds || (() => readCourseIds(storage));
  const getCourseSelections = deps.getCourseSelections || (() => readCourseSelections(storage));
  const directoryService = createDirectoryService({ fetchPage: params => fetcher.getCourseList(params) });
  let currentSession = { state: 'unknown' };
  let selectedView = 'teacher';

  async function refreshSession() {
    currentSession = await probe();
    return currentSession;
  }

  async function listConfiguredCourses() {
    const ids = await getCourseIds();
    if (!ids.length) return { state: 'unconfigured', courses: [] };
    await refreshSession();
    if (currentSession.state !== 'ready') return { state: currentSession.state, courses: [] };
    try {
      const courses = await (deps.listLive || listLiveCourses)(fetcher, ids);
      return { state: 'ready', courses: courses.map(safeCourse) };
    } catch (error) {
      return { state: error?.state === 'login-required' ? 'login-required' : 'failed', courses: [] };
    }
  }

  async function listFollowedConfiguredCourses() {
    const selections = await getCourseSelections();
    if (!selections.length) return { state: 'unconfigured', courses: [] };
    await refreshSession();
    if (currentSession.state !== 'ready') return { state: currentSession.state, courses: [] };
    try {
      const courses = deps.listFollowed
        ? await deps.listFollowed(fetcher, selections)
        : await listFollowedCourses(fetcher, selections);
      return { state: 'ready', courses: courses.map(safeCourse) };
    } catch (error) {
      return { state: error?.state === 'login-required' ? 'login-required' : 'failed', courses: [] };
    }
  }

  return {
    getSessionState: refreshSession,
    listFollowed: listFollowedConfiguredCourses,
    async directory(message = {}) {
      try {
        await refreshSession();
        if (currentSession.state !== 'ready') return { state: currentSession.state };
        if (message.type === 'GET_DIRECTORY_TERMS') {
          const result = await fetcher.getDirectoryTerms();
          return { state: 'ready', terms: result.terms, currentTerm: result.currentTerm };
        }
        if (message.type !== 'SEARCH_COURSES') return { state: 'failed' };
        const result = await directoryService.search({ term: message.term, query: message.query, page: message.page, perPage: message.perPage });
        return { state: 'ready', ...result };
      } catch (error) {
        return { state: error?.state === 'login-required' ? 'login-required' : 'failed' };
      }
    },
    async handle(message) {
      const request = parseRequest(message);
      if (request.type === CAPABILITIES) {
        await refreshSession();
        return {
          state: currentSession.state,
          capabilities: {
            live: true,
            download: false,
            record: false,
            archive: false,
          },
        };
      }
      if (request.type === REFRESH) {
        return listConfiguredCourses();
      }
      if (request.type === LIST_LIVE) {
        return listConfiguredCourses();
      }
      if (request.type === LIST_FOLLOWED) {
        return listFollowedConfiguredCourses();
      }
      if (request.type === SET_VIEW) {
        selectedView = request.payload.view;
        return { ok: true, view: selectedView };
      }
      if (request.type === OPEN_PLAYER) {
        return { ok: true, ...request.payload };
      }
      return { state: 'failed' };
    },

    async source(courseId, subId, view) {
      const request = parseRequest({
        version: PROTOCOL_VERSION,
        type: OPEN_PLAYER,
        payload: { courseId, subId, view },
      });
      return resolveLiveSource(
        fetcher,
        request.payload.courseId,
        request.payload.subId,
        request.payload.view,
      );
    },

    async refresh() {
      return listConfiguredCourses();
    },
  };
}

export async function handleRequest(message, deps) {
  return createBackgroundHandlers(deps).handle(message);
}

function isAllowedSender(sender, external = false, chromeApi = globalThis.chrome) {
  if (!sender) return false;
  if (external) return sender.origin === ALLOWED_PAGE_ORIGIN;
  return !chromeApi?.runtime?.id || sender.id === chromeApi.runtime.id;
}

function playerPayload(message) {
  return parseRequest({
    version: message?.version ?? PROTOCOL_VERSION,
    type: OPEN_PLAYER,
    payload: message?.payload,
  }).payload;
}

export async function handleExternalOpenPlayer(message, deps = {}) {
  let request;
  try {
    request = parseRequest(message);
  } catch (_) {
    return { ok: false, error: 'invalid request' };
  }

  const create = deps.tabsCreate || globalThis.chrome?.tabs?.create?.bind(globalThis.chrome.tabs);
  const query = deps.tabsQuery || globalThis.chrome?.tabs?.query?.bind(globalThis.chrome.tabs);
  const update = deps.tabsUpdate || globalThis.chrome?.tabs?.update?.bind(globalThis.chrome.tabs);
  const getUrl = deps.getUrl || globalThis.chrome?.runtime?.getURL?.bind(globalThis.chrome.runtime);
  if (typeof getUrl !== 'function') {
    return { ok: false, error: 'tabs unavailable' };
  }

  const { courseId, subId, view } = request.payload;
  const playerUrl = getUrl(
    `player/index.html?courseId=${encodeURIComponent(courseId)}`
      + `&subId=${encodeURIComponent(subId)}`
      + `&view=${encodeURIComponent(view)}`,
  );

  if (typeof query === 'function') {
    let matches = [];
    try {
      matches = await query({ url: `${getUrl('player/index.html')}*` });
    } catch (_) {
      matches = [];
    }
    const existing = Array.isArray(matches)
      ? matches.find((tab) => Number.isInteger(tab?.id))
      : null;
    if (existing) {
      if (typeof update === 'function') await update(existing.id, { active: true, url: playerUrl });
      return { ok: true };
    }
  }

  if (typeof create !== 'function') return { ok: false, error: 'tabs unavailable' };
  await create({ url: playerUrl });
  return { ok: true };
}

export function isLoginCompleteUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const url = new URL(value);
    if (url.hostname === 'icourse.fudan.edu.cn') return true;
    const webVpnRoute = new URL(WEBVPN_PREFIX).pathname.replace(/\/+$/, '');
    return (
      url.hostname === 'webvpn.fudan.edu.cn'
      && (url.pathname === '/' || url.pathname === webVpnRoute || url.pathname.startsWith(`${webVpnRoute}/`))
    );
  } catch (_) {
    return false;
  }
}

export function installLoginTabWatcher(
  chromeApi = globalThis.chrome,
  handlers = createBackgroundHandlers(),
  onRefresh,
) {
  const updated = chromeApi?.tabs?.onUpdated;
  if (!updated?.addListener) return;
  updated.addListener((tabId, changeInfo = {}, tab = {}) => {
    if (tabId !== loginTabId) return;
    const destination = changeInfo.url || tab.url;
    if (isWebVpnLoginUrl(destination)) {
      loginTabSawPrompt = true;
      return;
    }
    if (!isLoginCompleteUrl(destination)) return;

    const isWebVpnHome = (() => {
      try {
        const url = new URL(destination);
        return url.hostname === 'webvpn.fudan.edu.cn' && url.pathname === '/';
      } catch (_) {
        return false;
      }
    })();
    if (isWebVpnHome && !loginTabSawPrompt) return;
    const refresh = onRefresh || (
      typeof handlers.refresh === 'function'
        ? () => handlers.refresh()
        : () => handlers.handle({ version: PROTOCOL_VERSION, type: REFRESH, payload: {} })
    );
    const checkSession = typeof handlers.getSessionState === 'function' ? () => handlers.getSessionState() : refresh;
    Promise.resolve()
      .then(checkSession)
      .then((result) => {
        // The WebVPN home is also the pre-login redirect target. Only close it
        // after the authenticated API check confirms a ready session.
        if (isWebVpnHome && result?.state !== 'ready') return;
        if (loginTabId !== tabId) return;
        const completedTabId = tabId;
        loginTabId = null;
        if (checkSession !== refresh) Promise.resolve().then(refresh).catch(() => {});
        return chromeApi.tabs.remove?.(completedTabId);
      })
      .catch(() => {});
  });
}

function isWebVpnLoginUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === 'webvpn.fudan.edu.cn' && url.pathname === '/login';
  } catch (_) {
    return false;
  }
}

export function installRuntimeListeners(
  chromeApi = globalThis.chrome,
  handlers = createBackgroundHandlers(),
) {
  const runtime = chromeApi?.runtime;
  if (!runtime?.onMessage?.addListener) return;

  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isAllowedSender(sender, false, chromeApi)) return false;

    if (message?.type === 'GET_DIRECTORY_TERMS' || message?.type === 'SEARCH_COURSES') {
      Promise.resolve().then(() => handlers.directory(message))
        .then(sendResponse)
        .catch(() => sendResponse({ state: 'failed' }));
      return true;
    }

    if (message?.type === 'GET_COURSE_IDS') {
      readCourseIds(chromeApi.storage?.local)
        .then((courseIds) => sendResponse({ courseIds }))
        .catch(() => sendResponse({ courseIds: [] }));
      return true;
    }

    if (message?.type === 'SET_COURSE_IDS') {
      const input = Array.isArray(message.courseIds) ? parseCourseIds(message.courseIds).join('\n') : message.courseIds;
      saveCourseIds(input, chromeApi.storage?.local)
        .then((courseIds) => sendResponse({ ok: true, courseIds }))
        .catch((error) => sendResponse({ ok: false, error: error instanceof TypeError ? 'invalid course IDs' : 'storage unavailable' }));
      return true;
    }

    if (message?.type === PLAYER_HANDSHAKE) {
      try {
        if (Object.prototype.hasOwnProperty.call(message, 'payload')) playerPayload(message);
        sendResponse({ ok: true, version: PROTOCOL_VERSION });
      } catch (_) {
        sendResponse({ ok: false, error: 'invalid request' });
      }
      return false;
    }

    if (message?.type === OPEN_PLAYER) {
      handleExternalOpenPlayer(message, {
        tabsCreate: chromeApi.tabs?.create?.bind(chromeApi.tabs),
        tabsQuery: chromeApi.tabs?.query?.bind(chromeApi.tabs),
        tabsUpdate: chromeApi.tabs?.update?.bind(chromeApi.tabs),
        getUrl: runtime.getURL?.bind(runtime),
      })
        .then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: 'player unavailable' }));
      return true;
    }

    if (message?.type === PLAYER_SOURCE) {
      let payload;
      try {
        payload = playerPayload(message);
      } catch (_) {
        sendResponse({ ok: false, error: 'invalid request' });
        return false;
      }
      handlers.source(payload.courseId, payload.subId, payload.view)
        .then((source) => sendResponse({ ok: true, source }))
        .catch((error) => sendResponse({ ok: false, error: 'live source unavailable', state: ['login-required', 'ended'].includes(error?.state) ? error.state : 'failed' }));
      return true;
    }

    if (message?.type === OPEN_CAS_LOGIN) {
      openCasLogin({
        tabsCreate: chromeApi.tabs?.create?.bind(chromeApi.tabs),
      })
        .then((tab) => sendResponse({ ok: true, tabId: tab?.id ?? null }))
        .catch(() => sendResponse({ ok: false, error: 'login unavailable' }));
      return true;
    }

    let pending;
    try {
      pending = handlers.handle(message);
    } catch (_) {
      sendResponse({ ok: false, error: 'invalid request' });
      return false;
    }
    Promise.resolve(pending)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof TypeError ? 'invalid request' : 'request failed',
      }));
    return true;
  });

  runtime.onMessageExternal?.addListener((message, sender, sendResponse) => {
    handleExternal(message, sender, {
      tabsCreate: chromeApi.tabs?.create?.bind(chromeApi.tabs),
      getState: () => handlers.handle({ version: PROTOCOL_VERSION, type: CAPABILITIES, payload: {} }),
      listLive: async () => {
        const result = typeof handlers.refresh === 'function'
          ? await handlers.refresh()
          : await handlers.handle({ version: PROTOCOL_VERSION, type: LIST_LIVE, payload: {} });
        return result;
      },
      listFollowed: typeof handlers.listFollowed === 'function'
        ? () => handlers.listFollowed()
        : undefined,
      refresh: typeof handlers.refresh === 'function'
        ? () => handlers.refresh()
        : () => handlers.handle({ version: PROTOCOL_VERSION, type: REFRESH, payload: {} }),
      getUrl: runtime.getURL?.bind(runtime),
      playerFrameUrl: runtime.getURL?.('player/index.html'),
      openPlayer: (payload) => handleExternalOpenPlayer({ version: PROTOCOL_VERSION, type: OPEN_PLAYER, payload }, {
        tabsCreate: chromeApi.tabs?.create?.bind(chromeApi.tabs),
        tabsQuery: chromeApi.tabs?.query?.bind(chromeApi.tabs),
        tabsUpdate: chromeApi.tabs?.update?.bind(chromeApi.tabs),
        getUrl: runtime.getURL?.bind(runtime),
      }),
    })
      .then(sendResponse)
      .catch(() => sendResponse({ error: { code: 'REQUEST_FAILED', message: 'request failed' } }));
    return true;
  });

  installLoginTabWatcher(chromeApi, handlers);
}

const defaultHandlers = createBackgroundHandlers();
if (globalThis.chrome) installRuntimeListeners(globalThis.chrome, defaultHandlers);
