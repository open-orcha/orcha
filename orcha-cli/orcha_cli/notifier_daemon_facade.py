"""Preserve notifier daemon registry, lifecycle, and command entry points."""

from __future__ import annotations

import pathlib
import sys
from typing import Optional

from . import notifier_command as _command
from . import notifier_daemon_control as _control
from . import notifier_daemon_registry as _registry

HEARTBEAT_STALE_SECS = _registry.HEARTBEAT_STALE_SECS


def _compat():
    return sys.modules["orcha_cli.notifier"]


def _pid_path(cwd: pathlib.Path) -> pathlib.Path:
    return _registry.pid_path(cwd)


def _log_path(cwd: pathlib.Path) -> pathlib.Path:
    return _registry.log_path(cwd)


def _pid_alive(pid: int) -> bool:
    return _registry.pid_alive(pid, services=_compat())


def _ps_inspect(pid: int) -> Optional[tuple]:
    return _registry.ps_inspect(pid, services=_compat())


def _daemon_pid_live(pid: int, cid: Optional[str] = None) -> bool:
    return _registry.daemon_pid_live(pid, cid, services=_compat())


def _hb_path(cwd: pathlib.Path) -> pathlib.Path:
    return _registry.hb_path(cwd)


def _write_heartbeat(cwd: pathlib.Path) -> None:
    _registry.write_heartbeat(cwd, services=_compat())


def _heartbeat_verdict(cwd: pathlib.Path, pid: int):
    return _registry.heartbeat_verdict(cwd, pid, services=_compat())


def _daemon_pid_healthy(
    pid: int, cid: Optional[str], cwd: Optional[pathlib.Path]
) -> bool:
    return _registry.daemon_pid_healthy(pid, cid, cwd, services=_compat())


def daemon_running(cwd: pathlib.Path) -> Optional[int]:
    return _registry.daemon_running(cwd, services=_compat())


def _global_pid_path(container_id: str) -> pathlib.Path:
    return _registry.global_pid_path(container_id)


def _container_id_for(cwd: pathlib.Path) -> Optional[str]:
    return _registry.container_id_for(cwd)


def _api_base_for(cwd: pathlib.Path) -> Optional[str]:
    return _registry.api_base_for(cwd)


def _write_global_pid(
    container_id: str, pid: int, cwd: pathlib.Path
) -> None:
    _registry.write_global_pid(
        container_id, pid, cwd, services=_compat()
    )


def daemon_running_for_container(
    container_id: str,
) -> Optional[tuple]:
    return _registry.daemon_running_for_container(
        container_id, services=_compat()
    )


def _claim_container(container_id: str):
    return _registry.claim_container(container_id, services=_compat())


def _terminate_and_wait(
    pid: int, cid: Optional[str], grace: float = 8.0
) -> None:
    """Terminate only an identity-vetted daemon."""
    _control.terminate_and_wait(
        pid, cid, grace, services=_compat()
    )


def stop_daemon(cwd: pathlib.Path, quiet: bool = False) -> bool:
    return _control.stop_daemon(cwd, quiet, services=_compat())


def stop_daemon_for_container(
    container_id: str, quiet: bool = False
) -> bool:
    return _control.stop_daemon_for_container(
        container_id, quiet, services=_compat()
    )


def ensure_daemon(
    cwd: pathlib.Path, quiet: bool = False, restart: bool = False
) -> bool:
    return _control.ensure_daemon(
        cwd, quiet, restart, services=_compat()
    )


def cmd_notifier(args) -> int:
    return _command.cmd_notifier(args, services=_compat())
