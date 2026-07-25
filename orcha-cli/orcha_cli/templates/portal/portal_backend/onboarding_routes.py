"""Streaming FastAPI route for editable onboarding roster proposals."""

import logging
import queue
import threading
import time

from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import (
    require_container as _require_container,
)
from portal_backend.guards import (
    valid_uuid as _valid_uuid,
)
from portal_backend.model_setting_routes import _resolve_use_case_model
from portal_backend.onboarding_normalization import _normalize_roster_payload
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
from portal_backend.provider_keys import provider_api_key as _provider_api_key
from portal_backend.schemas import ProposeBody

try:
    import llm_util
except ImportError:
    from orcha_cli import llm_util

ONBOARDING_LOG = logging.getLogger("orcha.onboarding")

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
            _propose_error(
                "invalid_goal", "Describe what you want this workspace to do first."
            ),
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
    tools = (
        [_propose_roster_tool_schema()]
        if force_roster
        else [_ASK_CLARIFY_TOOL, _propose_roster_tool_schema()]
    )
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

            clarify = (
                None
                if force_roster
                else llm_util.collect_tool_call(events, "ask_clarifying_questions")
            )
            if clarify:
                questions = []
                for i, q in enumerate(
                    (clarify.get("input") or {}).get("questions") or []
                ):
                    if not isinstance(q, dict):
                        continue
                    prompt = str(q.get("prompt") or "").strip()
                    if prompt:
                        questions.append(
                            {
                                "id": str(q.get("id") or f"q{i + 1}"),
                                "prompt": prompt[:300],
                            }
                        )
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
                    force_roster,
                    diag.get("stop_reason"),
                    diag.get("output_tokens"),
                    diag.get("started"),
                    diag.get("completed"),
                    diag.get("json_error"),
                )
                if _propose_roster_was_truncated(force_roster, diag):
                    yield from _propose_error(
                        "roster_truncated",
                        "The roster proposal hit the model output limit before it finished. Narrow the first roster in the goal, then try again, or set it up by hand.",
                    )
                    return
                yield from _propose_error(
                    "model_error", "The model did not return a roster proposal."
                )
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
            code = (
                "rate_limited"
                if "rate" in msg.lower() or "429" in msg
                else "model_error"
            )
            yield from _propose_error(code, msg[:300])

    return StreamingResponse(gen(), media_type="text/event-stream")
