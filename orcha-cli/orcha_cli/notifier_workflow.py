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
NOTICE_INTERVAL_SECS = 30 * 60
_FIXES = {
    "runner_agent_invalid": "Assign the task to an active AI agent.",
    "runner_revoked": "Whoever turned launching off for this agent has to turn it back on.",
}


def _refuse(agent_id, reason, fix):
    _REFUSALS[agent_id] = (reason, fix)
    return None


def _refusal_detail(exc):
    """(code, plain-English message) from an Orcha error response, or (None, None)."""
    try:
        detail = json.load(exc).get("detail")
    except (ValueError, AttributeError, OSError):
        return None, None
    if isinstance(detail, dict):
        return detail.get("code"), detail.get("message")
    return None, None


def announce_refusal(api_base, candidate, post_json, *, quiet=False):
    """Say why a Workflow task could not launch, in the log and on the task thread.

    A refusal that only cools the agent down looks like nothing happened, so the person
    who started the Workflow gets the reason and the fix (at most once per interval).
    """
    aid = candidate["agent_id"]
    refusal = _REFUSALS.pop(aid, None)
    if not refusal:
        return False
    reason, fix = refusal
    if not quiet:
        print(f"[notifier] {candidate.get('alias')}: Workflow task not launched: {reason}. {fix}", file=sys.stderr)
    task_id = candidate.get("context_task_id") or next(iter(candidate.get("auto_start_task_ids") or []), None) or candidate.get("wake_task_id")
    last = _NOTICE_TS.get((aid, task_id))
    if not task_id or (last is not None and time.monotonic() - last < NOTICE_INTERVAL_SECS):
        return False
    _NOTICE_TS[(aid, task_id)] = time.monotonic()
    post_json(f"{api_base}/api/tasks/{task_id}/messages", {
        "author_agent_id": aid,
        "body": f"Orcha could not start this task automatically: {reason}. {fix}",
    })
    return True


def runner_post(url, body, headers):
    request = urllib.request.Request(url, data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json", **headers})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def reserve_candidate(api_base, candidate):
    aid = candidate["agent_id"]
    task_id = candidate.get("context_task_id") or next(iter(candidate.get("auto_start_task_ids") or []), None) or candidate.get("wake_task_id")
    body = {"task_id": task_id, "expected_workflow_revision": candidate.get("workflow_revision"),
            "expected_work_revision": candidate.get("workflow_work_revision"),
            "operation_key": candidate.setdefault("_workflow_launch_key", str(uuid4()))}
    try:
        reserved = runner_post(f"{api_base}/api/agents/{aid}/runs/reserve", body, {})
        if not reserved or reserved.get("task_id") != task_id or not reserved.get("permit"):
            return None
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
