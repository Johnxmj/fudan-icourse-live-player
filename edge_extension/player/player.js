import { toWebVpnUrl } from '../src/webvpn-url.js';

const video = document.getElementById('video');
const status = document.getElementById('status');
const params = new URLSearchParams(location.search);
const SAFE_VIEWS = new Set(['teacher', 'student', 'teacher_audio', 'student_audio']);
const SAFE_ID = /^[A-Za-z0-9]{1,64}$/;
const SAFE_NONCE = /^[A-Za-z0-9._:-]{1,256}$/;
const EMBEDDING_MESSAGE_TYPES = new Set(['PLAYER_INIT', 'SET_VIEW']);
const embedded = globalThis.parent && globalThis.parent !== globalThis;
const queryRequest = {
  courseId: params.get('courseId') || '',
  subId: params.get('subId') || '',
  view: params.get('view') || 'teacher',
};
const request = { courseId: '', subId: '', view: 'teacher' };
let hls = null;
let loadGeneration = 0;
export const EMBEDDING_ORIGIN = 'https://johnxmj.github.io';
const embeddingNonce = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
let challengeNonce = null;
let initialized = !embedded;
let startPromise = null;

function safeNonce(value) {
  return typeof value === 'string' && SAFE_NONCE.test(value);
}

export function sendEmbeddingHello(target = globalThis.parent, origin = EMBEDDING_ORIGIN) {
  if (target && target !== globalThis) {
    target.postMessage({ type: 'LIVE_PLAYER_HELLO', nonce: embeddingNonce, version: 1 }, origin);
  }
}

export function sendEmbeddingReady(
  target = globalThis.parent,
  origin = EMBEDDING_ORIGIN,
  nonce = challengeNonce,
  helloNonce = embeddingNonce,
) {
  if (
    target
    && target !== globalThis
    && safeNonce(nonce)
    && helloNonce === embeddingNonce
  ) {
    target.postMessage({
      type: 'LIVE_PLAYER_READY',
      nonce,
      helloNonce,
      version: 1,
    }, origin);
  }
}

export function isValidEmbeddingMessage(event = {}, nonce = challengeNonce) {
  return event.origin === EMBEDDING_ORIGIN
    && event.source === globalThis.parent
    && event.data?.version === 1
    && EMBEDDING_MESSAGE_TYPES.has(event.data?.type)
    && event.data?.nonce === nonce
    && event.data?.helloNonce === embeddingNonce;
}

function validRequest(value = {}) {
  return SAFE_ID.test(value.courseId) && SAFE_ID.test(value.subId) && SAFE_VIEWS.has(value.view);
}

function applyPlayerInit(value) {
  if (
    !challengeNonce
    || value?.nonce !== challengeNonce
    || value?.helloNonce !== embeddingNonce
    || !validRequest(value || {})
  ) return false;
  request.courseId = value.courseId;
  request.subId = value.subId;
  request.view = value.view;
  initialized = true;
  return true;
}

if (globalThis.addEventListener) {
  globalThis.addEventListener('message', (event) => {
    if (!embedded) return;
    const data = event?.data;
    if (
      event.origin !== EMBEDDING_ORIGIN
      || event.source !== globalThis.parent
      || data?.version !== 1
    ) return;
    if (event.data?.type === 'PLAYER_CHALLENGE') {
      if (!safeNonce(data.nonce) || data.helloNonce !== embeddingNonce) return;
      challengeNonce = data.nonce;
      sendEmbeddingReady(globalThis.parent, EMBEDDING_ORIGIN, challengeNonce, embeddingNonce);
      return;
    }
    if (!isValidEmbeddingMessage(event)) return;
    if (event.data?.type === 'PLAYER_INIT') {
      if (!applyPlayerInit(data)) {
        status.textContent = 'invalid player parameters';
        return;
      }
      void startIfReady();
      return;
    }
    if (event.data?.type === 'SET_VIEW' && SAFE_VIEWS.has(data.view)) {
      const next = new URL(location.href);
      next.searchParams.set('view', data.view);
      globalThis.history?.replaceState?.({}, '', next);
      request.view = data.view;
      if (initialized) void loadSourceForView(data.view);
    }
  });
}
if (embedded) sendEmbeddingHello();
const diagnostics = window.__fudanPlayerDiagnostics = {
  manifestHttpStatus: null,
  fragmentCount: 0,
  mediaSource: null,
  manifestParsed: false,
  playAttempted: false,
};

async function getSource(view = request.view) {
  const handshake = await chrome.runtime.sendMessage({ version: 1, type: 'PLAYER_HANDSHAKE' });
  if (!handshake?.ok) throw new Error('extension handshake failed');
  const result = await chrome.runtime.sendMessage({
    version: 1,
    type: 'PLAYER_SOURCE',
    payload: { courseId: request.courseId, subId: request.subId, view },
  });
  if (!result?.ok || typeof result.source !== 'string') throw new Error(result?.error || 'live source unavailable');
  return result.source;
}

class WebVpnLoader extends Hls.DefaultConfig.loader {
  load(context, config, callbacks) {
    if (context.url.startsWith('https://icourse.fudan.edu.cn/')) context.url = toWebVpnUrl(context.url);
    return super.load(context, config, callbacks);
  }
}

async function loadSourceForView(view) {
  if (!SAFE_VIEWS.has(view)) throw new Error('invalid player view');
  const generation = ++loadGeneration;
  status.textContent = 'Connecting…';
  let source;
  try {
    source = await getSource(view);
  } catch (error) {
    if (generation !== loadGeneration) return;
    status.textContent = error.message;
    return;
  }
  if (generation !== loadGeneration || !hls) return;
  request.view = view;
  hls.stopLoad?.();
  hls.loadSource(source);
}

function startIfReady() {
  if (!initialized) return Promise.resolve();
  if (!startPromise) {
    startPromise = start().catch((error) => {
      status.textContent = error.message;
    });
  }
  return startPromise;
}

async function start() {
  if (!embedded) Object.assign(request, queryRequest);
  if (!validRequest(request)) throw new Error('invalid player parameters');
  if (!window.MediaSource || !window.Hls || !Hls.isSupported()) throw new Error('HLS is not supported');
  hls = new Hls({ loader: WebVpnLoader, xhrSetup: (xhr) => { xhr.withCredentials = true; } });
  const events = Hls.Events || {};
  hls.on(events.ERROR || 'error', (_event, data) => { if (data.fatal) status.textContent = 'Live stream unavailable'; });
  hls.on(events.MEDIA_ATTACHED || 'mediaAttached', (_event, data) => {
    diagnostics.mediaSource = data?.mediaSource || null;
  });
  hls.on(events.MANIFEST_LOADED || 'manifestLoaded', (_event, data) => {
    const httpStatus = data?.networkDetails?.status ?? data?.stats?.httpStatus;
    diagnostics.manifestHttpStatus = Number.isFinite(Number(httpStatus)) ? Number(httpStatus) : null;
  });
  hls.on(events.FRAG_LOADED || 'fragLoaded', () => {
    diagnostics.fragmentCount += 1;
  });
  hls.on(events.MANIFEST_PARSED || 'manifestParsed', async () => {
    diagnostics.manifestParsed = true;
    diagnostics.playAttempted = true;
    try { await video.play?.(); } catch { /* autoplay may be blocked */ }
    status.textContent = 'Live';
  });
  hls.attachMedia(video);
  await loadSourceForView(request.view);
}

if (!embedded) void startIfReady();
