"""`orcha serve`: the foreground supervisor of a native-runtime project (GH #258 PR 6, R2).

Starts the portal, waits for it to answer (at most 30 s), then starts the notifier and
the terminal bridge. A child that exits is restarted after ``min(30, 2**n)`` seconds,
where ``n`` counts consecutive short runs and resets after 60 s of uptime. Ten restarts
inside ten minutes mark the child ``crashlooping`` in ``.orcha/state.json``; it is
still retried every 60 s, never abandoned silently. SIGTERM/SIGINT fan out as SIGTERM
to every child, SIGKILL after 8 s, and the state file is left with
``"status": "stopped"``. Uptime across reboots belongs to launchd/systemd (plan R3).
"""
from __future__ import annotations

import argparse
import collections
import dataclasses
import datetime
import importlib.metadata
import logging
import os
import pathlib
import signal
import subprocess
import sys
import time
from typing import Optional

from . import cli_portal, cli_stacks_registry
from .cli_runtime_mode import NATIVE, db_path, read_config, require_project
from .cli_serve_support import ChildSpec, child_specs, pump, read_state, rotating_logger, write_state

BACKOFF_CAP_SECS = 30.0
STABLE_SECS = 60.0
CRASHLOOP_RESTARTS = 10
CRASHLOOP_WINDOW_SECS = 600.0
CRASHLOOP_RETRY_SECS = 60.0
NOT_READY_RETRY_SECS = 5.0
STATE_REFRESH_SECS = 30.0
PORTAL_WAIT_SECS = 30.0
STOP_GRACE_SECS = 8.0
TICK_SECS = 0.5


@dataclasses.dataclass
class Child:
    spec: ChildSpec
    proc: Optional[subprocess.Popen] = None
    status: str = "pending"  # pending | waiting | running | restarting | crashlooping | stopped
    restarts: int = 0
    failures: int = 0  # consecutive short runs: the backoff exponent
    crashlooping: bool = False
    started_at: float = 0.0
    next_start: float = 0.0
    last_exit: Optional[int] = None
    recent: collections.deque = dataclasses.field(default_factory=collections.deque)


def _iso_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _cli_version() -> str:
    try:
        return importlib.metadata.version("orcha-cli")
    except importlib.metadata.PackageNotFoundError:
        return "0.0.0+source"


class Supervisor:
    def __init__(self, root, specs, *, env=None, popen=subprocess.Popen,
                 clock=time.monotonic, portal_wait=PORTAL_WAIT_SECS):
        self.root = pathlib.Path(root)
        self.children = {s.name: Child(s) for s in specs}
        self.env = env
        self.popen = popen
        self.clock = clock
        self.portal_wait = portal_wait
        self.log = rotating_logger(self.root, "serve")
        self.started_at = _iso_now()
        self.stopping = False
        self.gate_open = "portal" not in self.children
        self.gate_since: Optional[float] = None
        self._last_state = float("-inf")

    # --- lifecycle ------------------------------------------------------------------

    def _spawn(self, child: Child, now: float) -> None:
        argv = child.spec.argv()
        if argv is None:
            child.status, child.next_start = "waiting", now + NOT_READY_RETRY_SECS
            return
        proc = self.popen(
            argv, cwd=str(self.root), env=self.env, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True,
        )
        if proc.stdout is not None:
            pump(proc.stdout, rotating_logger(self.root, child.spec.name))
        child.proc, child.started_at = proc, now
        child.status = "crashlooping" if child.crashlooping else "running"
        self.log.info(f"[serve] started {child.spec.name} pid {proc.pid}")

    def _on_exit(self, child: Child, rc: int, now: float) -> None:
        child.proc, child.last_exit = None, rc
        if now - child.started_at >= STABLE_SECS:
            child.failures = 0
        child.restarts += 1
        child.recent.append(now)
        while child.recent and now - child.recent[0] > CRASHLOOP_WINDOW_SECS:
            child.recent.popleft()
        if len(child.recent) >= CRASHLOOP_RESTARTS:
            child.crashlooping = True
        if child.crashlooping:
            delay, child.status = CRASHLOOP_RETRY_SECS, "crashlooping"
        else:
            delay, child.status = min(BACKOFF_CAP_SECS, 2.0 ** child.failures), "restarting"
        child.failures += 1
        child.next_start = now + delay
        self.log.info(f"[serve] {child.spec.name} exited rc={rc}; {child.status}, retry in {delay:.0f}s")

    def _gated(self, child: Child, now: float) -> bool:
        """Non-portal children wait until the portal answers (or the wait expires)."""
        if child.spec.name == "portal" or self.gate_open:
            return False
        portal = self.children["portal"]
        if portal.proc is not None and self.gate_since is None:
            self.gate_since = now
        if portal.proc is not None and portal.spec.healthy():
            self.gate_open = True
        elif self.gate_since is not None and now - self.gate_since >= self.portal_wait:
            self.log.info(f"[serve] portal not answering after {self.portal_wait:.0f}s; starting the rest anyway")
            self.gate_open = True
        return not self.gate_open

    def tick(self) -> None:
        now = self.clock()
        changed = False
        for child in self.children.values():
            if child.proc is not None:
                rc = child.proc.poll()
                if rc is not None:
                    self._on_exit(child, rc, now)
                    changed = True
                elif child.crashlooping and now - child.started_at >= STABLE_SECS:
                    child.crashlooping, child.failures, child.status = False, 0, "running"
                    child.recent.clear()
                    changed = True
            if child.proc is None and now >= child.next_start and not self._gated(child, now):
                before = child.status
                self._spawn(child, now)
                changed = changed or child.status != before or child.proc is not None
        if changed or now - self._last_state >= STATE_REFRESH_SECS:
            self.write_state("running")
            self._last_state = now

    def stop(self) -> None:
        """SIGTERM every child, SIGKILL whatever is left after the grace period."""
        live = [c for c in self.children.values() if c.proc is not None and c.proc.poll() is None]
        for child in live:
            try:
                child.proc.send_signal(signal.SIGTERM)
            except (ProcessLookupError, OSError):
                pass
        deadline = self.clock() + STOP_GRACE_SECS
        for child in live:
            try:
                child.proc.wait(timeout=max(0.0, deadline - self.clock()))
            except subprocess.TimeoutExpired:
                self.log.info(f"[serve] {child.spec.name} ignored SIGTERM for {STOP_GRACE_SECS:.0f}s; SIGKILL")
                child.proc.kill()
                child.proc.wait()
        for child in self.children.values():
            child.proc, child.status = None, "stopped"
        self.write_state("stopped")
        self.log.info("[serve] stopped")

    def run(self) -> int:
        def _handle(signum, _frame):
            self.stopping = True

        signal.signal(signal.SIGTERM, _handle)
        signal.signal(signal.SIGINT, _handle)
        self.log.info(f"[serve] supervising {', '.join(self.children)} for {self.root}")
        try:
            while not self.stopping:
                self.tick()
                time.sleep(TICK_SECS)
        finally:
            self.stop()
        return 0

    # --- state ----------------------------------------------------------------------

    def state(self, status: str) -> dict:
        cfg = read_config(self.root)
        return {
            "runtime": NATIVE,
            "status": status,
            "serve_pid": os.getpid() if status == "running" else None,
            "children": {
                name: {"pid": c.proc.pid if c.proc else None, "status": c.status,
                       "restarts": c.restarts, "last_exit": c.last_exit}
                for name, c in self.children.items()
            },
            "api_port": cfg.get("api_port"),
            "bridge_port": cfg.get("bridge_port"),
            "bind": "lan" if cfg.get("bind") == "lan" else "loopback",
            "started_at": self.started_at,
            "updated_at": _iso_now(),
            "cli_version": _cli_version(),
            "db_path": str(db_path(self.root, cfg)),
        }

    def write_state(self, status: str) -> None:
        write_state(self.root, self.state(status))


def serve_running(root: pathlib.Path) -> Optional[int]:
    """The pid of a live ``orcha serve`` for this project, per ``state.json``."""
    state = read_state(root)
    pid = state.get("serve_pid")
    if state.get("status") != "running" or not isinstance(pid, int):
        return None
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError, OverflowError):
        return None
    return pid


def cmd_serve(args: argparse.Namespace) -> None:
    root = pathlib.Path(args.project_dir or pathlib.Path.cwd()).resolve()
    runtime = require_project(root, f"error: no Orcha project in {root} — run `orcha init` first.")
    if runtime != NATIVE:
        sys.exit("error: this project runs on Docker; use `orcha up` (`orcha serve` is for "
                 "native-runtime projects).")
    other = serve_running(root)
    if other and other != os.getpid():
        sys.exit(f"error: `orcha serve` is already running for this project (pid {other}).")
    cli_portal._prepare_host_state(root)
    env = cli_portal.build_portal_env(root, read_config(root))
    sup = Supervisor(root, child_specs(root, no_bridge=args.no_bridge), env=env)
    cfg = read_config(root)
    cli_stacks_registry.register(cfg.get("project_name") or root.name, path=root,
                                 api_port=cfg.get("api_port"), bridge_port=cfg.get("bridge_port"),
                                 cli_version=_cli_version())
    if sys.stderr.isatty():
        sup.log.addHandler(logging.StreamHandler(sys.stderr))
    sys.exit(sup.run())
