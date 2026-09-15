"""Read a locally served HLS stream as in-memory PCM blocks."""

from collections.abc import Iterator
from queue import Empty, Full, Queue
import re
import subprocess
import threading
from urllib.parse import urlsplit


_SAFE_IDENTIFIER = re.compile(r"^[A-Za-z0-9]{1,64}$")
_SAFE_VIEW = re.compile(r"^[A-Za-z0-9_]{1,64}$")
_PCM_BLOCK_BYTES = 32_000
_MAX_STDERR_BYTES = 32 * 1024
_STOP_WAIT_SECONDS = 5


class AudioStreamError(RuntimeError):
    """An ffmpeg stream ended unexpectedly without exposing its source URL."""


def _validate_manifest_url(manifest_url):
    if not isinstance(manifest_url, str):
        raise ValueError("invalid local media manifest URL")
    try:
        parsed = urlsplit(manifest_url)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("invalid local media manifest URL") from exc
    parts = parsed.path.split("/")
    valid_path = (
        len(parts) == 6
        and parts[0] == ""
        and parts[1] == "media"
        and parts[5] == "manifest.m3u8"
        and all(_SAFE_IDENTIFIER.fullmatch(part) for part in parts[2:4])
        and _SAFE_VIEW.fullmatch(parts[4])
    )
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or port is None
        or not 1 <= port <= 65535
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or not valid_path
    ):
        raise ValueError("invalid local media manifest URL")


def build_ffmpeg_command(manifest_url, ffmpeg="ffmpeg"):
    """Build the sole supported ffmpeg invocation: mono 16 kHz PCM on stdout."""
    _validate_manifest_url(manifest_url)
    if not isinstance(ffmpeg, str) or not ffmpeg:
        raise ValueError("invalid ffmpeg executable")
    return [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        manifest_url,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "s16le",
        "pipe:1",
    ]


class _BoundedStderr:
    def __init__(self, stream):
        self._stream = stream
        self._contents = bytearray()
        self._thread = threading.Thread(target=self._drain, daemon=True)

    def start(self):
        self._thread.start()

    def join(self):
        self._thread.join(timeout=_STOP_WAIT_SECONDS)

    def _drain(self):
        while True:
            chunk = self._stream.read(4096)
            if not chunk:
                return
            remaining = _MAX_STDERR_BYTES - len(self._contents)
            if remaining > 0:
                self._contents.extend(chunk[:remaining])


class _PcmStdout:
    """Drain a blocking pipe on a daemon thread through a bounded queue."""

    def __init__(self, stream):
        self._stream = stream
        self._chunks = Queue(maxsize=2)
        self._closed = threading.Event()
        self._finished = threading.Event()
        self._thread = threading.Thread(target=self._drain, daemon=True)

    @property
    def finished(self):
        return self._finished.is_set()

    def start(self):
        self._thread.start()

    def close(self):
        self._closed.set()

    def join(self):
        self._thread.join(timeout=_STOP_WAIT_SECONDS)

    def pop(self):
        try:
            return self._chunks.get(timeout=0.1)
        except Empty:
            return None

    def _drain(self):
        try:
            while not self._closed.is_set():
                chunk = self._stream.read(_PCM_BLOCK_BYTES)
                if not chunk:
                    return
                while not self._closed.is_set():
                    try:
                        self._chunks.put(chunk, timeout=0.1)
                        break
                    except Full:
                        pass
        finally:
            self._finished.set()


class FfmpegPcmReader:
    """Spawn ffmpeg with pipes only and yield aligned PCM blocks from stdout."""

    def __init__(self, command_factory=None, process_factory=None):
        self._command_factory = command_factory or build_ffmpeg_command
        self._process_factory = process_factory

    def frames(self, manifest_url, stop_event) -> Iterator[bytes]:
        if not hasattr(stop_event, "is_set"):
            raise ValueError("stop event must expose is_set")
        _validate_manifest_url(manifest_url)
        command = self._command_factory(manifest_url)
        if not isinstance(command, (list, tuple)) or not command:
            raise ValueError("invalid ffmpeg command")
        process = self._start_process(command)
        stderr = _BoundedStderr(process.stderr)
        stdout = _PcmStdout(process.stdout)
        stderr.start()
        stdout.start()
        completed = False
        pending = b""
        try:
            while not stop_event.is_set():
                chunk = stdout.pop()
                if chunk is None:
                    if stdout.finished:
                        break
                    continue
                pending += chunk
                while len(pending) >= _PCM_BLOCK_BYTES:
                    yield pending[:_PCM_BLOCK_BYTES]
                    pending = pending[_PCM_BLOCK_BYTES:]
            if not stop_event.is_set() and pending:
                yield pending
            if not stop_event.is_set():
                return_code = process.wait()
                stderr.join()
                completed = True
                if return_code:
                    raise AudioStreamError(f"ffmpeg audio stream exited with code {return_code}")
        finally:
            stdout.close()
            if not completed:
                self._stop_process(process)
            stdout.join()
            stderr.join()

    def _start_process(self, command):
        if self._process_factory is not None:
            return self._process_factory(command)
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        return subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=creationflags,
        )

    @staticmethod
    def _stop_process(process):
        try:
            process.terminate()
        except (AttributeError, OSError):
            return
        try:
            process.wait(timeout=_STOP_WAIT_SECONDS)
        except subprocess.TimeoutExpired:
            try:
                process.kill()
            except (AttributeError, OSError):
                return
            try:
                process.wait(timeout=_STOP_WAIT_SECONDS)
            except (subprocess.TimeoutExpired, OSError):
                pass
