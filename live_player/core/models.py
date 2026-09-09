"""Public catalog metadata deliberately excludes upstream media URLs."""

from dataclasses import dataclass

LIVE_STATUS = 1


@dataclass(frozen=True)
class LiveCourse:
    course_id: str
    course_title: str
    teacher: str
    room: str
    sub_id: str
    sub_title: str
    starts_at: str
    ends_at: str
    status: str
    available_views: tuple[str, ...]
