"""#294 Item 1 fast-follow — secret_box master-key provenance on `compose up`.

BLOCKER 1 (deploy-breaking): PUT /settings/llm-key 503s unless ORCHA_SECRET_KEY is in the
portal env, but a stock `orcha up`/`upgrade` never set it. The CLI now auto-generates +
persists a master key to .orcha/.env and exports it so `${ORCHA_SECRET_KEY:-}` interpolates.

These exercise _ensure_secret_key's three provenance branches + the .env helpers, with the
real `docker compose` call stubbed (we only assert env + file side-effects, no Docker).
"""
import pathlib

from orcha_cli import __main__ as cli  # noqa: E402 (conftest puts orcha-cli on sys.path)

ENV = cli._MASTER_KEY_ENV  # "ORCHA_SECRET_KEY"


def _orcha_dir(tmp_path: pathlib.Path) -> pathlib.Path:
    d = tmp_path / ".orcha"
    d.mkdir()
    return d


def test_generates_and_persists_when_absent(monkeypatch, tmp_path):
    monkeypatch.delenv(ENV, raising=False)
    d = _orcha_dir(tmp_path)
    cli._ensure_secret_key(d)
    key = cli.os.environ.get(ENV)
    assert key, "a master key must be exported into the process env"
    env_file = d / ".env"
    assert env_file.exists(), "the generated key must be persisted to .orcha/.env"
    assert cli._read_env_file_value(env_file, ENV) == key, "persisted value must match exported"


def test_persisted_key_is_reused_not_regenerated(monkeypatch, tmp_path):
    monkeypatch.delenv(ENV, raising=False)
    d = _orcha_dir(tmp_path)
    cli._ensure_secret_key(d)
    first = cli.os.environ.get(ENV)
    # Simulate a fresh CLI invocation: clear the process env but keep .orcha/.env on disk.
    monkeypatch.delenv(ENV, raising=False)
    cli._ensure_secret_key(d)
    assert cli.os.environ.get(ENV) == first, "an existing .env key must be loaded, not replaced"
    # A regenerated key would break decryption of already-stored blobs — so .env must hold ONE.
    lines = [l for l in (d / ".env").read_text().splitlines() if l.startswith(ENV + "=")]
    assert len(lines) == 1, "must not append a second key on reuse"


def test_operator_supplied_key_is_respected_and_not_persisted(monkeypatch, tmp_path):
    monkeypatch.setenv(ENV, "operator-master-key")
    d = _orcha_dir(tmp_path)
    cli._ensure_secret_key(d)
    assert cli.os.environ.get(ENV) == "operator-master-key", "operator env must win untouched"
    assert not (d / ".env").exists(), "we must never write the operator's secret to our .env"


def test_compose_up_exports_key_before_docker(monkeypatch, tmp_path):
    """End-to-end of the chokepoint: _compose('up') ensures the key BEFORE invoking docker, so
    the inherited subprocess interpolates ${ORCHA_SECRET_KEY:-} from a populated env."""
    monkeypatch.delenv(ENV, raising=False)
    seen = {}

    def fake_run(cmd, **kw):
        seen["key_at_call"] = cli.os.environ.get(ENV)
        return None

    monkeypatch.setattr(cli.subprocess, "run", fake_run)
    d = _orcha_dir(tmp_path)
    cli._compose(d, "up", "-d", "--build")
    assert seen["key_at_call"], "ORCHA_SECRET_KEY must be set in the env before `docker compose up`"


def test_compose_nonup_does_not_touch_secret_key(monkeypatch, tmp_path):
    monkeypatch.delenv(ENV, raising=False)
    monkeypatch.setattr(cli.subprocess, "run", lambda *a, **k: None)
    d = _orcha_dir(tmp_path)
    cli._compose(d, "down")
    assert cli.os.environ.get(ENV) is None, "only `up` mints/exports a key"
    assert not (d / ".env").exists()


def test_compose_template_passes_secret_key_to_portal():
    """Gate P1 regression tooth: the portal service MUST receive ORCHA_SECRET_KEY via compose
    interpolation, else PUT/read of stored LLM keys 503s on a real deploy (the deploy-critical
    half of the stock-up fix). Goes RED if the env line is dropped from docker-compose.yml.j2."""
    template = (cli.PKG_TEMPLATES / "docker-compose.yml.j2").read_text()
    expected = f"{ENV}: ${{{ENV}:-}}"  # ORCHA_SECRET_KEY: ${ORCHA_SECRET_KEY:-}
    assert expected in template, (
        f"docker-compose.yml.j2 must interpolate {expected!r} into the portal env so secret_box "
        "can unseal stored keys on a stock deploy")


def test_preexisting_env_is_tightened_to_0600(monkeypatch, tmp_path):
    """Gate P2 security tooth: a pre-existing world-readable .orcha/.env must be clamped to 0600
    once a generated master key is appended into it — a stock deploy must not leave the secret at
    0644. Goes RED if _append_env_file only chmods newly-created files."""
    monkeypatch.delenv(ENV, raising=False)
    d = _orcha_dir(tmp_path)
    env_file = d / ".env"
    env_file.write_text("EXISTING=1\n")
    env_file.chmod(0o644)
    assert (env_file.stat().st_mode & 0o777) == 0o644, "precondition: starts world-readable"
    cli._ensure_secret_key(d)
    mode = env_file.stat().st_mode & 0o777
    assert mode == 0o600, f"pre-existing .env must end at 0600, got {oct(mode)}"
    # the generated key really landed in the pre-existing file (not a fresh one)
    assert cli._read_env_file_value(env_file, ENV) == cli.os.environ.get(ENV)
    assert "EXISTING=1" in env_file.read_text(), "must append, not clobber pre-existing content"


def test_persisted_env_key_is_tightened_to_0600(monkeypatch, tmp_path):
    """Gate 2nd-pass P2 tooth: the LOAD path must tighten too. A .orcha/.env that ALREADY holds
    ORCHA_SECRET_KEY at a lax 0644 (hand-created, or written before the per-append clamp landed)
    takes the persisted-key branch — which never appends, so _append_env_file's clamp never runs.
    _ensure_secret_key must still clamp it to 0600. Goes RED if the load branch returns without
    tightening (the original cc2fedc behaviour)."""
    monkeypatch.delenv(ENV, raising=False)
    d = _orcha_dir(tmp_path)
    env_file = d / ".env"
    env_file.write_text(f"{ENV}=already-persisted\n")
    env_file.chmod(0o644)
    assert (env_file.stat().st_mode & 0o777) == 0o644, "precondition: starts world-readable"
    cli._ensure_secret_key(d)
    assert cli.os.environ.get(ENV) == "already-persisted", "must load the persisted key as-is"
    mode = env_file.stat().st_mode & 0o777
    assert mode == 0o600, f"persisted .env must be tightened to 0600, got {oct(mode)}"
