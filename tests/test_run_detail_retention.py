"""Worker-run weight: the lightweight ?view=summary runs list, and per-agent retention of
run detail (output, diff, line log) beyond each agent's newest RUN_DETAIL_KEEP_PER_AGENT runs.

The openorcha portal stalled ("Can't reach Embodent") while the notifier's terminal-worktree
sweep read ~138MB of full run rows every loop, from a 3GB DB that never pruned run detail.
"""
import pytest

from portal_backend import worker_run_support

pytestmark = pytest.mark.asyncio

BIG_OUTPUT = "x" * 5000 + "TAIL-MARKER"
DIFF = "--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-old\n+new\n"


async def _finished_run(client, agent_id, task_id, *, finish=True):
    s = await client.post(f"/api/agents/{agent_id}/runs",
                          json={"wake_kind": "ephemeral", "wake_event": "task_assigned",
                                "task_id": task_id})
    assert s.status_code == 201, s.text
    run_id = s.json()["run_id"]
    r = await client.post(f"/api/runs/{run_id}/lines", json={"start_seq": 1, "lines": ["a", "b"]})
    assert r.status_code == 200, r.text
    if finish:
        f = await client.post(f"/api/runs/{run_id}/finish",
                              json={"status": "exited", "exit_code": 0,
                                    "output": BIG_OUTPUT, "diff": DIFF,
                                    "input_tokens": 10, "output_tokens": 5})
        assert f.status_code == 200, f.text
    return run_id


def _detail(db, run_id):
    row = db.execute("SELECT output, diff, input_tokens, status FROM worker_runs WHERE run_id=%s",
                     (run_id,))[0]
    lines = db.execute("SELECT count(*) AS n FROM worker_run_lines WHERE run_id=%s", (run_id,))
    return row, int(lines[0]["n"])


async def test_task_runs_summary_view_drops_output_and_diff(client, make_agent, make_task):
    agent = await make_agent("Worker", kind="ai")
    task = await make_task("do it", "done when X", assignee_alias="Worker")
    run_id = await _finished_run(client, agent["agent_id"], task["id"])

    full = (await client.get(f"/api/tasks/{task['id']}/runs")).json()["runs"]
    assert full[0]["output"] == BIG_OUTPUT and full[0]["diff"] == DIFF   # default unchanged

    r = await client.get(f"/api/tasks/{task['id']}/runs?view=summary")
    assert r.status_code == 200, r.text
    run = r.json()["runs"][0]
    assert run["run_id"] == run_id and run["status"] == "exited"
    assert run["output"] is None and run["diff"] is None

    bad = await client.get(f"/api/tasks/{task['id']}/runs?view=everything")
    assert bad.status_code == 422


async def test_finish_prunes_detail_beyond_newest_runs(client, make_agent, make_task, db,
                                                       monkeypatch):
    monkeypatch.setattr(worker_run_support, "RUN_DETAIL_KEEP_PER_AGENT", 3)
    agent = await make_agent("Worker", kind="ai")
    other = await make_agent("Other", kind="ai")
    task = await make_task("do it", "done when X", assignee_alias="Worker")

    other_run = await _finished_run(client, other["agent_id"], task["id"])
    old_running = await _finished_run(client, agent["agent_id"], task["id"], finish=False)
    runs = [await _finished_run(client, agent["agent_id"], task["id"]) for _ in range(5)]

    # the two oldest finished runs lost their detail but kept their row and stats
    for run_id in runs[:2]:
        row, lines = _detail(db, run_id)
        assert lines == 0 and row["diff"] is None
        assert row["output"].endswith("TAIL-MARKER") and len(row["output"]) == 4096
        assert row["input_tokens"] == 10 and row["status"] == "exited"
    # the newest three keep everything
    for run_id in runs[2:]:
        row, lines = _detail(db, run_id)
        assert lines == 2 and row["diff"] == DIFF and row["output"] == BIG_OUTPUT
    # a still-running run is never pruned, nor is another agent's run
    for run_id in (old_running, other_run):
        _row, lines = _detail(db, run_id)
        assert lines == 2


async def test_prune_is_batched(client, make_agent, make_task, db, monkeypatch):
    agent = await make_agent("Worker", kind="ai")
    task = await make_task("do it", "done when X", assignee_alias="Worker")
    monkeypatch.setattr(worker_run_support, "RUN_DETAIL_KEEP_PER_AGENT", 1000)  # build a backlog
    runs = [await _finished_run(client, agent["agent_id"], task["id"]) for _ in range(4)]

    monkeypatch.setattr(worker_run_support, "RUN_DETAIL_KEEP_PER_AGENT", 1)
    monkeypatch.setattr(worker_run_support, "RUN_DETAIL_PRUNE_BATCH", 2)
    await _finished_run(client, agent["agent_id"], task["id"])      # one finish → two pruned,
    assert [_detail(db, run_id)[1] for run_id in runs] == [0, 0, 2, 2]   # oldest first

    await _finished_run(client, agent["agent_id"], task["id"])      # the next finish drains more
    assert all(_detail(db, run_id)[1] == 0 for run_id in runs)
