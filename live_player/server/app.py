"""Small transport-independent routing layer; no raw upstream errors escape."""

from dataclasses import asdict, dataclass, replace
import hmac
import json
import secrets
import threading
import time
import ipaddress
import math
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from live_player.core.catalog import discover_live_courses, resolve_course_ids
from live_player.core.sources import LiveSourceResolver, rewrite_hls_manifest
from src.api.webvpn import get_ordinary_url, get_vpn_url
from src.runtime.config import WEBVPN_BASE
from .tokens import TokenStore


_MANIFEST_CONTENT_TYPE = "application/vnd.apple.mpegurl"
_SEGMENT_CHUNK_SIZE = 64 * 1024
_SEGMENT_TTL_SECONDS = 90
_MEDIA_IDLE_SECONDS = 5 * 60
_MEDIA_MAX_SECONDS = 6 * 60 * 60
_WEBVPN_HOST = urlsplit(WEBVPN_BASE).hostname or "webvpn.fudan.edu.cn"
_STATIC_ROOT = Path(__file__).resolve().parents[1] / "web"
_STATIC_ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
    "/transport-local.js": ("transport-local.js", "application/javascript; charset=utf-8"),
    "/app.css": ("app.css", "text/css; charset=utf-8"),
    "/vendor/hls.min.js": ("vendor/hls.min.js", "application/javascript; charset=utf-8"),
    "/vendor/LICENSE": ("vendor/LICENSE", "text/plain; charset=utf-8"),
}


@dataclass(frozen=True)
class Response:
    status: int
    headers: dict[str, str]
    body: bytes = b""
    body_iter: object | None = None


def _json(status, value):
    return Response(status, {"Content-Type": "application/json", "Cache-Control": "no-store"}, json.dumps(value).encode())


def _error(status, code, message):
    return _json(status, {"error": {"code": code, "message": message}})


@dataclass(frozen=True)
class _MediaRouteEntry:
    source_key: tuple[str, str, str, str]
    course_id: str
    sub_id: str
    view: str
    url: str
    expires_at: float


@dataclass(frozen=True)
class _MediaTokenEntry:
    source_key: tuple[str, str]
    course_id: str
    sub_id: str
    expires_at: float
    idle_seconds: float
    absolute_expires_at: float


class _MediaRouteStore:
    """Memory-only route table with source-scoped invalidation."""

    def __init__(self, clock=None):
        self._clock = clock or (lambda: time.monotonic())
        self._entries: dict[str, _MediaRouteEntry] = {}
        self._sources: dict[tuple[str, str, str, str], set[str]] = {}
        self._lock = threading.RLock()

    def register(self, source_key, course_id, sub_id, view, url, ttl_seconds=_SEGMENT_TTL_SECONDS):
        if not math.isfinite(ttl_seconds) or ttl_seconds <= 0:
            raise ValueError("route lifetime must be positive")
        with self._lock:
            now = self._clock()
            self._prune_locked(now)
            token = secrets.token_urlsafe(24)
            while token in self._entries:
                token = secrets.token_urlsafe(24)
            entry = _MediaRouteEntry(source_key, str(course_id), str(sub_id), str(view), url, now + ttl_seconds)
            self._entries[token] = entry
            self._sources.setdefault(source_key, set()).add(token)
            return token

    def resolve(self, token):
        with self._lock:
            now = self._clock()
            self._prune_locked(now)
            return self._entries.get(token)

    def renew_playlist(self, token):
        """Keep an actively polled child playlist usable; segments stay short lived."""
        with self._lock:
            now = self._clock()
            self._prune_locked(now)
            entry = self._entries.get(token)
            if entry is not None:
                self._entries[token] = replace(entry, expires_at=now + _SEGMENT_TTL_SECONDS)

    def invalidate_source(self, source_key):
        with self._lock:
            tokens = self._sources.pop(source_key, set())
            for token in tokens:
                self._entries.pop(token, None)

    def clear(self):
        with self._lock:
            self._entries.clear()
            self._sources.clear()

    def _prune_locked(self, now):
        expired = [token for token, entry in self._entries.items() if entry.expires_at <= now]
        for token in expired:
            entry = self._entries.pop(token, None)
            if entry is None:
                continue
            tokens = self._sources.get(entry.source_key)
            if tokens is not None:
                tokens.discard(token)
                if not tokens:
                    self._sources.pop(entry.source_key, None)


class _MediaTokenStore:
    """Course-scoped access with an idle timeout and a fixed maximum lifetime."""
    def __init__(self, clock=None):
        self._clock = clock or (lambda: time.monotonic())
        self._entries: dict[str, _MediaTokenEntry] = {}
        self._sources: dict[tuple[str, str], set[str]] = {}
        self._lock = threading.RLock()

    def issue(self, course_id, sub_id, ttl_seconds=_MEDIA_IDLE_SECONDS, max_lifetime_seconds=_MEDIA_MAX_SECONDS):
        if not math.isfinite(ttl_seconds) or ttl_seconds <= 0:
            raise ValueError("token lifetime must be positive")
        if not math.isfinite(max_lifetime_seconds) or max_lifetime_seconds <= 0:
            raise ValueError("maximum token lifetime must be positive")
        source_key = (str(course_id), str(sub_id))
        with self._lock:
            now = self._clock()
            self._prune_locked(now)
            token = secrets.token_urlsafe(24)
            while token in self._entries:
                token = secrets.token_urlsafe(24)
            absolute_expires_at = now + max_lifetime_seconds
            entry = _MediaTokenEntry(
                source_key, str(course_id), str(sub_id),
                min(now + ttl_seconds, absolute_expires_at), ttl_seconds, absolute_expires_at,
            )
            self._entries[token] = entry
            self._sources.setdefault(source_key, set()).add(token)
            return token

    def resolve(self, token):
        with self._lock:
            now = self._clock()
            self._prune_locked(now)
            return self._entries.get(token)

    def renew(self, token):
        """Renew only after a successful request; expired entries cannot revive."""
        with self._lock:
            now = self._clock()
            self._prune_locked(now)
            entry = self._entries.get(token)
            if entry is not None:
                self._entries[token] = replace(
                    entry, expires_at=min(now + entry.idle_seconds, entry.absolute_expires_at),
                )

    def invalidate_source(self, source_key):
        with self._lock:
            tokens = self._sources.pop(source_key, set())
            for token in tokens:
                self._entries.pop(token, None)

    def clear(self):
        with self._lock:
            self._entries.clear()
            self._sources.clear()

    def _prune_locked(self, now):
        expired = [token for token, entry in self._entries.items() if entry.expires_at <= now]
        for token in expired:
            entry = self._entries.pop(token, None)
            if entry is None:
                continue
            tokens = self._sources.get(entry.source_key)
            if tokens is not None:
                tokens.discard(token)
                if not tokens:
                    self._sources.pop(entry.source_key, None)


def _header_value(headers, name):
    for key, value in headers.items():
        if key.lower() == name.lower():
            return value
    return None


class _StreamBody:
    def __init__(self, response, prefix=b"", iterator=None):
        self._response = response
        self._prefix = prefix or b""
        self._iterator = iterator
        self._closed = False

    def __iter__(self):
        try:
            if self._prefix:
                yield self._prefix
            if self._iterator is None:
                for chunk in self._response.iter_content(_SEGMENT_CHUNK_SIZE):
                    if chunk:
                        yield chunk
            else:
                for chunk in self._iterator:
                    if chunk:
                        yield chunk
        finally:
            self.close()

    def close(self):
        if self._closed:
            return
        self._closed = True
        close = getattr(self._response, "close", None)
        if close is not None:
            close()


class LiveApplication:
    def __init__(self, session_manager, course_ids=(), term=None, *, course_selections=(), media_handler=None):
        self.session_manager = session_manager
        self.course_ids = tuple(course_ids)
        self.term = term
        self.course_selections = tuple(course_selections or ())
        self._media_routes = _MediaRouteStore()
        self._media_tokens = _MediaTokenStore()
        self.media_handler = media_handler or self._handle_media
        self._bootstrap = TokenStore()
        self._session_token = secrets.token_urlsafe(32)

    def issue_bootstrap_token(self, ttl_seconds=60):
        return self._bootstrap.issue(True, ttl_seconds)

    def shutdown(self):
        self.session_manager.invalidate()
        self._media_routes.clear()
        self._media_tokens.clear()
        self._bootstrap.clear()
        self._session_token = secrets.token_urlsafe(32)

    def handle(self, method, path, headers, body):
        try:
            route = urlsplit(path).path
            if route in _STATIC_ASSETS and method in ("GET", "HEAD"):
                return self._serve_static(route)
            if route == "/api/session" and method == "POST":
                try:
                    payload = json.loads(body)
                except (ValueError, UnicodeError):
                    return _error(400, "LOGIN_REQUIRED", "Invalid session request")
                token = payload.get("bootstrap_token") if isinstance(payload, dict) else None
                if self._bootstrap.consume(token) is None:
                    return _error(401, "LOGIN_REQUIRED", "Launch the player to sign in")
                return _json(200, {"token": self._session_token})

            if route.startswith("/media/") and self._uses_default_media_handler():
                return self.media_handler(method, path, headers, body)

            authorization = next((value for key, value in headers.items() if key.lower() == "authorization"), "")
            expected = "Bearer " + self._session_token
            if not isinstance(authorization, str) or not hmac.compare_digest(authorization.encode(), expected.encode()):
                return _error(401, "LOGIN_REQUIRED", "Session authorization required")

            if route.startswith("/media/") and self.media_handler is not None:
                return self.media_handler(method, path, headers, body)

            if route == "/api/live-courses" and method == "GET":
                try:
                    self.session_manager.get_client()
                except Exception:
                    return _error(401, "LOGIN_REQUIRED", "Platform sign-in required")
                courses = self.session_manager.call(lambda client: discover_live_courses(
                    client, resolve_course_ids(client, self.course_ids, self.term)))
                payload = []
                for course in courses:
                    item = asdict(course)
                    item["media_token"] = self._media_token_for_course(course.course_id, course.sub_id)
                    payload.append(item)
                return _json(200, payload)
            if route == "/api/followed-courses" and method == "GET":
                try:
                    self.session_manager.get_client()
                except Exception:
                    return _error(401, "LOGIN_REQUIRED", "Platform sign-in required")
                try:
                    live = self.session_manager.call(lambda client: discover_live_courses(
                        client, resolve_course_ids(client, self.course_ids, self.term)))
                except RuntimeError:
                    return _error(401, "LOGIN_REQUIRED", "Platform sign-in required")
                live_by_id = {item.course_id: item for item in live}
                saved_by_id = {
                    str(item.get("course_id")): item for item in self.course_selections
                    if isinstance(item, dict) and item.get("course_id") is not None
                }
                payload = []
                for course_id in self.course_ids:
                    item = live_by_id.get(str(course_id))
                    if item is not None:
                        value = asdict(item)
                        value["media_token"] = self._media_token_for_course(item.course_id, item.sub_id)
                        payload.append(value)
                    else:
                        saved = saved_by_id.get(str(course_id), {})
                        payload.append({
                            "course_id": str(course_id), "course_title": str(saved.get("title") or ""),
                            "teacher": str(saved.get("teacher") or ""), "room": "",
                            "sub_id": "", "sub_title": "", "starts_at": "", "ends_at": "",
                            "status": "offline", "available_views": [],
                        })
                return _json(200, payload)
            return _error(404, "VIEW_UNAVAILABLE", "Requested view is unavailable")
        except Exception:
            return _error(502, "UPSTREAM_FAILED", "Live service request failed")

    def _uses_default_media_handler(self):
        handler = self.media_handler
        return (
            getattr(handler, "__self__", None) is self
            and getattr(handler, "__func__", None) is LiveApplication._handle_media
        )

    def _serve_static(self, route):
        entry = _STATIC_ASSETS.get(route)
        if entry is None:
            return _error(404, "VIEW_UNAVAILABLE", "Requested view is unavailable")
        relative_path, content_type = entry
        try:
            body = (_STATIC_ROOT / relative_path).read_bytes()
        except OSError:
            return _error(404, "VIEW_UNAVAILABLE", "Requested view is unavailable")
        return Response(200, {"Content-Type": content_type, "Cache-Control": "no-store"}, body)

    def _media_token_for_course(self, course_id, sub_id):
        return self._media_tokens.issue(course_id, sub_id)

    def _media_route_url(self, token, media_token):
        return f"/media/segment/{token}?media_token={media_token}"

    def _media_token_entry(self, path):
        query = parse_qs(urlsplit(path).query, keep_blank_values=True)
        token = next((value for value in query.get("media_token", []) if value), "")
        return self._media_tokens.resolve(token), token

    def _reject_unsafe_manifest(self, text, source_host):
        lower_source = source_host.lower()
        if "://" in text or lower_source in text or _WEBVPN_HOST in text:
            raise ValueError("unsafe manifest destination")

    def _handle_media(self, method, path, headers, body):
        route = urlsplit(path).path
        if method != "GET":
            return _error(404, "VIEW_UNAVAILABLE", "Requested view is unavailable")
        media_entry, media_token = self._media_token_entry(path)
        if media_entry is None:
            return _error(401, "LOGIN_REQUIRED", "Media authorization required")
        if route.startswith("/media/segment/"):
            token = route.rsplit("/", 1)[-1]
            entry = self._media_routes.resolve(token)
            if entry is None:
                return _error(410, "SOURCE_EXPIRED", "Source expired")
            if media_entry.course_id != entry.course_id or media_entry.sub_id != entry.sub_id:
                return _error(401, "LOGIN_REQUIRED", "Media authorization required")
            response = self._serve_segment(token, media_token, media_entry)
            if response.status == 200:
                self._media_tokens.renew(media_token)
            return response
        parts = route.split("/")
        if len(parts) == 6 and parts[1] == "media" and parts[5] == "manifest.m3u8":
            course_id, sub_id, view = parts[2], parts[3], parts[4]
            if media_entry.course_id != str(course_id) or media_entry.sub_id != str(sub_id):
                return _error(401, "LOGIN_REQUIRED", "Media authorization required")
            response = self._serve_manifest(course_id, sub_id, view, media_token)
            if response.status == 200:
                self._media_tokens.renew(media_token)
            return response
        return _error(404, "VIEW_UNAVAILABLE", "Requested view is unavailable")

    def _get_live_client(self):
        try:
            return self.session_manager.get_client()
        except Exception:
            return None

    def _source_context(self, client, course_id, sub_id, view):
        resolver = LiveSourceResolver(client)
        source_url = resolver.resolve(course_id, sub_id, view)
        ordinary = get_ordinary_url(source_url)
        parsed = urlsplit(ordinary)
        if parsed.scheme != "https" or not parsed.hostname:
            raise ValueError("unsafe live source")
        return source_url, ordinary, parsed.hostname.lower()

    def _normalize_destination(self, url, base_host):
        parsed = urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname:
            raise ValueError("unsafe media destination")
        if parsed.username or parsed.password:
            raise ValueError("unsafe media destination")
        try:
            parsed.port
        except ValueError as exc:
            raise ValueError("unsafe media destination") from exc

        host = parsed.hostname.lower()
        if host == _WEBVPN_HOST:
            return self._normalize_destination(get_ordinary_url(url), base_host)

        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = None
        if address is not None and (
            address.is_loopback or address.is_private or address.is_link_local or address.is_reserved
        ):
            raise ValueError("unsafe media destination")
        if host != base_host:
            raise ValueError("unsafe media destination")
        return parsed.geturl()

    def _scrub_manifest_metadata(self, text, source_host):
        lines = []
        for raw in text.splitlines(keepends=True):
            stripped = raw.lstrip()
            if stripped.startswith("#") and not stripped.startswith("#EXT") and (
                "://" in raw or source_host in raw or _WEBVPN_HOST in raw
            ):
                continue
            lines.append(raw)
        return "".join(lines)

    def _rewritten_manifest(self, client, course_id, sub_id, view, source_url, ordinary_source, source_host, upstream, media_token):
        source_key = (str(course_id), str(sub_id), str(view), source_url)

        def register(url):
            safe_url = self._normalize_destination(url, source_host)
            token = self._media_routes.register(source_key, course_id, sub_id, view, safe_url)
            return self._media_route_url(token, media_token)

        content = getattr(upstream, "data", None)
        if content is None:
            content = b""
            for chunk in upstream.iter_content(_SEGMENT_CHUNK_SIZE):
                if chunk:
                    content += chunk
        if isinstance(content, bytes):
            manifest_text = content.decode("utf-8", "replace")
        else:
            manifest_text = str(content)
        rewritten = rewrite_hls_manifest(manifest_text, register, ordinary_source)
        rewritten = self._scrub_manifest_metadata(rewritten, source_host)
        self._reject_unsafe_manifest(rewritten, source_host)
        return Response(200, {"Content-Type": _MANIFEST_CONTENT_TYPE, "Cache-Control": "no-store"}, rewritten.encode("utf-8"))

    def _manifest_error(self, client, source_key, upstream, status, code, message):
        close = getattr(upstream, "close", None)
        if close is not None:
            close()
        if getattr(upstream, "status_code", None) in (401, 403):
            self._media_routes.invalidate_source(source_key)
            self._media_tokens.invalidate_source(source_key[:2])
            self.session_manager.invalidate()
            return _error(410, "SOURCE_EXPIRED", "Source expired")
        return _error(status, code, message)

    def _serve_manifest(self, course_id, sub_id, view, media_token):
        client = self._get_live_client()
        if client is None:
            return _error(401, "LOGIN_REQUIRED", "Platform sign-in required")
        try:
            source_url, ordinary_source, source_host = self._source_context(client, course_id, sub_id, view)
        except ValueError:
            return _error(502, "UPSTREAM_FAILED", "Live source validation failed")
        except RuntimeError as exc:
            if "not currently live" in str(exc):
                self._media_tokens.invalidate_source((str(course_id), str(sub_id)))
                return _error(410, "SOURCE_EXPIRED", "Source expired")
            return _error(502, "UPSTREAM_FAILED", "Live source unavailable")

        source_key = (str(course_id), str(sub_id), str(view), source_url)
        upstream = None
        try:
            upstream = client.vpn.get_raw(
                source_url,
                allow_redirects=False,
                headers={"Accept-Encoding": "identity"},
                timeout=30,
            )
            status = getattr(upstream, "status_code", None)
            if status in (401, 403):
                return self._manifest_error(client, source_key, upstream, 410, "SOURCE_EXPIRED", "Source expired")
            if status != 200:
                return self._manifest_error(client, source_key, upstream, 502, "UPSTREAM_FAILED", "Live source unavailable")
            return self._rewritten_manifest(client, course_id, sub_id, view, source_url, ordinary_source, source_host, upstream, media_token)
        except ValueError:
            if upstream is not None:
                close = getattr(upstream, "close", None)
                if close is not None:
                    close()
            return _error(502, "UPSTREAM_FAILED", "Unsafe manifest destination")
        finally:
            if upstream is not None:
                close = getattr(upstream, "close", None)
                if close is not None:
                    close()

    def _serve_segment(self, token, media_token, media_entry):
        entry = self._media_routes.resolve(token)
        if entry is None:
            return _error(410, "SOURCE_EXPIRED", "Source expired")
        if media_entry.course_id != entry.course_id or media_entry.sub_id != entry.sub_id:
            return _error(401, "LOGIN_REQUIRED", "Media authorization required")

        client = self._get_live_client()
        if client is None:
            return _error(401, "LOGIN_REQUIRED", "Platform sign-in required")

        try:
            LiveSourceResolver(client).resolve(entry.course_id, entry.sub_id, entry.view)
        except RuntimeError as exc:
            if "not currently live" in str(exc):
                self._media_routes.invalidate_source(entry.source_key)
                self._media_tokens.invalidate_source((entry.course_id, entry.sub_id))
                return _error(410, "SOURCE_EXPIRED", "Source expired")
            return _error(502, "UPSTREAM_FAILED", "Live source unavailable")

        upstream = None
        streaming = False
        try:
            upstream = client.vpn.get_raw(
                get_vpn_url(entry.url),
                stream=True,
                allow_redirects=False,
                headers={"Accept-Encoding": "identity"},
                timeout=60,
            )
            status = getattr(upstream, "status_code", None)
            if status in (401, 403):
                self._media_routes.invalidate_source(entry.source_key)
                self._media_tokens.invalidate_source((entry.course_id, entry.sub_id))
                self.session_manager.invalidate()
                return _error(410, "SOURCE_EXPIRED", "Source expired")
            if status != 200:
                return _error(502, "UPSTREAM_FAILED", "Live segment unavailable")

            content_type = _header_value(getattr(upstream, "headers", {}), "Content-Type")
            content_length = _header_value(getattr(upstream, "headers", {}), "Content-Length")
            accept_ranges = _header_value(getattr(upstream, "headers", {}), "Accept-Ranges")
            ordinary_segment = entry.url
            iterator = iter(upstream.iter_content(_SEGMENT_CHUNK_SIZE))
            first_chunk = b""
            for chunk in iterator:
                if chunk:
                    first_chunk = chunk
                    break
            is_manifest = (
                (content_type or "").split(";", 1)[0].strip().lower() in {
                    _MANIFEST_CONTENT_TYPE,
                    "application/x-mpegurl",
                    "application/mpegurl",
                    "text/plain",
                }
                or ordinary_segment.split("?", 1)[0].endswith(".m3u8")
                or first_chunk.lstrip().startswith(b"#EXTM3U")
            )
            if is_manifest:
                manifest_chunks = [first_chunk] if first_chunk else []
                manifest_chunks.extend(chunk for chunk in iterator if chunk)
                manifest_text = b"".join(manifest_chunks).decode("utf-8", "replace")
                manifest_source = get_ordinary_url(get_vpn_url(entry.url))
                manifest_host = urlsplit(manifest_source).hostname or ""

                def register(url):
                    safe_url = self._normalize_destination(url, manifest_host.lower())
                    token = self._media_routes.register(entry.source_key, entry.course_id, entry.sub_id, entry.view, safe_url)
                    return self._media_route_url(token, media_token)

                rewritten = rewrite_hls_manifest(manifest_text, register, manifest_source)
                rewritten = self._scrub_manifest_metadata(rewritten, manifest_host.lower())
                self._reject_unsafe_manifest(rewritten, manifest_host.lower())
                self._media_routes.renew_playlist(token)
                return Response(200, {"Content-Type": _MANIFEST_CONTENT_TYPE, "Cache-Control": "no-store"}, rewritten.encode("utf-8"))

            headers_out = {"Cache-Control": "no-store"}
            if content_type is not None:
                headers_out["Content-Type"] = content_type
            if content_length is not None:
                headers_out["Content-Length"] = content_length
            if accept_ranges is not None:
                headers_out["Accept-Ranges"] = accept_ranges
            streaming = True
            return Response(200, headers_out, b"", _StreamBody(upstream, first_chunk, iterator))
        except ValueError:
            if upstream is not None:
                close = getattr(upstream, "close", None)
                if close is not None:
                    close()
            return _error(502, "UPSTREAM_FAILED", "Unsafe media destination")
        finally:
            if upstream is not None and not streaming:
                close = getattr(upstream, "close", None)
                if close is not None:
                    close()
