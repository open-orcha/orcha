"""General (non-code) project mode + industry templates (templates_catalog + templates_routes).

Covers: the catalog's shape and validator, the project profile (mode) with its authority
matrix in both identity lanes, the template preview (exactly what would be created, reused,
skipped, changed), and apply: human-confirmed, fingerprint-checked, created through the
existing handlers (agents, reporting lines, routines), DoD presets into the shared
project_dod_presets store (mig 956), objective, audit row + event, idempotent re-apply,
partial failures reported honestly, and Code projects left untouched.

Run: ORCHA_TEST_DB_NAME=orcha_test_on_general_mode_templates pytest tests/test_general_mode_templates.py
"""
import copy

import contextlib

import psycopg
import pytest
from fastapi import HTTPException

import conftest
from portal_backend import templates_catalog as cat
from portal_backend import templates_routes

OCTO = {"X-Auth-Request-User": "octocat"}
VERA = {"X-Auth-Request-User": "vera"}


@pytest.fixture(autouse=True)
def _team_plan(monkeypatch):
    monkeypatch.setenv("ORCHA_PLAN", "team")


@pytest.fixture
async def arena(client, container, make_agent, db):
    """Owner human (trust-off lane)."""
    owner = await make_agent("kedar", "Founder", kind="human")
    db.execute("UPDATE agents SET member_role='owner' WHERE id=%s", (owner["agent_id"],))
    return {"cid": container["id"], "owner": owner["agent_id"], "root": container["root_task_id"]}


async def preview(client, cid, key, **sel):
    r = await client.post(f"/api/containers/{cid}/templates/{key}/preview", json=sel)
    assert r.status_code == 200, r.text
    return r.json()


async def apply(client, cid, key, headers=None, **sel):
    plan = await preview(client, cid, key, **sel) if headers is None else (
        await client.post(f"/api/containers/{cid}/templates/{key}/preview", json=sel, headers=headers)).json()
    body = {**sel, "confirm": True, "plan_fingerprint": plan["plan_fingerprint"]}
    return plan, await client.post(f"/api/containers/{cid}/templates/{key}/apply", json=body, headers=headers or {})


# ---------------------------------------------------------------------------
# Catalog (pure)
# ---------------------------------------------------------------------------

def test_catalog_has_the_five_industry_templates():
    keys = [t["key"] for t in cat.CATALOG]
    assert keys == ["software-team", "marketing-team", "operations", "research", "customer-support"]
    modes = {t["key"]: t["mode"] for t in cat.CATALOG}
    assert modes["software-team"] == "code"
    assert all(m == "general" for k, m in modes.items() if k != "software-team")
    for t in cat.CATALOG:
        assert t["routines"] and t["dod_presets"] and len(t["objective_examples"]) >= 3
        assert sum(1 for r in t["roles"] if r["reports_to"] is None) == 1  # one lead


def test_every_prompt_carries_the_human_authority_rules_and_fits_its_mode():
    for t in cat.CATALOG:
        for r in t["roles"]:
            p = r["prompt"]
            assert "needs_verification" in p and "never self-certify" in p
            assert "cannot hire or create agents" in p
            if t["mode"] == "general":
                assert "DELIVERABLE" in p and "pull request" not in p
            else:
                assert "pull request" in p


def test_validator_rejects_malformed_templates():
    base = cat.get_template("marketing-team")

    def broken(mut):
        t = copy.deepcopy(base)
        mut(t)
        with pytest.raises(cat.TemplateError):
            cat.validate_template(t)

    broken(lambda t: t.update(mode="docs"))
    broken(lambda t: t["roles"][1].update(alias="Bad Alias"))
    broken(lambda t: t["roles"][1].update(alias=t["roles"][2]["alias"]))
    broken(lambda t: t["roles"][1].update(reports_to="nobody"))
    broken(lambda t: t["roles"][0].update(reports_to="content"))  # lead -> content -> lead loop
    broken(lambda t: t["routines"][0].update(assignee="nobody"))
    broken(lambda t: t["routines"][0].update(cron="61 9 * * *"))
    broken(lambda t: t["dod_presets"].append(dict(t["dod_presets"][0])))
    broken(lambda t: t.update(roles=[]))
    assert cat.validate_template(copy.deepcopy(base))["key"] == "marketing-team"


# ---------------------------------------------------------------------------
# Catalog + profile API
# ---------------------------------------------------------------------------

async def test_list_and_get_templates(client):
    r = await client.get("/api/project-templates")
    assert r.status_code == 200
    d = r.json()
    assert d["modes"] == ["code", "general"]
    mk = next(t for t in d["templates"] if t["key"] == "marketing-team")
    assert mk["mode"] == "general" and mk["routine_count"] == 2 and "prompt" not in mk["roles"][0]
    full = (await client.get("/api/project-templates/research")).json()
    assert full["roles"][0]["prompt"].startswith("You are the Research lead")
    assert (await client.get("/api/project-templates/nope")).status_code == 404


async def test_new_projects_default_to_code_mode(client, arena):
    p = (await client.get(f"/api/containers/{arena['cid']}/project-profile")).json()
    assert p == {"container_id": arena["cid"], "mode": "code", "dod_presets": [], "template_key": None,
                 "template_name": None, "last_applied_at": None}


async def test_owner_switches_mode_and_it_is_audited(client, arena, db):
    cid = arena["cid"]
    r = await client.put(f"/api/containers/{cid}/project-profile",
                         json={"mode": "general", "actor_agent_id": arena["owner"]})
    assert r.status_code == 200, r.text
    assert r.json()["mode"] == "general"
    ev = db.execute("SELECT * FROM events WHERE container_id=%s AND event_type='project_mode_changed'", (cid,))
    assert len(ev) == 1 and ev[0]["detail"] == {"from": "code", "to": "general"}
    # same mode again: no second event
    await client.put(f"/api/containers/{cid}/project-profile", json={"mode": "general", "actor_agent_id": arena["owner"]})
    assert len(db.execute("SELECT 1 FROM events WHERE event_type='project_mode_changed'")) == 1
    # back to code; nothing else changed
    r = await client.put(f"/api/containers/{cid}/project-profile", json={"mode": "code", "actor_agent_id": arena["owner"]})
    assert r.json()["mode"] == "code"


async def test_mode_authority_trust_off(client, arena, make_agent, db):
    cid = arena["cid"]
    url = f"/api/containers/{cid}/project-profile"
    ai = await make_agent("forge", "Builder")
    assert (await client.put(url, json={"mode": "general", "actor_agent_id": ai["agent_id"]})).status_code == 403
    m = await make_agent("hubot", "Dev", kind="human")
    x = await client.put(url, json={"mode": "general", "actor_agent_id": m["agent_id"]})
    assert x.status_code == 403 and "manage_autonomy" in x.text
    db.execute("""UPDATE agents SET grants='["manage_autonomy"]' WHERE id=%s""", (m["agent_id"],))
    assert (await client.put(url, json={"mode": "general", "actor_agent_id": m["agent_id"]})).status_code == 200
    v = await make_agent("vera", "Viewer", kind="human")
    db.execute("""UPDATE agents SET member_role='viewer', grants='["manage_autonomy"]' WHERE id=%s""",
               (v["agent_id"],))
    assert (await client.put(url, json={"mode": "code", "actor_agent_id": v["agent_id"]})).status_code == 403
    assert (await client.put(url, json={"mode": "code"})).status_code == 400  # no actor
    assert (await client.put(url, json={"mode": "docs", "actor_agent_id": arena["owner"]})).status_code == 422
    assert (await client.put(url, json={"actor_agent_id": arena["owner"]})).status_code == 422
    assert db.execute("SELECT project_mode FROM containers WHERE id=%s", (cid,))[0]["project_mode"] == "general"


async def test_bad_ids(client):
    assert (await client.get("/api/containers/not-a-uuid/project-profile")).status_code == 400
    missing = "00000000-0000-0000-0000-000000000000"
    assert (await client.get(f"/api/containers/{missing}/project-profile")).status_code == 404
    r = await client.post(f"/api/containers/{missing}/templates/research/preview", json={})
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Preview
# ---------------------------------------------------------------------------

async def test_preview_shows_exactly_what_would_happen_and_writes_nothing(client, arena, db):
    cid = arena["cid"]
    plan = await preview(client, cid, "marketing-team", actor_agent_id=arena["owner"], timezone="Africa/Nairobi",
                         objective="Launch the new tier")
    assert plan["template"] == {"key": "marketing-team", "version": 1, "name": "Marketing team", "mode": "general"}
    assert [a["alias"] for a in plan["agents"]] == [
        "marketing-lead", "content-writer", "seo-specialist", "social-manager", "marketing-analyst"]
    assert all(a["action"] == "create" for a in plan["agents"])
    lines = {line["alias"]: line["reports_to"] for line in plan["reporting"]}
    assert lines["marketing-lead"] == "kedar" and lines["content-writer"] == "marketing-lead"
    cal = next(r for r in plan["routines"] if r["key"] == "content-calendar")
    assert cal["assignee_alias"] == "marketing-lead" and cal["enabled"] is False
    assert cal["timezone"] == "Africa/Nairobi" and "Monday" in cal["schedule_text"]
    assert plan["mode"] == {"from": "code", "to": "general", "change": True}
    assert [p["name"] for p in plan["dod_presets"]] == ["Blog post", "Campaign brief", "Social post pack", "Newsletter"]
    assert plan["objective"] == {"from": None, "to": "Launch the new tier"}
    assert plan["counts"] == {"agents_to_create": 5, "routines_to_create": 2, "dod_presets_to_add": 4, "skipped": 0}
    # deterministic fingerprint; changes with the selection
    again = await preview(client, cid, "marketing-team", actor_agent_id=arena["owner"], timezone="Africa/Nairobi",
                          objective="Launch the new tier")
    assert again["plan_fingerprint"] == plan["plan_fingerprint"]
    other = await preview(client, cid, "marketing-team", actor_agent_id=arena["owner"], timezone="UTC")
    assert other["plan_fingerprint"] != plan["plan_fingerprint"]
    # nothing written
    assert len(db.execute("SELECT 1 FROM agents WHERE container_id=%s", (cid,))) == 1
    assert db.execute("SELECT count(*) AS n FROM routines")[0]["n"] == 0
    assert db.execute("SELECT project_mode FROM containers WHERE id=%s", (cid,))[0]["project_mode"] == "code"


async def test_preview_reuses_live_ai_and_skips_humans_and_retired(client, arena, make_agent, db):
    cid = arena["cid"]
    await make_agent("marketing-lead", "Our own lead")
    await make_agent("seo-specialist", "Someone", kind="human")
    old = await make_agent("social-manager", "Retired")
    db.execute("UPDATE agents SET terminated_at=now() WHERE id=%s", (old["agent_id"],))
    plan = await preview(client, cid, "marketing-team", actor_agent_id=arena["owner"])
    act = {a["alias"]: (a["action"], a["reason"]) for a in plan["agents"]}
    assert act["marketing-lead"] == ("reuse", "already on the roster — kept as is")
    assert act["seo-specialist"][0] == "skip" and "human" in act["seo-specialist"][1]
    assert act["social-manager"][0] == "skip" and "retired" in act["social-manager"][1]
    lines = {line["alias"]: line["reports_to"] for line in plan["reporting"]}
    assert "marketing-lead" not in lines  # existing agents are never rewired
    assert lines["content-writer"] == "marketing-lead"  # reuses the existing lead as manager
    assert plan["counts"]["agents_to_create"] == 2 and plan["counts"]["skipped"] == 2


async def test_preview_validates_selection(client, arena):
    cid = arena["cid"]
    r = await client.post(f"/api/containers/{cid}/templates/research/preview", json={"roles": ["lead", "ghost"]})
    assert r.status_code == 422 and "ghost" in r.text
    r = await client.post(f"/api/containers/{cid}/templates/research/preview", json={"routines": ["nope"]})
    assert r.status_code == 422
    r = await client.post(f"/api/containers/{cid}/templates/research/preview", json={"timezone": "Mars/Base"})
    assert r.status_code == 422
    assert (await client.post(f"/api/containers/{cid}/templates/zzz/preview", json={})).status_code == 404


async def test_subset_selection_without_the_lead(client, arena):
    plan = await preview(client, arena["cid"], "marketing-team", actor_agent_id=arena["owner"],
                         roles=["content"], routines=["content-calendar"], set_mode=False, dod_presets=False)
    assert [a["alias"] for a in plan["agents"]] == ["content-writer"]
    assert plan["reporting"] == [{"alias": "content-writer", "reports_to": "kedar"}]
    (cal,) = plan["routines"]
    assert cal["assignee_alias"] is None and "assigned normally" in cal["assignee_note"]
    assert plan["mode"]["change"] is False and plan["dod_presets"] == []


# ---------------------------------------------------------------------------
# Apply
# ---------------------------------------------------------------------------

async def test_apply_creates_everything_through_the_normal_paths(client, arena, db):
    cid = arena["cid"]
    plan, r = await apply(client, cid, "marketing-team", actor_agent_id=arena["owner"], timezone="Africa/Nairobi",
                          objective="Reach 500 trial sign-ups in 6 weeks")
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["ok"] is True and out["result"]["failures"] == []
    assert {a["status"] for a in out["result"]["agents"]} == {"created"}
    agents = {a["alias"]: a for a in db.execute(
        "SELECT alias, role, kind, system_prompt, is_auto_created, reports_to_agent_id, id FROM agents "
        "WHERE container_id=%s", (cid,))}
    assert set(agents) == {"kedar", "marketing-lead", "content-writer", "seo-specialist", "social-manager",
                           "marketing-analyst"}
    lead = agents["marketing-lead"]
    assert lead["kind"] == "ai" and lead["is_auto_created"] is False  # created by the human's confirmation
    assert "DELIVERABLE" in lead["system_prompt"]
    assert str(lead["reports_to_agent_id"]) == arena["owner"]
    assert agents["content-writer"]["reports_to_agent_id"] == lead["id"]
    # routines: normal, paused, assigned, in the chosen zone
    rts = db.execute("SELECT r.*, a.alias FROM routines r LEFT JOIN agents a ON a.id=r.assignee_agent_id "
                     "WHERE r.container_id=%s ORDER BY r.title", (cid,))
    assert [(x["alias"], x["enabled"], x["next_run_at"], x["timezone"]) for x in rts] == [
        ("marketing-lead", False, None, "Africa/Nairobi"), ("marketing-analyst", False, None, "Africa/Nairobi")]
    assert str(rts[0]["created_by_agent_id"]) == arena["owner"]
    # presets in the shared store
    presets = db.execute("SELECT name, source, created_by_agent_id FROM project_dod_presets "
                         "WHERE container_id=%s ORDER BY name", (cid,))
    assert [p["name"] for p in presets] == ["Blog post", "Campaign brief", "Newsletter", "Social post pack"]
    assert {p["source"] for p in presets} == {"template_import"}
    # mode + objective
    c = db.execute("SELECT project_mode, template_key, description FROM containers WHERE id=%s", (cid,))[0]
    assert c == {"project_mode": "general", "template_key": "marketing-team",
                 "description": "Reach 500 trial sign-ups in 6 weeks"}
    root = db.execute("SELECT description FROM tasks WHERE id=%s", (arena["root"],))[0]
    assert root["description"] == "Reach 500 trial sign-ups in 6 weeks"
    # audit
    appl = db.execute("SELECT * FROM project_template_applications WHERE container_id=%s", (cid,))
    assert len(appl) == 1 and str(appl[0]["applied_by_agent_id"]) == arena["owner"]
    assert appl[0]["plan"]["counts"] == plan["counts"]
    ev = db.execute("SELECT detail FROM events WHERE container_id=%s AND event_type='template_applied'", (cid,))
    assert ev[0]["detail"]["agents_created"] == 5 and ev[0]["detail"]["routines_created"] == 2
    assert db.execute("SELECT count(*) AS n FROM events WHERE event_type='routine_created'")[0]["n"] == 2
    assert db.execute("SELECT count(*) AS n FROM events WHERE event_type='agent_reports_to_changed'")[0]["n"] == 5
    # the profile + history reflect it
    prof = (await client.get(f"/api/containers/{cid}/project-profile")).json()
    assert prof["mode"] == "general" and prof["template_name"] == "Marketing team" and len(prof["dod_presets"]) == 4
    hist = (await client.get(f"/api/containers/{cid}/template-applications")).json()["applications"]
    assert hist[0]["applied_by_alias"] == "kedar" and hist[0]["template_key"] == "marketing-team"


async def test_reapply_is_idempotent(client, arena, db):
    cid = arena["cid"]
    _, r = await apply(client, cid, "research", actor_agent_id=arena["owner"])
    assert r.status_code == 201
    plan = await preview(client, cid, "research", actor_agent_id=arena["owner"])
    assert plan["counts"] == {"agents_to_create": 0, "routines_to_create": 0, "dod_presets_to_add": 0,
                              "skipped": 4}  # 1 routine + 3 presets skipped; 4 agents reused
    assert {a["action"] for a in plan["agents"]} == {"reuse"}
    first = db.execute("SELECT id FROM project_template_applications WHERE container_id=%s", (cid,))
    events_before = db.execute("SELECT count(*) AS n FROM events WHERE event_type='template_applied'")[0]["n"]
    _, r = await apply(client, cid, "research", actor_agent_id=arena["owner"])
    # A16b: a no-op re-apply records nothing — 200 (not 201), noop, points at the existing row
    assert r.status_code == 200 and r.json()["ok"] and r.json()["noop"] is True
    assert r.json()["application_id"] == str(first[0]["id"])
    assert {a["status"] for a in r.json()["result"]["agents"]} == {"reuse"}
    assert db.execute("SELECT count(*) AS n FROM agents WHERE container_id=%s AND kind='ai'", (cid,))[0]["n"] == 4
    assert db.execute("SELECT count(*) AS n FROM routines")[0]["n"] == 1
    assert db.execute("SELECT count(*) AS n FROM project_dod_presets")[0]["n"] == 3
    assert len(db.execute("SELECT id FROM project_template_applications WHERE container_id=%s", (cid,))) == 1
    assert db.execute("SELECT count(*) AS n FROM events WHERE event_type='template_applied'")[0]["n"] == events_before
    hist = (await client.get(f"/api/containers/{cid}/template-applications")).json()["applications"]
    assert len(hist) == 1


async def test_reapply_that_changes_something_is_still_recorded(client, arena, db):
    """Only a true no-op skips the audit row: a new objective, or a different template whose
    items all exist already (template_key changes), is a real application (A16b)."""
    cid = arena["cid"]
    _, r = await apply(client, cid, "research", actor_agent_id=arena["owner"])
    assert r.status_code == 201 and r.json()["noop"] is False
    _, r = await apply(client, cid, "research", actor_agent_id=arena["owner"], objective="Map the field in 4 weeks")
    assert r.status_code == 201 and r.json()["noop"] is False
    assert db.execute("SELECT description FROM containers WHERE id=%s", (cid,))[0]["description"] == \
        "Map the field in 4 weeks"
    # the same objective again is a no-op
    _, r = await apply(client, cid, "research", actor_agent_id=arena["owner"], objective="Map the field in 4 weeks")
    assert r.status_code == 200 and r.json()["noop"] is True
    assert len(db.execute("SELECT id FROM project_template_applications WHERE container_id=%s", (cid,))) == 2
    # the project's mode being switched back by a human makes a re-apply meaningful again
    db.execute("UPDATE containers SET project_mode='code' WHERE id=%s", (cid,))
    _, r = await apply(client, cid, "research", actor_agent_id=arena["owner"])
    assert r.status_code == 201 and r.json()["result"]["mode"]["to"] == "general"
    assert len(db.execute("SELECT id FROM project_template_applications WHERE container_id=%s", (cid,))) == 3


async def test_openapi_documents_the_noop_200(client):
    spec = (await client.get("/openapi.json")).json()
    resp = spec["paths"]["/api/containers/{cid}/templates/{key}/apply"]["post"]["responses"]
    assert "201" in resp and "200" in resp and "No-op" in resp["200"]["description"]


async def test_stale_preview_is_refused_with_the_fresh_plan(client, arena, make_agent, db):
    cid = arena["cid"]
    plan = await preview(client, cid, "operations", actor_agent_id=arena["owner"])
    await make_agent("ops-lead", "Made meanwhile")  # the project changed
    r = await client.post(f"/api/containers/{cid}/templates/operations/apply", json={
        "actor_agent_id": arena["owner"], "confirm": True, "plan_fingerprint": plan["plan_fingerprint"]})
    assert r.status_code == 409
    fresh = r.json()["detail"]["plan"]
    assert next(a for a in fresh["agents"] if a["alias"] == "ops-lead")["action"] == "reuse"
    assert db.execute("SELECT count(*) AS n FROM agents WHERE kind='ai'")[0]["n"] == 1  # nothing created


async def test_apply_requires_explicit_confirmation(client, arena, db):
    plan = await preview(client, arena["cid"], "operations", actor_agent_id=arena["owner"])
    r = await client.post(f"/api/containers/{arena['cid']}/templates/operations/apply", json={
        "actor_agent_id": arena["owner"], "confirm": False, "plan_fingerprint": plan["plan_fingerprint"]})
    assert r.status_code == 400
    r = await client.post(f"/api/containers/{arena['cid']}/templates/operations/apply", json={
        "actor_agent_id": arena["owner"], "plan_fingerprint": plan["plan_fingerprint"]})
    assert r.status_code == 422
    assert db.execute("SELECT count(*) AS n FROM agents WHERE kind='ai'")[0]["n"] == 0


async def test_apply_authority_trust_off(client, arena, make_agent, db):
    cid = arena["cid"]
    ai = await make_agent("forge", "Builder")
    _, r = await apply(client, cid, "research", actor_agent_id=ai["agent_id"])
    assert r.status_code == 403
    m = await make_agent("hubot", "Dev", kind="human")
    _, r = await apply(client, cid, "research", actor_agent_id=m["agent_id"])
    assert r.status_code == 403 and "manage_agents" in r.text
    # manage_agents alone may apply, but not switch the project's mode
    db.execute("""UPDATE agents SET grants='["manage_agents"]' WHERE id=%s""", (m["agent_id"],))
    _, r = await apply(client, cid, "research", actor_agent_id=m["agent_id"])
    assert r.status_code == 403 and "manage_autonomy" in r.text
    _, r = await apply(client, cid, "research", actor_agent_id=m["agent_id"], set_mode=False)
    assert r.status_code == 201, r.text
    assert db.execute("SELECT project_mode FROM containers WHERE id=%s", (cid,))[0]["project_mode"] == "code"


async def test_trusted_lane_viewer_previews_but_cannot_apply(client, container, make_agent, db, monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    assert (await client.get(f"/api/me?cid={cid}", headers=OCTO)).json()["identity"]["member_role"] == "owner"
    r = await client.post(f"/api/containers/{cid}/members", json={"github_login": "vera", "role": "viewer"},
                          headers=OCTO)
    assert r.status_code == 201, r.text
    # viewer: reads the profile and a preview, cannot switch mode or apply
    assert (await client.get(f"/api/containers/{cid}/project-profile", headers=VERA)).status_code == 200
    _, r = await apply(client, cid, "customer-support", headers=VERA)
    assert r.status_code == 403
    assert (await client.put(f"/api/containers/{cid}/project-profile", json={"mode": "general"},
                             headers=VERA)).status_code == 403
    # a stranger can't even read
    assert (await client.get(f"/api/containers/{cid}/project-profile",
                             headers={"X-Auth-Request-User": "mallory"})).status_code == 403
    # owner applies (body actor ignored; the proxy identity is the actor)
    plan, r = await apply(client, cid, "customer-support", headers=OCTO, enable_routines=True)
    assert r.status_code == 201, r.text
    assert {line["reports_to"] for line in plan["reporting"]} == {"octocat", "support-lead"}
    rts = db.execute("SELECT enabled, next_run_at, created_by_agent_id FROM routines WHERE container_id=%s", (cid,))
    assert len(rts) == 2 and all(x["enabled"] and x["next_run_at"] is not None for x in rts)
    who = db.execute("SELECT a.alias FROM project_template_applications p JOIN agents a ON a.id=p.applied_by_agent_id")
    assert who[0]["alias"] == "octocat"


async def test_code_template_keeps_a_code_project_as_is(client, arena, db):
    cid = arena["cid"]
    plan, r = await apply(client, cid, "software-team", actor_agent_id=arena["owner"])
    assert plan["mode"] == {"from": "code", "to": "code", "change": False}
    assert r.status_code == 201 and r.json()["result"]["mode"] is None
    assert db.execute("SELECT project_mode FROM containers WHERE id=%s", (cid,))[0]["project_mode"] == "code"
    assert db.execute("SELECT count(*) AS n FROM events WHERE event_type='project_mode_changed'")[0]["n"] == 0
    prompt = db.execute("SELECT system_prompt FROM agents WHERE alias='backend-dev'")[0]["system_prompt"]
    assert "pull request" in prompt


async def test_a_failing_item_is_reported_not_hidden(client, arena, db, monkeypatch):
    def boom(*_a, **_k):
        raise HTTPException(422, "schedule refused (test)")

    monkeypatch.setattr(templates_routes, "create_routine", boom)
    _, r = await apply(client, arena["cid"], "research", actor_agent_id=arena["owner"])
    assert r.status_code == 201
    out = r.json()
    assert out["ok"] is False
    assert out["result"]["failures"] == ["routine Literature digest {{date}}: schedule refused (test)"]
    assert out["result"]["routines"][0]["status"] == "failed"
    # everything else was still created, and the audit row records the failure
    assert db.execute("SELECT count(*) AS n FROM agents WHERE kind='ai'")[0]["n"] == 4
    appl = db.execute("SELECT result FROM project_template_applications")[0]
    assert appl["result"]["failures"]


@contextlib.contextmanager
def _hold_template_lock(cid):
    """Hold the per-project apply lock from outside the request (GH #258: per backend)."""
    if conftest.BACKEND == "postgres":
        with psycopg.connect(conftest.TEST_URL, autocommit=True) as holder:
            holder.execute("SELECT pg_advisory_lock(hashtext('orcha-template:' || %s))", (cid,))
            yield
        return
    from portal_backend import templates_routes

    templates_routes._APPLYING.add(cid)
    try:
        yield
    finally:
        templates_routes._APPLYING.discard(cid)


async def test_concurrent_apply_is_refused_while_one_is_running(client, arena):
    """The per-project advisory lock: a second apply while one holds it gets a clean 409."""
    plan = await preview(client, arena["cid"], "research", actor_agent_id=arena["owner"])
    with _hold_template_lock(arena["cid"]):
        r = await client.post(f"/api/containers/{arena['cid']}/templates/research/apply", json={
            "actor_agent_id": arena["owner"], "confirm": True, "plan_fingerprint": plan["plan_fingerprint"]})
        assert r.status_code == 409 and "already being applied" in r.text
    _, r = await apply(client, arena["cid"], "research", actor_agent_id=arena["owner"])
    assert r.status_code == 201
