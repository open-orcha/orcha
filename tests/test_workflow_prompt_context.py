"""The wake uses the task's workflow, never the agent's other memberships."""
import json
from uuid import uuid4

from orcha_cli.notifier_persona import format_persona


async def test_workflow_context_is_scoped_to_resolved_task(client, container, make_agent, make_task, db):
    owner = (await make_agent("Owner", kind="human"))["agent_id"]
    worker = (await make_agent("Worker"))["agent_id"]
    workflows = []
    for label in ("Mac release", "Mobile design"):
        wid = str(uuid4())
        db.execute("INSERT INTO workflows(id,container_id,owner_human_id,created_by_human_id,title,goal) VALUES (%s,%s,%s,%s,%s,%s)",
                   (wid, container["id"], owner, owner, label, label + " goal"))
        tasks = []
        for i in range(1, 5):
            t = await make_task(f"{label} step {i}", "Approved result", assignee_alias="Worker")
            db.execute("UPDATE tasks SET workflow_id=%s,priority=%s,status=%s,result=%s WHERE id=%s",
                       (wid, i, "completed" if i < 4 else "in_progress",
                        json.dumps({"result": f"{label} deliverable https://example.test/{i}"}) if i < 4 else None, t["id"]))
            tasks.append(t)
        workflows.append((wid, label, tasks))

    for wid, label, tasks in workflows:
        response = await client.get(f"/api/agents/{worker}/protocol", params={"task_id": tasks[3]["id"]})
        assert response.status_code == 200, response.text
        payload = response.json()
        context = payload["workflow"]
        assert context["id"] == wid
        assert context["title"] == label
        assert context["goal"] == label + " goal"
        assert context["step_number"] == 4
        assert [t["id"] for t in context["tasks"]] == [t["id"] for t in tasks]
        assert context["tasks"][2]["assignees"] == ["Worker"]
        assert "https://example.test/3" in context["tasks"][2]["result"]["result"]
        prompt = format_persona({"system_prompt": "You are Worker."}, None, payload)
        assert "## Your workflow" in prompt
        assert "step 4 of 4" in prompt
        assert f"3. {label} step 3" in prompt
        assert "https://example.test/3" in prompt
        assert "Step N" in prompt
        other = next(w for w in workflows if w[0] != wid)
        assert other[1] not in prompt
        assert all(t["id"] not in prompt for t in other[2])

    plain = await make_task("Unrelated task", "Done", assignee_alias="Worker")
    payload = (await client.get(f"/api/agents/{worker}/protocol", params={"task_id": plain["id"]})).json()
    assert payload.get("workflow") is None
    assert "## Your workflow" not in format_persona({"system_prompt": "Worker"}, None, payload)
