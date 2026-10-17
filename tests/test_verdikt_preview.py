"""Verdikt preview environments (mig 064) + "Open in Verdikt".

The gap: Verdikt only tests something already running at a target, so "Run in Verdikt" tested
whatever was at the configured URL, not the agent's change. Now a project can set a preview
command; the host notifier builds + serves the task's worktree and the portal hands Verdikt
that URL. Covered here (portal side, real HTTP to tests/fake_verdikt.py):

  * settings: the preview fields are validated, owner/manage_repo only, omitted fields are kept,
    and they appear in /openapi.json;
  * the lifecycle: trigger → `requested` (Verdikt NOT contacted yet) → claim → `starting` →
    ready → Verdikt is handed http://127.0.0.1:{port}/… → heartbeats drive the poll → the
    preview is told to stop once the run is over; failures read "Preview failed: …" with the
    log tail; no notifier / a silent notifier / no worktree are honest failures; cancel and
    TTL stop it; the no-preview path is unchanged;
  * the notifier lane is closed to viewers / plain members / strangers;
  * "Open in Verdikt": the run page (with the scenario), else the project page, at a
    browser-reachable host (host.docker.internal rewritten), 404s, and the read permission;
  * the browser "Preview" link and log tail.
The notifier side (processes, ports, kill, TTL, shell safety) is tests/test_notifier_preview.py.
"""
import pytest

from fake_verdikt import FakeVerdikt
from test_evidence_verdikt import HUBOT, MALLORY, OCTO, VERA, _members, _nv_task
from conftest import ts_ago

WT = "/Users/dev/acme/.orcha-worktrees/task-pixel-abc"
BASE = "/Users/dev/acme"
CMD = "python3 -m http.server {port} --bind 127.0.0.1"


@pytest.fixture
def fake():
    f = FakeVerdikt()
    f.base = f.start()
    f.add_project("shop-web", "Shop web")
    yield f
    f.stop()


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    monkeypatch.setenv("ORCHA_PLAN", "team")


async def _settings(client, cid, hid, base, **kw):
    body = {"actor_agent_id": hid, "enabled": True, "base_url": base, "verdikt_project": "shop-web",
            "target_kind": "web", "target_locator": "http://127.0.0.1:5173/login", "trigger_mode": "manual",
            "preview_command": CMD, **kw}
    r = await client.put(f"/api/containers/{cid}/verdikt", json=body)
    assert r.status_code == 200, r.text
    return r.json()


async def _task_with_worktree(client, make_agent, make_task, work_headers, db, *, worktree=WT, branch="orcha/task-pixel-abc"):
    hid, wid, tid = await _nv_task(client, make_agent, make_task, work_headers, db=db)
    db.execute("UPDATE worker_runs SET worktree=%s, base_cwd=%s, branch=%s WHERE task_id=%s",
               (worktree, BASE, branch, tid))
    return hid, wid, tid


async def _previewed(client, container, make_agent, make_task, work_headers, db, fake, **kw):
    hid, _w, tid = await _task_with_worktree(client, make_agent, make_task, work_headers, db)
    await _settings(client, container["id"], hid, fake.base, **kw)
    r = await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})
    assert r.status_code == 201, r.text
    return hid, tid, r.json()


async def _claim(client, cid):
    r = await client.post(f"/api/containers/{cid}/verdikt/previews/claim", json={"claimed_by": "mac pid 1"})
    assert r.status_code == 200, r.text
    return r.json()["preview"]


# ------------------------------------------------------------------ settings

async def test_settings_validate_keep_and_expose_the_preview_fields(client, container, make_agent, fake):
    cid = container["id"]
    h = await make_agent("root", "operator", kind="human")
    hid = h["agent_id"]
    s = (await client.get(f"/api/containers/{cid}/verdikt")).json()
    assert s["preview_command"] is None and s["preview_ready_path"] == "/"
    assert s["preview_timeout_seconds"] == 120 and s["preview_ttl_minutes"] == 60
    s = await _settings(client, cid, hid, fake.base, preview_ready_path="/health", preview_timeout_seconds=60,
                        preview_ttl_minutes=30)
    assert s["preview_command"] == CMD and s["preview_ready_path"] == "/health"
    assert (s["preview_timeout_seconds"], s["preview_ttl_minutes"]) == (60, 30)
    # an older client that doesn't send the preview fields keeps them
    body = {"actor_agent_id": hid, "enabled": True, "base_url": fake.base, "verdikt_project": "shop-web",
            "target_locator": "http://127.0.0.1:5173"}
    s = (await client.put(f"/api/containers/{cid}/verdikt", json=body)).json()
    assert s["preview_command"] == CMD and s["preview_ready_path"] == "/health" and s["preview_ttl_minutes"] == 30
    # "" clears the command
    s = (await client.put(f"/api/containers/{cid}/verdikt", json={**body, "preview_command": ""})).json()
    assert s["preview_command"] is None
    bad = [
        ({"preview_command": "npm run dev"}, "{port}"),                     # never learns its port
        ({"preview_command": "serve -l {port}\nrm -rf /"}, "one line"),
        ({"preview_command": "x {port}" + "y" * 2000}, None),                # > 2000 → 413
        ({"preview_ready_path": "health"}, "path"),
        ({"preview_ready_path": "/../etc"}, "path"),
        ({"preview_ready_path": "http://evil/"}, "path"),
        ({"preview_timeout_seconds": 1}, None),
        ({"preview_ttl_minutes": 10000}, None),
        ({"preview_command": CMD, "target_kind": "ios", "target_locator": "com.acme.app"}, "web target"),
    ]
    for extra, needle in bad:
        r = await client.put(f"/api/containers/{cid}/verdikt", json={**body, **extra})
        assert r.status_code in (400, 413, 422), (extra, r.text)
        if needle:
            assert needle in r.text, (extra, r.text)
    # $PORT is fine too
    s = (await client.put(f"/api/containers/{cid}/verdikt", json={**body, "preview_command": "npx serve -l $PORT"})).json()
    assert s["preview_command"] == "npx serve -l $PORT"
    # switching to a non-web target drops a kept command
    s = (await client.put(f"/api/containers/{cid}/verdikt",
                          json={**body, "target_kind": "ios", "target_locator": "com.acme.app"})).json()
    assert s["preview_command"] is None


async def test_preview_settings_need_owner_or_manage_repo(client, container, make_agent, trust_proxy, fake):
    cid = container["id"]
    await _members(client, cid, make_agent)
    body = {"enabled": True, "base_url": fake.base, "verdikt_project": "shop-web",
            "target_locator": "http://127.0.0.1:5173", "preview_command": CMD}
    for who in (VERA, HUBOT, MALLORY):
        assert (await client.put(f"/api/containers/{cid}/verdikt", json=body, headers=who)).status_code == 403
    r = await client.put(f"/api/containers/{cid}/verdikt", json=body, headers=OCTO)
    assert r.status_code == 200 and r.json()["preview_command"] == CMD
    # a viewer reads the setting (like the rest of the Verdikt settings)
    assert (await client.get(f"/api/containers/{cid}/verdikt", headers=VERA)).json()["preview_command"] == CMD


async def test_openapi_documents_the_preview_and_open_routes(client):
    spec = (await client.get("/openapi.json")).json()
    paths = spec["paths"]
    for p, m in [
        ("/api/tasks/{tid}/verdikt/open", "get"),
        ("/api/containers/{cid}/verdikt/open", "get"),
        ("/api/tasks/{tid}/verdikt/runs/{rid}/preview", "get"),
        ("/api/tasks/{tid}/verdikt/runs/{rid}/preview/log", "get"),
        ("/api/containers/{cid}/verdikt/previews/claim", "post"),
        ("/api/verdikt/previews/{pid}/ready", "post"),
        ("/api/verdikt/previews/{pid}/failed", "post"),
        ("/api/verdikt/previews/{pid}/heartbeat", "post"),
        ("/api/verdikt/previews/{pid}/stopped", "post"),
    ]:
        assert m in paths.get(p, {}), p
    props = spec["components"]["schemas"]["VerdiktSettingsBody"]["properties"]
    for k in ("preview_command", "preview_ready_path", "preview_timeout_seconds", "preview_ttl_minutes"):
        assert k in props, k
    assert "{port}" in props["preview_command"]["description"]
    ready = spec["components"]["schemas"]["PreviewReadyBody"]["properties"]["port"]
    assert ready["minimum"] == 1024 and ready["maximum"] == 65535


# ------------------------------------------------------------------ the lifecycle

async def test_preview_lifecycle_hands_verdikt_the_preview_url(client, container, make_agent, make_task,
                                                               work_headers, db, fake):
    cid = container["id"]
    _hid, tid, run = await _previewed(client, container, make_agent, make_task, work_headers, db, fake)
    # recorded, Verdikt not contacted yet
    assert run["status"] == "queued" and run["verdikt_request_id"] is None and run["locator"] == ""
    assert run["preview"]["status"] == "requested" and run["preview"]["branch"] == "orcha/task-pixel-abc"
    assert run["preview"]["open_url"] is None
    assert not [c for c in fake.calls if c[0] == "POST" and c[1] == "/api/requests"]
    # one open run per task still holds
    assert (await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": _hid})).status_code == 409

    claim = await _claim(client, cid)
    assert claim["id"] == run["preview"]["id"] and claim["command"] == CMD
    assert claim["worktree"] == WT and claim["branch"] == "orcha/task-pixel-abc" and claim["base_cwd"] == BASE
    assert claim["ready_path"] == "/" and claim["ttl_minutes"] == 60
    assert await _claim(client, cid) is None  # claimed once
    v = (await client.get(f"/api/tasks/{tid}/verdikt/runs")).json()["runs"][0]
    assert v["preview"]["status"] == "starting"
    # heartbeat while starting: keep going, log tail stored (escapes stripped)
    hb = (await client.post(f"/api/verdikt/previews/{claim['id']}/heartbeat",
                            json={"log_tail": "\x1b[32mServing HTTP\x1b[0m on 127.0.0.1 port 41234"})).json()
    assert hb == {"stop": False, "reason": None}
    log = (await client.get(f"/api/tasks/{tid}/verdikt/runs/{run['id']}/preview/log")).json()
    assert log["lines"] == ["Serving HTTP on 127.0.0.1 port 41234"] and log["status"] == "starting"

    r = await client.post(f"/api/verdikt/previews/{claim['id']}/ready", json={"port": 41234, "log_tail": "GET / 200"})
    assert r.status_code == 200, r.text
    assert r.json()["stop"] is False and r.json()["verdikt_url"] == "http://127.0.0.1:41234/login"
    req = fake.tables["run_requests"][-1]
    assert req["locator"] == "http://127.0.0.1:41234/login"  # the target URL's path, on the preview
    sc = fake.tables["scenarios"][-1]
    assert "Target: web:http://127.0.0.1:41234/login (a preview of branch orcha/task-pixel-abc" in sc["description"]
    v = (await client.get(f"/api/tasks/{tid}/verdikt/runs")).json()["runs"][0]
    assert v["status"] == "queued" and v["verdikt_request_id"] == req["id"] and v["locator"] == req["locator"]
    p = v["preview"]
    assert p["status"] == "ready" and p["port"] == 41234 and p["verdikt_url"] == "http://127.0.0.1:41234/login"
    assert p["open_url"] == f"/api/tasks/{tid}/verdikt/runs/{run['id']}/preview"
    # the browser link: the host the portal was opened on, the preview's port
    r = await client.get(p["open_url"], follow_redirects=False, headers={"Host": "127.0.0.1:8610"})
    assert r.status_code == 302 and r.headers["location"] == "http://127.0.0.1:41234/login"
    # while the Verdikt run is open, the heartbeat keeps it running
    assert (await client.post(f"/api/verdikt/previews/{claim['id']}/heartbeat", json={})).json()["stop"] is False
    # Verdikt finishes → the heartbeat polls it (nobody reads the task) and says stop
    fake.complete(req["id"], "pass", [{"text": 'The login page shows "Wrong password" after a bad password',
                                       "outcome": "pass"}])
    db.execute(f"UPDATE verdikt_runs SET last_polled_at = {ts_ago(60)} WHERE id=%s", (run["id"],))
    hb = (await client.post(f"/api/verdikt/previews/{claim['id']}/heartbeat", json={})).json()
    assert hb["stop"] is True and "completed" in hb["reason"]
    assert db.execute("SELECT status, verdict FROM verdikt_runs WHERE id=%s", (run["id"],))[0] == \
        {"status": "completed", "verdict": "pass"}
    r = await client.post(f"/api/verdikt/previews/{claim['id']}/stopped", json={"reason": hb["reason"], "log_tail": "bye"})
    assert r.json() == {"ok": True, "status": "stopped"}
    v = (await client.get(f"/api/tasks/{tid}/verdikt/runs")).json()["runs"][0]
    assert v["preview"]["status"] == "stopped" and v["preview"]["open_url"] is None
    assert "completed" in v["preview"]["stop_reason"]
    assert (await client.get(f"/api/tasks/{tid}/verdikt/runs/{run['id']}/preview", follow_redirects=False)).status_code == 409
    # the evidence pack carries the preview too
    pk = (await client.get(f"/api/tasks/{tid}/evidence")).json()
    assert pk["verdikt"]["preview"]["status"] == "stopped"
    # the task's status never moved
    assert db.execute("SELECT status FROM tasks WHERE id=%s", (tid,))[0]["status"] == "needs_verification"


async def test_preview_failure_is_reported_in_plain_words(client, container, make_agent, make_task, work_headers, db, fake):
    _hid, tid, run = await _previewed(client, container, make_agent, make_task, work_headers, db, fake)
    claim = await _claim(client, container["id"])
    tail = "\n".join(f"line {i}" for i in range(200)) + "\nnpm ERR! missing script: build"
    r = await client.post(f"/api/verdikt/previews/{claim['id']}/failed",
                          json={"error": "the preview command exited with code 1 before it answered", "log_tail": tail})
    assert r.status_code == 200
    v = (await client.get(f"/api/tasks/{tid}/verdikt/runs")).json()["runs"][0]
    assert v["status"] == "failed"
    assert v["error"] == "Preview failed: the preview command exited with code 1 before it answered"
    assert v["preview"]["status"] == "failed"
    assert v["preview"]["log_tail"].endswith("npm ERR! missing script: build")
    assert len(v["preview"]["log_tail"].split("\n")) == 12  # the run shows the last lines
    log = (await client.get(f"/api/tasks/{tid}/verdikt/runs/{run['id']}/preview/log")).json()
    assert len(log["lines"]) == 80 and log["lines"][-1] == "npm ERR! missing script: build"
    assert not [c for c in fake.calls if c[1] == "/api/requests"]  # Verdikt never got a dead URL
    # a late "ready" for a failed preview is refused and told to stop
    r = (await client.post(f"/api/verdikt/previews/{claim['id']}/ready", json={"port": 41000})).json()
    assert r["stop"] is True
    # Retry is allowed (the run is closed) and asks for a fresh preview
    r2 = (await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": _hid})).json()
    assert r2["preview"]["status"] == "requested" and r2["preview"]["id"] != claim["id"]


async def test_no_notifier_or_silent_notifier_fails_honestly(client, container, make_agent, make_task, work_headers, db, fake):
    _hid, tid, run = await _previewed(client, container, make_agent, make_task, work_headers, db, fake)
    # nobody claims it for > 2 min
    db.execute(f"UPDATE verdikt_previews SET created_at = {ts_ago(180)} WHERE verdikt_run_id=%s", (run["id"],))
    v = (await client.post(f"/api/tasks/{tid}/verdikt/runs/{run['id']}/refresh")).json()
    assert v["status"] == "failed" and v["error"].startswith("Preview failed: no notifier picked up the preview request")
    assert "orcha notifier" in v["error"]
    # a claimed preview whose notifier went quiet past timeout + grace
    r2 = (await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": _hid})).json()
    claim = await _claim(client, container["id"])
    assert claim["id"] == r2["preview"]["id"]
    db.execute(f"UPDATE verdikt_previews SET last_seen_at = {ts_ago(600)} WHERE id=%s", (claim["id"],))
    v = (await client.post(f"/api/tasks/{tid}/verdikt/runs/{r2['id']}/refresh")).json()
    assert v["status"] == "failed" and v["error"] == "Preview failed: the notifier stopped reporting on the preview"


async def test_task_without_a_worktree_or_branch_fails_at_once(client, container, make_agent, make_task, work_headers, db, fake):
    hid, _w, tid = await _nv_task(client, make_agent, make_task, work_headers, db=db)
    db.execute("UPDATE worker_runs SET worktree=NULL, branch=NULL WHERE task_id=%s", (tid,))
    await _settings(client, container["id"], hid, fake.base)
    run = (await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})).json()
    assert run["status"] == "failed" and run["preview"]["status"] == "failed"
    assert "no worktree or branch was recorded" in run["error"]
    assert await _claim(client, container["id"]) is None


async def test_cancel_and_ttl_stop_the_preview(client, container, make_agent, make_task, work_headers, db, fake):
    hid, tid, run = await _previewed(client, container, make_agent, make_task, work_headers, db, fake)
    # cancelled before any notifier claimed it: closed, never handed out
    r = await client.post(f"/api/tasks/{tid}/verdikt/runs/{run['id']}/cancel", json={"actor_agent_id": hid})
    assert r.status_code == 200 and r.json()["preview"]["status"] == "stopped"
    assert await _claim(client, container["id"]) is None
    # cancelled while running: the next heartbeat says stop
    r2 = (await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})).json()
    claim = await _claim(client, container["id"])
    await client.post(f"/api/verdikt/previews/{claim['id']}/ready", json={"port": 41235})
    await client.post(f"/api/tasks/{tid}/verdikt/runs/{r2['id']}/cancel", json={"actor_agent_id": hid})
    hb = (await client.post(f"/api/verdikt/previews/{claim['id']}/heartbeat", json={})).json()
    assert hb["stop"] is True and "cancelled" in hb["reason"]
    # TTL: an open run whose preview outlived its time limit is told to stop
    r3 = (await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})).json()
    c3 = await _claim(client, container["id"])
    await client.post(f"/api/verdikt/previews/{c3['id']}/ready", json={"port": 41236})
    db.execute(f"UPDATE verdikt_previews SET claimed_at = {ts_ago(3660)} WHERE id=%s", (c3["id"],))
    hb = (await client.post(f"/api/verdikt/previews/{c3['id']}/heartbeat", json={})).json()
    assert hb["stop"] is True and "time limit (60 min)" in hb["reason"]
    # the preview stopping on its own while Verdikt still tests is written on the run
    await client.post(f"/api/verdikt/previews/{c3['id']}/stopped",
                      json={"reason": "the preview process exited with code 137", "exited": True})
    v = (await client.get(f"/api/tasks/{tid}/verdikt/runs")).json()["runs"][0]
    assert v["id"] == r3["id"] and "the preview stopped while Verdikt was testing" in (v["error"] or "")


async def test_a_typed_url_or_no_command_skips_the_preview(client, container, make_agent, make_task, work_headers, db, fake):
    hid, _w, tid = await _task_with_worktree(client, make_agent, make_task, work_headers, db)
    await _settings(client, container["id"], hid, fake.base)
    run = (await client.post(f"/api/tasks/{tid}/verdikt/runs",
                             json={"actor_agent_id": hid, "locator": "http://127.0.0.1:9999/x"})).json()
    assert run["preview"] is None and run["locator"] == "http://127.0.0.1:9999/x" and run["verdikt_request_id"]
    await client.post(f"/api/tasks/{tid}/verdikt/runs/{run['id']}/cancel", json={"actor_agent_id": hid})
    await _settings(client, container["id"], hid, fake.base, preview_command="")
    run = (await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})).json()
    # exactly as before: the configured URL, straight to Verdikt
    assert run["preview"] is None and run["locator"] == "http://127.0.0.1:5173/login" and run["verdikt_request_id"]
    assert fake.tables["run_requests"][-1]["locator"] == "http://127.0.0.1:5173/login"


async def test_auto_trigger_requests_a_preview(client, container, make_agent, make_task, work_headers, db, fake):
    hid, _w, tid = await _task_with_worktree(client, make_agent, make_task, work_headers, db)
    await _settings(client, container["id"], hid, fake.base, trigger_mode="always")
    from portal_backend import verdikt_integration as vi

    pack = (await client.get(f"/api/tasks/{tid}/evidence")).json()
    vi.maybe_auto_trigger(tid, pack)
    runs = (await client.get(f"/api/tasks/{tid}/verdikt/runs")).json()["runs"]
    assert runs and runs[0]["trigger"] == "auto" and runs[0]["preview"]["status"] == "requested"


async def test_the_notifier_lane_is_closed_to_people_without_the_grant(client, container, make_agent, make_task,
                                                                        trust_proxy, db, fake):
    cid = container["id"]
    await _members(client, cid, make_agent)
    await make_agent("Pixel", "frontend")
    task = await make_task("Wishlist", "- The heart icon saves the item")
    tid = task["id"]
    db.execute("""INSERT INTO worker_runs (agent_id, task_id, wake_kind, status, exit_code, started_at, worktree, branch, base_cwd)
                  SELECT id, %s, 'headless', 'exited', 0, now(), %s, 'orcha/x', %s FROM agents
                   WHERE container_id=%s AND kind='ai' LIMIT 1""", (tid, WT, BASE, cid))
    body = {"enabled": True, "base_url": fake.base, "verdikt_project": "shop-web",
            "target_locator": "http://127.0.0.1:5173", "preview_command": CMD}
    assert (await client.put(f"/api/containers/{cid}/verdikt", json=body, headers=OCTO)).status_code == 200
    run = (await client.post(f"/api/tasks/{tid}/verdikt/runs", json={}, headers=HUBOT)).json()
    pid = run["preview"]["id"]
    assert run["preview"]["status"] == "requested"
    for who in (VERA, HUBOT, MALLORY):
        assert (await client.post(f"/api/containers/{cid}/verdikt/previews/claim", json={}, headers=who)).status_code == 403
        assert (await client.post(f"/api/verdikt/previews/{pid}/ready", json={"port": 41000}, headers=who)).status_code == 403
        assert (await client.post(f"/api/verdikt/previews/{pid}/failed", json={"error": "x"}, headers=who)).status_code == 403
        assert (await client.post(f"/api/verdikt/previews/{pid}/heartbeat", json={}, headers=who)).status_code == 403
    # the viewer reads the preview state + log like the evidence; a stranger doesn't
    assert (await client.get(f"/api/tasks/{tid}/verdikt/runs/{run['id']}/preview/log", headers=VERA)).status_code == 200
    assert (await client.get(f"/api/tasks/{tid}/verdikt/runs/{run['id']}/preview/log", headers=MALLORY)).status_code == 403
    # the owner (every grant) and the header-less daemon lane may claim
    assert (await client.post(f"/api/containers/{cid}/verdikt/previews/claim", json={}, headers=OCTO)).json()["preview"]["id"] == pid


async def test_ready_rejects_a_bad_port_and_unknown_ids(client, container, make_agent, make_task, work_headers, db, fake):
    await _previewed(client, container, make_agent, make_task, work_headers, db, fake)
    claim = await _claim(client, container["id"])
    for port in (0, 80, 1023, 65536, "41000; rm -rf /"):
        r = await client.post(f"/api/verdikt/previews/{claim['id']}/ready", json={"port": port})
        assert r.status_code == 422, port
    assert (await client.post("/api/verdikt/previews/not-a-uuid/ready", json={"port": 41000})).status_code == 400
    assert (await client.post("/api/verdikt/previews/00000000-0000-4000-8000-000000000000/heartbeat",
                              json={})).status_code == 404


# ------------------------------------------------------------------ Open in Verdikt

async def test_open_in_verdikt_goes_to_the_run_then_falls_back_to_the_project(client, container, make_agent, make_task,
                                                                               work_headers, db, fake):
    cid = container["id"]
    hid, _w, tid = await _nv_task(client, make_agent, make_task, work_headers, db=db)
    # not set up, nothing ran → 404
    assert (await client.get(f"/api/tasks/{tid}/verdikt/open", follow_redirects=False)).status_code == 404
    assert (await client.get(f"/api/containers/{cid}/verdikt/open", follow_redirects=False)).status_code == 404
    body = {"actor_agent_id": hid, "enabled": True, "base_url": fake.base, "verdikt_project": "shop-web",
            "target_locator": "http://127.0.0.1:5173/login"}
    assert (await client.put(f"/api/containers/{cid}/verdikt", json=body)).status_code == 200
    # before any run: the project page
    r = await client.get(f"/api/tasks/{tid}/verdikt/open", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == f"{fake.base}/projects/shop-web"
    assert r.headers["cache-control"] == "no-store"
    r = await client.get(f"/api/containers/{cid}/verdikt/open", follow_redirects=False)
    assert r.headers["location"] == f"{fake.base}/projects/shop-web"
    # queued, Verdikt hasn't started a run yet: still the project
    run = (await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})).json()
    r = await client.get(f"/api/tasks/{tid}/verdikt/open", follow_redirects=False)
    assert r.headers["location"] == f"{fake.base}/projects/shop-web"
    # a run exists: its page, on the task's scenario
    vrid = fake.complete(fake.tables["run_requests"][-1]["id"], "pass", [])
    await client.post(f"/api/tasks/{tid}/verdikt/runs/{run['id']}/refresh")
    sid = fake.tables["scenarios"][-1]["id"]
    r = await client.get(f"/api/tasks/{tid}/verdikt/open", follow_redirects=False)
    assert r.headers["location"] == f"{fake.base}/runs/{vrid}?scenario={sid}"
    r = await client.get(f"/api/tasks/{tid}/verdikt/open?run={run['id']}", follow_redirects=False)
    assert r.headers["location"] == f"{fake.base}/runs/{vrid}?scenario={sid}"
    # Docker: the container-only host becomes the host the browser used, Verdikt's port kept
    db.execute("UPDATE verdikt_runs SET base_url='http://host.docker.internal:31970' WHERE id=%s", (run["id"],))
    db.execute("UPDATE container_verdikt_settings SET base_url='http://host.docker.internal:31970' WHERE container_id=%s", (cid,))
    r = await client.get(f"/api/tasks/{tid}/verdikt/open", follow_redirects=False, headers={"Host": "127.0.0.1:8610"})
    assert r.headers["location"] == f"http://127.0.0.1:31970/runs/{vrid}?scenario={sid}"
    r = await client.get(f"/api/containers/{cid}/verdikt/open", follow_redirects=False,
                         headers={"X-Forwarded-Host": "mymac.local:443"})
    assert r.headers["location"] == "http://mymac.local:31970/projects/shop-web"
    # bad / foreign run ids
    assert (await client.get(f"/api/tasks/{tid}/verdikt/open?run=nope", follow_redirects=False)).status_code == 400
    assert (await client.get(f"/api/tasks/{tid}/verdikt/open?run=00000000-0000-4000-8000-000000000000",
                             follow_redirects=False)).status_code == 404
    assert (await client.get("/api/tasks/00000000-0000-4000-8000-000000000000/verdikt/open",
                             follow_redirects=False)).status_code == 404
    # no project slug → Verdikt's home page
    db.execute("UPDATE container_verdikt_settings SET verdikt_project=NULL WHERE container_id=%s", (cid,))
    r = await client.get(f"/api/containers/{cid}/verdikt/open", follow_redirects=False, headers={"Host": "127.0.0.1:8610"})
    assert r.headers["location"] == "http://127.0.0.1:31970/"


async def test_open_in_verdikt_uses_the_read_permission(client, container, make_agent, make_task, trust_proxy, fake):
    cid = container["id"]
    await _members(client, cid, make_agent)
    task = await make_task("t", "- x")
    body = {"enabled": True, "base_url": fake.base, "verdikt_project": "shop-web", "target_locator": "http://127.0.0.1:5173"}
    assert (await client.put(f"/api/containers/{cid}/verdikt", json=body, headers=OCTO)).status_code == 200
    for url in (f"/api/tasks/{task['id']}/verdikt/open", f"/api/containers/{cid}/verdikt/open"):
        assert (await client.get(url, headers=VERA, follow_redirects=False)).status_code == 302
        assert (await client.get(url, headers=MALLORY, follow_redirects=False)).status_code == 403
