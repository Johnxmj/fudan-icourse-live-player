"""Validated transcription request options and sanitized event records."""

from dataclasses import dataclass
import math
import re


SAFE_ID = re.compile(r"^[A-Za-z0-9]{1,64}$")
ALLOWED_MODELS = ("tiny", "base", "small")
ALLOWED_LANGUAGES = ("zh", "auto")
MAX_TRANSCRIPT_TEXT_LENGTH = 8000


@dataclass(frozen=True)
class TranscriptionOptions:
    course_id: str
    sub_id: str
    model: str = "base"
    language: str = "zh"

    @classmethod
    def from_payload(cls, payload):
        if not isinstance(payload, dict) or set(payload) - {
            "course_id",
            "sub_id",
            "model",
            "language",
        }:
            raise ValueError("invalid transcription options")
        course_id, sub_id = payload.get("course_id"), payload.get("sub_id")
        model, language = payload.get("model", "base"), payload.get("language", "zh")
        if not all(
            isinstance(value, str) and SAFE_ID.fullmatch(value)
            for value in (course_id, sub_id)
        ):
            raise ValueError("invalid transcription identifiers")
        if model not in ALLOWED_MODELS or language not in ALLOWED_LANGUAGES:
            raise ValueError("unsupported transcription options")
        return cls(course_id, sub_id, model, language)


@dataclass(frozen=True)
class TranscriptSlice:
    start: float
    end: float
    text: str


@dataclass(frozen=True)
class TranscriptEvent:
    type: str
    public: dict

    @classmethod
    def segment(cls, start, end, text, private_debug=None):
        del private_debug
        if (
            isinstance(start, bool)
            or isinstance(end, bool)
            or not isinstance(start, (int, float))
            or not isinstance(end, (int, float))
            or not math.isfinite(start)
            or not math.isfinite(end)
            or start < 0
            or end < 0
            or end < start
        ):
            raise ValueError("invalid transcript timestamps")
        if not isinstance(text, str) or len(text) > MAX_TRANSCRIPT_TEXT_LENGTH:
            raise ValueError("invalid transcript text")
        return cls("segment", {"start": start, "end": end, "text": text})

    def as_public_dict(self):
        return {"type": self.type, **self.public}
