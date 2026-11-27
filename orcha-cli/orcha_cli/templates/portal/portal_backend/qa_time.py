"""QA time limits: zero means no limit; a missing choice keeps the 20 minute default."""

from portal_backend import qa_store as qs


DEFAULT_MINUTES = 20


def minutes(value):
    return DEFAULT_MINUTES if value is None else value


def elapsed(result: dict) -> float:
    return max((result.get("budget") or {}).get("used_s") or 0, result.get("budget_offset_s") or 0)


def keep_clock(session: dict, result: dict) -> dict:
    """Progress and device updates cannot discard the allowance already consumed."""
    saved = qs._json(session.get("result"), {}) or {}
    result = dict(result)
    for key in ("budget", "budget_offset_s", "continued_from_session_id"):
        if key in saved and key not in result:
            result[key] = saved[key]
    return result


def carry_progress(cur, session: dict) -> dict:
    """A replacement worker continues an interrupted request's clock, not a fresh allowance.

    Continue explicitly starts a fresh allowance. A device queue does not.
    Verdicts are already request-scoped.
    """
    result = qs._json(session.get("result"), {}) or {}
    used = elapsed(result)
    if used and session.get("budget_minutes"):
        cur.execute("UPDATE qa_sessions SET result=%s WHERE id=%s",
                    (qs.dumps({**result, "budget_offset_s": used}), str(session["id"])))
        return qs.load_session(cur, str(session["id"]))
    if not session.get("request_id") or result.get("continued_from_session_id"):
        return session
    cur.execute("""SELECT * FROM qa_sessions WHERE request_id=%s AND id<>%s
                   ORDER BY started_at DESC LIMIT 1""", (str(session["request_id"]), str(session["id"])))
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
    result = qs._json(previous.get("result"), {}) or {}
    used = elapsed(result)
    if used and session.get("budget_minutes"):
        cur.execute("UPDATE qa_sessions SET result=%s WHERE id=%s",
                    (qs.dumps({"budget_offset_s": used}), str(session["id"])))
        return qs.load_session(cur, str(session["id"]))
    return session


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
