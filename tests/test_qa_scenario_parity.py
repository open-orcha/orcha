"""Scenarios beyond the record: versions, the wider status, quarantine, delete, check corrections,
the recorded path, the audit, coverage growth and links, sealed examples."""
import pytest

from portal_backend.database import db_cursor
from conftest import run_task_id

JPEG = b"\xff\xd8\xff\xe0" + b"0" * 32


@pytest.fixture
async def people(make_agent):
    human = await make_agent("Hussein", "owner", kind="human")
    bot = await make_agent("qa-bot")
    return {"human": human["agent_id"], "bot": bot["agent_id"]}


async def _propose(client, cid, actor, name="Create a routine", **extra):
    r = await client.post(f"/api/containers/{cid}/qa/scenarios", json={
        "actor_agent_id": actor, "platform": "ios", "name": name, "criteria": ["The list shows it", "It is saved"], **extra})
    assert r.status_code in (200, 201), r.text
    return r.json()["scenario"]


async def _status(client, cid, human, ids, status, **extra):
    return await client.post(f"/api/containers/{cid}/qa/scenarios/status", json={"actor_agent_id": human, "ids": ids, "status": status, **extra})


async def _session(client, cid, bot, kind="check", platform="ios"):
    r = await client.post(f"/api/containers/{cid}/qa/sessions", json={"actor_agent_id": bot, "kind": kind, "platform": platform, "task_id": await run_task_id(client, cid, bot)})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _verdicts(client, sid, bot, scenario, *words, **extra):
    for i, word in enumerate(words):
        r = await client.post(f"/api/qa/sessions/{sid}/verdicts", json={
            "actor_agent_id": bot, "scenario_id": scenario, "criterion_index": i, "verdict": word,
            "note": None if word == "pass" else "the screen said no", **extra})
        assert r.status_code == 201, r.text


async def test_every_change_is_a_version_and_restore_is_a_save(client, container, people):
    cid, human = container["id"], people["human"]
    s = await _propose(client, cid, human)
    vs = (await client.get(f"/api/qa/scenarios/{s['id']}/versions")).json()["versions"]
    assert [v["version"] for v in vs] == [1]
    r = await client.patch(f"/api/qa/scenarios/{s['id']}", json={"actor_agent_id": human, "name": "Create a daily routine"})
    assert r.status_code == 200, r.text
    await client.patch(f"/api/qa/scenarios/{s['id']}", json={"actor_agent_id": human, "name": "Create a daily routine"})
    assert await _status(client, cid, human, [s["id"]], "paused", reason="Flag off", until="2099-01-02")
    vs = (await client.get(f"/api/qa/scenarios/{s['id']}/versions")).json()["versions"]
    assert [v["version"] for v in vs] == [3, 2, 1]
    assert vs[0]["snapshot"]["status_note"] == "Paused: Flag off until 2099-01-02"
    r = await client.post(f"/api/qa/scenarios/{s['id']}/restore", json={"actor_agent_id": human, "version": 1})
    assert r.status_code == 200, r.text
    assert r.json()["scenario"]["name"] == "Create a routine"
    assert r.json()["scenario"]["status"] == "paused"  # a status set aside changes through the menu
    assert r.json()["version"] == 4


async def test_an_agent_cannot_restore_delete_release_or_dismiss(client, container, people):
    cid, bot = container["id"], people["bot"]
    s = await _propose(client, cid, bot)
    sid = s["id"]
    for r in (
        await client.post(f"/api/qa/scenarios/{sid}/restore", json={"actor_agent_id": bot, "version": 1}),
        await client.delete(f"/api/qa/scenarios/{sid}", params={"actor_agent_id": bot}),
        await client.delete(f"/api/qa/scenarios/{sid}/quarantine", params={"actor_agent_id": bot}),
        await client.post(f"/api/qa/scenarios/{sid}/check-fixes", json={"actor_agent_id": bot, "criterion_index": 0, "expression": "x"}),
        await client.post(f"/api/containers/{cid}/qa/scenario-health/actions", json={"actor_agent_id": bot, "action": "archive", "ids": [sid]}),
        await client.post(f"/api/containers/{cid}/qa/coverage/growth", json={"actor_agent_id": bot, "action": "baseline"}),
    ):
        assert r.status_code == 403, r.text


async def test_status_fields_are_checked_and_stored(client, container, people):
    cid, human = container["id"], people["human"]
    a = await _propose(client, cid, human, "One thing")
    b = await _propose(client, cid, human, "Its successor")
    assert (await _status(client, cid, human, [a["id"]], "paused", reason="x", until="2001-01-01")).status_code == 400
    assert (await _status(client, cid, human, [a["id"]], "paused", reason="x", issue="soon")).status_code == 400
    r = await _status(client, cid, human, [a["id"]], "paused", reason="Bug", issue="owner/repo#42")
    assert r.status_code == 200 and r.json()["scenarios"][0]["status_issue"] == "owner/repo#42"
    r = await _status(client, cid, human, [a["id"]], "retired", reason="Gone", replaced_by=b["id"])
    row = r.json()["scenarios"][0]
    assert row["status"] == "retired" and row["replaced_by"] == b["id"] and row["status_issue"] is None


async def test_quarantine_runs_and_clean_passes_release_it(client, container, people):
    cid, human, bot = container["id"], people["human"], people["bot"]
    s = await _propose(client, cid, human)
    await _status(client, cid, human, [s["id"]], "validated")
    r = await _status(client, cid, human, [s["id"]], "quarantined", reason="Flaky on slow networks")
    row = r.json()["scenarios"][0]
    assert row["status"] == "validated" and row["quarantined_at"] and row["quarantine_reason"] == "Flaky on slow networks"
    for n in range(4):
        await _verdicts(client, await _session(client, cid, bot), bot, s["id"], "pass", "pass")
    assert (await client.get(f"/api/qa/scenarios/{s['id']}")).json()["quarantine_clean_runs"] == 4
    await _verdicts(client, await _session(client, cid, bot), bot, s["id"], "pass", "fail")
    assert (await client.get(f"/api/qa/scenarios/{s['id']}")).json()["quarantine_clean_runs"] == 0
    for n in range(5):
        await _verdicts(client, await _session(client, cid, bot), bot, s["id"], "pass", "pass")
    got = (await client.get(f"/api/qa/scenarios/{s['id']}")).json()
    assert got["quarantined_at"] is None and got["quarantine_released_at"]
    # A person can do it sooner.
    await _status(client, cid, human, [s["id"]], "quarantined", reason="Again")
    r = await client.delete(f"/api/qa/scenarios/{s['id']}/quarantine", params={"actor_agent_id": human})
    assert r.status_code == 200 and r.json()["scenario"]["quarantined_at"] is None


async def test_a_paused_scenario_resumes_when_its_task_is_finished(client, container, people, make_task=None):
    cid, human = container["id"], people["human"]
    s = await _propose(client, cid, human)
    r = await _status(client, cid, human, [s["id"]], "paused", reason="Bug", until="2099-01-02")
    assert r.status_code == 200
    import portal_backend.database as db
    with db.db_cursor() as (conn, cur):
        cur.execute("UPDATE qa_scenarios SET status_until='2001-01-01' WHERE id=%s", (s["id"],))
        conn.commit()
    rows = (await client.get(f"/api/containers/{cid}/qa/scenarios")).json()["scenarios"]
    assert rows[0]["status"] == "validated" and rows[0]["status_until"] is None
    vs = (await client.get(f"/api/qa/scenarios/{s['id']}/versions")).json()["versions"]
    assert vs[0]["snapshot"]["status_note"].startswith("Resumed automatically")


async def test_delete_removes_it_and_what_depended_on_it_lets_go(client, container, people):
    cid, human = container["id"], people["human"]
    a = await _propose(client, cid, human, "First")
    b = await _propose(client, cid, human, "Second", depends_on=[a["id"]])
    r = await client.delete(f"/api/qa/scenarios/{a['id']}", params={"actor_agent_id": human})
    assert r.status_code == 200, r.text
    assert (await client.get(f"/api/qa/scenarios/{a['id']}")).status_code == 404
    assert (await client.get(f"/api/qa/scenarios/{b['id']}")).json()["depends_on"] == []


async def test_fresh_permissions_and_data_are_kept(client, container, people):
    cid, human = container["id"], people["human"]
    s = await _propose(client, cid, human, fresh=False, permissions="ask", session="admin", seed=["POST /api/x {} as x"],
                       cleanup=["DELETE /api/x/{{x.id}}"], events=['network: POST /v1/track "x"'])
    got = (await client.get(f"/api/qa/scenarios/{s['id']}")).json()
    assert got["fresh"] is False and got["permissions"] == "ask" and got["session"] == "admin"
    assert got["seed"] == ["POST /api/x {} as x"] and got["cleanup"] == ["DELETE /api/x/{{x.id}}"]
    r = await client.patch(f"/api/qa/scenarios/{s['id']}", json={"actor_agent_id": human, "fresh": None, "shared": True})
    assert r.status_code == 200, r.text
    got = r.json()["scenario"]
    assert got["fresh"] is None and got["shared"] is True


async def test_a_shared_scenario_lists_on_every_platform_with_each_ones_result(client, container, people):
    cid, human, bot = container["id"], people["human"], people["bot"]
    s = await _propose(client, cid, human, shared=True)
    await _status(client, cid, human, [s["id"]], "validated")
    assert [r["id"] for r in (await client.get(f"/api/containers/{cid}/qa/scenarios", params={"platform": "web"})).json()["scenarios"]] == [s["id"]]
    await _verdicts(client, await _session(client, cid, bot), bot, s["id"], "pass", "pass")
    await _verdicts(client, await _session(client, cid, bot, platform="web"), bot, s["id"], "inconclusive", "inconclusive")
    row = (await client.get(f"/api/containers/{cid}/qa/scenarios")).json()["scenarios"][0]
    assert row["by_platform"]["ios"]["outcome"] == "pass"
    assert row["by_platform"]["web"]["outcome"] == "inconclusive" and row["by_platform"]["web"]["reason"]


async def test_examples_seal_secrets_and_a_cell_is_revealed_only_from_its_own_table(client, container, people, monkeypatch):
    monkeypatch.setenv("ORCHA_SECRET_KEY", "qa-examples-master-key")
    cid, human = container["id"], people["human"]
    s = await _propose(client, cid, human, examples={"columns": ["email", "password"], "rows": [["a@b.co", "hunter2"]], "secret": ["password"]})
    table = (await client.get(f"/api/qa/scenarios/{s['id']}")).json()["examples"]
    ref = table["rows"][0][1]
    assert ref.startswith("secret:sec_") and table["secret"] == ["password"]
    assert "hunter2" not in str((await client.get(f"/api/qa/scenarios/{s['id']}/versions")).json())
    r = await client.post(f"/api/qa/scenarios/{s['id']}/examples/reveal", json={"actor_agent_id": human, "ref": ref[len("secret:"):]})
    assert r.status_code == 200 and r.json()["value"] == "hunter2" and r.headers["cache-control"] == "no-store"
    with db_cursor(readonly=True) as (_, cur):
        cur.execute("SELECT value FROM qa_example_secrets WHERE scenario_id=%s", (s["id"],))
        stored = str(cur.fetchone()["value"])
    assert "hunter2" not in stored
    other = await _propose(client, cid, human, "Other")
    r = await client.post(f"/api/qa/scenarios/{other['id']}/examples/reveal", json={"actor_agent_id": human, "ref": ref[len("secret:"):]})
    assert r.status_code == 404


async def test_a_secret_is_refused_rather_than_kept_in_the_clear_without_a_key(client, container, people, monkeypatch):
    monkeypatch.delenv("ORCHA_SECRET_KEY", raising=False)
    cid, human = container["id"], people["human"]
    r = await client.post(f"/api/containers/{cid}/qa/scenarios", json={
        "actor_agent_id": human, "platform": "ios", "name": "No key", "criteria": ["It opens", "It saves"],
        "examples": {"columns": ["password"], "rows": [["hunter2"]], "secret": ["password"]}})
    assert r.status_code == 503 and "ORCHA_SECRET_KEY" in r.json()["detail"]


async def test_check_fix_is_offered_and_dismissed(client, container, people):
    cid, human, bot = container["id"], people["human"], people["bot"]
    s = await _propose(client, cid, human, checks=[{"criterion_index": 0, "line": 'Button "Pay"'}])
    sid = await _session(client, cid, bot)
    fix = {"expression": 'Button "Pay"', "kind": "role", "reason": "the tree says Link", "proposed": 'Link "Pay"'}
    await _verdicts(client, sid, bot, s["id"], "pass", check_fix=fix)
    got = (await client.get(f"/api/qa/scenarios/{s['id']}/check-fixes")).json()
    assert got["rows"][0]["criteria"][0]["check_fix"]["proposed"] == 'Link "Pay"' and got["dismissed"] == []
    for _ in range(2):
        r = await client.post(f"/api/qa/scenarios/{s['id']}/check-fixes", json={"actor_agent_id": human, "criterion_index": 0, "expression": 'Button "Pay"', "proposed": 'Link "Pay"'})
        assert r.status_code == 200, r.text
    assert len((await client.get(f"/api/qa/scenarios/{s['id']}/check-fixes")).json()["dismissed"]) == 1


async def test_the_recorded_path_comes_from_the_walk(client, container, people):
    cid, human, bot = container["id"], people["human"], people["bot"]
    sid = await _session(client, cid, bot, kind="explore")
    r = await client.post(f"/api/containers/{cid}/qa/flows", json={"actor_agent_id": bot, "platform": "ios", "flows": [
        {"key": "pay", "name": "Pay", "steps": [{"text": "Open it"}]}]})
    assert r.status_code in (200, 201), r.text
    r = await client.post(f"/api/qa/sessions/{sid}/walks/next", json={"actor_agent_id": bot})
    assert r.status_code in (200, 201), r.text
    walk = r.json()["walk"]
    r = await client.post(f"/api/qa/sessions/{sid}/steps", json={"actor_agent_id": bot, "steps": [
        {"seq": 1, "kind": "tap", "args": {"target": {"label": "Pay", "role": "Button"}}},
        {"seq": 2, "kind": "type", "args": {"text": "Maria", "target": {"label": "Name", "role": "TextField"}}}]})
    assert r.status_code == 200, r.text
    s = await _propose(client, cid, bot, walk_id=walk["id"])
    traces = (await client.get(f"/api/qa/scenarios/{s['id']}/trace")).json()["traces"]
    assert len(traces) == 1 and traces[0]["targetKind"] == "ios" and traces[0]["runId"] == sid
    assert [a["label"] for a in traces[0]["actions"]] == ["tap Button 'Pay'", "type Maria into TextField 'Name'"]
    assert [x["text"] for x in traces[0]["segments"]] == ["The list shows it", "It is saved"]
    r = await client.delete(f"/api/qa/scenarios/{s['id']}/trace", params={"actor_agent_id": human, "target_kind": "ios"})
    assert r.status_code == 200, r.text
    assert (await client.get(f"/api/qa/scenarios/{s['id']}/trace")).json()["traces"] == []


async def test_the_audit_flags_dismisses_and_acts(client, container, people):
    cid, human = container["id"], people["human"]
    bad = await _propose(client, cid, human, "Orcha 3c96e42c · Build the Questions board")
    keep = await _propose(client, cid, human, "Sign in with email", criteria=["The form shows", "The home screen opens", "The name is shown"])
    dup = await _propose(client, cid, human, "Sign in by email", criteria=["The form shows", "The home screen opens", "The name is shown"])
    await _status(client, cid, human, [keep["id"], dup["id"]], "validated")
    audit = (await client.get(f"/api/containers/{cid}/qa/scenario-health")).json()
    assert audit["total"] == 3
    kinds = {s["id"]: {f["kind"] for f in s["flags"]} for s in audit["scenarios"]}
    assert "suspicious" in kinds[bad["id"]] and "duplicate" in kinds[dup["id"]] and keep["id"] not in kinds
    flags = (await client.get(f"/api/containers/{cid}/qa/scenario-health/flags", params={"ids": bad["id"]})).json()["flags"]
    assert flags and flags[0]["kind"] == "suspicious"
    r = await client.post(f"/api/containers/{cid}/qa/scenario-health/actions", json={"actor_agent_id": human, "action": "dismiss", "ids": [bad["id"]], "kind": "suspicious"})
    assert r.status_code == 200, r.text
    audit = (await client.get(f"/api/containers/{cid}/qa/scenario-health")).json()
    assert "suspicious" not in audit["counts"]
    r = await client.post(f"/api/containers/{cid}/qa/scenario-health/actions", json={"actor_agent_id": human, "action": "merge", "ids": [dup["id"]], "into": keep["id"]})
    assert r.status_code == 200, r.text
    got = (await client.get(f"/api/qa/scenarios/{dup['id']}")).json()
    assert got["status"] == "retired" and got["replaced_by"] == keep["id"]


async def test_growth_baseline_then_report_and_variations(client, container, people):
    cid, human, bot = container["id"], people["human"], people["bot"]
    r = await client.post(f"/api/containers/{cid}/qa/map/import", json={"actor_agent_id": bot, "platform": "ios", "source": "code", "nodes": [
        {"kind": "screen", "key": "Home", "label": "Home"}], "edges": []})
    assert r.status_code in (200, 201), r.text
    report = (await client.get(f"/api/containers/{cid}/qa/coverage/growth")).json()
    assert report["baseline"]["trigger"] == "first_mapping" and report["now"]["totals"]["screens"] == 1
    r = await client.post(f"/api/containers/{cid}/qa/coverage/growth", json={"actor_agent_id": human, "action": "baseline"})
    assert r.status_code == 200, r.text
    assert (await client.post(f"/api/containers/{cid}/qa/coverage/growth", json={"actor_agent_id": human, "action": "rebaseline", "reason": "x"})).status_code == 400
    r = await client.post(f"/api/containers/{cid}/qa/coverage/growth", json={"actor_agent_id": human, "action": "rebaseline", "reason": "A rewrite"})
    assert r.status_code == 200, r.text
    report = (await client.get(f"/api/containers/{cid}/qa/coverage/growth")).json()
    assert report["baseline"]["trigger"] == "rebaseline" and len(report["history"]) == 3 and report["growth"]
    s = await _propose(client, cid, human, data={"email": "a@b.co", "amount": "12"})
    await _status(client, cid, human, [s["id"]], "validated")
    r = await client.post(f"/api/containers/{cid}/qa/coverage/growth/variations", json={"actor_agent_id": human, "action": "suggest", "scenario": s["id"]})
    assert r.status_code == 200, r.text
    rows = r.json()["suggestions"]
    assert rows
    r = await client.post(f"/api/containers/{cid}/qa/coverage/growth/variations", json={"actor_agent_id": human, "action": "apply", "ids": [rows[0]["id"]]})
    assert r.status_code == 200, r.text
    assert (await client.get(f"/api/qa/scenarios/{s['id']}")).json()["examples"]["rows"]


async def test_coverage_links_survive_and_unlink_forgets(client, container, people):
    cid, human = container["id"], people["human"]
    s = await _propose(client, cid, human)
    r = await client.post(f"/api/containers/{cid}/qa/coverage/links", json={"actor_agent_id": human, "action": "reject", "scenario_id": s["id"], "feature_key": "auth"})
    assert r.status_code == 200, r.text
    await client.post(f"/api/containers/{cid}/qa/coverage/links", json={"actor_agent_id": human, "action": "confirm", "scenario_id": s["id"], "feature_key": "auth"})
    links = (await client.get(f"/api/containers/{cid}/qa/coverage/links")).json()["links"]
    assert [l["state"] for l in links] == ["confirmed"]
    await client.post(f"/api/containers/{cid}/qa/coverage/links", json={"actor_agent_id": human, "action": "unlink", "scenario_id": s["id"], "feature_key": "auth"})
    assert (await client.get(f"/api/containers/{cid}/qa/coverage/links")).json()["links"] == []


async def test_files_attach_list_delete(client, container, people):
    cid, human = container["id"], people["human"]
    s = await _propose(client, cid, human)
    r = await client.post(f"/api/qa/scenarios/{s['id']}/files", params={"name": "../id.png", "actor_agent_id": human}, content=b"abc")
    assert r.status_code == 201, r.text
    f = r.json()["file"]
    assert f["file_name"] == "id.png" and f["size_bytes"] == 3
    assert (await client.get(f"/api/qa/scenarios/{s['id']}/files")).json()["files"][0]["id"] == f["id"]
    assert (await client.delete(f"/api/qa/scenario-files/{f['id']}", params={"actor_agent_id": human})).status_code == 200


async def test_example_rows_report_each_rows_newest_result(client, container, people):
    cid, human, bot = container["id"], people["human"], people["bot"]
    s = await _propose(client, cid, human, examples={"columns": ["city"], "rows": [["Nairobi"], ["Lagos"]]})
    sid = await _session(client, cid, bot)
    await _verdicts(client, sid, bot, s["id"], "pass", "pass", example_row=1)
    rows = (await client.get(f"/api/qa/scenarios/{s['id']}/rows")).json()["rows"]
    assert [(r["index"], r["outcome"]) for r in rows] == [(1, "pass")]


async def test_a_list_marks_what_a_check_run_leaves_out(client, container, people):
    cid, human = container["id"], people["human"]
    s = await _propose(client, cid, human, "Orcha 3c96e42c · Build the board")
    assert (await client.get(f"/api/containers/{cid}/qa/scenarios")).json()["scenarios"][0]["suspicious"] is True
    await client.post(f"/api/containers/{cid}/qa/scenario-health/actions", json={"actor_agent_id": human, "action": "dismiss", "ids": [s["id"]], "kind": "suspicious"})
    assert (await client.get(f"/api/containers/{cid}/qa/scenarios")).json()["scenarios"][0]["suspicious"] is False


def test_the_suspicious_rule_matches_the_shared_cases():
    import json
    import pathlib

    from portal_backend.qa_scenario_health import suspicious_reasons

    root = pathlib.Path(__file__).resolve().parents[1]
    cases = json.loads((root / "orcha-cli/orcha_cli/templates/portal/frontend/src/pages/qa/scenarios/health/cases.json").read_text())
    for c in cases["suspicious"]:
        assert [r["code"] for r in suspicious_reasons(c["name"], c.get("description"), c.get("criteria"))] == c["expect"], c["name"]


async def test_a_first_map_takes_the_baseline_once(client, container, people):
    cid, bot = container["id"], people["bot"]
    body = {"actor_agent_id": bot, "platform": "ios", "source": "code", "nodes": [{"kind": "screen", "key": "Home", "label": "Home"}], "edges": []}
    await client.post(f"/api/containers/{cid}/qa/map/import", json=body)
    await client.post(f"/api/containers/{cid}/qa/map/import", json=body)
    report = (await client.get(f"/api/containers/{cid}/qa/coverage/growth")).json()
    assert report["baseline"]["trigger"] == "first_mapping" and len(report["history"]) == 1
