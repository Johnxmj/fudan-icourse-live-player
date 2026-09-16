# Local Whisper Live Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add manually started, local `faster-whisper` live transcription, deterministic keyword alerts, and session-only Markdown export to the current-live player.

**Architecture:** The loopback helper resolves an authorized teacher audio source, exposes it through the existing short-lived local media proxy, and feeds that URL to an `ffmpeg` pipe. A single transcription manager segments PCM and lazily runs `faster-whisper`; authenticated server-sent events deliver sanitized final segments to either local UI or the GitHub Pages UI paired to the helper. The page performs keyword matching and notifications without retaining transcript text after the page session.

**Tech Stack:** Python 3.10+, `faster-whisper`, bundled/system `ffmpeg`, `ThreadingHTTPServer`, browser Fetch streaming, vanilla ES modules, Node test runner, Python `unittest`, PyInstaller.

## Global Constraints

- Implement against `origin/main` after PR #13; do not merge or modify the replay-design branch.
- Transcription starts only after an explicit user click.
- Default model is `base`; allow only `tiny`, `base`, and `small`.
- Default language is `zh`; allow explicit automatic detection.
- Prefer teacher audio and fall back to the teacher video audio track.
- Raw audio moves through memory pipes and is never written to disk.
- Transcript and alert history stay in page memory; settings alone may use local storage.
- Default keywords are exactly `点名`, `签到`, `小测`, `测验`, `期中`, `期末`, and `quiz`.
- Do not include `作业`, `截止`, or `提交` in defaults.
- Apply a 60-second cooldown independently to each matched keyword.
- Allow only one active transcription per helper process.
- Keep all helper endpoints on `127.0.0.1` behind the existing bearer, Host, and Origin checks.
- Never accept a media URL from the page or expose an upstream media URL to the page.
- Do not add replay, recording, cloud AI, API-key, summarization, translation, or diarization features.
- Keep model files and caches out of Git and release archives.

---

## File map

New Python package:

- `live_player/transcription/models.py` — allowlisted options and sanitized event types.
- `live_player/transcription/engine.py` — lazy `faster-whisper` model selection and inference adapter.
- `live_player/transcription/audio.py` — `ffmpeg` PCM pipe and process cleanup.
- `live_player/transcription/segmenter.py` — bounded overlapping windows and timing.
- `live_player/transcription/session.py` — one-session state machine, event stream, cancellation, and grace cleanup.

Server integration:

- `live_player/server/app.py` — capabilities/start/events/stop routes and local media URL issuance.
- `live_player/server/handler.py` — configure the application with the bound authority and safely stream event bodies.
- `live_player/cli.py` — construct and shut down the transcription manager.

Frontend:

- `live_player/web/transcription.js` — shared settings, keyword, event-stream, notification, and Markdown controller.
- `frontend/live/transcription.js` — generated/synchronized copy of the shared controller.
- `live_player/web/transport-local.js` — authenticated transcription methods for the local page.
- `frontend/live/transports/local.js` — authenticated transcription methods for Pages pairing.
- `live_player/web/index.html`, `frontend/live/index.html` — transcription-panel markup.
- `live_player/web/app.css`, `frontend/live/app.css` — responsive panel and alert styles.
- `live_player/web/app.js`, `frontend/live/app.js` — mount controller and pass active-course changes.
- `scripts/sync_live_web.mjs` — keep the shared transcription module identical in both frontends.

Tests and delivery:

- `tests/live_transcription/` — model, audio, segmenter, and session unit tests.
- `tests/live_server/test_transcription_api.py` — route and authorization tests.
- `tests/live_server/test_handler.py` — streaming cleanup and local authority tests.
- `tests/live_web/transcription.test.mjs` — pure UI/controller behavior.
- `tests/live_web/transport-local.test.mjs`, `tests/pages_live/local.test.mjs` — transport contracts.
- `tests/live_web/app.test.mjs`, `tests/pages_live/app.test.mjs` — integration with course selection/playback.
- `requirements.txt`, `requirements-live-build.txt`, `scripts/build_windows.py` — runtime and packaging.
- `README.md`, `docs/live-player.md` — installation, first download, operation, privacy, and troubleshooting.

---

### Task 1: Validated options and lazy Whisper engine

**Files:**
- Create: `live_player/transcription/__init__.py`
- Create: `live_player/transcription/models.py`
- Create: `live_player/transcription/engine.py`
- Create: `tests/live_transcription/__init__.py`
- Create: `tests/live_transcription/test_models.py`
- Create: `tests/live_transcription/test_engine.py`
- Modify: `requirements.txt`

**Interfaces:**
- Produces: `TranscriptionOptions.from_payload(payload) -> TranscriptionOptions`
- Produces: `TranscriptEvent.as_public_dict() -> dict`
- Produces: `WhisperEngine.capabilities() -> dict`
- Produces: `WhisperEngine.prepare(options, on_state) -> None`
- Produces: `WhisperEngine.transcribe(samples, sample_rate, options, initial_prompt="") -> list[TranscriptSlice]`
- Consumes later: `SessionManager` calls the engine only through these methods.

- [ ] **Step 1: Write validation tests**

```python
def test_options_apply_product_defaults():
    options = TranscriptionOptions.from_payload({"course_id": "37142", "sub_id": "659200"})
    assert options.model == "base"
    assert options.language == "zh"

def test_options_reject_unknown_model_and_identifiers():
    with self.assertRaises(ValueError):
        TranscriptionOptions.from_payload({"course_id": "../x", "sub_id": "1", "model": "large-v3"})

def test_public_event_drops_private_fields():
    event = TranscriptEvent.segment(1.0, 4.2, "请大家签到", private_debug="secret")
    assert event.as_public_dict() == {"type": "segment", "start": 1.0, "end": 4.2, "text": "请大家签到"}
```

- [ ] **Step 2: Run the model tests and verify they fail**

Run: `python -m unittest tests.live_transcription.test_models -v`

Expected: import failure because `live_player.transcription.models` does not exist.

- [ ] **Step 3: Implement allowlisted immutable models**

Implement frozen dataclasses with these exact constraints:

```python
SAFE_ID = re.compile(r"^[A-Za-z0-9]{1,64}$")
ALLOWED_MODELS = ("tiny", "base", "small")
ALLOWED_LANGUAGES = ("zh", "auto")

@dataclass(frozen=True)
class TranscriptionOptions:
    course_id: str
    sub_id: str
    model: str = "base"
    language: str = "zh"

    @classmethod
    def from_payload(cls, payload):
        if not isinstance(payload, dict) or set(payload) - {"course_id", "sub_id", "model", "language"}:
            raise ValueError("invalid transcription options")
        course_id, sub_id = payload.get("course_id"), payload.get("sub_id")
        model, language = payload.get("model", "base"), payload.get("language", "zh")
        if not all(isinstance(value, str) and SAFE_ID.fullmatch(value) for value in (course_id, sub_id)):
            raise ValueError("invalid transcription identifiers")
        if model not in ALLOWED_MODELS or language not in ALLOWED_LANGUAGES:
            raise ValueError("unsupported transcription options")
        return cls(course_id, sub_id, model, language)

@dataclass(frozen=True)
class TranscriptSlice:
    start: float
    end: float
    text: str

@dataclass(frozen=True)
class TranscriptEvent:
    type: str
    public: dict

    def as_public_dict(self):
        return {"type": self.type, **self.public}
```

Reject booleans, lists, unknown keys, empty IDs, unsupported model names, and unsupported language values. Limit transcript event text to 8,000 Unicode characters and reject non-finite or negative timestamps.

- [ ] **Step 4: Write failing engine tests with an injected model factory**

```python
def test_engine_loads_base_once_and_uses_cpu_int8_fallback():
    factory = FakeWhisperFactory(cuda_fails=True)
    engine = WhisperEngine(model_factory=factory, model_resolver=FakeModelResolver(cached=True))
    engine.prepare(defaults(), lambda state: None)
    first = engine.transcribe(np.zeros(16000, dtype=np.float32), 16000, defaults())
    second = engine.transcribe(np.zeros(16000, dtype=np.float32), 16000, defaults())
    assert factory.calls == [("base", "cuda", "float16"), ("base", "cpu", "int8")]
    assert first == second == [TranscriptSlice(0.0, 1.0, "测试")]

def test_engine_passes_vad_and_language_options():
    engine.transcribe(samples, 16000, replace(defaults(), language="auto"), initial_prompt="上一句")
    assert fake_model.kwargs == {"language": None, "vad_filter": True, "initial_prompt": "上一句", "condition_on_previous_text": False}
```

- [ ] **Step 5: Run engine tests and verify they fail**

Run: `python -m unittest tests.live_transcription.test_engine -v`

Expected: import or missing-class failure for `WhisperEngine`.

- [ ] **Step 6: Implement the lazy engine**

Import `faster_whisper.WhisperModel` only inside the default factory so importing the app does not download or load a model. `prepare()` first asks an injectable resolver for `Systran/faster-whisper-{model}` with `local_files_only=True`; on cache miss it emits `downloading-model`, resolves with `local_files_only=False`, then emits `loading-model` before constructing the model from the resolved directory. Cache one model instance keyed by selected model. Try `device="cuda", compute_type="float16"` first only when CTranslate2 reports at least one CUDA device; if model construction fails, retry `device="cpu", compute_type="int8"`. Convert Whisper segments into `TranscriptSlice` values, trim blank text, and expose only:

```python
{
    "available": True,
    "models": ["tiny", "base", "small"],
    "default_model": "base",
    "default_language": "zh",
    "loaded_model": self.loaded_model,
    "device": self.device,
}
```

Use `vad_filter=True`, `condition_on_previous_text=False`, and a bounded 500-character initial prompt.

- [ ] **Step 7: Add the runtime dependency and run tests**

Add `faster-whisper>=1.1,<2` and `numpy>=1.23,<3` to `requirements.txt` without pinning transitive native wheels.

Run: `python -m unittest tests.live_transcription.test_models tests.live_transcription.test_engine -v`

Expected: all tests pass without downloading a model because tests inject the factory.

- [ ] **Step 8: Commit**

```bash
git add live_player/transcription requirements.txt tests/live_transcription
git commit -m "feat: add local Whisper engine"
```

---

### Task 2: Pipe-only audio reader and bounded segmenter

**Files:**
- Create: `live_player/transcription/audio.py`
- Create: `live_player/transcription/segmenter.py`
- Create: `tests/live_transcription/test_audio.py`
- Create: `tests/live_transcription/test_segmenter.py`

**Interfaces:**
- Produces: `FfmpegPcmReader(command_factory=None).frames(manifest_url, stop_event) -> Iterator[bytes]`
- Produces: `PcmSegmenter(sample_rate=16000, window_seconds=12.0, overlap_seconds=1.5, max_buffer_seconds=30.0).push(data) -> list[PcmWindow]`
- Produces: `PcmSegmenter.flush() -> list[PcmWindow]`
- Consumes: local loopback manifest URLs only.

- [ ] **Step 1: Write failing audio tests**

```python
def test_ffmpeg_command_is_pcm_pipe_only():
    command = build_ffmpeg_command("http://127.0.0.1:4310/media/x.m3u8?media_token=opaque")
    assert command[-8:] == ["-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"]
    assert "-y" not in command
    assert not any(value.endswith((".wav", ".mp3", ".pcm")) for value in command)

def test_reader_terminates_child_when_cancelled():
    process = FakeProcess(stdout_chunks=[b"a" * 3200])
    stop = threading.Event()
    reader = FfmpegPcmReader(process_factory=lambda *_: process)
    iterator = reader.frames(loopback_url(), stop)
    next(iterator)
    stop.set()
    iterator.close()
    assert process.terminate_calls == 1
```

- [ ] **Step 2: Run audio tests and verify they fail**

Run: `python -m unittest tests.live_transcription.test_audio -v`

Expected: missing `audio` module.

- [ ] **Step 3: Implement `FfmpegPcmReader`**

Allow only `http://127.0.0.1:<1-65535>/media/{course_id}/{sub_id}/{view}/manifest.m3u8` URLs; reject credentials, fragments, non-loopback hosts, and HTTPS/public URLs. Start:

```python
[
    ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error",
    "-i", manifest_url,
    "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1",
]
```

Use `stdin=DEVNULL`, `stdout=PIPE`, `stderr=PIPE`, and Windows no-window flags. Yield fixed-size PCM blocks, keep stderr bounded to 32 KiB, and on cancellation or generator close terminate, wait five seconds, then kill if necessary. A nonzero exit before cancellation raises `AudioStreamError` with a sanitized code and without the URL.

- [ ] **Step 4: Write failing segmenter tests**

```python
def test_segmenter_emits_twelve_second_windows_with_overlap():
    segmenter = PcmSegmenter(sample_rate=10, window_seconds=12, overlap_seconds=2, max_buffer_seconds=30)
    windows = segmenter.push(pcm_samples(22 * 10))
    assert [(item.start, item.end, len(item.samples)) for item in windows] == [(0.0, 12.0, 120), (10.0, 22.0, 120)]

def test_segmenter_never_buffers_more_than_limit():
    segmenter.push(pcm_samples(100 * 10))
    assert segmenter.buffered_seconds <= 30
    assert segmenter.dropped_seconds > 0
```

- [ ] **Step 5: Run segmenter tests and verify they fail**

Run: `python -m unittest tests.live_transcription.test_segmenter -v`

Expected: missing `segmenter` module.

- [ ] **Step 6: Implement bounded PCM windows**

Convert little-endian signed 16-bit PCM to NumPy `float32` in `[-1, 1]`. Emit 12-second windows every 10.5 seconds, preserve monotonic source offsets, and flush a final window only when it contains at least 0.5 seconds. Cap unprocessed data at 30 seconds, drop the oldest excess on overload, and expose `dropped_seconds` so the session can emit a lag/degraded event. Do not perform filesystem I/O.

- [ ] **Step 7: Run both suites and commit**

Run: `python -m unittest tests.live_transcription.test_audio tests.live_transcription.test_segmenter -v`

Expected: all tests pass.

```bash
git add live_player/transcription/audio.py live_player/transcription/segmenter.py tests/live_transcription/test_audio.py tests/live_transcription/test_segmenter.py
git commit -m "feat: stream live audio into bounded PCM windows"
```

---

### Task 3: Single-session transcription lifecycle

**Files:**
- Create: `live_player/transcription/session.py`
- Create: `tests/live_transcription/test_session.py`
- Modify: `live_player/transcription/__init__.py`

**Interfaces:**
- Produces: `TranscriptionManager.start(options, manifest_url_factory) -> str`
- Produces: `TranscriptionManager.events(session_id) -> Iterator[bytes]`
- Produces: `TranscriptionManager.stop(session_id) -> bool`
- Produces: `TranscriptionManager.capabilities() -> dict`
- Produces: `TranscriptionManager.shutdown() -> None`
- Consumes: `WhisperEngine`, `FfmpegPcmReader`, and `PcmSegmenter` from Tasks 1–2.

- [ ] **Step 1: Write failing lifecycle tests**

```python
def test_manager_rejects_second_active_session():
    first = manager.start(defaults(), manifest_factory)
    with self.assertRaises(TranscriptionBusyError):
        manager.start(replace(defaults(), sub_id="other"), manifest_factory)
    assert manager.stop(first) is True
    assert manager.stop(first) is False

def test_event_order_is_state_segments_ended():
    session_id = manager.start(defaults(), manifest_factory)
    events = decode_sse(manager.events(session_id))
    assert [event["type"] for event in events] == ["state", "state", "segment", "ended"]

def test_shutdown_stops_audio_and_worker():
    session_id = manager.start(defaults(), manifest_factory)
    manager.shutdown()
    assert reader.cancelled(session_id)
    assert manager.capabilities()["active"] is False
```

- [ ] **Step 2: Run lifecycle tests and verify they fail**

Run: `python -m unittest tests.live_transcription.test_session -v`

Expected: missing `TranscriptionManager`.

- [ ] **Step 3: Implement a bounded session state machine**

Use one worker thread per active session and these public states:

```python
SESSION_STATES = {
    "downloading-model", "loading-model", "connecting-audio", "listening",
    "delayed", "stopped", "live-ended", "error",
}
```

Issue a `secrets.token_urlsafe(24)` session ID. Queue at most 256 public events; coalesce repeated state/heartbeat events and never discard `segment`, `ended`, or `error`. Before each inference call, emit lag when buffered audio exceeds 15 seconds. Offset model-relative slices by the PCM window start and deduplicate overlap text by timestamp plus normalized prefix/suffix comparison. Carry at most the final 500 transcript characters as `initial_prompt`.

The worker calls `engine.prepare(options, on_state)` before opening audio, so first-use download and model loading have distinct state events. The manifest factory is called after the model is ready. Exceptions map to stable codes `MODEL_UNAVAILABLE`, `AUDIO_UNAVAILABLE`, `LOGIN_REQUIRED`, `LIVE_ENDED`, and `TRANSCRIPTION_FAILED`. Never place raw exception text in a public event.

Format the iterator as UTF-8 SSE frames:

```text
event: transcript
data: {"type":"segment","start":12.0,"end":18.4,"text":"现在开始签到"}

```

Yield a comment heartbeat every five seconds. `events()` allows one current consumer; when it disconnects, start a 15-second grace timer. A new `events()` attachment for the same session during that grace period replaces the closed consumer and cancels the timer. Stop the session when grace expires.

- [ ] **Step 4: Add retry, cancellation, and redaction tests**

Cover model failure before audio start, ffmpeg nonzero exit, live end, event consumer close/reconnect, event queue bounds, overlap deduplication, and confirmation that manifest URLs and fake exception secrets never appear in serialized SSE bytes.

- [ ] **Step 5: Run the lifecycle suite and commit**

Run: `python -m unittest tests.live_transcription.test_session -v`

Expected: all tests pass and no test starts `ffmpeg` or loads Whisper.

```bash
git add live_player/transcription/session.py live_player/transcription/__init__.py tests/live_transcription/test_session.py
git commit -m "feat: manage one local transcription session"
```

---

### Task 4: Authenticated loopback transcription API

**Files:**
- Modify: `live_player/server/app.py`
- Modify: `live_player/server/handler.py`
- Modify: `live_player/cli.py`
- Create: `tests/live_server/test_transcription_api.py`
- Modify: `tests/live_server/test_handler.py`
- Modify: `tests/live_server/test_api.py`

**Interfaces:**
- Produces routes: `GET /api/transcription/capabilities`
- Produces routes: `POST /api/transcription/start`
- Produces routes: `GET /api/transcription/events/<session_id>`
- Produces routes: `POST /api/transcription/stop`
- Consumes: existing session bearer and media-token proxy plus `TranscriptionManager`.

- [ ] **Step 1: Write failing route tests**

```python
def test_start_requires_bearer_and_builds_internal_media_url():
    denied = app.handle("POST", "/api/transcription/start", {}, body(defaults()))
    assert denied.status == 401
    allowed = app.handle("POST", "/api/transcription/start", auth(), body(defaults()))
    assert allowed.status == 201
    assert manager.started.options.model == "base"
    assert manager.started.manifest_url.startswith("http://127.0.0.1:4310/media/")
    assert "media_token=" in manager.started.manifest_url

def test_events_are_streamed_and_not_buffered():
    response = app.handle("GET", f"/api/transcription/events/{session_id}", auth(), b"")
    assert response.status == 200
    assert response.headers["Content-Type"] == "text/event-stream; charset=utf-8"
    assert response.body == b""
    assert response.body_iter is not None
```

- [ ] **Step 2: Run route tests and verify they fail**

Run: `python -m unittest tests.live_server.test_transcription_api -v`

Expected: 404 responses for the new routes.

- [ ] **Step 3: Configure the bound loopback authority**

Add `LiveApplication.set_loopback_authority(authority: str)` that accepts only `127.0.0.1:<port>` with port 1–65535 and may be called exactly once with the same value. In `serve()`, create the server, read `server.server_address`, call this method, then return the server. Do not derive a media URL from an untrusted request body.

- [ ] **Step 4: Implement routes and source preference**

Extend `LiveApplication.__init__` with an injectable `transcription_manager`. Route handling must occur only after the same bearer comparison used by `/api/live-courses`.

For start:

1. Parse at most the handler's existing 8 KiB JSON body.
2. Validate with `TranscriptionOptions.from_payload`.
3. Use the authorized client to attempt `LiveSourceResolver.resolve(course_id, sub_id, "teacher_audio")`.
4. On unavailable teacher audio, validate `"teacher"` instead.
5. Issue a course/sub-scoped media token and build the local `/media/.../manifest.m3u8` URL from the configured authority.
6. Pass a closure returning that local URL into the manager.
7. Return `201 {"session_id": "tx_opaque_value"}` where the value is the manager-issued opaque ID.

Map busy to 409 `TRANSCRIPTION_BUSY`, invalid input to 400 `INVALID_TRANSCRIPTION_REQUEST`, expired login to 401 `LOGIN_REQUIRED`, and unavailable audio to 422 `AUDIO_UNAVAILABLE`.

For events, return `Response(200, {"Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no"}, body_iter=manager.events(session_id))`. For stop, accept only `{"session_id":"tx_opaque_value"}` and return 200 even when already stopped.

- [ ] **Step 5: Make streaming cleanup explicit in the handler**

Keep `Connection: close`, omit `Content-Length` for streamed responses, flush after every body chunk, and ensure `body_iter.close()` runs after a client disconnect. Catch `BrokenPipeError`, `ConnectionResetError`, and `TimeoutError` only around streaming writes; do not turn a mid-stream disconnect into a JSON response.

- [ ] **Step 6: Wire lifecycle into CLI shutdown**

Create the default `TranscriptionManager` in `build_application`, inject it into `LiveApplication`, and make `LiveApplication.shutdown()` stop transcription before clearing media/session stores. Preserve existing injected-application tests by keeping constructor defaults lazy and side-effect-free. Add `--port` to the CLI with default `0`; validate `0 <= port <= 65535`, pass it into `build_application(..., port=port)`, and keep `host="127.0.0.1"` fixed.

- [ ] **Step 7: Run server regressions and commit**

Run: `python -m unittest tests.live_server.test_transcription_api tests.live_server.test_handler tests.live_server.test_api tests.test_live_launcher -v`

Expected: all tests pass with fake managers and no live network calls.

```bash
git add live_player/server/app.py live_player/server/handler.py live_player/cli.py tests/live_server/test_transcription_api.py tests/live_server/test_handler.py tests/live_server/test_api.py tests/test_live_launcher.py
git commit -m "feat: expose authenticated local transcription API"
```

---

### Task 5: Local transport and shared transcript logic

**Files:**
- Create: `live_player/web/transcription.js`
- Create: `frontend/live/transcription.js`
- Modify: `scripts/sync_live_web.mjs`
- Modify: `live_player/web/transport-local.js`
- Modify: `frontend/live/transports/local.js`
- Create: `tests/live_web/transcription.test.mjs`
- Modify: `tests/live_web/transport-local.test.mjs`
- Modify: `tests/pages_live/local.test.mjs`
- Modify: `tests/pages_live/sync.test.mjs`

**Interfaces:**
- Produces transport methods: `transcriptionCapabilities()`, `startTranscription(options)`, `streamTranscription(sessionId, {signal, onEvent})`, `stopTranscription(sessionId)`.
- Produces UI helpers: `normalizeKeywords`, `matchKeywords`, `createAlertCooldown`, `parseSseStream`, `buildTranscriptMarkdown`, `createTranscriptionController`.

- [ ] **Step 1: Write failing transport tests**

```javascript
test("local transport authenticates start, stream, and stop", async () => {
  const transport = createLocalTransport("http://127.0.0.1:4310", "session-token", { fetchImpl });
  await transport.startTranscription({ course_id: "37142", sub_id: "659200", model: "base", language: "zh" });
  await transport.stopTranscription("tx-1");
  assert.equal(calls[0].headers.Authorization, "Bearer session-token");
  assert.equal(calls[0].url, "http://127.0.0.1:4310/api/transcription/start");
  assert.deepEqual(JSON.parse(calls[1].body), { session_id: "tx-1" });
});
```

- [ ] **Step 2: Run transport tests and verify they fail**

Run: `node --test tests/live_web/transport-local.test.mjs tests/pages_live/local.test.mjs`

Expected: missing transcription methods.

- [ ] **Step 3: Implement matching transport contracts**

Use POST JSON for start/stop, GET JSON for capabilities, and authenticated `fetch` for the event stream. `streamTranscription` passes `response.body` to `parseSseStream`, supports `AbortSignal`, and throws errors with stable `status` and `code` fields using each transport's existing error parser.

- [ ] **Step 4: Write failing pure-logic tests**

```javascript
test("default keywords exclude homework words", () => {
  assert.deepEqual(DEFAULT_KEYWORDS, ["点名", "签到", "小测", "测验", "期中", "期末", "quiz"]);
});

test("matching normalizes Unicode and English case", () => {
  assert.deepEqual(matchKeywords("现在有 QUIZ，也请 签 到", ["quiz", "签到"]), ["quiz", "签到"]);
});

test("cooldown is per keyword for sixty seconds", () => {
  const allow = createAlertCooldown({ now: fakeClock });
  assert.equal(allow("签到"), true);
  assert.equal(allow("签到"), false);
  assert.equal(allow("quiz"), true);
  fakeClock.advance(60000);
  assert.equal(allow("签到"), true);
});

test("markdown contains alerts and timestamps but no connection data", () => {
  const markdown = buildTranscriptMarkdown(sessionFixture());
  assert.match(markdown, /## 告警记录/);
  assert.match(markdown, /\[00:01:02\]/);
  assert.doesNotMatch(markdown, /media_token|bootstrap|127\.0\.0\.1/);
});
```

- [ ] **Step 5: Run pure-logic tests and verify they fail**

Run: `node --test tests/live_web/transcription.test.mjs`

Expected: missing shared module.

- [ ] **Step 6: Implement the shared controller module**

Store only this settings object under `live-player.transcription-settings.v1`:

```javascript
{
  model: "base",
  language: "zh",
  keywords: ["点名", "签到", "小测", "测验", "期中", "期末", "quiz"],
  pageAlert: true,
  soundAlert: true,
  systemAlert: true,
}
```

Normalize text with Unicode NFKC, collapse whitespace for general display, and remove whitespace only for Chinese keyword comparison so `签 到` matches `签到`. Case-fold English with `toLocaleLowerCase("en-US")`. Deduplicate keywords after normalization and cap the list at 100 items of 1–40 characters.

Parse SSE incrementally across arbitrary chunk boundaries with `TextDecoder`. Accept only known event types and safe scalar fields. Keep transcript and alerts in closure-owned arrays only; expose immutable snapshots for rendering/export.

Generate Markdown with escaped pipes in tables, course/session headings, export time, model/language, an alert table, and timestamped transcript lines. Create downloads with a Blob URL and revoke it immediately after the click.

Add `live_player/web/transcription.js -> frontend/live/transcription.js` to `scripts/sync_live_web.mjs`, generate the Pages copy with `node scripts/sync_live_web.mjs --write`, and make the sync test assert equality.

- [ ] **Step 7: Run frontend logic/transport tests and commit**

Run: `node --test tests/live_web/transcription.test.mjs tests/live_web/transport-local.test.mjs tests/pages_live/local.test.mjs tests/pages_live/sync.test.mjs`

Expected: all tests pass.

```bash
git add live_player/web/transcription.js frontend/live/transcription.js live_player/web/transport-local.js frontend/live/transports/local.js scripts/sync_live_web.mjs tests/live_web/transcription.test.mjs tests/live_web/transport-local.test.mjs tests/pages_live/local.test.mjs tests/pages_live/sync.test.mjs
git commit -m "feat: add local transcription browser transport"
```

---

### Task 6: Responsive transcription UI and alert channels

**Files:**
- Modify: `live_player/web/index.html`
- Modify: `live_player/web/app.css`
- Modify: `live_player/web/app.js`
- Modify: `frontend/live/index.html`
- Modify: `frontend/live/app.css`
- Modify: `frontend/live/app.js`
- Modify: `tests/live_web/app.test.mjs`
- Modify: `tests/pages_live/app.test.mjs`
- Modify: `tests/live_web/transcription.test.mjs`

**Interfaces:**
- Consumes: local transport transcription methods and `createTranscriptionController` from Task 5.
- Produces: identical `data-transcription-*` panel contract in local and Pages UIs.

- [ ] **Step 1: Add failing DOM integration tests**

```javascript
test("transcription starts only after the explicit button click", async () => {
  const app = await mountWithLocalTransport();
  await app.selectCourse("37142", "659200");
  assert.equal(transport.startCalls.length, 0);
  elements.transcriptionStart.click();
  await until(() => transport.startCalls.length === 1);
  assert.deepEqual(transport.startCalls[0], { course_id: "37142", sub_id: "659200", model: "base", language: "zh" });
});

test("extension-only mode explains that the local helper is required", async () => {
  await bootWithExtensionTransport();
  assert.equal(elements.transcriptionStart.disabled, true);
  assert.match(elements.transcriptionStatus.textContent, /本地助手/);
});
```

- [ ] **Step 2: Run app tests and verify they fail**

Run: `node --test tests/live_web/app.test.mjs tests/pages_live/app.test.mjs`

Expected: missing transcription DOM/controller behavior.

- [ ] **Step 3: Add the panel markup and responsive layout**

Use the same data attributes in both documents:

```html
<aside class="transcription-panel" data-transcription-panel aria-label="实时转录">
  <header><h2>实时转录</h2><span data-transcription-state>未开始</span></header>
  <div class="transcription-actions">
    <button type="button" data-transcription-start>开始转录</button>
    <button type="button" data-transcription-stop disabled>停止</button>
    <button type="button" data-transcription-export disabled>导出 Markdown</button>
    <button type="button" data-transcription-clear disabled>清空</button>
  </div>
  <p data-transcription-status aria-live="polite"></p>
  <div data-transcription-alert role="status" aria-live="assertive" hidden></div>
  <ol data-transcription-lines aria-label="实时字幕"></ol>
  <details data-transcription-settings><summary>转录与提醒设置</summary><!-- allowlisted controls --></details>
</aside>
```

On wide screens, use a two-column player/transcript surface with a bounded transcript scroller. Below 900 px, stack the panel under the player. Preserve video aspect ratio, keyboard focus visibility, and `prefers-reduced-motion`. Alert state must not rely on color alone; include the matched keyword text and an icon/text label.

- [ ] **Step 4: Wire manual lifecycle without disrupting playback**

Mount the controller only after a local transport is selected and pass a function returning the active course. Never call start from course selection or playback events. On course change while transcription is active, stop the old session, keep its transcript visible/exportable, and require Clear before starting a different course so unsaved text is not silently lost.

Disable Start when no course is active, the local helper lacks transcription capability, another session is active, or old-course transcript awaits clear. Stop is idempotent. `pagehide` aborts the event fetch and calls `fetch(stopUrl, {method: "POST", headers, body, keepalive: true})`; if keepalive fetch throws synchronously, rely on the server's 15-second disconnected-consumer cleanup.

- [ ] **Step 5: Implement the three alert channels**

- Highlight the transcript row and render a dismissible in-page banner containing the matched keyword and timestamp.
- Use a short synthesized Web Audio beep; do not add an audio asset.
- Request Notification permission only from the Start button gesture and only when system notifications are enabled. Create `new Notification("课堂提醒：签到", {body: transcriptText, tag: "fudan-live-签到"})` after permission is granted.
- If permission is denied or unsupported, keep page/sound channels active and show a non-blocking status.
- Use the shared per-keyword cooldown before invoking any channel.

- [ ] **Step 6: Add event, notification, storage, and course-change tests**

Test final segments, keyword highlights, 60-second suppression, independent toggles, denied permission, settings persistence, absence of transcript keys in storage, old-course protection, stream abort, explicit stop, export enabling, and Markdown download URL revocation.

- [ ] **Step 7: Run UI regressions and commit**

Run: `node --test tests/live_web/*.test.mjs tests/pages_live/*.test.mjs`

Expected: all local and Pages tests pass; existing live playback behavior remains unchanged.

```bash
git add live_player/web frontend/live tests/live_web tests/pages_live
git commit -m "feat: add live transcript and keyword alert panel"
```

---

### Task 7: Native packaging, release workflow, and documentation

**Files:**
- Modify: `requirements.txt`
- Modify: `requirements-live-build.txt`
- Modify: `live_player/transcription/audio.py`
- Modify: `scripts/build_windows.py`
- Modify: `.github/workflows/release.yml`
- Modify: `tests/test_live_build.py`
- Modify: `tests/test_live_release.py`
- Modify: `tests/test_live_docs.py`
- Modify: `README.md`
- Modify: `docs/live-player.md`

**Interfaces:**
- Consumes: all runtime modules and UI from Tasks 1–6.
- Produces: native ZIPs that contain runtime libraries but no Whisper model/cache/audio/transcript data.

- [ ] **Step 1: Write failing packaging tests**

```python
def test_build_collects_whisper_runtime_without_model_cache():
    command = build_pyinstaller_command(output, work)
    assert command.count("--collect-all") >= 4
    assert "faster_whisper" in command
    assert "ctranslate2" in command
    assert "av" in command
    assert "imageio_ffmpeg" in command
    assert all("models--" not in value and ".cache" not in value for value in command)

def test_artifact_audit_rejects_transcript_and_model_cache_paths():
    assert not is_allowed_artifact_input(Path("transcripts/live.md"))
    assert not is_allowed_artifact_input(Path("models--Systran--faster-whisper-base/blob"))
```

- [ ] **Step 2: Run packaging tests and verify they fail**

Run: `python -m unittest tests.test_live_build tests.test_live_release -v`

Expected: missing collection flags and denied-path coverage.

- [ ] **Step 3: Update PyInstaller collection and artifact audit**

Refactor the command construction into a testable `build_pyinstaller_command(output, workpath, specpath)` function. Add `--collect-all faster_whisper`, `--collect-all ctranslate2`, `--collect-all av`, and `--collect-all imageio_ffmpeg`. Extend denied artifact parts with `transcript`, `transcripts`, `models--`, `huggingface`, and `whisper-cache`. Do not add model directories through `--add-data`.

Add `imageio-ffmpeg>=0.5,<1` to `requirements.txt`. Implement `resolve_ffmpeg_executable()` to use `imageio_ffmpeg.get_ffmpeg_exe()` first and fall back to `shutil.which("ffmpeg")`; if neither returns an existing executable, fail with the concrete Chinese message “未找到 ffmpeg，请安装后重新启动本地助手。” Add `--collect-all imageio_ffmpeg` to the PyInstaller command so native artifacts carry the wheel-provided executable. Do not download executables at runtime.

- [ ] **Step 4: Update release workflow assertions**

Retain Windows and macOS matrix builds. After each build, run the existing audit and add an archive listing check that fails on case-insensitive matches for `*.bin` model weights, `models--`, `transcript`, `audio`, `.env`, `cookie`, or credential filenames. Keep release creation restricted to `live-v*` tags.

- [ ] **Step 5: Write failing documentation tests**

Assert that README and the detailed guide mention `faster-whisper`, default `base`, manual Start transcription, first-use model download, no API key/cost, no audio persistence, exact default keywords, Markdown export, CPU/GPU behavior, and the local-helper requirement. Assert that the default-keyword line excludes `作业`, `截止`, and `提交`.

- [ ] **Step 6: Update user documentation**

Document:

1. Install/start the local helper.
2. Select and play a live course.
3. Click Start transcription.
4. Wait for first-use `base` model download/load.
5. Configure keywords and alert channels.
6. Export before closing the page.
7. Troubleshoot missing ffmpeg, model download, slow CPU, notification permission, expired Fudan login, and ended live streams.

State clearly that the model is local/open source, no AI API key is used, audio is not saved, transcripts disappear unless exported, and the extension-only playback path cannot run local transcription without the helper.

- [ ] **Step 7: Run delivery tests and commit**

Run:

```bash
python -m unittest tests.test_live_build tests.test_live_release tests.test_live_docs -v
python scripts/build_windows.py --audit-only
node scripts/sync_live_web.mjs --check
```

Expected: all tests and audits pass with no model download.

```bash
git add requirements.txt requirements-live-build.txt live_player/transcription/audio.py scripts/build_windows.py .github/workflows/release.yml tests/test_live_build.py tests/test_live_release.py tests/test_live_docs.py README.md docs/live-player.md
git commit -m "build: package and document local live transcription"
```

---

### Task 8: Full regression, smoke build, and review readiness

**Files:**
- Modify only files required to fix failures caused by Tasks 1–7.

**Interfaces:**
- Consumes: the complete feature.
- Produces: evidence that the branch is testable, package-safe, and ready for manual live acceptance.

- [ ] **Step 1: Run the complete Python suite**

Run: `python -m unittest discover -s tests -q`

Expected: zero failures and zero errors; tests do not contact Fudan or download Whisper.

- [ ] **Step 2: Run the complete JavaScript suite**

Run: `node --test tests/live_web/*.test.mjs tests/pages_live/*.test.mjs tests/extension/*.test.mjs`

Expected: zero failed tests.

- [ ] **Step 3: Run static and artifact checks**

Run:

```bash
python -m compileall -q live_player src
git diff --check origin/main...HEAD
node scripts/sync_live_web.mjs --check
python scripts/build_windows.py --audit-only
```

Expected: all commands exit 0.

- [ ] **Step 4: Build a local Windows smoke artifact**

Run: `python scripts/build_windows.py --output dist`

Expected: a Windows ZIP under `dist/`; archive listing includes Python/CTranslate2/AV runtime files and excludes model weights, caches, audio, transcripts, credentials, cookies, and `.env` files.

- [ ] **Step 5: Perform an offline UI smoke test with fakes**

Start the test fixture server, open the local page, feed state/segment/ended fixture events, and verify manual start, live transcript rendering, a `签到` alert, cooldown, stop, and Markdown export without a Fudan request or model load. Record the exact command and observed result in the PR description.

- [ ] **Step 6: Inspect branch scope**

Run:

```bash
git status --short
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git diff --name-only origin/main...HEAD
```

Expected: only transcription, local server, UI, tests, packaging, and documentation files appear; no replay implementation files or replay-plan edits appear.

- [ ] **Step 7: Request code review**

Review against `docs/superpowers/specs/2026-09-15-local-whisper-live-transcription-design.md`, focusing on authentication boundaries, media URL isolation, child-process cleanup, bounded queues, session-only transcript retention, exact default keywords, and playback regressions. Resolve every finding and rerun Steps 1–6 before claiming completion or creating a PR.
