"""FT-SURFACE (ISS-34) — prominent status pill per task in the task list.

The task list showed status only as small meta text + a tiny dot, so
needs_verification was hard to scan for. It must render the same colored status
indicator used in the detail view.

Phase 7: the vanilla static/tasks.html (renderRoster/trowHtml) is retired; the React
list is frontend/src/pages/tasks/TasksPage.tsx — each row renders the shared status
glyph (<Glyph status=.../>, the app.js glyph markup keyed by statusClass) and the list
is grouped by status with needs_verification first (D4 redesign). Static guard; the
visual is obvious in the portal.
"""
import pathlib

REPO = pathlib.Path(__file__).resolve().parent.parent
FRONTEND = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "frontend" / "src"


def test_roster_renders_status_pill_per_task():
    """D4 redesign: the task list renders a per-row colored status indicator (the shared
    status glyph) and groups by status, so needs_verification reads at a glance."""
    page = (FRONTEND / "pages" / "tasks" / "TasksPage.tsx").read_text()
    row = page[page.index("const trow = (x: Task)"):page.index("const ctx =")]
    assert "<Glyph status={x.status} />" in row, "task row doesn't render a per-row status indicator"
    # the glyph is the shared markup, keyed off the shared statusClass
    assert "glyphHtml(statusClass(status))" in page, "Glyph doesn't reuse the shared statusClass taxonomy"
    # grouped by status with needs_verification first
    grp = page[page.index("const GRP"):page.index("const TASKS_PAGE")]
    assert grp.index('k: "needs_verification"') < grp.index('k: "in_progress"'), \
        "list isn't grouped by status (needs_verification first)"
    # the detail header renders the same taxonomy as a full pill
    assert "<StatusPill status={t.status}" in page, "detail view lost the shared status pill"
