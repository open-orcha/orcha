"""Reply style (mig 102 / sqlite 032): the project setting, the per-thread overrides and the
prompt section agents get.

Storage: projects default to Normal; owners (or manage_agents) change it; any human member sets
or clears a conversation / task override; AI agents and viewers cannot; every change is logged.
Prompt: GET /protocol carries {project, task, conversation}; the notifier picks the thread value
by lane (thread beats project), Normal adds nothing, and each style keeps the fixed rules (exact
code/paths/quotes, one Normal reply on "elaborate", GitHub and agent-to-agent stay Normal, plans
never Caveman). Everything is in /openapi.json.
"""
import pytest

from orcha_cli import notifier
from orcha_cli.notifier_reply_style import (
    ASD_STE100_SECTION,
    CAVEMAN_SECTION,
    resolve_reply_style,
    reply_style_section,
)
from test_evidence_pack import HUBOT, OCTO, VERA, _members

PERSONA = {"system_prompt": "You are Tim."}


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    monkeypatch.setenv("ORCHA_PLAN", "team")


async def _conversation(client, aid, human_id):
    r = await client.post(f"/api/agents/{aid}/conversations", json={"actor_agent_id": human_id})
    assert r.status_code in (200, 201), r.text
    return r.json()["conversation"]["id"]


# ------------------------------------------------------------------ storage + API

async def test_project_setting_defaults_normal_and_is_saved_and_logged(client, container, make_agent, db):
    cid = container["id"]
    human = await make_agent("operator", kind="human")
    url = f"/api/containers/{cid}/reply-style"
    assert (await client.get(url)).json() == {"container_id": cid, "reply_style": "normal"}

    r = await client.put(url, json={"reply_style": "caveman", "actor_agent_id": human["agent_id"]})
    assert r.status_code == 200 and r.json()["reply_style"] == "caveman"
    assert (await client.get(url)).json()["reply_style"] == "caveman"
    row = db.execute("SELECT reply_style FROM containers WHERE id=%s", (cid,))[0]
    assert row["reply_style"] == "caveman"

    # same value again: saved, not logged twice
    await client.put(url, json={"reply_style": "caveman", "actor_agent_id": human["agent_id"]})
    await client.put(url, json={"reply_style": "asd_ste100", "actor_agent_id": human["agent_id"]})
    ev = db.execute("SELECT detail FROM events WHERE container_id=%s AND event_type='reply_style_changed' "
                    "ORDER BY id", (cid,))
    assert [e["detail"] for e in ev] == [
        {"scope": "project", "before": "normal", "after": "caveman"},
        {"scope": "project", "before": "caveman", "after": "asd_ste100"},
    ]


async def test_project_setting_is_validated_and_human_only(client, container, make_agent):
    cid = container["id"]
    human = await make_agent("operator", kind="human")
    ai = await make_agent("builder")
    url = f"/api/containers/{cid}/reply-style"
    assert (await client.put(url, json={"reply_style": "pirate", "actor_agent_id": human["agent_id"]})).status_code == 422
    assert (await client.put(url, json={"reply_style": None, "actor_agent_id": human["agent_id"]})).status_code == 422
    assert (await client.put(url, json={"reply_style": "caveman", "actor_agent_id": ai["agent_id"]})).status_code == 403
    assert (await client.get(url)).json()["reply_style"] == "normal"


async def test_project_setting_needs_owner_or_manage_agents_under_proxy(client, container, make_agent, trust_proxy):
    cid = container["id"]
    await _members(client, cid, make_agent)
    url = f"/api/containers/{cid}/reply-style"
    for who in (HUBOT, VERA):  # plain member, viewer
        assert (await client.put(url, json={"reply_style": "caveman"}, headers=who)).status_code == 403
    assert (await client.put(url, json={"reply_style": "caveman"}, headers=OCTO)).status_code == 200
    assert (await client.get(url, headers=VERA)).json()["reply_style"] == "caveman"  # viewers read
    stranger = {"X-Auth-Request-User": "mallory"}
    assert (await client.get(url, headers=stranger)).status_code == 403


async def test_task_override_beats_project_and_clears_back(client, container, make_agent, make_task, db):
    cid = container["id"]
    human = await make_agent("operator", kind="human")
    task = await make_task("t", "dod")
    url = f"/api/tasks/{task['id']}/reply-style"
    got = (await client.get(url)).json()
    assert got["override"] is None and got["effective_reply_style"] == "normal"

    await client.put(f"/api/containers/{cid}/reply-style",
                     json={"reply_style": "caveman", "actor_agent_id": human["agent_id"]})
    r = await client.put(url, json={"reply_style": "asd_ste100", "actor_agent_id": human["agent_id"]})
    assert r.status_code == 200
    assert r.json() == {"thread_kind": "task", "thread_id": task["id"], "container_id": cid,
                        "override": "asd_ste100", "project_reply_style": "caveman",
                        "effective_reply_style": "asd_ste100"}
    # an explicit Normal override is kept apart from "no override"
    r = await client.put(url, json={"reply_style": "normal", "actor_agent_id": human["agent_id"]})
    assert r.json()["override"] == "normal" and r.json()["effective_reply_style"] == "normal"
    r = await client.put(url, json={"reply_style": None, "actor_agent_id": human["agent_id"]})
    assert r.json()["override"] is None and r.json()["effective_reply_style"] == "caveman"
    ev = db.execute("SELECT entity_type, detail FROM events WHERE container_id=%s "
                    "AND event_type='reply_style_changed' AND entity_type='task' ORDER BY id", (cid,))
    assert [e["detail"]["after"] for e in ev] == ["asd_ste100", "normal", None]


async def test_conversation_override_and_permissions(client, container, make_agent, make_task):
    human = await make_agent("operator", kind="human")
    ai = await make_agent("builder")
    conv = await _conversation(client, ai["agent_id"], human["agent_id"])
    url = f"/api/conversations/{conv}/reply-style"
    r = await client.put(url, json={"reply_style": "caveman", "actor_agent_id": ai["agent_id"]})
    assert r.status_code == 403  # agents never change a person's reply style
    r = await client.put(url, json={"reply_style": "caveman", "actor_agent_id": human["agent_id"]})
    assert r.status_code == 200 and r.json()["effective_reply_style"] == "caveman"
    assert (await client.put(url, json={"reply_style": "loud", "actor_agent_id": human["agent_id"]})).status_code == 422
    assert (await client.get("/api/conversations/not-a-uuid/reply-style")).status_code == 400
    assert (await client.get("/api/tasks/00000000-0000-4000-8000-000000000000/reply-style")).status_code == 404


async def test_viewer_cannot_change_thread_style_under_proxy(client, container, make_agent, make_task, trust_proxy):
    cid = container["id"]
    await _members(client, cid, make_agent)
    task = await make_task("t", "dod")
    url = f"/api/tasks/{task['id']}/reply-style"
    assert (await client.put(url, json={"reply_style": "caveman"}, headers=VERA)).status_code == 403
    assert (await client.put(url, json={"reply_style": "caveman"}, headers=HUBOT)).status_code == 200


async def test_protocol_carries_project_and_thread_styles(client, container, make_agent, make_task):
    cid = container["id"]
    human = await make_agent("operator", kind="human")
    ai = await make_agent("builder")
    task = await make_task("t", "dod", assignee_alias="builder")
    proto = (await client.get(f"/api/agents/{ai['agent_id']}/protocol?task_id={task['id']}")).json()
    assert proto["reply_style"] == {"project": "normal", "task": None, "conversation": None}

    await client.put(f"/api/containers/{cid}/reply-style",
                     json={"reply_style": "asd_ste100", "actor_agent_id": human["agent_id"]})
    await client.put(f"/api/tasks/{task['id']}/reply-style",
                     json={"reply_style": "caveman", "actor_agent_id": human["agent_id"]})
    conv = await _conversation(client, ai["agent_id"], human["agent_id"])
    await client.put(f"/api/conversations/{conv}/reply-style",
                     json={"reply_style": "normal", "actor_agent_id": human["agent_id"]})
    proto = (await client.get(f"/api/agents/{ai['agent_id']}/protocol?task_id={task['id']}")).json()
    assert proto["reply_style"] == {"project": "asd_ste100", "task": "caveman", "conversation": "normal"}

    # no task resolves (idle agent): the project + conversation values still ride
    idle = await make_agent("idle")
    proto = (await client.get(f"/api/agents/{idle['agent_id']}/protocol")).json()
    assert proto["task_id"] is None
    assert proto["reply_style"] == {"project": "asd_ste100", "task": None, "conversation": None}


async def test_openapi_documents_the_reply_style_routes(client):
    spec = (await client.get("/openapi.json")).json()
    paths = spec["paths"]
    for path in ("/api/containers/{cid}/reply-style", "/api/conversations/{conv_id}/reply-style",
                 "/api/tasks/{tid}/reply-style"):
        assert {"get", "put"} <= set(paths[path]), path
    schemas = spec["components"]["schemas"]
    assert schemas["ProjectReplyStyleUpdate"]["properties"]["reply_style"]["enum"] == [
        "normal", "caveman", "asd_ste100"]
    thread = schemas["ThreadReplyStyle"]["properties"]
    assert {"override", "project_reply_style", "effective_reply_style"} <= set(thread)


# ------------------------------------------------------------------ prompt injection

def test_resolve_thread_beats_project_per_lane():
    block = {"project": "caveman", "task": "asd_ste100", "conversation": "normal"}
    assert resolve_reply_style(block, "work") == "asd_ste100"
    assert resolve_reply_style(block, "conversation") == "normal"  # explicit Normal override wins
    assert resolve_reply_style({"project": "caveman", "task": None}, "work") == "caveman"
    assert resolve_reply_style({"project": "caveman", "conversation": None}, "conversation") == "caveman"
    # a task override never leaks into the conversation lane, and vice versa
    assert resolve_reply_style({"project": "normal", "task": "caveman"}, "conversation") == "normal"
    assert resolve_reply_style({"project": "normal", "conversation": "caveman"}, "work") == "normal"
    # missing / unknown values fall back safely
    assert resolve_reply_style(None) == "normal"
    assert resolve_reply_style({"project": "pirate", "task": "loud"}) == "normal"


def test_normal_adds_nothing_to_the_prompt():
    base = notifier.format_persona(PERSONA, None)
    for proto in (None, {"reply_style": {"project": "normal"}},
                  {"reply_style": {"project": "caveman", "task": "normal"}}):
        assert notifier.format_persona(PERSONA, None, proto) == base
    assert reply_style_section("normal") is None and reply_style_section(None) is None
    assert "Reply style" not in base


@pytest.mark.parametrize("style,section,marker", [
    ("caveman", CAVEMAN_SECTION, "Drop articles, filler"),
    ("asd_ste100", ASD_STE100_SECTION, "25 words or fewer"),
])
def test_style_section_rides_right_after_the_guardrail(style, section, marker):
    out = notifier.format_persona(PERSONA, None, {"reply_style": {"project": style}})
    assert section in out and marker in out
    guard = out.index("Talking to humans")
    assert guard < out.index(section) < out.index("Multi-human steering")
    # the conversation lane reads the same project setting
    conv = notifier.format_persona(PERSONA, None, {"reply_style": {"project": style}}, lane="conversation")
    assert section in conv
    # no persona = not booting as an agent = no style either (like the guardrail)
    assert notifier.format_persona(None, {"digest": {"current_focus": "X"}},
                                   {"reply_style": {"project": style}}).count("Reply style") == 0


def test_thread_override_changes_the_injected_style():
    proto = {"reply_style": {"project": "caveman", "task": "asd_ste100", "conversation": "normal"}}
    work = notifier.format_persona(PERSONA, None, proto, lane="work")
    assert ASD_STE100_SECTION in work and CAVEMAN_SECTION not in work
    conv = notifier.format_persona(PERSONA, None, proto, lane="conversation")
    assert "Reply style" not in conv


@pytest.mark.parametrize("section", [CAVEMAN_SECTION, ASD_STE100_SECTION])
def test_every_style_keeps_the_fixed_rules(section):
    # exact content
    assert "code, commands, error text, file paths, quotes" in section
    # one-reply elaborate override, then back
    assert "elaborate" in section and "Return to this style on the next reply" in section
    # scope: every human-facing lane
    for lane in ("conversation replies", "task-thread posts", "plans", "verification"):
        assert lane in section
    # out of scope: public GitHub posts and agent-to-agent traffic stay Normal
    assert "GitHub posts" in section and "commit messages" in section
    assert "messages to other agents" in section


def test_plans_never_use_caveman():
    assert "never write a plan" in CAVEMAN_SECTION
    assert "Write plans in ASD-STE100" in CAVEMAN_SECTION
    # ASD-STE100 covers plans with its own rules; no Caveman anywhere in it
    assert "Caveman" not in ASD_STE100_SECTION and "plans" in ASD_STE100_SECTION
