"""SSE/ISS: the CLI pre-creates the host wake-log dir before `compose up` so Docker
can't create the bind source as root (which would silently break log capture)."""
import pathlib

from orcha_cli import __main__ as cli  # noqa: E402 (conftest puts orcha-cli on sys.path)


def _stub_compose(monkeypatch):
    """Stub out the actual `docker compose` call — we only test the dir side-effect."""
    monkeypatch.setattr(cli.subprocess, "run", lambda *a, **k: None)


def test_compose_up_creates_wake_dir(monkeypatch, tmp_path):
    _stub_compose(monkeypatch)
    orcha_dir = tmp_path / ".orcha"
    orcha_dir.mkdir()
    wakes = tmp_path / ".claude" / ".orcha-wakes"
    assert not wakes.exists()
    cli._compose(orcha_dir, "up", "-d", "--build")
    assert wakes.is_dir(), "wake-log dir must exist before compose up bind-mounts it"


def test_compose_nonup_does_not_create_wake_dir(monkeypatch, tmp_path):
    _stub_compose(monkeypatch)
    orcha_dir = tmp_path / ".orcha"
    orcha_dir.mkdir()
    cli._compose(orcha_dir, "down")
    assert not (tmp_path / ".claude" / ".orcha-wakes").exists()   # only `up` creates it
