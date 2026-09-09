import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("pins Hls.js v1.5.18 in the vendored bundle", async () => {
  const bundle = await readFile(new URL("../../live_player/web/vendor/hls.min.js", import.meta.url), "utf8");
  assert.match(bundle, /1\.5\.18/);
});
