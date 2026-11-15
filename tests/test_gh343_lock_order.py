"""GH #343 review round 5: taking on work locks rows in the same order as ending a run.

Ending a run locks the task, then the run, then revokes the token. Accepting or claiming a
task and registering a run must take the task, run and token rows in that order too, or
on PostgreSQL an acceptance racing a shutdown waits in a circle and one of them fails with
a deadlock error. SQLite runs one writer at a time, so these tests record the order of the
row locks each request takes, and replay the two "it changed in between" cases that make
the lock helpers start over.
"""

import re
from uuid import uuid4

import pytest

from portal_backend import database, sql
from test_gh343_task_pause_gates import (
    _accept,
    _claimed_unregistered_worker,
    _register,
    _renewal,
    pause,
)

_LOCK = " /*row lock*/"
_RANK = {"tasks": 0, "worker_runs": 1, "embodiment_tokens": 2}


@pytest.fixture
def trace(monkeypatch):
    """Statements that lock task, run or token rows, in order; plus injectable hooks."""
    seen, hooks = [], []
    real_for_update, real_execute = sql.for_update, database.Cursor.execute

    def for_update(*, of=None, skip_locked=False):
        real_for_update(of=of, skip_locked=skip_locked)  # same argument checks
        return _LOCK

    def execute(self, query, params=None):
        for hook in list(hooks):
            hook(self, query, real_execute)
        locked = re.match(r"\s*SELECT .*? FROM (\w+)", query, re.S) if _LOCK in query else None
        updated = re.match(r"\s*UPDATE (\w+)", query)
        table = (locked or updated).group(1) if (locked or updated) else None
        if table in _RANK:
            seen.append((table, "lock" if locked else "update"))
        if query.startswith(("ROLLBACK TO", "SAVEPOINT")):
            seen.append((query, "savepoint"))
        return real_execute(self, query, params)

    monkeypatch.setattr(sql, "for_update", for_update)
    monkeypatch.setattr(database.Cursor, "execute", execute)
    return seen, hooks


def assert_in_order(events, *, fresh=()):
    """No task or run row is taken after the token row unless it was locked before it.

    ``fresh`` names tables whose rows this request created itself (nobody else can hold them).
    """
    held, token_taken = set(), False
    for table, how in events:
        if how == "savepoint":
            if table.startswith("ROLLBACK TO"):
                held, token_taken = set(), False  # the locks since the savepoint are gone
            continue
        if table == "embodiment_tokens":
            token_taken = True
        elif token_taken:
            assert table in held or table in fresh, events
        elif how == "lock":
            held.add(table)


async def _setup(make_agent, client, work_headers):
    human = (await make_agent("Owner", kind="human"))["agent_id"]
    aid = (await make_agent("Builder"))["agent_id"]
    protocol, headers = await _claimed_unregistered_worker(client, work_headers, aid)
    return human, aid, protocol, headers


async def test_taking_on_work_and_ending_a_run_lock_task_then_run_then_token(
    client, container, make_agent, make_request, work_headers, trace,
):
    seen, _ = trace
    human, aid, protocol, headers = await _setup(make_agent, client, work_headers)
    seen.clear()
    tid = await _accept(client, make_request, human, aid, headers, "Before registration")
    assert_in_order(seen)
    seen.clear()
    run = await _register(client, aid, headers, None, protocol["task_id"])
    assert ("tasks", "lock") in seen and ("embodiment_tokens", "lock") in seen, seen
    assert_in_order(seen, fresh=("worker_runs",))
    request = await make_request(human, "Retry me", target_alias="Builder", type="task",
                                 task={"title": "Retry me", "definition_of_done": "Done"})
    url = f"/api/requests/{request['request_id']}/accept-task"
    assert (await client.post(url, json={"responder_agent_id": aid}, headers=headers)).status_code == 200
    seen.clear()
    # The acceptance retry the review raced against the shutdown: task, run, then token.
    retry = await client.post(url, json={"responder_agent_id": aid}, headers=headers)
    assert retry.status_code == 200, retry.text
    locks = [t for t, how in seen if how == "lock"]
    assert locks.index("tasks") < locks.index("worker_runs") < locks.index("embodiment_tokens"), seen
    assert_in_order(seen)
    seen.clear()
    revoked = await client.post(f"/api/embodiment-tokens/{headers['X-Orcha-Run-Token']}/revoke")
    assert revoked.status_code == 200 and revoked.json()["revoked"] is True, revoked.text
    assert_in_order(seen)
    assert (await pause(client, tid, human)).status_code == 200


async def test_claiming_with_next_locks_the_task_before_the_token(
    client, container, make_agent, make_task, work_headers, db, trace,
):
    seen, _ = trace
    human, aid, protocol, headers = await _setup(make_agent, client, work_headers)
    for when in ("before_registration", "after_registration"):
        tid = (await make_task(f"Ready {when}", "Done", assignee_alias="Builder"))["id"]
        db.execute("UPDATE tasks SET status='ready' WHERE id=%s", (tid,))
        seen.clear()
        claimed = await client.post(f"/api/agents/{aid}/next", headers=headers)
        assert claimed.status_code == 200 and claimed.json()["task"]["id"] == tid, claimed.text
        assert ("embodiment_tokens", "lock") in seen, seen
        assert_in_order(seen)
        if when == "before_registration":
            await _register(client, aid, headers, None, protocol["task_id"])


async def test_a_token_bound_between_the_two_reads_links_the_accepted_task_to_the_run(
    client, container, make_agent, make_request, work_headers, db, trace,
):
    """Registration commits after acceptance read the token but before it locked it."""
    seen, hooks = trace
    human, aid, protocol, headers = await _setup(make_agent, client, work_headers)
    token = headers["X-Orcha-Run-Token"]
    run_id = str(uuid4())
    db.execute("INSERT INTO worker_runs (run_id, agent_id, wake_kind, lane, status) "
               "VALUES (%s, %s, 'ephemeral', 'work', 'running')", (run_id, aid))
    bind = "UPDATE embodiment_tokens SET run_id=%s WHERE run_token=%s"
    state = {"bound": False}

    def registration_commits(cur, query, execute):
        locking_token = _LOCK in query and "FROM embodiment_tokens" in query and "lane='work'" in query
        if locking_token and not state["bound"]:
            state["bound"] = True
            execute(cur, bind, (run_id, token))
        elif query.startswith("ROLLBACK TO SAVEPOINT gh343_token_lock"):
            hooks.append(lambda c, q, e: (hooks.pop(), e(c, bind, (run_id, token))))

    hooks.append(registration_commits)
    tid = await _accept(client, make_request, human, aid, headers, "Raced registration")
    hooks.clear()
    assert ("ROLLBACK TO SAVEPOINT gh343_token_lock", "savepoint") in seen, seen
    assert_in_order(seen)
    assert [str(r["task_id"]) for r in db.execute(
        "SELECT task_id FROM worker_run_tasks WHERE run_id=%s", (run_id,))] == [tid]
    assert db.execute("SELECT task_id FROM embodiment_token_tasks WHERE run_token=%s", (token,)) == []
    paused = await pause(client, tid, human)
    assert paused.status_code == 200 and run_id in paused.json()["stopped_runs"], paused.text


async def test_a_task_accepted_between_registrations_two_reads_is_locked_and_checked(
    client, container, make_agent, make_task, make_request, work_headers, db, trace,
):
    """Acceptance commits after registration read the waiting tasks but before the token lock."""
    seen, hooks = trace
    human, aid, protocol, headers = await _setup(make_agent, client, work_headers)
    token = headers["X-Orcha-Run-Token"]
    late = (await make_task("Accepted in between", "Done", assignee_alias="Builder"))["id"]
    db.execute("UPDATE tasks SET paused_at=now(), paused_by=%s WHERE id=%s", (human, late))
    accept = "INSERT INTO embodiment_token_tasks (run_token, task_id) VALUES (%s, %s)"
    state = {"accepted": False}

    def acceptance_commits(cur, query, execute):
        locking_token = _LOCK in query and "FROM embodiment_tokens" in query and "run_id IS NULL" in query
        if locking_token and not state["accepted"]:
            state["accepted"] = True
            execute(cur, accept, (token, late))
        elif query.startswith("ROLLBACK TO SAVEPOINT gh343_registration_lock"):
            hooks.append(lambda c, q, e: (hooks.pop(), e(c, accept, (token, late))))

    hooks.append(acceptance_commits)
    seen.clear()
    run = await _register(client, aid, headers, None, protocol["task_id"])
    hooks.clear()
    assert ("ROLLBACK TO SAVEPOINT gh343_registration_lock", "savepoint") in seen, seen
    assert_in_order(seen, fresh=("worker_runs",))
    assert (await _renewal(client, aid, run["run_id"]))["stop_requested"] is True
    assert [str(r["task_id"]) for r in db.execute(
        "SELECT task_id FROM worker_run_tasks WHERE run_id=%s", (run["run_id"],))] == [late]


async def test_tasks_accepted_between_the_reads_on_every_pass_never_lock_a_task_after_the_token(
    client, container, make_agent, make_task, make_request, work_headers, db, trace,
):
    """Review round 6: registration starts over as often as tasks keep arriving in between.

    Earlier, the fifth pass kept the token and then locked the newly arrived task, so an
    acceptance holding that task and waiting for the token deadlocked on PostgreSQL. Here a
    task arrives between the two reads on seven passes in a row; every pass that keeps its
    locks took the tasks first, and the run ends up linked to all of them.
    """
    seen, hooks = trace
    human, aid, protocol, headers = await _setup(make_agent, client, work_headers)
    token = headers["X-Orcha-Run-Token"]
    pending = [
        (await make_task(f"Accepted in between {i}", "Done", assignee_alias="Builder"))["id"]
        for i in range(7)
    ]
    db.execute("UPDATE tasks SET paused_at=now(), paused_by=%s WHERE id=%s", (human, pending[-1]))
    accept = "INSERT INTO embodiment_token_tasks (run_token, task_id) VALUES (%s, %s)"
    arrived = []

    def acceptances_commit(cur, query, execute):
        locking_token = _LOCK in query and "FROM embodiment_tokens" in query and "run_id IS NULL" in query
        if locking_token and len(arrived) < len(pending):
            arrived.append(pending[len(arrived)])
            execute(cur, accept, (token, arrived[-1]))
        elif query.startswith("ROLLBACK TO SAVEPOINT gh343_registration_lock"):
            # The rollback also undoes this pass's acceptance; it committed, so redo it.
            hooks.append(lambda c, q, e, tid=arrived[-1]: (hooks.pop(), e(c, accept, (token, tid))))

    hooks.append(acceptances_commit)
    seen.clear()
    run = await _register(client, aid, headers, None, protocol["task_id"])
    hooks.clear()
    restarts = [e for e in seen if e[0].startswith("ROLLBACK TO SAVEPOINT gh343_registration_lock")]
    assert len(restarts) == len(pending), seen
    assert_in_order(seen, fresh=("worker_runs",))
    assert (await _renewal(client, aid, run["run_id"]))["stop_requested"] is True
    assert sorted(str(r["task_id"]) for r in db.execute(
        "SELECT task_id FROM worker_run_tasks WHERE run_id=%s", (run["run_id"],))) == sorted(pending)
    assert db.execute("SELECT task_id FROM embodiment_token_tasks WHERE run_token=%s", (token,)) == []
