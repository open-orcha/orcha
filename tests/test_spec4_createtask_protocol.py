"""SPEC-4 — Create-Task UI + per-task Protocol panel (frontend, task d05ca75c).

Part A: a human-gated "New Task" form on the tasks page POSTing to the existing
POST /api/containers/{cid}/tasks. Part B: a collapsible protocol panel on task detail
(4 rows review_chain/handoff_to/autonomy/notes + markdown notes, header chips, human-only
Edit -> PATCH /api/tasks/{tid}/protocol, empty/read-only states, autonomy free-text).

In-IIFE logic (protoEmpty) is exercised for real via the node harness; the wiring +
placement (mutation teeth: protocol sits between gate and assignment) and the human-authority
gating are asserted on the served static source.
"""
import json
import pathlib
import re
import shutil
import subprocess

import pytest

REPO = pathlib.Path(__file__).resolve().parent.parent
STATIC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static"


# ---------- protoEmpty: real JS execution ----------

@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_proto_empty_truth_table():
    """protoEmpty(p) is the empty-state predicate: true when there's no protocol or all four
    free-text keys are blank/absent; false the moment ANY key carries text (a partial protocol
    still renders the panel, not the 'No protocol set' note)."""
    html = (STATIC / "tasks.html").read_text()
    m = re.search(r"function protoEmpty\(p\)\s*\{.*?\}", html, re.S)
    assert m, "protoEmpty() not found in tasks.html"
    harness = m.group(0) + r"""
console.log(JSON.stringify({
  nullIsEmpty: protoEmpty(null) === true,
  undefIsEmpty: protoEmpty(undefined) === true,
  blankObjIsEmpty: protoEmpty({}) === true,
  allBlankIsEmpty: protoEmpty({review_chain:"",handoff_to:"",autonomy:"",notes:""}) === true,
  chainSetIsNotEmpty: protoEmpty({review_chain:"dev -> Helm"}) === false,
  notesOnlyIsNotEmpty: protoEmpty({notes:"x"}) === false,
  autonomyOnlyIsNotEmpty: protoEmpty({autonomy:"L1"}) === false,
}));
"""
    out = subprocess.run(["node", "-e", harness], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    res = json.loads(out.stdout.strip().splitlines()[-1])
    for k, v in res.items():
        assert v, f"{k} failed: {res}"


# ---------- Part B: placement + wiring ----------

def test_protocol_panel_placed_between_gate_and_assignment():
    """SPEC-4: the panel renders directly UNDER the gate / ABOVE Assignment."""
    html = (STATIC / "tasks.html").read_text()
    body = html[html.index("function renderDetail"):]
    body = body[: body.index("function gateSurface")]
    i_gate = body.index("html += gateSurface(t)")
    i_proto = body.index("html += protocolSurface(t)")
    i_assign = body.index("html += assignSurface(t)")
    assert i_gate < i_proto < i_assign, \
        f"protocol panel out of place (gate<protocol<assignment): {i_gate},{i_proto},{i_assign}"


def test_protocol_panel_rows_and_markdown_notes():
    html = (STATIC / "tasks.html").read_text()
    surf = html[html.index("function protocolSurface"):]
    surf = surf[: surf.index("function ", 10)]
    # the four structured rows
    for label, key in [("Review chain", "review_chain"), ("Hand-off to", "handoff_to"),
                       ("Autonomy", "autonomy"), ("Notes", "notes")]:
        assert f'"{key}"' in surf, f"row {key} missing from protocol panel"
        assert label in surf, f"row label '{label}' missing"
    # notes rendered as markdown/links via O.linkify; the others are escaped text
    assert "O.linkify(p.notes" in surf, "notes not rendered via O.linkify"
    # autonomy is FREE TEXT (SPEC-1 enum deferred) — no enum/select, just esc'd value + chip
    assert "p.autonomy" in surf and "L1" not in surf, "autonomy should be free-text, not enum-bound"
    # header chips visible even collapsed (handoff + autonomy)
    assert 'class="pchip"' in surf and 'pchip aut' in surf, "header chips missing"
    # empty state copy
    assert "No protocol set — using container defaults." in surf, "empty-state copy missing"


def test_protocol_edit_patches_human_gated():
    """[Edit] is human-authority only -> PATCH /api/tasks/{tid}/protocol with actor_agent_id."""
    html = (STATIC / "tasks.html").read_text()
    # a real PATCH helper exists and is used against the protocol route
    assert 'method: "PATCH"' in html, "no PATCH helper"
    assert "/protocol" in html, "protocol route not called"
    save = html[html.index("function saveProtocol"):]
    save = save[: save.index("function ", 10)]
    assert "actorOrWarn()" in save, "save not gated on an acting human"
    assert "actor_agent_id: h.id" in save, "PATCH body omits the acting human (audit gate)"
    assert "patchJSON(" in save and "/protocol" in save, "save doesn't PATCH the protocol route"
    # Edit/Set buttons only render for the acting human (canEdit gate)
    surf = html[html.index("function protocolSurface"):]
    surf = surf[: surf.index("function ", 10)]
    assert "const canEdit = !!O.actingHuman()" in surf, "Edit affordance not gated on acting human"
    assert 'canEdit ?' in surf, "Edit/Set buttons not behind the canEdit gate"


def test_data_adapter_maps_protocol():
    """data.js must whitelist `protocol` or the adapter silently drops it (the wakes_enabled trap)."""
    js = (STATIC / "data.js").read_text()
    tasks_map = js[js.index("const tasks = (raw.tasks"):]
    tasks_map = tasks_map[: tasks_map.index("const requests")]
    assert "protocol: t.protocol != null ? t.protocol : null" in tasks_map, \
        "data.js task mapping drops the protocol field"


# ---------- Part A: create-task form ----------

def test_new_task_form_human_gated_posts_to_real_route():
    html = (STATIC / "tasks.html").read_text()
    # a New-Task affordance exists in the list, wired to open the modal
    assert "data-newtask" in html, "no New-Task button"
    assert "openNewTaskModal" in html, "New-Task button not wired to a modal"
    sub = html[html.index("function submitNewTask"):]
    sub = sub[: sub.index("function ", 10)]
    # POSTs to the EXISTING container-tasks route with created_by resolving the acting human
    assert "/api/containers/" in sub and "/tasks" in sub, "create doesn't POST the container-tasks route"
    assert "created_by_agent_id: humanId" in sub, "create omits the acting human as creator"
    assert "definition_of_done: dod" in sub, "create omits definition_of_done"
    # required-field validation: title + DoD
    assert "Title is required." in sub and "Definition of done is required." in sub, \
        "create skips required-field validation"
    # the open path is human-gated
    openf = html[html.index("function openNewTaskModal"):]
    openf = openf[: openf.index("function ", 10)]
    assert "actorOrWarn()" in openf, "New-Task modal not gated on an acting human"
