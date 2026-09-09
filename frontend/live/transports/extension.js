const PROTOCOL_VERSION = 1;
const SAFE_VIEWS = new Set(["teacher", "student", "teacher_audio", "student_audio"]);
const SAFE_ID = /^[A-Za-z0-9]{1,64}$/;
const SAFE_EXTENSION_ID = /^[a-p]{32}$/;
const SAFE_NONCE = /^[A-Za-z0-9._:-]{1,256}$/;
const COURSE_KEYS = [
  "course_id", "course_title", "teacher", "room", "sub_id", "sub_title",
  "starts_at", "ends_at", "status", "available_views",
];

function nonceValue() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function scalar(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : "";
}

function safeCourse(course = {}) {
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

function safeId(value) {
  const normalized = typeof value === "string" ? value : "";
  return SAFE_ID.test(normalized) ? normalized : "";
}

function responseState(result) {
  if (result?.state === "login-required" || result?.state === "failed" || result?.state === "empty") {
    return result.state;
  }
  if (result?.state === "ready") return "connected";
  if (result && !result.error && (
    result.version === PROTOCOL_VERSION
    || result.capabilities
    || result.state
  )) return "connected";
  return "failed";
}

export function createExtensionTransport({ extensionId, runtime, windowRef = globalThis } = {}) {
  if (typeof extensionId !== "string" || !SAFE_EXTENSION_ID.test(extensionId)) {
    throw new TypeError("extensionId is required");
  }
  const origin = `chrome-extension://${extensionId}`;
  const send = (type, payload) => {
    if (typeof runtime?.sendMessage !== "function") return Promise.resolve(null);
    return Promise.resolve(runtime.sendMessage(extensionId, {
      version: PROTOCOL_VERSION,
      type,
      ...(payload === undefined ? {} : { payload }),
    }));
  };
  let mounted = null;
  let currentState = "unknown";

  return {
    name: "extension",
    origin,
    probe: async () => {
      try {
        const result = await send("CAPABILITIES");
        if (!result || result.error || !(
          result.version === PROTOCOL_VERSION
          || result.capabilities
          || result.state
        )) return false;
        currentState = responseState(result);
        return true;
      } catch (_) {
        currentState = "failed";
        return false;
      }
    },
    listLive: async () => {
      const result = await send("LIST_LIVE");
      const courses = Array.isArray(result) ? result : (Array.isArray(result?.courses) ? result.courses : []);
      currentState = responseState(result);
      if (currentState === "connected" && courses.length === 0) currentState = "empty";
      return courses.map(safeCourse);
    },
    mountPlayer(container, course = {}, view = "teacher") {
      if (!container) throw new TypeError("container is required");
      if (!SAFE_VIEWS.has(view)) view = "teacher";
      const documentRef = container.ownerDocument || globalThis.document;
      if (!documentRef?.createElement) throw new Error("document unavailable");
      const frame = documentRef.createElement("iframe");
      frame.src = `${origin}/player/index.html`;
      frame.allow = "autoplay; fullscreen";
      if (mounted?.dispose) mounted.dispose();
      const state = {
        frame,
        nonce: nonceValue(),
        helloNonce: null,
        ready: false,
        view,
      };
      const safe = safeCourse(course);
      const courseId = safeId(course.courseId ?? safe.course_id);
      const subId = safeId(course.subId ?? safe.sub_id);
      if (!courseId || !subId) throw new TypeError("course identifiers are required");
      const sendFrame = (message) => frame.contentWindow?.postMessage?.({
        version: PROTOCOL_VERSION,
        ...message,
      }, origin);
      const onMessage = (event) => {
        const data = event?.data;
        if (event?.origin !== origin || event?.source !== frame.contentWindow) return;
        if (data?.version !== PROTOCOL_VERSION || typeof data?.type !== "string") return;
        if (data.type === "LIVE_PLAYER_HELLO") {
          if (!SAFE_NONCE.test(data.nonce)) return;
          state.ready = false;
          state.helloNonce = data.nonce;
          sendFrame({
            type: "PLAYER_CHALLENGE",
            nonce: state.nonce,
            helloNonce: state.helloNonce,
          });
          return;
        }
        if (
          data.type !== "LIVE_PLAYER_READY"
          || data.nonce !== state.nonce
          || data.helloNonce !== state.helloNonce
        ) return;
        state.ready = true;
        sendFrame({
          type: "PLAYER_INIT",
          courseId,
          subId,
          view: state.view,
          nonce: state.nonce,
          helloNonce: state.helloNonce,
        });
      };
      windowRef?.addEventListener?.("message", onMessage);
      const onLoad = () => {
        if (state.helloNonce) {
          sendFrame({
            type: "PLAYER_CHALLENGE",
            nonce: state.nonce,
            helloNonce: state.helloNonce,
          });
        }
      };
      frame.addEventListener?.("load", onLoad);
      container.replaceChildren(frame);
      state.dispose = () => {
        windowRef?.removeEventListener?.("message", onMessage);
        frame.removeEventListener?.("load", onLoad);
      };
      state.setView = (nextView) => {
        if (!SAFE_VIEWS.has(nextView)) return false;
        state.view = nextView;
        if (state.ready) sendFrame({ type: "SET_VIEW", view: nextView, nonce: state.nonce, helloNonce: state.helloNonce });
        return true;
      };
      mounted = state;
      return state;
    },
    setView(view) { return mounted?.setView?.(view) ?? false; },
    refresh: async () => {
      const result = await send("REFRESH");
      currentState = responseState(result);
      return result;
    },
    getState() { return currentState; },
    get state() { return currentState; },
  };
}

export default createExtensionTransport;
