"""Pytest wrapper for the deploy/provision-swap.sh shell harness.

The real assertions live in tests/test_provision_swap.sh (PATH-shimmed
swapon/fallocate/mkswap/uname/id — no root, no real swap touched); this
wrapper just runs it so swap provisioning rides the normal python suite.
Requires only /bin/sh.
"""
import pathlib
import subprocess


def test_provision_swap_shell_harness():
    script = pathlib.Path(__file__).resolve().parent / "test_provision_swap.sh"
    result = subprocess.run(
        ["sh", str(script)], capture_output=True, text=True, timeout=60
    )
    assert result.returncode == 0, (
        f"shell harness failed (rc={result.returncode})\n"
        f"--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}"
    )
    assert "OK: provision-swap shell harness passed" in result.stdout
