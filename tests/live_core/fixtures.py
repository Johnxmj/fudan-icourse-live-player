"""Redacted fixture payloads for live catalog tests.

The values are deliberately invented and contain no platform credentials or
real media endpoints.
"""

COURSE_DETAIL = {
    "title": "Signals and Systems (Fixture)",
    "teacher": "Dr. Example",
    "lectures": [
        {"sub_id": "655211", "sub_title": "Fixture lecture 1", "date": "2999-01-01"},
        {"sub_id": "655212", "sub_title": "Fixture lecture 2", "date": "2999-01-02"},
    ],
}

LIVE_INFO = {
    "sub_id": "655212",
    "course_title": "Signals and Systems (Fixture)",
    "lecturer_name": "Dr. Example",
    "room_name": "Room F-101",
    "sub_title": "Fixture lecture 2",
    "start_at": "2999-01-02T09:00:00+08:00",
    "end_at": "2999-01-02T11:00:00+08:00",
    "sub_status": 1,
    "live_url": {
        "output": {
            "m3u8": "https://media.invalid/fixture-teacher.m3u8",
            "m3u8_audio": "https://media.invalid/fixture-teacher-audio.m3u8",
        },
        "output_student": {
            "m3u8": "https://media.invalid/fixture-student.m3u8",
            "m3u8_audio": "https://media.invalid/fixture-student-audio.m3u8",
        },
    },
}

ENDED_INFO = {
    **LIVE_INFO,
    "sub_id": "655213",
    "sub_title": "Fixture ended lecture",
    "sub_status": 2,
}
