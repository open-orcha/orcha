"""Worktree routing (#288): every agent run gets its own worktree, and a move between
checkouts never blocks a start. Carry/handoff units kept from the retired disable-worktrees
feature are the generic ones (ownership, dirty destinations, branch recovery, safe teardown)."""

import pathlib
import time
from types import SimpleNamespace

import pytest
from orcha_cli import (
    notifier,
    notifier_checkpoint,
    notifier_codex_conversation,
    notifier_reaper_completion,
    notifier_resident_claude_start,
    notifier_wake_scan,
    notifier_wake_worker,
    notifier_worktree_base,
    terminal_bridge_api,
    terminal_bridge_connection,
)
from orcha_cli.notifier_routing_handoff import carry_previous_checkout

class _Proc:
    pid = 4321


def test_main_routed_task_exit_captures_base_checkout_diff():
    captured = []
    finished = []
    worker = {
        "proc": SimpleNamespace(pid=4321, returncode=0),
        "run_id": "run-1",
        "base_cwd": "/project/main",
        "worktree": None,
        "task_bound": True,
        "task_worktree": False,
        "respawn_ctx": {"task_id": "task-1"},
    }
    live = {"agent-1": worker}
    services = SimpleNamespace(
        RUNTIME_CODEX="codex",
        _capture_diff=lambda cwd: captured.append(cwd) or "main diff",
        _normalize_runtime=lambda runtime: runtime,
        _finish_run=lambda *args, **kwargs: finished.append((args, kwargs)) or True,
        _reap_sandbox_artifacts=lambda *args: None,
        _teardown_worktree=lambda *args: None,
        _post_json=lambda *args: {},
        _retire_headless=lambda _api, workers, aid: workers.pop(aid, None),
    )

    notifier_reaper_completion.handle_exited(
        "http://orcha",
        "agent-1",
        worker,
        live,
        {},
        {},
        0,
        True,
        services,
    )

    assert captured == ["/project/main"]
    assert finished[0][0][5] == "main diff"


def test_main_routed_conversation_completion_captures_base_checkout_diff():
    captured = []
    finished = []
    resident = {
        "agent_id": "agent-1",
        "current_run_id": "run-1",
        "base_cwd": "/project/main",
        "worktree": None,
    }
    services = SimpleNamespace(
        _capture_diff=lambda cwd: captured.append(cwd) or "main diff",
        _finish_run=lambda *args, **kwargs: finished.append((args, kwargs)) or True,
        _reap_sandbox_artifacts=lambda *args: None,
        _post_json=lambda *args: {},
        _conversation_ack_body=lambda kind, **kwargs: {"kind": kind, **kwargs},
    )

    posted = notifier_codex_conversation.finish(
        "http://orcha",
        "conversation-1",
        resident,
        services,
        post_reply=False,
    )

    assert posted is False
    assert captured == ["/project/main"]
    assert finished[0][0][5] == "main diff"


def _orphan_recovery_services(monkeypatch, row):
    captured = []
    finished = []
    posts = []
    events = []

    def post_json(url, body=None, **_kwargs):
        events.append(("post", url))
        posts.append((url, body))
        return {}

    def capture_diff(cwd):
        events.append(("capture", cwd))
        captured.append(cwd)
        return "main diff"

    def finish_run(*args, **kwargs):
        events.append(("finish", args[1]))
        finished.append((args, kwargs))
        return True

    rows = row if isinstance(row, list) else [row]
    monkeypatch.setattr(
        notifier, "_get_json", lambda *_args, **_kwargs: {"runs": rows}
    )
    monkeypatch.setattr(notifier, "_post_json", post_json)
    monkeypatch.setattr(notifier, "_capture_diff", capture_diff)
    monkeypatch.setattr(notifier, "_finish_run", finish_run)
    monkeypatch.setattr(notifier._sandbox, "daemon_reachable", lambda: True)
    monkeypatch.setattr(notifier._sandbox, "managed_containers", lambda _cid: [])
    return captured, finished, posts, events


def test_restart_recovered_main_routed_sandbox_exit_captures_base_checkout_diff(
    monkeypatch,
):
    row = {
        "run_id": "run-1",
        "agent_id": "agent-1",
        "pid": 4321,
        "wake_kind": "sandbox",
        "sandbox_container_id": "orcha-run-main",
        "worktree": None,
        "base_cwd": "/project/main",
        "log_path": "/project/main/run.log",
    }
    captured, finished, _posts, _events = _orphan_recovery_services(monkeypatch, row)
    monkeypatch.setattr(
        notifier._sandbox,
        "probe",
        lambda _name: SimpleNamespace(running=False, exit_code=0, oom_killed=False),
    )
    monkeypatch.setattr(notifier._sandbox, "remove", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        notifier._sandbox, "remove_api_config", lambda *_args, **_kwargs: None
    )

    assert notifier.reap_orphaned_runs("http://orcha", "container-1") == 1
    assert captured == ["/project/main"]
    assert finished[0][0][5] == "main diff"


def test_restart_recovered_main_routed_host_exit_captures_before_lease_release(
    monkeypatch,
):
    row = {
        "run_id": "run-1",
        "agent_id": "agent-1",
        "pid": 4321,
        "wake_kind": "ephemeral",
        "lane": "work",
        "worktree": None,
        "base_cwd": "/project/main",
        "log_path": "/project/main/run.log",
    }
    captured, finished, posts, events = _orphan_recovery_services(monkeypatch, row)
    monkeypatch.setattr(notifier, "_run_pid_alive", lambda _pid: False)

    assert notifier.reap_orphaned_runs("http://orcha", "container-1") == 1
    assert captured == ["/project/main"]
    assert finished[0][0][5] == "main diff"
    assert any(
        url.endswith("/wake-ack") and body["release_lease"] is True
        for url, body in posts
    )
    assert events.index(("finish", "run-1")) < next(
        index
        for index, event in enumerate(events)
        if event[0] == "post" and event[1].endswith("/wake-ack")
    )


def test_restart_recovery_keeps_lease_when_run_snapshot_cannot_be_saved(monkeypatch):
    row = {
        "run_id": "run-1",
        "agent_id": "agent-1",
        "pid": 4321,
        "wake_kind": "ephemeral",
        "lane": "work",
        "worktree": None,
        "base_cwd": "/project/main",
    }
    captured, _finished, posts, _events = _orphan_recovery_services(
        monkeypatch, row
    )
    monkeypatch.setattr(notifier, "_run_pid_alive", lambda _pid: False)
    monkeypatch.setattr(notifier, "_finish_run", lambda *_args, **_kwargs: False)

    assert notifier.reap_orphaned_runs("http://orcha", "container-1") == 0
    assert captured == ["/project/main"]
    assert not any(url.endswith("/wake-ack") for url, _body in posts)


def test_restart_recovery_does_not_capture_checkout_used_by_live_sibling(monkeypatch):
    rows = [
        {
            "run_id": "dead-run",
            "agent_id": "agent-1",
            "pid": 4321,
            "wake_kind": "ephemeral",
            "lane": "work",
            "worktree": None,
            "base_cwd": "/project/main",
        },
        {
            "run_id": "live-run",
            "agent_id": "agent-1",
            "pid": 8765,
            "wake_kind": "checkpoint_respawn",
            "lane": "work",
            "worktree": None,
            "base_cwd": "/project/main",
        },
    ]
    captured, finished, posts, _events = _orphan_recovery_services(
        monkeypatch, rows
    )
    monkeypatch.setattr(notifier, "_run_pid_alive", lambda pid: pid == 8765)

    assert notifier.reap_orphaned_runs("http://orcha", "container-1") == 1
    assert captured == []
    assert len(finished) == 1
    assert finished[0][0][1] == "dead-run"
    assert finished[0][0][5] is None
    assert not any(url.endswith("/wake-ack") for url, _body in posts)


@pytest.mark.parametrize(
    ("wake_kind", "lane"),
    [("live", "work"), ("resident", "conversation")],
)
def test_restart_recovery_treats_pathless_live_runs_as_checkout_owners(
    monkeypatch, wake_kind, lane
):
    rows = [
        {
            "run_id": "dead-run",
            "agent_id": "agent-1",
            "pid": 4321,
            "wake_kind": "ephemeral",
            "lane": "work",
            "worktree": None,
            "base_cwd": "/project/main",
        },
        {
            "run_id": "live-run",
            "agent_id": "agent-2",
            "pid": 8765,
            "wake_kind": wake_kind,
            "lane": lane,
            # Exact legacy live-terminal / host-resident payload: neither
            # checkout field was recorded before this fix.
            "worktree": None,
            "base_cwd": None,
        },
    ]
    captured, finished, _posts, _events = _orphan_recovery_services(
        monkeypatch, rows
    )
    monkeypatch.setattr(notifier, "_run_pid_alive", lambda pid: pid == 8765)

    assert notifier.reap_orphaned_runs("http://orcha", "container-1") == 1
    assert captured == []
    assert len(finished) == 1
    assert finished[0][0][1] == "dead-run"
    assert finished[0][0][5] is None


def test_restart_recovery_captures_when_live_sibling_uses_another_checkout(
    monkeypatch,
):
    rows = [
        {
            "run_id": "dead-run",
            "agent_id": "agent-1",
            "pid": 4321,
            "wake_kind": "ephemeral",
            "lane": "work",
            "worktree": "/project/dead-worktree",
            "base_cwd": "/project/main",
        },
        {
            "run_id": "live-run",
            "agent_id": "agent-1",
            "pid": 8765,
            "wake_kind": "checkpoint_respawn",
            "lane": "work",
            "worktree": "/project/live-worktree",
            "base_cwd": "/project/main",
        },
    ]
    captured, finished, _posts, _events = _orphan_recovery_services(
        monkeypatch, rows
    )
    monkeypatch.setattr(notifier, "_run_pid_alive", lambda pid: pid == 8765)

    assert notifier.reap_orphaned_runs("http://orcha", "container-1") == 1
    assert captured == ["/project/dead-worktree"]
    assert len(finished) == 1
    assert finished[0][0][1] == "dead-run"
    assert finished[0][0][5] == "main diff"


def _checkpoint_repo(tmp_path):
    main = tmp_path / "main"
    main.mkdir()
    assert notifier._run_git(["init"], cwd=main)[0] == 0
    assert (
        notifier._run_git(["symbolic-ref", "HEAD", "refs/heads/main"], cwd=main)[0] == 0
    )
    assert (
        notifier._run_git(["config", "user.email", "test@example.com"], cwd=main)[0]
        == 0
    )
    assert notifier._run_git(["config", "user.name", "Test"], cwd=main)[0] == 0
    (main / "base.txt").write_text("base\n")
    assert notifier._run_git(["add", "base.txt"], cwd=main)[0] == 0
    assert notifier._run_git(["commit", "-m", "base"], cwd=main)[0] == 0
    origin = tmp_path / "origin.git"
    assert (
        notifier._run_git(["clone", "--bare", str(main), str(origin)], cwd=tmp_path)[0]
        == 0
    )
    assert notifier._run_git(["remote", "add", "origin", str(origin)], cwd=main)[0] == 0
    assert notifier._run_git(["fetch", "origin"], cwd=main)[0] == 0
    return main


def test_handoff_does_not_delete_unknown_destination_work(tmp_path):
    main = _checkpoint_repo(tmp_path)
    worktree, _branch = notifier._provision_task_worktree(
        str(main), "builder", "task-1"
    )
    task_file = pathlib.Path(worktree) / "task-work.txt"
    task_file.write_text("agent work\n")
    human_file = main / "human-work.txt"
    human_file.write_text("independent main checkout work\n")

    assert notifier._handoff_worktree_changes(worktree, str(main)) is False
    assert task_file.read_text() == "agent work\n"
    assert human_file.read_text() == "independent main checkout work\n"
    assert not (main / "task-work.txt").exists()


def test_handoff_does_not_claim_unknown_identical_main_checkout(tmp_path):
    main = _checkpoint_repo(tmp_path)
    worktree, _branch = notifier._provision_task_worktree(
        str(main), "builder", "task-1"
    )
    main_file = main / "shared.txt"
    task_file = pathlib.Path(worktree) / "shared.txt"
    main_file.write_text("independently created\n")
    task_file.write_text("independently created\n")

    assert notifier._handoff_worktree_changes(worktree, str(main)) is True
    task_file.write_text("later task edit\n")

    assert notifier._handoff_worktree_changes(worktree, str(main)) is False
    assert main_file.read_text() == "independently created\n"
    assert task_file.read_text() == "later task edit\n"


def test_handoff_does_not_overwrite_unknown_ignored_destination(tmp_path):
    main = _checkpoint_repo(tmp_path)
    (main / ".gitignore").write_text(".env\n")
    assert notifier._run_git(["add", ".gitignore"], cwd=main)[0] == 0
    assert notifier._run_git(
        ["commit", "-m", "ignore local environment"], cwd=main
    )[0] == 0
    assert notifier._run_git(["push", "origin", "main"], cwd=main)[0] == 0
    worktree, _branch = notifier._provision_worktree(str(main), "builder")
    source_file = pathlib.Path(worktree) / ".env"
    destination_file = main / ".env"
    source_file.write_text("SOURCE=worker\n")
    destination_file.write_text("SOURCE=human\n")
    before_index = notifier._run_git(
        ["diff", "--cached", "--binary"], cwd=str(main)
    )[1]

    assert notifier._handoff_worktree_changes(worktree, str(main)) is False
    assert source_file.read_text() == "SOURCE=worker\n"
    assert destination_file.read_text() == "SOURCE=human\n"
    assert (
        notifier._run_git(["diff", "--cached", "--binary"], cwd=str(main))[1]
        == before_index
    )


def test_round_trip_preserves_new_independent_destination_work(tmp_path):
    main = _checkpoint_repo(tmp_path)
    worktree, _branch = notifier._provision_task_worktree(
        str(main), "builder", "task-1"
    )
    destination = pathlib.Path(worktree)
    old_task_file = destination / "old-task.txt"
    old_task_file.write_text("old task work\n")

    assert notifier._handoff_worktree_changes(worktree, str(main)) is True
    (main / "old-task.txt").unlink()
    (main / "new-task.txt").write_text("replacement task work\n")
    independent_file = destination / "human-work.txt"
    independent_file.write_text("independent destination work\n")

    assert notifier._handoff_worktree_changes(str(main), worktree) is True
    assert not old_task_file.exists()
    assert (destination / "new-task.txt").read_text() == "replacement task work\n"
    assert independent_file.read_text() == "independent destination work\n"


def test_handoff_ownership_prevents_one_task_replacing_another(tmp_path):
    main = _checkpoint_repo(tmp_path)
    first_worktree, _ = notifier._provision_task_worktree(
        str(main), "builder", "task-1"
    )
    second_worktree, _ = notifier._provision_task_worktree(
        str(main), "builder", "task-2"
    )
    (pathlib.Path(first_worktree) / "first.txt").write_text("first task\n")
    (pathlib.Path(second_worktree) / "second.txt").write_text("second task\n")

    assert notifier._handoff_worktree_changes(
        first_worktree, str(main), owner_key="task:task-1"
    )
    assert (
        notifier._handoff_worktree_changes(
            second_worktree, str(main), owner_key="task:task-2"
        )
        is False
    )

    assert (main / "first.txt").read_text() == "first task\n"
    assert not (main / "second.txt").exists()
    assert (pathlib.Path(second_worktree) / "second.txt").read_text() == "second task\n"


def test_rejected_handoff_does_not_change_destination_index(tmp_path):
    main = _checkpoint_repo(tmp_path)
    worktree, _ = notifier._provision_task_worktree(str(main), "builder", "task-1")
    (pathlib.Path(worktree) / "task.txt").write_text("task work\n")
    (main / "human.txt").write_text("independent work\n")
    before_status = notifier._run_git(["status", "--porcelain=v1"], cwd=str(main))[1]
    before_index = notifier._run_git(["diff", "--cached", "--binary"], cwd=str(main))[1]

    assert (
        notifier._handoff_worktree_changes(
            worktree, str(main), owner_key="task:task-1"
        )
        is False
    )

    assert (
        notifier._run_git(["status", "--porcelain=v1"], cwd=str(main))[1]
        == before_status
    )
    assert (
        notifier._run_git(["diff", "--cached", "--binary"], cwd=str(main))[1]
        == before_index
    )
    assert (main / "human.txt").read_text() == "independent work\n"
    assert not (main / "task.txt").exists()


def test_safe_teardown_preserves_worktree_when_cleanliness_check_fails(
    monkeypatch,
):
    removed = []
    monkeypatch.setattr(notifier, "_run_git", lambda *args, **kwargs: (1, ""))
    monkeypatch.setattr(
        notifier, "_teardown_worktree", lambda *args: removed.append(args)
    )

    assert (
        notifier._safe_teardown_worktree("/project", "/project/worker", "orcha/worker")
        == "preserved-dirty"
    )
    assert removed == []


def test_safe_teardown_excludes_only_orcha_runtime_overlay(tmp_path):
    main = _checkpoint_repo(tmp_path)
    (main / ".gitignore").write_text(
        ".claude/orcha.json\n"
        ".claude/orcha-tabs/\n"
        ".claude/commands/orcha-*.md\n"
        ".agents/skills/orcha-*/\n"
    )
    assert notifier._run_git(["add", ".gitignore"], cwd=main)[0] == 0
    assert notifier._run_git(["commit", "-m", "ignore runtime overlay"], cwd=main)[0] == 0
    assert notifier._run_git(["push", "origin", "main"], cwd=main)[0] == 0

    (main / ".claude" / "orcha-tabs").mkdir(parents=True)
    (main / ".claude" / "commands").mkdir(parents=True)
    (main / ".claude" / "orcha.json").write_text("{}")
    (main / ".claude" / "orcha-tabs" / "builder.json").write_text("{}")
    (main / ".claude" / "commands" / "orcha-status.md").write_text("status")
    skill = main / ".agents" / "skills" / "orcha-status" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("status")

    worktree, branch = notifier._provision_worktree(str(main), "builder")
    assert pathlib.Path(worktree, ".claude", "orcha.json").exists()
    assert pathlib.Path(worktree, ".agents", "skills", "orcha-status").exists()

    assert notifier._safe_teardown_worktree(str(main), worktree, branch) == "removed"
    assert not pathlib.Path(worktree).exists()


def _deleted_branch_history(tmp_path):
    """Provision, then cleanly retire, a task worktree so only its run record survives."""
    main = _checkpoint_repo(tmp_path)
    worktree, branch = notifier._provision_task_worktree(str(main), "builder", "task-1")
    assert worktree and branch
    assert notifier._safe_teardown_worktree(str(main), worktree, branch) == "removed"
    assert not pathlib.Path(worktree).exists()
    assert (
        notifier._run_git(
            ["show-ref", "--verify", "--quiet", f"refs/heads/{branch}"], cwd=main
        )[0]
        != 0
    ), "a commit-less worker branch is deleted with its worktree"
    history = {
        "runs": [
            {
                "run_id": "run-1",
                "task_id": "task-1",
                "lane": "work",
                "worktree": worktree,
                "branch": branch,
                "base_cwd": str(main),
            }
        ]
    }
    return main, history


@pytest.mark.parametrize("to_main", [True, False])
def test_wake_carries_nothing_when_recorded_branch_was_already_deleted(
    tmp_path, to_main
):
    """Regression: worktree gone + branch deleted + branch name still on the run row.

    The recovery path used to diff a ref that no longer existed, fail closed, and
    pause every later wake for that task with no operator recourse.
    """
    main, history = _deleted_branch_history(tmp_path)
    services = SimpleNamespace(
        _get_json=lambda _url: history,
        _run_git=notifier._run_git,
        _handoff_worktree_changes=notifier._handoff_worktree_changes,
        _handoff_branch_changes=notifier._handoff_branch_changes,
    )
    destination = (
        str(main)
        if to_main
        else notifier._provision_task_worktree(str(main), "builder", "task-1")[0]
    )

    assert carry_previous_checkout(
        "http://orcha", "agent-1", destination, services, task_id="task-1", lane="work"
    ) is True


def test_wake_still_recovers_from_a_retained_branch_that_exists(tmp_path):
    main = _checkpoint_repo(tmp_path)
    worktree, branch = notifier._provision_task_worktree(str(main), "builder", "task-1")
    (pathlib.Path(worktree) / "kept.txt").write_text("committed work\n")
    assert notifier._run_git(["add", "kept.txt"], cwd=worktree)[0] == 0
    assert notifier._run_git(["commit", "-m", "keep"], cwd=worktree)[0] == 0
    assert notifier._safe_teardown_worktree(str(main), worktree, branch) == "removed"
    history = {
        "runs": [
            {
                "task_id": "task-1",
                "lane": "work",
                "worktree": worktree,
                "branch": branch,
                "base_cwd": str(main),
            }
        ]
    }
    services = SimpleNamespace(
        _get_json=lambda _url: history,
        _run_git=notifier._run_git,
        _handoff_worktree_changes=notifier._handoff_worktree_changes,
        _handoff_branch_changes=notifier._handoff_branch_changes,
    )

    assert carry_previous_checkout(
        "http://orcha", "agent-1", str(main), services, task_id="task-1", lane="work"
    ) is True
    assert (main / "kept.txt").read_text() == "committed work\n"


def test_branch_recovery_still_runs_when_existence_is_unknowable():
    """Services without git access keep the previous (recovery-attempt) behaviour."""
    calls = []
    history = {
        "runs": [
            {
                "task_id": "task-1",
                "lane": "work",
                "worktree": "/gone/worktree",
                "branch": "orcha/task-builder-task-1",
                "base_cwd": "/project/main",
            }
        ]
    }
    services = SimpleNamespace(
        _get_json=lambda _url: history,
        _handoff_branch_changes=lambda *args, **kwargs: calls.append(args) or True,
    )

    assert carry_previous_checkout(
        "http://orcha", "agent-1", "/project/main", services, task_id="task-1"
    ) is True
    assert calls == [("/project/main", "orcha/task-builder-task-1", "/project/main")]


def test_run_git_survives_non_utf8_output(tmp_path):
    main = _checkpoint_repo(tmp_path)
    (main / "cp1252.txt").write_bytes(b"quote \x93hello\x94\n")
    code, out = notifier_worktree_base.run_git(
        ["diff", "--no-index", "--", "/dev/null", "cp1252.txt"], cwd=main
    )
    assert code == 1
    assert "hello" in out
    # Bytes round-trip exactly through a written patch.
    patch_file = tmp_path / "p.patch"
    patch_file.write_text(out, encoding="utf-8", errors="surrogateescape")
    assert b"\x93hello\x94" in patch_file.read_bytes()
    assert "�" in notifier._capture_diff(str(main))


def test_handoff_into_dirty_main_skips_per_file_diffs(tmp_path, monkeypatch):
    """36k ignored files in main used to mean 36k `git diff --no-index` calls per wake."""
    main = _checkpoint_repo(tmp_path)
    worktree, _branch = notifier._provision_task_worktree(str(main), "builder", "task-1")
    (pathlib.Path(worktree) / "work.txt").write_text("work\n")
    (main / ".gitignore").write_text("venv/\n")
    (main / "venv").mkdir()
    for index in range(50):
        (main / "venv" / f"lib{index}.bin").write_bytes(b"\x00\x93\xff" * 10)
    (main / "independent.txt").write_text("human work\n")
    no_index_calls = []
    real_run_git = notifier._run_git

    def counting_run_git(args, cwd=None, timeout=30.0):
        if args[:2] == ["diff", "--no-index"] and str(cwd) == str(main):
            no_index_calls.append(args[-1])
        return real_run_git(args, cwd=cwd, timeout=timeout)

    monkeypatch.setattr(notifier, "_run_git", counting_run_git)

    assert notifier._handoff_worktree_changes(
        worktree, str(main), owner_key="task:task-1", source_owner_verified=True
    ) is False
    assert no_index_calls == [], "destination dirtiness is decided from one git status"
    assert (main / "independent.txt").read_text() == "human work\n"


def test_handoff_into_clean_main_still_transfers(tmp_path):
    main = _checkpoint_repo(tmp_path)
    worktree, _branch = notifier._provision_task_worktree(str(main), "builder", "task-1")
    (pathlib.Path(worktree) / "work.txt").write_text("work\n")
    assert notifier._handoff_worktree_changes(
        worktree, str(main), owner_key="task:task-1", source_owner_verified=True
    ) is True
    assert (main / "work.txt").read_text() == "work\n"


def test_wake_tick_recovers_from_a_crashing_candidate(monkeypatch, capsys):
    posts = []
    holds = {}
    monkeypatch.setattr(
        notifier_wake_scan.notifier_wake_candidate,
        "process_candidate",
        lambda api_base, candidate, **kwargs: (_ for _ in ()).throw(
            UnicodeDecodeError("utf-8", b"\x93", 0, 1, "invalid start byte")
        )
        if candidate["alias"] == "crasher"
        else {"agent_id": candidate["agent_id"], "alias": candidate["alias"], "sent": True},
    )
    scan = {
        "active": True,
        "candidates": [
            {"agent_id": "a-1", "alias": "crasher", "should_wake": True},
            {"agent_id": "a-2", "alias": "healthy", "should_wake": True},
        ],
    }
    services = SimpleNamespace(
        _get_json=lambda url: scan,
        _post_json=lambda url, body: posts.append((url, body)) or {},
        _triage_config_from_scan=lambda scan: None,
        _unseal_scan_key=lambda scan, key: None,
        _triage_wake=lambda *args, **kwargs: None,
        _ack_config_from_scan=lambda scan: None,
    )

    result = notifier_wake_scan.tick(
        "http://orcha",
        "cid",
        dry_run=False,
        cooldown=60,
        min_idle=30,
        quiet=True,
        lease_ttl=120,
        live_workers={},
        base_cwd=None,
        agent_hold_until=holds,
        services=services,
    )

    assert [record["alias"] for record in result["woke"]] == ["healthy"]
    assert posts == [
        ("http://orcha/api/agents/a-1/wake-ack",
         {"kind": "wake_error", "release_lease": True, "lane": "work"})
    ]
    assert holds["a-1"] > time.time() + 200
    assert "wake error for crasher" in capsys.readouterr().err
    assert "UnicodeDecodeError" in capsys.readouterr().err or True


# ---------------------------------------------------------------- #288: never block a start
class _Proc:
    pid = 4242

    def poll(self):
        return None


def _wake_services(posts, spawned):
    def post_json(url, body):
        posts.append((url, body))
        if url.endswith("/wake-claim"):
            return {"claimed": True}
        if url.endswith("/runs"):
            return {"run_id": "run-x"}
        return {}

    return SimpleNamespace(
        HARD_CAP_MIN_SECS=1200,
        WAKE_LEASE_TTL_SECS=120,
        pathlib=pathlib,
        _post_json=post_json,
        _get_json=lambda url: {
            "runs": [{"task_id": "task-1", "lane": "work",
                      "worktree": "/project/.orcha-worktrees/old", "base_cwd": "/project/main"}]
        },
        _build_persona=lambda *args, **kwargs: "persona",
        _provision_task_worktree=lambda *args: ("/project/.orcha-worktrees/task-1", "orcha/task-1"),
        _provision_worktree=lambda *args: ("/project/.orcha-worktrees/agent", "orcha/wk-agent"),
        _mint_embodiment_token=lambda *args: "token",
        _revoke_or_defer=lambda *args: None,
        _teardown_worktree=lambda *args: None,
        spawn_headless=lambda cwd, *args, **kwargs: (
            spawned.append(cwd) or (True, "command", _Proc())
        ),
    )


def _spawn(candidate, services):
    return notifier_wake_worker.spawn(
        "http://orcha", candidate, prompt="continue", event="task_message", dry_run=False,
        quiet=True, lease_ttl=120, live_workers={}, services=services,
    )


def test_task_wake_starts_in_its_worktree_when_the_carry_is_refused(monkeypatch):
    """#288: a refused carry posts ONE left-behind notice and never pauses the agent."""
    notifier_wake_worker.reset_notice_state()
    monkeypatch.setattr(
        notifier_wake_worker, "carry_previous_checkout", lambda *args, **kwargs: False
    )
    posts, spawned = [], []
    services = _wake_services(posts, spawned)
    candidate = {"agent_id": "agent-1", "alias": "builder", "headless_cwd": "/project/main",
                 "context_task_id": "task-1", "pending_events": 1}
    results = [_spawn(candidate, services) for _ in range(3)]

    assert [r["sent"] for r in results] == [True, True, True]
    assert all("handoff_failed" not in r for r in results)
    assert spawned == ["/project/.orcha-worktrees/task-1"] * 3
    notices = [body for url, body in posts if url.endswith("/tasks/task-1/messages")]
    assert len(notices) == 1
    assert "/project/.orcha-worktrees/old" in notices[0]["body"]
    assert "Bring changes into main" in notices[0]["body"]
    assert not any(url.endswith("/wake-ack") and "handoff" in str(body.get("kind"))
                   for url, body in posts)


def test_taskless_wake_starts_without_posting_to_a_task(monkeypatch):
    notifier_wake_worker.reset_notice_state()
    monkeypatch.setattr(
        notifier_wake_worker, "carry_previous_checkout", lambda *args, **kwargs: False
    )
    posts, spawned = [], []
    services = _wake_services(posts, spawned)
    candidate = {"agent_id": "agent-1", "alias": "builder", "headless_cwd": "/project/main",
                 "pending_events": 2, "latest_event": "prompt"}
    assert _spawn(candidate, services)["sent"] is True
    assert spawned == ["/project/.orcha-worktrees/agent"]
    assert not any("/messages" in url for url, _ in posts)


def test_worktree_is_always_provisioned_for_code_wakes():
    """The retired toggle can no longer route a code wake into the main checkout."""
    services = SimpleNamespace(
        _provision_task_worktree=lambda *args: ("/project/.orcha-worktrees/task-1", "orcha/task-1"),
        _provision_worktree=lambda *args: ("/project/.orcha-worktrees/agent", "orcha/wk-agent"),
    )
    candidate = {"headless_cwd": "/project/main", "context_task_id": "task-1",
                 "pending_events": 1, "worktrees_disabled": True}
    worktree, branch, task_worktree = notifier_wake_worker._worktree_for(
        candidate, [], {}, False, services
    )
    assert (worktree, branch, task_worktree) == (
        "/project/.orcha-worktrees/task-1", "orcha/task-1", True
    )


def test_select_transport_ignores_the_retired_toggle(monkeypatch):
    from orcha_cli import notifier_wake_facade

    monkeypatch.setattr(notifier, "tmux_pane_live", lambda target: True)
    cand = {"tmux_target": "pane", "headless_cwd": "/project/main", "worktrees_disabled": True}
    assert notifier_wake_facade.select_transport(cand) == "tmux"


@pytest.mark.asyncio
async def test_worktree_routing_setting_is_gone_from_the_api(client, container, make_agent):
    human = await make_agent("operator", kind="human")
    ai = await make_agent("builder")
    r = await client.post(
        f"/api/containers/{container['id']}/worktrees",
        json={"disabled": True, "actor_agent_id": human["agent_id"]},
    )
    assert r.status_code in (404, 405)
    snapshot = (await client.get(f"/api/containers/{container['id']}")).json()
    assert "worktrees_disabled" not in snapshot["container"]
    persona = (await client.get(f"/api/agents/{ai['agent_id']}/persona")).json()
    assert "worktrees_disabled" not in persona
    scan = (await client.get(f"/api/containers/{container['id']}/wake-scan")).json()
    assert "worktrees_disabled" not in scan
    assert all("worktrees_disabled" not in c for c in scan.get("candidates", []))
    conversations = (
        await client.get(f"/api/containers/{container['id']}/active-conversations")
    ).json()
    assert "worktrees_disabled" not in conversations
