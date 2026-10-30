"""Exact recorded process evidence; no tolerance window and no unknown-is-alive."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def process_identity(pid):
    try:
        pid = int(pid)
        if sys.platform.startswith('linux'):
            fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
            if fields[0] == 'Z':
                return None
            return {'pid': pid, 'start': fields[19],
                    'boot': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                    'namespace': os.readlink(f'/proc/{pid}/ns/pid')}
        if sys.platform == 'darwin':
            result = subprocess.run(['/bin/ps', '-o', 'stat=', '-o', 'lstart=', '-p', str(pid)],
                                    capture_output=True, text=True, timeout=1,
                                    env={'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LC_ALL': 'C'})
            line = result.stdout.strip().split(maxsplit=1)
            boot = subprocess.run(['/usr/sbin/sysctl', '-n', 'kern.boottime'],
                                  capture_output=True, text=True, timeout=1)
            if result.returncode or boot.returncode or len(line) != 2 or line[0].startswith('Z'):
                return None
            return {'pid': pid, 'start': line[1], 'boot': boot.stdout.strip(), 'namespace': 'host'}
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        pass
    return None


def same_process(identity):
    # Diagnostic only on macOS (ps resolution is one second). Signaling is
    # restricted to the original, unreaped child owner on ALL platforms.
    return bool(identity and process_identity(identity['pid']) == identity)


def group_live(pgid):
    """Return True/False/None. Unknown evidence must retain the worktree fence."""
    if sys.platform.startswith('linux'):
        return linux_group_live(pgid)
    try:
        result = subprocess.run(['ps', '-axo', 'pgid=,stat='], capture_output=True,
                                text=True, timeout=1, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
        if result.returncode:
            return None
        for line in result.stdout.splitlines():
            group, state = line.split()
            if int(group) == pgid and not state.startswith('Z'):
                return True
        return False
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def linux_group_live(pgid, proc_root=Path('/proc')):
    """The runner image has procfs but need not install the external ps tool."""
    unknown = False
    try:
        for entry in proc_root.iterdir():
            if not entry.name.isdigit():
                continue
            try:
                fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
                if int(fields[2]) == pgid and fields[0] not in {'Z', 'X'}:
                    return True
            except FileNotFoundError:
                continue  # The process exited during enumeration.
            except (OSError, ValueError, IndexError):
                unknown = True
        return None if unknown else False
    except OSError:
        return None


def child_exited(pid):
    """Observe exit WITHOUT reaping: pin the leader's PID until group cleanup.

    CPython omits waitid on macOS although libc provides it. The Darwin struct
    below follows sys/signal.h; other supported platforms use Python's wrapper.
    """
    if hasattr(os, 'waitid'):
        return os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
    if sys.platform == 'darwin':
        import ctypes

        class SigInfo(ctypes.Structure):
            _fields_ = [(name, ctypes.c_int) for name in
                        ('signo', 'error', 'code', 'pid', 'uid', 'status')] + [
                            ('address', ctypes.c_void_p), ('value', ctypes.c_void_p),
                            ('band', ctypes.c_long), ('reserved', ctypes.c_ulong * 7)]

        libc = ctypes.CDLL(None, use_errno=True)
        info = SigInfo()
        wait = libc.waitid
        wait.argtypes = [ctypes.c_int, ctypes.c_uint, ctypes.POINTER(SigInfo), ctypes.c_int]
        wait.restype = ctypes.c_int
        if wait(os.P_PID, pid, ctypes.byref(info), os.WEXITED | os.WNOHANG | os.WNOWAIT):
            raise OSError(ctypes.get_errno(), 'Cannot observe managed child')
        return info.pid == pid
    raise OSError('Managed commands require non-reaping child observation')
