"""Orcha API + read-only dashboard (Phase 3 + request chains from Orcha#1).

Containers:
    POST /api/containers                          create container + root task
    GET  /api/containers/{cid}                    full snapshot
    POST /api/containers/{cid}/status             flip status (active|paused|completed|cancelled)
    POST /api/containers/{cid}/sweep              escalate any open requests past expires_at
    GET  /api/containers/{cid}/events             SSE: container-wide events (escalations, suggestions)

Agents:
    POST /api/containers/{cid}/agents             register agent (optional initial_task)
    POST /api/agents/{aid}/next                   atomically claim next ready task
    GET  /api/agents/{aid}/inbox                  open info requests addressed to me (incoming)
    GET  /api/agents/{aid}/outbox?status=...      my outgoing requests (default: non-closed)
    GET  /api/agents/{aid}/wait?since_ts=...      long-poll next event (used by /orcha-listen)
    GET  /api/agents/{aid}/events                 SSE stream of events addressed to me

Tasks:
    POST /api/containers/{cid}/tasks              create a task (optionally assign + claim)
    POST /api/tasks/{tid}/messages                append to task thread (bumps heartbeat+turns)
    POST /api/tasks/{tid}/done                    agent marks needs_verification (bumps)
    POST /api/tasks/{tid}/assign                  human assigns an existing task to an agent + wakes them (B5)
    POST /api/tasks/{tid}/verify                  human approves -> completed, or rejects with feedback

Requests:
    POST /api/containers/{cid}/requests           Phase 2: type='info' agent A asks agent B.
                                                  Phase 3 (Orcha#5): type='task' carries the task spec
                                                  in body.task; target /accept-task-s or /reject-task-s.
                                                  Optional parent_request_id chains it (Orcha#1).
    POST /api/requests/{rid}/respond              info: target answers (open -> answered).
    POST /api/requests/{rid}/close                requester closes after satisfied (answered -> closed)
    POST /api/requests/{rid}/triage-close         #288: daemon auto-closes a pure-ack answered request (system actor)
    POST /api/requests/{rid}/escalate             requester pushes to human (target_id -> null)
    POST /api/requests/{rid}/accept-task          Phase 3: target accepts a task request → creates+claims task
    POST /api/requests/{rid}/reject-task          Phase 3: target rejects a task request with reason
    POST /api/requests/{rid}/suggest-agent        Phase 3: requester proposes a new agent to human
                                                  (kind='create'|'reassign'|'refuse')
    POST /api/requests/{rid}/convert-to-task      Phase 3: requester converts answered-but-insufficient
                                                  info request into a real task
    POST /api/agent-suggestions/{rid}/decide      Phase 3: human resolves an agent suggestion

Onboarding:
    POST /api/onboarding/propose                  SPEC-292 streaming roster proposal

Compat:
    GET  /api/snapshot/{cid}                      alias for /api/containers/{cid}
    GET  /                                        read-only HTML dashboard
"""
import asyncio
import json
import logging
import pathlib
import os
import queue
import re
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Literal, Optional

import psycopg
from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from psycopg.rows import dict_row
from pydantic import BaseModel, Field

# secret_box (#294): at-rest encryption for the per-container LLM API key. Same dual-context
# trick the design uses for llm_util — the portal container imports it top-level (copied in at
# scaffold alongside main.py), while host/test runs import it from the orcha_cli package.
try:  # portal container: secret_box.py sits next to main.py
    import secret_box
except ImportError:  # host daemon / pytest: import from the package on sys.path
    from orcha_cli import secret_box

# llm_util (#290): the universal LLM client. #294 reads its catalog + use-case registry here to
# serve the SETTINGS model-picker and to resolve the per-container triage model for wake-scan.
# Same dual-context import as secret_box.
try:  # portal container: llm_util.py sits next to main.py
    import llm_util
except ImportError:  # host daemon / pytest: import from the package on sys.path
    from orcha_cli import llm_util

# #287 write-side digest dedup (Tier-0 compaction). Copied alongside main.py in the portal build
# (see __main__._install_llm_util / _PORTAL_SHARED_MODULES, like llm_util/secret_box). Guarded so
# a missing copy degrades to storing the raw digest rather than 500-ing POST /digest.
try:  # portal container: digest_curate.py sits next to main.py
    import digest_curate as _digest_curate
except ImportError:  # host daemon / pytest: import from the package on sys.path
    try:
        from orcha_cli import digest_curate as _digest_curate
    except ImportError:
        _digest_curate = None

DB = os.environ["DATABASE_URL"]
ONBOARDING_LOG = logging.getLogger("orcha.onboarding")

# ---------- Phase 3 / Orcha#5 + Orcha#25: durable DB-backed event bus ----------
# This was an in-process ring buffer (_event_buf): events published while no
# agent held an open long-poll were silently dropped, and a portal restart wiped
# the whole buffer (Orcha#25 — durability bug). The bus is now backed by the
# agent_events table:
#   * _publish_event persists in the SAME transaction as its mutating endpoint
#     (the caller hands in its open cursor), so an event is visible atomically
#     with the state change it announces and is never lost to a crash or restart.
#   * _wait_for_event polls that table instead of memory, so a reconnecting agent
#     replays every event with ts > its cursor, in order.
# Delivery keys are unchanged: the target agent's id (as text) for agent-addressed
# events, or "c:<container_id>" for container-wide ones. A publish carrying both a
# target and a container writes one row per key (the old two-bucket fan-out), so
# container SSE still observes agent-addressed events.


def _publish_event(cur, container_id: Optional[str], target_agent_id: Optional[str],
                   event_name: str, payload: dict) -> None:
    """Persist an event to agent_events via the caller's OPEN cursor.

    Must run inside the same transaction as the state change it announces — the
    caller commits afterward, which is what makes the event atomic with its
    cause. Writes one row per delivery key (agent key and/or container key).
    """
    ts = time.time()
    body = json.dumps(payload)
    keys: list[tuple[str, Optional[str]]] = []
    if target_agent_id:
        keys.append((str(target_agent_id), str(target_agent_id)))
    if container_id:
        keys.append((f"c:{container_id}", None))
    for event_key, tgt in keys:
        cur.execute(
            """INSERT INTO agent_events
                 (container_id, target_id, event_key, event_name, ts, payload)
               VALUES (%s, %s, %s, %s, %s, %s::jsonb)""",
            (container_id, tgt, event_key, event_name, ts, body),
        )


def _poke_path_forward(cur, container_id, recipient_id, from_agent_id, message) -> None:
    """ISS-42 (B12, reject-loop): after a reject/cancel, give the affected agent an ACTIONABLE wake.

    A plain `task_request_rejected` / `decision_made` event wakes the agent but carries NO surfaced
    content — `build_wake_prompt` and the resident inbox drain only inject `prompt`/`task_message`
    events into the agent's turn (`_collect_directed_messages`), and a rejected request never shows in
    the `outbox?status=answered` drain. So the agent wakes, finds nothing actionable, and exits: the
    reject/cancel reason AND the path forward never reach it — the dead-end this issue is about.

    We piggyback the existing A3 `prompt` poke primitive (the documented keystone for B12): a directed
    `prompt` event IS surfaced verbatim into the agent's wake/drain turn AND counts as pending work in
    wake-scan, so the agent re-engages with the reason + concrete next steps in hand. Published on the
    recipient's key only (a poke is point-to-point; the machine event already hit the container key)."""
    _publish_event(cur, container_id, recipient_id, "prompt",
                   {"message": message, "from_agent_id": from_agent_id})


def _fetch_next_event(key: str, since_ts: float) -> Optional[dict]:
    """First agent_events row for `key` strictly newer than since_ts, or None.

    Opens its own short-lived connection (it runs off the async loop in a worker
    thread). Reconstructs the same {event, ts, **payload} shape the in-process
    buffer used to return, so callers are unchanged.
    """
    with db_cursor() as (_, cur):
        cur.execute(
            """SELECT event_name, ts, payload FROM agent_events
               WHERE event_key = %s AND ts > %s
               ORDER BY ts, id
               LIMIT 1""",
            (key, since_ts),
        )
        row = cur.fetchone()
    if not row:
        return None
    return {"event": row["event_name"], "ts": row["ts"], **(row["payload"] or {})}


async def _wait_for_event(key: str, since_ts: float, timeout_s: float,
                          poll_interval_s: float = 0.5) -> Optional[dict]:
    """Return the first agent_events row for `key` newer than since_ts, or None.

    Polls the table every poll_interval_s in a worker thread (psycopg is sync, so
    this keeps the event loop unblocked). At localhost scale (a few agents, ~1s
    latency tolerance) a short poll is simpler and sturdier than LISTEN/NOTIFY,
    and the (event_key, ts, id) index makes each probe a cheap range scan.
    """
    deadline = time.time() + timeout_s
    while True:
        evt = await asyncio.to_thread(_fetch_next_event, key, since_ts)
        if evt is not None:
            return evt
        if time.time() >= deadline:
            return None
        await asyncio.sleep(poll_interval_s)

# ---------- static HTML loader (review #7) ----------
# Each dashboard page used to be a ~500-line triple-quoted constant in this
# file. They now live in portal/static/*.html, read once at import time and
# cached. The route handlers below call _serve(name) instead of returning the
# constant directly.
_STATIC_DIR = pathlib.Path(__file__).parent / "static"
_HTML_CACHE: dict[str, str] = {}


def _serve(name: str) -> HTMLResponse:
    # Issue #13: if portal/static/ (or a single page) is missing, the project's
    # stack predates PR #10 (when the dashboard HTML moved out of main.py into
    # static/). A browser hitting /requests would otherwise get a bare 500 /
    # FileNotFoundError with no clue what to do. Instead, render a styled,
    # actionable page (503 — the server is up but mis-provisioned) that names
    # the exact fix. This is what makes #13 "loads with a clear message"
    # instead of "white screen / raw 500".
    if name not in _HTML_CACHE:
        path = _STATIC_DIR / name
        if not path.is_file():
            dir_missing = not _STATIC_DIR.is_dir()
            cause = (
                "the portal/static/ directory is missing entirely"
                if dir_missing
                else f"portal/static/{name} is missing"
            )
            return HTMLResponse(_missing_static_page(name, cause), status_code=503)
        _HTML_CACHE[name] = path.read_text(encoding="utf-8")
    return HTMLResponse(_HTML_CACHE[name])


def _missing_static_page(name: str, cause: str) -> str:
    # Self-contained (no external CSS/JS — those are the files that are missing)
    # error page, themed to match the dashboard so it doesn't look like a crash.
    return f"""<!doctype html>
<html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width, initial-scale=1">
<title>Orcha · portal not provisioned</title>
<style>
  body{{margin:0;min-height:100vh;display:grid;place-items:center;
    background:#0b0e14;color:#e6ebf5;
    font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial}}
  .card{{max-width:640px;margin:24px;padding:28px 30px;background:#141925;
    border:1px solid #263149;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.35)}}
  h1{{margin:0 0 6px;font-size:20px}}
  .sub{{color:#fbbf24;font-weight:600;margin-bottom:18px}}
  p{{color:#8a97b1;margin:10px 0}}
  code,pre{{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}}
  pre{{background:#0b0e14;border:1px solid #263149;border-radius:10px;
    padding:12px 14px;overflow-x:auto;color:#e6ebf5}}
  .muted{{color:#5b6680;font-size:13px;margin-top:18px}}
</style></head><body>
<div class=card>
  <h1>Portal not fully provisioned</h1>
  <div class=sub>Static page <code>{name}</code> couldn&#39;t be served</div>
  <p>The API is running, but {cause}. This <code>.orcha/</code> stack most
     likely predates PR&nbsp;#10, when the dashboard HTML moved out of
     <code>main.py</code> into <code>portal/static/</code>.</p>
  <p>Fix it from this project root:</p>
  <pre>uv tool install --reinstall --from &lt;repo&gt;/orcha-cli orcha-cli
orcha down -v &amp;&amp; orcha init</pre>
  <p class=muted>After re-init, reload this page (a hard refresh clears any
     cached old bundle). — Orcha #13</p>
</div></body></html>"""


app = FastAPI(title="Orcha API", version="0.6.0")

# D0 (portal redesign): serve the shared design-system assets (styles.css, app.js,
# and any future D-series static files) from portal/static at /assets. Read per
# request — unlike the import-time _HTML_CACHE pages, asset edits show up without a
# restart, which keeps D1-D6 iteration fast. A mount (not an @app route), so it is
# not part of the Swagger/OpenAPI API surface (static assets aren't API routes).
# Mount ONLY when portal/static/ exists: a mis-provisioned old stack (#13) must still
# BOOT and _serve() its styled "run orcha up" 503. Without the dir we skip the mount
# entirely, so /assets/* is a harmless 404 — not an import crash (check_dir=True) nor a
# runtime 500 (Starlette's lazy check_config on a missing dir). check_dir=False guards
# the slim race where the dir vanishes after this check.
if _STATIC_DIR.is_dir():
    app.mount("/assets", StaticFiles(directory=str(_STATIC_DIR), check_dir=False), name="assets")


@app.middleware("http")
async def _no_store_dynamic_responses(request, call_next):
    """#140 (onboarding 'ghost'): after a workspace reset the portal could still show an
    agent that no longer exists until a HARD refresh. One contributor (the issue names
    three) is the **browser HTTP cache**: the portal HTML shells and the live `/api/*`
    JSON carried NO cache headers, so a soft refresh could re-render a cached onboarding
    success screen / stale roster instead of re-fetching live state.

    Mark every dynamic response `no-store` so the browser always revalidates against the
    DB on reload. Scope = the HTML page shells (content-type text/html, incl. the #13 503)
    + all `/api/*` responses (JSON snapshots and the SSE event stream, which must never be
    cached anyway). URL-versioned `/assets/*` (css/js) are intentionally left cacheable —
    asset staleness is a separate, restart-driven concern, not the reset ghost. This is the
    infra half of #140; clearing the SPA's own client state on reset stays frontend-owned."""
    response = await call_next(request)
    ctype = response.headers.get("content-type", "")
    if request.url.path.startswith("/api/") or ctype.startswith("text/html"):
        response.headers["Cache-Control"] = "no-store"
    return response


ALLOWED_CONTAINER_STATUSES = {"active", "paused", "completed", "cancelled", "failed"}

# The full request lifecycle vocabulary (requests.status, free TEXT — see
# migrations/001_init.sql:111). Used to validate the optional ?status filter on the
# paginated request list so callers can scope a census to one lifecycle state instead
# of silently mixing in closed/answered rows.
REQUEST_STATUSES = {"open", "accepted", "rejected", "answered", "converted_to_task", "closed"}

# D7: the curated model list the create-agent dropdown renders. There is no live
# "list models" API from the CLI, so this is a maintained constant ({id, name}).
# The selected id is persisted on agents.model; B8 adds the picker UI + the
# `--model` launch (notifier spawns the worker with the chosen model). `runtime`
# names the local coding-agent CLI that can actually run the model.
AVAILABLE_MODELS = [
    {"id": "claude-opus-4-8", "name": "Opus 4.8", "runtime": "claude"},
    # Fable 5 is a LIMITED-AVAILABILITY model (offered only through 2026-06-22). Per-agent
    # selection works while it's listed here; the moment this entry is removed, every agent
    # that had chosen it auto-falls-back to DEFAULT_MODEL at spawn time (resolve_model below)
    # with ZERO breakage — the persisted agents.model choice is left intact, so re-adding the
    # entry restores it automatically. To retire Fable: just delete this one line.
    {"id": "claude-fable-5", "name": "Fable 5", "runtime": "claude"},
    {"id": "claude-sonnet-4-6", "name": "Sonnet 4.6", "runtime": "claude"},
    {"id": "claude-haiku-4-5-20251001", "name": "Haiku 4.5", "runtime": "claude"},
    {"id": "gpt-5.5", "name": "GPT-5.5", "runtime": "codex"},
    {"id": "gpt-5.4", "name": "GPT-5.4", "runtime": "codex"},
    {"id": "gpt-5.4-mini", "name": "GPT-5.4 mini", "runtime": "codex"},
    {"id": "gpt-5.3-codex-spark", "name": "GPT-5.3 Codex Spark", "runtime": "codex"},
]
DEFAULT_MODEL = "claude-opus-4-8"
_MODEL_IDS = {m["id"] for m in AVAILABLE_MODELS}
_MODELS_BY_ID = {m["id"]: m for m in AVAILABLE_MODELS}


def resolve_model(model: Optional[str]) -> str:
    """Map a PERSISTED agents.model choice to the model id to actually spawn with.

    The curated AVAILABLE_MODELS list is the single source of truth for what is spawnable
    RIGHT NOW. A persisted choice that is no longer listed (a limited-availability model like
    Fable 5 that has been retired, or an id from an older deploy) gracefully falls back to
    DEFAULT_MODEL — so a removed model never reaches the `--model` argv and breaks the spawn.
    The agent's stored choice is NOT mutated, so if the model is ever re-listed the agent picks
    it back up. NULL (no choice / a future non-Claude platform) also resolves to the default."""
    return model if model in _MODEL_IDS else DEFAULT_MODEL


def resolve_model_runtime(model: Optional[str]) -> str:
    """Return the local agent runtime for a persisted/resolved model id.

    Unknown or retired ids first resolve through DEFAULT_MODEL, preserving the same
    zero-breakage fallback as resolve_model. Existing Claude agents therefore remain
    Claude-backed, while Codex model selections tell the host daemon to spawn Codex.
    """
    return _MODELS_BY_ID.get(resolve_model(model), {}).get("runtime", "claude")

# Item 8 (review): cap user-supplied text to keep snapshots bounded and the DB sane.
# Bytes, not chars — Postgres TEXT has no hard limit, but every snapshot returns these.
MAX_NAME_LEN     = 200
MAX_DESC_LEN     = 4_000
MAX_PROMPT_LEN   = 8_000
MAX_PAYLOAD_LEN  = 4_000   # request / answer text + task result
MAX_TURN_LEN     = 100_000 # a conversation turn (human message or an agent 'result' final text)
# A3: aggregate cap on the directed-prompt batch surfaced in one wake. Each prompt is bounded by
# MAX_PAYLOAD_LEN, but an accumulated backlog concatenated into a single `claude -p` / tmux argv
# could blow the OS arg limit → spawn fails → the same too-big batch retries forever. wake-scan
# surfaces at most this many chars of prompts and tells the daemon to ack only through the last
# INCLUDED one; the rest stay pending for the next wake (progress, no loss, no argv blowup).
MAX_PROMPT_BATCH_CHARS = 24_000
# ISS-58: self-echo / notification events that must NEVER by themselves wake an agent. The C1
# digest snapshot emits `digest_snapshotted` (a dashboard notification, not actionable work); when
# it was delivered to the agent's OWN key it self-woke the agent in a ~60s loop (the wake spawns a
# worker → SessionEnd snapshots → republishes → re-wakes). The publish is now container-scoped
# (target=NULL), and wake-scan also excludes these names from its should_wake count as a backstop.
_NON_WAKING_EVENTS = ("digest_snapshotted",)
# ISS-75 (#188) / ISS-77 (#200): the SOLE event that must NOT, on its own, trigger a RESIDENT
# inbox-drain. `request_closed` is SELF-ECHOING: when the resident drains and closes a request, the
# close emits a NEW `request_closed` event → re-counts as pending_inbox → re-drains → the #185
# runaway (a turn burned every tick). It carries no drain surface, so excluding it loses nothing.
# ISS-77 CORRECTION: `request_answered` was ALSO excluded here, which stranded a resident whose
# request got answered — it never woke to act on the answer. But `request_answered` does NOT
# self-echo (acting on an answer doesn't emit another `request_answered`), so it is a genuine
# "my request was answered → wake + act" signal and MUST count toward the drain. It is no longer
# excluded. The exclusion is scoped to the resident drain count ONLY — the ephemeral one-shot wake
# path (gated by _NON_WAKING_EVENTS, digest_snapshotted only) still wakes on request_closed too
# (a worker resumes a parent then EXITS, so it can't loop). Mirrors ISS-58.
# `request_created` (a NEW incoming request TO the resident) is NOT here — it is real, actionable work.
_RESIDENT_DRAIN_AUDIT_EVENTS = ("request_closed",)
# #288 wake-suppression: terminal / FYI event types whose LONE, BARE delivery is a "no-action"
# wake — the recipient would spawn an ephemeral worker only to find nothing to do. wake-scan
# uses this set (plus `request_answered`, handled by LLM triage) to attach a `triage_hint` to a
# candidate; the notifier daemon makes the actual suppress decision and ALWAYS fails open (any
# error/ambiguity wakes). Per Helm's bareness rule, a human comment riding on any of these flips
# it from a silent structural skip to LLM triage — never a silent drop of human-authored content.
_TIER0_FYI_EVENTS = ("request_closed", "task_verified", "agent_suggestion_decided")


def _triage_hint_for(event_name, payload, *, full_answer=None):
    """#288: classify a single pending event into a wake-suppression *hint*, or return None when
    the event must always wake (the conservative default).

    Returns ``{tier, event_name, bare, request_id, text}``:
      - ``tier='structural'`` — a BARE terminal/FYI event: the daemon skips the spawn
        deterministically ($0, no LLM). ``request_id`` stays None (nothing to auto-close).
      - ``tier='llm'`` — feed ``text`` to ``llm_util.triage_wake`` (which fails open to wake).
        For ``request_answered`` this is the answer text and ``request_id`` is set so a pure-ack
        verdict auto-closes the request. For a structural FYI that CARRIES a human note
        (Helm's bareness rule) the note is triaged instead of being silently skipped.

    Only ever called for a candidate whose ONLY pending signal is this one event (pending==1, no
    ready task, no directed message) — so suppressing it cannot hide other actionable work."""
    payload = payload or {}
    if event_name == "request_answered":
        # the AMBIGUOUS case: an answer always carries text, so the LLM decides ack-vs-follow-up.
        # #307 T2: if it IS a pure ack, the routine next-hop is to CLOSE the request — a cheap
        # write the daemon can do on the 'ack' substrate instead of a full embodiment. The `t2`
        # tag rides alongside `tier` (the suppress path ignores it); the graded-wake decider only
        # consults it when the cheap rules DON'T already suppress.
        return {"tier": "llm", "event_name": event_name, "bare": False,
                "request_id": payload.get("request_id"),
                "text": (full_answer or payload.get("preview") or ""),
                "t2": {"action": "ack_close", "request_id": payload.get("request_id")}}
    if event_name == "request_closed":
        # a human force-close ROUTES its reason as a SEPARATE prompt event (pending would be >1),
        # so a lone request_closed is always bare. Nothing to auto-close (already closed).
        return {"tier": "structural", "event_name": event_name, "bare": True,
                "request_id": None, "text": ""}
    if event_name == "task_verified":
        if payload.get("approved") is not True:
            return None   # a REJECTED verify is a rework signal — always wake
        feedback = (payload.get("feedback") or "").strip()
        if not feedback:
            return {"tier": "structural", "event_name": event_name, "bare": True,
                    "request_id": None, "text": ""}
        # approved WITH a verifier note → triage the note (bareness rule), don't silently skip.
        # #307 T2: an APPROVAL's only routine next-hop is acknowledging the note on the task
        # thread — a cheap write, no full boot. Tag it so the graded-wake decider can route the
        # ack to the 'ack' substrate when it would otherwise spend a full embodiment.
        return {"tier": "llm", "event_name": event_name, "bare": False,
                "request_id": None, "text": feedback,
                "t2": {"action": "ack_verify", "task_id": payload.get("task_id")}}
    if event_name == "agent_suggestion_decided":
        if payload.get("kind") != "refuse":
            return None   # create/reassign → a new agent/target now owns it; requester should wake
        reason = (payload.get("reason") or "").strip()
        if not reason:
            return {"tier": "structural", "event_name": event_name, "bare": True,
                    "request_id": None, "text": ""}
        return {"tier": "llm", "event_name": event_name, "bare": False,
                "request_id": None, "text": reason}
    return None


# ---------- #247 KEYSTONE: typed notification registry (classify-over-the-bus) ----------
# The durable bus (agent_events) is ALREADY a per-recipient stream — rows keyed on the target
# agent's id, indexed (event_key, ts, id). What it LACKS is a typed taxonomy, a priority/ranking,
# and per-recipient read-state. The #247 registry supplies those by laying a typed classifier +
# a read-cursor + a read-API OVER the existing bus — NOT a parallel notifications table (events
# already persist atomically with their cause; a dual-write would only re-introduce drift).
# Classification is PURE and happens at READ time, so wake/notifier behaviour is unchanged.
#
# Each notification carries two ORTHOGONAL axes:
#   * zone     — SPEC-3 visual grouping: 'needs_you' (actionable) vs 'earlier' (informational).
#                The canonical NEEDS-YOU surface stays sourced from live attnItems(); this zone
#                is a high-signal hint a consumer MAY use to pull an item up.
#   * priority — a numeric DRAIN rank for the downstream wake-boot router, ordered to the locked
#                #247 contract ladder (Helm sign-off), highest first:
#                  interrupt/stop > approval|rejection-on-own-work > live human convo
#                  > task-assignment|thread-msg > request-in > answer-to-request > human close/cancel
#                Lower int = higher priority; gaps leave room for future rungs. The canonical drain
#                order is `ORDER BY priority ASC, ts ASC` — DOCUMENTED here; the actual drain-then-park
#                wake-boot BEHAVIOUR is the downstream D task, NOT wired in this keystone.
_NOTIF_PRI_INTERRUPT   = 0    # a directed interrupt / nudge injected into my turn
_NOTIF_PRI_OWN_WORK    = 10   # an approve / reject / decision on work or an ask that is MINE
_NOTIF_PRI_HUMAN_CONVO = 20   # a human needs me / an escalation surfaced to the operator
_NOTIF_PRI_TASK        = 30   # task assignment / readiness / thread message
_NOTIF_PRI_REQUEST_IN  = 40   # a fresh incoming request from another agent
_NOTIF_PRI_ANSWER      = 50   # a request of mine was answered
_NOTIF_PRI_CLOSE       = 60   # a request of mine was closed / cancelled
_NOTIF_PRI_UNKNOWN     = 90   # an event_name with no taxonomy entry (graceful degrade)

_NOTIF_PRIORITY_LADDER = [
    (_NOTIF_PRI_INTERRUPT, "interrupt"),
    (_NOTIF_PRI_OWN_WORK, "own_work"),
    (_NOTIF_PRI_HUMAN_CONVO, "human_conversation"),
    (_NOTIF_PRI_TASK, "task"),
    (_NOTIF_PRI_REQUEST_IN, "request_in"),
    (_NOTIF_PRI_ANSWER, "answer"),
    (_NOTIF_PRI_CLOSE, "close"),
    (_NOTIF_PRI_UNKNOWN, "unknown"),
]
_NOTIF_PRIORITY_TO_RANK = {priority: i + 1 for i, (priority, _label) in enumerate(_NOTIF_PRIORITY_LADDER)}
_NOTIF_PRIORITY_TO_LABEL = dict(_NOTIF_PRIORITY_LADDER)
_WAKE_NOTIFICATION_MANIFEST_LIMIT = 20

# event_name -> static classification. `request_created` is resolved DYNAMICALLY (its rung
# depends on whether the requester is a human), so it is handled in _classify_notification, not
# here. `link_kind`/`link_field` name the entity the panel row deep-links to and the payload
# field carrying its id.
_NOTIF_TAXONOMY = {
    "prompt":                   {"type": "directed",         "zone": "needs_you", "priority": _NOTIF_PRI_INTERRUPT,   "link_kind": None,       "link_field": None},
    "task_verified":            {"type": "task_verified",    "zone": "earlier",   "priority": _NOTIF_PRI_OWN_WORK,    "link_kind": "task",     "link_field": "task_id"},
    "task_request_rejected":    {"type": "agent_blocked",    "zone": "needs_you", "priority": _NOTIF_PRI_OWN_WORK,    "link_kind": "request",  "link_field": "request_id"},
    "task_request_accepted":    {"type": "request_answered", "zone": "earlier",   "priority": _NOTIF_PRI_OWN_WORK,    "link_kind": "request",  "link_field": "request_id"},
    "agent_suggestion_decided": {"type": "plan_decided",     "zone": "earlier",   "priority": _NOTIF_PRI_OWN_WORK,    "link_kind": "request",  "link_field": "request_id"},
    "decision_made":            {"type": "plan_decided",     "zone": "earlier",   "priority": _NOTIF_PRI_OWN_WORK,    "link_kind": "decision", "link_field": "decision_id"},
    "request_escalated":        {"type": "escalation",       "zone": "needs_you", "priority": _NOTIF_PRI_HUMAN_CONVO, "link_kind": "request",  "link_field": "request_id"},
    "agent_suggested":          {"type": "agent_suggested",  "zone": "needs_you", "priority": _NOTIF_PRI_HUMAN_CONVO, "link_kind": "request",  "link_field": "request_id"},
    "task_assigned":            {"type": "task_assigned",    "zone": "earlier",   "priority": _NOTIF_PRI_TASK,        "link_kind": "task",     "link_field": "task_id"},
    "task_ready":               {"type": "task_ready",       "zone": "earlier",   "priority": _NOTIF_PRI_TASK,        "link_kind": "task",     "link_field": "task_id"},
    "task_message":             {"type": "task_message",     "zone": "earlier",   "priority": _NOTIF_PRI_TASK,        "link_kind": "task",     "link_field": "task_id"},
    "task_unassigned":          {"type": "task_unassigned",  "zone": "earlier",   "priority": _NOTIF_PRI_TASK,        "link_kind": "task",     "link_field": "task_id"},
    "request_answered":         {"type": "request_answered", "zone": "earlier",   "priority": _NOTIF_PRI_ANSWER,      "link_kind": "request",  "link_field": "request_id"},
    "request_closed":           {"type": "request_closed",   "zone": "earlier",   "priority": _NOTIF_PRI_CLOSE,       "link_kind": "request",  "link_field": "request_id"},
}

# event_names that must NEVER surface as an operator notification: the self-echo dashboard ping
# (digest_snapshotted, container-scoped so it doesn't even reach an agent key — suppressed defensively)
# and the live-conversation channel (conversation_turn — that is the chat transcript, delivered to the
# agent's OWN key, and is NOT a notification). The classifier returns None for these (dropped).
_NOTIF_SUPPRESSED = ("digest_snapshotted", "conversation_turn")

# payload fields carrying a short human-readable preview, in priority order.
_NOTIF_PREVIEW_FIELDS = ("preview", "message", "reason", "feedback", "title")
# payload fields carrying the acting agent's id, in priority order. Q2 (Helm sign-off): the actor is
# resolved at READ time from these — NO ~25-site agent_events.actor_id backfill; a missing actor
# degrades to None (SPEC-3 graceful-degrade covers it).
_NOTIF_ACTOR_FIELDS = ("from_agent_id", "by_agent_id")


def _classify_notification(event_name, payload, *, requester_is_human=False):
    """Classify one bus row into a typed notification, or None to suppress it.

    PURE (no DB) so it is exhaustively unit-testable. The route resolves the two read-time
    inputs the static taxonomy can't see — `requester_is_human` (the request_created
    human-convo-vs-request-in rung split) and the actor alias — and layers the read flag on top.

    Returns ``{type, zone, priority, deeplink: {kind, id} | None, actor_ref, preview}`` or
    ``None`` when the event must not appear in the feed.
    """
    payload = payload or {}
    if event_name in _NOTIF_SUPPRESSED:
        return None

    if event_name == "request_created":
        # A fresh incoming request addressed to me. A HUMAN requester is a live-human-convo rung
        # (the operator is talking to me); an AGENT requester is the ordinary request-in rung.
        if requester_is_human:
            spec = {"type": "escalation", "zone": "needs_you",
                    "priority": _NOTIF_PRI_HUMAN_CONVO, "link_kind": "request", "link_field": "request_id"}
        else:
            spec = {"type": "request_created", "zone": "needs_you",
                    "priority": _NOTIF_PRI_REQUEST_IN, "link_kind": "request", "link_field": "request_id"}
    else:
        spec = _NOTIF_TAXONOMY.get(event_name)
        if spec is None:
            # graceful degrade (SPEC-3 presenceOf pattern): an unknown event_name still renders,
            # typed by its raw name, parked at the bottom of the EARLIER zone — a new event type
            # never breaks the panel.
            spec = {"type": event_name, "zone": "earlier",
                    "priority": _NOTIF_PRI_UNKNOWN, "link_kind": None, "link_field": None}

    deeplink = None
    if spec["link_kind"]:
        lid = payload.get(spec["link_field"])
        if lid:
            deeplink = {"kind": spec["link_kind"], "id": str(lid)}

    actor_ref = None
    for f in _NOTIF_ACTOR_FIELDS:
        if payload.get(f):
            actor_ref = str(payload[f])
            break

    preview = ""
    for f in _NOTIF_PREVIEW_FIELDS:
        v = payload.get(f)
        if v:
            preview = str(v)
            break

    # #359: a TASK-request (a teammate asking me to DO work) is the one request kind whose correct
    # drain is "accept → spawn the task → work it", NOT "answer/defer to empty the inbox". The
    # static taxonomy can't see it (request_created is one event_name for both info and task), so
    # derive it from the payload `type` the create-route stamps on the bus event. The wake manifest
    # surfaces this so build_wake_prompt can steer the worker into the work instead of deflecting it.
    is_task_request = event_name == "request_created" and (payload.get("type") == "task")

    return {"type": spec["type"], "zone": spec["zone"], "priority": spec["priority"],
            "deeplink": deeplink, "actor_ref": actor_ref, "preview": preview,
            "is_task_request": is_task_request}


def _notification_rank(priority: int) -> int:
    return _NOTIF_PRIORITY_TO_RANK.get(priority, _NOTIF_PRIORITY_TO_RANK[_NOTIF_PRI_UNKNOWN])


def _notification_origin_order(actor_kind: Optional[str]) -> int:
    if actor_kind == "human":
        return 0
    if actor_kind == "ai":
        return 1
    return 2


def _notification_surface(n: dict) -> str:
    deeplink = n.get("deeplink") or {}
    kind = deeplink.get("kind")
    ident = deeplink.get("id")
    if kind and ident:
        return f"{kind}:{ident}"
    return (n.get("type") or n.get("event_name") or "notification").replace("_", "-")


def _wake_notification_manifest(cur, aid: str, delivered_ts: float,
                                *, limit: int = _WAKE_NOTIFICATION_MANIFEST_LIMIT) -> tuple[list[dict], bool]:
    """Rank pending agent_events with the #247 notification registry for wake routing.

    This is the wake/boot consumer of the KEYSTONE registry: it reads the same bus rows that
    drive pending_events, classifies them through _classify_notification, resolves origin +
    object priority, and returns a compact rank-ordered manifest for the notifier prompt.
    The prompt limit is applied AFTER ranking the full pending set; otherwise an older low-rank
    backlog can hide a newer interrupt/human request from the wake prompt.
    """
    cur.execute(
        """SELECT id, event_name, ts, payload
           FROM agent_events
           WHERE event_key = %s AND ts > %s AND event_name <> ALL(%s)
           ORDER BY ts ASC, id ASC""",
        (aid, delivered_ts, list(_NON_WAKING_EVENTS)),
    )
    raw = cur.fetchall()

    ids: set[str] = set()
    for r in raw:
        p = r["payload"] or {}
        for f in _NOTIF_ACTOR_FIELDS:
            if p.get(f):
                ids.add(str(p[f]))
    people: dict[str, dict] = {}
    if ids:
        cur.execute("SELECT id, alias, kind FROM agents WHERE id = ANY(%s)", (list(ids),))
        people = {str(a["id"]): a for a in cur.fetchall()}

    items = []
    task_ids: set[str] = set()
    request_ids: set[str] = set()
    for r in raw:
        p = r["payload"] or {}
        requester_is_human = False
        if r["event_name"] == "request_created":
            fa = str(p["from_agent_id"]) if p.get("from_agent_id") else None
            requester_is_human = bool(fa and (people.get(fa) or {}).get("kind") == "human")
        n = _classify_notification(r["event_name"], p, requester_is_human=requester_is_human)
        if n is None:
            continue

        actor = people.get(n["actor_ref"]) or {} if n["actor_ref"] else {}
        deeplink = n["deeplink"] or {}
        if deeplink.get("kind") == "task" and _valid_uuid(deeplink.get("id")):
            task_ids.add(deeplink["id"])
        if deeplink.get("kind") == "request" and _valid_uuid(deeplink.get("id")):
            request_ids.add(deeplink["id"])

        priority = n["priority"]
        item = {
            "event_name": r["event_name"],
            "type": n["type"], "zone": n["zone"],
            "priority": priority, "rank": _notification_rank(priority),
            "rank_label": _NOTIF_PRIORITY_TO_LABEL.get(priority, "unknown"),
            "actor_ref": n["actor_ref"], "actor_alias": actor.get("alias"),
            "actor_kind": actor.get("kind"), "deeplink": n["deeplink"],
            "preview": n["preview"], "ts": r["ts"], "object_priority": None,
            "is_task_request": n.get("is_task_request", False),  # #359: steer the wake prompt into the work
        }
        item["surface"] = _notification_surface(item)
        items.append(item)

    object_priorities: dict[tuple[str, str], int] = {}
    if task_ids:
        cur.execute("SELECT id, priority FROM tasks WHERE id = ANY(%s)", (list(task_ids),))
        object_priorities.update({("task", str(r["id"])): r["priority"] for r in cur.fetchall()})
    if request_ids:
        cur.execute("SELECT id, priority FROM requests WHERE id = ANY(%s)", (list(request_ids),))
        object_priorities.update({("request", str(r["id"])): r["priority"] for r in cur.fetchall()})

    for item in items:
        deeplink = item.get("deeplink") or {}
        key = (deeplink.get("kind"), deeplink.get("id"))
        item["object_priority"] = object_priorities.get(key)

    def _sort_key(item):
        object_priority = item["object_priority"] if item["object_priority"] is not None else 1_000_000
        return (
            item["rank"],
            object_priority,
            _notification_origin_order(item.get("actor_kind")),
            item["ts"],
        )

    items.sort(key=_sort_key)
    return items[:limit], len(items) > limit
# ISS-60(B): heartbeat-keyed orphan-lease reaper threshold. A single-flight lease whose agent
# hasn't shown a liveness heartbeat in this long is treated as ORPHANED and force-released — a
# TTL-independent backstop for a lease that outlives its embodiment (daemon restart /
# externally-spawned resident whose lease survives an in-memory live_residents reset, where the
# short TTL alone wouldn't recover ALL wakes). Floored ABOVE the notifier's 1200s watchdog
# hard-cap so a legitimately busy worker is never false-orphaned. SAFE only because wake-renew
# now bumps last_heartbeat_at on every keep-alive tick (the liveness ping) — so an alive-but-quiet
# resident/live session keeps a fresh heartbeat and is never reaped out from under itself.
ORPHAN_LEASE_SECS = 1260.0
# S3 §3b: the host-side live-terminal PTY bridge (`orcha terminal-bridge`) is a SEPARATE
# localhost websocket server, not a portal route (the portal container can't spawn `orcha use`).
# The frontend (terminal.js) discovers its URL here instead of assuming `location.host`. Default
# is the bridge's localhost bind; override with ORCHA_TERMINAL_WS_URL for a non-default port/host.
TERMINAL_WS_URL = os.environ.get("ORCHA_TERMINAL_WS_URL", "ws://127.0.0.1:8765")
MAX_DOD_LEN      = 4_000
MAX_FEEDBACK_LEN = 4_000
MAX_PROTOCOL_FIELD_LEN = 4_000   # SPEC-4: per-field cap on a task protocol string

# ISS-47: an answered request the requester never closed within a day is a dangling thread.
STALE_ANSWERED_SECS = 24 * 3600


def _annotate_request_ownership(rows, *, now=None):
    """ISS-47 — questions/decisions fragment across surfaces → dangling threads + ambiguous
    ownership. Stamp every request read-row with a CANONICAL next-action ownership so each
    surface (snapshot, container list, inbox, outbox) agrees on *who holds the ball* and
    *whether the thread is dangling*, instead of each consumer re-deriving it (the
    /orcha-inbox skill did this client-side). Added fields:

      owner_id        — agent who owns the next action: open→target, answered→requester, else None
      owner_alias     — that agent's alias, when the SQL resolved it (mixed all-request views do)
      pending_action  — 'answer' | 'close' | None
      is_stale        — dangling-thread signal: an OPEN request past its expiry, or an ANSWERED
                        request left unclosed past STALE_ANSWERED_SECS

    Mutates each row dict in place and returns the list. Tolerant of a row missing a column
    (computes only what the fields allow). No DB access, no state change — pure derive.
    """
    if now is None:
        now = datetime.now(timezone.utc)
    for r in rows:
        status = r.get("status")
        if status == "open":
            owner = r.get("target_id")
            pending = "answer"
        elif status == "answered":
            owner = r.get("requester_id")
            pending = "close"
        else:
            owner = None
            pending = None
        r["owner_id"] = str(owner) if owner else None
        r["pending_action"] = pending
        r.setdefault("owner_alias", None)  # mixed views resolve it in SQL; single-side views leave None
        stale = False
        if status == "open":
            exp = r.get("expires_at")
            if exp is not None and exp < now:
                stale = True
        elif status == "answered":
            rat = r.get("responded_at")
            if rat is not None and (now - rat).total_seconds() > STALE_ANSWERED_SECS:
                stale = True
        r["is_stale"] = stale
    return rows


# Epic B / P0: clear over-length errors instead of a silent 422.
# A body that exceeds a Field(max_length=...) cap (e.g. a long /api/tasks/{tid}/
# messages post) used to fall through to FastAPI's generic 422 with a deeply
# nested error blob the CLI/portal swallowed — the post just "vanished". We now
# intercept request-validation errors: if ANY of them is a max-length violation,
# return 413 Payload Too Large with a flat, machine-readable detail naming the
# field, the limit, and the actual length so the client can guide the user to
# split the text. Non-length validation errors keep the standard 422 shape.
@app.exception_handler(RequestValidationError)
async def _too_long_or_invalid(request: Request, exc: RequestValidationError):
    for err in exc.errors():
        # Pydantic v2 tags max_length breaches as 'string_too_long' and carries
        # the cap in ctx.max_length; the offending value is in err['input'].
        if err.get("type") == "string_too_long":
            field = err.get("loc", ["body", "?"])[-1]
            limit = (err.get("ctx") or {}).get("max_length")
            value = err.get("input")
            got = len(value) if isinstance(value, str) else None
            return JSONResponse(
                status_code=413,
                content={
                    "error": "body_too_long",
                    "field": str(field),
                    "limit": limit,
                    "got": got,
                    "detail": (
                        f"'{field}' is {got} characters but the limit is {limit}. "
                        "Split it into multiple posts/messages and try again."
                    ),
                },
            )
    # Not a length problem — preserve FastAPI's default 422 contract.
    return JSONResponse(status_code=422, content={"detail": exc.errors()})

# Note on agents.status enum: the schema lists 'blocked' as a possible value, but
# nothing in the API actually transitions an agent into it. 'blocked' is reserved
# for the Phase 4 case "this agent's only task is dep-blocked"; in the meantime
# 'awaiting_request' / 'awaiting_human' cover the outgoing-wait case, and
# recompute_agent_status() never emits 'blocked'. Documenting so a reader isn't
# surprised by an enum value that never appears.


# ---------- DB helpers ----------

@contextmanager
def db_cursor():
    with psycopg.connect(DB, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            yield conn, cur


# ---------- R1: incremental migration runner (Phase 0.5) ----------
# migrations/001_init.sql only runs via Postgres initdb on a FRESH volume, so there was
# no way to add a table to a live DB (the manual psql replays + wipe-on-reinit pain).
# This applies migrations/*.sql in lexical order, each in its own txn, idempotently
# (tracked in schema_migrations), so `orcha up` (which restarts the portal -> startup
# hook below) applies pending migrations to an EXISTING volume with NO wipe.
MIGRATIONS_DIR = pathlib.Path(os.environ.get("MIGRATIONS_DIR", "/app/migrations"))
_MIGRATION_LOCK_KEY = 4242421  # constant for pg_advisory_lock — serialize concurrent runs

# ---------- #301: task-message file attachments (local files, no DB blobs) ----------
# Bytes are written under a WRITABLE host bind-mount (per-task subdir); task_messages.attachments
# (mig 025) stores ONLY path/metadata refs. Tests override main.ATTACHMENTS_DIR directly.
ATTACHMENTS_DIR = pathlib.Path(os.environ.get("ORCHA_ATTACHMENTS_DIR", "/app/orcha-attachments"))
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024     # 10 MiB per file
MAX_ATTACHMENTS_PER_MESSAGE = 10
MAX_EXTRACTED_TEXT_CHARS = 8_000
# ext -> mime. ONLY these extensions are accepted on upload and served. SVG/HTML are deliberately
# absent: they can carry inline script, and we never want a served attachment to run in the portal
# origin (XSS). Raster images render inline; everything else downloads (see _ATTACHMENT_INLINE_EXT).
_ATTACHMENT_TYPES = {
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
    "gif": "image/gif", "webp": "image/webp",
    "pdf": "application/pdf", "txt": "text/plain; charset=utf-8",
    "md": "text/markdown; charset=utf-8", "csv": "text/csv; charset=utf-8",
    "log": "text/plain; charset=utf-8", "json": "application/json",
}
# Only raster images are served with Content-Disposition: inline (safe to render in-page). Every
# other allowed type (incl. text/pdf) is served as an attachment → the browser downloads it rather
# than rendering in the portal origin.
_ATTACHMENT_INLINE_EXT = {"png", "jpg", "jpeg", "gif", "webp"}
# A stored basename is "<32-hex>_<sanitized-name>"; the sanitized part is [A-Za-z0-9._-] only. This
# regex is the path-traversal gate on the serve route: no "/", no "..", nothing but safe chars.
_SAFE_STORED_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def _attachment_ext(name: str) -> Optional[str]:
    """Lowercased extension if it's in the allowlist, else None."""
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return ext if ext in _ATTACHMENT_TYPES else None


def _sanitize_attachment_name(name: str) -> str:
    """Reduce a client filename to a safe DISPLAY basename: strip any path, keep only
    [A-Za-z0-9._-] (others → '_'), bound length. Never trusted for the on-disk path —
    the stored name is uuid-prefixed and re-validated — this is just the shown label."""
    base = os.path.basename(name or "").strip() or "file"
    base = re.sub(r"[^A-Za-z0-9._-]", "_", base)
    base = base.lstrip(".") or "file"          # no leading dots (hidden / "..")
    return base[:120]


def _attachment_content_type(stored_name: str) -> str:
    ext = _attachment_ext(stored_name) or ""
    return _ATTACHMENT_TYPES.get(ext, "application/octet-stream")


def _attachment_kind(stored_name: str) -> str:
    ext = _attachment_ext(stored_name) or ""
    return "image" if ext in _ATTACHMENT_INLINE_EXT else "file"


def _attachment_text_cache_path(scope: str, owner_id: str, stored_name: str) -> Optional[pathlib.Path]:
    """Sidecar cache for upload-time OCR text.

    The cache lives OUTSIDE the served per-task/per-conversation directories so a metadata sidecar
    can never be fetched through /attachments/{stored_name} or accepted as a staged attachment ref.
    """
    if not stored_name or not _SAFE_STORED_NAME.match(stored_name):
        return None
    return ATTACHMENTS_DIR / ".extracted-text" / scope / owner_id / f"{stored_name}.json"


def _read_cached_attachment_text(scope: str, owner_id: str, stored_name: str) -> str:
    p = _attachment_text_cache_path(scope, owner_id, stored_name)
    if p is None:
        return ""
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return ""
    text = raw.get("text") if isinstance(raw, dict) else None
    return str(text or "").strip()[:MAX_EXTRACTED_TEXT_CHARS]


def _write_cached_attachment_text(scope: str, owner_id: str, stored_name: str, text: str) -> None:
    clean = (text or "").strip()[:MAX_EXTRACTED_TEXT_CHARS]
    if not clean:
        return
    p = _attachment_text_cache_path(scope, owner_id, stored_name)
    if p is None:
        return
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"text": clean}, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass


def _container_llm_key(cur, cid: str) -> Optional[str]:
    """Resolve the Orcha-managed LLM key for a container (env override > encrypted DB > None).
    Anthropic-scoped: vision/curation (the non-overridable use-cases that call this) always run
    on Anthropic. Provider-overridable use-cases resolve via _provider_api_key instead."""
    return _provider_api_key(cur, cid, "anthropic")


def _provider_stored_row(cur, cid: str, provider: str):
    """The stored-key row for one (container, provider), or None. ALL providers — Anthropic
    included — live in container_provider_keys (migration 027); the legacy
    containers.llm_api_key_enc columns are retired (backfilled by 027, no longer read)."""
    cur.execute(
        "SELECT key_enc, key_hint, set_at FROM container_provider_keys "
        "WHERE container_id=%s AND provider=%s",
        (cid, provider),
    )
    return cur.fetchone()


def _provider_api_key(cur, cid: str, provider: str) -> Optional[str]:
    """Resolve the usable plaintext key for (container, provider): env override
    (ORCHA_LLM_API_KEY) > stored+unsealed key for THIS provider > None. The provider-scoped
    sibling of _container_llm_key, for use-cases whose provider a human can override (#290 catalog)."""
    try:
        row = _provider_stored_row(cur, cid, provider)
        return secret_box.resolve_llm_key(row["key_enc"] if row else None)
    except Exception:
        return None


def _provider_key_enc(cur, cid: str, provider: str) -> Optional[str]:
    """Return the SEALED key blob (ciphertext) for (container, provider), or None — NEVER the
    plaintext. Safe to hand to the host daemon over the loopback wake-scan API: the blob alone is
    not a usable credential (the master key lives off-row in ORCHA_SECRET_KEY). The daemon, which
    shares ORCHA_SECRET_KEY on the same host, unseals it locally — so triage/ack can use a
    Settings-stored provider key without any plaintext crossing the wire."""
    try:
        row = _provider_stored_row(cur, cid, provider)
        return row["key_enc"] if row else None
    except Exception:
        return None


def _effective_use_case_provider(model_override: Optional[dict], use_case_key: str) -> str:
    """The provider a use-case actually runs on: the human's per-container override if set, else
    the #290 shipped default for that use-case. Drives which provider's stored key the daemon needs."""
    if isinstance(model_override, dict) and model_override.get("provider"):
        return model_override["provider"]
    try:
        import llm_util  # noqa: PLC0415 (dual-context import, see top of file)
    except ImportError:
        from orcha_cli import llm_util
    return llm_util.resolve_spec(use_case_key).provider


def _attachment_extracted_text(scope: str, owner_id: str, stored_name: str,
                               path: Optional[pathlib.Path], *, api_key: Optional[str] = None) -> str:
    """Return cached OCR text for an image/PDF ref, computing it once from disk when possible.

    FAIL-OPEN: missing key, unsupported media, read errors, provider errors, or cache write errors
    all return "" and leave the normal file URL path intact.
    """
    ctype = _attachment_content_type(stored_name)
    if not llm_util.can_describe(ctype):
        return ""
    cached = _read_cached_attachment_text(scope, owner_id, stored_name)
    if cached:
        return cached
    if api_key is None or path is None:
        return ""
    try:
        data = path.read_bytes()
    except OSError:
        return ""
    try:
        text = llm_util.describe_image(data, ctype, api_key=api_key)
    except Exception:
        return ""
    if text:
        _write_cached_attachment_text(scope, owner_id, stored_name, text)
        return text.strip()[:MAX_EXTRACTED_TEXT_CHARS]
    return ""


# --- scope-parametric core (#338) ------------------------------------------------------------
# #301/#330 introduced these for task-thread messages; #338 reuses the EXACT same logic for
# conversation turns. The core takes a base dir / url-prefix so a second scope (conversations)
# is a thin wrapper, not a copy — there is one path-traversal gate, one ref shape, one validator.
def _resolve_stored_in(base_dir: pathlib.Path, stored_name: str) -> Optional[pathlib.Path]:
    """Map (base_dir, stored basename) → an on-disk path, or None if it's unsafe / missing.
    Defends against path traversal: the name must match _SAFE_STORED_NAME (no '/', no '..')
    AND the resolved file's parent must be exactly base_dir."""
    if not stored_name or not _SAFE_STORED_NAME.match(stored_name):
        return None
    p = (base_dir / stored_name).resolve()
    try:
        if p.parent != base_dir.resolve() or not p.is_file():
            return None
    except OSError:
        return None
    return p


def _attachment_ref_for(url_prefix: str, stored_name: str, display_name: str, size: int,
                        *, extracted_text: str = "") -> dict:
    """Build the canonical ref stored in JSONB / returned to the client. content_type and kind
    are DERIVED server-side from the allowlisted extension — never trusted from input. url_prefix
    is the serve-route base for this scope (".../attachments"); the stored name is appended.
    Optional extracted_text is cached server-side OCR text for Codex/text-only delivery."""
    ref = {
        "id": stored_name,
        "name": display_name,
        "size": size,
        "content_type": _attachment_content_type(stored_name),
        "kind": _attachment_kind(stored_name),
        "url": f"{url_prefix}/{stored_name}",
    }
    text = (extracted_text or "").strip()[:MAX_EXTRACTED_TEXT_CHARS]
    if text:
        ref["extracted_text"] = text
    return ref


def _validate_refs_in(base_dir: pathlib.Path, ref_builder, refs: Optional[list],
                      *, api_key: Optional[str] = None) -> list[dict]:
    """Turn client-supplied attachment refs into canonical, disk-backed refs. Each input ref must
    name a stored file that ACTUALLY EXISTS under base_dir (i.e. was produced by a prior upload).
    Size/type are re-read from disk so the persisted JSONB can't be poisoned with fabricated
    metadata or foreign paths. `ref_builder(stored, display, size)` builds the scoped ref. Raises
    400 on any bad/missing ref."""
    if not refs:
        return []
    if len(refs) > MAX_ATTACHMENTS_PER_MESSAGE:
        raise HTTPException(400, f"too many attachments (max {MAX_ATTACHMENTS_PER_MESSAGE})")
    out: list[dict] = []
    for ref in refs:
        if not isinstance(ref, dict):
            raise HTTPException(400, "each attachment must be an object")
        stored = str(ref.get("id") or "")
        p = _resolve_stored_in(base_dir, stored)
        if p is None:
            raise HTTPException(400, f"attachment not found on disk: {stored!r} (upload it first)")
        display = _sanitize_attachment_name(str(ref.get("name") or stored))
        out.append(ref_builder(stored, display, p.stat().st_size, p, api_key=api_key))
    return out


# --- task-thread scope (#301/#330) — signatures unchanged; now delegate to the core -----------
def _task_attachments_dir(tid: str) -> pathlib.Path:
    return ATTACHMENTS_DIR / tid


def _resolve_stored_attachment(tid: str, stored_name: str) -> Optional[pathlib.Path]:
    return _resolve_stored_in(_task_attachments_dir(tid), stored_name)


def _attachment_ref(tid: str, stored_name: str, display_name: str, size: int,
                    path: Optional[pathlib.Path] = None, *, api_key: Optional[str] = None) -> dict:
    p = path or _resolve_stored_attachment(tid, stored_name)
    extracted = _attachment_extracted_text("tasks", tid, stored_name, p, api_key=api_key)
    return _attachment_ref_for(
        f"/api/tasks/{tid}/attachments", stored_name, display_name, size,
        extracted_text=extracted)


def _validate_attachment_refs(tid: str, refs: Optional[list],
                              *, api_key: Optional[str] = None) -> list[dict]:
    return _validate_refs_in(
        _task_attachments_dir(tid),
        lambda stored, display, size, path, *, api_key=None:
            _attachment_ref(tid, stored, display, size, path, api_key=api_key),
        refs, api_key=api_key)


# --- conversation scope (#338) — mirror of the task scope, conversation-scoped dir + url -------
def _conversation_attachments_dir(conv_id: str) -> pathlib.Path:
    # Nested under a "conversations/" prefix so a conversation id can never collide with a task
    # id's dir (tasks live directly under ATTACHMENTS_DIR/<tid>).
    return ATTACHMENTS_DIR / "conversations" / conv_id


def _resolve_stored_conv_attachment(conv_id: str, stored_name: str) -> Optional[pathlib.Path]:
    return _resolve_stored_in(_conversation_attachments_dir(conv_id), stored_name)


def _conv_attachment_ref(conv_id: str, stored_name: str, display_name: str, size: int,
                         path: Optional[pathlib.Path] = None,
                         *, api_key: Optional[str] = None) -> dict:
    p = path or _resolve_stored_conv_attachment(conv_id, stored_name)
    extracted = _attachment_extracted_text("conversations", conv_id, stored_name, p,
                                           api_key=api_key)
    return _attachment_ref_for(
        f"/api/conversations/{conv_id}/attachments", stored_name, display_name, size,
        extracted_text=extracted)


def _validate_conv_attachment_refs(conv_id: str, refs: Optional[list],
                                   *, api_key: Optional[str] = None) -> list[dict]:
    return _validate_refs_in(
        _conversation_attachments_dir(conv_id),
        lambda stored, display, size, path, *, api_key=None:
            _conv_attachment_ref(conv_id, stored, display, size, path, api_key=api_key),
        refs, api_key=api_key)


def _render_attachment_feed_line(attachments: Optional[list]) -> str:
    """#338 feed-to-agent (task-thread, server-side): a compact one-line addendum naming the files
    on a task-thread message + their serve-route paths, so the woken agent OPENS them rather than
    only seeing text. The portal doesn't know the agent's external API base, so it emits the
    RELATIVE serve path — the agent fetches it on the same Orcha API it reads the thread from. ""
    when there are no (valid) attachments. Mirrors conversation_prefix.render_attachment_feed."""
    atts = [a for a in (attachments or []) if isinstance(a, dict)]
    if not atts:
        return ""
    parts = []
    for a in atts:
        name = a.get("name") or a.get("id") or "file"
        kind = a.get("kind") or "file"
        url = a.get("url") or ""
        detail = f"{name} ({kind}; GET {url})"
        text = (a.get("extracted_text") or "").strip()
        if text:
            detail += f"; auto-transcribed text: {text[:MAX_EXTRACTED_TEXT_CHARS]}"
        parts.append(detail)
    return (f" — 📎 {len(atts)} attached file(s): " + "; ".join(parts)
            + " — fetch each via GET on your Orcha API (e.g. curl), then read/view it with your "
              "tools. Text-only runtimes should use any auto-transcribed text above for image/PDF "
              "content.")


def run_migrations(migrations_dir: Optional[pathlib.Path] = None) -> list[str]:
    """Apply pending migrations/*.sql in lexical order; return the versions applied this run.

    Idempotent: each version recorded in schema_migrations is skipped thereafter.
    001_init.sql is a BASELINE — if unrecorded but the schema already exists (the
    `containers` table is present: initdb ran 001 on a fresh volume, or this is a
    pre-runner live DB), it's recorded WITHOUT re-running. A whole run is serialized by a
    pg advisory lock. A failing migration rolls back and HALTS (later files are skipped).
    """
    mdir = migrations_dir or MIGRATIONS_DIR
    files = sorted(mdir.glob("*.sql")) if mdir.is_dir() else []
    applied: list[str] = []
    with psycopg.connect(DB) as conn:
        conn.execute("SELECT pg_advisory_lock(%s)", (_MIGRATION_LOCK_KEY,))
        try:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations "
                "(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
            )
            conn.commit()
            done = {r[0] for r in conn.execute("SELECT version FROM schema_migrations").fetchall()}
            core_exists = conn.execute(
                "SELECT to_regclass('public.containers')"
            ).fetchone()[0] is not None
            for f in files:
                version = f.name
                if version in done:
                    continue
                baseline = (version == "001_init.sql" and core_exists)
                try:
                    if not baseline:
                        conn.execute(f.read_text())  # multi-statement DDL, no params
                    conn.execute(
                        "INSERT INTO schema_migrations(version) VALUES (%s) ON CONFLICT DO NOTHING",
                        (version,),
                    )
                    conn.commit()
                except Exception as e:
                    conn.rollback()
                    raise RuntimeError(f"migration {version} failed (halting): {e}") from e
                applied.append(("baseline:" if baseline else "") + version)
        finally:
            conn.execute("SELECT pg_advisory_unlock(%s)", (_MIGRATION_LOCK_KEY,))
            conn.commit()
    return applied


def _startup_migrate() -> None:
    """R1.3: on portal boot, wait for the DB then apply pending migrations.

    `orcha up` restarts the portal, so this is what makes `orcha up` migrate an EXISTING
    volume with no wipe. A migration failure is logged loudly but does NOT crash the
    portal (it keeps serving the current schema); fix-forward and reboot.
    """
    for _ in range(20):
        try:
            with psycopg.connect(DB) as _c:
                _c.execute("SELECT 1")
            break
        except Exception:
            time.sleep(0.5)
    else:
        print("[migrate] DB not reachable at startup; skipping (will retry next boot)", flush=True)
        return
    try:
        applied = run_migrations()
        print(f"[migrate] applied: {applied}" if applied else "[migrate] schema up to date", flush=True)
    except Exception as e:
        # Review (Tim): HARD-FAIL by default — the running portal expects this migration's
        # schema, so serving a stale/half-migrated DB is worse than a loud boot failure
        # (raising aborts startup -> the container exits, surfacing the problem). Opt into
        # resilience with ORCHA_MIGRATE_ON_FAILURE=continue (log + serve current schema).
        if os.environ.get("ORCHA_MIGRATE_ON_FAILURE", "halt").lower() == "continue":
            print(f"[migrate] ERROR (ORCHA_MIGRATE_ON_FAILURE=continue — serving current schema): {e}",
                  flush=True)
            return
        print(f"[migrate] FATAL: {e} — aborting startup "
              "(set ORCHA_MIGRATE_ON_FAILURE=continue to serve anyway)", flush=True)
        raise


app.on_event("startup")(_startup_migrate)  # run pending migrations when the portal boots


@app.post("/api/admin/migrate", status_code=200)
def admin_migrate():
    """Apply pending migrations on demand (R1.3 — used by `orcha migrate`)."""
    try:
        applied = run_migrations()
    except Exception as e:
        raise HTTPException(500, f"migration failed: {e}")
    return {"applied": applied, "count": len(applied)}


def log_event(cur, container_id, actor_type, actor_id, entity_type, entity_id, event_type, detail=None):
    cur.execute(
        """INSERT INTO events
             (container_id, actor_type, actor_id, entity_type, entity_id, event_type, detail)
           VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)""",
        (container_id, actor_type, actor_id, entity_type, entity_id, event_type,
         json.dumps(detail) if detail is not None else None),
    )


def bump_agent(cur, agent_id):
    """Heartbeat + turn counter for an active agent."""
    cur.execute(
        "UPDATE agents SET last_heartbeat_at = now(), turns_used = turns_used + 1 "
        "WHERE id = %s",
        (agent_id,),
    )


def _touch_heartbeat(agent_id):
    """ISS-50: mark an agent alive NOW — heartbeat ONLY (never turns_used; a /wait poll is not a
    turn). Own short transaction so it can be called outside an existing cursor (e.g. right after
    a long-poll returns)."""
    with db_cursor() as (conn, cur):
        cur.execute("UPDATE agents SET last_heartbeat_at = now() WHERE id = %s", (agent_id,))
        conn.commit()


def set_agent_status(cur, agent_id, status):
    """Hard-set status. Most callers should use recompute_agent_status instead."""
    cur.execute("UPDATE agents SET status=%s WHERE id=%s", (status, agent_id))


def recompute_agent_status(cur, agent_id):
    """Derive agent status from current activity. Single source of truth.

    Priority order:
        terminated → keep (never auto-flip from terminated)
        awaiting_request → has at least one open OUTGOING request (waiting on an answer)
        working          → has at least one agent_tasks row with assignment_status
                           in (assigned, accepted, working) (active task)
        idle             → none of the above

    Call after every endpoint that changes agent_tasks or requests where this
    agent is the requester or target.
    """
    cur.execute("SELECT status FROM agents WHERE id=%s", (agent_id,))
    row = cur.fetchone()
    if not row:
        return
    if row["status"] == "terminated":
        return  # don't auto-revive

    # any open outgoing request?
    cur.execute(
        "SELECT 1 FROM requests WHERE requester_id=%s AND status='open' LIMIT 1",
        (agent_id,),
    )
    if cur.fetchone():
        new_status = "awaiting_request"
    else:
        cur.execute(
            "SELECT 1 FROM agent_tasks "
            "WHERE agent_id=%s AND assignment_status IN ('assigned','accepted','working') LIMIT 1",
            (agent_id,),
        )
        new_status = "working" if cur.fetchone() else "idle"

    cur.execute("UPDATE agents SET status=%s WHERE id=%s", (new_status, agent_id))


def _valid_uuid(s: str) -> bool:
    try:
        uuid.UUID(s)
        return True
    except (ValueError, TypeError):
        return False


def _require_container(cur, cid):
    cur.execute("SELECT id, status FROM containers WHERE id=%s", (cid,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"container {cid} not found")
    return row


def _require_agent(cur, aid):
    cur.execute("SELECT id, container_id, alias, turn_budget, turns_used FROM agents WHERE id=%s", (aid,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"agent {aid} not found")
    return row


def _reject_if_retired(cur, agent_id):
    """ISS-51: a retired (terminated_at set) agent is ineligible for work-creating /
    work-claiming actions. Applied to the agent-acting mutation paths so a retired agent
    can't claim `/next`, post to threads, create/answer requests, mark tasks done, etc.
    No-op for a missing/None actor (other guards handle existence) and for live agents."""
    if not agent_id or not _valid_uuid(agent_id):
        return
    cur.execute("SELECT terminated_at FROM agents WHERE id=%s", (agent_id,))
    row = cur.fetchone()
    if row and row["terminated_at"] is not None:
        raise HTTPException(409, "agent is retired and cannot perform this action")


def _require_task(cur, tid):
    cur.execute("SELECT id, container_id, title, status, is_root FROM tasks WHERE id=%s", (tid,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"task {tid} not found")
    return row


def _agent_participates_in_task(cur, cid, agent_id, tid) -> bool:
    """GH #56 (Point 3, FLAG 2b): the LOOSER participant check used to validate an
    agent-supplied originating_task_id. True iff `tid` is a real task in container `cid`
    that `agent_id` works on — owns/assignee/collaborator (any agent_tasks row) OR is the
    creator (tasks.created_by_agent_id). Deliberately NOT the strict exact-one-in-progress
    rule, so a valid tag from an agent juggling several tasks isn't rejected."""
    cur.execute(
        """SELECT 1 FROM tasks t
           WHERE t.id=%s AND t.container_id=%s
             AND (t.created_by_agent_id=%s
                  OR EXISTS (SELECT 1 FROM agent_tasks at
                             WHERE at.task_id=t.id AND at.agent_id=%s))
           LIMIT 1""",
        (tid, cid, agent_id, agent_id),
    )
    return cur.fetchone() is not None


def _resolve_alias(cur, cid, alias):
    cur.execute("SELECT id FROM agents WHERE container_id=%s AND alias=%s", (cid, alias))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"no agent aliased '{alias}' in container {cid}")
    return str(row["id"])


def _pick_human(cur, cid):
    """Orcha#30: pick the human agent to target for an escalation.

    Strategy: most-recently-active human in the container (last_heartbeat_at
    DESC, then created_at ASC as tiebreaker). If no human is registered we
    raise 409 — every container is expected to have at least one human after
    `orcha init`, but the API doesn't enforce that hard.
    """
    cur.execute(
        """SELECT id FROM agents
           WHERE container_id=%s AND kind='human' AND terminated_at IS NULL
           ORDER BY COALESCE(last_heartbeat_at, created_at) DESC,
                    created_at ASC
           LIMIT 1""",
        (cid,),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(
            409,
            "no human agent is registered in this container. Run `orcha init --as <name>` "
            "(if this is a fresh container) or `/orcha-register-human <name>` to add one.",
        )
    return str(row["id"])


def _require_kind(cur, agent_id, allowed):
    """Reject the action unless agent_id has kind in `allowed` (tuple).

    KNOWN LIMITATION (#271 spoof vector V2): this checks the kind of the NAMED agent, not that
    the caller actually IS that agent. There is no server-side caller auth — actor identity is
    100% body-supplied and agent UUIDs are public — so an AI that supplies a known human's UUID
    clears every `_require_kind(..., ("human",))` gate (verify/assign/protocol/retire/edit/decide,
    + the #24 pause gate). Closing this fully requires capability tokens (per-agent secret resolved
    from a header, not the body) — a cross-cutting design call, NOT this cooperative-hardening pass.
    #271 closes only the no-auth-needed holes (the NULL-author-as-human post spoof, V1)."""
    if not agent_id or not _valid_uuid(agent_id):
        raise HTTPException(400, "actor_agent_id is required and must be a valid UUID")
    cur.execute("SELECT kind FROM agents WHERE id=%s", (agent_id,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"agent {agent_id} not found")
    if row["kind"] not in allowed:
        raise HTTPException(
            403,
            f"this action requires kind in {allowed}; agent {agent_id} is kind='{row['kind']}'",
        )
    return row


def _require_container_active(cur, cid, actor_agent_id=None):
    """GH #24: enforce /orcha-pause + /orcha-stop. A paused ('paused') or stopped
    ('completed'/'cancelled'/'failed') container must reject mutating AGENT actions —
    pause/stop were settable but decorative (wakes are status-gated, but a warm/headless
    agent could still hit a mutating endpoint directly).

    Blocks ONLY when the actor resolves to a real kind='ai' agent. Allowed even when not
    active: reads (no guard added), kind='human' actors (the human stays authoritative —
    can resume/verify/cancel/close), and unattributed human free-text posts (author None).
    So dual-actor endpoints (close/cancel/convert) and human posts keep working while only
    the AI actor is blocked. Agents always send their real id, so this catches the real
    threat (an agent doing collaboration work on a paused/stopped container).

    Raises 409 (not 403) so it reads as a transient container-state condition, not an
    authorization failure — the same action succeeds once the container is resumed.
    """
    row = _require_container(cur, cid)
    status = row["status"]
    if status == "active":
        return row
    if actor_agent_id and _valid_uuid(actor_agent_id):
        cur.execute("SELECT kind FROM agents WHERE id=%s", (actor_agent_id,))
        arow = cur.fetchone()
        if arow and arow["kind"] == "ai":
            raise HTTPException(
                409,
                f"container is '{status}' — agent actions are blocked until it is resumed",
            )
    return row


# ---------- models ----------

class ContainerCreate(BaseModel):
    name: str = Field(..., max_length=MAX_NAME_LEN)
    description: Optional[str] = Field(default=None, max_length=MAX_DESC_LEN)


class ContainerCreateResponse(BaseModel):
    container_id: str
    root_task_id: str


class ContainerReset(BaseModel):
    # DESTRUCTIVE: human-gated + typed confirmation. `confirm` must equal the
    # container's current name so a reset can't fire from a stray/replayed call.
    actor_agent_id: str
    confirm: str


class ContainerStatusUpdate(BaseModel):
    status: str = Field(..., description="active|paused|completed|cancelled|failed")
    actor_agent_id: str = Field(..., description="UUID of the human agent performing the action (kind='human')")


class LlmKeyUpdate(BaseModel):
    """#294 Item 1: store a per-container Anthropic API key (PUT .../settings/llm-key).
    HUMAN-AUTHORITY gated + audit-logged — writing a credential is a human action, mirroring
    /status and /auto-wake (Orcha#30). The key is sealed by secret_box before it touches the
    DB; the plaintext is never persisted and never returned."""
    actor_agent_id: str = Field(..., description="UUID of the human agent performing the action (kind='human')")
    api_key: str = Field(..., min_length=1, max_length=512, description="the Anthropic API key (plaintext, sealed server-side)")


class LlmKeyActor(BaseModel):
    """Actor-only body for DELETE .../settings/llm-key (human-authority gated)."""
    actor_agent_id: str = Field(..., description="UUID of the human agent performing the action (kind='human')")


class LlmKeyTest(BaseModel):
    """#294 Item 1: server-side credential ping (POST .../settings/llm-key/test). HUMAN-AUTHORITY
    gated. `api_key` is OPTIONAL — supply a candidate to test BEFORE saving (the setup flow), or
    omit to test the currently-resolved key (env override > stored)."""
    actor_agent_id: str = Field(..., description="UUID of the human agent performing the action (kind='human')")
    api_key: Optional[str] = Field(default=None, max_length=512, description="candidate key to test; omit to test the stored/resolved key")


class ModelSettingOverride(BaseModel):
    """One per-use-case model override in a PUT .../settings/models body (SPEC-SETTINGS §3).
    `provider`+`model` both present = override that use-case; a use-case OMITTED from the body
    (or sent with both null) is reset to the shipped default. Validated against the #290 catalog
    server-side (llm_util.is_catalog_choice) so a stubbed provider / bogus model can't be stored."""
    key: str = Field(..., max_length=64, description="the registered use-case key (e.g. 'triage', 'onboarding')")
    provider: Optional[str] = Field(default=None, max_length=64, description="provider id from the catalog; null = reset")
    model: Optional[str] = Field(default=None, max_length=128, description="model id from the catalog; null = reset")


class ModelSettingsUpdate(BaseModel):
    """#294: replace the FULL set of per-container model overrides (SPEC-SETTINGS §2.2 — one PUT
    writes the full overridden set). HUMAN-AUTHORITY gated + audit-logged, like /settings/llm-key
    and /auto-wake — a model swap is a deliberate cost/quality decision. Any registered use-case
    NOT in `use_cases` is reset to its shipped default."""
    actor_agent_id: str = Field(..., description="UUID of the human agent performing the action (kind='human')")
    use_cases: list[ModelSettingOverride] = Field(default_factory=list, description="the full set of overrides to persist")


class ProposeDialogueTurn(BaseModel):
    """One turn in the SPEC-292 turn-based clarify loop."""
    role: Literal["assistant", "user"]
    content: str = Field(..., max_length=MAX_PAYLOAD_LEN)


class ProposeBody(BaseModel):
    """SPEC-292 request body for POST /api/onboarding/propose."""
    cid: str = Field(..., description="container id for the workspace being staffed")
    goal: str = Field(..., max_length=MAX_PAYLOAD_LEN)
    dialogue: list[ProposeDialogueTurn] = Field(default_factory=list)


class InitialTask(BaseModel):
    title: str = Field(..., max_length=MAX_NAME_LEN)
    description: Optional[str] = Field(default=None, max_length=MAX_DESC_LEN)
    definition_of_done: str = Field(..., max_length=MAX_DOD_LEN)
    priority: int = 100


class AgentCreate(BaseModel):
    alias: str = Field(..., max_length=64)
    role: str = Field(..., max_length=200)
    # Orcha#30: humans don't carry a prompt. Optional now; the API rejects
    # 'ai' kind without a prompt below.
    prompt: Optional[str] = Field(
        default=None,
        description="System prompt that defines this agent (required for kind='ai'; omit for 'human')",
        max_length=MAX_PROMPT_LEN,
    )
    kind: str = Field(default="ai", pattern="^(ai|human)$")
    # D7: the LLM model this agent runs on. Curated static set (no live list API);
    # the portal create-agent dropdown defaults to Opus 4.8. Defaulted server-side
    # for kind='ai' when omitted; left NULL for humans (no LLM).
    model: Optional[str] = Field(default=None, max_length=64)
    initial_task: Optional[InitialTask] = None


class AgentCreateResponse(BaseModel):
    agent_id: str
    alias: str
    container_id: str
    initial_task: Optional[dict] = None


class ProtocolFields(BaseModel):
    """SPEC-4: the per-task working agreement — four OPTIONAL free-text strings. `autonomy`
    is FREE TEXT for now (NOT an L1/L2/L3 enum; that waits on the SPEC-1 autonomy design-call).
    Used both as the create-time `protocol` block and (with actor_agent_id) as the PATCH body."""
    review_chain: Optional[str] = Field(default=None, max_length=MAX_PROTOCOL_FIELD_LEN)
    handoff_to: Optional[str] = Field(default=None, max_length=MAX_PROTOCOL_FIELD_LEN)
    autonomy: Optional[str] = Field(default=None, max_length=MAX_PROTOCOL_FIELD_LEN)
    notes: Optional[str] = Field(default=None, max_length=MAX_PROTOCOL_FIELD_LEN)


class ProtocolUpdate(ProtocolFields):
    """PATCH /api/tasks/{tid}/protocol body. PARTIAL update: only the keys explicitly sent are
    merged into the existing protocol (omitted keys are preserved). Actor: human or dispatching
    AI orchestrator (#327); editing `autonomy` stays human-only."""
    actor_agent_id: str = Field(..., description="UUID of the actor (human or dispatching AI); autonomy edits stay human-only (#327)")


class TaskCreateBody(BaseModel):
    title: str = Field(..., max_length=MAX_NAME_LEN)
    description: Optional[str] = Field(default=None, max_length=MAX_DESC_LEN)
    definition_of_done: str = Field(..., max_length=MAX_DOD_LEN)
    priority: int = 100
    created_by_agent_id: Optional[str] = None
    assignee_alias: Optional[str] = Field(default=None, max_length=64)
    depends_on: list[str] = Field(default_factory=list)
    # SPEC-4: optional per-task protocol set at create-time (Glass's New-Task form may include it).
    protocol: Optional[ProtocolFields] = None
    # #326 (B3): create the task HELD — status='not_ready' instead of ready/pending. A held task
    # is design-gated (awaiting a brainstorm / upstream decision) so it is EXCLUDED from the
    # ready-queue and NOT self-claimable via /orcha-next until a human flips it to ready
    # (POST /api/tasks/{tid}/readiness). Overrides the ready/pending default; an explicitly
    # ASSIGNED task is still claimed (in_progress) — you don't hold work you're handing to an agent.
    not_ready: bool = False


def _propose_sse(payload: dict) -> str:
    """House SSE frame format for SPEC-292's POST stream."""
    return f"data: {json.dumps(payload)}\n\n"


def _propose_error(code: str, message: str):
    """Terminal SPEC-292 error stream: exactly one error frame, then done."""
    ONBOARDING_LOG.warning("POST /api/onboarding/propose SSE error code=%s message=%s", code, message)
    yield _propose_sse({"event": "error", "code": code, "message": message})
    yield _propose_sse({"event": "done"})


_ASK_CLARIFY_TOOL = {
    "name": "ask_clarifying_questions",
    "description": "Ask one to three short questions only when they are needed before drafting the roster.",
    "input_schema": {
        "type": "object",
        "properties": {
            "questions": {
                "type": "array",
                "minItems": 1,
                "maxItems": 3,
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "prompt": {"type": "string"},
                    },
                    "required": ["id", "prompt"],
                },
            },
        },
        "required": ["questions"],
    },
}


def _propose_roster_tool_schema() -> dict:
    """The SPEC-292 propose_roster tool schema, kept close to the route that uses it."""
    protocol_schema = {
        "type": ["object", "null"],
        "properties": {
            "review_chain": {"type": "string"},
            "handoff_to": {"type": "string"},
            "autonomy": {"type": "string"},
            "notes": {"type": "string"},
        },
        "additionalProperties": False,
    }
    return {
        "name": "propose_roster",
        "description": "Return an editable Orcha roster proposal. Do not create anything.",
        "input_schema": {
            "type": "object",
            "properties": {
                "rationale": {"type": "string"},
                "agents": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "role": {"type": "string"},
                            "charter": {"type": "string"},
                            "model_hint": {"type": ["string", "null"], "enum": [*_MODEL_IDS, None]},
                        },
                        "required": ["name", "role", "charter"],
                    },
                },
                "tasks": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"},
                            "definition_of_done": {"type": "string"},
                            "assignee": {"type": ["string", "null"]},
                            "depends_on": {"type": "array", "items": {"type": "string"}},
                            "protocol": protocol_schema,
                            "is_kickoff": {"type": "boolean"},
                        },
                        "required": ["title", "definition_of_done", "assignee", "depends_on", "is_kickoff"],
                    },
                },
            },
            "required": ["rationale", "agents", "tasks"],
        },
    }


def _propose_system_prompt(*, force_roster: bool) -> str:
    clarify_rule = (
        "If the goal is too vague, call ask_clarifying_questions with 1-3 short questions. "
        "If the goal is workable, call propose_roster."
        if not force_roster else
        "Do not ask another clarifying question. Call propose_roster now using the available context."
    )
    return (
        "You draft editable Orcha workspace rosters from a human's project goal. "
        "The proposal is advisory: the human will edit and commit through existing Orcha forms. "
        f"{clarify_rule}\n"
        "For propose_roster: include a concise rationale, at least one agent, and at least one task. "
        "Agent names must be unique. A task assignee must be one of the proposed agent names or null. "
        "depends_on entries must reference earlier task titles only. "
        "Each assignee with tasks must have exactly one kickoff task. "
        "Charters must tell agents to use Orcha requests for teamwork and stop at needs_verification."
    )


def _propose_messages(body: ProposeBody) -> list[dict]:
    messages = [{"role": "user", "content": "Project goal:\n" + body.goal.strip()}]
    for turn in body.dialogue:
        content = turn.content.strip()
        if content:
            messages.append({"role": turn.role, "content": content})
    return messages


def _propose_should_force_roster(body: ProposeBody) -> bool:
    user_text = "\n".join(t.content.lower() for t in body.dialogue if t.role == "user")
    if "skip clarifying" in user_text or "just propose" in user_text:
        return True
    # The UI appends one assistant turn per question; cap total questions at three.
    return sum(1 for t in body.dialogue if t.role == "assistant") >= 3


def _propose_roster_was_truncated(force_roster: bool, diag: dict) -> bool:
    if diag.get("stop_reason") == "max_tokens":
        return True
    # A forced tool call with started-but-incomplete or invalid JSON input is the
    # Anthropic streaming shape for an output-budget cut-off. Treat it as such
    # even if a provider/proxy omits stop_reason.
    return bool(force_roster and diag.get("started") and (
        not diag.get("completed") or diag.get("json_error")))


def _clean_protocol(raw: Any) -> Optional[dict]:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("protocol must be an object or null")
    cleaned = ProtocolFields(**{k: raw.get(k) for k in ("review_chain", "handoff_to", "autonomy", "notes")})
    data = cleaned.model_dump(exclude_none=True)
    return data or None


def _build_report_back(rid: str, dod: str) -> str:
    """GH #56 (Point 4.4/4.5): the report-back instruction for a request-born task. It is
    injected into the spawned task's protocol.notes AND echoed in the accept response so the
    same worker session sees it immediately. Derived purely from (rid, dod) so the fresh
    accept and the idempotent retry (first response lost) return the IDENTICAL instruction —
    a retry must never fall back to the old, instruction-less response shape (review P-retry)."""
    text = (
        f"REPORT BACK: when you've materially finished this task — i.e. "
        f"{dod.strip() or 'the requested work is complete'} — post your result to request {rid} "
        f"(/orcha-respond {rid} \"...\") BEFORE moving on. Reporting back is a separate, "
        f"agent-judged step: it is NOT /orcha-done (which only sends this task to human "
        f"verification, and may still be pending after you report back)."
    )
    return text[:MAX_PROTOCOL_FIELD_LEN]


def _normalize_roster_payload(raw: Any) -> dict:
    """Validate and repair the model's propose_roster payload into the exact UI-safe shape."""
    if not isinstance(raw, dict):
        raise ValueError("propose_roster payload must be an object")
    agents = []
    seen_names: set[str] = set()
    for item in raw.get("agents") or []:
        if not isinstance(item, dict):
            raise ValueError("agents must be objects")
        name = str(item.get("name") or "").strip()
        role = str(item.get("role") or "").strip()
        charter = str(item.get("charter") or "").strip()
        if not name or not role or not charter:
            raise ValueError("agent name, role, and charter are required")
        if name in seen_names:
            raise ValueError(f"duplicate agent name '{name}'")
        seen_names.add(name)
        hint = item.get("model_hint")
        agents.append({
            "name": name,
            "role": role[:200],
            "charter": charter[:MAX_PROMPT_LEN],
            "model_hint": hint if hint in _MODEL_IDS else None,
        })
    if not agents:
        raise ValueError("at least one agent is required")

    tasks = []
    seen_titles: set[str] = set()
    kickoff_by_assignee: dict[str, list[int]] = {}
    tasks_by_assignee: dict[str, list[int]] = {}
    for item in raw.get("tasks") or []:
        if not isinstance(item, dict):
            raise ValueError("tasks must be objects")
        title = str(item.get("title") or "").strip()
        dod = str(item.get("definition_of_done") or "").strip()
        if not title or not dod:
            raise ValueError("task title and definition_of_done are required")
        assignee = item.get("assignee")
        assignee = str(assignee).strip() if assignee is not None and str(assignee).strip() else None
        if assignee is not None and assignee not in seen_names:
            raise ValueError(f"task assignee '{assignee}' is not a proposed agent")
        deps = []
        for dep in item.get("depends_on") or []:
            dep_title = str(dep or "").strip()
            if dep_title in seen_titles:
                deps.append(dep_title)
        is_kickoff = bool(item.get("is_kickoff"))
        if is_kickoff and not assignee:
            is_kickoff = False
        if assignee:
            tasks_by_assignee.setdefault(assignee, []).append(len(tasks))
            if is_kickoff:
                kickoff_by_assignee.setdefault(assignee, []).append(len(tasks))
        tasks.append({
            "title": title[:MAX_NAME_LEN],
            "definition_of_done": dod[:MAX_DOD_LEN],
            "assignee": assignee,
            "depends_on": deps,
            "protocol": _clean_protocol(item.get("protocol")),
            "is_kickoff": is_kickoff,
        })
        seen_titles.add(title)
    if not tasks:
        raise ValueError("at least one task is required")
    for assignee, indexes in tasks_by_assignee.items():
        kickoffs = kickoff_by_assignee.get(assignee, [])
        if not kickoffs:
            tasks[indexes[0]]["is_kickoff"] = True
        elif len(kickoffs) > 1:
            for idx in kickoffs[1:]:
                tasks[idx]["is_kickoff"] = False

    return {
        "rationale": str(raw.get("rationale") or "").strip(),
        "agents": agents,
        "tasks": tasks,
    }


class TaskMessage(BaseModel):
    author_agent_id: Optional[str] = None
    body: str = Field(..., max_length=MAX_PAYLOAD_LEN)
    # #301: optional attachment refs the client staged via POST .../attachments (uploaded
    # FIRST, then referenced here by stored `id`). Each is re-validated against disk on post
    # (see _validate_attachment_refs) — the client cannot poison the JSONB with arbitrary
    # paths/sizes. Each item: {"id": "<stored basename>", "name": "<display name>"}.
    attachments: Optional[list[dict]] = None


class TaskDone(BaseModel):
    agent_id: str
    result: str = Field(..., max_length=MAX_PAYLOAD_LEN)


class AssignTask(BaseModel):
    actor_agent_id: str = Field(..., description="the actor (human or dispatching AI orchestrator) — Orcha#30 + #327")
    agent_id: str = Field(..., description="the AI agent to assign this task to")
    reassign: bool = Field(default=False,
                           description="if the task already has a DIFFERENT active assignee, release them and reassign (else 409)")


class TaskReadiness(BaseModel):
    """#326 (B3): POST /api/tasks/{tid}/readiness — flip a task between 'not_ready' (held) and
    'ready' (dispatchable). HUMAN-AUTHORITY gated (#327: AI cannot yet flip readiness). Holding
    parks a ready/pending row as 'not_ready' so it leaves the ready-queue and can't be claimed via
    /orcha-next; releasing returns it to 'ready' (or 'pending' if its deps aren't satisfied)."""
    actor_agent_id: str = Field(..., description="UUID of the human (kind='human') flipping readiness")
    ready: bool = Field(..., description="true = release to ready (or pending if deps unmet); false = hold as not_ready")


class TaskUnassign(BaseModel):
    """#326 (B2): POST /api/tasks/{tid}/unassign — clear the active assignee(s) so the row returns
    to the ready queue (owner==null). HUMAN-AUTHORITY gated (Orcha#30 — a deliberate dispatch reset,
    pairs with #327 AI-can't-assign). Mirrors the release half of the /assign reassign branch."""
    actor_agent_id: str = Field(..., description="UUID of the human (kind='human') clearing the assignee")


class TaskVerify(BaseModel):
    approve: bool
    feedback: Optional[str] = Field(default=None, max_length=MAX_FEEDBACK_LEN)
    actor_agent_id: str = Field(..., description="UUID of the human agent verifying (kind='human')")


class TaskCancel(BaseModel):
    """B7 (ISS-23) + #327: force-close a task. A human OR a dispatching AI orchestrator may cancel
    ANY non-root task. reason is required when the actor cancels a task assigned to someone else
    (routed to the displaced owner via the B0 decision primitive)."""
    actor_agent_id: str = Field(..., description="UUID of the actor (human or AI orchestrator may cancel any non-root task)")
    reason: Optional[str] = Field(default=None, max_length=MAX_FEEDBACK_LEN)


class AgentRetire(BaseModel):
    """ISS-51: retire an agent. Human-authority gated (actor must be kind='human')."""
    actor_agent_id: str


class AgentModelUpdate(BaseModel):
    """B8.1: change the LLM model an agent runs on. Must be one of the curated ids
    (AVAILABLE_MODELS); new providers are added there as supported."""
    model: str = Field(..., max_length=64)


class AgentUpdate(BaseModel):
    """Agent-update: edit an agent's role / system_prompt / alias (onboarding +
    re-profiles). Human-authority gated. All fields optional except the actor — a
    PARTIAL update: omit a field to leave it unchanged."""
    actor_agent_id: str
    role: Optional[str] = Field(default=None, max_length=MAX_NAME_LEN)
    system_prompt: Optional[str] = Field(default=None, max_length=MAX_PROMPT_LEN)
    alias: Optional[str] = Field(default=None, max_length=64)


class AutoWakeUpdate(BaseModel):
    """#266: set/clear an agent's clock-driven AUTO-WAKE cadence. HUMAN-AUTHORITY gated.
    `interval_secs` is REQUIRED but NULLABLE — send an int (>=60s floor) to enable a recurring
    heartbeat wake, or null to DISABLE (opt-out). Unlike a partial PATCH (where an omitted field
    means 'unchanged'), the value is always explicit here, so null unambiguously means 'disable'
    rather than 'don't touch'. The 60s floor + nullability are also enforced by the DB CHECK."""
    actor_agent_id: str
    interval_secs: Optional[int] = Field(
        ..., ge=60,
        description="seconds between clock-driven auto-wakes (>=60s floor); null disables auto-wake")


# ---- E3 conversation store (resident-session thread; docs/orcha-conversation-model.md) ----
class ConversationStart(BaseModel):
    """A human opens (or re-opens) the conversation with an AI agent."""
    actor_agent_id: str


class TurnAppend(BaseModel):
    """Append one turn. Human turn = the human's message; agent turn = ONE per stream-json
    'result' event (E2 findings), linked to its worker_run via run_id (the live token
    stream lives in worker_run_lines/ISS-39, not here)."""
    role: str = Field(..., pattern="^(human|agent)$")
    author_agent_id: str
    content: str = Field(..., max_length=MAX_TURN_LEN)
    run_id: Optional[str] = None
    meta: Optional[dict] = None
    # #338: staged attachment refs (each {"id": <stored basename>, ...}), validated against this
    # conversation's on-disk store before persist — mirrors TaskMessage.attachments (#330). Typed
    # as an object-array (list[dict]) so the OpenAPI schema matches the route's runtime contract
    # (_validate_attachment_refs requires each item be an object, main.py:846).
    attachments: Optional[list[dict]] = None


class ConversationSession(BaseModel):
    """Record the claude --session-id so the resident can pin/resume the same session."""
    session_id: str


class ConversationActor(BaseModel):
    actor_agent_id: str


class ReachabilityUpsert(BaseModel):
    """Epic A: how the notifier daemon can reach this agent's Claude session to wake it.

    Recorded at /orcha-register-agent and refreshed at SessionStart (the tmux pane
    changes every session). Partial upsert — only the fields supplied are written,
    so SessionStart can refresh tmux_target without clobbering a wake_enabled=false
    opt-out the human set earlier.
    """
    tmux_target: Optional[str] = Field(default=None, max_length=MAX_NAME_LEN,
                                       description='"session:window.pane" for live send-keys wakes')
    headless_cwd: Optional[str] = Field(default=None, max_length=MAX_DESC_LEN,
                                        description="project dir for out-of-band `claude -p` wakes")
    headless_flags: Optional[str] = Field(default=None, max_length=MAX_DESC_LEN)
    wake_enabled: Optional[bool] = Field(default=None,
                                         description="ON by default; set false to opt out of wakes")
class DigestSnapshot(BaseModel):
    """Epic C / D3: one per-agent memory digest the agent composes + POSTs.

    The server never synthesises these (reasoning isn't derivable from rows); it
    only stores what the agent sends. current_focus is a one-liner; the three
    lists are free-form [{text, ...}] objects (or bare strings, normalised on
    write). See docs/epic-c-agent-digest-plan.md for the ownership boundary.
    """
    current_focus: Optional[str] = Field(default=None, max_length=MAX_PAYLOAD_LEN)
    decisions: list = Field(default_factory=list)
    learnings: list = Field(default_factory=list)
    open_threads: list = Field(default_factory=list)
    # #325: the plain-language conversational register — who the agent is talking to,
    # their vocabulary, what they already understand. Free text, like current_focus.
    # Carried across wakes so tone survives (the facts above never captured HOW to talk
    # to a human, so each wake the agent reverted to internal jargon). Optional/additive.
    audience: Optional[str] = Field(default=None, max_length=MAX_PAYLOAD_LEN)


class DecisionCreate(BaseModel):
    """B0 / G1: the one shape every human-decision surface speaks.

    A decision is `approve` or `reject` plus a free-text `reason` (REQUIRED on
    reject, optional on approve). subject_type/subject_id name what's being decided
    (a task verify, a request, a checkpoint, a dummy demo) so a single endpoint
    serves every surface. The decision + reason are persisted (auditable) and an
    event is routed to target_agent_id so the agent sees *why* on its next wake.
    """
    subject_type: str = Field(..., max_length=MAX_NAME_LEN,
                              description="what's being decided, e.g. 'task_verify'|'request'|'checkpoint'|'dummy'")
    subject_id: str = Field(..., max_length=MAX_NAME_LEN,
                            description="id of the thing being decided (task/request/etc)")
    decision: Literal["approve", "reject"]
    reason: Optional[str] = Field(default=None, max_length=MAX_FEEDBACK_LEN,
                                  description="REQUIRED on reject, optional on approve")
    actor_agent_id: str = Field(..., description="UUID of the deciding human (kind='human')")
    target_agent_id: Optional[str] = Field(
        default=None, description="agent that consumes {decision,reason} on next wake (omit if none)")


# ---------- containers ----------

@app.post("/api/containers", response_model=ContainerCreateResponse, status_code=201)
def create_container(body: ContainerCreate):
    """Orcha#28: stack:db:container is 1:1:1. A stack holds AT MOST one container.

    Returns 409 if one already exists in this DB. To reset, run `orcha down -v &&
    orcha init` (wipes the volume).
    """
    with db_cursor() as (conn, cur):
        cur.execute("SELECT id, name, status FROM containers LIMIT 1")
        existing = cur.fetchone()
        if existing:
            raise HTTPException(
                409,
                f"this stack already has a container ({existing['id']}, "
                f"name='{existing['name']}', status='{existing['status']}'). "
                f"Stack:db:container is 1:1:1 — to start a new container, "
                f"run `orcha down -v && orcha init` to wipe the volume first."
            )
        cur.execute(
            "INSERT INTO containers (name, description) VALUES (%s, %s) RETURNING id",
            (body.name, body.description),
        )
        cid = str(cur.fetchone()["id"])
        cur.execute(
            """INSERT INTO tasks
                 (container_id, title, description, definition_of_done,
                  status, priority, is_root)
               VALUES (%s, %s, %s, %s, 'ready', 0, true)
               RETURNING id""",
            (cid, body.name, body.description or body.name,
             "Container objective met: all child tasks completed and verified."),
        )
        root_id = str(cur.fetchone()["id"])
        cur.execute("UPDATE containers SET root_task_id=%s WHERE id=%s", (root_id, cid))
        log_event(cur, cid, "human", None, "container", cid, "created",
                  {"name": body.name, "root_task_id": root_id})
        log_event(cur, cid, "human", None, "task", root_id, "created",
                  {"title": body.name, "is_root": True})
        conn.commit()
    return ContainerCreateResponse(container_id=cid, root_task_id=root_id)


@app.post("/api/containers/{cid}/reset", status_code=200)
def reset_container(cid: str, body: ContainerReset):
    """Wipe ALL data in this (1:1:1) container — agents, tasks, requests, decisions,
    conversations, worker runs, memory digests, events — and recreate a single empty
    root task. The `containers` row itself is KEPT (so `current_container_id` and the
    portal stay valid); only its contents are cleared.

    In-app counterpart to the CLI `orcha init --force --reset-data` (which instead drops
    the Postgres volume for a pristine initdb). DESTRUCTIVE, so doubly gated:
      * human actor (kind='human'), and
      * typed confirmation — `confirm` must equal the container's current name.
    Returns per-table deleted-row counts.

    NB: every container-scoped table must be listed below; a NEW such table added to the
    schema must be added here too, or reset will leave orphan rows.
    """
    if not _valid_uuid(cid):
        raise HTTPException(404, "container not found")
    with db_cursor() as (conn, cur):
        cur.execute("SELECT id, name FROM containers WHERE id=%s", (cid,))
        cont = cur.fetchone()
        if not cont:
            raise HTTPException(404, "container not found")
        _require_kind(cur, body.actor_agent_id, ("human",))
        if body.confirm != cont["name"]:
            raise HTTPException(
                400,
                "reset not confirmed: `confirm` must equal the container name "
                f"'{cont['name']}'.",
            )

        deleted: dict = {}

        def _run(table, sql, params):
            cur.execute(sql, params)
            deleted[table] = cur.rowcount

        # Break the containers→tasks circular ref before deleting tasks.
        cur.execute("UPDATE containers SET root_task_id=NULL WHERE id=%s", (cid,))

        # Delete children → parents. worker_run_lines / conversation_turns would cascade
        # from their parents, but we delete them explicitly so the counts are complete.
        agents_of = "SELECT id FROM agents WHERE container_id=%s"
        tasks_of = "SELECT id FROM tasks WHERE container_id=%s"
        _run("worker_run_lines",
             f"DELETE FROM worker_run_lines WHERE run_id IN "
             f"(SELECT run_id FROM worker_runs WHERE agent_id IN ({agents_of}))", (cid,))
        _run("conversation_turns",
             "DELETE FROM conversation_turns WHERE conversation_id IN "
             "(SELECT id FROM conversations WHERE container_id=%s)", (cid,))
        _run("conversations", "DELETE FROM conversations WHERE container_id=%s", (cid,))
        _run("worker_runs",
             f"DELETE FROM worker_runs WHERE agent_id IN ({agents_of})", (cid,))
        _run("decisions", "DELETE FROM decisions WHERE container_id=%s", (cid,))
        _run("agent_memory_digests",
             "DELETE FROM agent_memory_digests WHERE container_id=%s", (cid,))
        _run("requests", "DELETE FROM requests WHERE container_id=%s", (cid,))
        _run("task_messages",
             f"DELETE FROM task_messages WHERE task_id IN ({tasks_of})", (cid,))
        _run("task_dependencies",
             f"DELETE FROM task_dependencies WHERE task_id IN ({tasks_of})", (cid,))
        _run("agent_tasks",
             f"DELETE FROM agent_tasks WHERE task_id IN ({tasks_of})", (cid,))
        _run("agent_reachability",
             f"DELETE FROM agent_reachability WHERE agent_id IN ({agents_of})", (cid,))
        _run("agent_wake_state",
             f"DELETE FROM agent_wake_state WHERE agent_id IN ({agents_of})", (cid,))
        _run("agent_events",
             f"DELETE FROM agent_events WHERE container_id=%s OR target_id IN ({agents_of})",
             (cid, cid))
        _run("events", "DELETE FROM events WHERE container_id=%s", (cid,))
        _run("tasks", "DELETE FROM tasks WHERE container_id=%s", (cid,))
        _run("agents", "DELETE FROM agents WHERE container_id=%s", (cid,))

        # Recreate a single empty root task (mirror create_container).
        cur.execute(
            """INSERT INTO tasks
                 (container_id, title, description, definition_of_done,
                  status, priority, is_root)
               VALUES (%s, %s, %s, %s, 'ready', 0, true)
               RETURNING id""",
            (cid, cont["name"], cont["name"],
             "Container objective met: all child tasks completed and verified."),
        )
        root_id = str(cur.fetchone()["id"])
        cur.execute("UPDATE containers SET root_task_id=%s WHERE id=%s", (root_id, cid))
        # actor_id has no FK (the actor agent was just deleted) — safe to record.
        log_event(cur, cid, "human", body.actor_agent_id, "container", cid, "reset",
                  {"deleted": deleted, "new_root_task_id": root_id})
        conn.commit()
    return {"container_id": cid, "root_task_id": root_id, "deleted": deleted}


@app.get("/api/containers")
def list_containers():
    """Orcha#28: list this stack's container(s).

    Stack:db:container is 1:1:1 by design, so this returns either zero rows
    (stack is empty, run `orcha init`) or exactly one row. The list shape is
    kept for the portal / `orcha ls` clients that already consume it.
    """
    with db_cursor() as (_, cur):
        cur.execute(
            """SELECT id, name, description, status, root_task_id,
                      created_at, completed_at
               FROM containers
               ORDER BY created_at DESC""",
        )
        return {"containers": cur.fetchall()}


@app.get("/api/terminal/config")
def terminal_config():
    """S3 §3b: where the embedded-terminal frontend (terminal.js) opens its websocket. The PTY
    bridge is a SEPARATE host-side server (not a portal route), so the browser connects directly
    to `ws_url` + `/api/agents/<aid>/terminal?actor_agent_id=<human>`. Localhost/trusted-local."""
    return {"ws_url": TERMINAL_WS_URL}


@app.get("/api/containers/{cid}")
def get_container(cid: str, task_limit: int = 1000, request_limit: int = 1000):
    """The portal's 5s poll. ISS-68 (#167): the snapshot no longer ships each task's full
    message THREAD (~277KB re-sent every poll) — tasks carry a compact `message_summary`
    {count,last} + `plan_message` (the approval card renders the plan thread-free), and the
    full thread is lazy-fetched on expand via GET /api/tasks/{tid}/messages. Tasks/requests
    are priority-ordered and capped at task_limit/request_limit (the portal passes the count
    it has loaded so the poll refreshes that window; `task_total`/`request_total` gate
    'load more'). Defaults are generous so non-portal callers still get the full set."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    task_limit = max(1, min(task_limit, 1000))
    request_limit = max(1, min(request_limit, 1000))
    with db_cursor() as (_, cur):
        cur.execute(
            """SELECT id, name, description, status, root_task_id,
                      max_auto_agents, max_tasks, execution_mode, wakes_enabled,
                      autonomy_level,
                      created_at, completed_at
               FROM containers WHERE id=%s""", (cid,))
        c = cur.fetchone()
        if not c:
            raise HTTPException(404, f"container {cid} not found")

        # Item 6 (review): single-pass aggregation instead of correlated subquery per agent.
        # D7: additionally surface model (D7), wake_enabled (reachability join),
        # current_task (the actively-worked task) and last_active (latest of heartbeat /
        # worker-run start) so the redesign can render agent cards without extra calls.
        cur.execute(
            """SELECT a.id, a.alias, a.role, a.kind, a.turns_used, a.turn_budget,
                      a.last_heartbeat_at, a.is_auto_created, a.created_at, a.terminated_at,
                      a.model,
                      -- #266: the configured clock-driven auto-wake cadence (NULL = off) so the
                      -- portal can render/edit it on the agent card without a second call.
                      a.auto_wake_interval_secs,
                      -- A short glanceable prompt preview for the agent view; the FULL
                      -- system_prompt stays on GET /api/agents/{aid}/persona (lazy-loaded
                      -- on expand) so we don't ride 8KB x N prompts on every roster poll.
                      LEFT(a.system_prompt, 160) AS prompt_preview,
                      COALESCE(r.wake_enabled, true) AS wake_enabled,
                      GREATEST(
                          a.last_heartbeat_at,
                          (SELECT max(wr.started_at) FROM worker_runs wr WHERE wr.agent_id = a.id)
                      ) AS last_active,
                      (SELECT json_build_object('task_id', t2.id, 'title', t2.title)
                         FROM agent_tasks at2 JOIN tasks t2 ON t2.id = at2.task_id
                        WHERE at2.agent_id = a.id AND at2.assignment_status = 'working'
                        ORDER BY at2.assigned_at DESC LIMIT 1) AS current_task,
                      -- #340 regression fix (scope sharpened, Kedar live-test 2026-06-15):
                      -- the activity label must reflect the agent's LIVE run, NOT the persistent
                      -- task-claim. current_task (above) is an agent_tasks 'working' row, cleared
                      -- only on /orcha-done — it DIVERGES from live reality: an agent woken as a
                      -- conversation-turn / inbox-drain worker run (worker_runs.task_id NULL,
                      -- creating NO 'working' row — commits 6c40247/5995982) read IDLE even mid-run,
                      -- AND an agent carrying a STALE 'working' row (wrong-agent auto-claim bug)
                      -- showed that stale task while its live run was actually a checkpoint/request.
                      -- Surface the agent's live worker_run so the frontend can drive the label off
                      -- it (and fall back to current_task ONLY when no run is live). GATED on a LIVE
                      -- lease (the same predicate as `embodiment`/`status` below) so a STALE 'running'
                      -- orphan whose lease has already expired does NOT show a perpetual-busy label —
                      -- it correctly reads idle, consistent with the live-recomputed `status`. When
                      -- the live run IS a task, task_id + task_title are carried so the card shows the
                      -- worked task directly (no dependence on current_task matching).
                      (SELECT json_build_object(
                                  'run_id', wr.run_id,
                                  'wake_event', wr.wake_event,
                                  'wake_kind', wr.wake_kind,
                                  'runtime', wr.runtime,
                                  'task_id', wr.task_id,
                                  'task_title', t3.title,
                                  'has_conversation', wr.conversation_id IS NOT NULL,
                                  'started_at', wr.started_at)
                         FROM worker_runs wr
                         LEFT JOIN tasks t3 ON t3.id = wr.task_id
                        WHERE wr.agent_id = a.id AND wr.status = 'running'
                          AND ws.wake_lease_until IS NOT NULL AND ws.wake_lease_until > now()
                        ORDER BY wr.started_at DESC LIMIT 1) AS active_run,
                      -- §3b: the agent's current EMBODIMENT (the live single-flight lease kind, else
                      -- 'idle') so the portal can render the live-session indicator + lock/guard the
                      -- conversation panel and the 'Open terminal' action. idle|ephemeral|resident|live.
                      CASE WHEN ws.wake_lease_until IS NOT NULL AND ws.wake_lease_until > now()
                           THEN ws.lease_kind ELSE 'idle' END AS embodiment,
                      -- ISS-16/#89: LIVENESS-derived status, emitted UNDER `status` (the stored
                      -- agents.status column is left untouched as internal truth — internal callers
                      -- unaffected). The stored value flips to 'working' on task assignment
                      -- (recompute_agent_status, ownership-only) and recomputes ONLY at mutation
                      -- points, so it STICKS at 'working' long after the worker exits (Dock/Page
                      -- sticky-'Working' bug). Here we recompute it LIVE at query time — mirroring
                      -- recompute_agent_status's exact priority but GATING 'working' on a live
                      -- single-flight lease, so an owned-but-not-embodied task reads 'idle':
                      --   terminated       -> never auto-flip (defensive; terminated rows are filtered
                      --                       out by the WHERE below, kept for parity with recompute)
                      --   awaiting_request -> has >=1 open OUTGOING request (the `w` join below) —
                      --                       ABOVE working, matching recompute_agent_status priority
                      --   working          -> owns an active task (assigned/accepted/working) AND has
                      --                       a LIVE lease now (same predicate as `embodiment` above)
                      --   idle             -> none of the above (incl. a live lease with no task, OR
                      --                       an owned task with no live embodiment — the sticky-fix)
                      -- All four are existing stored-enum values recompute_agent_status already emits
                      -- and the frontend already styles — no new badge string, no migration, no
                      -- frontend change. Endpoint has no response_model -> untyped dict -> no OpenAPI
                      -- drift (the `status` field's documented type is unchanged: still a string).
                      CASE
                          WHEN a.status = 'terminated' THEN 'terminated'
                          WHEN w.waiting_on IS NOT NULL THEN 'awaiting_request'
                          WHEN ws.wake_lease_until IS NOT NULL AND ws.wake_lease_until > now()
                               AND EXISTS (SELECT 1 FROM agent_tasks at3
                                            WHERE at3.agent_id = a.id
                                              AND at3.assignment_status IN ('assigned','accepted','working'))
                               THEN 'working'
                          ELSE 'idle'
                      END AS status,
                      -- ISS-16/#89: RAW heartbeat freshness (seconds since the last keep-alive ping;
                      -- NULL if the agent never beat). No threshold — humans/clients decide what
                      -- 'stale' means; a 'stalled' badge that needs a threshold rides ISS-31 (Q2).
                      EXTRACT(EPOCH FROM (now() - a.last_heartbeat_at)) AS heartbeat_age_secs,
                      COALESCE(w.waiting_on, '[]'::json) AS waiting_on
               FROM agents a
               LEFT JOIN agent_reachability r ON r.agent_id = a.id
               LEFT JOIN agent_wake_state ws ON ws.agent_id = a.id
               LEFT JOIN (
                   SELECT r.requester_id,
                          json_agg(json_build_object(
                              'request_id', r.id,
                              'target_alias', COALESCE(t.alias, '(escalated to human)'),
                              'payload_preview', LEFT(r.payload, 120),
                              'chain_depth', r.chain_depth,
                              'created_at', r.created_at,
                              'expires_at', r.expires_at
                          ) ORDER BY r.created_at) AS waiting_on
                   FROM requests r LEFT JOIN agents t ON t.id = r.target_id
                   WHERE r.status='open' AND r.container_id=%s
                   GROUP BY r.requester_id
               ) w ON w.requester_id = a.id
               WHERE a.container_id=%s AND a.terminated_at IS NULL
               ORDER BY a.created_at""",
            (cid, cid),
        )
        agents = cur.fetchall()

        # ISS-68: TRIMMED, priority-ordered, capped task rows (same shape as GET
        # /api/containers/{cid}/tasks — message_summary + plan_message, NO full thread).
        cur.execute(f"SELECT count(*) AS n FROM tasks t WHERE t.container_id = %s", (cid,))
        task_total = cur.fetchone()["n"]
        task_order = ("ORDER BY CASE t.status WHEN 'needs_verification' THEN 0 "
                      "WHEN 'in_progress' THEN 1 ELSE 2 END, t.priority, t.created_at")
        cur.execute(_task_list_sql("t.container_id = %s", task_order), (cid, task_limit, 0))
        tasks = cur.fetchall()

        # ISS-68: priority-ordered (open→answered→closed), capped request rows.
        cur.execute("SELECT count(*) AS n FROM requests WHERE container_id = %s", (cid,))
        request_total = cur.fetchone()["n"]
        cur.execute(
            """SELECT id, type, status, priority, requester_id, target_id,
                      payload, response, rejection_reason, spawned_task_id,
                      expires_at, created_at, responded_at, closed_at,
                      parent_request_id, chain_depth, detail,
                      -- D7: resolve the spawned task into a light link so the portal can
                      -- navigate request → task without a second call. (Shape pending Tim;
                      -- default = the spawned task.) NULL when the request spawned none.
                      (SELECT json_build_object('task_id', st.id, 'title', st.title, 'status', st.status)
                         FROM tasks st WHERE st.id = requests.spawned_task_id) AS task_link,
                      -- ISS-47: alias of the agent who owns the next action (open→target,
                      -- answered→requester) so the mixed all-request view is unambiguous.
                      (SELECT a.alias FROM agents a
                         WHERE a.id = CASE requests.status WHEN 'open' THEN requests.target_id
                                                           WHEN 'answered' THEN requests.requester_id END)
                        AS owner_alias
               FROM requests WHERE container_id=%s
               ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END,
                        priority, created_at DESC, id
               LIMIT %s OFFSET 0""", (cid, request_limit))
        requests = _annotate_request_ownership(cur.fetchall())

    return {"container": c, "agents": agents, "tasks": tasks, "requests": requests,
            "task_total": task_total, "request_total": request_total}


def _quota_env(name: str) -> Optional[int]:
    """#289: a token quota ceiling is plan-specific and NOT knowable by the server, so we never
    invent one — the meter reports a percent-of-quota ONLY when an operator pins the number via
    env (ORCHA_QUOTA_5H_TOKENS / ORCHA_QUOTA_WEEKLY_TOKENS). Absent/invalid/<=0 → None (the
    endpoint then reports raw consumption with pct=null)."""
    raw = os.environ.get(name)
    if not raw:
        return None
    try:
        v = int(raw)
    except ValueError:
        return None
    return v if v > 0 else None


# A worker_run is MEASURED only if it recorded at least one usage field. An ended row with ALL-NULL
# usage (older pre-mig-019 wakes, or a finish whose result event was unparseable) is NOT a measured
# wake: counting it would inflate `runs` and poison mean-tokens/wake (control_baseline.py:127-132).
# COALESCE(col,0) still lives INSIDE the aggregations — a measured row may carry only some kinds.
_MEASURED_USAGE = (
    "(wr.input_tokens IS NOT NULL OR wr.output_tokens IS NOT NULL "
    "OR wr.cache_read_input_tokens IS NOT NULL OR wr.cache_creation_input_tokens IS NOT NULL "
    "OR wr.total_cost_usd IS NOT NULL)"
)


@app.get("/api/containers/{cid}/token-usage")
def container_token_usage(cid: str):
    """#289 (EFFICIENCY epic, measurement backbone): the tokens-vs-quota METER. Aggregates the
    per-wake token usage the daemon now records on worker_runs (mig 019) into rolling windows so
    we can SEE what the fleet is burning and prove a fix moved the number.

    The accounting that matters: a wake's load against the plan QUOTA is input + output +
    cache-CREATION + cache-READ tokens. Cache reads are nearly free in dollars yet still count
    against the quota — that is exactly the burn that hid behind a small dollar figure — so
    `total_tokens` sums all four, and the dollar figure (`total_cost_usd`) is surfaced
    separately, never as the quota signal.

    Windows: `5h` (the rolling session quota window), `7d` (the weekly quota), and `all` (since
    the container was created). Each carries the four token kinds, their sum, dollar cost, the
    run (wake) count, and — only when the matching ORCHA_QUOTA_* env is pinned — a pct-of-quota.
    Also returns a per-agent all-time breakdown (who is burning) and the single most-recent wake
    (per-wake number). Untyped dict → no response_model → zero OpenAPI drift on a NEW read path.

    NOTE: only wakes that recorded usage (finished post-mig-019, with a parseable result event)
    contribute; older / still-running / usage-less rows are simply absent (NULLs treated as 0)."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    q5h = _quota_env("ORCHA_QUOTA_5H_TOKENS")
    q7d = _quota_env("ORCHA_QUOTA_WEEKLY_TOKENS")
    with db_cursor() as (_, cur):
        _require_container(cur, cid)
        # One pass: conditional (FILTER) aggregation over this container's finished wakes for the
        # three windows. COALESCE so a wake that recorded only some token kinds still sums.
        cur.execute(
            f"""WITH r AS (
                   SELECT wr.ended_at,
                          COALESCE(wr.input_tokens,0)                 AS it,
                          COALESCE(wr.output_tokens,0)                AS ot,
                          COALESCE(wr.cache_read_input_tokens,0)      AS crt,
                          COALESCE(wr.cache_creation_input_tokens,0)  AS cct,
                          COALESCE(wr.total_cost_usd,0)               AS cost
                     FROM worker_runs wr JOIN agents a ON a.id = wr.agent_id
                    WHERE a.container_id=%s AND wr.ended_at IS NOT NULL
                      AND {_MEASURED_USAGE}
               )
               SELECT %s AS win,
                      count(*) FILTER (WHERE ended_at >= now() - interval '5 hours')  AS runs,
                      COALESCE(sum(it)  FILTER (WHERE ended_at >= now() - interval '5 hours'),0) AS it,
                      COALESCE(sum(ot)  FILTER (WHERE ended_at >= now() - interval '5 hours'),0) AS ot,
                      COALESCE(sum(crt) FILTER (WHERE ended_at >= now() - interval '5 hours'),0) AS crt,
                      COALESCE(sum(cct) FILTER (WHERE ended_at >= now() - interval '5 hours'),0) AS cct,
                      COALESCE(sum(cost) FILTER (WHERE ended_at >= now() - interval '5 hours'),0) AS cost
                 FROM r
               UNION ALL
               SELECT '7d',
                      count(*) FILTER (WHERE ended_at >= now() - interval '7 days'),
                      COALESCE(sum(it)  FILTER (WHERE ended_at >= now() - interval '7 days'),0),
                      COALESCE(sum(ot)  FILTER (WHERE ended_at >= now() - interval '7 days'),0),
                      COALESCE(sum(crt) FILTER (WHERE ended_at >= now() - interval '7 days'),0),
                      COALESCE(sum(cct) FILTER (WHERE ended_at >= now() - interval '7 days'),0),
                      COALESCE(sum(cost) FILTER (WHERE ended_at >= now() - interval '7 days'),0)
                 FROM r
               UNION ALL
               SELECT 'all', count(*),
                      COALESCE(sum(it),0), COALESCE(sum(ot),0), COALESCE(sum(crt),0),
                      COALESCE(sum(cct),0), COALESCE(sum(cost),0)
                 FROM r""",
            (cid, "5h"),
        )
        rows = {row["win"]: row for row in cur.fetchall()}

        def _window(row, quota):
            total = int(row["it"] + row["ot"] + row["crt"] + row["cct"])
            return {
                "input_tokens": int(row["it"]),
                "output_tokens": int(row["ot"]),
                "cache_read_input_tokens": int(row["crt"]),
                "cache_creation_input_tokens": int(row["cct"]),
                "total_tokens": total,
                "total_cost_usd": float(row["cost"]),
                "runs": int(row["runs"]),
                "quota_tokens": quota,
                "pct_of_quota": round(total / quota * 100, 2) if quota else None,
            }

        windows = {
            "5h": _window(rows["5h"], q5h),
            "7d": _window(rows["7d"], q7d),
            "all": _window(rows["all"], None),
        }

        # Who is burning — all-time per-agent (live agents + any that left rows behind).
        cur.execute(
            f"""SELECT a.id AS agent_id, a.alias,
                      count(wr.*) AS runs,
                      COALESCE(sum(COALESCE(wr.input_tokens,0)+COALESCE(wr.output_tokens,0)
                               +COALESCE(wr.cache_read_input_tokens,0)
                               +COALESCE(wr.cache_creation_input_tokens,0)),0) AS total_tokens,
                      COALESCE(sum(wr.total_cost_usd),0) AS total_cost_usd
                 FROM agents a
                 JOIN worker_runs wr ON wr.agent_id = a.id AND wr.ended_at IS NOT NULL
                      AND {_MEASURED_USAGE}
                WHERE a.container_id=%s
                GROUP BY a.id, a.alias
                ORDER BY total_tokens DESC""",
            (cid,),
        )
        per_agent = [
            {"agent_id": str(r["agent_id"]), "alias": r["alias"], "runs": int(r["runs"]),
             "total_tokens": int(r["total_tokens"]), "total_cost_usd": float(r["total_cost_usd"])}
            for r in cur.fetchall()
        ]

        # The single most-recent finished wake = the per-wake number.
        cur.execute(
            f"""SELECT wr.run_id, a.alias, wr.ended_at, wr.total_cost_usd,
                      COALESCE(wr.input_tokens,0)+COALESCE(wr.output_tokens,0)
                        +COALESCE(wr.cache_read_input_tokens,0)
                        +COALESCE(wr.cache_creation_input_tokens,0) AS total_tokens
                 FROM worker_runs wr JOIN agents a ON a.id = wr.agent_id
                WHERE a.container_id=%s AND wr.ended_at IS NOT NULL
                      AND {_MEASURED_USAGE}
                ORDER BY wr.ended_at DESC LIMIT 1""",
            (cid,),
        )
        lw = cur.fetchone()
    last_wake = None
    if lw:
        last_wake = {
            "run_id": str(lw["run_id"]), "agent_alias": lw["alias"],
            "ended_at": lw["ended_at"].isoformat() if lw["ended_at"] else None,
            "total_tokens": int(lw["total_tokens"]),
            "total_cost_usd": float(lw["total_cost_usd"]) if lw["total_cost_usd"] is not None else None,
        }
    return {"container_id": cid, "windows": windows, "per_agent": per_agent,
            "last_wake": last_wake}


# ISS-68 (#167): paginated, priority-ordered list endpoints for LAZY loading. The 3s snapshot
# above re-ships every task's full message thread (~277KB) + all request bodies (~478KB); these
# let the portal fetch the top-N rows (TRIMMED — no full thread) and "load more" on demand while
# the poll still refreshes the loaded window. The conversation panel already pages via
# /api/conversations/{conv_id}/turns; the per-task thread pages via GET messages?limit=&before=.

def _task_list_sql(where: str, order: str) -> str:
    # Same card-facing fields as the snapshot's tasks[], MINUS the heavy `messages` json_agg:
    # a `message_summary` {count, last} replaces the thread, and `plan_message` carries the
    # latest agent-authored note so the approval card renders the plan WITHOUT the thread.
    return f"""SELECT t.id, t.title, t.description, t.definition_of_done, t.status, t.priority,
                      t.is_root, t.created_by_agent_id, t.result,
                      -- SPEC-4: per-task working agreement {{review_chain,handoff_to,autonomy,notes}}
                      -- (NULL when unset). Rides the shared task-list builder so it surfaces on the
                      -- snapshot poll + GET /containers/{{cid}}/tasks with no extra call.
                      t.protocol,
                      t.created_at, t.started_at, t.completed_at,
                      COALESCE((SELECT json_agg(a.alias ORDER BY a.alias)
                                FROM agent_tasks at JOIN agents a ON a.id = at.agent_id
                                WHERE at.task_id = t.id), '[]'::json) AS assignees,
                      json_build_object(
                          'count', (SELECT count(*) FROM task_messages m WHERE m.task_id = t.id),
                          'last', (SELECT json_build_object(
                                       'body', LEFT(m.body, 140),
                                       'created_at', m.created_at,
                                       'is_human', (m.author_id IS NOT NULL AND ma.kind = 'human'),
                                       'author_alias', ma.alias)
                                   FROM task_messages m LEFT JOIN agents ma ON ma.id = m.author_id
                                   WHERE m.task_id = t.id ORDER BY m.created_at DESC LIMIT 1)
                      ) AS message_summary,
                      (SELECT json_build_object('decision', d.decision, 'reason', d.reason,
                                 'actor', da.alias, 'at', d.created_at)
                         FROM decisions d LEFT JOIN agents da ON da.id = d.actor_agent_id
                        WHERE d.subject_type = 'plan_approval' AND d.subject_id = t.id::text
                        ORDER BY d.created_at DESC LIMIT 1) AS plan_decision,
                      -- the agent's OPENING plan = the EARLIEST agent-authored post (ASC), matching
                      -- the established "opening non-human message" plan semantics (B10 + the portal
                      -- planMsgOf consumers) so the approval card renders the plan, not a later note.
                      (SELECT json_build_object('body', m.body, 'author_alias', ma.alias, 'at', m.created_at)
                         FROM task_messages m LEFT JOIN agents ma ON ma.id = m.author_id
                        WHERE m.task_id = t.id AND m.author_id IS NOT NULL AND ma.kind <> 'human'
                        ORDER BY m.created_at ASC LIMIT 1) AS plan_message,
                      json_build_object(
                          'count', (SELECT count(*) FROM worker_runs wr WHERE wr.task_id = t.id),
                          'latest', (SELECT json_build_object('status', l.status, 'exit_code', l.exit_code,
                                         'started_at', l.started_at, 'ended_at', l.ended_at)
                                     FROM worker_runs l WHERE l.task_id = t.id
                                     ORDER BY l.started_at DESC LIMIT 1)
                      ) AS runs
               FROM tasks t WHERE {where} {order} LIMIT %s OFFSET %s"""


# ISS-331: shared, injection-safe ORDER BY builder for the two list endpoints (tasks + requests),
# which back ALL FIVE portal surfaces (the container Tasks/Requests lists + the agent-detail
# current-tasks / incoming / outgoing lists via ?agent=&direction=). `sort` selects the leading
# SORTABLE key (time|priority); `dir` its direction. The status `bucket` stays the OUTER key so
# needs-attention / open rows keep floating to the top (preserves triage + composes with the
# ready-queue view); the UNCHOSEN key is the secondary tiebreaker and `id_col` is the final stable
# tiebreaker so paginated windows tile deterministically. "Time-sort is the higher-priority key":
# in time mode time outranks priority. WHITELIST-ONLY — callers run _validate_sort (→400) and ONLY
# fixed column literals are ever interpolated, so no user-controlled string reaches the SQL string.
def _validate_sort(sort: Optional[str], sort_dir: Optional[str]) -> None:
    if sort is not None and sort not in ("priority", "time"):
        raise HTTPException(400, "sort must be 'priority' or 'time'")
    if sort_dir is not None and sort_dir not in ("asc", "desc"):
        raise HTTPException(400, "dir must be 'asc' or 'desc'")


def _sort_clause(sort: Optional[str], sort_dir: Optional[str], *,
                 bucket: str, time_col: str, prio_col: str, id_col: str, default: str) -> str:
    if sort is None:                       # omitted → existing default ORDER BY, byte-identical
        return default
    if sort == "time":                     # default dir for time = DESC (newest first)
        d = "ASC" if sort_dir == "asc" else "DESC"
        return f"ORDER BY {bucket}, {time_col} {d}, {prio_col} ASC, {id_col}"
    # sort == "priority": default dir = ASC (lower number = higher priority, surfaced first)
    d = "DESC" if sort_dir == "desc" else "ASC"
    return f"ORDER BY {bucket}, {prio_col} {d}, {time_col} DESC, {id_col}"


@app.get("/api/containers/{cid}/tasks")
def list_container_tasks(cid: str, limit: int = 10, offset: int = 0, agent: Optional[str] = None,
                         status: Optional[str] = None, unassigned: Optional[bool] = None,
                         sort: Optional[str] = None,
                         sort_dir: Optional[str] = Query(default=None, alias="dir")):
    """ISS-68: paginated TRIMMED task rows for lazy list loading. Default order per Kedar's
    spec: waiting (needs_verification) → in_progress → the rest, then priority, created_at.
    `agent` (uuid) scopes to that agent's assigned tasks (agent-detail current-tasks list).
    Returns {tasks, total, has_more} — `total` lets the UI gate the 'load more' affordance.

    #326 (B1): additive filters make this a first-class READY-QUEUE view so the orchestrator reads
    its live queue in ONE cheap query instead of pulling the whole list and filtering client-side:
      `status`     — exact status filter (e.g. 'ready'); a 'not_ready' held task is naturally absent.
      `unassigned` — true → only tasks with NO active assignee (owner==null).
      `sort=priority` — order strictly by priority, created_at (drops the status-bucket ordering).
    The canonical queue read is `?status=ready&unassigned=true&sort=priority`.

    ISS-331: optional `sort=priority|time` + `dir=asc|desc`. `sort=time` re-orders the SORTABLE key
    within the (unchanged) status bucket; `sort=priority` keeps #326's bucket-free strict-priority
    queue ordering and additionally honors `dir`. All optional and back-compatible: omit them and the
    legacy bucket ordering is unchanged, byte-identical."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if agent is not None and not _valid_uuid(agent):
        raise HTTPException(400, "agent is not a valid UUID")
    _validate_sort(sort, sort_dir)
    lim = max(1, min(limit, 100))
    off = max(0, offset)
    with db_cursor() as (_, cur):
        _require_container(cur, cid)
        where = "t.container_id = %s"
        params: list[Any] = [cid]
        if agent:
            where += " AND EXISTS (SELECT 1 FROM agent_tasks at WHERE at.task_id = t.id AND at.agent_id = %s)"
            params.append(agent)
        if status:
            where += " AND t.status = %s"
            params.append(status)
        if unassigned:
            # #326: the free DISPATCH POOL — no ACTIVE assignee (a 'done' history row doesn't count
            # as owned) AND not the root sentinel (is_root is never claimable via /orcha-next, so it
            # must not pollute the ready-queue read either — mirror the /next eligibility predicate).
            where += (" AND t.is_root = false"
                      " AND NOT EXISTS (SELECT 1 FROM agent_tasks at WHERE at.task_id = t.id "
                      "AND at.assignment_status IN ('assigned','accepted','working'))")
        cur.execute(f"SELECT count(*) AS n FROM tasks t WHERE {where}", tuple(params))
        total = cur.fetchone()["n"]
        default_order = ("ORDER BY CASE t.status WHEN 'needs_verification' THEN 0 "
                         "WHEN 'in_progress' THEN 1 ELSE 2 END, t.priority, t.created_at")
        if sort == "priority":
            # #326: the ready-queue ordering — strict priority (NO status bucket), oldest-first
            # FIFO tiebreak. The canonical queue read depends on this bucket-free ordering, so it
            # is preserved as-is; ISS-331 layers `dir` on top (asc = higher-priority first, default).
            d = "DESC" if sort_dir == "desc" else "ASC"
            order = f"ORDER BY t.priority {d}, t.created_at"
        else:
            # ISS-331: `sort=time` re-orders the sortable key within the status bucket; omitted → default.
            order = _sort_clause(
                sort, sort_dir,
                bucket="CASE t.status WHEN 'needs_verification' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END",
                time_col="t.created_at", prio_col="t.priority", id_col="t.id", default=default_order)
        cur.execute(_task_list_sql(where, order), (*params, lim, off))
        tasks = cur.fetchall()
    return {"tasks": tasks, "total": total, "has_more": off + len(tasks) < total}


@app.get("/api/containers/{cid}/requests")
def list_container_requests(cid: str, limit: int = 15, offset: int = 0,
                            agent: Optional[str] = None, direction: Optional[str] = None,
                            status: Optional[str] = None, sort: Optional[str] = None,
                            sort_dir: Optional[str] = Query(default=None, alias="dir")):
    """ISS-68: paginated request rows for lazy list loading. Status order per Kedar's spec:
    open → answered → closed, then priority, created_at DESC, id (id = stable tiebreaker so
    repeat calls / page boundaries return the SAME window — without it, rows tied on
    (status,priority,created_at) ordered non-deterministically). `agent`+`direction` scopes to the
    agent-detail lists ('in' = addressed to the agent/target; 'out' = raised by it/requester;
    omitted = either side). `status` (optional) filters to one lifecycle state — without it the
    list mixes open+answered+closed, so a caller using this as a census of e.g. open requests
    would silently get closed rows in the window. Same row shape as the snapshot's requests[]
    (drop-in), just paginated + reordered. Returns {requests, total, has_more}."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if agent is not None and not _valid_uuid(agent):
        raise HTTPException(400, "agent is not a valid UUID")
    if direction is not None and direction not in ("in", "out"):
        raise HTTPException(400, "direction must be 'in' or 'out'")
    if status is not None and status not in REQUEST_STATUSES:
        raise HTTPException(400, "status is not a recognized request status")
    _validate_sort(sort, sort_dir)
    lim = max(1, min(limit, 100))
    off = max(0, offset)
    with db_cursor() as (_, cur):
        _require_container(cur, cid)
        where = "container_id = %s"
        params: list[Any] = [cid]
        if agent and direction == "in":
            where += " AND target_id = %s"; params.append(agent)
        elif agent and direction == "out":
            where += " AND requester_id = %s"; params.append(agent)
        elif agent:
            where += " AND (target_id = %s OR requester_id = %s)"; params.extend([agent, agent])
        if status is not None:
            where += " AND status = %s"; params.append(status)
        cur.execute(f"SELECT count(*) AS n FROM requests WHERE {where}", tuple(params))
        total = cur.fetchone()["n"]
        # ISS-331: default keeps open→answered→closed, priority, created_at DESC, id; an explicit
        # sort=priority|time + dir re-orders the sortable key within the (unchanged) status bucket.
        default_order = ("ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END, "
                         "priority, created_at DESC, id")
        order = _sort_clause(
            sort, sort_dir,
            bucket="CASE status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END",
            time_col="created_at", prio_col="priority", id_col="id", default=default_order)
        cur.execute(
            f"""SELECT id, type, status, priority, requester_id, target_id,
                       payload, response, rejection_reason, spawned_task_id,
                       expires_at, created_at, responded_at, closed_at,
                       parent_request_id, chain_depth, detail,
                       (SELECT json_build_object('task_id', st.id, 'title', st.title, 'status', st.status)
                          FROM tasks st WHERE st.id = requests.spawned_task_id) AS task_link,
                       -- ISS-47: alias of the agent owning the next action (open→target,
                       -- answered→requester) — disambiguates this mixed in+out list.
                       (SELECT a.alias FROM agents a
                          WHERE a.id = CASE requests.status WHEN 'open' THEN requests.target_id
                                                            WHEN 'answered' THEN requests.requester_id END)
                         AS owner_alias
                FROM requests WHERE {where} {order} LIMIT %s OFFSET %s""",
            (*params, lim, off))
        rows = _annotate_request_ownership(cur.fetchall())
    return {"requests": rows, "total": total, "has_more": off + len(rows) < total}


@app.get("/api/models")
def list_models():
    """D7: the curated model list the create-agent picker renders ({id, name}) plus
    the default. There is no live model-list API from the CLI — this is a maintained
    constant. B8's dropdown reads this; the selected id is persisted as agents.model."""
    return {"models": AVAILABLE_MODELS, "default": DEFAULT_MODEL}


@app.post("/api/containers/{cid}/status", status_code=200)
def set_container_status(cid: str, body: ContainerStatusUpdate):
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if body.status not in ALLOWED_CONTAINER_STATUSES:
        raise HTTPException(400, f"status must be one of {sorted(ALLOWED_CONTAINER_STATUSES)}")
    with db_cursor() as (conn, cur):
        _require_kind(cur, body.actor_agent_id, ("human",))  # Orcha#30
        c = _require_container(cur, cid)
        old = c["status"]
        completed_clause = ""
        params = [body.status, cid]
        if body.status in ("completed", "cancelled", "failed"):
            completed_clause = ", completed_at = COALESCE(completed_at, now())"
        cur.execute(f"UPDATE containers SET status=%s{completed_clause} WHERE id=%s", params)
        log_event(cur, cid, "human", None, "container", cid, "status_changed",
                  {"from": old, "to": body.status})
        conn.commit()
    return {"container_id": cid, "status": body.status, "from": old}


# ---------- container settings: encrypted LLM API key (#294 Item 1) ----------
# Per-container Anthropic key for the universal LLM client (#290). Stored SEALED by secret_box
# (the row alone is never a usable credential; the master key lives in ORCHA_SECRET_KEY off-row).
# Read path (env override > stored > none) is secret_box.resolve_llm_key; triage call-site wiring
# is downstream (#288/#290), deliberately not here. GET is open (returns only a masked hint, never
# a secret); PUT/DELETE/test are HUMAN-AUTHORITY gated + audit-logged, like /status & /auto-wake.

def _mask_llm_key(hint: Optional[str]) -> Optional[str]:
    """Render the last-4 hint as a masked display value, or None when no key is set."""
    return f"sk-...{hint}" if hint else None


@app.get("/api/containers/{cid}/settings/llm-key", status_code=200)
def get_container_llm_key(cid: str):
    """Report whether a container has an LLM key configured, and from where — NEVER the secret.
    Precedence mirrors the read path: an ORCHA_LLM_API_KEY env override is reported as
    source='env' (and shadows any stored key); else a stored key is source='db'; else
    configured=False. `masked` is a 'sk-...1234' hint; `set_at` feeds the SETTINGS banner."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_container(cur, cid)
        row = _provider_stored_row(cur, cid, "anthropic")  # unified table (migration 027)
    env_override = os.environ.get("ORCHA_LLM_API_KEY")
    if env_override:
        return {"configured": True, "source": "env",
                "masked": _mask_llm_key(secret_box.last4(env_override)), "set_at": None}
    if row and row["key_enc"]:
        return {"configured": True, "source": "db",
                "masked": _mask_llm_key(row["key_hint"]), "set_at": row["set_at"]}
    return {"configured": False, "source": None, "masked": None, "set_at": None}


@app.put("/api/containers/{cid}/settings/llm-key", status_code=200)
def put_container_llm_key(cid: str, body: LlmKeyUpdate):
    """Seal + store a per-container Anthropic key. HUMAN-AUTHORITY gated + audit-logged. Returns
    the masked hint, never the plaintext. 503 if ORCHA_SECRET_KEY is unset (encrypted persistence
    disabled — the operator can still use the ORCHA_LLM_API_KEY env override instead)."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    key = body.api_key.strip()
    if not key:
        raise HTTPException(400, "api_key must not be blank")
    with db_cursor() as (conn, cur):
        _require_kind(cur, body.actor_agent_id, ("human",))  # writing a credential is a human action
        _require_container(cur, cid)
        if not secret_box.master_key_present():
            raise HTTPException(
                503,
                "encrypted key storage is disabled: ORCHA_SECRET_KEY is not set in the portal "
                "environment. Set it to store a key, or use the ORCHA_LLM_API_KEY env override.",
            )
        sealed = secret_box.seal(key)
        hint = secret_box.last4(key)
        # Unified table (migration 027): Anthropic is just provider='anthropic' here now.
        cur.execute(
            "INSERT INTO container_provider_keys (container_id, provider, key_enc, key_hint, set_at) "
            "VALUES (%s, 'anthropic', %s, %s, now()) "
            "ON CONFLICT (container_id, provider) DO UPDATE SET "
            "key_enc=EXCLUDED.key_enc, key_hint=EXCLUDED.key_hint, set_at=now()",
            (cid, sealed, hint),
        )
        log_event(cur, cid, "human", body.actor_agent_id, "container", cid, "llm_key_set",
                  {"provider": "anthropic", "hint": hint})
        conn.commit()
    return {"configured": True, "source": "db", "masked": _mask_llm_key(hint)}


@app.delete("/api/containers/{cid}/settings/llm-key", status_code=200)
def delete_container_llm_key(cid: str, body: LlmKeyActor):
    """Remove the stored key (resolution falls back to the env override, else none). HUMAN-AUTHORITY
    gated + audit-logged. Carries a JSON body for the actor (no other body fields)."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_kind(cur, body.actor_agent_id, ("human",))
        _require_container(cur, cid)
        cur.execute(
            "DELETE FROM container_provider_keys WHERE container_id=%s AND provider='anthropic'",
            (cid,),
        )
        log_event(cur, cid, "human", body.actor_agent_id, "container", cid, "llm_key_cleared",
                  {"provider": "anthropic"})
        conn.commit()
    env_override = os.environ.get("ORCHA_LLM_API_KEY")
    if env_override:
        return {"configured": True, "source": "env",
                "masked": _mask_llm_key(secret_box.last4(env_override))}
    return {"configured": False, "source": None, "masked": None}


@app.post("/api/containers/{cid}/settings/llm-key/test", status_code=200)
def test_container_llm_key(cid: str, body: LlmKeyTest):
    """Server-side credential ping against the Anthropic API. HUMAN-AUTHORITY gated. With `api_key`
    -> test that candidate (the pre-save setup flow); without -> test the currently-resolved key
    (env override > stored). Returns {ok, detail} — a 401 from Anthropic is ok=False (bad key),
    never a 500. The network call runs OUTSIDE the DB transaction (no lock held during I/O)."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_kind(cur, body.actor_agent_id, ("human",))
        _require_container(cur, cid)
        if body.api_key and body.api_key.strip():
            candidate: Optional[str] = body.api_key.strip()
        else:
            candidate = _provider_api_key(cur, cid, "anthropic")  # unified table (migration 027)
    if not candidate:
        return {"ok": False,
                "detail": "no API key to test: none supplied, none stored, and ORCHA_LLM_API_KEY is unset"}
    try:  # same dual-context import as secret_box / llm_util
        import llm_util
    except ImportError:
        from orcha_cli import llm_util
    spec = llm_util.ModelSpec(provider="anthropic", model=llm_util.MODEL_HAIKU,
                              max_tokens=1, timeout_s=10.0)
    try:
        prov = llm_util.get_provider("anthropic")
        prov.complete(spec=spec, system=None,
                      messages=[{"role": "user", "content": "ping"}], api_key=candidate)
        return {"ok": True, "detail": "key accepted by the Anthropic API"}
    except llm_util.LLMError as e:
        return {"ok": False, "detail": str(e)[:300]}


# ---------- container settings: per-PROVIDER LLM keys (multi-provider, follow-on to #294 Item 1) ----------
# Migration 020's single key is Anthropic-only; with >1 live provider (#290 catalog: Anthropic +
# xAI/Grok) a use-case pointed at xAI needs an xAI key. These routes manage ONE key per available
# catalog provider, uniformly for the SETTINGS page — the Anthropic key still lives in its own
# column (the /settings/llm-key routes above remain), other providers in container_provider_keys.
# Same discipline as /settings/llm-key: human-gated writes, never return plaintext, 503 w/o master key.

def _available_provider(provider: str) -> Optional[dict]:
    """The catalog entry for `provider` if it's an AVAILABLE provider, else None."""
    try:
        import llm_util
    except ImportError:
        from orcha_cli import llm_util
    return next((p for p in llm_util.PROVIDER_CATALOG
                 if p["id"] == provider and p["available"]), None)


def _ping_provider_key(provider: str, candidate: str) -> dict:
    """Server-side credential ping against `provider`'s API using its cheapest catalog model and a
    1-token request. Returns {ok, detail}; a 401/bad-key is ok=False, never a 500."""
    try:
        import llm_util
    except ImportError:
        from orcha_cli import llm_util
    p = _available_provider(provider)
    if not p or not p["models"]:
        return {"ok": False, "detail": f"provider '{provider}' has no testable catalog model"}
    spec = llm_util.ModelSpec(provider=provider, model=p["models"][0]["id"],
                              max_tokens=1, timeout_s=10.0)
    try:
        prov = llm_util.get_provider(provider)
        prov.complete(spec=spec, system=None,
                      messages=[{"role": "user", "content": "ping"}], api_key=candidate)
        return {"ok": True, "detail": f"key accepted by the {p['name']} API"}
    except llm_util.LLMError as e:
        return {"ok": False, "detail": str(e)[:300]}


@app.get("/api/containers/{cid}/settings/provider-keys", status_code=200)
def list_container_provider_keys(cid: str):
    """One key-status entry per AVAILABLE catalog provider, for the SETTINGS key cards. NEVER
    returns a secret — only a masked 'sk-...1234' hint + source (env override shadows stored).
    Read-only/open, like GET /settings/providers."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    try:
        import llm_util
    except ImportError:
        from orcha_cli import llm_util
    env_override = os.environ.get("ORCHA_LLM_API_KEY")
    keys = []
    with db_cursor() as (_, cur):
        _require_container(cur, cid)
        for p in llm_util.PROVIDER_CATALOG:
            if not p["available"]:
                continue
            row = _provider_stored_row(cur, cid, p["id"])
            if env_override:
                entry = {"configured": True, "source": "env",
                         "masked": _mask_llm_key(secret_box.last4(env_override)), "set_at": None}
            elif row:
                entry = {"configured": True, "source": "db",
                         "masked": _mask_llm_key(row["key_hint"]), "set_at": row["set_at"]}
            else:
                entry = {"configured": False, "source": None, "masked": None, "set_at": None}
            entry.update({"provider": p["id"], "name": p["name"]})
            keys.append(entry)
    return {"keys": keys}


@app.put("/api/containers/{cid}/settings/provider-keys/{provider}", status_code=200)
def put_container_provider_key(cid: str, provider: str, body: LlmKeyUpdate):
    """Seal + store the key for one provider. HUMAN-AUTHORITY gated + audit-logged. Anthropic
    writes its legacy column; other providers upsert container_provider_keys. 503 w/o ORCHA_SECRET_KEY."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if not _available_provider(provider):
        raise HTTPException(400, f"'{provider}' is not an available catalog provider")
    key = body.api_key.strip()
    if not key:
        raise HTTPException(400, "api_key must not be blank")
    with db_cursor() as (conn, cur):
        _require_kind(cur, body.actor_agent_id, ("human",))
        _require_container(cur, cid)
        if not secret_box.master_key_present():
            raise HTTPException(
                503,
                "encrypted key storage is disabled: ORCHA_SECRET_KEY is not set in the portal "
                "environment. Set it to store a key, or use the ORCHA_LLM_API_KEY env override.",
            )
        sealed = secret_box.seal(key)
        hint = secret_box.last4(key)
        # Unified table (migration 027) — every provider, Anthropic included, upserts here.
        cur.execute(
            "INSERT INTO container_provider_keys (container_id, provider, key_enc, key_hint, set_at) "
            "VALUES (%s, %s, %s, %s, now()) "
            "ON CONFLICT (container_id, provider) DO UPDATE SET "
            "key_enc=EXCLUDED.key_enc, key_hint=EXCLUDED.key_hint, set_at=now()",
            (cid, provider, sealed, hint),
        )
        log_event(cur, cid, "human", body.actor_agent_id, "container", cid, "llm_key_set",
                  {"provider": provider, "hint": hint})
        conn.commit()
    return {"configured": True, "source": "db", "provider": provider, "masked": _mask_llm_key(hint)}


@app.delete("/api/containers/{cid}/settings/provider-keys/{provider}", status_code=200)
def delete_container_provider_key(cid: str, provider: str, body: LlmKeyActor):
    """Remove one provider's stored key (resolution falls back to env override, else none).
    HUMAN-AUTHORITY gated + audit-logged."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if not _available_provider(provider):
        raise HTTPException(400, f"'{provider}' is not an available catalog provider")
    with db_cursor() as (conn, cur):
        _require_kind(cur, body.actor_agent_id, ("human",))
        _require_container(cur, cid)
        # Unified table (migration 027) — clear the row for any provider, Anthropic included.
        cur.execute(
            "DELETE FROM container_provider_keys WHERE container_id=%s AND provider=%s",
            (cid, provider),
        )
        log_event(cur, cid, "human", body.actor_agent_id, "container", cid, "llm_key_cleared",
                  {"provider": provider})
        conn.commit()
    env_override = os.environ.get("ORCHA_LLM_API_KEY")
    if env_override:
        return {"configured": True, "source": "env", "provider": provider,
                "masked": _mask_llm_key(secret_box.last4(env_override))}
    return {"configured": False, "source": None, "provider": provider, "masked": None}


@app.post("/api/containers/{cid}/settings/provider-keys/{provider}/test", status_code=200)
def test_container_provider_key(cid: str, provider: str, body: LlmKeyTest):
    """Credential ping against `provider`'s API. HUMAN-AUTHORITY gated. With `api_key` -> test that
    candidate (pre-save); without -> test the currently-resolved key for this provider."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if not _available_provider(provider):
        raise HTTPException(400, f"'{provider}' is not an available catalog provider")
    with db_cursor() as (conn, cur):
        _require_kind(cur, body.actor_agent_id, ("human",))
        _require_container(cur, cid)
        if body.api_key and body.api_key.strip():
            candidate: Optional[str] = body.api_key.strip()
        else:
            candidate = _provider_api_key(cur, cid, provider)
    if not candidate:
        return {"ok": False,
                "detail": "no API key to test: none supplied, none stored, and ORCHA_LLM_API_KEY is unset"}
    return _ping_provider_key(provider, candidate)


# ---------- container settings: per-use-case universal-client model selection (#294) ----------
# The SETTINGS model picker (SPEC-SETTINGS §2). Two GETs feed the page — the catalog of providers
# +models (/providers) and the current per-use-case selections layered over shipped defaults
# (/models) — and one human-gated PUT replaces the full override set. The selections are ADVISORY:
# a use-case with no row uses #290's hardcoded default (USE_CASE_DEFAULTS), so the store can be
# empty, stale, or unreachable and the client still works. The wake-triage call-site CONSUMES
# these via wake-scan's `triage_model` (resolved by _resolve_use_case_model below).

def _resolve_use_case_model(cur, cid: str, use_case_key: str) -> Optional[dict]:
    """Return the stored {provider, model} override for (container, use_case), or None when unset.
    None ⇒ the caller falls back to the #290 shipped default — the override is advisory and the
    default is always the floor (SPEC-SETTINGS §6 resolver). A stored row whose model has since
    retired from the catalog is returned AS-IS (not auto-cleared); llm_util.resolve_spec / the
    provider then degrade gracefully on use."""
    cur.execute(
        "SELECT provider, model FROM container_model_settings WHERE container_id=%s AND use_case_key=%s",
        (cid, use_case_key),
    )
    row = cur.fetchone()
    return {"provider": row["provider"], "model": row["model"]} if row else None


@app.get("/api/containers/{cid}/settings/providers", status_code=200)
def get_settings_providers(cid: str):
    """The provider+model CATALOG that feeds the SETTINGS dropdowns (SPEC-SETTINGS §0/§3). This is
    the #290 universal-client axis (Anthropic live; OpenAI/Gemini stubbed with available=false),
    NOT GET /api/models (the spawnable-embodiment catalog) — feeding the picker from here is the
    §0 'two model concepts, never one' guarantee. Static (derived from llm_util) but cid-scoped
    for family consistency with the other /settings routes; read-only, no human gate."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        _require_container(cur, cid)
    return {"providers": llm_util.provider_catalog()}


@app.get("/api/containers/{cid}/settings/models", status_code=200)
def get_settings_models(cid: str):
    """The per-use-case model selections for this container — one element per REGISTERED use-case
    (llm_util.USE_CASE_REGISTRY), each with its shipped default and the stored override (if any).
    `is_set=false` ⇒ the page renders ○ 'using shipped default'; `is_set=true` ⇒ ● 'set to X'.
    Read-only (no secrets), so it's open like GET /settings/llm-key."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        _require_container(cur, cid)
        cur.execute(
            "SELECT use_case_key, provider, model FROM container_model_settings WHERE container_id=%s",
            (cid,),
        )
        stored = {r["use_case_key"]: (r["provider"], r["model"]) for r in cur.fetchall()}
    use_cases = []
    for uc in llm_util.use_case_registry():
        ov = stored.get(uc["key"])
        use_cases.append({
            "key": uc["key"], "label": uc["label"], "purpose": uc["purpose"],
            "default_provider": uc["default_provider"], "default_model": uc["default_model"],
            "provider": ov[0] if ov else None, "model": ov[1] if ov else None,
            "is_set": ov is not None,
        })
    return {"use_cases": use_cases}


@app.put("/api/containers/{cid}/settings/models", status_code=200)
def put_settings_models(cid: str, body: ModelSettingsUpdate):
    """Replace the FULL set of per-container model overrides (SPEC-SETTINGS §2.2). HUMAN-AUTHORITY
    gated + audit-logged — a model swap is a deliberate cost/quality decision, mirroring
    /settings/llm-key and /auto-wake. Semantics:
      * each entry with BOTH provider+model set, a REGISTERED key, and a valid catalog choice is
        stored (upsert); a stubbed provider / bogus model / unknown key is a 400 (no partial write);
      * any registered use-case NOT named (or sent with null provider+model) is RESET to default.
    Returns the refreshed list (same shape as GET) so the page reconciles from the server."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    registered = {uc["key"] for uc in llm_util.USE_CASE_REGISTRY}
    # Validate the whole body BEFORE writing anything (all-or-nothing — no partial persist).
    to_set: dict[str, tuple[str, str]] = {}
    for ov in body.use_cases:
        if ov.provider is None and ov.model is None:
            continue  # an explicit reset (treated like omission)
        if ov.key not in registered:
            raise HTTPException(400, f"unknown use-case key '{ov.key}'")
        if not ov.provider or not ov.model:
            raise HTTPException(400, f"use-case '{ov.key}': provider and model must both be set (or both null to reset)")
        if not llm_util.is_catalog_choice(ov.provider, ov.model):
            raise HTTPException(400, f"use-case '{ov.key}': '{ov.provider}/{ov.model}' is not a selectable catalog choice")
        to_set[ov.key] = (ov.provider, ov.model)
    with db_cursor() as (conn, cur):
        _require_kind(cur, body.actor_agent_id, ("human",))  # a cost/quality decision is a human action
        _require_container(cur, cid)
        # Full-replace: drop the prior override set, then insert the validated new one. Any
        # registered key absent from `to_set` is therefore reset to its shipped default.
        cur.execute("DELETE FROM container_model_settings WHERE container_id=%s", (cid,))
        for key, (provider, model) in to_set.items():
            cur.execute(
                "INSERT INTO container_model_settings(container_id, use_case_key, provider, model) "
                "VALUES (%s, %s, %s, %s)",
                (cid, key, provider, model),
            )
        log_event(cur, cid, "human", body.actor_agent_id, "container", cid, "model_settings_set",
                  {"overrides": {k: {"provider": p, "model": m} for k, (p, m) in to_set.items()}})
        conn.commit()
        # Re-read inside the txn so the returned list reflects exactly what was persisted.
        cur.execute(
            "SELECT use_case_key, provider, model FROM container_model_settings WHERE container_id=%s",
            (cid,),
        )
        stored = {r["use_case_key"]: (r["provider"], r["model"]) for r in cur.fetchall()}
    use_cases = []
    for uc in llm_util.use_case_registry():
        ov = stored.get(uc["key"])
        use_cases.append({
            "key": uc["key"], "label": uc["label"], "purpose": uc["purpose"],
            "default_provider": uc["default_provider"], "default_model": uc["default_model"],
            "provider": ov[0] if ov else None, "model": ov[1] if ov else None,
            "is_set": ov is not None,
        })
    return {"use_cases": use_cases}


# ---------- onboarding: SPEC-292 streaming roster proposal ----------

@app.post("/api/onboarding/propose", status_code=200)
def propose_onboarding_roster(body: ProposeBody):
    """SPEC-292: stream an editable roster proposal for the first-run onboarding lane.

    This is deliberately the ONLY new onboarding backend surface. It produces a proposal only;
    commit still reuses the existing POST /containers/{cid}/agents and /tasks flows from the
    client, so there is no server-side /commit route and no forked creation logic.
    """
    if not _valid_uuid(body.cid):
        raise HTTPException(400, "cid is not a valid UUID")

    goal = body.goal.strip()
    if not goal:
        return StreamingResponse(
            _propose_error("invalid_goal", "Describe what you want this workspace to do first."),
            media_type="text/event-stream",
        )

    with db_cursor() as (_, cur):
        _require_container(cur, body.cid)
        model_override = _resolve_use_case_model(cur, body.cid, "onboarding")
        config = {"onboarding": model_override} if model_override else None
        spec = llm_util.resolve_spec("onboarding", config=config)
        # Resolve the key for the SELECTED provider (the onboarding use-case may be overridden to
        # xAI etc. in Settings), not a single Anthropic key. env override > stored provider key > None.
        api_key = _provider_api_key(cur, body.cid, spec.provider)
    try:
        resolved_key = llm_util.resolve_api_key(spec.provider, explicit=api_key)
    except llm_util.LLMError:
        return StreamingResponse(
            _propose_error(
                "no_api_key",
                "No model API key is configured for this workspace yet. Add one in Settings or set ORCHA_LLM_API_KEY.",
            ),
            media_type="text/event-stream",
        )

    force_roster = _propose_should_force_roster(body)
    tools = [_propose_roster_tool_schema()] if force_roster else [_ASK_CLARIFY_TOOL, _propose_roster_tool_schema()]
    tool_choice = {"type": "tool", "name": "propose_roster"} if force_roster else None

    def gen():
        events: list[dict] = []
        try:
            q: queue.Queue = queue.Queue()

            def pump_model():
                try:
                    stream = llm_util.stream_tool_call(
                        "onboarding",
                        system=_propose_system_prompt(force_roster=force_roster),
                        messages=_propose_messages(body),
                        tools=tools,
                        tool_choice=tool_choice,
                        config=config,
                        api_key=resolved_key,
                    )
                    for ev in stream:
                        q.put(("event", ev))
                    q.put(("done", None))
                except Exception as e:
                    q.put(("error", e))

            threading.Thread(target=pump_model, daemon=True).start()
            while True:
                try:
                    kind, item = q.get(timeout=15.0)
                except queue.Empty:
                    yield f": heartbeat {int(time.time())}\n\n"
                    continue
                if kind == "error":
                    raise item
                if kind == "done":
                    break
                ev = item
                events.append(ev)
                if ev.get("type") in ("text_delta", "text"):
                    delta = ev.get("text") or ""
                    if delta:
                        yield _propose_sse({"event": "thinking", "delta": delta})

            clarify = None if force_roster else llm_util.collect_tool_call(events, "ask_clarifying_questions")
            if clarify:
                questions = []
                for i, q in enumerate((clarify.get("input") or {}).get("questions") or []):
                    if not isinstance(q, dict):
                        continue
                    prompt = str(q.get("prompt") or "").strip()
                    if prompt:
                        questions.append({"id": str(q.get("id") or f"q{i + 1}"), "prompt": prompt[:300]})
                    if len(questions) >= 3:
                        break
                if questions:
                    yield _propose_sse({"event": "clarify", "questions": questions})
                    yield _propose_sse({"event": "done"})
                    return

            roster = llm_util.collect_tool_call(events, "propose_roster")
            if not roster:
                diag = llm_util.tool_call_diagnostics(events, "propose_roster")
                ONBOARDING_LOG.warning(
                    "POST /api/onboarding/propose no roster force_roster=%s stop_reason=%s "
                    "output_tokens=%s tool_started=%s tool_completed=%s json_error=%s",
                    force_roster, diag.get("stop_reason"), diag.get("output_tokens"),
                    diag.get("started"), diag.get("completed"), diag.get("json_error"),
                )
                if _propose_roster_was_truncated(force_roster, diag):
                    yield from _propose_error(
                        "roster_truncated",
                        "The roster proposal hit the model output limit before it finished. Narrow the first roster in the goal, then try again, or set it up by hand.",
                    )
                    return
                yield from _propose_error("model_error", "The model did not return a roster proposal.")
                return
            try:
                payload = _normalize_roster_payload(roster.get("input"))
            except ValueError as e:
                yield from _propose_error("invalid_goal", str(e))
                return
            yield _propose_sse({"event": "roster", **payload})
            yield _propose_sse({"event": "done"})
        except llm_util.ProviderNotImplemented as e:
            yield from _propose_error("model_error", str(e))
        except llm_util.LLMError as e:
            msg = str(e)
            code = "rate_limited" if "rate" in msg.lower() or "429" in msg else "model_error"
            yield from _propose_error(code, msg[:300])

    return StreamingResponse(gen(), media_type="text/event-stream")


# ---------- agents ----------

@app.post(
    "/api/containers/{cid}/agents",
    response_model=AgentCreateResponse,
    status_code=201,
)
def register_agent(cid: str, body: AgentCreate):
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    # Orcha#30: agents need a prompt; humans don't.
    if body.kind == "ai" and not (body.prompt and body.prompt.strip()):
        raise HTTPException(400, "kind='ai' requires a non-empty `prompt` (the system prompt)")
    if body.kind == "human" and body.initial_task is not None:
        raise HTTPException(400, "humans don't get an initial_task — they pick work deliberately")
    with db_cursor() as (conn, cur):
        _require_container(cur, cid)

        # D7: default the model for AI agents (Opus 4.8) when the caller omits it;
        # humans carry no model. A supplied model must be one of the curated ids.
        model = body.model
        if body.kind == "human":
            model = None
        else:
            if not model:
                model = DEFAULT_MODEL
            elif model not in _MODEL_IDS:
                raise HTTPException(
                    400, f"model '{model}' is not a known model; choose one of {sorted(_MODEL_IDS)}")
        try:
            cur.execute(
                """INSERT INTO agents (container_id, alias, role, kind, system_prompt, model)
                   VALUES (%s, %s, %s, %s, %s, %s) RETURNING id""",
                (cid, body.alias, body.role, body.kind, body.prompt, model),
            )
        except psycopg.errors.UniqueViolation:
            raise HTTPException(409, f"alias '{body.alias}' already registered in this container")
        aid = str(cur.fetchone()["id"])
        log_event(cur, cid, "human", None, "agent", aid, "created",
                  {"alias": body.alias, "role": body.role, "kind": body.kind})

        initial = None
        if body.initial_task is not None:
            t = body.initial_task
            cur.execute(
                """INSERT INTO tasks
                     (container_id, title, description, definition_of_done,
                      status, priority, created_by_agent_id, started_at)
                   VALUES (%s, %s, %s, %s, 'in_progress', %s, NULL, now())
                   RETURNING id""",
                (cid, t.title, t.description, t.definition_of_done, t.priority),
            )
            tid = str(cur.fetchone()["id"])
            cur.execute(
                """INSERT INTO agent_tasks (agent_id, task_id, assignment_status)
                   VALUES (%s, %s, 'working')""",
                (aid, tid),
            )
            bump_agent(cur, aid)
            recompute_agent_status(cur, aid)
            log_event(cur, cid, "human", None, "task", tid, "created",
                      {"title": t.title, "assigned_to": body.alias})
            log_event(cur, cid, "ai", aid, "task", tid, "claimed",
                      {"via": "initial_task on register"})
            initial = {"task_id": tid, "title": t.title, "status": "in_progress"}

        conn.commit()

    return AgentCreateResponse(
        agent_id=aid, alias=body.alias, container_id=cid, initial_task=initial,
    )


@app.post("/api/agents/{aid}/next")
def agent_next(aid: str):
    """Atomically claim the highest-priority READY task in this agent's container."""
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        ag = _require_agent(cur, aid)
        # Orcha#30: humans don't poll for tasks. They pick deliberately via UI / direct assignment.
        _require_kind(cur, aid, ("ai",))
        _reject_if_retired(cur, aid)   # ISS-51 [P1]: a retired agent can't claim work
        _require_container_active(cur, str(ag["container_id"]), aid)   # GH #24: no claiming work on a paused/stopped container
        # GH #39: the turn_budget gate is removed — an assigned+ready task on an active
        # container is always claimable. turns_used stays as informational telemetry only.
        cid = str(ag["container_id"])

        # Issue #11: exclude the root task. Root is a sentinel for container
        # completion (the human verifies it last); agents should never claim it
        # via /orcha-next or they'd silently take ownership of "objective met."
        #
        # Claim-model subtraction: assignment is the ONLY task trigger. /next returns ONLY tasks
        # directly assigned to this agent (an active agent_tasks row, e.g. via POST /tasks/{tid}/assign).
        # Ready-but-unassigned tasks remain visible for humans/leads to route, but there is no free
        # claim pool for an inbox-only worker to accidentally drain.
        cur.execute(
            """SELECT t.id, t.title, t.description, t.definition_of_done, t.priority, t.protocol
               FROM tasks t
               JOIN agent_tasks at ON at.task_id = t.id AND at.agent_id = %s
                 AND at.assignment_status IN ('assigned','accepted','working')
               WHERE t.container_id=%s AND t.status='ready' AND t.is_root = false
               ORDER BY t.priority, t.created_at
               FOR UPDATE SKIP LOCKED
               LIMIT 1""",
            (aid, cid),
        )
        t = cur.fetchone()
        if not t:
            # Item 8 (review): don't burn turn budget on empty polling.
            conn.commit()
            return {"task": None, "message": "no ready tasks available"}

        tid = str(t["id"])
        cur.execute(
            "UPDATE tasks SET status='in_progress', started_at = COALESCE(started_at, now()) "
            "WHERE id=%s",
            (tid,),
        )
        cur.execute(
            """INSERT INTO agent_tasks (agent_id, task_id, assignment_status)
               VALUES (%s, %s, 'working')
               ON CONFLICT (agent_id, task_id) DO UPDATE SET assignment_status='working'""",
            (aid, tid),
        )
        # #298: read the container-level autonomy slider so the claim payload carries BOTH the
        # global engine level and the per-task protocol. The worker keys its loosely-hardened
        # gh/git behavior (pr create / pr merge) off autonomy_level; protocol.autonomy is the
        # advisory per-task override hint (never the hard completion gate).
        cur.execute("SELECT autonomy_level FROM containers WHERE id=%s", (cid,))
        autonomy_level = cur.fetchone()["autonomy_level"]
        bump_agent(cur, aid)
        recompute_agent_status(cur, aid)
        log_event(cur, cid, "ai", aid, "task", tid, "claimed", {"title": t["title"]})
        conn.commit()
    # SPEC-4: surface the task's protocol on the claim/wake payload so the working agent
    # reads its per-task working agreement (review_chain/handoff_to/autonomy/notes) on wake.
    # #298: also carry the global autonomy_level alongside it.
    # GH #33: carry the FULL task body on the claim payload — title AND description AND
    # definition_of_done — so the woken worker acts on the complete spec (multi-step DoD,
    # loops) instead of just the title/summary.
    return {"task": {"id": tid, "title": t["title"], "description": t["description"],
                     "definition_of_done": t["definition_of_done"],
                     "priority": t["priority"], "protocol": t["protocol"]},
            "autonomy_level": autonomy_level}


@app.get("/api/agents/{aid}/inbox")
def agent_inbox(aid: str, since: Optional[str] = None):
    """Open requests addressed to this agent (incoming side of the inbox).

    Orcha#33: `?since=<ISO-8601 timestamp>` returns only requests with
    `created_at > since`. Used by the `orcha poll-inbox` CLI subcommand that
    runs as a Claude Code PostToolUse hook — gives working agents a ≤5s
    notice on new asks without re-printing items already surfaced.
    """
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    if since is not None:
        try:
            from datetime import datetime
            datetime.fromisoformat(since.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(400, "`since` must be an ISO-8601 timestamp")
    with db_cursor() as (_, cur):
        _require_agent(cur, aid)
        if since is not None:
            cur.execute(
                """SELECT r.id, r.type, r.status, r.priority, r.payload, r.response,
                          r.created_at, r.responded_at, r.expires_at,
                          r.requester_id, a.alias AS requester_alias, r.target_id,
                          r.parent_request_id, r.chain_depth
                   FROM requests r
                   JOIN agents a ON a.id = r.requester_id
                   WHERE r.target_id = %s AND r.status = 'open'
                     AND r.created_at > %s::timestamptz
                   ORDER BY r.priority, r.created_at""",
                (aid, since),
            )
        else:
            cur.execute(
                """SELECT r.id, r.type, r.status, r.priority, r.payload, r.response,
                          r.created_at, r.responded_at, r.expires_at,
                          r.requester_id, a.alias AS requester_alias, r.target_id,
                          r.parent_request_id, r.chain_depth
                   FROM requests r
                   JOIN agents a ON a.id = r.requester_id
                   WHERE r.target_id = %s AND r.status = 'open'
                   ORDER BY r.priority, r.created_at""",
                (aid,),
            )
        return {"open_requests": _annotate_request_ownership(cur.fetchall())}


@app.get("/api/agents/{aid}/outbox")
def agent_outbox(aid: str, status: Optional[str] = None):
    """Outgoing requests where this agent is the requester.

    Use `?status=answered` to see only requests waiting for me to close (or resume the parent).
    Default: all non-closed (open, answered, escalated-via-target-null still open).
    """
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (_, cur):
        _require_agent(cur, aid)
        if status:
            cur.execute(
                """SELECT r.id, r.type, r.status, r.priority, r.payload, r.response,
                          r.created_at, r.responded_at, r.expires_at, r.closed_at,
                          r.target_id, t.alias AS target_alias, r.requester_id,
                          r.parent_request_id, r.chain_depth
                   FROM requests r
                   LEFT JOIN agents t ON t.id = r.target_id
                   WHERE r.requester_id = %s AND r.status = %s
                   ORDER BY r.created_at DESC""",
                (aid, status),
            )
        else:
            cur.execute(
                """SELECT r.id, r.type, r.status, r.priority, r.payload, r.response,
                          r.created_at, r.responded_at, r.expires_at, r.closed_at,
                          r.target_id, t.alias AS target_alias, r.requester_id,
                          r.parent_request_id, r.chain_depth
                   FROM requests r
                   LEFT JOIN agents t ON t.id = r.target_id
                   WHERE r.requester_id = %s AND r.status <> 'closed'
                   ORDER BY r.created_at DESC""",
                (aid,),
            )
        return {"outgoing_requests": _annotate_request_ownership(cur.fetchall())}


# ---------- #247 KEYSTONE: typed notification feed (classify-over-the-bus) ----------

class NotificationsRead(BaseModel):
    through_ts: Optional[float] = Field(
        None,
        description="advance the read cursor to this bus ts (epoch seconds); omit to mark ALL "
                    "current notifications read (cursor jumps to the agent's newest event ts)")


@app.get("/api/agents/{aid}/notifications")
def agent_notifications(aid: str, zone: Optional[str] = None,
                        limit: int = 50, before_ts: Optional[float] = None,
                        before_id: Optional[int] = None):
    """#247 — the recipient's TYPED notification feed, classified over the durable bus.

    Reads this agent's agent_events rows (keyed on its id), classifies each at read time via
    _classify_notification, drops suppressed rows, annotates a `read` flag against the agent's
    read cursor (agent_notification_state), and returns newest-first with keyset paging.

    No response_model — the row shape is computed, so this adds ZERO OpenAPI drift to existing
    routes (only +1 path in the spec delta). Query params:
      * ``zone=needs_you|earlier`` — filter to one SPEC-3 zone (applied AFTER classify).
      * ``limit`` (1..200, default 50) — page size.
      * ``before_ts`` + ``before_id`` — compound keyset cursor: resume strictly AFTER the
        (ts, id) of the last row of the previous page. before_id is optional/null on the first
        page; pass back BOTH next_before_ts and next_before_id verbatim for each subsequent page.
    Response: ``{notifications: [...], read_through_ts, next_before_ts, next_before_id}`` — the
    (ts, id) cursor pair to pass back for the next page (both null = reached the tail). Each row:
    ``{event_name, type, zone, priority, actor_ref, actor_alias, actor_kind, deeplink, preview,
    ts, read}`` — priority is the blocker-CLASS rank (lower = more urgent) and actor_kind
    ('ai'|'human'|None) is the ORIGIN tiebreak; the feed is ts-DESC, blocker-sort is the caller's.
    """
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    if zone is not None and zone not in ("needs_you", "earlier"):
        raise HTTPException(400, "zone must be 'needs_you' or 'earlier'")
    limit = max(1, min(limit, 200))
    # Over-fetch: suppressed rows (conversation_turn can be high-volume) and zone filtering thin the
    # page out post-classify, so scan a wider window of bus rows to fill `limit` classified ones.
    fetch_cap = limit * 4
    with db_cursor() as (_, cur):
        _require_agent(cur, aid)
        cur.execute("SELECT read_through_ts FROM agent_notification_state WHERE agent_id=%s", (aid,))
        crow = cur.fetchone()
        read_through = crow["read_through_ts"] if crow else 0.0
        # Compound (ts, id) keyset. ORDER BY ts DESC, id DESC means a page boundary can fall
        # INSIDE a group of rows that share one ts. A ts-only cursor (ts < before_ts) would then
        # silently DROP the remaining co-ts rows below the cut. Pairing the boundary id with the ts
        # resumes EXACTLY after the last-returned row: (ts < before_ts) OR (ts = before_ts AND
        # id < before_id). The idx_agent_events_key_ts (event_key, ts, id) index covers it directly.
        before_ts_eff = before_ts if before_ts is not None else 9e18
        if before_id is not None:
            cur.execute(
                """SELECT id, event_name, ts, payload FROM agent_events
                     WHERE event_key = %s AND (ts < %s OR (ts = %s AND id < %s))
                     ORDER BY ts DESC, id DESC
                     LIMIT %s""",
                (aid, before_ts_eff, before_ts_eff, before_id, fetch_cap),
            )
        else:
            cur.execute(
                """SELECT id, event_name, ts, payload FROM agent_events
                     WHERE event_key = %s AND ts < %s
                     ORDER BY ts DESC, id DESC
                     LIMIT %s""",
                (aid, before_ts_eff, fetch_cap),
            )
        raw = cur.fetchall()
        # Q2: batch-resolve actor aliases + requester kinds in ONE query (read-time, no backfill).
        ids: set[str] = set()
        for r in raw:
            p = r["payload"] or {}
            for f in _NOTIF_ACTOR_FIELDS:
                if p.get(f):
                    ids.add(str(p[f]))
        people: dict[str, dict] = {}
        if ids:
            cur.execute("SELECT id, alias, kind FROM agents WHERE id = ANY(%s)", (list(ids),))
            people = {str(a["id"]): a for a in cur.fetchall()}

    out = []
    truncated = False
    last_emitted = None   # raw row behind out[-1] — its (ts, id) is the next page's keyset cursor
    for r in raw:
        p = r["payload"] or {}
        requester_is_human = False
        if r["event_name"] == "request_created":
            fa = str(p["from_agent_id"]) if p.get("from_agent_id") else None
            requester_is_human = bool(fa and (people.get(fa) or {}).get("kind") == "human")
        n = _classify_notification(r["event_name"], p, requester_is_human=requester_is_human)
        if n is None:
            continue
        if zone is not None and n["zone"] != zone:
            continue
        actor = people.get(n["actor_ref"]) or {} if n["actor_ref"] else {}
        out.append({
            "event_name": r["event_name"],
            "type": n["type"], "zone": n["zone"], "priority": n["priority"],
            # actor_ref = the originating agent id; actor_alias/actor_kind are resolved read-time
            # (Q2, no backfill). actor_kind ('human'|'agent') is the ORIGIN tiebreak the #247 wake
            # ranker (SPEC-WAKE-BOOT) needs to break ties between equal-priority notifications.
            "actor_ref": n["actor_ref"], "actor_alias": actor.get("alias"),
            "actor_kind": actor.get("kind"),
            "deeplink": n["deeplink"], "preview": n["preview"],
            "ts": r["ts"], "read": r["ts"] <= read_through,
        })
        last_emitted = r
        if len(out) >= limit:
            truncated = True
            break

    # Keyset for "Load earlier": resume from the (ts, id) of the boundary row so a page that splits
    # a co-ts group loses nothing. If we capped `out` at limit, that boundary is the last emitted
    # row. Otherwise we consumed the whole fetch window — only signal more if that window itself was
    # full (it may have ended on suppressed rows with real rows still beyond it, so resume from the
    # last scanned raw row); a short window = the true tail.
    if truncated:
        next_before_ts = last_emitted["ts"]
        next_before_id = last_emitted["id"]
    elif len(raw) >= fetch_cap:
        next_before_ts = raw[-1]["ts"]
        next_before_id = raw[-1]["id"]
    else:
        next_before_ts = None
        next_before_id = None
    return {"notifications": out, "read_through_ts": read_through,
            "next_before_ts": next_before_ts, "next_before_id": next_before_id}


@app.post("/api/agents/{aid}/notifications/read", status_code=200)
def agent_notifications_read(aid: str, body: NotificationsRead):
    """#247 — advance this agent's notification read cursor (monotonic).

    UPSERTs agent_notification_state.read_through_ts. With ``through_ts`` omitted it jumps to the
    agent's newest bus ts now ("Mark all read"); with it set, advances to that ts (per-row "mark
    read up to here"). NEVER moves backward — a stale client can't un-read via GREATEST().

    This OPERATOR read cursor is deliberately SEPARATE from agent_wake_state.delivered_ts (the
    notifier daemon's wake-ack cursor); the two must never cross-clear.
    """
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_agent(cur, aid)
        target = body.through_ts
        if target is None:
            cur.execute("SELECT COALESCE(MAX(ts), 0) AS mx FROM agent_events WHERE event_key=%s", (aid,))
            target = cur.fetchone()["mx"]
        cur.execute(
            """INSERT INTO agent_notification_state (agent_id, read_through_ts, updated_at)
               VALUES (%s, %s, now())
               ON CONFLICT (agent_id) DO UPDATE
                 SET read_through_ts = GREATEST(agent_notification_state.read_through_ts,
                                                EXCLUDED.read_through_ts),
                     updated_at = now()
               RETURNING read_through_ts""",
            (aid, target),
        )
        read_through = cur.fetchone()["read_through_ts"]
        conn.commit()
    return {"agent_id": aid, "read_through_ts": read_through}


# ---------- reachability (Epic A: wake & self-movement) ----------

@app.post("/api/agents/{aid}/reachability", status_code=200)
def set_reachability(aid: str, body: ReachabilityUpsert):
    """Record/refresh how the notifier daemon can wake this agent's Claude session.

    Partial upsert: a NULL field in the body leaves the stored value unchanged, so
    SessionStart can refresh the volatile tmux pane without disturbing a human's
    earlier wake_enabled=false opt-out. The row is created on first call with
    wake_enabled defaulting to true (wake is ON by default).
    """
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_agent(cur, aid)
        # Partial upsert: COALESCE(raw bind, existing) on conflict = "only overwrite
        # when a non-null value was supplied". We reference the raw nullable binds
        # (%(we)s …) in DO UPDATE rather than EXCLUDED, because EXCLUDED.wake_enabled
        # carries the VALUES expression COALESCE(%(we)s, true) — never NULL — which
        # would silently re-enable wakes on a later pane-only refresh.
        cur.execute(
            """INSERT INTO agent_reachability
                 (agent_id, wake_enabled, tmux_target, headless_cwd, headless_flags, updated_at)
               VALUES (%(aid)s, COALESCE(%(we)s, true), %(tt)s, %(hc)s, %(hf)s, now())
               ON CONFLICT (agent_id) DO UPDATE SET
                 wake_enabled   = COALESCE(%(we)s, agent_reachability.wake_enabled),
                 tmux_target    = COALESCE(%(tt)s, agent_reachability.tmux_target),
                 headless_cwd   = COALESCE(%(hc)s, agent_reachability.headless_cwd),
                 headless_flags = COALESCE(%(hf)s, agent_reachability.headless_flags),
                 updated_at     = now()
               RETURNING wake_enabled, tmux_target, headless_cwd, headless_flags, updated_at""",
            {"aid": aid, "we": body.wake_enabled, "tt": body.tmux_target,
             "hc": body.headless_cwd, "hf": body.headless_flags},
        )
        row = cur.fetchone()
        conn.commit()
    return {"agent_id": aid, **row}


@app.post("/api/agents/{aid}/retire", status_code=200)
def retire_agent(aid: str, body: AgentRetire):
    """ISS-51: retire an agent — human-authority gated. Sets agents.terminated_at +
    status='terminated' so the container roster (which now filters terminated_at IS
    NULL) stops listing it. Any task this agent was actively working is RELEASED back
    to status='ready' (its assignment dropped) so another agent can reclaim it; the
    task thread (task_messages) is retained. A task with OTHER active assignees stays
    in_progress — only this agent's assignment is dropped. Idempotent: re-retiring an
    already-retired agent returns 200 without re-releasing tasks."""
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_kind(cur, body.actor_agent_id, ("human",))   # only a human may retire
        ag = _require_agent(cur, aid)
        cur.execute("SELECT terminated_at FROM agents WHERE id=%s", (aid,))
        if cur.fetchone()["terminated_at"] is not None:
            return {"agent_id": aid, "status": "terminated",
                    "released_tasks": [], "already_retired": True}

        # Tasks this agent is actively on (assigned/accepted/working).
        cur.execute(
            """SELECT task_id FROM agent_tasks
               WHERE agent_id=%s AND assignment_status IN ('assigned','accepted','working')""",
            (aid,),
        )
        active_task_ids = [str(r["task_id"]) for r in cur.fetchall()]

        # Drop ONLY this agent's ACTIVE assignments — terminal ('done') rows are kept so
        # completed/needs-verification tasks retain their assignee history (the container
        # snapshot builds task.assignees from agent_tasks).  [P2 review fix]
        cur.execute(
            "DELETE FROM agent_tasks WHERE agent_id=%s "
            "AND assignment_status IN ('assigned','accepted','working')",
            (aid,),
        )

        # Release to 'ready' any in_progress task that now has no active assignee left.
        released = []
        for tid in active_task_ids:
            cur.execute(
                """SELECT 1 FROM agent_tasks
                   WHERE task_id=%s AND assignment_status IN ('assigned','accepted','working')
                   LIMIT 1""",
                (tid,),
            )
            if cur.fetchone() is None:
                cur.execute(
                    "UPDATE tasks SET status='ready', started_at=NULL "
                    "WHERE id=%s AND status='in_progress' AND is_root=false RETURNING id",
                    (tid,),
                )
                if cur.fetchone():
                    released.append(tid)

        # Mark the agent retired.
        cur.execute(
            "UPDATE agents SET terminated_at=now(), status='terminated' WHERE id=%s", (aid,))
        log_event(cur, ag["container_id"], "human", body.actor_agent_id, "agent", aid,
                  "agent_retired", {"released_tasks": released})
        conn.commit()
    return {"agent_id": aid, "status": "terminated", "released_tasks": released}


@app.post("/api/agents/{aid}/model", status_code=200)
def set_agent_model(aid: str, body: AgentModelUpdate):
    """B8.1: update the LLM model an agent runs on. Persists agents.model (set at
    registration in D7) and flows through the D7 read payload (agent.model). The model
    must be a curated id (AVAILABLE_MODELS) — kept curated per kedar; new providers
    are added there as supported. Humans carry no model (400). Spawning the worker
    WITH this model (--model) is Forge's B8.2, separate from this persistence."""
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    if body.model not in _MODEL_IDS:
        raise HTTPException(
            400, f"model '{body.model}' is not a known model; choose one of {sorted(_MODEL_IDS)}")
    with db_cursor() as (conn, cur):
        ag = _require_agent(cur, aid)
        cur.execute("SELECT kind, model FROM agents WHERE id=%s", (aid,))
        row = cur.fetchone()
        if row["kind"] == "human":
            raise HTTPException(400, "humans carry no model")
        old_model = row["model"]
        cur.execute("UPDATE agents SET model=%s WHERE id=%s RETURNING model", (body.model, aid))
        new_model = cur.fetchone()["model"]
        # GAP B: a resident's WARM `claude --resume` re-attaches the pinned session, which has the
        # OLD model baked in — so a mid-conversation model switch would be a silent no-op until the
        # session happened to end. Force a COLD reboot by clearing the pinned session_id on the
        # agent's active conversation(s): the daemon's next boot sees session_id=NULL → cold path →
        # spawns with `--model <new>` and re-injects the history prefix (continuity preserved; a KV
        # warm-cache can't cross models anyway). Only on an ACTUAL change, to avoid needless reboots.
        cold_reset = []
        if new_model != old_model:
            cur.execute(
                "UPDATE conversations SET session_id=NULL "
                "WHERE agent_id=%s AND status='active' AND session_id IS NOT NULL "
                "RETURNING id", (aid,))
            cold_reset = [str(c["id"]) for c in cur.fetchall()]
        log_event(cur, ag["container_id"], "human", None, "agent", aid, "model_changed",
                  {"model": new_model, "previous_model": old_model,
                   "cold_reset_conversations": cold_reset})
        conn.commit()
    return {"agent_id": aid, "model": new_model, "cold_reset_conversations": cold_reset}


@app.patch("/api/agents/{aid}", status_code=200)
def update_agent(aid: str, body: AgentUpdate):
    """Edit an agent's role / system_prompt / alias (onboarding + re-profiles; no such
    route existed — personas were edited via raw DB). HUMAN-authority gated. PARTIAL:
    only the supplied fields change. Editing a HUMAN's system_prompt is rejected (humans
    carry no prompt). Renaming alias is 409-guarded on collision (UNIQUE per container);
    NOTE a rename orphans the local CLI binding file (.claude/orcha-tabs/<oldalias>.json),
    so the agent must re-bind (/orcha-use or re-register). The change flows through
    GET /persona AND the container read payload (role, prompt_preview)."""
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    if body.role is None and body.system_prompt is None and body.alias is None:
        raise HTTPException(400, "no updatable field supplied (role / system_prompt / alias)")
    with db_cursor() as (conn, cur):
        _require_kind(cur, body.actor_agent_id, ("human",))   # only a human may edit an agent
        cur.execute("SELECT kind, container_id FROM agents WHERE id=%s", (aid,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, f"agent {aid} not found")
        if body.system_prompt is not None:
            if row["kind"] == "human":
                raise HTTPException(400, "humans carry no system_prompt")
            # [P1 review] mirror register_agent's create-time rule: an AI agent must
            # keep a non-empty prompt, else /persona returns blank and the notifier's
            # format_persona() skips it -> headless workers boot as generic Claude.
            if not body.system_prompt.strip():
                raise HTTPException(400, "kind='ai' requires a non-empty system_prompt")

        sets, params, changed = [], [], []
        if body.role is not None:
            sets.append("role=%s"); params.append(body.role); changed.append("role")
        if body.system_prompt is not None:
            sets.append("system_prompt=%s"); params.append(body.system_prompt); changed.append("system_prompt")
        if body.alias is not None:
            if not body.alias.strip():
                raise HTTPException(400, "alias cannot be blank")
            sets.append("alias=%s"); params.append(body.alias); changed.append("alias")
        params.append(aid)
        try:
            cur.execute(
                f"UPDATE agents SET {', '.join(sets)} WHERE id=%s "
                "RETURNING id, alias, role, kind, system_prompt, model, status",
                params,
            )
        except psycopg.errors.UniqueViolation:
            raise HTTPException(409, f"alias '{body.alias}' already exists in this container")
        updated = cur.fetchone()
        log_event(cur, row["container_id"], "human", body.actor_agent_id, "agent", aid,
                  "agent_updated", {"fields": changed})
        conn.commit()
    result = {"agent_id": aid, **updated}
    if body.alias is not None:
        result["alias_rebind_note"] = ("alias changed — the local CLI binding "
                                       ".claude/orcha-tabs/<oldalias>.json is now stale; "
                                       "re-bind via /orcha-use or re-register")
    return result


@app.patch("/api/agents/{aid}/auto-wake", status_code=200)
def update_agent_auto_wake(aid: str, body: AutoWakeUpdate):
    """#266: set or clear an agent's clock-driven AUTO-WAKE interval. HUMAN-AUTHORITY gated +
    audit-logged, mirroring /verify and the protocol PATCH (Orcha#30): only a kind='human' actor
    may change wake policy. `interval_secs` is explicit (int>=60 to enable, null to disable) — the
    60s floor is also enforced by the DB CHECK, so a sub-floor value is rejected at the Pydantic
    layer (422) before it reaches SQL. Editing a HUMAN agent is rejected (humans aren't woken).
    The new value surfaces in wake-scan (the `auto_wake_due`/`auto_wake_interval_secs` candidate
    fields the notifier reads) and the container agent snapshot."""
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_kind(cur, body.actor_agent_id, ("human",))  # Orcha#30: wake policy is a human action
        cur.execute("SELECT kind, container_id FROM agents WHERE id=%s", (aid,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, f"agent {aid} not found")
        if row["kind"] == "human":
            raise HTTPException(400, "humans are not woken — auto-wake applies to kind='ai' agents")
        cur.execute(
            "UPDATE agents SET auto_wake_interval_secs=%s WHERE id=%s "
            "RETURNING id, alias, auto_wake_interval_secs",
            (body.interval_secs, aid),
        )
        updated = cur.fetchone()
        log_event(cur, str(row["container_id"]), "human", body.actor_agent_id, "agent", aid,
                  "auto_wake_updated", {"interval_secs": body.interval_secs})
        conn.commit()
    return {"agent_id": aid, "alias": updated["alias"],
            "auto_wake_interval_secs": updated["auto_wake_interval_secs"],
            "enabled": updated["auto_wake_interval_secs"] is not None}


@app.get("/api/agents/{aid}/reachability")
def get_reachability(aid: str):
    """Read an agent's reachability. Returns wake-on defaults when no row exists yet."""
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (_, cur):
        _require_agent(cur, aid)
        cur.execute(
            """SELECT wake_enabled, tmux_target, headless_cwd, headless_flags, updated_at
               FROM agent_reachability WHERE agent_id=%s""",
            (aid,),
        )
        row = cur.fetchone()
    if not row:
        # No row recorded yet — wake is on by default, but no transport is known
        # (the agent hasn't registered a tmux pane / headless cwd), so it's
        # effectively unreachable until SessionStart records one.
        return {"agent_id": aid, "wake_enabled": True, "tmux_target": None,
                "headless_cwd": None, "headless_flags": None, "updated_at": None,
                "recorded": False}
    return {"agent_id": aid, "recorded": True, **row}


# ---------- conversation store (E3 persistence; docs/orcha-conversation-model.md) ----------

_TURN_COLS = ("id, conversation_id, seq, role, author_agent_id, content, run_id, meta, "
              "attachments, created_at")  # #338: attachments surfaced to read paths + feed-to-agent


@app.post("/api/agents/{aid}/conversations", status_code=201)
def start_conversation(aid: str, body: ConversationStart):
    """Get-or-create the ACTIVE conversation with an AI agent (a human opens it). At most
    ONE active conversation per agent (the one-embodiment invariant). Idempotent — returns
    the existing active conversation if one is open."""
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        ag = _require_agent(cur, aid)
        _require_kind(cur, body.actor_agent_id, ("human",))   # a human opens the conversation
        cur.execute("SELECT kind FROM agents WHERE id=%s", (aid,))
        if cur.fetchone()["kind"] != "ai":
            raise HTTPException(400, "conversations target an AI agent")
        # Race-safe get-or-create: INSERT ... ON CONFLICT DO NOTHING against the
        # partial-unique index (agent_id WHERE status='active'). If a concurrent caller
        # already holds the active conversation, the insert no-ops (no aborted txn — the
        # earlier except-branch SELECT would have hit InFailedSqlTransaction) and we
        # return the winner's row. [P2 review fix]
        cur.execute(
            "INSERT INTO conversations (container_id, agent_id, started_by) VALUES (%s, %s, %s) "
            "ON CONFLICT (agent_id) WHERE status='active' DO NOTHING RETURNING *",
            (ag["container_id"], aid, body.actor_agent_id),
        )
        conv = cur.fetchone()
        if conv is None:
            cur.execute("SELECT * FROM conversations WHERE agent_id=%s AND status='active'", (aid,))
            return {"conversation": cur.fetchone(), "created": False}
        log_event(cur, str(ag["container_id"]), "human", body.actor_agent_id,
                  "conversation", str(conv["id"]), "conversation_started", {"agent_id": aid})
        conn.commit()
    return {"conversation": conv, "created": True}


@app.get("/api/agents/{aid}/conversation")
def get_agent_conversation(aid: str, limit: int = 50):
    """The agent's ACTIVE conversation + its most-recent turns (oldest→newest). Convenience
    for V1 boot-injection and the portal panel. {conversation: null, turns: []} if none."""
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    limit = max(1, min(limit, 500))
    with db_cursor() as (_, cur):
        _require_agent(cur, aid)
        cur.execute("SELECT * FROM conversations WHERE agent_id=%s AND status='active'", (aid,))
        conv = cur.fetchone()
        if not conv:
            return {"conversation": None, "turns": []}
        cur.execute(
            f"SELECT {_TURN_COLS} FROM conversation_turns WHERE conversation_id=%s "
            "ORDER BY seq DESC LIMIT %s", (conv["id"], limit))
        turns = list(reversed(cur.fetchall()))
    return {"conversation": conv, "turns": turns}


@app.get("/api/conversations/{conv_id}")
def get_conversation(conv_id: str):
    if not _valid_uuid(conv_id):
        raise HTTPException(400, "conversation_id is not a valid UUID")
    with db_cursor() as (_, cur):
        cur.execute("SELECT * FROM conversations WHERE id=%s", (conv_id,))
        conv = cur.fetchone()
    if not conv:
        raise HTTPException(404, f"conversation {conv_id} not found")
    return {"conversation": conv}


@app.get("/api/conversations/{conv_id}/turns")
def list_turns(conv_id: str, limit: int = 100, after_seq: int = 0):
    """Ordered turns oldest→newest from after_seq (exclusive). For V1 history injection
    (cache-friendly prefix order) and the portal panel; page with ?after_seq=<last seq>."""
    if not _valid_uuid(conv_id):
        raise HTTPException(400, "conversation_id is not a valid UUID")
    limit = max(1, min(limit, 1000))
    with db_cursor() as (_, cur):
        cur.execute("SELECT 1 FROM conversations WHERE id=%s", (conv_id,))
        if not cur.fetchone():
            raise HTTPException(404, f"conversation {conv_id} not found")
        cur.execute(
            f"SELECT {_TURN_COLS} FROM conversation_turns WHERE conversation_id=%s AND seq>%s "
            "ORDER BY seq LIMIT %s", (conv_id, after_seq, limit))
        turns = cur.fetchall()
    return {"conversation_id": conv_id, "turns": turns}


@app.post("/api/conversations/{conv_id}/turns", status_code=201)
def append_turn(conv_id: str, body: TurnAppend):
    """Append one turn; the server assigns a per-conversation monotonic seq. A HUMAN turn
    is PERSISTED FIRST, then a targeted 'conversation_turn' event is published to the agent
    so the resident-session manager (Forge) feeds it to the resident's stdin — guaranteeing
    the human turn has its seq before delivery (deterministic ordering). An AGENT turn is
    posted by the resident once per stream-json 'result', linked to its worker_run via run_id."""
    if not _valid_uuid(conv_id):
        raise HTTPException(400, "conversation_id is not a valid UUID")
    if not _valid_uuid(body.author_agent_id):
        raise HTTPException(400, "author_agent_id is not a valid UUID")
    if body.run_id is not None and not _valid_uuid(body.run_id):
        raise HTTPException(400, "run_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        cur.execute("SELECT * FROM conversations WHERE id=%s FOR UPDATE", (conv_id,))
        conv = cur.fetchone()
        if not conv:
            raise HTTPException(404, f"conversation {conv_id} not found")
        if conv["status"] == "ended":
            raise HTTPException(409, "conversation has ended — cannot append turns")
        # Integrity: agent turns come from the conversation's agent; human turns from a human.
        if body.role == "agent":
            if body.author_agent_id != str(conv["agent_id"]):
                raise HTTPException(403, "an 'agent' turn must be authored by the conversation's agent")
            # [P2 review] an agent turn is one-per-worker-run; require run_id and verify the
            # run belongs to THIS agent, else the wrong live stream (worker_run_lines) gets
            # attached to the turn.
            if not body.run_id:
                raise HTTPException(400, "an 'agent' turn requires run_id (its worker_run)")
            cur.execute("SELECT agent_id FROM worker_runs WHERE run_id=%s", (body.run_id,))
            wr = cur.fetchone()
            if not wr:
                raise HTTPException(404, f"worker_run {body.run_id} not found")
            if str(wr["agent_id"]) != str(conv["agent_id"]):
                raise HTTPException(403, "run_id belongs to a different agent")
        if body.role == "human":
            cur.execute("SELECT kind FROM agents WHERE id=%s", (body.author_agent_id,))
            arow = cur.fetchone()
            if not arow:
                raise HTTPException(404, f"agent {body.author_agent_id} not found")
            if arow["kind"] != "human":
                raise HTTPException(403, "a 'human' turn must be authored by a human")
        # #338: re-validate any staged attachment refs against THIS conversation's on-disk store
        # (re-deriving size/type) so the JSONB only ever holds real, this-conversation files.
        llm_key = _container_llm_key(cur, str(conv["container_id"]))
        attachments = _validate_conv_attachment_refs(conv_id, body.attachments, api_key=llm_key)
        cur.execute(
            "SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM conversation_turns WHERE conversation_id=%s",
            (conv_id,))
        seq = cur.fetchone()["n"]
        cur.execute(
            "INSERT INTO conversation_turns "
            "(conversation_id, seq, role, author_agent_id, content, run_id, meta, attachments) "
            f"VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING {_TURN_COLS}",
            (conv_id, seq, body.role, body.author_agent_id, body.content,
             body.run_id, json.dumps(body.meta or {}), json.dumps(attachments)))
        turn = cur.fetchone()
        cur.execute("UPDATE conversations SET last_turn_at=now() WHERE id=%s", (conv_id,))
        if body.role == "human":
            # Persisted (seq assigned) BEFORE delivery — the E3 bridge to the resident. #338: carry
            # the validated attachment refs so the resident-feed (Forge → _send_user_turn) can hand
            # the agent the files alongside the text without a second fetch.
            _publish_event(cur, str(conv["container_id"]), str(conv["agent_id"]),
                           "conversation_turn",
                           {"conversation_id": conv_id, "turn_id": str(turn["id"]),
                            "seq": seq, "content": body.content, "attachments": attachments})
        conn.commit()
    return {"turn": turn}


@app.post("/api/conversations/{conv_id}/session", status_code=200)
def set_conversation_session(conv_id: str, body: ConversationSession):
    """Record the claude --session-id (the resident manager sets this when it spawns the
    resident, so the same session can be pinned/resumed across respawns). ISS-70: also stamp
    session_pinned_at=now() so active-conversations can compute `cold_required` — force a one-shot
    cold boot (re-injecting persona+digest) when a digest written by another embodiment is newer
    than this pin."""
    if not _valid_uuid(conv_id) or not _valid_uuid(body.session_id):
        raise HTTPException(400, "conversation_id and session_id must be valid UUIDs")
    with db_cursor() as (conn, cur):
        cur.execute("UPDATE conversations SET session_id=%s, session_pinned_at=now() "
                    "WHERE id=%s RETURNING id, session_id",
                    (body.session_id, conv_id))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, f"conversation {conv_id} not found")
        conn.commit()
    return {"conversation_id": conv_id, "session_id": str(row["session_id"])}


@app.post("/api/conversations/{conv_id}/end", status_code=200)
def end_conversation(conv_id: str, body: ConversationActor):
    """Mark a conversation ended (human closes it, or the idle reaper on session end).
    Idempotent. Frees the agent's single active-conversation slot."""
    if not _valid_uuid(conv_id):
        raise HTTPException(400, "conversation_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_agent(cur, body.actor_agent_id)   # actor must exist (human or the resident manager)
        cur.execute(
            "UPDATE conversations SET status='ended', ended_at=now() "
            "WHERE id=%s AND status<>'ended' RETURNING id, container_id", (conv_id,))
        row = cur.fetchone()
        if row:
            log_event(cur, str(row["container_id"]), "ai", body.actor_agent_id,
                      "conversation", conv_id, "conversation_ended", {})
            conn.commit()
            return {"conversation_id": conv_id, "status": "ended"}
        cur.execute("SELECT 1 FROM conversations WHERE id=%s", (conv_id,))
        if not cur.fetchone():
            raise HTTPException(404, f"conversation {conv_id} not found")
        return {"conversation_id": conv_id, "status": "ended", "already_ended": True}


def _collect_directed_messages(cur, aid: str, delivered_ts, max_ts):
    """Surface the DIRECTED messages (`prompt` / `task_message` / `task_assigned`) pending for an
    agent past its wake cursor, oldest-first, bounded by MAX_PROMPT_BATCH_CHARS. Returns (messages,
    wake_task_id, ack_through_ts).

    These event kinds carry content with NO inbox surface — they are delivered ONLY by injecting
    the text into the agent's turn (there is no 'prompt inbox' to read). So the cursor must NOT be
    acked past an un-surfaced one: `ack_through_ts` is the last INCLUDED event's ts, defaulting to
    `max_ts` when nothing is truncated (then everything is safe to ack). If the batch overflows, the
    later messages stay pending and arrive on the next wake/drain (forward progress, no loss).

    Shared by wake_scan (ephemeral wakes) and active_conversations (ISS-74 resident inbox drain) so
    BOTH paths deliver directed messages identically — a resident drain can never mark a directed
    event delivered without its content reaching the agent. (A `task_assigned` whose task is already
    completed/cancelled by wake time surfaces nothing but is still acked — see the branch below.)"""
    messages = []
    wake_task_id = None                              # ISS-56: attribute the run to its task
    ack_through_ts = max_ts                          # default: nothing truncated → ack all pending
    cur.execute(
        """SELECT ts, event_name, payload FROM agent_events
           WHERE event_key = %s AND ts > %s
             AND event_name IN ('prompt', 'task_message', 'task_assigned')
           ORDER BY ts, id""",
        (aid, delivered_ts))
    budget = MAX_PROMPT_BATCH_CHARS
    included_ts = delivered_ts
    for r in cur.fetchall():
        pl = r["payload"] or {}
        if r["event_name"] == "task_message":
            ev_task_id = pl.get("task_id")
            preview = pl.get("preview") or ""
            # #338 feed-to-agent: if the posted message carried attachments, name them + their serve
            # paths inline so the agent OPENS the files (not just reads the text). The full refs live
            # on the task_messages row; fetch this specific message's attachments by id.
            feed = ""
            ev_msg_id = pl.get("message_id")
            if ev_msg_id:
                cur.execute("SELECT attachments FROM task_messages WHERE id=%s", (ev_msg_id,))
                mrow = cur.fetchone()
                if mrow:
                    feed = _render_attachment_feed_line(mrow["attachments"])
            # Frame it with the task id so the agent knows WHICH thread to read + answer on; the full
            # body lives in task_messages (the preview is the hook).
            m = (f"[task-thread message on task {ev_task_id}] {preview} "
                 f"— READ that task's thread and RESPOND on it{feed}"
                 if ev_task_id else f"{preview}{feed}")
        elif r["event_name"] == "task_assigned":
            # ISS-86 / #245 (Option C): a `task_assigned` event carries no inbox surface, so a woken
            # worker wouldn't know WHICH task it was assigned — and a create-and-assign task lands
            # `in_progress`, so it is NOT a `ready` auto-start target /orcha-next would list. Surface
            # it as a directed message framed by the task's CURRENT status so the directive is right
            # for both seams (create-and-assign → in_progress; /assign → ready).
            ev_task_id = pl.get("task_id")
            title = pl.get("title") or "(untitled)"
            if ev_task_id:
                cur.execute("SELECT status FROM tasks WHERE id=%s", (ev_task_id,))
                trow = cur.fetchone()
                tstatus = trow["status"] if trow else None
            else:
                tstatus = None
            if not ev_task_id or tstatus in (None, "completed", "cancelled"):
                # No id, or the task was finished/cancelled before this wake → nothing actionable to
                # surface (m stays None; the cursor still advances past it below, so it's acked away).
                m = None
            elif tstatus == "in_progress":
                m = (f"[new task assigned to you: {title} (task {ev_task_id})] "
                     f"— it's already in_progress, so /orcha-next will NOT list it; READ its thread "
                     f"(/api/tasks/{ev_task_id}/messages) and begin the work directly")
            elif tstatus == "ready":
                m = (f"[new task assigned to you: {title} (task {ev_task_id})] "
                     f"— claim it with /orcha-next (or READ its thread "
                     f"/api/tasks/{ev_task_id}/messages) and begin")
            else:  # pending (blocked on deps) or any other live state
                m = (f"[new task assigned to you: {title} (task {ev_task_id})] "
                     f"— it's '{tstatus}'; READ its thread (/api/tasks/{ev_task_id}/messages); "
                     f"it may be waiting on dependencies before it's ready")
        else:
            ev_task_id = None
            m = pl.get("message")
        if m and messages and len(m) > budget:
            # including this would overflow the batch → stop; ack only through the last included
            # event, leaving this message (and later ones) pending for the next wake/drain.
            ack_through_ts = included_ts
            break
        if m:
            messages.append(m)
            budget -= len(m)
            if ev_task_id:
                wake_task_id = ev_task_id            # latest SURFACED task event wins (ISS-56;
                                                     # task_message or task_assigned — ISS-86)
        included_ts = r["ts"]                        # advance past included or blank messages
    return messages, wake_task_id, ack_through_ts


@app.get("/api/containers/{cid}/active-conversations")
def active_conversations(cid: str):
    """E3: the resident-session manager's read-only discovery scan. Every ACTIVE
    conversation in the container with its last-turn {role, seq}, so the daemon can
    find conversations whose latest turn is an unanswered HUMAN turn (`pending_human`)
    — work for the resident to answer.

    Deliberately OFF the wake/ack event cursor for CONVERSATION delivery: the resident
    manager services any conversation whose last turn is human and whose `last_turn_seq`
    exceeds the seq it last serviced (an in-memory per-conversation cursor), so resident
    delivery is idempotent and never contends with the ephemeral headless path's delivered_ts.

    ISS-74: it ALSO reports `pending_inbox` — the count of NON-conversation events queued for
    this conversation's agent past its wake cursor (event_name NOT IN digest_snapshotted /
    conversation_turn / _RESIDENT_DRAIN_AUDIT_EVENTS — see ISS-75) plus `inbox_ack_ts` (the max ts
    of a COUNTED event, to ack after draining). A warm resident
    holds the single-embodiment lease, so the wake gate suppresses every ephemeral wake for its
    agent (decision/task_message/request_* QUEUE). The daemon uses these fields to inject a
    one-shot inbox-drain turn INTO the warm resident so those events are still handled. We
    exclude `conversation_turn` (the resident already handles those via `pending_human`) so this
    never fires on conversation activity and never touches the ephemeral/headless conversation
    fallback (which still wakes on conversation_turn when no resident is live)."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    excl = list(_NON_WAKING_EVENTS) + ["conversation_turn"] + list(_RESIDENT_DRAIN_AUDIT_EVENTS)
    with db_cursor() as (_, cur):
        _require_container(cur, cid)
        cur.execute(
            """SELECT cv.id AS conversation_id, cv.agent_id, a.alias AS agent_alias, a.model,
                      cv.session_id, cv.status, cv.last_turn_at,
                      -- #266: the clock-driven auto-wake inputs, so an idle warm resident can YIELD
                      -- its lease when the cadence is due (the wake then fires ephemeral, never
                      -- injected — ISS-78). Same truth table as wake_scan's auto_wake_due.
                      a.auto_wake_interval_secs, a.turns_used, a.turn_budget,
                      EXTRACT(EPOCH FROM (now() - ws.last_woken_at)) AS _secs_since_woken,
                      -- ISS-70: force a one-shot COLD boot when this agent's latest memory digest is
                      -- NEWER than when the resident's session was pinned (a digest written by another
                      -- embodiment the warm --resume would never re-read). FALSE when no session is
                      -- pinned (the boot is cold anyway via `not session_id`); TRUE for a pinned
                      -- session whose pin predates the digest, or a pre-ISS-70 pin with NULL timestamp
                      -- (re-inject the digest once). Uses idx_digest_agent_ts(agent_id, snapshot_ts).
                      CASE
                        WHEN cv.session_id IS NULL THEN false
                        WHEN cv.session_pinned_at IS NULL THEN true
                        ELSE COALESCE(
                            (SELECT max(d.snapshot_ts) FROM agent_memory_digests d
                              WHERE d.agent_id = cv.agent_id)
                            > extract(epoch FROM cv.session_pinned_at), false)
                      END AS cold_required,
                      t.seq AS last_turn_seq, t.role AS last_turn_role,
                      COALESCE(ws.delivered_ts, 0) AS _delivered_ts,
                      (SELECT max(ev.ts) FROM agent_events ev
                         WHERE ev.event_key = cv.agent_id::text
                           AND ev.ts > COALESCE(ws.delivered_ts, 0)
                           AND ev.event_name = 'conversation_turn') AS conversation_ack_ts,
                      COALESCE((SELECT count(*) FROM agent_events ev
                                 WHERE ev.event_key = cv.agent_id::text
                                   AND ev.ts > COALESCE(ws.delivered_ts, 0)
                                   AND ev.event_name <> ALL(%s)), 0) AS pending_inbox,
                      (SELECT max(ev.ts) FROM agent_events ev
                         WHERE ev.event_key = cv.agent_id::text
                           AND ev.ts > COALESCE(ws.delivered_ts, 0)
                           AND ev.event_name <> ALL(%s)) AS _inbox_max_ts
               FROM conversations cv
               JOIN agents a ON a.id = cv.agent_id
               LEFT JOIN agent_wake_state ws ON ws.agent_id = cv.agent_id
               LEFT JOIN LATERAL (
                   SELECT seq, role FROM conversation_turns
                   WHERE conversation_id = cv.id ORDER BY seq DESC LIMIT 1
               ) t ON true
               WHERE cv.container_id = %s AND cv.status = 'active'
               ORDER BY cv.last_turn_at ASC NULLS FIRST""",
            (excl, excl, cid))
        convs = cur.fetchall()
        for r in convs:
            # last_turn_role is NULL only for a brand-new conversation with no turns yet.
            r["last_turn_seq"] = r["last_turn_seq"] or 0
            r["pending_human"] = (r["last_turn_role"] == "human")
            r["pending_inbox"] = r["pending_inbox"] or 0
            # #266: is a clock-driven auto-wake due for this resident's agent? Identical interlocks to
            # wake_scan — opt-in (interval set) and the cadence has elapsed since the last wake of any
            # kind (NULL last_woken_at => never woken => due). GH #39: the turns_used<turn_budget cost
            # ceiling is removed; turns_used no longer gates wakes.
            # The daemon uses this to idle-yield a warm-but-between-turns resident so the ephemeral clock
            # wake can fire; a mid-turn resident is skipped daemon-side (awaiting_result), never here.
            _auto_iv = r["auto_wake_interval_secs"]
            _ssw = r["_secs_since_woken"]
            r["auto_wake_due"] = bool(
                _auto_iv is not None
                and (_ssw is None or _ssw >= _auto_iv))
            r.pop("turns_used", None)
            r.pop("turn_budget", None)
            r.pop("_secs_since_woken", None)
            # GAP A (resident): the model the daemon spawns this resident with, resolved
            # server-side (retired model → DEFAULT_MODEL). Pairs with GAP B: set_agent_model
            # clears the pinned session_id on a model change so the next boot is COLD and
            # actually picks this up (a warm --resume keeps the old in-session model).
            r["model"] = resolve_model(r["model"])
            r["model_runtime"] = resolve_model_runtime(r["model"])
            # ISS-74 (review fix): `prompt`/`task_message` events carry content with NO inbox surface —
            # they're delivered ONLY by injecting the text. So surface the bounded directed-message
            # batch (same semantics as wake_scan) and ACK ONLY THROUGH the last included one, so a
            # drain can never mark a directed message delivered without its content reaching the agent.
            if r["pending_inbox"]:
                msgs, _tid, ack_ts = _collect_directed_messages(
                    cur, str(r["agent_id"]), r["_delivered_ts"], r["_inbox_max_ts"])
                r["inbox_messages"] = msgs
                r["inbox_ack_ts"] = ack_ts
            else:
                r["inbox_messages"] = []
                r["inbox_ack_ts"] = None
            r.pop("_delivered_ts", None)
            r.pop("_inbox_max_ts", None)
    return {"container_id": cid, "conversations": convs}


@app.get("/api/agents/{aid}/persona")
def get_persona(aid: str):
    """Epic A: an agent's defining system prompt + role, for the notifier to inject
    into a headless `claude -p` wake (`--append-system-prompt`) so the spawned worker
    boots AS that agent — its persona/judgment, not a generic Claude. Pairs with
    GET /digest (Epic C) which carries the reasoning continuity. Not in the snapshot
    on purpose (the prompt can be large; only the daemon needs it)."""
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (_, cur):
        cur.execute("SELECT alias, role, kind, model, system_prompt FROM agents WHERE id=%s", (aid,))
        row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"agent {aid} not found")
    # GAP A (#136/ISS-58 — THIRD spawn surface): the live terminal path (`orcha use` →
    # _exec_live_session) boots `claude` AS the agent and consumes /persona on a COLD boot, so
    # surface the model here too — resolved server-side (retired/unknown → DEFAULT_MODEL) exactly
    # like the wake-scan + resident-discovery candidates. The CLI can't import resolve_model
    # (server-only), so it must arrive already-resolved. Humans carry no model → None (no --model).
    model = resolve_model(row["model"]) if row["kind"] != "human" else None
    model_runtime = resolve_model_runtime(model) if model else None
    return {"agent_id": aid, "alias": row["alias"], "role": row["role"],
            "kind": row["kind"], "model": model, "model_runtime": model_runtime,
            "system_prompt": row["system_prompt"]}


@app.get("/api/agents/{aid}/protocol")
def get_agent_protocol(aid: str, task_id: Optional[str] = None):
    """#326 (A1): the RULES the waking agent must read FRESH every wake — the protocol of its
    currently in_progress task (SPEC-4 per-task working agreement: review_chain / handoff_to /
    autonomy / notes), human-authored and human-edit-only (PATCH /api/tasks/{tid}/protocol).

    The continuity fix: the protocol is the durable, human-editable rule surface (the queue is the
    ready task rows — see #326). Unlike the digest (compressed, agent-authored, carries WHAT it
    knew), this is read ahead of / independent of the digest so a human edit takes effect on the
    very next wake. The notifier (format_persona) injects it above the digest on every wake.

    GH #56 (Point 3, FLAG 2a part d): an explicit `task_id` hint — the originating_task_id the
    wake is consuming an answer ON BEHALF OF (notifier reads it off the request_answered event and
    threads it through) — keys the protocol load off the STORED LINK instead of the fragile "one
    in_progress task" guess. That guess serves the WRONG protocol to an agent juggling several
    in-progress tasks; the link removes that risk. The hint is honored only when the agent actually
    participates in that task (looser participant check), so a stale/foreign id can never leak a
    protocol; otherwise we fall back to the in_progress guess.

    GH #33: the resolved task's FULL body rides here too — title AND description AND
    definition_of_done — so EVERY wake that resolves a task (the request-answer originating-link
    path and the in-progress direct-assignment path both flow through this endpoint) surfaces the
    complete spec, not just the title. The body is returned whenever a task resolves, independent
    of whether a protocol is set; `protocol` is null when no working agreement exists.

    Returns {task_id, title, description, definition_of_done, protocol} for the resolved task, or
    {task_id: null, protocol: null} when none resolves — so a cold/idle wake carries neither a body
    nor a protocol section."""
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (_, cur):
        agent = _require_agent(cur, aid)
        row = None
        # GH #56: prefer the explicit originating-task link when supplied AND the agent participates
        # in it (so a wrong/foreign id can never serve someone else's protocol). Falls through to the
        # in_progress guess on a null/invalid/non-participating hint.
        if task_id and _valid_uuid(task_id) and _agent_participates_in_task(
                cur, str(agent["container_id"]), aid, task_id):
            cur.execute(
                "SELECT id, title, description, definition_of_done, protocol "
                "FROM tasks WHERE id=%s AND is_root=false", (task_id,))
            row = cur.fetchone()
        if row is None:
            cur.execute(
                """SELECT t.id, t.title, t.description, t.definition_of_done, t.protocol
                   FROM tasks t
                   JOIN agent_tasks at ON at.task_id = t.id
                   WHERE at.agent_id=%s AND at.assignment_status IN ('assigned','accepted','working')
                     AND t.status='in_progress' AND t.is_root = false
                   ORDER BY t.started_at DESC NULLS LAST, t.created_at DESC
                   LIMIT 1""",
                (aid,),
            )
            row = cur.fetchone()
    if not row:
        return {"task_id": None, "protocol": None}
    # GH #33: body rides whenever a task resolves; protocol stays independent (null when unset).
    return {"task_id": str(row["id"]), "title": row["title"],
            "description": row["description"], "definition_of_done": row["definition_of_done"],
            "protocol": row["protocol"] or None}


class WakeAck(BaseModel):
    """Notifier daemon acknowledges that it issued (or attempted) a wake."""
    delivered_ts: Optional[float] = Field(
        default=None,
        description="advance the agent's wake cursor to this agent_events.ts (omit if no events consumed)")
    kind: str = Field(..., description="tmux | ephemeral | resident | unreachable | skipped (or a *_killed/*_failed/released reason)")
    event: Optional[str] = Field(default=None, max_length=MAX_NAME_LEN,
                                 description="the event_name / reason that triggered the wake")
    release_lease: bool = Field(
        default=False,
        description="R2.4: a one-shot worker that has finished draining sets this on its final "
                    "ack to release its single-flight lease immediately (snappy continuity). The "
                    "daemon's post-spawn ack leaves it false; the lease TTL is the crash-safe net.")
    stamp_woken: bool = Field(
        default=True,
        description="#266: whether this ack counts as a WAKE (stamps last_woken_at=now(), resetting "
                    "the cooldown + the clock-driven auto-wake cadence). Default true for every real "
                    "wake/finish. The auto-wake idle-yield sets it FALSE so a resident that merely "
                    "steps aside to let the ephemeral clock-wake fire does NOT reset secs_since_woken "
                    "out from under its own auto_wake_due (the real ephemeral wake stamps it instead).")


class PromptEvent(BaseModel):
    """A3: a directed human/teammate message that wakes an agent. Posting one publishes a
    `prompt` agent_event carrying the text; wake-scan counts it as pending work and the daemon
    surfaces the message in the woken worker's context. Keystone for B2 (prompt-from-portal)
    and B12 (poke / reject-loop)."""
    message: str = Field(..., min_length=1, max_length=MAX_PAYLOAD_LEN,
                         description="the directed message the woken agent should act on")
    from_agent_id: Optional[str] = Field(
        default=None, description="UUID of the sender (a human or agent); omitted for system pokes")


class WakeClaim(BaseModel):
    """R2.4: the daemon's atomic single-flight claim before spawning a headless worker."""
    lease_ttl: float = Field(
        default=300.0, ge=1, le=3600,
        description="seconds the lease is held; the worker should finish well within this, and the "
                    "TTL auto-expires it on crash so the agent is never stuck unwakeable")
    kind: str = Field(default="ephemeral", description="transport about to be used: ephemeral | tmux | resident | live")
    event: Optional[str] = Field(default=None, max_length=MAX_NAME_LEN,
                                 description="the event_name / reason driving this wake")
    lease_kind: str = Field(default="ephemeral", pattern="^(ephemeral|resident|live)$",
                            description="E1/§3b: embodiment holding the lease — 'ephemeral' (a one-shot "
                                        "`claude -p` wake), 'resident' (a background warm conversation "
                                        "session, also headless), or 'live' (a human interactively driving "
                                        "an embedded terminal AS the agent via `orcha use`). All three share "
                                        "the one single-flight lease, so one excludes the others "
                                        "(one-embodiment-per-agent).")
    preempt: bool = Field(
        default=False,
        description="ISS-69(b): if the claim is DENIED because an IDLE warm RESIDENT holds the lease, "
                    "record a yield request on the held row instead of just refusing. The daemon reads "
                    "it back on its next wake-renew and gracefully yields the idle resident (snapshot + "
                    "release) so this claim can win on retry. No effect when the holder is ephemeral or "
                    "another live terminal (those stay 4409).")


@app.get("/api/containers/{cid}/wake-scan")
def wake_scan(cid: str, cooldown: float = Query(default=15.0, ge=0),
              min_idle: float = Query(default=30.0, ge=0)):
    """Epic A: the notifier daemon's read-only scan — who needs an out-of-band wake.

    The wake DECISION lives here (server-side, single source of truth, testable via
    the API), so the host-side daemon stays a thin transport executor and the
    design invariant 'only the API touches the DB' holds. For every AI agent it
    reports pending unacked events, assigned-and-ready tasks (auto-start targets),
    reachability, and a `should_wake` verdict with the inputs behind it.

    should_wake = wake_enabled AND container active AND (pending events OR an
    assigned ready task OR a clock-driven auto-wake is due) AND the agent looks idle
    (heartbeat older than `min_idle`, or never beat) AND it isn't inside the per-agent
    `cooldown` window. Wakes are fully suppressed while the container is paused
    (respects /orcha-pause). #266: the auto-wake term is per-agent opt-in
    (auto_wake_interval_secs, NULL=off) and fires off the last_woken_at clock — see the
    auto_wake_due computation below. (GH#39 removed the turns_used<turn_budget gate.)
    """
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        c = _require_container(cur, cid)
        active = c["status"] == "active"
        # R2.4: global wake kill-switch — one surgical switch to stop ALL wakes.
        cur.execute("SELECT wakes_enabled, autonomy_level FROM containers WHERE id=%s", (cid,))
        _wrow = cur.fetchone()
        wakes_enabled = bool(_wrow["wakes_enabled"])
        # #307 graded-wake T2: the container autonomy_level gates whether the daemon may
        # AUTO-COMPLETE a routine handoff on the cheap substrate ('full' only). At 'plan'/'pr'
        # (the default) the daemon LOGS the would-be T2 (for the #284 token measurement) and still
        # full-boots — zero behaviour change until a human opts the container into full autonomy.
        autonomy_level = _wrow["autonomy_level"]
        # #294: the per-container 'triage' model override (None = use #290's shipped default).
        # Surfaced once per scan so the notifier's #288 wake-suppression triage uses the configured
        # model instead of the hardcoded Haiku — the EFFICIENCY hook (tune what a wake costs). The
        # notifier passes this straight to llm_util.triage_wake(config={"triage": ...}); the read
        # is advisory and fails open to the default everywhere downstream.
        triage_model = _resolve_use_case_model(cur, cid, "triage")
        # #307 graded-wake T2: the per-container 'ack' model override (None = #290 default Haiku),
        # surfaced so the daemon composes a routine-handoff acknowledgement on the configured cheap
        # model — symmetric with triage_model, same advisory/fail-open posture downstream.
        ack_model = _resolve_use_case_model(cur, cid, "ack")
        # The SEALED stored key for whichever provider triage/ack actually run on (override else the
        # #290 default). Ciphertext only — the daemon unseals it locally with the shared
        # ORCHA_SECRET_KEY, so a Settings-stored xAI key reaches the wake paths with no plaintext on
        # the wire. None when no key is stored (the daemon then falls back to its env keys).
        triage_key_enc = _provider_key_enc(cur, cid, _effective_use_case_provider(triage_model, "triage"))
        ack_key_enc = _provider_key_enc(cur, cid, _effective_use_case_provider(ack_model, "ack"))
        cur.execute(
            """SELECT a.id, a.alias, a.model, a.last_heartbeat_at, a.turns_used, a.turn_budget,
                      a.auto_wake_interval_secs,
                      COALESCE(r.wake_enabled, true) AS wake_enabled,
                      r.tmux_target, r.headless_cwd, r.headless_flags,
                      COALESCE(w.delivered_ts, 0)    AS delivered_ts,
                      w.last_woken_at,
                      EXTRACT(EPOCH FROM (now() - a.last_heartbeat_at)) AS idle_seconds,
                      -- #266: seconds since the clock anchor (NULL if never woken) — drives the
                      -- auto_wake_due term below. Reuses last_woken_at (stamped on every wake-ack)
                      -- so the cadence floats forward off the LAST wake of any kind, never overlapping
                      -- a real event/task wake.
                      EXTRACT(EPOCH FROM (now() - w.last_woken_at)) AS secs_since_woken,
                      (w.last_woken_at IS NOT NULL
                       AND EXTRACT(EPOCH FROM (now() - w.last_woken_at)) < %s) AS in_cooldown,
                      -- R2.4: a live worker holds an unexpired lease; skip those.
                      (w.wake_lease_until IS NOT NULL AND w.wake_lease_until > now()) AS lease_active,
                      -- E1 (review P2): only project the embodiment for a LIVE lease. Expiry is the
                      -- crash/orphan recovery path and doesn't clear the row, so a raw w.lease_kind
                      -- would report a stale 'resident' after the lease lapsed (lease_active=false,
                      -- should_wake=true) — violating the NULL-when-no-lease contract.
                      CASE WHEN w.wake_lease_until IS NOT NULL AND w.wake_lease_until > now()
                           THEN w.lease_kind ELSE NULL END AS lease_kind,
                      -- #247 B2: the AUTHORITATIVE anything-live? signal. lease_active alone is
                      -- lease-only and cannot close the orphan hole §3.2 names: orcha-upgrade kills
                      -- the owning daemon, its resident child survives 'running', the lease LAPSES
                      -- with no renewer (lease_active=false) and the lease-only gate flips should_wake
                      -- TRUE → an ephemeral spawns ALONGSIDE the live orphan = double embodiment
                      -- (finding-orcha-update-midflight-orphans-workers). worker_runs.status='running'
                      -- is the one signal the orphan still carries, so gate on it too. A genuinely
                      -- DEAD orphan is reaped to 'orphaned' by the dead-PID reaper, clearing this.
                      EXISTS (SELECT 1 FROM worker_runs wr
                              WHERE wr.agent_id = a.id AND wr.status = 'running') AS embodiment_running
               FROM agents a
               LEFT JOIN agent_reachability r ON r.agent_id = a.id
               LEFT JOIN agent_wake_state   w ON w.agent_id = a.id
               WHERE a.container_id = %s AND a.kind = 'ai' AND a.terminated_at IS NULL
               ORDER BY a.created_at""",
            (cooldown, cid),
        )
        agents = cur.fetchall()

        candidates = []
        for a in agents:
            aid = str(a["id"])
            # ISS-58: the should_wake `pending` count excludes _NON_WAKING_EVENTS (self-echo
            # notifications like digest_snapshotted) so they never wake the agent — but max_ts is
            # over ALL events so the ack still advances past them (they don't accumulate uncounted).
            cur.execute(
                """SELECT count(*) FILTER (WHERE event_name <> ALL(%s)) AS n,
                          max(ts) AS max_ts
                   FROM agent_events WHERE event_key = %s AND ts > %s""",
                (list(_NON_WAKING_EVENTS), aid, a["delivered_ts"]),
            )
            ev = cur.fetchone()
            pending = ev["n"] or 0
            max_ts = ev["max_ts"]
            latest = None
            latest_payload = None
            if pending:
                cur.execute(
                    """SELECT event_name, payload FROM agent_events
                       WHERE event_key = %s AND ts > %s AND event_name <> ALL(%s)
                       ORDER BY ts DESC, id DESC LIMIT 1""",
                    (aid, a["delivered_ts"], list(_NON_WAKING_EVENTS)),
                )
                _latest_row = cur.fetchone()
                latest = _latest_row["event_name"]
                latest_payload = _latest_row["payload"]
            # Pending directed messages — surfaced (oldest-first) to the woken worker via
            # build_wake_prompt so it acts on them, not just "drain the inbox". `prompt` and
            # `task_message` carry content with NO inbox surface (surfacing is the ONLY delivery
            # path), so the cursor is acked only THROUGH the last included one. Shared with the
            # resident inbox-drain path (ISS-74) via _collect_directed_messages — identical semantics.
            if pending:
                prompt_messages, wake_task_id, ack_through_ts = _collect_directed_messages(
                    cur, aid, a["delivered_ts"], max_ts)
                notifications, notifications_truncated = _wake_notification_manifest(
                    cur, aid, a["delivered_ts"])
                # GH #56 (Point 3 / FLAG 2a part b): if no directed-message task claimed the wake,
                # attach it to the originating task of the newest pending answer. A `request_answered`
                # event (the requester's own ask coming back) carries `originating_task_id` — the task
                # the requester was working on when it asked (respond_request / the Point 5 backstop
                # both stamp it). Surfacing it as wake_task_id makes run-attribution stamp the run
                # against THAT task (activity shows on its thread) and lets the protocol load key off
                # the link. Null/taskless asks (originating_task_id absent) leave wake_task_id None —
                # unchanged behaviour. Only set when the linked task is still live (not deleted).
                if wake_task_id is None:
                    cur.execute(
                        """SELECT payload FROM agent_events
                           WHERE event_key=%s AND ts > %s AND event_name='request_answered'
                             AND payload->>'originating_task_id' IS NOT NULL
                           ORDER BY ts DESC, id DESC LIMIT 1""",
                        (aid, a["delivered_ts"]),
                    )
                    _ans = cur.fetchone()
                    if _ans:
                        _otid = (_ans["payload"] or {}).get("originating_task_id")
                        if _otid:
                            cur.execute("SELECT 1 FROM tasks WHERE id=%s", (_otid,))
                            if cur.fetchone():
                                wake_task_id = _otid
            else:
                prompt_messages, wake_task_id, ack_through_ts = [], None, max_ts
                notifications, notifications_truncated = [], False
            # Assigned-and-ready tasks = auto-start targets (deps cleared, awaiting
            # the owner to claim+begin). Root is excluded — only the human verifies it.
            # Order by priority, created_at so auto_start_task_ids[0] (what the notifier attributes
            # the run to) is the SAME task /orcha-next claims first — keeps run attribution exact
            # for the B5/O4 assign-then-wake path. [review P1]
            cur.execute(
                """SELECT t.id FROM tasks t
                   JOIN agent_tasks at ON at.task_id = t.id AND at.agent_id = %s
                   WHERE t.container_id = %s AND t.status = 'ready' AND t.is_root = false
                   ORDER BY t.priority, t.created_at""",
                (aid, cid),
            )
            auto_tasks = [str(r["id"]) for r in cur.fetchall()]

            idle_seconds = a["idle_seconds"]
            is_idle = (idle_seconds is None) or (idle_seconds >= min_idle)
            # #266: clock-driven auto-wake — a recurring heartbeat poll, due when the interval has
            # elapsed since the last wake of ANY kind (last_woken_at, NULL=never => due immediately).
            # Two interlocks, ALL reusing existing state (no parallel counter): (1) opt-in only
            # (interval IS NOT NULL); (2) it's only ONE more OR-term into has_work, so it adds a wake
            # reason only when there's otherwise nothing pending, and last_woken_at resets on every
            # wake-ack so a busy agent is never also clock-woken. lease/idle/cooldown gates below apply
            # unchanged (the 60s floor >> 15s cooldown / 30s min_idle => never conflicts).
            # GH #39: the turns_used<turn_budget cost ceiling that previously gated clock wakes is removed.
            auto_interval = a["auto_wake_interval_secs"]
            secs_since_woken = a["secs_since_woken"]
            auto_wake_due = bool(
                auto_interval is not None
                and (secs_since_woken is None or secs_since_woken >= auto_interval))
            has_work = pending > 0 or len(auto_tasks) > 0 or auto_wake_due
            wake_enabled = a["wake_enabled"]
            in_cooldown = bool(a["in_cooldown"])
            lease_active = bool(a["lease_active"])   # R2.4: a worker is already live
            lease_kind = a["lease_kind"]             # E1: 'ephemeral' | 'resident' | None
            # #247 B2: anything-live? is the real single-embodiment guard, not is-resident-due?.
            # A lapsed-lease orphan whose worker_run is still 'running' must suppress the wake too.
            embodiment_running = bool(a["embodiment_running"])
            should_wake = bool(active and wakes_enabled and wake_enabled and has_work
                               and is_idle and not in_cooldown and not lease_active
                               and not embodiment_running)

            if not active:
                reason = f"container {c['status']} — wakes suppressed"
            elif not wakes_enabled:
                reason = "global wake kill-switch is OFF (wakes_enabled=false)"
            elif not wake_enabled:
                reason = "wake disabled (opt-out)"
            elif lease_active:
                # §3b: a 'live' terminal embodiment suppresses ephemeral wakes the same way a
                # resident does (single-embodiment); events stay pending and QUEUE until release.
                reason = ({"resident": "a resident session is live (single-embodiment)",
                           "live": "a live terminal session is held (single-embodiment) — events queue"}
                          .get(lease_kind, "a worker is already live (single-flight lease held)"))
            elif embodiment_running:
                # #247 B2: the lease lapsed (lease_active=false) but a worker_run is still 'running' —
                # a daemon-kill orphan. Suppress the ephemeral wake so it never spawns alongside the
                # live orphan (single-embodiment); the dead-PID reaper clears a genuinely dead one.
                reason = "an embodiment is still running (single-embodiment) — lapsed-lease orphan"
            elif not has_work:
                reason = "no pending events or ready tasks"
            elif not is_idle:
                reason = f"agent active (idle {idle_seconds:.0f}s < {min_idle:.0f}s)"
            elif in_cooldown:
                reason = "within cooldown window"
            else:
                bits = []
                if pending:
                    top = notifications[0] if notifications else None
                    if top:
                        bits.append(
                            f"{pending} event(s) (top=rank-{top['rank']} {top['type']}, latest={latest})")
                    else:
                        bits.append(f"{pending} event(s) (latest={latest})")
                if auto_tasks:
                    bits.append(f"{len(auto_tasks)} assigned ready task(s)")
                if auto_wake_due:
                    bits.append(f"scheduled auto-wake (every {auto_interval}s)")
                reason = "wake: " + ", ".join(bits)

            # #288 wake-suppression: attach a triage_hint ONLY when the agent's SOLE pending signal
            # is a single FYI/answer event — no ready task, no directed message, exactly one event.
            # That narrowness is the safety bar: anything else (task work, a directed prompt, a
            # multi-event backlog that might hide actionable work) carries NO hint and always wakes.
            # The notifier reads the hint and decides (failing open); the server never suppresses.
            triage_hint = None
            if (should_wake and pending == 1 and not auto_tasks
                    and not wake_task_id and not prompt_messages and latest):
                full_answer = None
                if latest == "request_answered" and (latest_payload or {}).get("request_id"):
                    cur.execute("SELECT response FROM requests WHERE id=%s",
                                ((latest_payload or {})["request_id"],))
                    _rr = cur.fetchone()
                    if _rr:
                        full_answer = _rr["response"]
                triage_hint = _triage_hint_for(latest, latest_payload, full_answer=full_answer)

            candidates.append({
                "agent_id": aid, "alias": a["alias"], "should_wake": should_wake,
                "reason": reason, "pending_events": pending, "latest_event": latest,
                "prompt_messages": prompt_messages, "wake_task_id": wake_task_id,
                "notifications": notifications, "notifications_truncated": notifications_truncated,
                "max_event_ts": max_ts, "ack_through_ts": ack_through_ts,
                "auto_start_task_ids": auto_tasks,
                # #266: surface the scheduled-wake verdict + the configured cadence so the notifier
                # can label the wake 'auto_wake' and build a heartbeat prompt, and the portal/debug
                # can show why an idle agent is being woken on a clock.
                "auto_wake_due": auto_wake_due, "auto_wake_interval_secs": auto_interval,
                # #288: the wake-suppression hint (None unless the sole pending signal is a single
                # FYI/answer event). The notifier daemon makes the final call and fails open.
                "triage_hint": triage_hint,
                "wake_enabled": wake_enabled, "in_cooldown": in_cooldown,
                "lease_active": lease_active, "lease_kind": lease_kind,
                # #247 B2: the authoritative live-embodiment signal (a 'running' worker_run), exposed
                # so the portal/debug can see an orphan suppressing a wake even after its lease lapsed.
                "embodiment_running": embodiment_running,
                "idle_seconds": idle_seconds,
                "tmux_target": a["tmux_target"], "headless_cwd": a["headless_cwd"],
                "headless_flags": a["headless_flags"],
                # GAP A: the model the daemon must spawn this worker with (`--model`). Resolved
                # server-side so a retired limited-availability model (e.g. Fable 5 after 2026-06-22)
                # auto-falls-back to the default and never reaches the spawn argv as an invalid id.
                "model": resolve_model(a["model"]),
                "model_runtime": resolve_model_runtime(a["model"]),
            })
    return {"container_id": cid, "container_status": c["status"],
            "active": active, "wakes_enabled": wakes_enabled,
            # #307 graded-wake: the container autonomy gate for T2 cheap-act auto-completion
            # ('full' => act; otherwise log-only + full boot). Advisory; the daemon fails open.
            "autonomy_level": autonomy_level,
            # #294: the configured 'triage' model for #288 wake-suppression (null = #290 default).
            "triage_model": triage_model,
            # The SEALED key blob for the triage/ack provider (ciphertext; null if none stored).
            # The daemon unseals locally — Settings-stored provider keys reach the wake paths.
            "triage_key_enc": triage_key_enc, "ack_key_enc": ack_key_enc,
            # #307: the configured 'ack' model for T2 cheap-act (null = #290 default Haiku).
            "ack_model": ack_model, "candidates": candidates}


@app.post("/api/agents/{aid}/wake-ack", status_code=200)
def wake_ack(aid: str, body: WakeAck):
    """Notifier daemon records that it woke (or tried to wake) this agent.

    Advances the per-agent wake cursor (so the same events don't re-trigger) and
    stamps last_woken_at for the cooldown debounce — both surviving daemon/stopgap
    restarts. Writes a `woken` audit row to events for portal visibility.
    """
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        ag = _require_agent(cur, aid)
        cur.execute(
            """INSERT INTO agent_wake_state
                 (agent_id, delivered_ts, last_woken_at, last_wake_kind, last_wake_event,
                  wake_lease_until)
               VALUES (%s, COALESCE(%s, 0), CASE WHEN %s THEN now() ELSE NULL END, %s, %s, NULL)
               ON CONFLICT (agent_id) DO UPDATE SET
                 -- never move the cursor backwards; only advance when given a newer ts
                 delivered_ts    = GREATEST(agent_wake_state.delivered_ts,
                                            COALESCE(EXCLUDED.delivered_ts, agent_wake_state.delivered_ts)),
                 -- #266: stamp_woken=false (the auto-wake idle-yield) PRESERVES the prior clock so the
                 -- ephemeral wake it's stepping aside for still reads auto_wake_due; every other ack stamps.
                 last_woken_at   = CASE WHEN %s THEN now() ELSE agent_wake_state.last_woken_at END,
                 last_wake_kind  = EXCLUDED.last_wake_kind,
                 last_wake_event = EXCLUDED.last_wake_event,
                 -- R2.4: a finished one-shot worker releases its lease; otherwise leave it
                 -- intact so the TTL still guards against a concurrent spawn.
                 wake_lease_until = CASE WHEN %s THEN NULL
                                         ELSE agent_wake_state.wake_lease_until END,
                 -- E1: clear the embodiment label when the lease is released, so a released
                 -- agent shows no embodiment (NULL) rather than a stale 'ephemeral'/'resident'.
                 lease_kind       = CASE WHEN %s THEN NULL
                                         ELSE agent_wake_state.lease_kind END,
                 -- ISS-69(b): releasing the lease (e.g. an idle resident yielding to a terminal)
                 -- also clears any pending yield request — it has been satisfied, so the next holder
                 -- never inherits a stale flag.
                 preempt_requested_at = CASE WHEN %s THEN NULL
                                             ELSE agent_wake_state.preempt_requested_at END,
                 preempt_for          = CASE WHEN %s THEN NULL
                                             ELSE agent_wake_state.preempt_for END
               RETURNING delivered_ts, last_woken_at, last_wake_kind, last_wake_event,
                         wake_lease_until, lease_kind""",
            (aid, body.delivered_ts, body.stamp_woken, body.kind, body.event, body.stamp_woken,
             body.release_lease, body.release_lease,
             body.release_lease, body.release_lease),
        )
        row = cur.fetchone()
        # ISS-stranded (e4b77f3f): durable reconciliation backstop. Enforce the invariant
        # "lease released => no 'running' worker_runs for this agent". The happy paths
        # _finish_run('exited'|'killed') BEFORE this ack, so any row still 'running' here is a
        # genuine orphan — a run whose run_id never reached the daemon's current_run_id (a send
        # that failed after the row was POSTed, pre send-first fix) or was stranded by daemon
        # turnover. worker_runs.status is free TEXT (no CHECK), so 'orphaned' needs no migration.
        if body.release_lease:
            cur.execute(
                """UPDATE worker_runs SET status='orphaned', ended_at=now()
                   WHERE agent_id=%s AND status='running'
                   RETURNING run_id""",
                (aid,))
            reconciled = [str(rr["run_id"]) for rr in cur.fetchall()]
            if reconciled:
                log_event(cur, str(ag["container_id"]), "system", None, "agent", aid,
                          "worker_runs_reconciled",
                          {"reconciled": reconciled, "to_status": "orphaned",
                           "trigger": "lease_release"})
        log_event(cur, str(ag["container_id"]), "system", None, "agent", aid, "woken",
                  {"kind": body.kind, "event": body.event, "delivered_ts": body.delivered_ts,
                   "release_lease": body.release_lease})
        conn.commit()
    return {"agent_id": aid, **row}


@app.post("/api/agents/{aid}/wake-claim", status_code=200)
def wake_claim(aid: str, body: WakeClaim):
    """R2.4: atomic single-flight claim — the daemon MUST win this before spawning a worker.

    The runaway happened because nothing stopped the daemon from spawning a second
    (third, twelfth) headless worker for an agent that already had one live. This
    endpoint hands out an exclusive, TTL-bounded lease per agent: the conditional
    UPDATE only succeeds when no unexpired lease exists, so concurrent/rapid scans
    serialize to exactly one winner. The loser gets {claimed: false} and does NOT
    spawn. The lease auto-expires after lease_ttl (crash-safe: a dead worker never
    wedges the agent), and a clean worker exit releases it early via wake-ack.

    Also the enforcement point for the global kill-switch: if containers.wakes_enabled
    is false the claim is refused outright, so flipping one flag halts all spawning.
    """
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        ag = _require_agent(cur, aid)
        cur.execute("SELECT status, wakes_enabled FROM containers WHERE id=%s",
                    (ag["container_id"],))
        c = cur.fetchone()
        if c["status"] != "active":
            return {"agent_id": aid, "claimed": False,
                    "reason": f"container {c['status']} — wakes suppressed"}
        if not c["wakes_enabled"]:
            return {"agent_id": aid, "claimed": False,
                    "reason": "global wake kill-switch is OFF (wakes_enabled=false)"}
        # Per-agent opt-out: wake-scan honors agent_reachability.wake_enabled, but since
        # the claim is the actual spawn gate, it must re-check it too — otherwise a user
        # disabling wakes in the window between scan and claim would still get a worker.
        cur.execute("SELECT wake_enabled FROM agent_reachability WHERE agent_id=%s", (aid,))
        rr = cur.fetchone()
        if rr is not None and rr["wake_enabled"] is False:
            return {"agent_id": aid, "claimed": False,
                    "reason": "wake disabled for this agent (opt-out)"}
        # Conditional single-flight: insert-or-claim only when no live lease exists.
        cur.execute(
            """INSERT INTO agent_wake_state (agent_id, wake_lease_until, last_woken_at, lease_kind)
               VALUES (%s, now() + make_interval(secs => %s), now(), %s)
               ON CONFLICT (agent_id) DO UPDATE SET
                 wake_lease_until = now() + make_interval(secs => %s),
                 last_woken_at    = now(),
                 lease_kind       = EXCLUDED.lease_kind,
                 -- ISS-69(b): a fresh claim clears any stale yield request (the prior holder
                 -- yielded and this is the new embodiment — no pending preempt should linger).
                 preempt_requested_at = NULL,
                 preempt_for          = NULL
               WHERE (agent_wake_state.wake_lease_until IS NULL
                      OR agent_wake_state.wake_lease_until < now())
                 -- #247 B2: atomic anything-live? belt. Even with a lapsed/absent lease, refuse the
                 -- claim while a worker_run is still 'running' (daemon-kill orphan whose lease lapsed
                 -- with no renewer) — closes the orphan double-spawn hole server-side, in the SAME
                 -- conditional that already serializes concurrent claims. The OR above is parenthesized
                 -- so this AND also guards the NULL-lease branch (AND binds tighter than OR).
                 AND NOT EXISTS (SELECT 1 FROM worker_runs wr
                                 WHERE wr.agent_id = agent_wake_state.agent_id
                                   AND wr.status = 'running')
               RETURNING wake_lease_until, lease_kind""",
            (aid, body.lease_ttl, body.lease_kind, body.lease_ttl),
        )
        row = cur.fetchone()
        if row is None:
            # Conflict + WHERE false → a live lease is held (single-flight / single-embodiment).
            conn.rollback()
            cur.execute("SELECT wake_lease_until, lease_kind FROM agent_wake_state WHERE agent_id=%s", (aid,))
            held = cur.fetchone()
            held_kind = held["lease_kind"] if held else None
            # ISS-69(b): a live-terminal claim (preempt=1) blocked by an IDLE warm RESIDENT records a
            # YIELD REQUEST rather than just refusing. The daemon (notifier.service_residents) reads it
            # back on its next wake-renew and, only if the resident isn't mid-turn, snapshots + releases
            # the lease so this claim wins on retry. Only a RESIDENT yields: an ephemeral wake or another
            # live terminal stays a hard 4409 (preempt has no effect on those). The deferred (mid-turn)
            # case is automatic — the flag persists, so the next idle daemon tick yields.
            # GATE on the REQUESTING kind too (review [blocking]): ISS-69(b) is scoped to the HUMAN
            # terminal "Pair anyway" path, so ONLY a live-terminal claim may preempt. An autonomous
            # ephemeral wake with preempt=true must NOT evict a warm resident — it stays a normal 4409.
            if body.preempt and body.lease_kind == "live" and held_kind == "resident":
                cur.execute(
                    """UPDATE agent_wake_state
                          SET preempt_requested_at = now(), preempt_for = %s
                        WHERE agent_id = %s AND lease_kind = 'resident'""",
                    (body.lease_kind, aid))
                log_event(cur, str(ag["container_id"]), "system", None, "agent", aid,
                          "wake_preempt_requested", {"by": body.lease_kind, "holder": held_kind})
                conn.commit()
                return {"agent_id": aid, "claimed": False, "reason": "yield_pending",
                        "lease_kind": held_kind, "preempt_requested": True,
                        "wake_lease_until": held["wake_lease_until"].isoformat() if held and held["wake_lease_until"] else None}
            reason = ({"resident": "a resident session is live (single-embodiment)",
                       "live": "a live terminal session is held (single-embodiment)"}
                      .get(held_kind, "a worker is already live (single-flight lease held)"))
            return {"agent_id": aid, "claimed": False, "reason": reason, "lease_kind": held_kind,
                    "wake_lease_until": held["wake_lease_until"].isoformat() if held and held["wake_lease_until"] else None}
        log_event(cur, str(ag["container_id"]), "system", None, "agent", aid, "wake_claimed",
                  {"kind": body.kind, "event": body.event, "lease_ttl": body.lease_ttl,
                   "lease_kind": body.lease_kind})
        conn.commit()
    resp = {"agent_id": aid, "claimed": True, "lease_kind": row["lease_kind"],
            "wake_lease_until": row["wake_lease_until"].isoformat()}
    # §3b live embodiment: the PTY bridge needs to know whether to COLD-boot (Vault injects
    # persona+digest+history into `orcha use`) or RESUME a pinned session. R1 is COLD-ONLY
    # (a fresh interactive session each open) — a PTY has no stream-json log to capture the
    # new session_id from, so warm `claude --resume` is a deferred follow-up. Surfacing the
    # signal now keeps the bridge/Vault contract stable across that follow-up.
    if body.lease_kind == "live":
        resp["cold"] = True
        resp["session_id"] = None
    return resp


@app.post("/api/agents/{aid}/wake-renew", status_code=200)
def wake_renew(aid: str, body: WakeClaim):
    """Wake-latency fix: extend a live worker's single-flight lease (heartbeat).

    The daemon claims a SHORT lease (so a crashed/orphaned worker's lease expires fast and
    never starves a fresh high-priority event for minutes), then renews it every tick while
    its worker is genuinely alive. This keeps single-flight for a legitimately long-running
    worker WITHOUT tying the lease to the 1200s watchdog hard-cap. Only extends a LIVE lease —
    never creates one and never revives a RELEASED (NULL, after a clean worker exit) or EXPIRED
    lease (which would re-block wakes for an agent no worker owns, defeating the fast-expiry
    behavior). So a renew that races a release/expiry is a no-op. Idempotent."""
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_agent(cur, aid)
        cur.execute(
            """UPDATE agent_wake_state
               SET wake_lease_until = now() + make_interval(secs => %s)
               WHERE agent_id = %s
                 AND wake_lease_until IS NOT NULL
                 AND wake_lease_until > now()
               RETURNING wake_lease_until, lease_kind, preempt_requested_at""",
            (body.lease_ttl, aid),
        )
        row = cur.fetchone()
        if row is not None:
            # ISS-60(B) liveness ping: a SUCCESSFUL renew is the daemon's per-tick proof that this
            # embodiment's process is genuinely alive (reap_workers / service_residents / the live
            # terminal bridge all renew only while their process lives). Bump last_heartbeat_at here
            # so the orphan-lease reaper can trust heartbeat staleness as death — an alive-but-quiet
            # resident (whose ONLY signal is this keep-alive) keeps a fresh heartbeat and is never
            # false-orphaned. A renew that races a release/expiry returns None and does NOT bump.
            cur.execute("UPDATE agents SET last_heartbeat_at = now() WHERE id = %s", (aid,))
        # #240/ISS-72: surface a pending human STOP on this SAME per-tick renew (zero new poll).
        # Single-flight ⇒ ≤1 running run per agent, so an agent-keyed renew carries a run-scoped
        # stop unambiguously. The daemon vets stop_run_id == the run IT tracks before killing
        # (never a stale/foreign run). `stop_requested_by` is surfaced as the requester's alias for
        # the resident '[turn stopped by …]' sentinel turn. Read in the SAME txn so a stop recorded
        # this tick is seen this tick (only meaningful when the lease was actually renewed).
        stop = None
        if row is not None:
            cur.execute(
                """SELECT w.run_id, ag.alias AS by_alias
                     FROM worker_runs w
                     LEFT JOIN agents ag ON ag.id::text = w.stop_requested_by
                    WHERE w.agent_id = %s AND w.status = 'running'
                      AND w.stop_requested_at IS NOT NULL
                    ORDER BY w.started_at DESC LIMIT 1""",
                (aid,),
            )
            stop = cur.fetchone()
        conn.commit()
    if row is None:
        return {"agent_id": aid, "renewed": False, "wake_lease_until": None, "lease_kind": None,
                "preempt_requested": False, "stop_requested": False, "stop_run_id": None,
                "stop_requested_by": None}
    # ISS-69(b): surface a pending yield request on the heartbeat the daemon already sends every
    # tick, so service_residents can yield an idle resident WITHOUT a separate read loop.
    return {"agent_id": aid, "renewed": True, "lease_kind": row["lease_kind"],
            "wake_lease_until": row["wake_lease_until"].isoformat(),
            "preempt_requested": row["preempt_requested_at"] is not None,
            "stop_requested": stop is not None,
            "stop_run_id": str(stop["run_id"]) if stop else None,
            "stop_requested_by": (stop["by_alias"] if stop else None)}


@app.post("/api/containers/{cid}/reap-orphan-leases", status_code=200)
def reap_orphan_leases(cid: str, orphan_secs: float = Query(default=ORPHAN_LEASE_SECS, ge=0)):
    """ISS-60(B): heartbeat-keyed orphan-lease reaper (defense-in-depth backstop for ISS-60).

    ISS-60 = an orphan resident lease blocks ALL wakes for an agent. The single-flight lease has
    a short TTL the daemon renews every tick, so a worker the daemon still TRACKS self-heals on
    exit/crash. The gap this closes: a lease that OUTLIVES its embodiment in a way the TTL alone
    won't recover — a daemon restart / externally-spawned resident whose lease survives an
    in-memory live_residents reset, where something keeps the lease alive without a live process
    behind it. This reaper is TTL-independent: it force-releases any LIVE lease whose agent hasn't
    produced a liveness heartbeat in `orphan_secs` (default 1260s > the 1200s watchdog hard-cap, so
    a legitimately busy worker is never reaped).

    SAFE only because wake-renew bumps last_heartbeat_at on every keep-alive tick — an alive-but-quiet
    resident keeps a fresh heartbeat, so heartbeat-staleness genuinely means the embodiment is gone.
    NULL heartbeats are NEVER reaped (an agent that never beat has no live embodiment to orphan; its
    own short TTL handles it) — only a once-alive-now-stale lease. The reap DECISION lives server-side
    (only the API touches the DB) so the host daemon stays a thin caller. The daemon polls this each
    tick; it is idempotent (a released lease is no longer LIVE, so a re-call is a no-op)."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_container(cur, cid)
        # CTE so RETURNING-equivalent captures the PRE-release lease_kind (the UPDATE NULLs it).
        cur.execute(
            """WITH orphans AS (
                   SELECT w.agent_id, a.alias, w.lease_kind,
                          EXTRACT(EPOCH FROM (now() - a.last_heartbeat_at)) AS idle_seconds
                     FROM agent_wake_state w
                     JOIN agents a ON a.id = w.agent_id
                    WHERE a.container_id = %s
                      AND a.terminated_at IS NULL
                      AND w.wake_lease_until IS NOT NULL
                      AND w.wake_lease_until > now()                       -- only a LIVE (wake-blocking) lease
                      AND a.last_heartbeat_at IS NOT NULL                  -- never-beat = no embodiment to orphan
                      AND a.last_heartbeat_at < now() - make_interval(secs => %s)
               ), released AS (
                   UPDATE agent_wake_state w
                      SET wake_lease_until = NULL, lease_kind = NULL,
                          preempt_requested_at = NULL, preempt_for = NULL
                     FROM orphans o
                    WHERE w.agent_id = o.agent_id
                   RETURNING w.agent_id
               )
               SELECT agent_id, alias, lease_kind, idle_seconds FROM orphans""",
            (cid, orphan_secs),
        )
        reaped = cur.fetchall()
        # ISS-stranded (e4b77f3f): fold the run-reconcile into the orphan-lease reaper too, so a lease
        # that OUTLIVED its embodiment (daemon turnover, beyond the TTL's reach) also clears its
        # stranded 'running' worker_runs when the reaper force-releases it — same invariant as
        # wake-ack's release path, keyed on the agents whose lease we just released.
        runs_by_agent: dict = {}
        reaped_ids = [str(r["agent_id"]) for r in reaped]
        if reaped_ids:
            cur.execute(
                """UPDATE worker_runs SET status='orphaned', ended_at=now()
                   WHERE agent_id::text = ANY(%s) AND status='running'
                   RETURNING run_id, agent_id""",
                (reaped_ids,))
            for rr in cur.fetchall():
                runs_by_agent.setdefault(str(rr["agent_id"]), []).append(str(rr["run_id"]))
        for r in reaped:
            log_event(cur, cid, "system", None, "agent", str(r["agent_id"]),
                      "orphan_lease_reaped",
                      {"lease_kind": r["lease_kind"],
                       "idle_seconds": round(float(r["idle_seconds"]), 1),
                       "orphan_secs": orphan_secs,
                       "reconciled_runs": runs_by_agent.get(str(r["agent_id"]), [])})
        conn.commit()
    return {"container_id": cid, "orphan_secs": orphan_secs,
            "reaped": [{"agent_id": str(r["agent_id"]), "alias": r["alias"],
                        "lease_kind": r["lease_kind"],
                        "idle_seconds": round(float(r["idle_seconds"]), 1)} for r in reaped]}


class WakesToggle(BaseModel):
    enabled: bool = Field(..., description="false = halt ALL wakes for this container")
    actor_agent_id: Optional[str] = Field(default=None, description="who flipped it (for the audit row)")


# #298: the autonomy SLIDER write body. `level` is the engine enum; `actor_agent_id` MUST be a
# kind='human' agent — moving the slider changes the one hard completion gate (at 'full' a /done
# auto-completes with no human verify), so it is a deliberate human authority action (stricter than
# /wakes, which only logs the actor). The route validates `level` against the enum (400 otherwise).
AUTONOMY_LEVELS = ("plan", "pr", "full")


class AutonomyUpdate(BaseModel):
    level: str = Field(..., description="engine autonomy level: 'plan' | 'pr' | 'full'")
    actor_agent_id: str = Field(..., description="UUID of the human (kind='human') moving the slider")


@app.post("/api/containers/{cid}/wakes", status_code=200)
def set_wakes_enabled(cid: str, body: WakesToggle):
    """R2.4: flip the global wake kill-switch (the one-switch halt for a runaway).

    Unlike /orcha-pause (which pauses the whole container — agents, tasks, everything),
    this surgically stops only out-of-band wakes: the container stays active, humans and
    live agents keep working, but the daemon's claims are refused so no new headless
    workers spawn. Re-enable to resume turnkey waking.
    """
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_container(cur, cid)
        cur.execute("UPDATE containers SET wakes_enabled=%s WHERE id=%s RETURNING wakes_enabled",
                    (body.enabled, cid))
        row = cur.fetchone()
        log_event(cur, cid, "system", body.actor_agent_id, "container", cid,
                  "wakes_toggled", {"enabled": body.enabled})
        conn.commit()
    return {"container_id": cid, "wakes_enabled": row["wakes_enabled"]}


@app.post("/api/containers/{cid}/autonomy", status_code=200)
def set_autonomy_level(cid: str, body: AutonomyUpdate):
    """#298: move the autonomy SLIDER for a container — the single source of truth for how much a
    human stays in the loop.

      plan (Plan-only)   — every /done stops at needs_verification (a human verifies); the agent
                           refuses `gh pr create` until its plan is approved on the task thread.
      pr   (Build-to-PR) — every /done stops at needs_verification; the agent may `gh pr create`
                           but refuses `gh pr merge`.
      full (Full)        — a /done AUTO-COMPLETES the task (no human verify); the agent may
                           `gh pr merge` to the configured target branch.

    Only the completion gate is engine-enforced (here + mark_done); the gh/git rules are agent
    behaviors keyed off this value, recorded in docs/orcha-project-preferences.md.

    HUMAN-GATED (Orcha#30, stricter than /wakes): moving the slider can switch off the human
    verification gate entirely, so only a kind='human' actor may do it. Audit-logged.
    """
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if body.level not in AUTONOMY_LEVELS:
        raise HTTPException(400, f"level must be one of {AUTONOMY_LEVELS}")
    with db_cursor() as (conn, cur):
        _require_container(cur, cid)
        _require_kind(cur, body.actor_agent_id, ("human",))   # Orcha#30: a deliberate human action
        cur.execute("UPDATE containers SET autonomy_level=%s WHERE id=%s RETURNING autonomy_level",
                    (body.level, cid))
        row = cur.fetchone()
        log_event(cur, cid, "human", body.actor_agent_id, "container", cid,
                  "autonomy_changed", {"level": body.level})
        conn.commit()
    return {"container_id": cid, "autonomy_level": row["autonomy_level"]}


# ---------- A2: worker runs (persist + expose headless wake output) ----------

class WorkerRunStart(BaseModel):
    """Notifier records a spawned worker (status=running)."""
    wake_kind: str = Field(default="ephemeral", description="transport: ephemeral | tmux | resident | live")
    wake_event: Optional[str] = Field(default=None, max_length=MAX_NAME_LEN)
    task_id: Optional[str] = Field(default=None, description="the wake's auto-start task, if any")
    log_path: Optional[str] = Field(default=None, description="host path of the per-wake stream-json log (A1)")
    pid: Optional[int] = Field(default=None, description="919050a5: host PID of the spawned worker, so "
                               "the notifier can os.kill(pid,0)-reap a run whose process is dead")
    runtime: Optional[str] = Field(default=None, max_length=MAX_NAME_LEN)
    conversation_id: Optional[str] = Field(default=None, description="conversation answered by this run, if any")
    conversation_ack_ts: Optional[float] = Field(default=None, description="event cursor claimed for this conversation turn")
    last_message_path: Optional[str] = Field(default=None, description="Codex --output-last-message sidecar path")
    worktree: Optional[str] = Field(default=None, description="isolated worktree cwd, if any")
    branch: Optional[str] = Field(default=None, description="isolated worktree branch, if any")
    base_cwd: Optional[str] = Field(default=None, description="host project cwd that owns the worktree/logs")


class WorkerRunFinish(BaseModel):
    """Notifier finishes a run on reap (clean exit or ISS-15 kill)."""
    status: str = Field(..., description="exited | killed")
    exit_code: Optional[int] = None
    output: Optional[str] = Field(default=None, description="captured stream-json text from the per-wake log")
    diff: Optional[str] = Field(default=None, description="ISS-8: net `git diff` vs origin/main from the worker's isolated worktree")
    kill_reason: Optional[str] = Field(default=None, description="#270: structured watchdog diagnostic (JSON) when the stall/hard-cap reaper kills a worker — explains WHY it was reaped")
    input_tokens: Optional[int] = Field(default=None, description="#289: input tokens for the wake (from the stream-json result event's usage)")
    output_tokens: Optional[int] = Field(default=None, description="#289: output tokens for the wake")
    cache_read_input_tokens: Optional[int] = Field(default=None, description="#289: cached input tokens READ — cheap in $ but count against the plan quota")
    cache_creation_input_tokens: Optional[int] = Field(default=None, description="#289: input tokens written to cache")
    total_cost_usd: Optional[float] = Field(default=None, description="#289: total dollar cost the CLI reported for the wake")


class WorkerRunStop(BaseModel):
    """#240 + #171/ISS-72: a human requests a graceful STOP of a running worker run / resident
    turn. The API only RECORDS the intent (it can't signal host PIDs); the host daemon enforces
    it on its next wake-renew tick. Human-gated."""
    actor_agent_id: str = Field(..., description="UUID of the human (kind='human') requesting the stop")


class WorkerRunLines(BaseModel):
    """ISS-39: the daemon posts a batch of new stream-json lines for a running worker.
    `start_seq` is the seq of the FIRST line; the rest are start_seq+1, +2, … Idempotent
    (PK (run_id, seq), ON CONFLICT DO NOTHING) so a retried batch never duplicates."""
    start_seq: int = Field(..., ge=1, description="seq of lines[0]; subsequent lines increment")
    lines: list[str] = Field(..., description="raw NDJSON stream-json lines, in order")


def _run_row(r: dict) -> dict:
    return {
        "run_id": str(r["run_id"]), "agent_id": str(r["agent_id"]),
        "task_id": str(r["task_id"]) if r["task_id"] else None,
        "wake_kind": r["wake_kind"], "wake_event": r["wake_event"],
        "status": r["status"], "exit_code": r["exit_code"], "log_path": r["log_path"],
        "pid": r.get("pid"), "runtime": r.get("runtime"),
        "conversation_id": str(r["conversation_id"]) if r.get("conversation_id") else None,
        "conversation_ack_ts": r.get("conversation_ack_ts"),
        "last_message_path": r.get("last_message_path"),
        "worktree": r.get("worktree"), "branch": r.get("branch"), "base_cwd": r.get("base_cwd"),
        "output": r["output"], "diff": r.get("diff"), "kill_reason": r.get("kill_reason"),
        "started_at": r["started_at"].isoformat() if r["started_at"] else None,
        "ended_at": r["ended_at"].isoformat() if r["ended_at"] else None,
    }


@app.post("/api/agents/{aid}/runs", status_code=201)
def start_worker_run(aid: str, body: WorkerRunStart):
    """A2: the notifier records a worker it just spawned (status=running). Returns run_id;
    the daemon stores it and calls /finish on reap. Keeps the 'only the API touches the
    DB' invariant — the notifier never writes worker_runs directly."""
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    if body.task_id is not None and not _valid_uuid(body.task_id):
        raise HTTPException(400, "task_id is not a valid UUID")
    if body.conversation_id is not None and not _valid_uuid(body.conversation_id):
        raise HTTPException(400, "conversation_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        ag = _require_agent(cur, aid)
        if body.task_id is not None:
            _require_task(cur, body.task_id)   # 404 on a valid-but-unknown task, not a 500 FK violation
        if body.conversation_id is not None:
            cur.execute("SELECT agent_id FROM conversations WHERE id=%s", (body.conversation_id,))
            conv = cur.fetchone()
            if not conv:
                raise HTTPException(404, f"conversation {body.conversation_id} not found")
            if str(conv["agent_id"]) != aid:
                raise HTTPException(403, "conversation_id belongs to a different agent")
        cur.execute(
            """INSERT INTO worker_runs
                    (agent_id, task_id, wake_kind, wake_event, log_path, pid, runtime,
                     conversation_id, conversation_ack_ts, last_message_path,
                     worktree, branch, base_cwd, status)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'running')
               RETURNING *""",
            (aid, body.task_id, body.wake_kind, body.wake_event, body.log_path,
             body.pid, body.runtime, body.conversation_id, body.conversation_ack_ts,
             body.last_message_path, body.worktree, body.branch, body.base_cwd),
        )
        row = cur.fetchone()
        log_event(cur, str(ag["container_id"]), "system", None, "agent", aid,
                  "worker_run_started", {"run_id": str(row["run_id"]), "wake_kind": body.wake_kind})
        conn.commit()
    return _run_row(row)


@app.get("/api/agents/{aid}/resident-runs")
def list_resident_runs(aid: str, status: Optional[str] = None):
    """919050a5: the notifier's cross-daemon single-flight read — this agent's RESIDENT worker_runs
    with their host `pid`, so the host (the only side that can evaluate os.kill(pid,0); the API runs
    in Docker and can't see host PIDs) can detect a run whose row says 'running' but whose backing
    process is dead, then reap it + release the held resident wake-lease. ?status=running narrows to
    the live-claimed rows the single-flight reaper cares about. Newest first."""
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_agent(cur, aid)
        q = ("SELECT run_id, pid, status, started_at FROM worker_runs "
             "WHERE agent_id=%s AND wake_kind='resident'")
        params: list = [aid]
        if status is not None:
            q += " AND status=%s"
            params.append(status)
        q += " ORDER BY started_at DESC"
        cur.execute(q, tuple(params))
        rows = cur.fetchall()
    return {"agent_id": aid,
            "runs": [{"run_id": str(r["run_id"]), "pid": r["pid"], "status": r["status"],
                      "started_at": r["started_at"].isoformat() if r["started_at"] else None}
                     for r in rows]}


@app.get("/api/containers/{cid}/running-runs")
def list_container_running_runs(cid: str):
    """#342: every worker_run still status='running' across this container's (live) agents, with its
    host `pid` — so the notifier (the only side that can os.kill(pid,0); the API runs in Docker and
    can't see host PIDs) can detect a run whose row says 'running' but whose process is DEAD and
    reconcile it. Unlike the per-agent /resident-runs read this is CONTAINER-WIDE and spans ALL
    wake_kinds: it's what reaps an orphaned EPHEMERAL wake-run (request_answered / checkpoint_respawn
    / conversation_turn) whose daemon RESTARTED and lost the Popen handle that would have poll()/
    finished it — the #342 'busy forever' leak the per-agent resident reaper (active-conversation +
    resident-scoped) and the heartbeat reap-orphan-leases (live-lease-scoped) both miss. Newest first."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        _require_container(cur, cid)
        cur.execute(
            """SELECT wr.run_id, wr.agent_id, wr.pid, wr.wake_kind, wr.wake_event, wr.started_at
                 FROM worker_runs wr JOIN agents a ON a.id = wr.agent_id
                WHERE a.container_id = %s AND wr.status = 'running'
                  AND a.terminated_at IS NULL
                ORDER BY wr.started_at DESC""",
            (cid,))
        rows = cur.fetchall()
    return {"container_id": cid,
            "runs": [{"run_id": str(r["run_id"]), "agent_id": str(r["agent_id"]),
                      "pid": r["pid"], "wake_kind": r["wake_kind"], "wake_event": r["wake_event"],
                      "started_at": r["started_at"].isoformat() if r["started_at"] else None}
                     for r in rows]}


@app.post("/api/runs/{run_id}/finish", status_code=200)
def finish_worker_run(run_id: str, body: WorkerRunFinish):
    """A2: the notifier finishes a run on reap — exited (clean) or killed (ISS-15 watchdog),
    with the captured stream-json output. Idempotent-ish: finishing an already-finished run
    just overwrites the terminal fields."""
    if not _valid_uuid(run_id):
        raise HTTPException(400, "run_id is not a valid UUID")
    if body.status not in ("exited", "killed"):
        raise HTTPException(422, "status must be 'exited' or 'killed'")
    with db_cursor() as (conn, cur):
        cur.execute("SELECT run_id, agent_id FROM worker_runs WHERE run_id=%s", (run_id,))
        if not cur.fetchone():
            raise HTTPException(404, f"worker run {run_id} not found")
        cur.execute(
            """UPDATE worker_runs SET status=%s, exit_code=%s, output=%s,
                      diff=COALESCE(%s, diff), kill_reason=COALESCE(%s, kill_reason),
                      input_tokens=COALESCE(%s, input_tokens),
                      output_tokens=COALESCE(%s, output_tokens),
                      cache_read_input_tokens=COALESCE(%s, cache_read_input_tokens),
                      cache_creation_input_tokens=COALESCE(%s, cache_creation_input_tokens),
                      total_cost_usd=COALESCE(%s, total_cost_usd),
                      ended_at=now()
               WHERE run_id=%s RETURNING agent_id, status, ended_at""",
            (body.status, body.exit_code, body.output, body.diff, body.kill_reason,
             body.input_tokens, body.output_tokens, body.cache_read_input_tokens,
             body.cache_creation_input_tokens, body.total_cost_usd, run_id),
        )
        row = cur.fetchone()
        conn.commit()
    return {"run_id": run_id, "status": row["status"],
            "ended_at": row["ended_at"].isoformat() if row["ended_at"] else None}


@app.post("/api/runs/{run_id}/stop", status_code=200)
def stop_worker_run(run_id: str, body: WorkerRunStop):
    """#240 + #171/ISS-72: a human requests a graceful STOP of a RUNNING worker run / resident
    turn. The API runs in Docker and cannot signal host PIDs, so it only RECORDS the intent on
    the run row; the host notifier reads it back on its next per-tick wake-renew (zero new poll)
    and reaps the run via the same graceful teardown the stall watchdog uses. Human-gated.

    Idempotent + async: re-stopping an already-stop-requested running run is a no-op 200; a run
    that is no longer 'running' cannot be stopped (returns stop_requested=false with its terminal
    status) — there is nothing live to signal."""
    if not _valid_uuid(run_id):
        raise HTTPException(400, "run_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_kind(cur, body.actor_agent_id, ("human",))   # only a human may stop a run
        cur.execute("SELECT run_id, agent_id, status, stop_requested_at FROM worker_runs "
                    "WHERE run_id=%s", (run_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, f"worker run {run_id} not found")
        if row["status"] != "running":
            # Nothing live to signal; report the terminal state without erroring (idempotent).
            return {"run_id": run_id, "stop_requested": False, "status": row["status"],
                    "already_finished": True}
        if row["stop_requested_at"] is not None:
            return {"run_id": run_id, "stop_requested": True, "status": "running",
                    "already_requested": True}
        cur.execute(
            "UPDATE worker_runs SET stop_requested_at=now(), stop_requested_by=%s "
            "WHERE run_id=%s AND status='running' RETURNING agent_id",
            (body.actor_agent_id, run_id),
        )
        urow = cur.fetchone()
        cur.execute("SELECT container_id FROM agents WHERE id=%s", (row["agent_id"],))
        crow = cur.fetchone()
        if crow:
            log_event(cur, str(crow["container_id"]), "human", body.actor_agent_id,
                      "agent", str(row["agent_id"]), "worker_run_stop_requested",
                      {"run_id": run_id})
        conn.commit()
    return {"run_id": run_id, "stop_requested": bool(urow), "status": "running"}


@app.post("/api/runs/{run_id}/lines", status_code=200)
def append_worker_run_lines(run_id: str, body: WorkerRunLines):
    """ISS-39: the daemon streams a running worker's stream-json lines here as they're
    written (it reads its OWN host log — no Docker mount lag). The SSE /stream endpoint tails
    this table instead of the bind-mounted file, so the portal no longer depends on seeing
    host appends through the macOS VirtioFS attribute cache. Idempotent: a re-POSTed batch
    (same start_seq) collides on the PK and is dropped, so a lost-response retry is safe."""
    if not _valid_uuid(run_id):
        raise HTTPException(400, "run_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        cur.execute("SELECT run_id FROM worker_runs WHERE run_id=%s", (run_id,))
        if not cur.fetchone():
            raise HTTPException(404, f"worker run {run_id} not found")
        rows = [(run_id, body.start_seq + i, line) for i, line in enumerate(body.lines)]
        if rows:
            cur.executemany(
                """INSERT INTO worker_run_lines (run_id, seq, line) VALUES (%s, %s, %s)
                   ON CONFLICT (run_id, seq) DO NOTHING""",
                rows,
            )
        conn.commit()
    return {"run_id": run_id, "accepted": len(rows),
            "max_seq": (body.start_seq + len(rows) - 1) if rows else None}


def _fetch_run_lines(run_id, after_seq, limit=500):
    with db_cursor() as (_, cur):
        cur.execute(
            """SELECT seq, line FROM worker_run_lines
               WHERE run_id=%s AND seq>%s ORDER BY seq LIMIT %s""",
            (run_id, after_seq, limit),
        )
        return cur.fetchall()


@app.get("/api/agents/{aid}/runs")
def list_agent_runs(aid: str, limit: int = Query(default=20, ge=1, le=200),
                    task_id: Optional[str] = Query(default=None)):
    """A2: this agent's worker runs, newest first (what B1 renders). Optional ?task_id= filter."""
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (_, cur):
        _require_agent(cur, aid)
        if task_id is not None:
            if not _valid_uuid(task_id):
                raise HTTPException(400, "task_id is not a valid UUID")
            cur.execute("""SELECT * FROM worker_runs WHERE agent_id=%s AND task_id=%s
                           ORDER BY started_at DESC LIMIT %s""", (aid, task_id, limit))
        else:
            cur.execute("""SELECT * FROM worker_runs WHERE agent_id=%s
                           ORDER BY started_at DESC LIMIT %s""", (aid, limit))
        runs = [_run_row(r) for r in cur.fetchall()]
    return {"agent_id": aid, "runs": runs}


@app.get("/api/tasks/{tid}/runs")
def list_task_runs(tid: str, limit: int = Query(default=20, ge=1, le=200)):
    """A2: worker runs for a task, newest first (per-task progress view for B1)."""
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    with db_cursor() as (_, cur):
        _require_task(cur, tid)
        cur.execute("""SELECT * FROM worker_runs WHERE task_id=%s
                       ORDER BY started_at DESC LIMIT %s""", (tid, limit))
        runs = [_run_row(r) for r in cur.fetchall()]
    return {"task_id": tid, "runs": runs}


def _worker_run_status(run_id):
    with db_cursor() as (_, cur):
        cur.execute("SELECT status FROM worker_runs WHERE run_id=%s", (run_id,))
        r = cur.fetchone()
        return r["status"] if r else None


@app.get("/api/agents/{aid}/runs/{run_id}/stream")
async def stream_worker_run(aid: str, run_id: str):
    """SSE: live-tail a worker's stream-json lines so the portal sees its progress the instant
    it acts (kills the 'invisible until reap' gap). Each new NDJSON line is one SSE event
    `{seq, line}`; on run finish a terminal `{seq, done:true, status}` is sent and the stream
    closes. Reap-time output+diff capture (history) is unchanged.

    ISS-39: lines are tailed from the `worker_run_lines` TABLE (the daemon POSTs them as it
    reads its own host log), NOT from the bind-mounted per-wake file. The portal reading the
    mounted log saw host appends through the macOS Docker VirtioFS attribute cache, which lags
    1-5s and dropped lines inside a client window ('seq 1 then stall'). DB reads have no such
    lag. `seq` is the daemon-assigned line number (monotonic per run), which the client dedups.

    Event shape (for the EventSource client):
      data: {"seq": <int>, "line": "<raw stream-json line>"}     ... one per worker line
      data: {"seq": <int>, "done": true, "status": "exited|killed"}   ... final, then close
    """
    if not _valid_uuid(aid) or not _valid_uuid(run_id):
        raise HTTPException(400, "agent_id / run_id must be valid UUIDs")
    with db_cursor() as (_, cur):
        _require_agent(cur, aid)
        cur.execute("SELECT status FROM worker_runs WHERE run_id=%s AND agent_id=%s",
                    (run_id, aid))
        row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"worker run {run_id} not found for this agent")

    async def gen():
        last_seq = 0
        deadline = time.time() + 1800.0   # 30-min safety cap so the stream can't hang forever
        yield ": stream open\n\n"
        while True:
            rows = await asyncio.to_thread(_fetch_run_lines, run_id, last_seq)
            for r in rows:
                last_seq = r["seq"]
                yield f"data: {json.dumps({'seq': r['seq'], 'line': r['line']})}\n\n"
            if rows:
                continue              # drained a batch; immediately look for more
            status = await asyncio.to_thread(_worker_run_status, run_id)
            if status is None or status != "running":
                # The daemon flushes a run's FINAL lines before marking it done, so drain once
                # more — never emit `done` ahead of a still-pending tail line.
                for r in await asyncio.to_thread(_fetch_run_lines, run_id, last_seq):
                    last_seq = r["seq"]
                    yield f"data: {json.dumps({'seq': r['seq'], 'line': r['line']})}\n\n"
                yield f"data: {json.dumps({'seq': last_seq + 1, 'done': True, 'status': status})}\n\n"
                return
            if time.time() > deadline:
                yield f"data: {json.dumps({'seq': last_seq + 1, 'done': True, 'status': 'stream_timeout'})}\n\n"
                return
            yield ": heartbeat\n\n"
            await asyncio.sleep(1.0)

    return StreamingResponse(gen(), media_type="text/event-stream")


# ---------- tasks ----------

@app.post("/api/containers/{cid}/tasks", status_code=201)
def create_task(cid: str, body: TaskCreateBody):
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_container_active(cur, cid, body.created_by_agent_id)   # GH #24 (was _require_container)
        _reject_if_retired(cur, body.created_by_agent_id)   # ISS-51 [P1]

        for dep in body.depends_on:
            if not _valid_uuid(dep):
                raise HTTPException(400, f"depends_on contains invalid UUID: {dep}")

        assignee_id = None
        if body.assignee_alias:
            assignee_id = _resolve_alias(cur, cid, body.assignee_alias)

        initial_status = "pending" if body.depends_on else (
            "in_progress" if assignee_id else "ready"
        )
        # #326 (B3): a HELD task is created 'not_ready' regardless of deps — it leaves the
        # ready-queue and is not self-claimable until a human releases it (POST .../readiness).
        # An explicitly assigned task is never held (you're handing it to an agent to start now).
        if body.not_ready and not assignee_id:
            initial_status = "not_ready"

        started_clause = "now()" if initial_status == "in_progress" else "NULL"

        # SPEC-4: optional create-time protocol. Only the keys actually sent are stored
        # (exclude_unset), so an empty/omitted protocol persists as NULL, not '{}'.
        protocol_json = None
        if body.protocol is not None:
            fields = body.protocol.model_dump(exclude_unset=True)
            if fields:
                protocol_json = json.dumps(fields)

        cur.execute(
            f"""INSERT INTO tasks
                  (container_id, title, description, definition_of_done,
                   status, priority, created_by_agent_id, protocol, started_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, {started_clause})
                RETURNING id""",
            (cid, body.title, body.description, body.definition_of_done,
             initial_status, body.priority, body.created_by_agent_id, protocol_json),
        )
        tid = str(cur.fetchone()["id"])

        for dep in body.depends_on:
            cur.execute(
                "INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (%s, %s)",
                (tid, dep),
            )

        if assignee_id:
            cur.execute(
                """INSERT INTO agent_tasks (agent_id, task_id, assignment_status)
                   VALUES (%s, %s, 'working')""",
                (assignee_id, tid),
            )
            # ISS-86 / #245 (GAP A): do NOT bump_agent(assignee) here. Being assigned a task
            # is not the assignee taking a turn — and bump_agent resets last_heartbeat_at=now(),
            # which shrinks idle_seconds so wake-scan reads the cold assignee as active and
            # SUPPRESSES the task_assigned wake for ~min_idle. recompute_agent_status still flips
            # them to 'working' off the agent_tasks row. Mirrors the /assign path (main.py ~3302),
            # which already omits the bump for exactly this reason.
            recompute_agent_status(cur, assignee_id)
            _publish_event(cur, cid, assignee_id, "task_assigned",
                           {"task_id": tid, "title": body.title, "via": "direct assignment"})

        actor_type = "ai" if body.created_by_agent_id else "human"
        log_event(cur, cid, actor_type, body.created_by_agent_id, "task", tid, "created",
                  {"title": body.title, "status": initial_status,
                   "assignee_alias": body.assignee_alias, "depends_on": body.depends_on})
        conn.commit()

    return {"task_id": tid, "status": initial_status,
            "assignee_alias": body.assignee_alias, "depends_on": body.depends_on}


@app.post("/api/tasks/{tid}/messages", status_code=201)
def post_message(tid: str, body: TaskMessage):
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    if body.author_agent_id is not None and not _valid_uuid(body.author_agent_id):
        raise HTTPException(400, "author_agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        t = _require_task(cur, tid)
        _reject_if_retired(cur, body.author_agent_id)   # ISS-51 [P1]
        _require_container_active(cur, str(t["container_id"]), body.author_agent_id)   # GH #24 (human None-author posts still allowed)
        # ISS-43: an attributed author must be a (non-retired) member of the task's CONTAINER,
        # but need NOT be an assignee. The original guard (assignee-only) was too strict for the
        # fleet's collaboration model — reviewers and coordinators routinely post on a dev's task
        # thread. Hitting a 403, those legitimate cross-task posts dropped their author_agent_id
        # and went in as a NULL author to get through. We still reject a non-member /
        # cross-container id so authorship can't be forged. We resolve the author's agents.kind
        # here so the audit actor_type (and the read-path is_human) are derived from WHO the
        # author IS, not from whether an id was supplied — see #271 below.
        author_kind = None
        if body.author_agent_id:
            cur.execute(
                "SELECT kind FROM agents WHERE id=%s AND container_id=%s LIMIT 1",
                (body.author_agent_id, t["container_id"]),
            )
            arow = cur.fetchone()
            if not arow:
                raise HTTPException(403, "author agent isn't a member of this task's container — cannot post")
            author_kind = arow["kind"]
        # #301: re-validate any staged attachment refs against disk (re-deriving size/type) so
        # the JSONB only ever holds real, this-task files — never client-fabricated paths.
        llm_key = _container_llm_key(cur, str(t["container_id"]))
        attachments = _validate_attachment_refs(tid, body.attachments, api_key=llm_key)
        cur.execute(
            "INSERT INTO task_messages (task_id, author_id, body, attachments) "
            "VALUES (%s, %s, %s, %s) RETURNING id",
            (tid, body.author_agent_id, body.body, json.dumps(attachments)),
        )
        mid = str(cur.fetchone()["id"])
        if body.author_agent_id:
            bump_agent(cur, body.author_agent_id)
        # #271 (harden AI-actor enforcement): the audit actor_type is DERIVED from the resolved
        # agents.kind, NEVER from the mere presence/absence of an author id. The old
        # `"ai" if author else "human"` logged a NULL-author post as "human" — so an AI could
        # fabricate a human-attributed thread post just by OMITTING its author_agent_id (spoof
        # vector V1). A NULL author now logs as a neutral 'system' actor (never 'human'); a real
        # human post is attributed (kind='human') by the portal comment box. NOTE the residual
        # vector V2 documented on _require_kind: with no server-side caller auth, an AI that
        # supplies a known human's UUID still clears human gates — that needs capability tokens,
        # out of scope for this cooperative-hardening pass.
        actor_type = author_kind if author_kind else "system"
        log_event(cur, t["container_id"], actor_type, body.author_agent_id,
                  "task", tid, "message", {"message_id": mid, "preview": body.body[:120]})
        # R2.2: a task-thread message is a wake trigger for the task's OTHER assignees.
        # Previously this emitted no agent_events, so a teammate's note silently stranded
        # until they happened to look. Publish a targeted `task_message` event to every
        # assignee except the author so the daemon/listen loop wakes them out-of-band.
        cur.execute("SELECT agent_id FROM agent_tasks WHERE task_id=%s", (tid,))
        for row in cur.fetchall():
            target = str(row["agent_id"])
            if target == body.author_agent_id:
                continue   # don't wake yourself for your own message
            _publish_event(cur, str(t["container_id"]), target, "task_message",
                           {"task_id": tid, "message_id": mid,
                            "from_agent_id": body.author_agent_id,
                            "preview": body.body[:120]})
        conn.commit()
    return {"message_id": mid, "task_id": tid}


@app.get("/api/tasks/{tid}/messages")
def get_task_messages(tid: str, limit: int = 0, before: Optional[str] = None,
                      before_id: Optional[str] = None):
    """Orcha#32: read the task collaboration thread. Symmetric with the POST above.

    The thread was write-only — task_messages had no read path, so agents posted
    progress notes that nobody could read back and the portal reported 0 messages.
    Returns the thread ordered by created_at ASC with the author alias resolved
    (LEFT JOIN agents). Same element shape that GET /api/containers/{cid} now embeds as each
    task's `messages[]`. Implemented by A on Thread's behalf.

    is_human derivation (#271, was ISS-43): `author_id IS NOT NULL AND agents.kind = 'human'`.
    Humans are themselves agents (kind='human', the 1:1:1 model), so a real human post is
    ATTRIBUTED and resolves kind='human'. A NULL author is NO LONGER treated as human — the old
    `author_id IS NULL OR ...` let an AI fabricate a human-looking post by omitting its id (spoof
    vector V1). A NULL author now renders is_human=false (the frontend shows it through the neutral
    'system' label). The portal comment box attributes human posts with the acting human's id.

    ISS-68 (#167): optional CURSOR pagination for lazy thread loading. With no params the
    full thread is returned ASC (unchanged). With `limit`>0 the NEWEST `limit` messages are
    returned, still ASC within the page, plus `has_more` + a `(next_before, next_before_id)`
    keyset cursor the panel echoes back as `(before, before_id)` to "load earlier".

    The cursor is a (created_at, id) KEYSET, not a bare timestamp — task_messages can share an
    identical `created_at` (bulk insert / coarse clock), and a `created_at < before` cursor would
    silently drop the same-timestamp rows straddling a page boundary (P2, kedar review #180). The
    composite tuple compare makes paging exact regardless of timestamp ties.

    GH #33: the response also carries a `task` header — {title, description, definition_of_done} —
    so a worker woken by a task-thread message that follows "read the thread" sees the FULL task
    body alongside the conversation, not just the message preview. Acceptance criteria living in the
    description / DoD are read before acting, not skipped for the title.
    """
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    if before_id is not None and not _valid_uuid(before_id):
        raise HTTPException(400, "before_id is not a valid UUID")
    cols = ("m.id AS message_id, m.author_id, ma.alias AS author_alias, "
            "(m.author_id IS NOT NULL AND ma.kind = 'human') AS is_human, m.body, "
            # #301: COALESCE so pre-migration rows surface [] (their column existed only
            # after mig 025; the DEFAULT covers new rows but be explicit for the read path).
            "COALESCE(m.attachments, '[]'::jsonb) AS attachments, m.created_at")
    with db_cursor() as (_, cur):
        _require_task(cur, tid)
        # GH #33: surface the FULL task body in a `task` header so a worker woken by a task-thread
        # message — told to "read the thread" — reads description + definition_of_done before acting,
        # not just the message preview and the title.
        cur.execute("SELECT title, description, definition_of_done FROM tasks WHERE id=%s", (tid,))
        _t = cur.fetchone()
        task_hdr = {"title": _t["title"], "description": _t["description"],
                    "definition_of_done": _t["definition_of_done"]}
        if limit and limit > 0:
            lim = min(limit, 200)
            params: list[Any] = [tid]
            cursor_clause = ""
            if before and before_id:
                # keyset: strictly older than the (created_at, id) of the oldest loaded row.
                cursor_clause = "AND (m.created_at, m.id) < (%s, %s)"
                params += [before, before_id]
            elif before:
                # back-compat: a bare timestamp cursor (first page never needs one)
                cursor_clause = "AND m.created_at < %s"
                params.append(before)
            cur.execute(
                f"""SELECT {cols}
                   FROM task_messages m LEFT JOIN agents ma ON ma.id = m.author_id
                   WHERE m.task_id = %s {cursor_clause}
                   ORDER BY m.created_at DESC, m.id DESC LIMIT %s""",
                (*params, lim + 1),
            )
            rows = cur.fetchall()          # DESC (newest→oldest)
            has_more = len(rows) > lim
            rows = rows[:lim]
            oldest = rows[-1] if rows else None   # last in DESC = oldest in this page → next cursor
            next_before = oldest["created_at"].isoformat() if (oldest and has_more) else None
            next_before_id = str(oldest["message_id"]) if (oldest and has_more) else None
            rows.reverse()   # ASC within the page (oldest→newest)
            return {"task_id": tid, "task": task_hdr, "messages": rows, "has_more": has_more,
                    "next_before": next_before, "next_before_id": next_before_id}
        cur.execute(
            f"""SELECT {cols}
               FROM task_messages m LEFT JOIN agents ma ON ma.id = m.author_id
               WHERE m.task_id = %s
               ORDER BY m.created_at""",
            (tid,),
        )
        messages = cur.fetchall()
    return {"task_id": tid, "task": task_hdr, "messages": messages}


@app.post("/api/tasks/{tid}/attachments", status_code=201)
async def upload_attachment(tid: str, file: UploadFile = File(...)):
    """#301: upload ONE file to a task's local attachment store and return its ref.

    Two-step, mirroring Claude-Code/Codex pasted-image handling: the client uploads each
    staged file HERE first (getting a stored `id` back), then references those ids in the
    POST .../messages body. Bytes are written to the host bind-mount under a per-task subdir
    (NO DB blobs); only the path/metadata ref is later persisted on the message row.

    Guards: task must exist + container active (parity with posting a message); extension must
    be on the allowlist (SVG/HTML excluded — never served renderable); size ≤ MAX_ATTACHMENT_BYTES
    (enforced while streaming, so an oversize upload is rejected without buffering it all). The
    stored basename is uuid-prefixed + sanitized so it's collision-free and path-traversal-safe."""
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    with db_cursor() as (_, cur):
        t = _require_task(cur, tid)
        _require_container_active(cur, str(t["container_id"]), None)
        llm_key = _container_llm_key(cur, str(t["container_id"]))
    display = _sanitize_attachment_name(file.filename or "file")
    if _attachment_ext(display) is None:
        raise HTTPException(
            400, "unsupported file type — allowed: " + ", ".join(sorted(_ATTACHMENT_TYPES)))
    stored = uuid.uuid4().hex + "_" + display
    tdir = _task_attachments_dir(tid)
    try:
        tdir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise HTTPException(500, f"attachment store unavailable: {e}")
    dest = tdir / stored
    size = 0
    try:
        with open(dest, "wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_ATTACHMENT_BYTES:
                    out.close()
                    dest.unlink(missing_ok=True)
                    raise HTTPException(
                        413, f"file too large (max {MAX_ATTACHMENT_BYTES // (1024 * 1024)} MiB)")
                out.write(chunk)
    except HTTPException:
        raise
    except OSError as e:
        dest.unlink(missing_ok=True)
        raise HTTPException(500, f"could not store attachment: {e}")
    if size == 0:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, "empty file")
    # Build the ref off-thread: on a first-upload cache miss this may run a blocking
    # sync vision/OCR call (describe_image, up to 45s); keep it off the single event loop
    # so notifier polls, SSE streams, and concurrent agent calls aren't stalled.
    return await asyncio.to_thread(
        _attachment_ref, tid, stored, display, size, dest, api_key=llm_key)


@app.get("/api/tasks/{tid}/attachments/{stored_name}")
def serve_attachment(tid: str, stored_name: str):
    """#301: stream a stored attachment from disk. Path-traversal-safe (see
    _resolve_stored_attachment: the name is regex-gated and the resolved parent must equal the
    task's dir). ONLY raster images are served inline; every other allowed type is forced to
    download (Content-Disposition: attachment) so a served file never renders in the portal
    origin. X-Content-Type-Options: nosniff stops the browser from re-sniffing a download into
    something executable."""
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    p = _resolve_stored_attachment(tid, stored_name)
    if p is None:
        raise HTTPException(404, "attachment not found")
    ext = _attachment_ext(stored_name) or ""
    media = _ATTACHMENT_TYPES.get(ext, "application/octet-stream")
    inline = ext in _ATTACHMENT_INLINE_EXT
    # strip the uuid prefix for the downloaded filename (show the original display name)
    display = stored_name.split("_", 1)[1] if "_" in stored_name else stored_name
    disposition = ("inline" if inline else "attachment") + f'; filename="{display}"'
    return FileResponse(
        p, media_type=media,
        headers={"Content-Disposition": disposition, "X-Content-Type-Options": "nosniff"})


@app.post("/api/conversations/{conv_id}/attachments", status_code=201)
async def upload_conversation_attachment(conv_id: str, file: UploadFile = File(...)):
    """#338: upload ONE file to a conversation's local attachment store and return its ref.

    Exact mirror of the task-message upload (#301/#330) with a conversation-scoped dir: the client
    uploads each staged file HERE first (getting a stored `id` back), then references those ids in
    the POST .../turns body. Bytes are written to the host bind-mount under
    .../conversations/<conv-id>/ (NO DB blobs); only the path/metadata ref is later persisted on
    the turn row and fed to the agent. Same guards: conversation must exist + container active;
    extension on the allowlist; size ≤ MAX_ATTACHMENT_BYTES (streamed); uuid-prefixed safe name."""
    if not _valid_uuid(conv_id):
        raise HTTPException(400, "conversation_id is not a valid UUID")
    with db_cursor() as (_, cur):
        cur.execute("SELECT container_id FROM conversations WHERE id=%s", (conv_id,))
        conv = cur.fetchone()
        if not conv:
            raise HTTPException(404, f"conversation {conv_id} not found")
        _require_container_active(cur, str(conv["container_id"]), None)
        llm_key = _container_llm_key(cur, str(conv["container_id"]))
    display = _sanitize_attachment_name(file.filename or "file")
    if _attachment_ext(display) is None:
        raise HTTPException(
            400, "unsupported file type — allowed: " + ", ".join(sorted(_ATTACHMENT_TYPES)))
    stored = uuid.uuid4().hex + "_" + display
    cdir = _conversation_attachments_dir(conv_id)
    try:
        cdir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise HTTPException(500, f"attachment store unavailable: {e}")
    dest = cdir / stored
    size = 0
    try:
        with open(dest, "wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_ATTACHMENT_BYTES:
                    out.close()
                    dest.unlink(missing_ok=True)
                    raise HTTPException(
                        413, f"file too large (max {MAX_ATTACHMENT_BYTES // (1024 * 1024)} MiB)")
                out.write(chunk)
    except HTTPException:
        raise
    except OSError as e:
        dest.unlink(missing_ok=True)
        raise HTTPException(500, f"could not store attachment: {e}")
    if size == 0:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, "empty file")
    # Off-thread for the same reason as the task-upload route: a first-upload cache miss
    # can trigger a blocking sync vision/OCR call inside the ref builder.
    return await asyncio.to_thread(
        _conv_attachment_ref, conv_id, stored, display, size, dest, api_key=llm_key)


@app.get("/api/conversations/{conv_id}/attachments/{stored_name}")
def serve_conversation_attachment(conv_id: str, stored_name: str):
    """#338: stream a stored conversation attachment from disk. Path-traversal-safe (see
    _resolve_stored_conv_attachment: the name is regex-gated and the resolved parent must equal
    the conversation's dir). Disposition + nosniff identical to the task serve route."""
    if not _valid_uuid(conv_id):
        raise HTTPException(400, "conversation_id is not a valid UUID")
    p = _resolve_stored_conv_attachment(conv_id, stored_name)
    if p is None:
        raise HTTPException(404, "attachment not found")
    ext = _attachment_ext(stored_name) or ""
    media = _ATTACHMENT_TYPES.get(ext, "application/octet-stream")
    inline = ext in _ATTACHMENT_INLINE_EXT
    display = stored_name.split("_", 1)[1] if "_" in stored_name else stored_name
    disposition = ("inline" if inline else "attachment") + f'; filename="{display}"'
    return FileResponse(
        p, media_type=media,
        headers={"Content-Disposition": disposition, "X-Content-Type-Options": "nosniff"})


def _backstop_stranded_request(cur, container_id, tid):
    """GH #56 (Point 5): the safety net that keeps a request loop from silently stranding. The
    PRIMARY close-the-loop path is the accepter reporting back by hand (the auto-injected Point 4.4
    report-back note tells it to). This net only catches the case where the accepter's spawned task
    reaches a terminal state (needs_verification / completed) while its originating request is STILL
    'accepted' — i.e. the agent finished but never reported back. We auto-answer the request so the
    requester wakes on its originating_task_id and reads the result anyway.

    DESIGN INTENT (kedar): this should RARELY fire. We log_event an `auto_answered` audit row each
    time it does, with backstop=true on the wake event, so a leaking primary path is observable
    (count the backstop fires vs total answers). A reviewer can grep for it.

    Returns the list of request ids it auto-answered (usually empty)."""
    cur.execute(
        """SELECT id, requester_id, originating_task_id, type FROM requests
           WHERE spawned_task_id=%s AND status='accepted' FOR UPDATE""", (tid,))
    stranded = cur.fetchall()
    fired = []
    for req in stranded:
        rid = str(req["id"])
        note = (f"[auto-answered by the #56 backstop] the accepter's task {tid} reached a terminal "
                f"state without an explicit report-back. See that task for the result/output.")
        cur.execute(
            "UPDATE requests SET status='answered', response=%s, responded_at=now() WHERE id=%s",
            (note, rid))
        _publish_event(cur, str(container_id), str(req["requester_id"]), "request_answered",
                       {"request_id": rid, "preview": note[:120],
                        "originating_task_id": (str(req["originating_task_id"])
                                                if req["originating_task_id"] else None),
                        "backstop": True})
        log_event(cur, container_id, "system", None, "request", rid, "auto_answered",
                  {"reason": "backstop: accepter task reached terminal state while request "
                             "still 'accepted' (no report-back)", "task_id": str(tid)})
        fired.append(rid)
    return fired


def _complete_and_unblock(cur, container_id, tid):
    """#298: the SHARED completion mechanics used by BOTH the human /verify (approve branch) and
    the full-autonomy /done path. Extracted so the two cannot drift — a single edit here changes
    both completion routes (a drift tooth in the tests proves it). Mechanics ONLY: it marks the
    task completed, unblocks every downstream task whose deps are now all satisfied (publishing the
    container-wide + per-assignee `task_ready` wakes), and completes the container if THIS was the
    root. It does NOT emit the verified / task_verified audit + wake events — each caller owns its
    own audit trail (a human verification vs an engine auto-completion are different events).
    Returns the list of newly-unblocked downstream task ids."""
    # GH #56 (Point 5): if THIS task was the accepter's spawned task and its originating request is
    # still 'accepted' (forgot to report back), auto-answer it now so the loop never strands. Covers
    # both completion routes that funnel through here (full-autonomy /done and the human /verify
    # approve branch). Usually a no-op (the request was already answered by the report-back).
    _backstop_stranded_request(cur, container_id, tid)
    cur.execute(
        "UPDATE tasks SET status='completed', completed_at=now() WHERE id=%s", (tid,))
    # unblock downstream tasks whose deps are now all completed
    cur.execute(
        """SELECT DISTINCT td.task_id
           FROM task_dependencies td
           WHERE td.depends_on_id = %s""", (tid,))
    downstream = [str(r["task_id"]) for r in cur.fetchall()]
    unblocked = []
    for dst in downstream:
        cur.execute(
            """SELECT 1
               FROM task_dependencies td
               JOIN tasks dep ON dep.id = td.depends_on_id
               WHERE td.task_id=%s AND dep.status <> 'completed'
               LIMIT 1""", (dst,))
        if not cur.fetchone():
            cur.execute(
                "UPDATE tasks SET status='ready' WHERE id=%s AND status='pending'", (dst,))
            if cur.rowcount:
                unblocked.append(dst)
                log_event(cur, container_id, "system", None,
                          "task", dst, "status_changed",
                          {"to": "ready", "reason": "deps satisfied"})
    for dst in unblocked:
        # Container-wide task_ready (dashboards / unassigned-pool pickup).
        _publish_event(cur, str(container_id), None, "task_ready", {"task_id": dst})
        # Epic A: a newly-ready ASSIGNED task ALSO gets a task_ready targeted at its assignee
        # so the daemon can wake its owner to auto-start it.
        cur.execute(
            "SELECT DISTINCT agent_id FROM agent_tasks WHERE task_id=%s", (dst,))
        for ar in cur.fetchall():
            _publish_event(cur, str(container_id), str(ar["agent_id"]),
                           "task_ready", {"task_id": dst, "assigned": True})

    # Did this complete the root? If so, complete the container.
    cur.execute("SELECT is_root, container_id FROM tasks WHERE id=%s", (tid,))
    tr = cur.fetchone()
    if tr["is_root"]:
        cur.execute(
            "UPDATE containers SET status='completed', completed_at=now() "
            "WHERE id=%s AND status<>'completed'", (tr["container_id"],))
        if cur.rowcount:
            log_event(cur, tr["container_id"], "system", None,
                      "container", tr["container_id"], "status_changed",
                      {"to": "completed", "reason": "root task verified"})
    return unblocked


@app.post("/api/tasks/{tid}/done", status_code=200)
def mark_done(tid: str, body: TaskDone):
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    if not _valid_uuid(body.agent_id):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        t = _require_task(cur, tid)
        _reject_if_retired(cur, body.agent_id)   # ISS-51 [P1]
        _require_container_active(cur, str(t["container_id"]), body.agent_id)   # GH #24
        # Issue #11: root task is a sentinel for container completion — only
        # the human verifies it via /orcha-verify <root_tid>. An agent should
        # never be able to mark it done, even if assignment somehow happened.
        if t["is_root"]:
            raise HTTPException(
                409, "this is the container's root task — agents cannot mark it done. "
                "Only /orcha-verify by the human flips it to completed (and the container along with it)."
            )
        # Item 4 (review): blocked tasks shouldn't flip done — blocked means
        # deps not satisfied, so completion would skip the dependency gate.
        if t["status"] != "in_progress":
            raise HTTPException(409, f"task is '{t['status']}', not 'in_progress' — can't mark done")
        # Item 3 (review): only an assignee can mark a task done. Without this
        # check anyone with the task UUID could flip the state.
        cur.execute(
            "SELECT 1 FROM agent_tasks WHERE agent_id=%s AND task_id=%s LIMIT 1",
            (body.agent_id, tid),
        )
        if not cur.fetchone():
            raise HTTPException(403, "this agent isn't assigned to that task — cannot mark it done")
        # #298: the ONE engine-enforced autonomy gate. The container's autonomy_level decides the
        # terminal state of a /done:
        #   plan | pr -> needs_verification (a human verifies — today's behavior, the safe default)
        #   full      -> the task AUTO-COMPLETES (no human in the loop) via the SAME
        #               _complete_and_unblock path /verify's approve branch uses, so a
        #               full-autonomy completion is indistinguishable from a verified one
        #               (downstream unblock + wakes + root→container). The free-text per-task
        #               protocol.autonomy is DELIBERATELY ignored here — an unvalidated string
        #               must never widen the hard gate; only this enum column can auto-complete.
        cur.execute("SELECT autonomy_level FROM containers WHERE id=%s", (t["container_id"],))
        level = cur.fetchone()["autonomy_level"]
        result_json = json.dumps({"result": body.result, "by_agent_id": body.agent_id})
        cur.execute(
            "UPDATE agent_tasks SET assignment_status='done' WHERE agent_id=%s AND task_id=%s",
            (body.agent_id, tid),
        )
        if level == "full":
            cur.execute("UPDATE tasks SET result=%s::jsonb WHERE id=%s", (result_json, tid))
            unblocked = _complete_and_unblock(cur, t["container_id"], tid)
            bump_agent(cur, body.agent_id)
            recompute_agent_status(cur, body.agent_id)
            log_event(cur, t["container_id"], "ai", body.agent_id, "task", tid,
                      "status_changed",
                      {"to": "completed", "autonomy_level": "full",
                       "auto_completed": True, "unblocked": unblocked})
            conn.commit()
            return {"task_id": tid, "status": "completed",
                    "auto_completed": True, "unblocked": unblocked}
        cur.execute(
            "UPDATE tasks SET status='needs_verification', result=%s::jsonb WHERE id=%s",
            (result_json, tid),
        )
        # GH #56 (Point 5): plan/pr autonomy parks the task at needs_verification (the full branch
        # above auto-completes via _complete_and_unblock, which runs the same backstop). If this is
        # an accepter's spawned task and its originating request is still 'accepted', auto-answer it
        # so the requester's loop closes even when the accepter forgot the report-back.
        _backstop_stranded_request(cur, t["container_id"], tid)
        bump_agent(cur, body.agent_id)
        recompute_agent_status(cur, body.agent_id)
        log_event(cur, t["container_id"], "ai", body.agent_id, "task", tid,
                  "status_changed", {"to": "needs_verification", "autonomy_level": level})
        conn.commit()
    return {"task_id": tid, "status": "needs_verification"}


@app.post("/api/tasks/{tid}/assign", status_code=200)
def assign_task(tid: str, body: AssignTask):
    """B5: assign an EXISTING task to an agent and wake them — unblocks O4 (assign-from-detail).

    Actor: a human OR a dispatching AI orchestrator (#327 — matches create_task, which already
    lets any AI assign-at-create; an AI actor is held to the same container-active + not-retired
    safeguards). The task lands
    'ready' when its deps are satisfied (a ready + assigned task is an auto-start wake target, so
    we publish a targeted `task_assigned` event and the daemon wakes the assignee to claim it via
    /orcha-next); it stays 'pending' when deps are unmet — NOT woken now, because the existing
    dep-unblock path delivers a targeted `task_ready` to the assignee when its deps clear (waking
    an assignee to a non-ready task would just no-op, the ISS-55 failure mode).

    `reassign=false` (default): refuse (409) if the task already has a DIFFERENT active assignee.
    `reassign=true`: release the prior active assignee(s) first (the same DELETE retire uses —
    'done' history rows are untouched), then assign. Re-asserting the SAME active assignee is an
    idempotent no-op (an in-progress task is never disturbed)."""
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    if not _valid_uuid(body.agent_id):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        t = _require_task(cur, tid)
        cid = str(t["container_id"])
        # #327: the AI orchestrator may dispatch (assign/reassign) an EXISTING task. This is the
        # SAME state change create_task already lets any kind='ai' make at create-time (its
        # `assignee_alias` is not human-gated), so locking assign-existing behind a human was an
        # internal inconsistency, not a real privilege boundary. Open the gate to AI, then apply
        # the SAME actor safeguards create_task enforces: no dispatch on a paused/stopped
        # container, none by a retired agent. (Both helpers pass a human actor straight through.)
        actor = _require_kind(cur, body.actor_agent_id, ("human", "ai"))   # Orcha#30 + #327
        _require_container_active(cur, cid, body.actor_agent_id)   # GH #24 (human actor passes through)
        _reject_if_retired(cur, body.actor_agent_id)   # ISS-51
        if t["is_root"]:
            raise HTTPException(409, "the root task cannot be assigned — only the human verifies it")
        # Terminal states — including 'cancelled' (cancel_task sets it; verify_task refuses it).
        # Assignment must NOT resurrect a finished/cancelled task back to ready/pending. [review P1]
        if t["status"] in ("completed", "needs_verification", "cancelled"):
            raise HTTPException(409, f"task is '{t['status']}' — cannot assign a finished/cancelled task")
        # Assignee must be a live AI agent in this container (humans don't poll /next — Orcha#30).
        cur.execute("SELECT kind, container_id, alias, terminated_at FROM agents WHERE id=%s",
                    (body.agent_id,))
        a = cur.fetchone()
        if not a:
            raise HTTPException(404, f"agent {body.agent_id} not found")
        if str(a["container_id"]) != cid:
            raise HTTPException(409, "agent is not in the same container as the task")
        if a["terminated_at"] is not None:
            raise HTTPException(409, "agent is retired and cannot be assigned work")
        if a["kind"] != "ai":
            raise HTTPException(409, f"can only assign tasks to AI agents; agent is kind='{a['kind']}'")

        # Is the target ALREADY an active assignee? (idempotency / don't disturb in-progress work)
        cur.execute("SELECT assignment_status FROM agent_tasks WHERE task_id=%s AND agent_id=%s",
                    (tid, body.agent_id))
        ex = cur.fetchone()
        target_active = bool(ex and ex["assignment_status"] in ("assigned", "accepted", "working"))

        # Other ACTIVE assignees (the reassign gate).
        cur.execute(
            """SELECT agent_id FROM agent_tasks
               WHERE task_id=%s AND agent_id <> %s
                 AND assignment_status IN ('assigned','accepted','working')""",
            (tid, body.agent_id),
        )
        prior = [str(r["agent_id"]) for r in cur.fetchall()]
        if target_active and not prior:
            # Already assigned to this agent and nobody else holds it → idempotent no-op.
            conn.commit()
            return {"task_id": tid, "agent_id": body.agent_id, "alias": a["alias"],
                    "status": t["status"], "assignment_status": ex["assignment_status"],
                    "woke": False, "released_prior": None}
        released_prior = None
        if prior:
            if not body.reassign:
                raise HTTPException(
                    409, "task already has a different active assignee — pass reassign=true to reassign")
            cur.execute(
                """DELETE FROM agent_tasks
                   WHERE task_id=%s AND agent_id <> %s
                     AND assignment_status IN ('assigned','accepted','working')""",
                (tid, body.agent_id),
            )
            for pid in prior:
                recompute_agent_status(cur, pid)
                _publish_event(cur, cid, pid, "task_unassigned",
                               {"task_id": tid, "by_id": body.actor_agent_id,
                                "by_kind": actor["kind"]})
            released_prior = prior

        # Ready vs pending is a function of dependency satisfaction (mirror the verify-unblock check).
        cur.execute(
            """SELECT 1 FROM task_dependencies td
               JOIN tasks dep ON dep.id = td.depends_on_id
               WHERE td.task_id=%s AND dep.status <> 'completed' LIMIT 1""",
            (tid,),
        )
        new_status = "pending" if cur.fetchone() else "ready"
        # (Re)assignment resets the task so the assignee claims it cleanly — started_at clears
        # until /orcha-next stamps it. NOT bumping the assignee's heartbeat: that would shrink
        # idle_seconds and make wake-scan think they're active, suppressing the very wake we want.
        cur.execute("UPDATE tasks SET status=%s, started_at=NULL WHERE id=%s", (new_status, tid))
        cur.execute(
            """INSERT INTO agent_tasks (agent_id, task_id, assignment_status)
               VALUES (%s, %s, 'assigned')
               ON CONFLICT (agent_id, task_id) DO UPDATE SET assignment_status='assigned'""",
            (body.agent_id, tid),
        )
        recompute_agent_status(cur, body.agent_id)
        # Wake-wiring: a ready+assigned task is an auto-start target → targeted task_assigned wakes
        # the assignee (daemon). A pending task waits for the dep-unblock task_ready instead.
        woke = False
        if new_status == "ready":
            _publish_event(cur, cid, body.agent_id, "task_assigned",
                           {"task_id": tid, "title": t["title"], "via": "B5 direct assignment"})
            woke = True
        log_event(cur, cid, actor["kind"], body.actor_agent_id, "task", tid, "assigned",
                  {"agent_id": body.agent_id, "alias": a["alias"], "status": new_status,
                   "reassigned_from": released_prior})
        conn.commit()
    return {"task_id": tid, "agent_id": body.agent_id, "alias": a["alias"],
            "status": new_status, "assignment_status": "assigned",
            "woke": woke, "released_prior": released_prior}


def _deps_unmet(cur, tid: str) -> bool:
    """#326: true if the task has a dependency that is not yet 'completed' (mirror the
    verify-unblock / assign dependency check — a task with unmet deps is 'pending', not 'ready')."""
    cur.execute(
        """SELECT 1 FROM task_dependencies td
           JOIN tasks dep ON dep.id = td.depends_on_id
           WHERE td.task_id=%s AND dep.status <> 'completed' LIMIT 1""",
        (tid,),
    )
    return cur.fetchone() is not None


@app.post("/api/tasks/{tid}/readiness", status_code=200)
def set_task_readiness(tid: str, body: TaskReadiness):
    """#326 (B3): flip a task between 'not_ready' (HELD — design-gated, excluded from the
    ready-queue + not self-claimable via /orcha-next) and dispatchable.

    HUMAN-AUTHORITY gated (Orcha#30 / #327: an AI cannot yet flip readiness). Allowed transitions:
      ready=false  HOLD:    'ready' or 'pending' -> 'not_ready'  (idempotent if already not_ready)
      ready=true   RELEASE: 'not_ready' -> 'ready' (or 'pending' if its deps aren't satisfied)
    Refused (409) for the root task and for in_progress / terminal states (completed,
    needs_verification, cancelled) — you don't hold work someone is building, nor resurrect a
    finished/cancelled task. started_at clears on a hold so a later release claims it cleanly."""
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_kind(cur, body.actor_agent_id, ("human",))   # Orcha#30 / #327: human-only flip
        t = _require_task(cur, tid)
        cid = str(t["container_id"])
        if t["is_root"]:
            raise HTTPException(409, "the root task has no readiness to flip")
        cur_status = t["status"]
        if body.ready:
            # RELEASE -> dispatchable. Idempotent if already ready/pending.
            if cur_status in ("ready", "pending"):
                conn.commit()
                return {"task_id": tid, "status": cur_status, "already": True}
            if cur_status != "not_ready":
                raise HTTPException(409, f"task is '{cur_status}', not 'not_ready' — nothing to release")
            new_status = "pending" if _deps_unmet(cur, tid) else "ready"
        else:
            # HOLD -> not_ready. Idempotent if already held.
            if cur_status == "not_ready":
                conn.commit()
                return {"task_id": tid, "status": "not_ready", "already": True}
            if cur_status not in ("ready", "pending"):
                raise HTTPException(
                    409, f"task is '{cur_status}' — only a ready/pending task can be held as not_ready")
            new_status = "not_ready"
        cur.execute("UPDATE tasks SET status=%s, started_at=NULL WHERE id=%s", (new_status, tid))
        log_event(cur, cid, "human", body.actor_agent_id, "task", tid, "readiness_set",
                  {"from": cur_status, "to": new_status})
        # Releasing an ASSIGNED held task makes it an auto-start target -> wake the assignee.
        if new_status == "ready":
            cur.execute(
                """SELECT agent_id FROM agent_tasks
                   WHERE task_id=%s AND assignment_status IN ('assigned','accepted','working')""",
                (tid,),
            )
            for r in cur.fetchall():
                _publish_event(cur, cid, str(r["agent_id"]), "task_ready",
                               {"task_id": tid, "title": t["title"], "via": "readiness release"})
        conn.commit()
    return {"task_id": tid, "status": new_status, "already": False}


@app.post("/api/tasks/{tid}/unassign", status_code=200)
def unassign_task(tid: str, body: TaskUnassign):
    """#326 (B2): clear the active assignee(s) so the task returns to the ready queue (owner==null).

    HUMAN-AUTHORITY gated (Orcha#30 — a deliberate dispatch reset; pairs with #327 AI-can't-assign).
    Releases every active agent_tasks row (the same DELETE /assign-reassign and /retire use — 'done'
    history rows are untouched) and, if the task was in_progress, returns it to 'ready' (or 'pending'
    if its deps aren't satisfied) so another agent can claim it. Idempotent no-op (200) when the task
    already has no active assignee. Refused (409) for the root task and terminal states."""
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_kind(cur, body.actor_agent_id, ("human",))   # Orcha#30: dispatch reset is a human action
        t = _require_task(cur, tid)
        cid = str(t["container_id"])
        if t["is_root"]:
            raise HTTPException(409, "the root task cannot be unassigned — only the human verifies it")
        if t["status"] in ("completed", "needs_verification", "cancelled"):
            raise HTTPException(409, f"task is '{t['status']}' — cannot unassign a finished/cancelled task")
        cur.execute(
            """SELECT agent_id FROM agent_tasks
               WHERE task_id=%s AND assignment_status IN ('assigned','accepted','working')""",
            (tid,),
        )
        active = [str(r["agent_id"]) for r in cur.fetchall()]
        if not active:
            conn.commit()
            return {"task_id": tid, "status": t["status"], "released": [], "already": True}
        cur.execute(
            """DELETE FROM agent_tasks
               WHERE task_id=%s AND assignment_status IN ('assigned','accepted','working')""",
            (tid,),
        )
        # An in_progress task with no assignee left returns to the queue; a ready/pending/not_ready
        # task keeps its status (it just loses its owner). started_at clears so a reclaim is clean.
        new_status = t["status"]
        if t["status"] == "in_progress":
            new_status = "pending" if _deps_unmet(cur, tid) else "ready"
            cur.execute("UPDATE tasks SET status=%s, started_at=NULL WHERE id=%s", (new_status, tid))
        for pid in active:
            recompute_agent_status(cur, pid)
            _publish_event(cur, cid, pid, "task_unassigned",
                           {"task_id": tid, "by_human_id": body.actor_agent_id})
        log_event(cur, cid, "human", body.actor_agent_id, "task", tid, "unassigned",
                  {"released": active, "status": new_status})
        conn.commit()
    return {"task_id": tid, "status": new_status, "released": active, "already": False}


@app.patch("/api/tasks/{tid}/protocol", status_code=200)
def update_task_protocol(tid: str, body: ProtocolUpdate):
    """SPEC-4: set/clear the per-task working agreement (review_chain, handoff_to, autonomy,
    notes). Audit-logged. Actor: a human OR a dispatching AI orchestrator (#327) — an AI may
    edit review_chain/handoff_to/notes (the coordination dials), but `autonomy` STAYS human-only:
    it's the human's risk dial, so an AI editing it would be self-granting privilege (403). PARTIAL
    update — only the keys explicitly sent are merged into the existing protocol; omitted keys are
    preserved; send "" to clear a key. Returns the full merged protocol so the panel re-renders."""
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        actor = _require_kind(cur, body.actor_agent_id, ("human", "ai"))  # Orcha#30 + #327
        t = _require_task(cur, tid)
        _require_container_active(cur, str(t["container_id"]), body.actor_agent_id)   # GH #24
        _reject_if_retired(cur, body.actor_agent_id)   # ISS-51

        # Only the keys the caller actually sent (exclude_unset) — minus the actor — are applied.
        changed = body.model_dump(exclude_unset=True)
        changed.pop("actor_agent_id", None)
        if not changed:
            raise HTTPException(400, "no protocol fields supplied")
        # #327: autonomy edits stay human-only — autonomy is the human's risk dial, so an AI
        # editing it would be self-granting privilege. AI may freely edit the coordination keys.
        if actor["kind"] != "human" and "autonomy" in changed:
            raise HTTPException(403, "autonomy is the human's risk dial — only a human may edit it")

        cur.execute("SELECT protocol FROM tasks WHERE id=%s", (tid,))
        existing = cur.fetchone()["protocol"] or {}
        merged = {**existing, **changed}    # partial merge; sent keys win, others preserved

        cur.execute("UPDATE tasks SET protocol=%s::jsonb WHERE id=%s",
                    (json.dumps(merged), tid))
        log_event(cur, t["container_id"], actor["kind"], body.actor_agent_id, "task", tid,
                  "protocol_updated", {"changed_keys": sorted(changed.keys())})
        conn.commit()
    return {"task_id": tid, "protocol": merged}


@app.post("/api/tasks/{tid}/verify", status_code=200)
def verify_task(tid: str, body: TaskVerify):
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_kind(cur, body.actor_agent_id, ("human",))  # Orcha#30
        t = _require_task(cur, tid)
        # Issue #11 follow-up: agents can't /done the root task, so it never
        # reaches needs_verification on its own. The human must be able to
        # /verify it from any non-terminal status to declare the container
        # complete. Non-root tasks still go through the regular gate.
        if t["status"] in ("completed", "cancelled"):
            raise HTTPException(409, f"task is already '{t['status']}'; nothing to verify")
        if not t["is_root"] and t["status"] != "needs_verification":
            raise HTTPException(409, f"task is '{t['status']}', not 'needs_verification'")

        if body.approve:
            # #298: completion mechanics (mark completed, unblock downstream, complete-root)
            # are SHARED with the full-autonomy /done path via _complete_and_unblock so the two
            # paths can't drift. The verify-specific audit + wake events stay here.
            unblocked = _complete_and_unblock(cur, t["container_id"], tid)

            # #288/ISS-59: an approval may carry a verifier NOTE (e.g. "please do the
            # follow-up X"). Mirror the rejection branch — persist it to the task thread and
            # carry it through the audit + the task_verified wake event — so a human-authored
            # note is NEVER silently dropped. This is what makes the wake-suppression bareness
            # rule work: _triage_hint_for sees the feedback and triages tier=llm (note read by
            # an LLM), instead of classifying a feedback-stripped payload as a bare FYI and
            # suppressing the wake.
            if body.feedback:
                cur.execute(
                    "INSERT INTO task_messages (task_id, author_id, body) VALUES (%s, NULL, %s)",
                    (tid, f"[verification approved] {body.feedback}"),
                )
            log_event(cur, t["container_id"], "human", None, "task", tid, "verified",
                      {"approved": True, "unblocked": unblocked,
                       "feedback": body.feedback,
                       "verifier_human_id": body.actor_agent_id})
            # Notify the assignees their work was approved + any newly-ready downstream
            cur.execute(
                "SELECT DISTINCT agent_id FROM agent_tasks WHERE task_id=%s",
                (tid,),
            )
            for r in cur.fetchall():
                _publish_event(cur, str(t["container_id"]), str(r["agent_id"]),
                               "task_verified",
                               {"task_id": tid, "approved": True, "feedback": body.feedback})
            # (downstream task_ready wakes + root→container completion are published inside
            # _complete_and_unblock above — shared with the full-autonomy /done path.)
            conn.commit()
            return {"task_id": tid, "status": "completed", "unblocked": unblocked}
        else:
            cur.execute(
                "UPDATE tasks SET status='in_progress' WHERE id=%s",
                (tid,),
            )
            # Item 2 (review): undo the agent_tasks done flag from /done so the
            # original assignee is "actively working" again. Without this, the
            # task is in_progress with no active assignee — orphaned.
            cur.execute(
                "UPDATE agent_tasks SET assignment_status='working' "
                "WHERE task_id=%s AND assignment_status='done' RETURNING agent_id",
                (tid,),
            )
            restored = [str(r["agent_id"]) for r in cur.fetchall()]
            for aid in restored:
                recompute_agent_status(cur, aid)
            if body.feedback:
                cur.execute(
                    "INSERT INTO task_messages (task_id, author_id, body) VALUES (%s, NULL, %s)",
                    (tid, f"[verification rejected] {body.feedback}"),
                )
            log_event(cur, t["container_id"], "human", None, "task", tid, "verified",
                      {"approved": False, "feedback": body.feedback,
                       "reassigned_to_agent_ids": restored,
                       "verifier_human_id": body.actor_agent_id})
            for aid in restored:
                _publish_event(cur, str(t["container_id"]), aid, "task_verified",
                               {"task_id": tid, "approved": False, "feedback": body.feedback})
            conn.commit()
            return {"task_id": tid, "status": "in_progress", "feedback": body.feedback,
                    "restored_assignee_agent_ids": restored}


@app.post("/api/tasks/{tid}/cancel", status_code=200)
def cancel_task(tid: str, body: TaskCancel):
    """B7 (ISS-23) + #327: force-close a task. A human OR a dispatching AI orchestrator may cancel
    ANY non-root task. Cancelling a task owned by SOMEONE ELSE is "forced" — kind-agnostic now: the
    actor (human or AI) MUST give a reason, which is routed to each displaced owner via the B0
    decision primitive (+ a path-forward poke) so they learn why. An assignee cancelling its own
    task needs no reason. (Was: only a human could force-cancel; a non-assignee AI got a 403.)"""
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    if not _valid_uuid(body.actor_agent_id):
        raise HTTPException(400, "actor_agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        t = _require_task(cur, tid)
        _require_container_active(cur, str(t["container_id"]), body.actor_agent_id)   # GH #24 (human may still cancel)
        _reject_if_retired(cur, body.actor_agent_id)   # ISS-51 (#327: AI may now cancel — hold it to the same bar)
        # Review P2: the root sentinel task must never be cancelled. Cancelling it leaves the
        # container stuck 'active' AND wedges the "root verify completes the container" path
        # (verify rejects a cancelled task). Direct the human to cancel the container instead.
        if t["is_root"]:
            raise HTTPException(409, "the root task can't be cancelled; cancel the container via "
                                     "POST /api/containers/{cid}/status {\"status\":\"cancelled\"}")
        cur.execute("SELECT kind FROM agents WHERE id=%s", (body.actor_agent_id,))
        arow = cur.fetchone()
        if not arow:
            raise HTTPException(404, f"agent {body.actor_agent_id} not found")
        is_human = arow["kind"] == "human"
        # who owns the task = its assignees
        cur.execute("SELECT agent_id FROM agent_tasks WHERE task_id=%s", (tid,))
        assignees = [str(r["agent_id"]) for r in cur.fetchall()]
        is_assignee = body.actor_agent_id in assignees
        # #327: any kind='ai' orchestrator (not just an assignee) may now cancel — mirroring
        # assign_task. The old "non-assignee non-human → 403" guard is removed; the reason-required
        # + owner-poke path below (now kind-agnostic) is what keeps a force-cancel accountable.
        # idempotent / illegal-transition
        if t["status"] == "cancelled":
            return {"task_id": tid, "status": "cancelled", "already_cancelled": True}
        if t["status"] == "completed":
            raise HTTPException(409, "task is 'completed' — cannot cancel")
        # B7.2 + #327: cancelling a task owned by someone ELSE is "forced" and requires a reason
        # (routed to the owner). Kind-agnostic: a human is never an assignee, so `not is_assignee`
        # is True for humans → this stays identical for the human case while also covering an AI
        # orchestrator cancelling a teammate's task. API-enforced, not only the UI.
        reason = (body.reason or "").strip()
        others = [a for a in assignees if a != body.actor_agent_id]
        forced = (not is_assignee) and len(others) > 0
        if forced and not reason:
            raise HTTPException(422, {"error": "reason_required",
                                      "detail": "a reason is required when cancelling another agent's task"})
        cur.execute(
            "UPDATE tasks SET status='cancelled', completed_at=now() WHERE id=%s", (tid,))
        # Review P2: clear the now-stale assignments so assignees don't stay 'working'.
        # recompute_agent_status counts assigned|accepted|working rows regardless of the
        # task's status, so a cancelled task would otherwise pin its assignee 'working'.
        # 'done' is the codebase's terminal assignment state (same value the verify/done path uses).
        cur.execute(
            "UPDATE agent_tasks SET assignment_status='done' "
            "WHERE task_id=%s AND assignment_status IN ('assigned','accepted','working')", (tid,))
        log_event(cur, t["container_id"], ("human" if is_human else "ai"), body.actor_agent_id,
                  "task", tid, "cancelled", {"by_human": is_human, "forced": forced})
        for aid in assignees:
            bump_agent(cur, aid)
            recompute_agent_status(cur, aid)
        # Route the reason to each OWNING assignee that isn't the actor.
        if forced:
            for owner in others:
                _route_close_reason(cur, t["container_id"], "task_close", tid, reason,
                                    body.actor_agent_id, owner)
                # ISS-42 (B12): the routed decision wakes the owner but carries no surfaced content,
                # so a cancelled owner would wake to nothing actionable (the dead-end). Poke them with
                # the reason + closure so they re-engage knowing it's closed and what they can do next.
                _poke_path_forward(
                    cur, t["container_id"], owner, body.actor_agent_id,
                    f"Your task \"{t['title']}\" (id {tid}) was cancelled by "
                    f"{'a human' if is_human else 'the orchestrator'}: {reason}. It's "
                    f"closed — no further work is needed on it. If a follow-up is warranted, propose a "
                    f"new task (/orcha-task-new) or raise it with your coordinator.")
            # ISS-48 (review P3): mirror the close into the task thread ONCE — _route_close_reason
            # runs per-owner (one decision row + decision_made each), but the thread message is
            # task-level, so a multi-assignee close must not stack identical [DECISION] rows.
            _post_decision_to_thread(cur, "task_close", tid, "reject", reason, body.actor_agent_id)
        conn.commit()
    return {"task_id": tid, "status": "cancelled",
            "forced": forced,                             # #327: forced over ANY other owner (human or AI)
            "forced_by_human": forced and is_human,       # back-compat: precise "a human forced this"
            "owners_poked": len(others) if forced else 0}


@app.get("/api/tasks/{tid}/close-implications")
def close_implications(tid: str):
    """Epic B P2 (READ-ONLY): the blast radius of authoritatively closing/completing
    a task, so the portal can show a confirm summary BEFORE the human acts. Pure
    SELECTs — mutates nothing. Aggregates: downstream tasks (and whether completing
    THIS one would unblock each), agents actively working it, the request that
    spawned it (provenance), and still-open requests its assignees have in flight
    (would be orphaned). `completes_container` flags the root task, whose approval
    completes the whole container (see verify_task).
    """
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    with db_cursor() as (_, cur):
        t = _require_task(cur, tid)

        # 1) downstream tasks that depend on this one, with a would-unblock test:
        #    completing THIS task readies a downstream only if all its OTHER deps
        #    are already completed and it's still pending.
        cur.execute(
            """SELECT d.id, d.title, d.status
               FROM task_dependencies td JOIN tasks d ON d.id = td.task_id
               WHERE td.depends_on_id = %s ORDER BY d.created_at""", (tid,))
        downstream, would_unblock, still_blocked = [], 0, 0
        for d in cur.fetchall():
            did = str(d["id"])
            cur.execute(
                """SELECT 1 FROM task_dependencies x JOIN tasks dep ON dep.id = x.depends_on_id
                   WHERE x.task_id = %s AND x.depends_on_id <> %s AND dep.status <> 'completed'
                   LIMIT 1""", (did, tid))
            unblocks = cur.fetchone() is None and d["status"] == "pending"
            if unblocks:
                would_unblock += 1
            elif d["status"] in ("pending", "blocked"):
                still_blocked += 1
            downstream.append({"task_id": did, "title": d["title"],
                               "status": d["status"], "would_unblock": unblocks})

        # 2) agents actively working it
        cur.execute(
            """SELECT a.id, a.alias, at.assignment_status
               FROM agent_tasks at JOIN agents a ON a.id = at.agent_id
               WHERE at.task_id = %s AND at.assignment_status IN ('assigned','accepted','working')
               ORDER BY a.alias""", (tid,))
        in_flight = [{"agent_id": str(r["id"]), "alias": r["alias"],
                      "assignment_status": r["assignment_status"]} for r in cur.fetchall()]

        # 3) provenance: the request (if any) that spawned this task
        cur.execute(
            """SELECT r.id, r.status, ra.alias AS requester_alias
               FROM requests r LEFT JOIN agents ra ON ra.id = r.requester_id
               WHERE r.spawned_task_id = %s LIMIT 1""", (tid,))
        sr = cur.fetchone()
        spawned_from = ({"request_id": str(sr["id"]), "requester_alias": sr["requester_alias"],
                         "status": sr["status"]} if sr else None)

        # 4) still-open requests this task's assignees have in flight (orphan risk)
        cur.execute(
            """SELECT r.id, r.status, r.payload, ra.alias AS requester_alias, ta.alias AS target_alias
               FROM requests r
               LEFT JOIN agents ra ON ra.id = r.requester_id
               LEFT JOIN agents ta ON ta.id = r.target_id
               WHERE r.status IN ('open','answered')
                 AND r.requester_id IN (SELECT agent_id FROM agent_tasks WHERE task_id = %s)
               ORDER BY r.created_at""", (tid,))
        open_reqs = [{"request_id": str(r["id"]), "status": r["status"],
                      "requester_alias": r["requester_alias"], "target_alias": r["target_alias"],
                      "preview": (r["payload"] or "")[:120]} for r in cur.fetchall()]

    return {
        "task_id": tid, "title": t["title"], "status": t["status"], "is_root": t["is_root"],
        "downstream_tasks": downstream,
        "in_flight_agents": in_flight,
        "spawned_from_request": spawned_from,
        "open_requests_from_assignees": open_reqs,
        "summary": {
            "downstream_total": len(downstream),
            "would_unblock": would_unblock,
            "still_blocked": still_blocked,
            "in_flight_agents": len(in_flight),
            "open_requests": len(open_reqs),
            "completes_container": bool(t["is_root"]),
        },
    }


# ---------- requests (Phase 2 — info type only) ----------

class TaskRequestPayload(BaseModel):
    """Embedded inside a request when type='task' (Orcha#5, Phase 3)."""
    title: str = Field(..., max_length=MAX_NAME_LEN)
    description: Optional[str] = Field(default=None, max_length=MAX_DESC_LEN)
    definition_of_done: str = Field(..., max_length=MAX_DOD_LEN)
    priority: int = 100
    # GH #55: a task request may carry the per-task protocol (loop rules). It rides in the
    # request's `detail` JSONB (no schema change) and is read into the spawned task's protocol
    # on /accept-task — so a request-born task gets its loop rules without a follow-up PATCH.
    protocol: Optional[ProtocolFields] = None


class RequestCreate(BaseModel):
    requester_agent_id: str
    target_alias: Optional[str] = Field(default=None, max_length=64)   # mutually exclusive with target_agent_id
    target_agent_id: Optional[str] = None                                # ditto; both null → API picks the human via _pick_human() (Orcha#30)
    payload: str = Field(..., max_length=MAX_PAYLOAD_LEN)
    priority: int = 100
    expires_minutes: int = Field(default=60, ge=0, le=10080)             # cap at 7 days
    parent_request_id: Optional[str] = None                              # Orcha#1: chain off another request
    # GH #56 (Point 3): the task the REQUESTER was working on when it asked. Optional + agent-supplied
    # (never backend-guessed — a requester can have several tasks in progress). Null for conversation /
    # taskless asks. When present it is server-validated (must be a real task in this container the
    # requester participates in) and then rides the answer back so the requester wakes ON that task.
    originating_task_id: Optional[str] = None
    # Phase 3 (Orcha#5):
    type: str = Field(default="info", pattern="^(info|task)$")
    task: Optional[TaskRequestPayload] = None                            # required when type='task'


class RequestRespond(BaseModel):
    responder_agent_id: str
    response: str = Field(..., max_length=MAX_PAYLOAD_LEN)


class RequestActorBody(BaseModel):
    requester_agent_id: str
    reason: Optional[str] = Field(default=None, max_length=MAX_FEEDBACK_LEN)


class TaskRequestAccept(BaseModel):
    """Target agent accepts a task request. Creates the task, assigns, starts."""
    responder_agent_id: str
    note: Optional[str] = Field(default=None, max_length=MAX_FEEDBACK_LEN)


class TaskRequestReject(BaseModel):
    """Target agent rejects a task request."""
    responder_agent_id: str
    reason: str = Field(..., max_length=MAX_FEEDBACK_LEN)


class AgentSuggestion(BaseModel):
    """Requester suggests a new agent be created (after task-request rejection or directly)."""
    requester_agent_id: str
    proposed_alias: str = Field(..., max_length=64)
    proposed_role: str = Field(..., max_length=200)
    proposed_prompt: str = Field(..., max_length=MAX_PROMPT_LEN)
    rationale: str = Field(..., max_length=MAX_FEEDBACK_LEN)


class SuggestionDecision(BaseModel):
    """Human resolves an agent suggestion."""
    kind: str = Field(..., pattern="^(create|reassign|refuse)$")
    # for reassign: which existing agent gets the task
    target_alias: Optional[str] = Field(default=None, max_length=64)
    # for refuse: why
    reason: Optional[str] = Field(default=None, max_length=MAX_FEEDBACK_LEN)
    # for create: optional turn budget for the new agent (else default)
    turn_budget: Optional[int] = None
    actor_agent_id: str = Field(..., description="UUID of the human agent deciding (kind='human')")


class RequestConvert(BaseModel):
    """Convert an answered info request into a task (Phase 3)."""
    requester_agent_id: str
    title: str = Field(..., max_length=MAX_NAME_LEN)
    definition_of_done: str = Field(..., max_length=MAX_DOD_LEN)
    priority: int = 100
    assignee_alias: Optional[str] = Field(default=None, max_length=64)


@app.post("/api/containers/{cid}/requests", status_code=201)
def create_request(cid: str, body: RequestCreate):
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if not _valid_uuid(body.requester_agent_id):
        raise HTTPException(400, "requester_agent_id is not a valid UUID")

    with db_cursor() as (conn, cur):
        _require_container_active(cur, cid, body.requester_agent_id)   # GH #24 (was _require_container)
        req_ag = _require_agent(cur, body.requester_agent_id)
        _reject_if_retired(cur, body.requester_agent_id)   # ISS-51 [P1]
        if str(req_ag["container_id"]) != cid:
            raise HTTPException(400, "requester_agent_id belongs to a different container")

        target_id: Optional[str] = None
        target_alias: Optional[str] = None
        if body.target_agent_id and body.target_alias:
            raise HTTPException(400, "specify target_agent_id OR target_alias, not both")
        if body.target_agent_id:
            if not _valid_uuid(body.target_agent_id):
                raise HTTPException(400, "target_agent_id is not a valid UUID")
            tg = _require_agent(cur, body.target_agent_id)
            if str(tg["container_id"]) != cid:
                raise HTTPException(400, "target agent in a different container")
            target_id = body.target_agent_id
            target_alias = tg["alias"]
        elif body.target_alias:
            target_id = _resolve_alias(cur, cid, body.target_alias)
            target_alias = body.target_alias
        else:
            # Orcha#30: no target specified == escalate-to-human at birth.
            # We never write NULL into requests.target_id anymore; pick the human row.
            target_id = _pick_human(cur, cid)

        # parent_request_id handling (Orcha#1: request chains)
        parent_request_id: Optional[str] = None
        chain_depth: int = 0
        if body.parent_request_id:
            if not _valid_uuid(body.parent_request_id):
                raise HTTPException(400, "parent_request_id is not a valid UUID")
            cur.execute(
                "SELECT container_id, chain_depth, status, target_id "
                "FROM requests WHERE id=%s",
                (body.parent_request_id,),
            )
            parent = cur.fetchone()
            if not parent:
                raise HTTPException(404, f"parent request {body.parent_request_id} not found")
            if str(parent["container_id"]) != cid:
                raise HTTPException(400, "parent request belongs to a different container")
            # parent should ideally be open or answered — closed parents make the chain meaningless
            if parent["status"] in ("closed", "rejected"):
                raise HTTPException(
                    409, f"parent request is '{parent['status']}' — no point chaining off a finished request"
                )
            parent_request_id = body.parent_request_id
            chain_depth = (parent["chain_depth"] or 0) + 1

        # GH #56 (Point 3, FLAG 2b): validate a SUPPLIED originating_task_id before storing.
        # Null always passes untouched (conversation / taskless asks). When present it must be a
        # real task in THIS container that the requester participates in — a typo or an id pasted
        # from another project would otherwise route the answer's wake to nothing or the wrong
        # task, silently. Uses the looser participant check (not exact-one-in-progress).
        originating_task_id: Optional[str] = None
        if body.originating_task_id is not None:
            if not _valid_uuid(body.originating_task_id):
                raise HTTPException(400, "originating_task_id is not a valid UUID")
            if not _agent_participates_in_task(cur, cid, body.requester_agent_id, body.originating_task_id):
                raise HTTPException(
                    400,
                    "originating_task_id must be a task in this container that the requester "
                    "participates in (owns/assignee/creator/collaborator)",
                )
            originating_task_id = body.originating_task_id

        # Phase 3 (Orcha#5): type='task' carries a TaskRequestPayload in body.task
        # which gets stuffed into the JSONB `detail` column. The task itself is
        # only created on /accept-task.
        detail: Optional[dict] = None
        if body.type == "task":
            if body.task is None:
                raise HTTPException(400, "type='task' requires a `task` object (title, definition_of_done, priority)")
            detail = {
                "title": body.task.title,
                "description": body.task.description,
                "definition_of_done": body.task.definition_of_done,
                "priority": body.task.priority,
            }
            # GH #55: carry the optional protocol through the request so the spawned task
            # inherits its loop rules on accept (only the keys actually set are stored).
            if body.task.protocol is not None:
                proto_fields = body.task.protocol.model_dump(exclude_none=True)
                if proto_fields:
                    detail["protocol"] = proto_fields
        elif body.task is not None:
            raise HTTPException(400, "`task` field is only valid with type='task'")

        cur.execute(
            """INSERT INTO requests
                 (container_id, type, requester_id, target_id, priority, status,
                  payload, expires_at, parent_request_id, chain_depth, detail,
                  originating_task_id)
               VALUES (%s, %s, %s, %s, %s, 'open', %s,
                       now() + (%s || ' minutes')::interval, %s, %s, %s::jsonb, %s)
               RETURNING id, expires_at""",
            (cid, body.type, body.requester_agent_id, target_id, body.priority,
             body.payload, str(body.expires_minutes), parent_request_id, chain_depth,
             json.dumps(detail) if detail is not None else None,
             originating_task_id),
        )
        row = cur.fetchone()
        rid = str(row["id"])
        bump_agent(cur, body.requester_agent_id)
        recompute_agent_status(cur, body.requester_agent_id)  # → awaiting_request
        log_event(cur, cid, "ai", body.requester_agent_id, "request", rid, "created",
                  {"type": body.type, "target_alias": target_alias,
                   "priority": body.priority, "preview": body.payload[:120],
                   "parent_request_id": parent_request_id, "chain_depth": chain_depth,
                   "task_title": detail["title"] if detail else None})
        _publish_event(cur, cid, target_id, "request_created", {
            "request_id": rid, "type": body.type, "from_agent_id": body.requester_agent_id,
            "preview": body.payload[:120]
        })
        conn.commit()

    return {
        "request_id": rid,
        "type": body.type,
        "status": "open",
        "target_alias": target_alias,  # null when the request was born already targeting the human (Orcha#30)
        "expires_at": row["expires_at"].isoformat(),
        "parent_request_id": parent_request_id,
        "chain_depth": chain_depth,
        "originating_task_id": originating_task_id,  # GH #56: task the answer's wake will attach to (or null)
        "task": detail,  # null for info; full task body for type='task'
    }


def _require_request(cur, rid, for_update=False):
    # for_update locks the request row for the rest of the transaction. State-mutating
    # endpoints (respond/close/accept-task) MUST pass it: without the lock, two
    # overlapping at-least-once retries both read status='open' under READ COMMITTED
    # and both mutate — accept-task would spawn TWO tasks, respond would overwrite the
    # first answer. With FOR UPDATE the loser blocks until the winner commits, then
    # re-reads the committed terminal state and takes the idempotent branch.
    cur.execute(
        """SELECT id, container_id, type, status, requester_id, target_id,
                  payload, response, expires_at, parent_request_id, chain_depth,
                  detail, spawned_task_id, rejection_reason, originating_task_id
           FROM requests WHERE id=%s""" + (" FOR UPDATE" if for_update else ""), (rid,))
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, f"request {rid} not found")
    return r


@app.post("/api/requests/{rid}/respond", status_code=200)
def respond_request(rid: str, body: RequestRespond):
    if not _valid_uuid(rid):
        raise HTTPException(400, "request_id is not a valid UUID")
    if not _valid_uuid(body.responder_agent_id):
        raise HTTPException(400, "responder_agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        r = _require_request(cur, rid, for_update=True)   # lock: serialize overlapping retries
        _reject_if_retired(cur, body.responder_agent_id)   # ISS-51 [P1]
        _require_container_active(cur, str(r["container_id"]), body.responder_agent_id)   # GH #24
        # Orcha#30: target_id is never null now (humans are agents with rows).
        # Only the target — agent or human — may answer. Check actor FIRST so a wrong
        # actor always gets 403, regardless of the request's current status.
        if r["target_id"] is None or str(r["target_id"]) != body.responder_agent_id:
            raise HTTPException(403, "only the target agent may respond")
        # R2.3 idempotency: the correct target re-responding to an already-answered
        # request gets the current state (200), not a 409 — so an at-least-once retry
        # after a dropped response is a safe no-op. Other terminal states (closed,
        # accepted) are genuine illegal transitions and still 409.
        if r["status"] == "answered":
            return {"request_id": rid, "status": "answered", "already_answered": True,
                    "response": r["response"], "unblocks_parent": None}
        # GH #56 (Point 4): `accepted` is now a WAYPOINT, not a dead end. The accepter
        # (still the target) may post its real result to flip accepted → answered, which
        # fires the answer notification so the requester wakes on its originating_task_id.
        # The requester — not the accepter — later flips answered → closed (close_request).
        if r["status"] not in ("open", "accepted"):
            raise HTTPException(409, f"request is '{r['status']}', not 'open'/'accepted' — cannot respond")
        cur.execute(
            "UPDATE requests SET status='answered', response=%s, responded_at=now() WHERE id=%s",
            (body.response, rid),
        )
        bump_agent(cur, body.responder_agent_id)
        recompute_agent_status(cur, body.responder_agent_id)  # just acted
        # The requester might also need recomputation if this answered their only open ask
        recompute_agent_status(cur, str(r["requester_id"]))
        log_event(cur, r["container_id"], "ai", body.responder_agent_id,
                  "request", rid, "answered",
                  {"preview": body.response[:120],
                   "parent_request_id": str(r["parent_request_id"]) if r["parent_request_id"] else None,
                   "chain_depth": r["chain_depth"]})

        # If this answered request had a parent, surface it in the response so the requester
        # (who is the target of the parent) knows their parent task is now unblocked. The
        # requester sees this naturally via /orcha-outbox; the response field is a convenience
        # for callers who want to chain logic immediately.
        unblocks_parent = None
        if r["parent_request_id"]:
            cur.execute(
                """SELECT p.id, p.payload, p.status, t.alias AS target_alias
                   FROM requests p LEFT JOIN agents t ON t.id = p.target_id
                   WHERE p.id = %s""",
                (str(r["parent_request_id"]),),
            )
            parent = cur.fetchone()
            if parent:
                unblocks_parent = {
                    "parent_request_id": str(parent["id"]),
                    "parent_target_alias": parent["target_alias"],
                    "parent_status": parent["status"],
                    "parent_payload_preview": (parent["payload"] or "")[:120],
                }
        # GH #56 (Point 3 / FLAG 2a): carry originating_task_id on the answer event so the
        # requester's wake attaches to the task it asked on behalf of (wake-scan reads this →
        # the run is stamped against that task → activity surfaces on the task thread, and the
        # protocol loaded is that task's). Null for conversation/taskless asks (unchanged path).
        _publish_event(cur, str(r["container_id"]), str(r["requester_id"]), "request_answered",
                       {"request_id": rid, "preview": body.response[:120],
                        "originating_task_id": str(r["originating_task_id"]) if r["originating_task_id"] else None})
        conn.commit()
    return {"request_id": rid, "status": "answered", "unblocks_parent": unblocks_parent}


def _post_decision_to_thread(cur, subject_type, subject_id, decision, reason, actor_agent_id):
    """ISS-48: mirror a human-authority decision into the collaboration THREAD the target
    agent actually reads.

    Decisions were written ONLY to the `decisions` table + a `decision_made` event. But an
    agent's source of truth is the task thread (`task_messages`): on wake it re-reads the
    thread, and the approval/rejection was nowhere in it — so an approved agent re-posted its
    plan and waited forever (confirmed 2026-06-04: Invy task 070d631d approved twice, never
    produced a PR). This posts a structured, ATTRIBUTED decision message to the task thread so
    the agent SEES the verdict and proceeds (resolves ISS-42's reject-reason gap too).

    Scope: only decisions whose subject is a TASK have a task thread (plan_approval, task_verify,
    task_close — subject_id is a task id). A request/checkpoint/dummy subject has no task thread,
    so we no-op for it (the existence check below also stops a non-task subject_id from ever
    hitting the task_messages FK). Attribution is the human decider's agent_id — NOT a null
    author, which the thread read path renders as a human free-text post (the ISS-43 mislabel).
    Returns the message id, or None when there's no task thread to post to."""
    if not _valid_uuid(str(subject_id)):
        return None
    cur.execute("SELECT container_id FROM tasks WHERE id=%s", (str(subject_id),))
    trow = cur.fetchone()
    if not trow:
        return None                       # subject isn't a task → no thread (request/checkpoint/…)
    cur.execute("SELECT alias FROM agents WHERE id=%s", (actor_agent_id,))
    arow = cur.fetchone()
    who = (arow["alias"] if arow else None) or "a human"
    verb = "APPROVED" if decision == "approve" else "REJECTED"
    body = f"[DECISION · {subject_type} = {verb} by {who}]"
    if reason:
        body += f" — {reason}"
    cur.execute(
        "INSERT INTO task_messages (task_id, author_id, body) VALUES (%s, %s, %s) RETURNING id",
        (str(subject_id), actor_agent_id, body),
    )
    mid = str(cur.fetchone()["id"])
    log_event(cur, trow["container_id"], "human", actor_agent_id, "task", str(subject_id),
              "decision_message",
              {"message_id": mid, "decision": decision, "subject_type": subject_type,
               "preview": body[:120]})
    return mid


def _route_close_reason(cur, container_id, subject_type, subject_id, reason,
                        actor_agent_id, target_agent_id):
    """B7/B0: persist a human's close/cancel REASON as a decision and route it to the
    OWNING agent so it learns WHY its item was force-closed on its next wake. Reuses the
    B0 `decisions` table + `decision_made` event verbatim; a force-close is modelled as
    decision='reject' (the human overrode/abandoned the item) carrying the reason."""
    cur.execute(
        """INSERT INTO decisions
             (container_id, subject_type, subject_id, decision, reason, actor_agent_id, target_agent_id)
           VALUES (%s, %s, %s, 'reject', %s, %s, %s)
           RETURNING id""",
        (container_id, subject_type, str(subject_id), reason, actor_agent_id, target_agent_id),
    )
    did = str(cur.fetchone()["id"])
    if target_agent_id:
        _publish_event(cur, str(container_id) if container_id else None, str(target_agent_id),
                       "decision_made",
                       {"decision_id": did, "subject_type": subject_type,
                        "subject_id": str(subject_id), "decision": "reject", "reason": reason})
    # NB: the task-thread mirror (ISS-48) is posted ONCE by the caller, not here — this helper
    # runs once PER owning assignee, so posting inside it duplicated the thread message on a
    # multi-assignee close (review P3).
    return did


@app.post("/api/requests/{rid}/close", status_code=200)
def close_request(rid: str, body: RequestActorBody):
    if not _valid_uuid(rid):
        raise HTTPException(400, "request_id is not a valid UUID")
    if not _valid_uuid(body.requester_agent_id):
        raise HTTPException(400, "requester_agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        r = _require_request(cur, rid, for_update=True)   # lock: serialize overlapping retries
        _require_container_active(cur, str(r["container_id"]), body.requester_agent_id)   # GH #24 (human may still close)
        # B7 (ISS-23): the actor may be the requester (owner) OR ANY human — the human is the
        # authoritative party and can abandon a stale request regardless of owner. Non-humans
        # stay owner-only and get a 403, regardless of status.
        cur.execute("SELECT kind FROM agents WHERE id=%s", (body.requester_agent_id,))
        arow = cur.fetchone()
        if not arow:
            raise HTTPException(404, f"agent {body.requester_agent_id} not found")
        is_human = arow["kind"] == "human"
        is_owner = str(r["requester_id"]) == body.requester_agent_id
        if not is_human and not is_owner:
            raise HTTPException(403, "only the requester (or a human) may close")
        # R2.3 idempotency: re-closing an already-closed request is a safe no-op (200).
        if r["status"] == "closed":
            return {"request_id": rid, "status": "closed", "already_closed": True}
        # Non-humans keep the answered-only rule; a human may force-close from any non-closed
        # status (authoritative abandon).
        if not is_human and r["status"] != "answered":
            raise HTTPException(409, f"request is '{r['status']}', not 'answered' — cannot close")
        # B7.2: a human closing a request they do NOT own must give a reason — it's routed to
        # the owner so it learns why (the API enforces this, not only the UI).
        reason = (body.reason or "").strip()
        forced = is_human and not is_owner
        if forced and not reason:
            raise HTTPException(422, {"error": "reason_required",
                                      "detail": "a reason is required when a human closes another agent's request"})
        cur.execute("UPDATE requests SET status='closed', closed_at=now() WHERE id=%s", (rid,))
        # Recompute the OWNER (requester) — its waiting_on changed.
        bump_agent(cur, str(r["requester_id"]))
        recompute_agent_status(cur, str(r["requester_id"]))
        log_event(cur, r["container_id"], ("human" if is_human else "ai"), body.requester_agent_id,
                  "request", rid, "closed", {"by_human": is_human, "forced": forced})
        if r["target_id"]:
            _publish_event(cur, str(r["container_id"]), str(r["target_id"]), "request_closed",
                           {"request_id": rid})
        if forced:
            _route_close_reason(cur, r["container_id"], "request_close", rid, reason,
                                body.requester_agent_id, str(r["requester_id"]))
        conn.commit()
    return {"request_id": rid, "status": "closed", "forced_by_human": forced}


class NudgeBody(BaseModel):
    """#60: a standalone request nudge — wakes whoever owns the NEXT ACTION, no state change."""
    actor_agent_id: str
    note: Optional[str] = Field(default=None, max_length=MAX_FEEDBACK_LEN)


def _task_request_context_block(detail) -> str:
    """#60: render a TASK request's ask — title / description / definition of done / protocol —
    into a nudge poke. A task request stores its ask in the JSONB `detail` column (see
    create_request); the only event that ever carried it (`request_created`) is consumed once
    the recipient drains its inbox. So an agent woken later by a context-less poke could not see
    what the task even is — it could not meaningfully accept or reject. This re-delivers the full
    ask verbatim in the wake prompt itself. Returns "" when there's nothing to show."""
    if not isinstance(detail, dict) or not detail:
        return ""
    lines = []
    title = (detail.get("title") or "").strip()
    if title:
        lines.append(f"Task: {title}")
    desc = (detail.get("description") or "").strip()
    if desc:
        lines.append(f"What's being asked: {desc}")
    dod = (detail.get("definition_of_done") or "").strip()
    if dod:
        lines.append(f"Definition of done: {dod}")
    proto = detail.get("protocol")
    if isinstance(proto, dict):
        proto_bits = []
        for key in ("review_chain", "handoff_to", "autonomy", "notes"):
            val = proto.get(key)
            val = val.strip() if isinstance(val, str) else val
            if val:
                proto_bits.append(f"{key.replace('_', ' ')}: {val}")
        if proto_bits:
            lines.append("Protocol — " + "; ".join(proto_bits))
    return ("\n\n" + "\n".join(lines)) if lines else ""


@app.post("/api/requests/{rid}/nudge", status_code=200)
def nudge_request(rid: str, body: NudgeBody):
    """#60: a STANDALONE wake-up for whoever owns the NEXT ACTION on a request — fully
    DECOUPLED from close. It NEVER changes the request's state (the handler does a SELECT
    only, never an UPDATE), so state invariance holds on every branch. The recipient is
    state-routed:
      • open      → the TARGET (they still owe the answer)
      • answered  → the REQUESTER (they must act on the answer or close it)
    Accepted (now a task — nudge the task, not the request) and the terminal states
    (rejected / converted_to_task / closed) are not actionable here → 409, no poke. Routing
    is total over the request status enum.

    Task-aware: for a type='task' request the poke is shaped to the actual next action — an OPEN
    task request directs the TARGET to accept/reject (not answer) and re-delivers the full task ask
    (title / description / definition of done / protocol) from the JSONB detail, since the original
    request_created event is consumed on first drain and an info-style "respond" prompt would be
    both the wrong verb and missing the context the agent needs to decide.

    Human-only (an operator wake action; the portal viewer is always human, the CLI resolves
    the acting human → else 403). When the routed recipient is a human (e.g. an escalated-to-
    human request, where the next action genuinely sits with a person) or the actor themselves,
    there's no agent to wake via a poke → 200 {nudged:false} as a clean no-op (no error, no
    state change). Delivery reuses the A3 `prompt` poke (`_poke_path_forward`): a directed
    prompt is surfaced verbatim into the recipient's wake/drain turn AND counts as pending work
    in wake-scan, so the agent re-engages."""
    if not _valid_uuid(rid):
        raise HTTPException(400, "request_id is not a valid UUID")
    if not _valid_uuid(body.actor_agent_id):
        raise HTTPException(400, "actor_agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        r = _require_request(cur, rid)   # SELECT-only (no FOR UPDATE): a nudge never mutates the request
        _require_container_active(cur, str(r["container_id"]), body.actor_agent_id)
        # Human-only: a nudge is an operator wake action.
        cur.execute("SELECT kind, alias FROM agents WHERE id=%s", (body.actor_agent_id,))
        arow = cur.fetchone()
        if not arow:
            raise HTTPException(404, f"agent {body.actor_agent_id} not found")
        if arow["kind"] != "human":
            raise HTTPException(403, "only a human may nudge a request")
        actor_alias = arow["alias"] or "a human"
        status = r["status"]
        # State routing — total over REQUEST_STATUSES.
        if status == "open":
            recipient_id, role = r["target_id"], "target"
        elif status == "answered":
            recipient_id, role = r["requester_id"], "requester"
        elif status == "accepted":
            # The next action moved from the request to the spawned task — nudge the task.
            raise HTTPException(409, "this request was accepted and became a task — "
                                     "nudge the task, not the request")
        else:  # rejected, converted_to_task, closed — terminal, nothing to nudge
            raise HTTPException(409, f"nothing to nudge: request is '{status}'")
        # No distinct AI to wake: the next action sits with a human (escalated-to-human, a
        # human target/requester, or a null target) or with the nudger themselves → clean no-op.
        recipient_id = str(recipient_id) if recipient_id else None
        recipient_is_human = False
        if recipient_id:
            cur.execute("SELECT kind FROM agents WHERE id=%s", (recipient_id,))
            rrow = cur.fetchone()
            recipient_is_human = bool(rrow) and rrow["kind"] == "human"
        if not recipient_id or recipient_is_human or recipient_id == body.actor_agent_id:
            return {"request_id": rid, "status": status, "nudged": False,
                    "nudged_role": role, "nudged_agent_id": None,
                    "reason": "a human owns the next action — nothing to wake"}
        # Wake-framed, state-appropriate directed prompt naming the nudger + rid8 + a 1-line preview.
        # Task-aware: an OPEN *task* request is accepted/rejected (NOT answered), and the poke carries
        # the full task ask (title / description / definition of done / protocol) so the woken agent
        # can decide even though the original request_created event was consumed on first drain.
        short_rid = rid[:8]
        is_task = r["type"] == "task"
        payload_preview = (str(r["payload"] or "").strip().splitlines() or [""])[0][:120]
        if role == "target":
            if is_task:
                message = (f'{actor_alias} nudged you about an OPEN task request you have not picked up '
                           f'yet. Request {short_rid}. Please accept it (/orcha-accept-task) or reject it '
                           f'(/orcha-reject-task).' + _task_request_context_block(r["detail"]))
            else:
                message = (f'{actor_alias} nudged you about an OPEN request you still owe an answer on. '
                           f'Request {short_rid}: "{payload_preview}". Please respond to it (/orcha-respond).')
        else:  # requester, on an answered request
            if is_task:
                detail = r["detail"] if isinstance(r["detail"], dict) else {}
                title = (detail.get("title") or "").strip()
                what = f' ("{title[:120]}")' if title else ""
                message = (f'{actor_alias} nudged you: a task request you sent{what} has been ANSWERED '
                           f'and is waiting on you to act on the result or close it (/orcha-close). '
                           f'Request {short_rid}.')
            else:
                message = (f'{actor_alias} nudged you: a request you sent has been ANSWERED and is waiting '
                           f'on you to act on the answer or close it. '
                           f'Request {short_rid}: "{payload_preview}".')
        note = (body.note or "").strip()
        if note:
            message += f' Note from {actor_alias}: {note}'
        _poke_path_forward(cur, str(r["container_id"]), recipient_id, body.actor_agent_id, message)
        # Audit only — NO status UPDATE, NO turn bump (an external poke, like triage-close).
        log_event(cur, r["container_id"], "human", body.actor_agent_id,
                  "request", rid, "nudged", {"by_human": True, "role": role})
        conn.commit()
    return {"request_id": rid, "status": status, "nudged": True,
            "nudged_role": role, "nudged_agent_id": recipient_id}


class TriageCloseBody(BaseModel):
    """#288 wake-suppression: the notifier daemon auto-closes an ANSWERED request whose answer was
    a pure ack (no actionable follow-up), so the requester is never spawned just to close it."""
    triage_reason: Optional[str] = Field(
        default=None, max_length=500,
        description="why the wake was suppressed (the triage verdict reason) — stamped into the "
                    "request_closed event JSONB so #289 can measure suppressions with no schema change")


@app.post("/api/requests/{rid}/triage-close", status_code=200)
def triage_close_request(rid: str, body: TriageCloseBody):
    """#288: the notifier daemon closes an ANSWERED request whose answer was a pure ack — a
    no-action wake that would otherwise cost a full ephemeral spawn just to close the request.

    Deliberately DISTINCT from POST /api/requests/{rid}/close (an INTERNAL daemon endpoint,
    mirroring the wake-scan / wake-ack posture — localhost, not agent-authenticated):
      - records ``actor_type='system'`` / ``actor_id=NULL`` — it NEVER impersonates the requester
        (aligns with #271 actor-hardening); the dedicated path is exactly why a system close
        doesn't masquerade as the answerer or requester.
      - acts ONLY on a request in ``answered`` status (a ``closed`` one is an idempotent no-op;
        any other status is refused) — the precise no-action window, so it cannot be used to
        force-close an open/escalated request.
      - stamps ``{auto:true, reason:'triage_skip', triage_reason}`` into the ``request_closed``
        event JSONB (and the audit row) so #289 can measure suppressions with no migration.

    NOTE: there is no pre-existing daemon-auth primitive to bind to (wake-scan/wake-ack are
    unauthenticated localhost endpoints); the answered-only state gate + system-actor stamping are
    the v1 guardrails. A shared daemon token is a sensible follow-up (#247-adjacent) — flagged."""
    if not _valid_uuid(rid):
        raise HTTPException(400, "request_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        r = _require_request(cur, rid, for_update=True)   # lock: serialize against a concurrent close
        if r["status"] == "closed":
            return {"request_id": rid, "status": "closed", "already_closed": True}
        if r["status"] != "answered":
            raise HTTPException(409, f"request is '{r['status']}', not 'answered' — triage-close only "
                                     f"closes a pure-ack answered request")
        triage_reason = (body.triage_reason or "").strip()[:500]
        cur.execute("UPDATE requests SET status='closed', closed_at=now() WHERE id=%s", (rid,))
        # the requester's waiting_on changed — recompute its status, but DON'T bump_agent: this is a
        # system cleanup, not an action by the requester (must not inflate its turns_used/budget).
        recompute_agent_status(cur, str(r["requester_id"]))
        stamp = {"auto": True, "reason": "triage_skip", "triage_reason": triage_reason}
        log_event(cur, r["container_id"], "system", None, "request", rid, "closed", stamp)
        if r["target_id"]:
            _publish_event(cur, str(r["container_id"]), str(r["target_id"]), "request_closed",
                           {"request_id": rid, **stamp})
        conn.commit()
    return {"request_id": rid, "status": "closed", "auto": True}


@app.post("/api/requests/{rid}/escalate", status_code=200)
def escalate_request(rid: str, body: RequestActorBody):
    """Requester re-targets the request at a human (Orcha#30: target stays set; just becomes the human's id)."""
    if not _valid_uuid(rid):
        raise HTTPException(400, "request_id is not a valid UUID")
    if not _valid_uuid(body.requester_agent_id):
        raise HTTPException(400, "requester_agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        r = _require_request(cur, rid, for_update=True)   # lock: serialize all request-state mutations
        _require_container_active(cur, str(r["container_id"]), body.requester_agent_id)   # GH #24
        if r["status"] not in ("open", "answered"):
            raise HTTPException(409, f"request is '{r['status']}' — cannot escalate")
        if str(r["requester_id"]) != body.requester_agent_id:
            raise HTTPException(403, "only the requester may escalate")
        human_id = _pick_human(cur, str(r["container_id"]))
        cur.execute(
            "UPDATE requests SET target_id=%s, status='open' WHERE id=%s",
            (human_id, rid),
        )
        bump_agent(cur, body.requester_agent_id)
        recompute_agent_status(cur, body.requester_agent_id)
        log_event(cur, r["container_id"], "ai", body.requester_agent_id,
                  "request", rid, "escalated",
                  {"reason": body.reason, "from_status": r["status"], "to_human_id": human_id})
        # Notify the human directly + the container channel for any dashboards.
        _publish_event(cur, str(r["container_id"]), human_id, "request_created",
                       {"request_id": rid, "type": r["type"],
                        "from_agent_id": body.requester_agent_id,
                        "preview": (r["payload"] or "")[:120],
                        "via": "escalated"})
        _publish_event(cur, str(r["container_id"]), None, "request_escalated",
                       {"request_id": rid, "reason": body.reason, "to_human_id": human_id})
        conn.commit()
    return {"request_id": rid, "status": "open", "target_id": human_id, "escalated": True}


# ---------- Phase 3 / Orcha#5: task requests + agent-suggestion ----------

@app.post("/api/requests/{rid}/accept-task", status_code=200)
def accept_task_request(rid: str, body: TaskRequestAccept):
    """Target accepts a task request → creates the task, assigns it, marks request 'accepted'."""
    if not _valid_uuid(rid):
        raise HTTPException(400, "request_id is not a valid UUID")
    if not _valid_uuid(body.responder_agent_id):
        raise HTTPException(400, "responder_agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        r = _require_request(cur, rid, for_update=True)   # lock: serialize overlapping retries
        _reject_if_retired(cur, body.responder_agent_id)   # ISS-51 [P1]: retired can't take on work
        _require_container_active(cur, str(r["container_id"]), body.responder_agent_id)   # GH #24
        if r["type"] != "task":
            raise HTTPException(409, f"request type is '{r['type']}', not 'task' — cannot accept-task")
        # Check actor first so a non-target always gets 403, regardless of status.
        if str(r["target_id"]) != body.responder_agent_id:
            raise HTTPException(403, "only the target agent may accept")
        # R2.3 idempotency: the target re-accepting an already-accepted task request gets
        # the SAME spawned task back (200) — so a retry never spawns a duplicate task.
        # 'rejected'/other states are genuine illegal transitions (409).
        # GH #56 (review P-retry): the retry MUST echo the report-back instruction too. If the
        # first accept response was lost, this idempotent retry is the only thing the same worker
        # session sees — returning the old instruction-less shape would let it miss report-back and
        # fall through to the Point 5 backstop. Rebuild it deterministically from the request detail.
        if r["status"] == "accepted":
            _retry_dod = ((r["detail"] or {}).get("definition_of_done") or "")
            return {"request_id": rid, "status": "accepted",
                    "spawned_task_id": str(r["spawned_task_id"]) if r["spawned_task_id"] else None,
                    "report_back": _build_report_back(rid, _retry_dod),
                    "report_back_request_id": rid,
                    "already_accepted": True}
        if r["status"] != "open":
            raise HTTPException(409, f"request is '{r['status']}', not 'open' — cannot accept")
        task = r["detail"] or {}
        if "title" not in task or "definition_of_done" not in task:
            raise HTTPException(500, "request detail is malformed; cannot synthesize a task")
        # GH #55: if the request carried a protocol, populate it on the spawned task so the
        # accepter reads its loop rules on the very wake this accept triggers (no follow-up PATCH).
        # GH #56 (Point 4.4/4.5): also auto-inject a report-back instruction into protocol.notes —
        # this is HOW the accepter learns to report back (it's in the protocol it reads every wake).
        # It spells out what "materially done" means for THIS request (the definition_of_done) and
        # is explicitly decoupled from /orcha-done (reporting back ≠ sending the task to verification).
        cleaned_proto = _clean_protocol(task.get("protocol")) or {}
        dod = (task.get("definition_of_done") or "").strip()
        # GH #56 (review P-retry): same builder as the idempotent-retry branch above, so the
        # fresh accept and a lost-response retry hand back the identical report-back instruction.
        report_back = _build_report_back(rid, dod)
        existing_notes = (cleaned_proto.get("notes") or "").strip()
        # GH #56 (Point 4.4/4.5, review P2): the report-back instruction is the MECHANISM that
        # tells the accepter to answer the request, so it must survive the per-field cap intact.
        # Prepend it and trim only the OLDER carried notes — never tail-truncate, or a near-max
        # carried `notes` would silently drop the whole REPORT BACK line and the answer waypoint
        # would be lost. report_back is well under the cap, but clamp defensively regardless.
        if existing_notes:
            sep = "\n\n"
            room = MAX_PROTOCOL_FIELD_LEN - len(report_back) - len(sep)
            merged_notes = report_back + sep + existing_notes[:room] if room > 0 else report_back
        else:
            merged_notes = report_back
        cleaned_proto["notes"] = merged_notes
        protocol_json = json.dumps(cleaned_proto)
        # Create the task, assign to the accepter, start it.
        cur.execute(
            """INSERT INTO tasks
                 (container_id, title, description, definition_of_done,
                  status, priority, created_by_agent_id, protocol, started_at)
               VALUES (%s, %s, %s, %s, 'in_progress', %s, %s, %s::jsonb, now())
               RETURNING id""",
            (str(r["container_id"]), task["title"], task.get("description"),
             task["definition_of_done"], task.get("priority", 100),
             str(r["requester_id"]), protocol_json),
        )
        tid = str(cur.fetchone()["id"])
        cur.execute(
            "INSERT INTO agent_tasks (agent_id, task_id, assignment_status) VALUES (%s, %s, 'working')",
            (body.responder_agent_id, tid),
        )
        # Mark the request as accepted, point at the spawned task.
        cur.execute(
            "UPDATE requests SET status='accepted', response=%s, responded_at=now(), spawned_task_id=%s WHERE id=%s",
            (body.note, tid, rid),
        )
        bump_agent(cur, body.responder_agent_id)
        recompute_agent_status(cur, body.responder_agent_id)
        recompute_agent_status(cur, str(r["requester_id"]))
        log_event(cur, r["container_id"], "ai", body.responder_agent_id,
                  "request", rid, "accepted",
                  {"spawned_task_id": tid, "note": body.note})
        log_event(cur, r["container_id"], "ai", body.responder_agent_id,
                  "task", tid, "created",
                  {"title": task["title"], "via": "task-request accept"})
        # GH #56 (Point 6): accept must NOT wake the requester — only the real ANSWER (at material
        # completion) wakes them. The accept stays in the audit feed via log_event above, but we no
        # longer publish a wake-worthy `task_request_accepted` event toward the requester (it was
        # classified as a `request_answered` notification — a premature receipt). Accept is silent now.
        conn.commit()
    # GH #56 (review P1): the same worker session that accepts a task-request keeps working it
    # WITHOUT reloading the spawned task's protocol, so the report-back note buried in
    # protocol.notes is invisible on this wake — the primary accepted->answered path gets skipped
    # and the Point 5 backstop becomes the normal route. Echo the instruction in the accept
    # RESPONSE so /orcha-accept-task can surface it immediately, in the same session, before the
    # agent starts the work.
    return {"request_id": rid, "status": "accepted", "spawned_task_id": tid,
            "report_back": report_back, "report_back_request_id": rid}


@app.post("/api/requests/{rid}/reject-task", status_code=200)
def reject_task_request(rid: str, body: TaskRequestReject):
    """Target rejects a task request with a reason; requester can then re-ask, suggest agent, or escalate."""
    if not _valid_uuid(rid):
        raise HTTPException(400, "request_id is not a valid UUID")
    if not _valid_uuid(body.responder_agent_id):
        raise HTTPException(400, "responder_agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        r = _require_request(cur, rid, for_update=True)   # lock: serialize all request-state mutations
        _require_container_active(cur, str(r["container_id"]), body.responder_agent_id)   # GH #24
        if r["type"] != "task":
            raise HTTPException(409, f"request type is '{r['type']}', not 'task' — cannot reject-task")
        if r["status"] != "open":
            raise HTTPException(409, f"request is '{r['status']}', not 'open' — cannot reject")
        if r["target_id"] is None or str(r["target_id"]) != body.responder_agent_id:
            raise HTTPException(403, "only the target agent may reject")
        cur.execute(
            "UPDATE requests SET status='rejected', rejection_reason=%s, responded_at=now() WHERE id=%s",
            (body.reason, rid),
        )
        bump_agent(cur, body.responder_agent_id)
        recompute_agent_status(cur, body.responder_agent_id)
        recompute_agent_status(cur, str(r["requester_id"]))
        log_event(cur, r["container_id"], "ai", body.responder_agent_id,
                  "request", rid, "rejected", {"reason": body.reason})
        _publish_event(cur, str(r["container_id"]), str(r["requester_id"]), "task_request_rejected",
                       {"request_id": rid, "reason": body.reason})
        # ISS-42 (B12): don't strand the requester at a dead-end. The machine event above wakes them
        # but carries no surfaced content; poke them with the reason + the three concrete paths forward
        # (re-ask, suggest a different agent, escalate to a human) so the rejection becomes actionable.
        reason_txt = (body.reason or "").strip() or "(no reason given)"
        _poke_path_forward(
            cur, str(r["container_id"]), str(r["requester_id"]), body.responder_agent_id,
            f"Your task request (id {rid}) was rejected: {reason_txt}. You're not stuck — pick a path "
            f"forward: re-ask another agent (/orcha-ask --task), propose a new agent for it "
            f"(/orcha-suggest-agent {rid}), or escalate to a human (/orcha-escalate {rid}).")
        conn.commit()
    return {"request_id": rid, "status": "rejected", "reason": body.reason, "requester_poked": True}


@app.post("/api/requests/{rid}/suggest-agent", status_code=200)
def suggest_agent(rid: str, body: AgentSuggestion):
    """Requester escalates with a structured proposal: 'please create a new agent X with role Y'.

    The request stays status='open' (target=null) so it appears in the human's escalations queue
    alongside other escalated items, but with `detail.proposed_*` populated so the human can
    /decide-suggestion to create, reassign, or refuse.
    """
    if not _valid_uuid(rid):
        raise HTTPException(400, "request_id is not a valid UUID")
    if not _valid_uuid(body.requester_agent_id):
        raise HTTPException(400, "requester_agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        r = _require_request(cur, rid, for_update=True)   # lock: serialize all request-state mutations
        _require_container_active(cur, str(r["container_id"]), body.requester_agent_id)   # GH #24
        if r["status"] not in ("open", "answered", "rejected"):
            raise HTTPException(409, f"request is '{r['status']}' — cannot escalate-with-suggestion")
        if str(r["requester_id"]) != body.requester_agent_id:
            raise HTTPException(403, "only the requester may suggest an agent")
        # Merge the suggestion into the request's `detail`, alongside any existing task payload.
        existing = r["detail"] or {}
        existing["proposed_alias"] = body.proposed_alias
        existing["proposed_role"] = body.proposed_role
        existing["proposed_prompt"] = body.proposed_prompt
        existing["rationale"] = body.rationale
        # Orcha#30: re-target at the container's human instead of nulling target_id.
        # detail.proposed_alias is what distinguishes a suggestion from a plain re-target.
        human_id = _pick_human(cur, str(r["container_id"]))
        cur.execute(
            """UPDATE requests
                 SET target_id=%s, status='open', detail=%s::jsonb
                 WHERE id=%s""",
            (human_id, json.dumps(existing), rid),
        )
        bump_agent(cur, body.requester_agent_id)
        recompute_agent_status(cur, body.requester_agent_id)
        log_event(cur, r["container_id"], "ai", body.requester_agent_id,
                  "request", rid, "agent_suggested",
                  {"proposed_alias": body.proposed_alias,
                   "proposed_role": body.proposed_role,
                   "rationale": body.rationale[:120],
                   "to_human_id": human_id})
        _publish_event(cur, str(r["container_id"]), human_id, "agent_suggested",
                       {"request_id": rid, "proposed_alias": body.proposed_alias,
                        "from_agent_id": body.requester_agent_id})
        conn.commit()
    return {
        "request_id": rid, "status": "open", "target_id": None,
        "suggestion": {
            "proposed_alias": body.proposed_alias,
            "proposed_role": body.proposed_role,
            "rationale": body.rationale,
        },
    }


@app.post("/api/agent-suggestions/{rid}/decide", status_code=200)
def decide_suggestion(rid: str, body: SuggestionDecision):
    """Human resolves an agent suggestion.

    kind='create': spawns the proposed agent, then accepts the underlying task request for them.
    kind='reassign': re-targets the request at an existing agent; that agent must still /accept-task.
    kind='refuse': closes the request with status='closed' (reason recorded). Requester's outbox shows it.
    """
    if not _valid_uuid(rid):
        raise HTTPException(400, "request_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_kind(cur, body.actor_agent_id, ("human",))  # Orcha#30
        r = _require_request(cur, rid, for_update=True)   # lock: serialize all request-state mutations
        # Orcha#30: detect a pending suggestion by detail.proposed_alias, not by null target.
        # The request now lives in the targeted human's inbox until resolved.
        detail = r["detail"] or {}
        if "proposed_alias" not in detail:
            raise HTTPException(409, "request has no agent-suggestion to decide on")
        if r["status"] != "open":
            raise HTTPException(409, f"suggestion is '{r['status']}', not 'open' — already decided")

        if body.kind == "create":
            # Cap check: containers.max_auto_agents = max TOTAL agents (post-PR#6 reinterpretation).
            cur.execute(
                "SELECT COUNT(*) AS n FROM agents WHERE container_id=%s AND terminated_at IS NULL",
                (str(r["container_id"]),),
            )
            n_existing = cur.fetchone()["n"]
            cur.execute(
                "SELECT max_auto_agents FROM containers WHERE id=%s",
                (str(r["container_id"]),),
            )
            cap = cur.fetchone()["max_auto_agents"]
            if n_existing >= cap:
                raise HTTPException(
                    409,
                    f"container is at the {cap}-agent cap. Reassign to an existing agent or "
                    f"raise containers.max_auto_agents.",
                )
            try:
                cur.execute(
                    """INSERT INTO agents
                         (container_id, alias, role, system_prompt, is_auto_created, parent_agent_id, turn_budget)
                       VALUES (%s, %s, %s, %s, true, %s, COALESCE(%s, 50))
                       RETURNING id""",
                    (str(r["container_id"]), detail["proposed_alias"], detail["proposed_role"],
                     detail["proposed_prompt"], str(r["requester_id"]), body.turn_budget),
                )
            except psycopg.errors.UniqueViolation:
                raise HTTPException(409, f"alias '{detail['proposed_alias']}' already exists in this container")
            new_aid = str(cur.fetchone()["id"])
            # Now target the request at the new agent so they can /accept-task it.
            cur.execute(
                "UPDATE requests SET target_id=%s, status='open' WHERE id=%s",
                (new_aid, rid),
            )
            log_event(cur, r["container_id"], "human", None, "agent", new_aid, "created",
                      {"alias": detail["proposed_alias"], "via": "suggestion accepted",
                       "from_request_id": rid, "verifier_human_id": body.actor_agent_id})
            log_event(cur, r["container_id"], "human", None, "request", rid, "suggestion_decided",
                      {"kind": "create", "new_agent_id": new_aid,
                       "verifier_human_id": body.actor_agent_id})
            _publish_event(cur, str(r["container_id"]), new_aid, "request_created",
                           {"request_id": rid, "type": r["type"], "from_agent_id": str(r["requester_id"]),
                            "preview": r["payload"][:120], "via": "human created new agent"})
            _publish_event(cur, str(r["container_id"]), str(r["requester_id"]), "agent_suggestion_decided",
                           {"request_id": rid, "kind": "create", "new_alias": detail["proposed_alias"]})
            conn.commit()
            return {"request_id": rid, "kind": "create", "new_agent_id": new_aid,
                    "new_alias": detail["proposed_alias"], "status": "open"}

        elif body.kind == "reassign":
            if not body.target_alias:
                raise HTTPException(400, "reassign requires target_alias")
            new_target_id = _resolve_alias(cur, str(r["container_id"]), body.target_alias)
            cur.execute(
                "UPDATE requests SET target_id=%s, status='open' WHERE id=%s",
                (new_target_id, rid),
            )
            log_event(cur, r["container_id"], "human", None, "request", rid, "suggestion_decided",
                      {"kind": "reassign", "to_alias": body.target_alias,
                       "verifier_human_id": body.actor_agent_id})
            _publish_event(cur, str(r["container_id"]), new_target_id, "request_created",
                           {"request_id": rid, "type": r["type"], "from_agent_id": str(r["requester_id"]),
                            "preview": r["payload"][:120], "via": "human reassigned"})
            _publish_event(cur, str(r["container_id"]), str(r["requester_id"]), "agent_suggestion_decided",
                           {"request_id": rid, "kind": "reassign", "target_alias": body.target_alias})
            conn.commit()
            return {"request_id": rid, "kind": "reassign", "target_alias": body.target_alias, "status": "open"}

        else:  # refuse
            cur.execute(
                "UPDATE requests SET status='closed', closed_at=now(), rejection_reason=%s WHERE id=%s",
                (body.reason or "refused by human", rid),
            )
            recompute_agent_status(cur, str(r["requester_id"]))
            log_event(cur, r["container_id"], "human", None, "request", rid, "suggestion_decided",
                      {"kind": "refuse", "reason": body.reason,
                       "verifier_human_id": body.actor_agent_id})
            _publish_event(cur, str(r["container_id"]), str(r["requester_id"]), "agent_suggestion_decided",
                           {"request_id": rid, "kind": "refuse", "reason": body.reason})
            conn.commit()
            return {"request_id": rid, "kind": "refuse", "status": "closed", "reason": body.reason}


@app.post("/api/requests/{rid}/convert-to-task", status_code=200)
def convert_to_task(rid: str, body: RequestConvert):
    """Convert an answered info request into a real task (e.g. answer was insufficient and warrants work).

    Request moves from 'answered' → 'converted_to_task'; a new task is created with optional
    assignee. Spawned_task_id is recorded so /requests can show the link.
    """
    if not _valid_uuid(rid):
        raise HTTPException(400, "request_id is not a valid UUID")
    if not _valid_uuid(body.requester_agent_id):
        raise HTTPException(400, "requester_agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        r = _require_request(cur, rid, for_update=True)   # lock: serialize all request-state mutations
        _require_container_active(cur, str(r["container_id"]), body.requester_agent_id)   # GH #24 (human may still convert)
        if r["status"] != "answered":
            raise HTTPException(409, f"request is '{r['status']}', not 'answered' — cannot convert")
        if str(r["requester_id"]) != body.requester_agent_id:
            raise HTTPException(403, "only the requester may convert")
        if r["type"] != "info":
            raise HTTPException(409, f"only info requests can be converted (this is '{r['type']}')")
        assignee_id: Optional[str] = None
        if body.assignee_alias:
            assignee_id = _resolve_alias(cur, str(r["container_id"]), body.assignee_alias)
        initial_status = "in_progress" if assignee_id else "ready"
        started_clause = "now()" if assignee_id else "NULL"
        cur.execute(
            f"""INSERT INTO tasks
                  (container_id, title, description, definition_of_done,
                   status, priority, created_by_agent_id, started_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, {started_clause})
                RETURNING id""",
            (str(r["container_id"]), body.title,
             f"Converted from request {rid[:8]}…", body.definition_of_done,
             initial_status, body.priority, body.requester_agent_id),
        )
        tid = str(cur.fetchone()["id"])
        if assignee_id:
            cur.execute(
                "INSERT INTO agent_tasks (agent_id, task_id, assignment_status) VALUES (%s, %s, 'working')",
                (assignee_id, tid),
            )
            # ISS-86 / #245 (GAP A): don't bump_agent(assignee) — see create_task. Resetting the
            # cold assignee's heartbeat would suppress the task_assigned wake below. The requester
            # (the actor doing the convert) IS active and is still bumped further down.
            recompute_agent_status(cur, assignee_id)
        cur.execute(
            "UPDATE requests SET status='converted_to_task', spawned_task_id=%s, closed_at=now() WHERE id=%s",
            (tid, rid),
        )
        bump_agent(cur, body.requester_agent_id)
        recompute_agent_status(cur, body.requester_agent_id)
        log_event(cur, r["container_id"], "ai", body.requester_agent_id,
                  "request", rid, "converted_to_task",
                  {"spawned_task_id": tid, "title": body.title,
                   "assignee_alias": body.assignee_alias})
        log_event(cur, r["container_id"], "ai", body.requester_agent_id,
                  "task", tid, "created",
                  {"title": body.title, "via": "info-request conversion"})
        if assignee_id:
            _publish_event(cur, str(r["container_id"]), assignee_id, "task_assigned",
                           {"task_id": tid, "title": body.title, "via": "converted from info request"})
        conn.commit()
    return {"request_id": rid, "status": "converted_to_task", "spawned_task_id": tid,
            "assignee_alias": body.assignee_alias}


# ---------- A3: prompt-event (wake an agent with a directed message) ----------

@app.post("/api/agents/{aid}/prompt", status_code=201)
def prompt_agent(aid: str, body: PromptEvent):
    """A3: wake an agent with a directed message.

    Publishes a `prompt` agent_event carrying `message` on the agent's key (so wake-scan counts
    it as pending work and the daemon wakes the agent) and on the container key (so dashboards /
    the thread see it). The woken headless worker is shown the message text in its wake prompt
    (see notifier.build_wake_prompt), so it acts on the prompt specifically rather than just
    'draining the inbox'. Keystone for B2 (prompt-from-portal) and B12 (poke / reject-loop)."""
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    if body.from_agent_id is not None and not _valid_uuid(body.from_agent_id):
        raise HTTPException(400, "from_agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        ag = _require_agent(cur, aid)
        payload = {"message": body.message, "from_agent_id": body.from_agent_id}
        _publish_event(cur, str(ag["container_id"]), aid, "prompt", payload)
        log_event(cur, str(ag["container_id"]), "agent", body.from_agent_id, "agent", aid,
                  "prompt_sent", {"chars": len(body.message)})
        conn.commit()
    return {"agent_id": aid, "event": "prompt", "delivered": True}


# ---------- SSE + long-poll subscribers (Orcha#5: addresses #3 polling cost) ----------

def _assigned_ready_task(cur, aid: str) -> Optional[str]:
    """#23: the first task this agent could auto-start RIGHT NOW — assigned to it, status
    'ready', not the root — or None. This is the LEVEL-triggered readiness signal /wait probes
    so an idle listener never deadlocks on work that already exists.

    The query is identical to the notifier wake-scan's `auto_start_task_ids` scan (wake_scan,
    main.py) — same JOIN, same predicate, same ORDER BY — so /wait and the daemon agree
    on exactly what 'ready work' means; the only difference is LIMIT 1, since /wait needs just
    existence + the first id. Keeping them in lockstep is the whole point: one source of truth
    for the readiness decision, on both the long-poll and the out-of-band wake path."""
    cur.execute(
        """SELECT t.id FROM tasks t
           JOIN agent_tasks at ON at.task_id = t.id AND at.agent_id = %s
           WHERE t.container_id = (SELECT container_id FROM agents WHERE id = %s)
             AND t.status = 'ready' AND t.is_root = false
           ORDER BY t.priority, t.created_at
           LIMIT 1""",
        (aid, aid),
    )
    row = cur.fetchone()
    return str(row["id"]) if row else None


def _agent_claim_blocked(cur, aid: str) -> bool:
    """#23 / Gate PR#274: True when `/api/agents/{aid}/next` would REFUSE to hand this agent a
    task right now for a reason unrelated to task availability. It mirrors the two agent-level
    preconditions agent_next enforces before claiming: a paused/stopped container (409 via
    _require_container_active) or a retired agent (409 via _reject_if_retired, terminated_at set).
    GH #39: the turn-budget precondition (429, turns_used >= turn_budget) is removed from agent_next,
    so it is no longer mirrored here.

    `_assigned_ready_task` answers 'is there ready work' (task-level, lockstep with the wake-scan
    query). This answers the orthogonal 'could THIS agent claim it right now' (agent-level,
    lockstep with /next's preconditions). The synthetic /wait task_ready probe must honor BOTH:
    surfacing 'ready work' that an immediate /orcha-next would bounce (409) is a false
    claimable signal — and because the synthetic echoes ts=since_ts the task stays perpetually
    'new', so a /orcha-listen loop would re-emit task_ready → /orcha-next → 409 → repeat (a
    spin). So /wait suppresses the synthetic whenever a claim is blocked; this gate governs ONLY
    the level-probe shortcut — a real agent_event still falls through to _wait_for_event and is
    delivered unchanged. CRITICAL: this is a pure predicate — it NEVER raises (agent_wait is a
    long-poll; a 409 here would wrongly fail the /wait itself instead of just declining the
    shortcut)."""
    cur.execute(
        """SELECT a.terminated_at, c.status AS container_status
           FROM agents a JOIN containers c ON c.id = a.container_id
           WHERE a.id = %s""",
        (aid,),
    )
    row = cur.fetchone()
    if row is None:
        return True
    if row["container_status"] != "active":      # _require_container_active → 409
        return True
    if row["terminated_at"] is not None:         # _reject_if_retired → 409
        return True
    return False


@app.get("/api/agents/{aid}/wait")
async def agent_wait(aid: str, since_ts: float = Query(default=0.0), timeout: float = Query(default=30.0, ge=1, le=120)):
    """Long-poll for the next event addressed to this agent.

    Returns `{event, ts, ...}` or `{event: 'timeout'}` after `timeout` seconds.
    Pass `since_ts` (epoch seconds) from the last received event's `ts` to avoid replay.
    """
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    # Quick existence check (sync DB call) + ISS-50 heartbeat-on-poll: an idle agent that's
    # only long-polling /wait (via /loop /orcha-listen) is alive but never touched
    # last_heartbeat_at, so the roster derived it as OFFLINE (last_active = GREATEST(heartbeat,
    # max worker_run start)). Refresh the heartbeat at poll entry so a present listener reads as
    # online. Heartbeat ONLY — NOT bump_agent(), which also increments turns_used (a poll isn't a
    # turn). This also (correctly) keeps wake-scan from spawning a redundant headless worker while
    # a live listener is here: idle_seconds stays small until the loop goes quiet >= min_idle.
    with db_cursor() as (conn, cur):
        _require_agent(cur, aid)
        cur.execute("UPDATE agents SET last_heartbeat_at = now() WHERE id = %s", (aid,))
        # #23 [P0]: BEFORE blocking, settle the edge/level gap. _wait_for_event is EDGE-triggered
        # (returns only agent_events with ts > since_ts), so a task assigned+readied while this
        # listener wasn't subscribed — its task_ready/task_assigned event already <= since_ts, or
        # never delivered on this agent's key (a container-only signal) — is invisible to the poll.
        # Meanwhile the notifier wake-scan that WOULD auto-start it is suppressed because THIS /wait
        # just refreshed last_heartbeat_at (the agent looks non-idle). Net: an idle deadlock on work
        # that already exists. So probe the DB LEVEL state here. Real events keep precedence: if any
        # agent_events row > since_ts is pending, fall through to the normal block (it delivers that
        # event, unchanged). Only when nothing real is pending do we check for an assigned-ready task
        # and, if found, return a synthetic task_ready immediately instead of blocking. Gate
        # (PR#274): only when this agent could ACTUALLY claim — _agent_claim_blocked mirrors /next's
        # preconditions (active container + not retired), so we never surface work an immediate
        # /orcha-next would bounce 409 (which a listener loop would re-emit → spin).
        cur.execute(
            "SELECT 1 FROM agent_events WHERE event_key=%s AND ts > %s LIMIT 1",
            (aid, since_ts),
        )
        if cur.fetchone() or _agent_claim_blocked(cur, aid):
            ready_tid = None
        else:
            ready_tid = _assigned_ready_task(cur, aid)
        conn.commit()
    if ready_tid is not None:
        _touch_heartbeat(aid)
        # ts = since_ts (NOT now): we confirmed no real event > since_ts above, but one could land
        # between this probe and the listener's next poll. Echoing the caller's cursor never advances
        # it, so that real event is still > since_ts and gets delivered next poll — the synthetic
        # never masks a real one. The synthetic self-clears once the listener claims via /orcha-next
        # (status flips to in_progress → the next probe finds nothing ready), so it can't spin.
        return {"event": "task_ready", "ts": since_ts, "task_id": ready_tid, "assigned": True}
    evt = await _wait_for_event(aid, since_ts, timeout)
    # ISS-50 review P1: the entry write alone is stale by the time a long poll returns — /wait can
    # block up to 120s. An event that lands near the end is delivered to a LIVE listener, but its
    # agent_events row is still pending for wake-scan, so a heartbeat last touched at poll-start can
    # already be older than min_idle → the notifier spawns a duplicate headless worker. Refresh the
    # heartbeat at RETURN too (event AND timeout paths) so the moment of delivery proves liveness.
    _touch_heartbeat(aid)
    if evt is None:
        # #23: timeout re-check — a task may have been assigned+readied DURING the block with no
        # agent-key event (e.g. a container-only task_ready), which _wait_for_event can't see. One
        # level probe before reporting an empty timeout, so the listener gets the work THIS poll
        # rather than waiting a full cycle longer. Same ts=since_ts rationale as the entry path.
        with db_cursor() as (_, cur):
            # Gate (PR#274): same claimability gate as the entry probe — suppress the synthetic
            # when /next would refuse the claim (paused/stopped container or exhausted budget).
            ready_tid = None if _agent_claim_blocked(cur, aid) else _assigned_ready_task(cur, aid)
        if ready_tid is not None:
            return {"event": "task_ready", "ts": since_ts, "task_id": ready_tid, "assigned": True}
        return {"event": "timeout", "ts": time.time()}
    return evt


@app.get("/api/agents/{aid}/events")
async def agent_events(aid: str, since_ts: float = Query(default=0.0)):
    """SSE stream of events addressed to this agent. Forever; clients close to unsubscribe.

    Useful for the dashboard (where a browser tab can stay open) and for any non-Claude
    client that can hold a long-lived HTTP connection.
    """
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (_, cur):
        _require_agent(cur, aid)

    async def event_stream():
        cursor_ts = since_ts
        # Periodic heartbeat so reverse proxies don't drop the idle connection.
        last_heartbeat = time.time()
        while True:
            evt = await _wait_for_event(aid, cursor_ts, 15.0)
            if evt is None:
                # No event in 15s — send a heartbeat comment so the connection stays warm.
                yield f": heartbeat {int(time.time())}\n\n"
                last_heartbeat = time.time()
                continue
            cursor_ts = evt["ts"]
            yield f"data: {json.dumps(evt)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/api/containers/{cid}/events")
async def container_events(cid: str, since_ts: float = Query(default=0.0)):
    """SSE stream of container-wide events (escalations, suggestions) for dashboards / humans."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        _require_container(cur, cid)
    key = f"c:{cid}"

    async def event_stream():
        cursor_ts = since_ts
        while True:
            evt = await _wait_for_event(key, cursor_ts, 15.0)
            if evt is None:
                yield f": heartbeat {int(time.time())}\n\n"
                continue
            cursor_ts = evt["ts"]
            yield f"data: {json.dumps(evt)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/api/containers/{cid}/sweep", status_code=200)
def sweep_expired(cid: str, actor_agent_id: str = Query(...)):
    """Escalate any open requests past expires_at — re-targets at a human (Orcha#30)."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_kind(cur, actor_agent_id, ("human",))  # Orcha#30
        _require_container(cur, cid)
        # Only sweep requests whose current target is an AGENT (not already a human).
        cur.execute(
            """SELECT r.id, r.target_id FROM requests r
               JOIN agents a ON a.id = r.target_id
               WHERE r.container_id=%s AND r.status='open'
                 AND r.expires_at IS NOT NULL AND r.expires_at < now()
                 AND a.kind = 'ai'""",
            (cid,),
        )
        expired = cur.fetchall()
        human_id: Optional[str] = None
        if expired:
            human_id = _pick_human(cur, cid)
        for r in expired:
            cur.execute(
                "UPDATE requests SET target_id=%s WHERE id=%s",
                (human_id, r["id"]),
            )
            log_event(cur, cid, "system", None, "request", str(r["id"]), "escalated",
                      {"reason": "expires_at passed (sweep)", "to_human_id": human_id})
            _publish_event(cur, cid, human_id, "request_created",
                           {"request_id": str(r["id"]), "via": "expires_at sweep"})
            _publish_event(cur, cid, None, "request_escalated",
                           {"request_id": str(r["id"]), "reason": "expires_at passed (sweep)"})
        conn.commit()
    return {"escalated_count": len(expired), "request_ids": [str(r["id"]) for r in expired]}


# ---------- agent memory digest (Epic C / D3 + D4) ----------

@app.post("/api/agents/{aid}/digest", status_code=201)
def post_digest(aid: str, body: DigestSnapshot):
    """D3: store one per-agent memory digest the agent composed.

    Append-only — every POST is a new snapshot row; the latest is the live view.
    The server stamps snapshot_ts (so cadence is server-truth) and never edits
    the agent's reasoning. Emits a 'digest_snapshotted' event for the portal.
    """
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    # #287 Tier-0 compaction: collapse exact-duplicate + empty entries before storing. Pure
    # (removes only provably-redundant bytes), so it never edits the agent's reasoning — the
    # honesty boundary is intact. Degrades to the raw lists if the curator copy is absent.
    decisions, learnings, open_threads = body.decisions, body.learnings, body.open_threads
    if _digest_curate is not None:
        clean = _digest_curate.dedup_digest(
            {"decisions": decisions, "learnings": learnings, "open_threads": open_threads})
        decisions, learnings, open_threads = (
            clean["decisions"], clean["learnings"], clean["open_threads"])
    with db_cursor() as (conn, cur):
        a = _require_agent(cur, aid)
        cid = str(a["container_id"])
        ts = time.time()
        cur.execute(
            """INSERT INTO agent_memory_digests
                 (container_id, agent_id, snapshot_ts, current_focus,
                  decisions, learnings, open_threads, audience)
               VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s)
               RETURNING id""",
            (cid, aid, ts, body.current_focus,
             json.dumps(decisions), json.dumps(learnings),
             json.dumps(open_threads), body.audience),
        )
        did = cur.fetchone()["id"]
        log_event(cur, cid, "ai", aid, "agent", aid, "digest_snapshotted",
                  {"digest_id": did, "current_focus": body.current_focus})
        # ISS-58: publish CONTAINER-scoped only (target_agent_id=None), NOT to the agent's own key.
        # A snapshot is a dashboard notification, not work — delivering it to the agent's inbox made
        # wake-scan count it as pending and re-wake the agent, which snapshots again on exit → a
        # ~60s runaway. agent_id rides in the payload so dashboards still attribute it.
        _publish_event(cur, cid, None, "digest_snapshotted",
                       {"digest_id": did, "snapshot_ts": ts, "agent_id": aid})
        conn.commit()
    return {"digest_id": did, "agent_id": aid, "snapshot_ts": ts}


@app.get("/api/agents/{aid}/digest")
def get_digest(aid: str):
    """Return the agent's LATEST memory digest (or {digest: null} if none yet)."""
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (_, cur):
        _require_agent(cur, aid)
        cur.execute(
            """SELECT id, snapshot_ts, current_focus, decisions, learnings,
                      open_threads, audience, created_at
               FROM agent_memory_digests
               WHERE agent_id=%s ORDER BY snapshot_ts DESC LIMIT 1""",
            (aid,),
        )
        return {"digest": cur.fetchone()}


@app.get("/api/agents/{aid}/rehydrate")
def rehydrate(aid: str):
    """D4: assemble the 'where we left off' brief for a re-binding tab.

    One call returns everything the SessionStart rehydrate prints: identity,
    the agent's live (non-terminal) tasks, open incoming requests, answered
    outgoing requests, and the latest memory digest. Identity/tasks/inbox come
    FRESH from the existing tables (Dock's (i)-(iii)); the digest carries the
    reasoning gap (iv). Deliberately carries NO Claude Code file-memory — that
    loads via its own parallel injector (the ownership boundary).
    """
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (_, cur):
        cur.execute(
            """SELECT id, container_id, alias, role, kind, status,
                      turns_used, turn_budget
               FROM agents WHERE id=%s""", (aid,))
        a = cur.fetchone()
        if not a:
            raise HTTPException(404, f"agent {aid} not found")

        # (ii) the agent's own live tasks + last thread line each
        cur.execute(
            """SELECT t.id, t.title, t.status, t.priority, t.definition_of_done,
                      (SELECT m.body FROM task_messages m
                       WHERE m.task_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_message
               FROM tasks t
               JOIN agent_tasks at ON at.task_id = t.id
               WHERE at.agent_id = %s AND t.status NOT IN ('completed', 'cancelled')
               ORDER BY t.priority, t.created_at""",
            (aid,),
        )
        tasks = cur.fetchall()

        # (iii) open incoming requests (need a reply)
        cur.execute(
            """SELECT r.id, r.type, r.priority, LEFT(r.payload, 240) AS payload,
                      req.alias AS requester_alias
               FROM requests r JOIN agents req ON req.id = r.requester_id
               WHERE r.target_id = %s AND r.status = 'open'
               ORDER BY r.priority, r.created_at""",
            (aid,),
        )
        inbox = cur.fetchall()

        # (iii) my outgoing requests that got answered (close / resume on these)
        cur.execute(
            """SELECT r.id, r.type, LEFT(r.payload, 160) AS payload,
                      LEFT(r.response, 240) AS response,
                      COALESCE(tgt.alias, '(human)') AS target_alias
               FROM requests r LEFT JOIN agents tgt ON tgt.id = r.target_id
               WHERE r.requester_id = %s AND r.status = 'answered'
               ORDER BY r.responded_at DESC NULLS LAST""",
            (aid,),
        )
        outbox = cur.fetchall()

        # (iv) the reasoning gap — latest digest only
        cur.execute(
            """SELECT snapshot_ts, current_focus, decisions, learnings,
                      open_threads, audience, created_at
               FROM agent_memory_digests
               WHERE agent_id=%s ORDER BY snapshot_ts DESC LIMIT 1""",
            (aid,),
        )
        digest = cur.fetchone()

    return {
        "identity": a,
        "tasks": tasks,
        "inbox": inbox,
        "outbox": outbox,
        "digest": digest,
    }


# ---------- backwards-compat + dashboard ----------

@app.get("/api/snapshot/{cid}")
def snapshot(cid: str):
    return get_container(cid)


@app.get("/", response_class=HTMLResponse)
def home():
    return _serve("home.html")


@app.get("/onboarding", response_class=HTMLResponse)
def onboarding_page():
    """O1+O2+O3 first-run onboarding wizard.

    Same pure client-side pattern as the other page routes: serves the static
    shell, which loads the D0 assets + onboarding.js. The wizard resolves the
    container (OrchaData.resolveCid), registers the operator (POST .../agents
    kind='human'), creates the first agent (POST .../agents kind='ai' + prompt,
    optional initial_task), and reads GET /api/models — all existing API surface.
    No new API/DB route.
    """
    return _serve("onboarding.html")


@app.get("/settings", response_class=HTMLResponse)
def settings_page():
    """#294 Settings page — Anthropic API-key surface (+ future model selection).

    Same pure client-side pattern as the other page routes: serves the static
    shell, which loads the D0 assets + settings.js. The page resolves the
    container (OrchaData.resolveCid) and reads/writes the key via the existing
    /api/containers/{cid}/settings/llm-key routes (GET/PUT/DELETE + .../test) —
    no new API/DB route added here (those belong to the #294 backend PR).
    """
    return _serve("settings.html")


@app.get("/agents", response_class=HTMLResponse)
def agents_page():
    """Per-agent detail view (owned by agent "C").

    Pure client-side: reads ?cid= (+ optional ?agent=alias) from the URL, fetches
    the same /api/containers/{cid} snapshot the home page uses, and renders a
    roster + a detail panel (current task in detail, every task the agent is on,
    and the agent's incoming + outgoing requests). No new API surface.
    """
    return _serve("agents.html")


@app.get("/requests", response_class=HTMLResponse)
def requests_page():
    """Per-request detail view (owned by agent "E").

    Pure client-side, same pattern as /agents: reads ?cid= (+ optional ?req=id)
    from the URL, fetches the shared /api/containers/{cid} snapshot, and renders a
    request roster + a detail panel for one request — its lifecycle in detail
    (open / answered / closed / escalated / rejected), who started it and who it's
    for, how long it took to address, and its place in a request chain (parent
    request with a live link, plus any children asked in service of it). No new
    API surface — everything derives from requests[] joined to agents[] by id.
    """
    return _serve("requests.html")


@app.get("/tasks", response_class=HTMLResponse)
def tasks_page():
    """Per-task detail view (owned by agent "D").

    Pure client-side, same pattern as /agents and /requests: reads ?cid= (+
    optional ?task=id) from the URL, fetches the shared /api/containers/{cid}
    snapshot, and renders a task roster + a detail panel for one task — its
    status in detail, the agents performing it (joined from assignees[]), when
    it started, and a live-ticking "running for" duration, plus DoD, description,
    result, who created it, and the request that spawned it (if any). No new API
    surface — everything derives from tasks[] joined to agents[] by alias/id.
    """
    return _serve("tasks.html")


# ---------- decisions (B0 / G1: the shared approval contract) ----------
# ONE endpoint behind every human-decision surface. It (a) enforces the core rule
# server-side — a reject MUST carry a reason — so the UI can't be the only guard,
# (b) persists {decision, reason} for audit, and (c) emits a `decision_made` event
# to the target agent so it sees *why* on its next wake (not just yes/no). B3
# (requests) and B4 (verify + checkpoint) reuse this without a new contract.

@app.post("/api/decisions", status_code=201)
def create_decision(body: DecisionCreate):
    reason = (body.reason or "").strip()
    # Server-side invariant (NOT only the UI): reject requires a reason.
    if body.decision == "reject" and not reason:
        raise HTTPException(422, {"error": "reason_required",
                                  "detail": "a reason is required when decision is 'reject'"})
    if body.target_agent_id is not None and not _valid_uuid(body.target_agent_id):
        raise HTTPException(400, "target_agent_id is not a valid UUID")

    with db_cursor() as (conn, cur):
        # Only a human decides. _require_kind also validates the UUID + existence.
        _require_kind(cur, body.actor_agent_id, ("human",))
        cur.execute("SELECT container_id FROM agents WHERE id=%s", (body.actor_agent_id,))
        target_container = cur.fetchone()["container_id"]
        if body.target_agent_id is not None:
            cur.execute("SELECT container_id FROM agents WHERE id=%s", (body.target_agent_id,))
            trow = cur.fetchone()
            if not trow:
                raise HTTPException(404, f"target agent {body.target_agent_id} not found")
            target_container = trow["container_id"]

        cur.execute(
            """INSERT INTO decisions
                 (container_id, subject_type, subject_id, decision, reason,
                  actor_agent_id, target_agent_id)
               VALUES (%s, %s, %s, %s, %s, %s, %s)
               RETURNING id, created_at""",
            (target_container, body.subject_type, body.subject_id, body.decision,
             (reason or None), body.actor_agent_id, body.target_agent_id),
        )
        row = cur.fetchone()
        decision_id = str(row["id"])

        # Route {decision, reason} to the agent so its next wake sees the WHY.
        if body.target_agent_id is not None:
            _publish_event(
                cur,
                str(target_container) if target_container else None,
                str(body.target_agent_id),
                "decision_made",
                {"decision_id": decision_id,
                 "subject_type": body.subject_type,
                 "subject_id": body.subject_id,
                 "decision": body.decision,
                 "reason": (reason or None)},
            )
        # ISS-48: a decision_made event wakes the agent, but the agent's source of truth is the
        # task THREAD — so also post an attributed decision message there. Without it an approved
        # plan-first agent re-reads the thread, sees no approval, and re-plans forever.
        _post_decision_to_thread(cur, body.subject_type, body.subject_id,
                                  body.decision, (reason or None), body.actor_agent_id)

    return {"decision_id": decision_id,
            "decision": body.decision,
            "reason": (reason or None),
            "subject_type": body.subject_type,
            "subject_id": body.subject_id,
            "target_agent_id": body.target_agent_id,
            "created_at": row["created_at"].isoformat()}


@app.get("/api/decisions/{did}")
def get_decision(did: str):
    if not _valid_uuid(did):
        raise HTTPException(400, "decision_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        cur.execute(
            """SELECT id, container_id, subject_type, subject_id, decision, reason,
                      actor_agent_id, target_agent_id, created_at
               FROM decisions WHERE id=%s""", (did,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, f"decision {did} not found")
        return {
            "decision_id": str(row["id"]),
            "container_id": str(row["container_id"]) if row["container_id"] else None,
            "subject_type": row["subject_type"],
            "subject_id": row["subject_id"],
            "decision": row["decision"],
            "reason": row["reason"],
            "actor_agent_id": str(row["actor_agent_id"]),
            "target_agent_id": str(row["target_agent_id"]) if row["target_agent_id"] else None,
            "created_at": row["created_at"].isoformat(),
        }
