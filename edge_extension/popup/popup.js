export function sortLiveCourses(courses = []) {
  return [...courses].sort((a, b) => String(a?.starts_at || '').localeCompare(String(b?.starts_at || '')));
}

const hasDocument = typeof document !== 'undefined';
const loginButton = hasDocument ? document.getElementById('login') : null;
const status = hasDocument ? document.getElementById('status') : null;
const list = hasDocument ? document.getElementById('courses') : null;
const courseIdsInput = hasDocument ? document.getElementById('course-ids') : null;
const saveCourseIdsButton = hasDocument ? document.getElementById('save-course-ids') : null;

function renderCourses(courses) {
  if (!list) return;
  list.replaceChildren(...sortLiveCourses(courses).map((course) => {
    const item = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = course.course_title || 'Live course';
    const details = document.createTextNode(`${course.teacher || ''} · ${course.room || ''}`);
    const startsAt = document.createTextNode(course.starts_at || '');
    item.append(title, document.createElement('br'), details, document.createElement('br'), startsAt);
    const button = document.createElement('button');
    button.textContent = 'Open player';
    button.addEventListener('click', () => chrome.runtime.sendMessage({ version: 1, type: 'OPEN_PLAYER', payload: { courseId: course.course_id, subId: course.sub_id, view: (course.available_views || ['teacher'])[0] } }));
    item.append(button);
    return item;
  }));
}

async function loadLive() {
  try {
    const result = await chrome.runtime.sendMessage({ version: 1, type: 'LIST_LIVE', payload: {} });
    if (result?.state === 'login-required') { if (status) status.textContent = 'Log in with Fudan CAS to view live courses.'; return; }
    renderCourses(result?.courses || []);
    if (status) status.textContent = result?.courses?.length ? '' : 'No current live courses.';
  } catch (error) { if (status) status.textContent = error.message; }
}

async function loadCourseIdSettings() {
  if (!courseIdsInput) return;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_COURSE_IDS' });
    courseIdsInput.value = Array.isArray(result?.courseIds) ? result.courseIds.join(', ') : '';
  } catch (_) {
    courseIdsInput.value = '';
  }
}

saveCourseIdsButton?.addEventListener('click', async () => {
  if (saveCourseIdsButton) saveCourseIdsButton.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'SET_COURSE_IDS',
      courseIds: courseIdsInput?.value || '',
    });
    if (!result?.ok) throw new Error(result?.error || 'Unable to save course IDs');
    if (status) status.textContent = 'Course IDs saved.';
    await loadLive();
  } catch (error) {
    if (status) status.textContent = error.message;
  } finally {
    if (saveCourseIdsButton) saveCourseIdsButton.disabled = false;
  }
});

loginButton?.addEventListener('click', async () => {
  if (loginButton) loginButton.disabled = true;
  if (status) status.textContent = 'Opening Fudan login…';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'OPEN_CAS_LOGIN' });
    if (!result?.ok) throw new Error(result?.error || 'Login unavailable');
    if (status) status.textContent = 'Complete login in the new tab.';
  } catch (error) {
    if (status) status.textContent = error.message;
    if (loginButton) loginButton.disabled = false;
  }
});

if (hasDocument) {
  loadCourseIdSettings();
  loadLive();
}
