import { createLocalTransport } from "./transport-local.js";

const VIEW_LABELS = { teacher: "教师画面", student: "学生画面", teacher_audio: "教师音频", student_audio: "学生音频" };

const STORAGE_KEYS = {
  railOpen: "live-player.rail-open",
};

function trim(value) {
  return String(value || "").trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function readStored(storage, key) {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(storage, key, value) {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    /* storage may be unavailable in private browsing */
  }
}

function clearStored(storage, key) {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    /* storage may be unavailable in private browsing */
  }
}

function boolStored(storage, key) {
  return readStored(storage, key) === "1";
}

function setBoolStored(storage, key, value) {
  writeStored(storage, key, value ? "1" : "0");
}

function getDefaultBaseUrl(locationLike) {
  const origin = locationLike?.origin;
  if (origin && origin !== "null") {
    try {
      const url = new URL(origin);
      if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
        return url.origin;
      }
    } catch {
      /* fall back to the local default below */
    }
  }
  return "http://127.0.0.1:8000";
}

function getBootstrapBaseUrl(locationLike) {
  return getDefaultBaseUrl(locationLike);
}

function readBootstrapToken(locationLike) {
  try {
    const fragment = new URLSearchParams(String(locationLike?.hash || "").replace(/^#/, ""));
    return trim(fragment.get("bootstrap") || new URLSearchParams(locationLike?.search || "").get("bootstrap"));
  } catch { return ""; }
}

function clearBootstrapTokenFromHistory(win, locationLike) {
  if (!win?.history?.replaceState || !locationLike?.href) return;
  try {
    const url = new URL(locationLike.href);
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
    fragment.delete("bootstrap");
    url.hash = fragment.toString();
    url.searchParams.delete("bootstrap");
    win.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}` || "/");
  } catch { /* Ignore malformed location state. */ }
}

async function redeemBootstrapToken(fetchImpl, baseUrl, bootstrapToken) {
  const sessionUrl = new URL("/api/session", baseUrl).toString();
  const response = await fetchImpl(sessionUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ bootstrap_token: bootstrapToken }),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = trim(payload?.error?.message) || `Automatic sign-in failed with ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  const token = trim(payload?.token);
  if (!token) {
    throw new Error("Automatic sign-in did not return a session token.");
  }

  return token;
}

function courseLabel(course) {
  const title = trim(course?.course_title) || "直播课程";
  const subTitle = trim(course?.sub_title);
  return subTitle ? `${title} · ${subTitle}` : title;
}

function courseMeta(course) {
  const teacher = trim(course?.teacher);
  const room = trim(course?.room);
  const window = [trim(course?.starts_at), trim(course?.ends_at)].filter(Boolean).join(" → ");
  return [teacher, room, window].filter(Boolean).join(" · ");
}

function errorKind(data) {
  return trim(data?.details || data?.type || data?.reason || "");
}

function isSessionExpired(data) {
  const status = data?.status ?? data?.response?.status ?? data?.response?.code ?? data?.response?.statusCode;
  if (status === 401 || status === 403) return true;
  const kind = errorKind(data).toLowerCase();
  return kind.includes("auth") || kind.includes("login");
}

function isFragmentFailure(data) {
  const kind = errorKind(data).toLowerCase();
  return (
    kind.includes("frag") ||
    kind.includes("segment") ||
    kind.includes("buffer") ||
    kind.includes("manifest")
  );
}

export function nextRecoveryAction(state = {}) {
  if (state.sessionExpired) {
    return "login-required";
  }
  if ((state.fragmentFailures || 0) >= 3) {
    return "refresh-source";
  }
  return "retry-fragment";
}

export function createHls(HlsCtor, onFatal = () => {}, options = {}) {
  if (typeof HlsCtor !== "function") {
    throw new Error("Hls constructor is required");
  }

  const hls = new HlsCtor({
    ...options,
    liveSyncDurationCount: 2,
    backBufferLength: 30,
  });

  const events = HlsCtor.Events || {};
  const errorEvent = events.ERROR || "error";
  if (typeof hls.on === "function") {
    hls.on(errorEvent, (_event, data) => {
      if (data?.fatal) {
        return onFatal(data, hls);
      }
    });
  }

  return hls;
}

function createMediaXhrSetup(token) {
  const authorization = trim(token) ? `Bearer ${trim(token)}` : "";
  if (!authorization) {
    return undefined;
  }

  return (xhr) => {
    if (typeof xhr?.setRequestHeader === "function") {
      xhr.setRequestHeader("Authorization", authorization);
    }
  };
}

function createEmptyState() {
  return {
    baseUrl: "",
    token: "",
    view: "live",
    railOpen: false,
    loading: false,
    statusTone: "muted",
    statusText: "正在等待本地播放器连接。",
    courses: [],
    selectedCourseId: "",
    selectedView: "",
    activeCourse: null,
    manifestUrl: "",
    recovery: {
      fragmentFailures: 0,
      refreshAttempts: 0,
      mediaRecoveries: 0,
      sessionExpired: false,
    },
  };
}

export function mountLivePlayerApp(options = {}) {
  const doc = options.document || globalThis.document;
  if (!doc) {
    throw new Error("document is required to mount the live player");
  }
  const win = options.window || globalThis.window || globalThis;
  const storage = options.storage || win.localStorage || null;
  const locationLike = options.location || win.location || null;
  const fetchImpl = options.fetchImpl || win.fetch || globalThis.fetch;
  const HlsCtor = options.Hls || win.Hls || globalThis.Hls || null;
  const root = options.root || doc.querySelector("[data-live-player-root]") || doc.body;

  const els = {
    rail: root.querySelector("[data-rail]"),
    railList: root.querySelector("[data-rail-list]"),
    railToggle: root.querySelector("[data-rail-toggle]"),
    refreshButtons: [...root.querySelectorAll("[data-refresh]")],
    fullscreenButton: root.querySelector("[data-fullscreen]"),
    connectButton: root.querySelector("[data-connect]"),
    baseUrlInput: root.querySelector("[data-base-url]"),
    tokenInput: root.querySelector("[data-token]"),
    status: root.querySelector("[data-status]"),
    courseCount: root.querySelector("[data-course-count]"),
    courseTitle: root.querySelector("[data-course-title]"),
    courseMeta: root.querySelector("[data-course-meta]"),
    courseBadge: root.querySelector("[data-course-badge]"),
    video: root.querySelector("[data-video]"),
    viewBar: root.querySelector("[data-view-bar]"),
    viewHint: root.querySelector("[data-view-hint]"),
    connectionHint: root.querySelector("[data-connection-hint]"),
    previewLine: root.querySelector("[data-preview-line]"),
  };

  const state = createEmptyState();
  state.baseUrl =
    trim(options.baseUrl) ||
    getDefaultBaseUrl(locationLike);
  state.token = trim(options.token) || "";
  state.railOpen = options.railOpen ?? boolStored(storage, STORAGE_KEYS.railOpen);

  let transport = createLocalTransport(state.baseUrl, state.token, { fetchImpl });
  let hls = null;
  let loadGeneration = 0;

  function setStatus(text, tone = "muted") {
    state.statusText = text;
    state.statusTone = tone;
    renderStatus();
  }

  function setConnectionHint(text) {
    if (els.connectionHint) {
      els.connectionHint.textContent = text;
    }
  }

  function syncConnectionFields() {
    if (els.baseUrlInput) {
      els.baseUrlInput.value = state.baseUrl;
    }
    if (els.tokenInput) {
      els.tokenInput.value = state.token;
    }
    setConnectionHint(state.token ? "已连接本地播放器。" : "请通过本地播放器启动入口打开此页面，即可自动连接。");
  }

  function setRailOpen(open) {
    state.railOpen = !!open;
    root.dataset.railOpen = state.railOpen ? "true" : "false";
    if (els.railToggle) {
      els.railToggle.setAttribute("aria-expanded", state.railOpen ? "true" : "false");
    }
    setBoolStored(storage, STORAGE_KEYS.railOpen, state.railOpen);
  }

  function setTransport(nextBaseUrl, nextToken) {
    state.baseUrl = trim(nextBaseUrl) || getDefaultBaseUrl(locationLike);
    state.token = trim(nextToken);
    transport = createLocalTransport(state.baseUrl, state.token, { fetchImpl });
    syncConnectionFields();
  }

  function applySessionToken(nextToken) {
    const preservedBaseUrl = getBootstrapBaseUrl(locationLike);
    state.baseUrl = preservedBaseUrl;
    state.token = trim(nextToken);
    transport = createLocalTransport(preservedBaseUrl, state.token, { fetchImpl });
    syncConnectionFields();
  }

  function clearSessionToken() {
    const preservedBaseUrl = getBootstrapBaseUrl(locationLike);
    state.baseUrl = preservedBaseUrl;
    state.token = "";
    transport = createLocalTransport(preservedBaseUrl, state.token, { fetchImpl });
    syncConnectionFields();
  }

  function clearPlayback() {
    loadGeneration += 1;
    if (hls && typeof hls.destroy === "function") {
      try {
        hls.destroy();
      } catch {
        /* ignore teardown noise */
      }
    }
    hls = null;
    if (els.video) {
      els.video.pause?.();
      els.video.removeAttribute("src");
      try {
        els.video.load?.();
      } catch {
        /* some browsers reject load() on detached video */
      }
    }
  }

  function setActiveCourse(course, preferredView = "") {
    state.activeCourse = course || null;
    state.selectedCourseId = course ? String(course.course_id) : "";
    const availableViews = Array.isArray(course?.available_views) ? course.available_views.map(String) : [];
    const firstView = availableViews.includes("teacher")
      ? "teacher"
      : availableViews[0] || "";
    const mediaToken = trim(course?.media_token);
    state.selectedView = preferredView && availableViews.includes(preferredView)
      ? preferredView
      : firstView;
    state.manifestUrl = course && state.selectedView
      ? transport.manifestUrl(course.course_id, course.sub_id, state.selectedView, mediaToken)
      : "";
    renderAll();
  }

  function renderStatus() {
    if (!els.status) return;
    els.status.textContent = state.statusText;
    els.status.dataset.tone = state.statusTone;
  }

  function renderCourseCard(course) {
    const selected = String(course.course_id) === state.selectedCourseId;
    const availability = Array.isArray(course.available_views) ? course.available_views.length : 0;
    const status = course.status === "live" || !course.status ? "正在直播" : course.status === "unknown" ? "状态未知" : "暂无直播";
    return `
      <button type="button" class="course-card${selected ? " is-selected" : ""}" data-course-id="${escapeHtml(course.course_id)}">
        <span class="course-card__dot" aria-hidden="true"></span>
        <span class="course-card__copy">
          <strong>${escapeHtml(courseLabel(course))}</strong>
          <span>${escapeHtml(courseMeta(course) || status)}</span>
        </span>
        <span class="course-card__views">${escapeHtml(course.status === "live" || !course.status ? `${availability} 个视角` : status)}</span>
      </button>
    `;
  }

  function renderRail() {
    if (!els.railList) return;
    if (!state.courses.length) {
      els.railList.innerHTML = `
        <div class="empty-rail">
          <strong>当前没有直播课程。</strong>
          <span>开课后点击刷新；也请核对已配置的课程。</span>
        </div>
      `;
      return;
    }
    els.railList.innerHTML = state.courses.map(renderCourseCard).join("");
  }

  function renderCourseSummary() {
    if (els.courseCount) {
      els.courseCount.textContent = `${state.courses.length} 门关注课程`;
    }
    if (els.courseTitle) {
      els.courseTitle.textContent = state.activeCourse ? courseLabel(state.activeCourse) : "选择直播课程";
    }
    if (els.courseMeta) {
      els.courseMeta.textContent = state.activeCourse ? courseMeta(state.activeCourse) : "选择左侧课程即可观看当前直播。";
    }
    if (els.courseBadge) {
      els.courseBadge.textContent = state.activeCourse ? "正在直播" : "待播放";
    }
    if (els.previewLine) {
      els.previewLine.textContent = state.activeCourse
        ? "点击下方按钮可切换画面或音频。"
        : "选择课程后加载直播。";
    }
  }

  function renderViewButtons() {
    if (!els.viewBar) return;
    const views = Array.isArray(state.activeCourse?.available_views) ? state.activeCourse.available_views.map(String) : [];
    if (!views.length) {
      els.viewBar.innerHTML = `
        <div class="view-hint">当前课程暂无可播放视角。</div>
      `;
      if (els.viewHint) {
        els.viewHint.textContent = "开课后请刷新课程重试。";
      }
      return;
    }

    els.viewBar.innerHTML = views.map((view) => `
      <button type="button" class="view-chip${view === state.selectedView ? " is-active" : ""}" data-view="${escapeHtml(view)}" aria-pressed="${view === state.selectedView}">
        ${escapeHtml(VIEW_LABELS[view] || view)}
      </button>
    `).join("");
    if (els.viewHint) {
      els.viewHint.textContent = `可选：${views.map(view => VIEW_LABELS[view] || view).join("、")}`;
    }
  }

  function renderVideoSourceLabel() {
    if (!els.video) return;
    // Media credentials stay in the playback request, never in descriptive DOM attributes.
    delete els.video.dataset.source;
  }

  function renderAll() {
    root.dataset.railOpen = state.railOpen ? "true" : "false";
    syncConnectionFields();
    renderStatus();
    renderCourseSummary();
    renderRail();
    renderViewButtons();
    renderVideoSourceLabel();

    if (els.railToggle) {
      els.railToggle.setAttribute("aria-expanded", state.railOpen ? "true" : "false");
    }
    if (els.rail) {
      const railHiddenOnMobile = (win.innerWidth || 0) < 760 && !state.railOpen;
      if (railHiddenOnMobile) {
        els.rail.setAttribute("aria-hidden", "true");
      } else {
        els.rail.removeAttribute("aria-hidden");
      }
    }
  }

  function useCourseById(courseId) {
    const found = state.courses.find((course) => String(course.course_id) === String(courseId));
    if (!found) return;
    if ((found.status && found.status !== "live") || !found.sub_id || !(found.available_views || []).length) {
      clearPlayback();
      state.activeCourse = null;
      state.selectedCourseId = String(found.course_id);
      state.selectedView = "";
      state.manifestUrl = "";
      setStatus(found.status === "unknown" ? "暂时无法确认直播状态，请稍后刷新课程。" : "当前暂无直播，开课后请刷新。", "muted");
      renderAll();
      return;
    }
    setActiveCourse(found);
    loadSelectedCourse({ refreshCatalog: false }).catch((error) => {
      surfaceError(error);
    });
    if ((win.innerWidth || 0) < 760) {
      setRailOpen(false);
    }
  }

  function surfaceError(error, tone = "danger") {
    const messages = {
      LOGIN_REQUIRED: "学校登录已失效，请重新启动本地播放器完成登录。",
      UPSTREAM_FAILED: "无法连接学校直播平台，请检查校园网或 WebVPN 后重试。",
      VIEW_UNAVAILABLE: "当前画面暂不可用，请切换视角或刷新课程。",
    };
    setStatus(messages[error?.code] || (error instanceof TypeError ? "网络连接失败，请确认本地播放器仍在运行，再检查校园网或 WebVPN。" : "暂时无法获取直播，请检查网络并刷新课程重试。"), tone);
  }

  function disposeHls() {
    if (hls && typeof hls.destroy === "function") {
      try {
        hls.destroy();
      } catch {
        /* ignore teardown noise */
      }
    }
    hls = null;
  }

  async function playVideo() {
    try {
      await els.video.play?.();
    } catch {
      /* Autoplay may be blocked; the controls stay usable. */
    }
  }

  async function loadSelectedCourse({ preserveRefreshBudget = false } = {}) {
    const course = state.activeCourse;
    if (!course) {
      return;
    }
    if (!state.selectedView) {
      clearPlayback();
      setStatus("当前课程没有可播放视角，请刷新课程重试。", "warning");
      return;
    }

    const mediaToken = trim(course.media_token);
    if (!mediaToken) {
      clearPlayback();
      setStatus("播放凭证未准备好，请刷新课程重试。", "danger");
      return;
    }
    state.recovery.fragmentFailures = 0;
    if (!preserveRefreshBudget) {
      state.recovery.refreshAttempts = 0;
    }
    state.recovery.mediaRecoveries = 0;
    state.recovery.sessionExpired = false;

    const manifestUrl = transport.manifestUrl(course.course_id, course.sub_id, state.selectedView, mediaToken);
    state.manifestUrl = manifestUrl;
    renderVideoSourceLabel();
    setStatus(`正在加载 ${courseLabel(course)} · ${VIEW_LABELS[state.selectedView] || state.selectedView}…`, "live");
    clearPlayback();
    const generation = ++loadGeneration;

    const canUseHls = HlsCtor && typeof HlsCtor.isSupported === "function"
      ? HlsCtor.isSupported()
      : !!HlsCtor;

    if (!canUseHls && els.video.canPlayType?.("application/vnd.apple.mpegurl")) {
      els.video.src = manifestUrl;
      renderAll();
      await playVideo();
      setStatus(`已准备好播放 ${courseLabel(course)}，如未开始请点击播放按钮。`, "live");
      return;
    }

    if (!canUseHls) {
      setStatus("当前浏览器无法播放此视频，请使用最新版 Chrome 或 Edge。", "danger");
      return;
    }

    const activeLoad = generation;
    hls = createHls(HlsCtor, async (data) => {
      if (activeLoad !== loadGeneration) {
        return;
      }
      await handleFatalError(data);
    }, {
      xhrSetup: createMediaXhrSetup(state.token),
    });

    if (typeof hls.attachMedia === "function") {
      hls.attachMedia(els.video);
    }
    if (typeof hls.loadSource === "function") {
      hls.loadSource(manifestUrl);
    }

    if (typeof hls.on === "function") {
      const events = HlsCtor.Events || {};
      const parsedEvent = events.MANIFEST_PARSED || "manifestParsed";
      hls.on(parsedEvent, async () => {
        if (activeLoad !== loadGeneration) {
          return;
        }
        setStatus(`已准备好播放 ${courseLabel(course)} · ${VIEW_LABELS[state.selectedView] || state.selectedView}，如未开始请点击播放按钮。`, "live");
        await playVideo();
      });
    }
  }

  async function refreshCatalogAndPlayback({ preserveRecovery = false } = {}) {
    if (state.loading) {
      return;
    }
    state.loading = true;
    if (!preserveRecovery) state.recovery.refreshAttempts = 0;
    setStatus("正在刷新直播课程…", "muted");
    try {
      const nextCourses = typeof transport.listFollowedCourses === "function"
        ? await transport.listFollowedCourses()
        : await transport.refreshLiveCourses();
      state.courses = Array.isArray(nextCourses) ? nextCourses : [];
      const nextSelected = state.courses.find((course) => String(course.course_id) === state.selectedCourseId);
      if (nextSelected && (nextSelected.status === "live" || !nextSelected.status) && nextSelected.sub_id) {
        state.activeCourse = nextSelected;
        const availableViews = Array.isArray(nextSelected.available_views) ? nextSelected.available_views.map(String) : [];
        if (!availableViews.includes(state.selectedView)) {
          state.selectedView = availableViews.includes("teacher") ? "teacher" : availableViews[0] || "";
        }
        state.manifestUrl = state.selectedView
          ? transport.manifestUrl(nextSelected.course_id, nextSelected.sub_id, state.selectedView, trim(nextSelected.media_token))
          : "";
        renderAll();
        await loadSelectedCourse({ preserveRefreshBudget: true });
      } else if (state.courses.some((course) => course.status === "live" || !course.status)) {
        setActiveCourse(state.courses.find((course) => course.status === "live" || !course.status));
        await loadSelectedCourse({ preserveRefreshBudget: true });
      } else {
        clearPlayback();
        state.activeCourse = null;
        state.selectedCourseId = state.courses[0]?.course_id ? String(state.courses[0].course_id) : "";
        state.selectedView = "";
        state.manifestUrl = "";
        setStatus("已加载关注课程，当前暂无直播，开课后请刷新。", "muted");
        renderAll();
      }
    } catch (error) {
      if (isSessionExpired(error)) {
        state.recovery.sessionExpired = true;
        clearPlayback();
        setStatus("登录已失效，请重新启动本地播放器完成登录。", "danger");
      } else {
        surfaceError(error);
      }
    } finally {
      state.loading = false;
    }
  }

  async function connectAndLoad() {
    setTransport(els.baseUrlInput?.value, els.tokenInput?.value);
    setStatus("正在连接本地播放器…", "muted");
    await refreshCatalogAndPlayback();
  }

  async function bootstrapAndLoad(bootstrapToken) {
    clearBootstrapTokenFromHistory(win, locationLike);
    setStatus("正在自动连接本地播放器…", "muted");
    let sessionToken;
    try {
      sessionToken = await redeemBootstrapToken(fetchImpl, getBootstrapBaseUrl(locationLike), bootstrapToken);
    } catch (error) {
      clearSessionToken();
      setStatus(
        "自动连接失败。请关闭此页面，重新双击本地播放器启动入口。",
        "danger",
      );
      return;
    }

    applySessionToken(sessionToken);
    setStatus("已自动连接，正在加载课程…", "muted");
    await refreshCatalogAndPlayback();
  }

  async function handleFatalError(data) {
    if (isSessionExpired(data) && !state.recovery.sessionExpired && state.recovery.refreshAttempts < 1) {
      // A media token can expire while the API session is still valid (e.g. after a long pause).
      state.recovery.refreshAttempts += 1;
      await refreshCatalogAndPlayback({ preserveRecovery: true });
      return;
    }
    if (state.recovery.sessionExpired || isSessionExpired(data)) {
      clearPlayback();
      setStatus("播放授权未能恢复，请刷新课程；如仍失败，请重新启动本地播放器。", "danger");
      return;
    }

    const nextFragmentFailures = state.recovery.fragmentFailures + 1;
    const action = nextRecoveryAction({
      fragmentFailures: nextFragmentFailures,
      sessionExpired: false,
    });

    if (data?.type === (HlsCtor?.ErrorTypes?.MEDIA_ERROR || "mediaError")) {
      if (state.recovery.mediaRecoveries < 1 && hls && typeof hls.recoverMediaError === "function") {
        state.recovery.mediaRecoveries += 1;
        setStatus("正在恢复播放画面…", "warning");
        hls.recoverMediaError();
        return;
      }
    }

    if (action === "refresh-source" && state.recovery.refreshAttempts < 1) {
      state.recovery.fragmentFailures = nextFragmentFailures;
      state.recovery.refreshAttempts += 1;
      setStatus("正在重新获取直播源…", "warning");
      await refreshCatalogAndPlayback({ preserveRecovery: true });
      return;
    }

    state.recovery.fragmentFailures = nextFragmentFailures;
    if (action === "retry-fragment" && hls?.startLoad && state.recovery.fragmentFailures < 3) {
      setStatus("直播连接中断，正在重试…", "warning");
      hls.startLoad();
      return;
    }
    setStatus("播放暂时中断，请检查校园网或 WebVPN，然后刷新课程重试。", "danger");
  }

  els.video?.addEventListener("error", () => {
    if (!hls && state.activeCourse) handleFatalError({ fatal: true, details: "manifestLoadError" }).catch(() => setStatus("视频连接中断，请刷新课程重试。", "danger"));
  });

  function toggleFullscreen() {
    const target = root.querySelector("[data-stage]") || doc.documentElement;
    if (doc.fullscreenElement) {
      doc.exitFullscreen?.().catch?.(() => {});
      return;
    }
    target.requestFullscreen?.().catch?.(() => {});
  }

  function bindEvents() {
    els.railToggle?.addEventListener("click", () => {
      setRailOpen(!state.railOpen);
    });

    els.refreshButtons.forEach((button) => {
      button.addEventListener("click", () => {
        refreshCatalogAndPlayback().catch((error) => surfaceError(error));
      });
    });

    els.fullscreenButton?.addEventListener("click", toggleFullscreen);

    els.connectButton?.addEventListener("click", () => {
      connectAndLoad().catch((error) => surfaceError(error));
    });

    els.baseUrlInput?.addEventListener("change", () => {
      setTransport(els.baseUrlInput.value, els.tokenInput?.value);
    });

    els.tokenInput?.addEventListener("change", () => {
      setTransport(els.baseUrlInput?.value, els.tokenInput.value);
    });

    els.railList?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-course-id]");
      if (!button) return;
      useCourseById(button.dataset.courseId);
    });

    els.viewBar?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-view]");
      if (!button || !state.activeCourse) return;
      const nextView = button.dataset.view;
      if (!nextView || nextView === state.selectedView || !state.activeCourse.available_views?.includes(nextView)) return;
      state.selectedView = nextView;
      state.manifestUrl = transport.manifestUrl(
        state.activeCourse.course_id,
        state.activeCourse.sub_id,
        state.selectedView,
        trim(state.activeCourse.media_token),
      );
      renderAll();
      loadSelectedCourse().catch((error) => surfaceError(error));
    });
  }

  setRailOpen(state.railOpen);
  bindEvents();
  renderAll();

  const bootstrapToken = readBootstrapToken(locationLike);
  if (bootstrapToken) {
    bootstrapAndLoad(bootstrapToken).catch((error) => surfaceError(error));
  } else if (state.token) {
    connectAndLoad().catch((error) => surfaceError(error));
  } else {
    setStatus("请通过本地播放器启动入口打开此页面，即可自动连接。", "muted");
  }

  const api = {
    state,
    refresh: connectAndLoad,
    connect: connectAndLoad,
    setRailOpen,
    selectCourse: useCourseById,
    selectView(view) {
      if (!state.activeCourse) return;
      const views = Array.isArray(state.activeCourse.available_views) ? state.activeCourse.available_views.map(String) : [];
      if (!views.includes(view)) return;
      state.selectedView = view;
      state.manifestUrl = transport.manifestUrl(
        state.activeCourse.course_id,
        state.activeCourse.sub_id,
        state.selectedView,
        trim(state.activeCourse.media_token),
      );
      renderAll();
      return loadSelectedCourse();
    },
    destroy() {
      clearPlayback();
      setBoolStored(storage, STORAGE_KEYS.railOpen, state.railOpen);
    },
  };

  root.dataset.railOpen = state.railOpen ? "true" : "false";
  if (typeof win !== "undefined") {
    win.LivePlayerApp = {
      mount: mountLivePlayerApp,
      nextRecoveryAction,
      createHls,
    };
  }

  return api;
}

const globalApi = {
  mount: mountLivePlayerApp,
  nextRecoveryAction,
  createHls,
};

if (typeof globalThis !== "undefined") {
  globalThis.LivePlayerApp = globalApi;
}

export default globalApi;
