"""Checkpoint commits must never sweep in Embodent scaffolding (a committed wake log or .orcha
overlay makes the task branch look unmerged, so cleanup keeps it forever) — and must still
checkpoint real work when some scaffolding is gitignored (`:(exclude)` pathspecs on
`git add` made it refuse and stage nothing)."""
import subprocess
from pathlib import Path

import pytest

from orcha_cli.notifier_worktree_cleanup import SCAFFOLD_UNSTAGE
from orcha_cli.worktree_gc import SCAFFOLDING_PATTERNS


def _git(cwd, *args, check=True):
    return subprocess.run(["git", *args], cwd=cwd, check=check, capture_output=True, text=True)


def _repo(tmp_path: Path, gitignore: str = "") -> Path:
    repo = tmp_path / "r"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@t")
    _git(repo, "config", "user.name", "t")
    (repo / "README.md").write_text("x\n")
    (repo / ".claude").mkdir()
    (repo / ".claude" / "settings.json").write_text('{"user": 1}\n')  # the user's tracked file
    if gitignore:
        (repo / ".gitignore").write_text(gitignore)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "init")
    for pat in SCAFFOLDING_PATTERNS:
        f = repo / pat.replace("*", "sample")
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text("scaffold\n")
    (repo / "src.py").write_text("print('real work')\n")
    return repo


@pytest.mark.parametrize("gitignore", ["", ".orcha/\n.codex/\n.claude/settings.local.json\n.claude/orcha.json\n"])
def test_checkpoint_stages_only_real_work(tmp_path: Path, gitignore: str):
    repo = _repo(tmp_path, gitignore)
    assert _git(repo, "add", "-A", "--", ".").returncode == 0
    _git(repo, "reset", "-q", "--", *SCAFFOLD_UNSTAGE)
    staged = set(_git(repo, "diff", "--cached", "--name-only").stdout.split())
    assert staged == {"src.py"}, f"scaffolding leaked into the checkpoint: {sorted(staged - {'src.py'})}"
