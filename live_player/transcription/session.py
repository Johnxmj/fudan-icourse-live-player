"""One local transcription worker with a reconnectable, sanitized SSE stream."""

from collections import deque
import json
import secrets
import threading
import time
import unicodedata

from .audio import AudioStreamError, FfmpegPcmReader
from .engine import WhisperEngine
from .models import TranscriptEvent
from .segmenter import PcmSegmenter


SESSION_STATES = frozenset({
    "downloading-model", "loading-model", "connecting-audio", "listening",
    "delayed", "stopped", "live-ended", "error",
})
_JOIN_SECONDS = 5
_HEARTBEAT_SECONDS = 5
_GRACE_SECONDS = 15
_ERROR_MESSAGES = {
    "MODEL_UNAVAILABLE": "The local transcription model is unavailable.",
    "AUDIO_UNAVAILABLE": "Live audio is unavailable.",
    "LOGIN_REQUIRED": "Sign in again to access live audio.",
    "LIVE_ENDED": "The live session has ended.",
    "TRANSCRIPTION_FAILED": "Local transcription failed.",
}


class TranscriptionBusyError(RuntimeError):
    """Another session still owns the transcription worker."""


class TranscriptionSourceError(RuntimeError):
    """A source resolver can explicitly classify a safe public failure."""

    def __init__(self, code):
        if code not in {"LOGIN_REQUIRED", "LIVE_ENDED", "AUDIO_UNAVAILABLE"}:
            raise ValueError("invalid transcription source code")
        self.code = code
        super().__init__(code)


class _Session:
    def __init__(self, options, manifest_factory):
        self.id = secrets.token_urlsafe(24)
        self.options = options
        self.manifest_factory = manifest_factory
        self.stop_event = threading.Event()
        self.audio_stop = threading.Event()
        self.done = threading.Event()
        self.condition = threading.Condition()
        self.queue = deque()
        self.consumer = None
        self.timer = None
        self.worker = None
        self.audio = None
        self.prompt = ""
        self.history = deque(maxlen=256)
        self.last_state = None

    def emit(self, record):
        with self.condition:
            # Keep two slots free for an error followed by the terminal event.
            limit = 256 if record["type"] in {"error", "ended"} else 254
            if record["type"] == "state" and record.get("state") == self.last_state:
                return True
            while len(self.queue) >= limit:
                state = next((item for item in self.queue if item["type"] == "state"), None)
                if state is not None:
                    self.queue.remove(state)
                    continue
                if record["type"] == "state" or self.stop_event.is_set():
                    return False
                self.condition.wait()
            if record["type"] == "state":
                self.last_state = record["state"]
            self.queue.append(record)
            self.condition.notify_all()
            return True

    def state(self, state):
        if state in SESSION_STATES and not self.stop_event.is_set():
            self.emit({"type": "state", "state": state})


class _AudioFeed:
    """Read independently of inference; backpressure at 30 seconds of PCM."""

    def __init__(self, reader, url, session):
        self.reader, self.url, self.session = reader, url, session
        self.chunks = deque()
        self.buffered_bytes = 0
        self.received_bytes = 0
        self.finished = False
        self.error = None
        self.thread = threading.Thread(target=self._read, daemon=True)

    def _read(self):
        session = self.session
        frames = None
        try:
            frames = self.reader.frames(self.url, session.audio_stop)
            for frame in frames:
                # A reader normally supplies one second; splitting also bounds
                # retained chunks from other compatible reader implementations.
                for offset in range(0, len(frame), 32000):
                    chunk = frame[offset:offset + 32000]
                    with session.condition:
                        while self.buffered_bytes + len(chunk) > 960000:
                            if session.audio_stop.is_set():
                                return
                            session.condition.wait()
                        if session.audio_stop.is_set():
                            return
                        self.chunks.append(chunk)
                        self.buffered_bytes += len(chunk)
                        self.received_bytes += len(chunk)
                        session.condition.notify_all()
        except Exception as exc:
            self.error = exc
        finally:
            try:
                if frames is not None and hasattr(frames, "close"):
                    frames.close()
            finally:
                with session.condition:
                    self.finished = True
                    session.condition.notify_all()

    def __iter__(self):
        return self

    def __next__(self):
        with self.session.condition:
            while not self.session.stop_event.is_set():
                if self.chunks:
                    chunk = self.chunks.popleft()
                    self.buffered_bytes -= len(chunk)
                    self.session.condition.notify_all()
                    return chunk
                if self.finished:
                    if self.error is not None:
                        if isinstance(self.error, TranscriptionSourceError) and self.error.code == "LIVE_ENDED":
                            break
                        raise self.error
                    break
                self.session.condition.wait()
        raise StopIteration


class _EventStream:
    """Attach immediately, including when close() precedes the first next()."""

    def __init__(self, manager, session):
        self.manager, self.session = manager, session
        self.closed = False
        self.heartbeat_at = time.monotonic() + _HEARTBEAT_SECONDS
        with session.condition:
            if session.timer is not None:
                session.timer.cancel()
                session.timer = None
            session.consumer = self
            session.condition.notify_all()

    def __iter__(self):
        return self

    def __next__(self):
        session = self.session
        with session.condition:
            while True:
                if self.closed or session.consumer is not self:
                    raise StopIteration
                now = time.monotonic()
                if now >= self.heartbeat_at:
                    self.heartbeat_at = now + _HEARTBEAT_SECONDS
                    return b": heartbeat\n\n"
                if session.queue:
                    record = session.queue.popleft()
                    if record["type"] == "ended":
                        self.closed = True
                    session.condition.notify_all()
                    break
                if session.done.is_set():
                    self.closed = True
                    raise StopIteration
                session.condition.wait(self.heartbeat_at - now)
        if record["type"] == "ended":
            session.worker.join(_JOIN_SECONDS)
        return ("event: transcript\ndata: " + json.dumps(record, ensure_ascii=False) + "\n\n").encode("utf-8")

    def close(self):
        session = self.session
        with session.condition:
            if self.closed:
                return
            self.closed = True
            if session.consumer is not self:
                return
            session.consumer = None
            if not session.done.is_set():
                timer = threading.Timer(_GRACE_SECONDS, lambda: self.manager._expire(session, timer))
                timer.daemon = True
                session.timer = timer
                timer.start()
            session.condition.notify_all()


class TranscriptionManager:
    """Keep models lazy and serialize ownership of one transcription session.

    In-flight synchronous model calls cannot be preempted by the engine API.
    Stop waits a bounded time and retains ownership until the worker exits.
    """

    def __init__(self, engine=None, reader=None):
        self._engine = engine if engine is not None else WhisperEngine()
        self._reader = reader if reader is not None else FfmpegPcmReader()
        self._lock = threading.RLock()
        self._session = None
        self._shutdown = False

    def start(self, options, manifest_url_factory):
        with self._lock:
            if self._shutdown:
                raise RuntimeError("transcription manager is shut down")
            if self._session is not None and self._session.worker.is_alive():
                raise TranscriptionBusyError("a transcription session is active")
            session = _Session(options, manifest_url_factory)
            session.worker = threading.Thread(target=self._run, args=(session,), daemon=True)
            self._session = session
            session.worker.start()
            return session.id

    def events(self, session_id):
        with self._lock:
            if self._session is None or self._session.id != session_id:
                raise KeyError("unknown transcription session")
            return _EventStream(self, self._session)

    def stop(self, session_id):
        with self._lock:
            session = self._session
            if session is None or session.id != session_id:
                return False
            with session.condition:
                if session.stop_event.is_set() or session.done.is_set():
                    return False
                session.stop_event.set()
                session.audio_stop.set()
                if session.timer is not None:
                    session.timer.cancel()
                    session.timer = None
                session.condition.notify_all()
        session.worker.join(_JOIN_SECONDS)
        return True

    def capabilities(self):
        with self._lock:
            result = self._engine.capabilities()
            result["active"] = self._session is not None and self._session.worker.is_alive()
            return result

    def shutdown(self):
        with self._lock:
            self._shutdown = True
            session = self._session
        if session is not None:
            self.stop(session.id)
            session.worker.join(_JOIN_SECONDS)

    def _expire(self, session, timer):
        with session.condition:
            if session.timer is not timer or session.consumer is not None:
                return
            session.timer = None
            session.stop_event.set()
            session.audio_stop.set()
            session.condition.notify_all()
        session.worker.join(_JOIN_SECONDS)

    def _run(self, session):
        phase = "model"
        final_state, code = "live-ended", "LIVE_ENDED"
        try:
            if session.stop_event.is_set():
                return
            self._engine.prepare(session.options, session.state)
            if session.stop_event.is_set():
                return
            phase = "audio"
            session.state("connecting-audio")
            manifest_url = session.manifest_factory()
            if session.stop_event.is_set():
                return
            segmenter = PcmSegmenter()
            frames = _AudioFeed(self._reader, manifest_url, session)
            session.audio = frames
            frames.thread.start()
            session.state("listening")
            try:
                for frame in frames:
                    if session.stop_event.is_set():
                        break
                    for window in segmenter.push(frame):
                        phase = "inference"
                        self._transcribe(session, window, segmenter.sample_rate)
                        phase = "audio"
                if not session.stop_event.is_set():
                    for window in segmenter.flush():
                        phase = "inference"
                        self._transcribe(session, window, segmenter.sample_rate)
            finally:
                # Always release the audio pump, including after inference failure.
                if not frames.finished:
                    with session.condition:
                        session.audio_stop.set()
                        session.condition.notify_all()
                # The caller's join is bounded; ownership remains with this
                # worker until its audio pump has actually released resources.
                frames.thread.join()
        except Exception as exc:
            if isinstance(exc, TranscriptionSourceError):
                code = exc.code
            elif phase == "model":
                code = "MODEL_UNAVAILABLE"
            elif isinstance(exc, PermissionError) and phase == "audio":
                code = "LOGIN_REQUIRED"
            elif phase == "audio" or isinstance(exc, AudioStreamError):
                code = "AUDIO_UNAVAILABLE"
            else:
                code = "TRANSCRIPTION_FAILED"
            if code != "LIVE_ENDED":
                final_state = "error"
        finally:
            if session.stop_event.is_set():
                final_state, code = "stopped", None
            elif final_state == "error":
                session.emit({"type": "error", "code": code, "message": _ERROR_MESSAGES[code]})
            with session.condition:
                if session.timer is not None:
                    session.timer.cancel()
                    session.timer = None
                record = {"type": "ended", "state": final_state}
                if code is not None:
                    record["code"] = code
                session.emit(record)
                session.done.set()
                session.condition.notify_all()

    def _transcribe(self, session, window, sample_rate):
        if session.stop_event.is_set():
            return
        with session.condition:
            backlog = max(0, session.audio.received_bytes / (sample_rate * 2) - window.start)
        if backlog > 15:
            session.state("delayed")
            if not session.emit({"type": "lag", "seconds": backlog}):
                return
        elif session.last_state == "delayed":
            session.state("listening")
        slices = self._engine.transcribe(window.samples, sample_rate, session.options,
                                         initial_prompt=session.prompt[-500:])
        previous = [record for record in session.history if record["end"] > window.start]
        emitted = []
        for part in slices:
            if session.stop_event.is_set():
                return
            record = TranscriptEvent.segment(window.start + part.start, window.start + part.end, part.text).as_public_dict()
            start, end, text = record["start"], record["end"], record["text"].strip()
            overlapping = [old for old in previous if old["end"] > start and old["start"] < end]
            if overlapping:
                old_text, _ = _normalized("".join(old["text"] for old in overlapping))
                new_text, positions = _normalized(text)
                if new_text and new_text in old_text and end <= max(old["end"] for old in overlapping):
                    continue
                matched = next((n for n in range(min(len(old_text), len(new_text)), 0, -1)
                                if old_text.endswith(new_text[:n]) and (n >= 2 or n == len(new_text))), 0)
                if matched:
                    text = text[positions[matched - 1] + 1:]
                    text = text.lstrip()
                    while text and not text[0].isalnum():
                        text = text[1:].lstrip()
                    start = min(end, max(start, max(old["end"] for old in overlapping)))
            if not text:
                continue
            record = TranscriptEvent.segment(start, end, text).as_public_dict()
            if not session.emit(record):
                return
            session.prompt = (session.prompt + text)[-500:]
            emitted.append(record)
        session.history.extend(emitted)


def _normalized(text):
    normalized, positions = [], []
    for index, char in enumerate(text):
        for value in unicodedata.normalize("NFKC", char).casefold():
            if value.isalnum():
                normalized.append(value)
                positions.append(index)
    return "".join(normalized), positions
