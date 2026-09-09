import { readCourseSelections, readSelectedTerm, saveCourseSelection, saveSelectedTerm } from '../src/course-settings.js';

export function createDirectoryPicker({ documentRef = globalThis.document, chromeApi = globalThis.chrome, storage = chromeApi?.storage?.local, onSaved = async () => {} } = {}) {
  const document = documentRef;
  const term = document.getElementById('directory-term');
  const query = document.getElementById('directory-query');
  const form = document.getElementById('directory-search');
  const loadButton = document.getElementById('directory-load');
  const searchButton = document.getElementById('directory-submit');
  const results = document.getElementById('directory-results');
  const status = document.getElementById('directory-status');
  const count = document.getElementById('directory-followed');
  const followedTerm = document.getElementById('directory-followed-term');
  const followedList = document.getElementById('directory-followed-list');
  const previous = document.getElementById('directory-previous');
  const next = document.getElementById('directory-next');
  const saveButton = document.getElementById('directory-save');
  let saved = new Map();
  const changes = new Map();
  let currentCourses = [];
  let page = 1;
  let generation = 0;
  let selectedTerm = null;

  function updateSelectionState() {
    const projected = new Map(saved);
    for (const [id, selected] of changes) { if (selected) projected.set(id, projected.get(id) || { course_id: id }); else projected.delete(id); }
    count.textContent = `已关注 ${saved.size} 门课程${changes.size ? `，保存后为 ${projected.size} 门` : ''}。`;
    if (followedTerm) followedTerm.textContent = selectedTerm ? `保存学期：${selectedTerm.title || selectedTerm.id}` : '保存学期：未选择';
    saveButton.disabled = changes.size === 0;
    if (followedList) {
      followedList.replaceChildren(...[...projected.values()].map(course => {
        const item = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = `${course.course_title || '课程 ' + course.course_id}${course.teacher ? ` · ${course.teacher}` : ''}`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '取消关注';
        remove.addEventListener('click', () => {
          if (saved.has(course.course_id)) changes.set(course.course_id, false);
          else changes.delete(course.course_id);
          updateSelectionState();
        });
        item.append(label, remove);
        return item;
      }));
    }
  }

  function renderCourses(courses) {
    currentCourses = courses;
    results.replaceChildren(...courses.map(course => {
      const item = document.createElement('li');
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = changes.has(course.course_id) ? changes.get(course.course_id) : saved.has(course.course_id);
      const title = document.createElement('span');
      title.textContent = `${course.course_title || '未命名课程'} · ${course.teacher || '教师未标注'}`;
      checkbox.addEventListener('change', () => {
        if (checkbox.checked === saved.has(course.course_id)) changes.delete(course.course_id);
        else changes.set(course.course_id, checkbox.checked);
        updateSelectionState();
      });
      label.append(checkbox, title);
      item.append(label);
      if (course.dept || course.course_code) {
        const detail = document.createElement('small');
        detail.textContent = [course.dept, course.course_code].filter(Boolean).join(' · ');
        item.append(detail);
      }
      return item;
    }));
  }

  function showError(result) {
    status.textContent = result?.state === 'login-required'
      ? '请先点击“复旦官方登录”，登录后重新加载学期或搜索。'
      : '课程目录加载失败，请检查网络或 WebVPN 后重试。';
  }

  async function loadTerms() {
    const current = ++generation;
    loadButton.disabled = true;
    searchButton.disabled = true;
    previous.disabled = true;
    next.disabled = true;
    renderCourses([]);
    status.textContent = '正在读取最近课程所属学期…';
    try {
      const result = await chromeApi.runtime.sendMessage({ type: 'GET_DIRECTORY_TERMS' });
      if (current !== generation) return;
      if (result?.state !== 'ready' || !Array.isArray(result.terms) || !result.terms.length) { showError(result); return; }
      term.replaceChildren(...result.terms.map(item => {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.title;
        return option;
      }));
      const remembered = await readSelectedTerm(storage);
      const preferred = remembered?.id || result.currentTerm;
      term.value = result.terms.some(item => item.id === preferred) ? preferred : result.terms[0].id;
      const selected = result.terms.find(item => item.id === term.value);
      selectedTerm = selected ? { id: selected.id, title: selected.title } : remembered;
      updateSelectionState();
      searchButton.disabled = false;
      status.textContent = '已识别最近课程所属学期。输入课程名、教师、学院或课程代码后搜索；留空可浏览本学期可见课程。';
    } catch (_) { if (current === generation) showError(); }
    finally { if (current === generation) loadButton.disabled = false; }
  }

  async function search(requestedPage = 1) {
    if (!term.value) { status.textContent = '请先加载学期并选择要查询的学期。'; return; }
    const current = ++generation;
    searchButton.disabled = true;
    previous.disabled = true;
    next.disabled = true;
    renderCourses([]);
    status.textContent = '正在读取本学期课程，首次搜索可能需要一点时间…';
    try {
      const result = await chromeApi.runtime.sendMessage({ type: 'SEARCH_COURSES', term: term.value, query: query.value.trim(), page: requestedPage, perPage: 20 });
      if (current !== generation) return;
      if (result?.state !== 'ready' || !Array.isArray(result.courses)) { showError(result); return; }
      renderCourses(result.courses);
      page = result.page;
      previous.disabled = page <= 1;
      next.disabled = !result.hasMore;
      status.textContent = result.total ? `找到 ${result.total} 门课程，当前第 ${page} 页。勾选后点击“保存关注课程”。` : '没有匹配的课程，请更换课程名、教师、学院、课程代码或学期。';
    } catch (_) { if (current === generation) showError(); }
    finally { if (current === generation) searchButton.disabled = false; }
  }

  async function saveSelection() {
    saveButton.disabled = true;
    try {
      const selections = currentCourses.map(course => ({ ...course }));
      const byId = new Map(selections.map(course => [course.course_id, course]));
      const ids = await saveCourseSelection([...changes].map(([courseId, selected]) => ({ courseId, selected, course: byId.get(courseId) })), storage);
      changes.clear();
      const latest = await readCourseSelections(storage);
      saved = new Map(latest.map(course => [course.course_id, course]));
      renderCourses(currentCourses);
      updateSelectionState();
      status.textContent = `已保存 ${ids.length} 门关注课程，正在检查直播。`;
      await onSaved(ids);
    } catch (error) {
      status.textContent = error instanceof TypeError ? error.message : '关注课程保存失败，请重试。';
      updateSelectionState();
    }
  }

  loadButton.addEventListener('click', loadTerms);
  const resetSearch = () => {
    generation += 1;
    renderCourses([]);
    previous.disabled = true;
    next.disabled = true;
    searchButton.disabled = !term.value;
    loadButton.disabled = false;
    status.textContent = '查询条件已更新，请点击搜索。';
  };
  query.addEventListener('input', resetSearch);
  term.addEventListener('change', () => {
    const option = [...(term.options || [])].find(item => item.value === term.value);
    selectedTerm = { id: term.value, title: option?.textContent || '' };
    if (storage?.set) void saveSelectedTerm({ id: term.value, title: option?.textContent || '' }, storage);
    resetSearch();
  });
  form.addEventListener('submit', event => { event.preventDefault(); return search(1); });
  previous.addEventListener('click', () => search(page - 1));
  next.addEventListener('click', () => search(page + 1));
  saveButton.addEventListener('click', saveSelection);
  updateSelectionState();
  return {
    loadTerms, search, saveSelection,
    setSavedCourseIds(ids) { saved = new Map((Array.isArray(ids) ? ids : []).map(id => [id, { course_id: id }])); changes.clear(); renderCourses(currentCourses); updateSelectionState(); },
    setSavedCourses(values) { saved = new Map((Array.isArray(values) ? values : []).map(course => [course.course_id, course])); changes.clear(); renderCourses(currentCourses); updateSelectionState(); },
  };
}
