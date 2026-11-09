"""QA onboarding in the portal (migration 094, portal_backend/qa_onboarding.py): the phases end to end
on a fixture repo, the human gate, the Run/Skip gate on the live pass, task phases following a
normal Orcha task, and a row a dead thread left running being picked up on the next read."""
import asyncio
import json

import pytest

from conftest import BACKEND
from portal_backend import qa_onboarding as qo


APP = {
    "apps/web/package.json": {"name": "web", "private": True, "dependencies": {"next": "14", "react-dom": "18"},
                              "scripts": {"dev": "next dev -p 4100"}},
    "apps/web/app/page.tsx": 'export default function Home() { return <a href="/checkout">Pay</a>; }\n',
    "apps/web/app/checkout/page.tsx": 'export default function Checkout() { return <button>Pay now</button>; }\n',
    "apps/web/app/about/page.tsx": "export default function About() { return <p>About us</p>; }\n",
    "apps/web/e2e/checkout.spec.ts": """import { test, expect } from '@playwright/test';
test('checkout pays', async ({ page }) => {
  await page.goto('/checkout');
  await expect(page.getByText('Pay now')).toBeVisible();
});
""",
}


@pytest.fixture
def repo(tmp_path, monkeypatch):
    for rel, text in APP.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text if isinstance(text, str) else json.dumps(text))
    monkeypatch.setenv("ORCHA_LOCAL_REPO_DIR", str(tmp_path))
    monkeypatch.setattr(qo, "POLL_S", 0.01)
    return tmp_path


@pytest.fixture
async def people(make_agent):
    return {"human": (await make_agent("Hussein", "owner", kind="human"))["agent_id"],
            "bot": (await make_agent("qa-bot"))["agent_id"]}


class Flow:
    def __init__(self, client, cid, human):
        self.client, self.cid, self.human = client, cid, human
        self.url = f"/api/containers/{cid}/qa/onboarding"

    async def get(self):
        r = await self.client.get(self.url)
        assert r.status_code == 200, r.text
        return r.json()

    async def act(self, action, status=202, actor=None, **options):
        r = await self.client.post(self.url, json={"actor_agent_id": actor or self.human, "action": action,
                                                   "options": options or None})
        assert r.status_code == status, r.text
        return r.json()

    async def until(self, check, seconds=15):
        for _ in range(int(seconds / 0.02)):
            got = await self.get()
            if check(got):
                return got
            await asyncio.sleep(0.02)
        raise AssertionError(f"never reached: {json.dumps({k: got[k] for k in ('phase', 'state', 'phases')})}")

    async def found(self):
        await self.act("start")
        return await self.until(lambda g: g["phases"]["found"]["state"] in ("done", "failed"))

    async def mapped(self, **options):
        await self.found()
        await self.act("confirm", **options)
        return await self.until(lambda g: g["phases"]["tests"]["state"] in ("done", "failed"))


@pytest.fixture
def flow(client, container, people):
    return Flow(client, container["id"], people["human"])


def test_migration_094_is_stamped(db):
    stamped = {r["version"] for r in db.execute("SELECT version FROM schema_migrations")}
    assert "094_qa_onboarding.sql" in stamped
    if BACKEND == "sqlite":
        assert "024_qa_onboarding.sql" in stamped


async def test_an_untouched_project_reads_idle(flow, repo):
    g = await flow.get()
    assert (g["phase"], g["state"], g["project_id"]) == ("found", "idle", flow.cid)
    assert g["phases"]["live"] == {"state": "pending"} and g["found"] == {}
    assert g["screens"] == [] and g["unavailable"] is None and g["first_test"] is None
    assert g["summary"] == {"screens": 0, "covered_by_tests": 0, "covered_by_qa": 0, "uncovered": 0,
                            "untested_critical": []}


async def test_the_live_platform_a_person_picks_is_what_the_map_step_runs(flow, repo):
    await flow.found()
    await flow.act("confirm", status=202, platforms=[{"kind": "web"}], platform="web")
    got = await flow.until(lambda g: g["phases"]["tests"]["state"] in ("done", "failed"))
    assert got["found"]["live_platform"]["kind"] == "web" and got["options"]["platform"] == "web"


async def test_only_a_person_runs_onboarding(flow, people, repo):
    await flow.act("start", status=403, actor=people["bot"])


async def test_start_says_why_it_cannot(flow, repo, monkeypatch):
    monkeypatch.delenv("ORCHA_LOCAL_REPO_DIR")
    r = await flow.act("start", status=409)
    assert r["detail"] == qo.NO_FOLDER and (await flow.get())["unavailable"] == qo.NO_FOLDER
    monkeypatch.setenv("ORCHA_LOCAL_REPO_DIR", "/no/such/folder")
    assert (await flow.act("start", status=409))["detail"] == qo.NO_FOLDER
    monkeypatch.setenv("ORCHA_LOCAL_REPO_DIR", str(repo))
    monkeypatch.setattr(qo, "detector", lambda: None)
    assert (await flow.act("start", status=409))["detail"] == qo.NOT_AVAILABLE


async def test_found_then_confirm_saves_targets_and_maps(flow, client, repo):
    cid = flow.cid
    await client.put(f"/api/containers/{cid}/qa/targets/web",
                     json={"actor_agent_id": flow.human, "notes": "Sign in as qa@example.com", "build_path": "/tmp/x"})
    answer = await flow.act("start")
    assert answer["project_id"] == cid and set(answer) >= {"phase", "state", "phases"}
    g = await flow.until(lambda g: g["phases"]["found"]["state"] == "done")
    assert (g["state"], g["phase"]) == ("waiting", "code_map")  # nothing maps before the person confirms
    web = next(p for p in g["found"]["platforms"] if p["kind"] == "web")
    assert web["app_id"] == "http://localhost:4100" and web["path"] == "apps/web"
    assert g["found"]["tests"] == [{"framework": "playwright", "count": 1, "path": "apps/web/e2e"}]
    assert g["phases"]["found"]["counts"]["tests"] == 1

    await flow.act("confirm", status=202, platforms=[{"kind": "web", "device_name": "mobile"}])
    g = await flow.until(lambda g: g["phases"]["tests"]["state"] in ("done", "failed"))
    assert g["phases"]["code_map"]["state"] == "done" and g["phases"]["code_map"]["counts"]["screens"] >= 3
    assert g["phases"]["tests"]["state"] == "done", g["phases"]["tests"]
    # stops at the live gate with the cost on screen
    assert (g["phase"], g["state"]) == ("live", "waiting")
    assert g["phases"]["live"]["state"] == "pending" and g["phases"]["live"]["estimate_usd"] == 3.95
    target = next(t for t in (await client.get(f"/api/containers/{cid}/qa/targets")).json()["targets"] if t["platform"] == "web")
    assert (target["app_id"], target["device_name"]) == ("http://localhost:4100", "mobile")
    assert target["notes"] == "Sign in as qa@example.com" and target["build_path"] == "/tmp/x"  # what was typed stays
    screen = next(s for s in g["screens"] if s["route"] == "/checkout")
    assert screen["id"] == "screen:web:/checkout" and screen["source"] == "code" and screen["platform"] == "web"
    assert screen["coverage"] == "your_tests" and screen["tests"][0]["path"] == "apps/web/e2e/checkout.spec.ts"
    assert screen["risk"]["score"] >= 40 and "Handles money" in screen["risk"]["reasons"][0]
    about = next(s for s in g["screens"] if s["route"] == "/about")
    assert about["coverage"] == "none"
    assert g["gaps"][0]["risk"] >= g["gaps"][-1]["risk"] and g["summary"]["covered_by_tests"] == 1
    assert g["bring_in"]["migrate"] == [{"framework": "playwright", "count": 1}]
    assert about["id"] in g["bring_in"]["draft"]["gap_screen_ids"] and g["bring_in"]["draft"]["estimate_usd"] == round(0.6 * len(g["bring_in"]["draft"]["gap_screen_ids"]), 2)
    assert g["smoke"]["projected"] is True and g["live_run"] is None and g["billing"] == {"run": None, "draft": None}


async def test_confirm_refuses_a_bad_web_pick_and_out_of_order_steps(flow, repo):
    r = await flow.act("confirm", status=409)
    assert "found" in r["detail"]
    await flow.found()
    await flow.act("confirm", status=400, platforms=[{"kind": "web", "app_id": "com.acme.app"}])
    await flow.act("confirm", status=400, platforms=[{"kind": "web", "device_name": "iPhone"}])
    await flow.act("confirm", status=400, platforms=[{"kind": "tvos"}])
    assert "first" in (await flow.act("run_live", status=409))["detail"]
    assert "first" in (await flow.act("bring_in", status=409))["detail"]
    assert "first" in (await flow.act("first_run", status=409))["detail"]


async def test_skip_live_goes_on_to_coverage(flow, repo):
    await flow.mapped()
    await flow.act("skip_live")
    g = await flow.until(lambda g: g["phases"]["coverage"]["state"] == "done")
    assert g["phases"]["live"]["state"] == "skipped" and g["phases"]["live"]["note"] == qo.SKIP_LIVE_NOTE
    assert (g["phase"], g["state"]) == ("bring_in", "waiting")
    assert g["phases"]["coverage"]["counts"]["screens"] == g["summary"]["screens"]


async def test_live_false_on_confirm_never_waits(flow, repo):
    await flow.found()
    await flow.act("confirm", live=False)
    g = await flow.until(lambda g: g["phases"]["coverage"]["state"] == "done")
    assert g["phases"]["live"]["state"] == "skipped"


async def test_live_follows_a_normal_task_to_needs_verification(flow, people, repo, db):
    await flow.mapped()
    r = await flow.act("run_live", agent_id=people["bot"], depth="overview")
    assert r["phases"]["live"]["state"] == "running"
    tid = r["phases"]["live"]["task_id"]
    task = db.execute("SELECT title, description, status, created_by_agent_id FROM tasks WHERE id=%s", (tid,))[0]
    assert "/orcha-qa-map" in task["description"] and task["status"] == "in_progress"
    assert str(task["created_by_agent_id"]) == flow.human
    assignees = db.execute("SELECT agent_id FROM agent_tasks WHERE task_id=%s", (tid,))
    assert [str(a["agent_id"]) for a in assignees] == [people["bot"]]
    # a second click follows the same task
    again = await flow.act("run_live")
    assert again["phases"]["live"]["task_id"] == tid
    assert len(db.execute("SELECT id FROM tasks WHERE description LIKE %s", ("%/orcha-qa-map%",))) == 1

    g = await flow.get()
    assert g["live_run"]["request_id"] == tid and g["live_run"]["status"] == "running" and g["state"] == "running"
    s = await flow.client.post(f"/api/containers/{flow.cid}/qa/sessions",
                               json={"actor_agent_id": people["bot"], "kind": "map", "platform": "web", "task_id": tid})
    g = await flow.until(lambda g: "session running" in (g["phases"]["live"].get("note") or ""))
    assert g["phases"]["live"]["counts"]["sessions"] == 1 and g["live_run"]["run_id"] == s.json()["id"]

    db.execute("UPDATE tasks SET status='needs_verification' WHERE id=%s", (tid,))
    g = await flow.until(lambda g: g["phases"]["coverage"]["state"] == "done")
    assert g["phases"]["live"]["state"] == "done" and g["live_run"]["status"] == "completed"
    assert db.execute("SELECT status FROM tasks WHERE id=%s", (tid,))[0]["status"] == "needs_verification"  # never verified here


async def test_a_cancelled_task_stops_the_phase(flow, repo, db):
    await flow.mapped()
    tid = (await flow.act("run_live"))["phases"]["live"]["task_id"]  # no agent: the task waits in the queue
    g = await flow.until(lambda g: g["phases"]["live"].get("blocked_reason"))
    assert g["phases"]["live"]["blocked_reason"] == "The task has not been picked up: no worker has started it yet."
    db.execute("UPDATE tasks SET status='cancelled' WHERE id=%s", (tid,))
    g = await flow.until(lambda g: g["phases"]["live"]["state"] == "skipped")
    assert g["phases"]["live"]["note"] == "Stopped: its task was cancelled."


async def test_a_refused_task_puts_the_phase_back(flow, repo):
    await flow.mapped()
    r = await flow.act("run_live", status=404, agent_id="3f2b8c1e-5a4d-4e0b-9c7a-1d2e3f4a5b6c")
    assert "not a member" in r["detail"]
    g = await flow.get()
    assert g["phases"]["live"]["state"] == "pending" and g["state"] == "waiting" and "task_id" not in g["phases"]["live"]


async def test_bring_in_and_first_run_to_done(flow, people, repo, db):
    await flow.mapped(live=False)
    g = await flow.until(lambda g: g["phases"]["coverage"]["state"] == "done")
    gap = g["bring_in"]["draft"]["gap_screen_ids"][0]
    r = await flow.act("bring_in", agent_id=people["bot"], migrate=False, gap_screen_ids=[gap, "screen:web:/nope"])
    tid = r["phases"]["bring_in"]["task_id"]
    body = db.execute("SELECT description FROM tasks WHERE id=%s", (tid,))[0]["description"]
    key = gap.split(":", 2)[2]
    assert "/orcha-qa-draft" in body and key in body and "screen:web:" not in body and "/nope" not in body
    assert "started this run" in body  # the click is the plan's approval, and the task says so
    assert "playwright" not in body  # the tests came in with the click, not through the agent
    made = await flow.client.post(f"/api/containers/{flow.cid}/qa/scenarios", json={
        "actor_agent_id": people["bot"], "platform": "web", "name": "Read about us", "tags": [f"screen:{key}"],
        "criteria": ["The page says who we are", "It has a contact link"]})
    sid = made.json()["scenario"]["id"]
    db.execute("UPDATE tasks SET status='needs_verification' WHERE id=%s", (tid,))
    g = await flow.until(lambda g: g["phases"]["bring_in"]["state"] == "done")
    assert (g["phase"], g["state"]) == ("first_run", "waiting")
    assert g["first_test"]["scenario_id"] == sid and g["first_test"]["screen_id"] == gap
    assert g["smoke"]["projected"] is False and g["smoke"]["count"] == 1
    assert next(s for s in g["screens"] if s["id"] == gap)["coverage"] == "qa"

    r = await flow.act("first_run", agent_id=people["bot"], scenario_id=sid)
    first = r["phases"]["first_run"]["task_id"]
    assert "/orcha-qa-check" in db.execute("SELECT description FROM tasks WHERE id=%s", (first,))[0]["description"]
    session = (await flow.client.post(f"/api/containers/{flow.cid}/qa/sessions", json={
        "actor_agent_id": people["bot"], "kind": "check", "platform": "web", "task_id": first})).json()["id"]
    # The run streams from the moment the session starts, before its first verdict.
    g = await flow.get()
    assert next(s for s in g["screens"] if s["id"] == gap)["first_run"] == {"scenario_id": sid, "run_id": session, "verdict": "running"}
    await flow.client.post(f"/api/qa/sessions/{session}/verdicts", json={
        "actor_agent_id": people["bot"], "scenario_id": sid, "criterion_index": 0, "verdict": "pass"})
    g = await flow.until(lambda g: next(s for s in g["screens"] if s["id"] == gap).get("first_run", {}).get("run_id"))
    assert next(s for s in g["screens"] if s["id"] == gap)["first_run"]["verdict"] == "running"
    db.execute("UPDATE tasks SET status='completed' WHERE id=%s", (first,))
    g = await flow.until(lambda g: g["state"] == "done")
    assert g["phase"] == "done" and g["phases"]["done"]["state"] == "done"
    fr = next(s for s in g["screens"] if s["id"] == gap)["first_run"]
    assert (fr["verdict"], fr["outcome"]) == ("pass", "passed")


async def test_tests_become_flows_and_bringing_them_in_takes_the_baseline(flow, people, client, repo, db):
    g = await flow.mapped(live=False)
    await flow.until(lambda g: g["phases"]["coverage"]["state"] == "done")
    map_ = (await client.get(f"/api/containers/{flow.cid}/qa/map", params={"platform": "web"})).json()
    flows = [n for n in map_["nodes"] if n["kind"] == "flow"]
    assert flows and map_["sources"]["tests"]["tests"] == len(flows) == g["phases"]["tests"]["counts"]["tests"]
    assert (await client.get(f"/api/containers/{flow.cid}/qa/coverage/growth")).json()["baseline"] is None
    tasks_before = db.execute("SELECT count(*) AS n FROM tasks WHERE container_id=%s", (flow.cid,))[0]["n"]
    r = await flow.act("bring_in", agent_id=people["bot"], migrate=True, draft=False)
    # Pure: every detected test is a draft by the time the click answers, with no task and no cost.
    assert r["phases"]["bring_in"]["state"] == "done" and "task_id" not in r["phases"]["bring_in"]
    assert r["phases"]["bring_in"]["counts"]["imported"] == g["phases"]["tests"]["counts"]["tests"]
    assert db.execute("SELECT count(*) AS n FROM tasks WHERE container_id=%s", (flow.cid,))[0]["n"] == tasks_before
    rows = (await client.get(f"/api/containers/{flow.cid}/qa/scenarios")).json()["scenarios"]
    assert rows and all(x["status"] == "draft" and "migrated" in x["tags"] and any(t.startswith("test:") for t in x["tags"]) for x in rows)
    assert all(len(x["criteria"]) >= 2 for x in rows) and any('"Paid"' in c or "shown" in c or "error" in c for x in rows for c in x["criteria"])
    g = await flow.get()
    assert g["bring_in"]["imported"] == len(rows)
    assert (g["phase"], g["state"]) == ("first_run", "waiting")
    growth = (await client.get(f"/api/containers/{flow.cid}/qa/coverage/growth")).json()
    assert growth["baseline"]["trigger"] == "onboarding"


async def test_leaving_the_flow_takes_the_baseline(flow, client, repo):
    await flow.mapped(live=False)
    await flow.until(lambda g: g["phases"]["coverage"]["state"] == "done")
    await flow.act("skip")
    growth = (await client.get(f"/api/containers/{flow.cid}/qa/coverage/growth")).json()
    assert growth["baseline"]["trigger"] == "onboarding"


async def test_a_task_names_the_app_the_person_saved(flow, people, repo, db):
    await flow.found()
    await flow.act("confirm", live="ask", agent_id=people["bot"], platforms=[{"kind": "web", "app_id": "http://127.0.0.1:5181/"}])
    await flow.until(lambda g: g["phases"]["tests"]["state"] == "done")
    r = await flow.act("run_live", agent_id=people["bot"])
    body = db.execute("SELECT description FROM tasks WHERE id=%s", (r["phases"]["live"]["task_id"],))[0]["description"]
    assert "app http://127.0.0.1:5181/." in body


async def test_a_row_a_dead_thread_left_running_is_picked_up(flow, repo, db, monkeypatch):
    await flow.found()
    await flow.act("confirm", live=False)
    g = await flow.until(lambda g: g["phases"]["coverage"]["state"] == "done")
    # the portal restarted mid-phase: the row says running and no thread exists
    phases = g["phases"]
    phases["coverage"] = {"state": "running"}
    db.execute("UPDATE qa_onboarding SET phases=%s, state='running', phase='coverage' WHERE container_id=%s",
               (json.dumps(phases), flow.cid))
    qo._threads.pop(flow.cid, None)
    g = await flow.until(lambda g: g["phases"]["coverage"]["state"] == "done")
    assert g["state"] == "waiting"


async def test_a_task_phase_resumes_following_its_task(flow, repo, db):
    await flow.mapped()
    tid = (await flow.act("run_live"))["phases"]["live"]["task_id"]
    await flow.until(lambda g: g["phases"]["live"].get("task_id"))
    t = qo._threads.get(flow.cid)
    qo._threads.pop(flow.cid, None)  # as after a restart; the old thread is the portal's that died
    db.execute("UPDATE tasks SET status='needs_verification' WHERE id=%s", (tid,))
    g = await flow.until(lambda g: g["phases"]["live"]["state"] == "done")
    assert g["phases"]["live"]["task_id"] == tid and len(db.execute(
        "SELECT id FROM tasks WHERE description LIKE %s", ("%/orcha-qa-map%",))) == 1
    if t is not None:
        t.join(2)


async def test_a_phase_that_fails_is_written_down_and_the_flow_goes_on(flow, repo, monkeypatch):
    def boom(_repo, _platform):
        raise RuntimeError("the code reader broke")

    class Map:
        build_payload = staticmethod(boom)

    monkeypatch.setattr(qo, "_codemap", lambda: Map)
    await flow.found()
    await flow.act("confirm")
    g = await flow.until(lambda g: g["phases"]["code_map"]["state"] == "failed")
    assert g["phases"]["code_map"]["note"] == "the code reader broke"
    await flow.until(lambda g: g["phases"]["tests"]["state"] == "done")


async def test_found_failing_says_so(flow, repo, monkeypatch):
    class Broken:
        @staticmethod
        def read_folder(_root):
            raise RuntimeError("no luck")

    monkeypatch.setattr(qo, "detector", lambda: Broken)
    await flow.act("start")
    g = await flow.until(lambda g: g["state"] == "failed")
    assert g["phases"]["found"]["note"] == "no luck"


async def test_skip_and_restart(flow, repo):
    await flow.mapped()
    r = await flow.act("skip")
    assert r["state"] == "done" and r["phases"]["live"]["state"] == "skipped" and r["phases"]["done"]["state"] == "done"
    r = await flow.act("restart")
    assert (r["state"], r["phase"]) == ("idle", "found") and r["phases"]["found"] == {"state": "pending"}
    assert (await flow.get())["found"] == {}


async def test_no_payload_or_route_doc_names_the_old_product(flow, client, repo):
    await flow.mapped(live=False)
    g = await flow.until(lambda g: g["phases"]["coverage"]["state"] == "done")
    assert "covered_by_qa" in g["summary"]
    assert "verdikt" not in json.dumps(g).lower()
    spec = (await client.get("/openapi.json")).json()
    onboarding = {p: v for p, v in spec["paths"].items() if "/qa" in p}
    assert onboarding and "verdikt" not in json.dumps(onboarding).lower()


async def test_gaps_and_the_first_test_stay_on_the_picked_platform(flow, people, repo, client, db):
    g = await flow.mapped(platform="web")
    assert all(s.startswith("screen:web:") for s in g["bring_in"]["draft"]["gap_screen_ids"])


def test_a_test_only_counts_on_its_own_platform():
    from types import SimpleNamespace as T
    tests = [T(framework="xcuitest"), T(framework="espresso"), T(framework="playwright"), T(framework="maestro")]
    assert [t.framework for t in qo.tests_on(tests, "android")] == ["espresso", "maestro"]
    assert [t.framework for t in qo.tests_on(tests, "ios")] == ["xcuitest", "maestro"]
    assert [t.framework for t in qo.tests_on(tests, "web")] == ["playwright", "maestro"]
