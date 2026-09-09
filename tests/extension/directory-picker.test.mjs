import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectoryPicker } from '../../edge_extension/popup/directory.js';

function makeDocument() {
  const elements = {};
  const node = tagName => ({ tagName, textContent: '', value: '', disabled: false, checked: false, listeners: {}, children: [],
    addEventListener(type, handler) { this.listeners[type] = handler; },
    replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); },
  });
  return { elements, getElementById(id) { return elements[id] ||= node(); }, createElement: node };
}

test('users can search by teacher, select results, and preserve existing followed courses', async () => {
  const documentRef = makeDocument();
  let saved = { courseIds: ['old'] };
  const requests = [];
  let onSavedIds;
  const picker = createDirectoryPicker({ documentRef, storage: { async get() { return saved; }, async set(value) { saved = value; } }, chromeApi: { runtime: { async sendMessage(message) {
    requests.push(message);
    if (message.type === 'GET_DIRECTORY_TERMS') return { state: 'ready', currentTerm: 'term1', terms: [{ id: 'term1', title: '测试学期' }] };
    return { state: 'ready', total: 1, page: 1, perPage: 20, hasMore: false, courses: [{ course_id: 'new', course_title: '数学分析', teacher: '王老师' }] };
  } } }, onSaved: async ids => { onSavedIds = ids; } });
  picker.setSavedCourseIds(['old']);
  await picker.loadTerms();
  assert.equal(documentRef.elements['directory-term'].value, 'term1');
  documentRef.elements['directory-query'].value = '王老师';
  await picker.search();
  assert.equal(requests.at(-1).query, '王老师');
  const label = documentRef.elements['directory-results'].children[0].children[0];
  assert.match(label.children[1].textContent, /数学分析.*王老师/);
  const checkbox = label.children[0];
  checkbox.checked = true;
  checkbox.listeners.change();
  await picker.saveSelection();
  assert.deepEqual(saved, {
    courseIds: ['old', 'new'],
    courseSelections: [{ course_id: 'old' }, { course_id: 'new', course_title: '数学分析', teacher: '王老师' }],
  });
  assert.deepEqual(onSavedIds, ['old', 'new']);
});

test('login and network failures remain distinct and never show stale directory results', async () => {
  const documentRef = makeDocument();
  let result = { state: 'login-required' };
  const picker = createDirectoryPicker({ documentRef, chromeApi: { runtime: { async sendMessage() { return result; } } } });
  await picker.loadTerms();
  assert.match(documentRef.elements['directory-status'].textContent, /登录/);
  documentRef.elements['directory-term'].value = 'term1';
  result = { state: 'ready', courses: [{ course_id: '1', course_title: '数学', teacher: '教师' }], total: 1, page: 1, hasMore: false };
  await picker.search();
  assert.equal(documentRef.elements['directory-results'].children.length, 1);
  result = { state: 'failed', error: 'https://secret.invalid' };
  await picker.search();
  assert.equal(documentRef.elements['directory-results'].children.length, 0);
  assert.match(documentRef.elements['directory-status'].textContent, /网络|重试/);
  assert.doesNotMatch(documentRef.elements['directory-status'].textContent, /secret|暂无|没有/);
});

test('a slower earlier search cannot replace the latest search results', async () => {
  const documentRef = makeDocument();
  let finishOld;
  const picker = createDirectoryPicker({ documentRef, chromeApi: { runtime: { sendMessage(message) {
    if (message.query === 'old') return new Promise(resolve => { finishOld = resolve; });
    return Promise.resolve({ state: 'ready', courses: [{ course_id: 'new', course_title: '新课程', teacher: '' }], total: 1, page: 1, hasMore: false });
  } } } });
  documentRef.elements['directory-term'].value = 'term1';
  documentRef.elements['directory-query'].value = 'old';
  const old = picker.search();
  documentRef.elements['directory-query'].value = 'new';
  await picker.search();
  finishOld({ state: 'ready', courses: [{ course_id: 'old', course_title: '旧课程', teacher: '' }], total: 1, page: 1, hasMore: false });
  await old;
  assert.match(documentRef.elements['directory-results'].children[0].children[0].children[1].textContent, /新课程/);
});

test('changing search text clears obsolete results and resets pagination controls', async () => {
  const documentRef = makeDocument();
  const picker = createDirectoryPicker({ documentRef, chromeApi: { runtime: { async sendMessage() { return { state: 'ready', courses: [{ course_id: '1', course_title: '数学', teacher: '教师' }], total: 40, page: 1, hasMore: true }; } } } });
  documentRef.elements['directory-term'].value = 'term1';
  await picker.search();
  assert.equal(documentRef.elements['directory-next'].disabled, false);
  documentRef.elements['directory-query'].value = 'new';
  assert.equal(typeof documentRef.elements['directory-query'].listeners.input, 'function');
  documentRef.elements['directory-query'].listeners.input();
  assert.equal(documentRef.elements['directory-results'].children.length, 0);
  assert.equal(documentRef.elements['directory-next'].disabled, true);
});
