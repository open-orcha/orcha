"""ISS-68 (#167) PR-2 — frontend lazy wiring.

The snapshot no longer ships each task's full message thread; tasks carry `message_summary`
{count,last} + `plan_message`. The adapter must map those (thread empty, summary/plan present),
expose a lazy `threadOf(tid)` fetch, and the pages must detect a pending plan from `plan_message`
(not the absent thread) + rebuild the home activity feed from `message_summary.last`.

MIGRATED (portal React migration Phase 7): the vanilla data.js node harnesses moved to
Vitest — frontend/src/api/client.iss68.test.ts (mapSnapshot trim + threadOf fetch/map).
The page greps are repointed at the React SOURCE.
"""
import pathlib

REPO = pathlib.Path(__file__).resolve().parent.parent
SRC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "frontend" / "src"


def test_adapter_maps_summary_plan_and_exposes_threadof():
    """Behavior covered in Vitest (frontend/src/api/client.iss68.test.ts); here we pin
    the wire contract in the SOURCE: mapSnapshot carries message_summary/plan_message
    with an empty eager thread, and threadOf lazy-GETs /api/tasks/{tid}/messages."""
    client = (SRC / "api" / "client.ts").read_text()
    assert 't.message_summary || { count: 0, last: null }' in client, "mapSnapshot doesn't default message_summary"
    assert "t.plan_message || null" in client, "mapSnapshot doesn't map plan_message"
    assert "export async function threadOf" in client, "no lazy threadOf fetch"
    assert '"/api/tasks/" + encodeURIComponent(tid) + "/messages"' in client, "threadOf doesn't hit the messages route"


def test_pages_detect_plan_from_plan_message_not_thread():
    """With the thread trimmed out, the plan-approval gate must fire off `plan_message`.
    The shared detector (planMessageOf, state/SnapshotProvider.tsx) reads plan_message
    FIRST with a thread fallback, and every plan surface routes through it."""
    provider = (SRC / "state" / "SnapshotProvider.tsx").read_text()
    assert "export function planMessageOf" in provider, "no shared plan detector"
    assert "if (t.plan_message)" in provider, "planMessageOf doesn't read plan_message first"
    for fname in (("pages", "tasks", "TasksPage.tsx"), ("pages", "agents", "AgentsPage.tsx"), ("shell", "Shell.tsx")):
        src = (SRC.joinpath(*fname)).read_text()
        assert "planMessageOf" in src, f"{fname[-1]} doesn't use the shared plan detector"
    home = (SRC / "pages" / "home" / "HomePage.tsx").read_text()
    assert "if (t.plan_message) return t.plan_message.body" in home, "home plan text doesn't read plan_message first"


def test_home_activity_feed_uses_message_summary():
    home = (SRC / "pages" / "home" / "HomePage.tsx").read_text()
    # the feed can no longer flatten every task's full thread — it reads message_summary.last
    block = home[home.index("function activityEvents"):]
    block = block[: block.index("\n}")]
    assert "message_summary" in block and ".last" in block, "activity feed not rebuilt from message_summary.last"


def test_tasks_detail_lazy_loads_thread():
    tasks = (SRC / "pages" / "tasks" / "TasksPage.tsx").read_text()
    assert "threadsRef" in tasks and "threadLoadingRef" in tasks, "no lazy per-task thread cache"
    assert "threadOf(" in tasks, "task detail doesn't lazy-fetch the thread"
    # refetch when the summary count outgrows the cached thread (a new message landed)
    assert "message_summary" in tasks and "have >= want" in tasks, "thread cache never refreshes on new messages"
