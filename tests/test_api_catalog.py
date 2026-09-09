import unittest
from unittest.mock import Mock

from src.api.icourse import ICourseClient


class CourseListClient(ICourseClient):
    def __init__(self, pages):
        self.pages = pages
        self.calls = []

    def get_course_list(self, term="24", page=1, per_page=20):
        self.calls.append((term, page, per_page))
        value = self.pages[page - 1]
        if isinstance(value, Exception):
            raise value
        return value


def page(total, *ids):
    return {"total": total, "courses": [{"id": value, "title": f"课程 {value}"} for value in ids]}


class CourseListResponseTest(unittest.TestCase):
    def client_for(self, payload):
        class Response:
            def raise_for_status(self):
                pass

            def json(self):
                return payload

        class VPN:
            def get(self, *args, **kwargs):
                return Response()

        return ICourseClient(VPN())

    def test_missing_or_malformed_pagination_is_not_reported_as_an_empty_catalog(self):
        for data in ({}, None, {"total": 0}, {"total": None, "list": []}, {"total": 1.5, "list": []}):
            with self.subTest(data=data), self.assertRaises(RuntimeError):
                self.client_for({"code": 0, "data": data}).get_course_list("35")

    def test_numeric_string_totals_keep_existing_normalized_contract(self):
        result = self.client_for({"code": 0, "data": {"total": "1", "list": [{"id": 42}]}}).get_course_list("35")
        self.assertEqual(result, {"total": 1, "courses": [{"id": 42}]})

    def test_none_term_omits_filter_for_the_official_recent_courses_page(self):
        client = self.client_for({"code": 0, "data": {"total": 0, "list": []}})
        original = client.vpn.get
        client.vpn.get = Mock(side_effect=original)
        client.get_course_list(term=None, per_page=500)
        self.assertNotIn("term", client.vpn.get.call_args.kwargs["params"])


class RecentSemesterDiscoveryTest(unittest.TestCase):
    def test_default_discovers_official_recent_term_instead_of_scanning_guessed_codes(self):
        client = ICourseClient(None)
        client.get_course_list = Mock(side_effect=[
            {"total": 25250, "courses": [{"term": "_27_", "term_name": "2026-20271"}]},
            {"total": 4763, "courses": [{"term_name": "2026-20271"}]},
        ])
        self.assertEqual(client.discover_terms(), [{"code": "27", "name": "2026-20271", "count": 4763}])
        self.assertEqual(client.get_course_list.call_args_list[0].kwargs, {"term": None, "page": 1, "per_page": 500})
        self.assertEqual(client.get_course_list.call_count, 2)

    def test_recent_page_terms_are_deduplicated_and_sorted(self):
        client = ICourseClient(None)
        client.get_course_list = Mock(side_effect=[
            {"total": 100, "courses": [
                {"term": "_26_", "term_name": "previous"},
                {"term": "_27_", "term_name": "current"},
                {"term": "_27_", "term_name": "current"},
            ]},
            {"total": 80, "courses": []}, {"total": 20, "courses": []},
        ])
        self.assertEqual([item["code"] for item in client.discover_terms()], ["27", "26"])
        self.assertEqual(client.get_course_list.call_count, 3)

    def test_explicit_range_retains_legacy_scan(self):
        client = ICourseClient(None)
        client.get_course_list = Mock(side_effect=[{"total": 1, "courses": [{"term_name": "term 24"}]}])
        self.assertEqual(client.discover_terms(24, 24), [{"code": "24", "name": "term 24", "count": 1}])
        client.get_course_list.assert_called_once_with(term="24", page=1, per_page=1)

    def test_unknown_recent_term_and_network_failures_are_not_silent_empty_results(self):
        for response in ({"total": 1, "courses": [{"term": "unknown"}]}, RuntimeError("offline")):
            client = ICourseClient(None)
            client.get_course_list = Mock(side_effect=[response])
            with self.subTest(response=response), self.assertRaises(RuntimeError):
                client.discover_terms()


class SemesterCoursePaginationTest(unittest.TestCase):
    def test_reads_all_pages_when_server_caps_requested_page_size(self):
        client = CourseListClient([page(5, 1, 2), page(5, 3, 4), page(5, 5)])
        result = client.list_semester_courses("35", per_page=500)
        self.assertEqual([item["course_id"] for item in result], ["1", "2", "3", "4", "5"])
        self.assertEqual(client.calls, [("35", 1, 500), ("35", 2, 500), ("35", 3, 500)])

    def test_page_size_may_vary_without_losing_courses(self):
        client = CourseListClient([page(5, 1, 2), page(5, 3), page(5, 4, 5)])
        self.assertEqual(len(client.list_semester_courses("35", 500)), 5)

    def test_overlapping_pages_are_deduplicated_without_premature_completion(self):
        client = CourseListClient([page(4, 1, 2), page(4, 2, 3), page(4, 4)])
        self.assertEqual([item["course_id"] for item in client.list_semester_courses("35")], ["1", "2", "3", "4"])

    def test_repeated_page_raises_instead_of_returning_a_partial_catalog(self):
        client = CourseListClient([page(5, 1, 2), page(5, 1, 2)])
        with self.assertRaisesRegex(RuntimeError, "progress"):
            client.list_semester_courses("35")
        self.assertEqual(len(client.calls), 2)

    def test_empty_tail_confirms_completion_when_total_includes_hidden_courses(self):
        client = CourseListClient([page(5, 1, 2), page(5)])
        self.assertEqual(len(client.list_semester_courses("35")), 2)
        self.assertEqual(len(client.calls), 2)

    def test_all_hidden_page_inside_declared_page_range_does_not_hide_later_visible_courses(self):
        client = CourseListClient([page(5, 1), page(5), page(5, 5), page(5)])
        self.assertEqual([item["course_id"] for item in client.list_semester_courses("35", per_page=2)], ["1", "5"])
        self.assertEqual(len(client.calls), 4)

    def test_page_failure_is_propagated_without_returning_partial_results(self):
        client = CourseListClient([page(5, 1, 2), RuntimeError("upstream unavailable")])
        with self.assertRaisesRegex(RuntimeError, "upstream unavailable"):
            client.list_semester_courses("35")

    def test_total_changing_mid_scan_requires_retry(self):
        client = CourseListClient([page(4, 1, 2), page(3, 3)])
        with self.assertRaisesRegex(RuntimeError, "changed"):
            client.list_semester_courses("35")

    def test_total_page_limit_stops_an_unbounded_scan(self):
        client = CourseListClient([page(10000, 1), page(10000, 2)])
        with self.assertRaisesRegex(RuntimeError, "limit"):
            client.list_semester_courses("35", max_pages=2)
        self.assertEqual(len(client.calls), 2)

    def test_successful_empty_catalog_requires_no_items_and_zero_total(self):
        client = CourseListClient([page(0)])
        self.assertEqual(client.list_semester_courses("35"), [])
        self.assertEqual(len(client.calls), 1)

    def test_malformed_course_or_total_is_not_silently_discarded(self):
        for result in (
            {"total": 1, "courses": [{}]},
            {"total": 1, "courses": "not a list"},
            {"total": -1, "courses": []},
            {"total": None, "courses": []},
            page(0, 1),
        ):
            with self.subTest(result=result), self.assertRaises(RuntimeError):
                CourseListClient([result]).list_semester_courses("35")

    def test_invalid_pagination_settings_fail_before_network_request(self):
        for keyword in ({"per_page": 0}, {"per_page": True}, {"max_pages": 0}, {"max_pages": 1.5}):
            client = CourseListClient([])
            with self.subTest(keyword=keyword), self.assertRaises(ValueError):
                client.list_semester_courses("35", **keyword)
            self.assertEqual(client.calls, [])

    def test_returns_compatible_normalized_public_course_metadata(self):
        client = CourseListClient([{"total": 1, "courses": [{
            "course_id": "42", "title": "数学分析", "teacher": "张老师",
            "school_name": "数学学院", "upstream_only": "omitted",
        }]}])
        self.assertEqual(client.list_semester_courses("35"), [{
            "course_id": "42", "title": "数学分析", "teacher": "张老师", "dept": "数学学院", "course_code": "",
        }])

    def test_real_department_and_course_code_are_retained_for_course_search(self):
        client = CourseListClient([{"total": 1, "courses": [{
            "id": "42", "title": "数学分析", "realname": "张老师",
            "structure_name": "数学科学学院", "course_code": "MATH001",
        }]}])
        self.assertEqual(client.list_semester_courses("27"), [{
            "course_id": "42", "title": "数学分析", "teacher": "张老师",
            "dept": "数学科学学院", "course_code": "MATH001",
        }])
