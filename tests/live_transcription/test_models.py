"""Validation and public-event boundary tests."""

import math
import unittest

from live_player.transcription.models import TranscriptEvent, TranscriptionOptions


class TranscriptionOptionsTest(unittest.TestCase):
    def test_options_apply_product_defaults(self):
        options = TranscriptionOptions.from_payload(
            {"course_id": "37142", "sub_id": "659200"}
        )

        self.assertEqual(options.model, "base")
        self.assertEqual(options.language, "zh")

    def test_options_reject_unknown_model_and_identifiers(self):
        with self.assertRaises(ValueError):
            TranscriptionOptions.from_payload(
                {"course_id": "../x", "sub_id": "1", "model": "large-v3"}
            )

    def test_options_rejects_non_allowlisted_payload_values(self):
        invalid_payloads = (
            {"course_id": True, "sub_id": "1"},
            {"course_id": "1", "sub_id": ["2"]},
            {"course_id": "", "sub_id": "2"},
            {"course_id": "1", "sub_id": "2", "language": "en"},
            {"course_id": "1", "sub_id": "2", "extra": "nope"},
        )

        for payload in invalid_payloads:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                TranscriptionOptions.from_payload(payload)


class TranscriptEventTest(unittest.TestCase):
    def test_public_event_drops_private_fields(self):
        event = TranscriptEvent.segment(1.0, 4.2, "请大家签到", private_debug="secret")

        self.assertEqual(
            event.as_public_dict(),
            {"type": "segment", "start": 1.0, "end": 4.2, "text": "请大家签到"},
        )

    def test_segment_rejects_invalid_timestamps_and_oversized_text(self):
        invalid_timestamps = ((-1.0, 1.0), (0.0, -1.0), (math.inf, 1.0), (0.0, math.nan))

        for start, end in invalid_timestamps:
            with self.subTest(start=start, end=end), self.assertRaises(ValueError):
                TranscriptEvent.segment(start, end, "测试")

        with self.assertRaises(ValueError):
            TranscriptEvent.segment(0.0, 1.0, "字" * 8001)
