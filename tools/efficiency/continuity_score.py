"""Score how faithfully a rendered wake prompt carries memory-digest facts."""
from __future__ import annotations

import math
import re

_FIELDS = ("current_focus", "decisions", "learnings", "open_threads")
_WORD = re.compile(r"[a-z0-9]+")


def _tokens(text: str) -> set[str]:
    """Return stable word tokens that ignore JSON escaping and field ordering."""
    return set(_WORD.findall((text or "").lower()))


def _fact_texts(digest: dict) -> list[tuple[str, str]]:
    """Flatten a digest into the atomic facts a wake must carry forward."""
    facts: list[tuple[str, str]] = []
    focus = (digest or {}).get("current_focus")
    if isinstance(focus, str) and focus.strip():
        facts.append(("current_focus", focus))
    for field in ("decisions", "learnings", "open_threads"):
        for item in (digest or {}).get(field) or []:
            if isinstance(item, dict):
                text = item.get("text") or item.get("ref") or ""
            else:
                text = str(item)
            if text and text.strip():
                facts.append((field, text))
    return facts


def _fact_recall(fact_text: str, boot_tokens: set[str]) -> float:
    """Return the fraction of one fact's tokens present in the rendered wake."""
    fact_tokens = _tokens(fact_text)
    if not fact_tokens:
        return 1.0
    return len(fact_tokens & boot_tokens) / len(fact_tokens)


def score_boot(digest: dict, boot_text: str | None) -> dict:
    """Return continuity recall and boot-size measurements for one rendered wake."""
    boot_text = boot_text or ""
    boot_tokens = _tokens(boot_text)
    facts = _fact_texts(digest)
    per_field: dict[str, dict] = {}
    recalls: list[float] = []
    for field in _FIELDS:
        field_recalls = [
            _fact_recall(text, boot_tokens)
            for fact_field, text in facts
            if fact_field == field
        ]
        if field_recalls:
            per_field[field] = {
                "facts": len(field_recalls),
                "recall": sum(field_recalls) / len(field_recalls),
            }
            recalls.extend(field_recalls)

    score = sum(recalls) / len(recalls) if recalls else 1.0
    chars = len(boot_text)
    return {
        "continuity_score": round(score, 4),
        "facts": len(facts),
        "per_field": per_field,
        "boot_chars": chars,
        "boot_tokens_est": math.ceil(chars / 4),
    }
