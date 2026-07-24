"""Connect a client workspace to an existing Orcha stack."""

from __future__ import annotations

import json
import pathlib
import sys
import urllib.parse
from collections.abc import Callable


def resolve_bridge_port(api_base: str, *, get_json: Callable) -> int | None:
    """Return the terminal bridge port advertised by the target portal."""
    data = get_json(f"{api_base}/api/terminal/config")
    if not data:
        return None
    try:
        return urllib.parse.urlparse(data.get("ws_url") or "").port
    except ValueError:
        return None


def connect_command(
    args,
    *,
    sanitize_name: Callable[[str], str],
    discover_stacks: Callable[[], list[dict]],
    wait_for_portal: Callable,
    get_json: Callable,
    resolve_port: Callable[[str], int | None],
    install_skill_templates: Callable,
    write_hook_config: Callable,
    post_json: Callable,
) -> None:
    """Adopt a running stack from a client-only workspace."""
    cwd = pathlib.Path.cwd()
    claude_dir = cwd / ".claude"
    claude_config = claude_dir / "orcha.json"
    tabs_dir = claude_dir / "orcha-tabs"

    project_short = sanitize_name(args.project_name)
    stacks = discover_stacks()
    match = next((s for s in stacks if s["project_short"] == project_short), None)
    if not match:
        available = ", ".join(s["project_short"] for s in stacks) or "(none)"
        sys.exit(
            f"error: no running stack named '{project_short}'.\n"
            f"  running stacks: {available}\n"
            f"  start one with `orcha up --project <name>` or `orcha init` in a fresh dir."
        )
    if not match["api_port"]:
        sys.exit(
            f"error: stack '{project_short}' is running but its portal port is unknown."
        )

    api_base = f"http://localhost:{match['api_port']}"
    if (cwd / ".orcha").exists():
        sys.exit(
            f"error: this folder has its own .orcha/ stack — connecting would point "
            f"its skills at '{project_short}' instead of the local stack. "
            f"Either run this from a fresh folder, or remove .orcha/ first."
        )

    wait_for_portal(api_base, timeout_s=5.0)
    data = get_json(f"{api_base}/api/containers")
    if not data or not data.get("containers"):
        sys.exit(
            f"error: stack '{project_short}' has no container yet — run "
            f"`orcha init` in its owning folder first."
        )
    container = data["containers"][0]
    container_id = container["id"]
    bridge_port = resolve_port(api_base)
    claude_commands, codex_skills = install_skill_templates(cwd)

    config = {
        "api_base_url": api_base,
        "project_name": project_short,
        "api_port": match["api_port"],
        "db_port": match["db_port"],
        "current_container_id": container_id,
        "connected": True,
    }
    if bridge_port:
        config["bridge_port"] = bridge_port
    claude_config.parent.mkdir(parents=True, exist_ok=True)
    claude_config.write_text(json.dumps(config, indent=2) + "\n")
    tabs_dir.mkdir(parents=True, exist_ok=True)
    write_hook_config(claude_config.parent)

    human_agent_id: str | None = None
    human_alias = (args.as_user or "").strip() or None
    if human_alias:
        try:
            response = post_json(
                f"{api_base}/api/containers/{container_id}/agents",
                {"alias": human_alias, "role": "operator", "kind": "human"},
            )
            human_agent_id = response["agent_id"]
            binding = {
                "alias": human_alias,
                "agent_id": human_agent_id,
                "container_id": container_id,
                "kind": "human",
            }
            (tabs_dir / f"{human_alias}.json").write_text(
                json.dumps(binding, indent=2) + "\n"
            )
            print(
                f"[orcha] ✓ registered as human '{human_alias}' (agent_id {human_agent_id})"
            )
        except Exception as exc:  # noqa: BLE001 - registration failures are intentionally non-fatal
            print(
                f"[orcha] warn: --as registration failed ({exc}); "
                f"add yourself manually with /orcha-register-human"
            )

    print()
    print(f"[orcha] ✓ connected '{cwd}' → stack '{project_short}'")
    print(f"        api:           {api_base}/")
    print(f"        container:     {container.get('name')}  ({container_id})")
    print(f"        config:        {claude_config}")
    print(f"        skills:        {claude_commands}")
    print(f"        codex:         {codex_skills}")
    print()
    print("Next steps:")
    if human_agent_id:
        print(
            f"  1. export ORCHA_ALIAS={human_alias}  (in your shell, for sticky identity)"
        )
        print("  2. Open Claude Code or Codex here and use Orcha commands as usual.")
    else:
        print(
            "  1. Register yourself as a human (recommended for cross-folder collab):"
        )
        print("       /orcha-register-human <YourName>")
        print("  2. Or register an AI agent now:")
        print('       /orcha-register-agent <Alias> --role "..." --prompt "..."')
