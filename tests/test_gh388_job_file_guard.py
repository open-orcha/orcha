"""Tracked-file detection for commands that keep running after their worker exits."""

import os
import subprocess

import pytest

from orcha_cli.job_file_guard import FileGuard


def git(root, *args):
    return subprocess.run(['git', '-C', str(root), '-c', 'user.name=Orcha Test',
                           '-c', 'user.email=test@example.invalid', *args],
                          check=True, capture_output=True).stdout


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / 'repo'
    root.mkdir()
    git(root, 'init', '-q')
    (root / 'src.py').write_text('VALUE = 1\n')
    (root / 'logs').mkdir()
    (root / 'logs' / 'run.log').write_text('old\n')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'fixture')
    return root


def guard_for(root):
    guard = FileGuard(root)
    assert guard.rebaseline('2026-11-03T00:00:00+00:00')
    return guard


def test_staging_unchanged_crlf_text_is_not_an_edit(repo):
    """Review case: `text eol=crlf` stores LF in Git while the file keeps CRLF."""
    (repo / '.gitattributes').write_text('*.txt text eol=crlf\n')
    (repo / 'source.txt').write_bytes(b'one\r\ntwo\r\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'crlf')
    (repo / 'source.txt').write_bytes(b'one\r\ntwo\r\nthree\r\n')  # Edited before the baseline.
    guard = guard_for(repo)
    git(repo, 'add', 'source.txt')
    assert (repo / 'source.txt').read_bytes() == b'one\r\ntwo\r\nthree\r\n'
    assert guard.changed() is False
    git(repo, 'commit', '-q', '-m', 'staged')
    assert guard.changed() is False
    (repo / 'source.txt').write_bytes(b'one\r\nchanged\r\n')
    assert guard.changed() is True


def test_staging_through_a_clean_filter_is_not_an_edit(repo):
    git(repo, 'config', 'filter.upper.clean', 'tr a-z A-Z')
    git(repo, 'config', 'filter.upper.smudge', 'cat')
    (repo / '.gitattributes').write_text('*.up filter=upper\n')
    (repo / 'notes.up').write_text('abc\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'filtered')
    (repo / 'notes.up').write_text('abcd\n')
    guard = guard_for(repo)
    git(repo, 'add', 'notes.up')
    assert guard.changed() is False
    (repo / 'notes.up').write_text('abcde\n')
    assert guard.changed() is True


def test_checkpoint_commit_of_new_and_edited_files_is_not_an_edit(repo):
    """Orcha's own exit checkpoint (`git add -A` + commit) runs after the baseline."""
    (repo / 'src.py').write_text('VALUE = 2\n')
    (repo / 'new_module.py').write_text('NEW = True\n')
    (repo / 'gone.py').write_text('')
    guard = guard_for(repo)
    git(repo, 'add', '-A', '--', '.')
    git(repo, 'commit', '-q', '-m', 'orcha: checkpoint task t run r')
    assert guard.changed() is False
    git(repo, 'reset', '-q', 'HEAD~1')  # Moving the index back changes no file either.
    assert guard.changed() is False
    git(repo, 'rm', '-q', '--cached', 'src.py')  # Untracked again, same bytes on disk.
    assert guard.changed() is False


@pytest.mark.parametrize('edit', ['rewrite', 'delete', 'replace_with_dir', 'retarget_symlink'])
def test_changes_to_files_tracked_at_baseline_are_edits(repo, edit):
    os.symlink('src.py', repo / 'link.py')
    git(repo, 'add', 'link.py')
    git(repo, 'commit', '-q', '-m', 'link')
    guard = guard_for(repo)
    if edit == 'rewrite':
        (repo / 'src.py').write_text('VALUE = 3\n')
    elif edit == 'delete':
        (repo / 'src.py').unlink()
    elif edit == 'replace_with_dir':
        (repo / 'src.py').unlink()
        (repo / 'src.py').mkdir()
    else:
        (repo / 'link.py').unlink()
        os.symlink('elsewhere.py', repo / 'link.py')
    assert guard.changed() is True


def test_logs_caches_untracked_and_declared_artifacts_are_not_edits(repo):
    (repo / 'report').mkdir()
    (repo / 'report' / 'summary.json').write_text('{}')
    git(repo, 'add', 'report/summary.json')
    git(repo, 'commit', '-q', '-m', 'tracked report')
    guard = FileGuard(repo, artifacts=('report',))
    assert guard.rebaseline('2026-11-03T00:00:00+00:00')
    (repo / 'logs' / 'run.log').write_text('new\n')
    (repo / 'report' / 'summary.json').write_text('{"passed": 3}')
    (repo / '.pytest_cache').mkdir()
    (repo / '.pytest_cache' / 'state').write_text('x')
    (repo / 'scratch.txt').write_text('untracked')
    assert guard.changed() is False


def test_git_failure_is_uncertainty_not_an_edit(repo, monkeypatch):
    guard = guard_for(repo)
    (repo / 'src.py').write_text('VALUE = 4\n')
    monkeypatch.setattr('orcha_cli.job_file_guard._git', lambda *a, **k: None)
    assert guard.changed() is None  # Unknown: neither an edit nor a clean check.
