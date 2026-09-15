"""Authenticated, local-only transcription route tests."""

import json
import unittest

from live_player.server.app import LiveApplication
from live_player.transcription.session import TranscriptionBusyError


class Client:
    def __init__(self, *, teacher_audio=True):
        self.teacher_audio = teacher_audio
        self.views = []

    def get_sub_info(self, course_id, sub_id):
        output = {"m3u8": "https://media.invalid/teacher.m3u8"}
        if self.teacher_audio:
            output["m3u8_audio"] = "https://media.invalid/teacher-audio.m3u8"
        return {"sub_id": sub_id, "sub_status": 1, "live_url": {"output": output}}


class SessionManager:
    def __init__(self, client=None, error=None):
        self.client = client or Client()
        self.error = error
        self.invalidated = 0

    def get_client(self):
        if self.error is not None:
            raise self.error
        return self.client

    def invalidate(self):
        self.invalidated += 1


class EventStream:
    def __init__(self):
        self.closed = False

    def __iter__(self):
        return iter((b"event: transcript\\ndata: {}\\n\\n",))

    def close(self):
        self.closed = True


class Manager:
    def __init__(self):
        self.started = None
        self.stopped = []
        self.stream = EventStream()
        self.shutdown_calls = 0
        self.busy = False

    def capabilities(self):
        return {"available": True, "active": False, "models": ["base"]}

    def start(self, options, manifest_factory):
        if self.busy:
            raise TranscriptionBusyError()
        self.started = type("Started", (), {
            "options": options,
            "manifest_url": manifest_factory(),
        })()
        return "tx_opaque_value"

    def events(self, session_id):
        if session_id != "tx_opaque_value":
            raise KeyError(session_id)
        return self.stream

    def stop(self, session_id):
        self.stopped.append(session_id)
        return False

    def shutdown(self):
        self.shutdown_calls += 1


class TranscriptionApiTest(unittest.TestCase):
    def setUp(self):
        self.manager = Manager()
        self.client = Client()
        self.sessions = SessionManager(self.client)
        self.app = LiveApplication(self.sessions, transcription_manager=self.manager)
        self.app.set_loopback_authority("127.0.0.1:4310")

    def auth(self):
        bootstrap = self.app.issue_bootstrap_token()
        response = self.app.handle(
            "POST", "/api/session", {}, json.dumps({"bootstrap_token": bootstrap}).encode(),
        )
        return {"Authorization": "Bearer " + json.loads(response.body)["token"]}

    @staticmethod
    def body(payload):
        return json.dumps(payload).encode()

    @staticmethod
    def defaults():
        return {"course_id": "c1", "sub_id": "s1"}

    def test_start_requires_bearer_and_builds_internal_media_url(self):
        denied = self.app.handle("POST", "/api/transcription/start", {}, self.body(self.defaults()))
        self.assertEqual(denied.status, 401)

        allowed = self.app.handle("POST", "/api/transcription/start", self.auth(), self.body(self.defaults()))
        self.assertEqual(allowed.status, 201)
        self.assertEqual(json.loads(allowed.body), {"session_id": "tx_opaque_value"})
        self.assertEqual(self.manager.started.options.model, "base")
        self.assertTrue(self.manager.started.manifest_url.startswith("http://127.0.0.1:4310/media/c1/s1/teacher_audio/manifest.m3u8?"))
        self.assertIn("media_token=", self.manager.started.manifest_url)
        self.assertNotIn("media.invalid", self.manager.started.manifest_url)

    def test_start_falls_back_to_teacher_when_audio_view_is_unavailable(self):
        self.client.teacher_audio = False

        response = self.app.handle("POST", "/api/transcription/start", self.auth(), self.body(self.defaults()))

        self.assertEqual(response.status, 201)
        self.assertIn("/teacher/manifest.m3u8?", self.manager.started.manifest_url)

    def test_events_are_streamed_and_not_buffered(self):
        response = self.app.handle("GET", "/api/transcription/events/tx_opaque_value", self.auth(), b"")

        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers["Content-Type"], "text/event-stream; charset=utf-8")
        self.assertEqual(response.headers["X-Accel-Buffering"], "no")
        self.assertEqual(response.body, b"")
        self.assertIs(response.body_iter, self.manager.stream)

    def test_rejects_invalid_transcription_payload_and_busy_manager(self):
        headers = self.auth()
        invalid = self.app.handle("POST", "/api/transcription/start", headers, self.body({"course_id": "c1", "sub_id": "s1", "url": "https://evil.invalid"}))
        self.assertEqual(invalid.status, 400)
        self.assertEqual(json.loads(invalid.body)["error"]["code"], "INVALID_TRANSCRIPTION_REQUEST")

        self.manager.busy = True
        busy = self.app.handle("POST", "/api/transcription/start", headers, self.body(self.defaults()))
        self.assertEqual(busy.status, 409)
        self.assertEqual(json.loads(busy.body)["error"]["code"], "TRANSCRIPTION_BUSY")

    def test_unavailable_audio_and_login_are_classified_without_upstream_detail(self):
        self.client.teacher_audio = False
        self.client.get_sub_info = lambda *_: {"sub_id": "s1", "sub_status": 1, "live_url": {"output": {}}}
        unavailable = self.app.handle("POST", "/api/transcription/start", self.auth(), self.body(self.defaults()))
        self.assertEqual(unavailable.status, 422)
        self.assertEqual(json.loads(unavailable.body)["error"]["code"], "AUDIO_UNAVAILABLE")

        app = LiveApplication(SessionManager(error=RuntimeError("credential=secret")), transcription_manager=Manager())
        app.set_loopback_authority("127.0.0.1:4311")
        bootstrap = app.issue_bootstrap_token()
        headers = {"Authorization": "Bearer " + json.loads(app.handle("POST", "/api/session", {}, self.body({"bootstrap_token": bootstrap})).body)["token"]}
        login = app.handle("POST", "/api/transcription/start", headers, self.body(self.defaults()))
        self.assertEqual(login.status, 401)
        self.assertEqual(json.loads(login.body)["error"]["code"], "LOGIN_REQUIRED")
        self.assertNotIn(b"secret", login.body)

    def test_stop_is_idempotent_and_validates_exact_session_payload(self):
        headers = self.auth()
        stopped = self.app.handle("POST", "/api/transcription/stop", headers, self.body({"session_id": "tx_opaque_value"}))
        self.assertEqual(stopped.status, 200)
        self.assertEqual(self.manager.stopped, ["tx_opaque_value"])

        invalid = self.app.handle("POST", "/api/transcription/stop", headers, self.body({"session_id": "tx_opaque_value", "url": "no"}))
        self.assertEqual(invalid.status, 400)
        self.assertEqual(json.loads(invalid.body)["error"]["code"], "INVALID_TRANSCRIPTION_REQUEST")

    def test_loopback_authority_is_strict_and_shutdown_stops_transcription_first(self):
        self.app.set_loopback_authority("127.0.0.1:4310")
        with self.assertRaises(ValueError):
            self.app.set_loopback_authority("localhost:4310")
        with self.assertRaises(ValueError):
            self.app.set_loopback_authority("127.0.0.1:0")
        with self.assertRaises(RuntimeError):
            self.app.set_loopback_authority("127.0.0.1:4311")

        self.app.shutdown()
        self.assertEqual(self.manager.shutdown_calls, 1)
        self.assertEqual(self.sessions.invalidated, 1)


if __name__ == "__main__":
    unittest.main()
