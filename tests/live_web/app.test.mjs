import test from "node:test";
import assert from "node:assert/strict";

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
    assert.equal(api.state.statusText, "Playing Course using the browser's native HLS support.");
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
    () => transport.calls.length === 2 && api.state.token === "session-token",
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
    () => api.state.statusTone === "danger" && api.state.statusText.includes("Automatic sign-in failed"),
    "expected the app to surface a manual-sign-in error when bootstrap redemption is rejected",
  );

  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].url, "http://127.0.0.1:8000/api/session");
  assert.equal(elements.tokenInput.value, "");
  assert.equal(api.state.token, "");
  assert.equal(win.location.search, "");
  assert.equal(win.location.historyCalls.length, 1);
  assert.ok(elements.status.textContent.includes("Automatic sign-in failed"));
  assert.ok(elements.status.textContent.includes("bootstrap rejected"));
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
    () => api.state.statusTone === "danger" && api.state.statusText.includes("Automatic sign-in failed"),
    "expected the app to surface a manual-sign-in error when bootstrap redemption is rejected",
  );

  assert.equal(elements.tokenInput.value, "");
  assert.equal(api.state.token, "");
  assert.equal(elements.connectionHint.textContent, "Paste a session token to connect.");
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
    () => api.state.statusTone === "danger" && api.state.statusText.includes("catalog unavailable"),
    "expected the app to surface the catalog failure after bootstrap succeeds",
  );

  assert.equal(transport.calls.length, 2);
  assert.equal(api.state.token, "session-token");
  assert.equal(elements.tokenInput.value, "session-token");
  assert.equal(elements.connectionHint.textContent, "Connected to the local player API.");
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
