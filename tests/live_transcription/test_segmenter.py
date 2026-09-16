"""Bounded PCM segmentation tests."""

import unittest
from unittest.mock import patch

import numpy as np

from live_player.transcription.segmenter import PcmSegmenter


def pcm_samples(count, value=1000):
    return np.full(count, value, dtype="<i2").tobytes()


class PcmSegmenterTest(unittest.TestCase):
    def test_segmenter_emits_twelve_second_windows_with_overlap(self):
        segmenter = PcmSegmenter(
            sample_rate=10,
            window_seconds=12,
            overlap_seconds=2,
            max_buffer_seconds=30,
        )

        windows = segmenter.push(pcm_samples(22 * 10))

        self.assertEqual(
            [(item.start, item.end, len(item.samples)) for item in windows],
            [(0.0, 12.0, 120), (10.0, 22.0, 120)],
        )

    def test_segmenter_never_buffers_more_than_limit(self):
        segmenter = PcmSegmenter(
            sample_rate=10,
            window_seconds=12,
            overlap_seconds=2,
            max_buffer_seconds=30,
        )

        segmenter.push(pcm_samples(100 * 10))

        self.assertLessEqual(segmenter.buffered_seconds, 30)
        self.assertGreater(segmenter.dropped_seconds, 0)

    def test_segmenter_crops_huge_input_before_float_conversion(self):
        sample_rate = 10
        max_buffer_seconds = 30
        segmenter = PcmSegmenter(
            sample_rate=sample_rate,
            window_seconds=12,
            overlap_seconds=2,
            max_buffer_seconds=max_buffer_seconds,
        )
        total_samples = 100_000
        maximum_conversion_bytes = sample_rate * max_buffer_seconds * 2
        original_frombuffer = np.frombuffer
        converted_sizes = []

        def bounded_frombuffer(data, *args, **kwargs):
            converted_sizes.append(memoryview(data).nbytes)
            self.assertLessEqual(memoryview(data).nbytes, maximum_conversion_bytes)
            return original_frombuffer(data, *args, **kwargs)

        with patch("live_player.transcription.segmenter.np.frombuffer", side_effect=bounded_frombuffer):
            windows = segmenter.push(bytes(total_samples * 2))

        self.assertTrue(converted_sizes)
        self.assertEqual(windows[0].start, (total_samples - sample_rate * max_buffer_seconds) / sample_rate)
        self.assertGreater(segmenter.dropped_seconds, 0)

    def test_segmenter_converts_signed_pcm_to_float32(self):
        segmenter = PcmSegmenter(sample_rate=10, window_seconds=1, overlap_seconds=0)

        window = segmenter.push(np.array([-32768, 0, 32767] + [0] * 7, dtype="<i2").tobytes())[0]

        self.assertEqual(window.samples.dtype, np.float32)
        np.testing.assert_allclose(window.samples[:3], [-1.0, 0.0, 32767 / 32768])

    def test_flush_emits_only_at_least_half_a_second(self):
        segmenter = PcmSegmenter(sample_rate=10, window_seconds=12, overlap_seconds=2)

        self.assertEqual(segmenter.push(pcm_samples(4)), [])
        self.assertEqual(segmenter.flush(), [])
        segmenter.push(pcm_samples(5))
        windows = segmenter.flush()

        self.assertEqual([(item.start, item.end, len(item.samples)) for item in windows], [(0.4, 0.9, 5)])


if __name__ == "__main__":
    unittest.main()
