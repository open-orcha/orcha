"""O4 — assign-task-from-detail + wake (frontend surface over Forge's B5 endpoint).

The task detail has a human-authority "Assignment" control: pick an agent → confirm →
POST /api/tasks/{tid}/assign (Forge B5) → B5 wakes the assignee. Copy + behaviour match
B5's reassign-behind-a-flag policy: a plain assign when the task is free, a release-and-
reassign confirm (reassign=true) when someone else is already on it, and the 409
"different active assignee" race is upgraded to a reassign confirm.

Frontend-only — calls B5's existing route, no new endpoint.

MIGRATED (portal React migration Phase 7): the vanilla static/tasks.html greps are
repointed at the React SOURCE (TaskDetail.tsx AssignControl; formerly AssignSurface). The node --check
syntax-validity test was retired: the frontend is TypeScript, compiled by
`tsc --noEmit` in the frontend build/test pipeline, which subsumes it.
"""
import pathlib

REPO = pathlib.Path(__file__).resolve().parent.parent
SRC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "frontend" / "src"


def _tasks_src() -> str:
    return "".join((SRC / "pages" / "tasks" / f).read_text() for f in ("TasksPage.tsx", "TaskDetail.tsx"))


def test_o4_assign_surface_wired_into_task_detail():
    src = _tasks_src()
    # Linear round 3 (D10/D12): the separate AssignSurface block became AssignControl —
    # the Assignee VALUE itself (rail in full view, meta line in the inspector) opens the
    # agent picker. Same contract: picker → confirm → POST B5.
    assert "function AssignControl" in src, "no AssignControl"
    assert "<AssignControl" in src, "AssignControl not rendered in the detail"
    assert "const pickAgent" in src and "const postAssign" in src, "assign handlers missing"
    assert 'data-act="assign"' in src and "onClick={openPicker}" in src, "assign button not wired"
    assert "onPick={pickAgent}" in src, "agent picker not wired to the assign confirm"

    # B5 contract: POST /api/tasks/{tid}/assign with {actor_agent_id, agent_id, reassign}
    assert '"/api/tasks/" + encodeURIComponent(t.id) + "/assign"' in src, "wrong assign route"
    assert "actor_agent_id: h.id" in src and "agent_id: agentId" in src and "reassign," in src, \
        "assign body doesn't match B5 contract"

    # hidden where B5 would 409 (root + finished tasks) and when there are no AI agents
    assert '["completed", "needs_verification", "cancelled"]' in src, "doesn't hide on finished tasks"
    assert "t.is_root" in src and 'a.kind === "ai"' in src, "doesn't gate root / filter AI agents"
    assert "if (!canAssign(t, snap)) return <>{children}</>;" in src, \
        "assign control not hidden where B5 would 409"

    # acting human required (B5 403s a non-human actor)
    assert "actingHuman(snap)" in src, "doesn't resolve the acting human"


def test_o4_lets_the_endpoint_be_the_authority_on_assignment_state():
    src = _tasks_src()
    # review P2: the snapshot's single display alias (assignees[0]) is NOT authoritative
    # (stale / can't see multiple active assignees), so we must NOT short-circuit client-side.
    assert "is already assigned" not in src, "must not short-circuit same-assignee from stale state"
    # TG-20: a KNOWN different assignee pre-selects reassign (one confirm, not a guaranteed
    # 409 + second confirm); an unassigned / same-assignee pick POSTs reassign=false and
    # B5 stays the authority on idempotency / races / multi-prior (409 fallback below).
    assert "setConfirm({ reassign: !!cur && cur !== ai.alias, agentId, alias: ai.alias })" in src, \
        "reassign not derived from the known assignee (TG-20)"
    assert "status === 409 && !reassign" in src and "setConfirm({ reassign: true, agentId, alias })" in src, \
        "stale-snapshot 409 no longer drives the reassign confirm"
    assert "void postAssign(c.agentId, c.alias, c.reassign)" in src, "confirm doesn't POST the chosen reassign flag"
    assert "This wakes them to start the task." in src, "no plain-assign confirm copy"
    # the reassign flow is driven REACTIVELY by B5's 409, not a client pre-decision
    assert "different active assignee" in src and "setConfirm({ reassign: true, agentId, alias })" in src, \
        "409 not upgraded to a reassign confirm"
    assert "They'll be released." in src, "no reassign confirm copy"
    # response surfaces woke / pending / released_prior from B5's payload
    assert "d.woke" in src and 'd.status === "pending"' in src and "d.released_prior" in src, \
        "doesn't surface B5's woke/pending/released_prior"
