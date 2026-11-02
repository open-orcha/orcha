"""Never treat lsof's displayed filename escapes as an inactive checkout."""
import subprocess
from types import SimpleNamespace

import pytest

from orcha_cli import worktree_cleanup as cleanup, worktree_cleanup_activity as activity
from test_pr396_git_compatibility import git, repository  # noqa: F401


def test_plain_cwd_fields_remain_exact():
    assert activity._process_folders('p12\nfcwd\nn/path with space/child\np13\nfcwd\nn/plain\n') == {
        '/path with space/child', '/plain'}


@pytest.mark.parametrize('name', [r'tab\tname', r'line\nname', r'hex\x09name', 'caret^Iname',
                                  'raw\tname', 'raw\rname', 'raw\nname', 'bad\udcffname'])
def test_ambiguous_process_names_refuse_cleanup(name):
    with pytest.raises(activity.CleanupError, match='retained'):
        activity._process_folders('p12\nfcwd\nn/tmp/' + name + '\n')


@pytest.mark.parametrize('output', ['', 'p12\nfcwd\n', 'nrelative\n', 'unexpected\n'])
def test_missing_or_unsupported_process_output_refuses_cleanup(output):
    with pytest.raises(activity.CleanupError, match='retained'):
        activity._process_folders(output)


def test_activity_checks_every_path_and_merges_both_batches(monkeypatch):
    rows = [{"path": f"/fixture/checkout-{i}", "task_ref": f"task-{i}"}
            for i in range(501)]
    requests = []

    def post(url, body):
        assert url == "http://fixture/api/containers/project/agent-worktrees/cleanup-context"
        requests.append(body)
        return {"complete": True,
                "items": {path: {"task_status": "in_progress"} for path in body["paths"]},
                "busy_worktrees": [body["paths"][-1]]}

    monkeypatch.setattr(activity.subprocess, "run", lambda *a, **k:
                        SimpleNamespace(returncode=0, stdout="p12\nfcwd\nn/process/child\n"))
    result = activity.provider("http://fixture", "project", post, ["/local/busy"])(rows)

    assert [len(body["paths"]) for body in requests] == [500, 1]
    assert [path for body in requests for path in body["paths"]] == [row["path"] for row in rows]
    assert requests[1]["task_refs"] == {rows[-1]["path"]: rows[-1]["task_ref"]}
    assert set(result["contexts"]) == {row["path"] for row in rows}
    assert result["busy"] == {"/local/busy", "/process/child", rows[499]["path"], rows[500]["path"]}


@pytest.mark.parametrize("last_reply", [None, {}, {"complete": False}, {"complete": "true"}])
def test_last_activity_batch_failure_rejects_partial_evidence(monkeypatch, last_reply):
    rows = [{"path": f"/fixture/checkout-{i}"} for i in range(501)]
    requests, process_checks = [], []

    def post(url, body):
        requests.append(body)
        if len(requests) == 2:
            return last_reply
        return {"complete": True, "items": {}, "busy_worktrees": []}

    monkeypatch.setattr(activity.subprocess, "run", lambda *a, **k: process_checks.append(a))
    with pytest.raises(activity.CleanupError, match="folders are retained"):
        activity.provider("http://fixture", "project", post)(rows)
    assert [len(body["paths"]) for body in requests] == [500, 1]
    assert requests[-1]["paths"] == [rows[-1]["path"]]
    assert process_checks == []


@pytest.mark.parametrize('name', ['tab\tname', 'line\nname', r'literal\nname'])
def test_real_process_in_unusual_checkout_prevents_removal(repository, monkeypatch, name):
    wt = repository.parent / name
    git(repository, 'worktree', 'add', '-q', '--detach', str(wt))
    child = subprocess.Popen(['sleep', '30'], cwd=wt)
    run = subprocess.run

    def scoped_lookup(args, *pos, **kwargs):
        if args[0] == 'lsof':
            args = [*args, '-a', '-p', str(child.pid)]
        return run(args, *pos, **kwargs)

    monkeypatch.setattr(activity.subprocess, 'run', scoped_lookup)
    provider = activity.provider('http://fixture', 'fixture',
                                 lambda *args: {'complete': True, 'items': {}, 'busy_worktrees': []})
    try:
        plan = cleanup.preview(repository, provider)
        assert plan['status'] == 'failed' and plan['candidate_count'] == 0
        assert 'retained' in plan['error']
        assert wt.is_dir() and child.poll() is None
    finally:
        child.terminate()
        child.wait(timeout=10)
