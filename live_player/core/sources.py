"""Resolve current live sources and replace manifest references in memory."""

from collections.abc import Callable
import re
from urllib.parse import urljoin, urlsplit

from src.api.webvpn import get_vpn_url

from .catalog import VIEW_PATHS
from .models import LIVE_STATUS

SOURCE_PATHS = VIEW_PATHS
_ATTRIBUTE = re.compile(r'([:,])([A-Z0-9-]+)=("[^"]*"|[^,]*)')


class LiveSourceResolver:
    def __init__(self, client):
        self.client = client

    def resolve(self, course_id: str, sub_id: str, view: str) -> str:
        if view not in SOURCE_PATHS:
            raise ValueError("unknown live view")
        info = self.client.get_sub_info(course_id, sub_id)
        if str(info.get("sub_status")) != str(LIVE_STATUS):
            raise RuntimeError("lecture is not currently live")
        value = info.get("live_url") or {}
        for key in SOURCE_PATHS[view]:
            value = value.get(key) if isinstance(value, dict) else None
        try:
            parsed = urlsplit(value) if isinstance(value, str) else None
            if not parsed or parsed.scheme != "https" or not parsed.hostname:
                raise ValueError
            parsed.port  # Reject malformed port values before VPN conversion.
        except ValueError:
            raise RuntimeError(f"live view unavailable: {view}") from None
        return get_vpn_url(value)


def rewrite_hls_manifest(text: str, register: Callable[[str], str], base_url: str) -> str:
    """Register references with the caller's memory-only opaque route mapping."""
    def rewrite_attribute(match):
        separator, name, value = match.groups()
        if name == "URI" and value.startswith('"'):
            route = register(urljoin(base_url, value[1:-1]))
            return f'{separator}{name}="{route}"'
        return match.group(0)

    lines = []
    for raw in text.splitlines(keepends=True):
        content = raw.rstrip("\r\n")
        ending = raw[len(content):]
        line = content.strip()
        if line.startswith("#EXT"):
            lines.append(_ATTRIBUTE.sub(rewrite_attribute, content) + ending)
        elif not line or line.startswith("#"):
            lines.append(raw)
        else:
            lines.append(register(urljoin(base_url, line)) + ending)
    return "".join(lines)
