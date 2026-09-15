"""Turn a PCM byte stream into bounded, overlapping Whisper windows."""

from dataclasses import dataclass
import math

import numpy as np


_MINIMUM_FLUSH_SECONDS = 0.5


@dataclass(frozen=True)
class PcmWindow:
    """One source-timestamped float32 PCM window ready for transcription."""

    start: float
    end: float
    samples: np.ndarray


class PcmSegmenter:
    """Keep at most a fixed amount of unprocessed mono PCM in memory."""

    def __init__(
        self,
        sample_rate=16_000,
        window_seconds=12.0,
        overlap_seconds=1.5,
        max_buffer_seconds=30.0,
    ):
        self.sample_rate = self._positive_integer(sample_rate, "sample rate")
        self._window_samples = self._seconds_to_samples(window_seconds, "window duration")
        self._overlap_samples = self._seconds_to_samples(overlap_seconds, "overlap duration", allow_zero=True)
        self._max_buffer_samples = self._seconds_to_samples(max_buffer_seconds, "maximum buffer duration")
        if self._overlap_samples >= self._window_samples:
            raise ValueError("overlap duration must be shorter than window duration")
        self._hop_samples = self._window_samples - self._overlap_samples
        self._minimum_flush_samples = math.ceil(_MINIMUM_FLUSH_SECONDS * self.sample_rate)
        self._buffer = np.empty(0, dtype=np.float32)
        self._buffer_start = 0
        self._next_start = 0
        self._trailing_byte = b""
        self._dropped_samples = 0

    @property
    def buffered_seconds(self):
        return len(self._buffer) / self.sample_rate

    @property
    def dropped_seconds(self):
        return self._dropped_samples / self.sample_rate

    def push(self, data):
        """Accept little-endian s16le bytes and return newly complete windows."""
        try:
            raw = memoryview(data).cast("B").tobytes()
        except (TypeError, ValueError) as exc:
            raise ValueError("PCM data must be bytes-like") from exc
        raw = self._trailing_byte + raw
        complete_size = len(raw) - (len(raw) % 2)
        complete, self._trailing_byte = raw[:complete_size], raw[complete_size:]
        if complete:
            samples = np.frombuffer(complete, dtype="<i2").astype(np.float32) / 32768.0
            self._append(samples)
        return self._emit_complete_windows()

    def flush(self):
        """Return the final partial window only when it covers at least 0.5 seconds."""
        buffer_end = self._buffer_start + len(self._buffer)
        available = buffer_end - self._next_start
        windows = []
        if available >= self._minimum_flush_samples:
            offset = self._next_start - self._buffer_start
            windows.append(
                PcmWindow(
                    self._next_start / self.sample_rate,
                    buffer_end / self.sample_rate,
                    self._buffer[offset:].copy(),
                )
            )
        self._buffer = np.empty(0, dtype=np.float32)
        self._buffer_start = buffer_end
        self._next_start = buffer_end
        self._trailing_byte = b""
        return windows

    def _append(self, samples):
        if len(self._buffer):
            self._buffer = np.concatenate((self._buffer, samples))
        else:
            self._buffer = samples.copy()
        excess = len(self._buffer) - self._max_buffer_samples
        if excess > 0:
            self._buffer = self._buffer[excess:].copy()
            self._buffer_start += excess
            self._dropped_samples += excess
            self._next_start = max(self._next_start, self._buffer_start)

    def _emit_complete_windows(self):
        windows = []
        buffer_end = self._buffer_start + len(self._buffer)
        while self._next_start + self._window_samples <= buffer_end:
            offset = self._next_start - self._buffer_start
            end_offset = offset + self._window_samples
            windows.append(
                PcmWindow(
                    self._next_start / self.sample_rate,
                    (self._next_start + self._window_samples) / self.sample_rate,
                    self._buffer[offset:end_offset].copy(),
                )
            )
            self._next_start += self._hop_samples
            discard = self._next_start - self._buffer_start
            if discard:
                self._buffer = self._buffer[discard:].copy()
                self._buffer_start = self._next_start
                buffer_end = self._buffer_start + len(self._buffer)
        return windows

    @staticmethod
    def _positive_integer(value, name):
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ValueError(f"{name} must be positive")
        return value

    def _seconds_to_samples(self, value, name, allow_zero=False):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"{name} must be finite")
        if value < 0 or (not allow_zero and value <= 0):
            raise ValueError(f"{name} must be positive")
        samples = round(value * self.sample_rate)
        if samples < 0 or (not allow_zero and samples <= 0):
            raise ValueError(f"{name} is too short")
        return samples
