"""Remove completed-task context from an agent's latest memory digest.

The operation is conservative and pure: it preserves durable learnings and
never mutates or deletes the stored historical snapshot.
"""
from __future__ import annotations

import json
from typing import Optional

_TITLE_MATCH_MIN = 12
_VERIFY_HINTS = (
    "verif",
    "human",
    "sign-off",
    "signoff",
    "approv",
    "await",
    "pending",
    "kedar",
)


def _entry_text(entry) -> str:
    if isinstance(entry, dict):
        text = entry.get("text")
        if isinstance(text, str):
            return text
        return json.dumps(entry, ensure_ascii=False, sort_keys=True)
    return entry if isinstance(entry, str) else str(entry)


def _norm(text: str) -> str:
    return " ".join(text.split()).strip().lower()


def _references_task(text: str, task_id: str, task_title: str) -> bool:
    """Return whether text names the task by ID or a distinctive title."""
    normalized = _norm(text)
    if not normalized:
        return False
    task_id = (task_id or "").strip().lower()
    if len(task_id) >= 8 and task_id[:8] in normalized:
        return True
    title = _norm(task_title or "")
    return len(title) >= _TITLE_MATCH_MIN and title in normalized


def _is_verification_thread(text: str) -> bool:
    normalized = _norm(text)
    return any(hint in normalized for hint in _VERIFY_HINTS)


def _reset_focus(task_id: str, verification_pending: bool) -> str:
    short_id = (task_id or "")[:8]
    if verification_pending:
        return (
            f"Task {short_id} finished and handed off — awaiting human verification. "
            "Recalibrated: pick the next focus from your live tasks / inbox on wake."
        )
    return (
        f"Task {short_id} closed. Recalibrated: pick the next focus from your live tasks / "
        "inbox on wake."
    )


def recalibrate_digest(
    digest: dict,
    task_id: str,
    task_title: str,
    *,
    verification_pending: bool,
    next_focus: Optional[str] = None,
) -> dict:
    """Return a copy without stale decisions and open threads for a closed task."""
    if not isinstance(digest, dict):
        return digest
    output = dict(digest)

    threads = digest.get("open_threads")
    if isinstance(threads, list):
        output["open_threads"] = [
            entry
            for entry in threads
            if not _references_task(_entry_text(entry), task_id, task_title)
            or (
                verification_pending
                and _is_verification_thread(_entry_text(entry))
            )
        ]

    decisions = digest.get("decisions")
    if isinstance(decisions, list):
        output["decisions"] = [
            entry
            for entry in decisions
            if not _references_task(_entry_text(entry), task_id, task_title)
        ]

    focus = digest.get("current_focus")
    if (
        isinstance(focus, str)
        and _references_task(focus, task_id, task_title)
    ):
        output["current_focus"] = next_focus or _reset_focus(
            task_id, verification_pending
        )
    return output
