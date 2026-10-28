"""Read-only workflow context for the one task resolved by a wake."""

import json

# Keep the round context well inside one prompt section (HLD §7: 64 KB).
ROUND_CONTEXT_LIMIT = 64 * 1024


def _json(value):
    return json.loads(value) if isinstance(value, str) else value


def _clip(text, limit):
    text = text or ""
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _findings(inputs):
    return [
        {"text": _clip(f.get("text"), 500), "severity": f.get("severity")}
        for f in (inputs or {}).get("findings") or []
    ][:50]


def round_context(cur, task, wid):
    """Semantics version 2: the step's outcomes and, for a repeat-group member, its round,
    the rule that ends the loop, what this round must address and the earlier rounds.
    None for version-1 workflows and for v2 steps with neither outcomes nor a group."""
    cur.execute("SELECT name,kind FROM workflow_step_outcomes WHERE task_id=%s ORDER BY position",
                (task["id"],))
    outcomes = [dict(r) for r in cur.fetchall()]
    cur.execute("SELECT g.* FROM workflow_repeat_groups g JOIN workflow_repeat_group_members m "
                "ON m.group_id=g.id WHERE m.task_id=%s AND g.workflow_id=%s", (task["id"], wid))
    group = cur.fetchone()
    if not outcomes and not group:
        return None
    # The fences a worker sends with its outcome report, read fresh on every call.
    cur.execute("SELECT revision FROM workflows WHERE id=%s", (wid,))
    workflow = cur.fetchone()
    cur.execute("SELECT work_revision FROM tasks WHERE id=%s", (task["id"],))
    work = cur.fetchone()
    context = {"task_id": str(task["id"]), "workflow_id": str(wid),
               "workflow_revision": workflow["revision"] if workflow else None,
               "work_revision": work["work_revision"] if work else None,
               "outcomes": outcomes, "group": None}
    if group:
        cur.execute("SELECT title FROM tasks WHERE id=%s", (group["review_task_id"],))
        review = cur.fetchone()
        cur.execute("SELECT round_number,trigger_kind,end_reason,inputs FROM workflow_group_rounds "
                    "WHERE group_id=%s ORDER BY round_number", (group["id"],))
        rounds = cur.fetchall()
        current = next((r for r in rounds if r["round_number"] == group["current_round"]), None)
        inputs = _json(current["inputs"]) if current else {}
        context["group"] = {
            "name": group["name"],
            "round": group["current_round"],
            "max_rounds": group["max_rounds"],
            "state": group["state"],
            "review_step": review["title"] if review else None,
            "is_review_step": str(group["review_task_id"]) == str(task["id"]),
            "exit_outcome": group["exit_outcome"],
            "this_round": {
                "trigger": current["trigger_kind"] if current else None,
                "outcome": (inputs or {}).get("outcome"),
                "findings": _findings(inputs),
                "note": _clip((inputs or {}).get("note"), 2000) or None,
                "owner_note": _clip((inputs or {}).get("owner_note"), 2000) or None,
            },
            "earlier_rounds": [
                {"round": r["round_number"], "ended": r["end_reason"],
                 "outcome": (_json(r["inputs"]) or {}).get("outcome"),
                 "findings": _findings(_json(r["inputs"]))}
                for r in rounds if r["round_number"] < group["current_round"]
            ],
        }
        # Oldest rounds go first when the context would not fit.
        while (context["group"]["earlier_rounds"]
               and len(json.dumps(context, default=str)) > ROUND_CONTEXT_LIMIT):
            context["group"]["earlier_rounds"].pop(0)
    return context


def workflow_for_prompt(cur, task):
    wid = task.get("workflow_id")
    if not wid:
        return None
    cur.execute("SELECT id,title,goal,semantics_version FROM workflows WHERE id=%s AND container_id=%s",
                (wid, task["container_id"]))
    workflow = cur.fetchone()
    if not workflow:
        return None
    # Match the workflow page's ordering. Membership comes exclusively from the
    # resolved task's workflow_id, never the agent's assignments or recent tasks.
    cur.execute("SELECT id,title,status,result FROM tasks WHERE workflow_id=%s "
                "AND container_id=%s ORDER BY priority,created_at,id",
                (wid, task["container_id"]))
    tasks = cur.fetchall()
    cur.execute("SELECT at.task_id,a.alias FROM agent_tasks at "
                "JOIN tasks t ON t.id=at.task_id JOIN agents a ON a.id=at.agent_id "
                "WHERE t.workflow_id=%s AND t.container_id=%s ORDER BY a.alias",
                (wid, task["container_id"]))
    assignees = {}
    for row in cur.fetchall():
        assignees.setdefault(str(row["task_id"]), []).append(row["alias"])
    steps = []
    step_number = None
    for number, row in enumerate(tasks, 1):
        tid = str(row["id"])
        if tid == str(task["id"]):
            step_number = number
        steps.append({"id": tid, "title": row["title"], "status": row["status"],
                      "assignees": assignees.get(tid, []),
                      "result": row["result"] if row["status"] in ("completed", "needs_verification") else None})
    context = {"id": str(workflow["id"]), "title": workflow["title"], "goal": workflow["goal"],
               "step_number": step_number, "tasks": steps}
    if workflow.get("semantics_version") == 2:
        context["round_context"] = round_context(cur, task, wid)
    return context
