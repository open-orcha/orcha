"""O4 — assign-task-from-detail + wake (frontend surface over Forge's B5 endpoint).

The task detail has a human-authority "Assignment" control: pick an agent → confirm →
POST /api/tasks/{tid}/assign (Forge B5) → B5 wakes the assignee. Copy + behaviour match
B5's reassign-behind-a-flag policy: a plain assign when the task is free, a release-and-
reassign confirm (reassign=true) when someone else is already on it, and the 409
"different active assignee" race is upgraded to a reassign confirm.

Frontend-only — calls B5's existing route, no new endpoint.

MIGRATED (portal React migration Phase 7): the vanilla static/tasks.html greps are
repointed at the React SOURCE (TasksPage.tsx AssignSurface). The node --check
syntax-validity test was retired: the frontend is TypeScript, compiled by
`tsc --noEmit` in the frontend build/test pipeline, which subsumes it.
"""
import pathlib

REPO = pathlib.Path(__file__).resolve().parent.parent
SRC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "frontend" / "src"


def _tasks_src() -> str:
    return (SRC / "pages" / "tasks" / "TasksPage.tsx").read_text()


def test_o4_assign_surface_wired_into_task_detail():
    src = _tasks_src()
    # the surface + its handlers exist and are mounted in the detail render
    assert "function AssignSurface" in src, "no AssignSurface"
    assert "<AssignSurface" in src, "AssignSurface not rendered in the detail"
    assert "const doAssign" in src and "const postAssign" in src, "assign handlers missing"
    assert 'data-act="assign"' in src and "onClick={doAssign}" in src, "assign button not wired"

    # B5 contract: POST /api/tasks/{tid}/assign with {actor_agent_id, agent_id, reassign}
    assert '"/api/tasks/" + encodeURIComponent(t.id) + "/assign"' in src, "wrong assign route"
    assert "actor_agent_id: h.id" in src and "agent_id: agentId" in src and "reassign," in src, \
        "assign body doesn't match B5 contract"

    # hidden where B5 would 409 (root + finished tasks) and when there are no AI agents
    assert '["completed", "needs_verification", "cancelled"]' in src, "doesn't hide on finished tasks"
    assert "t.is_root" in src and 'a.kind === "ai"' in src, "doesn't gate root / filter AI agents"

    # acting human required (B5 403s a non-human actor)
    assert "actingHuman(snap)" in src, "doesn't resolve the acting human"


def test_o4_lets_the_endpoint_be_the_authority_on_assignment_state():
    src = _tasks_src()
    # review P2: the snapshot's single display alias (assignees[0]) is NOT authoritative
    # (stale / can't see multiple active assignees), so we must NOT short-circuit client-side.
    assert "is already assigned" not in src, "must not short-circuit same-assignee from stale state"
    # the first action always POSTs (reassign=false); B5 decides idempotency/races/multi-prior.
    assert "setConfirm({ reassign: false, agentId: selAgent" in src, "doesn't always POST first (reassign=false)"
    assert "This wakes them to start the task." in src, "no plain-assign confirm copy"
    # the reassign flow is driven REACTIVELY by B5's 409, not a client pre-decision
    assert "different active assignee" in src and "setConfirm({ reassign: true, agentId, alias })" in src, \
        "409 not upgraded to a reassign confirm"
    assert "They'll be released." in src, "no reassign confirm copy"
    # response surfaces woke / pending / released_prior from B5's payload
    assert "d.woke" in src and 'd.status === "pending"' in src and "d.released_prior" in src, \
        "doesn't surface B5's woke/pending/released_prior"
