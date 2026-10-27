"""Inert workflow bootstrap: activation is the first action before task execution.

Read one JSON configuration from stdin, never from a shell command or prompt. The
notifier owns the process handle from creation; os.execvpe preserves that PID when
the authorized agent starts. Unknown/failed activation exits without running work.
"""

from __future__ import annotations

import json
import os
import secrets
import sys
import urllib.request


def activate_and_exec(config, *, post=None, exec_process=None, pid=None, process_key=None):
    """Injection points represent only the HTTP transport and final exec in tests."""
    run_id, aid = config["run_id"], config["agent_id"]
    process_key = process_key or secrets.token_hex(32)
    payload = {"permit": config["permit"], "process_key": process_key, "pid": pid or os.getpid()}
    if isinstance(config.get("run_details"), dict):
        payload["run_details"] = config["run_details"]
    url = config["api_base"].rstrip("/") + f"/api/agents/{aid}/runs/{run_id}/activate"
    if post is None:
        def post(url, payload):
            request = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.load(response)
    try:
        activated = post(url, payload)
        if (not activated or not activated.get("run_token") or activated.get("run_id") != run_id
                or activated.get("task_id") != config["task_id"] or activated.get("generation") != config["generation"]):
            return 75
    except Exception:
        # The server might have consumed the permit even if its response was lost.
        # Never try a new launch; the runner reconciles this exact preallocated run.
        return 75
    env = dict(os.environ)
    # Never forward the runner's scheduling credential into agent-controlled work.
    env.pop("ORCHA_WORKFLOW_RUNNER_TOKEN", None)
    env.pop("ORCHA_WORKFLOW_RUNNER_CREDENTIALS", None)
    env["ORCHA_RUN_TOKEN"] = activated["run_token"]
    env["ORCHA_WORKFLOW_RUN_ID"] = run_id
    env["ORCHA_WORKFLOW_TASK_ID"] = config["task_id"]
    env["ORCHA_WORKFLOW_GENERATION"] = str(config["generation"])
    command = config["command"]
    if not isinstance(command, list) or not command or not all(isinstance(arg, str) for arg in command):
        return 75
    (exec_process or os.execvpe)(command[0], command, env)
    return 0


def main():
    try:
        config = json.load(sys.stdin)
        return activate_and_exec(config)
    except Exception:
        return 75


if __name__ == "__main__":
    sys.exit(main())
