"""#76 — boot resilience: explicit restart policies for the Orcha + auth stacks.

The Orcha stack (portal+db) did not auto-start after a power cycle; only the auth
stack's oauth2-proxy came back, because it was the only service carrying an explicit
`restart:` policy (Docker's compose default is `restart: "no"`). These are template/file
string-presence gates — no Docker involved — mirroring test_migrations.py's
test_compose_initdb_only_baseline_portal_owns_rest and test_iss294's
test_compose_template_passes_secret_key_to_portal. Goes RED if a restart line is dropped
from either compose source.
"""
import pathlib

REPO = pathlib.Path(__file__).resolve().parent.parent
COMPOSE_J2 = REPO / "orcha-cli" / "orcha_cli" / "templates" / "docker-compose.yml.j2"
AUTH_COMPOSE = REPO / "deploy" / "auth" / "docker-compose.auth.yml"


def _service_block(text: str, service: str) -> str:
    """Return the indented body of one top-level `services:` entry, up to the next
    service at the same indent (2 spaces) or EOF. Good enough for these flat compose
    files without pulling in a YAML parser (not a test dependency in this repo)."""
    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if line == f"  {service}:")
    end = len(lines)
    for i in range(start + 1, len(lines)):
        if lines[i] and not lines[i].startswith("    ") and not lines[i].startswith("  #"):
            end = i
            break
    return "\n".join(lines[start:end])


def test_orcha_stack_portal_and_db_have_unless_stopped():
    """Gate #76: the Orcha stack template must pin both portal and db to
    `restart: unless-stopped`, else a host reboot strands the stack (docker default
    restart: "no" leaves both containers Exited)."""
    template = COMPOSE_J2.read_text()
    db_block = _service_block(template, "db")
    portal_block = _service_block(template, "portal")
    assert "restart: unless-stopped" in db_block, (
        "db service in docker-compose.yml.j2 must carry restart: unless-stopped "
        "(auto-start on boot; docker compose stop/down stays sticky)")
    assert "restart: unless-stopped" in portal_block, (
        "portal service in docker-compose.yml.j2 must carry restart: unless-stopped "
        "(auto-start on boot; docker compose stop/down stays sticky)")


def test_auth_stack_caddy_and_oauth2_proxy_have_unless_stopped():
    """Gate #76: the auth stack must keep explicit restart policies on both caddy and
    oauth2-proxy. oauth2-proxy already had this (it survived the #74 power cycle);
    this pins it so neither service can silently regress to the docker default."""
    compose = AUTH_COMPOSE.read_text()
    caddy_block = _service_block(compose, "caddy")
    oauth2_block = _service_block(compose, "oauth2-proxy")
    assert "restart: unless-stopped" in caddy_block, (
        "caddy service in deploy/auth/docker-compose.auth.yml must carry "
        "restart: unless-stopped")
    assert "restart: unless-stopped" in oauth2_block, (
        "oauth2-proxy service in deploy/auth/docker-compose.auth.yml must carry "
        "restart: unless-stopped")
