import test from 'node:test';
import assert from 'node:assert/strict';
import { sortLiveCourses } from '../../edge_extension/popup/popup.js';
import * as popup from '../../edge_extension/popup/popup.js';

test('popup sorts live courses by start time', () => {
  assert.deepEqual(sortLiveCourses([
    { starts_at: '10:00', sub_id: '2' },
    { starts_at: '08:00', sub_id: '1' },
  ]).map((x) => x.sub_id), ['1', '2']);
});

test('popup renders course metadata through text nodes', async () => {
  const { readFileSync } = await import('node:fs');
  const script = readFileSync('edge_extension/popup/popup.js', 'utf8');
  assert.doesNotMatch(script, /\.innerHTML\s*=/);
  assert.match(script, /textContent\s*=/);
  assert.match(script, /createTextNode/);
});

function makeDocument() {
  const elements = {};
  const node = () => ({ textContent: '', value: '', disabled: false, listeners: {}, children: [],
    addEventListener(type, handler) { this.listeners[type] = handler; },
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); },
  });
  return { elements, getElementById(id) { return elements[id] ||= node(); }, createElement: node, createTextNode: text => ({ textContent: text }) };
}

test('popup saves pasted course links and refreshes the configured live catalog', async () => {
  assert.equal(typeof popup.createPopup, 'function');
  const documentRef = makeDocument();
  let saved = { courseIds: ['old'] };
  let calls = 0;
  const chromeApi = {
    storage: { local: { async get() { return saved; }, async set(value) { saved = value; } } },
    runtime: { async sendMessage() { calls += 1; return { state: 'ready', courses: [] }; } },
  };
  const controller = popup.createPopup({ documentRef, chromeApi });
  await controller.ready;
  assert.equal(documentRef.elements['course-ids'].value, 'old');
  documentRef.elements['course-ids'].value = 'https://icourse.fudan.edu.cn/?course_id=123';
  await documentRef.elements['course-settings'].listeners.submit({ preventDefault() {} });
  assert.deepEqual(saved, { courseIds: ['123'] });
  assert.equal(calls, 2);
  assert.match(documentRef.elements.status.textContent, /暂无/);
});

test('popup distinguishes unconfigured, login, failed requests, and an empty live catalog', async () => {
  assert.equal(typeof popup.createPopup, 'function');
  const documentRef = makeDocument();
  let result = { state: 'unconfigured', courses: [] };
  const controller = popup.createPopup({ documentRef, chromeApi: {
    storage: { local: { async get() { return {}; } } },
    runtime: { async sendMessage() { return result; } },
  } });
  await controller.ready;
  assert.match(documentRef.elements.status.textContent, /添加.*课程/);
  result = { state: 'login-required', courses: [] };
  await controller.loadLive();
  assert.match(documentRef.elements.status.textContent, /登录/);
  for (result of [{ state: 'failed' }, { ok: false, error: 'private upstream url' }]) {
    await controller.loadLive();
    assert.match(documentRef.elements.status.textContent, /网络|连接/);
    assert.doesNotMatch(documentRef.elements.status.textContent, /暂无|private/);
  }
  result = { state: 'ready', courses: [] };
  await controller.loadLive();
  assert.match(documentRef.elements.status.textContent, /暂无/);
});
