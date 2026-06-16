"""FT-SURFACE (D3) — agent activity hub + detail (agents.html) on the D0/D1 foundation.

agents.html is rewritten to the design system: a sticky roster + a detail view that
renders from the LIVE snapshot on the 3s cadence (snapshot sections via Orcha.patch —
scroll/selection safe), plus per-agent lazy fetches (persona / digest / worker runs).

Folded in per dispatch:
- ISS-33/36 — a gate callout (plan-approval / needs_verification) surfaced DECOUPLED
  from the agent's status, deep-linking to the Tasks gate.
- ISS-41 — the gate is gated on the durable plan_decision: an approved plan shows a
  quiet decided-note, never a live re-approve (suppressed across reload).
- ISS-35/38 — current-task + requests-in/out deeplinks on served routes.
- prompt_preview (#81) for the persona, full system_prompt lazy via /persona.
- the shared runCard/activateRuns live-run engine (also clears #73 ISS-46/49).
- HELD: the conversation panel (placeholder only — E2 turn-bus + new bundle pending).
- READ-ONLY wake badge (per-agent wake endpoint is a Forge fast-follow).
The visual is verified live; the automatable surface is the wiring + the gate logic.
"""
import pathlib
import pytest

pytestmark = pytest.mark.asyncio

REPO = pathlib.Path(__file__).resolve().parent.parent
STATIC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static"


# ---------- the page serves + boots on the foundation ----------

async def test_agents_serves_and_wires_the_foundation(client):
    r = await client.get("/agents")
    assert r.status_code == 200, r.text
    html = r.text
    for asset in ("/assets/styles.css", "/assets/app.js", "/assets/data.js"):
        assert asset in html, f"agents doesn't load {asset}"
    assert 'mountShell("agents"' in html, "agents doesn't mount the shell"
    assert "OrchaData.start(render, 3000)" in html, "agents doesn't boot the live adapter on the 3s cadence"
    for el in ('id="roster"', 'id="detailMain"', 'id="runsWrap"'):
        assert el in html, f"agents missing section {el}"


# ---------- static guards ----------

def test_agents_roster_role_on_its_own_line_max_two():
    """The roster row stacks the name over the role (role on the 2nd line), the role
    wraps to AT MOST 2 lines then ellipsis, and the row top-aligns so its height grows
    with the wrapped role."""
    html = (STATIC / "agents.html").read_text()
    rrow = html[html.index(".rrow {"):html.index(".ahead {")]
    assert "flex-direction: column" in rrow, "name/role not stacked (role not on its own line)"
    assert "-webkit-line-clamp: 2" in rrow, "role not clamped to 2 lines"
    assert "align-items: flex-start" in rrow, "row doesn't top-align for a wrapping role (height won't grow cleanly)"


def test_agents_uses_patch_and_served_routes():
    html = (STATIC / "agents.html").read_text()
    # snapshot sections repaint via the scroll/selection-safe primitive (ISS-46)
    assert "O.patch(" in html, "agents doesn't render via Orcha.patch"
    # deeplinks target the served routes, never *.html (D1 review P2)
    for bad in ('href="agents.html', 'href="tasks.html', 'href="requests.html', "'agents.html", "'tasks.html"):
        assert bad not in html, f"agents links to a *.html route: {bad}"
    assert 'href="/tasks?task=' in html, "current-task / gate deeplinks not on the served Tasks route (ISS-35)"
    assert 'href="/requests?req=' in html, "request deeplinks not on the served Requests route (ISS-38)"
    # roster selection updates the ?agent= deeplink
    assert 'searchParams.set("agent"' in html, "roster selection doesn't update the ?agent= deeplink"


def test_agents_mounts_the_conversation_panel():
    """S1: the held placeholder is replaced by the live conversation panel — the module is
    loaded and mounted into #convWrap (a sibling of #detailMain, so the 3s patch can't wipe
    the composer). It still must NOT wire the one-shot /prompt (the resident path is used)."""
    html = (STATIC / "agents.html").read_text()
    assert "convo-hold" not in html and "Coming soon" not in html, "the held placeholder wasn't replaced"
    assert "conversation.js" in html and "OrchaConvo.mount" in html, "conversation panel not mounted"
    assert 'id="convWrap"' in html, "panel not mounted outside the patched #detailMain"
    assert "/prompt" not in html, "must not wire the one-shot prompt endpoint (resident conv path is used)"


def test_agents_wake_is_read_only_badge():
    """Only a container-wide wakes kill-switch exists; per-agent wake mutation is a Forge
    fast-follow. D3 shows a read-only badge — no toggle, no missing-endpoint call."""
    html = (STATIC / "agents.html").read_text()
    assert "wakebadge" in html, "no read-only wake status badge"
    assert "wake_enabled = !" not in html, "must not pretend to toggle wake_enabled (no endpoint)"
    assert "/wakes" not in html, "must not wire the container-wide kill-switch from the agent view"


def test_agents_persona_prompt_preview_and_lazy_full():
    html = (STATIC / "agents.html").read_text()
    # inline persona preview from the snapshot (#81), full prompt lazy via /persona
    assert "a.prompt_preview" in html, "persona doesn't consume prompt_preview (#81)"
    assert "/persona" in html, "full system_prompt not lazy-fetched from /persona on expand"


def test_agents_runs_use_the_shared_engine():
    html = (STATIC / "agents.html").read_text()
    assert "O.runCard(" in html and "O.activateRuns(" in html, "worker runs don't adopt the shared runCard engine"
    assert "/runs" in html, "worker runs not fetched from the agent /runs endpoint"


def test_agents_model_control_posts_ids_not_labels():
    """Review P1: POST /api/agents/{id}/model only accepts curated MODEL IDS
    (claude-opus-4-8, …), not display labels (Opus 4.8). The control must render
    {id,name} pairs — display the name, send the id, highlight on id===a.model — and
    fetch /api/models as the source of truth."""
    html = (STATIC / "agents.html").read_text()
    assert "/model" in html and '"Content-Type": "application/json"' in html, "model control not wired to POST /api/agents/{id}/model"
    # sends the id (data-model=m.id), highlights by id, NOT by display label
    assert 'data-model="${O.esc(m.id)}"' in html, "model button doesn't carry the curated id"
    assert "m.id===a.model" in html or "m.id === a.model" in html, "current-model highlight compares label to id (never matches)"
    # the curated list is the source of truth + a real curated id is present (not just labels)
    assert "/api/models" in html, "doesn't fetch the canonical model list"
    assert "claude-opus-4-8" in html, "no curated model id (would 400 on every click)"


def test_agents_model_control_filters_by_provider_runtime():
    """The Controls card shows Claude/Codex first, then filters the model buttons below."""
    html = (STATIC / "agents.html").read_text()
    assert 'id="modelRuntimeSeg"' in html, "no provider selector above the model selector"
    assert 'data-runtime="${O.esc(r.id)}"' in html, "provider buttons don't carry runtime ids"
    assert "modelsForRuntime(selectedRuntime)" in html, "model selector is not filtered by provider"
    assert 'id="modelSeg"' in html and 'data-runtime="${O.esc(selectedRuntime)}"' in html
    assert ".ctrl.model-ctrl { flex-direction: column;" in html, "model row can squeeze its label column"
    assert "grid-template-columns: repeat(auto-fit, minmax(142px, 1fr))" in html, "model buttons don't use a responsive grid"


def test_agents_gate_decoupled_from_status_and_gated_on_plan_decision():
    """ISS-36: surface the plan-approval / verify gate REGARDLESS of the agent's (possibly
    wrong) status — compute it from the agent's owned tasks, not a.status. ISS-41: an
    already-decided plan shows a quiet decided-note, never a live re-approve."""
    html = (STATIC / "agents.html").read_text()
    # the gate is computed from owned tasks (mine), not gated on the agent status field
    assert "function gateCallout(a, mine)" in html, "no decoupled gate callout"
    assert "regardless of" in html, "gate doesn't advertise being decoupled from agent status (ISS-36)"
    # ISS-41: undecided -> approve action; decided -> note (both branches read plan_decision)
    assert "!planTask.plan_decision" in html, "gate doesn't suppress the approval once plan_decision is set (ISS-41)"
    assert "Plan awaiting your approval" in html and "Plan ${O.esc(verb)}" in html, "missing the undecided/decided plan branches"
    # the gate action deep-links to the authoritative B10 Tasks gate (ISS-33 OR-deeplink)
    assert 'href="/tasks?task=' in html, "gate action doesn't deep-link to the Tasks gate"
