"""Build and launch warm stdin-driven Claude conversation workers."""

from __future__ import annotations

import pathlib
from typing import Optional


def spawn_resident(
    cwd: str,
    *,
    system_prompt: Optional[str] = None,
    log_path: Optional[pathlib.Path] = None,
    resume_session_id: Optional[str] = None,
    alias: Optional[str] = None,
    flags: Optional[str] = None,
    model: Optional[str] = None,
    reasoning_effort: Optional[str] = None,
    runtime: Optional[str] = None,
    run_token: Optional[str] = None,
    conversation: bool = False,
    dry_run: bool = False,
    services,
) -> tuple[bool, str, object]:
    """Launch a warm resident while resolving patchable services through the facade."""
    runtime = services._normalize_runtime(runtime)
    if runtime != services.RUNTIME_CLAUDE:
        repr_ = (
            f"(cd {cwd} && ORCHA_ALIAS={alias or '?'} codex resident "
            "[unsupported: no stdin stream-json protocol])"
        )
        return False, repr_, None

    executable = services._resolve_runtime_executable(services.RUNTIME_CLAUDE) or "claude"
    argv = [
        executable,
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
    ]
    if resume_session_id:
        argv += ["--resume", resume_session_id]
    if model:
        argv += ["--model", model]
    if reasoning_effort:
        argv += ["--effort", reasoning_effort]
    if system_prompt:
        argv += ["--append-system-prompt", system_prompt]
    extra = flags.split() if flags else []
    if not any(
        flag.startswith("--permission-mode")
        or flag == "--dangerously-skip-permissions"
        for flag in extra
    ):
        argv.append("--dangerously-skip-permissions")
    argv.extend(extra)

    mode = f"--resume {resume_session_id}" if resume_session_id else "cold"
    model_note = f" --model {model}" if model else ""
    if reasoning_effort:
        model_note += f" --effort {reasoning_effort}"
    repr_ = (
        f"(cd {cwd} && ORCHA_ALIAS={alias or '?'} ORCHA_HEADLESS_WORKER=1 claude -p "
        "--input-format stream-json --output-format stream-json "
        f"--include-partial-messages --verbose [{mode}]{model_note}"
        f"{' --append-system-prompt <persona+digest+history>' if system_prompt else ''}"
        f"{(' ' + flags) if flags else ''}{f' >{log_path}' if log_path else ''})"
    )
    if dry_run:
        return False, repr_, None
    if (
        not services._resolve_runtime_executable(services.RUNTIME_CLAUDE)
        or not cwd
        or not pathlib.Path(cwd).is_dir()
    ):
        return False, repr_, None

    env = dict(services.os.environ)
    if alias:
        env["ORCHA_ALIAS"] = alias
    if run_token:
        env["ORCHA_RUN_TOKEN"] = run_token
    if conversation:
        env["ORCHA_CONVERSATION_WORKER"] = "1"
    else:
        env.pop("ORCHA_CONVERSATION_WORKER", None)
    env["ORCHA_HEADLESS_WORKER"] = "1"
    out = services.subprocess.DEVNULL
    if log_path is not None:
        try:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            out = open(log_path, "ab")
        except OSError:
            out = services.subprocess.DEVNULL
    try:
        proc = services.subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdout=out,
            stderr=(
                services.subprocess.STDOUT
                if out is not services.subprocess.DEVNULL
                else services.subprocess.DEVNULL
            ),
            stdin=services.subprocess.PIPE,
            start_new_session=True,
        )
        return True, repr_, proc
    except (OSError, services.subprocess.SubprocessError):
        return False, repr_, None
    finally:
        if out is not services.subprocess.DEVNULL:
            try:
                out.close()
            except OSError:
                pass
