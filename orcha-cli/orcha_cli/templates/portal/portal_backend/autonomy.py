"""Resolve retired project/agent autonomy values for compatibility displays only.

Task ``autonomy`` is the only approval authority. Nothing in this module may gate plan approval,
work admission, completion, workflow acceptance, Git actions, or worker scheduling. The legacy
columns remain readable during the migration window so older snapshots and history views do not
break. Their historical projection was:

    effective = container.autonomy_level              if container.autonomy_enforced
              else (agent.autonomy_override or container.autonomy_level)

NULL override means inherit. This result is informational and grants no permission.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

AUTONOMY_LEVELS = ("plan", "pr", "full")


def effective_autonomy(
    container_level: str,
    autonomy_enforced: bool,
    agent_override: Optional[str],
) -> str:
    """Resolve one legacy display value; never use it as authority.

    * container_level    — retained containers.autonomy_level history.
    * autonomy_enforced  — containers.autonomy_enforced; when true, overrides are IGNORED.
    * agent_override     — agents.autonomy_override (None = inherit the container level).

    Enforced wins for historical display; otherwise a non-NULL override wins over the retained
    container value. The return value grants no current permission.
    """
    if autonomy_enforced:
        return container_level
    if agent_override:
        return agent_override
    return container_level


def effective_autonomy_for(
    container_row: Mapping[str, Any],
    agent_row: Optional[Mapping[str, Any]],
) -> str:
    """Row-oriented compatibility wrapper over ``effective_autonomy``.

    ``container_row`` must expose ``autonomy_level`` and ``autonomy_enforced``; ``agent_row`` (may
    be None for a container-only context) may expose ``autonomy_override``. Missing keys degrade to
    the safe inherit-semantics (container level, overrides applied) so a partial SELECT never crashes
    the gate.
    """
    container_level = container_row["autonomy_level"]
    autonomy_enforced = bool(container_row.get("autonomy_enforced", False))
    agent_override = agent_row.get("autonomy_override") if agent_row else None
    return effective_autonomy(container_level, autonomy_enforced, agent_override)
