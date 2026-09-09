# Persistent Course Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让三端支持手动选学期，并在 Pages 与本地播放器中常驻显示每个用户已关注的课程。

**Architecture:** 扩展和本地启动器保存带公开元数据的关注课程记录，后台/本地 API 将其与当前直播探测结果合并为统一目录。Pages 通过白名单桥接读取目录，只对直播记录启动现有隔离播放器。

**Tech Stack:** Python 3.10+、Node.js ESM、Edge Manifest V3、GitHub Pages 静态 HTML/CSS/JS、Node `node:test`、Python `unittest`。

## Global Constraints

- 不增加云端数据库、云端代理或第三方同步服务。
- 旧版 `courseIds` 和旧版 `LIST_LIVE` 请求保持兼容。
- Pages 与桥接层不得传输 Cookie、密码、媒体 URL 或媒体凭证。
- 每个用户的关注数据只保存在自己的浏览器扩展或本地配置文件中。

### Task 1: Python launcher semester selection and persistent metadata

**Files:**
- Modify: `live_player/cli.py`
- Modify: `tests/test_cli_course_selection.py`
- Modify: `tests/live_server/test_cli.py`
- Modify: `docs/live-player.md`

**Interfaces:**
- Add `choose_term(terms, input_fn=input, output_fn=print) -> dict`.
- Extend `load_course_selection()`/`save_course_selection()` to accept `{courseIds, term, termName, courses}` while reading legacy files.
- `select_courses()` must call `choose_term()` when no cached catalog is supplied and use the chosen term code.

- [x] Write a failing test proving `choose_term` selects the requested numbered term and rejects invalid input.
- [x] Run `python -m unittest tests.test_cli_course_selection -q`; expect the new test to fail because the helper is absent.
- [x] Implement numbered term display, validation, and last-term persistence with legacy fallback.
- [x] Run the focused Python tests and verify PASS.
- [x] Add a test proving saved course metadata and term survive a load/save round trip.
- [x] Run all Python tests and verify no regression.

### Task 2: Extension storage and resident followed-course list

**Files:**
- Modify: `edge_extension/src/course-settings.js`
- Modify: `edge_extension/popup/index.html`
- Modify: `edge_extension/popup/directory.js`
- Modify: `edge_extension/popup/popup.js`
- Modify: `tests/extension/course-settings.test.mjs`
- Modify: `tests/extension/directory-picker.test.mjs`
- Modify: `tests/extension/popup.test.mjs`

**Interfaces:**
- Add `readCourseSelections(storage) -> Promise<CourseSelection[]>`.
- Add `saveCourseSelections(changes, storage) -> Promise<CourseSelection[]>`.
- Preserve `readCourseIds` and `saveCourseIds` as compatibility wrappers.
- Add a resident “已关注课程” list in the popup, including remove/unfollow controls and the saved term.

- [x] Write failing storage tests for metadata persistence, legacy ID migration, and removal.
- [x] Run focused Node tests; verify the new assertions fail for the missing APIs/UI.
- [x] Implement the normalized storage schema and render resident list.
- [x] Persist the selected semester on `<select>` change and restore it on popup startup.
- [x] Run focused extension tests and verify PASS.

### Task 3: Unified followed-course API in extension and bridge

**Files:**
- Modify: `edge_extension/src/live-api.js`
- Modify: `edge_extension/src/protocol.js`
- Modify: `edge_extension/src/background.js`
- Modify: `edge_extension/src/page-bridge.js`
- Modify: `frontend/live/transports/extension.js`
- Modify: `tests/extension/background.test.mjs`
- Modify: `tests/pages_live/extension.test.mjs`

**Interfaces:**
- Add `LIST_FOLLOWED` protocol type.
- Add `listFollowedCourses(fetcher, selections, now) -> Promise<CourseRecord[]>` returning `status: live|offline|unknown` without media URLs.
- Add `handlers.listFollowed()` and external `LIST_FOLLOWED` handling.
- Add `extensionTransport.listFollowed()`.

- [x] Write failing tests for merging offline metadata with live records and redacting media fields.
- [x] Run focused tests and verify failure.
- [x] Implement merge logic with bounded per-course detail requests and preserve partial failures as `unknown`.
- [x] Extend protocol/bridge allowlists and sanitizers.
- [x] Run extension and bridge tests and verify PASS.

### Task 4: Pages and local player render the persistent catalog

**Files:**
- Modify: `frontend/live/app.js`
- Modify: `frontend/live/transports/local.js`
- Modify: `live_player/server/app.py`
- Modify: `live_player/web/app.js`
- Modify: `live_player/web/transport-local.js`
- Modify: `tests/pages_live/playback.test.mjs`
- Modify: `tests/live_web/app.test.mjs`
- Modify: `tests/live_web/transport-local.test.mjs`
- Modify: `tests/live_server/test_app.py`

**Interfaces:**
- Add local `GET /api/followed-courses` returning the sanitized persistent catalog.
- Add `listFollowed()`/`listFollowedCourses()` to local transport adapters.
- Pages and local UI render offline cards and refuse media mounting unless the selected record is live.

- [x] Write failing UI/API tests for offline cards and the no-media click path.
- [x] Run focused tests and verify failure.
- [x] Implement local endpoint and adapter methods.
- [x] Update rendering and state copy for live/offline/unknown records.
- [x] Run focused tests and verify PASS.

### Task 5: Documentation, build, and release verification

**Files:**
- Modify: `README.md`
- Modify: `docs/live-player.md`
- Modify: `tests/extension/build.test.mjs`
- Modify: `scripts/sync_live_web.mjs` only if generated assets require synchronization.

- [x] Document the numbered semester flow, resident course list, local-only persistence, and offline card behavior.
- [x] Run Python unit tests.
- [x] Run Node live/extension/Pages tests.
- [x] Run `node edge_extension/scripts/build.mjs`.
- [x] Run `node scripts/sync_live_web.mjs --check`.
- [x] Run `python scripts/build_windows.py --audit-only`.
- [ ] Review the diff for secret-bearing files and commit the complete feature.
