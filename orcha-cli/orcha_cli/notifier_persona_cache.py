"""Cache and render per-agent wake persona context while keeping protocols fresh."""

from __future__ import annotations

import time
from typing import Any

from .notifier_persona import format_persona


def persona_and_digest(
    api_base: str,
    agent_id: str,
    *,
    force_fresh: bool,
    services: Any,
):
    """Fetch and curate persona context, reusing a short-lived successful result."""
    now = time.monotonic()
    if not force_fresh:
        cached = services._PERSONA_CACHE.get(agent_id)
        if cached is not None and now < cached[0]:
            return cached[1], cached[2]
    persona = services._get_json(f"{api_base}/api/agents/{agent_id}/persona")
    digest = services._get_json(f"{api_base}/api/agents/{agent_id}/digest")
    curator = services._digest_curate
    if curator is not None:
        digest = curator.curate_injected_digest(
            digest, summarizer=curator.llm_summarizer
        )
    if persona is not None and digest is not None:
        services._PERSONA_CACHE[agent_id] = (
            now + services._PERSONA_CACHE_TTL_SECS,
            persona,
            digest,
        )
    return persona, digest


def build_persona(
    api_base: str,
    agent_id: str,
    *,
    task_id: str | None,
    force_fresh: bool,
    lane: str,
    self_wake: dict | None,
    return_resume_rendered: bool,
    services: Any,
):
    """Render cached identity and digest with a freshly fetched task protocol."""
    persona, digest = services._persona_and_digest(
        api_base, agent_id, force_fresh=force_fresh
    )
    protocol_url = f"{api_base}/api/agents/{agent_id}/protocol"
    if task_id:
        protocol_url += f"?task_id={task_id}"
    protocol = services._get_json(protocol_url)
    render_resume = bool(
        self_wake
        and self_wake.get("injected")
        and task_id
        and task_id == self_wake.get("task_id")
    )
    resume_rendered = bool(
        render_resume and protocol and protocol.get("resume_context")
    )
    formatted = format_persona(
        persona,
        digest,
        protocol,
        lane=lane,
        render_resume=render_resume,
    )
    if return_resume_rendered:
        return formatted, resume_rendered
    return formatted
