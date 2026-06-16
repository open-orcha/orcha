"""ISS-8 — per-worker git worktree isolation + net git-diff capture.

Exercises the real git helpers in notifier.py against a throwaway repo (bare origin +
working clone), plus the tick-level heuristic (worktree only for code-touching wakes).
"""
import pathlib
import subprocess

from orcha_cli import notifier  # noqa: E402 (conftest puts orcha-cli on sys.path)


def _git(args, cwd):
    subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True)


def _make_repo(tmp_path):
    """A bare 'origin' with a main branch + a working clone wired to it."""
    origin = tmp_path / "origin.git"
    _git(["init", "--bare", str(origin)], tmp_path)
    work = tmp_path / "work"
    work.mkdir()
    _git(["init"], work)
    _git(["symbolic-ref", "HEAD", "refs/heads/main"], work)   # portable: unborn HEAD -> main
    _git(["config", "user.email", "t@t"], work)
    _git(["config", "user.name", "t"], work)
    (work / "README.md").write_text("hi\n")
    _git(["add", "-A"], work)
    _git(["commit", "-m", "init"], work)
    _git(["remote", "add", "origin", str(origin)], work)
    _git(["push", "-u", "origin", "main"], work)
    return work


def test_provision_isolated_worktree_diff_and_teardown(tmp_path):
    work = _make_repo(tmp_path)
    # runtime config the fresh checkout lacks (gitignored in real life) must be overlaid
    (work / ".claude").mkdir()
    (work / ".claude" / "orcha.json").write_text('{"api_base_url":"http://x"}')

    wt, branch = notifier._provision_worktree(str(work), "fast")
    assert wt and pathlib.Path(wt).is_dir()
    assert (pathlib.Path(wt) / ".claude" / "orcha.json").exists()   # config overlaid → worker can reach API

    # an edit shows in the net diff (incl. a Bash-style new file)
    (pathlib.Path(wt) / "README.md").write_text("hi\nedited by worker\n")
    (pathlib.Path(wt) / "new.txt").write_text("created\n")
    diff = notifier._capture_diff(wt)
    assert "edited by worker" in diff and "new.txt" in diff

    # edit-then-undo nets to EMPTY (the worktree-diff property the stream-json log lacks)
    (pathlib.Path(wt) / "README.md").write_text("hi\n")
    (pathlib.Path(wt) / "new.txt").unlink()
    assert (notifier._capture_diff(wt) or "").strip() == ""

    # teardown removes the worktree; branch deleted (no commits worth keeping)
    notifier._teardown_worktree(str(work), wt, branch)
    assert not pathlib.Path(wt).exists()
    _, out = notifier._run_git(["branch", "--list", branch], cwd=str(work))
    assert branch not in out


def test_two_workers_do_not_tangle(tmp_path):
    work = _make_repo(tmp_path)
    wt1, b1 = notifier._provision_worktree(str(work), "alice")
    wt2, b2 = notifier._provision_worktree(str(work), "bob")
    assert wt1 != wt2 and b1 != b2
    (pathlib.Path(wt1) / "a.txt").write_text("alice was here\n")
    (pathlib.Path(wt2) / "b.txt").write_text("bob was here\n")
    d1, d2 = notifier._capture_diff(wt1), notifier._capture_diff(wt2)
    assert "alice was here" in d1 and "bob was here" not in d1   # isolated
    assert "bob was here" in d2 and "alice was here" not in d2
    notifier._teardown_worktree(str(work), wt1, b1)
    notifier._teardown_worktree(str(work), wt2, b2)


def test_teardown_keeps_branch_with_commits(tmp_path):
    work = _make_repo(tmp_path)
    wt, branch = notifier._provision_worktree(str(work), "committer")
    (pathlib.Path(wt) / "f.txt").write_text("work\n")
    _git(["add", "-A"], wt)
    _git(["commit", "-m", "did work"], wt)
    notifier._teardown_worktree(str(work), wt, branch)
    assert not pathlib.Path(wt).exists()                         # worktree dir gone
    _, out = notifier._run_git(["branch", "--list", branch], cwd=str(work))
    assert branch in out                                         # branch KEPT (PR-ready)


def test_provision_noop_outside_git_repo(tmp_path):
    wt, branch = notifier._provision_worktree(str(tmp_path), "x")   # not a git repo
    assert wt is None and branch is None


def test_ref_illegal_alias_still_isolates(tmp_path):
    """An alias with ref-illegal chars must NOT silently fall back to the shared checkout —
    the branch name is sanitized so `git worktree add -b` succeeds."""
    work = _make_repo(tmp_path)
    for alias in ("QA Bot", "bad..ref", "x~y", "x:y", "feature/x"):
        wt, branch = notifier._provision_worktree(str(work), alias)
        assert wt is not None and branch is not None, f"alias {alias!r} failed to isolate"
        assert pathlib.Path(wt).is_dir()
        # branch must be a valid ref
        rc, _ = notifier._run_git(["check-ref-format", "--branch", branch.split("refs/heads/")[-1]],
                                  cwd=str(work))
        assert rc == 0, f"branch {branch!r} from alias {alias!r} is not a valid ref"
        notifier._teardown_worktree(str(work), wt, branch)


def test_worktrees_excluded_from_base_index(tmp_path):
    """A live worker worktree under .orcha-worktrees/ must not be staged by a base-checkout
    `git add -A` (would otherwise embed a gitlink and pollute commits)."""
    work = _make_repo(tmp_path)
    wt, branch = notifier._provision_worktree(str(work), "w")
    assert wt is not None
    _git(["add", "-A"], work)
    _, staged = notifier._run_git(["diff", "--cached", "--name-only"], cwd=str(work))
    assert ".orcha-worktrees" not in staged, f"worktree leaked into the base index:\n{staged}"
    notifier._teardown_worktree(str(work), wt, branch)


def test_provision_live_worktree_is_stable_and_reused(tmp_path):
    """ISS-67/B2: the live worktree path is DETERMINISTIC per alias and REUSED across reopens (vs
    _provision_worktree's fresh-timestamp-per-call). A reopen must return the SAME dir+branch — the
    prerequisite for the bridge's grace-window reattach (the warm claude's CWD is this path) and so a
    human's in-progress edits survive a reconnect."""
    work = _make_repo(tmp_path)
    (work / ".claude").mkdir()
    (work / ".claude" / "orcha.json").write_text('{"api_base_url":"http://x"}')

    wt1, b1 = notifier._provision_live_worktree(str(work), "Vault")
    assert wt1 and pathlib.Path(wt1).is_dir()
    assert (pathlib.Path(wt1) / ".claude" / "orcha.json").exists()    # overlay seeded
    assert "live-Vault" in wt1 and b1 == "orcha/live-Vault"           # deterministic, not timestamped

    # a human's in-progress edit in the worktree...
    (pathlib.Path(wt1) / "wip.txt").write_text("half-done\n")

    # ...survives a reopen: same path + branch, edit intact (NOT a fresh checkout)
    wt2, b2 = notifier._provision_live_worktree(str(work), "Vault")
    assert (wt2, b2) == (wt1, b1)                                     # REUSED, not re-created
    assert (pathlib.Path(wt2) / "wip.txt").read_text() == "half-done\n"

    # a DIFFERENT agent gets its own stable path (no tangle)
    wt3, _ = notifier._provision_live_worktree(str(work), "Frame")
    assert wt3 != wt1 and "live-Frame" in wt3
    notifier._teardown_worktree(str(work), wt1, b1)
    notifier._teardown_worktree(str(work), wt3, _)


def test_provision_live_worktree_noop_outside_git_repo(tmp_path):
    wt, branch = notifier._provision_live_worktree(str(tmp_path), "Vault")
    assert wt is None and branch is None                             # caller falls back to shared cwd


def test_tick_provisions_worktree_only_for_code_wakes(monkeypatch):
    """Heuristic: a wake with an assigned/ready task (auto_start) gets a worktree;
    a pure event wake does not."""
    calls = []
    monkeypatch.setattr(notifier, "_provision_worktree",
                        lambda base, alias: calls.append(alias) or (None, None))
    monkeypatch.setattr(notifier, "select_transport", lambda c: "ephemeral")
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "_post_json",
                        lambda url, body, **k: {"claimed": True} if "wake-claim" in url
                        else ({"run_id": "R"} if url.endswith("/runs") else {}))
    monkeypatch.setattr(notifier, "spawn_headless", lambda *a, **k: (True, "cmd", _FakeP()))

    def cand(auto, latest="x", pending=1):
        return {"active": True, "candidates": [{
            "agent_id": "00000000-0000-0000-0000-000000000009", "alias": "B",
            "should_wake": True, "headless_cwd": "/proj", "tmux_target": None,
            "pending_events": pending, "auto_start_task_ids": auto, "reason": "wake",
            "latest_event": latest, "max_event_ts": 1.0, "headless_flags": None}]}

    def run_with(scan):
        calls.clear()
        monkeypatch.setattr(notifier, "_get_json", lambda url, **k: scan)
        notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0, quiet=True, live_workers={})

    run_with(cand(["task-1"]))                 # ready auto-start target
    assert calls == ["B"]
    # ISS-8.1: HUMAN-assigned in_progress task → woken via task_assigned (auto empty) → STILL isolated
    run_with(cand([], latest="task_assigned"))
    assert calls == ["B"], "human-assigned code wake must get a worktree"
    run_with(cand([], latest="task_ready"))
    assert calls == ["B"]
    # ISS-8.1-b: a MULTI-event backlog (newest is a request, but an older task event may be
    # hidden) must isolate — we only see the newest name, so be conservative.
    run_with(cand([], latest="request_created", pending=2))
    assert calls == ["B"], "multi-event backlog may hide a task wake → must isolate"
    # request_created is published for INFO *and* TASK requests → not skip-safe (a task
    # request, once accepted, does code work). Even a single one must isolate.
    run_with(cand([], latest="request_created", pending=1))
    assert calls == ["B"], "request_created may be a task request → must isolate"
    # only an answer/close to our own ask is confidently no-code → skip
    run_with(cand([], latest="request_answered", pending=1))
    assert calls == []
    run_with(cand([], latest="request_closed", pending=1))
    assert calls == []
    # PR #132 review [P1]: a task_message wake is now ACTIONABLE (ISS-55 — the worker reads the
    # task thread and may edit code, e.g. "rebase onto main"), so it must isolate like task work.
    run_with(cand([], latest="task_message", pending=1))
    assert calls == ["B"], "task_message is actionable now → must get a worktree (ISS-8)"
    # ...and a task_message hidden behind a newer event still isolates via wake_task_id.
    calls.clear()
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: {"active": True, "candidates": [{
        "agent_id": "00000000-0000-0000-0000-000000000009", "alias": "B", "should_wake": True,
        "headless_cwd": "/proj", "tmux_target": None, "pending_events": 1,
        "auto_start_task_ids": [], "wake_task_id": "TASK-7", "reason": "wake",
        "latest_event": "request_answered", "max_event_ts": 1.0, "headless_flags": None}]})
    notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0, quiet=True, live_workers={})
    assert calls == ["B"], "wake_task_id present → task work → must isolate"


def _event_scan():
    return {"active": True, "candidates": [{
        "agent_id": "00000000-0000-0000-0000-000000000009", "alias": "B",
        "should_wake": True, "headless_cwd": "/proj", "tmux_target": None,
        "pending_events": 1, "auto_start_task_ids": [], "reason": "wake",
        "latest_event": "task_assigned", "max_event_ts": 1.0, "headless_flags": None}]}


def _wire_spawn(monkeypatch, posts, run_resp):
    monkeypatch.setattr(notifier, "select_transport", lambda c: "ephemeral")
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "_provision_worktree", lambda b, a: (None, None))
    monkeypatch.setattr(notifier, "spawn_headless", lambda *a, **k: (True, "cmd", _FakeP()))
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: _event_scan())
    monkeypatch.setattr(notifier, "_post_json",
                        lambda url, body, **k: posts.append(url) or
                        ({"claimed": True} if "wake-claim" in url
                         else (run_resp if url.endswith("/runs") else {})))


def test_event_wake_records_run_and_logs_failure(monkeypatch, capsys):
    """ISS-8.2: a DAEMON-LOOP event-wake (no auto_start) records a worker_run; a failed
    POST /runs is logged, not swallowed."""
    posts = []
    _wire_spawn(monkeypatch, posts, run_resp=None)   # /runs fails → returns None
    notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0, quiet=False, live_workers={})
    assert any(u.endswith("/runs") for u in posts)               # recorded on event-wake
    assert "worker_run NOT recorded" in capsys.readouterr().err  # failure logged


def test_once_path_does_not_create_dangling_run(monkeypatch):
    """P2 fix: --once (live_workers is None) has no reaper to /finish a run, so it must NOT
    create a perpetual status=running row."""
    posts = []
    _wire_spawn(monkeypatch, posts, run_resp={"run_id": "R"})
    notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0, quiet=True, live_workers=None)
    assert not any(u.endswith("/runs") for u in posts), "--once must not create an unfinishable run"


class _FakeP:
    pid = 1
    def poll(self): return None
