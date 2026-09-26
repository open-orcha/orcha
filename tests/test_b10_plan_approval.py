"""FT-SURFACE (B10 / G2) — plan-approval portal surface.

B10 lets a human approve (or reject with a reason) an IN-PROGRESS task's PLAN from
the portal, before the agent commits code. It reuses the B0 primitive: the portal
POSTs /api/decisions with subject_type='plan_approval', subject_id=<task_id>,
target=<the plan's author>. So the automatable surface is (a) that exact decision
round-trip — recorded as a decisions row + routed to the assignee with {decision,
reason} — and the reason-less-reject block, and (b) that the tasks page (React:
frontend/src/pages/tasks/TasksPage.tsx, Phase 7) actually mounts the shared control on
the in-progress plan (and the agents page does not — it deep-links instead).
planMessageOf's earliest-agent-post selection is exercised in
frontend/src/state/snapshot.test.ts (Vitest). The live click-through is verified in
the portal and in frontend/src/pages/tasks/TasksPage.test.tsx.
"""
import pathlib
import re
import pytest

pytestmark = pytest.mark.asyncio

from conftest import next_event

REPO = pathlib.Path(__file__).resolve().parent.parent
PORTAL = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal"
FRONTEND = PORTAL / "frontend" / "src"


# ---------- API contract the portal performs ----------

async def test_plan_approval_routes_to_assignee_and_persists(client, make_agent, make_task, db):
    human = await make_agent("Boss", kind="human")
    worker = await make_agent("Worker", kind="ai")
    task = await make_task("build widget", "done when shipped", assignee_alias="Worker")
    assert db.execute("SELECT status FROM tasks WHERE id=%s", (task["id"],))[0]["status"] == "in_progress"

    r = await client.post("/api/decisions", json={
        "subject_type": "plan_approval", "subject_id": task["id"],
        "decision": "approve", "reason": "plan looks right — go",
        "actor_agent_id": human["agent_id"], "target_agent_id": worker["agent_id"],
    })
    assert r.status_code == 201, r.text
    did = r.json()["decision_id"]

    # recorded as an auditable decisions row on THIS task
    row = db.execute("SELECT subject_type, subject_id, decision, reason FROM decisions WHERE id=%s", (did,))[0]
    assert row["subject_type"] == "plan_approval"
    assert row["subject_id"] == task["id"]
    assert row["decision"] == "approve" and row["reason"] == "plan looks right — go"

    # routed to the assignee: it sees {decision, reason} on next wake (skip the task_assigned)
    ev = await next_event(client, worker["agent_id"], since_ts=0, timeout=3)
    while ev["event"] not in ("decision_made", "timeout"):
        ev = await next_event(client, worker["agent_id"], since_ts=ev["ts"], timeout=3)
    assert ev["event"] == "decision_made", ev
    assert ev["subject_type"] == "plan_approval"
    assert ev["subject_id"] == task["id"]
    assert ev["decision"] == "approve"
    assert ev["reason"] == "plan looks right — go"

    # plan approval is advisory routing — it does NOT change task status
    assert db.execute("SELECT status FROM tasks WHERE id=%s", (task["id"],))[0]["status"] == "in_progress"


async def test_plan_reject_requires_reason(client, make_agent, make_task, db):
    human = await make_agent("Boss", kind="human")
    worker = await make_agent("Worker", kind="ai")
    task = await make_task("build widget", "done when shipped", assignee_alias="Worker")
    r = await client.post("/api/decisions", json={
        "subject_type": "plan_approval", "subject_id": task["id"],
        "decision": "reject",  # no reason
        "actor_agent_id": human["agent_id"], "target_agent_id": worker["agent_id"],
    })
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["error"] == "reason_required"
    assert db.execute("SELECT 1 FROM decisions WHERE subject_type='plan_approval'") == []


async def test_plan_reject_with_reason_routes(client, make_agent, make_task, db):
    human = await make_agent("Boss", kind="human")
    worker = await make_agent("Worker", kind="ai")
    task = await make_task("build widget", "done when shipped", assignee_alias="Worker")
    r = await client.post("/api/decisions", json={
        "subject_type": "plan_approval", "subject_id": task["id"],
        "decision": "reject", "reason": "split step 2 out first",
        "actor_agent_id": human["agent_id"], "target_agent_id": worker["agent_id"],
    })
    assert r.status_code == 201, r.text
    ev = await next_event(client, worker["agent_id"], since_ts=0, timeout=3)
    while ev["event"] not in ("decision_made", "timeout"):
        ev = await next_event(client, worker["agent_id"], since_ts=ev["ts"], timeout=3)
    assert ev["event"] == "decision_made" and ev["decision"] == "reject"
    assert ev["reason"] == "split step 2 out first"


# ---------- portal surface guards (React source) ----------

def test_tasks_page_mounts_plan_approval_on_in_progress():
    """Static guard (React port): the tasks page builds the plan from the thread/
    plan_message, gates it on in_progress + an undecided plan_decision (pendingPlan in
    state/SnapshotProvider.tsx), and POSTs the B0 decisions contract with
    subject_type='plan_approval' keyed to the task, routed to the plan author."""
    sp = (FRONTEND / "state" / "SnapshotProvider.tsx").read_text()
    assert "export function planMessageOf" in sp and "export function pendingPlan" in sp, "plan helpers missing"
    # gated on in_progress + no durable decision yet
    assert re.search(r'return\s+t\.status\s*===\s*"in_progress"\s*&&\s*!t\.plan_decision', sp), \
        "plan gate not gated on in_progress + undecided plan_decision"
    html = (FRONTEND / "pages" / "tasks" / "TasksPage.tsx").read_text()
    # POSTs the B0 decisions contract, keyed to the task, routed to the plan author
    assert 'subject_type: "plan_approval"' in html, "wrong subject_type"
    assert "subject_id: t.id" in html, "plan decision must be keyed to the task"
    assert "target_agent_id: author?.id" in html, "decision must route to the plan's author"


def test_plan_card_shows_full_plan_scrollable():
    """Static guard (ISS-32): an approval gate must show the WHOLE plan — the full plan
    message body (no hard truncation) in a scrollable, pre-wrapped region. ISS-44: the
    body renders via the shared esc-first linkifier (Linkified)."""
    html = (FRONTEND / "pages" / "tasks" / "TasksPage.tsx").read_text()
    assert "text={isPlan ? pm?.body" in html, "plan card should render the full message body via Linkified"
    assert "trunc(pm" not in html, "plan body must not be hard-truncated"
    assert "maxHeight: 300, overflowY: \"auto\"" in html and 'whiteSpace: "pre-wrap"' in html, \
        "plan region not scrollable/pre-wrapped"


def test_plan_card_is_one_shot_per_session():
    """Static guard (review P2 / ISS-41): a recorded decision must not resurface. The
    DURABLE plan_decision renders a decided-note (suppressed across reload); a session
    `acted` set suppresses the gate immediately after a decision POSTs (optimistic),
    and a successful decision marks the task acted."""
    html = (FRONTEND / "pages" / "tasks" / "TasksPage.tsx").read_text()
    assert "useState<Set<string>>" in html and "acted" in html, "no optimistic acted cache"
    # a durable plan_decision -> quiet decided-note, never a live re-approve (ISS-41)
    assert 'if (t.status === "in_progress" && t.plan_decision)' in html, \
        "decided plan not gated on the durable plan_decision"
    assert 'Plan {ok ? "approved" : "rejected"}' in html, "no decided-note for a decided plan"
    # acted suppresses the gate immediately; a successful decision marks it acted
    assert "if (acted) return null" in html, "gate not suppressed for a just-acted task"
    assert "onActed(t.id)" in html, "a successful decision doesn't mark the task acted"


def test_agents_page_has_no_plan_surface():
    """B10 is a tasks-page surface only — the agents page renders no task thread, so it
    hosts no plan-approval *control* (it deep-links instead; see ISS-33 below)."""
    html = (FRONTEND / "pages" / "agents" / "AgentsPage.tsx").read_text()
    assert "plan_approval" not in html
    assert "/api/decisions" not in html


def test_agents_page_deeplinks_to_plan_approval():
    """ISS-33 (React port): the Agents view must not dead-end. The gate callout flags an
    in-progress task whose agent posted a plan awaiting sign-off and deep-links to that
    task on the Tasks page (where the B10 control lives). ISS-36: surfaced regardless of
    the agent's status. ISS-41: once plan_decision is set it's a decided-note, not a live
    re-approve."""
    html = (FRONTEND / "pages" / "agents" / "AgentsPage.tsx").read_text()
    m = re.search(r"function GateCallout\(\{ a, mine \}.*?\n\}", html, re.S)
    assert m, "no gate callout"
    block = m.group(0)
    # detect an agent-posted plan on an in-progress task, surfaced regardless of status
    assert "planMessageOf(t)" in block, "doesn't detect an agent-posted plan"
    assert "regardless of" in html, "gate not advertised as decoupled from agent status (ISS-36)"
    # undecided -> approve CTA deep-linking to the Tasks gate; decided -> note (ISS-41)
    assert "!planTask.plan_decision" in block, "approval not gated on the durable plan_decision (ISS-41)"
    assert "Plan awaiting your approval" in block and "Review plan" in block, "no plan-approval call-to-action"
    assert '"/tasks?task="' in block, "no deep-link to the Tasks page"


def test_agents_all_tasks_are_deeplinked():
    """ISS-33 revalidation: the in_progress-only 'Current task' link missed tasks in
    other states, leaving the human dead-ended when an agent had no in-progress task.
    EVERY assigned task — any status — must deep-link to the Tasks page via the
    'All tasks' chips."""
    html = (FRONTEND / "pages" / "agents" / "AgentsPage.tsx").read_text()
    # the All-tasks chips are links pointing at /tasks?task=<id>, built from `mine`
    assert "All tasks ·" in html, "no All-tasks section"
    chips = html[html.index("All tasks ·"):]
    assert 'className="tchip" to={"/tasks?task=" + encodeURIComponent(t.id)}' in chips, \
        "All-tasks chips not deep-linked to the task id"
    # ISS-68 PR-3: the chip list is a paginated render WINDOW over `mine` (load-more
    # reveals the rest; the count is over every assigned task).
    assert "mine.slice(0, tasksShown).map((t) =>" in chips, "All-tasks list isn't built from every assigned task"


# planMessage picks the earliest agent post (and the ISS-68 plan_message
# pass-through): moved to frontend/src/state/snapshot.test.ts (Vitest).
