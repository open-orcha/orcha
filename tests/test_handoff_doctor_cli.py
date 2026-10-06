"""Public, read-only checkout handoff preflight."""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import subprocess

import pytest

from orcha_cli import __main__ as cli
from orcha_cli import notifier


def _git(cwd: pathlib.Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def _make_repository(tmp_path: pathlib.Path) -> tuple[pathlib.Path, pathlib.Path]:
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", str(remote)], check=True)
    checkout = tmp_path / "destination"
    subprocess.run(["git", "clone", str(remote), str(checkout)], check=True)
    _git(checkout, "config", "user.name", "Handoff Doctor Test")
    _git(checkout, "config", "user.email", "handoff-doctor@example.test")
    (checkout / ".gitignore").write_text("private.bin\n.orcha/logs/\n")
    (checkout / "tracked.txt").write_text("baseline\n")
    _git(checkout, "add", ".gitignore", "tracked.txt")
    _git(checkout, "commit", "-m", "baseline")
    _git(checkout, "branch", "-M", "main")
    _git(checkout, "push", "-u", "origin", "main")
    source = tmp_path / "source"
    _git(checkout, "worktree", "add", "-b", "handoff-source", str(source), "main")
    return source, checkout


def _tree_fingerprint(*roots: pathlib.Path) -> dict[str, tuple]:
    """Capture content and metadata that a read-only command must preserve."""
    fingerprint = {}
    for root in roots:
        for path in [root, *sorted(root.rglob("*"))]:
            relative = f"{root.name}/{path.relative_to(root)}"
            stat = path.lstat()
            if path.is_symlink():
                content = os.readlink(path).encode()
                kind = "symlink"
            elif path.is_file():
                content = path.read_bytes()
                kind = "file"
            else:
                content = b""
                kind = "directory"
            fingerprint[relative] = (
                kind,
                stat.st_mode,
                stat.st_size,
                stat.st_mtime_ns,
                hashlib.sha256(content).hexdigest(),
            )
    return fingerprint


def test_parser_wires_public_handoff_doctor_command():
    args = cli.build_parser().parse_args(
        [
            "handoff-doctor",
            "/saved/source",
            "/selected/destination",
            "--owner-key",
            "task:example",
            "--snapshot-run-id",
            "run-example",
            "--json",
        ]
    )

    assert args.func is cli.cmd_handoff_doctor
    assert args.source == "/saved/source"
    assert args.destination == "/selected/destination"
    assert args.owner_key == "task:example"
    assert args.snapshot_run_id == "run-example"
    assert args.json is True


def test_safe_preflight_is_structured_and_does_not_mutate_any_repository_state(
    tmp_path, capsys
):
    source, destination = _make_repository(tmp_path)
    (source / "tracked.txt").write_text("stream state\n")
    (source / "private.bin").write_bytes(b"\x00ignored stream state\xff")
    assert notifier._record_checkout_stream_snapshot(
        str(source), "task:stream-two", run_id="run-two"
    ).ok
    before = _tree_fingerprint(source, destination)
    args = cli.build_parser().parse_args(
        [
            "handoff-doctor",
            str(source),
            str(destination),
            "--owner-key",
            "task:stream-two",
            "--snapshot-run-id",
            "run-two",
            "--json",
        ]
    )

    with pytest.raises(SystemExit) as exited:
        args.func(args)

    assert exited.value.code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["code"] == "ready_from_stream_snapshot"
    assert payload["phase"] == "preflight"
    assert payload["requested_owner"] == "task:stream-two"
    assert payload["mutated"] is False
    assert payload["patch_sha256"]
    assert payload["details"]["checkout_activity_checked"] is True
    assert payload["details"]["live_api_users_checked"] is False
    assert payload["details"]["live_state_checked"] is False
    assert "Checkout activity reservations were checked" in payload["guidance"]
    assert _tree_fingerprint(source, destination) == before


def test_nonportable_ignored_destination_runtime_files_do_not_block_preflight(
    tmp_path, capsys
):
    source, destination = _make_repository(tmp_path)
    (source / "tracked.txt").write_text("stream state\n")
    assert notifier._record_checkout_stream_snapshot(
        str(source), "task:stream-two", run_id="run-two"
    ).ok
    runtime_log = destination / ".orcha" / "logs" / "notifier.log"
    runtime_log.parent.mkdir(parents=True)
    runtime_log.write_text("container-wide runtime state\n")
    before = _tree_fingerprint(source, destination)
    args = cli.build_parser().parse_args(
        [
            "handoff-doctor",
            str(source),
            str(destination),
            "--owner-key",
            "task:stream-two",
            "--snapshot-run-id",
            "run-two",
            "--json",
        ]
    )

    with pytest.raises(SystemExit) as exited:
        args.func(args)

    assert exited.value.code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["code"] == "ready_from_stream_snapshot"
    assert payload["details"]["changed_path_count"] == 0
    assert _tree_fingerprint(source, destination) == before


def test_substantive_ignored_destination_file_still_blocks_preflight(
    tmp_path, capsys
):
    source, destination = _make_repository(tmp_path)
    (source / "tracked.txt").write_text("stream state\n")
    assert notifier._record_checkout_stream_snapshot(
        str(source), "task:stream-two", run_id="run-two"
    ).ok
    (destination / "private.bin").write_bytes(b"destination-only ignored state")
    before = _tree_fingerprint(source, destination)
    args = cli.build_parser().parse_args(
        [
            "handoff-doctor",
            str(source),
            str(destination),
            "--owner-key",
            "task:stream-two",
            "--snapshot-run-id",
            "run-two",
            "--json",
        ]
    )

    with pytest.raises(SystemExit) as exited:
        args.func(args)

    assert exited.value.code == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is False
    assert payload["code"] == "destination_has_independent_changes"
    assert payload["details"]["changed_path_count"] == 1
    assert _tree_fingerprint(source, destination) == before


@pytest.mark.parametrize(
    ("side", "activity_state", "expected_code"),
    [
        ("source", "active", "source_checkout_activity_active"),
        (
            "destination",
            "active",
            "destination_checkout_activity_active",
        ),
        (
            "source",
            "pending_snapshot",
            "source_checkout_activity_pending_snapshot",
        ),
        (
            "destination",
            "pending_snapshot",
            "destination_checkout_activity_pending_snapshot",
        ),
    ],
)
def test_checkout_activity_reservation_blocks_read_only_preflight(
    tmp_path, capsys, side, activity_state, expected_code
):
    source, destination = _make_repository(tmp_path)
    (source / "tracked.txt").write_text("stream state\n")
    assert notifier._record_checkout_stream_snapshot(
        str(source), "task:stream-two", run_id="run-two"
    ).ok
    reserved_checkout = source if side == "source" else destination
    reservation = notifier._reserve_checkout_activity(
        str(reserved_checkout), "task:active-writer"
    )
    assert reservation.ok
    if activity_state == "pending_snapshot":
        reservation.handle.close()
    before = _tree_fingerprint(source, destination)
    args = cli.build_parser().parse_args(
        [
            "handoff-doctor",
            str(source),
            str(destination),
            "--owner-key",
            "task:stream-two",
            "--snapshot-run-id",
            "run-two",
            "--json",
        ]
    )

    try:
        with pytest.raises(SystemExit) as exited:
            args.func(args)

        assert exited.value.code == 1
        payload = json.loads(capsys.readouterr().out)
        assert payload["ok"] is False
        assert payload["code"] == expected_code
        assert payload["phase"] == "checkout_activity"
        assert payload["observed_owner"] == "task:active-writer"
        assert payload["details"]["checkout_activity"][side]["status"] == activity_state
        assert payload["mutated"] is False
        assert _tree_fingerprint(source, destination) == before
    finally:
        release_identity = (
            {"activity": reservation}
            if activity_state == "active"
            else {"reservation_id": reservation.reservation_id}
        )
        released = notifier._release_checkout_activity(
            str(reserved_checkout), **release_identity
        )
        assert released.ok


def test_foreign_owner_snapshot_preflight_is_read_only(tmp_path, capsys):
    source, destination = _make_repository(tmp_path)
    target = tmp_path / "target"
    _git(destination, "worktree", "add", "-b", "handoff-target", str(target), "main")
    (source / "stream-one.txt").write_text("first stream\n")
    assert notifier._handoff_worktree_changes(
        str(source),
        str(destination),
        owner_key="task:stream-one",
        source_owner_verified=True,
    )
    (destination / "stream-two.txt").write_text("second stream\n")
    assert notifier._record_checkout_stream_snapshot(
        str(destination), "task:stream-two", run_id="run-two"
    ).ok
    before = _tree_fingerprint(destination, target)
    args = cli.build_parser().parse_args(
        [
            "handoff-doctor",
            str(destination),
            str(target),
            "--owner-key",
            "task:stream-two",
            "--snapshot-run-id",
            "run-two",
            "--json",
        ]
    )

    with pytest.raises(SystemExit) as exited:
        args.func(args)

    assert exited.value.code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["code"] == "ready_from_stream_snapshot"
    assert payload["details"]["source_snapshot_run_id"] == "run-two"
    assert payload["mutated"] is False
    assert _tree_fingerprint(destination, target) == before


def test_blocked_preflight_exits_nonzero_and_preserves_both_checkouts(
    tmp_path, capsys
):
    source, destination = _make_repository(tmp_path)
    before = _tree_fingerprint(source, destination)
    args = cli.build_parser().parse_args(
        [
            "handoff-doctor",
            str(destination),
            str(source),
            "--owner-key",
            "task:unknown-stream",
            "--json",
        ]
    )

    with pytest.raises(SystemExit) as exited:
        args.func(args)

    assert exited.value.code == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is False
    assert payload["code"] == "source_provenance_missing"
    assert payload["phase"] == "source_provenance"
    assert payload["mutated"] is False
    assert "ask the project owner" in payload["guidance"]
    assert _tree_fingerprint(source, destination) == before
