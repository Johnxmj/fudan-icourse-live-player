"""Lazy, local adapter around faster-whisper inference."""

import threading

from live_player.transcription.models import (
    ALLOWED_LANGUAGES,
    ALLOWED_MODELS,
    TranscriptSlice,
)


def _default_model_factory(model_path, *, device, compute_type):
    """Construct only after a caller explicitly prepares transcription."""
    from faster_whisper import WhisperModel

    return WhisperModel(model_path, device=device, compute_type=compute_type)


def _default_model_resolver(repository, *, local_files_only):
    """Resolve a model directory, preferring the existing local cache."""
    from huggingface_hub import snapshot_download

    return snapshot_download(repository, local_files_only=local_files_only)


def _default_cuda_detector():
    """Ask CTranslate2 about CUDA only when a model is explicitly requested."""
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count() > 0
    except (ImportError, AttributeError, OSError):
        return False


class WhisperEngine:
    """Load allowed faster-whisper models on demand and retain them in memory."""

    def __init__(self, model_factory=None, model_resolver=None, cuda_detector=None):
        self._model_factory = model_factory or _default_model_factory
        self._model_resolver = model_resolver or _default_model_resolver
        self._cuda_detector = cuda_detector or _default_cuda_detector
        self._models = {}
        self.loaded_model = None
        self.device = None
        self._lock = threading.RLock()

    def capabilities(self):
        return {
            "available": True,
            "models": list(ALLOWED_MODELS),
            "default_model": "base",
            "default_language": "zh",
            "loaded_model": self.loaded_model,
            "device": self.device,
        }

    def prepare(self, options, on_state):
        self._get_model(options, on_state)

    def transcribe(self, samples, sample_rate, options, initial_prompt=""):
        del sample_rate
        model = self._get_model(options, lambda _state: None)
        if not isinstance(initial_prompt, str):
            raise ValueError("initial prompt must be a string")
        segments, _info = model.transcribe(
            samples,
            language=None if options.language == "auto" else options.language,
            vad_filter=True,
            initial_prompt=initial_prompt[:500],
            condition_on_previous_text=False,
        )
        return [
            TranscriptSlice(segment.start, segment.end, text)
            for segment in segments
            if (text := segment.text.strip())
        ]

    def _get_model(self, options, on_state):
        self._validate_options(options)
        if not callable(on_state):
            raise ValueError("state callback must be callable")
        with self._lock:
            cached = self._models.get(options.model)
            if cached is not None:
                model, device = cached
                self.loaded_model = options.model
                self.device = device
                return model

            model_path = self._resolve_model(options.model, on_state)
            on_state("loading-model")
            model, device = self._construct_model(options.model, model_path)
            self._models[options.model] = (model, device)
            self.loaded_model = options.model
            self.device = device
            return model

    def _resolve_model(self, model_name, on_state):
        repository = f"Systran/faster-whisper-{model_name}"
        try:
            return self._resolve(repository, local_files_only=True)
        except FileNotFoundError:
            on_state("downloading-model")
            return self._resolve(repository, local_files_only=False)

    def _resolve(self, repository, *, local_files_only):
        resolver = self._model_resolver
        if hasattr(resolver, "resolve"):
            return resolver.resolve(repository, local_files_only=local_files_only)
        return resolver(repository, local_files_only=local_files_only)

    def _construct_model(self, model_name, model_path):
        if self._cuda_detector():
            try:
                return (
                    self._model_factory(
                        model_path, device="cuda", compute_type="float16"
                    ),
                    "cuda",
                )
            except Exception:
                pass
        return (
            self._model_factory(model_path, device="cpu", compute_type="int8"),
            "cpu",
        )

    @staticmethod
    def _validate_options(options):
        if (
            options.model not in ALLOWED_MODELS
            or options.language not in ALLOWED_LANGUAGES
        ):
            raise ValueError("unsupported transcription options")
