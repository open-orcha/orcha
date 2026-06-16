"""FT-SURFACE (ISS-34) — prominent status pill per task in the task list.

The task list (renderRoster in static/tasks.html) showed status only as small meta
text + a tiny dot, so needs_verification was hard to scan for. It must render the
same colored TASK_PILL used in the detail view. Static guard; the visual is obvious
in the portal.
"""
import pathlib
import re

REPO = pathlib.Path(__file__).resolve().parent.parent
STATIC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static"


def test_roster_renders_status_pill_per_task():
    """D4 redesign: the task list renders a per-row colored status indicator (the shared
    status glyph) and groups by status, so needs_verification reads at a glance."""
    html = (STATIC / "tasks.html").read_text()
    row = re.search(r"function trowHtml\(t\) \{.*?\n  \}", html, re.S)
    assert row, "trowHtml not found"
    assert "O.glyph(O.statusClass(t.status))" in row.group(0), "task row doesn't render a per-row status indicator"
    assert 'k: "needs_verification"' in html, "list isn't grouped by status (needs_verification first)"
