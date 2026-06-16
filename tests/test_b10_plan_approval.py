"""FT-SURFACE (B10 / G2) — plan-approval portal surface.

B10 lets a human approve (or reject with a reason) an IN-PROGRESS task's PLAN from
the portal, before the agent commits code. It reuses the B0 primitive: the portal
POSTs /api/decisions with subject_type='plan_approval', subject_id=<task_id>,
target=<the plan's author>. So the automatable surface is (a) that exact decision
round-trip — recorded as a decisions row + routed to the assignee with {decision,
reason} — and the reason-less-reject block, and (b) that the tasks page actually
mounts the shared control on the in-progress plan (and the agents page does not).
The live click-through is verified in the portal.
"""
import json
import pathlib
import re
import shutil
import subprocess
import pytest

pytestmark = pytest.mark.asyncio

from conftest import next_event

REPO = pathlib.Path(__file__).resolve().parent.parent
STATIC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static"


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


# ---------- portal surface guards ----------

def test_tasks_page_mounts_plan_approval_on_in_progress():
    """Static guard (D4 redesign): tasks.html builds the plan from the thread, gates it on
    in_progress + an undecided plan_decision (pendingPlan), and POSTs the B0 decisions
    contract with subject_type='plan_approval' keyed to the task, routed to the plan author."""
    html = (STATIC / "tasks.html").read_text()
    assert "function planMsgOf" in html and "function pendingPlan" in html, "plan helpers missing"
    # gated on in_progress + no durable decision yet
    assert re.search(r'pendingPlan\(t\)\s*\{\s*return\s*t\.status\s*===\s*"in_progress"\s*&&\s*!t\.plan_decision', html), \
        "plan gate not gated on in_progress + undecided plan_decision"
    # POSTs the B0 decisions contract, keyed to the task, routed to the plan author
    assert 'subject_type: "plan_approval"' in html, "wrong subject_type"
    assert "subject_id: t.id" in html, "plan decision must be keyed to the task"
    assert "target_agent_id: authorId" in html, "decision must route to the plan's author"


def test_plan_card_shows_full_plan_scrollable():
    """Static guard (ISS-32): an approval gate must show the WHOLE plan — the full thread
    message body (no hard truncation) in a scrollable, pre-wrapped region."""
    html = (STATIC / "tasks.html").read_text()
    gate = re.search(r"function gateSurface\(t\) \{.*?\n  \}", html, re.S).group(0)
    # ISS-44: the full body is now rendered via linkify() (esc-first + clickable URLs), not
    # bare esc() — still the WHOLE body, no truncation.
    assert "O.linkify(isPlan ? (pm.body" in gate, "plan card should render the full message body"
    assert "O.trunc(pm.body" not in gate and "slice(0," not in gate, "plan body must not be hard-truncated"
    assert "max-height:300px;overflow-y:auto" in gate and "white-space:pre-wrap" in gate, "plan region not scrollable/pre-wrapped"


def test_plan_card_is_one_shot_per_session():
    """Static guard (review P2 / ISS-41): a recorded decision must not resurface. The
    DURABLE plan_decision renders a decided-note (suppressed across reload); a session
    `acted` Set suppresses the gate immediately after a decision POSTs (optimistic), and
    a successful decision marks the task acted."""
    html = (STATIC / "tasks.html").read_text()
    assert "const acted = new Set()" in html, "no optimistic acted cache"
    gate = re.search(r"function gateSurface\(t\) \{.*?\n  \}", html, re.S).group(0)
    # a durable plan_decision -> quiet decided-note, never a live re-approve (ISS-41)
    assert 'if (t.status === "in_progress" && t.plan_decision)' in gate, "decided plan not gated on the durable plan_decision"
    assert 'Plan ${ok ? "approved" : "rejected"}' in gate, "no decided-note for a decided plan"
    # acted suppresses the gate immediately; a successful decision marks it acted
    assert "if (acted.has(t.id)) return" in gate, "gate not suppressed for a just-acted task"
    assert "acted.add(t.id)" in html, "a successful decision doesn't mark the task acted"


def test_agents_page_has_no_plan_surface():
    """B10 is a tasks-page surface only — the agents page renders no task thread, so it
    hosts no plan-approval *control* (it deep-links instead; see ISS-33 below)."""
    html = (STATIC / "agents.html").read_text()
    assert "renderPlanApprovalCard" not in html
    assert "plan_approval" not in html


def test_agents_page_deeplinks_to_plan_approval():
    """ISS-33 (D3 redesign): the Agents view must not dead-end. The gate callout flags an
    in-progress task whose agent posted a plan awaiting sign-off and deep-links to that
    task on the Tasks page (where the B10 control lives). ISS-36: surfaced regardless of
    the agent's status. ISS-41: once plan_decision is set it's a decided-note, not a live
    re-approve."""
    html = (STATIC / "agents.html").read_text()
    block = re.search(r"function gateCallout\(a, mine\) \{.*?\n  \}", html, re.S).group(0)
    # detect an agent-posted plan on an in-progress task, surfaced regardless of status
    assert "planMsgOf(t)" in block, "doesn't detect an agent-posted plan"
    assert "regardless of" in block, "gate not advertised as decoupled from agent status (ISS-36)"
    # undecided -> approve CTA deep-linking to the Tasks gate; decided -> note (ISS-41)
    assert "!planTask.plan_decision" in block, "approval not gated on the durable plan_decision (ISS-41)"
    assert "Plan awaiting your approval" in block and "Review plan" in block, "no plan-approval call-to-action"
    assert 'href="/tasks?task=' in block, "no deep-link to the Tasks page"


def test_agents_all_tasks_are_deeplinked():
    """ISS-33 revalidation (D3 redesign): the in_progress-only 'Current task' link missed
    tasks in other states, leaving the human dead-ended when an agent had no in-progress
    task. EVERY assigned task — any status — must deep-link to the Tasks page via the
    'All tasks' chips."""
    html = (STATIC / "agents.html").read_text()
    # the All-tasks chips are anchors pointing at /tasks?task=<id>, built from `mine`
    assert "All tasks ·" in html, "no All-tasks section"
    chips = html[html.index("All tasks ·"):]
    assert '<a class="tchip" href="/tasks?task=${encodeURIComponent(t.id)}"' in chips, "All-tasks chips not deep-linked to the task id"
    # ISS-68 PR-3: the chip list is a paginated render WINDOW over `mine` (load-more reveals the
    # rest; the `All tasks · ${mine.length}` count is over every assigned task), so it still maps
    # over `mine` — just sliced to the shown cap.
    assert "mine.slice(0, tasksShown).map((t) =>" in chips, "All-tasks list isn't built from every assigned task"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_plan_message_picks_earliest_agent_post():
    """planMessage = the agent's OPENING plan: the earliest non-human message,
    ignoring human messages and preserving author identity for routing."""
    html = (STATIC / "tasks.html").read_text()
    # ISS-68: planMsgOf is multi-line now (prefers the snapshot's plan_message, thread fallback);
    # match through its own-line closing brace.
    m = re.search(r"function planMsgOf\(t\) \{.*?\n  \}", html, re.S)
    assert m, "planMsgOf not found"
    # planMsgOf reads the mapped thread shape ({is_human, from, body}); earliest non-human
    js = m.group(0) + r"""
const t={thread:[
  {is_human:true,  from:"human", body:"human note"},
  {is_human:false, from:"AG2",   body:"PLAN: do X then Y"},
  {is_human:false, from:"AG2",   body:"progress update"},
]};
const pm=planMsgOf(t);
console.log(JSON.stringify({from:pm&&pm.from, body:pm&&pm.body}));
// no agent messages -> null
console.log(JSON.stringify(planMsgOf({thread:[{is_human:true,from:"human",body:"x"}]})));
// ISS-68: the trimmed snapshot ships plan_message instead of a thread -> used directly
const pm2=planMsgOf({plan_message:{body:"PLAN via summary", author_alias:"AG9", at:"t"}});
console.log(JSON.stringify({from:pm2&&pm2.from, body:pm2&&pm2.body}));
"""
    out = subprocess.run(["node", "-e", js], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    lines = out.stdout.strip().splitlines()
    first = json.loads(lines[0])
    assert first["from"] == "AG2" and first["body"].startswith("PLAN:"), first
    assert json.loads(lines[1]) is None
    # plan_message path: rendered straight from the summary field (no thread present)
    third = json.loads(lines[2])
    assert third["from"] == "AG9" and third["body"] == "PLAN via summary", third
