"""Interpret Codex JSON event phases, rate limits, turn ends, and live tails."""

from __future__ import annotations

import json

def _codex_is_rate_limit(obj: dict) -> bool:
    """GH#61: does this Codex `codex exec --json` event signal a rate-limit / backoff / retry —
    i.e. the worker is alive, just sleeping off a 429? Tolerant on purpose (codex is not installed
    on the dev host, so the exact event spelling can't be pinned — same caveat as
    `_extract_codex_session_id`): we scan the event `type`, any nested `msg.type`, and the explicit
    `retry_after` backoff field, and only treat an error-shaped event as 'live' when it CLEARLY
    carries retry/backoff/429 semantics (a generic error is a dead worker, not a sleeping one).
    We deliberately do NOT key off a bare `retries` count: a *successful* event can be stamped with
    `retries: N` (it retried then succeeded), which is history, not a backoff in progress — counting
    it would read a finished worker as alive. Only `retry_after` (a concrete 'sleep this long before
    the next attempt') and explicit retry/429 type/message text mark an in-flight backoff."""
    if not isinstance(obj, dict):
        return False
    msg = obj.get("msg") if isinstance(obj.get("msg"), dict) else {}
    for t in ((obj.get("type") or ""), (msg.get("type") or "")):
        t = t.lower()
        if "rate_limit" in t or "rate-limit" in t or "backoff" in t or "throttl" in t \
                or "retry" in t or "retrying" in t:
            return True
    if obj.get("retry_after") or msg.get("retry_after"):
        return True
    for field in (msg.get("message"), msg.get("error"), obj.get("error"), obj.get("message")):
        if isinstance(field, str):
            low = field.lower()
            if "429" in low or "rate limit" in low or "rate_limit" in low or "too many requests" in low:
                return True
    return False


def _codex_is_non_retry_error(obj: dict) -> bool:
    """Return True for error-shaped Codex events that are not rate-limit backoff.

    A plain error is evidence that the worker is not merely quiet between model
    steps. Rate-limit/retry errors are handled first by `_codex_is_rate_limit`.
    """
    if not isinstance(obj, dict):
        return False
    msg = obj.get("msg") if isinstance(obj.get("msg"), dict) else {}
    for t in ((obj.get("type") or ""), (msg.get("type") or "")):
        t = t.lower()
        if t in ("error", "fatal") or t.endswith("_error") or t.endswith(".error"):
            return True
        if "fatal" in t:
            return True
    return False


def _codex_event_phase(obj: dict):
    """GH#61: classify a Codex `codex exec --json` event as the START or END of a tool/command,
    returning ('start'|'end'|None, id_or_None). Codex frames work as item lifecycle events —
    `item.started` → `item.completed`/`item.failed` carrying `item.id`, `item.type`
    (command_execution, mcp_tool_call, web_search, file_change, …) and `item.status` — but older
    builds emit a nested `msg` with `*_begin`/`*_end` pairs (exec_command_begin/_end,
    mcp_tool_call_begin/_end, …). The exact spelling can't be pinned on this host, so we recognize
    BOTH shapes tolerantly and fall back to a status-string read; an unrecognized event is None
    (ignored) rather than mistaken for in-flight work."""
    if not isinstance(obj, dict):
        return None, None
    item = obj.get("item") if isinstance(obj.get("item"), dict) else {}
    msg = obj.get("msg") if isinstance(obj.get("msg"), dict) else {}
    iid = item.get("id") or msg.get("call_id") or msg.get("id") or obj.get("id")
    top = (obj.get("type") or "").lower()
    mtype = (msg.get("type") or "").lower()
    # modern item.* lifecycle
    if top == "item.started":
        return "start", iid
    if top in ("item.completed", "item.failed", "item.done"):
        return "end", iid
    # nested msg begin/end pairs (older schema)
    if mtype.endswith("_begin"):
        return "start", iid
    if mtype.endswith("_end"):
        return "end", iid
    # status-string fallback (e.g. an item.updated carrying status)
    status = str(item.get("status") or msg.get("status") or "").lower()
    if status in ("in_progress", "running", "started", "pending"):
        return "start", iid
    if status in ("completed", "complete", "done", "failed", "success", "error",
                  "cancelled", "canceled", "aborted"):
        return "end", iid
    return None, None


def _codex_is_turn_end(obj: dict) -> bool:
    """GH#61 (PR #80 review): does this Codex `codex exec --json` event mark the end of a whole
    TURN, not just one item? Codex frames an agent turn as `turn.started` → …items… →
    `turn.completed`/`turn.failed` (older builds nest a `msg.type` of `turn_complete`/`task_complete`).
    This matters for liveness because a command `item.started` is not always closed by its own
    `item.completed`: in the official `codex exec --json` sample a command start is followed by an
    agent-message `item.completed` (a DIFFERENT id) and then `turn.completed`, leaving the command id
    perpetually 'in flight'. A turn-terminal event is a hard boundary — every item opened in that turn
    is finished — so we honor it as such (clear in-flight ids, balance the count) rather than reading a
    completed turn as a live worker. Recognized tolerantly (codex unpinned on this host)."""
    if not isinstance(obj, dict):
        return False
    msg = obj.get("msg") if isinstance(obj.get("msg"), dict) else {}
    for t in ((obj.get("type") or ""), (msg.get("type") or "")):
        t = t.lower()
        if t in ("turn.completed", "turn.failed", "turn.done", "turn_complete",
                 "turn_completed", "turn_failed", "turn_end", "task_complete",
                 "task_completed", "task_finished"):
            return True
    return False


def _codex_tail_is_live(tail: bytes) -> bool:
    """GH#61: liveness probe for a Codex (`codex exec --json`) worker, the runtime-aware sibling of
    the Claude `_worker_is_live` body. The Claude probe only understands Claude stream-json shapes,
    so before this an ALIVE-but-log-silent Codex worker (e.g. on a long external command) read as
    stalled and was hard-killed past the cap — the exact #49 failure mode left unfixed for Codex.

    Mirror the Claude three-signal heuristic over Codex's event schema and treat ANY as alive:
      * pairing — a tool/command `item.started`/`*_begin` whose id has not yet been seen as a
        terminal `item.completed`/`*_end` (precise when ids exist);
      * count — more starts than ends (covers no-id + parallel calls);
      * order — the LAST tool-phase event in the tail is a START (a no-id call in flight at the tail);
    plus a rate-limit/backoff event as the last meaningful signal (mid-429, alive but sleeping).
    plus an unfinished-turn signal — Codex can be legitimately quiet after an `item.completed`
    event while the model is thinking/composing the next step, and the only reliable terminal
    boundary is `turn.completed`/`turn.failed`. A genuinely terminal/error Codex tail trips none
    of these → False, so the dead-Codex teeth case still hard-kills. Parsing is fail-open/tolerant
    (codex unpinned on this host).

    PR #80 review: a `turn.completed`/`turn.failed` event is a hard TURN boundary that overrides the
    in-flight pairing. In the official `codex exec --json` shape a command `item.started` is closed by
    an agent-message `item.completed` (a different id) and then `turn.completed`, so the command id
    would otherwise stay 'in flight' and read the finished worker as live (→ wrongly checkpoint-
    respawned). On a turn-terminal event we clear the in-flight set, reset the start/end count, and
    make the turn end the last signal — so a completed/failed turn correctly reads NOT live."""
    inflight: set = set()
    start_count = end_count = 0
    # 'turn_start' | 'start' | 'end' | 'rate_limit' | 'turn_end' | 'error'
    last_signal = None
    for raw in tail.split(b"\n"):
        s = raw.strip()
        if not s:
            continue
        try:
            obj = json.loads(s)
        except ValueError:
            continue                           # partial/garbled line (e.g. truncated tail head)
        if not isinstance(obj, dict):
            continue
        if _codex_is_turn_end(obj):
            # hard turn boundary: every item opened this turn is done — drop in-flight ids, balance
            # the count, and let this terminal event be the last signal so the order check reads idle.
            inflight.clear()
            start_count = end_count = 0
            last_signal = "turn_end"
            continue
        if _codex_is_rate_limit(obj):
            last_signal = "rate_limit"
            continue
        if _codex_is_non_retry_error(obj):
            inflight.clear()
            start_count = end_count = 0
            last_signal = "error"
            continue
        msg = obj.get("msg") if isinstance(obj.get("msg"), dict) else {}
        if (obj.get("type") or "").lower() == "turn.started" or (
            msg.get("type") or ""
        ).lower() in ("turn_start", "turn_started"):
            inflight.clear()
            start_count = end_count = 0
            last_signal = "turn_start"
            continue
        phase, iid = _codex_event_phase(obj)
        if phase == "start":
            last_signal = "start"
            if iid:
                # Codex emits repeated `item.updated` (status:in_progress) events for ONE command,
                # each read as a "start" by the status fallback. Trust the id: only count a fresh
                # start (id not already in flight) so repeated updates of the same command don't
                # inflate start_count and read a finished worker as live. No-id events still count.
                if iid not in inflight:
                    inflight.add(iid)
                    start_count += 1
            else:
                start_count += 1
        elif phase == "end":
            last_signal = "end"
            if iid:
                # Only balance the count for an id we actually counted as started; a terminal event
                # for an id whose start scrolled out of the tail (or a duplicate end) must not drive
                # end_count past the real starts and fabricate a false stall.
                if iid in inflight:
                    inflight.discard(iid)
                    end_count += 1
            else:
                end_count += 1
    if inflight:                               # pairing: an unpaired in-flight tool/command id
        return True
    if start_count > end_count:                # count: more starts issued than terminated (no-id safe)
        return True
    # order/backoff/open-turn: tail ends mid-tool, mid-429, or after a completed item in an
    # unterminated Codex turn. A terminal turn or plain error remains non-live.
    return last_signal in ("turn_start", "start", "end", "rate_limit")
