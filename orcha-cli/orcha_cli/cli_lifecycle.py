"""Implement self-wake scheduling and human-controlled container lifecycle commands."""

from __future__ import annotations

import json
import os
import pathlib
import re
import sys
from typing import Callable, Optional
from urllib.parse import urlencode


_SELF_WAKE_DURATION_RE = re.compile(r"^\s*(\d+)\s*([smhSMH]?)\s*$")


def parse_self_wake_delay(raw: str) -> int:
    """Convert the public duration syntax to a validated number of seconds."""
    match = _SELF_WAKE_DURATION_RE.match(raw or "")
    if not match:
        raise SystemExit("error: --in must look like 90s, 10m, or 2h")
    amount = int(match.group(1))
    unit = (match.group(2) or "s").lower()
    seconds = amount * {"s": 1, "m": 60, "h": 3600}[unit]
    if seconds < 60:
        raise SystemExit("error: self-wake delay must be at least 60 seconds")
    if seconds > 86_400:
        raise SystemExit("error: self-wake delay must be no more than 24 hours")
    return seconds


def read_project_api_base(cwd: pathlib.Path) -> str:
    """Read and validate the API address for the project in ``cwd``."""
    config_path = cwd / ".claude" / "orcha.json"
    if not config_path.exists():
        sys.exit(
            "error: no .claude/orcha.json in CWD. Run from an Orcha project, or connect this "
            "folder with `orcha connect`."
        )
    config = json.loads(config_path.read_text())
    api_base = config.get("api_base_url")
    if not api_base:
        sys.exit("error: api_base_url missing from .claude/orcha.json")
    return api_base.rstrip("/")


def self_wake_request(
    url: str, *, method: str, body: Optional[dict] = None
) -> dict:
    """Send an authenticated request to the work-lane self-wake endpoint."""
    import urllib.error
    import urllib.request

    token = os.environ.get("ORCHA_RUN_TOKEN")
    if not token:
        sys.exit("error: self-wake is work-lane only and needs ORCHA_RUN_TOKEN")
    headers = {"X-Orcha-Run-Token": token}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        sys.exit(
            f"error: HTTP {exc.code} from {url}\n"
            f"{exc.read().decode(errors='replace')}"
        )
    except urllib.error.URLError as exc:
        sys.exit(f"error: cannot reach {url} — is the stack up? ({exc.reason})")


def self_wake_command(
    args,
    *,
    require_binding: Callable,
    parse_delay: Callable[[str], int] = parse_self_wake_delay,
    read_api_base: Callable[[pathlib.Path], str] = read_project_api_base,
    request: Callable = self_wake_request,
) -> None:
    """Schedule or cancel a one-shot task resume wake for the acting work agent."""
    if os.environ.get("ORCHA_CONVERSATION_WORKER"):
        sys.exit("error: self-wake is for work-lane task workers, not conversation workers")
    cwd = pathlib.Path.cwd()
    binding = require_binding(cwd, args.alias, verb="orcha self-wake")
    agent_id = binding["agent_id"]
    api_base = read_api_base(cwd)

    if args.all and args.cancel_task_id is None:
        sys.exit("error: --all is only valid with --cancel")
    if args.cancel_task_id is not None:
        task_id = args.cancel_task_id or args.task_id
        if args.all:
            query = urlencode({"all": "true"})
        else:
            if not task_id:
                sys.exit("error: pass a task id with --cancel, or use --all")
            query = urlencode({"task_id": task_id})
        data = request(
            f"{api_base}/api/agents/{agent_id}/self-wake?{query}", method="DELETE"
        )
        print(f"cancelled {data.get('deleted', 0)} scheduled wake(s)")
        return

    if not args.task_id:
        sys.exit("error: task_id is required")
    if not args.delay:
        sys.exit("error: --in is required")
    context = (args.context or "").strip()
    if not context:
        sys.exit("error: --context must be non-empty")
    data = request(
        f"{api_base}/api/agents/{agent_id}/self-wake",
        method="POST",
        body={
            "task_id": args.task_id,
            "delay_secs": parse_delay(args.delay),
            "context": context,
        },
    )
    print(
        f"scheduled one-shot wake for {data.get('resume_at', '?')}. "
        "Exit now instead of polling."
    )


def lifecycle_call(
    container_id: Optional[str],
    new_status: str,
    verb: str,
    *,
    resolve_human_agent_id: Callable[[pathlib.Path], str],
) -> None:
    """Apply a human-authorized status transition to an Orcha container."""
    import urllib.error
    import urllib.request

    cwd = pathlib.Path.cwd()
    config_path = cwd / ".claude" / "orcha.json"
    if not config_path.exists():
        sys.exit(
            "error: no .claude/orcha.json in CWD. cd to your project root (the dir where "
            "`orcha init` was run), or use a slash skill from inside Claude Code."
        )
    config = json.loads(config_path.read_text())
    api_base = config.get("api_base_url")
    if not api_base:
        sys.exit(
            "error: api_base_url missing from .claude/orcha.json — "
            "re-init with `orcha init --force`?"
        )
    container = container_id or config.get("current_container_id")
    if not container:
        sys.exit(
            "error: no container_id given and no current_container_id in "
            f".claude/orcha.json. Pass it as: `orcha {verb} <container_id>`."
        )
    actor_agent_id = resolve_human_agent_id(cwd)
    url = f"{api_base}/api/containers/{container}/status"
    body = json.dumps({"status": new_status, "actor_agent_id": actor_agent_id}).encode()
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            data = json.loads(response.read())
    except urllib.error.HTTPError as exc:
        sys.exit(
            f"error: HTTP {exc.code} from {url}\n"
            f"{exc.read().decode(errors='replace')}"
        )
    except urllib.error.URLError as exc:
        sys.exit(f"error: cannot reach {url} — is the stack up? ({exc.reason})")

    print(f"container {container}: {data.get('from', '?')} → {data.get('status', '?')}")
