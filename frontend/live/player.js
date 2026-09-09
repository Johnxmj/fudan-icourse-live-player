/** Local media stays on loopback; the extension keeps its own isolated player. */
export function mountLocalPlayer(container, transport, course, view, {
  Hls = globalThis.Hls,
  onStatus = () => {},
  onRefresh = async () => {},
} = {}) {
  if (!course.media_token) throw new Error("缺少播放凭证，请刷新课程后重试。");
  const video = container.ownerDocument.createElement("video");
  video.controls = true;
  video.playsInline = true;
  video.setAttribute("aria-label", "课程直播");
  container.replaceChildren(video);
  let hls = null;
  let disposed = false;
  let networkRetries = 0;
  let mediaRetries = 0;
  let refreshAttempted = false;
  const play = async () => {
    if (disposed) return;
    try { await video.play(); }
    catch { onStatus("connected", "已准备好，点击视频中的播放按钮开始观看。"); }
  };
  const onPlaying = () => { if (!disposed) onStatus("playing"); };
  video.addEventListener("playing", onPlaying);
  const url = transport.manifestUrl(course.course_id, course.sub_id, view, course.media_token);
  if (Hls?.isSupported?.()) {
    hls = new Hls({ liveSyncDurationCount: 2, backBufferLength: 30 });
    hls.on(Hls.Events.MANIFEST_PARSED, play);
    hls.on(Hls.Events.ERROR, async (_event, data) => {
      if (disposed || !data?.fatal) return;
      const status = data.response?.code ?? data.response?.status;
      if (data.type === Hls.ErrorTypes?.MEDIA_ERROR && mediaRetries++ < 1) {
        onStatus("connected", "正在恢复播放画面…");
        hls.recoverMediaError();
      } else if (status !== 401 && status !== 403 && data.type === Hls.ErrorTypes?.NETWORK_ERROR && networkRetries++ < 2) {
        onStatus("connected", "连接中断，正在重新连接直播…");
        hls.startLoad();
      } else if (!refreshAttempted) {
        refreshAttempted = true;
        await onRefresh();
      } else {
        onStatus("failed", "播放暂时中断。请检查校园网或 WebVPN，然后点击刷新课程。");
      }
    });
    hls.attachMedia(video);
    hls.loadSource(url);
  } else if (video.canPlayType?.("application/vnd.apple.mpegurl")) {
    video.src = url;
    video.addEventListener("error", () => {
      if (disposed) return;
      if (!refreshAttempted) { refreshAttempted = true; void onRefresh(); }
      else onStatus("failed", "视频连接已中断，请刷新课程重试。");
    });
    void play();
  } else {
    onStatus("failed", "当前浏览器无法播放此视频，请使用最新版 Chrome 或 Edge。");
  }
  return {
    dispose() {
      disposed = true;
      hls?.destroy();
      video.removeEventListener?.("playing", onPlaying);
      video.pause?.();
      video.removeAttribute?.("src");
      video.load?.();
      container.replaceChildren();
    },
  };
}
