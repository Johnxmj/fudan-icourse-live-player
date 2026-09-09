import test from "node:test";
import assert from "node:assert/strict";
import { boot } from "../../frontend/live/app.js";

class Element {
  constructor() { this.dataset = {}; this.innerHTML = ""; this.textContent = ""; this.attributes = {}; this.listeners = {}; this.children = []; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  removeEventListener() {}
  querySelectorAll() { return []; }
  replaceChildren(...children) { this.children = children; }
}
function dom() {
  const elements = Object.fromEntries(["live-state", "live-courses", "course-rail", "rail-toggle", "player", "view-bar", "refresh", "fullscreen", "course-title", "course-meta", "stage"].map(key => [key, new Element()]));
  const documentRef = { querySelector: selector => elements[selector.slice(6, -1)] || null };
  return { elements, documentRef, windowRef: { location: new URL("https://johnxmj.github.io/fudan-icourse-live-player/live/") } };
}
const course = { course_id: "1001", sub_id: "s1", course_title: "分析 <一>", teacher: "老师", available_views: ["teacher", "student_audio"] };

test("Pages keeps courses, selects the isolated extension player and switches views", async () => {
  const screen = dom();
  const mounts = [];
  const views = [];
  const extension = { name: "extension", probe: async () => true, getState: () => "ready", listLive: async () => [course],
    mountPlayer: (container, item, view) => { mounts.push({ container, item, view }); return { setView: view => { views.push(view); return true; }, dispose() {} }; } };
  const app = await boot({ ...screen, extensionFactory: () => extension, localFactory: null });
  assert.match(screen.elements["live-courses"].innerHTML, /分析 &lt;一&gt;/);
  assert.equal(mounts.length, 0, "wait for the user to choose a course");
  await app.selectCourse("1001", "s1");
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].item, course);
  assert.equal(mounts[0].view, "teacher");
  await app.selectView("student_audio");
  assert.deepEqual(views, ["student_audio"]);
  assert.match(screen.elements["view-bar"].innerHTML, /学生音频/);
  await app.selectView("https://evil.invalid");
  assert.deepEqual(views, ["student_audio"]);
});

test("refresh stops ended courses and allows a course that starts later to be selected", async () => {
  const screen = dom();
  let courses = [course];
  let disposed = 0;
  const extension = { name: "extension", probe: async () => true, getState: () => "ready", listLive: async () => courses,
    mountPlayer: () => ({ dispose() { disposed++; } }), refresh: async () => ({ state: "ready" }) };
  const app = await boot({ ...screen, extensionFactory: () => extension, localFactory: null });
  await app.selectCourse("1001", "s1");
  courses = [];
  await app.refresh();
  assert.equal(disposed, 1);
  assert.match(screen.elements["live-state"].innerHTML, /data-state="empty"/);
  courses = [course];
  await app.refresh();
  assert.match(screen.elements["live-courses"].innerHTML, /分析/);
  assert.equal(app.activeCourse, null);
});

test("unconfigured helper tells the user to configure courses then refresh", async () => {
  const screen = dom();
  const extension = { name: "extension", probe: async () => true, getState: () => "unconfigured", listLive: async () => [] };
  await boot({ ...screen, extensionFactory: () => extension, localFactory: null });
  assert.match(screen.elements["live-state"].innerHTML, /data-state="unconfigured"/);
  assert.match(screen.elements["live-state"].innerHTML, /扩展.*课程/);
});

test("an explicitly paired local launcher is preferred over an unconfigured extension", async () => {
  const screen = dom();
  screen.windowRef.location.hash = "bridge=http%3A%2F%2F127.0.0.1%3A4310&bootstrap=once";
  const probes = [];
  const extension = { name: "extension", probe: async () => { probes.push("extension"); return true; }, getState: () => "unconfigured", listLive: async () => [] };
  const local = { name: "local", probe: async () => { probes.push("local"); return true; }, getState: () => "ready", listLive: async () => [course] };
  await boot({ ...screen, extensionFactory: () => extension, localFactory: () => { screen.windowRef.location.hash = ""; return local; } });
  assert.deepEqual(probes, ["local"]);
  assert.match(screen.elements["live-courses"].innerHTML, /分析/);
  assert.match(screen.elements["live-state"].innerHTML, /data-state="connected"/);
});

test("refresh renders the returned course catalog without issuing a second discovery request", async () => {
  const screen = dom();
  let listCalls = 0;
  let refreshCalls = 0;
  const updated = { ...course, course_title: "刷新后的课程" };
  const extension = { name: "extension", probe: async () => true, getState: () => "ready",
    listLive: async () => { listCalls++; return [course]; },
    refresh: async () => { refreshCalls++; return { version: 1, state: "ready", courses: [updated] }; },
  };
  const app = await boot({ ...screen, extensionFactory: () => extension, localFactory: null });
  assert.equal(listCalls, 1);
  await app.refresh();
  assert.equal(refreshCalls, 1);
  assert.equal(listCalls, 1, "the refresh response already contains the complete catalog");
  assert.match(screen.elements["live-courses"].innerHTML, /刷新后的课程/);
});
