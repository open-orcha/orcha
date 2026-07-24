"""Discover and address local Docker Compose stacks managed by Orcha."""

from __future__ import annotations

import subprocess
import sys
from collections import defaultdict
from collections.abc import Callable


def discover_stacks(*, parse_host_port: Callable[[str, str], int | None]) -> list[dict]:
    """Return running Orcha stacks with their published portal and database ports."""
    result = subprocess.run(
        [
            "docker",
            "ps",
            "--format",
            '{{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}',
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        sys.exit(f"error running docker ps:\n{result.stderr}")

    by_project: dict[str, list[tuple[str, str, str]]] = defaultdict(list)
    for line in result.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        name, status, ports, project = parts
        if project.startswith("orcha-"):
            by_project[project].append((name, status, ports))

    stacks: list[dict] = []
    for project in sorted(by_project):
        api_port = None
        db_port = None
        portal_status = ""
        for name, status, ports in by_project[project]:
            if "portal" in name:
                portal_status = status
                api_port = parse_host_port(ports, "8000")
            elif "db" in name:
                db_port = parse_host_port(ports, "5432")
        stacks.append(
            {
                "project": project,
                "project_short": project.removeprefix("orcha-"),
                "api_port": api_port,
                "db_port": db_port,
                "portal_status": portal_status,
            }
        )
    return stacks


def full_project(project_name: str) -> str:
    """Return the Compose project name corresponding to the public short name."""
    return f"orcha-{project_name}"


def by_project(
    project_name: str,
    *args: str,
    export_pairing_host: Callable[[], None],
) -> None:
    """Run a Compose command against a named Orcha project."""
    if "up" in args:
        export_pairing_host()
    command = ["docker", "compose", "-p", full_project(project_name), *args]
    subprocess.run(command, check=True)


def project_exists(project_name: str) -> bool:
    """Return whether Compose has containers for the named project."""
    result = subprocess.run(
        [
            "docker",
            "ps",
            "-a",
            "--filter",
            f"label=com.docker.compose.project={full_project(project_name)}",
            "--format",
            "{{.Names}}",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    return bool(result.stdout.strip())
