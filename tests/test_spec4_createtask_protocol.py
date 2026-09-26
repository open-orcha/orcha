"""SPEC-4 — Create-Task UI + per-task Protocol panel (frontend, task d05ca75c).

Part A: a human-gated "New Task" form on the tasks page POSTing to the existing
POST /api/containers/{cid}/tasks. Part B: a collapsible protocol panel on task detail
(4 rows review_chain/handoff_to/autonomy/notes + linkified notes, header chips,
human-only Edit -> PATCH /api/tasks/{tid}/protocol, empty/read-only states, autonomy
free-text).

Phase 7: the vanilla static/{tasks.html,data.js} surface is retired; the React port is
frontend/src/pages/tasks/TasksPage.tsx (ProtocolPanel + NewTaskModal) with the data
adapter in frontend/src/api/client.ts. The node harness that eval'd protoEmpty moved to
Vitest, exercising the truth table BEHAVIORALLY against the real page (plus the PATCH
body and the create-form validation): frontend/src/pages/tasks/TasksPage.spec4.test.tsx.
The wiring + placement (mutation teeth: protocol sits between gate and assignment) and
the human-authority gating are asserted on the React source below.
"""
import pathlib

REPO = pathlib.Path(__file__).resolve().parent.parent
FRONTEND = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "frontend" / "src"
TASKS_DIR = FRONTEND / "pages" / "tasks"


def _page() -> str:
    return (TASKS_DIR / "TasksPage.tsx").read_text()


def _panel() -> str:
    page = _page()
    return page[page.index("function ProtocolPanel"):page.index("function ThreadCard")]


# ---------- protoEmpty: real execution (moved to Vitest) ----------

def test_proto_empty_truth_table():
    """protoEmpty(p) is the empty-state predicate: true when there's no protocol or all
    four free-text keys are blank/absent; false the moment ANY key carries text (a
    partial protocol still renders the panel, not the 'No protocol set' note). The
    truth table runs BEHAVIORALLY against the real page in
    frontend/src/pages/tasks/TasksPage.spec4.test.tsx; here: pin the predicate + the
    harness beats."""
    page = _page()
    assert "return !p || (!p.review_chain && !p.handoff_to && !p.autonomy && !p.notes);" in page, \
        "protoEmpty predicate changed — all four keys must gate the empty state"
    t = (TASKS_DIR / "TasksPage.spec4.test.tsx").read_text()
    assert "protoEmpty truth table" in t, "protoEmpty Vitest scenario missing"
    for beat in (
        "protocol: null",                                       # null -> empty state
        'toContain("No protocol set — using container defaults.")',
        "a PARTIAL protocol (any key carrying text) renders the panel rows",
        'not.toContain("No protocol set")',
    ):
        assert beat in t, f"protoEmpty harness lost a beat: {beat}"


# ---------- Part B: placement + wiring ----------

def test_protocol_panel_placed_between_gate_and_assignment():
    """SPEC-4: the panel renders directly UNDER the gate / ABOVE Assignment."""
    page = _page()
    body = page[page.index("{/* gate -> protocol -> thread -> assignment -> close */}"):]
    i_gate = body.index("<GateSurface")
    i_proto = body.index("<ProtocolPanel")
    i_assign = body.index("<AssignSurface")
    assert i_gate < i_proto < i_assign, \
        f"protocol panel out of place (gate<protocol<assignment): {i_gate},{i_proto},{i_assign}"


def test_protocol_panel_rows_and_markdown_notes():
    surf = _panel()
    # the four structured rows
    for label, key in [("Review chain", "review_chain"), ("Hand-off to", "handoff_to"),
                       ("Autonomy", "autonomy"), ("Notes", "notes")]:
        assert f'"{key}"' in surf, f"row {key} missing from protocol panel"
        assert label in surf, f"row label '{label}' missing"
    # notes rendered as links/task-chips via <Linkified>; the others are escaped text
    assert "<Linkified text={p.notes" in surf, "notes not rendered via Linkified"
    # autonomy is FREE TEXT (SPEC-1 enum deferred) — no enum/select, just the value + chip
    assert "p.autonomy" in surf and "L1" not in surf, "autonomy should be free-text, not enum-bound"
    # header chips visible even collapsed (handoff + autonomy)
    assert 'className="pchip"' in surf and "pchip aut" in surf, "header chips missing"
    # empty state copy
    assert "No protocol set — using container defaults." in surf, "empty-state copy missing"


def test_protocol_edit_patches_human_gated():
    """[Edit] is human-authority only -> PATCH /api/tasks/{tid}/protocol with actor_agent_id."""
    page = _page()
    # a real PATCH helper exists and is used against the protocol route
    assert 'method: "PATCH"' in page, "no PATCH helper"
    surf = _panel()
    assert 'patchReq("/api/tasks/" + encodeURIComponent(t.id) + "/protocol"' in surf, \
        "save doesn't PATCH the protocol route"
    assert "actor_agent_id: h.id" in surf, "PATCH body omits the acting human (audit gate)"
    # save + edit-open are gated on an acting human
    assert "const h = actingHuman(snap);\n    if (!h || !draft) return;" in surf, "save not gated on an acting human"
    assert "if (!actingHuman(snap))" in surf, "Edit-open not gated on an acting human"
    # Edit/Set buttons only render for the acting human (canEdit gate)
    assert "const canEdit = !!actingHuman(snap)" in surf, "Edit affordance not gated on acting human"
    assert "canEdit ?" in surf, "Edit/Set buttons not behind the canEdit gate"
    # behavioral proof of the exact PATCH body (all four keys; '' clears) is Vitest:
    t = (TASKS_DIR / "TasksPage.spec4.test.tsx").read_text()
    assert "PATCHes /api/tasks/{tid}/protocol with the acting human" in t, \
        "protocol-PATCH Vitest scenario missing"
    assert 'actor_agent_id: "h1"' in t and 'handoff_to: ""' in t, "PATCH-body beats lost"


def test_data_adapter_maps_protocol():
    """The adapter must whitelist `protocol` or it silently drops it (the wakes_enabled
    trap) — vanilla data.js is retired; the React adapter is api/client.ts mapSnapshot."""
    js = (FRONTEND / "api" / "client.ts").read_text()
    assert "protocol: t.protocol != null ? t.protocol : null" in js, \
        "client.ts task mapping drops the protocol field"


# ---------- Part A: create-task form ----------

def test_new_task_form_human_gated_posts_to_real_route():
    page = _page()
    # a New-Task affordance exists in the list, wired to open the modal + human-gated
    assert "data-newtask" in page, "no New-Task button"
    assert "setNewTaskOpen(true)" in page and "NewTaskModal" in page, "New-Task button not wired to a modal"
    assert "const canCreate = !!actingHuman(snap)" in page, "New-Task not gated on an acting human"
    sub = page[page.index("function NewTaskModal"):page.index("   Worker runs (live feed)")]
    # POSTs to the EXISTING container-tasks route with created_by resolving the acting human
    assert '"/api/containers/" + encodeURIComponent(containerId) + "/tasks"' in sub, \
        "create doesn't POST the container-tasks route"
    assert "created_by_agent_id: h.id" in sub, "create omits the acting human as creator"
    assert "definition_of_done: dd" in sub, "create omits definition_of_done"
    # required-field validation: title + DoD
    assert "Title is required." in sub and "Definition of done is required." in sub, \
        "create skips required-field validation"
    # behavioral proof (validation order + the exact POST body) is Vitest:
    t = (TASKS_DIR / "TasksPage.spec4.test.tsx").read_text()
    assert "POSTs the container-tasks route with the acting human" in t, \
        "create-task Vitest scenario missing"
    assert 'created_by_agent_id: "h1"' in t, "create-body beat lost"


SKILLS = REPO / "orcha-cli" / "orcha_cli" / "templates" / "skills"


def test_orcha_task_new_skill_preserves_self_referential_context_before_post():
    """Conversation-lane self-handoff must be checked before the create call can wake a worker."""
    skill = (SKILLS / "orcha-task-new.md").read_text()
    check = skill[skill.index("Conversation-lane self-handoff check before POST"):]
    post_idx = skill.index("**POST** the task")
    post = skill[post_idx:]
    assert skill.index("Conversation-lane self-handoff check before POST") < post_idx
    assert "ORCHA_CONVERSATION_WORKER=1" in check
    assert "self-referential/overlap case" in check
    assert "initial `description` or `protocol.notes`" in check
    assert "create the task unassigned first, post the note, then assign it" in check
    assert "normal fresh handoff path" in check
    assert 'curl -sS -w \'\\n%{http_code}\' -X POST' in post
