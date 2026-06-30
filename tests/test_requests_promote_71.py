"""GH #71 — server-side auto-promotion of info-that-is-really-work to a task request,
plus the opt-in `?include_closed=true` outbox view.

Each promotion/guard test is teeth-verified: revert the production change in create_request
(or classify_request_type) and these go RED.
"""
import main


# ---------- pure classifier (backstop) ----------

def test_classify_promotes_imperative_work_verb():
    verdict, verb = main.classify_request_type("please review my PR plan")
    assert verdict == "task" and verb == "review"


def test_classify_keeps_plain_question_as_info():
    assert main.classify_request_type("what port does the DB use?") == ("info", None)


def test_classify_keeps_interrogative_with_verb_as_info():
    # leading question word + trailing '?' — must NOT promote despite "review" appearing
    assert main.classify_request_type("which file do I review?") == ("info", None)


def test_classify_sign_off_multiword():
    verdict, verb = main.classify_request_type("sign off on the release notes")
    assert verdict == "task" and verb == "sign off"


# ---------- end-to-end through create_request ----------

async def test_info_with_work_verb_promotes_to_task(client, make_agent, make_request, db):
    a = await make_agent("a", "eng")
    await make_agent("b", "eng")
    r = await make_request(a["agent_id"], "please review my PR plan", target_alias="b",
                           type="info")
    assert r["type"] == "task", "info-with-work-verb must auto-promote"
    rows = db.execute("SELECT type, detail FROM requests WHERE id=%s", (r["request_id"],))
    assert rows[0]["type"] == "task"
    detail = rows[0]["detail"]
    assert detail["promoted_from_info"] is True
    assert detail["matched_verb"] == "review"
    # synthesized task object is sane
    assert detail["title"] and detail["definition_of_done"]


async def test_info_plain_question_stays_info(client, make_agent, make_request, db):
    a = await make_agent("a", "eng")
    await make_agent("b", "eng")
    r = await make_request(a["agent_id"], "what port does the DB use?", target_alias="b",
                           type="info")
    assert r["type"] == "info", "a genuine question must not be promoted"
    rows = db.execute("SELECT type, detail FROM requests WHERE id=%s", (r["request_id"],))
    assert rows[0]["type"] == "info"
    assert rows[0]["detail"] is None


async def test_info_interrogative_with_verb_stays_info(client, make_agent, make_request, db):
    a = await make_agent("a", "eng")
    await make_agent("b", "eng")
    r = await make_request(a["agent_id"], "which file do I review?", target_alias="b",
                           type="info")
    assert r["type"] == "info", "interrogative-with-verb must not false-promote"
    rows = db.execute("SELECT type, detail FROM requests WHERE id=%s", (r["request_id"],))
    assert rows[0]["type"] == "info" and rows[0]["detail"] is None


async def test_explicit_task_unchanged_classifier_skipped(client, make_agent, make_request, db):
    a = await make_agent("a", "eng")
    await make_agent("b", "eng")
    # explicit type=task with a task object; payload would NOT classify as work on its own
    r = await make_request(a["agent_id"], "here is some context", target_alias="b",
                           type="task",
                           task={"title": "do the thing", "definition_of_done": "done",
                                 "priority": 100})
    assert r["type"] == "task"
    rows = db.execute("SELECT type, detail FROM requests WHERE id=%s", (r["request_id"],))
    assert rows[0]["type"] == "task"
    # classifier was skipped → no promotion audit stamp
    assert "promoted_from_info" not in (rows[0]["detail"] or {})
    assert rows[0]["detail"]["title"] == "do the thing"


# ---------- outbox include_closed ----------

async def test_outbox_include_closed_returns_closed_request(client, make_agent, make_request):
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "q", target_alias="b")  # genuine info question
    rid = req["request_id"]
    await client.post(f"/api/requests/{rid}/respond",
                      json={"responder_agent_id": b["agent_id"], "response": "answer"})
    await client.post(f"/api/requests/{rid}/close",
                      json={"requester_agent_id": a["agent_id"]})

    default = (await client.get(f"/api/agents/{a['agent_id']}/outbox")).json()["outgoing_requests"]
    assert all(r["id"] != rid for r in default), "default outbox omits closed"

    incl = (await client.get(
        f"/api/agents/{a['agent_id']}/outbox?include_closed=true")).json()["outgoing_requests"]
    assert any(r["id"] == rid and r["status"] == "closed" for r in incl), \
        "include_closed=true must surface the closed request"
