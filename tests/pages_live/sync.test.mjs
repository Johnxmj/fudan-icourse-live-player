import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkSync } from "../../scripts/sync_live_web.mjs";

test("Pages vendor assets match the local player", () => {
  assert.deepEqual(checkSync(), []);
  for (const name of ["hls.min.js", "LICENSE"]) {
    const source = readFileSync(`live_player/web/vendor/${name}`);
    const target = readFileSync(`frontend/live/vendor/${name}`);
    assert.equal(createHash("sha256").update(source).digest("hex"), createHash("sha256").update(target).digest("hex"));
  }
});
