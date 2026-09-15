"""Deterministic lifecycle checks; external model and audio work is replaced."""

from dataclasses import replace
import json
import threading
import unittest
from unittest.mock import patch

from live_player.transcription.audio import AudioStreamError
from live_player.transcription.models import TranscriptSlice, TranscriptionOptions
from live_player.transcription.session import (
    TranscriptionBusyError, TranscriptionManager, TranscriptionSourceError,
    _Session,
)


OPTIONS = TranscriptionOptions("123", "456")
SECRET_URL = "http://127.0.0.1:4310/media/FAKESECRET/123/456/teacher/manifest.m3u8"


def decode(frame):
    return json.loads(frame.decode("utf-8").split("data: ", 1)[1])


class Engine:
    def __init__(self, slices=None, prepare_error=None):
        self.slices = slices if slices is not None else [TranscriptSlice(0, 1, "现在签到")]
        self.prepare_error = prepare_error
        self.ready = threading.Event()
        self.prompts = []

    def capabilities(self):
        return {"available": True, "models": ["tiny", "base", "small"],
                "default_model": "base", "default_language": "zh",
                "loaded_model": None, "device": None}

    def prepare(self, options, on_state):
        if self.prepare_error:
            raise self.prepare_error
        self.ready.set()

    def transcribe(self, samples, sample_rate, options, initial_prompt=""):
        self.prompts.append(initial_prompt)
        return self.slices


class Reader:
    def __init__(self, chunks=(), block=False, error=None):
        self.chunks = chunks
        self.block = block
        self.error = error
        self.started = threading.Event()
        self.closed = threading.Event()

    def frames(self, url, stop_event):
        self.started.set()
        try:
            yield from self.chunks
            if self.block:
                stop_event.wait()
            if self.error:
                raise self.error
        finally:
            self.closed.set()


class ManualTimer:
    instances = []

    def __init__(self, interval, function):
        self.interval, self.function = interval, function
        self.cancelled = False
        self.__class__.instances.append(self)

    def start(self):
        pass

    def cancel(self):
        self.cancelled = True

    def fire(self):
        # A callback may already be running when cancel() is called.
        self.function()


class BlockingPrepareEngine(Engine):
    """A legacy two-argument engine fake whose prepare call cannot return yet."""

    def __init__(self, late_error=None):
        super().__init__()
        self.prepare_lock = threading.RLock()
        self.entered = threading.Event()
        self.release = threading.Event()
        self.finished = threading.Event()
        self.late_error = late_error

    def prepare(self, options, on_state):
        with self.prepare_lock:
            self.entered.set()
            self.release.wait()
            try:
                if self.late_error is not None:
                    raise self.late_error
                on_state("loading-model")
                self.ready.set()
            finally:
                self.finished.set()


class SessionTests(unittest.TestCase):
    def setUp(self):
        ManualTimer.instances = []

    def manager(self, engine=None, reader=None, timer_factory=None):
        manager = TranscriptionManager(
            engine=engine or Engine(),
            reader=reader or Reader(),
            timer_factory=timer_factory,
        )
        self.addCleanup(manager.shutdown)
        return manager

    def records(self, manager, session_id):
        return [decode(frame) for frame in manager.events(session_id) if not frame.startswith(b":")]

    def test_rejects_second_session_and_stop_is_idempotent(self):
        manager = self.manager(reader=Reader(block=True))
        first = manager.start(OPTIONS, lambda: SECRET_URL)
        self.assertRegex(first, r"^[A-Za-z0-9_-]{32}$")
        with self.assertRaises(TranscriptionBusyError):
            manager.start(replace(OPTIONS, sub_id="other"), lambda: SECRET_URL)
        self.assertTrue(manager.stop(first))
        self.assertFalse(manager.stop(first))
        self.assertFalse(manager.stop("unknown"))

    def test_states_segments_then_natural_end_in_utf8(self):
        manager = self.manager(reader=Reader([b"\0" * 32000]))
        records = self.records(manager, manager.start(OPTIONS, lambda: SECRET_URL))
        self.assertEqual([r["type"] for r in records], ["state", "state", "segment", "ended"])
        self.assertEqual([r["state"] for r in records if "state" in r],
                         ["connecting-audio", "listening", "live-ended"])
        self.assertEqual(records[2], {"type": "segment", "start": 0, "end": 1, "text": "现在签到"})

    def test_prepare_states_precede_manifest_and_audio(self):
        engine = Engine()
        original = engine.prepare
        def prepare(options, callback):
            callback("downloading-model")
            callback("loading-model")
            original(options, callback)
        engine.prepare = prepare
        def manifest():
            self.assertTrue(engine.ready.is_set())
            return SECRET_URL
        manager = self.manager(engine=engine)
        records = self.records(manager, manager.start(OPTIONS, manifest))
        self.assertEqual([r["state"] for r in records],
                         ["downloading-model", "loading-model", "connecting-audio", "listening", "live-ended"])

    def test_model_failure_is_redacted_and_retryable_before_audio(self):
        reader = Reader()
        engine = Engine(prepare_error=RuntimeError("FAKESECRET " + SECRET_URL))
        manager = self.manager(engine, reader)
        def forbidden():
            self.fail("manifest must not be requested before model preparation")
        records = self.records(manager, manager.start(OPTIONS, forbidden))
        self.assertEqual(records[-2]["code"], "MODEL_UNAVAILABLE")
        self.assertEqual(records[-1]["state"], "error")
        self.assertNotIn("FAKESECRET", json.dumps(records))
        self.assertFalse(reader.started.is_set())
        engine.prepare_error = None
        self.assertEqual(self.records(manager, manager.start(OPTIONS, lambda: SECRET_URL))[-1]["state"], "live-ended")

    def test_source_and_inference_errors_have_stable_codes(self):
        for error, code in [(AudioStreamError(SECRET_URL), "AUDIO_UNAVAILABLE"),
                            (PermissionError(SECRET_URL), "LOGIN_REQUIRED"),
                            (TranscriptionSourceError("LIVE_ENDED"), "LIVE_ENDED")]:
            with self.subTest(code=code):
                manager = self.manager(reader=Reader(error=error))
                records = self.records(manager, manager.start(OPTIONS, lambda: SECRET_URL))
                self.assertIn(code, [r.get("code") for r in records])
                self.assertNotIn("FAKESECRET", json.dumps(records))
        engine = Engine()
        def fail(*args, **kwargs):
            raise RuntimeError(SECRET_URL)
        engine.transcribe = fail
        manager = self.manager(engine, Reader([b"\0" * 32000]))
        records = self.records(manager, manager.start(OPTIONS, lambda: SECRET_URL))
        self.assertEqual(records[-2]["code"], "TRANSCRIPTION_FAILED")
        self.assertNotIn("FAKESECRET", json.dumps(records))

    def test_shutdown_cancels_audio_and_joins_worker(self):
        reader = Reader(block=True)
        manager = self.manager(reader=reader)
        session_id = manager.start(OPTIONS, lambda: SECRET_URL)
        self.assertTrue(reader.started.wait(2))
        manager.shutdown()
        self.assertTrue(reader.closed.is_set())
        self.assertFalse(manager.capabilities()["active"])
        self.assertEqual(self.records(manager, session_id)[-1]["state"], "stopped")

    def test_disconnect_reconnect_cancels_grace_and_replaces_consumer(self):
        manager = self.manager(reader=Reader(block=True), timer_factory=ManualTimer)
        session_id = manager.start(OPTIONS, lambda: SECRET_URL)
        first = manager.events(session_id)
        next(first)
        first.close()
        timer = ManualTimer.instances[-1]
        self.assertEqual(timer.interval, 15)
        second = manager.events(session_id)
        self.assertTrue(timer.cancelled)
        timer.fire()
        self.assertTrue(manager.capabilities()["active"])
        third = manager.events(session_id)
        self.assertEqual(list(second), [])
        third.close()
        ManualTimer.instances[-1].fire()
        self.assertFalse(manager.capabilities()["active"])

    def test_initial_attachment_deadline_stops_unconsumed_session(self):
        reader = Reader(block=True)
        manager = self.manager(reader=reader, timer_factory=ManualTimer)
        session_id = manager.start(OPTIONS, lambda: SECRET_URL)
        deadline = ManualTimer.instances[-1]

        self.assertEqual(deadline.interval, 15)
        self.assertTrue(reader.started.wait(1))
        deadline.fire()

        self.assertTrue(manager._session.done.wait(1))
        self.assertTrue(manager._session.stop_event.is_set())
        self.assertTrue(manager._session.audio_stop.is_set())
        self.assertEqual(self.records(manager, session_id)[-1], {"type": "ended", "state": "stopped"})

    def test_initial_attachment_cancels_deadline_before_stale_callback_runs(self):
        manager = self.manager(reader=Reader(block=True), timer_factory=ManualTimer)
        session_id = manager.start(OPTIONS, lambda: SECRET_URL)
        deadline = ManualTimer.instances[-1]

        stream = manager.events(session_id)

        self.assertTrue(deadline.cancelled)
        deadline.fire()
        self.assertTrue(manager.capabilities()["active"])
        self.assertFalse(manager._session.stop_event.is_set())
        stream.close()

    def test_stale_initial_deadline_cannot_stop_replacement_session(self):
        first_reader = Reader(block=True)
        manager = self.manager(reader=first_reader, timer_factory=ManualTimer)
        first_id = manager.start(OPTIONS, lambda: SECRET_URL)
        first_deadline = ManualTimer.instances[-1]
        first_stream = manager.events(first_id)
        first_stream.close()
        ManualTimer.instances[-1].fire()
        self.assertTrue(manager._session.done.wait(1))

        second_reader = Reader(block=True)
        manager._reader = second_reader
        second_id = manager.start(OPTIONS, lambda: SECRET_URL)
        self.assertNotEqual(first_id, second_id)
        second_stream = manager.events(second_id)

        first_deadline.fire()
        self.assertTrue(manager.capabilities()["active"])
        self.assertFalse(manager._session.stop_event.is_set())
        second_stream.close()

    def test_stop_during_blocked_preparation_finalizes_without_opening_audio(self):
        engine = BlockingPrepareEngine()
        reader = Reader()
        manager = self.manager(engine, reader)
        self.addCleanup(engine.release.set)
        session_id = manager.start(OPTIONS, lambda: self.fail("stopped preparation opened audio"))
        self.assertTrue(engine.entered.wait(1))

        with patch("live_player.transcription.session._JOIN_SECONDS", 0.1):
            self.assertTrue(manager.stop(session_id))

        self.assertTrue(manager._session.done.wait(1))
        self.assertFalse(manager._session.worker.is_alive())
        self.assertFalse(reader.started.is_set())
        engine.release.set()
        self.assertTrue(engine.finished.wait(1))
        self.assertFalse(reader.started.is_set())
        records = self.records(manager, session_id)
        self.assertEqual(records[-1], {"type": "ended", "state": "stopped"})
        self.assertNotIn("loading-model", [record.get("state") for record in records])

    def test_stop_after_preparation_before_manifest_factory_never_acquires_audio_source(self):
        engine = BlockingPrepareEngine()
        manager = self.manager(engine, Reader())
        self.addCleanup(engine.release.set)
        allow_connecting, at_connecting, manifest_called = threading.Event(), threading.Event(), threading.Event()
        session_id = manager.start(OPTIONS, lambda: manifest_called.set() or SECRET_URL)
        self.assertTrue(engine.entered.wait(1))
        session = manager._session
        original_state = session.state
        def pause_before_manifest(state):
            if state == "connecting-audio":
                at_connecting.set()
                allow_connecting.wait()
            return original_state(state)
        session.state = pause_before_manifest

        engine.release.set()
        self.assertTrue(at_connecting.wait(1))
        with patch("live_player.transcription.session._JOIN_SECONDS", 0.1):
            self.assertTrue(manager.stop(session_id))
        allow_connecting.set()

        self.assertTrue(session.done.wait(1))
        self.assertFalse(manifest_called.is_set())
        self.assertEqual(self.records(manager, session_id)[-1], {"type": "ended", "state": "stopped"})

    def test_late_preparation_error_cannot_replace_stopped_terminal_state(self):
        engine = BlockingPrepareEngine(late_error=RuntimeError("FAKESECRET " + SECRET_URL))
        manager = self.manager(engine, Reader())
        self.addCleanup(engine.release.set)
        session_id = manager.start(OPTIONS, lambda: self.fail("late preparation error opened audio"))
        self.assertTrue(engine.entered.wait(1))

        with patch("live_player.transcription.session._JOIN_SECONDS", 0.1):
            manager.stop(session_id)
        engine.release.set()
        self.assertTrue(engine.finished.wait(1))

        records = self.records(manager, session_id)
        self.assertEqual(records[-1], {"type": "ended", "state": "stopped"})
        self.assertNotIn("error", [record["type"] for record in records])
        self.assertNotIn("FAKESECRET", json.dumps(records))

    def test_preparation_base_exception_is_captured_as_a_safe_model_failure(self):
        engine = Engine()
        engine.prepare = lambda options, on_state: (_ for _ in ()).throw(KeyboardInterrupt())
        reader = Reader()
        manager = self.manager(engine, reader)

        records = self.records(manager, manager.start(OPTIONS, lambda: self.fail("failed preparation opened audio")))

        self.assertEqual(records[-2]["code"], "MODEL_UNAVAILABLE")
        self.assertEqual(records[-1]["state"], "error")
        self.assertFalse(reader.started.is_set())

    def test_logically_cancelled_preparation_releases_slot_for_serialized_new_session(self):
        engine = BlockingPrepareEngine()
        first_reader, second_reader = Reader(), Reader(block=True)
        manager = self.manager(engine, first_reader)
        self.addCleanup(engine.release.set)
        first_id = manager.start(OPTIONS, lambda: self.fail("first preparation opened audio"))
        self.assertTrue(engine.entered.wait(1))
        with patch("live_player.transcription.session._JOIN_SECONDS", 0.1):
            manager.stop(first_id)
        self.assertTrue(manager._session.done.wait(1))

        manager._reader = second_reader
        second_id = manager.start(OPTIONS, lambda: SECRET_URL)
        self.assertNotEqual(first_id, second_id)
        engine.release.set()
        self.assertTrue(second_reader.started.wait(1))
        manager.stop(second_id)

    def test_model_progress_is_bounded_monotonic_and_coalesces_to_the_newest_state(self):
        session = _Session(OPTIONS, lambda: SECRET_URL)
        session.state("downloading-model")
        session.progress(float("nan"))
        session.progress(-20)
        session.progress(25)
        session.progress(10)
        session.progress(140)

        self.assertEqual(list(session.queue), [{"type": "state", "state": "downloading-model", "progress": 100}])

    def test_sse_exposes_only_the_sanitized_latest_model_download_progress(self):
        engine = Engine()
        def prepare(options, on_state, cancel_event=None, on_progress=None):
            del options, cancel_event
            on_state("downloading-model")
            on_progress(-10)
            on_progress(25)
            on_progress(float("nan"))
            on_progress(10)
            on_progress(140)
            on_state("loading-model")
            engine.ready.set()
        engine.prepare = prepare
        manager = self.manager(engine, Reader())

        records = self.records(manager, manager.start(OPTIONS, lambda: SECRET_URL))

        self.assertIn({"type": "state", "state": "downloading-model", "progress": 100}, records)
        self.assertNotIn("FAKESECRET", json.dumps(records))

    def test_unknown_event_session_rejected_at_attachment(self):
        manager = self.manager()
        with self.assertRaises(KeyError):
            manager.events("unknown")

    def test_shutdown_during_inference_stops_audio_but_keeps_worker_busy(self):
        entered, release = threading.Event(), threading.Event()
        engine = Engine()
        def infer(*args, **kwargs):
            entered.set()
            release.wait()
            return [TranscriptSlice(0, 1, "must not escape after stop")]
        engine.transcribe = infer
        reader = Reader([b"\0" * (32000 * 12)], block=True)
        manager = self.manager(engine, reader)
        self.addCleanup(release.set)
        session_id = manager.start(OPTIONS, lambda: SECRET_URL)
        self.assertTrue(entered.wait(2))
        with patch("live_player.transcription.session._JOIN_SECONDS", 0.01):
            self.assertTrue(manager.stop(session_id))
            self.assertTrue(reader.closed.wait(1))
            self.assertTrue(manager.capabilities()["active"])
            with self.assertRaises(TranscriptionBusyError):
                manager.start(OPTIONS, lambda: SECRET_URL)
            manager.shutdown()
            self.assertTrue(manager.capabilities()["active"])
        release.set()
        records = self.records(manager, session_id)
        self.assertFalse(manager.capabilities()["active"])
        self.assertNotIn("segment", [r["type"] for r in records])

    def test_cancellation_during_prepare_never_opens_manifest(self):
        entered, release = threading.Event(), threading.Event()
        engine = Engine()
        def prepare(*args):
            entered.set()
            release.wait()
        engine.prepare = prepare
        manager = self.manager(engine)
        self.addCleanup(release.set)
        session_id = manager.start(OPTIONS, lambda: self.fail("cancelled model preparation opened audio"))
        self.assertTrue(entered.wait(2))
        with patch("live_player.transcription.session._JOIN_SECONDS", 0.01):
            manager.stop(session_id)
        release.set()
        self.assertEqual(self.records(manager, session_id)[-1]["state"], "stopped")

    def test_event_queue_backpressure_retains_segments_and_reserves_terminal_slots(self):
        session = _Session(OPTIONS, lambda: SECRET_URL)
        for i in range(254):
            session.emit({"type": "segment", "text": str(i)})
        blocked = threading.Event()
        original_wait = session.condition.wait
        def wait(timeout=None):
            blocked.set()
            return original_wait(timeout)
        session.condition.wait = wait
        thread = threading.Thread(target=session.emit, args=({"type": "segment", "text": "254"},), daemon=True)
        thread.start()
        try:
            self.assertTrue(blocked.wait(1), "the producer must wait when all transcript slots are occupied")
            with session.condition:
                self.assertEqual(len(session.queue), 254)
                self.assertEqual(session.queue.popleft()["text"], "0")
                session.condition.notify_all()
            thread.join(1)
            self.assertFalse(thread.is_alive())
            session.emit({"type": "error", "code": "TRANSCRIPTION_FAILED"})
            session.emit({"type": "ended", "state": "error"})
            self.assertEqual(len(session.queue), 256)
            self.assertEqual([r["text"] for r in session.queue if r["type"] == "segment"],
                             [str(i) for i in range(1, 255)])
        finally:
            session.stop_event.set()
            with session.condition:
                session.condition.notify_all()
            thread.join(1)

    def test_repeated_state_is_coalesced_without_dropping_segments(self):
        session = _Session(OPTIONS, lambda: SECRET_URL)
        for _ in range(1000):
            session.state("listening")
        self.assertEqual(len(session.queue), 1)
        for i in range(253):
            session.emit({"type": "segment", "text": str(i)})
        session.state("delayed")
        self.assertLessEqual(len(session.queue), 254)
        self.assertEqual(sum(r["type"] == "segment" for r in session.queue), 253)

    def test_many_segments_reach_consumer_without_loss(self):
        manager = self.manager(Engine([TranscriptSlice(0, 1, str(i)) for i in range(300)]),
                               Reader([b"\0" * 32000]))
        records = self.records(manager, manager.start(OPTIONS, lambda: SECRET_URL))
        self.assertEqual([r["text"] for r in records if r["type"] == "segment"], [str(i) for i in range(300)])

    def test_heartbeat_deadline_is_five_seconds_even_when_data_is_queued(self):
        manager = self.manager(reader=Reader(block=True))
        session_id = manager.start(OPTIONS, lambda: SECRET_URL)
        with patch("live_player.transcription.session.time.monotonic", return_value=10) as clock:
            stream = manager.events(session_id)
            self.addCleanup(stream.close)
            self.assertTrue(next(stream).startswith(b"event: transcript\n"))
            clock.return_value = 15
            self.assertEqual(next(stream), b": heartbeat\n\n")

    def test_offsets_overlap_dedup_and_context_tail(self):
        engine = Engine()
        results = iter([
            [TranscriptSlice(0, 1, "甲" * 600), TranscriptSlice(10.5, 12, "这是签到。")],
            [TranscriptSlice(0, 3, " 这是 签到！ 新内容"), TranscriptSlice(4, 5, "这是签到")],
        ])
        def infer(samples, sample_rate, options, initial_prompt=""):
            engine.prompts.append(initial_prompt)
            return next(results)
        engine.transcribe = infer
        manager = self.manager(engine, Reader([b"\0" * (32000 * 16)]))
        segments = [r for r in self.records(manager, manager.start(OPTIONS, lambda: SECRET_URL)) if r["type"] == "segment"]
        self.assertEqual([r["text"] for r in segments], ["甲" * 600, "这是签到。", "新内容", "这是签到"])
        self.assertEqual((segments[2]["start"], segments[2]["end"]), (12, 13.5))
        self.assertEqual((segments[3]["start"], segments[3]["end"]), (14.5, 15.5))
        self.assertEqual(engine.prompts, ["", "甲" * 495 + "这是签到。"])

    def test_backlog_reports_delayed_before_next_inference(self):
        entered, release, buffered = threading.Event(), threading.Event(), threading.Event()
        engine = Engine()
        calls = []
        def infer(*args, **kwargs):
            calls.append(1)
            if len(calls) == 1:
                entered.set()
                release.wait()
            return []
        engine.transcribe = infer
        def chunks():
            yield b"\0" * (32000 * 12)
            entered.wait(2)
            for _ in range(20):
                yield b"\0" * 32000
            buffered.set()
        manager = self.manager(engine, Reader(chunks()))
        self.addCleanup(release.set)
        session_id = manager.start(OPTIONS, lambda: SECRET_URL)
        self.assertTrue(entered.wait(2))
        self.assertTrue(buffered.wait(1), "audio must continue being read while inference runs")
        release.set()
        records = self.records(manager, session_id)
        self.assertIn("delayed", [r.get("state") for r in records])
        self.assertTrue(any(r["type"] == "lag" and r["seconds"] > 15 for r in records))

    def test_inference_failure_cancels_open_audio_without_becoming_user_stop(self):
        engine = Engine()
        def fail(*args, **kwargs):
            raise RuntimeError("FAKESECRET " + SECRET_URL)
        engine.transcribe = fail
        reader = Reader([b"\0" * (32000 * 12)], block=True)
        manager = self.manager(engine, reader)
        records = self.records(manager, manager.start(OPTIONS, lambda: SECRET_URL))
        self.assertTrue(reader.closed.is_set())
        self.assertEqual(records[-2]["code"], "TRANSCRIPTION_FAILED")
        self.assertEqual(records[-1]["state"], "error")
        self.assertNotIn("FAKESECRET", json.dumps(records))

    def test_explicit_live_end_flushes_final_audio(self):
        manager = self.manager(reader=Reader([b"\0" * 32000], error=TranscriptionSourceError("LIVE_ENDED")))
        records = self.records(manager, manager.start(OPTIONS, lambda: SECRET_URL))
        self.assertEqual([r["type"] for r in records], ["state", "state", "segment", "ended"])
        self.assertEqual(records[-1]["state"], "live-ended")

    def test_busy_is_retained_until_cancelled_audio_thread_exits(self):
        entered, release = threading.Event(), threading.Event()
        reader = Reader()
        def frames(url, stop_event):
            entered.set()
            release.wait()
            return
            yield
        reader.frames = frames
        manager = self.manager(reader=reader)
        self.addCleanup(release.set)
        session_id = manager.start(OPTIONS, lambda: SECRET_URL)
        self.assertTrue(entered.wait(1))
        with patch("live_player.transcription.session._JOIN_SECONDS", 0.01):
            manager.stop(session_id)
            # Synchronize with the worker reaching its audio join, independently
            # of whether the caller's bounded join timed out just before it.
            worker = manager._session.worker
            worker.join(0.05)
            self.assertTrue(manager.capabilities()["active"])
            with self.assertRaises(TranscriptionBusyError):
                manager.start(OPTIONS, lambda: SECRET_URL)
        release.set()
        self.assertEqual(self.records(manager, session_id)[-1]["state"], "stopped")

    def test_stop_unblocks_full_public_queue_preserving_already_queued_segments(self):
        manager = self.manager(Engine([TranscriptSlice(0, 1, str(i)) for i in range(500)]),
                               Reader([b"\0" * 32000]))
        session_id = manager.start(OPTIONS, lambda: SECRET_URL)
        session = manager._session
        with session.condition:
            self.assertTrue(session.condition.wait_for(lambda: len(session.queue) >= 254, timeout=2))
            queued = [r for r in session.queue if r["type"] == "segment"]
        manager.stop(session_id)
        records = self.records(manager, session_id)
        delivered = [r for r in records if r["type"] == "segment"]
        self.assertEqual(delivered[:len(queued)], queued)
        self.assertEqual(records[-1]["state"], "stopped")

    def test_overlapping_contained_text_is_deduplicated(self):
        engine = Engine()
        results = iter([[TranscriptSlice(10.5, 12, "ＡＢＣ，签到内容")],
                        [TranscriptSlice(0, 0.5, "abc"), TranscriptSlice(0.5, 1, "签到内容")]])
        engine.transcribe = lambda *args, **kwargs: next(results)
        manager = self.manager(engine, Reader([b"\0" * (32000 * 13)]))
        records = self.records(manager, manager.start(OPTIONS, lambda: SECRET_URL))
        self.assertEqual([r["text"] for r in records if r["type"] == "segment"], ["ＡＢＣ，签到内容"])

    def test_finished_iterator_cannot_emit_heartbeat_after_ended(self):
        manager = self.manager()
        session_id = manager.start(OPTIONS, lambda: SECRET_URL)
        with patch("live_player.transcription.session.time.monotonic", return_value=10) as clock:
            stream = manager.events(session_id)
            while decode(next(stream))["type"] != "ended":
                pass
            clock.return_value = 20
            with self.assertRaises(StopIteration):
                next(stream)

    def test_simultaneous_start_has_one_winner(self):
        manager = self.manager(reader=Reader(block=True))
        barrier = threading.Barrier(3)
        results = []
        def start():
            barrier.wait(timeout=2)
            try:
                results.append(manager.start(OPTIONS, lambda: SECRET_URL))
            except TranscriptionBusyError:
                results.append("busy")
        threads = [threading.Thread(target=start) for _ in range(2)]
        for thread in threads:
            thread.start()
        barrier.wait(timeout=2)
        for thread in threads:
            thread.join(2)
            self.assertFalse(thread.is_alive())
        self.assertEqual(len(results), 2)
        self.assertEqual(results.count("busy"), 1)

    def test_cancellation_before_worker_entry_does_not_prepare_model(self):
        engine = Engine()
        manager = self.manager(engine)
        session = _Session(OPTIONS, lambda: self.fail("cancelled worker opened manifest"))
        session.stop_event.set()
        manager._run(session)
        self.assertFalse(engine.ready.is_set())
        self.assertEqual(session.queue[-1]["state"], "stopped")

    def test_untrusted_model_state_callback_does_not_leak(self):
        engine = Engine()
        engine.prepare = lambda options, callback: callback(SECRET_URL)
        manager = self.manager(engine)
        frames = b"".join(manager.events(manager.start(OPTIONS, lambda: SECRET_URL)))
        self.assertNotIn(b"FAKESECRET", frames)

    def test_successful_stop_wins_before_terminal_commit(self):
        for outcome in ("LIVE_ENDED", "AUDIO_UNAVAILABLE"):
            with self.subTest(outcome=outcome):
                at_commit, release_commit = threading.Event(), threading.Event()
                manager = self.manager()
                self.addCleanup(release_commit.set)

                class GatedCondition:
                    """Pause finalization before acquiring its shared lock."""

                    def __init__(self, condition):
                        self.condition = condition
                        self.armed = False

                    def __enter__(self):
                        if self.armed and threading.current_thread() is manager._session.worker:
                            self.armed = False
                            at_commit.set()
                            release_commit.wait()
                        return self.condition.__enter__()

                    def __exit__(self, *args):
                        return self.condition.__exit__(*args)

                    def __getattr__(self, name):
                        return getattr(self.condition, name)

                def session_factory(*args):
                    session = _Session(*args)
                    session.condition = GatedCondition(session.condition)
                    return session

                def manifest():
                    # The source has selected its terminal outcome. The worker
                    # will next acquire the condition to publish that outcome.
                    manager._session.condition.armed = True
                    raise TranscriptionSourceError(outcome)

                with patch("live_player.transcription.session._Session", side_effect=session_factory):
                    session_id = manager.start(OPTIONS, manifest)
                self.assertTrue(at_commit.wait(2))
                with patch("live_player.transcription.session._JOIN_SECONDS", 0):
                    self.assertTrue(manager.stop(session_id))
                release_commit.set()
                records = self.records(manager, session_id)
                self.assertEqual(records[-1], {"type": "ended", "state": "stopped"})
                self.assertNotIn("error", [record["type"] for record in records])
                self.assertFalse(manager.stop(session_id))


if __name__ == "__main__":
    unittest.main()
