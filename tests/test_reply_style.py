"""Reply style (mig 102 / sqlite 032): the project setting, the per-thread overrides and the
prompt section agents get.

Storage: projects default to Normal; owners (or manage_agents) change it; any human member sets
or clears a conversation / task override; AI agents and viewers cannot; every change is logged.
Prompt: GET /protocol carries {project, task, conversation}; the notifier picks the thread value
by lane (thread beats project), Normal adds nothing, and each style keeps the fixed rules (exact
code/paths/quotes, one Normal reply on "elaborate", GitHub and agent-to-agent stay Normal, plans
never Caveman). Everything is in /openapi.json.
"""
import json

import pytest

from orcha_cli import notifier, notifier_reply_style
from orcha_cli.notifier_reply_style import (
    ASD_STE100_SECTION,
    CAVEMAN_SECTION,
    NORMAL_TURN_NOTE,
    resolve_reply_style,
    reply_style_section,
)
from test_evidence_pack import HUBOT, OCTO, VERA, _members
from test_resident_session import ResidentProc, _codex_resume_conv, _wire, _wire_codex_spawn

PERSONA = {"system_prompt": "You are Tim."}


@pytest.fixture(autouse=True)
def _fresh_delivered_styles():
    """Each test starts as a freshly started notifier: no chat's last style is known."""
    notifier_reply_style._DELIVERED.clear()
    yield
    notifier_reply_style._DELIVERED.clear()


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


# ------------------------------------------------------------------ warm chat sessions

def test_warm_turn_carries_a_changed_style_and_nothing_by_default():
    plain = notifier._wrap_conversation_turn("hi")
    # no style info (older server): unchanged, whatever the session last had
    assert notifier._wrap_conversation_turn("hi", reply_style=None) == plain
    assert notifier._wrap_conversation_turn("hi", reply_style=None, delivered_style="caveman") == plain
    # same style the session last received: the rules are already there
    assert notifier._wrap_conversation_turn("hi", reply_style="normal", delivered_style="normal") == plain
    assert notifier._wrap_conversation_turn("hi", reply_style="caveman", delivered_style="caveman") == plain
    # switched mid-chat (chip or project setting): the new rules ride on the turn
    out = notifier._wrap_conversation_turn("hi", reply_style="asd_ste100", delivered_style="caveman")
    assert ASD_STE100_SECTION in out and out.endswith("\n\nhi")
    # last style unknown (resumed session, notifier restarted): the current style is stated outright
    assert CAVEMAN_SECTION in notifier._wrap_conversation_turn("hi", reply_style="caveman")
    assert NORMAL_TURN_NOTE in notifier._wrap_conversation_turn("hi", reply_style="normal")
    # back to Normal: tell the session to drop the old rules
    back = notifier._wrap_conversation_turn("hi", reply_style="normal", delivered_style="caveman")
    assert NORMAL_TURN_NOTE in back and CAVEMAN_SECTION not in back


def _fed_text(proc) -> str:
    """The text of the last user turn written to a resident's stdin."""
    line = proc.stdin.getvalue().decode().strip().splitlines()[-1]
    return json.loads(line)["message"]["content"][0]["text"]


def _claude_chat(monkeypatch, tmp_path, *, style, session_id=None):
    """A Claude chat driven through the resident conversation service. Returns ``say(seq, text,
    style, override)``, which queues a human turn, runs one service tick and returns what the
    session received."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": session_id, "cold_required": False, "pending_human": True,
            "last_turn_seq": 0, "reply_style": style, "reply_style_override": None}
    turns = []
    _wire(monkeypatch, active=[conv], turns=turns)
    proc = ResidentProc()
    spawned = []
    monkeypatch.setattr(notifier, "spawn_resident",
                        lambda *a, **k: spawned.append(k) or (True, "r", proc))
    live = {}

    def say(seq, text, style, override=None):
        turns.append({"seq": seq, "role": "human", "content": text})
        conv.update(last_turn_seq=seq, reply_style=style, reply_style_override=override)
        if "C1" in live:                       # the previous reply was captured: session idle
            live["C1"].update(awaiting_result=False, current_run_id=None)
        notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))
        return _fed_text(proc)

    return say, spawned


def test_claude_chat_switching_back_to_its_starting_style_sends_the_reset(monkeypatch, tmp_path):
    """Code review r1: Normal -> Caveman -> Normal on one running session. The third turn must
    tell the session to drop the Caveman rules (it compared with the boot style before)."""
    say, spawned = _claude_chat(monkeypatch, tmp_path, style="normal")
    assert say(1, "one", "normal") == notifier._wrap_conversation_turn("one")   # boot prompt has it
    assert spawned[0]["resume_session_id"] is None                              # one cold boot ...
    assert CAVEMAN_SECTION in say(2, "two", "caveman", override="caveman")
    third = say(3, "three", "normal", override="normal")                        # explicit Normal chip
    assert NORMAL_TURN_NOTE in third and CAVEMAN_SECTION not in third and third.endswith("three")
    assert say(4, "four", "normal", override="normal") == notifier._wrap_conversation_turn("four")
    assert len(spawned) == 1                                                    # ... one live session


def test_claude_chat_follows_the_project_back_to_normal(monkeypatch, tmp_path):
    """Boot under the project's Caveman, then the project goes back to Normal (no chip)."""
    say, _ = _claude_chat(monkeypatch, tmp_path, style="caveman")
    assert say(1, "one", "caveman") == notifier._wrap_conversation_turn("one")
    assert NORMAL_TURN_NOTE in say(2, "two", "normal")
    assert say(3, "three", "normal") == notifier._wrap_conversation_turn("three")
    assert CAVEMAN_SECTION in say(4, "four", "caveman")                          # and back again


def test_resumed_claude_chat_states_normal_when_its_last_style_is_unknown(monkeypatch, tmp_path):
    """Code review r1: a resumed session may still hold Caveman rules from before a notifier
    restart; with the project now Normal, its first turn says so once, then adds nothing."""
    say, spawned = _claude_chat(monkeypatch, tmp_path, style="normal",
                                session_id="99999999-8888-7777-6666-555555555555")
    first = say(1, "one", "normal")
    assert spawned[0]["resume_session_id"] is not None and spawned[0]["system_prompt"] is None
    assert NORMAL_TURN_NOTE in first
    assert say(2, "two", "normal") == notifier._wrap_conversation_turn("two")


def _codex_turn(monkeypatch, tmp_path, **conv):
    """One Codex conversation turn through the service; returns (prompt, spawn kwargs)."""
    notifier._CODEX_RESUME_FAILED.discard("c1")
    _, spawned = _wire_codex_spawn(monkeypatch, _codex_resume_conv(**conv))
    notifier.service_residents("http://x", "cid", {}, quiet=True, base_cwd=str(tmp_path))
    args, kw = spawned[0]
    return args[1], kw


def test_resumed_codex_chat_returns_to_the_project_normal(monkeypatch, tmp_path):
    """Code review r1: a resumed Codex chat got Caveman; the project goes back to Normal with no
    chat override. The next resume prompt must reset it, and the one after adds nothing."""
    prompt, kw = _codex_turn(monkeypatch, tmp_path, reply_style="caveman")
    assert kw["resume_session_id"] and kw["system_prompt"] is None
    assert CAVEMAN_SECTION in prompt
    prompt, _ = _codex_turn(monkeypatch, tmp_path, reply_style="caveman")
    assert CAVEMAN_SECTION not in prompt                                         # already has it
    prompt, _ = _codex_turn(monkeypatch, tmp_path, reply_style="normal")
    assert NORMAL_TURN_NOTE in prompt and CAVEMAN_SECTION not in prompt
    prompt, _ = _codex_turn(monkeypatch, tmp_path, reply_style="normal")
    assert NORMAL_TURN_NOTE not in prompt


def test_resumed_codex_chat_states_normal_when_its_last_style_is_unknown(monkeypatch, tmp_path):
    """After a notifier restart the last style is unknown: state Normal outright, once."""
    prompt, _ = _codex_turn(monkeypatch, tmp_path, reply_style="normal")
    assert NORMAL_TURN_NOTE in prompt
    prompt, _ = _codex_turn(monkeypatch, tmp_path, reply_style="normal")
    assert NORMAL_TURN_NOTE not in prompt


def test_cold_codex_chat_remembers_the_style_its_persona_carried(monkeypatch, tmp_path):
    """A cold boot puts the style in the persona, so the next resume adds nothing for it."""
    prompt, kw = _codex_turn(monkeypatch, tmp_path, reply_style="asd_ste100", session_id=None)
    assert kw["resume_session_id"] is None and kw["system_prompt"] == "PERSONA"
    assert ASD_STE100_SECTION not in prompt
    prompt, kw = _codex_turn(monkeypatch, tmp_path, reply_style="asd_ste100")
    assert kw["resume_session_id"] and ASD_STE100_SECTION not in prompt and NORMAL_TURN_NOTE not in prompt


def test_chats_without_style_info_never_get_a_note(monkeypatch, tmp_path):
    """An older server sends no reply_style: resumed chats stay exactly as before."""
    prompt, _ = _codex_turn(monkeypatch, tmp_path)
    assert NORMAL_TURN_NOTE not in prompt and "[reply style" not in prompt


async def test_active_conversations_carry_the_chat_style(client, container, make_agent):
    cid = container["id"]
    human = await make_agent("operator", kind="human")
    ai = await make_agent("builder")
    conv = await _conversation(client, ai["agent_id"], human["agent_id"])

    async def row():
        rows = (await client.get(f"/api/containers/{cid}/active-conversations")).json()
        rows = rows.get("conversations", rows) if isinstance(rows, dict) else rows
        return next(r for r in rows if r["conversation_id"] == conv)

    r = await row()
    assert r["reply_style"] == "normal" and r["reply_style_override"] is None
    await client.put(f"/api/containers/{cid}/reply-style",
                     json={"reply_style": "caveman", "actor_agent_id": human["agent_id"]})
    assert (await row())["reply_style"] == "caveman"
    await client.put(f"/api/conversations/{conv}/reply-style",
                     json={"reply_style": "normal", "actor_agent_id": human["agent_id"]})
    r = await row()
    assert r["reply_style"] == "normal" and r["reply_style_override"] == "normal"
