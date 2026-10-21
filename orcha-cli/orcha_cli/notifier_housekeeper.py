"""Run the notifier's worktree housekeeping off the scan loop (GH #315).

``notifier_worktree_gc.service_worktrees`` inventories every worktree (several git commands
plus ``du`` each), which took 20+ minutes on a machine with thousands of worktrees. Run inline
before ``tick()`` it stopped the wake scan — so the portal chip read "Not running" — and the
heartbeat, so ``--ensure`` judged the daemon wedged. The ``Housekeeper`` owns ONE thread that
runs one pass at a time when the loop pokes it; pokes that arrive while a pass is running
coalesce into a single follow-up pass, so inventory / sweep never run twice at once.

``StageTimer`` times a pass stage by stage; a pass over ``SLOW_PASS_S`` writes one lifecycle
line with the breakdown, so a slow field report comes with data.
"""

from __future__ import annotations

import threading
import time
from typing import Callable, Iterable, Optional

THREAD_NAME = "orcha-worktree-gc"
SLOW_PASS_S = 60.0
STOP_JOIN_S = 2.0


def _secs(value: float) -> str:
    return f"{value:.1f}s" if value < 10 else f"{value:.0f}s"


class StageTimer:
    """Seconds per named stage of one pass (``lap`` closes the stage that just ran)."""

    def __init__(self, clock: Callable[[], float] = time.monotonic):
        self._clock = clock
        self.started = clock()
        self._mark = self.started
        self.laps: list[tuple[str, float]] = []
        self.notes: dict = {}

    def lap(self, name: str) -> None:
        now = self._clock()
        self.laps.append((name, now - self._mark))
        self._mark = now

    def note(self, key: str, value) -> None:
        self.notes[key] = value

    def total(self) -> float:
        return self._clock() - self.started

    def breakdown(self) -> str:
        return ", ".join(f"{name} {_secs(secs)}" for name, secs in self.laps)


class Housekeeper:
    """One background thread running ``run_pass(busy, timer)`` one pass at a time."""

    def __init__(self, run_pass: Callable[[frozenset, StageTimer], None], *,
                 log: Callable[[str], None], clock: Callable[[], float] = time.monotonic,
                 slow_after: float = SLOW_PASS_S):
        self._run_pass = run_pass
        self._log = log
        self._clock = clock
        self._slow_after = slow_after
        self._poked = threading.Event()
        self._stopping = threading.Event()
        self._busy: frozenset = frozenset()
        self._thread: Optional[threading.Thread] = None
        self._pass_started: Optional[float] = None

    def start(self) -> "Housekeeper":
        self._thread = threading.Thread(target=self._loop, name=THREAD_NAME, daemon=True)
        self._thread.start()
        return self

    def poke(self, busy: Iterable[str]) -> None:
        """Ask for a pass with the worktrees the loop's own workers use right now (a snapshot:
        the loop's dicts are not safe to read from another thread). Never blocks."""
        self._busy = frozenset(busy)
        self._poked.set()

    def busy_for(self) -> Optional[float]:
        """Seconds the pass in flight has been running, or None when idle."""
        started = self._pass_started
        return None if started is None else self._clock() - started

    def stop(self, timeout: float = STOP_JOIN_S) -> bool:
        """Start no further pass and wait briefly for the current one. A pass stuck in git /
        du does not hold the daemon up: the thread is a daemon thread. True once it ended."""
        self._stopping.set()
        self._poked.set()
        thread = self._thread
        if thread is None:
            return True
        thread.join(timeout)
        return not thread.is_alive()

    def run_one(self, busy: frozenset) -> None:
        timer = StageTimer(self._clock)
        self._pass_started = timer.started
        try:
            self._run_pass(busy, timer)
        except Exception:  # noqa: BLE001 - the next poke retries; the loop must not lose us
            pass
        finally:
            self._pass_started = None
        total = timer.total()
        if total >= self._slow_after:
            count = timer.notes.get("worktrees")
            self._log(f"slow worktree housekeeping pass: {_secs(total)} ({timer.breakdown()}"
                      + (f"; {count} worktrees" if count is not None else "")
                      + ") — ran beside the wake scan, which kept its cadence")

    def _loop(self) -> None:
        while True:
            self._poked.wait()
            if self._stopping.is_set():
                return
            self._poked.clear()
            self.run_one(self._busy)


def slow_loop_line(timer: StageTimer, housekeeper: Optional[Housekeeper] = None) -> Optional[str]:
    """The lifecycle line for a daemon loop pass over ``SLOW_PASS_S`` (else None)."""
    total = timer.total()
    if total < SLOW_PASS_S:
        return None
    running = housekeeper.busy_for() if housekeeper is not None else None
    return (f"slow loop pass: {_secs(total)} ({timer.breakdown()})"
            + (f"; worktree housekeeping running {_secs(running)} on its own thread"
               if running is not None else ""))
