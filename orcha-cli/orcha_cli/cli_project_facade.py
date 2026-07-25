"""Compatibility facade for project setup, stack lifecycle, and update commands."""

from __future__ import annotations

import importlib.resources as pkg_res
import json
import pathlib
import sys

from . import (
    cli_connect,
    cli_init,
    cli_project_commands,
    cli_project_setup,
    cli_stacks,
    cli_status,
    cli_update,
)
from .cli_env import _append_env_file, _read_env_file_value, _tighten_env_file
from .cli_http import _get_json, _post_json, _wait_for_portal
from .cli_text import _codex_skill_body
from .notifier import ensure_daemon, stop_daemon

PKG_ROOT = pkg_res.files("orcha_cli")
PKG_TEMPLATES = PKG_ROOT / "templates"
_MASTER_KEY_ENV = "ORCHA_SECRET_KEY"
_PAIRING_HOST_ENV = "ORCHA_PAIRING_HOST"
_PORTAL_SHARED_MODULES = (
    "llm_util.py",
    "llm_catalog.py",
    "llm_decisions.py",
    "llm_formats.py",
    "llm_http.py",
    "llm_observability.py",
    "llm_providers.py",
    "llm_stream.py",
    "llm_vision.py",
    "secret_box.py",
    "digest_curate.py",
    "digest_recalibrate.py",
    "digest_summary.py",
)

__all__ = [
    "PKG_ROOT",
    "PKG_TEMPLATES",
    "_MASTER_KEY_ENV",
    "_PAIRING_HOST_ENV",
    "_PORTAL_SHARED_MODULES",
    "_brew_keg",
    "_brew_upgrade",
    "_by_project",
    "_cli_source_root",
    "_compose",
    "_copy_tree",
    "_discover_pairing_host",
    "_discover_stacks",
    "_ensure_secret_key",
    "_export_pairing_host",
    "_find_free_port",
    "_full_project",
    "_install_llm_util",
    "_install_orcha_skill_templates",
    "_install_project_preferences",
    "_parse_host_port",
    "_project_exists",
    "_prune_stale_bindings",
    "_reinstall_cli",
    "_resolve_bridge_port",
    "_usable_pairing_ip",
    "cmd_connect",
    "cmd_down",
    "cmd_init",
    "cmd_ls",
    "cmd_migrate",
    "cmd_status",
    "cmd_up",
    "cmd_update",
    "cmd_upgrade",
    "ensure_daemon",
    "stop_daemon",
]


def _services():
    return sys.modules["orcha_cli.__main__"]


def _install_llm_util(orcha_dir: pathlib.Path) -> None:
    """Copy single-source shared Python modules into a scaffolded portal."""
    portal_dir = orcha_dir / "portal"
    portal_dir.mkdir(parents=True, exist_ok=True)
    for module in _PORTAL_SHARED_MODULES:
        (portal_dir / module).write_bytes((PKG_ROOT / module).read_bytes())


def _find_free_port(start: int, span: int = 100) -> int:
    return cli_project_setup.find_free_port(start, span)


def _copy_tree(src, dst: pathlib.Path) -> None:
    cli_project_setup.copy_tree(src, dst)


def _install_orcha_skill_templates(root: pathlib.Path):
    return cli_project_setup.install_skill_templates(
        root, PKG_TEMPLATES, _codex_skill_body
    )


def _install_project_preferences(root: pathlib.Path):
    return cli_project_setup.install_project_preferences(root, PKG_TEMPLATES)


def _ensure_secret_key(orcha_dir: pathlib.Path) -> None:
    cli_project_setup.ensure_secret_key(
        orcha_dir, _read_env_file_value, _append_env_file, _tighten_env_file
    )


def _usable_pairing_ip(value: str) -> str | None:
    return cli_project_setup.usable_pairing_ip(value)


def _discover_pairing_host() -> str | None:
    return cli_project_setup.discover_pairing_host()


def _export_pairing_host() -> None:
    cli_project_setup.export_pairing_host(_services()._discover_pairing_host)


def _compose(orcha_dir: pathlib.Path, *args: str, **kwargs):
    return cli_project_setup.compose(
        orcha_dir,
        *args,
        ensure_key=_ensure_secret_key,
        export_host=_export_pairing_host,
        **kwargs,
    )


def _prune_stale_bindings(tabs_dir: pathlib.Path, keep_cid: str) -> int:
    """Remove bindings that clearly belong to a replaced local container."""
    if not (keep_cid and tabs_dir.is_dir()):
        return 0
    removed = 0
    for binding_file in tabs_dir.glob("*.json"):
        try:
            container_id = json.loads(binding_file.read_text()).get("container_id")
        except (OSError, ValueError):
            continue
        if container_id and container_id != keep_cid:
            try:
                binding_file.unlink()
                removed += 1
            except OSError:
                pass
    return removed


def cmd_init(args) -> None:
    cli_init.cmd_init(args, _services())


def _resolve_bridge_port(api_base: str) -> int | None:
    return cli_connect.resolve_bridge_port(api_base, get_json=_get_json)


def cmd_connect(args) -> None:
    cli_connect.connect_command(
        args,
        sanitize_name=_services()._sanitize_name,
        discover_stacks=_discover_stacks,
        wait_for_portal=_wait_for_portal,
        get_json=_get_json,
        resolve_port=_resolve_bridge_port,
        install_skill_templates=_install_orcha_skill_templates,
        write_hook_config=_services()._write_hook_config,
        post_json=_post_json,
    )


def _discover_stacks() -> list[dict]:
    return cli_stacks.discover_stacks(parse_host_port=_parse_host_port)


def _full_project(project_name: str) -> str:
    return cli_stacks.full_project(project_name)


def _by_project(project_name: str, *args: str) -> None:
    cli_stacks.by_project(project_name, *args, export_pairing_host=_export_pairing_host)


def _project_exists(project_name: str) -> bool:
    return cli_stacks.project_exists(project_name)


def cmd_up(args) -> None:
    cli_project_commands.cmd_up(args, _services())


def cmd_down(args) -> None:
    cli_project_commands.cmd_down(args, _services())


def cmd_migrate(args) -> None:
    cli_project_commands.cmd_migrate(args, _services())


def cmd_upgrade(args) -> None:
    cli_project_commands.cmd_upgrade(args, _services())


_cli_source_root = cli_update.source_root
_brew_keg = cli_update.brew_keg
_reinstall_cli = cli_update.reinstall_cli
_brew_upgrade = cli_update.upgrade_brew


def cmd_update(args) -> None:
    cli_update.update_command(
        args,
        source_root=_services()._cli_source_root,
        brew_keg=_services()._brew_keg,
        reinstall_cli=_services()._reinstall_cli,
        brew_upgrade=_services()._brew_upgrade,
        upgrade=_services().cmd_upgrade,
        ensure_notifier=_services().ensure_daemon,
    )


def cmd_status(args) -> None:
    cli_status.status_command(args, _services())


def cmd_ls(args) -> None:
    cli_status.list_command(args, _services())


_parse_host_port = cli_status.parse_host_port
