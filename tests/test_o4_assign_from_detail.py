"""O4 — assign-task-from-detail + wake (frontend surface over Forge's B5 endpoint).

The task detail gains a human-authority "Assignment" control: pick an agent → confirm →
POST /api/tasks/{tid}/assign (Forge B5) → B5 wakes the assignee. Copy + behaviour match
B5's reassign-behind-a-flag policy: a plain assign when the task is free, a release-and-
reassign confirm (reassign=true) when someone else is already on it, and the 409
"different active assignee" race is upgraded to a reassign confirm.

Frontend-only — calls B5's existing route, no new endpoint → Postman owned by the B5 PR.
"""
import pathlib
import re
import shutil
import subprocess
import pytest

REPO = pathlib.Path(__file__).resolve().parent.parent
STATIC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static"


def _inline_js(html: str) -> str:
    return "\n".join(re.findall(r"<script>(.*?)</script>", html, re.S))


def test_o4_assign_surface_wired_into_task_detail():
    html = (STATIC / "tasks.html").read_text()
    # the surface + its handlers exist and are mounted in the detail render
    assert "function assignSurface(t)" in html, "no assignSurface"
    assert "html += assignSurface(t);" in html, "assignSurface not rendered in the detail"
    assert "function doAssign(t)" in html and "function postAssign(" in html, "assign handlers missing"
    assert 'data-act="assign"' in html and "doAssign(t)" in html, "assign button not wired"

    # B5 contract: POST /api/tasks/{tid}/assign with {actor_agent_id, agent_id, reassign}
    assert '"/api/tasks/" + encodeURIComponent(t.id) + "/assign"' in html, "wrong assign route"
    assert "actor_agent_id: actorId" in html and "agent_id: agentId" in html and "reassign: reassign" in html, \
        "assign body doesn't match B5 contract"

    # hidden where B5 would 409 (root + finished tasks) and when there are no AI agents
    assert '["completed", "needs_verification", "cancelled"]' in html, "doesn't hide on finished tasks"
    assert "t.is_root" in html and "x.kind === \"ai\"" in html, "doesn't gate root / filter AI agents"

    # acting human required (B5 403s a non-human actor)
    assert "actorOrWarn()" in html, "doesn't resolve the acting human"


def test_o4_lets_the_endpoint_be_the_authority_on_assignment_state():
    html = (STATIC / "tasks.html").read_text()
    # review P2: the snapshot's single display alias (assignees[0]) is NOT authoritative
    # (stale / can't see multiple active assignees), so we must NOT short-circuit client-side.
    assert "is already assigned" not in html, "must not short-circuit same-assignee from stale state"
    # the first action always POSTs (reassign=false); B5 decides idempotency/races/multi-prior.
    assert "postAssign(t, h.id, agentId, alias, false)" in html, "doesn't always POST first"
    assert "This wakes them to start the task." in html, "no plain-assign confirm copy"
    # the reassign flow is driven REACTIVELY by B5's 409, not a client pre-decision
    assert "different active assignee" in html and "postAssign(t, actorId, agentId, alias, true)" in html, \
        "409 not upgraded to a reassign confirm"
    assert "They'll be released." in html, "no reassign confirm copy"
    # response surfaces woke / pending / released_prior from B5's payload
    assert "d.woke" in html and 'd.status === "pending"' in html and "d.released_prior" in html, \
        "doesn't surface B5's woke/pending/released_prior"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to check client JS")
def test_tasks_inline_js_is_syntactically_valid():
    js = _inline_js((STATIC / "tasks.html").read_text())
    out = subprocess.run(["node", "--check", "-"], input=js, capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
