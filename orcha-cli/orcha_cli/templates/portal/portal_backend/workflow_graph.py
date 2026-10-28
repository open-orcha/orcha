"""Workflow graph validation. Call under the container graph guard when writing.

Edges are stored as dependent -> prerequisites, and drawn in the opposite direction.
These pure functions also serve previews, so preview and commit cannot disagree about
closure, duplicate inputs, the three-prerequisite limit, or cycles.
"""

from collections import deque

from fastapi import HTTPException


def conflict(code, message, *, status=409, **context):
    raise HTTPException(status, {"code": code, "message": message, **context})


def validate_graph(tasks, dependencies):
    """Validate the COMPLETE proposed workflow graph; never silently deduplicate."""
    ids = set(tasks)
    indegree = {tid: 0 for tid in ids}
    children = {tid: [] for tid in ids}
    for tid, prerequisites in dependencies.items():
        if tid not in ids:
            conflict("unknown_task", "A task is unavailable.", status=422)
        if len(prerequisites) > 3:
            conflict(
                "dependency_limit",
                "A task can have at most three prerequisites.",
                status=422,
                task_id=tid,
            )
        if len(set(prerequisites)) != len(prerequisites):
            conflict(
                "duplicate_dependency",
                "Select each prerequisite once.",
                status=422,
                task_id=tid,
            )
        for pid in prerequisites:
            if pid not in ids:
                conflict(
                    "dependency_outside_workflow",
                    "Every prerequisite must be in this workflow.",
                    status=422,
                    task_id=tid,
                )
            if pid == tid:
                conflict(
                    "self_dependency",
                    "A task cannot depend on itself.",
                    status=422,
                    task_id=tid,
                )
            indegree[tid] += 1
            children[pid].append(tid)
    queue = deque(sorted(tid for tid in ids if not indegree[tid]))
    visited = []
    while queue:
        tid = queue.popleft()
        visited.append(tid)
        for child in children[tid]:
            indegree[child] -= 1
            if not indegree[child]:
                queue.append(child)
    if len(visited) != len(ids):
        conflict(
            "dependency_cycle",
            "These prerequisites create a cycle.",
            status=422,
            task_ids=sorted(tid for tid, n in indegree.items() if n),
        )
    return visited


def dependency_closure(selected, dependencies):
    """Both directions: importing a prerequisite must also include its dependents."""
    neighbors = {}
    for tid, prerequisites in dependencies.items():
        neighbors.setdefault(tid, set()).update(prerequisites)
        for pid in prerequisites:
            neighbors.setdefault(pid, set()).add(tid)
    closure = set(selected)
    queue = deque(selected)
    while queue:
        for neighbor in neighbors.get(queue.popleft(), ()):
            if neighbor not in closure:
                closure.add(neighbor)
                queue.append(neighbor)
    return closure


def descendants(tid, dependencies):
    """Transitive dependents; used to prevent rewriting work that already started."""
    children = {}
    for child, prerequisites in dependencies.items():
        for pid in prerequisites:
            children.setdefault(pid, set()).add(child)
    found = set()
    queue = deque(children.get(tid, ()))
    while queue:
        child = queue.popleft()
        if child not in found:
            found.add(child)
            queue.extend(children.get(child, ()))
    return found


def ancestors(tid, dependencies):
    """Transitive prerequisites of a task."""
    found = set()
    queue = deque(dependencies.get(tid, ()))
    while queue:
        pid = queue.popleft()
        if pid not in found:
            found.add(pid)
            queue.extend(dependencies.get(pid, ()))
    return found


def validate_flow(tasks, dependencies, outcomes, routes, groups):
    """Validate outcomes, routes and repeat groups (semantics version 2) for the COMPLETE
    proposed workflow. Preview, create, edit and the Start check call this same function.

    `outcomes`: {task: [{name, kind}]}; `routes`: {task: [{outcome, destination,
    destination_task}]}; `groups`: [{name, member_tasks, review_task, exit_outcome,
    max_rounds}]. Task references are ids or draft keys, consistently. Prerequisites stay
    acyclic: a return never adds an edge, it starts a new round of its group.
    """
    ids = set(tasks)
    group_of = {}
    review_group = {}
    if len(groups) > 5:
        conflict("group_limit", "A workflow can have at most five repeat groups.", status=422)
    names = [g["name"].strip().casefold() for g in groups]
    if len(set(names)) != len(names):
        conflict("duplicate_group", "Give each repeat group a distinct name.", status=422)
    for g in groups:
        members = g["member_tasks"]
        if not 2 <= len(members) <= 10 or len(set(members)) != len(members):
            conflict(
                "group_members",
                "A repeat group needs two to ten distinct steps.",
                status=422,
                group=g["name"],
            )
        if not 1 <= int(g.get("max_rounds") or 0) <= 20:
            conflict(
                "group_without_limit",
                "Every repeat group needs a round limit from 1 to 20.",
                status=422,
                group=g["name"],
            )
        for tid in members:
            if tid not in ids:
                conflict("unknown_task", "A repeat group step is unavailable.", status=422, group=g["name"])
            if tid in group_of:
                conflict(
                    "group_overlap",
                    "A step can belong to only one repeat group.",
                    status=422,
                    task_id=tid,
                )
            group_of[tid] = g["name"]
        review = g["review_task"]
        if review not in members:
            conflict(
                "group_review_outside",
                "The review step must be one of the group's steps.",
                status=422,
                group=g["name"],
            )
        upstream = ancestors(review, dependencies)
        stray = [tid for tid in members if tid != review and tid not in upstream]
        if stray:
            conflict(
                "group_member_unreachable",
                "Every step in a repeat group must lead to its review step.",
                status=422,
                group=g["name"],
                task_ids=sorted(stray),
            )
        review_group[review] = g
    for tid in set(outcomes) | set(routes):
        if tid not in ids:
            conflict("unknown_task", "A task is unavailable.", status=422)
    for tid in ids:
        declared = outcomes.get(tid, [])
        rules = routes.get(tid, [])
        if len(declared) > 8:
            conflict("outcome_limit", "A step can have at most eight outcomes.", status=422, task_id=tid)
        names = [o["name"].strip().casefold() for o in declared]
        if len(set(names)) != len(names):
            conflict("duplicate_outcome", "Give each outcome a distinct name.", status=422, task_id=tid)
        ruled = [r["outcome"].strip().casefold() for r in rules]
        if len(set(ruled)) != len(ruled):
            conflict(
                "route_conflict",
                "An outcome can have only one next-step rule.",
                status=422,
                task_id=tid,
            )
        unknown = sorted(set(ruled) - set(names))
        if unknown:
            conflict(
                "unknown_outcome",
                "A rule names an outcome this step does not declare.",
                status=422,
                task_id=tid,
                outcomes=unknown,
            )
        missing = [o["name"] for o in declared if o["name"].strip().casefold() not in ruled]
        if missing:
            conflict(
                "outcome_without_route",
                "Every outcome needs a rule for what happens next.",
                status=422,
                task_id=tid,
                outcomes=missing,
            )
        dependents = {c for c, prereqs in dependencies.items() if tid in prereqs}
        for r in rules:
            kind, dest = r["destination"], r.get("destination_task")
            if (kind in {"step", "return"}) != bool(dest):
                conflict(
                    "route_destination",
                    "Choose a step for a branch or a send-back, and only for those.",
                    status=422,
                    task_id=tid,
                    outcome=r["outcome"],
                )
            if dest is not None and dest not in ids:
                conflict("unknown_task", "A rule points at an unavailable step.", status=422, task_id=tid)
            if kind == "step" and dest not in dependents:
                conflict(
                    "branch_not_dependent",
                    "A branch must lead to a step that waits for this one.",
                    status=422,
                    task_id=tid,
                    outcome=r["outcome"],
                )
            if kind in {"return", "exit_group"}:
                g = review_group.get(tid)
                if g is None:
                    conflict(
                        "return_outside_group",
                        "Only a repeat group's review step can send work back or leave the group.",
                        status=422,
                        task_id=tid,
                        outcome=r["outcome"],
                    )
                if kind == "return" and (
                    dest == tid or group_of.get(dest) != g["name"]
                ):
                    conflict(
                        "return_outside_group",
                        "Work can be sent back only to an earlier step in the same repeat group.",
                        status=422,
                        task_id=tid,
                        outcome=r["outcome"],
                    )
    for g in groups:
        review = g["review_task"]
        declared = {o["name"].strip().casefold(): o for o in outcomes.get(review, [])}
        exit_name = g["exit_outcome"].strip().casefold()
        if exit_name not in declared:
            conflict(
                "group_exit_unknown",
                "The review step must declare the outcome that ends the loop.",
                status=422,
                group=g["name"],
            )
        rules = {r["outcome"].strip().casefold(): r for r in routes.get(review, [])}
        if rules[exit_name]["destination"] in {"return", "ask_owner"}:
            conflict(
                "group_exit_loops",
                "The outcome that ends the loop must lead out of it.",
                status=422,
                group=g["name"],
            )
        if not any(r["destination"] == "return" for r in rules.values()):
            conflict(
                "group_without_return",
                "A repeat group's review step needs an outcome that sends work back.",
                status=422,
                group=g["name"],
            )
    return {"groups": {g["name"]: g for g in groups}, "group_of": group_of}
