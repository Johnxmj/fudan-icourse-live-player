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
    date = _parse_time(sub_info.get("date"))
    start_value = sub_info.get("start_at") or sub_info.get("begin_time") or sub_info.get("start_time") or ""
    end_value = sub_info.get("end_at") or sub_info.get("end_time") or ""
    start = _parse_time(start_value, date=date)
    end = _parse_time(end_value, date=date)
    return LiveCourse(
        course_id=str(course_id),
        course_title=sub_info.get("course_title") or course_detail.get("title") or "",
        teacher=sub_info.get("lecturer_name") or course_detail.get("teacher") or "",
        room=sub_info.get("room_name") or "",
        sub_id=str(sub_info["sub_id"]),
        sub_title=sub_info.get("sub_title") or "",
        starts_at=start.isoformat() if start else str(start_value),
        ends_at=end.isoformat() if end else str(end_value),
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


def _parse_time(value, *, date=None):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        if date is None:
            return None
        try:
            parsed = datetime.fromisoformat(f"{date.date().isoformat()}T{value}")
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=PLATFORM_TIMEZONE)
    return parsed.astimezone(PLATFORM_TIMEZONE)


def discover_live_courses(client, course_ids, *, now=None):
    """Probe current candidates newest first; never fall back to historical dates.

    Today can contain several lectures, including future ones. Skip known future
    starts, and check today's eligible candidates until one is confirmed live.
    Earlier dates qualify only for a session whose explicit end has not elapsed.
    A failure in one course must not hide a usable stream in another course.
    """
    now = now or datetime.now(PLATFORM_TIMEZONE)
    if now.tzinfo is None:
        now = now.replace(tzinfo=PLATFORM_TIMEZONE)
    now = now.astimezone(PLATFORM_TIMEZONE)
    live = []
    failed = False
    for course_id in dict.fromkeys(str(value) for value in course_ids):
        try:
            detail = client.get_course_detail(course_id)
        except Exception:
            failed = True
            continue
        candidates = []
        for index, lecture in enumerate(detail.get("lectures", [])):
            date = _parse_time(lecture.get("date"))
            start = _parse_time(lecture.get("start_at") or lecture.get("begin_time") or lecture.get("start_time"), date=date)
            end = _parse_time(lecture.get("end_at") or lecture.get("end_time"), date=date)
            anchor = start or date
            if not anchor or (start and start > now) or (date and date.date() > now.date()):
                continue
            if anchor.date() == now.date() or (anchor <= now and end and end > now):
                candidates.append((anchor, index, lecture))
        seen = set()
        for _, _, lecture in sorted(candidates, key=lambda item: (item[0], item[1]), reverse=True):
            sub_id = str(lecture.get("sub_id") or "")
            if not sub_id or sub_id in seen:
                continue
            seen.add(sub_id)
            try:
                info = client.get_sub_info(course_id, sub_id)
                mapped = map_live_course(course_id, detail, {**lecture, **info})
            except Exception:
                failed = True
                continue
            if mapped is not None:
                live.append(mapped)
                break
    if failed and not live:
        raise RuntimeError("live course discovery incomplete") from None
    return sorted(live, key=lambda item: item.starts_at)
