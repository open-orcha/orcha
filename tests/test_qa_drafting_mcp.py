"""The drafting tools against the real routes: a drafter says what it reads, proposes and revises,
asks the explorer of its task, and reads back what it saw. Two tool servers, one task."""
from __future__ import annotations

import pytest

import main
from orcha_cli.qa.mcp_server import QATools
from test_qa_mcp_fakes import FakeDevice, opener
from test_qa_mcp_portal import AppPortal, Ident, jshot


@pytest.fixture
def attachments(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "ATTACHMENTS_DIR", tmp_path)
    return tmp_path


CRITERIA = ['The list shows "Morning"', "The routine is saved after a restart"]


async def test_a_drafter_works_with_the_explorer_of_its_task(client, container, make_agent, make_task, attachments):
    from fastapi.testclient import TestClient

    cid = container["id"]
    human = (await make_agent("Hussein", "owner", kind="human"))["agent_id"]
    bot = (await make_agent("qa-bot"))["agent_id"]
    eyes = (await make_agent("qa-eyes"))["agent_id"]
    task = await make_task("Draft routines", "Drafts ready", created_by=human)
    r = await client.put(f"/api/containers/{cid}/qa/targets/ios",
                         json={"app_id": "com.example.app", "device_name": "iPhone 17 Pro", "actor_agent_id": human})
    assert r.status_code == 200, r.text
    home = jshot("home", ("Heading", "Routines"), ("Button", "Create routine"))

    with TestClient(main.app) as tc:
        drafter = QATools(identity=Ident(cid, bot), portal=AppPortal(tc, cid, bot))
        explorer = QATools(identity=Ident(cid, eyes), portal=AppPortal(tc, cid, eyes),
                           device_opener=opener(FakeDevice([home, home]), []))

        assert (await drafter.draft_progress(note="x")).startswith("error: no active session")
        out = await drafter.start_session("ios", "draft", minutes=0, task_id=task["id"], sources="code")
        assert out.startswith("session started"), out
        sid = drafter.live.id
        assert "1 line" in await drafter.draft_progress(note="Mapping routines")
        assert "3 line" in await drafter.draft_progress(files=["Sources/Routine.swift"], searches=2, note="Reading the form")
        assert (await drafter.draft_progress()).startswith("error")
        assert "explorer unavailable" in await drafter.ask_explorer("Open Routines")
        assert "no exploration runs" in await drafter.read_screens()

        made = await drafter.propose_scenario(name="Create a routine", platform="ios", description="A person creates a routine.",
                                              category="Form", persona="Owner", criteria=CRITERIA)
        assert made.startswith("scenario created"), made
        scid = drafter.live.drafts[0]

        await explorer.start_session("ios", "explore", minutes=0, task_id=task["id"])
        frame = explorer.live.last_frame_id
        asked = await drafter.ask_explorer("Open Routines, what does the button say?")
        assert asked.startswith("request "), asked
        rid = asked.split()[1]
        assert "look only" not in await explorer.next_request()
        assert (await explorer.next_request()) == "no request waiting"
        assert (await explorer.answer_request(rid, "It says Create routine")).startswith("answered")

        read = await drafter.read_screens()
        assert "session: live · explorer: running" in read and '"Create routine"' in read
        assert 'answer to "Open Routines, what does the button say?": It says Create routine' in read
        assert "nothing new" in await drafter.read_screens()
        assert '"Create routine"' in await drafter.read_screens(all=True)

        out = await drafter.revise_scenario(scid, criteria=['The list shows "Morning" under Create routine', CRITERIA[1]],
                                            reason="the button says Create routine", screen=frame)
        assert "revised" in out, out
        assert "explore session" in (await drafter.next_request())
        assert (await explorer.draft_progress(note="x")).startswith("error: this is a explore session")
        await drafter.end_session("Drafted one.")

    board = (await client.get(f"/api/qa/sessions/{sid}/drafting")).json()
    assert board["sources"] == "code"
    a = board["activity"]
    assert a["reads"] == 1 and a["searches"] == 2 and "Drafting: Create a routine" in a["recent"]
    kinds = [e["kind"] for e in board["events"]]
    assert {"note", "read", "search", "draft", "request", "answer", "screen", "correction"} <= set(kinds)
    [fix] = board["corrections"]
    assert fix["scenario_id"] == scid and fix["body"]["from_screen"] is True and fix["body"]["screen_name"] == "Routines"
    assert fix["body"]["changes"][0]["index"] == 0 and fix["body"]["changes"][0]["before"] == CRITERIA[0]
    assert fix["body"]["before"]["name"] == "Create a routine"
