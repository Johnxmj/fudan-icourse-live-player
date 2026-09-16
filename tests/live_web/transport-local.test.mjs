import test from "node:test";
import assert from "node:assert/strict";

import { createLocalTransport } from "../../live_player/web/transport-local.js";

test("builds authorized local requests", async () => {
  const calls = [];
  const transport = createLocalTransport("http://127.0.0.1:4310", "session-token", {
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => [{ course_id: "1001" }],
        text: async () => "ok",
      };
    },
  });

  const courses = await transport.listLiveCourses();

  assert.deepEqual(courses, [{ course_id: "1001" }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:4310/api/live-courses");
  assert.equal(calls[0].init.headers.Authorization, "Bearer session-token");
  assert.equal(calls[0].init.headers.Accept, "application/json");
});

test("returns an empty catalog for NO_LIVE_COURSES", async () => {
  const transport = createLocalTransport("http://127.0.0.1:4310", "session-token", {
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      headers: {
        get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json" : null),
      },
      json: async () => ({
        error: {
          code: "NO_LIVE_COURSES",
          message: "No courses are live now",
        },
      }),
      text: async () => "not used",
    }),
  });

  const courses = await transport.listLiveCourses();

  assert.deepEqual(courses, []);
});

test("threads an opaque media token into manifest URLs", () => {
  const transport = createLocalTransport("http://127.0.0.1:4310", "session-token", {
    fetchImpl: async () => {
      throw new Error("fetch not expected");
    },
  });

  const url = transport.manifestUrl("1001", "s1", "teacher", "media-token");

  assert.equal(
    url,
    "http://127.0.0.1:4310/media/1001/s1/teacher/manifest.m3u8?media_token=media-token",
  );
});

test("local transport authenticates transcription start, stream, and stop", async () => {
  const calls = [];
  const transport = createLocalTransport("http://127.0.0.1:4310", "session-token", {
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => url.endsWith("/start") ? { session_id: "tx-1" } : {},
        text: async () => "",
        body: new ReadableStream({ start(controller) { controller.close(); } }),
      };
    },
  });

  await transport.startTranscription({ course_id: "37142", sub_id: "659200", model: "base", language: "zh" });
  await transport.streamTranscription("tx-1", { onEvent() {} });
  await transport.stopTranscription("tx-1");

  assert.equal(calls[0].url, "http://127.0.0.1:4310/api/transcription/start");
  assert.equal(calls[0].init.headers.Authorization, "Bearer session-token");
  assert.deepEqual(JSON.parse(calls[0].init.body), { course_id: "37142", sub_id: "659200", model: "base", language: "zh" });
  assert.equal(calls[1].url, "http://127.0.0.1:4310/api/transcription/events/tx-1");
  assert.equal(calls[1].init.headers.Authorization, "Bearer session-token");
  assert.equal(calls[2].url, "http://127.0.0.1:4310/api/transcription/stop");
  assert.deepEqual(JSON.parse(calls[2].init.body), { session_id: "tx-1" });
});

test("local transcription errors retain stable status and code fields", async () => {
  const transport = createLocalTransport("http://127.0.0.1:4310", "session-token", {
    fetchImpl: async () => ({
      ok: false,
      status: 409,
      headers: { get: () => "application/json" },
      json: async () => ({ error: { code: "TRANSCRIPTION_BUSY", message: "Already active" } }),
      text: async () => "not used",
    }),
  });

  await assert.rejects(transport.startTranscription({}), (error) => (
    error.status === 409 && error.code === "TRANSCRIPTION_BUSY" && error.message === "Already active"
  ));
});
