import test from "node:test";
import assert from "node:assert/strict";
import { createExtensionTransport } from "../../frontend/live/transports/extension.js";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

function makeDom() {
  const listeners = new Set();
  globalThis.addEventListener = (type, fn) => type === "message" && listeners.add(fn);
  globalThis.removeEventListener = (type, fn) => type === "message" && listeners.delete(fn);
  const messages = [];
  const frame = {
    contentWindow: {
      postMessage(message, targetOrigin) {
        messages.push({ message, targetOrigin });
      },
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
  };
  const container = { replaceChildren(node) { this.child = node; }, ownerDocument: {
    createElement() { return frame; },
  } };
  return {
    container,
    frame,
    messages,
    dispatchMessage(event) { for (const fn of listeners) fn(event); },
  };
}

test("mount performs a challenge exchange and initializes the real player", () => {
  const dom = makeDom();
  const runtime = { sendMessage: async () => ({}) };
  const transport = createExtensionTransport({ extensionId: EXTENSION_ID, runtime, windowRef: globalThis });
  const mounted = transport.mountPlayer(dom.container, { course_id: "c1", sub_id: "s1" }, "student");
  dom.dispatchMessage({
    origin: `chrome-extension://${EXTENSION_ID}`,
    source: dom.frame.contentWindow,
    data: { type: "LIVE_PLAYER_HELLO", nonce: "iframe-nonce", version: 1 },
  });
  assert.deepEqual(dom.messages.at(-1), {
    message: {
      type: "PLAYER_CHALLENGE",
      nonce: mounted.nonce,
      helloNonce: "iframe-nonce",
      version: 1,
    },
    targetOrigin: `chrome-extension://${EXTENSION_ID}`,
  });
  assert.equal(mounted.ready, false);
  dom.dispatchMessage({ origin: "https://evil.invalid", source: dom.frame.contentWindow, data: { type: "LIVE_PLAYER_READY", nonce: mounted.nonce, version: 1 } });
  assert.equal(mounted.ready, false);
  dom.dispatchMessage({
    origin: `chrome-extension://${EXTENSION_ID}`,
    source: dom.frame.contentWindow,
    data: { type: "LIVE_PLAYER_READY", nonce: mounted.nonce, helloNonce: "wrong", version: 1 },
  });
  assert.equal(mounted.ready, false);
  dom.dispatchMessage({
    origin: `chrome-extension://${EXTENSION_ID}`,
    source: dom.frame.contentWindow,
    data: { type: "LIVE_PLAYER_READY", nonce: mounted.nonce, helloNonce: "iframe-nonce", version: 1 },
  });
  assert.equal(mounted.ready, true);
  assert.deepEqual(dom.messages.at(-1), {
    message: {
      version: 1,
      type: "PLAYER_INIT",
      courseId: "c1",
      subId: "s1",
      view: "student",
      nonce: mounted.nonce,
      helloNonce: "iframe-nonce",
    },
    targetOrigin: `chrome-extension://${EXTENSION_ID}`,
  });
});

test("probe and listLive use versioned extension messages", async () => {
  const calls = [];
  const runtime = { sendMessage: async (...args) => { calls.push(args); return { version: 1, courses: [{ course_id: "c1" }] }; } };
  const transport = createExtensionTransport({ extensionId: EXTENSION_ID, runtime });
  assert.equal(await transport.probe(), true);
  assert.deepEqual(await transport.listLive(), [{
    course_id: "c1",
    course_title: "",
    teacher: "",
    room: "",
    sub_id: "",
    sub_title: "",
    starts_at: "",
    ends_at: "",
    status: "",
    available_views: [],
  }]);
  assert.deepEqual(calls, [
    [EXTENSION_ID, { version: 1, type: "CAPABILITIES" }],
    [EXTENSION_ID, { version: 1, type: "LIST_LIVE" }],
  ]);
});

test("probe preserves external login and failed states for Pages", async () => {
  for (const state of ["login-required", "failed"]) {
    const transport = createExtensionTransport({
      extensionId: EXTENSION_ID,
      runtime: { sendMessage: async () => ({ version: 1, state }) },
    });
    assert.equal(await transport.probe(), true);
    assert.equal(transport.getState(), state);
  }
});

test("refresh uses the versioned external REFRESH message and updates state", async () => {
  const calls = [];
  const transport = createExtensionTransport({
    extensionId: EXTENSION_ID,
    runtime: {
      sendMessage: async (...args) => {
        calls.push(args);
        return { version: 1, state: "ready" };
      },
    },
  });
  const result = await transport.refresh();
  assert.deepEqual(result, { version: 1, state: "ready" });
  assert.equal(transport.getState(), "connected");
  assert.deepEqual(calls, [[EXTENSION_ID, { version: 1, type: "REFRESH" }]]);
});

test("listLive strips untrusted extension metadata before Pages consumes it", async () => {
  const runtime = {
    sendMessage: async () => ({
      version: 1,
      courses: [{
        course_id: "c1",
        sub_id: "s1",
        course_title: "Analysis",
        available_views: ["teacher", "https://evil.invalid/view", { token: "secret" }],
        signed_url: "https://evil.invalid/signed",
        token: "secret",
      }],
    }),
  };
  const transport = createExtensionTransport({ extensionId: EXTENSION_ID, runtime });
  assert.deepEqual(await transport.listLive(), [{
    course_id: "c1",
    course_title: "Analysis",
    teacher: "",
    room: "",
    sub_id: "s1",
    sub_title: "",
    starts_at: "",
    ends_at: "",
    status: "",
    available_views: ["teacher"],
  }]);
});

test("Pages discovers the extension through the content-script postMessage bridge", async () => {
  const listeners = new Set();
  const sent = [];
  const windowRef = {
    addEventListener(type, listener) { if (type === "message") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "message") listeners.delete(listener); },
    postMessage(message, targetOrigin) {
      sent.push({ message, targetOrigin });
      if (message.type === "PAGE_BRIDGE_HELLO") {
        queueMicrotask(() => {
          for (const listener of listeners) listener({
            source: windowRef,
            origin: "https://johnxmj.github.io",
            data: {
              source: "fudan-icourse-live-player",
              version: 1,
              type: "PAGE_BRIDGE_READY",
              nonce: message.nonce,
            },
          });
        });
      }
      if (message.type === "PAGE_BRIDGE_REQUEST") {
        queueMicrotask(() => {
          for (const listener of listeners) listener({
            source: windowRef,
            origin: "https://johnxmj.github.io",
            data: {
              source: "fudan-icourse-live-player",
              version: 1,
              type: "PAGE_BRIDGE_RESPONSE",
              nonce: message.nonce,
              requestId: message.requestId,
              ok: true,
              payload: { version: 1, capabilities: { live: true } },
            },
          });
        });
      }
    },
  };
  const transport = createExtensionTransport({ extensionId: EXTENSION_ID, windowRef });
  assert.equal(await transport.probe(), true);
  assert.deepEqual(sent.map(({ message, targetOrigin }) => ({ type: message.type, targetOrigin })), [
    { type: "PAGE_BRIDGE_HELLO", targetOrigin: "https://johnxmj.github.io" },
    { type: "PAGE_BRIDGE_REQUEST", targetOrigin: "https://johnxmj.github.io" },
  ]);
});

test("player status requires the actual frame and both completed handshake nonces", () => {
  const dom = makeDom();
  const statuses = [];
  const transport = createExtensionTransport({ extensionId: EXTENSION_ID, runtime: { sendMessage: async () => ({}) }, windowRef: globalThis });
  const mounted = transport.mountPlayer(dom.container, { course_id: "c1", sub_id: "s1" }, "teacher", { onStatus: value => statuses.push(value) });
  const event = data => ({ origin: `chrome-extension://${EXTENSION_ID}`, source: dom.frame.contentWindow, data: { version: 1, ...data } });
  dom.dispatchMessage(event({ type: "LIVE_PLAYER_HELLO", nonce: "hello" }));
  const state = { type: "LIVE_PLAYER_STATE", state: "playing", nonce: mounted.nonce, helloNonce: "hello" };
  dom.dispatchMessage(event(state));
  assert.deepEqual(statuses, [], "status cannot precede ready acknowledgement");
  dom.dispatchMessage(event({ type: "LIVE_PLAYER_READY", nonce: mounted.nonce, helloNonce: "hello" }));
  dom.dispatchMessage({ ...event(state), source: {} });
  dom.dispatchMessage(event({ ...state, nonce: "wrong" }));
  dom.dispatchMessage(event({ ...state, state: "unknown" }));
  assert.deepEqual(statuses, []);
  dom.dispatchMessage(event(state));
  assert.deepEqual(statuses, ["playing"]);
  mounted.dispose();
});

function deferredPageBridge({ handshake = true } = {}) {
  const listeners = new Set();
  const requests = [];
  const windowRef = {
    addEventListener(_name, handler) { listeners.add(handler); },
    removeEventListener(_name, handler) { listeners.delete(handler); },
    postMessage(message) {
      if (message.type === "PAGE_BRIDGE_HELLO" && handshake) queueMicrotask(() => reply({ type: "PAGE_BRIDGE_READY", nonce: message.nonce }));
      if (message.type === "PAGE_BRIDGE_REQUEST") requests.push(message);
    },
  };
  const reply = data => {
    for (const handler of listeners) handler({ source: windowRef, origin: "https://johnxmj.github.io", data: { source: "fudan-icourse-live-player", version: 1, ...data } });
  };
  return { windowRef, requests, respond() {
    const request = requests.at(-1);
    reply({ type: "PAGE_BRIDGE_RESPONSE", nonce: request.nonce, requestId: request.requestId, ok: true, payload: { version: 1, state: "ready", courses: [] } });
  } };
}
const flushMicrotasks = async () => { for (let index = 0; index < 5; index++) await Promise.resolve(); };

test("Pages allows slow course discovery and refresh beyond the short capability timeout", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const bridge = deferredPageBridge();
  const transport = createExtensionTransport({ extensionId: EXTENSION_ID, windowRef: bridge.windowRef });
  for (const method of ["listLive", "refresh"]) {
    let settled = false;
    const operation = transport[method]();
    operation.then(() => { settled = true; }, () => { settled = true; });
    await flushMicrotasks();
    context.mock.timers.tick(20000);
    await flushMicrotasks();
    assert.equal(settled, false, `${method} must allow a slow VPN course catalog`);
    bridge.respond();
    await operation;
  }
  transport.dispose();
});

test("Pages course requests still fail after a bounded one-minute wait", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const bridge = deferredPageBridge();
  const transport = createExtensionTransport({ extensionId: EXTENSION_ID, windowRef: bridge.windowRef });
  let settled = false;
  const request = transport.listLive();
  request.then(() => { settled = true; }, () => { settled = true; });
  const rejection = assert.rejects(request, error => error.code === "BRIDGE_TIMEOUT");
  await flushMicrotasks();
  context.mock.timers.tick(59999);
  await flushMicrotasks();
  assert.equal(settled, false);
  context.mock.timers.tick(1);
  await rejection;
  transport.dispose();
});

test("Pages keeps helper detection and missing-content-script waits short", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [handshake, timeout] of [[false, 1500], [true, 5000]]) {
    const bridge = deferredPageBridge({ handshake });
    const transport = createExtensionTransport({ extensionId: EXTENSION_ID, windowRef: bridge.windowRef });
    let settled = false;
    const probe = transport.probe().then(result => { settled = true; return result; });
    await flushMicrotasks();
    context.mock.timers.tick(timeout - 1);
    await flushMicrotasks();
    assert.equal(settled, false);
    context.mock.timers.tick(1);
    assert.equal(await probe, false);
    transport.dispose();
  }
});

test("refresh returns only public state and sanitized course metadata", async () => {
  const transport = createExtensionTransport({ extensionId: EXTENSION_ID,
    runtime: { sendMessage: async () => ({ version: 1, state: "ready", cookie: "private-cookie", courses: [{
      course_id: "c1", sub_id: "s1", course_title: "Course", media_token: "private-media", signed_url: "https://private.invalid/stream", available_views: ["teacher", "unsafe-view"],
    }] }) },
  });
  const refreshed = await transport.refresh();
  assert.deepEqual(Object.keys(refreshed).sort(), ["courses", "state", "version"]);
  assert.equal(refreshed.state, "ready");
  assert.equal(refreshed.courses[0].course_id, "c1");
  assert.deepEqual(refreshed.courses[0].available_views, ["teacher"]);
  assert.doesNotMatch(JSON.stringify(refreshed), /private|media_token|signed_url|cookie|unsafe-view/);
});
