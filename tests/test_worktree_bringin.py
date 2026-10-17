"""GH #288 — bring an agent's task-worktree changes into the main checkout (and the reverse),
explicitly, with a dry run first. Real git repositories; nothing is mocked."""

import json
import pathlib
import subprocess

import pytest
from orcha_cli import notifier_worktree_gc as ngc
from orcha_cli import worktree_bringin as bi


def _git(args, cwd):
    p = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    assert p.returncode == 0, f"git {args}: {p.stdout}{p.stderr}"
    return p.stdout


def _commit(cwd, msg):
    _git(["add", "-A", "--", "."], cwd)
    _git(["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", msg], cwd)


@pytest.fixture
def repo(tmp_path):
    """main checkout (with origin) + one provisioned task worktree with an agent's work in it."""
    main = tmp_path / "main"
    main.mkdir()
    _git(["init", "-q"], main)
    _git(["symbolic-ref", "HEAD", "refs/heads/main"], main)
    (main / "a.txt").write_text("a1\n")
    (main / "b.txt").write_text("b1\n")
    (main / ".gitignore").write_text("*.log\n")
    _commit(main, "base")
    _git(["clone", "-q", "--bare", str(main), str(tmp_path / "origin.git")], tmp_path)
    _git(["remote", "add", "origin", str(tmp_path / "origin.git")], main)
    _git(["fetch", "-q", "origin"], main)
    (main / ".git" / "info" / "exclude").write_text(".orcha-worktrees/\n")
    wt = main / ".orcha-worktrees" / "task-bob-deadbeef-1"
    wt.parent.mkdir()
    _git(["worktree", "add", "-q", "-b", "orcha/task-bob-deadbeef-1", str(wt), "origin/main"], main)
    (wt / "a.txt").write_text("a1\nagent\n")
    _commit(wt, "agent work")
    (wt / "b.txt").write_text("b1\nagent-uncommitted\n")
    (wt / "new.txt").write_text("new\n")
    (wt / "junk.log").write_text("ignored\n")
    (wt / ".claude").mkdir()
    (wt / ".claude" / "settings.json").write_text("{}")
    return main, wt


def _status(cwd):
    return [line for line in _git(["status", "--porcelain"], cwd).splitlines() if line.strip()]


def test_plan_lists_the_agents_delta_and_changes_nothing(repo):
    main, wt = repo
    plan = bi.plan_bring_in(str(main), str(wt))
    assert plan["nothing_to_do"] is False and plan["conflicts"] == [] and plan["error"] is None
    assert {(f["status"], f["path"]) for f in plan["files"]} == {("M", "a.txt"), ("M", "b.txt"), ("A", "new.txt")}
    assert plan["needs_stash"] is False and plan["main_ahead"] is False and plan["other_branch"] is False
    assert _status(main) == [] and "junk.log" not in json.dumps(plan)
    assert len(_git(["worktree", "list"], main).splitlines()) == 2  # the rehearsal worktree is gone


def test_apply_lands_uncommitted_in_main_with_a_named_stash_and_a_record(repo):
    main, wt = repo
    (main / "c.txt").write_text("c1\n")
    _commit(main, "main moved ahead")
    (main / "dirty.txt").write_text("human wip\n")
    plan = bi.plan_bring_in(str(main), str(wt))
    assert plan["main_ahead"] is True and plan["needs_stash"] is True and plan["main_dirty"] == ["dirty.txt"]

    res = bi.bring_in(str(main), str(wt), stash=True, stash_message="my wip")
    assert res["outcome"] == "done" and res["stash"] == "my wip" and res["stash_restore"] == "restored"
    assert (main / "a.txt").read_text() == "a1\nagent\n"
    assert (main / "new.txt").read_text() == "new\n"
    assert (main / "dirty.txt").read_text() == "human wip\n"          # the human's file is back
    assert not (main / "junk.log").exists() and not (main / ".claude").exists()
    assert sorted(_status(main)) == [" M a.txt", " M b.txt", "?? dirty.txt", "?? new.txt"]  # unstaged
    assert _git(["stash", "list"], main).strip() == ""                  # dropped after a clean restore
    record = json.loads(bi.record_path(str(main), str(wt)).read_text())
    assert record["files"] == ["a.txt", "b.txt", "new.txt"] and record["mode"] == "apply"
    # the agent's worktree is untouched
    assert (wt / "b.txt").read_text() == "b1\nagent-uncommitted\n" and (wt / "junk.log").exists()


def test_apply_on_a_dirty_main_without_a_stash_keeps_the_humans_edits(repo):
    main, wt = repo
    (main / "b.txt").write_text("b1\nhuman line at the end\n")
    (wt / "b.txt").write_text("agent line at the top\nb1\n")
    plan = bi.plan_bring_in(str(main), str(wt))
    assert plan["needs_stash"] is True and plan["conflicts"] == []
    res = bi.bring_in(str(main), str(wt))          # no stash: three-way on top of the dirty tree
    assert res["outcome"] == "done" and res["stash"] is None
    assert (main / "b.txt").read_text() == "agent line at the top\nb1\nhuman line at the end\n"
    (wt / "more.txt").write_text("more\n")
    with pytest.raises(bi.BringInError, match="merge needs them stashed"):
        bi.bring_in(str(main), str(wt), mode="merge")


def test_repeat_bring_in_is_incremental(repo):
    main, wt = repo
    bi.bring_in(str(main), str(wt))
    assert bi.bring_in(str(main), str(wt))["outcome"] == "nothing-to-do"
    (wt / "new.txt").write_text("new2\n")
    plan = bi.plan_bring_in(str(main), str(wt))
    assert plan["incremental"] is True and [f["path"] for f in plan["files"]] == ["new.txt"]
    res = bi.bring_in(str(main), str(wt))
    assert res["outcome"] == "done" and (main / "new.txt").read_text() == "new2\n"


def test_conflicts_are_reported_and_nothing_is_applied(repo):
    main, wt = repo
    (main / "a.txt").write_text("a1\nhuman\n")
    _commit(main, "human edits a.txt")
    plan = bi.plan_bring_in(str(main), str(wt))
    assert plan["conflicts"] == ["a.txt"] and plan["error"] is None
    with pytest.raises(bi.BringInError, match="conflicts in a.txt"):
        bi.bring_in(str(main), str(wt), stash=True)
    assert _status(main) == [] and (main / "a.txt").read_text() == "a1\nhuman\n"
    assert bi.read_record(str(main), str(wt)) is None


def test_main_on_another_branch_needs_confirmation(repo):
    main, wt = repo
    _git(["checkout", "-q", "-b", "feature"], main)
    plan = bi.plan_bring_in(str(main), str(wt))
    assert plan["other_branch"] is True and plan["main_branch"] == "feature"
    with pytest.raises(bi.BringInError, match="checked out on 'feature'"):
        bi.bring_in(str(main), str(wt))
    assert bi.bring_in(str(main), str(wt), allow_other_branch=True)["outcome"] == "done"
    assert (main / "new.txt").exists()


def test_a_running_agent_is_refused(repo):
    main, wt = repo
    with pytest.raises(bi.BringInError, match="agent is running"):
        bi.plan_bring_in(str(main), str(wt), busy={str(wt)})


def test_merge_mode_wip_commits_the_agent_work_and_merges_the_branch(repo):
    main, wt = repo
    plan = bi.plan_bring_in(str(main), str(wt), mode="merge")
    assert plan["conflicts"] == [] and {f["path"] for f in plan["files"]} == {"a.txt", "b.txt", "new.txt"}
    res = bi.bring_in(str(main), str(wt), mode="merge")
    assert res["outcome"] == "done" and res["wip_commit"] and res["merge_commit"]
    assert "Merge branch 'orcha/task-bob-deadbeef-1'" in _git(["log", "--oneline", "-1"], main)
    assert _status(main) == [] and (main / "new.txt").read_text() == "new\n"
    assert _status(wt) == ["?? .claude/"]  # the WIP commit took the agent's uncommitted work


def test_stash_that_no_longer_applies_is_kept_and_the_bring_in_stands(repo):
    main, wt = repo
    (main / "new.txt").write_text("the human's own new.txt\n")   # same NEW file, other content
    res = bi.bring_in(str(main), str(wt), stash=True)
    assert res["outcome"] == "done" and res["stash_restore"] == "kept"
    assert (main / "new.txt").read_text() == "new\n"                  # what was brought in stands
    assert res["stash"].startswith("orcha-bring-in/task-bob-deadbeef-1/")
    assert res["stash"] in _git(["stash", "list"], main)             # the human's file is in there


def test_update_from_main_merges_head_and_applies_mains_uncommitted_changes(repo):
    main, wt = repo
    (main / "c.txt").write_text("c1\n")
    _commit(main, "main ahead")
    (main / "d.txt").write_text("uncommitted in main\n")
    plan = bi.plan_update(str(main), str(wt))
    assert plan["commits_behind"] == 1 and [f["path"] for f in plan["files"]] == ["c.txt", "d.txt"]
    assert plan["needs_stash"] is True and plan["agent_dirty"] == ["b.txt", "new.txt"]
    with pytest.raises(bi.BringInError, match="confirm stashing"):
        bi.update_from_main(str(main), str(wt))
    res = bi.update_from_main(str(main), str(wt), stash=True, stash_message="agent wip")
    assert res["outcome"] == "done" and res["merge_commit"] and res["stash_restore"] == "restored"
    assert (wt / "c.txt").exists() and (wt / "d.txt").read_text() == "uncommitted in main\n"
    assert (wt / "b.txt").read_text() == "b1\nagent-uncommitted\n"   # the agent's own work is back
    assert _status(main) == ["?? d.txt"]                              # main untouched
    assert bi.plan_update(str(main), str(wt))["nothing_to_do"] is True


def test_update_conflicts_are_reported_first(repo):
    main, wt = repo
    (main / "a.txt").write_text("a1\nhuman\n")
    _commit(main, "human edits a.txt")
    plan = bi.plan_update(str(main), str(wt))
    assert plan["conflicts"] == ["a.txt"]
    with pytest.raises(bi.BringInError, match="conflicts in a.txt"):
        bi.update_from_main(str(main), str(wt), stash=True)
    assert (wt / "a.txt").read_text() == "a1\nagent\n"


def test_only_a_managed_worktree_on_a_branch_is_accepted(repo, tmp_path):
    main, wt = repo
    with pytest.raises(bi.BringInError, match="no longer there"):
        bi.plan_bring_in(str(main), str(main / ".orcha-worktrees" / "gone"))
    other = tmp_path / "elsewhere"
    _git(["worktree", "add", "-q", "--detach", str(other), "origin/main"], main)
    with pytest.raises(bi.BringInError, match="under .orcha-worktrees"):
        bi.plan_bring_in(str(main), str(other))


def test_daemon_runs_the_request_and_reports_the_plan_or_the_refusal(repo):
    main, wt = repo
    out = ngc.run_bring_in(str(main), {"action": "bring_in", "path": str(wt), "options": {}}, set())
    assert out["status"] == "done" and out["result"]["file_count"] == 3 and _status(main) == []
    out = ngc.run_bring_in(str(main), {"action": "bring_in", "path": str(wt),
                                       "options": {"dry_run": False, "mode": "apply"}}, set())
    assert out["status"] == "done" and out["result"]["outcome"] == "done" and (main / "new.txt").exists()
    out = ngc.run_bring_in(str(main), {"action": "update_from_main", "path": str(wt),
                                       "options": {"dry_run": False}}, {str(wt)})
    assert out["status"] == "failed" and "agent is running" in out["error"]
    out = ngc.run_action("http://p", "c1", str(main), {"action": "update_from_main", "path": str(wt),
                                                     "options": {}}, set(), post=lambda *a, **k: {})
    assert out["status"] == "done" and out["result"]["direction"] == "update"


# ---------------------------------------------------------------- the CLI

def _cli(argv, capsys):
    from orcha_cli.__main__ import build_parser

    args = build_parser().parse_args(argv)
    try:
        args.func(args)
        code = 0
    except SystemExit as exc:
        code = exc.code
    return code, capsys.readouterr().out


def test_resolve_task_worktree_by_path_name_task_or_agent():
    from orcha_cli.cli_worktrees import resolve_task_worktree

    rows = [
        {"path": "/p/.orcha-worktrees/task-bob-deadbeef-1", "name": "task-bob-deadbeef-1", "kind": "task",
         "agent": "bob", "task_id": "deadbeef-1111", "task_ref": "deadbeef-1"},
        {"path": "/p/.orcha-worktrees/task-bob-cafe0000-1", "name": "task-bob-cafe0000-1", "kind": "task",
         "agent": "bob", "task_id": "cafe0000-2222", "task_ref": "cafe0000-1"},
        {"path": "/p/.orcha-worktrees/bob-123", "name": "bob-123", "kind": "wake", "agent": "bob"},
    ]
    assert resolve_task_worktree(rows, "task-bob-cafe0000-1")[0]["task_ref"] == "cafe0000-1"
    assert resolve_task_worktree(rows, "deadbeef")[0]["task_ref"] == "deadbeef-1"
    row, why = resolve_task_worktree(rows, "bob")
    assert row is None and "matches 2 task worktrees" in why
    assert resolve_task_worktree(rows, "nope")[1].startswith("nope is not a task worktree")


def test_cli_bring_in_dry_run_then_apply_and_update(repo, capsys, monkeypatch):
    main, wt = repo
    (main / ".claude").mkdir(exist_ok=True)
    monkeypatch.chdir(main)
    code, out = _cli(["worktrees", "bring-in", "deadbeef", "--offline", "--dry-run"], capsys)
    assert code == 0 and "Would change 3 file(s) in main (dry run" in out and "A new.txt" in out
    assert _git(["status", "--porcelain"], main).strip() == ""
    code, out = _cli(["worktree", "bring-in", str(wt), "--offline", "--json"], capsys)
    assert code == 0
    res = json.loads(out)
    assert res["ok"] is True and res["outcome"] == "done" and (main / "new.txt").exists()
    (main / "d.txt").write_text("uncommitted in main\n")
    code, out = _cli(["worktrees", "update-from-main", "bob", "--offline", "--dry-run"], capsys)
    assert code == 0 and "Would bring" not in out and "d.txt" in out and "--stash" in out
    code, out = _cli(["worktrees", "update-from-main", "bob", "--offline"], capsys)
    assert code == 1 and "confirm stashing" in out
    code, out = _cli(["worktrees", "update-from-main", "bob", "--offline", "--stash", "--stash-message", "agent wip"], capsys)
    assert code == 0 and "stash 'agent wip' restored" in out and (wt / "d.txt").exists()
    code, out = _cli(["worktrees", "bring-in", "nope", "--offline"], capsys)
    assert code == 1 and "not a task worktree" in out
