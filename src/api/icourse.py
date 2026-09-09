"""
iCourse API client for Fudan University's smart teaching platform.

Provides access to course details, lecture lists, video URLs,
and current-live stream metadata through WebVPN.
"""

import hashlib
import re
import time
import uuid
from urllib.parse import urlparse

from src.runtime import config
from src.api.webvpn import WebVPNSession, get_vpn_url


_DATE_FROM_SUB_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})")


def _extract_date_from_sub(sub_title: str) -> str | None:
    """Extract YYYY-MM-DD from a sub_title like "2026-03-05第6-8节"."""
    if not sub_title:
        return None
    m = _DATE_FROM_SUB_RE.match(sub_title)
    return m.group(1) if m else None

class ICourseClient:
    """Client for the iCourse API, operating through WebVPN."""

    def __init__(self, vpn_session: WebVPNSession):
        self.vpn = vpn_session
        self.base_url = config.ICOURSE_BASE
        self._userinfo = None

    def get_userinfo(self) -> dict:
        """Get current user info (id, tenant_id, phone, account).

        Caches the result for the session.
        """
        if self._userinfo is not None:
            return self._userinfo

        url = f"{self.base_url}/userapi/v1/infosimple"
        resp = self.vpn.get(url)
        resp.raise_for_status()
        data = resp.json()

        if data.get("code") not in (0, 200):
            raise RuntimeError(f"Failed to get userinfo: {data.get('msg')}")

        self._userinfo = data.get("params") or data.get("data", {})
        return self._userinfo

    def check_alive(self) -> bool:
        """Quick session health check (non-cached)."""
        try:
            resp = self.vpn.get(
                f"{self.base_url}/userapi/v1/infosimple", timeout=10
            )
            return resp.status_code == 200 and resp.json().get("code") in (0, 200)
        except Exception:
            return False

    def sign_video_url(
        self, video_url: str, now: int | None = None
    ) -> str:
        """Sign a video URL with CDN authentication parameters.

        Adds clientUUID and t parameters required for video download.
        The t parameter format: {user_id}-{timestamp}-{md5_hash}
        where md5_hash = md5(pathname + user_id + tenant_id + reversed_phone + timestamp)
        """
        userinfo = self.get_userinfo()
        user_id = userinfo.get("id", "")
        tenant_id = userinfo.get("tenant_id", "")
        phone = str(userinfo.get("phone", ""))

        if now is None:
            now = int(time.time())

        reversed_phone = phone[::-1]
        pathname = urlparse(video_url).path

        hash_input = f"{pathname}{user_id}{tenant_id}{reversed_phone}{now}"
        md5_hash = hashlib.md5(hash_input.encode()).hexdigest()
        t_param = f"{user_id}-{now}-{md5_hash}"

        client_uuid = str(uuid.uuid4())
        sep = "&" if "?" in video_url else "?"
        return f"{video_url}{sep}clientUUID={client_uuid}&t={t_param}"

    def get_course_detail(self, course_id: str) -> dict:
        """Get course details including title, teacher, and lecture list.

        Returns dict with keys: title, teacher, lectures
        Each lecture has: sub_id, sub_title, lecturer_name, date, start_at,
        end_at, has_playback. Preserve supplied times for current-live selection.
        """
        url = f"{self.base_url}/courseapi/v3/multi-search/get-course-detail"
        resp = self.vpn.get(url, params={"course_id": course_id})
        resp.raise_for_status()
        data = resp.json()

        if data.get("code") != 0:
            raise RuntimeError(
                f"API error for course {course_id}: {data.get('msg')}"
            )

        course_data = data.get("data", {})
        title = course_data.get("title", "Unknown")
        teacher = course_data.get("realname", "Unknown")

        # Parse the nested sub_list: {year: {month: {day: [items]}}}
        lectures = []
        sub_list = course_data.get("sub_list", {})
        for year, months in sub_list.items():
            for month, days in months.items():
                for day, items in days.items():
                    for item in items:
                        if "id" in item:
                            sub_title = item.get("sub_title", "")
                            # Real lecture date is embedded in sub_title
                            # ("2026-03-05第6-8节" → "2026-03-05"); fall back
                            # to the server's year/month/day keys if missing.
                            # Zero-pad the fallback so SQLite ORDER BY works.
                            date = (
                                _extract_date_from_sub(sub_title)
                                or f"{int(year):04d}-{int(month):02d}-{int(day):02d}"
                            )
                            lectures.append(
                                {
                                    "sub_id": item["id"],
                                    "sub_title": sub_title,
                                    "lecturer_name": item.get(
                                        "lecturer_name", ""
                                    ),
                                    "date": date,
                                    "start_at": item.get("start_at") or item.get("begin_time") or item.get("start_time") or "",
                                    "end_at": item.get("end_at") or item.get("end_time") or "",
                                    "has_playback": str(item.get("playback_status")) == "1",
                                }
                            )

        return {"title": title, "teacher": teacher, "lectures": lectures}

    def get_ppt_list(self, course_id: str, sub_id: str,
                     per_page: int = 100) -> list[dict]:
        """Fetch PPT screenshot list for a lecture.

        Walks pagination until exhausted. Returns a flat list of items, each:
            {
              "id": int,                # row id
              "pptimgurl": str,         # full image URL (used for OCR)
              "pptthumb": str,          # thumbnail URL (kept for reference)
              "created_sec": int,       # offset within lecture, in seconds
              "created_ms": int,        # original epoch ms timestamp
              "taskid": str,
            }
        Sorted by created_sec ascending.
        """
        import json
        items = []
        page = 1
        while True:
            url = f"{self.base_url}/pptnote/v1/schedule/search-ppt"
            resp = self.vpn.get(
                url,
                params={
                    "course_id": course_id, "sub_id": sub_id,
                    "page": page, "per_page": per_page,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            if data.get("code") != 0:
                raise RuntimeError(f"search-ppt failed: {data.get('msg')}")
            page_items = data.get("list", [])
            if not page_items:
                break
            for raw in page_items:
                try:
                    content = json.loads(raw.get("content", "{}"))
                except (ValueError, TypeError):
                    continue
                img_url = content.get("pptimgurl")
                if not img_url:
                    continue
                items.append({
                    "id": raw.get("id"),
                    "pptimgurl": img_url,
                    "pptthumb": content.get("pptthumb", ""),
                    "created_sec": int(raw.get("created_sec", 0) or 0),
                    "created_ms": int(content.get("created", 0) or 0),
                    "taskid": content.get("taskid", ""),
                })
            if len(page_items) < per_page:
                break
            page += 1
        items.sort(key=lambda x: x["created_sec"])
        return items

    def get_course_list(
        self, term: str | None = "24", page: int = 1, per_page: int = 20
    ) -> dict:
        """Get a paginated list of courses for a given term.

        Returns dict with keys: total, courses (list of course dicts).
        Empty-string filter params are omitted so the API returns all
        courses rather than searching for "".
        """
        url = f"{self.base_url}/portal/courseapi/v3/multi-search/get-course-list"
        # Omitting empty-string params matters — some backends treat
        # ``title=""`` as "search for nothing" rather than "no filter".
        params: dict[str, str | int] = {
            "tenant": config.TENANT_CODE,
            "page": page,
            "per_page": per_page,
        }
        if term is not None and str(term).strip():
            params["term"] = str(term)
        for key in ("title", "kkxy_code", "course_type", "course_student_type"):
            val = getattr(config, key.upper(), "") if key.isupper() else ""
            if not val:
                continue
            params[key] = val
        resp = self.vpn.get(url, params=params)
        resp.raise_for_status()
        data = resp.json()

        if data.get("code") != 0:
            raise RuntimeError(f"API error: {data.get('msg')}")

        result = data.get("data")
        if not isinstance(result, dict) or not isinstance(result.get("list"), list):
            raise RuntimeError("invalid course catalog response")
        total = result.get("total")
        if isinstance(total, str) and total.strip().isascii() and total.strip().isdecimal():
            total = int(total.strip())
        if type(total) is not int or total < 0:
            raise RuntimeError("invalid course catalog total")
        return {"total": total, "courses": result["list"]}

    def discover_terms(self, code_min: int | None = None,
                       code_max: int | None = None) -> list[dict]:
        """Discover terms from the official recent-course page, newest first.

        Default discovery does not guess future numeric codes. Counts remain
        the platform's advertised term totals, which may include hidden courses.
        Explicit numeric bounds retain the legacy range-scan API.
        """
        if code_min is None and code_max is None:
            recent = self.get_course_list(term=None, page=1, per_page=500)
            if recent["total"] == 0:
                return []
            terms = {}
            for course in recent["courses"]:
                if not isinstance(course, dict):
                    continue
                match = re.fullmatch(r"_?(\d+)_?", str(course.get("term", "")).strip())
                if match:
                    code = match.group(1)
                    terms.setdefault(code, course.get("term_name") or code)
            if not terms:
                raise RuntimeError("official recent courses did not identify a semester")
            results = []
            for code in sorted(terms, key=int, reverse=True):
                total = self.get_course_list(term=code, page=1, per_page=1)["total"]
                if total:
                    results.append({"code": code, "name": terms[code], "count": total})
            return results
        code_min = 10 if code_min is None else code_min
        code_max = 35 if code_max is None else code_max
        results: list[dict] = []
        for code in range(code_min, code_max + 1):
            try:
                resp = self.get_course_list(
                    term=str(code), page=1, per_page=1,
                )
                total = resp.get("total", 0)
                if not total:
                    continue
                courses = resp.get("courses", [])
                name = (courses[0].get("term_name") if courses else None) or str(code)
                results.append({"code": str(code), "name": name,
                                "count": total})
            except Exception:
                continue
        return sorted(results, key=lambda x: -int(x["code"]))

    def list_semester_courses(self, term: str, per_page: int = 500,
                              *, max_pages: int = 1000) -> list[dict]:
        """Read the complete semester catalog even when the server caps page size.

        ``total`` can include hidden courses. Read the declared page range and
        continue until all advertised IDs are seen or an empty tail confirms the
        visible catalog is exhausted. Short pages never imply completion because
        the server may cap page size. Nonempty repeated, malformed, or changing
        pages raise; ``max_pages`` bounds broken pagination.
        Returns public ``{course_id, title, teacher, dept, course_code}`` metadata.
        """
        if type(per_page) is not int or per_page < 1:
            raise ValueError("per_page must be a positive integer")
        if type(max_pages) is not int or max_pages < 1:
            raise ValueError("max_pages must be a positive integer")
        out: list[dict] = []
        seen: set[str] = set()
        total_expected = None
        for page in range(1, max_pages + 1):
            result = self.get_course_list(term=term, page=page, per_page=per_page)
            if not isinstance(result, dict):
                raise RuntimeError("invalid course catalog response")
            total = result.get("total")
            page_items = result.get("courses")
            if type(total) is not int or total < 0 or not isinstance(page_items, list):
                raise RuntimeError("invalid course catalog response")
            if total_expected is None:
                total_expected = total
            elif total != total_expected:
                raise RuntimeError("course catalog changed during pagination; retry the query")
            if total_expected == 0 and not page_items:
                return []
            declared_pages = max(1, (total_expected + per_page - 1) // per_page)
            if not page_items:
                if page >= declared_pages:
                    return out
                continue
            previous_count = len(seen)
            for raw in page_items:
                if not isinstance(raw, dict):
                    raise RuntimeError("invalid course catalog entry")
                cid = raw.get("id") or raw.get("course_id")
                if type(cid) not in (str, int) or not str(cid).strip():
                    raise RuntimeError("invalid course catalog identifier")
                cid = str(cid).strip()
                if cid in seen:
                    continue
                seen.add(cid)
                dept = (
                    raw.get("kkxy_name") or raw.get("structure_name") or raw.get("school_name")
                    or raw.get("dept_name") or raw.get("kkxy") or None
                )
                out.append({
                    "course_id": cid,
                    "title": raw.get("title") or "",
                    "teacher": raw.get("realname") or raw.get("teacher") or "",
                    "dept": dept,
                    "course_code": raw.get("course_code") or "",
                })
            if len(seen) > total_expected:
                raise RuntimeError("course catalog total does not match returned entries")
            if len(seen) == total_expected and page >= declared_pages:
                return out
            if len(seen) == previous_count:
                raise RuntimeError("course catalog pagination made no progress")
        raise RuntimeError("course catalog pagination exceeded the page limit")

    def get_lecture_detail(self, course_id: str, sub_id: str) -> dict:
        """Get details for a specific lecture, including video URL info.

        The video URL is typically embedded in the course detail's sub_list
        items. This method retrieves the full course detail and finds the
        matching lecture by sub_id.
        """
        detail = self.get_course_detail(course_id)
        for lecture in detail["lectures"]:
            if str(lecture["sub_id"]) == str(sub_id):
                return lecture
        raise ValueError(
            f"Lecture {sub_id} not found in course {course_id}"
        )

    def get_transcript(self, sub_id: str) -> str | None:
        """Get the transcript text for a lecture (flat string).

        Returns the full transcript text, empty string if no transcript,
        or None on error.
        """
        segments = self.get_transcript_segments(sub_id)
        if segments is None:
            return None
        if not segments:
            return ""
        return " ".join(s["text"] for s in segments if s["text"])

    def get_transcript_segments(self, sub_id: str) -> list[dict] | None:
        """Get transcript as timed segments.  Returns None on API error,
        empty list if no transcript exists.

        Each segment: {"start_ms": int, "end_ms": int, "text": str}
        Sorted by start_ms ascending.
        """
        url = f"{self.base_url}/courseapi/v3/web-socket/search-trans-result"
        resp = self.vpn.get(
            url, params={"sub_id": sub_id, "format": "json"}
        )
        resp.raise_for_status()
        data = resp.json()

        if data.get("code") != 0:
            return None

        result_list = data.get("list", [])
        if not result_list:
            return []

        all_content = result_list[0].get("all_content", [])
        if not all_content:
            return []

        return sorted(
            (
                {
                    "start_ms": int(seg.get("BeginSec", 0)) * 1000,
                    "end_ms": int(seg.get("EndSec", seg.get("BeginSec", 0))) * 1000,
                    "text": seg.get("Text", ""),
                }
                for seg in all_content
                if seg.get("Text", "").strip()
            ),
            key=lambda s: s["start_ms"],
        )

    def get_sub_detail(self, course_id: str, sub_id: str) -> dict:
        """Get detailed info for a specific lecture (unsigned URL).

        Returns the full sub-detail data from the API.
        Note: The video URL returned here is NOT signed for CDN auth.
        Use get_sub_info() instead for a signed/downloadable URL.
        """
        url = f"{self.base_url}/courseapi/v3/multi-search/get-sub-detail"
        resp = self.vpn.get(url, params={
            "course_id": course_id, "sub_id": sub_id
        })
        resp.raise_for_status()
        data = resp.json()

        if data.get("code") != 0:
            raise RuntimeError(
                f"API error for sub {sub_id}: {data.get('msg')}"
            )

        return data.get("data", {})

    def get_sub_info(self, course_id: str, sub_id: str) -> dict:
        """Get lecture info including video URLs and timestamp.

        Returns the data payload from the API.

        Non-zero API codes that still ship a populated data payload
        (notably 7001 "视频未到开放时间", the school's 24h pre-release
        review gate) are returned as partial data so the caller can
        extract the video URL from nested content.playback.url — the
        gate scrubs top-level video_list/playurl but not the nested
        URL.  Only raises on HTTP failure or an entirely empty payload.
        """
        url = (
            f"{self.base_url}"
            f"/courseapi/v3/portal-home-setting/get-sub-info"
        )
        resp = self.vpn.get(url, params={
            "course_id": course_id, "sub_id": sub_id
        })
        resp.raise_for_status()
        data = resp.json()
        payload = data.get("data") or {}

        if data.get("code") != 0 and not payload:
            raise RuntimeError(
                f"API error for sub-info {sub_id}: {data.get('msg')}"
            )

        return payload

    def get_video_url(self, course_id: str, sub_id: str) -> str | None:
        """Get a signed MP4 video URL for a specific lecture.

        Cascades through URL sources, most- to least-preferred:
          1. info.video_list[*].preview_url     — healthy lecture
          2. info.playurl[*]                    — healthy alternate
          3. info.content.playback.url          — review-gated (no extra call)
          4. get-sub-detail content.playback.url — last resort

        Sources 3 and 4 cover the school's pre-release review gate
        (sub-info code 7001 "视频未到开放时间"), which scrubs top-level
        video_list/playurl but leaves the URL in nested fields.  The
        CDN itself does not enforce the gate, so a signed URL from
        either source downloads successfully.

        Returns the signed video URL string, or None if no source yields one.
        """
        try:
            info = self.get_sub_info(course_id, sub_id)
        except Exception as e:
            print(f"    sub-info unavailable for {sub_id} "
                  f"({type(e).__name__}); falling back to sub-detail")
            info = {}

        # Get server timestamp for signing
        now = info.get("now")
        if isinstance(now, str):
            now = int(now)

        # Extract base video URL from playurl dict or video_list
        base_url = None

        # Try video_list first (has preview_url without /0/ prefix)
        video_list = info.get("video_list", {})
        if isinstance(video_list, dict):
            for _, v in video_list.items():
                if isinstance(v, dict):
                    preview = v.get("preview_url")
                    if preview and preview.endswith(".mp4"):
                        base_url = preview
                        break

        # Fallback: try playurl dict (has /0/ prefix, may need stripping)
        if not base_url:
            playurl = info.get("playurl", {})
            if isinstance(playurl, dict):
                for k, v in playurl.items():
                    if k == "now":
                        continue
                    if isinstance(v, str) and v.endswith(".mp4"):
                        base_url = v
                        break

        # Review-gate fallback: nested content.playback.url is preserved
        # even when code == 7001 scrubs the top-level fields above.
        if not base_url:
            playback = (info.get("content") or {}).get("playback") or {}
            nested = playback.get("url")
            if isinstance(nested, str) and nested.endswith(".mp4"):
                base_url = nested
                if not now:
                    content_now = (info.get("content") or {}).get("now")
                    if isinstance(content_now, (int, str)):
                        now = int(content_now)

        # Last resort: hit get-sub-detail (gate-free) directly.
        if not base_url:
            try:
                detail = self.get_sub_detail(course_id, sub_id)
                content = detail.get("content", {})
                playback = content.get("playback", {})
                if playback and playback.get("url"):
                    base_url = playback["url"]
            except Exception:
                pass

        if not base_url:
            print(f"    No video URL found for {sub_id} (tried video_list, "
                  f"playurl, content.playback, sub_detail)")
            return None

        return self.sign_video_url(base_url, now=now)

    def get_stream_params(self, video_url: str) -> tuple[str, str]:
        """Get WebVPN URL and HTTP headers for direct streaming (e.g., ffmpeg).

        Returns:
            (vpn_url, http_headers) where http_headers is ffmpeg-compatible.
        """
        vpn_url = get_vpn_url(video_url)
        cookies = "; ".join(
            f"{c.name}={c.value}" for c in self.vpn.session.cookies
        )
        headers = f"Cookie: {cookies}\r\nUser-Agent: {config.USER_AGENT}\r\n"
        return vpn_url, headers
