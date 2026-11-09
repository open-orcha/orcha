"""The live QA session of one `orcha qa mcp` process: its portal row, device, step trace,
budget and the walk in progress.

- `ExplorationBudget`: the minutes are a target the agent
  spends, not just a cap. Every screen result opens with `budget_line()`, and `end_session`
  refuses to end while more than `EARLY_END_FRACTION` (15%) of the budget, and at least
  `MIN_EARLY_END_S`, is left. The only early exit is a hard blocker (`reason="blocked: ..."`) or
  `force=true` with a reason.
- `StepGuard`: a runaway guard, never the budget.
  Near it every screen says so; at it actions are refused with "write the report and end".
- `LiveSession`: the step trace (`seq` increasing from 1, kept locally for walk to scenario and
  sent to the portal in batches), the last screen's map key and frame, and the open walk.
- `LiveSession.frames`, `.person`: the live view's frame writer and the person who took the device
  over (`mcp_server.QATools._live_loop`). `person_step_args` is what the trace keeps of their input.
- `observation(screen)`: what `POST /map/observe` takes from a screen (title, texts, anchors).
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

EARLY_END_FRACTION = 0.15
MIN_EARLY_END_S = 30.0
BLOCKED_PREFIX = "blocked:"
MIN_REASON_CHARS = 10

STEP_GUARD_ENV = "ORCHA_QA_STEP_GUARD"
DEFAULT_STEP_GUARD = 2000
WARN_FRACTION = 0.9

STEP_BATCH = 10  # steps sent to the portal at once (and always before a walk ends or the session ends)
MAX_TEXTS = 40
MAX_ANCHORS = 30
MAX_TEXT_LEN = 120

_HEADING_ROLES = ("Heading", "NavigationBar", "Header", "Title")
_TEXT_ROLES = ("StaticText", "Heading", "Text", "TextView", "Header", "Title", "NavigationBar")
_ANCHOR_ROLES = ("Button", "Tab", "Link", "MenuItem", "Cell", "Switch", "Toggle", "SegmentedControl", "TextField",
                 "SearchField", "SecureTextField")


def is_blocker(reason: Optional[str]) -> bool:
    """Whether `reason` names a hard blocker (`blocked: <what>`), the only early exit."""
    text = (reason or "").strip()
    return text.lower().startswith(BLOCKED_PREFIX) and len(text[len(BLOCKED_PREFIX):].strip()) >= MIN_REASON_CHARS


def fmt_s(seconds: float) -> str:
    s = max(0, int(round(seconds)))
    return f"{s // 60}m{s % 60:02d}s"


@dataclass
class ExplorationBudget:
    minutes: float
    clock: Callable[[], float] = time.monotonic
    started: float = 0.0

    def __post_init__(self) -> None:
        if not self.started:
            self.started = self.clock()

    @property
    def total_s(self) -> float:
        return self.minutes * 60.0

    @property
    def used_s(self) -> float:
        return max(0.0, self.clock() - self.started)

    @property
    def left_s(self) -> float:
        return max(0.0, self.total_s - self.used_s)

    def ending_early(self) -> bool:
        return self.left_s > max(MIN_EARLY_END_S, EARLY_END_FRACTION * self.total_s)

    def budget_line(self) -> str:
        if self.left_s <= 0:
            return f"budget: {fmt_s(self.total_s)} spent - finish the screen you are on, then write the report and end_session"
        return f"budget: {fmt_s(self.used_s)} used of {fmt_s(self.total_s)}, {fmt_s(self.left_s)} left - keep exploring"

    def early_end_error(self, reason: Optional[str], force: bool = False) -> Optional[str]:
        """None when ending now is fine; otherwise the error `end_session` returns."""
        if not self.ending_early() or is_blocker(reason):
            return None
        if force and len((reason or "").strip()) >= MIN_REASON_CHARS:
            return None
        return (
            f"error: {fmt_s(self.left_s)} of the {fmt_s(self.total_s)} budget is left, and the whole budget is "
            "expected to be used. Keep exploring: revisit areas with different inputs a real user would type (valid, "
            "empty, invalid, long; never attack strings), try every filter/sort/tab combination, scroll each list to "
            "the end, follow the entries you skipped, re-check earlier findings, and look closer at anything that "
            "looked slow or odd. Only a hard blocker ends early: end_session(summary=..., reason=\"blocked: <the app "
            "crashes on launch | everything is behind a sign-in>\"), or force=true with the reason."
        )

    def summary(self, reason: Optional[str]) -> dict[str, Any]:
        early = self.ending_early()
        return {
            "minutes": self.minutes, "used_s": round(self.used_s, 1), "left_s": round(self.left_s, 1),
            "ended_early": early, "early_end_reason": ((reason or "").strip() or None) if early else None,
        }


@dataclass
class StepGuard:
    limit: int
    reached_at: Optional[int] = None

    def reached(self, seq: Optional[int]) -> bool:
        if self.reached_at is None and seq is not None and seq >= self.limit:
            self.reached_at = int(seq)
        return self.reached_at is not None

    def refusal(self, seq: Optional[int]) -> Optional[str]:
        if not self.reached(seq):
            return None
        return (
            f"error: step guard reached ({self.limit} steps). Stop now: take no more actions, write the report (its "
            f"first line: \"Stopped at the step guard ({self.limit} steps)\") and call end_session. Everything mapped is kept."
        )

    def screen_line(self, seq: Optional[int]) -> Optional[str]:
        if self.reached(seq):
            return f"step guard: {self.limit} steps reached - write the report and end_session now"
        if seq is not None and seq >= WARN_FRACTION * self.limit:
            return f"step guard: {seq} of {self.limit} steps - start wrapping up"
        return None


def step_guard_from_env(env: Optional[dict[str, str]] = None) -> StepGuard:
    env = os.environ if env is None else env
    try:
        limit = int(env.get(STEP_GUARD_ENV) or 0)
    except ValueError:
        limit = 0
    return StepGuard(limit if limit > 0 else DEFAULT_STEP_GUARD)


def _clip(text: Any) -> str:
    t = " ".join(str(text or "").split())
    return t[:MAX_TEXT_LEN]


class OtherApp(Exception):
    """Another app is in front: what it shows is not this app's screen."""


def other_app(platform: str, screen: Any, app_id: Optional[str]) -> bool:
    """On Android the tool knows the package in front, so Chrome opened from a link or the
    permission dialog never lands on the app's map."""
    front = getattr(screen, "foreground", None)
    return platform == "android" and bool(front and app_id) and front != app_id


def observation(screen: Any) -> dict[str, Any]:
    """`{title, texts, anchors, roles}` from a screen's elements (duck-typed: `.type`, `.label`,
    `.value`, `.y1`). The title is the first heading or navigation bar label, else the topmost
    static text; texts are what the screen says; anchors the labels of what can be acted on.
    `roles` maps a label to the role the screen gave it (for role-scoped checks)."""
    elements = list(getattr(screen, "elements", None) or [])
    try:
        from .device.tree import visible_elements

        # The device's own chrome never names a screen: Android's status bar reads "T-Mobile, signal full."
        elements = [e for e in visible_elements(elements) if "System" not in (getattr(e, "traits", None) or ())]
    except Exception:  # noqa: BLE001 - the plain list does
        pass
    texts: list[str] = []
    anchors: list[str] = []
    roles: dict[str, str] = {}
    title = ""
    for e in elements:
        role = str(getattr(e, "type", "") or "")
        label = _clip(getattr(e, "label", "") or "")
        if not label:
            continue
        if role in _HEADING_ROLES and not title:
            title = label
        if role in _ANCHOR_ROLES:
            if label not in anchors and len(anchors) < MAX_ANCHORS:
                anchors.append(label)
        elif role in _TEXT_ROLES or not role:
            if label not in texts and len(texts) < MAX_TEXTS:
                texts.append(label)
        else:
            if label not in texts and len(texts) < MAX_TEXTS:
                texts.append(label)
        roles.setdefault(label, role)
    if not title:
        statics = [e for e in elements if str(getattr(e, "type", "")) in _TEXT_ROLES and getattr(e, "label", "")]
        if statics:
            top = min(statics, key=lambda e: getattr(e, "y1", 0) or 0)
            title = _clip(top.label)
    return {"title": title, "texts": texts, "anchors": anchors, "roles": roles}


def person_step_args(kind: str, args: dict[str, Any]) -> dict[str, Any]:
    """A person's input as the trace keeps it: marked as theirs, and never what they typed (a
    person taking over usually does so to sign in, and steps are read by every member and agent)."""
    out: dict[str, Any] = {"source": "person"}
    if kind == "type":
        out["chars"] = len(str(args.get("text") or ""))
        return out
    return {**args, **out}


def person_result(kind: str, result: str) -> str:
    """An input's result as the trace and the page keep it: a device echoes typed text back."""
    if kind == "type":
        failed = result.startswith("error") or "failed" in result
        return "typing failed" if failed else "typed by a person"
    return result


@dataclass
class Walk:
    id: str
    flow: dict[str, Any]
    start_seq: int
    reported: list[dict[str, Any]] = field(default_factory=list)


def _stamp() -> str:
    """Now as UTC ISO text, to the millisecond: the run page's timeline plays at these times."""
    now = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now * 1000) % 1000:03d}Z"


@dataclass
class LiveSession:
    """The one session this server process drives."""

    id: str
    platform: str
    kind: str
    app_id: str
    device: Any = None  # the device session (None for a drafting session with no device)
    device_name: str = ""
    task_id: Optional[str] = None
    request_id: Optional[str] = None  # the QA request this session works
    budget: Optional[ExplorationBudget] = None
    guard: StepGuard = field(default_factory=lambda: StepGuard(DEFAULT_STEP_GUARD))
    seq: int = 0
    trace: list[dict[str, Any]] = field(default_factory=list)  # every step, for walk to scenario
    unsent: list[dict[str, Any]] = field(default_factory=list)
    last_screen: Any = None
    last_screen_key: Optional[str] = None
    last_frame_id: Optional[str] = None
    last_observation: dict[str, Any] = field(default_factory=dict)
    walk: Optional[Walk] = None
    device_appearance: Optional[str] = None  # what the device is set to (`appearance_setting`)
    scenario_row: Optional[tuple[str, int]] = None  # the scenario and Examples row `start_scenario` began
    run_conditions: dict = field(default_factory=dict)  # what the run asked for (`conditions.py`)
    applied: Any = None  # the conditions set on the device now (`conditions.Applied`), put back at the end
    applied_key: str = ""  # what `applied` was made from: a scenario asking the same leaves the device as it is
    crawl: Any = None  # a map session's planned crawl (`crawl_queue.CrawlQueue`)
    crawl_moved: Any = None  # the clock moved the queue on: the next action opens the next target
    findings: list[str] = field(default_factory=list)
    drafts: list[str] = field(default_factory=list)
    walks_done: list[dict[str, Any]] = field(default_factory=list)
    screens_seen: set[str] = field(default_factory=set)
    measured_seen: set[str] = field(default_factory=set)  # screen hashes the audit already read
    errors: list[str] = field(default_factory=list)  # portal errors kept for the report
    started_at: float = field(default_factory=time.time)
    # The live view (mcp_server `_start_live`): its frame writer and background tasks, and the
    # person driving the device right now, if any.
    frames: Any = None  # device.live_frames.LiveFrameWriter
    streaming: bool = False  # the device streams its screen; else each step's frame is offered
    live_tasks: list[Any] = field(default_factory=list)
    person: Optional[dict[str, Any]] = None  # {by, by_id, since}
    person_since: float = 0.0
    person_inputs: int = 0  # inputs applied during this takeover
    person_note: Optional[str] = None  # told to the agent with its next result
    logs_read_at: float = field(default_factory=time.time)
    log_seq: int = 0
    request_seq: int = 0
    unsent_logs: list[dict[str, Any]] = field(default_factory=list)
    unsent_requests: list[dict[str, Any]] = field(default_factory=list)

    def next_seq(self) -> int:
        self.seq += 1
        return self.seq

    def record(self, kind: str, args: Optional[dict[str, Any]] = None, result: str = "", *,
               screen_key: Optional[str] = None, screen_hash: Optional[str] = None,
               frame_id: Optional[str] = None) -> dict[str, Any]:
        step = {
            "seq": self.next_seq(), "kind": kind, "args": dict(args or {}), "result": (result or "")[:2000],
            "screen_key": screen_key, "screen_hash": screen_hash, "frame_id": frame_id,
            "at": _stamp(),
        }
        self.trace.append(step)
        self.unsent.append(step)
        return step

    def _telemetry_row(self, row: dict[str, Any], seq: int) -> dict[str, Any]:
        out = {k: v for k, v in row.items() if k != "at"}
        out["seq"] = seq
        out["step_seq"] = self.seq or None
        out["at_ms"] = max(0, int((float(row.get("at") or time.time()) - self.started_at) * 1000))
        return out

    def note_telemetry(self, logs: list[dict[str, Any]], requests: list[dict[str, Any]]) -> None:
        """Log lines and network calls gathered since the last look, filed under the step in hand.
        A row's `at` (epoch seconds) becomes its time from the session's start."""
        for row in logs:
            self.log_seq += 1
            self.unsent_logs.append(self._telemetry_row(row, self.log_seq))
        for row in requests:
            self.request_seq += 1
            self.unsent_requests.append(self._telemetry_row(row, self.request_seq))

    def take_unsent(self) -> list[dict[str, Any]]:
        out, self.unsent = self.unsent, []
        return out

    def requeue(self, steps: list[dict[str, Any]]) -> None:
        """Steps the portal did not take go back to the front (the batch is idempotent on seq)."""
        self.unsent = steps + self.unsent

    def steps_between(self, lo: int, hi: int) -> list[dict[str, Any]]:
        return [s for s in self.trace if lo <= s["seq"] <= hi]
