"""ISS-59 — Approve must carry answers/info to the agent.

The plan-approval Approve action was one-click and sent no message, so a human could not
answer the questions an agent raised in its plan. The decision endpoint already carries an
optional `reason` on approve to the agent (routed to its next wake + posted to the task thread
via ISS-48) — so this is a UI gap: the Approve flow now offers an OPTIONAL answer/info field
whose text is sent as that reason. Reject still requires a reason; verify-complete (a finished
task, no agent waiting) stays a plain confirm.

Frontend-only — no route/body change (the decision endpoint already accepts `reason` on
approve), so the Postman collection is unchanged.
"""
import pathlib
import re

REPO = pathlib.Path(__file__).resolve().parent.parent
STATIC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static"


def test_action_queue_approve_offers_optional_answer():
    home = (STATIC / "home.html").read_text()
    # plan approve is no longer a silent one-click send("") — it opens a modal with an optional answer
    assert 'if (approve) return send("")' not in home, "plan approve still one-click (no answer carried)"
    block = home[home.index("function doPlan"):home.index("function doVerify")]
    assert 'id="ans"' in block and "Answer / additional info for the agent (optional)" in block, "no optional answer field on approve"
    assert "send(v)" in block, "the typed answer isn't sent with the approval"
    # the answer rides as the decision `reason` (carried to the agent server-side)
    assert "reason: reason || undefined" in block, "answer not sent as the decision reason"


def test_task_gate_approve_offers_optional_answer_plan_only():
    tasks = (STATIC / "tasks.html").read_text()
    gate = re.search(r"function wireGate\(gate, t\) \{.*?\n  \}", tasks, re.S).group(0)
    # plan approve gets an optional answer body; verify-complete stays a plain confirm
    assert 'kind === "plan" ?' in gate and "Answer / additional info for the agent (optional)" in gate, "plan approve has no optional answer field"
    assert 'id="ans-' in gate, "no answer textarea id"
    assert "submit(true, el ? (el.value" in gate, "the answer value isn't submitted on approve"
    # reject still requires a reason (unchanged invariant)
    assert "confirm-reject" in gate and "if (!reason) return" in gate, "reject no longer requires a reason"


def test_no_backend_or_postman_change_needed():
    # The decision endpoint already accepts an optional reason on approve + carries it (ISS-48
    # thread post). This issue is UI-only, so neither main.py's contract nor Postman change.
    main = (REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "main.py").read_text()
    assert "reason: optional on approve" in main or "optional on approve" in main, "decision approve-reason contract missing"
    assert "_post_decision_to_thread" in main, "decisions aren't mirrored to the task thread"
