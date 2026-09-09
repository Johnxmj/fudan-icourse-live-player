// Run from the extension player DevTools console after an authorized current-live login.
(() => {
  const video = document.querySelector('#video');
  const diagnostics = window.__fudanPlayerDiagnostics;
  const observationMs = 5000;
  const started = video.currentTime;
  const initialFragmentCount = Number.isFinite(diagnostics?.fragmentCount) ? diagnostics.fragmentCount : null;
  setTimeout(() => console.log({
    'manifest HTTP status': diagnostics?.manifestHttpStatus ?? null,
    'fragment count after 5 seconds': initialFragmentCount === null || !Number.isFinite(diagnostics?.fragmentCount)
      ? null
      : Math.max(0, diagnostics.fragmentCount - initialFragmentCount),
    'MediaSource readyState': diagnostics?.mediaSource?.readyState ?? null,
    'video readyState': video.readyState,
    videoWidth: video.videoWidth,
    [`currentTime advances over ${observationMs / 1000} seconds`]: video.currentTime > started,
  }), observationMs);
})();
