# Persistent Course Catalog Design

## Goal

让本地启动器、Edge 扩展和 GitHub Pages 统一支持手动选择学期，并让每个用户已关注的课程在播放器页面长期显示；正在直播的课程可播放，其他课程显示“暂无直播”。

## Scope and constraints

- 改动覆盖 `live_player/`、`edge_extension/`、`frontend/live/`、桥接协议、测试和文档。
- 课程关注数据按用户本机保存，不增加云端数据库或代理服务。
- 旧版只保存 `courseIds` 的数据必须继续可读。
- Pages 只能接收课程公开元数据和直播状态，不接收 Cookie、凭证或媒体 URL。
- 直播源解析与现有播放授权流程保持不变。

## Architecture

### Shared course record

课程关注记录使用公开元数据：`course_id`、`course_title`、`teacher`、`dept`、`course_code`、`term_id`、`term_title`。扩展在 `chrome.storage.local` 保存记录；本地启动器在 `course-selection.json` 保存记录和最近学期。读取时兼容旧版 `courseIds`，缺少元数据的课程通过官方课程详情补全。

### Semester selection

启动器先展示官方返回的学期列表和编号，用户输入单个编号后读取对应学期目录；最近一次选择写入本机配置。扩展的 `<select>` 直接驱动搜索请求，并保存最近选择的学期。

### Course listing and playback

新增 `LIST_FOLLOWED` 公共请求。后台把已关注课程元数据与当前直播探测结果按 `course_id` 合并，返回 `status: live|offline`。Pages 和本地页面显示完整列表；只有 `live` 且带有效 `sub_id`、`available_views` 的记录允许启动播放器。现有 `LIST_LIVE` 保留兼容，继续返回仅直播课程的结果。

### Safety

桥接层只允许 `CAPABILITIES`、`LIST_LIVE`、`LIST_FOLLOWED`、`REFRESH`，并复用现有白名单字段清洗。离线课程不生成媒体令牌，也不暴露上游地址。

## Error handling

- 学期目录读取失败：保留已保存选择，显示可重试错误。
- 课程详情部分失败：保留课程卡片，以已保存元数据显示为“状态未知”；不阻塞其他课程。
- 会话过期：整个列表进入登录提示，不显示陈旧直播数据。
- 用户点击离线课程：不请求媒体源，显示“当前暂无直播”。

## Verification

- Python：学期选择、配置读写、离线/直播合并和 API 响应测试。
- Node：扩展存储、学期选择、后台请求、桥接清洗、Pages 列表和点击行为测试。
- 构建：Edge 扩展、Pages 资源同步、Windows artifact audit。
