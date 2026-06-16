"""`orcha --version` — the distribution/support surface (Homebrew formula `test do`,
release smoke test, bug reports). Reads the installed dist version; falls back to a
sentinel when running from a source tree where orcha-cli isn't pip-installed
(exactly how this test suite imports it, via conftest sys.path)."""
import re

import pytest

from orcha_cli import __main__ as cli


def test_version_flag_prints_version_and_exits_zero(capsys):
    with pytest.raises(SystemExit) as exc:
        cli.build_parser().parse_args(["--version"])
    assert exc.value.code == 0
    out = capsys.readouterr().out.strip()
    assert re.fullmatch(r"orcha \S+", out), out


def test_cli_version_falls_back_when_dist_not_installed(monkeypatch):
    def _missing(name):
        raise cli.PackageNotFoundError(name)
    monkeypatch.setattr(cli, "_pkg_version", _missing)
    assert cli._cli_version() == "0.0.0+source"
