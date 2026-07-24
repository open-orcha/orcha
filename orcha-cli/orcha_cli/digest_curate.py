"""#287 — memory-digest curation (write-side dedup + boot-copy trim + LLM tail-summary).

A long-lived agent's single latest digest accretes decisions/learnings/open_threads
append-only (main.py `POST /api/agents/{aid}/digest`), and ONLY that latest row is injected
verbatim into every wake (notifier.format_persona). So a long agent life makes per-wake boot
cost grow without bound — exactly the #284 boot overhead the efficiency meter measures. This
module curates that cost down at two seams, both honesty-preserving:

  WRITE  (main.py post_digest): `dedup_digest()` collapses EXACT duplicate entries and drops
         empty ones before the row is stored. Pure compaction — it removes only provably
         redundant bytes (a literal duplicate carries no new information); it never edits the
         agent's wording. The stored row stays the agent's own record.

  BOOT   (notifier._build_persona): `curate_injected_digest()` curates the INJECTED copy only —
         dedup, per-entry char clip, per-list recency cap, overall byte ceiling — then folds the
         dropped OLDER tail into ONE clearly-marked summary entry: an LLM summary when a
         summariser is wired (`llm_summarizer`), else a deterministic "N older items omitted"
         breadcrumb. The stored DB row is left FULL and verbatim: the server never rewrites
         reasoning into the agent's record (Epic C honesty boundary, docs/epic-c-agent-digest-plan.md).
         Caps can be widened or the whole layer reverted with no migration and no lost history.

Ordering note: the per-list recency cap keeps the LAST N entries, treating each list as
chronological oldest→newest (the append convention digest_synth.py also follows). Because the
dropped tail is *summarised* rather than discarded, this assumption only changes which entries
stay verbatim vs. summarised — no entry's substance is lost even if a digest were authored
newest-first, and the full row remains readable via GET /api/agents/{aid}/rehydrate.

Pure + deterministic (same input → same output) except the optional injected summariser, which
is passed in so unit tests exercise the deterministic path with no network and no live key.
"""
from __future__ import annotations

import json
from typing import Callable, Optional

try:
    from orcha_cli.digest_recalibrate import recalibrate_digest
    from orcha_cli.digest_summary import (
        _llm_util,
        summarize_with_client as _summarize_with_client,
    )
except ImportError:  # portal container: shared modules are copied beside main.py
    from digest_recalibrate import recalibrate_digest  # type: ignore
    from digest_summary import (  # type: ignore
        _llm_util,
        summarize_with_client as _summarize_with_client,
    )

# --- planned sizes (Kedar-approved #287 Q2: deliberately generous = conservative) ---
DEFAULT_KEEP = {"decisions": 15, "learnings": 15, "open_threads": 10}
CLIP_CHARS = 400                 # per-entry char clip (mirrors digest_synth._clip)
INJECTION_CEILING = 14_000       # hard byte backstop on the serialised lists+focus (12–16KB band)

_SUMMARY_MARK = ("[older context auto-summarised for brevity — machine-written, not the agent's "
                 "verbatim words; full history via GET /api/agents/{aid}/rehydrate]")

_LIST_FIELDS = ("decisions", "learnings", "open_threads")


def llm_summarizer(field: str, tail: list) -> Optional[str]:
    """Compatibility seam for callers that replace this module's LLM client."""
    return _summarize_with_client(_llm_util, field, tail)


# ------------------------------------------------------------------- entry helpers


def _entry_text(entry) -> str:
    """The text used for dedup/clip. Entries are `{text, ...}` dicts or bare strings (the
    DigestSnapshot convention); anything else is stably serialised so it still dedups."""
    if isinstance(entry, dict):
        t = entry.get("text")
        if isinstance(t, str):
            return t
        return json.dumps(entry, ensure_ascii=False, sort_keys=True)
    if isinstance(entry, str):
        return entry
    return str(entry)


def _norm(text: str) -> str:
    """Normalised dedup key: collapse whitespace + casefold so trivial variants collapse."""
    return " ".join(text.split()).strip().lower()


def _clip_text(text: str, n: int) -> str:
    text = " ".join(text.split())            # collapse whitespace → stable one-liner
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def _clip_entry(entry, n: int):
    """Clip an entry's text to `n` chars, preserving its shape (dict→dict, str→str)."""
    if isinstance(entry, dict) and isinstance(entry.get("text"), str):
        e = dict(entry)
        e["text"] = _clip_text(entry["text"], n)
        return e
    if isinstance(entry, str):
        return _clip_text(entry, n)
    return entry


def _dedup(items: list) -> list:
    """Drop empty entries and collapse EXACT (normalised) duplicates, keeping the most-recent
    occurrence and the original oldest→newest order. Pure, zero semantic loss."""
    seen: set = set()
    out: list = []
    for entry in reversed(items):            # walk newest→oldest so the most-recent dup wins
        key = _norm(_entry_text(entry))
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(entry)
    out.reverse()                            # restore oldest→newest
    return out


# --------------------------------------------------------------- write-side (Tier-0)


def dedup_digest(digest: dict) -> dict:
    """WRITE seam: Tier-0 compaction for the STORED row — drop empties + collapse exact dups.

    Pure, zero semantic loss, never edits wording (a literal duplicate carries no new info).
    Returns a NEW dict; the input is untouched. current_focus is left exactly as the agent
    wrote it (already capped at MAX_PAYLOAD_LEN by the model)."""
    if not isinstance(digest, dict):
        return digest
    out = dict(digest)
    for field in _LIST_FIELDS:
        v = digest.get(field)
        if isinstance(v, list):
            out[field] = _dedup(v)
    return out


# ------------------------------------------------------------- boot-copy (injection)


def _summarise_tail(field: str, tail: list, summarizer: Optional[Callable]) -> Optional[dict]:
    """Fold a dropped older `tail` into ONE marked summary entry. Uses `summarizer(field, tail)`
    when supplied (LLM); on None/failure falls back to a deterministic, honest omission
    breadcrumb. Returns None only for an empty tail."""
    if not tail:
        return None
    text: Optional[str] = None
    if summarizer is not None:
        try:
            raw = summarizer(field, tail)
            text = raw.strip() if isinstance(raw, str) else None
        except Exception:
            text = None                      # fail-safe: never let a flaky LLM drop continuity
    if text:
        return {"text": f"{_SUMMARY_MARK} {field}: {text}".strip()}
    n = len(tail)
    return {"text": f"[{n} older {field} entr{'y' if n == 1 else 'ies'} omitted to save space — "
                    f"full history in the agent's snapshot record]"}


def _serialised_size(d: dict) -> int:
    total = len(d.get("current_focus") or "")
    for field in _LIST_FIELDS:
        v = d.get(field)
        if v:
            total += len(json.dumps(v, ensure_ascii=False))
    return total


def _enforce_ceiling(out: dict, ceiling: int, has_summary: dict) -> None:
    """Hard byte backstop: while the serialised digest exceeds `ceiling`, drop the oldest
    real entry from the currently-largest list. A leading auto-summary (index 0) and at least
    one verbatim entry per non-empty list are always preserved, so a field never empties."""
    while _serialised_size(out) > ceiling:
        target, best = None, 0
        for field in _LIST_FIELDS:
            v = out.get(field)
            floor = 2 if has_summary.get(field) else 1   # keep summary + ≥1 real entry
            if isinstance(v, list) and len(v) > floor:
                sz = len(json.dumps(v, ensure_ascii=False))
                if sz > best:
                    best, target = sz, field
        if target is None:
            break                            # can't shrink further without emptying a field
        v = out[target]
        drop_at = 1 if has_summary.get(target) else 0    # drop oldest real entry, keep any summary
        out[target] = v[:drop_at] + v[drop_at + 1:]


def curate_inner(inner: dict, *, keep: Optional[dict] = None,
                 summarizer: Optional[Callable] = None,
                 ceiling: int = INJECTION_CEILING) -> dict:
    """Curate the inner digest dict ({current_focus, decisions, learnings, open_threads}) for
    wake injection: dedup → per-entry clip → per-list recency cap (older tail → one summary
    entry) → byte ceiling. Returns a NEW dict; the input is untouched."""
    if not isinstance(inner, dict):
        return inner
    keep = {**DEFAULT_KEEP, **(keep or {})}
    out = dict(inner)
    has_summary: dict = {}
    for field in _LIST_FIELDS:
        v = inner.get(field)
        if not isinstance(v, list):
            continue
        items = [_clip_entry(e, CLIP_CHARS) for e in _dedup(v)]
        k = keep.get(field, len(items))
        if len(items) > k:
            tail, recent = items[:-k], items[-k:]
            summary = _summarise_tail(field, tail, summarizer)
            if summary is not None:
                items = [summary] + recent
                has_summary[field] = True
            else:
                items = recent
        out[field] = items
    _enforce_ceiling(out, ceiling, has_summary)
    return out


def curate_injected_digest(envelope, *, summarizer: Optional[Callable] = None) -> dict:
    """BOOT seam: curate the `{"digest": {...}|null}` envelope GET /digest returns, for wake
    injection. Passes the envelope through unchanged when there's no digest. The stored row is
    NOT touched — this shapes only the copy notifier injects."""
    if not isinstance(envelope, dict):
        return envelope
    inner = envelope.get("digest")
    if not isinstance(inner, dict):
        return envelope
    out = dict(envelope)
    out["digest"] = curate_inner(inner, summarizer=summarizer)
    return out
