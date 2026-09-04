"""FT-SURFACE (D3) — agent activity hub + detail on the D0/D1 foundation.

The vanilla agents.html is retired by the React migration (Phase 7): the page is
frontend/src/pages/agents/AgentsPage.tsx (+ agents.css, runlog.tsx, Conversation.tsx),
served as the SPA shell (static/dist/) at GET /agents. A sticky roster + a detail view
render from the LIVE snapshot on the 3s cadence, plus per-agent lazy fetches
(persona / digest / worker runs).

Folded in per dispatch (all preserved by the React port):
- ISS-33/36 — a gate callout (plan-approval / needs_verification) surfaced DECOUPLED
  from the agent's status, deep-linking to the Tasks gate.
- ISS-41 — the gate is gated on the durable plan_decision: an approved plan shows a
  quiet decided-note, never a live re-approve.
- ISS-35/38 — current-task + requests-in/out deeplinks on served routes.
- prompt_preview (#81) for the persona, full system_prompt lazy via /persona.
- the shared run-feed engine (runlog.tsx: classifyLine + FilesChanged).
- the live conversation panel (Conversation.tsx, mounted outside the detail repaint).
- READ-ONLY wake badge (per-agent wake mutation still a fast-follow; #300 auto-wake
  cadence is a separate, real endpoint).
The visual + interaction flows are verified live and in the frontend Vitest suite
(frontend/src/pages/agents/AgentsPage.test.tsx); this file keeps the wiring guards.
"""
import pathlib
import re
import pytest

pytestmark = pytest.mark.asyncio

REPO = pathlib.Path(__file__).resolve().parent.parent
PORTAL = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal"
AGENTS_DIR = PORTAL / "frontend" / "src" / "pages" / "agents"


def _page() -> str:
    return (AGENTS_DIR / "AgentsPage.tsx").read_text()


# ---------- the page serves the SPA shell ----------

async def test_agents_serves_the_spa_shell(client):
    r = await client.get("/agents")
    assert r.status_code == 200, r.text
    assert "text/html" in r.headers.get("content-type", "")
    assert 'id="root"' in r.text, "no SPA mount point"
    assert "/assets/dist/" in r.text, "agents doesn't load the dist bundle"


# ---------- static guards (React source) ----------

def test_agents_roster_role_on_its_own_line_max_two():
    """The roster row stacks the name over the role (role on the 2nd line), the role
    wraps to AT MOST 2 lines then ellipsis, and the row top-aligns so its height grows
    with the wrapped role."""
    css = (AGENTS_DIR / "agents.css").read_text()
    rrow = css[css.index(".rrow {"):]
    assert "flex-direction: column" in rrow, "name/role not stacked (role not on its own line)"
    assert "-webkit-line-clamp: 2" in rrow, "role not clamped to 2 lines"
    assert "align-items: flex-start" in rrow, \
        "row doesn't top-align for a wrapping role (height won't grow cleanly)"


def test_agents_uses_served_route_deeplinks():
    html = _page()
    # deeplinks target the served routes, never *.html (D1 review P2)
    for bad in ('href="agents.html', 'href="tasks.html', 'href="requests.html', "'agents.html", "'tasks.html"):
        assert bad not in html, f"agents links to a *.html route: {bad}"
    assert '"/tasks?task="' in html, "current-task / gate deeplinks not on the served Tasks route (ISS-35)"
    assert '"/requests?req="' in html, "request deeplinks not on the served Requests route (ISS-38)"
    # roster selection updates the ?agent= deeplink
    assert 'sp.set("agent"' in html, "roster selection doesn't update the ?agent= deeplink"


def test_agents_mounts_the_conversation_panel():
    """S1: the live conversation panel is mounted into #convWrap (a sibling of
    #detailMain, so the snapshot repaint can't wipe the composer). It still must NOT
    wire the one-shot /prompt (the resident path is used)."""
    html = _page()
    assert "convo-hold" not in html and "Coming soon" not in html, "the held placeholder wasn't replaced"
    assert "<Conversation" in html, "conversation panel not mounted"
    assert 'id="convWrap"' in html, "panel not mounted outside the repainted #detailMain"
    for src in (html, (AGENTS_DIR / "Conversation.tsx").read_text()):
        assert "/prompt" not in src, "must not wire the one-shot prompt endpoint (resident conv path is used)"


def test_agents_wake_is_read_only_badge():
    """Only a container-wide wakes kill-switch exists; per-agent wake mutation is a
    fast-follow. The page shows a read-only badge — no toggle, no missing-endpoint
    call. (#300's auto-wake cadence PATCH is a different, real endpoint.)"""
    html = _page()
    assert "wakebadge" in html, "no read-only wake status badge"
    assert "wake_enabled = !" not in html, "must not pretend to toggle wake_enabled (no endpoint)"
    assert "/wakes" not in html, "must not wire the container-wide kill-switch from the agent view"


def test_agents_persona_prompt_preview_and_lazy_full():
    html = _page()
    # inline persona preview from the snapshot (#81), full prompt lazy via /persona
    assert "a.prompt_preview" in html, "persona doesn't consume prompt_preview (#81)"
    assert "/persona" in html, "full system_prompt not lazy-fetched from /persona on expand"


def test_agents_runs_use_the_shared_engine():
    html = _page()
    assert "RunsFeed" in html, "worker runs don't adopt the shared run-feed engine"
    runlog = (AGENTS_DIR / "runlog.tsx").read_text()
    assert "classifyLine" in runlog and "FilesChanged" in runlog, "run feed misses the shared classifier/diff widget"
    assert "/runs" in runlog, "worker runs not fetched from the agent /runs endpoint"


def test_agents_model_control_posts_ids_not_labels():
    """Review P1: POST /api/agents/{id}/model only accepts curated MODEL IDS
    (claude-opus-5, …), not display labels (Opus 5). The control renders {id,name}
    pairs — display the name, send the id, highlight by id — and fetches /api/models as
    the source of truth. The POST body round-trip is exercised in
    frontend/src/pages/agents/AgentsPage.test.tsx."""
    html = _page()
    assert '"/model", { model }' in html, "model control not wired to POST /api/agents/{id}/model with the id"
    # highlights by id (modelVal derives from a.model + the optimistic override)
    assert "m.id === modelVal" in html, "current-model highlight doesn't compare id to id"
    assert ": a.model" in html, "highlight value not derived from the agent's model id"
    # the curated list is the source of truth + a real curated id is present (not just labels)
    assert "/api/models" in html, "doesn't fetch the canonical model list"
    assert "claude-opus-5" in html, "no curated model id (would 400 on every click)"
    assert "claude-opus-4-8" not in html, "Opus 4.8 replaced by Opus 5"


def test_agents_model_control_filters_by_provider_runtime():
    """The Controls card shows Claude/Codex first, then filters the model buttons below."""
    html = _page()
    css = (AGENTS_DIR / "agents.css").read_text()
    assert 'id="modelRuntimeSeg"' in html, "no provider selector above the model selector"
    assert "modelsForRuntime(selectedRuntime)" in html, "model selector is not filtered by provider"
    assert 'id="modelSeg"' in html
    assert ".ctrl.model-ctrl { flex-direction: column;" in css, "model row can't squeeze its label column"
    assert "grid-template-columns: repeat(auto-fit, minmax(142px, 1fr))" in css, \
        "model buttons don't use a responsive grid"


def test_agents_gate_decoupled_from_status_and_gated_on_plan_decision():
    """ISS-36: surface the plan-approval / verify gate REGARDLESS of the agent's (possibly
    wrong) status — compute it from the agent's owned tasks, not a.status. ISS-41: an
    already-decided plan shows a quiet decided-note, never a live re-approve."""
    html = _page()
    # the gate is computed from owned tasks (mine), not gated on the agent status field
    block = re.search(r"function GateCallout\(\{ a, mine \}.*?\n\}", html, re.S)
    assert block, "no decoupled gate callout"
    assert "regardless of" in html, "gate doesn't advertise being decoupled from agent status (ISS-36)"
    # ISS-41: undecided -> approve action; decided -> note (both branches read plan_decision)
    assert "!planTask.plan_decision" in html, "gate doesn't suppress the approval once plan_decision is set (ISS-41)"
    assert "Plan awaiting your approval" in html and "Plan {verb}" in html, \
        "missing the undecided/decided plan branches"
    # the gate action deep-links to the authoritative B10 Tasks gate (ISS-33 OR-deeplink)
    assert '"/tasks?task="' in block.group(0), "gate action doesn't deep-link to the Tasks gate"
