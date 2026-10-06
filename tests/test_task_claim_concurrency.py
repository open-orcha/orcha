"""GH #258 S4 (PR 7c): concurrent POST /api/agents/{aid}/next claims hand out each ready task
exactly once.

The claim is one `UPDATE tasks ... WHERE id = (SELECT ... LIMIT 1) RETURNING` inside the
scope's write transaction. These tests fire the claims concurrently through the ASGI app (the
sync route runs on the anyio threadpool, so the handlers really overlap) and assert: one winner
per task, the losers get `{"task": None}`, no 5xx, and one `working` agent_tasks row per
claimed task.
"""
import asyncio

TASKS = 10


async def _ready_tasks(client, make_task, human_id, agent_id, n=TASKS):
    """n ready tasks assigned to `agent_id` (assign flips an unassigned task to ready)."""
    ids = []
    for i in range(n):
        t = await make_task(f"claim-{i}", "claimed once")
        r = await client.post(
            f"/api/tasks/{t['task_id']}/assign",
            json={"actor_agent_id": human_id, "agent_id": agent_id},
        )
        assert r.status_code == 200 and r.json()["status"] == "ready", r.text
        ids.append(t["task_id"])
    return ids


async def _claim_all(client, claims):
    """Fire every (agent_id, headers) claim at once; return the responses."""
    return await asyncio.gather(
        *(client.post(f"/api/agents/{aid}/next", headers=h) for aid, h in claims)
    )


def _winners(responses):
    assert all(r.status_code == 200 for r in responses), [
        (r.status_code, r.text) for r in responses if r.status_code != 200
    ]
    return [r.json()["task"]["id"] for r in responses if r.json()["task"] is not None]


async def test_twenty_claims_over_ten_tasks_one_winner_each(
    client, db, make_agent, make_task, work_headers
):
    human = await make_agent("op", "operator", kind="human")
    a = await make_agent("claimer", "eng")
    ids = await _ready_tasks(client, make_task, human["agent_id"], a["agent_id"])
    claims = [(a["agent_id"], await work_headers(a["agent_id"])) for _ in range(2 * TASKS)]

    responses = await _claim_all(client, claims)

    won = _winners(responses)
    assert sorted(won) == sorted(ids)  # every task claimed, none twice
    assert sum(r.json()["task"] is None for r in responses) == TASKS
    rows = db.execute(
        "SELECT task_id, assignment_status FROM agent_tasks WHERE agent_id=%s", (a["agent_id"],)
    )
    assert sorted(str(r["task_id"]) for r in rows) == sorted(ids)
    assert {r["assignment_status"] for r in rows} == {"working"}
    statuses = db.execute(
        "SELECT status FROM tasks WHERE id IN (" + ",".join(["%s"] * len(ids)) + ")", tuple(ids)
    )
    assert {r["status"] for r in statuses} == {"in_progress"}


async def test_five_agents_sharing_ten_tasks_still_ten_winners(
    client, db, make_agent, make_task, work_headers
):
    human = await make_agent("op", "operator", kind="human")
    agents = [await make_agent(f"claimer-{i}", "eng") for i in range(5)]
    ids = await _ready_tasks(client, make_task, human["agent_id"], agents[0]["agent_id"])
    # The assign route keeps one active assignee per task, so the other four agents are
    # co-assigned at the row level: every agent sees all ten tasks as its own ready work.
    for ag in agents[1:]:
        for tid in ids:
            db.execute(
                "INSERT INTO agent_tasks (agent_id, task_id, assignment_status) "
                "VALUES (%s, %s, 'assigned')",
                (ag["agent_id"], tid),
            )
    claims = []
    for ag in agents:
        for _ in range(TASKS):
            claims.append((ag["agent_id"], await work_headers(ag["agent_id"])))

    responses = await _claim_all(client, claims)

    won = _winners(responses)
    assert sorted(won) == sorted(ids)  # 50 claims, still exactly one winner per task
    assert sum(r.json()["task"] is None for r in responses) == len(claims) - TASKS
    working = db.execute(
        "SELECT task_id FROM agent_tasks WHERE assignment_status='working' "
        "AND task_id IN (" + ",".join(["%s"] * len(ids)) + ")",
        tuple(ids),
    )
    assert sorted(str(r["task_id"]) for r in working) == sorted(ids)  # one working row each
