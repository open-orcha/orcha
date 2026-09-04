"""FT-SURFACE (D1) — live data adapter (snapshot -> component shape) + ISS-46.

D1 replaced the mock data.js with a loader that fetches the real FastAPI snapshot and
maps it to the component shape the pages read. The vanilla data.js/app.js are retired
by the React migration (Phase 7): the adapter is now frontend/src/api/client.ts
(mapSnapshot / resolveCid / fetchSnapshot) driven by state/SnapshotProvider.tsx on the
3s cadence. ISS-46/ISS-53 (scroll/selection/typing clobbered by the 3s repaint) are
solved ARCHITECTURALLY in React — state-driven reconciliation + controlled inputs —
so the Orcha.patch primitive and its node harnesses are retired; the typed-draft
behaviour is covered functionally in the frontend Vitest suite (e.g.
frontend/src/pages/tasks/TasksPage.test.tsx "reject demands a typed reason").
Mapping fidelity moved to frontend/src/api/client.test.ts (Vitest); the attention
classification of mapped requests to frontend/src/state/snapshot.test.ts.
"""
import pathlib
import pytest

pytestmark = pytest.mark.asyncio

REPO = pathlib.Path(__file__).resolve().parent.parent
PORTAL = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal"
FRONTEND = PORTAL / "frontend" / "src"


# ---------- the snapshot contract the adapter reads holds ----------

async def test_snapshot_contract(client, make_agent, make_task, make_request):
    # the real snapshot the adapter (frontend/src/api/client.ts mapSnapshot,
    # compiled into static/dist/) reads exposes the keys it maps
    human = await make_agent("Boss", kind="human")
    worker = await make_agent("Worker", kind="ai")
    task = await make_task("do it", "done when X", assignee_alias="Worker")
    await make_request(worker["agent_id"], "advise?", target_alias="Boss")

    cid = worker["container_id"]
    snap = (await client.get(f"/api/containers/{cid}")).json()
    assert set(["container", "agents", "tasks", "requests"]).issubset(snap.keys())
    a0 = snap["agents"][0]
    assert {"id", "alias", "kind", "status"}.issubset(a0.keys())
    t0 = next(t for t in snap["tasks"] if t["id"] == task["id"])
    assert "assignees" in t0 and "status" in t0
    r0 = snap["requests"][0]
    assert {"id", "requester_id", "target_id", "status"}.issubset(r0.keys())


# ---------- static guards (React source) ----------

def test_adapter_present_and_maps_the_real_shapes():
    client_ts = (FRONTEND / "api" / "client.ts").read_text()
    for fn in ("export function mapSnapshot", "export async function resolveCid", "export async function fetchSnapshot"):
        assert fn in client_ts, f"client.ts missing {fn}"
    # maps to the component shape (no D7 dependency: D7 fields fall back)
    assert "byAlias" in client_ts, "adapter doesn't derive byAlias"
    # consumes D7's actual shapes: plan_decision, runs-summary-vs-array, resolved task_link
    assert "t.plan_decision" in client_ts, "doesn't surface D7 plan_decision (ISS-41 suppress)"
    assert "Array.isArray(t.runs)" in client_ts and "runs_summary" in client_ts, \
        "D7 runs-summary not distinguished from the run array"
    assert "r.task_link ||" in client_ts, "doesn't prefer D7's resolved task_link object"
    assert 'r.target_id) || "human"' in client_ts, "null request target not resolved to human"
    # D1 review (P2): mapped requests keep the raw ids the shell classifies by
    assert "requester_id: r.requester_id," in client_ts and "target_id: r.target_id," in client_ts, \
        "mapped requests drop raw ids"
    # the 3s cadence + live re-render is the SnapshotProvider poll
    sp = (FRONTEND / "state" / "SnapshotProvider.tsx").read_text()
    assert "setInterval(" in sp and "pollMs" in sp, "no 3s poll cadence"
    assert "fetchSnapshot" in sp, "provider doesn't refresh via the adapter"


def test_no_html_filename_deeplinks_in_the_react_source():
    """Review P2 of D1: deeplinks/nav must target the served FastAPI routes, never the
    *.html filenames (which 404). The React pages deep-link on the served routes."""
    offenders = []
    for p in FRONTEND.rglob("*.ts*"):
        src = p.read_text()
        for bad in ('href="agents.html', 'href="tasks.html', 'href="requests.html', 'href="home.html',
                    "'agents.html", "'tasks.html", "'requests.html"):
            if bad in src:
                offenders.append(f"{p.name}: {bad}")
    assert not offenders, f"React source still links *.html routes: {offenders}"
    tasks_page = (FRONTEND / "pages" / "tasks" / "TasksPage.tsx").read_text()
    assert '"/agents?agent="' in tasks_page, "agent deeplinks not on the served route"
    home = (FRONTEND / "pages" / "home" / "HomePage.tsx").read_text()
    assert '"/tasks?task="' in home and '"/requests?req="' in home, "deeplinks not on served routes"
    # ISS-49: run-feed timestamps use BOTH shared friendly helpers, not raw ISO
    runlog = (FRONTEND / "pages" / "agents" / "runlog.tsx").read_text()
    assert "clockTime(started)" in runlog, "feed time not via clockTime"
    assert "relTime(ended || started)" in runlog, "feed time missing friendly relative (relTime)"


async def test_portal_serves_routes_not_html_filenames(client):
    """Review P2: the shell deeplinks must hit the routes FastAPI actually serves.
    /agents|/tasks|/requests = 200; the *.html filenames the old links used = 404."""
    for path in ("/", "/agents", "/tasks", "/requests"):
        r = await client.get(path)
        assert r.status_code == 200, f"{path} → {r.status_code}"
    for bad in ("/agents.html", "/tasks.html", "/requests.html"):
        r = await client.get(bad)
        assert r.status_code == 404, f"{bad} → {r.status_code} (should 404)"


# ---------- behaviour moved to the frontend Vitest suite ----------
# - AI→AI request not counted as a human escalation (attn classification of the
#   mapped snapshot): frontend/src/state/snapshot.test.ts
# - mapSnapshot real-shape fallbacks + D7 enriched shapes (byAlias/assignee/model,
#   plan_decision, runs summary vs array, task_link, current_task, prompt_preview):
#   frontend/src/api/client.test.ts (+ foundation.test.ts spot-checks)
# - ISS-46/ISS-53 repaint preservation (Orcha.patch scroll/selection/dirty-input
#   guards): retired — React state-driven rendering + controlled inputs make the
#   3s repaint unable to clobber scroll, selections, or typed drafts; the typing
#   surfaces are exercised in frontend/src/pages/tasks/TasksPage.test.tsx and
#   frontend/src/pages/home/HomePage.test.tsx.
