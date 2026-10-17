"""GH #258 PR 6 / plan X2: the Docker sandbox when the portal is a native host process.

Linux joins the host network (api base unchanged); Docker Desktop (macOS/Windows) reaches the
host through host.docker.internal and needs the portal bound beyond loopback. A Docker-runtime
project, and a connected/BYOC folder with no `runtime` key, keep `portal:8000` on the compose
network exactly as before. Argv golden files: tests/fixtures/sandbox_argv/.
"""
import json
import pathlib

import pytest

from orcha_cli import notifier_orphan_cleanup, sandbox

GOLDEN = pathlib.Path(__file__).parent / "fixtures" / "sandbox_argv"
NAME = "orcha-run-000000000000"


def _project(root, *, runtime=None, bind=None, compose=False):
    (root / ".claude").mkdir(parents=True)
    cfg = {"api_base_url": "http://localhost:8123", "api_port": 8123}
    if runtime:
        cfg["runtime"] = runtime
    if bind:
        cfg["bind"] = bind
    (root / ".claude" / "orcha.json").write_text(json.dumps(cfg))
    if compose:
        (root / ".orcha").mkdir()
        (root / ".orcha" / "docker-compose.yml").write_text("name: orcha-proj\nservices: {}\n")
    return root


def _argv(root, platform):
    cfg = sandbox.SandboxConfig(enabled=True)
    network, add_hosts = sandbox.network_for(root, cfg, platform=platform)
    argv = sandbox.build_docker_argv(
        ["claude", "-p", "<prompt>"], cfg=cfg, name=NAME, workspace=str(root),
        network=network, add_hosts=add_hosts,
        api_config_mount=str(root / ".orcha" / "sandbox" / f"{NAME}.json"),
        extra_labels=("orcha.cid=C1",),
    )
    home = str(sandbox.agent_home_dir(root))
    return [a.replace(home, "<AGENT_HOME>").replace(str(root), "<WS>") for a in argv]


@pytest.mark.parametrize("case,runtime,platform", [
    ("docker_runtime", None, "darwin"),
    ("native_linux", "native", "linux"),
    ("native_macos", "native", "darwin"),
])
def test_argv_matches_golden(tmp_path, case, runtime, platform):
    root = _project(tmp_path / "proj", runtime=runtime, compose=runtime is None)
    golden = json.loads((GOLDEN / f"{case}.json").read_text())
    assert _argv(root, platform) == golden


def test_compose_network_is_none_under_native_even_with_a_leftover_compose_file(tmp_path):
    root = _project(tmp_path / "p", runtime="native", compose=True)
    assert sandbox.compose_network(root) is None
    assert sandbox.network_for(root, sandbox.SandboxConfig(), platform="linux") == ("host", ())


def test_explicit_network_override_still_wins(tmp_path):
    root = _project(tmp_path / "p", runtime="native")
    cfg = sandbox.SandboxConfig(network="mynet")
    assert sandbox.network_for(root, cfg, platform="linux") == ("mynet", ())
    assert sandbox.network_for(root, cfg, platform="darwin") == ("mynet", (sandbox.HOST_GATEWAY,))


def test_connected_folder_without_runtime_key_keeps_portal_8000(tmp_path):
    # BYOC/connected workspace: no compose file, no runtime key, portal is still a container.
    root = _project(tmp_path / "p")
    out = json.loads(pathlib.Path(sandbox.write_api_config(root, NAME, platform="linux")).read_text())
    assert out["api_base_url"] == "http://portal:8000"
    assert sandbox.network_for(root, sandbox.SandboxConfig(network="stack_net"),
                               platform="linux") == ("stack_net", ())


@pytest.mark.parametrize("platform,expected", [
    ("linux", "http://localhost:8123"),
    ("darwin", "http://host.docker.internal:8123"),
    ("win32", "http://host.docker.internal:8123"),
])
def test_api_config_rewrite_under_native(tmp_path, platform, expected):
    root = _project(tmp_path / "p", runtime="native", bind="lan")
    out = json.loads(pathlib.Path(sandbox.write_api_config(root, NAME, platform=platform)).read_text())
    assert out["api_base_url"] == expected
    assert json.loads((root / ".claude" / "orcha.json").read_text())["api_base_url"] == \
        "http://localhost:8123"  # the host copy is never touched


def test_api_config_rewrite_docker_runtime_unchanged(tmp_path):
    root = _project(tmp_path / "p", compose=True)
    out = json.loads(pathlib.Path(sandbox.write_api_config(root, NAME, platform="darwin")).read_text())
    assert out["api_base_url"] == "http://portal:8000"


@pytest.fixture
def docker_ok(monkeypatch):
    monkeypatch.setattr(sandbox.shutil, "which", lambda _b: "/usr/bin/docker")
    calls = []

    def fake_docker(args, timeout=10):
        calls.append(args)
        return sandbox.subprocess.CompletedProcess(args, 0, "ok", "")

    monkeypatch.setattr(sandbox, "_docker", fake_docker)
    monkeypatch.setattr(sandbox, "_free_disk_gb", lambda _p: 100.0)
    return calls


@pytest.mark.parametrize("platform", ["darwin", "win32"])
def test_preflight_refuses_loopback_bind_off_linux(tmp_path, docker_ok, platform):
    root = _project(tmp_path / "p", runtime="native")  # bind defaults to loopback
    reason = sandbox.preflight(sandbox.SandboxConfig(enabled=True), str(root), platform=platform)
    assert reason == sandbox.LOOPBACK_BIND_REASON
    assert '"bind": "lan"' in reason
    assert docker_ok == []  # refused before any docker call


def test_preflight_passes_with_lan_bind_on_macos(tmp_path, docker_ok):
    root = _project(tmp_path / "p", runtime="native", bind="lan")
    assert sandbox.preflight(sandbox.SandboxConfig(enabled=True), str(root),
                             platform="darwin") is None


def test_preflight_loopback_is_fine_on_linux_and_for_docker_runtime(tmp_path, docker_ok):
    native = _project(tmp_path / "n", runtime="native")
    docker = _project(tmp_path / "d", compose=True)
    cfg = sandbox.SandboxConfig(enabled=True)
    assert sandbox.preflight(cfg, str(native), platform="linux") is None
    assert sandbox.preflight(cfg, str(docker), platform="darwin") is None


# ── reaper: `docker info` only when sandboxing can be in play (X2 / R4) ──────────────────

class _Svc:
    def __init__(self, runs):
        self.runs = runs

    def _get_json(self, _url):
        return {"runs": self.runs}


def _reap(monkeypatch, runs, **kw):
    probes = []
    monkeypatch.setattr(sandbox, "daemon_reachable", lambda: probes.append(1) or False)
    monkeypatch.setattr(sandbox, "managed_containers",
                        lambda cid: pytest.fail("orphan pass must be gated on docker_ok"))
    notifier_orphan_cleanup.reap_orphaned_runs("http://x", "C1", services=_Svc(runs), **kw)
    return len(probes)


def test_reaper_skips_docker_info_when_sandbox_is_off_and_nothing_is_sandboxed(monkeypatch):
    assert _reap(monkeypatch, [], sandbox_enabled=False) == 0


@pytest.mark.parametrize("runs,kw", [
    ([], {}),                                             # caller didn't say → probe as before
    ([], {"sandbox_enabled": True}),
    ([], {"sandbox_enabled": False, "live_sandbox": frozenset({"orcha-run-x"})}),
    ([{"sandbox_container_id": "orcha-run-y", "agent_id": "a"}], {"sandbox_enabled": False}),
])
def test_reaper_still_probes_when_sandboxing_is_in_play(monkeypatch, runs, kw):
    assert _reap(monkeypatch, runs, **kw) == 1
