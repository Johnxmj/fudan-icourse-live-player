import unittest
from datetime import datetime, timedelta, timezone

from live_player.core.catalog import (
    discover_live_courses,
    map_live_course,
    resolve_course_ids,
)
from tests.live_core.fixtures import COURSE_DETAIL, ENDED_INFO, LIVE_INFO

NOW = datetime(2999, 1, 2, 10, tzinfo=timezone(timedelta(hours=8)))


class FakeClient:
    def __init__(self, infos, details=None, terms=None, semester_courses=None):
        self.infos = infos
        self.details = details or {"38463": COURSE_DETAIL}
        self.terms = terms or []
        self.semester_courses = semester_courses or []
        self.sub_info_calls = []

    def get_course_detail(self, course_id):
        return self.details[str(course_id)]

    def get_sub_info(self, course_id, sub_id):
        self.sub_info_calls.append((str(course_id), str(sub_id)))
        return self.infos[str(sub_id)]

    def discover_terms(self):
        return self.terms

    def list_semester_courses(self, term):
        self.listed_term = term
        return self.semester_courses


class LiveCatalogTest(unittest.TestCase):
    def test_maps_current_live_session_without_upstream_urls(self):
        course = map_live_course("38463", COURSE_DETAIL, LIVE_INFO)
        self.assertEqual(course.course_id, "38463")
        self.assertEqual(course.sub_id, "655212")
        self.assertEqual(course.status, "live")
        self.assertEqual(
            course.available_views,
            ("teacher", "student", "teacher_audio", "student_audio"),
        )
        self.assertNotIn("http", repr(course))

    def test_discovers_only_platform_live_sessions(self):
        client = FakeClient({"655212": LIVE_INFO, "655213": ENDED_INFO})
        courses = discover_live_courses(client, ["38463"], now=NOW)
        self.assertEqual([c.sub_id for c in courses], ["655212"])
        self.assertEqual(client.sub_info_calls, [("38463", "655212")])

    def test_ended_latest_does_not_probe_older_sessions(self):
        client = FakeClient({"655212": ENDED_INFO})
        self.assertEqual(discover_live_courses(client, ["38463"], now=NOW), [])
        self.assertEqual(client.sub_info_calls, [("38463", "655212")])

    def test_skips_past_future_and_undated_lectures(self):
        detail = {**COURSE_DETAIL, "lectures": [
            {"sub_id": "1", "date": "2999-01-01"},
            {"sub_id": "2", "date": "2999-01-03"},
            {"sub_id": "3", "date": "invalid"},
        ]}
        client = FakeClient({}, details={"38463": detail})
        self.assertEqual(discover_live_courses(client, ["38463"], now=NOW), [])
        self.assertEqual(client.sub_info_calls, [])

    def test_selects_latest_start_even_when_lectures_are_unsorted(self):
        detail = {**COURSE_DETAIL, "lectures": [
            {"sub_id": "655212", "date": "2999-01-02", "start_at": "2999-01-02T09:00:00+08:00"},
            {"sub_id": "1", "date": "2999-01-02", "start_at": "2999-01-02T08:00:00+08:00"},
        ]}
        client = FakeClient({"655212": LIVE_INFO}, details={"38463": detail})
        self.assertEqual(len(discover_live_courses(client, ["38463"], now=NOW)), 1)
        self.assertEqual(client.sub_info_calls, [("38463", "655212")])

    def test_future_same_day_session_does_not_hide_morning_live_session(self):
        detail = {**COURSE_DETAIL, "lectures": [
            {"sub_id": "655212", "date": "2999-01-02", "start_at": "2999-01-02T09:00:00+08:00"},
            {"sub_id": "future", "date": "2999-01-02", "start_at": "2999-01-02T15:00:00+08:00"},
        ]}
        client = FakeClient({"655212": LIVE_INFO, "future": ENDED_INFO}, details={"38463": detail})
        self.assertEqual([c.sub_id for c in discover_live_courses(client, ["38463"], now=NOW)], ["655212"])
        self.assertEqual(client.sub_info_calls, [("38463", "655212")])

    def test_time_only_start_is_interpreted_on_the_lecture_date(self):
        detail = {**COURSE_DETAIL, "lectures": [
            {"sub_id": "655212", "date": "2999-01-02", "begin_time": "09:00", "end_time": "11:00"},
            {"sub_id": "future", "date": "2999-01-02", "start_at": "15:00"},
        ]}
        info = {key: value for key, value in LIVE_INFO.items() if key not in ("start_at", "end_at")}
        client = FakeClient({"655212": info, "future": ENDED_INFO}, details={"38463": detail})
        courses = discover_live_courses(client, ["38463"], now=NOW)
        self.assertEqual(client.sub_info_calls, [("38463", "655212")])
        self.assertEqual(courses[0].starts_at, "2999-01-02T09:00:00+08:00")
        self.assertEqual(courses[0].ends_at, "2999-01-02T11:00:00+08:00")

    def test_checks_other_same_day_candidates_without_probing_history(self):
        detail = {**COURSE_DETAIL, "lectures": [
            {"sub_id": "old", "date": "2999-01-01"},
            {"sub_id": "655212", "date": "2999-01-02"},
            {"sub_id": "ended", "date": "2999-01-02"},
        ]}
        client = FakeClient({"655212": LIVE_INFO, "ended": ENDED_INFO}, details={"38463": detail})
        self.assertEqual([c.sub_id for c in discover_live_courses(client, ["38463"], now=NOW)], ["655212"])
        self.assertEqual(client.sub_info_calls, [("38463", "ended"), ("38463", "655212")])

    def test_future_date_is_not_eligible_merely_because_end_is_in_future(self):
        detail = {"lectures": [{"sub_id": "future", "date": "2999-01-03", "end_at": "2999-01-03T11:00:00+08:00"}]}
        client = FakeClient({"future": LIVE_INFO}, details={"38463": detail})
        self.assertEqual(discover_live_courses(client, ["38463"], now=NOW), [])
        self.assertEqual(client.sub_info_calls, [])

    def test_one_broken_course_does_not_hide_another_live_course(self):
        client = FakeClient({"655212": LIVE_INFO})
        self.assertEqual([c.sub_id for c in discover_live_courses(client, ["missing", "38463"], now=NOW)], ["655212"])

    def test_one_failed_candidate_does_not_hide_another_current_candidate(self):
        detail = {**COURSE_DETAIL, "lectures": [
            {"sub_id": "655212", "date": "2999-01-02"},
            {"sub_id": "missing", "date": "2999-01-02"},
        ]}
        client = FakeClient({"655212": LIVE_INFO}, details={"38463": detail})
        self.assertEqual([c.sub_id for c in discover_live_courses(client, ["38463"], now=NOW)], ["655212"])

    def test_live_metadata_preserves_candidate_times_when_info_omits_them(self):
        detail = {**COURSE_DETAIL, "lectures": [{
            "sub_id": "655212", "date": "2999-01-02",
            "start_at": "2999-01-02T09:00:00+08:00", "end_at": "2999-01-02T11:00:00+08:00",
        }]}
        info = {key: value for key, value in LIVE_INFO.items() if key not in ("start_at", "end_at")}
        client = FakeClient({"655212": info}, details={"38463": detail})
        course = discover_live_courses(client, ["38463"], now=NOW)[0]
        self.assertEqual(course.starts_at, detail["lectures"][0]["start_at"])
        self.assertEqual(course.ends_at, detail["lectures"][0]["end_at"])

    def test_cross_midnight_session_with_unelapsed_end_is_candidate(self):
        detail = {**COURSE_DETAIL, "lectures": [{
            "sub_id": "655212", "date": "2999-01-01",
            "end_time": "2999-01-02T03:00:00Z",
        }]}
        client = FakeClient({"655212": LIVE_INFO}, details={"38463": detail})
        self.assertEqual(len(discover_live_courses(client, ["38463"], now=NOW)), 1)

    def test_only_explicit_live_status_and_live_views_are_playable(self):
        for status in (None, "unknown", 0, 2, 1.5):
            with self.subTest(status=status):
                self.assertIsNone(map_live_course("38463", COURSE_DETAIL, {**LIVE_INFO, "sub_status": status}))
        self.assertIsNone(map_live_course("38463", COURSE_DETAIL, {**LIVE_INFO, "live_url": {}}))
        self.assertEqual(map_live_course("38463", COURSE_DETAIL, {**LIVE_INFO, "sub_status": "1"}).status, "live")

    def test_mapping_falls_back_to_course_metadata(self):
        course = map_live_course("38463", COURSE_DETAIL, {
            "sub_id": 655212, "sub_status": 1,
            "live_url": {"output": {"m3u8_audio": "https://media.invalid/audio.m3u8"}},
        })
        self.assertEqual(course.teacher, "Dr. Example")
        self.assertEqual(course.course_title, COURSE_DETAIL["title"])
        self.assertEqual(course.available_views, ("teacher_audio",))

    def test_configured_course_ids_take_precedence(self):
        client = FakeClient(
            {},
            terms=[{"code": "35"}],
            semester_courses=[{"course_id": "99999"}],
        )
        self.assertEqual(resolve_course_ids(client, ["38463"], "24"), ["38463"])
        self.assertEqual(getattr(client, "listed_term", None), None)

    def test_empty_configuration_uses_newest_term_courses(self):
        client = FakeClient(
            {},
            terms=[{"code": "35"}, {"code": "34"}],
            semester_courses=[
                {"course_id": "38463"},
                {"course_id": 38464},
            ],
        )
        self.assertEqual(
            resolve_course_ids(client, [], None),
            ["38463", "38464"],
        )
        self.assertEqual(client.listed_term, "35")

    def test_explicit_term_skips_term_discovery(self):
        client = FakeClient({}, semester_courses=[{"course_id": 123}])
        self.assertEqual(resolve_course_ids(client, [], "24"), ["123"])
        self.assertEqual(client.listed_term, "24")

    def test_no_discovered_terms_returns_empty_catalog(self):
        client = FakeClient({})
        self.assertEqual(resolve_course_ids(client, [], None), [])
        self.assertFalse(hasattr(client, "listed_term"))


if __name__ == "__main__":
    unittest.main()
