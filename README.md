# Fudan iCourse Live Player

复旦 iCourse 当前直播播放器。支持 Chrome / Edge 扩展，以及在 Windows / macOS 本机运行的独立播放器。仅播放当前直播，仍需本人有效的学校登录与可用的校园网 / WebVPN。

## 快速开始

推荐浏览器扩展：构建后打开 `chrome://extensions` 或 `edge://extensions`，开启开发者模式，选择“加载已解压的扩展程序”，加载 `dist/edge-extension`。点击“复旦官方登录”，完成后“加载学期”，按课程名、教师、学院或课程代码搜索，勾选后“保存关注课程”；有课正在直播时点击“打开直播”。课程配置只保存在本机，登录在学校官方页面完成。

本地播放器支持 Python 3.10+：

```sh
python -m pip install -r requirements.txt
python -m live_player --interactive
```

按提示输入学号、密码，再按课程名或教师搜索并选择编号。选择自动保存为 `course-selection.json`，下次直接复用；加 `--select-courses` 可重新选择。密码输入不会显示，也不会由启动器保存。macOS 优先打开 Chrome；Windows 优先打开 Edge。浏览器会自动配对，无需复制地址或令牌。关闭终端可停止助手。

## 本地实时转录

实时转录由本机运行的开源 `faster-whisper` 模型完成，默认模型是 `base`。它不使用任何 AI API key，也没有按次或按时长的 API 成本；课程授权、播放和转录仍仅在你的本机助手中进行。

1. 按上面的命令安装并启动本地助手，随后选择一门正在直播的课程并开始播放。
2. 在播放器的“实时转录”面板点击“开始转录”。这是手动操作，播放不会自动启动转录。
3. 首次使用时等待默认 `base` 模型下载并加载；之后会复用本机已下载的模型。不要把模型目录或缓存打包、上传或提交。
4. 默认提醒关键词为：点名、签到、小测、测验、期中、期末、quiz。可按需修改关键词，并启用页面提醒、声音提醒和系统通知。
5. 关闭页面前使用“导出 Markdown”保存需要保留的内容。音频不保存到磁盘；转录文字只在当前页面会话中存在，未导出即会在关闭页面后消失。

CPU 可以运行转录，但较慢的电脑可能跟不上直播；有可用 GPU 时 `faster-whisper` 会使用 GPU 加速。仅安装 Edge/Chrome 扩展的播放路径不能运行本地转录，必须启动支持转录的本地助手。

常见问题：显示“未找到 ffmpeg，请安装后重新启动本地助手。”时安装可用的 ffmpeg 后重启助手；模型下载失败时检查网络或稍后重试；CPU 太慢时选择较小模型或关闭其他负载；系统通知没有出现时在浏览器设置中允许通知；复旦登录过期时重新在官方页面登录；课程结束或没有直播时停止转录并刷新课程状态。

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
search by course name, teacher, department, or course code, then select courses
and click `保存关注课程`. The term choices come from the official recent-course
page. Directory searches walk all pages and cache only course metadata in memory
for five minutes. The `手动输入课程链接或 ID` section remains available as a fallback.

The IDs are stored only in the browser extension's local storage. Click
`复旦官方登录` once to establish the official session, then refresh
the Pages player. The extension lists only courses that are live right now;
an empty list does not indicate that a replay is available.

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

The historical `build_windows.py` name is retained; it now runs PyInstaller on the current OS and creates a platform-specific ZIP in `dist/`. Build Windows packages on Windows and macOS packages on macOS. macOS packages include a double-click `.command` launcher. Native ZIPs include the `faster-whisper` runtime and wheel-provided ffmpeg, but exclude model weights/caches, audio, transcripts, and credentials. The release workflow tests first, audits each ZIP, builds both platforms, uploads artifacts for manual runs, and publishes ZIPs/checksums only on `live-v*` tags. Native packages are not vendor-signed/notarized.
