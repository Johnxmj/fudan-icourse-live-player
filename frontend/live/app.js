/** Pages handles course metadata; the extension player keeps its media isolated. */

import { createExtensionTransport } from "./transports/extension.js";
import { createLocalTransport } from "./transports/local.js";
import { mountLocalPlayer } from "./player.js";
import { FUDAN_EXTENSION_ID as APPROVED_EXTENSION_ID } from "./extension-config.js";

export const LIVE_STATES = Object.freeze([
  "detecting",
  "connected",
  "login-required",
  "unconfigured",
  "empty",
  "playing",
  "disconnected",
  "failed",
]);

export const ACTION_URLS = Object.freeze({
  extension: "https://github.com/Johnxmj/fudan-icourse-live-player/blob/main/docs/live-player.md",
  local: "https://github.com/Johnxmj/fudan-icourse-live-player#run-locally",
});

export async function detectTransport(adapters = [], preferredName = "extension") {
  const ordered = [...adapters].sort((left, right) => {
    const leftPriority = left?.name === preferredName ? 0 : 1;
    const rightPriority = right?.name === preferredName ? 0 : 1;
    return leftPriority - rightPriority;
  });
  for (const adapter of ordered) {
    try {
      if (typeof adapter?.probe === "function" && await adapter.probe()) return adapter;
    } catch (_) {
      // A missing helper is expected; continue probing the next safe adapter.
    }
  }
  return null;
}

const copy = {
  detecting: ["正在检查播放助手", "正在检查 Chrome / Edge 扩展或本地播放器。"],
  connected: ["已连接", "播放助手已就绪，可以选择当前直播课程。"],
  "login-required": ["需要登录", "请点击浏览器扩展完成官方登录，然后刷新课程；使用本地播放器时请重新启动助手。"],
  unconfigured: ["还没有配置课程", "点击浏览器右上角的直播扩展，添加课程链接或课程 ID，保存后点击刷新课程。"],
  empty: ["暂无当前直播", "已连接，但配置的课程目前没有直播。请核对课程设置，开课后点击刷新课程。"],
  playing: ["正在直播", "当前课程正在播放。"],
  disconnected: ["尚未连接播放助手", "GitHub Pages 不提供云端代理。请连接以下任一安全助手开始当前直播。"],
  failed: ["播放助手不可用", "播放助手返回了暂时无法处理的状态，请稍后刷新。"],
};

export function renderState(state = "disconnected") {
  const key = LIVE_STATES.includes(state) ? state : "disconnected";
  const [title, message] = copy[key];
  const actions = key === "disconnected"
    ? `<div class="state-actions">
        <button type="button" data-action="extension" data-action-url="${ACTION_URLS.extension}">安装或打开浏览器扩展</button>
        <button type="button" data-action="local" data-action-url="${ACTION_URLS.local}">启动本地播放器</button>
      </div>`
    : "";
  return `<section class="state-card state-${key}" data-state="${key}"><p class="state-kicker">CURRENT LIVE</p><h2>${title}</h2><p>${message}</p>${actions}</section>`;
}

export function openActionGuide(action, windowRef = globalThis.window) {
  const url = ACTION_URLS[action];
  if (!url || !windowRef) return false;
  const opened = typeof windowRef.open === "function"
    ? windowRef.open(url, "_blank", "noopener,noreferrer")
    : null;
  if (!opened && windowRef.location) {
    if (typeof windowRef.location.assign === "function") windowRef.location.assign(url);
    else windowRef.location.href = url;
  }
  return true;
}

export function wireStateActions(container, windowRef = globalThis.window) {
  if (!container?.querySelectorAll) return () => {};
  const bindings = [];
  for (const button of container.querySelectorAll("[data-action]")) {
    const handler = () => openActionGuide(button.dataset?.action, windowRef);
    button.addEventListener("click", handler);
    bindings.push([button, handler]);
  }
  return () => {
    for (const [button, handler] of bindings) {
      button.removeEventListener?.("click", handler);
    }
  };
}

export function mountState(container, state, { windowRef = globalThis.window } = {}) {
  if (!container) return;
  container.innerHTML = renderState(state);
  container.setAttribute("aria-live", "polite");
  wireStateActions(container, windowRef);
}

export function bindRailToggle(toggle, rail) {
  if (!toggle || !rail) return () => {};

  const setOpen = (open) => {
    const value = Boolean(open);
    rail.dataset.open = String(value);
    if (toggle.dataset) toggle.dataset.open = String(value);
    toggle.setAttribute("aria-expanded", String(value));
  };
  setOpen(rail.dataset?.open === "true");

  const onClick = () => setOpen(rail.dataset.open !== "true");
  toggle.addEventListener("click", onClick);
  return () => toggle.removeEventListener?.("click", onClick);
}

function transportState(transport) {
  const value = typeof transport?.getState === "function" ? transport.getState() : transport?.state;
  if (value === "ready") return "connected";
  if (LIVE_STATES.includes(value)) return value;
  return "connected";
}

const VIEW_LABELS = Object.freeze({ teacher: "教师画面", student: "学生画面", teacher_audio: "教师音频", student_audio: "学生音频" });
const escapeHtml = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const viewsFor = (course) => (Array.isArray(course?.available_views) ? course.available_views : []).filter(view => Object.hasOwn(VIEW_LABELS, view));

export async function boot({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  extensionFactory = globalThis.createExtensionTransport,
  extensionId = globalThis.FUDAN_EXTENSION_ID || APPROVED_EXTENSION_ID,
  runtime = globalThis.chrome?.runtime,
  localFactory = createLocalTransport,
  Hls = globalThis.Hls,
} = {}) {
  const state = documentRef?.querySelector?.("[data-live-state]");
  if (!state) return;
  const find = name => documentRef.querySelector(`[data-${name}]`);
  const list = find("live-courses");
  const player = find("player");
  const viewBar = find("view-bar");
  const refreshButton = find("refresh");
  const rail = find("course-rail");
  const railToggle = find("rail-toggle");
  const unbindRail = bindRailToggle(railToggle, rail);
  let transport = null;
  let courses = [];
  let activeCourse = null;
  let selectedView = "";
  let mounted = null;
  let refreshing = false;
  let disposed = false;
  let recoveryAttempts = 0;
  const bindings = [];
  const bind = (element, event, handler) => {
    element?.addEventListener?.(event, handler);
    bindings.push(() => element?.removeEventListener?.(event, handler));
  };
  const show = (value, message = "") => {
    if (disposed) return;
    mountState(state, value, { windowRef });
    if (message) {
      const text = state.querySelector?.(".state-card > p:last-child");
      if (text) text.textContent = message;
    }
    if (player) player.hidden = !activeCourse;
    if (find("stage")) find("stage").dataset.playing = String(Boolean(activeCourse));
  };
  const clearPlayer = () => {
    mounted?.dispose?.();
    mounted = null;
    player?.replaceChildren?.();
  };
  const render = () => {
    if (list) list.innerHTML = courses.map(course => {
      const selected = course.course_id === activeCourse?.course_id && course.sub_id === activeCourse?.sub_id;
      const meta = [course.teacher, course.room, [course.starts_at, course.ends_at].filter(Boolean).join(" — ")].filter(Boolean).join(" · ");
      const status = course.status === "live" || !course.status ? "正在直播" : course.status === "unknown" ? "状态未知" : "暂无直播";
      return `<button class="course-card" type="button" data-course-id="${escapeHtml(course.course_id)}" data-sub-id="${escapeHtml(course.sub_id)}" aria-pressed="${selected}"><strong>${escapeHtml(course.course_title || "直播课程")}</strong><span>${escapeHtml(course.sub_title || status)}</span><small>${escapeHtml(meta || status)}</small></button>`;
    }).join("") || '<p class="course-empty">暂无直播课程。请配置课程并刷新。</p>';
    const title = find("course-title");
    if (title) title.textContent = activeCourse?.course_title || "选择课程开始观看";
    const meta = find("course-meta");
    if (meta) meta.textContent = [activeCourse?.teacher, activeCourse?.room, activeCourse?.sub_title].filter(Boolean).join(" · ");
    if (viewBar) viewBar.innerHTML = viewsFor(activeCourse).map(view => `<button type="button" data-view="${view}" aria-pressed="${view === selectedView}">${VIEW_LABELS[view]}</button>`).join("");
  };
  const recover = async () => {
    if (recoveryAttempts++ >= 1) {
      show("failed", "播放仍未恢复，请检查校园网或 WebVPN，然后点击刷新课程重试。");
      return;
    }
    await refresh({ recovery: true });
  };
  const startPlayer = () => {
    clearPlayer();
    if (!activeCourse || !player) return;
    if (!selectedView) { show("failed", "当前课程没有可播放的视角，请刷新课程。"); return; }
    show("connected", "正在连接视频。若未自动开始，请点击播放按钮。");
    try {
      mounted = transport.mountPlayer
        ? transport.mountPlayer(player, activeCourse, selectedView, { onStatus(value) {
          const descriptions = { ready: "视频已准备好，请点击播放按钮。", buffering: "正在缓冲直播…", paused: "播放已暂停，点击视频可继续。", ended: "本节直播已结束，请刷新课程查看其他直播。" };
          show(value === "ended" ? "empty" : ["ready", "buffering", "paused"].includes(value) ? "connected" : value, descriptions[value]);
        } })
        : mountLocalPlayer(player, transport, activeCourse, selectedView, { Hls, onStatus: show, onRefresh: recover });
    } catch (_) { show("failed"); }
  };
  async function selectCourse(courseId, subId) {
    const course = courses.find(item => String(item.course_id) === String(courseId) && (subId === undefined || String(item.sub_id) === String(subId)));
    if (!course || disposed) return;
    if ((course.status && course.status !== "live") || !course.sub_id || !viewsFor(course).length) {
      activeCourse = null;
      clearPlayer();
      render();
      show("connected", course.status === "unknown" ? "暂时无法确认直播状态，请稍后刷新课程。" : "当前暂无直播，开课后点击刷新课程。");
      return;
    }
    activeCourse = course;
    const views = viewsFor(course);
    selectedView = views.includes("teacher") ? "teacher" : views[0] || "";
    recoveryAttempts = 0;
    render();
    startPlayer();
    if (rail && (windowRef?.innerWidth || 1000) < 760) {
      rail.dataset.open = "false";
      railToggle?.setAttribute("aria-expanded", "false");
    }
  }
  async function selectView(view) {
    if (!activeCourse || !viewsFor(activeCourse).includes(view) || view === selectedView) return;
    selectedView = view;
    recoveryAttempts = 0;
    render();
    if (!mounted?.setView?.(view)) startPlayer();
  }
  async function refresh({ initial = false, recovery = false } = {}) {
    if (refreshing || disposed) return;
    refreshing = true;
    if (!recovery) recoveryAttempts = 0;
    if (refreshButton) refreshButton.disabled = true;
    try {
      if (!transport) transport = await detectTransport(adapters, preferredTransport);
      if (!transport) { show("disconnected"); return; }
      let refreshedCourses;
      if (!initial && transport.refresh) {
        const refreshed = await transport.refresh();
        if (typeof transport.listFollowed === "function") refreshedCourses = await transport.listFollowed();
        else if (Array.isArray(refreshed?.courses)) refreshedCourses = refreshed.courses;
      }
      const helperState = transportState(transport);
      if (initial && ["login-required", "unconfigured", "failed"].includes(helperState)) {
        show(helperState); return;
      }
      courses = refreshedCourses
        ?? (typeof transport.listFollowed === "function"
          ? await transport.listFollowed()
          : (typeof transport.listLive === "function" ? await transport.listLive() : []));
      if (!Array.isArray(courses)) courses = [];
      const nextState = transportState(transport);
      if (["login-required", "unconfigured", "failed", "disconnected"].includes(nextState)) {
        courses = []; activeCourse = null; clearPlayer(); render(); show(nextState); return;
      }
      const previous = activeCourse;
      activeCourse = courses.find(course => course.course_id === previous?.course_id && course.sub_id === previous?.sub_id) || null;
      render();
      if (activeCourse) {
        if (!viewsFor(activeCourse).includes(selectedView)) selectedView = viewsFor(activeCourse)[0] || "";
        render(); startPlayer();
      } else {
        clearPlayer(); show(courses.length ? "connected" : "empty");
      }
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) { activeCourse = null; courses = []; clearPlayer(); render(); }
      show(error?.status === 401 || error?.status === 403 ? "login-required" : "failed");
    } finally {
      refreshing = false;
      if (refreshButton) refreshButton.disabled = false;
    }
  }
  const adapters = [];
  let preferredTransport = "extension";
  if (typeof extensionFactory !== "function" && extensionId) extensionFactory = () => createExtensionTransport({ extensionId, runtime, windowRef });
  if (typeof extensionFactory === "function") {
    try { const adapter = extensionFactory(); if (adapter) adapters.push(adapter); } catch (_) {}
  }
  if (typeof localFactory === "function") {
    try {
      const explicitlyPaired = new URLSearchParams((windowRef?.location?.hash || "").replace(/^#/, "")).has("bridge");
      const adapter = localFactory(windowRef?.location);
      if (adapter) {
        adapters.push(adapter);
        // A launcher URL represents the user's explicit choice of the local helper.
        if (explicitlyPaired && adapter.name === "local") preferredTransport = "local";
      }
    } catch (_) {}
  }
  bind(list, "click", event => { const button = event.target.closest?.("[data-course-id]"); if (button) void selectCourse(button.dataset.courseId, button.dataset.subId); });
  bind(viewBar, "click", event => { const button = event.target.closest?.("[data-view]"); if (button) void selectView(button.dataset.view); });
  bind(refreshButton, "click", () => { void refresh(); });
  bind(find("fullscreen"), "click", () => {
    if (documentRef.fullscreenElement) documentRef.exitFullscreen?.().catch?.(() => {});
    else find("stage")?.requestFullscreen?.().catch?.(() => {});
  });
  const api = {
    selectCourse, selectView, refresh,
    get activeCourse() { return activeCourse; },
    destroy() { disposed = true; clearPlayer(); adapters.forEach(adapter => adapter.dispose?.()); unbindRail(); bindings.forEach(unbind => unbind()); },
  };
  bind(windowRef, "pagehide", () => api.destroy());
  show("detecting");
  await refresh({ initial: true });
  return api;
}

if (typeof document !== "undefined") {
  const start = () => boot({ documentRef: document, windowRef: window });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}
