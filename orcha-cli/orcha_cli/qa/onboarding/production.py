"""Whether a URL looks like production, from its host and the variable that holds it (ported from
`environment/production.py`, the part `onboarding.backends` reads). No network."""

from __future__ import annotations

import ipaddress
import re
from collections.abc import Iterable
from urllib.parse import urlsplit

#: Words in a host or an environment name that say "not production".
NON_PROD_MARKERS = frozenset({
    "staging", "stage", "stg", "dev", "develop", "development", "test", "testing", "qa", "uat",
    "preview", "sandbox", "demo", "local", "localhost", "int", "integration", "beta", "canary",
})
#: Longer markers also found inside a token (`manage-staging` splits, `mystaging` does not).
_EMBEDDED_MARKERS = ("staging", "sandbox", "preview", "localhost", "develop")
#: Words in an environment name that say "production".
PROD_NAMES = frozenset({"prod", "production", "live"})
#: Development-only TLDs.
_LOCAL_TLDS = frozenset({"local", "localhost", "test", "internal", "lan", "home", "example", "invalid"})


def _tokens(text: str | None) -> list[str]:
    return [t for t in re.split(r"[^a-z0-9]+", (text or "").lower()) if t]


def host_of(url: str | None) -> str:
    """The lowercased hostname of `url` (a bare host is accepted), or ""."""
    raw = (url or "").strip()
    if not raw:
        return ""
    if "://" not in raw:
        raw = f"http://{raw}"
    try:
        return (urlsplit(raw).hostname or "").lower()
    except ValueError:
        return ""


def is_local_host(host: str) -> bool:
    """Loopback, private, link-local and development-only hosts (localhost, 10.0.2.2, *.test)."""
    if not host:
        return False
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        ip = ipaddress.ip_address(host.strip("[]"))
        return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_unspecified
    except ValueError:
        pass
    return host.rsplit(".", 1)[-1] in _LOCAL_TLDS or "." not in host


def has_non_prod_marker(text: str | None) -> bool:
    for t in _tokens(text):
        if t in NON_PROD_MARKERS or any(m in t for m in _EMBEDDED_MARKERS):
            return True
    return False


def looks_like_production(name: str | None, url: str | None, known_production_hosts: Iterable[str] = ()) -> bool:
    """The default for an environment's production flag. A known production host always is; a
    local/private host never is; a marker (staging, dev, test, qa, local, ...) in the host or
    the name says not; a name that says prod/production/live says yes; otherwise a public URL
    with no marker is treated as production and an environment with no URL (a mobile one)
    as not, since there is nothing to go on. The person can always correct it."""
    host = host_of(url)
    if host and host in {h.lower() for h in known_production_hosts}:
        return True
    if host and is_local_host(host):
        return False
    if has_non_prod_marker(host) or has_non_prod_marker(name):
        return False
    if any(t in PROD_NAMES for t in _tokens(name)):
        return True
    return bool(host)
