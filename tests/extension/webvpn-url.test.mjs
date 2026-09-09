import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { toWebVpnUrl } from "../../edge_extension/src/webvpn-url.js";

test("maps public icourse URL exactly like Python adapter", () => {
  assert.equal(toWebVpnUrl("https://icourse.fudan.edu.cn/path?q=1"), "https://webvpn.fudan.edu.cn/https/77726476706e69737468656265737421f9f44e8935236d1e781d8dad961b2631a501f26f/path?q=1");
});
test("rejects non-icourse hosts", () => assert.throws(() => toWebVpnUrl("https://example.invalid/x"), /unsupported hostname/));

test('URL adapter runs in the browser without Node imports or globals', () => {
  const source = readFileSync('edge_extension/src/webvpn-url.js', 'utf8').replace(/export /g, '');
  const context = vm.createContext({ URL });
  vm.runInContext(source, context);
  assert.equal(vm.runInContext("toWebVpnUrl('https://icourse.fudan.edu.cn/path?q=1')", context), toWebVpnUrl('https://icourse.fudan.edu.cn/path?q=1'));
});
