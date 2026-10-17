"""Goal ancestry: the WHY of a task — project objective -> parent task(s) -> this task.

Truthful by construction. Every node in a chain comes from a stored fact:

* **objective** — the project's stated objective: ``containers.description``; when that is
  empty, the root task's description *only if* it says more than the project name (the init
  path defaults the root description to the name, which is not an objective). When neither
  exists the node is still emitted (the project is real) with ``text: null`` — the UI says
  "No objective set" instead of inventing one.
* **parent** — one hop up, from exactly two sources:
    1. ``tasks.parent_task_id`` (migration 062_goal_ancestry) — an explicit link a member or a
       participating agent set via ``PUT /api/tasks/{tid}/parent``   (``via: "parent_link"``);
    2. derived — the task was spawned by accepting / converting a task REQUEST whose
       ``originating_task_id`` (mig 028) names the task the requester was working on
       (``via: "task_request"``, with the request id).
  The explicit link wins when both exist. The root task is never a parent (it IS the
  objective), a parent must live in the same project, and the walk stops on a cycle or at
  ``MAX_DEPTH`` hops (``truncated: true``) — nothing is guessed past what is stored.
* **task** — the task itself.

The chain is ordered top-down (objective first, this task last) so a breadcrumb renders it
left-to-right and a prompt reads it as a sentence.
"""

from __future__ import annotations

import logging
from typing import Optional

from portal_backend import sql

_log = logging.getLogger(__name__)

MAX_DEPTH = 8  # parent hops walked before the chain is marked truncated

_HAS_PARENT_COLUMN = False  # positive-only cache: the migration may land after import


def has_parent_column(cur) -> bool:
    """Whether ``tasks.parent_task_id`` exists (migration applied). Positive result cached."""
    global _HAS_PARENT_COLUMN
    if _HAS_PARENT_COLUMN:
        return True
    cur.execute(f"SELECT 1 WHERE {sql.column_exists('tasks', 'parent_task_id')}")
    _HAS_PARENT_COLUMN = cur.fetchone() is not None
    return _HAS_PARENT_COLUMN


def _task_row(cur, tid: str, with_parent: bool) -> Optional[dict]:
    parent_col = "parent_task_id" if with_parent else "NULL AS parent_task_id"
    cur.execute(
        f"""SELECT id, container_id, title, status, is_root, {parent_col}
              FROM tasks WHERE id = %s""",
        (tid,),
    )
    return cur.fetchone()


def _derived_parent(cur, tid: str, cid: str) -> Optional[dict]:
    """The task a task REQUEST was raised from, when accepting that request spawned ``tid``."""
    cur.execute(
        """SELECT r.id AS request_id, r.originating_task_id
             FROM requests r
             JOIN tasks o ON o.id = r.originating_task_id
            WHERE r.spawned_task_id = %s
              AND r.originating_task_id IS NOT NULL
              AND r.originating_task_id <> %s
              AND o.container_id = %s
              AND NOT o.is_root
            ORDER BY r.created_at ASC
            LIMIT 1""",
        (tid, tid, cid),
    )
    return cur.fetchone()


def parent_of(cur, row: dict) -> Optional[dict]:
    """One hop up from a task row: ``{task_id, via, request_id?}`` or None (a top-level task)."""
    cid = str(row["container_id"])
    explicit = row.get("parent_task_id")
    if explicit is not None:
        return {"task_id": str(explicit), "via": "parent_link"}
    derived = _derived_parent(cur, str(row["id"]), cid)
    if derived:
        return {
            "task_id": str(derived["originating_task_id"]),
            "via": "task_request",
            "request_id": str(derived["request_id"]),
        }
    return None


def objective_node(cur, cid: str) -> Optional[dict]:
    """The project objective node (always present for a real project; ``text`` may be null)."""
    cur.execute(
        """SELECT c.id, c.name, c.description, c.root_task_id, rt.description AS root_desc
             FROM containers c
             LEFT JOIN tasks rt ON rt.id = c.root_task_id
            WHERE c.id = %s""",
        (cid,),
    )
    c = cur.fetchone()
    if c is None:
        return None
    name = c["name"] or ""
    text = (c["description"] or "").strip()
    source = "project_description" if text else None
    if not text:
        root_desc = (c["root_desc"] or "").strip()
        if root_desc and root_desc != name.strip():
            text, source = root_desc, "root_task"
    return {
        "kind": "objective",
        "id": str(c["root_task_id"]) if c["root_task_id"] else None,
        "container_id": str(c["id"]),
        "title": name,
        "text": text or None,
        "source": source,
    }


def goal_chain(cur, tid: str) -> Optional[dict]:
    """Compute the goal chain for task ``tid``.

    Returns ``{"task_id", "goal_chain": [nodes...], "truncated": bool, "cycle": bool}`` or
    None when the task does not exist. For the root task itself the chain is just the
    objective (the root IS the objective)."""
    with_parent = has_parent_column(cur)
    row = _task_row(cur, tid, with_parent)
    if row is None:
        return None
    cid = str(row["container_id"])
    objective = objective_node(cur, cid)
    if row["is_root"]:
        return {
            "task_id": str(row["id"]),
            "goal_chain": [objective] if objective else [],
            "truncated": False,
            "cycle": False,
        }

    ancestors: list[dict] = []
    seen = {str(row["id"])}
    truncated = cycle = False
    cur_row = row
    while True:
        up = parent_of(cur, cur_row)
        if up is None:
            break
        if len(ancestors) >= MAX_DEPTH:
            truncated = True
            break
        pid = up["task_id"]
        if pid in seen:
            cycle = True
            break
        prow = _task_row(cur, pid, with_parent)
        # Truthful: a dangling / cross-project / root parent ends the walk rather than
        # being shown. (The root is the objective node, never a "parent task".)
        if prow is None or str(prow["container_id"]) != cid or prow["is_root"]:
            break
        seen.add(pid)
        node = {
            "kind": "parent",
            "id": pid,
            "title": prow["title"],
            "status": prow["status"],
            "via": up["via"],
        }
        if up.get("request_id"):
            node["request_id"] = up["request_id"]
        ancestors.append(node)
        cur_row = prow

    chain: list[dict] = []
    if objective:
        chain.append(objective)
    chain.extend(reversed(ancestors))  # furthest ancestor first
    chain.append(
        {
            "kind": "task",
            "id": str(row["id"]),
            "title": row["title"],
            "status": row["status"],
        }
    )
    return {
        "task_id": str(row["id"]),
        "goal_chain": chain,
        "truncated": truncated,
        "cycle": cycle,
    }


def would_cycle(cur, tid: str, new_parent_id: str) -> bool:
    """True when making ``new_parent_id`` the parent of ``tid`` would close a loop, i.e.
    ``tid`` already appears in ``new_parent_id``'s own ancestry (or they are equal)."""
    if str(new_parent_id) == str(tid):
        return True
    with_parent = has_parent_column(cur)
    seen: set[str] = set()
    row = _task_row(cur, new_parent_id, with_parent)
    hops = 0
    while row is not None and hops <= MAX_DEPTH * 4:
        rid = str(row["id"])
        if rid == str(tid):
            return True
        if rid in seen:
            return False  # a pre-existing loop elsewhere; not one we would create
        seen.add(rid)
        up = parent_of(cur, row)
        if up is None:
            return False
        row = _task_row(cur, up["task_id"], with_parent)
        hops += 1
    return False


def goal_chain_for_prompt(cur, tid: str) -> Optional[list]:
    """Best-effort goal chain (node list) for the agent wake context.

    The wake must never fail because ancestry could not be read: any error is logged, the
    (read-only) transaction is rolled back so the caller's cursor stays usable, and None is
    returned — the prompt then simply carries no goal-chain line. A chain that is only the
    task itself with no objective text and no parents adds nothing, so it is also None."""
    try:
        res = goal_chain(cur, tid)
    except Exception as exc:  # noqa: BLE001 — context enrichment must not break a wake
        _log.warning("goal ancestry unavailable for task %s: %s", tid, exc)
        try:
            cur.connection.rollback()
        except Exception:  # noqa: BLE001
            pass
        return None
    if not res:
        return None
    chain = res["goal_chain"]
    has_parent = any(n["kind"] == "parent" for n in chain)
    has_objective_text = any(n["kind"] == "objective" and n.get("text") for n in chain)
    if not has_parent and not has_objective_text:
        return None
    return chain
