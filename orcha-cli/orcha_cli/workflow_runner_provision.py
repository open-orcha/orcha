"""Trusted local provisioning of Workflow launcher credentials (native projects only).

A Workflow worker is launched with a scoped runner credential (see
``portal_backend/workflow_worker_launch.require_runner``). There is deliberately no
web endpoint that creates one. On a native project the notifier runs as the person who
owns the project's database file, so it records the credential there directly: no new
network surface, and a hosted/Docker deployment (no local database file) is unchanged
and still needs ``ORCHA_WORKFLOW_RUNNER_CREDENTIALS``.

Only a SHA-256 of the secret is stored in the database; the secret itself is cached in
``.orcha/workflow-runner-credentials.json`` (0600) so a notifier restart reuses it.
"""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import secrets
import sqlite3
from uuid import uuid4

from . import cli_runtime_mode

CACHE_NAME = "workflow-runner-credentials.json"
RUNNER_INSTANCE = "local-notifier"
ENV_FIX = (
    "Set ORCHA_WORKFLOW_RUNNER_CREDENTIALS (a JSON map of agent id to launcher secret) "
    "for the notifier, using a credential your Orcha administrator provisioned."
)


class Unavailable(Exception):
    """Local provisioning cannot proceed; ``reason`` and ``fix`` are plain English."""

    def __init__(self, reason: str, fix: str):
        super().__init__(reason)
        self.reason = reason
        self.fix = fix


def digest(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def find_project(start, api_base: str) -> pathlib.Path | None:
    """The native project folder at or above ``start`` that serves ``api_base``.

    The API address must match so a notifier can never write into another project's
    database; a worktree's own orcha.json is skipped because it has no database file.
    """
    if not start:
        return None
    here = pathlib.Path(start).resolve()
    for root in (here, *here.parents):
        cfg = cli_runtime_mode.read_config(root)
        if (
            cli_runtime_mode.is_native_project(root, cfg)
            and str(cfg.get("api_base_url") or "").rstrip("/") == api_base.rstrip("/")
            and cli_runtime_mode.db_path(root, cfg).is_file()
        ):
            return root
    return None


def _load(cache: pathlib.Path) -> dict:
    try:
        data = json.loads(cache.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _store(cache: pathlib.Path, data: dict) -> None:
    cache.parent.mkdir(parents=True, exist_ok=True)
    tmp = cache.with_name(cache.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(data, handle)
    os.replace(tmp, cache)


def ensure_secret(start, api_base: str, agent_id: str) -> str:
    """The launcher secret for a live AI agent, registering one if needed.

    Raises :class:`Unavailable` with the reason and the fix when this is not a local
    native project, the agent is not an active AI teammate, or a person revoked the
    credential (a revoked credential is never replaced automatically).
    """
    root = find_project(start, api_base)
    if root is None:
        raise Unavailable(
            "this Orcha is not a local project folder the notifier can set up itself",
            ENV_FIX,
        )
    db = cli_runtime_mode.db_path(root, cli_runtime_mode.read_config(root))
    con = sqlite3.connect(str(db), timeout=10)
    try:
        con.execute("PRAGMA foreign_keys=ON")
        agent = con.execute(
            "SELECT container_id, kind, terminated_at FROM agents WHERE id=?", (agent_id,)
        ).fetchone()
        if not agent or agent[1] != "ai" or agent[2] is not None:
            raise Unavailable(
                "the assigned teammate is not an active AI agent",
                "Assign the task to an active AI agent.",
            )
        cache = root / ".orcha" / CACHE_NAME
        known = _load(cache)
        secret = known.get(agent_id)
        if isinstance(secret, str) and secret:
            row = con.execute(
                "SELECT revoked_at FROM workflow_runner_credentials "
                "WHERE token_sha256=? AND agent_id=?",
                (digest(secret), agent_id),
            ).fetchone()
            if row and row[0] is None:
                return secret
            if row:
                raise Unavailable(
                    "the launcher credential for this agent was revoked",
                    "Delete its entry from .orcha/" + CACHE_NAME + " to let Orcha set up a new one.",
                )
        secret = secrets.token_urlsafe(32)
        # Cache first: an unregistered cached secret is re-registered next time, while a
        # registered secret nobody holds would be unusable.
        _store(cache, {**known, agent_id: secret})
        with con:
            con.execute(
                "INSERT INTO workflow_runner_credentials"
                "(id, container_id, agent_id, runner_instance, token_sha256) "
                "VALUES (?, ?, ?, ?, ?)",
                (str(uuid4()), agent[0], agent_id, RUNNER_INSTANCE, digest(secret)),
            )
        return secret
    except sqlite3.Error as exc:
        raise Unavailable(
            f"the project's database could not be updated ({exc})",
            "Check that `orcha up` is running and the project's .orcha folder is writable.",
        ) from exc
    finally:
        con.close()
