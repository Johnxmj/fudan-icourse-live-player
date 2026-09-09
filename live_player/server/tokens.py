"""Opaque one-use values held exclusively in process memory."""

import math
import secrets
import threading
import time


class TokenStore:
    def __init__(self, clock=time.monotonic):
        self._clock = clock
        self._entries = {}
        self._lock = threading.Lock()

    def issue(self, value, ttl_seconds):
        if not math.isfinite(ttl_seconds) or ttl_seconds <= 0:
            raise ValueError("token lifetime must be finite and positive")
        with self._lock:
            now = self._clock()
            self._entries = {key: entry for key, entry in self._entries.items() if entry[0] > now}
            token = secrets.token_urlsafe(32)
            self._entries[token] = (now + ttl_seconds, value)
            return token

    def consume(self, token):
        if not isinstance(token, str):
            return None
        with self._lock:
            entry = self._entries.pop(token, None)
            return entry[1] if entry and entry[0] > self._clock() else None

    def clear(self):
        with self._lock:
            self._entries.clear()
