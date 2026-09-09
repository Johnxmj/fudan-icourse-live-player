import crypto from "node:crypto";

const WEBVPN_BASE = "https://webvpn.fudan.edu.cn";
const AES_KEY = Buffer.from("wrdvpnisthebest!", "utf8");
const IV_HEX = AES_KEY.toString("hex");
const ALLOWED_HOST = "icourse.fudan.edu.cn";

function encryptHost(hostname) {
  const cipher = crypto.createCipheriv("aes-128-cfb", AES_KEY, AES_KEY);
  return Buffer.concat([cipher.update(hostname, "utf8"), cipher.final()]).toString("hex");
}

/** Convert an iCourse URL to its fixed Fudan WebVPN route. */
export function toWebVpnUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError("invalid URL"); }
  if (parsed.hostname !== ALLOWED_HOST) throw new TypeError("unsupported hostname");
  const protocol = parsed.protocol.slice(0, -1);
  const port = parsed.port && !((protocol === "https" && parsed.port === "443") || (protocol === "http" && parsed.port === "80"))
    ? `-${parsed.port}` : "";
  const suffix = `${parsed.pathname.replace(/^\//, "")}${parsed.search}${parsed.hash}`;
  const encoded = `${IV_HEX}${encryptHost(parsed.hostname)}`;
  return `${WEBVPN_BASE}/${protocol}${port}/${encoded}${suffix ? `/${suffix}` : ""}`;
}

export const WEBVPN_PREFIX = `${WEBVPN_BASE}/https/${IV_HEX}${encryptHost(ALLOWED_HOST)}`;
