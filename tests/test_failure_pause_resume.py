"""Failure pause -> human answer/nudge -> explicit resume from the notice -> real work."""

import json
import types

from orcha_cli.notifier_wake_candidate import process_candidate
from portal_backend import sql

ERROR = "You've hit your usage limit."


async def candidate(client, cid, aid):
    response = await client.get(f"/api/containers/{cid}/wake-scan?cooldown=0&min_idle=0")
    assert response.status_code == 200, response.text
    return next(c for c in response.json()["candidates"] if c["agent_id"] == aid)


async def fail_three_times(client, db, aid, tid):
    output = json.dumps({"type": "turn.failed", "error": {"message": ERROR}})
    for _ in range(3):
        run = await client.post(f"/api/agents/{aid}/runs", json={
            "wake_kind": "ephemeral", "wake_event": "task_message", "task_id": tid,
        })
        assert run.status_code == 201, run.text
        done = await client.post(f"/api/runs/{run.json()['run_id']}/finish", json={
            "status": "failed", "exit_code": 1, "output": output,
        })
        assert done.status_code == 200, done.text
        db.execute("UPDATE wake_backoff SET suppressed_until=%s WHERE agent_id=%s", (sql.ago(1), aid))
    notices = db.execute(
        "SELECT * FROM requests WHERE requester_id=%s ORDER BY created_at DESC", (aid,))
    return str(notices[0]["id"])


def resume(client, rid, actor):
    return client.post(f"/api/requests/{rid}/resume-automatic-work", json={"actor_agent_id": actor})


async def setup(client, container, make_agent, make_task):
    human = (await make_agent("Owner", kind="human"))["agent_id"]
    aid = (await make_agent("Builder"))["agent_id"]
    tid = (await make_task("Workflows implementation", "Reviewed", assignee_alias="Builder"))["id"]
    return container["id"], human, aid, tid


async def test_answer_and_nudge_say_still_paused_then_resume_restores_the_same_work(
    client, container, make_agent, make_task, db,
):
    cid, human, aid, tid = await setup(client, container, make_agent, make_task)
    rid = await fail_three_times(client, db, aid, tid)
    notice = db.execute("SELECT payload FROM requests WHERE id=%s", (rid,))[0]["payload"]
    assert "Resume automatic work on this request" in notice

    answered = await client.post(f"/api/requests/{rid}/respond", json={
        "responder_agent_id": human, "response": "Limit reset. Continue"})
    assert answered.status_code == 200, answered.text
    assert answered.json()["automatic_work"]["paused"] is True
    assert "still paused" in answered.json()["automatic_work"]["message"]
    for text in ["Continue the approved task", "Distinct follow-up: preserve the stop controls"]:
        sent = await client.post(f"/api/tasks/{tid}/messages", json={"author_agent_id": human, "body": text})
        assert sent.status_code == 201, sent.text
    nudge = await client.post(f"/api/requests/{rid}/nudge", json={"actor_agent_id": human})
    assert nudge.status_code == 200 and nudge.json()["nudged"] is True
    assert nudge.json()["automatic_work"]["resume_path"] == f"/api/requests/{rid}/resume-automatic-work"

    # Reply text alone never resumes: the scan, notifier and lease all still refuse.
    paused = await candidate(client, cid, aid)
    assert paused["failure_paused"] and not paused["should_wake"]
    assert process_candidate("", paused, context={}, dry_run=False, quiet=True,
                             lease_ttl=180, live_workers={}, services=types.SimpleNamespace()) is None
    assert (await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_kind": "ephemeral"})).json()["claimed"] is False

    other = db.execute("SELECT count(*) AS n FROM wake_backoff WHERE agent_id=%s", (aid,))[0]["n"]
    db.execute("INSERT INTO wake_backoff (container_id, agent_id, wake_key, strikes) VALUES (%s,%s,'auto_wake',2)", (cid, aid))
    resumed = await resume(client, rid, human)
    assert resumed.status_code == 200, resumed.text
    assert resumed.json() == {"request_id": rid, "agent_id": aid, "state": "resumed", "resumed": True}
    # Only the failure pause went; other pacing, the request, events and acks are preserved.
    assert [r["wake_key"] for r in db.execute("SELECT wake_key FROM wake_backoff WHERE agent_id=%s", (aid,))] == ["auto_wake"] and other == 1
    db.execute("DELETE FROM wake_backoff WHERE agent_id=%s AND wake_key='auto_wake'", (aid,))
    assert db.execute("SELECT status FROM requests WHERE id=%s", (rid,))[0]["status"] == "answered"
    assert not db.execute("SELECT * FROM agent_event_acks WHERE agent_id=%s", (aid,))
    again = await resume(client, rid, human)
    assert again.status_code == 200 and again.json()["resumed"] is False and again.json()["state"] == "resumed"

    ready = await candidate(client, cid, aid)
    assert ready["should_wake"] and ready["context_task_id"] == tid
    names = {e["id"]: e["event_name"] for e in db.event_rows(aid)}
    handled = [names[i] for i in ready["handled_event_ids"] if i in names]
    assert handled.count("task_message") == 2 and "request_answered" in handled and "prompt" in handled
    assert (await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_kind": "ephemeral"})).json()["claimed"] is True
    run = await client.post(f"/api/agents/{aid}/runs", json={"task_id": tid, "wake_kind": "ephemeral"})
    assert run.status_code == 201, run.text
    done = await client.post(f"/api/runs/{run.json()['run_id']}/finish", json={
        "status": "exited", "exit_code": 0, "output": "Handled the saved messages"})
    assert done.status_code == 200
    ack = await client.post(f"/api/agents/{aid}/events/ack-handled", json={"event_ids": ready["handled_event_ids"]})
    assert ack.status_code == 200
    acked = {r["event_id"] for r in db.execute("SELECT event_id FROM agent_event_acks WHERE agent_id=%s", (aid,))}
    assert set(ready["handled_event_ids"]) <= acked


async def test_failure_after_resume_pauses_again_and_old_notice_cannot_clear_it(
    client, container, make_agent, make_task, db,
):
    cid, human, aid, tid = await setup(client, container, make_agent, make_task)
    first = await fail_three_times(client, db, aid, tid)
    db.execute("UPDATE requests SET created_at=%s WHERE id=%s", (sql.ago(3600), first))
    db.execute("UPDATE wake_backoff SET first_strike_at=%s WHERE agent_id=%s", (sql.ago(3700), aid))
    assert (await resume(client, first, human)).json()["resumed"] is True
    second = await fail_three_times(client, db, aid, tid)
    assert second != first
    stale = await resume(client, first, human)
    assert stale.status_code == 409 and "newer pause" in stale.text
    assert (await candidate(client, cid, aid))["failure_paused"]
    assert (await resume(client, second, human)).json()["resumed"] is True


async def test_resume_requires_a_human_in_the_same_project_and_a_real_notice(
    client, container, make_agent, make_task, make_request, db,
):
    cid, human, aid, tid = await setup(client, container, make_agent, make_task)
    rid = await fail_three_times(client, db, aid, tid)
    assert (await resume(client, rid, aid)).status_code == 403
    other = (await client.post("/api/containers", json={"name": "other-project", "additional": True})).json()["container_id"]
    outsider = (await make_agent("Outsider", kind="human", container_id=other))["agent_id"]
    assert (await resume(client, rid, outsider)).status_code in (400, 403)
    assert (await candidate(client, cid, aid))["failure_paused"]
    # A look-alike request written by the agent has no server pause record.
    forged = await make_request(aid, "Builder's automatic work is paused after 3 consecutive failed runs.",
                                target_alias="Owner")
    assert (await resume(client, forged["id"], human)).status_code == 409
    assert (await candidate(client, cid, aid))["failure_paused"]


async def test_notice_sent_before_this_repair_resolves_from_the_audit_record(
    client, container, make_agent, make_task, db,
):
    cid, human, aid, tid = await setup(client, container, make_agent, make_task)
    rid = await fail_three_times(client, db, aid, tid)
    # Older notices carry the earlier wording; the link never depended on it.
    db.execute("UPDATE requests SET payload=%s WHERE id=%s",
               ("Builder's automatic work is paused. Open Activity and choose Resume automatic work.", rid))
    assert (await resume(client, rid, human)).json()["resumed"] is True
    assert (await candidate(client, cid, aid))["should_wake"]


async def test_pause_listing_points_at_the_notice_that_can_resume_it(
    client, container, make_agent, make_task, db,
):
    cid, human, aid, tid = await setup(client, container, make_agent, make_task)
    rid = await fail_three_times(client, db, aid, tid)
    listing = (await client.get(f"/api/containers/{cid}/wake-backoff")).json()["backoffs"]
    assert [(r["agent_id"], r["paused"], r["notice_request_id"]) for r in listing] == [(aid, True, rid)]
    assert (await resume(client, rid, human)).json()["resumed"] is True
    assert (await client.get(f"/api/containers/{cid}/wake-backoff")).json()["backoffs"] == []


async def test_other_answers_and_nudges_say_paused_then_reach_the_agent_after_resume(
    client, container, make_agent, make_task, make_request, db,
):
    cid, human, aid, tid = await setup(client, container, make_agent, make_task)
    parent = await make_request(human, "Ship the reviewed fix", target_alias="Builder")
    child = await make_request(aid, "Which branch?", target_alias="Owner", parent_request_id=parent["id"])
    question = await make_request(aid, "May I rebase?", target_alias="Owner")
    await fail_three_times(client, db, aid, tid)
    notice = str(db.execute("SELECT entity_id FROM events WHERE entity_type='request' "
                            "AND event_type='created' AND actor_type='system'")[0]["entity_id"])
    resume_path = f"/api/requests/{notice}/resume-automatic-work"

    # The paused agent's own question and a parent chain: saved, unblocked, but not started.
    answered = await client.post(f"/api/requests/{child['id']}/respond", json={
        "responder_agent_id": human, "response": "Use main"})
    assert answered.status_code == 200, answered.text
    assert answered.json()["unblocks_parent"]["parent_request_id"] == parent["id"]
    assert answered.json()["automatic_work"]["resume_path"] == resume_path
    nudge = await client.post(f"/api/requests/{parent['id']}/nudge", json={"actor_agent_id": human})
    assert nudge.status_code == 200 and nudge.json()["nudged"] is True
    assert nudge.json()["automatic_work"]["notice_request_id"] == notice
    assert not (await candidate(client, cid, aid))["should_wake"]

    assert (await resume(client, notice, human)).json()["resumed"] is True
    later = await client.post(f"/api/requests/{question['id']}/respond", json={
        "responder_agent_id": human, "response": "Yes"})
    assert later.status_code == 200 and "automatic_work" not in later.json()
    ready = await candidate(client, cid, aid)
    assert ready["should_wake"]
    rows = {e["id"]: e for e in db.event_rows(aid)}
    answered_ids = {json.loads(rows[i]["payload"]).get("request_id") if isinstance(rows[i]["payload"], str)
                    else rows[i]["payload"].get("request_id")
                    for i in ready["handled_event_ids"] if i in rows and rows[i]["event_name"] == "request_answered"}
    assert {child["id"], question["id"]} <= answered_ids
    assert "prompt" in [rows[i]["event_name"] for i in ready["handled_event_ids"] if i in rows]
