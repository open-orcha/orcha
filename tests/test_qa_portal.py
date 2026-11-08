"""Orcha QA portal routes (migration 093 / sqlite 023; contract docs/orcha-qa-plan.md):
targets, sessions, steps (idempotent on seq), frames on disk, findings (dismiss / file as an
Orcha task), the flow queue's ranking, walks (a pass needs the last step reached), verdicts and
GET /api/tasks/{tid}/qa. The map and scenarios are in test_qa_portal_map_scenarios.py."""
import pytest

import main
from conftest import BACKEND, run_task_id


def jpeg(width=390, height=844, pad=0):
    """A minimal JPEG: SOI, a SOF0 header with the size, EOI (enough for the size reader)."""
    sof = (b"\xff\xc0\x00\x11\x08" + height.to_bytes(2, "big") + width.to_bytes(2, "big")
           + b"\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01")
    return b"\xff\xd8" + sof + b"\x00" * pad + b"\xff\xd9"


@pytest.fixture
def attachments(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "ATTACHMENTS_DIR", tmp_path)
    return tmp_path


@pytest.fixture
async def people(make_agent):
    human = await make_agent("Hussein", "owner", kind="human")
    bot = await make_agent("qa-bot")
    return {"human": human["agent_id"], "bot": bot["agent_id"]}


async def _session(client, cid, actor, **kw):
    body = {"actor_agent_id": actor, "kind": "explore", "platform": "ios", **kw}
    body.setdefault("task_id", await run_task_id(client, cid, actor))
    r = await client.post(f"/api/containers/{cid}/qa/sessions", json=body)
    assert r.status_code == 201, r.text
    return r.json()


# ---------------------------------------------------------------- schema

def test_migration_093_tables_and_stamps(db):
    names = {r["name"] if "name" in r else r["table_name"] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'qa_%'"
        if BACKEND == "sqlite" else
        "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'qa_%%'")}
    assert {"qa_targets", "qa_features", "qa_map_nodes", "qa_map_edges", "qa_map_builds", "qa_sessions",
            "qa_frames", "qa_steps", "qa_findings", "qa_flows", "qa_walks", "qa_scenarios",
            "qa_scenario_evidence", "qa_scenario_suggestions", "qa_verdicts"} <= names
    stamped = {r["version"] for r in db.execute("SELECT version FROM schema_migrations")}
    assert "093_qa.sql" in stamped
    if BACKEND == "sqlite":
        assert "023_qa.sql" in stamped


# ---------------------------------------------------------------- targets

async def test_targets_are_a_human_edit(client, container, people):
    cid = container["id"]
    r = await client.get(f"/api/containers/{cid}/qa/targets")
    assert [t["platform"] for t in r.json()["targets"]] == ["ios", "android", "web"]
    body = {"app_id": "com.example.shop", "device_name": "iPhone 17 Pro", "notes": "Sign in as qa@example.com"}
    r = await client.put(f"/api/containers/{cid}/qa/targets/ios", json={**body, "actor_agent_id": people["bot"]})
    assert r.status_code == 403 and "only a person" in r.json()["detail"]
    r = await client.put(f"/api/containers/{cid}/qa/targets/ios", json={**body, "actor_agent_id": people["human"]})
    assert r.status_code == 200, r.text
    assert r.json()["app_id"] == "com.example.shop"
    r = await client.put(f"/api/containers/{cid}/qa/targets/ios",
                         json={**body, "notes": "password: hunter2", "actor_agent_id": people["human"]})
    assert r.status_code == 400 and "never a password" in r.json()["detail"]
    r = await client.put(f"/api/containers/{cid}/qa/targets/tvos", json={**body, "actor_agent_id": people["human"]})
    assert r.status_code == 400
    # a session picks the target's app and device up when it names none
    s = await _session(client, cid, people["bot"])
    assert s["app_id"] == "com.example.shop" and s["device_name"] == "iPhone 17 Pro"


# ---------------------------------------------------------------- sessions

async def test_session_lifecycle(client, container, people, make_task):
    cid = container["id"]
    task = await make_task("Explore checkout", "Findings filed")
    s = await _session(client, cid, people["bot"], task_id=task["id"], goal="checkout", budget_minutes=20)
    assert s["status"] == "running" and s["agent_id"] == people["bot"] and s["task_id"] == task["id"]
    sid = s["id"]

    r = await client.get(f"/api/containers/{cid}/qa/sessions", params={"kind": "explore", "task_id": task["id"]})
    assert [x["id"] for x in r.json()["sessions"]] == [sid]
    r = await client.get(f"/api/containers/{cid}/qa/sessions", params={"kind": "map"})
    assert r.json()["sessions"] == []

    charter = {"missions": [{"id": "m1", "title": "Pay with a card", "status": "active"}]}
    r = await client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": people["bot"], "charter": charter,
                                                          "heartbeat": True})
    assert r.status_code == 200 and r.json()["charter"] == charter
    bad = {"missions": [{"id": "m1", "title": "x", "status": "maybe"}]}
    r = await client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": people["bot"], "charter": bad})
    assert r.status_code == 400

    r = await client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": people["bot"], "status": "done",
                                                          "report_md": "# Report"})
    assert r.status_code == 200 and r.json()["status"] == "done" and r.json()["ended_at"]
    r = await client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": people["bot"], "status": "running"})
    assert r.status_code == 409

    r = await client.get(f"/api/qa/sessions/{sid}")
    d = r.json()
    assert d["report_md"] == "# Report" and d["walks"] == [] and d["steps_count"] == 0


async def test_session_needs_a_member_actor(client, container, make_agent):
    cid = container["id"]
    r = await client.post(f"/api/containers/{cid}/qa/sessions", json={"kind": "map", "platform": "ios"})
    assert r.status_code == 400 and "actor_agent_id" in r.json()["detail"]
    other = (await client.post("/api/containers", json={"name": "other", "additional": True})).json()["container_id"]
    stranger = await make_agent("stranger", container_id=other)
    r = await client.post(f"/api/containers/{cid}/qa/sessions",
                          json={"kind": "map", "platform": "ios", "actor_agent_id": stranger["agent_id"]})
    assert r.status_code == 403


# ---------------------------------------------------------------- steps

async def test_steps_are_idempotent_on_seq(client, container, people):
    cid = container["id"]
    sid = (await _session(client, cid, people["bot"]))["id"]
    first = [{"seq": 1, "kind": "launch"}, {"seq": 2, "kind": "tap", "args": {"target": "Cart"}, "result": "ok"}]
    r = await client.post(f"/api/qa/sessions/{sid}/steps", json={"actor_agent_id": people["bot"], "steps": first})
    assert r.json() == {"inserted": 2, "skipped": 0}
    again = [{"seq": 2, "kind": "tap", "args": {"target": "CHANGED"}}, {"seq": 3, "kind": "screen"}]
    r = await client.post(f"/api/qa/sessions/{sid}/steps", json={"actor_agent_id": people["bot"], "steps": again})
    assert r.json() == {"inserted": 1, "skipped": 1}
    r = await client.get(f"/api/qa/sessions/{sid}/steps", params={"from_seq": 2})
    steps = r.json()["steps"]
    assert [s["seq"] for s in steps] == [2, 3]
    assert steps[0]["args"] == {"target": "Cart"}  # the first write stands
    r = await client.post(f"/api/qa/sessions/{sid}/steps",
                          json={"actor_agent_id": people["bot"], "steps": [{"seq": 9, "kind": "fly"}]})
    assert r.status_code == 422
    r = await client.post(f"/api/qa/sessions/{sid}/steps",
                          json={"actor_agent_id": people["bot"],
                                "steps": [{"seq": 4, "kind": "note"}, {"seq": 4, "kind": "note"}]})
    assert r.status_code == 400


# ---------------------------------------------------------------- frames

async def test_frames_are_stored_and_served(client, container, people, attachments):
    cid = container["id"]
    sid = (await _session(client, cid, people["bot"]))["id"]
    url = f"/api/qa/sessions/{sid}/frames"
    data = jpeg()
    r = await client.post(url, params={"actor_agent_id": people["bot"], "screen_hash": "abc"}, content=data,
                          headers={"content-type": "image/jpeg"})
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["width"] == 390 and out["height"] == 844
    fid = out["frame_id"]
    on_disk = attachments / "qa" / cid / sid / f"{fid}.jpg"
    assert on_disk.read_bytes() == data

    r = await client.get(f"/api/qa/frames/{fid}")
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg" and r.content == data

    r = await client.post(url, params={"actor_agent_id": people["bot"]}, content=b"\x89PNG....",
                          headers={"content-type": "image/png"})
    assert r.status_code == 415
    r = await client.post(url, params={"actor_agent_id": people["bot"]}, content=b"not a jpeg at all",
                          headers={"content-type": "image/jpeg"})
    assert r.status_code == 400
    big = jpeg(pad=4 * 1024 * 1024)
    r = await client.post(url, params={"actor_agent_id": people["bot"]}, content=big,
                          headers={"content-type": "image/jpeg"})
    assert r.status_code == 413
    assert len(list((attachments / "qa" / cid / sid).iterdir())) == 1

    r = await client.get(f"/api/qa/sessions/{sid}")
    assert r.json()["frames_count"] == 1


# ---------------------------------------------------------------- findings

async def test_finding_filed_as_an_orcha_task(client, container, people, make_task, attachments, db):
    cid = container["id"]
    origin = await make_task("Explore checkout", "Findings filed")
    sid = (await _session(client, cid, people["bot"], task_id=origin["id"], app_id="com.example.shop"))["id"]
    fid_frame = (await client.post(f"/api/qa/sessions/{sid}/frames", params={"actor_agent_id": people["bot"]},
                                   content=jpeg(), headers={"content-type": "image/jpeg"})).json()["frame_id"]
    body = {"actor_agent_id": people["bot"], "severity": "major", "title": "Pay button does nothing",
            "expected": "the order is placed", "actual": "nothing happens", "frame_ids": [fid_frame],
            "start_seq": 4, "end_seq": 7, "screen_key": "checkout"}
    r = await client.post(f"/api/qa/sessions/{sid}/findings", json=body)
    assert r.status_code == 201, r.text
    finding = r.json()
    assert finding["status"] == "open" and finding["task_id"] == origin["id"] and finding["frame_ids"] == [fid_frame]
    assert finding["detail"] is None  # TEXT, never a decoded {} (the UI split it and crashed)

    detail = "Tapping Pay twice charged once.\n\nevents since last screen (1):\nresponse 500: POST /api/pay"
    sid2 = (await _session(client, cid, people["bot"], app_id="com.example.shop"))["id"]
    r = await client.post(f"/api/qa/sessions/{sid2}/findings", json={**body, "title": "Pay errors", "detail": detail})
    assert r.status_code == 201 and r.json()["detail"] == detail
    session = (await client.get(f"/api/qa/sessions/{sid2}")).json()
    assert {f["title"]: f["detail"] for f in session["findings"]}["Pay errors"] == detail

    r = await client.post(f"/api/qa/sessions/{sid}/findings", json={**body, "frame_ids": [origin["id"]]})
    assert r.status_code == 400  # not a frame of this project

    r = await client.patch(f"/api/qa/findings/{finding['id']}",
                           json={"actor_agent_id": people["bot"], "action": "file", "assignee_agent_id": people["bot"]})
    assert r.status_code == 200, r.text
    filed = r.json()
    assert filed["status"] == "filed" and filed["filed_task_id"] == filed["task"]["task_id"]
    task = db.execute("SELECT title, description, definition_of_done, status, created_by_agent_id FROM tasks "
                      "WHERE id=%s", (filed["filed_task_id"],))[0]
    assert str(task["created_by_agent_id"]) == people["bot"]
    assert task["title"] == "Fix: Pay button does nothing"
    assert "nothing happens" in task["description"] and f"/api/qa/frames/{fid_frame}" in task["description"]
    assert "the order is placed" in task["definition_of_done"]
    assert task["status"] == "in_progress"  # assigned on creation, like any assigned task

    r = await client.patch(f"/api/qa/findings/{finding['id']}", json={"actor_agent_id": people["bot"], "action": "file"})
    assert r.status_code == 409
    r = await client.patch(f"/api/qa/findings/{finding['id']}",
                           json={"actor_agent_id": people["bot"], "action": "dismiss"})
    assert r.status_code == 409

    # the task's QA view carries the session, the finding (its own and the filed task's)
    qa = (await client.get(f"/api/tasks/{origin['id']}/qa")).json()
    assert [s["id"] for s in qa["sessions"]] == [sid] and [f["id"] for f in qa["findings"]] == [finding["id"]]
    qa = (await client.get(f"/api/tasks/{filed['filed_task_id']}/qa")).json()
    assert [f["id"] for f in qa["findings"]] == [finding["id"]]


async def test_finding_dismiss_and_reopen(client, container, people):
    cid = container["id"]
    sid = (await _session(client, cid, people["bot"]))["id"]
    f = (await client.post(f"/api/qa/sessions/{sid}/findings",
                           json={"actor_agent_id": people["bot"], "severity": "minor", "title": "Typo"})).json()
    r = await client.patch(f"/api/qa/findings/{f['id']}", json={"actor_agent_id": people["human"], "action": "dismiss"})
    assert r.json()["status"] == "dismissed"
    r = await client.patch(f"/api/qa/findings/{f['id']}", json={"actor_agent_id": people["bot"], "action": "file"})
    assert r.status_code == 409
    r = await client.patch(f"/api/qa/findings/{f['id']}", json={"actor_agent_id": people["bot"], "action": "reopen"})
    assert r.json()["status"] == "open"


# ---------------------------------------------------------------- flows and walks

async def _flows(client, cid, actor, flows):
    r = await client.post(f"/api/containers/{cid}/qa/flows",
                          json={"actor_agent_id": actor, "platform": "ios", "flows": flows})
    assert r.status_code == 200, r.text
    return {f["key"]: f for f in r.json()["flows"]}


async def _next(client, sid, actor):
    r = await client.post(f"/api/qa/sessions/{sid}/walks/next", json={"actor_agent_id": actor})
    assert r.status_code == 200, r.text
    return r.json()


async def _step(client, wid, actor, index, reached=True):
    r = await client.patch(f"/api/qa/walks/{wid}", json={"actor_agent_id": actor,
                                                        "step": {"index": index, "reached": reached, "result": "ok"}})
    assert r.status_code == 200, r.text
    return r.json()


async def _end(client, wid, actor, outcome, **kw):
    return await client.patch(f"/api/qa/walks/{wid}", json={"actor_agent_id": actor, "outcome": outcome, **kw})


async def test_walks_rank_and_pass_rule(client, container, people):
    cid, bot = container["id"], people["bot"]
    steps = [{"text": "Open the cart"}, {"text": "Pay", "check": "Order placed"}]
    flows = await _flows(client, cid, bot, [
        {"name": "Browse the catalog", "criticality": "low", "steps": steps},
        {"name": "Check out", "criticality": "high", "steps": steps},
        {"name": "Edit the profile", "criticality": "medium", "steps": steps},
    ])
    assert set(flows) == {"browse-the-catalog", "check-out", "edit-the-profile"}
    sid = (await _session(client, cid, bot))["id"]

    first = await _next(client, sid, bot)
    assert first["flow"]["key"] == "check-out"  # never walked 40 + high 30 + uncovered 10
    assert first["flow"]["score"] == 80 and first["walk"]["status"] == "walking"
    wid = first["walk"]["id"]
    assert len(first["walk"]["steps"]) == 2
    again = await _next(client, sid, bot)
    assert again["walk"]["id"] == wid and again["resumed"] is True

    # a pass needs the last step reached
    await _step(client, wid, bot, 0)
    r = await _end(client, wid, bot, "passed")
    assert r.status_code == 409 and "last step" in r.json()["detail"]
    await _step(client, wid, bot, 1)
    r = await _end(client, wid, bot, "passed")
    assert r.status_code == 200 and r.json()["walk"]["status"] == "passed"
    assert r.json()["flow"]["status"] == "passed" and r.json()["flow"]["last_walked_at"]
    r = await client.patch(f"/api/qa/walks/{wid}", json={"actor_agent_id": bot,
                                                        "step": {"index": 0, "reached": True}})
    assert r.status_code == 409  # an ended walk takes no more steps

    nxt = await _next(client, sid, bot)
    assert nxt["flow"]["key"] == "edit-the-profile"  # medium 20 beats low 10
    r = await _end(client, nxt["walk"]["id"], bot, "failed", reason="Save does nothing")
    assert r.json()["flow"]["status"] == "failed"
    last = await _next(client, sid, bot)
    assert last["flow"]["key"] == "browse-the-catalog"
    r = await _end(client, last["walk"]["id"], bot, "unreachable", reason="needs an account",
                   blocked_kind="needs_sign_in")
    assert r.json()["walk"]["blocked_kind"] == "needs_sign_in"
    assert (await _next(client, sid, bot)) == {"walk": None, "flow": None}

    # a new session: the recently failed flow (30 + medium 20 + 10) is next; passed ones are done
    sid2 = (await _session(client, cid, bot))["id"]
    retry = await _next(client, sid2, bot)
    assert retry["flow"]["key"] == "edit-the-profile"
    assert "failed recently (+30)" in retry["flow"]["rank_reasons"]
    assert retry["flow"]["score"] == 60


async def test_failed_recently_outranks_a_low_never_walked_flow(client, container, people):
    cid, bot = container["id"], people["bot"]
    steps = [{"text": "Go"}]
    await _flows(client, cid, bot, [{"name": "Pay", "criticality": "high", "steps": steps}])
    sid = (await _session(client, cid, bot))["id"]
    w = await _next(client, sid, bot)
    await _end(client, w["walk"]["id"], bot, "failed")
    await _flows(client, cid, bot, [{"name": "Help page", "criticality": "low", "steps": steps}])
    sid2 = (await _session(client, cid, bot))["id"]
    nxt = await _next(client, sid2, bot)
    assert nxt["flow"]["key"] == "pay"  # failed recently 30 + high 30 + 10 = 70 > never walked 40 + low 10 + 10


async def test_ending_a_session_abandons_its_walk(client, container, people):
    cid, bot = container["id"], people["bot"]
    await _flows(client, cid, bot, [{"name": "Pay", "steps": [{"text": "Go"}]}])
    sid = (await _session(client, cid, bot))["id"]
    w = await _next(client, sid, bot)
    await client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": bot, "status": "done"})
    d = (await client.get(f"/api/qa/sessions/{sid}")).json()
    assert d["walks"][0]["status"] == "abandoned"
    flows = (await client.get(f"/api/containers/{cid}/qa/flows", params={"platform": "ios"})).json()["flows"]
    assert flows[0]["status"] == "queued" and flows[0]["last_walked_at"] is None
    r = await client.post(f"/api/qa/sessions/{sid}/walks/next", json={"actor_agent_id": bot})
    assert r.status_code == 409
    assert w["walk"]["id"] == d["walks"][0]["id"]


# ---------------------------------------------------------------- verdicts + the task's QA

async def test_verdicts_and_task_qa(client, container, people, make_task):
    cid, bot = container["id"], people["bot"]
    task = await make_task("Check the suite", "Every validated scenario checked")
    sid = (await _session(client, cid, bot, kind="check", task_id=task["id"]))["id"]
    sc = (await client.post(f"/api/containers/{cid}/qa/scenarios", json={
        "actor_agent_id": bot, "platform": "ios", "name": "Guest checkout", "session_id": sid,
        "criteria": ["The cart shows the item", "Paying shows the confirmation"]})).json()["scenario"]
    assert sc["task_id"] == task["id"]  # taken from the session
    r = await client.post(f"/api/qa/sessions/{sid}/verdicts",
                          json={"actor_agent_id": bot, "scenario_id": sc["id"], "criterion_index": 1,
                                "verdict": "fail", "note": "no confirmation"})
    assert r.status_code == 201, r.text
    r = await client.post(f"/api/qa/sessions/{sid}/verdicts",
                          json={"actor_agent_id": bot, "scenario_id": sc["id"], "criterion_index": 2,
                                "verdict": "pass"})
    assert r.status_code == 400
    qa = (await client.get(f"/api/tasks/{task['id']}/qa")).json()
    assert [s["id"] for s in qa["sessions"]] == [sid]
    assert [s["id"] for s in qa["scenarios"]] == [sc["id"]]
    assert [(v["criterion_index"], v["verdict"], v["scenario_name"]) for v in qa["verdicts"]] == \
        [(1, "fail", "Guest checkout")]
    detail = (await client.get(f"/api/qa/scenarios/{sc['id']}")).json()
    assert [v["verdict"] for v in detail["verdicts"]] == ["fail"]
    r = await client.get("/api/tasks/not-a-uuid/qa")
    assert r.status_code == 400


async def test_overview_counts(client, container, people):
    cid, bot = container["id"], people["bot"]
    sid = (await _session(client, cid, bot))["id"]
    await client.post(f"/api/qa/sessions/{sid}/findings",
                      json={"actor_agent_id": bot, "severity": "minor", "title": "Typo"})
    await client.post(f"/api/containers/{cid}/qa/scenarios", json={
        "actor_agent_id": bot, "platform": "ios", "name": "A", "criteria": ["one", "two"]})
    o = (await client.get(f"/api/containers/{cid}/qa/overview")).json()
    ios = o["platforms"]["ios"]
    assert ios["open_findings"] == 1 and ios["untriaged"] == 1 and ios["scenarios"]["draft"] == 1
    assert ios["last_session"]["explore"]["id"] == sid and ios["last_session"]["map"] is None
    assert o["platforms"]["android"]["open_findings"] == 0
    assert set(o["platforms"]) == {"ios", "android", "web"} and o["platforms"]["web"]["screens"]["seen"] == 0


def test_routes_are_in_the_openapi_spec():
    paths = main.app.openapi()["paths"]
    for p in ("/api/containers/{cid}/qa/overview", "/api/containers/{cid}/qa/map/observe",
              "/api/qa/sessions/{sid}/frames", "/api/qa/findings/{fid}", "/api/qa/walks/{wid}",
              "/api/containers/{cid}/qa/scenarios/export.md", "/api/qa/suggestions/{gid}", "/api/tasks/{tid}/qa"):
        assert p in paths, p


# ---------------------------------------------------------------- UI support

async def test_qa_page_serves_the_spa_shell(client):
    r = await client.get("/qa", params={"view": "scenarios"}, headers={"accept": "text/html"})
    assert r.status_code == 200, r.text[:200]
    assert "text/html" in r.headers["content-type"] and 'id="root"' in r.text


async def test_session_detail_names_walk_flows_agents_and_tasks(client, container, people, make_task):
    cid, bot = container["id"], people["bot"]
    task = await make_task("Explore checkout", "Findings filed")
    await _flows(client, cid, bot, [{"name": "Check out", "steps": [{"text": "Pay"}]}])
    sid = (await _session(client, cid, bot, task_id=task["id"]))["id"]
    walk = (await _next(client, sid, bot))["walk"]
    await client.post(f"/api/qa/sessions/{sid}/findings",
                      json={"actor_agent_id": bot, "severity": "minor", "title": "Typo"})
    d = (await client.get(f"/api/qa/sessions/{sid}")).json()
    assert [(w["id"], w["flow_id"], w["flow_name"], w["flow_key"]) for w in d["walks"]] == \
        [(walk["id"], walk["flow_id"], "Check out", "check-out")]
    assert d["agent_alias"] == "qa-bot" and d["task_title"] == "Explore checkout"
    assert d["findings"][0]["agent_alias"] == "qa-bot" and d["findings"][0]["task_title"] == "Explore checkout"
    assert d["findings"][0]["filed_task_title"] is None
    listed = (await client.get(f"/api/containers/{cid}/qa/sessions")).json()["sessions"]
    assert listed[0]["agent_alias"] == "qa-bot" and listed[0]["task_title"] == "Explore checkout"
    qa = (await client.get(f"/api/tasks/{task['id']}/qa")).json()
    assert qa["sessions"][0]["agent_alias"] == "qa-bot" and qa["findings"][0]["task_title"] == "Explore checkout"


async def test_overview_untriaged_is_what_the_triage_inbox_lists(client, container, people):
    cid, bot = container["id"], people["bot"]
    sid = (await _session(client, cid, bot))["id"]
    found = [(await client.post(f"/api/qa/sessions/{sid}/findings", json={
        "actor_agent_id": bot, "severity": "major", "title": t})).json()["id"] for t in ("One", "Two")]
    r = await client.post(f"/api/qa/findings/{found[0]}/triage", json={
        "actor_agent_id": bot, "classification": "product_bug", "reproduced": True, "attempts": 3, "reproductions": 3,
        "root_cause": "A real bug"})
    assert r.status_code == 200, r.text
    ios = (await client.get(f"/api/containers/{cid}/qa/overview")).json()["platforms"]["ios"]
    inbox = (await client.get(f"/api/containers/{cid}/qa/triage")).json()
    assert ios["open_findings"] == 2 and ios["untriaged"] == 1 == len(inbox["untriaged"])


async def test_overview_counts_features_per_platform(client, container, people):
    cid, bot = container["id"], people["bot"]
    await client.post(f"/api/containers/{cid}/qa/map/import", json={
        "actor_agent_id": bot, "platform": "ios", "source": "code",
        "features": [{"name": "Checkout"}, {"name": "Profile"}],
        "nodes": [{"kind": "screen", "key": "cart", "feature_key": "checkout"}]})
    o = (await client.get(f"/api/containers/{cid}/qa/overview")).json()
    assert o["features_total"] == 2
    assert o["platforms"]["ios"]["features"] == 1 and o["platforms"]["android"]["features"] == 0


async def test_agent_defined_walk_steps_are_appended(client, container, people):
    cid, bot = container["id"], people["bot"]
    await _flows(client, cid, bot, [{"name": "Explore settings"}])  # a flow with no steps
    sid = (await _session(client, cid, bot))["id"]
    w = (await _next(client, sid, bot))["walk"]
    assert w["steps"] == []
    r = await client.patch(f"/api/qa/walks/{w['id']}", json={"actor_agent_id": bot, "step": {
        "index": 0, "reached": True, "text": "Open Settings", "expected": "Settings lists Privacy", "seq": 3}})
    assert r.status_code == 200, r.text
    r = await client.patch(f"/api/qa/walks/{w['id']}", json={"actor_agent_id": bot, "step": {
        "index": 1, "reached": False, "text": "Open Privacy"}})
    steps = r.json()["walk"]["steps"]
    assert [(s["index"], s["text"], s["expected"], s["reached"]) for s in steps] == \
        [(0, "Open Settings", "Settings lists Privacy", True), (1, "Open Privacy", None, False)]
    r = await _end(client, w["id"], bot, "passed")
    assert r.status_code == 409  # the last recorded step was not reached
    await client.patch(f"/api/qa/walks/{w['id']}", json={"actor_agent_id": bot, "step": {"index": 1, "reached": True}})
    r = await _end(client, w["id"], bot, "passed", end_seq=12)
    assert r.status_code == 200, r.text
    walk = r.json()["walk"]
    assert walk["status"] == "passed" and walk["end_seq"] == 12 and walk["steps"][1]["text"] == "Open Privacy"


async def test_flow_steps_keep_text_and_expected(client, container, people):
    cid, bot = container["id"], people["bot"]
    await _flows(client, cid, bot, [{"name": "Pay", "steps": [{"text": "Pay", "check": "Order placed"}]}])
    sid = (await _session(client, cid, bot))["id"]
    w = (await _next(client, sid, bot))["walk"]
    assert w["steps"][0]["text"] == "Pay" and w["steps"][0]["expected"] == "Order placed"
    r = await client.patch(f"/api/qa/walks/{w['id']}", json={"actor_agent_id": bot, "step": {
        "index": 0, "reached": True, "text": "", "expected": "The order number shows"}})
    step = r.json()["walk"]["steps"][0]
    assert step["text"] == "Pay" and step["expected"] == "The order number shows"


async def test_web_target_is_a_url_and_a_viewport(client, container, people):
    cid, human = container["id"], people["human"]
    url = f"/api/containers/{cid}/qa/targets/web"
    for bad in ({"app_id": "com.example.shop"}, {"app_id": "ftp://example.com"}, {"app_id": "https://"},
                {"app_id": "https://staging.example.com", "device_name": "iPhone 17 Pro"}):
        r = await client.put(url, json={**bad, "actor_agent_id": human})
        assert r.status_code == 400, bad
    r = await client.put(url, json={"app_id": "https://staging.example.com/app", "device_name": "mobile",
                                    "actor_agent_id": human})
    assert r.status_code == 200 and r.json()["device_name"] == "mobile"
    s = await _session(client, cid, people["bot"], platform="web")
    assert s["platform"] == "web" and s["app_id"] == "https://staging.example.com/app"


def test_a_passing_examples_row_never_hides_a_failing_one():
    from portal_backend import qa_store as qs

    rows = [{"criterion_index": 0, "example_row": 1, "verdict": "pass"},   # newest first
            {"criterion_index": 0, "example_row": 0, "verdict": "fail"},
            {"criterion_index": 0, "example_row": 0, "verdict": "pass"}]    # an earlier try of row 0
    assert [v["verdict"] for v in qs.newest_verdicts(rows)] == ["fail", "pass"]
    retried = [{"criterion_index": 0, "example_row": None, "verdict": "pass"}, {"criterion_index": 0, "example_row": None, "verdict": "fail"}]
    assert [v["verdict"] for v in qs.newest_verdicts(retried)] == ["pass"]  # no table: the retry stands
