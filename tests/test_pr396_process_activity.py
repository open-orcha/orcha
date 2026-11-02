"""Never treat lsof's displayed filename escapes as an inactive checkout."""
import subprocess

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
