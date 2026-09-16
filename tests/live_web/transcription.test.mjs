import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_KEYWORDS,
  SETTINGS_KEY,
  buildTranscriptMarkdown,
  createAlertCooldown,
  createTranscriptionController,
  downloadTranscriptMarkdown,
  matchKeywords,
  normalizeKeywords,
  parseSseStream,
} from "../../live_player/web/transcription.js";

function streamFromChunks(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

test("default keywords exclude homework words", () => {
  assert.deepEqual(DEFAULT_KEYWORDS, ["点名", "签到", "小测", "测验", "期中", "期末", "quiz"]);
  assert.equal(DEFAULT_KEYWORDS.some((word) => /作业|截止|提交/.test(word)), false);
});

test("keyword normalization uses NFKC, removes Chinese spacing, folds English, caps and deduplicates", () => {
  const long = "x".repeat(41);
  const result = normalizeKeywords([" 签 到 ", "签到", "ＱＵＩＺ", "quiz", "", long, 42]);

  assert.deepEqual(result, ["签到", "quiz"]);
});

test("matching normalizes Unicode and English case", () => {
  assert.deepEqual(matchKeywords("现在有 QUIZ，也请 签 到", ["quiz", "签到"]), ["quiz", "签到"]);
});

test("cooldown is per keyword for sixty seconds", () => {
  let time = 0;
  const allow = createAlertCooldown({ now: () => time });
  assert.equal(allow("签到"), true);
  assert.equal(allow("签到"), false);
  assert.equal(allow("quiz"), true);
  time += 60_000;
  assert.equal(allow("签到"), true);
});

test("SSE parsing accepts only safe event records across arbitrary chunk boundaries", async () => {
  const events = [];
  await parseSseStream(streamFromChunks([
    "event: transcript\ndata: {\"type\":\"seg",
    "ment\",\"start\":62,\"end\":64.5,\"text\":\"请 签到\",\"receivedAt\":\"remote-controlled\",\"private\":\"nope\"}\n\n",
    "event: transcript\ndata: {\"type\":\"error\",\"code\":\"AUDIO_UNAVAILABLE\",\"message\":\"Audio unavailable\",\"stack\":\"secret\"}\n\n",
    "event: transcript\ndata: {\"type\":\"ended\",\"state\":\"<img src=x onerror=alert(1)>\"}\n\n",
    "event: unknown\ndata: {\"type\":\"segment\",\"text\":\"ignore\"}\n\n",
  ]), { onEvent: (event) => events.push(event) });

  assert.deepEqual(events, [
    { type: "segment", start: 62, end: 64.5, text: "请 签到" },
    { type: "error", code: "AUDIO_UNAVAILABLE", message: "Audio unavailable" },
  ]);
});

test("SSE download progress preserves only a bounded numeric field and drops unsafe fields", async () => {
  const events = [];
  await parseSseStream(streamFromChunks([
    "event: transcript\ndata: {\"type\":\"state\",\"state\":\"downloading-model\",\"progress\":42,\"url\":\"https://model.invalid/private\",\"error\":\"secret\"}\n\n",
    "event: transcript\ndata: {\"type\":\"state\",\"state\":\"downloading-model\",\"progress\":-1}\n\n",
    "event: transcript\ndata: {\"type\":\"state\",\"state\":\"downloading-model\",\"progress\":101}\n\n",
    "event: transcript\ndata: {\"type\":\"state\",\"state\":\"downloading-model\",\"progress\":\"50\"}\n\n",
  ]), { onEvent: (event) => events.push(event) });

  assert.deepEqual(events, [
    { type: "state", state: "downloading-model", progress: 42 },
    { type: "state", state: "downloading-model" },
    { type: "state", state: "downloading-model" },
    { type: "state", state: "downloading-model" },
  ]);
});

test("markdown contains escaped alerts, receipt times, and marked keywords but no connection data", () => {
  const markdown = buildTranscriptMarkdown({
    course: { course_id: "37142", sub_id: "659200", name: "课程 | 名称" },
    sessionId: "tx-1",
    settings: { model: "base", language: "zh" },
    alerts: [{ keyword: "签到|quiz", timestamp: 62, receivedAt: "2026-09-15T01:02:03.000Z", text: "请 | 签到" }],
    transcript: [{ start: 62, end: 64, text: "请 | 签到", keywords: ["签到|quiz"] }],
    exportedAt: new Date("2026-09-15T00:00:00Z"),
    media_token: "must-not-export",
    bootstrap: "must-not-export",
    bridge: "http://127.0.0.1:4310",
  });

  assert.match(markdown, /## 告警记录/);
  assert.match(markdown, /\[00:01:02\]/);
  assert.match(markdown, /2026-09-15T01:02:03\.000Z/);
  assert.match(markdown, /\*\*关键词：签到\\\|quiz\*\*/);
  assert.match(markdown, /课程 \\| 名称/);
  assert.match(markdown, /请 \\| 签到/);
  assert.doesNotMatch(markdown, /media_token|bootstrap|127\.0\.0\.1/);
});

test("settings storage key is stable", () => {
  assert.equal(SETTINGS_KEY, "live-player.transcription-settings.v1");
});

test("controller persists only settings while keeping immutable transcript snapshots in memory", async () => {
  const writes = [];
  const storage = {
    getItem: () => null,
    setItem: (key, value) => writes.push([key, JSON.parse(value)]),
  };
  const transport = {
    transcriptionCapabilities: async () => ({}),
    startTranscription: async () => ({ session_id: "tx-1" }),
    streamTranscription: async (_sessionId, { onEvent }) => {
      onEvent({ type: "segment", start: 62, end: 64, text: "现在请签到" });
    },
    stopTranscription: async () => ({}),
  };
  const controller = createTranscriptionController({ transport, storage, now: () => Date.parse("2026-09-15T01:02:03.000Z") });
  controller.updateSettings({ keywords: ["签到", " 签 到 "] });
  await controller.start({ course_id: "37142", sub_id: "659200", name: "课程" });
  await controller.waitForStream();
  const snapshot = controller.snapshot();

  assert.deepEqual(writes, [[SETTINGS_KEY, {
    model: "base", language: "zh", keywords: ["签到"], pageAlert: true, soundAlert: true, systemAlert: true,
  }]]);
  assert.equal(snapshot.transcript[0].text, "现在请签到");
  assert.deepEqual(snapshot.alerts, [{ keyword: "签到", timestamp: 62, receivedAt: "2026-09-15T01:02:03.000Z", text: "现在请签到" }]);
  assert.throws(() => { snapshot.alerts[0].receivedAt = "mutated"; }, TypeError);
  assert.throws(() => snapshot.transcript.push({}), TypeError);
  assert.throws(() => { snapshot.transcript[0].text = "mutated"; }, TypeError);
});

test("controller exposes sanitized model download progress in its state snapshot", async () => {
  const transport = {
    startTranscription: async () => ({ session_id: "tx-progress" }),
    streamTranscription: async (_sessionId, { onEvent }) => {
      onEvent({ type: "state", state: "downloading-model", progress: 42 });
      onEvent({ type: "state", state: "downloading-model", progress: 10 });
    },
    stopTranscription: async () => ({}),
  };
  const controller = createTranscriptionController({ transport });
  await controller.start({ course_id: "37142", sub_id: "659200" });
  await controller.waitForStream();

  assert.deepEqual(controller.snapshot().state, "downloading-model");
  assert.equal(controller.snapshot().progress, 42, "a stale in-range update must not regress displayed progress");
});

test("cooldown keeps repeated transcript text but removes its suppressed keyword highlight", async () => {
  const transport = {
    startTranscription: async () => ({ session_id: "tx-cooldown" }),
    streamTranscription: async (_sessionId, { onEvent }) => {
      onEvent({ type: "segment", start: 1, end: 2, text: "请签到" });
      onEvent({ type: "segment", start: 3, end: 4, text: "再次签到" });
    },
    stopTranscription: async () => ({}),
  };
  const controller = createTranscriptionController({ transport, now: () => 0 });
  await controller.start({ course_id: "37142", sub_id: "659200" });
  await controller.waitForStream();

  assert.deepEqual(controller.snapshot().transcript.map(line => line.keywords), [["签到"], []]);
  assert.equal(controller.snapshot().alerts.length, 1);
});

test("Markdown download revokes its Blob URL immediately after clicking", () => {
  const calls = [];
  const urlApi = {
    createObjectURL: () => "blob:test",
    revokeObjectURL: (url) => calls.push(["revoke", url]),
  };
  const documentRef = {
    createElement: () => ({ click: () => calls.push(["click", "blob:test"]) }),
  };
  downloadTranscriptMarkdown("# record", { documentRef, urlApi });
  assert.deepEqual(calls, [["click", "blob:test"], ["revoke", "blob:test"]]);
});

test("controller retains the completed session ID for Markdown export after stopping", async () => {
  const transport = {
    startTranscription: async () => ({ session_id: "tx-keep" }),
    streamTranscription: async () => {},
    stopTranscription: async () => ({}),
  };
  const controller = createTranscriptionController({ transport });
  await controller.start({ course_id: "37142", sub_id: "659200" });
  await controller.stop();
  const markdown = controller.exportMarkdown({ download: false, exportedAt: new Date("2026-09-15T00:00:00Z") });

  assert.match(markdown, /转录会话：tx-keep/);
});

test("explicit stop aborts the stream and forwards keepalive shutdown options", async () => {
  let signal;
  const stops = [];
  const transport = {
    startTranscription: async () => ({ session_id: "tx-stop" }),
    streamTranscription: async (_sessionId, options) => {
      signal = options.signal;
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    },
    stopTranscription: async (sessionId, options) => { stops.push({ sessionId, options }); },
  };
  const controller = createTranscriptionController({ transport });
  await controller.start({ course_id: "37142", sub_id: "659200" });
  await controller.stop({ keepalive: true });

  assert.equal(signal.aborted, true);
  assert.deepEqual(stops, [{ sessionId: "tx-stop", options: { keepalive: true } }]);
  assert.equal(controller.snapshot().activeSessionId, null);
});

test("concurrent stop requests share one remote shutdown", async () => {
  let releaseStop;
  let stopCalls = 0;
  const transport = {
    startTranscription: async () => ({ session_id: "tx-once" }),
    streamTranscription: async () => {},
    stopTranscription: () => {
      stopCalls += 1;
      return new Promise(resolve => { releaseStop = resolve; });
    },
  };
  const controller = createTranscriptionController({ transport });
  await controller.start({ course_id: "37142", sub_id: "659200" });
  const first = controller.stop();
  const second = controller.stop();
  assert.equal(stopCalls, 1);
  releaseStop();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
});

test("an old stop finalizer cannot take ownership from a new session", async () => {
  const releaseStops = new Map();
  const signals = new Map();
  const stops = [];
  let sequence = 0;
  const transport = {
    startTranscription: async () => ({ session_id: ++sequence === 1 ? "tx-a" : "tx-b" }),
    streamTranscription: async (sessionId, { signal }) => {
      signals.set(sessionId, signal);
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    },
    stopTranscription: (sessionId) => {
      stops.push(sessionId);
      return new Promise(resolve => releaseStops.set(sessionId, resolve));
    },
  };
  const controller = createTranscriptionController({ transport });
  await controller.start({ course_id: "a", sub_id: "one" });
  const stopA = controller.stop();
  controller.clear();
  await controller.start({ course_id: "b", sub_id: "two" });
  const stopB = controller.stop();

  assert.deepEqual(stops, ["tx-a", "tx-b"]);
  assert.equal(signals.get("tx-a").aborted, true);
  assert.equal(signals.get("tx-b").aborted, true);
  releaseStops.get("tx-a")();
  releaseStops.get("tx-b")();
  await Promise.all([stopA, stopB]);
});

test("stopping while a start is pending tears down the late session without relabeling a record", async () => {
  let resolveStart;
  const stops = [];
  const transport = {
    startTranscription: () => new Promise(resolve => { resolveStart = resolve; }),
    streamTranscription: async () => assert.fail("cancelled starts must not open a transcript stream"),
    stopTranscription: async (sessionId, options) => { stops.push({ sessionId, options }); },
  };
  const controller = createTranscriptionController({ transport });
  const start = controller.start({ course_id: "old", sub_id: "session", name: "旧课程" });
  await controller.stop({ keepalive: true });
  resolveStart({ session_id: "tx-late" });

  assert.equal(await start, null);
  assert.deepEqual(stops, [{ sessionId: "tx-late", options: { keepalive: true } }]);
  assert.equal(controller.snapshot().course, null);
  assert.equal(controller.snapshot().sessionId, null);
});

test("controller synchronously locks concurrent starts until the first start resolves", async () => {
  let resolveStart;
  let starts = 0;
  const transport = {
    startTranscription: () => {
      starts += 1;
      return new Promise((resolve) => { resolveStart = resolve; });
    },
    streamTranscription: async () => {},
    stopTranscription: async () => ({}),
  };
  const controller = createTranscriptionController({ transport });
  const first = controller.start({ course_id: "37142", sub_id: "659200" });
  await assert.rejects(controller.start({ course_id: "37142", sub_id: "659200" }), /already active/);
  assert.equal(starts, 1);
  resolveStart({ session_id: "tx-1" });
  await first;
});

test("failed and malformed starts clear the starting guard and allow retry", async () => {
  const starts = [
    () => Promise.reject(new Error("bridge unavailable")),
    () => Promise.resolve({}),
    () => Promise.resolve({ session_id: "tx-retry" }),
  ];
  const transport = {
    startTranscription: () => starts.shift()(),
    streamTranscription: async () => {},
    stopTranscription: async () => ({}),
  };
  const controller = createTranscriptionController({ transport });
  const course = { course_id: "37142", sub_id: "659200" };

  await assert.rejects(controller.start(course), /bridge unavailable/);
  assert.deepEqual(controller.snapshot().state, "error");
  assert.equal(controller.snapshot().activeSessionId, null);
  await assert.rejects(controller.start(course), /session ID missing/);
  assert.deepEqual(controller.snapshot().state, "error");
  assert.equal(controller.snapshot().activeSessionId, null);
  assert.equal(controller.snapshot().sessionId, null);
  assert.equal(await controller.start(course), "tx-retry");
});

test("a failed start for a new course does not relabel an exportable old transcript", async () => {
  let starts = 0;
  const transport = {
    startTranscription: async () => {
      starts += 1;
      if (starts === 2) throw new Error("helper unavailable");
      return { session_id: "tx-old" };
    },
    streamTranscription: async (_sessionId, { onEvent }) => {
      onEvent({ type: "segment", start: 1, end: 2, text: "旧课程内容" });
    },
    stopTranscription: async () => ({}),
  };
  const controller = createTranscriptionController({ transport });
  await controller.start({ course_id: "old", sub_id: "one", name: "旧课程" });
  await controller.waitForStream();
  await controller.stop();

  await assert.rejects(controller.start({ course_id: "new", sub_id: "two", name: "新课程" }), /helper unavailable/);
  const markdown = controller.exportMarkdown({ download: false });
  assert.match(markdown, /课程：旧课程/);
  assert.match(markdown, /课程 ID：old/);
  assert.match(markdown, /旧课程内容/);
});

test("controller stores normalized segment display text and exports the same normalized text", async () => {
  const transport = {
    startTranscription: async () => ({ session_id: "tx-text" }),
    streamTranscription: async (_sessionId, { onEvent }) => {
      onEvent({ type: "segment", start: 1, end: 2, text: "　ＱＵＩＺ\n请   签 到　" });
    },
    stopTranscription: async () => ({}),
  };
  const controller = createTranscriptionController({ transport });
  await controller.start({ course_id: "37142", sub_id: "659200" });
  await controller.waitForStream();
  const expected = "QUIZ 请 签 到";

  assert.equal(controller.snapshot().transcript[0].text, expected);
  assert.match(controller.exportMarkdown({ download: false }), new RegExp(expected));
});
