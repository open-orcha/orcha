"""Server-side "Needs you" count — the SAME rule as the portal's attention selector.

The portal's ONE attention definition lives in
``frontend/src/state/attention.ts`` (``selectAttention``). The project switcher, the
sidebar rows of OTHER projects and the Projects table cannot compute it (they have no
snapshot of those projects), so ``GET /api/containers`` ships ``needs_you`` computed here.
Both sides MUST agree — ``tests/test_containers_needs_you.py`` pins the parity case by
case. The rule, per project:

  * plan    — task ``in_progress``, no ``plan_approval`` decision recorded, an agent-
              authored opening plan message exists, and the plan author's (else the
              first assignee's) EFFECTIVE autonomy is ``plan`` (``autonomy.py``, the ONE
              rule: enforced → container level, else the agent override, else the
              container level). Author/assignee resolve by alias among LIVE agents only,
              exactly like the snapshot the portal reads.
  * verify  — task ``needs_verification`` while the container level is not ``full``.
  * request — request ``escalated``, or ``open`` with no target or a live human target.

One entity counts once. The number counts only the decisions the REQUESTING user can
act on (not someone else's):
  * a task with an assigned reviewer counts only when the acting human IS that reviewer
    or is an owner (``member_role`` owner, or absent = pre-collab permissive) — the
    ``lib/reviewer.ts reviewFor`` rule; with no acting human, reviewer-assigned tasks
    never count;
  * a request targeted at a human counts only when the acting human is that target.
A read-only viewer (``viewer`` role, or a signed-in non-member) acts on nothing: 0.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Mapping, Optional

from portal_backend.task_list_query import PLAN_CUTOFF_SQL, PLAN_GATE_OPEN_SQL, PLAN_ROUND_ORDER_SQL
from portal_backend.autonomy import effective_autonomy

# The acting-human resolution result for one container.
READ_ONLY = "read_only"


def _empty() -> Dict[str, int]:
    return {"plan": 0, "verify": 0, "request": 0}


def _is_owner(h: Optional[Mapping[str, Any]]) -> bool:
    """lib/reviewer.ts isActingOwner: owner, or member_role absent (permissive)."""
    return bool(h) and (h.get("member_role") in ("owner", None))


def _task_for_other(task: Mapping[str, Any], acting: Optional[Mapping[str, Any]]) -> bool:
    """attention.ts: someone else's assigned review is listed, not counted."""
    rid = task.get("reviewer_agent_id")
    if rid is None:
        return False
    if acting is None:
        return True
    if not task.get("reviewer_exists"):
        return False  # reviewFor: no resolvable reviewer object ⇒ not someone else's
    if str(acting["id"]) == str(rid):
        return False
    if _is_owner(acting):
        return False
    return True


def needs_you_by_container(
    cur,
    containers: Iterable[Mapping[str, Any]],
    acting_by_cid: Mapping[str, Any],
) -> Dict[str, Dict[str, int]]:
    """Per-container {plan, verify, request} counts of decisions the acting human may make.

    ``containers`` rows need ``id``, ``autonomy_level`` and ``autonomy_enforced``.
    ``acting_by_cid[str(cid)]`` is the acting human's agent row (``id``, ``member_role``),
    ``None`` (nobody resolved — count only unassigned decisions), or ``READ_ONLY``.
    """
    rows = list(containers)
    out: Dict[str, Dict[str, int]] = {str(c["id"]): _empty() for c in rows}
    if not rows:
        return out
    cids = [str(c["id"]) for c in rows]
    by_cid = {str(c["id"]): c for c in rows}

    # LIVE agents only — the snapshot the portal resolves aliases against.
    cur.execute(
        """SELECT id, container_id, alias, kind, autonomy_override
             FROM agents
            WHERE container_id = ANY(%s::uuid[]) AND terminated_at IS NULL""",
        (cids,),
    )
    live_by_alias: Dict[str, Dict[str, Mapping[str, Any]]] = {}
    live_by_id: Dict[str, Mapping[str, Any]] = {}
    for a in cur.fetchall():
        live_by_alias.setdefault(str(a["container_id"]), {})[a["alias"]] = a
        live_by_id[str(a["id"])] = a

    # Candidate tasks: needs_verification, or an undecided in-progress task with an
    # agent-authored opening plan (task_list_query plan_message / plan_decision).
    cur.execute(
        """SELECT t.id, t.container_id, t.status, t.reviewer_agent_id,
                  EXISTS (SELECT 1 FROM agents ra WHERE ra.id = t.reviewer_agent_id)
                    AS reviewer_exists,
                  (SELECT ma.alias FROM (SELECT """ + PLAN_CUTOFF_SQL + """ AS c) pc
                    CROSS JOIN task_messages m JOIN agents ma ON ma.id = m.author_id
                    WHERE m.task_id = t.id AND ma.kind <> 'human'
                      AND m.created_at > pc.c
                    ORDER BY """ + PLAN_ROUND_ORDER_SQL + """ LIMIT 1) AS plan_author,
                  (SELECT a.alias FROM agent_tasks at JOIN agents a ON a.id = at.agent_id
                    WHERE at.task_id = t.id ORDER BY a.alias LIMIT 1) AS first_assignee
             FROM tasks t
            WHERE t.container_id = ANY(%s::uuid[])
              AND (t.status = 'needs_verification'
                   OR (t.status = 'in_progress'
                       AND """ + PLAN_GATE_OPEN_SQL + """))""",
        (cids,),
    )
    tasks = cur.fetchall()

    cur.execute(
        """SELECT id, container_id, status, target_id
             FROM requests
            WHERE container_id = ANY(%s::uuid[]) AND status IN ('open', 'escalated')""",
        (cids,),
    )
    reqs = cur.fetchall()

    for t in tasks:
        cid = str(t["container_id"])
        acting = acting_by_cid.get(cid)
        if acting == READ_ONLY:
            continue
        c = by_cid[cid]
        level = c["autonomy_level"] or "plan"
        kind = None
        if t["status"] == "in_progress":
            if t["plan_author"] is None:
                continue  # no agent plan posted: not a pending plan
            aliases = live_by_alias.get(cid, {})
            who = aliases.get(t["plan_author"]) or aliases.get(t["first_assignee"])
            eff = effective_autonomy(
                level,
                bool(c["autonomy_enforced"]),
                who.get("autonomy_override") if who else None,
            )
            if eff == "plan":
                kind = "plan"
        elif level != "full":
            kind = "verify"
        if kind and not _task_for_other(t, acting):
            out[cid][kind] += 1

    for r in reqs:
        cid = str(r["container_id"])
        acting = acting_by_cid.get(cid)
        if acting == READ_ONLY:
            continue
        target = live_by_id.get(str(r["target_id"])) if r["target_id"] is not None else None
        target_human = bool(target) and target["kind"] == "human"
        if r["status"] == "open" and r["target_id"] is not None and not target_human:
            continue  # open request to an agent (or a dead target): not a human decision
        if target_human and (acting is None or str(acting["id"]) != str(target["id"])):
            continue  # addressed to ANOTHER human
        out[cid]["request"] += 1
    return out


def parse_acting_picks(values: Optional[List[str]]) -> Dict[str, str]:
    """``?acting=<cid>:<human_agent_id>`` (repeatable) → {cid: agent_id}. Malformed skipped."""
    picks: Dict[str, str] = {}
    for v in values or []:
        for part in str(v).split(","):
            cid, sep, aid = part.strip().partition(":")
            if sep and cid and aid:
                picks[cid.strip().lower()] = aid.strip().lower()
    return picks
