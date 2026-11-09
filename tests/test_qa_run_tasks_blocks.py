"""Quality blocks: one catalogue, spliced into a draft through the workflow's own preview."""

import pytest
from fastapi.routing import APIRoute

from portal_backend import qa_blocks


@pytest.fixture
async def p(client, container, make_agent):
    human = (await make_agent("Hussein", kind="human"))["agent_id"]
    qa = (await make_agent("QAEngineer", "QA engineer"))["agent_id"]
    dev = (await make_agent("Dev"))["agent_id"]

    class Project:
        pass
    x = Project()
    x.client, x.cid, x.human, x.qa, x.dev = client, container["id"], human, qa, dev
    return x


def draft(p, *steps):
    tasks = [{"client_key": k, "title": k.title(), "definition_of_done": "Done.", "assignee_id": p.dev, "depends_on": deps} for k, deps in steps]
    return {"title": "Ship it", "goal": "A shipped change.", "tasks": tasks}


async def splice(p, block, base, **body):
    return await p.client.post(f"/api/containers/{p.cid}/qa/workflow-blocks/splice", json={"block": block, "draft": base, **body})


def task(d, key):
    return next(t for t in d["tasks"] if t["client_key"] == key)


async def test_the_catalogue_is_four_blocks_each_with_steps_routes_and_a_loop(p):
    await p.client.put(f"/api/containers/{p.cid}/qa/targets/web", json={"actor_agent_id": p.human, "app_id": "https://a.test"})
    blocks = (await p.client.get(f"/api/containers/{p.cid}/qa/workflow-blocks")).json()["blocks"]
    assert [b["key"] for b in blocks] == ["check_and_fix", "explore_and_draft", "map_the_app", "release_check"]
    for b in blocks:
        assert b["draft"]["tasks"] and len(b["draft"]["repeat_groups"]) == 1 and b["placeholders"]["next"]
        assert all(t.get("routes") for t in b["draft"]["tasks"])
    check = blocks[0]["draft"]
    assert [t["title"] for t in check["tasks"]] == ["Check", "Triage"]
    assert check["repeat_groups"][0]["member_tasks"] == ["build", "qa", "triage"]
    assert {r["destination_task"] for t in check["tasks"] for r in t["routes"] if r.get("destination_task")} == {"next", "triage", "build"}


async def test_check_and_fix_goes_between_the_step_before_and_what_follows(p):
    r = await splice(p, "check_and_fix", draft(p, ("build", []), ("ship", ["build"])), after=["build"])
    assert r.status_code == 200, r.text
    out = r.json()
    d = out["draft"]
    check, triage = out["added"]
    assert task(d, check)["depends_on"] == ["build"] and task(d, triage)["depends_on"] == [check]
    assert set(task(d, "ship")["depends_on"]) == {check, triage}
    routes = {r["outcome"]: r for r in task(d, check)["routes"]}
    assert routes["pass"]["destination_task"] == "ship" and routes["fail"]["destination_task"] == triage
    assert {r["outcome"]: r for r in task(d, triage)["routes"]}["fix"]["destination_task"] == "build"
    assert d["repeat_groups"][0]["member_tasks"] == ["build", check, triage]
    assert task(d, check)["block"] == {"key": "check_and_fix", "name": "Check and fix"}
    assert out["preview"]["preview_digest"]


async def test_with_nothing_after_it_the_block_brings_a_closing_step(p):
    out = (await splice(p, "check_and_fix", draft(p, ("build", [])), after=["build"])).json()
    assert len(out["added"]) == 3
    closing = task(out["draft"], out["added"][-1])
    assert closing["title"] == "Sum up" and closing["assignee_id"] == p.dev


async def test_work_goes_back_to_the_chosen_step_through_the_steps_between(p):
    base = draft(p, ("build", []), ("review", ["build"]))
    out = (await splice(p, "check_and_fix", base, after=["review"], build_step="build")).json()
    assert out["draft"]["repeat_groups"][0]["member_tasks"][:2] == ["build", "review"]


@pytest.mark.parametrize("block", ["explore_and_draft", "map_the_app"])
async def test_a_block_that_needs_no_build_step_splices_at_the_start(p, block):
    r = await splice(p, block, draft(p, ("ship", [])), after=[])
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["draft"]["tasks"][-1]["depends_on"] == [out["added"][-1]]


async def test_release_check_has_a_step_per_platform_and_asks_the_owner(p):
    for platform, app in (("web", "https://a.test"), ("ios", "com.a.b")):
        await p.client.put(f"/api/containers/{p.cid}/qa/targets/{platform}", json={"actor_agent_id": p.human, "app_id": app})
    r = await splice(p, "release_check", draft(p, ("build", [])), after=["build"])
    assert r.status_code == 200, r.text
    d = r.json()["draft"]
    checks = [t for t in d["tasks"] if (t.get("qa") or {}).get("kind") == "check"]
    assert sorted(t["qa"]["platform"] for t in checks) == ["ios", "web"]
    triage = next(t for t in d["tasks"] if (t.get("qa") or {}).get("kind") == "triage")
    routes = {r["outcome"]: r["destination"] for r in triage["routes"]}
    assert routes["fix"] == routes["clear"] == routes["needs_person"] == "ask_owner"


async def test_two_blocks_fit_one_draft(p):
    one = (await splice(p, "explore_and_draft", draft(p, ("build", [])), after=["build"])).json()
    r = await splice(p, "map_the_app", one["draft"], after=[one["added"][-1]])
    assert r.status_code == 200, r.text
    assert len(r.json()["draft"]["repeat_groups"]) == 2


async def test_a_step_already_in_a_loop_refuses_with_a_sentence(p):
    one = (await splice(p, "check_and_fix", draft(p, ("build", [])), after=["build"])).json()
    r = await splice(p, "check_and_fix", one["draft"], after=[one["added"][-1]], build_step="build")
    assert r.status_code == 409 or r.status_code == 422
    assert r.json()["detail"]["message"] == "A step can belong to only one repeat group."


async def test_no_step_to_send_work_back_to_refuses_with_a_sentence(p):
    r = await splice(p, "check_and_fix", draft(p, ("ship", [])), after=[])
    assert r.status_code == 422 and "add that step first" in r.json()["detail"]["message"]


async def test_too_many_prerequisites_refuse_with_a_sentence(p):
    base = draft(p, ("a", []), ("b", []), ("c", []), ("d", ["a", "b", "c"]))
    r = await splice(p, "check_and_fix", base, after=["a"])
    assert r.status_code == 422 and r.json()["detail"]["message"].startswith("A step can wait for at most three")


async def test_an_unknown_step_or_block_refuses_with_a_sentence(p):
    assert (await splice(p, "check_and_fix", draft(p, ("a", [])), after=["nope"])).json()["detail"]["message"] == "“nope” is not a step of this draft."
    assert (await splice(p, "nope", draft(p, ("a", [])), after=["a"])).status_code == 404


async def test_a_preset_is_a_build_step_and_a_block(p):
    presets = (await p.client.get(f"/api/containers/{p.cid}/qa/workflow-presets")).json()["presets"]
    assert [x["key"] for x in presets] == ["build_qa_fix", "build_qa_triage_fix"]
    triage = presets[1]["draft"]
    assert [t["client_key"] for t in triage["tasks"]] == ["build", "qa", "triage", "next"]
    assert [t["title"] for t in triage["tasks"]] == ["Build", "QA", "Triage", "Sum up"]
    assert task(triage, "qa")["block"]["key"] == "check_and_fix" and "block" not in task(triage, "build")
    assert set(task(triage, "next")["depends_on"]) == {"qa", "triage"}


async def test_a_spliced_draft_keeps_its_block_label_through_create(p):
    out = (await splice(p, "explore_and_draft", draft(p, ("build", [])), after=["build"])).json()
    r = await p.client.post(f"/api/containers/{p.cid}/workflows", json={**out["draft"], "idempotency_key": "one"},
                            headers={"X-Orcha-Local-Actor": p.human})
    assert r.status_code == 201, r.text
    steps = {t["title"]: t for t in r.json()["tasks"]}
    assert steps["Explore"]["block"]["key"] == "explore_and_draft" and steps["Build"]["block"] is None


def test_no_pydantic_class_name_collides_and_openapi_builds():
    import main

    assert main.app.openapi()["paths"]["/api/containers/{cid}/qa/workflow-blocks/splice"]
    names = [r.path for r in main.app.routes if isinstance(r, APIRoute)]
    assert "/api/agents/{aid}/qa-runs" in names and "/api/containers/{cid}/qa/run-task" in names


def test_splice_leaves_the_catalogue_alone():
    conf = {"agent_id": "qa", "max_rounds": 3}
    block = qa_blocks.map_the_app(conf, "web")
    before = repr(block)
    qa_blocks.splice({"title": "t", "goal": "g", "tasks": []}, block, [])
    assert repr(block) == before


def test_a_release_check_names_each_platform_as_people_do():
    block = qa_blocks.release_check({"agent_id": "a", "max_rounds": 3}, ["ios", "android", "web"])
    assert [t["title"] for t in block["draft"]["tasks"]][:3] == ["Check iOS", "Check Android", "Check Web"]
