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

# llm_util is the SINGLE git source (orcha_cli/llm_util.py). The host daemon imports it as
# `orcha_cli.llm_util`; the portal container gets a top-level copy alongside main.py (see
# __main__._install_llm_util / _PORTAL_SHARED_MODULES), so `import llm_util` works there. Guarded both ways and
# bound to None if absent — the write-side dedup + the deterministic boot trim never need it,
# so curation degrades gracefully (the LLM summary just falls back to an honest breadcrumb).
try:  # host daemon
    from orcha_cli import llm_util as _llm_util  # type: ignore
except ImportError:  # portal container (top-level copy) or missing
    try:
        import llm_util as _llm_util  # type: ignore
    except ImportError:
        _llm_util = None  # type: ignore

# --- planned sizes (Kedar-approved #287 Q2: deliberately generous = conservative) ---
DEFAULT_KEEP = {"decisions": 15, "learnings": 15, "open_threads": 10}
CLIP_CHARS = 400                 # per-entry char clip (mirrors digest_synth._clip)
INJECTION_CEILING = 14_000       # hard byte backstop on the serialised lists+focus (12–16KB band)

_SUMMARY_MARK = ("[older context auto-summarised for brevity — machine-written, not the agent's "
                 "verbatim words; full history via GET /api/agents/{aid}/rehydrate]")

_LIST_FIELDS = ("decisions", "learnings", "open_threads")


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


# ---------------------------------------------------- completion recalibration (GH #35)
#
# A digest only ever ACCUMULATES: nothing trims it when the work it describes closes. So when a
# task finishes, the agent's latest digest still carries that task's "I still need to do X" open
# threads and its task-scoped decisions, and the NEXT wake rehydrates them as if they were live —
# the agent re-verifies finished work or reasons off a stale picture (GH #35, the write-side twin
# of the #33 read-side gap). `recalibrate_digest` prunes what the closed task closed out while
# preserving durable learnings, so the next rehydration starts clean.
#
# Conservative by design (per the issue): match a task by its id (full UUID or the conventional
# 8-char short form) or a distinctive title substring; drop task-scoped OPEN THREADS and DECISIONS;
# NEVER touch learnings (durable — they survive); and keep a still-pending human-verification thread
# when the task only reached needs_verification (agents must not self-certify). Pure + deterministic;
# the caller (main.py) persists the result as a NEW append-only snapshot, so the prior full digest
# stays in the agent_memory_digests history — this demotes, it never hard-deletes the record.

_TITLE_MATCH_MIN = 12   # only match on title when it's distinctive enough to avoid false positives

# Hints that an open thread referencing the just-closed task is about a STILL-pending human
# verification (kept when the task only reached needs_verification). Erring toward KEEPING is the
# safe side of the "never drop something still pending human verification" rule.
_VERIFY_HINTS = ("verif", "human", "sign-off", "signoff", "approv", "await", "pending", "kedar")


def _references_task(text: str, task_id: str, task_title: str) -> bool:
    """True when `text` names the closed task — by full UUID, its 8-char short form, or a
    distinctive (>= _TITLE_MATCH_MIN chars) title substring. Normalised (whitespace + case)."""
    n = _norm(text)
    if not n:
        return False
    tid = (task_id or "").strip().lower()
    if len(tid) >= 8 and tid[:8] in n:        # short form contains-check also catches the full UUID
        return True
    title = _norm(task_title or "")
    if len(title) >= _TITLE_MATCH_MIN and title in n:
        return True
    return False


def _is_verification_thread(text: str) -> bool:
    n = _norm(text)
    return any(h in n for h in _VERIFY_HINTS)


def _reset_focus(task_id: str, verification_pending: bool) -> str:
    short = (task_id or "")[:8]
    if verification_pending:
        return (f"Task {short} finished and handed off — awaiting human verification. Recalibrated: "
                f"pick the next focus from your live tasks / inbox on wake.")
    return (f"Task {short} closed. Recalibrated: pick the next focus from your live tasks / "
            f"inbox on wake.")


def recalibrate_digest(digest: dict, task_id: str, task_title: str, *,
                       verification_pending: bool, next_focus: Optional[str] = None) -> dict:
    """GH #35 completion recalibration. Return a NEW digest dict with the just-closed task's stale
    context pruned:

      * open_threads referencing the task are dropped — EXCEPT, when `verification_pending` is True
        (the task only reached needs_verification), a thread about the still-pending human
        verification is KEPT (agents must not self-certify).
      * decisions referencing the task (scoped to it) are dropped.
      * learnings are left completely untouched — durable knowledge survives the task that taught it.
      * current_focus is reset (to `next_focus`, else a neutral recalibrated marker) ONLY when it
        pointed at the closed task; an unrelated focus is left alone.

    Pure + deterministic; the input dict is never mutated. A non-dict input is returned unchanged."""
    if not isinstance(digest, dict):
        return digest
    out = dict(digest)

    threads = digest.get("open_threads")
    if isinstance(threads, list):
        kept = []
        for e in threads:
            if not _references_task(_entry_text(e), task_id, task_title):
                kept.append(e)                                  # unrelated thread — keep
            elif verification_pending and _is_verification_thread(_entry_text(e)):
                kept.append(e)                                  # still-pending human verify — keep
            # else: references the closed task and is not a live verify thread → prune
        out["open_threads"] = kept

    decisions = digest.get("decisions")
    if isinstance(decisions, list):
        out["decisions"] = [e for e in decisions
                            if not _references_task(_entry_text(e), task_id, task_title)]

    # learnings: deliberately untouched — they are the durable takeaways that must survive.

    focus = digest.get("current_focus")
    if isinstance(focus, str) and _references_task(focus, task_id, task_title):
        out["current_focus"] = next_focus or _reset_focus(task_id, verification_pending)

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


# ---------------------------------------------------------------- LLM summariser


_SUMMARY_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string",
                    "description": "One or two terse sentences capturing the gist of the older "
                                   "entries, in the agent's third-person voice. No invented detail."},
    },
    "required": ["summary"],
}

_SUMMARY_SYSTEM = (
    "You compress an autonomous software agent's OLDER memory-digest entries into one or two "
    "short sentences so they still fit inside a wake prompt. Preserve the substance — decisions "
    "made, lessons learned, threads left open — in the agent's own terse third-person voice. "
    "Do NOT invent anything that is not present in the entries. Be brief."
)


def _entries_to_text(entries: list) -> str:
    return "\n".join(f"- {_entry_text(e)}" for e in entries)


def llm_summarizer(field: str, tail: list) -> Optional[str]:
    """Default boot-copy summariser backed by llm_util (cheap model). Returns a one-line summary
    string, or None on any error / no client (the caller then uses the deterministic omission
    breadcrumb). NEVER raises — continuity must survive a flaky LLM."""
    if _llm_util is None or not tail:
        return None
    try:
        result = _llm_util.classify(
            "digest_summary",
            system=_SUMMARY_SYSTEM,
            user=f"Older '{field}' entries (oldest first):\n{_entries_to_text(tail)}",
            schema=_SUMMARY_SCHEMA,
        )
        s = (result or {}).get("summary")
        return s.strip() if isinstance(s, str) and s.strip() else None
    except Exception:
        return None
