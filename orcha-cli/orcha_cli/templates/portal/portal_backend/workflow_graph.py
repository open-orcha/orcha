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
