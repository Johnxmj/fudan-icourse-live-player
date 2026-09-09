import test from "node:test";
import assert from "node:assert/strict";
import { toWebVpnUrl } from "../../edge_extension/src/webvpn-url.js";

test("maps public icourse URL exactly like Python adapter", () => {
  assert.equal(toWebVpnUrl("https://icourse.fudan.edu.cn/path?q=1"), "https://webvpn.fudan.edu.cn/https/77726476706e69737468656265737421f9f44e8935236d1e781d8dad961b2631a501f26f/path?q=1");
});
test("rejects non-icourse hosts", () => assert.throws(() => toWebVpnUrl("https://example.invalid/x"), /unsupported hostname/));
