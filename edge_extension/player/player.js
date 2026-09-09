import { toWebVpnUrl } from '../src/webvpn-url.js';

const video = document.getElementById('video');
const status = document.getElementById('status');
const retryButton = document.getElementById('retry');
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
let recoveryAttempts = 0;
let recoveryTimer = null;
let recovering = false;
const MAX_RECOVERY_ATTEMPTS = 3;
const PLAYER_STATES = new Set(['ready', 'playing', 'buffering', 'paused', 'failed', 'login-required', 'ended']);

function setPlayerState(state, message) {
  if (!PLAYER_STATES.has(state)) return;
  const labels = {
    ready: '直播已连接，等待开始播放。', playing: '正在直播', buffering: '正在缓冲…',
    paused: '已暂停，点击视频中的播放按钮继续。', failed: '直播连接失败，请检查网络后重试。',
    'login-required': '登录已失效，请在扩展中完成复旦官方登录后重试。', ended: '本节直播已结束，请刷新课程列表。',
  };
  status.textContent = message || labels[state];
  if (embedded && initialized && challengeNonce) {
    globalThis.parent.postMessage({ type: 'LIVE_PLAYER_STATE', version: 1, nonce: challengeNonce, helloNonce: embeddingNonce, state }, EMBEDDING_ORIGIN);
  }
}

function resetRecovery() {
  if (recoveryTimer !== null) clearTimeout(recoveryTimer);
  recoveryTimer = null;
  recovering = false;
  recoveryAttempts = 0;
  if (retryButton) retryButton.hidden = true;
}

function scheduleRecovery(type = 'networkError') {
  if (recoveryTimer !== null || recovering) return;
  if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
    hls?.stopLoad?.();
    setPlayerState('failed', '已尝试恢复 3 次，请检查网络或重新登录后点击重试。');
    if (retryButton) retryButton.hidden = false;
    return;
  }
  recoveryAttempts += 1;
  setPlayerState('buffering', `连接中断，正在恢复（${recoveryAttempts}/3）…`);
  recoveryTimer = setTimeout(async () => {
    recoveryTimer = null;
    recovering = true;
    let retryAgain = false;
    try {
      if (type === 'mediaError') hls?.recoverMediaError?.();
      else retryAgain = await loadSourceForView(request.view, { recovery: true }) === false;
    } catch (_) { retryAgain = true; }
    finally { recovering = false; }
    if (retryAgain) scheduleRecovery(type);
  }, 1000 * 2 ** (recoveryAttempts - 1));
}

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
        setPlayerState('failed', '课程播放参数无效，请从课程列表重新打开。');
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
  if (!handshake?.ok) throw new Error('无法连接扩展，请刷新页面后重试。');
  const result = await chrome.runtime.sendMessage({
    version: 1,
    type: 'PLAYER_SOURCE',
    payload: { courseId: request.courseId, subId: request.subId, view },
  });
  if (!result?.ok || typeof result.source !== 'string') {
    const error = new Error(result?.state === 'login-required' ? '登录已失效，请在扩展中重新登录后重试。' : result?.state === 'ended' ? '本节直播已结束，请刷新课程列表。' : '无法获取直播，请检查网络后重试。');
    error.state = result?.state;
    throw error;
  }
  return result.source;
}

class WebVpnLoader extends Hls.DefaultConfig.loader {
  load(context, config, callbacks) {
    if (context.url.startsWith('https://icourse.fudan.edu.cn/')) context.url = toWebVpnUrl(context.url);
    return super.load(context, config, callbacks);
  }
}

async function loadSourceForView(view, { recovery = false } = {}) {
  if (!SAFE_VIEWS.has(view)) throw new Error('不支持此播放视角。');
  if (!recovery) resetRecovery();
  const generation = ++loadGeneration;
  if (!recovery) setPlayerState('buffering', '正在连接直播…');
  let source;
  try {
    source = await getSource(view);
  } catch (error) {
    if (generation !== loadGeneration) return;
    status.textContent = error.message;
    setPlayerState(error.state === 'login-required' || error.state === 'ended' ? error.state : 'failed', error.message);
    if (retryButton) retryButton.hidden = false;
    if (error.state === 'login-required' || error.state === 'ended') return;
    if (!recovery) scheduleRecovery();
    return false;
  }
  if (generation !== loadGeneration || !hls) return;
  request.view = view;
  hls.stopLoad?.();
  hls.loadSource(source);
  return true;
}

function startIfReady() {
  if (!initialized) return Promise.resolve();
  if (!startPromise) {
    startPromise = start().catch((error) => {
      status.textContent = error.message;
      setPlayerState('failed', error.message);
      if (retryButton) retryButton.hidden = false;
      startPromise = null;
    });
  }
  return startPromise;
}

async function start() {
  if (!embedded) Object.assign(request, queryRequest);
  if (!validRequest(request)) throw new Error('课程播放参数无效，请从课程列表重新打开。');
  if (!window.MediaSource || !window.Hls || !Hls.isSupported()) throw new Error('当前浏览器不支持直播播放，请使用新版 Chrome 或 Edge。');
  hls = new Hls({ loader: WebVpnLoader, xhrSetup: (xhr) => { xhr.withCredentials = true; } });
  const events = Hls.Events || {};
  hls.on(events.ERROR || 'error', (_event, data) => {
    if (!data?.fatal) return;
    if (data.type === 'networkError' || data.type === 'mediaError') scheduleRecovery(data.type);
    else { setPlayerState('failed', '播放器遇到错误，请点击重试。'); if (retryButton) retryButton.hidden = false; }
  });
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
    setPlayerState('ready');
    try { await video.play?.(); } catch { setPlayerState('paused', '请点击视频中的播放按钮开始直播。'); }
  });
  video.addEventListener('playing', () => { setPlayerState('playing'); if (retryButton) retryButton.hidden = true; });
  video.addEventListener('waiting', () => setPlayerState('buffering'));
  video.addEventListener('pause', () => setPlayerState('paused'));
  video.addEventListener('ended', () => setPlayerState('ended'));
  hls.attachMedia(video);
  await loadSourceForView(request.view);
}

retryButton?.addEventListener('click', async () => {
  resetRecovery();
  if (!hls) await startIfReady();
  else { hls.recoverMediaError?.(); await loadSourceForView(request.view); }
});
globalThis.addEventListener?.('pagehide', () => {
  resetRecovery();
  loadGeneration += 1;
  hls?.destroy?.();
  hls = null;
});

if (!embedded) void startIfReady();
