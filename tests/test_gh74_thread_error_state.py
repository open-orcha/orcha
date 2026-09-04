"""GH#74 — a thread must not get stuck blank / on a perpetual spinner after a failed fetch.

Two distinct surfaces carry this contract in the unified React portal:

1. TasksPage.tsx (frontend/src/pages/tasks/TasksPage.tsx) — the per-task thread panel.
   A failed (network/non-200) thread fetch, OR a fetch that returns no messages while the
   snapshot says count>0, must surface a visible "couldn't load — retry" affordance instead
   of a perpetual spinner. A failing fetch must NOT be auto-retried on every 3s repaint (it
   latches until the user retries). An explicit retry refetches without a full page reload.
   Behavioral coverage runs in Vitest: TasksPage.thread-retry.test.tsx.

2. Conversation.tsx (frontend/src/pages/agents/Conversation.tsx) — the Agents-page
   conversation panel. A failed load() must surface a VISIBLE unavailable state instead of a
   perpetual "Loading…" spinner, and a later successful fetch must recover in place (no full
   page reload). The 3s poll() cadence keeps re-attempting the load while no conversation id
   is known, so a transient failure self-heals. Behavioral coverage runs in Vitest:
   Conversation.errorstate.test.tsx.

The source-contract guards below pin the wiring on both surfaces so a refactor can't
silently drop either latch.
"""
import pathlib
import re

REPO = pathlib.Path(__file__).resolve().parent.parent
TASKS_TSX = (
    REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal"
    / "frontend" / "src" / "pages" / "tasks" / "TasksPage.tsx"
)
CONV_TSX = (
    REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal"
    / "frontend" / "src" / "pages" / "agents" / "Conversation.tsx"
)


def _tasks_src() -> str:
    return TASKS_TSX.read_text()


def _conv_src() -> str:
    return CONV_TSX.read_text()


# --- TasksPage.tsx: per-task thread panel -----------------------------------

def test_thread_fetch_error_latches_and_surfaces_retry():
    src = _tasks_src()
    # a per-task latch exists and the loader consults it (no refetch-hammering each poll tick)
    assert "threadErrorRef" in src, "no latched thread-error state"
    assert "threadErrorRef.current[tid]" in src, "loader doesn't consult the latch"
    # an empty fetch while the snapshot expects messages is treated as a failure
    assert "want > 0" in src or "want >" in src, \
        "an empty fetch with summary count>0 isn't treated as an inconsistency"


def test_render_shows_retry_affordance_and_is_wired():
    src = _tasks_src()
    # render path offers a retry button (not blank, not perpetual "Loading thread…")
    assert "data-thread-retry" in src, "no retry affordance rendered for a failed thread fetch"
    assert "onRetry" in src, "retry button isn't wired to a refetch"
    # no regression: a task with zero real messages still shows the empty state
    assert "No messages yet." in src, "empty-thread state lost"


def test_failed_refresh_over_cached_messages_still_offers_retry():
    """Review blocker: a refresh that fails while cached messages are shown must still surface a
    retry control — otherwise the latch silently freezes the thread stale until a full page
    refresh. The React ThreadCard renders a distinct cached-but-stale branch."""
    src = _tasks_src()
    assert "Couldn&#39;t refresh" in src, "no stale-refresh notice for cached-messages-present failures"
    # both the empty-error and the cached-stale branches carry the retry control
    assert src.count("data-thread-retry") >= 2, \
        "retry button isn't rendered alongside cached messages on a failed refresh"


# --- Conversation.tsx: Agents-page conversation panel -----------------------

def test_failed_load_latches_a_visible_unavailable_state():
    src = _conv_src()
    load = re.search(r"const load = useCallback\(.*?\n  \}, \[", src, re.S)
    assert load, "Conversation load() not found"
    body = load.group(0)
    # the catch must latch a visible error state (not leave the panel on the spinner) …
    assert "setUnavailable(true)" in body, "a failed conversation fetch doesn't latch the unavailable state"
    # … and must ALSO mark the load finished, or the render stays on 'Loading conversation…'
    assert body.index("setUnavailable(true)") < body.rindex("setLoaded(true)"), \
        "the error path doesn't leave the loading state (perpetual spinner)"
    # a successful load clears the latch — recovery happens in place, no page reload
    assert "setUnavailable(false)" in body, "a successful load doesn't clear the unavailable latch"


def test_render_prefers_unavailable_over_spinner_and_empty_state():
    src = _conv_src()
    # the unavailable branch must be checked BEFORE the loading and empty branches,
    # so a latched error can never render as an eternal spinner or a fake-empty thread
    m = re.search(r"\{unavailable \?(.*?)\}\s*\n", src, re.S)
    assert m, "render doesn't branch on the unavailable latch"
    assert "Conversation unavailable." in src, "no visible copy for the unavailable state"
    assert src.index("unavailable ?") < src.index("Loading conversation…"), \
        "the error state doesn't take precedence over the loading spinner"
    # no regression: a healthy-but-empty thread still shows the empty state
    assert "No messages yet" in src, "empty-thread state lost"


def test_poll_cadence_retries_the_failed_load_in_place():
    """Recovery path: while no conversation id is resolved (the failed-load shape), the 3s
    poll() falls back to load() — a transient failure self-heals without a page reload,
    and the retry goes through the SAME load path that clears the latch on success."""
    src = _conv_src()
    poll = re.search(r"const poll = useCallback\(.*?\n  \}, \[", src, re.S)
    assert poll, "Conversation poll() not found"
    body = poll.group(0)
    assert re.search(r"if \(!cid\) \{\s*void load\(\);", body), \
        "poll() no longer falls back to load() while the conversation is unresolved (a failed load would never recover)"
    # the poll's own transient failures never crash the panel
    assert "catch" in body, "poll() doesn't tolerate transient fetch failures"
