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
    html = "".join((FRONTEND / "pages" / "tasks" / f).read_text() for f in ("TasksPage.tsx", "TaskDetail.tsx"))
    # POSTs the B0 decisions contract, keyed to the task, routed to the plan author
    assert 'subject_type: "plan_approval"' in html, "wrong subject_type"
    assert "subject_id: t.id" in html, "plan decision must be keyed to the task"
    assert "target_agent_id: author?.id" in html, "decision must route to the plan's author"


def test_plan_card_shows_full_plan_scrollable():
    """Static guard (ISS-32): an approval gate must show the WHOLE plan — the full plan
    message body (no hard truncation) in a scrollable, pre-wrapped region. ISS-44: the
    body renders via the shared esc-first linkifier (Linkified)."""
    html = "".join((FRONTEND / "pages" / "tasks" / f).read_text() for f in ("TasksPage.tsx", "TaskDetail.tsx"))
    # V2 screen-quality round: the full plan body renders as markdown (<Md>, which runs
    # the esc-first linkifier via mdText) inside ClampedMd — a long plan is visually
    # clamped with a "Show full plan" toggle, never truncated in the data.
    # Linear round 3: the gate card already carries the "Plan" heading, so a LEADING
    # "## Plan" heading line is dropped (stripPlanHeading) — presentation only; every
    # line of the plan itself still renders (behaviorally pinned below).
    assert re.search(r'<ClampedMd text=\{stripPlanHeading\(pm\?\.body \|\| ""\)\}[^>]*what="plan"', html), \
        "plan card should render the full message body"
    assert "trunc(pm" not in html, "plan body must not be hard-truncated"
    m = re.search(r"function stripPlanHeading\(body: string\): string \{\s*return body\.replace\(/(.*?)/(\w*), \"\"\);\s*\}", html)
    assert m, "stripPlanHeading must be a single anchored replace of a leading heading"
    pat = re.compile(m.group(1), re.I if "i" in m.group(2) else 0)
    assert "g" not in m.group(2) and "m" not in m.group(2), "heading strip must only touch the very start"
    plan = "## Plan\n1. Add the route\n2. Test it\n" + "\n".join(f"step {i}" for i in range(40))
    out = pat.sub("", plan, count=1)
    assert out == plan[len("## Plan\n"):], "only the leading heading line may be dropped"
    for body in ("1. Add the route\n## Plan\nmore", "Plan: do X then Y", "The plan is simple"):
        assert pat.sub("", body, count=1) == body, f"non-heading plan text was altered: {body!r}"
    m = re.search(r"function ClampedMd\(.*?\n\}", html, re.S)
    assert m, "no ClampedMd"
    assert '<Md className="wk-md" text={text}' in m.group(0), "ClampedMd must render the whole text"
    assert '"Show full " + what' in m.group(0) and "aria-expanded={open}" in m.group(0), \
        "long plans must be expandable to their full length"


def test_plan_card_is_one_shot_per_session():
    """Static guard (review P2 / ISS-41): a recorded decision must not resurface. The
    DURABLE plan_decision renders a decided-note (suppressed across reload); a session
    `acted` set suppresses the gate immediately after a decision POSTs (optimistic),
    and a successful decision marks the task acted."""
    html = "".join((FRONTEND / "pages" / "tasks" / f).read_text() for f in ("TasksPage.tsx", "TaskDetail.tsx"))
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
    m = re.search(r"function GateCallout\(\{ a, mine(?:, \w+)* \}.*?\n\}", html, re.S)
    assert m, "no gate callout"
    block = m.group(0)
    # detect an agent-posted plan on an in-progress task, surfaced regardless of status.
    # Parity r2: the plan pick moved into the exported pickGatePlan() (newest undecided
    # plan first, then verification, then the latest decision) which GateCallout calls.
    pick = re.search(r"export function pickGatePlan\(.*?\n\}", html, re.S)
    assert pick and "planMessageOf(t)" in pick.group(0), "doesn't detect an agent-posted plan"
    assert "pickGatePlan(" in block, "gate callout doesn't use the shared plan pick"
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
    # V2 (Agent E): the chips became rows in the agent workspace's Tasks tab.
    # Linear round 3 (D12): the tab splits `mine` into "Needs you" (waiting), "Active"
    # (current) and "Other tasks"/"All tasks" (rest); all three render through the same
    # deep-linked taskRow, and the count over every assigned task moved from the
    # toolbar to the tab label ("Tasks N").
    assert '<TabPanel tabKey="tasks"' in html, "no Tasks tab"
    tab = html[html.index('<TabPanel tabKey="tasks"'):]
    tab = tab[:tab.index("</TabPanel>")]
    assert 'count: k === "tasks" ? mine.length' in html, "All-tasks count isn't over every assigned task"
    # the three groups PARTITION `mine` — nothing assigned can fall through the cracks
    assert "const waiting = mine.filter(" in html and "const current = mine.filter(" in html, \
        "task groups not derived from every assigned task"
    assert "const rest = mine.filter((t) => waiting.indexOf(t) < 0 && current.indexOf(t) < 0);" in html, \
        "the rest group must hold every assigned task not already grouped"
    assert '"All tasks"' in tab, "no All-tasks group"
    assert 'className="ag-trow" to={"/tasks?task=" + encodeURIComponent(t.id)}' in html, \
        "task rows not deep-linked to the task id"
    assert "{waiting.map(taskRow)}" in tab and "{current.map(taskRow)}" in tab \
        and "rest.slice(0, tasksShown).map(taskRow)" in tab, \
        "task groups aren't rendered through the deep-linked row"
    # ISS-68 PR-3: a paginated render WINDOW (load-more reveals the rest).
    assert "setTasksShown((n) => n + TASKS_CAP)" in tab, "no load-more over the remaining tasks"


# planMessage picks the earliest agent post (and the ISS-68 plan_message
# pass-through): moved to frontend/src/state/snapshot.test.ts (Vitest).
