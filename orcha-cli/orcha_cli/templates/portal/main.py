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
import secrets  # GH #91/#90: mint per-process embodiment run tokens (secrets.token_urlsafe)
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Literal, Optional

import psycopg
from fastapi import File, Header, HTTPException, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    StreamingResponse,
)
from pydantic import BaseModel, Field
from portal_backend.attachment_config import (
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENTS_PER_MESSAGE,
    MAX_EXTRACTED_TEXT_CHARS,
    configure_compatibility as _configure_attachment_compatibility,
)
from portal_backend.attachment_references import (
    attachment_ref as _attachment_ref,
    attachment_ref_for as _attachment_ref_for,
    conv_attachment_ref as _conv_attachment_ref,
    conversation_attachments_dir as _conversation_attachments_dir,
    render_attachment_feed_line as _render_attachment_feed_line,
    resolve_stored_attachment as _resolve_stored_attachment,
    resolve_stored_conv_attachment as _resolve_stored_conv_attachment,
    task_attachments_dir as _task_attachments_dir,
    validate_attachment_refs as _validate_attachment_refs,
    validate_conv_attachment_refs as _validate_conv_attachment_refs,
    validate_refs_in as _validate_refs_in,
)
from portal_backend.attachment_storage import (
    ATTACHMENT_INLINE_EXT as _ATTACHMENT_INLINE_EXT,
    ATTACHMENT_TYPES as _ATTACHMENT_TYPES,
    SAFE_STORED_NAME as _SAFE_STORED_NAME,
    attachment_content_type as _attachment_content_type,
    attachment_ext as _attachment_ext,
    attachment_extracted_text as _attachment_extracted_text,
    attachment_kind as _attachment_kind,
    attachment_text_cache_path as _attachment_text_cache_path,
    contained_path as _contained_path,
    read_cached_attachment_text as _read_cached_attachment_text,
    resolve_stored_in as _resolve_stored_in,
    sanitize_attachment_name as _sanitize_attachment_name,
    write_cached_attachment_text as _write_cached_attachment_text,
)
from portal_backend.application import (
    app,
    no_store_dynamic_responses as _no_store_dynamic_responses,
)
from portal_backend.database import DB, db_cursor, run_migrations
from portal_backend.agent_status import (
    bump_agent,
    log_event,
    recompute_agent_status,
    set_agent_status,
    touch_heartbeat as _touch_heartbeat,
)
from portal_backend.events import (
    fetch_next_event as _fetch_next_event,
    poke_path_forward as _poke_path_forward,
    publish_event as _publish_event,
    wait_for_event as _wait_for_event,
)
from portal_backend.event_acknowledgement import (
    _ack_events_handled,
    _recompute_delivered_floor,
)
from portal_backend.event_policy import (
    _NON_WAKING_EVENTS,
    _RESIDENT_DRAIN_AUDIT_EVENTS,
    _TIER0_FYI_EVENTS,
    _WORK_NON_WAKING_EVENTS,
    _triage_hint_for,
)
from portal_backend.drain_classification import (
    _DRAIN_DIRECTIVE,
    _DRAIN_FYI,
    _DRAIN_NEW_WORK,
    _DRAIN_NON_WAKING,
    _DRAIN_RUN_ACKABLE,
    _DRAIN_TASK_BOUND,
    _DRAIN_TASKLESS_ACTIONABLE,
    _DRAIN_TASK_SCOPED,
    _drain_class,
    _drain_task_status,
    _is_cross_task_drain_row,
)
from portal_backend.directed_message_collection import collect_directed_messages
from portal_backend.guards import (
    agent_participates_in_task as _agent_participates_in_task,
    pick_human as _pick_human,
    reject_if_retired as _reject_if_retired,
    require_agent as _require_agent,
    require_container as _require_container,
    require_container_active as _require_container_active,
    require_kind as _require_kind,
    require_task as _require_task,
    resolve_alias as _resolve_alias,
    valid_uuid as _valid_uuid,
)
from portal_backend.limits import (
    MAX_DESC_LEN,
    MAX_DOD_LEN,
    MAX_FEEDBACK_LEN,
    MAX_NAME_LEN,
    MAX_PAYLOAD_LEN,
    MAX_PROMPT_BATCH_CHARS,
    MAX_PROMPT_LEN,
    MAX_PROTOCOL_FIELD_LEN,
    MAX_SELF_WAKE_CONTEXT_LEN,
    MAX_TURN_LEN,
)
from portal_backend.model_policy import (
    AVAILABLE_MODELS,
    AVAILABLE_REASONING_EFFORTS,
    DEFAULT_MODEL,
    DEFAULT_REASONING_EFFORT,
    MODELS_BY_ID as _MODELS_BY_ID,
    MODEL_IDS as _MODEL_IDS,
    REASONING_EFFORT_IDS as _REASONING_EFFORT_IDS,
    resolve_reasoning_effort,
)
from portal_backend.provider_keys import (
    container_llm_key as _container_llm_key,
    effective_use_case_provider as _effective_use_case_provider,
    provider_api_key as _provider_api_key,
    provider_key_enc as _provider_key_enc,
    provider_stored_row as _provider_stored_row,
)
from portal_backend.notification_formatting import (
    _classify_notification,
    _notification_origin_order,
    _notification_rank,
    _notification_surface,
)
from portal_backend.notification_taxonomy import (
    _NOTIF_ACTOR_FIELDS,
    _NOTIF_PREVIEW_FIELDS,
    _NOTIF_PRI_ANSWER,
    _NOTIF_PRI_CLOSE,
    _NOTIF_PRI_HUMAN_CONVO,
    _NOTIF_PRI_INTERRUPT,
    _NOTIF_PRI_OWN_WORK,
    _NOTIF_PRI_REQUEST_IN,
    _NOTIF_PRI_TASK,
    _NOTIF_PRI_UNKNOWN,
    _NOTIF_PRIORITY_LADDER,
    _NOTIF_PRIORITY_TO_LABEL,
    _NOTIF_PRIORITY_TO_RANK,
    _NOTIF_SUPPRESSED,
    _NOTIF_TAXONOMY,
    _WAKE_NOTIFICATION_MANIFEST_LIMIT,
)
from portal_backend.request_ownership import (
    STALE_ANSWERED_SECS,
    _annotate_request_ownership,
)
from portal_backend.self_wake_selection import select_due_self_wake
from portal_backend.static_pages import (
    STATIC_DIR as _STATIC_DIR,
    missing_static_page as _missing_static_page,
    serve_page as _serve,
)
from portal_backend.wake_manifest import _wake_notification_manifest
from portal_backend.wake_event_queries import (
    earliest_actionable_answer_ts,
    resident_inbox_task_work_id,
)
from portal_backend.wake_context import (
    filter_context_content,
    handled_event_ids as collect_handled_event_ids,
    resolve_context_task_id,
)
from portal_backend.wake_decision import decide_wake, triage_eligible
from portal_backend.wake_scan_queries import (
    has_pending_task_request as query_pending_task_request,
    list_wake_agents,
    newest_answer_task_id,
    pending_event_summary,
    ready_task_ids,
    request_answer,
)
from portal_backend.schemas.agent_state import (
    AgentModelUpdate,
    AgentReasoningEffortUpdate,
    AgentRetire,
    AgentUpdate,
    AutoWakeUpdate,
    DecisionCreate,
    DigestSnapshot,
    NotificationsRead,
    ReachabilityUpsert,
    SelfWakeSet,
)
from portal_backend.schemas.conversations import (
    ConversationActor,
    ConversationSession,
    ConversationStart,
    TurnAppend,
)
from portal_backend.schemas.requests import (
    AgentSuggestion,
    NudgeBody,
    RequestActorBody,
    RequestConvert,
    RequestCreate,
    RequestRespond,
    SuggestionDecision,
    TaskRequestAccept,
    TaskRequestPayload,
    TaskRequestReject,
    TriageCloseBody,
)
from portal_backend.schemas.task_operations import (
    AssignTask,
    TaskCancel,
    TaskDone,
    TaskMessage,
    TaskReadiness,
    TaskUnassign,
    TaskVerify,
)
from portal_backend.schemas.wakes import (
    AutonomyUpdate,
    EmbodimentTokenMint,
    EventsAckHandled,
    PromptEvent,
    WakeAck,
    WakeClaim,
    WakesToggle,
)
from portal_backend.schemas.worker_runs import (
    WorkerRunFinish,
    WorkerRunLines,
    WorkerRunStart,
    WorkerRunStop,
)
from portal_backend.schemas import (
    AgentCreate,
    AgentCreateResponse,
    ContainerCreate,
    ContainerCreateResponse,
    ContainerReset,
    ContainerStatusUpdate,
    InitialTask,
    LlmKeyActor,
    LlmKeyTest,
    LlmKeyUpdate,
    ModelSettingOverride,
    ModelSettingsUpdate,
    ProposeBody,
    ProposeDialogueTurn,
    ProtocolFields,
    ProtocolUpdate,
    TaskCreateBody,
)

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

ONBOARDING_LOG = logging.getLogger("orcha.onboarding")
KEYTEST_LOG = logging.getLogger("orcha.llm-key-test")
PAIRING_TTL_SECONDS = 5 * 60
PAIRING_TOKEN_EXCHANGE_FOLLOWUP = {
    "status": "follow_up",
    "endpoint": "POST /api/pair/device-token",
    "note": "Mobile device-token exchange/auth is not implemented in this slice.",
}
ATTACHMENTS_DIR = pathlib.Path(
    os.environ.get("ORCHA_ATTACHMENTS_DIR", "/app/orcha-attachments")
)
_configure_attachment_compatibility(
    lambda: ATTACHMENTS_DIR,
    lambda: MAX_ATTACHMENT_BYTES,
)

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


ALLOWED_CONTAINER_STATUSES = {"active", "paused", "completed", "cancelled", "failed"}

# The full request lifecycle vocabulary (requests.status, free TEXT — see
# migrations/001_init.sql:111). Used to validate the optional ?status filter on the
# paginated request list so callers can scope a census to one lifecycle state instead
# of silently mixing in closed/answered rows.
REQUEST_STATUSES = {
    "open",
    "accepted",
    "rejected",
    "answered",
    "converted_to_task",
    "closed",
}


def resolve_model(model: Optional[str]) -> str:
    """Compatibility seam for tests that temporarily retire a model."""
    return model if model in _MODEL_IDS else DEFAULT_MODEL


def resolve_model_runtime(model: Optional[str]) -> str:
    """Return the local agent runtime for a persisted/resolved model id.

    Unknown or retired ids first resolve through DEFAULT_MODEL, preserving the same
    zero-breakage fallback as resolve_model. Existing Claude agents therefore remain
    Claude-backed, while Codex model selections tell the host daemon to spawn Codex.
    """
    return _MODELS_BY_ID.get(resolve_model(model), {}).get("runtime", "claude")


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


# ---------- R1: incremental migration runner (Phase 0.5) ----------
# migrations/001_init.sql only runs via Postgres initdb on a FRESH volume, so there was
# no way to add a table to a live DB (the manual psql replays + wipe-on-reinit pain).
# This applies migrations/*.sql in lexical order, each in its own txn, idempotently
# (tracked in schema_migrations), so `orcha up` (which restarts the portal -> startup
# hook below) applies pending migrations to an EXISTING volume with NO wipe.
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
        print(
            "[migrate] DB not reachable at startup; skipping (will retry next boot)",
            flush=True,
        )
        return
    try:
        applied = run_migrations()
        print(
            f"[migrate] applied: {applied}"
            if applied
            else "[migrate] schema up to date",
            flush=True,
        )
    except Exception as e:
        # Review (Tim): HARD-FAIL by default — the running portal expects this migration's
        # schema, so serving a stale/half-migrated DB is worse than a loud boot failure
        # (raising aborts startup -> the container exits, surfacing the problem). Opt into
        # resilience with ORCHA_MIGRATE_ON_FAILURE=continue (log + serve current schema).
        if os.environ.get("ORCHA_MIGRATE_ON_FAILURE", "halt").lower() == "continue":
            print(
                f"[migrate] ERROR (ORCHA_MIGRATE_ON_FAILURE=continue — serving current schema): {e}",
                flush=True,
            )
            return
        print(
            f"[migrate] FATAL: {e} — aborting startup "
            "(set ORCHA_MIGRATE_ON_FAILURE=continue to serve anyway)",
            flush=True,
        )
        raise


app.on_event("startup")(
    _startup_migrate
)  # run pending migrations when the portal boots


@app.post("/api/admin/migrate", status_code=200)
def admin_migrate():
    """Apply pending migrations on demand (R1.3 — used by `orcha migrate`)."""
    try:
        applied = run_migrations()
    except Exception as e:
        raise HTTPException(500, f"migration failed: {e}")
    return {"applied": applied, "count": len(applied)}


from portal_backend.onboarding_prompt import (
    _ASK_CLARIFY_TOOL,
    _propose_error,
    _propose_messages,
    _propose_roster_tool_schema,
    _propose_roster_was_truncated,
    _propose_should_force_roster,
    _propose_sse,
    _propose_system_prompt,
)


from portal_backend.protocol_helpers import _build_report_back, _clean_protocol


from portal_backend.onboarding_normalization import _normalize_roster_payload


# ---- E3 conversation store (resident-session thread; docs/orcha-conversation-model.md) ----


# ---------- containers ----------


from portal_backend.container_lifecycle_routes import (
    create_container,
    list_containers,
    reset_container,
)


@app.get("/api/terminal/config")
def terminal_config():
    """S3 §3b: where the embedded-terminal frontend (terminal.js) opens its websocket. The PTY
    bridge is a SEPARATE host-side server (not a portal route), so the browser connects directly
    to `ws_url` + `/api/agents/<aid>/terminal?actor_agent_id=<human>`. Localhost/trusted-local."""
    return {"ws_url": TERMINAL_WS_URL}


from portal_backend.container_pairing_routes import (
    PAIRING_TOKEN_EXCHANGE_FOLLOWUP,
    PAIRING_TTL_SECONDS,
    get_container_pairing,
    is_local_pairing_host as _is_local_pairing_host,
    pairing_base_url as _pairing_base_url,
    pairing_warning as _pairing_warning,
    qr_svg as _qr_svg,
    short_pairing_code as _short_pairing_code,
)
from portal_backend.container_snapshot_routes import get_container
from portal_backend.container_token_usage_routes import (
    MEASURED_USAGE as _MEASURED_USAGE,
    container_token_usage,
    quota_env as _quota_env,
)
from portal_backend.list_sorting import (
    sort_clause as _sort_clause,
    validate_sort as _validate_sort,
)
from portal_backend.container_task_list_routes import list_container_tasks
from portal_backend.container_request_list_routes import (
    REQUEST_STATUSES,
    list_container_requests,
)


from portal_backend.container_lifecycle import (
    list_models,
    list_reasoning_efforts,
    set_container_status,
)


from portal_backend.llm_key_routes import (
    _llm_error_public_detail,
    _mask_llm_key,
    delete_container_llm_key,
    get_container_llm_key,
    put_container_llm_key,
    test_container_llm_key,
)


from portal_backend.provider_key_routes import (
    _available_provider,
    _ping_provider_key,
    delete_container_provider_key,
    list_container_provider_keys,
    put_container_provider_key,
    test_container_provider_key,
)


from portal_backend.model_setting_routes import (
    _resolve_use_case_model,
    get_settings_models,
    get_settings_providers,
    put_settings_models,
)


from portal_backend.onboarding_routes import propose_onboarding_roster


# ---------- agents ----------


from portal_backend.agent_registration_routes import (
    configure_model_ids as _configure_agent_model_ids,
    register_agent,
)
from portal_backend.agent_task_claim_routes import agent_next

_configure_agent_model_ids(lambda: _MODEL_IDS)


from portal_backend.agent_request_box_routes import agent_inbox, agent_outbox


from portal_backend.agent_notification_routes import (
    agent_notifications,
    agent_notifications_read,
)
from portal_backend.agent_profile_routes import retire_agent, update_agent
from portal_backend.agent_reachability_routes import (
    get_reachability,
    set_reachability,
)
from portal_backend.agent_self_wake_routes import (
    cancel_agent_self_wake,
    schedule_agent_self_wake,
)
from portal_backend.agent_wake_policy_routes import update_agent_auto_wake
from portal_backend.agent_model_routes import (
    configure_catalogs as _configure_agent_catalogs,
    set_agent_model,
    set_agent_reasoning_effort,
)

_configure_agent_catalogs(lambda: _MODEL_IDS, lambda: _REASONING_EFFORT_IDS)
# ---------- conversation store (E3 persistence; docs/orcha-conversation-model.md) ----------

from portal_backend.conversation_read_routes import (
    TURN_COLUMNS as _TURN_COLS,
    get_agent_conversation,
    get_conversation,
    list_turns,
    start_conversation,
)


from portal_backend.conversation_write_routes import append_turn


from portal_backend.conversation_write_routes import (
    end_conversation,
    set_conversation_session,
)


def _collect_directed_messages(cur, aid: str, delivered_ts, max_ts):
    """Compatibility seam for bounded directed-message collection."""
    return collect_directed_messages(
        cur,
        aid,
        delivered_ts,
        max_ts,
        max_chars=MAX_PROMPT_BATCH_CHARS,
        render_attachment_feed_line=_render_attachment_feed_line,
        drain_class=_drain_class,
    )


def _earliest_actionable_answer_ts(cur, aid: str, delivered_ts):
    """Compatibility seam for actionable pending-answer lookup."""
    return earliest_actionable_answer_ts(cur, aid, delivered_ts)


def _resident_inbox_task_work_id(cur, aid: str, delivered_ts, max_ts):
    """Compatibility seam for resident work-lane event lookup."""
    return resident_inbox_task_work_id(
        cur, aid, delivered_ts, max_ts, valid_uuid=_valid_uuid
    )


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
    excl = (
        list(_NON_WAKING_EVENTS)
        + ["conversation_turn"]
        + list(_RESIDENT_DRAIN_AUDIT_EVENTS)
    )
    with db_cursor() as (_, cur):
        _require_container(cur, cid)
        cur.execute(
            """SELECT cv.id AS conversation_id, cv.agent_id, a.alias AS agent_alias, a.model,
                      a.reasoning_effort,
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
                           AND ev.ts > COALESCE(ws.conv_delivered_ts, 0)
                           AND ev.event_name = 'conversation_turn') AS conversation_ack_ts,
                      -- GH #58 (review fix): anti-join agent_event_acks so an ALREADY-handled row
                      -- never counts as pending_inbox. A `request_closed` audit row (excluded from
                      -- the resident drain) pins the contiguous floor LOW, so a later already-acked
                      -- row sits ABOVE the floor; without this anti-join it inflated pending_inbox
                      -- while drain_ackable_ids (which DOES anti-join) stayed empty — the resident
                      -- then kept spawning no-op drain sidecars. Now consistent with the floor
                      -- recompute, the manifest, _collect_directed_messages and drain_ackable_ids.
                      COALESCE((SELECT count(*) FROM agent_events ev
                                 WHERE ev.event_key = cv.agent_id::text
                                   AND ev.ts > COALESCE(ws.delivered_ts, 0)
                                   AND ev.event_name <> ALL(%s)
                                   AND NOT EXISTS (SELECT 1 FROM agent_event_acks a
                                                    WHERE a.agent_id = cv.agent_id
                                                      AND a.event_id = ev.id)), 0) AS pending_inbox,
                      (SELECT max(ev.ts) FROM agent_events ev
                         WHERE ev.event_key = cv.agent_id::text
                           AND ev.ts > COALESCE(ws.delivered_ts, 0)
                           AND ev.event_name <> ALL(%s)
                           AND NOT EXISTS (SELECT 1 FROM agent_event_acks a
                                            WHERE a.agent_id = cv.agent_id
                                              AND a.event_id = ev.id)) AS _inbox_max_ts
               FROM conversations cv
               JOIN agents a ON a.id = cv.agent_id
               LEFT JOIN agent_wake_state ws ON ws.agent_id = cv.agent_id
               LEFT JOIN LATERAL (
                   SELECT seq, role FROM conversation_turns
                   WHERE conversation_id = cv.id ORDER BY seq DESC LIMIT 1
               ) t ON true
               WHERE cv.container_id = %s AND cv.status = 'active'
               ORDER BY cv.last_turn_at ASC NULLS FIRST""",
            (excl, excl, cid),
        )
        convs = cur.fetchall()
        for r in convs:
            # last_turn_role is NULL only for a brand-new conversation with no turns yet.
            r["last_turn_seq"] = r["last_turn_seq"] or 0
            r["pending_human"] = r["last_turn_role"] == "human"
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
                _auto_iv is not None and (_ssw is None or _ssw >= _auto_iv)
            )
            r.pop("turns_used", None)
            r.pop("turn_budget", None)
            r.pop("_secs_since_woken", None)
            # GAP A (resident): the model the daemon spawns this resident with, resolved
            # server-side (retired model → DEFAULT_MODEL). Pairs with GAP B: set_agent_model
            # clears the pinned session_id on a model change so the next boot is COLD and
            # actually picks this up (a warm --resume keeps the old in-session model).
            r["model"] = resolve_model(r["model"])
            r["model_runtime"] = resolve_model_runtime(r["model"])
            r["reasoning_effort"] = resolve_reasoning_effort(
                r["reasoning_effort"]
            )  # GH #51
            # ISS-74 (review fix): `prompt`/`task_message` events carry content with NO inbox surface —
            # they're delivered ONLY by injecting the text. So surface the bounded directed-message
            # batch (same semantics as wake_scan) and ACK ONLY THROUGH the last included one, so a
            # drain can never mark a directed message delivered without its content reaching the agent.
            if r["pending_inbox"]:
                msgs, _tid, ack_ts = _collect_directed_messages(
                    cur, str(r["agent_id"]), r["_delivered_ts"], r["_inbox_max_ts"]
                )
                # Resident drain injects every surfaced message's text (unchanged): a task-carrying row
                # forces the daemon to YIELD the lease to a protocol-bound ephemeral, so the resident
                # never silently owns cross-task work — no context filter needed here.
                r["inbox_messages"] = [m["text"] for m in msgs]
                r["inbox_ack_ts"] = ack_ts
                # #72: a warm resident's drain sidecar may NOT do task work, so it must never ack the
                # cursor PAST an answer that unblocks this agent's own task — that would erase the only
                # trigger and, after the resident exits, no worker would spawn to act on the green
                # light. Park strictly BEFORE the earliest such answer: drain only the events ahead of
                # it (drainable_inbox) and clamp inbox_ack_ts to the newest of those. When nothing is
                # drainable (the answer is the sole/earliest queued event) inbox_ack_ts is None and the
                # daemon skips the sidecar entirely, leaving the answer pending for the post-exit
                # ephemeral wake. No actionable answer queued → unchanged (drain the whole backlog).
                floor = _earliest_actionable_answer_ts(
                    cur, str(r["agent_id"]), r["_delivered_ts"]
                )
                if floor is not None:
                    cur.execute(
                        """SELECT count(*) AS n, max(ts) AS mx FROM agent_events
                           WHERE event_key = %s AND ts > %s AND ts < %s
                             AND event_name <> ALL(%s)""",
                        (str(r["agent_id"]), r["_delivered_ts"], floor, excl),
                    )
                    drow = cur.fetchone()
                    r["drainable_inbox"] = drow["n"] or 0
                    safe = drow[
                        "mx"
                    ]  # newest drainable event ts strictly before the answer (or None)
                    if safe is None:
                        r["inbox_ack_ts"] = None
                    elif ack_ts is None:
                        r["inbox_ack_ts"] = safe
                    else:
                        r["inbox_ack_ts"] = min(ack_ts, safe)
                else:
                    r["drainable_inbox"] = r["pending_inbox"]
                r["inbox_wake_task_id"] = _resident_inbox_task_work_id(
                    cur, str(r["agent_id"]), r["_delivered_ts"], r["_inbox_max_ts"]
                )
            else:
                r["inbox_messages"] = []
                r["inbox_ack_ts"] = None
                r["drainable_inbox"] = 0
                r["inbox_wake_task_id"] = None
            # GH #58 (§5.2 warm-zone): classify each queued inbox row so the resident drain sidecar
            # handles ONLY safe rows — FYI + taskless-actionable, which any run may ack with no task
            # protocol — and the daemon YIELDS the lease to a protocol-bound ephemeral whenever a
            # TASK_BOUND / NEW_WORK / DIRECTIVE row is present (those need that task's own run; a
            # resident carries no injected protocol, so its run-context is NONE → a task-carrying row is
            # never "matching" and always forces the yield). `drain_ackable_ids` are the exact event ids
            # the sidecar may post to /events/ack-handled on clean exit.
            drain_taskbound = 0
            drain_ackable_ids: list[int] = []
            if r["pending_inbox"]:
                cur.execute(
                    """SELECT e.id, e.event_name, e.payload, e.target_id FROM agent_events e
                       WHERE e.event_key=%s AND e.ts > %s AND e.event_name <> ALL(%s)
                         AND NOT EXISTS (SELECT 1 FROM agent_event_acks a
                                          WHERE a.agent_id=%s AND a.event_id=e.id)
                       ORDER BY e.ts, e.id""",
                    (str(r["agent_id"]), r["_delivered_ts"], excl, str(r["agent_id"])),
                )
                for _row in cur.fetchall():
                    _b = _drain_class(
                        cur,
                        _row["event_name"],
                        _row["payload"],
                        target_id=_row["target_id"],
                    )["bucket"]
                    if _b in _DRAIN_RUN_ACKABLE:
                        drain_ackable_ids.append(_row["id"])
                    elif _b in (_DRAIN_TASK_BOUND, _DRAIN_NEW_WORK, _DRAIN_DIRECTIVE):
                        drain_taskbound += 1
            r["drain_taskbound"] = drain_taskbound
            r["drain_ackable_ids"] = drain_ackable_ids
            r.pop("_delivered_ts", None)
            r.pop("_inbox_max_ts", None)
    return {"container_id": cid, "conversations": convs}


from portal_backend.persona_protocol_routes import (
    configure_model_resolution as _configure_persona_model_resolution,
    get_agent_protocol,
    get_persona,
)

_configure_persona_model_resolution(
    lambda model: resolve_model(model),
    lambda model: resolve_model_runtime(model),
)


from portal_backend.wake_lease_claim_routes import (
    resolve_claim_lane as _resolve_claim_lane,
    wake_claim,
)
from portal_backend.wake_lease_renewal_routes import wake_renew


@app.get("/api/containers/{cid}/wake-scan")
def wake_scan(
    cid: str,
    cooldown: float = Query(default=15.0, ge=0),
    min_idle: float = Query(default=30.0, ge=0),
):
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
        cur.execute(
            "SELECT wakes_enabled, autonomy_level FROM containers WHERE id=%s", (cid,)
        )
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
        triage_key_enc = _provider_key_enc(
            cur, cid, _effective_use_case_provider(triage_model, "triage")
        )
        ack_key_enc = _provider_key_enc(
            cur, cid, _effective_use_case_provider(ack_model, "ack")
        )
        agents = list_wake_agents(cur, cid, cooldown)

        candidates = []
        for a in agents:
            aid = str(a["id"])
            # ISS-58: the should_wake `pending` count excludes _NON_WAKING_EVENTS (self-echo
            # notifications like digest_snapshotted) so they never wake the agent — but max_ts is
            # over ALL events so the ack still advances past them (they don't accumulate uncounted).
            # GH #91/#90: this is the WORK-lane count, so it uses _WORK_NON_WAKING_EVENTS (adds
            # `conversation_turn`) — a bare human chat message is the conversation lane's surface and
            # must not by itself wake a WORK embodiment. max_ts is still over ALL events (unfiltered),
            # so a work ack advances the work cursor past a conversation_turn too (it never accumulates
            # uncounted); the conversation lane consumes it via its own delivered cursor.
            # GH #58: a pending event already in the per-event handled-set (acked by a prior drain pass
            # or at its seam) must NOT re-count toward should_wake — that is what lets one run drain
            # several events without each re-waking.
            pending, max_ts, latest, latest_payload = pending_event_summary(
                cur, aid, a["delivered_ts"], _WORK_NON_WAKING_EVENTS
            )
            # Pending directed messages — surfaced (oldest-first) to the woken worker via
            # build_wake_prompt so it acts on them, not just "drain the inbox". `prompt` and
            # `task_message` carry content with NO inbox surface (surfacing is the ONLY delivery
            # path), so the cursor is acked only THROUGH the last included one. Shared with the
            # resident inbox-drain path (ISS-74) via _collect_directed_messages — identical semantics.
            if pending:
                directed_msgs, wake_task_id, ack_through_ts = (
                    _collect_directed_messages(cur, aid, a["delivered_ts"], max_ts)
                )
                notifications, notifications_truncated = _wake_notification_manifest(
                    cur, aid, a["delivered_ts"]
                )
                # GH #56 (Point 3 / FLAG 2a part b): if no directed-message task claimed the wake,
                # attach it to the originating task of the newest pending answer. A `request_answered`
                # event (the requester's own ask coming back) carries `originating_task_id` — the task
                # the requester was working on when it asked (respond_request / the Point 5 backstop
                # both stamp it). Surfacing it as wake_task_id makes run-attribution stamp the run
                # against THAT task (activity shows on its thread) and lets the protocol load key off
                # the link. Null/taskless asks (originating_task_id absent) leave wake_task_id None —
                # unchanged behaviour. Only set when the linked task is still live (not deleted).
                if wake_task_id is None:
                    wake_task_id = newest_answer_task_id(cur, aid, a["delivered_ts"])
            else:
                directed_msgs, wake_task_id, ack_through_ts = [], None, max_ts
                notifications, notifications_truncated = [], False
            # #72: is any pending answer/close event one that unblocks THIS agent's task work? If so a
            # $0 drain/auto-close (#288 suppress / #307 cheap-act) must NOT consume it — a real worker
            # has to spawn to act on the answer. Used below to EXEMPT it from the triage hint (no hint
            # → decide_wake_tier returns 'full' → spawn) and surfaced for the portal/debug + tests.
            actionable_answer_ts = (
                _earliest_actionable_answer_ts(cur, aid, a["delivered_ts"])
                if pending
                else None
            )
            # Assigned-and-ready tasks = auto-start targets (deps cleared, awaiting
            # the owner to claim+begin). Root is excluded — only the human verifies it.
            # Order by priority, created_at so auto_start_task_ids[0] (what the notifier attributes
            # the run to) is the SAME task /orcha-next claims first — keeps run attribution exact
            # for the B5/O4 assign-then-wake path. [review P1]
            auto_tasks = ready_task_ids(cur, aid, cid)

            # GH #91/#90: an UNCAPPED work-lane signal — an OPEN task request addressed to this agent
            # that it still owes an accept/reject. This is task-shaped work that must ALWAYS full-boot
            # the WORK lane (a conversation lane cannot accept it), so it folds into has_work below,
            # forces a full boot (never suppressed), and is surfaced on the candidate so the notifier's
            # tier/suppression deciders short-circuit to a full work wake.
            has_pending_task_request = query_pending_task_request(cur, aid)

            # GH #122: one-shot, per-task self-scheduled wakes. First remove rows that can never
            # fire (task left in_progress or this agent is no longer an active assignee), then bind
            # a due row only when no higher-precedence target will steer the worker elsewhere.
            (
                self_wake_due,
                self_wake_context,
                self_wake_task_id,
                wake_task_id,
            ) = select_due_self_wake(
                cur,
                aid,
                wake_task_id,
                auto_tasks=auto_tasks,
                pending_task_request=has_pending_task_request,
                valid_uuid=_valid_uuid,
            )

            # GH #91/#90: WORK-lane idle keys on the lane's OWN heartbeat (work_last_heartbeat_at),
            # NULL => idle=true (never beat = no live work embodiment to be 'busy'). The agent-wide
            # idle_seconds (bumped by a conversation renew too) is kept for debug only and no longer
            # gates the work wake.
            idle_seconds = a["idle_seconds"]  # agent-wide, debug/back-compat only
            work_idle_seconds = a["work_idle_seconds"]

            # GH #58: the events THIS run may mark handled in a single drain pass, and the task its
            # context is bound to. Context precedence (R2 point 3): the task /orcha-next will actually
            # claim (auto_start[0]) wins; else the directed/answer-derived (or GH#122 self-wake-bound)
            # wake_task_id. A run drains FYI + taskless-actionable (any run) plus the TASK_BOUND events
            # whose task == context; it LEAVES cross-task task_bound, NEW_WORK and DIRECTIVE rows
            # pending (their own run / seam acks them). Bounded by ack_through_ts so a truncated
            # directed batch's tail is never acked-away undelivered. The daemon posts these ids to
            # /events/ack-handled at run COMPLETION. GH #91/#90: scoped like the should_wake count above
            # — _WORK_NON_WAKING_EVENTS (excludes a bare conversation_turn, the conversation lane's own
            # surface) since this is the WORK-lane drain.
            initial_context_task_id = auto_tasks[0] if auto_tasks else wake_task_id
            # GH #58 (R4 fix): a task-scoped DIRECTIVE/TASK_BOUND row can be the SOLE pending event
            # AFTER its task was already claimed — a rejected verification (task_verified{approved:false})
            # or a plan decision (decision_made plan_approval), whose assignment/readiness rows were
            # already consumed at the /next claim. The task is in_progress (not 'ready', so auto_tasks
            # is empty) and these directives never feed wake_task_id (that is directed-message / answer
            # derived only) — so context_task_id would stay None, the cross-task filter below would drop
            # the very row that woke us, and the worker would wake with one pending event but no task,
            # no protocol, no surfaced directive. When nothing else has selected a context, derive it
            # from the NEWEST pending task-scoped (TASK_BOUND / DIRECTIVE) row whose task is still live
            # (latest wins — same precedence as wake_task_id). Other tasks' rows stay cross-task and
            # re-surface on their own run. NEW_WORK is intentionally excluded: it is grounded via the
            # /next claim (auto_tasks) or the accept/reject seam, never by passively waking a context.
            context_task_id = resolve_context_task_id(
                cur,
                aid,
                a["delivered_ts"],
                ack_through_ts,
                initial_task_id=initial_context_task_id,
                pending=pending,
                non_waking_events=_NON_WAKING_EVENTS,
                drain_class=_drain_class,
                drain_task_status=_drain_task_status,
                task_bound_bucket=_DRAIN_TASK_BOUND,
                directive_bucket=_DRAIN_DIRECTIVE,
            )
            # GH #58 (R2 fix): now that the run-context task is known, surface ONLY the directed
            # messages this run will actually handle. Drop a cross-task TASK_BOUND/NEW_WORK/DIRECTIVE
            # row (task != context) — it stays pending for that task's own protocol-bound ephemeral, so
            # a task-B worker is never told to read/respond on task A. Taskless rows (prompt) and the
            # context task's own rows are kept. This MIRRORS the handled_event_ids drain rule below, so
            # a message is surfaced iff this run either acks it (FYI/taskless/context task_bound) or
            # owns it (context new_work/directive) — surfacing and acking can never disagree.
            # GH #58 (R3 fix): the ranked wake manifest is rendered verbatim by build_wake_prompt as
            # "RANKED WAKE MANIFEST - drain in this order", so it must obey the SAME run-context rule as
            # prompt_messages — otherwise a task-B run is told to drain task A's task-scoped rows even
            # though those rows are left pending for task A's own protocol-bound run. Drop the cross-task
            # task-scoped rows here (one predicate shared with prompt_messages above) before the manifest
            # reaches the candidate dict. FYI / taskless rows and the context task's own rows stay; a
            # task-less 'task' request_created stays (any run may accept it → #359 is_task_request path).
            prompt_messages, notifications = filter_context_content(
                directed_msgs,
                notifications,
                context_task_id,
                is_cross_task=_is_cross_task_drain_row,
            )
            handled_event_ids = collect_handled_event_ids(
                cur,
                aid,
                a["delivered_ts"],
                ack_through_ts,
                pending=pending,
                context_task_id=context_task_id,
                non_waking_events=_WORK_NON_WAKING_EVENTS,
                drain_class=_drain_class,
                run_ackable_buckets=_DRAIN_RUN_ACKABLE,
                task_bound_bucket=_DRAIN_TASK_BOUND,
            )
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
            wake_enabled = a["wake_enabled"]
            in_cooldown = bool(a["in_cooldown"])
            lease_active = bool(a["lease_active"])
            lease_kind = a["lease_kind"]
            embodiment_running = bool(a["embodiment_running"])
            conv_lease_active = bool(a["conv_lease_active"])
            conv_embodiment_running = bool(a["conv_embodiment_running"])
            auto_wake_due, should_wake, reason = decide_wake(
                container_status=c["status"],
                wakes_enabled=wakes_enabled,
                agent_wake_enabled=wake_enabled,
                pending=pending,
                latest=latest,
                notifications=notifications,
                auto_tasks=auto_tasks,
                auto_interval=auto_interval,
                secs_since_woken=secs_since_woken,
                pending_task_request=has_pending_task_request,
                self_wake_due=self_wake_due,
                work_idle_seconds=work_idle_seconds,
                min_idle=min_idle,
                in_cooldown=in_cooldown,
                lease_active=lease_active,
                lease_kind=lease_kind,
                embodiment_running=embodiment_running,
            )

            # #288 wake-suppression: attach a triage_hint ONLY when the agent's SOLE pending signal
            # is a single FYI/answer event — no ready task, no directed message, exactly one event.
            # That narrowness is the safety bar: anything else (task work, a directed prompt, a
            # multi-event backlog that might hide actionable work) carries NO hint and always wakes.
            # The notifier reads the hint and decides (failing open); the server never suppresses.
            # GH #91/#90: an owed OPEN task request is task-shaped work that must ALWAYS full-boot —
            # never attach a suppression hint when one is pending (the notifier's suppression decider
            # also short-circuits to wake on has_pending_task_request; this is the server-side belt).
            triage_hint = None
            if triage_eligible(
                should_wake=should_wake,
                pending_task_request=has_pending_task_request,
                self_wake_due=self_wake_due,
                pending=pending,
                auto_tasks=auto_tasks,
                wake_task_id=wake_task_id,
                prompt_messages=prompt_messages,
                latest=latest,
                actionable_answer_ts=actionable_answer_ts,
            ):
                full_answer = request_answer(cur, latest, latest_payload)
                triage_hint = _triage_hint_for(
                    latest, latest_payload, full_answer=full_answer
                )

            candidates.append(
                {
                    "agent_id": aid,
                    "alias": a["alias"],
                    "should_wake": should_wake,
                    "reason": reason,
                    "pending_events": pending,
                    "latest_event": latest,
                    "prompt_messages": prompt_messages,
                    "wake_task_id": wake_task_id,
                    "notifications": notifications,
                    "notifications_truncated": notifications_truncated,
                    "max_event_ts": max_ts,
                    "ack_through_ts": ack_through_ts,
                    # GH #58: the per-event handled-set the daemon posts to /events/ack-handled when this
                    # run COMPLETES (not at spawn — a spawn-then-crash marks nothing, so the events
                    # re-surface; no loss), plus the task this run's context is bound to.
                    "handled_event_ids": handled_event_ids,
                    "context_task_id": context_task_id,
                    "auto_start_task_ids": auto_tasks,
                    # #266: surface the scheduled-wake verdict + the configured cadence so the notifier
                    # can label the wake 'auto_wake' and build a heartbeat prompt, and the portal/debug
                    # can show why an idle agent is being woken on a clock.
                    "auto_wake_due": auto_wake_due,
                    "auto_wake_interval_secs": auto_interval,
                    # GH #122: due one-shot task resume wake. self_wake_injected means this scan bound
                    # the self-wake to the same task_id the persona/protocol load will use.
                    "self_wake_due": self_wake_due,
                    "self_wake_context": self_wake_context,
                    "self_wake_task_id": self_wake_task_id,
                    "self_wake_injected": bool(
                        self_wake_due and self_wake_task_id == wake_task_id
                    ),
                    # #288: the wake-suppression hint (None unless the sole pending signal is a single
                    # FYI/answer event). The notifier daemon makes the final call and fails open.
                    "triage_hint": triage_hint,
                    # #72: True when a pending answer/close unblocks this agent's own task work — such an
                    # answer is EXEMPT from #288/#307 suppression (triage_hint stays None) so a real worker
                    # spawns to act on it instead of a drain silently closing it.
                    "actionable_answer_pending": actionable_answer_ts is not None,
                    "wake_enabled": wake_enabled,
                    "in_cooldown": in_cooldown,
                    "lease_active": lease_active,
                    "lease_kind": lease_kind,
                    # #247 B2: the authoritative live-embodiment signal (a 'running' worker_run), exposed
                    # so the portal/debug can see an orphan suppressing a wake even after its lease lapsed.
                    # GH #91/#90: this is now the WORK-lane running signal (lane='work').
                    "embodiment_running": embodiment_running,
                    # GH #91/#90: the uncapped owed-task signal — the notifier folds it into has_task_request
                    # and its tier/suppression deciders short-circuit to a full WORK boot on it.
                    "has_pending_task_request": has_pending_task_request,
                    # GH #91/#90: lane-split debug fields (should_wake governs WORK only; these expose the
                    # coexisting conversation-lane state so the portal/debug can see both embodiments).
                    "conv_lease_active": conv_lease_active,
                    "conv_embodiment_running": conv_embodiment_running,
                    "work_idle_seconds": work_idle_seconds,
                    "idle_seconds": idle_seconds,
                    "tmux_target": a["tmux_target"],
                    "headless_cwd": a["headless_cwd"],
                    "headless_flags": a["headless_flags"],
                    # GAP A: the model the daemon must spawn this worker with (`--model`). Resolved
                    # server-side so a retired limited-availability model (e.g. Fable 5 after 2026-06-22)
                    # auto-falls-back to the default and never reaches the spawn argv as an invalid id.
                    "model": resolve_model(a["model"]),
                    "model_runtime": resolve_model_runtime(a["model"]),
                    # GH #51: the per-agent reasoning effort the daemon passes to the worker spawn.
                    # NULL stays NULL (no explicit flag); unknown stale values fall back server-side.
                    "reasoning_effort": resolve_reasoning_effort(a["reasoning_effort"]),
                }
            )
    return {
        "container_id": cid,
        "container_status": c["status"],
        "active": active,
        "wakes_enabled": wakes_enabled,
        # #307 graded-wake: the container autonomy gate for T2 cheap-act auto-completion
        # ('full' => act; otherwise log-only + full boot). Advisory; the daemon fails open.
        "autonomy_level": autonomy_level,
        # #294: the configured 'triage' model for #288 wake-suppression (null = #290 default).
        "triage_model": triage_model,
        # The SEALED key blob for the triage/ack provider (ciphertext; null if none stored).
        # The daemon unseals locally — Settings-stored provider keys reach the wake paths.
        "triage_key_enc": triage_key_enc,
        "ack_key_enc": ack_key_enc,
        # #307: the configured 'ack' model for T2 cheap-act (null = #290 default Haiku).
        "ack_model": ack_model,
        "candidates": candidates,
    }


from portal_backend.wake_acknowledgement_routes import (
    events_ack_handled,
    wake_ack,
)

from portal_backend.orphan_lease_routes import (
    ORPHAN_LEASE_SECS,
    reap_orphan_leases,
)

# #298: the autonomy SLIDER write body. `level` is the engine enum; `actor_agent_id` MUST be a
# kind='human' agent — moving the slider changes the one hard completion gate (at 'full' a /done
# auto-completes with no human verify), so it is a deliberate human authority action (stricter than
# /wakes, which only logs the actor). The route validates `level` against the enum (400 otherwise).
AUTONOMY_LEVELS = ("plan", "pr", "full")


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
        cur.execute(
            "UPDATE containers SET wakes_enabled=%s WHERE id=%s RETURNING wakes_enabled",
            (body.enabled, cid),
        )
        row = cur.fetchone()
        log_event(
            cur,
            cid,
            "system",
            body.actor_agent_id,
            "container",
            cid,
            "wakes_toggled",
            {"enabled": body.enabled},
        )
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
        _require_kind(
            cur, body.actor_agent_id, ("human",)
        )  # Orcha#30: a deliberate human action
        cur.execute(
            "UPDATE containers SET autonomy_level=%s WHERE id=%s RETURNING autonomy_level",
            (body.level, cid),
        )
        row = cur.fetchone()
        log_event(
            cur,
            cid,
            "human",
            body.actor_agent_id,
            "container",
            cid,
            "autonomy_changed",
            {"level": body.level},
        )
        conn.commit()
    return {"container_id": cid, "autonomy_level": row["autonomy_level"]}


# ---------- GH #91/#90: embodiment tokens (per-process WORK-lane capability) ----------
# A run_token is minted BEFORE a worker is spawned and bound to its run row at run-create. The four
# WORK-lane-only task endpoints (/next, accept->working, /tasks/{id}/done, release) require a valid
# non-revoked WORK token via the X-Orcha-Run-Token header, so a conversation-lane (or mislabeled)
# process structurally CANNOT own/claim/complete a task — it can only DISPATCH one. The server
# revokes a run's token on EVERY terminal transition it observes (finish / wake-ack orphan /
# reap-orphan-leases / dead-pid sweep) so a revoked capability can never outlive its process.


@app.post("/api/agents/{aid}/embodiment-tokens", status_code=201)
def mint_embodiment_token(aid: str, body: EmbodimentTokenMint):
    """GH #91/#90: mint a run_token for a spawn about to happen. run_id/pid stay NULL until the run
    is created and binds the token (start_worker_run). The token_id returned IS the run_token — there
    is no separate id column; the daemon carries it as the handle for the bind + revoke calls."""
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_agent(cur, aid)
        tok = secrets.token_urlsafe(32)
        cur.execute(
            """INSERT INTO embodiment_tokens (run_token, agent_id, lane, kind)
               VALUES (%s, %s, %s, %s)""",
            (tok, aid, body.lane, body.kind),
        )
        conn.commit()
    return {"run_token": tok, "token_id": tok}


@app.post("/api/embodiment-tokens/{token}/revoke", status_code=200)
def revoke_embodiment_token(token: str):
    """GH #91/#90: revoke a token (idempotent). A daemon revokes its own token when it retires the
    embodiment; the server also revokes on terminal transitions. Re-revoking a revoked/unknown token
    is a no-op 200 with revoked=false."""
    with db_cursor() as (conn, cur):
        cur.execute(
            """UPDATE embodiment_tokens SET revoked_at=now()
               WHERE run_token=%s AND revoked_at IS NULL""",
            (token,),
        )
        revoked = cur.rowcount > 0
        conn.commit()
    return {"revoked": bool(revoked)}


from portal_backend.worker_auth import require_work_lane as _require_work_lane


def _attribute_token_run_to_task(cur, aid, token, task_id) -> bool:
    """GH #83 follow-up + GH #144: accepting a task request happens inside an already-running worker,
    so the lazy run-start/run-finish inference never sees a new spawn to attach. The work token is
    already bound to the current worker_runs row. Two effects, deliberately split (GH #144):

      * PIN — if the row is still task-less, set worker_runs.task_id (the single "current task" the
        GH #340 activity label and the GH #126 live-run guard read). An EXISTING pin is PRESERVED: a
        session already working task A keeps A as its current task and is never silently moved to B
        (ec197e8 / test_accept_task_does_not_overwrite_existing_run_task).
      * FEED MEMBERSHIP — record that this run TOUCHED `task_id` in worker_run_tasks regardless of
        the pin, so a continuous session spanning task A then task B narrates on BOTH task feeds.
        This closes the one-task-only gap (GH #144) that the single pin column cannot: the AFTER
        trigger already maintains membership for the pin path, but the accept HOP keeps the pin on A
        (task_id unchanged) so the trigger never fires for B — hence this explicit insert.

    Returns True if the PIN was (re)set to task_id."""
    if not token or not task_id:
        return False
    cur.execute(
        """UPDATE worker_runs wr
              SET task_id=%s
             FROM embodiment_tokens et
            WHERE et.run_token=%s
              AND et.agent_id=%s
              AND et.lane='work'
              AND et.revoked_at IS NULL
              AND et.run_id IS NOT NULL
              AND wr.run_id=et.run_id
              AND wr.agent_id=et.agent_id
              AND wr.status='running'
              AND wr.task_id IS NULL
              AND EXISTS (SELECT 1 FROM tasks t
                           WHERE t.id=%s AND t.status='in_progress')
        RETURNING wr.run_id""",
        (task_id, token, aid, task_id),
    )
    pinned = cur.fetchone() is not None
    # GH #144 FEED MEMBERSHIP: the run touched this task — record it even when the pin stayed on an
    # earlier task, so BOTH task feeds narrate. Same live-work-token + in_progress-task guard as the
    # pin update (never attribute to a non-running run or a not-in_progress task); ON CONFLICT keeps
    # it idempotent across accept retries and the pin-path trigger.
    cur.execute(
        """INSERT INTO worker_run_tasks (run_id, task_id)
           SELECT wr.run_id, %s
             FROM worker_runs wr
             JOIN embodiment_tokens et ON wr.run_id = et.run_id
            WHERE et.run_token=%s
              AND et.agent_id=%s
              AND et.lane='work'
              AND et.revoked_at IS NULL
              AND et.run_id IS NOT NULL
              AND wr.agent_id=et.agent_id
              AND wr.status='running'
              AND EXISTS (SELECT 1 FROM tasks t
                           WHERE t.id=%s AND t.status='in_progress')
           ON CONFLICT DO NOTHING""",
        (task_id, token, aid, task_id),
    )
    return pinned


# ---------- A2: worker runs (persist + expose headless wake output) ----------


from portal_backend.worker_run_support import (
    infer_agent_active_task as _infer_agent_active_task,
    is_non_task_work as _is_non_task_work,
    revoke_tokens_for_runs as _revoke_tokens_for_runs,
    run_row as _run_row,
)
from portal_backend.worker_run_start_routes import (
    list_container_running_runs,
    list_resident_runs,
    start_worker_run,
)
from portal_backend.worker_run_finish_routes import (
    append_worker_run_lines,
    finish_worker_run,
    stop_worker_run,
)
from portal_backend.worker_run_read_routes import (
    fetch_run_lines as _fetch_run_lines,
    list_agent_runs,
    list_task_runs,
    stream_worker_run,
    worker_run_status as _worker_run_status,
)


# ---------- tasks ----------


@app.post("/api/containers/{cid}/tasks", status_code=201)
def create_task(cid: str, body: TaskCreateBody):
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_container_active(
            cur, cid, body.created_by_agent_id
        )  # GH #24 (was _require_container)
        _reject_if_retired(cur, body.created_by_agent_id)  # ISS-51 [P1]

        for dep in body.depends_on:
            if not _valid_uuid(dep):
                raise HTTPException(400, f"depends_on contains invalid UUID: {dep}")

        assignee_id = None
        if body.assignee_alias:
            assignee_id = _resolve_alias(cur, cid, body.assignee_alias)

        initial_status = (
            "pending"
            if body.depends_on
            else ("in_progress" if assignee_id else "ready")
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
            (
                cid,
                body.title,
                body.description,
                body.definition_of_done,
                initial_status,
                body.priority,
                body.created_by_agent_id,
                protocol_json,
            ),
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
            _publish_event(
                cur,
                cid,
                assignee_id,
                "task_assigned",
                {"task_id": tid, "title": body.title, "via": "direct assignment"},
            )

        actor_type = "ai" if body.created_by_agent_id else "human"
        log_event(
            cur,
            cid,
            actor_type,
            body.created_by_agent_id,
            "task",
            tid,
            "created",
            {
                "title": body.title,
                "status": initial_status,
                "assignee_alias": body.assignee_alias,
                "depends_on": body.depends_on,
            },
        )
        conn.commit()

    return {
        "task_id": tid,
        "status": initial_status,
        "assignee_alias": body.assignee_alias,
        "depends_on": body.depends_on,
    }


@app.post("/api/tasks/{tid}/messages", status_code=201)
def post_message(tid: str, body: TaskMessage):
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    if body.author_agent_id is not None and not _valid_uuid(body.author_agent_id):
        raise HTTPException(400, "author_agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        t = _require_task(cur, tid)
        _reject_if_retired(cur, body.author_agent_id)  # ISS-51 [P1]
        _require_container_active(
            cur, str(t["container_id"]), body.author_agent_id
        )  # GH #24 (human None-author posts still allowed)
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
                raise HTTPException(
                    403,
                    "author agent isn't a member of this task's container — cannot post",
                )
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
        log_event(
            cur,
            t["container_id"],
            actor_type,
            body.author_agent_id,
            "task",
            tid,
            "message",
            {"message_id": mid, "preview": body.body[:120]},
        )
        # R2.2: a task-thread message is a wake trigger for the task's OTHER assignees.
        # Previously this emitted no agent_events, so a teammate's note silently stranded
        # until they happened to look. Publish a targeted `task_message` event to every
        # assignee except the author so the daemon/listen loop wakes them out-of-band.
        cur.execute("SELECT agent_id FROM agent_tasks WHERE task_id=%s", (tid,))
        for row in cur.fetchall():
            target = str(row["agent_id"])
            if target == body.author_agent_id:
                continue  # don't wake yourself for your own message
            _publish_event(
                cur,
                str(t["container_id"]),
                target,
                "task_message",
                {
                    "task_id": tid,
                    "message_id": mid,
                    "from_agent_id": body.author_agent_id,
                    "preview": body.body[:120],
                },
            )
        conn.commit()
    return {"message_id": mid, "task_id": tid}


@app.get("/api/tasks/{tid}/messages")
def get_task_messages(
    tid: str,
    limit: int = 0,
    before: Optional[str] = None,
    before_id: Optional[str] = None,
):
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
    cols = (
        "m.id AS message_id, m.author_id, ma.alias AS author_alias, "
        "(m.author_id IS NOT NULL AND ma.kind = 'human') AS is_human, m.body, "
        # #301: COALESCE so pre-migration rows surface [] (their column existed only
        # after mig 025; the DEFAULT covers new rows but be explicit for the read path).
        "COALESCE(m.attachments, '[]'::jsonb) AS attachments, m.created_at"
    )
    with db_cursor() as (_, cur):
        _require_task(cur, tid)
        # GH #33: surface the FULL task body in a `task` header so a worker woken by a task-thread
        # message — told to "read the thread" — reads description + definition_of_done before acting,
        # not just the message preview and the title.
        cur.execute(
            "SELECT title, description, definition_of_done FROM tasks WHERE id=%s",
            (tid,),
        )
        _t = cur.fetchone()
        task_hdr = {
            "title": _t["title"],
            "description": _t["description"],
            "definition_of_done": _t["definition_of_done"],
        }
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
            rows = cur.fetchall()  # DESC (newest→oldest)
            has_more = len(rows) > lim
            rows = rows[:lim]
            oldest = (
                rows[-1] if rows else None
            )  # last in DESC = oldest in this page → next cursor
            next_before = (
                oldest["created_at"].isoformat() if (oldest and has_more) else None
            )
            next_before_id = (
                str(oldest["message_id"]) if (oldest and has_more) else None
            )
            rows.reverse()  # ASC within the page (oldest→newest)
            return {
                "task_id": tid,
                "task": task_hdr,
                "messages": rows,
                "has_more": has_more,
                "next_before": next_before,
                "next_before_id": next_before_id,
            }
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
            400,
            "unsupported file type — allowed: " + ", ".join(sorted(_ATTACHMENT_TYPES)),
        )
    stored = uuid.uuid4().hex + "_" + display
    tdir = _task_attachments_dir(tid)
    try:
        tdir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise HTTPException(500, f"attachment store unavailable: {e}")
    dest = _contained_path(tdir, stored)
    if dest is None:  # unreachable: `stored` is uuid-hex + sanitized basename
        raise HTTPException(400, "invalid attachment name")
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
                        413,
                        f"file too large (max {MAX_ATTACHMENT_BYTES // (1024 * 1024)} MiB)",
                    )
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
        _attachment_ref, tid, stored, display, size, dest, api_key=llm_key
    )


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
        p,
        media_type=media,
        headers={
            "Content-Disposition": disposition,
            "X-Content-Type-Options": "nosniff",
        },
    )


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
            400,
            "unsupported file type — allowed: " + ", ".join(sorted(_ATTACHMENT_TYPES)),
        )
    stored = uuid.uuid4().hex + "_" + display
    cdir = _conversation_attachments_dir(conv_id)
    try:
        cdir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise HTTPException(500, f"attachment store unavailable: {e}")
    dest = _contained_path(cdir, stored)
    if dest is None:  # unreachable: `stored` is uuid-hex + sanitized basename
        raise HTTPException(400, "invalid attachment name")
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
                        413,
                        f"file too large (max {MAX_ATTACHMENT_BYTES // (1024 * 1024)} MiB)",
                    )
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
        _conv_attachment_ref, conv_id, stored, display, size, dest, api_key=llm_key
    )


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
        p,
        media_type=media,
        headers={
            "Content-Disposition": disposition,
            "X-Content-Type-Options": "nosniff",
        },
    )


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
           WHERE spawned_task_id=%s AND status='accepted' FOR UPDATE""",
        (tid,),
    )
    stranded = cur.fetchall()
    fired = []
    for req in stranded:
        rid = str(req["id"])
        note = (
            f"[auto-answered by the #56 backstop] the accepter's task {tid} reached a terminal "
            f"state without an explicit report-back. See that task for the result/output."
        )
        cur.execute(
            "UPDATE requests SET status='answered', response=%s, responded_at=now() WHERE id=%s",
            (note, rid),
        )
        _publish_event(
            cur,
            str(container_id),
            str(req["requester_id"]),
            "request_answered",
            {
                "request_id": rid,
                "preview": note[:120],
                "originating_task_id": (
                    str(req["originating_task_id"])
                    if req["originating_task_id"]
                    else None
                ),
                "backstop": True,
            },
        )
        log_event(
            cur,
            container_id,
            "system",
            None,
            "request",
            rid,
            "auto_answered",
            {
                "reason": "backstop: accepter task reached terminal state while request "
                "still 'accepted' (no report-back)",
                "task_id": str(tid),
            },
        )
        fired.append(rid)
    return fired


def _recalibrate_agent_digest_on_close(
    cur, container_id, agent_id, task_id, task_title, *, verification_pending
):
    """GH #35: when a task closes, prune the owning agent's LATEST memory digest so the next wake
    doesn't rehydrate the finished task's stale open threads / task-scoped decisions. Durable
    learnings are preserved; current focus is reset only when it pointed at the closed task; a
    still-pending human-verification thread is kept when the task only reached needs_verification.

    Append-only: writes a NEW recalibrated snapshot (the prior full digest stays in
    agent_memory_digests history — this demotes, it never hard-deletes the record). Best-effort and
    silent no-op when the curator copy is absent, the agent has no digest yet, or nothing in the
    digest referenced the task (so a completion never spawns a churn row for nothing)."""
    if _digest_curate is None or not _valid_uuid(agent_id):
        return
    cur.execute(
        """SELECT current_focus, decisions, learnings, open_threads, audience
             FROM agent_memory_digests
            WHERE agent_id=%s ORDER BY snapshot_ts DESC LIMIT 1""",
        (agent_id,),
    )
    row = cur.fetchone()
    if not row:
        return
    inner = {
        "current_focus": row["current_focus"],
        "decisions": row["decisions"] or [],
        "learnings": row["learnings"] or [],
        "open_threads": row["open_threads"] or [],
    }
    recal = _digest_curate.recalibrate_digest(
        inner, str(task_id), task_title or "", verification_pending=verification_pending
    )
    # No-op guard: only persist a new snapshot if the recalibration actually changed something.
    if (
        recal.get("open_threads") == inner["open_threads"]
        and recal.get("decisions") == inner["decisions"]
        and recal.get("current_focus") == inner["current_focus"]
    ):
        return
    ts = time.time()
    cur.execute(
        """INSERT INTO agent_memory_digests
             (container_id, agent_id, snapshot_ts, current_focus,
              decisions, learnings, open_threads, audience)
           VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s)
           RETURNING id""",
        (
            str(container_id),
            agent_id,
            ts,
            recal.get("current_focus"),
            json.dumps(recal.get("decisions") or []),
            json.dumps(recal.get("learnings") or []),
            json.dumps(recal.get("open_threads") or []),
            row["audience"],
        ),
    )
    did = cur.fetchone()["id"]
    log_event(
        cur,
        container_id,
        "system",
        None,
        "agent",
        agent_id,
        "digest_snapshotted",
        {
            "digest_id": did,
            "recalibrated": True,
            "task_id": str(task_id),
            "reason": "task_closed",
        },
    )
    # ISS-58: container-scoped only (non-waking) — a snapshot is a dashboard notification, not work.
    _publish_event(
        cur,
        str(container_id),
        None,
        "digest_snapshotted",
        {
            "digest_id": did,
            "snapshot_ts": ts,
            "agent_id": agent_id,
            "recalibrated": True,
        },
    )


def _recalibrate_task_owners(
    cur, container_id, tid, task_title, *, verification_pending
):
    """GH #35: recalibrate EVERY owning assignee's digest for a task that just closed. Owners come
    from agent_tasks (done/working rows both count — the assignment row survives completion)."""
    cur.execute("SELECT DISTINCT agent_id FROM agent_tasks WHERE task_id=%s", (tid,))
    for r in cur.fetchall():
        _recalibrate_agent_digest_on_close(
            cur,
            container_id,
            str(r["agent_id"]),
            tid,
            task_title,
            verification_pending=verification_pending,
        )


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
        "UPDATE tasks SET status='completed', completed_at=now() WHERE id=%s", (tid,)
    )
    cur.execute("DELETE FROM agent_self_wake WHERE task_id=%s", (tid,))
    # unblock downstream tasks whose deps are now all completed
    cur.execute(
        """SELECT DISTINCT td.task_id
           FROM task_dependencies td
           WHERE td.depends_on_id = %s""",
        (tid,),
    )
    downstream = [str(r["task_id"]) for r in cur.fetchall()]
    unblocked = []
    for dst in downstream:
        cur.execute(
            """SELECT 1
               FROM task_dependencies td
               JOIN tasks dep ON dep.id = td.depends_on_id
               WHERE td.task_id=%s AND dep.status <> 'completed'
               LIMIT 1""",
            (dst,),
        )
        if not cur.fetchone():
            cur.execute(
                "UPDATE tasks SET status='ready' WHERE id=%s AND status='pending'",
                (dst,),
            )
            if cur.rowcount:
                unblocked.append(dst)
                log_event(
                    cur,
                    container_id,
                    "system",
                    None,
                    "task",
                    dst,
                    "status_changed",
                    {"to": "ready", "reason": "deps satisfied"},
                )
    for dst in unblocked:
        # Container-wide task_ready (dashboards / unassigned-pool pickup).
        _publish_event(cur, str(container_id), None, "task_ready", {"task_id": dst})
        # Epic A: a newly-ready ASSIGNED task ALSO gets a task_ready targeted at its assignee
        # so the daemon can wake its owner to auto-start it.
        cur.execute(
            "SELECT DISTINCT agent_id FROM agent_tasks WHERE task_id=%s", (dst,)
        )
        for ar in cur.fetchall():
            _publish_event(
                cur,
                str(container_id),
                str(ar["agent_id"]),
                "task_ready",
                {"task_id": dst, "assigned": True},
            )

    # Did this complete the root? If so, complete the container.
    cur.execute("SELECT is_root, container_id, title FROM tasks WHERE id=%s", (tid,))
    tr = cur.fetchone()
    if tr["is_root"]:
        cur.execute(
            "UPDATE containers SET status='completed', completed_at=now() "
            "WHERE id=%s AND status<>'completed'",
            (tr["container_id"],),
        )
        if cur.rowcount:
            log_event(
                cur,
                tr["container_id"],
                "system",
                None,
                "container",
                tr["container_id"],
                "status_changed",
                {"to": "completed", "reason": "root task verified"},
            )
    # GH #35: this is the SHARED terminal-completion path (full-autonomy /done + human /verify
    # approve). Recalibrate each owner's digest so the next wake doesn't rehydrate this finished
    # task's stale open threads / decisions. Completion is terminal — verification is NOT pending.
    _recalibrate_task_owners(
        cur, container_id, tid, tr["title"], verification_pending=False
    )
    return unblocked


@app.post("/api/tasks/{tid}/done", status_code=200)
def mark_done(
    tid: str,
    body: TaskDone,
    x_orcha_run_token: Optional[str] = Header(default=None, alias="X-Orcha-Run-Token"),
):
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    if not _valid_uuid(body.agent_id):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        t = _require_task(cur, tid)
        # GH #91/#90: completing a task is WORK-lane only — gate on the ACTING agent (body.agent_id).
        # A conversation-lane embodiment cannot mark a task done (403).
        _require_work_lane(cur, body.agent_id, x_orcha_run_token)
        _reject_if_retired(cur, body.agent_id)  # ISS-51 [P1]
        _require_container_active(cur, str(t["container_id"]), body.agent_id)  # GH #24
        # Issue #11: root task is a sentinel for container completion — only
        # the human verifies it via /orcha-verify <root_tid>. An agent should
        # never be able to mark it done, even if assignment somehow happened.
        if t["is_root"]:
            raise HTTPException(
                409,
                "this is the container's root task — agents cannot mark it done. "
                "Only /orcha-verify by the human flips it to completed (and the container along with it).",
            )
        # Item 4 (review): blocked tasks shouldn't flip done — blocked means
        # deps not satisfied, so completion would skip the dependency gate.
        if t["status"] != "in_progress":
            raise HTTPException(
                409, f"task is '{t['status']}', not 'in_progress' — can't mark done"
            )
        # Item 3 (review): only an assignee can mark a task done. Without this
        # check anyone with the task UUID could flip the state.
        cur.execute(
            "SELECT 1 FROM agent_tasks WHERE agent_id=%s AND task_id=%s LIMIT 1",
            (body.agent_id, tid),
        )
        if not cur.fetchone():
            raise HTTPException(
                403, "this agent isn't assigned to that task — cannot mark it done"
            )
        # #298: the ONE engine-enforced autonomy gate. The container's autonomy_level decides the
        # terminal state of a /done:
        #   plan | pr -> needs_verification (a human verifies — today's behavior, the safe default)
        #   full      -> the task AUTO-COMPLETES (no human in the loop) via the SAME
        #               _complete_and_unblock path /verify's approve branch uses, so a
        #               full-autonomy completion is indistinguishable from a verified one
        #               (downstream unblock + wakes + root→container). The free-text per-task
        #               protocol.autonomy is DELIBERATELY ignored here — an unvalidated string
        #               must never widen the hard gate; only this enum column can auto-complete.
        cur.execute(
            "SELECT autonomy_level FROM containers WHERE id=%s", (t["container_id"],)
        )
        level = cur.fetchone()["autonomy_level"]
        result_json = json.dumps({"result": body.result, "by_agent_id": body.agent_id})
        cur.execute(
            "UPDATE agent_tasks SET assignment_status='done' WHERE agent_id=%s AND task_id=%s",
            (body.agent_id, tid),
        )
        # GH #58: a CLEAN completion resolves this task's surfaced-not-acked DIRECTIVES — the in_progress
        # task_assigned start directive and any task_verified{approved:false} rework directive — so they
        # stop re-waking the now-finished assignee. Same txn as the /done (no loss if it rolls back).
        _ack_events_handled(cur, body.agent_id, "task_assigned", "task_id", tid)
        _ack_events_handled(cur, body.agent_id, "task_verified", "task_id", tid)
        if level == "full":
            cur.execute(
                "UPDATE tasks SET result=%s::jsonb WHERE id=%s", (result_json, tid)
            )
            unblocked = _complete_and_unblock(cur, t["container_id"], tid)
            bump_agent(cur, body.agent_id)
            recompute_agent_status(cur, body.agent_id)
            log_event(
                cur,
                t["container_id"],
                "ai",
                body.agent_id,
                "task",
                tid,
                "status_changed",
                {
                    "to": "completed",
                    "autonomy_level": "full",
                    "auto_completed": True,
                    "unblocked": unblocked,
                },
            )
            conn.commit()
            return {
                "task_id": tid,
                "status": "completed",
                "auto_completed": True,
                "unblocked": unblocked,
            }
        cur.execute(
            "UPDATE tasks SET status='needs_verification', result=%s::jsonb WHERE id=%s",
            (result_json, tid),
        )
        cur.execute("DELETE FROM agent_self_wake WHERE task_id=%s", (tid,))
        # GH #56 (Point 5): plan/pr autonomy parks the task at needs_verification (the full branch
        # above auto-completes via _complete_and_unblock, which runs the same backstop). If this is
        # an accepter's spawned task and its originating request is still 'accepted', auto-answer it
        # so the requester's loop closes even when the accepter forgot the report-back.
        _backstop_stranded_request(cur, t["container_id"], tid)
        bump_agent(cur, body.agent_id)
        recompute_agent_status(cur, body.agent_id)
        # GH #35: the active work is done (parked at needs_verification), so recalibrate the
        # owner's digest now — prune this task's stale open threads / decisions, but KEEP a thread
        # about the still-pending human verification (verification_pending=True; never self-certify).
        _recalibrate_agent_digest_on_close(
            cur,
            t["container_id"],
            body.agent_id,
            tid,
            t["title"],
            verification_pending=True,
        )
        log_event(
            cur,
            t["container_id"],
            "ai",
            body.agent_id,
            "task",
            tid,
            "status_changed",
            {"to": "needs_verification", "autonomy_level": level},
        )
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
        actor = _require_kind(
            cur, body.actor_agent_id, ("human", "ai")
        )  # Orcha#30 + #327
        _require_container_active(
            cur, cid, body.actor_agent_id
        )  # GH #24 (human actor passes through)
        _reject_if_retired(cur, body.actor_agent_id)  # ISS-51
        if t["is_root"]:
            raise HTTPException(
                409, "the root task cannot be assigned — only the human verifies it"
            )
        # Terminal states — including 'cancelled' (cancel_task sets it; verify_task refuses it).
        # Assignment must NOT resurrect a finished/cancelled task back to ready/pending. [review P1]
        if t["status"] in ("completed", "needs_verification", "cancelled"):
            raise HTTPException(
                409,
                f"task is '{t['status']}' — cannot assign a finished/cancelled task",
            )
        # Assignee must be a live AI agent in this container (humans don't poll /next — Orcha#30).
        cur.execute(
            "SELECT kind, container_id, alias, terminated_at FROM agents WHERE id=%s",
            (body.agent_id,),
        )
        a = cur.fetchone()
        if not a:
            raise HTTPException(404, f"agent {body.agent_id} not found")
        if str(a["container_id"]) != cid:
            raise HTTPException(409, "agent is not in the same container as the task")
        if a["terminated_at"] is not None:
            raise HTTPException(409, "agent is retired and cannot be assigned work")
        if a["kind"] != "ai":
            raise HTTPException(
                409, f"can only assign tasks to AI agents; agent is kind='{a['kind']}'"
            )

        # Is the target ALREADY an active assignee? (idempotency / don't disturb in-progress work)
        cur.execute(
            "SELECT assignment_status FROM agent_tasks WHERE task_id=%s AND agent_id=%s",
            (tid, body.agent_id),
        )
        ex = cur.fetchone()
        target_active = bool(
            ex and ex["assignment_status"] in ("assigned", "accepted", "working")
        )

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
            return {
                "task_id": tid,
                "agent_id": body.agent_id,
                "alias": a["alias"],
                "status": t["status"],
                "assignment_status": ex["assignment_status"],
                "woke": False,
                "released_prior": None,
            }
        released_prior = None
        if prior:
            if not body.reassign:
                raise HTTPException(
                    409,
                    "task already has a different active assignee — pass reassign=true to reassign",
                )
            cur.execute(
                """DELETE FROM agent_tasks
                   WHERE task_id=%s AND agent_id <> %s
                     AND assignment_status IN ('assigned','accepted','working')""",
                (tid, body.agent_id),
            )
            cur.execute(
                """DELETE FROM agent_self_wake
                   WHERE task_id=%s AND agent_id <> %s""",
                (tid, body.agent_id),
            )
            for pid in prior:
                recompute_agent_status(cur, pid)
                _publish_event(
                    cur,
                    cid,
                    pid,
                    "task_unassigned",
                    {
                        "task_id": tid,
                        "by_id": body.actor_agent_id,
                        "by_kind": actor["kind"],
                    },
                )
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
        cur.execute(
            "UPDATE tasks SET status=%s, started_at=NULL WHERE id=%s", (new_status, tid)
        )
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
            _publish_event(
                cur,
                cid,
                body.agent_id,
                "task_assigned",
                {"task_id": tid, "title": t["title"], "via": "B5 direct assignment"},
            )
            woke = True
        log_event(
            cur,
            cid,
            actor["kind"],
            body.actor_agent_id,
            "task",
            tid,
            "assigned",
            {
                "agent_id": body.agent_id,
                "alias": a["alias"],
                "status": new_status,
                "reassigned_from": released_prior,
            },
        )
        conn.commit()
    return {
        "task_id": tid,
        "agent_id": body.agent_id,
        "alias": a["alias"],
        "status": new_status,
        "assignment_status": "assigned",
        "woke": woke,
        "released_prior": released_prior,
    }


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
        _require_kind(
            cur, body.actor_agent_id, ("human",)
        )  # Orcha#30 / #327: human-only flip
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
                raise HTTPException(
                    409, f"task is '{cur_status}', not 'not_ready' — nothing to release"
                )
            new_status = "pending" if _deps_unmet(cur, tid) else "ready"
        else:
            # HOLD -> not_ready. Idempotent if already held.
            if cur_status == "not_ready":
                conn.commit()
                return {"task_id": tid, "status": "not_ready", "already": True}
            if cur_status not in ("ready", "pending"):
                raise HTTPException(
                    409,
                    f"task is '{cur_status}' — only a ready/pending task can be held as not_ready",
                )
            new_status = "not_ready"
        cur.execute(
            "UPDATE tasks SET status=%s, started_at=NULL WHERE id=%s", (new_status, tid)
        )
        log_event(
            cur,
            cid,
            "human",
            body.actor_agent_id,
            "task",
            tid,
            "readiness_set",
            {"from": cur_status, "to": new_status},
        )
        # Releasing an ASSIGNED held task makes it an auto-start target -> wake the assignee.
        if new_status == "ready":
            cur.execute(
                """SELECT agent_id FROM agent_tasks
                   WHERE task_id=%s AND assignment_status IN ('assigned','accepted','working')""",
                (tid,),
            )
            for r in cur.fetchall():
                _publish_event(
                    cur,
                    cid,
                    str(r["agent_id"]),
                    "task_ready",
                    {"task_id": tid, "title": t["title"], "via": "readiness release"},
                )
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
        _require_kind(
            cur, body.actor_agent_id, ("human",)
        )  # Orcha#30: dispatch reset is a human action
        t = _require_task(cur, tid)
        cid = str(t["container_id"])
        if t["is_root"]:
            raise HTTPException(
                409, "the root task cannot be unassigned — only the human verifies it"
            )
        if t["status"] in ("completed", "needs_verification", "cancelled"):
            raise HTTPException(
                409,
                f"task is '{t['status']}' — cannot unassign a finished/cancelled task",
            )
        cur.execute(
            """SELECT agent_id FROM agent_tasks
               WHERE task_id=%s AND assignment_status IN ('assigned','accepted','working')""",
            (tid,),
        )
        active = [str(r["agent_id"]) for r in cur.fetchall()]
        if not active:
            conn.commit()
            return {
                "task_id": tid,
                "status": t["status"],
                "released": [],
                "already": True,
            }
        cur.execute(
            """DELETE FROM agent_tasks
               WHERE task_id=%s AND assignment_status IN ('assigned','accepted','working')""",
            (tid,),
        )
        cur.execute("DELETE FROM agent_self_wake WHERE task_id=%s", (tid,))
        # An in_progress task with no assignee left returns to the queue; a ready/pending/not_ready
        # task keeps its status (it just loses its owner). started_at clears so a reclaim is clean.
        new_status = t["status"]
        if t["status"] == "in_progress":
            new_status = "pending" if _deps_unmet(cur, tid) else "ready"
            cur.execute(
                "UPDATE tasks SET status=%s, started_at=NULL WHERE id=%s",
                (new_status, tid),
            )
        for pid in active:
            recompute_agent_status(cur, pid)
            # GH #58: unassigning retracts this task from pid — resolve any outstanding NEW_WORK /
            # DIRECTIVE notification for it (assign/ready/in_progress-directive/rework) so an
            # assign→unassign-before-finish never pins pid's wake cursor on a task it no longer owns.
            _ack_events_handled(cur, pid, "task_assigned", "task_id", tid)
            _ack_events_handled(cur, pid, "task_ready", "task_id", tid)
            _ack_events_handled(cur, pid, "task_verified", "task_id", tid)
            _publish_event(
                cur,
                cid,
                pid,
                "task_unassigned",
                {"task_id": tid, "by_human_id": body.actor_agent_id},
            )
        log_event(
            cur,
            cid,
            "human",
            body.actor_agent_id,
            "task",
            tid,
            "unassigned",
            {"released": active, "status": new_status},
        )
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
        actor = _require_kind(
            cur, body.actor_agent_id, ("human", "ai")
        )  # Orcha#30 + #327
        t = _require_task(cur, tid)
        _require_container_active(
            cur, str(t["container_id"]), body.actor_agent_id
        )  # GH #24
        _reject_if_retired(cur, body.actor_agent_id)  # ISS-51

        # Only the keys the caller actually sent (exclude_unset) — minus the actor — are applied.
        changed = body.model_dump(exclude_unset=True)
        changed.pop("actor_agent_id", None)
        if not changed:
            raise HTTPException(400, "no protocol fields supplied")
        # #327: autonomy edits stay human-only — autonomy is the human's risk dial, so an AI
        # editing it would be self-granting privilege. AI may freely edit the coordination keys.
        if actor["kind"] != "human" and "autonomy" in changed:
            raise HTTPException(
                403, "autonomy is the human's risk dial — only a human may edit it"
            )

        cur.execute("SELECT protocol FROM tasks WHERE id=%s", (tid,))
        existing = cur.fetchone()["protocol"] or {}
        merged = {
            **existing,
            **changed,
        }  # partial merge; sent keys win, others preserved

        cur.execute(
            "UPDATE tasks SET protocol=%s::jsonb WHERE id=%s", (json.dumps(merged), tid)
        )
        log_event(
            cur,
            t["container_id"],
            actor["kind"],
            body.actor_agent_id,
            "task",
            tid,
            "protocol_updated",
            {"changed_keys": sorted(changed.keys())},
        )
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
            raise HTTPException(
                409, f"task is already '{t['status']}'; nothing to verify"
            )
        if not t["is_root"] and t["status"] != "needs_verification":
            raise HTTPException(
                409, f"task is '{t['status']}', not 'needs_verification'"
            )

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
            log_event(
                cur,
                t["container_id"],
                "human",
                None,
                "task",
                tid,
                "verified",
                {
                    "approved": True,
                    "unblocked": unblocked,
                    "feedback": body.feedback,
                    "verifier_human_id": body.actor_agent_id,
                },
            )
            # Notify the assignees their work was approved + any newly-ready downstream
            cur.execute(
                "SELECT DISTINCT agent_id FROM agent_tasks WHERE task_id=%s",
                (tid,),
            )
            for r in cur.fetchall():
                _publish_event(
                    cur,
                    str(t["container_id"]),
                    str(r["agent_id"]),
                    "task_verified",
                    {"task_id": tid, "approved": True, "feedback": body.feedback},
                )
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
            log_event(
                cur,
                t["container_id"],
                "human",
                None,
                "task",
                tid,
                "verified",
                {
                    "approved": False,
                    "feedback": body.feedback,
                    "reassigned_to_agent_ids": restored,
                    "verifier_human_id": body.actor_agent_id,
                },
            )
            for aid in restored:
                _publish_event(
                    cur,
                    str(t["container_id"]),
                    aid,
                    "task_verified",
                    {"task_id": tid, "approved": False, "feedback": body.feedback},
                )
            conn.commit()
            return {
                "task_id": tid,
                "status": "in_progress",
                "feedback": body.feedback,
                "restored_assignee_agent_ids": restored,
            }


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
        _require_container_active(
            cur, str(t["container_id"]), body.actor_agent_id
        )  # GH #24 (human may still cancel)
        _reject_if_retired(
            cur, body.actor_agent_id
        )  # ISS-51 (#327: AI may now cancel — hold it to the same bar)
        # Review P2: the root sentinel task must never be cancelled. Cancelling it leaves the
        # container stuck 'active' AND wedges the "root verify completes the container" path
        # (verify rejects a cancelled task). Direct the human to cancel the container instead.
        if t["is_root"]:
            raise HTTPException(
                409,
                "the root task can't be cancelled; cancel the container via "
                'POST /api/containers/{cid}/status {"status":"cancelled"}',
            )
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
            raise HTTPException(
                422,
                {
                    "error": "reason_required",
                    "detail": "a reason is required when cancelling another agent's task",
                },
            )
        cur.execute(
            "UPDATE tasks SET status='cancelled', completed_at=now() WHERE id=%s",
            (tid,),
        )
        cur.execute("DELETE FROM agent_self_wake WHERE task_id=%s", (tid,))
        # Review P2: clear the now-stale assignments so assignees don't stay 'working'.
        # recompute_agent_status counts assigned|accepted|working rows regardless of the
        # task's status, so a cancelled task would otherwise pin its assignee 'working'.
        # 'done' is the codebase's terminal assignment state (same value the verify/done path uses).
        cur.execute(
            "UPDATE agent_tasks SET assignment_status='done' "
            "WHERE task_id=%s AND assignment_status IN ('assigned','accepted','working')",
            (tid,),
        )
        log_event(
            cur,
            t["container_id"],
            ("human" if is_human else "ai"),
            body.actor_agent_id,
            "task",
            tid,
            "cancelled",
            {"by_human": is_human, "forced": forced},
        )
        for aid in assignees:
            bump_agent(cur, aid)
            recompute_agent_status(cur, aid)
            # GH #58: cancel is a TERMINAL seam — resolve this task's outstanding NEW_WORK / DIRECTIVE
            # notifications for every assignee so a cancelled task never pins their wake cursor.
            _ack_events_handled(cur, aid, "task_assigned", "task_id", tid)
            _ack_events_handled(cur, aid, "task_ready", "task_id", tid)
            _ack_events_handled(cur, aid, "task_verified", "task_id", tid)
        # Route the reason to each OWNING assignee that isn't the actor.
        if forced:
            for owner in others:
                _route_close_reason(
                    cur,
                    t["container_id"],
                    "task_close",
                    tid,
                    reason,
                    body.actor_agent_id,
                    owner,
                )
                # ISS-42 (B12): the routed decision wakes the owner but carries no surfaced content,
                # so a cancelled owner would wake to nothing actionable (the dead-end). Poke them with
                # the reason + closure so they re-engage knowing it's closed and what they can do next.
                _poke_path_forward(
                    cur,
                    t["container_id"],
                    owner,
                    body.actor_agent_id,
                    f'Your task "{t["title"]}" (id {tid}) was cancelled by '
                    f"{'a human' if is_human else 'the orchestrator'}: {reason}. It's "
                    f"closed — no further work is needed on it. If a follow-up is warranted, propose a "
                    f"new task (/orcha-task-new) or raise it with your coordinator.",
                )
            # ISS-48 (review P3): mirror the close into the task thread ONCE — _route_close_reason
            # runs per-owner (one decision row + decision_made each), but the thread message is
            # task-level, so a multi-assignee close must not stack identical [DECISION] rows.
            _post_decision_to_thread(
                cur, "task_close", tid, "reject", reason, body.actor_agent_id
            )
        # GH #35: a cancelled task's work is closed for good — recalibrate each owner's digest so
        # its stale open threads / decisions don't rehydrate next wake. Not pending verification.
        _recalibrate_task_owners(
            cur, t["container_id"], tid, t["title"], verification_pending=False
        )
        conn.commit()
    return {
        "task_id": tid,
        "status": "cancelled",
        "forced": forced,  # #327: forced over ANY other owner (human or AI)
        "forced_by_human": forced
        and is_human,  # back-compat: precise "a human forced this"
        "owners_poked": len(others) if forced else 0,
    }


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
               WHERE td.depends_on_id = %s ORDER BY d.created_at""",
            (tid,),
        )
        downstream, would_unblock, still_blocked = [], 0, 0
        for d in cur.fetchall():
            did = str(d["id"])
            cur.execute(
                """SELECT 1 FROM task_dependencies x JOIN tasks dep ON dep.id = x.depends_on_id
                   WHERE x.task_id = %s AND x.depends_on_id <> %s AND dep.status <> 'completed'
                   LIMIT 1""",
                (did, tid),
            )
            unblocks = cur.fetchone() is None and d["status"] == "pending"
            if unblocks:
                would_unblock += 1
            elif d["status"] in ("pending", "blocked"):
                still_blocked += 1
            downstream.append(
                {
                    "task_id": did,
                    "title": d["title"],
                    "status": d["status"],
                    "would_unblock": unblocks,
                }
            )

        # 2) agents actively working it
        cur.execute(
            """SELECT a.id, a.alias, at.assignment_status
               FROM agent_tasks at JOIN agents a ON a.id = at.agent_id
               WHERE at.task_id = %s AND at.assignment_status IN ('assigned','accepted','working')
               ORDER BY a.alias""",
            (tid,),
        )
        in_flight = [
            {
                "agent_id": str(r["id"]),
                "alias": r["alias"],
                "assignment_status": r["assignment_status"],
            }
            for r in cur.fetchall()
        ]

        # 3) provenance: the request (if any) that spawned this task
        cur.execute(
            """SELECT r.id, r.status, ra.alias AS requester_alias
               FROM requests r LEFT JOIN agents ra ON ra.id = r.requester_id
               WHERE r.spawned_task_id = %s LIMIT 1""",
            (tid,),
        )
        sr = cur.fetchone()
        spawned_from = (
            {
                "request_id": str(sr["id"]),
                "requester_alias": sr["requester_alias"],
                "status": sr["status"],
            }
            if sr
            else None
        )

        # 4) still-open requests this task's assignees have in flight (orphan risk)
        cur.execute(
            """SELECT r.id, r.status, r.payload, ra.alias AS requester_alias, ta.alias AS target_alias
               FROM requests r
               LEFT JOIN agents ra ON ra.id = r.requester_id
               LEFT JOIN agents ta ON ta.id = r.target_id
               WHERE r.status IN ('open','answered')
                 AND r.requester_id IN (SELECT agent_id FROM agent_tasks WHERE task_id = %s)
               ORDER BY r.created_at""",
            (tid,),
        )
        open_reqs = [
            {
                "request_id": str(r["id"]),
                "status": r["status"],
                "requester_alias": r["requester_alias"],
                "target_alias": r["target_alias"],
                "preview": (r["payload"] or "")[:120],
            }
            for r in cur.fetchall()
        ]

    return {
        "task_id": tid,
        "title": t["title"],
        "status": t["status"],
        "is_root": t["is_root"],
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

# GH #71: requests default to type='info', but real work (review / sign-off / docs / coding)
# routed as 'info' silently skips the task wake path — a missed-wake incident. This shared,
# PURE classifier is the server-side BACKSTOP: when a caller sends type='info' with no task
# object, create_request runs it and AUTO-PROMOTES the request to type='task' if the payload
# clearly *asks for work*. It is intentionally conservative — a false promotion (info that
# becomes a task) is worse than a false negative (work that stays info), so the verb set is
# curated, not speculative, and an interrogative phrasing always wins (stays info).
#
# Curated WORK_VERBS only (do NOT expand speculatively). Multi-word forms ("sign off",
# "sign-off") are matched separately below.
WORK_VERBS = frozenset(
    {
        "review",
        "approve",
        "implement",
        "write",
        "code",
        "build",
        "fix",
        "document",
        "draft",
        "create",
        "refactor",
        "test",
        "add",
    }
)
# Leading question words / auxiliaries — if the payload OPENS with one of these it is a
# genuine question (interrogative), never promote even if a work verb appears later
# ("which file do I review?" stays info).
_QUESTION_LEADERS = frozenset(
    {
        "which",
        "what",
        "who",
        "whom",
        "whose",
        "when",
        "where",
        "why",
        "how",
        "is",
        "are",
        "was",
        "were",
        "do",
        "does",
        "did",
        "can",
        "could",
        "should",
        "would",
        "will",
        "shall",
        "may",
        "might",
        "am",
        "has",
        "have",
    }
)
# Imperative lead-ins that may precede the work verb ("please review ...", "can you go
# review ...") — we skip past these to find the verb in imperative position. "can"/"could"
# are deliberately NOT here: they lead a question ("can you review?" → interrogative).
_IMPERATIVE_LEADINS = frozenset(
    {"please", "kindly", "pls", "plz", "go", "now", "then", "you", "to"}
)
# Underscore MUST stay in the word charset: a code identifier like "test_wake_single_flight"
# or "include_closed" is one token, not the bare verb "test"/"closed" it would otherwise
# fragment into (GH#71 round-1 blocker 1).
_WORD_RE = re.compile(r"[a-z][a-z_\-']*")
# Copula/auxiliary forms — when one of these (or "of") follows the candidate verb anywhere
# before sentence end, the verb is being used as a NOUN subject of a declarative sentence
# ("fix was deployed", "review of the Q3 numbers is attached"), not an imperative. A bare
# past-tense/participle word ("failed", "dropped", "attached") is the same signal, checked
# separately below — underscore-joined identifiers are exempted so "include_closed" (which
# ends in "ed") is never mistaken for one (GH#71 round-1 blocker 2).
_DECLARATIVE_MARKERS = frozenset(
    {
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "being",
        "has",
        "have",
        "had",
        "of",
    }
)


def _is_declarative_tail(words: "list[str]") -> bool:
    for w in words:
        if w in _DECLARATIVE_MARKERS:
            return True
        if "_" not in w and w.endswith("ed") and w not in WORK_VERBS:
            return True
    return False


def classify_request_type(payload: str) -> "tuple[str, Optional[str]]":
    """GH #71 — pure, unit-testable classifier. Decide whether an info-typed request
    payload actually *asks for work* and should be promoted to a task.

    Returns ("task", matched_verb) to promote, or ("info", None) to leave alone.

    Rules (all must hold to promote):
      * a curated WORK_VERB (lowercased, word-boundary matched) appears in IMPERATIVE
        position — i.e. it is the first meaningful word, or follows only imperative
        lead-ins like "please"/"go"/"you";
      * the payload is NOT interrogative — it must not open with a question word/auxiliary
        AND must not end with '?';
      * the rest of the sentence is not declarative — no copula/auxiliary/"of" or bare
        past-tense word follows the verb (else it's a noun subject, e.g. "build 4711 failed
        overnight", not an imperative).
    Anything else stays info. Conservative by design (backstop only).
    """
    if not payload:
        return ("info", None)
    text = payload.strip()
    if not text:
        return ("info", None)
    lowered = text.lower()

    # Interrogative guards: trailing '?' OR a leading question word → genuine question.
    if text.rstrip().endswith("?"):
        return ("info", None)
    words = _WORD_RE.findall(lowered)
    if not words:
        return ("info", None)
    if words[0] in _QUESTION_LEADERS:
        return ("info", None)

    # Multi-word verb form: "sign off" / "sign-off" in imperative position.
    # Normalize the hyphenated form to the spaced form for a uniform prefix check, then
    # re-tokenize with the same word regex so the declarative-tail check below sees
    # underscore-joined identifiers as single tokens, same as the single-word path.
    norm = re.sub(r"sign-off", "sign off", lowered)
    norm_words = _WORD_RE.findall(norm)
    idx = 0
    while idx < len(norm_words) and norm_words[idx] in _IMPERATIVE_LEADINS:
        idx += 1
    if idx + 1 < len(norm_words):
        if norm_words[idx] == "sign" and norm_words[idx + 1] == "off":
            if _is_declarative_tail(norm_words[idx + 2 :]):
                return ("info", None)
            return ("task", "sign off")

    # Single-word work verb in imperative position: scan past leading imperative lead-ins,
    # the first meaningful word must be a curated WORK_VERB.
    pos = 0
    while pos < len(words) and words[pos] in _IMPERATIVE_LEADINS:
        pos += 1
    if pos < len(words) and words[pos] in WORK_VERBS:
        if _is_declarative_tail(words[pos + 1 :]):
            return ("info", None)
        return ("task", words[pos])
    return ("info", None)


@app.post("/api/containers/{cid}/requests", status_code=201)
def create_request(cid: str, body: RequestCreate):
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if not _valid_uuid(body.requester_agent_id):
        raise HTTPException(400, "requester_agent_id is not a valid UUID")

    with db_cursor() as (conn, cur):
        _require_container_active(
            cur, cid, body.requester_agent_id
        )  # GH #24 (was _require_container)
        req_ag = _require_agent(cur, body.requester_agent_id)
        _reject_if_retired(cur, body.requester_agent_id)  # ISS-51 [P1]
        if str(req_ag["container_id"]) != cid:
            raise HTTPException(
                400, "requester_agent_id belongs to a different container"
            )

        target_id: Optional[str] = None
        target_alias: Optional[str] = None
        if body.target_agent_id and body.target_alias:
            raise HTTPException(
                400, "specify target_agent_id OR target_alias, not both"
            )
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
                raise HTTPException(
                    404, f"parent request {body.parent_request_id} not found"
                )
            if str(parent["container_id"]) != cid:
                raise HTTPException(
                    400, "parent request belongs to a different container"
                )
            # parent should ideally be open or answered — closed parents make the chain meaningless
            if parent["status"] in ("closed", "rejected"):
                raise HTTPException(
                    409,
                    f"parent request is '{parent['status']}' — no point chaining off a finished request",
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
            if not _agent_participates_in_task(
                cur, cid, body.requester_agent_id, body.originating_task_id
            ):
                raise HTTPException(
                    400,
                    "originating_task_id must be a task in this container that the requester "
                    "participates in (owns/assignee/creator/collaborator)",
                )
            originating_task_id = body.originating_task_id

        # GH #71: AUTO-PROMOTE info-that-is-really-work to a task BEFORE the type branch,
        # so we never insert a task-type row with task=None (the 400 contract below is kept
        # for genuine caller errors). Only runs when the caller sent the DEFAULT type='info'
        # with NO task object — an explicit type='task' honors the caller and SKIPS the
        # classifier (binding answer #4). On a "task" verdict we synthesize a minimal
        # TaskRequestPayload (title = first line of payload truncated; dod = the payload;
        # priority = the request priority) and route it through the SAME task-detail build
        # path below, then stamp the audit fields onto `detail`.
        effective_type = body.type
        effective_task = body.task
        promoted_verb: Optional[str] = None
        if body.type == "info" and body.task is None:
            verdict, matched_verb = classify_request_type(body.payload)
            if verdict == "task":
                effective_type = "task"
                promoted_verb = matched_verb
                first_line = body.payload.strip().splitlines()[0].strip()
                synth_title = (
                    first_line[:MAX_NAME_LEN] if first_line else "(promoted request)"
                )
                effective_task = TaskRequestPayload(
                    title=synth_title,
                    definition_of_done=body.payload[:MAX_DOD_LEN],
                    priority=body.priority,
                )

        # Phase 3 (Orcha#5): type='task' carries a TaskRequestPayload in body.task
        # which gets stuffed into the JSONB `detail` column. The task itself is
        # only created on /accept-task.
        detail: Optional[dict] = None
        if effective_type == "task":
            if effective_task is None:
                raise HTTPException(
                    400,
                    "type='task' requires a `task` object (title, definition_of_done, priority)",
                )
            detail = {
                "title": effective_task.title,
                "description": effective_task.description,
                "definition_of_done": effective_task.definition_of_done,
                "priority": effective_task.priority,
            }
            # GH #55: carry the optional protocol through the request so the spawned task
            # inherits its loop rules on accept (only the keys actually set are stored).
            if effective_task.protocol is not None:
                proto_fields = effective_task.protocol.model_dump(exclude_none=True)
                if proto_fields:
                    detail["protocol"] = proto_fields
            # GH #71: audit stamp on a promoted request so the provenance is visible in `detail`.
            if promoted_verb is not None:
                detail["promoted_from_info"] = True
                detail["matched_verb"] = promoted_verb
        elif effective_task is not None:
            raise HTTPException(400, "`task` field is only valid with type='task'")

        cur.execute(
            """INSERT INTO requests
                 (container_id, type, requester_id, target_id, priority, status,
                  payload, expires_at, parent_request_id, chain_depth, detail,
                  originating_task_id)
               VALUES (%s, %s, %s, %s, %s, 'open', %s,
                       now() + (%s || ' minutes')::interval, %s, %s, %s::jsonb, %s)
               RETURNING id, expires_at""",
            (
                cid,
                effective_type,
                body.requester_agent_id,
                target_id,
                body.priority,
                body.payload,
                str(body.expires_minutes),
                parent_request_id,
                chain_depth,
                json.dumps(detail) if detail is not None else None,
                originating_task_id,
            ),
        )
        row = cur.fetchone()
        rid = str(row["id"])
        bump_agent(cur, body.requester_agent_id)
        recompute_agent_status(cur, body.requester_agent_id)  # → awaiting_request
        log_event(
            cur,
            cid,
            "ai",
            body.requester_agent_id,
            "request",
            rid,
            "created",
            {
                "type": effective_type,
                "target_alias": target_alias,
                "priority": body.priority,
                "preview": body.payload[:120],
                "parent_request_id": parent_request_id,
                "chain_depth": chain_depth,
                "task_title": detail["title"] if detail else None,
                "promoted_from_info": promoted_verb is not None,
            },
        )  # GH #71
        _publish_event(
            cur,
            cid,
            target_id,
            "request_created",
            {
                "request_id": rid,
                "type": effective_type,
                "from_agent_id": body.requester_agent_id,
                "preview": body.payload[:120],
            },
        )
        conn.commit()

    return {
        "request_id": rid,
        "type": effective_type,  # GH #71: reflects auto-promotion (info → task) when it fired
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
           FROM requests WHERE id=%s"""
        + (" FOR UPDATE" if for_update else ""),
        (rid,),
    )
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, f"request {rid} not found")
    return r


@app.get("/api/requests/{rid}")
def get_request(rid: str):
    """Read a single request by id. Read-only, localhost posture like wake-scan/wake-ack.

    GH#36: the notifier daemon calls this to decide whether a graded `ack_close` wake is still
    ACTIONABLE (status='answered' — there is a real answer to acknowledge + close) or a resolved
    NO-OP (closed/escalated/gone) it should NOT spend a full headless boot on. Booting a worker for
    an already-resolved request is exactly the empty-inbox boot→stall→watchdog-kill loop this read
    breaks: the daemon advances the wake cursor instead of spawning."""
    if not _valid_uuid(rid):
        raise HTTPException(400, "request_id is not a valid UUID")
    with db_cursor() as (_, cur):
        r = _require_request(cur, rid)  # 404 if missing
        return {
            "request_id": str(r["id"]),
            "type": r["type"],
            "status": r["status"],
            "requester_id": str(r["requester_id"]) if r["requester_id"] else None,
            "target_id": str(r["target_id"]) if r["target_id"] else None,
        }


@app.post("/api/requests/{rid}/respond", status_code=200)
def respond_request(rid: str, body: RequestRespond):
    if not _valid_uuid(rid):
        raise HTTPException(400, "request_id is not a valid UUID")
    if not _valid_uuid(body.responder_agent_id):
        raise HTTPException(400, "responder_agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        r = _require_request(
            cur, rid, for_update=True
        )  # lock: serialize overlapping retries
        _reject_if_retired(cur, body.responder_agent_id)  # ISS-51 [P1]
        _require_container_active(
            cur, str(r["container_id"]), body.responder_agent_id
        )  # GH #24
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
            return {
                "request_id": rid,
                "status": "answered",
                "already_answered": True,
                "response": r["response"],
                "unblocks_parent": None,
            }
        # GH #56 (Point 4): `accepted` is now a WAYPOINT, not a dead end. The accepter
        # (still the target) may post its real result to flip accepted → answered, which
        # fires the answer notification so the requester wakes on its originating_task_id.
        # The requester — not the accepter — later flips answered → closed (close_request).
        if r["status"] not in ("open", "accepted"):
            raise HTTPException(
                409,
                f"request is '{r['status']}', not 'open'/'accepted' — cannot respond",
            )
        cur.execute(
            "UPDATE requests SET status='answered', response=%s, responded_at=now() WHERE id=%s",
            (body.response, rid),
        )
        bump_agent(cur, body.responder_agent_id)
        recompute_agent_status(cur, body.responder_agent_id)  # just acted
        # The requester might also need recomputation if this answered their only open ask
        recompute_agent_status(cur, str(r["requester_id"]))
        log_event(
            cur,
            r["container_id"],
            "ai",
            body.responder_agent_id,
            "request",
            rid,
            "answered",
            {
                "preview": body.response[:120],
                "parent_request_id": str(r["parent_request_id"])
                if r["parent_request_id"]
                else None,
                "chain_depth": r["chain_depth"],
            },
        )

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
        _publish_event(
            cur,
            str(r["container_id"]),
            str(r["requester_id"]),
            "request_answered",
            {
                "request_id": rid,
                "preview": body.response[:120],
                "originating_task_id": str(r["originating_task_id"])
                if r["originating_task_id"]
                else None,
            },
        )
        conn.commit()
    return {"request_id": rid, "status": "answered", "unblocks_parent": unblocks_parent}


def _post_decision_to_thread(
    cur, subject_type, subject_id, decision, reason, actor_agent_id
):
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
        return None  # subject isn't a task → no thread (request/checkpoint/…)
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
    log_event(
        cur,
        trow["container_id"],
        "human",
        actor_agent_id,
        "task",
        str(subject_id),
        "decision_message",
        {
            "message_id": mid,
            "decision": decision,
            "subject_type": subject_type,
            "preview": body[:120],
        },
    )
    return mid


def _route_close_reason(
    cur, container_id, subject_type, subject_id, reason, actor_agent_id, target_agent_id
):
    """B7/B0: persist a human's close/cancel REASON as a decision and route it to the
    OWNING agent so it learns WHY its item was force-closed on its next wake. Reuses the
    B0 `decisions` table + `decision_made` event verbatim; a force-close is modelled as
    decision='reject' (the human overrode/abandoned the item) carrying the reason."""
    cur.execute(
        """INSERT INTO decisions
             (container_id, subject_type, subject_id, decision, reason, actor_agent_id, target_agent_id)
           VALUES (%s, %s, %s, 'reject', %s, %s, %s)
           RETURNING id""",
        (
            container_id,
            subject_type,
            str(subject_id),
            reason,
            actor_agent_id,
            target_agent_id,
        ),
    )
    did = str(cur.fetchone()["id"])
    if target_agent_id:
        _publish_event(
            cur,
            str(container_id) if container_id else None,
            str(target_agent_id),
            "decision_made",
            {
                "decision_id": did,
                "subject_type": subject_type,
                "subject_id": str(subject_id),
                "decision": "reject",
                "reason": reason,
            },
        )
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
        r = _require_request(
            cur, rid, for_update=True
        )  # lock: serialize overlapping retries
        _require_container_active(
            cur, str(r["container_id"]), body.requester_agent_id
        )  # GH #24 (human may still close)
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
            raise HTTPException(
                409, f"request is '{r['status']}', not 'answered' — cannot close"
            )
        # B7.2: a human closing a request they do NOT own must give a reason — it's routed to
        # the owner so it learns why (the API enforces this, not only the UI).
        reason = (body.reason or "").strip()
        forced = is_human and not is_owner
        if forced and not reason:
            raise HTTPException(
                422,
                {
                    "error": "reason_required",
                    "detail": "a reason is required when a human closes another agent's request",
                },
            )
        cur.execute(
            "UPDATE requests SET status='closed', closed_at=now() WHERE id=%s", (rid,)
        )
        # Recompute the OWNER (requester) — its waiting_on changed.
        bump_agent(cur, str(r["requester_id"]))
        recompute_agent_status(cur, str(r["requester_id"]))
        log_event(
            cur,
            r["container_id"],
            ("human" if is_human else "ai"),
            body.requester_agent_id,
            "request",
            rid,
            "closed",
            {"by_human": is_human, "forced": forced},
        )
        if r["target_id"]:
            _publish_event(
                cur,
                str(r["container_id"]),
                str(r["target_id"]),
                "request_closed",
                {"request_id": rid},
            )
            # GH #58: a TASK request closed before the target accepted/rejected would otherwise pin the
            # target's cursor on its NEW_WORK request_created (no accept/reject seam ever ran). Closing
            # terminally resolves it.
            _ack_events_handled(
                cur, str(r["target_id"]), "request_created", "request_id", rid
            )
        if forced:
            _route_close_reason(
                cur,
                r["container_id"],
                "request_close",
                rid,
                reason,
                body.requester_agent_id,
                str(r["requester_id"]),
            )
        conn.commit()
    return {"request_id": rid, "status": "closed", "forced_by_human": forced}


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
        r = _require_request(
            cur, rid
        )  # SELECT-only (no FOR UPDATE): a nudge never mutates the request
        _require_container_active(cur, str(r["container_id"]), body.actor_agent_id)
        # Human-only: a nudge is an operator wake action.
        cur.execute(
            "SELECT kind, alias FROM agents WHERE id=%s", (body.actor_agent_id,)
        )
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
            raise HTTPException(
                409,
                "this request was accepted and became a task — "
                "nudge the task, not the request",
            )
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
        if (
            not recipient_id
            or recipient_is_human
            or recipient_id == body.actor_agent_id
        ):
            return {
                "request_id": rid,
                "status": status,
                "nudged": False,
                "nudged_role": role,
                "nudged_agent_id": None,
                "reason": "a human owns the next action — nothing to wake",
            }
        # Wake-framed, state-appropriate directed prompt naming the nudger + rid8 + a 1-line preview.
        # Task-aware: an OPEN *task* request is accepted/rejected (NOT answered), and the poke carries
        # the full task ask (title / description / definition of done / protocol) so the woken agent
        # can decide even though the original request_created event was consumed on first drain.
        short_rid = rid[:8]
        is_task = r["type"] == "task"
        payload_preview = (str(r["payload"] or "").strip().splitlines() or [""])[0][
            :120
        ]
        if role == "target":
            if is_task:
                message = (
                    f"{actor_alias} nudged you about an OPEN task request you have not picked up "
                    f"yet. Request {short_rid}. Please accept it (/orcha-accept-task) or reject it "
                    f"(/orcha-reject-task)." + _task_request_context_block(r["detail"])
                )
            else:
                message = (
                    f"{actor_alias} nudged you about an OPEN request you still owe an answer on. "
                    f'Request {short_rid}: "{payload_preview}". Please respond to it (/orcha-respond).'
                )
        else:  # requester, on an answered request
            if is_task:
                detail = r["detail"] if isinstance(r["detail"], dict) else {}
                title = (detail.get("title") or "").strip()
                what = f' ("{title[:120]}")' if title else ""
                message = (
                    f"{actor_alias} nudged you: a task request you sent{what} has been ANSWERED "
                    f"and is waiting on you to act on the result or close it (/orcha-close). "
                    f"Request {short_rid}."
                )
            else:
                message = (
                    f"{actor_alias} nudged you: a request you sent has been ANSWERED and is waiting "
                    f"on you to act on the answer or close it. "
                    f'Request {short_rid}: "{payload_preview}".'
                )
        note = (body.note or "").strip()
        if note:
            message += f" Note from {actor_alias}: {note}"
        _poke_path_forward(
            cur, str(r["container_id"]), recipient_id, body.actor_agent_id, message
        )
        # Audit only — NO status UPDATE, NO turn bump (an external poke, like triage-close).
        log_event(
            cur,
            r["container_id"],
            "human",
            body.actor_agent_id,
            "request",
            rid,
            "nudged",
            {"by_human": True, "role": role},
        )
        conn.commit()
    return {
        "request_id": rid,
        "status": status,
        "nudged": True,
        "nudged_role": role,
        "nudged_agent_id": recipient_id,
    }


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
        r = _require_request(
            cur, rid, for_update=True
        )  # lock: serialize against a concurrent close
        if r["status"] == "closed":
            return {"request_id": rid, "status": "closed", "already_closed": True}
        if r["status"] != "answered":
            raise HTTPException(
                409,
                f"request is '{r['status']}', not 'answered' — triage-close only "
                f"closes a pure-ack answered request",
            )
        triage_reason = (body.triage_reason or "").strip()[:500]
        cur.execute(
            "UPDATE requests SET status='closed', closed_at=now() WHERE id=%s", (rid,)
        )
        # the requester's waiting_on changed — recompute its status, but DON'T bump_agent: this is a
        # system cleanup, not an action by the requester (must not inflate its turns_used/budget).
        recompute_agent_status(cur, str(r["requester_id"]))
        stamp = {"auto": True, "reason": "triage_skip", "triage_reason": triage_reason}
        log_event(
            cur, r["container_id"], "system", None, "request", rid, "closed", stamp
        )
        if r["target_id"]:
            _publish_event(
                cur,
                str(r["container_id"]),
                str(r["target_id"]),
                "request_closed",
                {"request_id": rid, **stamp},
            )
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
        r = _require_request(
            cur, rid, for_update=True
        )  # lock: serialize all request-state mutations
        _require_container_active(
            cur, str(r["container_id"]), body.requester_agent_id
        )  # GH #24
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
        log_event(
            cur,
            r["container_id"],
            "ai",
            body.requester_agent_id,
            "request",
            rid,
            "escalated",
            {
                "reason": body.reason,
                "from_status": r["status"],
                "to_human_id": human_id,
            },
        )
        # Notify the human directly + the container channel for any dashboards.
        _publish_event(
            cur,
            str(r["container_id"]),
            human_id,
            "request_created",
            {
                "request_id": rid,
                "type": r["type"],
                "from_agent_id": body.requester_agent_id,
                "preview": (r["payload"] or "")[:120],
                "via": "escalated",
            },
        )
        _publish_event(
            cur,
            str(r["container_id"]),
            None,
            "request_escalated",
            {"request_id": rid, "reason": body.reason, "to_human_id": human_id},
        )
        # GH #58: escalation re-routes this request to a human; if it was a TASK request the original
        # agent target never accept/rejected, resolve its NEW_WORK request_created so it doesn't pin.
        if r["target_id"]:
            _ack_events_handled(
                cur, str(r["target_id"]), "request_created", "request_id", rid
            )
        conn.commit()
    return {
        "request_id": rid,
        "status": "open",
        "target_id": human_id,
        "escalated": True,
    }


# ---------- Phase 3 / Orcha#5: task requests + agent-suggestion ----------


@app.post("/api/requests/{rid}/accept-task", status_code=200)
def accept_task_request(
    rid: str,
    body: TaskRequestAccept,
    x_orcha_run_token: Optional[str] = Header(default=None, alias="X-Orcha-Run-Token"),
):
    """Target accepts a task request → creates the task, assigns it, marks request 'accepted'."""
    if not _valid_uuid(rid):
        raise HTTPException(400, "request_id is not a valid UUID")
    if not _valid_uuid(body.responder_agent_id):
        raise HTTPException(400, "responder_agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        r = _require_request(
            cur, rid, for_update=True
        )  # lock: serialize overlapping retries
        # GH #91/#90: accepting a task request creates an agent_tasks 'working' row — that is moving a
        # task INTO working, which is WORK-lane only. Gate on the ACCEPTING agent (the target /
        # responder). A conversation-lane embodiment can DISPATCH a task (create/assign a request) but
        # cannot accept one into its own working set (403).
        _require_work_lane(cur, body.responder_agent_id, x_orcha_run_token)
        _reject_if_retired(
            cur, body.responder_agent_id
        )  # ISS-51 [P1]: retired can't take on work
        _require_container_active(
            cur, str(r["container_id"]), body.responder_agent_id
        )  # GH #24
        if r["type"] != "task":
            raise HTTPException(
                409, f"request type is '{r['type']}', not 'task' — cannot accept-task"
            )
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
            _retry_dod = (r["detail"] or {}).get("definition_of_done") or ""
            if r["spawned_task_id"]:
                _attribute_token_run_to_task(
                    cur,
                    body.responder_agent_id,
                    x_orcha_run_token,
                    str(r["spawned_task_id"]),
                )
                conn.commit()
            return {
                "request_id": rid,
                "status": "accepted",
                "spawned_task_id": str(r["spawned_task_id"])
                if r["spawned_task_id"]
                else None,
                "report_back": _build_report_back(rid, _retry_dod),
                "report_back_request_id": rid,
                "already_accepted": True,
            }
        if r["status"] != "open":
            raise HTTPException(
                409, f"request is '{r['status']}', not 'open' — cannot accept"
            )
        task = r["detail"] or {}
        if "title" not in task or "definition_of_done" not in task:
            raise HTTPException(
                500, "request detail is malformed; cannot synthesize a task"
            )
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
            merged_notes = (
                report_back + sep + existing_notes[:room] if room > 0 else report_back
            )
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
            (
                str(r["container_id"]),
                task["title"],
                task.get("description"),
                task["definition_of_done"],
                task.get("priority", 100),
                str(r["requester_id"]),
                protocol_json,
            ),
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
        log_event(
            cur,
            r["container_id"],
            "ai",
            body.responder_agent_id,
            "request",
            rid,
            "accepted",
            {"spawned_task_id": tid, "note": body.note},
        )
        log_event(
            cur,
            r["container_id"],
            "ai",
            body.responder_agent_id,
            "task",
            tid,
            "created",
            {"title": task["title"], "via": "task-request accept"},
        )
        _attribute_token_run_to_task(
            cur, body.responder_agent_id, x_orcha_run_token, tid
        )
        # GH #56 (Point 6): accept must NOT wake the requester — only the real ANSWER (at material
        # completion) wakes them. The accept stays in the audit feed via log_event above, but we no
        # longer publish a wake-worthy `task_request_accepted` event toward the requester (it was
        # classified as a `request_answered` notification — a premature receipt). Accept is silent now.
        # GH #58: accepting CONSUMES the target's NEW_WORK request_created notification (the accept IS
        # the handling; the spawned task drives the work) so it stops re-waking the responder.
        _ack_events_handled(
            cur, body.responder_agent_id, "request_created", "request_id", rid
        )
        conn.commit()
    # GH #56 (review P1): the same worker session that accepts a task-request keeps working it
    # WITHOUT reloading the spawned task's protocol, so the report-back note buried in
    # protocol.notes is invisible on this wake — the primary accepted->answered path gets skipped
    # and the Point 5 backstop becomes the normal route. Echo the instruction in the accept
    # RESPONSE so /orcha-accept-task can surface it immediately, in the same session, before the
    # agent starts the work.
    return {
        "request_id": rid,
        "status": "accepted",
        "spawned_task_id": tid,
        "report_back": report_back,
        "report_back_request_id": rid,
    }


@app.post("/api/requests/{rid}/reject-task", status_code=200)
def reject_task_request(rid: str, body: TaskRequestReject):
    """Target rejects a task request with a reason; requester can then re-ask, suggest agent, or escalate."""
    if not _valid_uuid(rid):
        raise HTTPException(400, "request_id is not a valid UUID")
    if not _valid_uuid(body.responder_agent_id):
        raise HTTPException(400, "responder_agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        r = _require_request(
            cur, rid, for_update=True
        )  # lock: serialize all request-state mutations
        _require_container_active(
            cur, str(r["container_id"]), body.responder_agent_id
        )  # GH #24
        if r["type"] != "task":
            raise HTTPException(
                409, f"request type is '{r['type']}', not 'task' — cannot reject-task"
            )
        if r["status"] != "open":
            raise HTTPException(
                409, f"request is '{r['status']}', not 'open' — cannot reject"
            )
        if r["target_id"] is None or str(r["target_id"]) != body.responder_agent_id:
            raise HTTPException(403, "only the target agent may reject")
        cur.execute(
            "UPDATE requests SET status='rejected', rejection_reason=%s, responded_at=now() WHERE id=%s",
            (body.reason, rid),
        )
        bump_agent(cur, body.responder_agent_id)
        recompute_agent_status(cur, body.responder_agent_id)
        recompute_agent_status(cur, str(r["requester_id"]))
        log_event(
            cur,
            r["container_id"],
            "ai",
            body.responder_agent_id,
            "request",
            rid,
            "rejected",
            {"reason": body.reason},
        )
        _publish_event(
            cur,
            str(r["container_id"]),
            str(r["requester_id"]),
            "task_request_rejected",
            {"request_id": rid, "reason": body.reason},
        )
        # ISS-42 (B12): don't strand the requester at a dead-end. The machine event above wakes them
        # but carries no surfaced content; poke them with the reason + the three concrete paths forward
        # (re-ask, suggest a different agent, escalate to a human) so the rejection becomes actionable.
        reason_txt = (body.reason or "").strip() or "(no reason given)"
        _poke_path_forward(
            cur,
            str(r["container_id"]),
            str(r["requester_id"]),
            body.responder_agent_id,
            f"Your task request (id {rid}) was rejected: {reason_txt}. You're not stuck — pick a path "
            f"forward: re-ask another agent (/orcha-ask --task), propose a new agent for it "
            f"(/orcha-suggest-agent {rid}), or escalate to a human (/orcha-escalate {rid}).",
        )
        # GH #58: rejecting CONSUMES the target's NEW_WORK request_created notification so it stops
        # re-waking the responder (the work is now back with the requester to re-route).
        _ack_events_handled(
            cur, body.responder_agent_id, "request_created", "request_id", rid
        )
        conn.commit()
    return {
        "request_id": rid,
        "status": "rejected",
        "reason": body.reason,
        "requester_poked": True,
    }


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
        r = _require_request(
            cur, rid, for_update=True
        )  # lock: serialize all request-state mutations
        _require_container_active(
            cur, str(r["container_id"]), body.requester_agent_id
        )  # GH #24
        if r["status"] not in ("open", "answered", "rejected"):
            raise HTTPException(
                409, f"request is '{r['status']}' — cannot escalate-with-suggestion"
            )
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
        log_event(
            cur,
            r["container_id"],
            "ai",
            body.requester_agent_id,
            "request",
            rid,
            "agent_suggested",
            {
                "proposed_alias": body.proposed_alias,
                "proposed_role": body.proposed_role,
                "rationale": body.rationale[:120],
                "to_human_id": human_id,
            },
        )
        _publish_event(
            cur,
            str(r["container_id"]),
            human_id,
            "agent_suggested",
            {
                "request_id": rid,
                "proposed_alias": body.proposed_alias,
                "from_agent_id": body.requester_agent_id,
            },
        )
        conn.commit()
    return {
        "request_id": rid,
        "status": "open",
        "target_id": None,
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
        r = _require_request(
            cur, rid, for_update=True
        )  # lock: serialize all request-state mutations
        # Orcha#30: detect a pending suggestion by detail.proposed_alias, not by null target.
        # The request now lives in the targeted human's inbox until resolved.
        detail = r["detail"] or {}
        if "proposed_alias" not in detail:
            raise HTTPException(409, "request has no agent-suggestion to decide on")
        if r["status"] != "open":
            raise HTTPException(
                409, f"suggestion is '{r['status']}', not 'open' — already decided"
            )

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
                    (
                        str(r["container_id"]),
                        detail["proposed_alias"],
                        detail["proposed_role"],
                        detail["proposed_prompt"],
                        str(r["requester_id"]),
                        body.turn_budget,
                    ),
                )
            except psycopg.errors.UniqueViolation:
                raise HTTPException(
                    409,
                    f"alias '{detail['proposed_alias']}' already exists in this container",
                )
            new_aid = str(cur.fetchone()["id"])
            # Now target the request at the new agent so they can /accept-task it.
            cur.execute(
                "UPDATE requests SET target_id=%s, status='open' WHERE id=%s",
                (new_aid, rid),
            )
            log_event(
                cur,
                r["container_id"],
                "human",
                None,
                "agent",
                new_aid,
                "created",
                {
                    "alias": detail["proposed_alias"],
                    "via": "suggestion accepted",
                    "from_request_id": rid,
                    "verifier_human_id": body.actor_agent_id,
                },
            )
            log_event(
                cur,
                r["container_id"],
                "human",
                None,
                "request",
                rid,
                "suggestion_decided",
                {
                    "kind": "create",
                    "new_agent_id": new_aid,
                    "verifier_human_id": body.actor_agent_id,
                },
            )
            _publish_event(
                cur,
                str(r["container_id"]),
                new_aid,
                "request_created",
                {
                    "request_id": rid,
                    "type": r["type"],
                    "from_agent_id": str(r["requester_id"]),
                    "preview": r["payload"][:120],
                    "via": "human created new agent",
                },
            )
            _publish_event(
                cur,
                str(r["container_id"]),
                str(r["requester_id"]),
                "agent_suggestion_decided",
                {
                    "request_id": rid,
                    "kind": "create",
                    "new_alias": detail["proposed_alias"],
                },
            )
            conn.commit()
            return {
                "request_id": rid,
                "kind": "create",
                "new_agent_id": new_aid,
                "new_alias": detail["proposed_alias"],
                "status": "open",
            }

        elif body.kind == "reassign":
            if not body.target_alias:
                raise HTTPException(400, "reassign requires target_alias")
            new_target_id = _resolve_alias(
                cur, str(r["container_id"]), body.target_alias
            )
            cur.execute(
                "UPDATE requests SET target_id=%s, status='open' WHERE id=%s",
                (new_target_id, rid),
            )
            log_event(
                cur,
                r["container_id"],
                "human",
                None,
                "request",
                rid,
                "suggestion_decided",
                {
                    "kind": "reassign",
                    "to_alias": body.target_alias,
                    "verifier_human_id": body.actor_agent_id,
                },
            )
            _publish_event(
                cur,
                str(r["container_id"]),
                new_target_id,
                "request_created",
                {
                    "request_id": rid,
                    "type": r["type"],
                    "from_agent_id": str(r["requester_id"]),
                    "preview": r["payload"][:120],
                    "via": "human reassigned",
                },
            )
            _publish_event(
                cur,
                str(r["container_id"]),
                str(r["requester_id"]),
                "agent_suggestion_decided",
                {
                    "request_id": rid,
                    "kind": "reassign",
                    "target_alias": body.target_alias,
                },
            )
            conn.commit()
            return {
                "request_id": rid,
                "kind": "reassign",
                "target_alias": body.target_alias,
                "status": "open",
            }

        else:  # refuse
            cur.execute(
                "UPDATE requests SET status='closed', closed_at=now(), rejection_reason=%s WHERE id=%s",
                (body.reason or "refused by human", rid),
            )
            recompute_agent_status(cur, str(r["requester_id"]))
            log_event(
                cur,
                r["container_id"],
                "human",
                None,
                "request",
                rid,
                "suggestion_decided",
                {
                    "kind": "refuse",
                    "reason": body.reason,
                    "verifier_human_id": body.actor_agent_id,
                },
            )
            _publish_event(
                cur,
                str(r["container_id"]),
                str(r["requester_id"]),
                "agent_suggestion_decided",
                {"request_id": rid, "kind": "refuse", "reason": body.reason},
            )
            conn.commit()
            return {
                "request_id": rid,
                "kind": "refuse",
                "status": "closed",
                "reason": body.reason,
            }


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
        r = _require_request(
            cur, rid, for_update=True
        )  # lock: serialize all request-state mutations
        _require_container_active(
            cur, str(r["container_id"]), body.requester_agent_id
        )  # GH #24 (human may still convert)
        if r["status"] != "answered":
            raise HTTPException(
                409, f"request is '{r['status']}', not 'answered' — cannot convert"
            )
        if str(r["requester_id"]) != body.requester_agent_id:
            raise HTTPException(403, "only the requester may convert")
        if r["type"] != "info":
            raise HTTPException(
                409, f"only info requests can be converted (this is '{r['type']}')"
            )
        assignee_id: Optional[str] = None
        if body.assignee_alias:
            assignee_id = _resolve_alias(
                cur, str(r["container_id"]), body.assignee_alias
            )
        initial_status = "in_progress" if assignee_id else "ready"
        started_clause = "now()" if assignee_id else "NULL"
        cur.execute(
            f"""INSERT INTO tasks
                  (container_id, title, description, definition_of_done,
                   status, priority, created_by_agent_id, started_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, {started_clause})
                RETURNING id""",
            (
                str(r["container_id"]),
                body.title,
                f"Converted from request {rid[:8]}…",
                body.definition_of_done,
                initial_status,
                body.priority,
                body.requester_agent_id,
            ),
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
        log_event(
            cur,
            r["container_id"],
            "ai",
            body.requester_agent_id,
            "request",
            rid,
            "converted_to_task",
            {
                "spawned_task_id": tid,
                "title": body.title,
                "assignee_alias": body.assignee_alias,
            },
        )
        log_event(
            cur,
            r["container_id"],
            "ai",
            body.requester_agent_id,
            "task",
            tid,
            "created",
            {"title": body.title, "via": "info-request conversion"},
        )
        if assignee_id:
            _publish_event(
                cur,
                str(r["container_id"]),
                assignee_id,
                "task_assigned",
                {
                    "task_id": tid,
                    "title": body.title,
                    "via": "converted from info request",
                },
            )
        # GH #58: converting terminally resolves the original request — if the target still had a
        # pending request_created for it, ack it so it stops re-surfacing (mirrors close/escalate).
        if r["target_id"]:
            _ack_events_handled(
                cur, str(r["target_id"]), "request_created", "request_id", rid
            )
        conn.commit()
    return {
        "request_id": rid,
        "status": "converted_to_task",
        "spawned_task_id": tid,
        "assignee_alias": body.assignee_alias,
    }


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
        log_event(
            cur,
            str(ag["container_id"]),
            "agent",
            body.from_agent_id,
            "agent",
            aid,
            "prompt_sent",
            {"chars": len(body.message)},
        )
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
    if row["container_status"] != "active":  # _require_container_active → 409
        return True
    if row["terminated_at"] is not None:  # _reject_if_retired → 409
        return True
    return False


@app.get("/api/agents/{aid}/wait")
async def agent_wait(
    aid: str,
    since_ts: float = Query(default=0.0),
    timeout: float = Query(default=30.0, ge=1, le=120),
):
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
        # GH #91/#90: also refresh the WORK-lane heartbeat so a present listener suppresses a
        # redundant work spawn (see _touch_heartbeat + the edge/level note below, which relies on it).
        cur.execute(
            """INSERT INTO agent_wake_state (agent_id, work_last_heartbeat_at)
               VALUES (%s, now())
               ON CONFLICT (agent_id) DO UPDATE SET work_last_heartbeat_at = now()""",
            (aid,),
        )
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
        return {
            "event": "task_ready",
            "ts": since_ts,
            "task_id": ready_tid,
            "assigned": True,
        }
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
            ready_tid = (
                None
                if _agent_claim_blocked(cur, aid)
                else _assigned_ready_task(cur, aid)
            )
        if ready_tid is not None:
            return {
                "event": "task_ready",
                "ts": since_ts,
                "task_id": ready_tid,
                "assigned": True,
            }
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
            log_event(
                cur,
                cid,
                "system",
                None,
                "request",
                str(r["id"]),
                "escalated",
                {"reason": "expires_at passed (sweep)", "to_human_id": human_id},
            )
            _publish_event(
                cur,
                cid,
                human_id,
                "request_created",
                {"request_id": str(r["id"]), "via": "expires_at sweep"},
            )
            _publish_event(
                cur,
                cid,
                None,
                "request_escalated",
                {"request_id": str(r["id"]), "reason": "expires_at passed (sweep)"},
            )
        conn.commit()
    return {
        "escalated_count": len(expired),
        "request_ids": [str(r["id"]) for r in expired],
    }


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
    decisions, learnings, open_threads = (
        body.decisions,
        body.learnings,
        body.open_threads,
    )
    if _digest_curate is not None:
        clean = _digest_curate.dedup_digest(
            {
                "decisions": decisions,
                "learnings": learnings,
                "open_threads": open_threads,
            }
        )
        decisions, learnings, open_threads = (
            clean["decisions"],
            clean["learnings"],
            clean["open_threads"],
        )
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
            (
                cid,
                aid,
                ts,
                body.current_focus,
                json.dumps(decisions),
                json.dumps(learnings),
                json.dumps(open_threads),
                body.audience,
            ),
        )
        did = cur.fetchone()["id"]
        log_event(
            cur,
            cid,
            "ai",
            aid,
            "agent",
            aid,
            "digest_snapshotted",
            {"digest_id": did, "current_focus": body.current_focus},
        )
        # ISS-58: publish CONTAINER-scoped only (target_agent_id=None), NOT to the agent's own key.
        # A snapshot is a dashboard notification, not work — delivering it to the agent's inbox made
        # wake-scan count it as pending and re-wake the agent, which snapshots again on exit → a
        # ~60s runaway. agent_id rides in the payload so dashboards still attribute it.
        _publish_event(
            cur,
            cid,
            None,
            "digest_snapshotted",
            {"digest_id": did, "snapshot_ts": ts, "agent_id": aid},
        )
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
               FROM agents WHERE id=%s""",
            (aid,),
        )
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
        raise HTTPException(
            422,
            {
                "error": "reason_required",
                "detail": "a reason is required when decision is 'reject'",
            },
        )
    if body.target_agent_id is not None and not _valid_uuid(body.target_agent_id):
        raise HTTPException(400, "target_agent_id is not a valid UUID")

    with db_cursor() as (conn, cur):
        # Only a human decides. _require_kind also validates the UUID + existence.
        _require_kind(cur, body.actor_agent_id, ("human",))
        cur.execute(
            "SELECT container_id FROM agents WHERE id=%s", (body.actor_agent_id,)
        )
        target_container = cur.fetchone()["container_id"]
        if body.target_agent_id is not None:
            cur.execute(
                "SELECT container_id FROM agents WHERE id=%s", (body.target_agent_id,)
            )
            trow = cur.fetchone()
            if not trow:
                raise HTTPException(
                    404, f"target agent {body.target_agent_id} not found"
                )
            target_container = trow["container_id"]

        cur.execute(
            """INSERT INTO decisions
                 (container_id, subject_type, subject_id, decision, reason,
                  actor_agent_id, target_agent_id)
               VALUES (%s, %s, %s, %s, %s, %s, %s)
               RETURNING id, created_at""",
            (
                target_container,
                body.subject_type,
                body.subject_id,
                body.decision,
                (reason or None),
                body.actor_agent_id,
                body.target_agent_id,
            ),
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
                {
                    "decision_id": decision_id,
                    "subject_type": body.subject_type,
                    "subject_id": body.subject_id,
                    "decision": body.decision,
                    "reason": (reason or None),
                },
            )
        # ISS-48: a decision_made event wakes the agent, but the agent's source of truth is the
        # task THREAD — so also post an attributed decision message there. Without it an approved
        # plan-first agent re-reads the thread, sees no approval, and re-plans forever.
        _post_decision_to_thread(
            cur,
            body.subject_type,
            body.subject_id,
            body.decision,
            (reason or None),
            body.actor_agent_id,
        )

    return {
        "decision_id": decision_id,
        "decision": body.decision,
        "reason": (reason or None),
        "subject_type": body.subject_type,
        "subject_id": body.subject_id,
        "target_agent_id": body.target_agent_id,
        "created_at": row["created_at"].isoformat(),
    }


@app.get("/api/decisions/{did}")
def get_decision(did: str):
    if not _valid_uuid(did):
        raise HTTPException(400, "decision_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        cur.execute(
            """SELECT id, container_id, subject_type, subject_id, decision, reason,
                      actor_agent_id, target_agent_id, created_at
               FROM decisions WHERE id=%s""",
            (did,),
        )
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
            "target_agent_id": str(row["target_agent_id"])
            if row["target_agent_id"]
            else None,
            "created_at": row["created_at"].isoformat(),
        }
