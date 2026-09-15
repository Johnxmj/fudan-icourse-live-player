"""Bounded PCM segmentation tests."""

import unittest

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
