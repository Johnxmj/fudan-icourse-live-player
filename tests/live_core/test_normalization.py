import unittest

from src.api.icourse import ICourseClient


class CourseNormalizationTest(unittest.TestCase):
    def test_preserves_start_and_end_aliases_for_live_selection(self):
        class Response:
            def raise_for_status(self):
                pass

            def json(self):
                return {"code": 0, "data": {"sub_list": {"2999": {"1": {"2": [{
                    "id": "morning", "sub_title": "2999-01-02 Morning",
                    "begin_time": "2999-01-02T09:00:00+08:00",
                    "end_time": "2999-01-02T11:00:00+08:00",
                }]}}}}}

        class VPN:
            def get(self, *args, **kwargs):
                return Response()

        lecture = ICourseClient(VPN()).get_course_detail("c1")["lectures"][0]
        self.assertEqual(lecture.get("start_at"), "2999-01-02T09:00:00+08:00")
        self.assertEqual(lecture.get("end_at"), "2999-01-02T11:00:00+08:00")
