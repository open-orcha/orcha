"""Detect and surface task-creation claims that did not persist in Orcha."""

from __future__ import annotations

import json
import pathlib
import re


_CLAIM_VERB = re.compile(
    r"\b(created|creating|spawned|spawning|started|starting|accepted|"
    r"in_progress|assigned to me)\b",
    re.IGNORECASE,
)
_ADJACENT_TASK_ID = re.compile(
    r"\btask(?:[\s_]id)?\b[\s:#=-]{0,3}"
    r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b",
    re.IGNORECASE,
)
_TERSE_STATUS_GAP = (
    r"[^\n]{0,60}(?:\n[ \t]{0,4}(?:[-*•]\s*)?[^\n]{0,60}){0,2}?"
)
_TERSE_TASK_STATUS = re.compile(
    r"\btask(?:[\s_]id)?\b[\s:#=-]{0,3}"
    r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b"
    rf"{_TERSE_STATUS_GAP}\bstatus\b\s*[:=]\s*"
    r"(?:ready|pending|in_progress)\b",
    re.IGNORECASE,
)
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+|\n+")
_BACKTICKS = re.compile("`+")


def extract_claimed_task_ids(text: str | None) -> list[str]:
    """Return deduplicated task IDs from creation or terse status claims."""
    if not text:
        return []
    found: list[str] = []
    seen: set[str] = set()
    normalized = _BACKTICKS.sub("", text)
    for match in _TERSE_TASK_STATUS.finditer(normalized):
        task_id = match.group(1).lower()
        if task_id not in seen:
            seen.add(task_id)
            found.append(task_id)
    for sentence in _SENTENCE_SPLIT.split(normalized):
        if not _CLAIM_VERB.search(sentence):
            continue
        for match in _ADJACENT_TASK_ID.finditer(sentence):
            task_id = match.group(1).lower()
            if task_id not in seen:
                seen.add(task_id)
                found.append(task_id)
    return found


def _flag_digest(services, api_base: str, agent_id: str, warning: str) -> None:
    """Carry continuity forward while making the failed claim the current focus."""
    prior: dict = {}
    try:
        result = services._get_json(
            f"{api_base}/api/agents/{agent_id}/digest", timeout=4.0
        )
        if isinstance(result, dict) and isinstance(result.get("digest"), dict):
            prior = result["digest"]
    except Exception:
        pass

    def carry(key: str) -> list:
        value = prior.get(key)
        return list(value) if isinstance(value, list) else []

    open_threads = carry("open_threads")
    flag = {"text": warning}
    if flag not in open_threads:
        open_threads.insert(0, flag)
    audience = prior.get("audience")
    body = {
        "current_focus": warning,
        "decisions": carry("decisions"),
        "learnings": carry("learnings"),
        "open_threads": open_threads,
        "audience": audience if isinstance(audience, str) and audience else None,
    }
    try:
        services._post_json(f"{api_base}/api/agents/{agent_id}/digest", body)
    except Exception:
        pass


def _flag_thread_or_escalate(
    services,
    api_base: str,
    container_id: str,
    agent_id: str,
    alias: str | None,
    listing: dict,
    warning: str,
) -> None:
    """Post to active work when possible, otherwise escalate to a human."""
    live_task_id = next(
        (
            task.get("id")
            for task in listing.get("tasks", [])
            if alias in task.get("assignees", [])
            and task.get("status") == "in_progress"
        ),
        None,
    )
    if live_task_id:
        try:
            services._post_json(
                f"{api_base}/api/tasks/{live_task_id}/messages",
                {"author_agent_id": agent_id, "body": warning},
            )
            return
        except Exception:
            pass
    try:
        services._post_json(
            f"{api_base}/api/containers/{container_id}/requests",
            {
                "requester_agent_id": agent_id,
                "payload": warning,
                "priority": 10,
                "type": "info",
            },
        )
    except Exception:
        pass


def _fetch_tasks(
    services,
    api_base: str,
    container_id: str,
    claimed_ids: list[str],
    *,
    max_pages: int = 50,
) -> dict | None:
    """Page until all claimed tasks are found or the task list is exhausted."""
    remaining = set(claimed_ids)
    all_tasks: list[dict] = []
    offset = 0
    for _ in range(max_pages):
        page = services._get_json(
            f"{api_base}/api/containers/{container_id}/tasks?"
            f"limit=100&offset={offset}",
            timeout=6.0,
        )
        if not isinstance(page, dict):
            return None
        tasks = page.get("tasks") or []
        all_tasks.extend(tasks)
        remaining -= {str(task.get("id") or "").lower() for task in tasks}
        if not remaining or not page.get("has_more") or not tasks:
            break
        offset += len(tasks)
    return {"tasks": all_tasks}


def task_claim_guard(args, services) -> None:
    """Audit the final assistant reply and loudly flag fabricated task claims."""
    try:
        transcript = services._read_hook_stdin().get("transcript_path")
        claimed = extract_claimed_task_ids(
            services._last_assistant_text_full(transcript)
        )
        if not claimed:
            return
        cwd = pathlib.Path.cwd()
        config_path = cwd / ".claude" / "orcha.json"
        if not config_path.exists():
            return
        api_base = json.loads(config_path.read_text()).get("api_base_url")
        binding = services._resolve_any_binding(cwd, getattr(args, "alias", None))
        if not api_base or not binding:
            return
        agent_id = binding.get("agent_id")
        container_id = binding.get("container_id")
        if not agent_id or not container_id:
            return
        listing = _fetch_tasks(
            services, api_base, container_id, claimed
        )
        if listing is None:
            return
        real_ids = {
            str(task.get("id") or "").lower()
            for task in listing.get("tasks", [])
        }
        missing = [task_id for task_id in claimed if task_id not in real_ids]
        if not missing:
            return
        warning = (
            f"⚠️ GH #152 HARD-FAIL: last session claimed task(s) "
            f"{', '.join(missing)} — NOT FOUND in the container's task list. "
            "That claim did not persist to the DB. Do not trust it; re-verify "
            "via the container task list before continuing or reporting it as real work."
        )
        print(f"[orcha] {warning}")
        _flag_digest(services, api_base, agent_id, warning)
        _flag_thread_or_escalate(
            services,
            api_base,
            container_id,
            agent_id,
            binding.get("alias"),
            listing,
            warning,
        )
    except Exception:
        return
