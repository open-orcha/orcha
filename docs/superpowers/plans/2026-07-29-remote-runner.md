# Remote Runner (Sandbox Wake Mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent wakes execute inside disposable, resource-capped Docker containers instead of host processes — no host secrets, durable across daemon restarts, meterable per run.

**Architecture:** A new pure-function module `orcha_cli/sandbox.py` translates the exact argv/env that `notifier.spawn_headless` builds today into a `docker run` invocation (foreground client process, so the existing Popen/poll lease contract is untouched). A new `sandbox` wake mode is opt-in per project via `.claude/orcha.json`. The container name is stamped into `worker_runs.sandbox_container_id` so a restarted daemon re-adopts live runs by Docker label instead of orphaning them. Spec: `docs/superpowers/specs/2026-07-29-orcha-cloud-remote-runner-design.md`.

**Tech Stack:** Python 3.11+ (orcha-cli), Docker CLI (no docker-py dependency), Postgres migration, pytest (existing `tests/` conventions: monkeypatch `notifier.spawn_headless`, fake subprocess via PATH shim).

**Branch:** `feat/remote-runner` (branched from `feat/remote-runner-spec`). **Local only — do not push or open a PR until the Hetzner dogfood week passes** (user decision 2026-07-29).

**Amendment to spec §3.2 (approved during planning):** v1 toggle is the CLI command `orcha sandbox on|off|status`, not a portal control. Portal editability is post-v1.

---

### Task 1: `sandbox.py` — config + pure builders

**Files:**
- Create: `orcha-cli/orcha_cli/sandbox.py`
- Test: `tests/test_sandbox_builders.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_sandbox_builders.py
"""Unit tests for the sandbox spawner's pure functions (spec §3.3b).

No Docker required: these test argv/env/config construction only.
"""
import json
import pathlib

from orcha_cli import sandbox


def _project(tmp_path: pathlib.Path, sandbox_block=None) -> pathlib.Path:
    (tmp_path / ".claude").mkdir()
    cfg = {"api_base_url": "http://127.0.0.1:8000"}
    if sandbox_block is not None:
        cfg["sandbox"] = sandbox_block
    (tmp_path / ".claude" / "orcha.json").write_text(json.dumps(cfg))
    (tmp_path / ".orcha").mkdir()
    (tmp_path / ".orcha" / "docker-compose.yml").write_text(
        "# generated\nname: orcha-myproj\n\nservices:\n  db: {}\n"
    )
    return tmp_path


def test_config_defaults_disabled(tmp_path):
    cfg = sandbox.SandboxConfig.load(_project(tmp_path))
    assert cfg.enabled is False
    assert cfg.image == sandbox.DEFAULT_IMAGE
    assert cfg.max_runtime_secs == 7200


def test_config_reads_overrides(tmp_path):
    proj = _project(tmp_path, {"enabled": True, "memory": "8g", "cpus": 4,
                               "max_runtime_secs": 600})
    cfg = sandbox.SandboxConfig.load(proj)
    assert cfg.enabled is True
    assert cfg.memory == "8g"
    assert cfg.cpus == "4"          # normalized to str
    assert cfg.max_runtime_secs == 600


def test_config_survives_missing_or_garbage_file(tmp_path):
    assert sandbox.SandboxConfig.load(tmp_path).enabled is False   # no .claude at all
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "orcha.json").write_text("{not json")
    assert sandbox.SandboxConfig.load(tmp_path).enabled is False


def test_compose_network_derived_from_stack_name(tmp_path):
    proj = _project(tmp_path)
    assert sandbox.compose_network(proj) == "orcha-myproj_default"


def test_compose_network_none_when_unreadable(tmp_path):
    assert sandbox.compose_network(tmp_path) is None


def test_container_names_are_unique_and_labeled():
    a, b = sandbox.new_container_name(), sandbox.new_container_name()
    assert a != b and a.startswith("orcha-run-")


def test_build_docker_argv_shape(tmp_path):
    proj = _project(tmp_path, {"enabled": True})
    cfg = sandbox.SandboxConfig.load(proj)
    argv = sandbox.build_docker_argv(
        ["claude", "-p", "hi"], cfg=cfg, name="orcha-run-abc",
        workspace=str(proj), network="orcha-myproj_default",
        api_config_mount=str(proj / ".orcha" / "sandbox" / "orcha-run-abc.json"),
    )
    joined = " ".join(argv)
    assert argv[:3] == ["docker", "run", "--name"]
    assert "--rm" not in argv                       # reaper removes after stamping (spec §3.5)
    assert "--label orcha.managed=1" in joined
    assert "--label orcha.container_name=orcha-run-abc" in joined
    assert "--memory 4g" in joined and "--cpus 2" in joined and "--pids-limit 512" in joined
    assert f"-v {proj}:/workspace" in joined and "-w /workspace" in joined
    # secrets ride the client env, never argv:
    assert "-e ORCHA_RUN_TOKEN" in joined and "ORCHA_RUN_TOKEN=" not in joined
    assert "--network orcha-myproj_default" in joined
    # the api-base override file masks the host-addressed orcha.json in the workspace:
    assert f"-v {proj}/.orcha/sandbox/orcha-run-abc.json:/workspace/.claude/orcha.json:ro" in joined
    assert argv[-3:] == [cfg.image, *["claude", "-p", "hi"]][-3:]


def test_sandbox_api_config_rewrites_base_url(tmp_path):
    proj = _project(tmp_path, {"enabled": True})
    path = sandbox.write_api_config(proj, "orcha-run-abc")
    written = json.loads(pathlib.Path(path).read_text())
    assert written["api_base_url"] == "http://portal:8000"      # service name, in-network
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/husseinmohamed/Desktop/quantal-projects/orcha-open && python -m pytest tests/test_sandbox_builders.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'orcha_cli.sandbox'` (or ImportError via conftest path).

- [ ] **Step 3: Write the module**

```python
# orcha-cli/orcha_cli/sandbox.py
"""Sandbox wake execution — spec docs/superpowers/specs/2026-07-29-orcha-cloud-remote-runner-design.md.

Pure functions that translate a headless wake's argv/env into `docker run`.
The notifier keeps its Popen contract untouched: the foreground `docker run`
client lives as long as the container and exits with its exit code.

HARD RULE (spec §3.2): if Docker is unavailable the wake FAILS with a visible
reason. There is no fallback to a host process.
"""
from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import uuid
from dataclasses import dataclass
from typing import Optional

DEFAULT_IMAGE = "orcha/runner:0.5"
DEFAULT_MEMORY = "4g"
DEFAULT_CPUS = "2"
DEFAULT_PIDS = 512
MIN_FREE_DISK_GB = 5
LABEL_MANAGED = "orcha.managed=1"

# Secrets and identity ride the CLIENT env (docker inherits `-e KEY` values from
# the client process), never argv — `ps` must not show tokens (spec §3.5).
ENV_PASSTHROUGH = (
    "ORCHA_ALIAS", "ORCHA_RUN_TOKEN", "ORCHA_AGENT_RUNTIME",
    "ORCHA_HEADLESS_WORKER", "ORCHA_CONVERSATION_WORKER",
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ORCHA_LLM_API_KEY",
)


@dataclass(frozen=True)
class SandboxConfig:
    enabled: bool = False
    image: str = DEFAULT_IMAGE
    memory: str = DEFAULT_MEMORY
    cpus: str = DEFAULT_CPUS
    pids_limit: int = DEFAULT_PIDS
    network: Optional[str] = None            # explicit override; else derived
    max_runtime_secs: int = 7200

    @staticmethod
    def load(project_dir) -> "SandboxConfig":
        cfg_path = pathlib.Path(project_dir) / ".claude" / "orcha.json"
        try:
            raw = json.loads(cfg_path.read_text()).get("sandbox") or {}
        except (OSError, ValueError):
            return SandboxConfig()
        if not isinstance(raw, dict):
            return SandboxConfig()
        return SandboxConfig(
            enabled=bool(raw.get("enabled", False)),
            image=str(raw.get("image", DEFAULT_IMAGE)),
            memory=str(raw.get("memory", DEFAULT_MEMORY)),
            cpus=str(raw.get("cpus", DEFAULT_CPUS)),
            pids_limit=int(raw.get("pids_limit", DEFAULT_PIDS)),
            network=raw.get("network"),
            max_runtime_secs=int(raw.get("max_runtime_secs", 7200)),
        )


def compose_network(project_dir) -> Optional[str]:
    """The stack's default network: `<compose name>_default`, read from the
    `name:` line of .orcha/docker-compose.yml (rendered by `orcha init`)."""
    f = pathlib.Path(project_dir) / ".orcha" / "docker-compose.yml"
    try:
        for line in f.read_text().splitlines():
            if line.startswith("name:"):
                return line.split(":", 1)[1].strip() + "_default"
    except OSError:
        pass
    return None


def new_container_name() -> str:
    return "orcha-run-" + uuid.uuid4().hex[:12]


def write_api_config(project_dir, name: str) -> str:
    """A sandbox-scoped copy of .claude/orcha.json with api_base_url rewritten
    to the in-network portal address. Bind-mounted read-only OVER the workspace
    copy so skills inside the container reach the portal without mutating any
    shared file (the host copy points at the host-published localhost port,
    which is unreachable from inside a container — spec §3.3b)."""
    project_dir = pathlib.Path(project_dir)
    cfg = json.loads((project_dir / ".claude" / "orcha.json").read_text())
    cfg["api_base_url"] = "http://portal:8000"
    out_dir = project_dir / ".orcha" / "sandbox"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{name}.json"
    out.write_text(json.dumps(cfg, indent=2))
    return str(out)


def build_docker_argv(inner_argv, *, cfg: SandboxConfig, name: str,
                      workspace: str, network: Optional[str],
                      api_config_mount: str) -> list:
    argv = [
        "docker", "run",
        "--name", name,
        "--label", LABEL_MANAGED,
        "--label", f"orcha.container_name={name}",
        "--memory", cfg.memory,
        "--cpus", cfg.cpus,
        "--pids-limit", str(cfg.pids_limit),
        "-v", f"{workspace}:/workspace",
        "-v", f"{api_config_mount}:/workspace/.claude/orcha.json:ro",
        "-w", "/workspace",
    ]
    if network:
        argv += ["--network", network]
    for key in ENV_PASSTHROUGH:
        argv += ["-e", key]
    argv.append(cfg.image)
    argv.extend(inner_argv)
    return argv
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_sandbox_builders.py -v`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add orcha-cli/orcha_cli/sandbox.py tests/test_sandbox_builders.py
git commit -m "feat(sandbox): config + pure docker-argv builders for sandbox wakes"
```

---

### Task 2: preflight — fail loudly, never fall back

**Files:**
- Modify: `orcha-cli/orcha_cli/sandbox.py` (append)
- Test: `tests/test_sandbox_preflight.py`

- [ ] **Step 1: Write the failing tests**

The tests fake the `docker` binary with a PATH shim — the same technique as a
fake-subprocess fixture; no Docker daemon needed.

```python
# tests/test_sandbox_preflight.py
"""Preflight: Docker reachable, image present, disk headroom (spec §3.5).
A failed preflight returns a human-readable reason; the caller fails the wake."""
import os
import stat

from orcha_cli import sandbox


def _shim(tmp_path, monkeypatch, script: str):
    d = tmp_path / "bin"
    d.mkdir(exist_ok=True)
    f = d / "docker"
    f.write_text("#!/bin/sh\n" + script)
    f.chmod(f.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{d}:{os.environ['PATH']}")


def test_preflight_ok(tmp_path, monkeypatch):
    _shim(tmp_path, monkeypatch, 'exit 0\n')          # `docker info` and `docker image inspect` succeed
    assert sandbox.preflight(sandbox.SandboxConfig(enabled=True), str(tmp_path)) is None


def test_preflight_docker_down(tmp_path, monkeypatch):
    _shim(tmp_path, monkeypatch, 'echo "Cannot connect" >&2; exit 1\n')
    reason = sandbox.preflight(sandbox.SandboxConfig(enabled=True), str(tmp_path))
    assert reason is not None and "docker" in reason.lower()


def test_preflight_missing_image(tmp_path, monkeypatch):
    _shim(tmp_path, monkeypatch,
          'if [ "$1" = "info" ]; then exit 0; fi\nexit 1\n')   # info ok, image inspect fails
    reason = sandbox.preflight(sandbox.SandboxConfig(enabled=True), str(tmp_path))
    assert reason is not None and "image" in reason.lower()


def test_preflight_disk_watermark(tmp_path, monkeypatch):
    _shim(tmp_path, monkeypatch, 'exit 0\n')
    monkeypatch.setattr(sandbox, "_free_disk_gb", lambda path: 1.0)
    reason = sandbox.preflight(sandbox.SandboxConfig(enabled=True), str(tmp_path))
    assert reason is not None and "disk" in reason.lower()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_sandbox_preflight.py -v`
Expected: FAIL — `AttributeError: module 'orcha_cli.sandbox' has no attribute 'preflight'`.

- [ ] **Step 3: Append the implementation to `sandbox.py`**

```python
def _free_disk_gb(path) -> float:
    usage = shutil.disk_usage(str(path))
    return usage.free / (1024 ** 3)


def _docker(args: list, timeout: int = 10) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", *args], capture_output=True, text=True,
                          timeout=timeout)


def preflight(cfg: SandboxConfig, workspace: str) -> Optional[str]:
    """None = good to spawn; otherwise a human-readable reason. The caller
    MUST fail the wake on a reason — de-sandboxing is never an error path."""
    if shutil.which("docker") is None:
        return "docker CLI not installed on this host"
    try:
        info = _docker(["info", "--format", "{{.ServerVersion}}"])
    except subprocess.TimeoutExpired:
        return "docker daemon not responding (info timed out)"
    if info.returncode != 0:
        return f"docker daemon unreachable: {(info.stderr or '').strip()[:200]}"
    img = _docker(["image", "inspect", cfg.image, "--format", "ok"], timeout=15)
    if img.returncode != 0:
        return (f"runner image {cfg.image} not present — "
                f"run `docker pull {cfg.image}` (or `orcha sandbox build-image`)")
    if _free_disk_gb(workspace) < MIN_FREE_DISK_GB:
        return (f"insufficient disk: less than {MIN_FREE_DISK_GB} GiB free "
                f"on the workspace volume")
    return None
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_sandbox_preflight.py tests/test_sandbox_builders.py -v`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add orcha-cli/orcha_cli/sandbox.py tests/test_sandbox_preflight.py
git commit -m "feat(sandbox): preflight checks — docker/image/disk, fail-loud contract"
```

---

### Task 3: hook `spawn_headless` — wrap the wake in `docker run`

**Files:**
- Modify: `orcha-cli/orcha_cli/notifier.py` (function `spawn_headless`, defined at ~line 1171; the Popen block is at ~line 1330)
- Test: `tests/test_sandbox_spawn_integration.py`

**Context for the implementer:** `spawn_headless(cwd, prompt, flags, dry_run, ...)`
returns `(spawned: bool, command_repr: str, proc: Popen|None)`. Callers poll
`proc` to release the single-flight lease. `dry_run=True` returns before any
process starts — that is the test seam. The env dict is fully built (ORCHA_ALIAS,
ORCHA_RUN_TOKEN, ORCHA_AGENT_RUNTIME, ORCHA_HEADLESS_WORKER) just before the
Popen. **Do not change the return tuple's shape** — several tests monkeypatch
this function with 3-tuples.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_sandbox_spawn_integration.py
"""spawn_headless in sandbox mode: wraps argv in docker run (dry-run seam),
fails loudly when preflight fails, stamps the container name into spawn_info."""
import json

from orcha_cli import notifier, sandbox


def _sandbox_project(tmp_path):
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "orcha.json").write_text(json.dumps({
        "api_base_url": "http://127.0.0.1:8000",
        "sandbox": {"enabled": True},
    }))
    (tmp_path / ".orcha").mkdir()
    (tmp_path / ".orcha" / "docker-compose.yml").write_text("name: orcha-proj\n")
    return tmp_path


def test_dry_run_repr_shows_docker_wrap(tmp_path, monkeypatch):
    proj = _sandbox_project(tmp_path)
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)
    sent, repr_, proc = notifier.spawn_headless(str(proj), "do the task", None, True)
    assert sent is False and proc is None
    assert "docker run" in repr_ and "orcha-run-" in repr_


def test_preflight_failure_fails_wake_without_host_fallback(tmp_path, monkeypatch):
    proj = _sandbox_project(tmp_path)
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: "docker daemon unreachable")
    calls = []
    monkeypatch.setattr(notifier.subprocess, "Popen",
                        lambda *a, **k: calls.append(a) or (_ for _ in ()).throw(AssertionError("must not spawn")))
    sent, repr_, proc = notifier.spawn_headless(str(proj), "do the task", None, False)
    assert sent is False and proc is None
    assert "sandbox unavailable" in repr_ and "docker daemon unreachable" in repr_
    assert calls == []          # NOTHING was spawned — no host fallback


def test_spawn_info_carries_container_name(tmp_path, monkeypatch):
    proj = _sandbox_project(tmp_path)
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)
    info = {}
    sent, repr_, proc = notifier.spawn_headless(str(proj), "task", None, True,
                                                spawn_info=info)
    assert info["sandbox_container_id"].startswith("orcha-run-")


def test_host_mode_untouched(tmp_path):
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "orcha.json").write_text(json.dumps(
        {"api_base_url": "http://127.0.0.1:8000"}))
    sent, repr_, proc = notifier.spawn_headless(str(tmp_path), "task", None, True)
    assert "docker run" not in repr_
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_sandbox_spawn_integration.py -v`
Expected: FAIL — repr has no "docker run"; `spawn_info` is an unexpected kwarg.

- [ ] **Step 3: Modify `spawn_headless`**

3a. Add to the signature (keyword-only, default None): `spawn_info: Optional[dict] = None`.

3b. Import at the top of `notifier.py`: `from orcha_cli import sandbox as _sandbox`.

3c. Immediately after the existing `argv` list and `repr_` string are fully
built (just before the `if dry_run:` return), insert:

```python
    sandbox_cfg = _sandbox.SandboxConfig.load(cwd)
    if sandbox_cfg.enabled:
        reason = _sandbox.preflight(sandbox_cfg, cwd)
        if reason is not None:
            # Spec §3.2 hard rule: fail loudly; NEVER fall back to a host process.
            return False, f"(sandbox unavailable: {reason})", None
        sbx_name = _sandbox.new_container_name()
        if spawn_info is not None:
            spawn_info["sandbox_container_id"] = sbx_name
        api_cfg = _sandbox.write_api_config(cwd, sbx_name)
        argv = _sandbox.build_docker_argv(
            argv, cfg=sandbox_cfg, name=sbx_name, workspace=cwd,
            network=sandbox_cfg.network or _sandbox.compose_network(cwd),
            api_config_mount=api_cfg,
        )
        repr_ = f"(sandbox {sbx_name}: {' '.join(argv[:12])} … {argv[-1]})"
```

Note the placement: this must run BEFORE the dry-run return so the dry-run repr
reflects sandbox mode, and the existing env-building + Popen code below runs
unchanged — `docker run` inherits the same env dict, which is exactly how the
`-e KEY` passthrough picks up values without exposing them in argv.

- [ ] **Step 4: Run the new tests AND the existing notifier-adjacent suites**

Run: `python -m pytest tests/test_sandbox_spawn_integration.py tests/test_worktree_diff.py tests/test_iss307_graded_wake.py tests/test_gh110_worker_continuity.py -v`
Expected: new tests pass; existing suites stay green (they monkeypatch
`spawn_headless` wholesale, and host mode is byte-identical).

- [ ] **Step 5: Commit**

```bash
git add orcha-cli/orcha_cli/notifier.py tests/test_sandbox_spawn_integration.py
git commit -m "feat(sandbox): spawn_headless wraps wakes in docker run when sandbox mode is on"
```

---

### Task 4: record the container on the run row

**Files:**
- Create: `orcha-cli/orcha_cli/templates/migrations/034_sandbox_runs.sql`
- Modify: `orcha-cli/orcha_cli/templates/portal/main.py` (the `POST /api/agents/{aid}/runs` request model + the `INSERT INTO worker_runs` at ~line 6815)
- Modify: `orcha-cli/orcha_cli/notifier.py` (the run-record POST at ~line 2958 and its sibling call sites at ~3878/4527/5094 — each passes the payload dict built beside the spawn)
- Test: `tests/portal/` — extend the existing runs-API test file (locate with `grep -rl "agents/{" tests/ | xargs grep -l runs`)

- [ ] **Step 1: Write the migration**

```sql
-- 034_sandbox_runs.sql
-- Spec §3.3c: sandbox wakes stamp their docker container name so a restarted
-- daemon re-adopts live runs by label instead of orphaning them, and so
-- metering can attribute container runtime to a run row.
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS sandbox_container_id TEXT;
CREATE INDEX IF NOT EXISTS idx_worker_runs_sandbox_live
    ON worker_runs (sandbox_container_id) WHERE status = 'running';
```

- [ ] **Step 2: Write the failing portal test** (in the existing runs-API test file, matching its fixture style — the suite uses `tests/conftest.py`'s portal client):

```python
def test_run_record_accepts_sandbox_container_id(client, seeded_agent):
    r = client.post(f"/api/agents/{seeded_agent}/runs", json={
        "wake_kind": "sandbox", "wake_event": "task_dispatch",
        "sandbox_container_id": "orcha-run-abc123def456",
    })
    assert r.status_code == 200
    assert r.json()["sandbox_container_id"] == "orcha-run-abc123def456"
```

- [ ] **Step 3: Run it to verify it fails**

Run: `python -m pytest tests/portal -k sandbox_container -v`
Expected: FAIL (unknown field is ignored and response lacks the column, or 422).

- [ ] **Step 4: Implement**

- Request model for that endpoint: add `sandbox_container_id: Optional[str] = None`.
- INSERT at ~6815: add the column to the column list, `%s` to VALUES, and
  `body.sandbox_container_id` to the parameter tuple (keep positional order aligned).
- Notifier: each spawn site that records a run passes `spawn_info={}` into
  `spawn_headless` and merges it into the payload it POSTs, e.g. at ~2958:

```python
        _spawn_info: dict = {}
        sent, _cmd, newproc = spawn_headless(run_cwd, ctx.get("prompt", ""), ctx.get("flags"), False,
                                             ..., spawn_info=_spawn_info)   # keep existing kwargs
        payload = {"wake_kind": "sandbox" if _spawn_info.get("sandbox_container_id") else "ephemeral",
                   ...existing keys...,
                   **_spawn_info}
```

  Apply the same shape at the other three sites; each already builds a
  `{"wake_kind": ...}` dict adjacent to the spawn call. `wake_kind` becomes
  `"sandbox"` whenever a container name is present, else the site's existing value.

- [ ] **Step 5: Run tests; verify pass; run the full portal suite**

Run: `python -m pytest tests/portal -v` — expected: all pass (migration 034 applies via the suite's migration runner).

- [ ] **Step 6: Commit**

```bash
git add orcha-cli/orcha_cli/templates/migrations/034_sandbox_runs.sql \
        orcha-cli/orcha_cli/templates/portal/main.py orcha-cli/orcha_cli/notifier.py tests/portal
git commit -m "feat(sandbox): worker_runs.sandbox_container_id — spawn stamps, API records"
```

---

### Task 5: reaper — deadline, orphans, adoption

**Files:**
- Modify: `orcha-cli/orcha_cli/sandbox.py` (append sweep helpers)
- Modify: `orcha-cli/orcha_cli/notifier.py` (the #342 container-wide dead-pid sweep at ~line 3408 gains a sandbox branch)
- Test: `tests/test_sandbox_reaper.py`

- [ ] **Step 1: Write the failing tests** (PATH-shim fake `docker` again; the shim logs its argv to a file the test reads):

```python
# tests/test_sandbox_reaper.py
"""Sweep semantics (spec §3.5): liveness by docker inspect, deadline stop,
orphan stop, exit-code stamping, container rm AFTER stamping, volumes untouched."""
import json
import os
import stat
import time

from orcha_cli import sandbox


def _shim(tmp_path, monkeypatch, inspect_json: dict, log: str):
    d = tmp_path / "bin"; d.mkdir(exist_ok=True)
    f = d / "docker"
    f.write_text(
        "#!/bin/sh\n"
        f"echo \"$@\" >> {log}\n"
        "case \"$1\" in\n"
        f"  inspect) echo '{json.dumps([inspect_json])}';;\n"
        "  ps) echo 'orcha-run-orphan1';;\n"
        "esac\nexit 0\n")
    f.chmod(f.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{d}:{os.environ['PATH']}")


def test_probe_running(tmp_path, monkeypatch):
    _shim(tmp_path, monkeypatch,
          {"State": {"Status": "running", "StartedAt": "2026-07-29T00:00:00Z",
                     "OOMKilled": False, "ExitCode": 0}}, str(tmp_path / "log"))
    st = sandbox.probe("orcha-run-x")
    assert st.running is True and st.exit_code is None


def test_probe_exited_maps_exit_and_oom(tmp_path, monkeypatch):
    _shim(tmp_path, monkeypatch,
          {"State": {"Status": "exited", "OOMKilled": True, "ExitCode": 137,
                     "StartedAt": "2026-07-29T00:00:00Z"}}, str(tmp_path / "log"))
    st = sandbox.probe("orcha-run-x")
    assert st.running is False and st.exit_code == 137 and st.oom_killed is True


def test_stop_past_deadline(tmp_path, monkeypatch):
    log = str(tmp_path / "log")
    _shim(tmp_path, monkeypatch,
          {"State": {"Status": "running", "OOMKilled": False, "ExitCode": 0,
                     "StartedAt": "2020-01-01T00:00:00Z"}}, log)   # ancient
    assert sandbox.past_deadline(sandbox.probe("orcha-run-x"), max_runtime_secs=7200)
    sandbox.stop("orcha-run-x")
    assert "stop orcha-run-x" in open(log).read()


def test_reap_removes_container_never_volumes(tmp_path, monkeypatch):
    log = str(tmp_path / "log")
    _shim(tmp_path, monkeypatch,
          {"State": {"Status": "exited", "OOMKilled": False, "ExitCode": 0,
                     "StartedAt": "2026-07-29T00:00:00Z"}}, log)
    sandbox.remove("orcha-run-x")
    contents = open(log).read()
    assert "rm orcha-run-x" in contents and "-v" not in contents   # volumes NEVER removed


def test_orphan_listing(tmp_path, monkeypatch):
    _shim(tmp_path, monkeypatch, {"State": {}}, str(tmp_path / "log"))
    assert sandbox.managed_containers() == ["orcha-run-orphan1"]
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: append to `sandbox.py`:**

```python
@dataclass(frozen=True)
class SandboxState:
    running: bool
    exit_code: Optional[int]
    oom_killed: bool
    started_at: Optional[str]        # RFC3339 from docker inspect


def probe(name: str) -> Optional[SandboxState]:
    """State of one managed container; None if docker errors or it's gone."""
    out = _docker(["inspect", name], timeout=10)
    if out.returncode != 0:
        return None
    try:
        state = json.loads(out.stdout)[0]["State"]
    except (ValueError, KeyError, IndexError):
        return None
    return SandboxState(
        running=state.get("Status") == "running",
        exit_code=None if state.get("Status") == "running" else state.get("ExitCode"),
        oom_killed=bool(state.get("OOMKilled")),
        started_at=state.get("StartedAt"),
    )


def past_deadline(state: Optional[SandboxState], *, max_runtime_secs: int) -> bool:
    if state is None or not state.running or not state.started_at:
        return False
    import datetime
    started = datetime.datetime.fromisoformat(state.started_at.replace("Z", "+00:00"))
    age = (datetime.datetime.now(datetime.timezone.utc) - started).total_seconds()
    return age > max_runtime_secs


def stop(name: str) -> None:
    _docker(["stop", "--time", "20", name], timeout=40)


def remove(name: str) -> None:
    # NEVER pass -v: workspace volumes are durable state (spec §3.5).
    _docker(["rm", name], timeout=15)


def managed_containers() -> list:
    out = _docker(["ps", "--filter", f"label={LABEL_MANAGED}",
                   "--format", "{{.Names}}"], timeout=10)
    if out.returncode != 0:
        return []
    return [l.strip() for l in out.stdout.splitlines() if l.strip()]
```

- [ ] **Step 4: Wire the notifier sweep.** In the #342 container-wide sweep
(~line 3408), where each open run's pid liveness is checked: when the run row
has `sandbox_container_id`, use this instead of pid logic:

```python
            sbx = run.get("sandbox_container_id")
            if sbx:
                state = _sandbox.probe(sbx)
                if state is None:
                    _finish_run(run, status="killed", reason="sandbox container vanished")
                elif state.running:
                    if _sandbox.past_deadline(state, max_runtime_secs=_sandbox.SandboxConfig.load(run_cwd).max_runtime_secs):
                        _sandbox.stop(sbx)      # next sweep observes exited + stamps
                    continue                     # ALIVE: adopted, not orphaned — even if our Popen died with the old daemon
                else:
                    _finish_run(run, status=("killed" if state.oom_killed else ("exited" if state.exit_code == 0 else "exited")),
                                reason=("out of memory — raise sandbox.memory" if state.oom_killed else None),
                                exit_code=state.exit_code)
                    _sandbox.remove(sbx)
                continue
```

(`_finish_run` = whatever helper the sweep already uses to POST
`/api/runs/{id}/finish` — reuse it, matching its actual name and signature at the
call site.) After the loop, stop any `managed_containers()` entry that has no
open run row (orphan sweep).

- [ ] **Step 5: Run all sandbox tests + the notifier sweep's existing tests; commit**

```bash
python -m pytest tests/test_sandbox_reaper.py tests/ -k "sandbox or 342 or sweep" -v
git add orcha-cli/orcha_cli/sandbox.py orcha-cli/orcha_cli/notifier.py tests/test_sandbox_reaper.py
git commit -m "feat(sandbox): reaper — probe/deadline/orphans/adoption, volumes never removed"
```

---

### Task 6: runner image + CLI commands

**Files:**
- Create: `orcha-cli/orcha_cli/templates/runner/Dockerfile`
- Modify: `orcha-cli/orcha_cli/__main__.py` (new `sandbox` subcommand group beside the existing `update` parser at ~line 2387)
- Test: `tests/test_sandbox_cli.py`

- [ ] **Step 1: The Dockerfile**

```dockerfile
# orcha/runner — the sandbox wake image (spec §3.3a). Version-pinned to the CLI minor.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ripgrep python3 python3-venv jq ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code @openai/codex \
    && curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"
WORKDIR /workspace
```

- [ ] **Step 2: Failing CLI tests**

```python
# tests/test_sandbox_cli.py
import json
from orcha_cli import __main__ as cli


def _project(tmp_path):
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "orcha.json").write_text(json.dumps({"api_base_url": "x"}))
    (tmp_path / ".orcha").mkdir()
    (tmp_path / ".orcha" / "docker-compose.yml").write_text("name: orcha-p\n")
    return tmp_path


def test_sandbox_on_off_status(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(_project(tmp_path))
    cli.main(["sandbox", "on"])
    assert json.loads((tmp_path / ".claude" / "orcha.json").read_text())["sandbox"]["enabled"] is True
    cli.main(["sandbox", "status"])
    assert "enabled" in capsys.readouterr().out
    cli.main(["sandbox", "off"])
    assert json.loads((tmp_path / ".claude" / "orcha.json").read_text())["sandbox"]["enabled"] is False
```

(If `cli.main` has a different entry signature, match how existing CLI tests in
`tests/` invoke commands — grep `test_.*cli` first and mirror it.)

- [ ] **Step 3: Implement** — subparser `sandbox` with `on|off|status|build-image`:
`on`/`off` read-modify-write the `sandbox` block in `.claude/orcha.json`
(preserving unknown keys); `status` prints the loaded `SandboxConfig`;
`build-image` runs `docker build -t orcha/runner:0.5 <templates>/runner` and
streams output.

- [ ] **Step 4: Run tests, verify pass. Step 5: Commit**

```bash
git add orcha-cli/orcha_cli/templates/runner/Dockerfile orcha-cli/orcha_cli/__main__.py tests/test_sandbox_cli.py
git commit -m "feat(sandbox): runner Dockerfile + orcha sandbox on/off/status/build-image"
```

---

### Task 7: end-to-end lifecycle integration test (requires Docker; CI-skippable)

**Files:**
- Create: `tests/integration/test_sandbox_lifecycle.py`
- Create: `tests/integration/stub-runner/Dockerfile` (a tiny image whose `claude` is a shell script)

- [ ] **Step 1: The stub image**

```dockerfile
# tests/integration/stub-runner/Dockerfile — fake runtime for lifecycle tests
FROM alpine:3.20
RUN printf '#!/bin/sh\necho "{\\"type\\":\\"result\\",\\"result\\":\\"stub done\\"}"\nsleep "${STUB_SLEEP:-0}"\n' \
      > /usr/local/bin/claude && chmod +x /usr/local/bin/claude
WORKDIR /workspace
```

- [ ] **Step 2: The lifecycle test**

```python
# tests/integration/test_sandbox_lifecycle.py
"""Real-docker lifecycle (spec §3.6.2). Skipped when docker is unavailable.
Covers: spawn → exit-code mapping → reap → rm; deadline stop; and the
load-bearing durability case — the spawner's client process dies, the
container keeps running, probe() still adopts it."""
import pathlib
import shutil
import signal
import subprocess
import time

import pytest

from orcha_cli import sandbox

pytestmark = pytest.mark.skipif(
    shutil.which("docker") is None
    or subprocess.run(["docker", "info"], capture_output=True).returncode != 0,
    reason="docker unavailable")

STUB = "orcha-test/stub-runner"


@pytest.fixture(scope="module", autouse=True)
def stub_image():
    ctx = pathlib.Path(__file__).parent / "stub-runner"
    subprocess.run(["docker", "build", "-q", "-t", STUB, str(ctx)], check=True)


def _cfg():
    return sandbox.SandboxConfig(enabled=True, image=STUB, memory="256m",
                                 cpus="1", pids_limit=64, max_runtime_secs=3600)


def _spawn(tmp_path, extra_env=None, sleep="0"):
    name = sandbox.new_container_name()
    argv = sandbox.build_docker_argv(
        ["claude", "-p", "x"], cfg=_cfg(), name=name, workspace=str(tmp_path),
        network=None, api_config_mount=str(tmp_path / "noop.json"))
    (tmp_path / "noop.json").write_text("{}")
    (tmp_path / ".claude").mkdir(exist_ok=True)
    (tmp_path / ".claude" / "orcha.json").write_text("{}")
    env = {"PATH": "/usr/bin:/bin", "STUB_SLEEP": sleep}
    argv.insert(2, "-e"); argv.insert(3, "STUB_SLEEP")
    proc = subprocess.Popen(argv, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT)
    return name, proc


def test_full_lifecycle(tmp_path):
    name, proc = _spawn(tmp_path)
    assert proc.wait(timeout=60) == 0
    state = sandbox.probe(name)
    assert state is not None and state.running is False and state.exit_code == 0
    sandbox.remove(name)
    assert sandbox.probe(name) is None


def test_client_death_does_not_kill_container(tmp_path):
    name, proc = _spawn(tmp_path, sleep="20")
    time.sleep(2)
    proc.send_signal(signal.SIGKILL)          # the daemon "restarts"
    proc.wait()
    state = sandbox.probe(name)
    assert state is not None and state.running is True     # ADOPTABLE
    sandbox.stop(name); sandbox.remove(name)
```

- [ ] **Step 3: Run** `python -m pytest tests/integration/test_sandbox_lifecycle.py -v`
Expected: 2 passed locally (or skipped on docker-less CI).

- [ ] **Step 4: Commit**

```bash
git add tests/integration
git commit -m "test(sandbox): real-docker lifecycle + client-death adoption integration tests"
```

---

### Task 8: docs + changelog

**Files:**
- Create: `docs/sandbox-mode.md` — what it is (spec §1 table + §3.2 summary), `orcha sandbox on`, config keys with defaults (`image`, `memory 4g`, `cpus 2`, `pids_limit 512`, `max_runtime_secs 7200`, `network`), the fail-loud rule, failure-mode table from spec §3.5, and the note that host mode remains the default.
- Modify: `orcha-cli/CHANGELOG.md` — an Unreleased entry: "sandbox wake mode: agent wakes run in isolated, resource-capped Docker containers (opt-in, `orcha sandbox on`)."

- [ ] **Step 1: Write both. Step 2: Full test suite** — `python -m pytest tests -x -q` green. **Step 3: Commit**

```bash
git add docs/sandbox-mode.md orcha-cli/CHANGELOG.md
git commit -m "docs(sandbox): sandbox-mode guide + changelog"
```

---

### Task 9: dogfood gate (manual, closes the plan)

- [ ] Provision one Hetzner box (CX32 class), install Docker + orcha-cli from this branch, `orcha init` a scratch project, `orcha sandbox on`, `orcha sandbox build-image`.
- [ ] Run a real agent task end-to-end; verify: `ps` shows no `claude` process on the host during the wake; `docker ps` shows one labeled container; portal run detail streams the log; iOS app supervises over Tailscale.
- [ ] `kill` the notifier mid-run; restart; verify the run completes and its status/log are correct (spec §5 criteria).
- [ ] One week of team dogfood with zero de-sandboxing incidents → then (and only then) push the branch and open the OSS PR.

---

## Self-review (done at write time)

- **Spec coverage:** §3.2 mode+hard rule → Tasks 3, 6 (CLI amendment noted in header); §3.3a image → Task 6; §3.3b spawner/env/caps/labels/network/api-base → Tasks 1–3; §3.3c durability/adoption + column → Tasks 4, 5, 7; §3.3d log flow → unchanged by design, asserted via dogfood gate; §3.3e metering → Task 4 (column + existing timestamps, nothing else to build); §3.5 failure modes → Tasks 2, 5; §3.6 tests → Tasks 1–7; §3.7 rollout → Task 9.
- **Placeholders:** none; the two "match the existing helper/fixture" notes point at concrete grep targets, not unwritten designs.
- **Type consistency:** `SandboxConfig.load`, `preflight(cfg, workspace)`, `probe(name) -> SandboxState`, `spawn_info: dict` used identically across Tasks 1–5/7.

---

## Tracked follow-ups (from Task 3 code review — not v1 blockers)

- **Config fail-open**: a present-but-corrupt `.claude/orcha.json` yields `SandboxConfig()` (disabled) → silent host-mode wake. Distinguish FileNotFoundError (→ disabled, fine) from parse/IO errors on an existing file (→ fail the wake loudly). (`sandbox.py` load)
- **Codex conversation lane in sandbox mode**: `last_message_path` is host-absolute under `base_cwd` (not mounted) and `codex exec resume` needs host `~/.codex` rollouts — reply harvest finds nothing. Guard or document before cloud Codex support. (notifier.py ~5127)
- **Sandbox api-config accretion**: one `.orcha/sandbox/<name>.json` per real wake; Task 5's reaper should unlink the file when it removes the container.
- **Task 5 REQUIREMENT (from Task 4 review): drain-sidecar orphan exemption.** With sandbox mode on, `_spawn_drain_sidecar` produces an `orcha-run-*` container with NO worker_runs row by design ("Kedar-locked" no-lease invariant). The orphan sweep MUST NOT stop it: stamp a distinguishing docker label at spawn (e.g. `orcha.sidecar=1`, set via a spawn_headless flag or sandbox build option) and exempt labeled sidecars from the no-open-run-row rule, OR apply a minimum-age grace ≥ the sidecar hard cap. Also: Task 7's integration test should assert the recorded `sandbox_container_id` on a run row (Task 4 review minor 4).
- **M7 (from Task 5 review): orphan-pass min-age grace.** A just-spawned container whose `POST /runs` failed (or hasn't landed yet) has no open run row and would be stopped by the orphan pass within one tick. Add a minimum-age grace (~60s, read from `docker inspect` StartedAt) before a row-less managed container is treated as an orphan — young containers get a tick or two for their row to appear. (notifier.py orphan pass / sandbox.managed_containers)
- **M8 (from Task 5 review): per-tick dedupe + escalation for repeated `docker stop`.** `sandbox.stop` blocks up to ~20s+ per container; a stuck container that ignores SIGTERM gets re-stopped every sweep, serially blocking the daemon loop. Track stop attempts per container name (daemon-scope dict): dedupe within a tick, back off across ticks, and escalate to `docker kill` after N failed stops. (notifier.py sweep / sandbox.py stop)
- **Exited-orphan `docker ps -a` sweep** (required follow-up from Task 5 re-review): three paths terminate in "exited, row-less, removed by nobody" — the kill-path rm race, vanish-then-exit after a daemon-outage window, and every container the orphan pass stops (stop-only by design). Add a low-frequency cid-scoped `docker ps -a` sweep that `docker rm`s exited row-less managed containers and reaps their api-config files (C1's `orcha.cid` label provides scoping); optionally `docker rm -f` escalation on kill paths.
- **Network egress restriction** (docs/sandbox-mode.md now promises this as tracked): the sandbox container currently has ordinary outbound internet and can reach the stack's `db` service on the compose network. Follow-up: egress allowlist (LLM API + git hosts) and a portal-only network alias or internal network split so wakes can't reach Postgres directly.
- **docker logs recovery for host-reboot-truncated log capture** (pre-dogfood review): the sweep's finish captures output from the row's `log_path` on the workspace; if the host rebooted mid-run (or the workspace file was truncated/lost) the adopted run's finish captures a partial/empty log even though `docker logs <container>` still holds the container's stdout/stderr. Follow-up: on capture-miss, fall back to `docker logs` before the container is removed.
- **Config fail-open loud-fail before OSS PR** (pre-dogfood review; upgrades the "Config fail-open" entry above from tracked to REQUIRED before the open-orcha PR): a present-but-corrupt `.claude/orcha.json` silently de-sandboxes the wake to host mode — unacceptable to ship to OSS users; `SandboxConfig.load` must distinguish missing (→ disabled) from corrupt (→ fail the wake loudly, mirroring the §3.2 hard rule).
