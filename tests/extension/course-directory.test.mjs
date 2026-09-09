import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDirectoryCourse, loadCourseDirectory, searchCourseDirectory, createDirectoryService } from '../../edge_extension/src/course-directory.js';
import * as directory from '../../edge_extension/src/course-directory.js';

test('directory metadata exposes only identifiers, course names, and teachers', () => {
  assert.deepEqual(normalizeDirectoryCourse({ id: 123, title: '  数学分析  ', realname: '王老师', token: 'secret', live_url: 'https://secret.invalid', cover: 'private' }), { course_id: '123', course_title: '数学分析', teacher: '王老师' });
  assert.equal(normalizeDirectoryCourse({ id: 'https://invalid', title: '课程' }), null);
  assert.deepEqual(normalizeDirectoryCourse({ id: '1', title: '同名课程', realname: '教师', kkxy_name: '学院', structure_name: '备用学院', course_code: 'MATH001' }), { course_id: '1', course_title: '同名课程', teacher: '教师', dept: '学院', course_code: 'MATH001' });
});

test('directory loader follows all official pages and deduplicates course identifiers', async () => {
  const calls = [];
  const courses = await loadCourseDirectory(async params => {
    calls.push(params);
    return params.page === 1 ? { total: 3, list: [{ id: '1', title: '数学分析', realname: '王老师' }, { id: '2', title: '大学物理', realname: '李老师' }] }
      : { total: 3, list: [{ id: '2', title: '大学物理', realname: '李老师' }, { id: '3', title: '线性代数', realname: '张老师' }] };
  }, { term: '2026A', perPage: 2 });
  assert.deepEqual(courses.map(course => course.course_id), ['1', '2', '3']);
  assert.deepEqual(calls, [{ tenant: 222, term: '2026A', page: 1, per_page: 2 }, { tenant: 222, term: '2026A', page: 2, per_page: 2 }]);
});

test('directory search matches names, teachers, departments, and course codes and paginates the filtered results', () => {
  const catalog = [
    { course_id: '1', course_title: '数学分析 A', teacher: '王老师', dept: '数学科学学院', course_code: 'MATH001' },
    { course_id: '2', course_title: '大学物理', teacher: '李老师' },
    { course_id: '3', course_title: '数学分析 B', teacher: '李老师' },
  ];
  assert.deepEqual(searchCourseDirectory(catalog, { query: '李老师', page: 2, perPage: 1 }), { courses: [catalog[2]], total: 2, page: 2, perPage: 1, hasMore: false });
  assert.deepEqual(searchCourseDirectory(catalog, { query: '数学 李老师' }).courses, [catalog[2]]);
  assert.deepEqual(searchCourseDirectory(catalog, { query: '数学科学学院' }).courses, [catalog[0]]);
  assert.deepEqual(searchCourseDirectory(catalog, { query: 'math001' }).courses, [catalog[0]]);
  assert.equal(searchCourseDirectory(catalog, { query: '不存在' }).total, 0);
});

test('incomplete or malformed directories fail instead of producing a misleading empty result', async () => {
  await assert.rejects(loadCourseDirectory(async ({ page }) => {
    if (page === 2) throw Object.assign(new Error('login'), { state: 'login-required' });
    return { total: 2, list: [{ id: '1', title: '数学' }] };
  }, { term: 'term1', perPage: 1 }), error => error.state === 'login-required');
  await assert.rejects(loadCourseDirectory(async () => ({ total: 1 }), { term: 'term1' }));
  await assert.rejects(loadCourseDirectory(async () => ({ total: 1000000, list: [] }), { term: 'term1' }), /目录/);
  await assert.rejects(loadCourseDirectory(async () => ({ total: 2, list: [{ id: 'same', title: '重复页' }] }), { term: 'term1', perPage: 1 }), /目录/);
  assert.equal(normalizeDirectoryCourse(null), null);
});

test('searches reuse a bounded in-memory directory cache and reload after expiry', async () => {
  let requests = 0;
  let time = 0;
  const service = createDirectoryService({ now: () => time, fetchPage: async () => { requests += 1; return { total: 1, list: [{ id: '1', title: '数学', realname: '王老师' }] }; } });
  await service.search({ term: 'term1', query: '数学' });
  await service.search({ term: 'term1', query: '王老师' });
  assert.equal(requests, 1);
  time = 300001;
  await service.search({ term: 'term1', query: '' });
  assert.equal(requests, 2);
});

test('directory parameters cannot inject an endpoint or unbounded page size', async () => {
  await assert.rejects(loadCourseDirectory(async () => ({ total: 0, list: [] }), { term: 'https://evil.invalid' }), /学期/);
  assert.throws(() => searchCourseDirectory([], { query: '', page: -1 }), /分页/);
  assert.throws(() => searchCourseDirectory([], { query: '', perPage: 10000 }), /分页/);
});

test('recent official courses identify the available terms without scanning guessed term codes', () => {
  assert.equal(typeof directory.discoverRecentTerms, 'function');
  assert.deepEqual(directory.discoverRecentTerms({ list: [
    { term: '_27_', term_name: '2026-20271' }, { term: '_27_', term_name: '2026-20271' },
    { term: '_24_', term_name: '2025-20261' }, { term: 'https://invalid', term_name: 'invalid' },
  ] }), { terms: [{ id: '27', title: '2026–2027 学年第一学期' }, { id: '24', title: '2025–2026 学年第一学期' }], currentTerm: '27' });
});

test('hidden courses require an empty final page to confirm the visible directory is complete', async () => {
  const calls = [];
  const courses = await loadCourseDirectory(async ({ page }) => {
    calls.push(page);
    return { total: 22, list: Array.from({ length: page === 1 ? 18 : page === 2 ? 2 : 0 }, (_, index) => ({ id: String((page - 1) * 20 + index), title: '可见课程' })) };
  }, { term: '27', perPage: 20 });
  assert.equal(courses.length, 20);
  assert.deepEqual(calls, [1, 2, 3]);
});

test('a server page-size cap smaller than requested does not truncate the directory', async () => {
  const calls = [];
  const courses = await loadCourseDirectory(async ({ page, per_page }) => {
    calls.push({ page, per_page });
    const offset = (page - 1) * 50;
    return { total: 120, list: Array.from({ length: Math.min(50, Math.max(0, 120 - offset)) }, (_, index) => ({ id: String(offset + index), title: '可见课程' })) };
  }, { term: '27' });
  assert.equal(courses.length, 120);
  assert.deepEqual(calls, [{ page: 1, per_page: 500 }, { page: 2, per_page: 500 }, { page: 3, per_page: 500 }]);
});
