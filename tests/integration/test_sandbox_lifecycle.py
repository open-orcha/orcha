# tests/integration/test_sandbox_lifecycle.py
"""Remote-runner Task 7: REAL-Docker lifecycle integration tests for sandbox mode.

Everything here runs against the actual local Docker daemon, using a tiny stub
image (tests/integration/stub-runner) whose `claude` binary prints one result
JSON line and then sleeps ``$STUB_SLEEP`` seconds (default 0). This is the
end-to-end proof for the seams the unit suites fake:

  (a) full lifecycle    — real `docker run` via the REAL build_docker_argv,
                          exit 0, probe() sees the exited state, remove() works;
  (b) client-death      — SIGKILL the foreground docker-run CLIENT; the
      adoption            container must SURVIVE it (running=True) — the
                          load-bearing durability property the reaper's
                          adoption pass depends on;
  (c) deadline          — past_deadline() flips on a real container's real
                          StartedAt (docker's NANOSECOND RFC3339 — the exact
                          format the I3 fix truncates), then stop() lands;
  (d) spawn_headless    — the real notifier path end-to-end: preflight, api
                          config rewrite, docker Popen, spawn_info out-param;
  (e) labels            — the real container carries orcha.managed=1 and the
                          project-scoping orcha.cid label (C1).

Cleanup discipline: every container the module creates is named orcha-run-*
and its name is recorded in _CREATED; per-test finally blocks and the module
teardown force-remove ONLY those. Live orcha stacks on this host
(orcha-quantal-ehr-*, orcha-orcha-live-demo-*) are never touched. The stub
image is left in place (cheap; speeds re-runs).
"""
import json
import os
import pathlib
import shutil
import signal
import subprocess
import time

import pytest

from orcha_cli import notifier, sandbox

STUB_IMAGE = "orcha-test/stub-runner"
STUB_DIR = pathlib.Path(__file__).resolve().parent / "stub-runner"


def _docker_ready() -> bool:
    if shutil.which("docker") is None:
        return False
    try:
        return subprocess.run(
            ["docker", "info", "--format", "{{.ServerVersion}}"],
            capture_output=True, timeout=15).returncode == 0
    except (subprocess.TimeoutExpired, OSError):
        return False


pytestmark = pytest.mark.skipif(
    not _docker_ready(), reason="docker CLI missing or daemon unreachable")

# Names of every container THIS module created — the ONLY ones cleanup may touch.
_CREATED: list[str] = []


def _track(name: str) -> str:
    _CREATED.append(name)
    return name


def _force_rm(name: str) -> None:
    subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=30)


@pytest.fixture(scope="module", autouse=True)
def stub_image():
    build = subprocess.run(
        ["docker", "build", "-q", "-t", STUB_IMAGE, str(STUB_DIR)],
        capture_output=True, text=True, timeout=600)
    assert build.returncode == 0, f"stub image build failed:\n{build.stderr}"
    yield STUB_IMAGE
    # Module teardown: enumerate managed containers, then remove ONLY the
    # orcha-run-* names this module itself created. Anything else carrying the
    # label (another project's real runs) is left alone; the live orcha stacks
    # carry neither the label nor a tracked name.
    managed = subprocess.run(
        ["docker", "ps", "-a", "--filter", "label=orcha.managed=1",
         "--format", "{{.Names}}"], capture_output=True, text=True, timeout=30)
    leftover = set(managed.stdout.split()) if managed.returncode == 0 else set()
    for name in _CREATED:
        if name.startswith("orcha-run-") and name in leftover:
            _force_rm(name)


# --------------------------------------------------------------------- helpers

def _tiny_cfg() -> sandbox.SandboxConfig:
    return sandbox.SandboxConfig(enabled=True, image=STUB_IMAGE,
                                 memory="512m", cpus="1", pids_limit=64)


def _argv_for(tmp_path: pathlib.Path, name: str, *, stub_sleep: bool = False) -> list:
    """A real docker-run argv via the REAL builder (no fakes): tiny caps, the
    stub image, a scratch workspace, and a real api-config file to bind-mount."""
    workspace = tmp_path / "ws"
    workspace.mkdir(exist_ok=True)
    api_cfg = tmp_path / f"{name}.json"
    api_cfg.write_text(json.dumps({"api_base_url": "http://portal:8000"}))
    argv = sandbox.build_docker_argv(
        ["claude", "-p", "x"], cfg=_tiny_cfg(), name=name,
        workspace=str(workspace), network=None, api_config_mount=str(api_cfg),
        extra_labels=("orcha.test=t7",))
    if stub_sleep:
        # build_docker_argv has no extra-env hook by design (env rides the
        # documented ENV_PASSTHROUGH allowlist) — insert the test-only
        # `-e STUB_SLEEP` beside the passthrough flags, before the image token.
        idx = argv.index(STUB_IMAGE)
        argv[idx:idx] = ["-e", "STUB_SLEEP"]
    return argv


def _wait_running(name: str, client: subprocess.Popen, timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        st = sandbox.probe(name)
        if st is not None and st.running:
            return
        assert client.poll() is None, \
            f"docker run client exited (rc={client.returncode}) before the container ran"
        time.sleep(0.5)
    pytest.fail(f"container {name} never reached running state within {timeout}s")


# ------------------------------------------------------------ (a) full lifecycle

def test_full_lifecycle_run_exit_probe_remove(tmp_path):
    """Real `docker run` of the real builder's argv: the foreground client exits 0
    with the stub's result line; probe() reports the exited container (exit_code
    0); remove() deletes it; probe() then reports gone (None)."""
    name = _track(sandbox.new_container_name())
    try:
        proc = subprocess.Popen(_argv_for(tmp_path, name),
                                stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True)
        out, _ = proc.communicate(timeout=120)
        assert proc.returncode == 0, out
        assert "stub done" in out                       # the stub actually ran
        st = sandbox.probe(name)
        assert st is not None
        assert st.running is False
        assert st.exit_code == 0
        assert st.oom_killed is False
        sandbox.remove(name)
        assert sandbox.probe(name) is None              # gone after rm
    finally:
        _force_rm(name)


# ---------------- (b) client-death adoption + (c) deadline semantics + stop ----

def test_client_death_adoption_then_deadline_and_stop(tmp_path):
    """The load-bearing durability case (b): SIGKILL the foreground docker-run
    CLIENT ~2s in — the container must still be running afterwards (it outlives
    its client, so a restarted daemon can adopt it). Then (c): on that same real
    container, past_deadline() flips True for a 1s budget (docker's nanosecond
    StartedAt parsed end-to-end) while a generous budget stays False; stop()
    brings it down and probe() reports not-running; remove() deletes it."""
    name = _track(sandbox.new_container_name())
    env = dict(os.environ)
    env["STUB_SLEEP"] = "20"
    try:
        proc = subprocess.Popen(_argv_for(tmp_path, name, stub_sleep=True),
                                env=env, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL)
        _wait_running(name, proc)
        time.sleep(2)                                    # ~2s of real runtime
        # (b) kill the CLIENT dead (SIGKILL: no docker-cli signal proxying).
        proc.send_signal(signal.SIGKILL)
        proc.wait(timeout=30)
        st = sandbox.probe(name)
        assert st is not None
        assert st.running is True, "container must SURVIVE its docker-run client"
        # (c) real StartedAt (nanosecond RFC3339 fraction — the I3 seam).
        assert st.started_at and "." in st.started_at, st.started_at
        assert sandbox.past_deadline(st, max_runtime_secs=1) is True
        assert sandbox.past_deadline(st, max_runtime_secs=3600) is False
        sandbox.stop(name)
        st_stopped = sandbox.probe(name)
        assert st_stopped is not None
        assert st_stopped.running is False
        sandbox.remove(name)
        assert sandbox.probe(name) is None
    finally:
        _force_rm(name)


# --------------------------------------- (d)/(e) spawn_headless end-to-end -----

def _sandbox_project(tmp_path: pathlib.Path) -> pathlib.Path:
    """A minimal real project dir for spawn_headless: sandbox enabled on the stub
    image with tiny caps. `network: bridge` overrides the compose-derived
    `orcha-t7test_default` (which does not exist — docker run would fail on a
    missing network); the compose file still exists so the derivation seam is
    present and demonstrably overridden."""
    proj = tmp_path / "proj"
    (proj / ".claude").mkdir(parents=True)
    (proj / ".claude" / "orcha.json").write_text(json.dumps({
        "api_base_url": "http://127.0.0.1:9",
        "current_container_id": "t7-cid",
        "sandbox": {"enabled": True, "image": STUB_IMAGE, "memory": "512m",
                    "cpus": "1", "pids_limit": 64, "network": "bridge"},
    }))
    (proj / ".orcha").mkdir()
    (proj / ".orcha" / "docker-compose.yml").write_text("name: orcha-t7test\n")
    return proj


def test_spawn_headless_end_to_end_with_spawn_info(tmp_path):
    """(d) the REAL notifier.spawn_headless against the real daemon: preflight
    passes, the per-run api config is written with api_base_url rewritten to the
    in-network portal, the container name lands in spawn_info, the returned live
    Popen (the docker-run client) exits 0, probe() sees the exited container,
    and remove()/remove_api_config() clean both artifacts. No host `claude` is
    required — in sandbox mode docker IS the executable (Task-3 guard)."""
    proj = _sandbox_project(tmp_path)
    info: dict = {}
    name = None
    try:
        sent, repr_, proc = notifier.spawn_headless(
            str(proj), "hi", None, False, spawn_info=info)
        name = info.get("sandbox_container_id")
        if name:
            _track(name)
        assert sent is True, repr_
        assert proc is not None
        assert name and name.startswith("orcha-run-")
        api_cfg = proj / ".orcha" / "sandbox" / f"{name}.json"
        assert api_cfg.exists()
        assert json.loads(api_cfg.read_text())["api_base_url"] == "http://portal:8000"
        assert proc.wait(timeout=120) == 0
        st = sandbox.probe(name)
        assert st is not None
        assert st.running is False
        assert st.exit_code == 0
        sandbox.remove(name)
        assert sandbox.probe(name) is None
        sandbox.remove_api_config(str(proj), name)
        assert not api_cfg.exists()
    finally:
        if name:
            _force_rm(name)


def test_spawn_stamps_cid_and_managed_labels_on_real_container(tmp_path):
    """(e) label end-to-end: the container a real spawn_headless creates carries
    orcha.managed=1 (the reaper/teardown filter) and orcha.cid=<the project's
    current_container_id> (C1 — the project-scoping label), readable back via
    real `docker inspect`."""
    proj = _sandbox_project(tmp_path)               # current_container_id=t7-cid
    info: dict = {}
    name = None
    try:
        sent, repr_, proc = notifier.spawn_headless(
            str(proj), "hi", None, False, spawn_info=info)
        name = info.get("sandbox_container_id")
        if name:
            _track(name)
        assert sent is True, repr_
        assert proc.wait(timeout=120) == 0
        out = subprocess.run(
            ["docker", "inspect", "-f", "{{json .Config.Labels}}", name],
            capture_output=True, text=True, timeout=30)
        assert out.returncode == 0, out.stderr
        labels = json.loads(out.stdout)
        assert labels.get("orcha.managed") == "1"
        assert labels.get("orcha.cid") == "t7-cid"
        assert labels.get("orcha.container_name") == name
        assert "orcha.sidecar" not in labels        # a normal wake, not a sidecar
    finally:
        if name:
            _force_rm(name)
            sandbox.remove_api_config(str(proj), name)
