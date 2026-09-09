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
