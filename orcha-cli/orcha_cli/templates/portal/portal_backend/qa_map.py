"""Orcha QA app map: import/merge per source, and meeting a live native screen with a node.

Adapted from `app_map/store.py` (per-source parts) and `app_map/live.py`
(native matching). A node or edge keeps every source's part apart, `evidence[source]` and
`detail[source]`, so a rebuild of one source never erases what another said:

- `import_map(..., replace_source=False)` joins each listed row's part with what that source
  said before (lists join, dicts fold, plain values take the newer one).
- `replace_source=True` makes the payload everything the source says now: its part goes from
  every row it no longer lists, and a row nobody speaks for any more is deleted (edges with it).

`observe` resolves one live capture (texts in reading order, anchors) on an iOS/Android
screen. Route-less, like the original native path: the capture first loses what is not the app's
screen (status bar, keyboard, tab bar, counts); what is left is scored against the static texts
the code reader stored on each screen (`TextIndex`); else a declared screen named by its title;
else a screen sessions already saw (most of the same distinctive anchors, or the same title);
else it gets a key of its own (`seen-<hash>`). The node is marked `seen` and a `navigates` edge
labelled with the action joins it to the screen it was reached from.

Payload shapes (POST /map/import), all optional but `kind` and `key`:
  node  {kind, key, label?, feature_key?, evidence?, detail?}   detail of a code screen may carry
        texts[], texts_own (how many of texts are its own), title, alerts[], name
  edge  {kind, from_key, to_key, from_kind?='screen', to_kind?='screen', label?, evidence?, detail?}
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import math
import re
from collections import Counter
from dataclasses import dataclass
from typing import Any, Optional

from fastapi import HTTPException

from portal_backend import qa_store as qs

#: A build that said it started and has not ended after this long stopped without saying so.
BUILD_LOST_MINUTES = 15
BUILD_LOST = "It stopped before it finished."
from portal_backend.qa_map_cover import add_coverage, source_summaries

SOURCES = ("code", "tests", "live", "crawl", "agent")
#: Whose name a node takes when several sources name it.
LABEL_ORDER = ("code", "tests", "live", "crawl", "agent")
NODE_KINDS = ("screen", "endpoint", "entity", "flow")
EDGE_KINDS = ("navigates", "calls", "reads", "writes", "steps")
#: Most items a list in a part keeps, and session ids a live part remembers.
LIST_KEPT = 30
SESSIONS_KEPT = 20
#: Detail keys whose newest value replaces the old one instead of joining it.
REPLACED = frozenset({"anchors", "steps", "fields", "order", "route", "platform", "side", "handler", "store",
                      "name", "title", "label", "texts", "texts_own", "alerts"})
#: Detail keys that are bookkeeping for matching, left out of what the API shows.
PRIVATE = frozenset({"hashes", "files", "texts", "texts_own"})
#: A screen named for the container it is (`MainTabView`): what sessions saw names it better.
CONTAINER = re.compile(r"^(?:main|root|app|content|tab|tabs|tab bar|main tab|home tab|container|shell|navigation"
                       r"|nav host)(?: view| screen)?$", re.IGNORECASE)


# ======================================================================== merging parts

def _union(old: list, new: list, limit: int = LIST_KEPT) -> list:
    out = list(old)
    seen = {json.dumps(x, sort_keys=True, default=str) for x in out}
    for x in new:
        k = json.dumps(x, sort_keys=True, default=str)
        if k not in seen:
            seen.add(k)
            out.append(x)
    return out[:limit]


def combine(old: Any, new: Any) -> Any:
    """Two evidence parts of one source as one: lists join, dicts fold, else the newer wins."""
    if new is None:
        return old
    if old is None:
        return new
    if isinstance(old, list) and isinstance(new, list):
        return _union(old, new)
    if isinstance(old, dict) and isinstance(new, dict):
        return combine_detail(old, new)
    return new


def combine_detail(old: Optional[dict], new: Optional[dict]) -> dict:
    out = dict(old or {})
    for k, v in (new or {}).items():
        if v is None:
            continue
        cur = out.get(k)
        if k in REPLACED or cur is None:
            out[k] = v
        elif isinstance(cur, list) and isinstance(v, list):
            out[k] = _union(cur, v)
        elif isinstance(cur, dict) and isinstance(v, dict):
            out[k] = combine_detail(cur, v)
        else:
            out[k] = v
    return out


def _seen(evidence: dict) -> bool:
    for s in ("live", "crawl"):
        part = evidence.get(s)
        if isinstance(part, dict) and (int(part.get("sightings") or 0) > 0 or int(part.get("runs") or 0) > 0):
            return True
    return False


def derive_node(kind: str, key: str, evidence: dict, detail: dict, *, feature_key: Optional[str],
                blocked_kind: Optional[str]) -> dict:
    """The columns a node's parts decide."""
    sources = [s for s in SOURCES if s in evidence or s in detail]
    labels = {s: str(detail[s]["label"]) for s in LABEL_ORDER
              if isinstance(detail.get(s), dict) and detail[s].get("label")}
    label = next(iter(labels.values()), None)
    if kind == "screen" and label and CONTAINER.match(label) and labels.get("live"):
        label = labels["live"]
    feature = next((str(detail[s]["feature"]) for s in LABEL_ORDER
                    if isinstance(detail.get(s), dict) and detail[s].get("feature")), None)
    state = "seen" if _seen(evidence) else ("blocked" if blocked_kind else "declared")
    return {"label": (label or humanize(key))[:300], "feature_key": feature or feature_key, "state": state,
            "sources": sources}


def derive_edge(evidence: dict, detail: dict) -> dict:
    live = evidence.get("live") if isinstance(evidence.get("live"), dict) else {}
    return {"sources": [s for s in SOURCES if s in evidence or s in detail], "count": int(live.get("count") or 0)}


def humanize(key: str) -> str:
    text = str(key or "").strip()
    if not text or text.startswith("/"):
        return text or "Screen"
    words = qs.slug(text).replace("-", " ").strip()
    return words[:1].upper() + words[1:] if words else text


def _same(a: Any, b: Any) -> bool:
    return json.dumps(a, sort_keys=True, default=str) == json.dumps(b, sort_keys=True, default=str)


# ======================================================================== import

def _nodes(cur, cid: str, platform: str) -> dict[tuple[str, str], dict]:
    cur.execute("SELECT * FROM qa_map_nodes WHERE container_id=%s AND platform=%s", (cid, platform))
    out = {}
    for r in cur.fetchall():
        r = dict(r)
        r["evidence"] = qs._json(r.get("evidence"), {})
        r["detail"] = qs._json(r.get("detail"), {})
        r["sources"] = qs._json(r.get("sources"), [])
        out[(r["kind"], r["key"])] = r
    return out


def _edges(cur, cid: str, platform: str) -> dict[tuple[str, str, str, str], dict]:
    cur.execute("SELECT * FROM qa_map_edges WHERE container_id=%s AND platform=%s", (cid, platform))
    out = {}
    for r in cur.fetchall():
        r = dict(r)
        r["evidence"] = qs._json(r.get("evidence"), {})
        r["detail"] = qs._json(r.get("detail"), {})
        r["sources"] = qs._json(r.get("sources"), [])
        out[(r["kind"], str(r["from_node_id"]), str(r["to_node_id"]), r["label"])] = r
    return out


def _write_node(cur, row: dict, values: dict, evidence: dict, detail: dict, at) -> None:
    cur.execute(
        """UPDATE qa_map_nodes SET label=%s, feature_key=%s, state=%s, sources=%s, evidence=%s, detail=%s,
                  updated_at=%s WHERE id=%s""",
        (values["label"], values["feature_key"], values["state"], qs.dumps(values["sources"]),
         qs.dumps(evidence), qs.dumps(detail), at, str(row["id"])),
    )


def _insert_node(cur, cid: str, platform: str, kind: str, key: str, values: dict, evidence: dict,
                 detail: dict, at, *, blocked_kind=None, blocked_reason=None, frame_id=None,
                 last_seen_at=None) -> str:
    nid = qs.new_id()
    cur.execute(
        """INSERT INTO qa_map_nodes (id, container_id, platform, kind, key, label, feature_key, state, blocked_kind,
                                     blocked_reason, sources, evidence, detail, frame_id, last_seen_at,
                                     created_at, updated_at)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (nid, cid, platform, kind, key, values["label"], values["feature_key"], values["state"], blocked_kind,
         blocked_reason, qs.dumps(values["sources"]), qs.dumps(evidence), qs.dumps(detail), frame_id,
         last_seen_at, at, at),
    )
    return nid


def _part(item: dict, source: str) -> tuple[Any, dict]:
    detail = dict(item.get("detail") or {})
    if item.get("label"):
        detail["label"] = item["label"]
    if item.get("feature_key"):
        detail["feature"] = item["feature_key"]
    return item.get("evidence"), detail


def import_map(cur, cid: str, platform: str, source: str, *, nodes: list[dict], edges: list[dict],
               features: list[dict], replace_source: bool, agent_id: Optional[str]) -> dict:
    if source not in SOURCES:
        raise HTTPException(400, f"source must be one of {', '.join(SOURCES)}")
    at = qs.now()
    counts = {"nodes_added": 0, "nodes_changed": 0, "nodes_removed": 0, "edges_added": 0, "edges_changed": 0,
              "edges_removed": 0, "edges_skipped": 0, "features": 0}
    if features:
        fsource = "code" if source in ("code", "tests") else "exploration"
        counts["features"] = len(set_features(cur, cid, features, fsource))

    existing = _nodes(cur, cid, platform)
    wanted: dict[tuple[str, str], dict] = {}
    for item in nodes:
        ident = (item["kind"], item["key"])
        ev, det = _part(item, source)
        if ident in wanted:  # the same node twice in one payload is one, both parts joined
            prev = wanted[ident]
            wanted[ident] = {"evidence": combine(prev["evidence"], ev), "detail": combine_detail(prev["detail"], det)}
        else:
            wanted[ident] = {"evidence": ev, "detail": det}

    ids: dict[tuple[str, str], str] = {}
    removed: set[str] = set()
    for ident, row in existing.items():
        fact = wanted.get(ident)
        if fact is None and not (replace_source and (source in row["evidence"] or source in row["detail"])):
            ids[ident] = str(row["id"])
            continue
        evidence, detail = dict(row["evidence"]), dict(row["detail"])
        if fact is None:
            evidence.pop(source, None)
            detail.pop(source, None)
        else:
            evidence[source] = fact["evidence"] if replace_source else combine(evidence.get(source), fact["evidence"])
            detail[source] = fact["detail"] if replace_source else combine_detail(detail.get(source), fact["detail"])
            if evidence[source] is None:
                evidence.pop(source)
        values = derive_node(row["kind"], row["key"], evidence, detail, feature_key=row.get("feature_key"),
                             blocked_kind=row.get("blocked_kind"))
        if not values["sources"]:
            removed.add(str(row["id"]))
            continue
        ids[ident] = str(row["id"])
        current = {"label": row["label"], "feature_key": row.get("feature_key"), "state": row["state"],
                   "sources": row["sources"], "evidence": row["evidence"], "detail": row["detail"]}
        if not _same(current, {**values, "evidence": evidence, "detail": detail}):
            _write_node(cur, row, values, evidence, detail, at)
            counts["nodes_changed"] += 1
    for nid in sorted(removed):
        cur.execute("DELETE FROM qa_map_nodes WHERE id=%s", (nid,))
    counts["nodes_removed"] = len(removed)
    for ident, fact in wanted.items():
        if ident in existing:
            continue
        evidence = {source: fact["evidence"]} if fact["evidence"] is not None else {}
        detail = {source: fact["detail"]}
        values = derive_node(ident[0], ident[1], evidence, detail, feature_key=None, blocked_kind=None)
        ids[ident] = _insert_node(cur, cid, platform, ident[0], ident[1], values, evidence, detail, at)
        counts["nodes_added"] += 1

    old_edges = {k: e for k, e in _edges(cur, cid, platform).items()
                 if k[1] not in removed and k[2] not in removed}
    want_edges: dict[tuple[str, str, str, str], dict] = {}
    for item in edges:
        a = ids.get((item.get("from_kind") or "screen", item["from_key"]))
        b = ids.get((item.get("to_kind") or "screen", item["to_key"]))
        if not a or not b:
            counts["edges_skipped"] += 1
            continue
        ident = (item["kind"], a, b, item.get("label") or "")
        want_edges[ident] = {"evidence": item.get("evidence"), "detail": dict(item.get("detail") or {})}
    for ident, row in old_edges.items():
        fact = want_edges.get(ident)
        if fact is None and not (replace_source and (source in row["evidence"] or source in row["detail"])):
            continue
        evidence, detail = dict(row["evidence"]), dict(row["detail"])
        if fact is None:
            evidence.pop(source, None)
            detail.pop(source, None)
        else:
            evidence[source] = fact["evidence"] if replace_source else combine(evidence.get(source), fact["evidence"])
            detail[source] = fact["detail"] if replace_source else combine_detail(detail.get(source), fact["detail"])
            if evidence[source] is None:
                evidence.pop(source)
        values = derive_edge(evidence, detail)
        if not values["sources"]:
            cur.execute("DELETE FROM qa_map_edges WHERE id=%s", (str(row["id"]),))
            counts["edges_removed"] += 1
        elif not _same({"sources": row["sources"], "count": row["count"], "evidence": row["evidence"],
                        "detail": row["detail"]}, {**values, "evidence": evidence, "detail": detail}):
            cur.execute("UPDATE qa_map_edges SET sources=%s, count=%s, evidence=%s, detail=%s, updated_at=%s "
                        "WHERE id=%s",
                        (qs.dumps(values["sources"]), values["count"], qs.dumps(evidence), qs.dumps(detail), at,
                         str(row["id"])))
            counts["edges_changed"] += 1
    for ident, fact in want_edges.items():
        if ident in old_edges:
            continue
        evidence = {source: fact["evidence"]} if fact["evidence"] is not None else {}
        detail = {source: fact["detail"]}
        values = derive_edge(evidence, detail)
        cur.execute(
            """INSERT INTO qa_map_edges (id, container_id, platform, kind, from_node_id, to_node_id, label, count,
                                         sources, evidence, detail, created_at, updated_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (qs.new_id(), cid, platform, ident[0], ident[1], ident[2], ident[3], values["count"],
             qs.dumps(values["sources"]), qs.dumps(evidence), qs.dumps(detail), at, at),
        )
        counts["edges_added"] += 1

    cur.execute("""UPDATE qa_map_builds SET status='done', counts=%s, ended_at=%s
                    WHERE container_id=%s AND platform=%s AND source=%s AND status='running'""",
                (qs.dumps(counts), qs.now(), cid, platform, source))
    if cur.rowcount <= 0:
        cur.execute(
            """INSERT INTO qa_map_builds (id, container_id, platform, source, status, counts, started_at, ended_at,
                                          agent_id)
               VALUES (%s,%s,%s,%s,'done',%s,%s,%s,%s)""",
            (qs.new_id(), cid, platform, source, qs.dumps(counts), at, qs.now(), agent_id),
        )
    return counts


def start_build(cur, cid: str, platform: str, source: str, agent_id: Optional[str]) -> str:
    """A build under way: the map shows it until its import ends it. One that never ended (its
    reader died) is closed as failed, so a new one starts clean."""
    cur.execute("""UPDATE qa_map_builds SET status='failed', error=%s, ended_at=%s
                    WHERE container_id=%s AND platform=%s AND source=%s AND status='running'""",
                (BUILD_LOST, qs.now(), cid, platform, source))
    bid = qs.new_id()
    cur.execute(
        """INSERT INTO qa_map_builds (id, container_id, platform, source, status, counts, started_at, agent_id)
           VALUES (%s,%s,%s,%s,'running','{}',%s,%s)""",
        (bid, cid, platform, source, qs.now(), agent_id),
    )
    return bid


def _live_build(build: Optional[dict]) -> Optional[dict]:
    """A build still running after `BUILD_LOST_MINUTES` is one whose reader died: it reads as failed."""
    if build and build.get("status") == "running":
        started = _dt.datetime.fromisoformat(str(build["started_at"]).replace("Z", "+00:00"))
        if qs.now() - started > _dt.timedelta(minutes=BUILD_LOST_MINUTES):
            return {**build, "status": "failed", "error": BUILD_LOST}
    return build


# ======================================================================== features

def set_features(cur, cid: str, features: list[dict], source: str) -> list[dict]:
    """Upsert features by key (from the name when missing). Never deletes one."""
    if len(features) > 30:
        raise HTTPException(400, "at most 30 features at a time")
    at = qs.now()
    out = []
    for f in features:
        key = qs.slug(f.get("key") or f["name"])
        if not key:
            raise HTTPException(400, f"feature {f['name']!r} has no usable key")
        cur.execute("SELECT id FROM qa_features WHERE container_id=%s AND key=%s", (cid, key))
        row = cur.fetchone()
        if row:
            fid = str(row["id"])
            cur.execute("""UPDATE qa_features SET name=%s, summary=%s, entry=%s, paths=%s, source=%s, updated_at=%s
                            WHERE id=%s""",
                        (f["name"], f.get("summary"), f.get("entry"), qs.dumps(f.get("paths") or []), source, at,
                         fid))
        else:
            fid = qs.new_id()
            cur.execute("""INSERT INTO qa_features (id, container_id, key, name, summary, entry, paths, source,
                                                    created_at, updated_at)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                        (fid, cid, key, f["name"], f.get("summary"), f.get("entry"), qs.dumps(f.get("paths") or []),
                         source, at, at))
        cur.execute("SELECT * FROM qa_features WHERE id=%s", (fid,))
        out.append(qs.public(cur.fetchone()))
    return out


# ======================================================================== reading

def _shown_detail(detail: dict) -> dict:
    return {s: ({k: v for k, v in part.items() if k not in PRIVATE} if isinstance(part, dict) else part)
            for s, part in (detail or {}).items()}


def node_public(row: dict) -> dict:
    out = qs.public(row)
    out["detail"] = _shown_detail(out.get("detail") or {})
    return out


def read_map(cur, cid: str, platform: str) -> dict:
    cur.execute("SELECT * FROM qa_features WHERE container_id=%s ORDER BY name", (cid,))
    features = [qs.public(r) for r in cur.fetchall()]
    cur.execute("SELECT * FROM qa_map_nodes WHERE container_id=%s AND platform=%s ORDER BY kind, key",
                (cid, platform))
    nodes = [node_public(r) for r in cur.fetchall()]
    keys = {n["id"]: n["key"] for n in nodes}
    cur.execute("SELECT * FROM qa_map_edges WHERE container_id=%s AND platform=%s ORDER BY kind, label",
                (cid, platform))
    edges = []
    for r in cur.fetchall():
        e = qs.public(r)
        e["detail"] = _shown_detail(e.get("detail") or {})
        e["from_key"], e["to_key"] = keys.get(e["from_node_id"]), keys.get(e["to_node_id"])
        edges.append(e)
    cur.execute("SELECT * FROM qa_map_builds WHERE container_id=%s AND platform=%s ORDER BY started_at DESC LIMIT 1",
                (cid, platform))
    last_build = _live_build(qs.public(cur.fetchone()))
    add_coverage(cur, cid, platform, features, nodes, edges)
    # A feature's last exploration: the last time a run stood on one of its screens.
    explored: dict[str, str] = {}
    for n in nodes:
        at, key = n.get("last_seen_at"), n.get("feature_key")
        if n["kind"] == "screen" and at and key:
            explored[key] = max(explored.get(key, ""), str(at))
    for f in features:
        f["last_explored_at"] = explored.get(f["key"])
    return {"platform": platform, "features": features, "nodes": nodes, "edges": edges, "last_build": last_build,
            "sources": source_summaries(cur, cid, platform, nodes, edges)}


# ======================================================================== a native capture
# (the original app_map/live.py: clean_capture, TextIndex, Catalog.place — adapted to one capture)

_STATUS_BAR = re.compile(
    r"\b(?:no signal|signal full|signal strength|(?:one|two|three|four|no) bars?|battery|wi-?fi)\b|^\d{1,2}:\d{2}"
    r"(?:\s?[AP]M)?$|^(?:cellular|airplane mode|location services)$|\bnotification:$", re.IGNORECASE)
_KEYBOARD_WORDS = frozenset({
    "shift", "delete", "caps lock", "tab", "return", "search", "go", "send", "next", "join", "space", "emoji",
    "dictate", "numbers", "more", "next keyboard", "undo", "redo", "paste", "hide keyboard", "dismiss keyboard",
    "abc", "#+=", "globe", "international", "dismiss popup", "emoji button", "symbol keyboard", "?123", "period",
    "comma", "enter", "open features menu", "clipboard", "translate", "use voice typing", "voice typing",
})
_KEYBOARD_TOOLBAR = "open features menu"
_KEY_ROWS = (("q", "w", "e"), ("a", "z", "e"), ("q", "w", "e", "r"))
KEYBOARD_SUGGESTIONS = 3
_NUMERIC = re.compile(r"^[\d\s.,:%+\-–—/·×]*$")
_QUOTED = re.compile(r"^[“\"«].*[”\"»]$")
TAB_BAR = "tab bar"
_SEARCH_CONTROLS = frozenset({"close search", "clear search", "cancel search"})
_MENU = "dismiss context menu"
_SYSTEM_SCREEN = re.compile(r"^(?:\d+ apps|Dock|App Library|\w[\w ]* folder|At a glance|Predicted app: .+)$")
_DATA = re.compile(r"\bQA[-_ ]?[0-9A-Fa-f]{2,}|\d")
TAB_RUN = 3
_CONTROLS = frozenset({
    "back", "cancel", "close", "done", "save", "next", "next page", "previous page", "skip", "ok", "edit", "menu",
    "more", "search", "close search", "dismiss", "continue", "submit", "add", "delete", "share", "settings ⌘,",
    "close sheet", "drag handle", "go back", "navigate up", "close dialog", "dismiss popup", "dismiss context menu", "clear text",
    "on", "off", "yes", "no", "refresh", "retry",
})
#: Share of distinctive anchors two captures need in common to be one screen, or with the same title.
SAME_SCREEN = 0.5
SAME_TITLE = 0.2
#: An anchor on at least this share of the distinct screens is chrome (needs CHROME_MIN screens).
CHROME_SHARE = 0.3
CHROME_MIN = 5
LIST_ANCHORS = 30
TITLE_WEIGHT = 1.0
MIN_SCORE = 1.0
MIN_STRINGS = 2
TITLE_SPAN = 3
RENDERED_WEIGHT = 0.5
PIECE_WEIGHT = 0.5
PATTERN_WEIGHT = 0.8
_SUFFIX_WORDS = {"view", "screen", "page", "controller", "tab", "vc", "activity", "fragment", "component", "route"}


def _keyboard_noise(text: str) -> bool:
    t = text.strip()
    return len(t) <= 1 or t.lower() in _KEYBOARD_WORDS or bool(_NUMERIC.match(t)) or bool(_QUOTED.match(t))


def keyboard_start(texts: list[str]) -> Optional[int]:
    """Where the on-screen keyboard starts in `texts`, or None when no keyboard is up."""
    low = [t.strip().lower() for t in texts]
    keys_only = [(i, t) for i, t in enumerate(low) if not t.isdigit()]
    for n, (i, _) in enumerate(keys_only):
        if not any(tuple(t for _, t in keys_only[n: n + len(row)]) == row for row in _KEY_ROWS):
            continue
        if _KEYBOARD_TOOLBAR in low[:i]:
            return low.index(_KEYBOARD_TOOLBAR)
        j, free = i, KEYBOARD_SUGGESTIONS
        while j > 0:
            prev = texts[j - 1].strip()
            if prev.lower() == TAB_BAR:
                break
            if _keyboard_noise(prev):
                j -= 1
            elif free and " " not in prev and len(prev) <= 6:
                free -= 1
                j -= 1
            else:
                break
        return j
    return None


@dataclass
class Capture:
    texts: list[str]
    anchors: list[str]
    tabs: list[str]
    states: list[str]


def clean_capture(texts: list[str], anchors: list[str], tabs: Optional[set[str]] = None) -> Capture:
    """A native capture without the device's and the keyboard's own texts, the tab bar (after an
    iOS "Tab Bar", or a run of known tab names), index letters and counts."""
    tabs = tabs or set()
    states: list[str] = []
    texts = [t for t in texts if not _STATUS_BAR.search(t)]
    if any(_SYSTEM_SCREEN.match(t.strip()) for t in texts):
        return Capture([], [], [], ["system"])
    k = keyboard_start(texts)
    if k is not None:
        states.append("keyboard")
        rest = texts[k:]
        if rest and rest[0].strip().lower() == _KEYBOARD_TOOLBAR:
            rest = rest[next((n for n, t in enumerate(rest) if len(t.strip()) == 1), len(rest)):]
        texts = texts[:k] + [t for t in rest if not _keyboard_noise(t) and len(t.strip()) > 2]
    bar: list[str] = []
    low = [t.strip().lower() for t in texts]
    if TAB_BAR in low:
        i = low.index(TAB_BAR)
        bar = [t for t in texts[i + 1:] if not _NUMERIC.match(t.strip())]
        texts = texts[:i]
    known = tabs | set(bar)
    keep = [True] * len(texts)
    i = 0
    while i < len(texts):
        if texts[i] not in known:
            i += 1
            continue
        j, names = i, 0
        while j < len(texts) and (texts[j] in known or (names and _NUMERIC.match(texts[j].strip()))):
            names += texts[j] in known
            j += 1
        if names >= TAB_RUN - 1:
            for x in range(i, j):
                keep[x] = False
        i = max(j, i + 1)
    if any(t.strip().lower() == _MENU for t in texts):
        states.append("menu")
    texts = [t for t, ok in zip(texts, keep)
             if ok and len(t.strip()) > 1 and not _NUMERIC.match(t.strip()) and t.strip().lower() != _MENU]
    if any(t.strip().lower() in _SEARCH_CONTROLS for t in texts):
        states.append("search")
    shown = set(texts)
    if shown:
        kept = [a for a in anchors if a in shown]
    else:
        kept = [a for a in anchors if not _STATUS_BAR.search(a) and not _keyboard_noise(a) and a not in known]
    return Capture([t for t in texts if t.strip().lower() not in _KEYBOARD_WORDS], kept, bar, states)


def norm_text(text: str) -> str:
    t = (text.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"').replace("…", "..."))
    return " ".join(t.lower().split()).strip(" .!?:;,")


def text_pieces(text: str) -> list[str]:
    """A live text, then its parts: VoiceOver joins a control's label, value and hint."""
    whole = norm_text(text)
    parts = [norm_text(p) for p in re.split(r"(?<=[.!?])\s+|,\s+|\n|\s+·\s+", text)]
    return [whole] + [p for p in dict.fromkeys(parts) if p and p != whole and len(p) > 1]


def _words(text: Optional[str]) -> list[str]:
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", str(text or ""))
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", s)
    out = [w for w in re.split(r"[^a-z0-9]+", s.lower()) if w]
    while len(out) > 1 and out[-1] in _SUFFIX_WORDS:
        out.pop()
    return out


def _stem(word: str) -> str:
    if len(word) > 4 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def phrase(text: Optional[str]) -> str:
    return " ".join(_stem(w) for w in _words(text))


@dataclass
class CodeMatch:
    key: str
    label: str
    score: float
    strings: list[str]
    alerts: list[str]


class TextIndex:
    """The static texts of the code's screens, to score a capture against each (the original's
    TextIndex). A string only one screen says counts 1 for it, one n screens say counts 1/n; a
    string a screen only says through a component it renders counts RENDERED_WEIGHT; a part of a
    live text or a pattern counts less than a whole literal; list rows ending in the same words
    count those once. The screen's title at the top adds TITLE_WEIGHT, and so does an alert's
    title opening a dialog. The best screen with MIN_STRINGS strings and MIN_SCORE wins."""

    def __init__(self, screens: list[dict]):
        self.screens = {s["key"]: s for s in screens}
        self.exact: dict[str, set[str]] = {}
        self.patterns: list[tuple[re.Pattern, str, set[str]]] = []
        self._pattern_ids: dict[str, int] = {}
        self.by_word: dict[str, set[int]] = {}
        self.owns: dict[tuple[str, str], float] = {}
        self._totals: dict[str, float] = {}
        for s in screens:
            own = s.get("texts_own")
            for i, text in enumerate(s.get("texts") or []):
                n = norm_text(str(text))
                if not n:
                    continue
                share = 1.0 if own is None or i < int(own) else RENDERED_WEIGHT
                self.owns[(s["key"], n)] = max(self.owns.get((s["key"], n), 0.0), share)
                if "*" in n:
                    idx = self._pattern_ids.get(n)
                    if idx is None:
                        literal = re.findall(r"[^\W\d_]{3,}", n.replace("*", " "))
                        if not literal:
                            continue
                        regex = re.compile("^" + ".+".join(re.escape(p) for p in n.split("*")) + "$")
                        idx = self._pattern_ids[n] = len(self.patterns)
                        self.patterns.append((regex, n, set()))
                        self.by_word.setdefault(max(literal, key=len), set()).add(idx)
                    self.patterns[idx][2].add(s["key"])
                else:
                    self.exact.setdefault(n, set()).add(s["key"])

    def __bool__(self) -> bool:
        return bool(self.screens)

    def _share(self, key: str, string: str, keys_: set[str]) -> float:
        total = self._totals.get(string)
        if total is None:
            total = self._totals[string] = math.fsum(self.owns.get((k, string), 1.0) for k in keys_)
        return self.owns.get((key, string), 1.0) / total if total else 0.0

    def _hits(self, piece: str) -> list[tuple[str, set[str], float]]:
        out = []
        keys_ = self.exact.get(piece)
        if keys_:
            out.append((piece, keys_, 1.0))
        words = set(re.findall(r"[^\W\d_]{3,}", piece))
        for idx in sorted({i for w in words for i in self.by_word.get(w, ())}):
            regex, pattern, keys_ = self.patterns[idx]
            if regex.match(piece):
                out.append((pattern, keys_, PATTERN_WEIGHT))
        return out

    def match(self, texts: list[str]) -> Optional[CodeMatch]:
        pieces = {text: text_pieces(text) for text in dict.fromkeys(texts)}
        tails = Counter(p[-1] for p in pieces.values() if len(p) > 1)
        got: dict[str, dict[str, float]] = {}
        for parts in pieces.values():
            if len(parts) > 1 and tails[parts[-1]] > 1:
                parts, whole = [parts[-1]], False
            else:
                whole = True
            best_here: dict[str, tuple[float, str]] = {}
            for n, piece in enumerate(parts):
                factor = 1.0 if n == 0 and whole else PIECE_WEIGHT
                for string, keys_, weight in self._hits(piece):
                    for k in keys_:
                        w = factor * weight * self._share(k, string, keys_)
                        if w > best_here.get(k, (0.0, ""))[0]:
                            best_here[k] = (w, string)
            for k, (w, string) in best_here.items():
                mine = got.setdefault(k, {})
                mine[string] = max(mine.get(string, 0.0), w)
        top = [norm_text(t) for t in texts[:TITLE_SPAN]]
        titled = [k for k in got if norm_text(str(self.screens[k].get("title") or "")) in top]
        first = texts[0].strip().lower() if texts else ""
        dialog = {k for k in got if any(str(a).strip().lower() == first for a in self.screens[k].get("alerts") or [])}
        last = max((top.index(norm_text(str(self.screens[k]["title"]))) for k in titled), default=-1)
        best: Optional[CodeMatch] = None
        best_score = 0.0
        for k, strings in got.items():
            s = self.screens[k]
            title = norm_text(str(s.get("title") or ""))
            score = math.fsum(strings.values()) + (TITLE_WEIGHT if title and k in titled and top.index(title) == last
                                                   else 0.0)
            score += TITLE_WEIGHT / len(dialog) if k in dialog else 0.0
            if len(strings) < MIN_STRINGS or score < MIN_SCORE:
                continue
            if best is None or (score, k) > (best_score, best.key):
                best_score = score
                shown = {t.strip().lower() for t in texts}
                alerts = [a for a in s.get("alerts") or [] if str(a).strip().lower() in shown]
                best = CodeMatch(k, str(s.get("label") or humanize(k)), round(score, 3), sorted(strings), alerts)
        return best


def _title(ordered: list[str]) -> Optional[str]:
    for text in ordered:
        t = text.strip()
        if "\n" in t or not 2 <= len(t) <= 30 or t.lower() in _CONTROLS or t[-1] in ".,:;!…" or _DATA.search(t):
            continue
        if " " not in t and re.search(r"[-_.]", t) and t == t.lower():
            continue
        if t.lower() in _KEYBOARD_WORDS or t.lower() in _SEARCH_CONTROLS:
            continue
        return t
    return None


def _anchor_label(ordered: list[str], title: Optional[str] = None) -> str:
    if title:
        return title
    found = _title(ordered)
    if found:
        return found
    for t in ordered:
        t = t.strip()
        if "\n" not in t and 2 <= len(t) <= 40 and t.lower() not in _CONTROLS and not _DATA.search(t) \
                and "." not in t[:-1]:
            return t
    return "Screen"


def _jaccard(a: set, b: set) -> float:
    return len(a & b) / len(a | b) if a or b else 0.0


def _chrome(anchor_sets: list[set[str]]) -> set[str]:
    if len(anchor_sets) < CHROME_MIN:
        return set()
    counts: Counter = Counter(a for s in anchor_sets for a in s)
    return {a for a, n in counts.items() if n / len(anchor_sets) >= CHROME_SHARE}


@dataclass
class Placed:
    key: str
    label: str
    by: str  # route | code | name | seen | title | new
    states: list[str]
    anchors: list[str]
    title: Optional[str]


def place(nodes: list[dict], code_tabs: set[str], texts: list[str], anchors: list[str], *,
          title_hint: Optional[str] = None, screen_hash: Optional[str] = None) -> Optional[Placed]:
    """Where one capture lands among the platform's screen nodes (see the module docstring), or
    None when it shows nothing of the app (only the device's own texts, or nothing at all)."""
    cap = clean_capture(texts, anchors, code_tabs)
    if not cap.texts and not cap.anchors:
        return None
    title = (title_hint or "").strip() or _title(cap.texts or sorted(cap.anchors))
    shown = cap.texts or sorted(cap.anchors)
    said, names, seen, titles, anchor_sets = [], {}, [], {}, []
    for n in nodes:
        detail = n.get("detail") or {}
        others = [s for s in n.get("sources") or [] if s not in ("live", "crawl")]
        for s in ("code", "tests"):
            part = detail.get(s)
            if isinstance(part, dict) and part.get("texts"):
                said.append({"key": n["key"], "label": n["label"], "title": part.get("title"),
                             "texts": part["texts"], "alerts": part.get("alerts") or [],
                             "texts_own": part.get("texts_own")})
                break
        if others:
            for text in (n["key"], n["label"], *(str((detail.get(s) or {}).get("name") or "") for s in others)):
                ph = phrase(text)
                if ph:
                    names.setdefault(ph, n["key"])
        live = detail.get("live") if isinstance(detail.get("live"), dict) else {}
        if live:
            known = {str(a) for a in live.get("anchors") or []}
            seen.append((n["key"], {str(h) for h in live.get("hashes") or []}, known))
            anchor_sets.append(known)
            if live.get("title"):
                titles.setdefault(str(live["title"]), n["key"])
    index = TextIndex(said)
    hit = index.match(shown) if index else None
    if hit is not None:
        first = cap.texts[0] if cap.texts else None
        label = title if title and title == first and norm_text(title) in hit.strings else hit.label
        return Placed(hit.key, label, "code", cap.states + [f"alert: {a}" for a in hit.alerts], cap.anchors, title)
    if title and len(title) <= 40:
        ph = phrase(title)
        if ph in names:
            key = names[ph]
            label = next((n["label"] for n in nodes if n["key"] == key), humanize(key))
            return Placed(key, label, "name", cap.states, cap.anchors, title)
    chrome = _chrome(anchor_sets)
    own = {a for a in cap.anchors if a not in chrome or a == title} or set(cap.anchors) or set(cap.texts[:LIST_ANCHORS])
    label = _anchor_label([t for t in shown if t in own] + sorted(own - set(shown)), title)
    for key, hashes, known in seen:
        share = _jaccard(own, known)
        if (screen_hash and screen_hash in hashes) or share >= SAME_SCREEN:
            return Placed(key, label, "seen", cap.states, cap.anchors, title)
        if title and share >= SAME_TITLE and title in known:
            return Placed(key, label, "seen", cap.states, cap.anchors, title)
    if title and title in titles:
        return Placed(titles[title], label, "title", cap.states, cap.anchors, title)
    digest = hashlib.sha1("\n".join(sorted(own) if not title else [title]).encode()).hexdigest()[:8]
    return Placed(f"seen-{digest}", label, "new", cap.states, cap.anchors, title)


# ---------- web routes (the original app_map/keys.py, code.collapse_route, api_surface.is_id_segment)

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
_HEX_ID = re.compile(r"^[0-9a-f]{12,}$", re.IGNORECASE)
_TOKEN_ID = re.compile(r"^[A-Za-z0-9_-]{20,}$")
_PARAM_SEGMENT = re.compile(r"^(?:\[\[?(?:\.\.\.)?[^\]]*\]\]?|:\w+\??|\{[^}]*\}|<[^>]*>|\$.+|\*+)$")
#: A route segment that is only a language (`/en/listings`).
LOCALE = re.compile(r"^[a-z]{2}(?:[-_][A-Za-z]{2,4})?$")
NOT_FOUND_KEY = "not-found"
_NOT_FOUND = re.compile(r"\b(?:page not found|not found|doesn['’]t exist|does not exist|could not be found"
                        r"|no longer exists)\b", re.IGNORECASE)


def is_id_segment(segment: str) -> bool:
    """A number, a uuid, a long hex string or a long opaque token that holds a digit."""
    s = segment.strip()
    if not s:
        return False
    if s.isdigit() or _UUID.match(s):
        return True
    if _HEX_ID.match(s) and any(c.isdigit() for c in s):
        return True
    return bool(_TOKEN_ID.match(s) and any(c.isdigit() for c in s))


def route_key(path: str) -> str:
    """`/listings/[id]/`, `/listings/812?tab=1`, `https://x.test/listings/812` -> `/listings/*`.
    Host, query and fragment drop; route groups `(x)` and slots `@x` drop; parameter and id
    segments become `*`."""
    raw = str(path or "").strip()
    if "://" in raw:
        raw = raw.split("://", 1)[1]
        raw = raw[raw.find("/"):] if "/" in raw else "/"
    raw = raw.split("?", 1)[0].split("#", 1)[0]
    parts = [p for p in raw.split("/") if p and not (p.startswith("(") and p.endswith(")")) and not p.startswith("@")]
    return "/" + "/".join("*" if _PARAM_SEGMENT.match(p) or is_id_segment(p) else p for p in parts)


def route_matches(route: str, pattern: str) -> bool:
    a = [x for x in route.split("/") if x]
    b = [x for x in pattern.split("/") if x]
    return len(a) == len(b) and all(q == "*" or q == x for x, q in zip(a, b))


def _best_route(route: str, known: list[str]) -> Optional[str]:
    if route in known:
        return route
    fits = [k for k in known if route_matches(route, k)]
    return min(fits, key=lambda k: (k.count("*"), -len(k), k)) if fits else None


def resolve_route(route: str, known: list[str]) -> tuple[str, bool]:
    """(key, known): the known route pattern a visited route fits (also once a leading locale
    segment is dropped), else its own collapsed form."""
    key = route_key(route)
    patterns = sorted(set(known))
    hit = _best_route(key, patterns)
    if hit is None:
        parts = [x for x in key.split("/") if x]
        if parts and LOCALE.match(parts[0]):
            hit = _best_route("/" + "/".join(parts[1:]), patterns)
    return (hit, True) if hit else (key, False)


def route_label(route: str) -> str:
    """`/listings` -> "Listings", `/listings/*` -> "Listings detail", `/` -> "Home"."""
    parts = [re.sub(r"\.(?:html?|php|aspx?|jsp)$", "", x, flags=re.I) for x in route.split("/") if x]
    if parts and parts[-1].lower() in ("index", "default"):
        parts = parts[:-1]
    named = [x for x in parts if x != "*"]
    if not named:
        return "Home" if not parts else "Detail"
    base = humanize(named[-1])
    return f"{base} detail" if parts[-1] == "*" else base


def is_not_found(texts: list[str], title: Optional[str]) -> bool:
    """The site's own "page not found": a 404 with a not-found line among the first texts."""
    head = [str(t).strip() for t in list(texts or [])[:30]] + ([str(title).strip()] if title else [])
    has_code = any(t == "404" or t.startswith(("404 ", "404:")) or t.endswith(" 404") for t in head)
    return has_code and any(_NOT_FOUND.search(t) for t in head)


def place_route(nodes: list[dict], route: str, texts: list[str], anchors: list[str], *,
                title_hint: Optional[str], screen_hash: Optional[str], code_tabs: set[str]) -> Optional[Placed]:
    """A web capture: a screen keyed by the route it fits first, then by its words (the native
    path), else a node of its own keyed by its collapsed route."""
    title = (title_hint or "").strip() or None
    if is_not_found(texts, title):
        return Placed(NOT_FOUND_KEY, "Page not found", "route", [], list(anchors), title)
    known = [n["key"] for n in nodes if str(n["key"]).startswith("/")]
    key, hit = resolve_route(route, known)
    if hit:
        label = next((n["label"] for n in nodes if n["key"] == key), route_label(key))
        return Placed(key, label, "route", [], list(anchors), title)
    # Words only decide among screens with no route of their own (code-declared by name): a page
    # at a new route never merges into another route's page because their words look alike.
    unrouted = [n for n in nodes if not str(n["key"]).startswith("/")]
    found = place(unrouted, code_tabs, texts, anchors, title_hint=title_hint, screen_hash=screen_hash)
    if found is not None and found.by != "new":
        return found
    label = title or (found.label if found else None) or route_label(key)
    return Placed(key, label, "new", found.states if found else [], list(anchors), title)


def _code_tabs(cur, cid: str, platform: str) -> set[str]:
    cur.execute("SELECT label, sources FROM qa_map_edges WHERE container_id=%s AND platform=%s AND kind='navigates'",
                (cid, platform))
    out = set()
    for r in cur.fetchall():
        label = str(r["label"] or "")
        if "code" in qs._json(r["sources"], []) and label.endswith(" tab") and len(label) > 4:
            out.add(label[: -len(" tab")])
    return out


def observe(cur, s: dict, *, platform: str, texts: list[str], anchors: list[str], title: Optional[str],
            frame_id: Optional[str], from_key: Optional[str], action: Optional[str],
            screen_hash: Optional[str], route: Optional[str] = None) -> dict:
    """Meet one live capture with a screen node, mark it seen, and add the `navigates` edge it
    was reached by. Returns {screen_key, label, state, new, matched_by, states}."""
    cid, sid = str(s["container_id"]), str(s["id"])
    existing = _nodes(cur, cid, platform)
    screens = [n for (kind, _), n in existing.items() if kind == "screen"]
    tabs = _code_tabs(cur, cid, platform)
    if platform == "web" and (route or "").strip():
        found = place_route(screens, route, texts, anchors, title_hint=title, screen_hash=screen_hash, code_tabs=tabs)
    else:
        found = place(screens, tabs, texts, anchors, title_hint=title, screen_hash=screen_hash)
    if found is None:
        return {"screen_key": None, "label": None, "state": None, "new": False, "matched_by": "none",
                "states": ["system"]}
    at = qs.now()
    row = existing.get(("screen", found.key))
    evidence = dict(row["evidence"]) if row else {}
    detail = dict(row["detail"]) if row else {}
    was_seen = bool(row) and row["state"] == "seen"
    live = dict(evidence.get("live") or {}) if isinstance(evidence.get("live"), dict) else {}
    live["sightings"] = int(live.get("sightings") or 0) + 1
    live["session_ids"] = list(dict.fromkeys([sid, *(live.get("session_ids") or [])]))[:SESSIONS_KEPT]
    live["last_seen_at"] = qs.iso(at)
    evidence["live"] = live
    dlive = dict(detail.get("live") or {}) if isinstance(detail.get("live"), dict) else {}
    dlive["anchors"] = found.anchors[:LIST_KEPT]
    if found.title:
        dlive["title"] = found.title
    if found.by in ("new", "seen", "title") or (found.by == "route" and not row):
        dlive["label"] = found.label
    if route and platform == "web":
        dlive["routes"] = _union(dlive.get("routes") or [], [route.split("?", 1)[0].split("#", 1)[0][:300]], 10)
    if screen_hash:
        dlive["hashes"] = _union(dlive.get("hashes") or [], [screen_hash])
    if found.states:
        dlive["states"] = _union(dlive.get("states") or [], found.states)
    detail["live"] = dlive
    values = derive_node("screen", found.key, evidence, detail, feature_key=(row or {}).get("feature_key"),
                         blocked_kind=None)
    if row:
        cur.execute(
            """UPDATE qa_map_nodes SET label=%s, feature_key=%s, state=%s, blocked_kind=NULL, blocked_reason=NULL,
                      sources=%s, evidence=%s, detail=%s, frame_id=COALESCE(%s, frame_id), last_seen_at=%s,
                      updated_at=%s WHERE id=%s""",
            (values["label"], values["feature_key"], values["state"], qs.dumps(values["sources"]),
             qs.dumps(evidence), qs.dumps(detail), frame_id, at, at, str(row["id"])),
        )
        nid = str(row["id"])
    else:
        nid = _insert_node(cur, cid, platform, "screen", found.key, values, evidence, detail, at, frame_id=frame_id,
                           last_seen_at=at)
    prev = existing.get(("screen", from_key)) if from_key else None
    if prev and str(prev["id"]) != nid:
        _count_edge(cur, cid, platform, str(prev["id"]), nid, (action or "").strip()[:200], sid, at)
    return {"screen_key": found.key, "label": values["label"], "state": values["state"], "new": not was_seen,
            "matched_by": found.by, "states": found.states, "node_id": nid}


def _count_edge(cur, cid: str, platform: str, a: str, b: str, label: str, sid: str, at) -> None:
    cur.execute(
        """SELECT * FROM qa_map_edges WHERE container_id=%s AND platform=%s AND kind='navigates'
              AND from_node_id=%s AND to_node_id=%s AND label=%s""",
        (cid, platform, a, b, label),
    )
    row = cur.fetchone()
    evidence = qs._json(row["evidence"], {}) if row else {}
    detail = qs._json(row["detail"], {}) if row else {}
    live = dict(evidence.get("live") or {}) if isinstance(evidence.get("live"), dict) else {}
    live["count"] = int(live.get("count") or 0) + 1
    live["session_ids"] = list(dict.fromkeys([sid, *(live.get("session_ids") or [])]))[:SESSIONS_KEPT]
    live["last_seen_at"] = qs.iso(at)
    evidence["live"] = live
    detail.setdefault("live", {})
    values = derive_edge(evidence, detail)
    if row:
        cur.execute("UPDATE qa_map_edges SET sources=%s, count=%s, evidence=%s, detail=%s, updated_at=%s WHERE id=%s",
                    (qs.dumps(values["sources"]), values["count"], qs.dumps(evidence), qs.dumps(detail), at,
                     str(row["id"])))
    else:
        cur.execute(
            """INSERT INTO qa_map_edges (id, container_id, platform, kind, from_node_id, to_node_id, label, count,
                                         sources, evidence, detail, created_at, updated_at)
               VALUES (%s,%s,%s,'navigates',%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (qs.new_id(), cid, platform, a, b, label, values["count"], qs.dumps(values["sources"]),
             qs.dumps(evidence), qs.dumps(detail), at, at),
        )


def mark_blocked(cur, cid: str, platform: str, screen: str, kind: str, reason: str,
                 session_id: Optional[str]) -> dict:
    """Record why a screen could not be reached. `screen` is a node key, else a screen's label;
    an unknown one becomes a screen node of its own (source `agent`). A screen sessions have seen
    keeps its `seen` state; the reason is still kept."""
    existing = _nodes(cur, cid, platform)
    row = existing.get(("screen", screen))
    if row is None:
        low = screen.strip().lower()
        row = next((n for (k, _), n in existing.items() if k == "screen" and str(n["label"]).strip().lower() == low),
                   None)
    at = qs.now()
    part = {"blocked": {"kind": kind, "reason": reason, "session_id": session_id, "at": qs.iso(at)}}
    if row is None:
        key = qs.slug(screen) or ("blocked-" + hashlib.sha1(screen.encode()).hexdigest()[:8])
        evidence, detail = {"agent": part}, {"agent": {"label": screen.strip()[:200]}}
        values = derive_node("screen", key, evidence, detail, feature_key=None, blocked_kind=kind)
        _insert_node(cur, cid, platform, "screen", key, values, evidence, detail, at, blocked_kind=kind,
                     blocked_reason=reason)
        return {"screen_key": key, "label": values["label"], "state": values["state"], "new": True}
    evidence, detail = dict(row["evidence"]), dict(row["detail"])
    evidence["agent"] = combine(evidence.get("agent"), part)
    detail.setdefault("agent", {})
    values = derive_node("screen", row["key"], evidence, detail, feature_key=row.get("feature_key"), blocked_kind=kind)
    cur.execute(
        """UPDATE qa_map_nodes SET state=%s, blocked_kind=%s, blocked_reason=%s, sources=%s, evidence=%s, detail=%s,
                  updated_at=%s WHERE id=%s""",
        (values["state"], kind, reason, qs.dumps(values["sources"]), qs.dumps(evidence), qs.dumps(detail), at,
         str(row["id"])),
    )
    return {"screen_key": row["key"], "label": values["label"], "state": values["state"], "new": False}
