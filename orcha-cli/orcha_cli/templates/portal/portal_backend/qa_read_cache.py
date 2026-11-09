"""What the polled QA reads share: a small cache of heavy readings, keyed by a cheap version.

A page polls; the map behind it rarely changes. `get` hands back the last reading while its version
stands, and one thread computes a new one while the others wait for it, so a burst of polls costs one
reading (each is pure Python under the GIL, and enough of them at once slow every route in the
portal). A version is computed from what the reading reads, in a few milliseconds.

Not every write bumps `qa_scenarios.updated_at`, so scenarios are hashed by content. An entry also
expires after `MAX_AGE_S`: a reading may mention how long ago something was.
"""

from __future__ import annotations

import collections
import hashlib
import json
import threading
import time
from typing import Any, Callable, Hashable

from fastapi import Response
from fastapi.encoders import jsonable_encoder

MAX_ENTRIES = 64
MAX_AGE_S = 60.0
_entries: "collections.OrderedDict[Hashable, tuple[str, float, Any]]" = collections.OrderedDict()
_computing: dict[Hashable, threading.Lock] = {}
_guard = threading.Lock()


def _fresh(key: Hashable, version: str) -> tuple[bool, Any]:
    with _guard:
        hit = _entries.get(key)
        if hit and hit[0] == version and time.monotonic() - hit[1] < MAX_AGE_S:
            _entries.move_to_end(key)
            return True, hit[2]
    return False, None


def get(key: Hashable, version: str, compute: Callable[[], Any]) -> Any:
    """The reading for `key` at `version`, computed once however many ask. Callers must not change it."""
    found, value = _fresh(key, version)
    if found:
        return value
    with _guard:
        lock = _computing.setdefault(key, threading.Lock())
    with lock:
        found, value = _fresh(key, version)
        if found:
            return value
        value = compute()
        with _guard:
            _entries[key] = (version, time.monotonic(), value)
            _entries.move_to_end(key)
            while len(_entries) > MAX_ENTRIES:
                gone, _ = _entries.popitem(last=False)
                _computing.pop(gone, None)
    return value


def peek(key: Hashable, version: str) -> Any:
    return _fresh(key, version)[1]


def clear() -> None:
    with _guard:
        _entries.clear()


def json_response(key: Hashable, version: str, compute: Callable[[], Any]) -> Response:
    """The reading already encoded: encoding a large one is most of what a poll costs."""
    body = get(key, version, lambda: json.dumps(jsonable_encoder(compute()), separators=(",", ":")).encode())
    return Response(content=body, media_type="application/json")


def _stamp(cur, query: str, cid: str) -> str:
    cur.execute(query, (cid,))
    return "|".join(str(v) for v in dict(cur.fetchone() or {}).values())


def map_version(cur, cid: str) -> str:
    """Changes when the map, or what covers it, does: its nodes, edges, scenarios and their walks."""
    parts = [_stamp(cur, f"SELECT count(*) AS n, max(updated_at) AS at FROM {t} WHERE container_id=%s", cid)
             for t in ("qa_map_nodes", "qa_map_edges")]
    parts.append(_stamp(cur, "SELECT count(*) AS n, max(ended_at) AS a, max(started_at) AS b FROM qa_walks WHERE container_id=%s AND scenario_id IS NOT NULL", cid))
    cur.execute("SELECT id, status, name, tags, source, walk_id, platform FROM qa_scenarios WHERE container_id=%s ORDER BY id", (cid,))
    parts.append(hashlib.sha1("".join(str(list(dict(r).values())) for r in cur.fetchall()).encode()).hexdigest())
    return hashlib.sha1("\n".join(parts).encode()).hexdigest()[:16]


def live_version(cur, cid: str) -> str:
    """`map_version` and what a running session adds to the map and atlas pages."""
    parts = [map_version(cur, cid)]
    parts += [_stamp(cur, f"SELECT count(*) AS n, max(updated_at) AS at FROM {t} WHERE container_id=%s", cid) for t in ("qa_features", "qa_targets")]
    parts.append(_stamp(cur, "SELECT count(*) AS n, max(started_at) AS a, max(ended_at) AS b, max(status) AS s FROM qa_map_builds WHERE container_id=%s", cid))
    # Not last_seen_at: a heartbeat changes neither page, and it would throw the reading away every time.
    parts.append(_stamp(cur, "SELECT count(*) AS n, max(started_at) AS a, max(ended_at) AS b FROM qa_sessions WHERE container_id=%s", cid))
    parts.append(_stamp(cur, """SELECT count(*) AS n FROM qa_steps WHERE session_id IN
                                (SELECT id FROM qa_sessions WHERE container_id=%s AND status='running')""", cid))
    parts.append(_stamp(cur, "SELECT count(*) AS n FROM qa_verdicts WHERE container_id=%s", cid))
    parts.append(_stamp(cur, "SELECT updated_at FROM qa_onboarding WHERE container_id=%s", cid))
    return hashlib.sha1("\n".join(parts).encode()).hexdigest()[:16]
