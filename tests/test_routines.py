"""Routines — recurring scheduled work (routine_routes + routine_schedule + the notifier hook).

Covers: cron/timezone/DST schedule math, plain-English descriptions, the flood guard,
due → normal task creation (through the task-creation handler), skip-if-open,
at-most-one catch-up task after downtime, slot idempotency, run-now, disable/enable,
author-authority failures, paused projects, the owner/manage_agents/viewer matrix in
both identity lanes, audit events, and the notifier's throttled tick call.

Run: ORCHA_TEST_DB_NAME=orcha_test_routines pytest tests/test_routines.py
"""
from datetime import datetime, timedelta, timezone

import psycopg
import pytest

import conftest
from portal_backend import routine_routes
from portal_backend import routine_schedule as sched
from conftest import ts_ago

UTC = timezone.utc


def dt(s):
    return datetime.fromisoformat(s).astimezone(UTC)


# ---------------------------------------------------------------------------
# Schedule math (pure)
# ---------------------------------------------------------------------------

def nxt(expr, tz, after):
    return sched.next_after(sched.parse_cron(expr), sched.load_zone(tz), dt(after))


def test_daily_in_nairobi_is_utc_plus_3():
    assert nxt("0 9 * * *", "Africa/Nairobi", "2026-09-29T05:00:00+00:00") == dt("2026-09-29T06:00:00+00:00")
    # strictly after: exactly at the slot → the next day
    assert nxt("0 9 * * *", "Africa/Nairobi", "2026-09-29T06:00:00+00:00") == dt("2026-09-30T06:00:00+00:00")


def test_weekdays_skip_the_weekend():
    # Fri 2 Oct 2026 10:00 Nairobi → Mon 5 Oct 09:00 Nairobi
    assert nxt("0 9 * * 1-5", "Africa/Nairobi", "2026-10-02T07:00:00+00:00") == dt("2026-10-05T06:00:00+00:00")
    assert nxt("0 9 * * MON-FRI", "Africa/Nairobi", "2026-10-02T07:00:00+00:00") == dt("2026-10-05T06:00:00+00:00")


def test_day_of_week_7_is_sunday_and_dom_dow_are_ored():
    # Sun 4 Oct 2026
    assert nxt("0 12 * * 7", "UTC", "2026-09-29T00:00:00+00:00") == dt("2026-10-04T12:00:00+00:00")
    assert nxt("0 12 * * 0", "UTC", "2026-09-29T00:00:00+00:00") == dt("2026-10-04T12:00:00+00:00")
    # day 1 of month OR Sunday → Sun 4 Oct comes before 1 Nov
    assert nxt("0 12 1 * 0", "UTC", "2026-10-02T00:00:00+00:00") == dt("2026-10-04T12:00:00+00:00")


def test_spring_forward_gap_fires_just_after_the_jump_not_skipped():
    # New York jumps 02:00 → 03:00 on Sun 8 Mar 2026. 02:30 doesn't exist: fire at 03:30 EDT (07:30Z).
    first = nxt("30 2 * * *", "America/New_York", "2026-03-08T05:00:00+00:00")
    assert first == dt("2026-03-08T07:30:00+00:00")
    # the next day is a normal 02:30 EDT (06:30Z)
    assert nxt("30 2 * * *", "America/New_York", first.isoformat()) == dt("2026-03-09T06:30:00+00:00")


def test_fall_back_overlap_fires_once():
    # New York repeats 01:00–02:00 on Sun 1 Nov 2026. 01:30 fires once (first occurrence, EDT).
    first = nxt("30 1 * * *", "America/New_York", "2026-11-01T04:00:00+00:00")
    assert first == dt("2026-11-01T05:30:00+00:00")
    second = nxt("30 1 * * *", "America/New_York", first.isoformat())
    assert second == dt("2026-11-02T06:30:00+00:00")  # NOT 2026-11-01T06:30Z (the repeat)
    # asking from inside the repeated hour doesn't resurrect the first occurrence either
    assert nxt("30 1 * * *", "America/New_York", "2026-11-01T06:10:00+00:00") == second


def test_hourly_across_dst_is_strictly_increasing_without_duplicates():
    cron, tz = sched.parse_cron("0 * * * *"), sched.load_zone("Europe/London")
    for start in ("2026-03-28T20:00:00+00:00", "2026-10-24T20:00:00+00:00"):
        t, seen = dt(start), []
        for _ in range(12):
            t = sched.next_after(cron, tz, t)
            seen.append(t)
        assert all(b > a for a, b in zip(seen, seen[1:]))
        assert len(set(seen)) == len(seen)


def test_occurrences_counts_missed_slots_inclusive():
    cron, tz = sched.parse_cron("0 9 * * *"), sched.load_zone("UTC")
    got = sched.occurrences(cron, tz, dt("2026-09-26T09:00:00+00:00"), dt("2026-09-29T10:00:00+00:00"))
    assert [g.day for g in got] == [26, 27, 28, 29]


def test_descriptions_are_plain_english():
    assert sched.describe("0 9 * * 1-5", "Africa/Nairobi") == "Every weekday at 09:00 Nairobi time"
    assert sched.describe("30 7 * * *", "UTC") == "Every day at 07:30 UTC"
    assert sched.describe("15 * * * *", "UTC") == "Every hour at :15"
    assert sched.describe("0 16 * * 5", "America/New_York") == "Every Friday at 16:00 New York time"
    assert sched.describe("0 8 1 * *", "Europe/Berlin") == "On the 1st of every month at 08:00 Berlin time"
    assert sched.describe("0 8,17 * * *", "UTC").startswith("Custom schedule (0 8,17 * * *)")


@pytest.mark.parametrize("expr,tz,needle", [
    ("0 9 * *", "UTC", "5 fields"),
    ("61 9 * * *", "UTC", "out of range"),
    ("0 9 * * FUNDAY", "UTC", "not valid"),
    ("*/5 * * * *", "UTC", "at most every 15 minutes"),
    ("0 0 31 2 *", "UTC", "never runs"),
    ("0 9 * * *", "Mars/Olympus", "unknown timezone"),
])
def test_invalid_schedules_are_refused_with_reasons(expr, tz, needle):
    with pytest.raises(sched.ScheduleError) as e:
        sched.validate(expr, tz)
    assert needle in str(e.value)


# ---------------------------------------------------------------------------
# API + scheduler (DB)
# ---------------------------------------------------------------------------

OCTO = {"X-Auth-Request-User": "octocat"}
VERA = {"X-Auth-Request-User": "vera"}


@pytest.fixture(autouse=True)
def _team_plan(monkeypatch):
    monkeypatch.setenv("ORCHA_PLAN", "team")


@pytest.fixture
async def arena(client, container, make_agent, db):
    """Owner human + AI worker, trust-off lane."""
    owner = await make_agent("kedar", "Founder", kind="human")
    db.execute("UPDATE agents SET member_role='owner' WHERE id=%s", (owner["agent_id"],))
    forge = await make_agent("forge", "Builder")
    return {"cid": container["id"], "owner": owner["agent_id"], "forge": forge["agent_id"]}


def routine_body(actor, **kw):
    body = {
        "actor_agent_id": actor,
        "title": "Dependency audit {{date}}",
        "description": "Check for outdated packages.",
        "definition_of_done": "A short report of outdated packages is posted.",
        "cron": "0 9 * * 1-5",
        "timezone": "Africa/Nairobi",
    }
    body.update(kw)
    return body


async def make_routine(client, arena, **kw):
    r = await client.post(f"/api/containers/{arena['cid']}/routines", json=routine_body(arena["owner"], **kw))
    assert r.status_code == 201, r.text
    return r.json()


def set_due(db, rid, when):
    db.execute("UPDATE routines SET next_run_at=%s WHERE id=%s", (when, rid))


def runs(db, rid):
    return db.execute("SELECT * FROM routine_runs WHERE routine_id=%s ORDER BY created_at", (rid,))


async def test_create_lists_with_next_run_and_plain_schedule(client, arena):
    r = await make_routine(client, arena, assignee_agent_id=arena["forge"])
    assert r["schedule_text"] == "Every weekday at 09:00 Nairobi time"
    assert r["enabled"] and r["skip_if_open"]
    assert r["assignee_alias"] == "forge"
    nr = datetime.fromisoformat(r["next_run_at"])
    assert nr > datetime.now(UTC)
    assert nr.astimezone(sched.load_zone("Africa/Nairobi")).hour == 9
    lst = (await client.get(f"/api/containers/{arena['cid']}/routines")).json()
    assert [x["id"] for x in lst["routines"]] == [r["id"]]
    assert lst["scheduler"] == {"last_tick_at": None}


async def test_create_rejects_bad_schedule_and_non_ai_assignee(client, arena):
    r = await client.post(f"/api/containers/{arena['cid']}/routines",
                          json=routine_body(arena["owner"], cron="*/5 * * * *"))
    assert r.status_code == 422 and "15 minutes" in r.text
    r = await client.post(f"/api/containers/{arena['cid']}/routines",
                          json=routine_body(arena["owner"], assignee_agent_id=arena["owner"]))
    assert r.status_code == 422 and "AI agent" in r.text


async def test_due_routine_creates_a_normal_task_through_task_creation(client, arena, db):
    r = await make_routine(client, arena, assignee_agent_id=arena["forge"])
    slot = dt("2026-09-29T06:00:00+00:00")  # Tue 09:00 Nairobi
    set_due(db, r["id"], slot)
    out = routine_routes.run_due_routines(arena["cid"], now=slot + timedelta(seconds=20))
    assert [f["outcome"] for f in out["fired"]] == ["created"]
    task_id = out["fired"][0]["task_id"]
    t = db.execute("SELECT * FROM tasks WHERE id=%s", (task_id,))[0]
    assert t["title"] == "Dependency audit 2026-09-29"
    assert str(t["created_by_agent_id"]) == arena["owner"]  # created AS the routine's human
    assert t["status"] == "in_progress"  # directly assigned, like any human-created task
    # R14/KG-2: the back-link names the routine as the task reads (tokens resolved), never raw "{{date}}"
    assert "Created by routine “Dependency audit 2026-09-29”" in t["description"]
    assert "{{date}}" not in t["description"]
    assert "Every weekday at 09:00 Nairobi time" in t["description"]
    assert t["description"].startswith("Check for outdated packages.")
    at = db.execute("SELECT * FROM agent_tasks WHERE task_id=%s", (task_id,))
    assert [str(a["agent_id"]) for a in at] == [arena["forge"]]
    # the assignee got the ordinary task_assigned event (so the normal wake path applies)
    ev = db.execute("SELECT * FROM agent_events WHERE target_id=%s AND event_name='task_assigned'", (arena["forge"],))
    assert len(ev) == 1
    [run] = runs(db, r["id"])
    assert run["trigger"] == "schedule" and run["outcome"] == "created"
    assert str(run["task_id"]) == task_id and run["scheduled_for"] == slot
    after = (await client.get(f"/api/routines/{r['id']}")).json()
    assert datetime.fromisoformat(after["next_run_at"]) == dt("2026-09-30T06:00:00+00:00")
    assert after["last_run"]["outcome"] == "created" and after["last_run"]["task_status"] == "in_progress"
    # history endpoint
    hist = (await client.get(f"/api/routines/{r['id']}/runs")).json()["runs"]
    assert hist[0]["task_title"] == "Dependency audit 2026-09-29"
    # audited
    evs = db.execute("SELECT event_type FROM events WHERE entity_type='routine' ORDER BY id")
    assert [e["event_type"] for e in evs] == ["routine_created", "routine_task_created"]


async def test_unassigned_routine_creates_a_ready_task(client, arena, db):
    r = await make_routine(client, arena)
    slot = dt("2026-09-29T06:00:00+00:00")
    set_due(db, r["id"], slot)
    out = routine_routes.run_due_routines(arena["cid"], now=slot)
    t = db.execute("SELECT status FROM tasks WHERE id=%s", (out["fired"][0]["task_id"],))[0]
    assert t["status"] == "ready"


async def test_skip_if_open_then_fires_again_once_the_task_is_done(client, arena, db):
    r = await make_routine(client, arena)
    s1, s2, s3 = (dt(x) for x in ("2026-09-29T06:00:00+00:00", "2026-09-30T06:00:00+00:00", "2026-10-01T06:00:00+00:00"))
    set_due(db, r["id"], s1)
    first = routine_routes.run_due_routines(arena["cid"], now=s1)["fired"][0]
    set_due(db, r["id"], s2)
    second = routine_routes.run_due_routines(arena["cid"], now=s2)["fired"][0]
    assert second["outcome"] == "skipped"
    assert "is still ready" in second["detail"]
    assert db.execute("SELECT count(*) AS n FROM tasks WHERE title LIKE 'Dependency audit%%'")[0]["n"] == 1
    db.execute("UPDATE tasks SET status='completed' WHERE id=%s", (first["task_id"],))
    set_due(db, r["id"], s3)
    third = routine_routes.run_due_routines(arena["cid"], now=s3)["fired"][0]
    assert third["outcome"] == "created"


async def test_skip_if_open_off_creates_every_time(client, arena, db):
    r = await make_routine(client, arena, skip_if_open=False)
    for s in ("2026-09-29T06:00:00+00:00", "2026-09-30T06:00:00+00:00"):
        set_due(db, r["id"], dt(s))
        assert routine_routes.run_due_routines(arena["cid"], now=dt(s))["fired"][0]["outcome"] == "created"


async def test_downtime_collapses_into_one_catch_up_task_and_says_so(client, arena, db):
    r = await make_routine(client, arena, cron="0 9 * * *", timezone="UTC")
    set_due(db, r["id"], dt("2026-09-26T09:00:00+00:00"))
    now = dt("2026-09-29T10:00:00+00:00")  # stack was down Sat..Tue: 4 slots missed
    out = routine_routes.run_due_routines(arena["cid"], now=now)
    assert len(out["fired"]) == 1
    f = out["fired"][0]
    assert f["outcome"] == "created" and f["trigger"] == "catch_up"
    tasks = db.execute("SELECT * FROM tasks WHERE title LIKE 'Dependency audit%%'")
    assert len(tasks) == 1
    assert "Catch-up run: 4 scheduled runs were missed" in tasks[0]["description"]
    assert "at most one catch-up task" in tasks[0]["description"]
    [run] = runs(db, r["id"])
    assert run["missed_count"] == 4 and run["scheduled_for"] == dt("2026-09-29T09:00:00+00:00")
    nr = db.execute("SELECT next_run_at FROM routines WHERE id=%s", (r["id"],))[0]["next_run_at"]
    assert nr == dt("2026-09-30T09:00:00+00:00")
    # a second pass right after does nothing
    assert routine_routes.run_due_routines(arena["cid"], now=now + timedelta(seconds=30))["fired"] == []


async def test_single_late_slot_is_a_catch_up_too(client, arena, db):
    r = await make_routine(client, arena, cron="0 9 * * *", timezone="UTC")
    set_due(db, r["id"], dt("2026-09-29T09:00:00+00:00"))
    f = routine_routes.run_due_routines(arena["cid"], now=dt("2026-09-29T11:00:00+00:00"))["fired"][0]
    assert f["trigger"] == "catch_up"
    t = db.execute("SELECT description FROM tasks WHERE id=%s", (f["task_id"],))[0]
    assert "1 scheduled run was missed" in t["description"]


async def test_a_slot_fires_at_most_once(client, arena, db):
    r = await make_routine(client, arena, skip_if_open=False)
    slot = dt("2026-09-29T06:00:00+00:00")
    set_due(db, r["id"], slot)
    routine_routes.run_due_routines(arena["cid"], now=slot)
    set_due(db, r["id"], slot)  # simulate a stale concurrent reader re-offering the slot
    out = routine_routes.run_due_routines(arena["cid"], now=slot)
    assert [f["outcome"] for f in out["fired"]] == ["duplicate"]
    assert len(runs(db, r["id"])) == 1


async def test_disabled_routines_never_fire_and_reenable_starts_from_now(client, arena, db):
    r = await make_routine(client, arena)
    p = await client.patch(f"/api/routines/{r['id']}", json={"actor_agent_id": arena["owner"], "enabled": False})
    assert p.status_code == 200 and p.json()["next_run_at"] is None
    out = routine_routes.run_due_routines(arena["cid"], now=datetime.now(UTC) + timedelta(days=30))
    assert out["fired"] == []
    p = await client.patch(f"/api/routines/{r['id']}", json={"actor_agent_id": arena["owner"], "enabled": True})
    assert datetime.fromisoformat(p.json()["next_run_at"]) > datetime.now(UTC)
    evs = [e["event_type"] for e in db.execute("SELECT event_type FROM events WHERE entity_type='routine' ORDER BY id")]
    assert evs == ["routine_created", "routine_disabled", "routine_enabled"]


async def test_editing_the_schedule_recomputes_next_run(client, arena):
    r = await make_routine(client, arena)
    p = await client.patch(f"/api/routines/{r['id']}", json={
        "actor_agent_id": arena["owner"], "cron": "0 16 * * 5", "timezone": "America/New_York"})
    assert p.status_code == 200, p.text
    j = p.json()
    assert j["schedule_text"] == "Every Friday at 16:00 New York time"
    loc = datetime.fromisoformat(j["next_run_at"]).astimezone(sched.load_zone("America/New_York"))
    assert (loc.weekday(), loc.hour) == (4, 16)


async def test_run_now_creates_a_task_without_moving_the_schedule(client, arena, db):
    r = await make_routine(client, arena)
    x = await client.post(f"/api/routines/{r['id']}/run", json={"actor_agent_id": arena["owner"]})
    assert x.status_code == 200, x.text
    assert x.json()["outcome"] == "created" and x.json()["trigger"] == "manual"
    t = db.execute("SELECT description FROM tasks WHERE id=%s", (x.json()["task_id"],))[0]
    assert "run manually by kedar" in t["description"]
    again = (await client.get(f"/api/routines/{r['id']}")).json()
    assert again["next_run_at"] == r["next_run_at"]
    assert again["last_run"]["trigger"] == "manual"


async def test_retired_author_fails_the_run_honestly(client, arena, db):
    r = await make_routine(client, arena)
    db.execute("UPDATE agents SET terminated_at=now() WHERE id=%s", (arena["owner"],))
    slot = dt("2026-09-29T06:00:00+00:00")
    set_due(db, r["id"], slot)
    f = routine_routes.run_due_routines(arena["cid"], now=slot)["fired"][0]
    assert f["outcome"] == "failed" and "no longer a member" in f["detail"]
    assert db.execute("SELECT count(*) AS n FROM tasks WHERE title LIKE 'Dependency audit%%'")[0]["n"] == 0


async def test_retired_assignee_leaves_the_task_unassigned_and_says_so(client, arena, db):
    r = await make_routine(client, arena, assignee_agent_id=arena["forge"])
    db.execute("UPDATE agents SET terminated_at=now() WHERE id=%s", (arena["forge"],))
    slot = dt("2026-09-29T06:00:00+00:00")
    set_due(db, r["id"], slot)
    f = routine_routes.run_due_routines(arena["cid"], now=slot)["fired"][0]
    assert f["outcome"] == "created" and "left unassigned" in f["detail"]


async def test_paused_project_fires_nothing_until_resumed(client, arena, db):
    r = await make_routine(client, arena, cron="0 9 * * *", timezone="UTC")
    set_due(db, r["id"], dt("2026-09-28T09:00:00+00:00"))
    db.execute("UPDATE containers SET status='paused' WHERE id=%s", (arena["cid"],))
    out = routine_routes.run_due_routines(arena["cid"], now=dt("2026-09-29T10:00:00+00:00"))
    assert out["suppressed"] == "paused" and out["fired"] == []
    db.execute("UPDATE containers SET status='active' WHERE id=%s", (arena["cid"],))
    out = routine_routes.run_due_routines(arena["cid"], now=dt("2026-09-29T10:00:00+00:00"))
    assert out["fired"][0]["trigger"] == "catch_up"


async def test_stale_pending_run_is_marked_interrupted(client, arena, db):
    r = await make_routine(client, arena)
    db.execute(
        "INSERT INTO routine_runs (routine_id, container_id, trigger, outcome, created_at) "
        f"VALUES (%s, %s, 'manual', 'pending', {ts_ago(3600)})",
        (r["id"], arena["cid"]),
    )
    routine_routes.run_due_routines(arena["cid"])
    [run] = runs(db, r["id"])
    assert run["outcome"] == "failed" and run["detail"].startswith("Interrupted")


async def test_tick_endpoint_and_scheduler_heartbeat(client, arena):
    x = await client.post(f"/api/containers/{arena['cid']}/routines/tick")
    assert x.status_code == 200 and x.json()["ok"] is True
    lst = (await client.get(f"/api/containers/{arena['cid']}/routines")).json()
    assert lst["scheduler"]["last_tick_at"] is not None


async def test_preview_endpoint(client, arena):
    x = await client.post(f"/api/containers/{arena['cid']}/routines/preview",
                          json={"cron": "0 9 * * 1-5", "timezone": "Africa/Nairobi"})
    j = x.json()
    assert j["valid"] and j["schedule_text"] == "Every weekday at 09:00 Nairobi time"
    assert len(j["next_runs"]) == 3
    bad = (await client.post(f"/api/containers/{arena['cid']}/routines/preview",
                             json={"cron": "* * * * *", "timezone": "UTC"})).json()
    assert bad["valid"] is False and "15 minutes" in bad["error"]


async def test_delete_archives_and_keeps_history(client, arena, db):
    r = await make_routine(client, arena)
    await client.post(f"/api/routines/{r['id']}/run", json={"actor_agent_id": arena["owner"]})
    d = await client.delete(f"/api/routines/{r['id']}", params={"actor_agent_id": arena["owner"]})
    assert d.status_code == 200
    assert (await client.get(f"/api/containers/{arena['cid']}/routines")).json()["routines"] == []
    assert (await client.get(f"/api/routines/{r['id']}")).status_code == 404
    assert len(runs(db, r["id"])) == 1  # history kept
    assert db.execute("SELECT count(*) AS n FROM tasks WHERE title LIKE 'Dependency audit%%'")[0]["n"] == 1


# ---- authorization matrix -----------------------------------------------------

async def test_trust_off_requires_a_human_owner_or_manage_agents(client, arena, make_agent, db):
    cid = arena["cid"]
    # an AI can never manage routines
    x = await client.post(f"/api/containers/{cid}/routines", json=routine_body(arena["forge"]))
    assert x.status_code == 403
    # a plain member needs the grant
    m = await make_agent("hubot", "Dev", kind="human")
    x = await client.post(f"/api/containers/{cid}/routines", json=routine_body(m["agent_id"]))
    assert x.status_code == 403 and "manage_agents" in x.text
    db.execute("""UPDATE agents SET grants='["manage_agents"]' WHERE id=%s""", (m["agent_id"],))
    x = await client.post(f"/api/containers/{cid}/routines", json=routine_body(m["agent_id"]))
    assert x.status_code == 201, x.text
    rid = x.json()["id"]
    # a viewer is refused even with the grant
    v = await make_agent("vera", "Viewer", kind="human")
    db.execute("""UPDATE agents SET member_role='viewer', grants='["manage_agents"]' WHERE id=%s""", (v["agent_id"],))
    for call in (
        client.post(f"/api/containers/{cid}/routines", json=routine_body(v["agent_id"])),
        client.patch(f"/api/routines/{rid}", json={"actor_agent_id": v["agent_id"], "enabled": False}),
        client.post(f"/api/routines/{rid}/run", json={"actor_agent_id": v["agent_id"]}),
        client.delete(f"/api/routines/{rid}", params={"actor_agent_id": v["agent_id"]}),
    ):
        assert (await call).status_code == 403
    # missing actor
    x = await client.post(f"/api/containers/{cid}/routines", json=routine_body(None))
    assert x.status_code == 400


async def test_trusted_lane_viewer_reads_but_cannot_write(client, container, make_agent, db, monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    assert (await client.get(f"/api/me?cid={cid}", headers=OCTO)).json()["identity"]["member_role"] == "owner"
    r = await client.post(f"/api/containers/{cid}/members", json={"github_login": "vera", "role": "viewer"}, headers=OCTO)
    assert r.status_code == 201, r.text
    # owner creates (body actor ignored: the proxy identity IS the actor)
    x = await client.post(f"/api/containers/{cid}/routines", json=routine_body(None), headers=OCTO)
    assert x.status_code == 201, x.text
    rid = x.json()["id"]
    assert x.json()["created_by_alias"] == "octocat"
    # viewer: reads OK, writes 403
    assert (await client.get(f"/api/containers/{cid}/routines", headers=VERA)).status_code == 200
    assert (await client.get(f"/api/routines/{rid}/runs", headers=VERA)).status_code == 200
    assert (await client.post(f"/api/containers/{cid}/routines", json=routine_body(None), headers=VERA)).status_code == 403
    assert (await client.post(f"/api/routines/{rid}/run", json={}, headers=VERA)).status_code == 403
    # a verified stranger can't even read
    assert (await client.get(f"/api/containers/{cid}/routines",
                             headers={"X-Auth-Request-User": "mallory"})).status_code == 403
    # owner run-now: task created as the owner
    x = await client.post(f"/api/routines/{rid}/run", json={}, headers=OCTO)
    assert x.status_code == 200, x.text
    t = db.execute("SELECT a.alias FROM tasks t JOIN agents a ON a.id=t.created_by_agent_id WHERE t.id=%s",
                   (x.json()["task_id"],))[0]
    assert t["alias"] == "octocat"


# ---- notifier hook -------------------------------------------------------------

def test_notifier_hook_is_throttled_and_never_raises(monkeypatch):
    from orcha_cli import notifier_routines

    calls = []

    class Svc:
        @staticmethod
        def _post_json(url, body):
            calls.append(url)
            if len(calls) == 2:
                raise RuntimeError("boom")
            return {"ok": True, "fired": [{"outcome": "created", "routine_id": "r1", "task_id": "t1"}]}

    notifier_routines._LAST_TICK.clear()
    clock = [1000.0]
    monkeypatch.setattr(notifier_routines, "_monotonic", lambda: clock[0])
    notifier_routines.maybe_fire_routines("http://api", "cid-1", Svc, quiet=True)
    notifier_routines.maybe_fire_routines("http://api", "cid-1", Svc, quiet=True)  # throttled
    assert calls == ["http://api/api/containers/cid-1/routines/tick"]
    clock[0] += notifier_routines.TICK_EVERY_SECS + 1
    notifier_routines.maybe_fire_routines("http://api", "cid-1", Svc, quiet=True)  # raises inside → swallowed
    assert len(calls) == 2
    clock[0] += notifier_routines.TICK_EVERY_SECS + 1
    notifier_routines.maybe_fire_routines("http://api", "cid-1", Svc, quiet=True, dry_run=True)
    assert len(calls) == 2  # dry-run never fires routines, even when the throttle is open


async def test_an_unexpected_task_creation_error_is_logged_not_returned(client, arena, db, monkeypatch, caplog):
    """CodeQL information exposure: a crash inside task creation fails the run with a fixed
    message (API, run row, the scheduler's tick result); the exception text goes to the log."""
    from portal_backend import task_creation_routes

    def boom(*_a, **_k):
        raise RuntimeError("SECRET-INTERNAL connection string postgres://u:pw@db")

    monkeypatch.setattr(task_creation_routes, "create_task", boom)
    r = await make_routine(client, arena)
    with caplog.at_level("WARNING", logger="orcha.portal.errors"):
        x = await client.post(f"/api/routines/{r['id']}/run", json={"actor_agent_id": arena["owner"]})
    assert x.status_code == 500
    assert "SECRET" not in x.text and "RuntimeError" not in x.text
    assert x.json()["detail"].startswith("Task creation failed because of an unexpected server error")
    assert "SECRET-INTERNAL" in caplog.text  # the operator still sees the cause
    assert all("SECRET" not in (row["detail"] or "") for row in runs(db, r["id"]))

    slot = dt("2026-09-29T06:00:00+00:00")
    set_due(db, r["id"], slot)
    out = routine_routes.run_due_routines(arena["cid"], now=slot)
    assert out["fired"] and all("SECRET" not in (f.get("detail") or "") for f in out["fired"])


async def test_preview_returns_the_schedule_validation_message(client, arena):
    bad = (await client.post(f"/api/containers/{arena['cid']}/routines/preview",
                             json={"cron": "61 * * * *", "timezone": "UTC"})).json()
    assert bad["valid"] is False and bad["error"] == "minute value 61 is out of range 0-59"
    bad = (await client.post(f"/api/containers/{arena['cid']}/routines/preview",
                             json={"cron": "0 9 * * *", "timezone": "Mars/Olympus"})).json()
    assert bad["error"] == "unknown timezone 'Mars/Olympus'"
