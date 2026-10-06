"""Regression coverage for shared-main checkout ownership transitions."""

from __future__ import annotations

import hashlib
import os
import pathlib
from types import SimpleNamespace

import pytest

from orcha_cli import (
    notifier,
    notifier_wake_worker,
    notifier_worktree_cleanup,
)
from orcha_cli.notifier_routing_handoff import (
    carry_previous_checkout,
    checkout_live_guard,
    record_stopped_checkout_snapshot,
)


class _Process:
    pid = 4321
    returncode = None


def _git(cwd: pathlib.Path | str, *args: str) -> str:
    code, output = notifier._run_git(list(args), cwd=str(cwd))
    assert code == 0, f"git {' '.join(args)} failed in {cwd}: {output}"
    return output.strip()


def _repository(tmp_path: pathlib.Path) -> pathlib.Path:
    """Create a main checkout with a local ``origin/main`` reference."""
    main = tmp_path / "main"
    main.mkdir()
    _git(main, "init")
    _git(main, "symbolic-ref", "HEAD", "refs/heads/main")
    _git(main, "config", "user.email", "handoff-tests@example.test")
    _git(main, "config", "user.name", "Handoff Tests")
    (main / ".gitignore").write_text("private.bin\n")
    (main / "tracked.txt").write_text("baseline\n")
    _git(main, "add", ".gitignore", "tracked.txt")
    _git(main, "commit", "-m", "baseline")

    origin = tmp_path / "origin.git"
    _git(tmp_path, "clone", "--bare", str(main), str(origin))
    _git(main, "remote", "add", "origin", str(origin))
    _git(main, "fetch", "origin")
    return main


def _file_view(root: pathlib.Path) -> dict[str, tuple[str, str]]:
    """Hash checkout files while deliberately excluding private Git metadata."""
    result: dict[str, tuple[str, str]] = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if ".git" in relative.parts:
            continue
        key = relative.as_posix()
        if path.is_symlink():
            payload = os.readlink(path).encode("utf-8", "surrogateescape")
            result[key] = ("symlink", hashlib.sha256(payload).hexdigest())
        elif path.is_file():
            result[key] = ("file", hashlib.sha256(path.read_bytes()).hexdigest())
        elif path.is_dir():
            result[key] = ("directory", "")
    return result


def _semantic_checkout_state(root: pathlib.Path) -> dict:
    """State a rejected or live-blocked handoff must preserve exactly."""
    return {
        "files": _file_view(root),
        "status": _git(
            root,
            "status",
            "--porcelain=v1",
            "--ignored",
            "--untracked-files=all",
        ),
        "index": _git(root, "diff", "--cached", "--binary", "--full-index"),
        "head": _git(root, "rev-parse", "HEAD"),
        "branch": _git(root, "symbolic-ref", "--short", "HEAD"),
        "owner_record": notifier._handoff_record_bytes(str(root)),
    }


def _seed_foreign_main_owner(
    main: pathlib.Path, owner_worktree: pathlib.Path
) -> bytes:
    (owner_worktree / "owner-a.txt").write_text("first owner's shared state\n")
    result = notifier._handoff_worktree_changes_result(
        str(owner_worktree),
        str(main),
        owner_key="task:task-a",
        source_owner_verified=True,
    )
    assert result.ok is True, result.to_dict()
    record = notifier._handoff_record_bytes(str(main))
    assert record is not None
    return record


def _spawn_services(
    *,
    main: pathlib.Path,
    destination: pathlib.Path,
    destination_branch: str,
    history: dict,
    running_runs: list[dict] | None,
    posts: list[tuple[str, dict]],
    spawned: list[str],
):
    provisioned: list[tuple] = []

    def get_json(url):
        if "/api/agents/agent-b/runs?" in url:
            return history
        if url.endswith(
            "/api/containers/container-1/running-runs?include_retired=true"
        ):
            return None if running_runs is None else {"runs": running_runs}
        pytest.fail(f"unexpected GET {url}")

    def post_json(url, body):
        posts.append((url, body))
        if url.endswith("/wake-claim"):
            return {"claimed": True}
        if url.endswith("/runs"):
            return {"run_id": "new-run-b"}
        return {}

    def provision_task(*args):
        provisioned.append(args)
        return str(destination), destination_branch

    def spawn_headless(cwd, *_args, **_kwargs):
        spawned.append(str(cwd))
        return True, "worker command", _Process()

    services = SimpleNamespace(
        HARD_CAP_MIN_SECS=1200,
        WAKE_LEASE_TTL_SECS=120,
        pathlib=pathlib,
        _get_json=get_json,
        _post_json=post_json,
        _build_persona=lambda *_args, **_kwargs: "persona",
        _provision_task_worktree=provision_task,
        _provision_worktree=lambda *_args: pytest.fail(
            "a task wake must select its task worktree"
        ),
        _handoff_worktree_changes=notifier._handoff_worktree_changes,
        _handoff_worktree_changes_result=notifier._handoff_worktree_changes_result,
        _handoff_branch_changes=notifier._handoff_branch_changes,
        _handoff_branch_changes_result=notifier._handoff_branch_changes_result,
        _retirement_record_status=notifier._retirement_record_status,
        _container_id_for=lambda _cwd: "container-1",
        _mint_embodiment_token=lambda *_args: "token-b",
        _revoke_or_defer=lambda *_args: None,
        _safe_teardown_worktree=notifier._safe_teardown_worktree,
        spawn_headless=spawn_headless,
    )
    services.provisioned = provisioned
    return services


def _task_candidate(main: pathlib.Path) -> dict:
    return {
        "agent_id": "agent-b",
        "alias": "builder-b",
        "headless_cwd": str(main),
        "context_task_id": "task-b",
        "pending_events": 1,
        "latest_event": "task_message",
        # The saved run used shared main while worktrees were disabled. This new
        # wake observes the re-enabled setting and must select task B's worktree.
        "worktrees_disabled": False,
    }


def test_two_shared_main_owners_resume_after_restart_and_start_normal_worker(
    tmp_path,
):
    main = _repository(tmp_path)
    owner_a_path, _ = notifier._provision_task_worktree(
        str(main), "builder-a", "task-a"
    )
    owner_b_path, owner_b_branch = notifier._provision_task_worktree(
        str(main), "builder-b", "task-b"
    )
    owner_a = pathlib.Path(owner_a_path)
    owner_b = pathlib.Path(owner_b_path)
    owner_a_record = _seed_foreign_main_owner(main, owner_a)

    # Task B's stopped shared-main run contains every relevant file class,
    # including non-UTF-8 ignored data that ordinary Git diffs omit.
    (main / "tracked.txt").write_text("task B tracked state\n")
    (main / "task-b-untracked.txt").write_text("task B untracked state\n")
    (main / "private.bin").write_bytes(b"\x00task-B-ignored\xff")
    snapshot = notifier._record_checkout_stream_snapshot(
        str(main), "task:task-b", run_id="stopped-run-b"
    )
    assert snapshot.ok is True, snapshot.to_dict()
    assert notifier._handoff_record_bytes(str(main)) == owner_a_record

    # A fresh service object and empty worker registry model daemon restart: no
    # in-memory owner state is available, only run history and private Git proof.
    notifier_wake_worker.reset_notice_state()
    posts: list[tuple[str, dict]] = []
    spawned: list[str] = []
    history = {
        "query_complete": True,
        "runs": [
            {
                "run_id": "stopped-run-b",
                "agent_id": "agent-b",
                "task_id": "task-b",
                "wake_kind": "ephemeral",
                "wake_event": "task_message",
                "lane": "work",
                "worktree": None,
                "branch": None,
                "base_cwd": str(main),
            }
        ],
    }
    services = _spawn_services(
        main=main,
        destination=owner_b,
        destination_branch=owner_b_branch,
        history=history,
        running_runs=[],
        posts=posts,
        spawned=spawned,
    )
    live_workers: dict = {}

    result = notifier_wake_worker.spawn(
        "http://orcha.test",
        _task_candidate(main),
        prompt="continue task B",
        event="task_message",
        dry_run=False,
        quiet=True,
        lease_ttl=120,
        live_workers=live_workers,
        services=services,
    )

    assert result["sent"] is True
    assert spawned == [str(owner_b)]
    assert services.provisioned == [(str(main), "builder-b", "task-b")]
    assert (owner_b / "tracked.txt").read_text() == "task B tracked state\n"
    assert (owner_b / "task-b-untracked.txt").read_text() == (
        "task B untracked state\n"
    )
    assert (owner_b / "private.bin").read_bytes() == b"\x00task-B-ignored\xff"
    assert notifier._handoff_record_bytes(str(main)) == owner_a_record
    assert live_workers["agent-b"]["worktree"] == str(owner_b)
    assert any(url.endswith("/runs") for url, _body in posts)
    assert not any("/tasks/task-b/messages" in url for url, _body in posts)
    assert not any(
        url.endswith("/wake-ack")
        and body.get("kind") == "worker_routing_handoff_failed"
        for url, body in posts
    )


def test_real_foreign_owner_without_snapshot_blames_source_not_clean_destination(
    tmp_path,
):
    main = _repository(tmp_path)
    owner_a_path, _ = notifier._provision_task_worktree(
        str(main), "builder-a", "task-a"
    )
    owner_b_path, owner_b_branch = notifier._provision_task_worktree(
        str(main), "builder-b", "task-b"
    )
    owner_a = pathlib.Path(owner_a_path)
    owner_b = pathlib.Path(owner_b_path)
    owner_a_record = _seed_foreign_main_owner(main, owner_a)
    (main / "task-b-unsnapshotted.txt").write_text("ambiguous task B state\n")

    source_before = _semantic_checkout_state(main)
    destination_before = _semantic_checkout_state(owner_b)
    assert destination_before["status"] == ""
    notifier_wake_worker.reset_notice_state()
    posts: list[tuple[str, dict]] = []
    spawned: list[str] = []
    history = {
        "query_complete": True,
        "runs": [
            {
                "run_id": "missing-snapshot-run-b",
                "agent_id": "agent-b",
                "task_id": "task-b",
                "wake_kind": "ephemeral",
                "wake_event": "task_message",
                "lane": "work",
                "worktree": None,
                "base_cwd": str(main),
            }
        ],
    }
    services = _spawn_services(
        main=main,
        destination=owner_b,
        destination_branch=owner_b_branch,
        history=history,
        running_runs=[],
        posts=posts,
        spawned=spawned,
    )

    result = notifier_wake_worker.spawn(
        "http://orcha.test",
        _task_candidate(main),
        prompt="continue task B",
        event="task_message",
        dry_run=False,
        quiet=True,
        lease_ttl=120,
        live_workers={},
        services=services,
    )

    assert result["sent"] is False
    assert result["handoff_code"] == "foreign_source_owner"
    assert spawned == []
    notices = [
        body["body"]
        for url, body in posts
        if url.endswith("/tasks/task-b/messages")
    ]
    assert len(notices) == 1
    assert "foreign ownership proof" in notices[0]
    assert "source checkout" in notices[0]
    assert "commit, stash" not in notices[0].lower()
    assert "destination changes" not in notices[0].lower()
    assert notifier._handoff_record_bytes(str(main)) == owner_a_record
    assert _semantic_checkout_state(main) == source_before
    assert _semantic_checkout_state(owner_b) == destination_before


@pytest.mark.parametrize(
    ("live_case", "expected_code"),
    [
        ("source", "checkout_live_in_use"),
        ("destination", "checkout_live_in_use"),
        ("pathless", "checkout_live_state_unverified"),
        ("unavailable", "checkout_live_state_unverified"),
    ],
)
def test_last_moment_live_guard_preserves_files_index_and_owner_proof(
    tmp_path, monkeypatch, live_case, expected_code
):
    main = _repository(tmp_path)
    source_path, source_branch = notifier._provision_task_worktree(
        str(main), "builder-b", "task-b"
    )
    source = pathlib.Path(source_path)
    (source / "task-b.txt").write_text("stopped task B state\n")
    source_before = _semantic_checkout_state(source)
    destination_before = _semantic_checkout_state(main)

    if live_case == "source":
        running = [{"run_id": "live-source", "worktree": str(source)}]
    elif live_case == "destination":
        running = [{"run_id": "live-destination", "base_cwd": str(main)}]
    elif live_case == "pathless":
        running = [{"run_id": "live-unknown", "worktree": None, "base_cwd": None}]
    else:
        running = None

    history = {
        "query_complete": True,
        "runs": [
            {
                "run_id": "stopped-run-b",
                "agent_id": "agent-b",
                "task_id": "task-b",
                "wake_kind": "ephemeral",
                "lane": "work",
                "worktree": str(source),
                "branch": source_branch,
                "base_cwd": str(main),
            }
        ],
    }

    def get_json(url):
        if "/api/agents/agent-b/runs?" in url:
            return history
        if url.endswith(
            "/api/containers/container-1/running-runs?include_retired=true"
        ):
            return None if running is None else {"runs": running}
        pytest.fail(f"unexpected GET {url}")

    services = SimpleNamespace(
        _get_json=get_json,
        _container_id_for=lambda _cwd: "container-1",
        _handoff_worktree_changes=notifier._handoff_worktree_changes,
        _handoff_worktree_changes_result=notifier._handoff_worktree_changes_result,
        _handoff_branch_changes=notifier._handoff_branch_changes,
        _handoff_branch_changes_result=notifier._handoff_branch_changes_result,
        _retirement_record_status=notifier._retirement_record_status,
    )
    monkeypatch.setattr(
        notifier_worktree_cleanup,
        "_place_handoff_patch",
        lambda *_args, **_kwargs: pytest.fail(
            "live-check failure must happen before destination reconciliation"
        ),
    )

    result = carry_previous_checkout(
        "http://orcha.test",
        "agent-b",
        str(main),
        services,
        task_id="task-b",
        lane="work",
        structured=True,
    )

    assert result.ok is False
    assert result.code == expected_code
    assert result.phase == "live_checkout_guard"
    assert result.mutated is False
    assert _semantic_checkout_state(source) == source_before
    assert _semantic_checkout_state(main) == destination_before


def test_snapshot_skips_large_nonportable_ignored_cache_but_carries_ignored_work(
    tmp_path,
):
    main = _repository(tmp_path)
    (main / ".gitignore").write_text(
        (main / ".gitignore").read_text() + ".claude/.orcha-wakes/\n"
    )
    cache = main / ".claude" / ".orcha-wakes"
    cache.mkdir(parents=True)
    for index in range(notifier_worktree_cleanup.HANDOFF_MAX_PATHS + 1):
        (cache / f"runtime-{index}.log").write_text("runtime only\n")
    (main / "private.bin").write_bytes(b"\x00portable-ignored\xff")

    snapshot = notifier._record_checkout_stream_snapshot(
        str(main), "task:task-b", run_id="run-with-large-cache"
    )

    assert snapshot.ok is True, snapshot.to_dict()
    assert "private.bin" in snapshot.details["captured_diff"]
    assert "runtime-0.log" not in snapshot.details["captured_diff"]

    destination_path, _branch = notifier._provision_task_worktree(
        str(main), "builder-b", "task-b"
    )
    destination = pathlib.Path(destination_path)
    carried = notifier._handoff_worktree_changes_result(
        str(main),
        str(destination),
        owner_key="task:task-b",
        source_owner_verified=True,
        snapshot_run_id="run-with-large-cache",
    )
    assert carried.ok is True, carried.to_dict()
    assert (destination / "private.bin").read_bytes() == b"\x00portable-ignored\xff"
    assert not (destination / ".claude" / ".orcha-wakes").exists()
    assert (cache / "runtime-0.log").read_text() == "runtime only\n"


def test_pathless_control_notice_is_not_treated_as_checkout_writer(tmp_path):
    main = _repository(tmp_path)
    destination_path, _branch = notifier._provision_task_worktree(
        str(main), "builder", "task"
    )
    services = SimpleNamespace(
        _get_json=lambda _url: {
            "runs": [
                {
                    "run_id": "control-only",
                    "wake_event": "checkout_handoff_blocked",
                    "worktree": None,
                    "base_cwd": None,
                }
            ]
        },
        _container_id_for=lambda _cwd: "container-1",
    )

    guard = checkout_live_guard(
        "http://orcha.test", services, container_id="container-1"
    )
    assert guard(str(main), destination_path) is None


def test_shared_main_spawn_binds_activity_to_top_level_worker(monkeypatch):
    activity = object()
    binds = []
    spawned = []
    posts = []
    monkeypatch.setattr(
        notifier_wake_worker,
        "prepare_checkout_start",
        lambda *args, **kwargs: SimpleNamespace(
            handoff=True,
            activity=activity,
        ),
    )

    def post_json(url, body):
        posts.append((url, body))
        if url.endswith("/wake-claim"):
            return {"claimed": True}
        if url.endswith("/runs"):
            return {"run_id": "run-1"}
        return {}

    services = SimpleNamespace(
        HARD_CAP_MIN_SECS=1200,
        WAKE_LEASE_TTL_SECS=120,
        pathlib=pathlib,
        _post_json=post_json,
        _build_persona=lambda *args, **kwargs: "persona",
        _is_git_repo=lambda _cwd: True,
        _reserve_checkout_activity=lambda *args, **kwargs: activity,
        _bind_checkout_activity=lambda value, **kwargs: binds.append(
            (value, kwargs)
        )
        or True,
        _mint_embodiment_token=lambda *args: "token",
        _revoke_or_defer=lambda *args: None,
        spawn_headless=lambda cwd, *args, **kwargs: (
            spawned.append(cwd) or (True, "command", _Process())
        ),
    )
    workers = {}
    result = notifier_wake_worker.spawn(
        "http://orcha.test",
        {
            "agent_id": "agent-b",
            "alias": "builder-b",
            "headless_cwd": "/project/main",
            "context_task_id": "task-b",
            "pending_events": 1,
            "worktrees_disabled": True,
        },
        prompt="continue",
        event="task_message",
        dry_run=False,
        quiet=True,
        lease_ttl=120,
        live_workers=workers,
        services=services,
    )

    assert result["sent"] is True
    assert spawned == ["/project/main"]
    assert binds == [
        (activity, {"pid": 4321, "sandbox_container_id": None}),
        (
            activity,
            {
                "run_id": "run-1",
                "pid": 4321,
                "sandbox_container_id": None,
            },
        ),
    ]
    assert workers["agent-b"]["checkout_activity"] is activity
    assert "checkout_activity" not in workers["agent-b"]["respawn_ctx"]


def test_once_mode_refuses_untracked_shared_main_writer(monkeypatch):
    services = SimpleNamespace(
        HARD_CAP_MIN_SECS=1200,
        WAKE_LEASE_TTL_SECS=120,
        pathlib=pathlib,
        _post_json=lambda url, body: {"claimed": True}
        if url.endswith("/wake-claim")
        else {},
        _build_persona=lambda *args, **kwargs: "persona",
        _is_git_repo=lambda _cwd: True,
        _reserve_checkout_activity=lambda *args, **kwargs: pytest.fail(
            "one-shot mode must fail before reserving"
        ),
        spawn_headless=lambda *args, **kwargs: pytest.fail(
            "one-shot mode must not start an untracked shared writer"
        ),
    )
    result = notifier_wake_worker.spawn(
        "http://orcha.test",
        {
            "agent_id": "agent-b",
            "alias": "builder-b",
            "headless_cwd": "/project/main",
            "pending_events": 1,
            "worktrees_disabled": True,
        },
        prompt="continue",
        event="request_created",
        dry_run=False,
        quiet=True,
        lease_ttl=120,
        live_workers=None,
        services=services,
    )
    assert result["sent"] is False
    assert result["handoff_code"] == "checkout_activity_tracking_unavailable"


def test_stopped_shared_worker_releases_activity_only_after_snapshot(tmp_path):
    main = _repository(tmp_path)
    activity = object()
    releases = []
    row = {
        "run_id": "run-1",
        "agent_id": "agent-b",
        "task_id": "task-b",
        "wake_kind": "ephemeral",
        "lane": "work",
        "worktree": None,
        "base_cwd": str(main),
    }
    services = SimpleNamespace(
        _container_id_for=lambda _cwd: "container-1",
        _is_git_repo=lambda _cwd: True,
        _get_json=lambda _url: {"runs": [row]},
        _checkout_overlap_evidence=lambda _cwd: {
            "status": "none",
            "evidence_count": 0,
        },
        _record_checkout_stream_snapshot=lambda cwd, owner_key, run_id=None: (
            notifier._record_checkout_stream_snapshot(
                cwd, owner_key, run_id=run_id
            )
        ),
        _release_checkout_activity=lambda cwd, **kwargs: releases.append(
            (cwd, kwargs)
        )
        or SimpleNamespace(ok=True),
    )
    result = record_stopped_checkout_snapshot(
        {
            **row,
            "checkout_activity": activity,
            "respawn_ctx": {"task_id": "task-b"},
        },
        "agent-b",
        services,
        api_base="http://orcha.test",
        container_id="container-1",
    )
    assert result.ok is True
    assert releases == [
        (
            str(main),
            {"activity": activity, "run_id": "run-1"},
        )
    ]


def test_prior_capture_limit_reports_the_actual_failure(tmp_path):
    main = _repository(tmp_path)
    evidence = notifier._record_checkout_overlap_evidence(
        str(main),
        "task:task-b",
        run_id="run-1",
        agent_id="agent-b",
        reason="snapshot_failure:snapshot_capture_limit",
    )
    assert evidence.ok is True
    status = notifier._checkout_overlap_evidence(str(main))
    assert status["reasons"] == ["snapshot_failure:snapshot_capture_limit"]

    services = SimpleNamespace(
        _container_id_for=lambda _cwd: "container-1",
        _is_git_repo=lambda _cwd: True,
        _checkout_overlap_evidence=lambda _cwd: status,
        _record_checkout_stream_snapshot=lambda *args, **kwargs: pytest.fail(
            "durable capture-limit proof must short-circuit another capture"
        ),
    )
    result = record_stopped_checkout_snapshot(
        {
            "run_id": "run-1",
            "agent_id": "agent-b",
            "base_cwd": str(main),
            "respawn_ctx": {"task_id": "task-b"},
        },
        "agent-b",
        services,
        api_base="http://orcha.test",
        container_id="container-1",
    )

    assert result.ok is False
    assert result.code == "snapshot_capture_limit"
    assert result.details["ambiguity_evidence_recorded"] is True
    assert "exceeded the safe snapshot limit" in result.guidance
