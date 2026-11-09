"""A task's Quality report: export as Markdown and as a bundle, import it back as reported, add the
scenarios a project lacks as drafts. No secret leaves the project."""
import io
import json
import zipfile

from test_qa_portal import _session, attachments, jpeg, people  # noqa: F401


async def _run(client, cid, bot, task_id):
    sid = (await _session(client, cid, bot, kind="check", task_id=task_id))["id"]
    frame = (await client.post(f"/api/qa/sessions/{sid}/frames", params={"actor_agent_id": bot}, content=jpeg(),
                               headers={"content-type": "image/jpeg"})).json()["frame_id"]
    sc = (await client.post(f"/api/containers/{cid}/qa/scenarios", json={
        "actor_agent_id": bot, "platform": "ios", "name": "Guest checkout", "session_id": sid, "persona": "A guest",
        "needs": ["a card"], "criteria": ["The cart shows the item", "Paying shows the confirmation"]})).json()["scenario"]
    for i, verdict in ((0, "pass"), (1, "fail")):
        r = await client.post(f"/api/qa/sessions/{sid}/verdicts", json={
            "actor_agent_id": bot, "scenario_id": sc["id"], "criterion_index": i, "verdict": verdict, "note": "no confirmation" if i else None,
            "frame_ids": [frame]})
        assert r.status_code == 201, r.text
    r = await client.post(f"/api/qa/sessions/{sid}/findings", json={
        "actor_agent_id": bot, "severity": "major", "title": "No confirmation after paying", "expected": "A confirmation", "frame_ids": [frame]})
    assert r.status_code == 201, r.text
    return sid, sc, frame


async def test_a_task_report_exports_and_imports_back_as_reported(client, container, people, attachments, make_task):  # noqa: F811
    cid, bot, human = container["id"], people["bot"], people["human"]
    task = await make_task("Fix checkout", "- Paying shows the confirmation")
    r = await client.get(f"/api/tasks/{task['id']}/qa/report.md")
    assert r.status_code == 404 and "no Quality runs" in r.json()["detail"]
    sid, sc, frame = await _run(client, cid, bot, task["id"])

    r = await client.get(f"/api/tasks/{task['id']}/qa/report.md")
    assert r.status_code == 200, r.text
    assert r.headers["content-disposition"].startswith('attachment; filename="quality-report-fix-checkout.md"')
    md = r.text
    assert "# Quality report: Fix checkout" in md and "| Result | **Failed** |" in md
    assert "| Guest checkout | iOS | Failed | 1 of 2 |" in md and "**Major**: No confirmation after paying" in md
    assert "A guest: a card" in md and "```orcha-quality-report" in md

    r = await client.get(f"/api/tasks/{task['id']}/qa/report.zip")
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert {"report.md", "report.json", f"frames/{frame}.jpg"} <= set(z.namelist())
    assert json.loads(z.read("report.json"))["frames"] == [frame]

    r = await client.post(f"/api/containers/{cid}/qa/reports", params={"actor_agent_id": human, "file_name": "report.zip"}, content=r.content)
    assert r.status_code == 201, r.text
    report = r.json()
    assert report["title"] == "Fix checkout" and report["imported_by"] == "Hussein"
    assert report["matched"] == {sc["id"]: sc["id"]}  # the same project: the scenario is here
    assert report["data"]["tally"] == {"scenarios": 1, "passed": 0, "failed": 1, "blocked": 0, "findings": 1}
    r = await client.get(f"/api/qa/reports/{report['id']}/frames/{frame}")
    assert r.status_code == 200 and r.content == jpeg()
    listed = (await client.get(f"/api/containers/{cid}/qa/reports")).json()["reports"]
    assert [x["id"] for x in listed] == [report["id"]] and listed[0]["result"] == "fail"

    # From the Markdown alone (what is attached to a ticket): the same data, no screenshots.
    r = await client.post(f"/api/containers/{cid}/qa/reports", params={"actor_agent_id": human}, content=md.encode())
    assert r.status_code == 201 and r.json()["data"]["frames"] == []


async def test_an_import_from_elsewhere_offers_its_scenarios_as_drafts(client, container, people, attachments, make_task):  # noqa: F811
    cid, bot, human = container["id"], people["bot"], people["human"]
    task = await make_task("Fix checkout", "- Paying shows the confirmation")
    await _run(client, cid, bot, task["id"])
    md = (await client.get(f"/api/tasks/{task['id']}/qa/report.md")).text
    data = json.loads(md.split("```orcha-quality-report\n", 1)[1].split("\n```", 1)[0])
    data["scenarios"][0].update(id="00000000-0000-4000-8000-000000000001", name="Pay with a saved card")
    foreign = md.split("```orcha-quality-report", 1)[0] + "```orcha-quality-report\n" + json.dumps(data) + "\n```\n"
    report = (await client.post(f"/api/containers/{cid}/qa/reports", params={"actor_agent_id": human}, content=foreign.encode())).json()
    assert report["matched"] == {"00000000-0000-4000-8000-000000000001": None}
    r = await client.post(f"/api/qa/reports/{report['id']}/drafts", json={"actor_agent_id": human})
    assert r.status_code == 201 and len(r.json()["created"]) == 1
    made = (await client.get(f"/api/qa/scenarios/{r.json()['created'][0]}")).json()
    made = made.get("scenario", made)
    assert made["status"] == "draft" and made["name"] == "Pay with a saved card"
    again = (await client.get(f"/api/qa/reports/{report['id']}")).json()
    assert again["matched"]["00000000-0000-4000-8000-000000000001"] == made["id"]


async def test_what_is_not_a_report_is_refused(client, container, people):  # noqa: F811
    cid, human = container["id"], people["human"]
    r = await client.post(f"/api/containers/{cid}/qa/reports", params={"actor_agent_id": human}, content=b"# just notes")
    assert r.status_code == 400 and "no Embodent report data" in r.json()["detail"]
    r = await client.post(f"/api/containers/{cid}/qa/reports", params={"actor_agent_id": human}, content=b"PK\x03\x04broken")
    assert r.status_code == 400
    bad = "```orcha-quality-report\n{\"schema\": \"orcha-quality-report\", \"version\": 99, \"task\": {}, \"scenarios\": [], \"setup\": {}}\n```"
    r = await client.post(f"/api/containers/{cid}/qa/reports", params={"actor_agent_id": human}, content=bad.encode())
    assert r.status_code == 400 and "newer Embodent" in r.json()["detail"]


def test_examples_values_and_secrets_never_leave():
    from portal_backend import qa_report

    assert qa_report._secret_free(["secret:abc", {"pw": "secret:x"}, "plain"]) == ["<secret>", {"pw": "<secret>"}, "plain"]
