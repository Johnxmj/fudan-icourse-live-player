import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  bindRailToggle,
  boot,
  detectTransport,
  renderState,
  wireStateActions,
} from "../../frontend/live/app.js";
import { FUDAN_EXTENSION_ID } from "../../frontend/live/extension-config.js";

test("prefers the extension transport even when adapters arrive in another order", async () => {
  const probes = [];
  const transport = await detectTransport([
    { name: "local", probe: async () => { probes.push("local"); return true; } },
    { name: "extension", probe: async () => { probes.push("extension"); return true; } },
  ]);
  assert.equal(transport.name, "extension");
  assert.deepEqual(probes, ["extension"]);
});

test("returns disconnected when no helper is available", async () => {
  const transport = await detectTransport([{ name: "extension", probe: async () => false }]);
  assert.equal(transport, null);
});

test("disconnected state offers exactly extension and local-player actions", () => {
  const markup = renderState("disconnected");
  assert.match(markup, /浏览器扩展/);
  assert.match(markup, /本地播放器/);
  assert.equal((markup.match(/<button\b/g) || []).length, 2);
  assert.match(markup, /data-action-url="https:\/\/github\.com\/Johnxmj\/fudan-icourse-live-player/);
  assert.doesNotMatch(markup, /password|cookie|signed url/i);
});

test("disconnected actions open safe setup guidance", () => {
  const buttons = [
    { dataset: { action: "extension" }, listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; } },
    { dataset: { action: "local" }, listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; } },
  ];
  const container = { querySelectorAll() { return buttons; } };
  const opened = [];
  const windowRef = {
    open(url, target, features) {
      opened.push({ url, target, features });
      return {};
    },
  };

  wireStateActions(container, windowRef);
  buttons[0].listeners.click();
  buttons[1].listeners.click();

  assert.deepEqual(opened.map((entry) => entry.url), [
    "https://github.com/Johnxmj/fudan-icourse-live-player/blob/main/docs/live-player.md",
    "https://github.com/Johnxmj/fudan-icourse-live-player#run-locally",
  ]);
  assert.deepEqual(opened.map((entry) => entry.target), ["_blank", "_blank"]);
  assert.ok(opened.every((entry) => /noopener/.test(entry.features)));
});

test("boot renders disconnected when a transport factory throws synchronously", async () => {
  const state = {
    markup: "",
    attributes: {},
    set innerHTML(value) { this.markup = value; },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelectorAll() { return []; },
  };
  const documentRef = {
    querySelector(selector) {
      return selector === "[data-live-state]" ? state : null;
    },
  };

  await boot({
    documentRef,
    windowRef: { location: new URL("https://johnxmj.github.io/fudan-icourse-live-player/live/") },
    extensionFactory() { throw new Error("extension unavailable"); },
    localFactory() { throw new Error("local unavailable"); },
  });

  assert.match(state.markup, /data-state="disconnected"/);
});

test("boot wires the approved extension ID into the default adapter", async () => {
  const state = {
    markup: "",
    attributes: {},
    set innerHTML(value) { this.markup = value; },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelectorAll() { return []; },
  };
  const calls = [];
  const documentRef = {
    querySelector(selector) {
      return selector === "[data-live-state]" ? state : null;
    },
  };
  const runtime = {
    sendMessage(extensionId, message) {
      calls.push({ extensionId, message });
      return Promise.resolve(message.type === "LIST_LIVE"
        ? { version: 1, state: "ready", courses: [{ course_id: "c1", sub_id: "s1" }] }
        : { version: 1, capabilities: { live: true } });
    },
  };

  await boot({
    documentRef,
    windowRef: { location: new URL("https://johnxmj.github.io/fudan-icourse-live-player/live/") },
    runtime,
    extensionFactory: undefined,
    localFactory: undefined,
  });

  assert.equal(FUDAN_EXTENSION_ID.length, 32);
  assert.deepEqual(calls, [{
    extensionId: FUDAN_EXTENSION_ID,
    message: { version: 1, type: "CAPABILITIES" },
  }, {
    extensionId: FUDAN_EXTENSION_ID,
    message: { version: 1, type: "LIST_LIVE" },
  }]);
  assert.match(state.markup, /data-state="connected"/);
});

test("boot propagates extension login-required state", async () => {
  const state = {
    markup: "",
    attributes: {},
    set innerHTML(value) { this.markup = value; },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelectorAll() { return []; },
  };
  const documentRef = {
    querySelector(selector) {
      return selector === "[data-live-state]" ? state : null;
    },
  };
  await boot({
    documentRef,
    windowRef: { location: new URL("https://johnxmj.github.io/fudan-icourse-live-player/live/") },
    extensionFactory: () => ({
      name: "extension",
      probe: async () => true,
      getState: () => "login-required",
      listLive: async () => [],
    }),
    localFactory: undefined,
  });
  assert.match(state.markup, /data-state="login-required"/);
});

test("boot propagates extension failed state", async () => {
  const state = {
    markup: "",
    attributes: {},
    set innerHTML(value) { this.markup = value; },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelectorAll() { return []; },
  };
  const documentRef = {
    querySelector(selector) {
      return selector === "[data-live-state]" ? state : null;
    },
  };
  await boot({
    documentRef,
    windowRef: { location: new URL("https://johnxmj.github.io/fudan-icourse-live-player/live/") },
    extensionFactory: () => ({
      name: "extension",
      probe: async () => true,
      getState: () => "failed",
      listLive: async () => [],
    }),
    localFactory: undefined,
  });
  assert.match(state.markup, /data-state="failed"/);
});

test("boot renders empty when a ready extension has no current courses", async () => {
  const state = {
    markup: "",
    attributes: {},
    set innerHTML(value) { this.markup = value; },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelectorAll() { return []; },
  };
  const documentRef = {
    querySelector(selector) {
      return selector === "[data-live-state]" ? state : null;
    },
  };
  await boot({
    documentRef,
    windowRef: { location: new URL("https://johnxmj.github.io/fudan-icourse-live-player/live/") },
    extensionFactory: () => ({
      name: "extension",
      probe: async () => true,
      getState: () => "connected",
      listLive: async () => [],
    }),
    localFactory: undefined,
  });
  assert.match(state.markup, /data-state="empty"/);
});

test("mobile course rail toggle keeps data-open and aria-expanded in sync", () => {
  const rail = { dataset: { open: "false" } };
  const toggle = {
    dataset: {},
    attributes: {},
    listeners: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    click() { this.listeners.click(); },
  };

  const cleanup = bindRailToggle(toggle, rail);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  toggle.click();
  assert.equal(rail.dataset.open, "true");
  assert.equal(toggle.dataset.open, "true");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  toggle.click();
  assert.equal(rail.dataset.open, "false");
  assert.equal(toggle.dataset.open, "false");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  cleanup();
});

test("live route exposes an accessible course rail toggle", () => {
  const markup = readFileSync("frontend/live/index.html", "utf8");
  assert.match(markup, /data-rail-toggle/);
  assert.match(markup, /aria-controls="live-course-rail"/);
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, /<aside[^>]+id="live-course-rail"[^>]+data-open="false"/s);
});

test("extension-only mode explains that the local helper is required", async () => {
  const listeners = {};
  const element = () => ({
    dataset: {}, disabled: false, value: "", checked: false, innerHTML: "", textContent: "", hidden: false,
    setAttribute() {}, addEventListener(type, handler) { (listeners[type] ||= []).push(handler); }, removeEventListener() {}, querySelector() { return null; }, replaceChildren() {},
  });
  const state = element();
  const transcriptionStart = element();
  const transcriptionStatus = element();
  const byName = new Map([
    ["live-state", state], ["live-courses", element()], ["player", element()], ["view-bar", element()], ["refresh", element()], ["course-rail", element()], ["rail-toggle", element()],
    ["transcription-start", transcriptionStart], ["transcription-stop", element()], ["transcription-export", element()], ["transcription-clear", element()], ["transcription-state", element()], ["transcription-status", transcriptionStatus], ["transcription-alert", element()], ["transcription-lines", element()], ["transcription-model", element()], ["transcription-language", element()], ["transcription-keywords", element()], ["transcription-page", element()], ["transcription-sound", element()], ["transcription-system", element()],
  ]);
  const documentRef = { querySelector(selector) { if (selector === "[data-live-state]") return state; const match = /^\[data-(.+)\]$/.exec(selector); return match ? byName.get(match[1]) || null : null; } };
  await boot({
    documentRef,
    windowRef: { location: new URL("https://johnxmj.github.io/fudan-icourse-live-player/live/") },
    extensionFactory: () => ({ name: "extension", probe: async () => true, getState: () => "connected", listLive: async () => [{ course_id: "c1", sub_id: "s1", available_views: ["teacher"] }] }),
    localFactory: undefined,
  });
  assert.equal(transcriptionStart.disabled, true);
  assert.match(transcriptionStatus.textContent, /本地助手/);
});

test("Pages course changes cancel a late local transcription start before streaming", async () => {
  const element = () => ({
    dataset: {}, disabled: false, value: "", checked: true, innerHTML: "", textContent: "", hidden: false, listeners: {},
    setAttribute() {}, addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }, removeEventListener() {}, querySelector() { return null; }, replaceChildren() {},
    click() { for (const handler of this.listeners.click || []) handler({ target: this, preventDefault() {} }); },
  });
  const state = element();
  const start = element();
  const byName = new Map([
    ["live-state", state], ["live-courses", element()], ["player", element()], ["view-bar", element()], ["refresh", element()], ["course-rail", element()], ["rail-toggle", element()],
    ["transcription-start", start], ["transcription-stop", element()], ["transcription-export", element()], ["transcription-clear", element()], ["transcription-state", element()], ["transcription-status", element()], ["transcription-alert", element()], ["transcription-lines", element()], ["transcription-model", element()], ["transcription-language", element()], ["transcription-keywords", element()], ["transcription-page", element()], ["transcription-sound", element()], ["transcription-system", element()],
  ]);
  const documentRef = { querySelector(selector) { if (selector === "[data-live-state]") return state; const match = /^\[data-(.+)\]$/.exec(selector); return match ? byName.get(match[1]) || null : null; } };
  let resolveStart;
  const stops = [];
  const streams = [];
  const courses = [
    { course_id: "old", sub_id: "one", course_title: "旧课程", available_views: ["teacher"] },
    { course_id: "new", sub_id: "two", course_title: "新课程", available_views: ["teacher"] },
  ];
  const app = await boot({
    documentRef,
    windowRef: { location: new URL("https://johnxmj.github.io/live/") },
    extensionFactory: undefined,
    localFactory: () => ({
      name: "local", probe: async () => true, getState: () => "connected", listLive: async () => courses,
      transcriptionCapabilities: async () => ({ available: true }),
      startTranscription: () => new Promise(resolve => { resolveStart = resolve; }),
      streamTranscription: async (sessionId) => streams.push(sessionId),
      stopTranscription: async sessionId => stops.push(sessionId),
      mountPlayer: () => ({ dispose() {} }),
    }),
  });
  await app.selectCourse("old", "one");
  start.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  app.selectCourse("new", "two");
  resolveStart({ session_id: "tx-late" });
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.deepEqual(stops, ["tx-late"]);
  assert.deepEqual(streams, []);
  assert.equal(app.activeCourse.course_id, "new");
});
