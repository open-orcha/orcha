"""Screen speed: the timings the Slowest screens page and the Map's speed overlay read.

No table of samples: a sample is read from the steps a session recorded. Each action the MCP
server sends carries `duration_ms` and `timing` (how long the screen took to react and to hold
still, the host's load per core), and the `screen` step right after it says which screen it led
to. So an action gives:

- `appear` (or `launch` for a launch): sent to first change on screen
- `settle`: sent to held still

An action with no screen after it has no screen to credit; one that changed nothing timed no
screen. A sample taken under load, or on a session's first launch, is noise: kept and counted,
never compared. The ranking itself (median, baseline, heat) is the page's (`map/perf/perf.ts`).

Settings are a person's (`qa_perf_settings`): `{}` means every default below.
"""

from __future__ import annotations

import copy
from datetime import datetime, timedelta
from typing import Any, Optional

from portal_backend import qa_store as qs
from portal_backend.qa_atlas import STALE_MINUTES, _parse_at, _when

#: The newest steps read for one window, at most.
WINDOW_LIMIT = 40000
#: How many of a running session's newest timings the page shows.
LIVE_SHOWN = 6

DEFAULTS: dict[str, Any] = {
    # A regression: this much slower than the screen's baseline median, in percent...
    "regression_pct": 50,
    # ...and at least this many milliseconds slower, so a 100 ms screen at 160 ms is not one...
    "regression_min_ms": 300,
    # ...on this many sessions in a row.
    "confirm_runs": 2,
    # The baseline: the median and p90 of this many of the screen's newest clean samples.
    "baseline_runs": 20,
    # Absolute budgets: over one is slow whatever the history says.
    "budgets": {"web_lcp_ms": 2500, "appear_ms": 1500, "launch_ms": 3000},
    # A sample taken while the host's load per core is above this is left out (noise).
    "load_limit": 1.5,
}
#: (min, max) of each number, inclusive.
RANGES: dict[str, tuple[float, float]] = {
    "regression_pct": (5, 1000),
    "regression_min_ms": (0, 60000),
    "confirm_runs": (1, 10),
    "baseline_runs": (3, 200),
    "load_limit": (0.5, 10),
    "web_lcp_ms": (100, 60000),
    "appear_ms": (100, 60000),
    "launch_ms": (100, 120000),
}


def _in_range(key: str, v: Any) -> bool:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return False
    lo, hi = RANGES[key]
    return lo <= v <= hi


def normalise(raw: Any) -> dict[str, Any]:
    """The stored value laid over the defaults; a value of the wrong type or out of range is the
    default."""
    out = copy.deepcopy(DEFAULTS)
    if not isinstance(raw, dict):
        return out
    for key in ("regression_pct", "regression_min_ms", "confirm_runs", "baseline_runs", "load_limit"):
        v = raw.get(key)
        if _in_range(key, v):
            out[key] = int(v) if key in ("confirm_runs", "baseline_runs") else v
    budgets = raw.get("budgets")
    if isinstance(budgets, dict):
        for key in DEFAULTS["budgets"]:
            if _in_range(key, budgets.get(key)):
                out["budgets"][key] = budgets[key]
    return out


def validate(fields: Any) -> tuple[Optional[dict[str, Any]], Optional[str]]:
    """A change from the page: `(what to lay over the stored value, None)` or `(None, why not)`."""
    if not isinstance(fields, dict) or not fields:
        return None, "Send at least one setting."
    unknown = sorted(set(fields) - set(DEFAULTS))
    if unknown:
        return None, f"Unknown setting: {', '.join(unknown)}."
    out: dict[str, Any] = {}
    for key, v in fields.items():
        if key == "budgets":
            if not isinstance(v, dict) or set(v) - set(DEFAULTS["budgets"]):
                return None, "budgets takes web_lcp_ms, appear_ms and launch_ms."
            for b, bv in v.items():
                if not _in_range(b, bv):
                    lo, hi = RANGES[b]
                    return None, f"{b} must be a number from {lo:g} to {hi:g}."
            out["budgets"] = dict(v)
        else:
            if not _in_range(key, v):
                lo, hi = RANGES[key]
                return None, f"{key} must be a number from {lo:g} to {hi:g}."
            out[key] = v
    return out, None


def read_settings(cur, cid: str) -> dict[str, Any]:
    cur.execute("SELECT settings FROM qa_perf_settings WHERE container_id=%s", (cid,))
    row = cur.fetchone()
    return normalise(qs._json(row["settings"], {}) if row else {})


def write_settings(cur, cid: str, who: dict, change: dict[str, Any]) -> dict[str, Any]:
    cur.execute("SELECT settings FROM qa_perf_settings WHERE container_id=%s", (cid,))
    row = cur.fetchone()
    base = dict(qs._json(row["settings"], {})) if row else {}
    for key, v in change.items():
        base[key] = {**(base.get("budgets") if isinstance(base.get("budgets"), dict) else {}), **v} if key == "budgets" else v
    cur.execute(
        """INSERT INTO qa_perf_settings (container_id, settings, updated_by, updated_at) VALUES (%s,%s,%s,%s)
           ON CONFLICT (container_id) DO UPDATE SET settings=EXCLUDED.settings, updated_by=EXCLUDED.updated_by,
             updated_at=EXCLUDED.updated_at""",
        (cid, qs.dumps(base), who["id"], qs.now()),
    )
    return normalise(base)


def device_class(platform: str, device: Optional[str]) -> str:
    """What baselines are kept per: the model on a phone, the viewport class on the web."""
    if platform == "web":
        return "mobile" if str(device or "").lower() == "mobile" else "desktop"
    return device or ""


def noise_of(timing: dict[str, Any], load_limit: float) -> Optional[str]:
    """Why a sample is noise, or None for a clean one."""
    if timing.get("cold"):
        return "cold_start"
    load = timing.get("load")
    return "under_load" if isinstance(load, (int, float)) and load > load_limit else None


def samples_of(steps: list[dict], labels: dict[tuple, str], load_limit: float) -> list[dict]:
    """The samples of one session's steps, in seq order."""
    out: list[dict] = []
    for i, st in enumerate(steps):
        if st["kind"] == "screen" or st.get("duration_ms") is None:
            continue
        after = steps[i + 1] if i + 1 < len(steps) else None
        if not after or after["kind"] != "screen" or not after.get("screen_key"):
            continue  # two actions without a look between them: no screen to credit
        timing = st.get("timing") if isinstance(st.get("timing"), dict) else {}
        if timing.get("settled") == "unchanged":
            continue
        key, p = str(after["screen_key"]), str(st["platform"])
        row = {"run_id": str(st["session_id"]), "screen_key": key, "screen_label": labels.get((p, key)), "platform": p,
               "device": st.get("device_name"), "device_class": device_class(p, st.get("device_name")), "step_seq": st["seq"],
               "noise": noise_of(timing, load_limit), "created_at": _when(st.get("at"))}
        if st["kind"] == "launch":
            out.append({**row, "metric": "launch", "value": timing.get("appear_ms") or st["duration_ms"]})
            continue
        if timing.get("appear_ms") is not None:
            out.append({**row, "metric": "appear", "value": timing["appear_ms"]})
        out.append({**row, "metric": "settle", "value": timing.get("settle_ms") or st["duration_ms"]})
    return out


def read_perf(cur, cid: str, days: int, platform: Optional[str], now: Optional[datetime] = None) -> dict:
    """`{samples, screens, running, platforms, settings, days}`: the window's samples oldest first,
    each screen's node and frame as the map knows it, and the sessions timing screens now."""
    now = now or qs.now()
    settings = read_settings(cur, cid)
    cutoff = _when(now - timedelta(days=days))
    cur.execute(
        """SELECT st.session_id, st.seq, st.kind, st.duration_ms, st.timing, st.screen_key, st.at,
                  s.platform, s.device_name
             FROM qa_steps st JOIN qa_sessions s ON s.id = st.session_id
            WHERE st.container_id = %s AND (st.kind = 'screen' OR st.duration_ms IS NOT NULL)
            ORDER BY st.at DESC, st.seq DESC
            LIMIT %s""",
        (cid, WINDOW_LIMIT),
    )
    rows = [qs.public(r) for r in cur.fetchall()]
    cur.execute("SELECT id, platform, key, label, frame_id FROM qa_map_nodes WHERE container_id=%s AND kind='screen'", (cid,))
    nodes = [dict(r) for r in cur.fetchall()]
    labels = {(str(n["platform"]), str(n["key"])): str(n["label"]) for n in nodes if n.get("label")}
    known = {f"{n['platform']}:{n['key']}": {"node": str(n["id"]), "frame": f"/api/qa/frames/{n['frame_id']}" if n.get("frame_id") else None}
             for n in nodes}
    sessions: dict[str, list[dict]] = {}
    for r in rows:
        sessions.setdefault(str(r["session_id"]), []).append(r)
    samples: list[dict] = []
    for steps in sessions.values():
        steps.sort(key=lambda s: s["seq"])
        samples += [x for x in samples_of(steps, labels, settings["load_limit"]) if x["created_at"] >= cutoff]
    every = sorted({x["platform"] for x in samples})
    if platform:
        samples = [x for x in samples if x["platform"] == platform]
    samples.sort(key=lambda x: (x["created_at"], x["step_seq"]))
    return {"samples": samples, "screens": known, "running": _running(cur, cid, sessions, labels, platform, now),
            "platforms": every, "days": days, "settings": settings}


def _running(cur, cid: str, sessions: dict[str, list[dict]], labels: dict[tuple, str], platform: Optional[str], now: datetime) -> list[dict]:
    """The sessions going now that act on a device, with what they timed so far."""
    cur.execute("""SELECT id, platform, device_name, started_at, last_seen_at FROM qa_sessions
                    WHERE container_id=%s AND status='running' AND kind <> 'draft' ORDER BY started_at DESC LIMIT 20""", (cid,))
    out: list[dict] = []
    for r in [qs.public(x) for x in cur.fetchall()]:
        heard = _parse_at(r.get("last_seen_at") or r.get("started_at"))
        if heard is not None and now - heard > timedelta(minutes=STALE_MINUTES):
            continue
        if platform and r["platform"] != platform:
            continue
        steps = sessions.get(str(r["id"])) or []
        timed = []
        for i, st in enumerate(steps):
            if st["kind"] == "screen" or st.get("duration_ms") is None:
                continue
            after = steps[i + 1] if i + 1 < len(steps) else None
            timing = st.get("timing") if isinstance(st.get("timing"), dict) else {}
            key = str(after["screen_key"]) if after and after["kind"] == "screen" and after.get("screen_key") else None
            timed.append({"seq": st["seq"], "kind": st["kind"], "at_ms": 0, "appear_ms": timing.get("appear_ms"),
                          "settle_ms": timing.get("settle_ms") or st["duration_ms"], "settled": timing.get("settled"),
                          "screen": labels.get((str(r["platform"]), key), key) if key else None})
        out.append({"run_id": str(r["id"]), "platform": r["platform"], "device": r.get("device_name"), "started_at": r.get("started_at"),
                    "timed": len(timed), "latest": timed[-LIVE_SHOWN:]})
    return out
