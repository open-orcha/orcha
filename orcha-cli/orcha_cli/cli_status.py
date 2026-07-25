"""Render local project status and discover running Orcha stacks."""

from __future__ import annotations

import json
import pathlib
import sys
from typing import Any


def status_command(_: Any, services: Any) -> None:
    """Show the connected project and its Compose process state."""
    cwd = pathlib.Path.cwd()
    orcha_dir = cwd / ".orcha"
    config_path = cwd / ".claude" / "orcha.json"
    if not config_path.exists():
        sys.exit("error: no .claude/orcha.json — run `orcha init` first")
    config = json.loads(config_path.read_text())
    print(f"project:              {config.get('project_name', '?')}")
    print(f"api base URL:         {config.get('api_base_url', '?')}")
    print(f"db port:              {config.get('db_port', '?')}")
    print(
        "current container_id: "
        f"{config.get('current_container_id', '(none — run /orcha-container)')}"
    )
    print()
    if (orcha_dir / "docker-compose.yml").exists():
        services._compose(orcha_dir, "ps")
        print()
        print(
            f"tail logs:  docker compose -f {orcha_dir / 'docker-compose.yml'} logs -f"
        )
        print(
            "db shell:   docker compose -f "
            f"{orcha_dir / 'docker-compose.yml'} exec db psql -U orcha -d orcha"
        )


def list_command(_: Any, services: Any) -> None:
    """List running stacks with each stack's single Orcha container."""
    stacks = services._discover_stacks()
    if not stacks:
        print(
            "no orcha stacks running. cd to a project and `orcha up`, "
            "or `orcha init` to bootstrap."
        )
        return
    header = f"{'PROJECT':<22} {'API':<28} {'DB':<6} {'CONTAINER':<28} {'STATUS':<10}"
    print(header)
    print("-" * len(header))
    for stack in stacks:
        api_port = stack["api_port"] or "?"
        db_port = stack["db_port"] or "?"
        api_url = f"http://localhost:{api_port}/"
        container_name = "(none — run orcha init)"
        container_status = "-"
        if stack["api_port"]:
            data = services._get_json(
                f"http://localhost:{stack['api_port']}/api/containers"
            )
            if data and data.get("containers"):
                container = data["containers"][0]
                container_name = (container.get("name") or "(unnamed)")[:27]
                container_status = container.get("status") or "-"
        print(
            f"{stack['project_short']:<22} {api_url:<28} {db_port:<6} "
            f"{container_name:<28} {container_status:<10}"
        )


def parse_host_port(ports: str, container_port: str) -> str | None:
    """Extract a published host port from Docker's human-readable port list."""
    for chunk in ports.split(","):
        chunk = chunk.strip()
        if f"->{container_port}/" in chunk and "0.0.0.0:" in chunk:
            try:
                return chunk.split("0.0.0.0:")[1].split("->")[0]
            except (IndexError, ValueError):
                pass
    return None
