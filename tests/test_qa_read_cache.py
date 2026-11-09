"""The polled reads: a poll stays small, the heavy reading runs once per version, and a read takes no
write lock. A real portal's slowness was contention between them, so these hold the line."""

import ast
import pathlib
import threading
import time

import pytest

from portal_backend import database, qa_onboarding, qa_read_cache

BACKEND = pathlib.Path(qa_onboarding.__file__).parent


@pytest.fixture
async def p(client, container, make_agent):
    human = (await make_agent("Hussein", kind="human"))["agent_id"]
    bot = (await make_agent("qa-bot"))["agent_id"]

    class X:
        pass
    x = X()
    x.client, x.cid, x.human, x.bot = client, container["id"], human, bot
    x.c = f"/api/containers/{container['id']}/qa"
    return x


async def observe(p, key):
    r = await p.client.post(f"{p.c}/map/import", json={"actor_agent_id": p.bot, "platform": "ios", "source": "code", "nodes": [{"kind": "screen", "key": key, "label": key}]})
    assert r.status_code == 200, r.text


def count_map_parts(monkeypatch):
    calls = []
    real = qa_onboarding._map_part
    monkeypatch.setattr(qa_onboarding, "_map_part", lambda cur, row: calls.append(1) or real(cur, row))
    return calls


async def get(p, **params):
    r = await p.client.get(f"{p.c}/onboarding", params=params)
    assert r.status_code == 200, r.text
    return r.json()


async def test_the_map_part_is_computed_once_per_version(p, monkeypatch):
    calls = count_map_parts(monkeypatch)
    await get(p)
    await get(p)
    await get(p)
    assert len(calls) == 1
    await observe(p, "home")
    await get(p)
    assert len(calls) == 2


async def test_a_poll_with_its_version_leaves_the_map_out(p):
    await observe(p, "home")
    full = await get(p)
    assert full["screens"] and full["snapshot_version"] and "snapshot_unchanged" not in full
    poll = await get(p, since=full["snapshot_version"])
    assert poll["snapshot_unchanged"] is True and poll["snapshot_version"] == full["snapshot_version"]
    for key in qa_onboarding.MAP_KEYS:
        assert key not in poll
    assert poll["phases"] == full["phases"] and poll["smoke"] == full["smoke"] and "first_test" in poll


async def test_a_changed_map_brings_it_back(p):
    await observe(p, "home")
    full = await get(p)
    await observe(p, "cart")
    poll = await get(p, since=full["snapshot_version"])
    assert "snapshot_unchanged" not in poll and {s["name"] for s in poll["screens"]} == {"home", "cart"}
    assert poll["snapshot_version"] != full["snapshot_version"]


async def test_a_scenario_edit_that_leaves_updated_at_alone_changes_the_version(p, db):
    await observe(p, "home")
    sid = qa_onboarding.qs.new_id()
    db.execute("INSERT INTO qa_scenarios (id, container_id, platform, name, criteria, status, tags, updated_at) VALUES (%s,%s,'ios','Pay','[]','draft','[]','2026-01-01T00:00:00+00:00')",
               (sid, p.cid))
    before = (await get(p))["snapshot_version"]
    db.execute("UPDATE qa_scenarios SET tags='[\"screen:home\"]' WHERE id=%s", (sid,))
    after = await get(p)
    assert after["snapshot_version"] != before
    assert next(s for s in after["screens"] if s["name"] == "home")["coverage"] == "qa"


async def test_the_row_alone_reads_no_snapshot(p, monkeypatch):
    calls = count_map_parts(monkeypatch)
    out = await get(p, fields="row")
    assert not calls and "screens" not in out and "phases" in out and "live_build" not in out and "smoke" not in out


def test_a_first_run_leaves_the_cached_screens_as_they_were():
    screens = [{"id": "a"}, {"id": "b"}]
    out = qa_onboarding._with_first_run(screens, {"screen_id": "a", "first_run": {"status": "running"}})
    assert out[0]["first_run"] == {"status": "running"} and "first_run" not in screens[0] and out[1] is screens[1]


def test_many_at_once_cost_one_reading():
    qa_read_cache.clear()
    calls = []

    def slow():
        calls.append(1)
        time.sleep(0.05)
        return "value"

    got = []
    threads = [threading.Thread(target=lambda: got.append(qa_read_cache.get("k", "v1", slow))) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(calls) == 1 and got == ["value"] * 8


def test_an_old_entry_expires_since_a_reading_may_say_how_long_ago(monkeypatch):
    qa_read_cache.clear()
    assert qa_read_cache.get("k", "v", lambda: 1) == 1
    real = time.monotonic
    monkeypatch.setattr(qa_read_cache.time, "monotonic", lambda: real() + qa_read_cache.MAX_AGE_S + 1)
    assert qa_read_cache.get("k", "v", lambda: 2) == 2


def test_the_cache_stays_small():
    qa_read_cache.clear()
    for i in range(qa_read_cache.MAX_ENTRIES + 10):
        qa_read_cache.get(("k", i), "v", lambda: i)
    assert len(qa_read_cache._entries) == qa_read_cache.MAX_ENTRIES


async def test_a_heartbeat_keeps_the_atlas_reading_and_a_step_replaces_it(p, db):
    tid = (await p.client.post(f"{p.c}/run-task", json={"actor_agent_id": p.bot, "kind": "map", "platform": "ios"})).json()["task_id"]
    sid = (await p.client.post(f"{p.c}/sessions", json={"actor_agent_id": p.bot, "kind": "map", "platform": "ios", "task_id": tid})).json()["id"]

    def version():
        with database.db_cursor(readonly=True) as (_, cur):
            return qa_read_cache.live_version(cur, p.cid)

    before = version()
    await p.client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": p.bot})
    assert version() == before
    await p.client.post(f"/api/qa/sessions/{sid}/steps", json={"actor_agent_id": p.bot, "steps": [{"seq": 1, "kind": "note"}]})
    assert version() != before


async def test_map_and_atlas_follow_what_changed(p):
    await observe(p, "home")
    first = (await p.client.get(f"{p.c}/map", params={"platform": "ios"})).json()
    assert (await p.client.get(f"{p.c}/map", params={"platform": "ios"})).json() == first
    await observe(p, "cart")
    assert len((await p.client.get(f"{p.c}/map", params={"platform": "ios"})).json()["nodes"]) > len(first["nodes"])
    atlas = (await p.client.get(f"{p.c}/atlas")).json()
    await observe(p, "pay")
    assert (await p.client.get(f"{p.c}/atlas")).json() != atlas


@pytest.mark.parametrize("path", ["/onboarding", "/onboarding?fields=row", "/overview", "/map?platform=ios", "/atlas", "/sessions",
                                  "/session-digests", "/requests", "/triage", "/live", "/scenarios", "/settings"])
async def test_a_polled_qa_read_opens_no_write_transaction(p, monkeypatch, path):
    await observe(p, "home")
    writes = []
    begin = database._Scope.begin
    monkeypatch.setattr(database._Scope, "begin", lambda self: (None if self.readonly else writes.append(1), begin(self))[1])
    monkeypatch.setattr(qa_onboarding.qa_explorations, "_swept", {p.cid: time.monotonic()})
    r = await p.client.get(p.c + path)
    assert r.status_code == 200, r.text
    assert not writes


@pytest.mark.parametrize("path", ["/api/containers", "/api/plan-usage/display", "/api/plan-usage/summary", "/api/plan-usage"])
async def test_the_reads_every_page_makes_take_no_write_lock(p, monkeypatch, path):
    writes = []
    begin = database._Scope.begin
    monkeypatch.setattr(database._Scope, "begin", lambda self: (None if self.readonly else writes.append(1), begin(self))[1])
    r = await p.client.get(path)
    assert r.status_code == 200, r.text
    assert not writes


async def test_the_reads_changed_to_readonly_really_write_nothing(p, monkeypatch):
    monkeypatch.setenv("ORCHA_DB_ASSERT_READONLY", "1")
    for path in ("/api/containers", f"/api/containers/{p.cid}/budgets", f"/api/containers/{p.cid}/running-runs",
                 f"/api/containers/{p.cid}/project-profile", "/api/plan-usage", "/api/plan-usage/summary", "/api/plan-usage/display"):
        r = await p.client.get(path)
        assert r.status_code == 200, (path, r.text)


#: QA GET routes that may open a write scope, and why. Anything else there is a bug.
WRITES_ON_READ = {"list_qa_scenarios": "only when a paused scenario is due", "qa_drafting_board": "only when a request is past its time",
                  "qa_scenario_flags": "only when the audit is stale", "qa_scenario_audit": "stores the audit; opened by a person",
                  "qa_coverage_growth": "records today's point; opened by a person"}


def test_no_qa_get_route_holds_a_write_transaction_by_habit():
    found = {}
    for path in BACKEND.glob("qa_*.py"):
        for fn in ast.walk(ast.parse(path.read_text())):
            if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if not any(isinstance(d, ast.Call) and getattr(d.func, "attr", "") == "get" for d in fn.decorator_list):
                continue
            for n in ast.walk(fn):
                if isinstance(n, ast.Call) and getattr(n.func, "id", "") == "db_cursor" and not any(k.arg == "readonly" for k in n.keywords):
                    found[fn.name] = path.name
    assert set(found) <= set(WRITES_ON_READ), found
