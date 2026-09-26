"""Persist a best-effort continuity digest when an Orcha-managed session exits."""
# ruff: noqa: BLE001

from __future__ import annotations

import json
import os
import pathlib
from typing import Any


def snapshot_command(args: Any, services: Any) -> None:
    """Write a thin fallback digest without shadowing richer session-authored context."""
    if not (os.environ.get("ORCHA_HEADLESS_WORKER") or os.environ.get("ORCHA_LIVE")):
        return
    try:
        payload = services._read_hook_stdin()
        transcript_path = payload.get("transcript_path")
        cwd = pathlib.Path.cwd()
        config_path = cwd / ".claude" / "orcha.json"
        if not config_path.exists():
            return
        api_base = json.loads(config_path.read_text()).get("api_base_url")
        if not api_base:
            return
        binding = services._resolve_any_binding(cwd, getattr(args, "alias", None))
        if not binding:
            return
        agent_id = binding.get("agent_id")
        alias = binding.get("alias") or agent_id
        if not agent_id:
            return
        if services._rich_digest_posted_this_session(transcript_path, agent_id):
            print(
                f"[orcha] snapshot: {alias} already authored a digest this "
                "session — skipping fallback"
            )
            return

        embodiment = (
            "Live terminal session"
            if os.environ.get("ORCHA_LIVE")
            else "Headless wake worker"
        )
        focus = services._focus_from_transcript(transcript_path) or (
            f"{embodiment} exited without an explicit /orcha-snapshot this session."
        )
        prior: dict = {}
        try:
            got = services._get_json(
                f"{api_base}/api/agents/{agent_id}/digest", timeout=4.0
            )
            if isinstance(got, dict) and isinstance(got.get("digest"), dict):
                prior = got["digest"]
        except Exception:
            prior = {}

        def carry(key: str) -> list:
            value = prior.get(key)
            return list(value) if isinstance(value, list) else []

        prior_audience = prior.get("audience")
        audience = (
            prior_audience
            if isinstance(prior_audience, str) and prior_audience
            else None
        )
        resume_hint = {
            "text": "Resume: re-read the assigned task thread; this wake ended "
            "without a detailed self-snapshot."
        }
        open_threads = carry("open_threads")
        if resume_hint not in open_threads:
            open_threads.append(resume_hint)
        body = {
            "current_focus": focus,
            "decisions": carry("decisions"),
            "learnings": carry("learnings"),
            "open_threads": open_threads,
            "audience": audience,
        }
        try:
            services._post_json(f"{api_base}/api/agents/{agent_id}/digest", body)
            print(
                f"[orcha] snapshot: continuity digest written for {alias} "
                "(write-on-exit)"
            )
        except Exception:
            return
    except Exception:
        # Session-end hooks must never disrupt teardown.
        return
