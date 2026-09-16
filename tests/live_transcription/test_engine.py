"""Lazy Whisper engine tests using fully offline dependency fakes."""

from dataclasses import replace
import sys
import threading
import types
import unittest
from unittest.mock import patch

import numpy as np

from live_player.transcription.engine import (
    PreparationCancelled,
    WhisperEngine,
    _default_model_resolver,
)
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


class CallbackModelResolver(FakeModelResolver):
    def __init__(self, cached):
        super().__init__(cached)
        self.cancel_events = []
        self.progress_callbacks = []

    def resolve(self, repository, *, local_files_only, cancel_event=None, on_progress=None):
        self.cancel_events.append(cancel_event)
        self.progress_callbacks.append(on_progress)
        return super().resolve(repository, local_files_only=local_files_only)


class FakeTqdm:
    def __init__(self, *args, total=None, **kwargs):
        del args, kwargs
        self.total = total
        self.n = 0

    def update(self, amount=1):
        self.n += amount


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

    def test_prepare_forwards_cancellation_and_download_progress_only_after_cache_miss(self):
        resolver = CallbackModelResolver(cached=False)
        engine = WhisperEngine(
            model_factory=FakeWhisperFactory(),
            model_resolver=resolver,
            cuda_detector=lambda: False,
        )
        cancelled = threading.Event()
        progress = []

        engine.prepare(defaults(), lambda _state: None, cancelled, progress.append)

        self.assertEqual(resolver.calls, [
            ("Systran/faster-whisper-base", True),
            ("Systran/faster-whisper-base", False),
        ])
        self.assertEqual(resolver.cancel_events, [None, cancelled])
        self.assertEqual(resolver.progress_callbacks, [None, progress.append])

    def test_prepare_keeps_legacy_two_argument_resolvers_compatible(self):
        resolver = FakeModelResolver(cached=False)
        engine = WhisperEngine(
            model_factory=FakeWhisperFactory(),
            model_resolver=resolver,
            cuda_detector=lambda: False,
        )

        engine.prepare(defaults(), lambda _state: None, threading.Event(), lambda _progress: None)

        self.assertEqual(len(resolver.calls), 2)

    def test_default_download_resolver_reports_progress_through_huggingface_tqdm_hook(self):
        calls, progress = [], []
        hub = types.ModuleType("huggingface_hub")
        def snapshot_download(repository, **kwargs):
            calls.append((repository, kwargs))
            meter = kwargs["tqdm_class"](total=100)
            meter.update(25)
            meter.update(75)
            return "cached-model"
        hub.snapshot_download = snapshot_download
        tqdm_package, tqdm_auto = types.ModuleType("tqdm"), types.ModuleType("tqdm.auto")
        tqdm_auto.tqdm = FakeTqdm
        tqdm_package.auto = tqdm_auto

        with patch.dict(sys.modules, {"huggingface_hub": hub, "tqdm": tqdm_package, "tqdm.auto": tqdm_auto}):
            result = _default_model_resolver(
                "Systran/faster-whisper-base",
                local_files_only=False,
                cancel_event=threading.Event(),
                on_progress=progress.append,
            )

        self.assertEqual(result, "cached-model")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], "Systran/faster-whisper-base")
        self.assertEqual(calls[0][1]["local_files_only"], False)
        self.assertTrue(issubclass(calls[0][1]["tqdm_class"], FakeTqdm))
        self.assertEqual(progress, [0.0, 25.0, 100.0])

    def test_default_download_resolver_aborts_before_huggingface_progress_starts(self):
        hub = types.ModuleType("huggingface_hub")
        hub.snapshot_download = lambda _repository, **kwargs: kwargs["tqdm_class"](total=100)
        tqdm_package, tqdm_auto = types.ModuleType("tqdm"), types.ModuleType("tqdm.auto")
        tqdm_auto.tqdm = FakeTqdm
        tqdm_package.auto = tqdm_auto
        cancelled = threading.Event()
        cancelled.set()

        with patch.dict(sys.modules, {"huggingface_hub": hub, "tqdm": tqdm_package, "tqdm.auto": tqdm_auto}):
            with self.assertRaises(PreparationCancelled):
                _default_model_resolver(
                    "Systran/faster-whisper-base",
                    local_files_only=False,
                    cancel_event=cancelled,
                    on_progress=lambda _progress: None,
                )

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
