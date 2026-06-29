"""GH#74 — task thread must not get stuck blank / on 'Loading thread…' after a failed fetch.

A failed (network/non-200) thread fetch, OR a fetch that returns no messages while the snapshot
says count>0, must surface a visible "couldn't load — retry" affordance instead of a perpetual
spinner. A failing fetch must NOT be auto-retried on every 3s repaint (it latches until the user
retries). An explicit retry refetches without a full page reload.
"""
import pathlib
import re

REPO = pathlib.Path(__file__).resolve().parent.parent
TASKS = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static" / "tasks.html"


def test_thread_fetch_error_latches_and_surfaces_retry():
    src = TASKS.read_text()
    block = re.search(r"function maybeLoadThread\(.*?\n  \}", src, re.S)
    assert block, "maybeLoadThread not found"
    body = block.group(0)
    # the catch must record an error (not just clear the loading flag and leave the panel blank)
    assert ".catch(" in body and "threadError[t.id] = true" in body, \
        "a failed thread fetch doesn't latch an error state"
    # empty fetch while the snapshot expects messages is treated as a failure, not a perpetual spinner
    assert "want > 0" in body, "an empty fetch with summary count>0 isn't treated as an inconsistency"
    # a latched error suppresses the auto-retry (no hammering the endpoint every repaint)
    assert "threadError[t.id]) return" in body, "a latched thread error is still auto-retried each tick"


def test_render_shows_retry_affordance_and_is_wired():
    src = TASKS.read_text()
    # render path offers a retry button (not blank, not perpetual "Loading thread…")
    assert "data-thread-retry" in src, "no retry affordance rendered for a failed thread fetch"
    # an explicit retry refetches via maybeLoadThread(t, true) — clears the latch + refetches in place
    assert "maybeLoadThread(t, true)" in src, "retry button doesn't trigger a manual refetch"
    # no regression: a task with zero real messages still shows the empty state
    assert "No messages yet." in src, "empty-thread state lost"
