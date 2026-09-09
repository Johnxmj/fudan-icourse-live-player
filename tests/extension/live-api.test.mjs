import test from "node:test";
import assert from "node:assert/strict";
import { mapLiveCourse, listLiveCourses, listFollowedCourses, resolveLiveSource } from "../../edge_extension/src/live-api.js";
const detail = { course_id:"1", title:"Analysis", teacher:"Dr. Example", lectures:[{sub_id:"2", date:"2999-01-01"}] };
const info = { course_id:"1", sub_id:"2", course_title:"Analysis", lecturer_name:"Dr. Example", room_name:"R1", sub_title:"Lecture", start_at:"2999-01-01T09:00:00+08:00", end_at:"2999-01-01T10:00:00+08:00", sub_status:1, live_url:{output:{m3u8:"https://icourse.fudan.edu.cn/live.m3u8"}} };
const DAY1 = new Date("2999-01-01T10:00:00+08:00");
const DAY2 = new Date("2999-01-02T10:00:00+08:00");
const DAY3 = new Date("2999-03-03T10:00:00+08:00");

const fakeFetcher = {
  async getCourseDetail(){ return detail; },
  async getSubInfo(){ return info; },
};

test("ended lectures are not mapped as live", () => { assert.equal(mapLiveCourse({ title: "Analysis" }, { sub_status: 2, sub_id: "2", live_url: {} }), null); });
test("maps only current live metadata", () => { assert.deepEqual(mapLiveCourse(detail, info), {course_id:"1",course_title:"Analysis",teacher:"Dr. Example",room:"R1",sub_id:"2",sub_title:"Lecture",starts_at:info.start_at,ends_at:info.end_at,status:"live",available_views:["teacher"]}); });
test("lists current live courses", async () => { assert.equal((await listLiveCourses(fakeFetcher,["1"], DAY1)).length,1); });
test("keeps followed courses and marks probe failures unknown", async () => {
  const result = await listFollowedCourses({
    async getCourseDetail(id) { if (id === "broken") throw new Error("temporary failure"); return detail; },
    async getSubInfo() { return info; },
  }, [{ course_id: "1", course_title: "Analysis" }, { course_id: "broken", course_title: "Other" }], DAY1);
  assert.equal(result.find(course => course.course_id === "1").status, "live");
  assert.equal(result.find(course => course.course_id === "broken").status, "unknown");
});
test("source resolution accepts only known views", async () => { await assert.rejects(() => resolveLiveSource(fakeFetcher, "1", "2", "recording"), /unknown live view/); });
test("source resolution preserves ordinary https media urls", async () => {
  const fetcher = {
    async getSubInfo(){ return { ...info, live_url: { output: { m3u8: "https://media.invalid/live.m3u8" } } }; },
  };
  assert.equal(await resolveLiveSource(fetcher, "1", "2", "teacher"), "https://media.invalid/live.m3u8");
});
test("source resolution rejects malformed authority-less https urls", async () => {
  for (const value of ["https:///missing-host", "https:/missing-host", "https:\\missing-host"]) {
    const fetcher = {
      async getSubInfo(){ return { ...info, live_url: { output: { m3u8: value } } }; },
    };
    await assert.rejects(() => resolveLiveSource(fetcher, "1", "2", "teacher"), /live view unavailable/);
  }
});
test("source resolution maps icourse urls through WebVPN", async () => {
  assert.match(await resolveLiveSource(fakeFetcher,"1","2","teacher"), /^https:\/\/webvpn\.fudan\.edu\.cn\//);
});
test("listLiveCourses ignores older lectures when the newest one is not live", async () => {
  const fetcher = {
    calls: [],
    async getCourseDetail() {
      return {
        course_id: "1",
        title: "Analysis",
        teacher: "Dr. Example",
        lectures: [
          { sub_id: "1", date: "2999-01-01", start_at: "2999-01-01T08:00:00+08:00" },
          { sub_id: "2", date: "2999-01-02", start_at: "2999-01-02T09:00:00+08:00" },
        ],
      };
    },
    async getSubInfo(courseId, subId) {
      this.calls.push([courseId, subId]);
      return subId === "1"
        ? { ...info, sub_id: "1", start_at: "2999-01-01T08:00:00+08:00", end_at: "2999-01-01T09:00:00+08:00" }
        : { ...info, sub_id: "2", sub_status: 2, start_at: "2999-01-02T09:00:00+08:00", end_at: "2999-01-02T10:00:00+08:00" };
    },
  };
  assert.deepEqual(await listLiveCourses(fetcher, ["1"], DAY2), []);
  assert.deepEqual(fetcher.calls, [["1", "2"]]);
});
test("listLiveCourses includes cross-midnight sessions that end after now", async () => {
  const fetcher = {
    calls: [],
    async getCourseDetail() {
      return {
        course_id: "1",
        title: "Analysis",
        teacher: "Dr. Example",
        lectures: [
          { sub_id: "1", date: "2999-01-01", end_time: "2999-01-02T03:00:00Z" },
        ],
      };
    },
    async getSubInfo(courseId, subId) {
      this.calls.push([courseId, subId]);
      return { ...info, sub_id: subId, start_at: "2999-01-01T23:00:00+08:00", end_at: "2999-01-02T03:00:00+08:00" };
    },
  };
  assert.equal((await listLiveCourses(fetcher, ["1"], DAY2)).length, 1);
  assert.deepEqual(fetcher.calls, [["1", "1"]]);
});
test("listLiveCourses skips impossible calendar dates", async () => {
  const fetcher = {
    async getCourseDetail() {
      return {
        course_id: "1",
        title: "Analysis",
        teacher: "Dr. Example",
        lectures: [{ sub_id: "1", date: "2999-02-31" }],
      };
    },
    async getSubInfo() {
      throw new Error("should not probe an impossible date");
    },
  };
  assert.deepEqual(await listLiveCourses(fetcher, ["1"], DAY3), []);
});

test('a later non-live lecture on the same day does not hide the current lecture', async () => {
  const calls = [];
  const fetcher = {
    async getCourseDetail() { return { lectures: [{ sub_id: 'morning', date: '2999-01-01' }, { sub_id: 'later', date: '2999-01-01' }] }; },
    async getSubInfo(courseId, subId) {
      calls.push(subId);
      return { ...info, sub_id: subId, sub_status: subId === 'morning' ? 1 : 0 };
    },
  };
  assert.deepEqual((await listLiveCourses(fetcher, ['1'], DAY1)).map(course => course.sub_id), ['morning']);
  assert.ok(calls.includes('morning'));
});

test('future lectures with a future end time are never probed', async () => {
  const fetcher = {
    async getCourseDetail() { return { lectures: [{ sub_id: 'future', date: '2999-01-02', start_at: '2999-01-02T09:00:00+08:00', end_at: '2999-01-02T10:00:00+08:00' }] }; },
    async getSubInfo() { throw new Error('must not query a future lecture'); },
  };
  assert.deepEqual(await listLiveCourses(fetcher, ['1'], DAY1), []);
});

test('an unavailable course does not hide a live course but all failed probes remain errors', async () => {
  const fetcher = {
    async getCourseDetail(id) { if (id === 'broken') throw new Error('unavailable'); return detail; },
    async getSubInfo() { return info; },
  };
  assert.equal((await listLiveCourses(fetcher, ['broken', '1'], DAY1)).length, 1);
  await assert.rejects(listLiveCourses(fetcher, ['broken'], DAY1), /unavailable/);
});

test('an ended source reports an ended state so the player does not keep retrying', async () => {
  await assert.rejects(resolveLiveSource({ async getSubInfo() { return { sub_status: 2 }; } }, '1', '2', 'teacher'), error => error.state === 'ended');
});
