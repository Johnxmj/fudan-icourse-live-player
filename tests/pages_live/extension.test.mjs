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
