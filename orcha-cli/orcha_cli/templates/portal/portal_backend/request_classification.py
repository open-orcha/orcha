"""Conservatively distinguish delegated work from information requests."""

import re
from typing import Optional

# ---------- requests (Phase 2 — info type only) ----------

# GH #71: requests default to type='info', but real work (review / sign-off / docs / coding)
# routed as 'info' silently skips the task wake path — a missed-wake incident. This shared,
# PURE classifier is the server-side BACKSTOP: when a caller sends type='info' with no task
# object, create_request runs it and AUTO-PROMOTES the request to type='task' if the payload
# clearly *asks for work*. It is intentionally conservative — a false promotion (info that
# becomes a task) is worse than a false negative (work that stays info), so the verb set is
# curated, not speculative, and an interrogative phrasing always wins (stays info).
#
# Curated WORK_VERBS only (do NOT expand speculatively). Multi-word forms ("sign off",
# "sign-off") are matched separately below.
WORK_VERBS = frozenset(
    {
        "review",
        "approve",
        "implement",
        "write",
        "code",
        "build",
        "fix",
        "document",
        "draft",
        "create",
        "refactor",
        "test",
        "add",
    }
)
# Leading question words / auxiliaries — if the payload OPENS with one of these it is a
# genuine question (interrogative), never promote even if a work verb appears later
# ("which file do I review?" stays info).
_QUESTION_LEADERS = frozenset(
    {
        "which",
        "what",
        "who",
        "whom",
        "whose",
        "when",
        "where",
        "why",
        "how",
        "is",
        "are",
        "was",
        "were",
        "do",
        "does",
        "did",
        "can",
        "could",
        "should",
        "would",
        "will",
        "shall",
        "may",
        "might",
        "am",
        "has",
        "have",
    }
)
# Imperative lead-ins that may precede the work verb ("please review ...", "can you go
# review ...") — we skip past these to find the verb in imperative position. "can"/"could"
# are deliberately NOT here: they lead a question ("can you review?" → interrogative).
_IMPERATIVE_LEADINS = frozenset(
    {"please", "kindly", "pls", "plz", "go", "now", "then", "you", "to"}
)
# Underscore MUST stay in the word charset: a code identifier like "test_wake_single_flight"
# or "include_closed" is one token, not the bare verb "test"/"closed" it would otherwise
# fragment into (GH#71 round-1 blocker 1).
_WORD_RE = re.compile(r"[a-z][a-z_\-']*")
# Copula/auxiliary forms — when one of these (or "of") follows the candidate verb anywhere
# before sentence end, the verb is being used as a NOUN subject of a declarative sentence
# ("fix was deployed", "review of the Q3 numbers is attached"), not an imperative. A bare
# past-tense/participle word ("failed", "dropped", "attached") is the same signal, checked
# separately below — underscore-joined identifiers are exempted so "include_closed" (which
# ends in "ed") is never mistaken for one (GH#71 round-1 blocker 2).
_DECLARATIVE_MARKERS = frozenset(
    {
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "being",
        "has",
        "have",
        "had",
        "of",
    }
)


def _is_declarative_tail(words: "list[str]") -> bool:
    for w in words:
        if w in _DECLARATIVE_MARKERS:
            return True
        if "_" not in w and w.endswith("ed") and w not in WORK_VERBS:
            return True
    return False


def classify_request_type(payload: str) -> "tuple[str, Optional[str]]":
    """GH #71 — pure, unit-testable classifier. Decide whether an info-typed request
    payload actually *asks for work* and should be promoted to a task.

    Returns ("task", matched_verb) to promote, or ("info", None) to leave alone.

    Rules (all must hold to promote):
      * a curated WORK_VERB (lowercased, word-boundary matched) appears in IMPERATIVE
        position — i.e. it is the first meaningful word, or follows only imperative
        lead-ins like "please"/"go"/"you";
      * the payload is NOT interrogative — it must not open with a question word/auxiliary
        AND must not end with '?';
      * the rest of the sentence is not declarative — no copula/auxiliary/"of" or bare
        past-tense word follows the verb (else it's a noun subject, e.g. "build 4711 failed
        overnight", not an imperative).
    Anything else stays info. Conservative by design (backstop only).
    """
    if not payload:
        return ("info", None)
    text = payload.strip()
    if not text:
        return ("info", None)
    lowered = text.lower()

    # Interrogative guards: trailing '?' OR a leading question word → genuine question.
    if text.rstrip().endswith("?"):
        return ("info", None)
    words = _WORD_RE.findall(lowered)
    if not words:
        return ("info", None)
    if words[0] in _QUESTION_LEADERS:
        return ("info", None)

    # Multi-word verb form: "sign off" / "sign-off" in imperative position.
    # Normalize the hyphenated form to the spaced form for a uniform prefix check, then
    # re-tokenize with the same word regex so the declarative-tail check below sees
    # underscore-joined identifiers as single tokens, same as the single-word path.
    norm = re.sub(r"sign-off", "sign off", lowered)
    norm_words = _WORD_RE.findall(norm)
    idx = 0
    while idx < len(norm_words) and norm_words[idx] in _IMPERATIVE_LEADINS:
        idx += 1
    if idx + 1 < len(norm_words):
        if norm_words[idx] == "sign" and norm_words[idx + 1] == "off":
            if _is_declarative_tail(norm_words[idx + 2 :]):
                return ("info", None)
            return ("task", "sign off")

    # Single-word work verb in imperative position: scan past leading imperative lead-ins,
    # the first meaningful word must be a curated WORK_VERB.
    pos = 0
    while pos < len(words) and words[pos] in _IMPERATIVE_LEADINS:
        pos += 1
    if pos < len(words) and words[pos] in WORK_VERBS:
        if _is_declarative_tail(words[pos + 1 :]):
            return ("info", None)
        return ("task", words[pos])
    return ("info", None)
