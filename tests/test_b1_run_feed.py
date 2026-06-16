"""FT-SURFACE (B1) — portal worker-progress feed.

B1 is a frontend consumer of the existing A2/ISS-8 /runs endpoints, so the
automatable surface is (a) the data contract the feed renders — a worker run is
retrievable via GET /runs with its status/exit/output/diff, and a watchdog-killed
run surfaces status='killed' — and (b) that both detail pages render runs through the
SHARED app.js engine (runCard / activateRuns / startRunStream / classifyLine). The
full 9-type visual is verified live after a code-touching wake.
"""
import json
import pathlib
import re
import shutil
import subprocess
import pytest

pytestmark = pytest.mark.asyncio

REPO = pathlib.Path(__file__).resolve().parent.parent
STATIC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static"

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


# ---------- the run feed adopts the SHARED engine (D3 agents + D4 tasks) ----------
# The inline b1* feed + inline SSE client were a parallel implementation; D3 (agents.html)
# and D4 (tasks.html) both retired it for the shared app.js engine (runCard / activateRuns /
# startRunStream / classifyLine). The behavioural guarantees now live on that one engine —
# repaint-preservation (ISS-46/ISS-53) is covered by test_d1_data_adapter (Orcha.patch).

def test_pages_mount_the_shared_run_engine():
    """Both detail pages render runs via the shared engine — fetch the agent/task /runs
    endpoint and render each run with O.runCard + O.activateRuns (live stream + diffs)."""
    for page in ("tasks.html", "agents.html"):
        html = (STATIC / page).read_text()
        assert "O.runCard(" in html and "O.activateRuns(" in html, f"{page}: doesn't use the shared run engine"
        assert "/runs" in html, f"{page}: doesn't fetch the /runs feed"


def test_shared_classifier_has_the_full_taxonomy():
    """The classifier lives once in app.js classifyLine (not per page): narration /
    thinking / tool / tool-result / orcha self-actions; the run card flags watchdog-kills."""
    app = (STATIC / "app.js").read_text()
    assert re.search(r"function classifyLine\(line\) \{", app), "classifyLine missing"
    for token in ("narrate", "think", "tool", "result", "selfAction", "label"):
        assert token in app, f"shared classifier missing '{token}'"
    assert "watchdog-killed" in app, "run card doesn't flag a watchdog-killed run"


def _classify(line: str):
    """Run the SHARED app.js classifyLine on one stream-json line via node; returns the
    first classified entry (None if node is unavailable)."""
    app = (STATIC / "app.js").read_text()
    harness = (
        "global.localStorage={getItem:()=>null,setItem:()=>{}};"
        "global.document={documentElement:{setAttribute(){}},addEventListener(){},getElementById:()=>null,"
        "createElement:()=>({classList:{add(){},remove(){}},addEventListener(){},style:{},appendChild(){}}),body:{appendChild(){}}};"
        "global.window={};\n" + app +
        "\nconst e=window.Orcha.classifyLine(process.argv[1]);console.log(JSON.stringify(e[0]||{}));"
    )
    out = subprocess.run(["node", "-e", harness, "--", line], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip())


def _classify_type(line: str):
    return _classify(line).get("type")


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_classifier_tags_container_scoped_request_as_selfaction():
    """Review P3: an /orcha-* write (POST /api/containers/{cid}/requests|tasks, or
    /api/decisions) classifies as an orcha SELF-ACTION (type 'decision'); a read-only
    poll is a plain 'tool'."""
    def tool_line(cmd):
        return json.dumps({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Bash", "input": {"command": cmd}}]}})
    assert _classify_type(tool_line("curl -X POST http://x:8000/api/containers/abc/requests -d @x")) == "decision"
    assert _classify_type(tool_line("curl -X POST http://x:8000/api/containers/abc/tasks -d @x")) == "decision"
    assert _classify_type(tool_line("curl -X POST http://x:8000/api/decisions -d @x")) == "decision"
    assert _classify_type(tool_line("curl http://x:8000/api/agents/a1/wait?since_ts=0")) == "tool"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_classifier_maps_codex_messages_tools_results_and_reasoning():
    """ISS-85: Codex JSONL gets the same portal run-feed taxonomy as Claude where its
    public stream exposes equivalent data."""
    msg = _classify(json.dumps({
        "type": "item.completed",
        "item": {
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "working from codex"}],
        },
    }))
    assert msg["type"] == "narrate"
    assert msg["label"] == "narration"
    assert msg["text"] == "working from codex"

    delta = _classify(json.dumps({"type": "response.output_text.delta", "delta": "still working"}))
    assert delta["type"] == "narrate"
    assert delta["label"] == "narration"
    assert delta["text"] == "still working"

    call = _classify(json.dumps({
        "type": "item.started",
        "item": {"type": "function_call", "name": "shell", "arguments": "{\"cmd\":\"ls\"}"},
    }))
    assert call["type"] == "tool"
    assert call["label"] == "tool"
    assert call["text"] == "shell"
    assert "ls" in call["detail"]

    result = _classify(json.dumps({
        "type": "item.completed",
        "item": {"type": "function_call_output", "output": "ok"},
    }))
    assert result["type"] == "result"
    assert result["label"] == "tool result"
    assert result["detail"] == "ok"

    reasoning = _classify(json.dumps({
        "type": "item.completed",
        "item": {"type": "reasoning", "summary": [{"type": "summary_text", "text": "checked repo state"}]},
    }))
    assert reasoning["type"] == "think"
    assert reasoning["label"] == "reasoning"
    assert reasoning["text"] == "checked repo state"

    reasoning_delta = _classify(json.dumps({
        "type": "response.reasoning_summary_text.delta",
        "delta": "summarized plan",
    }))
    assert reasoning_delta["type"] == "think"
    assert reasoning_delta["label"] == "reasoning"
    assert reasoning_delta["text"] == "summarized plan"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_classifier_codex_reasoning_without_summary_is_explicit_not_fabricated():
    """ISS-85 honesty boundary: hidden reasoning is represented as unavailable instead
    of being rendered from provider-private/raw fields."""
    reasoning = _classify(json.dumps({
        "type": "item.completed",
        "item": {
            "type": "reasoning",
            "encrypted_content": "secret",
            "content": "do not expose this as a summary",
        },
    }))
    assert reasoning["type"] == "think"
    assert reasoning["label"] == "reasoning"
    assert reasoning["text"] == "reasoning summary unavailable"
    assert "provider did not expose raw reasoning" in reasoning["detail"]
    assert "secret" not in json.dumps(reasoning)
    assert "do not expose" not in json.dumps(reasoning)


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_classifier_tags_codex_orcha_calls_as_selfaction():
    line = json.dumps({
        "type": "item.started",
        "item": {
            "type": "function_call",
            "name": "shell",
            "arguments": "curl -X POST http://x:8000/api/agents/a1/wake-ack -d @x",
        },
    })
    assert _classify_type(line) == "decision"
