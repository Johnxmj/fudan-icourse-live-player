import unittest
from unittest.mock import Mock, patch

from live_player import cli


class InteractiveLauncherTest(unittest.TestCase):
    def test_interactive_login_does_not_modify_environment_or_echo_password(self):
        original = {"OTHER": "kept"}
        ask = Mock(side_effect=[" 20260001 ", "123, 456"])
        secret = Mock(return_value="private password")
        result = cli.prompt_environment(original, input_fn=ask, password_fn=secret)
        self.assertEqual(original, {"OTHER": "kept"})
        self.assertEqual(result["StuId"], "20260001")
        self.assertEqual(result["UISPsw"], "private password")
        self.assertEqual(result["COURSE_IDS"], "123, 456")
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
