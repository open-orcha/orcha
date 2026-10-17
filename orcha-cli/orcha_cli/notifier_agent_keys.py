"""Agent runs on an API key: put a project's opted-in provider key into the worker env.

For users with NO Claude/ChatGPT subscription (migration 071, `use_for_agents`). The portal's
wake-scan carries, per agent runtime, the project's stored provider key SEALED (`agent_keys_enc`:
{"claude": "v1:…" | None, "codex": "v1:…" | None}) — the same discipline as the triage/ack keys.
This module remembers that ciphertext per container and, at spawn time only, opens it in memory
and writes it into the child env dict handed to Popen:

  * Claude runtime → ANTHROPIC_API_KEY=<key>; CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_AUTH_TOKEN are
    dropped so the API key is the only credential (Claude Code ranks ANTHROPIC_AUTH_TOKEN above
    ANTHROPIC_API_KEY, and an OAuth token is a subscription login).
  * Codex runtime  → CODEX_API_KEY=<key> and OPENAI_API_KEY=<key> (codex-cli 0.160 accepts either
    as environment auth — `codex doctor`: "auth is provided by environment" — and env auth wins
    over a stored ChatGPT login); CODEX_ACCESS_TOKEN is dropped for the same reason.

Never touches the daemon's own os.environ, so nothing else the daemon spawns (previews, git,
hooks) sees the key, and nothing here logs, prints or returns it. When a runtime has no opted-in
key, or the scan never mentioned agent keys (older portal), the env is left exactly as it was:
subscription first, nothing injected.
"""

from __future__ import annotations

import pathlib
import sys
from typing import Any, MutableMapping, Optional

RUNTIME_CLAUDE = "claude"
RUNTIME_CODEX = "codex"

# runtime -> (env vars that receive the key, competing credentials to drop)
_INJECT = {
    RUNTIME_CLAUDE: (
        ("ANTHROPIC_API_KEY",),
        ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"),
    ),
    RUNTIME_CODEX: (
        ("CODEX_API_KEY", "OPENAI_API_KEY"),
        ("CODEX_ACCESS_TOKEN",),
    ),
}

# container_id -> {runtime: sealed blob or None}. Ciphertext only; refreshed by every wake scan.
_SEALED: dict[str, dict[str, Optional[str]]] = {}
# runtimes whose blob could not be opened, so the warning prints once per (cid, runtime, blob).
_WARNED: set = set()


def reset() -> None:
    """Forget remembered keys (tests and daemon restarts)."""
    _SEALED.clear()
    _WARNED.clear()


def remember(container_id: Optional[str], scan: Optional[dict]) -> None:
    """Record the sealed agent keys a wake scan carried. A scan without the field (an older
    portal) records nothing, so behaviour stays exactly as before."""
    if not container_id or not isinstance(scan, dict) or "agent_keys_enc" not in scan:
        return
    raw = scan.get("agent_keys_enc")
    blobs = raw if isinstance(raw, dict) else {}
    _SEALED[str(container_id)] = {
        runtime: (blobs.get(runtime) if isinstance(blobs.get(runtime), str) else None)
        for runtime in _INJECT
    }


def _container_for(cwd, services: Any) -> Optional[str]:
    """The container a spawn belongs to: the cwd's own .claude/orcha.json, else its workspace
    root's (a task worktree carries no orcha.json), else the only container this daemon serves."""
    resolve = getattr(services, "_container_id_for", None)
    if cwd and resolve is not None:
        path = pathlib.Path(cwd)
        candidates = [path]
        try:
            from . import sandbox as _sandbox

            root = _sandbox.workspace_root_for(path)
            if root != path:
                candidates.append(root)
        except Exception:  # noqa: BLE001 - resolution is best-effort
            pass
        for candidate in candidates:
            try:
                cid = resolve(candidate)
            except Exception:  # noqa: BLE001
                cid = None
            if cid and cid in _SEALED:
                return cid
    if len(_SEALED) == 1:
        return next(iter(_SEALED))
    return None


def sealed_for(runtime: Optional[str], cwd, services: Any) -> Optional[str]:
    """The sealed key opted in for `runtime` on the spawn's container, or None."""
    if runtime not in _INJECT:
        return None
    cid = _container_for(cwd, services)
    if cid is None:
        return None
    return _SEALED.get(cid, {}).get(runtime)


def _open(blob: str, services: Any) -> Optional[str]:
    box = getattr(services, "_secret_box", None)
    if box is None:
        return None
    try:
        key = box.unseal(blob)
    except Exception:  # noqa: BLE001 - no master key / tampered blob → no injection
        return None
    return key if isinstance(key, str) and key.strip() else None


def inject(
    env: MutableMapping[str, str],
    runtime: Optional[str],
    cwd,
    services: Any,
    *,
    quiet: bool = False,
) -> bool:
    """Put the opted-in API key for `runtime` into `env` (the child env dict). Returns whether a
    key was injected. Off / no key / unopenable → env untouched, False."""
    blob = sealed_for(runtime, cwd, services)
    if not blob:
        return False
    key = _open(blob, services)
    if key is None:
        marker = (runtime, blob[-12:])
        if marker not in _WARNED:
            _WARNED.add(marker)
            if not quiet:
                print(
                    f"[notifier] agent API key for the {runtime} runtime could not be opened "
                    "(ORCHA_SECRET_KEY missing or changed) — this run uses the CLI's own login",
                    file=sys.stderr,
                )
        return False
    targets, competing = _INJECT[runtime]
    for name in competing:
        env.pop(name, None)
    for name in targets:
        env[name] = key
    return True
