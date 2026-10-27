"""Read-only workflow context for the one task resolved by a wake."""


def workflow_for_prompt(cur, task):
    wid = task.get("workflow_id")
    if not wid:
        return None
    cur.execute("SELECT id,title,goal FROM workflows WHERE id=%s AND container_id=%s",
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
    return {"id": str(workflow["id"]), "title": workflow["title"], "goal": workflow["goal"],
            "step_number": step_number, "tasks": steps}
