"""GH #301: decide whether a conversation worker can start before claiming its lease.

A project folder can sit inside a Git repository it does not own (LearnChat inside an
empty ``~/Documents`` repository), or own a repository that has no first commit yet.
Neither can host the isolated resident checkout a conversation worker requires, and the
old path discovered that only after claiming the conversation lease — so it failed
silently every ~3 seconds while the portal showed the agent as Busy. This module checks
first, names the blocker in plain words, and spaces out the retries. Pending human turns
are never acknowledged here, so they are answered once the blocker is fixed.
"""

from __future__ import annotations

import os
import sys
import time
from typing import Any

from . import notifier_worktree_base as _worktree_base

BACKOFF_FIRST_SECS = 5.0
BACKOFF_MAX_SECS = 120.0

# conversation_id -> {"failures", "next_attempt", "reason"}. Process-local: a daemon
# restart simply retries once, then backs off again.
_BACKOFF: dict[str, dict[str, Any]] = {}

ISOLATION_FAILED = (
    "Orcha could not create the separate checkout for this chat in {base_cwd} "
    "(no usable origin/main, HEAD or existing branch). It will not run in the shared "
    "folder instead. Pending messages stay queued."
)


def _real(path) -> str:
    return os.path.realpath(os.path.expanduser(str(path)))


def repository_state(base_cwd, services: Any) -> dict[str, Any]:
    """Classify the project folder for resident-checkout startup.

    Returns ``{"state": ..., "toplevel": ..., "detail": ...}`` where state is one of:
    ``no_git`` (run in the folder, as non-Git projects always have), ``ready`` (a
    checkout can be provisioned), ``ancestor_repo`` (Git found a repository in a parent
    folder — empty or not — rather than one rooted at the project folder), or
    ``no_commit`` (the project's own repository has no commit yet). Read-only: only
    ``rev-parse`` is run.
    """
    # Same detection the starters use to decide on isolation, so both agree on "no Git".
    if not base_cwd or not services._is_git_repo(base_cwd):
        return {"state": "no_git", "toplevel": None, "detail": None}
    # Prefer the daemon's seam; minimal service stand-ins fall back to plain Git.
    run_git = getattr(services, "_run_git", None) or _worktree_base.run_git
    code, out = run_git(["rev-parse", "--show-toplevel"], cwd=base_cwd)
    if code != 0 or not out.strip():
        return {"state": "no_git", "toplevel": None, "detail": None}
    toplevel = out.strip()
    has_commit = (
        run_git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], cwd=base_cwd)[0]
        == 0
    )
    if _real(toplevel) != _real(base_cwd):
        # Any repository ABOVE the project folder belongs to someone else. Making a
        # resident checkout there would add a branch and a worktree entry to that
        # parent's .git, so it blocks whether or not the parent has commits.
        found = (
            "a Git repository with saved history"
            if has_commit
            else "an empty Git repository with no commits"
        )
        return {
            "state": "ancestor_repo",
            "toplevel": toplevel,
            "detail": (
                f"The project folder {base_cwd} is not its own Git repository, and Git "
                f"found {found} in a parent folder ({toplevel}). Orcha will not create "
                "branches or checkouts in that parent repository. To fix: run "
                "`git init` in the project folder and make a first commit there (or "
                "point the project at a folder outside that parent repository). "
                "Pending messages stay queued and are answered once fixed."
            ),
        }
    if has_commit:
        return {"state": "ready", "toplevel": toplevel, "detail": None}
    return {
        "state": "no_commit",
        "toplevel": toplevel,
        "detail": (
            f"The project's Git repository ({toplevel}) has no commits yet, so Orcha "
            "cannot create the separate checkout a chat worker needs. To fix: make a "
            "first commit in the project. Pending messages stay queued and are "
            "answered once it exists."
        ),
    }


def in_backoff(conv_id, now: float | None = None) -> bool:
    """Whether a previous startup failure says to wait before trying this conversation."""
    entry = _BACKOFF.get(conv_id)
    return entry is not None and (now or time.time()) < entry["next_attempt"]


def record_failure(conv_id, reason, now: float | None = None) -> tuple[float, bool]:
    """Push the next attempt out (5s doubling to 2 min). Returns (delay, reason_changed)."""
    entry = _BACKOFF.get(conv_id)
    failures = (entry["failures"] if entry else 0) + 1
    # Cap the exponent: an unbounded 2**n overflows float after ~1024 failures (~34h at
    # the 2-minute ceiling) and would turn every later tick into an exception.
    delay = min(BACKOFF_FIRST_SECS * (2 ** min(failures - 1, 16)), BACKOFF_MAX_SECS)
    changed = entry is None or entry.get("reason") != reason
    _BACKOFF[conv_id] = {
        "failures": failures,
        "next_attempt": (now or time.time()) + delay,
        "reason": reason,
    }
    return delay, changed


def record_success(conv_id) -> None:
    _BACKOFF.pop(conv_id, None)


def report_failure(
    services,
    api_base,
    candidate,
    conv_id,
    *,
    kind,
    reason,
    release_lease,
    quiet,
) -> None:
    """Persist an actionable startup failure (even in quiet mode) and back off.

    The ``woken`` audit row carries ``detail`` so the reason survives a quiet daemon.
    The reason is printed to stderr whenever it changes, not on every retry.
    """
    delay, changed = record_failure(conv_id, reason)
    services._post_json(
        f"{api_base}/api/agents/{candidate['agent_id']}/wake-ack",
        {
            "kind": kind,
            "event": "conversation_turn",
            "release_lease": release_lease,
            "lane": "conversation",
            "detail": (reason or "")[:1000] or None,
        },
    )
    if changed or not quiet:
        print(
            f"[notifier] conversation startup blocked for "
            f"{candidate.get('agent_alias')} — {reason} (retrying in {delay:.0f}s)",
            file=sys.stderr,
        )


def preflight(services, api_base, conv_id, candidate, *, base_cwd, quiet, kind) -> bool:
    """Return True when startup may proceed to the lease claim.

    Called BEFORE wake-claim: a blocked repository never takes the conversation lease,
    so the agent is not shown as Busy and no lease churn happens between retries.
    """
    if in_backoff(conv_id):
        return False
    state = repository_state(base_cwd, services)
    # Worktrees are always on (migration 072), so a Git project folder always needs a usable
    # commit to branch from, and a parent repository is never ours to branch in.
    if state["state"] in ("ancestor_repo", "no_commit"):
        report_failure(
            services,
            api_base,
            candidate,
            conv_id,
            kind=kind,
            reason=state["detail"],
            release_lease=False,
            quiet=quiet,
        )
        return False
    return True
