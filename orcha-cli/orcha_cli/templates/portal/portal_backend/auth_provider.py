"""Pluggable auth provider seam (SEAM A / open-orcha#211).

Open-core Orcha ships with NO server-side caller authentication: a route trusts
the acting-agent id it is handed in the request body (``actor_agent_id`` and its
per-route equivalents) and only checks that id's *kind* (``require_kind(...,
("human",))``) — it never verifies the caller actually **is** that agent. That
open V2 spoof vector is documented in ``tests/test_iss271_actor_hardening.py``.

This module adds a lane for a downstream distribution (e.g. orcha-cloud) to plug
in real caller resolution and authorization WITHOUT forking the route files. The
defaults preserve today's behavior BIT-FOR-BIT:

  * ``resolve_actor`` returns the explicit fallback id the route already read
    from the body — i.e. exactly what the route used before this seam existed.
  * ``authorize`` permits everything — the existing per-route ``require_kind`` /
    human-authority checks stay exactly where they are; this hook only ADDS a
    check lane, it does not move or replace any existing one.

A distribution swaps either (or both) via ``register_auth_provider(...)`` at app
assembly time. Registration is process-global, idempotent, and replaceable:
passing ``None`` (or omitting a kwarg) leaves that hook at its current binding;
passing a callable replaces it; ``register_auth_provider()`` with no args is a
no-op. Call with the built-in defaults to reset.

The action strings passed to ``authorize`` are a small, free-form-growable
vocabulary the call sites use to name what the caller is trying to do:
``create_task``, ``register_agent``, ``update_agent``, ``verify_task``,
``respond_request``, ``container_control``, ``edit_protocol`` (and more as the
surface grows).
"""

from __future__ import annotations

from typing import Callable, Optional

from fastapi import Request

# --- built-in defaults: today's behavior, unchanged ------------------------


def _default_resolve_actor(
    cur, request: Request, container_id: str, fallback_actor_id: Optional[str]
) -> Optional[str]:
    """Default resolver: the acting agent id IS the explicit fallback the route
    read from the request body. This is precisely the pre-seam behavior — the
    body-supplied ``actor_agent_id`` (or its per-route equivalent) is trusted
    as-is. A downstream override can instead derive the actor from, e.g., a
    verified session cookie or a signed capability token, ignoring the fallback.
    """
    return fallback_actor_id


def _default_authorize(
    cur,
    request: Request,
    actor_agent_id: Optional[str],
    action: str,
    container_id: str,
) -> None:
    """Default authorizer: permit everything. The route's existing
    ``require_kind`` / human-authority checks remain the sole gate under the
    defaults. A downstream override raises ``HTTPException(403)`` to deny.
    """
    return None


# --- process-global active hooks -------------------------------------------

_resolve_actor_hook: Callable[..., Optional[str]] = _default_resolve_actor
_authorize_hook: Callable[..., None] = _default_authorize


# --- public seam surface (called by routes) --------------------------------


def resolve_actor(
    cur, request: Request, container_id: str, fallback_actor_id: Optional[str]
) -> Optional[str]:
    """Return the acting agent id for this request.

    Default: the explicit ``fallback_actor_id`` (today's body-field behavior),
    untouched. Overridden via :func:`register_auth_provider`.
    """
    return _resolve_actor_hook(cur, request, container_id, fallback_actor_id)


def authorize(
    cur,
    request: Request,
    actor_agent_id: Optional[str],
    action: str,
    container_id: str,
) -> None:
    """Authorize ``actor_agent_id`` to perform ``action`` in ``container_id``.

    Raise ``HTTPException(403)`` to deny. Default: permit (the existing per-route
    human-authority checks stay where they are — this hook ADDS a lane).
    """
    return _authorize_hook(cur, request, actor_agent_id, action, container_id)


# --- registration ----------------------------------------------------------


def register_auth_provider(
    *,
    resolve_actor: Optional[Callable[..., Optional[str]]] = None,
    authorize: Optional[Callable[..., None]] = None,
) -> None:
    """Install override hooks at app assembly time.

    Each kwarg left ``None`` keeps that hook at its current binding; supplying a
    callable replaces it. Idempotent and replaceable — call again to swap, or
    call :func:`reset_auth_provider` to restore the built-in defaults.
    """
    global _resolve_actor_hook, _authorize_hook
    if resolve_actor is not None:
        _resolve_actor_hook = resolve_actor
    if authorize is not None:
        _authorize_hook = authorize


def reset_auth_provider() -> None:
    """Restore the built-in defaults (today's behavior). Primarily for tests."""
    global _resolve_actor_hook, _authorize_hook
    _resolve_actor_hook = _default_resolve_actor
    _authorize_hook = _default_authorize
