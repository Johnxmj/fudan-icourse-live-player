import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync("edge_extension/src/page-bridge.js", "utf8");
const ORIGIN = "https://johnxmj.github.io";

function makeBridge() {
  const listeners = new Set();
  const sent = [];
  const calls = [];
  const page = {
    addEventListener(type, listener) { if (type === "message") listeners.add(listener); },
    postMessage(message, targetOrigin) { sent.push({ message, targetOrigin }); },
    dispatch(data, origin = ORIGIN, source = page) {
      for (const listener of listeners) listener({ data, origin, source });
    },
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          calls.push(message);
          return {
            version: 1,
            state: "ready",
            courses: [{
              course_id: "c1",
              sub_id: "s1",
              token: "must-not-cross-boundary",
              live_url: "https://media.invalid/live.m3u8?sig=secret",
              available_views: ["teacher", "https://evil.invalid"],
            }],
          };
        },
      },
    },
  };
  vm.runInNewContext(SOURCE, { window: page, URL, Set, Object, Promise, RegExp, Boolean, Array });
  return { page, sent, calls };
}

test("content script forwards only an approved LIST_LIVE request and redacts media data", async () => {
  const bridge = makeBridge();
  bridge.page.dispatch({
    source: "fudan-icourse-live-player",
    version: 1,
    type: "PAGE_BRIDGE_HELLO",
    nonce: "test-nonce",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(bridge.sent.at(-1).message)), {
    source: "fudan-icourse-live-player",
    version: 1,
    type: "PAGE_BRIDGE_READY",
    nonce: "test-nonce",
  });
  bridge.page.dispatch({
    source: "fudan-icourse-live-player",
    version: 1,
    type: "PAGE_BRIDGE_REQUEST",
    nonce: "test-nonce",
    requestId: "request-1",
    request: { version: 1, type: "LIST_LIVE", payload: {} },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(bridge.calls, [{ version: 1, type: "LIST_LIVE", payload: {} }]);
  const response = bridge.sent.at(-1).message;
  assert.equal(response.type, "PAGE_BRIDGE_RESPONSE");
  assert.equal(response.ok, true);
  assert.equal(response.payload.courses[0].course_id, "c1");
  assert.equal("token" in response.payload.courses[0], false);
  assert.equal("live_url" in response.payload.courses[0], false);
  assert.doesNotMatch(JSON.stringify(response), /secret|media\.invalid|must-not-cross-boundary/);
});

test("content script ignores wrong origins, nonces, and non-whitelisted requests", async () => {
  const bridge = makeBridge();
  bridge.page.dispatch({ source: "fudan-icourse-live-player", version: 1, type: "PAGE_BRIDGE_HELLO", nonce: "test-nonce" }, "https://evil.invalid");
  bridge.page.dispatch({ source: "fudan-icourse-live-player", version: 1, type: "PAGE_BRIDGE_HELLO", nonce: "test-nonce" });
  bridge.page.dispatch({
    source: "fudan-icourse-live-player", version: 1, type: "PAGE_BRIDGE_REQUEST", nonce: "wrong",
    requestId: "request-1", request: { version: 1, type: "LIST_LIVE", payload: {} },
  });
  bridge.page.dispatch({
    source: "fudan-icourse-live-player", version: 1, type: "PAGE_BRIDGE_REQUEST", nonce: "test-nonce",
    requestId: "request-2", request: { version: 1, type: "OPEN_PLAYER", payload: {} },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(bridge.calls, []);
  assert.equal(bridge.sent.length, 1);
});

test('content bridge preserves the unconfigured state without widening its API', async () => {
  const bridge = makeBridge();
  bridge.page.chrome.runtime.sendMessage = async () => ({ state: 'unconfigured', courses: [] });
  bridge.page.dispatch({ source: 'fudan-icourse-live-player', version: 1, type: 'PAGE_BRIDGE_HELLO', nonce: 'config-nonce' });
  bridge.page.dispatch({
    source: 'fudan-icourse-live-player', version: 1, type: 'PAGE_BRIDGE_REQUEST', nonce: 'config-nonce',
    requestId: 'config-request', request: { version: 1, type: 'LIST_LIVE', payload: {} },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bridge.sent.at(-1).message.payload.state, 'unconfigured');
});
