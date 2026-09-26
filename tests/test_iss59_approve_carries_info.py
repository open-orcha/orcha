"""ISS-59 — Approve must carry answers/info to the agent.

The plan-approval Approve action was one-click and sent no message, so a human could not
answer the questions an agent raised in its plan. The decision endpoint already carries an
optional `reason` on approve to the agent (routed to its next wake + posted to the task thread
via ISS-48) — so this is a UI gap: the Approve flow offers an OPTIONAL answer/info field
whose text is sent as that reason. Reject still requires a reason; verify-complete (a finished
task, no agent waiting) stays a plain confirm.

MIGRATED (portal React migration Phase 7): the vanilla static/{home,tasks}.html greps are
repointed at the React SOURCE (HomePage.tsx / TasksPage.tsx). The backend contract check
on main.py is unchanged.
"""
import pathlib

REPO = pathlib.Path(__file__).resolve().parent.parent
PORTAL = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal"
SRC = PORTAL / "frontend" / "src"


def test_action_queue_approve_offers_optional_answer():
    home = (SRC / "pages" / "home" / "HomePage.tsx").read_text()
    # plan approve is no longer a silent one-click send — it opens a modal with an
    # optional answer field first (setApproveFor -> Modal -> sendPlanDecision)
    assert "setApproveFor({ taskId: t.id, authorId })" in home, "plan approve doesn't route through the answer modal"
    assert 'id="ans"' in home and "Answer / additional info for the agent (optional)" in home, \
        "no optional answer field on approve"
    assert "sendPlanDecision(p.taskId, p.authorId, true, answer)" in home, "the typed answer isn't sent with the approval"
    # the answer rides as the decision `reason` (carried to the agent server-side)
    assert "reason: reason || undefined" in home, "answer not sent as the decision reason"


def test_task_gate_approve_offers_optional_answer_plan_only():
    tasks = (SRC / "pages" / "tasks" / "TasksPage.tsx").read_text()
    # plan approve gets an optional answer body; verify-complete stays a plain confirm
    assert "Answer / additional info for the agent (optional)" in tasks, "plan approve has no optional answer field"
    assert 'id={"ans-" + t.id}' in tasks, "no answer textarea id"
    # the answer is submitted ONLY on a plan approve (verify stays a plain confirm)
    assert 'submit(true, isPlan ? answer : "")' in tasks, "the answer value isn't submitted on approve (plan-only)"
    # reject still requires a reason (unchanged invariant)
    assert 'data-act="confirm-reject"' in tasks and "if (!r) return" in tasks, "reject no longer requires a reason"


def test_no_backend_or_postman_change_needed():
    # The decision endpoint already accepts an optional reason on approve + carries it (ISS-48
    # thread post). This issue is UI-only, so main.py's contract doesn't change.
    main = (PORTAL / "main.py").read_text()
    assert "reason: optional on approve" in main or "optional on approve" in main, "decision approve-reason contract missing"
    assert "_post_decision_to_thread" in main, "decisions aren't mirrored to the task thread"
