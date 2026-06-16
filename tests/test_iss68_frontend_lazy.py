"""ISS-68 (#167) PR-2 — frontend lazy wiring.

The snapshot no longer ships each task's full message thread; tasks carry `message_summary`
{count,last} + `plan_message`. The adapter must map those (thread empty, summary/plan present),
expose a lazy `threadOf(tid)` fetch, and the pages must detect a pending plan from `plan_message`
(not the absent thread) + rebuild the home activity feed from `message_summary.last`.
"""
import json
import pathlib
import re
import shutil
import subprocess

import pytest

REPO = pathlib.Path(__file__).resolve().parent.parent
STATIC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_mapsnapshot_trims_thread_keeps_summary_and_plan():
    data_js = (STATIC / "data.js").read_text()
    harness = r"""
global.location = { search: "" }; global.fetch = () => {}; global.window = {};
__DATAJS__
const m = window.OrchaData.mapSnapshot({
  container: { id: "c1", status: "active" },
  agents: [ { id: "a1", alias: "Frame", kind: "ai", status: "working" } ],
  tasks: [ { id: "t1", title: "X", status: "in_progress", priority: 50, assignees: ["Frame"],
             message_summary: { count: 3, last: { body: "latest note", created_at: "t", is_human: false, author_alias: "Frame" } },
             plan_message: { body: "PLAN: do X", author_alias: "Frame", at: "t0" } } ],
  requests: [],
});
const t = m.tasks[0];
console.log(JSON.stringify({
  threadEmpty: Array.isArray(t.thread) && t.thread.length === 0,   // trimmed snapshot -> no eager thread
  summary: t.message_summary.count === 3 && t.message_summary.last.body === "latest note",
  plan: t.plan_message.body === "PLAN: do X" && t.plan_message.author_alias === "Frame",
  hasThreadOf: typeof window.OrchaData.threadOf === "function",
}));
"""
    out = subprocess.run(["node", "-e", harness.replace("__DATAJS__", data_js)], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    res = json.loads(out.stdout.strip().splitlines()[-1])
    assert all(res.values()), res


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_threadof_fetches_and_maps_the_lazy_thread():
    data_js = (STATIC / "data.js").read_text()
    harness = r"""
let fetched = null;
global.location = { search: "" };
global.window = { ORCHA: { agents: [ { id: "a1", alias: "Frame" } ] } };
global.fetch = (url) => { fetched = url; return Promise.resolve({ ok: true, json: () => Promise.resolve({
  task_id: "t1", messages: [
    { message_id: "m1", author_id: "a1", author_alias: "Frame", is_human: false, body: "hello", created_at: "t" },
    { message_id: "m2", author_id: null, author_alias: null, is_human: true, body: "hi back", created_at: "t2" },
  ] }) }); };
__DATAJS__
window.OrchaData.threadOf("t1").then((thread) => {
  console.log(JSON.stringify({
    url: /\/api\/tasks\/t1\/messages/.test(fetched),
    mapped: thread.length === 2 && thread[0].from === "Frame" && thread[1].from === "human" && thread[1].is_human === true,
  }));
});
"""
    out = subprocess.run(["node", "-e", harness.replace("__DATAJS__", data_js)], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    res = json.loads(out.stdout.strip().splitlines()[-1])
    assert all(res.values()), res


def test_pages_detect_plan_from_plan_message_not_thread():
    """With the thread trimmed out, the plan-approval gate must fire off `plan_message`. Every
    plan detector falls back to the thread but reads plan_message first."""
    for fn_name, fname in [("planMessageOf", "app.js"), ("planMsgOf", "tasks.html"), ("planMsgOf", "agents.html")]:
        src = (STATIC / fname).read_text()
        block = re.search(rf"function {fn_name}\(t\) \{{.*?\n  \}}", src, re.S)
        assert block, f"{fn_name} not found in {fname}"
        assert "t.plan_message" in block.group(0), f"{fn_name} in {fname} doesn't read plan_message"


def test_home_activity_feed_uses_message_summary():
    home = (STATIC / "home.html").read_text()
    # the feed can no longer flatten every task's full thread — it reads message_summary.last
    block = re.search(r"function activityEvents\(\) \{.*?\n  \}", home, re.S).group(0)
    assert "message_summary" in block and ".last" in block, "activity feed not rebuilt from message_summary.last"


def test_tasks_detail_lazy_loads_thread():
    tasks = (STATIC / "tasks.html").read_text()
    assert "threadCache" in tasks and "maybeLoadThread" in tasks, "no lazy per-task thread cache"
    assert "OrchaData.threadOf(" in tasks, "task detail doesn't lazy-fetch the thread"
    # refetch when the summary count outgrows the cached thread (a new message landed)
    assert "message_summary" in tasks and "have >= want" in tasks, "thread cache never refreshes on new messages"
