"""Project initialization workflow for the Orcha command-line interface."""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
from typing import Optional

def cmd_init(args: argparse.Namespace, services) -> None:
    """Initialize a project while resolving patchable services from the CLI facade."""
    PKG_TEMPLATES = services.PKG_TEMPLATES
    _sanitize_name = services._sanitize_name
    _find_free_port = services._find_free_port
    _copy_tree = services._copy_tree
    _install_llm_util = services._install_llm_util
    _install_orcha_skill_templates = services._install_orcha_skill_templates
    _install_project_preferences = services._install_project_preferences
    _write_hook_config = services._write_hook_config
    _compose = services._compose
    _wait_for_portal = services._wait_for_portal
    _post_json = services._post_json
    _put_json = services._put_json
    _detect_github_repo = services._detect_github_repo
    _prune_stale_bindings = services._prune_stale_bindings
    stop_daemon_for_container = services.stop_daemon_for_container
    ensure_daemon = services.ensure_daemon
    project_root = pathlib.Path.cwd()
    orcha_dir = project_root / ".orcha"
    claude_config = project_root / ".claude" / "orcha.json"
    tabs_dir = project_root / ".claude" / "orcha-tabs"
    # #255: the container this checkout was bound to BEFORE this (re-)init — captured before
    # step 4 overwrites orcha.json. On `--reset-data` its daemon + tab bindings are now stale.
    old_container_id: Optional[str] = None
    if claude_config.exists():
        try:
            old_container_id = json.loads(claude_config.read_text()).get("current_container_id")
        except (OSError, ValueError):
            old_container_id = None

    if orcha_dir.exists() and not args.force:
        sys.exit("error: .orcha/ already exists; pass --force to overwrite")

    project_name = _sanitize_name(args.name or project_root.name)
    db_port = args.db_port or _find_free_port(start=5432)
    api_port = args.api_port or _find_free_port(start=8000)
    # ISS-84/#235: the live-terminal bridge port must be per-project too — api_port/db_port
    # already are, but the bridge port was a fixed 8765 constant, so a 2nd project's browser
    # dialled the 1st project's bridge (auth against the wrong container -> 4403). Scan starts
    # at 8765 so the first project keeps the familiar port; only 2nd+ shift.
    bridge_port = args.bridge_port or _find_free_port(start=8765)
    api_base = f"http://localhost:{api_port}"

    # Orcha#30: figure out who the first human is.
    human_alias = args.as_user or os.environ.get("USER") or "operator"
    human_alias = human_alias.strip() or "operator"

    # GitHub auto-bind (project-runtime epic): when init runs inside a git checkout whose
    # `origin` points at github.com, bind the new container to that repo automatically —
    # so the box-side provisioner / token-refresh timer can mint repo-scoped tokens
    # without a manual Connect-repo click. `--no-github` opts out; detection failures are
    # silent (best-effort sugar, never a reason for init to fail).
    github_repo: Optional[str] = None
    if not getattr(args, "no_github", False):
        github_repo = _detect_github_repo(project_root)

    # 1. Render docker-compose template
    template_text = (PKG_TEMPLATES / "docker-compose.yml.j2").read_text()
    rendered = (
        template_text
        .replace("{{ project_name }}", project_name)
        .replace("{{ db_port }}", str(db_port))
        .replace("{{ api_port }}", str(api_port))
        .replace("{{ bridge_port }}", str(bridge_port))
    )
    orcha_dir.mkdir(parents=True, exist_ok=True)
    (orcha_dir / "docker-compose.yml").write_text(rendered)

    # 2. Copy migrations/ and portal/
    _copy_tree(PKG_TEMPLATES / "migrations", orcha_dir / "migrations")
    _copy_tree(PKG_TEMPLATES / "portal", orcha_dir / "portal")
    _install_llm_util(orcha_dir)  # #290 llm_util + #294 secret_box + #287 digest_curate into portal build

    # 3. Copy Orcha command templates for Claude Code and Codex.
    claude_commands, codex_skills = _install_orcha_skill_templates(project_root)

    # 3b. #298: materialize the project-preferences file (loosely-hardened gh/git rules agents
    #     read). Packaged template → docs/orcha-project-preferences.md, so every project gets it
    #     at init regardless of install method. The autonomy LEVEL is never written here (DB-only).
    prefs_path = _install_project_preferences(project_root)
    if prefs_path:
        print(f"[orcha] wrote {prefs_path} (loosely-hardened project rules — commit it)")

    # 4. Write .claude/orcha.json (preserve current_container_id if present + --force)
    existing: dict = {}
    if claude_config.exists() and args.force:
        try:
            existing = json.loads(claude_config.read_text())
        except Exception:
            existing = {}
    config = {
        "api_base_url": api_base,
        "project_name": project_name,
        "api_port": api_port,
        "db_port": db_port,
        "bridge_port": bridge_port,
    }
    if github_repo:
        # Recorded locally as well as bound via the API below, so folder-side tooling
        # (and a later `orcha up` on a fresh box) can see the binding without a portal
        # round-trip.
        config["github_repo"] = github_repo
    claude_config.parent.mkdir(parents=True, exist_ok=True)
    claude_config.write_text(json.dumps(config, indent=2) + "\n")

    # 4b. Orcha#33: register the PostToolUse poll-inbox hook so working agents
    #     notice incoming asks within ~5s. Idempotent w.r.t. existing settings.json.
    _write_hook_config(claude_config.parent)

    # 4c. --reset-data: drop this project's Postgres volume for a PRISTINE start.
    #     Without it, `init --force` REUSES the existing named volume
    #     (orcha-<project>_pgdata), so the previous container + all agents/tasks/
    #     requests survive and create_container 409s on re-init (Tim's reset task).
    #     `down -v` removes the volume → fresh initdb on the next `up` → empty DB.
    #     Explicit flag ONLY — init NEVER wipes data implicitly. The just-written
    #     compose file names the same project, so this targets the right volume.
    if args.reset_data:
        print(f"[orcha] --reset-data: dropping DB volume for project '{project_name}' "
              f"(DESTRUCTIVE — wiping all prior data) ...")
        _compose(orcha_dir, "down", "-v", check=False)

    # 5. docker compose up
    print(f"[orcha] starting stack '{project_name}' on api={api_port}, db={db_port} ...")
    _compose(orcha_dir, "up", "-d", "--build")

    # 6. Wait for portal readiness — the next two API calls need it up.
    if not args.no_container:
        _wait_for_portal(api_base)

    # 7. Orcha#29: bootstrap the container.
    container_id: Optional[str] = None
    if args.no_container:
        print("[orcha] --no-container set; skipping container creation.")
    else:
        objective = (args.objective or "").strip()
        if not objective:
            # Default to the project name as the objective; can be renamed later.
            objective = project_root.name
            print(f"[orcha] no --objective; defaulting to '{objective}' (rename later via API).")
        try:
            data = _post_json(f"{api_base}/api/containers", {"name": objective})
            container_id = data["container_id"]
            config["current_container_id"] = container_id
            claude_config.write_text(json.dumps(config, indent=2) + "\n")
            print(f"[orcha] ✓ container created: {container_id}  name='{objective}'")
        except Exception as e:
            msg = str(e)
            # The stack already had a container (init --force reuses the volume by
            # design). Don't silently wipe — point the user at the explicit reset.
            if "already has a container" in msg or "409" in msg:
                sys.exit(
                    "error: this stack already has a container; its data was preserved.\n"
                    "  `orcha init --force` reuses the existing DB volume by design.\n"
                    "  To start COMPLETELY fresh (wipes all agents/tasks/requests):\n"
                    "      orcha init --force --reset-data\n"
                    "  …or drop the volume manually first:  orcha down -v && orcha init"
                )
            sys.exit(f"error: container creation failed: {e}")

    # 7b. GitHub auto-bind: seed the freshly created container's repo binding the same way
    #     init seeds everything else — through the portal API (PUT /api/containers/{cid}/github,
    #     the exact endpoint the portal's Connect-repo modal uses). Best-effort: a failure
    #     leaves the container unbound (bindable later from the portal), never kills init.
    if container_id is not None and github_repo:
        try:
            _put_json(
                f"{api_base}/api/containers/{container_id}/github",
                {"repo": github_repo},
            )
            print(f"[orcha] ✓ GitHub repo bound from origin remote: {github_repo}")
        except Exception as e:
            print(f"[orcha] warn: GitHub auto-bind failed ({e}); "
                  "bind manually from the portal's Connect-repo modal")
    elif github_repo:
        print(f"[orcha] GitHub origin detected ({github_repo}) but no container was "
              "created — recorded in .claude/orcha.json only")

    # 8. Orcha#30: register the first human agent (kind='human').
    if container_id is not None:
        try:
            # PR attribution: carry the optional GitHub identity so agent-opened PRs
            # credit this human (docs/agent-prs.md). Omit keys when absent (NULL).
            _human_body = {
                "alias": human_alias,
                "role": "operator",
                "kind": "human",
                # prompt intentionally omitted — humans don't carry a system prompt
            }
            _gh = (getattr(args, "github_login", None) or "").lstrip("@").strip()
            _ge = (getattr(args, "git_email", None) or "").strip()
            if _gh:
                _human_body["github_login"] = _gh
            if _ge:
                _human_body["git_email"] = _ge
            data = _post_json(
                f"{api_base}/api/containers/{container_id}/agents",
                _human_body,
            )
            human_agent_id = data["agent_id"]
            tabs_dir.mkdir(parents=True, exist_ok=True)
            binding = {
                "alias": human_alias,
                "agent_id": human_agent_id,
                "container_id": container_id,
                "kind": "human",
            }
            (tabs_dir / f"{human_alias}.json").write_text(
                json.dumps(binding, indent=2) + "\n"
            )
            print(f"[orcha] ✓ first human registered: {human_alias}  (agent_id {human_agent_id})")
        except Exception as e:
            print(f"[orcha] warn: human registration failed ({e}); register manually with /orcha-register-human")

    # 8a. #255: --reset-data host cleanup. The DB volume was dropped (step 4c) and a NEW
    #     container created, so anything on disk keyed to the OLD container is now stale:
    #     - tab bindings for the wiped fleet still carry the dead container_id → prune them
    #       (the fresh human binding, written just above with the NEW cid, is kept).
    #     - the daemon bound to the OLD container keeps polling a now-404 container forever;
    #       ensure_daemon(restart=True) below only stops the daemon for the NEW cid (orcha.json
    #       was overwritten in step 7), so stop the OLD one explicitly by its container id.
    if args.reset_data and old_container_id and old_container_id != container_id:
        pruned = _prune_stale_bindings(tabs_dir, container_id or "")
        if pruned:
            print(f"[orcha] --reset-data: pruned {pruned} stale tab binding(s) for the old container")
        if stop_daemon_for_container(old_container_id, quiet=True):
            print(f"[orcha] --reset-data: stopped the stale daemon bound to the old container")

    # 8b. Epic A: bring the wake daemon up with the workspace (ON by default).
    #     restart=True so a re-init binds the daemon to the JUST-created container
    #     (it resolves its container once at startup; a stale daemon would watch the
    #     old, dead container). Idempotent otherwise.
    try:
        ensure_daemon(project_root, restart=True)
    except Exception as e:
        print(f"[orcha] warn: notifier daemon didn't start ({e}); start it with `orcha notifier --ensure`")
    try:    # S3 §3b: bring the host-side live-terminal bridge up with the workspace too. restart=True
            # so a re-init binds a fresh bridge to the JUST-created container (mirrors the daemon).
        from orcha_cli.terminal_bridge import ensure_bridge
        ensure_bridge(project_root, restart=True)
    except Exception as e:
        print(f"[orcha] warn: terminal bridge didn't start ({e}); start it with `orcha terminal-bridge --ensure`")

    # 9. Report
    print()
    print(f"[orcha] ✓ initialized in {project_root}")
    print(f"        api:      {api_base}/")
    print(f"        db:       postgresql://orcha:orcha@localhost:{db_port}/orcha")
    print(f"        skills:   {claude_commands}")
    print(f"        codex:    {codex_skills}")
    print(f"        config:   {claude_config}")
    if container_id:
        print(f"        container_id: {container_id}")
    print()
    print("Next steps:")
    print(f"  1. In your shell:  export ORCHA_ALIAS={human_alias}")
    print( "     (so /orcha-* commands attribute actions to you without needing --alias every time)")
    print( "  2. Open Claude Code or Codex in this directory.")
    print( "  3. Register your first AI agent:")
    print(f"       /orcha-register-agent <Alias> --role \"...\" --prompt \"...\" [--initial-task \"...\" --task-dod \"...\"]")
    print( "  4. Inspect anytime:  /orcha-status in Claude or $orcha-status in Codex")
