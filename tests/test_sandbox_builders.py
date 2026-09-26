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
    (tmp_path / ".claude" / "orcha.json").write_text("null")
    assert sandbox.SandboxConfig.load(tmp_path).enabled is False


def test_config_network_coerced_to_str_or_none(tmp_path):
    proj = _project(tmp_path, {"enabled": True, "network": 123})
    assert sandbox.SandboxConfig.load(proj).network == "123"
    (tmp_path / "p2").mkdir()
    proj2 = _project(tmp_path / "p2", {"enabled": True})
    assert sandbox.SandboxConfig.load(proj2).network is None


def test_config_leading_dash_image_falls_back_to_default(tmp_path):
    # A leading-dash "image" would be parsed as a docker CLI flag — argument
    # injection from a repo-supplied orcha.json. It must be ignored.
    proj = _project(tmp_path, {"enabled": True, "image": "--help"})
    cfg = sandbox.SandboxConfig.load(proj)
    assert cfg.enabled is True
    assert cfg.image == sandbox.DEFAULT_IMAGE


def test_config_bad_numeric_field_defaults_but_keeps_enabled(tmp_path):
    proj = _project(tmp_path, {"enabled": True, "pids_limit": "abc",
                               "max_runtime_secs": None})
    cfg = sandbox.SandboxConfig.load(proj)
    assert cfg.enabled is True                       # NEVER silently de-sandbox
    assert cfg.pids_limit == sandbox.DEFAULT_PIDS
    assert cfg.max_runtime_secs == sandbox.DEFAULT_MAX_RUNTIME_SECS


def test_compose_network_derived_from_stack_name(tmp_path):
    proj = _project(tmp_path)
    assert sandbox.compose_network(proj) == "orcha-myproj_default"


def test_compose_network_none_when_unreadable(tmp_path):
    assert sandbox.compose_network(tmp_path) is None


def test_container_names_are_unique_and_prefixed():
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
    assert argv[:2] == ["docker", "run"]
    assert "--rm" not in argv                       # reaper removes after stamping (spec §3.5)
    assert "--label orcha.managed=1" in joined
    assert "--label orcha.container_name=orcha-run-abc" in joined
    assert "--memory 4g" in joined and "--cpus 2" in joined and "--pids-limit 512" in joined
    # PATH-IDENTICAL mounting: host path == container path, workdir = the root —
    # git-worktree pointer files and .orcha/github-token paths stay valid.
    assert f"-v {proj}:{proj}" in joined and f"-w {proj}" in joined
    assert "/workspace" not in joined               # the old remap is GONE
    # the spawner-stamped root env the gh wrapper / credential helper read:
    assert f"-e ORCHA_WORKSPACE_ROOT={proj}" in joined
    # secrets ride the client env, never argv:
    assert "-e ORCHA_RUN_TOKEN" in joined and "ORCHA_RUN_TOKEN=" not in joined
    assert "--network orcha-myproj_default" in joined
    # the api-base override file masks the host-addressed orcha.json the agent reads:
    assert f"-v {proj}/.orcha/sandbox/orcha-run-abc.json:{proj}/.claude/orcha.json:ro" in joined
    assert argv[-3:] == ["claude", "-p", "hi"]
    assert argv[-4] == cfg.image


def test_build_docker_argv_worktree_workdir(tmp_path):
    # A worktree spawn: the ROOT is mounted path-identically, -w is the WORKTREE,
    # and the api-config override masks BOTH the worktree's and the root's
    # orcha.json (the root is visible in-container and its api_base_url points
    # at an unreachable host port).
    proj = _project(tmp_path, {"enabled": True})
    cfg = sandbox.SandboxConfig.load(proj)
    wt = proj / ".orcha-worktrees" / "resident-C1"
    api_cfg = str(proj / ".orcha" / "sandbox" / "orcha-run-abc.json")
    argv = sandbox.build_docker_argv(
        ["claude", "-p"], cfg=cfg, name="orcha-run-abc",
        workspace=str(proj), workdir=str(wt), network=None,
        api_config_mount=api_cfg,
    )
    joined = " ".join(argv)
    assert f"-v {proj}:{proj}" in joined            # the root mount covers the worktree
    assert f"-w {wt}" in joined                     # ...but the session runs IN the worktree
    assert f"-e ORCHA_WORKSPACE_ROOT={proj}" in joined      # root, not the worktree
    assert f"-v {api_cfg}:{wt}/.claude/orcha.json:ro" in joined
    assert f"-v {api_cfg}:{proj}/.claude/orcha.json:ro" in joined
    assert f"-v {wt}:{wt}" not in joined            # inside the root — no extra mount


def test_build_docker_argv_workdir_outside_root_gets_own_mount(tmp_path):
    # Defensive: a spawn cwd OUTSIDE the mounted root (not the current worktree
    # layout) must still resolve in-container — it gets its own path-identical
    # mount rather than a dangling -w.
    (tmp_path / "proj").mkdir()
    proj = _project(tmp_path / "proj", {"enabled": True})
    cfg = sandbox.SandboxConfig.load(proj)
    outside = tmp_path / "elsewhere" / "wt"
    argv = sandbox.build_docker_argv(
        ["claude", "-p"], cfg=cfg, name="orcha-run-abc",
        workspace=str(proj), workdir=str(outside), network=None,
        api_config_mount=str(proj / ".orcha" / "sandbox" / "orcha-run-abc.json"),
    )
    joined = " ".join(argv)
    assert f"-v {outside}:{outside}" in joined
    assert f"-w {outside}" in joined


def test_build_docker_argv_extra_labels(tmp_path):
    # Task-5 REQUIREMENT: the drain sidecar's container is labeled orcha.sidecar=1
    # (via the generic extra_labels param, not hardcoding) so the reaper's orphan
    # pass can exempt it. Default: NO extra labels.
    proj = _project(tmp_path, {"enabled": True})
    cfg = sandbox.SandboxConfig.load(proj)
    kw = dict(cfg=cfg, name="orcha-run-abc", workspace=str(proj),
              network=None,
              api_config_mount=str(proj / ".orcha" / "sandbox" / "orcha-run-abc.json"))
    plain = " ".join(sandbox.build_docker_argv(["claude", "-p", "hi"], **kw))
    assert "orcha.sidecar" not in plain
    labeled = " ".join(sandbox.build_docker_argv(
        ["claude", "-p", "hi"], **kw, extra_labels=(sandbox.LABEL_SIDECAR,)))
    assert "--label orcha.sidecar=1" in labeled
    assert "--label orcha.managed=1" in labeled          # managed label still present


def test_build_docker_argv_mounts_agent_home(tmp_path):
    # Session-persistence: every sandboxed wake (one-shot AND resident) mounts
    # the durable per-workspace agent home over the container's ~/.claude —
    # without it each container boots with an empty ~/.claude and a resident's
    # `--resume <pinned session>` always fails after a container restart.
    proj = _project(tmp_path, {"enabled": True})
    cfg = sandbox.SandboxConfig.load(proj)
    kw = dict(cfg=cfg, name="orcha-run-abc", workspace=str(proj), network=None,
              api_config_mount=str(proj / ".orcha" / "sandbox" / "orcha-run-abc.json"))
    one_shot = " ".join(sandbox.build_docker_argv(["claude", "-p", "hi"], **kw))
    assert f"-v {proj}/.orcha/agent-home:/home/node/.claude" in one_shot
    resident = " ".join(sandbox.build_docker_argv(
        ["claude", "-p"], **kw, interactive=True))
    assert f"-v {proj}/.orcha/agent-home:/home/node/.claude" in resident


def test_workspace_root_for_plain_checkout_and_non_git(tmp_path):
    assert sandbox.workspace_root_for(tmp_path) == tmp_path        # non-git dir
    (tmp_path / ".git").mkdir()
    assert sandbox.workspace_root_for(tmp_path) == tmp_path        # normal checkout


def test_workspace_root_for_resolves_worktree_pointer(tmp_path):
    # The live-evidence layout: a resident worktree whose .git is a POINTER
    # FILE with a host-absolute gitdir into the root checkout.
    wt = tmp_path / ".orcha-worktrees" / "resident-C1"
    wt.mkdir(parents=True)
    (wt / ".git").write_text(f"gitdir: {tmp_path}/.git/worktrees/resident-C1\n")
    assert sandbox.workspace_root_for(wt) == tmp_path


def test_workspace_root_for_tolerates_malformed_pointer(tmp_path):
    wt = tmp_path / "wt"
    wt.mkdir()
    (wt / ".git").write_text("not a gitdir pointer\n")
    assert sandbox.workspace_root_for(wt) == wt                    # fail-safe: itself
    (wt / ".git").write_text("gitdir: /somewhere/odd\n")           # not */.git/worktrees/*
    assert sandbox.workspace_root_for(wt) == wt


def test_agent_home_dir_is_workspace_scoped(tmp_path):
    assert sandbox.agent_home_dir(tmp_path) == tmp_path / ".orcha" / "agent-home"


def test_ensure_agent_home_creates_dir_idempotently(tmp_path):
    path = sandbox.ensure_agent_home(tmp_path)
    assert pathlib.Path(path) == tmp_path / ".orcha" / "agent-home"
    assert (tmp_path / ".orcha" / "agent-home").is_dir()
    assert sandbox.ensure_agent_home(tmp_path) == path      # second call: no-op


def test_ensure_agent_home_mkdir_failure_propagates(tmp_path):
    # write_api_config convention: the caller catches OSError and fails the
    # wake LOUDLY — ensure_agent_home must not swallow a mkdir failure (a
    # silently-skipped mount would quietly re-break resumes).
    (tmp_path / ".orcha").mkdir()
    (tmp_path / ".orcha" / "agent-home").write_text("a file in the way")
    try:
        sandbox.ensure_agent_home(tmp_path)
    except OSError:
        pass
    else:
        raise AssertionError("expected OSError when the agent-home path is a file")


def test_sandbox_api_config_rewrites_base_url(tmp_path):
    proj = _project(tmp_path, {"enabled": True})
    path = sandbox.write_api_config(proj, "orcha-run-abc")
    written = json.loads(pathlib.Path(path).read_text())
    assert written["api_base_url"] == "http://portal:8000"      # service name, in-network
