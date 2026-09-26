"""Project-runtime epic — `orcha init` auto-binds the checkout's GitHub origin.

When init runs inside a git repo whose `origin` points at github.com, the new
container is bound to that repo automatically (the same PUT
/api/containers/{cid}/github the portal's Connect-repo modal uses), and the
owner/name is recorded in .claude/orcha.json. `--no-github` opts out; every
failure path is best-effort (init never dies because of the binding).

Host-CLI unit tests only — docker/daemon/bridge/portal side effects are stubbed,
following the test_iss84_bridge_port.py pattern. The origin parser and the
git-remote reader are exercised for real (a real `git init` repo in tmp_path).
"""
import argparse
import json
import pathlib
import subprocess

from orcha_cli import __main__ as cli  # noqa: E402  (conftest puts orcha-cli on sys.path)
from orcha_cli import terminal_bridge as tb
from orcha_cli.cli_project_setup import detect_github_repo, parse_github_origin


# --------------------------------------------------------------------------- helpers

def _init_namespace(**over) -> argparse.Namespace:
    """A full `orcha init` Namespace; container creation ON by default here because
    the binding rides the container-create path."""
    ns = dict(
        name="demo", api_port=None, db_port=None, bridge_port=None,
        force=False, reset_data=False, no_container=False, objective=None,
        as_user="tester", no_github=False,
    )
    ns.update(over)
    return argparse.Namespace(**ns)


def _stub_externals(monkeypatch, *, container_id="cid-1234"):
    """Stub every docker / daemon / bridge / HTTP side effect cmd_init triggers.
    Returns a recorder dict capturing the POST and PUT calls init makes."""
    recorded = {"posts": [], "puts": []}
    monkeypatch.setattr(cli, "_compose", lambda *a, **k: None)
    monkeypatch.setattr(cli, "_copy_tree", lambda *a, **k: None)
    monkeypatch.setattr(cli, "ensure_daemon", lambda *a, **k: None)
    monkeypatch.setattr(cli, "_wait_for_portal", lambda *a, **k: None)
    monkeypatch.setattr(tb, "ensure_bridge", lambda *a, **k: None)
    monkeypatch.setattr(cli, "_find_free_port", lambda start, span=100: start)

    def fake_post(url, body):
        recorded["posts"].append((url, body))
        if url.endswith("/api/containers"):
            return {"container_id": container_id}
        if url.endswith("/agents"):
            return {"agent_id": "aid-1"}
        raise AssertionError(f"unexpected POST {url}")

    def fake_put(url, body):
        recorded["puts"].append((url, body))
        return dict(body)

    monkeypatch.setattr(cli, "_post_json", fake_post)
    monkeypatch.setattr(cli, "_put_json", fake_put)
    return recorded


def _orcha_json(project_root: pathlib.Path) -> dict:
    return json.loads((project_root / ".claude" / "orcha.json").read_text())


def _git(cwd: pathlib.Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True)


# --------------------------------------------------------------------------- origin parsing

def test_parse_github_origin_recognises_all_remote_shapes():
    for url in (
        "https://github.com/acme/site.git",
        "https://github.com/acme/site",
        "https://github.com/acme/site/",
        "git@github.com:acme/site.git",
        "git@github.com:acme/site",
        "ssh://git@github.com/acme/site.git",
        "https://x-access-token:tok123@github.com/acme/site.git",
    ):
        assert parse_github_origin(url) == "acme/site", url


def test_parse_github_origin_preserves_dotted_and_dashed_names():
    assert parse_github_origin("git@github.com:my-org/my.repo-2.git") == "my-org/my.repo-2"


def test_parse_github_origin_rejects_non_github_and_garbage():
    for url in (
        "https://gitlab.com/acme/site.git",
        "git@bitbucket.org:acme/site.git",
        "https://github.company.com/acme/site.git",   # GHE is NOT github.com
        "not a url",
        "",
        None,
    ):
        assert parse_github_origin(url) is None, url


def test_detect_github_repo_reads_real_origin(tmp_path):
    _git(tmp_path, "init", "-q")
    _git(tmp_path, "remote", "add", "origin", "git@github.com:acme/site.git")
    assert detect_github_repo(tmp_path) == "acme/site"


def test_detect_github_repo_none_without_git_or_origin(tmp_path):
    # not a git repo at all
    assert detect_github_repo(tmp_path) is None
    # a repo with no origin remote
    _git(tmp_path, "init", "-q")
    assert detect_github_repo(tmp_path) is None


# --------------------------------------------------------------------------- init wiring

def test_init_binds_detected_origin_to_new_container(tmp_path, monkeypatch, capsys):
    """The happy path: origin detected → recorded in orcha.json AND PUT to the portal
    against the just-created container, with a visible confirmation line."""
    recorded = _stub_externals(monkeypatch, container_id="cid-42")
    monkeypatch.setattr(cli, "_detect_github_repo", lambda root: "acme/site")
    monkeypatch.chdir(tmp_path)

    cli.cmd_init(_init_namespace())

    assert _orcha_json(tmp_path)["github_repo"] == "acme/site"
    assert recorded["puts"] == [
        ("http://localhost:8000/api/containers/cid-42/github", {"repo": "acme/site"})
    ]
    assert "GitHub repo bound from origin remote: acme/site" in capsys.readouterr().out


def test_init_no_github_flag_skips_detection_and_binding(tmp_path, monkeypatch):
    recorded = _stub_externals(monkeypatch)

    def _boom(root):
        raise AssertionError("--no-github must skip detection entirely")

    monkeypatch.setattr(cli, "_detect_github_repo", _boom)
    monkeypatch.chdir(tmp_path)

    cli.cmd_init(_init_namespace(no_github=True))

    assert "github_repo" not in _orcha_json(tmp_path)
    assert recorded["puts"] == []


def test_init_without_github_origin_binds_nothing(tmp_path, monkeypatch):
    recorded = _stub_externals(monkeypatch)
    monkeypatch.setattr(cli, "_detect_github_repo", lambda root: None)
    monkeypatch.chdir(tmp_path)

    cli.cmd_init(_init_namespace())

    assert "github_repo" not in _orcha_json(tmp_path)
    assert recorded["puts"] == []


def test_init_no_container_records_repo_locally_only(tmp_path, monkeypatch, capsys):
    """--no-container: nothing to PUT against, but the detected repo still lands in
    orcha.json (a later registration path can seed it), and init says so."""
    recorded = _stub_externals(monkeypatch)
    monkeypatch.setattr(cli, "_detect_github_repo", lambda root: "acme/site")
    monkeypatch.chdir(tmp_path)

    cli.cmd_init(_init_namespace(no_container=True))

    assert _orcha_json(tmp_path)["github_repo"] == "acme/site"
    assert recorded["puts"] == []
    assert "recorded in .claude/orcha.json only" in capsys.readouterr().out


def test_init_bind_failure_is_nonfatal(tmp_path, monkeypatch, capsys):
    """A portal-side bind failure warns and moves on — the container exists, the repo
    stays recorded locally, and init completes (bindable later from the portal)."""
    _stub_externals(monkeypatch)
    monkeypatch.setattr(cli, "_detect_github_repo", lambda root: "acme/site")

    def failing_put(url, body):
        raise RuntimeError("HTTP 422 repo shape rejected")

    monkeypatch.setattr(cli, "_put_json", failing_put)
    monkeypatch.chdir(tmp_path)

    cli.cmd_init(_init_namespace())          # must not raise

    cfg = _orcha_json(tmp_path)
    assert cfg["github_repo"] == "acme/site"
    assert cfg["current_container_id"] == "cid-1234"   # init carried on to completion
    assert "GitHub auto-bind failed" in capsys.readouterr().out
