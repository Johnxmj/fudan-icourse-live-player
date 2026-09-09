"""Session lifecycle tests with offline clients; no credentials or network."""

from concurrent.futures import ThreadPoolExecutor
import gc
import unittest
import weakref

from live_player.core.session import SessionManager


class FakeClient:
    def __init__(self, alive=True):
        self.alive = alive
        self.vpn = type("Session", (), {})()

    def check_alive(self):
        if isinstance(self.alive, Exception):
            raise self.alive
        return self.alive


class FakeFactory:
    def __init__(self, outcomes):
        self.outcomes = iter(outcomes)
        self.calls = 0

    def __call__(self):
        self.calls += 1
        outcome = next(self.outcomes)
        if isinstance(outcome, Exception):
            raise outcome
        return FakeClient(outcome)


class SessionManagerTest(unittest.TestCase):
    def test_reauthenticates_once_after_a_cold_session(self):
        factory = FakeFactory([False, True])
        manager = SessionManager(factory, max_login_attempts=2)
        self.assertEqual(manager.call(lambda client: "ok"), "ok")
        self.assertEqual(factory.calls, 2)

    def test_login_failures_are_bounded_and_sanitized(self):
        factory = FakeFactory([RuntimeError("password=fixture-private"), False, True])
        manager = SessionManager(factory)
        with self.assertRaises(RuntimeError) as caught:
            manager.get_client()
        self.assertEqual(factory.calls, 2)
        self.assertNotIn("fixture-private", str(caught.exception))

    def test_factory_exception_diagnostic_is_redacted(self):
        factory = FakeFactory([ValueError("password=fixture-private")] * 2)
        with self.assertRaises(RuntimeError) as caught:
            SessionManager(factory).get_client()
        self.assertNotIn("fixture-private", str(caught.exception))
        self.assertTrue(caught.exception.__suppress_context__)

    def test_rechecks_cached_client_and_replaces_expired_session(self):
        factory = FakeFactory([True, True])
        manager = SessionManager(factory)
        old = manager.get_client()
        self.assertIs(manager.get_client(), old)
        old.alive = False
        self.assertIsNot(manager.get_client(), old)
        self.assertEqual(factory.calls, 2)

    def test_health_check_exception_does_not_escape(self):
        factory = FakeFactory([True, RuntimeError("password=fixture-private"), True])
        manager = SessionManager(factory)
        manager.get_client().alive = RuntimeError("token=fixture-private")
        self.assertTrue(manager.get_client().alive)
        self.assertEqual(factory.calls, 3)

    def test_invalidate_releases_client_and_session(self):
        manager = SessionManager(FakeFactory([True, True]))
        client = manager.get_client()
        client_ref, session_ref = weakref.ref(client), weakref.ref(client.vpn)
        del client
        manager.invalidate()
        gc.collect()
        self.assertIsNone(client_ref())
        self.assertIsNone(session_ref())
        self.assertTrue(manager.get_client().alive)

    def test_concurrent_acquisitions_share_one_login(self):
        factory = FakeFactory([True] * 12)
        manager = SessionManager(factory)
        with ThreadPoolExecutor(max_workers=8) as workers:
            clients = list(workers.map(lambda _: manager.get_client(), range(24)))
        self.assertTrue(all(client is clients[0] for client in clients))
        self.assertEqual(factory.calls, 1)

    def test_operation_error_is_sanitized_without_replay_and_invalidates(self):
        factory = FakeFactory([True, True])
        manager = SessionManager(factory)
        calls = []

        def operation(client):
            calls.append(1)
            raise ValueError("request https://media.invalid/a?token=fixture-private")

        with self.assertRaises(RuntimeError) as caught:
            manager.call(operation)
        self.assertNotIn("fixture-private", str(caught.exception))
        self.assertEqual(len(calls), 1)
        manager.get_client()
        self.assertEqual(factory.calls, 2)

    def test_rejects_invalid_retry_bounds(self):
        for value in (0, -1, True, 1.5, "2", None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                SessionManager(lambda: FakeClient(), max_login_attempts=value)

    def test_factory_errors_do_not_expose_arbitrary_exception_text(self):
        factory = FakeFactory([RuntimeError("unlabelled fixture-private")] * 2)
        with self.assertRaises(RuntimeError) as caught:
            SessionManager(factory).get_client()
        self.assertNotIn("fixture-private", str(caught.exception))

    def test_operation_errors_do_not_expose_arbitrary_exception_text(self):
        def operation(client):
            raise ValueError("unlabelled fixture-private")
        with self.assertRaises(RuntimeError) as caught:
            SessionManager(FakeFactory([True])).call(operation)
        self.assertNotIn("fixture-private", str(caught.exception))
