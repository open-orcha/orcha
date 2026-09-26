"""Create disposable Git worktrees and overlay Orcha's local runtime configuration."""

from __future__ import annotations

import json
import os
import pathlib
import re
import shutil
import subprocess
import time
from typing import Any


def run_git(args, cwd=None, timeout: float = 30.0):
    """Run Git and return its status and stdout without raising."""
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return result.returncode, result.stdout
    except (OSError, subprocess.SubprocessError):
        return 1, ""


def safe_ref(alias) -> str:
    """Convert an unconstrained display alias into a safe Git reference segment."""
    slug = re.sub(r"[^A-Za-z0-9._-]", "-", str(alias or "agent"))
    slug = re.sub(r"\.+", ".", slug).strip(".-")
    return slug or "agent"


def ensure_exclude(base_cwd, services: Any) -> None:
    """Keep live worker worktrees out of the base checkout's index."""
    return_code, git_dir = services._run_git(
        ["rev-parse", "--git-common-dir"], cwd=base_cwd
    )
    if return_code != 0:
        return
    git_dir = git_dir.strip()
    exclude = (
        pathlib.Path(
            git_dir if os.path.isabs(git_dir) else os.path.join(base_cwd, git_dir)
        )
        / "info"
        / "exclude"
    )
    try:
        exclude.parent.mkdir(parents=True, exist_ok=True)
        existing = exclude.read_text() if exclude.exists() else ""
        if ".orcha-worktrees/" not in existing.split():
            with open(exclude, "a") as output:
                prefix = "" if existing.endswith("\n") or not existing else "\n"
                output.write(
                    prefix
                    + "# orcha: isolated headless-worker worktrees (never commit)\n"
                    ".orcha-worktrees/\n"
                )
    except OSError:
        pass


def overlay_runtime_config(base: pathlib.Path, worktree: pathlib.Path) -> None:
    """Copy ignored connection, binding, hook, and Orcha skill files into a worktree."""
    destination = worktree / ".claude"
    destination.mkdir(parents=True, exist_ok=True)
    for name in ("orcha.json", "settings.json"):
        source = base / ".claude" / name
        if source.exists():
            try:
                shutil.copy2(source, destination / name)
            except OSError:
                pass
    tabs = base / ".claude" / "orcha-tabs"
    if tabs.is_dir():
        (destination / "orcha-tabs").mkdir(parents=True, exist_ok=True)
        for source in tabs.iterdir():
            if source.is_file():
                try:
                    shutil.copy2(source, destination / "orcha-tabs" / source.name)
                except OSError:
                    pass

    # Project-installed Orcha commands/skills are intentionally ignored by Git. A fresh Git
    # worktree therefore cannot discover the local task API unless the runtime overlay carries
    # those files alongside orcha.json. Copy only Orcha-owned entries; unrelated local skills and
    # commands remain private to the base checkout.
    commands = base / ".claude" / "commands"
    if commands.is_dir():
        command_destination = destination / "commands"
        command_destination.mkdir(parents=True, exist_ok=True)
        for source in commands.glob("orcha-*.md"):
            try:
                shutil.copy2(source, command_destination / source.name)
            except OSError:
                pass
    skills = base / ".agents" / "skills"
    if skills.is_dir():
        skill_destination = worktree / ".agents" / "skills"
        skill_destination.mkdir(parents=True, exist_ok=True)
        for source in skills.glob("orcha-*"):
            if not source.is_dir():
                continue
            try:
                shutil.copytree(
                    source,
                    skill_destination / source.name,
                    dirs_exist_ok=True,
                )
            except OSError:
                pass

    # LAST step on purpose: everything the overlay just wrote gets re-owned too.
    mirror_base_ownership(base, worktree)


def _chown_tree(root: pathlib.Path, uid: int, gid: int) -> None:
    """Best-effort recursive chown that never follows symlinks out of the tree."""
    chown = getattr(os, "lchown", None) or os.chown
    try:
        chown(root, uid, gid)
    except OSError:
        return
    for dirpath, dirnames, filenames in os.walk(root):
        for name in dirnames + filenames:
            try:
                chown(os.path.join(dirpath, name), uid, gid)
            except OSError:
                pass


def mirror_base_ownership(base: pathlib.Path, worktree: pathlib.Path) -> None:
    """Give a fresh worktree the SAME owner as the base checkout it came from.

    Field bug (Warden, 2026-08-01): on cloud boxes the notifier daemon runs as
    root while sandboxes run as a non-root uid, so `git worktree add` birthed
    root-owned trees the worker could not write — every file, including the
    worktree's own admin dir under the main repo's .git/worktrees (HEAD/index
    live there), was read-only to the agent. Mirroring the BASE workspace's
    owner (which provisioning already set to the runner uid) fixes both the
    tree and the admin dir at creation time. No-op when the daemon already IS
    the workspace owner (local self-host) or off POSIX."""
    if os.name != "posix":
        return
    try:
        stat = os.stat(base)
        uid, gid = stat.st_uid, stat.st_gid
        if uid == os.geteuid():
            return
    except OSError:
        return
    _chown_tree(worktree, uid, gid)
    # the worktree's admin dir inside the main .git — git writes HEAD/index there
    return_code, git_dir = run_git(["rev-parse", "--git-dir"], cwd=str(worktree))
    if return_code == 0 and git_dir.strip():
        admin = pathlib.Path(git_dir.strip())
        if not admin.is_absolute():
            admin = (worktree / admin).resolve()
        _chown_tree(admin, uid, gid)


def seed_tab_binding(base_cwd, alias, agent_id, container_id) -> bool:
    """Create a missing portal-agent CLI binding without overwriting user state."""
    if not (base_cwd and alias and agent_id):
        return False
    try:
        tabs = pathlib.Path(base_cwd) / ".claude" / "orcha-tabs"
        destination = tabs / f"{alias}.json"
        if destination.exists():
            return False
        tabs.mkdir(parents=True, exist_ok=True)
        binding = {
            "alias": alias,
            "agent_id": agent_id,
            "container_id": container_id,
        }
        destination.write_text(json.dumps(binding, indent=2) + "\n")
        return True
    except OSError:
        return False


def provision_disposable(base_cwd, alias, services: Any):
    """Create a fresh worker branch and worktree from origin/main."""
    if (
        not base_cwd
        or services._run_git(["rev-parse", "--git-dir"], cwd=base_cwd)[0] != 0
    ):
        return None, None
    base = pathlib.Path(base_cwd)
    services._ensure_worktree_exclude(base_cwd)
    stamp = f"{services._safe_ref(alias)}-{int(time.time() * 1000)}"
    branch = f"orcha/wk-{stamp}"
    worktree = base / ".orcha-worktrees" / stamp
    services._run_git(["fetch", "origin", "main"], cwd=base_cwd, timeout=60)
    return_code, _ = services._run_git(
        [
            "worktree",
            "add",
            "-b",
            branch,
            str(worktree),
            "origin/main",
        ],
        cwd=base_cwd,
        timeout=60,
    )
    if return_code != 0:
        return None, None
    services._overlay_runtime_config(base, worktree)
    return str(worktree), branch
