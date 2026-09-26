"""Manage live-terminal worktrees, leases, tokens, and worker-run records."""

from . import notifier

LIVE_LEASE_TTL_SECS = 180
LIVE_RUN_OUTPUT_CAP = 200_000


def safe_teardown_worktree(base_cwd, worktree, branch):
    """Remove a clean live worktree while preserving uncommitted human work."""
    if not worktree:
        return "noop"
    rc, output = notifier._run_git(["status", "--porcelain"], cwd=worktree)
    if rc == 0 and output.strip():
        return "preserved-dirty"
    notifier._teardown_worktree(base_cwd, worktree, branch)
    return "removed"


def mint_live_token(api_base, aid):
    """Mint a best-effort work-lane token for a live terminal."""
    token = notifier._post_json(
        f"{api_base}/api/agents/{aid}/embodiment-tokens",
        {"lane": "work", "kind": "live"},
    )
    return (token or {}).get("run_token")


def revoke_live_token(api_base, token):
    """Revoke a live token when the session finally retires."""
    if token:
        notifier._post_json(f"{api_base}/api/embodiment-tokens/{token}/revoke", {})


def claim_live_lease(api_base, aid, preempt=False):
    """Claim the agent's single live embodiment lease."""
    return notifier._post_json(
        f"{api_base}/api/agents/{aid}/wake-claim",
        {
            "lease_ttl": LIVE_LEASE_TTL_SECS,
            "kind": "live",
            "lease_kind": "live",
            "event": "live_terminal",
            "preempt": bool(preempt),
            "lane": "work",
        },
    )


def renew_live_lease(api_base, aid):
    return notifier._post_json(
        f"{api_base}/api/agents/{aid}/wake-renew",
        {
            "lease_ttl": LIVE_LEASE_TTL_SECS,
            "lease_kind": "live",
            "lane": "work",
        },
    )


def release_live_lease(api_base, aid):
    return notifier._post_json(
        f"{api_base}/api/agents/{aid}/wake-ack",
        {
            "kind": "live",
            "release_lease": True,
            "event": "live_terminal_closed",
            "lane": "work",
        },
    )


def start_live_run(api_base, aid, wake_event="live_terminal", pid=None, token_id=None):
    """Create a best-effort worker-run audit record."""
    run = notifier._post_json(
        f"{api_base}/api/agents/{aid}/runs",
        {
            "wake_kind": "live",
            "wake_event": wake_event,
            "lane": "work",
            "pid": pid,
            "token_id": token_id,
        },
    )
    return (run or {}).get("run_id")


def finish_live_run(api_base, run_id, status="exited", output=None, exit_code=None):
    """Finish a worker-run record with a bounded transcript."""
    if not run_id:
        return
    if output is not None and len(output) > LIVE_RUN_OUTPUT_CAP:
        output = "...[truncated]...\n" + output[-LIVE_RUN_OUTPUT_CAP:]
    notifier._post_json(
        f"{api_base}/api/runs/{run_id}/finish",
        {"status": status, "exit_code": exit_code, "output": output},
    )
