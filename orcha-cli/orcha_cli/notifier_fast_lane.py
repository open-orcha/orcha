"""Make the daemon's idle gap between scans responsive (live chat latency).

The daemon loop scans, then idles `--interval` seconds (2s). Everything a live chat needs
used to wait on that cadence: a human's message sat until the next scan before a resident
was fed, a worker's streamed output reached the portal only when the next scan pumped its
log, and a finished reply was posted only on the scan after its `result` line.

The idle gap now does three cheap things instead of a blind sleep:
  * pumps every live worker/resident log into the run feed every PUMP_STEP_S (a local file
    read; an HTTP POST only when complete lines are waiting), so output streams live;
  * ends the gap early when a pump posts a resident's terminal `result`, so the reply is
    captured and posted on the very next scan;
  * ends the gap early when the portal publishes a human `conversation_turn` — observed by
    a background reader of the container's existing SSE event stream (no polling, no new
    dependency). If that stream is unreachable the loop simply keeps its old cadence.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from typing import Callable, Optional

PUMP_STEP_S = 0.2
# Human-turn events that should wake the daemon at once. Only these — a container event
# stream also carries run/reply notices meant for dashboards.
WAKE_EVENTS = frozenset({"conversation_turn"})


class TurnEventWatcher:
    """Background reader of GET /api/containers/{cid}/events that sets `wake` on a human
    conversation turn. Daemon thread; reconnects with backoff; never raises."""

    def __init__(self, api_base: str, cid: str, *, opener: Optional[Callable] = None):
        self.url = f"{api_base}/api/containers/{cid}/events"
        self.wake = threading.Event()
        self._stop = threading.Event()
        self._cursor = time.time()
        self._open = opener or (lambda url: urllib.request.urlopen(url, timeout=30.0))
        self._thread: Optional[threading.Thread] = None

    def start(self) -> "TurnEventWatcher":
        self._thread = threading.Thread(target=self._run, name="orcha-turn-events", daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()

    def handle_line(self, raw: str) -> None:
        """Consume one SSE line (exposed for tests)."""
        line = raw.strip()
        if not line.startswith("data:"):
            return
        try:
            event = json.loads(line[5:].strip())
        except ValueError:
            return
        if not isinstance(event, dict):
            return
        ts = event.get("ts")
        if isinstance(ts, (int, float)) and ts > self._cursor:
            self._cursor = float(ts)
        if event.get("event") in WAKE_EVENTS:
            self.wake.set()

    def _run(self) -> None:
        backoff = 1.0
        while not self._stop.is_set():
            try:
                with self._open(f"{self.url}?since_ts={self._cursor}") as resp:
                    backoff = 1.0
                    for raw in resp:
                        if self._stop.is_set():
                            return
                        self.handle_line(raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw)
            except (urllib.error.URLError, OSError, ValueError):
                pass
            except Exception:  # noqa: BLE001 - a helper thread must never kill the daemon
                pass
            if self._stop.wait(backoff):
                return
            backoff = min(backoff * 2, 15.0)


def idle_wait(
    interval: float,
    stop: dict,
    *,
    live_workers: dict,
    live_residents: dict,
    pump: Callable[[dict], bool],
    wake: Optional[threading.Event] = None,
    step: float = PUMP_STEP_S,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> Optional[str]:
    """Idle up to `interval` seconds between scans, streaming live logs meanwhile.

    Returns "turn" (a human turn arrived), "result" (a resident's reply finished), or None
    when the full interval elapsed / a stop was requested."""
    deadline = clock() + interval
    while not stop.get("flag"):
        if wake is not None and wake.is_set():
            wake.clear()
            return "turn"
        for worker in list(live_workers.values()):
            try:
                pump(worker)
            except Exception:  # noqa: BLE001 - the scan's own pump retries next pass
                pass
        for resident in list(live_residents.values()):
            # only a resident mid-turn: between turns its log belongs to no run yet
            if not (resident.get("awaiting_result") and resident.get("current_run_id")):
                continue
            try:
                if pump(resident):
                    return "result"
            except Exception:  # noqa: BLE001
                pass
        left = deadline - clock()
        if left <= 0:
            return None
        sleep(min(step, left))
    return None
