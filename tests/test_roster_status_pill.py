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
    """D4 redesign, carried into V2: the task list renders a per-row status indicator with
    the EXACT status label (StatusDot: shared lib/status STAT label + a distinct glyph
    shape, never colour-only) and groups by status with needs_verification first; the
    detail view renders the same taxonomy."""
    page = (FRONTEND / "pages" / "tasks" / "TasksPage.tsx").read_text()
    # Linear pop round 1: the row / list moved to TaskListView.tsx, the detail to TaskDetail.tsx
    view = (FRONTEND / "pages" / "tasks" / "TaskListView.tsx").read_text()
    detail = (FRONTEND / "pages" / "tasks" / "TaskDetail.tsx").read_text()
    query = (FRONTEND / "pages" / "tasks" / "taskQuery.ts").read_text()
    icon = (FRONTEND / "components" / "primitives" / "StatusIcon.tsx").read_text()
    badge = (FRONTEND / "components" / "primitives" / "Badge.tsx").read_text()
    row = view[view.index("export function TaskRow"):]
    row = row[: row.index("\n}\n")]
    assert "<StatusIcon status={t.status}" in row, "task row doesn't render a per-row status indicator"
    # the indicator is the ONE D8 taxonomy: exact STAT label + a glyph shape per status
    assert "statusMeta(status).l" in icon and "statusShape(status)" in icon, \
        "StatusIcon doesn't reuse the shared status taxonomy (label + glyph)"
    assert "<StatusGlyph" in badge, "legacy StatusDot doesn't render the shared D8 glyph set"
    # grouped by status with needs_verification first
    grp = query[query.index("export const GROUP_ORDER"):query.index("export const KNOWN_STATUSES")]
    assert grp.index('k: "needs_verification"') < grp.index('k: "in_progress"'), \
        "list isn't grouped by status (needs_verification first)"
    assert "GROUP_ORDER" in page, "the page doesn't group by the shared status order"
    # the detail header renders the same taxonomy with its exact label
    assert "<StatusIcon status={t.status}" in detail, "detail view lost the shared status indicator"
