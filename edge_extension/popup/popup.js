import { readCourseSelections, saveCourseIds } from '../src/course-settings.js';
import { createDirectoryPicker } from './directory.js';

export function sortLiveCourses(courses = []) {
  return [...courses].sort((a, b) => String(a?.starts_at || '').localeCompare(String(b?.starts_at || '')));
}

export function createPopup({ documentRef = globalThis.document, chromeApi = globalThis.chrome } = {}) {
  const document = documentRef;
  const loginButton = document.getElementById('login');
  const status = document.getElementById('status');
  const list = document.getElementById('courses');
  const input = document.getElementById('course-ids');
  const form = document.getElementById('course-settings');
  const saveButton = document.getElementById('save');
  const refreshButton = document.getElementById('refresh');
  const storage = chromeApi?.storage?.local;
  let generation = 0;
  const directory = createDirectoryPicker({ documentRef, chromeApi, storage, onSaved: async ids => {
    input.value = ids.join('\n');
    await loadLive();
  } });

  function renderCourses(courses) {
    list.replaceChildren(...sortLiveCourses(courses).map(course => {
      const item = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = course.course_title || '直播课程';
      const details = document.createTextNode(`${course.teacher || ''} · ${course.room || ''}`);
      const startsAt = document.createTextNode(course.starts_at || '');
      item.append(title, document.createElement('br'), details, document.createElement('br'), startsAt);
      const button = document.createElement('button');
      button.textContent = '打开直播';
      button.addEventListener('click', async () => {
        try {
          const result = await chromeApi.runtime.sendMessage({ version: 1, type: 'OPEN_PLAYER', payload: { courseId: course.course_id, subId: course.sub_id, view: (course.available_views || ['teacher'])[0] } });
          if (!result?.ok) throw new Error();
        } catch (_) { status.textContent = '无法打开播放器，请刷新后重试。'; }
      });
      item.append(button);
      return item;
    }));
  }

  async function loadLive() {
    const current = ++generation;
    refreshButton.disabled = true;
    status.textContent = '正在检查课程…';
    try {
      const result = await chromeApi.runtime.sendMessage({ version: 1, type: 'LIST_LIVE', payload: {} });
      if (current !== generation) return;
      const state = result?.state;
      if (!result || result.error || result.ok === false || !['ready', 'empty', 'unconfigured', 'login-required'].includes(state)) throw new Error();
      renderCourses(state === 'ready' ? result.courses || [] : []);
      status.textContent = state === 'unconfigured' ? '请先添加要关注的课程并保存。'
        : state === 'login-required' ? '请点击“复旦官方登录”，完成后刷新课程。'
          : result.courses?.length ? `找到 ${result.courses.length} 节当前直播。`
            : '已检查所配置课程，目前暂无直播。';
    } catch (_) {
      if (current !== generation) return;
      renderCourses([]);
      status.textContent = '连接失败，请检查网络或 WebVPN，再刷新课程。';
    } finally {
      if (current === generation) refreshButton.disabled = false;
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    saveButton.disabled = true;
    try {
      const ids = await saveCourseIds(input.value, storage);
      input.value = ids.join('\n');
      directory.setSavedCourseIds(ids);
      await loadLive();
    } catch (error) {
      status.textContent = error instanceof TypeError ? error.message : '课程保存失败，请重新打开扩展后重试。';
    } finally { saveButton.disabled = false; }
  });
  refreshButton.addEventListener('click', loadLive);
  loginButton.addEventListener('click', async () => {
    loginButton.disabled = true;
    status.textContent = '正在打开复旦官方登录…';
    try {
      const result = await chromeApi.runtime.sendMessage({ type: 'OPEN_CAS_LOGIN' });
      if (!result?.ok) throw new Error();
      status.textContent = '请在新标签页完成登录，然后重新打开扩展并刷新课程。';
    } catch (_) { status.textContent = '无法打开登录页，请重试。'; }
    finally { loginButton.disabled = false; }
  });

  const ready = readCourseSelections(storage).then(selections => {
    const ids = selections.map(item => item.course_id);
    input.value = ids.join('\n');
    directory.setSavedCourses(selections);
    return loadLive();
  }).catch(() => { status.textContent = '无法读取课程配置，请重新打开扩展。'; });
  return { ready, loadLive, directory };
}

if (typeof document !== 'undefined') createPopup();
