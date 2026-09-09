/** Transport-neutral GitHub Pages live shell. No credentials or media pass through this module. */

import { createExtensionTransport } from "./transports/extension.js";
import { createLocalTransport } from "./transports/local.js";
import { FUDAN_EXTENSION_ID as APPROVED_EXTENSION_ID } from "./extension-config.js";

export const LIVE_STATES = Object.freeze([
  "detecting",
  "connected",
  "login-required",
  "empty",
  "playing",
  "disconnected",
  "failed",
]);

export const ACTION_URLS = Object.freeze({
  extension: "https://github.com/Johnxmj/Fudan_iCourse_Subscriber#edge-current-live-extension-developer-mode",
  local: "https://github.com/Johnxmj/Fudan_iCourse_Subscriber#本地直播预览",
});

export async function detectTransport(adapters = []) {
  const ordered = [...adapters].sort((left, right) => {
    const leftPriority = left?.name === "extension" ? 0 : 1;
    const rightPriority = right?.name === "extension" ? 0 : 1;
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
  detecting: ["正在检查播放助手", "仅连接到你明确启动的 Edge 扩展或本地播放器。"],
  connected: ["已连接", "播放助手已就绪，可以选择当前直播课程。"],
  "login-required": ["需要登录", "请在本机的播放助手中完成官方 CAS 登录。"],
  empty: ["暂无当前直播", "目前没有可播放的直播课程。"],
  playing: ["正在直播", "当前课程正在播放。"],
  disconnected: ["尚未连接播放助手", "GitHub Pages 不提供云端代理。请连接以下任一安全助手开始当前直播。"],
  failed: ["播放助手不可用", "播放助手返回了暂时无法处理的状态，请稍后刷新。"],
};

export function renderState(state = "disconnected") {
  const key = LIVE_STATES.includes(state) ? state : "disconnected";
  const [title, message] = copy[key];
  const actions = key === "disconnected"
    ? `<div class="state-actions">
        <button type="button" data-action="extension" data-action-url="${ACTION_URLS.extension}">安装或打开 Edge extension</button>
        <button type="button" data-action="local" data-action-url="${ACTION_URLS.local}">启动 Windows local player</button>
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

async function resolveTransportState(transport) {
  let state = transportState(transport);
  if (state === "login-required" || state === "failed") return state;
  if (typeof transport?.listLive !== "function") return state;
  try {
    const courses = await transport.listLive();
    state = transportState(transport);
    return state === "connected" && Array.isArray(courses) && courses.length === 0 ? "empty" : state;
  } catch (_) {
    return "failed";
  }
}

export function boot({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  extensionFactory = globalThis.createExtensionTransport,
  extensionId = globalThis.FUDAN_EXTENSION_ID || APPROVED_EXTENSION_ID,
  runtime = globalThis.chrome?.runtime,
  localFactory = createLocalTransport,
} = {}) {
  const state = documentRef?.querySelector?.("[data-live-state]");
  if (!state) return;
  mountState(state, "detecting", { windowRef });

  const rail = documentRef.querySelector("[data-course-rail]");
  const railToggle = documentRef.querySelector("[data-rail-toggle]");
  bindRailToggle(railToggle, rail);

  const adapters = [];
  if (typeof extensionFactory !== "function" && extensionId && runtime) {
    extensionFactory = () => createExtensionTransport({ extensionId, runtime, windowRef });
  }
  if (typeof extensionFactory === "function") {
    try {
      const adapter = extensionFactory();
      if (adapter) adapters.push(adapter);
    } catch (_) {}
  }
  if (typeof localFactory === "function") {
    try {
      const adapter = localFactory(windowRef?.location);
      if (adapter) adapters.push(adapter);
    } catch (_) {}
  }
  return detectTransport(adapters)
    .then(async (transport) => {
      if (!transport) {
        mountState(state, "disconnected", { windowRef });
        return;
      }
      mountState(state, await resolveTransportState(transport), { windowRef });
    })
    .catch(() => mountState(state, "failed", { windowRef }));
}

if (typeof document !== "undefined") {
  const start = () => boot({ documentRef: document, windowRef: window });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}
