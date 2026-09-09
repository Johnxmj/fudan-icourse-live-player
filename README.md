# Fudan iCourse Live Player

复旦 iCourse 当前直播播放器。支持 Chrome / Edge 扩展，以及在 Windows / macOS 本机运行的独立播放器。仅播放当前直播，仍需本人有效的学校登录与可用的校园网 / WebVPN。

## 快速开始

推荐浏览器扩展：构建后打开 `chrome://extensions` 或 `edge://extensions`，开启开发者模式，选择“加载已解压的扩展程序”，加载 `dist/edge-extension`。点击“复旦官方登录”，完成后“加载学期”，从列表中手动选择学期，按课程名、教师、学院或课程代码搜索，勾选后“保存关注课程”。已关注课程会常驻在扩展和 Pages 页面中；没有当前直播时显示“暂无直播”，开课后刷新即可。课程配置和课程公开元数据只保存在本机，登录在学校官方页面完成。

本地播放器支持 Python 3.10+：

```sh
python -m pip install -r requirements.txt
python -m live_player --interactive
```

按提示输入学号、密码，从官方返回的学期列表中选择编号，再按课程名或教师搜索并选择编号。课程 ID、所选学期和公开课程元数据自动保存为 `course-selection.json`，下次直接复用；加 `--select-courses` 可重新选择。密码输入不会显示，也不会由启动器保存。macOS 优先打开 Chrome；Windows 优先打开 Edge。浏览器会自动配对，无需复制地址或令牌。关闭终端可停止助手。

完整安装、排错和验收步骤见 [中文使用说明](docs/live-player.md)。PR 合并前，已部署的公共 Pages 页面仍可能是旧版本；本机扩展入口与本地播放器可独立使用。

Standalone Fudan iCourse current-live player with a Microsoft Edge extension,
GitHub Pages shell, and loopback bridge. This is a separate project; it does
not contain the encrypted-summary subscriber, email delivery, database,
recording, download, or pre-release playback features.

## Components

- `live_player/` — loopback-only Windows/Python bridge and current-live API.
- `edge_extension/` — Microsoft Edge Manifest V3 helper and embedded player.
- `frontend/live/` — static GitHub Pages shell.

The Pages shell has no cloud proxy. It works with the Edge extension or with an
explicitly started local bridge. Pairing tokens are fragment-only, one-use, and
kept in memory; media is streamed without local persistence.

On the public Pages site, the Edge helper is detected through a content-script
bridge injected only on `https://johnxmj.github.io/*`. The bridge uses a
versioned nonce handshake and exposes only capabilities, current-live metadata,
and refresh. Credentials, cookies, bearer tokens, signed media URLs, and player
source responses remain inside the extension or local bridge.

## Run locally

Install Python dependencies from `requirements.txt`, set `StuId`, `UISPsw`, and
`COURSE_IDS` in the local environment, then run:

```powershell
python -m live_player.cli --pages
```

The launcher binds only to `127.0.0.1` and opens the Pages live route in Edge.
Never commit the environment file or real credentials.

## Build the Edge extension

```powershell
node edge_extension/scripts/build.mjs
```

Load `dist/edge-extension` in `edge://extensions` with Developer mode enabled.
The generated ZIP is `dist/fudan-icourse-live-edge.zip`.

After loading the extension, complete the official login, click `加载学期`,
choose a term from the returned list, search by course name, teacher, department,
or course code, then select courses and click `保存关注课程`. The term choices
come from the official recent-course page. Directory searches walk all pages and
cache only course metadata in memory for five minutes. The `手动输入课程链接或
ID` section remains available as a fallback. Followed course IDs, the selected
term, and safe display metadata are stored only in the local extension storage.

The followed catalog is stored only in the browser extension's local storage.
Click `复旦官方登录` once to establish the official session, then refresh the
Pages player. The catalog keeps every followed course visible and annotates it
as live, offline, or temporarily unknown. Only a live record can open the
isolated player; an offline card is informational and does not imply replay
availability.

## Test

```powershell
python -m unittest discover -s tests -q
node --test tests/live_web/*.test.mjs tests/pages_live/*.test.mjs tests/extension/*.test.mjs
```

Real playback still requires an authorized Fudan session and a lecture that is
currently live. The project intentionally does not bypass delayed replay access.

## Native release builds

```sh
python -m pip install -r requirements.txt -r requirements-live-build.txt
python scripts/build_windows.py
node edge_extension/scripts/build.mjs
python scripts/checksums.py
```

The historical `build_windows.py` name is retained; it now runs PyInstaller on the current OS and creates a platform-specific ZIP in `dist/`. Build Windows packages on Windows and macOS packages on macOS. macOS packages include a double-click `.command` launcher. The release workflow tests first, builds both platforms, uploads artifacts for manual runs, and publishes ZIPs/checksums on `live-v*` tags. Native packages are not vendor-signed/notarized.
