# 当前直播播放器使用说明

这是独立的 Fudan iCourse 当前直播项目，只处理正在进行的课程。GitHub Pages 不提供云端代理，必须连接 Edge 扩展或本地播放器。

## 三种入口

1. 在 Edge 加载 `dist/edge-extension`，打开 Pages 的 `/live/` 页面。
2. 在本机设置 `StuId`、`UISPsw`、`COURSE_IDS` 后运行 `python -m live_player.cli --pages`。
3. 直接运行本地播放器页面，按界面提示连接助手。

登录只通过复旦官方 CAS/WebVPN 流程完成。凭证只在本机内存中使用，不写入 Pages；不要把 `.env`、Cookie、签名直播地址或日志提交到仓库。

播放器不录制、不下载、不归档视频，也不绕过回放延迟。直播源失效时可刷新课程列表；登录失效时重新完成官方登录；校园网/VPN 不可达时先恢复网络连接。

Edge 扩展卸载：打开 `edge://extensions`，找到 Fudan iCourse Live Player，选择“删除”。本地助手按 Ctrl+C 停止即可。
