import json
import logging
import pathlib

import pytest

import main

pytestmark = pytest.mark.asyncio

REPO = pathlib.Path(__file__).resolve().parent.parent


async def _post_sse(client, body, *, max_events=10):
    events = []
    async with client.stream("POST", "/api/onboarding/propose", json=body) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        async for line in resp.aiter_lines():
            line = line.strip()
            if not line.startswith("data:"):
                continue
            events.append(json.loads(line[len("data:"):].strip()))
            if events[-1].get("event") == "done" or len(events) >= max_events:
                break
    return events


def _tool_stream(name, payload, *, text="Drafting the roster...\n"):
    yield {"type": "text_delta", "text": text}
    yield {"type": "tool_start", "index": 0, "name": name, "id": "tool-1"}
    yield {"type": "tool_input_delta", "index": 0, "partial_json": json.dumps(payload)}
    yield {"type": "tool_stop", "index": 0}


def _forced_dialogue():
    return [
        {"role": "assistant", "content": "Who is the audience?"},
        {"role": "user", "content": "Clinic admins"},
        {"role": "assistant", "content": "What systems matter?"},
        {"role": "user", "content": "Scheduling, intake, billing"},
        {"role": "assistant", "content": "What constraints matter?"},
        {"role": "user", "content": "Start with a small team"},
    ]


def _valid_roster():
    return {
        "rationale": "A lead agent plans the workspace, then a builder ships the first slice.",
        "agents": [
            {
                "name": "Atlas",
                "role": "Lead planner",
                "charter": "Plan the work, coordinate through Orcha requests, and stop at needs_verification.",
                "model_hint": "claude-sonnet-5",
            },
            {
                "name": "Forge",
                "role": "Builder",
                "charter": "Implement assigned tasks, ask teammates through Orcha requests, and stop at needs_verification.",
                "model_hint": "not-a-real-model",
            },
        ],
        "tasks": [
            {
                "title": "Map the first-run drop-off",
                "definition_of_done": "A concise map of the current first-run journey and the highest-friction point.",
                "assignee": "Atlas",
                "depends_on": [],
                "protocol": {"review_chain": "Lens -> Gate -> Helm", "notes": "Keep the human in the loop."},
                "is_kickoff": True,
            },
            {
                "title": "Ship the first fix",
                "definition_of_done": "The highest-friction onboarding point is fixed and ready for verification.",
                "assignee": "Forge",
                "depends_on": ["Map the first-run drop-off"],
                "protocol": None,
                "is_kickoff": True,
            },
        ],
    }


async def test_onboarding_propose_streams_roster_with_onboarding_model_override(
    client, container, db, monkeypatch
):
    db.execute(
        "INSERT INTO container_model_settings(container_id, use_case_key, provider, model) "
        "VALUES (%s, 'onboarding', 'anthropic', %s)",
        (container["id"], main.llm_util.MODEL_HAIKU),
    )
    monkeypatch.setenv("ORCHA_LLM_API_KEY", "sk-test")

    seen = {}

    def fake_stream(use_case, *, system, messages, tools, tool_choice=None, config=None, api_key=None, provider=None):
        seen.update({
            "use_case": use_case,
            "system": system,
            "messages": messages,
            "tools": [t["name"] for t in tools],
            "tool_choice": tool_choice,
            "config": config,
            "api_key": api_key,
        })
        yield from _tool_stream("propose_roster", _valid_roster())

    monkeypatch.setattr(main.llm_util, "stream_tool_call", fake_stream)

    frames = await _post_sse(client, {"cid": container["id"], "goal": "Improve first-run onboarding"})

    assert [f["event"] for f in frames] == ["thinking", "roster", "done"]
    roster = frames[1]
    assert roster["rationale"].startswith("A lead agent")
    assert [a["name"] for a in roster["agents"]] == ["Atlas", "Forge"]
    assert roster["agents"][0]["model_hint"] == "claude-sonnet-5"
    assert roster["agents"][1]["model_hint"] is None
    assert roster["tasks"][1]["depends_on"] == ["Map the first-run drop-off"]
    assert roster["tasks"][0]["protocol"]["review_chain"] == "Lens -> Gate -> Helm"

    assert seen["use_case"] == "onboarding"
    assert seen["tools"] == ["ask_clarifying_questions", "propose_roster"]
    assert seen["tool_choice"] is None
    assert seen["config"] == {"onboarding": {"provider": "anthropic", "model": main.llm_util.MODEL_HAIKU}}
    assert seen["api_key"] == "sk-test"
    assert "Each assignee with tasks must have exactly one kickoff task" in seen["system"]
    assert seen["messages"][0]["content"].endswith("Improve first-run onboarding")


async def test_onboarding_propose_can_return_clarify_turn(client, container, monkeypatch):
    monkeypatch.setenv("ORCHA_LLM_API_KEY", "sk-test")

    def fake_stream(*_, **__):
        yield from _tool_stream("ask_clarifying_questions", {
            "questions": [
                {"id": "audience", "prompt": "Who is the main audience?"},
                {"id": "deadline", "prompt": "Is there a launch date?"},
            ],
        })

    monkeypatch.setattr(main.llm_util, "stream_tool_call", fake_stream)

    frames = await _post_sse(client, {"cid": container["id"], "goal": "Launch a customer portal"})

    assert [f["event"] for f in frames] == ["thinking", "clarify", "done"]
    assert frames[1]["questions"] == [
        {"id": "audience", "prompt": "Who is the main audience?"},
        {"id": "deadline", "prompt": "Is there a launch date?"},
    ]


async def test_onboarding_propose_forces_roster_after_three_clarify_questions(client, container, monkeypatch):
    monkeypatch.setenv("ORCHA_LLM_API_KEY", "sk-test")
    seen = {}

    def fake_stream(use_case, *, tools, tool_choice=None, **kwargs):
        seen["tools"] = [t["name"] for t in tools]
        seen["tool_choice"] = tool_choice
        yield from _tool_stream("propose_roster", _valid_roster())

    monkeypatch.setattr(main.llm_util, "stream_tool_call", fake_stream)
    dialogue = [
        {"role": "assistant", "content": "Who is the audience?"},
        {"role": "user", "content": "New admins"},
        {"role": "assistant", "content": "What deadline?"},
        {"role": "user", "content": "This month"},
        {"role": "assistant", "content": "What constraints matter?"},
        {"role": "user", "content": "Keep setup simple"},
    ]

    frames = await _post_sse(client, {"cid": container["id"], "goal": "Launch onboarding", "dialogue": dialogue})

    assert [f["event"] for f in frames] == ["thinking", "roster", "done"]
    assert seen["tools"] == ["propose_roster"]
    assert seen["tool_choice"] == {"type": "tool", "name": "propose_roster"}


async def test_onboarding_propose_reports_truncated_for_max_tokens(
    client, container, monkeypatch, caplog
):
    monkeypatch.setenv("ORCHA_LLM_API_KEY", "sk-test")

    def fake_stream(*_, **__):
        yield {"type": "tool_start", "index": 0, "name": "propose_roster", "id": "tool-1"}
        yield {"type": "tool_input_delta", "index": 0, "partial_json": '{"rationale":"large roster",'}
        yield {"type": "usage", "output_tokens": 8192, "stop_reason": "max_tokens"}

    monkeypatch.setattr(main.llm_util, "stream_tool_call", fake_stream)

    with caplog.at_level(logging.WARNING, logger="orcha.onboarding"):
        frames = await _post_sse(
            client,
            {"cid": container["id"], "goal": "Staff a full EHR workspace", "dialogue": _forced_dialogue()},
        )

    assert [f["event"] for f in frames] == ["error", "done"]
    assert frames[0]["code"] == "roster_truncated"
    assert "output limit" in frames[0]["message"]
    messages = [r.getMessage() for r in caplog.records if r.name == "orcha.onboarding"]
    assert any("stop_reason=max_tokens" in m and "tool_completed=False" in m for m in messages)


async def test_onboarding_propose_reports_truncated_for_bad_forced_tool_json(
    client, container, monkeypatch
):
    monkeypatch.setenv("ORCHA_LLM_API_KEY", "sk-test")

    def fake_stream(*_, **__):
        yield {"type": "tool_start", "index": 0, "name": "propose_roster", "id": "tool-1"}
        yield {"type": "tool_input_delta", "index": 0, "partial_json": '{"rationale":'}
        yield {"type": "tool_stop", "index": 0}

    monkeypatch.setattr(main.llm_util, "stream_tool_call", fake_stream)

    frames = await _post_sse(
        client,
        {"cid": container["id"], "goal": "Staff a full EHR workspace", "dialogue": _forced_dialogue()},
    )

    assert [f["event"] for f in frames] == ["error", "done"]
    assert frames[0]["code"] == "roster_truncated"


async def test_onboarding_propose_repairs_forward_dependency(client, container, monkeypatch):
    monkeypatch.setenv("ORCHA_LLM_API_KEY", "sk-test")
    roster = _valid_roster()
    roster["tasks"][0]["depends_on"] = ["Ship the first fix"]

    def fake_stream(*_, **__):
        yield from _tool_stream("propose_roster", roster)

    monkeypatch.setattr(main.llm_util, "stream_tool_call", fake_stream)

    frames = await _post_sse(client, {"cid": container["id"], "goal": "Improve onboarding"})

    assert [f["event"] for f in frames] == ["thinking", "roster", "done"]
    assert frames[1]["tasks"][0]["depends_on"] == []


async def test_onboarding_propose_promotes_missing_kickoff(client, container, monkeypatch):
    monkeypatch.setenv("ORCHA_LLM_API_KEY", "sk-test")
    roster = _valid_roster()
    roster["tasks"][0]["is_kickoff"] = False

    def fake_stream(*_, **__):
        yield from _tool_stream("propose_roster", roster)

    monkeypatch.setattr(main.llm_util, "stream_tool_call", fake_stream)

    frames = await _post_sse(client, {"cid": container["id"], "goal": "Improve onboarding"})

    assert [f["event"] for f in frames] == ["thinking", "roster", "done"]
    assert frames[1]["tasks"][0]["assignee"] == "Atlas"
    assert frames[1]["tasks"][0]["is_kickoff"] is True


async def test_onboarding_propose_keeps_first_of_multiple_kickoffs(client, container, monkeypatch):
    monkeypatch.setenv("ORCHA_LLM_API_KEY", "sk-test")
    roster = _valid_roster()
    roster["tasks"][1]["assignee"] = "Atlas"
    roster["tasks"][1]["is_kickoff"] = True

    def fake_stream(*_, **__):
        yield from _tool_stream("propose_roster", roster)

    monkeypatch.setattr(main.llm_util, "stream_tool_call", fake_stream)

    frames = await _post_sse(client, {"cid": container["id"], "goal": "Improve onboarding"})

    assert [f["event"] for f in frames] == ["thinking", "roster", "done"]
    assert frames[1]["tasks"][0]["is_kickoff"] is True
    assert frames[1]["tasks"][1]["is_kickoff"] is False


async def test_onboarding_propose_no_key_is_sse_error(client, container, monkeypatch):
    monkeypatch.delenv("ORCHA_LLM_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    frames = await _post_sse(client, {"cid": container["id"], "goal": "Improve onboarding"})

    assert frames == [
        {
            "event": "error",
            "code": "no_api_key",
            "message": "No model API key is configured for this workspace yet. Add one in Settings or set ORCHA_LLM_API_KEY.",
        },
        {"event": "done"},
    ]


async def test_onboarding_propose_logs_sse_error_frames(client, container, monkeypatch, caplog):
    monkeypatch.delenv("ORCHA_LLM_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    with caplog.at_level(logging.WARNING, logger="orcha.onboarding"):
        frames = await _post_sse(client, {"cid": container["id"], "goal": "Improve onboarding"})

    assert frames[0]["event"] == "error"
    messages = [r.getMessage() for r in caplog.records if r.name == "orcha.onboarding"]
    assert any("code=no_api_key" in m and "No model API key is configured" in m for m in messages)


async def test_onboarding_propose_rejects_invalid_roster_tool_output(client, container, monkeypatch):
    monkeypatch.setenv("ORCHA_LLM_API_KEY", "sk-test")
    bad = _valid_roster()
    bad["tasks"][0]["assignee"] = "MissingAgent"

    def fake_stream(*_, **__):
        yield from _tool_stream("propose_roster", bad)

    monkeypatch.setattr(main.llm_util, "stream_tool_call", fake_stream)

    frames = await _post_sse(client, {"cid": container["id"], "goal": "Improve onboarding"})

    assert [f["event"] for f in frames] == ["thinking", "error", "done"]
    assert frames[1]["code"] == "invalid_goal"
    assert "MissingAgent" in frames[1]["message"]


async def test_onboarding_propose_is_in_openapi(client):
    r = await client.get("/openapi.json")
    assert r.status_code == 200, r.text
    spec = r.json()
    assert "/api/onboarding/propose" in spec["paths"]
    assert sorted(spec["paths"]["/api/onboarding/propose"]) == ["post"]
    body_ref = spec["paths"]["/api/onboarding/propose"]["post"]["requestBody"]["content"]["application/json"]["schema"]["$ref"]
    assert body_ref.endswith("/ProposeBody")


async def test_postman_collection_includes_onboarding_propose():
    coll = json.loads((REPO / "docs" / "orcha.postman_collection.json").read_text())
    requests = []
    for folder in coll["item"]:
        for item in folder.get("item", []):
            if "request" in item:
                requests.append((folder["name"], item["name"], item["request"]["method"], item["request"]["url"]["raw"]))
    assert (
        "Onboarding",
        "Propose roster (SPEC-292 SSE)",
        "POST",
        "{{baseUrl}}/api/onboarding/propose",
    ) in requests
