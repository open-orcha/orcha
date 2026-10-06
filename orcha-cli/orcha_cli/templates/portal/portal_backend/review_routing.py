"""Manager review handoff (mig 057): finished work follows the org chart.

When an agent's ``/done`` parks a task at ``needs_verification`` (the ONLY transition into
that state — task_done_routes.mark_done, plan/pr autonomy), ``route_finished_work`` decides
WHO reviews it, according to the project's ``containers.review_route``:

  manager_chain (default)
      The finisher's nearest HUMAN manager who can act on a verification (kind='human',
      live, same project, never a viewer — the same rule ``org_chart.route_via_manager``
      applies to escalations) becomes ``tasks.reviewer_agent_id``; the routing record is
      stamped on ``tasks.review_routing`` ({routed_via:'reports_to', ...}). The task then
      lands in THAT human's Needs you (the existing "assigned to you / someone else" split).
      No reporting line → unchanged behaviour (anyone may verify). A chain with nobody who
      can act → ``routed_via:'fallback'`` (anyone), with the skipped managers recorded.
  owner
      The project owner becomes the reviewer.
  anyone
      No automatic reviewer (the pre-057 behaviour).

A reviewer a HUMAN chose (PUT /api/tasks/{tid}/reviewer → ``review_routing.routed_via =
'manual'``) is always respected; automatic routing never overwrites it.

AI manager PRE-review (``containers.ai_manager_prereview``, default on, manager_chain only):
when an AI manager sits between the finisher and that human, the nearest live AI manager is
sent an ordinary ``info`` request (requester = the finisher, originating_task_id = the task,
``detail.kind = 'manager_review'``) carrying the task, its definition of done, the result and
the run evidence — so its pre-review is a normal wake under the normal autonomy / budget
rules. It answers by responding ``APPROVE: …`` / ``SEND BACK: …`` (POST
/api/requests/{rid}/respond) or via POST /api/tasks/{tid}/manager-review.

  * approve  → recorded on ``tasks.manager_review`` as a RECOMMENDATION. It never verifies
               the task: the task stays at needs_verification for the human reviewer, who
               sees "Atlas (manager) recommends approval: …" in the verification gate.
  * send back→ the task returns to its assignee(s) with the reasons — the same mechanics as a
               human rejection's rework, labelled as the manager's feedback.
  * anything else → recorded as a comment and handed to the human unchanged.

Human authority is never reduced: any human may still verify directly while the pre-review is
pending (the pending request is closed as ``superseded``), may approve work an AI manager sent
back (``overridden``), and an owner may reassign the reviewer at any time. Every automatic
routing decision writes an audit event (``review_routed``, ``manager_prereview_requested``,
``manager_review_recorded``, ``manager_review_superseded``).
"""

import json
import re
from datetime import datetime, timezone
from typing import Optional

from portal_backend import sql
from portal_backend.agent_status import log_event, recompute_agent_status
from portal_backend.events import publish_event
from portal_backend.org_chart import manager_chain

REVIEW_ROUTES = ("manager_chain", "owner", "anyone")
MANAGER_REVIEW_KIND = "manager_review"
# The pre-review request's lifetime. It is excluded from the expiry sweep (the human reviewer
# already holds the task), so this only bounds how long it lingers in the manager's inbox.
PREREVIEW_EXPIRES_MINUTES = 7 * 24 * 60
_EVIDENCE_RUNS = 3
_EVIDENCE_FILES = 25
_TEXT_CAP = 4000


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def review_settings(cur, container_id) -> dict:
    cur.execute(
        "SELECT review_route, ai_manager_prereview FROM containers WHERE id=%s",
        (container_id,),
    )
    row = cur.fetchone() or {}
    return {
        "review_route": row.get("review_route") or "manager_chain",
        "ai_manager_prereview": bool(row.get("ai_manager_prereview", True)),
    }


def _walk(cur, container_id, finisher_id):
    """Walk the finisher's chain: (human_mgr|None, ai_mgr|None, depth|None, skipped, has_chain).

    ``ai_mgr`` is the nearest live AI manager in this project BELOW the human (or anywhere
    in the chain when no human can act). Viewers / retired / other-project managers are
    skipped and recorded, mirroring org_chart.route_via_manager."""
    chain = manager_chain(cur, finisher_id)
    ai_mgr = None
    skipped = []
    for depth, mgr in enumerate(chain, start=1):
        alias = mgr["alias"]
        if str(mgr["container_id"]) != str(container_id):
            skipped.append({"alias": alias, "why": "other_project"})
            continue
        if mgr["terminated_at"] is not None:
            skipped.append({"alias": alias, "why": "retired"})
            continue
        if mgr["kind"] != "human":
            if ai_mgr is None:
                ai_mgr = mgr
            else:
                skipped.append({"alias": alias, "why": "ai_manager"})
            continue
        if mgr["member_role"] == "viewer":
            skipped.append({"alias": alias, "why": "viewer"})
            continue
        return mgr, ai_mgr, depth, skipped, True
    return None, ai_mgr, None, skipped, bool(chain)


def _project_owner(cur, container_id):
    cur.execute(
        """SELECT id, alias FROM agents
            WHERE container_id=%s AND kind='human' AND terminated_at IS NULL
              AND member_role='owner'
            ORDER BY created_at ASC LIMIT 1""",
        (container_id,),
    )
    return cur.fetchone()


def _alias(cur, agent_id) -> Optional[str]:
    if agent_id is None:
        return None
    cur.execute("SELECT alias FROM agents WHERE id=%s", (agent_id,))
    row = cur.fetchone()
    return row["alias"] if row else None


def _close_prereview_request(cur, container_id, request_id, reason, response=None):
    """Close the pre-review request (no wake to the requester — it is not an answer)."""
    if not request_id:
        return
    cur.execute(
        """UPDATE requests SET status='closed', closed_at=now(),
                  response=COALESCE(%s, response),
                  responded_at=CASE WHEN CAST(%s AS TEXT) IS NULL THEN responded_at ELSE now() END
            WHERE id=%s AND status IN ('open','accepted')
        RETURNING requester_id, target_id""",
        (response, response, request_id),
    )
    row = cur.fetchone()
    if not row:
        return
    log_event(cur, container_id, "system", None, "request", str(request_id), "closed",
              {"reason": reason, "kind": MANAGER_REVIEW_KIND})
    if row["target_id"]:
        publish_event(cur, str(container_id), str(row["target_id"]), "request_closed",
                      {"request_id": str(request_id), "reason": reason})
    if row["requester_id"]:
        recompute_agent_status(cur, str(row["requester_id"]))


def _run_evidence(cur, task_id) -> list:
    cur.execute(
        """SELECT l.run_id, l.status, l.exit_code, l.started_at, l.ended_at, l.diff,
                  a.alias AS agent_alias
             FROM worker_runs l
             JOIN worker_run_tasks wrt ON wrt.run_id = l.run_id
             LEFT JOIN agents a ON a.id = l.agent_id
            WHERE wrt.task_id = %s
            ORDER BY l.started_at DESC LIMIT %s""",
        (task_id, _EVIDENCE_RUNS),
    )
    runs = []
    for r in cur.fetchall():
        files = []
        for m in re.finditer(r"^diff --git a/(\S+) b/", r["diff"] or "", re.M):
            if m.group(1) not in files:
                files.append(m.group(1))
        runs.append({
            "run_id": str(r["run_id"]),
            "agent_alias": r["agent_alias"],
            "status": r["status"],
            "exit_code": r["exit_code"],
            "ended_at": r["ended_at"].isoformat() if r["ended_at"] else None,
            "changed_files": files[:_EVIDENCE_FILES],
            "changed_files_total": len(files),
        })
    return runs


def _prereview_payload(task, finisher_alias, reviewer_alias, result_text, runs) -> str:
    lines = [
        f"Manager pre-review: {finisher_alias} finished \"{task['title']}\" and it is waiting "
        f"for verification by {reviewer_alias or 'a human'}.",
        "As their manager, check the result against the definition of done and the run "
        "evidence. Your call is a RECOMMENDATION — a human still verifies.",
        "",
        "Reply (respond to this request) starting with exactly one of:",
        "  APPROVE: <why it meets the definition of done>",
        "  SEND BACK: <what must change>  (returns the task to the assignee with your reasons)",
        "",
        f"Task id: {task['id']}",
        "Definition of done:",
        (task.get("definition_of_done") or "(none)")[:_TEXT_CAP],
        "",
        f"Result from {finisher_alias}:",
        (result_text or "(no result text)")[:_TEXT_CAP],
    ]
    if runs:
        lines += ["", "Run evidence (newest first):"]
        for r in runs:
            files = ", ".join(r["changed_files"]) if r["changed_files"] else "no diff recorded"
            more = r["changed_files_total"] - len(r["changed_files"])
            if more > 0:
                files += f" (+{more} more)"
            lines.append(
                f"  - run {r['run_id'][:8]} by {r['agent_alias']}: {r['status']}"
                f" (exit {r['exit_code']}); files: {files}"
            )
    return "\n".join(lines)


def supersede_pending_prereview(cur, container_id, task_id, *, reason, actor_id=None,
                                new_status="superseded") -> bool:
    """A human acted (verify / reject / cancel) while an AI pre-review was still pending:
    close the pre-review request and mark the record. Returns True if one was pending."""
    cur.execute("SELECT manager_review FROM tasks WHERE id=%s", (task_id,))
    row = cur.fetchone()
    mr = (row or {}).get("manager_review") or None
    if not mr or mr.get("status") != "pending":
        return False
    mr = {**mr, "status": new_status, "decided_at": _now_iso(), "superseded_reason": reason}
    cur.execute("UPDATE tasks SET manager_review=%s WHERE id=%s", (sql.json_param(mr), task_id))
    _close_prereview_request(cur, container_id, mr.get("request_id"), reason)
    log_event(cur, container_id, "human" if actor_id else "system", actor_id, "task",
              str(task_id), "manager_review_superseded",
              {"reason": reason, "manager_alias": mr.get("manager_alias"),
               "request_id": mr.get("request_id")})
    return True


def route_finished_work(cur, container_id, task_id, finisher_id, result_text) -> dict:
    """Route the review of a task that just entered needs_verification. Same transaction as
    the /done. Returns a summary {review_routed_via, reviewer_alias, prereview_request_id}."""
    cid = str(container_id)
    tid = str(task_id)
    settings = review_settings(cur, cid)
    cur.execute(
        """SELECT id, title, definition_of_done, reviewer_agent_id, review_routing,
                  manager_review
             FROM tasks WHERE id=%s""",
        (tid,),
    )
    task = cur.fetchone()
    prev_routing = task["review_routing"] or {}
    finisher_alias = _alias(cur, finisher_id) or "the assignee"

    # A rework round re-routes: an older pre-review still pending is superseded first.
    supersede_pending_prereview(cur, cid, tid, reason="resubmitted")

    manual = prev_routing.get("routed_via") == "manual"
    reviewer_id = str(task["reviewer_agent_id"]) if task["reviewer_agent_id"] else None
    routing: Optional[dict] = None
    ai_mgr = None

    human = depth = None
    skipped: list = []
    has_chain = False
    if settings["review_route"] == "manager_chain":
        human, ai_mgr, depth, skipped, has_chain = _walk(cur, cid, finisher_id)
        if not settings["ai_manager_prereview"]:
            ai_mgr = None

    if manual:
        routing = prev_routing  # a human's explicit choice (incl. "anyone") is respected
    elif settings["review_route"] == "manager_chain":
        if human is not None:
            reviewer_id = str(human["id"])
            routing = {"routed_via": "reports_to", "reviewer_alias": human["alias"],
                       "manager_depth": depth}
        elif has_chain:
            reviewer_id = None
            routing = {"routed_via": "fallback"}
        else:
            # No reporting line: today's behaviour. Drop a stale auto-route from an
            # earlier round (the org chart may have changed since).
            if prev_routing.get("routed_via") in ("reports_to", "owner", "fallback"):
                reviewer_id = None
            routing = None
    elif settings["review_route"] == "owner":
        owner = _project_owner(cur, cid)
        reviewer_id = str(owner["id"]) if owner else None
        routing = ({"routed_via": "owner", "reviewer_alias": owner["alias"]} if owner
                   else {"routed_via": "fallback"})
    else:  # anyone
        if prev_routing.get("routed_via") in ("reports_to", "owner", "fallback"):
            reviewer_id = None
        routing = None

    if routing is not None and not manual:
        routing = {**routing, "assignee_alias": finisher_alias, "routed_at": _now_iso()}
        if skipped:
            routing["reports_to_skipped"] = skipped
        if ai_mgr is not None:
            routing["pre_review_by"] = ai_mgr["alias"]
    cur.execute(
        "UPDATE tasks SET reviewer_agent_id=%s, review_routing=%s, manager_review=NULL "
        "WHERE id=%s",
        (reviewer_id, sql.json_param(routing) if routing is not None else None, tid),
    )
    reviewer_alias = _alias(cur, reviewer_id)
    routed_via = (routing or {}).get("routed_via")
    if routing is not None or prev_routing:
        log_event(cur, cid, "system", None, "task", tid, "review_routed", {
            "review_routed_via": routed_via,
            "review_route_setting": settings["review_route"],
            "reviewer_agent_id": reviewer_id,
            "reviewer_alias": reviewer_alias,
            "assignee_alias": finisher_alias,
            "manager_depth": (routing or {}).get("manager_depth"),
            "reports_to_skipped": skipped or None,
            "pre_review_by": ai_mgr["alias"] if ai_mgr is not None else None,
        })

    prereview_rid = None
    if ai_mgr is not None:
        prereview_rid = _request_prereview(
            cur, cid, task, finisher_id, finisher_alias, ai_mgr, reviewer_alias, result_text
        )
    return {
        "review_routed_via": routed_via,
        "reviewer_agent_id": reviewer_id,
        "reviewer_alias": reviewer_alias,
        "prereview_request_id": prereview_rid,
        "pre_review_by": ai_mgr["alias"] if ai_mgr is not None else None,
    }


def _request_prereview(cur, cid, task, finisher_id, finisher_alias, ai_mgr, reviewer_alias,
                       result_text) -> str:
    tid = str(task["id"])
    runs = _run_evidence(cur, tid)
    payload = _prereview_payload(task, finisher_alias, reviewer_alias, result_text, runs)
    detail = {
        "kind": MANAGER_REVIEW_KIND,
        "task_id": tid,
        "task_title": task["title"],
        "definition_of_done": task["definition_of_done"],
        "result": (result_text or "")[:_TEXT_CAP],
        "runs": runs,
        "assignee_alias": finisher_alias,
        "human_reviewer_alias": reviewer_alias,
    }
    cur.execute(
        """INSERT INTO requests
             (container_id, type, requester_id, target_id, priority, status, payload,
              expires_at, chain_depth, detail, originating_task_id)
           VALUES (%s, 'info', %s, %s, 100, 'open', %s,
                   %s, 0, %s, %s)
           RETURNING id""",
        (cid, finisher_id, str(ai_mgr["id"]), payload,
         sql.from_now(PREREVIEW_EXPIRES_MINUTES * 60), json.dumps(detail), tid),
    )
    rid = str(cur.fetchone()["id"])
    mr = {
        "status": "pending",
        "manager_agent_id": str(ai_mgr["id"]),
        "manager_alias": ai_mgr["alias"],
        "request_id": rid,
        "recommendation": None,
        "reasons": None,
        "requested_at": _now_iso(),
        "decided_at": None,
    }
    cur.execute("UPDATE tasks SET manager_review=%s WHERE id=%s", (sql.json_param(mr), tid))
    recompute_agent_status(cur, finisher_id)
    log_event(cur, cid, "system", None, "request", rid, "created", {
        "type": "info", "target_alias": ai_mgr["alias"], "priority": 100,
        "preview": payload[:120], "kind": MANAGER_REVIEW_KIND, "task_id": tid,
    })
    log_event(cur, cid, "system", None, "task", tid, "manager_prereview_requested", {
        "manager_agent_id": str(ai_mgr["id"]), "manager_alias": ai_mgr["alias"],
        "request_id": rid, "assignee_alias": finisher_alias,
        "human_reviewer_alias": reviewer_alias,
    })
    # A normal request wake for the AI manager (autonomy / budget / wake policy apply as
    # for any other request it receives).
    publish_event(cur, cid, str(ai_mgr["id"]), "request_created", {
        "request_id": rid, "type": "info", "from_agent_id": str(finisher_id),
        "preview": payload[:120], "kind": MANAGER_REVIEW_KIND, "task_id": tid,
    })
    return rid


_APPROVE_RE = re.compile(r"^\s*\**\s*(approve[ds]?|approval|lgtm|recommend approval)\b[\s:.\-—]*",
                         re.I)
_SEND_BACK_RE = re.compile(
    r"^\s*\**\s*(send[\s_-]*back|sent[\s_-]*back|reject(ed)?|changes[\s_-]*requested|rework)\b"
    r"[\s:.\-—]*",
    re.I,
)


def parse_manager_response(text: str):
    """(decision, reasons) from a free-text pre-review answer."""
    body = text or ""
    m = _SEND_BACK_RE.match(body)
    if m:
        return "send_back", body[m.end():].strip() or body.strip()
    m = _APPROVE_RE.match(body)
    if m:
        return "approve", body[m.end():].strip() or body.strip()
    return "comment", body.strip()


def pending_prereview_for_request(cur, request_row):
    """The task whose pending pre-review this request is, else None."""
    detail = request_row.get("detail") or {}
    if detail.get("kind") != MANAGER_REVIEW_KIND or not detail.get("task_id"):
        return None
    cur.execute(
        "SELECT id, container_id, status, title, manager_review FROM tasks WHERE id=%s " + sql.for_update(),
        (detail["task_id"],),
    )
    t = cur.fetchone()
    mr = (t or {}).get("manager_review") or {}
    if (not t or mr.get("status") != "pending"
            or str(mr.get("request_id")) != str(request_row["id"])):
        return None
    return t


def apply_manager_review(cur, task_row, manager_id, decision, reasons) -> dict:
    """Record the AI manager's pre-review. ``decision`` ∈ approve | send_back | comment.

    Never verifies. approve/comment → recorded, the human reviewer keeps the task;
    send_back → the task returns to its assignees (in_progress) with the reasons."""
    cid = str(task_row["container_id"])
    tid = str(task_row["id"])
    mr = dict(task_row["manager_review"] or {})
    alias = mr.get("manager_alias") or _alias(cur, manager_id) or "manager"
    reasons = (reasons or "").strip()[:_TEXT_CAP]
    status = {"approve": "approved", "send_back": "sent_back"}.get(decision, "commented")
    mr.update({
        "status": status,
        "recommendation": decision if decision in ("approve", "send_back") else None,
        "reasons": reasons or None,
        "decided_at": _now_iso(),
    })
    cur.execute("UPDATE tasks SET manager_review=%s WHERE id=%s", (sql.json_param(mr), tid))
    label = {
        "approve": f"[manager pre-review] {alias} recommends approval",
        "send_back": f"[manager feedback] {alias} sent this back",
    }.get(decision, f"[manager pre-review] {alias} commented")
    cur.execute(
        "INSERT INTO task_messages (task_id, author_id, body) VALUES (%s, %s, %s)",
        (tid, manager_id, label + (f": {reasons}" if reasons else "")),
    )
    _close_prereview_request(cur, cid, mr.get("request_id"), f"manager_{status}",
                             response=reasons or decision)
    restored = []
    if decision == "send_back":
        cur.execute("UPDATE tasks SET status='in_progress' WHERE id=%s", (tid,))
        cur.execute(
            "UPDATE agent_tasks SET assignment_status='working' "
            "WHERE task_id=%s AND assignment_status='done' RETURNING agent_id",
            (tid,),
        )
        restored = [str(r["agent_id"]) for r in cur.fetchall()]
        for aid in restored:
            recompute_agent_status(cur, aid)
        feedback = f"Your manager {alias} sent this back: {reasons or '(no reasons given)'}"
        for aid in restored:
            # The same rework directive a human rejection sends — labelled as the manager's.
            publish_event(cur, cid, aid, "task_verified", {
                "task_id": tid, "approved": False, "feedback": feedback,
                "by_manager_alias": alias, "manager_review": True,
            })
    recompute_agent_status(cur, str(manager_id))
    log_event(cur, cid, "ai", str(manager_id), "task", tid, "manager_review_recorded", {
        "decision": decision,
        "status": status,
        "reasons": reasons or None,
        "manager_alias": alias,
        "request_id": mr.get("request_id"),
        "reassigned_to_agent_ids": restored or None,
    })
    if decision == "send_back":
        log_event(cur, cid, "ai", str(manager_id), "task", tid, "status_changed",
                  {"to": "in_progress", "reason": "manager_sent_back", "manager_alias": alias})
    return {"task_id": tid, "manager_review": mr,
            "status": "in_progress" if decision == "send_back" else "needs_verification",
            "restored_assignee_agent_ids": restored}
