import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from live_player import cli


CATALOG = [
    {"course_id": "101", "title": "数学分析", "teacher": "张老师", "dept": "数学学院"},
    {"course_id": "102", "title": "数学分析", "teacher": "李老师", "dept": "数学学院"},
    {"course_id": "103", "title": "普通物理", "teacher": "王老师", "dept": "物理系"},
]


def catalog_client():
    client = Mock()
    client.check_alive.return_value = True
    client.discover_terms.return_value = [{"code": "27", "name": "2026-20271", "count": 3}]
    client.list_semester_courses.return_value = CATALOG
    return client


class CourseSelectionTest(unittest.TestCase):
    def test_choose_term_allows_manual_selection_from_available_terms(self):
        terms = [
            {"code": "27", "name": "2026-2027 学年第一学期"},
            {"code": "24", "name": "2025-2026 学年第二学期"},
        ]
        selected = cli.choose_term(terms, input_fn=Mock(side_effect=["2"]), output_fn=Mock())
        self.assertEqual(selected, terms[1])

    def test_searches_name_and_teacher_and_accumulates_selected_courses(self):
        client = catalog_client()
        ask = Mock(side_effect=["数学 张老师", "1", "王老师", "1", ""])
        output = Mock()
        selected = cli.select_courses(client, input_fn=ask, output_fn=output)
        self.assertEqual(selected, ["101", "103"])
        client.list_semester_courses.assert_called_once_with("27")
        self.assertIn("数学分析", str(output.call_args_list))
        self.assertIn("王老师", str(output.call_args_list))

    def test_invalid_selection_and_empty_search_do_not_select_every_course(self):
        ask = Mock(side_effect=["", "不存在的课程", "数学", "99", "数学", "2", ""])
        self.assertEqual(cli.select_courses(catalog_client(), input_fn=ask, output_fn=Mock()), ["102"])

    def test_repeated_selection_is_deduplicated(self):
        ask = Mock(side_effect=["数学", "1,1，2", ""])
        self.assertEqual(cli.select_courses(catalog_client(), input_fn=ask, output_fn=Mock()), ["101", "102"])

    def test_empty_official_directory_does_not_launch_an_unconfigured_scan(self):
        client = catalog_client()
        client.list_semester_courses.return_value = []
        with self.assertRaises(RuntimeError):
            cli.select_courses(client, input_fn=Mock(), output_fn=Mock())

    def test_saved_selection_contains_only_identifiers_and_can_be_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "course-selection.json"
            cli.save_course_selection(["101", "101", "103"], path)
            self.assertEqual(json.loads(path.read_text()), {"courseIds": ["101", "103"]})
            self.assertEqual(cli.load_course_selection(path), ["101", "103"])

    def test_missing_selection_is_empty_but_invalid_identifiers_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "course-selection.json"
            self.assertEqual(cli.load_course_selection(path), [])
            path.write_text('{"courseIds":["https://example.invalid/?token=secret"]}')
            with self.assertRaises(ValueError):
                cli.load_course_selection(path)

    def test_packaged_selection_file_lives_next_to_executable(self):
        with patch.object(cli.sys, "frozen", True, create=True), patch.object(cli.sys, "executable", "/tmp/player/Fudan-iCourse-Live"):
            self.assertEqual(cli.course_selection_path(), Path("/tmp/player/course-selection.json").resolve())

    def test_native_layout_reuses_parent_directory_shared_with_course_picker(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            app = parent / "Fudan-iCourse-Live"
            app.mkdir()
            (parent / "课程目录.json").write_text("{}")
            with patch.object(cli.sys, "frozen", True, create=True), patch.object(cli.sys, "executable", str(app / "Fudan-iCourse-Live")):
                self.assertEqual(cli.course_selection_path(), parent.resolve() / "course-selection.json")

    def test_complete_local_catalog_is_validated_and_stripped_to_public_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "课程目录.json"
            payload = {
                "term": "27", "term_name": "2026-20271", "complete": True,
                "total": 3, "imported_count": 3, "missing_pages": [], "incomplete_pages": [],
                "courses": [{**course, "private_field": "must not be used"} for course in CATALOG],
            }
            path.write_text(json.dumps(payload), encoding="utf-8")
            result = cli.load_course_catalog(path)
            self.assertEqual(result["term_name"], "2026-20271")
            self.assertEqual(len(result["courses"]), 3)
            self.assertNotIn("private_field", result["courses"][0])
            payload["complete"] = False
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaises(ValueError):
                cli.load_course_catalog(path)

    def test_cached_catalog_search_does_not_repeat_official_queries(self):
        client = catalog_client()
        ask = Mock(side_effect=["王老师", "1", ""])
        cached = {"term": "27", "term_name": "2026-20271", "courses": CATALOG}
        self.assertEqual(cli.select_courses(client, catalog=cached, input_fn=ask, output_fn=Mock()), ["103"])
        client.discover_terms.assert_not_called()
        client.list_semester_courses.assert_not_called()

    def test_saved_course_ids_skip_catalog_and_are_loaded_without_reentering_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "course-selection.json"
            path.write_text('{"courseIds":["101"]}')
            with patch("live_player.cli.course_selection_path", return_value=path), \
                    patch("live_player.cli.select_courses") as select, \
                    patch("live_player.cli.launch_player") as launch:
                self.assertEqual(cli.main(["--interactive"], env={"StuId": "student", "UISPsw": "secret"}), 0)
            select.assert_not_called()
            self.assertEqual(launch.call_args.args[0].course_ids, ("101",))

    def test_explicit_environment_ids_override_saved_selection(self):
        with patch("live_player.cli.load_course_selection") as load, patch("live_player.cli.launch_player") as launch:
            self.assertEqual(cli.main([], env={"StuId": "student", "UISPsw": "secret", "COURSE_IDS": "102"}), 0)
        load.assert_not_called()
        self.assertEqual(launch.call_args.args[0].course_ids, ("102",))

    def test_catalog_login_is_reused_and_bootstrap_is_issued_after_selection(self):
        client = catalog_client()
        events = []
        original_build = cli.build_application
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "course-selection.json"
            def select(*args, **kwargs):
                events.append("select")
                return ["103"]
            def build(*args, **kwargs):
                events.append("build")
                return original_build(*args, **kwargs)
            with patch("live_player.cli.course_selection_path", return_value=path), \
                    patch("live_player.cli.load_course_catalog", return_value=None), \
                    patch("live_player.cli._create_client", return_value=client) as create, \
                    patch("live_player.cli.select_courses", side_effect=select), \
                    patch("live_player.cli.build_application", side_effect=build), \
                    patch("live_player.cli.launch_player") as launch:
                self.assertEqual(cli.main(["--interactive"], env={"StuId": "student", "UISPsw": "secret"}), 0)
                self.assertIs(launch.call_args.args[0].application.session_manager.get_client(), client)
            self.assertEqual(events, ["select", "build"])
            create.assert_called_once()
            self.assertEqual(json.loads(path.read_text()), {"courseIds": ["103"]})
