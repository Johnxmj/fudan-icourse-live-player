import { createLocalTransport } from "./transport-local.js";

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
  const search = trim(locationLike?.search || "");
  if (!search) return "";
  try {
    return trim(new URLSearchParams(search).get("bootstrap"));
  } catch {
    return "";
  }
}

function clearBootstrapTokenFromHistory(win, locationLike) {
  const history = win?.history;
  const href = locationLike?.href;
  if (!history?.replaceState || !href) return;
  try {
    const url = new URL(href);
    if (!url.searchParams.has("bootstrap")) return;
    url.searchParams.delete("bootstrap");
    const nextUrl = `${url.pathname}${url.search}${url.hash}` || "/";
    history.replaceState(null, "", nextUrl);
  } catch {
    /* Ignore malformed location state. */
  }
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
  const title = trim(course?.course_title) || "Untitled live course";
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
  const status = data?.response?.status ?? data?.response?.code ?? data?.response?.statusCode;
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
        onFatal(data, hls);
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
    statusText: "Connect to the local API to load live courses.",
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
    setConnectionHint(state.token ? "Connected to the local player API." : "Paste a session token to connect.");
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
    return `
      <button type="button" class="course-card${selected ? " is-selected" : ""}" data-course-id="${escapeHtml(course.course_id)}">
        <span class="course-card__dot" aria-hidden="true"></span>
        <span class="course-card__copy">
          <strong>${escapeHtml(courseLabel(course))}</strong>
          <span>${escapeHtml(courseMeta(course) || "Live now")}</span>
        </span>
        <span class="course-card__views">${availability} views</span>
      </button>
    `;
  }

  function renderRail() {
    if (!els.railList) return;
    if (!state.courses.length) {
      els.railList.innerHTML = `
        <div class="empty-rail">
          <strong>No live courses right now.</strong>
          <span>Refresh once the platform marks a session live.</span>
        </div>
      `;
      return;
    }
    els.railList.innerHTML = state.courses.map(renderCourseCard).join("");
  }

  function renderCourseSummary() {
    if (els.courseCount) {
      els.courseCount.textContent = `${state.courses.length} live`;
    }
    if (els.courseTitle) {
      els.courseTitle.textContent = state.activeCourse ? courseLabel(state.activeCourse) : "Choose a live course";
    }
    if (els.courseMeta) {
      els.courseMeta.textContent = state.activeCourse ? courseMeta(state.activeCourse) : "The player stays scoped to the current live session only.";
    }
    if (els.courseBadge) {
      els.courseBadge.textContent = state.activeCourse ? trim(state.activeCourse.status || "live") : "idle";
    }
    if (els.previewLine) {
      els.previewLine.textContent = state.activeCourse
        ? `Source: ${state.activeCourse.course_id} / ${state.activeCourse.sub_id}`
        : "Select a course to load its stream.";
    }
  }

  function renderViewButtons() {
    if (!els.viewBar) return;
    const views = Array.isArray(state.activeCourse?.available_views) ? state.activeCourse.available_views.map(String) : [];
    if (!views.length) {
      els.viewBar.innerHTML = `
        <div class="view-hint">No stream views are available for the selected course.</div>
      `;
      if (els.viewHint) {
        els.viewHint.textContent = "The backend did not expose a playable stream variant.";
      }
      return;
    }

    els.viewBar.innerHTML = views.map((view) => `
      <button type="button" class="view-chip${view === state.selectedView ? " is-active" : ""}" data-view="${escapeHtml(view)}">
        ${escapeHtml(view)}
      </button>
    `).join("");
    if (els.viewHint) {
      els.viewHint.textContent = `Available stream views: ${views.join(", ")}.`;
    }
  }

  function renderVideoSourceLabel() {
    if (!els.video) return;
    if (state.manifestUrl) {
      els.video.dataset.source = state.manifestUrl;
    } else {
      delete els.video.dataset.source;
    }
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
    setActiveCourse(found);
    loadSelectedCourse({ refreshCatalog: false }).catch((error) => {
      surfaceError(error);
    });
    if ((win.innerWidth || 0) < 760) {
      setRailOpen(false);
    }
  }

  function surfaceError(error, tone = "danger") {
    const message = error?.message || "Live playback failed.";
    setStatus(message, tone);
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
      setStatus("No playable stream view is available for the selected course.", "warning");
      return;
    }

    const generation = ++loadGeneration;
    const mediaToken = trim(course.media_token);
    if (!mediaToken) {
      setStatus("No media token is available for the selected course.", "danger");
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
    setStatus(`Loading ${courseLabel(course)} (${state.selectedView})...`, "live");
    clearPlayback();

    const canUseHls = HlsCtor && typeof HlsCtor.isSupported === "function"
      ? HlsCtor.isSupported()
      : !!HlsCtor;

    if (!canUseHls && els.video.canPlayType?.("application/vnd.apple.mpegurl")) {
      els.video.src = manifestUrl;
      renderAll();
      await playVideo();
      setStatus(`Playing ${courseLabel(course)} using the browser's native HLS support.`, "live");
      return;
    }

    if (!HlsCtor) {
      setStatus("This browser does not expose HLS.js, and native HLS is unavailable.", "danger");
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
        setStatus(`Ready to play ${courseLabel(course)} on ${state.selectedView}.`, "live");
        await playVideo();
      });
    }
  }

  async function refreshCatalogAndPlayback() {
    if (state.loading) {
      return;
    }
    state.loading = true;
    setStatus("Refreshing live courses...", "muted");
    try {
      const nextCourses = await transport.refreshLiveCourses();
      state.courses = Array.isArray(nextCourses) ? nextCourses : [];
      const nextSelected = state.courses.find((course) => String(course.course_id) === state.selectedCourseId);
      if (nextSelected) {
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
      } else if (state.courses.length) {
        setActiveCourse(state.courses[0]);
        await loadSelectedCourse({ preserveRefreshBudget: true });
      } else {
        clearPlayback();
        state.activeCourse = null;
        state.selectedCourseId = "";
        state.selectedView = "";
        state.manifestUrl = "";
        setStatus("No live courses are available right now.", "muted");
        renderAll();
      }
    } catch (error) {
      if (isSessionExpired(error)) {
        state.recovery.sessionExpired = true;
        setStatus("Session expired. Paste a fresh token and reconnect.", "danger");
      } else {
        surfaceError(error);
      }
    } finally {
      state.loading = false;
    }
  }

  async function connectAndLoad() {
    setTransport(els.baseUrlInput?.value, els.tokenInput?.value);
    setStatus("Connecting to the local API...", "muted");
    await refreshCatalogAndPlayback();
  }

  async function bootstrapAndLoad(bootstrapToken) {
    clearBootstrapTokenFromHistory(win, locationLike);
    setStatus("Signing in with the launch token...", "muted");
    let sessionToken;
    try {
      sessionToken = await redeemBootstrapToken(fetchImpl, getBootstrapBaseUrl(locationLike), bootstrapToken);
    } catch (error) {
      clearSessionToken();
      setStatus(
        `Automatic sign-in failed. Paste a session token to continue. ${error?.message ? error.message : ""}`.trim(),
        "danger",
      );
      return;
    }

    applySessionToken(sessionToken);
    setStatus("Signed in automatically. Loading live courses...", "muted");
    await refreshCatalogAndPlayback();
  }

  async function handleFatalError(data) {
    if (state.recovery.sessionExpired || isSessionExpired(data)) {
      state.recovery.sessionExpired = true;
      disposeHls();
      setStatus("The live session expired. Reconnect to continue.", "danger");
      return;
    }

    const nextFragmentFailures = state.recovery.fragmentFailures + (isFragmentFailure(data) ? 1 : 0);
    const action = nextRecoveryAction({
      fragmentFailures: nextFragmentFailures,
      sessionExpired: false,
    });

    if (data?.type === (HlsCtor?.ErrorTypes?.MEDIA_ERROR || "mediaError")) {
      if (state.recovery.mediaRecoveries < 1 && hls && typeof hls.recoverMediaError === "function") {
        state.recovery.mediaRecoveries += 1;
        setStatus("Recovering the media buffer once...", "warning");
        hls.recoverMediaError();
        return;
      }
    }

    if (action === "refresh-source" && state.recovery.refreshAttempts < 1) {
      state.recovery.fragmentFailures = nextFragmentFailures;
      state.recovery.refreshAttempts += 1;
      setStatus("Refreshing the live source once...", "warning");
      await refreshCatalogAndPlayback();
      return;
    }

    state.recovery.fragmentFailures = nextFragmentFailures;
    surfaceError(new Error(`Playback stalled after ${state.recovery.fragmentFailures} fragment failures.`));
  }

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
      if (!nextView || nextView === state.selectedView) return;
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
    setStatus("Paste a session token to load the current live courses.", "muted");
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
      disposeHls();
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
