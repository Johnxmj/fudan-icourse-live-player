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
    "ment\",\"start\":62,\"end\":64.5,\"text\":\"请 签到\",\"private\":\"nope\"}\n\n",
    "event: transcript\ndata: {\"type\":\"error\",\"code\":\"AUDIO_UNAVAILABLE\",\"message\":\"Audio unavailable\",\"stack\":\"secret\"}\n\n",
    "event: unknown\ndata: {\"type\":\"segment\",\"text\":\"ignore\"}\n\n",
  ]), { onEvent: (event) => events.push(event) });

  assert.deepEqual(events, [
    { type: "segment", start: 62, end: 64.5, text: "请 签到" },
    { type: "error", code: "AUDIO_UNAVAILABLE", message: "Audio unavailable" },
  ]);
});

test("markdown contains escaped alerts and timestamps but no connection data", () => {
  const markdown = buildTranscriptMarkdown({
    course: { course_id: "37142", sub_id: "659200", name: "课程 | 名称" },
    sessionId: "tx-1",
    settings: { model: "base", language: "zh" },
    alerts: [{ keyword: "签到|quiz", timestamp: 62, text: "请 | 签到" }],
    transcript: [{ start: 62, end: 64, text: "请 | 签到" }],
    exportedAt: new Date("2026-09-15T00:00:00Z"),
    media_token: "must-not-export",
    bootstrap: "must-not-export",
    bridge: "http://127.0.0.1:4310",
  });

  assert.match(markdown, /## 告警记录/);
  assert.match(markdown, /\[00:01:02\]/);
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
  const controller = createTranscriptionController({ transport, storage, now: () => 0 });
  controller.updateSettings({ keywords: ["签到", " 签 到 "] });
  await controller.start({ course_id: "37142", sub_id: "659200", name: "课程" });
  await controller.waitForStream();
  const snapshot = controller.snapshot();

  assert.deepEqual(writes, [[SETTINGS_KEY, {
    model: "base", language: "zh", keywords: ["签到"], pageAlert: true, soundAlert: true, systemAlert: true,
  }]]);
  assert.equal(snapshot.transcript[0].text, "现在请签到");
  assert.deepEqual(snapshot.alerts, [{ keyword: "签到", timestamp: 62, text: "现在请签到" }]);
  assert.throws(() => snapshot.transcript.push({}), TypeError);
  assert.throws(() => { snapshot.transcript[0].text = "mutated"; }, TypeError);
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
