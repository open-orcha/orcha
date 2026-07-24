"""Summarize older digest entries for compact wake prompts.

The deterministic curation policy lives in :mod:`digest_curate`; this module owns
the optional LLM boundary so curation remains usable when no provider is present.
"""
from __future__ import annotations

import json
from typing import Optional

try:
    from orcha_cli import llm_util as _llm_util  # type: ignore
except ImportError:  # portal container: shared modules are copied beside main.py
    try:
        import llm_util as _llm_util  # type: ignore
    except ImportError:
        _llm_util = None  # type: ignore

_SUMMARY_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {
            "type": "string",
            "description": (
                "One or two terse sentences capturing the gist of the older "
                "entries, in the agent's third-person voice. No invented detail."
            ),
        },
    },
    "required": ["summary"],
}

_SUMMARY_SYSTEM = (
    "You compress an autonomous software agent's OLDER memory-digest entries into one or two "
    "short sentences so they still fit inside a wake prompt. Preserve the substance — decisions "
    "made, lessons learned, threads left open — in the agent's own terse third-person voice. "
    "Do NOT invent anything that is not present in the entries. Be brief."
)


def _entry_text(entry) -> str:
    """Return stable text for either supported digest-entry representation."""
    if isinstance(entry, dict):
        text = entry.get("text")
        if isinstance(text, str):
            return text
        return json.dumps(entry, ensure_ascii=False, sort_keys=True)
    return entry if isinstance(entry, str) else str(entry)


def _entries_to_text(entries: list) -> str:
    return "\n".join(f"- {_entry_text(entry)}" for entry in entries)


def summarize_with_client(client, field: str, tail: list) -> Optional[str]:
    """Return a brief summary using the supplied provider client."""
    if client is None or not tail:
        return None
    try:
        result = client.classify(
            "digest_summary",
            system=_SUMMARY_SYSTEM,
            user=f"Older '{field}' entries (oldest first):\n{_entries_to_text(tail)}",
            schema=_SUMMARY_SCHEMA,
        )
        summary = (result or {}).get("summary")
        return summary.strip() if isinstance(summary, str) and summary.strip() else None
    except Exception:
        return None


def llm_summarizer(field: str, tail: list) -> Optional[str]:
    """Return a brief provider-backed summary, or ``None`` on any failure."""
    return summarize_with_client(_llm_util, field, tail)
