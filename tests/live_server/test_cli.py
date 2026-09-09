import os
import unittest
from unittest.mock import patch

from live_player.cli import LauncherConfig, build_application, launch_player, open_edge


class FakeApplication:
    def __init__(self):
        self.shutdown_calls = 0

    def shutdown(self):
        self.shutdown_calls += 1


class FakeServer:
    def __init__(self, address=("127.0.0.1", 53123), *, stop_after_launch=True):
        self.server_address = address
        self.shutdown_calls = 0
        self.server_close_calls = 0
        self.stop_after_launch = stop_after_launch
        self.serve_forever_started = False

    def serve_forever(self):
        self.serve_forever_started = True
        if self.stop_after_launch:
            raise KeyboardInterrupt()

    def shutdown(self):
        if not self.serve_forever_started:
            raise AssertionError("shutdown should not run before serve_forever starts")
        self.shutdown_calls += 1

    def server_close(self):
        self.server_close_calls += 1


class LauncherTest(unittest.TestCase):
    def test_server_uses_loopback_and_ephemeral_port(self):
        config = build_application({"StuId": "user", "UISPsw": "pass", "COURSE_IDS": "1,2"})
        self.assertEqual(config.host, "127.0.0.1")
        self.assertEqual(config.port, 0)
        self.assertEqual(config.application.course_ids, ("1", "2"))

    def test_missing_credentials_returns_configuration_error(self):
        with self.assertRaisesRegex(ValueError, "StuId and UISPsw"):
            build_application({})

    def test_open_edge_prefers_installed_edge_before_browser_fallback(self):
        with patch.dict(os.environ, {"ProgramFiles(x86)": r"C:\PFx86", "ProgramFiles": r"C:\PF"}, clear=False), \
             patch("live_player.cli.Path.is_file", side_effect=[True]), \
             patch("live_player.cli.subprocess.Popen") as popen, \
             patch("live_player.cli.webbrowser.open") as browser_open:
            open_edge("http://127.0.0.1:1/?bootstrap=token")

        popen.assert_called_once_with([
            r"C:\PFx86\Microsoft\Edge\Application\msedge.exe",
            "http://127.0.0.1:1/?bootstrap=token",
        ])
        browser_open.assert_not_called()

    def test_open_edge_falls_back_when_edge_is_missing(self):
        with patch.dict(os.environ, {"ProgramFiles(x86)": r"C:\PFx86", "ProgramFiles": r"C:\PF"}, clear=False), \
             patch("live_player.cli.Path.is_file", return_value=False), \
             patch("live_player.cli.subprocess.Popen") as popen, \
             patch("live_player.cli.webbrowser.open") as browser_open:
            open_edge("http://127.0.0.1:1/?bootstrap=token")

        popen.assert_not_called()
        browser_open.assert_called_once_with("http://127.0.0.1:1/?bootstrap=token")

    def test_launch_player_cleans_up_on_keyboard_interrupt(self):
        app = FakeApplication()
        config = LauncherConfig(
            application=app,
            host="127.0.0.1",
            port=0,
            bootstrap_token="bootstrap-token",
            course_ids=(),
        )
        server = FakeServer()

        with patch("live_player.cli.serve", return_value=server) as serve_fn, \
             patch("live_player.cli.open_edge") as browser_open:
            launch_player(config)

        serve_fn.assert_called_once_with(app, host="127.0.0.1", port=0)
        browser_open.assert_called_once_with("http://127.0.0.1:53123/?bootstrap=bootstrap-token")
        self.assertEqual(server.shutdown_calls, 1)
        self.assertEqual(server.server_close_calls, 1)
        self.assertEqual(app.shutdown_calls, 1)

    def test_launch_player_closes_server_when_browser_open_fails(self):
        app = FakeApplication()
        config = LauncherConfig(
            application=app,
            host="127.0.0.1",
            port=0,
            bootstrap_token="bootstrap-token",
            course_ids=(),
        )
        server = FakeServer(stop_after_launch=False)

        with patch("live_player.cli.serve", return_value=server), \
             patch("live_player.cli.open_edge", side_effect=RuntimeError("browser failed")):
            with self.assertRaisesRegex(RuntimeError, "browser failed"):
                launch_player(config)

        self.assertEqual(server.shutdown_calls, 0)
        self.assertEqual(server.server_close_calls, 1)
        self.assertEqual(app.shutdown_calls, 1)

    def test_launch_player_pages_uses_fragment_pairing_url(self):
        app = FakeApplication()
        config = LauncherConfig(
            application=app,
            host="127.0.0.1",
            port=0,
            bootstrap_token="bootstrap-token",
            course_ids=(),
        )
        server = FakeServer()

        with patch("live_player.cli.serve", return_value=server), \
             patch("live_player.cli.open_edge") as browser_open:
            launch_player(config, pages=True)

        url = browser_open.call_args.args[0]
        self.assertEqual(
            url,
            "https://johnxmj.github.io/Fudan_iCourse_Subscriber/live/"
            "#bridge=http%3A%2F%2F127.0.0.1%3A53123&bootstrap=bootstrap-token",
        )
        self.assertNotIn("?", url.split("#", 1)[0])
        self.assertEqual(server.shutdown_calls, 1)
        self.assertEqual(server.server_close_calls, 1)
        self.assertEqual(app.shutdown_calls, 1)
