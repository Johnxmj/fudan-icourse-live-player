from datetime import datetime
import http.client
import json
import threading
import unittest

from live_player.core.catalog import PLATFORM_TIMEZONE
from live_player.core.session import SessionManager
from live_player.server.app import LiveApplication, Response
from live_player.server.handler import serve


class Client:
    def __init__(self):
        self.vpn = self
        self.requests = []

    def check_alive(self):
        return True

    def get_course_detail(self, course_id):
        return {"title": "Course", "lectures": [{"sub_id": "s1", "date": datetime.now(PLATFORM_TIMEZONE).date().isoformat()}]}

    def get_sub_info(self, course_id, sub_id):
        return {"sub_id": sub_id, "sub_status": 1, "live_url": {"output": {"m3u8": "https://example.invalid/live?token=secret"}}}

    def get_raw(self, url, **kwargs):
        self.requests.append((url, kwargs))

        class Upstream:
            def __init__(self, is_manifest):
                self.status_code = 200
                self.headers = {
                    "Content-Type": "application/vnd.apple.mpegurl" if is_manifest else "video/mp2t",
                    "Content-Length": "30",
                    "Accept-Ranges": "bytes",
                }
                self.data = b"#EXTM3U\n#EXTINF:4,\nsegment.ts\n" if is_manifest else b"segment-bytes"
                self.closed = False

            def iter_content(self, chunk_size):
                yield self.data

            def close(self):
                self.closed = True

        return Upstream(not kwargs.get("stream"))


class LiveApiTest(unittest.TestCase):
    def setUp(self):
        self.app = LiveApplication(SessionManager(Client), course_ids=["c1"])

    def authorize(self):
        bootstrap = self.app.issue_bootstrap_token()
        response = self.app.handle("POST", "/api/session", {}, json.dumps({"bootstrap_token": bootstrap}).encode())
        self.assertEqual(response.status, 200)
        return {"Authorization": "Bearer " + json.loads(response.body)["token"]}

    def test_rejects_course_list_without_session_token(self):
        self.assertEqual(self.app.handle("GET", "/api/live-courses", {}, b"").status, 401)

    def test_returns_only_safe_course_fields(self):
        headers = self.authorize()
        for _ in range(2):
            response = self.app.handle("GET", "/api/live-courses", headers, b"")
            payload = json.loads(response.body)
            self.assertEqual(payload[0]["status"], "live")
            self.assertEqual(payload[0]["available_views"], ["teacher"])
            self.assertNotIn("live_url", response.body.decode())
            self.assertNotIn("secret", response.body.decode())
            self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_bootstrap_cannot_be_replayed_or_used_as_bearer(self):
        token = self.app.issue_bootstrap_token()
        body = json.dumps({"bootstrap_token": token}).encode()
        self.assertEqual(self.app.handle("GET", "/api/live-courses", {"Authorization": "Bearer " + token}, b"").status, 401)
        self.assertEqual(self.app.handle("POST", "/api/session", {}, body).status, 200)
        self.assertEqual(self.app.handle("POST", "/api/session", {}, body).status, 401)

    def test_malformed_session_bodies_never_escape(self):
        for body in (b"[]", b"null", b"{", b'{}', b'{"bootstrap_token": []}', b'\xff'):
            with self.subTest(body=body):
                self.assertIn(self.app.handle("POST", "/api/session", {}, body).status, (400, 401))

    def test_query_token_and_wrong_bearer_are_not_authorization(self):
        headers = self.authorize()
        token = headers["Authorization"].split()[1]
        self.assertEqual(self.app.handle("GET", "/api/live-courses?token=" + token, {}, b"").status, 401)
        self.assertEqual(self.app.handle("GET", "/api/live-courses", {"Authorization": "Bearer wrong"}, b"").status, 401)

    def test_empty_catalog_has_stable_error(self):
        class Empty(Client):
            def get_course_detail(self, course_id):
                return {"lectures": []}
        self.app = LiveApplication(SessionManager(Empty), course_ids=["c1"])
        response = self.app.handle("GET", "/api/live-courses", self.authorize(), b"")
        self.assertEqual(json.loads(response.body)["error"]["code"], "NO_LIVE_COURSES")

    def test_upstream_errors_are_not_exposed(self):
        class Broken(Client):
            def get_course_detail(self, course_id):
                raise RuntimeError("password=secret https://x.invalid/?sign=secret")
        self.app = LiveApplication(SessionManager(Broken), course_ids=["c1"])
        response = self.app.handle("GET", "/api/live-courses", self.authorize(), b"")
        self.assertEqual(response.status, 502)
        self.assertNotIn(b"secret", response.body)

    def test_media_routes_require_an_opaque_media_token(self):
        headers = self.authorize()
        self.assertEqual(self.app.handle("GET", "/media/c1/s1/teacher/manifest.m3u8", headers, b"").status, 401)
        courses = json.loads(self.app.handle("GET", "/api/live-courses", headers, b"").body)
        media_token = courses[0]["media_token"]
        response = self.app.handle("GET", "/media/c1/s1/teacher/manifest.m3u8?media_token=" + media_token, headers, b"")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers["Content-Type"], "application/vnd.apple.mpegurl")

    def test_media_routes_accept_opaque_media_tokens(self):
        headers = self.authorize()
        courses = json.loads(self.app.handle("GET", "/api/live-courses", headers, b"").body)
        media_token = courses[0]["media_token"]
        response = self.app.handle("GET", "/media/c1/s1/teacher/manifest.m3u8?media_token=" + media_token, headers, b"")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers["Content-Type"], "application/vnd.apple.mpegurl")
        self.assertIn(b"/media/segment/", response.body)
        self.assertNotIn(b"secret", response.body)

    def test_media_routes_accept_opaque_media_tokens_without_bearer(self):
        headers = self.authorize()
        courses = json.loads(self.app.handle("GET", "/api/live-courses", headers, b"").body)
        media_token = courses[0]["media_token"]
        response = self.app.handle("GET", "/media/c1/s1/teacher/manifest.m3u8?media_token=" + media_token, {}, b"")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers["Content-Type"], "application/vnd.apple.mpegurl")

    def test_media_routes_authorize_before_custom_handler(self):
        calls = []

        def media_handler(method, path, headers, body):
            calls.append((method, path, headers, body))
            return Response(200, {"Content-Type": "text/plain"}, b"custom media")

        self.app.media_handler = media_handler
        path = "/media/c1/s1/teacher/manifest.m3u8?media_token=opaque"

        self.assertEqual(self.app.handle("GET", path, {}, b"").status, 401)
        self.assertEqual(self.app.handle("GET", path, {"Authorization": "Bearer wrong"}, b"").status, 401)

        response = self.app.handle("GET", path, self.authorize(), b"")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.body, b"custom media")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], "GET")
        self.assertEqual(calls[0][1], path)

    def test_serve_rejects_non_loopback_bind(self):
        for host in ("0.0.0.0", "192.0.2.1", "example.com", "::1", "127.0.0.2", "localhost"):
            with self.subTest(host=host), self.assertRaises(ValueError):
                server = serve(self.app, host=host)
                server.server_close()

    def test_real_http_server_rejects_foreign_host_and_origin(self):
        server = serve(self.app)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for headers, status in (({}, 401), ({"Host": "evil.example"}, 403), ({"Origin": "https://evil.example"}, 403)):
                connection = http.client.HTTPConnection(*server.server_address, timeout=3)
                try:
                    connection.request("GET", "/api/live-courses", headers=headers)
                    response = connection.getresponse()
                    self.assertEqual(response.status, status)
                    self.assertEqual(response.getheader("Cache-Control"), "no-store")
                    response.read()
                finally:
                    connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_shutdown_invalidates_bootstrap_sessions(self):
        class SessionManager:
            def __init__(self):
                self.invalidated = 0

            def get_client(self):
                return Client()

            def invalidate(self):
                self.invalidated += 1

        manager = SessionManager()
        app = LiveApplication(manager, course_ids=["c1"])
        token = app.issue_bootstrap_token()
        app.shutdown()

        response = app.handle("POST", "/api/session", {}, json.dumps({"bootstrap_token": token}).encode())
        self.assertEqual(response.status, 401)
        self.assertEqual(manager.invalidated, 1)
