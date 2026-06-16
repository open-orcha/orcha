"""#247 item-3 — cold-boot conversation-history CURATION (sliding-window LLM summarization).

When a resident COLD-boots, the notifier injects the resolved conversation turns as a history
block via ``conversation_prefix.format_conversation_history`` — a MECHANICAL oldest-first drop
capped at ``MAX_HISTORY_TURNS`` / ``HISTORY_CHAR_BUDGET``. For a long conversation that drop
silently discards the OLDEST whole turns — losing early context (the original ask, a decision
made 30 turns ago) the agent still needs to resume coherently.

This module curates instead. When the raw history is large (over ``CURATION_CHAR_THRESHOLD``),
keep the most-recent ``CURATION_RECENT_TURNS`` turns VERBATIM and summarize everything OLDER
into ONE synthetic "summary of earlier conversation" turn via the #290 universal LLM client
('curation' use-case = Sonnet). The agent then boots with a compact summary of old context +
the recent turns intact, at a fraction of the tokens the full transcript would cost — and
without the wholesale loss the mechanical drop causes.

Boundaries (all ruled in #247 / by Helm on this task's plan):

  * **COLD full-spawn only.** The notifier injects history ONLY on a cold resident boot (a warm
    ``--resume`` rehydrates the session's own message history; ephemeral one-shot wakes carry
    persona+digest, no history). So this is naturally the "T3 full spawn" path — no tier signal
    is needed here; the seam itself is the gate.
  * **FAIL-OPEN, ABSOLUTE.** Any curation / LLM / timeout / import error falls back to today's
    mechanical ``conversation_prefix`` drop and NEVER raises / blocks the spawn (Helm hard
    requirement; #247 ruling-3). ``curate_history`` is total — it cannot raise.
  * **HISTORY-ONLY (v1).** The memory digest is already a curated snapshot; the raw history
    turns are the bloat (Helm Q2). Digest curation is a separate, later concern.
  * **Zero routes / DB / OpenAPI delta.** Pure runtime infra, a sibling of
    ``conversation_prefix`` / ``digest_synth`` — host-daemon only (the notifier imports it), so
    it is NOT one of the portal-copied shared modules.

Latency note: curation adds ONE bounded LLM call to a cold boot, and only when history exceeds
the threshold (large, infrequent T3 spawns). It is a deliberate trade — a one-time summarize to
make the boot CHEAPER (far fewer history tokens) and the agent BETTER-oriented (old context kept
as a summary instead of dropped). The call is timeout-bounded; on timeout we fail-open to the
mechanical block, so a slow LLM degrades to today's behaviour rather than stalling the boot.

The thresholds are module-level NAMED constants so #294 can surface them as tunables later
(Helm Q3). The summarizer + mechanical fallback are injectable so tests run with a fake provider
and no network / no live key.
"""

from __future__ import annotations

import logging
from typing import Callable, Optional

log = logging.getLogger("orcha.curation")

# The mechanical formatter trims OLDEST-first once the rendered block exceeds its char budget.
# Derive that budget from conversation_prefix (single source of truth) so the curation threshold
# below CANNOT drift above it. Optional import → safe literal fallback if the module is absent.
try:
    from orcha_cli.conversation_prefix import HISTORY_CHAR_BUDGET as _MECHANICAL_CHAR_BUDGET
except Exception:                       # pragma: no cover - module always ships in practice
    _MECHANICAL_CHAR_BUDGET = 8000

# --- tunable v1 defaults (NAMED constants so #294 can expose them later; Helm Q3) ----------
# The RENDERED-block char budget the curation gate inherits from the mechanical formatter. The
# gate engages curation iff the mechanical render would be LOSSY at this budget — measured on the
# *rendered* length (header + role labels + separators), NOT a raw content sum. MUST be <= the
# mechanical budget: a threshold ABOVE it would leave a band where the mechanical formatter
# silently oldest-DROPS turns before curation engages (Gate #321 2nd-pass — first the 8000-12000
# content band, then the narrower rendering-overhead band: content_sum <= budget < rendered_len).
# Pinned to the mechanical budget so curation ALWAYS engages the instant mechanical would drop.
CURATION_CHAR_THRESHOLD = _MECHANICAL_CHAR_BUDGET
# Keep this many most-recent turns VERBATIM; everything older is summarized into one turn.
CURATION_RECENT_TURNS = 8
# Defensive per-turn cap on the verbatim recent turns so a single pasted log / tool dump can't
# blow the cold-boot prompt. Deterministic (stable marker) → keeps the prefix cache-stable.
RECENT_TURN_CHAR_CAP = 2000

# Mirrors conversation_prefix's labels: the agent reads its OWN prior turns as "You", the person
# it is talking to as "Human". Replicated (not imported) to avoid coupling to a private symbol.
_ROLE_LABEL = {"human": "Human", "agent": "You"}
_TRUNC_MARK = "\n…[truncated to fit the prompt-cache budget]"

_CURATED_HEADER = (
    "## Conversation so far (curated — your earlier turns with the human are summarized first, "
    "then your most-recent turns verbatim, oldest first; continue from the newest message that "
    "follows via your input):"
)
_SUMMARY_LABEL = "[Summary of earlier conversation]"

# Header for the "kept all verbatim" branch (over budget but too few turns to summarize a tail):
# honest — no "summarized" claim, since nothing was summarized.
_RECENT_ONLY_HEADER = (
    "## Conversation so far (your recent turns with the human, oldest first; continue from the "
    "newest message that follows via your input):"
)

_CURATION_SYSTEM = (
    "You compress the EARLIER part of an ongoing conversation between an autonomous agent "
    "('You') and a human ('Human') into a brief, factual summary so the agent can resume with "
    "the old context WITHOUT re-reading every turn. PRESERVE: the original ask/goal, any "
    "decisions or commitments made, still-unanswered questions, and the current task state. "
    "DISCARD: greetings, acknowledgements, and verbose tool output. Write 3-8 terse sentences "
    "describing what happened so far. Do not invent anything that is not in the text."
)

_CURATION_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {
            "type": "string",
            "description": "A 3-8 sentence factual summary of the earlier conversation turns, "
                           "preserving the goal, decisions, open questions, and task state.",
        },
    },
    "required": ["summary"],
}


def _content(turn) -> str:
    return (turn.get("content") or "").strip() if isinstance(turn, dict) else ""


def _clean(turns) -> list:
    """Drop None / non-dict / empty-content turns, preserving order (oldest→newest)."""
    return [t for t in (turns or []) if isinstance(t, dict) and _content(t)]


def _line(turn, *, cap: int = RECENT_TURN_CHAR_CAP) -> str:
    role = _ROLE_LABEL.get(turn.get("role"), str(turn.get("role") or "?"))
    content = _content(turn)
    if len(content) > cap:
        content = content[:cap].rstrip() + _TRUNC_MARK
    return f"{role}: {content}"


def _transcript_for_summary(turns) -> str:
    """Plain oldest→newest transcript of the OLDER turns, fed to the summarizer as the user
    message. Not cache-sensitive (consumed by the LLM, not injected) — no per-turn cap here."""
    return "\n\n".join(
        f"{_ROLE_LABEL.get(t.get('role'), '?')}: {_content(t)}" for t in turns
    )


def _render_curated(summary: str, recent_turns: list) -> str:
    recent_block = "\n\n".join(_line(t) for t in recent_turns)
    return f"{_CURATED_HEADER}\n\n{_SUMMARY_LABEL}\n{summary}\n\n{recent_block}"


def _render_recent_only(turns) -> str:
    """All turns kept verbatim (each per-turn capped & deterministic) under a plain header. Used
    when the history is over budget but has too few turns to split off a summarizable tail: this
    bounds size via the per-turn cap WITHOUT the mechanical oldest-DROP, so no whole turn is ever
    silently lost (honors the 'no mechanical drop without curation' invariant)."""
    return f"{_RECENT_ONLY_HEADER}\n\n" + "\n\n".join(_line(t) for t in turns)


def _mechanical_would_drop(turns, *, char_budget: int = CURATION_CHAR_THRESHOLD) -> bool:
    """Whether the mechanical formatter would DROP a whole turn or TRUNCATE content for ``turns``
    (i.e. the cheap path would lose information). This is the curation gate — delegated to
    ``conversation_prefix.would_truncate`` so it is judged by the formatter's OWN render path
    (rendered length + the ``max_turns`` cap), the single source of truth. A raw content sum was
    wrong: it ignored header/role/separator overhead, so content could fit the budget while the
    rendered block did not — a silent-drop band (Gate #321 2nd-pass P1).

    Defensive: if ``conversation_prefix`` is somehow unimportable (then ``_default_mechanical``
    yields '' anyway), fall back to a conservative content-sum estimate rather than raising."""
    try:
        from orcha_cli.conversation_prefix import would_truncate
    except Exception:                       # pragma: no cover - module always ships in practice
        return sum(len(_content(t)) for t in turns) > char_budget
    return would_truncate(turns, char_budget=char_budget)


def _default_mechanical(turns) -> str:
    """Today's mechanical oldest-first drop (the fail-open fallback). Imported lazily so this
    module stays importable even if conversation_prefix is somehow absent (→ '')."""
    try:
        from orcha_cli.conversation_prefix import format_conversation_history
    except Exception:
        return ""
    return format_conversation_history(turns) or ""


def _default_summarize(older_turns) -> str:
    """Summarize the older turns into one paragraph via the #290 universal client ('curation'
    use-case = Sonnet, forced-tool JSON). Raises on any LLM error — ``curate_history`` catches
    it and fails open. Imported lazily (mirrors notifier's optional-import pattern)."""
    from orcha_cli import llm_util
    result = llm_util.classify(
        "curation",
        system=_CURATION_SYSTEM,
        user=_transcript_for_summary(older_turns),
        schema=_CURATION_SCHEMA,
    )
    return str((result or {}).get("summary", ""))


def curate_history(
    turns,
    *,
    threshold_chars: int = CURATION_CHAR_THRESHOLD,
    recent_turns: int = CURATION_RECENT_TURNS,
    summarize: Optional[Callable[[list], str]] = None,
    mechanical: Optional[Callable[[list], str]] = None,
) -> str:
    """Curate the cold-boot history block for ``turns`` (oldest→newest), or ''.

    When the mechanical formatter would render every turn losslessly (nothing dropped or
    truncated) → the mechanical block verbatim, ZERO LLM call. When it would be LOSSY → keep the
    most-recent ``recent_turns`` verbatim and summarize the older turns into one synthetic turn
    via ``summarize`` (the #290 client by default). The cheap-path decision is made by the
    formatter's OWN render math (``_mechanical_would_drop``), so curation engages the instant the
    mechanical drop would silently lose a turn — no content-vs-rendered band (Gate #321 P1).

    TOTAL — never raises. Any failure (LLM/timeout/empty summary/bug) falls back to the
    mechanical drop, and if even that fails, ''. This is the ABSOLUTE fail-open contract: a
    boot must never be blocked or crashed by curation (#247 ruling-3 / Helm).
    """
    mech = mechanical or _default_mechanical
    try:
        cleaned = _clean(turns)
        if not cleaned:
            return ""
        # Cheap path ONLY when the mechanical render is lossless — it would neither drop a whole
        # turn nor truncate content at this budget. Judged on the RENDERED block (header + role
        # labels + separators) + the max-turns cap via conversation_prefix, NOT a raw content sum
        # (which left a silent-drop band: content_sum <= budget < rendered_len). ``threshold_chars``
        # is the rendered budget, pinned <= the mechanical budget so curation never engages LATER
        # than the mechanical drop (test_threshold_aligned guards this).
        if not _mechanical_would_drop(cleaned, char_budget=threshold_chars):
            return mech(cleaned)
        recent = cleaned[-recent_turns:]
        older = cleaned[:-recent_turns]
        if not older:
            # Over budget, but too few turns (<= recent_turns) to split off a summarizable tail.
            # Do NOT hand this to the mechanical drop — it would silently drop the oldest WHOLE
            # turns with no summary. Keep every turn verbatim (per-turn capped) instead.
            return _render_recent_only(cleaned)
        try:
            summary = (summarize or _default_summarize)(older)
        except Exception as e:  # LLM/transport/timeout — fail open
            log.info("curation fail-open (summarize error): %s", e)
            return mech(cleaned)
        summary = (summary or "").strip()
        if not summary:
            log.info("curation fail-open (empty summary)")
            return mech(cleaned)
        return _render_curated(summary, recent)
    except Exception as e:  # defensive: nothing here may escape and block a boot
        log.info("curation fail-open (unexpected): %s", e)
        try:
            return mech(turns)
        except Exception:
            return ""
