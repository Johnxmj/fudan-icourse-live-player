import test from "node:test";
import assert from "node:assert/strict";
import { parseRequest, safeCourse } from "../../edge_extension/src/protocol.js";

test("rejects messages with a different protocol version", () => {
  assert.throws(() => parseRequest({ version: 2, type: "LIST_LIVE" }), /protocol version/);
});

test("safe course payload omits every source field", () => {
  const safe = safeCourse({ course_id: "1", sub_id: "2", course_title: "Analysis", live_url: { output: "secret" } });
  assert.deepEqual(Object.keys(safe).sort(), ["available_views", "course_id", "course_title", "ends_at", "room", "starts_at", "status", "sub_id", "sub_title", "teacher"]);
  assert.equal(JSON.stringify(safe).includes("secret"), false);
});

test("safe course only exposes whitelisted available views", () => {
  const safe = safeCourse({
    available_views: [
      "teacher",
      "student",
      "teacher_audio",
      "student_audio",
      "teacher_hd",
      "https://signed.example/audio.m3u8",
    ],
  });
  assert.deepEqual(safe.available_views, ["teacher", "student", "teacher_audio", "student_audio"]);
});

test("rejects unsupported message types", () => {
  assert.throws(() => parseRequest({ version: 1, type: "LOGIN_REQUIRED" }), /message type/);
});

test("normalizes missing payload to an empty object", () => {
  assert.deepEqual(parseRequest({ version: 1, type: "LIST_LIVE" }), { version: 1, type: "LIST_LIVE", payload: {} });
});

test("safe course sanitizes nested values and view names", () => {
  const safe = safeCourse({ course_id: { secret: "x" }, available_views: ["teacher", { secret: "y" }, 3] });
  assert.equal(safe.course_id, "");
  assert.deepEqual(safe.available_views, ["teacher"]);
  assert.equal(JSON.stringify(safe).includes("secret"), false);
});

test("accepts OPEN_PLAYER payloads with only whitelisted keys", () => {
  assert.deepEqual(
    parseRequest({
      version: 1,
      type: "OPEN_PLAYER",
      payload: { courseId: "38463", subId: "655212", view: "teacher_audio" },
    }),
    {
      version: 1,
      type: "OPEN_PLAYER",
      payload: { courseId: "38463", subId: "655212", view: "teacher_audio" },
    },
  );
});

test("accepts OPEN_PLAYER payloads with stable alphanumeric ids", () => {
  assert.deepEqual(
    parseRequest({
      version: 1,
      type: "OPEN_PLAYER",
      payload: { courseId: "A1b2C3", subId: "s9Z8", view: "student" },
    }),
    {
      version: 1,
      type: "OPEN_PLAYER",
      payload: { courseId: "A1b2C3", subId: "s9Z8", view: "student" },
    },
  );
});

test("rejects OPEN_PLAYER payloads with extra fields", () => {
  assert.throws(
    () => parseRequest({
      version: 1,
      type: "OPEN_PLAYER",
      payload: {
        courseId: "38463",
        subId: "655212",
        view: "teacher",
        sourceUrl: "https://signed.example/manifest.m3u8",
        token: "signed-token",
      },
    }),
    /payload/,
  );
});

test("rejects OPEN_PLAYER payloads with URL-like ids and views", () => {
  assert.throws(
    () => parseRequest({
      version: 1,
      type: "OPEN_PLAYER",
      payload: {
        courseId: "https://example.invalid/course",
        subId: "token/with/slash",
        view: "https://example.invalid/view",
      },
    }),
    /payload/,
  );
});

test("rejects SET_VIEW payloads with URL-like views", () => {
  assert.throws(
    () => parseRequest({
      version: 1,
      type: "SET_VIEW",
      payload: { view: "https://example.invalid/view" },
    }),
    /payload/,
  );
});
