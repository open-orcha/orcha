"""GH #71 — sizable work must go out as a `task` request, not `info`.

Two surfaces:
  * the request-create endpoint rejects an AI→AI `info` request whose payload reads like work
    (review / sign-off / docs / coding) with a 422 nudging `--task` — a high-precision backstop
    behind the /orcha-ask prompt guidance. A genuine quick question, a human-targeted question,
    and an explicit `task` request all still pass.
  * the outbox can surface open + recently-closed requests so a sender doesn't re-ask something
    already resolved.
"""
import main


# ---- unit: _looks_like_work is high-precision (work artifacts trip it; bare questions don't) ----

def test_looks_like_work_positive():
    for s in [
        "Please review the PR for the auth change",
        "Can you sign off on the migration plan?",
        "review the diff on notifier.py",
        "implement the login endpoint",
        "write the documentation for the requests API",
        "fix the bug in the wake loop",
        "refactor the notifier module",
        "add tests for the outbox query",
    ]:
        assert main._looks_like_work(s), f"should read as work: {s!r}"


def test_looks_like_work_negative():
    for s in [
        "What auth scheme are we using?",
        "Which database do we run in prod?",
        "can you review my understanding of the auth flow?",  # 'review' + non-artifact noun
        "where does the config live?",
        "do you have a minute to chat?",
        None,
        "",
    ]:
        assert not main._looks_like_work(s), f"should NOT read as work: {s!r}"


# ---- endpoint: enforcement on create ----

async def test_info_work_request_to_agent_rejected(client, make_agent, container):
    a = await make_agent("a", "eng")
    await make_agent("b", "eng")
    r = await client.post(f"/api/containers/{container['id']}/requests", json={
        "requester_agent_id": a["agent_id"], "target_alias": "b",
        "payload": "review the PR for the auth change", "type": "info",
        "priority": 100, "expires_minutes": 60,
    })
    assert r.status_code == 422, r.text
    assert "--task" in r.text


async def test_info_quick_question_to_agent_allowed(client, make_agent, container):
    a = await make_agent("a", "eng")
    await make_agent("b", "eng")
    r = await client.post(f"/api/containers/{container['id']}/requests", json={
        "requester_agent_id": a["agent_id"], "target_alias": "b",
        "payload": "What auth scheme are we using?", "type": "info",
        "priority": 100, "expires_minutes": 60,
    })
    assert r.status_code == 201, r.text


async def test_info_work_question_to_human_allowed(client, make_agent, container):
    # escalating a work-shaped question to a human is legitimately info — the guardrail must not fire.
    await make_agent("human", "operator", kind="human")
    a = await make_agent("a", "eng")
    r = await client.post(f"/api/containers/{container['id']}/requests", json={
        "requester_agent_id": a["agent_id"], "target_alias": "human",
        "payload": "review the PR for the auth change", "type": "info",
        "priority": 100, "expires_minutes": 60,
    })
    assert r.status_code == 201, r.text


async def test_task_work_request_allowed(client, make_agent, container):
    a = await make_agent("a", "eng")
    await make_agent("b", "eng")
    r = await client.post(f"/api/containers/{container['id']}/requests", json={
        "requester_agent_id": a["agent_id"], "target_alias": "b",
        "payload": "review the PR for the auth change", "type": "task",
        "task": {"title": "Review auth PR", "definition_of_done": "approved or change-requested",
                 "priority": 100},
        "priority": 100, "expires_minutes": 60,
    })
    assert r.status_code == 201, r.text
    assert r.json()["type"] == "task"


# ---- endpoint: outbox surfaces recently-closed (AC #3) ----

async def test_outbox_recently_closed_visible_opt_in(client, make_agent, make_request, container):
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "What auth scheme are we using?", target_alias="b")
    rid = req["request_id"]
    await client.post(f"/api/requests/{rid}/respond",
                      json={"responder_agent_id": b["agent_id"], "response": "OAuth"})
    await client.post(f"/api/requests/{rid}/close",
                      json={"requester_agent_id": a["agent_id"]})

    # default hides the closed request...
    d = (await client.get(f"/api/agents/{a['agent_id']}/outbox")).json()
    assert rid not in [r["id"] for r in d["outgoing_requests"]]

    # ...but include_recently_closed surfaces it.
    d2 = (await client.get(
        f"/api/agents/{a['agent_id']}/outbox?include_recently_closed=true")).json()
    assert rid in [r["id"] for r in d2["outgoing_requests"]]
