"""Fine-grained notification preferences (mig 063).

Covers, in order:
  * the migration (tables, cascade, idempotent re-apply);
  * the category mapping (every known kind → exactly one category, unknown fallback);
  * a TABLE-DRIVEN should_notify: every category × channel × scope (mine / not mine),
    pause + snooze expiry, quiet hours across midnight and in several time zones (DST
    included), project mute and the critical in-app lock;
  * validation (plain-words 422s);
  * the routes: identity in trust-off and trusted modes, own-only edits, viewers,
    audit rows, /openapi.json;
  * integration: a muted category writes no push_outbox row and posts nothing to Slack,
    push is re-filtered per member at claim time, the bell hides it — and the
    Needs-you sources (the snapshot's open request / needs_verification task) still
    carry it.
"""
import itertools
import pathlib
from datetime import datetime, timezone

import psycopg
import pytest

from conftest import TEST_URL
from portal_backend import notification_prefs as np
from portal_backend import notification_taxonomy as tax
from portal_backend import push_outbox, slack_notify

MIGRATION = (
    pathlib.Path(__file__).resolve().parent.parent
    / "orcha-cli" / "orcha_cli" / "templates" / "migrations" / "063_notification_prefs.sql"
)

OCTO = {"X-Auth-Request-User": "octocat"}
HUBOT = {"X-Auth-Request-User": "hubot"}
VIEWER = {"X-Auth-Request-User": "vera"}
MALLORY = {"X-Auth-Request-User": "mallory"}
TOKEN_A = "a" * 64
TOKEN_B = "b" * 64


def _utc(*a) -> float:
    return datetime(*a, tzinfo=timezone.utc).timestamp()


NOW = _utc(2026, 1, 15, 15, 0)  # 10:00 in New York (EST)


@pytest.fixture(autouse=True)
def _team_plan(monkeypatch):
    monkeypatch.setenv("ORCHA_PLAN", "team")


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


@pytest.fixture
def no_trust_proxy(monkeypatch):
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)


# ================================================================== migration


def test_migration_creates_tables_and_is_idempotent(db):
    cols = {
        (r["table_name"], r["column_name"])
        for r in db.execute(
            """SELECT table_name, column_name FROM information_schema.columns
               WHERE table_name IN ('notification_prefs','notification_pref_defaults')"""
        )
    }
    assert {
        ("notification_prefs", "member_agent_id"),
        ("notification_prefs", "container_id"),
        ("notification_prefs", "prefs"),
        ("notification_prefs", "updated_at"),
        ("notification_pref_defaults", "identity_key"),
        ("notification_pref_defaults", "prefs"),
    } <= cols
    # ADD-only + tolerant re-apply: running it again is a no-op, not an error
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        conn.execute(MIGRATION.read_text())
    idx = db.execute(
        "SELECT indexname FROM pg_indexes WHERE tablename='notification_prefs'"
    )
    assert "notification_prefs_container_idx" in {r["indexname"] for r in idx}


async def test_member_row_delete_cascades_override(client, container, make_agent, db):
    h = await make_agent("root", "operator", kind="human")
    r = await client.put(
        f"/api/containers/{container['id']}/notification-prefs", json={"muted": True}
    )
    assert r.status_code == 200, r.text
    assert len(db.execute("SELECT 1 FROM notification_prefs")) == 1
    db.execute("DELETE FROM events WHERE actor_id=%s", (h["agent_id"],))
    db.execute("DELETE FROM agents WHERE id=%s", (h["agent_id"],))
    assert db.execute("SELECT 1 FROM notification_prefs") == []


# ============================================================ category mapping


def _all_known_kinds():
    kinds = set(tax._NOTIF_TAXONOMY) | {"request_created"}
    kinds |= set(push_outbox.TITLE_BY_KIND)                      # outbox kinds
    kinds |= {"task_plan", "task_verify", "request_answer", "request_close"}  # desktop
    return kinds


def test_every_known_kind_maps_to_exactly_one_real_category():
    for kind in _all_known_kinds():
        assert kind in np.KIND_TO_CATEGORY, f"{kind} has no explicit category"
        assert np.category_for(kind) in np.CATEGORY_KEYS
    assert set(np.KIND_TO_CATEGORY.values()) <= set(np.CATEGORY_KEYS)
    # every category is reachable from at least one kind
    assert set(np.KIND_TO_CATEGORY.values()) == set(np.CATEGORY_KEYS)


@pytest.mark.parametrize(
    "kind,expected",
    [
        ("task_verify", "approvals"),
        ("plan_approval", "approvals"),
        ("task_plan", "approvals"),
        ("request", "requests"),
        ("request_created", "requests"),
        ("request_escalated", "escalations"),
        ("budget_paused", "budget"),
        ("task_assigned", "tasks"),
        ("task_message", "messages"),
        ("routine_failed", "routines"),
        ("verdikt_run", "verdikt"),
        ("member_invited", "settings"),
        # unknown kinds degrade by prefix, then to the fallback
        ("budget_something_new", "budget"),
        ("routine_skipped", "routines"),
        ("evidence_uploaded", "verdikt"),
        ("member_left", "settings"),
        ("request_reopened", "requests"),
        ("totally_new_thing", np.FALLBACK_CATEGORY),
        ("", np.FALLBACK_CATEGORY),
        (None, np.FALLBACK_CATEGORY),
    ],
)
def test_category_for(kind, expected):
    assert np.category_for(kind) == expected


# ======================================================= should_notify: the table

A_KIND = {  # one representative kind per category
    "approvals": "task_verify",
    "requests": "request_created",
    "escalations": "request_escalated",
    "budget": "budget_warning",
    "tasks": "task_assigned",
    "messages": "task_message",
    "routines": "routine_failed",
    "verdikt": "verdikt_run",
    "settings": "member_invited",
}


def _prefs_with(category, scope, channel_on):
    rules = {c: {"scope": "all", "channels": {ch: True for ch in np.CHANNEL_KEYS}} for c in np.CATEGORY_KEYS}
    rules[category] = {
        "scope": scope,
        "channels": {ch: (ch in channel_on) for ch in np.CHANNEL_KEYS},
    }
    return np.resolve({"rules": rules}, None)


SCOPE_CASES = [
    # (scope, mine, expected when the channel is on)
    ("all", True, True),
    ("all", False, True),
    ("mine", True, True),
    ("mine", False, False),
    ("off", True, False),
    ("off", False, False),
]


@pytest.mark.parametrize(
    "category,channel,scope,mine,expected",
    [
        (cat, ch, scope, mine, exp)
        for cat, ch, (scope, mine, exp) in itertools.product(
            np.CATEGORY_KEYS, np.CHANNEL_KEYS, SCOPE_CASES
        )
    ],
)
def test_should_notify_matrix(category, channel, scope, mine, expected):
    kind = A_KIND[category]
    on = _prefs_with(category, scope, set(np.CHANNEL_KEYS))
    assert np.should_notify(on, {"kind": kind, "mine": mine}, channel, NOW) is expected
    # the channel switch off always silences it (the budget in-app lock keeps it on)
    off = _prefs_with(category, scope, set(np.CHANNEL_KEYS) - {channel})
    locked = (category, channel) in np.LOCKS
    assert np.should_notify(off, {"kind": kind, "mine": mine}, channel, NOW) is (
        expected if locked else False
    )


def test_decide_reasons():
    base = np.resolve(None, None)
    assert np.decide(base, {"kind": "task_verify", "mine": False}, "push", NOW) == (True, "allowed")
    assert np.decide(base, {"kind": "task_assigned", "mine": False}, "in_app", NOW) == (False, "not_mine")
    assert np.decide(base, {"kind": "routine_failed"}, "push", NOW) == (False, "channel_off")
    assert np.decide(base, {"kind": "x"}, "carrier_pigeon", NOW) == (False, "unknown_channel")
    muted = np.resolve(None, {"muted": True})
    assert np.decide(muted, {"kind": "task_verify"}, "in_app", NOW) == (False, "project_muted")


def test_builtin_defaults_keep_pre_063_channels_on():
    """No regression: push/desktop/Slack for approvals & requests stay on out of the box."""
    base = np.resolve(None, None)
    for kind in ("task_verify", "plan_approval", "request"):
        for ch in ("push", "slack", "desktop", "in_app"):
            assert np.should_notify(base, {"kind": kind, "mine": False}, ch, NOW), (kind, ch)
    for kind in ("task_plan", "request_answer", "request_close"):
        assert np.should_notify(base, {"kind": kind, "mine": False}, "desktop", NOW), kind


# ------------------------------------------------------------ pause / snooze


@pytest.mark.parametrize(
    "pause,now,paused",
    [
        (None, NOW, False),
        ({"until": None}, NOW, True),                  # until I turn it back on
        ({"until": NOW + 3600}, NOW, True),            # for 1h
        ({"until": NOW + 3600}, NOW + 3599, True),
        ({"until": NOW + 3600}, NOW + 3600, False),    # expiry is exclusive
        ({"until": NOW + 3600}, NOW + 7200, False),    # snooze expired → back on
    ],
)
@pytest.mark.parametrize("channel", np.CHANNEL_KEYS)
def test_pause_and_snooze_expiry(pause, now, paused, channel):
    prefs = np.resolve({"pause": pause}, None)
    assert np.is_paused(prefs, now) is paused
    assert np.should_notify(prefs, {"kind": "task_verify", "mine": True}, channel, now) is (not paused)


def test_pause_accepts_datetime_now():
    prefs = np.resolve({"pause": {"until": NOW + 60}}, None)
    assert np.is_paused(prefs, datetime.fromtimestamp(NOW, timezone.utc))
    assert np.is_paused(prefs, datetime.utcfromtimestamp(NOW))  # naive = UTC


# ------------------------------------------------------------- quiet hours

NY_NIGHT = {"start": "22:00", "end": "07:00", "tz": "America/New_York"}
TOKYO_DAY = {"start": "09:00", "end": "17:00", "tz": "Asia/Tokyo"}


@pytest.mark.parametrize(
    "quiet,now,inside",
    [
        # across midnight, New York winter (EST = UTC-5)
        (NY_NIGHT, _utc(2026, 1, 15, 3, 0), True),    # 22:00 local — start inclusive
        (NY_NIGHT, _utc(2026, 1, 15, 2, 59), False),  # 21:59
        (NY_NIGHT, _utc(2026, 1, 15, 8, 0), True),    # 03:00 after midnight
        (NY_NIGHT, _utc(2026, 1, 15, 11, 59), True),  # 06:59
        (NY_NIGHT, _utc(2026, 1, 15, 12, 0), False),  # 07:00 — end exclusive
        (NY_NIGHT, _utc(2026, 1, 15, 17, 0), False),  # noon
        # DST: the same UTC instant is 22:00 in July (EDT = UTC-4) but 21:00 in January
        (NY_NIGHT, _utc(2026, 7, 15, 2, 0), True),
        (NY_NIGHT, _utc(2026, 1, 15, 2, 0), False),
        # a daytime window in another zone (no midnight crossing)
        (TOKYO_DAY, _utc(2026, 1, 15, 1, 0), True),   # 10:00 JST
        (TOKYO_DAY, _utc(2026, 1, 15, 8, 0), False),  # 17:00 JST — end exclusive
        (TOKYO_DAY, _utc(2026, 1, 14, 23, 59), False),  # 08:59 JST
        (None, NOW, False),
    ],
)
def test_quiet_hours_window(quiet, now, inside):
    assert np.in_quiet_hours(quiet, now) is inside
    prefs = np.resolve({"quiet_hours": quiet}, None)
    ev = {"kind": "task_verify", "mine": True}
    # quiet hours HOLD the alert channels…
    for ch in np.ALERT_CHANNELS:
        assert np.should_notify(prefs, ev, ch, now) is (not inside), ch
    # …but in-app keeps collecting
    assert np.should_notify(prefs, ev, "in_app", now) is True


# ----------------------------------------------------------- critical lock


def test_critical_budget_hard_stop_always_reaches_in_app():
    everything_off = np.resolve(
        {
            "rules": {c: {"scope": "off"} for c in np.CATEGORY_KEYS},
            "pause": {"until": None},
            "quiet_hours": NY_NIGHT,
        },
        {"muted": True},
    )
    ev = {"kind": "budget_paused"}
    assert np.decide(everything_off, ev, "in_app", _utc(2026, 1, 15, 4, 0)) == (True, "critical")
    # the lock is in-app only: alert channels still honour mute / pause / quiet hours
    for ch in np.ALERT_CHANNELS:
        assert np.should_notify(everything_off, ev, ch, NOW) is False
    # a non-critical budget event follows the rules
    assert np.should_notify(everything_off, {"kind": "budget_warning"}, "in_app", NOW) is False


def test_budget_in_app_is_locked_on_in_resolution_and_validation():
    with pytest.raises(np.PrefsError, match="can't be turned off"):
        np.validate_rules({"budget": {"channels": {"in_app": False}}})
    # a stored row that somehow says off is resolved back on
    eff = np.resolve({"rules": {"budget": {"channels": {"in_app": False}}}}, None)
    assert eff["rules"]["budget"]["channels"]["in_app"] is True


# ------------------------------------------------------ resolution layers


def test_project_override_layers_over_defaults():
    defaults = {"rules": {"tasks": {"scope": "all", "channels": {"push": True}}}}
    project = {"rules": {"tasks": {"channels": {"desktop": False}}}}
    eff = np.resolve(defaults, project)
    assert eff["rules"]["tasks"]["scope"] == "all"             # from defaults
    assert eff["rules"]["tasks"]["channels"]["push"] is True    # from defaults
    assert eff["rules"]["tasks"]["channels"]["desktop"] is False  # project override
    assert eff["rules"]["approvals"] == np.BUILTIN_RULES["approvals"]


def test_resolve_tolerates_garbage_rows():
    eff = np.resolve(
        {"rules": {"nope": 1, "tasks": {"scope": "bogus"}}, "quiet_hours": {"start": "x"}, "pause": "soon"},
        {"rules": "no"},
    )
    assert eff["rules"] == np.builtin_rules() | {"budget": eff["rules"]["budget"]}
    assert eff["quiet_hours"] is None and eff["pause"] is None


# ================================================================ validation


@pytest.mark.parametrize(
    "rules,msg",
    [
        ([], "must be an object"),
        ({"nope": {}}, "unknown notification category"),
        ({"tasks": "all"}, "must be an object"),
        ({"tasks": {"scope": "sometimes"}}, "scope for 'tasks'"),
        ({"tasks": {"channels": {"fax": True}}}, "unknown channel"),
        ({"tasks": {"channels": {"push": "yes"}}}, "true or false"),
        ({"tasks": {"volume": 3}}, "unknown field"),
    ],
)
def test_validate_rules_errors(rules, msg):
    with pytest.raises(np.PrefsError, match=msg):
        np.validate_rules(rules)


@pytest.mark.parametrize(
    "pause,msg",
    [
        ({"until": NOW - 1}, "future"),
        ({"until": NOW + 400 * 86400}, "longer than a year"),
        ({"until": "tomorrow"}, "must be a time"),
        ({"until": True}, "must be a time"),
        ({"for": "1h"}, "pause must be null"),
    ],
)
def test_validate_pause_errors(pause, msg):
    with pytest.raises(np.PrefsError, match=msg):
        np.validate_pause(pause, NOW)


@pytest.mark.parametrize(
    "quiet,msg",
    [
        ({"start": "25:00", "end": "07:00", "tz": "UTC"}, "24-hour"),
        ({"start": "22:00", "end": "7am", "tz": "UTC"}, "24-hour"),
        ({"start": "22:00", "end": "22:00", "tz": "UTC"}, "differ"),
        ({"start": "22:00", "end": "07:00", "tz": "Mars/Olympus"}, "time zone"),
        ({"start": "22:00", "end": "07:00"}, "time zone"),
        ({"start": "22:00", "end": "07:00", "tz": "UTC", "days": 5}, "unknown quiet-hours"),
    ],
)
def test_validate_quiet_hours_errors(quiet, msg):
    with pytest.raises(np.PrefsError, match=msg):
        np.validate_quiet_hours(quiet)


# ==================================================================== routes


def _url(cid, suffix=""):
    return f"/api/containers/{cid}/notification-prefs{suffix}"


async def test_openapi_lists_the_routes(client):
    spec = (await client.get("/openapi.json")).json()
    paths = spec["paths"]
    assert {"get", "put", "delete"} <= set(paths["/api/containers/{cid}/notification-prefs"])
    assert {"get", "put"} <= set(paths["/api/containers/{cid}/notification-prefs/defaults"])
    assert "post" in paths["/api/containers/{cid}/notification-prefs/check"]
    assert "requestBody" in paths["/api/containers/{cid}/notification-prefs"]["put"]
    schemas = spec["components"]["schemas"]
    assert {"ProjectPrefsBody", "DefaultPrefsBody", "CheckBody"} <= set(schemas)


async def test_trust_off_get_resolves_local_operator(client, container, make_agent, no_trust_proxy):
    h = await make_agent("root", "operator", kind="human")
    r = await client.get(_url(container["id"]))
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["member"]["id"] == h["agent_id"]
    assert [c["key"] for c in d["catalog"]["categories"]] == list(np.CATEGORY_KEYS)
    assert d["effective"]["rules"] == np.resolve(None, None)["rules"]
    assert d["project"] == {"rules": {}, "muted": False, "stored": False}
    assert d["channels"]["in_app"]["available"] is True
    assert d["channels"]["desktop"]["available"] is True  # local stack
    assert d["channels"]["slack"]["available"] is False
    assert d["channels"]["push"]["available"] is False
    assert d["catalog"]["locks"][0]["category"] == "budget"


async def test_no_human_is_409_and_bad_ids_400(client, container):
    assert (await client.get(_url(container["id"]))).status_code == 409
    assert (await client.get(_url("not-a-uuid"))).status_code == 400
    assert (
        await client.get(_url("00000000-0000-0000-0000-000000000000"))
    ).status_code == 404


async def test_put_project_and_defaults_round_trip_with_audit(client, container, make_agent, db):
    await make_agent("root", "operator", kind="human")
    cid = container["id"]
    r = await client.put(
        _url(cid),
        json={"rules": {"tasks": {"scope": "off"}}, "muted": False},
    )
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["project"]["rules"] == {"tasks": {"scope": "off"}}
    assert d["effective"]["rules"]["tasks"]["scope"] == "off"

    until = datetime.now(timezone.utc).timestamp() + 3600
    r = await client.put(
        _url(cid, "/defaults"),
        json={
            "rules": {"routines": {"scope": "off"}},
            "pause": {"until": until},
            "quiet_hours": NY_NIGHT,
        },
    )
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["defaults"]["rules"]["routines"]["scope"] == "off"
    assert d["defaults"]["quiet_hours"] == NY_NIGHT
    assert d["effective"]["paused_now"] is True
    # clearing pause + quiet hours with explicit nulls
    r = await client.put(_url(cid, "/defaults"), json={"pause": None, "quiet_hours": None})
    assert r.status_code == 200
    assert r.json()["effective"]["paused_now"] is False
    assert r.json()["defaults"]["quiet_hours"] is None
    assert r.json()["defaults"]["rules"]["routines"]["scope"] == "off"  # untouched

    # reset the project override
    r = await client.delete(_url(cid))
    assert r.status_code == 200 and r.json()["project"]["stored"] is False
    assert r.json()["effective"]["rules"]["tasks"]["scope"] == "mine"  # built-in again

    audit = db.execute(
        "SELECT detail FROM events WHERE event_type='notification_prefs_changed' ORDER BY id"
    )
    scopes = [a["detail"]["scope"] for a in audit]
    assert scopes == ["project", "defaults", "defaults", "project"]
    assert audit[0]["detail"]["fields"] == ["muted", "rules"]


@pytest.mark.parametrize(
    "suffix,body,msg",
    [
        ("", {}, "nothing to change"),
        ("", {"rules": {"nope": {}}}, "unknown notification category"),
        ("", {"rules": {"budget": {"channels": {"in_app": False}}}}, "can't be turned off"),
        ("", {"muted": None}, "true or false"),
        ("", {"volume": 11}, None),  # extra field → pydantic 422
        ("/defaults", {"pause": {"until": 1}}, "future"),
        ("/defaults", {"quiet_hours": {"start": "22:00", "end": "22:00", "tz": "UTC"}}, "differ"),
        ("/defaults", {}, "nothing to change"),
    ],
)
async def test_put_validation_422(client, container, make_agent, suffix, body, msg):
    await make_agent("root", "operator", kind="human")
    r = await client.put(_url(container["id"], suffix), json=body)
    assert r.status_code == 422, r.text
    if msg:
        assert msg in r.json()["detail"]


async def test_trust_off_actor_must_be_a_live_human_here(client, container, make_agent, no_trust_proxy):
    await make_agent("root", "operator", kind="human")
    ai = await make_agent("bot", "eng")
    r = await client.get(_url(container["id"]), params={"actor_agent_id": ai["agent_id"]})
    assert r.status_code == 403
    r = await client.get(_url(container["id"]), params={"actor_agent_id": "nope"})
    assert r.status_code == 400


async def _bind_owner(client, container, make_agent):
    await make_agent("root", "operator", kind="human")
    r = await client.get(f"/api/me?cid={container['id']}", headers=OCTO)
    assert r.json()["identity"]["member_role"] == "owner"
    return r.json()["identity"]["agent_id"]


async def _invite(client, cid, login, role="member"):
    r = await client.post(
        f"/api/containers/{cid}/members",
        json={"github_login": login, "role": role},
        headers=OCTO,
    )
    assert r.status_code == 201, r.text
    return r.json()["agent_id"]


async def test_trusted_members_edit_only_their_own(client, container, make_agent, trust_proxy):
    cid = container["id"]
    octo = await _bind_owner(client, container, make_agent)
    hubot = await _invite(client, cid, "hubot")

    r = await client.get(_url(cid), headers=HUBOT)
    assert r.status_code == 200 and r.json()["member"]["id"] == hubot
    # naming someone else is refused — you can only change your own settings
    r = await client.put(
        _url(cid), json={"muted": True, "actor_agent_id": octo}, headers=HUBOT
    )
    assert r.status_code == 403
    assert "your own" in r.json()["detail"]
    r = await client.get(_url(cid), params={"actor_agent_id": octo}, headers=HUBOT)
    assert r.status_code == 403

    # hubot mutes the project for HIMSELF; octocat is unaffected
    r = await client.put(_url(cid), json={"muted": True}, headers=HUBOT)
    assert r.status_code == 200 and r.json()["effective"]["muted"] is True
    r = await client.get(_url(cid), headers=OCTO)
    assert r.json()["effective"]["muted"] is False

    # defaults are per PERSON (identity-level): hubot's pause doesn't pause octocat
    until = datetime.now(timezone.utc).timestamp() + 600
    r = await client.put(_url(cid, "/defaults"), json={"pause": {"until": until}}, headers=HUBOT)
    assert r.status_code == 200
    assert (await client.get(_url(cid), headers=OCTO)).json()["effective"]["paused_now"] is False

    # a verified stranger is refused outright
    assert (await client.get(_url(cid), headers=MALLORY)).status_code == 403
    assert (await client.put(_url(cid), json={"muted": True}, headers=MALLORY)).status_code == 403


async def test_viewer_may_set_their_own_notifications(client, container, make_agent, trust_proxy):
    """Personal, read-scoped configuration — like pairing a phone (write=False)."""
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    await _invite(client, cid, "vera", role="viewer")
    r = await client.put(_url(cid), json={"rules": {"settings": {"scope": "off"}}}, headers=VIEWER)
    assert r.status_code == 200, r.text
    assert r.json()["member"]["member_role"] == "viewer"
    assert r.json()["effective"]["rules"]["settings"]["scope"] == "off"


async def test_channels_available_reflect_configuration(client, container, make_agent, trust_proxy, db):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    d = (await client.get(_url(cid), headers=OCTO)).json()
    assert d["channels"]["desktop"]["available"] is False  # trusted/cloud stack
    assert d["channels"]["push"]["available"] is False
    await client.post("/api/push/devices", json={"apns_token": TOKEN_A}, headers=OCTO)
    db.execute("UPDATE containers SET slack_webhook_url='https://hooks.slack.com/x' WHERE id=%s", (cid,))
    d = (await client.get(_url(cid), headers=OCTO)).json()
    assert d["channels"]["push"]["available"] is True
    assert d["channels"]["slack"]["available"] is True


async def test_check_route_for_the_desktop(client, container, make_agent, make_task, make_request, db):
    cid = container["id"]
    h = await make_agent("root", "operator", kind="human")
    asker = await make_agent("asker", "eng")
    t = await make_task("plan it", "done")
    req = await make_request(asker["agent_id"], "need a hand", target_alias="root")
    await client.put(_url(cid), json={"rules": {"approvals": {"channels": {"desktop": False}}}})
    r = await client.post(
        _url(cid, "/check"),
        json={
            "channel": "desktop",
            "items": [
                {"kind": "task_verify", "ref_id": t["task_id"]},
                {"kind": "request_answer", "ref_id": req["request_id"]},
                {"kind": "request_close", "ref_id": req["request_id"]},
            ],
        },
    )
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["member_id"] == h["agent_id"]
    got = [(x["kind"], x["category"], x["notify"], x["reason"]) for x in d["decisions"]]
    assert got == [
        ("task_verify", "approvals", False, "channel_off"),
        ("request_answer", "requests", True, "allowed"),
        ("request_close", "requests", True, "allowed"),
    ]
    # an ESCALATED request is judged in Escalations
    db.execute("UPDATE requests SET status='escalated' WHERE id=%s", (req["request_id"],))
    await client.put(_url(cid), json={"rules": {"escalations": {"scope": "off"}}})
    d = (await client.post(
        _url(cid, "/check"),
        json={"channel": "desktop", "items": [{"kind": "request_answer", "ref_id": req["request_id"]}]},
    )).json()
    assert d["decisions"][0]["category"] == "escalations"
    assert d["decisions"][0]["notify"] is False
    bad = await client.post(_url(cid, "/check"), json={"channel": "fax", "items": []})
    assert bad.status_code == 422


# ============================================================== integration


async def _drive_to_needs_verification(client, make_agent, make_task, work_headers, title="ship it"):
    alias = "dev-" + "".join(c for c in title if c.isalnum())[:20]
    dev = await make_agent(alias, "eng")
    t = await make_task(title, "done when shipped", assignee_alias=alias)
    r = await client.post(
        f"/api/tasks/{t['task_id']}/done",
        json={"agent_id": dev["agent_id"], "result": "x"},
        headers=await work_headers(dev["agent_id"]),
    )
    assert r.status_code == 200 and r.json()["status"] == "needs_verification", r.text
    return t["task_id"]


def _outbox(db):
    return db.execute("SELECT kind, ref_id::text AS ref, failed FROM push_outbox ORDER BY created_at")


async def test_muted_category_writes_no_push_row_but_needs_you_keeps_it(
    client, container, make_agent, make_task, work_headers, trust_proxy, db
):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    await client.post("/api/push/devices", json={"apns_token": TOKEN_A}, headers=OCTO)
    r = await client.put(_url(cid), json={"rules": {"approvals": {"scope": "off"}}}, headers=OCTO)
    assert r.status_code == 200
    tid = await _drive_to_needs_verification(client, make_agent, make_task, work_headers)
    assert _outbox(db) == []  # muted → no row
    # SAFETY RULE: the Needs-you source (the snapshot's task list) still carries it
    snap = (await client.get(f"/api/containers/{cid}", headers=OCTO)).json()
    task = next(t for t in snap["tasks"] if t["id"] == tid)
    assert task["status"] == "needs_verification"

    # turning it back on → the next birth enqueues again
    await client.put(_url(cid), json={"rules": {}}, headers=OCTO)
    await _drive_to_needs_verification(client, make_agent, make_task, work_headers, title="again")
    assert [row["kind"] for row in _outbox(db)] == ["task_verify"]


async def test_pause_and_push_only_mine_filter_devices_per_member_at_claim(
    client, container, make_agent, make_task, work_headers, trust_proxy, db
):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    hubot = await _invite(client, cid, "hubot")
    await client.post("/api/push/devices", json={"apns_token": TOKEN_A}, headers=OCTO)
    await client.post("/api/push/devices", json={"apns_token": TOKEN_B}, headers=HUBOT)
    # hubot: approvals only when they're his
    await client.put(_url(cid), json={"rules": {"approvals": {"scope": "mine"}}}, headers=HUBOT)
    tid = await _drive_to_needs_verification(client, make_agent, make_task, work_headers)
    ev = (await client.post("/api/push/outbox/claim", json={})).json()["events"]
    assert len(ev) == 1 and ev[0]["devices"] == [TOKEN_A]  # owner = default verifier

    # make hubot the named reviewer: now it's his, and no longer the owner's default
    db.execute("UPDATE tasks SET reviewer_agent_id=%s WHERE id=%s", (hubot, tid))
    ev = (await client.post("/api/push/outbox/claim", json={})).json()["events"]
    assert ev[0]["devices"] == [TOKEN_A, TOKEN_B]  # octo still has scope "all"

    # both pause → re-checked AT SEND TIME: the row is failed, nothing sent
    until = datetime.now(timezone.utc).timestamp() + 3600
    for h in (OCTO, HUBOT):
        r = await client.put(_url(cid, "/defaults"), json={"pause": {"until": until}}, headers=h)
        assert r.status_code == 200
    assert (await client.post("/api/push/outbox/claim", json={})).json()["events"] == []
    assert _outbox(db)[0]["failed"] == "muted by notification settings"


async def test_muted_category_posts_nothing_to_slack(
    client, container, make_agent, make_task, work_headers, db, monkeypatch
):
    posts = []
    monkeypatch.setattr(slack_notify, "_post_webhook", lambda url, payload: posts.append(payload))
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    db.execute("UPDATE containers SET slack_webhook_url='https://hooks.slack.com/x' WHERE id=%s", (cid,))
    await client.put(_url(cid), json={"rules": {"approvals": {"channels": {"slack": False}}}})
    await _drive_to_needs_verification(client, make_agent, make_task, work_headers)
    assert posts == []
    # quiet hours hold Slack too — but with them off and the channel on, it posts
    await client.put(_url(cid), json={"rules": {}})
    await _drive_to_needs_verification(client, make_agent, make_task, work_headers, title="two")
    assert len(posts) == 1 and "Needs verification" in posts[0]["text"]


async def test_bell_hides_muted_category_needs_you_still_has_it(
    client, container, make_agent, make_request
):
    cid = container["id"]
    h = await make_agent("root", "operator", kind="human")
    asker = await make_agent("asker", "eng")
    req = await make_request(asker["agent_id"], "can you review the plan?", target_alias="root")
    feed = f"/api/agents/{h['agent_id']}/notifications"

    before = (await client.get(feed)).json()
    assert [n["event_name"] for n in before["notifications"]] == ["request_created"]
    assert before["prefs_state"] == {"paused": False, "paused_until": None, "muted": False}

    await client.put(_url(cid), json={"rules": {"requests": {"scope": "off"}}})
    after = (await client.get(feed)).json()
    assert after["notifications"] == []           # the bell hides it (and its unread count)
    # …but Needs-you is computed from live requests, which still list it
    reqs = (await client.get(f"/api/containers/{cid}")).json()["requests"]
    assert any(r["id"] == req["request_id"] and r["status"] == "open" for r in reqs)

    # in-app switch alone (scope all) hides it too; mute + pause surface in prefs_state
    await client.put(_url(cid), json={"rules": {"requests": {"channels": {"in_app": False}}}, "muted": True})
    after = (await client.get(feed)).json()
    assert after["notifications"] == [] and after["prefs_state"]["muted"] is True


async def test_ai_feeds_are_never_filtered(client, container, make_agent, make_request):
    await make_agent("root", "operator", kind="human")
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    await make_request(a["agent_id"], "peer q", target_alias="b")
    await client.put(_url(container["id"]), json={"rules": {"requests": {"scope": "off"}}, "muted": True})
    d = (await client.get(f"/api/agents/{b['agent_id']}/notifications")).json()
    assert [n["event_name"] for n in d["notifications"]] == ["request_created"]
    assert d["prefs_state"] is None
