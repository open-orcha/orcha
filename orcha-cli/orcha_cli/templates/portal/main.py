"""Compose the Orcha FastAPI portal and preserve its public Python seams."""

import os
import pathlib
from typing import Optional

from fastapi.responses import HTMLResponse
from portal_backend.application import (
    app,
    no_store_dynamic_responses as _no_store_dynamic_responses,
)
from portal_backend.attachment_config import (
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENTS_PER_MESSAGE,
    MAX_EXTRACTED_TEXT_CHARS,
    configure_compatibility as _configure_attachment_compatibility,
)
from portal_backend.attachment_references import (
    render_attachment_feed_line as _render_attachment_feed_line,
)
from portal_backend.attachment_routes import (
    configure_compatibility as _configure_attachment_routes,
    serve_attachment,
    serve_conversation_attachment,
    upload_attachment,
    upload_conversation_attachment,
)
from portal_backend.container_snapshot_routes import get_container
from portal_backend.database import DB, db_cursor, run_migrations
from portal_backend.decision_routing import _post_decision_to_thread
from portal_backend.directed_message_collection import collect_directed_messages
from portal_backend.drain_classification import (
    _DRAIN_DIRECTIVE,
    _DRAIN_FYI,
    _DRAIN_NEW_WORK,
    _DRAIN_NON_WAKING,
    _DRAIN_RUN_ACKABLE,
    _DRAIN_TASK_BOUND,
    _DRAIN_TASKLESS_ACTIONABLE,
    _drain_class,
)
from portal_backend.event_policy import _triage_hint_for
from portal_backend.events import publish_event as _publish_event
from portal_backend.guards import valid_uuid as _valid_uuid
from portal_backend.limits import MAX_PROMPT_BATCH_CHARS
from portal_backend.model_policy import (
    AVAILABLE_MODELS,
    AVAILABLE_REASONING_EFFORTS,
    DEFAULT_MODEL,
    DEFAULT_REASONING_EFFORT,
    MODELS_BY_ID as _MODELS_BY_ID,
    MODEL_IDS as _MODEL_IDS,
    REASONING_EFFORT_IDS_BY_MODEL as _REASONING_EFFORT_IDS_BY_MODEL,
    REASONING_EFFORT_IDS as _REASONING_EFFORT_IDS,
    resolve_reasoning_effort,
)
from portal_backend.notification_formatting import (
    _classify_notification,
    _notification_origin_order,
    _notification_rank,
    _notification_surface,
)
from portal_backend import notification_taxonomy as _notification_taxonomy
from portal_backend.request_classification import (
    WORK_VERBS,
    _is_declarative_tail,
    classify_request_type,
)
from portal_backend.request_backstop import (
    backstop_stranded_request as _backstop_stranded_request,
)
from portal_backend.static_pages import (
    STATIC_DIR as _STATIC_DIR,
    missing_static_page as _missing_static_page,
    serve_page as _serve,
)
from portal_backend.task_completion_support import (
    _complete_and_unblock,
    _recalibrate_agent_digest_on_close,
    _recalibrate_task_owners,
    configure_compatibility as _configure_task_completion,
)
from portal_backend.wake_event_queries import (
    earliest_actionable_answer_ts,
    resident_inbox_task_work_id,
)
from portal_backend.wake_manifest import _wake_notification_manifest

try:
    import llm_util
    import secret_box
except ImportError:
    from orcha_cli import llm_util, secret_box

try:
    import digest_curate as _digest_curate
except ImportError:
    try:
        from orcha_cli import digest_curate as _digest_curate
    except ImportError:
        _digest_curate = None

ATTACHMENTS_DIR = pathlib.Path(
    os.environ.get("ORCHA_ATTACHMENTS_DIR", "/app/orcha-attachments")
)


def resolve_model(model: Optional[str]) -> str:
    """Resolve through the facade-owned model catalog for monkeypatch compatibility."""
    return model if model in _MODEL_IDS else DEFAULT_MODEL


def resolve_model_runtime(model: Optional[str]) -> str:
    """Return the worker runtime after applying the compatible model fallback."""
    return _MODELS_BY_ID.get(resolve_model(model), {}).get("runtime", "claude")


def _collect_directed_messages(cur, aid: str, delivered_ts, max_ts):
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
    return earliest_actionable_answer_ts(cur, aid, delivered_ts)


def _resident_inbox_task_work_id(cur, aid: str, delivered_ts, max_ts):
    return resident_inbox_task_work_id(
        cur, aid, delivered_ts, max_ts, valid_uuid=_valid_uuid
    )


# Route modules register cohesive API surfaces when imported.
from portal_backend.active_conversation_routes import (  # noqa: E402
    configure_compatibility as _configure_active_conversations,
)
from portal_backend.agent_digest_routes import (  # noqa: E402
    configure_compatibility as _configure_agent_digest,
)
from portal_backend.agent_event_routes import (  # noqa: E402
    configure_compatibility as _configure_agent_events,
)
from portal_backend.application_lifecycle import (  # noqa: E402
    configure_compatibility as _configure_lifecycle,
    start_local_index_warmer as _start_local_index_warmer,
    startup_migrate as _startup_migrate,
)
from portal_backend.embodiment_token_routes import (  # noqa: E402
    attribute_token_run_to_task as _attribute_token_run_to_task,
)
from portal_backend.wake_scan_routes import (  # noqa: E402
    configure_compatibility as _configure_wake_scan,
)


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
    return _serve("dist/index.html")  # React SPA shell (open-orcha base; cloud pages via src/extensions.ts)


# Import the remaining route registry and retain modules with compatibility setup.
from portal_backend.route_registry import (  # noqa: E402
    agent_model_routes,
    agent_registration_routes,
    compatibility_export as _route_export,
    persona_protocol_routes,
    request_acceptance_routes,
    task_done_routes,
    task_verification_routes,
)


def __getattr__(name):
    """Resolve legacy facade exports from their cohesive owner modules."""
    if hasattr(_notification_taxonomy, name):
        return getattr(_notification_taxonomy, name)
    return _route_export(name)


def _publish_prompt(cur, container_id, agent_id, payload):
    return _publish_event(cur, container_id, agent_id, "prompt", payload)


_configure_attachment_compatibility(
    lambda: ATTACHMENTS_DIR, lambda: MAX_ATTACHMENT_BYTES
)
_configure_attachment_routes(lambda: MAX_ATTACHMENT_BYTES)
_configure_task_completion(lambda: _digest_curate)
_configure_agent_digest(_digest_curate)
_configure_agent_events(_publish_prompt)
_configure_lifecycle(lambda: run_migrations)
app.on_event("startup")(_startup_migrate)
app.on_event("startup")(_start_local_index_warmer)
_configure_active_conversations(lambda: _MODEL_IDS)
agent_registration_routes.configure_model_ids(lambda: _MODEL_IDS)
agent_model_routes.configure_catalogs(
    lambda: _MODEL_IDS,
    lambda: _REASONING_EFFORT_IDS,
    lambda: _REASONING_EFFORT_IDS_BY_MODEL,
)
persona_protocol_routes.configure_model_resolution(
    lambda model: resolve_model(model),
    lambda model: resolve_model_runtime(model),
)
task_done_routes.configure_compatibility(
    lambda: _complete_and_unblock,
    lambda: _backstop_stranded_request,
    lambda: _recalibrate_agent_digest_on_close,
)
task_verification_routes.configure_compatibility(lambda: _complete_and_unblock)
request_acceptance_routes.configure_compatibility(lambda: _attribute_token_run_to_task)
_configure_wake_scan(
    collect_directed_messages=_collect_directed_messages,
    earliest_actionable_answer_ts=_earliest_actionable_answer_ts,
    notification_manifest=_wake_notification_manifest,
    triage_hint_for=_triage_hint_for,
    resolve_model=resolve_model,
    resolve_model_runtime=resolve_model_runtime,
)

# Compatibility anchors: dynamic responses set ``Cache-Control: no-store`` in
# ``_no_store_dynamic_responses`` and static mounting is guarded by
# ``_STATIC_DIR.is_dir()``. Decision reason is optional on approve.
