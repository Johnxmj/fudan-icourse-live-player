"""Offline fixtures only; all media references are invented."""

from copy import deepcopy
import unittest

from live_player.core.sources import LiveSourceResolver, rewrite_hls_manifest
from src.api.webvpn import get_ordinary_url
from tests.live_core.fixtures import LIVE_INFO


class FakeClient:
    def __init__(self):
        self.info = deepcopy(LIVE_INFO)
        self.calls = []

    def get_sub_info(self, course_id, sub_id):
        self.calls.append((course_id, sub_id))
        return self.info


class SourceTest(unittest.TestCase):
    def test_rejects_unknown_view_without_fetching(self):
        client = FakeClient()
        with self.assertRaisesRegex(ValueError, "unknown live view"):
            LiveSourceResolver(client).resolve("1", "2", "screen")
        self.assertEqual(client.calls, [])

    def test_resolves_each_view_through_webvpn(self):
        client = FakeClient()
        resolver = LiveSourceResolver(client)
        for view, filename in (
            ("teacher", "fixture-teacher.m3u8"),
            ("student", "fixture-student.m3u8"),
            ("teacher_audio", "fixture-teacher-audio.m3u8"),
            ("student_audio", "fixture-student-audio.m3u8"),
        ):
            with self.subTest(view=view):
                url = resolver.resolve("1", "2", view)
                self.assertEqual(get_ordinary_url(url), "https://media.invalid/" + filename)
        self.assertEqual(client.calls, [("1", "2")] * 4)

    def test_rechecks_current_live_status_each_time(self):
        client = FakeClient()
        resolver = LiveSourceResolver(client)
        client.info["sub_status"] = "1"
        resolver.resolve("1", "2", "teacher")
        for status in (0, 2, None, "unknown", True, 1.5):
            client.info["sub_status"] = status
            with self.subTest(status=status):
                with self.assertRaisesRegex(RuntimeError, "not currently live"):
                    resolver.resolve("1", "2", "teacher")

    def test_rejects_missing_malformed_and_non_https_sources(self):
        client = FakeClient()
        for value in (None, {}, "", "http://media.invalid/live.m3u8", "https://", "https:///missing-host"):
            client.info["live_url"]["output"]["m3u8"] = value
            with self.subTest(value=value):
                with self.assertRaisesRegex(RuntimeError, "live view unavailable"):
                    LiveSourceResolver(client).resolve("1", "2", "teacher")


class ManifestTest(unittest.TestCase):
    def rewrite(self, manifest):
        self.seen = []

        def register(url):
            self.seen.append(url)
            return f"/media/segment/{len(self.seen)}"

        return rewrite_hls_manifest(manifest, register, "https://media.invalid/live/main.m3u8")

    def test_rewrites_absolute_and_relative_segments(self):
        output = self.rewrite("#EXTM3U\n#EXTINF:10,\nseg-1.ts?sig=fixture\n#EXTINF:10,\nhttps://media.invalid/live/seg-2.ts?sig=fixture\n")
        self.assertEqual(output, "#EXTM3U\n#EXTINF:10,\n/media/segment/1\n#EXTINF:10,\n/media/segment/2\n")
        self.assertEqual(self.seen, ["https://media.invalid/live/seg-1.ts?sig=fixture", "https://media.invalid/live/seg-2.ts?sig=fixture"])

    def test_preserves_comments_blank_lines_and_final_newline(self):
        for text in ("", "#EXTM3U\n\n# comment", "#EXTM3U\r\n\r\n# comment\r\n"):
            with self.subTest(text=text):
                self.assertEqual(self.rewrite(text), text)
                self.assertEqual(self.seen, [])

    def test_rewrites_uri_attributes_preserving_other_tag_content(self):
        for tag, attributes, expected in (
            ("KEY", 'METHOD=AES-128,URI="../key?sig=fixture",IV=0x01', 'METHOD=AES-128,URI="/media/segment/1",IV=0x01'),
            ("MAP", 'URI="../key?sig=fixture",BYTERANGE="512@0"', 'URI="/media/segment/1",BYTERANGE="512@0"'),
            ("MEDIA", 'TYPE=AUDIO,GROUP-ID="audio",URI="../key?sig=fixture"', 'TYPE=AUDIO,GROUP-ID="audio",URI="/media/segment/1"'),
            ("I-FRAME-STREAM-INF", 'BANDWIDTH=100,URI="../key?sig=fixture"', 'BANDWIDTH=100,URI="/media/segment/1"'),
        ):
            with self.subTest(tag=tag):
                self.assertEqual(self.rewrite(f"#EXT-X-{tag}:{attributes}\r\n"), f"#EXT-X-{tag}:{expected}\r\n")
                self.assertEqual(self.seen, ["https://media.invalid/key?sig=fixture"])

    def test_does_not_rewrite_uri_suffix_or_text_inside_other_attributes(self):
        manifest = '#EXT-X-EXAMPLE:OTHER-URI="unchanged",NAME="URI=example",URI="init.mp4"\n# comment URI="unchanged"\n'
        self.assertEqual(self.rewrite(manifest), '#EXT-X-EXAMPLE:OTHER-URI="unchanged",NAME="URI=example",URI="/media/segment/1"\n# comment URI="unchanged"\n')
        self.assertEqual(self.seen, ["https://media.invalid/live/init.mp4"])

    def test_rewrites_master_playlist_and_network_path_references(self):
        output = self.rewrite('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\n../variant/main.m3u8?sig=fixture\n//cdn.invalid/segment.ts')
        self.assertEqual(output, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\n/media/segment/1\n/media/segment/2')
        self.assertEqual(self.seen, ['https://media.invalid/variant/main.m3u8?sig=fixture', 'https://cdn.invalid/segment.ts'])


if __name__ == "__main__":
    unittest.main()
