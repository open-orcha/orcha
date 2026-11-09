"""The QA tools take the request: `start_session(request_id)`, `verdict` naming a line, `triage_finding`,
what people told QA in `list_project`, and `orcha qa request`."""

from __future__ import annotations

import asyncio
import json
import types

from orcha_cli import notifier_protocol
from orcha_cli.qa import cli
from test_qa_mcp import make

REQUEST = {"id": "r1", "kind": "check", "platform": "ios", "qa_task_id": "t1", "focus": "The total", "minutes": None, "round": 2,
           "acceptance": ["The total drops"], "finding_ids": [], "scenario_ids": [], "tags": [], "build": {"branch": "feat/x"}}


def run(coro):
    return asyncio.run(coro)


def test_a_request_supplies_the_session_and_lists_what_to_prove():
    tools, portal, _, _ = make()
    tools.portal.get_request = lambda rid: REQUEST
    out = run(tools.start_session(request_id="r1"))
    assert "session started" in out and "request: r1 (round 2)" in out and "0. The total drops" in out and "branch feat/x" in out
    sent = portal.calls_to("POST", "/sessions")[0][2]
    assert (sent["request_id"], sent["kind"], sent["platform"], sent["task_id"]) == ("r1", "check", "ios", "t1")
    bodies = []
    tools.portal.post_verdict = lambda sid, body: bodies.append(body)
    assert "acceptance line 0 pass" in run(tools.verdict(verdict="pass", acceptance_line=0))
    assert bodies[0]["acceptance_line"] == 0 and "scenario_id" not in bodies[0]


def test_a_line_needs_a_request_and_a_verdict_needs_a_subject():
    tools, _, _, _ = make()
    run(tools.start_session("ios", "check", minutes=0))
    assert "no QA request" in run(tools.verdict(verdict="pass", acceptance_line=0))
    assert run(tools.verdict(verdict="pass")).startswith("error:")


def test_a_triage_request_runs_as_a_session_with_no_budget():
    tools, portal, _, _ = make()
    tools.portal.get_request = lambda rid: {**REQUEST, "kind": "triage", "finding_ids": ["f1"], "acceptance": []}
    out = run(tools.start_session(request_id="r1"))
    assert "findings to diagnose: f1" in out and tools.live.budget is None
    assert portal.calls_to("POST", "/sessions")[0][2]["kind"] == "explore"
    tools.portal.triage_finding = lambda fid, body: {"action": "quarantined"}
    assert "quarantined" in run(tools.triage_finding("f1", "flaky", attempts=3, reproductions=1))


def test_list_project_says_what_people_told_qa():
    tools, _, _, _ = make()
    tools.portal.memory = lambda: {"memory": [{"kind": "not_a_bug", "text": "Not a bug: the dot blinks."}]}
    out = run(tools.list_project())
    assert "never reported again" in out and "the dot blinks" in out


def test_the_cli_files_a_request(monkeypatch, capsys):
    calls = []
    portal = types.SimpleNamespace(api_base="http://x", container_id="c", create_request=lambda body, task: calls.append((body, task)) or {
        "request": {"id": "r1", "kind": "check", "platform": "web"}, "qa_task_id": "t2"})
    monkeypatch.setattr(cli, "_identity_and_portal", lambda: (None, portal))
    args = types.SimpleNamespace(task="t1", kind="check", platform="web", finding=[], scenario=[], tag=["smoke"], focus="x", acceptance=["A line"],
                                 minutes=None, on_fail="reopen", branch="b", commit=None, url=None, app_path=None, build_notes=None, json=True)
    assert cli.cmd_request(args) == 0
    body, task = calls[0]
    assert task == "t1" and body["tags"] == ["smoke"] and body["build"] == {"branch": "b"} and body["on_fail"] == "reopen"
    assert json.loads(capsys.readouterr().out)["qa_task_id"] == "t2"


def test_a_qa_steps_prompt_names_the_skill_and_asks_for_no_outcome():
    workflow = {"title": "W", "id": "w", "goal": "G", "step_number": 1, "tasks": [],
                "round_context": {"task_id": "t", "outcomes": [{"name": "pass"}], "group": None},
                "qa": {"skill": "/orcha-qa-check", "request_id": "r1", "approved_by": "Hussein", "acceptance": ["A line"]}}
    text = notifier_protocol._render_workflow(workflow)
    assert "/orcha-qa-check" in text and 'request_id="r1"' in text and "Do not report an outcome" in text
    assert "report exactly one outcome" not in text and "approval of your plan" in text
