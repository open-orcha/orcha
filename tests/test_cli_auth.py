"""Auth v1 (#271): CLI side — runtime token, default auth headers, compose render.

The CLI (and host daemons) authenticate with the derived root credential: an
HMAC of the ORCHA_SECRET_KEY the CLI already persists to .orcha/.env. Host
filesystem access is the local root of trust, so no API round-trip or DB row is
needed to bootstrap — `orcha init` can register the first human on an enforce
stack out of the box.
"""
import json
import os
import pathlib
import stat

from orcha_cli import __main__ as cli  # noqa: E402 (conftest puts orcha-cli on sys.path)
from orcha_cli import auth_tokens, notifier


# ---------- runtime token file ----------

def test_ensure_runtime_token_writes_derived_root_0600(monkeypatch, tmp_path):
    monkeypatch.setenv("ORCHA_SECRET_KEY", "master-A")
    orcha_dir = tmp_path / ".orcha"
    orcha_dir.mkdir()
    tok = cli._ensure_runtime_token(orcha_dir)
    p = orcha_dir / "runtime-token"
    assert p.read_text().strip() == tok == auth_tokens.derive_root("master-A")
    assert stat.S_IMODE(p.stat().st_mode) == 0o600
    assert cli._ensure_runtime_token(orcha_dir) == tok  # idempotent


# ---------- header resolution ----------

def test_default_auth_headers_env_wins(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("ORCHA_TOKEN", "orcha_h_envtok")
    assert cli._default_auth_headers() == {"Authorization": "Bearer orcha_h_envtok"}


def test_default_auth_headers_reads_runtime_token_upward(monkeypatch, tmp_path):
    monkeypatch.delenv("ORCHA_TOKEN", raising=False)
    monkeypatch.delenv("ORCHA_SECRET_KEY", raising=False)
    (tmp_path / ".orcha").mkdir()
    (tmp_path / ".orcha" / "runtime-token").write_text("orcha_d_filetok\n")
    sub = tmp_path / "src" / "deep"
    sub.mkdir(parents=True)
    monkeypatch.chdir(sub)  # discovered by walking up, like .claude/orcha.json
    assert cli._default_auth_headers() == {"Authorization": "Bearer orcha_d_filetok"}


def test_default_auth_headers_derives_when_file_missing(monkeypatch, tmp_path):
    """Pre-auth stack upgraded in place: .orcha/.env has the master key but no
    runtime-token file yet — derive on the fly rather than dead-ending."""
    monkeypatch.delenv("ORCHA_TOKEN", raising=False)
    monkeypatch.delenv("ORCHA_SECRET_KEY", raising=False)
    (tmp_path / ".orcha").mkdir()
    (tmp_path / ".orcha" / ".env").write_text("ORCHA_SECRET_KEY=master-B\n")
    monkeypatch.chdir(tmp_path)
    assert cli._default_auth_headers() == {
        "Authorization": f"Bearer {auth_tokens.derive_root('master-B')}"}


def test_default_auth_headers_empty_when_nothing(monkeypatch, tmp_path):
    monkeypatch.delenv("ORCHA_TOKEN", raising=False)
    monkeypatch.delenv("ORCHA_SECRET_KEY", raising=False)
    monkeypatch.chdir(tmp_path)
    assert cli._default_auth_headers() == {}


def test_post_json_sends_default_auth_header(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("ORCHA_TOKEN", "orcha_h_envtok")
    seen = {}

    class _Resp:
        def read(self):
            return b"{}"
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout=None):
        seen["auth"] = req.get_header("Authorization")
        return _Resp()

    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    cli._post_json("http://localhost:1/api/x", {"a": 1})
    assert seen["auth"] == "Bearer orcha_h_envtok"


def test_notifier_helpers_send_auth_header(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("ORCHA_RUNTIME_TOKEN", "orcha_d_daemontok")
    seen = {}

    class _Resp:
        def read(self):
            return b"{}"
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout=None):
        seen["auth"] = req.get_header("Authorization")
        return _Resp()

    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    notifier._get_json("http://localhost:1/api/x")
    assert seen["auth"] == "Bearer orcha_d_daemontok"
    seen.clear()
    notifier._post_json("http://localhost:1/api/x", {"a": 1})
    assert seen["auth"] == "Bearer orcha_d_daemontok"


# ---------- compose render ----------

def test_render_compose_default_is_loopback_enforce():
    out = cli._render_compose("proj", db_port=5433, api_port=8001, bridge_port=8765,
                              auth_mode="enforce", expose=False)
    assert '"127.0.0.1:8001:8000"' in out
    assert '"127.0.0.1:5433:5432"' in out
    assert "ORCHA_AUTH_MODE: enforce" in out


def test_render_compose_expose_binds_all_interfaces():
    out = cli._render_compose("proj", db_port=5433, api_port=8001, bridge_port=8765,
                              auth_mode="enforce", expose=True)
    assert '"8001:8000"' in out
    assert "127.0.0.1:8001" not in out


# ---------- gitignore hygiene ----------

def test_ensure_gitignore_covers_secret_files(tmp_path):
    added = cli._ensure_gitignore_entries(tmp_path)
    content = (tmp_path / ".gitignore").read_text()
    for entry in (".orcha/.env", ".orcha/runtime-token", ".claude/orcha-tabs/"):
        assert entry in content
        assert entry in added
    # idempotent: second run adds nothing and doesn't duplicate
    assert cli._ensure_gitignore_entries(tmp_path) == []
    assert content == (tmp_path / ".gitignore").read_text()
