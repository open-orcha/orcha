"""GH #83 — lazy/late worker-run → task attribution.

A worker run that does work for a task must be attributed to that task no matter how the
worker was spawned. Several spawn paths can't supply a task_id at wake time:
  - a task-request accept (the spawned task is in_progress, not ready-queued, and no wake
    event carries its id),
  - a checkpoint respawn that lost the original wake context,
  - any wake that fires without a directed task event.
The portal backfills the link server-side: at run start (POST /agents/{aid}/runs) from the
agent's current in_progress task, and as a backstop on /finish for a run still unattached.
The inference only fires when the agent's active task is UNAMBIGUOUS (exactly one in_progress
task); with several concurrent tasks it declines rather than guess wrong, leaving the run NULL.
"""
import uuid


def _task_payload(title="build X", dod="done"):
    return {"title": title, "definition_of_done": dod, "priority": 100}


async def test_run_without_task_id_attributes_to_current_in_progress_task(
        client, make_agent, make_task):
    """A run started with no task_id is lazily linked to the agent's current in_progress task.
    An assigned task is created in_progress with an agent_tasks 'working' row."""
    a = await make_agent("W", "eng")
    aid = a["agent_id"]
    tid = (await make_task("T", "dod", assignee_alias="W"))["id"]

    # the daemon spawns a run but passes NO task_id (e.g. wake carried no directed task event)
    r = await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral"})
    assert r.status_code == 201, r.text
    assert r.json()["task_id"] == tid              # lazily attributed at start

    # the run shows up under the task's run feed
    pt = await client.get(f"/api/tasks/{tid}/runs")
    assert [run["run_id"] for run in pt.json()["runs"]] == [r.json()["run_id"]]


async def test_accept_task_spawned_run_is_attributed(
        client, make_agent, make_request, work_headers):
    """The headline scenario: a worker created by ACCEPTING a task request must not float
    unattached. The accepter's next run (no task_id from the wake) links to the spawned task."""
    a = await make_agent("Requester", "lead")
    b = await make_agent("bb", "eng")
    req = await make_request(a["agent_id"], "build X", target_alias="bb",
                             type="task", task=_task_payload())
    # GH #91/#90: accept-task is work-lane gated — the accepter must present a WORK token.
    acc = await client.post(f"/api/requests/{req['request_id']}/accept-task",
                            json={"responder_agent_id": b["agent_id"], "note": "on it"},
                            headers=await work_headers(b["agent_id"]))
    assert acc.status_code == 200, acc.text
    spawned = acc.json()["spawned_task_id"]
    assert spawned

    # the accepter wakes to work the spawned task; the wake carries no task_id
    r = await client.post(f"/api/agents/{b['agent_id']}/runs", json={"wake_kind": "ephemeral"})
    assert r.status_code == 201, r.text
    assert r.json()["task_id"] == spawned

    pt = await client.get(f"/api/tasks/{spawned}/runs")
    assert r.json()["run_id"] in [run["run_id"] for run in pt.json()["runs"]]


async def test_accept_task_attributes_current_accepting_run(
        client, make_agent, make_request, db, work_headers):
    """Follow-up repro (PR #139 live symptom): accepting a task request happens inside an
    already-running inbox/request worker. There is no later run-start event for GH #83's lazy
    inference to fix, so accept-task must attach the current token-bound worker run itself."""
    a = await make_agent("Requester", "lead")
    b = await make_agent("bb", "eng")
    req = await make_request(a["agent_id"], "build X", target_alias="bb",
                             type="task", task=_task_payload())
    headers = await work_headers(b["agent_id"])
    token = headers["X-Orcha-Run-Token"]

    # The worker is already running before it accepts the task request, and it starts task-less.
    started = await client.post(f"/api/agents/{b['agent_id']}/runs",
                                json={"wake_kind": "ephemeral", "token_id": token})
    assert started.status_code == 201, started.text
    run_id = started.json()["run_id"]
    assert started.json()["task_id"] is None

    acc = await client.post(f"/api/requests/{req['request_id']}/accept-task",
                            json={"responder_agent_id": b["agent_id"], "note": "on it"},
                            headers=headers)
    assert acc.status_code == 200, acc.text
    spawned = acc.json()["spawned_task_id"]

    row = db.execute("SELECT task_id FROM worker_runs WHERE run_id=%s", (run_id,))[0]
    assert str(row["task_id"]) == spawned
    pt = await client.get(f"/api/tasks/{spawned}/runs")
    assert run_id in [run["run_id"] for run in pt.json()["runs"]]


async def test_accept_task_does_not_overwrite_existing_run_task(
        client, make_agent, make_task, make_request, db, work_headers):
    """If the token-bound run already has an explicit task link, accept-task must not move it to
    the newly spawned task. Wrong attribution is worse than leaving the new task without this run."""
    a = await make_agent("Requester", "lead")
    b = await make_agent("bb", "eng")
    existing = await make_task("existing task", "done", assignee_alias="bb")
    headers = await work_headers(b["agent_id"])
    token = headers["X-Orcha-Run-Token"]
    started = await client.post(f"/api/agents/{b['agent_id']}/runs",
                                json={"wake_kind": "ephemeral",
                                      "token_id": token,
                                      "task_id": existing["id"]})
    assert started.status_code == 201, started.text
    run_id = started.json()["run_id"]
    assert started.json()["task_id"] == existing["id"]

    req = await make_request(a["agent_id"], "build X", target_alias="bb",
                             type="task", task=_task_payload(title="new task"))
    acc = await client.post(f"/api/requests/{req['request_id']}/accept-task",
                            json={"responder_agent_id": b["agent_id"], "note": "on it"},
                            headers=headers)
    assert acc.status_code == 200, acc.text
    spawned = acc.json()["spawned_task_id"]

    row = db.execute("SELECT task_id FROM worker_runs WHERE run_id=%s", (run_id,))[0]
    assert str(row["task_id"]) == existing["id"]
    spawned_runs = await client.get(f"/api/tasks/{spawned}/runs")
    assert run_id not in [run["run_id"] for run in spawned_runs.json()["runs"]]


async def test_accept_task_retry_attributes_respawned_taskless_run(
        client, make_agent, make_task, make_request, db, work_headers):
    """If the first accept response is lost and a respawn retries the already-accepted request,
    the retry branch should attach the respawned run to the still-in-progress spawned task."""
    a = await make_agent("Requester", "lead")
    b = await make_agent("bb", "eng")
    req = await make_request(a["agent_id"], "build X", target_alias="bb",
                             type="task", task=_task_payload())
    h1 = await work_headers(b["agent_id"])
    started1 = await client.post(f"/api/agents/{b['agent_id']}/runs",
                                 json={"wake_kind": "ephemeral",
                                       "token_id": h1["X-Orcha-Run-Token"]})
    assert started1.status_code == 201, started1.text
    acc1 = await client.post(f"/api/requests/{req['request_id']}/accept-task",
                             json={"responder_agent_id": b["agent_id"], "note": "on it"},
                             headers=h1)
    assert acc1.status_code == 200, acc1.text
    spawned = acc1.json()["spawned_task_id"]
    await client.post(f"/api/runs/{started1.json()['run_id']}/finish",
                      json={"status": "killed"})

    # A second active task makes run-start inference ambiguous, so only the retry branch can attach.
    await make_task("other active task", "done", assignee_alias="bb")
    h2 = await work_headers(b["agent_id"])
    started2 = await client.post(f"/api/agents/{b['agent_id']}/runs",
                                 json={"wake_kind": "ephemeral",
                                       "token_id": h2["X-Orcha-Run-Token"]})
    assert started2.status_code == 201, started2.text
    assert started2.json()["task_id"] is None
    run2 = started2.json()["run_id"]

    retry = await client.post(f"/api/requests/{req['request_id']}/accept-task",
                              json={"responder_agent_id": b["agent_id"], "note": "retry"},
                              headers=h2)
    assert retry.status_code == 200, retry.text
    assert retry.json()["already_accepted"] is True
    assert retry.json()["spawned_task_id"] == spawned
    row = db.execute("SELECT task_id FROM worker_runs WHERE run_id=%s", (run2,))[0]
    assert str(row["task_id"]) == spawned


async def test_accept_task_retry_does_not_attribute_completed_spawned_task(
        client, make_agent, make_request, db, work_headers):
    """A stale retry of an old accepted request must not stamp a new task-less run with a task
    that has already completed."""
    a = await make_agent("Requester", "lead")
    b = await make_agent("bb", "eng")
    req = await make_request(a["agent_id"], "build X", target_alias="bb",
                             type="task", task=_task_payload())
    h1 = await work_headers(b["agent_id"])
    started1 = await client.post(f"/api/agents/{b['agent_id']}/runs",
                                 json={"wake_kind": "ephemeral",
                                       "token_id": h1["X-Orcha-Run-Token"]})
    assert started1.status_code == 201, started1.text
    acc1 = await client.post(f"/api/requests/{req['request_id']}/accept-task",
                             json={"responder_agent_id": b["agent_id"], "note": "on it"},
                             headers=h1)
    assert acc1.status_code == 200, acc1.text
    spawned = acc1.json()["spawned_task_id"]
    db.execute("UPDATE tasks SET status='completed' WHERE id=%s", (spawned,))

    h2 = await work_headers(b["agent_id"])
    started2 = await client.post(f"/api/agents/{b['agent_id']}/runs",
                                 json={"wake_kind": "ephemeral",
                                       "token_id": h2["X-Orcha-Run-Token"]})
    assert started2.status_code == 201, started2.text
    assert started2.json()["task_id"] is None
    run2 = started2.json()["run_id"]
    retry = await client.post(f"/api/requests/{req['request_id']}/accept-task",
                              json={"responder_agent_id": b["agent_id"], "note": "stale retry"},
                              headers=h2)
    assert retry.status_code == 200, retry.text
    assert retry.json()["already_accepted"] is True
    row = db.execute("SELECT task_id FROM worker_runs WHERE run_id=%s", (run2,))[0]
    assert row["task_id"] is None


async def test_late_attribution_on_finish_when_unattached_at_start(
        client, make_agent, make_task):
    """Backstop: a run that started before the agent had any in_progress task (so it began
    unattached) is reconciled on /finish once the agent's current task is determinable."""
    a = await make_agent("W", "eng")
    aid = a["agent_id"]

    # run starts while the agent holds no in_progress task → unattached
    r = await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral"})
    assert r.json()["task_id"] is None

    # the agent now has an in_progress task (assigned task is created in_progress + working)
    tid = (await make_task("T", "dod", assignee_alias="W"))["id"]

    # finishing the run backfills the link
    f = await client.post(f"/api/runs/{r.json()['run_id']}/finish",
                          json={"status": "exited", "exit_code": 0})
    assert f.status_code == 200
    run = (await client.get(f"/api/agents/{aid}/runs")).json()["runs"][0]
    assert run["task_id"] == tid


async def test_explicit_task_id_is_never_overwritten(client, make_agent, make_task):
    """No regression: an explicitly-supplied task_id is preserved at start AND survives finish
    (the finish backstop only fills a NULL link, never replaces an existing one)."""
    a = await make_agent("W", "eng")
    aid = a["agent_id"]
    # two concurrent in_progress tasks: the lazy fallback is ambiguous and would give up (None),
    # so the explicit T1 we pass is the ONLY thing that can link the run — proving the explicit
    # link is honoured over (and independent of) the inference path.
    t1 = await make_task("T1", "dod", assignee_alias="W")
    await make_task("T2", "dod", assignee_alias="W")

    r = await client.post(f"/api/agents/{aid}/runs",
                          json={"wake_kind": "ephemeral", "task_id": t1["id"]})
    assert r.json()["task_id"] == t1["id"]          # explicit link kept, not the lazy guess
    await client.post(f"/api/runs/{r.json()['run_id']}/finish", json={"status": "exited"})
    run = (await client.get(f"/api/agents/{aid}/runs")).json()["runs"][0]
    assert run["task_id"] == t1["id"]               # finish did not overwrite it


async def test_ambiguous_multiple_in_progress_tasks_stays_unattributed(
        client, make_agent, make_task):
    """kedar1607 (PR #86): when the agent holds SEVERAL concurrent in_progress tasks the
    inference can't tell which one an unlinked run belongs to. Rather than tag a plausible-but-
    possibly-wrong task, it declines — the run stays NULL at start AND on finish. A wrong link
    is worse than an honest unattributed run."""
    a = await make_agent("W", "eng")
    aid = a["agent_id"]
    # two concurrent in_progress tasks assigned to the same agent → ambiguous
    await make_task("T1", "dod", assignee_alias="W")
    await make_task("T2", "dod", assignee_alias="W")

    r = await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral"})
    assert r.status_code == 201, r.text
    assert r.json()["task_id"] is None              # ambiguous → not guessed at start

    f = await client.post(f"/api/runs/{r.json()['run_id']}/finish", json={"status": "exited"})
    assert f.status_code == 200
    run = (await client.get(f"/api/agents/{aid}/runs")).json()["runs"][0]
    assert run["task_id"] is None                   # still ambiguous → not guessed on finish


async def test_taskless_wake_stays_unattributed(client, make_agent):
    """An agent with no active task (a genuinely inbox-only wake) leaves the run unattached —
    we never invent a bogus link."""
    a = await make_agent("W", "eng")
    aid = a["agent_id"]
    r = await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral"})
    assert r.status_code == 201, r.text
    assert r.json()["task_id"] is None
    f = await client.post(f"/api/runs/{r.json()['run_id']}/finish", json={"status": "exited"})
    assert f.status_code == 200
    run = (await client.get(f"/api/agents/{aid}/runs")).json()["runs"][0]
    assert run["task_id"] is None


# ---------- non-task-work gate (GH #83 R2): conversation & live runs stay NULL ----------
#
# A resident/ephemeral per-turn conversation reply or a live terminal session posts a run with
# no task_id because it is definitionally NOT task work. Without the gate the lazy inference would
# stamp it onto the agent's SOLE in_progress task (the common case for a loop agent), regressing
# the GH #340 activity label and polluting /api/tasks/{tid}/runs. Each test below gives the agent
# EXACTLY ONE in_progress task, so an unattributed result proves the gate — not the absence of a
# candidate — is what keeps the run NULL.


async def test_resident_conversation_turn_run_stays_unattributed(client, make_agent, make_task):
    """A resident per-turn conversation reply (wake_kind='resident', wake_event='conversation_turn')
    is not task work: it stays NULL at start AND finish even though the agent has one in_progress
    task the inference would otherwise pick."""
    a = await make_agent("W", "eng")
    aid = a["agent_id"]
    await make_task("T", "dod", assignee_alias="W")   # the single in_progress task the gate must ignore

    r = await client.post(f"/api/agents/{aid}/runs",
                          json={"wake_kind": "resident", "wake_event": "conversation_turn"})
    assert r.status_code == 201, r.text
    assert r.json()["task_id"] is None                # gate skipped inference at start

    f = await client.post(f"/api/runs/{r.json()['run_id']}/finish", json={"status": "exited"})
    assert f.status_code == 200
    run = (await client.get(f"/api/agents/{aid}/runs")).json()["runs"][0]
    assert run["task_id"] is None                     # gate skipped the finish backstop too


async def test_codex_conversation_run_with_conversation_id_stays_unattributed(
        client, make_agent, make_task):
    """A Codex ephemeral conversation turn carries a conversation_id — the gate flags it as
    non-task work and leaves it NULL at start AND finish despite the agent's sole in_progress task."""
    human = await make_agent("Kedar", "human", kind="human")
    a = await make_agent("W", "eng")
    aid = a["agent_id"]
    await make_task("T", "dod", assignee_alias="W")   # single in_progress task the gate must ignore
    conv = (await client.post(f"/api/agents/{aid}/conversations",
                              json={"actor_agent_id": human["agent_id"]})).json()["conversation"]["id"]

    r = await client.post(f"/api/agents/{aid}/runs",
                          json={"wake_kind": "ephemeral", "wake_event": "conversation_turn",
                                "conversation_id": conv})
    assert r.status_code == 201, r.text
    assert r.json()["task_id"] is None                # conversation_id → gated at start

    f = await client.post(f"/api/runs/{r.json()['run_id']}/finish", json={"status": "exited"})
    assert f.status_code == 200
    run = (await client.get(f"/api/agents/{aid}/runs")).json()["runs"][0]
    assert run["task_id"] is None                     # still gated on finish


async def test_live_terminal_run_stays_unattributed(client, make_agent, make_task):
    """A live terminal session (wake_kind='live') is not task work — it stays NULL at start AND
    finish even with a single in_progress task available to the inference."""
    a = await make_agent("W", "eng")
    aid = a["agent_id"]
    await make_task("T", "dod", assignee_alias="W")   # single in_progress task the gate must ignore

    r = await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "live"})
    assert r.status_code == 201, r.text
    assert r.json()["task_id"] is None                # wake_kind='live' → gated at start

    f = await client.post(f"/api/runs/{r.json()['run_id']}/finish", json={"status": "exited"})
    assert f.status_code == 200
    run = (await client.get(f"/api/agents/{aid}/runs")).json()["runs"][0]
    assert run["task_id"] is None                     # still gated on finish


async def test_explicit_task_id_on_conversation_run_still_attaches(client, make_agent, make_task):
    """The gate only skips the INFERENCE fallback — it never blocks an explicit task_id. A run
    flagged as conversation work that nonetheless supplies a task_id is honoured and attached,
    at start and through finish."""
    a = await make_agent("W", "eng")
    aid = a["agent_id"]
    tid = (await make_task("T", "dod", assignee_alias="W"))["id"]

    r = await client.post(f"/api/agents/{aid}/runs",
                          json={"wake_kind": "resident", "wake_event": "conversation_turn",
                                "task_id": tid})
    assert r.status_code == 201, r.text
    assert r.json()["task_id"] == tid                 # explicit link honoured despite the gate

    await client.post(f"/api/runs/{r.json()['run_id']}/finish", json={"status": "exited"})
    run = (await client.get(f"/api/agents/{aid}/runs")).json()["runs"][0]
    assert run["task_id"] == tid                      # finish did not drop the explicit link
