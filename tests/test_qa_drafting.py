"""Orcha QA drafting: the board a draft session shows (messages, activity, sources, evidence), the
explorer of the same task, requests between the two, and a person's feedback."""
import pytest
from conftest import fresh_task_id

JPEG = b"\xff\xd8\xff\xe0" + b"0" * 32


@pytest.fixture
async def people(make_agent):
    human = await make_agent("Hussein", "owner", kind="human")
    bot = await make_agent("qa-bot")
    return {"human": human["agent_id"], "bot": bot["agent_id"]}


async def _session(client, cid, bot, kind="draft", task_id=None, **extra):
    r = await client.post(f"/api/containers/{cid}/qa/sessions",
                          json={"actor_agent_id": bot, "kind": kind, "platform": "ios", "task_id": task_id or await fresh_task_id(client, cid, bot), **extra})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _frame(client, sid, bot):
    r = await client.post(f"/api/qa/sessions/{sid}/frames", params={"actor_agent_id": bot}, content=JPEG, headers={"content-type": "image/jpeg"})
    return r.json()["frame_id"]


async def _screen(client, sid, bot, seq, title, key):
    frame = await _frame(client, sid, bot)
    r = await client.post(f"/api/qa/sessions/{sid}/steps", json={"actor_agent_id": bot, "steps": [
        {"seq": seq, "kind": "screen", "args": {"title": title, "anchors": ["Create routine"], "texts": ["Routines"]}, "screen_key": key, "frame_id": frame}]})
    assert r.status_code == 200, r.text
    return frame


async def _propose(client, cid, bot, sid, name="Create a routine", **extra):
    r = await client.post(f"/api/containers/{cid}/qa/scenarios", json={
        "actor_agent_id": bot, "platform": "ios", "name": name, "criteria": ["The list shows it", "It is saved"], "session_id": sid, **extra})
    assert r.status_code in (200, 201), r.text
    return r.json()["scenario"]["id"]


async def test_the_board_reads_what_the_drafter_said(client, container, people):
    cid, bot = container["id"], people["bot"]
    sid = await _session(client, cid, bot, draft_sources="code")
    r = await client.post(f"/api/qa/sessions/{sid}/messages", json={"actor_agent_id": bot, "messages": [
        {"kind": "read", "title": "Sources/Auth/SignIn.swift"},
        {"kind": "read", "title": "Sources/Auth/SignIn.swift"},
        {"kind": "search", "title": "Searched the code 4 times", "body": {"count": 4}},
        {"kind": "note", "title": "Mapping the sign-in journey"},
        {"kind": "draft", "title": "Sign in with email"},
    ]})
    assert r.status_code == 201, r.text
    board = (await client.get(f"/api/qa/sessions/{sid}/drafting")).json()
    assert board["session"] is None and board["explorers"] == [] and board["sources"] == "code"
    a = board["activity"]
    assert a["reads"] == 1 and a["searches"] == 4 and a["read_files"] == ["Sources/Auth/SignIn.swift"]
    assert a["recent"][-2:] == ["Mapping the sign-in journey", "Drafting: Sign in with email"]
    assert a["phase"] == "drafting" and a["note"] == "Drafting: Sign in with email"
    assert [e["kind"] for e in board["events"]][:2] == ["read", "read"]


async def test_a_session_keeps_its_sources_and_they_are_checked(client, container, people):
    cid, bot = container["id"], people["bot"]
    sid = await _session(client, cid, bot, draft_sources="both")
    assert (await client.get(f"/api/qa/sessions/{sid}")).json()["draft_sources"] == "both"
    r = await client.post(f"/api/containers/{cid}/qa/sessions", json={"actor_agent_id": bot, "kind": "draft", "platform": "ios", "draft_sources": "everything"})
    assert r.status_code == 422


async def test_messages_need_a_running_session_and_a_real_kind(client, container, people):
    cid, bot = container["id"], people["bot"]
    sid = await _session(client, cid, bot)
    r = await client.post(f"/api/qa/sessions/{sid}/messages", json={"actor_agent_id": bot, "messages": [{"kind": "answer", "title": "x"}]})
    assert r.status_code == 422
    await client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": bot, "status": "done"})
    r = await client.post(f"/api/qa/sessions/{sid}/messages", json={"actor_agent_id": bot, "messages": [{"kind": "note", "title": "late"}]})
    assert r.status_code == 409
    r = await client.post(f"/api/qa/sessions/{sid}/messages", json={"actor_agent_id": bot, "messages": [{"kind": "correction", "title": "Revised 'x'"}]})
    assert r.status_code == 201, r.text


async def test_sources_count_completed_explorations_with_steps(client, container, people):
    cid, bot = container["id"], people["bot"]
    done = await _session(client, cid, bot, kind="explore")
    await _screen(client, done, bot, 1, "Home", "HomeView")
    await client.patch(f"/api/qa/sessions/{done}", json={"actor_agent_id": bot, "status": "done", "report_md": "# Report"})
    await _session(client, cid, bot, kind="explore")  # still running: not read
    empty = await _session(client, cid, bot, kind="explore")
    await client.patch(f"/api/qa/sessions/{empty}", json={"actor_agent_id": bot, "status": "done"})  # no steps: not read
    s = (await client.get(f"/api/containers/{cid}/qa/drafting/sources")).json()
    assert s["count"] == 1 and s["reports"] == 1 and s["latestKind"] == "ios"
    assert s["kinds"][0]["kind"] == "ios" and s["kinds"][0]["count"] == 1
    assert len(s["frames"]) == 1 and s["frames"][0]["run_id"] == done

    sid = await _session(client, cid, bot, draft_sources="both")
    board = (await client.get(f"/api/qa/sessions/{sid}/drafting", params={"labels": "true"})).json()
    assert [f["run_id"] for f in board["frames"]] == [done]
    assert board["past_screens"][0]["title"] == "Home" and "Create routine" in board["past_screens"][0]["body"]["labels"]
    code = await _session(client, cid, bot, draft_sources="code")
    assert (await client.get(f"/api/qa/sessions/{code}/drafting")).json()["frames"] == []


async def test_a_drafter_and_an_explorer_of_one_task_share_a_board(client, container, people, make_task):
    cid, bot = container["id"], people["bot"]
    task = await make_task("Draft", "Drafted", created_by=people["human"])
    tid = task["id"]
    other_task = await _session(client, cid, bot, kind="explore")
    draft = await _session(client, cid, bot, task_id=tid, draft_sources="code")
    explore = await _session(client, cid, bot, kind="explore", task_id=tid, budget_minutes=10)
    frame = await _screen(client, explore, bot, 1, "Routines", "RoutinesView")
    await _screen(client, explore, bot, 2, "Routines", "RoutinesView")
    await _screen(client, other_task, bot, 1, "Elsewhere", "ElseView")

    board = (await client.get(f"/api/qa/sessions/{draft}/drafting")).json()
    assert board["session"]["status"] == "live" and board["session"]["explorer_status"] == "running"
    assert board["session"]["deadline_at"]
    e = board["explorers"][0]
    assert e["id"] == explore and e["status"] == "running" and e["screens"] == 1 and len(e["frames"]) == 2
    screens = [x for x in board["events"] if x["kind"] == "screen"]
    assert [x["title"] for x in screens] == ["Routines"]  # the first sighting only
    assert screens[0]["frame_id"] == frame and "labels" not in screens[0]["body"]

    r = await client.post(f"/api/qa/sessions/{draft}/requests", json={"actor_agent_id": bot, "question": "Open Routines"})
    assert r.status_code == 201, r.text
    rid = r.json()["request"]["id"]
    assert r.json()["look_only"] is None
    r = await client.post(f"/api/qa/sessions/{explore}/requests/next", json={"actor_agent_id": bot})
    assert r.json()["request"]["id"] == rid and r.json()["request"]["status"] == "claimed"
    assert (await client.post(f"/api/qa/sessions/{explore}/requests/next", json={"actor_agent_id": bot})).json()["request"] is None
    r = await client.post(f"/api/qa/requests/{rid}/answer", json={"actor_agent_id": bot, "session_id": explore, "answer": "It says Create routine", "frame_id": frame})
    assert r.status_code == 201, r.text
    board = (await client.get(f"/api/qa/sessions/{draft}/drafting")).json()
    ask = next(x for x in board["events"] if x["kind"] == "request")
    said = next(x for x in board["events"] if x["kind"] == "answer")
    assert ask["status"] == "answered" and said["reply_to"] == rid and said["body"]["question"] == "Open Routines"
    r = await client.post(f"/api/qa/requests/{rid}/answer", json={"actor_agent_id": bot, "session_id": explore, "answer": "again"})
    assert r.status_code == 409

    await client.patch(f"/api/qa/sessions/{explore}", json={"actor_agent_id": bot, "status": "failed", "result": {"error": "the app crashed"}})
    board = (await client.get(f"/api/qa/sessions/{draft}/drafting")).json()
    assert board["session"]["status"] == "code_only" and "the app crashed" in board["session"]["note"]


async def test_an_explorer_is_needed_and_destructive_requests_are_look_only(client, container, people, make_task):
    cid, bot = container["id"], people["bot"]
    task = await make_task("Draft", "Drafted", created_by=people["human"])
    tid = task["id"]
    draft = await _session(client, cid, bot, task_id=tid)
    r = await client.post(f"/api/qa/sessions/{draft}/requests", json={"actor_agent_id": bot, "question": "Open it"})
    assert r.status_code == 409 and "no explorer" in r.text
    explore = await _session(client, cid, bot, kind="explore", task_id=tid)
    r = await client.post(f"/api/qa/sessions/{draft}/requests", json={"actor_agent_id": bot, "question": "Delete the account"})
    assert r.json()["look_only"] == "it asks to delete"
    for _ in range(2):
        await client.post(f"/api/qa/sessions/{draft}/requests", json={"actor_agent_id": bot, "question": "Look"})
    r = await client.post(f"/api/qa/sessions/{draft}/requests", json={"actor_agent_id": bot, "question": "One more"})
    assert r.status_code == 409 and "already waiting" in r.text
    r = await client.post(f"/api/qa/sessions/{explore}/requests", json={"actor_agent_id": bot, "question": "Look"})
    assert r.status_code == 409


async def test_evidence_says_which_screen_backs_a_criterion(client, container, people):
    cid, bot = container["id"], people["bot"]
    sid = await _session(client, cid, bot)
    frame = await _screen(client, sid, bot, 7, "Routines", "RoutinesView")
    scid = await _propose(client, cid, bot, sid, evidence=[
        {"criterion_index": 0, "status": "verified", "frame_id": frame},
        {"criterion_index": 1, "status": "code_only", "code_ref": "Sources/Routine.swift:12"},
    ])
    rows = (await client.get(f"/api/qa/sessions/{sid}/drafting")).json()["evidence"]
    assert [r["scenario_id"] for r in rows] == [scid, scid]
    assert rows[0]["screen_name"] == "Routines" and rows[0]["step"] == 7 and rows[0]["run_id"] == sid
    assert rows[1]["screen_name"] is None and rows[1]["code_ref"] == "Sources/Routine.swift:12"


async def test_a_revision_and_a_persons_feedback_reach_the_card(client, container, people):
    cid, bot, human = container["id"], people["bot"], people["human"]
    sid = await _session(client, cid, bot)
    frame = await _screen(client, sid, bot, 1, "Routines", "RoutinesView")
    scid = await _propose(client, cid, bot, sid)
    r = await client.post(f"/api/qa/sessions/{sid}/messages", json={"actor_agent_id": bot, "messages": [
        {"kind": "correction", "title": "Revised 'Create a routine'", "scenario_id": scid, "frame_id": frame,
         "body": {"changes": [{"index": 0, "before": "a", "after": "b"}], "reason": "it says b", "from_screen": True}}]})
    assert r.status_code == 201, r.text
    r = await client.post(f"/api/qa/scenarios/{scid}/feedback", json={"actor_agent_id": bot, "text": "No"})
    assert r.status_code == 403
    r = await client.post(f"/api/qa/scenarios/{scid}/feedback", json={"actor_agent_id": human, "text": "Criterion 2  is wrong"})
    assert r.status_code == 201, r.text
    board = (await client.get(f"/api/qa/sessions/{sid}/drafting")).json()
    fix = board["corrections"][0]
    assert fix["scenario_id"] == scid and fix["body"]["screen_name"] == "Routines" and fix["frame_id"] == frame
    assert board["feedback"][scid][0]["text"] == "Criterion 2 is wrong"
