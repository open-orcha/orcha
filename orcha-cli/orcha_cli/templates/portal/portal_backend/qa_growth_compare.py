"""Baseline against now: how much coverage grew, and what Orcha added (#413, "Attribution").

Pure, over two measurements (`measure.measure`) and the daily points between them.

"Added by Orcha" is three things, each counted against the baseline:

- **scenarios**: Orcha scenarios (drafted, suggested or written in Orcha and accepted) that
  cover a screen now and did not at the baseline. Only fresh ones count (`measure`'s rules), so a
  scenario that went stale since is not claimed.
- **data variations**: rows Orcha suggested that a person applied, on scenarios that count,
  minus what the same scenarios held at the baseline.
- **screens reached**: screens an exploration or crawl saw that the baseline did not know, or
  knew only from the code.

Points are whole percentage points of screens covered: "Checkout: 40% → 85% (+45 points)". An area
whose evidence is unknown on either side has no points, and says so.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any



def _day(value: Any) -> str:
    return (value.isoformat() if isinstance(value, datetime) else str(value or ""))[:10]


_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _short(value: Any) -> str:
    day = _day(value)
    return f"{_MONTHS[int(day[5:7]) - 1]} {int(day[8:10])}" if re.match(r"^\d{4}-\d{2}-\d{2}", day) else day


def short_date(value: Any) -> str:
    """`2026-10-02T…` -> `Oct 2`, on the person's clock (#461): a baseline taken at 01:33 UTC on
    Oct 29 was taken on Oct 28 in New York. A plain day is already the person's."""
    return _short(value)


def _plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def _points(before: int | None, now: int | None) -> int | None:
    return None if before is None or now is None else now - before


def _orcha_ids(m: dict[str, Any], area: str | None = None) -> set[str]:
    return {i for s in m.get("screens") or [] if area is None or s["area"] == area for i in s.get("orcha") or []}


def _live(m: dict[str, Any], area: str | None = None) -> set[str]:
    return {s["id"] for s in m.get("screens") or [] if (area is None or s["area"] == area) and s.get("live")}


def _rows(m: dict[str, Any], ids: set[str] | None = None) -> dict[str, int]:
    return {f["id"]: int(f["depth"].get("orcha_rows") or 0) for f in m.get("flows") or [] if f.get("evidence") == "fresh" and (ids is None or f["id"] in ids)}


def added(baseline: dict[str, Any], now: dict[str, Any], area: str | None = None) -> dict[str, Any]:
    """What Orcha added since the baseline, for one area (None: the whole project). A baseline
    recounted on a new screen rule (#467) claims against the scenarios that covered a screen when
    it was taken, so a recount never adds or takes a scenario."""
    original = ((baseline.get("recount") or {}).get("original") or {}) if area is None else {}
    new = _orcha_ids(now, area) - _orcha_ids(original if original.get("screens") else baseline, area)
    scoped = {f["id"] for f in now.get("flows") or [] if area is None or area in (f.get("areas") or [])}
    after, before = _rows(now, scoped), _rows(baseline)
    variations = sum(max(0, n - before.get(i, 0)) for i, n in after.items())
    reached = _live(now, area) - _live(baseline, area)
    return {"scenarios": len(new), "scenario_ids": sorted(new), "variations": variations, "screens_reached": len(reached),
            "screens": sorted(reached)}


def _area_row(key: str, name: str, b: dict[str, Any] | None, n: dict[str, Any] | None, add: dict[str, Any]) -> dict[str, Any]:
    bp = b.get("pct") if b else None
    np_ = n.get("pct") if n else None
    return {
        "key": key, "name": name,
        "before": {"pct": bp, "screens": (b or {}).get("screens", 0), "covered": (b or {}).get("covered", 0),
                   "by_your_tests": (b or {}).get("by_your_tests", 0), "by_orcha": (b or {}).get("by_orcha", 0),
                   "variations": (b or {}).get("variations", 0), "evidence": (b or {}).get("evidence", "unknown")},
        "now": {"pct": np_, "screens": (n or {}).get("screens", 0), "covered": (n or {}).get("covered", 0),
                "by_your_tests": (n or {}).get("by_your_tests", 0), "by_orcha": (n or {}).get("by_orcha", 0),
                "at_risk": (n or {}).get("at_risk", 0), "unknown": (n or {}).get("unknown", 0),
                "variations": (n or {}).get("variations", 0), "evidence": (n or {}).get("evidence", "unknown")},
        "points": _points(bp, np_),
        "added": add,
        "new": b is None,
    }


def growth(baseline: dict[str, Any], now: dict[str, Any], *, since: str) -> dict[str, Any]:
    """Per area and overall: before and now, the points, and what Orcha added."""
    b_areas = {a["key"]: a for a in baseline.get("areas") or []}
    n_areas = {a["key"]: a for a in now.get("areas") or []}
    names = {k: a["name"] for k, a in b_areas.items()} | {k: a["name"] for k, a in n_areas.items()}
    areas = [_area_row(k, names[k], b_areas.get(k), n_areas.get(k), added(baseline, now, k)) for k in names]
    # Most points first; on a tie (always on the baseline's own day) the most covered, then the
    # biggest, so the areas that matter lead and the untested tail of tiny ones comes last.
    areas.sort(key=lambda a: (a["points"] is None, -(a["points"] or 0), -((a.get("now") or {}).get("covered") or 0),
                              -((a.get("now") or {}).get("screens") or 0), a["name"].lower()))
    overall = _area_row("all", "All screens", baseline.get("totals"), now.get("totals"), added(baseline, now))
    return {"since": since, "overall": overall, "areas": areas, "headline": headline(overall, since), "lines": [area_line(a, since) for a in areas]}


def _change(before: int | None, now: int | None, points: int | None) -> str:
    if points is None:
        return "evidence unknown" if now is None else f"{now}% (no baseline figure)"
    if points == 0:
        return f"{before}% → {now}% (no change)"
    sign = "+" if points > 0 else "−"
    unit = "point" if abs(points) == 1 else "points"
    return f"{before}% → {now}% ({sign}{abs(points)} {unit})"


def _added_words(add: dict[str, Any]) -> str:
    parts = []
    if add["scenarios"]:
        parts.append(_plural(add["scenarios"], "scenario"))
    if add["variations"]:
        parts.append(_plural(add["variations"], "data variation"))
    if add["screens_reached"]:
        parts.append(_plural(add["screens_reached"], "newly reached screen"))
    if not parts:
        return ""
    return "Orcha added " + (", ".join(parts[:-1]) + " and " + parts[-1] if len(parts) > 1 else parts[0])


def headline(overall: dict[str, Any], since: str) -> str:
    """"Coverage: 40% → 85% since Oct 2 (+45 points). Orcha added 12 scenarios and 30 data variations.\""""
    b, n, p = overall["before"]["pct"], overall["now"]["pct"], overall["points"]
    if p is None:
        head = "Coverage evidence is unknown so far: map the app or run your scenarios to measure it."
    else:
        head = f"Coverage: {_change(b, n, p).replace(' (', f' since {short_date(since)} (', 1)}."
    words = _added_words(overall["added"])
    return f"{head} {words}." if words else head


def area_line(a: dict[str, Any], since: str) -> str:
    """"Checkout: 40% → 85% since Oct 2 (+45 points); Orcha added 12 scenarios and 30 data variations.\""""
    b, n, p = a["before"]["pct"], a["now"]["pct"], a["points"]
    change = _change(b, n, p)
    when = f" since {short_date(since)}" if p is not None else ""
    if p is not None:
        change = change.replace(" (", f"{when} (", 1)
    words = _added_words(a["added"])
    return f"{a['name']}: {change}" + (f"; {words}." if words else ".")


#: The weekly line compares with a point between 7 and this many days old; an older one would not
#: be "this week" (the worker records a point every day, so there is normally one 7 days old).
WEEK_MAX_DAYS = 13


def weekly_line(points: list[dict[str, Any]], now: dict[str, Any], today: datetime | None = None) -> str | None:
    """"This week: coverage 72% (+6 points); Orcha added 3 scenarios and 8 data variations." from
    the newest point at least a week old (None until there is one, or when the newest such point is
    more than `WEEK_MAX_DAYS` old)."""
    today = today or datetime.now(timezone.utc)
    cutoff = _day(today - timedelta(days=7))
    floor = _day(today - timedelta(days=WEEK_MAX_DAYS))
    old = [p for p in points if floor <= str(p.get("day") or "") <= cutoff]
    if not old or now["totals"].get("pct") is None:
        return None
    week = max(old, key=lambda p: p["day"])
    data = week.get("data") or {}
    before = (data.get("totals") or {}).get("pct")
    if before is None:
        return None
    pts = now["totals"]["pct"] - before
    add = added(data, now)
    words = _added_words(add)
    change = "no change" if pts == 0 else f"{'+' if pts > 0 else '−'}{abs(pts)} {'point' if abs(pts) == 1 else 'points'}"
    return f"This week: coverage {now['totals']['pct']}% ({change})" + (f"; {words}." if words else ".")


def series(baseline_row: dict[str, Any] | None, points: list[dict[str, Any]], now: dict[str, Any], today: str) -> list[dict[str, Any]]:
    """The chart's points, oldest first, from the baseline's day: `{day, kind, pct, areas: {key:
    pct}}`, today's being the live measurement. On the baseline's own day the baseline keeps its
    figure, and a later measurement that day (a run that landed after it) follows it as a second
    point of the same day, so the chart never labels today's figure as the baseline's."""
    out: dict[tuple[str, int], dict[str, Any]] = {}
    start = str((baseline_row or {}).get("day") or "")

    rule = int(now.get("screen_rule") or 1)

    def put(day: str, m: dict[str, Any], kind: str) -> None:
        if not day or (start and day < start):
            return
        out[(day, 0 if kind == "baseline" else 1)] = {"day": day, "kind": kind, "pct": (m.get("totals") or {}).get("pct"),
                                                      "areas": {a["key"]: a.get("pct") for a in m.get("areas") or []},
                                                      # Counted under another screen rule and not recounted (#467).
                                                      "old_count": int(m.get("screen_rule") or 1) != rule}

    for p in points:
        put(str(p.get("day") or ""), p.get("data") or {}, "point")
    if baseline_row:
        put(start, baseline_row.get("data") or {}, "baseline")
    # Never before the baseline: one taken in the evening before #461 was keyed on the UTC date,
    # a day ahead of the person's today, and dropped the live point from the chart.
    put(max(today, start) if start else today, now, "now")
    same = out.get((start, 1))
    if baseline_row and same is not None and same["pct"] == out[(start, 0)]["pct"] and same["areas"] == out[(start, 0)]["areas"]:
        del out[(start, 1)]  # nothing changed since it was taken: one point, the baseline
    return [out[k] for k in sorted(out)]
