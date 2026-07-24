"""Resolve and launch interactive Claude or Codex sessions for ``orcha use``."""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import sys
from typing import Callable, Optional

RUNTIME_CLAUDE = "claude"
RUNTIME_CODEX = "codex"
ORCHA_CLAUDE_EXEC = "ORCHA_CLAUDE_EXEC"
ORCHA_CODEX_EXEC = "ORCHA_CODEX_EXEC"
CODEX_EXEC_FALLBACKS = (
    "/Applications/Codex.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "~/.local/bin/codex",
)


def live_boot_prefix(api_base, agent_id, *, get_json) -> Optional[str]:
    """Build best-effort cold-boot context from persona, digest, and conversation."""
    if not api_base or not agent_id:
        return None
    parts = []
    try:
        from orcha_cli import notifier

        persona = notifier._build_persona(api_base, agent_id)
        if persona:
            parts.append(persona)
    except Exception:
        pass
    try:
        from orcha_cli.conversation_prefix import format_conversation_history

        conversation = get_json(
            f"{api_base}/api/agents/{agent_id}/conversation", timeout=4.0
        )
        history = format_conversation_history((conversation or {}).get("turns") or [])
        if history:
            parts.append(history)
    except Exception:
        pass
    return "\n\n".join(parts) if parts else None


def normalize_runtime(runtime: Optional[str], model: Optional[str] = None) -> str:
    """Resolve an explicit runtime or infer one from the model family."""
    if runtime == RUNTIME_CODEX:
        return RUNTIME_CODEX
    if runtime == RUNTIME_CLAUDE:
        return RUNTIME_CLAUDE
    if model and not str(model).startswith("claude-"):
        return RUNTIME_CODEX
    return RUNTIME_CLAUDE


def executable_override(env_var: str) -> Optional[str]:
    """Resolve an executable override from PATH or an absolute file."""
    override = os.environ.get(env_var)
    if not override:
        return None
    if shutil.which(override):
        return override
    path = pathlib.Path(override).expanduser()
    return str(path) if path.is_file() and os.access(path, os.X_OK) else None


def runtime_executable(runtime: Optional[str]) -> str:
    """Return the conventional executable name for a runtime."""
    return "codex" if normalize_runtime(runtime) == RUNTIME_CODEX else "claude"


def resolve_runtime_executable(
    runtime: Optional[str], *, fallbacks=CODEX_EXEC_FALLBACKS
) -> Optional[str]:
    """Find the configured runtime executable without launching it."""
    runtime = normalize_runtime(runtime)
    leaf = runtime_executable(runtime)
    env_var = ORCHA_CODEX_EXEC if runtime == RUNTIME_CODEX else ORCHA_CLAUDE_EXEC
    override = executable_override(env_var)
    if override:
        return override
    if shutil.which(leaf):
        return leaf
    if runtime == RUNTIME_CODEX:
        for candidate in fallbacks:
            path = pathlib.Path(candidate).expanduser()
            if path.is_file() and os.access(path, os.X_OK):
                return str(path)
    return None


def build_live_argv(
    cold: bool,
    resume_sid: Optional[str],
    boot_prefix: Optional[str],
    model: Optional[str] = None,
    runtime: Optional[str] = None,
) -> list:
    """Build the runtime arguments for a cold boot or warm resume."""
    runtime = normalize_runtime(runtime, model)
    if runtime == RUNTIME_CODEX:
        argv = ["codex"]
        if cold:
            if model:
                argv += ["--model", model]
            if boot_prefix:
                argv.append(boot_prefix)
        elif resume_sid:
            argv += ["resume", resume_sid]
        return argv

    argv = ["claude"]
    if cold:
        if boot_prefix:
            argv += ["--append-system-prompt", boot_prefix]
        if model:
            argv += ["--model", model]
    elif resume_sid:
        argv += ["--resume", resume_sid]
    return argv


def live_agent_launch(api_base, agent_id, *, get_json) -> tuple[Optional[str], str]:
    """Fetch the selected model and runtime, failing open to Claude defaults."""
    if not api_base or not agent_id:
        return None, RUNTIME_CLAUDE
    try:
        persona = (
            get_json(f"{api_base}/api/agents/{agent_id}/persona", timeout=4.0) or {}
        )
        model = persona.get("model")
        return model, normalize_runtime(persona.get("model_runtime"), model)
    except Exception:
        return None, RUNTIME_CLAUDE


def _read_live_binding(
    cwd: pathlib.Path, binding_file: pathlib.Path
) -> tuple[dict, object]:
    """Read the local agent binding and project API base."""
    try:
        binding = json.loads(binding_file.read_text())
    except Exception:
        binding = {}
    api_base = None
    config_path = cwd / ".claude" / "orcha.json"
    if config_path.exists():
        try:
            api_base = json.loads(config_path.read_text()).get("api_base_url")
        except Exception:
            pass
    return binding, api_base


def _launch_selection(
    api_base, agent_id, *, agent_launch, normalize
) -> tuple[object, str]:
    """Prefer bridge-provided model data, otherwise query the persona endpoint."""
    env_runtime = os.environ.get("ORCHA_LIVE_RUNTIME")
    if env_runtime:
        env_model = os.environ.get("ORCHA_LIVE_MODEL") or None
        return env_model, normalize(env_runtime, env_model)
    model, runtime = agent_launch(api_base, agent_id)
    if model is None and api_base and agent_id:
        sys.stderr.write(
            "orcha live: could not resolve the agent's selected model from "
            f"{api_base}/api/agents/{agent_id}/persona — booting the runtime default "
            "instead. The terminal may not match the agent's configured model/runtime "
            "(#297).\n"
        )
    return model, runtime


def exec_live_session(
    cwd: pathlib.Path,
    alias: str,
    binding_file: pathlib.Path,
    *,
    boot_prefix: Callable,
    agent_launch: Callable,
    build_argv: Callable,
    resolve_executable: Callable,
    runtime_leaf: Callable,
    normalize: Callable,
) -> None:
    """Replace the current process with the selected interactive coding runtime."""
    binding, api_base = _read_live_binding(cwd, binding_file)
    agent_id = binding.get("agent_id")
    cold = os.environ.get("ORCHA_LIVE_COLD", "1") != "0"
    prefix = boot_prefix(api_base, agent_id) if cold else None
    live_model, runtime = _launch_selection(
        api_base, agent_id, agent_launch=agent_launch, normalize=normalize
    )
    argv = build_argv(
        cold,
        os.environ.get("ORCHA_LIVE_RESUME_SID"),
        prefix,
        live_model if cold else None,
        runtime,
    )
    exec_cmd = os.environ.get("ORCHA_LIVE_EXEC") or resolve_executable(runtime)
    if not exec_cmd:
        leaf = runtime_leaf(runtime)
        hint = (
            f" Install Codex CLI or set {ORCHA_CODEX_EXEC}=/absolute/path/to/codex."
            if runtime == RUNTIME_CODEX
            else (
                f" Install Claude Code or set "
                f"{ORCHA_CLAUDE_EXEC}=/absolute/path/to/claude."
            )
        )
        sys.exit(f"error: `{leaf}` not found — cannot start the live session.{hint}")
    if os.environ.get("ORCHA_LIVE_EXEC") and not shutil.which(exec_cmd):
        sys.exit(
            f"error: `{exec_cmd}` not found on PATH — cannot start the live session."
        )
    argv[0] = exec_cmd
    env = dict(os.environ)
    env["ORCHA_ALIAS"] = alias
    env["ORCHA_AGENT_RUNTIME"] = runtime
    os.execvpe(exec_cmd, argv, env)


def use_command(args, *, exec_session: Callable) -> None:
    """Print an alias export or become the agent inside a managed live terminal."""
    cwd = pathlib.Path.cwd()
    alias = args.alias
    binding_file = cwd / ".claude" / "orcha-tabs" / f"{alias}.json"
    if not binding_file.exists():
        sys.exit(
            f"error: no binding for alias '{alias}' in .claude/orcha-tabs/. "
            f"Register it first (/orcha-register-agent {alias} ...) or check "
            "the spelling."
        )
    if os.environ.get("ORCHA_LIVE"):
        exec_session(cwd, alias, binding_file)
        return
    print(f"export ORCHA_ALIAS={alias}")
