"""Validation and repair of model-proposed onboarding rosters."""

from typing import Any

from portal_backend.limits import MAX_DOD_LEN, MAX_NAME_LEN, MAX_PROMPT_LEN
from portal_backend.model_policy import MODEL_IDS as _MODEL_IDS
from portal_backend.protocol_helpers import _clean_protocol


def _normalize_roster_payload(raw: Any) -> dict:
    """Validate and repair the model's propose_roster payload into the exact UI-safe shape."""
    if not isinstance(raw, dict):
        raise ValueError("propose_roster payload must be an object")
    agents = []
    seen_names: set[str] = set()
    for item in raw.get("agents") or []:
        if not isinstance(item, dict):
            raise ValueError("agents must be objects")
        name = str(item.get("name") or "").strip()
        role = str(item.get("role") or "").strip()
        charter = str(item.get("charter") or "").strip()
        if not name or not role or not charter:
            raise ValueError("agent name, role, and charter are required")
        if name in seen_names:
            raise ValueError(f"duplicate agent name '{name}'")
        seen_names.add(name)
        hint = item.get("model_hint")
        agents.append(
            {
                "name": name,
                "role": role[:200],
                "charter": charter[:MAX_PROMPT_LEN],
                "model_hint": hint if hint in _MODEL_IDS else None,
            }
        )
    if not agents:
        raise ValueError("at least one agent is required")

    tasks = []
    seen_titles: set[str] = set()
    kickoff_by_assignee: dict[str, list[int]] = {}
    tasks_by_assignee: dict[str, list[int]] = {}
    for item in raw.get("tasks") or []:
        if not isinstance(item, dict):
            raise ValueError("tasks must be objects")
        title = str(item.get("title") or "").strip()
        dod = str(item.get("definition_of_done") or "").strip()
        if not title or not dod:
            raise ValueError("task title and definition_of_done are required")
        assignee = item.get("assignee")
        assignee = (
            str(assignee).strip()
            if assignee is not None and str(assignee).strip()
            else None
        )
        if assignee is not None and assignee not in seen_names:
            raise ValueError(f"task assignee '{assignee}' is not a proposed agent")
        deps = []
        for dep in item.get("depends_on") or []:
            dep_title = str(dep or "").strip()
            if dep_title in seen_titles:
                deps.append(dep_title)
        is_kickoff = bool(item.get("is_kickoff"))
        if is_kickoff and not assignee:
            is_kickoff = False
        if assignee:
            tasks_by_assignee.setdefault(assignee, []).append(len(tasks))
            if is_kickoff:
                kickoff_by_assignee.setdefault(assignee, []).append(len(tasks))
        tasks.append(
            {
                "title": title[:MAX_NAME_LEN],
                "definition_of_done": dod[:MAX_DOD_LEN],
                "assignee": assignee,
                "depends_on": deps,
                "protocol": _clean_protocol(item.get("protocol")),
                "is_kickoff": is_kickoff,
            }
        )
        seen_titles.add(title)
    if not tasks:
        raise ValueError("at least one task is required")
    for assignee, indexes in tasks_by_assignee.items():
        kickoffs = kickoff_by_assignee.get(assignee, [])
        if not kickoffs:
            tasks[indexes[0]]["is_kickoff"] = True
        elif len(kickoffs) > 1:
            for idx in kickoffs[1:]:
                tasks[idx]["is_kickoff"] = False

    return {
        "rationale": str(raw.get("rationale") or "").strip(),
        "agents": agents,
        "tasks": tasks,
    }
