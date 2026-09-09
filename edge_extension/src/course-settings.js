const SAFE_ID = /^[A-Za-z0-9]{1,64}$/;
const MAX_COURSES = 200;
const selectionKeys = ['course_id', 'course_title', 'teacher', 'dept', 'course_code', 'term_id', 'term_title'];

function normalizeSelection(value) {
  const source = typeof value === 'string' || typeof value === 'number' ? { course_id: String(value) } : value;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const course_id = String(source.course_id ?? source.courseId ?? source.id ?? '').trim();
  if (!SAFE_ID.test(course_id)) return null;
  const result = { course_id };
  for (const key of selectionKeys.slice(1)) {
    if (typeof source[key] === 'string' && source[key].trim()) result[key] = source[key].trim().slice(0, 240);
  }
  return result;
}

function normalizeSelections(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const item = normalizeSelection(value);
    if (!item || seen.has(item.course_id)) continue;
    seen.add(item.course_id);
    result.push(item);
  }
  return result.slice(0, MAX_COURSES);
}

export async function readCourseSelections(storage = globalThis.chrome?.storage?.local) {
  if (!storage?.get) return [];
  const saved = await storage.get(['courseSelections', 'courseIds']);
  const values = Array.isArray(saved?.courseSelections) && saved.courseSelections.length
    ? saved.courseSelections
    : saved?.courseIds;
  return normalizeSelections(values);
}

export async function saveCourseSelections(values, storage = globalThis.chrome?.storage?.local) {
  if (Array.isArray(values) && values.length > MAX_COURSES) throw new TypeError('最多保存 200 门课程。');
  const selections = normalizeSelections(values);
  if (!storage?.set) throw new Error('无法保存课程，请重新打开扩展。');
  if (Array.isArray(values) && values.some(value => !normalizeSelection(value))) throw new TypeError('课程列表包含无效课程。');
  await storage.set({
    courseIds: selections.map(item => item.course_id),
    courseSelections: selections,
  });
  return selections;
}

export async function readSelectedTerm(storage = globalThis.chrome?.storage?.local) {
  if (!storage?.get) return null;
  const saved = await storage.get('selectedTerm');
  const id = typeof saved?.selectedTerm?.id === 'string' ? saved.selectedTerm.id.trim() : '';
  const title = typeof saved?.selectedTerm?.title === 'string' ? saved.selectedTerm.title.trim() : '';
  return id ? { id, title } : null;
}

export async function saveSelectedTerm(term, storage = globalThis.chrome?.storage?.local) {
  const id = typeof term?.id === 'string' ? term.id.trim() : '';
  const title = typeof term?.title === 'string' ? term.title.trim() : '';
  if (!/^[A-Za-z0-9]{1,32}$/.test(id) || !storage?.set) throw new TypeError('请选择有效学期。');
  await storage.set({ selectedTerm: { id, title: title.slice(0, 120) } });
  return { id, title: title.slice(0, 120) };
}

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
  return (await readCourseSelections(storage)).map(item => item.course_id);
}

export async function saveCourseIds(value, storage = globalThis.chrome?.storage?.local) {
  const ids = parseCourseIds(value);
  const previous = await readCourseSelections(storage);
  const metadata = new Map(previous.map(item => [item.course_id, item]));
  if (!previous.some(item => Object.keys(item).length > 1)) {
    if (!storage?.set) throw new Error('无法保存课程，请重新打开扩展。');
    await storage.set({ courseIds: ids });
    return ids;
  }
  await saveCourseSelections(ids.map(id => metadata.get(id) || { course_id: id }), storage);
  return ids;
}

/** Apply search selections to the latest saved list without replacing unrelated courses. */
export async function saveCourseSelection(changes, storage = globalThis.chrome?.storage?.local) {
  if (!Array.isArray(changes) || changes.length > 400 || changes.some(change => !change || typeof change.courseId !== 'string' || !SAFE_ID.test(change.courseId) || typeof change.selected !== 'boolean')) {
    throw new TypeError('课程选择无效，请重新勾选。');
  }
  const raw = await storage.get(['courseSelections', 'courseIds']);
  const storedMetadata = normalizeSelections(raw?.courseSelections);
  const metadata = new Map(storedMetadata.map(item => [item.course_id, item]));
  const storedIds = Array.isArray(raw?.courseIds) ? normalizeSelections(raw.courseIds).map(item => item.course_id) : storedMetadata.map(item => item.course_id);
  const current = storedIds.map(id => metadata.get(id) || { course_id: id });
  const selections = new Map(current.map(item => [item.course_id, item]));
  for (const { courseId, selected, course } of changes) {
    if (selected) selections.set(courseId, normalizeSelection(course) || selections.get(courseId) || { course_id: courseId });
    else selections.delete(courseId);
  }
  const saved = await saveCourseSelections([...selections.values()], storage);
  return saved.map(item => item.course_id);
}
