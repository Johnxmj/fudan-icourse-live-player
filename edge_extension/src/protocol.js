/** Versioned, transport-safe protocol shared by the Edge extension surfaces. */
export const PROTOCOL_VERSION = 1;

export const CAPABILITIES = "CAPABILITIES";
export const LIST_LIVE = "LIST_LIVE";
export const OPEN_PLAYER = "OPEN_PLAYER";
export const SET_VIEW = "SET_VIEW";
export const REFRESH = "REFRESH";
export const LOGIN_REQUIRED = "LOGIN_REQUIRED";
export const ERROR = "ERROR";

const REQUEST_TYPES = new Set([CAPABILITIES, LIST_LIVE, OPEN_PLAYER, SET_VIEW, REFRESH]);
const SAFE_VIEWS = new Set(["teacher", "student", "teacher_audio", "student_audio"]);
const SAFE_ID = /^[A-Za-z0-9]{1,64}$/;
const REQUEST_PAYLOAD_KEYS = new Map([
  [CAPABILITIES, []],
  [LIST_LIVE, []],
  [OPEN_PLAYER, ["courseId", "subId", "view"]],
  [SET_VIEW, ["view"]],
  [REFRESH, []],
]);
const COURSE_KEYS = [
  "course_id", "course_title", "teacher", "room", "sub_id", "sub_title",
  "starts_at", "ends_at", "status", "available_views",
];

function scalar(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : "";
}

function isSafeId(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}

function isSafeView(value) {
  return typeof value === "string" && SAFE_VIEWS.has(value);
}

function validatePayload(type, payload) {
  const allowedKeys = REQUEST_PAYLOAD_KEYS.get(type);
  if (!allowedKeys) throw new TypeError("unsupported message type");
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const keys = Object.keys(source);
  if (keys.some((key) => !allowedKeys.includes(key))) {
    throw new TypeError("invalid payload");
  }
  if (allowedKeys.length && allowedKeys.some((key) => !Object.prototype.hasOwnProperty.call(source, key))) {
    throw new TypeError("invalid payload");
  }
  if (!allowedKeys.length && keys.length) {
    throw new TypeError("invalid payload");
  }
  if (type === OPEN_PLAYER) {
    if (!isSafeId(source.courseId) || !isSafeId(source.subId) || !isSafeView(source.view)) {
      throw new TypeError("invalid payload");
    }
  }
  if (type === SET_VIEW && !isSafeView(source.view)) {
    throw new TypeError("invalid payload");
  }
  return source;
}

/** Parse an extension request while enforcing the protocol version and type set. */
export function parseRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== PROTOCOL_VERSION) {
    throw new TypeError("unsupported protocol version");
  }
  if (!REQUEST_TYPES.has(value.type)) throw new TypeError("unsupported message type");
  const payload = validatePayload(value.type, value.payload);
  return {
    version: PROTOCOL_VERSION,
    type: value.type,
    payload,
  };
}

/** Serialize only public course metadata; upstream/source fields never cross this boundary. */
export function safeCourse(course = {}) {
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
