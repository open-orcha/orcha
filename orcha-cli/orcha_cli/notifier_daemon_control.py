"""Stop, restart, and singleton-start notifier daemon processes safely."""

from __future__ import annotations

import datetime
import pathlib

from . import personal_session


def lifecycle_log(message: str, *, services) -> None:
    """One timestamped stderr line, printed even under --quiet: daemon start,
    stop, self-retire and stray reaping are what a field diagnosis needs, and the
    native runtime runs the daemon with --quiet (GH #313)."""
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        print(f"[notifier {stamp}] {message}", file=services.sys.stderr, flush=True)
    except (OSError, ValueError):
        pass


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


def terminate_all_and_wait(pids, cid, grace: float = 8.0, *, services) -> None:
    """terminate_and_wait for several daemons at once: SIGTERM every vetted pid,
    share one grace period, then SIGKILL whatever is still alive."""
    pending = []
    for pid in pids:
        if not services._daemon_pid_live(pid, cid):
            continue
        try:
            services.os.kill(pid, services.signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            continue
        pending.append(pid)
    deadline = services.time.time() + grace
    while pending and services.time.time() < deadline:
        pending = [pid for pid in pending if services._daemon_pid_live(pid, cid)]
        if pending:
            services.time.sleep(0.25)
    for pid in pending:
        services._terminate_and_wait(pid, cid, 0.0)


def _family(pid, daemons: dict) -> set:
    """`pid` plus its daemon ancestors and descendants (a launcher and its child)."""
    if not pid:
        return set()
    family = {pid}
    parent = daemons.get(pid)
    while parent in daemons and parent not in family:
        family.add(parent)
        parent = daemons.get(parent)
    grew = True
    while grew:
        grew = False
        for child, parent in daemons.items():
            if parent in family and child not in family:
                family.add(child)
                grew = True
    return family


def _depth(pid, daemons: dict) -> int:
    depth, seen = 0, {pid}
    parent = daemons.get(pid)
    while parent in daemons and parent not in seen:
        depth, parent = depth + 1, daemons.get(parent)
        seen.add(parent)
    return depth


def reap_strays(cid, keep, cwd=None, *, services) -> list:
    """Stop every notifier daemon of container `cid` except `keep` (and the
    launcher/child process that belongs to it). Discovery is a process scan, so
    orphans the pid file never named are found too (GH #313). Never touches a
    daemon of another container: the scan matches the exact `--container <cid>`
    and terminate_and_wait re-vets each pid before signalling it."""
    if not cid:
        return []
    daemons = services._container_daemons(cid)
    if not daemons:
        return []
    protected = _family(keep, daemons) | _family(services.os.getpid(), daemons)
    strays = sorted(
        (pid for pid in daemons if pid not in protected),
        key=lambda pid: _depth(pid, daemons),
        reverse=True,
    )
    if strays:
        services._lifecycle_log(
            f"stopping {len(strays)} stray daemon(s) for container {cid}: "
            f"{', '.join(str(pid) for pid in strays)}"
            + (f" (keeping pid {keep})" if keep else "")
        )
        services._terminate_all_and_wait(strays, cid)
    if cwd is not None:
        _prune_heartbeats(cwd, services=services)
    return strays


def _prune_heartbeats(cwd: pathlib.Path, *, services) -> None:
    """Drop per-pid heartbeat files of processes that no longer exist."""
    try:
        entries = list(services._hb_dir(cwd).iterdir())
    except OSError:
        return
    for entry in entries:
        try:
            if not services._pid_alive(int(entry.name)):
                entry.unlink()
        except (ValueError, OSError):
            continue


def _proven_daemon(pid, cid, ws, *, services) -> bool:
    """`pid` is a live daemon loop for `cid` with a fresh per-pid heartbeat in `ws`."""
    stamp = services._read_pid_stamp(ws, pid)
    if stamp is None or services.time.time() - stamp >= services.HEARTBEAT_STALE_SECS:
        return False
    info = services._ps_inspect(pid)
    return info is not None and services._is_container_daemon_command(info[1], cid or "")


def superseded_by(cwd: pathlib.Path, cid, *, services):
    """Called by a running daemon: the pid of ANOTHER proven daemon that owns
    this container (local pid file first, then the container claim), else None.

    A daemon the pid file no longer names retires itself once the owner proves
    life with its own fresh per-pid heartbeat — so a supervisor respawn or a
    leftover from a sleep/wake restart cannot linger beside the owner (GH #313).
    An owner without proof is left to --ensure's health check. When nobody owns
    the slot any more, this daemon re-claims it instead of leaving it empty."""
    me, parent = services.os.getpid(), services.os.getppid()
    path = services._pid_path(cwd)
    try:
        owner = int(path.read_text().strip())
    except (OSError, ValueError):
        owner = None
    if owner in (me, parent):
        return None
    if owner is not None and services._daemon_pid_live(owner, cid):
        return owner if _proven_daemon(owner, cid, cwd, services=services) else None
    if cid:
        # never take the container claim from a daemon serving it from another worktree
        try:
            lines = services._global_pid_path(cid).read_text().splitlines()
            holder = int(lines[0].strip())
            holder_ws = pathlib.Path(lines[1].strip()) if len(lines) > 1 and lines[1].strip() else cwd
        except (OSError, ValueError, IndexError):
            holder = None
        if holder is not None and holder not in (me, parent) and services._daemon_pid_live(holder, cid):
            return holder if _proven_daemon(holder, cid, holder_ws, services=services) else None
    try:
        path.write_text(str(me))
    except OSError:
        return None
    if cid:
        services._write_global_pid(cid, me, cwd)
    return None


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
            # GH #313: --stop/--restart also stop daemons no pid file names
            strays = services._reap_strays(cid, None, cwd)
            if strays and not quiet:
                print(f"[notifier] stopped {len(strays)} stray daemon(s): "
                      f"{', '.join(str(p) for p in strays)}")
            if other or strays:
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
        strays = services._reap_strays(cid, running[0] if running and running[0] != pid else None, cwd)
        if strays and not quiet:
            print(f"[notifier] stopped {len(strays)} stray daemon(s): "
                  f"{', '.join(str(p) for p in strays)}")
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
    strays = services._reap_strays(
        container_id, holder[0] if holder else None
    )
    if not holder:
        return bool(strays)
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
    if cid:
        # GH #313: the pid file names one daemon; find EVERY daemon loop for this
        # container and stop all but the healthy one we keep, so a sleep/wake or
        # session restart can no longer leave a new daemon beside old orphans.
        keep = pid
        if not keep:
            holder = services.daemon_running_for_container(cid)
            keep = holder[0] if holder else None
        services._reap_strays(cid, keep, cwd)
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
                # A daemon --ensure'd from a personal desktop tab must not hand the
                # personal marker to every worker it later spawns.
                env=personal_session.strip(dict(services.os.environ)),
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
