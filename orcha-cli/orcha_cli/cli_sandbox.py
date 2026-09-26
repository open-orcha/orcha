"""`orcha sandbox` — toggle, inspect, and build the sandbox wake runner."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys

from . import sandbox


def _sandbox_config_guard(cwd: pathlib.Path) -> pathlib.Path:
    """`sandbox on/off/status` all need an existing project's .claude/orcha.json —
    mirrors cmd_status/cmd_upgrade's own existence gate + error wording."""
    config_path = cwd / ".claude" / "orcha.json"
    if not config_path.exists():
        sys.exit(
            "error: no .claude/orcha.json here — run `orcha sandbox` from an "
            "existing project directory (run `orcha init` to bootstrap one)."
        )
    return config_path


def _load_orcha_json_loud(config_path: pathlib.Path) -> dict:
    """Read+parse .claude/orcha.json, exiting with a CLEAN, actionable message on a
    garbled file instead of leaking a raw JSONDecodeError traceback. `sandbox status`
    calls this BEFORE SandboxConfig.load so the diagnostic command never silently
    reports `enabled: False` defaults on a corrupt file (which would confirm a lie)."""
    try:
        return json.loads(config_path.read_text())
    except (OSError, ValueError):
        sys.exit(
            "error: .claude/orcha.json is not valid JSON — fix or restore it, then retry"
        )


def sandbox_command(args: argparse.Namespace, *, pkg_templates) -> None:
    """Sandbox mode (opt-in; see docs/sandbox-mode.md): agent wakes run inside an
    isolated `orcha/runner` Docker container instead of directly on the host.

    `on`/`off` flip the `sandbox.enabled` flag in .claude/orcha.json via a
    read-modify-write that preserves every other top-level key AND any existing
    sandbox sub-keys (e.g. a custom `image`) — only `enabled` is touched. `status`
    prints the effective SandboxConfig (defaults filled in). `build-image` builds
    the `orcha/runner` image from the CLI's installed template and needs no project
    at all — it only reads the installed templates/runner/ directory.
    """
    if args.action == "build-image":
        template_dir = pkg_templates / "runner"
        cmd = ["docker", "build", "-t", sandbox.DEFAULT_IMAGE, str(template_dir)]
        print(f"[orcha] building sandbox runner image\n        $ {' '.join(cmd)}")
        result = subprocess.run(cmd)
        sys.exit(result.returncode)

    cwd = pathlib.Path.cwd()
    config_path = _sandbox_config_guard(cwd)

    if args.action == "status":
        _load_orcha_json_loud(config_path)  # fail loud on a corrupt file, not silently defaults
        cfg = sandbox.SandboxConfig.load(cwd)
        print(f"enabled:          {cfg.enabled}")
        print(f"image:            {cfg.image}")
        print(f"memory:           {cfg.memory}")
        print(f"cpus:             {cfg.cpus}")
        print(f"pids_limit:       {cfg.pids_limit}")
        print(f"max_runtime_secs: {cfg.max_runtime_secs}")
        print(f"network:          {cfg.network or '(derived from compose)'}")
        # Pre-dogfood review item 3: the runner container receives provider creds
        # ONLY via spawn's `-e` env passthrough from the DAEMON's environment
        # (ANTHROPIC_API_KEY / OPENAI_API_KEY / ORCHA_LLM_API_KEY, or a
        # subscription `claude setup-token` CLAUDE_CODE_OAUTH_TOKEN). Interactive
        # host OAuth login state (claude login / codex login) does NOT reach the
        # container. A soft warning here, NOT a preflight failure — keys may
        # legitimately arrive later (e.g. exported by the unit file that starts
        # the daemon).
        if cfg.enabled and not any(
            os.environ.get(k)
            for k in (
                "ANTHROPIC_API_KEY",
                "OPENAI_API_KEY",
                "ORCHA_LLM_API_KEY",
                "CLAUDE_CODE_OAUTH_TOKEN",
            )
        ):
            print(
                "WARNING: no provider API key in the daemon environment — "
                "sandbox wakes will fail auth (export ANTHROPIC_API_KEY / "
                "OPENAI_API_KEY / ORCHA_LLM_API_KEY / CLAUDE_CODE_OAUTH_TOKEN "
                "where the notifier starts)"
            )
        return

    # on / off — preserve unknown top-level keys and unknown sandbox sub-keys.
    cfg = _load_orcha_json_loud(config_path)
    cfg.setdefault("sandbox", {})["enabled"] = args.action == "on"
    # Atomic write: render to a temp file in the SAME dir, then os.replace over the
    # target — a crash mid-write can never leave a half-written orcha.json.
    tmp_path = config_path.with_name(config_path.name + ".tmp")
    tmp_path.write_text(json.dumps(cfg, indent=2) + "\n")
    os.replace(tmp_path, config_path)
    state = "enabled" if args.action == "on" else "disabled"
    print(f"[orcha] sandbox mode {state} (.claude/orcha.json)")
