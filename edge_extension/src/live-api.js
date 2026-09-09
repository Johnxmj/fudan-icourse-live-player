import { toWebVpnUrl } from "./webvpn-url.js";

export const VIEW_PATHS = Object.freeze({
  teacher: ["output", "m3u8"], student: ["output_student", "m3u8"],
  teacher_audio: ["output", "m3u8_audio"], student_audio: ["output_student", "m3u8_audio"],
});

const PLATFORM_TIMEZONE = "Asia/Shanghai";

const nested = (root, path) => path.reduce((node, key) => node && node[key], root);

function extractDateFromSubTitle(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return match?.[1] ?? null;
}

function flattenSubList(subList) {
  const lectures = [];
  if (!subList || typeof subList !== "object" || Array.isArray(subList)) return lectures;
  for (const [year, months] of Object.entries(subList)) {
    if (!months || typeof months !== "object" || Array.isArray(months)) continue;
    for (const [month, days] of Object.entries(months)) {
      if (!days || typeof days !== "object" || Array.isArray(days)) continue;
      for (const [day, items] of Object.entries(days)) {
        if (!Array.isArray(items)) continue;
        const fallbackDate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        for (const item of items) {
          if (
            !item
            || typeof item !== "object"
            || (item.id == null && item.sub_id == null)
          ) continue;
          const subTitle = item.sub_title ?? item.subTitle ?? "";
          lectures.push({
            ...item,
            sub_id: item.sub_id ?? item.id,
            sub_title: subTitle,
            date: item.date ?? extractDateFromSubTitle(subTitle) ?? fallbackDate,
          });
        }
      }
    }
  }
  return lectures;
}

function normalizeCourseDetail(detail = {}, fallbackCourseId) {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    return { course_id: fallbackCourseId, lectures: [] };
  }
  const nestedLectures = flattenSubList(detail.sub_list);
  const lectures = nestedLectures.length
    ? nestedLectures
    : Array.isArray(detail.lectures)
      ? detail.lectures
      : [];
  return {
    ...detail,
    course_id: detail.course_id ?? fallbackCourseId,
    title: detail.title ?? "",
    teacher: detail.teacher ?? detail.realname ?? "",
    lectures,
  };
}

function parseShanghaiDateTime(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(text);
  const parsed = new Date(
      hasTimezone
        ? text
        : /^\d{4}-\d{2}-\d{2}$/.test(text)
        ? `${text}T00:00:00+08:00`
        : `${text.replace(" ", "T")}+08:00`,
  );
  if (Number.isNaN(parsed.getTime())) return null;
  if (dateOnly && shanghaiDateString(parsed) !== text) return null;
  return parsed;
}

function shanghaiDateString(value) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: PLATFORM_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(value).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function eligibleLectures(lectures, now = new Date()) {
  const current = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (Number.isNaN(current.getTime())) return [];
  const currentShanghaiDate = shanghaiDateString(current);
  const candidates = [];
  lectures.forEach((lecture, index) => {
    if (!lecture || lecture.sub_id == null) return;
    const date = parseShanghaiDateTime(lecture.date);
    const start = parseShanghaiDateTime(lecture.start_at ?? lecture.begin_time ?? lecture.start_time);
    const end = parseShanghaiDateTime(lecture.end_at ?? lecture.end_time);
    if ((start && start > current) || (date && shanghaiDateString(date) > currentShanghaiDate)) return;
    if ((date && shanghaiDateString(date) === currentShanghaiDate) || (end && end > current)) {
      const order = start ?? date ?? end;
      if (order) candidates.push([order.getTime(), index, lecture]);
    }
  });
  candidates.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  return candidates.map(candidate => candidate[2]);
}

function resolveSourceUrl(value) {
  if (typeof value !== "string" || !/^https:\/\/[^/\\?#]+(?:[/?#]|$)/.test(value)) {
    throw new Error("live view unavailable");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("live view unavailable");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) {
    throw new Error("live view unavailable");
  }
  if (parsed.hostname === "icourse.fudan.edu.cn") {
    return toWebVpnUrl(value);
  }
  return value;
}

/** Map platform-confirmed current-live data to URL-free extension metadata. */
export function mapLiveCourse(courseDetail = {}, subInfo = {}) {
  if (Number(subInfo.sub_status) !== 1) return null;
  const liveUrl = subInfo.live_url || {};
  const available = Object.keys(VIEW_PATHS).filter((view) => typeof nested(liveUrl, VIEW_PATHS[view]) === "string");
  if (!available.length || subInfo.sub_id == null) return null;
  return {
    course_id: String(subInfo.course_id ?? courseDetail.course_id ?? subInfo.courseId ?? ""),
    course_title: String(subInfo.course_title ?? courseDetail.title ?? ""),
    teacher: String(subInfo.lecturer_name ?? courseDetail.teacher ?? ""),
    room: String(subInfo.room_name ?? ""), sub_id: String(subInfo.sub_id),
    sub_title: String(subInfo.sub_title ?? ""),
    starts_at: String(subInfo.start_at ?? subInfo.begin_time ?? ""),
    ends_at: String(subInfo.end_at ?? subInfo.end_time ?? ""), status: "live",
    available_views: available,
  };
}

export async function listLiveCourses(fetcher, courseIds, now = new Date()) {
  const result = [];
  let firstError = null;
  for (const id of courseIds || []) {
    let detail;
    try { detail = normalizeCourseDetail(await fetcher.getCourseDetail(String(id)), String(id)); }
    catch (error) { firstError ||= error; continue; }
    const seen = new Set();
    for (const lecture of eligibleLectures(Array.isArray(detail?.lectures) ? detail.lectures : [], now)) {
      if (!lecture?.sub_id || seen.has(String(lecture.sub_id))) continue;
      seen.add(String(lecture.sub_id));
      try {
        const info = await fetcher.getSubInfo(String(id), String(lecture.sub_id));
        const mapped = mapLiveCourse({ ...detail, course_id: detail.course_id ?? id }, info);
        if (mapped) { result.push(mapped); break; }
      } catch (error) { firstError ||= error; }
    }
  }
  if (!result.length && firstError) throw firstError;
  return result.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

/** Merge saved public course metadata with the subset that is live now. */
export async function listFollowedCourses(fetcher, selections, now = new Date()) {
  const saved = (Array.isArray(selections) ? selections : []).map((course) => ({
    course_id: String(course?.course_id ?? course?.courseId ?? ""),
    course_title: String(course?.course_title ?? ""),
    teacher: String(course?.teacher ?? ""),
    room: "", sub_id: "", sub_title: "", starts_at: "", ends_at: "",
    status: "offline", available_views: [],
  })).filter(course => course.course_id);
  if (!saved.length) return [];
  const result = [];
  for (const course of saved) {
    try {
      const live = await listLiveCourses(fetcher, [course.course_id], now);
      result.push(live[0] || course);
    } catch (error) {
      if (error?.state === 'login-required') throw error;
      result.push({ ...course, status: 'unknown' });
    }
  }
  return result;
}

export async function resolveLiveSource(fetcher, courseId, subId, view) {
  if (!VIEW_PATHS[view]) throw new TypeError("unknown live view");
  const info = await fetcher.getSubInfo(String(courseId), String(subId));
  if (Number(info?.sub_status) !== 1) throw Object.assign(new Error("lecture is not currently live"), { state: 'ended' });
  const value = nested(info?.live_url, VIEW_PATHS[view]);
  if (typeof value !== "string") throw new Error("live view unavailable");
  return resolveSourceUrl(value);
}
