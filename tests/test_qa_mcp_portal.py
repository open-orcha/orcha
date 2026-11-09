"""The Orcha QA MCP tools end to end against the real portal routes (in process, the test
database) with a fake device: start a session for a task, act, walk a queued flow to a pass,
capture a finding, end the session; the drafted scenario, its frame evidence, the map and the
task's QA section all come back from the portal. Guards the tool server's bodies against the
routes' request models (`qa_routes.py`)."""

from __future__ import annotations

import pytest

import main
from orcha_cli.qa.mcp_server import QATools
from orcha_cli.qa.portal import PortalClient, PortalError, _detail
from test_qa_mcp_fakes import FakeDevice, Shot, opener, shot


def jpeg(width=390, height=844):
    sof = (b"\xff\xc0\x00\x11\x08" + height.to_bytes(2, "big") + width.to_bytes(2, "big")
           + b"\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01")
    return b"\xff\xd8" + sof + b"\xff\xd9"


class JpegShot(Shot):
    @property
    def jpeg(self) -> bytes:
        return jpeg()


def jshot(name, *labels):
    s = shot(name, *labels)
    return JpegShot(s.name, s.elements)


class AppPortal(PortalClient):
    """The real client with its transport swapped for a synchronous ASGI client."""

    def __init__(self, tc, cid, aid):
        super().__init__("http://testserver", cid, aid)
        self.tc = tc

    def _request(self, method, path, body=None, *, query=None, raw=None, content_type="application/json", headers=None):
        q = {k: v for k, v in (query or {}).items() if v not in (None, "")}
        if raw is not None:
            r = self.tc.request(method, path, params=q, content=raw, headers={"Content-Type": content_type})
        else:
            r = self.tc.request(method, path, params=q, json=body)
        if r.status_code >= 400:
            raise PortalError(f"HTTP {r.status_code} on {method} {path}: {_detail(r.content)}", r.status_code)
        return r.json() if r.content else None


class Ident:
    ok = True
    problems: list = []

    def __init__(self, cid, aid):
        self.api_base, self.container_id, self.agent_id = "http://testserver", cid, aid


@pytest.fixture
def attachments(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "ATTACHMENTS_DIR", tmp_path)
    return tmp_path


async def test_tools_against_the_real_routes(client, container, make_agent, make_task, attachments):
    from fastapi.testclient import TestClient

    cid = container["id"]
    human = (await make_agent("Hussein", "owner", kind="human"))["agent_id"]
    bot = (await make_agent("qa-bot"))["agent_id"]
    task = await make_task("Explore feeding", "Findings filed")
    r = await client.put(f"/api/containers/{cid}/qa/targets/ios",
                         json={"app_id": "com.example.snug", "device_name": "iPhone 17 Pro", "actor_agent_id": human})
    assert r.status_code == 200, r.text

    home = jshot("home", ("Heading", "Today"), ("StaticText", "No feeds yet"), ("Button", "Feed"), ("Tab", "Today"))
    feed = jshot("feed", ("Heading", "New feed"), ("Button", "Bottle"), ("TextField", "Amount (ml)"), ("Button", "Save feed"))
    typed = jshot("typed", ("Heading", "New feed"), ("Button", "Bottle"), ("TextField", "120"), ("Button", "Save feed"))
    saved = jshot("saved", ("Heading", "Today"), ("StaticText", "Bottle feed"), ("Button", "Feed"), ("Tab", "Today"))
    device = FakeDevice([home, feed, typed, saved])
    seen: list = []
    with TestClient(main.app) as tc:
        tools = QATools(identity=Ident(cid, bot), portal=AppPortal(tc, cid, bot), device_opener=opener(device, seen))
        out = await tools.start_session("ios", "explore", minutes=0, task_id=task["id"], goal="feeding")
        assert out.startswith("session started"), out
        assert seen == [("ios", "com.example.snug", "iPhone 17 Pro", {"any_device": True})]  # the target's device is a preference
        assert "map: Today" in out
        sid = tools.live.id

        assert (await tools.submit_briefing({"app_summary": "A baby log.", "charter": [
            {"title": "Feeds"}, {"title": "Sleep"}, {"title": "Diapers"}]})).startswith("briefing stored")
        assert (await tools.post_plan([{"name": "Log a bottle feed", "criticality": "high", "persona": "a new parent",
                                        "steps": ["Open New feed", "Enter 120 ml", "Save the feed"]}])).startswith("flow queue: 1")
        mission = await tools.next_flow()
        assert mission.startswith("walk ") and "Log a bottle feed" in mission, mission
        wid = tools.live.walk.id

        assert "map: New feed" in await tools.tap("Feed")
        assert (await tools.walk_step(wid, 1, True, "The New feed form opens", checked=["New feed"])).startswith("step 1"), "walk_step 1"
        await tools.type_text("Amount (ml)", "120")
        assert (await tools.walk_step(wid, 2, True, "Amount reads 120", expected='The amount field holds "120"')).startswith("step 2")
        await tools.tap("Save feed")
        assert (await tools.walk_step(wid, 3, True, "Back on Today", checked=["Bottle feed"],
                                      expected='Today lists the "Bottle feed"')).startswith("step 3")
        ended = await tools.end_walk(wid, "passed")
        assert "ended: passed" in ended and "draft scenario created: Log a bottle feed" in ended, ended

        found = await tools.capture_evidence("minor", "Feed time shows UTC", "local time", "UTC time")
        assert found.startswith("finding "), found
        assert (await tools.charter_update("m1", "covered", note="logged a feed")).startswith("mission m1: covered")
        done = await tools.end_session("Walked the feeding flow; one finding.")
        assert done.startswith(f"session {sid} ended"), done

    r = await client.get(f"/api/qa/sessions/{sid}")
    d = r.json()
    assert d["status"] == "done" and "Walked the feeding flow" in d["report_md"]
    assert d["steps_count"] == tools_steps(d) and d["steps_count"] >= 9
    assert [w["status"] for w in d["walks"]] == ["passed"]
    r = await client.get(f"/api/containers/{cid}/qa/scenarios", params={"platform": "ios"})
    [scen] = r.json()["scenarios"]
    assert scen["status"] == "draft" and scen["source"] == "walk" and len(scen["criteria"]) == 3
    r = await client.get(f"/api/qa/scenarios/{scen['id']}")
    detail = r.json()
    assert len(detail["evidence"]) == 3 and all(e["frame_id"] for e in detail["evidence"])
    r = await client.get(f"/api/containers/{cid}/qa/map", params={"platform": "ios"})
    labels = {n["label"] for n in r.json()["nodes"] if n["kind"] == "screen"}
    assert {"Today", "New feed"} <= labels
    r = await client.get(f"/api/tasks/{task['id']}/qa")
    tq = r.json()
    assert len(tq["sessions"]) == 1 and len(tq["findings"]) == 1


def tools_steps(d):
    return d["steps_count"]
