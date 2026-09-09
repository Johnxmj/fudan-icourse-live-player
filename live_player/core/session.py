"""Lock-protected, memory-only live client lifecycle with bounded logins."""

import threading


class SessionManager:
    """The factory authenticates once and returns a client owning its VPN session.

    Factories must keep credentials/cookies in memory and must not perform their
    own unbounded retry loop. No separate session reference is retained here.
    """

    def __init__(self, factory, max_login_attempts=2):
        if type(max_login_attempts) is not int or max_login_attempts < 1:
            raise ValueError("max_login_attempts must be a positive integer")
        self.factory = factory
        self.max_login_attempts = max_login_attempts
        self._client = None
        self._lock = threading.RLock()

    def get_client(self):
        """Return a healthy client, attempting at most the configured logins."""
        with self._lock:
            if self._client is not None:
                try:
                    if self._client.check_alive():
                        return self._client
                except Exception:
                    pass
                self._client = None
            for _ in range(self.max_login_attempts):
                try:
                    client = self.factory()
                    if client.check_alive():
                        self._client = client
                        return client
                except Exception:
                    pass
            # Upstream exception text can contain arbitrary unlabelled secrets.
            raise RuntimeError("live session authentication failed") from None

    def invalidate(self):
        """Release our client and its owned session; external holders remain valid."""
        with self._lock:
            self._client = None

    def call(self, operation):
        """Run once with a healthy client; use fixed errors and drop stale state.

        Operations are not replayed because they need not be idempotent. Holding
        the same lock also prevents invalidation during an operation and protects
        the shared client's underlying HTTP session from concurrent mutations.
        """
        with self._lock:
            client = self.get_client()
            try:
                return operation(client)
            except Exception:
                self.invalidate()
            raise RuntimeError("live session operation failed") from None
