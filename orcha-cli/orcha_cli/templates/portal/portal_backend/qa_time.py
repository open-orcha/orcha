"""QA time limits: zero means no limit; a missing choice keeps the 20 minute default."""

import re

from portal_backend import qa_store as qs


DEFAULT_MINUTES = 20


def minutes(value):
    return DEFAULT_MINUTES if value is None else value


def task_description(description: str | None, budget: int) -> str:
    """Refresh generated time instructions without replacing the task's requirements."""
    text = description or ""
    note = "Time limit: none." if budget == 0 else f"Time limit: {budget} minutes."
    text, count = re.subn(r"(?m)^Time limit: (?:none|[0-9]+ minutes)\.$", note, text)
    text = re.sub(r"(?m)^(Run /orcha-qa-(?:map|explore) for this task on (?:ios|android|web) --minutes )[0-9]+\b",
                  lambda match: match[1] + str(budget), text)
    return text if count else text + ("\n\n" if text else "") + note


def elapsed(result: dict) -> float:
    return max((result.get("budget") or {}).get("used_s") or 0, result.get("budget_offset_s") or 0)


def keep_clock(session: dict, result: dict) -> dict:
    """Progress and device updates cannot discard the allowance already consumed."""
    saved = qs._json(session.get("result"), {}) or {}
    result = dict(result)
    for key in ("budget", "budget_offset_s", "continued_from_session_id", "resumed_from_session_id", "new_allowance"):
        if key in saved and key not in result:
            result[key] = saved[key]
    return result


def portal_attempt(sessions: list[dict], newest: dict) -> list[dict]:
    """Follow automatic replacements, never a person's explicit new attempt."""
    by_id = {str(s["id"]): s for s in sessions}
    attempt, seen = [], set()
    current = newest
    while current and str(current["id"]) not in seen:
        if any(str(current.get(k)) != str(newest.get(k))
               for k in ("task_id", "agent_id", "kind", "platform", "request_id")):
            break
        attempt.append(current)
        seen.add(str(current["id"]))
        saved = qs._json(current.get("result"), {}) or {}
        current = by_id.get(str(saved.get("resumed_from_session_id")))
    return attempt


def carry_progress(cur, session: dict) -> dict:
    """A replacement worker continues the interrupted run's clock and time choice.

    Continue explicitly starts a fresh allowance. A device queue does not.
    Verdicts are already request-scoped.
    """
    result = qs._json(session.get("result"), {}) or {}
    used = elapsed(result)
    if used:
        cur.execute("UPDATE qa_sessions SET result=%s WHERE id=%s",
                    (qs.dumps({**result, "budget_offset_s": used}), str(session["id"])))
        return qs.load_session(cur, str(session["id"]))
    if result.get("continued_from_session_id") or result.get("new_allowance"):
        return session
    if session.get("request_id"):
        cur.execute("""SELECT * FROM qa_sessions WHERE request_id=%s AND id<>%s
                       ORDER BY started_at DESC LIMIT 1""", (str(session["request_id"]), str(session["id"])))
    else:
        # Portal runs can have no request. Restrict their clock to this task,
        # agent and run type; a similar goal elsewhere is not the same work.
        cur.execute("""SELECT * FROM qa_sessions WHERE task_id=%s AND agent_id=%s
                       AND kind=%s AND platform=%s AND request_id IS NULL AND id<>%s
                       ORDER BY started_at DESC LIMIT 1""",
                    (str(session["task_id"]), str(session["agent_id"]), session["kind"],
                     session["platform"], str(session["id"])))
    previous = cur.fetchone()
    if not previous:
        return session
    if previous["status"] == "running":
        # A hard stop can skip tool shutdown. Use the same replacement rule as
        # the session sweeper, before reading the saved heartbeat clock.
        from portal_backend import qa_explorations as qx
        if (str(previous.get("agent_id")) != str(session.get("agent_id"))
                or qx._why_stopped(cur, dict(previous)) != qx.REPLACED_WORDS):
            return session
        cur.execute("UPDATE qa_sessions SET status='abandoned', ended_at=%s WHERE id=%s",
                    (qs.now(), str(previous["id"])))
        qs.end_open_walks(cur, str(previous["id"]), qx.REPLACED_WORDS)
    elif previous["status"] not in ("abandoned", "failed"):
        return session
    used = elapsed(qs._json(previous.get("result"), {}) or {})
    budget = session.get("budget_minutes") if session.get("request_id") else previous.get("budget_minutes")
    cur.execute("UPDATE qa_sessions SET budget_minutes=%s, result=%s WHERE id=%s",
                (budget, qs.dumps({**result, "budget_offset_s": used,
                                   "resumed_from_session_id": str(previous["id"])}), str(session["id"])))
    return qs.load_session(cur, str(session["id"]))


def reached(session: dict) -> bool:
    result = qs._json(session.get("result"), {}) or {}
    if result.get("stop_reason") == "time_limit":
        return True
    budget = result.get("budget") or {}
    return bool(budget.get("minutes", 0) > 0 and budget.get("used_s", 0) >= budget["minutes"] * 60)


def stop_result(session: dict, result: dict, lines: list[dict]) -> dict:
    """Keep the reason with the ended session, including the unfinished acceptance lines."""
    if not reached({**session, "result": result}):
        return result
    unfinished = [line for line in lines if line.get("verdict") != "pass"]
    limit = (result.get("budget") or {}).get("minutes") or session.get("budget_minutes")
    reason = f"Stopped at the {limit:g}-minute time limit." if limit else "Stopped at the time limit."
    if unfinished:
        reason += " Unfinished checks: " + "; ".join(f"Line {l['index'] + 1}: {l['text']}" for l in unfinished) + "."
    return {**result, "stop_reason": "time_limit", "reason": reason, "unfinished_lines": unfinished}
