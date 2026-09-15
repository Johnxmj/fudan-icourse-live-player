"""Lazy Whisper engine tests using fully offline dependency fakes."""

from dataclasses import replace
import unittest

import numpy as np

from live_player.transcription.engine import WhisperEngine
from live_player.transcription.models import TranscriptSlice, TranscriptionOptions


def defaults():
    return TranscriptionOptions.from_payload({"course_id": "37142", "sub_id": "659200"})


class FakeSegment:
    def __init__(self, start, end, text):
        self.start = start
        self.end = end
        self.text = text


class FakeWhisperModel:
    def __init__(self):
        self.kwargs = None

    def transcribe(self, samples, **kwargs):
        self.kwargs = kwargs
        return (
            [
                FakeSegment(0.0, 1.0, " 测试 "),
                FakeSegment(1.0, 1.5, "   "),
            ],
            object(),
        )


class FakeWhisperFactory:
    def __init__(self, cuda_fails=False):
        self.cuda_fails = cuda_fails
        self.calls = []
        self.model = FakeWhisperModel()

    def __call__(self, model, *, device, compute_type):
        self.calls.append((model, device, compute_type))
        if self.cuda_fails and device == "cuda":
            raise RuntimeError("CUDA unavailable")
        return self.model


class FakeModelResolver:
    def __init__(self, cached):
        self.cached = cached
        self.calls = []

    def resolve(self, repository, *, local_files_only):
        self.calls.append((repository, local_files_only))
        if local_files_only and not self.cached:
            raise FileNotFoundError(repository)
        return repository.rsplit("-", 1)[-1]


class WhisperEngineTest(unittest.TestCase):
    def test_engine_loads_base_once_and_uses_cpu_int8_fallback(self):
        factory = FakeWhisperFactory(cuda_fails=True)
        engine = WhisperEngine(
            model_factory=factory,
            model_resolver=FakeModelResolver(cached=True),
            cuda_detector=lambda: True,
        )

        engine.prepare(defaults(), lambda state: None)
        first = engine.transcribe(np.zeros(16000, dtype=np.float32), 16000, defaults())
        second = engine.transcribe(np.zeros(16000, dtype=np.float32), 16000, defaults())

        self.assertEqual(
            factory.calls,
            [("base", "cuda", "float16"), ("base", "cpu", "int8")],
        )
        self.assertEqual(first, [TranscriptSlice(0.0, 1.0, "测试")])
        self.assertEqual(second, [TranscriptSlice(0.0, 1.0, "测试")])
        self.assertEqual(engine.capabilities()["loaded_model"], "base")
        self.assertEqual(engine.capabilities()["device"], "cpu")

    def test_engine_passes_vad_and_language_options(self):
        factory = FakeWhisperFactory()
        engine = WhisperEngine(
            model_factory=factory,
            model_resolver=FakeModelResolver(cached=True),
            cuda_detector=lambda: False,
        )
        samples = np.zeros(16000, dtype=np.float32)

        engine.transcribe(
            samples,
            16000,
            replace(defaults(), language="auto"),
            initial_prompt="上一句",
        )

        self.assertEqual(
            factory.model.kwargs,
            {
                "language": None,
                "vad_filter": True,
                "initial_prompt": "上一句",
                "condition_on_previous_text": False,
            },
        )

    def test_prepare_downloads_only_after_a_cache_miss_and_emits_states(self):
        resolver = FakeModelResolver(cached=False)
        engine = WhisperEngine(
            model_factory=FakeWhisperFactory(),
            model_resolver=resolver,
            cuda_detector=lambda: False,
        )
        states = []

        engine.prepare(defaults(), states.append)

        self.assertEqual(
            resolver.calls,
            [
                ("Systran/faster-whisper-base", True),
                ("Systran/faster-whisper-base", False),
            ],
        )
        self.assertEqual(states, ["downloading-model", "loading-model"])

    def test_engine_bounds_prompt_and_excludes_blank_segments(self):
        factory = FakeWhisperFactory()
        engine = WhisperEngine(
            model_factory=factory,
            model_resolver=FakeModelResolver(cached=True),
            cuda_detector=lambda: False,
        )

        result = engine.transcribe(
            np.zeros(16000, dtype=np.float32),
            16000,
            defaults(),
            initial_prompt="x" * 501,
        )

        self.assertEqual(result, [TranscriptSlice(0.0, 1.0, "测试")])
        self.assertEqual(factory.model.kwargs["initial_prompt"], "x" * 500)
