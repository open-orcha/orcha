"""Start, stop, migrate, and upgrade an Orcha project stack."""
from __future__ import annotations

import argparse
import json
import pathlib
import sys


def cmd_up(args: argparse.Namespace, services) -> None:
    if args.project:
        if not services._project_exists(args.project):
            sys.exit(
                f"error: no docker compose project named '{services._full_project(args.project)}' found. "
                f"Run `orcha ls` to see available projects, or `orcha init` in a fresh dir."
            )
        services._by_project(args.project, "up", "-d")
        return
    orcha_dir = pathlib.Path.cwd() / ".orcha"
    if not (orcha_dir / "docker-compose.yml").exists():
        sys.exit(
            "error: no .orcha/docker-compose.yml here — run `orcha init` first, "
            "or pass `--project <name>` to target a specific stack from anywhere."
        )
    services._compose(orcha_dir, "up", "-d")
    # #298: backfill the project-preferences file if a pre-#298 project is missing it.
    prefs_path = services._install_project_preferences(pathlib.Path.cwd())
    if prefs_path:
        print(f"[orcha] backfilled {prefs_path} (#298 loosely-hardened project rules)")
    # Epic A: relaunching the workspace brings the wake daemon back up too.
    try:
        services.ensure_daemon(pathlib.Path.cwd())
    except Exception as e:
        print(f"[orcha] warn: notifier daemon didn't start ({e}); start it with `orcha notifier --ensure`")
    try:    # S3 §3b: and the host-side live-terminal bridge
        from orcha_cli.terminal_bridge import ensure_bridge
        ensure_bridge(pathlib.Path.cwd())
    except Exception as e:
        print(f"[orcha] warn: terminal bridge didn't start ({e}); start it with `orcha terminal-bridge --ensure`")


def cmd_down(args: argparse.Namespace, services) -> None:
    extra = ["-v"] if args.volumes else []
    # Epic A: the wake daemon dies with the stack — otherwise a daemon would keep
    # polling a DB that's going away (and, with -v, a wiped one). Best-effort, local
    # cwd only (a --project down from elsewhere can't locate that project's pidfile).
    try:
        services.stop_daemon(pathlib.Path.cwd())
    except Exception:
        pass
    try:    # S3 §3b: the live-terminal bridge dies with the stack too (else it holds the port +
            # points at a going-away DB; the portal would still advertise its ws URL).
        from orcha_cli.terminal_bridge import stop_bridge
        stop_bridge(pathlib.Path.cwd())
    except Exception:
        pass
    if args.project:
        if not services._project_exists(args.project):
            sys.exit(
                f"error: no docker compose project named '{services._full_project(args.project)}' found. "
                f"Run `orcha ls` to see available projects."
            )
        services._by_project(args.project, "down", *extra)
        return
    orcha_dir = pathlib.Path.cwd() / ".orcha"
    if not (orcha_dir / "docker-compose.yml").exists():
        sys.exit(
            "error: no .orcha/docker-compose.yml here — nothing to bring down. "
            "Pass `--project <name>` to target a specific stack from anywhere."
        )
    services._compose(orcha_dir, "down", *extra)


def cmd_migrate(_: argparse.Namespace, services) -> None:
    """R1: apply pending DB migrations on demand (the portal also runs them on startup,
    so `orcha up` already migrates; this is the explicit, on-demand path)."""
    cwd = pathlib.Path.cwd()
    config_path = cwd / ".claude" / "orcha.json"
    if not config_path.exists():
        sys.exit("error: no .claude/orcha.json — run `orcha init` first")
    api_base = json.loads(config_path.read_text()).get("api_base_url")
    if not api_base:
        sys.exit("error: api_base_url missing from .claude/orcha.json")
    try:
        data = services._post_json(f"{api_base}/api/admin/migrate", {})
    except Exception as e:
        sys.exit(f"error: migrate request failed ({e}); is the stack up? (`orcha up`)")
    applied = data.get("applied") or []
    print(f"[orcha] migrations applied: {applied}" if applied else "[orcha] schema already up to date")


def cmd_upgrade(args: argparse.Namespace, services) -> None:
    """Upgrade an EXISTING project to the installed CLI's templates WITHOUT a data wipe.

    Re-renders docker-compose.yml (ports/name preserved from .claude/orcha.json), re-copies
    portal/ + migrations/ + skills, then rebuilds the portal. This is the upgrade story for
    features that change the portal/compose (e.g. R1's migration runner + the portal mount):
    `orcha up` can only migrate an existing volume AFTER the portal is on the new build+compose,
    which this delivers. Data is preserved (no `down -v`); pending migrations then apply on the
    portal's startup (or `orcha migrate`).
    """
    cwd = pathlib.Path.cwd()
    orcha_dir = cwd / ".orcha"
    config_path = cwd / ".claude" / "orcha.json"
    if not (orcha_dir / "docker-compose.yml").exists() or not config_path.exists():
        sys.exit("error: no .orcha/ + .claude/orcha.json here — `orcha upgrade` is for an "
                 "existing project (run `orcha init` to bootstrap a new one).")
    cfg = json.loads(config_path.read_text())
    project_name = cfg.get("project_name") or services._sanitize_name(cwd.name)
    db_port, api_port = cfg.get("db_port"), cfg.get("api_port")
    if not db_port or not api_port:
        sys.exit("error: db_port/api_port missing from .claude/orcha.json; re-init instead.")
    # Downgrade guard: the migration chain is a monotonic stamp present on BOTH sides
    # (packaged templates + the stack's .orcha/migrations copy). An outdated CLI whose
    # tip is BELOW the stack's would re-copy older templates over a newer portal — a
    # silent downgrade (vanilla shell at /, 404 feature routes) that looks like "the
    # upgrade did nothing". Refuse before any writes; --allow-downgrade overrides for
    # deliberate rollbacks.
    cli_tip = services._migration_tip(services.PKG_TEMPLATES / "migrations")
    stack_tip = services._migration_tip(orcha_dir / "migrations")
    if cli_tip < stack_tip and not getattr(args, "allow_downgrade", False):
        sys.exit(
            f"error: this project is on a NEWER Orcha than your CLI "
            f"(project migrations reach {stack_tip:03d}, this CLI ships {cli_tip:03d}).\n"
            "Upgrading now would DOWNGRADE the portal. Update the orcha CLI first "
            "(e.g. `uv tool upgrade orcha-cli` / `brew upgrade orcha`), then re-run "
            "`orcha upgrade` — or pass --allow-downgrade to roll back deliberately."
        )
    # ISS-84/#235: backfill the per-project bridge_port for projects created before this field
    # existed. Pick a free port (8765 scan-start so the first project keeps the familiar port),
    # persist it to orcha.json, and re-render it into the compose env below — keeping the
    # advertised ws URL and the bridge's actual bind in lockstep. The bridge is restarted at the
    # end so it rebinds to this port.
    bridge_port = cfg.get("bridge_port")
    if not bridge_port:
        bridge_port = services._find_free_port(start=8765)
        cfg["bridge_port"] = bridge_port
        config_path.write_text(json.dumps(cfg, indent=2) + "\n")
        print(f"[orcha] backfilled per-project bridge_port={bridge_port} (ISS-84/#235)")
    rendered = (
        (services.PKG_TEMPLATES / "docker-compose.yml.j2").read_text()
        .replace("{{ project_name }}", project_name)
        .replace("{{ db_port }}", str(db_port))
        .replace("{{ api_port }}", str(api_port))
        .replace("{{ bridge_port }}", str(bridge_port))
    )
    (orcha_dir / "docker-compose.yml").write_text(rendered)
    services._copy_tree(services.PKG_TEMPLATES / "migrations", orcha_dir / "migrations")
    services._copy_tree(services.PKG_TEMPLATES / "portal", orcha_dir / "portal")
    services._install_llm_util(orcha_dir)  # #290 llm_util + #294 secret_box + #287 digest_curate into portal build
    claude_commands, codex_skills = services._install_orcha_skill_templates(cwd)
    # #298: backfill the project-preferences file for projects created before it existed.
    prefs_path = services._install_project_preferences(cwd)
    if prefs_path:
        print(f"[orcha] backfilled {prefs_path} (#298 loosely-hardened project rules)")
    print("[orcha] re-rendered compose + re-copied portal/migrations/skills from templates")
    print(f"[orcha] refreshed Claude commands: {claude_commands}")
    print(f"[orcha] refreshed Codex skills: {codex_skills}")
    # ISS-40/ISS-20: re-register the notification hooks so newly-shipped template
    # hooks (e.g. C1's SessionEnd `orcha snapshot`) reach an EXISTING workspace on
    # upgrade — init/connect call this, but upgrade previously didn't, so new hooks
    # never landed without a manual `orcha enable-hook`. Idempotent + additive: only
    # missing hooks are added; existing settings.json entries are untouched.
    if services._write_hook_config(config_path.parent):
        print("[orcha] registered newly-shipped notification hooks in .claude/settings.json")
    else:
        print("[orcha] notification hooks already up to date (.claude/settings.json)")
    print("[orcha] rebuilding portal (data preserved — no volume wipe) ...")
    services._compose(orcha_dir, "up", "-d", "--build")
    try:
        services.ensure_daemon(cwd, restart=True)
    except Exception as e:
        print(f"[orcha] warn: notifier daemon didn't restart ({e}); start it with `orcha notifier --ensure`")
    # ISS-84/#235: restart the bridge so it rebinds to the per-project bridge_port (a backfill
    # changes the port from the old fixed 8765; even with no change a restart is harmless and
    # matches the daemon's restart-on-upgrade). The bridge reads bridge_port from orcha.json.
    # Honor --no-bridge when upgrade is invoked from `orcha update` on a headless host (no
    # terminal panel): standalone `orcha upgrade` has no such flag, so getattr defaults to
    # False and it still rebinds. Without this guard, update's Phase-3 --no-bridge suppression
    # is defeated because Phase-1 (this cmd_upgrade) already restarted the bridge.
    if not getattr(args, "no_bridge", False):
        try:
            from orcha_cli import terminal_bridge
            terminal_bridge.ensure_bridge(cwd, restart=True, quiet=True)
        except Exception as e:
            print(f"[orcha] warn: terminal bridge didn't restart ({e}); start it with `orcha terminal-bridge --ensure`")
    print("[orcha] ✓ upgraded. Pending migrations apply on portal startup; `orcha migrate` to force now.")
