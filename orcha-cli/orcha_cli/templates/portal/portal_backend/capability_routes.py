"""Deployment capability discovery — what THIS portal supports, for clients.

Companion seam to the auth provider (#211), portal extensions (#212), and
namespaced migrations (#213): a downstream distribution registers the extra
capabilities it ships (e.g. an access model, device tokens, a push relay) and
clients — the mobile apps foremost — negotiate features at runtime instead of
assuming a deployment shape. One binary then serves every Orcha deployment:
absent capability ⇒ the client hides or degrades the surface, never errors.

Client compatibility rule (pinned by the mobile apps): a portal that 404s this
endpoint entirely is a pre-capabilities build — clients treat that as "assume
the full feature set of my own vintage", NOT "assume nothing".

The response carries no secrets and no per-user data; it describes the
deployment's shape only, so it rides the same perimeter as every other read.
"""

from portal_backend.application import app

# Core capabilities every upstream deployment ships. Downstreams extend via
# register_capability() at app assembly — never by editing this set.
_CORE_CAPABILITIES = {
    "tasks",
    "conversations",
    "requests",
    "decisions",
    "attachments",
    "pairing",
    "autonomy_levels",
}

_capabilities: set[str] = set(_CORE_CAPABILITIES)


def register_capability(name: str) -> None:
    """Register an additional capability string (idempotent)."""
    if not name or not isinstance(name, str):
        raise ValueError("capability name must be a non-empty string")
    _capabilities.add(name)


def reset_capabilities() -> None:
    """Restore the core set (test isolation)."""
    _capabilities.clear()
    _capabilities.update(_CORE_CAPABILITIES)


@app.get("/api/capabilities")
def get_capabilities():
    return {"capabilities": sorted(_capabilities)}
