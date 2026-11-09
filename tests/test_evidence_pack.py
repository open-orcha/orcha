"""Proof-of-work evidence packs (evidence_routes, evidence_pack).

Covers: the pack built from a task's own runs (tests parsed from stream-json, captured diff →
summary + risk flags, DoD checklist with evidence lines + the agent's labelled claim, links),
basis-driven rebuild, verification rounds, the /done hook, Needs-you summaries and access
(viewer reads, stranger 403) — and that nothing here ever changes the task's status."""
import json
import time

import pytest

from conftest import ts_from_now


OCTO = {"X-Auth-Request-User": "octocat"}
HUBOT = {"X-Auth-Request-User": "hubot"}
VERA = {"X-Auth-Request-User": "vera"}
MALLORY = {"X-Auth-Request-User": "mallory"}


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
    assert "summary" in p and set(p["summary"]) == {"dod", "tests", "risk_flags", "line"}
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


async def test_access_under_proxy_identity(client, container, make_agent, make_task, trust_proxy):
    cid = container["id"]
    await _members(client, cid, make_agent)
    task = await make_task("t", "Tests pass")
    tid = task["id"]
    assert (await client.get(f"/api/tasks/{tid}/evidence", headers=VERA)).status_code == 200
    assert (await client.get(f"/api/tasks/{tid}/evidence", headers=HUBOT)).status_code == 200
    assert (await client.get(f"/api/tasks/{tid}/evidence", headers=MALLORY)).status_code == 403
    assert (await client.get(f"/api/containers/{cid}/evidence-summaries", headers=MALLORY)).status_code == 403


async def test_removed_qa_handoff_routes_are_gone(client, container, make_agent, make_task):
    """The external QA handoff was removed: none of its routes is in the contract, and an
    older client that still calls them gets a plain 404."""
    paths = (await client.get("/openapi.json")).json()["paths"]
    assert not [p for p in paths if "verdikt" in p]
    cid = container["id"]
    tid = (await make_task("t", "Tests pass"))["id"]
    for method, url in (("get", f"/api/containers/{cid}/verdikt"), ("get", f"/api/tasks/{tid}/verdikt/runs"),
                        ("get", f"/api/tasks/{tid}/verdikt/autofix"),
                        ("post", f"/api/containers/{cid}/verdikt/sweep")):
        r = await getattr(client, method)(url) if method == "get" else await client.post(url, json={})
        assert r.status_code in (404, 405), (url, r.status_code)
