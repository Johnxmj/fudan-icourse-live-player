import unittest
from pathlib import Path
from scripts.build_windows import is_allowed_artifact_input

ROOT = Path(__file__).resolve().parents[1]

class LiveReleaseWorkflowTest(unittest.TestCase):
    def test_release_workflow_orders_tests_before_packaging(self):
        text = (ROOT / ".github/workflows/release-live-player.yml").read_text(encoding="utf-8")
        self.assertLess(text.index("python -m unittest"), text.index("Build Windows player"))
        self.assertLess(text.index("node --test"), text.index("Package Edge extension"))

    def test_artifact_allowlist_excludes_private_files(self):
        self.assertFalse(is_allowed_artifact_input(Path(".env")))
        self.assertFalse(is_allowed_artifact_input(Path("data/icourse.db")))
        self.assertTrue(is_allowed_artifact_input(Path("live_player/web/index.html")))
