import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import build_windows


class NativeBuildTest(unittest.TestCase):
    def test_build_invokes_packager_and_packages_only_generated_app(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "dist"
            calls = []

            def package(command, **kwargs):
                calls.append(command)
                app = output / "Fudan-iCourse-Live"
                app.mkdir(parents=True)
                (app / "Fudan-iCourse-Live").write_text("executable fixture")

            with patch("scripts.build_windows.subprocess.run", side_effect=package):
                archive = build_windows.build(output)
            self.assertTrue(archive.is_file())
            self.assertIn("PyInstaller", calls[0])
            self.assertIn("--add-data", calls[0])
            self.assertNotIn(".env", " ".join(calls[0]))

    def test_build_failure_is_not_reported_as_success(self):
        import subprocess
        with tempfile.TemporaryDirectory() as directory, \
                patch("scripts.build_windows.subprocess.run", side_effect=subprocess.CalledProcessError(1, "packager")):
            with self.assertRaises(subprocess.CalledProcessError):
                build_windows.build(Path(directory))


if __name__ == "__main__":
    unittest.main()
