"""Portable project templates — export / preview / import + the template library.

Covers: a versioned bundle with roster (roles, prompts, models, effort, auto-wake,
autonomy overrides, reporting lines), routines, DoD presets, skills and opt-in budgets;
secret / key / token / member-identity scrubbing (nothing identifying survives in the
JSON); import into a NEW and an EXISTING project with a preview diff, alias collision
handling (skip / rename / invalid rename), human confirmation bound to the preview
digest, stale-preview refusal, audit events, owner / manage_agents authority (and the
manage_autonomy-only parts), bundle validation, and a lossless round trip.

Migration 059 creates the tables (applied by conftest with every 0*.sql migration).
"""
import copy
import json

import pytest


from portal_backend import project_export_bundle as pb  # noqa: E402
from portal_backend import project_export_library_routes  # noqa: E402,F401
from portal_backend import project_export_routes  # noqa: E402,F401

OCTO = {"X-Auth-Request-User": "octocat"}
HUBOT = {"X-Auth-Request-User": "hubot"}
VERA = {"X-Auth-Request-User": "vera"}
MALLORY = {"X-Auth-Request-User": "mallory"}

ANT_KEY = "sk-ant-api03-AAAAbbbbCCCCddddEEEEffff0123456789"
GH_PAT = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"


# --------------------------------------------------------------------------- helpers
async def _ok(r, code=200):
    assert r.status_code == code, r.text
    return r.json()


async def _export(client, cid, actor=None, headers=None, **kw):
    body = {"actor_agent_id": actor, **kw}
    return await client.post(f"/api/containers/{cid}/template/export", json=body, headers=headers or {})


async def _preview(client, cid, bundle, actor=None, headers=None, options=None):
    return await client.post(f"/api/containers/{cid}/template/preview", headers=headers or {},
                             json={"actor_agent_id": actor, "bundle": bundle, "options": options or {}})


async def _import(client, cid, bundle, digest, actor=None, headers=None, options=None, confirm=True):
    return await client.post(f"/api/containers/{cid}/template/import", headers=headers or {}, json={
        "actor_agent_id": actor, "bundle": bundle, "options": options or {},
        "confirm": confirm, "preview_digest": digest})


async def _preview_and_import(client, cid, bundle, actor=None, headers=None, options=None):
    p = await _ok(await _preview(client, cid, bundle, actor, headers, options))
    r = await _import(client, cid, bundle, p["preview_digest"], actor, headers, options)
    return p, r


async def _new_project(client, name, headers=None):
    d = await _ok(await client.post("/api/containers", json={"name": name, "additional": True},
                                    headers=headers or {}), 201)
    return d["container_id"], d["human_agent_id"]


@pytest.fixture
async def seeded(client, container, make_agent, db):
    """A realistic source project: owner 'hussein' (github login + email), a lead + two
    workers, reporting lines (one to the human), a routine, presets, skills, budgets —
    with secrets and member identities planted in free text."""
    cid = container["id"]
    r = await client.post(f"/api/containers/{cid}/agents", json={
        "alias": "hussein", "role": "operator", "kind": "human",
        "github_login": "hussein-gh", "git_email": "hussein@quantal.dev"})
    owner = (await _ok(r, 201))["agent_id"]
    lead = (await make_agent("Atlas", "lead", prompt=(
        "You lead the team. Ask hussein (@hussein-gh, hussein@quantal.dev) before merging.\n"
        f"Use ANTHROPIC key {ANT_KEY} and password=hunter2hunter2 for staging.")))["agent_id"]
    forge = (await make_agent("Forge", "backend engineer", prompt=(
        f"Backend. GitHub token {GH_PAT}. Call the API with Authorization: Bearer {JWT}. "
        "DB at postgres://svc:s3cretPass@db.internal:5432/app")))["agent_id"]
    pixel = (await make_agent("Pixel", "frontend engineer", prompt="Frontend work only."))["agent_id"]
    # config through the real routes
    await _ok(await client.post(f"/api/agents/{forge}/model", json={"model": "gpt-5.6-sol"}))
    await _ok(await client.post(f"/api/agents/{forge}/reasoning-effort", json={"reasoning_effort": "ultra"}))
    await _ok(await client.patch(f"/api/agents/{pixel}", json={"actor_agent_id": owner, "autonomy_override": "pr"}))
    await _ok(await client.patch(f"/api/agents/{lead}/auto-wake", json={"actor_agent_id": owner, "interval_secs": 3600}))
    for aid, mgr in ((lead, owner), (forge, lead), (pixel, lead)):
        await _ok(await client.put(f"/api/agents/{aid}/reports-to",
                                   json={"actor_agent_id": owner, "reports_to_agent_id": mgr}))
    # a run token that exists in this stack, pasted into a prompt
    tok = await _ok(await client.post(f"/api/agents/{pixel}/embodiment-tokens",
                                      json={"lane": "work", "kind": "headless"}), 201)
    await _ok(await client.patch(f"/api/agents/{pixel}", json={
        "actor_agent_id": owner, "system_prompt": f"Frontend work only. Token {tok['run_token']}"}))
    await _ok(await client.post(f"/api/containers/{cid}/routines", json={
        "actor_agent_id": owner, "title": "Weekly dependency audit",
        "description": "Ping hussein when done", "definition_of_done": "Report posted",
        "assignee_agent_id": forge, "cron": "0 9 * * 1", "timezone": "Africa/Nairobi"}), 201)
    await _ok(await client.post(f"/api/containers/{cid}/dod-presets", json={
        "actor_agent_id": owner, "name": "Web feature done",
        "body": "Tests pass, screenshots attached, reviewed by hussein-gh"}), 201)
    await _ok(await client.post(f"/api/containers/{cid}/skills", json={
        "actor_agent_id": owner, "name": "release-checklist", "description": "How we ship",
        "body": "1. Tag\n2. api_key: abcdef123456 in the vault\n3. Announce"}), 201)
    await _ok(await client.put(f"/api/agents/{forge}/budget", json={
        "actor_agent_id": owner, "monthly_limit_usd": 50, "monthly_limit_tokens": 2000000}))
    await _ok(await client.put(f"/api/containers/{cid}/budget", json={
        "actor_agent_id": owner, "monthly_limit_usd": 200, "override": "grant", "note": "demo"}))
    return {"cid": cid, "owner": owner, "lead": lead, "forge": forge, "pixel": pixel,
            "run_token": tok["run_token"]}


# --------------------------------------------------------------------------- export
async def test_export_carries_the_setup(client, seeded):
    b = await _ok(await _export(client, seeded["cid"], seeded["owner"]))
    assert b["format"] == "orcha.project-template" and b["version"] == 1
    assert b["source"]["project_name"] == "test-arena"
    assert b["includes"] == ["roster", "routines", "dod_presets", "skills"]
    roster = {a["alias"]: a for a in b["roster"]}
    assert set(roster) == {"Atlas", "Forge", "Pixel"}  # AI only; humans are never exported
    assert roster["Forge"]["model"] == "gpt-5.6-sol" and roster["Forge"]["reasoning_effort"] == "ultra"
    assert roster["Pixel"]["autonomy_override"] == "pr"
    assert roster["Atlas"]["auto_wake_interval_secs"] == 3600
    assert roster["Forge"]["reports_to"] == {"kind": "agent", "ref": "Atlas"}
    assert roster["Atlas"]["reports_to"] == {"kind": "human_seat", "ref": "human-1"}
    assert b["human_seats"] == [{"ref": "human-1", "label": "Human seat 1"}]
    [rt] = b["routines"]
    assert rt["assignee"] == "Forge" and rt["cron"] == "0 9 * * 1" and rt["timezone"] == "Africa/Nairobi"
    assert b["dod_presets"][0]["name"] == "Web feature done"
    assert b["skills"][0]["name"] == "release-checklist"
    assert "budgets" not in b  # opt-in only
    assert b["digest"] == pb.bundle_digest(b)


async def test_export_scrubs_secrets_tokens_and_member_identities(client, seeded, db):
    b = await _ok(await _export(client, seeded["cid"], seeded["owner"], include_budgets=True))
    text = json.dumps(b)
    for leaked in (ANT_KEY, GH_PAT, JWT, "hunter2hunter2", "s3cretPass", seeded["run_token"],
                   "abcdef123456", "hussein-gh", "hussein@quantal.dev", "quantal.dev",
                   seeded["owner"], "octocat"):
        assert leaked not in text, leaked
    assert "hussein" not in text.lower()  # the human alias itself, in any case
    atlas = next(a for a in b["roster"] if a["alias"] == "Atlas")
    assert "[member]" in atlas["system_prompt"] and "[email]" in atlas["system_prompt"]
    assert "password=[redacted secret]" in atlas["system_prompt"]
    forge = next(a for a in b["roster"] if a["alias"] == "Forge")
    assert "Bearer [redacted secret]" in forge["system_prompt"]
    assert "postgres://[redacted]@db.internal" in forge["system_prompt"]
    red = {r["field"]: set(r["kinds"]) for r in b["scrub"]["redactions"]}
    assert red["roster[Atlas].system_prompt"] == {"secret", "email", "member_identity"}
    assert red["roster[Forge].system_prompt"] == {"secret"}
    assert "secret" in red["roster[Pixel].system_prompt"]
    assert "member_identity" in red["routines[1].description"]
    assert "member_identity" in red["dod_presets[Web feature done].body"]
    assert "secret" in red["skills[release-checklist].body"]
    assert b["scrub"]["never_exported"]
    # the DB is untouched: export scrubs a copy, never the source
    row = db.execute("SELECT system_prompt FROM agents WHERE id=%s", (seeded["lead"],))[0]
    assert ANT_KEY in row["system_prompt"]
    # budgets: limits only — no override, note, period or spend
    assert b["budgets"]["project"] == {"monthly_limit_usd": 200, "monthly_limit_tokens": None}
    assert b["budgets"]["agents"] == [{"alias": "Forge", "monthly_limit_usd": 50, "monthly_limit_tokens": 2000000}]
    assert "override" not in json.dumps(b["budgets"]) and "demo" not in json.dumps(b["budgets"])


async def test_export_is_audited_and_excludes_retired_and_archived(client, seeded, db):
    await _ok(await client.post(f"/api/agents/{seeded['pixel']}/retire",
                                json={"actor_agent_id": seeded["owner"]}))
    b = await _ok(await _export(client, seeded["cid"], seeded["owner"]))
    assert "Pixel" not in {a["alias"] for a in b["roster"]}
    ev = db.execute("SELECT * FROM events WHERE event_type='template_exported'")
    assert len(ev) == 1 and str(ev[0]["actor_id"]) == seeded["owner"]
    assert ev[0]["detail"]["counts"]["roster"] == 2 and ev[0]["detail"]["redacted_fields"] > 0


# --------------------------------------------------------------------------- import: new project
async def test_import_into_new_project_preview_then_apply(client, seeded, db):
    bundle = await _ok(await _export(client, seeded["cid"], seeded["owner"], include_budgets=True))
    cid2, me = await _new_project(client, "copy")
    p = await _ok(await _preview(client, cid2, bundle, me))
    assert p["bundle"]["digest_ok"] is True and p["bundle"]["project_name"] == "test-arena"
    assert p["errors"] == [] and p["changes"] > 0
    assert [(i["alias"], i["action"]) for i in p["sections"]["roster"]] == [
        ("Atlas", "create"), ("Forge", "create"), ("Pixel", "create")]
    lines = {ln["alias"]: ln for ln in p["sections"]["reporting_lines"]}
    assert lines["Atlas"]["manager"]["label"] == "you" and lines["Forge"]["manager"]["alias"] == "Atlas"
    [rt] = p["sections"]["routines"]
    assert rt["action"] == "create" and rt["enabled"] is False and "imported paused" in rt["notes"][0]
    # the preview writes nothing
    assert db.execute("SELECT count(*) AS n FROM agents WHERE container_id=%s", (cid2,))[0]["n"] == 1

    r = await _ok(await _import(client, cid2, bundle, p["preview_digest"], me))
    assert {a["alias"] for a in r["agents"]} == {"Atlas", "Forge", "Pixel"}
    rows = {x["alias"]: x for x in db.execute(
        """SELECT a.alias, a.role, a.model, a.reasoning_effort, a.autonomy_override,
                  a.auto_wake_interval_secs, a.system_prompt, a.is_auto_created, a.member_role,
                  m.alias AS mgr FROM agents a LEFT JOIN agents m ON m.id=a.reports_to_agent_id
            WHERE a.container_id=%s AND a.kind='ai'""", (cid2,))}
    assert rows["Forge"]["model"] == "gpt-5.6-sol" and rows["Forge"]["reasoning_effort"] == "ultra"
    assert rows["Pixel"]["autonomy_override"] == "pr" and rows["Atlas"]["auto_wake_interval_secs"] == 3600
    assert rows["Atlas"]["mgr"] == "operator" and rows["Forge"]["mgr"] == "Atlas"  # seat → the importer
    assert rows["Forge"]["is_auto_created"] is False and rows["Forge"]["member_role"] == "member"
    assert ANT_KEY not in rows["Atlas"]["system_prompt"]  # the scrubbed text is what lands
    [routine] = db.execute("SELECT * FROM routines WHERE container_id=%s", (cid2,))
    assert routine["enabled"] is False and routine["next_run_at"] is None
    assert str(routine["created_by_agent_id"]) == me
    assert db.execute("SELECT alias FROM agents WHERE id=%s", (routine["assignee_agent_id"],))[0]["alias"] == "Forge"
    assert db.execute("SELECT name, source FROM project_dod_presets WHERE container_id=%s", (cid2,)) == [
        {"name": "Web feature done", "source": "template_import"}]
    assert db.execute("SELECT name FROM project_skills WHERE container_id=%s", (cid2,)) == [{"name": "release-checklist"}]
    cb = db.execute("SELECT * FROM container_budgets WHERE container_id=%s", (cid2,))[0]
    assert float(cb["monthly_limit_usd"]) == 200 and cb["override_period"] is None
    ab = db.execute("SELECT * FROM agent_budgets WHERE container_id=%s", (cid2,))
    assert len(ab) == 1 and float(ab[0]["monthly_limit_usd"]) == 50
    # audit: one summary event + per-object events, all attributed to the importing human
    [summary] = db.execute("SELECT * FROM events WHERE event_type='template_imported' AND container_id=%s", (cid2,))
    assert str(summary["actor_id"]) == me and summary["detail"]["source_project"] == "test-arena"
    assert sorted(summary["detail"]["created_agents"]) == ["Atlas", "Forge", "Pixel"]
    created = db.execute("SELECT * FROM events WHERE container_id=%s AND event_type='created' "
                         "AND detail->>'via'='template_import'", (cid2,))
    assert len(created) == 3 and all(str(e["actor_id"]) == me for e in created)
    for et in ("agent_reports_to_changed", "routine_created", "dod_preset_created", "skill_created", "budget_updated"):
        assert db.execute("SELECT 1 FROM events WHERE container_id=%s AND event_type=%s", (cid2, et)), et


async def test_round_trip_is_lossless(client, seeded):
    a = await _ok(await _export(client, seeded["cid"], seeded["owner"], include_budgets=True))
    cid2, me = await _new_project(client, "copy")
    _, r = await _preview_and_import(client, cid2, a, me)
    await _ok(r)
    b = await _ok(await _export(client, cid2, me, include_budgets=True))
    strip = ("exported_at", "digest", "source", "scrub")
    a2 = {k: v for k, v in a.items() if k not in strip}
    b2 = {k: v for k, v in b.items() if k not in strip}
    # routines come back paused (import never silently starts schedules)
    for rt in a2["routines"]:
        rt["enabled"] = False
    assert a2 == b2


async def test_enable_routines_option_schedules_them(client, seeded, db):
    bundle = await _ok(await _export(client, seeded["cid"], seeded["owner"]))
    cid2, me = await _new_project(client, "copy")
    _, r = await _preview_and_import(client, cid2, bundle, me, options={"enable_routines": True})
    await _ok(r)
    [routine] = db.execute("SELECT * FROM routines WHERE container_id=%s", (cid2,))
    assert routine["enabled"] is True and routine["next_run_at"] is not None


async def test_human_seat_unassigned_option(client, seeded, db):
    bundle = await _ok(await _export(client, seeded["cid"], seeded["owner"]))
    cid2, me = await _new_project(client, "copy")
    p, r = await _preview_and_import(client, cid2, bundle, me, options={"human_seats": "unassigned"})
    await _ok(r)
    atlas = next(ln for ln in p["sections"]["reporting_lines"] if ln["alias"] == "Atlas")
    assert atlas["action"] == "skip" and "left unassigned" in atlas["note"]
    assert db.execute("SELECT reports_to_agent_id FROM agents WHERE container_id=%s AND alias='Atlas'",
                      (cid2,))[0]["reports_to_agent_id"] is None


# --------------------------------------------------------------------------- import: existing project
async def test_reimport_into_same_project_skips_collisions_by_default(client, seeded, db):
    cid = seeded["cid"]
    bundle = await _ok(await _export(client, cid, seeded["owner"]))
    p = await _ok(await _preview(client, cid, bundle, seeded["owner"]))
    assert all(i["action"] == "skip" and i["collision"] for i in p["sections"]["roster"])
    assert p["sections"]["roster"][0]["suggested_alias"] == "Atlas-2"
    assert p["sections"]["routines"][0]["action"] == "skip"
    assert p["sections"]["dod_presets"][0]["action"] == "rename"  # scrubbed text differs from the original
    assert p["sections"]["skills"][0]["action"] == "rename"
    before = db.execute("SELECT count(*) AS n FROM agents WHERE container_id=%s", (cid,))[0]["n"]
    r = await _ok(await _import(client, cid, bundle, p["preview_digest"], seeded["owner"]))
    assert r["agents"] == []
    assert db.execute("SELECT count(*) AS n FROM agents WHERE container_id=%s", (cid,))[0]["n"] == before
    names = [x["name"] for x in db.execute(
        "SELECT name FROM project_dod_presets WHERE container_id=%s ORDER BY created_at", (cid,))]
    assert names == ["Web feature done", "Web feature done (imported)"]
    # importing the same thing again: identical presets / skills are skipped now
    p2 = await _ok(await _preview(client, cid, bundle, seeded["owner"]))
    assert p2["sections"]["dod_presets"][0]["action"] == "skip"
    assert p2["sections"]["skills"][0]["action"] == "skip"


async def test_collision_rename_and_mapping_to_existing(client, seeded, db):
    cid = seeded["cid"]
    bundle = await _ok(await _export(client, cid, seeded["owner"]))
    opts = {"collisions": {"Forge": {"action": "rename", "rename_to": "Forge-eu"},
                           "Pixel": {"action": "rename"}}}
    p = await _ok(await _preview(client, cid, bundle, seeded["owner"], options=opts))
    roster = {i["alias"]: i for i in p["sections"]["roster"]}
    assert roster["Atlas"]["action"] == "skip"
    assert roster["Forge"]["action"] == "rename" and roster["Forge"]["final_alias"] == "Forge-eu"
    assert roster["Pixel"]["final_alias"] == "Pixel-2"  # the suggested name when none is given
    lines = {ln["alias"]: ln for ln in p["sections"]["reporting_lines"]}
    # renamed agents report to the EXISTING Atlas (skipped = keep the one already here)
    assert lines["Forge-eu"]["manager"] == {"kind": "existing", "id": seeded["lead"], "alias": "Atlas", "label": "Atlas"}
    r = await _ok(await _import(client, cid, bundle, p["preview_digest"], seeded["owner"], options=opts))
    assert sorted(a["alias"] for a in r["agents"]) == ["Forge-eu", "Pixel-2"]
    row = db.execute("SELECT reports_to_agent_id, model FROM agents WHERE container_id=%s AND alias='Forge-eu'", (cid,))[0]
    assert str(row["reports_to_agent_id"]) == seeded["lead"] and row["model"] == "gpt-5.6-sol"
    ev = db.execute("SELECT detail FROM events WHERE event_type='created' AND detail->>'alias'='Forge-eu'")
    assert ev[0]["detail"]["renamed_from"] == "Forge"


async def test_invalid_rename_blocks_the_import(client, seeded):
    cid = seeded["cid"]
    bundle = await _ok(await _export(client, cid, seeded["owner"]))
    long = await _preview(client, cid, bundle, seeded["owner"],
                          options={"collisions": {"Forge": {"action": "rename", "rename_to": "x" * 65}}})
    assert long.status_code in (413, 422)
    for target in ("Atlas", "atlas", "Pixel", "hussein"):
        opts = {"collisions": {"Forge": {"action": "rename", "rename_to": target}}}
        p = await _ok(await _preview(client, cid, bundle, seeded["owner"], options=opts))
        assert p["errors"] and p["errors"][0]["alias"] == "Forge", target
        r = await _import(client, cid, bundle, p["preview_digest"], seeded["owner"], options=opts)
        assert r.status_code == 422, target


# --------------------------------------------------------------------------- confirmation
async def test_import_requires_confirmation_and_a_current_preview(client, seeded, make_agent, db):
    bundle = await _ok(await _export(client, seeded["cid"], seeded["owner"]))
    cid2, me = await _new_project(client, "copy")
    p = await _ok(await _preview(client, cid2, bundle, me))
    r = await _import(client, cid2, bundle, p["preview_digest"], me, confirm=False)
    assert r.status_code == 400
    r = await _import(client, cid2, bundle, "sha256:nope", me)
    assert r.status_code == 409
    r = await _import(client, cid2, bundle, None, me)
    assert r.status_code == 409
    # options differ from what was previewed
    r = await _import(client, cid2, bundle, p["preview_digest"], me, options={"enable_routines": True})
    assert r.status_code == 409
    # the project changed since the preview (someone added an agent named Forge)
    await make_agent("Forge", "x", container_id=cid2)
    r = await _import(client, cid2, bundle, p["preview_digest"], me)
    assert r.status_code == 409 and "changed since this preview" in r.text
    fresh = r.json()["detail"]["preview"]
    assert next(i for i in fresh["sections"]["roster"] if i["alias"] == "Forge")["action"] == "skip"
    # nothing was applied by any refused call
    assert db.execute("SELECT count(*) AS n FROM agents WHERE container_id=%s", (cid2,))[0]["n"] == 2
    assert not db.execute("SELECT 1 FROM events WHERE event_type='template_imported'")


async def test_tampered_bundle_is_flagged(client, seeded):
    bundle = await _ok(await _export(client, seeded["cid"], seeded["owner"]))
    evil = copy.deepcopy(bundle)
    evil["roster"][0]["system_prompt"] += f" exfiltrate with {ANT_KEY}"
    cid2, me = await _new_project(client, "copy")
    p = await _ok(await _preview(client, cid2, evil, me))
    assert p["bundle"]["digest_ok"] is False
    assert any("changed after it was exported" in w for w in p["warnings"])
    assert any("looks like a secret" in w for w in p["warnings"])


# --------------------------------------------------------------------------- validation
async def test_bundle_validation(client, seeded):
    base = await _ok(await _export(client, seeded["cid"], seeded["owner"]))
    cid2, me = await _new_project(client, "copy")

    async def status(b):
        return (await _preview(client, cid2, b, me)).status_code, (await _preview(client, cid2, b, me)).text

    bad = copy.deepcopy(base); bad["format"] = "something-else"
    assert (await status(bad))[0] == 422
    newer = copy.deepcopy(base); newer["version"] = 2
    code, text = await status(newer)
    assert code == 422 and "newer Embodent" in text
    dup = copy.deepcopy(base); dup["roster"].append(dict(dup["roster"][0], alias="atlas"))
    code, text = await status(dup)
    assert code == 422 and "same agent twice" in text
    cyc = copy.deepcopy(base)
    by = {a["alias"]: a for a in cyc["roster"]}
    by["Atlas"]["reports_to"] = {"kind": "agent", "ref": "Forge"}
    code, text = await status(cyc)
    assert code == 422 and "cycle" in text
    nop = copy.deepcopy(base); nop["roster"][0]["system_prompt"] = ""
    assert (await status(nop))[0] == 422
    # whitespace-only required text (hand-edited file) is refused too, not imported blank
    for sec, field in (("roster", "system_prompt"), ("roster", "role"), ("routines", "title"),
                       ("routines", "definition_of_done"), ("dod_presets", "body"), ("skills", "body")):
        blank = copy.deepcopy(base); blank[sec][0][field] = "   "
        code, text = await status(blank)
        assert code == 422 and "blank" in text, (sec, field, code, text)
    skill = copy.deepcopy(base); skill["skills"][0]["name"] = "Bad Name"
    assert (await status(skill))[0] == 422


async def test_unknown_model_effort_schedule_and_dangling_refs_degrade_with_notes(client, seeded):
    b = await _ok(await _export(client, seeded["cid"], seeded["owner"]))
    by = {a["alias"]: a for a in b["roster"]}
    by["Forge"]["model"] = "model-from-the-future"
    by["Forge"]["reasoning_effort"] = "ultra"  # not supported by the fallback model
    by["Pixel"]["auto_wake_interval_secs"] = 10
    by["Pixel"]["reports_to"] = {"kind": "agent", "ref": "Ghost"}
    b["routines"].append(dict(b["routines"][0], title="Bad", cron="61 * * * *"))
    b["routines"].append(dict(b["routines"][0], title="Orphan", assignee="Ghost"))
    cid2, me = await _new_project(client, "copy")
    p = await _ok(await _preview(client, cid2, b, me))
    roster = {i["alias"]: i for i in p["sections"]["roster"]}
    assert roster["Forge"]["model"] == pb.DEFAULT_MODEL and roster["Forge"]["reasoning_effort"] is None
    assert any("isn't available here" in n for n in roster["Forge"]["notes"])
    assert roster["Pixel"]["auto_wake_interval_secs"] is None
    pixel_line = next(ln for ln in p["sections"]["reporting_lines"] if ln["alias"] == "Pixel")
    assert pixel_line["action"] == "skip" and "isn't in the template" in pixel_line["note"]
    rts = {r["title"]: r for r in p["sections"]["routines"]}
    assert rts["Bad"]["action"] == "skip" and "schedule" in rts["Bad"]["notes"][0]
    assert rts["Orphan"]["assignee"] is None
    r = await _import(client, cid2, b, p["preview_digest"], me)
    assert r.status_code == 200, r.text


# --------------------------------------------------------------------------- authority
@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    monkeypatch.setenv("ORCHA_PLAN", "team")


async def _invite(client, cid, login, role="member", grants=None):
    aid = (await _ok(await client.post(f"/api/containers/{cid}/members",
                                       json={"github_login": login, "role": role}, headers=OCTO), 201))["agent_id"]
    if grants is not None:
        await _ok(await client.patch(f"/api/containers/{cid}/members/{aid}", json={"grants": grants}, headers=OCTO))
    return aid


async def test_authority_matrix_under_proxy(client, container, make_agent, trust_proxy, db):
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    await _ok(await client.get(f"/api/me?cid={cid}", headers=OCTO))
    await _invite(client, cid, "hubot")
    await _invite(client, cid, "vera", role="viewer")
    await _ok(await client.post(f"/api/containers/{cid}/agents", headers=OCTO,
                                json={"alias": "Bot", "role": "eng", "kind": "ai", "prompt": "p"}), 201)
    # export: viewer, grant-less member, stranger refused; owner ok
    assert (await _export(client, cid, headers=VERA)).status_code == 403
    r = await _export(client, cid, headers=HUBOT)
    assert r.status_code == 403 and "manage_agents" in r.text
    assert (await _export(client, cid, headers=MALLORY)).status_code == 403
    bundle = await _ok(await _export(client, cid, headers=OCTO))
    # the proxy identity (octocat) is scrubbed too
    assert "octocat" not in json.dumps(bundle)
    # preview/import: same gate
    assert (await _preview(client, cid, bundle, headers=VERA)).status_code == 403
    assert (await _preview(client, cid, bundle, headers=HUBOT)).status_code == 403
    assert (await _import(client, cid, bundle, "x", headers=VERA)).status_code == 403
    # a manage_agents grant unlocks it
    hubot = next(r["id"] for r in db.execute("SELECT id FROM agents WHERE github_login='hubot'"))
    await _ok(await client.patch(f"/api/containers/{cid}/members/{hubot}",
                                 json={"grants": ["manage_agents"]}, headers=OCTO))
    opts = {"collisions": {"Bot": {"action": "rename", "rename_to": "Bot-2"}}}
    p, r = await _preview_and_import(client, cid, bundle, headers=HUBOT, options=opts)
    body = await _ok(r)
    assert [a["alias"] for a in body["agents"]] == ["Bot-2"]
    ev = db.execute("SELECT actor_id FROM events WHERE event_type='template_imported'")
    assert str(ev[0]["actor_id"]) == str(hubot)


async def test_autonomy_parts_need_manage_autonomy(client, container, make_agent, trust_proxy, db):
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    await _ok(await client.get(f"/api/me?cid={cid}", headers=OCTO))
    hubot = await _invite(client, cid, "hubot", grants=["manage_agents"])
    bot = (await _ok(await client.post(f"/api/containers/{cid}/agents", headers=OCTO, json={
        "alias": "Bot", "role": "eng", "kind": "ai", "prompt": "p"}), 201))["agent_id"]
    await _ok(await client.patch(f"/api/agents/{bot}", json={"actor_agent_id": "x", "autonomy_override": "full"}, headers=OCTO))
    await _ok(await client.patch(f"/api/agents/{bot}/auto-wake", json={"actor_agent_id": "x", "interval_secs": 120}, headers=OCTO))
    await _ok(await client.put(f"/api/agents/{bot}/budget", json={"monthly_limit_usd": 5}, headers=OCTO))
    bundle = await _ok(await _export(client, cid, headers=OCTO, include_budgets=True))
    opts = {"collisions": {"Bot": {"action": "rename", "rename_to": "Bot-2"}}}
    p, r = await _preview_and_import(client, cid, bundle, headers=HUBOT, options=opts)
    await _ok(r)
    item = p["sections"]["roster"][0]
    assert item["autonomy_override"] is None and item["auto_wake_interval_secs"] is None
    assert any("Autonomy permission" in n for n in item["notes"])
    assert all(b["action"] == "skip" for b in p["sections"]["budgets"])
    row = db.execute("SELECT autonomy_override, auto_wake_interval_secs FROM agents WHERE alias='Bot-2'")[0]
    assert row == {"autonomy_override": None, "auto_wake_interval_secs": None}
    assert not db.execute("SELECT 1 FROM agent_budgets ab JOIN agents a ON a.id=ab.agent_id WHERE a.alias='Bot-2'")
    # the owner gets them
    p, r = await _preview_and_import(client, cid, bundle, headers=OCTO,
                                     options={"collisions": {"Bot": {"action": "rename", "rename_to": "Bot-3"}}})
    await _ok(r)
    row = db.execute("SELECT autonomy_override, auto_wake_interval_secs FROM agents WHERE alias='Bot-3'")[0]
    assert row == {"autonomy_override": "full", "auto_wake_interval_secs": 120}


async def test_trust_off_requires_a_human_actor(client, container, make_agent):
    cid = container["id"]
    human = (await make_agent("boss", "operator", kind="human"))["agent_id"]
    bot = (await make_agent("Bot", "eng"))["agent_id"]
    assert (await _export(client, cid)).status_code == 400
    assert (await _export(client, cid, bot)).status_code == 403  # an AI can't export/import setups
    assert (await _export(client, cid, human)).status_code == 200


# --------------------------------------------------------------------------- library CRUD
async def test_presets_and_skills_crud(client, container, make_agent, db):
    cid = container["id"]
    human = (await make_agent("boss", "operator", kind="human"))["agent_id"]
    p = await _ok(await client.post(f"/api/containers/{cid}/dod-presets",
                                    json={"actor_agent_id": human, "name": "Doc reviewed", "body": "Two approvals"}), 201)
    assert p["created_by_alias"] == "boss" and p["source"] == "manual"
    r = await client.post(f"/api/containers/{cid}/dod-presets",
                          json={"actor_agent_id": human, "name": "doc REVIEWED", "body": "x"})
    assert r.status_code == 409
    assert (await client.post(f"/api/containers/{cid}/dod-presets",
                              json={"actor_agent_id": human, "name": "  ", "body": "x"})).status_code == 422
    u = await _ok(await client.patch(f"/api/dod-presets/{p['id']}", json={"actor_agent_id": human, "body": "Three approvals"}))
    assert u["body"] == "Three approvals"
    lst = await _ok(await client.get(f"/api/containers/{cid}/dod-presets"))
    assert [x["name"] for x in lst["items"]] == ["Doc reviewed"]
    await _ok(await client.delete(f"/api/dod-presets/{p['id']}", params={"actor_agent_id": human}))
    assert (await _ok(await client.get(f"/api/containers/{cid}/dod-presets")))["items"] == []
    # archived, not deleted — and its name is free again
    assert db.execute("SELECT archived_at FROM project_dod_presets WHERE id=%s", (p["id"],))[0]["archived_at"]
    await _ok(await client.post(f"/api/containers/{cid}/dod-presets",
                                json={"actor_agent_id": human, "name": "Doc reviewed", "body": "again"}), 201)
    assert (await client.patch(f"/api/dod-presets/{p['id']}", json={"actor_agent_id": human, "body": "x"})).status_code == 404

    s = await _ok(await client.post(f"/api/containers/{cid}/skills", json={
        "actor_agent_id": human, "name": "write-changelog", "description": "d", "body": "# steps"}), 201)
    assert (await client.post(f"/api/containers/{cid}/skills", json={
        "actor_agent_id": human, "name": "Write Changelog", "body": "x"})).status_code == 422
    u = await _ok(await client.patch(f"/api/skills/{s['id']}", json={"actor_agent_id": human, "name": "changelog"}))
    assert u["name"] == "changelog"
    await _ok(await client.delete(f"/api/skills/{s['id']}", params={"actor_agent_id": human}))
    for et in ("dod_preset_created", "dod_preset_updated", "dod_preset_deleted",
               "skill_created", "skill_updated", "skill_deleted"):
        assert db.execute("SELECT 1 FROM events WHERE event_type=%s", (et,)), et


async def test_library_authority_under_proxy(client, container, make_agent, trust_proxy):
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    await _ok(await client.get(f"/api/me?cid={cid}", headers=OCTO))
    await _invite(client, cid, "vera", role="viewer")
    await _invite(client, cid, "hubot")
    p = await _ok(await client.post(f"/api/containers/{cid}/dod-presets",
                                    json={"name": "n", "body": "b"}, headers=OCTO), 201)
    assert (await client.get(f"/api/containers/{cid}/dod-presets", headers=VERA)).status_code == 200
    assert (await client.get(f"/api/containers/{cid}/skills", headers=MALLORY)).status_code == 403
    assert (await client.post(f"/api/containers/{cid}/dod-presets", json={"name": "v", "body": "b"},
                              headers=VERA)).status_code == 403
    assert (await client.post(f"/api/containers/{cid}/skills", json={"name": "v", "body": "b"},
                              headers=HUBOT)).status_code == 403
    assert (await client.delete(f"/api/dod-presets/{p['id']}", headers=VERA)).status_code == 403


# --------------------------------------------------------------------------- pure scrub units
@pytest.mark.parametrize("secret", [
    ANT_KEY, GH_PAT, JWT, "sk-proj-abcdefghijklmnopqrstuvwxyz0123",
    "xoxb-1234567890-abcdefghij", "AKIAABCDEFGHIJKLMNOP",
    "https://hooks.slack.com/services/T000/B000/XXXXXXXX",
    "Zq3xV9kLmN2pR7tY5wB1cD4fG6hJ8sA0eU_-Kq",  # token_urlsafe-shaped
])
def test_scrub_secrets_units(secret):
    out, kinds = pb.scrub_text(f"before {secret} after", [])
    assert secret not in out and "secret" in kinds and out.startswith("before ") and out.endswith(" after")


def test_scrub_keeps_ordinary_text():
    txt = ("Run npm test, then open PR #42 against main. Container 7f1c2a9e-3b4d-4e5f-8a9b-0c1d2e3f4a5b. "
           "Tokenize input; the password policy is documented in docs/security.md.")
    out, kinds = pb.scrub_text(txt, pb.identity_patterns(["al", "bob"]))
    assert out == txt and kinds == []


def test_identity_scrub_is_word_bounded():
    pats = pb.identity_patterns(["sam", "sam-dev", "sam@x.io"])
    out, _ = pb.scrub_text("Ask sam or @sam-dev; not samples or same-day.", pats)
    assert out == "Ask [member] or [member]; not samples or same-day."


# --------------------------------------------------------------------------- new-project preview + spec
async def test_preview_for_a_new_project_matches_the_real_one(client, seeded, db):
    bundle = await _ok(await _export(client, seeded["cid"], seeded["owner"], include_budgets=True))
    before = db.execute("SELECT count(*) AS n FROM containers")[0]["n"]
    virt = await _ok(await client.post("/api/template/preview-new", json={"bundle": bundle}))
    assert virt["target"] == "new" and virt["preview_digest"] is None and virt["errors"] == []
    assert db.execute("SELECT count(*) AS n FROM containers")[0]["n"] == before  # writes nothing
    assert all(b["action"] == "set" for b in virt["sections"]["budgets"])  # the founder owns it
    cid2, me = await _new_project(client, "copy")
    real = await _ok(await _preview(client, cid2, bundle, me))
    assert real["counts"] == virt["counts"]
    bad = copy.deepcopy(bundle); bad["format"] = "x"
    assert (await client.post("/api/template/preview-new", json={"bundle": bad})).status_code == 422


async def test_routes_are_in_the_openapi_contract(client):
    spec = (await client.get("/openapi.json")).json()["paths"]
    for path in ("/api/containers/{cid}/template/export", "/api/containers/{cid}/template/preview",
                 "/api/containers/{cid}/template/import", "/api/template/preview-new",
                 "/api/containers/{cid}/dod-presets", "/api/dod-presets/{pid}",
                 "/api/containers/{cid}/skills", "/api/skills/{sid}"):
        assert path in spec, path


# --------------------------------------------------------------------------- QA round (portdeliv)
async def test_round_trip_keeps_the_templates_order(client, seeded):
    """Rows of one import used to share the transaction's now(), so re-export (ORDER BY
    created_at, alias) came back alphabetised: a non-alphabetical roster / routine list
    didn't survive export → import → export."""
    b = await _ok(await _export(client, seeded["cid"], seeded["owner"]))
    by = {a["alias"]: a for a in b["roster"]}
    b["roster"] = [by["Pixel"], by["Atlas"], by["Forge"]]
    b["routines"].append(dict(b["routines"][0], title="Alpha nightly sweep", cron="30 2 * * *"))
    b.pop("digest")
    cid2, me = await _new_project(client, "copy-order")
    _, r = await _preview_and_import(client, cid2, b, me)
    await _ok(r)
    back = await _ok(await _export(client, cid2, me))
    assert [a["alias"] for a in back["roster"]] == ["Pixel", "Atlas", "Forge"]
    assert [x["title"] for x in back["routines"]] == ["Weekly dependency audit", "Alpha nightly sweep"]


def test_scrub_growth_is_trimmed_back_to_the_field_limit():
    """'token=abc123' → 'token=[redacted secret]' grows the text; a near-limit prompt used
    to export at 8009 chars and then fail its own import validation (422)."""
    from portal_backend.limits import MAX_PROMPT_LEN, MAX_NAME_LEN
    prompt = "x" * (MAX_PROMPT_LEN - 15) + " token=abc123"
    role = "r" * (MAX_NAME_LEN - 4) + " bob"
    b = pb.build_bundle(
        project_name="p", humans=[{"id": "h1", "alias": "bob", "github_login": None, "git_email": None}],
        ai_agents=[{"id": "a1", "alias": "Forge", "role": role, "system_prompt": prompt, "model": None,
                    "reasoning_effort": None, "auto_wake_interval_secs": None,
                    "autonomy_override": None, "reports_to_agent_id": None}],
        routines=[], presets=[], skills=[])
    [a] = b["roster"]
    assert len(a["system_prompt"]) <= MAX_PROMPT_LEN and "abc123" not in a["system_prompt"]
    assert len(a["role"]) <= MAX_NAME_LEN and "bob" not in a["role"]
    kinds = {r["field"]: r["kinds"] for r in b["scrub"]["redactions"]}
    assert "trimmed" in kinds["roster[Forge].system_prompt"] and "trimmed" in kinds["roster[Forge].role"]
    pb.ProjectTemplateBundle.model_validate(b)  # the export is importable again


async def test_near_limit_prompt_exports_importably(client, seeded):
    prompt = "x" * 7985 + " token=abc123"
    await _ok(await client.patch(f"/api/agents/{seeded['pixel']}", json={
        "actor_agent_id": seeded["owner"], "system_prompt": prompt}))
    b = await _ok(await _export(client, seeded["cid"], seeded["owner"]))
    r = await client.post("/api/template/preview-new", json={"bundle": b})
    assert r.status_code == 200, r.text


async def test_validation_errors_read_as_plain_words(client, seeded):
    from portal_backend.project_export_routes import validation_text
    assert validation_text({"loc": ("roster", 0, "system_prompt"), "msg": "Field required"}) == (
        "the template isn't valid: agent 1 › system prompt: Field required")
    assert validation_text({"loc": ("routines", 2, "title"), "msg": "Value error, can't be blank"}) == (
        "the template isn't valid: routine 3 › title: can't be blank")
    base = await _ok(await _export(client, seeded["cid"], seeded["owner"]))
    cid2, me = await _new_project(client, "copy-msgs")
    for mutate in (lambda b: b.update(version=2), lambda b: b["roster"][0].update(role="  "),
                   lambda b: b["roster"][0].pop("system_prompt")):
        b = copy.deepcopy(base); mutate(b)
        r = await _preview(client, cid2, b, me)
        detail = r.json()["detail"]
        assert r.status_code == 422 and isinstance(detail, str)
        assert "Value error" not in detail and "roster.0" not in detail, detail
