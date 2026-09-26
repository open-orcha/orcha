"""Multi-installation (multi-org) GitHub App support.

Two surfaces:

1. `GET /api/github/repos` with the ORCHA_GITHUB_TOKENS_FILE per-owner token map —
   merge across installations, dedupe, per-owner failure detail, precedence over and
   fallback to the legacy single-token file. Per the test-teeth convention only the
   network leaf (`github_routes._fetch_installation_repos`) is stubbed.

2. The minter's pure installation-selection helpers (`pick_installation`,
   `installations_summary`) in deploy/github-app-token.py, loaded by path (the
   filename is not importable as a module name).
"""
import importlib.util
import json
import pathlib

import pytest

from portal_backend import github_routes

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent


# ---------- GET /api/github/repos with the token map ----------

def _write_map(tmp_path, mapping):
    path = tmp_path / "github-tokens.json"
    path.write_text(json.dumps(mapping))
    return path


ACME_REPOS = [
    {"full_name": "acme/site", "private": True, "description": "The site",
     "html_url": "https://github.com/acme/site"},
    {"full_name": "acme/docs", "private": False, "description": None,
     "html_url": "https://github.com/acme/docs"},
]
BETA_REPOS = [
    {"full_name": "beta/app", "private": True, "description": "App",
     "html_url": "https://github.com/beta/app"},
    # duplicate of an acme repo (e.g. a fork-transfer edge) — must be deduped
    {"full_name": "acme/site", "private": True, "description": "The site",
     "html_url": "https://github.com/acme/site"},
]


async def test_repos_merges_all_installations(client, monkeypatch, tmp_path):
    monkeypatch.setenv(
        "ORCHA_GITHUB_TOKENS_FILE",
        str(_write_map(tmp_path, {"acme": "tok-acme", "beta": "tok-beta"})),
    )
    monkeypatch.delenv("ORCHA_GITHUB_TOKEN_FILE", raising=False)
    seen = []

    def fake_fetch(token):
        seen.append(token)
        return {"tok-acme": ACME_REPOS, "tok-beta": BETA_REPOS}[token]

    monkeypatch.setattr(github_routes, "_fetch_installation_repos", fake_fetch)
    r = await client.get("/api/github/repos")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True
    assert "detail" not in body
    # merged across both tokens, deduped, sorted by full_name
    assert [repo["full_name"] for repo in body["repos"]] == [
        "acme/docs", "acme/site", "beta/app"]
    assert body["repos"][1] == {"full_name": "acme/site", "private": True,
                                "description": "The site",
                                "html_url": "https://github.com/acme/site"}
    assert sorted(seen) == ["tok-acme", "tok-beta"]   # each token queried exactly once


async def test_repos_partial_failure_keeps_available_with_detail(
        client, monkeypatch, tmp_path):
    monkeypatch.setenv(
        "ORCHA_GITHUB_TOKENS_FILE",
        str(_write_map(tmp_path, {"acme": "tok-acme", "beta": "tok-bad"})),
    )

    def fake_fetch(token):
        if token == "tok-bad":
            raise RuntimeError("GitHub returned 401 for installation/repositories")
        return ACME_REPOS

    monkeypatch.setattr(github_routes, "_fetch_installation_repos", fake_fetch)
    body = (await client.get("/api/github/repos")).json()
    assert body["available"] is True                   # ANY working token → available
    assert [repo["full_name"] for repo in body["repos"]] == ["acme/docs", "acme/site"]
    assert "beta" in body["detail"] and "401" in body["detail"]


async def test_repos_all_tokens_failing_is_unavailable_with_detail(
        client, monkeypatch, tmp_path):
    monkeypatch.setenv(
        "ORCHA_GITHUB_TOKENS_FILE",
        str(_write_map(tmp_path, {"acme": "tok-a", "beta": "tok-b"})),
    )

    def fake_fetch(token):
        raise RuntimeError("could not reach GitHub: timeout")

    monkeypatch.setattr(github_routes, "_fetch_installation_repos", fake_fetch)
    body = (await client.get("/api/github/repos")).json()
    assert body["available"] is False and body["repos"] == []
    assert "acme" in body["detail"] and "beta" in body["detail"]


async def test_repos_map_takes_precedence_over_legacy_file(
        client, monkeypatch, tmp_path):
    """Both envs set and readable → the map wins; the legacy token is never fetched."""
    legacy = tmp_path / "github-token"
    legacy.write_text("tok-legacy\n")
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(legacy))
    monkeypatch.setenv(
        "ORCHA_GITHUB_TOKENS_FILE", str(_write_map(tmp_path, {"acme": "tok-acme"})))
    seen = []

    def fake_fetch(token):
        seen.append(token)
        return ACME_REPOS

    monkeypatch.setattr(github_routes, "_fetch_installation_repos", fake_fetch)
    body = (await client.get("/api/github/repos")).json()
    assert body["available"] is True and len(body["repos"]) == 2
    assert seen == ["tok-acme"]


@pytest.mark.parametrize("breakage", ["absent", "invalid-json", "empty-map",
                                      "blank-values", "not-an-object"])
async def test_repos_falls_back_to_legacy_when_map_unusable(
        client, monkeypatch, tmp_path, breakage):
    """Map env set but the file is missing/broken/empty → legacy single-token path."""
    map_path = tmp_path / "github-tokens.json"
    if breakage == "invalid-json":
        map_path.write_text("{not json")
    elif breakage == "empty-map":
        map_path.write_text("{}")
    elif breakage == "blank-values":
        map_path.write_text('{"acme": "  "}')
    elif breakage == "not-an-object":
        map_path.write_text('["tok-a"]')
    monkeypatch.setenv("ORCHA_GITHUB_TOKENS_FILE", str(map_path))
    legacy = tmp_path / "github-token"
    legacy.write_text("tok-legacy")
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(legacy))
    seen = []

    def fake_fetch(token):
        seen.append(token)
        return ACME_REPOS

    monkeypatch.setattr(github_routes, "_fetch_installation_repos", fake_fetch)
    body = (await client.get("/api/github/repos")).json()
    assert body["available"] is True and len(body["repos"]) == 2
    assert seen == ["tok-legacy"]


async def test_repos_graceful_off_when_neither_env_usable(client, monkeypatch, tmp_path):
    monkeypatch.setenv("ORCHA_GITHUB_TOKENS_FILE", str(tmp_path / "missing.json"))
    monkeypatch.delenv("ORCHA_GITHUB_TOKEN_FILE", raising=False)
    r = await client.get("/api/github/repos")
    assert r.status_code == 200 and r.json() == {"available": False, "repos": []}


# ---------- minter installation selection (deploy/github-app-token.py) ----------

def _load_minter():
    spec = importlib.util.spec_from_file_location(
        "github_app_token", REPO_ROOT / "deploy" / "github-app-token.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


INSTALLS = [
    {"id": 101, "account": {"login": "quantal-health"}},
    {"id": 202, "account": {"login": "Quantal-Labs-AI"}},
]


def test_pick_installation_matches_owner_case_insensitively():
    minter = _load_minter()
    assert minter.pick_installation(INSTALLS, "quantal-labs-ai")["id"] == 202
    assert minter.pick_installation(INSTALLS, "QUANTAL-HEALTH")["id"] == 101


def test_pick_installation_defaults_to_first_without_owner():
    minter = _load_minter()
    assert minter.pick_installation(INSTALLS)["id"] == 101


def test_pick_installation_unknown_owner_lists_available():
    minter = _load_minter()
    with pytest.raises(LookupError) as exc:
        minter.pick_installation(INSTALLS, "someone-else")
    message = str(exc.value)
    assert "someone-else" in message
    assert "quantal-health" in message and "Quantal-Labs-AI" in message


def test_pick_installation_no_installs_is_a_clear_error():
    minter = _load_minter()
    with pytest.raises(LookupError, match="installed on nothing"):
        minter.pick_installation([], None)
    with pytest.raises(LookupError, match="installed on nothing"):
        minter.pick_installation([], "acme")


def test_installations_summary_shape():
    minter = _load_minter()
    assert minter.installations_summary(INSTALLS) == [
        {"id": 101, "owner": "quantal-health"},
        {"id": 202, "owner": "Quantal-Labs-AI"},
    ]
    # a broken/absent account never crashes the summary
    assert minter.installations_summary([{"id": 7}]) == [{"id": 7, "owner": ""}]
