"""Copy only the setup of a completed workflow into the ordinary creation path."""

from portal_backend import workflow_routing as routing
from portal_backend.workflow_graph import conflict


def completed_setup(svc, source, person):
    # Completed rows retain the final setup. Definition snapshots omit descriptions,
    # objectives and limits, and older workflows have no snapshot at all.
    wid, cid = source["id"], source["container_id"]
    tasks = svc.rows(
        "SELECT * FROM tasks WHERE workflow_id=%s ORDER BY priority,created_at,id", (wid,)
    )
    generated = set()
    for row in svc.rows("SELECT * FROM workflow_review_rounds WHERE workflow_id=%s", (wid,)):
        if row["correction_task_id"]:
            generated.add(row["correction_task_id"])
        if row["prior_round_id"]:
            generated.add(row["review_task_id"])
    tasks = [t for t in tasks if not t["withdrawn_at"] and t["id"] not in generated]
    ids = {t["id"] for t in tasks}
    people = {p["id"]: p for p in svc.rows(
        "SELECT * FROM agents WHERE container_id=%s AND terminated_at IS NULL", (cid,)
    )}
    assignments = {}
    for row in svc.rows(
        "SELECT a.* FROM agent_tasks a JOIN tasks t ON t.id=a.task_id "
        "WHERE t.workflow_id=%s ORDER BY a.assigned_at,a.agent_id",
        (wid,),
    ):
        assignments.setdefault(row["task_id"], []).append(row)
    deps = {tid: [] for tid in ids}
    for row in svc.rows(
        "SELECT d.* FROM task_dependencies d JOIN tasks t ON t.id=d.task_id WHERE t.workflow_id=%s", (wid,)
    ):
        if row["task_id"] in ids and row["depends_on_id"] in ids:
            deps[row["task_id"]].append(row["depends_on_id"])
    outcomes, routes, groups = routing.load_flow(svc, wid)
    # Ignore definitions belonging to removed steps, but never silently redirect a
    # retained step/loop whose destination disappeared.
    for tid, rules in routes.items():
        if tid in ids and any(r["destination_task"] and r["destination_task"] not in ids for r in rules):
            conflict("copy_definition_unavailable", "A saved route points to a removed step. The workflow cannot be copied.")
    notes, specs, autonomy, dropped = [], [], {}, []
    for t in tasks:
        history = assignments.get(t["id"], [])
        assigned = [a["agent_id"] for a in history if a["assignment_status"] == "assigned"]
        # Accepting a result marks the assignment done. Retain the last assignee
        # of completed steps, without resurrecting a former assignee on a draft.
        if not assigned and t["status"] == "completed" and history:
            assigned = [history[-1]["agent_id"]]
        kept = [aid for aid in assigned if aid in people and people[aid]["kind"] == "ai"]
        if len(kept) != len(assigned):
            dropped.extend({"task_id": t["id"], "assignee_id": aid} for aid in assigned if aid not in kept)
            notes.append(f'Choose an available assignee for “{t["title"]}”.')
        specs.append({
            "client_key": t["id"], "title": t["title"],
            "description": t["description"] or "", "definition_of_done": t["definition_of_done"] or "",
            "priority": t["priority"], "assignee_id": kept[-1] if kept else None,
            "depends_on": deps[t["id"]], "outcomes": outcomes.get(t["id"], []),
            "routes": routes.get(t["id"], []),
        })
        # Enabling autonomy is reserved to the project owner, including on a copy.
        if t["autonomy"] == "on":
            if person["member_role"] == "owner":
                autonomy[t["id"]] = "on"
            else:
                notes.append(f'“{t["title"]}” requires human approval. The project owner can restore automatic approval.')
    copied_groups = []
    for g in groups:
        if not set(g["member_tasks"]) <= ids or g["review_task"] not in ids:
            conflict("copy_definition_unavailable", "A saved loop includes a removed step. The workflow cannot be copied.")
        group = {k: g[k] for k in (
            "name", "member_tasks", "review_task", "exit_outcome", "max_rounds", "escalation_owner_id", "stall_rule"
        )}
        owner = people.get(group["escalation_owner_id"])
        if not owner or owner["kind"] != "human" or owner["member_role"] == "viewer":
            group["escalation_owner_id"] = None
            notes.append(f'You will handle decisions for the “{g["name"]}” loop because its previous owner is unavailable.')
        copied_groups.append(group)
    draft = {
        "title": source["title"][:188] + " (run again)", "goal": source["goal"],
        "execution_mode": source["execution_mode"], "semantics_version": source["semantics_version"],
        "turn_allowance": source["turn_allowance"], "tasks": specs, "repeat_groups": copied_groups,
        "objectives": svc.rows("SELECT title,criteria FROM workflow_objectives WHERE workflow_id=%s ORDER BY id", (wid,)),
    }
    return draft, {
        "task_limit": source["task_limit"], "round_limit": source["round_limit"], "autonomy": autonomy,
        "provenance": {"source_workflow_id": wid, "source_definition_version": source["definition_version"], "copy_notes": notes, "dropped_assignees": dropped},
    }
