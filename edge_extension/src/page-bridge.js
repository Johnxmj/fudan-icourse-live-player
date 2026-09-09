// Deliberately tiny page/content-script bridge. It exposes public live metadata
// only; cookies, bearer tokens, and media URLs never cross into the page world.
(function installPageBridge(global) {
  "use strict";

  const PAGE_ORIGIN = "https://johnxmj.github.io";
  const SOURCE = "fudan-icourse-live-player";
  const VERSION = 1;
  const HELLO = "PAGE_BRIDGE_HELLO";
  const READY = "PAGE_BRIDGE_READY";
  const REQUEST = "PAGE_BRIDGE_REQUEST";
  const RESPONSE = "PAGE_BRIDGE_RESPONSE";
  const ALLOWED_REQUESTS = new Set(["CAPABILITIES", "LIST_LIVE", "REFRESH"]);
  const SAFE_STATES = new Set(["unknown", "ready", "unconfigured", "login-required", "failed", "empty"]);
  const SAFE_VIEWS = new Set(["teacher", "student", "teacher_audio", "student_audio"]);
  const SAFE_NONCE = /^[A-Za-z0-9._:-]{1,256}$/;
  const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
  const COURSE_KEYS = [
    "course_id", "course_title", "teacher", "room", "sub_id", "sub_title",
    "starts_at", "ends_at", "status", "available_views",
  ];

  function scalar(value) {
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? value
      : "";
  }

  function safeCourse(course) {
    const source = course && typeof course === "object" && !Array.isArray(course) ? course : {};
    return Object.fromEntries(COURSE_KEYS.map((key) => {
      if (key === "available_views") {
        const views = Array.isArray(source[key])
          ? source[key].filter((view) => typeof view === "string" && SAFE_VIEWS.has(view))
          : [];
        return [key, views];
      }
      return [key, scalar(source[key])];
    }));
  }

  function safePlayerFrame(value) {
    if (typeof value !== "string") return "";
    try {
      const url = new URL(value);
      return url.protocol === "chrome-extension:" && url.pathname === "/player/index.html"
        ? url.toString()
        : "";
    } catch (_) {
      return "";
    }
  }

  function safeError(error) {
    const code = typeof error?.code === "string" && /^[A-Z_]{1,64}$/.test(error.code)
      ? error.code
      : "REQUEST_FAILED";
    return { code, message: "播放助手请求失败" };
  }

  function safeResponse(requestType, response) {
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      return { error: safeError(null) };
    }
    if (response.error) return { error: safeError(response.error) };
    const result = { version: VERSION };
    if (SAFE_STATES.has(response.state)) result.state = response.state;
    if (requestType === "CAPABILITIES") {
      const capabilities = response.capabilities;
      if (capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)) {
        result.capabilities = {
          live: capabilities.live === true,
          refresh: capabilities.refresh === true,
        };
      }
      const playerFrame = safePlayerFrame(response.playerFrame);
      if (playerFrame) result.playerFrame = playerFrame;
      return result;
    }
    if (requestType === "LIST_LIVE" || requestType === "REFRESH") {
      const courses = Array.isArray(response.courses) ? response.courses : [];
      result.courses = courses.map(safeCourse);
    }
    return result;
  }

  function isSafeEnvelope(data, type) {
    return Boolean(
      data && typeof data === "object" && !Array.isArray(data)
      && data.source === SOURCE && data.version === VERSION && data.type === type,
    );
  }

  function post(message) {
    global.postMessage({ source: SOURCE, version: VERSION, ...message }, PAGE_ORIGIN);
  }

  let activeNonce = null;
  const pending = new Set();

  global.addEventListener("message", (event) => {
    if (event.source !== global || event.origin !== PAGE_ORIGIN) return;
    const data = event.data;
    if (!data || typeof data !== "object" || data.source !== SOURCE || data.version !== VERSION) return;

    if (data.type === HELLO) {
      if (typeof data.nonce !== "string" || !SAFE_NONCE.test(data.nonce)) return;
      activeNonce = data.nonce;
      post({ type: READY, nonce: activeNonce });
      return;
    }

    if (!isSafeEnvelope(data, REQUEST) || data.nonce !== activeNonce) return;
    if (typeof data.requestId !== "string" || !SAFE_REQUEST_ID.test(data.requestId)) return;
    if (pending.has(data.requestId)) return;

    const request = data.request;
    if (!request || typeof request !== "object" || Array.isArray(request)) return;
    const requestType = request.type;
    if (request.version !== VERSION || !ALLOWED_REQUESTS.has(requestType)) return;
    if (!request.payload || typeof request.payload !== "object" || Array.isArray(request.payload)) return;
    if (Object.keys(request.payload).length !== 0) return;

    pending.add(data.requestId);
    Promise.resolve(global.chrome?.runtime?.sendMessage?.(request))
      .then((response) => post({
        type: RESPONSE,
        nonce: activeNonce,
        requestId: data.requestId,
        ok: true,
        payload: safeResponse(requestType, response),
      }))
      .catch(() => post({
        type: RESPONSE,
        nonce: activeNonce,
        requestId: data.requestId,
        ok: false,
        payload: { error: safeError(null) },
      }))
      .finally(() => pending.delete(data.requestId));
  });
})(window);
