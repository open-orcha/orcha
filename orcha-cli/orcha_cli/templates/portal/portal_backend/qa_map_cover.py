"""Which scenarios cover the app map, computed when the map is read, never stored: results change
on every check and a scenario can be paused or retired at any time.

A scenario covers a screen when it is known to go there:

- `run`: its newest sessions that checked it alone (a passing one first): the screens their steps
  reached, in order.
- `trace`: the walk it was written from: the screens that walk's recorded steps reached.

Validated and paused scenarios cover what they reach (a paused one marked so); drafts and retired
ones cover nothing. A flow node is covered when one of those paths visits its steps in order, and
a `navigates` edge when one of them took that move. Read-only, bounded by the platform's scenarios.
"""

from __future__ import annotations

import datetime as _dt
import re
from typing import Any, Iterable, Optional

from portal_backend import qa_store as qs, sql

#: Where a link comes from, strongest first.
VIA = ("run", "trace")
#: Newest sessions of a scenario alone read for its links.
RUNS_PER_SCENARIO = 2
#: Most links listed per node.
MAX_LINKS = 20
FAILING_DAYS = 7
RECENT_DAYS = 30
COVERED_DEPTH = 3.0
STRONG_DEPTH = 6.0
#: What covering every one of a feature's screens adds to the raw depth (of 13).
MAP_DEPTH = 3.0
#: Edge cases a scenario's text can name, each a family of words.
EDGE_KINDS = tuple(re.compile(p, re.I) for p in (
    r"\b(errors?|fails?|failure|crash\w*|5\d\d|went wrong|retry)\b",
    r"\b(empty|no results?|nothing (?:to|yet)|zero (?:items|results))\b",
    r"\b(offline|no (?:network|connection|internet)|airplane|connection (?:lost|drops?))\b",
    r"\b(permissions?|denied|den(?:y|ies)|not allowed|unauthori[sz]ed|forbidden|40[13])\b",
    r"\b(invalid|validation|malformed|incorrect|wrong (?:password|code)|required field|422)\b",
    r"\b(time ?outs?|timed out|slow)\b",
    r"\b(limits?|maximum|minimum|too (?:many|long|short)|quota|boundary|overflow)\b",
    r"\b(paywall|premium|subscri\w+|upgrade|purchase|trial)\b",
    r"\b(expired?|session|signs? out|signed out|log ?out)\b",
))


def _when(value: Any) -> Optional[_dt.datetime]:
    text = qs.iso(value)
    if not isinstance(text, str):
        return None
    try:
        at = _dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return at if at.tzinfo else at.replace(tzinfo=_dt.timezone.utc)


def _walks(path: list[str], steps: list[str]) -> bool:
    """Whether `path` (screens reached, in order) visits `steps` in order."""
    if not steps:
        return False
    i = 0
    for key in path:
        if key == steps[i]:
            i += 1
            if i == len(steps):
                return True
    return False


def _depth(scenarios: list[dict], total: int, hit: int) -> float:
    """How deep the scenarios test a feature, 0..10: how many, their criteria, the edge cases they
    name, their personas and the share of its screens they reach."""
    criteria = [str(c) for s in scenarios for c in qs._json(s.get("criteria"), [])]
    text = " ".join([*(str(s.get("name") or "") for s in scenarios), *(str(s.get("description") or "") for s in scenarios), *criteria])
    edges = sum(1 for rx in EDGE_KINDS if rx.search(text))
    personas = {s.get("persona") for s in scenarios if s.get("persona")}
    raw = min(len(scenarios), 3) + min(len(criteria), 12) / 4 + min(edges, 4) * 1.25 + (1 if len(personas) >= 2 else 0)
    return round((raw + MAP_DEPTH * min(hit, total) / max(total, 1)) * 10 / (13 + MAP_DEPTH), 1)


def _state(scenarios: list[dict], newest: dict[str, tuple[Optional[_dt.datetime], str]], total: int, hit: int) -> str:
    if not scenarios:
        return "untested"
    now = _dt.datetime.now(_dt.timezone.utc)
    failing = passing = False
    for s in scenarios:
        at, result = newest.get(str(s["id"]), (None, ""))
        if at is None:
            continue
        failing = failing or (result == "fail" and at >= now - _dt.timedelta(days=FAILING_DAYS))
        passing = passing or (result == "pass" and at >= now - _dt.timedelta(days=RECENT_DAYS))
    score = _depth(scenarios, total, hit)
    if failing:
        return "failing"
    if score >= STRONG_DEPTH and passing:
        return "strong"
    return "covered" if score >= COVERED_DEPTH else "thin"


def _results(rows: Iterable[dict]) -> tuple[dict, dict]:
    """From verdict rows, newest first: each scenario's newest pass or fail with its time, and the
    sessions (newest first, a passing one leading) that checked it and nothing else."""
    sessions: dict[str, dict[str, Any]] = {}
    for r in rows:
        s = sessions.setdefault(str(r["session_id"]), {"at": r["created_at"], "by": {}})
        s["by"].setdefault(str(r["scenario_id"]), set()).add(r["verdict"])
    newest: dict[str, tuple[Optional[_dt.datetime], str]] = {}
    alone: dict[str, list[tuple[bool, str]]] = {}
    for sid, s in sessions.items():  # rows came newest first, so sessions did too
        for scenario, verdicts in s["by"].items():
            result = "fail" if "fail" in verdicts else "pass" if "pass" in verdicts else None
            if result and scenario not in newest:
                newest[scenario] = (_when(s["at"]), result)
            if len(s["by"]) == 1:
                alone.setdefault(scenario, []).append((result == "pass", sid))
    chosen = {k: [sid for _, sid in sorted(v, key=lambda x: not x[0])[:RUNS_PER_SCENARIO]] for k, v in alone.items()}
    return newest, chosen


def _paths(cur, scenarios: list[dict], chosen: dict[str, list[str]]) -> dict[str, list[tuple[str, list[str]]]]:
    """scenario id -> `(via, screen keys in order)` for each path it is known to have walked."""
    out: dict[str, list[tuple[str, list[str]]]] = {}
    session_ids = sorted({sid for ids in chosen.values() for sid in ids})
    by_session: dict[str, list[str]] = {}
    if session_ids:
        cur.execute(f"""SELECT session_id, screen_key FROM qa_steps
                         WHERE {sql.in_list('session_id')} AND screen_key IS NOT NULL ORDER BY session_id, seq""",
                    (sql.list_param(session_ids),))
        for r in cur.fetchall():
            by_session.setdefault(str(r["session_id"]), []).append(r["screen_key"])
    for scenario, ids in chosen.items():
        for sid in ids:
            out.setdefault(scenario, []).append(("run", by_session.get(sid, [])))
    ids = [str(s["id"]) for s in scenarios]
    walk_of = {str(s["walk_id"]): str(s["id"]) for s in scenarios if s.get("walk_id")}
    cur.execute(f"""SELECT id, scenario_id, steps FROM qa_walks
                     WHERE {sql.in_list('scenario_id')} OR {sql.in_list('id')}""",
                (sql.list_param(ids), sql.list_param(list(walk_of))))
    for r in cur.fetchall():
        owner = str(r["scenario_id"]) if r["scenario_id"] and str(r["scenario_id"]) in ids else walk_of.get(str(r["id"]))
        path = [s["screen_key"] for s in qs._json(r["steps"], []) if isinstance(s, dict) and s.get("reached") and s.get("screen_key")]
        if owner:
            out.setdefault(owner, []).append(("trace", path))
    return out


def add_coverage(cur, cid: str, platform: str, features: list[dict], nodes: list[dict], edges: list[dict]) -> None:
    """Set, in place, `covered_by` on nodes, `covered` on edges, and `coverage` and
    `covered_screens` on features."""
    for n in nodes:
        n["covered_by"] = []
    for e in edges:
        e["covered"] = False
    for f in features:
        f["coverage"], f["covered_screens"] = "untested", 0
    cur.execute("""SELECT id, name, description, persona, criteria, status, walk_id FROM qa_scenarios
                    WHERE container_id=%s AND platform=%s AND status IN ('validated', 'paused')""", (cid, platform))
    scenarios = [dict(r) for r in cur.fetchall()]
    if not scenarios or not nodes:
        return
    ids = [str(s["id"]) for s in scenarios]
    cur.execute(f"""SELECT session_id, scenario_id, verdict, created_at FROM qa_verdicts
                     WHERE {sql.in_list('scenario_id')} ORDER BY created_at DESC""", (sql.list_param(ids),))
    newest, chosen = _results(cur.fetchall())
    paths = _paths(cur, scenarios, chosen)

    screens = {n["key"]: n["id"] for n in nodes if n["kind"] == "screen"}
    flows = {n["id"]: [] for n in nodes if n["kind"] == "flow"}
    for e in sorted((e for e in edges if e["kind"] == "steps" and e["from_node_id"] in flows), key=_step_order):
        flows[e["from_node_id"]].append(e["to_node_id"])
    moves: dict[tuple[str, str], list[dict]] = {}
    for e in edges:
        if e["kind"] == "navigates":
            moves.setdefault((e["from_node_id"], e["to_node_id"]), []).append(e)

    found: dict[str, dict[str, str]] = {}  # node id -> scenario id -> via
    for scenario, walked in paths.items():
        for via, keys in walked:
            seq = [screens[k] for k in keys if k in screens]
            for nid in seq:
                cur_via = found.setdefault(nid, {}).get(scenario)
                if cur_via is None or VIA.index(via) < VIA.index(cur_via):
                    found[nid][scenario] = via
            for a, b in zip(seq, seq[1:]):
                for e in moves.get((a, b), []):
                    e["covered"] = True
            for fid, steps in flows.items():
                if _walks(seq, steps) and found.setdefault(fid, {}).get(scenario) != "run":
                    found[fid][scenario] = via

    by_id = {str(s["id"]): s for s in scenarios}
    title = {k: str(s.get("name") or "Scenario") + (" (paused)" if s.get("status") == "paused" else "") for k, s in by_id.items()}
    for n in nodes:
        by = found.get(n["id"])
        if by:
            links = [{"scenario_id": k, "title": title[k], "result": (newest.get(k) or (None, None))[1], "via": v} for k, v in by.items()]
            links.sort(key=lambda l: (VIA.index(l["via"]), l["title"].lower(), l["scenario_id"]))
            n["covered_by"] = links[:MAX_LINKS]
    for f in features:
        mine = [n for n in nodes if n["kind"] == "screen" and n.get("feature_key") == f["key"]]
        covered = [n for n in mine if n["covered_by"]]
        keys = {link["scenario_id"] for n in covered for link in n["covered_by"]}
        f["covered_screens"] = len(covered)
        f["coverage"] = _state([by_id[k] for k in keys], newest, len(mine), len(covered))


def _step_order(edge: dict) -> tuple[int, str]:
    detail = edge.get("detail") or {}
    orders = [p.get("order") for p in detail.values() if isinstance(p, dict) and isinstance(p.get("order"), int)]
    return (orders[0] if orders else 0, edge["id"])


def source_summaries(cur, cid: str, platform: str, nodes: list[dict], edges: list[dict]) -> dict:
    """What each source said last: when it was read and how much it gave; None for one not read."""
    cur.execute("""SELECT source, MAX(ended_at) AS at FROM qa_map_builds
                    WHERE container_id=%s AND platform=%s AND status='done' GROUP BY source""", (cid, platform))
    built = {r["source"]: qs.iso(r["at"]) for r in cur.fetchall()}

    def said(kind: str, source: str) -> list[dict]:
        return [n for n in nodes if n["kind"] == kind and source in (n.get("sources") or [])]

    code = None
    if "code" in built or any("code" in (n.get("sources") or []) for n in nodes):
        code = {"at": built.get("code"), "repo": None, "screens": len(said("screen", "code")),
                "edges": sum(1 for e in edges if "code" in (e.get("sources") or [])),
                "endpoints": len(said("endpoint", "code")), "entities": len(said("entity", "code"))}
    tests = None
    flows = said("flow", "tests")
    if "tests" in built or flows:
        frameworks = {(n.get("detail") or {}).get("tests", {}).get("framework") for n in flows
                      if isinstance((n.get("detail") or {}).get("tests"), dict)}
        tests = {"at": built.get("tests"), "tests": len(flows), "flows": len(flows), "frameworks": sorted(x for x in frameworks if x)}
    sightings: list[tuple[str, list[str]]] = []
    for n in nodes:
        for source in ("live", "crawl"):
            part = (n.get("evidence") or {}).get(source)
            if isinstance(part, dict) and part.get("session_ids"):
                sightings.append((str(part.get("last_seen_at") or ""), [str(x) for x in part["session_ids"]]))
    live = None
    if sightings or "live" in built or "crawl" in built:
        newest = max(sightings, key=lambda s: s[0], default=("", []))
        stamps = [x for x in (newest[0], built.get("live"), built.get("crawl")) if x]
        live = {"at": max(stamps) if stamps else None, "runs": len({sid for _, ids in sightings for sid in ids}),
                "last_run_id": newest[1][0] if newest[1] else None}
    return {"code": code, "tests": tests, "live": live}
