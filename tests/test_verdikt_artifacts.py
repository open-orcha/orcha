"""Verdikt screenshots / recording / report reach the BROWSER through the portal.

Regression: the evidence pack handed the browser Verdikt's server-side URLs
(`{base}/api/artifacts/qa-runs/…`, `{base}/runs/{id}`). With the portal in Docker the base is
`http://host.docker.internal:31970`, which a browser can't resolve — every screenshot was
broken. Now:
  * screenshots + the recording stream through
    `GET /api/tasks/{tid}/verdikt/runs/{rid}/artifact?path=…` (members read; strict allow-list:
    only artifacts THIS run recorded, inside its own Verdikt run folder, image/video only;
    Range passed through; our content type, never Verdikt's)
  * the report opens through `GET …/runs/{rid}/report`, a 302 that swaps a container-only
    Verdikt host for the host the portal was opened on.
Real HTTP to the fake Verdikt (tests/fake_verdikt.py)."""
import json

import pytest

from fake_verdikt import JPG_BYTES, PNG_BYTES, WEBM_BYTES, FakeVerdikt
from portal_backend.verdikt_client import (artifact_path_from_url, browser_base, safe_artifact_path)
from test_evidence_verdikt import HUBOT, MALLORY, OCTO, VERA, _members, _nv_task, _settings

RID = "fa4ee56e-0f69-4e81-9169-cdc79d142ebd"
_CRIT = [{"text": 'The login page shows "Wrong password" after a bad password', "outcome": "pass"},
         {"text": "The error text is red", "outcome": "fail", "actual": "black"}]


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


async def _completed(client, container, make_agent, make_task, work_headers, db, fake, *, again=None, **complete_kw):
    """A task at needs_verification with a completed Verdikt run → (tid, run, verdikt run id).
    `again=(hid, tid)` runs the same task once more instead of creating a new one."""
    if again:
        hid, tid = again
    else:
        hid, _w, tid = await _nv_task(client, make_agent, make_task, work_headers, db=db)
        await _settings(client, container["id"], hid, fake.base)
    run = (await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})).json()
    kw = {"reason": "error text colour", "evidence": [("error text colour", "major"), ("login form", "info")]}
    kw.update(complete_kw)
    vrid = fake.complete(fake.tables["run_requests"][-1]["id"], "fail", _CRIT, **kw)
    v = (await client.post(f"/api/tasks/{tid}/verdikt/runs/{run['id']}/refresh")).json()
    assert v["status"] == "completed", v
    return tid, v, vrid


# ------------------------------------------------------------------ pure helpers

def test_safe_artifact_path_allow_list():
    ok = [f"{RID}/evidence/001.png", f"{RID}/evidence/001-major.png", f"{RID}/frames/0003.jpg",
          f"{RID}/run.webm", f"{RID}/recording.mp4", f"{RID}/shot.JPEG", f"{RID}/a.webp"]
    for p in ok:
        assert safe_artifact_path(p, RID) == p, p
    bad = [
        None, "", RID, f"/{RID}/evidence/001.png", f"{RID}/../x/evidence/001.png", f"{RID}/evidence/../../etc/passwd.png",
        f"{RID}/./evidence/001.png", f"{RID}//001.png", f"{RID}/evidence/..png", f"{RID}/evidence/a..b.png",
        f"{RID}\\evidence\\001.png", f"{RID}/evidence/%2e%2e/001.png", f"{RID}/evidence/001.png?x=1",
        f"{RID}/evidence/001.png#f", f"{RID}/trace.json", f"{RID}/index.html", f"{RID}/evidence/001.svg",
        f"{RID}/evidence/001", "c46bab00-a545-434a-b8f8-2264e598cf97/evidence/001.png",  # another run
        f"http://evil.example/{RID}/a.png", f"{RID}/.hidden.png", f"{RID}/evidence/ 001.png",
        f"{RID}/" + "a" * 500 + ".png",
    ]
    for p in bad:
        assert safe_artifact_path(p, RID) is None, p
    assert safe_artifact_path(f"../evidence/001.png", "..") is None
    assert safe_artifact_path(f"{RID}/evidence/001.png", None) is None


def test_artifact_path_from_stored_url():
    base = "http://host.docker.internal:31970"
    assert artifact_path_from_url(base, f"{base}/api/artifacts/qa-runs/{RID}/evidence/001.png") == f"{RID}/evidence/001.png"
    assert artifact_path_from_url(base + "/", f"{base}/api/artifacts/qa-runs/{RID}/run%20a.webm") == f"{RID}/run a.webm"
    assert artifact_path_from_url(base, f"http://other:1/api/artifacts/qa-runs/{RID}/a.png") is None
    assert artifact_path_from_url(base, f"{base}/runs/{RID}") is None
    assert artifact_path_from_url(None, f"{base}/api/artifacts/qa-runs/x.png") is None


def test_browser_base_rewrites_only_container_hosts():
    assert browser_base("http://host.docker.internal:31970", "127.0.0.1") == "http://127.0.0.1:31970"
    assert browser_base("http://host.docker.internal:31970/", "mymac.local") == "http://mymac.local:31970"
    assert browser_base("https://gateway.docker.internal", "10.0.0.5") == "https://10.0.0.5"
    assert browser_base("http://172.17.0.1:3100", "[::1]") == "http://[::1]:3100"
    assert browser_base("http://host.docker.internal:31970", None) == "http://localhost:31970"
    assert browser_base("http://host.docker.internal:31970", "evil.com/path?x") == "http://localhost:31970"
    # a Verdikt the browser can already reach is left alone
    assert browser_base("http://127.0.0.1:31100", "mymac.local") == "http://127.0.0.1:31100"
    assert browser_base("https://verdikt.acme.dev", "portal.acme.dev") == "https://verdikt.acme.dev"


# ------------------------------------------------------------------ the proxy

async def test_screenshots_and_recording_stream_through_the_portal(client, container, make_agent, make_task,
                                                                   work_headers, db, fake):
    tid, v, vrid = await _completed(client, container, make_agent, make_task, work_headers, db, fake)
    assert len(v["screenshots"]) == 2
    for s in v["screenshots"]:
        assert s["url"].startswith(f"/api/tasks/{tid}/verdikt/runs/{v['id']}/artifact?path={vrid}/evidence/")
        r = await client.get(s["url"])
        assert r.status_code == 200, r.text
        assert r.content == PNG_BYTES
        assert r.headers["content-type"] == "image/png"
        assert r.headers["x-content-type-options"] == "nosniff"
        assert "sandbox" in r.headers["content-security-policy"]
    # the recording, including a seek (Range → 206 passed through)
    r = await client.get(v["video_url"])
    assert r.status_code == 200 and r.content == WEBM_BYTES and r.headers["content-type"] == "video/webm"
    r = await client.get(v["video_url"], headers={"Range": "bytes=100-199"})
    assert r.status_code == 206, r.text
    assert r.content == WEBM_BYTES[100:200]
    assert r.headers["content-range"] == f"bytes 100-199/{len(WEBM_BYTES)}"
    assert fake.artifact_requests[-1] == {"path": f"{vrid}/run.webm", "range": "bytes=100-199"}
    # a malformed Range is not forwarded
    r = await client.get(v["video_url"], headers={"Range": "bytes=0-1, 5-9\r\nX: y"})
    assert r.status_code == 200 and fake.artifact_requests[-1]["range"] is None
    # whatever content type Verdikt claims, the portal serves its own
    fake.artifact_content_type = "text/html"
    r = await client.get(v["screenshots"][0]["url"])
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"


async def test_frames_fallback_is_proxied(client, container, make_agent, make_task, work_headers, db, fake):
    tid, v, vrid = await _completed(client, container, make_agent, make_task, work_headers, db, fake,
                                    evidence=(), video=False, frames=[3, 4])
    assert v["video_url"] is None
    assert [s["kind"] for s in v["screenshots"]] == ["frame", "frame"]
    r = await client.get(v["screenshots"][0]["url"])
    assert r.status_code == 200 and r.content == JPG_BYTES and r.headers["content-type"] == "image/jpeg"


async def test_proxy_allow_list_blocks_everything_else(client, container, make_agent, make_task, work_headers, db, fake):
    tid, v, vrid = await _completed(client, container, make_agent, make_task, work_headers, db, fake)
    hid = db.execute("SELECT triggered_by FROM verdikt_runs WHERE id=%s", (v["id"],))[0]["triggered_by"]
    # a second run: its artifacts must not be readable through the first run
    _tid, v2, vrid2 = await _completed(client, container, make_agent, make_task, work_headers, db, fake,
                                       again=(str(hid), tid))
    other_task = (await make_task("Another task", "- anything"))["id"]
    base = f"/api/tasks/{tid}/verdikt/runs/{v['id']}/artifact"
    before = len(fake.artifact_requests)
    for path in [
        f"{vrid}/trace.json",                      # exists in Verdikt's run folder, never surfaced
        f"{vrid}/evidence/009-major.png",          # safe-shaped but not recorded for this run
        f"{vrid2}/evidence/001-major.png",         # another run's (real) screenshot
        f"{vrid}/../{vrid2}/evidence/001-major.png",
        f"../../../../etc/passwd",
        "/etc/passwd",
        f"{vrid}/evidence/%2e%2e/001-major.png",
        f"{vrid}/evidence/001-major.png?x=1",
        f"http://127.0.0.1:1/{vrid}/evidence/001-major.png",
        f"{vrid}\\evidence\\001-major.png",
    ]:
        r = await client.get(base, params={"path": path})
        assert r.status_code == 404, (path, r.status_code, r.text)
    assert len(fake.artifact_requests) == before, "a rejected path must never reach Verdikt"
    # the other run's screenshot through its OWN run works; through another task it doesn't
    assert (await client.get(v2["screenshots"][0]["url"])).status_code == 200
    r = await client.get(f"/api/tasks/{other_task}/verdikt/runs/{v2['id']}/artifact",
                         params={"path": f"{vrid2}/evidence/001-major.png"})
    assert r.status_code == 404
    assert len(fake.artifact_requests) == before + 1
    assert (await client.get(base)).status_code == 422  # path is required
    assert (await client.get(f"/api/tasks/{tid}/verdikt/runs/not-a-uuid/artifact",
                             params={"path": f"{vrid}/run.webm"})).status_code == 400


async def test_proxy_honest_when_verdikt_is_gone(client, container, make_agent, make_task, work_headers, db, fake):
    tid, v, vrid = await _completed(client, container, make_agent, make_task, work_headers, db, fake)
    fake.files.pop(f"{vrid}/evidence/001-major.png")
    r = await client.get(v["screenshots"][0]["url"])
    assert r.status_code == 404 and "no longer" in r.json()["detail"]
    fake.stop()
    r = await client.get(v["screenshots"][1]["url"])
    assert r.status_code == 502 and "not reachable" in r.json()["detail"]


async def test_rows_stored_by_an_older_build_still_work(client, container, make_agent, make_task, work_headers, db, fake):
    """Rows written before this fix stored only the server-side URL (no `path`)."""
    tid, v, vrid = await _completed(client, container, make_agent, make_task, work_headers, db, fake)
    legacy = [{"url": f"{fake.base}/api/artifacts/qa-runs/{vrid}/evidence/001-major.png", "label": "old",
               "kind": "evidence", "seq": 1}]
    db.execute("UPDATE verdikt_runs SET screenshots=%s::jsonb WHERE id=%s", (json.dumps(legacy), v["id"]))
    runs = (await client.get(f"/api/tasks/{tid}/verdikt/runs")).json()["runs"]
    s = next(r for r in runs if r["id"] == v["id"])["screenshots"]
    assert s[0]["url"] == f"/api/tasks/{tid}/verdikt/runs/{v['id']}/artifact?path={vrid}/evidence/001-major.png"
    assert (await client.get(s[0]["url"])).content == PNG_BYTES
    # a stored URL that isn't a Verdikt artifact of this run is dropped, never passed through
    db.execute("UPDATE verdikt_runs SET screenshots=%s::jsonb WHERE id=%s",
               (json.dumps([{"url": "http://evil.example/x.png", "label": "x", "kind": "evidence"}]), v["id"]))
    p = (await client.get(f"/api/tasks/{tid}/evidence")).json()
    assert p["verdikt"]["screenshots"] == []


async def test_proxy_and_report_use_the_evidence_read_permission(client, container, make_agent, make_task, trust_proxy,
                                                                 fake):
    cid = container["id"]
    await _members(client, cid, make_agent)
    task = await make_task("Wishlist: save items for later", "- The heart icon saves the item")
    tid = task["id"]
    body = {"enabled": True, "base_url": fake.base, "verdikt_project": "shop-web",
            "target_locator": "http://127.0.0.1:5173"}
    assert (await client.put(f"/api/containers/{cid}/verdikt", json=body, headers=OCTO)).status_code == 200
    run = (await client.post(f"/api/tasks/{tid}/verdikt/runs", json={}, headers=HUBOT)).json()
    vrid = fake.complete(fake.tables["run_requests"][-1]["id"], "pass",
                         [{"text": "The heart icon saves the item", "outcome": "pass"}],
                         evidence=[("saved", "info")])
    v = (await client.post(f"/api/tasks/{tid}/verdikt/runs/{run['id']}/refresh", headers=VERA)).json()
    shot, report = v["screenshots"][0]["url"], v["report_url"]
    # a viewer reads evidence, so it reads the screenshots and opens the report
    assert (await client.get(shot, headers=VERA)).status_code == 200
    assert (await client.get(report, headers=VERA, follow_redirects=False)).status_code == 302
    # a stranger gets 403 on both — and Verdikt is never asked
    before = len(fake.artifact_requests)
    assert (await client.get(shot, headers=MALLORY)).status_code == 403
    assert (await client.get(report, headers=MALLORY, follow_redirects=False)).status_code == 403
    assert len(fake.artifact_requests) == before
    assert vrid in shot


# ------------------------------------------------------------------ the report redirect

async def test_report_redirect_targets_a_browser_reachable_host(client, container, make_agent, make_task,
                                                                work_headers, db, fake):
    tid, v, vrid = await _completed(client, container, make_agent, make_task, work_headers, db, fake)
    assert v["report_url"] == f"/api/tasks/{tid}/verdikt/runs/{v['id']}/report"
    r = await client.get(v["report_url"], follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == f"{fake.base}/runs/{vrid}"
    assert r.headers["cache-control"] == "no-store"
    # the portal in Docker reaches Verdikt at host.docker.internal: the browser is sent to the
    # host it opened the portal on, same Verdikt port
    db.execute("UPDATE verdikt_runs SET base_url='http://host.docker.internal:31970' WHERE id=%s", (v["id"],))
    r = await client.get(v["report_url"], follow_redirects=False, headers={"Host": "127.0.0.1:8610"})
    assert r.headers["location"] == f"http://127.0.0.1:31970/runs/{vrid}"
    r = await client.get(v["report_url"], follow_redirects=False, headers={"X-Forwarded-Host": "mymac.local:443"})
    assert r.headers["location"] == f"http://mymac.local:31970/runs/{vrid}"
    # screenshots recorded with a `path` keep working after the base changes (served from the
    # run's stored base) — and never expose host.docker.internal to the browser
    p = (await client.get(f"/api/tasks/{tid}/evidence")).json()
    assert "host.docker.internal" not in json.dumps(p["verdikt"]["screenshots"]) + str(p["verdikt"]["report_url"])


async def test_report_404_before_verdikt_started_a_run(client, container, make_agent, make_task, work_headers, db, fake):
    hid, _w, tid = await _nv_task(client, make_agent, make_task, work_headers, db=db)
    await _settings(client, container["id"], hid, fake.base)
    run = (await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})).json()
    assert run["report_url"] is None and run["screenshots"] == [] and run["video_url"] is None
    r = await client.get(f"/api/tasks/{tid}/verdikt/runs/{run['id']}/report", follow_redirects=False)
    assert r.status_code == 404
