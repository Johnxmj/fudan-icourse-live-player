import json
import unittest

from live_player.core.session import SessionManager
from live_player.server.app import LiveApplication
from tests.live_server.test_api import Client


class Upstream:
    def __init__(self, data, status=200):
        self.data = data
        self.status_code = status
        self.headers = {"Content-Type": "application/vnd.apple.mpegurl" if data.startswith(b"#EXTM3U") else "video/mp2t"}

    def iter_content(self, size):
        yield self.data

    def close(self):
        pass


class MediaLifetimeTest(unittest.TestCase):
    def setUp(self):
        self.now = [0]
        self.client = Client()
        self.app = LiveApplication(SessionManager(lambda: self.client), course_ids=["c1"])
        self.app._media_tokens._clock = lambda: self.now[0]
        self.app._media_routes._clock = lambda: self.now[0]
        self.token = self.app._media_token_for_course("c1", "s1")
        self.manifest = "/media/c1/s1/teacher/manifest.m3u8?media_token=" + self.token

    def request(self, path):
        response = self.app.handle("GET", path, {}, b"")
        if response.body_iter is not None:
            b"".join(response.body_iter)
        return response

    def test_continuous_playback_renews_authorization_past_initial_lifetime(self):
        for elapsed in range(0, 3601, 30):
            self.now[0] = elapsed
            self.assertEqual(self.request(self.manifest).status, 200, elapsed)

    def test_authorization_expires_after_five_minutes_without_valid_media(self):
        self.assertEqual(self.request(self.manifest).status, 200)
        self.now[0] = 299
        self.assertEqual(self.request(self.manifest).status, 200)
        self.now[0] = 599
        self.assertEqual(self.request(self.manifest).status, 401)

    def test_invalid_course_requests_do_not_keep_token_alive(self):
        for elapsed in (0, 100, 200):
            self.now[0] = elapsed
            self.assertEqual(self.request(self.manifest.replace("/c1/", "/other/")).status, 401)
        self.now[0] = 300
        self.assertEqual(self.request(self.manifest).status, 401)

    def test_continuous_playback_still_has_a_six_hour_absolute_limit(self):
        for elapsed in range(0, 6 * 60 * 60, 60):
            self.now[0] = elapsed
            self.assertEqual(self.request(self.manifest).status, 200, elapsed)
        self.now[0] = 6 * 60 * 60
        self.assertEqual(self.request(self.manifest).status, 401)

    def test_master_child_playlist_keeps_working_while_old_segments_expire(self):
        def get_raw(url, **kwargs):
            if "child.m3u8" in url:
                return Upstream(b"#EXTM3U\n#EXTINF:4,\nsegment.ts\n")
            if "segment.ts" in url:
                return Upstream(b"segment")
            return Upstream(b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nchild.m3u8\n")

        self.client.get_raw = get_raw
        child = self.request(self.manifest).body.decode().splitlines()[-1]
        old_segment = self.request(child).body.decode().splitlines()[-1]
        for elapsed in range(30, 361, 30):
            self.now[0] = elapsed
            playlist = self.request(child)
            self.assertEqual(playlist.status, 200, elapsed)
            segment = playlist.body.decode().splitlines()[-1]
            self.assertEqual(self.request(segment).status, 200)
        self.assertEqual(self.request(old_segment).status, 410)

    def test_upstream_denied_manifest_revokes_media_authorization(self):
        self.client.get_raw = lambda *args, **kwargs: Upstream(b"denied", status=403)
        self.assertEqual(self.request(self.manifest).status, 410)
        self.assertEqual(self.request(self.manifest).status, 401)

    def test_expired_course_source_revokes_its_media_authorization(self):
        self.client.get_sub_info = lambda *args: {"sub_id": "s1", "sub_status": 2}
        self.assertEqual(self.request(self.manifest).status, 410)
        self.assertEqual(self.request(self.manifest).status, 401)
