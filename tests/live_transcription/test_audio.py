"""Pipe-only ffmpeg reader tests."""

import subprocess
import threading
import unittest
from unittest.mock import patch

from live_player.transcription.audio import (
    AudioStreamError,
    FfmpegPcmReader,
    build_ffmpeg_command,
    resolve_ffmpeg_executable,
)


def loopback_url():
    return "http://127.0.0.1:4310/media/course1/sub1/teacher_audio/manifest.m3u8?media_token=opaque"


class FakeStream:
    def __init__(self, chunks=()):
        self._chunks = list(chunks)

    def read(self, _size=-1):
        return self._chunks.pop(0) if self._chunks else b""


class FakeProcess:
    def __init__(self, stdout_chunks=(), stderr_chunks=(), returncode=0):
        self.stdout = FakeStream(stdout_chunks)
        self.stderr = FakeStream(stderr_chunks)
        self.returncode = returncode
        self.terminate_calls = 0
        self.kill_calls = 0
        self.wait_calls = []

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminate_calls += 1

    def kill(self):
        self.kill_calls += 1

    def wait(self, timeout=None):
        self.wait_calls.append(timeout)
        return self.returncode


class BlockingUntilTerminatedStream:
    def __init__(self):
        self.read_started = threading.Event()
        self.released = threading.Event()

    def read(self, _size=-1):
        self.read_started.set()
        self.released.wait()
        return b""


class BlockingProcess(FakeProcess):
    def __init__(self):
        super().__init__()
        self.stdout = BlockingUntilTerminatedStream()

    def terminate(self):
        super().terminate()
        self.stdout.released.set()


class FfmpegPcmReaderTest(unittest.TestCase):
    def test_resolver_prefers_wheel_ffmpeg_before_path(self):
        with patch("live_player.transcription.audio.imageio_ffmpeg.get_ffmpeg_exe", return_value="C:/wheel/ffmpeg.exe"), \
                patch("live_player.transcription.audio.Path.is_file", return_value=True), \
                patch("live_player.transcription.audio.shutil.which") as which:
            self.assertEqual(resolve_ffmpeg_executable(), "C:/wheel/ffmpeg.exe")
        which.assert_not_called()

    def test_resolver_reports_a_clear_error_without_wheel_or_path_ffmpeg(self):
        with patch("live_player.transcription.audio.imageio_ffmpeg.get_ffmpeg_exe", return_value=""), \
                patch("live_player.transcription.audio.shutil.which", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "未找到 ffmpeg，请安装后重新启动本地助手。"):
                resolve_ffmpeg_executable()

    def test_resolver_falls_back_to_path_when_wheel_lookup_fails(self):
        with patch("live_player.transcription.audio.imageio_ffmpeg.get_ffmpeg_exe", side_effect=RuntimeError("missing")), \
                patch("live_player.transcription.audio.shutil.which", return_value="C:/system/ffmpeg.exe"), \
                patch("live_player.transcription.audio.Path.is_file", return_value=True):
            self.assertEqual(resolve_ffmpeg_executable(), "C:/system/ffmpeg.exe")

    def test_ffmpeg_command_is_pcm_pipe_only(self):
        command = build_ffmpeg_command(loopback_url())

        self.assertEqual(
            command[-8:],
            ["-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"],
        )
        self.assertNotIn("-y", command)
        self.assertFalse(any(value.endswith((".wav", ".mp3", ".pcm")) for value in command))

    def test_reader_terminates_child_when_cancelled(self):
        process = FakeProcess(stdout_chunks=[b"a" * 3200])
        stop = threading.Event()
        reader = FfmpegPcmReader(process_factory=lambda *_: process)
        iterator = reader.frames(loopback_url(), stop)

        self.assertEqual(next(iterator), b"a" * 3200)
        stop.set()
        iterator.close()

        self.assertEqual(process.terminate_calls, 1)
        self.assertEqual(process.wait_calls, [5])

    def test_reader_cancels_while_stdout_read_is_stalled(self):
        process = BlockingProcess()
        stop = threading.Event()
        iterator = FfmpegPcmReader(process_factory=lambda *_: process).frames(loopback_url(), stop)
        finished = threading.Event()

        def consume():
            try:
                next(iterator)
            except StopIteration:
                pass
            finally:
                finished.set()

        worker = threading.Thread(target=consume)
        worker.start()
        try:
            self.assertTrue(process.stdout.read_started.wait(1))
            stop.set()
            self.assertTrue(finished.wait(1))
        finally:
            process.stdout.released.set()
            worker.join(1)

        self.assertFalse(worker.is_alive())
        self.assertEqual(process.terminate_calls, 1)

    def test_reader_rejects_urls_outside_the_local_media_route(self):
        unsafe_urls = (
            "https://127.0.0.1:4310/media/course1/sub1/teacher/manifest.m3u8",
            "http://localhost:4310/media/course1/sub1/teacher/manifest.m3u8",
            "http://127.0.0.1:0/media/course1/sub1/teacher/manifest.m3u8",
            "http://user:password@127.0.0.1:4310/media/course1/sub1/teacher/manifest.m3u8",
            "http://127.0.0.1:4310/media/course1/../teacher/manifest.m3u8",
            "http://127.0.0.1:4310/media/course1/sub1/not-a-view/manifest.m3u8",
            "http://127.0.0.1:4310/media/course1/sub1/teacher/manifest.m3u8#secret",
        )
        reader = FfmpegPcmReader(process_factory=lambda *_: self.fail("must not start ffmpeg"))

        for url in unsafe_urls:
            with self.subTest(url=url), self.assertRaises(ValueError):
                next(reader.frames(url, threading.Event()))

    def test_reader_uses_only_pipe_standard_streams(self):
        process = FakeProcess()
        with patch("live_player.transcription.audio.subprocess.Popen", return_value=process) as start:
            list(FfmpegPcmReader().frames(loopback_url(), threading.Event()))

        self.assertEqual(start.call_count, 1)
        self.assertIs(start.call_args.kwargs["stdin"], subprocess.DEVNULL)
        self.assertIs(start.call_args.kwargs["stdout"], subprocess.PIPE)
        self.assertIs(start.call_args.kwargs["stderr"], subprocess.PIPE)

    def test_reader_error_is_sanitized(self):
        url = loopback_url()
        process = FakeProcess(stderr_chunks=[b"failed " + url.encode()], returncode=17)
        reader = FfmpegPcmReader(process_factory=lambda *_: process)

        with self.assertRaisesRegex(AudioStreamError, "code 17") as raised:
            list(reader.frames(url, threading.Event()))

        self.assertNotIn(url, str(raised.exception))


if __name__ == "__main__":
    unittest.main()
