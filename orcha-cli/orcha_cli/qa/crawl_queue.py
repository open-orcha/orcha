"""The planned crawl's queue: a map session's list of unreached screens and the clock on each.

Left alone, a map session gets a list of unreached screens and wanders. Here the tool server
plans a **queue** and holds the agent to it:

- **Planning** (`plan_queue`): the map's unreached screens (`declared`) on the session's platform,
  each with a way in (`WayIn`) and a score: how close it is to a screen sessions saw (`navigates`
  hops) and how cheap its way in is (a route or deep link beats a path, a path beats nothing).
  Highest score first.
- **Running** (`CrawlQueue`): one target at a time. A target has a budget to reach it and one to
  explore it once reached (per tier, `budgets_for`). When the phase's budget runs out the agent is
  told (a nudge on the next screen); `grace_s` later the queue moves on by itself, so no target
  takes more than its budget plus the grace. A target reached on the way is done; a screen the map
  never had joins the queue as discovered. Dead ends are marked blocked with a kind, and every
  target the session does not reach keeps a reason.

`CrawlQueue.as_json` is what the tool server stores on the session (`qa_sessions.crawl_queue`,
`PUT /api/qa/sessions/{sid}/crawl-queue`) and the Map page shows live: the next targets outlined,
the current one under its budget ring, and the chip's "14 of 40 targets".
"""

from __future__ import annotations

import re
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Optional
from urllib.parse import urlsplit

from .codemap import keys

VERSION = 1
#: Most targets planned (the queue grows with discovered screens).
MAX_TARGETS = 60
#: Seconds after a phase's budget before the queue moves on by itself.
GRACE_S = 10
#: Per-tier budgets: (reach_s, explore_s) by the session's minutes.
MAP_BUDGETS = ((10, 30, 45), (20, 45, 60), (40, 45, 90))
#: A focused pass: the high-level map takes one look at each main area; the deeper pass works
#: through a platform's unseen screens. Each ends when its list is through.
FOCUS_BUDGETS = {"overview": (20, 15), "deeper": (30, 30)}
FOCUSES = tuple(FOCUS_BUDGETS)
#: The most screens one deeper pass visits (the atlas's "Fill in" says so too).
MAX_DEEPER = 25
GUIDE_BUDGETS = (60, 120)
STATUSES = ("queued", "current", "reached", "explored", "blocked", "skipped")
DONE = frozenset({"reached", "explored", "blocked", "skipped"})
#: What a target's way in is worth when ordering (a direct way in is cheap).
WAY_SCORE = {"route": 2.0, "deep_link": 2.0, "intent": 1.5, "path": 1.0, "none": -1.0}
WAY_KINDS = ("route", "deep_link", "intent", "path", "none")
#: Most hops a path way in may take (longer is the agent's job).
MAX_HOPS = 6
#: Seen screens revisited a few at a time once the queue is through.
REVISIT_BATCH = 6


def budgets_for(scope: Optional[str], minutes: Optional[float], focus: Optional[str] = None) -> tuple[int, int]:
    """(reach_s, explore_s) for a target: a map session scales with its minutes (a focused pass has
    its own); any other kind that uses the queue as a guide gets roomy budgets never enforced."""
    if scope == "map" and focus in FOCUS_BUDGETS:
        return FOCUS_BUDGETS[focus]
    if scope != "map":
        return GUIDE_BUDGETS
    m = int(minutes or 20)
    for upto, reach, explore in MAP_BUDGETS:
        if m <= upto:
            return reach, explore
    return MAP_BUDGETS[-1][1], MAP_BUDGETS[-1][2]


def _iso(t: Optional[float]) -> Optional[str]:
    if t is None:
        return None
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(t % 1 * 1000):03d}Z"


def _fmt(seconds: float) -> str:
    s = max(0, round(seconds))
    return f"{s // 60}:{s % 60:02d}"


# ---------- the way in ----------


@dataclass
class WayIn:
    kind: str  # one of WAY_KINDS
    url: Optional[str] = None  # route / deep link: what open_url opens
    hops: list[dict[str, Any]] = field(default_factory=list)  # path: [{from, to, label}]
    note: Optional[str] = None  # where the ids came from, or how to get there by hand
    intent: Optional[dict[str, Any]] = None  # intent: {action, component, extras}

    def public(self) -> dict[str, Any]:
        out: dict[str, Any] = {"kind": self.kind}
        if self.url:
            out["url"] = self.url
        if self.hops:
            out["hops"] = len(self.hops)
            out["path"] = [h["label"] for h in self.hops]
        if self.note:
            out["note"] = self.note
        if self.intent:
            out["intent"] = self.intent
        return out

    def as_json(self) -> dict[str, Any]:
        return {"kind": self.kind, "url": self.url, "hops": self.hops, "note": self.note, "intent": self.intent}

    @classmethod
    def from_json(cls, data: Any) -> "WayIn":
        if not isinstance(data, dict):
            return cls("none")
        kind = data.get("kind") if data.get("kind") in WAY_KINDS else "none"
        hops = [h for h in data.get("hops") or [] if isinstance(h, dict)] if isinstance(data.get("hops"), list) else []
        intent = data.get("intent") if isinstance(data.get("intent"), dict) else None
        return cls(kind, data.get("url") or None, hops, data.get("note") or None, intent)

    def describe(self) -> str:
        """One line for the brief and the screen header."""
        if self.kind == "route":
            return f"open {self.url}" + (f" (ids from {self.note})" if self.note else "")
        if self.kind == "deep_link":
            return f"deep link {self.url}" + (f" (ids from {self.note})" if self.note else "")
        if self.kind == "intent" and self.intent:
            extras = ", ".join(f"{k}={v}" for k, v in self.intent.get("extras") or [])
            return f"intent {self.intent.get('action')}" + (f" ({extras})" if extras else "")
        if self.kind == "path":
            return " → ".join(h["label"] or "?" for h in self.hops) + f" (from {self.hops[0]['from']})" if self.hops else "path"
        return self.note or "no way in known: navigate from the nearest screen you know"


# ---------- the queue ----------


@dataclass
class Target:
    key: str
    label: str
    feature: Optional[str] = None
    way_in: WayIn = field(default_factory=lambda: WayIn("none"))
    score: float = 0.0
    why: list[str] = field(default_factory=list)
    origin: str = "map"  # map | discovered
    status: str = "queued"
    phase: Optional[str] = None  # reach | explore, while current
    phase_started: Optional[float] = None  # wall clock
    started: Optional[float] = None  # when this pass at it began (None when not current)
    used_s: float = 0.0
    overruns: int = 0
    reason: Optional[str] = None
    kind: Optional[str] = None  # a blocked target's kind (`map_blocked`)
    landed: Optional[str] = None  # what the way in showed instead, when it missed
    passes: int = 0

    def plan_json(self) -> dict[str, Any]:
        return {
            "key": self.key, "label": self.label, "feature": self.feature, "way_in": self.way_in.as_json(),
            "score": round(self.score, 2), "why": self.why, "origin": self.origin,
        }

    @classmethod
    def from_plan(cls, data: dict[str, Any]) -> "Target":
        return cls(
            key=str(data["key"]), label=str(data.get("label") or data["key"]), feature=data.get("feature") or None,
            way_in=WayIn.from_json(data.get("way_in")), score=float(data.get("score") or 0.0),
            why=[str(w) for w in data.get("why") or []], origin=str(data.get("origin") or "map"),
        )


@dataclass
class Tick:
    """What the clock says about the current target: a nudge (its budget ran out), or that the
    queue moved on (the grace ran out too)."""

    nudge: Optional[str] = None
    advanced: Optional[Target] = None  # the target the queue left
    note: Optional[str] = None


class CrawlQueue:
    """The queue's live state in the tool server (see the module docstring). `clock` is wall
    time (the Map page counts the ring down from the stored times); `on_change` is called with
    the queue after every change (the server stores it on the session)."""

    def __init__(self, targets: list[Target], *, mode: str = "enforced", platform: Optional[str] = None,
                 budgets: tuple[int, int] = (30, 45), grace_s: float = GRACE_S,
                 clock: Callable[[], float] = time.time, on_change: Optional[Callable[["CrawlQueue"], None]] = None):
        self.targets = list(targets)
        self.mode = mode
        self.platform = platform
        self.reach_s, self.explore_s = budgets
        self.grace_s = grace_s
        self.clock = clock
        self.on_change = on_change
        self.revisits: list[Target] = []  # seen screens with actions to try, once the queue is through
        self.current: Optional[Target] = None
        self.started: Optional[float] = None
        self.second_pass = False
        self.last_key: Optional[str] = None
        #: A focused pass (`focus`) ends once its list is through (`finished`), instead of going
        #: on with revisits for the rest of its minutes.
        self.focus: Optional[str] = None
        self.finished = False

    # ----- reading -----

    @property
    def enforced(self) -> bool:
        return self.mode == "enforced"

    def by_key(self, key: str) -> Optional[Target]:
        return next((t for t in self.targets if t.key == key), None)

    @property
    def done(self) -> int:
        return sum(1 for t in self.targets if t.status in DONE)

    @property
    def reached(self) -> int:
        return sum(1 for t in self.targets if t.status in ("reached", "explored"))

    def next_queued(self) -> Optional[Target]:
        return next((t for t in self.targets if t.status == "queued"), None)

    def budget_s(self, t: Optional[Target] = None) -> float:
        t = t or self.current
        if t is None:
            return 0.0
        return float(self.explore_s if t.phase == "explore" else self.reach_s)

    def phase_elapsed(self, now: Optional[float] = None) -> float:
        t = self.current
        if t is None or t.phase_started is None:
            return 0.0
        return max(0.0, (self.clock() if now is None else now) - t.phase_started)

    # ----- moving -----

    def _changed(self) -> None:
        if self.on_change is not None:
            try:
                self.on_change(self)
            except Exception:  # noqa: BLE001 - storing the queue never breaks the session
                pass

    def start_next(self) -> Optional[Target]:
        """Make the next queued target current (a second pass over the skipped ones once the
        queue is through, once). None when nothing is left."""
        now = self.clock()
        if self.started is None:
            self.started = now
        t = self.next_queued()
        if t is None and not self.second_pass:
            again = [x for x in self.targets if x.status == "skipped" and x.passes < 2 and x.way_in.kind != "none"]
            if again:
                self.second_pass = True
                for x in again:
                    x.status, x.reason, x.overruns = "queued", None, 0
                t = self.next_queued()
        if t is None and self.revisits:
            # Through the unreached screens: the seen ones with the fewest actions tried, a few
            # at a time (a screen reached on the way meanwhile is skipped).
            known = {x.key for x in self.targets if x.origin == "revisit"}
            batch = [r for r in self.revisits if r.key not in known][:REVISIT_BATCH]
            self.revisits = [r for r in self.revisits if r not in batch]
            self.targets.extend(batch)
            t = self.next_queued()
        self.current = t
        if t is not None:
            t.status, t.phase, t.phase_started, t.overruns = "current", "reach", now, 0
            t.started = now  # this pass
            t.passes += 1
            if self.last_key == t.key:
                self._reach(t, now)
        self._changed()
        return t

    def _reach(self, t: Target, now: float) -> None:
        t.phase, t.phase_started, t.overruns, t.landed = "explore", now, 0, None

    def _close(self, t: Target, status: str, reason: Optional[str] = None, kind: Optional[str] = None) -> None:
        now = self.clock()
        if t.started is not None:
            t.used_s = round(t.used_s + max(0.0, now - t.started), 1)
            t.started = None
        t.status, t.phase, t.phase_started = status, None, None
        if reason:
            t.reason = reason
        if kind:
            t.kind = kind
        if self.current is t:
            self.current = None

    def finish(self, *, blocked_kind: Optional[str] = None, reason: Optional[str] = None) -> Optional[Target]:
        """The agent is done with the current target (`crawl_next`): explored when it was
        reached, blocked when the agent says why, else skipped with what the way in showed."""
        t = self.current
        if t is None:
            return None
        if blocked_kind:
            self._close(t, "blocked", reason or "dead end", blocked_kind)
        elif t.phase == "explore":
            self._close(t, "explored")
        else:
            why = reason or (f"not reached: {t.way_in.describe()} showed {t.landed}" if t.landed else "moved on before reaching it")
            self._close(t, "skipped", why)
        self._changed()
        return t

    def observe(self, key: Optional[str], label: Optional[str] = None, *, new: bool = False, url: Optional[str] = None,
                via: Optional[dict[str, Any]] = None) -> Optional[str]:
        """The screen the app is on now. Reaching the current target starts its explore phase;
        another queued target met on the way is done; a screen the map never had joins the
        queue as discovered (done: the crawl is on it). Returns a line for the agent, or None."""
        if not key:
            return None
        now = self.clock()
        prev, self.last_key = self.last_key, key
        cur = self.current
        if cur is not None and cur.key == key:
            if cur.phase == "reach":
                self._reach(cur, now)
                self._changed()
                return f"reached {cur.label}: explore it ({self.explore_s} s)"
            return None
        if cur is not None and cur.phase == "reach" and prev != key:
            cur.landed = label or key
        t = self.by_key(key)
        if t is not None and t.status == "queued":
            t.status = "reached"
            t.reason = None
            self._changed()
            return f"reached {t.label} on the way (a queued target)"
        if t is None and new:
            way = WayIn("route", url) if url else (WayIn("path", hops=[via]) if via else WayIn("none"))
            found = Target(key=key, label=label or keys.humanize(key), way_in=way, origin="discovered", status="reached",
                           why=["discovered on the way"])
            self.targets.append(found)
            self._changed()
            return f"new screen: {found.label} joined the queue"
        return None

    def mark_blocked(self, key: str, kind: str, reason: str) -> bool:
        """A dead end the agent marked with `map_blocked`: the target is blocked (the current
        one too). False when the key is not on the queue."""
        t = self.by_key(key)
        if t is None or t.status in ("explored", "reached"):
            return False
        if t is self.current:
            self._close(t, "blocked", reason, kind)
        else:
            t.status, t.reason, t.kind = "blocked", reason, kind
        self._changed()
        return True

    def tick(self) -> Tick:
        """Check the current target's clock (before an action and on every screen): the first
        overrun nudges, the second (`grace_s` later) moves the queue on. Never in guide mode."""
        t = self.current
        if t is None or not self.enforced or t.phase_started is None:
            return Tick()
        elapsed = self.phase_elapsed()
        budget = self.budget_s(t)
        if elapsed <= budget:
            return Tick()
        if elapsed <= budget + self.grace_s:
            if t.overruns == 0:
                t.overruns = 1
                self._changed()
            what = "reach" if t.phase == "reach" else "explore"
            hint = (
                "mark it a dead end with crawl_next(blocked_kind=..., reason=...) or call crawl_next() to move on"
                if t.phase == "reach" else "finish the action you are on, then crawl_next()"
            )
            return Tick(nudge=(
                f"time's up for {t.label} ({_fmt(budget)} to {what}, {_fmt(elapsed)} used): {hint};"
                f" the queue moves on by itself in {_fmt(budget + self.grace_s - elapsed)}"
            ))
        t.overruns = 2
        left = t
        if t.phase == "explore":
            self._close(t, "explored")
        else:
            seen = f": {t.way_in.describe()} showed {t.landed}" if t.landed else ""
            self._close(t, "skipped", f"not reached in its {_fmt(budget)} budget{seen}")
        self._changed()
        return Tick(advanced=left, note=f"time's up twice for {left.label}: the queue moved on")

    # ----- telling -----

    def header(self) -> Optional[str]:
        """The crawl line every screen result starts with."""
        t = self.current
        total = len(self.targets)
        if t is None:
            if self.started is None:
                return f"crawl: {total} target{'s' if total != 1 else ''} queued; call crawl_next() to open the first"
            if self.next_queued() is None:
                return f"crawl: queue done ({self.reached} of {total} reached); explore what is left, deeper or in the other appearance"
            return f"crawl: {self.done} of {total} done; call crawl_next() for the next target"
        pos = self.targets.index(t) + 1
        budget = self.budget_s(t)
        left = budget - self.phase_elapsed()
        phase = "to reach" if t.phase == "reach" else "to explore"
        clock = f"{_fmt(max(0.0, left))} left {phase}" if self.enforced else f"{_fmt(self.phase_elapsed())} {phase[3:]}ing"
        return f"crawl: target {pos} of {total} · {t.label} (`{t.key}`) · {clock} · {self.done} done"

    def summary_lines(self) -> list[str]:
        """For end_session and the report: what was reached and why each other target was not."""
        planned = [t for t in self.targets if t.origin != "revisit"]
        revisited = [t for t in self.targets if t.origin == "revisit" and t.status in ("reached", "explored")]
        lines = [f"crawl: {sum(1 for t in planned if t.status in ('reached', 'explored'))} of {len(planned)} targets reached"
                 f" ({sum(1 for t in planned if t.origin == 'discovered')} discovered on the way)"
                 + (f"; then {len(revisited)} seen screen{'s' if len(revisited) != 1 else ''} explored for new ones" if revisited else "")]
        for t in self.targets:
            if t.status in ("reached", "explored") or t.origin == "revisit":
                continue
            if t.status == "blocked":
                lines.append(f"- {t.label} (`{t.key}`): blocked, {t.kind or 'other'}: {t.reason}")
            elif t.status == "skipped":
                lines.append(f"- {t.label} (`{t.key}`): {t.reason}")
            elif t.status in ("queued", "current"):
                lines.append(f"- {t.label} (`{t.key}`): not tried, the time ran out first")
        return lines

    def unreached(self) -> list[dict[str, Any]]:
        out = []
        for t in self.targets:
            if t.status in ("reached", "explored") or t.origin == "revisit":
                continue
            reason = t.reason or ("not tried: the time ran out first" if t.status in ("queued", "current") else "not reached")
            out.append({"key": t.key, "label": t.label, "status": t.status, "kind": t.kind, "reason": reason})
        return out

    def as_json(self) -> dict[str, Any]:
        now = self.clock()
        cur = self.current
        targets = []
        for t in self.targets:
            row: dict[str, Any] = {
                "key": t.key, "label": t.label, "feature": t.feature, "status": t.status, "way_in": t.way_in.public(),
                "used_s": t.used_s, "overruns": t.overruns, "origin": t.origin, "score": round(t.score, 2), "why": t.why,
            }
            if t.reason:
                row["reason"] = t.reason
            if t.kind:
                row["kind"] = t.kind
            if t is cur:
                budget = self.budget_s(t)
                row.update({
                    "phase": t.phase, "budget_s": budget, "phase_started_at": _iso(t.phase_started),
                    "deadline_at": _iso((t.phase_started or now) + budget),
                    "used_s": round(t.used_s + max(0.0, now - (t.started or now)), 1),
                })
            targets.append(row)
        return {
            "version": VERSION, "mode": self.mode, "platform": self.platform, "focus": self.focus, "total": len(self.targets),
            "done": self.done, "reached": self.reached, "index": self.targets.index(cur) if cur is not None else None,
            "current": cur.key if cur is not None else None, "updated_at": _iso(now), "started_at": _iso(self.started),
            "budgets": {"reach_s": self.reach_s, "explore_s": self.explore_s, "grace_s": self.grace_s},
            "targets": targets,
        }

# ---------- planning ----------


class MapGraph:
    """The map as `GET C/map` answers it, as much as planning reads."""

    def __init__(self, data: dict[str, Any]):
        nodes = [n for n in data.get("nodes") or [] if isinstance(n, dict)]
        self.screens = [n for n in nodes if n.get("kind") == "screen" and n.get("key")]
        self.by_key = {str(n["key"]): n for n in self.screens}
        self.nav: dict[str, list[dict[str, Any]]] = {}
        for e in data.get("edges") or []:
            if isinstance(e, dict) and e.get("kind") == "navigates" and e.get("from_key") and e.get("to_key"):
                self.nav.setdefault(str(e["from_key"]), []).append(e)


def action_target(label: str) -> Optional[str]:
    """The control a `navigates` edge's label names: `Tap "Properties"` -> `Properties`; None for
    an action that names no control (`Tap row`, `Press back`, `Open /faqs`)."""
    m = re.match(r'^(?:Tap|Long press) "(.+)"$', str(label or "").strip())
    return m.group(1) if m else None


def shortest_path(graph: MapGraph, start_keys: Iterable[str], target_key: str, *, max_hops: int = MAX_HOPS) -> Optional[list[dict[str, Any]]]:
    """The fewest `navigates` hops from any of `start_keys` (seen screens, nearest first) to the
    target, each `{from, to, label}`, preferring edges whose label names a control (replayable).
    None when the map knows no way."""
    if target_key not in graph.by_key:
        return None
    frontier: deque[str] = deque(k for k in start_keys if k in graph.by_key)
    prev: dict[str, Optional[tuple[str, str]]] = {k: None for k in frontier}
    depth = {k: 0 for k in frontier}
    while frontier:
        cur = frontier.popleft()
        if cur == target_key:
            break
        if depth[cur] >= max_hops:
            continue
        edges = sorted(graph.nav.get(cur, []), key=lambda e: (action_target(e.get("label") or "") is None, -int(e.get("count") or 0), e.get("label") or ""))
        for e in edges:
            to = str(e["to_key"])
            if to in prev or to not in graph.by_key:
                continue
            prev[to] = (cur, str(e.get("label") or ""))
            depth[to] = depth[cur] + 1
            frontier.append(to)
    if target_key not in prev:
        return None
    hops: list[dict[str, Any]] = []
    at = target_key
    while prev[at] is not None:
        frm, label = prev[at]  # type: ignore[misc]
        hops.append({"from": frm, "to": at, "label": label})
        at = frm
    return list(reversed(hops)) or None


def hops_from_seen(graph: MapGraph) -> dict[str, int]:
    """Each screen's distance in `navigates` hops from the nearest screen sessions saw (0 for a
    seen screen); screens no path reaches are left out."""
    dist: dict[str, int] = {}
    frontier: deque[str] = deque()
    for n in graph.screens:
        if n.get("state") == "seen":
            dist[str(n["key"])] = 0
            frontier.append(str(n["key"]))
    while frontier:
        cur = frontier.popleft()
        for e in graph.nav.get(cur, []):
            to = str(e["to_key"])
            if to not in dist and to in graph.by_key:
                dist[to] = dist[cur] + 1
                frontier.append(to)
    return dist


def locale_prefix(start_url: Optional[str]) -> str:
    """`/en` for a start URL whose first path segment is a language (`https://x/en/`), else ''."""
    if not start_url or "://" not in start_url:
        return ""
    parts = [p for p in urlsplit(start_url).path.split("/") if p]
    return f"/{parts[0]}" if parts and keys.LOCALE.match(parts[0]) else ""


def origin_of(url: Optional[str]) -> Optional[str]:
    if not url or "://" not in url:
        return None
    s = urlsplit(url)
    return f"{s.scheme}://{s.netloc}" if s.scheme and s.netloc else None


def _route_of(node: dict[str, Any]) -> Optional[str]:
    detail = node.get("detail") if isinstance(node.get("detail"), dict) else {}
    code = detail.get("code") if isinstance(detail.get("code"), dict) else {}
    route = code.get("route") or (node["key"] if str(node["key"]).startswith("/") else None)
    return str(route) if route else None


def _links_of(node: dict[str, Any]) -> list[dict[str, Any]]:
    detail = node.get("detail") if isinstance(node.get("detail"), dict) else {}
    code = detail.get("code") if isinstance(detail.get("code"), dict) else {}
    return [x for x in code.get("links") or detail.get("links") or [] if isinstance(x, dict)]


def _hint(route: str, locale: str) -> str:
    segs = [s for s in route.split("/") if s]
    wild = next((i for i, s in enumerate(segs) if s == "*" or s.startswith(":")), len(segs))
    parent = "/" + "/".join(segs[:wild]) if wild else None
    return f"needs a record: open its list (near {locale}{parent}) and follow one row" if parent else "needs a record: open its list and follow one row"


def way_in(node: dict[str, Any], graph: MapGraph, *, platform: Optional[str], origin: Optional[str], locale: str,
           seen_keys: list[str]) -> WayIn:
    """The cheapest way known to put the app on a screen: its route on the web, a link its code
    declares on a phone, the shortest path the map knows, else nothing."""
    route = _route_of(node)
    if platform == "web" and route:
        if "*" not in route and ":" not in route and origin:
            return WayIn("route", origin + locale + (route if route != "/" else "/"))
        path = shortest_path(graph, seen_keys, str(node["key"]))
        return WayIn("path", hops=path) if path else WayIn("none", note=_hint(route, locale))
    for link in _links_of(node):
        uri = str(link.get("uri") or "")
        if link.get("kind") != "intent" and uri and "{" not in uri and "*" not in uri:
            return WayIn("deep_link", uri)
    path = shortest_path(graph, seen_keys, str(node["key"]))
    return WayIn("path", hops=path) if path else WayIn("none")


def plan_queue(data: dict[str, Any], *, platform: Optional[str], start_url: Optional[str] = None, limit: int = MAX_TARGETS,
               only: Optional[list[str]] = None) -> list[Target]:
    """The crawl's targets, best first (see the module docstring). `only`: a focused pass's own
    list of screen keys, in that order."""
    graph = MapGraph(data)
    origin, locale = origin_of(start_url), locale_prefix(start_url)
    hops = hops_from_seen(graph)
    seen_keys = [str(n["key"]) for n in graph.screens if n.get("state") == "seen"]
    out: list[Target] = []
    for n in graph.screens:
        if n.get("state") != "declared":
            continue
        key = str(n["key"])
        why = ["never reached"]
        score = 0.0
        d = hops.get(key)
        if d is not None and d > 0:
            score += {1: 2.0, 2: 1.0}.get(d, 0.0)
            why.append(f"{d} hop{'s' if d != 1 else ''} from a seen screen")
        way = way_in(n, graph, platform=platform, origin=origin, locale=locale, seen_keys=seen_keys)
        score += WAY_SCORE[way.kind]
        out.append(Target(key=key, label=str(n.get("label") or keys.humanize(key)), feature=n.get("feature_key") or None,
                          way_in=way, score=score, why=why))
    if only is not None:
        order = {k: i for i, k in enumerate(only)}
        return sorted((t for t in out if t.key in order), key=lambda t: order[t.key])[:limit]
    out.sort(key=lambda t: (-t.score, hops.get(t.key, 99), t.key))
    return out[:limit]


def overview_keys(data: dict[str, Any]) -> list[str]:
    """The high-level pass's list: the first unreached screen of each area not seen yet, so each
    main area gets one look."""
    screens = [n for n in data.get("nodes") or [] if isinstance(n, dict) and n.get("kind") == "screen"]
    seen = {n.get("feature_key") for n in screens if n.get("state") == "seen"}
    out: dict[Any, str] = {}
    for n in screens:
        area = n.get("feature_key")
        if n.get("state") == "declared" and area not in seen and area not in out:
            out[area] = str(n["key"])
    return list(out.values())


def plan_session(data: dict[str, Any], *, platform: Optional[str], start_url: Optional[str], minutes: Optional[float],
                 focus: Optional[str], clock: Callable[[], float] = time.time,
                 on_change: Optional[Callable[["CrawlQueue"], None]] = None) -> Optional["CrawlQueue"]:
    """A map session's queue, or None when the map has nothing unreached (a plain crawl then)."""
    focus = focus if focus in FOCUSES else None
    only = overview_keys(data) if focus == "overview" else None
    targets = plan_queue(data, platform=platform, start_url=start_url, limit=MAX_DEEPER if focus == "deeper" else MAX_TARGETS, only=only)
    if not targets:
        return None
    q = CrawlQueue(targets, platform=platform, budgets=budgets_for("map", minutes, focus), clock=clock, on_change=on_change)
    q.focus = focus
    return q
