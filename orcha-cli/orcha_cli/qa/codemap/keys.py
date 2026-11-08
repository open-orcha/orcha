"""Keys, so the code, the tests and the runs meet on one node (adapted from `app_map/keys.py`).

- A screen with a route is keyed by the route with its ids collapsed (`/listings/*`): Next
  `[id]`, Express `:id`, `{id}` and `$id` segments and real ids (`812`, a uuid) all become `*`.
  A native screen is keyed by its name without the screen kind (`code.screen_key`:
  `ListingDetailView`, `ListingDetailScreen` and `ListingDetailPage` are all `listing-detail`;
  a test's `ListingDetailRobot` too).
- An endpoint is `METHOD pattern` (`code.endpoint_key`, `*` when the method is unknown).
- An entity is its model name, singular, lower case, words joined by `_` (`code.entity_key`:
  `Listing`, `listings`, `listing_table` are all `listing`).

The code readers own these rules (`app_map/code.py`); this module adds what runs and tests need.

A route a run or a test visited is resolved against the routes the map already knows
(`resolve_route`), so `/listings/a-cosy-flat` meets `/listings/*` and `/en/listings` meets
`/listings` when the code has no locale segment.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

from orcha_cli.qa.codemap import code
from orcha_cli.qa.codemap.code import collapse_route, endpoint_key, entity_key

__all__ = [
    "collapse_route", "endpoint_key", "entity_key", "humanize", "is_endpoint_key", "node_id",
    "resolve_endpoint", "resolve_route", "route_key", "route_label", "route_matches", "screen_key",
    "split_endpoint_key",
]

#: Test page-object endings the code's screen names never have (`DashboardRobot`).
_TEST_SUFFIX = re.compile(r"(?:Robot|PO)$")
#: A route segment that is only a language (`/en/listings`, `/pt-BR/listings`).
LOCALE = re.compile(r"^[a-z]{2}(?:[-_][A-Za-z]{2,4})?$")
_DYNAMIC = re.compile(r"^(?:\[.*\]|:.+|\{.*\}|\$.+|<.+>)$")
_METHOD = re.compile(r"^(?:[A-Z]+|\*) /")


def node_id(kind: str, key: str) -> str:
    """The id a node has in the JSON the site reads: `screen:listing-detail`."""
    return f"{kind}:{key}"


def route_key(path: str) -> str:
    """`/listings/[id]/` (code), `/listings/812?tab=1` (a run) -> `/listings/*`. Route groups
    (`(app)`) drop out."""
    raw = str(path or "").strip()
    if not raw:
        return "/"
    if "://" in raw:
        raw = "/" + raw.split("://", 1)[1].partition("/")[2]
    raw = raw.split("?", 1)[0].split("#", 1)[0]
    parts = [p for p in raw.split("/") if p and not (p.startswith("(") and p.endswith(")"))]
    parts = ["*" if _DYNAMIC.match(p) else p for p in parts]
    return collapse_route("/" + "/".join(parts))


def screen_key(name: str) -> str:
    """`ListingDetailView` -> `listing-detail`; `SettingsScreen`, `SettingsRobot` -> `settings`.
    A route is keyed by `route_key` instead."""
    stripped = _TEST_SUFFIX.sub("", name.strip())
    return code.screen_key(stripped or name)


def humanize(key_or_name: str) -> str:
    """A label from a key or a type name: `listing-detail` / `ListingDetailView` -> "Listing
    detail"; a route stays a route."""
    text = str(key_or_name or "").strip()
    if not text or text.startswith("/") or _METHOD.match(text):
        return text or "Screen"
    words = screen_key(text).replace("-", " ").strip()
    return words[:1].upper() + words[1:] if words else text


_PAGE_FILE = re.compile(r"\.(?:html?|php|aspx?|jsp)$", re.I)


def route_label(route: str) -> str:
    """A label for a screen known only by its route: `/listings` -> "Listings", `/listings/*`
    -> "Listings detail", `/` -> "Home". A static site's page reads as its page:
    `/orders.html` -> "Orders", `/index.html` -> "Home"."""
    parts = [_PAGE_FILE.sub("", p) for p in route.split("/") if p]
    if parts and parts[-1].lower() in ("index", "default"):
        parts = parts[:-1]
    named = [p for p in parts if p != "*"]
    if not named:
        return "Home" if not parts else "Detail"
    base = humanize(named[-1])
    return f"{base} detail" if parts[-1] == "*" else base


def route_matches(route: str, pattern: str) -> bool:
    """Whether a concrete route fits a route pattern segment by segment (`*` is any one)."""
    a = [s for s in route.split("/") if s]
    b = [s for s in pattern.split("/") if s]
    return len(a) == len(b) and all(p == "*" or p == s for s, p in zip(a, b))


def _best(route: str, known: list[str]) -> str | None:
    if route in known:
        return route
    fits = [k for k in known if route_matches(route, k)]
    # The most specific pattern: fewest wildcards, then the longest.
    return min(fits, key=lambda k: (k.count("*"), -len(k), k)) if fits else None


def resolve_route(route: str, known: Iterable[str]) -> str:
    """The key a visited route takes: a known route pattern it fits (also once a leading locale
    segment is dropped), else its own collapsed form."""
    key = route_key(route)
    patterns = sorted(set(known))
    hit = _best(key, patterns)
    if hit:
        return hit
    parts = [p for p in key.split("/") if p]
    if parts and LOCALE.match(parts[0]):
        hit = _best("/" + "/".join(parts[1:]), patterns)
        if hit:
            return hit
    return key


def split_endpoint_key(key: str) -> tuple[str, str]:
    """`GET /api/listings/*` -> (`GET`, `/api/listings/*`)."""
    method, _, pattern = str(key).partition(" ")
    return method, pattern or "/"


def is_endpoint_key(text: str) -> bool:
    return bool(_METHOD.match(str(text or "")))


def resolve_endpoint(method: str, path: str, known: Iterable[str]) -> str:
    """The key a request takes: the known endpoint its method and path fit (an exact method
    first, then one the code left as `*`, also once a base path is dropped; a `*` request takes
    the only method known on its path), else its own `METHOD pattern`."""
    own = endpoint_key(method, path)
    method, pattern = split_endpoint_key(own)
    by_method: dict[str, list[str]] = {}
    for k in known:
        m, p = split_endpoint_key(k)
        by_method.setdefault(m, []).append(p)
    parts = [p for p in pattern.split("/") if p]
    # The path as sent, then without one or two leading segments: a client with a base path
    # (`/api`, `/api/v1`) calls `/api/homepage-data` for the `/homepage-data` its code names.
    for drop in range(0, min(2, len(parts) - 1) + 1):
        path = "/" + "/".join(parts[drop:])
        for m in (method, "*"):
            hit = _best(path, by_method.get(m, []))
            if hit:
                return f"{m} {hit}"
    if method == "*":
        # A mock or a call that does not say its method meets the one known method on its path.
        hits = {f"{m} {hit}" for m, patterns in by_method.items() if (hit := _best(pattern, patterns))}
        if len(hits) == 1:
            return hits.pop()
    return own
