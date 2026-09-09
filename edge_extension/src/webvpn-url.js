const WEBVPN_BASE = "https://webvpn.fudan.edu.cn";
const ALLOWED_HOST = "icourse.fudan.edu.cn";
// Public, fixed routing identifier for the only supported upstream host.
// Keeping it fixed lets this module run in a browser service worker.
const ENCODED_HOST = "77726476706e69737468656265737421f9f44e8935236d1e781d8dad961b2631a501f26f";

/** Convert an iCourse URL to its fixed Fudan WebVPN route. */
export function toWebVpnUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError("invalid URL"); }
  if (parsed.hostname !== ALLOWED_HOST) throw new TypeError("unsupported hostname");
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new TypeError('unsupported protocol');
  const protocol = parsed.protocol.slice(0, -1);
  const port = parsed.port && !((protocol === "https" && parsed.port === "443") || (protocol === "http" && parsed.port === "80"))
    ? `-${parsed.port}` : "";
  const suffix = `${parsed.pathname.replace(/^\//, "")}${parsed.search}${parsed.hash}`;
  return `${WEBVPN_BASE}/${protocol}${port}/${ENCODED_HOST}${suffix ? `/${suffix}` : ""}`;
}

export const WEBVPN_PREFIX = `${WEBVPN_BASE}/https/${ENCODED_HOST}`;
