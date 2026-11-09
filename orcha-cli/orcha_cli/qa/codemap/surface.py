"""The URL helpers the code readers share with live traffic (ported from the original
`api_mocks/api_surface.py`): a request's path pattern with ids as `*`, and whether a URL is the
app's API at all."""

from __future__ import annotations

import re
from urllib.parse import urlsplit

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
_HEX_ID = re.compile(r"^[0-9a-f]{12,}$", re.IGNORECASE)
_TOKEN_ID = re.compile(r"^[A-Za-z0-9_-]{20,}$")
_NUMERIC = re.compile(r"^\d+$")
_STATIC = re.compile(r"\.(?:js|mjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|html?)$", re.IGNORECASE)
_NOISE_PATHS = ("/_next/", "/__next", "/__nextjs", "/@vite/", "/@fs/", "/node_modules/", "/sockjs-node", "/favicon", "/hot-update", "/__webpack")
#: Third-party hosts that are the app reporting, not the app's backend.
_NOISE_HOSTS = (
    "google-analytics.com", "googletagmanager.com", "analytics.google.com", "doubleclick.net",
    "segment.io", "segment.com", "amplitude.com", "mixpanel.com", "sentry.io", "hotjar.com",
    "facebook.com", "facebook.net", "clarity.ms", "posthog.com", "intercom.io", "fullstory.com",
    "datadoghq.com", "newrelic.com", "nr-data.net", "googleapis.com", "gstatic.com",
)


def is_id_segment(segment: str) -> bool:
    """Whether a path segment is an id the pattern should collapse to `*`: a number, a uuid, a
    long hex string (a Mongo ObjectId, a hash) or a long opaque token that holds a digit."""
    s = segment.strip()
    if not s:
        return False
    if _NUMERIC.match(s) or _UUID.match(s):
        return True
    if _HEX_ID.match(s) and any(c.isdigit() for c in s):
        return True
    return bool(_TOKEN_ID.match(s) and any(c.isdigit() for c in s))


def endpoint_pattern(url: str) -> str:
    """A request URL's path pattern: the path alone, query dropped, trailing slash dropped, ids
    as `*`. `https://x.test/api/orders/812?a=1` -> `/api/orders/*`."""
    raw = (url or "").strip()
    path = urlsplit(raw).path if re.match(r"^[a-z][a-z0-9+.-]*://", raw, re.IGNORECASE) else raw.split("?", 1)[0].split("#", 1)[0]
    parts = [p for p in path.split("/") if p]
    out = ["*" if is_id_segment(p) else p for p in parts]
    return "/" + "/".join(out)


def _host(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def is_noise(url: str) -> bool:
    """Requests that are not the app's API: page assets, dev-server files, analytics hosts."""
    host = _host(url)
    if host and any(host == h or host.endswith("." + h) for h in _NOISE_HOSTS):
        return True
    try:
        path = urlsplit(url).path if "://" in url else url.split("?", 1)[0]
    except ValueError:
        path = url.split("?", 1)[0]
    if _STATIC.search(path):
        return True
    return any(n in path for n in _NOISE_PATHS)
