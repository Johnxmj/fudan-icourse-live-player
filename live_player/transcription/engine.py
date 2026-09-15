"""Lazy, local adapter around faster-whisper inference."""

import inspect
import math
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


class PreparationCancelled(RuntimeError):
    """A cooperative model download was cancelled before construction."""


def _download_progress_class(cancel_event, on_progress):
    """Adapt huggingface-hub's tqdm hook to safe cooperative callbacks."""
    from tqdm.auto import tqdm

    class DownloadProgress(tqdm):
        def _check_cancelled(self):
            if cancel_event is not None and cancel_event.is_set():
                raise PreparationCancelled("model download cancelled")

        def _report_progress(self):
            if not callable(on_progress):
                return
            total = self.total
            if not isinstance(total, (int, float)) or not math.isfinite(total) or total <= 0:
                return
            on_progress(self.n * 100 / total)

        def __init__(self, *args, **kwargs):
            self._check_cancelled()
            super().__init__(*args, **kwargs)
            self._report_progress()

        def update(self, n=1):
            self._check_cancelled()
            result = super().update(n)
            self._report_progress()
            self._check_cancelled()
            return result

    return DownloadProgress


def _default_model_resolver(repository, *, local_files_only, cancel_event=None, on_progress=None):
    """Resolve a model directory, preferring the existing local cache."""
    from huggingface_hub import snapshot_download

    if local_files_only:
        return snapshot_download(repository, local_files_only=True)
    return snapshot_download(
        repository,
        local_files_only=False,
        tqdm_class=_download_progress_class(cancel_event, on_progress),
    )


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

    def prepare(self, options, on_state, cancel_event=None, on_progress=None):
        """Prepare one model, optionally reporting/cancelling a cache-miss download."""
        self._get_model(options, on_state, cancel_event, on_progress)

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

    def _get_model(self, options, on_state, cancel_event=None, on_progress=None):
        self._validate_options(options)
        if not callable(on_state):
            raise ValueError("state callback must be callable")
        with self._lock:
            self._raise_if_cancelled(cancel_event)
            cached = self._models.get(options.model)
            if cached is not None:
                model, device = cached
                self.loaded_model = options.model
                self.device = device
                return model

            model_path = self._resolve_model(options.model, on_state, cancel_event, on_progress)
            self._raise_if_cancelled(cancel_event)
            on_state("loading-model")
            model, device = self._construct_model(options.model, model_path)
            self._models[options.model] = (model, device)
            self.loaded_model = options.model
            self.device = device
            return model

    def _resolve_model(self, model_name, on_state, cancel_event, on_progress):
        repository = f"Systran/faster-whisper-{model_name}"
        try:
            return self._resolve(repository, local_files_only=True)
        except FileNotFoundError:
            on_state("downloading-model")
            return self._resolve(
                repository,
                local_files_only=False,
                cancel_event=cancel_event,
                on_progress=on_progress,
            )

    def _resolve(self, repository, *, local_files_only, cancel_event=None, on_progress=None):
        resolver = self._model_resolver
        callback = resolver.resolve if hasattr(resolver, "resolve") else resolver
        kwargs = {"local_files_only": local_files_only}
        if not local_files_only:
            optional = {"cancel_event": cancel_event, "on_progress": on_progress}
            kwargs.update(_supported_keywords(callback, optional))
        return callback(repository, **kwargs)

    @staticmethod
    def _raise_if_cancelled(cancel_event):
        if cancel_event is not None and cancel_event.is_set():
            raise PreparationCancelled("model preparation cancelled")

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


def _supported_keywords(callback, values):
    """Keep existing two-argument resolver fakes and integrations compatible."""
    try:
        parameters = inspect.signature(callback).parameters.values()
    except (TypeError, ValueError):
        return {}
    accepts_any = any(parameter.kind is parameter.VAR_KEYWORD for parameter in parameters)
    names = {parameter.name for parameter in parameters}
    return {name: value for name, value in values.items() if accepts_any or name in names}
