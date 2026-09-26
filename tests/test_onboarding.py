"""FT-SURFACE (O1+O2+O3) — first-run onboarding wizard (/onboarding).

The /onboarding page serves the wizard (welcome → fork → create-agent | create-tasks →
agent-created), wired to the REAL API:
  O1 — register the operator (human) via POST .../agents kind='human'.
  O2 — create an agent via POST .../agents kind='ai' + prompt (+ optional initial_task),
       models from GET /api/models.
  O3 — a versioned CONCIERGE_TEMPLATE seeds the first agent's system prompt (editable).
  O4 — HELD: the assign/wake step is a "coming soon" stub (no assign endpoint wired).

MIGRATED (portal React migration Phase 7): the wizard now lives in the React SPA —
source at frontend/src/pages/onboarding/{OnboardingPage.tsx,logic.ts}; /onboarding
serves the SPA shell (static/dist/index.html). The onboarding.js node harness
(step machine / ghost reconcile) moved to Vitest: frontend/src/pages/onboarding/logic.test.ts.
The vanilla-only render-loop tests (per-tick innerHTML rebuild, models-load in-place patch)
were retired: React renders from state — there is no innerHTML rebuild path — and the
boot-once + scroll-scoped-to-go() invariants are asserted on the source below.
"""
import pathlib
import pytest

REPO = pathlib.Path(__file__).resolve().parent.parent
PORTAL = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal"
SRC = PORTAL / "frontend" / "src"
ONB = SRC / "pages" / "onboarding"


def _page() -> str:
    return (ONB / "OnboardingPage.tsx").read_text()


def _logic() -> str:
    return (ONB / "logic.ts").read_text()


# ---------- the page serves the SPA shell ----------

@pytest.mark.asyncio
async def test_onboarding_serves_and_boots(client):
    r = await client.get("/onboarding")
    assert r.status_code == 200, r.text
    assert "text/html" in r.headers.get("content-type", ""), r.headers
    html = r.text
    # the React SPA shell: root mount point + the built bundle assets
    assert '<div id="root">' in html, "onboarding doesn't serve the SPA shell (no #root mount)"
    assert "/assets/dist/" in html, "SPA shell doesn't load the built dist bundle"


# ---------- static guards on the wizard contract (React source) ----------

def test_onboarding_registers_human_and_creates_agent():
    js = _page()
    # O1: register the operator as a HUMAN via the agents endpoint
    assert "/agents" in js, "doesn't POST to the agents endpoint"
    assert 'kind: "human"' in js, "operator not registered with kind:human"
    assert 'role: "Operator"' in js, "operator role not set"
    # O2: create an AI agent WITH a prompt
    assert 'kind: "ai"' in js, "agent not created with kind:ai"
    assert "prompt" in js, "agent create doesn't send a system prompt"
    # the container id comes from the shared snapshot provider (which resolves via
    # resolveCid — ?cid= wins, else the sole/active container), used for both POSTs
    assert "cid" in js and "useSnapshot()" in js, "container id not taken from the shared provider"
    assert "export async function resolveCid" in (SRC / "api" / "client.ts").read_text(), \
        "no shared resolveCid"


def test_onboarding_reads_models_and_supports_initial_task():
    js = _page()
    # O2: models come from GET /api/models (display name, send id), default applied
    assert '"/api/models"' in js, "doesn't read the canonical model list"
    assert "d.default" in js, "doesn't honor the models default"
    assert "m.id" in js, "model picker doesn't carry the curated id"
    # O2: an OPTIONAL initial_task with the right shape {title, definition_of_done}
    assert "initial_task" in js, "no optional initial_task support"
    assert "definition_of_done" in js, "initial_task missing definition_of_done"
    # review P2: the 'add tasks first' path persists EVERY queued task (POST /tasks), not just [0]
    assert "/tasks" in js and "for (const t of f.S.tasks)" in js, "tasks-first branch doesn't persist every queued task"
    assert "S.tasks[0]" not in js, "tasks-first branch still drops the queue (only carries the first task)"


def test_onboarding_has_concierge_template_for_first_agent():
    logic = _logic()
    # O3: a versioned concierge template constant, editable in the create form
    assert "CONCIERGE_TEMPLATE" in logic, "no concierge template constant"
    # the seed mentions its key behaviors: suggest (not create) agents, requests, no self-cert
    assert "/orcha-suggest-agent" in logic, "concierge template doesn't point at /orcha-suggest-agent"
    assert "self-certify" in logic or "needs_verification" in logic, "concierge template omits the human-authoritative rule"
    # "first agent" is detected from the snapshot (zero AI agents), not a local flag
    assert 'kind !== "human").length === 0' in _page(), "first-agent detection isn't snapshot-derived"


def test_onboarding_o4_is_a_held_stub_no_assign_wired():
    js = _page() + _logic()
    # O4 held: a coming-soon stub note, NOT a wired assign/wake step
    assert "coming soon" in js.lower(), "no held coming-soon stub for the assign step"
    assert "B5 assign endpoint" in js, "the held stub doesn't name the missing B5 assign endpoint"
    # no invented assign/wake endpoint CALLS (prose like "the assign/wake step" is fine —
    # what's forbidden is actually fetching one of these paths)
    for bad in ('"/assign', "'/assign", '/api/wakes', "/wakes", "/wake-scan"):
        assert bad not in js, f"O4 must stay held — wired a forbidden endpoint: {bad}"
    # and there must be NO fetch to a per-agent /wake* mutation
    assert '/wake"' not in js and "/wake'" not in js, "must not wire a wake endpoint while O4 is held"


def test_onboarding_deeplinks_use_served_routes():
    js = _page()
    # deep-link to an agent on the served route, never a *.html filename
    assert "/agents?agent=" in js, "agent deep-link not on the served /agents route"
    for bad in ("agents.html", 'home.html"', "tasks.html"):
        assert bad not in js, f"onboarding links to a *.html route: {bad}"


# ---------- the page route serves the SPA shell like the others ----------

def test_onboarding_route_registered_in_main():
    main = (PORTAL / "main.py").read_text()
    assert '@app.get("/onboarding"' in main, "no served /onboarding route"
    # Phase 7 (cloud layout): /onboarding serves the shell from main.py; the other
    # page routes live in portal_backend/{dashboard,device_token}_routes.py.
    assert '_serve("dist/index.html")' in main, "/onboarding doesn't serve the SPA shell"
    dash = (PORTAL / "portal_backend" / "dashboard_routes.py").read_text()
    dev = (PORTAL / "portal_backend" / "device_token_routes.py").read_text()
    assert dash.count('serve_page("dist/index.html")') >= 8, "dashboard page routes don't all serve the SPA shell"
    assert 'serve_page("dist/index.html")' in dev, "/auth/device doesn't serve the SPA shell"


# ---------- home empty-state CTA → /onboarding ----------

def test_home_empty_state_cta_links_to_onboarding():
    home = (SRC / "pages" / "home" / "HomePage.tsx").read_text()
    # CTA surfaces only when there are no AI agents, and links to the wizard
    assert 'href="/onboarding"' in home, "home empty-state CTA doesn't link to /onboarding"
    assert 'a.kind !== "human"' in home, "CTA condition isn't 'no AI agents'"


# ---------- pure step-machine logic ----------

def test_step_machine_transitions_are_pure():
    """The step machine is pure, DOM-free logic in frontend/src/pages/onboarding/logic.ts;
    its behavior (railKeyFor / resumeStep / reconcileGhost / template seed) is exercised in
    Vitest: frontend/src/pages/onboarding/logic.test.ts. Pin the exports here."""
    logic = _logic()
    for fn in ("railKeyFor", "resumeStep", "reconcileGhost"):
        assert f"export function {fn}" in logic, f"{fn} not exported from onboarding logic"


# ---------- real round-trip against the endpoints the page uses ----------

@pytest.mark.asyncio
async def test_onboarding_can_register_human_and_create_agent(client, container):
    cid = container["id"]
    # O1: register the operator (human)
    h = await client.post(f"/api/containers/{cid}/agents",
                          json={"alias": "Dario", "role": "Operator", "kind": "human"})
    assert h.status_code in (200, 201), h.text
    assert h.json()["agent_id"]

    # models endpoint the picker reads
    m = await client.get("/api/models")
    assert m.status_code == 200, m.text
    models = m.json()
    assert models["models"] and "default" in models
    model_id = models["default"]

    # O2: create an AI agent with a prompt + chosen model + an optional initial_task
    a = await client.post(f"/api/containers/{cid}/agents", json={
        "alias": "Atlas", "role": "Concierge", "kind": "ai",
        "prompt": "You are the concierge agent. Suggest agents via /orcha-suggest-agent; never self-certify.",
        "model": model_id,
        "initial_task": {"title": "Plan the workspace",
                         "definition_of_done": "A task breakdown the operator approved."},
    })
    assert a.status_code in (200, 201), a.text
    assert a.json()["agent_id"]

    # both exist in the snapshot, with the right kinds
    snap = await client.get(f"/api/containers/{cid}")
    assert snap.status_code == 200, snap.text
    agents = snap.json()["agents"]
    by_alias = {x["alias"]: x for x in agents}
    assert by_alias["Dario"]["kind"] == "human"
    assert by_alias["Atlas"]["kind"] == "ai"
    assert by_alias["Atlas"]["model"] == model_id
    # the initial_task surfaced as a task
    titles = [t["title"] for t in snap.json()["tasks"]]
    assert "Plan the workspace" in titles, titles


# ---------- O-series bug fixes (PR #121 follow-up) ----------

def test_onboarding_boots_once_no_per_tick_rebuild():
    """Bug (vanilla): the wizard jumped on the 3s repaint because the poll re-rendered the
    whole form every tick. React port: boot() runs ONCE on the first snapshot (guarded),
    and all form state lives in component state, which the poll never clobbers."""
    js = _page()
    assert "if (booted || !snap) return;" in js, "boot isn't guarded to run once"
    assert "setBooted(true)" in js, "boot-once flag never set"


def test_add_another_agent_affordance_and_deeplink():
    """Bug: no way to add a SECOND agent once the empty-state CTA was gone. Fix: a persistent
    '+ New agent' affordance on the dashboard + agents page → /onboarding?new=1, and onboarding
    jumps straight to the create-agent step when ?new=1 (operator already exists)."""
    home = (SRC / "pages" / "home" / "HomePage.tsx").read_text()
    agents = (SRC / "pages" / "agents" / "AgentsPage.tsx").read_text()
    js = _page()
    assert "/onboarding?new=1" in home, "home has no persistent '+ New agent' entry point"
    assert "/onboarding?new=1" in agents, "agents page has no '+ New agent' entry point"
    assert 'qp("new") === "1"' in js, "onboarding doesn't honor the ?new=1 deep-link"
    assert 's.step = "create-agent"' in js, "?new=1 doesn't jump to the create-agent step"


def test_onboarding_refreshes_snapshot_after_writes():
    """review P2: a write must explicitly refresh the snapshot before rendering the next
    snapshot-derived step — else a just-created human / agent / task won't appear until
    the poll catches up."""
    js = _page()
    assert "refreshAnd" in js and "await refresh()" in js, "no refresh-then-render helper"
    assert 'await f.refreshAnd("create-agent")' in js, "tasks-first doesn't refresh before the create-agent picker"
    assert 'await f.refreshAnd("fork")' in js and 'await f.refreshAnd("agent-created")' in js, \
        "register/create don't refresh before next step"


def test_onboarding_no_jump_on_any_screen():
    """Finding 3: scroll-to-top belongs to an explicit step change (go), never a re-render
    of the current step — the React port keeps window.scrollTo scoped to go() alone."""
    js = _page()
    assert js.count("window.scrollTo") == 1, "scrollTo fires outside the explicit step change"
    go_block = js[js.index("const go = "):]
    go_block = go_block[: go_block.index("}, [")]
    assert "window.scrollTo({ top: 0 })" in go_block, "scrollTo not scoped to go() (step change)"


def test_onboarding_reconciles_ghost_against_live_snapshot():
    """#140 frontend half (onboarding-ghost): the SPA must NOT re-render a stale
    'agent-created' success screen after a workspace reset. boot() reconciles the
    persisted local flow against the live server snapshot, and the success screen
    bails to fork if the celebrated agent is gone from server truth.
    (Behavioral cases: frontend/src/pages/onboarding/logic.test.ts.)"""
    logic = _logic()
    js = _page()
    # the pure reconciler exists + is exported
    assert "export function reconcileGhost(" in logic, "no ghost reconciler"
    # boot() reconciles against the LIVE snapshot before resuming the step
    assert "reconcileGhost(s, agents.map((a) => a.alias))" in js, "boot() doesn't reconcile against the live snapshot"
    # defensive render-time guard: no live agent -> don't render the dead success card
    assert "const missing = !alias || !a;" in js and 'go("fork")' in js, \
        "agent-created screen still renders a vanished agent"


def test_initial_task_picker_selects_by_id_not_index():
    """Finding 4: the existing-task picker selects by task ID (correct after a refresh/reorder),
    not a positional index into a stale snapshot."""
    js = _page()
    assert "_pickId" in js and "data-pickid" in js, "picker doesn't select by task id"
    assert 'data-pick="${i}"' not in js and "rts[draft._pick]" not in js, "picker still uses a fragile positional index"
    # the pick list derives from the LIVE snapshot every render (not a stale copy)
    assert 'readyTasks = (snap?.tasks ?? []).filter((t) => t.status === "ready"' in js, \
        "pick list isn't recomputed live from the snapshot"
