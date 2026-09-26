"""Epic A — the Orcha notifier (wake & self-movement, the platform's #1-pain fix).

A persistent, **NON-AI** process that wakes idle agents out-of-band so they resume
work without a human nudge. It watches the API's read-only wake-scan for agents
that have pending events or an assigned-and-ready task and, when such an agent
looks idle, injects a turn into its Claude Code session by one of two transports:

  * **tmux** — `tmux send-keys` into the agent's live pane (live-context wake), or
  * **headless** — a one-shot `claude -p` in the agent's project dir (out-of-band
    inbox/admin wake) when no live pane is reachable.

The wake DECISION lives server-side (`GET /api/containers/{cid}/wake-scan`); this
module only selects a transport, performs the host-side side-effect, and acks
(`POST /api/agents/{aid}/wake-ack`). That keeps the design invariant — "only the
API touches the DB" — intact and lets the CLI stay dependency-free (stdlib only).

It never crosses the verification gate: the wake prompt tells the agent to stop at
needs_verification and never self-certify; the daemon itself only sends keystrokes.

Modes:
  * `orcha notifier --once`  → one tick. The **phase-0 cron STOPGAP**: schedule it
    (cron/launchd) and missed events get caught within the cron cadence while the
    daemon proper is built. It is exactly one iteration of the daemon loop.
  * `orcha notifier`         → the long-running daemon (the same tick on a loop).
  * add `--dry-run` to print the wake decisions + the exact transport command
    WITHOUT sending keystrokes, spawning claude, or advancing any cursor. This is
    the demo/proof path (and what the tests assert against).
"""
from __future__ import annotations

import sys
from typing import Optional

from .notifier_context import install as _install_context

_install_context(globals())

from .notifier_wake_facade import (
    _ack_config_from_scan,
    _advance_wake_cursor,
    _apply_wake_act,
    _build_persona,
    _clear_persona_cache,
    _cold_boot_history,
    _container_vanished,
    _load_master_key_from_env_file,
    _log_graded_wake,
    _persona_and_digest,
    _request_actionable,
    _resolve_runtime_executable,
    _suppress_wake,
    _triage_config_from_scan,
    _triage_wake,
    _unseal_scan_key,
    decide_wake_suppression,
    decide_wake_tier,
    derive_wake_event,
    select_transport,
    self_wake_ack_fields,
    spawn_headless,
    spawn_resident,
)
from .notifier_worktree_facade import (
    _branch_commit_count,
    _capture_diff,
    _drain_pending_revokes,
    _ensure_worktree_exclude,
    _finish_run,
    _is_git_repo,
    _mint_embodiment_token,
    _overlay_runtime_config,
    _provision_live_worktree,
    _provision_resident_worktree,
    _provision_task_worktree,
    _provision_worktree,
    _reap_dead_pid_resident_runs,
    _reap_sandbox_artifacts,
    _retire_headless,
    _retire_resident,
    _revoke_embodiment_token,
    _revoke_or_defer,
    _run_git,
    _run_pid_alive,
    _safe_ref,
    _safe_teardown_worktree,
    _seed_tab_binding,
    _teardown_worktree,
    _worktree_is_dirty,
)
from .notifier_worker_facade import (
    _checkpoint_and_respawn,
    _codex_exit_status,
    _codex_tail_is_rate_limited,
    _drain_task_failure,
    _is_stream_event_line,
    _parse_rate_limit_reset,
    _pump_one,
    _reclaim_task_worktree,
    _record_task_saved_ref,
    _saved_human_line,
    _saved_ref,
    _synthesize_task_digest,
    live_sandbox_shield,
    reap_orphan_leases,
    reap_orphaned_runs,
    reap_terminal_task_worktrees,
    reap_workers,
    tick,
)
from .notifier_task_facade import _checkpoint_task_worktree
from .notifier_conversation_facade import (
    _ExternalProcess,
    _as_path,
    _codex_resume_prompt,
    _codex_run_state,
    _conversation_ack_body,
    _conversation_log_path,
    _conversation_reply_path,
    _conversation_reply_text,
    _conversation_worker_prompt,
    _finish_codex_conversation,
    _maybe_pin_codex_session,
    _next_human_turn,
    _post_conversation_reply,
    _resident_log_path,
    _resident_runtime,
    _simple_history,
    _text_from_content,
    reconcile_codex_conversation_runs,
)
from .notifier_resident_lifecycle import (
    _close_resident,
    _spawn_drain_sidecar,
)
from .notifier_persona import (
    _LOOPBACK_HOSTS,
    _portal_host,
    remote_portal_notice,
)
from .notifier_daemon_facade import (
    HEARTBEAT_STALE_SECS,
    _api_base_for,
    _claim_container,
    _container_id_for,
    _daemon_pid_healthy,
    _daemon_pid_live,
    _global_pid_path,
    _hb_path,
    _heartbeat_verdict,
    _log_path,
    _pid_alive,
    _pid_path,
    _ps_inspect,
    _terminate_and_wait,
    _write_global_pid,
    _write_heartbeat,
    cmd_notifier,
    daemon_running,
    daemon_running_for_container,
    ensure_daemon,
    stop_daemon,
    stop_daemon_for_container,
)

def service_residents(api_base: str, cid: str, live_residents: dict, *, quiet: bool = False,
                      dry_run: bool = False, base_cwd: Optional[str] = None) -> None:
    """E3: drive WARM resident conversation sessions — the conversational counterpart to tick()'s
    one-shot ephemeral wakes. Poll-based, ONE state transition per resident per tick (like
    reap_workers): capture an in-flight turn's reply → renew lease → idle-reap; then for any
    conversation with a pending human turn and no resident busy, boot/feed the next turn. Single-
    embodiment with ephemeral wakes is enforced by the E1 resident lease (lease_kind='resident')."""
    scan = _get_json(f"{api_base}/api/containers/{cid}/active-conversations") or {}
    by_id = {c["conversation_id"]: c for c in scan.get("conversations", [])}
    active_ids = set(by_id)

    # 919050a5 (c): fast dead-PID liveness gate. BEFORE advancing/booting anything, reap any resident
    # run whose row says 'running' but whose host process is dead — releasing the held resident lease
    # in SECONDS so the ISS-74 wake gate stops suppressing this agent's event wakes, instead of
    # waiting out the >1260s ISS-60-B heartbeat window (the live repro's lease was only ~3min old).
    # Keyed on the DB + os.kill (not the in-memory live_residents dict), so it ALSO clears orphans a
    # daemon turnover / cross-worktree second daemon left behind. `live_pids` shields THIS daemon's
    # genuinely-live residents from a racing os.kill. active-conversations is container-wide → covers
    # every agent with a live conversation, not just the ones this daemon booted.
    live_pids = frozenset(r["proc"].pid for r in live_residents.values()
                          if r.get("proc") is not None)
    if not dry_run:
        for c in by_id.values():
            if c.get("agent_id"):
                _reap_dead_pid_resident_runs(api_base, c["agent_id"], live_pids, quiet=quiet)

    # Advance every live resident through one lifecycle transition.
    for conv_id, resident in list(live_residents.items()):
        _resident_live.advance_live_resident(
            sys.modules[__name__], api_base, conv_id, resident,
            by_id.get(conv_id), active_ids, live_residents,
            quiet=quiet, dry_run=dry_run,
        )

    # 2) For each conversation with a pending human turn and no resident mid-turn, advance ONE
    #    turn: boot the resident if needed, then feed the next human turn.
    for conv_id, c in by_id.items():
        if not c.get("pending_human"):
            continue
        runtime = _normalize_runtime(c.get("model_runtime"))
        if runtime == RUNTIME_CODEX:
            _resident_codex_start.start_candidate(
                sys.modules[__name__], api_base, conv_id, c, live_residents,
                base_cwd=base_cwd, quiet=quiet, dry_run=dry_run,
            )
            continue
        if runtime == RUNTIME_CLAUDE:
            _resident_claude_start.start_or_feed_candidate(
                sys.modules[__name__], api_base, conv_id, c, live_residents, live_pids,
                base_cwd=base_cwd, quiet=quiet, dry_run=dry_run,
            )
