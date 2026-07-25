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

import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Optional

from .notifier_wake_prompts import (
    build_resident_sidecar_drain_prompt,
    build_wake_prompt,
)
from .notifier_persona import (
    CONVERSATION_LANE_DIRECTIVE,
    HUMAN_COMMS_GUARDRAIL,
    _wrap_conversation_turn,
    format_persona,
)
from .notifier_protocol import (
    _render_protocol,
    _render_resume_context,
    _render_task_body,
)

from .notifier_codex_events import (
    _codex_event_phase,
    _codex_is_rate_limit,
    _codex_is_turn_end,
    _codex_tail_is_live,
)
from .notifier_codex_result import _codex_result_status
from . import notifier_conversation as _conversation
from . import notifier_codex_conversation as _codex_conversation
from . import notifier_boot_context as _boot_context
from . import notifier_command as _notifier_command
from . import notifier_daemon_control as _daemon_control
from . import notifier_daemon_registry as _daemon_registry
from . import notifier_embodiment as _embodiment
from . import notifier_persona_cache as _persona_cache
from .notifier_process import _capture_run_output, _kill_worker, _usage_from_log
from .notifier_session_io import (
    _extract_codex_session_id,
    _extract_session_id,
    _result_after,
    _send_user_turn,
)
from .notifier_worker_status import _last_event_type, _result_status, _terminal_status, _worker_is_live
from . import notifier_runtime as _notifier_runtime
from .notifier_host import (
    _api_and_cid,
    _extract_attachment_text,
    _get_json,
    _load_config,
    _post_json,
    _probe_container,
    send_tmux,
    tmux_pane_live,
)
from .notifier_runtime import (
    ORCHA_CLAUDE_EXEC,
    ORCHA_CODEX_EXEC,
    RUNTIME_CLAUDE,
    RUNTIME_CODEX,
    _CODEX_EFFORT,
    _CODEX_EXEC_FALLBACKS,
    _codex_prompt,
    _normalize_runtime,
    _runtime_executable,
    _runtime_extra_flags,
)
from . import notifier_headless as _headless
from . import notifier_orphan_cleanup as _orphan_cleanup
from . import notifier_resident_spawn as _resident_spawn
from . import notifier_run_feed as _run_feed
from . import notifier_task_continuity as _task_continuity
from . import notifier_wake_actions as _wake_actions
from . import notifier_wake_decisions as _wake_decisions
from . import notifier_worker_results as _worker_results
from . import notifier_worktree_base as _worktree_base
from . import notifier_worktree_stable as _worktree_stable

# E3 V1 history-injection (Vault's PR #120): a PURE formatter for the cold-boot conversation
# prefix, in its own module (zero merge surface). OPTIONAL — bound to None until #120 lands in
# main, so this branch is self-consistent and doesn't hard-depend on merge order; the history
# block activates automatically once the module is importable. Referenced as a module global so
# tests can monkeypatch it.
try:
    from orcha_cli.conversation_prefix import format_conversation_history as _format_history
except ImportError:
    _format_history = None

# #338 feed-to-agent: render the CURRENT turn's attachments (location + metadata + open
# instructions) as a text block the agent acts on. Self-failing-open like _format_history.
try:
    from orcha_cli.conversation_prefix import render_attachment_feed as _render_attachment_feed
except ImportError:
    def _render_attachment_feed(attachments, *, api_base=None, runtime=None, extracted=None):  # type: ignore
        return ""

# #338 Codex image->text is cached on attachment refs by the portal upload/validation path. The
# notifier only reads that cached text; it must not re-OCR on every wake.

# #247 item-3: LLM curation of a LONG cold-boot history (summarize-older + recent-verbatim)
# in place of the mechanical oldest-drop. OPTIONAL + self-failing-open: curate_history never
# raises and internally falls back to the mechanical block, so binding it to None (module
# absent) or any curation error simply degrades to today's _format_history behaviour.
try:
    from orcha_cli.digest_curation import curate_history as _curate_history
except ImportError:
    _curate_history = None


def _cold_boot_history(turns) -> str:
    """Compatibility facade for fail-open cold-boot history curation."""
    return _boot_context.cold_boot_history(turns, sys.modules[__name__])

# #288 wake-suppression: the #290 universal LLM client provides triage_wake() (Haiku, fail-open).
# Imported as a module global so tests can monkeypatch it; bound to None if unavailable so the
# fail-open hook below still wakes (we can NEVER suppress on an infra error).
try:
    from orcha_cli import llm_util as _llm_util
except ImportError:
    _llm_util = None

# #287 boot-copy digest curation: a PURE curator (dedup + clip + recency cap + byte ceiling,
# older tail → one summary) shrinks the latest-digest injection so a long-lived agent's per-wake
# cost stays bounded. Imported as a module global so tests can monkeypatch it; bound to None if
# absent so _build_persona degrades to the raw (uncurated) injection rather than crashing a wake.
try:
    from orcha_cli import digest_curate as _digest_curate
except ImportError:
    _digest_curate = None

# Per-provider wake-path keys: the portal carries the SEALED stored key for the triage/ack provider
# on the wake-scan; the daemon unseals it locally with ORCHA_SECRET_KEY (shared, same host) so a
# Settings-stored xAI key reaches triage/ack with no plaintext on the wire. Bound to None if absent
# so the daemon simply degrades to its env keys (ORCHA_LLM_API_KEY / XAI_API_KEY).
try:
    from orcha_cli import secret_box as _secret_box
except ImportError:
    _secret_box = None


def _load_master_key_from_env_file() -> None:
    """Compatibility facade for loading the daemon's persisted master key."""
    _boot_context.load_master_key()


def _unseal_scan_key(scan: Optional[dict], field: str) -> Optional[str]:
    """Compatibility facade for a sealed wake-scan provider key."""
    return _boot_context.unseal_scan_key(
        scan, field, sys.modules[__name__]
    )


def _triage_wake(event_text: str, *, config: Optional[dict] = None, api_key: Optional[str] = None) -> dict:
    """Compatibility facade for fail-open universal-client triage."""
    return _boot_context.triage_wake(
        event_text,
        config=config,
        api_key=api_key,
        services=sys.modules[__name__],
    )


def _triage_config_from_scan(scan: dict) -> Optional[dict]:
    """Compatibility facade for wake-scan triage model configuration."""
    return _boot_context.triage_config(scan)


def decide_wake_suppression(cand, *, triage_fn=_triage_wake):
    """Compatibility facade for the pure wake-suppression grader."""
    return _wake_decisions.decide_wake_suppression(cand, triage_fn=triage_fn)


def decide_wake_tier(cand, *, triage_fn=_triage_wake):
    """Compatibility facade for the pure wake-tier grader."""
    return _wake_decisions.decide_wake_tier(cand, triage_fn=triage_fn)


def _ack_config_from_scan(scan: dict) -> Optional[dict]:
    """Compatibility facade for acknowledgement-model configuration."""
    return _wake_actions.ack_config_from_scan(scan)


def _log_graded_wake(verdict: dict, autonomy_level, acted: bool) -> None:
    """Compatibility facade for structured graded-wake logging."""
    _wake_actions.log_graded_wake(verdict, autonomy_level, acted)


def _advance_wake_cursor(api_base: str, cand: dict, event) -> None:
    """Compatibility facade for no-spawn cursor acknowledgement."""
    _wake_actions.advance_wake_cursor(api_base, cand, event, post_json=_post_json)


def _request_actionable(api_base: str, rid: str) -> Optional[bool]:
    """Compatibility facade for request actionability checks."""
    return _wake_actions.request_actionable(api_base, rid, get_json=_get_json)


def _apply_wake_act(api_base: str, cand: dict, event, verdict: dict, *,
                    quiet: bool, ack_config: Optional[dict] = None,
                    ack_api_key: Optional[str] = None) -> bool:
    """Compatibility facade for cheap routine handoff actions."""
    return _wake_actions.apply_wake_act(
        api_base,
        cand,
        event,
        verdict,
        quiet=quiet,
        llm_util=_llm_util,
        get_json=_get_json,
        post_json=_post_json,
        ack_config=ack_config,
        ack_api_key=ack_api_key,
    )


def _suppress_wake(api_base: str, cand: dict, event, suppress: dict, *, quiet: bool) -> None:
    """Compatibility facade for suppressed-wake side effects."""
    _wake_actions.suppress_wake(
        api_base,
        cand,
        event,
        suppress,
        quiet=quiet,
        post_json=_post_json,
    )


# ---------- config ----------

def _resolve_runtime_executable(runtime: Optional[str]) -> Optional[str]:
    """Resolve through the runtime module while retaining the legacy fallback patch seam."""
    return _notifier_runtime._resolve_runtime_executable(
        runtime,
        fallbacks=_CODEX_EXEC_FALLBACKS,
    )


# Issue #36: how often a RUNNING daemon re-checks that its container still exists. Far longer
# than the scan --interval (default 2s) — this is a cheap liveness guard, not a hot path, and a
# minute's delay before an orphan self-terminates is harmless. The startup 404-refusal posture
# only protects the moment of launch; this carries the same protection through the daemon's life.
_DAEMON_LIVENESS_INTERVAL = 60.0


def _container_vanished(api_base: str, cid: str) -> bool:
    """Issue #36 self-terminate predicate. True iff the API is ALIVE and DEFINITIVELY no longer
    knows this container (HTTP 404).

    A long-running daemon resolves (api_base, cid) ONCE at startup. When its container is later
    REPLACED (`orcha up` / `init --force`) or its `.claude/orcha.json` goes stale, the daemon
    would otherwise poll a now-404 container forever — an orphan that still shows up as a live
    `orcha notifier` in ps (the #36 boot-loop postmortem found 4 notifier daemons, 3 of them bound
    to dead containers). Mirrors the startup 404-refusal: only a definitive 404 is grounds to quit.

    Returns False for 'unreachable' (API down / booting / mid-restart): a transient API bounce —
    routine during `orcha up` — must NEVER kill a healthy daemon. Only a definitive 'missing' does."""
    return _probe_container(api_base, cid) == "missing"


# ---------- transports (host-side side-effects) ----------


# #285: per-wake persona+digest reuse. run_daemon is a long-lived loop, so an agent's persona
# (static until the agent is edited) and its CURATED digest are stable between wakes that arrive
# close together — yet today every wake re-GETs /persona + /digest AND re-runs the (LLM) #287
# digest curation, re-paying a cost that hasn't changed. We cache the (persona, curated_digest)
# pair per agent_id under a short TTL so bursty/retried wakes reuse it; a long gap re-pays
# (acceptable — freshness on the order of one wake interval). Two invariants make this safe:
#   * the protocol (RULES) is DELIBERATELY never cached — _build_persona always fetches it fresh
#     so a human edit still applies on the very next wake (#326 A1);
#   * the checkpoint/respawn path (_checkpoint_and_respawn) calls with force_fresh=True, which
#     bypasses AND refreshes the cache, so a just-written continuity digest is never served
#     stale — that is the whole safety bar of #285.
# Zero contract change: this is entirely daemon-side. ORCHA_PERSONA_CACHE_TTL_SECS overrides the
# default (set 0 to effectively disable — every entry is born already expired).
_PERSONA_CACHE_TTL_SECS = float(os.environ.get("ORCHA_PERSONA_CACHE_TTL_SECS") or 90.0)
# agent_id -> (expires_at_monotonic, persona_or_None, curated_digest_or_None)
_PERSONA_CACHE: dict[str, tuple[float, Optional[dict], Optional[dict]]] = {}


def _clear_persona_cache() -> None:
    """Drop all cached persona+digest entries (test/diagnostic hook)."""
    _PERSONA_CACHE.clear()


def _persona_and_digest(api_base: str, agent_id: str,
                        *, force_fresh: bool = False) -> tuple[Optional[dict], Optional[dict]]:
    """Compatibility facade for cached persona and digest retrieval."""
    return _persona_cache.persona_and_digest(
        api_base,
        agent_id,
        force_fresh=force_fresh,
        services=sys.modules[__name__],
    )


def _build_persona(api_base: str, agent_id: str, *, task_id: Optional[str] = None,
                   force_fresh: bool = False, lane: str = "work",
                   self_wake: Optional[dict] = None,
                   return_resume_rendered: bool = False):
    """Compatibility facade for persona, digest, and fresh protocol rendering."""
    return _persona_cache.build_persona(
        api_base,
        agent_id,
        task_id=task_id,
        force_fresh=force_fresh,
        lane=lane,
        self_wake=self_wake,
        return_resume_rendered=return_resume_rendered,
        services=sys.modules[__name__],
    )


def spawn_headless(cwd: str, prompt: str, flags: Optional[str], dry_run: bool,
                   *, alias: Optional[str] = None,
                   system_prompt: Optional[str] = None,
                   model: Optional[str] = None,
                   reasoning_effort: Optional[str] = None,
                   runtime: Optional[str] = None,
                   resume_session_id: Optional[str] = None,
                   log_path: Optional[pathlib.Path] = None,
                   last_message_path: Optional[pathlib.Path] = None,
                   run_token: Optional[str] = None,
                   conversation: bool = False) -> tuple[bool, str, object]:
    """Compatibility facade for launching one-shot coding-agent workers."""
    return _headless.spawn_headless(
        cwd, prompt, flags, dry_run, alias=alias, system_prompt=system_prompt,
        model=model, reasoning_effort=reasoning_effort, runtime=runtime,
        resume_session_id=resume_session_id, log_path=log_path,
        last_message_path=last_message_path, run_token=run_token,
        conversation=conversation, services=sys.modules[__name__],
    )



def select_transport(cand: dict) -> str:
    """Pure transport choice for a should-wake candidate: tmux | ephemeral | unreachable.

    'ephemeral' is a one-shot coding-agent wake worker (this value was once 'headless', but a
    RESIDENT conversation session is ALSO headless — no tty — so the real axis is
    ephemeral|resident, matching the E1 lease_kind; residents are driven by service_residents,
    not this scan)."""
    if cand.get("tmux_target") and tmux_pane_live(cand["tmux_target"]):
        return "tmux"
    if cand.get("headless_cwd"):
        return "ephemeral"
    return "unreachable"


def derive_wake_event(cand: dict) -> Optional[str]:
    """The single event LABEL a should-wake candidate is woken under, in precedence order:
    a real pending event (latest_event) wins; else an auto-start ready task; else #266's
    clock-driven heartbeat (`auto_wake`). Returns None for a candidate with none of these.
    This is what `tick()` records on the wake-claim + worker_run, so it is exercised here as a
    pure function rather than re-derived inline at each call site."""
    return (cand.get("latest_event")
            or ("auto_start" if cand.get("auto_start_task_ids") else None)
            or ("self_wake" if cand.get("self_wake_due") else None)
            or ("auto_wake" if cand.get("auto_wake_due") else None))  # #266: clock-driven heartbeat


def self_wake_ack_fields(cand: dict, *, kind: str, sent: bool, resume_rendered: bool) -> dict:
    """GH #122: ack fields that consume a self-wake only after rendered headless delivery."""
    if (sent and kind == "ephemeral" and cand.get("self_wake_injected")
            and resume_rendered and cand.get("self_wake_task_id")):
        return {"clear_self_wake": True, "self_wake_task_id": cand["self_wake_task_id"]}
    return {}


# ---------- E3: the resident-session transport (a WARM, stdin-driven `claude`) ----------

def spawn_resident(cwd: str, *, system_prompt: Optional[str] = None,
                   log_path: Optional[pathlib.Path] = None,
                   resume_session_id: Optional[str] = None,
                   alias: Optional[str] = None, flags: Optional[str] = None,
                   model: Optional[str] = None,
                   reasoning_effort: Optional[str] = None,
                   runtime: Optional[str] = None,
                   run_token: Optional[str] = None,
                   conversation: bool = False,
                   dry_run: bool = False) -> tuple[bool, str, object]:
    """Compatibility facade for launching warm conversation workers."""
    return _resident_spawn.spawn_resident(
        cwd, system_prompt=system_prompt, log_path=log_path,
        resume_session_id=resume_session_id, alias=alias, flags=flags,
        model=model, reasoning_effort=reasoning_effort, runtime=runtime,
        run_token=run_token, conversation=conversation, dry_run=dry_run,
        services=sys.modules[__name__],
    )



# ---------- GH #91/#90: embodiment-token lifecycle (mint before spawn, revoke on teardown) ----------
# A token is a per-PROCESS work/conversation capability, decoupled from worker_runs. The daemon mints
# one BEFORE Popen at every run-creating spawn site (so it is valid in the DB before the worker's
# first gated call), injects it as ORCHA_RUN_TOKEN, stores it in the live-state dict, and revokes it
# when the process is torn down. The server-side run-terminal revoke (bound via token_id at run-create)
# is the durable backstop; this daemon-side revoke is the fast path.
#
# `pending_revokes`: tokens whose revoke POST failed transiently. Retried best-effort each tick — the
# DB binding means even if the daemon dies before the retry lands, the server still revokes on the
# run's terminal transition, so no live token can strand.
pending_revokes: list[str] = []


def _mint_embodiment_token(api_base: str, aid: str, lane: str, kind: str) -> Optional[str]:
    """Compatibility facade for process-scoped capability minting."""
    return _embodiment.mint_token(api_base, aid, lane, kind, post_json=_post_json)


def _revoke_embodiment_token(api_base: str, token: Optional[str]) -> bool:
    """Compatibility facade for best-effort token revocation."""
    return _embodiment.revoke_token(api_base, token, post_json=_post_json)


def _revoke_or_defer(api_base: str, token: Optional[str]) -> None:
    """Compatibility facade retaining the notifier's shared retry list."""
    if token and not _revoke_embodiment_token(api_base, token):
        pending_revokes.append(token)


def _drain_pending_revokes(api_base: str) -> None:
    """Retry parked revocations through the patchable compatibility facade."""
    pending_revokes[:] = [
        token for token in pending_revokes
        if not _revoke_embodiment_token(api_base, token)
    ]


def _retire_headless(api_base: str, live_workers: dict, aid) -> Optional[dict]:
    """Revoke and retire a headless worker through the shared teardown path."""
    w = live_workers.get(aid)
    if w is not None:
        _revoke_or_defer(api_base, w.get("run_token"))
    return live_workers.pop(aid, None)


def _retire_resident(api_base: str, live_residents: dict, conv_id) -> Optional[dict]:
    """Revoke and retire a resident through the shared teardown path."""
    r = live_residents.get(conv_id)
    if r is not None:
        _revoke_or_defer(api_base, r.get("run_token"))
    return live_residents.pop(conv_id, None)


def _finish_run(api_base: str, run_id, status: str, exit_code, log_path, diff=None,
                kill_reason=None) -> None:
    """Compatibility facade for terminal run persistence."""
    _embodiment.finish_run(
        api_base,
        run_id,
        status,
        exit_code,
        log_path,
        post_json=_post_json,
        capture_output=_capture_run_output,
        usage_from_log=_usage_from_log,
        diff=diff,
        kill_reason=kill_reason,
    )


def _run_pid_alive(pid) -> bool:
    """Compatibility facade for host process liveness checks."""
    return _embodiment.run_pid_alive(pid)


def _reap_dead_pid_resident_runs(api_base: str, aid: str, live_pids=frozenset(),
                                 *, quiet: bool = True) -> int:
    """Compatibility facade preserving notifier monkeypatch seams."""
    return _embodiment.reap_dead_resident_runs(
        api_base,
        aid,
        live_pids,
        get_json=_get_json,
        post_json=_post_json,
        finish_run=_finish_run,
        pid_alive=_run_pid_alive,
        quiet=quiet,
    )


# ---------- ISS-8: per-worker git worktree isolation + net-diff capture ----------

def _run_git(args, cwd=None, timeout: float = 30.0):
    """Compatibility facade for best-effort Git commands."""
    return _worktree_base.run_git(args, cwd, timeout)


def _safe_ref(alias) -> str:
    """Compatibility facade for Git-safe alias normalization."""
    return _worktree_base.safe_ref(alias)


def _ensure_worktree_exclude(base_cwd) -> None:
    """Compatibility facade for the repository-local worktree exclusion."""
    _worktree_base.ensure_exclude(base_cwd, sys.modules[__name__])


def _provision_worktree(base_cwd, alias):
    """Compatibility facade for disposable worker worktrees."""
    return _worktree_base.provision_disposable(
        base_cwd, alias, sys.modules[__name__]
    )


def _overlay_runtime_config(base, wt):
    """Compatibility facade for ignored runtime configuration overlay."""
    _worktree_base.overlay_runtime_config(base, wt)


def _seed_tab_binding(base_cwd, alias, agent_id, container_id) -> bool:
    """#254: write the CLI tab binding `<base>/.claude/orcha-tabs/<alias>.json` for a
    PORTAL-created agent — write-if-ABSENT only (never clobber a human-edited binding).

    Binding files are otherwise written ONLY host-side by the CLI (`orcha init`/`connect --as`
    and the /orcha-register-agent skill). The portal register endpoint runs INSIDE the API
    container, so it can't touch the host `.claude/` — a portal agent gets no binding, and its
    spawned headless worker's `/orcha-*` skills then fail alias→agent_id resolution ("no binding
    for alias '<x>'"). The daemon DOES have alias + agent_id + cid + base_cwd in hand, so it
    seeds the binding host-side; `_overlay_runtime_config` copies it into the worktree unchanged
    (no overlay change needed). Idempotent + self-limiting (skips once the file exists), mirroring
    the reachability backfill. Returns True iff it CREATED the file."""
    if not (base_cwd and alias and agent_id):
        return False
    try:
        tabs = pathlib.Path(base_cwd) / ".claude" / "orcha-tabs"
        dst = tabs / f"{alias}.json"
        if dst.exists():
            return False                       # never overwrite an existing (human-edited) binding
        tabs.mkdir(parents=True, exist_ok=True)
        binding = {"alias": alias, "agent_id": agent_id, "container_id": container_id}
        dst.write_text(json.dumps(binding, indent=2) + "\n")
        return True
    except OSError:
        return False


def _provision_resident_worktree(base_cwd, conv_id):
    """Compatibility facade for stable conversation worktrees."""
    return _worktree_stable.provision_resident(
        base_cwd, conv_id, sys.modules[__name__]
    )


def _provision_live_worktree(base_cwd, alias):
    """Compatibility facade for stable live-terminal worktrees."""
    return _worktree_stable.provision_live(
        base_cwd, alias, sys.modules[__name__]
    )


def _provision_task_worktree(base_cwd, alias, task_id):
    """Compatibility facade for durable per-task worktrees."""
    return _worktree_stable.provision_task(
        base_cwd, alias, task_id, sys.modules[__name__]
    )


# the runtime config we overlay into a worktree (see _provision_worktree /
# _overlay_runtime_config) is NOT the worker's change — exclude it from the captured diff
# so it's not noise. GH#110: settings.json is TRACKED and copied in per-worktree by
# _overlay_runtime_config, so without this exclusion the local hook config would (a) show up
# in every captured diff and (b) — new for GH#110 — get committed onto the durable task branch
# a PR is cut from. Excluding it fixes both.
_DIFF_EXCLUDES = ("." , ":(exclude).claude/orcha.json", ":(exclude).claude/orcha-tabs",
                  ":(exclude).claude/settings.json")


def _capture_diff(worktree, cap: int = 200_000):
    """NET diff of the worktree vs origin/main (committed + uncommitted), so an
    edit-then-undo nets to EMPTY and Bash/sed edits (missed by the stream-json parse)
    are still captured. `add -A -N` marks new files intent-to-add so they show in the
    diff; the overlaid runtime config is excluded via pathspec."""
    if not worktree:
        return None
    _run_git(["add", "-A", "-N", "--", *_DIFF_EXCLUDES], cwd=worktree)
    rc, out = _run_git(["diff", "origin/main", "--", *_DIFF_EXCLUDES], cwd=worktree)
    if rc != 0:
        return None
    if len(out) > cap:
        out = out[:cap] + "\n...[diff truncated]..."
    return out


def _branch_commit_count(base_cwd, branch) -> int:
    """GH#110: how many commits `branch` has beyond origin/main (0 when the branch is unset,
    missing, or exactly at origin/main). Used to (a) keep a PR-ready/committed branch on teardown
    and (b) word the saved-work feed line correctly when a worker committed EARLIER in the run but
    left a clean tree this reap (PR #121 review note a), and (c) gate the §2c terminal-task branch
    delete (never drop a branch that still carries commits / an open PR — a PR branch has commits)."""
    if not branch:
        return 0
    rc, out = _run_git(["rev-list", "--count", f"origin/main..{branch}"], cwd=base_cwd)
    return int(out.strip()) if rc == 0 and out.strip().isdigit() else 0


def _teardown_worktree(base_cwd, worktree, branch):
    """Remove the worktree dir on finish. Keep the branch if it has commits beyond
    origin/main (PR-ready); delete it otherwise (nothing worth keeping)."""
    if not worktree:
        return
    has_commits = _branch_commit_count(base_cwd, branch) > 0
    _run_git(["worktree", "remove", "--force", worktree], cwd=base_cwd)
    if branch and not has_commits:
        _run_git(["branch", "-D", branch], cwd=base_cwd)


def _is_git_repo(cwd) -> bool:
    """True if `cwd` is inside a git work tree (so there's a shared checkout to isolate from)."""
    return bool(cwd) and _run_git(["rev-parse", "--git-dir"], cwd=cwd)[0] == 0


def _worktree_is_dirty(worktree, excludes=None) -> bool:
    """True if the worktree has uncommitted changes (staged, unstaged, or untracked). `excludes`
    (pathspecs) drops paths that aren't the worker's work — notably the overlaid runtime config
    (_DIFF_EXCLUDES): _overlay_runtime_config copies in the TRACKED .claude/settings.json, so
    without excluding it EVERY task worktree reads dirty (GH#110 §2c would then never reclaim one)."""
    if not worktree:
        return False
    args = ["status", "--porcelain"] + (["--", *excludes] if excludes else [])
    rc, out = _run_git(args, cwd=worktree)
    return rc == 0 and bool(out.strip())


def _safe_teardown_worktree(base_cwd, worktree, branch) -> str:
    """Tear down an EMBODIMENT's worktree WITHOUT ever discarding uncommitted work.

    The ephemeral one-shot path (_teardown_worktree) force-removes — a finished one-shot worker
    leaves nothing a human cares about. But a LIVE terminal or a conversational RESIDENT may leave
    un-pushed edits a person isn't done with, so: remove only when the worktree is CLEAN (committed
    work on the branch is still preserved by _teardown_worktree, which keeps a branch that has
    commits); if it's DIRTY, PRESERVE the worktree + report it. Returns
    'removed' | 'preserved-dirty' | 'noop'."""
    if not worktree:
        return "noop"
    if _worktree_is_dirty(worktree):
        return "preserved-dirty"
    _teardown_worktree(base_cwd, worktree, branch)
    return "removed"


# ---------- GH#110: task-worker continuity (preserve worktree/diff across wakes) ----------

# After this many CONSECUTIVE failed/rate-limited drains of the same (agent, task) task worker,
# advance the wake cursor anyway + emit a human-visible failure event, so a deterministically
# failing worker can't hot-loop forever on the withheld cursor. Daemon-scope (see main()); a
# daemon restart resets it (a fresh N), which is acceptable — the loop we bound is intra-daemon.
FAILED_DRAIN_MAX = 3

# Fallback hold-down when a Codex rate-limit event carries no parseable reset/retry-after — long
# enough to clear a typical 429 cooldown without stranding the agent.
RATE_LIMIT_DEFAULT_BACKOFF_SECS = 60.0


def _checkpoint_task_worktree(base_cwd, worktree, branch, task_id, run_id):
    """GH#110: on a CLEAN task-worker exit with a dirty tree, commit the work as a LOCAL checkpoint
    on the durable task branch and KEEP the worktree, so the next same-(agent+task) wake resumes
    from it. NEVER pushes, never opens a PR (that stays a human/review step). Commits with the same
    exclusion pathspecs used for diff capture (_DIFF_EXCLUDES) so the overlaid runtime config —
    notably the TRACKED .claude/settings.json — never lands on the branch a PR is cut from. If the
    tree is clean after exclusions, SKIPS the commit (nothing to preserve). Returns the checkpoint
    commit sha (short) on commit, or None when nothing was committed."""
    if not worktree:
        return None
    # stage everything the worker touched, minus the overlaid runtime config
    _run_git(["add", "-A", "--", *_DIFF_EXCLUDES], cwd=worktree)
    rc, staged = _run_git(["diff", "--cached", "--name-only", "--", *_DIFF_EXCLUDES], cwd=worktree)
    if rc != 0 or not staged.strip():
        return None                          # clean after exclusions → nothing worth committing
    msg = f"orcha: checkpoint task {task_id or '?'} run {run_id or '?'}"
    rc, _ = _run_git(["-c", "user.email=orcha@localhost", "-c", "user.name=orcha",
                      "commit", "-m", msg], cwd=worktree)
    if rc != 0:
        return None
    rc, sha = _run_git(["rev-parse", "--short", "HEAD"], cwd=worktree)
    return sha.strip() if rc == 0 and sha.strip() else None


def _codex_exit_status(log_path, returncode) -> str:
    """Compatibility facade for Codex worker result classification."""
    if _codex_tail_is_rate_limited(log_path):
        return "rate_limited"
    result_status = _codex_result_status(log_path)
    if result_status == "error":
        return "failed"
    if result_status is None and returncode not in (0, None):
        return "failed"
    return "exited"


def _codex_tail_is_rate_limited(log_path) -> bool:
    """Compatibility facade for tail rate-limit detection."""
    return _worker_results.codex_tail_is_rate_limited(log_path, sys.modules[__name__])


def _parse_rate_limit_reset(log_path) -> float:
    """Compatibility facade for rate-limit retry delay parsing."""
    return _worker_results.parse_rate_limit_reset(log_path, sys.modules[__name__])


def _saved_ref(w, checkpoint_sha, diff) -> dict:
    """Compatibility facade for durable task-work pointers."""
    return _task_continuity.saved_ref(w, checkpoint_sha, diff, sys.modules[__name__])


def _saved_human_line(base_cwd, branch, sha) -> str:
    """Compatibility facade for plain-language saved-work messages."""
    return _task_continuity.saved_human_line(
        base_cwd, branch, sha, sys.modules[__name__]
    )


def _reclaim_task_worktree(base_cwd, worktree, branch) -> str:
    """Compatibility facade for safe task-worktree reclamation."""
    return _task_continuity.reclaim_task_worktree(
        base_cwd, worktree, branch, sys.modules[__name__]
    )


def _record_task_saved_ref(api_base, w, saved_ref, human_line) -> None:
    """Compatibility facade for publishing task saved-work pointers."""
    _task_continuity.record_task_saved_ref(
        api_base, w, saved_ref, human_line, sys.modules[__name__]
    )


def _synthesize_task_digest(api_base, agent_id, task_id, saved_ref, run_started_ts, human_line) -> None:
    """Compatibility facade for task-worker continuity digests."""
    _task_continuity.synthesize_task_digest(
        api_base,
        agent_id,
        task_id,
        saved_ref,
        run_started_ts,
        human_line,
        sys.modules[__name__],
    )


def _is_stream_event_line(line: str) -> bool:
    """Compatibility facade for partial stream-event filtering."""
    return _run_feed.is_stream_event_line(line)


def _pump_one(api_base: str, aid: str, w: dict) -> None:
    """Compatibility facade for durable worker run-feed streaming."""
    _run_feed.pump_one(api_base, w, _post_json)


def _checkpoint_and_respawn(api_base: str, aid: str, w: dict, live_workers: dict,
                            quiet: bool) -> None:
    """ISS-76 (#194) — checkpoint-and-respawn a still-progressing worker that crossed the soft
    hard cap (HARD_CAP_MIN_SECS). It is a long task, not a runaway, so don't SIGKILL it mid-work:

      1. GRACEFULLY stop it (SIGTERM → grace window) so claude's SessionEnd hook writes the C1
         continuity digest before the process dies; capture its git diff + finish the run as
         `exited` (the work succeeded so far — not `killed`).
      2. KEEP the worktree (no teardown) — the respawn reuses it, so committed + uncommitted work
         carries over.
      3. Spawn a FRESH worker on that same worktree with a freshly-rebuilt persona (now carrying
         the just-written digest) so it resumes with continuity but a clean context window, and
         RESET its cap/progress trackers (respawns += 1).

    The single-flight lease is HELD throughout (wake-renew each tick keeps it; the success ack
    below is non-releasing), so no second worker can claim the agent during the swap. Bounded by
    HARD_CAP_RESPAWN_MAX in reap_workers — past that a task that still won't finish is a runaway."""
    proc = w["proc"]
    ctx = w.get("respawn_ctx") or {}
    base_cwd = w.get("base_cwd")
    worktree = w.get("worktree")
    branch = w.get("branch")
    n = w.get("respawns", 0) + 1
    cap = w.get("cap", HARD_CAP_MIN_SECS)

    # 1) graceful checkpoint — SessionEnd (C1 digest) runs before the process is forced down.
    _kill_worker(proc, graceful=True)
    diff = _capture_diff(worktree)
    _finish_run(api_base, w.get("run_id"), "exited", 0, w.get("log_path"), diff)

    # GH #126: don't trust the in-memory ctx["task_id"] snapshot captured at original spawn -- if
    # the server's record for this agent's just-finished run has since diverged (e.g. the agent was
    # reassigned to a different task mid-run), blindly carrying ctx.task_id forward would respawn
    # the worker still claiming the OLD task while the server's truth says otherwise. Re-fetch the
    # just-finished run's task_id from the server and use that; fail open to ctx.get("task_id")
    # only if the fetch itself fails OR the finished run isn't found, never on a mismatch.
    #
    # `/runs` is newest-run-first across BOTH lanes (work + conversation) -- NOT "the run that just
    # finished". A conversation-lane run started after this checkpoint's work run (e.g. the human
    # chatted with the agent mid-task) would sort first and could carry a different (often null)
    # task_id, so we must match this checkpoint's own run_id explicitly rather than take runs[0].
    finished_run_id = w.get("run_id")
    _server_runs = _get_json(f"{api_base}/api/agents/{aid}/runs?limit=20")
    respawn_task_id = ctx.get("task_id")
    if _server_runs and _server_runs.get("runs"):
        for _run in _server_runs["runs"]:
            if _run.get("run_id") == finished_run_id:
                respawn_task_id = _run.get("task_id")
                break

    # GH #91/#90: the OLD process is dead — revoke its work token, then mint a FRESH work token for
    # the respawned process. Exactly one live token per live process. Revoke-old first (idempotent):
    old_tok = w.get("run_token")
    _revoke_or_defer(api_base, old_tok)
    new_tok = _mint_embodiment_token(api_base, aid, "work", "headless")

    # 2) respawn AS the agent with the freshest digest, on the SAME worktree. #285: force_fresh
    # bypasses the persona/digest cache — step 1 just wrote a NEW continuity digest (C1) for this
    # agent, so a cached (pre-checkpoint) digest here would respawn it with stale continuity.
    persona = _build_persona(api_base, aid, force_fresh=True)
    run_cwd = worktree or base_cwd
    log_path = None
    if base_cwd:
        log_path = (pathlib.Path(base_cwd) / ".claude" / ".orcha-wakes"
                    / f"{ctx.get('alias', 'agent')}-{int(time.time())}.log")
    sent, _cmd, newproc = spawn_headless(run_cwd, ctx.get("prompt", ""), ctx.get("flags"), False,
                                         alias=ctx.get("alias"), system_prompt=persona,
                                         model=ctx.get("model"),
                                         reasoning_effort=ctx.get("reasoning_effort"),
                                         runtime=ctx.get("model_runtime"),
                                         log_path=log_path, run_token=new_tok)
    if not (sent and newproc is not None):
        # Respawn failed to spawn — release the lease so the agent isn't stranded. GH#110 (PR #121
        # review, BLOCKER 1): a DURABLE task worktree must be PRESERVED here, NOT force-removed —
        # the graceful checkpoint above already snapshotted the work, so tearing it down would
        # discard exactly the uncommitted build we exist to keep (Andrew's scenario, on the
        # long-build path most likely to cross the cap). Checkpoint-commit + record the saved ref
        # + synthesize the continuity digest (the clean-exit success shape); only a disposable
        # ephemeral worktree is torn down. The cursor stays WITHHELD (no delivered_ts) so a later
        # wake retries from the preserved state.
        # GH #91/#90: revoke the just-minted new token explicitly (nothing will ever carry it), then
        # store it so _retire_headless revokes whatever is tracked (idempotent) as it pops.
        _revoke_or_defer(api_base, new_tok)
        is_task_wt = bool(w.get("task_worktree"))
        if is_task_wt:
            t_id = ctx.get("task_id")
            sha = _checkpoint_task_worktree(base_cwd, worktree, branch, t_id, w.get("run_id"))
            if sha or (diff or "").strip():
                saved = _saved_ref(w, sha, diff)
                human = _saved_human_line(base_cwd, branch, sha)
                _record_task_saved_ref(api_base, w, saved, human)
                _synthesize_task_digest(api_base, aid, t_id, saved, w.get("started_ts"), human)
        else:
            _teardown_worktree(base_cwd, worktree, branch)
        _post_json(f"{api_base}/api/agents/{aid}/wake-ack",
                   {"kind": "worker_checkpoint_respawn_failed", "release_lease": True,
                    "lane": w.get("lane", "work")})
        w["run_token"] = new_tok
        _retire_headless(api_base, live_workers, aid)
        if not quiet:
            print(f"[notifier] checkpoint-respawn for {aid} FAILED to spawn a fresh worker — "
                  f"{'task worktree preserved' if is_task_wt else 'worktree torn down'} + "
                  f"lease released")
        return

    # GH #91/#90: a respawned worker continues on ITS OWN lane (stamped at first spawn; today
    # always 'work' — tick ephemerals are work-lane by construction, PR R5); carry the minted
    # token_id so the server binds embodiment_tokens.run_id to this run (durable EOL backstop).
    run = _post_json(f"{api_base}/api/agents/{aid}/runs",
                     {"wake_kind": "ephemeral", "wake_event": "checkpoint_respawn",
                      "task_id": respawn_task_id,
                      "log_path": str(log_path) if log_path else None,
                      "pid": newproc.pid, "runtime": ctx.get("model_runtime"),
                      "worktree": worktree, "branch": branch, "base_cwd": base_cwd,
                      "lane": w.get("lane", "work"), "token_id": new_tok})
    now = time.time()
    live_workers[aid] = {
        "proc": newproc,
        "hard_deadline": now + cap,
        "last_size": 0, "last_progress_ts": now,
        "run_id": (run or {}).get("run_id"), "log_path": log_path,
        "worktree": worktree, "branch": branch, "base_cwd": base_cwd,
        # GH#110 (PR #121 review, BLOCKER 1): a checkpoint-respawned TASK worker MUST stay a task
        # worker across the swap. Without these keys the reaper reads task_worktree=False on the
        # respawned worker's clean exit and _teardown_worktree FORCE-REMOVES the durable task
        # worktree (Andrew's data-loss scenario), skips the checkpoint/saved_ref/digest, and drops
        # the bounded-release cursor (wake_ack_ts) — so a respawned worker that later hits
        # FAILED_DRAIN_MAX would release on delivered_ts=None (no advance) and never stop
        # re-waking. Carry them through (wake_task_id also keeps the GH#36 no-op-kill re-assert
        # correctly DISABLED for a task worker across the swap).
        "task_worktree": bool(w.get("task_worktree")),
        "wake_ack_ts": w.get("wake_ack_ts"),
        "wake_task_id": w.get("wake_task_id"),
        "started_ts": w.get("started_ts"),
        "agent_id": w.get("agent_id") or aid,
        "lines_offset": 0, "lines_seq": 1, "lines_buf": b"",
        # GH #58: the original wake's handled-set rides the respawn so the FINAL clean exit acks it
        # (the checkpoint-respawn finishes the old run but the wake's work is still in flight).
        "handled_event_ids": ctx.get("handled_event_ids") or w.get("handled_event_ids") or [],
        "cap": cap, "respawns": n, "respawn_ctx": ctx, "lane": w.get("lane", "work"),
        "run_token": new_tok}   # GH #91/#90: track the fresh work token for teardown revoke
    # Non-releasing ack: keep the single-flight lease (the new worker continues under it) but
    # record the checkpoint for portal/event visibility + refresh the cooldown debounce.
    _post_json(f"{api_base}/api/agents/{aid}/wake-ack",
               {"kind": "worker_checkpoint_respawn", "release_lease": False,
                "lane": w.get("lane", "work")})
    if not quiet:
        print(f"[notifier] worker for {aid} (pid {proc.pid}) crossed the soft hard-cap while "
              f"still progressing — checkpointed (C1 digest) + respawned (pid {newproc.pid}, "
              f"respawn {n}/{HARD_CAP_RESPAWN_MAX}) on the same worktree")


def _drain_task_failure(api_base: str, w: dict, aid: str, task_id, status: str,
                        returncode, diff, *, failed_drains: dict, agent_hold_until: dict,
                        now: float, quiet: bool, w_lane: str, live_workers: dict,
                        pid, drain_desc: str = "drained") -> None:
    """GH#110: the shared rate_limited/failed TASK-drain bookkeeping — PRESERVE the task worktree
    (never teardown), record the run with its structured cause, count the failed drain, and DON'T
    advance the wake cursor (the events stay pending so the next wake retries from the preserved
    state) — bounded by FAILED_DRAIN_MAX. Used by BOTH reap paths: the clean-exit poll() branch and
    the completed-but-lingering kill branch (PR #121 review blocker: the lingering branch used to
    record a terminal-failure Codex worker as a normal 'exited' drain — checkpoint, counter
    cleared, cursor ADVANCED — silently skipping the retry instead of routing it here)."""
    _finish_run(api_base, w.get("run_id"), status, returncode, w.get("log_path"),
                diff, kill_reason=json.dumps({"run_id": str(w.get("run_id")),
                                              "agent_id": aid, "cause": status,
                                              "task_id": task_id}))
    key = (aid, task_id)
    failed_drains[key] = failed_drains.get(key, 0) + 1
    n = failed_drains[key]
    if status == "rate_limited":
        hold = _parse_rate_limit_reset(w.get("log_path"))
        agent_hold_until[aid] = now + hold
        human = ("worker hit a rate limit (Codex 429) — work saved and preserved; "
                 "it will retry after the cooldown")
    else:
        human = "worker exited without finishing — work saved and preserved; it will retry"
    _record_task_saved_ref(api_base, w, _saved_ref(w, None, diff), human)
    if n >= FAILED_DRAIN_MAX:
        # bounded redelivery: stop the hot-loop — advance the cursor and surface a plain-language
        # failure so a human can look, then clear the counter. GH #58 (R5 blocker): the release
        # cursor is wake_ack_ts (the ack_through_ts/max_event_ts batch high-water stashed at
        # spawn), NOT the retired pending_ack_ts — that stash is always None now, which the
        # server reads as "no advance", so releasing on it left the same events pending and
        # restarted the identical failure cycle from zero.
        _post_json(f"{api_base}/api/agents/{aid}/wake-ack",
                   {"delivered_ts": w.get("wake_ack_ts"),
                    "kind": "worker_drain_failed_released", "release_lease": True,
                    "lane": w_lane})
        _record_task_saved_ref(
            api_base, w, _saved_ref(w, None, diff),
            f"heads up: this worker has failed to finish {n} times in a row — "
            f"releasing it for now so it doesn't loop; the work is saved on its branch")
        failed_drains.pop(key, None)
    else:
        # withhold the cursor (no delivered_ts) but release the lease so a later wake
        # can retry. GH#110 DoD(3): do NOT ack/close pending notifications here.
        _post_json(f"{api_base}/api/agents/{aid}/wake-ack",
                   {"kind": ("worker_rate_limited" if status == "rate_limited"
                             else "worker_drain_failed"), "release_lease": True,
                    "lane": w_lane})
    _retire_headless(api_base, live_workers, aid)   # GH #91/#90: revoke token, then pop
    if not quiet:
        print(f"[notifier] task worker for {aid} (pid {pid}) {drain_desc} {status} "
              f"({n}/{FAILED_DRAIN_MAX}) — worktree PRESERVED, cursor "
              f"{'advanced (bound hit)' if n >= FAILED_DRAIN_MAX else 'withheld'}")


def reap_workers(api_base: str, live_workers: dict, quiet: bool, stall_secs: float = 120.0,
                 failed_drains: Optional[dict] = None,
                 agent_hold_until: Optional[dict] = None) -> None:
    """R2.4 reaper + ISS-15/ISS-31 watchdog: for each tracked worker, either release its
    lease on clean exit OR kill it — but kill on STALL, not a fixed deadline. A2: finishes
    the worker_runs row (status + output + ISS-8 diff) on the way out.

    GH#110: `failed_drains` {(agent_id, task_id): int} and `agent_hold_until` {agent_id: float}
    are DAEMON-SCOPE dicts (created once in main(), survive the per-reap `live_workers.pop`). They
    bound the withheld-cursor task-worker path: `failed_drains` counts consecutive failed/rate-
    limited drains so the cursor is force-advanced after FAILED_DRAIN_MAX; `agent_hold_until`
    records a rate-limit cooldown so tick skips re-waking a still-limited agent. Both default to a
    throwaway dict for the pre-GH#110 callers (tests, --once) that don't thread them.

    The daemon tracks {agent_id: {proc, hard_deadline, last_size, last_progress_ts, run_id,
    log_path, worktree, branch, base_cwd}}. Each tick:
      * exited -> finish the run + tear down the worktree + release the single-flight lease.
      * still running -> check PROGRESS via the per-wake log's size. While it grows the
        worker is alive and is LEFT RUNNING even past the old 300s lease (ISS-31: a slow
        cold-start + a long tool call routinely needs >5 min). Kill ONLY if the log hasn't
        grown for `stall_secs` (genuinely stuck). ISS-76: a worker STILL GROWING when it crosses
        the soft hard_deadline is NOT killed — it's checkpoint-respawned (graceful snapshot +
        fresh worker on the same worktree), bounded by HARD_CAP_RESPAWN_MAX as the runaway
        backstop; only a stalled (or respawn-exhausted) worker is reaped.

    Before ISS-31 the kill was a fixed deadline regardless of output, so it reaped workers
    that were still producing. proc.poll() (not os.kill(pid,0)) detects exit: an exited child
    is a zombie until the parent reaps it, and kill(pid,0) reports a zombie as alive."""
    if failed_drains is None:
        failed_drains = {}
    if agent_hold_until is None:
        agent_hold_until = {}
    now = time.time()
    for aid, w in list(live_workers.items()):
        proc = w["proc"]
        # GH #91/#90 (PR R5): renew/release against the lane THIS worker's lease lives on (stamped
        # at spawn) — a hardcoded 'work' would renew/release the wrong lane's lease if a
        # conversation-lane worker ever landed in this dict. Default 'work' covers legacy entries.
        w_lane = w.get("lane", "work")
        # ISS-39: flush the worker's latest stream-json lines to the DB every tick (this is the
        # live feed) AND right before any finish below — the daemon posts a run's final lines
        # before its status flips, so the SSE never emits `done` ahead of a tail line.
        _pump_one(api_base, aid, w)
        if proc.poll() is not None:    # exited — poll() has reaped the zombie
            diff = _capture_diff(w.get("worktree"))
            # GH#110: a clean exit (returncode-only) is NOT automatically a successful drain. A
            # Codex worker that died on a 429 still exits 0; read its runtime's classifiers so a
            # rate-limited/failed drain is recorded as such — never as a cursor-advancing success.
            w_runtime = _normalize_runtime((w.get("respawn_ctx") or {}).get("model_runtime"))
            status = "exited"
            if w_runtime == RUNTIME_CODEX:
                status = _codex_exit_status(w.get("log_path"), proc.returncode)
            is_task_wt = bool(w.get("task_worktree"))
            task_id = (w.get("respawn_ctx") or {}).get("task_id")
            if is_task_wt and status in ("rate_limited", "failed"):
                # GH#110: PRESERVE the task worktree, record the structured cause, withhold the
                # cursor so the next wake retries — the shared bookkeeping in _drain_task_failure.
                # PR #121 review note (b): tag the run with WHY it drained non-successfully so the
                # feed/meter shows a structured cause (rate_limited vs failed), not a bare status.
                _drain_task_failure(api_base, w, aid, task_id, status, proc.returncode, diff,
                                    failed_drains=failed_drains,
                                    agent_hold_until=agent_hold_until, now=now, quiet=quiet,
                                    w_lane=w_lane, live_workers=live_workers, pid=proc.pid,
                                    drain_desc="drained")
                continue
            _finish_run(api_base, w.get("run_id"), status, proc.returncode, w.get("log_path"), diff)
            if is_task_wt:
                # GH#110 SUCCESS: checkpoint-commit the dirty tree onto the durable branch + KEEP
                # the worktree (next same-task wake resumes from it), record the saved_ref + inject
                # a continuity digest, clear the failed-drain counter. GH #58: the cursor advances
                # via the ack-handled seam below (contiguous floor), so delivered_ts stays None.
                sha = _checkpoint_task_worktree(w.get("base_cwd"), w.get("worktree"),
                                                w.get("branch"), task_id, w.get("run_id"))
                failed_drains.pop((aid, task_id), None)
                if sha or (diff or "").strip():
                    saved = _saved_ref(w, sha, diff)
                    human = _saved_human_line(w.get("base_cwd"), w.get("branch"), sha)
                    _record_task_saved_ref(api_base, w, saved, human)
                    _synthesize_task_digest(api_base, aid, task_id, saved,
                                            w.get("started_ts"), human)
                _post_json(f"{api_base}/api/agents/{aid}/wake-ack",
                           {"delivered_ts": None,
                            "kind": "released", "release_lease": True, "lane": w_lane})
            else:
                _teardown_worktree(w.get("base_cwd"), w.get("worktree"), w.get("branch"))
                _post_json(f"{api_base}/api/agents/{aid}/wake-ack",
                           {"kind": "released", "release_lease": True, "lane": w_lane})
            # GH #58: on a CLEAN exit (rc 0) record the per-event handled-set this run drained so it
            # stops re-waking — the server then advances delivered_ts to the contiguous floor (events
            # the run could NOT handle stay pending and re-surface). A non-zero exit, or a
            # rate_limited/failed task drain (handled above via `continue`), marks nothing.
            if proc.returncode == 0:
                _post_json(f"{api_base}/api/agents/{aid}/events/ack-handled",
                           {"event_ids": w.get("handled_event_ids") or []})
            _retire_headless(api_base, live_workers, aid)   # GH #91/#90: revoke token, then pop
            if not quiet:
                print(f"[notifier] worker for {aid} (pid {proc.pid}, rc={proc.returncode}) "
                      f"exited ({status}) — "
                      f"{'task worktree preserved' if is_task_wt else 'worktree torn down'}, "
                      f"lease released")
            continue
        # Wake-latency fix: this worker is still alive — renew its short single-flight lease so
        # it doesn't expire mid-run (which would let a second worker spawn). A crashed worker, or
        # one the daemon stops tracking, is NOT renewed, so its lease lapses within
        # WAKE_LEASE_TTL_SECS and a fresh high-priority event can wake a new worker promptly.
        renew = _post_json(f"{api_base}/api/agents/{aid}/wake-renew",
                           {"lease_ttl": WAKE_LEASE_TTL_SECS, "lane": w_lane})
        # #240/ISS-72: a human requested a graceful STOP of THIS tracked run (surfaced on the renew
        # above — zero new poll). Vet stop_run_id == the run THIS daemon tracks (run-id identity
        # check, the #276 pattern at run level — never kill a stale/foreign run), then reap it with
        # the SAME graceful teardown the stall/hard-cap watchdog uses: SIGTERM -> grace -> SIGKILL so
        # SessionEnd/C1 runs, finish 'killed' with a structured human_stop reason, PRESERVE a dirty
        # worktree (the in-progress diff is the record of what it was doing), release the lease.
        if (renew and renew.get("stop_requested")
                and str(renew.get("stop_run_id")) == str(w.get("run_id"))):
            _kill_worker(proc, graceful=True)
            diff = _capture_diff(w.get("worktree"))
            diag = {"run_id": str(w.get("run_id")), "agent_id": aid, "cause": "human_stop",
                    "by": renew.get("stop_requested_by")}
            _finish_run(api_base, w.get("run_id"), "killed", proc.returncode, w.get("log_path"),
                        diff, kill_reason=json.dumps(diag))
            _safe_teardown_worktree(w.get("base_cwd"), w.get("worktree"), w.get("branch"))
            _post_json(f"{api_base}/api/agents/{aid}/wake-ack",
                       {"kind": "worker_human_stopped", "release_lease": True, "lane": w_lane})
            _retire_headless(api_base, live_workers, aid)   # GH #91/#90: revoke token, then pop
            if not quiet:
                print(f"[notifier] worker for {aid} (pid {proc.pid}, run {w.get('run_id')}) "
                      f"STOPPED by {renew.get('stop_requested_by') or 'a human'} — "
                      f"graceful kill, worktree preserved if dirty, lease released")
            continue
        # still running — is it making progress? (per-wake log growing = alive)
        size = w.get("last_size", 0)
        lp = w.get("log_path")
        if lp:
            try:
                size = os.path.getsize(lp)
            except OSError:
                size = w.get("last_size", 0)
        if size > w.get("last_size", 0):
            w["last_size"] = size
            w["last_progress_ts"] = now
        stalled = (now - w.get("last_progress_ts", now)) > stall_secs
        over_cap = now > w.get("hard_deadline", now)
        if not (stalled or over_cap):
            continue                   # progressing (or within stall window) — let it work
        # GH#61: resolve the worker's OWN runtime up front — both the terminal-completion check
        # below and the liveness probe further down must read the worker's runtime schema. A Codex
        # worker's `codex exec --json` log carries none of the Claude stream-json signals, so a
        # runtime-blind read mis-classifies it. The runtime rides on respawn_ctx (set at spawn AND
        # carried through checkpoint-respawn).
        w_runtime = _normalize_runtime((w.get("respawn_ctx") or {}).get("model_runtime"))
        # ISS-29: a worker that already emitted a terminal `result` (Claude) / `turn.completed`
        # (Codex, GH#61 PR #80 review) has COMPLETED — the log stops growing at that line, so the
        # stall timer trips even though the work is done and the process is just slow to exit. Do
        # NOT reap it as 'killed' AND do NOT checkpoint-respawn it: a Codex worker's terminal turn
        # line is fresh growth (`not stalled`), which the checkpoint branch below would otherwise
        # treat as "still progressing" and respawn an already-finished worker (#80 review round 2).
        # Hold off here and let the next tick's proc.poll() catch a clean exit (reaped 'exited',
        # SessionEnd/C1 digest gets to run). Only force it down — still 'exited' — if it overruns a
        # generous graceful-exit window.
        rstatus = _terminal_status(w.get("log_path"), runtime=w_runtime)
        if rstatus is not None:
            seen = w.get("result_seen_ts")
            if seen is None:
                w["result_seen_ts"] = now
                if not quiet:
                    print(f"[notifier] worker for {aid} (pid {proc.pid}) completed "
                          f"(result={rstatus}) — awaiting clean exit so SessionEnd can run")
                continue
            if now - seen <= GRACEFUL_EXIT_SECS:
                continue               # within the graceful window — let it exit on its own
            _kill_worker(proc, graceful=True)   # SIGTERM (let teardown run) then SIGKILL
            diff = _capture_diff(w.get("worktree"))
            # PR #121 review blocker: a lingering worker whose terminal signal was a FAILURE (or a
            # rate-limited tail) must NOT be booked as a completed drain — that checkpoint-committed,
            # cleared the failed-drain counter and ADVANCED the cursor, silently skipping the retry.
            # Classify exactly like the clean-exit poll() path (safe post-kill: rstatus is non-None
            # here, so the classifier never falls back to the kill-signal returncode) and route a
            # rate_limited/failed TASK drain through the shared preserve+retry bookkeeping.
            drain_status = "exited"
            if w_runtime == RUNTIME_CODEX:
                drain_status = _codex_exit_status(w.get("log_path"), proc.returncode)
            if bool(w.get("task_worktree")) and drain_status in ("rate_limited", "failed"):
                _drain_task_failure(api_base, w, aid,
                                    (w.get("respawn_ctx") or {}).get("task_id"),
                                    drain_status, proc.returncode, diff,
                                    failed_drains=failed_drains,
                                    agent_hold_until=agent_hold_until, now=now, quiet=quiet,
                                    w_lane=w_lane, live_workers=live_workers, pid=proc.pid,
                                    drain_desc="completed-but-lingered, drained")
                continue
            exit_code = 0 if rstatus == "success" else proc.returncode
            _finish_run(api_base, w.get("run_id"), drain_status, exit_code, w.get("log_path"), diff)
            # GH#110: a COMPLETED task worker preserves its worktree exactly like the clean-exit
            # success path (checkpoint-commit + keep + saved_ref + digest; GH #58: the cursor
            # advances via ack-handled below); only a non-task ephemeral worker is torn down here.
            if bool(w.get("task_worktree")):
                task_id = (w.get("respawn_ctx") or {}).get("task_id")
                sha = _checkpoint_task_worktree(w.get("base_cwd"), w.get("worktree"),
                                                w.get("branch"), task_id, w.get("run_id"))
                failed_drains.pop((aid, task_id), None)
                if sha or (diff or "").strip():
                    saved = _saved_ref(w, sha, diff)
                    human = _saved_human_line(w.get("base_cwd"), w.get("branch"), sha)
                    _record_task_saved_ref(api_base, w, saved, human)
                    _synthesize_task_digest(api_base, aid, task_id, saved,
                                            w.get("started_ts"), human)
                _post_json(f"{api_base}/api/agents/{aid}/wake-ack",
                           {"delivered_ts": None,
                            "kind": "worker_completed_reaped", "release_lease": True,
                            "lane": w_lane})
            else:
                _teardown_worktree(w.get("base_cwd"), w.get("worktree"), w.get("branch"))
                _post_json(f"{api_base}/api/agents/{aid}/wake-ack",
                           {"kind": "worker_completed_reaped", "release_lease": True,
                            "lane": w_lane})
            # GH #58: same completion seam as the clean-poll exit above — a successful drain acks its
            # handled-set; a non-success (rstatus != success) marks nothing so the events re-surface.
            if exit_code == 0:
                _post_json(f"{api_base}/api/agents/{aid}/events/ack-handled",
                           {"event_ids": w.get("handled_event_ids") or []})
            _retire_headless(api_base, live_workers, aid)   # GH #91/#90: revoke token, then pop
            if not quiet:
                print(f"[notifier] worker for {aid} (pid {proc.pid}) completed but lingered "
                      f">{GRACEFUL_EXIT_SECS:.0f}s after result — reaped as exited")
            continue
        # ISS-45: a stalled-looking worker can be log-silent yet ALIVE — waiting on an in-flight
        # tool call (the `tool_use` is out but its `tool_result` only lands when the subprocess
        # returns) or backing off on a rate limit. Compute liveness ONCE here; reused by the
        # exemption, the checkpoint gate, and the kill diagnostic below. The probe reads the
        # worker's OWN runtime (w_runtime, resolved above) — a runtime-blind probe would read an
        # alive-but-silent Codex worker as dead and hard-kill it past the cap (GH#61).
        is_live = _worker_is_live(w.get("log_path"), runtime=w_runtime)
        # Under the soft cap a log-silent-but-live worker is simply LEFT ALONE — don't STALL-kill it:
        # that SIGKILLed legitimately-working workers mid-task, losing the result + the C1 digest.
        if stalled and not over_cap and is_live:
            if not quiet:
                print(f"[notifier] worker for {aid} (pid {proc.pid}) log-silent but ALIVE "
                      f"(in-flight tool / rate-limit backoff) — not stall-killing")
            continue
        # CHECKPOINT-and-respawn (graceful snapshot → C1 digest → fresh worker on the SAME worktree),
        # bounded by HARD_CAP_RESPAWN_MAX, for a past-cap worker that is NOT a runaway:
        #   * ISS-76 (#194): still GROWING (`not stalled`; the only way that survives the early
        #     `if not (stalled or over_cap): continue` is `over_cap`) — a genuine long task; OR
        #   * GH#49: STALLED but PROVABLY ALIVE past the cap (`over_cap and is_live`) — log-silent on
        #     a long EXTERNAL job (e.g. a 16-min `xcodebuild test`) holding an unanswered tool_use.
        #     The old code hard-killed exactly this case mid-run, losing the C1 digest and leaving
        #     the successor to restart the whole suite from zero. Checkpointing preserves the digest
        #     (so the successor learns a run was in flight) while the respawn budget still caps a
        #     genuinely-hung in-flight tool — past HARD_CAP_RESPAWN_MAX it falls through to the kill.
        respawnable = bool(w.get("respawn_ctx")) and w.get("respawns", 0) < HARD_CAP_RESPAWN_MAX
        if respawnable and (not stalled or (over_cap and is_live)):
            _checkpoint_and_respawn(api_base, aid, w, live_workers, quiet)
            continue
        # genuinely stalled, or the hard-cap backstop tripped → kill. ISS-45: GRACEFUL (SIGTERM
        # + a short grace window) so claude's SessionEnd hook (the C1 digest) runs BEFORE
        # SIGKILL — even a legit watchdog kill must not lose what the worker did.
        #
        # #270 (residual of #251): build the kill DIAGNOSTIC from the log tail BEFORE the kill (the
        # tail still reflects what the worker was doing) — enough to explain why _worker_is_live
        # returned false: the ids, how long it was log-silent, whether the hard cap tripped, the
        # liveness verdict, and the last stream-json event type. It is persisted as the run's
        # structured kill_reason AND logged at kill time.
        lp = w.get("log_path")
        lpts = w.get("last_progress_ts")
        diag = {
            "run_id": str(w.get("run_id")) if w.get("run_id") else None,
            "agent_id": aid,
            "cause": "stalled" if (stalled and not over_cap) else "hard_cap",
            "stall_secs": round(now - lpts, 1) if lpts else None,
            "stall_threshold": stall_secs,
            "last_progress_ts": lpts,
            "over_cap": over_cap,
            "worker_is_live": is_live,
            "runtime": w_runtime,            # GH#61: which liveness schema the probe applied
            "last_event_type": _last_event_type(lp),
        }
        _kill_worker(proc, graceful=True)
        diff = _capture_diff(w.get("worktree"))
        _finish_run(api_base, w.get("run_id"), "killed", proc.returncode, lp, diff,
                    kill_reason=json.dumps(diag))
        # #270: PRESERVE the killed worker's worktree if it has uncommitted work — a stall/cap kill
        # is exactly when the in-progress diff is the only record of what it was doing, so don't
        # force-discard it; only a CLEAN worktree is torn down. Mirrors the embodiment path
        # (_safe_teardown_worktree); the preserved path is logged so a human can find it.
        disp = _safe_teardown_worktree(w.get("base_cwd"), w.get("worktree"), w.get("branch"))
        kind = "worker_stalled_killed" if (stalled and not over_cap) else "worker_timeout_killed"
        # GH#36 backstop: a NO-OP ephemeral worker (no task attributed AND no uncommitted work) that
        # stalls into a watchdog kill must not leave its trigger un-acked — re-assert the cursor
        # advance to the trigger ts this boot consumed so the SAME wake can't re-arm into another
        # empty-inbox boot→stall→kill cycle (the spawn-time ack already set it; this is the idempotent
        # safety net for a transient ack failure). A worker that DID make progress (a task wake or a
        # dirty diff) leaves the cursor ALONE: its work isn't finished, so it must be free to re-wake.
        kill_ack = {"kind": kind, "release_lease": True, "lane": w_lane}
        if not w.get("wake_task_id") and not (diff or "").strip() and w.get("wake_ack_ts") is not None:
            kill_ack["delivered_ts"] = w.get("wake_ack_ts")
        _post_json(f"{api_base}/api/agents/{aid}/wake-ack", kill_ack)
        _retire_headless(api_base, live_workers, aid)   # GH #91/#90: revoke token, then pop
        # #270: emit the kill diagnostic AT KILL TIME, unconditionally — a watchdog kill is a rare,
        # important event and this line is the whole on-host record of WHY it fired.
        print(f"[notifier] WATCHDOG KILL {aid} (pid {proc.pid}) — gracefully KILLED "
              f"(SIGTERM→SIGKILL): {json.dumps(diag)}")
        if disp == "preserved-dirty":
            print(f"[notifier] preserved dirty worktree of killed worker {aid}: {w.get('worktree')}")


# ISS-31: a generous FLOOR for the worker hard cap (single-flight lease + watchdog backstop),
# decoupled from lease_ttl. Even a stale 300s lease_ttl can't lower the cap below this, so a
# still-progressing worker is never SIGKILLed at 300s — stall_secs is the primary kill, the cap
# only catches true runaways. The daemon's worker may legitimately run for many minutes (cold
# start + long tool calls).
HARD_CAP_MIN_SECS = 1200.0

# ISS-76 (#194): the hard cap above is now a SOFT, checkpoint-respawn trigger — NOT a kill — for
# a worker that is STILL PROGRESSING (its stream-json log is still growing) when it crosses the
# cap. Such a worker is a genuine long task, not a runaway; the old code SIGKILLed it mid-flight,
# losing the work. Instead reap_workers gracefully checkpoints it (SessionEnd → C1 digest) and
# respawns a FRESH worker on the SAME worktree so the task continues with a clean context window
# + the just-written digest. This bounds how many times one task may roll over the cap before it
# is treated as a runaway and reaped — the preserved hard-cap backstop. GH#49: a STALLED but
# PROVABLY-ALIVE worker past the cap (log-silent on a long external job, holding an unanswered
# tool_use) is checkpoint-respawned too, under the same budget — only a stalled worker that is NOT
# live (no in-flight tool / rate-limit backoff) is killed outright.
HARD_CAP_RESPAWN_MAX = 3

# Wake-latency fix: the single-flight LEASE is now decoupled from the hard cap. The daemon
# claims a SHORT lease and RENEWS it every tick while its worker is alive (reap_workers). So a
# legitimately long worker keeps single-flight, but a crashed/orphaned worker's lease expires
# within this window instead of squatting for the full 1200s hard-cap — which is what starved a
# fresh high-priority event for minutes. Renew interval (the tick) must stay well under this.
WAKE_LEASE_TTL_SECS = 180.0


def reap_orphan_leases(api_base: str, cid: str, quiet: bool) -> None:
    """Compatibility facade for stale single-flight lease cleanup."""
    _orphan_cleanup.reap_orphan_leases(
        api_base, cid, quiet, sys.modules[__name__]
    )


def reap_orphaned_runs(api_base: str, cid: str, live_pids=frozenset(),
                       *, quiet: bool = True) -> int:
    """Compatibility facade for dead-pid run reconciliation."""
    return _orphan_cleanup.reap_orphaned_runs(
        api_base,
        cid,
        live_pids,
        quiet=quiet,
        services=sys.modules[__name__],
    )


# GH#110 §2c: a task's terminal states. A durable per-(agent+task) worktree is preserved across
# wakes precisely so a worker resumes prior state; once the task reaches one of these, nothing will
# resume it, so the worktree/branch must be reclaimed (else orcha/task-* trees accumulate forever).
# `verified` collapses to `completed` in this schema (POST /verify approve → status='completed'),
# so the two stored terminal statuses are completed + cancelled.
_TERMINAL_TASK_STATES = ("completed", "cancelled")
# PR #121 R3: the terminal-worktree sweep must PAGINATE (the list endpoint clamps limit→100).
# Terminal tasks are never deleted, so a container accrues them without bound (this one already
# has 98 completed + 39 cancelled). A page cap is a pure runaway backstop — 200 pages = 20k
# terminal tasks of one status, far beyond any real container — never a functional limit; if a
# container ever exceeds it the oldest already-swept pages are simply skipped by swept_tasks.
_TERMINAL_SWEEP_MAX_PAGES = 200
_TERMINAL_SWEEP_PAGE_SIZE = 100


def reap_terminal_task_worktrees(api_base: str, cid: str, base_cwd: Optional[str],
                                 live_workers: dict, swept_tasks: set, quiet: bool,
                                 failed_drains: Optional[dict] = None) -> int:
    """GH#110 §2c: reclaim a durable per-(agent+task) worktree once its task is TERMINAL.

    The clean-exit/rate-limit paths PRESERVE a task worktree so the next same-(agent+task) wake
    resumes prior state. Nothing tears it down while the task is live — correct. But once the task
    is completed/cancelled, nothing will ever resume it, so without this sweep every `orcha/task-*`
    worktree + branch would live forever (the exact "teardown half doesn't exist" gap PR #121's
    first review caught). CONSERVATIVE by construction — it never risks losing work:
      * skips a worktree still tracked in `live_workers` (an in-flight worker still holds it);
      * PRESERVES a DIRTY tree (uncommitted work is never discarded — _reclaim_task_worktree
        removes only a worktree that is CLEAN after excluding the overlaid runtime config);
      * deletes the branch ONLY when it has no commits beyond origin/main (via _teardown_worktree's
        has-commits guard) — a committed / open-PR branch is KEPT, since a branch with an open PR
        necessarily carries commits beyond main, so the has-commits guard already means "no open
        PR captured the work" without shelling out to `gh`.
    `swept_tasks` is a DAEMON-SCOPE set so each terminal task is processed at most once (a daemon
    restart re-scans, but a safe_teardown of an already-gone worktree is a cheap noop). Reads the
    run rows (§2d recorded worktree/branch/base_cwd there) to map a task → its worktree without
    reversing the on-disk slug. Best-effort: any error is swallowed so cleanup never takes down the
    daemon loop. Returns the number of worktrees removed this pass."""
    return _orphan_cleanup.reap_terminal_task_worktrees(
        api_base,
        cid,
        base_cwd,
        live_workers,
        swept_tasks,
        quiet,
        failed_drains,
        sys.modules[__name__],
    )


# ISS-29: once a worker has emitted its terminal `result`, the agent loop is DONE — but the
# process can linger before exiting on long headless sessions. Give it this generous window
# (from when `result` was first seen) to exit on its own so SessionEnd (the C1 digest) runs;
# only force it down after, and even then record `exited` — the work completed.
GRACEFUL_EXIT_SECS = 180.0

# E3: a resident conversation session stays WARM between turns (the whole point — warm context,
# no re-boot cost per turn). When no new human turn has arrived for this long, the manager
# closes stdin (graceful EOF → claude exits, SessionEnd/C1 runs), ends the conversation, and
# releases the resident embodiment lease — freeing the agent for ephemeral wakes again. A later
# human turn re-opens a fresh resident and --resume's the pinned session_id (warm-ish restart).
# #247 B3 (§5.1): widened 900→1200s so the WARM-ZONE hold matches the heartbeat/lease cadence
# (HARD_CAP_MIN_SECS / lease_ttl) — a human who steps away for a poll cycle returns to a warm
# session, not a cold re-boot. Named constant, not a per-tick knob (Kedar §10-Q2 ruling).
RESIDENT_IDLE_REAP_SECS = 1200.0
RESUME_FAIL_WINDOW_SECS = 20.0           # ISS-61: a warm boot that dies this fast = a bad --resume
# ISS-78 (A2): forward-progress backstop for the resident inbox-drain YIELD. ISS-74 used to drain the
# non-conversation inbox INTO the warm session (the ISS-78 context-bleed); A2 instead idle-YIELDS the
# lease so an ephemeral worker drains the backlog in its own session. As defense-in-depth (and carrying
# forward the ISS-75/#188 anti-runaway guard) the daemon refuses to yield AGAIN when the inbox high-
# water mark (inbox_ack_ts) has NOT advanced past the last yield's within this window — so a stuck/echo
# event the ephemeral drain can't ack away can't thrash teardown→warm-resume every cycle. A genuinely
# NEW event (higher inbox_ack_ts) always yields immediately; only a stalled/echo repeat is throttled.
RESIDENT_DRAIN_COOLDOWN_SECS = 60.0
# GH #91/#90 (R2-1 / R3-4): the lanes split retires the resident-side WORK teardown. Non-conversation
# inbox + clock auto-wake now drive the WORK lane independently through wake_scan (its own work lease +
# work worker_run), so a warm resident must NOT tear down its (conversation) lease to let an ephemeral
# do that work — the two lanes coexist now. This flag gates BOTH the drain-sidecar spawn and the two
# work-yield branches (inbox_drain_yield, auto_wake_yield) OFF by default; conversation delivery + the
# pure idle-reap are untouched. Kept as a flag (not a hard delete) so the old behavior can be restored
# if the work lane's independent wake regresses in the field. See the plan's R2-1 and R3-4 sections.
RESIDENT_WORK_TEARDOWN_ENABLED = False
# ISS-78: per-conversation yield bookkeeping for the backstop above — {conv_id: (inbox_ack_ts, ts)}.
# Module-level (not on the resident dict) because the resident is destroyed when it yields; this is how
# the next boot's idle tick remembers the last yield's high-water mark. Cleared on conversation end.
_RESIDENT_DRAIN_YIELD: dict = {}
# ISS-61 cold-fallback: conversations whose last WARM (--resume) boot crashed fast (a session
# claude couldn't resume). The next boot for these forces COLD (ignore the pinned session); cleared
# on a successful cold boot. Daemon-process in-memory state (like live_residents).
_RESIDENT_RESUME_FAILED = set()
# #286 Codex resume fail-open: conversations whose last `codex exec resume <sid>` worker exited
# WITHOUT producing a reply (a bad session id / unresumable rollout / wrong flag spelling). The next
# Codex turn for these forces COLD full-history injection so the human never sees a broken turn —
# bounded to ONE cold retry (cleared on the next successful reply or conversation end). Daemon-
# process in-memory state, sibling to _RESIDENT_RESUME_FAILED.
_CODEX_RESUME_FAILED = set()


def tick(api_base: str, cid: str, *, dry_run: bool, cooldown: float,
         min_idle: float, quiet: bool, lease_ttl: float = 1200.0,
         live_workers: Optional[dict] = None, base_cwd: Optional[str] = None,
         agent_hold_until: Optional[dict] = None) -> dict:
    """One scan-and-wake pass. Returns a summary dict (also used by tests).

    `live_workers` (daemon-loop state, {agent_id: pid}) is updated with each ephemeral
    worker spawned so `reap_workers` can release its lease on exit. `base_cwd` is the daemon's
    project dir, used to auto-record reachability for portal-created agents (see below).

    GH#110: `agent_hold_until` {agent_id: float} is the daemon-scope rate-limit hold-down that
    reap_workers writes on a Codex 429 drain; this loop SKIPS a still-held agent as a wake
    candidate (client-side, no API change) so a rate-limited worker isn't re-woken on cooldown
    cadence and burning the retry budget. None (tests/--once) means no holds are active."""
    if agent_hold_until is None:
        agent_hold_until = {}
    scan = _get_json(
        f"{api_base}/api/containers/{cid}/wake-scan?cooldown={cooldown}&min_idle={min_idle}"
    )
    if scan is None:
        if not quiet:
            print("[notifier] wake-scan unreachable (is the stack up?)", file=sys.stderr)
        return {"ok": False, "woke": [], "error": "scan_unreachable"}

    if not scan.get("active"):
        if not quiet:
            print(f"[notifier] container {scan.get('container_status')} — wakes suppressed")
        return {"ok": True, "woke": [], "suppressed": scan.get("container_status")}

    # Portal-first reachability backfill. A PORTAL-created agent (onboarding O2) has NO
    # agent_reachability row, so the daemon has nowhere to spawn it — it can't be woken by
    # ANYTHING (task-thread message, decision, or prompt), which breaks the portal-first premise
    # (you create the agent in the portal but it's unwakeable). The portal runs in a container and
    # can't know the HOST cwd; the daemon does. So auto-record headless_cwd = the daemon's project
    # dir for any wake_enabled agent that is otherwise unreachable (no headless_cwd AND no tmux
    # pane). Extends the Epic A "wakeable turnkey" auto-reachability to portal-created agents.
    # Idempotent + self-limiting: once the row exists the next scan returns headless_cwd, so no
    # repeat POSTs. Respects a human's wake_enabled=false opt-out — we only send headless_cwd
    # (the partial upsert leaves wake_enabled untouched) and skip agents that aren't wake_enabled.
    if base_cwd and not dry_run:
        for cand in scan.get("candidates", []):
            if not cand.get("wake_enabled"):
                continue
            if not cand.get("headless_cwd") and not cand.get("tmux_target"):
                r = _post_json(f"{api_base}/api/agents/{cand['agent_id']}/reachability",
                               {"headless_cwd": base_cwd})
                if r and r.get("headless_cwd"):
                    cand["headless_cwd"] = r["headless_cwd"]   # spawnable THIS tick, no extra latency
                    if not quiet:
                        print(f"[notifier] auto-recorded reachability for {cand.get('alias')} "
                              f"(headless_cwd={base_cwd}) — portal-created agent now wakeable")
            # #254 binding backfill: reachability makes the agent SPAWNABLE, but the spawned
            # worker still needs `.claude/orcha-tabs/<alias>.json` to resolve its own alias→
            # agent_id in every `/orcha-*` skill. Seed it host-side (write-if-absent), keyed on
            # file-absence (inside the helper) NOT on headless_cwd — so it also heals a
            # reachable-but-unbound agent. The overlay then copies it into the worktree.
            if _seed_tab_binding(base_cwd, cand.get("alias"), cand.get("agent_id"), cid):
                if not quiet:
                    print(f"[notifier] seeded tab binding for {cand.get('alias')} "
                          f"(.claude/orcha-tabs/{cand.get('alias')}.json) — portal-created agent now resolvable")

    woke = []
    # #294: the per-container 'triage' model override the server resolved for this scan (None =>
    # #290's shipped default). Bind it into the triage_fn so #288 wake-suppression triages with the
    # CONFIGURED model — the efficiency hook (tune what an event costs to evaluate). Container-wide,
    # so it's resolved once per scan, not per candidate.
    _triage_config = _triage_config_from_scan(scan)
    # Unseal the per-provider triage key the portal carried (sealed) on the scan, so triage runs on
    # the Settings-stored key for the configured provider (e.g. xAI). None ⇒ llm_util env fallback.
    _triage_key = _unseal_scan_key(scan, "triage_key_enc")
    _scan_triage_fn = (lambda text: _triage_wake(text, config=_triage_config, api_key=_triage_key))
    # #307 graded-wake: the per-container 'ack' model override (None => #290 Haiku default) + the
    # container autonomy gate, resolved once per scan. T2 cheap-acts ONLY at autonomy_level='full';
    # at the default the daemon logs the would-be saving (#284) and full-boots — no behaviour change.
    _ack_config = _ack_config_from_scan(scan)
    _ack_key = _unseal_scan_key(scan, "ack_key_enc")
    _autonomy_level = scan.get("autonomy_level")
    _t2_enabled = (_autonomy_level == "full")
    _hold_now = time.time()
    for cand in scan.get("candidates", []):
        if not cand.get("should_wake"):
            continue
        # GH#110: a Codex worker that drained on a 429 recorded a rate-limit hold on its agent;
        # skip re-waking it until the cooldown elapses (client-side, no server change). Drop the
        # key once it lapses so the agent is a normal candidate again.
        hold = agent_hold_until.get(cand.get("agent_id"))
        if hold is not None:
            if _hold_now < hold:
                if not quiet:
                    print(f"[notifier] skip {cand.get('alias')} — rate-limit hold-down "
                          f"({hold - _hold_now:.0f}s left)")
                continue
            agent_hold_until.pop(cand.get("agent_id"), None)
        prompt = build_wake_prompt(cand)
        kind = select_transport(cand)
        event = derive_wake_event(cand)
        resume_rendered = False
        ephemeral_lane = "work"   # GH #91/#90 (PR R5): every scan_and_wake wake is WORK-lane — the
                                  # scan's pending count runs against the work cursor, so the ack
                                  # must advance that same cursor (tmux/unreachable included).
        # #288 wake-suppression: a NO-ACTION ephemeral wake (a bare FYI / pure-ack answer) costs a
        # full subprocess spawn for zero work. Gate ONLY the ephemeral spawn — resident/tmux wakes
        # are cheap (a prompt to a live pane) and are NEVER gated. The decision (server-provided
        # triage_hint + this fail-open verdict) lives in decide_wake_suppression; on suppress we
        # auto-close the answered request, advance the cursor, and skip the spawn entirely. --once
        # skips it too (dry_run/no-spawn paths never suppress, so a manual `tick --once` always wakes).
        if kind == "ephemeral" and not dry_run:
            # #307 graded wake: ONE grading decides the cheapest sufficient substrate. structural/
            # llm => #288 suppress (no spawn); act => T2 cheap handoff (gated on autonomy); full =>
            # the spawn below. decide_wake_tier is a superset of decide_wake_suppression and makes a
            # SINGLE triage call, so the #288 path is byte-identical and never double-charged.
            verdict = decide_wake_tier(cand, triage_fn=_scan_triage_fn)
            tier = verdict.get("tier")
            if tier in ("structural", "llm"):
                _suppress_wake(api_base, cand, event, verdict, quiet=quiet)
                woke.append({"agent_id": cand["agent_id"], "alias": cand["alias"],
                             "kind": "skipped", "sent": False,
                             "command": f"suppressed ({tier}): {verdict.get('reason', '')}",
                             "reason": cand["reason"], "pending_events": cand.get("pending_events"),
                             "auto_start_task_ids": cand.get("auto_start_task_ids"),
                             "event": event, "suppressed": tier})
                if not quiet:
                    print(f"[notifier] suppressed wake for {cand['alias']} "
                          f"({tier}: {verdict.get('reason', '')}) — no spawn")
                continue
            if tier == "act":
                # T2 cheap-act rung. Complete the routine handoff ONLY when the container opted into
                # full autonomy; otherwise LOG the would-be saving (#284) and fall through to the
                # full boot, so prod behaviour is byte-identical until full autonomy is chosen.
                acted = (_apply_wake_act(api_base, cand, event, verdict,
                                         quiet=quiet, ack_config=_ack_config, ack_api_key=_ack_key)
                         if _t2_enabled else False)
                _log_graded_wake(verdict, _autonomy_level, acted)
                if acted:
                    woke.append({"agent_id": cand["agent_id"], "alias": cand["alias"],
                                 "kind": "skipped", "sent": False,
                                 "command": f"acted (T2 {verdict.get('action')}) — no spawn",
                                 "reason": cand["reason"], "pending_events": cand.get("pending_events"),
                                 "auto_start_task_ids": cand.get("auto_start_task_ids"),
                                 "event": event, "suppressed": "act"})
                    if not quiet:
                        print(f"[notifier] T2 cheap-act for {cand['alias']} "
                              f"({verdict.get('action')}) — no spawn")
                    continue
                # not acted (gate closed, model declined, or write failed) → full boot below.
        if kind == "tmux":
            sent, cmd = send_tmux(cand["tmux_target"], prompt, dry_run)
        elif kind == "ephemeral":
            # ISS-31: the worker hard cap (single-flight lease + watchdog backstop) is
            # DECOUPLED from lease_ttl and floored at a generous HARD_CAP_MIN_SECS, so a small
            # lease_ttl (e.g. a stale 300s daemon launch) can NEVER set the cap low enough to
            # SIGKILL a still-progressing worker — stall (stall_secs) is the primary kill. In
            # --once (no watchdog/reaper) the lease stays short (lease_ttl, already capped).
            cap = max(lease_ttl, HARD_CAP_MIN_SECS) if live_workers is not None else lease_ttl
            # Wake-latency fix: the single-flight LEASE is short + renewed each tick (daemon
            # loop), NOT the 1200s cap — so a crashed worker's lease can't starve a fresh event.
            # --once has no reaper to renew, so it keeps its own (already-short) lease and lets
            # it expire. The watchdog hard cap (`cap`) is unchanged and lives on hard_deadline.
            claim_ttl = WAKE_LEASE_TTL_SECS if live_workers is not None else cap
            # GH #91/#90 (PR R5): a tick ephemeral is ALWAYS the WORK lane. Every scan candidate is
            # driven by the WORK pending count (wake_scan counts events past `delivered_ts`, with
            # bare `conversation_turn` filtered out), so this wake's ack MUST advance the WORK
            # cursor — an earlier revision routed taskless drain wakes (info requests, answered
            # notifications, nudges, clock auto-wakes) to the conversation lane, whose ack advances
            # only `conv_delivered_ts`; the driving events never left the work pending count and the
            # daemon respawned a no-op worker forever. The conversation lane belongs exclusively to
            # genuine chat embodiments (the Claude warm resident / Codex per-turn conversation
            # runner, both spawned by service_residents), never to a scan_and_wake ephemeral.
            ephemeral_lane = "work"
            # R2.4 single-flight: win an exclusive, TTL-bounded lease BEFORE spawning.
            # If we don't win, a worker is already live for this agent (or the global
            # kill-switch is off) — skip without spawning and without touching the
            # cursor (the live worker drains + acks). This is the runaway fix.
            if not dry_run:
                claim = _post_json(
                    f"{api_base}/api/agents/{cand['agent_id']}/wake-claim",
                    {"lease_ttl": claim_ttl, "kind": "ephemeral", "event": event,
                     "lane": ephemeral_lane})
                if not (claim and claim.get("claimed")):
                    why = (claim or {}).get("reason", "claim failed (unreachable)")
                    if not quiet:
                        print(f"[notifier] skip {cand['alias']} — single-flight: {why}")
                    continue
            # Boot the headless worker AS the agent: inject persona + latest digest
            # (--append-system-prompt) and ORCHA_ALIAS, so it answers with the agent's
            # judgment + reasoning continuity, not as a generic Claude.
            # GH #56 (Point 3 / FLAG 2a part d): pass the wake's originating-task hint so the injected
            # protocol is that task's (the link), not a guess at the agent's one in_progress task.
            # GH #58 (R2 fix): the task THIS run is bound to — persona/protocol, run attribution, and
            # the drain all key off ONE value. Prefer the server's context_task_id (the task /orcha-next
            # will claim — auto_start[0] — else the directed wake_task_id); recompute that same formula
            # locally only for version skew where an older server didn't send it. wake_task_id ALONE
            # was the bug: it can be a DIFFERENT in_progress task A while the run claims ready task B,
            # booting B's worker under A's protocol and attributing the run to A.
            auto = cand.get("auto_start_task_ids") or []
            run_task_id = cand.get("context_task_id") or (auto[0] if auto else cand.get("wake_task_id"))
            if dry_run:
                persona = None
            else:
                _persona_result = _build_persona(
                    api_base, cand["agent_id"], task_id=run_task_id,
                    self_wake={"injected": cand.get("self_wake_injected"),
                               "task_id": cand.get("self_wake_task_id")},
                    return_resume_rendered=True)
                if isinstance(_persona_result, tuple):
                    persona, resume_rendered = _persona_result
                else:
                    persona, resume_rendered = _persona_result, False
            log_path = None
            hc = cand.get("headless_cwd")
            if hc and not dry_run:
                # Per-wake log lives under the BASE checkout (outside any worktree) so it
                # survives worktree teardown and A2 output-capture still works.
                log_path = (pathlib.Path(hc) / ".claude" / ".orcha-wakes"
                            / f"{cand.get('alias', 'agent')}-{int(time.time())}.log")
            # ISS-8 / ISS-8.1: code-touching wakes run in an ISOLATED git worktree off
            # origin/main so concurrent workers don't tangle the shared checkout. The worker
            # drains its WHOLE backlog, but wake-scan only exposes the NEWEST event name +
            # a pending count — so we can't see a task event hidden behind a newer request.
            # Be conservative: only SKIP the worktree when it's provably no-code — no ready
            # auto-start target AND a single pending event whose (known) name is pure
            # request-answer / note. Anything else (a task wake, or a multi-event backlog
            # that might hide one) gets isolated (ISS-8.1-b). Pure single-request wakes still
            # skip to save the ~200-500ms + disk. Only the daemon loop (live_workers present)
            # provisions — it alone can reap + tear down; --once has no reaper.
            # request_created is published for BOTH info AND task requests (the payload's
            # `type` distinguishes them, but wake-scan only exposes the event NAME) — and a
            # task-request, once accepted, spawns an in_progress task + code work. So it is
            # NOT skip-safe. Only an incoming answer/close to one of our own asks is
            # confidently no-code.
            # PR #132 review [P1]: `task_message` is NO LONGER on the no-code fast path. ISS-55
            # made task-thread notes actionable — the worker is told to read that task's thread
            # and respond, which can mean real code edits (e.g. a "please rebase onto main" note).
            # Running that in the shared `headless_cwd` would bypass ISS-8 isolation and collide
            # with other workers. So a task-thread resume gets a worktree like any task work —
            # keyed off `wake_task_id` (set whenever a task_message is surfaced), which also
            # catches a task_message hidden behind a newer event in a multi-event backlog.
            _NONCODE = ("request_answered", "request_closed")
            _single_noncode = ((cand.get("pending_events") or 0) <= 1
                               and cand.get("latest_event") in _NONCODE)
            is_code_wake = bool(auto) or bool(cand.get("wake_task_id")) or not _single_noncode
            # GH#110: a code wake that is LINKED to a task gets the DURABLE per-(agent+task)
            # worktree so uncommitted work survives a clean exit and the next same-task wake
            # resumes from it; a code wake with no task id keeps the disposable ephemeral worktree.
            wt_task_id = (auto[0] if auto else cand.get("wake_task_id"))
            worktree = branch = None
            task_worktree = False
            if is_code_wake and hc and not dry_run and live_workers is not None:
                if wt_task_id:
                    worktree, branch = _provision_task_worktree(hc, cand.get("alias"), wt_task_id)
                    task_worktree = worktree is not None
                if worktree is None:            # no task id, or task-worktree provisioning failed
                    worktree, branch = _provision_worktree(hc, cand.get("alias"))
            run_cwd = worktree or hc
            # GH #91/#90: mint the process-scoped embodiment token BEFORE Popen so it is valid in the
            # DB before the worker's first gated call. Lane per the resolver above; kind 'headless'.
            # dry_run never mints (no process). A mint failure returns None → the worker spawns
            # token-less (degraded), never blocked.
            ephemeral_tok = None if dry_run else _mint_embodiment_token(
                api_base, cand["agent_id"], ephemeral_lane, "headless")
            sent, cmd, proc = spawn_headless(run_cwd, prompt,
                                       cand.get("headless_flags"), dry_run,
                                       alias=cand.get("alias"), system_prompt=persona,
                                       model=cand.get("model"),
                                       reasoning_effort=cand.get("reasoning_effort"),
                                       runtime=cand.get("model_runtime"),
                                       log_path=log_path, run_token=ephemeral_tok,
                                       conversation=(ephemeral_lane == "conversation"))
            if sent and proc is not None and live_workers is not None:
                # ISS-8.2: record a worker_run for every DAEMON-LOOP headless spawn (incl.
                # event-wakes — the 18:15 invisible-worker gap) so reap can finish it with
                # output + git diff; a failed POST is LOGGED, not swallowed. (--once has no
                # reaper to /finish a run, so it deliberately does NOT record one — a perpetual
                # status=running row with no output/diff would be worse than none.)
                # ISS-56: attribute the run to a task so it shows in that task's worker feed.
                # Prefer an auto-start target; else fall back to the triggering event's task
                # (e.g. a `task_message` wake) — without this an event-wake recorded task_id=NULL
                # and the run was invisible in the thread it was answering.
                run = _post_json(f"{api_base}/api/agents/{cand['agent_id']}/runs",
                                 {"wake_kind": "ephemeral", "wake_event": event,
                                  # GH #58 (R2): attribute the run to the SAME context task the persona
                                  # + drain keyed off (run_task_id).
                                  "task_id": run_task_id,
                                  "log_path": str(log_path) if log_path else None,
                                  "pid": getattr(proc, "pid", None),
                                  "runtime": cand.get("model_runtime"),
                                  "worktree": worktree, "branch": branch, "base_cwd": hc,
                                  # GH #91/#90: stamp the run's lane + bind the minted token so the
                                  # server durably revokes it on this run's terminal transition.
                                  "lane": ephemeral_lane, "token_id": ephemeral_tok})
                run_id = (run or {}).get("run_id")
                if not run_id and not quiet:
                    print(f"[notifier] WARN: worker_run NOT recorded for {cand.get('alias')} "
                          f"— POST /runs failed (returned {run!r}); the worker is running unseen",
                          file=sys.stderr)
                live_workers[cand["agent_id"]] = {
                    "proc": proc,
                    # ISS-31: the watchdog kills on STALL (no log growth), not at a fixed
                    # deadline; hard_deadline is just the crash-safe backstop — `cap` (a
                    # generous floor, decoupled from lease_ttl) so a slow-but-progressing
                    # worker is NEVER reaped at 300s mid-work.
                    "hard_deadline": time.time() + cap,
                    "last_size": 0, "last_progress_ts": time.time(),
                    "run_id": run_id, "log_path": log_path,
                    "worktree": worktree, "branch": branch, "base_cwd": hc,
                    # GH#110: a DURABLE task worktree is preserved (checkpoint-committed + kept) on
                    # a clean exit instead of torn down; started_ts guards the digest-clobber check.
                    # GH #58 (R5): the pending_ack_ts stash is RETIRED — a successful drain
                    # advances via /events/ack-handled, and the FAILED_DRAIN_MAX backstop
                    # force-advances to wake_ack_ts (below), its bounded-release cursor.
                    "task_worktree": task_worktree, "started_ts": time.time(),
                    "agent_id": cand["agent_id"],
                    # ISS-39: per-worker cursor for streaming stream-json lines into the DB
                    "lines_offset": 0, "lines_seq": 1, "lines_buf": b"",
                    # ISS-76: everything reap_workers needs to CHECKPOINT-RESPAWN this worker on
                    # the same worktree if it's still progressing when it crosses the soft cap.
                    "cap": cap, "respawns": 0,
                    # GH#36: the trigger this boot consumed — so a NO-OP stall/cap kill (no task
                    # attributed AND no uncommitted diff) can re-assert the cursor advance to this
                    # ts and never re-arm the SAME wake into another empty-inbox boot→stall→kill.
                    # GH #58 (R5): wake_ack_ts is ALSO the bounded-release cursor
                    # _drain_task_failure force-advances to when FAILED_DRAIN_MAX is hit.
                    "wake_event": event,
                    "wake_task_id": auto[0] if auto else cand.get("wake_task_id"),
                    "wake_ack_ts": (cand.get("ack_through_ts")
                                    if cand.get("ack_through_ts") is not None
                                    else cand.get("max_event_ts")),
                    # [P2 #218] carry the resolved model: the replacement worker must come up
                    # on the agent's model, not claude's default (per-agent contract, #202)
                    # GH #58: the per-event handled-set wake-scan computed for THIS run (FYI +
                    # taskless + its context-task's task_bound rows). Posted to /events/ack-handled
                    # only on a CLEAN exit (reap_workers) — a crash marks nothing, so the events
                    # re-surface (no loss). Carried in respawn_ctx so a checkpoint-respawn keeps it.
                    "handled_event_ids": cand.get("handled_event_ids") or [],
                    "respawn_ctx": {"prompt": prompt, "flags": cand.get("headless_flags"),
                                    "alias": cand.get("alias"),
                                    "model": cand.get("model"),
                                    "reasoning_effort": cand.get("reasoning_effort"),  # GH #51
                                    "model_runtime": cand.get("model_runtime"),
                                    # GH #58 (R2 fix): run_task_id, not a re-derived auto[0]/wake_task_id
                                    # — same one-value-everywhere fix as the persona build above.
                                    "task_id": run_task_id,
                                    # GH#110: carry the task-worktree flag through a checkpoint-
                                    # respawn so the respawned worker is still preserved on exit.
                                    "task_worktree": task_worktree,
                                    # GH #58: also carried in respawn_ctx (belt-and-suspenders with
                                    # the top-level key above) since the checkpoint-respawn path
                                    # reads ctx.get("handled_event_ids") first.
                                    "handled_event_ids": cand.get("handled_event_ids") or [],
                                    "event": event},
                    # GH #91/#90: track the token so _retire_headless revokes it on teardown. Stored
                    # even when POST /runs came back falsy ("running unseen") — the worker still holds
                    # the token, so it must still be revoked when later reaped.
                    "run_token": ephemeral_tok,
                    # GH #91/#90 (PR R5): the lane this worker's lease lives on. reap_workers reads
                    # it for every renew/release so the reaper is structurally lane-correct. Today
                    # this is always 'work' (tick ephemerals are work-lane by construction, and
                    # conversation embodiments are tracked in live_residents, not here) — which is
                    # also why keying live_workers by agent_id alone stays sound: one work-lane
                    # worker per agent is exactly the work lane's single-flight invariant.
                    "lane": ephemeral_lane}
            elif worktree and not sent:
                # spawn failed after we made a worktree — clean it up (no orphan)
                _teardown_worktree(hc, worktree, branch)
                # GH #91/#90: the just-minted token will never ride a process → revoke it now.
                _revoke_or_defer(api_base, ephemeral_tok)
            elif not sent and not dry_run:
                # spawn failed with no worktree — still revoke the minted token (nothing carries it).
                _revoke_or_defer(api_base, ephemeral_tok)
        else:
            sent, cmd = False, "(no tmux pane / headless cwd recorded — unreachable)"

        rec = {"agent_id": cand["agent_id"], "alias": cand["alias"], "kind": kind,
               "sent": sent, "command": cmd, "reason": cand["reason"],
               "pending_events": cand.get("pending_events"),
               "auto_start_task_ids": cand.get("auto_start_task_ids"),
               "event": event}
        woke.append(rec)

        if not quiet:
            tag = "DRY-RUN would wake" if dry_run else ("woke" if sent else f"could not wake ({kind})")
            print(f"[notifier] {tag} {cand['alias']} via {kind}: {cand['reason']}")
            if dry_run:
                print(f"             → {cmd}")

        if not dry_run:
            # Advance the cursor only when we consumed events (and only on a real
            # delivery); unreachable keeps events pending so a later tick retries
            # once a pane is recorded — but still stamps cooldown to avoid hammering.
            # A3: ack only THROUGH the prompt batch we actually surfaced (ack_through_ts);
            # if wake-scan capped a large prompt backlog, the rest stay pending for the next
            # wake instead of being acked-away undelivered. Falls back to max_event_ts.
            # GH #58: a reaped ephemeral worker (tracked in live_workers) acks its handled-set at
            # COMPLETION via /events/ack-handled (contiguous-floor advance), NOT here at spawn — so a
            # spawn-then-crash re-surfaces the events instead of high-watering past undrained ones.
            # The single-flight lease suppresses any re-wake while it runs. This subsumes GH#110's
            # task-worktree withhold: a task_worktree worker is provisioned only when live_workers is
            # not None and gets added to live_workers on spawn (see above), so it was never a case
            # distinct from ephemeral_reaped — the pending_ack_ts stash it used to set is retired
            # (success advances via ack-handled; the FAILED_DRAIN_MAX backstop releases on
            # wake_ack_ts).
            ephemeral_reaped = (kind == "ephemeral" and sent and live_workers is not None
                                and cand["agent_id"] in live_workers)
            # GH #58 (review fix): the NON-reaped delivery paths (`--once` with no reaper, and tmux
            # sends) used to BLANKET high-water delivered_ts to ack_through_ts (|| max_event_ts) at
            # spawn — which skipped past rows wake_scan deliberately left UN-handled (a cross-task
            # task_bound, a NEW_WORK/DIRECTIVE), the exact skipped-notification class this PR removes.
            # Instead they now post the SAME per-event handled-set (FYI + taskless + context-task
            # task_bound, bounded by ack_through_ts) to /events/ack-handled, which advances the cursor
            # only to the contiguous floor: handled rows stop re-waking while an unhandled one
            # re-surfaces next tick (acked at its own seam when the agent acts). Identical semantics to
            # the reaper and the resident drain sidecar. delivered_ts stays None on every path; the
            # wake-ack below still stamps cooldown/lease. An unreachable/failed send acks nothing.
            non_reaped_drain = (sent and not ephemeral_reaped and cand.get("pending_events"))
            if non_reaped_drain:
                _post_json(f"{api_base}/api/agents/{cand['agent_id']}/events/ack-handled",
                           {"event_ids": cand.get("handled_event_ids") or []})
            delivered_ts = None
            # We claim a single-flight lease ONLY for an ephemeral spawn. If that spawn
            # then failed (no claude, bad cwd, Popen error), no worker exists — release
            # the lease we just won so the agent isn't suppressed for the whole TTL.
            release_lease = (kind == "ephemeral" and not sent)
            # GH #91/#90: the ack releases/advances THIS ephemeral's lane (resolved above; 'work'
            # default for tmux/unreachable, which never took a lane-scoped claim).
            ack_body = {"delivered_ts": delivered_ts,
                        "kind": kind if sent else (f"{kind}_failed" if kind != "unreachable" else "unreachable"),
                        "event": event, "release_lease": release_lease, "lane": ephemeral_lane}
            ack_body.update(self_wake_ack_fields(
                cand, kind=kind, sent=sent, resume_rendered=resume_rendered))
            _post_json(f"{api_base}/api/agents/{cand['agent_id']}/wake-ack", ack_body)

    return {"ok": True, "woke": woke}


# ---------- E3: the resident-session manager (WARM multi-turn conversations) ----------

def _resident_log_path(base_cwd, conversation_id) -> Optional[pathlib.Path]:
    """Per-conversation stream-json log for a resident session (one warm `claude`, many turns)."""
    if not base_cwd:
        return None
    return pathlib.Path(base_cwd) / ".orcha" / "resident-logs" / f"{conversation_id}.ndjson"


def _next_human_turn(api_base: str, conv_id: str, after_seq: int) -> Optional[dict]:
    """The first unanswered HUMAN turn after `after_seq` — the next turn to feed the resident."""
    data = _get_json(f"{api_base}/api/conversations/{conv_id}/turns?after_seq={after_seq}&limit=50")
    for t in (data or {}).get("turns", []):
        if t.get("role") == "human":
            # #338: carry the turn's attachment refs so the warm-resident feed can hand the agent
            # the files (location + metadata) alongside the text.
            return {"seq": t["seq"], "content": t.get("content") or "",
                    "attachments": t.get("attachments") or []}
    return None


def _conversation_log_path(base_cwd, conversation_id) -> Optional[pathlib.Path]:
    """Per-turn one-shot conversation log for non-resident runtimes such as Codex."""
    if not base_cwd:
        return None
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(conversation_id)).strip("-") or "conversation"
    return (pathlib.Path(base_cwd) / ".orcha" / "conversation-logs"
            / f"{slug}-{int(time.time() * 1000)}.ndjson")


def _conversation_reply_path(log_path) -> Optional[pathlib.Path]:
    if not log_path:
        return None
    return pathlib.Path(str(log_path) + ".reply.txt")


def _simple_history(turns: list[dict]) -> str:
    return _conversation.simple_history(turns)


# GH #91/#90: the dispatch directive for a ONE-SHOT conversation worker (Codex cold + resume). Same
# content as CONVERSATION_LANE_DIRECTIVE, phrased for a single-turn chat reply: answer quick asks
# inline; hand real work off as an assigned task with a one-line ack + link, and do NOT do it inline.
# This REPLACES the older "do not post through task/request endpoints unless the human asked" line —
# the whole point of #91/#90 is that the conversation worker SHOULD create+dispatch a task for real
# work; it just must not do that work inline.
_CONVERSATION_DISPATCH_DIRECTIVE = _conversation.DISPATCH_DIRECTIVE


def _conversation_worker_prompt(alias: str, pending_turns: list[dict], history_turns: list[dict],
                                api_base: Optional[str] = None) -> str:
    """Instruction for a one-shot Codex conversation worker.

    Codex does not provide the stdin stream-json resident protocol Claude uses here, so each
    conversation reply is a fresh `codex exec`. We inject the thread history and ask Codex to make
    its final response the message that Orcha appends back to the Conversation tab.
    """
    return _conversation.worker_prompt(
        alias, pending_turns, history_turns, api_base,
        cold_history=_cold_boot_history,
        extract_attachment_text=_extract_attachment_text,
        render_attachment_feed=_render_attachment_feed,
    )


def _codex_resume_prompt(alias: str, pending_turns: list[dict]) -> str:
    """#286: the continuation prompt for a `codex exec resume <session_id>` worker.

    Unlike _conversation_worker_prompt, this injects NO thread history and NO persona/digest — the
    resumed on-disk rollout already holds all prior context, so re-injecting it would re-pay exactly
    the history tokens this feature exists to save. Carries ONLY the framing reminder + the new
    pending human turn(s). The cost win lives here: a multi-turn Codex review now pays history once
    (the cold turn-1 rollout) instead of every turn."""
    return _conversation.resume_prompt(alias, pending_turns)


def _text_from_content(content) -> Optional[str]:
    return _conversation.text_from_content(content)


def _conversation_reply_text(log_path, last_message_path=None) -> Optional[str]:
    """Best-effort final text for a one-shot conversation worker.

    Codex `exec --output-last-message` is the primary path. The JSONL fallback deliberately accepts
    both Claude stream-json and Codex-ish assistant message shapes so tests and future CLI changes
    fail soft instead of leaving the Conversation tab blank.
    """
    return _conversation.reply_text(
        log_path, last_message_path, result_after=_result_after
    )


class _ExternalProcess:
    """A minimal Popen-like wrapper for a worker spawned by a prior notifier process."""

    def __init__(self, pid: int):
        self.pid = int(pid)
        self.returncode = None
        self.stdin = None

    def poll(self):
        if self.returncode is not None:
            return self.returncode
        if _pid_alive(self.pid):
            return None
        self.returncode = 0
        return self.returncode

    def wait(self, timeout=None):
        start = time.time()
        while self.poll() is None:
            if timeout is not None and time.time() - start > timeout:
                raise subprocess.TimeoutExpired(str(self.pid), timeout)
            time.sleep(0.05)
        return self.returncode

    def kill(self):
        try:
            os.kill(self.pid, signal.SIGKILL)
        except OSError:
            pass
        self.returncode = -9


def _as_path(value):
    return pathlib.Path(value) if value else None


def _post_conversation_reply(api_base: str, conv_id: str, r: dict,
                             text: str, meta: Optional[dict] = None) -> bool:
    res = _post_json(
        f"{api_base}/api/conversations/{conv_id}/turns",
        {"role": "agent", "author_agent_id": r["agent_id"],
         "content": text, "run_id": r["current_run_id"],
         "meta": meta or {}},
    )
    return bool(res and res.get("turn"))


def _conversation_ack_body(kind: str, *, delivered_ts=None, release_lease: bool = True) -> dict:
    # GH #91/#90: every ack built here is a CONVERSATION-lane embodiment (resident / Codex
    # conversation), so it releases/advances the conversation lease slot, never the work slot.
    body = {"kind": kind, "event": "conversation_turn", "release_lease": release_lease,
            "lane": "conversation"}
    if delivered_ts is not None:
        body["delivered_ts"] = delivered_ts
    return body


def _resident_runtime(r: dict) -> str:
    """Older in-memory resident dicts predate the runtime field; those are Claude residents."""
    return _normalize_runtime((r or {}).get("runtime"))


def _maybe_pin_codex_session(api_base: str, conv_id: str, r: dict) -> Optional[str]:
    """Compatibility facade for persisting a Codex conversation session."""
    return _codex_conversation.maybe_pin_session(
        api_base, conv_id, r, sys.modules[__name__]
    )


def _finish_codex_conversation(api_base: str, conv_id: str, r: dict, *,
                               status: str = "exited", exit_code=None,
                               ack_kind: str = "codex_conversation_released",
                               post_reply: bool = True,
                               teardown_worktree: bool = False) -> bool:
    """Compatibility facade for finalizing one-shot Codex conversation turns."""
    return _codex_conversation.finish(
        api_base,
        conv_id,
        r,
        sys.modules[__name__],
        status=status,
        exit_code=exit_code,
        ack_kind=ack_kind,
        post_reply=post_reply,
        teardown_worktree=teardown_worktree,
    )


def _codex_run_state(conv: dict, run: dict, *, base_cwd: Optional[str] = None) -> dict:
    """Compatibility facade for restoring durable Codex run state."""
    return _codex_conversation.run_state(
        conv, run, sys.modules[__name__], base_cwd=base_cwd
    )


def reconcile_codex_conversation_runs(api_base: str, cid: str, live_residents: dict, *,
                                      quiet: bool = False,
                                      base_cwd: Optional[str] = None) -> None:
    """Compatibility facade for recovering Codex conversation workers."""
    _codex_conversation.reconcile(
        api_base,
        cid,
        live_residents,
        sys.modules[__name__],
        quiet=quiet,
        base_cwd=base_cwd,
    )


def _close_resident(api_base: str, r: dict, reason: str = "idle", teardown_worktree: bool = False,
                    stamp_woken: bool = True) -> None:
    """Tear a resident down: close stdin (graceful EOF → claude exits, SessionEnd/C1 runs),
    finish any in-flight run, and RELEASE the embodiment lease — but do NOT end the conversation
    (ending is human-driven; an idle teardown keeps the conversation active so the next human
    turn re-spawns and --resume's the pinned session). The agent is then free for ephemeral wakes.

    ISS-61: the worktree is KEPT by default (idle/hung) — it's the STABLE per-conversation worktree,
    reused on the next boot so `--resume`'s cwd doesn't change. Pass teardown_worktree=True ONLY when
    the conversation has ENDED (nothing left to resume into)."""
    proc = r.get("proc")
    try:
        if proc is not None and getattr(proc, "stdin", None) is not None:
            proc.stdin.close()                 # EOF — let claude finish + flush its SessionEnd hook
    except OSError:
        pass
    if proc is not None:
        _kill_worker(proc, graceful=True)      # SIGTERM→wait→SIGKILL; the C1 digest gets to run
    # #247 B3: a warm-zone drain sidecar may still be running under this resident's lease. Tearing
    # the resident down releases that lease, so don't leave the sidecar orphaned — graceful-kill it
    # too (it holds no lease/worker_run of its own, so nothing else cleans it up). Self-terminating
    # one-shot, so this is belt-and-braces for the rare teardown-mid-drain (preempt/idle/end).
    side = r.get("sidecar")
    if isinstance(side, dict) and side.get("proc") is not None:
        _kill_worker(side["proc"], graceful=True)
        r["sidecar"] = None
    if r.get("current_run_id"):
        _finish_run(api_base, r["current_run_id"], "exited", 0, r.get("log_path"))
    # ISS-8: the resident ran code work in an ISOLATED worktree — the SessionEnd C1 snapshot above
    # (graceful kill) reads its config there, so teardown happens AFTER. Preserve a dirty worktree
    # (un-pushed conversational work) rather than discard it (Kedar-greenlit). ISS-61: only on
    # conversation end — an idle/hung close keeps the worktree for the next --resume boot.
    if teardown_worktree:
        _safe_teardown_worktree(r.get("base_cwd"), r.get("worktree"), r.get("branch"))
    # GH #91/#90: a resident is a CONVERSATION-lane embodiment → release the conversation lease slot.
    _post_json(f"{api_base}/api/agents/{r['agent_id']}/wake-ack",
               {"kind": f"resident_{reason}", "release_lease": True, "stamp_woken": stamp_woken,
                "lane": "conversation"})


def _spawn_drain_sidecar(api_base: str, r: dict, inbox: int, *, messages: Optional[list] = None,
                         ack_ts=None, ackable_ids: Optional[list] = None,
                         model: Optional[str] = None,
                         reasoning_effort: Optional[str] = None,
                         dry_run: bool = False, quiet: bool = False) -> bool:
    """#247 B3 (§5.2 warm-zone): spawn a THROWAWAY one-shot drain worker for a warm resident's queued
    NON-conversation inbox WITHOUT releasing the resident's embodiment lease or tearing down the warm
    conversation session. Returns True if a sidecar was started, False on any failure (so the caller
    can fall open to the A2 idle-yield).

    The sidecar runs in the resident's BASE checkout (never its pinned --resume worktree) in its OWN
    fresh session — so the drain's notification/request reasoning can never bleed into the warm
    conversation's context window (the ISS-78 incoherence Kedar hit). It uses a LEAN drain-only
    prompt (no task auto-start — that would be a second embodiment).

    §3 ONE-EMBODIMENT coherence (Kedar-locked, B2 @c2b15b5): the sidecar takes NO wake lease and
    registers NO worker_run. The single resident lease (renewed every tick) stays the agent's SOLE
    embodiment, so the B2 wake gate (lease_active OR EXISTS running worker_run) keeps suppressing
    tick()'s ephemeral — exactly one body. Because there is no worker_run row, the dead-PID
    orphan-reaper (_reap_dead_pid_resident_runs) has nothing of the sidecar's to mistake for the
    resident embodiment, and the resident is never orphan-reaped on the sidecar's account. A wedged
    sidecar carries its own hard_deadline (the caller reaps it), so it can never pin the resident
    lease open. On exit there is no run to /finish — accounting is clean by construction.
    """
    if dry_run:
        return True
    try:
        base_cwd = r.get("base_cwd")
        if not base_cwd or not pathlib.Path(base_cwd).is_dir():
            return False
        persona = _build_persona(api_base, r["agent_id"])
        log_path = (pathlib.Path(base_cwd) / ".claude" / ".orcha-wakes"
                    / f"{r.get('alias', 'agent')}-drain-{int(time.time())}.log")
        prompt = build_resident_sidecar_drain_prompt(r.get("alias"), inbox, messages)
        # Always a Claude one-shot: the resident path is Claude-only (Codex residents have no warm
        # --resume session to protect), and `claude -p` is the drain transport the ephemeral uses.
        sent, _, proc = spawn_headless(base_cwd, prompt, None, False,
                                       alias=r.get("alias"), system_prompt=persona,
                                       model=model, reasoning_effort=reasoning_effort,
                                       runtime=RUNTIME_CLAUDE, log_path=log_path)
        if not sent or proc is None:
            return False
        # Gate P1a: stash the wake cursor watermark captured AT SPAWN (active-conversations'
        # inbox_ack_ts — the max ts of the events this sidecar is about to drain, never past an
        # un-surfaced directed message). On confirmed-success completion the caller acks THROUGH this
        # ts (release_lease=False) so the drained backlog stops re-surfacing as pending_inbox. Pinning
        # the spawn-time mark (not the next tick's) means events that arrive DURING the drain stay
        # pending and are drained next tick — never silently acked away.
        # GH #58: stash the EXACT per-event ids this sidecar may mark handled — only the FYI +
        # taskless-actionable rows active-conversations classified as safe for a protocol-less run
        # (drain_ackable_ids). On confirmed-success the caller posts these to /events/ack-handled
        # (per-event ack + contiguous-floor advance), replacing the old delivered_ts high-water park
        # so a task-bound row that slipped in never gets acked away by the resident. ack_ts retained
        # for log/back-compat only.
        r["sidecar"] = {"proc": proc, "log_path": log_path,
                        "hard_deadline": time.time() + HARD_CAP_MIN_SECS,
                        "ack_ts": ack_ts, "ackable_ids": list(ackable_ids or [])}
        if not quiet:
            print(f"[notifier] resident {r.get('alias')} idle with {inbox} queued inbox event(s) — "
                  f"spawned a throwaway drain sidecar (pid {proc.pid}) in its OWN session; warm "
                  f"conversation + lease KEPT (#247 B3 warm-zone, no context-bleed)")
        return True
    except Exception as e:   # §8 fail-open: a sidecar failure must NEVER crash the daemon loop
        if not quiet:
            print(f"[notifier] resident {r.get('alias')} drain sidecar spawn FAILED ({e!r}) — "
                  f"falling back to idle-yield (#247 B3 §8 fail-open)", file=sys.stderr)
        return False


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

    # 1) Advance every LIVE resident: detect death, capture a finished turn, stream tokens,
    #    renew the lease, idle-reap.
    for conv_id, r in list(live_residents.items()):
        proc = r["proc"]
        cand = by_id.get(conv_id)
        desired_runtime = (_normalize_runtime(cand.get("model_runtime"))
                           if cand and cand.get("model_runtime") else None)
        if (desired_runtime is not None
                and desired_runtime != _resident_runtime(r)
                and not r.get("awaiting_result")):
            if not quiet:
                print(f"[notifier] resident {r.get('alias')} runtime changed "
                      f"{_resident_runtime(r)}→{desired_runtime} — releasing old resident lease")
            _close_resident(api_base, r, reason="runtime_changed")
            _retire_resident(api_base, live_residents, conv_id)
            continue
        # GH#88: same-RUNTIME model switch (e.g. Opus → another Claude model). set_agent_model
        # already cleared the pinned session_id so the NEXT boot is COLD and picks up the new
        # --model — but a still-alive warm resident kept its OLD boot model baked into its
        # session, and the runtime branch above never fires because desired_runtime equals the
        # resident's. Recycle the idle resident so the next human turn cold-boots on the newly
        # selected model. A mid-turn resident (awaiting_result) is left alone — its turn finishes
        # on the old model and this fires next tick, before the next human turn is fed. Claude
        # only: codex conversation turns already cold-spawn per turn with the current model, and
        # their in-memory dict carries no boot model to compare against.
        desired_model = cand.get("model") if cand else None
        if (_resident_runtime(r) == RUNTIME_CLAUDE
                and desired_model is not None
                and r.get("model") is not None
                and desired_model != r.get("model")
                and not r.get("awaiting_result")):
            if not quiet:
                print(f"[notifier] resident {r.get('alias')} model changed "
                      f"{r.get('model')}→{desired_model} — recycling for cold reboot (GH#88)")
            _RESIDENT_RESUME_FAILED.add(conv_id)
            _close_resident(api_base, r, reason="model_changed")
            live_residents.pop(conv_id, None)
            continue
        if _resident_runtime(r) == RUNTIME_CODEX:
            if conv_id not in active_ids:
                _kill_worker(proc, graceful=True)
                _finish_run(api_base, r.get("current_run_id"), "killed", proc.returncode,
                            r.get("log_path"), _capture_diff(r.get("worktree")))
                _safe_teardown_worktree(r.get("base_cwd"), r.get("worktree"), r.get("branch"))
                _post_json(f"{api_base}/api/agents/{r['agent_id']}/wake-ack",
                           _conversation_ack_body("codex_conversation_ended", release_lease=True))
                _CODEX_RESUME_FAILED.discard(conv_id)   # #286: conversation gone → reset the flag
                _retire_resident(api_base, live_residents, conv_id)
                continue
            _pump_one(api_base, r["agent_id"], r)
            if proc.poll() is not None:
                _finish_codex_conversation(
                    api_base, conv_id, r, status="exited", exit_code=proc.returncode,
                    ack_kind="codex_conversation_released", post_reply=True,
                )
                _retire_resident(api_base, live_residents, conv_id)
                if not quiet:
                    print(f"[notifier] Codex conversation worker for {r.get('alias')} "
                          f"(pid {proc.pid}, rc={proc.returncode}) replied — lease released")
                continue
            renew = _post_json(f"{api_base}/api/agents/{r['agent_id']}/wake-renew",
                               {"lease_ttl": WAKE_LEASE_TTL_SECS, "lane": "conversation"})
            # #240/ISS-72: a human requested a graceful STOP of THIS codex conversation turn (surfaced
            # on the renew — zero new poll). A live codex conversation worker HAS a worker_runs row, so
            # POST /api/runs/{id}/stop targets it and APPEARS to succeed — we must honor the signal here
            # or the process runs on to exit/hard-cap (the P1). Same run-id identity vet as the worker
            # (1340) and claude-resident (2230) paths — never reap a stale/foreign run. Abort the TURN,
            # post a stop sentinel so resolved_through advances (the pending human turn is NOT re-run),
            # finish 'killed' with a structured human_stop reason, release the lease — KEEP the
            # conversation/worktree (the interrupt preserves state so the human can redirect).
            if (renew and renew.get("stop_requested")
                    and r.get("current_run_id")
                    and str(renew.get("stop_run_id")) == str(r.get("current_run_id"))):
                _kill_worker(proc, graceful=True)
                by = renew.get("stop_requested_by") or "a human"
                _post_conversation_reply(api_base, conv_id, r, f"[turn stopped by {by}]",
                                         {"runtime": "codex", "stopped": True,
                                          "by": renew.get("stop_requested_by")})
                _finish_run(api_base, r.get("current_run_id"), "killed", proc.returncode,
                            r.get("log_path"), _capture_diff(r.get("worktree")),
                            kill_reason=json.dumps({"cause": "human_stop",
                                                    "run_id": str(r.get("current_run_id")),
                                                    "agent_id": r["agent_id"], "runtime": "codex",
                                                    "by": renew.get("stop_requested_by")}))
                _post_json(f"{api_base}/api/agents/{r['agent_id']}/wake-ack",
                           _conversation_ack_body("codex_conversation_human_stopped",
                                                  release_lease=True))
                _retire_resident(api_base, live_residents, conv_id)
                if not quiet:
                    print(f"[notifier] Codex conversation worker for {r.get('alias')} TURN STOPPED "
                          f"by {by} (run {r.get('current_run_id')}) — conversation kept, lease "
                          f"released")
                continue
            size = r.get("last_size", 0)
            lp = r.get("log_path")
            if lp:
                try:
                    size = os.path.getsize(lp)
                except OSError:
                    size = r.get("last_size", 0)
            if size > r.get("last_size", 0):
                r["last_size"] = size
                r["last_progress_ts"] = time.time()
            if time.time() > r.get("hard_deadline", time.time()):
                _kill_worker(proc, graceful=True)
                diff = _capture_diff(r.get("worktree"))
                _finish_run(api_base, r.get("current_run_id"), "killed", proc.returncode,
                            r.get("log_path"), diff)
                _post_json(f"{api_base}/api/agents/{r['agent_id']}/wake-ack",
                           _conversation_ack_body("codex_conversation_killed", release_lease=True))
                _retire_resident(api_base, live_residents, conv_id)
            continue
        if proc.poll() is not None:            # resident process exited/crashed
            if r.get("current_run_id"):
                _finish_run(api_base, r["current_run_id"], "killed", proc.returncode, r.get("log_path"))
            # ISS-61: a WARM (--resume) boot that died within the resume window = claude couldn't
            # find the session → flag this conversation to COLD-boot next time (don't re-attempt the
            # dead session and crash-loop). Keep the worktree (stable per-conversation, reused on the
            # next boot so --resume's cwd doesn't change) — it's torn down only on conversation end.
            if (not r.get("cold")
                    and time.time() - r.get("booted_ts", 0) < RESUME_FAIL_WINDOW_SECS):
                _RESIDENT_RESUME_FAILED.add(conv_id)
                if not quiet:
                    print(f"[notifier] resident {r.get('alias')} warm --resume failed fast "
                          f"→ next boot COLD (ISS-61)")
            _post_json(f"{api_base}/api/agents/{r['agent_id']}/wake-ack",
                       {"kind": "resident_exited", "release_lease": True, "lane": "conversation"})
            _retire_resident(api_base, live_residents, conv_id)
            continue
        if conv_id not in active_ids:          # human ended the conversation out from under us
            _close_resident(api_base, r, reason="conversation_ended", teardown_worktree=True)
            _RESIDENT_RESUME_FAILED.discard(conv_id)   # ISS-61: conversation gone → reset the flag
            _RESIDENT_DRAIN_YIELD.pop(conv_id, None)    # ISS-78: drop stale yield bookkeeping
            _retire_resident(api_base, live_residents, conv_id)
            continue
        if r.get("awaiting_result"):
            _pump_one(api_base, r["agent_id"], r)          # live tokens → worker_run_lines (ISS-39)
            res = _result_after(r.get("log_path"), r.get("turn_scan_offset", 0))
            if res is not None:                            # the turn finished → capture the reply
                # ISS-78 (A2): a resident only ever runs CONVERSATION turns now — non-conversation
                # inbox events are drained by an ephemeral worker after an idle-yield (below), never
                # injected into this warm session — so every captured result is a human reply to post.
                posted = _post_conversation_reply(
                    api_base, conv_id, r, res.get("text") or "",
                    {"subtype": res.get("subtype"), "num_turns": res.get("num_turns"),
                     "session_id": res.get("session_id")},
                )
                delivered_ts = r.get("conversation_ack_ts") if posted else None
                _post_json(f"{api_base}/api/agents/{r['agent_id']}/wake-ack",
                           _conversation_ack_body("resident_conversation_turn",
                                                  delivered_ts=delivered_ts,
                                                  release_lease=False))
                _finish_run(api_base, r["current_run_id"], "exited", 0, r.get("log_path"))
                # GH#88: if the agent's model was switched (same claude runtime) WHILE this
                # cold-booted turn was in flight, set_agent_model already NULLed the server-side
                # session_id so the next boot cold-starts on the new model. Re-pinning the OLD
                # model's session here would undo that clear and make the switch stick to the old
                # model — the recycle would then rely solely on the in-memory _RESIDENT_RESUME_FAILED
                # flag, which is dropped at spawn (so a crash / ISS-72 stop / hard-cap / daemon
                # restart before the next turn silently warm-resumes the old-model session). Leaving
                # the server pin NULL keeps the next boot cold BY CONSTRUCTION — the durable signal
                # is the server clear, not daemon memory. cand is non-None here: the conversation-
                # ended check above (conv_id in active_ids) guarantees it.
                model_switched = (
                    _resident_runtime(r) == RUNTIME_CLAUDE
                    and cand is not None
                    and cand.get("model") is not None
                    and r.get("model") is not None
                    and cand.get("model") != r.get("model")
                )
                if model_switched:
                    _RESIDENT_RESUME_FAILED.add(conv_id)   # belt-and-suspenders next-boot-cold flag
                    if not quiet:
                        print(f"[notifier] resident {r.get('alias')} model switched mid-turn "
                              f"{r.get('model')}→{cand.get('model')} — captured old reply but "
                              f"leaving session UNPINNED so the next boot cold-starts (GH#88)")
                if not r.get("session_pinned") and not model_switched:   # pin the session for later --resume
                    sid = res.get("session_id") or _extract_session_id(r.get("log_path"))
                    if sid:
                        _post_json(f"{api_base}/api/conversations/{conv_id}/session",
                                   {"session_id": sid})
                        r["session_id"] = sid
                        r["session_pinned"] = True
                r["turn_scan_offset"] = res.get("end_offset", r.get("turn_scan_offset", 0))
                r["awaiting_result"] = False
                r["current_run_id"] = None
                r["last_activity_ts"] = time.time()
        # ISS-60: hard-cap a HUNG turn. If a turn never produces its `result` (claude wedged),
        # the resident stays awaiting_result forever — the idle-reaper can't fire (it requires
        # `not awaiting_result`) and the loop below RENEWS the single-flight lease every tick, so
        # EVERY ephemeral wake for this agent is suppressed indefinitely (the ISS-60 stall). Cap
        # it: finish the run killed + graceful close (SessionEnd/C1 runs) + RELEASE the lease.
        if r.get("awaiting_result") and time.time() - r.get("awaiting_since", 0) > HARD_CAP_MIN_SECS:
            if not quiet:
                print(f"[notifier] resident {r.get('alias')} HUNG awaiting result "
                      f">{HARD_CAP_MIN_SECS:.0f}s — reaping + releasing lease (ISS-60)")
            if r.get("current_run_id"):
                _finish_run(api_base, r["current_run_id"], "killed", -1, r.get("log_path"))
                r["current_run_id"] = None
            _close_resident(api_base, r, reason="hung")
            _retire_resident(api_base, live_residents, conv_id)
            continue
        renew = _post_json(f"{api_base}/api/agents/{r['agent_id']}/wake-renew",
                           {"lease_ttl": WAKE_LEASE_TTL_SECS,
                            "lane": "conversation"})   # hold single-embodiment while warm
        # #240/ISS-72: a human requested a graceful STOP of this resident's in-flight TURN (surfaced
        # on the renew — zero new poll). stop_run_id matches current_run_id ONLY while a turn is in
        # flight, so this fires exactly on a mid-turn run, never on an idle warm session. Abort the
        # TURN but KEEP the conversation active so the human can immediately redirect it (that IS the
        # interrupt semantic — kill the drift, preserve state). _pump_one first so the partial reply
        # is RECOVERABLE; then graceful kill (SessionEnd/C1 runs); finish 'killed'; post ONE sentinel
        # agent turn so resolved_through advances and the daemon does NOT re-run the still-pending
        # human turn (else it would re-spawn forever); release the lease; KEEP the worktree (stable
        # per-conversation, reused on the next turn's --resume).
        if (renew and renew.get("stop_requested")
                and r.get("current_run_id")
                and str(renew.get("stop_run_id")) == str(r.get("current_run_id"))):
            _pump_one(api_base, r["agent_id"], r)        # flush in-flight tokens (ISS-39) before kill
            _kill_worker(proc, graceful=True)
            by = renew.get("stop_requested_by") or "a human"
            _post_conversation_reply(api_base, conv_id, r, f"[turn stopped by {by}]",
                                     {"stopped": True, "by": renew.get("stop_requested_by")})
            _finish_run(api_base, r.get("current_run_id"), "killed", proc.returncode,
                        r.get("log_path"), _capture_diff(r.get("worktree")),
                        kill_reason=json.dumps({"cause": "human_stop",
                                                "run_id": str(r.get("current_run_id")),
                                                "agent_id": r["agent_id"],
                                                "by": renew.get("stop_requested_by")}))
            _post_json(f"{api_base}/api/agents/{r['agent_id']}/wake-ack",
                       _conversation_ack_body("resident_human_stopped", release_lease=True))
            _retire_resident(api_base, live_residents, conv_id)            # worktree KEPT (conversation stays active)
            if not quiet:
                print(f"[notifier] resident {r.get('alias')} TURN STOPPED by {by} "
                      f"(run {r.get('current_run_id')}) — partial flushed, conversation kept, "
                      f"lease released")
            continue
        pending = bool(cand and cand.get("pending_human")
                       and cand.get("last_turn_seq", 0) > r.get("serviced_seq", 0))
        # ISS-70/#222: cold_required is not only a boot-time hint. A live terminal can write a
        # newer digest while this resident process is already warm. If a human turn is waiting and
        # we leave the idle process alive, section 2 below would feed that turn into stale in-memory
        # context. Close first; the same scan then boots cold and re-injects the latest digest.
        if pending and (cand or {}).get("cold_required") and not r.get("awaiting_result"):
            if not quiet:
                print(f"[notifier] resident {r.get('alias')} has a newer digest than its pinned "
                      f"session — checkpointing and cold-restarting before the next turn (#222)")
            # #285: the cold reboot below (loop 2) re-injects via _build_persona, which serves the
            # (persona, curated_digest) pair from the short-TTL cache. #222 just decided this
            # agent's LIVE digest is newer than its pin — so a cache entry written ≤TTL ago holds
            # the now-stale pre-resync digest. Drop it here so the cold boot fetches the new one;
            # without this pop the resync would close the resident only to re-inject the very digest
            # it meant to flush. force_fresh on the reboot would also work, but that path serves
            # cold AND warm boots for many reasons — popping at the decision point is the narrower,
            # lower-risk seam.
            _PERSONA_CACHE.pop(r.get("agent_id"), None)
            _close_resident(api_base, r, reason="digest_resync")
            _retire_resident(api_base, live_residents, conv_id)
            continue
        # ISS-69(b): a human opened a live terminal (preempt=1) while this resident holds the lease.
        # wake-claim recorded the yield request; the renew above reads it back. Yield ONLY when idle
        # (no in-flight turn, no pending human turn) so we never SIGKILL mid-response — _close_resident
        # snapshots (#145) + releases the lease so the terminal's retry claims 'live'. If the resident
        # IS mid-turn, skip: the flag persists in the DB, so the next idle tick yields = deferred
        # handoff that waits for the turn to finish, with no extra bookkeeping here.
        if (renew and renew.get("preempt_requested")
                and not r.get("awaiting_result") and not pending):
            if not quiet:
                print(f"[notifier] resident {r.get('alias')} YIELDING to a live terminal "
                      f"(preempt=1, idle) — snapshot + release lease (ISS-69b)")
            _close_resident(api_base, r, reason="preempted")
            _retire_resident(api_base, live_residents, conv_id)
            continue
        # #247 B3 (§5.2 warm-zone): a drain SIDECAR may be in flight (spawned below). While it runs,
        # this resident is "busy draining" — exactly like an in-flight turn: skip every yield/reap
        # transition this tick so the warm session + lease stay put (both already renewed above). Reap
        # it on exit, or kill it at its OWN hard deadline (a wedged sidecar can NEVER pin the resident
        # lease open). Either way the sidecar is this resident's one transition for the tick → continue;
        # next tick re-reads the drained inbox and decides whether another drain pass is needed. The
        # sidecar holds no lease and no worker_run, so on exit there is nothing to /finish — clean.
        side = r.get("sidecar")
        if side is not None:
            sproc = side.get("proc")
            natural = sproc is not None and sproc.poll() is not None   # exited on its own
            done = sproc is None or natural
            if not done and time.time() > side.get("hard_deadline", time.time()):
                _kill_worker(sproc, graceful=True)        # wedged drain → kill; resident + lease KEPT
                done = True                               # killed, NOT a natural exit → no cursor ack
                if not quiet:
                    print(f"[notifier] resident {r.get('alias')} drain sidecar "
                          f"(pid {getattr(sproc, 'pid', None)}) exceeded its hard cap — killed; warm "
                          f"resident + lease KEPT, cursor NOT advanced (#247 B3)")
            if done:
                # GH #58 — SUCCESS only: a NATURAL exit with rc 0 means the drain ran to completion,
                # so POST the per-event handled-set (the FYI/taskless ids captured at spawn) to
                # /events/ack-handled — the server records the acks and advances delivered_ts to the
                # contiguous floor, so the drained rows stop re-surfacing as pending_inbox while ANY
                # row the run could not handle stays pending. A wedged-kill or a NON-ZERO exit posts
                # nothing → the backlog re-surfaces for a fresh drain next tick (failure never advances
                # the cursor). The lease is always KEPT (no wake-ack here) — never regress to the A2
                # yield/teardown model. Replaces the old delivered_ts high-water park, which could ack
                # past a task-bound row the resident must not clear.
                success = natural and sproc.returncode == 0
                ackable_ids = side.get("ackable_ids") or []
                r["sidecar"] = None                       # finished/killed → no worker_run to finish
                if success:
                    _post_json(f"{api_base}/api/agents/{r['agent_id']}/events/ack-handled",
                               {"event_ids": ackable_ids})
                    if not quiet:
                        print(f"[notifier] resident {r.get('alias')} drain sidecar finished — inbox "
                              f"drained in its own session; {len(ackable_ids)} event(s) acked-handled "
                              f"(lease KEPT), warm conversation intact (#247 B3 / GH #58)")
                elif not quiet:
                    print(f"[notifier] resident {r.get('alias')} drain sidecar ended without a clean "
                          f"completion — cursor NOT advanced; the backlog re-surfaces for a fresh "
                          f"drain next tick (#247 B3)")
            continue
        # ISS-78 (A2) → #247 B3 (§5.2): a warm resident holds the single-embodiment lease, so the
        # server's wake gate suppresses EVERY ephemeral wake for this agent — decision_made/task_message/
        # request_* QUEUE and the resident (which only consumes conversation turns) never sees them.
        # ISS-74 used to drain them INTO the warm session, but that physically left the drain prompt +
        # the agent's task-work reasoning in the conversation's context window, contaminating the NEXT
        # human turn (the ISS-78 incoherence Kedar hit live). A2 then IDLE-YIELDED the lease so the next
        # tick()'s ephemeral drained the backlog — context-bleed solved, but the yield TORE DOWN the warm
        # session, forcing a cold re-boot on the next human turn and defeating the §5.1 warm-zone hold.
        # B3 keeps the warm session: instead of yielding, spawn a THROWAWAY DRAIN SIDECAR in its OWN
        # session/cwd (base checkout, never the pinned --resume worktree) that drains the WHOLE backlog
        # and exits, WITHOUT releasing the lease or tearing down the conversation. Separate session ⇒
        # zero bleed; no second lease/worker_run ⇒ the §3 ONE-EMBODIMENT contract (Kedar-locked, B2
        # @c2b15b5) holds — the resident lease stays the sole body, tick()'s ephemeral stays suppressed.
        # A real human turn always takes precedence (the `pending` guard above); a live sidecar short-
        # circuits this tick (the `r["sidecar"]` block above), so we only get here with NO sidecar live.
        inbox = (cand or {}).get("pending_inbox", 0) or 0
        inbox_ack_ts = (cand or {}).get("inbox_ack_ts")
        # #72: only the events BEFORE an actionable answer are drainable by a sidecar (which may NOT do
        # task work); the answer itself must stay pending for a real post-exit worker. The server
        # surfaces `drainable_inbox` = that safe count. When it's 0 (e.g. the sole queued event is the
        # unblocking answer) DON'T spawn a sidecar — it would drain nothing, and skipping it leaves the
        # trigger pending so the ephemeral wake fires once this resident's lease clears. Fall back to
        # the full pending count for an older server that doesn't surface the field.
        drainable = (cand or {}).get("drainable_inbox")
        if drainable is None:
            drainable = inbox
        inbox_wake_task_id = (cand or {}).get("inbox_wake_task_id")
        # GH #58 (§5.2 safe-rows-only): active-conversations classifies the queued backlog. A resident
        # carries NO injected task protocol, so it may only drain FYI + taskless-actionable rows
        # (drain_ackable_ids). If ANY TASK_BOUND / NEW_WORK / DIRECTIVE row is present (drain_taskbound
        # > 0) the sidecar must NOT run — those need a fresh ephemeral bound to that task; so YIELD the
        # lease (the existing A2 idle-yield) and let tick()'s protocol-bound ephemeral drain the whole
        # backlog (FYI rows ride along). A pure FYI/taskless backlog drains in the warm-zone sidecar.
        drain_taskbound = (cand or {}).get("drain_taskbound", 0) or 0
        drain_ackable_ids = (cand or {}).get("drain_ackable_ids") or []
        # ISS-78 anti-thrash backstop (carries the ISS-75/#188 guard forward): don't spawn ANOTHER drain
        # pass when the inbox high-water mark (inbox_ack_ts) hasn't advanced past the last attempt's AND
        # we attempted within the cooldown — a stuck/echo event the drain can't ack away would otherwise
        # thrash a fresh sidecar every cycle. A genuinely NEW event (higher inbox_ack_ts) clears `stalled`
        # and drains immediately. State is module-level so it survives across ticks (and a yield-fallback,
        # which destroys the resident dict).
        prev = _RESIDENT_DRAIN_YIELD.get(conv_id)
        stalled = (inbox_ack_ts is not None and prev is not None and prev[0] is not None
                   and inbox_ack_ts <= prev[0]
                   and time.time() - prev[1] < RESIDENT_DRAIN_COOLDOWN_SECS)
        # GH #91/#90 (R2-1/R3-4): the WORK lane now drains the non-conversation inbox on its own —
        # the warm resident no longer spawns a sidecar NOR yields its conversation lease for it. Gated
        # OFF by RESIDENT_WORK_TEARDOWN_ENABLED. The warm resident stays a pure conversation responder
        # here; it is torn down only by the pure idle-reap below or by a real conversation transition.
        # #72: the gate counts only DRAINABLE events (events before an actionable answer), so a
        # backlog whose sole trigger is an unblocking answer parks for the post-lease worker.
        if (RESIDENT_WORK_TEARDOWN_ENABLED
                and not r.get("awaiting_result") and not pending and drainable > 0 and not stalled):
            if inbox_wake_task_id:
                # GH #131: this backlog is a resume on an in-progress task the agent already owns.
                # Leave it on the WORK lane so wake_scan can spawn the normal isolated worker; the
                # resident drain sidecar is only for no-task drains and new/other task claims.
                if not quiet:
                    print(f"[notifier] resident {r.get('alias')} has task-thread work queued "
                          f"for an in-progress task — leaving inbox for the work worker; warm "
                          f"conversation + lease KEPT (GH #131)")
                continue
            if drain_taskbound > 0:
                # A task-bound / new-work / directive row needs a protocol-bound ephemeral, which the
                # resident is not → YIELD the lease so the next tick()'s ephemeral (carrying that task's
                # protocol) drains the whole backlog. Same teardown seam as the §8 fail-open below.
                if not quiet:
                    print(f"[notifier] resident {r.get('alias')} has {drain_taskbound} task-bound "
                          f"inbox row(s) needing a protocol-bound run — yielding the lease for an "
                          f"ephemeral drain instead of the warm-zone sidecar (#247 B3 §5.2 / GH #58)")
                _close_resident(api_base, r, reason="inbox_drain_yield")
                _retire_resident(api_base, live_residents, conv_id)
                continue
            _RESIDENT_DRAIN_YIELD[conv_id] = (inbox_ack_ts, time.time())   # mark this drain attempt
            spawned = _spawn_drain_sidecar(api_base, r, inbox,
                                           messages=(cand or {}).get("inbox_messages"),
                                           ack_ts=inbox_ack_ts,
                                           ackable_ids=drain_ackable_ids,
                                           model=(cand or {}).get("model"),
                                           reasoning_effort=(cand or {}).get("reasoning_effort"),
                                           dry_run=dry_run, quiet=quiet)
            if not spawned:
                # §8 fail-open: sidecar spawn failed/raised → fall back to the A2 idle-YIELD so the next
                # tick's ephemeral drains the backlog (never crash, never strand). Warm-zone is forfeited
                # for this one cycle only; the next human turn warm --resume's (or cold-boots) a clean
                # pre-drain session, so coherence still holds.
                if not quiet:
                    print(f"[notifier] resident {r.get('alias')} drain sidecar unavailable — "
                          f"yielding the lease for an ephemeral drain instead (#247 B3 §8 fail-open)")
                _close_resident(api_base, r, reason="inbox_drain_yield")
                _retire_resident(api_base, live_residents, conv_id)
            continue
        # #266 (auto-wake FIRING): a warm resident that is idle (no in-flight turn, no pending human
        # turn) and whose clock-driven auto-wake is DUE yields the lease — the same snapshot+release
        # seam as the ISS-78 inbox-drain (NEVER inject the heartbeat into the warm human session: an
        # auto-wake nudge is task-work and would bleed into the next human turn, the ISS-78 regression).
        # Reached with nothing left for a sidecar to drain (inbox==0, or #72: only an unblocking answer
        # is queued — parked, not drained, so a real worker handles it once the lease clears), so this is
        # the PURE clock path. stamp_woken=False so this release does NOT reset secs_since_woken — wake-scan still
        # reads auto_wake_due and the very next idle tick()'s EPHEMERAL wake performs the heartbeat in its
        # own throwaway session (single-embodiment preserved: the lease is free before it claims). The
        # ephemeral wake's own ack then stamps last_woken_at, anchoring the next cadence correctly. A
        # mid-turn resident never reaches here (awaiting_result short-circuits in section 1).
        # GH #91/#90 (R3-4): the clock-driven auto-wake is WORK-lane work; the warm conversation
        # resident must NOT yield its lease for it (the work lane fires its own ephemeral off its own
        # work lease + heartbeat). Gated OFF by RESIDENT_WORK_TEARDOWN_ENABLED.
        if (RESIDENT_WORK_TEARDOWN_ENABLED
                and not r.get("awaiting_result") and not pending and (cand or {}).get("auto_wake_due")):
            if not quiet:
                print(f"[notifier] resident {r.get('alias')} idle + clock-driven auto-wake due — "
                      f"yielding the lease (no clock reset) so an ephemeral worker runs the heartbeat "
                      f"in its own session (#266, no context-bleed)")
            _close_resident(api_base, r, reason="auto_wake_yield", stamp_woken=False)
            _retire_resident(api_base, live_residents, conv_id)
            continue
        if (not r.get("awaiting_result") and not pending
                and time.time() - r.get("last_activity_ts", 0) > RESIDENT_IDLE_REAP_SECS):
            _close_resident(api_base, r, reason="idle")     # warm session went cold → free the lease
            _retire_resident(api_base, live_residents, conv_id)

    # 2) For each conversation with a pending human turn and no resident mid-turn, advance ONE
    #    turn: boot the resident if needed, then feed the next human turn.
    for conv_id, c in by_id.items():
        if not c.get("pending_human"):
            continue
        runtime = _normalize_runtime(c.get("model_runtime"))
        if runtime == RUNTIME_CODEX:
            if live_residents.get(conv_id) is not None:
                continue
            turns = (_get_json(f"{api_base}/api/agents/{c['agent_id']}/conversation?limit=200")
                     or {}).get("turns", [])
            resolved_through = max([t["seq"] for t in turns if t.get("role") == "agent"], default=0)
            pending_turns = [t for t in turns
                             if t.get("role") == "human" and t.get("seq", 0) > resolved_through]
            if not pending_turns:
                continue
            if dry_run:
                if not quiet:
                    print(f"[notifier] DRY-RUN would start Codex conversation worker "
                          f"for {c.get('agent_alias')}")
                continue
            if not dry_run:
                claim = _post_json(
                    f"{api_base}/api/agents/{c['agent_id']}/wake-claim",
                    {"lease_ttl": WAKE_LEASE_TTL_SECS, "kind": "conversation",
                     "event": "conversation_turn", "lease_kind": "ephemeral"})
                if not (claim and claim.get("claimed")):
                    if not quiet:
                        print(f"[notifier] Codex conversation skip {c.get('agent_alias')} — "
                              f"{(claim or {}).get('reason', 'claim failed')}")
                    continue
            in_git = (not dry_run) and _is_git_repo(base_cwd)
            worktree, branch = _provision_resident_worktree(base_cwd, conv_id) if in_git else (None, None)
            if in_git and worktree is None:
                if not quiet:
                    print(f"[notifier] Codex conversation skip {c.get('agent_alias')} — "
                          f"worktree isolation failed (won't run in shared checkout)")
                _post_json(f"{api_base}/api/agents/{c['agent_id']}/wake-ack",
                           {"kind": "codex_conversation_failed", "event": "conversation_turn",
                            "release_lease": True, "lane": "conversation"})   # no token minted yet
                continue
            run_cwd = worktree or base_cwd or str(pathlib.Path.cwd())
            log_path = _conversation_log_path(base_cwd, conv_id)
            last_message_path = _conversation_reply_path(log_path)
            # #286: RESUME when this conversation has a pinned Codex session AND the digest hasn't
            # changed since the pin (cold_required, ISS-70) AND the last resume didn't fail. Then
            # `codex exec resume <sid>` restores persona+digest+history from the on-disk rollout, so
            # we inject ONLY the new turns and NO persona — the token win. Otherwise COLD: full
            # history + persona (today's behavior), which also re-pins a fresh session id on success.
            session_id = c.get("session_id")
            use_resume = (bool(session_id) and not c.get("cold_required")
                          and conv_id not in _CODEX_RESUME_FAILED)
            if use_resume:
                prompt = _codex_resume_prompt(c.get("agent_alias"), pending_turns)
                persona = None
            else:
                prompt = _conversation_worker_prompt(
                    c.get("agent_alias"), pending_turns,
                    [t for t in turns if t.get("seq", 0) <= resolved_through],
                    api_base=api_base)
                persona = None if dry_run else _build_persona(
                    api_base, c["agent_id"], lane="conversation")
            # GH #91/#90 (R3): this Codex conversation worker IS a conversation-lane embodiment —
            # mint the CONVERSATION-lane token BEFORE Popen (valid in the DB before its first gated
            # call), pass it + conversation=True to the process, and stamp lane='conversation' on the
            # run below. Without this the run recorded lane='work' (the WorkerRunStart default), so
            # wake_scan counted a live conversation as a WORK embodiment and suppressed work wakes —
            # the exact split this PR delivers. One run per process (one-shot `codex exec`), so the
            # server's revoke-on-terminal (bound via token_id) is the right lifetime, mirroring the
            # ephemeral path. dry_run never mints (no process); a None token spawns token-less.
            conv_tok = None if dry_run else _mint_embodiment_token(
                api_base, c["agent_id"], "conversation", "headless")
            sent, _, proc = spawn_headless(run_cwd, prompt, None, dry_run,
                                           alias=c.get("agent_alias"), system_prompt=persona,
                                           model=c.get("model"),
                                           reasoning_effort=c.get("reasoning_effort"),
                                           runtime=runtime,
                                           resume_session_id=(session_id if use_resume else None),
                                           log_path=log_path,
                                           last_message_path=last_message_path,
                                           run_token=conv_tok, conversation=True)
            if not sent or proc is None:
                _safe_teardown_worktree(base_cwd, worktree, branch)
                _revoke_or_defer(api_base, conv_tok)   # token never rode a process → revoke now
                _post_json(f"{api_base}/api/agents/{c['agent_id']}/wake-ack",
                           {"kind": "codex_conversation_failed", "event": "conversation_turn",
                            "release_lease": True, "lane": "conversation"})
                continue
            run = _post_json(
                f"{api_base}/api/agents/{c['agent_id']}/runs",
                {"wake_kind": "ephemeral", "wake_event": "conversation_turn",
                 "log_path": str(log_path) if log_path else None,
                 "pid": proc.pid, "runtime": runtime, "conversation_id": conv_id,
                 "conversation_ack_ts": c.get("conversation_ack_ts"),
                 "last_message_path": str(last_message_path) if last_message_path else None,
                 "worktree": worktree, "branch": branch, "base_cwd": base_cwd,
                 # GH #91/#90 (R3): stamp the conversation lane + bind the minted token so the
                 # server durably revokes it on this run's terminal transition.
                 "lane": "conversation", "token_id": conv_tok})
            run_id = (run or {}).get("run_id")
            if not run_id:
                _kill_worker(proc, graceful=True)
                _safe_teardown_worktree(base_cwd, worktree, branch)
                _revoke_or_defer(api_base, conv_tok)   # no run bound the token → revoke now
                _post_json(f"{api_base}/api/agents/{c['agent_id']}/wake-ack",
                           {"kind": "codex_conversation_failed", "event": "conversation_turn",
                            "release_lease": True, "lane": "conversation"})
                if not quiet:
                    print(f"[notifier] Codex conversation skip {c.get('agent_alias')} — "
                          "worker_run creation failed")
                continue
            live_residents[conv_id] = {
                "runtime": RUNTIME_CODEX, "proc": proc, "agent_id": c["agent_id"],
                "conversation_id": conv_id, "alias": c.get("agent_alias"),
                "log_path": log_path, "last_message_path": last_message_path,
                "worktree": worktree, "branch": branch, "base_cwd": base_cwd,
                "serviced_seq": max(t.get("seq", 0) for t in pending_turns),
                "current_run_id": run_id, "run_id": run_id,
                "conversation_ack_ts": c.get("conversation_ack_ts"),
                # #286: the session id this worker RESUMED (None on a cold turn). The finish path
                # uses it to (a) fall back to cold if a resume produced no reply, and (b) skip
                # re-pinning when the resumed session id is unchanged.
                "resume_session_id": session_id if use_resume else None,
                # GH #91/#90 (R3): track the conversation token so _retire_resident revokes it on
                # teardown (belt to the server's run-terminal revoke, mirroring the ephemeral path).
                "run_token": conv_tok,
                "hard_deadline": time.time() + HARD_CAP_MIN_SECS,
                "last_size": 0, "last_progress_ts": time.time(),
                "lines_offset": 0, "lines_buf": b"", "lines_seq": 1,
                "last_activity_ts": time.time()}
            if not quiet:
                print(f"[notifier] Codex conversation worker for {c.get('agent_alias')} "
                      f"spawned (pid {proc.pid})")
            continue
        if runtime != RUNTIME_CLAUDE:
            continue
        r = live_residents.get(conv_id)
        if r is not None and r.get("awaiting_result"):
            continue                                        # busy; capture handled in section 1
        serviced = r.get("serviced_seq", 0) if r else 0
        if c.get("last_turn_seq", 0) <= serviced:
            continue                                        # nothing newer than we've fed
        desired_model = c.get("model")
        if (r is not None
                and _resident_runtime(r) == RUNTIME_CLAUDE
                and desired_model is not None
                and r.get("model") is not None
                and desired_model != r.get("model")):
            if not quiet:
                print(f"[notifier] resident {r.get('alias')} model changed "
                      f"{r.get('model')}→{desired_model} — recycling before feed (GH#88)")
            _RESIDENT_RESUME_FAILED.add(conv_id)
            _close_resident(api_base, r, reason="model_changed")
            live_residents.pop(conv_id, None)
            r = None
        if r is None:                                       # boot a resident for this conversation
            # 919050a5 (b): single-flight reap-prior. Before claiming a NEW resident lease, reap any
            # prior resident run for this agent whose pid is dead (a crash/turnover between POST-run
            # and _finish_run left it 'running' + dropped the in-memory entry) — else we'd stack a
            # second resident on the orphan and hold two running rows for one agent. The reaped lease
            # is released, then re-claimed fresh below. Cross-daemon safe (DB + host os.kill).
            if not dry_run:
                _reap_dead_pid_resident_runs(api_base, c["agent_id"], live_pids, quiet=quiet)
            claim = None if dry_run else _post_json(
                f"{api_base}/api/agents/{c['agent_id']}/wake-claim",
                {"lease_ttl": WAKE_LEASE_TTL_SECS, "kind": "resident", "lease_kind": "resident"})
            if not (claim and claim.get("claimed")):
                if not quiet:
                    print(f"[notifier] resident skip {c.get('agent_alias')} — "
                          f"{(claim or {}).get('reason', 'claim failed')}")
                continue
            session_id = c.get("session_id")
            # cold boot injects persona (+history). ISS-61: also force COLD if a prior WARM boot for
            # this conversation crash-failed --resume (a session claude couldn't find) — else we'd
            # re-attempt the same dead session and crash-loop. ISS-70: also force COLD when the server
            # signals `cold_required` — this agent's latest memory digest is newer than when the
            # session was pinned (a cross-embodiment digest the warm --resume would never re-read).
            # Self-limiting: the cold boot re-pins session_pinned_at=now() so the signal clears next tick.
            cold = ((not session_id) or (conv_id in _RESIDENT_RESUME_FAILED)
                    or bool(c.get("cold_required")))
            # Any boot of a conversation that ALREADY has answered turns must start `serviced` past
            # the last AGENT reply — else _next_human_turn re-feeds an old, answered question (the
            # unanswered turns are the ones after the last agent reply). Applies cold AND warm
            # (a --resume respawn also starts with a fresh in-memory cursor). Fetch the MOST-RECENT
            # page (the agent's active-conversation read returns the newest N oldest→newest) — NOT
            # after_seq=0, which returns the OLDEST page and leaves resolved_through stale once the
            # conversation passes the page size, feeding an ancient turn (review P2). The newest
            # agent reply is always near the tail of an alternating conversation, so the recent page
            # captures it; this page also feeds the cold-boot history block (budgeted to last-N).
            turns = (_get_json(f"{api_base}/api/agents/{c['agent_id']}/conversation?limit=200")
                     or {}).get("turns", [])
            resolved_through = max([t["seq"] for t in turns if t.get("role") == "agent"], default=0)
            serviced = max(serviced, resolved_through)
            persona = (_build_persona(api_base, c["agent_id"], lane="conversation")
                       if cold else None)   # warm --resume already carries it in-session
            if cold and _format_history is not None:
                # V1 history prefix (Vault #120): the warm session has no in-context history on a
                # cold boot, so prepend the RESOLVED turns (seq ≤ resolved_through). WARM --resume
                # skips this (history already in-session → no double-inject). '' (brand-new
                # conversation) is omitted. Order: persona → digest → history block.
                # #247 item-3: a LONG history is CURATED (summarize-older + recent-verbatim) here
                # rather than mechanically oldest-dropped; _cold_boot_history fails open to the
                # mechanical block, so this branch can never block the boot.
                block = _cold_boot_history([t for t in turns if t.get("seq", 0) <= resolved_through])
                if block:
                    persona = "\n\n".join(p for p in (persona, block) if p) or None
            log_path = _resident_log_path(base_cwd, conv_id)
            # ignore any pre-existing log content (a prior resident's turns) — scan/pump from the end
            existing = log_path.stat().st_size if (log_path and log_path.exists()) else 0
            # ISS-8 (Kedar-greenlit narrow fix): a resident does CODE work via conversation, so it
            # must run in an ISOLATED worktree off origin/main — NOT the shared base checkout (where
            # a resident already opened a PR off main). Mirrors tick()'s ephemeral path. The per-turn
            # log_path stays under base_cwd (survives teardown); only the spawn CWD is the worktree.
            in_git = (not dry_run) and _is_git_repo(base_cwd)
            # ISS-61: a STABLE per-conversation worktree (reused across boots) — NOT a fresh path
            # each boot (#149's _provision_worktree), which changed the cwd and broke `--resume`.
            worktree, branch = _provision_resident_worktree(base_cwd, conv_id) if in_git else (None, None)
            if in_git and worktree is None:
                # FAIL CLOSED (review P1): base_cwd IS a git checkout but isolation failed
                # (worktree-add/fetch/ref error). Booting a resident in the shared checkout would
                # reproduce the exact ISS-8 hazard this fix removes — so release the lease + skip,
                # never run resident code work in main. (A truly NON-git project keeps the explicit
                # base_cwd fallback above: nothing shared to tangle.)
                if not quiet:
                    print(f"[notifier] resident skip {c.get('agent_alias')} — "
                          f"worktree isolation failed (won't run in shared checkout)")
                _post_json(f"{api_base}/api/agents/{c['agent_id']}/wake-ack",
                           {"kind": "resident_failed", "release_lease": True,
                            "lane": "conversation"})   # release the CONVERSATION lease we claimed
                continue
            run_cwd = worktree or base_cwd or str(pathlib.Path.cwd())
            # GH #91/#90 (R3): a resident is a CONVERSATION-lane embodiment. Mint the conversation
            # token BEFORE spawn and pass it + conversation=True so its env carries the capability
            # (the gated WORK endpoints 403 it — it may only dispatch). Unlike the one-shot ephemeral/
            # Codex worker (one run per process, so token_id binds to that run for revoke-on-terminal),
            # a resident is ONE process spanning MANY per-turn runs — so the token is PROCESS-scoped:
            # stored in r["run_token"] and revoked by _retire_resident at teardown. Binding it to a
            # per-turn run would revoke it after the first turn (each turn's run goes terminal). The
            # per-turn run below is still stamped lane='conversation' — the wake_scan-critical fix.
            conv_tok = None if dry_run else _mint_embodiment_token(
                api_base, c["agent_id"], "conversation", "resident")
            sent, _, proc = spawn_resident(run_cwd,
                                           system_prompt=persona, log_path=log_path,
                                           resume_session_id=None if cold else session_id,
                                           alias=c.get("agent_alias"), model=c.get("model"),
                                           reasoning_effort=c.get("reasoning_effort"),
                                           runtime=c.get("model_runtime"),
                                           run_token=conv_tok, conversation=True,
                                           dry_run=dry_run)
            if not sent or proc is None:
                # ISS-61: keep the STABLE per-conversation worktree (reused on the next boot); it's
                # torn down only when the conversation ends. Revoke the just-minted token (no process
                # to carry it) and release the CONVERSATION lease.
                _revoke_or_defer(api_base, conv_tok)
                _post_json(f"{api_base}/api/agents/{c['agent_id']}/wake-ack",
                           {"kind": "resident_failed", "release_lease": True,
                            "lane": "conversation"})
                continue
            r = {"runtime": RUNTIME_CLAUDE, "proc": proc,
                 "agent_id": c["agent_id"], "conversation_id": conv_id,
                 "alias": c.get("agent_alias"), "log_path": log_path,
                 # GH#88: the model this resident was actually booted on (already resolved
                 # server-side). service_residents recycles the resident when the candidate's
                 # current model drifts from this — a same-runtime warm session keeps its boot
                 # model in-context, so a mid-conversation Opus→other-Claude switch needs a cold
                 # boundary to take effect.
                 "model": c.get("model"),
                 "worktree": worktree, "branch": branch, "base_cwd": base_cwd,
                 "session_id": session_id, "session_pinned": not cold, "cold": cold,
                 # GH #91/#90 (R3): the process-scoped conversation token, revoked by
                 # _retire_resident at teardown (see the mint comment above).
                 "run_token": conv_tok,
                 "serviced_seq": serviced, "current_run_id": None, "run_id": None,
                 "awaiting_result": False, "turn_scan_offset": existing,
                 "lines_offset": existing, "lines_buf": b"", "lines_seq": 1,
                 "booted_ts": time.time(), "last_activity_ts": time.time()}
            live_residents[conv_id] = r
            if cold:
                _RESIDENT_RESUME_FAILED.discard(conv_id)   # ISS-61: cold boot recovered → clear flag
        nxt = _next_human_turn(api_base, conv_id, r["serviced_seq"])
        if nxt is None:
            continue
        # #338 feed-to-agent: a resident is a Claude stdin session; append the attachment feed
        # (location + metadata + open-instructions) to the human turn so the files reach the agent.
        _feed = _render_attachment_feed(nxt.get("attachments"), api_base=api_base, runtime="claude")
        if _feed:
            nxt["content"] = f"{nxt['content']}\n\n{_feed}" if nxt["content"] else _feed
        # ISS-stranded (e4b77f3f): SEND-FIRST. Persist the worker_run only AFTER the turn lands on
        # the resident's stdin. The old POST-then-send order created a status=running row and then,
        # on a broken pipe, hit `continue` WITHOUT setting current_run_id — orphaning the row forever
        # (the exact stall Page hit) and re-POSTing a fresh orphan every tick. A broken pipe now just
        # skips this tick (the resident is reaped via proc.poll()/idle), creating no row.
        # GH #91/#90 (PR R5): every turn fed to the resident carries the stable one-line lane
        # reminder (_wrap_conversation_turn) — the full CONVERSATION_LANE_DIRECTIVE rode in on the
        # cold-boot persona, but a long-lived warm resident (and a resumed pre-merge session, which
        # never saw the directive at all) answers many turns off that one boot, so the lane is
        # re-asserted per turn. Wrapped at the send (not stored) so the reminder never leaks into
        # conversation records.
        if not _send_user_turn(r["proc"], _wrap_conversation_turn(nxt["content"])):  # pipe gone → reaped next tick, no orphan row
            continue
        run = _post_json(f"{api_base}/api/agents/{c['agent_id']}/runs",
                         {"wake_kind": "resident", "wake_event": "conversation_turn",
                          "log_path": str(r["log_path"]) if r.get("log_path") else None,
                          "pid": getattr(r.get("proc"), "pid", None),
                          # GH #91/#90 (R3): stamp the conversation lane so wake_scan does not count
                          # this warm resident as a WORK embodiment (which would suppress work wakes).
                          # No token_id: the resident token is PROCESS-scoped (revoked at teardown),
                          # not bound to a per-turn run — see the mint comment at boot.
                          "lane": "conversation"})
        run_id = (run or {}).get("run_id")
        r["current_run_id"] = run_id
        r["run_id"] = run_id                                # _pump_one streams this turn to run_id
        r["lines_seq"] = 1                                  # fresh seq space per per-turn run
        r["current_run_kind"] = "conversation"              # ISS-74: a real reply → post to the convo
        r["conversation_ack_ts"] = c.get("conversation_ack_ts")
        r["awaiting_result"] = True
        r["awaiting_since"] = time.time()                   # ISS-60: hard-cap a hung turn
        r["serviced_seq"] = nxt["seq"]
        r["last_activity_ts"] = time.time()


# ---------- daemon singleton (so init / up / SessionStart can auto-start it) ----------

def _pid_path(cwd: pathlib.Path) -> pathlib.Path:
    return _daemon_registry.pid_path(cwd)



def _log_path(cwd: pathlib.Path) -> pathlib.Path:
    return _daemon_registry.log_path(cwd)



def _pid_alive(pid: int) -> bool:
    return _daemon_registry.pid_alive(pid, services=sys.modules[__name__])



def _ps_inspect(pid: int) -> Optional[tuple]:
    """Compatibility facade for portable process inspection."""
    return _daemon_registry.ps_inspect(pid, services=sys.modules[__name__])



def _daemon_pid_live(pid: int, cid: Optional[str] = None) -> bool:
    """Compatibility facade for notifier process identity checks."""
    return _daemon_registry.daemon_pid_live(pid, cid, services=sys.modules[__name__])



def daemon_running(cwd: pathlib.Path) -> Optional[int]:
    """Return the live notifier daemon PID for this project, if present."""
    return _daemon_registry.daemon_running(cwd, services=sys.modules[__name__])



# The daemon is CONTAINER-global (it resolves container_id once at startup and services
# every agent in it), but the per-cwd PID file above is only visible from one checkout.
# With several worktrees of the same project (Orcha, Orcha-<agent>, ...) a second
# `notifier --ensure` from a different cwd couldn't see the first daemon and DOUBLE-SPAWNED
# it — two ticking servicers race past every spawn gate (single-flight lease, drain
# backstop) → concurrent residents per agent + phantom 'running' worker_runs
# (incident 2026-06-10). The container-keyed PID file under $HOME closes that hole:
# every worktree sees the same file.

def _global_pid_path(container_id: str) -> pathlib.Path:
    return _daemon_registry.global_pid_path(container_id)



def _container_id_for(cwd: pathlib.Path) -> Optional[str]:
    return _daemon_registry.container_id_for(cwd)



def _api_base_for(cwd: pathlib.Path) -> Optional[str]:
    return _daemon_registry.api_base_for(cwd)



def _write_global_pid(container_id: str, pid: int, cwd: pathlib.Path) -> None:
    _daemon_registry.write_global_pid(container_id, pid, cwd, services=sys.modules[__name__])



def daemon_running_for_container(container_id: str) -> Optional[tuple]:
    """Return the live daemon serving a container from any worktree."""
    return _daemon_registry.daemon_running_for_container(container_id, services=sys.modules[__name__])



def _claim_container(container_id: str):
    """Compatibility facade for atomic container-wide daemon claims."""
    return _daemon_registry.claim_container(container_id, services=sys.modules[__name__])



def _terminate_and_wait(pid: int, cid: Optional[str], grace: float = 8.0) -> None:
    """Compatibility facade for identity-vetted daemon termination."""
    _daemon_control.terminate_and_wait(pid, cid, grace, services=sys.modules[__name__])



def stop_daemon(cwd: pathlib.Path, quiet: bool = False) -> bool:
    """Stop the daemon serving this project's container."""
    return _daemon_control.stop_daemon(cwd, quiet, services=sys.modules[__name__])



def stop_daemon_for_container(container_id: str, quiet: bool = False) -> bool:
    """Stop the daemon bound to a specific, possibly replaced container."""
    return _daemon_control.stop_daemon_for_container(container_id, quiet, services=sys.modules[__name__])



def ensure_daemon(cwd: pathlib.Path, quiet: bool = False, restart: bool = False) -> bool:
    """Start the project's detached singleton notifier when needed."""
    return _daemon_control.ensure_daemon(cwd, quiet, restart, services=sys.modules[__name__])



# ---------- subcommand entry ----------

def cmd_notifier(args) -> None:
    """Compatibility facade for the notifier command lifecycle."""
    _notifier_command.cmd_notifier(args, services=sys.modules[__name__])
