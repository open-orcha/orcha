"""FT-SURFACE (D2) — home dashboard on the D0/D1 foundation.

The vanilla home.html is retired by the React migration (Phase 7): the dashboard is
frontend/src/pages/home/HomePage.tsx, served as the SPA shell (static/dist/) at GET /.
It renders from the LIVE snapshot on the 3s cadence: the "Needs your attention" action
queue HERO (plans to approve + tasks to verify + escalations, with inline
approve/reject), agents-at-a-glance, live activity, and tasks-by-status. The visual is
verified live; the automatable surface is the wiring + the action-queue logic — the
queue logic itself is covered functionally in the frontend Vitest suite
(frontend/src/state/snapshot.test.ts + frontend/src/pages/home/HomePage.test.tsx).
"""
import pathlib
import pytest

pytestmark = pytest.mark.asyncio

REPO = pathlib.Path(__file__).resolve().parent.parent
PORTAL = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal"
FRONTEND = PORTAL / "frontend" / "src"


# ---------- the page serves the SPA shell ----------

async def test_home_serves_the_spa_shell(client):
    r = await client.get("/")
    assert r.status_code == 200, r.text
    assert "text/html" in r.headers.get("content-type", "")
    assert 'id="root"' in r.text, "no SPA mount point"
    assert "/assets/dist/" in r.text, "home doesn't load the dist bundle"


# ---------- static guards (React source) ----------

def test_home_action_queue_wiring():
    html = (FRONTEND / "pages" / "home" / "HomePage.tsx").read_text()
    # the action queue has INLINE approve/reject wired to the real endpoints (plan-first gate)
    assert 'data-kind="plan"' in html and 'data-kind="verify"' in html, "no inline plan/verify actions"
    assert "/api/decisions" in html and 'subject_type: "plan_approval"' in html, \
        "plan approval not via the B0 decision contract"
    assert "/verify" in html, "task verify not wired"
    assert "actingHuman(" in html, "actions don't resolve the acting human"
    # review P1: the plan card shows the FULL plan body, rendered via the shared
    # esc-first linkifier (ISS-44), never truncated before approval.
    assert "<Linkified text={planText(t)} />" in html, \
        "plan card must show the full plan, not a truncated summary"
    assert "trunc(planText" not in html, "plan body must not be truncated before approval"
    # review P2: one-shot — acted cards are suppressed immediately + not re-submittable
    assert "useState<Set<string>>" in html and "acted" in html, "no one-shot per-task acted cache"
    assert "!acted.has(t.id)" in html, "acted cards aren't suppressed on render"
    assert "markActed(taskId)" in html, "a successful decision doesn't mark the card acted"
    # review P2 follow-up (:173): suppression must be pruned when the task leaves the
    # actionable set, so a reject→rework cycle that returns the same id isn't hidden forever
    assert "actionable.has(id)" in html, \
        "acted set is never pruned — a reworked task stays hidden permanently this session"


# ---------- action-queue logic ----------
# attnItems() surfacing pending plans only (undecided, agent-authored), alongside
# needs_verification + escalations, is covered in the frontend Vitest suite:
# frontend/src/state/snapshot.test.ts ("attnItems (action-queue logic, D2/ISS-52)")
# and rendered end-to-end in frontend/src/pages/home/HomePage.test.tsx.
