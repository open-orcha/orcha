"""Proof-of-work evidence packs + the Verdikt handoff (evidence_routes, verdikt_routes).

Covers: the pack built from a task's own runs (tests parsed from stream-json, captured diff →
summary + risk flags, DoD checklist with evidence lines + the agent's labelled claim, links),
basis-driven rebuild, verification rounds, the /done hook, Needs-you summaries, access
(viewer reads, stranger 403), Verdikt settings (validation + authority), connection test,
manual trigger → real HTTP to a fake Verdikt → poll → verdicts mapped onto DoD lines +
screenshots/recording/report links, honest failure states (unavailable / failed / timeout /
missing project), retry, cancel, one-open-run rule, auto-trigger policy (ui_changes / always /
manual, once per round) — and that nothing here ever changes the task's status."""
import json
import time
from datetime import timedelta

import pytest

from fake_verdikt import FakeVerdikt
from conftest import ts_ago, ts_from_now


OCTO = {"X-Auth-Request-User": "octocat"}
HUBOT = {"X-Auth-Request-User": "hubot"}
VERA = {"X-Auth-Request-User": "vera"}
MALLORY = {"X-Auth-Request-User": "mallory"}


@pytest.fixture
def fake():
    f = FakeVerdikt()
    f.base = f.start()
    f.add_project("shop-web", "Shop web")
    yield f
    f.stop()


# ------------------------------------------------------------------ helpers

def _claude(cmd, out, *, err=False, tid="t1"):
    use = {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": tid, "name": "Bash", "input": {"command": cmd}}]}}
    res = {"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": tid, "content": out, "is_error": err}]}}
    return json.dumps(use) + "\n" + json.dumps(res)


DIFF = """diff --git a/web/src/pages/Login.tsx b/web/src/pages/Login.tsx
index 111..222 100644
--- a/web/src/pages/Login.tsx
+++ b/web/src/pages/Login.tsx
@@ -1,2 +1,3 @@
 export function Login() {
+  return <p className="err">Wrong password</p>;
 }
diff --git a/api/auth/session.py b/api/auth/session.py
index 333..444 100644
--- a/api/auth/session.py
+++ b/api/auth/session.py
@@ -1 +1,2 @@
 x = 1
+API_TOKEN = "abcdefgh12345678"
diff --git a/tests/test_login.py b/tests/test_login.py
new file mode 100644
--- /dev/null
+++ b/tests/test_login.py
@@ -0,0 +1,2 @@
+def test_login():
+    assert True
"""

DOD = """- All tests pass
- Add tests for the login error
- The login page shows "Wrong password" after a bad password
- The error text is red
"""


def _run(db, aid, tid, *, output, diff=DIFF, status="exited", started="now()"):
    rows = db.execute(
        f"""INSERT INTO worker_runs (agent_id, task_id, wake_kind, status, exit_code, output, diff,
                                    started_at, ended_at, branch)
            VALUES (%s, %s, 'headless', %s, 0, %s, %s, {started}, {started}, 'orcha/login-error')
            RETURNING run_id""",
        (aid, tid, status, output, diff),
    )
    return str(rows[0]["run_id"])


async def _nv_task(client, make_agent, make_task, work_headers, *, dod=DOD, result="Wired the login error. All tests pass.",
                   runs=True, db=None):
    human = await make_agent("root", "operator", kind="human")
    worker = await make_agent("Pixel", "frontend")
    task = await make_task("Show login error", dod, assignee_alias="Pixel", description="Bad passwords must say so.")
    tid = task["id"]
    if runs:
        out = "\n".join([
            _claude("npm test", "Exit code 1\nTests:       1 failed, 11 passed, 12 total", err=True, tid="a"),
            _claude("npm test", "Tests:       12 passed, 12 total", tid="b"),
            _claude("pytest -q", "==== 30 passed in 1.02s ====", tid="c"),
            _claude("gh pr create --fill", "https://github.com/acme/shop/pull/42", tid="d"),
        ])
        _run(db, worker["agent_id"], tid, output=out)
    r = await client.post(f"/api/tasks/{tid}/done", json={"agent_id": worker["agent_id"], "result": result},
                          headers=await work_headers(worker["agent_id"]))
    assert r.status_code == 200, r.text
    return human["agent_id"], worker["agent_id"], tid


async def _settings(client, cid, hid, base, **kw):
    body = {"actor_agent_id": hid, "enabled": True, "base_url": base, "verdikt_project": "shop-web",
            "target_kind": "web", "target_locator": "http://127.0.0.1:5173/login", "trigger_mode": "manual", **kw}
    r = await client.put(f"/api/containers/{cid}/verdikt", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _wait(pred, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        v = pred()
        if v:
            return v
        time.sleep(0.05)
    return pred()


# ------------------------------------------------------------------ the pack

async def test_pack_from_real_run_output_and_diff(client, container, make_agent, make_task, work_headers, db):
    _hid, _wid, tid = await _nv_task(client, make_agent, make_task, work_headers, db=db)
    r = await client.get(f"/api/tasks/{tid}/evidence")
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["task_status"] == "needs_verification"
    t = p["tests"]
    # the npm rerun wins over the failing first attempt; pytest counted alongside
    assert t["status"] == "passed" and t["passed"] == 42 and t["failed"] == 0
    assert t["suites"] == 2 and t["earlier"] == 1
    c = p["changes"]
    assert c["files"] == 3 and c["ui_touching"] is True
    assert c["summary"].startswith("Changed 3 files (+4 −0): 1 UI file, 1 source file, 1 test file.")
    kinds = {f["kind"] for f in p["flags"]}
    assert kinds == {"auth", "secrets"}
    assert "abcdefgh" not in json.dumps(p)  # never echo the secret
    items = p["dod"]["items"]
    assert [i["status"] for i in items] == ["proven", "proven", "needs_human", "needs_human"]
    # `npm test` is of unknown framework until its output names the runner (jest's "Tests:")
    assert items[0]["evidence"] == "npm test (jest): 12 passed; pytest: 30 passed"
    assert items[1]["evidence"] == "Test files changed: tests/test_login.py"
    assert p["claim"]["text"].startswith("Wired the login error")
    assert p["summary"]["line"] == "2/4 DoD items evidenced · 42 tests passed · 2 risk flags"
    assert p["pr_urls"] == ["https://github.com/acme/shop/pull/42"]
    assert p["branch"] == "orcha/login-error"
    kinds = [l["kind"] for l in p["links"]]
    assert "captured_diff" in kinds and "runs" in kinds and "pr" in kinds
    cap = next(l for l in p["links"] if l["kind"] == "captured_diff")
    assert cap["href"].startswith("/agents?agent=Pixel&changes=")
    assert p["verdikt"] is None
    # evidence never changes the task
    task = db.execute("SELECT status FROM tasks WHERE id=%s", (tid,))[0]
    assert task["status"] == "needs_verification"


async def test_no_runs_is_honest(client, container, make_agent, make_task, work_headers, db):
    _h, _w, tid = await _nv_task(client, make_agent, make_task, work_headers, db=db, runs=False,
                                 dod="Tests pass; the docs mention it")
    p = (await client.get(f"/api/tasks/{tid}/evidence")).json()
    assert p["tests"]["status"] == "none" and p["changes"]["files"] == 0
    assert [i["status"] for i in p["dod"]["items"]] == ["not_proven", "not_proven"]
    assert p["dod"]["items"][0]["evidence"] == "No test command found in this task's run output"
    assert p["summary"]["line"] == "0/2 DoD items evidenced · no tests ran"


async def test_basis_rebuild_and_rounds(client, container, make_agent, make_task, work_headers, db):
    hid, wid, tid = await _nv_task(client, make_agent, make_task, work_headers, db=db)
    first = (await client.get(f"/api/tasks/{tid}/evidence")).json()
    again = (await client.get(f"/api/tasks/{tid}/evidence")).json()
    assert again["rebuilt"] is False and again["built_at"] == first["built_at"]
    # reject → rework round: earlier runs no longer count
    r = await client.post(f"/api/tasks/{tid}/verify", json={"approve": False, "actor_agent_id": hid,
                                                           "feedback": "error must be red"})
    assert r.status_code == 200, r.text
    fresh = (await client.get(f"/api/tasks/{tid}/evidence")).json()
    assert fresh["rebuilt"] is True and fresh["runs"] == [] and fresh["tests"]["status"] == "none"
    assert fresh["round_started_at"]
    _run(db, wid, tid, output=_claude("pytest", "1 failed, 29 passed in 1s", err=True), diff="",
         started=f"{ts_from_now(1)}")
    r = await client.post(f"/api/tasks/{tid}/evidence/rebuild")
    assert r.status_code == 200
    assert r.json()["tests"]["status"] == "failed"
    assert r.json()["summary"]["line"].endswith("1 tests failing")


async def test_done_hook_builds_pack(client, container, make_agent, make_task, work_headers, db):
    _h, _w, tid = await _nv_task(client, make_agent, make_task, work_headers, db=db)
    row = _wait(lambda: db.execute("SELECT built_reason, pack FROM task_evidence_packs WHERE task_id=%s", (tid,)))
    assert row and row[0]["built_reason"] == "needs_verification"
    assert row[0]["pack"]["tests"]["passed"] == 42


async def test_summaries_for_needs_you(client, container, make_agent, make_task, work_headers, db):
    _h, _w, tid = await _nv_task(client, make_agent, make_task, work_headers, db=db)
    r = await client.get(f"/api/containers/{container['id']}/evidence-summaries")
    assert r.status_code == 200, r.text
    s = r.json()["summaries"][tid]
    assert s["line"] == "2/4 DoD items evidenced · 42 tests passed · 2 risk flags"
    assert s["dod"] == {"total": 4, "proven": 2, "not_proven": 0, "needs_human": 2}
    assert (await client.get(f"/api/containers/{container['id']}/evidence-summaries?status=bogus")).status_code == 400
    assert (await client.get("/api/tasks/nope/evidence")).status_code == 400


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    monkeypatch.setenv("ORCHA_PLAN", "team")


async def _members(client, cid, make_agent):
    await make_agent("root", "operator", kind="human")
    assert (await client.get(f"/api/me?cid={cid}", headers=OCTO)).status_code == 200

    async def invite(login, role):
        r = await client.post(f"/api/containers/{cid}/members", json={"github_login": login, "role": role}, headers=OCTO)
        assert r.status_code == 201, r.text
        return r.json()["agent_id"]
    return await invite("hubot", "member"), await invite("vera", "viewer")


async def test_access_under_proxy_identity(client, container, make_agent, make_task, trust_proxy, fake):
    cid = container["id"]
    hubot, _vera = await _members(client, cid, make_agent)
    task = await make_task("t", "Tests pass")
    tid = task["id"]
    assert (await client.get(f"/api/tasks/{tid}/evidence", headers=VERA)).status_code == 200
    assert (await client.get(f"/api/tasks/{tid}/evidence", headers=MALLORY)).status_code == 403
    assert (await client.get(f"/api/containers/{cid}/verdikt", headers=VERA)).status_code == 200
    body = {"enabled": True, "base_url": fake.base, "verdikt_project": "shop-web",
            "target_locator": "http://127.0.0.1:5173"}
    assert (await client.put(f"/api/containers/{cid}/verdikt", json=body, headers=VERA)).status_code == 403
    assert (await client.put(f"/api/containers/{cid}/verdikt", json=body, headers=HUBOT)).status_code == 403
    assert (await client.post(f"/api/containers/{cid}/verdikt/test", json={}, headers=HUBOT)).status_code == 403
    r = await client.put(f"/api/containers/{cid}/verdikt", json=body, headers=OCTO)
    assert r.status_code == 200, r.text
    assert r.json()["enabled"] is True
    g = await client.patch(f"/api/containers/{cid}/members/{hubot}", json={"grants": ["manage_repo"]}, headers=OCTO)
    assert g.status_code == 200
    assert (await client.put(f"/api/containers/{cid}/verdikt", json=body, headers=HUBOT)).status_code == 200
    # a viewer cannot trigger; a member can
    assert (await client.post(f"/api/tasks/{tid}/verdikt/runs", json={}, headers=VERA)).status_code == 403
    r = await client.post(f"/api/tasks/{tid}/verdikt/runs", json={}, headers=HUBOT)
    assert r.status_code == 201, r.text
    assert r.json()["triggered_by"] == hubot


# ------------------------------------------------------------------ settings

async def test_settings_validation(client, container, make_agent):
    cid = container["id"]
    hid = (await make_agent("root", "operator", kind="human"))["agent_id"]
    ai = (await make_agent("Bot"))["agent_id"]
    d = (await client.get(f"/api/containers/{cid}/verdikt")).json()
    assert d["configured"] is False and d["enabled"] is False and d["trigger_mode"] == "manual"
    put = lambda body: client.put(f"/api/containers/{cid}/verdikt", json={"actor_agent_id": hid, **body})
    assert (await put({"enabled": True})).status_code == 400
    assert (await put({"base_url": "ftp://x"})).status_code == 400
    assert (await put({"base_url": "http://v", "verdikt_project": "bad slug!"})).status_code == 400
    assert (await put({"target_kind": "web", "target_locator": "not a url"})).status_code == 400
    assert (await put({"target_kind": "ios", "target_locator": "com.acme.App"})).status_code == 200
    assert (await put({"trigger_mode": "sometimes"})).status_code == 422
    assert (await client.put(f"/api/containers/{cid}/verdikt",
                             json={"actor_agent_id": ai, "enabled": False})).status_code == 403
    s = (await put({"enabled": True, "base_url": "http://127.0.0.1:31100/", "verdikt_project": "shop-web",
                    "trigger_mode": "ui_changes", "timeout_minutes": 15})).json()
    assert s["base_url"] == "http://127.0.0.1:31100" and s["configured"] is True and s["timeout_minutes"] == 15


async def test_connection_check(client, container, make_agent, fake):
    cid = container["id"]
    hid = (await make_agent("root", "operator", kind="human"))["agent_id"]
    r = await client.post(f"/api/containers/{cid}/verdikt/test",
                          json={"actor_agent_id": hid, "base_url": fake.base, "verdikt_project": "shop-web"})
    d = r.json()
    assert d["reachable"] is True and d["ok"] is True and d["project_found"] is True and d["worker_online"] is True
    assert d["projects"][0]["slug"] == "shop-web"
    d = (await client.post(f"/api/containers/{cid}/verdikt/test",
                           json={"actor_agent_id": hid, "base_url": fake.base, "verdikt_project": "nope"})).json()
    assert d["ok"] is False and d["error"] == "Verdikt has no project 'nope'"
    d = (await client.post(f"/api/containers/{cid}/verdikt/test",
                           json={"actor_agent_id": hid, "base_url": "http://127.0.0.1:9", "verdikt_project": "x"})).json()
    assert d["reachable"] is False and d["ok"] is False and "not reachable" in d["error"]
    # nothing saved and no URL given: nothing was contacted, so it is not "reachable"
    d = (await client.post(f"/api/containers/{cid}/verdikt/test", json={"actor_agent_id": hid})).json()
    assert d["reachable"] is False and d["ok"] is False and d["error"] == "no Verdikt URL configured"


# ------------------------------------------------------------------ trigger → poll → evidence

async def test_manual_trigger_roundtrip(client, container, make_agent, make_task, work_headers, db, fake):
    hid, _w, tid = await _nv_task(client, make_agent, make_task, work_headers, db=db)
    await _settings(client, container["id"], hid, fake.base)
    r = await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})
    assert r.status_code == 201, r.text
    run = r.json()
    assert run["status"] == "queued" and run["verdikt_request_id"] and run["error"] is None
    assert run["locator"] == "http://127.0.0.1:5173/login" and run["trigger"] == "manual"
    h = run["handoff"]
    # code-level DoD lines are proven from the run itself and are NOT sent to the UI tester
    assert [c["dod_index"] for c in h["criteria"]] == [2, 3]
    assert [s["dod_index"] for s in h["skipped_items"]] == [0, 1]
    sc = fake.tables["scenarios"][0]
    assert sc["name"] == f"Orcha {tid[:8]} · Show login error" and sc["status"] == "validated"
    assert sc["criteria"] == ['The login page shows "Wrong password" after a bad password', "The error text is red"]
    assert "Changed files (3)" in sc["description"] and "PR: https://github.com/acme/shop/pull/42" in sc["description"]
    assert "Branch: orcha/login-error" in sc["description"]
    req = fake.tables["run_requests"][0]
    assert req["mode"] == "scenarios" and json.loads(req["scenario_ids"]) == [sc["id"]]
    # one open run at a time
    assert (await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})).status_code == 409
    # evidence shows it running
    fake.start_run(req["id"])
    p = (await client.get(f"/api/tasks/{tid}/evidence")).json()
    assert p["verdikt"]["status"] == "running" and p["summary"]["line"].endswith("Verdikt running")
    # the worker finishes: criterion 0 passes, criterion 1 fails
    vrid = fake.complete(req["id"], "fail", [
        {"text": 'The login page shows "Wrong password" after a bad password', "outcome": "pass", "from_step": 1, "to_step": 4},
        {"text": "The error text is red", "outcome": "fail", "expected": "red text", "actual": "the error text is black",
         "evidence_seq": 1},
    ], reason="error text colour", evidence=[("error text colour", "major")])
    rr = await client.post(f"/api/tasks/{tid}/verdikt/runs/{run['id']}/refresh")
    v = rr.json()
    assert v["status"] == "completed" and v["verdict"] == "fail" and v["verdikt_run_id"] == vrid
    # links are portal-relative (the browser can't be assumed to reach Verdikt's server-side URL)
    base = f"/api/tasks/{tid}/verdikt/runs/{run['id']}"
    assert v["report_url"] == f"{base}/report"
    assert v["video_url"] == f"{base}/artifact?path={vrid}/run.webm"
    assert v["screenshots"][0]["url"] == f"{base}/artifact?path={vrid}/evidence/001-major.png"
    assert v["screenshots"][0]["path"] == f"{vrid}/evidence/001-major.png"
    assert fake.base not in json.dumps(v["screenshots"]) + str(v["video_url"]) + str(v["report_url"])
    assert [(c["dod_index"], c["outcome"]) for c in v["criteria"]] == [(2, "pass"), (3, "fail")]
    p = (await client.get(f"/api/tasks/{tid}/evidence")).json()
    st = [i["status"] for i in p["dod"]["items"]]
    assert st == ["proven", "proven", "proven", "not_proven"]
    assert p["dod"]["items"][3]["evidence"] == f"Verdikt run {vrid[:8]}: fail — the error text is black"
    assert p["summary"]["line"] == "3/4 DoD items evidenced · 42 tests passed · 2 risk flags · Verdikt fail"
    # Verdikt never verifies: the human gate is untouched
    assert db.execute("SELECT status FROM tasks WHERE id=%s", (tid,))[0]["status"] == "needs_verification"
    # retry reuses the same Verdikt scenario
    r2 = await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})
    assert r2.status_code == 201 and r2.json()["handoff"]["scenario_reused"] is True
    assert len(fake.tables["scenarios"]) == 1 and len(fake.tables["run_requests"]) == 2
    lst = (await client.get(f"/api/tasks/{tid}/verdikt/runs")).json()
    assert len(lst["runs"]) == 2 and lst["settings"]["enabled"] is True
    ev = db.execute("SELECT count(*) AS n FROM events WHERE entity_id=%s AND event_type='verdikt_triggered'", (tid,))
    assert ev[0]["n"] == 2


async def test_frames_fallback_and_locator_override(client, container, make_agent, make_task, work_headers, db, fake):
    hid, _w, tid = await _nv_task(client, make_agent, make_task, work_headers, db=db)
    await _settings(client, container["id"], hid, fake.base, target_locator=None)
    r = await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})
    assert r.status_code == 400 and "no target" in r.json()["detail"]
    assert (await client.post(f"/api/tasks/{tid}/verdikt/runs",
                              json={"actor_agent_id": hid, "locator": "javascript:alert(1)"})).status_code == 400
    r = await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid, "locator": "https://preview.example.dev"})
    assert r.status_code == 201 and r.json()["locator"] == "https://preview.example.dev"
    req = fake.tables["run_requests"][0]
    vrid = fake.complete(req["id"], "pass", [{"text": "x", "outcome": "pass"}, {"text": "y", "outcome": "pass"}],
                         video=False, frames=[3, 4])
    v = (await client.post(f"/api/tasks/{tid}/verdikt/runs/{r.json()['id']}/refresh")).json()
    assert v["verdict"] == "pass" and v["video_url"] is None
    assert [s["kind"] for s in v["screenshots"]] == ["frame", "frame"]
    assert v["screenshots"][0]["url"].endswith(f"{vrid}/frames/0004.jpg")


async def test_unavailable_failed_timeout_missing_project(client, container, make_agent, make_task, work_headers, db, fake):
    hid, _w, tid = await _nv_task(client, make_agent, make_task, work_headers, db=db)
    cid = container["id"]
    # 1) Verdikt down → recorded as unavailable (201), retry allowed
    await _settings(client, cid, hid, "http://127.0.0.1:9")
    r = await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})
    assert r.status_code == 201 and r.json()["status"] == "unavailable" and "not reachable" in r.json()["error"]
    p = (await client.get(f"/api/tasks/{tid}/evidence")).json()
    assert p["summary"]["line"].endswith("Verdikt unavailable")
    # 2) unknown Verdikt project → failed with the known projects named
    await _settings(client, cid, hid, fake.base, verdikt_project="nope")
    r = await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})
    assert r.json()["status"] == "failed" and r.json()["error"] == "Verdikt has no project 'nope' (projects: shop-web)"
    # 3) Verdikt answers 500 on queue → failed
    await _settings(client, cid, hid, fake.base)
    fake.fail_next["POST /api/requests"] = 1
    r = await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})
    assert r.json()["status"] == "failed" and "HTTP 500" in r.json()["error"]
    # 4) the request fails inside Verdikt → failed with its error
    r = await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})
    rid = r.json()["id"]
    fake.fail(fake.tables["run_requests"][-1]["id"], "build failed")
    v = (await client.post(f"/api/tasks/{tid}/verdikt/runs/{rid}/refresh")).json()
    assert v["status"] == "failed" and v["error"] == "build failed"
    # 5) Verdikt goes quiet → timeout after the configured minutes, request cancelled best-effort
    r = await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})
    rid = r.json()["id"]
    db.execute(f"UPDATE verdikt_runs SET created_at = {ts_ago(1860)} WHERE id=%s", (rid,))
    v = (await client.post(f"/api/tasks/{tid}/verdikt/runs/{rid}/refresh")).json()
    assert v["status"] == "timeout" and v["error"] == "no result from Verdikt within 30 min"
    assert fake.tables["run_requests"][-1]["status"] == "cancelled"
    # 6) transient poll failure keeps the run open with a note
    r = await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})
    rid = r.json()["id"]
    fake.fail_next["POST /api/db"] = 1
    v = (await client.post(f"/api/tasks/{tid}/verdikt/runs/{rid}/refresh")).json()
    assert v["status"] == "queued" and v["error"].startswith("last check failed")
    # 7) cancel
    c = await client.post(f"/api/tasks/{tid}/verdikt/runs/{rid}/cancel", json={"actor_agent_id": hid})
    assert c.status_code == 200 and c.json()["status"] == "cancelled"
    assert (await client.post(f"/api/tasks/{tid}/verdikt/runs/{rid}/cancel", json={"actor_agent_id": hid})).status_code == 409
    assert db.execute("SELECT status FROM tasks WHERE id=%s", (tid,))[0]["status"] == "needs_verification"


async def test_trigger_refusals(client, container, make_agent, make_task, work_headers, db, fake):
    hid, wid, tid = await _nv_task(client, make_agent, make_task, work_headers, db=db)
    r = await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})
    assert r.status_code == 409 and "not enabled" in r.json()["detail"]
    await _settings(client, container["id"], hid, fake.base)
    assert (await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": wid})).status_code == 403
    assert (await client.post(f"/api/tasks/{tid}/verdikt/runs", json={})).status_code == 400
    assert (await client.post(f"/api/tasks/{tid}/verdikt/runs/not-a-uuid/refresh")).status_code == 400


async def test_worker_offline_is_said(client, container, make_agent, make_task, work_headers, db, fake):
    hid, _w, tid = await _nv_task(client, make_agent, make_task, work_headers, db=db)
    fake.worker_online = False
    await _settings(client, container["id"], hid, fake.base)
    r = (await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})).json()
    assert r["status"] == "queued" and r["error"] == "queued — no Verdikt worker is online to run it yet"
    # a poll while still queued keeps saying so (it used to clear the note on the first poll)
    v = (await client.post(f"/api/tasks/{tid}/verdikt/runs/{r['id']}/refresh")).json()
    assert v["status"] == "queued" and v["error"] == "queued — no Verdikt worker is online to run it yet"
    p = (await client.get(f"/api/tasks/{tid}/evidence")).json()
    assert p["summary"]["line"].endswith("Verdikt queued")
    # the worker comes online: the note goes away
    fake.worker_online = True
    v = (await client.post(f"/api/tasks/{tid}/verdikt/runs/{r['id']}/refresh")).json()
    assert v["status"] == "queued" and v["error"] is None


# ------------------------------------------------------------------ auto-trigger policy

async def test_auto_trigger_policy(client, container, make_agent, make_task, work_headers, db, fake):
    from portal_backend import evidence_pack

    hid = (await make_agent("root", "operator", kind="human"))["agent_id"]
    await _settings(client, container["id"], hid, fake.base, trigger_mode="ui_changes")
    worker = await make_agent("Pixel", "frontend")
    headers = await work_headers(worker["agent_id"])

    async def nv(title, diff):
        t = await make_task(title, "The page works", assignee_alias="Pixel")
        tid = t["id"]
        _run(db, worker["agent_id"], tid, output="", diff=diff)
        r = await client.post(f"/api/tasks/{tid}/done", json={"agent_id": worker["agent_id"], "result": "ok"},
                              headers=headers)
        assert r.status_code == 200, r.text
        return tid

    ui = await nv("ui", DIFF)
    assert _wait(lambda: db.execute("SELECT trigger, status FROM verdikt_runs WHERE task_id=%s", (ui,)))[0]["trigger"] == "auto"
    backend_only = "diff --git a/api/x.py b/api/x.py\n--- a/api/x.py\n+++ b/api/x.py\n@@ -1 +1 @@\n-a\n+b\n"
    be = await nv("backend", backend_only)
    _wait(lambda: db.execute("SELECT 1 FROM task_evidence_packs WHERE task_id=%s", (be,)))
    time.sleep(0.3)
    assert db.execute("SELECT count(*) AS n FROM verdikt_runs WHERE task_id=%s", (be,))[0]["n"] == 0
    # at most once per round: a second hook call does not queue again
    evidence_pack.on_task_needs_verification(ui, background=False)
    assert db.execute("SELECT count(*) AS n FROM verdikt_runs WHERE task_id=%s", (ui,))[0]["n"] == 1
    # 'always' fires for backend-only changes too
    await _settings(client, container["id"], hid, fake.base, trigger_mode="always")
    evidence_pack.on_task_needs_verification(be, background=False)
    assert db.execute("SELECT count(*) AS n FROM verdikt_runs WHERE task_id=%s", (be,))[0]["n"] == 1
    # 'manual' never auto-fires
    await _settings(client, container["id"], hid, fake.base, trigger_mode="manual")
    t3 = await nv("manual", DIFF)
    _wait(lambda: db.execute("SELECT 1 FROM task_evidence_packs WHERE task_id=%s", (t3,)))
    time.sleep(0.3)
    assert db.execute("SELECT count(*) AS n FROM verdikt_runs WHERE task_id=%s", (t3,))[0]["n"] == 0


# ------------------------------------------------------------------ QA round (2026-09-30) regressions

_CRIT = [
    {"text": 'The login page shows "Wrong password" after a bad password', "outcome": "pass"},
    {"text": "The error text is red", "outcome": "fail", "expected": "red", "actual": "the error text is black"},
]


async def test_late_result_is_kept_not_overwritten_as_timeout(client, container, make_agent, make_task, work_headers, db, fake):
    """Polling is read-driven: a verdict that landed while nobody read the task must be kept on
    the first read after the timeout, not discarded as 'timeout' (and Verdikt not told to cancel)."""
    hid, _w, tid = await _nv_task(client, make_agent, make_task, work_headers, db=db)
    await _settings(client, container["id"], hid, fake.base, timeout_minutes=5)
    run = (await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})).json()
    req = fake.tables["run_requests"][0]
    fake.complete(req["id"], "fail", _CRIT)
    db.execute(f"UPDATE verdikt_runs SET created_at = {ts_ago(360)} WHERE id=%s", (run["id"],))
    p = (await client.get(f"/api/tasks/{tid}/evidence")).json()
    assert p["verdikt"]["status"] == "completed" and p["verdikt"]["verdict"] == "fail"
    assert [i["status"] for i in p["dod"]["items"]][2:] == ["proven", "not_proven"]
    assert not any(c[0] == "PATCH" and c[1].startswith("/api/requests/") for c in fake.calls)
    # a run that really got no answer still times out (and is cancelled in Verdikt)
    run2 = (await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})).json()
    db.execute(f"UPDATE verdikt_runs SET created_at = {ts_ago(360)} WHERE id=%s", (run2["id"],))
    v = (await client.post(f"/api/tasks/{tid}/verdikt/runs/{run2['id']}/refresh")).json()
    assert v["status"] == "timeout" and fake.tables["run_requests"][-1]["status"] == "cancelled"


async def test_failed_retry_keeps_the_last_real_verdict(client, container, make_agent, make_task, work_headers, db, fake):
    """A later retry that is cancelled / cannot reach Verdikt must not erase (hide) the round's
    last real verdict from the DoD checklist; the Verdikt part of the line reports the retry."""
    hid, _w, tid = await _nv_task(client, make_agent, make_task, work_headers, db=db)
    cid = container["id"]
    await _settings(client, cid, hid, fake.base)
    run = (await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})).json()
    fake.complete(fake.tables["run_requests"][0]["id"], "fail", _CRIT)
    await client.post(f"/api/tasks/{tid}/verdikt/runs/{run['id']}/refresh")
    # retry → cancelled
    r2 = (await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})).json()
    await client.post(f"/api/tasks/{tid}/verdikt/runs/{r2['id']}/cancel", json={"actor_agent_id": hid})
    p = (await client.get(f"/api/tasks/{tid}/evidence")).json()
    assert p["verdikt"]["status"] == "cancelled"
    assert [i["status"] for i in p["dod"]["items"]] == ["proven", "proven", "proven", "not_proven"]
    assert p["summary"]["line"].endswith("Verdikt cancelled")
    # retry → Verdikt down
    await _settings(client, cid, hid, "http://127.0.0.1:9")
    await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})
    p = (await client.get(f"/api/tasks/{tid}/evidence")).json()
    assert p["verdikt"]["status"] == "unavailable"
    assert p["dod"]["items"][3]["status"] == "not_proven" and "Verdikt run" in p["dod"]["items"][3]["evidence"]
    s = (await client.get(f"/api/containers/{cid}/evidence-summaries")).json()["summaries"][tid]
    assert s["dod"]["not_proven"] == 1


async def test_previous_round_verdict_does_not_prove_the_rework(client, container, make_agent, make_task, work_headers, db, fake):
    """After a rejected verification the old round's Verdikt verdict judged the old claim: it
    must not prove DoD lines for the rework nor appear in the summary line; the run itself is
    still returned, flagged previous_round."""
    hid, wid, tid = await _nv_task(client, make_agent, make_task, work_headers, db=db)
    await _settings(client, container["id"], hid, fake.base)
    run = (await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})).json()
    fake.complete(fake.tables["run_requests"][0]["id"], "pass",
                  [dict(c, outcome="pass") for c in _CRIT])
    await client.post(f"/api/tasks/{tid}/verdikt/runs/{run['id']}/refresh")
    p = (await client.get(f"/api/tasks/{tid}/evidence")).json()
    assert [i["status"] for i in p["dod"]["items"]][2:] == ["proven", "proven"]
    r = await client.post(f"/api/tasks/{tid}/verify", json={"approve": False, "actor_agent_id": hid,
                                                           "feedback": "not red enough"})
    assert r.status_code == 200, r.text
    _run(db, wid, tid, output=_claude("pytest -q", "==== 30 passed in 1.02s ===="), started=f"{ts_from_now(1)}")
    p = (await client.get(f"/api/tasks/{tid}/evidence")).json()
    assert p["round_started_at"]
    assert [i["status"] for i in p["dod"]["items"]][2:] == ["needs_human", "needs_human"]
    assert p["verdikt"]["id"] == run["id"] and p["verdikt"]["previous_round"] is True
    assert p["summary"]["verdikt"] is None and "Verdikt" not in p["summary"]["line"]
    # a new run in this round counts again
    run2 = (await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})).json()
    fake.complete(fake.tables["run_requests"][-1]["id"], "pass", [dict(c, outcome="pass") for c in _CRIT])
    await client.post(f"/api/tasks/{tid}/verdikt/runs/{run2['id']}/refresh")
    p = (await client.get(f"/api/tasks/{tid}/evidence")).json()
    assert "previous_round" not in p["verdikt"] and p["summary"]["line"].endswith("Verdikt pass")
    assert [i["status"] for i in p["dod"]["items"]][2:] == ["proven", "proven"]


def test_with_verdikt_round_filter_is_pure():
    from portal_backend import evidence_pack as ep_mod

    pack = {"dod": {"items": [{"index": 0, "text": "The page is blue", "status": "needs_human", "basis": "none",
                                "evidence": None}]},
            "tests": {"status": "none"}, "changes": {"list": []}, "flags": [],
            "round_started_at": "2026-09-30T10:00:00+00:00"}
    old = {"id": "r1", "status": "completed", "verdict": "pass", "created_at": "2026-09-30T09:00:00+00:00",
           "verdikt_run_id": "abcdef0123", "criteria": [{"dod_index": 0, "text": "The page is blue", "outcome": "pass"}]}
    out = ep_mod.with_verdikt(pack, old)
    assert out["dod"]["items"][0]["status"] == "needs_human" and out["verdikt"]["previous_round"] is True
    assert out["summary"]["verdikt"] is None
    new = dict(old, created_at="2026-09-30T10:05:00+00:00")
    out = ep_mod.with_verdikt(pack, {"id": "r2", "status": "cancelled", "created_at": "2026-09-30T10:06:00+00:00"}, new)
    assert out["dod"]["items"][0]["status"] == "proven" and out["summary"]["verdikt"]["status"] == "cancelled"
