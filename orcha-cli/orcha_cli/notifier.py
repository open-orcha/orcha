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
    """The cold-boot conversation-history block.

    Curation LAYERS ON TOP of the mechanical ``_format_history`` formatter — it is NOT a parallel
    path. The mechanical block is the SINGLE fallback seam: it is injected into ``curate_history``
    as ``mechanical=`` (so curation's own fail-open routes through the same formatter tests patch)
    AND is what we degrade to if curation is absent or returns nothing.

    Contract:
      * ``_format_history`` ABSENT (None) → NO history block at all, even if curation is present
        (unchanged absent-formatter contract — curation is an enhancement of the formatter, not a
        replacement for it).
      * ABSOLUTE fail-open — this never lets history assembly raise into the spawn path.
    """
    if _format_history is None:
        return ""   # formatter absent → history injection disabled (unchanged contract)

    def _mech(t):
        return _format_history(t) or ""

    if _curate_history is not None:
        try:
            block = _curate_history(turns, mechanical=_mech)
            if block:
                return block
        except Exception:
            pass  # belt-and-suspenders: curate_history is already total, but never block a boot
    return _mech(turns)

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
    """Make ORCHA_SECRET_KEY available to the daemon so it can unseal wake-path provider keys.

    The CLI persists the master key to <project>/.orcha/.env (see __main__._ensure_secret_key), but
    `orcha up` brings the daemon up without exporting it (only Compose reads that file). So if it's
    not already in the env, read it from .orcha/.env relative to the daemon's cwd (the project root
    ensure_daemon spawns it in). Best-effort: any failure leaves the daemon on its env keys."""
    if os.environ.get("ORCHA_SECRET_KEY"):
        return
    try:
        env_file = pathlib.Path.cwd() / ".orcha" / ".env"
        if not env_file.is_file():
            return
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line.startswith("ORCHA_SECRET_KEY="):
                val = line.split("=", 1)[1].strip().strip('"').strip("'")
                if val:
                    os.environ["ORCHA_SECRET_KEY"] = val
                return
    except Exception:
        return


def _unseal_scan_key(scan: Optional[dict], field: str) -> Optional[str]:
    """Unseal a wake-scan's sealed provider-key blob (`triage_key_enc` / `ack_key_enc`) into a
    usable plaintext key, or None. Env override (ORCHA_LLM_API_KEY) still wins via resolve_llm_key.
    Fails SOFT to None (→ the call falls back to env keys / fails open) on any decrypt error."""
    blob = (scan or {}).get(field)
    if _secret_box is None:
        return None
    try:
        return _secret_box.resolve_llm_key(blob)
    except Exception:
        return None


def _triage_wake(event_text: str, *, config: Optional[dict] = None, api_key: Optional[str] = None) -> dict:
    """#288 Tier-1 hook — delegate to the #290 universal client. FAIL-OPEN to wake if the module
    is somehow unavailable (cannot suppress on infra error); triage_wake itself also fails open.

    #294: `config` is the {"triage": {provider, model}} override resolved server-side and carried
    on the wake-scan response, so an operator can tune WHICH model triages (cost vs. accuracy).
    None ⇒ #290's shipped default (Haiku). The override is advisory: llm_util.resolve_spec falls
    back to the default on any missing/partial config.

    `api_key` is the unsealed per-provider key from the wake-scan (see _unseal_scan_key) so a
    Settings-stored key (e.g. xAI) is used; None ⇒ llm_util's own env fallback applies."""
    if _llm_util is None:
        return {"wake": True, "reason": "llm_util unavailable — fail-open"}
    return _llm_util.triage_wake(event_text, config=config, api_key=api_key)


def _triage_config_from_scan(scan: dict) -> Optional[dict]:
    """#294: map a wake-scan response's per-container `triage_model` into the {use_case: {...}}
    config shape llm_util.resolve_spec expects. Returns None when no override is configured (the
    common case) so triage_wake uses #290's shipped default. A malformed/empty triage_model also
    yields None — the override is advisory and must never crash the triage path."""
    tm = (scan or {}).get("triage_model")
    if isinstance(tm, dict) and (tm.get("provider") or tm.get("model")):
        return {"triage": tm}
    return None


def decide_wake_suppression(cand, *, triage_fn=_triage_wake):
    """#288: PURE decision — should this candidate's EPHEMERAL wake be SUPPRESSED (no spawn)?

    Returns None to wake normally (the conservative default), or a dict
    ``{tier, reason, request_id}`` to suppress. ``triage_fn(text)->{"wake":bool,"reason":str}`` is
    injected (``llm_util.triage_wake``) so tests can drive it without a network call.

    FAIL-OPEN everywhere: a candidate with no ``triage_hint``, an unknown tier, a non-False
    ``wake`` verdict, OR any triage exception all return None (wake). Only a structural BARE FYI,
    or an explicit ``wake is False`` triage verdict, suppresses. ``request_id`` is set (Tier-1
    ``request_answered`` only) so the caller can auto-close the answered request."""
    hint = (cand or {}).get("triage_hint")
    if not hint:
        return None
    tier = hint.get("tier")
    if tier == "structural":
        return {"tier": "structural",
                "reason": f"bare {hint.get('event_name')}",
                "request_id": hint.get("request_id")}
    if tier == "llm":
        try:
            verdict = triage_fn(hint.get("text") or "")
        except Exception:
            return None   # fail-open — a flaky triage can never suppress a wake
        # only an explicit boolean False suppresses; missing/null/non-bool wakes (bool(None) trap).
        if isinstance(verdict, dict) and verdict.get("wake") is False:
            return {"tier": "llm",
                    "reason": str(verdict.get("reason", "")),
                    "request_id": hint.get("request_id")}
        return None
    return None


# The T2 cheap-act actions the daemon knows how to complete. An event tagged with anything NOT in
# this set FAILS OPEN to a full boot (decide_wake_tier) — never a silent no-op.
_T2_ACTIONS = ("ack_close", "ack_verify")


def decide_wake_tier(cand, *, triage_fn=_triage_wake):
    """#307: PURE grading of a candidate into the CHEAPEST SUFFICIENT substrate —
    ``structural`` | ``llm`` (both = #288 suppress), ``act`` (T2 cheap handoff), or ``full`` (boot).

    A strict SUPERSET of ``decide_wake_suppression``: it first asks #288 "would this be suppressed?"
    and returns that verdict VERBATIM (so T2 can NEVER steal a wake #288 already handles, TOOTH A).
    Only when #288 would let the event FULL-BOOT does it look at the server's ``t2`` tag: a KNOWN
    routine action grades ``act`` (the boot-saving rung, TOOTH B); an unknown action or no tag
    grades ``full`` (FAIL-OPEN — an untagged/novel event always earns a full embodiment).

    ``triage_fn`` is injected exactly as in ``decide_wake_suppression`` (one triage call total)."""
    hint = (cand or {}).get("triage_hint")
    if not hint:
        return {"tier": "full"}
    # #288 first: a structural bare FYI or a triage=skip answer stays a suppress, verbatim.
    suppress = decide_wake_suppression(cand, triage_fn=triage_fn)
    if suppress is not None:
        return suppress
    # Not suppressed → this would full-boot today. Cheap-act ONLY a server-tagged routine handoff.
    t2 = hint.get("t2") if isinstance(hint, dict) else None
    action = t2.get("action") if isinstance(t2, dict) else None
    if action in _T2_ACTIONS:
        verdict = {"tier": "act", "action": action, "text": hint.get("text") or ""}
        if action == "ack_close":
            verdict["request_id"] = t2.get("request_id")
        elif action == "ack_verify":
            verdict["task_id"] = t2.get("task_id")
        return verdict
    return {"tier": "full"}   # untagged / unknown action → conservative full boot


def _ack_config_from_scan(scan: dict) -> Optional[dict]:
    """#307: map a wake-scan's per-container `ack_model` into the {use_case: {...}} config shape
    llm_util.resolve_spec expects, symmetric with `_triage_config_from_scan`. None when no override
    is configured (the common case) so handoff_ack uses #290's shipped default (Haiku)."""
    am = (scan or {}).get("ack_model")
    if isinstance(am, dict) and (am.get("provider") or am.get("model")):
        return {"ack": am}
    return None


def _log_graded_wake(verdict: dict, autonomy_level, acted: bool) -> None:
    """#284 measurement: emit ONE structured record per graded T2 — whether the act actually fired
    (autonomy='full') or was only logged (the default gate). This is the before/after token signal
    the continuity-eval harness reads.

    Writes the record straight to STDOUT (ensure_daemon redirects the daemon's stdout+stderr to its
    log file), NOT through logging.getLogger: the daemon never configures the logging module, so an
    .info() record under the unconfigured root (default level WARNING, no handler) is silently
    DROPPED and never reaches the daemon log at runtime. Emitted UNCONDITIONALLY — the daemon always
    runs --quiet, but the #284 measurement must land regardless of the quiet flag. The greppable
    `graded_wake` tag lets the continuity-eval harness parse it. Never crashes the wake path."""
    try:
        record = json.dumps({
            "event": "graded_wake",
            "tier": verdict.get("tier"),
            "action": verdict.get("action"),
            "acted": bool(acted),
            "would_boot": True,            # a graded 'act' is BY DEFINITION one #288 would full-boot
            "autonomy_level": autonomy_level,
        })
        print(f"[notifier] graded_wake {record}", flush=True)
    except Exception:
        pass


def _apply_wake_act(api_base: str, cand: dict, event, verdict: dict, *,
                    quiet: bool, ack_config: Optional[dict] = None,
                    ack_api_key: Optional[str] = None) -> bool:
    """#307 T2: complete a routine handoff on the CHEAP substrate via the agent's EXISTING routes,
    WITHOUT a spawn. Returns True iff the handoff was acked + the cursor advanced; False ESCALATES
    (the caller full-boots) on any of: no cheap client, a missing target id, the model declining
    (ack=False), or a failed write. NEVER advances the cursor unless the write succeeded — an
    escalated/failed event re-grades next tick and ultimately full-boots, so work is never lost."""
    action = verdict.get("action")
    target = verdict.get("request_id") if action == "ack_close" else (
        verdict.get("task_id") if action == "ack_verify" else None)
    if not target:
        return False                       # nothing to act on → escalate
    if _llm_util is None:
        return False                       # no cheap substrate → escalate
    try:
        decision = _llm_util.handoff_ack(verdict.get("text") or "", config=ack_config,
                                         api_key=ack_api_key)
    except Exception:
        return False                       # fail-closed → escalate
    line = (decision.get("text") or "").strip() if isinstance(decision, dict) else ""
    if not (isinstance(decision, dict) and decision.get("ack") and line):
        return False                       # model judged it non-routine → escalate, NO write
    # Perform the cheap write via the same route a full agent would have used.
    if action == "ack_close":
        resp = _post_json(f"{api_base}/api/requests/{target}/triage-close",
                          {"triage_reason": line[:500]})
    else:  # ack_verify
        resp = _post_json(f"{api_base}/api/tasks/{target}/messages",
                          {"author_agent_id": cand["agent_id"], "body": line})
    if resp is None:
        if not quiet:
            print(f"[notifier] WARN T2 {action} write failed for {cand.get('alias')} "
                  f"— escalating to a full boot (cursor not advanced)", file=sys.stderr)
        return False                       # write failed → DON'T advance the cursor; re-grade later
    # Write landed → advance the cursor WITHOUT spawning (mirrors _suppress_wake exactly).
    ack_ts = cand.get("ack_through_ts")
    if ack_ts is None:
        ack_ts = cand.get("max_event_ts")
    _post_json(f"{api_base}/api/agents/{cand['agent_id']}/wake-ack",
               {"delivered_ts": ack_ts, "kind": "skipped", "event": event, "release_lease": False})
    return True


def _suppress_wake(api_base: str, cand: dict, event, suppress: dict, *, quiet: bool) -> None:
    """#288: apply a wake suppression — auto-close the answered request (Tier-1 only), then advance
    the wake cursor so the same event doesn't re-trigger (and re-charge the LLM) every tick. NEVER
    spawns. Cursor advance is best-effort-after-close: even if triage-close fails (transient), we
    still suppress + ack — the request lingering 'answered' is the pre-#288 status quo, no regression."""
    rid = suppress.get("request_id")
    if rid:
        resp = _post_json(f"{api_base}/api/requests/{rid}/triage-close",
                          {"triage_reason": (suppress.get("reason") or "")[:500]})
        if resp is None and not quiet:
            print(f"[notifier] WARN triage-close failed for request {rid} "
                  f"({cand.get('alias')}) — wake still suppressed; request stays 'answered'",
                  file=sys.stderr)
    # advance the cursor WITHOUT spawning; kind='skipped' (documented WakeAck value) so the
    # cooldown/metrics see a real no-spawn pass. ack_through_ts falls back to max_event_ts.
    ack_ts = cand.get("ack_through_ts")
    if ack_ts is None:
        ack_ts = cand.get("max_event_ts")
    _post_json(f"{api_base}/api/agents/{cand['agent_id']}/wake-ack",
               {"delivered_ts": ack_ts, "kind": "skipped", "event": event, "release_lease": False})


# ---------- config ----------

RUNTIME_CLAUDE = "claude"
RUNTIME_CODEX = "codex"
ORCHA_CLAUDE_EXEC = "ORCHA_CLAUDE_EXEC"
ORCHA_CODEX_EXEC = "ORCHA_CODEX_EXEC"
_CODEX_EXEC_FALLBACKS = (
    "/Applications/Codex.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "~/.local/bin/codex",
)


def _normalize_runtime(runtime: Optional[str]) -> str:
    return RUNTIME_CODEX if runtime == RUNTIME_CODEX else RUNTIME_CLAUDE


def _runtime_executable(runtime: Optional[str]) -> str:
    return "codex" if _normalize_runtime(runtime) == RUNTIME_CODEX else "claude"


def _executable_override(env_var: str) -> Optional[str]:
    override = os.environ.get(env_var)
    if not override:
        return None
    if shutil.which(override):
        return override
    p = pathlib.Path(override).expanduser()
    return str(p) if p.is_file() and os.access(p, os.X_OK) else None


def _resolve_runtime_executable(runtime: Optional[str]) -> Optional[str]:
    runtime = _normalize_runtime(runtime)
    leaf = _runtime_executable(runtime)
    override = _executable_override(ORCHA_CODEX_EXEC if runtime == RUNTIME_CODEX else ORCHA_CLAUDE_EXEC)
    if override:
        return override
    if shutil.which(leaf):
        return leaf
    if runtime == RUNTIME_CODEX:
        for candidate in _CODEX_EXEC_FALLBACKS:
            p = pathlib.Path(candidate).expanduser()
            if p.is_file() and os.access(p, os.X_OK):
                return str(p)
    return None


def _codex_prompt(prompt: str, system_prompt: Optional[str]) -> str:
    if not system_prompt:
        return prompt
    return f"{system_prompt.strip()}\n\n## Orcha Wake Instruction\n{prompt}"


def _runtime_extra_flags(runtime: Optional[str], flags: Optional[str]) -> list[str]:
    """Carry user-supplied headless flags, dropping Claude-only permission flags for Codex."""
    extra = flags.split() if flags else []
    if _normalize_runtime(runtime) != RUNTIME_CODEX:
        return extra
    filtered: list[str] = []
    skip_next = False
    for flag in extra:
        if skip_next:
            skip_next = False
            continue
        if flag == "--dangerously-skip-permissions":
            continue
        if flag == "--permission-mode":
            skip_next = True
            continue
        if flag.startswith("--permission-mode="):
            continue
        filtered.append(flag)
    return filtered

def _load_config(cwd: pathlib.Path) -> dict:
    cfg = cwd / ".claude" / "orcha.json"
    if not cfg.exists():
        sys.exit(
            "error: no .claude/orcha.json in CWD. Run the notifier from the project "
            "root (where `orcha init`/`orcha connect` was run)."
        )
    return json.loads(cfg.read_text())


def _api_and_cid(cwd: pathlib.Path, api_override: Optional[str],
                 cid_override: Optional[str]) -> tuple[str, str]:
    # Both overrides supplied → don't require a project config file (lets the
    # daemon run from anywhere, e.g. a systemd unit or the demo harness).
    if api_override and cid_override:
        return api_override.rstrip("/"), cid_override
    cfg = _load_config(cwd)
    api_base = (api_override or cfg.get("api_base_url") or "").rstrip("/")
    cid = cid_override or cfg.get("current_container_id")
    if not api_base:
        sys.exit("error: api_base_url missing from .claude/orcha.json")
    if not cid:
        sys.exit("error: no container_id — pass --container or set current_container_id "
                 "in .claude/orcha.json (run /orcha-container).")
    return api_base, cid


def _get_json(url: str, timeout: float = 8.0) -> Optional[dict]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read())
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError):
        return None


def _probe_container(api_base: str, cid: str) -> str:
    """Does this API actually know this container? 'ok' | 'missing' (definitive HTTP 404)
    | 'unreachable' (API down/booting). _get_json can't distinguish a 404 from a dead API —
    this can, and ONLY a definitive 404 should make the daemon refuse to start.

    Why it matters: a daemon bound to a container its API doesn't know is a permanent no-op
    that still LOOKS alive in ps. The 2026-06-10 postmortem found stale orcha.json files
    pointing at OTHER projects' API ports after a stack reshuffle — those daemons would idle
    forever, deepening the which-daemon-is-which confusion during an incident."""
    url = f"{api_base}/api/containers/{cid}/wake-scan?cooldown=15&min_idle=30"
    try:
        with urllib.request.urlopen(url, timeout=8.0) as resp:
            resp.read()
        return "ok"
    except urllib.error.HTTPError as e:
        # 404 = the API answered and doesn't know the container. Any other HTTP error
        # means the API is alive — not grounds to refuse.
        return "missing" if e.code == 404 else "ok"
    except (urllib.error.URLError, ValueError, OSError):
        return "unreachable"


def _post_json(url: str, body: dict, timeout: float = 8.0) -> Optional[dict]:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError):
        return None


def _extract_attachment_text(attachments, api_base: Optional[str] = None) -> dict:
    """#338 Codex image->text. Read upload/validation-time cached OCR text from attachment refs and
    return ``{attachment-id: text}`` for the feed renderer. ``api_base`` is kept for compatibility
    with the first-pass call sites/tests, but this helper deliberately performs NO network fetch
    and NO LLM call — cached text is the single source so task-thread and conversation wakes do not
    re-OCR per turn. FAIL-OPEN: malformed refs simply omit that id."""
    out: dict = {}
    for a in attachments or []:
        if not isinstance(a, dict):
            continue
        aid = a.get("id")
        text = (a.get("extracted_text") or "").strip()
        if text:
            out[aid] = text
    return out


# ---------- wake prompt ----------

def build_wake_prompt(cand: dict) -> str:
    """The short directive injected into the agent's session. Pure (testable).

    R2.4: this is a ONE-SHOT worker prompt — drain the inbox and EXIT. The runaway
    happened because the old prompt told the worker to run `/orcha-listen`, whose
    long-poll watch loop never returns; every wake spawned a fresh headless process
    that then sat forever in its own /wait loop, and they piled up.

    R2.2: "drain" means the FULL backlog — ALL open requests + ALL unacked events,
    repeating until the inbox is EMPTY, then exit. This is finite (it terminates when
    nothing is pending) and is NOT the `/orcha-listen` watch loop, which blocks
    indefinitely waiting for NEW events. Handling only the first item would strand the
    rest until the next wake (queue-stranding bug d94727e7).
    """
    alias = cand.get("alias") or "agent"
    bits = []
    if cand.get("pending_events"):
        bits.append(f"{cand['pending_events']} new event(s)")
    if cand.get("auto_start_task_ids"):
        bits.append(f"{len(cand['auto_start_task_ids'])} assigned ready task(s)")
    # #266: a clock-driven heartbeat wake with NOTHING otherwise pending — say so plainly so the
    # worker knows it's a scheduled poll: drain anything that's there, and if genuinely empty, just
    # exit (the generic "pending work" below would be misleading for an empty scheduled poll).
    if cand.get("auto_wake_due") and not cand.get("pending_events") and not cand.get("auto_start_task_ids"):
        bits.append("scheduled heartbeat wake (nothing flagged — check for anything pending, else exit)")
    what = " + ".join(bits) or "pending work"

    manifest = ""
    notifications = cand.get("notifications") or []
    if notifications:
        rows = []
        for n in notifications[:12]:
            label = str(n.get("rank_label") or n.get("type") or n.get("event_name") or "notification")
            label = label.replace("_", "-")
            # #359: a task-REQUEST drains as "accept → spawn the task → work it", not "answer & clear".
            # Surface it distinctly so the worker (and the human reading the manifest) sees it is work,
            # not just another request to acknowledge.
            if n.get("is_task_request"):
                label = "task-request-in"
            surface = n.get("surface")
            if not surface:
                deeplink = n.get("deeplink") or {}
                if deeplink.get("kind") and deeplink.get("id"):
                    surface = f"{deeplink['kind']}:{deeplink['id']}"
                else:
                    surface = str(n.get("type") or n.get("event_name") or "notification").replace("_", "-")
            actor = f" from {n['actor_alias']}" if n.get("actor_alias") else ""
            obj_pri = f" p={n['object_priority']}" if n.get("object_priority") is not None else ""
            preview = str(n.get("preview") or "").replace("\n", " ").strip()
            if len(preview) > 120:
                preview = preview[:117] + "..."
            tail = f": {preview}" if preview else ""
            rows.append(f"rank {n.get('rank', '?')} {label} -> {surface}{actor}{obj_pri}{tail}")
        if cand.get("notifications_truncated") or len(notifications) > 12:
            rows.append("more pending notifications omitted from this prompt; keep draining until empty")
        manifest = " RANKED WAKE MANIFEST - drain in this order: " + " | ".join(rows) + "."

    # A3: a directed prompt-event carries a human/teammate message. Surface it verbatim so the
    # worker acts on it specifically (not just "drain the inbox"). Quote each pending message.
    directed = ""
    msgs = [m for m in (cand.get("prompt_messages") or []) if m]
    if msgs:
        quoted = " ".join(f'(prompt {i + 1}) "{m}"' for i, m in enumerate(msgs))
        directed = (f" DIRECTED MESSAGE{'S' if len(msgs) > 1 else ''} FOR YOU — act on "
                    f"{'these' if len(msgs) > 1 else 'this'} specifically: {quoted}.")
    # #359: a TASK-request in the inbox IS an assignment — accepting it spawns the task. Without this
    # the worker reads "drain your inbox" + "assignment is the only task trigger" and DEFLECTS the
    # work (answers/defers the request to empty the inbox) instead of spawning it. When one is
    # pending, steer the worker into accept-and-do, overriding the generic don't-claim guidance.
    has_task_request = any((n.get("is_task_request") for n in notifications))
    if has_task_request:
        task_step = (
            f"(2) one or more inbox items is a TASK-REQUEST (a teammate asking you to DO work) — "
            f"this IS an assignment: accept it via `/orcha-accept-task <request-id> --alias {alias}` "
            f"(which SPAWNS the task) and make concrete progress on it THIS session; do NOT just "
            f"answer, reject, or defer a task-request to empty your inbox — that deflects the work "
            f"instead of doing it; "
        )
    elif cand.get("auto_start_task_ids"):
        task_step = (
            f"(2) if the auto-start rule still holds (assigned & ready, no human HOLD, "
            f"container active) claim your task via `/orcha-next --alias {alias}` and make "
            f"concrete progress; "
        )
    else:
        task_step = (
            "(2) do not claim a task just because you were woken for inbox/event work — "
            "assignment is the only task trigger; "
        )
    return (
        f"[orcha wake] {alias}: {what}.{manifest}{directed} You are a ONE-SHOT headless worker: drain your "
        f"FULL inbox, then EXIT — do NOT enter the `/orcha-listen` long-poll watch loop "
        f"(it never returns and piles up stuck workers). Steps: (1) drain the ENTIRE "
        f"backlog — handle ALL your open requests AND all unacked events, repeating until "
        f"your inbox is EMPTY (don't stop after the first item; that strands the rest "
        f"until the next wake); {task_step}(3) once the inbox is empty and you've "
        f"reached a natural stop — or you need the human — STOP and exit; another wake "
        f"resumes you when there's more. Never self-certify: stop at needs_verification "
        f"and let the human verify."
    )


# ISS-78 (A2): build_resident_drain_prompt was removed. A warm resident no longer drains its
# NON-conversation inbox in-session (that physically left task-work reasoning in the conversation's
# context window — the ISS-78 bleed). It now idle-YIELDS the lease (service_residents) and an ordinary
# ephemeral worker drains the backlog via build_wake_prompt in its OWN session — so the drain prompt
# and the wake prompt are one and the same again.


def build_resident_sidecar_drain_prompt(alias: Optional[str], inbox: int,
                                        messages: Optional[list] = None) -> str:
    """#247 B3 (§5.2 warm-zone): the LEAN one-shot prompt for a warm-resident DRAIN SIDECAR. Pure.

    Distinct from build_wake_prompt (the ephemeral wake) in TWO deliberate ways:
      1. It is spawned in a SEPARATE session/cwd while the warm conversation lease is STILL HELD —
         so it can drain the queued NON-conversation backlog without the ISS-78 context-bleed (the
         removed in-session drain fed task reasoning into the next human turn) AND without yielding
         the lease (which the A2 idle-yield did, defeating the §5.1 warm-zone hold).
      2. It OMITS task auto-start. A warm conversation embodiment is already live for this agent;
         claiming + working a task here would be a SECOND concurrent embodiment, violating the
         Kedar-locked §3 ONE-EMBODIMENT contract. So: drain notifications/requests only, then EXIT.

    GH #58 (§5.2 safe-rows-only): the caller (service_residents) spawns this sidecar ONLY when the
    queued backlog is pure FYI + taskless-actionable (active-conversations' drain_taskbound == 0); if
    any TASK_BOUND / NEW_WORK / DIRECTIVE row is present it yields the lease to a protocol-bound
    ephemeral instead. So this run, which carries NO injected task protocol, never needs to reason
    about a specific task — it only clears protocol-less rows, and the caller acks exactly those ids
    (drain_ackable_ids) via /events/ack-handled on its clean exit.

    Gate P1b: `prompt`/`task_message`/`task_assigned` events carry content with NO inbox surface —
    surfacing the text is the ONLY delivery path (same as build_wake_prompt / wake_scan). So the
    caller threads the bounded directed-message batch (active-conversations' `inbox_messages`) in
    here and we quote it VERBATIM — otherwise the cursor-ack (P1a) would mark these delivered while
    silently dropping their content. The cursor is acked ONLY after this sidecar has run with them.
    """
    who = alias or "agent"
    n = f"{inbox} queued inbox event(s)" if inbox else "queued inbox events"
    # P1b: directed messages have no other inbox surface — quote each so the sidecar acts on it
    # specifically (mirrors build_wake_prompt's A3 surfacing) before its content is acked away.
    directed = ""
    msgs = [m for m in (messages or []) if m]
    if msgs:
        quoted = " ".join(f'(message {i + 1}) "{m}"' for i, m in enumerate(msgs))
        directed = (f" DIRECTED MESSAGE{'S' if len(msgs) > 1 else ''} FOR YOU — these carry content "
                    f"with no other inbox surface, so handle {'them' if len(msgs) > 1 else 'it'} "
                    f"specifically: {quoted}.")
    return (
        f"[orcha wake · drain sidecar] {who}: {n} piled up while your live conversation session is "
        f"held WARM.{directed} You are a ONE-SHOT DRAIN worker: clear the FULL non-conversation backlog, then "
        f"EXIT — do NOT enter the `/orcha-listen` long-poll watch loop (it never returns and piles "
        f"up stuck workers). Steps: (1) drain the ENTIRE inbox — handle ALL your open requests AND "
        f"ack ALL unacked events, repeating until your inbox is EMPTY (don't stop after the first "
        f"item; that strands the rest). (2) Do NOT claim or start a task via `/orcha-next` and do "
        f"NOT begin code work — a warm conversation session is already live for you, so starting "
        f"task work here would be a second concurrent embodiment. If answering a request would "
        f"require real task work, leave it for that task's own worker; answer what you can without "
        f"code and move on. (3) Once the inbox is empty, STOP and exit. Never self-certify — stop "
        f"at needs_verification and let a human verify."
    )


# ---------- transports (host-side side-effects) ----------

def _tmux_available() -> bool:
    return shutil.which("tmux") is not None


def tmux_pane_live(target: str) -> bool:
    """True if `target` (session:window.pane) exists and runs a Claude session.

    Best-effort: Claude Code runs as a `node` process, so we accept node/claude as
    the pane's foreground command. If we can't confirm a Claude-ish process we
    return False — sending keystrokes into a bare shell would execute the prompt as
    a command, which we must never do.
    """
    if not target or not _tmux_available():
        return False
    try:
        out = subprocess.run(
            ["tmux", "display-message", "-p", "-t", target, "#{pane_current_command}"],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if out.returncode != 0:
        return False
    cmd = out.stdout.strip().lower()
    return cmd in {"node", "claude", "claude-code"}


def send_tmux(target: str, prompt: str, dry_run: bool) -> tuple[bool, str]:
    """Inject `prompt` + Enter into the tmux pane. Returns (sent, command-repr)."""
    literal = ["tmux", "send-keys", "-t", target, "-l", prompt]
    enter = ["tmux", "send-keys", "-t", target, "Enter"]
    repr_ = f"tmux send-keys -t {target} -l <prompt>; tmux send-keys -t {target} Enter"
    if dry_run:
        return False, repr_
    try:
        subprocess.run(literal, check=True, timeout=5)
        subprocess.run(enter, check=True, timeout=5)
        return True, repr_
    except (OSError, subprocess.SubprocessError):
        return False, repr_


# #325: the standing plain-language rule for every message an agent sends a HUMAN. Orcha is
# built for non-engineers to run their own agent teams, so communication clarity is a product
# requirement, not polish. This rides the persona on EVERY wake (independent of whether a digest
# exists) because the digest only ever carried WHAT the agent knew — never HOW to talk to a
# person — so each wake the agent reverted to internal jargon a non-engineer can't parse.
HUMAN_COMMS_GUARDRAIL = (
    "## Talking to humans (plain-language guardrail — applies to every message you send a person)\n"
    "Orcha is run by non-engineers. Before any message leaves to a human, make it readable to them:\n"
    "- No bare UUIDs, invented shorthand labels (F1/F2, B3), or git SHAs unless the human used them "
    "first. Name what a thing IS in plain English; put an id in parentheses only if it's actually "
    "useful to them.\n"
    "- Lead with the answer, then the why. Keep it short — a sentence or two, not a structured "
    "report — unless they asked for depth.\n"
    "- Match how they talk to you. If you're unsure what they already understand, default to plain "
    "over precise."
)


def _render_protocol(protocol: Optional[dict]) -> Optional[str]:
    """#326 (A1): render the per-task protocol (GET /agents/{aid}/protocol → {protocol:{...}})
    as the standing-RULES section. `protocol` is the response dict; its `protocol` key is the
    SPEC-4 JSONB {review_chain, handoff_to, autonomy, notes} (any subset). Returns None when no
    rules are set so an idle/cold wake carries no protocol section."""
    p = (protocol or {}).get("protocol")
    if not p:
        return None
    lines = ["## Standing protocol (your task's working agreement — the RULES, read FRESH every "
             "wake ahead of your notes; a human edits these and they apply on your very next wake):"]
    # GH #56 (Point 2): review_chain / handoff_to / notes are BINDING — render them as imperatives
    # the agent must ACT on (route the review per the chain; hand the finished work to the named
    # agent), not as passive labels it merely reads. `autonomy` stays ADVISORY: the real completion
    # gate is the container autonomy setting, so we mark it as such to kill the ambiguity (an
    # unvalidated free-text string must never read as a binding gate). Genuine server-side
    # enforcement (e.g. blocking /orcha-done until the chain is satisfied) is out of scope for this
    # pass and deliberately not implied.
    for label, key in (
            ("Review chain (BINDING — route reviews/sign-off through exactly this chain, in order)",
             "review_chain"),
            ("Hand off to (BINDING — when your part is materially done, hand the work to this agent "
             "via an Orcha request)", "handoff_to"),
            ("Autonomy (ADVISORY ONLY — the real gate is the container autonomy setting; never "
             "self-certify, stop at needs_verification for a human)", "autonomy"),
            ("Notes (BINDING instructions)", "notes")):
        v = p.get(key)
        if v:
            if not isinstance(v, str):
                v = json.dumps(v, ensure_ascii=False)
            lines.append(f"- {label}: {v}")
    return "\n".join(lines) if len(lines) > 1 else None


def format_persona(persona: Optional[dict], digest: Optional[dict],
                   protocol: Optional[dict] = None) -> Optional[str]:
    """Pure: assemble the --append-system-prompt text so a headless worker boots AS the
    agent. `persona` is GET /persona ({system_prompt,...}); `digest` is GET /digest
    ({digest: {...}|null}); `protocol` is GET /agents/{aid}/protocol ({protocol:{...}|null});
    any may be None. Returns the text, or None if nothing.

    This is what makes the spawned `claude -p` answer with the agent's judgment +
    reasoning continuity instead of as a generic Claude — persona from Epic A, the
    'where you left off' digest from Epic C.

    #325: when we're booting as a real agent (persona present) we always append the
    plain-language HUMAN_COMMS_GUARDRAIL, and — if the digest carried an `audience` slice
    — surface "Who you're talking to" AHEAD of the facts so the conversational register
    is set before the work state.

    #326 (A1): the task's standing protocol (RULES) rides AHEAD of / independent of the digest —
    it is human-authored and read fresh every wake, so an edit takes effect on the next wake. It
    lands after the guardrail and before the digest (rules frame the work before the recalled facts).
    """
    parts = []
    if persona and persona.get("system_prompt"):
        parts.append(persona["system_prompt"].strip())
    # #325: standing guardrail rides whenever we're actually booting as an agent.
    if parts:
        parts.append(HUMAN_COMMS_GUARDRAIL)
    # #326 (A1): RULES (protocol) ahead of the digest — read fresh every wake, human-editable.
    proto_section = _render_protocol(protocol)
    if proto_section:
        parts.append(proto_section)
    d = (digest or {}).get("digest")
    if d:
        # #325: lead with WHO the agent is talking to (their register) so tone is framed
        # before the facts that follow.
        aud = d.get("audience")
        if aud:
            if not isinstance(aud, str):
                aud = json.dumps(aud, ensure_ascii=False)
            parts.append("## Who you're talking to (carry this register — it survives across "
                         "wakes, not just the facts):\n" + aud)
        lines = ["## Where you left off (your latest memory digest — you are RESUMING as "
                 "this agent, not starting fresh):",
                 "Memory-digest guard: treat these items as prior reasoning, not live truth. "
                 "Any claim about external state (GitHub PR/issue status, Orcha task/request "
                 "status, who owes what, review state) is a pointer to re-check the source of "
                 "truth before acting or deciding there is nothing to do."]
        for label, key in (("Current focus", "current_focus"), ("Decisions", "decisions"),
                           ("Learnings", "learnings"), ("Open threads", "open_threads")):
            v = d.get(key)
            if v:
                if not isinstance(v, str):
                    v = json.dumps(v, ensure_ascii=False)
                lines.append(f"- {label}: {v}")
        if len(lines) > 1:
            parts.append("\n".join(lines))
    return "\n\n".join(parts) if parts else None


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
    """#285: return (persona, curated_digest) for an agent, served from the per-agent cache when a
    fresh-enough entry exists; otherwise fetch + curate and (re)populate the cache.

    force_fresh=True (the checkpoint/respawn path) bypasses the cache on read AND overwrites it on
    the fresh fetch, so a just-written continuity digest is served immediately — never stale.

    A transient fetch failure (either _get_json returns None) is NOT cached: pinning a missing
    persona/digest for the whole TTL would suppress real continuity on every wake in that window.
    A legitimately empty digest is the dict {"digest": null} (truthy), so this still caches the
    common no-snapshot-yet agent.
    """
    now = time.monotonic()
    if not force_fresh:
        cached = _PERSONA_CACHE.get(agent_id)
        if cached is not None and now < cached[0]:
            return cached[1], cached[2]
    persona = _get_json(f"{api_base}/api/agents/{agent_id}/persona")
    digest = _get_json(f"{api_base}/api/agents/{agent_id}/digest")
    if _digest_curate is not None:
        digest = _digest_curate.curate_injected_digest(
            digest, summarizer=_digest_curate.llm_summarizer)
    if persona is not None and digest is not None:
        _PERSONA_CACHE[agent_id] = (now + _PERSONA_CACHE_TTL_SECS, persona, digest)
    return persona, digest


def _build_persona(api_base: str, agent_id: str, *, task_id: Optional[str] = None,
                   force_fresh: bool = False) -> Optional[str]:
    """Fetch the agent's persona + latest digest + active-task protocol and format them for
    injection.

    GH #56 (Point 3 / FLAG 2a part d): `task_id` is the originating-task hint for this wake (the
    wake-scan candidate's `wake_task_id` — set from a request_answered event's originating_task_id).
    Passed through to the protocol GET so the RULES loaded are that task's, not a guess at the
    agent's "one in_progress task" (which serves the wrong protocol when several are in progress).
    None → the endpoint falls back to the in_progress guess (unchanged behaviour).

    #285: persona + the (#287-)curated digest are served from a short-TTL per-agent cache
    (_persona_and_digest) so close-together wakes don't re-GET + re-curate unchanged inputs.
    `force_fresh=True` (the checkpoint/respawn path) bypasses that cache so a freshly written
    continuity digest is never served stale.

    #287: the latest digest is CURATED for the boot copy only (dedup + clip + recency cap +
    byte ceiling, older tail folded into one LLM/breadcrumb summary) so a long-lived agent's
    per-wake injection cost stays bounded. The stored DB row is left full + verbatim — curation
    is a transport concern, not an edit to the agent's record (Epic C honesty boundary).

    #326 (A1): the protocol (RULES) is fetched fresh on EVERY wake — never cached — so a human
    edit applies on the next wake, independent of the (agent-authored, compressed) digest."""
    persona, digest = _persona_and_digest(api_base, agent_id, force_fresh=force_fresh)
    proto_url = f"{api_base}/api/agents/{agent_id}/protocol"
    if task_id:
        proto_url += f"?task_id={task_id}"
    protocol = _get_json(proto_url)
    return format_persona(persona, digest, protocol)


def spawn_headless(cwd: str, prompt: str, flags: Optional[str], dry_run: bool,
                   *, alias: Optional[str] = None,
                   system_prompt: Optional[str] = None,
                   model: Optional[str] = None,
                   runtime: Optional[str] = None,
                   resume_session_id: Optional[str] = None,
                   log_path: Optional[pathlib.Path] = None,
                   last_message_path: Optional[pathlib.Path] = None) -> tuple[bool, str, object]:
    """Fire-and-forget a one-shot coding-agent worker in `cwd`, booted AS `alias`.

    Claude models spawn `claude -p "<prompt>"`; Codex models spawn `codex exec "<prompt>"`.
    `system_prompt` (the agent's persona + digest, from _build_persona) is injected via
    Claude's `--append-system-prompt`, or prepended to the Codex exec prompt. `ORCHA_ALIAS=<alias>`
    in the env makes its work-skills/hooks resolve to that agent.
    #286: a Codex `resume_session_id` re-attaches the prior on-disk rollout via
    `codex exec resume <session_id>` so the conversation context (persona+digest+history,
    already in the rollout) is NOT re-injected — only the new turn(s) ride in `prompt`.
    Ignored for Claude (its warm path is the resident stdin session, spawn_resident).
    `log_path` (R2.4) captures the worker's stdout/stderr to a per-wake file so a
    misbehaving worker is diagnosable — the old DEVNULL made the runaway invisible.
    Returns (spawned, command-repr, proc) — proc is the Popen handle (None unless a
    process was started); the daemon tracks it and poll()s it to release the
    single-flight lease the moment it exits (poll reaps the zombie; a pid + kill(pid,0)
    check cannot, since a zombie still reports alive).
    """
    runtime = _normalize_runtime(runtime)
    extra = _runtime_extra_flags(runtime, flags)
    executable = _resolve_runtime_executable(runtime) or _runtime_executable(runtime)
    if runtime == RUNTIME_CODEX:
        # Codex's automation surface is `codex exec`; --json gives the same tailable JSONL
        # property the portal expects from Claude stream-json logs. There is no system-prompt
        # flag, so the agent persona/digest rides at the top of the initial instruction.
        # #286: `codex exec resume <session_id> <prompt>` re-attaches the prior rollout —
        # the conversation context is restored from disk, so `prompt` carries ONLY the new
        # turn(s) and `system_prompt` is NOT re-injected (the rollout already holds it). The
        # `resume <session_id>` token pair sits right after `exec`; the shared flags
        # (--json/--model/--output-last-message) are accepted on the resume subcommand too.
        argv = [executable, "exec"]
        if resume_session_id:
            argv += ["resume", resume_session_id]
        argv += ["--json", "--dangerously-bypass-approvals-and-sandbox",
                 "--skip-git-repo-check"]
        if model:
            argv += ["--model", model]
        if last_message_path:
            argv += ["--output-last-message", str(last_message_path)]
        argv.extend(extra)
        # On resume the rollout already holds persona+digest+history → pass the bare prompt
        # (no persona prefix); on a cold exec keep prepending persona/digest as before.
        argv.append(prompt if resume_session_id else _codex_prompt(prompt, system_prompt))
    else:
        # A1/ISS-17: stream-json + verbose so the per-wake log fills with newline-delimited
        # JSON events (each message, tool call, result) LIVE during the run — tailable. Plain
        # `claude -p` emits only an end-of-run text blob (often empty on a hang), so we could
        # never see what a worker was doing. --output-format stream-json requires --verbose.
        # ISS-#251: --include-partial-messages emits `stream_event` token/thinking deltas DURING
        # a turn's generation. Without it `claude -p` writes a complete assistant message only
        # when the turn FINISHES, so a worker thinking/generating for >stall_secs (e.g. reasoning
        # over a large tool_result before its next tool_use) goes log-silent and the stall
        # watchdog SIGKILLs it mid-work (reap_workers measures progress by log growth). The deltas
        # give the watchdog a genuine liveness heartbeat — a truly silent/dead worker still trips
        # the 120s stall — while _pump_one filters them out of the DB feed so the portal/SSE is
        # unchanged. The resident path already passes this flag (see spawn_resident).
        argv = [executable, "-p", prompt, "--output-format", "stream-json",
                "--include-partial-messages", "--verbose"]
        # GAP A (#136/ISS-58): boot the worker on the agent's selected model. wake-scan resolves a
        # retired/limited-availability id (e.g. Fable 5 after 2026-06-22) to the default server-side,
        # so by here `model` is always a currently-spawnable id (or None → claude's own default).
        if model:
            argv += ["--model", model]
        if system_prompt:
            argv += ["--append-system-prompt", system_prompt]
        # A daemon-spawned worker has NO tty to answer permission prompts, so it must run
        # non-interactively or it hangs forever on the first tool (the orcha skills curl the
        # API via Bash). Default to bypassing permission checks — this is a LOCAL, trusted
        # daemon spawning a registered agent, and the human still gates real outcomes via
        # /orcha-verify. A headless_flags that already sets a permission mode wins (no dup).
        if not any(f.startswith("--permission-mode") or f == "--dangerously-skip-permissions"
                   for f in extra):
            argv.append("--dangerously-skip-permissions")
        argv.extend(extra)
    persona_note = (
        " --append-system-prompt <persona+digest>"
        if system_prompt and runtime == RUNTIME_CLAUDE else ""
    )
    if system_prompt and runtime == RUNTIME_CODEX:
        persona_note = " <prompt includes persona+digest>"
    model_note = f" --model {model}" if model else ""
    perm_note = ""
    if runtime == RUNTIME_CODEX:
        perm_note = " --dangerously-bypass-approvals-and-sandbox"
    elif not any(f.startswith("--permission-mode") or f == "--dangerously-skip-permissions"
                 for f in extra):
        perm_note = " --dangerously-skip-permissions"
    log_note = f" >{log_path}" if log_path else ""
    last_note = f" --output-last-message {last_message_path}" if last_message_path else ""
    if runtime == RUNTIME_CODEX:
        resume_note = f" resume {resume_session_id}" if resume_session_id else ""
        # On resume the persona/history live in the restored rollout, not in the prompt.
        codex_persona_note = "" if resume_session_id else persona_note
        repr_ = (f"(cd {cwd} && ORCHA_ALIAS={alias or '?'} ORCHA_HEADLESS_WORKER=1 "
                 f"codex exec{resume_note} --json{perm_note} --skip-git-repo-check"
                 f"{model_note}{last_note}{codex_persona_note}"
                 f"{(' ' + ' '.join(extra)) if extra else ''}{log_note})")
    else:
        repr_ = (f"(cd {cwd} && ORCHA_ALIAS={alias or '?'} ORCHA_HEADLESS_WORKER=1 claude -p <prompt> "
                 f"--output-format stream-json --include-partial-messages --verbose"
                 f"{model_note}{persona_note}{perm_note}{(' ' + flags) if flags else ''}{log_note})")
    if dry_run:
        return False, repr_, None
    if (not _resolve_runtime_executable(runtime)
            or not cwd or not pathlib.Path(cwd).is_dir()):
        return False, repr_, None
    env = dict(os.environ)
    if alias:
        env["ORCHA_ALIAS"] = alias
    env["ORCHA_AGENT_RUNTIME"] = runtime
    # ISS-21: mark this as a headless wake worker so the interactive SessionStart hooks
    # (watch/rehydrate/notifier --ensure/reachability) short-circuit to a no-op. Without
    # this the worker runs `orcha watch --detach`, whose per-session poller never returns,
    # and the worker wedges before draining its inbox — completing zero work.
    env["ORCHA_HEADLESS_WORKER"] = "1"
    out = subprocess.DEVNULL
    if log_path is not None:
        try:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            out = open(log_path, "ab")
        except OSError:
            out = subprocess.DEVNULL
    try:
        proc = subprocess.Popen(argv, cwd=cwd, env=env, stdout=out,
                         stderr=subprocess.STDOUT if out is not subprocess.DEVNULL else subprocess.DEVNULL,
                         stdin=subprocess.DEVNULL, start_new_session=True)
        # Return the Popen handle (not just the pid): the daemon must poll()/reap it to
        # detect exit. An exited child is a ZOMBIE until its parent reaps it, and
        # os.kill(pid, 0) reports a zombie as alive — so pid-only liveness never frees
        # the lease. proc.poll() reaps the zombie and returns its exit code.
        return True, repr_, proc
    except (OSError, subprocess.SubprocessError):
        return False, repr_, None
    finally:
        # The child inherited its own dup of the fd; close the parent's copy.
        if out is not subprocess.DEVNULL:
            try:
                out.close()
            except OSError:
                pass


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
            or ("auto_wake" if cand.get("auto_wake_due") else None))  # #266: clock-driven heartbeat


# ---------- E3: the resident-session transport (a WARM, stdin-driven `claude`) ----------

def spawn_resident(cwd: str, *, system_prompt: Optional[str] = None,
                   log_path: Optional[pathlib.Path] = None,
                   resume_session_id: Optional[str] = None,
                   alias: Optional[str] = None, flags: Optional[str] = None,
                   model: Optional[str] = None,
                   runtime: Optional[str] = None,
                   dry_run: bool = False) -> tuple[bool, str, object]:
    """Boot a RESIDENT conversation session: `claude -p --input-format stream-json` with an
    OPEN stdin pipe, booted AS `alias`. Unlike the ephemeral headless worker (one-shot, stdin
    DEVNULL, prompt as argv), the resident reads successive user turns from stdin and stays warm
    across them in ONE claude session (E2 proved multi-turn warm context). It emits one
    stream-json `result` per turn; the manager (per the conversation-store contract) writes each
    human turn to stdin and captures the matching result as the agent's reply.

    COLD boot: pass `system_prompt` (persona+digest, plus V1 history prefix the manager appends)
    via --append-system-prompt. WARM restart: pass `resume_session_id` → --resume the pinned
    claude session (history already in-session; the manager injects NO history prefix then, to
    avoid double-injection — see the Vault E3 seam). Returns (spawned, repr, proc); proc.stdin
    is the live pipe the manager feeds with _send_user_turn."""
    runtime = _normalize_runtime(runtime)
    if runtime != RUNTIME_CLAUDE:
        repr_ = (f"(cd {cwd} && ORCHA_ALIAS={alias or '?'} codex resident "
                 f"[unsupported: no stdin stream-json protocol])")
        return False, repr_, None

    executable = _resolve_runtime_executable(RUNTIME_CLAUDE) or "claude"
    argv = [executable, "-p", "--input-format", "stream-json",
            "--output-format", "stream-json", "--include-partial-messages", "--verbose"]
    if resume_session_id:
        argv += ["--resume", resume_session_id]
    # GAP A/B: spawn on the agent's selected model (resolved server-side). A WARM --resume keeps
    # whatever model the pinned session booted with, so a model change forces a COLD boot upstream
    # (set_agent_model clears session_id) — by which point this `--model` takes effect on cold.
    if model:
        argv += ["--model", model]
    if system_prompt:
        argv += ["--append-system-prompt", system_prompt]
    extra = flags.split() if flags else []
    if not any(f.startswith("--permission-mode") or f == "--dangerously-skip-permissions"
               for f in extra):
        argv.append("--dangerously-skip-permissions")     # no tty to answer prompts (as headless)
    argv.extend(extra)
    mode = f"--resume {resume_session_id}" if resume_session_id else "cold"
    model_note = f" --model {model}" if model else ""
    repr_ = (f"(cd {cwd} && ORCHA_ALIAS={alias or '?'} ORCHA_HEADLESS_WORKER=1 claude -p "
             f"--input-format stream-json --output-format stream-json --include-partial-messages "
             f"--verbose [{mode}]{model_note}"
             f"{' --append-system-prompt <persona+digest+history>' if system_prompt else ''}"
             f"{(' ' + flags) if flags else ''}{f' >{log_path}' if log_path else ''})")
    if dry_run:
        return False, repr_, None
    if (not _resolve_runtime_executable(RUNTIME_CLAUDE)
            or not cwd or not pathlib.Path(cwd).is_dir()):
        return False, repr_, None
    env = dict(os.environ)
    if alias:
        env["ORCHA_ALIAS"] = alias
    env["ORCHA_HEADLESS_WORKER"] = "1"      # ISS-21: short-circuit interactive SessionStart hooks
    out = subprocess.DEVNULL
    if log_path is not None:
        try:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            out = open(log_path, "ab")
        except OSError:
            out = subprocess.DEVNULL
    try:
        proc = subprocess.Popen(
            argv, cwd=cwd, env=env, stdout=out,
            stderr=subprocess.STDOUT if out is not subprocess.DEVNULL else subprocess.DEVNULL,
            stdin=subprocess.PIPE, start_new_session=True)   # OPEN stdin — the warm input channel
        return True, repr_, proc
    except (OSError, subprocess.SubprocessError):
        return False, repr_, None
    finally:
        if out is not subprocess.DEVNULL:
            try:
                out.close()
            except OSError:
                pass


def _send_user_turn(proc, content: str) -> bool:
    """Write ONE user turn to the resident's stdin as a stream-json NDJSON line (the exact shape
    E2 proved: type=user, message.role=user, content=[{type:text,text:…}]). The resident answers
    in-session and emits a `result`; stdin stays OPEN for the next turn (closing it = graceful EOF
    → claude exits → SessionEnd/C1 runs). Returns False if the pipe is gone (resident died)."""
    if proc is None or getattr(proc, "stdin", None) is None:
        return False
    line = json.dumps({"type": "user",
                       "message": {"role": "user",
                                   "content": [{"type": "text", "text": content}]}}) + "\n"
    try:
        proc.stdin.write(line.encode())
        proc.stdin.flush()
        return True
    except (BrokenPipeError, OSError, ValueError):
        return False


def _extract_session_id(log_path) -> Optional[str]:
    """E3: claude assigns the session_id and stamps it on every stream-json event (the `system`
    init line is the first). The manager reads it from the head of the log after a COLD boot and
    pins it via POST /conversations/{id}/session so a later warm restart can --resume the same
    session. Returns the first session_id seen, or None if not emitted yet / unreadable."""
    if not log_path:
        return None
    try:
        with open(log_path, "rb") as f:
            head = f.read(65536)             # the init/system line is at the very top
    except OSError:
        return None
    for raw in head.split(b"\n"):
        s = raw.strip()
        if not s:
            continue
        try:
            obj = json.loads(s)
        except ValueError:
            continue                         # partial head line — try the next
        sid = obj.get("session_id")
        if sid:
            return sid
    return None


def _extract_codex_session_id(log_path) -> Optional[str]:
    """#286: pull the Codex session/rollout id from a `codex exec --json` log so a later turn can
    `codex exec resume <session_id>` instead of re-injecting the full thread history.

    Codex stamps the id on an early event; the exact event/key spelling varies across Codex
    versions and could NOT be empirically pinned here (codex is not installed on this host —
    Invy's feasibility caveat, task ff19f91c), so this scans the head TOLERANTLY for any of the
    known carriers — top-level `session_id`/`thread_id`/`conversation_id`, or nested under a
    `msg`/`session` object (e.g. the `session_configured` event). Returns the first id found, or
    None. A None (or a non-UUID the pin endpoint rejects) simply leaves the conversation on the
    cold full-history path — the #286 fail-open contract."""
    if not log_path:
        return None
    try:
        with open(log_path, "rb") as f:
            head = f.read(65536)             # the session event is at the very top
    except OSError:
        return None

    def _id_from(obj) -> Optional[str]:
        if not isinstance(obj, dict):
            return None
        for key in ("session_id", "thread_id", "conversation_id"):
            val = obj.get(key)
            if isinstance(val, str) and val:
                return val
        for nest in ("msg", "session", "payload"):
            found = _id_from(obj.get(nest))
            if found:
                return found
        return None

    for raw in head.split(b"\n"):
        s = raw.strip()
        if not s:
            continue
        try:
            obj = json.loads(s)
        except ValueError:
            continue                         # partial head line — try the next
        sid = _id_from(obj)
        if sid:
            return sid
    return None


def _result_after(log_path, start_offset: int = 0) -> Optional[dict]:
    """E3 reply-capture: find the FIRST terminal `result` event at/after `start_offset` bytes —
    the boundary that ends the turn the manager just fed. Returns {text, subtype, num_turns,
    session_id, end_offset} (end_offset = byte position just past the result line, so the next
    turn scans from there), or None if the turn hasn't finished (no complete result line yet)."""
    if not log_path:
        return None
    try:
        with open(log_path, "rb") as f:
            f.seek(start_offset)
            chunk = f.read()
    except OSError:
        return None
    off = start_offset
    for raw in chunk.split(b"\n"):
        advance = len(raw) + 1               # bytes consumed incl. the trailing newline
        s = raw.strip()
        if s:
            try:
                obj = json.loads(s)
            except ValueError:
                obj = None                   # a still-being-written final line → not done yet
            if obj and obj.get("type") == "result":
                return {"text": obj.get("result"), "subtype": obj.get("subtype"),
                        "num_turns": obj.get("num_turns"), "session_id": obj.get("session_id"),
                        "end_offset": off + advance}
        off += advance
    return None


# ---------- one tick ----------

def _result_status(log_path) -> Optional[str]:
    """ISS-29: return the subtype of a terminal stream-json `result` event if the worker has
    COMPLETED its agent loop (e.g. 'success', 'error_max_turns'), else None.

    `claude -p --output-format stream-json` emits exactly one `result` object as the FINAL
    NDJSON line. Once it's present the run has finished — a still-alive process is merely slow
    to exit (a known linger on long headless sessions). Such a worker must NOT be reaped as
    'killed', and its SessionEnd hook (the C1 digest) deserves a window to run. We read only
    the log's tail (the result line is small) and inspect the LAST complete line: a truncated
    final line means claude is still mid-write → not done yet."""
    if not log_path:
        return None
    try:
        with open(log_path, "rb") as f:
            f.seek(0, os.SEEK_END)
            end = f.tell()
            f.seek(max(0, end - 65536))      # tail is plenty; result lines are small
            tail = f.read()
    except OSError:
        return None
    for raw in reversed(tail.split(b"\n")):
        s = raw.strip()
        if not s:
            continue
        try:
            obj = json.loads(s)
        except ValueError:
            return None                       # last line still being written → not complete
        return obj.get("subtype") if obj.get("type") == "result" else None
    return None


def _last_event_type(log_path) -> Optional[str]:
    """#270: the `type` of the LAST complete stream-json line in the worker log, or None.

    Part of the watchdog kill diagnostic: it explains what the worker was doing when it went
    log-silent — an 'assistant' (mid tool_use), a 'stream_event' (mid token/thinking generation),
    a 'rate_limit_event' (backing off a 429), or 'result' (already finished). We scan the tail in
    reverse and skip any garbled/partial trailing line (a still-being-written final line)."""
    if not log_path:
        return None
    try:
        with open(log_path, "rb") as f:
            f.seek(0, os.SEEK_END)
            end = f.tell()
            f.seek(max(0, end - 65536))      # tail is plenty; we only want the last line's type
            tail = f.read()
    except OSError:
        return None
    for raw in reversed(tail.split(b"\n")):
        s = raw.strip()
        if not s:
            continue
        try:
            return json.loads(s).get("type")
        except ValueError:
            continue                          # partial/garbled line — fall back to the previous
    return None


def _worker_is_live(log_path) -> bool:
    """ISS-45: liveness probe for the STALL watchdog. A worker whose stream-json log has
    stopped growing is NOT necessarily stalled — output-silence ≠ death. Two common cases are
    a worker that is very much alive yet legitimately quiet:

      * an IN-FLIGHT tool call — `claude -p` emits the assistant `tool_use` immediately, but
        the matching `tool_result` only lands when the subprocess returns, so the log freezes
        for the whole duration of a long `Bash` (build, big `git`, a sleep, a slow `curl`);
      * a RATE-LIMIT backoff — a top-level `{"type":"rate_limit_event", ...}` then silence
        while claude sleeps off a 429 before resuming.

    The old size-only heuristic mistook both for a stall and SIGKILLed the worker mid-work
    (Invy run 5a9c7cbe: a long command + 2 rate_limit_events → >120s no growth → killed at
    ~11min, no result, C1 digest lost). Return True if the log's tail shows either signal so
    the stall kill is suppressed. This only governs the STALL path — the 1200s hard-cap
    backstop still reaps a genuinely-hung worker even while it looks 'live'.

    Detecting an outstanding tool call must NOT assume the blocks carry ids. `claude -p` does
    emit `tool_use.id` / `tool_result.tool_use_id` in the wild, but other real-shaped streams
    (and our own fixtures) carry NO ids — and an id-only pairing would miss the exact ISS-45
    case there, stall-killing the worker anyway. So we read three shape-agnostic signals over
    the tail and treat ANY as 'alive' (a false 'alive' merely defers the kill to the 1200s hard
    cap; a false 'stalled' is the bug we're fixing):
      * id pairing — `tool_use` ids not yet seen as a `tool_result` id (precise, orphan-safe
        when ids exist);
      * count — more `tool_use` blocks than `tool_result` blocks (covers no-id + parallel calls);
      * order — the LAST tool-related block in the stream is a `tool_use` (covers a no-id call
        in flight at the tail, even when an orphan result earlier balances the count).
    A `tool_result` always follows its `tool_use`, so an orphan result whose `tool_use` scrolled
    out of the tail can't fabricate a false in-flight under any of the three."""
    if not log_path:
        return False
    try:
        with open(log_path, "rb") as f:
            f.seek(0, os.SEEK_END)
            end = f.tell()
            f.seek(max(0, end - 262144))     # 256KB tail: ample to pair recent tool calls
            tail = f.read()
    except OSError:
        return False
    tool_use_ids: set = set()
    tool_result_ids: set = set()
    use_count = result_count = 0
    last_tool_block = None                    # 'use' | 'result' — last tool-related block seen
    last_type = None
    for raw in tail.split(b"\n"):
        s = raw.strip()
        if not s:
            continue
        try:
            obj = json.loads(s)
        except ValueError:
            continue                          # partial/garbled line (e.g. truncated tail head)
        etype = obj.get("type")
        last_type = etype
        content = (obj.get("message") or {}).get("content") if isinstance(obj.get("message"), dict) else None
        if etype == "assistant" and isinstance(content, list):
            for blk in content:
                if isinstance(blk, dict) and blk.get("type") == "tool_use":
                    use_count += 1
                    last_tool_block = "use"
                    if blk.get("id"):
                        tool_use_ids.add(blk["id"])
        elif etype == "user" and isinstance(content, list):
            for blk in content:
                if isinstance(blk, dict) and blk.get("type") == "tool_result":
                    result_count += 1
                    last_tool_block = "result"
                    if blk.get("tool_use_id"):
                        tool_result_ids.add(blk["tool_use_id"])
    if last_type == "rate_limit_event":
        return True                           # mid-backoff on a 429 — alive, just sleeping
    if tool_use_ids - tool_result_ids:        # id pairing: an unanswered tool_use id
        return True
    if use_count > result_count:              # count: more calls issued than answered (no-id safe)
        return True
    return last_tool_block == "use"           # order: tail ends on an unanswered tool_use


def _kill_worker(proc, graceful: bool = False, grace_secs: float = 10.0) -> None:
    """Kill a worker's whole process GROUP, then reap the leader.

    Workers are spawned with start_new_session=True, so each is its own session +
    process-group leader (pgid == pid) and claude's grandchildren (tool subprocesses
    — e.g. the `bash` that runs the orcha `curl`s) inherit that group. A bare
    proc.kill() SIGKILLs only the claude pid and leaves those grandchildren orphaned
    and ALIVE, so a timed-out worker could keep doing work while the daemon green-lit a
    replacement (ISS-15 P1). Signal the GROUP so the whole tree dies.

    `graceful=True` (ISS-29 completion path AND ISS-45 watchdog kills) sends SIGTERM to the
    group first and gives it `grace_secs` to unwind — so claude's SessionEnd hook (the C1
    continuity-digest write-on-exit) gets to run — escalating to SIGKILL only if it ignores the
    term. A hard SIGKILL is what was eating the digest before: on a finished-but-lingering
    worker (ISS-29) and, worse, on a stall/hard-cap kill of a still-working worker (ISS-45),
    where the digest is the only record of what it did. So EVERY watchdog kill is graceful —
    a genuinely-hung worker that ignores SIGTERM is still SIGKILLed after the window."""
    try:
        pgid = os.getpgid(proc.pid)
    except (ProcessLookupError, OSError):
        pgid = proc.pid                      # start_new_session => pgid == pid anyway
    if graceful:
        try:
            os.killpg(pgid, signal.SIGTERM)  # let SessionEnd (C1 digest) run before we force it
        except (ProcessLookupError, PermissionError, OSError):
            pass
        try:
            proc.wait(timeout=grace_secs)
            return                           # exited on SIGTERM — clean teardown, no SIGKILL
        except Exception:
            pass                             # ignored the term → fall through to SIGKILL
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.kill()                      # fallback: at least kill the leader
        except OSError:
            pass
    try:
        proc.wait(timeout=5)                 # reap the leader so it doesn't linger as a zombie
    except Exception:
        pass


def _capture_run_output(log_path, cap: int = 200_000):
    """A2: read the per-wake stream-json log (tail-capped) so the API can persist it.
    The daemon has FS access to the host log; the portal (different container) does not,
    so the text is sent on /finish. Returns None if there's no log / it can't be read."""
    if not log_path:
        return None
    try:
        data = pathlib.Path(log_path).read_bytes()
    except OSError:
        return None
    if len(data) > cap:
        data = b"...[truncated]...\n" + data[-cap:]
    return data.decode("utf-8", "replace")


def _usage_from_log(log_path) -> dict:
    """#289 (efficiency measurement backbone): extract the TOKEN usage of a finished wake from
    its stream-json log. `claude -p --output-format stream-json` emits exactly one terminal
    `result` event whose `usage` object carries input_tokens / output_tokens /
    cache_creation_input_tokens / cache_read_input_tokens (cumulative for the invocation) plus a
    top-level `total_cost_usd`. The reply-capture path (_result_after) read that event for text
    and dropped the usage; this reads the SAME terminal event (from the log tail — result lines
    are small) for the five accounting fields. Returns a dict with those keys (any absent → None
    so a malformed / pre-result log degrades to NULL, never a crash). Empty dict if no log /
    unreadable / no complete result line yet.

    Caveat (documented V2): a resident worker that handled multiple turns in one process logs one
    result event per turn; we read the LAST, i.e. the cumulative usage of its final turn. For the
    ephemeral headless worker — the dominant per-wake cost and the control-project case — there is
    exactly one result event, so this IS the whole wake."""
    keys = ("input_tokens", "output_tokens", "cache_read_input_tokens",
            "cache_creation_input_tokens", "total_cost_usd")
    if not log_path:
        return {}
    try:
        with open(log_path, "rb") as f:
            f.seek(0, os.SEEK_END)
            end = f.tell()
            f.seek(max(0, end - 65536))      # tail is plenty; result lines are small
            tail = f.read()
    except OSError:
        return {}
    for raw in reversed(tail.split(b"\n")):
        s = raw.strip()
        if not s:
            continue
        try:
            obj = json.loads(s)
        except ValueError:
            return {}                         # last line still being written → not complete
        if obj.get("type") == "result":
            usage = obj.get("usage") or {}
            out = {k: usage.get(k) for k in keys[:4]}
            out["total_cost_usd"] = obj.get("total_cost_usd")
            return out
    return {}


def _finish_run(api_base: str, run_id, status: str, exit_code, log_path, diff=None,
                kill_reason=None) -> None:
    """A2/ISS-8: record a run's terminal state + captured stream-json output + net git
    diff via the API (no direct DB). #270: `kill_reason` is a structured JSON diagnostic the
    stall/hard-cap watchdog attaches when it kills a worker — NULL on every clean path.
    #289: also attaches the wake's token usage (parsed from the same log) for the meter."""
    if not run_id:
        return
    _post_json(f"{api_base}/api/runs/{run_id}/finish",
               {"status": status, "exit_code": exit_code,
                "output": _capture_run_output(log_path), "diff": diff,
                "kill_reason": kill_reason, **_usage_from_log(log_path)})


def _run_pid_alive(pid) -> bool:
    """919050a5: is this HOST run pid a live process? Only the notifier can ask (the API runs in
    Docker and can't see host PIDs). A NULL/0 pid is treated as dead (unknown == not provably alive,
    so it gets reaped). A PermissionError means the pid exists but is owned by another user → alive
    (distinct from the daemon-singleton `_pid_alive`, which only cares about its OWN pid). NOTE:
    deliberately a separate helper from `_pid_alive` — same-name shadowing would silently change
    daemon_running()'s 0/perm semantics."""
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except (OSError, ValueError, TypeError):
        return False


def _reap_dead_pid_resident_runs(api_base: str, aid: str, live_pids=frozenset(),
                                 *, quiet: bool = True) -> int:
    """919050a5: cross-daemon single-flight + fast liveness release. Read this agent's RUNNING
    resident runs and their host pids; for any whose process is dead, reconcile it. This is the only
    truth that survives daemon turnover / cross-worktree double-daemons: the shared DB row + a host
    os.kill(pid,0). `live_pids` = pids THIS daemon knows are alive (its own live_residents) — never
    reaped even if os.kill momentarily races. Behaviour:
      * NO live process backs the lease  → release the resident wake-lease (the server reconciles
        the agent's running runs to 'orphaned', e4b77f3f) so suppressed event wakes resume in
        SECONDS, not the >1260s ISS-60-B heartbeat window.
      * a live sibling DOES exist (true double-spawn) → finish ONLY the dead orphan rows (killed),
        keep the lease the live resident still renews. Never two running resident rows per agent.
    Returns the number of dead runs reaped."""
    data = _get_json(f"{api_base}/api/agents/{aid}/resident-runs?status=running") or {}
    runs = data.get("runs", [])
    if not runs:
        return 0
    def _alive(r):
        pid = r.get("pid")
        return (pid in live_pids) or _run_pid_alive(pid)
    dead = [r for r in runs if not _alive(r)]
    if not dead:
        return 0
    live_sibling = any(_alive(r) for r in runs)
    if live_sibling:
        for r in dead:
            _finish_run(api_base, r.get("run_id"), "killed", -1, None)
    else:
        _post_json(f"{api_base}/api/agents/{aid}/wake-ack",
                   {"kind": "resident_dead_pid", "release_lease": True})
    if not quiet:
        print(f"[notifier] reaped {len(dead)} dead-pid resident run(s) for {aid} "
              f"({'kept lease (live sibling)' if live_sibling else 'released lease'})")
    return len(dead)


# ---------- ISS-8: per-worker git worktree isolation + net-diff capture ----------

def _run_git(args, cwd=None, timeout: float = 30.0):
    """Run a git command; return (returncode, stdout). Never raises."""
    try:
        out = subprocess.run(["git", *args], cwd=cwd, capture_output=True,
                             text=True, timeout=timeout)
        return out.returncode, out.stdout
    except (OSError, subprocess.SubprocessError):
        return 1, ""


def _safe_ref(alias) -> str:
    """A git-ref-safe, filesystem-safe slug from a display alias. Aliases aren't
    constrained to ref-legal text ('QA Bot', 'bad..ref', 'x~y', 'x:y'), and a bad branch
    name would make `git worktree add -b` fail → silent fallback to the shared checkout
    (defeating isolation). Map anything outside [A-Za-z0-9._-] to '-', collapse dots
    (kills '..'), strip leading/trailing '.'/'-'."""
    s = re.sub(r"[^A-Za-z0-9._-]", "-", str(alias or "agent"))
    s = re.sub(r"\.+", ".", s).strip(".-")
    return s or "agent"


def _ensure_worktree_exclude(base_cwd) -> None:
    """Add `.orcha-worktrees/` to the repo-local git exclude so a base-checkout
    `git add -A` can't stage a LIVE worker worktree as an embedded repo/gitlink during
    the concurrency window (would pollute commits in the shared checkout)."""
    rc, gitdir = _run_git(["rev-parse", "--git-common-dir"], cwd=base_cwd)
    if rc != 0:
        return
    gitdir = gitdir.strip()
    excl = pathlib.Path(gitdir if os.path.isabs(gitdir) else os.path.join(base_cwd, gitdir)) / "info" / "exclude"
    try:
        excl.parent.mkdir(parents=True, exist_ok=True)
        existing = excl.read_text() if excl.exists() else ""
        if ".orcha-worktrees/" not in existing.split():
            with open(excl, "a") as f:
                f.write(("" if existing.endswith("\n") or not existing else "\n")
                        + "# orcha: isolated headless-worker worktrees (never commit)\n.orcha-worktrees/\n")
    except OSError:
        pass


def _provision_worktree(base_cwd, alias):
    """Create an isolated git worktree off origin/main for a CODE-TOUCHING worker, so
    concurrent workers don't tangle in the shared checkout (ISS-8). Overlays the runtime
    .claude/orcha.json + orcha-tabs (gitignored — absent from a fresh checkout) so the
    worker can still resolve its binding + reach the API. Returns (worktree_path, branch),
    or (None, None) on any failure (caller falls back to the shared cwd)."""
    if not base_cwd or _run_git(["rev-parse", "--git-dir"], cwd=base_cwd)[0] != 0:
        return None, None
    base = pathlib.Path(base_cwd)
    _ensure_worktree_exclude(base_cwd)   # keep .orcha-worktrees/ out of the base checkout's index
    # ref-safe slug independent of the (possibly ref-illegal) display alias
    stamp = f"{_safe_ref(alias)}-{int(time.time() * 1000)}"
    branch = f"orcha/wk-{stamp}"
    wt = base / ".orcha-worktrees" / stamp
    _run_git(["fetch", "origin", "main"], cwd=base_cwd, timeout=60)   # best-effort fresh base
    rc, _ = _run_git(["worktree", "add", "-b", branch, str(wt), "origin/main"],
                     cwd=base_cwd, timeout=60)
    if rc != 0:
        return None, None
    _overlay_runtime_config(base, wt)
    return str(wt), branch


def _overlay_runtime_config(base, wt):
    """Overlay the gitignored runtime config (.claude/orcha.json + orcha-tabs + settings.json)
    that a fresh checkout lacks, so a worker/resident in the worktree resolves its binding,
    reaches the API, AND fires its notification hooks."""
    dst = wt / ".claude"
    dst.mkdir(parents=True, exist_ok=True)
    cfg = base / ".claude" / "orcha.json"
    if cfg.exists():
        try:
            shutil.copy2(cfg, dst / "orcha.json")
        except OSError:
            pass
    # settings.json carries the SessionEnd `orcha snapshot` hook (C1 continuity, _write_hook_config).
    # It's gitignored, so a worktree checked out from origin/main lacks it → claude there has no
    # SessionEnd hook → snapshot-on-exit never runs (silent for headless workers AND the S3 live
    # terminal, whose bridge delegates snapshot-on-close to exactly this hook). Overlay it too.
    settings = base / ".claude" / "settings.json"
    if settings.exists():
        try:
            shutil.copy2(settings, dst / "settings.json")
        except OSError:
            pass
    tabs = base / ".claude" / "orcha-tabs"
    if tabs.is_dir():
        (dst / "orcha-tabs").mkdir(parents=True, exist_ok=True)
        for f in tabs.iterdir():
            if f.is_file():
                try:
                    shutil.copy2(f, dst / "orcha-tabs" / f.name)
                except OSError:
                    pass


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
    """ISS-61: a STABLE per-conversation worktree (deterministic path, REUSED across boots) — vs
    _provision_worktree's fresh-per-call path. `claude --resume <sid>` keys its session storage by
    the CWD, so a new worktree path every reboot (the #149 regression) made --resume fail
    (error_during_execution) and crash-loop. A stable path keeps the session resumable. Created
    once; reused on later boots; removed only when the conversation ENDS. (None, None) on failure."""
    if not base_cwd or _run_git(["rev-parse", "--git-dir"], cwd=base_cwd)[0] != 0:
        return None, None
    base = pathlib.Path(base_cwd)
    _ensure_worktree_exclude(base_cwd)
    slug = _safe_ref(conv_id)
    branch = f"orcha/resident-{slug}"
    wt = base / ".orcha-worktrees" / f"resident-{slug}"
    if wt.exists():
        return str(wt), branch                       # reuse → stable cwd → --resume works
    _run_git(["fetch", "origin", "main"], cwd=base_cwd, timeout=60)
    rc, _ = _run_git(["worktree", "add", "-b", branch, str(wt), "origin/main"], cwd=base_cwd, timeout=60)
    if rc != 0:
        # the branch may survive a pruned dir from a prior boot — reuse it rather than fail
        rc, _ = _run_git(["worktree", "add", str(wt), branch], cwd=base_cwd, timeout=60)
        if rc != 0:
            return None, None
    _overlay_runtime_config(base, wt)
    return str(wt), branch


def _provision_live_worktree(base_cwd, alias):
    """ISS-67/B2: a STABLE per-agent worktree for the S3 LIVE terminal embodiment — a deterministic
    path REUSED across reopens (vs _provision_worktree's fresh-timestamp-per-call path, which made
    every terminal reopen pay a fresh `git worktree add` + a cold `claude` re-injection — the
    reopen-latency this fixes). A stable path is the PREREQUISITE for the bridge's grace-window
    keepalive (B1: a reopen reattaches the SAME warm claude+PTY+CWD instantly): the warm claude's
    CWD *is* this worktree, so reattach is only coherent if the path persists. It also lets a
    human's in-progress edits survive a reconnect — a re-provision returns the SAME dir, and a
    grace-expiry teardown that finds it dirty PRESERVES it (safe_teardown_worktree), so the next
    open reuses those edits. Created once; reused while it exists; (None, None) on failure → the
    caller falls back to the shared checkout (today's in-place behavior)."""
    if not base_cwd or _run_git(["rev-parse", "--git-dir"], cwd=base_cwd)[0] != 0:
        return None, None
    base = pathlib.Path(base_cwd)
    _ensure_worktree_exclude(base_cwd)
    slug = _safe_ref(alias)
    branch = f"orcha/live-{slug}"
    wt = base / ".orcha-worktrees" / f"live-{slug}"
    if wt.exists():
        return str(wt), branch                       # reuse → stable cwd → reattach/edits persist
    _run_git(["fetch", "origin", "main"], cwd=base_cwd, timeout=60)
    rc, _ = _run_git(["worktree", "add", "-b", branch, str(wt), "origin/main"], cwd=base_cwd, timeout=60)
    if rc != 0:
        # the branch may survive a pruned dir from a prior session — reuse it rather than fail
        rc, _ = _run_git(["worktree", "add", str(wt), branch], cwd=base_cwd, timeout=60)
        if rc != 0:
            return None, None
    _overlay_runtime_config(base, wt)
    return str(wt), branch


# the runtime config we overlay into a worktree (see _provision_worktree) is NOT the
# worker's change — exclude it from the captured diff so it's not noise.
_DIFF_EXCLUDES = ("." , ":(exclude).claude/orcha.json", ":(exclude).claude/orcha-tabs")


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


def _teardown_worktree(base_cwd, worktree, branch):
    """Remove the worktree dir on finish. Keep the branch if it has commits beyond
    origin/main (PR-ready); delete it otherwise (nothing worth keeping)."""
    if not worktree:
        return
    has_commits = False
    if branch:
        rc, out = _run_git(["rev-list", "--count", f"origin/main..{branch}"], cwd=base_cwd)
        has_commits = rc == 0 and out.strip().isdigit() and int(out.strip()) > 0
    _run_git(["worktree", "remove", "--force", worktree], cwd=base_cwd)
    if branch and not has_commits:
        _run_git(["branch", "-D", branch], cwd=base_cwd)


def _is_git_repo(cwd) -> bool:
    """True if `cwd` is inside a git work tree (so there's a shared checkout to isolate from)."""
    return bool(cwd) and _run_git(["rev-parse", "--git-dir"], cwd=cwd)[0] == 0


def _worktree_is_dirty(worktree) -> bool:
    """True if the worktree has uncommitted changes (staged, unstaged, or untracked)."""
    if not worktree:
        return False
    rc, out = _run_git(["status", "--porcelain"], cwd=worktree)
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


def _is_stream_event_line(line: str) -> bool:
    """ISS-#251: True for a `--include-partial-messages` `stream_event` partial-delta line.

    These token/thinking deltas exist in the host log purely so the stall watchdog (reap_workers,
    which measures progress by log growth) sees a heartbeat while a worker is mid-generation. They
    must NOT be persisted to the DB line feed — at one line per token they would flood
    worker_run_lines and the portal SSE. Fail soft: a non-JSON line is treated as NOT a partial
    (kept), matching _pump_one's prior 'keep every non-blank line' behavior."""
    try:
        return json.loads(line).get("type") == "stream_event"
    except (ValueError, AttributeError):
        return False


def _pump_one(api_base: str, aid: str, w: dict) -> None:
    """ISS-39: stream a running worker's NEW stream-json lines into the DB.

    The DAEMON reads its OWN host log (zero mount lag) and POSTs complete NDJSON lines to
    `/api/runs/<run_id>/lines`; the portal's SSE endpoint then tails the worker_run_lines
    TABLE instead of the bind-mounted file — whose growth the long-lived portal process sees
    through the macOS Docker VirtioFS attribute cache with a 1-5s lag that dropped lines
    mid-window ('seq 1 then stall'). Per-worker cursor: lines_offset (bytes consumed),
    lines_buf (the unterminated trailing line), lines_seq (next seq to assign).

    On a failed POST we DON'T advance the cursor, so the same bytes are retried next tick —
    safe because the insert is idempotent on (run_id, seq)."""
    lp = w.get("log_path")
    run_id = w.get("run_id")
    if not lp or not run_id:
        return
    offset = w.get("lines_offset", 0)
    try:
        with open(lp, "rb") as f:
            f.seek(offset)
            data = f.read()
    except OSError:
        return                       # log not created yet — try again next tick
    if not data:
        return
    buf = w.get("lines_buf", b"") + data
    *complete, tail = buf.split(b"\n")
    if not complete:
        # only a partial line so far — buffer it and advance past the bytes we've absorbed
        w["lines_offset"] = offset + len(data)
        w["lines_buf"] = tail
        return
    lines = [c.decode("utf-8", "replace").rstrip("\r") for c in complete]
    lines = [ln for ln in lines if ln.strip()]
    # ISS-#251: drop partial `stream_event` deltas from the DB feed (they stay in the host log for
    # the stall watchdog's liveness check, but persisting one row per token would flood the feed).
    lines = [ln for ln in lines if not _is_stream_event_line(ln)]
    start_seq = w.get("lines_seq", 1)
    if lines:
        resp = _post_json(f"{api_base}/api/runs/{run_id}/lines",
                          {"start_seq": start_seq, "lines": lines})
        if resp is None:
            return                   # POST failed — leave the cursor; retry same bytes next tick
        w["lines_seq"] = start_seq + len(lines)
    # advance only after a successful POST (or when the batch was all-blank)
    w["lines_offset"] = offset + len(data)
    w["lines_buf"] = tail


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
                                         runtime=ctx.get("model_runtime"),
                                         log_path=log_path)
    if not (sent and newproc is not None):
        # Respawn failed to spawn — don't strand the agent holding a worktree + lease forever.
        _teardown_worktree(base_cwd, worktree, branch)
        _post_json(f"{api_base}/api/agents/{aid}/wake-ack",
                   {"kind": "worker_checkpoint_respawn_failed", "release_lease": True})
        live_workers.pop(aid, None)
        if not quiet:
            print(f"[notifier] checkpoint-respawn for {aid} FAILED to spawn a fresh worker — "
                  f"worktree torn down + lease released")
        return

    run = _post_json(f"{api_base}/api/agents/{aid}/runs",
                     {"wake_kind": "ephemeral", "wake_event": "checkpoint_respawn",
                      "task_id": ctx.get("task_id"),
                      "log_path": str(log_path) if log_path else None,
                      "pid": newproc.pid, "runtime": ctx.get("model_runtime"),
                      "worktree": worktree, "branch": branch, "base_cwd": base_cwd})
    now = time.time()
    live_workers[aid] = {
        "proc": newproc,
        "hard_deadline": now + cap,
        "last_size": 0, "last_progress_ts": now,
        "run_id": (run or {}).get("run_id"), "log_path": log_path,
        "worktree": worktree, "branch": branch, "base_cwd": base_cwd,
        "lines_offset": 0, "lines_seq": 1, "lines_buf": b"",
        # GH #58: the original wake's handled-set rides the respawn so the FINAL clean exit acks it
        # (the checkpoint-respawn finishes the old run but the wake's work is still in flight).
        "handled_event_ids": ctx.get("handled_event_ids") or w.get("handled_event_ids") or [],
        "cap": cap, "respawns": n, "respawn_ctx": ctx}
    # Non-releasing ack: keep the single-flight lease (the new worker continues under it) but
    # record the checkpoint for portal/event visibility + refresh the cooldown debounce.
    _post_json(f"{api_base}/api/agents/{aid}/wake-ack",
               {"kind": "worker_checkpoint_respawn", "release_lease": False})
    if not quiet:
        print(f"[notifier] worker for {aid} (pid {proc.pid}) crossed the soft hard-cap while "
              f"still progressing — checkpointed (C1 digest) + respawned (pid {newproc.pid}, "
              f"respawn {n}/{HARD_CAP_RESPAWN_MAX}) on the same worktree")


def reap_workers(api_base: str, live_workers: dict, quiet: bool, stall_secs: float = 120.0) -> None:
    """R2.4 reaper + ISS-15/ISS-31 watchdog: for each tracked worker, either release its
    lease on clean exit OR kill it — but kill on STALL, not a fixed deadline. A2: finishes
    the worker_runs row (status + output + ISS-8 diff) on the way out.

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
    now = time.time()
    for aid, w in list(live_workers.items()):
        proc = w["proc"]
        # ISS-39: flush the worker's latest stream-json lines to the DB every tick (this is the
        # live feed) AND right before any finish below — the daemon posts a run's final lines
        # before its status flips, so the SSE never emits `done` ahead of a tail line.
        _pump_one(api_base, aid, w)
        if proc.poll() is not None:    # exited — poll() has reaped the zombie
            diff = _capture_diff(w.get("worktree"))
            _finish_run(api_base, w.get("run_id"), "exited", proc.returncode, w.get("log_path"), diff)
            _teardown_worktree(w.get("base_cwd"), w.get("worktree"), w.get("branch"))
            # GH #58: on a CLEAN exit (rc 0) record the per-event handled-set this run drained so it
            # stops re-waking — the server then advances delivered_ts to the contiguous floor (events
            # the run could NOT handle stay pending and re-surface). A non-zero exit marks nothing.
            if proc.returncode == 0:
                _post_json(f"{api_base}/api/agents/{aid}/events/ack-handled",
                           {"event_ids": w.get("handled_event_ids") or []})
            _post_json(f"{api_base}/api/agents/{aid}/wake-ack",
                       {"kind": "released", "release_lease": True})
            live_workers.pop(aid, None)
            if not quiet:
                print(f"[notifier] worker for {aid} (pid {proc.pid}, rc={proc.returncode}) "
                      f"exited — lease released")
            continue
        # Wake-latency fix: this worker is still alive — renew its short single-flight lease so
        # it doesn't expire mid-run (which would let a second worker spawn). A crashed worker, or
        # one the daemon stops tracking, is NOT renewed, so its lease lapses within
        # WAKE_LEASE_TTL_SECS and a fresh high-priority event can wake a new worker promptly.
        renew = _post_json(f"{api_base}/api/agents/{aid}/wake-renew",
                           {"lease_ttl": WAKE_LEASE_TTL_SECS})
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
                       {"kind": "worker_human_stopped", "release_lease": True})
            live_workers.pop(aid, None)
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
        # ISS-29: a worker that already emitted a terminal `result` has COMPLETED — the log
        # stops growing at the result line, so the stall timer trips even though the work is
        # done and the process is just slow to exit. Do NOT reap it as 'killed': hold off and
        # let the next tick's proc.poll() catch a clean exit (reaped 'exited', SessionEnd/C1
        # digest gets to run). Only force it down — still 'exited' — if it overruns a generous
        # graceful-exit window.
        rstatus = _result_status(w.get("log_path"))
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
            exit_code = 0 if rstatus == "success" else proc.returncode
            _finish_run(api_base, w.get("run_id"), "exited", exit_code, w.get("log_path"), diff)
            _teardown_worktree(w.get("base_cwd"), w.get("worktree"), w.get("branch"))
            # GH #58: same completion seam as the clean-poll exit above — a successful drain acks its
            # handled-set; a non-success (rstatus != success) marks nothing so the events re-surface.
            if exit_code == 0:
                _post_json(f"{api_base}/api/agents/{aid}/events/ack-handled",
                           {"event_ids": w.get("handled_event_ids") or []})
            _post_json(f"{api_base}/api/agents/{aid}/wake-ack",
                       {"kind": "worker_completed_reaped", "release_lease": True})
            live_workers.pop(aid, None)
            if not quiet:
                print(f"[notifier] worker for {aid} (pid {proc.pid}) completed but lingered "
                      f">{GRACEFUL_EXIT_SECS:.0f}s after result — reaped as exited")
            continue
        # ISS-45: a stalled-looking worker can be log-silent yet ALIVE — waiting on an in-flight
        # tool call (the `tool_use` is out but its `tool_result` only lands when the subprocess
        # returns) or backing off on a rate limit. Don't STALL-kill it: that SIGKILLed
        # legitimately-working workers mid-task, losing the result + the C1 digest. Under the soft
        # cap a log-silent-but-live worker is exempt; PAST the cap we no longer trust "looks
        # alive" — persistent silence then is a runaway, so the exemption stays cap-bounded (this
        # keeps the hard-cap teeth for a genuinely-hung in-flight tool — the ISS-45 backstop).
        if stalled and not over_cap and _worker_is_live(w.get("log_path")):
            if not quiet:
                print(f"[notifier] worker for {aid} (pid {proc.pid}) log-silent but ALIVE "
                      f"(in-flight tool / rate-limit backoff) — not stall-killing")
            continue
        # ISS-76 (#194): reaching here NOT stalled means the log is still GROWING but the worker has
        # merely crossed the soft hard cap (the only way `not stalled` survives the early
        # `if not (stalled or over_cap): continue` is `over_cap`). That is a genuine long task, not
        # a runaway — the old code SIGKILLed it mid-work. CHECKPOINT it (graceful snapshot → C1
        # digest) and respawn a FRESH worker on the same worktree so it continues with a clean
        # context window. Bounded by HARD_CAP_RESPAWN_MAX: once a task has rolled over the cap that
        # many times without finishing it's treated as a runaway and falls through to the kill.
        if not stalled and w.get("respawn_ctx") and w.get("respawns", 0) < HARD_CAP_RESPAWN_MAX:
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
            "worker_is_live": _worker_is_live(lp),
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
        _post_json(f"{api_base}/api/agents/{aid}/wake-ack",
                   {"kind": kind, "release_lease": True})
        live_workers.pop(aid, None)
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
# is treated as a runaway and reaped — the preserved hard-cap backstop. A genuinely STALLED (log-
# silent, not live) worker is still killed immediately at any age; only progressing workers respawn.
HARD_CAP_RESPAWN_MAX = 3

# Wake-latency fix: the single-flight LEASE is now decoupled from the hard cap. The daemon
# claims a SHORT lease and RENEWS it every tick while its worker is alive (reap_workers). So a
# legitimately long worker keeps single-flight, but a crashed/orphaned worker's lease expires
# within this window instead of squatting for the full 1200s hard-cap — which is what starved a
# fresh high-priority event for minutes. Renew interval (the tick) must stay well under this.
WAKE_LEASE_TTL_SECS = 180.0


def reap_orphan_leases(api_base: str, cid: str, quiet: bool) -> None:
    """ISS-60(B): TTL-independent backstop — ask the API to release any single-flight lease whose
    agent hasn't heartbeat in >ORPHAN_LEASE_SECS (a daemon-restart / externally-spawned resident
    whose lease survived an in-memory live_residents reset, where the short TTL alone wouldn't
    recover all wakes). The reap DECISION + threshold live server-side (only the API touches the
    DB); this is a thin transport poll, run each tick alongside reap_workers. SAFE because
    wake-renew bumps last_heartbeat_at on every keep-alive, so an alive-but-quiet embodiment is
    never false-orphaned. Idempotent: a released lease is no longer LIVE, so a re-call is a no-op."""
    res = _post_json(f"{api_base}/api/containers/{cid}/reap-orphan-leases", {})
    if res and res.get("reaped") and not quiet:
        for r in res["reaped"]:
            print(f"[notifier] reaped ORPHAN {r.get('lease_kind')} lease for {r.get('alias')} "
                  f"(no heartbeat {float(r.get('idle_seconds') or 0):.0f}s) — lease released (ISS-60B)")


def reap_orphaned_runs(api_base: str, cid: str, live_pids=frozenset(),
                       *, quiet: bool = True) -> int:
    """#342: CONTAINER-WIDE dead-pid sweep across ALL wake_kinds — the fix for orphaned EPHEMERAL
    wake-runs left status='running' forever. The per-agent resident reaper (_reap_dead_pid_resident_runs)
    only runs for agents WITH an active conversation and reads RESIDENT runs; the heartbeat
    reap-orphan-leases only acts on a still-LIVE lease. So an ephemeral wake-run (request_answered /
    checkpoint_respawn / conversation_turn) whose daemon RESTARTED — dropping the in-memory Popen handle
    that reap_workers() would have poll()/finished — falls through BOTH: its lease has already expired
    (nothing renews it) and it never had a resident row, so it squats 'running' indefinitely, misreporting
    the agent as busy (blocks re-wake, compounds #340).

    This sweep is keyed on the only truth that survives daemon turnover: the DB run row + a HOST
    os.kill(pid,0) (the API can't see host PIDs). For each agent with a running run whose process is dead:
      * NO live process backs ANY of its running rows → release the lease (the server's wake-ack reconcile
        orphans every running row for the agent) so the agent is idle + re-wakeable within one poll cycle.
      * a live sibling DOES exist (true double-spawn / a fresh worker mid-run) → finish ONLY the dead orphan
        rows ('killed'), keep the lease the live worker still renews.
    `live_pids` shields THIS daemon's genuinely-live workers + residents from a racing os.kill. (pid REUSE
    can mask a dead run as alive — accepted: the ISS-60B heartbeat backstop still catches that tail.)
    Returns the number of dead runs reaped."""
    data = _get_json(f"{api_base}/api/containers/{cid}/running-runs") or {}
    runs = data.get("runs", [])
    if not runs:
        return 0

    def _alive(r):
        pid = r.get("pid")
        return (pid in live_pids) or _run_pid_alive(pid)

    by_agent: dict = {}
    for r in runs:
        by_agent.setdefault(r.get("agent_id"), []).append(r)
    reaped = 0
    for aid, arows in by_agent.items():
        dead = [r for r in arows if not _alive(r)]
        if not dead:
            continue
        live_sibling = any(_alive(r) for r in arows)
        if live_sibling:
            for r in dead:
                _finish_run(api_base, r.get("run_id"), "killed", -1, None)
        else:
            _post_json(f"{api_base}/api/agents/{aid}/wake-ack",
                       {"kind": "orphan_run_sweep", "release_lease": True})
        reaped += len(dead)
        if not quiet:
            print(f"[notifier] swept {len(dead)} dead-pid orphaned run(s) for {aid} "
                  f"({'finished orphans, kept lease (live sibling)' if live_sibling else 'released lease'}) "
                  f"(#342)")
    return reaped


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
         live_workers: Optional[dict] = None, base_cwd: Optional[str] = None) -> dict:
    """One scan-and-wake pass. Returns a summary dict (also used by tests).

    `live_workers` (daemon-loop state, {agent_id: pid}) is updated with each ephemeral
    worker spawned so `reap_workers` can release its lease on exit. `base_cwd` is the daemon's
    project dir, used to auto-record reachability for portal-created agents (see below)."""
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
    for cand in scan.get("candidates", []):
        if not cand.get("should_wake"):
            continue
        prompt = build_wake_prompt(cand)
        kind = select_transport(cand)
        event = derive_wake_event(cand)
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
            # R2.4 single-flight: win an exclusive, TTL-bounded lease BEFORE spawning.
            # If we don't win, a worker is already live for this agent (or the global
            # kill-switch is off) — skip without spawning and without touching the
            # cursor (the live worker drains + acks). This is the runaway fix.
            if not dry_run:
                claim = _post_json(
                    f"{api_base}/api/agents/{cand['agent_id']}/wake-claim",
                    {"lease_ttl": claim_ttl, "kind": "ephemeral", "event": event})
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
            persona = None if dry_run else _build_persona(
                api_base, cand["agent_id"], task_id=cand.get("wake_task_id"))
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
            auto = cand.get("auto_start_task_ids") or []
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
            worktree = branch = None
            if is_code_wake and hc and not dry_run and live_workers is not None:
                worktree, branch = _provision_worktree(hc, cand.get("alias"))
            run_cwd = worktree or hc
            sent, cmd, proc = spawn_headless(run_cwd, prompt,
                                       cand.get("headless_flags"), dry_run,
                                       alias=cand.get("alias"), system_prompt=persona,
                                       model=cand.get("model"),
                                       runtime=cand.get("model_runtime"),
                                       log_path=log_path)
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
                                  "task_id": auto[0] if auto else cand.get("wake_task_id"),
                                  "log_path": str(log_path) if log_path else None,
                                  "pid": getattr(proc, "pid", None),
                                  "runtime": cand.get("model_runtime"),
                                  "worktree": worktree, "branch": branch, "base_cwd": hc})
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
                    # ISS-39: per-worker cursor for streaming stream-json lines into the DB
                    "lines_offset": 0, "lines_seq": 1, "lines_buf": b"",
                    # ISS-76: everything reap_workers needs to CHECKPOINT-RESPAWN this worker on
                    # the same worktree if it's still progressing when it crosses the soft cap.
                    "cap": cap, "respawns": 0,
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
                                    "model_runtime": cand.get("model_runtime"),
                                    "task_id": auto[0] if auto else cand.get("wake_task_id"),
                                    "handled_event_ids": cand.get("handled_event_ids") or [],
                                    "event": event}}
            elif worktree and not sent:
                # spawn failed after we made a worktree — clean it up (no orphan)
                _teardown_worktree(hc, worktree, branch)
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
            ack_ts = cand.get("ack_through_ts")
            if ack_ts is None:
                ack_ts = cand.get("max_event_ts")
            # GH #58: a reaped ephemeral worker (tracked in live_workers) acks its handled-set at
            # COMPLETION via /events/ack-handled (contiguous-floor advance), NOT here at spawn — so a
            # spawn-then-crash re-surfaces the events instead of high-watering past undrained ones.
            # The single-flight lease suppresses any re-wake while it runs. Only the non-reaped paths
            # (--once with no reaper, tmux/unreachable) still high-water the cursor at spawn.
            ephemeral_reaped = (kind == "ephemeral" and sent and live_workers is not None
                                and cand["agent_id"] in live_workers)
            if ephemeral_reaped:
                delivered_ts = None
            else:
                delivered_ts = ack_ts if (sent and cand.get("pending_events")) else None
            # We claim a single-flight lease ONLY for an ephemeral spawn. If that spawn
            # then failed (no claude, bad cwd, Popen error), no worker exists — release
            # the lease we just won so the agent isn't suppressed for the whole TTL.
            release_lease = (kind == "ephemeral" and not sent)
            _post_json(f"{api_base}/api/agents/{cand['agent_id']}/wake-ack",
                       {"delivered_ts": delivered_ts,
                        "kind": kind if sent else (f"{kind}_failed" if kind != "unreachable" else "unreachable"),
                        "event": event, "release_lease": release_lease})

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
    rows = []
    for t in turns[-20:]:
        content = (t.get("content") or "").strip()
        atts = [a for a in (t.get("attachments") or []) if isinstance(a, dict)]
        if not content and not atts:
            continue
        who = "Human" if t.get("role") == "human" else "Agent"
        # #338: name any files shared on this turn (context marker; the open-instructions live with
        # the pending turn via _render_attachment_feed).
        marker = ""
        if atts:
            names = ", ".join(f"{a.get('name') or a.get('id')} ({a.get('kind') or 'file'})" for a in atts)
            marker = f"  [attached {len(atts)} file(s): {names}]"
        rows.append(f"{who}: {content}{marker}")
    return "## Conversation so far\n\n" + "\n\n".join(rows) if rows else ""


def _conversation_worker_prompt(alias: str, pending_turns: list[dict], history_turns: list[dict],
                                api_base: Optional[str] = None) -> str:
    """Instruction for a one-shot Codex conversation worker.

    Codex does not provide the stdin stream-json resident protocol Claude uses here, so each
    conversation reply is a fresh `codex exec`. We inject the thread history and ask Codex to make
    its final response the message that Orcha appends back to the Conversation tab.
    """
    # #247 item-3: Codex has no --resume, so a one-shot conversation worker re-injects the whole
    # history every turn — curating a long history (summarize-older + recent-verbatim) is the win.
    # _cold_boot_history fails open to the mechanical block, then we degrade to _simple_history.
    history = _cold_boot_history(history_turns)
    if not history:
        history = _simple_history(history_turns)
    # #338: a pending turn counts if it has text OR attachments (an attachment-only message must
    # still reach the agent). Aggregate attachment refs across the pending turns for the feed.
    pending = [t for t in pending_turns
               if (t.get("content") or "").strip() or (t.get("attachments") or [])]
    latest = "\n\n".join(
        f"Human turn seq {t.get('seq')}: {(t.get('content') or '').strip() or '(no text — see attached files)'}"
        for t in pending
    )
    if not latest:
        latest = "(empty human message)"
    pending_atts = [a for t in pending for a in (t.get("attachments") or []) if isinstance(a, dict)]
    # #338 Codex image->text: Codex cannot view pixels, so OCR any image/PDF to text it can read.
    extracted = _extract_attachment_text(pending_atts, api_base)
    feed = _render_attachment_feed(pending_atts, api_base=api_base, runtime="codex",
                                   extracted=extracted)
    feed_block = f"\n\n{feed}" if feed else ""
    return (
        f"[orcha conversation] {alias or 'agent'}: reply to the human in Orcha's "
        "Conversation tab. This is a ONE-SHOT Codex conversation worker, not a resident "
        "stdin session. Use tools if needed, but make your final answer the chat reply "
        "that should be appended to the conversation. Do not call `/orcha-listen` and do "
        "not post this reply through task/request endpoints unless the human explicitly "
        "asked for that side effect.\n\n"
        f"{history}\n\n"
        "## Pending Human Message(s)\n\n"
        f"{latest}\n"
        f"{feed_block}"
    )


def _codex_resume_prompt(alias: str, pending_turns: list[dict]) -> str:
    """#286: the continuation prompt for a `codex exec resume <session_id>` worker.

    Unlike _conversation_worker_prompt, this injects NO thread history and NO persona/digest — the
    resumed on-disk rollout already holds all prior context, so re-injecting it would re-pay exactly
    the history tokens this feature exists to save. Carries ONLY the framing reminder + the new
    pending human turn(s). The cost win lives here: a multi-turn Codex review now pays history once
    (the cold turn-1 rollout) instead of every turn."""
    latest = "\n\n".join(
        f"Human turn seq {t.get('seq')}: {(t.get('content') or '').strip()}"
        for t in pending_turns
        if (t.get("content") or "").strip()
    )
    if not latest:
        latest = "(empty human message)"
    return (
        f"[orcha conversation] {alias or 'agent'}: continue replying to the human in Orcha's "
        "Conversation tab. This RESUMES your existing Codex session — the prior conversation is "
        "already in your context, so do NOT restate it. Make your final answer the chat reply "
        "appended to the conversation. Do not call `/orcha-listen` and do not post this reply "
        "through task/request endpoints unless the human explicitly asked for that side effect.\n\n"
        "## New Human Message(s)\n\n"
        f"{latest}\n"
    )


def _text_from_content(content) -> Optional[str]:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for blk in content:
            if not isinstance(blk, dict):
                continue
            if isinstance(blk.get("text"), str):
                parts.append(blk["text"])
            elif blk.get("type") in ("text", "output_text") and isinstance(blk.get("content"), str):
                parts.append(blk["content"])
        return "\n".join(p for p in parts if p).strip() or None
    return None


def _conversation_reply_text(log_path, last_message_path=None) -> Optional[str]:
    """Best-effort final text for a one-shot conversation worker.

    Codex `exec --output-last-message` is the primary path. The JSONL fallback deliberately accepts
    both Claude stream-json and Codex-ish assistant message shapes so tests and future CLI changes
    fail soft instead of leaving the Conversation tab blank.
    """
    if last_message_path:
        try:
            text = pathlib.Path(last_message_path).read_text().strip()
            if text:
                return text
        except OSError:
            pass
    res = _result_after(log_path, 0)
    if res and res.get("text"):
        return str(res["text"]).strip() or None
    if not log_path:
        return None
    try:
        lines = pathlib.Path(log_path).read_text(errors="replace").splitlines()
    except OSError:
        return None
    last = None
    for line in lines:
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        typ = obj.get("type")
        msg = obj.get("message")
        role = obj.get("role")
        if role is None and isinstance(msg, dict):
            role = msg.get("role")
        candidate = None
        if typ == "result":
            candidate = obj.get("result")
        elif role == "assistant" or typ in {"assistant", "agent_message", "assistant_message"}:
            if isinstance(msg, str):
                candidate = msg
            elif isinstance(msg, dict):
                candidate = _text_from_content(msg.get("content"))
            candidate = candidate or _text_from_content(obj.get("content")) or obj.get("text")
        if isinstance(candidate, str) and candidate.strip():
            last = candidate.strip()
    return last


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
    body = {"kind": kind, "event": "conversation_turn", "release_lease": release_lease}
    if delivered_ts is not None:
        body["delivered_ts"] = delivered_ts
    return body


def _resident_runtime(r: dict) -> str:
    """Older in-memory resident dicts predate the runtime field; those are Claude residents."""
    return _normalize_runtime((r or {}).get("runtime"))


def _maybe_pin_codex_session(api_base: str, conv_id: str, r: dict) -> Optional[str]:
    """#286: capture the Codex session id from this turn's log and pin it on the conversation so
    the NEXT turn can `codex exec resume <session_id>` instead of re-injecting the full history.

    No-ops when there is nothing new to pin — a cold worker that emitted no parseable id, or a
    resume worker that kept the same session (already pinned). Reuses the existing
    POST /conversations/{id}/session endpoint (shared with the Claude resident; the column is a
    UUID, and recent Codex session ids are UUIDs). A non-UUID id makes the endpoint 400 → _post_json
    returns None → we simply stay on the cold path next turn (the #286 fail-open contract)."""
    sid = _extract_codex_session_id(r.get("log_path"))
    if not sid or sid == r.get("resume_session_id"):
        return None
    res = _post_json(f"{api_base}/api/conversations/{conv_id}/session", {"session_id": sid})
    return sid if res is not None else None


def _finish_codex_conversation(api_base: str, conv_id: str, r: dict, *,
                               status: str = "exited", exit_code=None,
                               ack_kind: str = "codex_conversation_released",
                               post_reply: bool = True,
                               teardown_worktree: bool = False) -> bool:
    diff = _capture_diff(r.get("worktree"))
    posted = False
    real_text = _conversation_reply_text(r.get("log_path"), r.get("last_message_path")) \
        if post_reply else None
    text = real_text
    if post_reply:
        # #286 resume fail-open: a `codex exec resume` worker that produced NO reply (bad session
        # id / unresumable rollout / wrong flag spelling) must NOT post the misleading "no reply"
        # sentinel. Flag the conversation so the NEXT turn re-runs COLD with full history — the
        # pending human turn stays unanswered (posted stays False → delivered_ts None) and is
        # re-spawned cold. Never a broken turn; bounded to one cold retry.
        if not text and r.get("resume_session_id"):
            _CODEX_RESUME_FAILED.add(conv_id)
        elif not text and status == "exited":
            text = ("Codex completed without producing a final conversation reply. "
                    f"See worker run {r.get('current_run_id')} for details.")
        if text:
            posted = _post_conversation_reply(
                api_base, conv_id, r, text,
                {"runtime": "codex", "exit_code": exit_code},
            )
    # A GENUINE reply (not the sentinel) means the rollout is valid → capture its session id for
    # the next turn's resume, and clear any prior resume-failed flag (resume is healthy again).
    if real_text and posted:
        _maybe_pin_codex_session(api_base, conv_id, r)
        _CODEX_RESUME_FAILED.discard(conv_id)
    _finish_run(api_base, r.get("current_run_id"), status, exit_code, r.get("log_path"), diff)
    if teardown_worktree:
        _safe_teardown_worktree(r.get("base_cwd"), r.get("worktree"), r.get("branch"))
    delivered_ts = r.get("conversation_ack_ts") if posted else None
    _post_json(f"{api_base}/api/agents/{r['agent_id']}/wake-ack",
               _conversation_ack_body(ack_kind, delivered_ts=delivered_ts, release_lease=True))
    return posted


def _codex_run_state(conv: dict, run: dict, *, base_cwd: Optional[str] = None) -> dict:
    log_path = _as_path(run.get("log_path"))
    try:
        last_size = os.path.getsize(log_path) if log_path else 0
    except OSError:
        last_size = 0
    return {
        "runtime": RUNTIME_CODEX, "proc": _ExternalProcess(run["pid"]),
        "agent_id": conv["agent_id"], "conversation_id": conv["conversation_id"],
        "alias": conv.get("agent_alias"),
        "log_path": log_path, "last_message_path": _as_path(run.get("last_message_path")),
        "worktree": run.get("worktree"), "branch": run.get("branch"),
        "base_cwd": run.get("base_cwd") or base_cwd,
        "serviced_seq": conv.get("last_turn_seq", 0),
        "current_run_id": run["run_id"], "run_id": run["run_id"],
        "conversation_ack_ts": (run.get("conversation_ack_ts")
                                if run.get("conversation_ack_ts") is not None
                                else conv.get("conversation_ack_ts")),
        "hard_deadline": time.time() + HARD_CAP_MIN_SECS,
        "last_size": last_size, "last_progress_ts": time.time(),
        "lines_offset": 0, "lines_buf": b"", "lines_seq": 1,
        "last_activity_ts": time.time(),
    }


def reconcile_codex_conversation_runs(api_base: str, cid: str, live_residents: dict, *,
                                      quiet: bool = False,
                                      base_cwd: Optional[str] = None) -> None:
    """Recover Codex one-shot conversation workers after a notifier restart.

    Codex conversation replies are not resident stdin sessions. The durable worker_run row
    carries the host pid plus the --output-last-message sidecar path, so a fresh daemon can
    either reattach to a still-running process or recover the completed reply from disk.
    """
    scan = _get_json(f"{api_base}/api/containers/{cid}/active-conversations") or {}
    for conv in scan.get("conversations", []):
        if _normalize_runtime(conv.get("model_runtime")) != RUNTIME_CODEX:
            continue
        conv_id = conv.get("conversation_id")
        aid = conv.get("agent_id")
        if not conv_id or not aid:
            continue
        runs = (_get_json(f"{api_base}/api/agents/{aid}/runs?limit=200") or {}).get("runs", [])
        for run in runs:
            if (run.get("status") != "running"
                    or _normalize_runtime(run.get("runtime")) != RUNTIME_CODEX
                    or run.get("wake_event") != "conversation_turn"
                    or run.get("conversation_id") != conv_id):
                continue
            pid = run.get("pid")
            if pid and _pid_alive(pid):
                if live_residents.get(conv_id) is None:
                    live_residents[conv_id] = _codex_run_state(conv, run, base_cwd=base_cwd)
                    if not quiet:
                        print(f"[notifier] reattached Codex conversation worker for "
                              f"{conv.get('agent_alias')} (pid {pid}, run {run.get('run_id')})")
                continue
            state = _codex_run_state({**conv, "last_turn_seq": conv.get("last_turn_seq", 0)},
                                     {**run, "pid": pid or -1}, base_cwd=base_cwd)
            text = _conversation_reply_text(state.get("log_path"), state.get("last_message_path"))
            status = "exited" if text else "killed"
            exit_code = 0 if text else -1
            _finish_codex_conversation(
                api_base, conv_id, state, status=status, exit_code=exit_code,
                ack_kind="codex_conversation_orphan_recovered",
                post_reply=True, teardown_worktree=True,
            )
            if not quiet:
                outcome = "recovered reply" if text else "finished without reply"
                print(f"[notifier] reconciled orphan Codex conversation run {run.get('run_id')} "
                      f"for {conv.get('agent_alias')} ({outcome})")


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
    _post_json(f"{api_base}/api/agents/{r['agent_id']}/wake-ack",
               {"kind": f"resident_{reason}", "release_lease": True, "stamp_woken": stamp_woken})


def _spawn_drain_sidecar(api_base: str, r: dict, inbox: int, *, messages: Optional[list] = None,
                         ack_ts=None, ackable_ids: Optional[list] = None,
                         model: Optional[str] = None,
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
                                       model=model, runtime=RUNTIME_CLAUDE, log_path=log_path)
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
                live_residents.pop(conv_id, None)
                continue
            _pump_one(api_base, r["agent_id"], r)
            if proc.poll() is not None:
                _finish_codex_conversation(
                    api_base, conv_id, r, status="exited", exit_code=proc.returncode,
                    ack_kind="codex_conversation_released", post_reply=True,
                )
                live_residents.pop(conv_id, None)
                if not quiet:
                    print(f"[notifier] Codex conversation worker for {r.get('alias')} "
                          f"(pid {proc.pid}, rc={proc.returncode}) replied — lease released")
                continue
            renew = _post_json(f"{api_base}/api/agents/{r['agent_id']}/wake-renew",
                               {"lease_ttl": WAKE_LEASE_TTL_SECS})
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
                live_residents.pop(conv_id, None)
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
                live_residents.pop(conv_id, None)
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
                       {"kind": "resident_exited", "release_lease": True})
            live_residents.pop(conv_id, None)
            continue
        if conv_id not in active_ids:          # human ended the conversation out from under us
            _close_resident(api_base, r, reason="conversation_ended", teardown_worktree=True)
            _RESIDENT_RESUME_FAILED.discard(conv_id)   # ISS-61: conversation gone → reset the flag
            _RESIDENT_DRAIN_YIELD.pop(conv_id, None)    # ISS-78: drop stale yield bookkeeping
            live_residents.pop(conv_id, None)
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
                if not r.get("session_pinned"):        # pin the session for later --resume
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
            live_residents.pop(conv_id, None)
            continue
        renew = _post_json(f"{api_base}/api/agents/{r['agent_id']}/wake-renew",
                           {"lease_ttl": WAKE_LEASE_TTL_SECS})   # hold single-embodiment while warm
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
            live_residents.pop(conv_id, None)            # worktree KEPT (conversation stays active)
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
            live_residents.pop(conv_id, None)
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
            live_residents.pop(conv_id, None)
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
        if not r.get("awaiting_result") and not pending and inbox > 0 and not stalled:
            if drain_taskbound > 0:
                # A task-bound / new-work / directive row needs a protocol-bound ephemeral, which the
                # resident is not → YIELD the lease so the next tick()'s ephemeral (carrying that task's
                # protocol) drains the whole backlog. Same teardown seam as the §8 fail-open below.
                if not quiet:
                    print(f"[notifier] resident {r.get('alias')} has {drain_taskbound} task-bound "
                          f"inbox row(s) needing a protocol-bound run — yielding the lease for an "
                          f"ephemeral drain instead of the warm-zone sidecar (#247 B3 §5.2 / GH #58)")
                _close_resident(api_base, r, reason="inbox_drain_yield")
                live_residents.pop(conv_id, None)
                continue
            _RESIDENT_DRAIN_YIELD[conv_id] = (inbox_ack_ts, time.time())   # mark this drain attempt
            spawned = _spawn_drain_sidecar(api_base, r, inbox,
                                           messages=(cand or {}).get("inbox_messages"),
                                           ack_ts=inbox_ack_ts,
                                           ackable_ids=drain_ackable_ids,
                                           model=(cand or {}).get("model"),
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
                live_residents.pop(conv_id, None)
            continue
        # #266 (auto-wake FIRING): a warm resident that is idle (no in-flight turn, no pending human
        # turn) and whose clock-driven auto-wake is DUE yields the lease — the same snapshot+release
        # seam as the ISS-78 inbox-drain (NEVER inject the heartbeat into the warm human session: an
        # auto-wake nudge is task-work and would bleed into the next human turn, the ISS-78 regression).
        # Reached only with inbox==0 (a real queued event already drained above), so this is the PURE
        # clock path. stamp_woken=False so this release does NOT reset secs_since_woken — wake-scan still
        # reads auto_wake_due and the very next idle tick()'s EPHEMERAL wake performs the heartbeat in its
        # own throwaway session (single-embodiment preserved: the lease is free before it claims). The
        # ephemeral wake's own ack then stamps last_woken_at, anchoring the next cadence correctly. A
        # mid-turn resident never reaches here (awaiting_result short-circuits in section 1).
        if not r.get("awaiting_result") and not pending and (cand or {}).get("auto_wake_due"):
            if not quiet:
                print(f"[notifier] resident {r.get('alias')} idle + clock-driven auto-wake due — "
                      f"yielding the lease (no clock reset) so an ephemeral worker runs the heartbeat "
                      f"in its own session (#266, no context-bleed)")
            _close_resident(api_base, r, reason="auto_wake_yield", stamp_woken=False)
            live_residents.pop(conv_id, None)
            continue
        if (not r.get("awaiting_result") and not pending
                and time.time() - r.get("last_activity_ts", 0) > RESIDENT_IDLE_REAP_SECS):
            _close_resident(api_base, r, reason="idle")     # warm session went cold → free the lease
            live_residents.pop(conv_id, None)

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
                            "release_lease": True})
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
                persona = None if dry_run else _build_persona(api_base, c["agent_id"])
            sent, _, proc = spawn_headless(run_cwd, prompt, None, dry_run,
                                           alias=c.get("agent_alias"), system_prompt=persona,
                                           model=c.get("model"), runtime=runtime,
                                           resume_session_id=(session_id if use_resume else None),
                                           log_path=log_path,
                                           last_message_path=last_message_path)
            if not sent or proc is None:
                _safe_teardown_worktree(base_cwd, worktree, branch)
                _post_json(f"{api_base}/api/agents/{c['agent_id']}/wake-ack",
                           {"kind": "codex_conversation_failed", "event": "conversation_turn",
                            "release_lease": True})
                continue
            run = _post_json(
                f"{api_base}/api/agents/{c['agent_id']}/runs",
                {"wake_kind": "ephemeral", "wake_event": "conversation_turn",
                 "log_path": str(log_path) if log_path else None,
                 "pid": proc.pid, "runtime": runtime, "conversation_id": conv_id,
                 "conversation_ack_ts": c.get("conversation_ack_ts"),
                 "last_message_path": str(last_message_path) if last_message_path else None,
                 "worktree": worktree, "branch": branch, "base_cwd": base_cwd})
            run_id = (run or {}).get("run_id")
            if not run_id:
                _kill_worker(proc, graceful=True)
                _safe_teardown_worktree(base_cwd, worktree, branch)
                _post_json(f"{api_base}/api/agents/{c['agent_id']}/wake-ack",
                           {"kind": "codex_conversation_failed", "event": "conversation_turn",
                            "release_lease": True})
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
            persona = _build_persona(api_base, c["agent_id"]) if cold else None   # warm --resume's it
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
                           {"kind": "resident_failed", "release_lease": True})
                continue
            run_cwd = worktree or base_cwd or str(pathlib.Path.cwd())
            sent, _, proc = spawn_resident(run_cwd,
                                           system_prompt=persona, log_path=log_path,
                                           resume_session_id=None if cold else session_id,
                                           alias=c.get("agent_alias"), model=c.get("model"),
                                           runtime=c.get("model_runtime"),
                                           dry_run=dry_run)
            if not sent or proc is None:
                # ISS-61: keep the STABLE per-conversation worktree (reused on the next boot); it's
                # torn down only when the conversation ends. Just release the lease.
                _post_json(f"{api_base}/api/agents/{c['agent_id']}/wake-ack",
                           {"kind": "resident_failed", "release_lease": True})
                continue
            r = {"runtime": RUNTIME_CLAUDE, "proc": proc,
                 "agent_id": c["agent_id"], "conversation_id": conv_id,
                 "alias": c.get("agent_alias"), "log_path": log_path,
                 "worktree": worktree, "branch": branch, "base_cwd": base_cwd,
                 "session_id": session_id, "session_pinned": not cold, "cold": cold,
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
        if not _send_user_turn(r["proc"], nxt["content"]):  # pipe gone → reaped next tick, no orphan row
            continue
        run = _post_json(f"{api_base}/api/agents/{c['agent_id']}/runs",
                         {"wake_kind": "resident", "wake_event": "conversation_turn",
                          "log_path": str(r["log_path"]) if r.get("log_path") else None,
                          "pid": getattr(r.get("proc"), "pid", None)})
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
    return cwd / ".claude" / ".orcha-notifier.pid"


def _log_path(cwd: pathlib.Path) -> pathlib.Path:
    return cwd / ".claude" / ".orcha-notifier.log"


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError, ValueError, TypeError):
        return False


def _ps_inspect(pid: int) -> Optional[tuple]:
    """(state, command) for `pid` via `ps`, or None if `ps` is unusable / gives us nothing.

    Portable across macOS + Linux: `ps -o state= -o command= -p <pid>` (empty headers, so
    no header row to strip). Returns None on any error / non-zero exit / empty output — the
    caller treats that as "can't tell" and FAILS OPEN to the os.kill verdict (no regression
    on a host without a usable `ps`)."""
    try:
        out = subprocess.run(
            ["ps", "-o", "state=", "-o", "command=", "-p", str(pid)],
            capture_output=True, text=True, timeout=2.0,
        )
    except Exception:
        # ANY failure consulting `ps` (missing binary, OSError, timeout, a sandboxed/odd
        # environment) is "can't tell" → fail open. Deliberately broad: this is a best-effort
        # vetting helper whose whole contract is to never make the caller WORSE than os.kill.
        return None
    if out.returncode != 0:
        return None
    line = (out.stdout or "").strip()
    if not line:
        return None
    state, _, command = line.partition(" ")
    return state, command.strip()


def _daemon_pid_live(pid: int, cid: Optional[str] = None) -> bool:
    """ISS-22 / #92: is `pid` a LIVE notifier daemon — not a zombie, not a reused pid?

    Bare `os.kill(pid, 0)` reports SUCCESS for two non-live states that make `--ensure`
    wrongly refuse to start a replacement: a ZOMBIE (the daemon exited but the OS hasn't
    reaped it yet) and a REUSED pid (after a SIGKILL the finally-block never cleared the
    pidfile, and the OS handed that pid to an unrelated process). Vet the pid against `ps`:
    reject a zombie state and require the command to actually be a notifier — and, when the
    container is known AND the daemon's argv carries an explicit `--container` (it does when
    `ensure_daemon` spawned it, see below), require it to be OURS.

    FAIL-OPEN: if `ps` can't tell us (missing / errored / empty), fall back to today's
    os.kill-only verdict. So this can only ADD rejections that `ps` positively justifies —
    it never newly reports a genuinely-live daemon as dead on a box without a usable `ps`."""
    if not _pid_alive(pid):
        return False
    info = _ps_inspect(pid)
    if info is None:
        return True  # fail-open — exactly today's os.kill-only behavior
    state, command = info
    if state and state[0] == "Z":
        return False  # zombie: exited, awaiting reap — not a live daemon
    if "notifier" not in command:
        return False  # pid was reused for an unrelated process
    # A notifier stamped for a DIFFERENT container on this pid ⇒ the pid was reused by another
    # project's daemon. A notifier with NO `--container` token (started directly without one)
    # can't be disambiguated, so it's accepted as ours.
    if cid and "--container" in command and cid not in command:
        return False
    return True


def daemon_running(cwd: pathlib.Path) -> Optional[int]:
    """Return the live notifier daemon's pid for this project, or None.

    ISS-22: liveness is zombie- & pid-reuse-aware (`_daemon_pid_live`). A pidfile pointing at
    a dead / zombie / foreign pid is CLEARED here, so a stale pidfile (e.g. a SIGKILL'd daemon
    whose finally-block never ran) can't make `--ensure` refuse to spawn a replacement forever."""
    p = _pid_path(cwd)
    if not p.exists():
        return None
    try:
        pid = int(p.read_text().strip())
    except (ValueError, OSError):
        return None
    if _daemon_pid_live(pid, _container_id_for(cwd)):
        return pid
    try:
        p.unlink()  # stale pidfile (dead / zombie / reused pid) — clear it
    except OSError:
        pass
    return None


# The daemon is CONTAINER-global (it resolves container_id once at startup and services
# every agent in it), but the per-cwd PID file above is only visible from one checkout.
# With several worktrees of the same project (Orcha, Orcha-<agent>, ...) a second
# `notifier --ensure` from a different cwd couldn't see the first daemon and DOUBLE-SPAWNED
# it — two ticking servicers race past every spawn gate (single-flight lease, drain
# backstop) → concurrent residents per agent + phantom 'running' worker_runs
# (incident 2026-06-10). The container-keyed PID file under $HOME closes that hole:
# every worktree sees the same file.

def _global_pid_path(container_id: str) -> pathlib.Path:
    return pathlib.Path.home() / ".orcha" / f"notifier-{container_id}.pid"


def _container_id_for(cwd: pathlib.Path) -> Optional[str]:
    """current_container_id from this project's .claude/orcha.json, or None."""
    try:
        cfg = json.loads((cwd / ".claude" / "orcha.json").read_text())
        return cfg.get("current_container_id") or None
    except (OSError, ValueError):
        return None


def _api_base_for(cwd: pathlib.Path) -> Optional[str]:
    """api_base_url from this project's .claude/orcha.json, or None."""
    try:
        cfg = json.loads((cwd / ".claude" / "orcha.json").read_text())
        return (cfg.get("api_base_url") or "").rstrip("/") or None
    except (OSError, ValueError):
        return None


def _write_global_pid(container_id: str, pid: int, cwd: pathlib.Path) -> None:
    p = _global_pid_path(container_id)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(f"{pid}\n{cwd}")
    except OSError:
        pass  # best-effort — the per-cwd file still guards same-checkout double-spawns


def daemon_running_for_container(container_id: str) -> Optional[tuple]:
    """(pid, started_from_cwd) of a LIVE daemon serving container_id — from ANY worktree, or None.

    #92 / #276 rework (Gate P1 #1): liveness here is the SAME zombie- & pid-reuse-aware identity
    vet (`_daemon_pid_live`) the per-cwd `daemon_running` uses — a bare `_pid_alive` let a stale
    GLOBAL claim pointing at a zombie / reused / foreign pid masquerade as a live daemon, so
    `ensure_daemon` returned "already running" and never spawned a replacement (#92 still
    reproducible through the container-global path even after the local pidfile was fixed). A stale
    global pidfile is CLEARED here too — symmetry with `daemon_running` — so it can't wedge
    `--ensure` (or a stop path) forever."""
    p = _global_pid_path(container_id)
    try:
        lines = p.read_text().splitlines()
        pid = int(lines[0].strip())
    except (OSError, ValueError, IndexError):
        return None
    if not _daemon_pid_live(pid, container_id):
        try:
            p.unlink()  # stale global claim (dead / zombie / reused / foreign pid) — clear it
        except OSError:
            pass
        return None
    return pid, (lines[1].strip() if len(lines) > 1 else "")


def _claim_container(container_id: str):
    """Atomically claim the container BEFORE spawning a daemon [P1 review].

    A read-only check followed by spawn-then-claim leaves a window where two concurrent
    `--ensure` calls (different worktrees) both see no claim and both spawn — the exact
    double-servicer failure this guard exists to close. So the claim file itself is the
    lock: O_CREAT|O_EXCL means exactly one claimer wins, and it stamps its own pid
    immediately so the loser sees a LIVE claimant (the spawned daemon's pid replaces it
    right after Popen).

    Returns (True, None) when this process now holds the claim;
    (False, (pid, cwd)) when a live daemon already holds it;
    (False, (0, "")) when a concurrent claim is in flight (or undecidable) — yield, no spawn;
    (False, None) when the claim file is unusable (e.g. unwritable $HOME) — caller falls
    back to the per-cwd guard alone.
    """
    p = _global_pid_path(container_id)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        return False, None
    for _ in range(3):
        try:
            fd = os.open(str(p), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            holder = daemon_running_for_container(container_id)
            if holder:
                return False, holder
            try:
                raw = p.read_text().strip()
            except OSError:
                continue  # vanished between checks — retry the atomic create
            stale = False
            try:
                # #276 rework (P1 #1): identity-aware, same as the global-claim reader — a bare
                # _pid_alive would treat a zombie/reused pid as a live claimant and refuse to spawn.
                stale = not _daemon_pid_live(int(raw.splitlines()[0]), container_id)  # parseable + not-our-daemon = definitive
            except (ValueError, IndexError):
                # unreadable claim — a concurrent claimer between ITS O_EXCL create and pid
                # write looks exactly like this. Yield to a fresh one; clear a lingering one.
                try:
                    stale = (time.time() - p.stat().st_mtime) >= 10.0
                except OSError:
                    continue
            if not stale:
                return False, (0, "")
            try:
                p.unlink()  # stale claim — clear it and retry the atomic create
            except (FileNotFoundError, OSError):
                pass
        except OSError:
            return False, None
        else:
            try:
                os.write(fd, f"{os.getpid()}\n".encode())  # provisional claimant: us
            finally:
                os.close(fd)
            return True, None
    return False, (0, "")  # undecidable after retries — fail SAFE: no spawn


def _terminate_and_wait(pid: int, cid: Optional[str], grace: float = 8.0) -> None:
    """ISS-22 P2: SIGTERM `pid`, then BLOCK until it actually exits, escalating to SIGKILL
    after `grace` seconds.

    `stop_daemon` used to SIGTERM and return IMMEDIATELY — but a SIGTERM'd notifier only sets
    its stop flag and finishes the in-flight tick before exiting (the graceful-drain window).
    A `ensure_daemon(restart=True)` (orcha init/up) that didn't wait would then call
    `daemon_running` mid-drain, see a genuinely-live pid, print "already running", and NOT
    spawn a replacement — the old daemon then exits and the container is left UNSERVICED (the
    latent init/up form of #92). Blocking here closes that race.

    Bounded, and ONLY on the explicit stop/restart path — never the steady-state loop. The
    SIGKILL escalation is logged LOUDLY (it skips that daemon's SessionEnd / C1 digest flush).

    #276 rework (Gate P1 #2): NEVER signal a pid we haven't vetted as OUR live daemon. The pid
    comes from a pidfile that may name a reused/foreign process (a SIGKILL'd daemon's pidfile the
    OS handed to `vim`); a blind SIGTERM would kill that unrelated process. We vet with
    `_daemon_pid_live` BEFORE the SIGTERM and RE-vet immediately before the SIGKILL, so the
    escalation can never land on a pid that exited and got reused during the grace window."""
    if not _daemon_pid_live(pid, cid):
        return  # dead / zombie / reused / foreign — not our daemon, send NO signal
    try:
        os.kill(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return  # already gone / not killable — nothing to wait for
    deadline = time.time() + grace
    while time.time() < deadline:
        if not _daemon_pid_live(pid, cid):
            return  # exited cleanly within grace
        time.sleep(0.25)
    # still alive after the grace window → force it down so a follow-up --ensure can spawn. Re-vet
    # RIGHT BEFORE the SIGKILL: if the pid is no longer our live daemon (exited + reused mid-grace),
    # don't escalate onto whatever now holds it.
    if not _daemon_pid_live(pid, cid):
        return
    try:
        os.kill(pid, signal.SIGKILL)
        print(f"[notifier] WARNING: daemon pid {pid} did not exit {grace:.0f}s after SIGTERM — "
              f"sent SIGKILL (its SessionEnd digest flush was skipped)", file=sys.stderr)
    except (ProcessLookupError, PermissionError):
        return  # raced to exit between the last poll and the kill
    for _ in range(8):  # brief poll so we don't return while it's still being reaped
        if not _daemon_pid_live(pid, cid):
            return
        time.sleep(0.25)


def stop_daemon(cwd: pathlib.Path, quiet: bool = False) -> bool:
    """Stop the daemon serving this project's CONTAINER (SIGTERM via the PID files). Idempotent.

    Called by `orcha down` so the daemon dies with the stack, and by `ensure_daemon(
    restart=True)` on `orcha init` so a fresh daemon tracks the NEW container (the
    daemon resolves its container_id once at startup, so a re-init must restart it).

    [P2 #218] The daemon may have been started from ANOTHER worktree — visible only via
    the container-global claim, not this cwd's pidfile. `orcha down` from here must stop
    that one too: left alive it polls a stack that is going away, and after `down -v &&
    up` its still-live claim makes `--ensure` believe the container is already serviced.
    """
    import signal
    pid = daemon_running(cwd)
    pidf = _pid_path(cwd)
    cid = _container_id_for(cwd)
    if not pid:
        if pidf.exists():
            try:
                pidf.unlink()
            except OSError:
                pass
        # no LOCAL pidfile ≠ no daemon: fall back to the container-global claim
        if cid:
            other = daemon_running_for_container(cid)
            if other:
                _terminate_and_wait(other[0], cid)  # ISS-22: block until it actually exits
                if not quiet:
                    frm = f", started from {other[1]}" if other[1] else ""
                    print(f"[notifier] stopped daemon (pid {other[0]}{frm})")
            try:
                _global_pid_path(cid).unlink()   # live holder stopped, or stale debris
            except (FileNotFoundError, OSError):
                pass
            if other:
                return True
        return False
    _terminate_and_wait(pid, cid)  # ISS-22: block until it actually exits (SIGKILL after grace)
    try:
        pidf.unlink()
    except (FileNotFoundError, OSError):
        pass
    # drop the container-keyed file too when it names the daemon we just stopped,
    # so a follow-up --ensure (from any worktree) doesn't see a stale claim
    if cid:
        running = daemon_running_for_container(cid)
        if running is None or running[0] == pid:
            try:
                _global_pid_path(cid).unlink()
            except (FileNotFoundError, OSError):
                pass
    if not quiet:
        print(f"[notifier] stopped daemon (pid {pid})")
    return True


def stop_daemon_for_container(container_id: str, quiet: bool = False) -> bool:
    """#255: stop the daemon bound to a SPECIFIC (e.g. now-wiped) container, by its container id.

    `ensure_daemon(restart=True)` on `orcha init` resolves the cid to stop from the CURRENT
    orcha.json — but `init --force --reset-data` overwrites orcha.json with the NEW cid BEFORE
    the restart, so `stop_daemon` only ever stops the new daemon. The daemon bound to the OLD
    (now-404) container survives and polls a dead container forever. This stops THAT one
    explicitly via its container-keyed pidfile. Idempotent: a no-op when no such daemon exists.
    Returns True iff a live daemon was signalled."""
    import signal
    if not container_id:
        return False
    holder = daemon_running_for_container(container_id)  # identity-vetted (P1 #1) + clears stale claim
    try:
        _global_pid_path(container_id).unlink()      # clear live claim or stale debris
    except (FileNotFoundError, OSError):
        pass
    if not holder:
        return False
    # #276 rework (P1 #2): route the kill through _terminate_and_wait — it RE-vets identity with
    # _daemon_pid_live before signalling, so we never SIGTERM a reused/foreign pid (the bare
    # os.kill here was the second signal-before-vet site Gate flagged).
    _terminate_and_wait(holder[0], container_id)
    if not quiet:
        frm = f", started from {holder[1]}" if holder[1] else ""
        print(f"[notifier] stopped stale daemon for old container {container_id} (pid {holder[0]}{frm})")
    return True


def ensure_daemon(cwd: pathlib.Path, quiet: bool = False, restart: bool = False) -> bool:
    """Start `orcha notifier` detached iff one isn't already running for this project.

    Idempotent singleton (PID file under .claude/) — safe to call from `orcha init`,
    `orcha up`, and a SessionStart hook repeatedly. Silent no-op when this isn't an
    Orcha project. This is what makes wake ON-BY-DEFAULT: the daemon comes up with the
    workspace, no hand-starting.

    `restart=True` (used by `orcha init`) first stops any running daemon, so the new one
    binds to the just-created container — without it a re-init strands the old daemon on
    a dead container_id (it resolves the container once, at startup).
    """
    if not (cwd / ".claude" / "orcha.json").exists():
        return False  # not an orcha project — nothing to wake
    cid = _container_id_for(cwd)
    if restart:
        # stop_daemon is container-global [P2 #218]: it stops a same-cwd daemon AND one
        # started from another worktree (via the claim file), so a restart always gets a
        # genuinely fresh daemon for this container.
        stop_daemon(cwd, quiet=True)
    pid = daemon_running(cwd)
    if pid:
        if not quiet:
            print(f"[notifier] already running (pid {pid})")
        return True
    # [P2 #224 review] The 404 refusal must hold on THIS managed path too, BEFORE any
    # claim/pidfile is written — otherwise --ensure returns success, leaves a pidfile +
    # container claim pointing at a child that immediately refused, and buries the real
    # error in the daemon log. One quick probe (no retries — this runs in a SessionStart
    # hook): only a definitive 404 refuses; an unreachable/booting API proceeds and the
    # child re-probes with retries. If the child still refuses, its dead pid makes the
    # parent-written pidfile/claim stale, so liveness checks ignore them.
    if cid:
        api = _api_base_for(cwd)
        if api and _probe_container(api, cid) == "missing":
            if not quiet:
                print(f"[notifier] container {cid} does not exist at {api} — not starting a "
                      f"daemon. This usually means a stale .claude/orcha.json (api_base_url/"
                      f"current_container_id from a previous stack). Fix the config or re-run "
                      f"`orcha connect <project>`.", file=sys.stderr)
            return False
    # container-global guard: the same container may already be serviced by a daemon
    # started from a DIFFERENT worktree — the per-cwd file above can't see it. Two
    # daemons on one container breach every spawn gate (incident 2026-06-10). The claim
    # is taken ATOMICALLY before the spawn (not checked-then-written-after), so two
    # concurrent --ensure calls can't both pass and double-spawn [P1 review].
    claim_won = False
    if cid:
        claim_won, holder = _claim_container(cid)
        if not claim_won and holder is not None:
            if not quiet:
                if holder[0]:
                    frm = f" from {holder[1]}" if holder[1] else ""
                    print(f"[notifier] already running for this container (pid {holder[0]}{frm})")
                else:
                    print("[notifier] another --ensure is starting this container's daemon — yielding")
            return True
        # claim_won=False with holder=None: claim file unusable — per-cwd guard only
    exe = shutil.which("orcha")
    argv = [exe, "notifier", "--quiet"] if exe else [sys.executable, "-m", "orcha_cli", "notifier", "--quiet"]
    if cid:
        # [#218 hardening] carry the container in the argv so `ps` is self-explanatory —
        # during the 2026-06-10 incident every daemon read as an identical `orcha notifier
        # --quiet` and a legitimate other-project daemon was killed as a "duplicate". Also
        # makes the daemon pgrep-able by container (`pgrep -f 'orcha notifier.*<cid>'`).
        # Same value the daemon would resolve from this cwd's orcha.json — not a behavior change.
        argv += ["--container", cid]
    log = _log_path(cwd)
    log.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(log, "ab") as lf:
            proc = subprocess.Popen(argv, cwd=str(cwd), stdout=lf, stderr=lf,
                                    stdin=subprocess.DEVNULL, start_new_session=True)
    except (OSError, subprocess.SubprocessError) as e:
        if claim_won:
            try:
                _global_pid_path(cid).unlink()  # release the claim — nothing was spawned
            except (FileNotFoundError, OSError):
                pass
        if not quiet:
            print(f"[notifier] could not start daemon: {e}", file=sys.stderr)
        return False
    _pid_path(cwd).write_text(str(proc.pid))
    if cid:
        # hand the claim to the child: replace our provisional claimant pid with the
        # daemon's, so liveness now tracks the daemon (not this short-lived parent)
        _write_global_pid(cid, proc.pid, cwd)
    if not quiet:
        print(f"[notifier] started daemon (pid {proc.pid}); log: {log}")
    return True


# ---------- subcommand entry ----------

def cmd_notifier(args) -> None:
    import signal
    cwd = pathlib.Path.cwd()
    # Make ORCHA_SECRET_KEY available so the daemon can unseal wake-path provider keys carried
    # (sealed) on the wake-scan. `orcha up` brings the daemon up without exporting it, so load it
    # from <project>/.orcha/.env here (best-effort; absent ⇒ daemon stays on its env keys).
    _load_master_key_from_env_file()

    # ISS-22 explicit operator verbs (NOT hooks — never auto-fired in a managed embodiment, so
    # they are not gated on ORCHA_HEADLESS_WORKER/ORCHA_LIVE the way --ensure is). Scoped to the
    # notifier daemon for THIS project's container — distinct from `orcha down` (whole stack).
    if getattr(args, "stop", False):
        stopped = stop_daemon(cwd, quiet=args.quiet)
        if not args.quiet and not stopped:
            print("[notifier] no running daemon for this project — nothing to stop")
        return
    if getattr(args, "restart", False):
        # stop the running daemon (bounded wait, SIGKILL after grace) then spawn a fresh one
        ensure_daemon(cwd, quiet=args.quiet, restart=True)
        return

    # `--ensure`: idempotent singleton spawn (used by init/up/SessionStart). Returns
    # immediately; the spawned child runs the loop below.
    if getattr(args, "ensure", False):
        # ISS-21 + R1/S3: a managed embodiment must NOT manage the daemon — skip the
        # SessionStart `notifier --ensure` hook inside a headless wake worker
        # (ORCHA_HEADLESS_WORKER, spawn_headless) or an S3 live terminal (ORCHA_LIVE, PTY bridge).
        if os.environ.get("ORCHA_HEADLESS_WORKER") or os.environ.get("ORCHA_LIVE"):
            if not args.quiet:
                kind = "headless worker" if os.environ.get("ORCHA_HEADLESS_WORKER") else "live terminal session"
                print(f"[notifier] {kind} — skipping notifier --ensure (managed embodiment doesn't manage the daemon)")
            return
        ensure_daemon(cwd, quiet=args.quiet)
        return

    api_base, cid = _api_and_cid(cwd, args.api_base, args.container)

    # Reachability backfill (PR #126) records headless_cwd = the daemon's cwd, then spawns a worker
    # there that must find THIS project's .claude config + orcha skills to drain the wake. Only
    # enable it when cwd is the project root FOR THE RESOLVED TARGET — i.e. its .claude/orcha.json
    # names the same api_base + container we're waking. Existence alone is NOT enough: in the
    # explicit --api-base/--container "run from anywhere" mode (systemd/demo) the daemon can be
    # launched from an UNRELATED Orcha project root whose cwd/config/skills belong to a different
    # container — backfilling that into the target container spawns a misconfigured worker and acks
    # the event as delivered yet undrained, LOSING the wake. On a mismatch (or no/!readable config)
    # we pass None and skip the pre-pass. The normal no-override daemon path resolves api_base+cid
    # FROM this same config, so it always matches and backfill stays on. [review P1 x2]
    project_cwd = None
    _cfg_path = cwd / ".claude" / "orcha.json"
    if _cfg_path.exists():
        try:
            _cfg = json.loads(_cfg_path.read_text())
            if ((_cfg.get("api_base_url") or "").rstrip("/") == api_base
                    and _cfg.get("current_container_id") == cid):
                project_cwd = str(cwd)
        except (OSError, ValueError):
            project_cwd = None

    if args.once:
        # --once is fire-and-forget: no live_workers, no reap_workers, so NOTHING releases
        # the single-flight lease early — only its TTL does. The 1200s hard-cap default is a
        # DAEMON concept (the watchdog manages long runs); in --once it would become a 20-min
        # wake-suppression window. Cap --once at a short lease so the stopgap stays responsive
        # (honors an explicitly-lower --lease-ttl).
        once_ttl = min(getattr(args, "lease_ttl", 1200.0), 300.0)
        tick(api_base, cid, dry_run=args.dry_run, cooldown=args.cooldown,
             min_idle=args.min_idle, quiet=args.quiet, lease_ttl=once_ttl, base_cwd=project_cwd)
        return

    # [#218 hardening] Refuse to start a daemon for a container this API definitively does
    # not know (HTTP 404) — that daemon would be a permanent no-op that still looks alive in
    # ps (stale orcha.json after a port/stack reshuffle, 2026-06-10 postmortem). A merely
    # UNREACHABLE API is tolerated after brief retries: `orcha up` may still be booting, and
    # wake-on-boot must not brick on a race. Runs BEFORE any pid/claim file is written.
    probe = _probe_container(api_base, cid)
    for _ in range(5):
        if probe != "unreachable":
            break
        time.sleep(2.0)
        probe = _probe_container(api_base, cid)
    if probe == "missing":
        sys.exit(f"[notifier] container {cid} does not exist at {api_base} — refusing to start "
                 f"a no-op daemon. This usually means a stale .claude/orcha.json (api_base_url/"
                 f"current_container_id from a previous stack). Fix the config or re-run "
                 f"`orcha connect <project>`.")

    stop = {"flag": False}

    def _handle(signum, frame):
        stop["flag"] = True

    signal.signal(signal.SIGTERM, _handle)
    signal.signal(signal.SIGINT, _handle)
    # Own the PID file so `--ensure` / `daemon_running` detect this loop and never
    # double-spawn (even when started directly rather than via ensure_daemon).
    pid_file = _pid_path(cwd)
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    pid_file.write_text(str(os.getpid()))
    # own the container-keyed file too (cid resolved above) — a directly-started daemon
    # (not via --ensure) must still be visible to --ensure from OTHER worktrees
    _write_global_pid(cid, os.getpid(), cwd)
    if not args.quiet:
        print(f"[notifier] daemon up (pid {os.getpid()}) — scanning {api_base} every {args.interval}s "
              f"(cooldown={args.cooldown}s, min-idle={args.min_idle}s). Ctrl-C to stop.")
    live_workers: dict = {}   # {agent_id: pid} — for releasing leases on worker exit
    live_residents: dict = {}  # {conversation_id: resident-state} — E3 warm conversation sessions
    reconcile_codex_conversation_runs(api_base, cid, live_residents, quiet=args.quiet,
                                      base_cwd=str(cwd))
    try:
        while not stop["flag"]:
            try:
                # Release leases of workers that finished since the last tick, BEFORE
                # scanning, so a just-finished agent with fresh work is wakeable now.
                reap_workers(api_base, live_workers, args.quiet,
                             stall_secs=getattr(args, "stall_secs", 120.0))
                # ISS-60(B): TTL-independent backstop for an orphan lease that outlived its
                # embodiment (daemon restart / externally-spawned resident the in-memory
                # live_workers/live_residents maps no longer track, so neither reap path above
                # releases it). Heartbeat-keyed, so it never touches a live (heartbeating) one.
                reap_orphan_leases(api_base, cid, args.quiet)
                # #342: container-wide dead-pid sweep — reconcile orphaned EPHEMERAL (and any) runs
                # left status='running' by a PRIOR daemon whose Popen handles this process never
                # inherited. Keyed on the host os.kill(pid,0) (not lease/heartbeat state), so it
                # catches a run whose lease already expired — the gap reap_orphan_leases (live-lease
                # only) and the per-agent resident reaper (active-conversation only) both miss. Shield
                # THIS daemon's genuinely-live workers + residents from a racing os.kill.
                live_pids = frozenset(
                    w["proc"].pid for w in live_workers.values() if w.get("proc") is not None
                ) | frozenset(
                    r["proc"].pid for r in live_residents.values() if r.get("proc") is not None
                )
                reap_orphaned_runs(api_base, cid, live_pids, quiet=args.quiet)
                # E3: drive warm resident conversation sessions (capture replies, feed new turns,
                # idle-reap) BEFORE tick() — a live resident holds the embodiment lease, so the
                # ephemeral scan correctly suppresses a double-spawn for the same agent.
                service_residents(api_base, cid, live_residents, quiet=args.quiet,
                                  dry_run=args.dry_run, base_cwd=str(cwd))
                tick(api_base, cid, dry_run=args.dry_run, cooldown=args.cooldown,
                     min_idle=args.min_idle, quiet=args.quiet,
                     lease_ttl=getattr(args, "lease_ttl", 1200.0),
                     live_workers=live_workers, base_cwd=project_cwd)
            except Exception as e:  # a daemon must not die on a transient error
                if not args.quiet:
                    print(f"[notifier] tick error (continuing): {e}", file=sys.stderr)
            slept = 0.0
            while slept < args.interval and not stop["flag"]:
                time.sleep(min(0.25, args.interval - slept))
                slept += 0.25
    finally:
        try:
            if pid_file.read_text().strip() == str(os.getpid()):
                pid_file.unlink()
        except (FileNotFoundError, ValueError, OSError):
            pass
        # drop the container claim too — but only if it's still OURS (a restart may
        # already have handed it to a replacement daemon)
        try:
            gp = _global_pid_path(cid)
            if gp.read_text().splitlines()[0].strip() == str(os.getpid()):
                gp.unlink()
        except (FileNotFoundError, ValueError, IndexError, OSError):
            pass
    if not args.quiet:
        print("[notifier] stopped.")
