# Local Whisper Live Transcription Design

## Summary

Add opt-in, near-real-time transcription to the existing Fudan iCourse current-live player. The user starts transcription manually for the currently selected live course. The local helper reads the authorized teacher audio stream, converts it in memory, runs the open-source `faster-whisper` `base` model locally, and streams timestamped transcript events back to the player UI. Keyword matches produce highlighted transcript rows, an in-page alert, an optional sound, and an optional browser/system notification.

This work replaces the replay feature as the current priority. It does not implement or extend replay browsing.

## Goals

- Provide local speech-to-text without a paid API or API key.
- Use `faster-whisper` with `base` as the default model.
- Keep transcription opt-in with an explicit **Start transcription** action.
- Show near-real-time, timestamped transcript segments in the player.
- Alert on configurable course-event keywords.
- Export the current transcript and alerts as Markdown.
- Keep raw audio off disk and keep transcripts session-only by default.
- Work through the existing loopback-only local helper and pairing-token model.

## Non-goals

- Replay discovery or replay playback.
- Recording, downloading, or retaining live audio/video.
- Cloud transcription or user-supplied AI API keys.
- Speaker diarization, translation, lecture summarization, or semantic event detection.
- Running Whisper inside the Edge extension or GitHub Pages JavaScript runtime.
- Supporting more than one active transcription session per helper process.

## User experience

### Starting a session

1. The user starts the local helper and opens the paired player page as today.
2. The user selects a currently live course and starts playback.
3. The user opens the **Live transcription** panel and clicks **Start transcription**.
4. On first use, the panel shows model download progress and then model loading status.
5. Once ready, timestamped final transcript segments appear continuously.

Transcription never starts automatically. The first release exposes only the manual start action so selecting or playing a course cannot unexpectedly consume CPU.

### Transcription panel

The panel contains:

- Start and stop controls.
- A state label: idle, downloading model, loading model, connecting audio, listening, delayed, stopped, live ended, or error.
- A scrolling list of timestamped transcript segments.
- A visible latency/backlog indicator when inference falls behind live audio.
- Clear-session and Export Markdown actions.
- A settings section for model, language, keywords, and alert channels.

The panel must remain usable beside the video on wide screens and below it on narrow screens. Starting or stopping transcription must not interrupt playback or change the selected video view.

### Defaults

- Model: `base`.
- Language: Chinese (`zh`), with automatic language detection available as an option.
- Compute: automatic GPU selection when a supported CUDA runtime is available; otherwise CPU `int8`.
- Default alert keywords: `点名`, `签到`, `小测`, `测验`, `期中`, `期末`, `quiz`.
- Same-keyword cooldown: 60 seconds.
- In-page alert, sound, and browser/system notification: enabled, with independent toggles.
- Transcript and alert history: memory only.

`作业`, `截止`, and `提交` are deliberately not default keywords. Users may add them manually.

## Architecture

### Chosen approach

The local helper owns the complete audio and inference pipeline. This is preferred over extension-side audio capture and browser-hosted Whisper because it keeps authentication and media access in the existing trusted local process, avoids Manifest V3 lifecycle constraints, and gives predictable access to native `ffmpeg` and `faster-whisper`.

The public GitHub Pages site remains a static UI. It does not receive Fudan credentials, signed upstream media URLs, raw audio, or model files. It receives sanitized transcript events only through the authenticated loopback bridge.

### Data flow

1. The browser sends an authenticated start request containing the active `course_id`, `sub_id`, and transcription options.
2. The local helper confirms that the requested course/sub-session is currently live and belongs to the current authorized session.
3. The helper resolves the teacher audio HLS source. If a dedicated teacher-audio playlist is unavailable, it falls back to the teacher video playlist and extracts its audio track.
4. `ffmpeg` reads the stream and writes 16 kHz, mono, signed 16-bit PCM to stdout. No temporary audio file is created.
5. A bounded segmenter uses voice activity detection and overlapping windows to create Whisper inputs without growing an unbounded queue.
6. `faster-whisper` transcribes each segment using the selected local model.
7. The helper emits sanitized state, transcript, and error events over an authenticated streaming HTTP response.
8. The page renders transcript events, performs deterministic keyword matching, triggers enabled alerts, and retains the session in memory for export.

### Component boundaries

New local modules should have narrow responsibilities:

- `live_player/transcription/audio.py`: resolves the authorized source, owns the `ffmpeg` subprocess, yields PCM frames, and guarantees process cleanup.
- `live_player/transcription/segmenter.py`: voice activity detection, time accounting, overlap, and bounded buffering.
- `live_player/transcription/engine.py`: lazy model download/load and `faster-whisper` inference behind a small adapter interface.
- `live_player/transcription/session.py`: one-session lifecycle, cancellation, event queue, state transitions, and idle cleanup.
- `live_player/transcription/models.py`: validated request options and sanitized event records.

The HTTP application delegates to a transcription manager instead of embedding inference logic in request handlers. Tests may inject fake audio sources and a fake engine.

Frontend transcription state and keyword matching should live in focused JavaScript modules, separate from the existing course-selection and HLS playback code. Shared pure logic may be synchronized between the local and Pages frontends; transport-specific wiring remains separate.

## Local API

All routes remain bound to numeric loopback `127.0.0.1`, use the existing session bearer, enforce the existing host/origin checks, and return `Cache-Control: no-store`.

### `GET /api/transcription/capabilities`

Returns availability, installed/cached model state, supported models, selected compute backend, and whether a transcription session is active. It never returns filesystem paths.

### `POST /api/transcription/start`

Accepts a small validated JSON body:

```json
{
  "course_id": "37142",
  "sub_id": "659200",
  "model": "base",
  "language": "zh"
}
```

The server verifies identifiers, model and language allowlists, current-live status, and session availability. It returns a random opaque transcription-session ID. If another transcription is active, it returns a conflict response rather than silently stopping it.

### `GET /api/transcription/events/{session_id}`

Uses authenticated `fetch()` streaming with `text/event-stream`; the Authorization header remains available, unlike native `EventSource`. Events include:

- `state`: lifecycle state and optional progress.
- `segment`: final text with start/end offsets.
- `lag`: current transcription backlog.
- `ended`: explicit user stop or live-stream end.
- `error`: stable public error code and safe user-facing message.

No cookies, upstream URLs, raw audio, local paths, stack traces, or model-provider metadata cross this boundary.

### `POST /api/transcription/stop`

Cancels the matching session idempotently, terminates `ffmpeg`, drains worker resources, and closes the event stream.

The server also stops transcription when the helper shuts down, when the live source ends, or after an inactivity timeout following loss of the consuming page.

## Audio processing and inference

- Prefer the dedicated teacher-audio stream; fall back to the teacher video stream only when needed.
- Convert to 16 kHz mono PCM entirely through pipes.
- Use VAD to avoid sending silence to Whisper.
- Use short, overlapping speech windows suitable for approximately 5–15 second subtitle latency.
- Preserve a small amount of prior text as a prompt/context hint where supported, while preventing unbounded prompt growth.
- Emit only finalized segments to the UI. Partial hypotheses are excluded from keyword matching.
- Bound audio and event queues. If inference falls behind, report lag and apply backpressure; do not consume unlimited memory.
- Do not write audio chunks, transcripts, or alerts to disk.

`base` is the product default. `tiny` and `small` remain allowlisted alternatives in settings. Model files are downloaded once into the normal local model cache and reused. Model download is cancellable, reports progress when the backend exposes it, and failures are retryable.

## Keyword alerts

Keyword evaluation is deterministic and local to the page; it does not require another language model.

- Normalize Unicode, whitespace, and English letter case before matching.
- Match configured phrases against finalized transcript segments.
- Record the matched keyword, transcript text, course-relative time, and local wall-clock time.
- Apply a per-keyword 60-second cooldown.
- Highlight the transcript row and show an in-page alert.
- Play a short local notification sound when enabled.
- Use the browser Notifications API when enabled and permission is granted.
- If notification permission is denied, continue with page and sound alerts and show a non-blocking explanation.

Keyword settings and alert toggles may persist in browser local storage because they contain no credentials. Transcript text and alert records must not be written to local storage.

## Port and settings behavior

This local-model design has no AI API URL or API-key setting. The local helper binds an automatically selected loopback port and passes that address to the page through the existing fragment-only pairing URL. Normal users do not type a port. Add an advanced `--port` launcher option for users who need a fixed loopback port; it must still bind only to `127.0.0.1`.

## Markdown export

Export is generated in the browser from the current in-memory session. The file contains:

- Course title and live-session title.
- Export time.
- Model and language settings.
- A warning/alert summary table.
- Timestamped transcript lines, with matched keywords visibly marked.

The export contains no audio, signed media URLs, authentication tokens, or Fudan credentials.

## Failure handling

- **Model unavailable/download failure:** keep the session stopped, show a retry action, and leave playback untouched.
- **No teacher audio:** fall back to teacher video audio; if neither has audio, return a specific unsupported-audio error.
- **Login expired/source rejected:** stop transcription and surface the existing login-required state without exposing upstream details.
- **Live session ended:** finalize the last complete segment, emit `ended`, and keep the transcript available for export until the page closes or the user clears it.
- **Inference behind real time:** show lag; keep queues bounded and favor an explicit degraded state over hidden memory growth.
- **Page disconnect:** cancel after a short grace period so a refresh can reconnect without leaving a permanent background transcription.
- **Helper shutdown:** terminate `ffmpeg` and inference workers cleanly.
- **Browser notifications denied:** fall back to in-page and sound alerts.

## Packaging and dependencies

- Add `faster-whisper` and the chosen VAD dependency to the local runtime requirements.
- Keep the Whisper model out of Git and out of release ZIPs; download it on first use.
- Update PyInstaller collection rules for native libraries required by `faster-whisper`/CTranslate2.
- Keep the existing extension package lean; it does not bundle Whisper or model data.
- Update the Windows and macOS release workflows and checksums after tests pass.

## Security and privacy

- Reuse the existing short-lived bootstrap and session bearer model.
- Keep the server on `127.0.0.1`; do not expose a LAN listener.
- Preserve strict Host and Origin validation.
- Validate all course IDs, sub IDs, model names, languages, session IDs, and request sizes.
- Never accept an arbitrary media URL from the page. The helper resolves the source from authorized course identifiers.
- Never expose raw audio or upstream media URLs to GitHub Pages.
- Never persist audio or transcript contents automatically.
- Never log credentials, bearer tokens, source URLs, raw transcript contents, or alert text in server logs.

## Testing strategy

### Python unit tests

- Request validation and route authorization.
- Single-active-session enforcement and idempotent stop.
- Audio-source preference and fallback.
- `ffmpeg` argument construction, pipe-only behavior, cleanup, and cancellation.
- Segment timing, VAD boundaries, overlap, and queue limits.
- Engine lazy loading and injected fake-engine output.
- Event sanitization and lifecycle ordering.
- Login expiry, stream end, page disconnect, and helper shutdown.

Tests must use fixtures and fakes; they must not contact Fudan or download a Whisper model.

### JavaScript unit tests

- Start/stop state machine and authenticated event streaming.
- Transcript rendering and session-only retention.
- Unicode/case normalization and keyword matching.
- Per-keyword cooldown.
- Alert-channel toggles and denied notification permission.
- Markdown escaping and export content.
- Responsive panel state and playback independence.

### Integration and packaging checks

- Existing live playback and extension tests remain green.
- Local server integration test streams fake transcript events to the frontend transport.
- Build audit proves that no model, audio, transcript, credentials, or cache directory enters release artifacts.
- PyInstaller smoke tests confirm that the helper starts and reports transcription capabilities without downloading a model during the build.

### Manual acceptance

With an authorized current-live course:

1. Start the local helper and paired player.
2. Play the course, click Start transcription, and complete first-use model download.
3. Confirm Chinese subtitles appear with acceptable delay and playback remains uninterrupted.
4. Speak or play test phrases containing each default keyword and verify highlight, page alert, sound, system notification, and cooldown.
5. Stop transcription and confirm CPU use returns to idle and no `ffmpeg` process remains.
6. Export Markdown and verify timestamps and alert records.
7. Confirm closing the page without export leaves no transcript or audio file on disk.

## Delivery scope

The implementation will include local transcription modules, loopback API routes, both local and Pages UI support, settings and Markdown export, dependency and packaging updates, automated tests, documentation, and a release artifact update. The Edge extension remains compatible and unchanged except for any protocol capability declaration strictly required to steer users toward the local helper.
