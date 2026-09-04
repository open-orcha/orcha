"""FT-SURFACE (B1) — portal worker-progress feed.

B1 is a frontend consumer of the existing A2/ISS-8 /runs endpoints, so the
automatable surface is (a) the data contract the feed renders — a worker run is
retrievable via GET /runs with its status/exit/output/diff, and a watchdog-killed
run surfaces status='killed' — and (b) that both detail pages render runs through the
SHARED engine. In the React port (Phase 7) that engine is frontend/src/lib/classify.ts
(classifyLine taxonomy) + hooks/useRunStream.ts + components/FilesChanged.tsx, mounted
by pages/tasks/TasksPage.tsx and pages/agents/runlog.tsx. The classifier's behaviour
(orcha self-actions, the Codex JSONL taxonomy, the ISS-85 hidden-reasoning honesty
boundary) is exercised in frontend/src/lib/classify.test.ts (Vitest).
"""
import pathlib
import pytest

pytestmark = pytest.mark.asyncio

REPO = pathlib.Path(__file__).resolve().parent.parent
PORTAL = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal"
FRONTEND = PORTAL / "frontend" / "src"

# a tiny but real-shaped stream-json sample (the shapes the classifier maps)
SAMPLE_OUTPUT = "\n".join([
    '{"type":"system","subtype":"init","cwd":"/repo","session_id":"s"}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"working on it"}]}}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}',
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}',
    '{"type":"result","subtype":"success","result":"done"}',
])
SAMPLE_DIFF = "--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-old\n+new\n"


async def _run(client, make_agent, make_task, *, status="exited", exit_code=0, diff=SAMPLE_DIFF):
    agent = await make_agent("Worker", kind="ai")
    task = await make_task("do it", "done when X", assignee_alias="Worker")
    s = await client.post(f"/api/agents/{agent['agent_id']}/runs",
                          json={"wake_kind": "ephemeral", "wake_event": "task_assigned", "task_id": task["id"]})
    assert s.status_code == 201, s.text
    run_id = s.json()["run_id"]
    f = await client.post(f"/api/runs/{run_id}/finish",
                          json={"status": status, "exit_code": exit_code, "output": SAMPLE_OUTPUT, "diff": diff})
    assert f.status_code == 200, f.text
    return agent, task, run_id


async def test_run_feed_data_contract_task_and_agent(client, make_agent, make_task):
    agent, task, run_id = await _run(client, make_agent, make_task)
    for url in (f"/api/tasks/{task['id']}/runs", f"/api/agents/{agent['agent_id']}/runs"):
        r = await client.get(url)
        assert r.status_code == 200, r.text
        runs = r.json()["runs"]
        assert runs, f"{url} returned no runs"
        run = next(x for x in runs if x["run_id"] == run_id)
        assert run["status"] == "exited"
        assert run["exit_code"] == 0
        assert run["output"] and "tool_use" in run["output"]   # the classifier's input
        assert run["diff"] == SAMPLE_DIFF                       # B1.3 source


async def test_watchdog_killed_run_surfaced(client, make_agent, make_task):
    agent, task, run_id = await _run(client, make_agent, make_task, status="killed", exit_code=137)
    r = await client.get(f"/api/tasks/{task['id']}/runs")
    run = next(x for x in r.json()["runs"] if x["run_id"] == run_id)
    assert run["status"] == "killed"   # the feed flags this red


async def test_empty_diff_is_retrievable(client, make_agent, make_task):
    # ISS-8: an edit-undo nets an empty diff — the feed renders 'no net change'.
    agent, task, run_id = await _run(client, make_agent, make_task, diff="")
    r = await client.get(f"/api/agents/{agent['agent_id']}/runs")
    run = next(x for x in r.json()["runs"] if x["run_id"] == run_id)
    assert run["diff"] == ""


# ---------- the run feed adopts the SHARED engine (tasks + agents pages) ----------
# The inline b1* feed + inline SSE client were a parallel implementation; the
# behavioural guarantees live on the one shared engine (classify.ts + useRunStream +
# FilesChanged) consumed by both detail pages.

def test_pages_mount_the_shared_run_engine():
    """Both detail pages render runs via the shared engine — fetch the agent/task /runs
    endpoint and render each run with the shared classifier + diff widget."""
    tasks = (FRONTEND / "pages" / "tasks" / "TasksPage.tsx").read_text()
    assert "useRunStream" in tasks and "FilesChanged" in tasks, "tasks page: doesn't use the shared run engine"
    assert '"/api/tasks/" + encodeURIComponent(tid) + "/runs"' in tasks, "tasks page: doesn't fetch the /runs feed"
    runlog = (FRONTEND / "pages" / "agents" / "runlog.tsx").read_text()
    assert "classifyLine" in runlog and "FilesChanged" in runlog, "agents page: doesn't use the shared run engine"
    assert '"/runs"' in runlog, "agents page: doesn't fetch the /runs feed"


def test_shared_classifier_has_the_full_taxonomy():
    """The classifier lives once in lib/classify.ts (not per page): narration /
    thinking / tool / tool-result / orcha self-actions; the run cards flag
    watchdog-kills (honestly — a human stop reads 'stopped', #299)."""
    cl = (FRONTEND / "lib" / "classify.ts").read_text()
    assert "export function classifyLine" in cl, "classifyLine missing"
    assert "export function selfAction" in cl, "orcha self-action detector missing"
    for token in ("narrate", "think", "tool", "result", "label"):
        assert token in cl, f"shared classifier missing '{token}'"
    for page in ("pages/tasks/TasksPage.tsx", "pages/agents/runlog.tsx"):
        assert "watchdog-killed" in (FRONTEND / page).read_text(), \
            f"{page}: run card doesn't flag a watchdog-killed run"


# ---------- classifier behaviour (moved to Vitest) ----------
# The node-harness cases that eval'd app.js classifyLine now run against the TS
# source in frontend/src/lib/classify.test.ts:
# - container-scoped /api writes + /api/decisions classify as 'decision'
#   (orcha self-action); a read-only poll stays 'tool' (review P3)
# - ISS-85 Codex JSONL: messages/deltas → narrate, function calls → tool,
#   outputs → result, reasoning summaries → think
# - ISS-85 honesty boundary: hidden reasoning renders "reasoning summary
#   unavailable" and never leaks provider-private fields
# - a Codex orcha API call (e.g. wake-ack) classifies as a self-action
