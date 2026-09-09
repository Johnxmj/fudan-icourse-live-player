const WEBVPN_BASE = "https://webvpn.fudan.edu.cn";
// This route prefix is deterministic for the one host this extension supports.
// Keep the browser runtime free of Node-only crypto imports.
const IV_HEX = "77726476706e69737468656265737421";
const ENCRYPTED_ALLOWED_HOST = "f9f44e8935236d1e781d8dad961b2631a501f26f";
const ALLOWED_HOST = "icourse.fudan.edu.cn";

/** Convert an iCourse URL to its fixed Fudan WebVPN route. */
export function toWebVpnUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError("invalid URL"); }
  if (parsed.hostname !== ALLOWED_HOST) throw new TypeError("unsupported hostname");
  const protocol = parsed.protocol.slice(0, -1);
  const port = parsed.port && !((protocol === "https" && parsed.port === "443") || (protocol === "http" && parsed.port === "80"))
    ? `-${parsed.port}` : "";
  const suffix = `${parsed.pathname.replace(/^\//, "")}${parsed.search}${parsed.hash}`;
  const encoded = `${IV_HEX}${ENCRYPTED_ALLOWED_HOST}`;
  return `${WEBVPN_BASE}/${protocol}${port}/${encoded}${suffix ? `/${suffix}` : ""}`;
}

export const WEBVPN_PREFIX = `${WEBVPN_BASE}/https/${IV_HEX}${ENCRYPTED_ALLOWED_HOST}`;
