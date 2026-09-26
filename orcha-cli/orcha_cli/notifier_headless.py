"""Build and launch one-shot Claude or Codex notifier workers."""

from __future__ import annotations

import pathlib
from typing import Optional

# Remote-runner spec §3.2–3.4: sandbox wake execution. Imported as a module so
# tests can monkeypatch `_sandbox.preflight` etc. (attribute lookup at call time).
from . import sandbox as _sandbox


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
    spawn_info: Optional[dict] = None,
    sandbox_sidecar: bool = False,
    services,
) -> tuple[bool, str, object]:
    """Launch a one-shot worker while resolving patchable services through the facade.

    `spawn_info` is an out-param dict: sandbox mode stamps the container name into
    it as 'sandbox_container_id' so the caller can persist it on the run row.
    `sandbox_sidecar` (Task-5 REQUIREMENT): mark this wake's sandbox container with
    the `orcha.sidecar=1` label — the drain sidecar records NO worker_runs row by
    design (locked no-lease invariant), so without the label the reaper's
    orphan pass would see a live managed container with no open run row and stop
    it mid-drain. Host-mode spawns ignore it (no container to label).
    """
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
    # Remote-runner spec §3.2–3.4: sandbox mode wraps the fully-built argv in
    # `docker run`. The Popen contract below is untouched — the foreground docker
    # client lives as long as the container and exits with its exit code, and the
    # `-e KEY` passthrough flags pick their values from the env built below.
    sandbox_cfg = _sandbox.SandboxConfig.load(cwd)
    if sandbox_cfg.enabled:
        reason = _sandbox.preflight(sandbox_cfg, cwd)
        if reason is not None:
            # Spec §3.2 hard rule: fail loudly; NEVER fall back to a host process.
            return False, f"(sandbox unavailable: {reason})", None
        # Issue #75 (OOM incident F1): the LAST-MOMENT box-wide budget check. Counting
        # ground-truth live managed containers HERE — after preflight, right before we
        # commit a container name and Popen — is what stops racing daemons from
        # double-booking the box between ticks (six-in-11s → global OOM). A deferral is
        # NOT a failure: stamp spawn_info['deferred'] so the caller keeps the candidate
        # eligible for a later tick (no worktree teardown, no "could not wake" noise)
        # and logs the cap ONCE per tick per deferral. NOT applied in dry-run (no real
        # container is created, so nothing is spent against the budget).
        if not dry_run:
            defer_reason = _sandbox.cap_defers_spawn(sandbox_cfg)
            if defer_reason is not None:
                if spawn_info is not None:
                    spawn_info["deferred"] = True
                return False, f"(deferred: {defer_reason})", None
        sbx_name = _sandbox.new_container_name()
        if spawn_info is not None:
            spawn_info["sandbox_container_id"] = sbx_name
        # Path-identical mounting: mount the workspace ROOT (a worktree cwd's
        # main checkout — its `.git` pointer file and the root's
        # .orcha/github-token must resolve in-container) and run in `cwd`.
        ws_root = str(_sandbox.workspace_root_for(cwd))
        # Dry-run must not touch the project dir — compute the mount path only.
        # A real spawn writes the sandbox-scoped api config, guarded: an
        # unwritable dir or garbled orcha.json fails the wake loudly (§3.2),
        # never escapes spawn_headless as an exception.
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
            # missing source root-owned → the uid-1000 runner can't write it
            # and resumes quietly break again). Failure fails the wake loudly
            # (§3.2) — never a silent skip of the mount.
            try:
                _sandbox.ensure_agent_home(ws_root)
            except OSError as e:
                return False, f"(sandbox unavailable: cannot create agent home: {e})", None
        # Inside the runner image the binaries are bare `claude`/`codex` on
        # PATH — a host-resolved absolute executable path (which-hit or
        # ORCHA_*_EXEC override) is meaningless in the container.
        argv = [services._runtime_executable(runtime), *argv[1:]]
        # C1 (Task-5 review): stamp the PROJECT identity (current_container_id from
        # this project's .claude/orcha.json — the same file write_api_config reads)
        # so the reaper's orphan pass is cid-scoped: on a host running several
        # orcha stacks, one daemon must never stop another project's containers.
        # No cid resolvable → no label; a cid-filtered orphan pass then simply
        # never sees this container (fails SAFE — it is never stopped as an orphan).
        sbx_labels = []
        run_cid = services._container_id_for(pathlib.Path(cwd))
        if run_cid:
            sbx_labels.append(f"{_sandbox.LABEL_CID_KEY}={run_cid}")
        if sandbox_sidecar:
            # Task-5 REQUIREMENT: the drain sidecar's container is label-exempt
            # from the reaper's orphan pass (it owns no run row by design).
            sbx_labels.append(_sandbox.LABEL_SIDECAR)
        argv = _sandbox.build_docker_argv(
            argv, cfg=sandbox_cfg, name=sbx_name, workspace=ws_root, workdir=cwd,
            # The stack's compose file lives at the ROOT (worktrees never carry
            # the generated .orcha/docker-compose.yml).
            network=sandbox_cfg.network or _sandbox.compose_network(ws_root),
            api_config_mount=api_cfg,
            extra_labels=tuple(sbx_labels),
        )
        # Repr hygiene: like the host-mode reprs, NEVER include the prompt or
        # persona payload (this string lands in woke records / dry-run output).
        # argv[:12] is the docker head (name/labels/caps) — no argv tail.
        repr_ = (f"(sandbox {sbx_name}: {' '.join(argv[:12])} … "
                 f"{sandbox_cfg.image} {services._runtime_executable(runtime)} <prompt>)")
    if dry_run:
        return False, repr_, None
    # In sandbox mode docker IS the executable (preflight already validated it);
    # a cloud VM has no host claude/codex install, so only host mode requires one.
    if (
        (not sandbox_cfg.enabled and not services._resolve_runtime_executable(runtime))
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
