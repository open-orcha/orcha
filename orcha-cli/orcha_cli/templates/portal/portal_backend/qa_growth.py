"""Coverage growth: a baseline, then how coverage rises over time, overall and per area. Read from
the portal's own rows, no model.

- **Baseline** (`capture`): the screens and areas known, who covers each screen, the key flows and
  the data variations per flow, frozen. A person takes it or re-baselines with a reason; every
  baseline stays as history (`qa_coverage_baselines`).
- **Ongoing** (`report`): the same measurement now (`qa_growth_measure`, with its honesty rules),
  one point a day (`qa_coverage_points`), the comparison with the baseline (`qa_growth_compare`).
- **More data** (`qa_growth_variations`): data rows for a scenario's Examples table by test-design
  technique, applied only when a person approves them.

*Your tests* are the scenarios a person wrote (`source` authored); *Orcha* every other one.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from portal_backend import qa_growth_compare as compare
from portal_backend import qa_growth_depth as depth_mod
from portal_backend import qa_growth_variations as variations
from portal_backend import qa_map, qa_map_cover, qa_scenarios, qa_store as qs
from portal_backend.qa_growth_measure import EVIDENCE_VERSION, FRESH_DAYS, Inputs, ScenarioFacts, ScreenFacts, measure

#: Points read for the chart when there is no baseline yet.
DEFAULT_DAYS = 90


class GrowthError(ValueError):
    """A request that cannot be done; str(e) says why, in the person's words."""


def _day(when: datetime) -> str:
    return when.date().isoformat()


def results(cur: Any, cid: str, rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Each scenario's newest outcome, when, and its newest pass, one attempt per check session."""
    cur.execute("SELECT * FROM qa_verdicts WHERE container_id=%s ORDER BY created_at DESC", (cid,))
    by: dict[str, dict[str, list[dict]]] = {}
    for v in cur.fetchall():
        by.setdefault(str(v["scenario_id"]), {}).setdefault(str(v["session_id"]), []).append(qs.public(v))
    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        sid = str(r["id"])
        tries = qa_scenarios.attempts_of(len(qs._json(r.get("criteria"), [])), by.get(sid, {}))
        passes = [a for a in tries if a["outcome"] == "pass"]
        out[sid] = {"last_outcome": tries[0]["outcome"] if tries else None, "last_at": tries[0]["at"] if tries else None,
                    "last_pass_at": passes[0]["at"] if passes else None}
    return out


def _source(node: dict[str, Any]) -> str:
    have = set(node.get("sources") or [])
    code, live = "code" in have, bool(have - {"code"})
    return "both" if code and live else "live" if live else "code"


def _test_names(node: dict[str, Any]) -> list[str]:
    """The team's own tests that reach this screen, as the tests phase tied them."""
    found = (node.get("evidence") or {}).get("tests")
    return [str(t["name"]) for t in found if isinstance(t, dict) and t.get("name")] if isinstance(found, list) else []


def inputs(cur: Any, cid: str) -> Inputs:
    cur.execute("SELECT key, name FROM qa_features WHERE container_id=%s", (cid,))
    features = {str(r["key"]): str(r["name"] or r["key"]) for r in cur.fetchall()}
    cur.execute("SELECT * FROM qa_scenarios WHERE container_id=%s", (cid,))
    rows = [dict(r) for r in cur.fetchall()]
    res = results(cur, cid, rows)
    done = variations.applied(cur, cid)
    scenarios: dict[str, ScenarioFacts] = {}
    tagged: dict[str, list[str]] = {}
    for r in rows:
        sid = str(r["id"])
        got = res.get(sid, {})
        scenarios[sid] = ScenarioFacts(
            id=sid, name=str(r.get("name") or "Scenario"), status=qa_scenarios.effective(r),
            origin="yours" if r.get("source") == "authored" or any(str(t).startswith("test:") for t in qs._json(r.get("tags"), [])) else "orcha",
            last_outcome=got.get("last_outcome"), last_at=got.get("last_at") or None, last_pass_at=got.get("last_pass_at"),
            depth=depth_mod.depth(r, done.get(sid)),
        )
        for t in qs._json(r.get("tags"), []):
            if isinstance(t, str) and t.startswith("screen:"):
                tagged.setdefault(t[len("screen:"):], []).append(sid)
    cur.execute("SELECT scenario_id, feature_key FROM qa_coverage_links WHERE container_id=%s AND state='rejected'", (cid,))
    rejected = {(str(r["scenario_id"]), str(r["feature_key"])) for r in cur.fetchall()}
    screens: list[ScreenFacts] = []
    platforms = sorted({str(r["platform"]) for r in _map_platforms(cur, cid)})
    for platform in platforms:
        graph = qa_map.read_map(cur, cid, platform)
        for n in graph["nodes"]:
            if n.get("kind") != "screen":
                continue
            key = str(n.get("feature_key") or "other")
            on = [str(c.get("scenario_id")) for c in n.get("covered_by") or []] + tagged.get(str(n.get("key")), [])
            on = [s for s in dict.fromkeys(on) if s in scenarios and (s, key) not in rejected]
            screens.append(ScreenFacts(id=str(n["id"]), name=str(n.get("label") or n.get("key")), area=key,
                                       area_name=features.get(key, "Other" if key == "other" else key),
                                       source=_source(n), tests=_test_names(n), scenarios=on, platform=platform,
                                       first_seen_at=n.get("created_at")))
    placed = {s.area for s in screens}
    return Inputs(project_id=cid, screens=screens, scenarios=scenarios, empty_areas={k: v for k, v in features.items() if k not in placed})


def _map_platforms(cur: Any, cid: str) -> list[dict[str, Any]]:
    cur.execute("SELECT DISTINCT platform FROM qa_map_nodes WHERE container_id=%s", (cid,))
    return list(cur.fetchall())


def measure_now(cur: Any, cid: str, now: Optional[datetime] = None) -> dict[str, Any]:
    return measure(inputs(cur, cid), now)


def current_baseline(cur: Any, cid: str) -> Optional[dict[str, Any]]:
    cur.execute("SELECT * FROM qa_coverage_baselines WHERE container_id=%s AND superseded_at IS NULL ORDER BY created_at DESC LIMIT 1", (cid,))
    row = cur.fetchone()
    return qs.public(row) if row else None


def history(cur: Any, cid: str) -> list[dict[str, Any]]:
    cur.execute("SELECT * FROM qa_coverage_baselines WHERE container_id=%s ORDER BY created_at DESC", (cid,))
    return [qs.public(r) for r in cur.fetchall()]


def capture(cur: Any, cid: str, who: Optional[dict], *, trigger: str, reason: Optional[str] = None, now: Optional[datetime] = None) -> dict[str, Any]:
    """Measure now and store it as the baseline (the current one becomes history)."""
    now = now or datetime.now(timezone.utc)
    data = measure_now(cur, cid, now)
    cur.execute("UPDATE qa_coverage_baselines SET superseded_at=%s WHERE container_id=%s AND superseded_at IS NULL", (qs.now(), cid))
    bid = qs.new_id()
    cur.execute(
        """INSERT INTO qa_coverage_baselines (id, container_id, day, trigger_kind, reason, evidence_version, data, created_by_agent_id, created_at)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (bid, cid, _day(now), trigger, reason, EVIDENCE_VERSION, qs.dumps(data), who["id"] if who else None, qs.now()),
    )
    return current_baseline(cur, cid) or {}


def ensure_baseline(cur: Any, cid: str, trigger: str) -> Optional[dict[str, Any]]:
    """The first baseline, unless one exists (`first_mapping` after the first finished map)."""
    return None if current_baseline(cur, cid) is not None else capture(cur, cid, None, trigger=trigger)


def after_map_build(cur: Any, cid: str) -> Optional[dict[str, Any]]:
    """A map import finished: the first mapping that found a screen is the project's baseline,
    unless onboarding is still bringing its tests in. Growth is a reading of the map, never a
    reason an import fails."""
    try:
        if current_baseline(cur, cid) is not None:
            return None
        cur.execute("SELECT state FROM qa_onboarding WHERE container_id=%s", (cid,))
        row = cur.fetchone()
        if row and row["state"] == "running":
            return None
        cur.execute("SELECT 1 AS one FROM qa_map_nodes WHERE container_id=%s AND kind='screen' LIMIT 1", (cid,))
        if cur.fetchone() is None:
            return None
        return ensure_baseline(cur, cid, "first_mapping")
    except Exception:  # noqa: BLE001 - see the docstring
        return None


def rebaseline(cur: Any, cid: str, who: dict, reason: Optional[str]) -> dict[str, Any]:
    """A person's re-baseline (a big rewrite, a new app): a reason is required, history is kept."""
    reason = (reason or "").strip()
    if len(reason) < 3:
        raise GrowthError("Say why you are re-baselining (for example: the app was rewritten).")
    trigger = "manual" if current_baseline(cur, cid) is None else "rebaseline"
    return capture(cur, cid, who, trigger=trigger, reason=reason)


def _baseline_json(row: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    if row is None:
        return None
    return {"id": row["id"], "day": row["day"], "taken_at": row["created_at"], "trigger": row["trigger_kind"], "reason": row.get("reason"),
            "app_build": row.get("app_build"), "evidence_version": row.get("evidence_version"),
            "same_rules": int(row.get("evidence_version") or 0) == EVIDENCE_VERSION, "superseded_at": row.get("superseded_at")}


def points(cur: Any, cid: str, since: str) -> list[dict[str, Any]]:
    cur.execute("SELECT * FROM qa_coverage_points WHERE container_id=%s AND day>=%s ORDER BY day", (cid, since))
    return [qs.public(r) for r in cur.fetchall()]


def record_point(cur: Any, cid: str, data: dict[str, Any], day: str) -> None:
    cur.execute("SELECT id FROM qa_coverage_points WHERE container_id=%s AND day=%s", (cid, day))
    row = cur.fetchone()
    if row:
        cur.execute("UPDATE qa_coverage_points SET data=%s, evidence_version=%s WHERE id=%s", (qs.dumps(data), EVIDENCE_VERSION, str(row["id"])))
    else:
        cur.execute("INSERT INTO qa_coverage_points (id, container_id, day, evidence_version, data, created_at) VALUES (%s,%s,%s,%s,%s,%s)",
                    (qs.new_id(), cid, day, EVIDENCE_VERSION, qs.dumps(data), qs.now()))


def report(cur: Any, cid: str, *, write: bool = True, now: Optional[datetime] = None) -> dict[str, Any]:
    """The project's coverage growth (`CoverageGrowth` in the Coverage page's growth types)."""
    now = now or datetime.now(timezone.utc)
    day = _day(now)
    m = measure_now(cur, cid, now)
    if write:
        record_point(cur, cid, m, day)
    base = current_baseline(cur, cid)
    since_day = base["day"] if base else _day(now - timedelta(days=DEFAULT_DAYS))
    pts = [p for p in points(cur, cid, min(since_day, _day(now - timedelta(days=8)))) if p["day"] != day]
    g = compare.growth(base["data"], m, since=base["created_at"]) if base else None
    weekly = compare.weekly_line(pts, m, now)
    return {
        "project_id": cid, "computed_at": m["measured_at"], "source": "measured", "refreshing": False, "fresh_days": FRESH_DAYS,
        "evidence_version": EVIDENCE_VERSION, "baseline": _baseline_json(base),
        "history": [_baseline_json(r) for r in history(cur, cid)], "now": m, "growth": g,
        "series": compare.series(base, [p for p in pts if p["day"] >= since_day], m, day), "count": None,
        "weekly": weekly, "payoff": payoff(g, m, weekly), "variations": variations.summary(cur, cid),
    }


def payoff(g: Optional[dict[str, Any]], m: dict[str, Any], weekly: Optional[str]) -> dict[str, Any]:
    """The few lines the page's headline and the weekly summary say."""
    totals = m["totals"]
    pct, screens = totals.get("pct"), int(totals.get("screens") or 0)
    if g is None:
        return {"headline": f"Coverage now: {pct}% of {compare._plural(screens, 'screen')}. No baseline yet." if pct is not None
                else "Coverage evidence is unknown so far.", "areas": [], "weekly": weekly,
                "pct": pct, "screens": screens, "points": None, "since": None, "added": None}
    grew = [a for a in g["areas"] if (a["points"] or 0) > 0][:3]
    add = g["overall"]["added"]
    return {"headline": g["headline"], "areas": [compare.area_line(a, g["since"]) for a in grew], "weekly": weekly,
            "pct": pct, "screens": screens, "points": g["overall"]["points"], "since": g["since"],
            "added": {k: int(add.get(k) or 0) for k in ("scenarios", "variations", "screens_reached")}}
