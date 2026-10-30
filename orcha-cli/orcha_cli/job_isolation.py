"""An enforced, deliberately narrow contract for isolated host commands.

macOS Seatbelt permits reads and a fresh private scratch directory, but denies
network/IPC, shared writes, hard links, process creation and signals. Descendants
cannot escape the guard because this contract cannot create descendants. Tests
or builds that need subprocesses must use the ordinary stop-before-transfer mode.
This is not a confidentiality boundary: readable files can appear in private logs.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from .job_store import JobStorageError, _sync_directory

CONTRACT = 'readonly_single_process_v1'
EXECUTABLE = '/usr/bin/sandbox-exec'


def profile(scratch):
    # JSON escaping is also valid for this Scheme string literal. Never inject
    # command arguments into the sandbox program.
    path = json.dumps(str(Path(scratch).resolve()))
    return ('(version 1)(deny default)(allow file-read*)'
            '(allow process-exec)(allow sysctl-read)'
            f'(allow file-write* (subpath {path}))'
            '(deny file-link)')


def require_available():
    if sys.platform != 'darwin' or not Path(EXECUTABLE).is_file():
        raise JobStorageError('Isolated commands require macOS sandbox-exec on this host')
    # Probe the actual kernel boundary before creating a server reservation.
    try:
        result = subprocess.run([EXECUTABLE, '-p', '(version 1)(deny default)'
                                 '(allow file-read*)(allow process-exec)', '/usr/bin/true'],
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=3, close_fds=True)
    except (OSError, subprocess.SubprocessError):
        raise JobStorageError('Command isolation is unavailable on this host') from None
    if result.returncode:
        raise JobStorageError('Command isolation is unavailable on this host')


def prepare(directory):
    """A new directory only; never bless existing output as isolated evidence."""
    scratch = directory / 'scratch'
    scratch.mkdir(mode=0o700, exist_ok=False)
    _sync_directory(directory)
    return scratch


def launch_arguments(directory, argv, env):
    scratch = directory / 'scratch'
    if scratch.is_symlink() or not scratch.is_dir():
        raise JobStorageError('Isolated command scratch directory is unavailable')
    scratch = scratch.resolve()
    if scratch.parent != directory.resolve():
        raise JobStorageError('Isolated command scratch directory changed')
    # Both the guard and launch client check availability. There is no fallback
    # to executing the command without enforcement.
    require_available()
    isolated_env = {**env, 'HOME': str(scratch), 'TMPDIR': str(scratch),
                    'TMP': str(scratch), 'TEMP': str(scratch),
                    'ORCHA_JOB_SCRATCH': str(scratch), 'PYTHONDONTWRITEBYTECODE': '1'}
    return [EXECUTABLE, '-p', profile(scratch), *argv], isolated_env
