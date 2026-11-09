"""What is covered right now, per screen and per area, and by whom (#413, "Ongoing measurement").

Pure: `measure` takes the facts `load.inputs` reads (or a test builds by hand) and returns the
measurement a baseline or a daily point stores, and the Coverage page shows.

**Who covers a screen.** *Your tests* are the team's own tests: a test in the repository tied to
the screen by a strong step (evidence and all), or a
scenario migrated from one (`scenarios.source_test`, `migration_sources`). *Orcha* is every
other scenario: drafted, suggested or written in Orcha and accepted there.

**The honesty rules** (each one a unit test in `tests/unit/coverage_growth/test_coverage_growth.py`):

1. A scenario covers a screen only when it is *validated* and its newest result *passed* within
   `FRESH_DAYS`. A draft covers nothing (it never shows at all), and neither does a retired one.
2. A screen whose only scenarios are failing, stale (last passed too long ago), flaky
   (quarantined) or paused is *at risk*, never covered, and says why.
3. A screen whose only scenario is validated but has never run is *unknown*: Orcha cannot say.
   An area with no screens known, or whose screens are all unknown, says its evidence is unknown
   instead of showing 0%.

A screen's state is one of `both`, `orcha`, `your_tests` (covered), `at_risk`, `unknown`,
`none`; an area's coverage is the share of its screens covered.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any


#: The measuring rules' version, stored with every snapshot (bump it when a rule changes).
EVIDENCE_VERSION = 1
#: A pass older than this no longer covers (the Coverage page's window for "passing").
FRESH_DAYS = 30
PASS = frozenset({"pass", "warning"})
FAIL = frozenset({"fail"})
COVERED = ("both", "orcha", "your_tests")
STATES = ("both", "orcha", "your_tests", "at_risk", "unknown", "none")
#: A scenario's evidence, best first.
EVIDENCE = ("fresh", "never_run", "failing", "stale", "flaky", "paused", "not_counted")
RISKY = frozenset({"failing", "stale", "flaky", "paused"})


def platform_split(platforms: Any) -> dict[str, int]:
    """How many screens are each platform's own, when every one is one platform's and there are
    two or more: then the count is "one per platform" and can say so. Empty otherwise."""
    have = list(platforms)
    if not have or any(p is None for p in have):
        return {}
    out: dict[str, int] = {}
    for p in have:
        out[str(p)] = out.get(str(p), 0) + 1
    return dict(sorted(out.items())) if len(out) > 1 else {}


@dataclass
class ScenarioFacts:
    id: str
    name: str
    #: The effective status: draft, validated, quarantined, paused, retired.
    status: str
    #: `yours` (migrated from the team's test) or `orcha`.
    origin: str
    last_outcome: str | None = None
    last_at: str | None = None
    last_pass_at: str | None = None
    #: `depth.depth` of the scenario.
    depth: dict[str, Any] = field(default_factory=lambda: {"partitions": 1, "kinds": ["partition"], "rows": 0, "orcha_rows": 0, "orcha_partitions": 0})


@dataclass
class ScreenFacts:
    id: str
    name: str
    area: str
    area_name: str
    #: `code`, `live` or `both`.
    source: str
    #: The team's tests tied to it (`path#name`).
    tests: list[str] = field(default_factory=list)
    #: The scenarios that reach it (runs, traces, the tests they came from).
    scenarios: list[str] = field(default_factory=list)
    #: The one platform it is (`app_map.store.screen_platform`); None on both phones or unknown.
    platform: str | None = None
    #: When a run first saw it (its oldest look), None when no run has: a recount says whether it
    #: was already seen at an older measurement (`recount`).
    first_seen_at: str | None = None


@dataclass
class Inputs:
    project_id: str
    screens: list[ScreenFacts]
    scenarios: dict[str, ScenarioFacts]
    #: Areas known with no screen yet (a feature area the code names that the map has not placed).
    empty_areas: dict[str, str] = field(default_factory=dict)
    #: The rule the code map counted these screens by (`app_map.code.SCREEN_RULE` of its newest code
    #: build; 1 before #467 said one).
    screen_rule: int = 1


def _time(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        t = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _days_ago(value: Any, now: datetime) -> int | None:
    t = _time(value)
    return None if t is None else max(0, (now - t).days)


def evidence(s: ScenarioFacts, now: datetime, fresh_days: int = FRESH_DAYS) -> str:
    """What one scenario's results say about what it covers (`EVIDENCE`)."""
    if s.status not in ("validated", "quarantined", "paused"):
        return "not_counted"
    if s.status == "paused":
        return "paused"
    if s.status == "quarantined":
        return "flaky"
    if not s.last_outcome:
        return "never_run"
    if s.last_outcome in FAIL:
        return "failing"
    passed = _time(s.last_pass_at)
    if s.last_outcome in PASS and passed is not None and passed >= now - timedelta(days=fresh_days):
        return "fresh"
    return "stale"


def _why(s: ScenarioFacts, ev: str, now: datetime) -> str:
    name = f"‘{s.name}’"
    if ev == "failing":
        ago = _days_ago(s.last_at, now)
        return f"Only {name} reaches it, and it failed" + (f" {_ago(ago)}" if ago is not None else "") + "."
    if ev == "stale":
        ago = _days_ago(s.last_pass_at, now)
        return f"Only {name} reaches it, and it last passed" + (f" {_ago(ago)}" if ago is not None else " long ago") + "."
    if ev == "flaky":
        return f"Only {name} reaches it, and it is quarantined as flaky."
    if ev == "paused":
        return f"Only {name} reaches it, and it is paused."
    if ev == "never_run":
        return f"{name} reaches it but has never run, so Orcha cannot say yet."
    return ""


def _ago(days: int) -> str:
    return "today" if days == 0 else "yesterday" if days == 1 else f"{days} days ago"


def screen_state(sc: ScreenFacts, scenarios: dict[str, ScenarioFacts], now: datetime, fresh_days: int = FRESH_DAYS) -> dict[str, Any]:
    """`{state, reason, orcha: [fresh Orcha scenario ids], yours: [fresh migrated ids]}`."""
    mine = [scenarios[i] for i in dict.fromkeys(sc.scenarios) if i in scenarios]
    evs = [(s, evidence(s, now, fresh_days)) for s in mine]
    fresh_v = [s.id for s, e in evs if e == "fresh" and s.origin == "orcha"]
    fresh_y = [s.id for s, e in evs if e == "fresh" and s.origin == "yours"]
    yours = bool(sc.tests) or bool(fresh_y)
    if yours and fresh_v:
        state, reason = "both", ""
    elif fresh_v:
        state, reason = "orcha", ""
    elif yours:
        state, reason = "your_tests", ""
    else:
        counted = [(s, e) for s, e in evs if e != "not_counted"]
        risky = sorted((p for p in counted if p[1] in RISKY), key=lambda p: (EVIDENCE.index(p[1]), p[0].name.lower()))
        never = [p for p in counted if p[1] == "never_run"]
        if risky:
            state, reason = "at_risk", _why(risky[0][0], risky[0][1], now)
            if len(risky) > 1:
                more = len(risky) - 1
                reason = reason.replace("Only ", "", 1)
                reason = reason[0].upper() + reason[1:] + f" {more} more {'scenario reaches' if more == 1 else 'scenarios reach'} it, none passing."
        elif never:
            state, reason = "unknown", _why(never[0][0], "never_run", now)
        else:
            state, reason = "none", ""
    return {"state": state, "reason": reason, "orcha": fresh_v, "yours": fresh_y}


def _pct(covered: int, total: int) -> int | None:
    return round(covered * 100 / total) if total else None


def _rollup(rows: list[dict[str, Any]], flows: dict[str, dict[str, Any]]) -> dict[str, Any]:
    counts = {s: sum(1 for r in rows if r["state"] == s) for s in STATES}
    covered = sum(counts[s] for s in COVERED)
    known = len(rows) - counts["unknown"]
    tests = {t for r in rows for t in r["tests"]}
    orcha = {i for r in rows for i in r["orcha"]}
    yours = {i for r in rows for i in r["yours"]}
    fl = [flows[i] for i in orcha | yours if i in flows]
    if not rows or counts["unknown"] == len(rows):
        ev = "unknown"
    elif counts["unknown"]:
        ev = "partial"
    else:
        ev = "known"
    return {
        "screens": len(rows), "covered": covered, "pct": _pct(covered, len(rows)) if known else None, **counts,
        "by_your_tests": counts["your_tests"] + counts["both"], "by_orcha": counts["orcha"] + counts["both"],
        "flows": {"your_tests": len(tests) + len(yours), "orcha": len(orcha)},
        "variations": sum(int(f["depth"]["partitions"]) for f in fl),
        "variations_added": sum(int(f["depth"]["orcha_rows"]) for f in fl),
        "evidence": ev,
    }


def measure(inp: Inputs, now: datetime | None = None, fresh_days: int = FRESH_DAYS) -> dict[str, Any]:
    """The measurement: screens, areas, flows and totals (`Measurement` in
    `web/src/components/scenarios/coverage/growth/types.ts`)."""
    now = now or datetime.now(timezone.utc)
    screens: list[dict[str, Any]] = []
    for sc in sorted(inp.screens, key=lambda s: (s.area_name.lower(), s.name.lower(), s.id)):
        st = screen_state(sc, inp.scenarios, now, fresh_days)
        screens.append({
            "id": sc.id, "name": sc.name, "area": sc.area, "source": sc.source, "live": sc.source in ("live", "both"),
            "state": st["state"], "reason": st["reason"] or None, "tests": sorted(set(sc.tests)),
            "orcha": st["orcha"], "yours": st["yours"],
        })
    flows: dict[str, dict[str, Any]] = {}
    for s in inp.scenarios.values():
        ev = evidence(s, now, fresh_days)
        if ev == "not_counted":
            continue
        flows[s.id] = {"id": s.id, "name": s.name, "origin": s.origin, "evidence": ev, "depth": s.depth,
                       "areas": sorted({r["area"] for r in screens if s.id in r["orcha"] or s.id in r["yours"]})}
    names = {sc.area: sc.area_name for sc in inp.screens} | dict(inp.empty_areas)
    areas = []
    for key in sorted(names, key=lambda k: names[k].lower()):
        rows = [r for r in screens if r["area"] == key]
        areas.append({"key": key, "name": names[key], **_rollup(rows, flows)})
    totals = _rollup(screens, flows)
    totals["live_screens"] = sum(1 for r in screens if r["live"])
    # Each platform's own screen counts apart (#467): how many are each platform's, so the
    # figure can say so beside the atlas's, which counts a screen once across platforms.
    totals["platforms"] = platform_split(sc.platform for sc in inp.screens)
    return {
        "evidence_version": EVIDENCE_VERSION,
        "screen_rule": inp.screen_rule,
        "measured_at": now.isoformat().replace("+00:00", "Z"),
        "fresh_days": fresh_days,
        "screens": screens,
        "areas": areas,
        "flows": sorted(flows.values(), key=lambda f: (f["origin"], f["name"].lower(), f["id"])),
        "totals": totals,
    }
