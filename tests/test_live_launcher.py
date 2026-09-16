import io
import unittest
from unittest.mock import Mock, patch

from live_player import cli


class InteractiveLauncherTest(unittest.TestCase):
    def test_help_is_portable_to_legacy_windows_console_encodings(self):
        stream = io.TextIOWrapper(io.BytesIO(), encoding="cp1252")
        try:
            with patch("live_player.cli.sys.stdout", stream), self.assertRaises(SystemExit) as raised:
                cli.main(["--help"], env={})
            stream.flush()
            output = stream.buffer.getvalue().decode("cp1252")
        finally:
            stream.close()
        self.assertEqual(raised.exception.code, 0)
        self.assertIn("prompt for student ID, password, and courses", output)
        self.assertIn("search by course name or teacher", output)
        self.assertIn("course selection", output)

    def test_main_uses_ascii_fallback_when_stdout_cannot_encode_status(self):
        env = {"StuId": "student", "UISPsw": "secret", "COURSE_IDS": "1"}
        stream = io.TextIOWrapper(io.BytesIO(), encoding="cp1252")
        try:
            with patch("live_player.cli.sys.stdout", stream), \
                    patch("live_player.cli.launch_player"):
                self.assertEqual(cli.main(["--port", "4310"], env=env), 0)
            stream.flush()
            output = stream.buffer.getvalue().decode("cp1252")
        finally:
            stream.close()
        self.assertIn("Player will open in your browser.", output)
        self.assertNotIn("播放器", output)
        self.assertNotIn("Traceback", output)

    def test_main_preserves_chinese_status_when_stdout_supports_utf8(self):
        env = {"StuId": "student", "UISPsw": "secret", "COURSE_IDS": "1"}
        stream = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")
        try:
            with patch("live_player.cli.sys.stdout", stream), \
                    patch("live_player.cli.launch_player"):
                self.assertEqual(cli.main(["--port", "4310"], env=env), 0)
            stream.flush()
            output = stream.buffer.getvalue().decode("utf-8")
        finally:
            stream.close()
        self.assertIn("播放器将在浏览器中打开", output)

    def test_main_passes_only_valid_explicit_loopback_ports_to_launcher(self):
        env = {"StuId": "student", "UISPsw": "secret", "COURSE_IDS": "1"}
        with patch("live_player.cli.launch_player") as launch:
            self.assertEqual(cli.main(["--port", "4310"], env=env), 0)
        self.assertEqual(launch.call_args.args[0].host, "127.0.0.1")
        self.assertEqual(launch.call_args.args[0].port, 4310)

        with patch("live_player.cli.sys.stderr") as stderr:
            self.assertEqual(cli.main(["--port", "65536"], env=env), 2)
        self.assertIn("port must be between 0 and 65535", "".join(str(call) for call in stderr.write.call_args_list))

    def test_interactive_login_does_not_modify_environment_or_echo_password(self):
        original = {"OTHER": "kept"}
        ask = Mock(side_effect=[" 20260001 "])
        secret = Mock(return_value="private password")
        result = cli.prompt_environment(original, input_fn=ask, password_fn=secret)
        self.assertEqual(original, {"OTHER": "kept"})
        self.assertEqual(result["StuId"], "20260001")
        self.assertEqual(result["UISPsw"], "private password")
        self.assertNotIn("COURSE_IDS", result)
        self.assertEqual(secret.call_count, 1)
        self.assertNotIn("private password", str(ask.call_args_list))

    def test_interactive_launcher_preserves_existing_credentials(self):
        ask = Mock(side_effect=AssertionError("unexpected prompt"))
        env = {"StuId": "student", "UISPsw": "secret", "COURSE_IDS": "1"}
        self.assertEqual(cli.prompt_environment(env, input_fn=ask, password_fn=ask), env)

    def test_missing_credentials_produces_actionable_message_without_traceback(self):
        with patch("live_player.cli.sys.stderr") as stderr:
            result = cli.main([], env={})
        self.assertEqual(result, 2)
        self.assertIn("--interactive", "".join(str(c) for c in stderr.write.call_args_list))

    def test_mac_prefers_installed_chrome(self):
        with patch("live_player.cli.sys.platform", "darwin"), \
                patch("live_player.cli.Path.is_dir", return_value=True), \
                patch("live_player.cli.subprocess.Popen") as launch:
            cli.open_edge("http://127.0.0.1:123/#bootstrap=example")
        launch.assert_called_once_with(["open", "-a", "Google Chrome", "http://127.0.0.1:123/#bootstrap=example"])


if __name__ == "__main__":
    unittest.main()
