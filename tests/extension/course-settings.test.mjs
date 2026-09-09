import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCourseIds, readCourseIds, saveCourseIds } from '../../edge_extension/src/course-settings.js';
import * as settings from '../../edge_extension/src/course-settings.js';

test('accepts IDs and official course links while storing only deduplicated identifiers', async () => {
  const input = '123，abc\nhttps://icourse.fudan.edu.cn/course?course_id=456&other=ignored\nhttps://icourse.fudan.edu.cn/#/course-detail?courseId=789\n123';
  assert.deepEqual(parseCourseIds(input), ['123', 'abc', '456', '789']);
  let saved;
  const storage = { async set(value) { saved = value; }, async get() { return saved; } };
  await saveCourseIds(input, storage);
  assert.deepEqual(saved, { courseIds: ['123', 'abc', '456', '789'] });
  assert.deepEqual(await readCourseIds(storage), saved.courseIds);
});

test('rejects malformed input instead of silently deleting configured courses', async () => {
  for (const input of ['https://example.com/?course_id=123', 'https://icourse.fudan.edu.cn/live.m3u8?token=secret', 'abc/def', 'good invalid!']) {
    assert.throws(() => parseCourseIds(input), /课程/);
  }
  let writes = 0;
  await assert.rejects(saveCourseIds('invalid!', { async set() { writes += 1; } }));
  assert.equal(writes, 0);
  assert.deepEqual(parseCourseIds(''), []);
});

test('invalid saved values are not exposed as course identifiers', async () => {
  assert.deepEqual(await readCourseIds({ async get() { return { courseIds: ['123', '123', 'https://secret.invalid'] }; } }), ['123']);
});

test('directory selections preserve existing courses, deduplicate, and enforce the 200-course limit', async () => {
  assert.equal(typeof settings.saveCourseSelection, 'function');
  let saved = { courseIds: ['old', 'remove'] };
  const storage = { async get() { return saved; }, async set(value) { saved = value; } };
  assert.deepEqual(await settings.saveCourseSelection([{ courseId: 'new', selected: true }, { courseId: 'remove', selected: false }, { courseId: 'old', selected: true }], storage), ['old', 'new']);
  saved.courseIds = Array.from({ length: 200 }, (_, index) => String(index));
  await assert.rejects(settings.saveCourseSelection([{ courseId: 'extra', selected: true }], storage), /200/);
  assert.equal(saved.courseIds.length, 200);
  await assert.rejects(settings.saveCourseSelection([{ selected: true }], storage), /选择/);
});
