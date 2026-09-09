const SAFE_ID = /^[A-Za-z0-9]{1,64}$/;
const MAX_COURSES = 200;

/** Accept copied course links but persist only their public identifiers. */
export function parseCourseIds(value) {
  if (typeof value !== 'string' || value.length > 20000) throw new TypeError('课程列表过长，请分批添加。');
  const ids = [];
  for (const item of value.split(/[\s,，;；]+/).filter(Boolean)) {
    let id = item;
    if (!SAFE_ID.test(id)) {
      try {
        const url = new URL(item);
        if (url.protocol !== 'https:' || url.username || url.password || !['icourse.fudan.edu.cn', 'webvpn.fudan.edu.cn'].includes(url.hostname)) throw new Error();
        const query = new URLSearchParams(url.search);
        const hashQuery = new URLSearchParams(url.hash.split('?')[1] || '');
        id = ['course_id', 'courseId', 'id'].map(key => query.get(key) || hashQuery.get(key)).find(Boolean) || '';
      } catch (_) { id = ''; }
    }
    if (!SAFE_ID.test(id)) throw new TypeError('请输入有效的课程 ID 或复旦 iCourse 课程链接。');
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > MAX_COURSES) throw new TypeError('最多保存 200 门课程。');
  return ids;
}

export async function readCourseIds(storage = globalThis.chrome?.storage?.local) {
  if (!storage?.get) return [];
  const saved = await storage.get('courseIds');
  return [...new Set((Array.isArray(saved?.courseIds) ? saved.courseIds : []).filter(id => typeof id === 'string' && SAFE_ID.test(id)))].slice(0, MAX_COURSES);
}

export async function saveCourseIds(value, storage = globalThis.chrome?.storage?.local) {
  const ids = parseCourseIds(value);
  if (!storage?.set) throw new Error('无法保存课程，请重新打开扩展。');
  await storage.set({ courseIds: ids });
  return ids;
}
