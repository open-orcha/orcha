"""The Orcha QA MCP tools on the web, end to end: a real `WebSession` (headless Chromium) on a
static site served by `http.server`, through the real portal routes (the test database). Start a
web session from the web target, click through to an order page, see the route observed into the
map, get refused off-origin navigation, walk a flow to a passed draft, end the session.

Skipped when Playwright or its Chromium is not installed (`playwright install chromium`)."""

from __future__ import annotations

import functools
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import pytest

import main
from orcha_cli.qa.mcp_server import QATools
from test_qa_mcp_portal import AppPortal, Ident

pytest.importorskip("playwright")

PAGES = {
    "index.html": """<!doctype html><html><head><title>Corner Shop</title></head><body>
<h1>Corner Shop</h1><p>Fresh bread every morning</p>
<a href="/orders/8812.html">Your order</a></body></html>""",
    "orders/8812.html": """<!doctype html><html><head><title>Order</title></head><body>
<h1>Order 8812</h1><p>Sourdough loaf</p><p>Status: Shipped</p>
<button onclick="document.getElementById('msg').textContent='Thanks for confirming'">Confirm delivery</button>
<p id="msg"></p><a href="/index.html">Back to the shop</a></body></html>""",
}


def _chromium_ready() -> bool:
    from orcha_cli.qa import cli

    return bool(cli.chromium_status()["ok"])


@pytest.fixture
def site(tmp_path):
    for rel, html in PAGES.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(html)

    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(tmp_path)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


@pytest.fixture
def attachments(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "ATTACHMENTS_DIR", tmp_path / "attachments")
    return tmp_path


async def test_web_session_end_to_end(client, container, make_agent, make_task, attachments, site):
    if not _chromium_ready():
        pytest.skip("Chromium for Playwright is not installed (playwright install chromium)")
    from fastapi.testclient import TestClient

    cid = container["id"]
    human = (await make_agent("Hussein", "owner", kind="human"))["agent_id"]
    bot = (await make_agent("qa-bot"))["agent_id"]
    task = await make_task("Explore the shop", "Findings filed")
    r = await client.put(f"/api/containers/{cid}/qa/targets/web",
                         json={"app_id": f"{site}/index.html", "device_name": "desktop",
                               "notes": "Allowed: https://pay.example.com", "actor_agent_id": human})
    assert r.status_code == 200, r.text

    with TestClient(main.app) as tc:
        tools = QATools(identity=Ident(cid, bot), portal=AppPortal(tc, cid, bot))
        try:
            out = await tools.start_session("web", "explore", minutes=0, task_id=task["id"])
            assert out.startswith("session started"), out
            assert "in Chromium (desktop viewport)" in out and "https://pay.example.com" in out
            assert "Corner Shop" in out and "map: " in out
            sid = tools.live.id

            blocked = await tools.open_url("https://evil.example.net/")
            assert blocked.startswith("blocked:"), blocked

            assert (await tools.post_plan([{"name": "Confirm a delivery", "criticality": "high",
                                            "steps": ["Open your order", "Confirm the delivery"]}])).startswith("flow queue: 1")
            mission = await tools.next_flow()
            assert mission.startswith("walk "), mission
            wid = tools.live.walk.id

            opened = await tools.tap("Your order")
            assert "Order 8812" in opened, opened
            assert (await tools.walk_step(wid, 1, True, "The order page opens", checked=["Order 8812"])).startswith("step 1")
            confirmed = await tools.tap("Confirm delivery")
            assert "Thanks for confirming" in confirmed, confirmed
            assert (await tools.walk_step(wid, 2, True, "A thank-you line shows", checked=["Thanks for confirming"],
                                          expected='The order page says "Thanks for confirming"')).startswith("step 2")
            ended = await tools.end_walk(wid, "passed")
            assert "draft scenario created: Confirm a delivery" in ended, ended

            back = await tools.press("back")
            assert not back.startswith("error"), back
            done = await tools.end_session("Walked the order flow on the web.")
            assert done.startswith(f"session {sid} ended"), done
        finally:
            await tools.shutdown()

    r = await client.get(f"/api/qa/sessions/{sid}")
    d = r.json()
    assert d["status"] == "done" and d["steps_count"] >= 6
    r = await client.get(f"/api/containers/{cid}/qa/map", params={"platform": "web"})
    nodes = [n for n in r.json()["nodes"] if n["kind"] == "screen"]
    keys = {n["key"]: n["state"] for n in nodes}
    assert keys.get("/index.html") == "seen" and keys.get("/orders/8812.html") == "seen", keys
    r = await client.get(f"/api/containers/{cid}/qa/scenarios", params={"platform": "web"})
    [scen] = r.json()["scenarios"]
    assert scen["platform"] == "web" and scen["source"] == "walk" and "web" in scen["tags"]
    r = await client.get(f"/api/qa/scenarios/{scen['id']}")
    assert all(e["frame_id"] for e in r.json()["evidence"])
