import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

class LiveDocsTest(unittest.TestCase):
    def test_docs_state_pages_requires_a_local_helper(self):
        text = (ROOT / "docs/live-player.md").read_text(encoding="utf-8")
        self.assertIn("GitHub Pages 不提供云端代理", text)
        self.assertIn("Edge 扩展或本地播放器", text)

    def test_issue_template_warns_against_private_logs(self):
        text = (ROOT / ".github/ISSUE_TEMPLATE/live-player.yml").read_text(encoding="utf-8")
        for value in ("密码", "Cookie", "签名直播地址"):
            self.assertIn(value, text)

    def test_transcription_docs_explain_local_use_and_privacy(self):
        texts = [
            (ROOT / "README.md").read_text(encoding="utf-8"),
            (ROOT / "docs/live-player.md").read_text(encoding="utf-8"),
        ]
        expected = (
            "faster-whisper", "base", "开始转录", "首次", "下载", "API key",
            "音频", "不保存", "点名、签到、小测、测验、期中、期末、quiz", "Markdown",
            "CPU", "GPU", "本地助手",
        )
        for text in texts:
            for value in expected:
                with self.subTest(document=text[:20], value=value):
                    self.assertIn(value, text)

    def test_documented_default_keywords_exclude_homework_words(self):
        text = (ROOT / "docs/live-player.md").read_text(encoding="utf-8")
        default_line = next(line for line in text.splitlines() if "点名、签到、小测、测验、期中、期末、quiz" in line)
        for forbidden in ("作业", "截止", "提交"):
            self.assertNotIn(forbidden, default_line)
