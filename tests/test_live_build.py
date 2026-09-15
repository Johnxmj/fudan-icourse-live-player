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

    def test_build_collects_whisper_runtime_without_model_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            command = build_windows.build_pyinstaller_command(
                Path(directory) / "dist", Path(directory) / "work", Path(directory) / "spec"
            )

        self.assertGreaterEqual(command.count("--collect-all"), 4)
        for package in ("faster_whisper", "ctranslate2", "av", "imageio_ffmpeg"):
            self.assertIn(package, command)
        self.assertFalse(any("models--" in value.lower() or ".cache" in value.lower() for value in command))

    def test_archive_audit_rejects_model_transcript_audio_and_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "native.zip"
            import zipfile
            with zipfile.ZipFile(archive, "w") as package:
                package.writestr("Fudan/models--Systran/model.bin", "fixture")
                package.writestr("Fudan/transcripts/live.md", "fixture")
                package.writestr("Fudan/audio/lecture.wav", "fixture")
                package.writestr("Fudan/libavcodec.dll", "runtime")
                package.writestr("Fudan/_internal/av/audio/runtime.py", "runtime")
                package.writestr("Fudan/_internal/cv2/data/cascade.xml", "runtime")

            denied = build_windows.audit_archive(archive)

        self.assertEqual(
            denied,
            ["Fudan/models--Systran/model.bin", "Fudan/transcripts/live.md", "Fudan/audio/lecture.wav"],
        )


if __name__ == "__main__":
    unittest.main()
