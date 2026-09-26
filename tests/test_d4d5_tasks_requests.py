"""FT-SURFACE (D4 + D5 + ISS-53) — Tasks & Requests pages + typing-surface safety.

The vanilla tasks.html / requests.html are retired by the React migration (Phase 7):
the pages are frontend/src/pages/tasks/TasksPage.tsx and
frontend/src/pages/requests/RequestsPage.tsx, served as the SPA shell (static/dist/)
at GET /tasks and GET /requests. ISS-46/ISS-53 (the 3s repaint clobbering scroll /
selection / a half-typed reject reason) are solved ARCHITECTURALLY in React: drafts
live in React state (controlled inputs), so the snapshot poll can never wipe typing —
the Orcha.patch primitive and its node harness are retired. The interaction flows are
covered functionally in the frontend Vitest suite
(frontend/src/pages/tasks/TasksPage.test.tsx, frontend/src/pages/requests/
RequestsPage.test.tsx); this file keeps the wiring + gating guards.
"""
import pathlib
import pytest

pytestmark = pytest.mark.asyncio

REPO = pathlib.Path(__file__).resolve().parent.parent
PORTAL = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal"
FRONTEND = PORTAL / "frontend" / "src"


def _tasks() -> str:
    return (FRONTEND / "pages" / "tasks" / "TasksPage.tsx").read_text()


def _requests() -> str:
    return (FRONTEND / "pages" / "requests" / "RequestsPage.tsx").read_text()


# ---------- ISS-53: typing surfaces survive the 3s repaint ----------
# Retired as a runtime harness: React controlled inputs hold drafts in component
# state, so a repaint re-renders the SAME draft instead of wiping the DOM. The
# typed-reason flow (open reject → type → submit) is exercised end-to-end in
# frontend/src/pages/tasks/TasksPage.test.tsx ("reject demands a typed reason…")
# and frontend/src/pages/home/HomePage.test.tsx.

def test_drafts_live_in_react_state_not_dom():
    """The ISS-53-protected typing surfaces are controlled inputs (value= + state),
    never uncontrolled DOM the repaint could clobber."""
    tasks = _tasks()
    reqs = _requests()
    assert 'value={reason}' in tasks, "reject reason is not a controlled input"
    assert 'value={text}' in tasks, "reply composer is not a controlled input"
    assert 'value={ansDraft}' in reqs, "inline answer is not a controlled input"


# ---------- D4: tasks page ----------

async def test_tasks_serves_the_spa_shell(client):
    r = await client.get("/tasks")
    assert r.status_code == 200, r.text
    assert "text/html" in r.headers.get("content-type", "")
    assert 'id="root"' in r.text and "/assets/dist/" in r.text, "tasks doesn't serve the SPA shell"


def test_tasks_static_guards():
    html = _tasks()
    # no *.html deeplinks; agent deeplinks on served routes
    for bad in ('href="agents.html', 'href="tasks.html', "'agents.html"):
        assert bad not in html, f"tasks links to a *.html route: {bad}"
    # the gate POSTs the real endpoints; plan-approval is gated on the durable plan_decision (ISS-41)
    assert "/api/decisions" in html and 'subject_type: "plan_approval"' in html, "plan approval not via the B0 contract"
    assert "/verify" in html and "/messages" in html, "verify / reply not wired"
    assert "/cancel" in html, "B7 close-task not wired"
    sp = (FRONTEND / "state" / "SnapshotProvider.tsx").read_text()
    assert "!t.plan_decision" in sp, "plan gate not gated on the durable plan_decision"
    # the reject-reason + reply inputs are the protected typing surfaces
    assert '"rt-" + t.id' in html and 'id="reply"' in html, "no reject-reason / reply inputs"
    # runs via the shared engine, fetched per task
    assert "useRunStream" in html and "FilesChanged" in html, "runs don't use the shared engine"
    assert '"/api/tasks/" + encodeURIComponent(tid) + "/runs"' in html, "runs not fetched per task"


# ---------- D5: requests page ----------

async def test_requests_serves_the_spa_shell(client):
    r = await client.get("/requests")
    assert r.status_code == 200, r.text
    assert "text/html" in r.headers.get("content-type", "")
    assert 'id="root"' in r.text and "/assets/dist/" in r.text, "requests doesn't serve the SPA shell"


def test_requests_static_guards():
    html = _requests()
    for bad in ('href="agents.html', 'href="requests.html', "'requests.html"):
        assert bad not in html, f"requests links to a *.html route: {bad}"
    # the request chain is walkable
    assert "chainSeq" in html and "in_service_of" in html, "no walkable request chain"
    # all four arbitration actions wire the REAL endpoints
    assert "/respond" in html and "/convert-to-task" in html and "/escalate" in html and "/close" in html, \
        "request actions not fully wired"
    # actions are gated on the acting human's ROLE (respond=target, convert/escalate=requester)
    assert "isTarget" in html and "isRequester" in html, "actions not gated on the human's role (would 403)"
    # convert requires a definition of done (the endpoint mandates it)
    assert "definition_of_done: dod" in html, "convert-to-task doesn't send a definition of done"
    # the inline answer box is the protected typing surface; deeplinks on served routes
    assert 'id="ansIn"' in html, "no inline answer input (ISS-53 surface)"
    assert '"/agents?agent="' in html, "agent deeplinks not on the served route"


def test_review_p1_fixes():
    """PR #114 review (3x P1), preserved by the React port:
    A) human thread comments are ATTRIBUTED with the acting human's id (#271) and
       require an acting human before posting.
    B) every successful submit clears its input before re-render (stale controls /
       double-submit).
    C) every task status stays visible in the list (pending/failed have buckets + a
       catch-all)."""
    tasks = _tasks()
    reqs = _requests()
    # A (#271): the reply POST attributes the acting human and gates on one being selected.
    assert "author_agent_id: h.id" in tasks, \
        "human comment must be attributed with the acting human's id (#271)"
    assert "Pick an acting human" in tasks, "reply must require an acting human before posting (#271)"
    # B: success paths clear the submitted input state before the next render
    assert 'setReason("");' in tasks, "gate/close reject doesn't clear the reason after success"
    assert 'setText("");' in tasks, "reply doesn't clear its input after success"
    assert 'setAnsDraft("");' in reqs, "answer doesn't clear the inline box after success"
    # C: pending + failed have buckets, and a catch-all renders any other status
    assert '{ k: "pending"' in tasks and '{ k: "failed"' in tasks, "pending/failed tasks have no list bucket"
    assert "!grouped.has(" in tasks, "no catch-all — a task with an unexpected status would vanish"


def test_review_p2_fixes():
    """PR #114 re-review (2x P2 on the requests page), preserved by the React port:
    A) cancelling the inline answer editor clears the draft state (the editor can't
       stay stuck open with stale text).
    B) human-target detection uses the SHARED isToHuman (resolves any human by id),
       not a first-human shortcut that misses non-first humans in a multi-human
       container."""
    reqs = _requests()
    # A: cancel-answer clears the draft and closes the editor
    idx = reqs.index('act === "cancel-answer"')
    cancel = reqs[idx:idx + 200]
    assert 'setAnsDraft("")' in cancel and "setAnswering(false)" in cancel, \
        "cancel-answer doesn't clear the draft before the next render"
    # B: delegates to the shared detector; no first-human shortcut
    assert "isToHuman(snap, r)" in reqs, "doesn't use the shared human-target detector"
    assert "humans(snap)[0]" not in reqs and "humans()[0]" not in reqs, \
        "still uses the first-human shortcut (misses non-first humans)"
