"""Flexible workflows (semantics version 2): the stored flow and its definition versions.

A workflow's flow is the outcomes each step may report, the rule that says what happens
next for each outcome, and its repeat groups. `validate_flow` (workflow_graph) is the one
check for preview, save and Start; this module stores, loads and snapshots the result.
Nothing here commits: callers own the transaction and the container graph guard.
"""

import json
import os
from uuid import uuid4

from portal_backend.workflow_graph import conflict, descendants, validate_flow

FLAG = "WORKFLOWS_FLEXIBLE"


def flexible_enabled():
    """The server switch. Off hides version-2 authoring and pauses version-2 runs."""
    return os.environ.get(FLAG, "").strip().lower() in {"1", "true", "on", "yes"}


def capability():
    """The flexible-workflow fields of a Capability."""
    on = flexible_enabled()
    return {
        "flexible_workflows": on,
        "semantics_versions_supported": [1, 2] if on else [1],
    }


def wants_flow(draft):
    return bool(
        draft.get("repeat_groups")
        or any(t.get("outcomes") or t.get("routes") for t in draft.get("tasks", []))
    )


def semantics_for(draft):
    """Version for a new workflow: 2 whenever the switch is on, unless the draft asks
    for 1. A draft that uses outcomes, routes or groups needs version 2."""
    asked = draft.get("semantics_version")
    if asked == 2 and not flexible_enabled():
        conflict(
            "flexible_disabled",
            "Outcomes, next-step rules and repeat groups are not turned on for this server.",
            status=422,
        )
    version = asked or (2 if flexible_enabled() else 1)
    if version == 1 and wants_flow(draft):
        conflict(
            "flexible_disabled",
            "Outcomes, next-step rules and repeat groups are not turned on for this server."
            if not flexible_enabled()
            else "Outcomes, next-step rules and repeat groups need the newer workflow version.",
            status=422,
        )
    return version


def draft_flow(specs, groups, key_map=None):
    """Outcomes/routes/groups from draft task specs, with keys mapped through `key_map`."""
    m = key_map or {}

    def ref(value):
        return m.get(value, value) if value is not None else None

    outcomes, routes = {}, {}
    for spec in specs:
        tid = m.get(spec["client_key"], spec["client_key"])
        if spec.get("outcomes"):
            outcomes[tid] = [
                {"name": o["name"].strip(), "kind": o.get("kind", "custom")}
                for o in spec["outcomes"]
            ]
        if spec.get("routes"):
            routes[tid] = [
                {
                    "outcome": r["outcome"].strip(),
                    "destination": r["destination"],
                    "destination_task": ref(r.get("destination_task")),
                }
                for r in spec["routes"]
            ]
    mapped = [
        {
            **g,
            "name": g["name"].strip(),
            "exit_outcome": g["exit_outcome"].strip(),
            "member_tasks": [ref(t) for t in g["member_tasks"]],
            "review_task": ref(g["review_task"]),
        }
        for g in groups
    ]
    return outcomes, routes, mapped


def load_flow(svc, wid):
    """The stored flow of a workflow, in task-id space. `svc` is a WorkflowService."""
    outcomes, routes = {}, {}
    for o in svc.rows(
        "SELECT task_id,name,kind FROM workflow_step_outcomes WHERE workflow_id=%s ORDER BY task_id,position",
        (wid,),
    ):
        outcomes.setdefault(o["task_id"], []).append(
            {"name": o["name"], "kind": o["kind"]}
        )
    for r in svc.rows(
        "SELECT task_id,outcome_name,destination_kind,destination_task_id FROM workflow_step_routes WHERE workflow_id=%s ORDER BY task_id,outcome_name",
        (wid,),
    ):
        routes.setdefault(r["task_id"], []).append(
            {
                "outcome": r["outcome_name"],
                "destination": r["destination_kind"],
                "destination_task": r["destination_task_id"],
            }
        )
    groups = []
    for g in svc.rows(
        "SELECT * FROM workflow_repeat_groups WHERE workflow_id=%s ORDER BY name", (wid,)
    ):
        members = svc.rows(
            "SELECT task_id FROM workflow_repeat_group_members WHERE group_id=%s ORDER BY position",
            (g["id"],),
        )
        groups.append(
            {
                "id": g["id"],
                "name": g["name"],
                "member_tasks": [m["task_id"] for m in members],
                "review_task": g["review_task_id"],
                "exit_outcome": g["exit_outcome"],
                "max_rounds": g["max_rounds"],
                "escalation_owner_id": g["escalation_owner_id"],
                "stall_rule": g["stall_rule"],
                "current_round": g["current_round"],
                "state": g["state"],
            }
        )
    return outcomes, routes, groups


def save_flow(svc, w, outcomes, routes, groups):
    """Replace the stored flow. Group ids survive a save when the group name is kept,
    so rounds already recorded stay attached to their group."""
    wid, cur = w["id"], svc.cur
    kept = {
        r["name"]: r["id"]
        for r in svc.rows(
            "SELECT id,name FROM workflow_repeat_groups WHERE workflow_id=%s", (wid,)
        )
    }
    cur.execute("DELETE FROM workflow_step_routes WHERE workflow_id=%s", (wid,))
    cur.execute("DELETE FROM workflow_step_outcomes WHERE workflow_id=%s", (wid,))
    cur.execute(
        "DELETE FROM workflow_repeat_group_members WHERE workflow_id=%s", (wid,)
    )
    names = {g["name"] for g in groups}
    for name, gid in kept.items():
        if name not in names:
            cur.execute("DELETE FROM workflow_repeat_groups WHERE id=%s", (gid,))
    group_ids = {}
    for g in groups:
        gid = kept.get(g["name"])
        owner = g.get("escalation_owner_id") or w["owner_human_id"]
        if gid:
            cur.execute(
                "UPDATE workflow_repeat_groups SET review_task_id=%s,exit_outcome=%s,max_rounds=%s,escalation_owner_id=%s,stall_rule=%s WHERE id=%s",
                (
                    g["review_task"],
                    g["exit_outcome"],
                    g["max_rounds"],
                    owner,
                    g.get("stall_rule", "findings_and_artifact"),
                    gid,
                ),
            )
        else:
            gid = str(uuid4())
            cur.execute(
                "INSERT INTO workflow_repeat_groups(id,workflow_id,name,review_task_id,exit_outcome,max_rounds,escalation_owner_id,stall_rule) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    gid,
                    wid,
                    g["name"],
                    g["review_task"],
                    g["exit_outcome"],
                    g["max_rounds"],
                    owner,
                    g.get("stall_rule", "findings_and_artifact"),
                ),
            )
        group_ids[g["name"]] = gid
        for position, tid in enumerate(g["member_tasks"]):
            cur.execute(
                "INSERT INTO workflow_repeat_group_members(group_id,workflow_id,task_id,position) VALUES (%s,%s,%s,%s)",
                (gid, wid, tid, position),
            )
    review_group = {g["review_task"]: group_ids[g["name"]] for g in groups}
    for tid, declared in outcomes.items():
        for position, o in enumerate(declared):
            cur.execute(
                "INSERT INTO workflow_step_outcomes(workflow_id,task_id,name,kind,position) VALUES (%s,%s,%s,%s,%s)",
                (wid, tid, o["name"], o.get("kind", "custom"), position),
            )
    for tid, rules in routes.items():
        for r in rules:
            cur.execute(
                "INSERT INTO workflow_step_routes(workflow_id,task_id,outcome_name,destination_kind,destination_task_id,group_id) VALUES (%s,%s,%s,%s,%s,%s)",
                (
                    wid,
                    tid,
                    r["outcome"],
                    r["destination"],
                    r.get("destination_task"),
                    review_group.get(tid)
                    if r["destination"] in {"return", "exit_group"}
                    else None,
                ),
            )


def check_flow(tasks, dependencies, outcomes, routes, groups):
    """`validate_flow` over the full task set; returns its summary."""
    return validate_flow(tasks, dependencies, outcomes, routes, groups)


def definition_snapshot(snapshot, outcomes, routes, groups, assignees):
    w = snapshot["workflow"]
    return {
        "semantics_version": w.get("semantics_version", 1),
        "turn_allowance": w.get("turn_allowance"),
        "execution_mode": w["execution_mode"],
        "tasks": [
            {
                "id": str(tid),
                "title": t["title"],
                "definition_of_done": t["definition_of_done"],
                "work_revision": t["work_revision"],
                "assignee_ids": sorted(assignees.get(str(tid), [])),
                "depends_on": sorted(str(p) for p in snapshot["dependencies"].get(tid, [])),
            }
            for tid, t in snapshot["tasks"].items()
        ],
        "outcomes": outcomes,
        "routes": routes,
        "repeat_groups": [
            {k: g[k] for k in ("name", "member_tasks", "review_task", "exit_outcome", "max_rounds", "stall_rule")}
            for g in groups
        ],
    }


def record_definition_version(svc, w, actor_id, reason, body):
    """Freeze the current definition as the next version (Start, then each structural
    edit). Only version-2 workflows keep definition versions."""
    if w.get("semantics_version", 1) != 2:
        return None
    cur = svc.cur
    version = (
        svc.one(
            "SELECT COALESCE(MAX(version),0) AS v FROM workflow_definition_versions WHERE workflow_id=%s",
            (w["id"],),
        )["v"]
        + 1
    )
    cur.execute(
        "INSERT INTO workflow_definition_versions(id,workflow_id,version,reason,snapshot,created_by) VALUES (%s,%s,%s,%s,%s,%s)",
        (str(uuid4()), w["id"], version, reason, json.dumps(body, sort_keys=True, default=str, separators=(",", ":")), actor_id),
    )
    cur.execute(
        "UPDATE workflows SET definition_version=%s WHERE id=%s", (version, w["id"])
    )
    return version


STARTED = {"in_progress", "needs_verification", "completed"}


def propagate_unselected(seed, tasks, dependencies):
    """Steps left without any selected prerequisite are not selected either."""
    out = set(seed)
    changed = True
    while changed:
        changed = False
        for tid, prerequisites in dependencies.items():
            if tid in out or not prerequisites:
                continue
            if all(
                p in out or tasks.get(p, {}).get("route_state") == "not_selected"
                for p in prerequisites
            ):
                out.add(tid)
                changed = True
    return out


def resolve(snapshot, flow, tid, outcome):
    """Where an outcome leads, and what that does to the rest of the plan. Pure: the
    same answer feeds the reporter's preview, the Accept dialog and the apply step."""
    outcomes, routes, groups = flow
    tasks, deps = snapshot["tasks"], snapshot["dependencies"]
    declared = {o["name"].casefold(): o["name"] for o in outcomes.get(tid, [])}
    name = declared.get(outcome.strip().casefold())
    if not name:
        conflict(
            "unknown_outcome",
            "Choose one of this step's outcomes.",
            status=422,
            outcomes=list(declared.values()),
        )
    rule = next(r for r in routes[tid] if r["outcome"].casefold() == name.casefold())
    kind, target = rule["destination"], rule.get("destination_task")
    branches = {r["destination_task"] for r in routes.get(tid, []) if r["destination"] == "step"}
    seed = branches - {target}
    if kind == "stop":
        seed |= descendants(tid, deps)
    unselected = {
        t
        for t in propagate_unselected(seed, tasks, deps)
        if tasks[t]["status"] not in STARTED and tasks[t].get("route_state") != "not_selected"
    }
    group = next((g for g in groups if g["review_task"] == tid), None)
    out = {
        "task_id": tid,
        "outcome": name,
        "destination": kind,
        "destination_task_id": target,
        "group": group["name"] if group else None,
        "round": group.get("current_round") if group else None,
        "rounds_remaining": max(group["max_rounds"] - (group.get("current_round") or 0), 0)
        if group
        else None,
        "repeats": [],
        "kept": [],
        "stale": [],
        "not_selected": sorted(unselected),
        "blocked_by": None,
    }
    if kind == "return":
        below = descendants(target, deps)
        repeats = [
            m
            for m in group["member_tasks"]
            if m == target or (m in below and (m == tid or tid in descendants(m, deps)))
        ]
        out["repeats"] = repeats
        out["kept"] = [m for m in group["member_tasks"] if m not in repeats]
        members = set(group["member_tasks"])
        out["stale"] = sorted(
            {
                d
                for r in repeats
                for d in descendants(r, deps)
                if d not in members and tasks[d]["status"] in STARTED
            }
        )
        if (group.get("current_round") or 0) >= group["max_rounds"]:
            out["blocked_by"] = "limit"
    out["message"] = describe(out, tasks)
    return out


def describe(preview, tasks):
    def title(tid):
        return tasks[tid]["title"] if tid in tasks else "a step"

    kind = preview["destination"]
    if kind == "return":
        if preview["blocked_by"] == "limit":
            return (
                f"The loop {preview['group']} reached its round limit; the owner decides what happens next."
            )
        return (
            f"Sends the work back to {title(preview['destination_task_id'])} for round "
            f"{(preview['round'] or 0) + 1} of {preview['group']}."
        )
    if kind == "step":
        return f"Continues with {title(preview['destination_task_id'])}."
    if kind == "exit_group":
        return f"Ends the loop {preview['group']} and continues."
    if kind == "ask_owner":
        return "Asks the owner what happens next."
    if kind == "stop":
        return "Stops this path; the steps after it will not run."
    return "Continues with the next steps."
