"""Build and launch one-shot Claude or Codex notifier workers."""

from __future__ import annotations

import pathlib
from typing import Optional


def spawn_headless(
    cwd: str,
    prompt: str,
    flags: Optional[str],
    dry_run: bool,
    *,
    alias: Optional[str] = None,
    system_prompt: Optional[str] = None,
    model: Optional[str] = None,
    reasoning_effort: Optional[str] = None,
    runtime: Optional[str] = None,
    resume_session_id: Optional[str] = None,
    log_path: Optional[pathlib.Path] = None,
    last_message_path: Optional[pathlib.Path] = None,
    run_token: Optional[str] = None,
    conversation: bool = False,
    services,
) -> tuple[bool, str, object]:
    """Launch a one-shot worker while resolving patchable services through the facade."""
    runtime = services._normalize_runtime(runtime)
    extra = services._runtime_extra_flags(runtime, flags)
    executable = (
        services._resolve_runtime_executable(runtime)
        or services._runtime_executable(runtime)
    )
    if runtime == services.RUNTIME_CODEX:
        argv = [executable, "exec"]
        if resume_session_id:
            argv += ["resume", resume_session_id]
        argv += [
            "--json",
            "--dangerously-bypass-approvals-and-sandbox",
            "--skip-git-repo-check",
        ]
        if model:
            argv += ["--model", model]
        if reasoning_effort:
            effort = services._CODEX_EFFORT.get(reasoning_effort, reasoning_effort)
            argv += ["-c", f"model_reasoning_effort={effort}"]
        if last_message_path:
            argv += ["--output-last-message", str(last_message_path)]
        argv.extend(extra)
        argv.append(
            prompt
            if resume_session_id
            else services._codex_prompt(prompt, system_prompt)
        )
    else:
        argv = [
            executable,
            "-p",
            prompt,
            "--output-format",
            "stream-json",
            "--include-partial-messages",
            "--verbose",
        ]
        if model:
            argv += ["--model", model]
        if reasoning_effort:
            argv += ["--effort", reasoning_effort]
        if system_prompt:
            argv += ["--append-system-prompt", system_prompt]
        if not any(
            flag.startswith("--permission-mode")
            or flag == "--dangerously-skip-permissions"
            for flag in extra
        ):
            argv.append("--dangerously-skip-permissions")
        argv.extend(extra)

    persona_note = (
        " --append-system-prompt <persona+digest>"
        if system_prompt and runtime == services.RUNTIME_CLAUDE
        else ""
    )
    if system_prompt and runtime == services.RUNTIME_CODEX:
        persona_note = " <prompt includes persona+digest>"
    model_note = f" --model {model}" if model else ""
    if reasoning_effort:
        if runtime == services.RUNTIME_CLAUDE:
            model_note += f" --effort {reasoning_effort}"
        else:
            effort = services._CODEX_EFFORT.get(reasoning_effort, reasoning_effort)
            model_note += f" -c model_reasoning_effort={effort}"
    perm_note = ""
    if runtime == services.RUNTIME_CODEX:
        perm_note = " --dangerously-bypass-approvals-and-sandbox"
    elif not any(
        flag.startswith("--permission-mode")
        or flag == "--dangerously-skip-permissions"
        for flag in extra
    ):
        perm_note = " --dangerously-skip-permissions"
    log_note = f" >{log_path}" if log_path else ""
    last_note = (
        f" --output-last-message {last_message_path}" if last_message_path else ""
    )
    if runtime == services.RUNTIME_CODEX:
        resume_note = f" resume {resume_session_id}" if resume_session_id else ""
        codex_persona_note = "" if resume_session_id else persona_note
        repr_ = (
            f"(cd {cwd} && ORCHA_ALIAS={alias or '?'} ORCHA_HEADLESS_WORKER=1 "
            f"codex exec{resume_note} --json{perm_note} --skip-git-repo-check"
            f"{model_note}{last_note}{codex_persona_note}"
            f"{(' ' + ' '.join(extra)) if extra else ''}{log_note})"
        )
    else:
        repr_ = (
            f"(cd {cwd} && ORCHA_ALIAS={alias or '?'} ORCHA_HEADLESS_WORKER=1 "
            "claude -p <prompt> --output-format stream-json "
            f"--include-partial-messages --verbose{model_note}{persona_note}{perm_note}"
            f"{(' ' + flags) if flags else ''}{log_note})"
        )
    if dry_run:
        return False, repr_, None
    if (
        not services._resolve_runtime_executable(runtime)
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
    env["ORCHA_AGENT_RUNTIME"] = runtime
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
            stdin=services.subprocess.DEVNULL,
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
