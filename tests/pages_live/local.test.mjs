import assert from "node:assert/strict";
import test from "node:test";
import { createLocalTransport } from "../../frontend/live/transports/local.js";

function response(payload, ok = true, status = 200) {
  return { ok, status, json: async () => payload };
}

async function withHistory(location, callback) {
  const previous = globalThis.history;
  const calls = [];
  globalThis.history = {
    replaceState(_state, _title, nextUrl) {
      calls.push(nextUrl);
      const next = new URL(nextUrl, location);
      location.hash = next.hash;
    },
  };
  try {
    return await callback(calls);
  } finally {
    globalThis.history = previous;
  }
}

test("local transport reads pairing only from the fragment", async () => {
  const location = new URL("https://johnxmj.github.io/Fudan_iCourse_Subscriber/live/#bridge=http%3A%2F%2F127.0.0.1%3A43123&bootstrap=once");
  await withHistory(location, async () => {
    const transport = createLocalTransport(location, async () => response({ token: "session" }));
    assert.equal(transport.baseUrl, "http://127.0.0.1:43123");
    assert.equal("bootstrap" in transport, false);
    await transport.ready;
  });
});

test("rejects non-loopback bridge origins", () => {
  const location = new URL("https://example.test/#bridge=https%3A%2F%2Fevil.invalid&bootstrap=x");
  assert.throws(() => createLocalTransport(location, async () => response({ token: "session" })), /loopback/);
  assert.equal(location.hash, "");
});

test("clears a fragment when bootstrap is missing", () => {
  const location = new URL("https://example.test/#bridge=http%3A%2F%2F127.0.0.1%3A43123");
  assert.throws(() => createLocalTransport(location, async () => response({ token: "session" })), /bootstrap token is required/);
  assert.equal(location.hash, "");
});

test("clears a fragment when the bridge URL is malformed", () => {
  const location = new URL("https://example.test/#bridge=%2F%2F127.0.0.1%3A43123&bootstrap=x");
  assert.throws(() => createLocalTransport(location, async () => response({ token: "session" })), /Invalid URL/);
  assert.equal(location.hash, "");
});

test("removes the pairing fragment before the exchange and keeps it removed on failure", async () => {
  const location = new URL("https://johnxmj.github.io/Fudan_iCourse_Subscriber/live/#bridge=http%3A%2F%2F127.0.0.1%3A43123&bootstrap=once");
  await withHistory(location, async (historyCalls) => {
    let hashAtFetch = "unset";
    const transport = createLocalTransport(location, async () => {
      hashAtFetch = location.hash;
      throw Object.assign(new Error("bridge unavailable"), { status: 503 });
    });
    assert.equal(location.hash, "");
    assert.equal(hashAtFetch, "");
    await assert.rejects(transport.ready, /bridge unavailable/);
    assert.equal(location.hash, "");
    assert.deepEqual(historyCalls, ["/Fudan_iCourse_Subscriber/live/"]);
  });
});

test("exchanges bootstrap once, then uses only the in-memory bearer", async () => {
  const location = new URL("https://johnxmj.github.io/Fudan_iCourse_Subscriber/live/#bridge=http%3A%2F%2F127.0.0.1%3A43123&bootstrap=once");
  const calls = [];
  await withHistory(location, async () => {
    const transport = createLocalTransport(location, async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/api/session")) return response({ token: "session" });
      return response([]);
    });
    await transport.listLive();
    assert.equal(calls.length, 2);
    assert.match(calls[0].init.body, /"bootstrap_token":"once"/);
    assert.equal(calls[0].init.headers.Authorization, undefined);
    assert.equal(calls[1].init.headers.Authorization, "Bearer session");
    assert.doesNotMatch(JSON.stringify(calls[1]), /bootstrap|once/);
    assert.equal("bootstrap" in transport, false);
  });
});
