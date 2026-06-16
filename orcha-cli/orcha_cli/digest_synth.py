"""V2 — best-effort memory digest synthesised from a resident's recent turns.

This is the **PRE-KILL FALLBACK** for resident digest-on-end, NOT the primary path.

When an E3 resident session is reaped, Forge's notifier first drives ONE final
agent-authored turn ("run /orcha-snapshot") and awaits its result — that yields a RICH
digest the agent composed itself (it hits the existing C1 `POST /api/agents/{aid}/digest`).
Only when that drain turn times out (or the agent never produced a result) does the reaper
fall back to THIS function, PRE-kill, to capture *something* for continuity instead of
losing the session silently. Forge owns the notifier wiring; this is the only piece Vault
owns (the agreed seam, mirroring V1's `conversation_prefix`).

Honesty boundary (carried from Epic C): a machine CANNOT author the agent's reasoning, so
this never fabricates decisions/learnings. It mechanically captures the *shape* of where the
session was — what was last being worked on, and any unanswered human message — and marks
every field as auto-synthesised so a reader (or the agent, on rehydrate) knows it's partial.

Pure (no I/O), deterministic: same `turns` in → same dict out. The returned dict matches the
C1 `DigestSnapshot` model exactly ({current_focus, decisions, learnings, open_threads}); Forge
POSTs it verbatim to the existing /digest endpoint — no new API/DB surface.
"""

# How many trailing turns to consider, and content caps (keep the digest compact and the
# snapshot row small; resident transcripts can be large). FOCUS_CHARS is the TOTAL budget for
# current_focus (marker included); THREAD_CHARS bounds the quoted message in a loose-end thread.
MAX_RECENT_TURNS = 12
FOCUS_CHARS = 240
THREAD_CHARS = 240

_MARK = "[auto-synthesised on reap — the agent was killed before it could compose its own]"
_ROLE = {"human": "human", "agent": "agent"}


def _clean(turn) -> tuple:
    """(role, content) with content stripped; ('', '') for an empty/garbage turn."""
    if not isinstance(turn, dict):
        return "", ""
    role = _ROLE.get(turn.get("role"), str(turn.get("role") or ""))
    return role, (turn.get("content") or "").strip()


def _clip(text: str, n: int) -> str:
    text = " ".join(text.split())          # collapse whitespace → stable one-liner
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def synthesize_digest(turns, *, max_recent: int = MAX_RECENT_TURNS,
                      focus_chars: int = FOCUS_CHARS,
                      thread_chars: int = THREAD_CHARS) -> dict:
    """Mechanical fallback digest from a resident's recent conversation turns.

    `turns`: ordered (oldest→newest) list of {"role": "human"|"agent", "content": str}.
    Tolerates None / [] / empty-content / non-dict entries. Returns a dict with the C1
    digest keys; `decisions` and `learnings` are ALWAYS empty (reasoning isn't derivable),
    `open_threads` carries the last unanswered human turn (if any) plus a marker thread, and
    `current_focus` summarises the last activity. Empty input → an honest empty-but-marked
    digest (so even a zero-turn reap leaves a continuity breadcrumb).
    """
    kept = [(r, c) for r, c in (_clean(t) for t in (turns or [])) if c]
    kept = kept[-max_recent:]

    open_threads = [{"text": f"{_MARK} Resident session ended (reaped); continuity below is partial."}]

    if not kept:
        return {
            "current_focus": f"{_MARK} Session reaped with no recorded turns.",
            "decisions": [],
            "learnings": [],
            "open_threads": open_threads,
        }

    last_role, last_content = kept[-1]
    if last_role == "human":
        # The agent never replied to the final human turn → a real loose end to resume.
        focus = f"{_MARK} Was mid-reply to the human."
        open_threads.append(
            {"text": "Unanswered human message at reap: " + _clip(last_content, thread_chars)}
        )
    else:
        focus = f"{_MARK} Last worked on: {last_content}"

    return {
        "current_focus": _clip(focus, focus_chars),
        "decisions": [],
        "learnings": [],
        "open_threads": open_threads,
    }
