export const SETTINGS_KEY = "live-player.transcription-settings.v1";
export const DEFAULT_KEYWORDS = Object.freeze(["点名", "签到", "小测", "测验", "期中", "期末", "quiz"]);
export const DEFAULT_SETTINGS = Object.freeze({
  model: "base",
  language: "zh",
  keywords: DEFAULT_KEYWORDS,
  pageAlert: true,
  soundAlert: true,
  systemAlert: true,
});

const HAN = /\p{Script=Han}/u;
const SAFE_TYPES = new Set(["state", "segment", "lag", "ended", "error"]);
const SAFE_STATES = new Set([
  "downloading-model", "loading-model", "connecting-audio", "listening",
  "delayed", "stopped", "live-ended", "error",
]);

function normalizeText(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function keywordComparable(value) {
  const normalized = normalizeText(value).toLocaleLowerCase("en-US");
  return HAN.test(normalized) ? normalized.replace(/\s+/gu, "") : normalized;
}

function safeString(value, maxLength = 8000) {
  return typeof value === "string" && value.length <= maxLength ? value : null;
}

function safeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeRecord(record) {
  if (!record || typeof record !== "object" || !SAFE_TYPES.has(record.type)) return null;
  if (record.type === "segment") {
    const start = safeNumber(record.start);
    const end = safeNumber(record.end);
    const text = safeString(record.text);
    if (start === null || end === null || start < 0 || end < start || !text) return null;
    return { type: "segment", start, end, text };
  }
  if (record.type === "state") {
    return SAFE_STATES.has(record.state) ? { type: "state", state: record.state } : null;
  }
  if (record.type === "lag") {
    const seconds = safeNumber(record.seconds);
    return seconds === null || seconds < 0 ? null : { type: "lag", seconds };
  }
  if (record.type === "ended") {
    const state = safeString(record.state, 80);
    const code = record.code === undefined ? null : safeString(record.code, 80);
    return state === null || !SAFE_STATES.has(state) || (record.code !== undefined && code === null)
      ? null
      : code === null ? { type: "ended", state } : { type: "ended", state, code };
  }
  const code = safeString(record.code, 80);
  const message = safeString(record.message, 500);
  return code === null || message === null ? null : { type: "error", code, message };
}

function abortError() {
  const error = new Error("The transcription stream was aborted");
  error.name = "AbortError";
  return error;
}

function freezeSnapshot(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeSnapshot));
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeSnapshot(item)])));
  }
  return value;
}

export function normalizeKeywords(keywords) {
  if (!Array.isArray(keywords)) return [];
  const result = [];
  const seen = new Set();
  for (const keyword of keywords) {
    if (typeof keyword !== "string") continue;
    const normalized = keywordComparable(keyword);
    if (!normalized || normalized.length > 40 || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length === 100) break;
  }
  return result;
}

export function matchKeywords(text, keywords = DEFAULT_KEYWORDS) {
  const haystack = keywordComparable(text);
  if (!haystack) return [];
  return normalizeKeywords(keywords).filter((keyword) => haystack.includes(keyword));
}

export function createAlertCooldown({ now = () => Date.now(), cooldownMs = 60_000 } = {}) {
  const previous = new Map();
  return (keyword) => {
    const key = keywordComparable(keyword);
    const timestamp = now();
    if (!key || !Number.isFinite(timestamp)) return false;
    const last = previous.get(key);
    if (last !== undefined && timestamp - last < cooldownMs) return false;
    previous.set(key, timestamp);
    return true;
  };
}

export async function parseSseStream(body, { signal, onEvent = () => {} } = {}) {
  if (!body || typeof body.getReader !== "function") throw new TypeError("SSE response body is required");
  if (signal?.aborted) throw abortError();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const consumeFrame = (frame) => {
    let eventName = "message";
    const data = [];
    for (const line of frame.split(/\r?\n/u)) {
      if (!line || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /u, "");
      if (field === "event") eventName = value;
      if (field === "data") data.push(value);
    }
    if (eventName !== "transcript" || !data.length) return;
    try {
      const record = safeRecord(JSON.parse(data.join("\n")));
      if (record) onEvent(record);
    } catch {
      // Invalid or untrusted SSE records are intentionally ignored.
    }
  };
  const flushFrames = () => {
    let boundary;
    while ((boundary = /\r?\n\r?\n/u.exec(pending))) {
      const frame = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary[0].length);
      consumeFrame(frame);
    }
  };
  const onAbort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      flushFrames();
    }
    pending += decoder.decode();
    flushFrames();
    if (signal?.aborted) throw abortError();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function timestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = String(Math.floor(total / 3600)).padStart(2, "0");
  const minutes = String(Math.floor(total / 60) % 60).padStart(2, "0");
  const remainder = String(total % 60).padStart(2, "0");
  return `${hours}:${minutes}:${remainder}`;
}

function markdownCell(value) {
  return String(value ?? "").replace(/\\/gu, "\\\\").replace(/\|/gu, "\\|").replace(/[\r\n]+/gu, " ");
}

export function buildTranscriptMarkdown(session = {}) {
  const course = session.course && typeof session.course === "object" ? session.course : {};
  const settings = session.settings && typeof session.settings === "object" ? session.settings : {};
  const exportedAt = session.exportedAt instanceof Date ? session.exportedAt : new Date();
  const transcript = Array.isArray(session.transcript) ? session.transcript : [];
  const alerts = Array.isArray(session.alerts) ? session.alerts : [];
  const courseName = course.name || course.course_name || course.title || "未命名课程";
  const lines = [
    "# 实时转录记录",
    "",
    `- 课程：${markdownCell(courseName)}`,
    `- 课程 ID：${markdownCell(course.course_id)}`,
    `- 直播 ID：${markdownCell(course.sub_id)}`,
    `- 转录会话：${markdownCell(session.sessionId)}`,
    `- 导出时间：${exportedAt.toISOString()}`,
    `- 模型/语言：${markdownCell(settings.model || "base")} / ${markdownCell(settings.language || "zh")}`,
    "",
    "## 告警记录",
    "",
    "| 时间 | 关键词 | 文本 |",
    "| --- | --- | --- |",
    ...alerts.map((alert) => `| ${timestamp(alert.timestamp ?? alert.start)} | ${markdownCell(alert.keyword)} | ${markdownCell(alert.text)} |`),
    "",
    "## 转录内容",
    "",
    ...transcript.map((line) => `[${timestamp(line.start)}] ${markdownCell(normalizeText(line.text))}`),
    "",
  ];
  return lines.join("\n");
}

export function downloadTranscriptMarkdown(markdown, { filename = "live-transcript.md", documentRef = globalThis.document, urlApi = globalThis.URL } = {}) {
  if (!documentRef?.createElement || !urlApi?.createObjectURL || !urlApi?.revokeObjectURL) return markdown;
  const url = urlApi.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
  try {
    const anchor = documentRef.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    urlApi.revokeObjectURL(url);
  }
  return markdown;
}

function readSettings(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(SETTINGS_KEY) || "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DEFAULT_SETTINGS, keywords: [...DEFAULT_KEYWORDS] };
    return sanitizeSettings(parsed);
  } catch {
    return { ...DEFAULT_SETTINGS, keywords: [...DEFAULT_KEYWORDS] };
  }
}

function sanitizeSettings(value) {
  return {
    model: ["tiny", "base", "small"].includes(value.model) ? value.model : "base",
    language: ["zh", "auto"].includes(value.language) ? value.language : "zh",
    keywords: normalizeKeywords(value.keywords).length ? normalizeKeywords(value.keywords) : [...DEFAULT_KEYWORDS],
    pageAlert: value.pageAlert !== false,
    soundAlert: value.soundAlert !== false,
    systemAlert: value.systemAlert !== false,
  };
}

export function createTranscriptionController({ transport, storage = globalThis.localStorage, now, onUpdate = () => {}, onAlert = () => {} } = {}) {
  if (!transport) throw new TypeError("A transcription transport is required");
  let settings = readSettings(storage);
  let course = null;
  let sessionId = null;
  let activeSessionId = null;
  let starting = false;
  let stopPromise = null;
  let cancelStart = false;
  let cancelStartOptions = {};
  let state = "idle";
  let aborter = null;
  let streamPromise = null;
  const transcript = [];
  const alerts = [];
  const allowAlert = createAlertCooldown({ now });
  const emit = () => onUpdate(snapshot());
  const snapshot = () => freezeSnapshot({
    settings: { ...settings, keywords: [...settings.keywords] },
    course: course ? { ...course } : null,
    sessionId,
    activeSessionId,
    starting,
    state,
    transcript: transcript.map((line) => ({ ...line, keywords: [...line.keywords] })),
    alerts: alerts.map((alert) => ({ ...alert })),
  });
  const persist = () => {
    try { storage?.setItem?.(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* settings remain session-local */ }
  };
  const receive = (event) => {
    if (event.type === "segment") {
      const text = normalizeText(event.text);
      if (!text) return;
      const keywords = matchKeywords(text, settings.keywords);
      const line = { start: event.start, end: event.end, text, keywords };
      transcript.push(line);
      for (const keyword of keywords) {
        if (!allowAlert(keyword)) continue;
        const alert = { keyword, timestamp: event.start, text };
        alerts.push(alert);
        onAlert(freezeSnapshot({ ...alert, settings: { pageAlert: settings.pageAlert, soundAlert: settings.soundAlert, systemAlert: settings.systemAlert } }));
      }
    } else if (event.type === "state") state = event.state;
    else if (event.type === "ended") { state = event.state; activeSessionId = null; }
    else if (event.type === "error") state = "error";
    emit();
  };
  return {
    transcriptionCapabilities: () => transport.transcriptionCapabilities(),
    snapshot,
    settings: () => freezeSnapshot({ ...settings, keywords: [...settings.keywords] }),
    updateSettings(next = {}) {
      settings = sanitizeSettings({ ...settings, ...next });
      persist();
      emit();
      return this.settings();
    },
    async start(nextCourse) {
      if (!nextCourse?.course_id || !nextCourse?.sub_id) throw new TypeError("A live course is required");
      if (activeSessionId || starting) throw new Error("A transcription session is already active");
      const requestedCourse = { course_id: String(nextCourse.course_id), sub_id: String(nextCourse.sub_id), ...(nextCourse.name ? { name: String(nextCourse.name) } : {}) };
      const previousCourse = course;
      const previousSessionId = sessionId;
      starting = true;
      cancelStart = false;
      cancelStartOptions = {};
      state = "starting";
      emit();
      try {
        const result = await transport.startTranscription({ course_id: requestedCourse.course_id, sub_id: requestedCourse.sub_id, model: settings.model, language: settings.language });
        const nextSessionId = typeof result?.session_id === "string" ? result.session_id.trim() : "";
        if (!nextSessionId) {
          throw new Error("Transcription session ID missing");
        }
        course = requestedCourse;
        sessionId = nextSessionId;
        activeSessionId = nextSessionId;
        starting = false;
        if (cancelStart) {
          activeSessionId = null;
          course = previousCourse;
          sessionId = previousSessionId;
          state = "stopped";
          try { await transport.stopTranscription(nextSessionId, cancelStartOptions); }
          finally { emit(); }
          return null;
        }
        aborter = new AbortController();
        streamPromise = transport.streamTranscription(activeSessionId, { signal: aborter.signal, onEvent: receive })
          .catch((error) => { if (error?.name !== "AbortError") { state = "error"; emit(); } });
        emit();
        return sessionId;
      } catch (error) {
        starting = false;
        activeSessionId = null;
        state = cancelStart ? "stopped" : "error";
        emit();
        throw error;
      }
    },
    async stop(options = {}) {
      if (stopPromise) return stopPromise;
      if (starting && !activeSessionId) {
        cancelStart = true;
        cancelStartOptions = options;
        emit();
        return true;
      }
      if (!activeSessionId) return false;
      const current = activeSessionId;
      activeSessionId = null;
      aborter?.abort();
      state = "stopped";
      emit();
      let stopped;
      try { stopped = transport.stopTranscription(current, options); }
      catch (error) { stopped = Promise.reject(error); }
      stopPromise = Promise.resolve(stopped)
        .then(() => true)
        .finally(() => { aborter = null; stopPromise = null; emit(); });
      return stopPromise;
    },
    async waitForStream() { await streamPromise; },
    clear() {
      if (activeSessionId) throw new Error("Stop transcription before clearing it");
      transcript.length = 0;
      alerts.length = 0;
      course = null;
      sessionId = null;
      state = "idle";
      emit();
    },
    exportMarkdown(options = {}) {
      const markdown = buildTranscriptMarkdown({ ...snapshot(), exportedAt: options.exportedAt || new Date() });
      return options.download === false ? markdown : downloadTranscriptMarkdown(markdown, options);
    },
  };
}
