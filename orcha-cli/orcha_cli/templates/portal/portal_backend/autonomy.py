"""The single source of truth for an agent's EFFECTIVE autonomy level.

#298 gave a container ONE engine-enforced autonomy level (containers.autonomy_level, mig 021)
driving the ONE hard gate — task completion. PER-AGENT OVERRIDES (mig 034) let a trusted agent
be handed a different level WITHOUT moving the whole container, and a container-wide `enforced`
switch lets an operator ignore every override at once. Both are expressed by the ONE rule below,
which EVERY consumer of the autonomy level MUST route through so the gate can never diverge from
what the portal shows:

    effective = container.autonomy_level              if container.autonomy_enforced
              else (agent.autonomy_override or container.autonomy_level)

Safety framing (unchanged by this file): the effective level can only ever be one of the SAME
three enum values the container level already allows; an override can never widen a container past
what its own slider could grant everyone, and the needs_verification floor + human merge authority
are untouched. NULL override = inherit.
"""

from __future__ import annotations

from typing import Optional

AUTONOMY_LEVELS = ("plan", "pr", "full")


def effective_autonomy(
    container_level: str,
    autonomy_enforced: bool,
    agent_override: Optional[str],
) -> str:
    """Resolve the autonomy level that GOVERNS one agent.

    * container_level    — containers.autonomy_level ('plan'|'pr'|'full'), the #298 slider.
    * autonomy_enforced  — containers.autonomy_enforced; when true, overrides are IGNORED.
    * agent_override     — agents.autonomy_override (None = inherit the container level).

    Returns the effective enum value. Enforced wins (container level for everyone); otherwise a
    non-NULL override wins over the container level; otherwise the container level (inherit).
    """
    if autonomy_enforced:
        return container_level
    if agent_override:
        return agent_override
    return container_level
