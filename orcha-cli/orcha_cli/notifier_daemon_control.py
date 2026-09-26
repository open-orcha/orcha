"""Stop, restart, and singleton-start notifier daemon processes safely."""

from __future__ import annotations

import pathlib


def terminate_and_wait(
    pid: int, cid: str | None, grace: float = 8.0, *, services
) -> None:
    """Terminate only an identity-vetted daemon, escalating after a grace period."""
    if not services._daemon_pid_live(pid, cid):
        return
    try:
        services.os.kill(pid, services.signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    deadline = services.time.time() + grace
    while services.time.time() < deadline:
        if not services._daemon_pid_live(pid, cid):
            return
        services.time.sleep(0.25)
    if not services._daemon_pid_live(pid, cid):
        return
    try:
        services.os.kill(pid, services.signal.SIGKILL)
        print(
            f"[notifier] WARNING: daemon pid {pid} did not exit {grace:.0f}s "
            "after SIGTERM — sent SIGKILL (its SessionEnd digest flush was skipped)",
            file=services.sys.stderr,
        )
    except (ProcessLookupError, PermissionError):
        return
    for _ in range(8):
        if not services._daemon_pid_live(pid, cid):
            return
        services.time.sleep(0.25)


def stop_daemon(cwd: pathlib.Path, quiet: bool, *, services) -> bool:
    """Stop the container daemon found through either local or global ownership."""
    pid = services.daemon_running(cwd)
    pid_file = services._pid_path(cwd)
    cid = services._container_id_for(cwd)
    if not pid:
        if pid_file.exists():
            try:
                pid_file.unlink()
            except OSError:
                pass
        if cid:
            other = services.daemon_running_for_container(cid)
            if other:
                services._terminate_and_wait(other[0], cid)
                if not quiet:
                    origin = f", started from {other[1]}" if other[1] else ""
                    print(f"[notifier] stopped daemon (pid {other[0]}{origin})")
            try:
                services._global_pid_path(cid).unlink()
            except (FileNotFoundError, OSError):
                pass
            if other:
                return True
        return False

    services._terminate_and_wait(pid, cid)
    try:
        pid_file.unlink()
    except (FileNotFoundError, OSError):
        pass
    if cid:
        running = services.daemon_running_for_container(cid)
        if running is None or running[0] == pid:
            try:
                services._global_pid_path(cid).unlink()
            except (FileNotFoundError, OSError):
                pass
    if not quiet:
        print(f"[notifier] stopped daemon (pid {pid})")
    return True


def stop_daemon_for_container(
    container_id: str, quiet: bool, *, services
) -> bool:
    """Stop a daemon bound to a specific, possibly replaced container."""
    if not container_id:
        return False
    holder = services.daemon_running_for_container(container_id)
    try:
        services._global_pid_path(container_id).unlink()
    except (FileNotFoundError, OSError):
        pass
    if not holder:
        return False
    services._terminate_and_wait(holder[0], container_id)
    if not quiet:
        origin = f", started from {holder[1]}" if holder[1] else ""
        print(
            f"[notifier] stopped stale daemon for old container {container_id} "
            f"(pid {holder[0]}{origin})"
        )
    return True


def ensure_daemon(
    cwd: pathlib.Path, quiet: bool, restart: bool, *, services
) -> bool:
    """Start one detached notifier for the project container when needed."""
    if not (cwd / ".claude" / "orcha.json").exists():
        return False
    cid = services._container_id_for(cwd)
    if restart:
        services.stop_daemon(cwd, quiet=True)
    pid = services.daemon_running(cwd)
    if pid:
        if not quiet:
            print(f"[notifier] already running (pid {pid})")
        return True

    if cid:
        api_base = services._api_base_for(cwd)
        if api_base and services._probe_container(api_base, cid) == "missing":
            if not quiet:
                print(
                    f"[notifier] container {cid} does not exist at {api_base} — not "
                    "starting a daemon. This usually means a stale "
                    ".claude/orcha.json (api_base_url/current_container_id from a "
                    "previous stack). Fix the config or re-run "
                    "`orcha connect <project>`.",
                    file=services.sys.stderr,
                )
            return False

    claim_won = False
    if cid:
        claim_won, holder = services._claim_container(cid)
        if not claim_won and holder is not None:
            if not quiet:
                if holder[0]:
                    origin = f" from {holder[1]}" if holder[1] else ""
                    print(
                        "[notifier] already running for this container "
                        f"(pid {holder[0]}{origin})"
                    )
                else:
                    print(
                        "[notifier] another --ensure is starting this container's "
                        "daemon — yielding"
                    )
            return True

    executable = services.shutil.which("orcha")
    argv = (
        [executable, "notifier", "--quiet"]
        if executable
        else [
            services.sys.executable,
            "-m",
            "orcha_cli",
            "notifier",
            "--quiet",
        ]
    )
    if cid:
        argv += ["--container", cid]
    log_path = services._log_path(cwd)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(log_path, "ab") as log:
            process = services.subprocess.Popen(
                argv,
                cwd=str(cwd),
                stdout=log,
                stderr=log,
                stdin=services.subprocess.DEVNULL,
                start_new_session=True,
            )
    except (OSError, services.subprocess.SubprocessError) as error:
        if claim_won:
            try:
                services._global_pid_path(cid).unlink()
            except (FileNotFoundError, OSError):
                pass
        if not quiet:
            print(
                f"[notifier] could not start daemon: {error}",
                file=services.sys.stderr,
            )
        return False
    services._pid_path(cwd).write_text(str(process.pid))
    if cid:
        services._write_global_pid(cid, process.pid, cwd)
    if not quiet:
        print(f"[notifier] started daemon (pid {process.pid}); log: {log_path}")
    return True
