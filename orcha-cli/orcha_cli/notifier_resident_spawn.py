"""Build and launch warm stdin-driven Claude conversation workers."""

from __future__ import annotations

import pathlib
from typing import Optional

# Remote-runner spec §3.2–3.4, resident lane: sandbox wake execution. Imported as
# a module so tests can monkeypatch `_sandbox.preflight` etc. (attribute lookup at
# call time) — same seam as notifier_headless.
from . import sandbox as _sandbox


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
    spawn_info: Optional[dict] = None,
    services,
) -> tuple[bool, str, object]:
    """Launch a warm resident while resolving patchable services through the facade.

    `spawn_info` is an out-param dict (same contract as spawn_headless): sandbox
    mode stamps the container name into it as 'sandbox_container_id' so the caller
    can persist it on each turn's run row and reap the container on close."""
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
    # Remote-runner spec §3.2–3.4 (resident lane un-deferral): sandbox mode wraps
    # the fully-built argv in `docker run -i`. The Popen contract below is
    # untouched — stdin=PIPE now feeds the foreground docker CLIENT, whose `-i`
    # keeps that pipe attached to the container's stdin, so the warm stream-json
    # turn protocol works unchanged; stdout rides back the same way for the log.
    sandbox_cfg = _sandbox.SandboxConfig.load(cwd)
    if sandbox_cfg.enabled:
        reason = _sandbox.preflight(sandbox_cfg, cwd)
        if reason is not None:
            # Spec §3.2 hard rule: fail loudly; NEVER fall back to a host process.
            return False, f"(sandbox unavailable: {reason})", None
        # Issue #75 (OOM incident F1): residents count against the SAME box-wide budget
        # as one-shot wakes — a resident boot is a sandbox container too. Enforce at the
        # last moment before committing a name/Popen so racing daemons can't double-book.
        # A deferral is NOT a failure: stamp spawn_info['deferred'] so the caller keeps
        # the conversation eligible for a later tick instead of loudly failing the boot.
        if not dry_run:
            defer_reason = _sandbox.cap_defers_spawn(sandbox_cfg)
            if defer_reason is not None:
                if spawn_info is not None:
                    spawn_info["deferred"] = True
                return False, f"(deferred: {defer_reason})", None
        sbx_name = _sandbox.new_container_name()
        if spawn_info is not None:
            spawn_info["sandbox_container_id"] = sbx_name
        # Path-identical mounting: a resident's cwd is a PER-CONVERSATION git
        # worktree whose `.git` is a pointer file into the ROOT checkout, and
        # the rotating .orcha/github-token lives at the root — mount the root
        # at its real host path and run in the worktree.
        ws_root = str(_sandbox.workspace_root_for(cwd))
        # Dry-run must not touch the project dir — compute the mount path only.
        # A real spawn writes the sandbox-scoped api config, guarded: an
        # unwritable dir or garbled orcha.json fails the boot loudly (§3.2),
        # never escapes spawn_resident as an exception.
        if dry_run:
            api_cfg = str(
                pathlib.Path(cwd) / ".orcha" / "sandbox" / f"{sbx_name}.json"
            )
        else:
            try:
                api_cfg = _sandbox.write_api_config(cwd, sbx_name)
            except (OSError, ValueError) as e:
                return False, f"(sandbox unavailable: cannot write api config: {e})", None
            # Session-persistence: the agent-home dir backing the container's
            # ~/.claude must exist BEFORE docker run (docker would create a
            # missing source root-owned → the uid-1000 runner can't write it).
            # This is what makes a pinned session's `--resume` survive a
            # container restart. Failure fails the boot loudly (§3.2) — never
            # a silent skip of the mount.
            try:
                _sandbox.ensure_agent_home(ws_root)
            except OSError as e:
                return False, f"(sandbox unavailable: cannot create agent home: {e})", None
        # Inside the runner image the binary is bare `claude` on PATH — a
        # host-resolved absolute executable path is meaningless in the container.
        argv = [services._runtime_executable(services.RUNTIME_CLAUDE), *argv[1:]]
        # C1: stamp the PROJECT identity so the reaper's orphan pass is cid-scoped
        # (no cid resolvable → no label → the container is never orphan-stopped).
        sbx_labels = []
        run_cid = services._container_id_for(pathlib.Path(cwd))
        if run_cid:
            sbx_labels.append(f"{_sandbox.LABEL_CID_KEY}={run_cid}")
        argv = _sandbox.build_docker_argv(
            argv, cfg=sandbox_cfg, name=sbx_name, workspace=ws_root, workdir=cwd,
            # The stack's compose file lives at the ROOT (worktrees never carry
            # the generated .orcha/docker-compose.yml).
            network=sandbox_cfg.network or _sandbox.compose_network(ws_root),
            api_config_mount=api_cfg,
            extra_labels=tuple(sbx_labels),
            interactive=True,
        )
        # Repr hygiene: like the host-mode repr, NEVER include the persona payload
        # (this string lands in notifier logs / dry-run output). argv[:13] is the
        # docker head incl. -i (name/labels) — no argv tail.
        repr_ = (f"(sandbox {sbx_name}: {' '.join(argv[:13])} … "
                 f"{sandbox_cfg.image} claude -p --input-format stream-json [{mode}])")
    if dry_run:
        return False, repr_, None
    # In sandbox mode docker IS the executable (preflight already validated it);
    # a cloud VM has no host claude install, so only host mode requires one.
    if (
        (
            not sandbox_cfg.enabled
            and not services._resolve_runtime_executable(services.RUNTIME_CLAUDE)
        )
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
