"""Workflow admission transport for the existing notifier (no second daemon).

All legacy/manual/resident/remote paths must refuse workflow work unless they call
this adapter. Unknown capability/membership responses are not permission to spawn.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from uuid import uuid4

_REFUSALS = {}  # agent_id -> (reason, fix) from the latest refused launch
_NOTICE_TS = {}  # (agent_id, task_id) -> monotonic time of the last thread note
_LOGGED = {}  # (agent_id, task_id) -> the refusal reason last written to the notifier log
NOTICE_INTERVAL_SECS = 30 * 60
_FIXES = {
    "runner_agent_invalid": "Assign the task to an active AI agent.",
    "runner_revoked": "Whoever turned launching off for this agent has to turn it back on.",
}
_TRANSPORT_REFUSALS = {
    "tmux": ("this agent has an open terminal session, and Workflow tasks only start in a background worker",
             "Close the agent's terminal session so Orcha can start it in the background."),
    "unreachable": ("Orcha has no background working folder recorded for this agent",
                    "Relaunch with orcha up so the agent gets one."),
}


def _refuse(agent_id, reason, fix):
    _REFUSALS[agent_id] = (reason, fix)
    return None


def _task_id(candidate):
    return candidate.get("context_task_id") or next(iter(candidate.get("auto_start_task_ids") or []), None) or candidate.get("wake_task_id")


def _refusal_detail(exc):
    """(code, plain-English message) from an Orcha error response, or (None, None).

    A not_eligible refusal names its blockers; the generic "not waiting" one only
    restates the refusal, so the specific blockers are what the person needs to see.
    """
    try:
        detail = json.load(exc).get("detail")
    except (ValueError, AttributeError, OSError):
        return None, None
    if not isinstance(detail, dict):
        return None, None
    message = detail.get("message")
    blockers = [b for b in detail.get("blockers") or [] if isinstance(b, dict) and b.get("message")]
    specific = [b for b in blockers if b.get("code") != "task_not_waiting"] or blockers
    if message and specific:
        message = message.rstrip(".") + ": " + " ".join(b["message"] for b in specific)
    return detail.get("code"), message


def refuse_transport(candidate, kind):
    """Record why a Workflow wake was skipped before any launch was attempted."""
    reason, fix = _TRANSPORT_REFUSALS.get(kind, _TRANSPORT_REFUSALS["unreachable"])
    return _refuse(candidate["agent_id"], reason, fix)


def announce_refusal(api_base, candidate, post_json, *, quiet=False, log=None):
    """Say why a Workflow task could not launch, in the log and on the task thread.

    A refusal that only cools the agent down looks like nothing happened, so the person
    who started the Workflow gets the reason and the fix (at most once per interval).
    ``log`` writes the notifier log even in quiet mode; a reason is written once until
    it changes, because the scan repeats every few seconds.
    """
    aid = candidate["agent_id"]
    refusal = _REFUSALS.pop(aid, None)
    if not refusal:
        return False
    reason, fix = refusal
    task_id = _task_id(candidate)
    line = f"{candidate.get('alias')}: Workflow task {task_id} not launched: {reason}. {fix}"
    if log is not None and _LOGGED.get((aid, task_id)) != reason:
        _LOGGED[(aid, task_id)] = reason
        log(line)
    elif log is None and not quiet:
        print(f"[notifier] {line}", file=sys.stderr)
    last = _NOTICE_TS.get((aid, task_id))
    if not task_id or (last is not None and time.monotonic() - last < NOTICE_INTERVAL_SECS):
        return False
    _NOTICE_TS[(aid, task_id)] = time.monotonic()
    # No author: a system note. Posted as the assignee it would be the task's earliest
    # assignee message, i.e. its plan, and the real plan would then wait for approval.
    post_json(f"{api_base}/api/tasks/{task_id}/messages", {
        "body": f"Orcha could not start this task automatically: {reason}. {fix}",
        "system_notice": True,
    })
    return True


def runner_post(url, body, headers):
    request = urllib.request.Request(url, data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json", **headers})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def reserve_candidate(api_base, candidate):
    """Reserve a fresh turn, or continue the turn a stopped worker still holds.

    A worker that exits mid-turn (e.g. to wait for an answer) keeps the turn, so a new
    event for that task must continue it: a fresh reserve is refused while it is live.
    """
    aid = candidate["agent_id"]
    task_id = _task_id(candidate)
    previous_run = candidate.get("workflow_continue_run_id")
    if previous_run:
        # One key per stopped worker: a lost response replays the same receipt.
        url = f"{api_base}/api/agents/{aid}/runs/{previous_run}/continue-reserve"
        body = {"operation_key": f"continue:{previous_run}"}
    else:
        url = f"{api_base}/api/agents/{aid}/runs/reserve"
        body = {"task_id": task_id, "expected_workflow_revision": candidate.get("workflow_revision"),
                "expected_work_revision": candidate.get("workflow_work_revision"),
                "operation_key": candidate.setdefault("_workflow_launch_key", str(uuid4()))}
    try:
        reserved = runner_post(url, body, {})
        if not reserved or reserved.get("task_id") != task_id or not reserved.get("permit"):
            return None
        _LOGGED.pop((aid, task_id), None)  # a later refusal is news again
        return {**reserved, "agent_id": aid, "api_base": api_base}
    except urllib.error.HTTPError as exc:
        code, message = _refusal_detail(exc)
        if message:
            return _refuse(aid, message.rstrip("."), _FIXES.get(code, "Refresh the Workflow page to see its current state."))
        return None
    except Exception:
        return None


def abort_reserved(launch):
    try:
        result = runner_post(f"{launch['api_base']}/api/agents/{launch['agent_id']}/runs/{launch['run_id']}/abort-launch", {}, {})
        return result.get("state") == "aborted"
    except Exception:
        return False


def confirm_exit(api_base, aid, worker):
    """Only a locally tracked process with a positive exit observation qualifies."""
    if not worker.get("workflow") or worker.get("sandbox_container_id"):
        return False
    process = worker.get("proc")
    if process is None or process.poll() is None:
        return False
    try:
        runner_post(f"{api_base}/api/agents/{aid}/runs/{worker['run_id']}/confirm-stopped",
                    {"generation": worker["workflow_generation"]}, {})
        return True
    except Exception:
        return False


def reserve_then_spawn(*, api_base, agent_id, task_id, workflow_revision, work_revision,
                       operation_key, command, post, prepare, spawn=None):
    """Reserve -> prepare checkout -> inert bootstrap. Return the preallocated ID.

    post accepts url, body, headers and returns a decoded response or raises. Callers
    persist operation_key across retries. A spawn exception is treated as uncertain;
    only the server's unconsumed-permit test may release that reservation.
    """
    headers = {}
    body = {"task_id": task_id, "expected_workflow_revision": workflow_revision,
            "expected_work_revision": work_revision, "operation_key": operation_key}
    reserved = post(f"{api_base}/api/agents/{agent_id}/runs/reserve", body, headers)
    if not reserved or not all(reserved.get(k) for k in ("run_id", "execution_id", "generation", "permit")) or reserved.get("task_id") != task_id:
        return None
    run_id = reserved["run_id"]
    process = None
    try:
        cwd = prepare()
        config = {**reserved, "api_base": api_base, "agent_id": agent_id, "command": command}
        process = (spawn or subprocess.Popen)([sys.executable, "-m", "orcha_cli.workflow_bootstrap"],
                                              cwd=cwd, stdin=subprocess.PIPE, text=True)
        process.stdin.write(json.dumps(config))
        process.stdin.close()
        return {"proc": process, "run_id": run_id, "execution_id": reserved["execution_id"],
                "generation": reserved["generation"], "workflow": True}
    except Exception:
        # No assumption that the process disappeared; an accepted activation makes
        # abort return launch_uncertain, retaining the slot for confirmed stop.
        try:
            post(f"{api_base}/api/agents/{agent_id}/runs/{run_id}/abort-launch", {}, headers)
        except Exception:
            pass
        return {"proc": process, "run_id": run_id, "workflow": True, "recovery_needed": True}
