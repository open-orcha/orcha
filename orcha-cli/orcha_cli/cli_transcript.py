"""Parse hook input and extract continuity evidence from Claude transcript files."""

from __future__ import annotations

import json
import pathlib
from typing import Iterator, Optional, TextIO


def read_hook_input(stream: Optional[TextIO]) -> dict:
    """Parse a hook payload from ``stream``, returning an empty mapping on failure."""
    try:
        if stream is None or stream.isatty():
            return {}
        raw = stream.read()
    except Exception:
        return {}
    if not raw or not raw.strip():
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def iter_records(transcript_path: Optional[str]) -> Iterator[dict]:
    """Yield valid JSON records from a transcript in chronological order."""
    if not transcript_path:
        return
    try:
        path = pathlib.Path(transcript_path)
        if not path.exists():
            return
        for line in path.read_text(errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except Exception:
                continue
            if isinstance(record, dict):
                yield record
    except Exception:
        return


def rich_digest_posted(
    transcript_path: Optional[str], agent_id: str
) -> bool:
    """Detect whether this session already posted a digest for ``agent_id``."""
    if not agent_id:
        return False
    needle = f"/agents/{agent_id}/digest"
    for record in iter_records(transcript_path):
        try:
            blob = json.dumps(record)
        except Exception:
            continue
        if needle in blob and "digest" in blob:
            return True
    return False


def last_assistant_text(transcript_path: Optional[str]) -> Optional[str]:
    """Return the final assistant text turn, condensed but otherwise untruncated."""
    last_text: Optional[str] = None
    for record in iter_records(transcript_path):
        if record.get("type") != "assistant" and record.get("role") != "assistant":
            continue
        message = (
            record.get("message")
            if isinstance(record.get("message"), dict)
            else record
        )
        content = message.get("content")
        text = None
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            parts = [
                block.get("text")
                for block in content
                if isinstance(block, dict)
                and block.get("type") == "text"
                and block.get("text")
            ]
            text = " ".join(parts).strip() or None
        if text:
            last_text = text
    if not last_text:
        return None
    return " ".join(last_text.split())


def focus_from_transcript(transcript_path: Optional[str]) -> Optional[str]:
    """Return a short, agent-authored focus line suitable for a fallback digest."""
    text = last_assistant_text(transcript_path)
    return text[:280] if text is not None else None
