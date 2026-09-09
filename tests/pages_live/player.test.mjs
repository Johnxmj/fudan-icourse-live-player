import test from "node:test";
import assert from "node:assert/strict";
import { mountLocalPlayer } from "../../frontend/live/player.js";
import { createLocalTransport } from "../../frontend/live/transports/local.js";

class Hls {
  static Events = { MANIFEST_PARSED: "parsed", ERROR: "error" };
  static ErrorTypes = { NETWORK_ERROR: "network", MEDIA_ERROR: "media" };
  static isSupported() { return true; }
  constructor() { Hls.instance = this; this.handlers = {}; this.retries = 0; }
  on(name, handler) { this.handlers[name] = handler; }
  attachMedia(video) { this.video = video; }
  loadSource(url) { this.url = url; }
  startLoad() { this.retries++; }
  destroy() { this.destroyed = true; }
}
const course = { course_id: "c1", sub_id: "s1", media_token: "scoped-token" };
function makeDom() {
  const video = { listeners: {}, setAttribute() {}, addEventListener(name, fn) { this.listeners[name] = fn; }, removeEventListener() {}, play: async () => {}, pause() {}, removeAttribute() {}, load() {} };
  return { video, container: { ownerDocument: { createElement: () => video }, replaceChildren(...nodes) { this.nodes = nodes; } } };
}

test("local Pages playback consumes a loopback media token and bounds fatal-error recovery", async () => {
  const screen = makeDom();
  const transport = createLocalTransport(new URL("https://johnxmj.github.io/live/#bridge=http%3A%2F%2F127.0.0.1%3A4310&bootstrap=once"), async () => ({ ok: true, json: async () => ({ token: "private-session" }) }));
  await transport.ready;
  let refreshes = 0;
  const statuses = [];
  const mounted = mountLocalPlayer(screen.container, transport, course, "teacher", { Hls, onStatus: value => statuses.push(value), onRefresh: async () => { refreshes++; } });
  assert.match(Hls.instance.url, /^http:\/\/127\.0\.0\.1:4310\/media\/c1\/s1\/teacher\/manifest.m3u8\?media_token=scoped-token$/);
  assert.doesNotMatch(Hls.instance.url, /private-session|once/);
  screen.video.listeners.playing();
  assert.equal(statuses.at(-1), "playing");
  for (let i = 0; i < 4; i++) await Hls.instance.handlers.error("error", { fatal: true, type: "network" });
  assert.equal(Hls.instance.retries, 2);
  assert.equal(refreshes, 1);
  assert.equal(statuses.at(-1), "failed");
  mounted.dispose();
  assert.equal(Hls.instance.destroyed, true);
  assert.deepEqual(screen.container.nodes, []);
});

test("local Pages catalog maps legacy no-live responses to empty and can recover", async () => {
  let request = 0;
  const transport = createLocalTransport(new URL("https://johnxmj.github.io/live/#bridge=http%3A%2F%2F127.0.0.1%3A4310&bootstrap=once"), async () => {
    request++;
    if (request === 1) return { ok: true, json: async () => ({ token: "session" }) };
    if (request === 2) return { ok: false, status: 404, json: async () => ({ error: { code: "NO_LIVE_COURSES" } }) };
    return { ok: true, json: async () => [course] };
  });
  assert.deepEqual(await transport.listLive(), []);
  assert.equal(transport.getState(), "empty");
  assert.deepEqual(await transport.listLive(), [course]);
  assert.equal(transport.getState(), "ready");
});
