"""Read-only task-message guidance. Uses the same recipients and parking as delivery.

Issue #369 owns changes to wake selection; this projection must follow that policy,
never implement a second path to launch or release workflow work.
"""

import json
from typing import Literal
from urllib.parse import urlencode

from pydantic import BaseModel

from portal_backend.budget_routes import agent_budget_block
from portal_backend.run_failure_backoff import failure_block
from portal_backend.wake_scan_queries import WorkflowParking, list_wake_agents
from portal_backend.wake_decision import decide_wake
from portal_backend.wake_backoff import fetch_active_backoff_map

DeliveryState = Literal[
    "deliverable_now", "deferred_until_eligible", "worker_running", "no_assignee",
    "task_finished", "wake_disabled_or_paused", "unknown",
]


class MessageRecipientDelivery(BaseModel):
    agent_id: str
    alias: str
    state: DeliveryState
    reason: str
    direct_chat_href: str | None = None


class TaskMessageDelivery(BaseModel):
    task_id: str
    state: DeliveryState
    reason: str
    task_href: str
    recipients: list[MessageRecipientDelivery]


def message_recipients(cur, task):
    """Active assignments plus the exact submitter awaiting review (legacy /done)."""
    tid = str(task["id"])
    cur.execute("SELECT agent_id FROM agent_tasks WHERE task_id=%s AND assignment_status <> 'done'", (tid,))
    recipients = cur.fetchall()
    if task["status"] == "needs_verification":
        result = task.get("result") or {}
        if isinstance(result, str):
            result = json.loads(result)
        submitter = result.get("by_agent_id") if isinstance(result, dict) else None
        if submitter and all(str(r["agent_id"]) != str(submitter) for r in recipients):
            cur.execute("SELECT agent_id FROM agent_tasks WHERE task_id=%s AND agent_id=%s", (tid, submitter))
            row = cur.fetchone()
            if row:
                recipients.append(row)
    return recipients


def recipient_state(cur, task, agent, wake, container, backoff):
    """Explain eligibility, not proof of launch, receipt or reply. No writes."""
    if task["status"] in ("completed", "cancelled"):
        return "task_finished", "This task is finished. A thread message will not start an agent."
    if agent["kind"] != "ai" or agent["terminated_at"] is not None:
        return "wake_disabled_or_paused", "This assignee cannot start automatic agent work."
    if not wake:
        return "unknown", "Automatic message delivery could not be checked."
    # Ask the wake service's existing decision function about this prospective
    # message. The branches below only translate its refusal into UI categories.
    _, can_wake, _ = decide_wake(
        container_status=container["status"], wakes_enabled=container["wakes_enabled"],
        agent_wake_enabled=wake["wake_enabled"], pending=1, latest="task_message",
        notifications=[], auto_tasks=[], auto_interval=None,
        secs_since_woken=wake["secs_since_woken"], pending_task_request=False,
        self_wake_due=False, work_idle_seconds=wake["work_idle_seconds"], min_idle=30,
        in_cooldown=wake["in_cooldown"], lease_active=wake["lease_active"],
        lease_kind=wake["lease_kind"], embodiment_running=wake["embodiment_running"],
    )
    if not can_wake and (container["status"] != "active" or not container["wakes_enabled"] or not wake["wake_enabled"]):
        return "wake_disabled_or_paused", "Automatic work is paused or disabled. Check the project and agent settings."
    blocked = failure_block(cur, str(agent["id"])) or agent_budget_block(cur, str(task["container_id"]), str(agent["id"]))
    if blocked:
        return "wake_disabled_or_paused", blocked
    if not can_wake and (wake["lease_active"] or wake["embodiment_running"]):
        return "worker_running", "An agent session is already running. The message is queued; an immediate reply is not guaranteed."
    if (str(agent["id"]), "task_message") in backoff:
        return "deferred_until_eligible", "Automatic replies are waiting after repeated attempts made no progress. Check Activity or use direct chat."
    parking = WorkflowParking(cur, str(agent["id"]))
    if task.get("workflow_id"):
        # The cached choice supplies the explanation; parked() remains authoritative,
        # including its stopped-worker continuation exception.
        choice = parking._choice(str(task["workflow_id"]), str(task["id"]))
        if choice is None:
            return "unknown", "Workflow eligibility could not be checked. Open the workflow controls."
        if parking.parked(task["id"]):
            reasons = [b["message"] for b in choice.get("blockers", []) if b.get("message")]
            return "deferred_until_eligible", " ".join(reasons) or "The workflow cannot give this task a turn yet. Open its workflow controls."
    if not can_wake:
        return "deferred_until_eligible", "Waiting for the agent’s current activity or short restart delay to clear."
    if not wake["headless_cwd"] and not wake["tmux_target"]:
        return "unknown", "The agent has no automatic launch setup. Open its direct chat or check its setup."
    return "deliverable_now", "This message can request an agent wake. Saving it does not confirm a launch or a reply."


def task_message_delivery(cur, task):
    cid, tid = str(task["container_id"]), str(task["id"])
    cur.execute("SELECT status,wakes_enabled FROM containers WHERE id=%s", (cid,))
    container = cur.fetchone()
    wakes = {str(w["id"]): w for w in list_wake_agents(cur, cid, 15)}
    backoff = fetch_active_backoff_map(cur, cid)
    recipients = []
    for row in message_recipients(cur, task):
        aid = str(row["agent_id"])
        cur.execute("SELECT id,alias,kind,terminated_at FROM agents WHERE id=%s", (aid,))
        agent = cur.fetchone()
        if not agent:
            continue
        state, reason = recipient_state(cur, task, agent, wakes.get(aid), container, backoff)
        recipients.append(MessageRecipientDelivery(
            agent_id=aid, alias=agent["alias"], state=state, reason=reason,
            direct_chat_href="/agents?" + urlencode({"cid": cid, "agent": agent["alias"], "tab": "conversation"})
            if agent["kind"] == "ai" and agent["terminated_at"] is None else None,
        ))
    finished = task["status"] in ("completed", "cancelled")
    state = "task_finished" if finished else "no_assignee" if not recipients else (
        recipients[0].state if len({r.state for r in recipients}) == 1 else "unknown")
    reason = ("This task is finished. Messages are saved without waking an agent." if finished else
              "No assignee will receive a wake. Assign an agent or contact one directly." if not recipients else
              "Delivery is checked separately for each assignee.")
    return TaskMessageDelivery(task_id=tid, state=state, reason=reason,
                              task_href="/tasks?" + urlencode({"cid": cid, "task": tid}), recipients=recipients)
