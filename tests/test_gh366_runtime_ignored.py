"""GH #366: Orcha's runtime state in a project folder stays out of Git.

A project whose own .gitignore did not cover `.orcha/` and `.claude/.orcha-*` listed them as
untracked: `git add -A` staged the stack's `.env` (master key), GitHub tokens and database,
and Claude Code agents saw the notifier heartbeat and the portal log (rewritten every few
seconds) as "Updated" after nearly every Bash command. These tests use real Git in disposable
folders.
"""

from __future__ import annotations

import pathlib
import subprocess

import pytest

from orcha_cli import cli_portal, cli_project_setup, notifier
from orcha_cli import notifier_startup_preflight as preflight
from orcha_cli import notifier_worktree_base as wtb
from test_gh301_startup_inherited_repo import (  # noqa: F401  (autouse fixture)
    _empty_parent_with_project,
    _git,
    _git_ceiling,
    _snapshot,
)

RUNTIME = (
    ".orcha/.env",
    ".orcha/orcha.db",
    ".orcha/github-token",
    ".orcha/logs/portal.log",
    ".claude/.orcha-notifier.hb",
    ".claude/.orcha-notifier.hb.d/123",
    ".claude/.orcha-notifier.pid",
    ".claude/.orcha-attachments/c1/a.md",
    ".claude/.orcha-wakes/agent-1.log",
)
PROJECT = ("README.md", ".claude/settings.json", ".claude/orcha.json")


def _project(root: pathlib.Path, *, repo: bool = True) -> pathlib.Path:
    root.mkdir(parents=True, exist_ok=True)
    if repo:
        _git(root, "init", "-q")
    for rel in RUNTIME + PROJECT:
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(f"{rel}\n")
    return root


def _untracked(root: pathlib.Path, *git_dir: str) -> set[str]:
    out = _git(root, *git_dir, "status", "--porcelain", "-uall")
    return {line[3:] for line in out.splitlines() if line.startswith("?? ")}


def _exclude(root: pathlib.Path) -> str:
    return (root / ".git" / "info" / "exclude").read_text()


def test_runtime_state_leaves_git_status_and_project_files_stay(tmp_path):
    project = _project(tmp_path / "App")
    assert set(RUNTIME) <= _untracked(project)

    wtb.ensure_runtime_ignored(project)

    assert _untracked(project) == set(PROJECT)
    assert (project / ".orcha" / ".gitignore").read_text() == wtb.ORCHA_DIR_GITIGNORE
    assert "/.claude/.orcha-*" in _exclude(project).split()
    # nothing tracked was written: .gitignore at the top is still absent
    assert not (project / ".gitignore").exists()


def test_the_stack_hides_itself_from_any_git_directory(tmp_path):
    """`.orcha/.gitignore` lives in the folder, so it applies whichever Git directory looks
    at it, even one that never got the project's info/exclude."""
    project = _project(tmp_path / "App")
    other = tmp_path / "other"
    _git(tmp_path, "init", "-q", str(other))
    git_dir = ("--git-dir", str(other / ".git"), "--work-tree", str(project))

    wtb.ensure_runtime_ignored(project)

    seen = _untracked(project, *git_dir)
    assert not any(p.startswith(".orcha/") for p in seen)
    assert set(PROJECT) <= seen


def test_idempotent_and_keeps_what_is_there(tmp_path):
    project = _project(tmp_path / "App")
    exclude = project / ".git" / "info" / "exclude"
    exclude.write_text("# mine\nbuild/")  # no trailing newline
    custom = project / ".orcha" / ".gitignore"
    custom.write_text("logs/\n")  # a project's own rule is never rewritten

    wtb.ensure_runtime_ignored(project)
    once = exclude.read_text()
    wtb.ensure_runtime_ignored(project)

    assert exclude.read_text() == once
    assert once.startswith("# mine\nbuild/\n# orcha: ")
    assert once.count("/.claude/.orcha-*") == 1
    assert custom.read_text() == "logs/\n"


def test_tracked_files_stay_tracked(tmp_path):
    project = _project(tmp_path / "App")
    _git(project, "add", "-f", ".orcha/.env")
    _git(project, "commit", "-q", "-m", "a team that tracks it")

    wtb.ensure_runtime_ignored(project)
    (project / ".orcha" / ".env").write_text("changed\n")

    assert " M .orcha/.env" in _git(project, "status", "--porcelain").splitlines()


def test_no_repository_or_a_parent_repository_is_left_alone(tmp_path):
    loose = _project(tmp_path / "Loose", repo=False)
    wtb.ensure_runtime_ignored(loose)
    assert not (loose / ".git").exists()
    assert (loose / ".orcha" / ".gitignore").is_file()  # ready for a later `git init`

    documents, project = _empty_parent_with_project(tmp_path)
    _project(project, repo=False)
    before = {k: v for k, v in _snapshot(documents).items() if k.startswith(".git/")}
    wtb.ensure_runtime_ignored(project)
    after = {k: v for k, v in _snapshot(documents).items() if k.startswith(".git/")}
    assert after == before
    # …yet `git add -A` in that parent no longer picks up the project's stack secrets
    seen = _untracked(documents)
    assert "Research/LearnChat/notes.md" in seen
    assert not any("/.orcha/" in p for p in seen)


def test_a_repository_made_by_project_setup_starts_clean(tmp_path):
    """GH #301 "Set up Git for this project": the new repository already excludes them."""
    documents, project = _empty_parent_with_project(tmp_path)
    _project(project, repo=False)

    ok, detail = preflight.setup_project_repository(str(project), notifier)

    assert ok, detail
    assert "/.claude/.orcha-*" in _exclude(project).split()
    assert _untracked(project) == set(PROJECT) | {"notes.md"}


def test_every_project_start_applies_it(tmp_path, monkeypatch):
    """Native (`orcha serve` / `orcha portal`) and Docker (`orcha up` / `init`) starts."""
    monkeypatch.setattr(cli_project_setup, "export_pairing_host", lambda *a, **k: None)
    monkeypatch.setattr(cli_project_setup, "export_gh_token", lambda: None)

    native = _project(tmp_path / "Native")
    cli_portal._prepare_host_state(native)
    assert _untracked(native) == set(PROJECT)

    docker = _project(tmp_path / "Docker")
    real_run = subprocess.run
    composed = []

    def run(cmd, *a, **k):
        if cmd[0] == "git":
            return real_run(cmd, *a, **k)
        composed.append(cmd)
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(subprocess, "run", run)
    cli_project_setup.compose(
        docker / ".orcha", "up", "-d", ensure_key=lambda _d: None, export_host=lambda: None
    )
    monkeypatch.setattr(subprocess, "run", real_run)
    assert composed and composed[0][:2] == ["docker", "compose"]
    assert _untracked(docker) == set(PROJECT)


@pytest.mark.parametrize("code, out", [(1, ""), (0, ""), (0, None)])
def test_a_failing_git_never_breaks_a_start(tmp_path, code, out):
    project = _project(tmp_path / "App")
    wtb.ensure_runtime_ignored(project, run_git=lambda *a, **k: (code, out))
    assert (project / ".orcha" / ".gitignore").is_file()
