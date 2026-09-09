const PAGES_ORIGIN = "https://johnxmj.github.io";

export function parseBridge(location) {
  try {
    const hash = typeof location?.hash === "string" ? location.hash : "";
    const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
    const raw = params.get("bridge");
    if (!raw) throw new TypeError("bridge is required");
    const base = new URL(raw);
    if (base.protocol !== "http:" || !new Set(["127.0.0.1", "[::1]"]).has(base.hostname)) {
      throw new TypeError("bridge must use loopback");
    }
    const bootstrap = params.get("bootstrap");
    if (!bootstrap) throw new TypeError("bootstrap token is required");
    return { baseUrl: base.origin, bootstrap };
  } catch (error) {
    clearPairingFragment(location);
    throw error;
  }
}

function clearPairingFragment(location) {
  if (!location || typeof location !== "object") return;
  const cleanUrl = `${location.pathname || ""}${location.search || ""}`;
  try {
    globalThis.history?.replaceState?.({}, "", cleanUrl);
  } catch (_) {
    // Fall back below when the history API is unavailable or rejects the URL.
  }
  if (typeof location.hash === "string" && location.hash) {
    try {
      location.hash = "";
    } catch (_) {
      // A non-browser test location may expose a read-only hash.
    }
  }
}

export function createLocalTransport(location = globalThis.location, fetcher = globalThis.fetch) {
  if (typeof fetcher !== "function") throw new Error("fetch is required for the local transport");
  const pairing = parseBridge(location);
  let token = null;
  let state = "connecting";
  const baseUrl = pairing.baseUrl;
  let bootstrap = pairing.bootstrap;
  clearPairingFragment(location);
  const request = async (path, init = {}) => {
    const headers = { Accept: "application/json", ...(init.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetcher(new URL(path, baseUrl).toString(), { ...init, headers });
    if (!response.ok) {
      const payload = await response.json?.().catch?.(() => null);
      const error = new Error(payload?.error?.message || `Local request failed with ${response.status}`);
      error.status = response.status; error.code = payload?.error?.code;
      throw error;
    }
    return response;
  };
  const connect = (async () => {
    try {
      const response = await request("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bootstrap_token: bootstrap }) });
      const payload = await response.json();
      if (!payload?.token) throw new Error("Session token missing");
      token = payload.token;
      state = "ready";
    } catch (error) { state = error?.status === 401 ? "login-required" : "disconnected"; throw error; }
    finally { bootstrap = null; }
  })();
  const json = async (path) => { await connect; const payload = await (await request(path)).json(); return payload; };
  return {
    name: "local", baseUrl, ready: connect,
    probe: async () => { try { await connect; return true; } catch { return false; } },
    listLive: async () => { const result = await json("/api/live-courses"); return Array.isArray(result) ? result : []; },
    listLiveCourses: async () => { const result = await json("/api/live-courses"); return Array.isArray(result) ? result : []; },
    refreshLiveCourses: async () => { const result = await json("/api/live-courses"); return Array.isArray(result) ? result : []; },
    requestJson: json,
    manifestUrl(courseId, subId, view, mediaToken = "") { const url = new URL(`/media/${encodeURIComponent(courseId)}/${encodeURIComponent(subId)}/${encodeURIComponent(view)}/manifest.m3u8`, baseUrl); if (mediaToken) url.searchParams.set("media_token", mediaToken); return url.toString(); },
    segmentUrl(segmentToken, mediaToken = "") { const url = new URL(`/media/segment/${encodeURIComponent(segmentToken)}`, baseUrl); if (mediaToken) url.searchParams.set("media_token", mediaToken); return url.toString(); },
    getState: () => state,
    get state() { return state; },
  };
}

export default createLocalTransport;
