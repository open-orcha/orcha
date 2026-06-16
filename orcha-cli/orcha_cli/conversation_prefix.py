"""V1 — cache-friendly conversation-history prefix for a resident agent's COLD boot.

Pure (no I/O). Given the conversation turns BEFORE the current (triggering) human turn,
render a deterministic "## Conversation so far" block that sits AFTER persona+digest in the
resident's `--append-system-prompt` prefix (Forge's E3 boot owns the fetch, the cold-vs-warm
gate, and the wiring — this module is the only piece Vault owns). Order at boot:

    persona → digest → THIS block → [the new human turn arrives via stdin as the suffix]

COLD-boot only: on `--resume` claude rehydrates the session's own message history, so this
block is injected ONLY on a fresh/cold boot (no resumable session). Resident-only —
ephemeral one-shot wakes keep persona+digest, no conversation history.

Cache invariants (this is correctness, not style): the resident reuses Anthropic's
server-side prompt cache (~5-min TTL) only while the prefix stays byte-identical turn over
turn. So the block MUST be: append-only, oldest→newest, deterministic, and free of volatile
tokens (NO timestamps / nonces / ids that change between turns). Same `turns` in → same
string out.
"""

# Tunable after we see real transcripts — exposed as module constants so Forge's boot and
# this formatter share one source of truth.
MAX_HISTORY_TURNS = 20       # inject at most the most-recent N turns (oldest dropped first)
HISTORY_CHAR_BUDGET = 8000   # then trim OLDEST-first until the rendered block fits this many chars

_HEADER = ("## Conversation so far (you are mid-conversation as this agent — your recent "
           "turns with the human, oldest first; continue from the newest message that "
           "follows via your input):")

# 'You' = the agent reads its OWN prior turns; 'Human' = the person it's talking to.
_ROLE_LABEL = {"human": "Human", "agent": "You"}
_TRUNC_MARK = "\n…[truncated to fit the prompt-cache budget]"


def _role(turn: dict) -> str:
    return _ROLE_LABEL.get(turn.get("role"), str(turn.get("role") or "?"))


def _has_payload(turn) -> bool:
    """A turn carries cold-boot context if it has text content OR ≥1 valid attachment. #338:
    current delivery allows attachment-only turns (notifier.py:2148 Codex, :3025 Claude resident),
    so once such a turn becomes history its file context must survive — `_line`/`_attachment_markers`
    render the marker even with empty content. Dropping content-empty turns here (the prior filter)
    silently lost those files from a cold boot."""
    if not turn:
        return False
    if (turn.get("content") or "").strip():
        return True
    return any(isinstance(a, dict) for a in (turn.get("attachments") or []))


def _line(turn: dict) -> str:
    # #338: a COMPACT, cache-stable marker per attached file (name + kind only — NO url/size, which
    # are open-instructions reserved for the CURRENT turn via render_attachment_feed). History just
    # needs the agent to KNOW a file was shared earlier; stored refs are stable so this stays
    # byte-identical turn over turn (the prompt-cache invariant).
    return f"{_role(turn)}: {(turn.get('content') or '').strip()}{_attachment_markers(turn)}"


def _render(turns) -> str:
    return _HEADER + "\n\n" + "\n\n".join(_line(t) for t in turns)


def would_truncate(turns, *, max_turns: int = MAX_HISTORY_TURNS,
                   char_budget: int = HISTORY_CHAR_BUDGET) -> bool:
    """True iff ``format_conversation_history`` would DROP a whole turn or TRUNCATE content for
    ``turns`` — i.e. the mechanical render is LOSSY. Computed by the SAME path the formatter
    trims against (the post-``max_turns`` slice + the *rendered* block length), so callers can
    gate on it WITHOUT re-deriving header/role/separator overhead, which drifts (Orcha#321).

    Returns ``False`` ⟺ every non-empty turn renders verbatim within budget (the formatter would
    emit them all, lossless). Pure; no behaviour change to ``format_conversation_history``.
    """
    kept = [t for t in turns if _has_payload(t)]
    if not kept:
        return False
    if len(kept) > max_turns:
        return True                              # most-recent kept; older whole turns dropped
    return len(_render(kept)) > char_budget      # oldest dropped, or the lone turn truncated


def format_conversation_history(turns, *, max_turns: int = MAX_HISTORY_TURNS,
                                char_budget: int = HISTORY_CHAR_BUDGET) -> str:
    """Render the history block, or "" when there's nothing to inject.

    `turns`: ordered (oldest→newest) list of turn dicts BEFORE the current human turn; each
    has at least {"role": "human"|"agent", "content": str}. Tolerates None/[]/empty-content
    turns. Keeps the most-recent `max_turns`, then drops OLDEST whole turns until the block
    fits `char_budget`. If a single (newest) turn is STILL over budget, its content is
    truncated DETERMINISTICALLY with a stable marker — so a pasted log / tool dump can't
    blow the cap (and the prefix stays byte-stable for the cache). [P2 review]
    """
    if not turns:
        return ""
    kept = [t for t in turns if _has_payload(t)][-max_turns:]
    if not kept:
        return ""
    # Drop OLDEST whole turns while over budget and more than one remains.
    while len(kept) > 1 and len(_render(kept)) > char_budget:
        kept = kept[1:]
    block = _render(kept)
    if len(block) <= char_budget:
        return block
    # One (newest) turn still over budget — truncate its content to fit, exactly.
    lone = kept[-1]
    non_content = len(_HEADER) + 2 + len(_role(lone)) + 2   # header + "\n\n" + "<role>: "
    keep = char_budget - non_content - len(_TRUNC_MARK)
    if keep <= 0:
        return ""   # budget too small for even a label — inject nothing
    truncated = dict(lone)
    truncated["content"] = (lone.get("content") or "").strip()[:keep] + _TRUNC_MARK
    return _render([truncated])


# --- #338 attachment feed-to-agent ------------------------------------------------------------
# The feed mechanism is uniform across BOTH surfaces (task threads + conversations) and BOTH
# runtimes (Claude/Codex): we never inject bytes — we hand the agent the file's LOCATION + metadata
# as text and let it open the file with its OWN tools (Helm/Kedar-approved approach, #338). Files
# already live on disk (the #330 bind mount) and are reachable via the portal serve route; the
# agent fetches each with its shell and then reads/views it. Claude reads images natively (vision);
# Codex reads text/PDF/CSV/… but cannot view image PIXELS (image→text OCR is the flagged follow-up).

def _human_size(n) -> str:
    try:
        size = float(n)
    except (TypeError, ValueError):
        return "?"
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024:
            return f"{int(size)}{unit}" if unit == "B" else f"{size:.1f}{unit}"
        size /= 1024
    return f"{size:.1f}TB"


def _attachment_markers(turn: dict) -> str:
    """Compact, cache-stable suffix naming the files shared on a HISTORY turn (context only)."""
    atts = [a for a in (turn.get("attachments") or []) if isinstance(a, dict)]
    if not atts:
        return ""
    names = ", ".join(f"{a.get('name') or a.get('id')} ({a.get('kind') or 'file'})" for a in atts)
    return f"  [attached {len(atts)} file(s): {names}]"


def render_attachment_feed(attachments, *, api_base=None, runtime=None, extracted=None) -> str:
    """The FULL open-instruction block for the CURRENT turn/message's attachments — name, type,
    size, and a directly-fetchable URL per file, plus runtime-tailored guidance on how to open it.
    Returns "" when there are no (valid) attachments. Pure: same inputs → same string.

    `extracted` (#338 Codex image->text): an optional ``{attachment-id: text}`` map of pre-OCR'd
    text for files the runtime cannot view as pixels (Codex + images/PDFs). Attachment refs may
    also carry cached ``extracted_text`` from upload/validation time; the explicit map wins. Cached
    ref text is read only for the Codex/text-only runtime. When a file has text, it is inlined
    under the file so a text-only agent can act on the content directly — the URL is still given
    (the extraction is best-effort enrichment, never a replacement). Passing text in (rather than
    calling an LLM here) keeps this renderer PURE: the caller does the I/O, this just formats.
    Claude omits cached ref text (native vision)."""
    atts = [a for a in (attachments or []) if isinstance(a, dict)]
    if not atts:
        return ""
    base = (api_base or "").rstrip("/")
    extracted = extracted if isinstance(extracted, dict) else {}
    lines = ["## Attached files",
             "The human attached these to this message. Open each with your own tools "
             "(they are NOT inlined below — fetch them):"]
    for a in atts:
        name = a.get("name") or a.get("id") or "file"
        kind = a.get("kind") or "file"
        ctype = a.get("content_type") or "application/octet-stream"
        size = _human_size(a.get("size"))
        url = a.get("url") or ""
        full = f"{base}{url}" if (base and url) else url
        lines.append(f"  • {name} — {kind}, {ctype}, {size} — GET {full}")
        cached = a.get("extracted_text") if runtime == "codex" else ""
        text = (extracted.get(a.get("id")) or cached or "").strip()
        if text:
            # Inline the OCR/description so a text-only runtime can read content it cannot view. The
            # body is indented under the bullet so it's unambiguously THIS file's transcription.
            body = text.replace("\n", "\n      ")
            lines.append(f"      ↳ auto-transcribed text (you cannot view this file directly):\n"
                         f"      {body}")
    if runtime == "codex":
        lines.append("Fetch each with your shell (e.g. `curl -s '<url>' -o '<name>'`), then open it. "
                     "You can read text/PDF/CSV/JSON/log/markdown directly; you CANNOT view image "
                     "pixels — for image (and PDF) files the auto-transcribed text above is your "
                     "view of the content.")
    else:
        lines.append("Fetch each with your shell (e.g. `curl -s '<url>' -o '<name>'`), then open it "
                     "with the Read tool — images render visually (you can SEE them) and documents "
                     "read as text.")
    return "\n".join(lines)
