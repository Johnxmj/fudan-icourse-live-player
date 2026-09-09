const DEFAULT_HEADERS = {
  Accept: "application/json",
};

function normalizeBaseUrl(baseUrl, fallbackUrl) {
  const candidate = String(baseUrl || "").trim();
  if (!candidate) {
    return new URL(fallbackUrl);
  }
  return new URL(candidate, fallbackUrl);
}

function joinUrl(baseUrl, path) {
  const base = baseUrl instanceof URL ? baseUrl : new URL(baseUrl);
  const rel = String(path || "").replace(/^\//, "");
  return new URL(rel, base);
}

function withQuery(url, params = {}) {
  const next = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).trim()) {
      next.searchParams.set(key, String(value));
    }
  }
  return next;
}

function readErrorMessage(payload, fallback) {
  if (!payload || typeof payload !== "object") {
    return fallback;
  }
  const message = payload?.error?.message;
  return typeof message === "string" && message.trim() ? message : fallback;
}

async function parseResponse(response) {
  const contentType = response.headers?.get?.("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

export function createLocalTransport(baseUrl, token, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is required for the local transport");
  }

  const fallbackUrl = globalThis.location?.origin && globalThis.location.origin !== "null"
    ? globalThis.location.origin
    : "http://127.0.0.1:8000";
  const base = normalizeBaseUrl(baseUrl, fallbackUrl);
  const authHeader = token ? { Authorization: `Bearer ${token}` } : {};

  async function request(path, init = {}) {
    const url = joinUrl(base, path).toString();
    const headers = {
      ...DEFAULT_HEADERS,
      ...authHeader,
      ...(init.headers || {}),
    };
    const response = await fetchImpl(url, {
      ...init,
      headers,
    });

    if (!response.ok) {
      let payload = null;
      try {
        payload = await parseResponse(response);
      } catch {
        payload = null;
      }
      const fallback = `Local request failed with ${response.status}`;
      const message = readErrorMessage(payload, fallback);
      const error = new Error(message);
      error.status = response.status;
      error.code = payload?.error?.code || null;
      error.url = url;
      throw error;
    }

    return response;
  }

  async function requestJson(path, init = {}) {
    try {
      const response = await request(path, {
        ...init,
        headers: {
          Accept: "application/json",
          ...(init.headers || {}),
        },
      });
      return response.json();
    } catch (error) {
      if (path === "/api/live-courses" && error?.status === 404 && error?.code === "NO_LIVE_COURSES") {
        return [];
      }
      throw error;
    }
  }

  async function requestText(path, init = {}) {
    const response = await request(path, init);
    return response.text();
  }

  return {
    baseUrl: base.origin,
    listLiveCourses() {
      return requestJson("/api/live-courses");
    },
    refreshLiveCourses() {
      return requestJson("/api/live-courses");
    },
    requestJson,
    requestText,
    manifestUrl(courseId, subId, view, mediaToken = "") {
      const url = joinUrl(base, `/media/${encodeURIComponent(courseId)}/${encodeURIComponent(subId)}/${encodeURIComponent(view)}/manifest.m3u8`);
      return withQuery(url, { media_token: mediaToken }).toString();
    },
    segmentUrl(segmentToken, mediaToken = "") {
      const url = joinUrl(base, `/media/segment/${encodeURIComponent(segmentToken)}`);
      return withQuery(url, { media_token: mediaToken }).toString();
    },
  };
}
