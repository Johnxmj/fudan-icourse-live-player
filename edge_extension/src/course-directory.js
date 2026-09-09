const SAFE_ID = /^[A-Za-z0-9]{1,64}$/;
const SAFE_TERM = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_DIRECTORY_SIZE = 20000;
const CACHE_TTL = 5 * 60 * 1000;

function text(value) { return typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, 256) : ''; }

export function normalizeDirectoryCourse(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const courseId = text(value.course_id ?? value.id);
  if (!SAFE_ID.test(courseId)) return null;
  const dept = text(value.kkxy_name || value.structure_name || value.dept);
  const courseCode = text(value.course_code);
  return {
    course_id: courseId,
    course_title: text(value.course_title ?? value.title ?? value.name),
    teacher: text(value.teacher ?? value.realname ?? value.lecturer_name),
    ...(dept ? { dept } : {}),
    ...(courseCode ? { course_code: courseCode } : {}),
  };
}

/** Discover only terms actually present on the official recent-course page. */
export function discoverRecentTerms(data) {
  if (!Array.isArray(data?.list)) throw new Error('最近课程所属学期读取失败，请重试。');
  const terms = new Map();
  for (const course of data.list) {
    const match = /^_?(\d{1,8})_?$/.exec(text(course?.term));
    if (!match) continue;
    const id = match[1];
    const name = text(course.term_name);
    const academicYear = /^(\d{4})-(\d{4})([12])$/.exec(name);
    const title = academicYear ? `${academicYear[1]}–${academicYear[2]} 学年第${academicYear[3] === '1' ? '一' : '二'}学期` : name || `学期 ${id}`;
    if (!terms.has(id)) terms.set(id, { id, title });
  }
  if (!terms.size) throw new Error('最近课程中未找到可用学期，请重试。');
  return { terms: [...terms.values()], currentTerm: terms.keys().next().value };
}

function validateTerm(term) {
  if (typeof term !== 'string' || !SAFE_TERM.test(term)) throw new TypeError('请选择有效学期。');
  return term;
}

/** Fetch every official page before presenting search results as complete. */
export async function loadCourseDirectory(fetchPage, { term, perPage = 500 } = {}) {
  validateTerm(term);
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 500) throw new TypeError('目录分页大小无效。');
  const courses = new Map();
  const pageSignatures = new Set();
  let expectedTotal = null;
  for (let page = 1; page <= 1000; page += 1) {
    const data = await fetchPage({ tenant: 222, term, page, per_page: perPage });
    const total = Number(data?.total);
    if (!Array.isArray(data?.list) || !Number.isInteger(total) || total < 0 || total > MAX_DIRECTORY_SIZE) throw new Error('课程目录格式异常，请刷新后重试。');
    if (expectedTotal === null) expectedTotal = total;
    if (total !== expectedTotal) throw new Error('课程目录正在更新，请重新搜索。');
    const signature = data.list.map(row => text(row?.course_id ?? row?.id)).join(',');
    if (signature && pageSignatures.has(signature)) throw new Error('课程目录返回了重复页面，请重试。');
    if (signature) pageSignatures.add(signature);
    for (const row of data.list) {
      const course = normalizeDirectoryCourse(row);
      if (course) courses.set(course.course_id, course);
    }
    // Hidden courses can inflate the total, and the server can cap page size.
    // Cover the advertised range, then confirm all rows or an empty final page.
    const coveredDeclaredPages = page >= Math.max(1, Math.ceil(total / perPage));
    if (coveredDeclaredPages && (courses.size >= total || data.list.length === 0)) return [...courses.values()];
  }
  throw new Error('课程目录超过加载上限，请选择更具体的学期。');
}

export function searchCourseDirectory(courses, { query = '', page = 1, perPage = 20 } = {}) {
  if (typeof query !== 'string' || query.length > 120) throw new TypeError('搜索内容请控制在 120 个字以内。');
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(perPage) || perPage < 1 || perPage > 50) throw new TypeError('搜索分页参数无效。');
  const words = query.normalize('NFKC').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matched = courses.filter(course => {
    const searchable = `${course.course_title} ${course.teacher} ${course.dept || ''} ${course.course_code || ''}`.normalize('NFKC').toLocaleLowerCase();
    return words.every(word => searchable.includes(word));
  });
  const offset = (page - 1) * perPage;
  return { courses: matched.slice(offset, offset + perPage), total: matched.length, page, perPage, hasMore: offset + perPage < matched.length };
}

export function createDirectoryService({ fetchPage, now = () => Date.now() } = {}) {
  const cache = new Map();
  const pending = new Map();
  return {
    async search(params = {}) {
      const term = validateTerm(params.term);
      // Validate search limits before requesting a directory.
      searchCourseDirectory([], params);
      let entry = cache.get(term);
      if (!entry || now() - entry.created >= CACHE_TTL) {
        if (!pending.has(term)) {
          pending.set(term, loadCourseDirectory(fetchPage, { term }).then(courses => {
            cache.delete(term);
            cache.set(term, { courses, created: now() });
            while (cache.size > 3) cache.delete(cache.keys().next().value);
            return courses;
          }).finally(() => pending.delete(term)));
        }
        entry = { courses: await pending.get(term) };
      }
      return searchCourseDirectory(entry.courses, params);
    },
  };
}
