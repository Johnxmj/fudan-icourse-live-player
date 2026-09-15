import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

import { createHls, nextRecoveryAction } from "../../live_player/web/app.js";

class FakeElement {
  constructor(name) {
    this.name = name;
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.innerHTML = "";
    this.textContent = "";
    this.value = "";
    this.src = "";
    this.pauseCalls = 0;
    this.loadCalls = 0;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
    if (name === "src") {
      this.src = "";
    }
  }

  addEventListener(type, handler) {
    (this.listeners[type] ||= []).push(handler);
  }

  canPlayType() {
    return "";
  }

  load() {
    this.loadCalls += 1;
  }

  play() {
    return Promise.resolve();
  }

  closest() {
    return null;
  }

  pause() {
    this.pauseCalls += 1;
  }

  click() {
    for (const handler of this.listeners.click || []) handler({ target: this, preventDefault() {} });
  }
}

function createJsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "content-type" ? "application/json" : null;
      },
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function createLivePlayerDom({ innerWidth = 1440, videoCanPlayType = "" } = {}) {
  const root = new FakeElement("root");
  const rail = new FakeElement("rail");
  const railList = new FakeElement("rail-list");
  const railToggle = new FakeElement("rail-toggle");
  const refreshButtons = [new FakeElement("refresh-1"), new FakeElement("refresh-2")];
  const fullscreenButton = new FakeElement("fullscreen");
  const connectButton = new FakeElement("connect");
  const baseUrlInput = new FakeElement("base-url");
  const tokenInput = new FakeElement("token");
  const status = new FakeElement("status");
  const courseCount = new FakeElement("course-count");
  const courseTitle = new FakeElement("course-title");
  const courseMeta = new FakeElement("course-meta");
  const courseBadge = new FakeElement("course-badge");
  const video = new FakeElement("video");
  video.canPlayType = () => videoCanPlayType;
  const viewBar = new FakeElement("view-bar");
  const viewHint = new FakeElement("view-hint");
  const connectionHint = new FakeElement("connection-hint");
  const previewLine = new FakeElement("preview-line");
  const transcriptionState = new FakeElement("transcription-state");
  const transcriptionStart = new FakeElement("transcription-start");
  const transcriptionStop = new FakeElement("transcription-stop");
  const transcriptionExport = new FakeElement("transcription-export");
  const transcriptionClear = new FakeElement("transcription-clear");
  const transcriptionStatus = new FakeElement("transcription-status");
  const transcriptionAlert = new FakeElement("transcription-alert");
  const transcriptionLines = new FakeElement("transcription-lines");
  const transcriptionModel = new FakeElement("transcription-model");
  const transcriptionLanguage = new FakeElement("transcription-language");
  const transcriptionKeywords = new FakeElement("transcription-keywords");
  const transcriptionPage = new FakeElement("transcription-page");
  const transcriptionSound = new FakeElement("transcription-sound");
  const transcriptionSystem = new FakeElement("transcription-system");
  const stage = new FakeElement("stage");

  const bySelector = {
    "[data-rail]": rail,
    "[data-rail-list]": railList,
    "[data-rail-toggle]": railToggle,
    "[data-fullscreen]": fullscreenButton,
    "[data-connect]": connectButton,
    "[data-base-url]": baseUrlInput,
    "[data-token]": tokenInput,
    "[data-status]": status,
    "[data-course-count]": courseCount,
    "[data-course-title]": courseTitle,
    "[data-course-meta]": courseMeta,
    "[data-course-badge]": courseBadge,
    "[data-video]": video,
    "[data-view-bar]": viewBar,
    "[data-view-hint]": viewHint,
    "[data-connection-hint]": connectionHint,
    "[data-preview-line]": previewLine,
    "[data-transcription-state]": transcriptionState,
    "[data-transcription-start]": transcriptionStart,
    "[data-transcription-stop]": transcriptionStop,
    "[data-transcription-export]": transcriptionExport,
    "[data-transcription-clear]": transcriptionClear,
    "[data-transcription-status]": transcriptionStatus,
    "[data-transcription-alert]": transcriptionAlert,
    "[data-transcription-lines]": transcriptionLines,
    "[data-transcription-model]": transcriptionModel,
    "[data-transcription-language]": transcriptionLanguage,
    "[data-transcription-keywords]": transcriptionKeywords,
    "[data-transcription-page]": transcriptionPage,
    "[data-transcription-sound]": transcriptionSound,
    "[data-transcription-system]": transcriptionSystem,
    "[data-stage]": stage,
  };

  root.dataset = {};
  root.querySelector = (selector) => bySelector[selector] || null;
  root.querySelectorAll = (selector) => (selector === "[data-refresh]" ? refreshButtons : []);
  root.setAttribute = FakeElement.prototype.setAttribute;
  root.getAttribute = FakeElement.prototype.getAttribute;
  root.removeAttribute = FakeElement.prototype.removeAttribute;

  const doc = {
    body: root,
    documentElement: new FakeElement("documentElement"),
    fullscreenElement: null,
    querySelector(selector) {
      return selector === "[data-live-player-root]" ? root : null;
    },
    exitFullscreen() {
      return Promise.resolve();
    },
  };

  const win = {
    innerWidth,
    location: { origin: "http://127.0.0.1:8000" },
    localStorage: null,
    fetch: undefined,
  };

  return {
    doc,
    win,
    root,
    elements: {
      rail,
      railList,
      railToggle,
      refreshButtons,
      fullscreenButton,
      connectButton,
      baseUrlInput,
      tokenInput,
      status,
      courseCount,
      courseTitle,
      courseMeta,
      courseBadge,
      video,
      viewBar,
      viewHint,
      connectionHint,
      previewLine,
      transcriptionState,
      transcriptionStart,
      transcriptionStop,
      transcriptionExport,
      transcriptionClear,
      transcriptionStatus,
      transcriptionAlert,
      transcriptionLines,
      transcriptionModel,
      transcriptionLanguage,
      transcriptionKeywords,
      transcriptionPage,
      transcriptionSound,
      transcriptionSystem,
      stage,
    },
  };
}

function createLocation(url) {
  const parsed = new URL(url);
  return {
    href: parsed.href,
    origin: parsed.origin,
    pathname: parsed.pathname,
    search: parsed.search,
    historyCalls: [],
    replaceState(state, title, nextUrl) {
      this.historyCalls.push({ state, title, nextUrl });
      const next = new URL(nextUrl, this.href);
      this.href = next.href;
      this.origin = next.origin;
      this.pathname = next.pathname;
      this.search = next.search;
    },
  };
}

function createFetchSequence(responses) {
  const calls = [];
  let index = 0;
  return {
    calls,
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return typeof response === "function" ? response(url, init) : response;
    },
  };
}

function createStorage(seed = {}) {
  const entries = new Map(Object.entries(seed));
  const reads = [];
  const writes = [];
  const removals = [];
  return {
    reads,
    writes,
    removals,
    getItem(key) {
      reads.push(key);
      return entries.has(key) ? entries.get(key) : null;
    },
    setItem(key, value) {
      writes.push([key, String(value)]);
      entries.set(key, String(value));
    },
    removeItem(key) {
      removals.push(key);
      entries.delete(key);
    },
  };
}

class FakeHls {
  static instances = [];
  static Events = { ERROR: "error", MANIFEST_PARSED: "manifestParsed" };
  static ErrorTypes = { MEDIA_ERROR: "mediaError" };

  static isSupported() {
    return true;
  }

  constructor(config) {
    this.config = config;
    this.handlers = {};
    this.sources = [];
    FakeHls.instances.push(this);
  }

  on(event, handler) {
    this.handlers[event] = handler;
  }

  attachMedia() {}

  loadSource(source) {
    this.sources.push(source);
  }

  destroy() {}

  recoverMediaError() {}

  emitFatal(data) {
    return this.handlers.error?.({}, data);
  }
}

async function waitFor(predicate, message, attempts = 20) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(predicate(), message);
}

test("refreshes source after repeated fragment failures", () => {
  assert.equal(
    nextRecoveryAction({ fragmentFailures: 3, sessionExpired: false }),
    "refresh-source",
  );
});

test("transcription starts only after the explicit button click", async () => {
  const course = {
    course_id: "37142", sub_id: "659200", course_title: "课程", media_token: "media-token", available_views: ["teacher"],
  };
  const requests = createFetchSequence([
    createJsonResponse(200, [course]),
    createJsonResponse(200, { available: true }),
    createJsonResponse(200, { session_id: "tx-1" }),
  ]);
  const { doc, win, elements } = createLivePlayerDom();
  const { mountLivePlayerApp } = await import("../../live_player/web/app.js");
  mountLivePlayerApp({ document: doc, window: win, Hls: FakeHls, fetchImpl: requests.fetch, token: "session-token" });

  await waitFor(() => requests.calls.some((call) => call.url.endsWith("/api/live-courses")), "expected catalog load");
  assert.equal(requests.calls.some((call) => call.url.endsWith("/api/transcription/start")), false);
  elements.transcriptionStart.click();
  await waitFor(() => requests.calls.some((call) => call.url.endsWith("/api/transcription/start")), "expected explicit transcription start");
  const start = requests.calls.find((call) => call.url.endsWith("/api/transcription/start"));
  assert.deepEqual(JSON.parse(start.init.body), { course_id: "37142", sub_id: "659200", model: "base", language: "zh" });
});

test("transcription UI renders safe model download progress from the SSE state", async () => {
  const course = { course_id: "37142", sub_id: "659200", course_title: "课程", media_token: "media-token", available_views: ["teacher"] };
  const encoder = new TextEncoder();
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/live-courses") return createJsonResponse(200, [course]);
    if (path === "/api/transcription/capabilities") return createJsonResponse(200, { available: true });
    if (path === "/api/transcription/start") return createJsonResponse(200, { session_id: "tx-progress" });
    if (path === "/api/transcription/events/tx-progress") return {
      ok: true, status: 200,
      headers: { get: () => "text/event-stream" },
      body: new ReadableStream({ start(controller) {
        controller.enqueue(encoder.encode("event: transcript\ndata: {\"type\":\"state\",\"state\":\"downloading-model\",\"progress\":42,\"url\":\"https://model.invalid/private\"}\n\n"));
        controller.close();
      } }),
    };
    throw new Error(`unexpected request ${path}`);
  };
  const { doc, win, elements } = createLivePlayerDom();
  const { mountLivePlayerApp } = await import("../../live_player/web/app.js");
  mountLivePlayerApp({ document: doc, window: win, Hls: FakeHls, fetchImpl, token: "session-token" });

  await waitFor(() => elements.transcriptionStart.disabled === false, "expected available transcription control");
  elements.transcriptionStart.click();
  await waitFor(() => /下载模型 42%/.test(elements.transcriptionState.textContent), "expected visible download percentage");
  assert.match(elements.transcriptionStatus.textContent, /下载.*42%/);
});

test("loopback transcription UI smoke uses the real page transport and SSE fixture", async () => {
  const course = {
    course_id: "37142", sub_id: "659200", course_title: "离线演示课", media_token: "local-only", available_views: ["teacher"],
  };
  const transcriptEvents = [
    { type: "state", state: "listening" },
    { type: "segment", start: 1, end: 2, text: "请大家签到" },
    { type: "segment", start: 3, end: 4, text: "再次签到" },
    { type: "ended", state: "stopped" },
  ].map((record) => `event: transcript\ndata: ${JSON.stringify(record)}\n\n`).join("");
  const calls = [];
  let starts = 0;
  let secondStreamCancelled = false;
  const fixtureServer = createServer(async (request, response) => {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const url = new URL(request.url, "http://127.0.0.1");
    calls.push({ method: request.method, url: url.pathname, body: Buffer.concat(body).toString("utf8") });
    const sendJson = (status, payload) => {
      const encoded = JSON.stringify(payload);
      response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) });
      response.end(encoded);
    };
    if (request.method === "GET" && url.pathname === "/") {
      const html = readFileSync("live_player/web/index.html");
      response.writeHead(200, { "content-type": "text/html", "content-length": html.length });
      response.end(html);
    } else if (request.method === "GET" && url.pathname === "/app.js") {
      const source = readFileSync("live_player/web/app.js");
      response.writeHead(200, { "content-type": "text/javascript", "content-length": source.length });
      response.end(source);
    } else if (request.method === "GET" && url.pathname === "/api/live-courses") {
      sendJson(200, [course]);
    } else if (request.method === "GET" && url.pathname === "/api/transcription/capabilities") {
      sendJson(200, { available: true });
    } else if (request.method === "POST" && url.pathname === "/api/transcription/start") {
      sendJson(200, { session_id: `tx-${++starts}` });
    } else if (request.method === "POST" && url.pathname === "/api/transcription/stop") {
      sendJson(200, {});
    } else if (request.method === "GET" && url.pathname === "/api/transcription/events/tx-1") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      response.end(transcriptEvents);
    } else if (request.method === "GET" && url.pathname === "/api/transcription/events/tx-2") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      request.on("aborted", () => { secondStreamCancelled = true; });
      response.on("close", () => { if (!response.writableEnded) secondStreamCancelled = true; });
    } else {
      sendJson(404, { error: { message: `unexpected fixture request: ${request.method} ${url.pathname}` } });
    }
  });
  await new Promise((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
  const { port } = fixtureServer.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const realFetch = globalThis.fetch;
  const fetchCalls = [];
  const guardedFetch = async (url, init) => {
    const parsed = new URL(url);
    fetchCalls.push(parsed.href);
    if (parsed.hostname !== "127.0.0.1") throw new Error(`non-loopback request: ${parsed.href}`);
    return realFetch(url, init);
  };
  const { doc, win, elements } = createLivePlayerDom();
  win.location.origin = baseUrl;
  win.fetch = guardedFetch;
  const originalDocument = globalThis.document;
  const originalUrl = globalThis.URL;
  let exportedBlob = null;
  const clicks = [];
  class ExportUrl extends originalUrl {
    static createObjectURL(blob) { exportedBlob = blob; return "blob:offline-smoke"; }
    static revokeObjectURL() {}
  }
  globalThis.URL = ExportUrl;
  globalThis.document = { createElement() { return { click() { clicks.push(this); } }; } };
  try {
    const page = await guardedFetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<script type="module">[\s\S]*import \{ mountLivePlayerApp \} from "\.\/app\.js"/);
    const appModule = await guardedFetch(`${baseUrl}/app.js`);
    assert.equal(appModule.status, 200);
    assert.match(await appModule.text(), /mountLivePlayerApp/);
    const { mountLivePlayerApp } = await import("../../live_player/web/app.js");
    const app = mountLivePlayerApp({ document: doc, window: win, Hls: FakeHls, baseUrl, token: "offline-session" });
    await waitFor(() => calls.some((call) => call.url === "/api/live-courses"), "fixture should load the catalog");
    await app.connect();
    await waitFor(() => elements.transcriptionStart.disabled === false, "offline fixture should expose manual transcription start");
    elements.transcriptionStart.click();
    await waitFor(() => elements.transcriptionState.textContent === "已停止", "fixture should render the ended state");
    assert.match(elements.transcriptionLines.innerHTML, /请大家签到/);
    assert.equal((elements.transcriptionLines.innerHTML.match(/is-alert/g) || []).length, 1, "签到 cooldown should suppress only the repeated highlight");
    assert.equal(elements.transcriptionAlert.hidden, false);
    assert.match(elements.transcriptionAlert.innerHTML, /签到/);
    assert.equal(elements.transcriptionExport.disabled, false);
    elements.transcriptionExport.click();
    assert.equal(clicks.length, 1);
    assert.match(await exportedBlob.text(), /请大家签到/);
    assert.match(await exportedBlob.text(), /再次签到/);

    elements.transcriptionStart.click();
    await waitFor(() => calls.some((call) => call.url.endsWith("/api/transcription/events/tx-2")), "second manual start should open the fixture stream");
    elements.transcriptionStop.click();
    await waitFor(() => secondStreamCancelled, "manual stop should abort the fake stream");
    await waitFor(() => calls.filter((call) => call.url === "/api/transcription/stop").length === 1, "manual stop should reach the fixture server");
    assert.equal(calls.filter((call) => call.url === "/api/transcription/stop").length, 1);
    assert.ok(fetchCalls.every((url) => new URL(url).hostname === "127.0.0.1"), "offline fixture must not contact Fudan");
    assert.equal(fetchCalls.some((url) => url.includes("model")), false, "UI smoke must not load a model");
  } finally {
    globalThis.URL = originalUrl;
    globalThis.document = originalDocument;
    fixtureServer.close();
    fixtureServer.closeAllConnections?.();
  }
});

test("transcription start stays disabled when the local helper lacks the capability", async () => {
  const course = { course_id: "37142", sub_id: "659200", course_title: "课程", media_token: "media-token", available_views: ["teacher"] };
  const requests = createFetchSequence([createJsonResponse(200, [course]), createJsonResponse(200, { available: false })]);
  const { doc, win, elements } = createLivePlayerDom();
  const { mountLivePlayerApp } = await import("../../live_player/web/app.js");
  mountLivePlayerApp({ document: doc, window: win, Hls: FakeHls, fetchImpl: requests.fetch, token: "session-token" });

  await waitFor(() => requests.calls.some((call) => call.url.endsWith("/api/transcription/capabilities")), "expected capability probe");
  assert.equal(elements.transcriptionStart.disabled, true);
  assert.match(elements.transcriptionStatus.textContent, /支持转录的本地助手/);
});

test("changing courses cancels a late transcription start before it opens a stream", async () => {
  const oldCourse = { course_id: "old", sub_id: "one", course_title: "旧课程", media_token: "media-old", available_views: ["teacher"] };
  const newCourse = { course_id: "new", sub_id: "two", course_title: "新课程", media_token: "media-new", available_views: ["teacher"] };
  const calls = [];
  let resolveStart;
  const fetchImpl = (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/api/live-courses")) return Promise.resolve(createJsonResponse(200, [oldCourse, newCourse]));
    if (url.endsWith("/api/transcription/capabilities")) return Promise.resolve(createJsonResponse(200, { available: true }));
    if (url.endsWith("/api/transcription/start")) return new Promise(resolve => { resolveStart = resolve; });
    if (url.endsWith("/api/transcription/stop")) return Promise.resolve(createJsonResponse(200, {}));
    return Promise.resolve(createJsonResponse(200, {}));
  };
  const { doc, win, elements } = createLivePlayerDom();
  const { mountLivePlayerApp } = await import("../../live_player/web/app.js");
  const app = mountLivePlayerApp({ document: doc, window: win, fetchImpl, token: "session-token" });
  await waitFor(() => calls.some(call => call.url.endsWith("/api/transcription/capabilities")), "expected capability probe");
  elements.transcriptionStart.click();
  await waitFor(() => typeof resolveStart === "function", "expected transcription start request");
  app.selectCourse("new");
  resolveStart(createJsonResponse(200, { session_id: "tx-late" }));
  await waitFor(() => calls.some(call => call.url.endsWith("/api/transcription/stop")), "expected late session stop");

  const stop = calls.find(call => call.url.endsWith("/api/transcription/stop"));
  assert.deepEqual(JSON.parse(stop.init.body), { session_id: "tx-late" });
  assert.equal(calls.some(call => call.url.includes("/api/transcription/events/")), false);
  assert.equal(app.state.activeCourse.course_id, "new");
  assert.equal(elements.transcriptionExport.disabled, true);
});

test("requires login when session has expired", () => {
  assert.equal(nextRecoveryAction({ fragmentFailures: 0, sessionExpired: true }), "login-required");
});

test("creates HLS with a short live sync window", () => {
  let capturedConfig = null;
  const events = [];

  class FakeHls {
    static Events = { ERROR: "error" };

    constructor(config) {
      capturedConfig = config;
      this.handlers = [];
    }

    on(event, handler) {
      this.handlers.push({ event, handler });
    }
  }

  const hls = createHls(FakeHls, (data) => events.push(data));

  assert.equal(capturedConfig.liveSyncDurationCount, 2);
  assert.equal(typeof hls.on, "function");
  assert.equal(events.length, 0);
});

test("threads the session bearer into HLS requests", async () => {
  FakeHls.instances = [];
  const course = {
    course_id: "1001",
    sub_id: "s1",
    course_title: "Course",
    media_token: "media-token",
    available_views: ["teacher"],
  };
  const transport = createFetchSequence([createJsonResponse(200, [course])]);
  const { doc, win, elements } = createLivePlayerDom();
  elements.baseUrlInput.value = "http://127.0.0.1:4310";

  const { mountLivePlayerApp } = await import("../../live_player/web/app.js");
  const api = mountLivePlayerApp({
    document: doc,
    window: win,
    fetchImpl: transport.fetch,
    Hls: FakeHls,
    token: "session-token",
  });

  await waitFor(
    () => FakeHls.instances.length === 1,
    "expected the app to create an HLS instance after booting with a session token",
  );

  const headers = [];
  FakeHls.instances[0].config.xhrSetup({
    setRequestHeader(name, value) {
      headers.push([name, value]);
    },
  });

  assert.equal(api.state.token, "session-token");
  assert.deepEqual(headers, [["Authorization", "Bearer session-token"]]);
});

test("uses native HLS playback when Hls.js is unavailable", async () => {
  FakeHls.instances = [];
  const originalIsSupported = FakeHls.isSupported;
  FakeHls.isSupported = () => false;
  try {
    const course = {
      course_id: "1001",
      sub_id: "s1",
      course_title: "Course",
      media_token: "media-token",
      available_views: ["teacher"],
    };
    const transport = createFetchSequence([createJsonResponse(200, [course])]);
    const { doc, win, elements } = createLivePlayerDom({ videoCanPlayType: "probably" });
    elements.baseUrlInput.value = "http://127.0.0.1:4310";

    const { mountLivePlayerApp } = await import("../../live_player/web/app.js");
    const api = mountLivePlayerApp({
      document: doc,
      window: win,
      fetchImpl: transport.fetch,
      Hls: FakeHls,
      token: "session-token",
      baseUrl: "http://127.0.0.1:4310",
    });

    await waitFor(
      () => elements.video.src.includes("/media/1001/s1/teacher/manifest.m3u8"),
      "expected the app to use the native media URL when Hls.js is unavailable",
    );

    assert.equal(FakeHls.instances.length, 0);
    assert.equal(api.state.statusText, "已准备好播放 Course，如未开始请点击播放按钮。");
    assert.equal(elements.video.src, "http://127.0.0.1:4310/media/1001/s1/teacher/manifest.m3u8?media_token=media-token");
  } finally {
    FakeHls.isSupported = originalIsSupported;
  }
});

test("keeps the one-refresh budget after reloading playback", async () => {
  FakeHls.instances = [];
  const course = {
    course_id: "1001",
    sub_id: "s1",
    course_title: "Course",
    media_token: "media-token",
    available_views: ["teacher"],
  };
  const transport = createFetchSequence([
    createJsonResponse(200, [course]),
    createJsonResponse(200, [course]),
  ]);
  const { doc, win, elements } = createLivePlayerDom();
  elements.baseUrlInput.value = "http://127.0.0.1:4310";
  elements.tokenInput.value = "session-token";

  const { mountLivePlayerApp } = await import("../../live_player/web/app.js");
  const api = mountLivePlayerApp({
    document: doc,
    window: win,
    fetchImpl: transport.fetch,
    Hls: FakeHls,
  });

  await api.connect();
  assert.equal(FakeHls.instances.length, 1);

  await FakeHls.instances[0].emitFatal({ fatal: true, details: "fragLoadError" });
  await FakeHls.instances[0].emitFatal({ fatal: true, details: "fragLoadError" });
  await FakeHls.instances[0].emitFatal({ fatal: true, details: "fragLoadError" });

  await waitFor(
    () =>
      transport.calls.filter((call) => call.url.endsWith("/api/live-courses")).length === 2 &&
      FakeHls.instances.length === 2 &&
      api.state.recovery.refreshAttempts === 1,
    "expected one complete recovery cycle after the first fatal playback sequence",
  );
  assert.equal(api.state.recovery.refreshAttempts, 1);
  assert.equal(FakeHls.instances.length, 2);
});

test("redeems bootstrap tokens from the URL before loading courses", async () => {
  FakeHls.instances = [];
  const course = {
    course_id: "1001",
    sub_id: "s1",
    course_title: "Course",
    media_token: "media-token",
    available_views: ["teacher"],
  };
  const transport = createFetchSequence([
    createJsonResponse(200, { token: "session-token" }),
    createJsonResponse(200, [course]),
  ]);
  const { doc, win, elements } = createLivePlayerDom();
  win.location = createLocation("http://127.0.0.1:4310/?bootstrap=bootstrap-token");
  win.history = { replaceState: win.location.replaceState.bind(win.location) };
  const storage = createStorage({
    "live-player.base-url": "http://evil.invalid",
    "live-player.token": "stale-token",
  });

  const { mountLivePlayerApp } = await import("../../live_player/web/app.js");
  const api = mountLivePlayerApp({
    document: doc,
    window: win,
    storage,
    fetchImpl: transport.fetch,
    Hls: FakeHls,
    baseUrl: "http://127.0.0.1:4310",
  });

  await waitFor(
    () => transport.calls.length >= 2 && api.state.token === "session-token",
    "expected the bootstrap token to be exchanged before the catalog request",
  );

  assert.equal(transport.calls[0].url, "http://127.0.0.1:4310/api/session");
  assert.equal(transport.calls[0].init.method, "POST");
  assert.equal(transport.calls[0].init.headers["Content-Type"], "application/json");
  assert.equal(JSON.parse(transport.calls[0].init.body).bootstrap_token, "bootstrap-token");
  assert.equal(transport.calls[1].url, "http://127.0.0.1:4310/api/live-courses");
  assert.equal(transport.calls[1].init.headers.Authorization, "Bearer session-token");
  assert.ok(FakeHls.instances[0].sources[0].includes("media_token=media-token"));
  assert.equal(api.state.token, "session-token");
  assert.equal(elements.tokenInput.value, "session-token");
  assert.equal(win.location.search, "");
  assert.equal(win.location.historyCalls.length, 1);
  assert.ok(!win.location.historyCalls[0].nextUrl.includes("bootstrap="));
  assert.equal(api.state.baseUrl, "http://127.0.0.1:4310");
  assert.ok(!storage.reads.includes("live-player.base-url"));
  assert.ok(!storage.reads.includes("live-player.token"));
  assert.ok(!storage.writes.some(([key]) => key === "live-player.base-url" || key === "live-player.token"));
});

test("falls back to manual sign-in when bootstrap redemption fails", async () => {
  FakeHls.instances = [];
  const transport = createFetchSequence([
    createJsonResponse(401, { error: { message: "bootstrap rejected" } }),
  ]);
  const { doc, win, elements } = createLivePlayerDom();
  win.location = createLocation("http://127.0.0.1:8000/?bootstrap=bootstrap-token");
  win.history = { replaceState: win.location.replaceState.bind(win.location) };

  const { mountLivePlayerApp } = await import("../../live_player/web/app.js");
  const api = mountLivePlayerApp({
    document: doc,
    window: win,
    fetchImpl: transport.fetch,
    Hls: FakeHls,
    baseUrl: "http://127.0.0.1:4310",
  });

  await waitFor(
    () => api.state.statusTone === "danger" && api.state.statusText.includes("自动连接失败"),
    "expected the app to surface a manual-sign-in error when bootstrap redemption is rejected",
  );

  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].url, "http://127.0.0.1:8000/api/session");
  assert.equal(elements.tokenInput.value, "");
  assert.equal(api.state.token, "");
  assert.equal(win.location.search, "");
  assert.equal(win.location.historyCalls.length, 1);
  assert.ok(elements.status.textContent.includes("自动连接失败"));
  assert.ok(!elements.status.textContent.includes("bootstrap rejected"));
});

test("picks the loopback origin for bootstrap redemption instead of persisted base URLs", async () => {
  FakeHls.instances = [];
  const transport = createFetchSequence([
    createJsonResponse(200, { token: "session-token" }),
    createJsonResponse(200, []),
  ]);
  const { doc, win } = createLivePlayerDom();
  win.location = createLocation("http://127.0.0.1:4321/?bootstrap=bootstrap-token");
  win.history = { replaceState: win.location.replaceState.bind(win.location) };
  const storage = createStorage({
    "live-player.base-url": "http://evil.invalid",
    "live-player.token": "stale-token",
  });

  const { mountLivePlayerApp } = await import("../../live_player/web/app.js");
  mountLivePlayerApp({
    document: doc,
    window: win,
    storage,
    fetchImpl: transport.fetch,
    Hls: FakeHls,
    baseUrl: "http://evil.invalid",
  });

  await waitFor(
    () => transport.calls.length >= 1,
    "expected bootstrap redemption to start immediately",
  );

  assert.equal(transport.calls[0].url, "http://127.0.0.1:4321/api/session");
  assert.equal(win.location.origin, "http://127.0.0.1:4321");
  assert.ok(!storage.reads.includes("live-player.base-url"));
  assert.ok(!storage.reads.includes("live-player.token"));
});

test("clears stale stored token after bootstrap redemption fails", async () => {
  FakeHls.instances = [];
  const storage = createStorage({
    "live-player.token": "stale-token",
  });
  const transport = createFetchSequence([
    createJsonResponse(401, { error: { message: "bootstrap rejected" } }),
  ]);
  const { doc, win, elements } = createLivePlayerDom();
  win.location = createLocation("http://127.0.0.1:8000/?bootstrap=bootstrap-token");
  win.history = { replaceState: win.location.replaceState.bind(win.location) };

  const { mountLivePlayerApp } = await import("../../live_player/web/app.js");
  const api = mountLivePlayerApp({
    document: doc,
    window: win,
    storage,
    fetchImpl: transport.fetch,
    Hls: FakeHls,
    baseUrl: "http://127.0.0.1:4310",
  });

  await waitFor(
    () => api.state.statusTone === "danger" && api.state.statusText.includes("自动连接失败"),
    "expected the app to surface a manual-sign-in error when bootstrap redemption is rejected",
  );

  assert.equal(elements.tokenInput.value, "");
  assert.equal(api.state.token, "");
  assert.equal(elements.connectionHint.textContent, "请通过本地播放器启动入口打开此页面，即可自动连接。");
  assert.ok(!storage.reads.includes("live-player.token"));
  assert.ok(!storage.writes.some(([key]) => key === "live-player.token"));
});

test("keeps the redeemed session token when the live catalog fails after bootstrap", async () => {
  FakeHls.instances = [];
  const transport = createFetchSequence([
    createJsonResponse(200, { token: "session-token" }),
    createJsonResponse(500, { error: { message: "catalog unavailable" } }),
  ]);
  const { doc, win, elements } = createLivePlayerDom();
  win.location = createLocation("http://127.0.0.1:8000/?bootstrap=bootstrap-token");
  win.history = { replaceState: win.location.replaceState.bind(win.location) };

  const { mountLivePlayerApp } = await import("../../live_player/web/app.js");
  const api = mountLivePlayerApp({
    document: doc,
    window: win,
    fetchImpl: transport.fetch,
    Hls: FakeHls,
    baseUrl: "http://127.0.0.1:4310",
  });

  await waitFor(
    () => api.state.statusTone === "danger" && api.state.statusText.includes("暂时无法获取直播"),
    "expected the app to surface the catalog failure after bootstrap succeeds",
  );

  assert.equal(transport.calls.length, 3);
  assert.equal(api.state.token, "session-token");
  assert.equal(elements.tokenInput.value, "session-token");
  assert.equal(elements.connectionHint.textContent, "已连接本地播放器。");
});

test("clears stale playback when the live catalog becomes empty", async () => {
  FakeHls.instances = [];
  const course = {
    course_id: "1001",
    sub_id: "s1",
    course_title: "Course",
    media_token: "media-token",
    available_views: ["teacher"],
  };
  const transport = createFetchSequence([
    createJsonResponse(200, [course]),
    createJsonResponse(200, []),
  ]);
  const { doc, win, elements } = createLivePlayerDom();
  elements.baseUrlInput.value = "http://127.0.0.1:4310";
  elements.tokenInput.value = "session-token";

  const { mountLivePlayerApp } = await import("../../live_player/web/app.js");
  const api = mountLivePlayerApp({
    document: doc,
    window: win,
    fetchImpl: transport.fetch,
    Hls: FakeHls,
  });

  await api.connect();
  elements.video.src = "blob:stale-stream";
  elements.video.attributes.src = "blob:stale-stream";
  const pauseCallsBeforeRefresh = elements.video.pauseCalls;
  const loadCallsBeforeRefresh = elements.video.loadCalls;

  await api.refresh();

  assert.equal(elements.video.src, "");
  assert.equal(elements.video.getAttribute("src"), null);
  assert.equal(elements.video.pauseCalls, pauseCallsBeforeRefresh + 1);
  assert.equal(elements.video.loadCalls, loadCallsBeforeRefresh + 1);
  assert.equal(FakeHls.instances.length, 1);
});

test("leaves the desktop rail visible to screen readers", async () => {
  const { doc, win, elements } = createLivePlayerDom({ innerWidth: 1440 });
  elements.tokenInput.value = "";

  const { mountLivePlayerApp } = await import("../../live_player/web/app.js");
  mountLivePlayerApp({
    document: doc,
    window: win,
    fetchImpl: async () => {
      throw new Error("fetch not expected");
    },
    Hls: FakeHls,
  });

  assert.equal(elements.rail.getAttribute("aria-hidden"), null);
});

test("redeems fragment bootstrap and removes it before the first request", async () => {
  const { doc, win } = createLivePlayerDom();
  const location = new URL("http://127.0.0.1:4310/#bootstrap=fragment-secret");
  win.location = location;
  win.history = { replaceState(_state, _title, next) { location.href = new URL(next, location).href; } };
  const calls = [];
  const { mountLivePlayerApp } = await import("../../live_player/web/app.js");
  const api = mountLivePlayerApp({ document: doc, window: win, Hls: FakeHls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(location.hash, "");
      return createJsonResponse(200, url.endsWith("/api/session") ? { token: "session-token" } : []);
    },
  });
  await waitFor(() => calls.length >= 2, "fragment pairing should load the catalog");
  assert.equal(api.state.token, "session-token");
});

test("media authorization failure refreshes the short-lived media token without logging out", async () => {
  FakeHls.instances = [];
  const course = { course_id: "1001", sub_id: "s1", course_title: "课", media_token: "old-media", available_views: ["teacher"] };
  const requests = createFetchSequence([createJsonResponse(200, [course]), createJsonResponse(200, [{ ...course, media_token: "fresh-media" }])]);
  const { doc, win } = createLivePlayerDom();
  const { mountLivePlayerApp } = await import("../../live_player/web/app.js");
  const api = mountLivePlayerApp({ document: doc, window: win, Hls: FakeHls, fetchImpl: requests.fetch, token: "session-token" });
  await waitFor(() => FakeHls.instances.length === 1, "initial playback");
  await FakeHls.instances[0].emitFatal({ fatal: true, response: { code: 401 }, details: "manifestLoadError" });
  assert.equal(requests.calls.length, 3);
  assert.equal(api.state.recovery.sessionExpired, false);
  assert.match(FakeHls.instances.at(-1).sources[0], /fresh-media/);
  await FakeHls.instances.at(-1).emitFatal({ fatal: true, response: { code: 401 }, details: "manifestLoadError" });
  assert.equal(requests.calls.length, 3, "auth recovery must be bounded");
});

test("catalog authorization failure clears stale playback and requires reconnecting", async () => {
  FakeHls.instances = [];
  const course = { course_id: "1001", sub_id: "s1", media_token: "media", available_views: ["teacher"] };
  const requests = createFetchSequence([createJsonResponse(200, [course]), createJsonResponse(401, { error: { code: "LOGIN_REQUIRED" } })]);
  const { doc, win, elements } = createLivePlayerDom();
  const { mountLivePlayerApp } = await import("../../live_player/web/app.js");
  const api = mountLivePlayerApp({ document: doc, window: win, Hls: FakeHls, fetchImpl: requests.fetch, token: "session-token" });
  await waitFor(() => FakeHls.instances.length === 1, "initial playback");
  elements.video.src = "blob:old";
  await api.refresh();
  assert.equal(api.state.recovery.sessionExpired, true);
  assert.equal(elements.video.src, "");
});

test("Chinese view labels preserve playable view identifiers", async () => {
  FakeHls.instances = [];
  const { doc, win, elements } = createLivePlayerDom();
  const course = { course_id: "1001", sub_id: "s1", media_token: "media", available_views: ["teacher", "student_audio"] };
  const { mountLivePlayerApp } = await import("../../live_player/web/app.js");
  mountLivePlayerApp({ document: doc, window: win, Hls: FakeHls, token: "session", fetchImpl: async () => createJsonResponse(200, [course]) });
  await waitFor(() => FakeHls.instances.length === 1, "initial playback");
  assert.match(elements.viewBar.innerHTML, /data-view="student_audio"[^>]*>\s*学生音频/);
  elements.viewBar.listeners.click[0]({ target: { closest: () => ({ dataset: { view: "student_audio" } }) } });
  assert.match(FakeHls.instances.at(-1).sources[0], /\/student_audio\/manifest/);
});
