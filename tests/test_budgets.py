"""Per-agent monthly budgets with hard stops (+ optional project cap) — budget_routes.

Covers: accounting (metered USD vs NOT-metered runs, never $0; token cap counts all runs;
in-flight runs excluded from spend), thresholds (80% warning + Needs-you once per month,
100% pause + Needs-you once), the pre-spawn hard stop in the wake-scan (should_wake withheld,
in-flight run untouched, notifier skips), the audited one-time override, month rollover, the
project-wide cap, and authority (owner / manage_autonomy only; viewers, members without the
grant and AI agents refused; reads member-only)."""
import datetime as _dt

import pytest

from portal_backend import sql

OCTO = {"X-Auth-Request-User": "octocat"}
HUBOT = {"X-Auth-Request-User": "hubot"}
VERA = {"X-Auth-Request-User": "vera"}
MALLORY = {"X-Auth-Request-User": "mallory"}


async def _setup(client, container, make_agent):
    human = await make_agent("root", "operator", kind="human")
    ai = await make_agent("Builder", "worker", kind="ai")
    return human["agent_id"], ai["agent_id"]


def _run(db, aid, *, cost=None, tokens=(0, 0, 0, 0), running=False, started="now()", output=None):
    it, ot, crt, cct = tokens
    use_tokens = any(tokens)
    db.execute(
        f"""INSERT INTO worker_runs (agent_id, wake_kind, status, started_at, ended_at,
                input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
                total_cost_usd, output)
            VALUES (%s, 'ephemeral', %s, {started}, {'NULL' if running else started},
                    %s, %s, %s, %s, %s, %s)""",
        (aid, "running" if running else "exited",
         it if use_tokens else None, ot if use_tokens else None,
         crt if use_tokens else None, cct if use_tokens else None, cost, output),
    )


async def _put(client, aid, body, headers=None):
    return await client.put(f"/api/agents/{aid}/budget", json=body, headers=headers or {})


async def _scan(client, cid):
    r = await client.get(f"/api/containers/{cid}/wake-scan", params={"cooldown": 0, "min_idle": 0})
    assert r.status_code == 200, r.text
    return next(c for c in r.json()["candidates"] if c["alias"] == "Builder")


def _make_due(db, aid):
    # a clock-driven auto-wake that is due now: a guaranteed should_wake candidate
    db.execute("UPDATE agents SET auto_wake_interval_secs=60 WHERE id=%s", (aid,))


def _requests(db, reason):
    return db.execute(
        """SELECT r.* FROM requests r JOIN events e ON e.entity_id = r.id
            WHERE e.event_type='created' AND e.detail->>'reason'=%s""",
        (reason,),
    )


# --------------------------------------------------------------------------- accounting

async def test_unmetered_runs_are_not_counted_as_zero_spend(client, container, make_agent, db):
    hid, aid = await _setup(client, container, make_agent)
    _run(db, aid, cost=2.5, tokens=(100, 50, 0, 0))
    _run(db, aid, cost=None, tokens=(1000, 500, 200, 300))   # subscription: no dollar figure
    _run(db, aid, cost=None, running=True)                   # in flight
    r = await _put(client, aid, {"actor_agent_id": hid, "monthly_limit_usd": 10})
    assert r.status_code == 200, r.text
    b = r.json()
    u = b["usage"]
    assert u["spend_usd"] == 2.5
    assert u["metered_runs"] == 1 and u["unmetered_runs"] == 1
    assert u["unmetered_tokens"] == 2000
    assert u["tokens"] == 2150
    assert u["in_flight_runs"] == 1 and u["runs"] == 2
    assert b["state"] == "ok" and b["usd_ratio"] == 0.25 and b["paused"] is False


async def test_output_tail_cost_counts_as_metered(client, container, make_agent, db):
    hid, aid = await _setup(client, container, make_agent)
    tail = '{"type":"result","total_cost_usd":1.25,"usage":{"input_tokens":10,"output_tokens":5}}'
    _run(db, aid, output=tail)
    r = await client.get(f"/api/agents/{aid}/budget")
    assert r.status_code == 200, r.text
    u = r.json()["usage"]
    assert u["spend_usd"] == 1.25 and u["metered_runs"] == 1 and u["unmetered_runs"] == 0
    assert r.json()["state"] == "none"  # no limit set → no verdict, usage still reported


async def test_token_cap_counts_unmetered_runs(client, container, make_agent, db):
    hid, aid = await _setup(client, container, make_agent)
    _run(db, aid, cost=None, tokens=(600, 300, 100, 0))
    r = await _put(client, aid, {"actor_agent_id": hid, "monthly_limit_usd": 5, "monthly_limit_tokens": 1000})
    b = r.json()
    assert b["usd_ratio"] == 0.0          # nothing metered — not "$0 of real spend"
    assert b["token_ratio"] == 1.0
    assert b["state"] == "exceeded" and b["limits_reached"] == ["tokens"] and b["paused"] is True


# --------------------------------------------------------------------------- thresholds

async def test_warning_at_80_percent_fires_once(client, container, make_agent, db):
    hid, aid = await _setup(client, container, make_agent)
    await _put(client, aid, {"actor_agent_id": hid, "monthly_limit_usd": 10})
    _run(db, aid, cost=8.2)
    c = await _scan(client, container["id"])
    assert c["budget_paused"] is False
    await _scan(client, container["id"])
    ev = db.execute("SELECT * FROM events WHERE event_type='budget_warning' AND entity_id=%s", (aid,))
    assert len(ev) == 1
    reqs = _requests(db, "budget_warning")
    assert len(reqs) == 1 and reqs[0]["target_id"] is not None
    assert "82%" in reqs[0]["payload"]
    assert (await client.get(f"/api/agents/{aid}/budget")).json()["state"] == "warning"


async def test_pause_before_spawn_never_kills_in_flight(client, container, make_agent, db):
    hid, aid = await _setup(client, container, make_agent)
    _make_due(db, aid)
    assert (await _scan(client, container["id"]))["should_wake"] is True
    await _put(client, aid, {"actor_agent_id": hid, "monthly_limit_usd": 1})
    _run(db, aid, cost=1.5)
    c = await _scan(client, container["id"])
    assert c["should_wake"] is False
    assert c["budget_paused"] is True and c["budget_held_wake"] is True
    assert c["reason"].startswith("budget: Monthly budget reached")
    assert "Runs in progress were not stopped" in c["budget_reason"]
    # a run that was already in flight when the budget tripped is never touched
    _run(db, aid, running=True)
    assert db.execute("SELECT count(*) AS n FROM worker_runs WHERE agent_id=%s AND status='running'", (aid,))[0]["n"] == 1
    # exactly one pause event + Needs-you notice across repeated scans
    await _scan(client, container["id"])
    assert len(db.execute("SELECT 1 FROM events WHERE event_type='budget_paused' AND entity_id=%s", (aid,))) == 1
    assert len(_requests(db, "budget_paused")) == 1
    b = (await client.get(f"/api/agents/{aid}/budget")).json()
    assert b["paused"] is True and b["blocked_by"] == "agent" and "not stopped" in b["reason"]


def test_notifier_skips_budget_paused_candidate(capsys):
    from orcha_cli import notifier_wake_candidate as nwc

    class Boom:
        def __getattr__(self, name):
            raise AssertionError("notifier must not touch services for a paused candidate")

    cand = {"agent_id": "a", "alias": "Builder", "should_wake": True, "budget_paused": True,
            "budget_held_wake": True, "budget_reason": "Monthly budget reached"}
    assert nwc.process_candidate("http://x", cand, context={}, dry_run=False, quiet=False,
                                 lease_ttl=60, live_workers={}, services=Boom()) is None
    assert "Monthly budget reached" in capsys.readouterr().out


async def test_raise_budget_resumes_and_rearms_notices(client, container, make_agent, db):
    hid, aid = await _setup(client, container, make_agent)
    _make_due(db, aid)
    await _put(client, aid, {"actor_agent_id": hid, "monthly_limit_usd": 1})
    _run(db, aid, cost=1.2)
    assert (await _scan(client, container["id"]))["should_wake"] is False
    r = await _put(client, aid, {"actor_agent_id": hid, "monthly_limit_usd": 100})
    assert r.json()["paused"] is False
    assert (await _scan(client, container["id"]))["should_wake"] is True
    ev = db.execute("SELECT detail FROM events WHERE event_type='budget_updated' AND entity_id=%s ORDER BY id", (aid,))
    assert ev[-1]["detail"]["changes"]["monthly_limit_usd"] == {"from": 1.0, "to": 100.0}
    row = db.execute("SELECT warned_period, paused_period FROM agent_budgets WHERE agent_id=%s", (aid,))[0]
    assert row["warned_period"] is None and row["paused_period"] is None


async def test_one_time_override_is_audited_and_month_scoped(client, container, make_agent, db):
    hid, aid = await _setup(client, container, make_agent)
    _make_due(db, aid)
    await _put(client, aid, {"actor_agent_id": hid, "monthly_limit_usd": 1})
    _run(db, aid, cost=3)
    r = await _put(client, aid, {"actor_agent_id": hid, "override": "grant", "note": "release week"})
    b = r.json()
    assert b["state"] == "exceeded" and b["paused"] is False
    assert b["override"]["active"] is True and b["override"]["granted_by"] == hid
    assert (await _scan(client, container["id"]))["should_wake"] is True
    ev = db.execute("SELECT actor_id, detail FROM events WHERE event_type='budget_override_granted'")
    assert len(ev) == 1 and str(ev[0]["actor_id"]) == hid and ev[0]["detail"]["note"] == "release week"
    # an override from LAST month does not carry over
    db.execute("UPDATE agent_budgets SET override_period='1999-01' WHERE agent_id=%s", (aid,))
    assert (await client.get(f"/api/agents/{aid}/budget")).json()["paused"] is True
    # revoke
    await _put(client, aid, {"actor_agent_id": hid, "override": "grant"})
    r = await _put(client, aid, {"actor_agent_id": hid, "override": "revoke"})
    assert r.json()["override"]["active"] is False and r.json()["paused"] is True
    assert len(db.execute("SELECT 1 FROM events WHERE event_type='budget_override_revoked'")) == 1


async def test_month_rollover_resets(client, container, make_agent, db):
    hid, aid = await _setup(client, container, make_agent)
    _make_due(db, aid)
    await _put(client, aid, {"actor_agent_id": hid, "monthly_limit_usd": 1})
    now = sql.utcnow()
    last_month = "'" + sql.ts(now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
                                - _dt.timedelta(days=3)) + "'"
    _run(db, aid, cost=50, started=last_month)
    db.execute("UPDATE agent_budgets SET warned_period='1999-01', paused_period='1999-01' WHERE agent_id=%s", (aid,))
    b = (await client.get(f"/api/agents/{aid}/budget")).json()
    assert b["usage"]["spend_usd"] == 0 and b["state"] == "ok" and b["paused"] is False
    assert (await _scan(client, container["id"]))["should_wake"] is True
    # a new month re-arms the notices: this month's spend crosses 100% → fires again
    _run(db, aid, cost=2)
    await _scan(client, container["id"])
    assert len(_requests(db, "budget_paused")) == 1
    period = b["period"]
    assert db.execute("SELECT paused_period FROM agent_budgets WHERE agent_id=%s", (aid,))[0]["paused_period"] == period


async def test_project_cap_pauses_every_agent(client, container, make_agent, db):
    hid, aid = await _setup(client, container, make_agent)
    other = (await make_agent("Other", "worker", kind="ai"))["agent_id"]
    _make_due(db, aid)
    _run(db, aid, cost=3)
    _run(db, other, cost=3)
    r = await client.put(f"/api/containers/{container['id']}/budget",
                         json={"actor_agent_id": hid, "monthly_limit_usd": 5})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["project"]["state"] == "exceeded" and body["project"]["usage"]["spend_usd"] == 6
    assert all(a["paused"] and a["blocked_by"] == "project" for a in body["agents"])
    c = await _scan(client, container["id"])
    assert c["should_wake"] is False and "Project monthly budget" in c["budget_reason"]
    lst = (await client.get(f"/api/containers/{container['id']}/budgets")).json()
    assert {a["alias"] for a in lst["agents"]} == {"Builder", "Other"}
    # a project override lifts the stop for this month
    await client.put(f"/api/containers/{container['id']}/budget",
                     json={"actor_agent_id": hid, "override": "grant"})
    assert (await _scan(client, container["id"]))["should_wake"] is True


# --------------------------------------------------------------------------- authority

async def test_ai_agent_cannot_set_its_own_budget(client, container, make_agent):
    hid, aid = await _setup(client, container, make_agent)
    r = await _put(client, aid, {"actor_agent_id": aid, "monthly_limit_usd": 1000})
    assert r.status_code == 403
    r = await _put(client, aid, {"monthly_limit_usd": 1000})
    assert r.status_code == 400  # no actor → refused


async def test_humans_have_no_budget(client, container, make_agent):
    hid, _ = await _setup(client, container, make_agent)
    assert (await _put(client, hid, {"actor_agent_id": hid, "monthly_limit_usd": 1})).status_code == 400
    assert (await client.get(f"/api/agents/{hid}/budget")).status_code == 400


async def test_validation(client, container, make_agent):
    hid, aid = await _setup(client, container, make_agent)
    assert (await _put(client, aid, {"actor_agent_id": hid, "monthly_limit_usd": -1})).status_code == 422
    assert (await _put(client, aid, {"actor_agent_id": hid, "override": "forever"})).status_code == 422
    assert (await client.get("/api/agents/not-a-uuid/budget")).status_code == 400


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    monkeypatch.setenv("ORCHA_PLAN", "team")


async def test_grant_matrix_under_proxy_identity(client, container, make_agent, trust_proxy):
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    assert (await client.get(f"/api/me?cid={cid}", headers=OCTO)).status_code == 200
    aid = (await make_agent("Builder", "worker", kind="ai"))["agent_id"]

    async def invite(login, role):
        r = await client.post(f"/api/containers/{cid}/members",
                              json={"github_login": login, "role": role}, headers=OCTO)
        assert r.status_code == 201, r.text
        return r.json()["agent_id"]

    hubot = await invite("hubot", "member")
    await invite("vera", "viewer")

    # member without the grant, viewer, stranger → refused; everyone who is a member can read
    assert (await _put(client, aid, {"monthly_limit_usd": 5}, HUBOT)).status_code == 403
    assert (await _put(client, aid, {"monthly_limit_usd": 5}, VERA)).status_code == 403
    assert (await _put(client, aid, {"monthly_limit_usd": 5}, MALLORY)).status_code == 403
    assert (await client.get(f"/api/agents/{aid}/budget", headers=VERA)).status_code == 200
    assert (await client.get(f"/api/containers/{cid}/budgets", headers=MALLORY)).status_code == 403
    assert (await client.put(f"/api/containers/{cid}/budget", json={"monthly_limit_usd": 5},
                             headers=VERA)).status_code == 403

    # owner → allowed (the proxy identity IS the actor, even with no body actor)
    r = await _put(client, aid, {"monthly_limit_usd": 5}, OCTO)
    assert r.status_code == 200, r.text
    assert r.json()["limits"]["usd"] == 5

    # member WITH manage_autonomy → allowed
    g = await client.patch(f"/api/containers/{cid}/members/{hubot}",
                           json={"grants": ["manage_autonomy"]}, headers=OCTO)
    assert g.status_code == 200, g.text
    r = await _put(client, aid, {"monthly_limit_usd": 7, "override": "grant"}, HUBOT)
    assert r.status_code == 200, r.text
    assert r.json()["limits"]["usd"] == 7 and r.json()["override"]["granted_by"] == hubot


# --------------------------------------------------------------------------- B26: stale notices

def _open(db, reason):
    return [r for r in _requests(db, reason) if r["status"] in ("open", "escalated")]


async def test_override_closes_pause_notice_and_raise_closes_warning(client, container, make_agent, db):
    hid, aid = await _setup(client, container, make_agent)
    _make_due(db, aid)
    await _put(client, aid, {"actor_agent_id": hid, "monthly_limit_usd": 10})
    _run(db, aid, cost=8.5)
    await _scan(client, container["id"])
    assert len(_open(db, "budget_warning")) == 1
    _run(db, aid, cost=2)
    await _scan(client, container["id"])
    assert len(_open(db, "budget_paused")) == 1

    # override: the pause is lifted -> the pause notice leaves Needs-you
    r = await _put(client, aid, {"actor_agent_id": hid, "override": "grant"})
    assert r.json()["paused"] is False
    assert _open(db, "budget_paused") == []
    assert len(_open(db, "budget_warning")) == 1  # still over 80%
    closed = db.execute("SELECT detail FROM events WHERE event_type='closed' AND detail->>'reason'='budget_resolved'")
    assert len(closed) == 1
    open_ids = {str(x["id"]) for x in (await client.get(
        f"/api/containers/{container['id']}/requests", params={"status": "open"})).json().get("requests", [])}
    assert not open_ids & {str(x["id"]) for x in _requests(db, "budget_paused")}

    # revoke + raise to $50 -> state ok: warning closes too; scans don't reopen anything
    await _put(client, aid, {"actor_agent_id": hid, "override": "revoke"})
    r = await _put(client, aid, {"actor_agent_id": hid, "monthly_limit_usd": 50})
    assert r.json()["state"] == "ok"
    await _scan(client, container["id"])
    await _scan(client, container["id"])
    assert _open(db, "budget_warning") == [] and _open(db, "budget_paused") == []


async def test_rearmed_pause_never_stacks_two_notices(client, container, make_agent, db):
    hid, aid = await _setup(client, container, make_agent)
    _make_due(db, aid)
    await _put(client, aid, {"actor_agent_id": hid, "monthly_limit_usd": 1})
    _run(db, aid, cost=2)
    await _scan(client, container["id"])
    assert len(_open(db, "budget_paused")) == 1
    # lower-but-still-exceeded limit re-arms paused_period -> the next scan re-fires
    await _put(client, aid, {"actor_agent_id": hid, "monthly_limit_usd": 1.5})
    await _scan(client, container["id"])
    assert len(_requests(db, "budget_paused")) == 2
    assert len(_open(db, "budget_paused")) == 1


async def test_project_override_closes_project_pause_notice(client, container, make_agent, db):
    hid, aid = await _setup(client, container, make_agent)
    _run(db, aid, cost=6)
    await client.put(f"/api/containers/{container['id']}/budget",
                     json={"actor_agent_id": hid, "monthly_limit_usd": 5})
    await _scan(client, container["id"])
    assert len(_open(db, "budget_paused")) == 1
    await client.put(f"/api/containers/{container['id']}/budget",
                     json={"actor_agent_id": hid, "override": "grant"})
    assert _open(db, "budget_paused") == []


async def test_budget_usage_reports_cache_share(client, container, make_agent, db):
    hid, aid = await _setup(client, container, make_agent)
    _run(db, aid, cost=1, tokens=(100, 50, 1000, 200))
    b = (await client.get(f"/api/agents/{aid}/budget")).json()
    assert b["usage"]["tokens"] == 1350 and b["usage"]["cache_tokens"] == 1200
