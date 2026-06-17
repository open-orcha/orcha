"""#254/#255 — registration must seed the CLI tab binding (and reset-data must clean up).

#254: a PORTAL-created agent gets NO `.claude/orcha-tabs/<alias>.json` (the register endpoint
runs inside the API container and can't touch the host `.claude/`). Without the binding, the
spawned headless worker's `/orcha-*` skills can't resolve alias→agent_id and die. The daemon
seeds the binding host-side in the wake-scan backfill (write-if-absent), and the worktree overlay
copies it in.

#255: `init --force --reset-data` wipes the DB + makes a NEW container, but on disk the OLD
container's tab bindings (dead container_id) and its still-running daemon survive. The init host
cleanup prunes the stale bindings and stops the old daemon.

Each test carries a mutation note: revert the production line and the named assert goes RED.
"""
import json
import os
import signal
import subprocess
import sys
import time

import pytest

from orcha_cli import notifier            # noqa: E402 (conftest puts orcha-cli on sys.path)
from orcha_cli import __main__ as cli     # noqa: E402

_DEAD_PID = 2_000_000_000                 # a pid that is virtually never alive


def _portal_cand(**over):
    """A portal-created agent candidate (wake_enabled, has work). `should_wake=False` keeps the
    test on the BACKFILL path only — no spawn machinery needed."""
    c = {"agent_id": "00000000-0000-0000-0000-000000000009", "alias": "Portal",
         "should_wake": False, "headless_cwd": None, "tmux_target": None, "wake_enabled": True,
         "pending_events": 1, "auto_start_task_ids": [], "latest_event": "task_message"}
    c.update(over)
    return c


# ---------- #254: seed the tab binding in the notifier backfill ----------

def test_tick_seeds_tab_binding_for_portal_agent(monkeypatch, tmp_path):
    """TEETH (#254): driving tick() for a portal agent writes `.claude/orcha-tabs/<alias>.json`
    with the right agent_id + the CURRENT container id. Mutation: remove the `_seed_tab_binding`
    call in tick's backfill → the file is never created → this RED."""
    cand = _portal_cand(headless_cwd=str(tmp_path), alias="Portal")   # already reachable → isolate the seed
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: {"active": True, "candidates": [cand]})
    monkeypatch.setattr(notifier, "_post_json", lambda *a, **k: {})

    notifier.tick("http://x", "CID-NEW", dry_run=False, cooldown=15, min_idle=0, quiet=True,
                  live_workers={}, base_cwd=str(tmp_path))

    binding = tmp_path / ".claude" / "orcha-tabs" / "Portal.json"
    assert binding.exists(), "portal agent must get a seeded tab binding"
    assert json.loads(binding.read_text()) == {
        "alias": "Portal", "agent_id": cand["agent_id"], "container_id": "CID-NEW"}


def test_tick_does_not_overwrite_existing_binding(monkeypatch, tmp_path):
    """TEETH (#254): a PRE-EXISTING binding (e.g. human-edited, or seeded last tick) is never
    clobbered — the seed is write-if-ABSENT. Mutation: drop the `if dst.exists(): return False`
    guard in `_seed_tab_binding` → the human's agent_id is overwritten → this RED."""
    tabs = tmp_path / ".claude" / "orcha-tabs"
    tabs.mkdir(parents=True)
    pinned = {"alias": "Portal", "agent_id": "HUMAN-PINNED", "container_id": "CID-OLD"}
    (tabs / "Portal.json").write_text(json.dumps(pinned))

    cand = _portal_cand(headless_cwd=str(tmp_path), alias="Portal")
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: {"active": True, "candidates": [cand]})
    monkeypatch.setattr(notifier, "_post_json", lambda *a, **k: {})

    notifier.tick("http://x", "CID-NEW", dry_run=False, cooldown=15, min_idle=0, quiet=True,
                  live_workers={}, base_cwd=str(tmp_path))

    assert json.loads((tabs / "Portal.json").read_text()) == pinned   # untouched


def test_seed_skips_disabled_and_missing_fields(tmp_path):
    """`_seed_tab_binding` is a no-op without the data it needs (no clobber, no half-binding)."""
    assert notifier._seed_tab_binding(None, "A", "id", "c") is False
    assert notifier._seed_tab_binding(str(tmp_path), None, "id", "c") is False
    assert notifier._seed_tab_binding(str(tmp_path), "A", None, "c") is False
    assert not (tmp_path / ".claude" / "orcha-tabs").exists()


# ---------- #255: prune stale tab bindings on --reset-data ----------

def test_prune_stale_bindings_keeps_only_live(tmp_path):
    """TEETH (#255): bindings carrying a dead container_id are pruned; the live one survives.
    Mutation: no-op `_prune_stale_bindings` (return 0) → the stale files survive → this RED."""
    tabs = tmp_path / "orcha-tabs"
    tabs.mkdir()
    (tabs / "old1.json").write_text(json.dumps({"alias": "old1", "container_id": "DEAD-A"}))
    (tabs / "old2.json").write_text(json.dumps({"alias": "old2", "container_id": "DEAD-B"}))
    (tabs / "live.json").write_text(json.dumps({"alias": "live", "container_id": "NEW"}))

    removed = cli._prune_stale_bindings(tabs, "NEW")

    assert removed == 2
    assert {f.name for f in tabs.glob("*.json")} == {"live.json"}


def test_prune_leaves_unclassifiable_bindings(tmp_path):
    """A binding with no readable container_id is left alone — never delete what we can't classify."""
    tabs = tmp_path / "orcha-tabs"
    tabs.mkdir()
    (tabs / "nocid.json").write_text(json.dumps({"alias": "nocid"}))      # no container_id
    (tabs / "garbage.json").write_text("not json{{")

    assert cli._prune_stale_bindings(tabs, "NEW") == 0
    assert {f.name for f in tabs.glob("*.json")} == {"nocid.json", "garbage.json"}


# ---------- #255: stop the daemon bound to the OLD container ----------

@pytest.mark.skipif(
    sys.platform != "darwin",
    reason="Identity-vets the daemon via macOS `ps -o command=`/state semantics and relies on "
           "zombie-state exit detection; the notifier only runs on macOS in production, so this "
           "is not validated on Linux CI runners.",
)
def test_stop_daemon_for_container_signals_and_clears_pidfile(monkeypatch, tmp_path):
    """TEETH (#255): a live daemon recorded for the OLD container is SIGTERM'd and its pidfile
    removed. Mutation: skip the kill in `stop_daemon_for_container` → the proc stays alive →
    `proc.wait(timeout=...)` times out → this RED.

    #276 rework: `stop_daemon_for_container` now routes through `_terminate_and_wait`, which
    identity-vets the pid (`_daemon_pid_live`) BEFORE signalling — so it will NOT signal a process
    that doesn't look like our notifier. The decoy therefore carries a notifier-shaped argv
    (`...notifier --quiet --container OLD`) so the real `ps` vet accepts it as ours; once SIGTERM'd
    it becomes a zombie whose `ps` state `Z` lets the bounded wait detect exit promptly."""
    monkeypatch.setattr(notifier, "_global_pid_path",
                        lambda cid: tmp_path / f"notifier-{cid}.pid")
    # argv extra tokens surface verbatim in `ps -o command=` so the identity vet sees a notifier.
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)",
                             "orcha", "notifier", "--quiet", "--container", "OLD"])
    try:
        pidf = tmp_path / "notifier-OLD.pid"
        pidf.write_text(f"{proc.pid}\n{tmp_path}")          # mirrors _write_global_pid format

        stopped = notifier.stop_daemon_for_container("OLD", quiet=True)

        assert stopped is True
        assert not pidf.exists()                            # claim cleared
        assert proc.wait(timeout=5) == -signal.SIGTERM      # the daemon was actually signalled
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)


def test_stop_daemon_for_container_noop_when_absent(monkeypatch, tmp_path):
    """No pidfile for the old container → idempotent no-op (returns False, doesn't raise)."""
    monkeypatch.setattr(notifier, "_global_pid_path",
                        lambda cid: tmp_path / f"notifier-{cid}.pid")
    assert notifier.stop_daemon_for_container("OLD", quiet=True) is False
    assert notifier.stop_daemon_for_container("", quiet=True) is False


def test_stop_daemon_for_container_clears_stale_dead_pidfile(monkeypatch, tmp_path):
    """A pidfile naming a DEAD pid → no signal to send, but the stale claim file is still cleared
    so a follow-up --ensure doesn't believe the old container is still serviced."""
    monkeypatch.setattr(notifier, "_global_pid_path",
                        lambda cid: tmp_path / f"notifier-{cid}.pid")
    pidf = tmp_path / "notifier-OLD.pid"
    pidf.write_text(f"{_DEAD_PID}\n{tmp_path}")

    assert notifier.stop_daemon_for_container("OLD", quiet=True) is False   # nothing live to stop
    assert not pidf.exists()                                                # but debris cleared
