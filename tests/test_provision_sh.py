"""Pytest wrapper for the deploy/provision-projects.sh shell harnesses.

The real assertions live in tests/test_provision_projects.sh (stubbed portal,
PATH-shimmed git/orcha, stub token minter) and tests/test_provision_projects_
systemd.sh (issue #77: the systemd-supervision branch of the notifier pass,
PATH-shimmed systemctl); these wrappers just run them so the provisioner
rides the normal python suite. Requires only /bin/sh + python3 — no docker,
no network beyond loopback.
"""
import pathlib
import subprocess


def _run_harness(name: str, marker: str) -> None:
    script = pathlib.Path(__file__).resolve().parent / name
    result = subprocess.run(
        ["sh", str(script)], capture_output=True, text=True, timeout=120
    )
    assert result.returncode == 0, (
        f"shell harness failed (rc={result.returncode})\n"
        f"--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}"
    )
    assert marker in result.stdout


def test_provision_projects_shell_harness():
    _run_harness(
        "test_provision_projects.sh",
        "OK: provision-projects shell harness passed",
    )


def test_provision_projects_systemd_branch_shell_harness():
    _run_harness(
        "test_provision_projects_systemd.sh",
        "OK: provision-projects systemd-branch harness passed",
    )
