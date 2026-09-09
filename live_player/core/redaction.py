"""Best-effort diagnostics sanitization; never log raw authentication objects."""

import re

_REDACTED = "[redacted]"
_URL = re.compile(r"https?://[^\s<>\"]+", re.IGNORECASE)
_FIELDS = re.compile(
    r"(?i)(\b(?:password|passwd|pwd|student_id|username|account|"
    r"auth_key|access_token|refresh_token|token|sign|clientUUID|t)"
    r"[\"']?\s*[:=]\s*)(?:\[redacted\]|\"(?:\\.|[^\"\\])*\"|"
    r"'(?:\\.|[^'\\])*'|[^\s]+)"
)
_HEADERS = re.compile(
    r"(?im)(\b(?:authorization|proxy-authorization|cookie|set-cookie)"
    r"[\"']?\s*[:=]\s*)[^\r\n]+"
)
_STUDENT_ID = re.compile(r"\b\d{11}\b")


def _redact_url(match):
    url = match.group(0)
    # Remove userinfo without parsing exceptions that could echo the URL.
    url = re.sub(r"(https?://)[^/?#]*@", r"\1[redacted]@", url, flags=re.IGNORECASE)
    if "#" in url:
        url = url.split("#", 1)[0] + "#[redacted]"
    if "?" in url:
        base, query = url.split("?", 1)
        query, separator, fragment = query.partition("#")
        query = "&".join(
            part.split("=", 1)[0] + "=[redacted]" if "=" in part else "[redacted]"
            for part in query.split("&")
        )
        url = base + "?" + query + separator + fragment
    return url


def redact_message(value: object) -> str:
    """Redact known fields, headers, identifiers, and every URL query value.

    Arbitrary unlabelled secrets cannot be identified reliably. Callers should
    prefer fixed diagnostic messages and must never dump credentials or sessions.
    """
    try:
        message = str(value)
    except Exception:
        return "diagnostic unavailable"
    message = _URL.sub(_redact_url, message)
    message = _HEADERS.sub(lambda match: match[1] + _REDACTED, message)
    message = _FIELDS.sub(lambda match: match[1] + _REDACTED, message)
    return _STUDENT_ID.sub(_REDACTED, message)
