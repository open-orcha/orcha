"""What a real run on a real project taught onboarding: a person's Run click is the plan's approval,
detection reads only the project's own folders, and a stuck pass says why."""

import json
import subprocess

from orcha_cli.qa.onboarding import ignored, test_import, tests_scan
from orcha_cli.qa.onboarding.found import read_folder
from portal_backend import qa_atlas, qa_onboarding as qo, sql
from portal_backend.database import db_cursor
from test_qa_onboarding_portal import flow, people, repo  # noqa: F401 (fixtures)

PLAYWRIGHT = """import { test, expect } from '@playwright/test';
test('signs in', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByText('Welcome back')).toBeVisible();
});
"""


def write(root, files):
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text if isinstance(text, str) else json.dumps(text))


def test_detection_skips_worktrees_orcha_folders_and_what_git_ignores(tmp_path):
    app = {"package.json": {"name": "shop", "dependencies": {"next": "14"}}, "e2e/login.spec.ts": PLAYWRIGHT}
    write(tmp_path, app)
    write(tmp_path / ".orcha-worktrees/task-QA-1", {**app, "apps/api/composer.json": {"require": {"laravel/framework": "11"}}})
    write(tmp_path / ".claude/worktree", app)
    write(tmp_path / "generated-copy", app)
    (tmp_path / ".gitignore").write_text("generated-copy/\n")
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    sheet = json.dumps(read_folder(tmp_path))
    assert ".orcha-worktrees" not in sheet and ".claude/" not in sheet and "generated-copy" not in sheet
    inv = tests_scan.scan(tmp_path)
    assert [t.path for t in inv.tests] == ["e2e/login.spec.ts"]  # the count is not inflated by the copies
    skip = ignored.matcher(tmp_path)
    assert skip(tmp_path / ".orcha") and skip(tmp_path / "generated-copy") and not skip(tmp_path / "e2e")


def test_a_test_becomes_a_draft_with_no_model_and_a_pointer_to_its_file():
    t = tests_scan.SourceTest("e2e/login.spec.ts", "signs in", 2, "playwright", "await expect(page.getByText('Welcome back')).toBeVisible();\n")
    row = test_import.convert_sources([t], ["web"])[0]
    assert row["platform"] == "web" and row["fields"]["criteria"][0] == '"Welcome back" is shown'
    assert "test:e2e/login.spec.ts" in row["fields"]["tags"] and len(row["fields"]["criteria"]) >= 2
    assert row["evidence"][0]["code_ref"] == "e2e/login.spec.ts:2"
    same = tests_scan.SourceTest("e2e/other.spec.ts", "signs in", 9, "playwright", "")
    names = [r["fields"]["name"] for r in test_import.convert_sources([t, same], ["web"])]
    assert len(set(names)) == 2  # one test never overwrites another


async def test_run_click_approves_the_plan_through_the_record_and_the_task_says_so(flow, people, repo, db):  # noqa: F811
    await flow.mapped()
    tid = (await flow.act("run_live", agent_id=people["bot"]))["phases"]["live"]["task_id"]
    row = db.execute("SELECT description, autonomy FROM tasks WHERE id=%s", (tid,))[0]
    assert "That is the approval of your plan" in row["description"] and row["autonomy"] == "off"
    approvals = db.execute("SELECT phase, actor_kind FROM task_approval_records WHERE task_id=%s", (tid,))
    assert [(a["phase"], a["actor_kind"]) for a in approvals] == [("plan", "human")]
    assert db.execute("SELECT decision FROM decisions WHERE subject_type='plan_approval' AND subject_id=%s", (tid,))[0]["decision"] == "approve"


async def test_an_open_request_from_the_agent_is_why_the_pass_waits(flow, people, repo, db):  # noqa: F811
    await flow.mapped()
    tid = (await flow.act("run_live", agent_id=people["bot"]))["phases"]["live"]["task_id"]
    r = db.execute("""INSERT INTO requests (container_id, type, requester_id, target_id, payload, originating_task_id)
                      VALUES (%s,'info',%s,%s,'OK if I go ahead with this plan?',%s) RETURNING id""", (flow.cid, people["bot"], people["human"], tid))
    g = await flow.until(lambda g: g["phases"]["live"].get("request_id"))
    assert g["phases"]["live"]["request_id"] == str(r[0]["id"]) and "OK if I go ahead" in g["phases"]["live"]["blocked_reason"]


async def test_a_worker_that_left_without_a_session_is_said_and_stops_the_wait(flow, people, repo, db, monkeypatch):  # noqa: F811
    monkeypatch.setattr(qo, "WORKER_GONE_SECONDS", 0.0)
    await flow.mapped()
    tid = (await flow.act("run_live", agent_id=people["bot"]))["phases"]["live"]["task_id"]
    db.execute("INSERT INTO worker_runs (run_id, agent_id, task_id, status, ended_at, total_cost_usd) VALUES (%s,%s,%s,'exited',%s,0.86)",
               ("22222222-2222-4333-8444-555555555555", people["bot"], tid, sql.utcnow()))
    g = await flow.until(lambda g: g["phases"]["live"]["state"] == "failed")
    assert g["phases"]["live"]["blocked_reason"] == "The agent's worker exited without starting a QA session."
    assert g["phases"]["live"]["cost_usd"] == 0.86


async def test_a_session_that_never_got_a_device_does_not_count_and_is_not_listed(flow, people, repo, db):  # noqa: F811
    await flow.mapped()
    tid = (await flow.act("run_live", agent_id=people["bot"]))["phases"]["live"]["task_id"]
    s = (await flow.client.post(f"/api/containers/{flow.cid}/qa/sessions", json={
        "actor_agent_id": people["bot"], "kind": "map", "platform": "web", "task_id": tid})).json()
    await flow.client.patch(f"/api/qa/sessions/{s['id']}", json={"actor_agent_id": people["bot"], "status": "failed"})
    listed = (await flow.client.get(f"/api/containers/{flow.cid}/qa/sessions")).json()["sessions"]
    assert s["id"] not in [x["id"] for x in listed]
    g = await flow.until(lambda g: (g["phases"]["live"].get("counts") or {}).get("sessions") == 0)
    assert g["phases"]["live"]["counts"]["sessions"] == 0


async def test_the_atlas_uses_the_project_name_over_a_name_from_the_code(flow, people, repo):  # noqa: F811
    with db_cursor() as (_, cur):
        cur.execute("INSERT INTO qa_targets (container_id, platform, app_name, updated_at) VALUES (%s,'web','ebroker',%s)", (flow.cid, sql.utcnow()))
        cur.execute("INSERT INTO qa_onboarding (container_id, phase, state, found, phases, updated_at) VALUES (%s,'found','idle',%s,'{}',%s)",
                    (flow.cid, json.dumps({"platforms": [{"kind": "web", "name": "ebroker"}]}), sql.utcnow()))
    with db_cursor(readonly=True) as (_, cur):
        cur.execute("SELECT name FROM containers WHERE id=%s", (flow.cid,))
        project = cur.fetchone()["name"]
        assert qa_atlas.read_atlas(cur, flow.cid)["name"] == project
