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

test("loads the persistent followed catalog from the local helper", async () => {
  const calls = [];
  const transport = createLocalTransport("http://127.0.0.1:4310", "session", {
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, headers: { get: () => "application/json" }, json: async () => [{ course_id: "1001", status: "offline" }] };
    },
  });
  assert.deepEqual(await transport.listFollowedCourses(), [{ course_id: "1001", status: "offline" }]);
  assert.equal(calls[0], "http://127.0.0.1:4310/api/followed-courses");
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
