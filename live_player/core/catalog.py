"""Discover current sessions without scanning historical media."""

from datetime import datetime, timedelta, timezone

from .models import LIVE_STATUS, LiveCourse

# China has no daylight-saving transitions; this also works without Windows tzdata.
PLATFORM_TIMEZONE = timezone(timedelta(hours=8))
VIEW_PATHS = {
    "teacher": ("output", "m3u8"),
    "student": ("output_student", "m3u8"),
    "teacher_audio": ("output", "m3u8_audio"),
    "student_audio": ("output_student", "m3u8_audio"),
}


def _nested(mapping, path):
    value = mapping
    for key in path:
        value = value.get(key) if isinstance(value, dict) else None
    return value


def map_live_course(course_id, course_detail, sub_info):
    """Return URL-free metadata only for platform-confirmed live sessions."""
    if str(sub_info.get("sub_status")) != str(LIVE_STATUS):
        return None
    live_url = sub_info.get("live_url") or {}
    views = tuple(name for name, path in VIEW_PATHS.items() if _nested(live_url, path))
    if not views:
        return None
    return LiveCourse(
        course_id=str(course_id),
        course_title=sub_info.get("course_title") or course_detail.get("title") or "",
        teacher=sub_info.get("lecturer_name") or course_detail.get("teacher") or "",
        room=sub_info.get("room_name") or "",
        sub_id=str(sub_info["sub_id"]),
        sub_title=sub_info.get("sub_title") or "",
        starts_at=str(sub_info.get("start_at") or sub_info.get("begin_time") or ""),
        ends_at=str(sub_info.get("end_at") or sub_info.get("end_time") or ""),
        status="live",
        available_views=views,
    )


def resolve_course_ids(client, configured_ids, term=None):
    """Prefer configured IDs, otherwise list the requested or newest semester."""
    if configured_ids:
        return [str(course_id) for course_id in configured_ids]
    if not term:
        terms = client.discover_terms()  # Client contract: newest first.
        if not terms:
            return []
        term = terms[0]["code"]
    return [str(course["course_id"]) for course in client.list_semester_courses(str(term))]


def _parse_time(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=PLATFORM_TIMEZONE)
    return parsed.astimezone(PLATFORM_TIMEZONE)


def discover_live_courses(client, course_ids, *, now=None):
    """Probe one newest eligible lecture per course; never fall back to history.

    A lecture is eligible if dated today in Shanghai or its supplied end time
    has not elapsed. Unknown dates are skipped. Platform status remains the
    authority on whether that candidate is actually live. ``now`` allows callers
    to share a refresh timestamp and makes date-boundary tests deterministic.
    """
    now = now or datetime.now(PLATFORM_TIMEZONE)
    if now.tzinfo is None:
        now = now.replace(tzinfo=PLATFORM_TIMEZONE)
    now = now.astimezone(PLATFORM_TIMEZONE)
    live = []
    for course_id in course_ids:
        course_id = str(course_id)
        detail = client.get_course_detail(course_id)
        candidates = []
        for index, lecture in enumerate(detail.get("lectures", [])):
            date = _parse_time(lecture.get("date"))
            start = _parse_time(lecture.get("start_at") or lecture.get("begin_time"))
            end = _parse_time(lecture.get("end_at") or lecture.get("end_time"))
            if (date and date.date() == now.date()) or (end and end > now):
                candidates.append((start or date or end, index, lecture))
        if not candidates:
            continue
        # The normalized client exposes only dates; list order breaks same-day ties.
        lecture = max(candidates, key=lambda item: (item[0], item[1]))[2]
        info = client.get_sub_info(course_id, str(lecture["sub_id"]))
        mapped = map_live_course(course_id, detail, info)
        if mapped is not None:
            live.append(mapped)
    return sorted(live, key=lambda item: item.starts_at)
